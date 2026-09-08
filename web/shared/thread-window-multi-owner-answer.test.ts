import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
} from "../server/leader-thread-response.js";
import { buildFeedModel } from "../src/hooks/use-feed-model.js";
import { buildFeedSections } from "../src/components/message-feed-sections.js";
import { resolveThreadResponses } from "../src/components/thread-response-presentation.js";
import { buildFeedMessageModel } from "../src/utils/feed-render-model.js";
import { normalizeHistoryMessageToChatMessages } from "../src/utils/history-message-normalization.js";
import { buildThreadWindowSync, THREAD_WINDOW_SUPPORT_RECORD_LIMIT } from "./thread-window.js";

type Human = Extract<BrowserIncomingMessage, { type: "user_message" }>;
type Assistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function route(threadKey: string) {
  return threadKey === "main"
    ? { threadKey }
    : {
        threadKey,
        questId: threadKey,
        threadRefs: [{ threadKey, questId: threadKey, source: "explicit" as const }],
      };
}

function human(id: string, threadKey: string, associated: string[] = []): Human {
  const fields = route(threadKey);
  return {
    type: "user_message",
    id: `raw-${id}`,
    content: `Exact prompt ${id}`,
    timestamp: Number(id.slice(1)),
    leaderUserMessageId: id,
    leaderResponseCoverageVersion: 1,
    ...fields,
    threadRefs: [
      ...(fields.threadRefs ?? []),
      ...associated.map((key) => ({ threadKey: key, questId: key, source: "backfill" as const })),
    ],
  };
}

function appendAnswer(
  history: BrowserIncomingMessage[],
  id: string,
  answerIds: string[],
  selectedThreadKey: string,
): Assistant {
  const answer: Assistant = {
    type: "assistant",
    timestamp: 10 + history.length,
    parent_tool_use_id: null,
    leaderThreadRole: "answer",
    leaderAnswerUserMessageIds: answerIds,
    leaderAnswerObservedHistoryLength: history.length,
    ...route(selectedThreadKey),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: `\nExact answer ${id}\n` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  history.push(answer);
  expect(finalizeRoutedLeaderResponseMessage({ id: "leader", messageHistory: history }, answer).finalized).toBe(true);
  return answer;
}

function fixture() {
  const first = human("u1", "main", ["q-11", "q-12"]);
  const second = human("u2", "q-22", ["q-23"]);
  const pending = human("u3", "main");
  const history: BrowserIncomingMessage[] = [first, second, pending];
  // Author order is intentionally different from history order, and the
  // authoring quest owns neither request. Finalization supplies the real proof.
  const answer = appendAnswer(history, "shared-answer", ["u2", "u1"], "q-30");
  return { first, second, pending, history, answer };
}

function project(history: BrowserIncomingMessage[], threadKey: string) {
  const state = buildLeaderThreadResponseState({ id: "leader", messageHistory: history }, threadKey).projection;
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey,
    fromItem: -1,
    itemCount: 1,
    sectionItemCount: 1,
    visibleItemCount: 1,
    currentThreadResponseProjection: state,
  });
  const delivered = sync.entries.flatMap((entry) =>
    normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
  );
  const supportedState = sync.threadResponseSupportComplete ? sync.threadResponseProjection : undefined;
  const feed = buildFeedMessageModel({
    leaderSessionId: "leader",
    threadKey,
    projectThreadRoutes: true,
    allMessages: [],
    historyLoading: false,
    selectedFeedWindowEnabled: true,
    selectedFeedWindow: sync.window,
    selectedFeedWindowMessages: delivered,
    threadResponseState: supportedState,
  });
  const turns = buildFeedModel(feed.messages, threadKey !== "main", 0, undefined, null, undefined, true).turns;
  const presentation = resolveThreadResponses(
    buildFeedSections(turns, 30),
    supportedState,
    threadKey,
    true,
    feed.messagesAvailableForDerivation,
  );
  return { state, sync, feed, presentation };
}

