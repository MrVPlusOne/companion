import { isCodexTurnRecoverySourceId } from "../../shared/injected-event-message.js";
import { formatReplyContentForPreview } from "../../shared/reply-context.js";
import type { BrowserIncomingMessage, CodexOutboundTurn, PendingCodexInput } from "../session-types.js";
import {
  buildNeedsInputReminderHistoryEntry,
  commitQueuedNeedsInputResolutionNoticeHistoryEntry,
  restoreQueuedNeedsInputResolutionNotices,
  shouldCommitNeedsInputReminderHistoryEntry,
} from "./adapter-browser-routing-needs-input-reminder.js";
import {
  collectCodexAutoPauseRecoveryLinks,
  markCodexAutoPauseRecoveryDelivered,
} from "./codex-auto-pause-recovery-summary.js";
import { determineCodexTurnSourceKind } from "../codex-result-error-auto-pause.js";
import { getTakodeHerdEventBrowserMetadata } from "../herd-event-browser-metadata.js";
import {
  isActualHumanUserInput,
  isActualHumanUserMessage,
  restoreSessionMessagePreview,
} from "../user-message-classification.js";
import {
  absoluteHistoryEnd,
  createCodexHistoryIncorporationForClient,
  markCodexHistoryRecorded,
  markCodexHistoryRpcAccepted,
  stageCodexTerminalHistoryReconciliation,
} from "./codex-history-incorporation.js";
import { recordCodexHistoryMilestoneProof } from "./codex-recovery-diagnostics.js";
import type { TurnSteerFailureInfo } from "./adapter-interface.js";
import { blocksAutomaticCodexResumeTurnRecovery } from "./codex-provider-result-recovery.js";
import { summarizeLocalCodexDeliveryActivityFrom } from "./codex-delivery-ownership.js";
import { buildCodexBatchMessageInputs, buildCodexPendingBatchRecoveryText } from "./codex-pending-start-batch.js";
import { clearLeaderThreadStatusForCoveredUserMessage } from "./thread-routing-reminder.js";
import type {
  CodexRecoveryOrchestratorDeps,
  CodexRecoveryOrchestratorSessionLike,
} from "./codex-recovery-orchestrator.js";

interface PendingReceiptObservation {
  turnId: string;
  observedAt: number;
  activityStartHistoryIndex: number;
}

function promoteReceiptProvenSameTurnSteerToCurrent(
  session: CodexRecoveryOrchestratorSessionLike,
  turn: CodexOutboundTurn,
  providerTurnId: string,
): boolean {
  if (turn.turnTarget !== "queued" || !session.isGenerating) return false;
  const hasCurrentSameTurnOwner = session.pendingCodexTurns.some(
    (candidate) =>
      candidate !== turn &&
      candidate.status !== "completed" &&
      candidate.turnTarget === "current" &&
      candidate.turnId === providerTurnId,
  );
  if (!hasCurrentSameTurnOwner) return false;
  turn.turnTarget = "current";
  return true;
}

const pendingReceiptObservations = new WeakMap<object, Map<string, PendingReceiptObservation>>();
const PENDING_RECEIPT_OBSERVATION_LIMIT = 512;

export function recordCodexHistoryReceiptObservation(
  session: CodexRecoveryOrchestratorSessionLike,
  receipt: { turnId: string; clientUserMessageId: string; observedAt?: number },
  deps: CodexRecoveryOrchestratorDeps,
): void {
  let observations = pendingReceiptObservations.get(session);
  if (!observations) {
    observations = new Map();
    pendingReceiptObservations.set(session, observations);
  }
  if (!observations.has(receipt.clientUserMessageId)) {
    observations.set(receipt.clientUserMessageId, {
      turnId: receipt.turnId,
      observedAt: receipt.observedAt ?? Date.now(),
      activityStartHistoryIndex: absoluteHistoryEnd(session),
    });
  }
  while (observations.size > PENDING_RECEIPT_OBSERVATION_LIMIT) {
    const oldest = observations.keys().next().value;
    if (typeof oldest !== "string") break;
    observations.delete(oldest);
  }

  const matching = session.pendingCodexTurns.filter(
    (turn) =>
      turn.status !== "completed" &&
      !turn.terminalHistoryReconciliation &&
      turn.historyIncorporation?.clientUserMessageId === receipt.clientUserMessageId &&
      (!turn.historyIncorporation.providerTurnId || turn.historyIncorporation.providerTurnId === receipt.turnId) &&
      (!turn.turnId || turn.turnId === receipt.turnId),
  );
  if (matching.length !== 1) return;
  const turn = matching[0]!;
  turn.turnId ??= receipt.turnId;
  turn.historyIncorporation!.providerTurnId ??= receipt.turnId;
  const observation = observations.get(receipt.clientUserMessageId)!;
  let changed = promoteReceiptProvenSameTurnSteerToCurrent(session, turn, receipt.turnId);
  changed = finalizeCodexBatchBrowserHistory(session, turn, deps, true) || changed;
  if (markCodexHistoryRecorded(turn, "live", observation.activityStartHistoryIndex, observation.observedAt)) {
    recordCodexHistoryMilestoneProof(session, turn, "recorded");
    changed = true;
  }
  if (changed) deps.persistSession(session);
}

