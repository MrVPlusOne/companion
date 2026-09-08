// @vitest-environment jsdom

import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserOutgoingMessage, HistoryWindowState, ThreadWindowState } from "../types.js";
import { useMessageFeedBoundedConversation, useMessageFeedFollowState } from "./message-feed-bounded-conversation.js";
import { useThreadWindowRequester } from "./message-feed-thread-window-request.js";

const sendToSession = vi.hoisted(() => vi.fn((_id: string, _message: BrowserOutgoingMessage) => true));
vi.mock("../ws.js", () => ({ sendToSession }));

const window: ThreadWindowState = {
  thread_key: "main",
  from_item: 0,
  item_count: 12,
  total_items: 12,
  has_older_items: false,
  has_newer_items: false,
  source_history_length: 30,
  section_item_count: 10,
  visible_item_count: 3,
};

beforeEach(() => sendToSession.mockClear());

describe("bounded conversation follow intent", () => {
  it("announces latest capacity rather than a short resolved slice, and observes both follow transitions", () => {
    // A -1/30 request can resolve to only twelve rows. That must not become a
    // pinned 0/12 subscription that loses later sends on authoritative refresh.
    const { result } = renderHook(() => {
      const follow = useMessageFeedFollowState(true);
      useMessageFeedBoundedConversation({
        sessionId: "follow-session",
        connectionStatus: "connected",
        normalizedThreadKey: "main",
        selectedFeedWindowEnabled: true,
        activeHistoryWindow: null,
        activeThreadWindow: window,
        ...follow,
      });
      return follow;
    });
    expect(sendToSession).toHaveBeenLastCalledWith("follow-session", expect.objectContaining({ from: -1, count: 30 }));
    act(() => result.current.setAutoFollowEnabled(false));
    expect(sendToSession).toHaveBeenLastCalledWith("follow-session", expect.objectContaining({ from: 0, count: 30 }));
    act(() => result.current.setAutoFollowEnabled(true));
    expect(sendToSession).toHaveBeenLastCalledWith("follow-session", expect.objectContaining({ from: -1, count: 30 }));
    const announcements = sendToSession.mock.calls.length;
    act(() => result.current.setAutoFollowEnabled(true));
    expect(sendToSession).toHaveBeenCalledTimes(announcements);
  });

  it("reads layout-established history intent before announcing, without shrinking a larger window", () => {
    // Viewport restoration runs in layout effects. The passive announcement
    // must not briefly publish the render's stale initial latest-follow value.
    const older = {
      ...window,
      from_item: 200,
      item_count: 180,
      total_items: 500,
      has_older_items: true,
      has_newer_items: true,
    };
    renderHook(() => {
      const follow = useMessageFeedFollowState(true);
      useMessageFeedBoundedConversation({
        sessionId: "follow-session",
        connectionStatus: "connected",
        normalizedThreadKey: "main",
        selectedFeedWindowEnabled: true,
        activeHistoryWindow: null,
        activeThreadWindow: older,
        ...follow,
      });
      useLayoutEffect(() => follow.setAutoFollowEnabled(false), [follow.setAutoFollowEnabled]);
    });
    expect(sendToSession).toHaveBeenCalledTimes(1);
    expect(sendToSession).toHaveBeenLastCalledWith(
      "follow-session",
      expect.objectContaining({ from: 200, count: 180 }),
    );
  });

  it("applies the same latest capacity contract to history windows", () => {
    renderHook(() => {
      const follow = useMessageFeedFollowState(true);
      useMessageFeedBoundedConversation({
        sessionId: "history-follow",
        connectionStatus: "connected",
        normalizedThreadKey: "all",
        selectedFeedWindowEnabled: false,
        activeThreadWindow: null,
        ...follow,
        activeHistoryWindow: {
          from_turn: 0,
          turn_count: 2,
          total_turns: 2,
          has_older_items: false,
          has_newer_items: false,
          start_index: 0,
          section_turn_count: 10,
          visible_section_count: 3,
        },
      });
    });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "history-follow",
      expect.objectContaining({ view: "history", from: -1, count: 30 }),
    );
  });

  it("preserves a target request until replacement and repairs capacity after same-content revalidation", () => {
    const { result, rerender } = renderHook(
      ({ applied }) => {
        const follow = useMessageFeedFollowState(true);
        const bounded = useMessageFeedBoundedConversation({
          sessionId: "target-follow",
          connectionStatus: "connected",
          normalizedThreadKey: "main",
          selectedFeedWindowEnabled: true,
          activeHistoryWindow: null,
          activeThreadWindow: applied,
          ...follow,
        });
        const request = useThreadWindowRequester({
          sessionId: "target-follow",
          normalizedThreadKey: "main",
          activeThreadWindow: applied,
          sectionTurnCount: 10,
          setPendingInitialThreadWindowKey: vi.fn(),
          onWindowRequest: bounded.noteWindowRequest,
        });
        return { ...follow, request };
      },
      { initialProps: { applied: window } },
    );

    act(() => {
      result.current.setAutoFollowEnabled(false);
      result.current.request(-1, 12, "older-target");
    });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "target-follow",
      expect.objectContaining({
        type: "thread_window_request",
        target_message_id: "older-target",
      }),
    );
    rerender({ applied: { ...window } });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "target-follow",
      expect.objectContaining({
        type: "conversation_view_update",
        from: 0,
        count: 30,
      }),
    );

    // A cheap revalidation can activate the short resolved count. Even when
    // the response has unchanged contents, the full latest budget must return.
    act(() => result.current.setAutoFollowEnabled(true));
    act(() => {
      result.current.request(-1, 12);
    });
    rerender({ applied: { ...window } });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "target-follow",
      expect.objectContaining({
        type: "conversation_view_update",
        from: -1,
        count: 30,
      }),
    );
  });

  it("clears history-request suppression after disconnect and never suppresses a failed request", () => {
    const history: HistoryWindowState = {
      from_turn: 0,
      turn_count: 2,
      total_turns: 2,
      has_older_items: false,
      has_newer_items: false,
      start_index: 0,
      section_turn_count: 10,
      visible_section_count: 3,
    };
    const { result, rerender } = renderHook(
      ({ connectionStatus }) => {
        const follow = useMessageFeedFollowState(true);
        const bounded = useMessageFeedBoundedConversation({
          sessionId: "history-reconnect",
          connectionStatus,
          normalizedThreadKey: "all",
          selectedFeedWindowEnabled: false,
          activeThreadWindow: null,
          activeHistoryWindow: history,
          ...follow,
        });
        return { ...follow, ...bounded };
      },
      { initialProps: { connectionStatus: "connected" } },
    );
    act(() => {
      result.current.requestHistoryWindow(0, 2, 10, 3, "older-target");
      result.current.setAutoFollowEnabled(false);
    });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "history-reconnect",
      expect.objectContaining({
        type: "history_window_request",
        target_message_id: "older-target",
      }),
    );
    // The disconnected socket no longer owns an active request. Reconnect must
    // reannounce even when its first applied window is the same cached object.
    rerender({ connectionStatus: "disconnected" });
    rerender({ connectionStatus: "connected" });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "history-reconnect",
      expect.objectContaining({
        type: "conversation_view_update",
        from: 0,
        count: 30,
      }),
    );
    sendToSession.mockReturnValueOnce(false);
    act(() => {
      expect(result.current.requestHistoryWindow(1, 2, 10, 3)).toBe(false);
      result.current.setAutoFollowEnabled(true);
    });
    expect(sendToSession).toHaveBeenLastCalledWith(
      "history-reconnect",
      expect.objectContaining({
        type: "conversation_view_update",
        from: -1,
        count: 30,
      }),
    );
  });
});
