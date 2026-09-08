import type { HistoryWindowState, ThreadWindowState } from "../types.js";

export type FeedWindowLoadDirection = "older" | "newer";

// Sparse collapsed history needs more retained context for short scroll reversals.
// Initial subscriptions still use three sections; only boundary paging grows this buffer.
export const FEED_WINDOW_LOAD_STEP_SECTION_COUNT = 6;
export const FEED_WINDOW_MAX_RETAINED_SECTION_COUNT = 18;

export interface BoundaryWindowRange {
  from: number;
  count: number;
}

interface BoundaryWindowRangeInput {
  from: number;
  count: number;
  total: number;
  sectionSize: number;
  direction: FeedWindowLoadDirection;
}

export function getBoundaryWindowRange(input: BoundaryWindowRangeInput): BoundaryWindowRange | null {
  const total = normalizedNonNegativeInt(input.total);
  const sectionSize = normalizedPositiveInt(input.sectionSize);
  const currentFrom = Math.min(normalizedNonNegativeInt(input.from), Math.max(0, total - 1));
  const currentCount = Math.min(normalizedPositiveInt(input.count), Math.max(1, total - currentFrom));
  const currentEnd = Math.min(total, currentFrom + currentCount);
  if (total === 0) return null;

  const stepSize = sectionSize * FEED_WINDOW_LOAD_STEP_SECTION_COUNT;
  const maxRetainedCount = sectionSize * FEED_WINDOW_MAX_RETAINED_SECTION_COUNT;

  if (input.direction === "older") {
    if (currentFrom <= 0) return null;
    const nextFrom = Math.max(0, currentFrom - stepSize);
    const desiredCount = Math.max(currentCount, currentEnd - nextFrom);
    const nextCount = Math.min(total - nextFrom, Math.min(maxRetainedCount, desiredCount));
    return nextFrom === currentFrom && nextCount === currentCount ? null : { from: nextFrom, count: nextCount };
  }

  if (currentEnd >= total) return null;
  const nextEnd = Math.min(total, currentEnd + stepSize);
  const desiredCount = Math.max(currentCount, nextEnd - currentFrom);
  const nextCount = Math.min(nextEnd, Math.min(maxRetainedCount, desiredCount));
  const nextFrom = Math.max(0, nextEnd - nextCount);
  return nextFrom === currentFrom && nextCount === currentCount ? null : { from: nextFrom, count: nextCount };
}

export function getHistoryBoundaryWindowRequest(
  window: HistoryWindowState,
  direction: FeedWindowLoadDirection,
): { fromTurn: number; turnCount: number } | null {
  const range = getBoundaryWindowRange({
    from: window.from_turn,
    count: window.turn_count,
    total: window.total_turns,
    sectionSize: window.section_turn_count,
    direction,
  });
  return range ? { fromTurn: range.from, turnCount: range.count } : null;
}

export function getThreadBoundaryWindowRequest(
  window: ThreadWindowState,
  direction: FeedWindowLoadDirection,
): { fromItem: number; itemCount: number } | null {
  const range = getBoundaryWindowRange({
    from: window.from_item,
    count: window.item_count,
    total: window.total_items,
    sectionSize: window.section_item_count,
    direction,
  });
  return range ? { fromItem: range.from, itemCount: range.count } : null;
}

function normalizedPositiveInt(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function normalizedNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
