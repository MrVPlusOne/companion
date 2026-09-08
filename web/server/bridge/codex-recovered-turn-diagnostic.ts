import type {
  BrowserIncomingMessage,
  CodexOutboundTurn,
  CodexTurnRecoveryContinuationMode,
  CodexTurnRecoveryReason,
} from "../session-types.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import { appendCodexLeaderRecoveryDiagnostic } from "./codex-leader-recovery-diagnostic.js";
import {
  beginCodexTurnRecoveryContinuation,
  archiveUnrelatedTerminalCodexRecovery,
  isCodexTurnRecoveryContinuationInjectionPending,
  markCodexTurnRecoveryActionRequired,
  type CodexInterruptedTurnRecoveryDeps,
  type CodexInterruptedTurnRecoverySessionLike,
} from "./codex-interrupted-turn-recovery.js";
import {
  rearmRecoveredQueuedHeadTurn,
  reconcileRecoveredQueuedTurnLifecycle,
  type RecoveredQueuedTurnSessionLike,
} from "./codex-queued-turn-lifecycle.js";
import {
  logCodexRecoveryDiagnostic,
  type CodexRecoveryDiagnosticLogContext,
  type CodexRecoveryDiagnosticOutcome,
  type CodexRecoveryDiagnosticPresentation,
} from "./codex-recovery-diagnostic-log.js";
import { stageCodexTerminalHistoryReconciliation } from "./codex-history-incorporation.js";

export type CodexRecoveredTurnDiagnosticSessionLike = Omit<CodexInterruptedTurnRecoverySessionLike, "isGenerating"> &
  RecoveredQueuedTurnSessionLike;

export interface CodexRecoveredTurnDiagnosticDeps<
  Session extends CodexRecoveredTurnDiagnosticSessionLike = CodexRecoveredTurnDiagnosticSessionLike,
> extends Pick<
    CodexInterruptedTurnRecoveryDeps,
    "broadcastToBrowsers" | "persistSession" | "injectUserMessage" | "setAttentionError"
  > {
  completeCodexTurn: (session: Session, turn: CodexOutboundTurn | null) => boolean;
  markTurnInterrupted: (session: Session, source: "user" | "leader" | "system") => void;
  setGenerating: (session: Session, generating: boolean, reason: string) => void;
  getCodexHeadTurn: (session: Session) => CodexOutboundTurn | null;
  dispatchQueuedCodexTurns: (session: Session, reason: string) => void;
  maybeFlushQueuedCodexMessages: (session: Session, reason: string) => void;
  markRunningFromUserDispatch: (session: Session, reason: string) => UserDispatchTurnTarget;
  promoteNextQueuedTurn: (session: Session) => boolean;
  trackUserMessageForTurn: (session: Session, historyIndex: number, target: UserDispatchTurnTarget) => void;
}

export interface CompleteRecoveredCodexTurnOptions {
  leaderDiagnosticRoute?: ThreadRouteMetadata | null;
  leaderContinuationRoute?: ThreadRouteMetadata | null;
  recoveryOwner?: CodexOutboundTurn;
  turnRecoveryActionRequired?: CodexTurnRecoveryReason;
  continuationMode?: CodexTurnRecoveryContinuationMode;
  interruptSource?: "user" | "leader" | "system";
  diagnosticLog?: CodexRecoveryDiagnosticLogContext;
}

function diagnosticPresentation(
  session: CodexRecoveredTurnDiagnosticSessionLike,
  outcome: CodexRecoveryDiagnosticOutcome,
): CodexRecoveryDiagnosticPresentation {
  if (outcome.continuationQueued) return "continuation_queued";
  if (session.state.codex_turn_recovery?.status === "action_required") return "action_required";
  return outcome.diagnosticAppended ? "routed_fallback" : "browser_error";
}