export function addPendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  input: PendingCodexInput,
  deps: Pick<CodexRecoveryOrchestratorDeps, "touchUserMessage" | "broadcastPendingCodexInputs">,
): void {
  const beforeIndex = input.queueBeforeOwnerId
    ? session.pendingCodexInputs.findIndex((candidate) => candidate.id === input.queueBeforeOwnerId)
    : -1;
  if (beforeIndex >= 0) session.pendingCodexInputs.splice(beforeIndex, 0, input);
  else session.pendingCodexInputs.push(input);
  session.lastUserMessage = formatReplyContentForPreview(input.content || "", input.replyContext).slice(0, 80);
  session.lastMessagePreviewAt = input.timestamp;
  if (isActualHumanUserInput(input)) deps.touchUserMessage(session.id, input.timestamp);
  deps.broadcastPendingCodexInputs(session);
}

export function setPendingCodexInputCancelable(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  cancelable: boolean,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const pending = session.pendingCodexInputs.find((item) => item.id === id);
  if (!pending || pending.cancelable === cancelable) return;
  pending.cancelable = cancelable;
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
}

export function setPendingCodexInputsCancelable(
  session: CodexRecoveryOrchestratorSessionLike,
  ids: string[],
  cancelable: boolean,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  let changed = false;
  const idSet = new Set(ids);
  for (const pending of session.pendingCodexInputs) {
    if (!idSet.has(pending.id) || pending.cancelable === cancelable) continue;
    pending.cancelable = cancelable;
    changed = true;
  }
  if (!changed) return;
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
}

export function getCancelablePendingCodexInputs(
  session: Pick<CodexRecoveryOrchestratorSessionLike, "pendingCodexInputs">,
): PendingCodexInput[] {
  return session.pendingCodexInputs.filter((item) => item.cancelable && item.deliveryState !== "failed");
}

export function commitPendingCodexInputs(
  session: CodexRecoveryOrchestratorSessionLike,
  ids: string[],
  deps: CodexRecoveryOrchestratorDeps,
  options: { deliveryConfirmed?: boolean } = {},
): number[] {
  const indexes: number[] = [];
  for (const id of ids) {
    const idx = commitPendingCodexInput(session, id, deps, options.deliveryConfirmed !== false);
    if (typeof idx === "number" && idx >= 0) indexes.push(idx);
  }
  return indexes;
}

export function getPendingCodexInputsByIds(
  session: Pick<CodexRecoveryOrchestratorSessionLike, "pendingCodexInputs">,
  ids: string[],
): PendingCodexInput[] {
  const idSet = new Set(ids);
  return session.pendingCodexInputs.filter((input) => idSet.has(input.id));
}

export function recordSubmittedCodexSteerTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  expectedTurnId: string,
  inputs: PendingCodexInput[],
  clientUserMessageId: string,
  deps: CodexRecoveryOrchestratorDeps,
): CodexOutboundTurn | null {
  if (inputs.length === 0) return null;
  const now = Date.now();
  const pendingInputIds = inputs.map((input) => input.id);
  const historyIncorporation = createCodexHistoryIncorporationForClient(pendingInputIds, clientUserMessageId);
  if (!historyIncorporation) return null;
  historyIncorporation.providerTurnId = expectedTurnId;
  const turn: CodexOutboundTurn = {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds,
      inputs: buildCodexBatchMessageInputs(inputs),
      clientUserMessageId,
    },
    userMessageId: pendingInputIds[0]!,
    pendingInputIds,
    userContent: buildCodexPendingBatchRecoveryText(inputs, deps),
    historyIndex: -1,
    status: "dispatched",
    dispatchCount: 1,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
    turnTarget: "queued",
    lastError: null,
    turnId: expectedTurnId,
    disconnectedAt: null,
    resumeConfirmedAt: null,
    autoPauseSourceKind: determineCodexTurnSourceKind(inputs),
    autoPauseRecoveryLinks: collectCodexAutoPauseRecoveryLinks(inputs),
    historyIncorporation,
    requiresFreshSuccessor: inputs.some((input) => input.requireFreshSuccessor) || undefined,
  };
  let insertAt = session.pendingCodexTurns.length;
  for (let index = session.pendingCodexTurns.length - 1; index >= 0; index--) {
    if (session.pendingCodexTurns[index]?.turnId === expectedTurnId) {
      insertAt = index + 1;
      break;
    }
  }
  session.pendingCodexTurns.splice(insertAt, 0, turn);
  deps.persistSession(session);
  return turn;
}