describe("multi-owner answer window and feed projection", () => {
  it.each(["main", "q-42"])("retains an older Quiz answer's complete proof in a latest %s window", (threadKey) => {
    // Quiz support retains its actual host outside the selected latest turn.
    // Its older answer and covered user boundary must join the proof packet,
    // or the frontend rejects the whole projection despite staying under cap.
    const history: BrowserIncomingMessage[] = [human("u1", threadKey)];
    const older = appendAnswer(history, "older-quiz-answer", ["u1"], threadKey);
    older.message.content.push({ type: "text", text: "\n{[(Quest Quiz: q-42)]}\n" });
    history.push(human("u2", threadKey));
    appendAnswer(history, "latest-answer", ["u2"], threadKey);

    const { sync, feed, presentation } = project(history, threadKey);
    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(sync.threadResponseProjection?.currentAnswers.map((row) => row.currentMessageId)).toEqual([
      "older-quiz-answer",
      "latest-answer",
    ]);
    expect(presentation?.currentResponses.map((row) => row.response.currentMessageId)).toEqual([
      "older-quiz-answer",
      "latest-answer",
    ]);
    expect(presentation?.quizGroups).toEqual([{ hostTurnId: "raw-u1", questIds: ["q-42"] }]);
    expect(feed.messages.filter((row) => row.id === older.message.id)).toHaveLength(1);
  });

  it.each([
    { threadKey: "main", sourceOwner: "main" },
    { threadKey: "q-42", sourceOwner: "q-42" },
    { threadKey: "q-42", sourceOwner: "main" },
  ])("closes $sourceOwner boundaries for a separate older Quiz in $threadKey", ({ threadKey, sourceOwner }) => {
    // A commentary Quiz can introduce an answered human boundary without
    // itself being an answer. Closure still needs that boundary's answer set.
    const history: BrowserIncomingMessage[] = [human("u1", sourceOwner, sourceOwner === threadKey ? [] : [threadKey])];
    const older = appendAnswer(history, "older-answer", ["u1"], threadKey);
    history.push({
      ...older,
      ...route(threadKey),
      leaderThreadRole: "commentary",
      leaderAnswerUserMessageIds: undefined,
      leaderAnswerObservedHistoryLength: undefined,
      threadAnswer: undefined,
      message: { ...older.message, id: "quiz-host", content: [{ type: "text", text: "{[(Quest Quiz: q-42)]}" }] },
    });
    history.push(human("u2", threadKey));
    appendAnswer(history, "latest-answer", ["u2"], threadKey);

    const { sync, presentation } = project(history, threadKey);
    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(presentation?.currentResponses.map((row) => row.response.currentMessageId)).toEqual([
      "older-answer",
      "latest-answer",
    ]);
    expect(presentation?.quizGroups).toEqual([{ hostTurnId: "raw-u1", questIds: ["q-42"] }]);
  });

  it("keeps a recent shared answer visible when historical Main support exceeds the cap", () => {
    // This models the live failure: 33 retained answer rows and 28 distinct
    // original prompts fit the initial cap (61), but 20 historical source
    // boundaries inflate all-history support to 81. The latest complete answer
    // set needs only a few records and must remain visible in both destinations.
    const history: BrowserIncomingMessage[] = [];
    for (let index = 1; index <= 27; index += 1) {
      history.push(human(`u${index}`, "main", index === 27 ? ["q-42"] : []));
      if (index <= 20) {
        history.push({
          type: "user_message",
          id: `history-source-${index}`,
          content: "Background work completed.",
          timestamp: history.length + 1,
          threadKey: "main",
          agentSource: { sessionId: "timer:history", sessionLabel: "History timer" },
        });
      }
      appendAnswer(history, `historical-answer-${index}`, [`u${index}`], "main");
      if (index <= 5) appendAnswer(history, `complement-${index}`, [`u${index}`], "main");
    }
    history.push(human("u28", "q-42"));
    const answer = appendAnswer(history, "recent-shared-answer", ["u27", "u28"], "q-42");
    const global = buildLeaderThreadResponseState({ id: "leader", messageHistory: history }, "main").projection;
    expect(global.currentAnswers).toHaveLength(33);
    expect(
      new Set(global.currentAnswers.flatMap((row) => [row.currentMessageId, ...row.referencedUserMessageIds])).size,
    ).toBe(61);

    for (const threadKey of ["main", "q-42"]) {
      const { sync, feed, presentation } = project(history, threadKey);
      expect(sync.threadResponseSupportComplete).toBe(true);
      expect(presentation?.currentResponses.map((row) => row.response.currentMessageId)).toEqual([
        "historical-answer-27",
        "recent-shared-answer",
      ]);
      expect(feed.messages.filter((row) => row.id === answer.message.id)).toHaveLength(1);
      expect(sync.threadResponseProjection?.currentAnswers.at(-1)?.coveredAnswerUserMessageIds).toEqual(
        threadKey === "main" ? ["u27"] : ["u28"],
      );
      expect(
        sync.entries.some(
          ({ message }) => message.type === "assistant" && message.message.id === "historical-answer-1",
        ),
      ).toBe(false);
    }

    // A newer unrelated prompt stays globally pending, even though retained
    // answer support is now local to this latest window.
    history.push(human("u29", "main"));
    const pending = project(history, "main");
    expect(pending.sync.threadResponseProjection).toMatchObject({
      pendingMessageCount: 1,
      pendingMessages: [{ userMessageId: "u29" }],
      ready: false,
    });
    expect(pending.presentation).not.toBeNull();
    expect(pending.sync.threadResponseProjection?.currentAnswers.at(-1)?.coveredAnswerUserMessageIds).toEqual(["u27"]);
  });

  it("projects the same source row through every prompt's tabs and keeps coverage local", () => {
    const { history, answer } = fixture();
    for (const threadKey of ["main", "q-11", "q-12", "q-22", "q-23", "q-30"]) {
      const { state, sync, feed, presentation } = project(history, threadKey);
      expect(sync.threadResponseSupportComplete).toBe(true);
      expect(presentation?.currentResponses).toHaveLength(1);
      const row = presentation!.currentResponses[0]!;
      expect(row.messageEntry.msg.id).toBe(answer.message.id);
      expect(row.messageEntry.msg.content).toBe("\nExact answer shared-answer\n");
      expect(feed.messages.filter((message) => message.id === answer.message.id)).toHaveLength(1);
      expect(row.referencedUserMessages?.map((message) => message.userMessageId)).toEqual(["u2", "u1"]);
      expect(row.response.coveredAnswerUserMessageIds).toEqual(
        threadKey === "main" ? ["u1"] : threadKey === "q-22" ? ["u2"] : [],
      );
      expect(state.pendingMessageCount).toBe(threadKey === "main" ? 1 : 0);
      // Foreign prompts are retained only as bounded proof, not attached into
      // another tab's visible feed or used as its answer-placement anchor.
      const visiblePrompts = feed.messages.filter((message) => message.role === "user").map((message) => message.id);
      if (["q-11", "q-12"].includes(threadKey)) expect(visiblePrompts).toEqual(["raw-u1"]);
      if (["q-22", "q-23"].includes(threadKey)) expect(visiblePrompts).toEqual(["raw-u2"]);
      if (threadKey === "q-30") expect(visiblePrompts).toEqual([]);
    }
    expect(project(history, "q-99").state.currentAnswers).toEqual([]);
  });

  it("retains complementary rows after per-request supersession without borrowing another owner's coverage", () => {
    const { history } = fixture();
    appendAnswer(history, "later-answer", ["u1"], "q-11");
    const main = project(history, "main");
    expect(
      main.presentation?.currentResponses.map((item) => [
        item.response.currentMessageId,
        item.response.coveredAnswerUserMessageIds,
      ]),
    ).toEqual([
      ["shared-answer", []],
      ["later-answer", ["u1"]],
    ]);
    const secondOwner = project(history, "q-22");
    expect(
      secondOwner.presentation?.currentResponses.map((item) => [
        item.response.currentMessageId,
        item.response.coveredAnswerUserMessageIds,
      ]),
    ).toEqual([["shared-answer", ["u2"]]]);
    // Persistence/replay reproduces the same IDs and per-owner projection.
    expect(project(JSON.parse(JSON.stringify(history)), "main").state).toEqual(main.state);
  });

  it("drops stale generated destination refs while preserving the authored tab", () => {
    const { history, first } = fixture();
    first.threadRefs = first.threadRefs?.filter((ref) => ref.threadKey !== "q-11");
    const detached = project(history, "q-11");
    expect(detached.state.currentAnswers).toEqual([]);
    expect(
      detached.sync.entries.some(
        ({ message }) => message.type === "assistant" && message.message.id === "shared-answer",
      ),
    ).toBe(false);
    expect(detached.feed.messages.some((message) => message.id === "shared-answer")).toBe(false);
    expect(project(history, "q-12").presentation?.currentResponses).toHaveLength(1);
    expect(project(history, "q-30").presentation?.currentResponses).toHaveLength(1);
  });

  it("fails bounded proof closed for an omitted prompt, stale owner, or malformed partition", () => {
    const { history, answer } = fixture();
    const state = buildLeaderThreadResponseState({ id: "leader", messageHistory: history }, "q-11").projection;
    const input = {
      messageHistory: history,
      threadKey: "q-11",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
      currentThreadResponseProjection: state,
    };
    const incomplete = buildThreadWindowSync({ ...input, includeMessage: (_message, index) => index !== 1 });
    expect(incomplete.threadResponseSupportComplete).toBe(false);
    expect(
      incomplete.entries.some(
        ({ message }) => message.type === "assistant" && message.message.id === answer.message.id,
      ),
    ).toBe(false);
    expect(incomplete.entries.some(({ message }) => message.type === "user_message" && message.id === "raw-u2")).toBe(
      false,
    );
    const originalGroups = answer.threadAnswer!.ownerGroups;
    answer.threadAnswer!.ownerGroups = [{ threadKey: "main", userMessageIds: ["u1", "u2"] }];
    expect(buildThreadWindowSync(input).threadResponseSupportComplete).toBe(false);
    answer.threadAnswer!.ownerGroups = [{ threadKey: "main", userMessageIds: ["u1"] }];
    expect(buildThreadWindowSync(input).threadResponseSupportComplete).toBe(false);
    answer.threadAnswer!.ownerGroups = originalGroups;
  });

  it("keeps foreign prompt support out of ordinary fallback when a grouped answer exceeds the budget", () => {
    // The destination shares only u1. Failed atomic support must not expose
    // either the auto-routed answer or unrelated original prompts as feed rows.
    const history: BrowserIncomingMessage[] = [human("u1", "main", ["q-11"])];
    const ids = ["u1"];
    for (let index = 2; index <= THREAD_WINDOW_SUPPORT_RECORD_LIMIT; index += 1) {
      ids.push(`u${index}`);
      history.push(human(`u${index}`, "q-22"));
    }
    appendAnswer(history, "over-budget-answer", ids, "main");
    const { sync, feed, presentation } = project(history, "q-11");
    expect(sync.threadResponseSupportComplete).toBe(false);
    expect(presentation).toBeNull();
    expect(feed.messages.map((message) => message.id)).toEqual(["raw-u1"]);
  });
});
