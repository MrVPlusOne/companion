import { retryPendingCodexTurn } from "./codex-pending-turn-retry.js";
export { retryPendingCodexTurn } from "./codex-pending-turn-retry.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot } from "../codex-adapter.js";
import type { TurnStartFailureInfo, TurnSteerFailureInfo } from "./adapter-interface.js";
import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  ActiveTurnRoute,
  BrowserOutgoingMessage,
  CodexModelSwitchCompactionGuard,
  CodexOutboundTurn,
  CodexTurnRecoveryReason,
  PendingCodexInput,
  SessionNotification,
  SessionState,
} from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import { getTakodeHerdEventBrowserMetadata } from "../herd-event-browser-metadata.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import {
  buildNeedsInputReminderHistoryEntry,
  commitQueuedNeedsInputResolutionNoticeHistoryEntry,
  restoreQueuedNeedsInputResolutionNotices,
  shouldCommitNeedsInputReminderHistoryEntry,
} from "./adapter-browser-routing-needs-input-reminder.js";
import { isRecoverableCodexInitError } from "../codex-adapter-utils.js";
import {
  isActualHumanUserInput,
  isActualHumanUserMessage,
  restoreSessionMessagePreview,
} from "../user-message-classification.js";
import {
  determineCodexTurnSourceKind,
  getCodexAutoPauseRecoveryProgress,
  holdCodexAutoPausedQueuedBacklog,
  isCodexAutoPauseRecoveryTesting,
} from "../codex-result-error-auto-pause.js";
import {
  broadcastCodexAutoPauseRecoveryTesting,
  retireCodexAutoPauseRecoveryTesting,
} from "./codex-auto-pause-recovery-testing.js";
import {
  armCodexFreshTurnRequirement as armCodexFreshTurnRequirementState,
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementState,
  completeCodexTurnsForResult as completeCodexTurnsForResultState,
  dispatchQueuedCodexTurns as dispatchQueuedCodexTurnsState,
} from "./codex-turn-queue.js";
import { requestCodexAutoRecovery as requestCodexAutoRecoveryController } from "./session-registry-controller.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import { isSessionPaused } from "../session-pause.js";
import { recoverAgentMessagesFromResumedTurn } from "./codex-recovered-assistant-routing.js";
import { consumeCodexIntentionalRelaunch } from "./codex-intentional-relaunch.js";
import { buildCodexRecoveryDiagnosticLogContext } from "./codex-recovery-diagnostic-log.js";
import { completeRecoveredCodexTurnWithDiagnostic } from "./codex-recovered-turn-diagnostic.js";
import { handleTerminalTurnStartFailure } from "./codex-terminal-turn-start-failure.js";
import { reconcileRecoverableCodexTurnStartFailure } from "./codex-turn-start-history-failure.js";
import {
  blocksAutomaticCodexTerminalHistoryContinuation,
  codexInitRecoveryRetryDelayMs,
  decideCodexProviderResultRecovery,
} from "./codex-provider-result-recovery.js";
import {
  canContinueCodexOutageRecovery,
  clearCodexRecoveryRuntimeState,
  continueCodexOutageRecoveryAfterFailure,
  getCodexRecoveryRuntimeReason,
  handleExhaustedCodexAdapterDisconnect,
  invalidateCodexRecoveryAttempt,
  isCodexPersistentOutageRecoveryReason,
  resolveCodexAutoRecoveryReason,
  stopIneligibleCodexOutageRecovery,
} from "../codex-process-reconnect.js";
import {
  collectCodexAutoPauseRecoveryLinks,
  markCodexAutoPauseRecoveryDelivered,
} from "./codex-auto-pause-recovery-summary.js";
import {
  recordCodexHistoryMilestoneProof,
  recordCodexReplaySuppressedProof,
  recordCodexResumeSnapshotProof,
  recordCodexTurnResultProof,
  recordCodexTurnStartedProof,
  recordCodexTurnSteerFailedProof,
  recordCodexTurnSteeredProof,
  summarizeCodexResumeSnapshot,
  summarizePendingCodexInputs,
  summarizePendingCodexTurns,
} from "./codex-recovery-diagnostics.js";
import {
  extractUserTextFromResumedTurn,
  hasIncompleteRecoveredMessagesWithoutTerminalEvidence,
  hasInterruptedAssistantRecoveryWithoutTerminalEvidence,
  hasOnlyRetrySafeCodexResumedItems,
  mergeCodexDeliveryActivity,
  normalizeResumedUserText,
  summarizeCodexResumeDeliveryActivity,
  summarizeLocalCodexDeliveryActivity,
  type CodexLocalDeliveryActivitySummary,
} from "./codex-delivery-ownership.js";
import { clearOrphanedCodexProviderRetryState } from "./codex-provider-retry-state.js";
import {
  clearRecoveredCodexGenerationIfIdle,
  rearmRecoveredQueuedHeadTurn,
  reconcileRecoveredQueuedTurnLifecycle,
} from "./codex-queued-turn-lifecycle.js";
import { runCodexSessionMetaBarrier } from "./codex-session-meta-barrier.js";
import { registerCodexNativeSubagentLifecycle } from "./codex-native-subagent-lifecycle.js";
import { recordCodexAcceptedDispatchActivity } from "./codex-model-switch-dispatch-activity.js";
import { retireProvenInactiveCodexTurnAfterSteerFailure } from "./codex-steer-failure-recovery.js";
import { recoverNonDrainableCodexHeadTurn } from "./codex-nondrainable-turn-recovery.js";
import {
  absoluteHistoryEnd,
  createCodexHistoryIncorporation,
  createCodexHistoryIncorporationForClient,
  markCodexHistoryRecorded,
  prepareCodexHistoryTrackingForDispatch,
  markCodexHistoryRpcAccepted,
  mergeCodexHistoryIncorporation,
  stageCodexTerminalHistoryReconciliation,
} from "./codex-history-incorporation.js";
import { reconcileEvidenceAwareCodexResume } from "./codex-evidence-aware-resume.js";
import {
  advanceCodexTerminalHistoryReconciliation,
  reconcileRestoredUnknownCodexTurn,
  reconcileUnknownCodexTurnBeforeDispatch,
} from "./codex-terminal-history-reconciliation.js";
import {
  buildCodexBatchMessageInputs,
  buildCodexPendingBatchRecoveryText,
  findQueuedCodexPendingStartBatchTurn,
  getQueuedCodexPendingBatchInputs,
} from "./codex-pending-start-batch.js";
import {
  refreshDispatchableCodexStartTurn,
  refreshPendingCodexThreadOutcomeReminders,
} from "./codex-outcome-reminder-delivery.js";
import {
  addPendingCodexInput,
  commitPendingCodexInputs,
  finalizeCodexBatchBrowserHistory,
  getCancelablePendingCodexInputs,
  getPendingCodexInputsByIds,
  recordCodexHistoryIncorporationReceipt,
  recordCodexHistoryReceiptObservation,
  recordSteeredCodexTurn,
  recordSubmittedCodexSteerTurn,
  reconcileSubmittedCodexSteerFailure,
  removePendingCodexInput,
  setPendingCodexInputCancelable,
  setPendingCodexInputsCancelable,
} from "./codex-pending-input-history.js";
import {
  clearCodexTurnRecoveryForOwner,
  beginCodexTurnRecoveryContinuation,
  hasFinalCodexOutcomeEvidence,
  hasIncompleteCodexActivityWithoutTerminalEvidence,
  isCodexLeaderRecycleRecoveryInjectionPending,
  isCodexTurnRecoveryContinuationInjectionPending,
  isRecoveryContinuationTurn,
  markCodexTurnRecoveryActionRequired,
  markCodexTurnRecoveryContinuationActive,
  markCodexTurnRecoveryOnDisconnect,
  retireTerminalCodexRecoveryOwner,
  retireTerminalCodexRecoveryOwners,
  archiveUnrelatedTerminalCodexRecovery,
  resolveCodexTurnRecoveryRoute,
  selectCodexTurnRecoveryOwner,
  settleCodexTurnRecoveryFromResult,
  type CodexTurnRecoveryDeliveryStatus,
} from "./codex-interrupted-turn-recovery.js";
export { extractUserTextFromResumedTurn, normalizeResumedUserText };
export { advanceCodexTerminalHistoryReconciliation };
export {
  addPendingCodexInput,
  commitPendingCodexInputs,
  getCancelablePendingCodexInputs,
  getPendingCodexInputsByIds,
  recordSteeredCodexTurn,
  recordCodexHistoryReceiptObservation,
  removePendingCodexInput,
  setPendingCodexInputCancelable,
  setPendingCodexInputsCancelable,
};
export {
  clearCodexIntentionalRelaunch,
  markCodexIntentionalRelaunch,
} from "./codex-intentional-relaunch.js";
export { maybeFlushQueuedCodexMessages } from "./codex-queued-message-flush.js";
type InterruptSource = "user" | "leader" | "system";
type CodexRecoveryAdapterLike = any;
export interface CodexRecoveryOrchestratorSessionLike {
  id: string;
  backendType: "codex" | "claude" | "claude-sdk";
  state: Pick<
    SessionState,
    | "backend_state"
    | "backend_reconnect"
    | "backend_type"
    | "cwd"
    | "model"
    | "is_compacting"
    | "isOrchestrator"
    | "codex_result_error_auto_pause"
    | "codex_provider_retry"
    | "codex_turn_recovery"
    | "leaderThreadStatuses"
  >;
  messageHistory: BrowserIncomingMessage[];
  _frozenCount?: number;
  notifications?: SessionNotification[];
  pendingMessages: string[];
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  codexLeaderRecycleContinuation?: import("../session-types.js").CodexLeaderRecycleContinuation | null;
  codexFreshTurnRequiredUntilTurnId: string | null;
  codexModelSwitchCompactionGuard?: CodexModelSwitchCompactionGuard | null;
  codexPendingDeliveryProofSignals?: import("../session-types.js").CodexPendingDeliveryProofSignal[];
  isGenerating: boolean;
  cliInitReceived: boolean;
  consecutiveAdapterFailures: number;
  lastAdapterFailureAt: number | null;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: Array<InterruptSource | null>;
  queuedTurnActiveRoutes?: Array<ActiveTurnRoute | null>;
  lastUserMessage?: string;
  lastMessagePreviewAt?: number;
  codexAdapter: {
    getCurrentTurnId(): string | null;
    isConnected(): boolean;
    sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
    disconnect(): Promise<void>;
  } | null;
}
export interface CodexRecoveryOrchestratorDeps {
  codexAssistantReplayScanLimit: number;
  formatVsCodeSelectionPrompt: (selection: NonNullable<PendingCodexInput["vscodeSelection"]>) => string;
  broadcastPendingCodexInputs: (session: CodexRecoveryOrchestratorSessionLike) => void;
  broadcastToBrowsers: (session: CodexRecoveryOrchestratorSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
  refreshBrowserConversationViews?: (session: CodexRecoveryOrchestratorSessionLike) => void;
  invalidateLeaderThreadTabsForSession?: (sessionId: string) => boolean;
  touchUserMessage: (sessionId: string, timestamp?: number) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  injectCompactionRecovery: (session: CodexRecoveryOrchestratorSessionLike) => void;
  onUserMessage?: (
    sessionId: string,
    history: CodexRecoveryOrchestratorSessionLike["messageHistory"],
    cwd: string,
    wasGenerating: boolean,
  ) => void;
  enqueueCodexTurn: (session: CodexRecoveryOrchestratorSessionLike, turn: CodexOutboundTurn) => CodexOutboundTurn;
  getCodexHeadTurn: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  getCodexTurnInRecovery: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  completeCodexTurn: (session: CodexRecoveryOrchestratorSessionLike, turn: CodexOutboundTurn | null) => boolean;
  completeCodexTurnsForResult: (
    session: CodexRecoveryOrchestratorSessionLike,
    msg: CLIResultMessage,
    updatedAt?: number,
    interrupted?: boolean,
  ) => boolean;
  armCodexFreshTurnRequirement: (session: CodexRecoveryOrchestratorSessionLike, turnId: string, reason: string) => void;
  clearCodexFreshTurnRequirement: (
    session: CodexRecoveryOrchestratorSessionLike,
    reason: string,
    options?: { completedTurnId?: string | null },
  ) => void;
  dispatchQueuedCodexTurns: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  maybeFlushQueuedCodexMessages: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  pruneStalePendingCodexHerdInputs: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => boolean;
  synthesizeCodexToolResultsFromResumedTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ) => { count: number; omittedFromResumeSnapshotCount: number };
  handleRecoveredCodexAutoPauseSuccess: (
    session: CodexRecoveryOrchestratorSessionLike,
    completedTurn: CodexOutboundTurn,
  ) => Promise<void> | void;
  trackUserMessageForTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    historyIndex: number,
    target: UserDispatchTurnTarget,
  ) => void;
  markTurnInterrupted: (session: CodexRecoveryOrchestratorSessionLike, source: "user" | "leader" | "system") => void;
  setGenerating: (session: CodexRecoveryOrchestratorSessionLike, generating: boolean, reason: string) => void;
  markRunningFromUserDispatch: (
    session: CodexRecoveryOrchestratorSessionLike,
    reason: string,
    queuedInterruptSource?: InterruptSource | null,
  ) => UserDispatchTurnTarget;
  promoteNextQueuedTurn: (session: CodexRecoveryOrchestratorSessionLike) => boolean;
  isCodexWorkerV2DeliveryFrozen: (sessionId: string) => boolean;
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
  setAttentionError?: (session: CodexRecoveryOrchestratorSessionLike) => void;
}

