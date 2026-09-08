import {
  isSystemSourceTag,
  isTimerReminderContent,
  isTimerSourceTag,
} from "./bridge/adapter-browser-routing-source-tags.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIResultMessage,
  CodexAutoPauseHeldInput,
  CodexAutoPauseInputSourceKind,
  CodexAutoPauseRecoveryProgress,
  CodexPendingBatchInput,
  CodexOutboundTurn,
  CodexResultErrorAutoPauseState,
  CodexResultErrorFamily,
  PendingCodexInput,
  PausedInboundSource,
  SessionState,
} from "./session-types.js";
import { collectCodexAutoPauseRecoveryLinks } from "./bridge/codex-auto-pause-recovery-summary.js";
import { createCodexHistoryIncorporation } from "./bridge/codex-history-incorporation.js";

type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

export const CODEX_RESULT_ERROR_AUTO_PAUSE_THRESHOLD = 3;
export const CODEX_COPILOT_AUTH_REFRESH_AUTO_PAUSE_THRESHOLD = 1;
export const CODEX_RESULT_ERROR_AUTO_PAUSE_STREAK_WINDOW_MS = 10 * 60 * 1000;

const MODEL_BACKEND_STREAM_ERROR_SUMMARY = "Model backend stream disconnected before completion.";
const COPILOT_AUTH_REFRESH_EXHAUSTED_SUMMARY = "GitHub Copilot API-key refresh exhausted its retry budget.";
const COPILOT_AUTH_REFRESH_INVALIDATED_SUMMARY =
  "GitHub Copilot authentication became invalid while connectivity was recovering.";
const MODEL_NOT_SUPPORTED_SUMMARY = "The selected model was rejected as unsupported by the provider.";

export interface ClassifiedCodexResultError {
  family: CodexResultErrorFamily;
  fingerprint: string;
  message: string;
}

export interface CodexResultErrorAutoPauseSessionLike {
  state: Pick<SessionState, "codex_result_error_auto_pause">;
}

export interface CodexAutoPauseRecoveryTestingSessionLike extends CodexResultErrorAutoPauseSessionLike {
  isGenerating?: boolean;
  codexAdapter?: { getCurrentTurnId?: () => string | null } | null;
  state: Pick<SessionState, "codex_result_error_auto_pause" | "backend_state">;
  pendingCodexTurns: Array<
    Pick<
      CodexOutboundTurn,
      "autoPauseRecoveryTestingRetired" | "autoPauseSourceKind" | "status" | "turnId" | "turnTarget"
    >
  >;
}

export interface CodexAutoPausedQueuedBacklogSessionLike extends CodexResultErrorAutoPauseSessionLike {
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
}

export function classifyCodexResultError(msg: CLIResultMessage): ClassifiedCodexResultError | null {
  if (!msg.is_error) return null;
  if (typeof msg.codex_turn_id !== "string" || !msg.codex_turn_id.trim()) return null;
  if (typeof msg.result !== "string") return null;

  const normalized = msg.result.toLowerCase();
  if (
    normalized.includes("litellm.authenticationerror") &&
    normalized.includes("failed to refresh api key") &&
    normalized.includes("after maximum retries") &&
    normalized.includes("github_copilot/")
  ) {
    return {
      family: "copilot_auth_refresh_exhausted",
      fingerprint: "copilot_auth_refresh_exhausted:github_copilot",
      message: COPILOT_AUTH_REFRESH_EXHAUSTED_SUMMARY,
    };
  }

  const modelNotSupported =
    normalized.includes("model_not_supported") || normalized.includes("requested model is not supported");
  if (modelNotSupported) {
    if (msg.codex_provider_failure_context?.family === "copilot_auth_refresh_invalidated") {
      return {
        family: "copilot_auth_refresh_invalidated",
        fingerprint: "copilot_auth_refresh_invalidated:github_copilot",
        message: COPILOT_AUTH_REFRESH_INVALIDATED_SUMMARY,
      };
    }
    return {
      family: "model_not_supported",
      fingerprint: "model_not_supported:selected_model",
      message: MODEL_NOT_SUPPORTED_SUMMARY,
    };
  }

  if (
    normalized.includes("stream disconnected before completion") &&
    normalized.includes("error sending request") &&
    normalized.includes("/responses")
  ) {
    return {
      family: "model_backend_stream_error",
      fingerprint: "model_backend_stream_error:responses",
      message: MODEL_BACKEND_STREAM_ERROR_SUMMARY,
    };
  }

  return null;
}

