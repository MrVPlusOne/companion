// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ThreadWindowState } from "../types.js";
import { useUserMessageNavigation } from "./message-feed-user-navigation-hook.js";
import type { UserNavigationTarget } from "./message-feed-user-navigation.js";

function makeWindow(): ThreadWindowState {
  return {
    thread_key: "main",
    from_item: 245,
    item_count: 30,
    total_items: 304,
    has_older_items: true,
    has_newer_items: true,
    source_history_length: 19_087,
    section_item_count: 10,
    visible_item_count: 3,
  };
}

describe("useUserMessageNavigation", () => {
  it("retires saved restore ownership before requesting an off-window stable target", () => {
    const order: string[] = [];
    const target: UserNavigationTarget = {
      key: "turn:user-1787696375620-129",
      turnId: "user-1787696375620-129",
      blockId: "turn:user-1787696375620-129",
      messageId: "user-1787696375620-129",
      content: "Copied-live target 130",
      role: "user",
      starred: false,
      timestamp: 1_787_696_375_620,
      navigationIndex: 129,
      historyIndex: 18_817,
    };
    const requestThreadWindow = vi.fn((_fromItem, _itemCount, targetMessageId) => {
      order.push(`request:${targetMessageId}`);
    });
    const onUserNavigationIntent = vi.fn(() => order.push("intent"));
    const contentRoot = document.createElement("div");

    const { result } = renderHook(() =>
      useUserMessageNavigation({
        containerRef: { current: document.createElement("div") },
        contentRootRef: { current: contentRoot },
        userNavigationTargets: [target],
        activeHistoryWindow: null,
        activeThreadWindow: makeWindow(),
        normalizedThreadKey: "main",
        visibleWindowSignature: "window-117",
        setAutoFollowEnabled: vi.fn(),
        markSectionLoadPending: () => true,
        requestThreadWindow,
        requestHistoryWindow: vi.fn(),
        ensureSectionForTurnVisible: () => false,
        scrollToFeedBlock: vi.fn(),
        scrollToBottom: vi.fn(),
        onUserNavigationIntent,
      }),
    );

    act(() => result.current.handleSelectUserNavigationTarget(target));

    expect(order).toEqual(["intent", `request:${target.messageId}`]);
    expect(onUserNavigationIntent).toHaveBeenCalledTimes(1);
    expect(requestThreadWindow).toHaveBeenCalledWith(expect.any(Number), 30, target.messageId);
  });
});
