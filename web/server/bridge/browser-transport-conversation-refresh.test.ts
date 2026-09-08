import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../session-types.js";
import { finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";
import { refreshBrowserConversationViews, type BrowserTransportSessionLike } from "./browser-transport-controller.js";
import { recordBoundedConversationViewUpdate } from "./browser-conversation-window-policy.js";

function threadSocket(threadKey: string) {
  return {
    data: {
      sessionId: "refresh-session",
      subscribed: true,
      conversationView: {
        kind: "thread" as const,
        request: {
          threadKey,
          fromItem: -1,
          itemCount: 30,
          sectionItemCount: 10,
          visibleItemCount: 3,
        },
      },
    },
    send: vi.fn(),
  };
}

function parseCalls(socket: ReturnType<typeof threadSocket>) {
  return socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
}

function sessionWithTwelveRanges(socket: ReturnType<typeof threadSocket>): BrowserTransportSessionLike {
  return {
    id: "refresh-session",
    browserSockets: new Set([socket]),
    nextEventSeq: 1,
    messageHistory: Array.from({ length: 12 }, (_, index) => ({
      type: "user_message",
      id: `earlier-${index}`,
      content: "Earlier thread input",
      timestamp: index + 1,
      threadKey: "q-1",
      questId: "q-1",
      ...(index % 3 ? { agentSource: { sessionId: "herd-events", sessionLabel: "Herd" } } : {}),
    })),
  } as BrowserTransportSessionLike;
}

function directUser(): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: "new-user",
    content: "Continue the work",
    timestamp: 20,
    threadKey: "q-1",
    questId: "q-1",
    threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "explicit" }],
    leaderResponseCoverageVersion: 1,
    leaderUserMessageId: "u1",
  };
}

function assistant(id: string): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp: 21,
    parent_tool_use_id: null,
    threadKey: "q-1",
    questId: "q-1",
    threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "explicit" }],
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "New assistant activity" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function refreshedWindow(session: BrowserTransportSessionLike, socket: ReturnType<typeof threadSocket>) {
  socket.send.mockClear();
  refreshBrowserConversationViews(session);
  return parseCalls(socket).find((message) => message.type === "thread_window_sync") as Extract<
    BrowserIncomingMessage,
    { type: "thread_window_sync" }
  >;
}

function deliveredIds(window: ReturnType<typeof refreshedWindow>) {
  return window.entries.flatMap(({ message }) => {
    if (message.type === "user_message") return message.id ? [message.id] : [];
    return message.type === "assistant" ? [message.message.id] : [];
  });
}