export function getCodexTurnSourceKind(
  turn: Pick<CodexOutboundTurn, "autoPauseSourceKind"> | null | undefined,
): CodexAutoPauseInputSourceKind {
  return turn?.autoPauseSourceKind ?? "automatic";
}

export function determineCodexInputSourceKind(input: PendingCodexInput): CodexAutoPauseInputSourceKind {
  if (input.autoPauseSourceKind) return input.autoPauseSourceKind;
  return determineUserMessageSourceKind({
    type: "user_message",
    content: input.content,
    ...(input.agentSource ? { agentSource: input.agentSource } : {}),
    ...(input.takodeHerdBatch ? { takodeHerdBatch: input.takodeHerdBatch } : {}),
  });
}

export function determineCodexTurnSourceKind(inputs: readonly PendingCodexInput[]): CodexAutoPauseInputSourceKind {
  if (inputs.length === 0) return "automatic";
  return inputs.every((input) => determineCodexInputSourceKind(input) === "manual") ? "manual" : "automatic";
}

export function determineUserMessageSourceKind(msg: BrowserUserMessage): CodexAutoPauseInputSourceKind {
  if (msg.autoPauseSourceKind) return msg.autoPauseSourceKind;
  if (msg.inputSource === "composer") return "manual";
  if (msg.takodeHerdBatch) return "automatic";
  if (isTimerReminderContent(msg.content)) return "automatic";
  if (!msg.agentSource) return "automatic";
  if (isSystemSourceTag(msg.agentSource) || isTimerSourceTag(msg.agentSource)) return "automatic";
  if (msg.agentSource.sessionId === "herd-events") return "automatic";
  return "automatic";
}

export function isAutomaticCodexAutoPauseInput(msg: BrowserUserMessage): boolean {
  return determineUserMessageSourceKind(msg) === "automatic";
}

export function noteCodexResultForAutoPause(
  session: CodexResultErrorAutoPauseSessionLike,
  msg: CLIResultMessage,
  turn:
    | Pick<
        CodexOutboundTurn,
        | "autoPauseRecoveryTestingRetired"
        | "autoPauseSourceKind"
        | "providerRecoveryAttempts"
        | "providerRecoveryFamily"
        | "turnTarget"
      >
    | null
    | undefined,
  now = Date.now(),
  options: { retainPausedOwnerOnResume?: boolean } = {},
): {
  changed: boolean;
  pausedNow: boolean;
  resumedNow: boolean;
  diagnostic?: string;
  heldInputs?: CodexAutoPauseHeldInput[];
} {
  const classified = classifyCodexResultError(msg);
  if (!classified) {
    if (!msg.is_error) {
      return noteCodexAutoPauseRecoverySuccess(session, turn, options.retainPausedOwnerOnResume === true);
    }
    return { changed: false, pausedNow: false, resumedNow: false };
  }

  const sourceKind = getCodexTurnSourceKind(turn);
  const existing = session.state.codex_result_error_auto_pause ?? null;
  const sameFingerprint = existing?.fingerprint === classified.fingerprint;
  const withinWindow = !!existing && now - existing.lastErrorAt <= CODEX_RESULT_ERROR_AUTO_PAUSE_STREAK_WINDOW_MS;
  const priorHeld = existing?.heldInputs ?? [];
  const streak = sameFingerprint && withinWindow ? existing.streak + 1 : 1;
  const totalMatchingErrors = sameFingerprint ? existing.totalMatchingErrors + 1 : 1;
  const threshold = getCodexResultErrorAutoPauseThreshold(classified.family);
  const pausedAt = existing?.pausedAt ?? (streak >= threshold ? now : null);
  const wasPaused = !!existing?.pausedAt;
  const pausedNow = !wasPaused && !!pausedAt;
  const state: CodexResultErrorAutoPauseState = {
    family: classified.family,
    fingerprint: classified.fingerprint,
    streak,
    threshold,
    pausedAt,
    lastError: classified.message,
    lastErrorAt: now,
    lastSourceKind: sourceKind,
    totalMatchingErrors,
    heldInputs: priorHeld,
    ...(existing?.releaseProgress ? { releaseProgress: existing.releaseProgress } : {}),
  };
  session.state.codex_result_error_auto_pause = state;
  return {
    changed: true,
    pausedNow,
    resumedNow: false,
    ...(pausedNow
      ? {
          diagnostic: buildCodexAutoPauseDiagnostic(state),
        }
      : {}),
  };
}

