import { describe, expect, it, vi } from "vitest";
import type { CodexOutboundTurn, PendingCodexInput } from "../session-types.js";
import { createCodexHistoryIncorporation } from "./codex-history-incorporation.js";
import {
  commitPendingCodexInputs,
  recordCodexHistoryReceiptObservation,
  recordSubmittedCodexSteerTurn,
} from "./codex-pending-input-history.js";
import type {
  CodexRecoveryOrchestratorDeps,
  CodexRecoveryOrchestratorSessionLike,
} from "./codex-recovery-orchestrator.js";

describe("Codex pending-input thread response coverage", () => {
  it.each(["timer-m7", "f7"])("keeps %s through restored queues and repeated receipt handling", (messageId) => {
    // A restored pending timer is the same answer target; it must never mint a new ID or human obligation.
    const input: PendingCodexInput = {
      id: "timer-occurrence",
      content: "[⏰ Timer t3 reminder] Report",
      timestamp: 20,
      cancelable: false,
      agentSource: { sessionId: "timer:t3", sessionLabel: "Timer t3" },
      threadKey: "q-42",
      questId: "q-42",
      leaderTimerMessageId: messageId,
      deliveryContent: `[Timer reminder earlier id:${messageId}] [thread:q-42] [⏰ Timer t3 reminder] Report`,
      timerFiring: { timerId: "t3", scheduledFireAt: 1, messageId },
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
    };
    const session = {
      id: "leader",
      state: { cwd: "/tmp" },
      messageHistory: [],
      pendingCodexInputs: JSON.parse(JSON.stringify([input])),
      notifications: [],
      isGenerating: false,
    } as unknown as CodexRecoveryOrchestratorSessionLike;
    const deps = {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
      refreshBrowserConversationViews: vi.fn(),
    } as unknown as CodexRecoveryOrchestratorDeps;
    commitPendingCodexInputs(session, [input.id], deps);
    commitPendingCodexInputs(session, [input.id], deps);
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({
      id: input.id,
      content: input.content,
      leaderTimerMessageId: messageId,
      threadKey: "q-42",
    });
    expect(session.messageHistory[0]).not.toHaveProperty("leaderResponseCoverageVersion");
    expect(session.messageHistory[0]).not.toHaveProperty("leaderUserMessageId");
    expect(deps.touchUserMessage).not.toHaveBeenCalled();
    expect(deps.refreshBrowserConversationViews).toHaveBeenCalledWith(session);
  });

  it("preserves coverage and invalidates stale Ready when delayed human input commits", () => {
    const input: PendingCodexInput = {
      id: "covered-user",
      content: "Finish this request",
      timestamp: 12345,
      cancelable: false,
      threadKey: "q-42",
      questId: "q-42",
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    };
    const session = {
      id: "leader",
      state: {
        cwd: "/tmp",
        leaderThreadStatuses: {
          "q-42": {
            kind: "ready",
            label: "Thread Ready",
            threadKey: "q-42",
            questId: "q-42",
            summary: "old",
            messageId: "old",
            timestamp: 1,
            updatedAt: 1,
          },
        },
      },
      messageHistory: [],
      pendingCodexInputs: [input],
      notifications: [],
      isGenerating: false,
    } as unknown as CodexRecoveryOrchestratorSessionLike;
    const invalidateLeaderThreadTabsForSession = vi.fn(() => true);
    const refreshBrowserConversationViews = vi.fn();
    const deps = {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
      invalidateLeaderThreadTabsForSession,
      refreshBrowserConversationViews,
    } as unknown as CodexRecoveryOrchestratorDeps;

    commitPendingCodexInputs(session, [input.id], deps);

    expect(session.messageHistory[0]).toMatchObject({
      id: input.id,
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    });
    expect(session.state.leaderThreadStatuses?.["q-42"]).toBeUndefined();
    expect(invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(session.id);
    expect(refreshBrowserConversationViews).toHaveBeenCalledWith(session);
  });
  it("tracks a receipt-proven same-provider-turn steer as current answer input", () => {
    const input: PendingCodexInput = {
      id: "steered-user",
      content: "Answer this follow-up",
      timestamp: 20,
      cancelable: false,
      threadKey: "main",
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    };
    const currentHistory = createCodexHistoryIncorporation(["initial-owner"]);
    currentHistory.providerTurnId = "turn-current";
    currentHistory.rpcAcceptedAt = 10;
    const currentTurn: CodexOutboundTurn = {
      adapterMsg: {
        type: "codex_start_pending",
        pendingInputIds: ["initial-owner"],
        inputs: [{ content: "initial work" }],
        clientUserMessageId: currentHistory.clientUserMessageId,
      },
      userMessageId: "initial-owner",
      pendingInputIds: ["initial-owner"],
      userContent: "initial work",
      historyIndex: 0,
      status: "backend_acknowledged",
      dispatchCount: 1,
      createdAt: 1,
      updatedAt: 10,
      acknowledgedAt: 10,
      turnTarget: "current",
      lastError: null,
      turnId: "turn-current",
      disconnectedAt: null,
      resumeConfirmedAt: null,
      historyIncorporation: currentHistory,
    };
    const session = {
      id: "leader",
      state: { cwd: "/tmp" },
      messageHistory: [],
      pendingCodexInputs: [input],
      pendingCodexTurns: [currentTurn],
      notifications: [],
      isGenerating: true,
    } as unknown as CodexRecoveryOrchestratorSessionLike;
    const tracked: Array<{ historyIndex: number; target: string }> = [];
    const deps = {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
      enqueueCodexTurn: vi.fn((target, turn) => {
        target.pendingCodexTurns.push(turn);
        return turn;
      }),
      trackUserMessageForTurn: vi.fn((_target, historyIndex, target) => tracked.push({ historyIndex, target })),
    } as unknown as CodexRecoveryOrchestratorDeps;
    const clientUserMessageId = createCodexHistoryIncorporation([input.id]).clientUserMessageId;

    const steered = recordSubmittedCodexSteerTurn(session, "turn-current", [input], clientUserMessageId, deps)!;
    recordCodexHistoryReceiptObservation(
      session,
      { turnId: "turn-current", clientUserMessageId, observedAt: 30 },
      deps,
    );

    expect(steered.turnTarget).toBe("current");
    expect(session.messageHistory[0]).toMatchObject({ id: input.id, leaderUserMessageId: "u1" });
    expect(tracked).toContainEqual({ historyIndex: 0, target: "current" });
  });

  it("keeps a receipt-proven future-turn steer queued", () => {
    const input: PendingCodexInput = {
      id: "future-user",
      content: "Handle in the future turn",
      timestamp: 20,
      cancelable: false,
      threadKey: "main",
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    };
    const currentHistory = createCodexHistoryIncorporation(["initial-owner"]);
    currentHistory.providerTurnId = "turn-current";
    currentHistory.rpcAcceptedAt = 10;
    const currentTurn = {
      adapterMsg: { type: "codex_start_pending", pendingInputIds: ["initial-owner"], inputs: [] },
      userMessageId: "initial-owner",
      pendingInputIds: ["initial-owner"],
      userContent: "initial work",
      historyIndex: 0,
      status: "backend_acknowledged",
      dispatchCount: 1,
      createdAt: 1,
      updatedAt: 10,
      acknowledgedAt: 10,
      turnTarget: "current",
      lastError: null,
      turnId: "turn-current",
      disconnectedAt: null,
      resumeConfirmedAt: null,
      historyIncorporation: currentHistory,
    } as CodexOutboundTurn;
    const session = {
      id: "leader",
      state: { cwd: "/tmp" },
      messageHistory: [],
      pendingCodexInputs: [input],
      pendingCodexTurns: [currentTurn],
      notifications: [],
      isGenerating: true,
    } as unknown as CodexRecoveryOrchestratorSessionLike;
    const trackUserMessageForTurn = vi.fn();
    const deps = {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
      enqueueCodexTurn: vi.fn((target, turn) => {
        target.pendingCodexTurns.push(turn);
        return turn;
      }),
      trackUserMessageForTurn,
    } as unknown as CodexRecoveryOrchestratorDeps;
    const clientUserMessageId = createCodexHistoryIncorporation([input.id]).clientUserMessageId;

    const steered = recordSubmittedCodexSteerTurn(session, "turn-current", [input], clientUserMessageId, deps)!;
    steered.turnId = "turn-future";
    steered.historyIncorporation!.providerTurnId = "turn-future";
    recordCodexHistoryReceiptObservation(session, { turnId: "turn-future", clientUserMessageId, observedAt: 30 }, deps);

    expect(steered.turnTarget).toBe("queued");
    expect(trackUserMessageForTurn).toHaveBeenCalledWith(session, 0, "queued");
  });
});