export interface CodexAdapterRecoveryLifecycleDeps extends CodexRecoveryOrchestratorDeps {
  clearOptimisticRunningTimer?: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  clearCodexDisconnectGraceTimer: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  setCliSessionIdFromMeta: (
    sessionId: string,
    cliSessionId: string,
    instructionSnapshot?: import("../codex-adapter-types.js").CodexInstructionSnapshot,
  ) => void;
  beforeSessionMetaDispatch: (sessionId: string, cliSessionId: string) => boolean | Promise<boolean>;
  completeCodexLeaderRecycle: (sessionId: string) => void;
  hydrateCodexResumedHistory: (session: CodexRecoveryOrchestratorSessionLike, snapshot: unknown) => number;
  setBackendState: (session: CodexRecoveryOrchestratorSessionLike, state: string, error: string | null) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: CodexRecoveryOrchestratorSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  finalizeCodexRollback: (session: CodexRecoveryOrchestratorSessionLike) => void;
  flushQueuedMessagesToCodexAdapter: (
    session: CodexRecoveryOrchestratorSessionLike,
    adapter: CodexRecoveryAdapterLike,
    reason: string,
  ) => void;
  getCancelablePendingCodexInputs: (session: CodexRecoveryOrchestratorSessionLike) => PendingCodexInput[];
  getCodexTurnAwaitingAck: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  getPendingCodexInputsByIds: (
    session: CodexRecoveryOrchestratorSessionLike,
    inputIds: string[],
  ) => PendingCodexInput[];
  queueCodexPendingStartBatch: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  recordSteeredCodexTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    turnId: string,
    steeredInputs: PendingCodexInput[],
    clientUserMessageId: string,
  ) => void;
  setPendingCodexInputsCancelable: (
    session: CodexRecoveryOrchestratorSessionLike,
    inputIds: string[],
    cancelable: boolean,
  ) => void;
  rebuildQueuedCodexPendingStartBatch: (session: CodexRecoveryOrchestratorSessionLike) => void;
  setAttentionError: (session: CodexRecoveryOrchestratorSessionLike) => void;
  setGenerating: (session: CodexRecoveryOrchestratorSessionLike, generating: boolean, reason: string) => void;
  scheduleCodexToolResultWatchdogs: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  requestCodexAutoRecovery: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => boolean;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  isCurrentSession: (sessionId: string, session: CodexRecoveryOrchestratorSessionLike) => boolean;
  getLauncherSessionInfo: (sessionId: string) => any;
  logCodexProcessSnapshot: (sessionId: string, reason: string) => void;
  codexDisconnectGraceMs: number;
  adapterFailureResetWindowMs: number;
  maxAdapterRelaunchFailures: number;
  hasCliRelaunchCallback: boolean;
}

export interface CodexAttachLifecycleDeps
  extends Pick<CodexRecoveryOrchestratorDeps, "persistSession" | "broadcastToBrowsers"> {
  clearCodexDisconnectGraceTimer: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  setBackendState: (session: CodexRecoveryOrchestratorSessionLike, state: string, error: string | null) => void;
  persistHistoryOwnershipRepair: (
    session: CodexRecoveryOrchestratorSessionLike,
    expectedFrozenCount: number,
  ) => Promise<void>;
  getLauncherSessionInfo: (sessionId: string) => any;
  onOrchestratorTurnEnd?: (sessionId: string) => void;
  handleCodexAdapterBrowserMessage: (session: CodexRecoveryOrchestratorSessionLike, msg: unknown) => Promise<void>;
  registerRecoveryLifecycle: (
    sessionId: string,
    session: CodexRecoveryOrchestratorSessionLike,
    adapter: CodexRecoveryAdapterLike,
  ) => void;
}

function broadcastCodexAutoPauseRecoveryStatus(
  session: CodexRecoveryOrchestratorSessionLike,
  deps: Pick<CodexRecoveryOrchestratorDeps, "broadcastToBrowsers">,
  status: "running" | "idle" | null,
): void {
  deps.broadcastToBrowsers(session, {
    type: "status_change",
    status,
    codexAutoPauseRecoveryProgress: getCodexAutoPauseRecoveryProgress(session),
  });
}

export function requestCodexAutoRecovery(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: {
    requestCliRelaunch?: (sessionId: string) => void;
    persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
    emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
    attached?: (session: CodexRecoveryOrchestratorSessionLike) => boolean;
    getLauncherSessionInfo?: (sessionId: string) => any;
    broadcastSessionUpdate?: (session: CodexRecoveryOrchestratorSessionLike, update: Record<string, unknown>) => void;
    recoveryTimeoutMs?: number;
  },
): boolean {
  return requestCodexAutoRecoveryController(session, reason, deps);
}

export function attachCodexAdapterLifecycle(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  deps: CodexAttachLifecycleDeps,
): void {
  session.backendType = "codex" as any;
  session.state.backend_type = "codex" as any;
  deps.clearCodexDisconnectGraceTimer(session, "adapter_attach");
  if (session.codexAdapter && session.codexAdapter !== adapter) {
    session.codexAdapter.disconnect().catch(() => {});
  }
  session.codexAdapter = adapter;
  registerCodexNativeSubagentLifecycle(session as any, adapter, {
    persistSession: (targetSession) => deps.persistSession(targetSession as any),
    persistHistoryOwnershipRepair: (targetSession, expectedFrozenCount) =>
      deps.persistHistoryOwnershipRepair(targetSession as any, expectedFrozenCount),
    broadcastToBrowsers: (targetSession, message) => deps.broadcastToBrowsers(targetSession as any, message),
    handleOwnedBrowserMessage: (targetSession, message) =>
      deps.handleCodexAdapterBrowserMessage(targetSession as any, message),
  });
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  const backendState =
    launcherInfo?.cliSessionId || session.pendingCodexTurns.length > 0 || (session as any).pendingMessages.length > 0
      ? "resuming"
      : "initializing";
  deps.setBackendState(session, backendState, null);
  deps.persistSession(session);

  session.cliInitReceived = true as any;
  if (launcherInfo?.isOrchestrator) {
    deps.onOrchestratorTurnEnd?.(session.id);
  }

  adapter.onBrowserMessage(async (msg: unknown) => {
    if (session.codexAdapter !== adapter) return;
    await deps.handleCodexAdapterBrowserMessage(session, msg);
  });

  deps.registerRecoveryLifecycle(sessionId, session, adapter);
  console.log(`[ws-bridge] Codex adapter attached for session ${sessionTag(sessionId)}`);
}

export { hydrateCodexResumedHistory } from "./codex-resumed-history-hydration.js";