export function noteCodexAutoPauseRecoverySuccess(
  session: CodexResultErrorAutoPauseSessionLike,
  turn:
    | Pick<
        CodexOutboundTurn,
        | "autoPauseRecoveryTestingRetired"
        | "autoPauseSourceKind"
        | "providerRecoveryAttempts"
        | "providerRecoveryFamily"
        | "turnTarget"
      >
    | null
    | undefined,
  retainPausedOwner = false,
): { changed: boolean; pausedNow: false; resumedNow: boolean; heldInputs?: CodexAutoPauseHeldInput[] } {
  return clearCodexResultErrorAutoPauseAfterSuccess(session, turn, retainPausedOwner);
}

export function queueCodexAutoPausedInput(
  session: CodexResultErrorAutoPauseSessionLike,
  source: PausedInboundSource,
  message: BrowserUserMessage,
  now = Date.now(),
): CodexAutoPauseHeldInput | null {
  const state = getActiveCodexResultErrorAutoPause(session);
  if (!state) return null;
  const key = codexAutoPauseCoalesceKey(source, message);
  const existing = state.heldInputs.find((item) => codexAutoPauseCoalesceKey(item.source, item.message) === key);
  if (existing) {
    const autoPauseRecoveries = mergeRecoveryLinks(existing.message.autoPauseRecoveries, message.autoPauseRecoveries);
    existing.count += 1;
    existing.lastQueuedAt = now;
    existing.message = {
      ...message,
      ...(autoPauseRecoveries.length ? { autoPauseRecoveries } : {}),
    };
    return existing;
  }
  let ordinal = state.heldInputs.length + 1;
  let id = `codex-auto-pause-${now}-${ordinal}`;
  while (state.heldInputs.some((item) => item.id === id)) {
    ordinal += 1;
    id = `codex-auto-pause-${now}-${ordinal}`;
  }
  const item: CodexAutoPauseHeldInput = {
    id,
    queuedAt: now,
    lastQueuedAt: now,
    source,
    message,
    count: 1,
  };
  state.heldInputs.push(item);
  return item;
}

export function getActiveCodexResultErrorAutoPause(
  session: CodexResultErrorAutoPauseSessionLike | null | undefined,
): CodexResultErrorAutoPauseState | null {
  const state = session?.state.codex_result_error_auto_pause ?? null;
  return state?.pausedAt ? state : null;
}

export function isCodexAutoPauseRecoveryTesting(
  session: CodexAutoPauseRecoveryTestingSessionLike | null | undefined,
): boolean {
  return getCodexAutoPauseRecoveryProgress(session) !== null;
}

export function getCodexAutoPauseRecoveryProgress(
  session: CodexAutoPauseRecoveryTestingSessionLike | null | undefined,
): CodexAutoPauseRecoveryProgress | null {
  if (!session || !getActiveCodexResultErrorAutoPause(session)) return null;
  const owner = session.pendingCodexTurns.find(
    (turn) =>
      turn.turnTarget === "current" &&
      turn.autoPauseRecoveryTestingRetired !== true &&
      turn.autoPauseSourceKind === "manual" &&
      (turn.status === "queued" || turn.status === "dispatched" || turn.status === "backend_acknowledged"),
  );
  if (!owner) return null;
  const activeTurnId = session.codexAdapter?.getCurrentTurnId?.() ?? null;
  const hasComparableLiveOwner =
    owner.status === "backend_acknowledged" &&
    !!owner.turnId &&
    !!activeTurnId &&
    session.isGenerating === true &&
    session.state.backend_state === "connected";
  if (hasComparableLiveOwner) return owner.turnId === activeTurnId ? "active" : null;
  return "testing";
}

export function getCodexAutoPauseHeldInputCount(state: CodexResultErrorAutoPauseState | null | undefined): number {
  return (state?.heldInputs ?? []).reduce((total, item) => total + Math.max(1, item.count), 0);
}

