import {
  CODEX_TURN_RECOVERY_SOURCE_LABEL,
  codexTurnRecoverySourceId,
  isCodexLeaderRecoveryDiagnosticSourceId,
  isCodexTurnRecoverySourceId,
} from "../../shared/injected-event-message.js";
import { getKnownSessionNum } from "../cli-launcher.js";
import { compactPendingCodexInputsForBrowser } from "../codex-pending-input-safety.js";
import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  CodexOutboundTurn,
  CodexTurnRecoveryContinuationMode,
  CodexTurnRecoveryReason,
  PendingCodexInput,
  SessionState,
  CodexTurnRecoveryState,
} from "../session-types.js";
import type { CodexResumeTurnSnapshot } from "../codex-adapter.js";
import { sessionTag } from "../session-tag.js";
import {
  browserMessageRoute,
  routeFromHistoryEntry,
  sameThreadRoute,
  threadRouteForTarget,
  type ThreadRouteMetadata,
} from "../thread-routing-metadata.js";
import {
  getMessageAtAbsoluteHistoryIndex,
  summarizeLocalCodexDeliveryActivity,
  type CodexLocalDeliveryActivitySummary,
} from "./codex-delivery-ownership.js";
import { reconcileRecoveredQueuedTurnLifecycle } from "./codex-queued-turn-lifecycle.js";
import {
  createCodexHistoryIncorporation,
  isCodexTurnProvablyNeverDispatched,
  summarizeHistoryCorrelatedLocalActivity,
} from "./codex-history-incorporation.js";
import { withTrustedCodexRecoveryRoute } from "./codex-recovery-routing-context.js";

export type CodexTurnRecoveryDeliveryStatus = "sent" | "queued" | "paused_queued" | "dropped" | "no_session";

export interface CodexInterruptedTurnRecoverySessionLike {
  id: string;
  attentionReason?: "action" | "error" | "review" | null;
  codexLeaderRecycleContinuation?: {
    content: string;
    requestedAt: number;
    trigger: string;
    recoveryId?: string;
  } | null;
  isGenerating?: boolean;
  queuedTurnStarts?: number;
  queuedTurnReasons?: string[];
  queuedTurnUserMessageIds?: number[][];
  queuedTurnInterruptSources?: Array<"user" | "leader" | "system" | null>;
  queuedTurnActiveRoutes?: Array<{ threadKey: string; questId?: string } | null>;
  sessionNum?: number | null;
  state: Pick<
    SessionState,
    | "backend_error"
    | "backend_state"
    | "codex_result_error_auto_pause"
    | "codex_turn_recovery"
    | "isOrchestrator"
    | "pause"
  >;
  messageHistory: BrowserIncomingMessage[];
  frozenCount?: number;
  _frozenCount?: number;
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  /** Unresolved terminal recoveries retained outside the active scheduling slot. */
  codexTerminalRecoveries?: CodexTurnRecoveryState[];
  pendingStartupMemoryCatalogInjection?: unknown;
}

export interface CodexInterruptedTurnRecoveryDeps {
  broadcastToBrowsers: (session: any, message: BrowserIncomingMessage) => void;
  persistSession: (session: any) => void;
  persistHistoryMetadataRepair?: (session: any, expectedFrozenCount: number) => Promise<void>;
  refreshBrowserConversationViews?: (session: any) => void;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource: { sessionId: string; sessionLabel?: string },
    threadRoute: ThreadRouteMetadata,
    options: {
      deliveryContent: string;
      afterAccepted?: () => void;
      afterRejected?: (reason: "dropped" | "route_rejected" | "route_failed") => void;
    },
  ) => CodexTurnRecoveryDeliveryStatus;
  rebuildQueuedCodexPendingStartBatch?: (session: any) => void;
  dispatchQueuedCodexTurns?: (session: any, reason: string) => void;
  queueCodexPendingStartBatch?: (session: any, reason: string) => void;
  setAttentionError?: (session: any) => void;
}

const OUTCOME_BEARING_ACTIVITY = new Set(["assistant_text", "tool_use", "tool_result", "permission", "stream"]);

const RECOVERY_STATUSES = new Set(["recovering", "continuation_pending", "continuation_active", "action_required"]);
const RECOVERY_REASONS = new Set([
  "adapter_disconnect",
  "interrupted_after_activity",
  "continuation_dispatch_failed",
  "continuation_interrupted",
  "continuation_failed",
  "recovery_timeout",
  "recovery_failed",
]);

/** Preserve an unrelated terminal outcome before assigning the active recovery slot. */
export function archiveUnrelatedTerminalCodexRecovery(
  session: CodexInterruptedTurnRecoverySessionLike,
  ownerId: string,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  const current = session.state.codex_turn_recovery;
  if (
    current?.status !== "action_required" ||
    current.originalOwnerId === ownerId ||
    current.continuationOwnerId === ownerId
  )
    return;
  const retained = session.codexTerminalRecoveries ?? [];
  session.codexTerminalRecoveries = [
    ...retained.filter((recovery) => recovery.recoveryId !== current.recoveryId),
    { ...current },
  ];
  // This is a scheduling handoff, not resolution: leave diagnostic history unresolved.
  session.state.codex_turn_recovery = null;
  deps.broadcastToBrowsers(session, { type: "session_update", session: { codex_turn_recovery: null } });
  deps.persistSession(session);
}

/** Retire only terminal-owned queue entries; stale callbacks cannot authorize another attempt. */
export function retireTerminalCodexRecoveryOwner(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): boolean {
  const terminal = findTerminalCodexRecoveryOwner(session, pending);
  if (!terminal) return false;
  retireCodexTurnRecoveryOwners(session, terminal, deps);
  return true;
}

/** Reject delayed continuation delivery after its exact owner is no longer active. */
export function isInactiveCodexRecoverySource(
  session: Pick<CodexInterruptedTurnRecoverySessionLike, "state">,
  sourceId: string | undefined,
): boolean {
  if (!isCodexTurnRecoverySourceId(sourceId)) return false;
  const current = session.state.codex_turn_recovery;
  return !current || current.status === "action_required" || sourceId !== codexTurnRecoverySourceId(current.recoveryId);
}

/** Remove exact terminal ownership before constructing either a start or steer batch. */
export function retireTerminalCodexRecoveryOwners(
  session: CodexInterruptedTurnRecoverySessionLike,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  for (const recovery of terminalCodexRecoveries(session)) retireCodexTurnRecoveryOwners(session, recovery, deps);
}

function terminalCodexRecoveries(
  session: Pick<CodexInterruptedTurnRecoverySessionLike, "state" | "codexTerminalRecoveries">,
): CodexTurnRecoveryState[] {
  const current = session.state.codex_turn_recovery;
  return [...(session.codexTerminalRecoveries ?? []), ...(current?.status === "action_required" ? [current] : [])];
}

function findTerminalCodexRecoveryOwner(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
): CodexTurnRecoveryState | undefined {
  const ids = pending.pendingInputIds ?? [pending.userMessageId];
  return terminalCodexRecoveries(session).find(
    (recovery) =>
      ids.includes(recovery.originalOwnerId) ||
      (recovery.continuationOwnerId != null && ids.includes(recovery.continuationOwnerId)) ||
      sourceIdForPendingTurn(session, pending) === codexTurnRecoverySourceId(recovery.recoveryId),
  );
}

