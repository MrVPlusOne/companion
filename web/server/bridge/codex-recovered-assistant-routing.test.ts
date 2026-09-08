import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../session-types.js";
import {
  findMatchingRecoveredCodexAssistantReplay,
  recoverAgentMessagesFromResumedTurn,
} from "./codex-recovered-assistant-routing.js";
import { buildLeaderThreadResponseState, leaderThreadResponseContentHash } from "../leader-thread-response.js";

describe("Codex recovered assistant routing", () => {
  it("recovers the routed owner from a generic replay match without duplicating the assistant row", () => {
    // The retained incident already had the partial leader response in browser
    // history, while Codex resumed it under a generic item-N id. The replay
    // match must carry the existing route forward so recovery can replace the
    // unowned red error with one routed actionable diagnostic.
    const existing: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: "live-partial",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "I am reading the screenshot first." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 100,
      threadKey: "main",
    };
    const session = {
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [existing],
    };
    const resumedText = "[thread:main:C] I am reading the screenshot first.";

    expect(findMatchingRecoveredCodexAssistantReplay(session, resumedText, 10)).toEqual([existing]);

    const broadcastToBrowsers = vi.fn();
    const result = recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-interrupted",
        status: "interrupted",
        error: null,
        items: [{ type: "agentMessage", id: "item-1", text: resumedText }],
      },
      { disconnectedAt: 200, historyIndex: -1 },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
    );

    expect(result).toEqual({ count: 1, latestLeaderRoute: { threadKey: "main" } });
    expect(session.messageHistory).toEqual([existing]);
    expect(broadcastToBrowsers).not.toHaveBeenCalled();
  });

  it("does not use an identical pre-owner assistant as routed recovery evidence", () => {
    // Once a replay match controls whether the generic browser error is
    // suppressed, matches must stay inside the pending owner's history range.
    const priorAssistant: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: "prior-assistant",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Repeated status text." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 10,
      threadKey: "q-old",
      questId: "q-old",
    };
    const currentUser: BrowserIncomingMessage = {
      type: "user_message",
      id: "current-user",
      content: "new request",
      timestamp: 20,
      threadKey: "main",
    };
    const session = {
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [priorAssistant, currentUser],
    };

    expect(findMatchingRecoveredCodexAssistantReplay(session, "Repeated status text.", 10, 1)).toBeNull();

    const broadcastToBrowsers = vi.fn();
    const result = recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-current",
        status: "interrupted",
        error: null,
        items: [{ type: "agentMessage", id: "item-1", text: "Repeated status text." }],
      },
      { disconnectedAt: 30, historyIndex: 1 },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
    );

    expect(result.latestLeaderRoute).toBeNull();
    expect(session.messageHistory).toHaveLength(3);
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
  });

  it("does not let a reused generic item id bypass owner-bounded matching", () => {
    const priorAssistant: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: "codex-agent-item-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Old partial response." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 10,
      threadKey: "q-old",
      questId: "q-old",
    };
    const session = {
      state: { isOrchestrator: true, model: "gpt-5.6-sol" },
      messageHistory: [
        priorAssistant,
        { type: "user_message" as const, id: "current-user", content: "new request", timestamp: 20 },
      ],
    };
    const broadcastToBrowsers = vi.fn();

    const result = recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-current",
        status: "interrupted",
        error: null,
        items: [{ type: "agentMessage", id: "item-1", text: "[thread:main:C] Genuinely new partial." }],
      },
      { disconnectedAt: 30, historyIndex: 1 },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
    );

    expect(result).toEqual({ count: 1, latestLeaderRoute: { threadKey: "main" } });
    expect(session.messageHistory).toHaveLength(3);
    expect(session.messageHistory[2]).toMatchObject({
      type: "assistant",
      message: { id: "codex-agent-turn-current-item-1" },
      threadKey: "main",
    });
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
  });

  it("applies the owner bound to a hot tail with a frozen absolute offset", () => {
    const oldAssistant: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: "old",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Repeated status text." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      threadKey: "q-old",
      questId: "q-old",
    };
    const currentAssistant: BrowserIncomingMessage = {
      ...oldAssistant,
      message: { ...oldAssistant.message, id: "current" },
      threadKey: "main",
      questId: undefined,
    };
    const session = {
      state: { isOrchestrator: true, model: "gpt-5.6-sol" },
      _frozenCount: 50,
      messageHistory: [
        oldAssistant,
        { type: "user_message" as const, id: "current-user", content: "new request", timestamp: 20 },
        currentAssistant,
      ],
    };

    expect(findMatchingRecoveredCodexAssistantReplay(session, "[thread:main:C] Repeated status text.", 10, 51)).toEqual(
      [currentAssistant],
    );
  });
});