export function buildCodexAutoPauseDiagnostic(state: CodexResultErrorAutoPauseState): string {
  const heldCount = getCodexAutoPauseHeldInputCount(state);
  const heldSuffix =
    heldCount === 0 ? "No automatic inputs are currently held." : `${heldCount} automatic input(s) are held.`;
  if (state.family === "model_not_supported") {
    return (
      "Automatic inputs are paused because the selected model is not available. " +
      `${heldSuffix} Choose a supported model, then send a message. ` +
      "Takode will not change models or retry this automatic work on another model."
    );
  }
  const reason =
    state.family === "copilot_auth_refresh_exhausted"
      ? "Copilot sign-in could not be refreshed"
      : state.family === "copilot_auth_refresh_invalidated"
        ? "Copilot sign-in expired while Takode was reconnecting"
        : "the model connection dropped repeatedly";
  const action =
    state.family === "copilot_auth_refresh_exhausted" || state.family === "copilot_auth_refresh_invalidated"
      ? "Sign in to Copilot again, then retry this session."
      : "Takode will keep trying the current message; you can also send a message to retry now.";
  return (
    `Automatic inputs are paused because ${reason}. ` +
    `${heldSuffix} ${action} Held inputs will send after this session completes a message successfully.`
  );
}

function getCodexResultErrorAutoPauseThreshold(family: CodexResultErrorFamily): number {
  return family === "copilot_auth_refresh_exhausted" || family === "model_not_supported"
    ? CODEX_COPILOT_AUTH_REFRESH_AUTO_PAUSE_THRESHOLD
    : CODEX_RESULT_ERROR_AUTO_PAUSE_THRESHOLD;
}

export function materializeCodexAutoPausedInputsForDrain(
  heldInputs: readonly CodexAutoPauseHeldInput[],
  recoverySummaryId?: string,
): BrowserUserMessage[] {
  return heldInputs.map((item) => {
    const message =
      item.count <= 1
        ? item.message
        : {
            ...item.message,
            content:
              `[Takode auto-pause resumed: ${item.count} similar automatic inputs were coalesced while delivery was paused.]\n\n` +
              item.message.content,
          };
    if (!recoverySummaryId) return message;
    return {
      ...message,
      autoPauseRecoveries: mergeRecoveryLinks(message.autoPauseRecoveries, [
        { summaryId: recoverySummaryId, groupId: item.id },
      ]),
    };
  });
}

export function sweepCodexAutoPausedQueuedBacklog(
  session: CodexAutoPausedQueuedBacklogSessionLike,
  now = Date.now(),
): { changed: boolean; heldInputCount: number; heldInputIds: string[] } {
  if (!getActiveCodexResultErrorAutoPause(session)) {
    return { changed: false, heldInputCount: 0, heldInputIds: [] };
  }

  const heldInputIds: string[] = [];
  const remainingInputs: PendingCodexInput[] = [];
  const recoverySensitiveInputIds = new Set(
    session.pendingCodexTurns
      .filter(
        (turn) =>
          turn.historyTrackingUnknown === true ||
          turn.requiresFreshSuccessor === true ||
          turn.historyIncorporation?.attempt === 1 ||
          turn.dispatchCount > 0 ||
          turn.acknowledgedAt != null ||
          turn.historyIncorporation?.rpcAcceptedAt != null ||
          turn.historyIncorporation?.recordedAt != null ||
          turn.status === "recovery_pending" ||
          turn.terminalHistoryReconciliation != null,
      )
      .flatMap((turn) => turn.pendingInputIds ?? [turn.userMessageId]),
  );
  for (const input of session.pendingCodexInputs) {
    if (
      isEligibleQueuedAutomaticCodexInput(input) &&
      !input.requireFreshSuccessor &&
      !recoverySensitiveInputIds.has(input.id)
    ) {
      queueCodexAutoPausedInput(session, "programmatic", pendingCodexInputToAutoPauseMessage(input), now);
      heldInputIds.push(input.id);
      continue;
    }
    remainingInputs.push(input);
  }

  let changed = heldInputIds.length > 0;
  if (changed) {
    session.pendingCodexInputs = remainingInputs;
  }
  const prunedQueuedTurns = pruneHeldQueuedCodexStartPendingTurns(session);
  changed ||= prunedQueuedTurns;

  return {
    changed,
    heldInputCount: heldInputIds.length,
    heldInputIds,
  };
}

