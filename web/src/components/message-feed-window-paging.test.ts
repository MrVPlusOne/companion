import { describe, expect, it } from "vitest";
import {
  HISTORY_WINDOW_SECTION_TURN_COUNT,
  HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
} from "../../shared/history-window.js";
import { getHistoryBoundaryWindowRequest, getThreadBoundaryWindowRequest } from "./message-feed-window-paging.js";
import type { HistoryWindowState, ThreadWindowState } from "../types.js";

function makeHistoryWindow(overrides: Partial<HistoryWindowState> = {}): HistoryWindowState {
  return {
    from_turn: 370,
    turn_count: 30,
    total_turns: 400,
    has_older_items: true,
    has_newer_items: false,
    start_index: 0,
    section_turn_count: 10,
    visible_section_count: 3,
    ...overrides,
  };
}

function makeThreadWindow(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  return {
    thread_key: "main",
    from_item: 370,
    item_count: 30,
    total_items: 400,
    has_older_items: true,
    has_newer_items: false,
    source_history_length: 800,
    section_item_count: 10,
    visible_item_count: 3,
    ...overrides,
  };
}

describe("message feed window paging", () => {
  it("uses ten-item render sections with the existing three-section initial window", () => {
    // Larger boundary loads must not increase the cost of opening the latest conversation.
    expect(HISTORY_WINDOW_SECTION_TURN_COUNT).toBe(10);
    expect(HISTORY_WINDOW_VISIBLE_SECTION_COUNT).toBe(3);
    expect(HISTORY_WINDOW_SECTION_TURN_COUNT * HISTORY_WINDOW_VISIBLE_SECTION_COUNT).toBe(30);
  });

  it("loads older selected-thread content in six-section steps up to the eighteen-section cap", () => {
    // Keep the existing 30-range initial delivery, then amortize paging with 90/150/180 ranges.
    expect(getThreadBoundaryWindowRequest(makeThreadWindow(), "older")).toEqual({
      fromItem: 310,
      itemCount: 90,
    });

    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 310, item_count: 90 }), "older")).toEqual({
      fromItem: 250,
      itemCount: 150,
    });
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 250, item_count: 150 }), "older")).toEqual({
      fromItem: 190,
      itemCount: 180,
    });
  });

  it("keeps selected-thread windows bounded while moving through nearby newer ranges", () => {
    // At the cap, a direction change preserves 120 of 180 source ranges and never grows the bound.
    const window = makeThreadWindow({ from_item: 100, item_count: 180 });
    const newer = getThreadBoundaryWindowRequest(window, "newer");
    expect(newer).toEqual({
      fromItem: 160,
      itemCount: 180,
    });
    expect(window.from_item + window.item_count - newer!.fromItem).toBe(120);
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 160, item_count: 180 }), "older")).toEqual({
      fromItem: 100,
      itemCount: 180,
    });
  });

  it("mirrors the same older and newer paging policy for raw history windows", () => {
    // Raw-history feeds use the same bounded policy rather than retaining a smaller separate buffer.
    expect(getHistoryBoundaryWindowRequest(makeHistoryWindow(), "older")).toEqual({
      fromTurn: 310,
      turnCount: 90,
    });
    expect(getHistoryBoundaryWindowRequest(makeHistoryWindow({ from_turn: 100, turn_count: 180 }), "newer")).toEqual({
      fromTurn: 160,
      turnCount: 180,
    });
  });

  it("does not request data when the active window already reaches that boundary", () => {
    // Repeated boundary input must stop when no source ranges remain in that direction.
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 0 }), "older")).toBeNull();
    expect(getThreadBoundaryWindowRequest(makeThreadWindow(), "newer")).toBeNull();
  });

  it("takes a shorter final newer step and then stops at the exact latest range", () => {
    // A partial final batch still keeps the retained cap and must not overshoot or loop at the tail.
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 190, item_count: 180 }), "newer")).toEqual({
      fromItem: 220,
      itemCount: 180,
    });
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 220, item_count: 180 }), "newer")).toBeNull();
    expect(getHistoryBoundaryWindowRequest(makeHistoryWindow({ from_turn: 190, turn_count: 180 }), "newer")).toEqual({
      fromTurn: 220,
      turnCount: 180,
    });
    expect(getHistoryBoundaryWindowRequest(makeHistoryWindow({ from_turn: 220, turn_count: 180 }), "newer")).toBeNull();
  });

  it("takes a shorter final older step without dropping below the retained buffer", () => {
    // Near the beginning, clamp the start while preserving nearby content and the hard retained cap.
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 20, item_count: 180 }), "older")).toEqual({
      fromItem: 0,
      itemCount: 180,
    });
    expect(getThreadBoundaryWindowRequest(makeThreadWindow({ from_item: 0, item_count: 180 }), "older")).toBeNull();
  });
});
