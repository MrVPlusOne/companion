import type { BrowserIncomingMessage } from "./session-types.js";
import { findTurnBoundaries, turnNavigationEnd } from "./turn-boundaries.js";

export interface TurnInspectionRange {
  number: number;
  from: number;
  to: number;
  completed: boolean;
}

export interface TurnInspectionPageOptions {
  count?: number;
  from?: number;
  until?: number;
}

/** Resolve a finite turn and one page, keeping navigation separate from completion. */
export function resolveTurnInspection(
  history: BrowserIncomingMessage[],
  target: { messageIndex: number } | { turn: number },
  options: TurnInspectionPageOptions,
):
  | { ok: true; range: TurnInspectionRange; page: TurnInspectionPageOptions }
  | { ok: false; status: 400 | 404; error: string } {
  const byMessage = "messageIndex" in target;
  const index = byMessage ? target.messageIndex : target.turn;
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, status: 400, error: `${byMessage ? "turnContaining" : "turn"} must be a non-negative integer` };
  }
  if (byMessage && index >= history.length) {
    return { ok: false, status: 404, error: `Message index ${index} out of range (0-${history.length - 1})` };
  }
  const turns = findTurnBoundaries(history);
  const number = byMessage
    ? turns.findIndex((turn) => index >= turn.startIdx && index <= turnNavigationEnd(history, turn))
    : index;
  const turn = turns[number];
  if (!turn) {
    const error = byMessage
      ? `Message index ${index} is not contained in a turn`
      : `Turn ${index} not found. Session has ${turns.length} turns (0-${turns.length - 1}).`;
    return { ok: false, status: 404, error };
  }
  const range = { number, from: turn.startIdx, to: turnNavigationEnd(history, turn), completed: turn.endIdx >= 0 };
  const count = options.count ?? 60;
  if (!Number.isSafeInteger(count) || count < 1) {
    return { ok: false, status: 400, error: "count must be a positive integer" };
  }
  if (options.from !== undefined && options.until !== undefined) {
    return { ok: false, status: 400, error: "Use either from or until to page within a turn" };
  }
  const cursor = options.from ?? options.until;
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < range.from || cursor > range.to)) {
    return { ok: false, status: 400, error: `Page cursor must be within turn ${number} (${range.from}-${range.to})` };
  }
  const from = options.from ?? Math.max(range.from, index - Math.floor(count / 2));
  const page =
    options.until !== undefined
      ? { until: options.until, count }
      : { from: cursor ?? (byMessage ? from : range.from), count };
  return { ok: true, range, page };
}