export function holdCodexAutoPausedQueuedBacklog<TSession extends CodexAutoPausedQueuedBacklogSessionLike>(
  session: TSession,
  deps: {
    broadcastPendingCodexInputs: (session: TSession) => void;
    broadcastToBrowsers: (session: TSession, msg: BrowserIncomingMessage) => void;
    persistSession: (session: TSession) => void;
  },
): boolean {
  const swept = sweepCodexAutoPausedQueuedBacklog(session);
  if (!swept.changed) return false;
  deps.broadcastPendingCodexInputs(session);
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { codex_result_error_auto_pause: session.state.codex_result_error_auto_pause ?? null },
  });
  deps.persistSession(session);
  return true;
}

function clearCodexResultErrorAutoPauseAfterSuccess(
  session: CodexResultErrorAutoPauseSessionLike,
  turn:
    | Pick<
        CodexOutboundTurn,
        | "autoPauseRecoveryTestingRetired"
        | "autoPauseSourceKind"
        | "providerRecoveryAttempts"
        | "providerRecoveryFamily"
        | "turnTarget"
      >
    | null
    | undefined,
  retainPausedOwner: boolean,
): { changed: boolean; pausedNow: false; resumedNow: boolean; heldInputs?: CodexAutoPauseHeldInput[] } {
  const existing = session.state.codex_result_error_auto_pause ?? null;
  if (!existing) return { changed: false, pausedNow: false, resumedNow: false };
  if (existing.releaseProgress?.status === "releasing") {
    return { changed: false, pausedNow: false, resumedNow: false };
  }
  if (existing.pausedAt && !isAcceptedCodexAutoPauseRecoveryOwner(turn, existing)) {
    return { changed: false, pausedNow: false, resumedNow: false };
  }
  const heldInputs = existing.pausedAt ? existing.heldInputs : [];
  if (!retainPausedOwner) session.state.codex_result_error_auto_pause = null;
  return {
    changed: true,
    pausedNow: false,
    resumedNow: !!existing.pausedAt,
    ...(existing.pausedAt ? { heldInputs } : {}),
  };
}

function isAcceptedCodexAutoPauseRecoveryOwner(
  turn:
    | Pick<
        CodexOutboundTurn,
        | "autoPauseRecoveryTestingRetired"
        | "autoPauseSourceKind"
        | "providerRecoveryAttempts"
        | "providerRecoveryFamily"
        | "turnTarget"
      >
    | null
    | undefined,
  activePause: CodexResultErrorAutoPauseState,
): boolean {
  if (turn?.turnTarget !== "current" || turn.autoPauseRecoveryTestingRetired === true) return false;
  if (turn.autoPauseSourceKind === "manual") return true;
  return (turn.providerRecoveryAttempts ?? 0) > 0 && turn.providerRecoveryFamily === activePause.family;
}

function isEligibleQueuedAutomaticCodexInput(input: PendingCodexInput): boolean {
  return input.deliveryState !== "failed" && input.cancelable && determineCodexInputSourceKind(input) === "automatic";
}

function pendingCodexInputToAutoPauseMessage(input: PendingCodexInput): BrowserUserMessage {
  return {
    type: "user_message",
    content: input.content,
    // The original browser message id was recorded before Codex deferred
    // history commit. Reusing it during drain would trip ingress idempotency
    // and drop this uncommitted pending input.
    ...(input.imageRefs?.length ? { imageRefs: input.imageRefs } : {}),
    ...(input.deliveryContent ? { deliveryContent: input.deliveryContent } : {}),
    ...(input.timerFiring
      ? {
          timerFiring: {
            ...input.timerFiring,
            ...(input.leaderTimerMessageId ? { messageId: input.leaderTimerMessageId } : {}),
          },
        }
      : {}),
    ...(input.replyContext ? { replyContext: input.replyContext } : {}),
    ...(input.vscodeSelection ? { vscodeSelection: input.vscodeSelection } : {}),
    ...(input.agentSource ? { agentSource: input.agentSource } : {}),
    ...(input.takodeHerdBatch ? { takodeHerdBatch: input.takodeHerdBatch } : {}),
    ...(input.threadKey ? { threadKey: input.threadKey } : {}),
    ...(input.questId ? { questId: input.questId } : {}),
    ...(input.threadRefs ? { threadRefs: input.threadRefs } : {}),
    ...(input.autoPauseSourceKind ? { autoPauseSourceKind: input.autoPauseSourceKind } : {}),
    ...(input.autoPauseRecoveries?.length ? { autoPauseRecoveries: input.autoPauseRecoveries } : {}),
    ...(input.leaderThreadOutcomeReminderGuard
      ? { leaderThreadOutcomeReminderGuard: input.leaderThreadOutcomeReminderGuard }
      : {}),
  };
}

