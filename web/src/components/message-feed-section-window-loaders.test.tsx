// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ThreadWindowState } from "../types.js";
import { useMessageFeedSectionWindowLoaders } from "./message-feed-section-window-loaders.js";

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

describe("useMessageFeedSectionWindowLoaders", () => {
  it("cancels exact restore only for explicit boundary controls", () => {
    const order: string[] = [];
    const requestThreadWindow = vi.fn(() => {
      order.push("request");
      return true;
    });
    const onUserNavigationIntent = vi.fn(() => order.push("intent"));
    const { result } = renderHook(() =>
      useMessageFeedSectionWindowLoaders({
        activeHistoryWindow: null,
        activeThreadWindow: makeWindow(),
        normalizedThreadKey: "main",
        pendingRequestKeyRef: { current: null },
        setAutoFollowEnabled: vi.fn(),
        previousSectionStartIndex: null,
        nextSectionStartIndex: null,
        latestVisibleSectionStartIndex: 0,
        markPending: () => true,
        moveSectionWindow: vi.fn(),
        requestHistoryWindow: vi.fn(() => true),
        requestThreadWindow,
        setShowScrollButton: vi.fn(),
        onUserNavigationIntent,
      }),
    );

    act(() => result.current.handleLoadNewerSection());
    expect(order).toEqual(["request"]);

    order.length = 0;
    act(() => result.current.explicitSectionLoad.newer());
    expect(order).toEqual(["intent", "request"]);
  });
});
