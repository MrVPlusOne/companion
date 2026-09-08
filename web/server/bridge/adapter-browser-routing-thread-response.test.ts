import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "../session-types.js";
import { ingestUserMessage, routeBrowserMessage } from "./adapter-browser-routing-controller.js";
import { finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";
import { THREAD_RESPONSE_REMINDER_SOURCE_ID } from "./leader-thread-outcome-validator.js";
import type { AdapterBrowserRoutingDeps, AdapterBrowserRoutingSessionLike } from "./adapter-browser-routing-types.js";
import {
  buildAdapterUserMessageSourcePrefix,
  buildUserMessageDeliveryPrefix,
} from "./adapter-browser-routing-source-prefix.js";

describe("leader timer firing ingestion", () => {
  const firing = {
    type: "user_message" as const,
    content: "[⏰ Timer t4 reminder] Daily report\n\nEarlier note:\nProduce the report.",
    agentSource: { sessionId: "timer:t4", sessionLabel: "Timer t4" },
    threadKey: "q-42",
    timerFiring: { timerId: "t4", scheduledFireAt: 1_000 },
  };

  it("supplies one firing reference without turning the timer into a human request", async () => {
    // The model receives an exact source reference; stored reminder prose is unchanged.
    const target = session();
    const runtime = deps();
    const ingested = await ingestUserMessage(target, firing, runtime);
    expect(ingested.historyEntry).toMatchObject({
      content: firing.content,
      leaderTimerMessageId: "timer-m1",
      threadKey: "q-42",
      questId: "q-42",
    });
    expect(ingested.historyEntry).not.toHaveProperty("leaderUserMessageId");
    expect(ingested.historyEntry).not.toHaveProperty("leaderResponseCoverageVersion");
    expect(runtime.touchUserMessage).not.toHaveBeenCalled();
    expect(runtime.refreshBrowserConversationViews).toHaveBeenCalledWith(target);
    const prefix = buildAdapterUserMessageSourcePrefix(
      target,
      ingested.timestamp,
      runtime.getLauncherSessionInfo,
      firing.agentSource,
      firing.content,
      "q-42",
      undefined,
      ingested.historyEntry.leaderTimerMessageId,
    );
    expect(prefix).toMatch(/^\[Timer reminder .* id:timer-m1\] \[thread:q-42\] $/);
  });

  it("reserves references for queued recurring firings before either commits", async () => {
    // Concurrent queued occurrences must not both be assigned the next history ordinal.
    const target = session();
    const runtime = deps();
    const first = await ingestUserMessage(target, firing, runtime, { commit: false });
    target.pendingCodexInputs.push({
      id: first.historyEntry.id!,
      content: firing.content,
      timestamp: first.timestamp,
      cancelable: true,
      leaderTimerMessageId: first.historyEntry.leaderTimerMessageId,
    });
    const second = await ingestUserMessage(target, firing, runtime, { commit: false });
    expect(first.historyEntry.leaderTimerMessageId).toBe("timer-m1");
    expect(second.historyEntry.leaderTimerMessageId).toBe("timer-m2");
    expect(target.messageHistory).toEqual([]);
  });

  it.each([
    "manual pause",
    "auto-pause",
    "recovery transfer",
  ])("reserves assigned references retained in %s", async (owner) => {
    // A removed pending input still owns its firing ID while another durable
    // delivery state holds it, including after process restart.
    const target = session();
    const message = { ...firing, timerFiring: { ...firing.timerFiring, messageId: "f7" } };
    if (owner === "manual pause") {
      target.state.pause = {
        pausedAt: 1,
        queuedMessages: [{ id: "held", queuedAt: 2, source: "programmatic", message }],
      };
    } else if (owner === "auto-pause") {
      target.state.codex_result_error_auto_pause = {
        family: "model_not_supported",
        fingerprint: "model_not_supported:selected_model",
        streak: 1,
        threshold: 1,
        pausedAt: 1,
        lastError: "unsupported model",
        lastErrorAt: 1,
        lastSourceKind: "automatic",
        totalMatchingErrors: 1,
        heldInputs: [{ id: "held", queuedAt: 2, lastQueuedAt: 2, source: "programmatic", count: 1, message }],
      };
    } else {
      target.recoveryDeliveryTransfers = [
        {
          id: "recovery-transfer-held",
          createdAt: 2,
          sourceOwnerKind: "auto_pause",
          sourceOwnerId: "held",
          sourceOwnerCount: 1,
          payloadBytes: 200,
          message,
        },
      ];
    }

    const ingested = await ingestUserMessage(target, firing, deps(), { commit: false });

    expect(ingested.historyEntry.leaderTimerMessageId).toBe("timer-m8");
    expect(target.messageHistory).toEqual([]);
  });

  it("reuses a held firing reference without duplicating its model source envelope", async () => {
    const target = session();
    const runtime = deps();
    const deliveryContent = "[Timer reminder earlier id:f7] [thread:q-42] " + firing.content;
    const message = { ...firing, deliveryContent, timerFiring: { ...firing.timerFiring, messageId: "f7" } };

    const ingested = await ingestUserMessage(target, message, runtime, { commit: false });

    expect(ingested.historyEntry.leaderTimerMessageId).toBe("f7");
    expect(buildUserMessageDeliveryPrefix(target, ingested, message, deliveryContent, runtime)).toBe("");
    expect(message.deliveryContent).toBe(deliveryContent);
  });

  it("keeps legacy and readable references with the same ordinal as distinct queued owners", async () => {
    // Retained identity uses the exact string, while allocation reserves ordinals
    // across both formats. Re-admitting an older held input must not alias it.
    const target = session();
    const runtime = deps();
    const readable = await ingestUserMessage(target, firing, runtime, { commit: false });
    target.pendingCodexInputs.push({
      id: "readable-input",
      content: firing.content,
      timestamp: readable.timestamp,
      cancelable: true,
      leaderTimerMessageId: readable.historyEntry.leaderTimerMessageId,
    });
    const legacy = JSON.parse(
      JSON.stringify({
        ...firing,
        deliveryContent: "[Timer reminder earlier id:f1] [thread:q-42] " + firing.content,
        timerFiring: { ...firing.timerFiring, messageId: "f1" },
      }),
    );
    target.state.pause = {
      pausedAt: 1,
      queuedMessages: [{ id: "legacy-held", queuedAt: 2, source: "programmatic", message: legacy }],
    };
    const legacyBefore = structuredClone(legacy);

    const retained = await ingestUserMessage(target, legacy, runtime, { commit: false });
    const next = await ingestUserMessage(target, firing, runtime, { commit: false });

    expect(readable.historyEntry.leaderTimerMessageId).toBe("timer-m1");
    expect(retained.historyEntry.leaderTimerMessageId).toBe("f1");
    expect(buildUserMessageDeliveryPrefix(target, retained, legacy, legacy.deliveryContent, runtime)).toBe("");
    expect(next.historyEntry.leaderTimerMessageId).toBe("timer-m2");
    expect(target.state.pause.queuedMessages[0].message).toEqual(legacyBefore);
    expect(target.messageHistory).toEqual([]);
  });

  it("keeps the firing reference in a wrapped timer's model envelope without rewriting raw content", async () => {
    // Materialized auto-pause groups retain their existing wrapper and one
    // representative; the wrapper must not downgrade a genuine firing to an event.
    const target = session();
    const runtime = deps();
    const message = {
      ...firing,
      content:
        "[Takode auto-pause resumed: 2 similar automatic inputs were coalesced while delivery was paused.]\n\n" +
        firing.content,
    };
    const ingested = await ingestUserMessage(target, message, runtime);

    expect(ingested.historyEntry.content).toBe(message.content);
    expect(ingested.historyEntry.leaderTimerMessageId).toBe("timer-m1");
    expect(buildUserMessageDeliveryPrefix(target, ingested, message, message.content, runtime)).toMatch(
      /id:timer-m1\]/,
    );
  });

  it.each([
    "committed",
    "pending",
    "malformed ID",
    "malformed provenance",
  ])("rejects retained identity with %s evidence before mutation", async (kind) => {
    const target = session();
    const runtime = deps();
    if (kind === "committed") await ingestUserMessage(target, firing, runtime);
    if (kind === "pending")
      target.pendingCodexInputs.push({
        id: "prior-input",
        content: firing.content,
        timestamp: 1,
        cancelable: true,
        leaderTimerMessageId: "timer-m1",
      });
    const message = {
      ...firing,
      deliveryContent: "[Timer reminder earlier id:timer-m1] " + firing.content,
      timerFiring: {
        ...firing.timerFiring,
        messageId: kind === "malformed ID" ? "u1" : "timer-m1",
        ...(kind === "malformed provenance" ? { scheduledFireAt: -1 } : {}),
      },
    };
    const historyBefore = structuredClone(target.messageHistory);
    const pendingBefore = structuredClone(target.pendingCodexInputs);

    expect(() => ingestUserMessage(target, message, runtime)).toThrow(/Retained timer firing/);
    expect(target.messageHistory).toEqual(historyBefore);
    expect(target.pendingCodexInputs).toEqual(pendingBefore);
  });

  it.each([
    { name: "unproven injected reminder", message: { ...firing, timerFiring: undefined } },
    { name: "cancellation", message: { ...firing, content: "[⏰ Timer t4 cancelled] Daily report" } },
    { name: "different source", message: { ...firing, agentSource: { sessionId: "timer:t5" } } },
    { name: "invalid schedule", message: { ...firing, timerFiring: { timerId: "t4", scheduledFireAt: NaN } } },
  ])("does not assign answer authority to $name", async ({ message }) => {
    const ingested = await ingestUserMessage(session(), message, deps());
    expect(ingested.historyEntry).not.toHaveProperty("leaderTimerMessageId");
  });

  it("keeps worker timer delivery outside the leader answer contract", async () => {
    const runtime = deps();
    vi.mocked(runtime.getLauncherSessionInfo).mockReturnValue({ isOrchestrator: false } as any);
    const ingested = await ingestUserMessage(session(), firing, runtime);
    expect(ingested.historyEntry).not.toHaveProperty("leaderTimerMessageId");
  });
});

