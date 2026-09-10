import { describe, expect, it } from "vitest";
import { buildThreadContinuationFixture } from "../../shared/test-fixtures/thread-continuation.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { buildFeedMessageModel } from "./feed-render-model.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

describe("continuation lifetime across window and live delivery", () => {
  it.each(["main", "q-42"] as const)("clears and replaces %s notices before the next snapshot", (threadKey) => {
    // Start with the actual window producer and deliver only the appended raw
    // events after it. No invented browser history or return-state flag is used.
    const fixture = buildThreadContinuationFixture(threadKey);
    const snapshot = buildThreadWindowSync({
      messageHistory: fixture.away,
      threadKey,
      fromItem: -1,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const selectedFeedWindowMessages = snapshot.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );
    const input = {
      leaderSessionId: "continuation-feed",
      threadKey,
      projectThreadRoutes: true,
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: snapshot.window,
      selectedFeedWindowMessages,
      allMessages: [],
    };
    const first = buildFeedMessageModel(input);
    const markers = (model: ReturnType<typeof buildFeedMessageModel>) =>
      model.messages.filter((message) => message.metadata?.threadTransitionMarker);
    expect(markers(first)).toHaveLength(1);
    for (const [history, count] of [
      [fixture.returned, 0],
      [fixture.departedAgain, 1],
    ] as const) {
      const model = buildFeedMessageModel({
        ...input,
        allMessages: history.flatMap((message, index) =>
          index >= fixture.away.length ? normalizeHistoryMessageToChatMessages(message, index) : [],
        ),
      });
      expect(markers(model)).toHaveLength(count);
      if (count) expect(markers(model)[0].id).not.toBe(markers(first)[0].id);
      const realBefore = first.messages.filter((message) => !message.metadata?.threadTransitionMarker);
      expect(model.messages).toEqual(expect.arrayContaining(realBefore));
    }
    // Selecting an unrelated tab then coming back does not mutate notice state.
    buildFeedMessageModel({ ...input, threadKey: "all" });
    expect(markers(buildFeedMessageModel(input))).toEqual(markers(first));
  });
});