export function recordSteeredCodexTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  turnId: string,
  inputs: PendingCodexInput[],
  clientUserMessageId: string,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const now = Date.now();
  const existing = session.pendingCodexTurns.find(
    (turn) => turn.status !== "completed" && turn.historyIncorporation?.clientUserMessageId === clientUserMessageId,
  );
  if (existing) {
    existing.turnId = turnId;
    existing.status = "backend_acknowledged";
    existing.acknowledgedAt = now;
    existing.updatedAt = now;
    existing.lastError = null;
    markCodexHistoryRpcAccepted(existing, turnId, now);
    deps.persistSession(session);
    return;
  }
  if (inputs.length === 0) return;
  const pendingInputIds = inputs.map((input) => input.id);
  const historyIncorporation = createCodexHistoryIncorporationForClient(pendingInputIds, clientUserMessageId);
  if (!historyIncorporation) return;
  historyIncorporation.providerTurnId = turnId;
  historyIncorporation.rpcAcceptedAt = now;
  deps.enqueueCodexTurn(session, {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds,
      inputs: buildCodexBatchMessageInputs(inputs),
      clientUserMessageId,
    },
    userMessageId: pendingInputIds[0]!,
    pendingInputIds,
    userContent: buildCodexPendingBatchRecoveryText(inputs, deps),
    historyIndex: -1,
    status: "backend_acknowledged",
    dispatchCount: 1,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: now,
    turnTarget: "queued",
    lastError: null,
    turnId,
    disconnectedAt: null,
    resumeConfirmedAt: null,
    autoPauseSourceKind: determineCodexTurnSourceKind(inputs),
    autoPauseRecoveryLinks: collectCodexAutoPauseRecoveryLinks(inputs),
    historyIncorporation,
  });
}

export function reconcileSubmittedCodexSteerFailure(
  session: CodexRecoveryOrchestratorSessionLike,
  pendingInputIds: string[],
  clientUserMessageId: string | undefined,
  failure: TurnSteerFailureInfo | undefined,
  deps: CodexRecoveryOrchestratorDeps,
): "missing" | "released" | "retained" | "terminal" {
  const candidates = session.pendingCodexTurns
    .map((turn, index) => ({ turn, index }))
    .filter(
      ({ turn }) =>
        turn.status === "dispatched" &&
        turn.historyIncorporation != null &&
        (!clientUserMessageId || turn.historyIncorporation.clientUserMessageId === clientUserMessageId) &&
        sameOrderedIds(turn.pendingInputIds ?? [turn.userMessageId], pendingInputIds),
    );
  if (candidates.length !== 1) return "missing";
  const turnIndex = candidates[0]!.index;
  const turn = session.pendingCodexTurns[turnIndex]!;
  const recorded = turn.historyIncorporation?.recordedAt != null;
  const providerRejected = failure?.kind === "no_active_turn" || failure?.kind === "active_turn_mismatch";
  const terminalFailure =
    failure?.kind === "other" && blocksAutomaticCodexResumeTurnRecovery({ error: failure.message });
  if (providerRejected && !recorded) {
    session.pendingCodexTurns.splice(turnIndex, 1);
    deps.persistSession(session);
    return "released";
  }
  finalizeCodexBatchBrowserHistory(session, turn, deps, recorded);
  const reason = terminalFailure
    ? "turn_steer_failed_terminal_error"
    : recorded
      ? "turn_steer_failed_after_history_receipt"
      : "turn_steer_failed_before_history_receipt";
  stageCodexTerminalHistoryReconciliation(turn, {
    presence: recorded ? "present" : "unknown",
    reason,
    action: terminalFailure ? "action_required" : "continue",
    continuationMode: terminalFailure ? null : "verify_then_continue",
    classifiedAt: Date.now(),
  });
  recordCodexHistoryMilestoneProof(session, turn, terminalFailure ? "automatic_recovery_blocked" : "classified", {
    historyPresence: recorded ? "present" : "unknown",
    classification: reason,
    continuationMode: terminalFailure ? null : "verify_then_continue",
  });
  deps.persistSession(session);
  return terminalFailure ? "terminal" : "retained";
}

