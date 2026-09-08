import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage, LeaderThreadResponseProjection } from "../server/session-types.js";
import { buildLeaderThreadResponseState, leaderThreadResponseContentHash } from "../server/leader-thread-response.js";
import { buildFeedSections } from "../src/components/message-feed-sections.js";
import { resolveThreadResponses } from "../src/components/thread-response-presentation.js";
import { buildFeedModel } from "../src/hooks/use-feed-model.js";
import { normalizeHistoryMessageToChatMessages } from "../src/utils/history-message-normalization.js";
import {
  buildProjectedThreadEntries,
  buildThreadWindowSync,
  THREAD_WINDOW_SUPPORT_RECORD_LIMIT,
} from "./thread-window.js";

const THREAD_KEY = "q-2024";
const THREAD_REF = { threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" as const };

function human(rawId: string, answerId: string, timestamp: number): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: rawId,
    leaderUserMessageId: answerId,
    content: rawId,
    timestamp,
    leaderResponseCoverageVersion: 1,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [THREAD_REF],
  };
}

function assistant(
  id: string,
  text: string,
  timestamp: number,
  role: "commentary" | "answer" | "response",
  answerIds?: string[],
): BrowserIncomingMessage {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    leaderThreadRole: role,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [THREAD_REF],
    ...(role === "answer" && answerIds
      ? { threadAnswer: { version: 2 as const, answerUserMessageIds: answerIds, observedHistoryLength: 1 } }
      : {}),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function mainHuman(rawId: string, answerId: string, timestamp: number): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: rawId,
    leaderUserMessageId: answerId,
    leaderResponseCoverageVersion: 1,
    content: rawId,
    timestamp,
    threadKey: "main",
  };
}

function backfilledMainHuman(
  rawId: string,
  answerId: string | undefined,
  timestamp: number,
  threadKey = THREAD_KEY,
): BrowserIncomingMessage {
  const message = mainHuman(rawId, answerId ?? "u1", timestamp) as Extract<
    BrowserIncomingMessage,
    { type: "user_message" }
  >;
  if (answerId === undefined) message.leaderUserMessageId = undefined;
  message.threadRefs = [{ threadKey, questId: threadKey, source: "backfill", attachedAt: timestamp + 1 }];
  return message;
}

function sourcedMainUser(id: string, timestamp: number, sourceSessionId: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content: id,
    timestamp,
    agentSource: { sessionId: sourceSessionId, sessionLabel: sourceSessionId },
  };
}