describe("Codex recovered routed answers", () => {
  function pendingHuman(): Extract<BrowserIncomingMessage, { type: "user_message" }> {
    return {
      type: "user_message",
      id: "current-user",
      leaderUserMessageId: "u1",
      content: "Please finish the answer.",
      timestamp: 20,
      threadKey: "main",
      leaderResponseCoverageVersion: 1,
    };
  }

  function legacyBatchId(sessionId: string): string {
    const encoded = Buffer.from(JSON.stringify({ v: 1, t: "main", h: 1, ids: ["current-user"] })).toString("base64url");
    const checksum = leaderThreadResponseContentHash(`${sessionId}\n${encoded}`).slice(0, 24);
    return `response-batch-v1.${encoded}.${checksum}`;
  }

  function persistedLegacyAssistant(
    sessionId: string,
    text = "Persisted legacy answer.",
    messageId = "persisted-legacy-response",
  ): Extract<BrowserIncomingMessage, { type: "assistant" }> {
    return {
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 25,
      threadKey: "main",
      leaderThreadRole: "response",
      threadResponse: {
        logicalResponseId: "legacy-response",
        revisionId: "legacy-response-r1",
        revisionNumber: 1,
        batchId: legacyBatchId(sessionId),
        batchObservedHistoryLength: 1,
        coveredUserMessageIds: ["current-user"],
        contentHash: leaderThreadResponseContentHash(text),
      },
    };
  }

  it("finalizes a completed recovered answer against the exact pending owner", () => {
    const session = {
      id: "leader-recovered",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman()] as BrowserIncomingMessage[],
    };
    const broadcastToBrowsers = vi.fn();
    const refreshBrowserConversationViews = vi.fn();
    const invalidateLeaderThreadTabsForSession = vi.fn();

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-completed",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "final-item",
            text: "[thread:main:A:u1] Completed recovered answer.\n{[(Thread Ready: main | recovered answer complete)]}",
          },
        ],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      {
        codexAssistantReplayScanLimit: 10,
        broadcastToBrowsers,
        refreshBrowserConversationViews,
        invalidateLeaderThreadTabsForSession,
      },
    );

    const response = session.messageHistory.find(
      (message): message is Extract<BrowserIncomingMessage, { type: "assistant" }> => message.type === "assistant",
    )!;
    expect(response).toMatchObject({
      leaderThreadRole: "answer",
      threadAnswer: { version: 2, answerUserMessageIds: ["u1"], observedHistoryLength: 1 },
    });
    expect(response.leaderAnswerObservedHistoryLength).toBeUndefined();
    expect(session.state.leaderThreadStatuses?.main).toMatchObject({ kind: "ready", messageId: response.message.id });
    expect(refreshBrowserConversationViews).toHaveBeenCalledWith(session);
    expect(invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(session.id);
  });

  it("canonicalizes a completed recovered answer to one shared owner without replaying prose", () => {
    // Recovery runs the same finalizer as a live result. Preserve one recovered
    // row while changing only answer authority from q-2044 to q-2042.
    const first = pendingHuman();
    first.id = "owner-user-1";
    first.leaderUserMessageId = "u1";
    first.threadKey = "q-2042";
    first.questId = "q-2042";
    first.threadRefs = [
      { threadKey: "q-2042", questId: "q-2042", source: "explicit", attachedAt: 20 },
      { threadKey: "q-2044", questId: "q-2044", source: "backfill", attachedAt: 21 },
    ];
    const second = pendingHuman();
    second.id = "owner-user-2";
    second.leaderUserMessageId = "u2";
    second.timestamp = 22;
    second.threadKey = "q-2042";
    second.questId = "q-2042";
    second.threadRefs = [
      { threadKey: "q-2042", questId: "q-2042", source: "explicit", attachedAt: 22 },
      { threadKey: "q-2044", questId: "q-2044", source: "backfill", attachedAt: 23 },
    ];
    const session = {
      id: "leader-recovered-canonical",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [first, second] as BrowserIncomingMessage[],
    };
    const broadcastToBrowsers = vi.fn();
    const refreshBrowserConversationViews = vi.fn();
    const invalidateLeaderThreadTabsForSession = vi.fn();

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-canonical",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "canonical-item",
            text: "[thread:q-2044:A:u1,u2] The approved implementation is complete.",
          },
        ],
      },
      {
        disconnectedAt: 30,
        historyIndex: 0,
        userMessageId: "owner-user-1",
        pendingInputIds: ["owner-user-1", "owner-user-2"],
        historyIncorporation: {
          inputIds: ["owner-user-1", "owner-user-2"],
          historyIndexes: [0, 1],
        } as any,
      },
      {
        codexAssistantReplayScanLimit: 10,
        broadcastToBrowsers,
        refreshBrowserConversationViews,
        invalidateLeaderThreadTabsForSession,
      },
    );

    const response = session.messageHistory[2] as Extract<BrowserIncomingMessage, { type: "assistant" }>;
    expect(response).toMatchObject({
      message: { id: "codex-agent-canonical-item" },
      threadKey: "q-2042",
      questId: "q-2042",
      threadRefs: [
        { threadKey: "q-2042", questId: "q-2042", source: "explicit" },
        { threadKey: "q-2044", questId: "q-2044", source: "backfill" },
      ],
      threadAnswer: { version: 2, answerUserMessageIds: ["u1", "u2"], observedHistoryLength: 2 },
    });
    expect(response.threadRoutingError).toBeUndefined();
    expect(response.leaderAnswerUserMessageIds).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "q-2042").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, "q-2044").projection.currentAnswers).toMatchObject([
      { currentMessageId: response.message.id, threadKey: "q-2042" },
    ]);
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(2);
    expect(refreshBrowserConversationViews).toHaveBeenCalledWith(session);
    expect(invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(session.id);
  });

  it("rejects recovered sibling Ready on a canonicalized display-only thread", () => {
    const request = pendingHuman();
    request.id = "owner-user";
    request.threadKey = "q-2042";
    request.questId = "q-2042";
    request.threadRefs = [
      { threadKey: "q-2042", questId: "q-2042", source: "explicit", attachedAt: 20 },
      { threadKey: "q-2044", questId: "q-2044", source: "backfill", attachedAt: 21 },
    ];
    const session = {
      id: "leader-recovered-display-ready",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [request] as BrowserIncomingMessage[],
      pendingLeaderRejectedReadyThreadKeys: [] as string[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-display-ready",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "display-ready-item",
            text: "[thread:q-2044:C] Work complete.\n{[(Thread Ready: q-2044 | display complete)]}",
          },
          {
            type: "agentMessage",
            id: "canonical-answer-item",
            text: "[thread:q-2044:A:u1] The requested implementation is complete.",
          },
        ],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "owner-user" },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    const answer = session.messageHistory.find(
      (message): message is Extract<BrowserIncomingMessage, { type: "assistant" }> =>
        message.type === "assistant" && message.leaderThreadRole === "answer",
    )!;
    expect(answer).toMatchObject({
      threadKey: "q-2042",
      threadAnswer: { answerUserMessageIds: ["u1"] },
    });
    expect(session.state.leaderThreadStatuses["q-2044"]).toBeUndefined();
    expect(session.pendingLeaderRejectedReadyThreadKeys).toEqual(["q-2044"]);
  });

  it("allows recovered sibling Ready when the selected thread owns current coverage in the same turn", () => {
    const associated = pendingHuman();
    associated.id = "associated-user";
    associated.threadKey = "q-1";
    associated.questId = "q-1";
    associated.threadRefs = [
      { threadKey: "q-1", questId: "q-1", source: "explicit", attachedAt: 20 },
      { threadKey: "q-2", questId: "q-2", source: "backfill", attachedAt: 21 },
    ];
    const owned = pendingHuman();
    owned.id = "owned-user";
    owned.leaderUserMessageId = "u2";
    owned.timestamp = 22;
    owned.threadKey = "q-2";
    owned.questId = "q-2";
    owned.threadRefs = [{ threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 22 }];
    const session = {
      id: "leader-recovered-owner-ready",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [associated, owned] as BrowserIncomingMessage[],
      pendingLeaderRejectedReadyThreadKeys: [] as string[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-owner-ready",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "owner-ready-item",
            text: "[thread:q-2:C] Both requests are complete.\n{[(Thread Ready: q-2 | owner complete)]}",
          },
          {
            type: "agentMessage",
            id: "associated-answer-item",
            text: "[thread:q-2:A:u1] The associated request is complete.",
          },
          {
            type: "agentMessage",
            id: "owned-answer-item",
            text: "[thread:q-2:A:u2] The owned request is complete.",
          },
        ],
      },
      {
        disconnectedAt: 30,
        historyIndex: 0,
        userMessageId: "associated-user",
        pendingInputIds: ["associated-user", "owned-user"],
        historyIncorporation: {
          inputIds: ["associated-user", "owned-user"],
          historyIndexes: [0, 1],
        } as any,
      },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    expect(session.state.leaderThreadStatuses["q-2"]).toMatchObject({ kind: "ready" });
    expect(session.pendingLeaderRejectedReadyThreadKeys).toEqual([]);
    expect(buildLeaderThreadResponseState(session, "q-1").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, "q-2").projection.pendingMessageCount).toBe(0);
  });

  it("keeps superseded recovered answers visible without granting display-only Main Ready", () => {
    // Recovery finalizes both answers before sibling statuses. The later quest
    // answer owns coverage, while the first answer still proves Main visibility.
    const request = pendingHuman();
    request.threadKey = "q-42";
    request.questId = "q-42";
    request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "explicit", attachedAt: 20 }];
    const session = {
      id: "leader-recovered-superseded",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [request] as BrowserIncomingMessage[],
      pendingLeaderRejectedReadyThreadKeys: [] as string[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-superseded",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "main-ready",
            text: "[thread:main:C] Complete.\n{[(Thread Ready: main | complete)]}",
          },
          {
            type: "agentMessage",
            id: "quest-ready",
            text: "[thread:q-42:C] Complete.\n{[(Thread Ready: q-42 | complete)]}",
          },
          { type: "agentMessage", id: "main-answer", text: "[thread:main:A:u1] The requested change is implemented." },
          {
            type: "agentMessage",
            id: "quest-answer",
            text: "[thread:q-42:A:u1] The requested change is now synchronized too.",
          },
        ],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    expect(buildLeaderThreadResponseState(session, "main").projection.currentAnswers).toMatchObject([
      { currentMessageId: "codex-agent-main-answer", coveredAnswerUserMessageIds: [] },
    ]);
    expect(buildLeaderThreadResponseState(session, "q-42").projection.currentAnswers).toMatchObject([
      { currentMessageId: "codex-agent-main-answer", coveredAnswerUserMessageIds: [] },
      { currentMessageId: "codex-agent-quest-answer", coveredAnswerUserMessageIds: ["u1"] },
    ]);
    expect(session.state.leaderThreadStatuses.main).toBeUndefined();
    expect(session.state.leaderThreadStatuses["q-42"]).toMatchObject({ kind: "ready" });
    expect(session.pendingLeaderRejectedReadyThreadKeys).toEqual(["main"]);
  });

  it.each([
    "main",
    "q-2044",
  ])("accepts a recovered answer authored from %s without a prior association", (authoredThreadKey) => {
    // The authoring tab no longer needs a pre-existing association with every
    // prompt. Recovery must retain one answer and prove the request's own owner.
    const request = pendingHuman();
    request.threadKey = "q-2042";
    request.questId = "q-2042";
    request.threadRefs = [{ threadKey: "q-2042", questId: "q-2042", source: "explicit", attachedAt: 20 }];
    const session = {
      id: "leader-recovered-associated",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [request] as BrowserIncomingMessage[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-associated",
        status: "completed",
        error: null,
        items: [
          { type: "agentMessage", id: "associated-item", text: `[thread:${authoredThreadKey}:A:u1] Completed answer.` },
        ],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    const response = session.messageHistory[1] as Extract<BrowserIncomingMessage, { type: "assistant" }>;
    expect(response.threadAnswer).toMatchObject({
      version: 2,
      answerUserMessageIds: ["u1"],
      observedHistoryLength: 1,
      authoredThreadKey,
      ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1"] }],
    });
    expect(response.leaderAnswerUserMessageIds).toBeUndefined();
    expect(response.threadRoutingError).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "q-2042").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, authoredThreadKey).projection.currentAnswers).toMatchObject([
      { currentMessageId: response.message.id, coveredAnswerUserMessageIds: [] },
    ]);
  });

  it.each([
    "main",
    "q-8",
  ])("recovers one mixed-owner answer authored from %s and replays its snapshot once", (authoredThreadKey) => {
    // A completed provider snapshot contains earlier sibling status segments,
    // one nonconsecutive mixed-owner answer, and an unrelated pending request.
    const questRequest = pendingHuman();
    questRequest.id = "quest-user";
    questRequest.threadKey = "q-1";
    questRequest.questId = "q-1";
    questRequest.threadRefs = [
      { threadKey: "q-1", questId: "q-1", source: "explicit", attachedAt: 20 },
      { threadKey: "q-8", questId: "q-8", source: "backfill", attachedAt: 21 },
    ];
    const unrelated = pendingHuman();
    unrelated.id = "unrelated-user";
    unrelated.leaderUserMessageId = "u2";
    unrelated.timestamp = 22;
    unrelated.threadKey = "q-9";
    unrelated.questId = "q-9";
    unrelated.threadRefs = [{ threadKey: "q-9", questId: "q-9", source: "explicit", attachedAt: 22 }];
    const mainRequest = pendingHuman();
    mainRequest.id = "main-user";
    mainRequest.leaderUserMessageId = "u3";
    mainRequest.timestamp = 23;
    const session = {
      id: "leader-recovered-mixed",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [questRequest, unrelated, mainRequest] as BrowserIncomingMessage[],
      pendingLeaderRejectedReadyThreadKeys: [] as string[],
    };
    const turn = {
      id: "turn-mixed",
      status: "completed" as const,
      error: null,
      items: [
        ...["q-1", "main", "q-8"].map((threadKey, index) => ({
          type: "agentMessage" as const,
          id: `item-${index + 1}`,
          text: `[thread:${threadKey}:C] The answered requests are complete.\n{[(Thread Ready: ${threadKey} | requests complete)]}`,
        })),
        {
          type: "agentMessage" as const,
          id: "item-4",
          text: `[thread:${authoredThreadKey}:A:u1,u3] Both requested changes are implemented.`,
        },
      ],
    };
    const pending = {
      disconnectedAt: 30,
      historyIndex: 0,
      userMessageId: "quest-user",
      pendingInputIds: ["quest-user", "unrelated-user", "main-user"],
      historyIncorporation: {
        inputIds: ["quest-user", "unrelated-user", "main-user"],
        historyIndexes: [0, 1, 2],
      } as any,
    };
    const deps = {
      codexAssistantReplayScanLimit: 10,
      broadcastToBrowsers: vi.fn(),
      refreshBrowserConversationViews: vi.fn(),
      invalidateLeaderThreadTabsForSession: vi.fn(),
    };

    recoverAgentMessagesFromResumedTurn(session, turn, pending, deps);

    const answer = session.messageHistory.find(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> =>
        entry.type === "assistant" && !!entry.threadAnswer,
    )!;
    expect(answer).toMatchObject({
      message: {
        id: "codex-agent-turn-mixed-item-4",
        content: [{ type: "text", text: "Both requested changes are implemented." }],
      },
      threadKey: "main",
      threadAnswer: {
        answerUserMessageIds: ["u1", "u3"],
        authoredThreadKey,
        ownerGroups: [
          { threadKey: "q-1", userMessageIds: ["u1"] },
          { threadKey: "main", userMessageIds: ["u3"] },
        ],
      },
    });
    expect(answer.threadRoutingError).toBeUndefined();
    expect(session.state.leaderThreadStatuses["q-1"]).toMatchObject({ kind: "ready" });
    expect(session.state.leaderThreadStatuses.main).toMatchObject({ kind: "ready" });
    expect(session.state.leaderThreadStatuses["q-8"]).toBeUndefined();
    expect(session.pendingLeaderRejectedReadyThreadKeys).toEqual(["q-8"]);
    for (const [threadKey, coveredIds] of [
      ["q-1", ["u1"]],
      ["main", ["u3"]],
      ["q-8", []],
    ] as const) {
      expect(buildLeaderThreadResponseState(session, threadKey).projection.currentAnswers).toMatchObject([
        { currentMessageId: answer.message.id, coveredAnswerUserMessageIds: coveredIds },
      ]);
    }
    expect(buildLeaderThreadResponseState(session, "q-9").projection.pendingMessages).toMatchObject([
      { userMessageId: "u2" },
    ]);

    // Persisted authority and the authored route must identify the same row
    // when the provider repeats the original snapshot after restart.
    const restored = JSON.parse(JSON.stringify(session)) as typeof session;
    const persistedHistory = JSON.parse(JSON.stringify(restored.messageHistory));
    deps.broadcastToBrowsers.mockClear();
    deps.refreshBrowserConversationViews.mockClear();
    deps.invalidateLeaderThreadTabsForSession.mockClear();
    recoverAgentMessagesFromResumedTurn(restored, turn, pending, deps);

    expect(restored.messageHistory).toEqual(persistedHistory);
    expect(restored.messageHistory.filter((entry) => entry.type === "assistant" && entry.threadAnswer)).toHaveLength(1);
    expect(restored.pendingLeaderRejectedReadyThreadKeys).toEqual(["q-8"]);
    // A rejected sibling status may be reconsidered, but it cannot rebroadcast
    // the settled answer, alter coverage, or add a second source row.
    expect(deps.broadcastToBrowsers.mock.calls.some(([, entry]) => entry.threadAnswer)).toBe(false);
    expect(deps.invalidateLeaderThreadTabsForSession).not.toHaveBeenCalled();
  });

  it("restores completed replay-matched answer controls exactly once after retry cleanup", () => {
    const response: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
      type: "assistant",
      message: {
        id: "retained-partial-final",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Recovered final answer." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 25,
      threadKey: "main",
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
    };
    const session = {
      id: "leader-replay-match",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman(), response] as BrowserIncomingMessage[],
    };
    const turn = {
      id: "turn-completed-replay",
      status: "completed" as const,
      error: null,
      items: [
        {
          type: "agentMessage" as const,
          id: "item-1",
          text: "[thread:main:A:u1] Recovered final answer.\n{[(Thread Ready: main | recovered replay complete)]}",
        },
      ],
    };
    const broadcastToBrowsers = vi.fn();
    const refreshBrowserConversationViews = vi.fn();
    const invalidateLeaderThreadTabsForSession = vi.fn();
    const deps = {
      codexAssistantReplayScanLimit: 10,
      broadcastToBrowsers,
      refreshBrowserConversationViews,
      invalidateLeaderThreadTabsForSession,
    };

    expect(
      recoverAgentMessagesFromResumedTurn(
        session,
        turn,
        { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
        deps,
      ),
    ).toEqual({ count: 1, latestLeaderRoute: { threadKey: "main" } });

    expect(session.messageHistory).toHaveLength(2);
    expect(response).toMatchObject({
      leaderThreadRole: "answer",
      threadAnswer: { version: 2, answerUserMessageIds: ["u1"], observedHistoryLength: 1 },
      threadStatusMarkers: [expect.objectContaining({ kind: "ready", messageId: response.message.id })],
    });
    expect(response.leaderAnswerObservedHistoryLength).toBeUndefined();
    expect(response.deferredThreadStatusMarkers).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "main").projection.ready).toBe(true);
    expect(session.state.leaderThreadStatuses.main).toMatchObject({
      kind: "ready",
      messageId: response.message.id,
    });
    expect(invalidateLeaderThreadTabsForSession).toHaveBeenCalledTimes(1);
    expect(refreshBrowserConversationViews).toHaveBeenCalledTimes(1);
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);

    invalidateLeaderThreadTabsForSession.mockClear();
    refreshBrowserConversationViews.mockClear();
    broadcastToBrowsers.mockClear();
    recoverAgentMessagesFromResumedTurn(
      session,
      turn,
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      deps,
    );

    expect(session.messageHistory).toHaveLength(2);
    expect(invalidateLeaderThreadTabsForSession).not.toHaveBeenCalled();
    expect(refreshBrowserConversationViews).not.toHaveBeenCalled();
    expect(broadcastToBrowsers).not.toHaveBeenCalled();
  });

  it("matches recovery only after the latest exact member of a merged owner batch", () => {
    const first = pendingHuman();
    first.id = "merged-user-1";
    first.leaderUserMessageId = "u1";
    const second = pendingHuman();
    second.id = "merged-user-2";
    second.leaderUserMessageId = "u2";
    second.timestamp = 30;
    const unrelated: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
      type: "assistant",
      message: {
        id: "unrelated-between-owners",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Shared final wording." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 25,
      threadKey: "main",
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1", "u2"],
    };
    const session = {
      id: "leader-merged-owner",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [first, unrelated, second] as BrowserIncomingMessage[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-merged-owner",
        status: "completed",
        error: null,
        items: [{ type: "agentMessage", id: "item-1", text: "[thread:main:A:u1,u2] Shared final wording." }],
      },
      {
        disconnectedAt: 40,
        historyIndex: 0,
        userMessageId: "merged-user-1",
        pendingInputIds: ["merged-user-1", "merged-user-2"],
        historyIncorporation: {
          inputIds: ["merged-user-1", "merged-user-2"],
          historyIndexes: [0, 2],
        } as any,
      },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    const responses = session.messageHistory.filter(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> => entry.type === "assistant",
    );
    expect(responses).toHaveLength(2);
    expect(unrelated.threadAnswer).toBeUndefined();
    expect(responses[1]).toMatchObject({
      message: { id: "codex-agent-turn-merged-owner-item-1" },
      threadAnswer: { version: 2, answerUserMessageIds: ["u1", "u2"], observedHistoryLength: 3 },
    });
  });

  it("does not restore Ready when a completed replay match lacks exact response observation proof", () => {
    const response: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
      type: "assistant",
      message: {
        id: "unproven-replay-final",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Unproven recovered answer." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 25,
      threadKey: "main",
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
    };
    const session = {
      id: "leader-unproven-replay",
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman(), response] as BrowserIncomingMessage[],
      pendingLeaderRejectedReadyThreadKeys: [] as string[],
    };
    const invalidateLeaderThreadTabsForSession = vi.fn();

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-unproven-replay",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "item-1",
            text: "[thread:main:A:u1] Unproven recovered answer.\n{[(Thread Ready: main | should be rejected)]}",
          },
        ],
      },
      { disconnectedAt: 30, historyIndex: -1 },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn(), invalidateLeaderThreadTabsForSession },
    );

    expect(response.threadAnswer).toBeUndefined();
    expect(response.threadStatusMarkers).toBeUndefined();
    expect(session.state.leaderThreadStatuses.main).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "main").projection.pendingMessageCount).toBe(1);
    // Historical replay must not inject a fresh reminder turn. Preserve the
    // rejection so the next normal outcome-validation boundary can do so.
    expect(session.pendingLeaderRejectedReadyThreadKeys).toEqual(["main"]);
    expect(invalidateLeaderThreadTabsForSession).not.toHaveBeenCalled();
  });

  it("keeps an interrupted recovered answer non-authoritative", () => {
    const session = {
      id: "leader-interrupted",
      state: { isOrchestrator: true, model: "gpt-5.6-sol" },
      messageHistory: [pendingHuman()] as BrowserIncomingMessage[],
    };

    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-interrupted",
        status: "interrupted",
        error: null,
        items: [{ type: "agentMessage", id: "partial-item", text: "[thread:main:A:u1] Partial recovered answer." }],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers: vi.fn() },
    );

    const response = session.messageHistory.find(
      (message): message is Extract<BrowserIncomingMessage, { type: "assistant" }> => message.type === "assistant",
    )!;
    expect(response.leaderThreadRole).toBe("answer");
    expect(response.threadAnswer).toBeUndefined();
    expect(response.leaderAnswerObservedHistoryLength).toBeUndefined();
  });

  it("deduplicates a completed raw legacy :F replay only against its persisted valid response proof", () => {
    // Replay-only compatibility prevents resume hot-tail growth without re-enabling fresh :F authoring.
    const sessionId = "leader-legacy-completed";
    const response = persistedLegacyAssistant(sessionId);
    const session = {
      id: sessionId,
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman(), response] as BrowserIncomingMessage[],
    };
    const replayText = "[thread:main:F] Persisted legacy answer.";

    expect(findMatchingRecoveredCodexAssistantReplay(session, replayText, 10, 0)).toEqual([response]);
    const broadcastToBrowsers = vi.fn();
    expect(
      recoverAgentMessagesFromResumedTurn(
        session,
        {
          id: "turn-legacy-completed",
          status: "completed",
          error: null,
          items: [{ type: "agentMessage", id: "item-1", text: replayText }],
        },
        { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
        { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
      ),
    ).toEqual({ count: 1, latestLeaderRoute: { threadKey: "main" } });

    expect(session.messageHistory).toEqual([expect.objectContaining({ type: "user_message" }), response]);
    expect(response.threadResponse).toBeDefined();
    expect(response.threadAnswer).toBeUndefined();
    expect(response.leaderAnswerUserMessageIds).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "main").responses).toEqual([
      expect.objectContaining({ currentMessageId: response.message.id, source: "legacy" }),
    ]);
    expect(broadcastToBrowsers).not.toHaveBeenCalled();
  });

  it("deduplicates an interrupted raw legacy :F replay without promoting or rewriting the persisted response", () => {
    // Interrupted provider history may repeat the row, but cannot revise its legacy authority.
    const sessionId = "leader-legacy-interrupted";
    const response = persistedLegacyAssistant(
      sessionId,
      "Persisted legacy answer.",
      "codex-agent-legacy-provider-item",
    );
    const originalProof = structuredClone(response.threadResponse);
    const session = {
      id: sessionId,
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman(), response] as BrowserIncomingMessage[],
    };
    const broadcastToBrowsers = vi.fn();

    expect(
      recoverAgentMessagesFromResumedTurn(
        session,
        {
          id: "turn-legacy-interrupted",
          status: "interrupted",
          error: null,
          items: [
            { type: "agentMessage", id: "legacy-provider-item", text: "[thread:main:F] Persisted legacy answer." },
          ],
        },
        { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
        { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
      ),
    ).toEqual({ count: 1, latestLeaderRoute: { threadKey: "main" } });

    expect(session.messageHistory).toHaveLength(2);
    expect(response.threadResponse).toEqual(originalProof);
    expect(response.threadAnswer).toBeUndefined();
    expect(response.leaderResponseObservedHistoryLength).toBeUndefined();
    expect(broadcastToBrowsers).not.toHaveBeenCalled();
  });

  it("keeps fresh :F invalid when the same-looking persisted row lacks valid historical proof", () => {
    // Text similarity alone is insufficient; corrupted legacy proof must fail closed and remain invalid.
    const sessionId = "leader-invalid-legacy-proof";
    const response = persistedLegacyAssistant(sessionId);
    response.threadResponse!.contentHash = leaderThreadResponseContentHash("Different text.");
    const session = {
      id: sessionId,
      state: { isOrchestrator: true, model: "gpt-5.6-sol", leaderThreadStatuses: {} as Record<string, any> },
      messageHistory: [pendingHuman(), response] as BrowserIncomingMessage[],
    };
    const replayText = "[thread:main:F] Persisted legacy answer.";

    expect(findMatchingRecoveredCodexAssistantReplay(session, replayText, 10, 0)).toBeNull();
    const broadcastToBrowsers = vi.fn();
    recoverAgentMessagesFromResumedTurn(
      session,
      {
        id: "turn-invalid-legacy-proof",
        status: "completed",
        error: null,
        items: [{ type: "agentMessage", id: "item-1", text: replayText }],
      },
      { disconnectedAt: 30, historyIndex: 0, userMessageId: "current-user" },
      { codexAssistantReplayScanLimit: 10, broadcastToBrowsers },
    );

    expect(session.messageHistory).toHaveLength(3);
    expect(session.messageHistory[2]).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "invalid_role", marker: "[thread:main:F]" },
    });
    expect(session.messageHistory[2]).not.toHaveProperty("leaderThreadRole");
    expect(session.messageHistory[2]).not.toHaveProperty("threadResponse");
    expect(session.messageHistory[2]).not.toHaveProperty("threadAnswer");
    expect(broadcastToBrowsers).toHaveBeenCalledTimes(1);
  });

  it("does not replay-dedupe a answer marker onto an older roleless commentary row", () => {
    const existing: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
      type: "assistant",
      message: {
        id: "old-commentary",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Same body." }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 100,
      threadKey: "main",
    };
    const session = { state: { isOrchestrator: true, model: "gpt-5.6-sol" }, messageHistory: [existing] };

    expect(findMatchingRecoveredCodexAssistantReplay(session, "[thread:main:A:u1] Same body.", 10)).toBeNull();
    expect(findMatchingRecoveredCodexAssistantReplay(session, "[thread:main:C] Same body.", 10)).toEqual([existing]);
  });
});
