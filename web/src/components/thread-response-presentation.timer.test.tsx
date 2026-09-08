// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, vi } from "vitest";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
} from "../../server/leader-thread-response.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import type { BrowserIncomingMessage } from "../types.js";
import { buildFeedModel } from "../hooks/use-feed-model.js";
import { normalizeHistoryMessageToChatMessages } from "../utils/history-message-normalization.js";
import { buildFeedSections } from "./message-feed-sections.js";
import { resolveThreadResponses } from "./thread-response-presentation.js";
import { ReadyThreadResponseRows } from "./ReadyThreadResponseRows.js";

vi.mock("../api.js", () => ({ api: {} }));

function route(threadKey: string) {
  return {
    threadKey,
    ...(threadKey === "main"
      ? {}
      : {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit" as const }],
        }),
  };
}

function firing(
  id: string,
  ordinal: number,
  threadKey: string,
): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id,
    timestamp: ordinal,
    content: "[⏰ Timer t2 reminder] Daily build report\n\nSummarize the completed build checks.",
    agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
    leaderTimerMessageId: `timer-m${ordinal}`,
    ...route(threadKey),
  };
}

function human(id: string, threadKey: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: `raw-${id}`,
    timestamp: 0,
    content: `Unrelated human request ${id}`,
    leaderResponseCoverageVersion: 1,
    leaderUserMessageId: id,
    ...route(threadKey),
  };
}

