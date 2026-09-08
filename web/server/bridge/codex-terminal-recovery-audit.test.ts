import { describe, expect, it, vi } from "vitest";
import type { CodexOutboundTurn, CodexTurnRecoveryState } from "../session-types.js";
import {
  archiveUnrelatedTerminalCodexRecovery,
  beginCodexTurnRecoveryContinuation,
  isCodexTurnRecoveryContinuationInjectionPending,
  markCodexTurnRecoveryContinuationActive,
  markCodexTurnRecoveryOnDisconnect,
  resolveCodexTurnRecoveryAction,
  settleCodexTurnRecoveryFromResult,
  type CodexInterruptedTurnRecoverySessionLike,
} from "./codex-interrupted-turn-recovery.js";
import { advanceCodexTerminalHistoryReconciliation } from "./codex-terminal-history-reconciliation.js";
import {
  reconcileCodexResumedTurn,
  retryPendingCodexTurn,
  trySteerPendingCodexInputs,
} from "./codex-recovery-orchestrator.js";
import { completeRecoveredCodexTurnWithDiagnostic } from "./codex-recovered-turn-diagnostic.js";

function recovery(): CodexTurnRecoveryState {
  return {
    recoveryId: "old-owner",
    originalOwnerId: "old-owner",
    originalHistoryIndex: 0,
    originalProviderTurnId: "shared-provider-turn",
    continuationOwnerId: "old-continuation",
    threadKey: "main",
    status: "action_required",
    reason: "continuation_interrupted",
    historyPresence: "present",
    continuationMode: "verify_then_continue",
    attempt: 1,
    maxAttempts: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

function pending(owner = "new-owner"): CodexOutboundTurn {
  return {
    adapterMsg: { type: "codex_start_pending", pendingInputIds: [owner], inputs: [{ content: "retained input" }] },
    userMessageId: owner,
    pendingInputIds: [owner],
    userContent: "retained input",
    historyIndex: 1,
    status: "recovery_pending",
    dispatchCount: 1,
    createdAt: 3,
    updatedAt: 4,
    acknowledgedAt: 4,
    turnTarget: "current",
    turnId: "shared-provider-turn",
    lastError: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
    terminalHistoryReconciliation: {
      presence: "present",
      reason: "receipt",
      action: "continue",
      continuationMode: "verify_then_continue",
      classifiedAt: 4,
    },
  };
}

function session(): CodexInterruptedTurnRecoverySessionLike {
  return {
    id: "audit-session",
    state: { isOrchestrator: true, backend_state: "connected", codex_turn_recovery: recovery() },
    pendingCodexInputs: [],
    pendingCodexTurns: [],
    codexTerminalRecoveries: [],
    messageHistory: [
      { type: "user_message", id: "old-owner", content: "old work", timestamp: 1, threadKey: "main" },
      {
        type: "user_message",
        id: "new-owner",
        content: "new work",
        timestamp: 3,
        threadKey: "q-9000",
        questId: "q-9000",
      },
    ],
  };
}

function dependencies() {
  return {
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    injectUserMessage: vi.fn(() => "queued" as const),
    rebuildQueuedCodexPendingStartBatch: vi.fn(),
    dispatchQueuedCodexTurns: vi.fn(),
  };
}

describe("terminal Codex recovery audit", () => {
  it.each([
    "old-owner",
    "old-continuation",
    "source-only",
  ])("excludes terminal input-only %s from steering without losing independent input", (identity) => {
    // Late routing and restored input can exist before a turn is constructed.
    // Shared provider identity never makes the independent input terminal.
    const s = session() as any;
    const deps = {
      ...dependencies(),
      broadcastPendingCodexInputs: vi.fn(),
      isCodexWorkerV2DeliveryFrozen: () => false,
      pruneStalePendingCodexHerdInputs: vi.fn(),
    };
    archiveUnrelatedTerminalCodexRecovery(s, "new-owner", deps);
    s.codexAdapter = {
      getCurrentTurnId: () => "shared-provider-turn",
      isConnected: () => true,
      sendBrowserMessage: vi.fn(() => true),
    };
    s.pendingCodexInputs = [
      {
        id: identity,
        content: "terminal payload",
        timestamp: 6,
        cancelable: true,
        ...(identity === "source-only" ? { agentSource: { sessionId: "system:codex-turn-recovery:old-owner" } } : {}),
      },
      { id: "independent", content: "new input", timestamp: 7, cancelable: true },
    ];
    expect(trySteerPendingCodexInputs(s, "test", deps as any)).toBe(true);
    expect(s.codexAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_steer_pending",
        pendingInputIds: ["independent"],
        inputs: [{ content: "new input" }],
      }),
    );
    expect(s.codexTerminalRecoveries).toEqual([recovery()]);
  });

  it("keeps an incomplete owner pending when another active recovery prevents continuation acceptance", () => {
    const s = session();
    s.state.codex_turn_recovery = { ...recovery(), status: "continuation_pending" };
    const owner = pending();
    owner.status = "backend_acknowledged";
    owner.terminalHistoryReconciliation = undefined;
    s.pendingCodexTurns = [owner];
    const deps = { ...dependencies(), completeCodexTurn: vi.fn() };
    completeRecoveredCodexTurnWithDiagnostic(s as any, owner, "test_recovery", "incomplete", deps as any, {
      leaderContinuationRoute: { threadKey: "q-9000" },
      recoveryOwner: owner,
    });
    expect(s.pendingCodexTurns).toEqual([owner]);
    expect(owner).toMatchObject({ status: "recovery_pending", terminalHistoryReconciliation: { action: "continue" } });
    expect(deps.completeCodexTurn).not.toHaveBeenCalled();
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("preserves the old outcome while serializing two new owners across delayed continuation acceptance", () => {
    // Mirrors the retained incident: an unrelated terminal record predates
    // two recovery owners. Queued delivery is not yet accepted model work.
    const s = session();
    const first = pending();
    const second = pending("later-owner");
    s.pendingCodexTurns = [first, second];
    const deps = dependencies();
    expect(advanceCodexTerminalHistoryReconciliation(s as any, deps as any)).toBe(true);
    expect(s.codexTerminalRecoveries).toEqual([recovery()]);
    expect(s.pendingCodexTurns).toEqual([second]);
    expect(s.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: "new-owner",
      status: "continuation_pending",
      continuationOwnerId: null,
    });
    expect(isCodexTurnRecoveryContinuationInjectionPending(s)).toBe(true);
    expect(advanceCodexTerminalHistoryReconciliation(s as any, deps as any)).toBe(true);
    expect(s.pendingCodexTurns).toEqual([second]);
    expect(deps.injectUserMessage).toHaveBeenCalledTimes(1);
    const [, , source, , options] = (deps.injectUserMessage.mock.calls as any[])[0];
    s.pendingCodexInputs.push({
      id: "accepted-continuation",
      content: "continue",
      timestamp: 5,
      cancelable: true,
      agentSource: source,
    });
    options.afterAccepted();
    expect(s.state.codex_turn_recovery?.continuationOwnerId).toBe("accepted-continuation");
    expect(s.codexTerminalRecoveries).toEqual([recovery()]);
  });

  it("does not archive an active recovery to allow another owner to overtake it", () => {
    const s = session();
    s.state.codex_turn_recovery = { ...recovery(), status: "continuation_pending" };
    const deps = dependencies();
    expect(beginCodexTurnRecoveryContinuation(s, pending(), { threadKey: "q-9000" }, deps)).toBe(false);
    expect(s.codexTerminalRecoveries).toEqual([]);
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it.each([
    "old-owner",
    "old-continuation",
  ])("does not resurrect archived %s through resume, retry, or disconnect", (owner) => {
    const s = session();
    const deps = dependencies();
    archiveUnrelatedTerminalCodexRecovery(s, "new-owner", deps);
    const old = pending(owner);
    old.status = "backend_acknowledged";
    old.terminalHistoryReconciliation = undefined;
    const later = pending();
    s.pendingCodexTurns = [old, later];
    // Even full absence evidence cannot override a recorded terminal outcome.
    reconcileCodexResumedTurn(
      s as any,
      { threadStatus: "idle", turns: [], lastTurn: null } as any,
      {
        ...deps,
        getCodexTurnInRecovery: () => old,
      } as any,
    );
    expect(s.pendingCodexTurns).toEqual([later]);
    retryPendingCodexTurn(s as any, old, deps as any);
    markCodexTurnRecoveryOnDisconnect(s, old, deps);
    expect(s.state.codex_turn_recovery).toBeNull();
    expect(s.codexTerminalRecoveries).toEqual([recovery()]);
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("resolves an archived recovery only by its exact ID without clearing the active owner", () => {
    const s = session();
    const deps = { ...dependencies(), queueCodexPendingStartBatch: vi.fn() };
    archiveUnrelatedTerminalCodexRecovery(s, "new-owner", deps);
    const active = {
      ...recovery(),
      recoveryId: "new-owner",
      originalOwnerId: "new-owner",
      continuationOwnerId: "new-continuation",
      status: "continuation_active" as const,
    };
    s.state.codex_turn_recovery = active;
    s.pendingCodexTurns = [pending("old-continuation"), pending("new-owner")];
    expect(resolveCodexTurnRecoveryAction(s, "wrong-id", deps)).toBe(false);
    expect(resolveCodexTurnRecoveryAction(s, "old-owner", deps)).toBe(true);
    expect(s.codexTerminalRecoveries).toEqual([]);
    expect(s.state.codex_turn_recovery).toBe(active);
    expect(s.pendingCodexTurns.map((turn) => turn.userMessageId)).toEqual(["new-owner"]);
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledOnce();
  });

  it("does not let a late continuation-active callback revive terminal recovery", () => {
    const s = session();
    const before = structuredClone(s.state.codex_turn_recovery);
    markCodexTurnRecoveryContinuationActive(s, pending("old-continuation"), dependencies());
    expect(s.state.codex_turn_recovery).toEqual(before);
  });

  it.each([
    "main",
    "q-9000",
  ])("settles archived work only after a new successful human follow-up on its thread (%s)", (threadKey) => {
    const s = session();
    const deps = dependencies();
    archiveUnrelatedTerminalCodexRecovery(s, "new-owner", deps);
    s.messageHistory.push({
      type: "user_message",
      id: "follow-up",
      content: "checked the outcome",
      timestamp: 6,
      threadKey,
    });
    const followup = { ...pending("follow-up"), historyIndex: 2 };
    settleCodexTurnRecoveryFromResult(
      s,
      [followup],
      { is_error: false, subtype: "success", stop_reason: "completed" } as any,
      deps,
    );
    expect(s.codexTerminalRecoveries).toEqual(threadKey === "main" ? [] : [recovery()]);
  });
});