describe("browser conversation refresh", () => {
  it("refreshes each socket from its own selected view without serializing the full conversation", () => {
    const first = threadSocket("q-1");
    const second = threadSocket("q-2");
    const poisonedOutsideBothViews = {
      type: "user_message",
      id: "main-poison",
      content: "unselected main content",
      timestamp: 3,
      // If refresh regresses to whole-history serialization, this makes the test
      // fail before any payload can be mistaken for bounded evidence.
      toJSON() {
        throw new Error("unselected history must not be serialized");
      },
    } as unknown as BrowserIncomingMessage;
    const session = {
      id: "refresh-session",
      browserSockets: new Set([first, second]),
      nextEventSeq: 11,
      messageHistory: [
        {
          type: "user_message",
          id: "q-1-message",
          content: "first selected view",
          timestamp: 1,
          threadKey: "q-1",
          questId: "q-1",
        } as BrowserIncomingMessage,
        {
          type: "user_message",
          id: "q-2-message",
          content: "second selected view",
          timestamp: 2,
          threadKey: "q-2",
          questId: "q-2",
        } as BrowserIncomingMessage,
        poisonedOutsideBothViews,
      ],
    } as BrowserTransportSessionLike;

    expect(() => refreshBrowserConversationViews(session)).not.toThrow();

    const firstCalls = parseCalls(first);
    const secondCalls = parseCalls(second);
    expect(firstCalls.map((message) => message.type)).toEqual(["thread_window_sync", "conversation_sync_complete"]);
    expect(secondCalls.map((message) => message.type)).toEqual(["thread_window_sync", "conversation_sync_complete"]);
    expect(firstCalls[0]).toMatchObject({
      thread_key: "q-1",
      entries: [expect.objectContaining({ message: expect.objectContaining({ id: "q-1-message" }) })],
    });
    expect(secondCalls[0]).toMatchObject({
      thread_key: "q-2",
      entries: [expect.objectContaining({ message: expect.objectContaining({ id: "q-2-message" }) })],
    });
    expect(firstCalls[1]).toEqual({ type: "conversation_sync_complete", through_seq: 11 });
    expect(secondCalls[1]).toEqual({ type: "conversation_sync_complete", through_seq: 11 });
    expect(session.nextEventSeq).toBe(12);

    const forbiddenOrdinaryFrames = new Set(["feed_window_sync", "message_history", "history_sync"]);
    expect([...firstCalls, ...secondCalls].some((message) => forbiddenOrdinaryFrames.has(message.type))).toBe(false);

    first.send.mockClear();
    second.send.mockClear();
    refreshBrowserConversationViews(session);
    expect(parseCalls(first).at(-1)).toEqual({ type: "conversation_sync_complete", through_seq: 12 });
    expect(parseCalls(second).at(-1)).toEqual({ type: "conversation_sync_complete", through_seq: 12 });
    expect(session.nextEventSeq).toBe(13);
  });

  it.each([false, true])("applies a browser announcement before new input with latest-follow=%s", (followLatest) => {
    const socket = threadSocket("q-1");
    const session = sessionWithTwelveRanges(socket);
    const initial = refreshedWindow(session, socket);
    expect(initial.window).toMatchObject({ from_item: 0, item_count: 12, total_items: 12, has_newer_items: false });

    // The real browser announces after the initial response. Reusing resolved
    // 0/12 pins this small history; latest/-1 must retain the requested 30 budget.
    recordBoundedConversationViewUpdate(socket.data, {
      type: "conversation_view_update",
      view: "thread",
      thread_key: "q-1",
      from: followLatest ? -1 : initial.window.from_item,
      count: followLatest ? 30 : initial.window.item_count,
      section_count: 10,
      visible_count: 3,
    });

    session.messageHistory.push(directUser());
    const echo = refreshedWindow(session, socket);
    // Pending response proof can retain the new prompt even in the pinned slice.
    expect(deliveredIds(echo)).toContain("new-user");
    expect(echo.window.has_newer_items).toBe(false);

    session.messageHistory.push(assistant("new-activity"));
    const active = refreshedWindow(session, socket);
    expect(active.window).toMatchObject({
      from_item: 0,
      item_count: followLatest ? 13 : 12,
      total_items: 13,
      has_newer_items: !followLatest,
    });
    expect(deliveredIds(active).includes("new-activity")).toBe(followLatest);

    const answer = assistant("new-answer");
    answer.leaderThreadRole = "answer";
    answer.leaderAnswerUserMessageIds = ["u1"];
    answer.leaderAnswerObservedHistoryLength = session.messageHistory.length;
    session.messageHistory.push(answer);
    expect(finalizeRoutedLeaderResponseMessage(session, answer)).toMatchObject({ finalized: true });
    const answered = refreshedWindow(session, socket);
    // Finalizing coverage removes the pending-only escape hatch. The latest
    // announcement must still retain both the sent prompt and its accepted answer.
    expect(deliveredIds(answered).includes("new-user")).toBe(followLatest);
    expect(deliveredIds(answered).includes("new-answer")).toBe(followLatest);
    expect(answered.window.has_newer_items).toBe(!followLatest);
  });

  it("keeps an explicitly announced older numeric range anchored while new activity arrives", () => {
    const socket = threadSocket("q-1");
    const session = sessionWithTwelveRanges(socket);
    refreshedWindow(session, socket);
    recordBoundedConversationViewUpdate(socket.data, {
      type: "conversation_view_update",
      view: "thread",
      thread_key: "q-1",
      from: 2,
      count: 3,
      section_count: 1,
      visible_count: 3,
    });
    session.messageHistory.push(directUser(), assistant("new-activity"));
    const older = refreshedWindow(session, socket);
    // Server refresh respects intentional reading bounds; pending proof may be
    // attached without shifting that range or treating the browser as latest-following.
    expect(older.window).toMatchObject({ from_item: 2, item_count: 3, total_items: 13, has_newer_items: true });
    expect(deliveredIds(older)).toEqual(expect.arrayContaining(["earlier-2", "earlier-3", "earlier-4"]));
    expect(deliveredIds(older)).not.toContain("new-activity");
    expect(socket.data.conversationView.request).toMatchObject({ fromItem: 2, itemCount: 3 });
  });
});