export function completeCodexTurnsForResult(
  session: CodexRecoveryOrchestratorSessionLike,
  msg: CLIResultMessage,
  deps: CodexRecoveryOrchestratorDeps,
  updatedAt = Date.now(),
  interrupted = false,
): boolean {
  const resultTurnId = typeof msg.codex_turn_id === "string" ? msg.codex_turn_id : null;
  const completedTurns = resultTurnId
    ? session.pendingCodexTurns.filter((turn) => turn.turnId === resultTurnId)
    : [deps.getCodexHeadTurn(session)].filter((turn): turn is CodexOutboundTurn => turn !== null);
  const providerRecovery = decideCodexProviderResultRecovery(session, msg, completedTurns[0] ?? null);
  const blockAutomaticContinuation =
    interrupted ||
    providerRecovery.kind === "terminal_model_not_supported" ||
    providerRecovery.kind === "exhausted" ||
    blocksAutomaticCodexTerminalHistoryContinuation(msg);
  const outcome = completeCodexTurnsForResultState(session, msg, updatedAt);
  if (providerRecovery.kind === "recover" && !providerRecovery.retryTurn) {
    const recordedRecoveryTurns = completedTurns.filter(
      (turn) =>
        turn.status === "completed" &&
        turn.historyIncorporation?.recordedAt != null &&
        !isRecoveryContinuationTurn(session, turn),
    );
    for (const turn of [...recordedRecoveryTurns].reverse()) {
      stageCodexTerminalHistoryReconciliation(turn, {
        presence: "present",
        reason: "recoverable_provider_result_after_recorded_activity",
        action: "continue",
        continuationMode: "verify_then_continue",
        classifiedAt: updatedAt,
      });
      if (!session.pendingCodexTurns.includes(turn)) session.pendingCodexTurns.unshift(turn);
      recordCodexHistoryMilestoneProof(session, turn, "continuation_selected", {
        historyPresence: "present",
        classification: "recoverable_provider_result_after_recorded_activity",
        continuationMode: "verify_then_continue",
      });
    }
  }
  const actuallyCompletedTurns = completedTurns.filter((turn) => turn.status === "completed");
  const unresolvedTrackedTurns = completedTurns.filter(
    (turn) =>
      turn.status !== "completed" &&
      (turn.terminalHistoryReconciliation != null ||
        turn.historyTrackingUnknown === true ||
        (turn.historyIncorporation != null && turn.historyIncorporation.recordedAt == null)),
  );
  for (const turn of unresolvedTrackedTurns) {
    finalizeCodexBatchBrowserHistory(session, turn, deps, false);
    if (isRecoveryContinuationTurn(session, turn)) {
      recordCodexHistoryMilestoneProof(session, turn, "automatic_recovery_blocked", {
        historyPresence: "unknown",
        classification: "terminal_recovery_continuation_without_history_receipt",
      });
      deps.completeCodexTurn(session, turn);
      markCodexTurnRecoveryActionRequired(
        session,
        interrupted ? "continuation_interrupted" : "continuation_failed",
        deps,
      );
      continue;
    }
    const existingTerminalPlan = turn.terminalHistoryReconciliation;
    if (existingTerminalPlan?.action === "action_required" || (existingTerminalPlan && !blockAutomaticContinuation)) {
      continue;
    }
    stageCodexTerminalHistoryReconciliation(turn, {
      presence: "unknown",
      reason: "terminal_result_without_history_receipt",
      action: blockAutomaticContinuation ? "action_required" : "continue",
      continuationMode: blockAutomaticContinuation ? null : "verify_then_continue",
      classifiedAt: updatedAt,
    });
    recordCodexHistoryMilestoneProof(session, turn, "classified", {
      historyPresence: "unknown",
      classification: "terminal_result_without_history_receipt",
      continuationMode: blockAutomaticContinuation ? null : "verify_then_continue",
    });
  }
  if (blockAutomaticContinuation && unresolvedTrackedTurns.length > 0) {
    advanceCodexTerminalHistoryReconciliation(session, deps);
  }
  if (outcome.codexTurnId) {
    if (outcome.matched) {
      recordCodexTurnResultProof(session, outcome.codexTurnId);
      reconcileRecoveredQueuedTurnLifecycle(session, "codex_result_turn_id_completed", deps);
      if (actuallyCompletedTurns.length > 0) {
        settleCodexTurnRecoveryFromResult(session, actuallyCompletedTurns, msg, deps, interrupted);
      }
      return true;
    }
    console.warn(
      `[ws-bridge] Ignoring Codex result for untracked turn ${outcome.codexTurnId} in session ${sessionTag(session.id)}`,
    );
    return false;
  }
  if (outcome.matched && actuallyCompletedTurns.length > 0) {
    settleCodexTurnRecoveryFromResult(session, actuallyCompletedTurns, msg, deps, interrupted);
  }
  return outcome.matched;
}

export function armCodexFreshTurnRequirement(
  session: CodexRecoveryOrchestratorSessionLike,
  turnId: string,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "persistSession">,
): void {
  if (!armCodexFreshTurnRequirementState(session, turnId)) return;
  console.log(
    `[ws-bridge] Blocking Codex steering until turn ${turnId} ends for session ${sessionTag(session.id)} (${reason})`,
  );
  deps.persistSession(session);
}

export function clearCodexFreshTurnRequirement(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "persistSession">,
  options?: { completedTurnId?: string | null },
): void {
  const { cleared, blockedTurnId } = clearCodexFreshTurnRequirementState(session, options);
  if (!cleared || !blockedTurnId) return;
  console.log(
    `[ws-bridge] Codex fresh-turn requirement cleared for session ${sessionTag(session.id)} (${reason}${options?.completedTurnId ? `: ${options.completedTurnId}` : ""})`,
  );
  deps.persistSession(session);
}

export function markSessionRelaunchPending(session: CodexRecoveryOrchestratorSessionLike): void {
  (session as any).relaunchPending = true;
}

export function dispatchQueuedCodexTurns(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  if (
    isSessionPaused(session as any) ||
    deps.isCodexWorkerV2DeliveryFrozen(session.id) ||
    isCodexTurnRecoveryContinuationInjectionPending(session)
  )
    return;
  retireTerminalCodexRecoveryOwners(session, deps);
  if (advanceCodexTerminalHistoryReconciliation(session, deps)) return;
  let head =
    typeof deps.getCodexHeadTurn === "function"
      ? deps.getCodexHeadTurn(session)
      : (session.pendingCodexTurns[0] ?? null);
  if (reconcileUnknownCodexTurnBeforeDispatch(session, head, deps)) return;
  if (
    head?.adapterMsg.type === "codex_start_pending" &&
    (head.status === "queued" || head.status === "blocked_broken_session")
  ) {
    const inputIds = head.pendingInputIds ?? [head.userMessageId];
    const reminderRefresh = refreshPendingCodexThreadOutcomeReminders(session, deps, { inputIds });
    if (reminderRefresh.changed && !refreshDispatchableCodexStartTurn(session, head, deps)) {
      dispatchQueuedCodexTurns(session, reason, deps);
      return;
    }
    head =
      typeof deps.getCodexHeadTurn === "function"
        ? deps.getCodexHeadTurn(session)
        : (session.pendingCodexTurns[0] ?? null);
  }
  const receiptAware = typeof (session.codexAdapter as any)?.onUserMessageRecorded === "function";
  if (prepareCodexHistoryTrackingForDispatch(head, receiptAware)) deps.persistSession(session);
  holdCodexAutoPausedQueuedBacklog(session as any, deps);
  const outcome = dispatchQueuedCodexTurnsState(session, reason, {
    pruneStalePendingCodexHerdInputs: (dispatchReason) =>
      deps.pruneStalePendingCodexHerdInputs(session, dispatchReason),
    setPendingCodexInputsCancelable: (ids) => setPendingCodexInputsCancelable(session, ids, false, deps),
    persistSession: () => deps.persistSession(session),
  });
  const recoveryTurn =
    session.state.codex_result_error_auto_pause?.pausedAt && outcome.head?.autoPauseSourceKind === "manual"
      ? outcome.head
      : null;
  if (outcome.status === "adapter_rejected" && recoveryTurn?.turnTarget === "current") {
    recoveryTurn.turnTarget = null;
    broadcastCodexAutoPauseRecoveryTesting(session, deps);
    deps.persistSession(session);
  } else if (outcome.status === "dispatched" && isCodexAutoPauseRecoveryTesting(session)) {
    broadcastCodexAutoPauseRecoveryTesting(session, deps);
  }
  if (outcome.status !== "dispatched" || !outcome.head) return;
  recordCodexHistoryMilestoneProof(session, outcome.head, "submitted");
  recordCodexAcceptedDispatchActivity(session, deps.persistSession, "turn", reason, outcome.head.dispatchCount);
}

export { buildCodexBatchMessageInputs, buildCodexPendingBatchRecoveryText } from "./codex-pending-start-batch.js";
export function rebuildQueuedCodexPendingStartBatch(
  session: CodexRecoveryOrchestratorSessionLike,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  retireTerminalCodexRecoveryOwners(session, deps);
  refreshPendingCodexThreadOutcomeReminders(session, deps);
  holdCodexAutoPausedQueuedBacklog(session as any, deps);
  const head = deps.getCodexHeadTurn(session);
  const headBlocksQueuedFollowUps = !!head && head.status === "blocked_broken_session";
  const existingQueuedTurn = findQueuedCodexPendingStartBatchTurn(session.pendingCodexTurns);
  const deliverable = getQueuedCodexPendingBatchInputs(
    session.pendingCodexInputs,
    session.pendingCodexTurns,
    existingQueuedTurn,
  );
  if (headBlocksQueuedFollowUps || deliverable.length === 0) {
    if (!existingQueuedTurn) return;
    const idx = session.pendingCodexTurns.indexOf(existingQueuedTurn);
    if (idx >= 0) {
      session.pendingCodexTurns.splice(idx, 1);
    }
    deps.persistSession(session);
    return;
  }
  if (existingQueuedTurn) {
    const inputIds = deliverable.map((input) => input.id);
    if (
      !existingQueuedTurn.historyIncorporation ||
      existingQueuedTurn.historyIncorporation.inputIds.length !== inputIds.length ||
      existingQueuedTurn.historyIncorporation.inputIds.some((id, index) => id !== inputIds[index])
    ) {
      existingQueuedTurn.historyIncorporation = createCodexHistoryIncorporation(inputIds);
    }
    const clientUserMessageId = existingQueuedTurn.historyIncorporation.clientUserMessageId;
    existingQueuedTurn.adapterMsg = {
      type: "codex_start_pending",
      pendingInputIds: inputIds,
      inputs: buildCodexBatchMessageInputs(deliverable),
      clientUserMessageId,
    };
    existingQueuedTurn.userMessageId = deliverable[0].id;
    existingQueuedTurn.pendingInputIds = inputIds;
    existingQueuedTurn.userContent = buildCodexPendingBatchRecoveryText(deliverable, deps);
    existingQueuedTurn.updatedAt = Date.now();
    existingQueuedTurn.lastError = null;
    existingQueuedTurn.autoPauseSourceKind = determineCodexTurnSourceKind(deliverable);
    existingQueuedTurn.autoPauseRecoveryLinks = collectCodexAutoPauseRecoveryLinks(deliverable);
    existingQueuedTurn.requiresFreshSuccessor = deliverable.some((input) => input.requireFreshSuccessor) || undefined;
    moveQueuedTurnBeforeRequestedOwner(session.pendingCodexTurns, existingQueuedTurn, deliverable);
    deps.persistSession(session);
    return;
  }
  const now = Date.now();
  const inputIds = deliverable.map((input) => input.id);
  const historyIncorporation = createCodexHistoryIncorporation(inputIds);
  const clientUserMessageId = historyIncorporation.clientUserMessageId;
  const queuedTurn: CodexOutboundTurn = {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds: inputIds,
      inputs: buildCodexBatchMessageInputs(deliverable),
      clientUserMessageId,
    },
    userMessageId: deliverable[0].id,
    pendingInputIds: inputIds,
    userContent: buildCodexPendingBatchRecoveryText(deliverable, deps),
    historyIndex: -1,
    status:
      session.state.backend_state === "broken" || session.state.backend_state === "recovery_suppressed"
        ? "blocked_broken_session"
        : "queued",
    dispatchCount: 0,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
    turnTarget: null,
    lastError:
      session.state.backend_state === "broken" || session.state.backend_state === "recovery_suppressed"
        ? "Codex session needs manual Resume before queued messages can run."
        : null,
    turnId: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
    autoPauseSourceKind: determineCodexTurnSourceKind(deliverable),
    autoPauseRecoveryLinks: collectCodexAutoPauseRecoveryLinks(deliverable),
    historyIncorporation,
    requiresFreshSuccessor: deliverable.some((input) => input.requireFreshSuccessor) || undefined,
  };
  const beforeOwnerId = deliverable.find((input) => input.queueBeforeOwnerId)?.queueBeforeOwnerId;
  const beforeTurnIndex = beforeOwnerId
    ? session.pendingCodexTurns.findIndex((turn) =>
        (turn.pendingInputIds ?? [turn.userMessageId]).includes(beforeOwnerId),
      )
    : -1;
  if (beforeTurnIndex >= 0) session.pendingCodexTurns.splice(beforeTurnIndex, 0, queuedTurn);
  else session.pendingCodexTurns.push(queuedTurn);
  deps.persistSession(session);
}

