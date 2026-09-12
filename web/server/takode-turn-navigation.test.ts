import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import {
  buildPeekRangeForContainingMessage,
  buildPeekRangeForTurnNumber,
  buildPeekTurnScan,
} from "./takode-messages.js";
import { findTurnBoundaries, turnNavigationEnd } from "./turn-boundaries.js";

const user = (id: string): BrowserIncomingMessage => ({ type: "user_message", id, content: id, timestamp: 1 });
const assistant = (index: number): BrowserIncomingMessage => ({
  type: "assistant",
  timestamp: index + 2,
  parent_tool_use_id: null,
  message: {
    id: `reply-${index}`,
    type: "message",
    role: "assistant",
    model: "fixture",
    content: [{ type: "text", text: `reply ${index}` }],
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

describe("bounded turn inspection", () => {
  it("does not let old unclosed turns absorb later requests or claim completion", () => {
    // Consecutive user rows occur during steering/recovery without a result for
    // each logical input. Their navigation ranges must still be disjoint.
    const history = [user("old"), assistant(0), user("later"), assistant(1)];
    const boundaries = findTurnBoundaries(history);
    expect(boundaries[0]?.endIdx).toBe(-1);
    expect(turnNavigationEnd(history, boundaries[0]!)).toBe(1);
    expect(buildPeekRangeForContainingMessage(history, 3)).toMatchObject({
      ok: true,
      response: { from: 2, to: 3, turn: { number: 1, from: 2, to: 3, completed: false } },
    });
    const scan = buildPeekTurnScan(history);
    expect(scan.turns[0]).toMatchObject({ si: 0, ei: 1, result: "reply 0", stats: { tools: 0, messages: 1 } });
    expect(scan.turns[0]?.success).toBeUndefined();
  });

  it("includes a distant anchor and pages both directions without crossing its turn", () => {
    // Use a long producer-shaped history so a superficially correct short-turn
    // fixture cannot hide ignored count or an anchor omitted from its own page.
    const history = [
      user("old"),
      user("target"),
      ...Array.from({ length: 130 }, (_, i) => assistant(i)),
      user("successor"),
    ];
    const lookup = buildPeekRangeForContainingMessage(history, 100, { count: 7 });
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.response.messages).toHaveLength(7);
    expect(lookup.response.messages.some((message) => message.idx === 100)).toBe(true);
    const first = lookup.response.messages[0]!.idx;
    const previous = buildPeekRangeForTurnNumber(history, 1, { until: first - 1, count: 7 });
    expect(previous.ok && previous.response.messages.at(-1)!.idx).toBe(first - 1);
    let cursor = 1;
    const seen: number[] = [];
    while (cursor <= 131) {
      const page = buildPeekRangeForTurnNumber(history, 1, { from: cursor, count: 7 });
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      expect(page.response.messages.length).toBeLessThanOrEqual(7);
      seen.push(...page.response.messages.map((message) => message.idx));
      const next = page.response.to + 1;
      expect(next).toBeGreaterThan(cursor); // explicit progress invariant
      cursor = next;
    }
    expect(seen).toEqual(Array.from({ length: 131 }, (_, i) => i + 1));
  });

  it("keeps diagnostic rows with their owner and continuation rows separate", () => {
    const diagnostic = { ...user("diagnostic"), agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" } };
    const continuation = { ...user("continuation"), agentSource: { sessionId: "system:codex-turn-recovery:original" } };
    const history = [user("original"), assistant(0), diagnostic, continuation, assistant(1)];
    expect(buildPeekRangeForContainingMessage(history, 2)).toMatchObject({ ok: true, response: { from: 0, to: 2 } });
    expect(buildPeekRangeForContainingMessage(history, 4)).toMatchObject({ ok: true, response: { from: 3, to: 4 } });
  });

  it("bounds sparse and thread-filtered pages and rejects invalid page cursors", () => {
    const history = [
      user("old"),
      { ...user("target"), threadKey: "q-9000" },
      { ...assistant(1), threadKey: "q-9000" },
      user("next"),
    ];
    expect(buildPeekRangeForContainingMessage(history, 2, { count: 1, threadKey: "q-9000" })).toMatchObject({
      ok: true,
      response: { messages: [{ idx: 2 }] },
    });
    expect(buildPeekRangeForContainingMessage(history, 2, { threadKey: "main" })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(buildPeekRangeForTurnNumber(history, 1, { from: 3 })).toMatchObject({ ok: false, status: 400 });
    expect(buildPeekRangeForTurnNumber(history, 1, { count: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(buildPeekRangeForTurnNumber(history, 1, { from: 1, until: 2 })).toMatchObject({ ok: false, status: 400 });
  });
});
