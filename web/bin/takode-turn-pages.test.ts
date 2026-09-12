import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePeek } from "./takode-message-commands.js";
import { buildPeekRangeForContainingMessage, buildPeekRangeForTurnNumber } from "../server/takode-messages.js";
import type { BrowserIncomingMessage } from "../server/session-types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("turn page CLI", () => {
  it("sends count/cursors and prints server-owned page links in text and JSON modes", async () => {
    // The fake HTTP boundary uses the actual server projection. All history is
    // synthetic, and no socket, live session, or provider process is accessed.
    const history: BrowserIncomingMessage[] = [
      { type: "user_message", id: "old", content: "old unclosed request", timestamp: 1 },
      { type: "user_message", id: "target", content: "target request", timestamp: 2 },
      ...Array.from(
        { length: 100 },
        (_, i): BrowserIncomingMessage => ({
          type: "assistant",
          timestamp: i + 3,
          parent_tool_use_id: null,
          message: {
            id: `reply-${i}`,
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [{ type: "text", text: `reply ${i}` }],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
      ),
    ];
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        expect(url.origin).toBe("http://fixture.invalid");
        paths.push(url.pathname + url.search);
        const count = Number(url.searchParams.get("count"));
        const from = url.searchParams.has("from") ? Number(url.searchParams.get("from")) : undefined;
        const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : undefined;
        const options = { count, from, until };
        const result = url.searchParams.has("turnContaining")
          ? buildPeekRangeForContainingMessage(history, Number(url.searchParams.get("turnContaining")), options)
          : buildPeekRangeForTurnNumber(history, Number(url.searchParams.get("turn")), options);
        expect(result.ok).toBe(true);
        return Response.json(
          result.ok ? { sid: "fixture", sn: 1, name: "Fixture", status: "idle", ...result.response } : result,
        );
      }),
    );
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      printed.push(args.join(" "));
    });
    await handlePeek("http://fixture.invalid", ["fixture", "--turn-containing", "73", "--count", "5"]);
    expect(paths[0]).toContain("turnContaining=73&count=5");
    expect(printed.filter((line) => /^\s+\[\d+\]/.test(line))).toHaveLength(5);
    expect(printed.join("\n")).toContain("Turn 1: [1]-[101] (no result recorded)");
    expect(printed.join("\n")).toContain("--turn 1 --until 70 --count 5");
    expect(printed.join("\n")).toContain("--turn 1 --from 76 --count 5");
    printed.length = 0;
    await handlePeek("http://fixture.invalid", ["fixture", "--turn", "1", "--from", "76", "--count", "5", "--json"]);
    expect(paths[1]).toContain("turn=1&count=5&from=76");
    const page = JSON.parse(printed.join("\n"));
    expect(page.messages.map((message: { idx: number }) => message.idx)).toEqual([76, 77, 78, 79, 80]);
    expect(page.turn).toMatchObject({ number: 1, from: 1, to: 101, completed: false });
  });
});