function moveQueuedTurnBeforeRequestedOwner(
  turns: CodexOutboundTurn[],
  queuedTurn: CodexOutboundTurn,
  deliverable: PendingCodexInput[],
): void {
  const beforeOwnerId = deliverable.find((input) => input.queueBeforeOwnerId)?.queueBeforeOwnerId;
  if (!beforeOwnerId) return;
  const currentIndex = turns.indexOf(queuedTurn);
  const beforeIndex = turns.findIndex(
    (turn, index) => index !== currentIndex && (turn.pendingInputIds ?? [turn.userMessageId]).includes(beforeOwnerId),
  );
  if (currentIndex < 0 || beforeIndex < 0 || currentIndex < beforeIndex) return;
  turns.splice(currentIndex, 1);
  turns.splice(beforeIndex, 0, queuedTurn);
}
export function queueCodexPendingStartBatch(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  retryNonDrainableCodexHeadTurn(session, `${reason}_stale_ack_head`, deps);
  clearStaleCodexCompactionState(session, `${reason}_stale_compaction`, deps);
  rebuildQueuedCodexPendingStartBatch(session, deps);
  deps.dispatchQueuedCodexTurns(session, reason);
}

function codexPendingInputGroupKey(turn: CodexOutboundTurn): string {
  const orderedInputs = (turn.pendingInputIds ?? [turn.userMessageId]).join("\u0000");
  const history = turn.historyIncorporation;
  const identity = history
    ? `tracked:${history.batchId}:${history.attempt}:${history.clientUserMessageId}`
    : "untracked";
  return `${orderedInputs}\u0001${identity}`;
}

function codexPendingTurnRecoveryRank(turn: CodexOutboundTurn): number {
  const targetRank = turn.turnTarget === "current" ? 40 : turn.turnTarget === "queued" ? 20 : 0;
  const statusRank =
    turn.status === "backend_acknowledged"
      ? 8
      : turn.status === "dispatched"
        ? 6
        : turn.status === "queued"
          ? 4
          : turn.status === "blocked_broken_session"
            ? 2
            : 0;
  const turnIdRank = turn.turnId ? 1 : 0;
  return targetRank + statusRank + turnIdRank;
}

function mergeCodexPendingTurnRecoveryState(keeper: CodexOutboundTurn, duplicate: CodexOutboundTurn): void {
  keeper.dispatchCount = Math.max(keeper.dispatchCount, duplicate.dispatchCount);
  keeper.createdAt = Math.min(keeper.createdAt, duplicate.createdAt);
  keeper.updatedAt = Math.max(keeper.updatedAt, duplicate.updatedAt);
  keeper.historyIndex = keeper.historyIndex >= 0 ? keeper.historyIndex : duplicate.historyIndex;
  keeper.acknowledgedAt = keeper.acknowledgedAt ?? duplicate.acknowledgedAt;
  keeper.disconnectedAt = keeper.disconnectedAt ?? duplicate.disconnectedAt;
  keeper.autoPauseRecoveryTestingRetired ||= duplicate.autoPauseRecoveryTestingRetired;
  keeper.resumeConfirmedAt = keeper.resumeConfirmedAt ?? duplicate.resumeConfirmedAt;
  keeper.turnId = keeper.turnId ?? duplicate.turnId;
  keeper.lastError = keeper.lastError ?? duplicate.lastError;
  keeper.autoPauseRecoveryLinks = collectCodexAutoPauseRecoveryLinks([
    { autoPauseRecoveries: keeper.autoPauseRecoveryLinks },
    { autoPauseRecoveries: duplicate.autoPauseRecoveryLinks },
  ]);
  keeper.requiresFreshSuccessor ||= duplicate.requiresFreshSuccessor;
  mergeCodexHistoryIncorporation(keeper, duplicate);
}

export function reconcileDuplicateCodexPendingTurns(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "persistSession">,
): number {
  const groups = new Map<string, CodexOutboundTurn[]>();
  for (const turn of session.pendingCodexTurns) {
    if (turn.status === "completed") continue;
    const key = codexPendingInputGroupKey(turn);
    if (!key) continue;
    const group = groups.get(key);
    if (group) {
      group.push(turn);
    } else {
      groups.set(key, [turn]);
    }
  }

  const duplicates = new Set<CodexOutboundTurn>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let keeper = group[0]!;
    for (const candidate of group.slice(1)) {
      if (codexPendingTurnRecoveryRank(candidate) > codexPendingTurnRecoveryRank(keeper)) {
        keeper = candidate;
      }
    }
    for (const duplicate of group) {
      if (duplicate === keeper) continue;
      mergeCodexPendingTurnRecoveryState(keeper, duplicate);
      duplicates.add(duplicate);
    }
  }

  if (duplicates.size === 0) return 0;
  session.pendingCodexTurns = session.pendingCodexTurns.filter((turn) => !duplicates.has(turn));
  console.warn(
    `[ws-bridge] Collapsed ${duplicates.size} duplicate Codex pending turn(s) for session ${sessionTag(session.id)} (${reason})`,
  );
  deps.persistSession(session);
  return duplicates.size;
}

export function pokeStaleCodexPendingDelivery(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
  options: { triggeringInputId?: string } = {},
): boolean {
  const adapter = session.codexAdapter;
  if (session.backendType !== "codex") return false;
  if (deps.isCodexWorkerV2DeliveryFrozen(session.id) || isCodexTurnRecoveryContinuationInjectionPending(session))
    return false;
  if (session.pendingCodexInputs.length === 0) return false;
  if (session.isGenerating) return false;
  if (!adapter || session.state.backend_state !== "connected" || !adapter.isConnected()) return false;
  if (adapter.getCurrentTurnId()) return false;

  const head = deps.getCodexHeadTurn(session);
  if (!isStaleCodexPendingDeliveryHead(head, options.triggeringInputId)) return false;

  const beforeDispatchCount = head.dispatchCount;
  const beforeStatus = head.status;
  if (head.status === "queued") {
    clearStaleCodexCompactionState(session, `${reason}_stale_compaction`, deps);
    deps.dispatchQueuedCodexTurns(session, reason);
    rebuildQueuedCodexPendingStartBatch(session, deps);
  } else {
    queueCodexPendingStartBatch(session, reason, deps);
  }

  const currentHead = deps.getCodexHeadTurn(session);
  const dispatchedStaleHead =
    currentHead === head &&
    head.status === "dispatched" &&
    (beforeStatus !== "dispatched" || head.dispatchCount > beforeDispatchCount);
  if (dispatchedStaleHead && !session.isGenerating) {
    deps.markRunningFromUserDispatch(session, `${reason}_stale_head_dispatched`, null);
  }

  console.warn(
    `[ws-bridge] Poked stale Codex pending delivery for session ${sessionTag(session.id)} ` +
      `(${reason}, head_status=${beforeStatus}, dispatched=${dispatchedStaleHead})`,
  );
  return true;
}

function isStaleCodexPendingDeliveryHead(
  head: CodexOutboundTurn | null,
  triggeringInputId: string | undefined,
): head is CodexOutboundTurn {
  if (!head) return false;
  if (head.adapterMsg.type !== "codex_start_pending") return false;
  const headInputIds = head.pendingInputIds ?? [head.userMessageId];
  if (triggeringInputId && headInputIds.includes(triggeringInputId)) return false;
  return head.status === "queued" || head.status === "backend_acknowledged";
}
export function trySteerPendingCodexInputs(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  if (deps.isCodexWorkerV2DeliveryFrozen(session.id) || isCodexTurnRecoveryContinuationInjectionPending(session))
    return false;
  const adapter = session.codexAdapter;
  const expectedTurnId = adapter?.getCurrentTurnId() ?? null;
  if (!adapter || !expectedTurnId || session.state.backend_state !== "connected" || !adapter.isConnected()) {
    if (!expectedTurnId) {
      deps.clearCodexFreshTurnRequirement(session, `${reason}_no_active_turn`);
    }
    return false;
  }
  if (session.codexFreshTurnRequiredUntilTurnId === expectedTurnId) {
    console.log(
      `[ws-bridge] Skipping Codex steer for session ${sessionTag(session.id)} while turn ${expectedTurnId} still owes a fresh turn (${reason})`,
    );
    return false;
  }
  if (session.codexFreshTurnRequiredUntilTurnId) {
    deps.clearCodexFreshTurnRequirement(session, `${reason}_active_turn_changed`);
  }
  deps.pruneStalePendingCodexHerdInputs(session, `${reason}_before_steer`);
  retireTerminalCodexRecoveryOwners(session, deps);
  refreshPendingCodexThreadOutcomeReminders(session, deps);
  holdCodexAutoPausedQueuedBacklog(session as any, deps);
  const deliverable = getCancelablePendingCodexInputs(session);
  if (deliverable.length === 0) return false;
  const ids = deliverable.map((input) => input.id);
  const clientUserMessageId = createCodexHistoryIncorporation(ids).clientUserMessageId;
  setPendingCodexInputsCancelable(session, ids, false, deps);
  const accepted = adapter.sendBrowserMessage({
    type: "codex_steer_pending",
    pendingInputIds: ids,
    expectedTurnId,
    inputs: buildCodexBatchMessageInputs(deliverable),
    clientUserMessageId,
  });
  if (!accepted) {
    setPendingCodexInputsCancelable(session, ids, true, deps);
    return false;
  }
  const receiptAware = typeof (adapter as any).onUserMessageRecorded === "function";
  const submitted = receiptAware
    ? recordSubmittedCodexSteerTurn(session, expectedTurnId, deliverable, clientUserMessageId, deps)
    : null;
  if (submitted) recordCodexHistoryMilestoneProof(session, submitted, "submitted");
  recordCodexAcceptedDispatchActivity(session, deps.persistSession, "steer", reason, ids.length);
  return true;
}

