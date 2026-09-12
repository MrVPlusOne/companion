import { createCodexHistoryIncorporation } from "./codex-history-incorporation.js";
import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage, CLIResultMessage, CodexOutboundTurn } from "../session-types.js";
import { injectUserMessage as injectProgrammaticUserMessage } from "./browser-transport-controller.js";
import {
  archiveUnrelatedTerminalCodexRecovery,
  beginCodexTurnRecoveryContinuation,
  hasIncompleteCodexActivityWithoutTerminalEvidence,
  isCodexTurnRecoveryContinuationInjectionPending,
  isRecoveryContinuationTurn,
  markCodexTurnRecoveryActionRequired,
  markCodexTurnRecoveryContinuationActive,
  markCodexTurnRecoveryOnDisconnect,
  normalizeCodexTurnRecoveryState,
  repairRestoredCodexTurnRecovery,
  repairRestoredCodexTurnRecoveryState,
  resolveCodexTurnRecoveryAction,
  resolveCodexTurnRecoveryRoute,
  settleCodexTurnRecoveryFromResult,
  type CodexInterruptedTurnRecoverySessionLike,
} from "./codex-interrupted-turn-recovery.js";

function result(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    session_id: "session",
    uuid: "result",
    stop_reason: "completed",
    ...overrides,
  };
}

function makeSession(): CodexInterruptedTurnRecoverySessionLike {
  const user: BrowserIncomingMessage = {
    type: "user_message",
    id: "original-owner",
    content: "Investigate and finish the task",
    timestamp: 1,
    threadKey: "q-1987",
    questId: "q-1987",
  };
  return {
    id: "session",
    attentionReason: null,
    isGenerating: false,
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    queuedTurnInterruptSources: [],
    queuedTurnActiveRoutes: [],
    sessionNum: 42,
    state: { backend_state: "connected", isOrchestrator: true, codex_turn_recovery: null },
    messageHistory: [user],
    frozenCount: 0,
    pendingCodexInputs: [],
    pendingCodexTurns: [],
  };
}

function turn(overrides: Partial<CodexOutboundTurn> = {}): CodexOutboundTurn {
  return {
    adapterMsg: { type: "codex_start_pending", pendingInputIds: ["original-owner"], inputs: [{ content: "task" }] },
    userMessageId: "original-owner",
    pendingInputIds: ["original-owner"],
    userContent: "task",
    historyIndex: 0,
    status: "backend_acknowledged",
    dispatchCount: 1,
    createdAt: 1,
    updatedAt: 2,
    acknowledgedAt: 2,
    turnTarget: "current",
    lastError: null,
    turnId: "provider-turn",
    disconnectedAt: 3,
    resumeConfirmedAt: 4,
    ...overrides,
  };
}

function deps(session: CodexInterruptedTurnRecoverySessionLike) {
  const broadcastToBrowsers = vi.fn();
  const persistSession = vi.fn();
  const persistHistoryMetadataRepair = vi.fn(async () => {});
  const setAttentionError = vi.fn();
  const injectUserMessage = vi.fn(
    (
      _: string,
      __: string,
      agentSource: { sessionId: string },
      ___: unknown,
      options: { deliveryContent: string; afterAccepted?: () => void },
    ) => {
      session.pendingCodexInputs.push({
        id: "continuation-owner",
        content: "visible recovery",
        timestamp: 5,
        cancelable: true,
        agentSource,
        threadKey: "q-1987",
        questId: "q-1987",
      });
      options.afterAccepted?.();
      return "sent" as const;
    },
  );
  return {
    broadcastToBrowsers,
    persistSession,
    persistHistoryMetadataRepair,
    setAttentionError,
    injectUserMessage,
  };
}