function mergeRecoveryLinks(
  left: BrowserUserMessage["autoPauseRecoveries"],
  right: BrowserUserMessage["autoPauseRecoveries"],
) {
  const seen = new Set<string>();
  return [...(left ?? []), ...(right ?? [])].filter((link) => {
    const key = `${link.summaryId}\u0000${link.groupId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pruneHeldQueuedCodexStartPendingTurns(session: CodexAutoPausedQueuedBacklogSessionLike): boolean {
  const pendingById = new Map(session.pendingCodexInputs.map((input) => [input.id, input]));
  let changed = false;

  for (let idx = session.pendingCodexTurns.length - 1; idx >= 0; idx--) {
    const turn = session.pendingCodexTurns[idx];
    if (!turn || !isQueuedCodexStartPendingTurn(turn)) continue;
    const ids = turn.pendingInputIds ?? [turn.userMessageId];
    const retainedInputs = ids.map((id) => pendingById.get(id)).filter((input): input is PendingCodexInput => !!input);
    if (retainedInputs.length === ids.length) continue;

    changed = true;
    if (retainedInputs.length === 0) {
      session.pendingCodexTurns.splice(idx, 1);
      continue;
    }

    const inputIds = retainedInputs.map((input) => input.id);
    const historyIncorporation = createCodexHistoryIncorporation(inputIds);
    turn.adapterMsg = {
      type: "codex_start_pending",
      pendingInputIds: inputIds,
      inputs: buildQueuedCodexBatchMessageInputs(retainedInputs),
      clientUserMessageId: historyIncorporation.clientUserMessageId,
    };
    turn.userMessageId = retainedInputs[0].id;
    turn.pendingInputIds = inputIds;
    turn.userContent = buildQueuedCodexPendingBatchText(retainedInputs);
    turn.autoPauseSourceKind = determineCodexTurnSourceKind(retainedInputs);
    turn.autoPauseRecoveryLinks = collectCodexAutoPauseRecoveryLinks(retainedInputs);
    turn.historyIncorporation = historyIncorporation;
    turn.historyTrackingUnknown = undefined;
    turn.requiresFreshSuccessor = retainedInputs.some((input) => input.requireFreshSuccessor) || undefined;
    turn.updatedAt = Date.now();
    turn.lastError = null;
  }

  return changed;
}

function isQueuedCodexStartPendingTurn(turn: CodexOutboundTurn): boolean {
  return (
    (turn.status === "queued" || turn.status === "blocked_broken_session") &&
    turn.historyTrackingUnknown !== true &&
    turn.dispatchCount === 0 &&
    turn.acknowledgedAt == null &&
    turn.turnId == null &&
    turn.adapterMsg.type === "codex_start_pending" &&
    !turn.providerRecoveryFamily &&
    turn.historyIncorporation?.rpcAcceptedAt == null &&
    turn.historyIncorporation?.recordedAt == null
  );
}

function buildQueuedCodexBatchMessageInputs(inputs: PendingCodexInput[]): CodexPendingBatchInput[] {
  return inputs.map((input) => ({
    content: input.deliveryContent || input.content,
    ...(input.vscodeSelection ? { vscodeSelection: input.vscodeSelection } : {}),
  }));
}

function buildQueuedCodexPendingBatchText(inputs: PendingCodexInput[]): string {
  return inputs
    .map((input) => input.deliveryContent || input.content)
    .filter(Boolean)
    .join("\n\n");
}

function codexAutoPauseCoalesceKey(source: PausedInboundSource, message: BrowserUserMessage): string {
  const agent = message.agentSource?.sessionId ?? "";
  const thread = message.threadKey ?? message.questId ?? "";
  const herd = message.takodeHerdBatch?.eventKeys?.join(",") ?? "";
  return [source, agent, thread, herd, message.content.trim(), message.timerFiring?.messageId ?? ""].join("\u0000");
}