export function handleCodexAdapterInitError(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  error: string,
  deps: CodexAdapterRecoveryLifecycleDeps,
): "ignored" | "retrying" | "broken" {
  if (session.codexAdapter !== adapter) return "ignored";
  deps.clearCodexDisconnectGraceTimer(session, "init_error");
  console.error(`[ws-bridge] Codex adapter init failed for session ${sessionTag(sessionId)}: ${error}`);
  session.codexAdapter = null;
  const pending = deps.getCodexTurnInRecovery(session);
  const launcherInfo = deps.getLauncherSessionInfo(sessionId);
  const autoRecoveryReason = resolveCodexAutoRecoveryReason(session, getCodexRecoveryRuntimeReason(session), {
    allowPendingFallback: true,
  });
  const recoverableInitError = isRecoverableCodexInitError(error);
  if (
    recoverableInitError &&
    autoRecoveryReason &&
    launcherInfo &&
    stopIneligibleCodexOutageRecovery(session, autoRecoveryReason, deps)
  )
    return "ignored";
  const canRetryTransientInit =
    !!autoRecoveryReason && !!launcherInfo?.cliSessionId && recoverableInitError && deps.hasCliRelaunchCallback;

  if (canRetryTransientInit) {
    invalidateCodexRecoveryAttempt(session);
    const now = Date.now();
    if (
      session.lastAdapterFailureAt !== null &&
      now - session.lastAdapterFailureAt > deps.adapterFailureResetWindowMs
    ) {
      (session as any).codexInitRecoveryFailures = 0;
    }
    const failures = ((session as any).codexInitRecoveryFailures ?? 0) + 1;
    (session as any).codexInitRecoveryFailures = failures;
    session.lastAdapterFailureAt = now;
    session.consecutiveAdapterFailures = failures;
    if (failures < deps.maxAdapterRelaunchFailures) {
      if (pending) {
        pending.status = "queued";
        pending.turnId = null;
        pending.acknowledgedAt = null;
        pending.lastError = error;
        pending.updatedAt = now;
        deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
      }
      deps.rebuildQueuedCodexPendingStartBatch(session);
      deps.setBackendState(session, "recovering", null);
      broadcastCodexAutoPauseRecoveryTesting(session, deps);
      deps.broadcastToBrowsers(session, { type: "backend_disconnected" });
      const delayMs = codexInitRecoveryRetryDelayMs(autoRecoveryReason, failures);
      (session as any).codexInitRetryTimer = setTimeout(() => {
        (session as any).codexInitRetryTimer = null;
        if (session.codexAdapter) return;
        if (
          isCodexPersistentOutageRecoveryReason(autoRecoveryReason) &&
          !canContinueCodexOutageRecovery(session, autoRecoveryReason, deps.getLauncherSessionInfo(sessionId))
        ) {
          clearCodexRecoveryRuntimeState(session);
          session.state.backend_reconnect = null;
          deps.setBackendState(session, "disconnected", null);
          deps.broadcastToBrowsers(session, {
            type: "session_update",
            session: { backend_reconnect: null },
          });
          deps.persistSession(session);
          return;
        }
        deps.requestCodexAutoRecovery(session, `init_error:${autoRecoveryReason}`);
      }, delayMs);
      deps.persistSession(session);
      return "retrying";
    }
    if (pending) {
      pending.status = "queued";
      pending.lastError = error;
      pending.updatedAt = now;
      deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
    }
    deps.rebuildQueuedCodexPendingStartBatch(session);
    if (
      continueCodexOutageRecoveryAfterFailure(session, autoRecoveryReason, deps, {
        resetCycle: true,
      })
    ) {
      broadcastCodexAutoPauseRecoveryTesting(session, deps);
      return "retrying";
    }
    clearCodexRecoveryRuntimeState(session);
    const diagnostic = `Codex automatic recovery is paused after ${failures} failed attempts. Use Reconnect to start a fresh cycle.`;
    markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
    deps.setBackendState(session, "recovery_suppressed", diagnostic);
    deps.setAttentionError(session);
    retireCodexAutoPauseRecoveryTesting(session, deps);
    deps.emitTakodeEvent(session.id, "session_error", { error: diagnostic });
    deps.setGenerating(session, false, "codex_recovery_suppressed");
    deps.broadcastToBrowsers(session, {
      type: "backend_disconnected",
      reason: "recovery_suppressed",
    });
    deps.broadcastToBrowsers(session, { type: "error", message: diagnostic });
    broadcastCodexAutoPauseRecoveryStatus(session, deps, null);
    deps.persistSession(session);
    return "broken";
  }

  clearCodexRecoveryRuntimeState(session);
  if ((session as any).pendingCodexRollback) {
    (session as any).pendingCodexRollbackError = error;
    (session as any).pendingCodexRollbackWaiter?.reject(new Error(error));
    (session as any).pendingCodexRollbackWaiter = null;
  }
  retireCodexAutoPauseRecoveryTesting(session, deps);
  if (pending) {
    pending.status = "blocked_broken_session";
    pending.lastError = error;
    pending.updatedAt = Date.now();
    deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
  }
  markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
  deps.setBackendState(session, "broken", error);
  deps.setAttentionError(session);
  deps.emitTakodeEvent(session.id, "session_error", { error });
  deps.setGenerating(session, false, "codex_init_error");
  deps.broadcastToBrowsers(session, {
    type: "backend_disconnected",
    reason: "broken",
  });
  deps.broadcastToBrowsers(session, { type: "error", message: error });
  broadcastCodexAutoPauseRecoveryStatus(session, deps, null);
  deps.persistSession(session);
  return "broken";
}