describe("Codex interrupted turn recovery classification", () => {
  it("treats an interrupted idle tool-only resume with omitted tools as incomplete", () => {
    const interrupted = {
      id: "provider-turn",
      status: "interrupted",
      error: null,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "task" }] },
        { type: "reasoning", summary: ["working"] },
      ],
    };
    expect(
      hasIncompleteCodexActivityWithoutTerminalEvidence(
        interrupted,
        "idle",
        { count: 4, kinds: ["reasoning", "tool_use", "tool_result"], firstHistoryIndex: 1, lastHistoryIndex: 4 },
        3,
      ),
    ).toBe(true);
  });

  it("treats completed or failed tool-only snapshots without final prose as incomplete", () => {
    const toolOnly = {
      id: "provider-turn",
      status: "completed",
      error: null,
      items: [
        { type: "userMessage", content: [{ type: "text", text: "task" }] },
        { type: "functionCall", id: "call-1", status: "completed", name: "exec_command" },
      ],
    };
    const activity = { count: 1, kinds: ["tool_use"], firstHistoryIndex: 1, lastHistoryIndex: 1 } as any;
    expect(hasIncompleteCodexActivityWithoutTerminalEvidence(toolOnly, "idle", activity, 0)).toBe(true);
    expect(
      hasIncompleteCodexActivityWithoutTerminalEvidence(
        {
          ...toolOnly,
          items: [...toolOnly.items, { type: "agentMessage", id: "final", text: "Finished." }],
        },
        "idle",
        activity,
        0,
      ),
    ).toBe(false);
    expect(
      hasIncompleteCodexActivityWithoutTerminalEvidence({ ...toolOnly, status: "failed" }, "idle", activity, 0),
    ).toBe(true);
  });

  it("does not broaden reasoning-only or terminal recovery", () => {
    const interrupted = {
      id: "provider-turn",
      status: "interrupted",
      error: null,
      items: [{ type: "reasoning", summary: ["working"] }],
    };
    const reasoningOnly = { count: 1, kinds: ["reasoning"], firstHistoryIndex: 1, lastHistoryIndex: 1 };
    expect(hasIncompleteCodexActivityWithoutTerminalEvidence(interrupted, "idle", reasoningOnly as any, 0)).toBe(false);
    expect(hasIncompleteCodexActivityWithoutTerminalEvidence(interrupted, "idle", reasoningOnly as any, 0, true)).toBe(
      true,
    );
    expect(
      hasIncompleteCodexActivityWithoutTerminalEvidence(
        { ...interrupted, items: [...interrupted.items, { type: "result" }] },
        "idle",
        reasoningOnly as any,
        1,
      ),
    ).toBe(false);
  });
});