export function normalizeCodexTurnRecoveryState(value: unknown): SessionState["codex_turn_recovery"] {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const status = String(raw.status);
  const reason = String(raw.reason);
  if (
    typeof raw.recoveryId !== "string" ||
    !raw.recoveryId.trim() ||
    typeof raw.originalOwnerId !== "string" ||
    !raw.originalOwnerId.trim() ||
    !Number.isInteger(raw.originalHistoryIndex) ||
    typeof raw.threadKey !== "string" ||
    !raw.threadKey.trim() ||
    !RECOVERY_STATUSES.has(status) ||
    !RECOVERY_REASONS.has(reason) ||
    raw.maxAttempts !== 1 ||
    !Number.isFinite(raw.createdAt) ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return null;
  }
  const attemptValid = raw.attempt === 0 || raw.attempt === 1;
  const continuationStatus = status === "continuation_pending" || status === "continuation_active";
  const failClosed = !attemptValid || (continuationStatus && raw.attempt !== 1);
  const historyPresence =
    raw.historyPresence === "present" || raw.historyPresence === "absent" ? raw.historyPresence : "unknown";
  const continuationMode =
    raw.continuationMode === "finish_response" || raw.continuationMode === "verify_then_continue"
      ? raw.continuationMode
      : raw.attempt === 1 || continuationStatus
        ? "verify_then_continue"
        : null;
  return {
    recoveryId: raw.recoveryId,
    originalOwnerId: raw.originalOwnerId,
    originalProviderTurnId:
      typeof raw.originalProviderTurnId === "string" && raw.originalProviderTurnId.trim()
        ? raw.originalProviderTurnId
        : null,
    originalHistoryIndex: raw.originalHistoryIndex as number,
    continuationOwnerId:
      typeof raw.continuationOwnerId === "string" && raw.continuationOwnerId.trim() ? raw.continuationOwnerId : null,
    threadKey: raw.threadKey,
    ...(typeof raw.questId === "string" && raw.questId.trim() ? { questId: raw.questId } : {}),
    status: failClosed ? "action_required" : (status as NonNullable<SessionState["codex_turn_recovery"]>["status"]),
    reason: failClosed ? "recovery_failed" : (reason as CodexTurnRecoveryReason),
    historyPresence,
    continuationMode,
    ...(typeof raw.raisedAttention === "boolean" ? { raisedAttention: raw.raisedAttention } : {}),
    attempt: failClosed ? 1 : (raw.attempt as number),
    maxAttempts: 1,
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  };
}

export interface RestoredCodexTurnRecoveryRepair {
  state: SessionState["codex_turn_recovery"];
  resolvedByHistoricalSuccess: boolean;
  historyMetadataChanged: boolean;
  requiresFrozenHistoryMetadataRepair: boolean;
}

export function repairRestoredCodexTurnRecovery(
  session: CodexInterruptedTurnRecoverySessionLike,
): RestoredCodexTurnRecoveryRepair {
  let resolvedArchivedRecovery = false;
  let historyMetadataChanged = false;
  let requiresFrozenHistoryMetadataRepair = false;
  session.codexTerminalRecoveries = session.codexTerminalRecoveries?.filter((recovery) => {
    if (!hasHistoricalSuccessfulSameThreadHumanFollowUp(session, recovery)) return true;
    retireRestoredTerminalCodexRecoveryOwners(session, recovery);
    resolvedArchivedRecovery = true;
    const retired = retireCodexTurnRecoveryDiagnostics(session, recovery, Date.now());
    historyMetadataChanged ||= retired.changed;
    requiresFrozenHistoryMetadataRepair ||= retired.requiresFrozenHistoryMetadataRepair;
    return false;
  });
  const active = repairRestoredActiveCodexTurnRecovery(session);
  return {
    ...active,
    resolvedByHistoricalSuccess: active.resolvedByHistoricalSuccess || resolvedArchivedRecovery,
    historyMetadataChanged: active.historyMetadataChanged || historyMetadataChanged,
    requiresFrozenHistoryMetadataRepair:
      active.requiresFrozenHistoryMetadataRepair || requiresFrozenHistoryMetadataRepair,
  };
}

