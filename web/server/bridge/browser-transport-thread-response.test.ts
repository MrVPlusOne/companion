import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../session-types.js";
import { buildLeaderThreadResponseState, finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";
import { THREAD_WINDOW_SUPPORT_RECORD_LIMIT } from "../../shared/thread-window.js";
import { sendThreadWindowSync } from "./browser-transport-controller.js";

function human(id: string, timestamp: number, threadKey = "main", userMessageId?: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    ...(userMessageId ? { leaderUserMessageId: userMessageId } : {}),
    content: id,
    timestamp,
    threadKey,
    leaderResponseCoverageVersion: 1,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] }),
  };
}

function assistant(
  id: string,
  text: string,
  timestamp: number,
  threadKey = "main",
): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    threadKey,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] }),
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

function createResponse(
  session: { id: string; messageHistory: BrowserIncomingMessage[] },
  threadKey: string,
  text: string,
) {
  const observedHistoryLength = session.messageHistory.length;
  const response = assistant(
    `response-${observedHistoryLength}-${text.replace(/\W/g, "")}`,
    text,
    observedHistoryLength + 10,
    threadKey,
  );
  const pendingId = buildLeaderThreadResponseState(session, threadKey).projection.pendingMessages.at(-1)?.userMessageId;
  if (!pendingId) throw new Error(`No pending user message for ${threadKey}`);
  response.leaderThreadRole = "answer";
  response.leaderAnswerUserMessageIds = [pendingId];
  response.leaderAnswerObservedHistoryLength = observedHistoryLength;
  session.messageHistory.push(response);
  expect(finalizeRoutedLeaderResponseMessage(session, response)).toMatchObject({ finalized: true });
  return response;
}

function parseLast(sent: string[]) {
  return JSON.parse(sent.at(-1) ?? "null") as Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>;
}

function sendLatest(
  session: { id: string; messageHistory: BrowserIncomingMessage[] },
  threadKey: string,
  itemCount = 1,
) {
  const sent: string[] = [];
  sendThreadWindowSync(
    session,
    { send: (data) => sent.push(String(data)) },
    { threadKey, fromItem: -1, itemCount, sectionItemCount: 1, visibleItemCount: 1 },
  );
  return parseLast(sent);
}

function deliveredIds(message: Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>): string[] {
  return message.entries.flatMap((entry) => {
    if (entry.message.type === "leader_user_message" || entry.message.type === "user_message") {
      return entry.message.id ? [entry.message.id] : [];
    }
    if (entry.message.type === "assistant") return [entry.message.message.id];
    return [];
  });
}

