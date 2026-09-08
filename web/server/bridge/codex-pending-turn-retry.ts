import type { CodexOutboundTurn } from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import { retireTerminalCodexRecoveryOwner } from "./codex-interrupted-turn-recovery.js";
import { reconcileRecoveredQueuedTurnLifecycle } from "./codex-queued-turn-lifecycle.js";
import type {
  CodexRecoveryOrchestratorDeps,
  CodexRecoveryOrchestratorSessionLike,
} from "./codex-recovery-orchestrator.js";

export function retryPendingCodexTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
  deps: CodexRecoveryOrchestratorDeps,
  options: { diagnoseDispatchFailure?: boolean } = {},
): void {
  if (retireTerminalCodexRecoveryOwner(session, pending, deps)) return;
  const releasedHeadQueuedTurn = pending.turnTarget === "queued";
  const preserveRecoveryTestingOwnership =
    pending.turnTarget === "current" &&
    pending.autoPauseRecoveryTestingRetired !== true &&
    pending.autoPauseSourceKind === "manual" &&
    !!session.state.codex_result_error_auto_pause?.pausedAt;
  const restartRunningGuard = session.isGenerating && pending.turnTarget !== "queued";
  if (restartRunningGuard) {
    deps.setGenerating(session, false, "codex_retry_pending_turn_restart");
  }
  pending.status =
    session.state.backend_state === "broken" || session.state.backend_state === "recovery_suppressed"
      ? "blocked_broken_session"
      : "queued";
  pending.updatedAt = Date.now();
  pending.acknowledgedAt = null;
  pending.lastError = null;
  pending.turnTarget = preserveRecoveryTestingOwnership ? "current" : null;
  pending.turnId = null;
  pending.disconnectedAt = null;
  pending.resumeConfirmedAt = null;
  reconcileRecoveredQueuedTurnLifecycle(session, "codex_retry_pending_turn", deps, { releasedHeadQueuedTurn });
  deps.dispatchQueuedCodexTurns(session, "codex_retry_pending_turn");
  const pendingAfterDispatch: CodexOutboundTurn = pending;
  const retryIssue = options.diagnoseDispatchFailure ? getCodexRetryDispatchIssue(session, pendingAfterDispatch) : null;
  if (retryIssue) {
    const message = `Codex resumed an interrupted user-only turn, but automatic retry was not dispatched: ${retryIssue}.`;
    pendingAfterDispatch.lastError = message;
    console.warn(`[ws-bridge] ${message} session=${sessionTag(session.id)}`);
    deps.broadcastToBrowsers(session, { type: "error", message });
    deps.persistSession(session);
    return;
  }
  if (pendingAfterDispatch.status === "dispatched" && !session.isGenerating) {
    const target = deps.markRunningFromUserDispatch(session, "codex_retry_pending_turn");
    pendingAfterDispatch.turnTarget = target;
    if (pendingAfterDispatch.historyIndex >= 0) {
      deps.trackUserMessageForTurn(session, pendingAfterDispatch.historyIndex, target);
    }
  }
  deps.persistSession(session);
}

function getCodexRetryDispatchIssue(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
): string | null {
  if (pending.status === "dispatched" || pending.status === "backend_acknowledged") return null;
  if (pending.status === "blocked_broken_session") return "session is in a non-retryable broken state";
  if (!session.codexAdapter) return "adapter not connected";
  if (session.state.backend_state !== "connected")
    return `backend state is ${session.state.backend_state ?? "unknown"}`;
  if (!session.codexAdapter.isConnected()) return "adapter not connected";
  return `retry remained ${pending.status}`;
}