function session(): AdapterBrowserRoutingSessionLike {
  return {
    id: "leader",
    backendType: "claude-sdk",
    state: {
      session_id: "leader",
      cwd: "/tmp",
      backend_state: "connected",
      leaderThreadStatuses: {
        "q-42": {
          kind: "ready",
          label: "Thread Ready",
          threadKey: "q-42",
          questId: "q-42",
          summary: "previous request complete",
          messageId: "old-ready",
          timestamp: 1,
          updatedAt: 1,
        },
      },
    } as unknown as AdapterBrowserRoutingSessionLike["state"],
    messageHistory: [],
    notifications: [],
    pendingPermissions: new Map(),
    evaluatingAborts: new Map(),
    pendingMessages: [],
    pendingCodexTurns: [],
    pendingCodexInputs: [],
    forceCompactPending: false,
    isGenerating: false,
    lastUserMessageDateTag: "",
    lastOutboundUserNdjson: null,
    consecutiveAdapterFailures: 0,
    codexAdapter: null,
    claudeSdkAdapter: null,
  };
}

function deps() {
  return {
    getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: true })),
    nextUserMessageId: vi.fn(() => "user-q42"),
    promoteLeaderThreadTabForMessageAttention: vi.fn(),
    touchUserMessage: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    refreshBrowserConversationViews: vi.fn(),
    invalidateLeaderThreadTabsForSession: vi.fn(() => true),
    emitTakodeEvent: vi.fn(),
  } as unknown as AdapterBrowserRoutingDeps;
}