export function registerCodexAdapterRecoveryLifecycle(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  deps: CodexAdapterRecoveryLifecycleDeps,
): void {
  const receiptAwareAdapter = typeof adapter.onUserMessageRecorded === "function";
  adapter.onSessionMeta((meta: any) => {
    const continueSessionMetaLifecycle = () => {
      if (session.codexAdapter !== adapter) return;
      deps.clearCodexDisconnectGraceTimer(session, "session_meta");
      const lastDisconnectDiagnostics = (session as any).lastCodexTransportCloseDiagnostics as
        | Record<string, unknown>
        | null
        | undefined;
      if (lastDisconnectDiagnostics) {
        console.log(
          `[ws-bridge] Codex recovery session_meta for session ${sessionTag(session.id)} ` +
            `closeId=${String(lastDisconnectDiagnostics.closeId ?? "unknown")} ` +
            `resume=${JSON.stringify(summarizeCodexResumeSnapshot(meta.resumeSnapshot))}`,
        );
      }
      if (meta.cliSessionId) {
        if (meta.instructionSnapshot) {
          deps.setCliSessionIdFromMeta(session.id, meta.cliSessionId, meta.instructionSnapshot);
        } else {
          deps.setCliSessionIdFromMeta(session.id, meta.cliSessionId);
        }
      }
      (session as any).relaunchPending = false;
      if (session.state.backend_reconnect) {
        session.state.backend_reconnect = null;
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { backend_reconnect: null },
        });
      }
      deps.setBackendState(session, "connected", null);
      const recyclePending = deps.getLauncherSessionInfo(session.id)?.codexLeaderRecyclePending;
      const pendingRollback = (session as any).pendingCodexRollback;
      if (meta.resumeSnapshot) {
        recordCodexResumeSnapshotProof(session, meta.resumeSnapshot);
      }
      if (meta.resumeSnapshot && !pendingRollback) {
        deps.hydrateCodexResumedHistory(session, meta.resumeSnapshot);
        reconcileCodexResumedTurn(session, meta.resumeSnapshot, deps);
      }
      clearCodexRecoveryRuntimeState(session);
      broadcastCodexAutoPauseRecoveryTesting(session, deps);
      reconcileDuplicateCodexPendingTurns(session, "session_meta", deps);
      retryNonDrainableCodexHeadTurn(session, "session_meta_stale_ack_head", deps);
      clearStaleCodexCompactionState(session, "session_meta_stale_compaction", deps);
      clearOrphanedCodexProviderRetryState(session, (state) =>
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { codex_provider_retry: state },
        }),
      );
      if (meta.model) {
        session.state.model = meta.model;
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { model: meta.model },
        });
      }
      if (meta.cwd) session.state.cwd = meta.cwd;
      (session.state as any).backend_type = "codex";
      if (recyclePending) {
        const exactRecoveryPending = isCodexLeaderRecycleRecoveryInjectionPending(session);
        deps.injectCompactionRecovery(session);
        if (!exactRecoveryPending) deps.completeCodexLeaderRecycle(session.id);
      }
      if (pendingRollback) {
        (session as any).pendingCodexRollbackError = null;
        void adapter
          .rollbackTurns(pendingRollback.numTurns)
          .then(() => {
            if (session.codexAdapter !== adapter) return;
            deps.finalizeCodexRollback(session);
          })
          .catch((err: unknown) => {
            if (session.codexAdapter !== adapter) return;
            const message = err instanceof Error ? err.message : String(err);
            (session as any).pendingCodexRollback = null;
            (session as any).pendingCodexRollbackError = message;
            (session as any).pendingCodexRollbackWaiter?.reject(new Error(message));
            (session as any).pendingCodexRollbackWaiter = null;
            console.error(
              `[ws-bridge] Pending Codex rollback failed for session ${sessionTag(session.id)}: ${message}`,
            );
            deps.persistSession(session);
          });
        deps.broadcastToBrowsers(session, { type: "backend_connected" });
        deps.refreshGitInfoThenRecomputeDiff(session, {
          broadcastUpdate: true,
          notifyPoller: true,
        });
        deps.persistSession(session);
        return;
      }
      const steeredPending = trySteerPendingCodexInputs(session, "session_meta", deps);
      if (!steeredPending) {
        const headWasBlockedRecovery = deps.getCodexHeadTurn(session)?.status === "blocked_broken_session";
        deps.dispatchQueuedCodexTurns(session, "session_meta");
        reconcileRecoveredQueuedTurnLifecycle(session, "session_meta_dispatch", deps);
        const currentTurnId = adapter.getCurrentTurnId?.() ?? null;
        const hasPendingLocalInputs = deps.getCancelablePendingCodexInputs(session).length > 0;
        if (!headWasBlockedRecovery && (!session.isGenerating || (!currentTurnId && hasPendingLocalInputs))) {
          deps.queueCodexPendingStartBatch(session, "session_meta");
          reconcileRecoveredQueuedTurnLifecycle(session, "session_meta_pending_batch", deps);
        }
      }
      deps.flushQueuedMessagesToCodexAdapter(session, adapter, "session_meta");
      deps.broadcastToBrowsers(session, { type: "backend_connected" });
      deps.refreshGitInfoThenRecomputeDiff(session, {
        broadcastUpdate: true,
        notifyPoller: true,
      });
      deps.persistSession(session);
    };
    if (!meta.cliSessionId) return continueSessionMetaLifecycle();
    runCodexSessionMetaBarrier(
      () => deps.beforeSessionMetaDispatch(session.id, meta.cliSessionId),
      continueSessionMetaLifecycle,
    );
  });

  adapter.onTurnStarted((turnId: string, source?: "local" | "codex_goal_continuation") => {
    if (session.codexAdapter !== adapter) return;
    recordCodexTurnStartedProof(session, turnId);
    clearOrphanedCodexProviderRetryState(session, (state) =>
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { codex_provider_retry: state },
      }),
    );
    const pending = deps.getCodexTurnAwaitingAck(session);
    if (!pending) {
      if (source === "codex_goal_continuation" && !session.isGenerating) {
        deps.setGenerating(session, true, "codex_goal_continuation");
        broadcastCodexAutoPauseRecoveryStatus(session, deps, "running");
        deps.persistSession(session);
      }
      return;
    }
    pending.turnId = turnId;
    pending.status = "backend_acknowledged";
    pending.acknowledgedAt = Date.now();
    markCodexHistoryRpcAccepted(pending, turnId, pending.acknowledgedAt);
    recordCodexHistoryMilestoneProof(session, pending, "rpc_accepted");
    pending.updatedAt = pending.acknowledgedAt;
    if (pending.requiresFreshSuccessor) {
      armCodexFreshTurnRequirement(session, turnId, "codex_recovery_continuation_successor", deps);
    }
    markCodexTurnRecoveryContinuationActive(session, pending, deps);
    if (pending.turnTarget === "queued" && !session.isGenerating) {
      rearmRecoveredQueuedHeadTurn(session, pending, "codex_turn_started_recovered", deps);
    }
    if (pending.turnTarget === null) {
      const target = session.isGenerating ? "current" : deps.markRunningFromUserDispatch(session, "codex_turn_started");
      pending.turnTarget = target;
    }
    if (!receiptAwareAdapter) {
      finalizeCodexBatchBrowserHistory(session, pending, deps, true);
      pending.historyIncorporation = undefined;
    }
    broadcastCodexAutoPauseRecoveryTesting(session, deps);
    deps.persistSession(session);
    trySteerPendingCodexInputs(session, "codex_turn_started", deps);
  });

  adapter.onTurnSteered((turnId: string, pendingInputIds: string[], clientUserMessageId?: string) => {
    if (session.codexAdapter !== adapter) return;
    recordCodexTurnSteeredProof(session, turnId, pendingInputIds.length);
    const steeredInputs = deps.getPendingCodexInputsByIds(session, pendingInputIds);
    const trackedClientId = clientUserMessageId ?? createCodexHistoryIncorporation(pendingInputIds).clientUserMessageId;
    deps.recordSteeredCodexTurn(session, turnId, steeredInputs, trackedClientId);
    const trackedTurn = session.pendingCodexTurns.find(
      (turn) => turn.turnId === turnId && turn.historyIncorporation?.clientUserMessageId === trackedClientId,
    );
    if (trackedTurn) recordCodexHistoryMilestoneProof(session, trackedTurn, "rpc_accepted");
    if (!receiptAwareAdapter) {
      const recorded = session.pendingCodexTurns.find(
        (turn) => turn.turnId === turnId && turn.historyIncorporation?.clientUserMessageId === trackedClientId,
      );
      if (recorded) {
        finalizeCodexBatchBrowserHistory(session, recorded, deps, true);
        const recordedIds = recorded.pendingInputIds ?? [recorded.userMessageId];
        for (const turn of session.pendingCodexTurns) {
          const candidateIds = turn.pendingInputIds ?? [turn.userMessageId];
          if (
            candidateIds.length === recordedIds.length &&
            candidateIds.every((id, index) => id === recordedIds[index])
          ) {
            turn.historyIncorporation = undefined;
          }
        }
      }
    }
    reconcileDuplicateCodexPendingTurns(session, "codex_turn_steered", deps);
    deps.persistSession(session);
    trySteerPendingCodexInputs(session, "codex_turn_steered", deps);
  });

  adapter.onUserMessageRecorded?.((receipt: { turnId: string; clientUserMessageId: string; observedAt?: number }) => {
    if (session.codexAdapter !== adapter) return;
    recordCodexHistoryIncorporationReceipt(session, receipt, deps);
  });
  adapter.onUserMessageReceiptObserved?.(
    (receipt: { turnId: string; clientUserMessageId: string; observedAt?: number }) => {
      if (session.codexAdapter !== adapter) return;
      recordCodexHistoryReceiptObservation(session, receipt, deps);
    },
  );

  adapter.onTurnSteerFailed(
    (pendingInputIds: string[], failure?: TurnSteerFailureInfo, clientUserMessageId?: string) => {
      if (session.codexAdapter !== adapter) return;
      recordCodexTurnSteerFailedProof(session, adapter.getCurrentTurnId?.() ?? null, pendingInputIds.length);
      const attempt = reconcileSubmittedCodexSteerFailure(session, pendingInputIds, clientUserMessageId, failure, deps);
      if (attempt !== "retained") deps.setPendingCodexInputsCancelable(session, pendingInputIds, true);
      if (attempt === "terminal" && failure?.kind === "other") {
        deps.setBackendState(session, "broken", `Codex could not steer this turn: ${failure.message}`);
        deps.setAttentionError(session);
      }
      const retiredInactiveTurn = retireProvenInactiveCodexTurnAfterSteerFailure(
        session,
        pendingInputIds,
        failure,
        deps,
      );
      reconcileDuplicateCodexPendingTurns(session, "codex_turn_steer_failed", deps);
      retryNonDrainableCodexHeadTurn(session, "codex_turn_steer_failed_stale_ack_head", deps);
      deps.rebuildQueuedCodexPendingStartBatch(session);
      if (adapter.getCurrentTurnId?.()) {
        deps.persistSession(session);
        return;
      }
      if (attempt === "terminal") deps.setGenerating(session, false, "codex_turn_steer_terminal_failure");
      deps.dispatchQueuedCodexTurns(session, "codex_turn_steer_failed");
      if (retiredInactiveTurn && deps.getCodexHeadTurn(session)?.status === "dispatched") {
        deps.promoteNextQueuedTurn(session);
        deps.persistSession(session);
      }
    },
  );

  adapter.onInitError((error: string) => {
    handleCodexAdapterInitError(sessionId, session, adapter, error, deps);
  });

  adapter.onDisconnect(() => {
    if (session.codexAdapter !== adapter) return;
    deps.clearOptimisticRunningTimer?.(session, "codex_disconnect");
    const wasGenerating = session.isGenerating;
    const disconnectedTurnId = adapter.getCurrentTurnId ? adapter.getCurrentTurnId() : null;
    const disconnectDiagnostics = adapter.getLastDisconnectDiagnostics?.() ?? null;
    if (disconnectDiagnostics) {
      (session as any).lastCodexTransportCloseDiagnostics = disconnectDiagnostics;
      console.log(
        `[ws-bridge] Codex adapter disconnect diagnostics for session ${sessionTag(session.id)} ` +
          `closeId=${disconnectDiagnostics.closeId} ` +
          `pendingInputs=${JSON.stringify(summarizePendingCodexInputs(session.pendingCodexInputs))} ` +
          `pendingTurns=${JSON.stringify(summarizePendingCodexTurns(session.pendingCodexTurns))}`,
      );
    }
    const pending = deps.getCodexTurnInRecovery(session);
    if (pending) {
      if (disconnectedTurnId) pending.turnId = disconnectedTurnId;
      pending.disconnectedAt = Date.now();
      pending.resumeConfirmedAt = null;
      pending.updatedAt = pending.disconnectedAt;
    }
    const now = Date.now();
    const intentionalReason = consumeCodexIntentionalRelaunch(session, adapter, now);
    const intentionalRelaunch = intentionalReason !== null;
    if (pending && !intentionalRelaunch) {
      markCodexTurnRecoveryOnDisconnect(session, pending, deps);
    }
    for (const [reqId] of (session as any).pendingPermissions) {
      deps.broadcastToBrowsers(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    (session as any).pendingPermissions.clear();
    (session as any).pendingQuestCommands.clear();
    session.codexAdapter = null;
    deps.setPendingCodexInputsCancelable(
      session,
      session.pendingCodexInputs.map((input: { id: string }) => input.id),
      true,
    );
    deps.rebuildQueuedCodexPendingStartBatch(session);
    deps.setBackendState(session, "disconnected", null);
    if (!intentionalRelaunch) {
      if (
        session.lastAdapterFailureAt !== null &&
        now - session.lastAdapterFailureAt > deps.adapterFailureResetWindowMs
      ) {
        session.consecutiveAdapterFailures = 0;
      }
      session.lastAdapterFailureAt = now;
      session.consecutiveAdapterFailures++;
    }
    const idleKilled = deps.getLauncherSessionInfo(sessionId)?.killedByIdleManager;
    const shouldDeferDisconnectInterruption = wasGenerating && pending !== null && !intentionalRelaunch && !idleKilled;
    if (shouldDeferDisconnectInterruption) {
      deps.clearCodexDisconnectGraceTimer(session, "codex_disconnect_rearm");
      (session as any).codexDisconnectGraceTimer = setTimeout(() => {
        (session as any).codexDisconnectGraceTimer = null;
        if (session.codexAdapter || !session.isGenerating) return;
        if (session.state.backend_state === "recovering") {
          console.log(
            `[ws-bridge] Codex disconnect grace expired for session ${sessionTag(session.id)} ` +
              `while recovery is still in flight; keeping the turn resumable`,
          );
          broadcastCodexAutoPauseRecoveryTesting(session, deps);
          deps.persistSession(session);
          return;
        }
        if (session.state.codex_turn_recovery?.status === "recovering") {
          markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
        }
        retireCodexAutoPauseRecoveryTesting(session, deps);
        deps.markTurnInterrupted(session, "system");
        deps.setGenerating(session, false, "codex_disconnect");
        broadcastCodexAutoPauseRecoveryStatus(session, deps, "idle");
        deps.persistSession(session);
        console.log(
          `[ws-bridge] Codex disconnect grace expired for session ${sessionTag(session.id)} — emitting deferred system interruption`,
        );
      }, deps.codexDisconnectGraceMs);
      console.log(
        `[ws-bridge] Deferring Codex disconnect interruption for session ${sessionTag(session.id)} ` +
          `(${deps.codexDisconnectGraceMs}ms grace, recoverable pending turn)`,
      );
    } else {
      retireCodexAutoPauseRecoveryTesting(session, deps);
      deps.markTurnInterrupted(session, "system");
      deps.setGenerating(session, false, "codex_disconnect");
    }
    broadcastCodexAutoPauseRecoveryStatus(session, deps, null);
    deps.scheduleCodexToolResultWatchdogs(session, "codex_disconnect");
    deps.persistSession(session);
    console.log(
      `[ws-bridge] Codex adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}` +
        `${intentionalReason ? ` (intentional relaunch: ${intentionalReason})` : ""}` +
        `${disconnectDiagnostics?.closeId ? ` closeId=${disconnectDiagnostics.closeId}` : ""}` +
        ` (consecutive failures: ${session.consecutiveAdapterFailures})`,
    );
    deps.logCodexProcessSnapshot(
      sessionId,
      disconnectDiagnostics?.closeId
        ? `adapter_disconnect closeId=${disconnectDiagnostics.closeId}`
        : "adapter_disconnect",
    );
    deps.broadcastToBrowsers(session, {
      type: "backend_disconnected",
      ...(idleKilled ? { reason: "idle_limit" } : {}),
    });
    if (
      wasGenerating &&
      !idleKilled &&
      !intentionalRelaunch &&
      session.state.codex_turn_recovery?.status !== "recovering"
    ) {
      deps.setAttentionError(session);
    }

    if (
      !intentionalRelaunch &&
      !idleKilled &&
      deps.isCurrentSession(sessionId, session) &&
      session.consecutiveAdapterFailures <= deps.maxAdapterRelaunchFailures
    ) {
      const browserQualifier = (session as any).browserSockets?.size > 0 ? "active browser" : "detached session";
      console.log(
        `[ws-bridge] Codex adapter disconnected for ${browserQualifier}; requesting relaunch for session ${sessionTag(sessionId)} (attempt ${session.consecutiveAdapterFailures}/${deps.maxAdapterRelaunchFailures})`,
      );
      deps.requestCodexAutoRecovery(session, "adapter_disconnect");
    } else if (!intentionalRelaunch && idleKilled) {
      deps.emitTakodeEvent(sessionId, "session_disconnected", {
        wasGenerating,
        reason: "idle_limit",
      });
    } else if (!intentionalRelaunch && session.consecutiveAdapterFailures > deps.maxAdapterRelaunchFailures) {
      handleExhaustedCodexAdapterDisconnect(session, wasGenerating, deps.maxAdapterRelaunchFailures, deps);
    } else if (!intentionalRelaunch && !deps.hasCliRelaunchCallback) {
      deps.emitTakodeEvent(sessionId, "session_disconnected", {
        wasGenerating,
        reason: "adapter_disconnect",
      });
    }
  });

  adapter.onTurnStartFailed((msg: any, info?: TurnStartFailureInfo) => {
    if (session.codexAdapter !== adapter) {
      console.warn(`[ws-bridge] Ignoring stale-adapter turn/start failure for session ${sessionTag(sessionId)}`);
      return;
    }
    if (info?.recoverable === false) {
      handleTerminalTurnStartFailure(session, adapter, msg, info, deps);
      return;
    }
    console.log(`[ws-bridge] Turn start failed for session ${sessionTag(sessionId)}, re-queuing ${msg.type}`);
    if (msg.type === "user_message" || msg.type === "codex_start_pending") {
      const pending =
        deps.getCodexTurnAwaitingAck(session) ??
        session.pendingCodexTurns.find(
          (turn: any) =>
            turn.adapterMsg.type === msg.type &&
            JSON.stringify(turn.adapterMsg) === JSON.stringify(msg) &&
            turn.status !== "completed",
        );
      if (pending && reconcileRecoverableCodexTurnStartFailure(session, pending, deps)) return;
      if (pending) {
        pending.status = "queued";
        pending.turnId = null;
        pending.updatedAt = Date.now();
        pending.lastError = "turn/start failed before acknowledgement";
        deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
      }
      deps.dispatchQueuedCodexTurns(session, "turn_start_failed");
    } else {
      const raw = JSON.stringify(msg);
      const alreadyQueued = (session as any).pendingMessages.some((queued: string) => queued === raw);
      if (!alreadyQueued) {
        (session as any).pendingMessages.push(raw);
      }
    }
  });
}
export function reconcileCodexResumedTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  snapshot: CodexResumeSnapshot,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const pending = deps.getCodexTurnInRecovery(session);
  const lastTurn = snapshot.lastTurn;
  if (pending && retireTerminalCodexRecoveryOwner(session, pending, deps)) {
    deps.dispatchQueuedCodexTurns(session, "codex_terminal_recovery_owner_retired");
    return;
  }
  if (!pending) {
    const recovery = session.state.codex_turn_recovery ?? null;
    if (
      recovery &&
      recovery.status !== "action_required" &&
      lastTurn &&
      lastTurn.id === recovery.originalProviderTurnId
    ) {
      if (lastTurn.status === "completed" && lastTurn.error == null && hasFinalCodexOutcomeEvidence(lastTurn)) {
        clearCodexTurnRecoveryForOwner(session, recovery.originalOwnerId, deps);
      } else {
        markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
      }
    }
    if (lastTurn && lastTurn.status !== "completed") {
      console.warn(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} ` +
          `has status=${lastTurn.status} but no pending turn; skipping automatic retry`,
      );
    }
    return;
  }
  if (pending.status === "recovery_pending" && pending.terminalHistoryReconciliation) {
    advanceCodexTerminalHistoryReconciliation(session, deps);
    return;
  }
  if (reconcileRestoredUnknownCodexTurn(session, pending, snapshot, deps)) return;
  if (
    pending.historyIncorporation &&
    (pending.dispatchCount > 0 ||
      pending.historyIncorporation.rpcAcceptedAt != null ||
      pending.historyIncorporation.recordedAt != null) &&
    reconcileEvidenceAwareCodexResume(session, pending, snapshot, deps, {
      retryPendingTurn: (turn, options) => retryPendingCodexTurn(session, turn, deps, options),
      finalizeBatchHistory: (turn, deliveryConfirmed) => {
        finalizeCodexBatchBrowserHistory(session, turn, deps, deliveryConfirmed);
      },
      recordHistoryMilestone: (turn, milestone, details) =>
        recordCodexHistoryMilestoneProof(session, turn, milestone, details),
    })
  ) {
    return;
  }
  if (!lastTurn) {
    if (pending.turnId) {
      if (suppressCodexReplayWhenDeliveryWasObserved(session, pending, "resume_no_last_turn", deps)) return;
      console.log(
        `[ws-bridge] Resumed Codex snapshot for session ${sessionTag(session.id)} has no lastTurn while pending turn ${pending.turnId} is in flight; retrying message`,
      );
      retryPendingCodexTurn(session, pending, deps, {
        diagnoseDispatchFailure: true,
      });
    }
    return;
  }
  const pendingText = normalizeResumedUserText(pending.userContent);
  const resumedUserText = normalizeResumedUserText(extractUserTextFromResumedTurn(lastTurn));
  const matchesTurnId = !!pending.turnId && pending.turnId === lastTurn.id;
  const matchesText = !!pendingText && pendingText === resumedUserText;
  if (!matchesTurnId && !matchesText) {
    if (
      !pending.turnId &&
      lastTurn.status === "inProgress" &&
      snapshot.threadStatus === "idle" &&
      lastTurn.items.length === 0
    ) {
      if (suppressCodexReplayWhenDeliveryWasObserved(session, pending, "resume_lost_turn_identity", deps)) return;
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} ` +
          "lost local turn identity after turn/start; thread is idle and turn has no items, retrying user message",
      );
      retryPendingCodexTurn(session, pending, deps, {
        diagnoseDispatchFailure: true,
      });
      return;
    }
    if (pending.turnId && pending.turnId !== lastTurn.id) {
      if (suppressCodexReplayWhenDeliveryWasObserved(session, pending, "resume_turn_id_mismatch", deps)) return;
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} does not match pending turn ${pending.turnId}; retrying message`,
      );
      retryPendingCodexTurn(session, pending, deps, {
        diagnoseDispatchFailure: true,
      });
      return;
    }
    console.warn(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} ` +
        "does not match pending Codex turn by id or text; skipping automatic retry",
    );
    return;
  }
  if (!pending.turnId && matchesText) pending.turnId = lastTurn.id;
  const recoveryOwner = selectCodexTurnRecoveryOwner(session, pending);
  const completedHistoryIndexes = commitPendingCodexInputs(
    session,
    pending.pendingInputIds ?? [pending.userMessageId],
    deps,
  );
  if (completedHistoryIndexes.length > 0 && pending.historyIndex < 0) {
    pending.historyIndex = completedHistoryIndexes[0];
  }
  const nonUserItems = lastTurn.items.filter((item) => item.type !== "userMessage");
  if (nonUserItems.length === 0) {
    if (suppressCodexReplayWhenDeliveryWasObserved(session, pending, "resume_user_only", deps)) return;
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has only user input and no local model activity; retrying message`,
    );
    retryPendingCodexTurn(session, pending, deps, {
      diagnoseDispatchFailure: true,
    });
    return;
  }
  const localActivity = summarizeLocalCodexDeliveryActivity(session, recoveryOwner);
  const recoveredAgentMessages = recoverAgentMessagesFromResumedTurn(session, lastTurn, recoveryOwner, deps);
  const recoveredAgents = recoveredAgentMessages.count;
  const synthesizedToolResults = deps.synthesizeCodexToolResultsFromResumedTurn(session, lastTurn, pending);
  const synthesizedResults = synthesizedToolResults.count;
  const observedActivity = mergeCodexDeliveryActivity(
    localActivity,
    summarizeCodexResumeDeliveryActivity(nonUserItems),
  );
  const recoveryContinuation = isRecoveryContinuationTurn(session, pending);
  const interruptedActivityWithoutTerminal = hasIncompleteCodexActivityWithoutTerminalEvidence(
    lastTurn,
    snapshot.threadStatus,
    recoveryContinuation ? observedActivity : localActivity,
    synthesizedToolResults.omittedFromResumeSnapshotCount,
    recoveryContinuation,
  );
  if (lastTurn.status === "inProgress" && snapshot.threadStatus === "idle") {
    if (observedActivity.count > 0) {
      suppressCodexReplayForObservedActivity(session, pending, "resume_idle_inprogress", observedActivity, deps);
      return;
    }
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} reports inProgress but thread is idle with no model activity; retrying user message`,
    );
    retryPendingCodexTurn(session, pending, deps);
    return;
  }
  if (lastTurn.status === "inProgress") {
    if (recoveredAgents > 0 || synthesizedResults > 0) {
      session.consecutiveAdapterFailures = 0;
      session.lastAdapterFailureAt = null;
    }
    pending.status = "backend_acknowledged";
    pending.turnId = lastTurn.id;
    pending.resumeConfirmedAt = Date.now();
    pending.updatedAt = pending.resumeConfirmedAt;
    if (pending.turnTarget === "queued" && session.isGenerating) {
      pending.turnTarget = "current";
    }
    if (pending.turnTarget !== "queued" && !session.isGenerating) {
      const target = deps.markRunningFromUserDispatch(session, "codex_resume_in_progress");
      pending.turnTarget = target;
      if (pending.historyIndex >= 0) {
        deps.trackUserMessageForTurn(session, pending.historyIndex, target);
      }
    }
    rearmRecoveredQueuedHeadTurn(session, pending, "codex_resume_in_progress", deps);
    deps.persistSession(session);
    return;
  }
  if (
    (recoveredAgents > 0 &&
      hasIncompleteRecoveredMessagesWithoutTerminalEvidence(
        lastTurn,
        snapshot.threadStatus,
        synthesizedToolResults.omittedFromResumeSnapshotCount,
      )) ||
    interruptedActivityWithoutTerminal
  ) {
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    const isInterruptedAssistantRecovery = hasInterruptedAssistantRecoveryWithoutTerminalEvidence(
      lastTurn,
      snapshot.threadStatus,
      synthesizedToolResults.omittedFromResumeSnapshotCount,
    );
    const leaderRecoveryDiagnosticRoute =
      session.state.isOrchestrator === true
        ? resolveCodexTurnRecoveryRoute(session, recoveryOwner, recoveredAgentMessages.latestLeaderRoute)
        : null;
    const diagnosticLog = buildCodexRecoveryDiagnosticLogContext({
      session,
      owner: recoveryOwner,
      lastTurn,
      threadStatus: snapshot.threadStatus,
      reason: "codex_resume_incomplete_recovered_messages",
      evidenceClass: isInterruptedAssistantRecovery
        ? "interrupted_assistant"
        : recoveredAgents > 0
          ? "assistant_tool_tail"
          : observedActivity.kinds.some((kind) => kind === "tool_use" || kind === "tool_result") ||
              synthesizedResults > 0 ||
              synthesizedToolResults.omittedFromResumeSnapshotCount > 0
            ? "tool_tail"
            : "interrupted_activity",
      recoveredAssistantCount: recoveredAgents,
      synthesizedToolResultCount: synthesizedResults,
      omittedToolResultCount: synthesizedToolResults.omittedFromResumeSnapshotCount,
      activity: observedActivity,
      route: leaderRecoveryDiagnosticRoute,
    });
    completeRecoveredCodexTurnWithDiagnostic(
      session,
      pending,
      "codex_resume_incomplete_recovered_messages",
      "Codex disconnected mid-turn and recovered partial assistant/tool activity, but no final response was recovered. Automatic retry was skipped to avoid duplicate side effects. Send a new instruction if the intended outcome is still missing.",
      deps,
      {
        leaderDiagnosticRoute: leaderRecoveryDiagnosticRoute,
        leaderContinuationRoute: recoveryContinuation ? null : leaderRecoveryDiagnosticRoute,
        recoveryOwner,
        turnRecoveryActionRequired: recoveryContinuation ? "continuation_interrupted" : undefined,
        interruptSource: isInterruptedAssistantRecovery || interruptedActivityWithoutTerminal ? "system" : undefined,
        diagnosticLog,
      },
    );
    return;
  }
  if (recoveredAgents > 0 || synthesizedResults > 0) {
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    const reason = recoveredAgents > 0 ? "codex_resume_recovered_messages" : "codex_resume_synthesized_results";
    if (session.state.isOrchestrator === true && (lastTurn.status !== "completed" || lastTurn.error != null)) {
      const leaderRoute = resolveCodexTurnRecoveryRoute(
        session,
        recoveryOwner,
        recoveredAgentMessages.latestLeaderRoute,
      );
      completeRecoveredCodexTurnWithDiagnostic(
        session,
        pending,
        reason,
        "Codex recovery ended without a successful final turn. Completed work was preserved, but the request still needs continuation or review.",
        deps,
        {
          leaderDiagnosticRoute: leaderRoute,
          leaderContinuationRoute: recoveryContinuation ? null : leaderRoute,
          recoveryOwner,
          turnRecoveryActionRequired: recoveryContinuation
            ? lastTurn.status === "interrupted"
              ? "continuation_interrupted"
              : "continuation_failed"
            : undefined,
          interruptSource: "system",
        },
      );
      return;
    }
    deps.completeCodexTurn(session, pending);
    if (lastTurn.status === "completed" && lastTurn.error == null) {
      clearCodexTurnRecoveryForOwner(session, recoveryOwner.userMessageId, deps);
      const maybeRecovery = deps.handleRecoveredCodexAutoPauseSuccess(session, pending);
      if (maybeRecovery instanceof Promise) {
        void maybeRecovery.catch((error) => {
          console.error(`[ws-bridge] Failed recovered Codex auto-pause handoff for ${sessionTag(session.id)}:`, error);
        });
      }
    }
    clearRecoveredCodexGenerationIfIdle(session, reason, deps);
    reconcileRecoveredQueuedTurnLifecycle(session, reason, deps);
    deps.dispatchQueuedCodexTurns(session, reason);
    reconcileRecoveredQueuedTurnLifecycle(session, `${reason}_dispatched`, deps);
    deps.maybeFlushQueuedCodexMessages(session, reason);
    deps.persistSession(session);
    return;
  }
  if (observedActivity.count > 0) {
    suppressCodexReplayForObservedActivity(session, pending, "resume_model_activity", observedActivity, deps);
    return;
  }
  if (hasOnlyRetrySafeCodexResumedItems(nonUserItems)) {
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} contains only context-compaction metadata; retrying pending user message`,
    );
    retryPendingCodexTurn(session, pending, deps);
    return;
  }
  console.warn(
    `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has non-user items but no recoverable agentMessage text; skipping auto-retry to avoid duplicate side effects`,
  );
  const leaderRoute =
    session.state.isOrchestrator === true ? resolveCodexTurnRecoveryRoute(session, recoveryOwner) : null;
  completeRecoveredCodexTurnWithDiagnostic(
    session,
    pending,
    "codex_resume_non_retryable",
    "Codex disconnected mid-turn and resumed with non-text tool activity. Automatic retry was skipped to avoid duplicate side effects. Send a new instruction if the intended outcome is still missing.",
    deps,
    {
      leaderDiagnosticRoute: leaderRoute,
      recoveryOwner,
      turnRecoveryActionRequired: session.state.codex_turn_recovery ? "recovery_failed" : undefined,
      interruptSource: "system",
    },
  );
}
function suppressCodexReplayWhenDeliveryWasObserved(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
  replayCause: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  const recoveryOwner = selectCodexTurnRecoveryOwner(session, pending);
  const activity = summarizeLocalCodexDeliveryActivity(session, recoveryOwner);
  if (activity.count === 0) return false;
  suppressCodexReplayForObservedActivity(session, pending, replayCause, activity, deps);
  return true;
}

function suppressCodexReplayForObservedActivity(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
  replayCause: string,
  activity: CodexLocalDeliveryActivitySummary,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const recoveryOwner = selectCodexTurnRecoveryOwner(session, pending);
  if (retireTerminalCodexRecoveryOwner(session, recoveryOwner, deps)) return;
  archiveUnrelatedTerminalCodexRecovery(session, recoveryOwner.userMessageId, deps);
  recordCodexReplaySuppressedProof(session, recoveryOwner, replayCause, activity);
  console.warn(
    `[ws-bridge] Suppressed Codex user-delivery replay for session ${sessionTag(session.id)} ` +
      `(owner=${recoveryOwner.userMessageId}, cause=${replayCause}, activity=${activity.kinds.join(",") || "unknown"}, count=${activity.count})`,
  );
  const leaderRoute =
    session.state.isOrchestrator === true ? resolveCodexTurnRecoveryRoute(session, recoveryOwner) : null;
  completeRecoveredCodexTurnWithDiagnostic(
    session,
    pending,
    "codex_resume_replay_suppressed",
    "Codex disconnected after Takode had already observed model activity for this user delivery. The old user payload was not replayed; send a new instruction only if you want to continue the interrupted work.",
    deps,
    {
      leaderDiagnosticRoute: leaderRoute,
      leaderContinuationRoute: session.state.codex_turn_recovery ? null : leaderRoute,
      recoveryOwner,
      turnRecoveryActionRequired: session.state.codex_turn_recovery
        ? isRecoveryContinuationTurn(session, pending)
          ? "continuation_interrupted"
          : "recovery_failed"
        : undefined,
      interruptSource: "system",
    },
  );
}

export function retryNonDrainableCodexHeadTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  return recoverNonDrainableCodexHeadTurn(session, reason, {
    getHead: () => deps.getCodexHeadTurn(session),
    retire: (head) => {
      deps.completeCodexTurn(session, head);
    },
    settleObservedActivity: (head, activity) =>
      suppressCodexReplayForObservedActivity(session, head, "stale_ack_local_activity", activity, deps),
    retry: (head) => retryPendingCodexTurn(session, head, deps),
  });
}
export function clearStaleCodexCompactionState(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  const adapter = session.codexAdapter;
  if (!session.state.is_compacting) return false;
  if (session.isGenerating) return false;
  if (!adapter || session.state.backend_state !== "connected" || !adapter.isConnected()) return false;
  if (adapter.getCurrentTurnId()) return false;

  session.state.is_compacting = false;
  deps.broadcastToBrowsers(session, { type: "status_change", status: null });
  deps.emitTakodeEvent(session.id, "compaction_finished", {});
  const shouldInjectRecovery =
    reason !== "codex_turn_completed_stale_compaction" &&
    session.messageHistory.some((entry) => entry.type === "compact_marker");
  if (shouldInjectRecovery) {
    deps.injectCompactionRecovery(session);
  }
  deps.persistSession(session);
  console.warn(`[ws-bridge] Cleared stale Codex compaction state for session ${sessionTag(session.id)} (${reason})`);
  return true;
}