describe("explicit answer selected-window authority", () => {
  it("retains every current response and covered prompt anchor for a bounded Ready projection", () => {
    const session = { id: "leader", messageHistory: [human("u1", 1, "q-42")] };
    const first = createResponse(session, "q-42", "First answer.");
    session.messageHistory.push(human("u2", 3, "q-42"));
    const second = createResponse(session, "q-42", "Second answer.");
    session.messageHistory.push(human("u3", 5, "q-42"));
    const third = createResponse(session, "q-42", "Third answer.");

    const message = sendLatest(session, "q-42");

    expect(message.response_state).toMatchObject({
      threadKey: "q-42",
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        { currentMessageId: first.message.id, coveredUserMessageIds: ["u1"] },
        { currentMessageId: second.message.id, coveredUserMessageIds: ["u2"] },
        { currentMessageId: third.message.id, coveredUserMessageIds: ["u3"] },
      ],
    });
    expect(deliveredIds(message)).toEqual(
      expect.arrayContaining(["u1", "u2", "u3", first.message.id, second.message.id, third.message.id]),
    );
  });

  it("retains every same-ID explicit answer row while only the latest owns coverage", () => {
    // Producer-shaped transport coverage for the live regression: a detailed
    // Work answer and a later complementary answer share one prompt anchor.
    const session = { id: "leader", messageHistory: [human("raw-u1", 1, "q-42", "u1")] };
    const earlier = createResponse(session, "q-42", "Detailed accepted Work answer.");
    const later = assistant("later-same-id-answer", "Complementary Memory finding.", 20, "q-42");
    later.leaderThreadRole = "answer";
    later.leaderAnswerUserMessageIds = ["u1"];
    later.leaderAnswerObservedHistoryLength = session.messageHistory.length;
    session.messageHistory.push(later);
    expect(finalizeRoutedLeaderResponseMessage(session, later)).toMatchObject({ finalized: true });

    const message = sendLatest(session, "q-42");

    expect(message.response_state).toMatchObject({
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        { currentMessageId: earlier.message.id, coveredUserMessageIds: [] },
        { currentMessageId: later.message.id, coveredUserMessageIds: ["raw-u1"] },
      ],
    });
    expect(deliveredIds(message)).toEqual(expect.arrayContaining(["raw-u1", earlier.message.id, later.message.id]));
  });

  it("retains old Main prompt anchors with their current responses", () => {
    const session = { id: "leader", messageHistory: [human("main-u1", 1)] };
    const response = createResponse(session, "main", "Main answer.");
    session.messageHistory.push(assistant("later", "Later activity", 20));

    const message = sendLatest(session, "main");

    expect(message.response_state?.ready).toBe(true);
    expect(deliveredIds(message)).toEqual(expect.arrayContaining(["main-u1", response.message.id]));
  });

  it("emits the same Main-owned u25 answer identity in Main and its associated q-2024 window", () => {
    // Producer-shaped regression for the live failure: the request remains
    // owned by Main while a backfill ref makes it part of q-2024.
    const request = human("raw-u25", 1, "main", "u25") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [{ threadKey: "q-2024", questId: "q-2024", source: "backfill", attachedAt: 2 }];
    const session = { id: "leader", messageHistory: [request] as BrowserIncomingMessage[] };
    const response = createResponse(session, "main", "Main answer for the attached request.");
    session.messageHistory.push(assistant("unrelated-main", "Unrelated Main activity.", 20));

    const main = sendLatest(session, "main");
    const quest = sendLatest(session, "q-2024");
    const unrelated = sendLatest(session, "q-999");
    const mainAnswer = main.response_state?.currentAnswers[0];
    const questAnswer = quest.response_state?.currentAnswers[0];

    expect(mainAnswer).toMatchObject({
      threadKey: "main",
      answerUserMessageIds: ["u25"],
      coveredAnswerUserMessageIds: ["u25"],
      coveredUserMessageIds: ["raw-u25"],
      currentMessageId: response.message.id,
      currentHistoryIndex: 1,
    });
    expect(quest.response_state).toMatchObject({
      threadKey: "q-2024",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      ready: true,
    });
    expect(questAnswer).toEqual({ ...mainAnswer, coveredAnswerUserMessageIds: [], coveredUserMessageIds: [] });
    expect(deliveredIds(quest).filter((id) => id === response.message.id)).toHaveLength(1);
    expect(deliveredIds(quest).filter((id) => id === "raw-u25")).toHaveLength(1);
    expect(deliveredIds(quest)).not.toContain("unrelated-main");
    const deliveredAnswer = quest.entries.find(
      (entry) => entry.message.type === "assistant" && entry.message.message.id === response.message.id,
    )?.message;
    expect(deliveredAnswer).toMatchObject({ type: "assistant", threadKey: "main" });
    // One stored source row carries visibility-only refs; the quest's empty
    // coverage subset cannot grant it Main's pending or Ready authority.
    expect(deliveredAnswer).toEqual(response);
    expect(response.threadRefs).toMatchObject([{ threadKey: "q-2024", questId: "q-2024", source: "backfill" }]);
    expect(unrelated.response_state?.currentAnswers).toEqual([]);
    expect(deliveredIds(unrelated)).not.toContain(response.message.id);
  });

  it("keeps deterministic missing-ID compatibility for an associated Main answer", () => {
    const request = human("raw-without-persisted-id", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.leaderUserMessageId = undefined;
    request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 }];
    const session = { id: "leader", messageHistory: [request] as BrowserIncomingMessage[] };
    const response = createResponse(session, "main", "Answer through deterministic u1.");

    const quest = sendLatest(session, "q-42");

    expect(request.leaderUserMessageId).toBeUndefined();
    expect(quest.response_state?.currentAnswers).toMatchObject([
      {
        threadKey: "main",
        answerUserMessageIds: ["u1"],
        referencedUserMessageIds: ["raw-without-persisted-id"],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
        currentMessageId: response.message.id,
      },
    ]);
    expect(deliveredIds(quest)).toEqual(expect.arrayContaining(["raw-without-persisted-id", response.message.id]));
  });

  it("retains a separate routed Quest Quiz directive for the collapsed Ready view", () => {
    const session = { id: "leader", messageHistory: [human("u1", 1, "q-42")] };
    const response = createResponse(session, "q-42", "Answer.");
    session.messageHistory.push(assistant("quiz", "{[(Quest Quiz: q-42)]}", 20, "q-42"));
    for (let index = 0; index < 5; index += 1) {
      session.messageHistory.push(assistant(`later-${index}`, `Later ${index}`, 30 + index, "q-42"));
    }

    const message = sendLatest(session, "q-42");

    expect(message.response_state?.ready).toBe(true);
    expect(deliveredIds(message)).toEqual(expect.arrayContaining(["u1", response.message.id, "quiz"]));
  });

  it("does not backfill a Quiz directive from before the response cutover", () => {
    const session = {
      id: "leader",
      messageHistory: [assistant("legacy-quiz", "{[(Quest Quiz: q-42)]}", 1, "q-42"), human("u1", 2, "q-42")],
    };
    const response = createResponse(session, "q-42", "Answer.");
    for (let index = 0; index < 5; index += 1) {
      session.messageHistory.push(assistant(`later-${index}`, `Later ${index}`, 30 + index, "q-42"));
    }

    const message = sendLatest(session, "q-42");

    expect(message.response_state?.cutoverHistoryIndex).toBe(1);
    expect(deliveredIds(message)).toEqual(expect.arrayContaining(["u1", response.message.id]));
    expect(deliveredIds(message)).not.toContain("legacy-quiz");
  });

  it("fails closed to the ordinary bounded window when response support exceeds the cap", () => {
    const session = { id: "leader", messageHistory: [] as BrowserIncomingMessage[] };
    for (let index = 0; index <= THREAD_WINDOW_SUPPORT_RECORD_LIMIT / 2; index += 1) {
      session.messageHistory.push(human(`raw-${index}`, index * 2 + 1, "q-42", `u${index + 1}`));
      createResponse(session, "q-42", `Answer ${index}.`);
    }

    const message = sendLatest(session, "q-42");

    expect(message.response_state).toBeUndefined();
    expect(message.entries.length).toBeLessThan(THREAD_WINDOW_SUPPORT_RECORD_LIMIT);
  });

  it("omits cross-thread response state when duplicate raw prompt identity makes support ambiguous", () => {
    const first = human("raw-duplicate", 1, "main", "u1") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const second = human("raw-duplicate", 2, "main", "u2") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    for (const request of [first, second]) {
      request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 3 }];
    }
    const session = { id: "leader", messageHistory: [first, second] as BrowserIncomingMessage[] };
    const response = assistant("duplicate-anchor-answer", "Answer for the first prompt.", 10, "main");
    response.leaderThreadRole = "answer";
    response.leaderAnswerUserMessageIds = ["u1"];
    response.leaderAnswerObservedHistoryLength = 2;
    session.messageHistory.push(response);
    expect(finalizeRoutedLeaderResponseMessage(session, response)).toMatchObject({ finalized: true });
    expect(buildLeaderThreadResponseState(session, "q-42").projection.currentAnswers).toHaveLength(1);

    const message = sendLatest(session, "q-42");

    expect(message.response_state).toBeUndefined();
    expect(deliveredIds(message)).not.toContain(response.message.id);
  });

  it("omits cross-thread response state when complete associated proof exceeds the support cap", () => {
    const session = { id: "leader", messageHistory: [] as BrowserIncomingMessage[] };
    const responseIds: string[] = [];
    for (let index = 0; index <= THREAD_WINDOW_SUPPORT_RECORD_LIMIT / 2; index += 1) {
      const request = human(`raw-main-${index}`, index * 2 + 1, "main", `u${index + 1}`) as Extract<
        BrowserIncomingMessage,
        { type: "user_message" }
      >;
      request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: index + 1 }];
      session.messageHistory.push(request);
      responseIds.push(createResponse(session, "main", `Associated answer ${index}.`).message.id);
    }
    expect(buildLeaderThreadResponseState(session, "q-42").projection.currentAnswers).toHaveLength(
      THREAD_WINDOW_SUPPORT_RECORD_LIMIT / 2 + 1,
    );

    const message = sendLatest(session, "q-42");

    expect(message.response_state).toBeUndefined();
    expect(deliveredIds(message).some((id) => responseIds.includes(id))).toBe(false);
  });

  it("sends response state even on a cache hit", () => {
    const session = { id: "leader", messageHistory: [human("u1", 1)] };
    const response = createResponse(session, "main", "Answer.");
    const sent: string[] = [];
    const socket = { send: (data: string) => sent.push(data) };
    const options = { threadKey: "main", fromItem: -1, itemCount: 1, sectionItemCount: 1, visibleItemCount: 1 };

    sendThreadWindowSync(session, socket, options);
    const first = parseLast(sent);
    sendThreadWindowSync(session, socket, { ...options, cachedWindowHash: first.window.window_hash });
    const cached = parseLast(sent);

    expect(cached.cache_hit).toBe(true);
    expect(cached.entries).toEqual([]);
    expect(cached.response_state?.currentAnswers[0]).toMatchObject({ currentMessageId: response.message.id });
  });

  it("omits malformed response authority and leaves its covered prompt pending", () => {
    const session = { id: "leader", messageHistory: [human("u1", 1)] };
    const response = createResponse(session, "main", "Answer.");
    response.threadAnswer = { ...response.threadAnswer!, answerUserMessageIds: ["u999"] };

    expect(sendLatest(session, "main").response_state).toMatchObject({
      pendingMessageCount: 1,
      currentAnswers: [],
      ready: false,
    });
  });
});
