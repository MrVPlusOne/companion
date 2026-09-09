import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
} from "../server/leader-thread-response.js";
import { updateLeaderThreadStatusesForAssistantOutput } from "../server/bridge/thread-routing-reminder.js";
import { parseThreadStatusMarkerLine } from "./thread-status-marker.js";
import { buildThreadWindowSync, THREAD_WINDOW_SUPPORT_RECORD_LIMIT } from "./thread-window.js";
import { leaderResponseProvenCurrentOwnerThreadKey } from "./leader-thread-response-routing.js";
import { normalizeHistoryMessageToChatMessages } from "../src/utils/history-message-normalization.js";
import { filterMessagesForThread } from "../src/utils/thread-projection.js";
import { buildFeedMessageModel } from "../src/utils/feed-render-model.js";
import { originalThreadRequest } from "./test-fixtures/original-thread-visibility.js";

type Assistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function answer(history: BrowserIncomingMessage[], userId: string, threadKey = "q-42"): Assistant {
  const entry: Assistant = {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp: history.length * 10 + 10,
    threadKey,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] }),
    leaderThreadRole: "answer",
    leaderAnswerUserMessageIds: [userId],
    leaderAnswerObservedHistoryLength: history.length,
    message: {
      id: `answer-${history.length}`,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text: "The requested release plan is ready for discussion." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  history.push(entry);
  expect(finalizeRoutedLeaderResponseMessage({ id: "fixture-leader", messageHistory: history }, entry).finalized).toBe(
    true,
  );
  return entry;
}

function project(history: BrowserIncomingMessage[], threadKey: string, targetMessageId?: string) {
  const projection =
    threadKey === "all"
      ? undefined
      : buildLeaderThreadResponseState({ id: "fixture-leader", messageHistory: history }, threadKey).projection;
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey,
    fromItem: -1,
    itemCount: 1,
    sectionItemCount: 1,
    visibleItemCount: 1,
    currentThreadResponseProjection: projection,
    targetMessageId,
  });
  const normalized = sync.entries.flatMap((entry) =>
    normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
  );
  return { sync, projection, visible: filterMessagesForThread(normalized, threadKey) };
}