describe("Codex interrupted turn recovery state", () => {
  it.each([
    "active",
    "archived",
    "resolved",
  ] as const)("reserves recovery ordering until a queued route settles (state before routing: %s)", async (state) => {
    const session = Object.assign(makeSession(), {
      backendType: "codex" as const,
      browserSockets: new Set(),
      nextEventSeq: 1,
      lastAckSeq: 0,
      pendingPermissions: new Map(),
      taskHistory: [],
      eventBuffer: [],
      lastReadAt: 0,
      generationStartedAt: null,
      notifications: [],
      attentionRecords: [],
      processedClientMessageIds: [],
      processedClientMessageIdSet: new Set<string>(),
    });
    session.pendingCodexTurns = [
      turn({ userMessageId: "later-owner", pendingInputIds: ["later-owner"], turnId: null }),
    ];
    let releaseRoute!: () => void;
    const blocker = new Promise<void>((resolve) => (releaseRoute = resolve));
    const routeState: { current?: Promise<void> } = { current: blocker };
    const routeBrowserMessage = vi.fn(async (_target: unknown, message: any) => {
      session.pendingCodexInputs.push({
        id: "continuation-owner",
        content: message.content,
        deliveryContent: message.deliveryContent,
        timestamp: 5,
        cancelable: true,
        agentSource: message.agentSource,
        threadKey: message.threadKey,
        questId: message.questId,
        requireFreshSuccessor: true,
      });
      return true;
    });
    const browserDeps = {
      routeBrowserMessage,
      backendConnected: vi.fn(() => true),
      getLauncherSessionInfo: vi.fn(() => ({ archived: false })),
      idempotentMessageTypes: new Set<string>(),
      processedClientMsgIdLimit: 100,
      persistSession: vi.fn(),
      getRouteChain: vi.fn(() => routeState.current),
      setRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => (routeState.current = route)),
      clearRouteChain: vi.fn((_sessionId: string, route: Promise<void>) => {
        if (routeState.current === route) routeState.current = undefined;
      }),
      notifyImageSendFailure: vi.fn(),
      broadcastError: vi.fn(),
    } as any;
    const rebuildQueuedCodexPendingStartBatch = vi.fn();
    const dispatchQueuedCodexTurns = vi.fn();
    const afterAccepted = vi.fn();
    const afterRejected = vi.fn();
    const recoveryDeps = {
      ...deps(session),
      rebuildQueuedCodexPendingStartBatch,
      dispatchQueuedCodexTurns,
      injectUserMessage: (sessionId: string, content: string, agentSource: any, route: any, options: any) =>
        injectProgrammaticUserMessage(session as any, content, agentSource, undefined, browserDeps, route, {
          ...options,
          afterAccepted: () => {
            afterAccepted();
            options.afterAccepted?.();
          },
          afterRejected: (reason: "dropped" | "route_rejected" | "route_failed") => {
            afterRejected(reason);
            options.afterRejected?.(reason);
          },
        }),
    };

    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    expect(routeBrowserMessage).not.toHaveBeenCalled();
    expect(isCodexTurnRecoveryContinuationInjectionPending(session)).toBe(true);
    expect(dispatchQueuedCodexTurns).not.toHaveBeenCalled();

    if (state !== "active") {
      // A's route is still waiting on unrelated routing work when recovery ends.
      // B now owns a live turn; releasing A must reject before adapter routing
      // can mistake that old continuation for an ordinary steer into B.
      markCodexTurnRecoveryActionRequired(session, "recovery_timeout", recoveryDeps);
      archiveUnrelatedTerminalCodexRecovery(session, "later-owner", recoveryDeps);
      const oldRecovery = structuredClone(session.codexTerminalRecoveries![0]!);
      const activeRecovery = {
        ...oldRecovery,
        recoveryId: "later-owner",
        originalOwnerId: "later-owner",
        originalProviderTurnId: "later-provider-turn",
        continuationOwnerId: "later-continuation",
        status: "continuation_active" as const,
      };
      session.state.codex_turn_recovery = activeRecovery;
      session.isGenerating = true;
      session.pendingCodexTurns = [
        turn({
          userMessageId: "later-continuation",
          pendingInputIds: ["later-continuation"],
          turnId: "later-provider-turn",
        }),
      ];
      const preservedTurns = structuredClone(session.pendingCodexTurns);
      const preservedHistory = structuredClone(session.messageHistory);
      if (state === "resolved") {
        // Resolution removes A's archive, but its previously queued route still
        // exists. Absence of terminal evidence must not renew delivery authority.
        expect(resolveCodexTurnRecoveryAction(session, oldRecovery.recoveryId, recoveryDeps)).toBe(true);
        expect(session.codexTerminalRecoveries).toEqual([]);
      }
      const drain = routeState.current;
      releaseRoute();
      await drain;

      expect(afterRejected).toHaveBeenCalledExactlyOnceWith("dropped");
      expect(afterAccepted).not.toHaveBeenCalled();
      expect(routeBrowserMessage).not.toHaveBeenCalled();
      expect(session.state.codex_turn_recovery).toEqual(activeRecovery);
      expect(session.codexTerminalRecoveries).toEqual(state === "resolved" ? [] : [oldRecovery]);
      expect(session.pendingCodexTurns).toEqual(preservedTurns);
      expect(session.pendingCodexInputs).toEqual([]);
      expect(session.messageHistory).toEqual(preservedHistory);
      expect(session.isGenerating).toBe(true);
      expect(rebuildQueuedCodexPendingStartBatch).not.toHaveBeenCalled();
      expect(dispatchQueuedCodexTurns).not.toHaveBeenCalled();
      return;
    }

    const drain = routeState.current;
    releaseRoute();
    await drain;

    expect(afterAccepted).toHaveBeenCalledOnce();
    expect(afterRejected).not.toHaveBeenCalled();
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "continuation_pending",
      continuationOwnerId: "continuation-owner",
    });
    expect(session.pendingCodexInputs[0]).toMatchObject({ queueBeforeOwnerId: "later-owner" });
    expect(rebuildQueuedCodexPendingStartBatch).toHaveBeenCalledWith(session);
    expect(dispatchQueuedCodexTurns).toHaveBeenCalledWith(session, "codex_turn_recovery_continuation_accepted");
  });

  it("queues one separately owned routed continuation and clears only on its success", () => {
    const session = makeSession();
    const original = turn();
    const recoveryDeps = deps(session);

    expect(
      beginCodexTurnRecoveryContinuation(session, original, { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    expect(recoveryDeps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent).toContain(
      "separately owned verification-first continuation",
    );
    expect(recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent).toContain(
      "Tool or external effects may already have occurred",
    );
    expect(recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent).toContain(
      "Takode could not confirm that the previous turn completed its response",
    );
    expect(recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent).toContain(
      "Takode history and these commands expose only Takode's persisted observations",
    );
    expect(recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent).toContain(
      "may be incomplete and do not prove all Codex-internal progress, partial tool execution, or external effects",
    );
    const prompt = recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent;
    expect(prompt).toContain("cannot confirm the original input's receipt");
    expect(prompt).toContain("Continue from the request and partial work already in your context");
    expect(prompt).toContain("Only if a necessary detail is missing");
    expect(prompt).toContain("--limit 40");
    expect(prompt).toContain("--count 20");
    expect(prompt).not.toContain("Start with");
    expect(prompt).not.toContain("Inspect current quest, board");
    expect(session.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: "original-owner",
      continuationOwnerId: "continuation-owner",
      threadKey: "q-1987",
      status: "continuation_pending",
      attempt: 1,
      maxAttempts: 1,
    });

    const continuation = turn({
      userMessageId: "continuation-owner",
      pendingInputIds: ["continuation-owner"],
      historyIndex: 1,
      turnId: "continuation-turn",
    });
    session.messageHistory.push({
      type: "user_message",
      id: "continuation-owner",
      content: "visible recovery",
      timestamp: 5,
      threadKey: "q-1987",
      questId: "q-1987",
      agentSource: {
        sessionId: `system:codex-turn-recovery:${session.state.codex_turn_recovery?.recoveryId}`,
      },
    });
    markCodexTurnRecoveryContinuationActive(session, continuation, recoveryDeps);
    expect(session.state.codex_turn_recovery?.status).toBe("continuation_active");

    settleCodexTurnRecoveryFromResult(session, [continuation], result(), recoveryDeps);
    expect(session.state.codex_turn_recovery).toBeNull();
  });

  it("keeps incomplete-observation guidance without broadening finish-response authority", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);

    expect(
      beginCodexTurnRecoveryContinuation(
        session,
        turn(),
        { threadKey: "q-1987", questId: "q-1987" },
        recoveryDeps,
        "finish_response",
      ),
    ).toBe(true);

    const deliveryContent = recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent;
    expect(deliveryContent).toContain(
      "The original user payload is recorded in Codex history and must not be replayed",
    );
    expect(deliveryContent).toContain("Takode could not confirm that the previous turn completed its response");
    expect(deliveryContent).toContain("Takode history and these commands expose only Takode's persisted observations");
    expect(deliveryContent).toContain("Continue from the request and partial work already in your context");
    expect(deliveryContent).toContain("Only if a necessary detail is missing");
    expect(deliveryContent).toContain(
      "Before repeating an action whose outcome is uncertain, verify that operation's current state",
    );
    expect(deliveryContent).not.toContain("verification-first continuation");
    expect(session.state.codex_turn_recovery).toMatchObject({
      continuationMode: "finish_response",
      status: "continuation_pending",
      attempt: 1,
      maxAttempts: 1,
    });
  });

  it("distinguishes recorded-input uncertainty from missing receipt and uses bounded lookup only when needed", () => {
    // A conservative verification-first mode must not imply that a known
    // receipt was lost or that the model necessarily lost its working context.
    const session = makeSession();
    const recoveryDeps = deps(session);
    const history = createCodexHistoryIncorporation(["original-owner"]);
    history.recordedAt = 3;
    history.recordedSource = "live";
    const original = turn({ historyIncorporation: history });
    beginCodexTurnRecoveryContinuation(session, original, { threadKey: "main" }, recoveryDeps);
    const prompt = recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent;
    expect(prompt).toContain("has evidence that the original input was recorded");
    expect(prompt).not.toContain("cannot confirm the original input's receipt");
    expect(prompt).toContain("does not establish that your model context was lost");
    expect(prompt).toContain("verify that operation's current state");
  });

  it("uses a bounded optional scan when the interrupted owner has no history anchor", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn({ historyIndex: -1 }), { threadKey: "main" }, recoveryDeps);
    const prompt = recoveryDeps.injectUserMessage.mock.calls[0]?.[4]?.deliveryContent;
    expect(prompt).toContain("Only if a necessary detail is missing");
    expect(prompt).toContain("takode scan 42 --count 5");
    expect(prompt).not.toContain("--turn-containing -1");
  });

  it("fails closed after the one continuation is interrupted instead of recursively injecting", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    const continuation = turn({ userMessageId: "continuation-owner", historyIndex: 1, turnId: "continuation-turn" });
    session.messageHistory.push({
      type: "user_message",
      id: "continuation-owner",
      content: "visible recovery",
      timestamp: 5,
      agentSource: {
        sessionId: `system:codex-turn-recovery:${session.state.codex_turn_recovery?.recoveryId}`,
      },
      threadKey: "q-1987",
      questId: "q-1987",
    });
    markCodexTurnRecoveryOnDisconnect(session, continuation, recoveryDeps);
    expect(session.state.codex_turn_recovery?.status).toBe("recovering");

    expect(
      beginCodexTurnRecoveryContinuation(
        session,
        continuation,
        { threadKey: "q-1987", questId: "q-1987" },
        recoveryDeps,
      ),
    ).toBe(false);
    expect(recoveryDeps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(session.state.codex_turn_recovery?.status).toBe("action_required");
    expect(session.state.codex_turn_recovery?.reason).toBe("continuation_interrupted");
    expect(session.state.codex_turn_recovery?.raisedAttention).toBe(false);
    expect(recoveryDeps.setAttentionError).not.toHaveBeenCalled();
  });

  it("keeps later same-provider-turn owners queued when one recovery becomes action-required", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    session.pendingCodexInputs.push({
      id: "owner-b",
      content: "later independently tracked owner",
      timestamp: 6,
      cancelable: false,
      threadKey: "q-1988",
      questId: "q-1988",
    });
    session.pendingCodexTurns.push(
      turn({
        userMessageId: "owner-b",
        pendingInputIds: ["owner-b"],
        userContent: "later independently tracked owner",
        historyIndex: -1,
        status: "recovery_pending",
        terminalHistoryReconciliation: {
          presence: "unknown",
          reason: "terminal_result_without_history_receipt",
          action: "continue",
          continuationMode: "verify_then_continue",
          classifiedAt: 6,
        },
      }),
    );

    markCodexTurnRecoveryActionRequired(session, "continuation_failed", recoveryDeps);

    expect(session.pendingCodexInputs.map((input) => input.id)).toEqual(["owner-b"]);
    expect(session.pendingCodexTurns).toEqual([
      expect.objectContaining({ userMessageId: "owner-b", status: "recovery_pending" }),
    ]);
    const queueCodexPendingStartBatch = vi.fn();
    expect(
      resolveCodexTurnRecoveryAction(session, "original-owner", {
        ...recoveryDeps,
        queueCodexPendingStartBatch,
      }),
    ).toBe(true);
    expect(queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "codex_turn_recovery_resolved");
  });

  it("fails original-owner results closed and honors canonical interruption for continuation results", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    const original = turn();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "original-tool",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo done" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 2,
    });
    session.pendingCodexTurns = [original];
    markCodexTurnRecoveryOnDisconnect(session, original, recoveryDeps);

    settleCodexTurnRecoveryFromResult(
      session,
      [original],
      result({ is_error: true, subtype: "error_during_execution" }),
      recoveryDeps,
    );
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "recovery_failed",
    });

    const interruptedSession = makeSession();
    const interruptedDeps = deps(interruptedSession);
    beginCodexTurnRecoveryContinuation(
      interruptedSession,
      turn(),
      { threadKey: "q-1987", questId: "q-1987" },
      interruptedDeps,
    );
    const continuation = turn({
      userMessageId: "continuation-owner",
      pendingInputIds: ["continuation-owner"],
      historyIndex: 1,
      turnId: "continuation-turn",
    });
    interruptedSession.messageHistory.push({
      type: "user_message",
      id: "continuation-owner",
      content: "visible recovery",
      timestamp: 5,
      agentSource: {
        sessionId: `system:codex-turn-recovery:${interruptedSession.state.codex_turn_recovery?.recoveryId}`,
      },
    });
    settleCodexTurnRecoveryFromResult(interruptedSession, [continuation], result(), interruptedDeps, true);
    expect(interruptedSession.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_interrupted",
    });
  });

  it("selects the direct human co-owner and preserves its original route", () => {
    const session = makeSession();
    session.messageHistory = [
      {
        type: "user_message",
        id: "herd-owner",
        content: "automatic work",
        timestamp: 1,
        agentSource: { sessionId: "herd-events" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "human-owner",
        content: "direct correction",
        timestamp: 2,
        threadKey: "q-9010",
        questId: "q-9010",
      },
      {
        type: "assistant",
        message: {
          id: "tool-after-human",
          type: "message",
          role: "assistant",
          model: "gpt-5.6-sol",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo done" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 3,
      },
    ];
    const automatic = turn({ userMessageId: "herd-owner", pendingInputIds: ["herd-owner"], historyIndex: 0 });
    const human = turn({ userMessageId: "human-owner", pendingInputIds: ["human-owner"], historyIndex: 1 });
    session.pendingCodexTurns = [automatic, human];
    const recoveryDeps = deps(session);

    markCodexTurnRecoveryOnDisconnect(session, automatic, recoveryDeps);

    expect(session.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: "human-owner",
      originalProviderTurnId: "provider-turn",
      threadKey: "q-9010",
      questId: "q-9010",
    });
    expect(resolveCodexTurnRecoveryRoute(session, human, { threadKey: "q-9999", questId: "q-9999" })).toMatchObject({
      threadKey: "q-9010",
      questId: "q-9010",
    });
  });

  it("queues a priority continuation despite later work but fails closed while delivery is paused", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    session.pendingCodexTurns = [turn({ userMessageId: "later", pendingInputIds: ["later"], turnId: null })];
    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    expect(recoveryDeps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(session.pendingCodexTurns.map((pending) => pending.userMessageId)).toEqual(["later"]);
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "continuation_pending",
      continuationOwnerId: "continuation-owner",
    });

    const paused = makeSession();
    paused.state.pause = { pausedAt: 10, queuedMessages: [] };
    const pausedDeps = deps(paused);
    expect(
      beginCodexTurnRecoveryContinuation(paused, turn(), { threadKey: "q-1987", questId: "q-1987" }, pausedDeps),
    ).toBe(false);
    expect(pausedDeps.injectUserMessage).not.toHaveBeenCalled();
    expect(paused.state.codex_turn_recovery).toMatchObject({ status: "action_required" });
  });

  it("dedupes an already queued continuation and fails closed across an orphaned crash window", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(true);
    expect(recoveryDeps.injectUserMessage).toHaveBeenCalledTimes(1);

    session.pendingCodexInputs = [];
    expect(
      beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps),
    ).toBe(false);
    expect(recoveryDeps.injectUserMessage).toHaveBeenCalledTimes(1);
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
    });
  });

  it("retires live recovery owners and ignores a late original success after continuation began", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    const original = turn();
    beginCodexTurnRecoveryContinuation(session, original, { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    session.pendingCodexTurns = [
      turn({
        userMessageId: "continuation-owner",
        pendingInputIds: ["continuation-owner"],
        historyIndex: 1,
        turnId: "continuation-turn",
      }),
    ];

    settleCodexTurnRecoveryFromResult(session, [original], result(), recoveryDeps);
    expect(session.state.codex_turn_recovery).not.toBeNull();

    markCodexTurnRecoveryActionRequired(session, "continuation_failed", recoveryDeps);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.state.codex_turn_recovery).toMatchObject({ status: "action_required" });
  });

  it("repairs restored continuation ownership or converts an ownerless state to action required", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    const repaired = repairRestoredCodexTurnRecoveryState(session);
    expect(repaired).toMatchObject({ continuationOwnerId: "continuation-owner", status: "continuation_pending" });

    session.pendingCodexInputs = [];
    session.pendingCodexTurns = [];
    expect(repairRestoredCodexTurnRecoveryState(session)).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
    });
  });

  it.each([
    "error",
    "review",
    "action",
  ] as const)("does not clear unrelated pre-existing %s attention on explicit resolution", (attentionReason) => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    session.attentionReason = attentionReason;
    markCodexTurnRecoveryActionRequired(session, "continuation_failed", recoveryDeps);
    expect(session.state.codex_turn_recovery?.raisedAttention).toBe(false);
    expect(recoveryDeps.setAttentionError).not.toHaveBeenCalled();

    expect(resolveCodexTurnRecoveryAction(session, "original-owner", recoveryDeps)).toBe(true);
    expect(session.attentionReason).toBe(attentionReason);
  });

  it("clears action-required recovery only through its exact explicit resolution id", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    session.state.codex_turn_recovery = {
      ...session.state.codex_turn_recovery!,
      status: "action_required",
      reason: "continuation_interrupted",
    };

    expect(resolveCodexTurnRecoveryAction(session, "wrong-owner", recoveryDeps)).toBe(false);
    expect(session.state.codex_turn_recovery).not.toBeNull();
    expect(resolveCodexTurnRecoveryAction(session, "original-owner", recoveryDeps)).toBe(true);
    expect(session.state.codex_turn_recovery).toBeNull();
  });

  it("retires action-required state and its routed diagnostic after a fresh same-thread human success", () => {
    const session = makeSession();
    const recoveryDeps = { ...deps(session), refreshBrowserConversationViews: vi.fn() };
    session.state.codex_turn_recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 0,
      continuationOwnerId: null,
      threadKey: "main",
      status: "action_required",
      reason: "continuation_dispatch_failed",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    };
    session.messageHistory.push(
      {
        type: "user_message",
        id: "legacy-recovery-diagnostic",
        content: "Review the interrupted work.",
        timestamp: 120,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "fresh-follow-up",
        content: "Continue the missing work",
        timestamp: 200,
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "later-distinct-legacy-diagnostic",
        content: "A later interrupted turn still needs review.",
        timestamp: 210,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
    );
    session.frozenCount = 2;
    const followUp = turn({
      userMessageId: "fresh-follow-up",
      pendingInputIds: ["fresh-follow-up"],
      historyIndex: 2,
      turnId: "turn-follow-up",
    });

    settleCodexTurnRecoveryFromResult(session, [followUp], result(), recoveryDeps);

    expect(session.state.codex_turn_recovery).toBeNull();
    expect(session.messageHistory[1]).toMatchObject({
      type: "user_message",
      codexTurnRecoveryId: "original-owner",
      codexTurnRecoveryResolvedAt: expect.any(Number),
    });
    expect(session.messageHistory[3]).toMatchObject({
      type: "user_message",
      id: "later-distinct-legacy-diagnostic",
    });
    expect(session.messageHistory[3]).not.toHaveProperty("codexTurnRecoveryResolvedAt");
    expect(recoveryDeps.persistHistoryMetadataRepair).toHaveBeenCalledWith(session, 2);
    expect(recoveryDeps.refreshBrowserConversationViews).toHaveBeenCalledWith(session);
    expect(recoveryDeps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "session_update",
      session: { codex_turn_recovery: null },
    });
  });

  it("repairs restored action-required state when persisted same-thread human success proves completion", () => {
    const session = makeSession();
    session.frozenCount = 2;
    session.state.codex_turn_recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 0,
      continuationOwnerId: null,
      threadKey: "main",
      status: "action_required",
      reason: "continuation_dispatch_failed",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    };
    session.messageHistory.push(
      {
        type: "user_message",
        id: "legacy-recovery-diagnostic",
        content: "Review the interrupted work.",
        timestamp: 120,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "fresh-follow-up",
        content: "Continue the missing work",
        timestamp: 200,
        threadKey: "main",
      },
      { type: "result", data: result({ uuid: "fresh-follow-up-result" }) },
    );

    const repaired = repairRestoredCodexTurnRecovery(session);

    expect(repaired).toMatchObject({
      state: null,
      resolvedByHistoricalSuccess: true,
      historyMetadataChanged: true,
      requiresFrozenHistoryMetadataRepair: true,
    });
    expect(session.messageHistory[1]).toMatchObject({
      codexTurnRecoveryId: "original-owner",
      codexTurnRecoveryResolvedAt: expect.any(Number),
    });
  });

  it.each([
    {
      label: "later other-thread success",
      tail: [
        {
          type: "user_message",
          id: "other-thread",
          content: "Unrelated work",
          timestamp: 210,
          threadKey: "q-9999",
          questId: "q-9999",
        },
        { type: "result", data: result({ uuid: "other-thread-result" }), threadKey: "q-9999", questId: "q-9999" },
      ],
    },
    {
      label: "native child success",
      tail: [
        {
          type: "result",
          data: result({ uuid: "child-result" }),
          threadKey: "main",
          codexSubagent: { childId: "child-1", rootTurnId: "fresh-follow-up" },
        },
      ],
    },
    {
      label: "interrupted outer result",
      tail: [
        {
          type: "result",
          data: result({ uuid: "interrupted-result" }),
          threadKey: "main",
          interrupted: true,
        },
      ],
    },
  ] as const)("keeps restored recovery for $label", ({ tail }) => {
    const session = makeSession();
    session.state.codex_turn_recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 0,
      continuationOwnerId: null,
      threadKey: "main",
      status: "action_required",
      reason: "continuation_dispatch_failed",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    };
    session.messageHistory.push(
      {
        type: "user_message",
        id: "recovery-diagnostic",
        content: "Review the interrupted work.",
        timestamp: 120,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "fresh-follow-up",
        content: "Finish the interrupted work",
        timestamp: 200,
        threadKey: "main",
      },
      ...(tail as readonly BrowserIncomingMessage[]),
    );

    const repaired = repairRestoredCodexTurnRecovery(session);

    expect(repaired.resolvedByHistoricalSuccess).toBe(false);
    expect(repaired.state).toMatchObject({ status: "action_required", recoveryId: "original-owner" });
    expect(session.messageHistory[1]).not.toHaveProperty("codexTurnRecoveryResolvedAt");
  });

  it("does not bulk-retire ambiguous legacy diagnostics from separate same-thread incidents", () => {
    const session = makeSession();
    const recoveryDeps = { ...deps(session), refreshBrowserConversationViews: vi.fn() };
    session.state.codex_turn_recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 0,
      continuationOwnerId: null,
      threadKey: "main",
      status: "action_required",
      reason: "continuation_dispatch_failed",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    };
    session.messageHistory.push(
      {
        type: "user_message",
        id: "legacy-a",
        content: "First unresolved incident.",
        timestamp: 120,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "legacy-b",
        content: "Second unresolved incident.",
        timestamp: 121,
        agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
        threadKey: "main",
      },
      {
        type: "user_message",
        id: "fresh-follow-up",
        content: "Continue the missing work",
        timestamp: 200,
        threadKey: "main",
      },
    );
    const followUp = turn({
      userMessageId: "fresh-follow-up",
      pendingInputIds: ["fresh-follow-up"],
      historyIndex: 3,
      turnId: "turn-follow-up",
    });

    settleCodexTurnRecoveryFromResult(session, [followUp], result(), recoveryDeps);

    expect(session.state.codex_turn_recovery).toBeNull();
    expect(session.messageHistory[1]).not.toHaveProperty("codexTurnRecoveryResolvedAt");
    expect(session.messageHistory[2]).not.toHaveProperty("codexTurnRecoveryResolvedAt");
  });

  it("keeps action-required state for stale, automatic, other-thread, or failed follow-ups", () => {
    const cases = [
      {
        label: "stale",
        message: { type: "user_message" as const, id: "candidate", content: "queued earlier", timestamp: 90 },
        result: result(),
        interrupted: false,
      },
      {
        label: "automatic",
        message: {
          type: "user_message" as const,
          id: "candidate",
          content: "automatic follow-up",
          timestamp: 200,
          agentSource: { sessionId: "herd-events" },
        },
        result: result(),
        interrupted: false,
      },
      {
        label: "other thread",
        message: {
          type: "user_message" as const,
          id: "candidate",
          content: "unrelated work",
          timestamp: 200,
          threadKey: "q-9999",
          questId: "q-9999",
        },
        result: result(),
        interrupted: false,
      },
      {
        label: "failed",
        message: { type: "user_message" as const, id: "candidate", content: "continue", timestamp: 200 },
        result: result({ is_error: true, subtype: "error_during_execution", stop_reason: "failed" }),
        interrupted: false,
      },
    ];

    for (const testCase of cases) {
      const session = makeSession();
      const recoveryDeps = deps(session);
      session.state.codex_turn_recovery = {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
        originalProviderTurnId: "turn-original",
        originalHistoryIndex: 0,
        continuationOwnerId: null,
        threadKey: "main",
        status: "action_required",
        reason: "continuation_dispatch_failed",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 100,
        updatedAt: 110,
      };
      session.messageHistory.push(testCase.message);
      const followUp = turn({
        userMessageId: "candidate",
        pendingInputIds: ["candidate"],
        historyIndex: 1,
        turnId: `turn-${testCase.label}`,
      });

      settleCodexTurnRecoveryFromResult(session, [followUp], testCase.result, recoveryDeps, testCase.interrupted);

      expect(session.state.codex_turn_recovery, testCase.label).toMatchObject({
        status: "action_required",
        recoveryId: "original-owner",
      });
    }
  });

  it("does not let an unrelated compaction continuation revive action-required recovery", () => {
    const session = makeSession();
    const recoveryDeps = deps(session);
    beginCodexTurnRecoveryContinuation(session, turn(), { threadKey: "q-1987", questId: "q-1987" }, recoveryDeps);
    markCodexTurnRecoveryActionRequired(session, "continuation_failed", recoveryDeps);
    session.messageHistory.push({
      type: "user_message",
      id: "later-compaction",
      content: "ordinary later compaction recovery",
      timestamp: 10,
      agentSource: { sessionId: "system:compaction-recovery" },
    });
    const unrelated = turn({
      userMessageId: "later-compaction",
      pendingInputIds: ["later-compaction"],
      historyIndex: 1,
      turnId: "later-compaction-turn",
    });

    expect(isRecoveryContinuationTurn(session, unrelated)).toBe(false);
    settleCodexTurnRecoveryFromResult(session, [unrelated], result(), recoveryDeps);
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_failed",
    });
  });

  it("normalizes payload-free persisted state and rejects malformed records", () => {
    expect(normalizeCodexTurnRecoveryState({ status: "recovering" })).toBeNull();
    expect(
      normalizeCodexTurnRecoveryState({
        recoveryId: "owner",
        originalOwnerId: "owner",
        originalProviderTurnId: "turn",
        originalHistoryIndex: 7,
        continuationOwnerId: null,
        threadKey: "main",
        status: "continuation_pending",
        reason: "interrupted_after_activity",
        attempt: 2,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 20,
      }),
    ).toMatchObject({ status: "action_required", reason: "recovery_failed", attempt: 1 });
    expect(
      normalizeCodexTurnRecoveryState({
        recoveryId: "owner",
        originalOwnerId: "owner",
        originalProviderTurnId: "turn",
        originalHistoryIndex: 7,
        continuationOwnerId: null,
        threadKey: "main",
        status: "action_required",
        reason: "recovery_timeout",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 10,
        updatedAt: 20,
      }),
    ).toMatchObject({ recoveryId: "owner", status: "action_required", reason: "recovery_timeout" });
  });
});