export function completeRecoveredCodexTurnWithDiagnostic<Session extends CodexRecoveredTurnDiagnosticSessionLike>(
  session: Session,
  pending: CodexOutboundTurn,
  reason: string,
  message: string,
  deps: CodexRecoveredTurnDiagnosticDeps<Session>,
  options: CompleteRecoveredCodexTurnOptions = {},
): CodexRecoveryDiagnosticOutcome {
  const owner = options.recoveryOwner ?? pending;
  if (options.leaderContinuationRoute) {
    archiveUnrelatedTerminalCodexRecovery(session, owner.userMessageId, deps);
    const current = session.state.codex_turn_recovery;
    if (
      current &&
      current.originalOwnerId !== owner.userMessageId &&
      current.continuationOwnerId !== owner.userMessageId
    ) {
      // Preserve this owner until the already active continuation has settled.
      // Retiring it first would leave only a diagnostic if injection was refused.
      stageCodexTerminalHistoryReconciliation(owner, {
        presence: owner.historyIncorporation?.recordedAt != null ? "present" : "unknown",
        reason: "waiting_for_active_recovery",
        action: "continue",
        continuationMode: options.continuationMode ?? "verify_then_continue",
        classifiedAt: Date.now(),
      });
      deps.persistSession(session);
      return { continuationQueued: false, diagnosticAppended: false, browserErrorBroadcast: false };
    }
  }
  deps.completeCodexTurn(session, options.recoveryOwner ?? pending);
  if (options.interruptSource) deps.markTurnInterrupted(session, options.interruptSource);
  const generationReason = options.leaderContinuationRoute ? "codex_interrupted_turn_continuation" : reason;
  deps.setGenerating(session, false, generationReason);

  let continuationQueued = false;
  if (options.turnRecoveryActionRequired) {
    markCodexTurnRecoveryActionRequired(session, options.turnRecoveryActionRequired, deps);
  } else if (options.leaderContinuationRoute) {
    continuationQueued = beginCodexTurnRecoveryContinuation(
      session,
      options.recoveryOwner ?? pending,
      options.leaderContinuationRoute,
      deps,
      options.continuationMode,
    );
  }

  const successor = deps.getCodexHeadTurn(session);
  if (successor && !isCodexTurnRecoveryContinuationInjectionPending(session)) {
    rearmRecoveredQueuedHeadTurn(session, successor, `${reason}_successor`, deps);
  }
  reconcileRecoveredQueuedTurnLifecycle(session, reason, deps);

  let diagnosticRecorded = false;
  if (!continuationQueued && options.leaderDiagnosticRoute) {
    const diagnosticOwner = options.recoveryOwner ?? pending;
    const currentRecovery = session.state.codex_turn_recovery ?? null;
    const currentOwnsDiagnostic =
      currentRecovery != null &&
      (diagnosticOwner.userMessageId === currentRecovery.originalOwnerId ||
        diagnosticOwner.userMessageId === currentRecovery.continuationOwnerId);
    const recoveryId = currentOwnsDiagnostic ? currentRecovery.recoveryId : diagnosticOwner.userMessageId;
    const appendResult = appendCodexLeaderRecoveryDiagnostic(session, recoveryId, options.leaderDiagnosticRoute, deps);
    diagnosticRecorded = appendResult === "appended" || appendResult === "existing_unresolved";
  }
  const diagnosticAppended = diagnosticRecorded;
  if (!continuationQueued) deps.dispatchQueuedCodexTurns(session, reason);
  reconcileRecoveredQueuedTurnLifecycle(session, `${reason}_dispatched`, deps);
  deps.maybeFlushQueuedCodexMessages(session, reason);

  const browserErrorBroadcast = !continuationQueued && !diagnosticAppended;
  if (browserErrorBroadcast) deps.broadcastToBrowsers(session, { type: "error", message } as BrowserIncomingMessage);
  const outcome = { continuationQueued, diagnosticAppended, browserErrorBroadcast };
  if (options.diagnosticLog) {
    logCodexRecoveryDiagnostic({
      ...options.diagnosticLog,
      ...outcome,
      presentation: diagnosticPresentation(session, outcome),
    });
  }
  deps.persistSession(session);
  return outcome;
}