function repairRestoredActiveCodexTurnRecovery(
  session: CodexInterruptedTurnRecoverySessionLike,
): RestoredCodexTurnRecoveryRepair {
  const current = normalizeCodexTurnRecoveryState(session.state.codex_turn_recovery);
  if (!current) {
    return {
      state: null,
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }
  if (current.status === "action_required") {
    if (hasHistoricalSuccessfulSameThreadHumanFollowUp(session, current)) {
      retireRestoredTerminalCodexRecoveryOwners(session, current);
      const retired = retireCodexTurnRecoveryDiagnostics(session, current, Date.now());
      return {
        state: null,
        resolvedByHistoricalSuccess: true,
        historyMetadataChanged: retired.changed,
        requiresFrozenHistoryMetadataRepair: retired.requiresFrozenHistoryMetadataRepair,
      };
    }
    if (
      current.raisedAttention === true &&
      session.attentionReason === "error" &&
      !hasIndependentRestoredErrorAttentionEvidence(session, current)
    ) {
      session.attentionReason = null;
    }
    return {
      state: { ...current, raisedAttention: false },
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }

  const sourceId = codexTurnRecoverySourceId(current.recoveryId);
  const continuationInput = [...session.pendingCodexInputs]
    .reverse()
    .find((input) => input.deliveryState !== "failed" && input.agentSource?.sessionId === sourceId);
  const continuationTurn = [...session.pendingCodexTurns]
    .reverse()
    .find((turn) => sourceIdForPendingTurn(session, turn) === sourceId && turn.status !== "completed");
  const continuationOwnerId = continuationInput?.id ?? continuationTurn?.userMessageId ?? null;
  if (continuationOwnerId) {
    return {
      state: {
        ...current,
        continuationOwnerId,
        status: continuationTurn?.status === "backend_acknowledged" ? "continuation_active" : "continuation_pending",
      },
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }

  if (current.attempt === 1 && session.codexLeaderRecycleContinuation?.recoveryId === current.recoveryId) {
    return {
      state: { ...current, continuationOwnerId: null, status: "continuation_pending" },
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }
  if (current.attempt === 1) {
    return {
      state: {
        ...current,
        raisedAttention: false,
        status: "action_required",
        reason: "continuation_dispatch_failed",
        updatedAt: Date.now(),
      },
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }

  const originalPending = session.pendingCodexTurns.some(
    (turn) =>
      turn.status !== "completed" &&
      (turn.userMessageId === current.originalOwnerId ||
        (!!current.originalProviderTurnId && turn.turnId === current.originalProviderTurnId)),
  );
  if (originalPending) {
    return {
      state: current,
      resolvedByHistoricalSuccess: false,
      historyMetadataChanged: false,
      requiresFrozenHistoryMetadataRepair: false,
    };
  }
  return {
    state: {
      ...current,
      raisedAttention: false,
      status: "action_required",
      reason: "recovery_failed",
      updatedAt: Date.now(),
    },
    resolvedByHistoricalSuccess: false,
    historyMetadataChanged: false,
    requiresFrozenHistoryMetadataRepair: false,
  };
}

function hasIndependentRestoredErrorAttentionEvidence(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
): boolean {
  if (
    session.state.backend_state === "broken" ||
    session.state.backend_state === "recovery_suppressed" ||
    !!session.state.backend_error
  ) {
    return true;
  }

  const recoveryOwnerIds = new Set<string>(
    [recovery.originalOwnerId, recovery.continuationOwnerId].filter((id): id is string => !!id),
  );
  if (
    session.pendingCodexInputs.some((input) => {
      const sourceId = input.agentSource?.sessionId;
      return (
        input.deliveryState === "failed" &&
        (input.failedAt ?? input.timestamp) > recovery.updatedAt &&
        !recoveryOwnerIds.has(input.id) &&
        input.agentSource == null &&
        !isCodexTurnRecoverySourceId(sourceId)
      );
    })
  ) {
    return true;
  }

  if (
    session.pendingCodexTurns.some(
      (turn) =>
        turn.status !== "completed" &&
        turn.disconnectedAt != null &&
        turn.disconnectedAt > recovery.updatedAt &&
        pendingTurnHasIndependentDirectHumanOwner(session, turn, recovery, recoveryOwnerIds),
    )
  ) {
    return true;
  }

  let segmentCanOwnIndependentAttention = false;
  for (let index = recovery.originalHistoryIndex + 1; index < session.messageHistory.length; index += 1) {
    const message = session.messageHistory[index];
    if (!message || message.codexSubagent != null) continue;
    if (message.type === "user_message") {
      const sourceId = message.agentSource?.sessionId;
      segmentCanOwnIndependentAttention ||=
        message.timestamp > recovery.updatedAt &&
        !recoveryOwnerIds.has(message.id ?? "") &&
        message.agentSource == null &&
        !isCodexTurnRecoverySourceId(sourceId) &&
        !isCodexLeaderRecoveryDiagnosticSourceId(sourceId);
      continue;
    }
    if (message.type !== "result") continue;
    if (segmentCanOwnIndependentAttention && message.data.is_error === true && message.interrupted !== true) {
      return true;
    }
    segmentCanOwnIndependentAttention = false;
  }
  return false;
}

function pendingTurnHasIndependentDirectHumanOwner(
  session: CodexInterruptedTurnRecoverySessionLike,
  turn: CodexOutboundTurn,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
  recoveryOwnerIds: ReadonlySet<string>,
): boolean {
  const historyIndexes = new Set<number>([
    turn.historyIndex,
    ...(turn.historyIncorporation?.historyIndexes.filter((index): index is number => index != null) ?? []),
  ]);
  for (const historyIndex of historyIndexes) {
    const message = getMessageAtAbsoluteHistoryIndex(session, historyIndex);
    if (
      message?.type === "user_message" &&
      message.agentSource == null &&
      message.timestamp > recovery.updatedAt &&
      !recoveryOwnerIds.has(message.id ?? "")
    ) {
      return true;
    }
  }

  const pendingIds = new Set(turn.pendingInputIds ?? [turn.userMessageId]);
  return session.pendingCodexInputs.some(
    (input) =>
      pendingIds.has(input.id) &&
      input.agentSource == null &&
      input.timestamp > recovery.updatedAt &&
      !recoveryOwnerIds.has(input.id),
  );
}

export function repairRestoredCodexTurnRecoveryState(
  session: CodexInterruptedTurnRecoverySessionLike,
): SessionState["codex_turn_recovery"] {
  return repairRestoredCodexTurnRecovery(session).state;
}

export function hasIncompleteCodexActivityWithoutTerminalEvidence(
  turn: CodexResumeTurnSnapshot,
  threadStatus: string | null | undefined,
  activity: CodexLocalDeliveryActivitySummary,
  omittedFromResumeSnapshotCount: number,
  includeReasoning = false,
): boolean {
  const status = normalizeStatus(turn.status);
  const eligibleStatus =
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    (status === "interrupted" && normalizeStatus(threadStatus) === "idle");
  if (!eligibleStatus || turn.items.some(isTerminalResumeItem) || activity.kinds.includes("result")) return false;

  const lastToolIndex = findLastResumeItemIndex(turn.items, isResumeToolActivityItem);
  const lastAgentIndex = findLastResumeItemIndex(
    turn.items,
    (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim().length > 0,
  );
  const toolEvidence =
    omittedFromResumeSnapshotCount > 0 ||
    lastToolIndex >= 0 ||
    activity.kinds.includes("tool_use") ||
    activity.kinds.includes("tool_result");
  if (toolEvidence) {
    return omittedFromResumeSnapshotCount > 0 || lastAgentIndex < lastToolIndex || lastAgentIndex < 0;
  }
  if (status !== "interrupted") return false;
  return activity.kinds.some(
    (kind) => OUTCOME_BEARING_ACTIVITY.has(kind) || (includeReasoning && kind === "reasoning"),
  );
}

export function hasFinalCodexOutcomeEvidence(turn: CodexResumeTurnSnapshot): boolean {
  if (turn.items.some(isTerminalResumeItem)) return true;
  const lastToolIndex = findLastResumeItemIndex(turn.items, isResumeToolActivityItem);
  const lastAgentIndex = findLastResumeItemIndex(
    turn.items,
    (item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim().length > 0,
  );
  return lastAgentIndex >= 0 && lastAgentIndex > lastToolIndex;
}

export function selectCodexTurnRecoveryOwner(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
): CodexOutboundTurn {
  const coOwners = pending.turnId
    ? session.pendingCodexTurns.filter((turn) => turn.turnId === pending.turnId)
    : [pending];
  return coOwners.find((turn) => isDirectHumanTurn(session, turn)) ?? pending;
}

export function markCodexTurnRecoveryHistoryPresence(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  historyPresence: "present" | "absent" | "unknown",
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): boolean {
  if (findTerminalCodexRecoveryOwner(session, pending)) return false;
  archiveUnrelatedTerminalCodexRecovery(session, pending.userMessageId, deps);
  const current = session.state.codex_turn_recovery ?? null;
  if (current && current.originalOwnerId !== pending.userMessageId) return false;
  if (current?.historyPresence === historyPresence) return false;
  if (current) {
    setRecoveryState(session, { ...current, historyPresence, updatedAt: Date.now() }, deps);
    return true;
  }
  const now = Date.now();
  const route = resolveCodexTurnRecoveryRoute(session, pending);
  setRecoveryState(
    session,
    {
      recoveryId: pending.userMessageId,
      originalOwnerId: pending.userMessageId,
      originalProviderTurnId: pending.turnId,
      originalHistoryIndex: pending.historyIndex,
      continuationOwnerId: null,
      threadKey: route.threadKey,
      ...(route.questId ? { questId: route.questId } : {}),
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence,
      continuationMode: null,
      attempt: 0,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
    },
    deps,
  );
  return true;
}

export function markCodexTurnRecoveryOnDisconnect(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  const recoveryOwner = pending.historyIncorporation ? pending : selectCodexTurnRecoveryOwner(session, pending);
  pending = recoveryOwner;
  if (findTerminalCodexRecoveryOwner(session, pending)) return;
  archiveUnrelatedTerminalCodexRecovery(session, pending.userMessageId, deps);
  const current = session.state.codex_turn_recovery ?? null;
  if (current && isRecoveryContinuationTurn(session, pending, current.recoveryId)) {
    setRecoveryState(
      session,
      { ...current, status: "recovering", reason: "adapter_disconnect", updatedAt: Date.now() },
      deps,
    );
    return;
  }
  if (current) return;
  const trackedHistory = pending.historyIncorporation?.rpcAcceptedAt != null;
  const activity = trackedHistory
    ? summarizeHistoryCorrelatedLocalActivity(session, pending)
    : summarizeLocalCodexDeliveryActivity(session, pending);
  if (
    !trackedHistory &&
    (session.state.isOrchestrator !== true || !isDirectHumanTurn(session, pending) || activity.count === 0)
  ) {
    return;
  }
  const now = Date.now();
  const route = resolveCodexTurnRecoveryRoute(session, pending);
  setRecoveryState(
    session,
    {
      recoveryId: pending.userMessageId,
      originalOwnerId: pending.userMessageId,
      originalProviderTurnId: pending.turnId,
      originalHistoryIndex: pending.historyIndex,
      continuationOwnerId: null,
      threadKey: route.threadKey,
      ...(route.questId ? { questId: route.questId } : {}),
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence: pending.historyIncorporation?.recordedAt != null ? "present" : "unknown",
      continuationMode: null,
      attempt: 0,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
    },
    deps,
  );
}

export function isCodexLeaderRecycleRecoveryInjectionPending(
  session: CodexInterruptedTurnRecoverySessionLike,
): boolean {
  const recovery = session.state.codex_turn_recovery ?? null;
  const recycle = session.codexLeaderRecycleContinuation ?? null;
  return isCodexTurnRecoveryContinuationInjectionPending(session) && recycle?.recoveryId === recovery?.recoveryId;
}

export function isCodexTurnRecoveryContinuationInjectionPending(
  session: CodexInterruptedTurnRecoverySessionLike,
): boolean {
  const recovery = session.state.codex_turn_recovery ?? null;
  return recovery?.status === "continuation_pending" && recovery.continuationOwnerId == null;
}

export function prepareCodexLeaderRecycleRecoveryInjection(
  session: CodexInterruptedTurnRecoverySessionLike,
  recoveryId: string,
  requestedAt: number,
): boolean {
  const current = session.state.codex_turn_recovery ?? null;
  const recycle = session.codexLeaderRecycleContinuation ?? null;
  if (
    !current ||
    current.status !== "continuation_pending" ||
    current.continuationOwnerId != null ||
    current.recoveryId !== recoveryId ||
    recycle?.recoveryId !== recoveryId ||
    recycle.requestedAt !== requestedAt ||
    session.pendingStartupMemoryCatalogInjection ||
    session.state.pause?.pausedAt ||
    session.state.codex_result_error_auto_pause?.pausedAt
  ) {
    return false;
  }

  if (hasRecoveryEpochUserMessage(session, requestedAt)) return false;
  if (session.pendingCodexInputs.some((input) => input.deliveryState !== "failed")) return false;
  return !session.pendingCodexTurns.some((turn) => turn.status !== "completed");
}

export function finalizeCodexLeaderRecycleRecoveryInjection(
  session: CodexInterruptedTurnRecoverySessionLike,
  recoveryId: string,
  requestedAt: number,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession" | "setAttentionError"> & {
    rebuildQueuedCodexPendingStartBatch: (session: any) => void;
    dispatchQueuedCodexTurns: (session: any, reason: string) => void;
  },
): boolean {
  const current = session.state.codex_turn_recovery ?? null;
  if (!current || current.recoveryId !== recoveryId) return false;
  if (current.status === "action_required") {
    retireCodexTurnRecoveryOwners(session, current, deps);
    deps.rebuildQueuedCodexPendingStartBatch(session);
    deps.dispatchQueuedCodexTurns(session, "codex_recycle_recovery_stale_action_required");
    return false;
  }
  if (
    session.codexLeaderRecycleContinuation?.recoveryId !== recoveryId ||
    session.codexLeaderRecycleContinuation.requestedAt !== requestedAt
  ) {
    return false;
  }
  const sourceId = codexTurnRecoverySourceId(recoveryId);
  const recoveryInput = [...session.pendingCodexInputs]
    .reverse()
    .find((input) => input.deliveryState !== "failed" && input.agentSource?.sessionId === sourceId);
  const laterInputExists = session.pendingCodexInputs.some(
    (input) => input.deliveryState !== "failed" && input.agentSource?.sessionId !== sourceId,
  );
  const laterTurnExists = session.pendingCodexTurns.some((turn) => {
    if (turn.status === "completed") return false;
    const ids = turn.pendingInputIds ?? [turn.userMessageId];
    return ids.some((id) => id !== recoveryInput?.id);
  });
  if (!recoveryInput || laterInputExists || laterTurnExists) {
    markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
    deps.rebuildQueuedCodexPendingStartBatch(session);
    deps.dispatchQueuedCodexTurns(session, "codex_recycle_recovery_order_changed");
    return false;
  }
  session.codexLeaderRecycleContinuation = null;
  setRecoveryState(
    session,
    {
      ...current,
      continuationOwnerId: recoveryInput.id,
      status: "continuation_pending",
      attempt: 1,
      updatedAt: Date.now(),
    },
    deps,
  );
  deps.rebuildQueuedCodexPendingStartBatch(session);
  deps.dispatchQueuedCodexTurns(session, "codex_recycle_recovery_ready");
  return true;
}

export function beginCodexTurnRecoveryContinuation(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  route: ThreadRouteMetadata,
  deps: CodexInterruptedTurnRecoveryDeps,
  continuationMode: CodexTurnRecoveryContinuationMode = "verify_then_continue",
): boolean {
  if (findTerminalCodexRecoveryOwner(session, pending)) return false;
  archiveUnrelatedTerminalCodexRecovery(session, pending.userMessageId, deps);
  const existing = session.state.codex_turn_recovery ?? null;
  if (isRecoveryContinuationTurn(session, pending, existing?.recoveryId)) {
    markCodexTurnRecoveryActionRequired(session, "continuation_interrupted", deps);
    return false;
  }
  if (existing && existing.originalOwnerId !== pending.userMessageId) return false;
  if (existing?.attempt === 1) {
    if (existing.status === "action_required") return false;
    const sourceId = codexTurnRecoverySourceId(existing.recoveryId);
    const continuationOwnerId = findContinuationOwnerId(session, sourceId);
    if (!continuationOwnerId) {
      markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
      return false;
    }
    setRecoveryState(
      session,
      {
        ...existing,
        continuationOwnerId,
        continuationMode: existing.continuationMode ?? continuationMode,
        updatedAt: Date.now(),
      },
      deps,
    );
    return true;
  }

  const now = Date.now();
  const recoveryId = pending.userMessageId;
  const next: NonNullable<SessionState["codex_turn_recovery"]> = {
    recoveryId,
    originalOwnerId: pending.userMessageId,
    originalProviderTurnId: pending.turnId,
    originalHistoryIndex: pending.historyIndex,
    continuationOwnerId: null,
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
    status: "continuation_pending" as const,
    reason: "interrupted_after_activity" as const,
    historyPresence: pending.historyIncorporation?.recordedAt != null ? "present" : "unknown",
    continuationMode,
    attempt: 1,
    maxAttempts: 1 as const,
    createdAt: existing?.originalOwnerId === pending.userMessageId ? existing.createdAt : now,
    updatedAt: now,
  };
  setRecoveryState(session, next, deps);
  if (session.state.pause?.pausedAt || session.state.codex_result_error_auto_pause?.pausedAt) {
    markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
    return false;
  }

  const sourceId = codexTurnRecoverySourceId(recoveryId);
  const queueBeforeOwnerId = session.pendingCodexTurns.find((turn) => turn.status !== "completed")?.userMessageId;
  const visibleContent =
    continuationMode === "verify_then_continue"
      ? "Takode added a separate follow-up to check prior work before finishing what is missing. The original input was not replayed."
      : "Takode added a separate follow-up to finish the interrupted response. The original input was not replayed.";
  const deliveryContent = buildContinuationPrompt(session, pending, continuationMode);
  const acceptContinuation = () => {
    bindAcceptedCodexTurnRecoveryContinuation(session, recoveryId, sourceId, deps);
  };
  const rejectContinuation = () => {
    if (session.state.codex_turn_recovery?.recoveryId !== recoveryId) return;
    markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
  };
  let delivery: CodexTurnRecoveryDeliveryStatus;
  try {
    delivery = withTrustedCodexRecoveryRoute(
      session,
      {
        recoveryId,
        sourceId,
        visibleContent,
        deliveryContent,
        threadKey: route.threadKey,
        ...(route.questId ? { questId: route.questId } : {}),
        ...(queueBeforeOwnerId ? { queueBeforeOwnerId } : {}),
      },
      () =>
        deps.injectUserMessage(
          session.id,
          visibleContent,
          { sessionId: sourceId, sessionLabel: CODEX_TURN_RECOVERY_SOURCE_LABEL },
          route,
          { deliveryContent, afterAccepted: acceptContinuation, afterRejected: rejectContinuation },
        ),
    );
  } catch {
    rejectContinuation();
    return false;
  }
  if (delivery === "dropped" || delivery === "no_session" || delivery === "paused_queued") {
    rejectContinuation();
    return false;
  }
  const continuationOwnerId = session.state.codex_turn_recovery?.continuationOwnerId ?? null;
  console.log(
    `[ws-bridge] Queued exact-owner Codex continuation for session ${sessionTag(session.id)} ` +
      `(recovery=${recoveryId}, owner=${continuationOwnerId ?? "pending"}, route=${route.threadKey}, mode=${continuationMode})`,
  );
  return true;
}

function bindAcceptedCodexTurnRecoveryContinuation(
  session: CodexInterruptedTurnRecoverySessionLike,
  recoveryId: string,
  sourceId: string,
  deps: CodexInterruptedTurnRecoveryDeps,
): void {
  const current = session.state.codex_turn_recovery ?? null;
  if (!current || current.recoveryId !== recoveryId || current.status === "action_required") return;
  const continuationOwnerId = findContinuationOwnerId(session, sourceId);
  if (!continuationOwnerId) {
    markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
    return;
  }
  const continuationInput = session.pendingCodexInputs.find((input) => input.id === continuationOwnerId);
  if (continuationInput && !continuationInput.queueBeforeOwnerId) {
    const laterTurnOwner = session.pendingCodexTurns.find(
      (turn) => turn.status !== "completed" && sourceIdForPendingTurn(session, turn) !== sourceId,
    )?.userMessageId;
    const laterInputOwner = session.pendingCodexInputs.find(
      (input) => input.id !== continuationOwnerId && input.deliveryState !== "failed",
    )?.id;
    continuationInput.queueBeforeOwnerId = laterTurnOwner ?? laterInputOwner;
  }
  setRecoveryState(
    session,
    { ...current, continuationOwnerId, status: "continuation_pending", updatedAt: Date.now() },
    deps,
  );
  deps.rebuildQueuedCodexPendingStartBatch?.(session);
  deps.dispatchQueuedCodexTurns?.(session, "codex_turn_recovery_continuation_accepted");
}

export function markCodexTurnRecoveryContinuationActive(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  const current = session.state.codex_turn_recovery ?? null;
  if (
    !current ||
    current.status === "action_required" ||
    !isRecoveryContinuationTurn(session, pending, current.recoveryId)
  )
    return;
  setRecoveryState(
    session,
    {
      ...current,
      continuationOwnerId: pending.userMessageId,
      status: "continuation_active",
      updatedAt: Date.now(),
    },
    deps,
  );
}

function retireCodexTurnRecoveryOwners(
  session: CodexInterruptedTurnRecoverySessionLike,
  current: NonNullable<SessionState["codex_turn_recovery"]>,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  const sourceId = codexTurnRecoverySourceId(current.recoveryId);
  if (session.codexLeaderRecycleContinuation?.recoveryId === current.recoveryId) {
    session.codexLeaderRecycleContinuation = null;
  }
  const ownerIds = new Set([current.originalOwnerId, current.continuationOwnerId].filter(Boolean) as string[]);
  for (const input of session.pendingCodexInputs) {
    if (input.agentSource?.sessionId === sourceId) ownerIds.add(input.id);
  }

  const previousTurnCount = session.pendingCodexTurns.length;
  let splitMixedTurn = false;
  session.pendingCodexTurns = session.pendingCodexTurns.flatMap((turn) => {
    if (turn.status === "completed") return [];
    const ids = turn.pendingInputIds ?? [turn.userMessageId];
    const remainingIds = ids.filter((id) => !ownerIds.has(id));
    const sourceOwned = sourceIdForPendingTurn(session, turn) === sourceId;
    if (remainingIds.length === ids.length && !sourceOwned) return [turn];
    if (remainingIds.length === 0 || turn.adapterMsg.type === "user_message") return [];
    if (turn.adapterMsg.type !== "codex_start_pending" && turn.adapterMsg.type !== "codex_steer_pending") {
      return [];
    }

    const batchMessage = turn.adapterMsg;
    const inputById = new Map(
      batchMessage.pendingInputIds.map((id, index) => [id, batchMessage.inputs[index]] as const),
    );
    const pendingById = new Map(session.pendingCodexInputs.map((input) => [input.id, input] as const));
    const remainingInputs = remainingIds.map((id) => {
      const existing = inputById.get(id);
      if (existing) return existing;
      const pending = pendingById.get(id);
      return {
        content: pending?.deliveryContent || pending?.content || turn.userContent,
        ...(pending?.vscodeSelection ? { vscodeSelection: pending.vscodeSelection } : {}),
      };
    });
    const canRegenerateTracking = isCodexTurnProvablyNeverDispatched(turn);
    const historyIncorporation = canRegenerateTracking ? createCodexHistoryIncorporation(remainingIds) : undefined;
    turn.adapterMsg = {
      ...batchMessage,
      pendingInputIds: remainingIds,
      inputs: remainingInputs,
      ...(historyIncorporation ? { clientUserMessageId: historyIncorporation.clientUserMessageId } : {}),
    };
    turn.pendingInputIds = remainingIds;
    turn.userMessageId = remainingIds[0]!;
    turn.userContent = remainingInputs
      .map((input) => input.content)
      .filter(Boolean)
      .join("\n\n");
    if (turn.historyIndex === current.originalHistoryIndex || sourceOwned) turn.historyIndex = -1;
    turn.historyIncorporation = historyIncorporation;
    turn.historyTrackingUnknown = canRegenerateTracking ? undefined : true;
    if (!canRegenerateTracking) {
      turn.status = "recovery_pending";
      turn.turnTarget = null;
      turn.terminalHistoryReconciliation = {
        presence: "unknown",
        reason: "recovery_owner_split",
        action: "continue",
        continuationMode: "verify_then_continue",
        classifiedAt: Date.now(),
      };
    }
    splitMixedTurn = true;
    return [turn];
  });

  const previousInputCount = session.pendingCodexInputs.length;
  session.pendingCodexInputs = session.pendingCodexInputs.filter(
    (input) => !ownerIds.has(input.id) && input.agentSource?.sessionId !== sourceId,
  );
  if (session.pendingCodexInputs.length !== previousInputCount) {
    deps.broadcastToBrowsers(session, {
      type: "codex_pending_inputs",
      inputs: compactPendingCodexInputsForBrowser(session.pendingCodexInputs),
    });
  }
  if (
    session.pendingCodexTurns.length !== previousTurnCount ||
    session.pendingCodexInputs.length !== previousInputCount ||
    splitMixedTurn
  ) {
    if (
      typeof session.isGenerating === "boolean" &&
      typeof session.queuedTurnStarts === "number" &&
      Array.isArray(session.queuedTurnReasons) &&
      Array.isArray(session.queuedTurnUserMessageIds) &&
      Array.isArray(session.queuedTurnInterruptSources)
    ) {
      reconcileRecoveredQueuedTurnLifecycle(session as any, "codex_turn_recovery_action_required", {
        getCodexHeadTurn: (target: CodexInterruptedTurnRecoverySessionLike) => target.pendingCodexTurns[0] ?? null,
      });
    }
    deps.persistSession(session);
  }
}

export function markCodexTurnRecoveryActionRequired(
  session: CodexInterruptedTurnRecoverySessionLike,
  reason: CodexTurnRecoveryReason,
  deps: Pick<
    CodexInterruptedTurnRecoveryDeps,
    | "broadcastToBrowsers"
    | "persistSession"
    | "persistHistoryMetadataRepair"
    | "refreshBrowserConversationViews"
    | "setAttentionError"
  >,
): void {
  const current = session.state.codex_turn_recovery ?? null;
  if (!current) return;
  retireCodexTurnRecoveryOwners(session, current, deps);
  setRecoveryState(
    session,
    { ...current, status: "action_required", reason, raisedAttention: false, updatedAt: Date.now() },
    deps,
  );
  console.warn(
    `[ws-bridge] Codex interrupted-turn recovery requires action for session ${sessionTag(session.id)} ` +
      `(recovery=${current.recoveryId}, reason=${reason}, route=${current.threadKey})`,
  );
}

export function markCodexTurnRecoveryOwnerActionRequired(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  reason: CodexTurnRecoveryReason,
  deps: Pick<
    CodexInterruptedTurnRecoveryDeps,
    | "broadcastToBrowsers"
    | "persistSession"
    | "persistHistoryMetadataRepair"
    | "refreshBrowserConversationViews"
    | "setAttentionError"
  >,
): void {
  if (retireTerminalCodexRecoveryOwner(session, pending, deps)) return;
  archiveUnrelatedTerminalCodexRecovery(session, pending.userMessageId, deps);
  const current = session.state.codex_turn_recovery ?? null;
  if (!current) {
    const now = Date.now();
    const route = resolveCodexTurnRecoveryRoute(session, pending);
    setRecoveryState(
      session,
      {
        recoveryId: pending.userMessageId,
        originalOwnerId: pending.userMessageId,
        originalProviderTurnId: pending.turnId,
        originalHistoryIndex: pending.historyIndex,
        continuationOwnerId: null,
        threadKey: route.threadKey,
        ...(route.questId ? { questId: route.questId } : {}),
        status: "recovering",
        reason: "adapter_disconnect",
        historyPresence: pending.historyIncorporation?.recordedAt != null ? "present" : "unknown",
        continuationMode: null,
        attempt: 0,
        maxAttempts: 1,
        createdAt: now,
        updatedAt: now,
      },
      deps,
    );
  }
  if (session.state.codex_turn_recovery?.originalOwnerId === pending.userMessageId) {
    markCodexTurnRecoveryActionRequired(session, reason, deps);
  }
}

export function resolveCodexTurnRecoveryAction(
  session: CodexInterruptedTurnRecoverySessionLike,
  recoveryId: string,
  deps: Pick<
    CodexInterruptedTurnRecoveryDeps,
    | "broadcastToBrowsers"
    | "persistSession"
    | "persistHistoryMetadataRepair"
    | "refreshBrowserConversationViews"
    | "queueCodexPendingStartBatch"
  >,
): boolean {
  const current =
    session.state.codex_turn_recovery?.recoveryId === recoveryId
      ? session.state.codex_turn_recovery
      : session.codexTerminalRecoveries?.find((recovery) => recovery.recoveryId === recoveryId);
  if (!current || current.status !== "action_required" || current.recoveryId !== recoveryId) return false;
  retireCodexTurnRecoveryOwners(session, current, deps);
  clearCodexTurnRecoveryState(session, current, deps);
  deps.queueCodexPendingStartBatch?.(session, "codex_turn_recovery_resolved");
  console.log(
    `[ws-bridge] User resolved Codex interrupted-turn recovery for session ${sessionTag(session.id)} ` +
      `(recovery=${current.recoveryId}, route=${current.threadKey})`,
  );
  return true;
}

export function clearCodexTurnRecoveryForOwner(
  session: CodexInterruptedTurnRecoverySessionLike,
  ownerId: string,
  deps: Pick<
    CodexInterruptedTurnRecoveryDeps,
    "broadcastToBrowsers" | "persistSession" | "persistHistoryMetadataRepair" | "refreshBrowserConversationViews"
  >,
): void {
  const current = session.state.codex_turn_recovery ?? null;
  if (!current) return;
  if (ownerId !== current.originalOwnerId && ownerId !== current.continuationOwnerId) return;
  if (ownerId === current.originalOwnerId && current.attempt > 0) return;
  clearCodexTurnRecoveryState(session, current, deps);
  console.log(
    `[ws-bridge] Cleared Codex interrupted-turn recovery for session ${sessionTag(session.id)} ` +
      `(recovery=${current.recoveryId}, owner=${ownerId})`,
  );
}

export function settleCodexTurnRecoveryFromResult(
  session: CodexInterruptedTurnRecoverySessionLike,
  completedTurns: CodexOutboundTurn[],
  result: CLIResultMessage,
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession" | "setAttentionError">,
  interrupted = false,
): void {
  const successful = isSuccessfulResult(result, interrupted);
  if (successful) {
    for (const recovery of [...(session.codexTerminalRecoveries ?? [])]) {
      if (completedTurns.some((turn) => isFreshSameThreadHumanRecoveryFollowUp(session, turn, recovery))) {
        clearCodexTurnRecoveryState(session, recovery, deps);
      }
    }
  }
  const current = session.state.codex_turn_recovery ?? null;
  if (!current) return;
  if (successful && current.status === "action_required") {
    const followUp = completedTurns.find((turn) => isFreshSameThreadHumanRecoveryFollowUp(session, turn, current));
    if (followUp) {
      clearCodexTurnRecoveryState(session, current, deps);
      console.log(
        `[ws-bridge] Cleared action-required Codex recovery after a successful same-thread follow-up for ` +
          `${sessionTag(session.id)} (recovery=${current.recoveryId}, owner=${followUp.userMessageId}, ` +
          `route=${current.threadKey})`,
      );
      return;
    }
  }
  const continuation = completedTurns.find((turn) => isRecoveryContinuationTurn(session, turn, current.recoveryId));
  if (!continuation) {
    const completedOriginal = completedTurns.some((turn) => turn.userMessageId === current.originalOwnerId);
    if (!completedOriginal || current.attempt > 0) return;
    if (successful) clearCodexTurnRecoveryForOwner(session, current.originalOwnerId, deps);
    else markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
    return;
  }
  if (successful) {
    clearCodexTurnRecoveryForOwner(session, continuation.userMessageId, deps);
    return;
  }
  const stopReason = typeof result.stop_reason === "string" ? result.stop_reason.toLowerCase() : "";
  markCodexTurnRecoveryActionRequired(
    session,
    interrupted || stopReason.includes("interrupt") || stopReason.includes("cancel")
      ? "continuation_interrupted"
      : "continuation_failed",
    deps,
  );
}

function isFreshSameThreadHumanRecoveryFollowUp(
  session: CodexInterruptedTurnRecoverySessionLike,
  turn: CodexOutboundTurn,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
): boolean {
  if (turn.userMessageId === recovery.originalOwnerId || turn.userMessageId === recovery.continuationOwnerId) {
    return false;
  }
  if (turn.historyIndex <= recovery.originalHistoryIndex || !isDirectHumanTurn(session, turn)) return false;
  const message = getMessageAtAbsoluteHistoryIndex(session, turn.historyIndex);
  if (message?.type !== "user_message" || message.timestamp <= recovery.updatedAt) return false;
  const route = routeFromHistoryEntry(message) ?? threadRouteForTarget("main");
  return sameThreadRoute(route, { threadKey: recovery.threadKey });
}

function clearCodexTurnRecoveryState(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
  deps: Pick<
    CodexInterruptedTurnRecoveryDeps,
    "broadcastToBrowsers" | "persistSession" | "persistHistoryMetadataRepair" | "refreshBrowserConversationViews"
  >,
): void {
  if (recovery.status === "action_required") retireCodexTurnRecoveryOwners(session, recovery, deps);
  const retired = retireCodexTurnRecoveryDiagnostics(session, recovery, Date.now());
  if (session.state.codex_turn_recovery?.recoveryId === recovery.recoveryId) {
    session.state.codex_turn_recovery = null;
    deps.broadcastToBrowsers(session, { type: "session_update", session: { codex_turn_recovery: null } });
  }
  session.codexTerminalRecoveries = session.codexTerminalRecoveries?.filter(
    (retained) => retained.recoveryId !== recovery.recoveryId,
  );
  if (retired.requiresFrozenHistoryMetadataRepair && deps.persistHistoryMetadataRepair) {
    const expectedFrozenCount = normalizedFrozenHistoryCount(session);
    void deps.persistHistoryMetadataRepair(session, expectedFrozenCount).catch((error) => {
      console.error(
        `[ws-bridge] Failed to persist resolved Codex recovery diagnostic for ${sessionTag(session.id)} ` +
          `(recovery=${recovery.recoveryId}):`,
        error,
      );
    });
  } else {
    deps.persistSession(session);
  }
  if (retired.changed) deps.refreshBrowserConversationViews?.(session);
}

function retireRestoredTerminalCodexRecoveryOwners(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: CodexTurnRecoveryState,
): void {
  // Restore has no subscribers; the registry persists the complete repair
  // after pending ownership and historical resolution are reconciled together.
  retireCodexTurnRecoveryOwners(session, recovery, { broadcastToBrowsers: () => {}, persistSession: () => {} });
}

interface RetiredCodexTurnRecoveryDiagnostics {
  changed: boolean;
  requiresFrozenHistoryMetadataRepair: boolean;
}

function retireCodexTurnRecoveryDiagnostics(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
  resolvedAt: number,
): RetiredCodexTurnRecoveryDiagnostics {
  const exactIndexes: number[] = [];
  for (let index = recovery.originalHistoryIndex + 1; index < session.messageHistory.length; index += 1) {
    const message = session.messageHistory[index];
    if (
      message?.type === "user_message" &&
      message.codexTurnRecoveryId === recovery.recoveryId &&
      message.codexTurnRecoveryResolvedAt == null &&
      isCodexLeaderRecoveryDiagnosticSourceId(message.agentSource?.sessionId)
    ) {
      exactIndexes.push(index);
    }
  }

  const indexes = exactIndexes.length > 0 ? exactIndexes : uniqueLegacyRecoveryDiagnosticIndex(session, recovery);
  const frozenCount = normalizedFrozenHistoryCount(session);
  let requiresFrozenHistoryMetadataRepair = false;
  for (const index of indexes) {
    const message = session.messageHistory[index];
    if (message?.type !== "user_message") continue;
    message.codexTurnRecoveryId = recovery.recoveryId;
    message.codexTurnRecoveryResolvedAt = resolvedAt;
    requiresFrozenHistoryMetadataRepair ||= index < frozenCount;
  }
  return { changed: indexes.length > 0, requiresFrozenHistoryMetadataRepair };
}

function uniqueLegacyRecoveryDiagnosticIndex(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
): number[] {
  const candidates: number[] = [];
  for (let index = recovery.originalHistoryIndex + 1; index < session.messageHistory.length; index += 1) {
    const message = session.messageHistory[index];
    if (!message) continue;
    if (message.type === "user_message" && message.agentSource == null) break;
    if (
      message.type !== "user_message" ||
      message.codexTurnRecoveryId != null ||
      message.codexTurnRecoveryResolvedAt != null ||
      !isCodexLeaderRecoveryDiagnosticSourceId(message.agentSource?.sessionId) ||
      message.timestamp < recovery.createdAt
    ) {
      continue;
    }
    const route = routeFromHistoryEntry(message) ?? threadRouteForTarget("main");
    if (sameThreadRoute(route, { threadKey: recovery.threadKey })) candidates.push(index);
  }
  return candidates.length === 1 ? candidates : [];
}

function normalizedFrozenHistoryCount(session: CodexInterruptedTurnRecoverySessionLike): number {
  const raw = session.frozenCount ?? session._frozenCount ?? 0;
  return Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), session.messageHistory.length)) : 0;
}

function hasHistoricalSuccessfulSameThreadHumanFollowUp(
  session: CodexInterruptedTurnRecoverySessionLike,
  recovery: NonNullable<SessionState["codex_turn_recovery"]>,
): boolean {
  const pendingOwnerIds = new Set(session.pendingCodexInputs.map((input) => input.id));
  for (const turn of session.pendingCodexTurns) {
    if (turn.status === "completed") continue;
    pendingOwnerIds.add(turn.userMessageId);
    for (const id of turn.pendingInputIds ?? []) pendingOwnerIds.add(id);
  }

  let segmentHasEligibleFollowUp = false;
  for (let index = recovery.originalHistoryIndex + 1; index < session.messageHistory.length; index += 1) {
    const message = session.messageHistory[index];
    if (!message || message.codexSubagent != null) continue;
    if (message.type === "user_message") {
      const messageId = message.id?.trim() ?? "";
      const route = routeFromHistoryEntry(message) ?? threadRouteForTarget("main");
      segmentHasEligibleFollowUp =
        message.agentSource == null &&
        messageId.length > 0 &&
        message.timestamp > recovery.updatedAt &&
        !pendingOwnerIds.has(messageId) &&
        sameThreadRoute(route, { threadKey: recovery.threadKey });
      continue;
    }
    if (message.type !== "result") continue;
    const route = routeFromHistoryEntry(message) ?? threadRouteForTarget("main");
    if (
      segmentHasEligibleFollowUp &&
      sameThreadRoute(route, { threadKey: recovery.threadKey }) &&
      isSuccessfulResult(message.data, message.interrupted === true)
    ) {
      return true;
    }
    segmentHasEligibleFollowUp = false;
  }
  return false;
}

export function resolveCodexTurnRecoveryRoute(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  recoveredRoute?: ThreadRouteMetadata | null,
): ThreadRouteMetadata {
  if (pending.adapterMsg.type === "user_message") {
    const route = browserMessageRoute(pending.adapterMsg);
    if (route) return route;
  }
  const original = getMessageAtAbsoluteHistoryIndex(session, pending.historyIndex);
  return routeFromHistoryEntry(original ?? undefined) ?? recoveredRoute ?? threadRouteForTarget("main");
}

export function isRecoveryContinuationTurn(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  recoveryId = session.state.codex_turn_recovery?.recoveryId,
): boolean {
  if (!recoveryId) return false;
  if (
    recoveryId === session.state.codex_turn_recovery?.recoveryId &&
    pending.userMessageId === session.state.codex_turn_recovery?.continuationOwnerId
  )
    return true;
  const sourceId = sourceIdForPendingTurn(session, pending);
  return sourceId === codexTurnRecoverySourceId(recoveryId);
}

function setRecoveryState(
  session: CodexInterruptedTurnRecoverySessionLike,
  state: SessionState["codex_turn_recovery"],
  deps: Pick<CodexInterruptedTurnRecoveryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  session.state.codex_turn_recovery = state;
  deps.broadcastToBrowsers(session, { type: "session_update", session: { codex_turn_recovery: state } });
  deps.persistSession(session);
}

function isDirectHumanTurn(session: CodexInterruptedTurnRecoverySessionLike, pending: CodexOutboundTurn): boolean {
  const original = getMessageAtAbsoluteHistoryIndex(session, pending.historyIndex);
  if (original?.type === "user_message") return original.agentSource == null;
  return pending.adapterMsg.type === "user_message" && pending.adapterMsg.agentSource == null;
}

function sourceIdForPendingTurn(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
): string | undefined {
  const original = getMessageAtAbsoluteHistoryIndex(session, pending.historyIndex);
  if (original?.type === "user_message") return original.agentSource?.sessionId;
  if (pending.adapterMsg.type === "user_message") return pending.adapterMsg.agentSource?.sessionId;
  return undefined;
}

function findContinuationOwnerId(session: CodexInterruptedTurnRecoverySessionLike, sourceId: string): string | null {
  const pendingInput = [...session.pendingCodexInputs]
    .reverse()
    .find((input) => input.deliveryState !== "failed" && input.agentSource?.sessionId === sourceId);
  if (pendingInput) return pendingInput.id;
  const pendingTurn = [...session.pendingCodexTurns]
    .reverse()
    .find((turn) => sourceIdForPendingTurn(session, turn) === sourceId);
  return pendingTurn?.userMessageId ?? null;
}

function buildContinuationPrompt(
  session: CodexInterruptedTurnRecoverySessionLike,
  pending: CodexOutboundTurn,
  continuationMode: CodexTurnRecoveryContinuationMode,
): string {
  const sessionRef = String(getKnownSessionNum(session.id) ?? session.sessionNum ?? session.id);
  const historyIndex = pending.historyIndex;
  const inspectCommands =
    historyIndex >= 0
      ? `Start with \`takode peek ${sessionRef} --turn-containing ${historyIndex}\`, then use \`takode read ${sessionRef} ${historyIndex}\` and other targeted inspection only as needed.`
      : `Start with \`takode scan ${sessionRef}\`, then inspect the most recent interrupted turn with \`takode peek\` or \`takode read\` as needed.`;
  return [
    "Takode could not confirm that the previous turn completed its response.",
    continuationMode === "verify_then_continue"
      ? "This is a separately owned verification-first continuation. The original user payload was not replayed because its history or effect evidence is incomplete."
      : "This is a separately owned recovery continuation. The original user payload is recorded in Codex history and must not be replayed.",
    inspectCommands,
    "Takode history and these commands expose only Takode's persisted observations; they may be incomplete and do not prove all Codex-internal progress, partial tool execution, or external effects.",
    continuationMode === "verify_then_continue"
      ? "Tool or external effects may already have occurred. Inspect current quest, board, notification, file, and external state before repeating any action."
      : "Takode's available observations did not show effect-capable activity after this input; that absence is not proof that no partial tool execution or external effect occurred. Inspect the original request, partial response, and current state, then finish only the missing response without repeating already-taken actions.",
    "Continue only the missing work within the original authorization and thread route. If safe continuation remains unclear, report the unfinished/action-required state instead of guessing or claiming completion.",
  ].join("\n\n");
}

function isSuccessfulResult(result: CLIResultMessage, interrupted = false): boolean {
  if (interrupted || result.is_error) return false;
  const stopReason = typeof result.stop_reason === "string" ? result.stop_reason.toLowerCase() : "";
  if (stopReason.includes("interrupt") || stopReason.includes("cancel") || stopReason.includes("fail")) return false;
  return result.subtype === "success";
}

function hasRecoveryEpochUserMessage(session: CodexInterruptedTurnRecoverySessionLike, requestedAt: number): boolean {
  let markerIndex = -1;
  for (let index = session.messageHistory.length - 1; index >= 0; index -= 1) {
    const message = session.messageHistory[index];
    if (
      message?.type === "compact_marker" &&
      message.markerKind === "session_recycled" &&
      message.timestamp === requestedAt
    ) {
      markerIndex = index;
      break;
    }
  }
  if (markerIndex >= 0) {
    return session.messageHistory.slice(markerIndex + 1).some((message) => message.type === "user_message");
  }
  return session.messageHistory.some(
    (message) => message.type === "user_message" && (message.timestamp ?? 0) >= requestedAt,
  );
}

function normalizeStatus(status: string | null | undefined): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function findLastResumeItemIndex(
  items: Array<Record<string, unknown>>,
  predicate: (item: Record<string, unknown>) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function isResumeToolActivityItem(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  return (
    type.includes("command") ||
    type.includes("tool") ||
    type.includes("function") ||
    type.includes("filechange") ||
    type.includes("patch")
  );
}

function isTerminalResumeItem(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  return (
    type === "result" ||
    type === "turnresult" ||
    type === "turn_result" ||
    type === "taskcomplete" ||
    type === "task_complete" ||
    type.includes("taskcomplete") ||
    type.includes("task_complete")
  );
}

export function isCodexTurnRecoverySource(sourceId: string | undefined): boolean {
  return isCodexTurnRecoverySourceId(sourceId);
}