describe("leader direct-user response cutover ingestion", () => {
  it("marks committed human input, clears stale Ready, and refreshes selected windows", () => {
    const target = session();
    const runtime = deps();
    const message: Extract<BrowserOutgoingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: "Please revise the result.",
      threadKey: "q-42",
    };

    const ingested = ingestUserMessage(target, message, runtime);

    expect(ingested).not.toBeInstanceOf(Promise);
    expect(target.messageHistory[0]).toMatchObject({
      type: "user_message",
      id: "user-q42",
      threadKey: "q-42",
      questId: "q-42",
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    });
    expect(target.state.leaderThreadStatuses?.["q-42"]).toBeUndefined();
    expect(runtime.broadcastToBrowsers).toHaveBeenCalledWith(target, target.messageHistory[0]);
    expect(runtime.refreshBrowserConversationViews).toHaveBeenCalledWith(target);
    expect(runtime.invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(target.id);
  });

  it("invalidates Ready when Codex accepts the human input before history commit", () => {
    const target = session();
    target.backendType = "codex";
    const runtime = deps();
    const message: Extract<BrowserOutgoingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: "Queue this request.",
      threadKey: "q-42",
    };

    const ingested = ingestUserMessage(target, message, runtime, { commit: false });

    expect(ingested).not.toBeInstanceOf(Promise);
    expect(target.messageHistory).toEqual([]);
    expect((ingested as Exclude<typeof ingested, Promise<unknown>>).historyEntry).toMatchObject({
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    });
    expect(target.state.leaderThreadStatuses?.["q-42"]).toBeUndefined();
    expect(runtime.refreshBrowserConversationViews).not.toHaveBeenCalled();
    expect(runtime.invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(target.id);
  });

  it("does not mark or invalidate system-authored user-shaped input", () => {
    const target = session();
    const runtime = deps();
    const message: Extract<BrowserOutgoingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: "Internal reminder",
      threadKey: "q-42",
      agentSource: { sessionId: "system:reminder", sessionLabel: "Reminder" },
    };

    ingestUserMessage(target, message, runtime);

    expect(target.messageHistory[0]).not.toHaveProperty("leaderResponseCoverageVersion");
    expect(target.messageHistory[0]).not.toHaveProperty("leaderUserMessageId");
    expect(target.state.leaderThreadStatuses?.["q-42"]?.kind).toBe("ready");
    expect(runtime.refreshBrowserConversationViews).not.toHaveBeenCalled();
    expect(runtime.invalidateLeaderThreadTabsForSession).not.toHaveBeenCalled();
  });
  it("fails closed when an outcome-reminder source lacks its structured guard", async () => {
    const target = session();
    const runtime = deps();
    const historyLength = target.messageHistory.length;

    const accepted = await routeBrowserMessage(
      target as AdapterBrowserRoutingSessionLike &
        import("./browser-transport-controller.js").BrowserTransportSessionLike,
      {
        type: "user_message",
        content: "unguarded reminder",
        agentSource: { sessionId: THREAD_RESPONSE_REMINDER_SOURCE_ID, sessionLabel: "Thread Outcome Reminder" },
        threadKey: "main",
      },
      undefined,
      runtime,
    );

    expect(accepted).toBe(false);
    expect(target.messageHistory).toHaveLength(historyLength);
    expect(target.pendingCodexInputs).toEqual([]);
  });

  it("drops a stale persisted outcome reminder before user-history or pending-input ingestion", async () => {
    const target = session();
    const runtime = deps();
    const direct = {
      type: "user_message",
      id: "direct-u1",
      content: "Please answer this.",
      timestamp: 10,
      threadKey: "main",
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u1",
    } satisfies BrowserIncomingMessage;
    const answer = {
      type: "assistant",
      message: {
        id: "answer-u1",
        type: "message",
        role: "assistant",
        model: "test",
        content: [{ type: "text", text: "The answer is complete." }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: 20,
      threadKey: "main",
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
      leaderAnswerObservedHistoryLength: 1,
    } satisfies BrowserIncomingMessage;
    target.messageHistory.push(direct, answer);
    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({ finalized: true });
    target.state.leaderThreadStatuses!.main = {
      kind: "ready",
      label: "Thread Ready",
      threadKey: "main",
      summary: "answer complete",
      messageId: "answer-u1",
      timestamp: 20,
      updatedAt: 20,
    };
    const historyLength = target.messageHistory.length;

    const accepted = await routeBrowserMessage(
      target as AdapterBrowserRoutingSessionLike &
        import("./browser-transport-controller.js").BrowserTransportSessionLike,
      {
        type: "user_message",
        content: "stale answer reminder",
        agentSource: { sessionId: THREAD_RESPONSE_REMINDER_SOURCE_ID, sessionLabel: "Thread Outcome Reminder" },
        threadKey: "main",
        leaderThreadOutcomeReminderGuard: {
          version: 1,
          pendingResponseTargets: [
            {
              threadKey: "main",
              earliestTimestamp: 10,
              pendingAnswerCount: 1,
              pendingAnswerUserMessageIds: ["u1"],
            },
          ],
          missingOutcomeTargets: [],
          missingNeedsInputTargets: [],
        },
      },
      undefined,
      runtime,
    );

    expect(accepted).toBe(false);
    expect(target.messageHistory).toHaveLength(historyLength);
    expect(target.pendingCodexInputs).toEqual([]);
  });
});
