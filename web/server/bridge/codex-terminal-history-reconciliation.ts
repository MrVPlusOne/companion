import {
  beginCodexHistoryAbsentReplay,
  stageCodexTerminalHistoryReconciliation,
} from "./codex-history-incorporation.js";
import { finalizeCodexBatchBrowserHistory } from "./codex-pending-input-history.js";
import { recordCodexHistoryMilestoneProof } from "./codex-recovery-diagnostics.js";
import { blocksAutomaticCodexResumeTurnRecovery } from "./codex-provider-result-recovery.js";
import { removeCompletedCodexTurns } from "./codex-turn-queue.js";
import type { CodexResumeSnapshot } from "../codex-adapter.js";
import {
  beginCodexTurnRecoveryContinuation,
  archiveUnrelatedTerminalCodexRecovery,
  retireTerminalCodexRecoveryOwner,
  clearCodexTurnRecoveryForOwner,
  markCodexTurnRecoveryActionRequired,
  markCodexTurnRecoveryHistoryPresence,
  markCodexTurnRecoveryOwnerActionRequired,
  resolveCodexTurnRecoveryRoute,
} from "./codex-interrupted-turn-recovery.js";
import type {
  CodexRecoveryOrchestratorDeps,
  CodexRecoveryOrchestratorSessionLike,
} from "./codex-recovery-orchestrator.js";

export function reconcileUnknownCodexTurnBeforeDispatch(
  session: CodexRecoveryOrchestratorSessionLike,
  turn: CodexRecoveryOrchestratorSessionLike["pendingCodexTurns"][number] | null,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  if (!turn || turn.historyTrackingUnknown !== true) return false;
  if (turn.status !== "recovery_pending" || !turn.terminalHistoryReconciliation) {
    finalizeCodexBatchBrowserHistory(session, turn, deps, false);
    stageCodexTerminalHistoryReconciliation(turn, {
      presence: "unknown",
      reason: "queued_history_tracking_unknown",
      action: "continue",
      continuationMode: "verify_then_continue",
      classifiedAt: Date.now(),
    });
    recordCodexHistoryMilestoneProof(session, turn, "classified", {
      historyPresence: "unknown",
      classification: "queued_history_tracking_unknown",
      continuationMode: "verify_then_continue",
    });
  }
  return advanceCodexTerminalHistoryReconciliation(session, deps);
}

export function reconcileRestoredUnknownCodexTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  turn: CodexRecoveryOrchestratorSessionLike["pendingCodexTurns"][number] | null,
  snapshot: CodexResumeSnapshot,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  if (!turn || turn.historyTrackingUnknown !== true) return false;
  const matchingTurn = turn.turnId
    ? (snapshot.turns.find((candidate) => candidate.id === turn.turnId) ?? null)
    : (snapshot.lastTurn ?? null);
  if (matchingTurn && blocksAutomaticCodexResumeTurnRecovery(matchingTurn)) {
    finalizeCodexBatchBrowserHistory(session, turn, deps, false);
    stageCodexTerminalHistoryReconciliation(turn, {
      presence: "unknown",
      reason: "terminal_resume_snapshot_error",
      action: "action_required",
      continuationMode: null,
      classifiedAt: Date.now(),
    });
    recordCodexHistoryMilestoneProof(session, turn, "automatic_recovery_blocked", {
      historyPresence: "unknown",
      classification: "terminal_resume_snapshot_error",
    });
    advanceCodexTerminalHistoryReconciliation(session, deps);
    return true;
  }
  if (
    matchingTurn?.status === "inProgress" &&
    typeof snapshot.threadStatus === "string" &&
    snapshot.threadStatus !== "idle"
  ) {
    turn.status = "backend_acknowledged";
    turn.turnId = matchingTurn.id;
    turn.resumeConfirmedAt = Date.now();
    turn.updatedAt = turn.resumeConfirmedAt;
    deps.persistSession(session);
    return true;
  }
  finalizeCodexBatchBrowserHistory(session, turn, deps, false);
  stageCodexTerminalHistoryReconciliation(turn, {
    presence: "unknown",
    reason: "restored_history_tracking_unknown",
    action: "continue",
    continuationMode: "verify_then_continue",
    classifiedAt: Date.now(),
  });
  recordCodexHistoryMilestoneProof(session, turn, "classified", {
    historyPresence: "unknown",
    classification: "restored_history_tracking_unknown",
    continuationMode: "verify_then_continue",
  });
  advanceCodexTerminalHistoryReconciliation(session, deps);
  return true;
}

export function advanceCodexTerminalHistoryReconciliation(
  session: CodexRecoveryOrchestratorSessionLike,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  while (true) {
    const head = session.pendingCodexTurns[0] ?? null;
    const plan = head?.terminalHistoryReconciliation;
    if (!head || head.status !== "recovery_pending" || !plan) return false;

    if (retireTerminalCodexRecoveryOwner(session, head, deps)) continue;
    archiveUnrelatedTerminalCodexRecovery(session, head.userMessageId, deps);
    const current = session.state.codex_turn_recovery ?? null;
    if (current && (current.status !== "recovering" || current.originalOwnerId !== head.userMessageId)) return true;

    head.terminalHistoryReconciliation = undefined;
    head.historyTrackingUnknown = undefined;
    if (plan.action === "complete") {
      recordCodexHistoryMilestoneProof(session, head, "completed_from_history", {
        historyPresence: plan.presence,
        classification: plan.reason,
      });
      clearCodexTurnRecoveryForOwner(session, head.userMessageId, deps);
      deps.completeCodexTurn(session, head);
      continue;
    }

    if (plan.action === "action_required") {
      recordCodexHistoryMilestoneProof(session, head, "automatic_recovery_blocked", {
        historyPresence: plan.presence,
        classification: plan.reason,
      });
      markCodexTurnRecoveryOwnerActionRequired(session, head, "recovery_failed", deps);
      if (removeCompletedCodexTurns(session)) deps.persistSession(session);
      return true;
    }

    if (plan.action === "replay") {
      if (!beginCodexHistoryAbsentReplay(head)) {
        markCodexTurnRecoveryActionRequired(session, "recovery_failed", deps);
        return true;
      }
      markCodexTurnRecoveryHistoryPresence(session, head, "absent", deps);
      head.status = "queued";
      head.turnId = null;
      head.acknowledgedAt = null;
      head.disconnectedAt = null;
      head.resumeConfirmedAt = null;
      head.turnTarget = null;
      head.lastError = null;
      head.updatedAt = Date.now();
      recordCodexHistoryMilestoneProof(session, head, "replay_queued", {
        historyPresence: plan.presence,
        classification: plan.reason,
      });
      deps.dispatchQueuedCodexTurns(session, "codex_history_absent_replay");
      deps.persistSession(session);
      return true;
    }

    const route = resolveCodexTurnRecoveryRoute(session, head);
    head.status = "completed";
    head.updatedAt = Date.now();
    removeCompletedCodexTurns(session);
    recordCodexHistoryMilestoneProof(session, head, "continuation_selected", {
      historyPresence: plan.presence,
      classification: plan.reason,
      continuationMode: plan.continuationMode,
    });
    const queued = beginCodexTurnRecoveryContinuation(
      session,
      head,
      route,
      deps,
      plan.continuationMode ?? "verify_then_continue",
    );
    if (!queued && session.state.codex_turn_recovery?.status !== "action_required") {
      markCodexTurnRecoveryActionRequired(session, "continuation_dispatch_failed", deps);
    }
    deps.persistSession(session);
    return true;
  }
}