function appendAnswer(history: BrowserIncomingMessage[], id: string, ids: string[], threadKey: string) {
  const answer: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp: 100 + history.length,
    leaderThreadRole: "answer",
    codexMessagePhase: "final_answer",
    ...route(threadKey),
    leaderAnswerUserMessageIds: ids,
    leaderAnswerObservedHistoryLength: history.length,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: `Substantive report ${id}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  history.push(answer);
  expect(finalizeRoutedLeaderResponseMessage({ id: "timer-leader", messageHistory: history }, answer).finalized).toBe(
    true,
  );
  return answer;
}

function selected(history: BrowserIncomingMessage[], threadKey: string, itemCount = 1) {
  // The frontend consumes finalized server answers and a bounded wire window,
  // including the full original reference set retained as supporting proof.
  const projection = buildLeaderThreadResponseState(
    { id: "timer-leader", messageHistory: history },
    threadKey,
  ).projection;
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey,
    fromItem: -1,
    itemCount,
    sectionItemCount: 1,
    visibleItemCount: 1,
    currentThreadResponseProjection: projection,
  });
  expect(sync.threadResponseSupportComplete).toBe(true);
  const messages = sync.entries.flatMap(({ message, history_index }) =>
    normalizeHistoryMessageToChatMessages(message, history_index),
  );
  const visible = messages.filter(
    (message) =>
      message.metadata?.threadKey === threadKey ||
      message.metadata?.threadRefs?.some((ref) => ref.threadKey === threadKey),
  );
  const turns = buildFeedModel(visible, true).turns;
  const presentation = resolveThreadResponses(
    buildFeedSections(turns, 10),
    sync.threadResponseProjection,
    threadKey,
    true,
    messages,
  );
  expect(presentation).not.toBeNull();
  return { projection, sync, messages, turns, presentation: presentation! };
}

describe("timer report answer presentation", () => {
  it.each([
    "main",
    "q-42",
  ])("keeps distinct recurring reports and complementary answers in %s with a human request pending", (threadKey) => {
    const history = [human("u1", threadKey), firing("first-firing", 1, threadKey)];
    appendAnswer(history, "first-report", ["timer-m1"], threadKey);
    appendAnswer(history, "first-report-addition", ["timer-m1"], threadKey);
    history.push(firing("second-firing", 2, threadKey));
    appendAnswer(history, "second-report", ["timer-m2"], threadKey);
    history.push(firing("progress-only-firing", 3, threadKey));

    const result = selected(history, threadKey, 10);
    expect(result.presentation.ready).toBe(false);
    expect(result.projection.pendingMessages.map((message) => message.userMessageId)).toEqual(["u1"]);
    expect(
      result.presentation.currentResponses.map((item) => [
        item.response.currentMessageId,
        item.response.coveredAnswerUserMessageIds,
      ]),
    ).toEqual([
      ["first-report", []],
      ["first-report-addition", ["timer-m1"]],
      ["second-report", ["timer-m2"]],
    ]);
    expect(
      result.presentation.currentResponses.map((item) => item.referencedUserMessages?.[0]?.historyMessageId),
    ).toEqual(["first-firing", "first-firing", "second-firing"]);
    expect(result.messages.find((message) => message.id === "first-firing")?.agentSource?.sessionId).toBe("timer:t2");
    expect(result.messages.find((message) => message.id === "second-firing")?.metadata?.leaderTimerMessageId).toBe(
      "timer-m2",
    );
  });

  it.each(["timer-m1", "f1"])("renders the collapsed answer and previews exact timer reference %s", (reference) => {
    // Historical references survive the same server window and preview path;
    // the renderer must display the stored ID without replacing its prefix.
    const timer = firing("first-firing", 1, "q-42");
    timer.leaderTimerMessageId = reference;
    const history = [timer];
    appendAnswer(history, "first-report", [reference], "q-42");
    const result = selected(history, "q-42");
    render(
      <>
        {result.turns.map((turn) => (
          <ReadyThreadResponseRows
            key={turn.id}
            turn={turn}
            presentation={result.presentation}
            sessionId="timer-leader"
            questLinkSurface="chat-feed"
            renderEntry={(entry) => (entry.kind === "message" ? <p>{entry.msg.content}</p> : null)}
          />
        ))}
      </>,
    );
    expect(screen.getByText("Substantive report first-report")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Answers 1 message/ }));
    expect(screen.getByText(reference)).toBeInTheDocument();
    expect(screen.getByTestId("thread-response-covered-message-content")).toHaveTextContent(
      "[⏰ Timer t2 reminder] Daily build report",
    );
  });

  it("preserves exact resumed timer content through finalized answer proof and its firing preview", () => {
    // Automatic delivery can carry this exact server-authored coalescing
    // wrapper. The answer still names the one recorded delivery, and neither
    // selected-window proof nor its preview rewrites the stored reminder.
    const timer = firing("resumed-firing", 1, "q-42");
    timer.content =
      "[Takode auto-pause resumed: 3 similar automatic inputs were coalesced while delivery was paused.]\n\n" +
      timer.content;
    const history: BrowserIncomingMessage[] = [human("u1", "q-42"), timer];
    appendAnswer(history, "resumed-report", ["timer-m1"], "q-42");
    const result = selected(history, "q-42");
    expect(result.projection.pendingMessages.map((message) => message.userMessageId)).toEqual(["u1"]);
    expect(result.messages.find((message) => message.id === timer.id)?.content).toBe(timer.content);
    expect(result.presentation.currentResponses[0]?.referencedUserMessages).toEqual([
      {
        historyMessageId: timer.id,
        userMessageId: "timer-m1",
        content: timer.content,
      },
    ]);
    expect(result.presentation.currentResponses[0]?.collapsedMessageEntry.msg.content).toBe(
      "Substantive report resumed-report",
    );
  });

  it("projects one mixed human/timer answer into its Main and quest destinations without covering unrelated requests", () => {
    const history = [human("u1", "main"), human("u2", "q-42"), firing("quest-firing", 1, "q-42")];
    const answer = appendAnswer(history, "shared-report", ["u1", "timer-m1"], "q-42");
    const main = selected(history, "main");
    const quest = selected(history, "q-42");
    expect(main.projection.pendingMessages).toEqual([]);
    expect(quest.projection.pendingMessages.map((message) => message.userMessageId)).toEqual(["u2"]);
    expect(main.presentation.currentResponses[0]?.response.coveredAnswerUserMessageIds).toEqual(["u1"]);
    expect(quest.presentation.currentResponses[0]?.response.coveredAnswerUserMessageIds).toEqual(["timer-m1"]);
    for (const result of [main, quest]) {
      expect(result.presentation.currentResponses[0]?.messageEntry.msg.id).toBe(answer.message.id);
      expect(
        result.presentation.currentResponses[0]?.referencedUserMessages?.map((message) => message.userMessageId),
      ).toEqual(["u1", "timer-m1"]);
    }
  });

  it("refuses selected-window proof after a firing becomes a cancellation or gains a duplicate firing ID", () => {
    const history = [firing("first-firing", 1, "main")];
    appendAnswer(history, "first-report", ["timer-m1"], "main");
    const projection = buildLeaderThreadResponseState(
      { id: "timer-leader", messageHistory: history },
      "main",
    ).projection;
    const assertRejected = () =>
      expect(
        buildThreadWindowSync({
          messageHistory: history,
          threadKey: "main",
          fromItem: -1,
          itemCount: 1,
          sectionItemCount: 1,
          visibleItemCount: 1,
          currentThreadResponseProjection: projection,
        }).threadResponseSupportComplete,
      ).toBe(false);
    const original = history[0]!;
    history[0] = { ...original, content: "[⏰ Timer t2 cancelled] Daily build report" };
    assertRejected();
    history[0] = original;
    history.push(firing("duplicate-firing", 1, "main"));
    assertRejected();
  });
});