describe("original-thread message visibility", () => {
  it.each([
    ["main", "explicit"],
    ["main", "inferred"],
    ["main", "backfill"],
    ["q-41", "explicit"],
    ["q-41", "inferred"],
    ["q-41", "backfill"],
  ] as const)("keeps a %s source after %s association without changing its owner or raw record", (origin, source) => {
    // A captured handoff retains the direct original route while appending an ownership ref.
    // Both window delivery and the browser projection must keep the original identity.
    const request = originalThreadRequest(origin, source);
    const history: BrowserIncomingMessage[] = [request];
    const before = JSON.stringify(history);
    for (const threadKey of [origin, "q-42", "all"]) {
      const { sync, visible } = project(history, threadKey);
      expect(sync.entries.filter((entry) => entry.message === request)).toHaveLength(1);
      expect(visible.filter((entry) => entry.id === request.id)).toHaveLength(1);
      expect(visible[0]).toMatchObject({ content: request.content, timestamp: request.timestamp, historyIndex: 0 });
    }
    expect(leaderResponseProvenCurrentOwnerThreadKey(request)).toBe(source === "backfill" ? origin : "q-42");
    expect(JSON.stringify(history)).toBe(before);
  });

  it("preserves quest-only responsibility and existing decision/queued-input Ready gates", () => {
    // Displaying the original request cannot recreate an obligation in Main.
    const request = originalThreadRequest();
    const session = { id: "fixture-leader", messageHistory: [request], state: { leaderThreadStatuses: {} } };
    expect(project(session.messageHistory, "main").visible.some((row) => row.id === request.id)).toBe(true);
    expect(buildLeaderThreadResponseState(session, "main").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, "q-42").projection.pendingMessageCount).toBe(1);
    const markReady = (target: typeof session, threadKey: string) =>
      updateLeaderThreadStatusesForAssistantOutput(
        target,
        [parseThreadStatusMarkerLine(`{[(Thread Ready: ${threadKey} | complete)]}`)!],
        { messageId: "ready-marker", timestamp: 10 },
      );
    expect(markReady(session, "main").records).toHaveLength(1);
    expect(markReady(session, "q-42").records).toEqual([]);
    const withDecision = {
      ...session,
      notifications: [
        {
          id: "n-1",
          category: "needs-input" as const,
          timestamp: 4,
          messageId: "decision",
          threadKey: "main",
          done: false,
        },
      ],
    };
    expect(markReady(withDecision, "main").records).toEqual([]);
    const withQueuedInput = {
      ...session,
      pendingCodexInputs: [
        {
          id: "queued",
          content: "Another Main request",
          timestamp: 5,
          cancelable: true,
          threadKey: "main",
          leaderUserMessageId: "u2",
          leaderResponseCoverageVersion: 1 as const,
        },
      ],
    };
    expect(markReady(withQueuedInput, "main").records).toEqual([]);
  });

  it.each([
    "main",
    "q-41",
  ])("retains the same settled answer in the original %s thread with destination-only coverage", (origin) => {
    // Use the real finalizer rather than inventing frontend answer-owner proof.
    const request = originalThreadRequest(origin);
    const history: BrowserIncomingMessage[] = [request];
    const response = answer(history, "u1");
    const proof = structuredClone(response.threadAnswer);
    const restored: BrowserIncomingMessage[] = JSON.parse(JSON.stringify(history));
    for (const threadKey of [origin, "q-42"]) {
      const { sync, projection, visible } = project(restored, threadKey);
      expect(sync.threadResponseSupportComplete).toBe(true);
      expect(visible.filter((row) => row.id === request.id)).toHaveLength(1);
      expect(visible.filter((row) => row.id === response.message.id)).toHaveLength(1);
      expect(projection?.currentAnswers[0]?.coveredAnswerUserMessageIds).toEqual(threadKey === "q-42" ? ["u1"] : []);
    }
    expect(restored.filter((row) => row.type === "user_message" && row.id === request.id)).toHaveLength(1);
    expect(response.threadAnswer).toEqual(proof);
  });

  it("renders a pre-existing quest-authored answer with its original request in Main", () => {
    // The reported stored answer predates source retention: its direct route
    // is still the quest, with destination ownerGroups and no Main backfill.
    const request = originalThreadRequest();
    const history: BrowserIncomingMessage[] = [request];
    const response = answer(history, "u1");
    Object.assign(response, {
      threadKey: "q-42",
      questId: "q-42",
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit", attachedAt: 10 }],
    });
    const before = JSON.stringify(history);
    const { sync } = project(history, "main");
    const delivered = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );
    const feed = buildFeedMessageModel({
      leaderSessionId: "fixture-leader",
      threadKey: "main",
      projectThreadRoutes: true,
      allMessages: [],
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages: delivered,
      threadResponseState: sync.threadResponseProjection,
    });
    expect(feed.messages.filter((row) => row.id === request.id)).toHaveLength(1);
    expect(feed.messages.filter((row) => row.id === response.message.id)).toHaveLength(1);
    expect(sync.threadResponseProjection?.currentAnswers[0]?.coveredAnswerUserMessageIds).toEqual([]);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("navigates to an older original message with bounded complete proof and unchanged chronology", () => {
    const source = originalThreadRequest();
    const history: BrowserIncomingMessage[] = [source];
    const originalAnswer = answer(history, "u1");
    // Many later, answered Main turns exercise the real bounded-window selection.
    for (let index = 2; index <= 42; index++) {
      history.push({
        ...originalThreadRequest(),
        id: `later-${index}`,
        leaderUserMessageId: `u${index}`,
        timestamp: history.length * 10 + 10,
        threadRefs: [],
      });
      answer(history, `u${index}`, "main");
    }
    const { sync, visible } = project(history, "main", source.id);
    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(sync.entries.length).toBeLessThan(THREAD_WINDOW_SUPPORT_RECORD_LIMIT);
    expect(sync.window.has_newer_items).toBe(true);
    expect(visible.filter((row) => row.id === source.id)).toHaveLength(1);
    expect(visible.findIndex((row) => row.id === source.id)).toBeLessThan(
      visible.findIndex((row) => row.id === originalAnswer.message.id),
    );
    expect(sync.entries.map((entry) => entry.history_index)).toEqual(
      [...sync.entries.map((entry) => entry.history_index)].sort((a, b) => a - b),
    );
  });
});