function mainAssistant(
  id: string,
  text: string,
  timestamp: number,
  role: "commentary" | "answer",
  answerIds?: string[],
): BrowserIncomingMessage {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    leaderThreadRole: role,
    threadKey: "main",
    ...(role === "answer" && answerIds
      ? { threadAnswer: { version: 2 as const, answerUserMessageIds: answerIds, observedHistoryLength: 1 } }
      : {}),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function resolvedPresentation(
  entries: ReturnType<typeof buildThreadWindowSync>["entries"],
  state: LeaderThreadResponseProjection,
  threadKey: string,
  options: { leaderMode: boolean; parentSessionId?: string } = { leaderMode: true },
) {
  const messages = entries.flatMap((entry) =>
    normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
  );
  const model = buildFeedModel(messages, options.leaderMode, 0, undefined, options.parentSessionId, undefined, true);
  return resolveThreadResponses(buildFeedSections(model.turns, 30), state, threadKey);
}

function projection(ready: boolean): LeaderThreadResponseProjection {
  return {
    version: 2,
    threadKey: THREAD_KEY,
    cutoverHistoryIndex: 0,
    pendingMessageCount: ready ? 0 : 1,
    pendingMessages: ready ? [] : [{ userMessageId: "u2", historyMessageId: "raw-u2", historyIndex: 3, askedAt: 4 }],
    currentAnswers: [
      {
        version: 2,
        threadKey: THREAD_KEY,
        questId: THREAD_KEY,
        answerUserMessageIds: ["u1"],
        referencedUserMessageIds: ["raw-u1"],
        coveredAnswerUserMessageIds: ["u1"],
        coveredUserMessageIds: ["raw-u1"],
        currentMessageId: "answer-1",
        currentHistoryIndex: 1,
        createdAt: 2,
        updatedAt: 2,
        source: "explicit",
      },
    ],
    ready,
  };
}

function legacyBatchId(sessionId: string, threadKey: string, historyLength: number, ids: string[]): string {
  const encoded = Buffer.from(JSON.stringify({ v: 1, t: threadKey, h: historyLength, ids })).toString("base64url");
  const checksum = leaderThreadResponseContentHash(`${sessionId}\n${encoded}`).slice(0, 24);
  return `response-batch-v1.${encoded}.${checksum}`;
}

function deliveredIds(sync: ReturnType<typeof buildThreadWindowSync>): string[] {
  return sync.entries.flatMap(({ message }) => {
    if (message.type === "assistant") return [message.message.id];
    if (message.type === "user_message" || message.type === "leader_user_message")
      return message.id ? [message.id] : [];
    return [];
  });
}

describe("selected thread-window routed answer support", () => {
  it("backfills the exact Main-owned u25 answer and prompt into its bounded q-2024 window", () => {
    const request = backfilledMainHuman("raw-u25", "u25", 1);
    const answer = mainAssistant("answer-u25", "Main answer for the attached request", 2, "answer", ["u25"]);
    const laterBoundary: BrowserIncomingMessage = {
      type: "user_message",
      id: "q-later-worker-event",
      content: "Later quest activity",
      timestamp: 3,
      agentSource: { sessionId: "worker-1", sessionLabel: "worker-1" },
      threadKey: THREAD_KEY,
      questId: THREAD_KEY,
      threadRefs: [THREAD_REF],
    };
    const later = assistant("q-later-commentary", "Latest quest update", 4, "commentary");
    const messages = [
      request,
      answer,
      mainAssistant("unrelated-main", "Unrelated Main row", 3, "commentary"),
      laterBoundary,
      later,
    ];
    const state = buildLeaderThreadResponseState({ id: "leader", messageHistory: messages }, THREAD_KEY).projection;

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(state).toMatchObject({
      threadKey: THREAD_KEY,
      cutoverHistoryIndex: 0,
      currentAnswers: [
        {
          threadKey: "main",
          answerUserMessageIds: ["u25"],
          referencedUserMessageIds: ["raw-u25"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
          currentMessageId: "answer-u25",
          currentHistoryIndex: 1,
        },
      ],
    });
    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync).filter((id) => id === "raw-u25")).toHaveLength(1);
    expect(deliveredIds(sync).filter((id) => id === "answer-u25")).toHaveLength(1);
    expect(deliveredIds(sync)).toEqual(expect.arrayContaining(["q-later-worker-event", "q-later-commentary"]));
    expect(deliveredIds(sync)).not.toContain("unrelated-main");
  });

  it("omits cross-thread support on duplicate identity, include-policy rejection, or malformed answer route", () => {
    const request = backfilledMainHuman("raw-u25", "u25", 1);
    const answer = mainAssistant("answer-u25", "Main answer for the attached request", 2, "answer", ["u25"]);
    const laterBoundary: BrowserIncomingMessage = {
      type: "user_message",
      id: "q-later-worker-event",
      content: "Later quest activity",
      timestamp: 3,
      agentSource: { sessionId: "worker-1", sessionLabel: "worker-1" },
      threadKey: THREAD_KEY,
      questId: THREAD_KEY,
      threadRefs: [THREAD_REF],
    };
    const messages = [request, answer, laterBoundary];
    const state = buildLeaderThreadResponseState({ id: "leader", messageHistory: messages }, THREAD_KEY).projection;
    expect(state.currentAnswers).toHaveLength(1);

    const corruptions: Array<{
      messages: BrowserIncomingMessage[];
      state: LeaderThreadResponseProjection;
      includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean;
    }> = [
      {
        messages,
        state: { ...state, currentAnswers: [state.currentAnswers[0]!, { ...state.currentAnswers[0]! }] },
      },
      { messages, state, includeMessage: (_message, historyIndex) => historyIndex !== 0 },
      { messages, state, includeMessage: (_message, historyIndex) => historyIndex !== 1 },
      {
        messages: [request, { ...answer, questId: "q-999" }, laterBoundary],
        state,
      },
    ];

    for (const corruption of corruptions) {
      const sync = buildThreadWindowSync({
        messageHistory: corruption.messages,
        threadKey: THREAD_KEY,
        fromItem: -1,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
        currentThreadResponseProjection: corruption.state,
        ...(corruption.includeMessage ? { includeMessage: corruption.includeMessage } : {}),
      });
      expect(sync.threadResponseSupportComplete).toBe(false);
      expect(deliveredIds(sync)).not.toContain("answer-u25");
    }
  });

  it("rejects a forged cross-thread legacy response projection", () => {
    const request = backfilledMainHuman("raw-u1", "u1", 1);
    const text = "Legacy Main response";
    const legacy: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: "legacy-main-answer",
      content: text,
      timestamp: 2,
      threadKey: "main",
      threadResponse: {
        logicalResponseId: "legacy-main",
        revisionId: "legacy-main-r1",
        revisionNumber: 1,
        batchId: legacyBatchId("leader", "main", 1, ["raw-u1"]),
        batchObservedHistoryLength: 1,
        coveredUserMessageIds: ["raw-u1"],
        contentHash: leaderThreadResponseContentHash(text),
      },
    };
    const messages = [request, legacy];
    const sourceState = buildLeaderThreadResponseState({ id: "leader", messageHistory: messages }, "main").projection;
    expect(sourceState.currentAnswers).toMatchObject([
      { threadKey: "main", currentMessageId: "legacy-main-answer", source: "legacy" },
    ]);

    const forgedState: LeaderThreadResponseProjection = {
      version: 2,
      threadKey: THREAD_KEY,
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: "main",
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["raw-u1"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["raw-u1"],
          currentMessageId: "legacy-main-answer",
          currentHistoryIndex: 1,
          createdAt: 2,
          updatedAt: 2,
          source: "legacy",
        },
      ],
      ready: true,
    };
    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: forgedState,
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
    expect(deliveredIds(sync)).not.toContain("legacy-main-answer");
  });

  it("backfills a current answer, its proof anchor, and an actual-host Quiz while newer input is pending", () => {
    const messages: BrowserIncomingMessage[] = [
      human("raw-u1", "u1", 1),
      assistant("answer-1", "Current answer", 2, "answer", ["u1"]),
      assistant("quiz", "{[(Quest Quiz: q-2024)]}", 3, "commentary"),
      human("raw-u2", "u2", 4),
      assistant("commentary", "Working on the follow-up", 5, "commentary"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: projection(false),
    });

    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync)).toEqual(expect.arrayContaining(["raw-u1", "answer-1", "quiz", "raw-u2", "commentary"]));
  });

  it("backfills an older pending request when a later clarification already has the current answer", () => {
    // This is the inverse bounded-window shape that previously reported complete but failed in the browser.
    const messages: BrowserIncomingMessage[] = [
      human("raw-u1", "u1", 1),
      human("raw-u2", "u2", 2),
      assistant("answer-2", "Clarification answered", 3, "answer", ["u2"]),
    ];
    const state = projection(false);
    state.pendingMessages = [{ userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 }];
    state.currentAnswers = [
      {
        ...state.currentAnswers[0]!,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["raw-u2"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["raw-u2"],
        currentMessageId: "answer-2",
        currentHistoryIndex: 2,
        createdAt: 3,
        updatedAt: 3,
      },
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync)).toEqual(expect.arrayContaining(["raw-u1", "raw-u2", "answer-2"]));
    expect(
      resolvedPresentation(sync.entries, sync.threadResponseProjection!, THREAD_KEY)?.currentResponses[0],
    ).toMatchObject({
      anchorUserMessageId: "raw-u2",
      sourceTurnId: "raw-u2",
    });
  });

  it("fails closed when a pending projection does not match exact history identity or current ownership", () => {
    const messages: BrowserIncomingMessage[] = [
      human("raw-u1", "u1", 1),
      human("raw-u2", "u2", 2),
      assistant("answer-2", "Clarification answered", 3, "answer", ["u2"]),
    ];
    const base = projection(false);
    base.currentAnswers = [
      {
        ...base.currentAnswers[0]!,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["raw-u2"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["raw-u2"],
        currentMessageId: "answer-2",
        currentHistoryIndex: 2,
      },
    ];
    const movedPending = {
      ...messages[0]!,
      threadRefs: [THREAD_REF, { threadKey: "q-99", questId: "q-99", source: "explicit" as const, attachedAt: 99 }],
    } as BrowserIncomingMessage;

    const corruptions: Array<{ messages: BrowserIncomingMessage[]; pending: (typeof base.pendingMessages)[number] }> = [
      {
        messages,
        pending: { userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 1, askedAt: 1 },
      },
      {
        messages,
        pending: { userMessageId: "u9", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 },
      },
      {
        messages: [movedPending, ...messages.slice(1)],
        pending: { userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 },
      },
    ];

    for (const corruption of corruptions) {
      const state = { ...base, pendingMessages: [corruption.pending] };
      const sync = buildThreadWindowSync({
        messageHistory: corruption.messages,
        threadKey: THREAD_KEY,
        fromItem: -1,
        itemCount: 1,
        sectionItemCount: 1,
        visibleItemCount: 1,
        currentThreadResponseProjection: state,
      });
      expect(sync.threadResponseSupportComplete).toBe(false);
    }
  });

  it("accepts the deterministic virtual ID used by an older post-cutover pending row", () => {
    const legacyPending = { ...human("raw-u1", "u1", 1), leaderUserMessageId: undefined } as BrowserIncomingMessage;
    const messages: BrowserIncomingMessage[] = [
      legacyPending,
      human("raw-u2", "u2", 2),
      assistant("answer-2", "Clarification answered", 3, "answer", ["u2"]),
    ];
    const state = projection(false);
    state.pendingMessages = [{ userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 }];
    state.currentAnswers = [
      {
        ...state.currentAnswers[0]!,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["raw-u2"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["raw-u2"],
        currentMessageId: "answer-2",
        currentHistoryIndex: 2,
      },
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync)).toContain("raw-u1");
  });

  it("rejects an arbitrary virtual ID for an older post-cutover pending row", () => {
    // Missing persisted IDs are compatible only with the deterministic ordinal
    // the server would derive from the complete leader history.
    const legacyPending = { ...human("raw-u1", "u1", 1), leaderUserMessageId: undefined } as BrowserIncomingMessage;
    const messages: BrowserIncomingMessage[] = [
      legacyPending,
      human("raw-u2", "u2", 2),
      assistant("answer-2", "Clarification answered", 3, "answer", ["u2"]),
    ];
    const state = projection(false);
    state.pendingMessages = [{ userMessageId: "u9", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 }];
    state.currentAnswers = [
      {
        ...state.currentAnswers[0]!,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["raw-u2"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["raw-u2"],
        currentMessageId: "answer-2",
        currentHistoryIndex: 2,
      },
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
  });

  it("fails closed when the root-history include policy rejects a projected pending row", () => {
    const messages: BrowserIncomingMessage[] = [
      human("raw-u1", "u1", 1),
      human("raw-u2", "u2", 2),
      assistant("answer-2", "Clarification answered", 3, "answer", ["u2"]),
    ];
    const state = projection(false);
    state.pendingMessages = [{ userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 0, askedAt: 1 }];
    state.currentAnswers = [
      {
        ...state.currentAnswers[0]!,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["raw-u2"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["raw-u2"],
        currentMessageId: "answer-2",
        currentHistoryIndex: 2,
      },
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      includeMessage: (_message, historyIndex) => historyIndex !== 0,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
  });

  it("preserves a herding-parent source turn for a Main answer and its actual-host Quiz", () => {
    // Main feed turn boundaries depend on the runtime herdedBy source, which the server must conservatively preserve.
    const parentSessionId = "leader-parent";
    const messages: BrowserIncomingMessage[] = [
      mainHuman("raw-u1", "u1", 1),
      sourcedMainUser("parent-trigger", 2, parentSessionId),
      sourcedMainUser("timer-before-answer", 3, "timer:t0"),
      mainAssistant("answer-u1", "Asynchronous Main answer", 4, "answer", ["u1"]),
      mainAssistant("quiz", "{[(Quest Quiz: q-2024)]}", 5, "commentary"),
      sourcedMainUser("timer-latest", 6, "timer:t1"),
      mainAssistant("later", "Later Main activity", 7, "commentary"),
    ];
    const state: LeaderThreadResponseProjection = {
      version: 2,
      threadKey: "main",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: "main",
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["raw-u1"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["raw-u1"],
          currentMessageId: "answer-u1",
          currentHistoryIndex: 3,
          createdAt: 4,
          updatedAt: 4,
          source: "explicit",
        },
      ],
      ready: true,
    };
    const fullEntries = buildProjectedThreadEntries(messages, "main");
    const fullPresentation = resolvedPresentation(fullEntries, state, "main", {
      leaderMode: false,
      parentSessionId,
    });

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });
    const boundedPresentation = resolvedPresentation(sync.entries, sync.threadResponseProjection!, "main", {
      leaderMode: false,
      parentSessionId,
    });

    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync)).toContain("parent-trigger");
    expect(fullPresentation?.currentResponses[0]?.sourceTurnId).toBe("parent-trigger");
    expect(boundedPresentation?.currentResponses[0]?.sourceTurnId).toBe("parent-trigger");
    expect(fullPresentation?.quizGroups).toEqual([{ hostTurnId: "parent-trigger", questIds: ["q-2024"] }]);
    expect(boundedPresentation?.quizGroups).toEqual(fullPresentation?.quizGroups);
  });

  it("fails closed when the root-history include policy rejects a required Main source boundary", () => {
    // Omitting a required boundary would silently reassign both answer source and Quiz host.
    const parentSessionId = "leader-parent";
    const messages: BrowserIncomingMessage[] = [
      mainHuman("raw-u1", "u1", 1),
      sourcedMainUser("parent-trigger", 2, parentSessionId),
      mainAssistant("answer-u1", "Asynchronous Main answer", 3, "answer", ["u1"]),
      sourcedMainUser("latest-boundary", 4, "timer:latest"),
      mainAssistant("latest", "Latest activity", 5, "commentary"),
    ];
    const state: LeaderThreadResponseProjection = {
      version: 2,
      threadKey: "main",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: "main",
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["raw-u1"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["raw-u1"],
          currentMessageId: "answer-u1",
          currentHistoryIndex: 2,
          createdAt: 3,
          updatedAt: 3,
          source: "explicit",
        },
      ],
      ready: true,
    };

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      includeMessage: (_message, historyIndex) => historyIndex !== 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
    expect(deliveredIds(sync)).not.toContain("answer-u1");
  });

  it("fails closed instead of exceeding the support cap for Main source-boundary closure", () => {
    // Conservative closure stays bounded rather than turning a selected window into a large replay.
    const boundaryRows = Array.from({ length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT }, (_, index) =>
      sourcedMainUser(`parent-candidate-${index}`, index + 2, `source-${index}`),
    );
    const answerIndex = boundaryRows.length + 1;
    const messages: BrowserIncomingMessage[] = [
      mainHuman("raw-u1", "u1", 1),
      ...boundaryRows,
      mainAssistant("answer-u1", "Bounded answer", answerIndex + 1, "answer", ["u1"]),
      sourcedMainUser("latest-boundary", answerIndex + 2, "timer:latest"),
      mainAssistant("latest", "Latest activity", answerIndex + 3, "commentary"),
    ];
    const state: LeaderThreadResponseProjection = {
      version: 2,
      threadKey: "main",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: "main",
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["raw-u1"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["raw-u1"],
          currentMessageId: "answer-u1",
          currentHistoryIndex: answerIndex,
          createdAt: answerIndex + 1,
          updatedAt: answerIndex + 1,
          source: "explicit",
        },
      ],
      ready: true,
    };

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
    expect(deliveredIds(sync)).not.toContain("answer-u1");
  });

  it("fails closed when answer authority points at commentary", () => {
    const messages: BrowserIncomingMessage[] = [
      human("raw-u1", "u1", 1),
      assistant("answer-1", "Not an answer", 2, "commentary"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: projection(true),
    });

    expect(sync.threadResponseSupportComplete).toBe(false);
  });

  it("continues to support legacy dedicated response rows during bounded-window replay", () => {
    const legacy: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: "legacy-answer",
      content: "Legacy answer",
      timestamp: 2,
      threadKey: THREAD_KEY,
      questId: THREAD_KEY,
      threadRefs: [THREAD_REF],
      threadResponse: {
        logicalResponseId: "legacy-logical",
        revisionId: "legacy-r1",
        revisionNumber: 1,
        batchId: "legacy-batch",
        batchObservedHistoryLength: 1,
        coveredUserMessageIds: ["raw-u1"],
        contentHash: "legacy-hash",
      },
    };
    const state = projection(true);
    state.currentAnswers[0] = {
      ...state.currentAnswers[0]!,
      currentMessageId: "legacy-answer",
      source: "legacy",
    };
    const messages = [human("raw-u1", "u1", 1), legacy, assistant("later", "Later", 3, "commentary")];

    const sync = buildThreadWindowSync({
      messageHistory: messages,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    });

    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(deliveredIds(sync)).toEqual(expect.arrayContaining(["raw-u1", "legacy-answer", "later"]));
  });
});