export function recordCodexHistoryIncorporationReceipt(
  session: CodexRecoveryOrchestratorSessionLike,
  receipt: { turnId: string; clientUserMessageId: string; observedAt?: number },
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const matching = session.pendingCodexTurns.filter(
    (turn) =>
      turn.status === "backend_acknowledged" &&
      !turn.terminalHistoryReconciliation &&
      turn.historyIncorporation?.clientUserMessageId === receipt.clientUserMessageId &&
      turn.historyIncorporation.providerTurnId === receipt.turnId &&
      turn.turnId === receipt.turnId,
  );
  if (matching.length !== 1) return;
  const turn = matching[0]!;
  const observation = pendingReceiptObservations.get(session)?.get(receipt.clientUserMessageId);
  pendingReceiptObservations.get(session)?.delete(receipt.clientUserMessageId);
  const activityStartHistoryIndex = observation?.activityStartHistoryIndex ?? absoluteHistoryEnd(session);
  let changed = promoteReceiptProvenSameTurnSteerToCurrent(session, turn, receipt.turnId);
  changed = finalizeCodexBatchBrowserHistory(session, turn, deps, true) || changed;
  const recorded = markCodexHistoryRecorded(
    turn,
    "live",
    activityStartHistoryIndex,
    observation?.observedAt ?? receipt.observedAt ?? Date.now(),
  );
  if (recorded) recordCodexHistoryMilestoneProof(session, turn, "recorded");
  const postReceiptActivity = summarizeLocalCodexDeliveryActivityFrom(
    session,
    activityStartHistoryIndex,
    turn.userMessageId,
  );
  if (postReceiptActivity.count > 0 && !turn.providerReplayUnsafeActivityObserved) {
    turn.providerReplayUnsafeActivityObserved = true;
    recordCodexHistoryMilestoneProof(session, turn, "activity_observed");
    changed = true;
  }
  changed = recorded || changed;
  if (changed) deps.persistSession(session);
}

export function finalizeCodexBatchBrowserHistory(
  session: CodexRecoveryOrchestratorSessionLike,
  turn: CodexOutboundTurn,
  deps: CodexRecoveryOrchestratorDeps,
  deliveryConfirmed: boolean,
): boolean {
  const inputIds = turn.pendingInputIds ?? [turn.userMessageId];
  const committed = commitPendingCodexInputs(session, inputIds, deps, { deliveryConfirmed });
  const historyIndexes = historyIndexesForInputIds(session, inputIds);
  if (turn.historyIncorporation) turn.historyIncorporation.historyIndexes = historyIndexes;
  turn.historyIndex = historyIndexes.find((index): index is number => index != null) ?? turn.historyIndex;
  if (turn.turnTarget) {
    for (const historyIndex of historyIndexes) {
      if (historyIndex != null) deps.trackUserMessageForTurn(session, historyIndex, turn.turnTarget);
    }
  }
  return committed.length > 0;
}

export function removePendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "broadcastPendingCodexInputs" | "persistSession">,
): PendingCodexInput | null {
  const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const [removed] = session.pendingCodexInputs.splice(idx, 1);
  if (removed) restoreQueuedNeedsInputResolutionNotices(session, removed.id);
  if (removed && session.lastMessagePreviewAt === removed.timestamp) restoreSessionMessagePreview(session);
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
  return removed;
}

function sameOrderedIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function historyIndexesForInputIds(
  session: CodexRecoveryOrchestratorSessionLike,
  inputIds: string[],
): Array<number | null> {
  const absoluteById = new Map<string, number>();
  const frozenCount = session._frozenCount ?? 0;
  session.messageHistory.forEach((message, index) => {
    if (message.type === "user_message" && message.id) absoluteById.set(message.id, frozenCount + index);
  });
  return inputIds.map((id) => absoluteById.get(id) ?? null);
}

function commitPendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  deps: CodexRecoveryOrchestratorDeps,
  deliveryConfirmed = true,
): number | null {
  const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const pending = session.pendingCodexInputs[idx];
  session.pendingCodexInputs.splice(idx, 1);
  if (deliveryConfirmed) markCodexAutoPauseRecoveryDelivered(session, pending.autoPauseRecoveries, Date.now(), deps);
  if (
    pending.needsInputReminderText &&
    shouldCommitNeedsInputReminderHistoryEntry(pending.needsInputReminderText, session.notifications)
  ) {
    const reminderHistoryEntry = buildNeedsInputReminderHistoryEntry(
      pending.needsInputReminderText,
      pending.timestamp,
      pending.id,
    );
    session.messageHistory.push(reminderHistoryEntry);
    deps.broadcastToBrowsers(session, reminderHistoryEntry);
  }
  commitQueuedNeedsInputResolutionNoticeHistoryEntry(session, pending, deps);
  const takodeHerdEvents = getTakodeHerdEventBrowserMetadata(pending.takodeHerdBatch);
  const modelDeliveryContent =
    isCodexTurnRecoverySourceId(pending.agentSource?.sessionId) &&
    pending.requireFreshSuccessor === true &&
    typeof pending.deliveryContent === "string"
      ? pending.deliveryContent
      : undefined;
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: pending.content,
    ...(modelDeliveryContent !== undefined ? { modelDeliveryContent } : {}),
    timestamp: pending.timestamp,
    id: pending.id,
    ...(pending.imageRefs?.length ? { images: pending.imageRefs } : {}),
    ...(pending.replyContext ? { replyContext: pending.replyContext } : {}),
    ...(pending.clientMsgId ? { client_msg_id: pending.clientMsgId } : {}),
    ...(pending.vscodeSelection ? { vscodeSelection: pending.vscodeSelection } : {}),
    ...(pending.agentSource ? { agentSource: pending.agentSource } : {}),
    ...(pending.threadKey ? { threadKey: pending.threadKey } : {}),
    ...(pending.questId ? { questId: pending.questId } : {}),
    ...(pending.threadRefs ? { threadRefs: pending.threadRefs } : {}),
    ...(pending.takodeHerdBatch?.eventKeys?.length ? { takodeHerdEventKeys: pending.takodeHerdBatch.eventKeys } : {}),
    ...(takodeHerdEvents?.length ? { takodeHerdEvents } : {}),
    ...(pending.recentAskBoundaryBefore ? { recentAskBoundaryBefore: pending.recentAskBoundaryBefore } : {}),
    ...(pending.leaderResponseCoverageVersion
      ? { leaderResponseCoverageVersion: pending.leaderResponseCoverageVersion }
      : {}),
    ...(pending.leaderUserMessageId ? { leaderUserMessageId: pending.leaderUserMessageId } : {}),
    ...(pending.leaderTimerMessageId ? { leaderTimerMessageId: pending.leaderTimerMessageId } : {}),
  };
  session.messageHistory.push(userHistoryEntry);
  if (clearLeaderThreadStatusForCoveredUserMessage(session, userHistoryEntry)) {
    deps.invalidateLeaderThreadTabsForSession?.(session.id);
  }
  const userMsgHistoryIdx = session.messageHistory.length - 1;
  session.lastUserMessage = formatReplyContentForPreview(pending.content || "", pending.replyContext).slice(0, 80);
  session.lastMessagePreviewAt = pending.timestamp;
  if (isActualHumanUserMessage(userHistoryEntry)) deps.touchUserMessage(session.id, pending.timestamp);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  appendPendingInputHistoryFollowUps(session, pending, userHistoryEntry, deps);
  if (userHistoryEntry.leaderResponseCoverageVersion === 1 || userHistoryEntry.leaderTimerMessageId) {
    deps.refreshBrowserConversationViews?.(session);
  }
  deps.broadcastPendingCodexInputs(session);
  deps.onUserMessage?.(session.id, [...session.messageHistory], session.state.cwd, session.isGenerating);
  deps.persistSession(session);
  return userMsgHistoryIdx;
}

function appendPendingInputHistoryFollowUps(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: PendingCodexInput,
  baseEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  if (!pending.historyFollowUps?.length) return;
  pending.historyFollowUps.forEach((followUp, index) => {
    const entry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: followUp.content,
      timestamp: pending.timestamp,
      id: `${pending.id}-followup-${index}`,
      ...(followUp.agentSource ? { agentSource: followUp.agentSource } : {}),
      ...((followUp.threadKey ?? baseEntry.threadKey) ? { threadKey: followUp.threadKey ?? baseEntry.threadKey } : {}),
      ...((followUp.questId ?? baseEntry.questId) ? { questId: followUp.questId ?? baseEntry.questId } : {}),
      ...(followUp.threadRefs?.length ? { threadRefs: followUp.threadRefs } : {}),
    };
    session.messageHistory.push(entry);
    deps.broadcastToBrowsers(session, entry);
  });
}
