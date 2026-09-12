import { describe, it, expect } from "vitest";
import {
  buildPeekDefault,
  buildPeekRange,
  buildPeekRangeForContainingMessage,
  buildPeekResponse,
  buildPeekTurnScan,
  buildReadResponse,
  buildToolSummary,
  grepMessageHistory,
  escapeStringLiteral,
  formatQuotedContent,
} from "./takode-messages.js";
import type { BrowserIncomingMessage, CLIResultMessage } from "./session-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a user_message entry for testing. */
function userMsg(content: string, ts: number, id?: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    content,
    timestamp: ts,
    ...(id ? { id } : {}),
  } as BrowserIncomingMessage;
}

/** Create an assistant message entry for testing. */
function assistantMsg(
  textContent: string,
  ts: number,
  toolUses?: { name: string; input: Record<string, unknown> }[],
  parentToolUseId: string | null = null,
): BrowserIncomingMessage {
  const content: unknown[] = [{ type: "text" as const, text: textContent }];
  if (toolUses) {
    for (const t of toolUses) {
      content.push({ type: "tool_use" as const, id: `tu-${t.name}`, name: t.name, input: t.input });
    }
  }
  return {
    type: "assistant",
    message: {
      id: `msg-${ts}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: parentToolUseId,
    timestamp: ts,
  } as BrowserIncomingMessage;
}

function toolResultPreview(
  toolUseId: string,
  content: string,
  options: {
    isError?: boolean;
    durationSeconds?: number;
    syntheticReason?: string;
    retainedOutput?: boolean;
    totalSize?: number;
  } = {},
): BrowserIncomingMessage {
  return {
    type: "tool_result_preview",
    previews: [
      {
        tool_use_id: toolUseId,
        content,
        is_error: options.isError ?? false,
        total_size: options.totalSize ?? content.length,
        is_truncated: options.totalSize !== undefined ? options.totalSize > content.length : false,
        ...(typeof options.durationSeconds === "number" ? { duration_seconds: options.durationSeconds } : {}),
        ...(options.syntheticReason ? { synthetic_reason: options.syntheticReason } : {}),
        ...(typeof options.retainedOutput === "boolean" ? { retained_output: options.retainedOutput } : {}),
      },
    ],
  } as BrowserIncomingMessage;
}

/** Create a result message entry for testing. */
function resultMsg(durationMs: number, isError = false): BrowserIncomingMessage {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result: isError ? "Something went wrong" : "Task completed successfully",
      duration_ms: durationMs,
      duration_api_ms: durationMs - 100,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: `result-${durationMs}`,
      session_id: "test-session",
    } as CLIResultMessage,
  } as BrowserIncomingMessage;
}

/** Create a compact_marker entry. */
function compactMarker(
  summary: string,
  ts: number,
  opts?: { trigger?: "auto" | "manual"; preTokens?: number; markerKind?: "compaction" | "session_recycled" },
): BrowserIncomingMessage {
  return {
    type: "compact_marker",
    timestamp: ts,
    id: `compact-${ts}`,
    ...(summary ? { summary } : {}),
    ...(opts?.markerKind ? { markerKind: opts.markerKind } : {}),
    ...(opts?.trigger ? { trigger: opts.trigger } : {}),
    ...(opts?.preTokens ? { preTokens: opts.preTokens } : {}),
  } as BrowserIncomingMessage;
}

/** Create a permission_approved entry. */
function permissionApproved(toolName: string, summary: string, ts: number): BrowserIncomingMessage {
  return {
    type: "permission_approved",
    id: `approval-${ts}`,
    tool_name: toolName,
    tool_use_id: `tu-${ts}`,
    summary,
    timestamp: ts,
  } as BrowserIncomingMessage;
}

function questLifecycleEvent(kind: "claimed" | "submitted", ts: number): BrowserIncomingMessage {
  return {
    type: "quest_lifecycle_event",
    id: `quest_${kind}-q-2003-worker-${ts}`,
    timestamp: ts,
    kind,
    quest: {
      questId: "q-2003",
      title: "Diagnose recurring alerts",
      status: kind === "claimed" ? "in_progress" : "done",
    },
    threadKey: "q-2003",
    questId: "q-2003",
    threadRefs: [{ threadKey: "q-2003", questId: "q-2003", source: "explicit" }],
  } as BrowserIncomingMessage;
}

function withThread(
  msg: BrowserIncomingMessage,
  threadKey: string,
  options: { statusThreadKey?: string; statusSummary?: string } = {},
): BrowserIncomingMessage {
  const questId = threadKey.startsWith("q-") ? threadKey : undefined;
  return {
    ...msg,
    threadKey,
    ...(questId ? { questId } : {}),
    ...(questId ? { threadRefs: [{ threadKey, questId, source: "explicit" as const }] } : {}),
    ...(options.statusThreadKey
      ? {
          threadStatusMarkers: [
            {
              kind: "waiting" as const,
              label: "Thread Waiting" as const,
              threadKey: options.statusThreadKey,
              questId: options.statusThreadKey.startsWith("q-") ? options.statusThreadKey : undefined,
              summary: options.statusSummary ?? "waiting on work",
              messageId: `status-${threadKey}-${options.statusThreadKey}`,
              timestamp: 1,
              updatedAt: 1,
            },
          ],
        }
      : {}),
  } as BrowserIncomingMessage;
}

// ─── escapeStringLiteral & formatQuotedContent ──────────────────────────────

describe("escapeStringLiteral", () => {
  it("escapes backslashes, double quotes, newlines, tabs, and carriage returns", () => {
    expect(escapeStringLiteral('hello "world"')).toBe('hello \\"world\\"');
    expect(escapeStringLiteral("line1\nline2")).toBe("line1\\nline2");
    expect(escapeStringLiteral("col1\tcol2")).toBe("col1\\tcol2");
    expect(escapeStringLiteral("back\\slash")).toBe("back\\\\slash");
    expect(escapeStringLiteral("cr\rhere")).toBe("cr\\rhere");
  });

  it("handles strings with no special characters", () => {
    expect(escapeStringLiteral("simple text")).toBe("simple text");
  });

  it("handles empty string", () => {
    expect(escapeStringLiteral("")).toBe("");
  });

  it("escapes multiple special characters in sequence", () => {
    expect(escapeStringLiteral('a\n"b"\tc')).toBe('a\\n\\"b\\"\\tc');
  });
});

describe("formatQuotedContent", () => {
  it("wraps short content in double quotes", () => {
    expect(formatQuotedContent("hello", 100)).toBe('"hello"');
  });

  it("escapes special characters inside quotes", () => {
    expect(formatQuotedContent('say "hi"\nthere', 100)).toBe('"say \\"hi\\"\\nthere"');
  });

  it("truncates long content with char count", () => {
    const result = formatQuotedContent("a".repeat(200), 100);
    expect(result).toBe('"' + "a".repeat(100) + '" +100 chars');
  });

  it("does not truncate content at exactly the limit", () => {
    const result = formatQuotedContent("a".repeat(100), 100);
    expect(result).toBe('"' + "a".repeat(100) + '"');
  });

  it("truncates content one char over the limit", () => {
    const result = formatQuotedContent("a".repeat(101), 100);
    expect(result).toBe('"' + "a".repeat(100) + '" +1 chars');
  });
});

// ─── buildToolSummary ─────────────────────────────────────────────────────────

describe("buildToolSummary", () => {
  it("summarizes Bash with truncated command", () => {
    const result = buildToolSummary("Bash", { command: "ls -la /some/very/long/path/that/goes/on/and/on" });
    expect(result).toBe("ls -la /some/very/long/path/that/goes/on/and/on");
  });

  it("truncates long Bash commands at 60 chars", () => {
    const longCmd = "a".repeat(100);
    const result = buildToolSummary("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(80); // 60 + "... [+N chars]" suffix
    expect(result).toContain("... [+40 chars]");
  });

  it("summarizes Edit with basename", () => {
    const result = buildToolSummary("Edit", { file_path: "/home/user/project/server/routes.ts" });
    expect(result).toBe("routes.ts");
  });

  it("summarizes Read with basename", () => {
    const result = buildToolSummary("Read", { file_path: "/home/user/.config/settings.json" });
    expect(result).toBe("settings.json");
  });

  it("summarizes Write with basename and (new) suffix", () => {
    const result = buildToolSummary("Write", { file_path: "/tmp/output.txt" });
    expect(result).toBe("output.txt (new)");
  });

  it("summarizes Glob with pattern", () => {
    const result = buildToolSummary("Glob", { pattern: "**/*.test.ts" });
    expect(result).toBe("**/*.test.ts");
  });

  it("summarizes Grep with pattern", () => {
    const result = buildToolSummary("Grep", { pattern: "TODO|FIXME" });
    expect(result).toBe("TODO|FIXME");
  });

  it("uses first string value for unknown tools", () => {
    const result = buildToolSummary("CustomTool", { url: "https://example.com", count: 42 });
    expect(result).toBe("https://example.com");
  });

  it("returns empty string when no string values in input", () => {
    const result = buildToolSummary("CustomTool", { count: 42, enabled: true });
    expect(result).toBe("");
  });

  it("handles empty file_path gracefully for Edit", () => {
    const result = buildToolSummary("Edit", { file_path: "" });
    expect(result).toBe("");
  });
});

// ─── buildPeekResponse ────────────────────────────────────────────────────────

describe("buildPeekResponse", () => {
  it("returns empty array for empty history", () => {
    const result = buildPeekResponse([], { turns: 1 });
    expect(result).toEqual([]);
  });

  it("extracts a single turn from history", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Hello, help me fix a bug", 1000),
      assistantMsg("I'll help you fix the bug.", 2000),
      resultMsg(5000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);

    const turn = result[0];
    expect(turn.turn).toBe(0);
    expect(turn.start).toBe(1000);
    expect(turn.dur).toBe(5000);
    expect(turn.messages).toHaveLength(3);

    // User message
    expect(turn.messages[0].type).toBe("user");
    expect(turn.messages[0].content).toBe("Hello, help me fix a bug");
    expect(turn.messages[0].idx).toBe(0);

    // Assistant message
    expect(turn.messages[1].type).toBe("assistant");
    expect(turn.messages[1].idx).toBe(1);

    // Result message
    expect(turn.messages[2].type).toBe("result");
    expect(turn.messages[2].success).toBe(true);
    expect(turn.messages[2].dur).toBe(5000);
  });

  it("extracts multiple turns when requested", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("First question", 1000),
      assistantMsg("First answer", 2000),
      resultMsg(3000),
      userMsg("Second question", 4000),
      assistantMsg("Second answer", 5000),
      resultMsg(2000),
    ];

    const result = buildPeekResponse(history, { turns: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].turn).toBe(0);
    expect(result[1].turn).toBe(1);
  });

  it("returns only last N turns from longer history", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Reply 1", 2000),
      resultMsg(1000),
      userMsg("Turn 2", 3000),
      assistantMsg("Reply 2", 4000),
      resultMsg(1000),
      userMsg("Turn 3", 5000),
      assistantMsg("Reply 3", 6000),
      resultMsg(1000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);
    // Should be the last turn (Turn 3)
    expect(result[0].messages[0].content).toBe("Turn 3");
  });

  it("truncates long content in peek mode (full=false)", () => {
    const longText = "x".repeat(600);
    const history: BrowserIncomingMessage[] = [userMsg(longText, 1000), assistantMsg(longText, 2000), resultMsg(1000)];

    const result = buildPeekResponse(history, { turns: 1, full: false });
    // User messages are short but this one is long — should be truncated at 500 chars
    expect(result[0].messages[0].content.length).toBeLessThan(600);
    expect(result[0].messages[0].content).toContain("... [+");
  });

  it("preserves full content when full=true", () => {
    const longText = "x".repeat(200);
    const history: BrowserIncomingMessage[] = [userMsg(longText, 1000), assistantMsg(longText, 2000), resultMsg(1000)];

    const result = buildPeekResponse(history, { turns: 1, full: true });
    expect(result[0].messages[0].content).toBe(longText);
  });

  it("extracts tool calls from assistant messages", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Read the file", 1000),
      assistantMsg("Let me read that file.", 2000, [
        { name: "Read", input: { file_path: "/home/user/server/routes.ts" } },
        { name: "Bash", input: { command: "ls -la" } },
      ]),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const assistantPeek = result[0].messages[1];
    expect(assistantPeek.tools).toHaveLength(2);
    expect(assistantPeek.tools![0].name).toBe("Read");
    expect(assistantPeek.tools![0].summary).toBe("routes.ts");
    expect(assistantPeek.tools![1].name).toBe("Bash");
    expect(assistantPeek.tools![1].summary).toBe("ls -la");
  });

  it("handles in-progress turn (no result yet)", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Do something", 1000),
      assistantMsg("Working on it...", 2000),
      // No result message yet
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].end).toBeUndefined();
    expect(result[0].dur).toBeUndefined();
    expect(result[0].messages).toHaveLength(2);
  });

  it("filters turns by since timestamp", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Old turn", 1000),
      assistantMsg("Old reply", 2000),
      resultMsg(1000),
      userMsg("New turn", 5000),
      assistantMsg("New reply", 6000),
      resultMsg(2000),
    ];

    const result = buildPeekResponse(history, { turns: 10, since: 4000 });
    // Only the second turn should match (started at 5000 >= since 4000)
    expect(result).toHaveLength(1);
    expect(result[0].messages[0].content).toBe("New turn");
  });

  it("includes compact_marker as system type", () => {
    const history: BrowserIncomingMessage[] = [
      compactMarker("Context was compacted", 500),
      userMsg("Continue working", 1000),
      assistantMsg("Sure, continuing.", 2000),
      resultMsg(1000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    // compact_marker is before the turn, so it should not be in the turn
    expect(result).toHaveLength(1);
    // The turn starts at userMsg, compact_marker is at idx 0 which is before startIdx
    expect(result[0].messages[0].type).toBe("user");
  });

  it("includes permission_approved as system message within a turn", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Edit the file", 1000),
      assistantMsg("Let me edit that.", 2000),
      permissionApproved("Edit", "server/routes.ts", 2500),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const systemMsgs = result[0].messages.filter((m) => m.type === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain("Approved: Edit");
  });

  it("handles error result correctly", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Do dangerous thing", 1000),
      assistantMsg("Attempting...", 2000),
      resultMsg(1000, true),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const resultPeek = result[0].messages[2];
    expect(resultPeek.success).toBe(false);
  });

  it("assigns correct idx values from original messageHistory", () => {
    // Stream events and other non-peekable messages are skipped but indices should
    // still reflect the original array position
    const history: BrowserIncomingMessage[] = [
      userMsg("Question", 1000), // idx 0
      { type: "stream_event", event: {}, parent_tool_use_id: null } as BrowserIncomingMessage, // idx 1 - skipped
      assistantMsg("Answer", 2000), // idx 2
      {
        type: "tool_progress",
        tool_use_id: "tu1",
        tool_name: "Bash",
        elapsed_time_seconds: 1,
      } as BrowserIncomingMessage, // idx 3 - skipped
      resultMsg(1000), // idx 4
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result[0].messages[0].idx).toBe(0); // user_message
    expect(result[0].messages[1].idx).toBe(2); // assistant (skipped stream_event at 1)
    expect(result[0].messages[2].idx).toBe(4); // result (skipped tool_progress at 3)
  });

  it("collapses subagent child chatter into the parent assistant preview", () => {
    const subagentResult = JSON.stringify([
      { type: "text", text: "Final agent answer" },
      { type: "text", text: "agentId: worker-1" },
    ]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Investigate the bug", 1000),
      assistantMsg("", 2000, [{ name: "Agent", input: { prompt: "Look into the websocket bug" } }]),
      assistantMsg("streaming child detail", 2500, undefined, "tu-Agent"),
      toolResultPreview("tu-Agent", subagentResult),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result[0].messages).toHaveLength(3);
    expect(result[0].messages[1].type).toBe("assistant");
    expect(result[0].messages[1].content).toBe("Final agent answer");
    expect(result[0].messages[1].tools).toBeUndefined();
    expect(result[0].messages.some((msg) => msg.content.includes("streaming child detail"))).toBe(false);
  });
});

describe("buildPeekDefault", () => {
  it("uses the subagent final result as the collapsed turn preview", () => {
    const subagentResult = JSON.stringify([
      { type: "text", text: "Subagent finished the audit" },
      { type: "text", text: "<usage>tokens</usage>" },
    ]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("", 2000, [{ name: "Agent", input: { prompt: "Audit the websocket path" } }]),
      assistantMsg("child detail", 2500, undefined, "tu-Agent"),
      toolResultPreview("tu-Agent", subagentResult),
      resultMsg(3000),
      userMsg("Turn 2", 6000),
      assistantMsg("Done with follow-up", 7000),
      resultMsg(1000),
    ];

    const result = buildPeekDefault(history);
    expect(result.collapsed).toHaveLength(1);
    expect(result.collapsed[0].result).toBe("Subagent finished the audit");
  });

  it("prefers the turn-local assistant reply over later synthetic subagent preview text", () => {
    const childPreview = JSON.stringify([{ type: "text", text: "Repeated apology from a nested agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Actual first-turn reply", 2000),
      assistantMsg("", 2500, [{ name: "Agent", input: { prompt: "double-check details" } }]),
      toolResultPreview("tu-Agent", childPreview),
      resultMsg(3000),
      userMsg("Turn 2", 7000),
      assistantMsg("Distinct second-turn reply", 8000),
      resultMsg(1000),
    ];

    const result = buildPeekDefault(history);
    expect(result.collapsed).toHaveLength(1);
    expect(result.collapsed[0].result).toBe("Actual first-turn reply");
  });

  it("ignores a trailing injected stop message instead of treating it as a running turn", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Investigate the bug", 1000),
      assistantMsg("Final diagnosis", 2000),
      resultMsg(3000),
      {
        type: "user_message",
        content: "Session stopped by leader #158 Debug stuck worker session",
        timestamp: 5000,
        id: "stop-5000",
        agentSource: { sessionId: "leader-158", sessionLabel: "#158 Debug stuck worker session" },
      } as BrowserIncomingMessage,
    ];

    const result = buildPeekDefault(history);
    expect(result.totalTurns).toBe(1);
    expect(result.expanded?.start).toBe(1000);
    expect(result.expanded?.end).toBe(4000);
    expect(result.expanded?.messages.at(-1)?.type).toBe("result");
  });
});

describe("buildPeekRange", () => {
  it("keeps an idle quest lifecycle event inspectable with its producer route", () => {
    const history = [userMsg("finish", 1000), resultMsg(100), questLifecycleEvent("submitted", 1500)];

    const result = buildPeekRange(history, { from: 0, count: 10, threadKey: "q-2003" });

    expect(result.messages.at(-1)).toMatchObject({
      idx: 2,
      ts: 1500,
      type: "system",
      content: "Quest submitted: Diagnose recurring alerts",
      threadKey: "q-2003",
      questId: "q-2003",
      threadRefs: [expect.objectContaining({ threadKey: "q-2003", questId: "q-2003", source: "explicit" })],
    });
  });

  it("shows the subagent result preview and hides child messages in range mode", () => {
    const subagentResult = JSON.stringify([{ type: "text", text: "Range preview from child agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Range turn", 1000),
      assistantMsg("", 2000, [{ name: "Task", input: { prompt: "Check one narrow thing" } }]),
      assistantMsg("child detail", 2300, undefined, "tu-Task"),
      toolResultPreview("tu-Task", subagentResult),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { from: 0, count: 10 });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].content).toBe("Range preview from child agent");
    expect(result.messages[1].toolCounts).toBeUndefined();
    expect(result.messages.some((msg) => msg.content.includes("child detail"))).toBe(false);
  });

  it("supports inclusive backward paging via until while keeping chronological order", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Answer 1", 2000),
      resultMsg(500),
      userMsg("Turn 2", 4000),
      assistantMsg("Answer 2", 5000),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { until: 4, count: 3 });
    expect(result.from).toBe(2);
    expect(result.to).toBe(4);
    expect(result.messages.map((msg) => msg.idx)).toEqual([2, 3, 4]);

    const previousPage = buildPeekRange(history, { until: result.messages[0].idx, count: 3 });
    expect(previousPage.messages.map((msg) => msg.idx)).toEqual([0, 1, 2]);
  });

  it("accepts from/until as an inclusive explicit range", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Answer 1", 2000),
      resultMsg(500),
      userMsg("Turn 2", 4000),
      assistantMsg("Answer 2", 5000),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { from: 2, until: 4 });
    expect(result.from).toBe(2);
    expect(result.to).toBe(4);
    expect(result.messages.map((msg) => msg.idx)).toEqual([2, 3, 4]);
  });

  it("shows status and orphan diagnostics for single tool calls in range mode", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Check status", 1000),
      assistantMsg("", 2000, [{ name: "Bash", input: { command: "git status --short" } }]),
      resultMsg(500),
      toolResultPreview("tu-Bash", "Terminal command did not deliver a final result after a later tool completed.", {
        durationSeconds: 121.7,
        syntheticReason: "superseded_by_later_completed_tool",
        retainedOutput: false,
      }),
    ];

    const result = buildPeekRange(history, { from: 1, until: 1 });
    expect(result.messages[0]?.tools).toEqual([
      expect.objectContaining({
        name: "Bash",
        summary: "git status --short",
        status: "orphaned",
        durationSeconds: 121.7,
        syntheticReason: "superseded_by_later_completed_tool",
        retainedOutput: false,
        result: "Terminal command did not deliver a final result after a later tool completed.",
      }),
    ]);
  });

  it("adds opt-in context details to peek tool lines", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("inspect quest", 1000),
      assistantMsg("", 1500, [
        { name: "Bash", input: { command: "quest show q-1452", description: "Show quest q-1452" } },
      ]),
      toolResultPreview("tu-Bash", "preview", { totalSize: 29_400 }),
      resultMsg(200),
    ];

    const compact = buildPeekRange(history, { from: 0, count: 10, showTools: true });
    const withContext = buildPeekRange(history, { from: 0, count: 10, showTools: true, includeContext: true });

    expect(compact.messages[1].tools?.[0]).not.toHaveProperty("context");
    expect(withContext.messages[1].tools?.[0]).toMatchObject({
      context: {
        resultBytes: 29_400,
        hiddenResultBytes: 29_393,
        commandFamily: "quest show",
        commandSummary: "Show quest q-1452",
      },
    });
  });

  it("adds opt-in reported usage to peek messages using the latest prior sample", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("inspect quest", 1000),
      assistantMsg("reply", 1500),
      resultMsg(200),
    ];

    const compact = buildPeekRange(history, { from: 0, count: 10 });
    const withContext = buildPeekRange(history, {
      from: 0,
      count: 10,
      includeContext: true,
      contextUsageHistory: [
        { timestamp: 1200, source: "codex_token_usage", contextUsedPercent: 42 },
        { timestamp: 1800, source: "codex_token_usage", contextUsedPercent: 84 },
      ],
    });

    expect(compact.messages[0]).not.toHaveProperty("contextUsage");
    expect(withContext.messages[0].contextUsage).toBeNull();
    expect(withContext.messages[1].contextUsage).toMatchObject({
      timestamp: 1200,
      source: "codex_token_usage",
      contextUsedPercent: 42,
    });
    expect(withContext.messages[2].contextUsage).toMatchObject({
      timestamp: 1200,
      source: "codex_token_usage",
      contextUsedPercent: 42,
    });
  });

  it("filters range output by thread participation while preserving the closing result", () => {
    // Thread filtering must include status-marker participation, not only a
    // message's primary route, because leader turns can update another thread.
    const history: BrowserIncomingMessage[] = [
      withThread(userMsg("main prompt", 1000), "main"),
      assistantMsg("main reply", 1500),
      resultMsg(200),
      withThread(userMsg("quest prompt", 2000), "q-1289"),
      withThread(assistantMsg("mixed reply", 2500), "q-1289", {
        statusThreadKey: "q-1298",
        statusSummary: "waiting on explore",
      }),
      resultMsg(300),
    ];

    const result = buildPeekRange(history, { from: 0, count: 10, threadKey: "q-1298" });

    expect(result.messages.map((msg) => msg.idx)).toEqual([4, 5]);
    expect(result.messages[0]).toMatchObject({
      threadKey: "q-1289",
      threadStatuses: [expect.objectContaining({ threadKey: "q-1298", summary: "waiting on explore" })],
    });
    expect(result.messages[1]).toMatchObject({ type: "result" });
  });

  it("resolves a message index to its containing turn with thread filtering", () => {
    // This supports compact grep rows: callers can jump from a message id to
    // turn context explicitly instead of carrying turn labels on every row.
    const history: BrowserIncomingMessage[] = [
      userMsg("main prompt", 1000),
      withThread(assistantMsg("thread answer", 1500), "q-1300"),
      resultMsg(200),
    ];

    const result = buildPeekRangeForContainingMessage(history, 1, { threadKey: "q-1300" });

    expect(result).toMatchObject({
      ok: true,
      response: {
        mode: "range",
        from: 0,
        to: 2,
        bounds: [{ turn: 0, si: 0, ei: 2 }],
      },
    });
    if (result.ok) {
      expect(result.response.messages.map((message) => message.idx)).toEqual([1, 2]);
    }
  });

  it("preserves reported usage when resolving a containing turn with --context", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("main prompt", 1000),
      assistantMsg("thread answer", 1500),
      resultMsg(200),
    ];

    const result = buildPeekRangeForContainingMessage(history, 1, {
      includeContext: true,
      contextUsageHistory: [
        { timestamp: 1200, source: "codex_token_usage", contextUsedPercent: 42 },
        { timestamp: 1800, source: "codex_token_usage", contextUsedPercent: 84 },
      ],
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.response.messages[0].contextUsage).toBeNull();
      expect(result.response.messages[1].contextUsage).toMatchObject({
        timestamp: 1200,
        source: "codex_token_usage",
        contextUsedPercent: 42,
      });
      expect(result.response.messages[2].contextUsage).toMatchObject({
        timestamp: 1200,
        source: "codex_token_usage",
        contextUsedPercent: 42,
      });
    }
  });

  it("rejects message-to-turn lookup when the message is outside the selected thread", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("main prompt", 1000),
      withThread(assistantMsg("thread answer", 1500), "q-1300"),
      resultMsg(200),
    ];

    const result = buildPeekRangeForContainingMessage(history, 0, { threadKey: "q-1300" });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Message index 0 does not participate in thread q-1300",
    });
  });
});

describe("buildPeekTurnScan", () => {
  it("uses the actual turn-local assistant reply for collapsed summaries", () => {
    const childPreview = JSON.stringify([{ type: "text", text: "Repeated apology from a nested agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Actual first-turn reply", 2000),
      assistantMsg("", 2500, [{ name: "Agent", input: { prompt: "double-check details" } }]),
      toolResultPreview("tu-Agent", childPreview),
      resultMsg(3000),
      userMsg("Turn 2", 7000),
      assistantMsg("Distinct second-turn reply", 8000),
      resultMsg(1000),
      userMsg("Turn 3", 10000),
      assistantMsg("Third-turn reply", 11000),
      resultMsg(1000),
    ];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 3 });
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0].result).toBe("Actual first-turn reply");
    expect(result.turns[1].result).toBe("Distinct second-turn reply");
    expect(result.turns[2].result).toBe("Third-turn reply");
  });

  it("returns a safe empty slice for metadata-only zero-count probes", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("reply", 2000),
      resultMsg(3000),
      userMsg("Turn 2", 4000),
      assistantMsg("reply 2", 5000),
      resultMsg(6000),
    ];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 0 });
    expect(result.totalTurns).toBe(2);
    expect(result.totalMessages).toBe(6);
    expect(result.from).toBe(0);
    expect(result.count).toBe(0);
    expect(result.turns).toEqual([]);
    expect(result.compactionEvents).toBeUndefined();
  });

  it("preserves long turn-start user text so scan can apply its own truncation policy", () => {
    const longUser = `human prompt ${"x".repeat(1200)} USER_SCAN_KEEP ${"y".repeat(900)}`;
    const history: BrowserIncomingMessage[] = [userMsg(longUser, 1000), assistantMsg("reply", 2000), resultMsg(3000)];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 1 });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].user).toContain("USER_SCAN_KEEP");
    expect(result.turns[0].user.length).toBeGreaterThan(1500);
  });

  it("projects compact turn thread metadata and keeps full mixed turn summaries under --thread", () => {
    const history: BrowserIncomingMessage[] = [
      withThread(userMsg("main prompt", 1000), "main"),
      assistantMsg("main reply", 1500),
      resultMsg(200),
      withThread(userMsg("quest prompt", 2000), "q-1289"),
      withThread(assistantMsg("mixed q-1289 reply", 2500), "q-1289", {
        statusThreadKey: "q-1298",
        statusSummary: "waiting on explore",
      }),
      resultMsg(300),
    ];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 10, threadKey: "q-1298" });

    expect(result.totalTurns).toBe(1);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      turn: 1,
      user: "quest prompt",
      result: "mixed q-1289 reply",
      threads: ["q-1289", "q-1298"],
      threadStatuses: [expect.objectContaining({ threadKey: "q-1298", summary: "waiting on explore" })],
    });
  });

  it("adds opt-in observable context summaries to scan turns", () => {
    // Normal scan stays compact; --context reveals payload metrics and the
    // Bash command family that made the turn expensive.
    const history: BrowserIncomingMessage[] = [
      userMsg("inspect quest", 1000),
      assistantMsg("", 1500, [{ name: "Bash", input: { command: "quest show q-1452" } }]),
      toolResultPreview("tu-Bash", "preview", { totalSize: 29_400 }),
      resultMsg(200),
    ];

    const compact = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 1 });
    const withContext = buildPeekTurnScan(history, {
      fromTurn: 0,
      turnCount: 1,
      includeContext: true,
      contextUsageHistory: [
        {
          timestamp: 900,
          source: "codex_token_usage",
          contextUsedPercent: 52,
          contextTokensUsed: 280_000,
          modelContextWindow: 545_000,
        },
      ],
    });

    expect(compact.turns[0]).not.toHaveProperty("context");
    expect(withContext.turns[0].context).toMatchObject({
      reportedUsage: {
        timestamp: 900,
        source: "codex_token_usage",
        contextUsedPercent: 52,
        contextTokensUsed: 280_000,
        modelContextWindow: 545_000,
      },
      toolResultBytes: 29_400,
      hiddenToolResultBytes: 29_393,
      topCommands: [expect.objectContaining({ family: "quest show", calls: 1 })],
    });
  });
});

// ─── buildReadResponse ────────────────────────────────────────────────────────

describe("buildReadResponse", () => {
  it("returns null for out-of-bounds index", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];
    expect(buildReadResponse(history, 5)).toBeNull();
    expect(buildReadResponse(history, -1)).toBeNull();
  });

  it("reads a user message with full content", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello world\nSecond line\nThird line", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.idx).toBe(0);
    expect(result.type).toBe("user_message");
    expect(result.ts).toBe(1000);
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe("Hello world\nSecond line\nThird line");
  });

  it("reads an assistant message with text and tool blocks", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Let me help.", 1000, [{ name: "Bash", input: { command: "ls -la" } }]),
    ];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("assistant");
    expect(result.content).toContain("Let me help.");
    expect(result.content).toContain("[Tool: Bash]");
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks!.length).toBe(2); // text + tool_use
  });

  it("reads a result message", () => {
    const history: BrowserIncomingMessage[] = [resultMsg(5000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("result");
    expect(result.content).toContain("Task completed successfully");
  });

  it("reads a result message with errors", () => {
    const history: BrowserIncomingMessage[] = [resultMsg(1000, true)];

    const result = buildReadResponse(history, 0)!;
    expect(result.content).toContain("Something went wrong");
  });

  it("paginates content by lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
    const history: BrowserIncomingMessage[] = [userMsg(lines.join("\n"), 1000)];

    // Get lines 3-5 (offset=2, limit=3)
    const result = buildReadResponse(history, 0, { offset: 2, limit: 3 })!;
    expect(result.totalLines).toBe(10);
    expect(result.offset).toBe(2);
    expect(result.limit).toBe(3);
    expect(result.content).toBe("Line 3\nLine 4\nLine 5");
  });

  it("handles offset beyond total lines", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Short message", 1000)];

    const result = buildReadResponse(history, 0, { offset: 100, limit: 10 })!;
    expect(result.totalLines).toBe(1);
    expect(result.content).toBe("");
  });

  it("does not include contentBlocks for non-assistant messages", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.contentBlocks).toBeUndefined();
  });

  it("adds compact thread metadata without requiring raw-message inspection", () => {
    const history: BrowserIncomingMessage[] = [
      withThread(assistantMsg("threaded reply", 1000), "q-1300", {
        statusThreadKey: "q-1300",
        statusSummary: "waiting on review",
      }),
    ];

    const result = buildReadResponse(history, 0)!;

    expect(result).toMatchObject({
      threadKey: "q-1300",
      questId: "q-1300",
      threadRefs: [expect.objectContaining({ threadKey: "q-1300", source: "explicit" })],
      threadStatuses: [expect.objectContaining({ threadKey: "q-1300", summary: "waiting on review" })],
    });
  });

  it("reads a compact_marker message", () => {
    const history: BrowserIncomingMessage[] = [compactMarker("Context was compacted to save tokens", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("compact_marker");
    expect(result.content).toBe("Context was compacted to save tokens");
  });

  it("reads a session recycled marker without calling it compacted", () => {
    const history: BrowserIncomingMessage[] = [compactMarker("", 1000, { markerKind: "session_recycled" })];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("compact_marker");
    expect(result.content).toBe("[Session recycled]");
    expect(result.content).not.toContain("compacted");
  });

  it("reads a permission_approved message", () => {
    const history: BrowserIncomingMessage[] = [permissionApproved("Edit", "server/routes.ts +15 lines", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("permission_approved");
    expect(result.content).toContain("Approved: Edit");
  });

  it("reads a quest lifecycle event with exact type, timestamp, and route", () => {
    const result = buildReadResponse([questLifecycleEvent("claimed", 1200)], 0)!;

    expect(result).toMatchObject({
      type: "quest_lifecycle_event",
      ts: 1200,
      content: "Quest claimed: Diagnose recurring alerts",
      threadKey: "q-2003",
      questId: "q-2003",
      threadRefs: [expect.objectContaining({ threadKey: "q-2003", questId: "q-2003", source: "explicit" })],
    });
  });

  it("defaults offset to 0 and limit to 200", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(200);
  });

  it("expands a parent subagent message to the full stored tool result", () => {
    const preview = JSON.stringify([{ type: "text", text: "Short preview" }]);
    const full = JSON.stringify([
      { type: "text", text: "Full subagent answer" },
      { type: "text", text: "agentId: worker-2" },
    ]);
    const history: BrowserIncomingMessage[] = [
      assistantMsg("", 1000, [{ name: "Agent", input: { prompt: "Write the summary" } }]),
      toolResultPreview("tu-Agent", preview),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) => (toolUseId === "tu-Agent" ? { content: full, is_error: false } : null),
    })!;

    expect(result.content).toBe("Full subagent answer");
    expect(result.content).not.toContain("[Tool: Agent]");
    expect(result.content).not.toContain("agentId:");
  });

  it("pairs non-subagent tool calls with their full results via getToolResult", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Let me check.", 1000, [
        { name: "Bash", input: { command: "ls -la" } },
        { name: "Read", input: { file_path: "/tmp/foo.txt" } },
      ]),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) => {
        if (toolUseId === "tu-Bash") return { content: "file1.ts\nfile2.ts", is_error: false };
        if (toolUseId === "tu-Read") return { content: "hello world", is_error: false };
        return null;
      },
    })!;

    expect(result.content).toContain("[Tool: Bash]");
    expect(result.content).toContain("[Tool Result] file1.ts\nfile2.ts");
    expect(result.content).toContain("[Tool: Read]");
    expect(result.content).toContain("[Tool Result] hello world");
  });

  it("pairs tool calls with truncated preview when full result unavailable", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Reading file.", 1000, [{ name: "Read", input: { file_path: "/tmp/big.txt" } }]),
      toolResultPreview("tu-Read", "last 300 chars..."),
    ];
    // Patch the preview to be truncated
    const previews = (history[1] as any).previews;
    previews[0].is_truncated = true;
    previews[0].total_size = 45000;

    const result = buildReadResponse(history, 0)!;

    expect(result.content).toContain("[Tool: Read]");
    expect(result.content).toContain("[Tool Result] last 300 chars...");
    expect(result.content).toContain("[truncated, 45000 bytes total]");
  });

  it("shows tool error prefix for failed tool results", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Running command.", 1000, [{ name: "Bash", input: { command: "bad-cmd" } }]),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) =>
        toolUseId === "tu-Bash" ? { content: "command not found: bad-cmd", is_error: true } : null,
    })!;

    expect(result.content).toContain("[Tool Error] command not found: bad-cmd");
  });

  it("renders tool call without result when no result is available", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Checking.", 1000, [{ name: "Bash", input: { command: "echo hi" } }]),
    ];

    const result = buildReadResponse(history, 0)!;

    expect(result.content).toContain("[Tool: Bash]");
    // No result line should appear
    expect(result.content).not.toContain("[Tool Result]");
    expect(result.content).not.toContain("[Tool Error]");
  });

  it("returns tool_result_preview content when reading a preview message directly", () => {
    // tool_result_preview messages are not peekable (filtered from peek/scan),
    // but they are accessible via read by index and should show actual content
    const history: BrowserIncomingMessage[] = [
      userMsg("Question", 1000),
      assistantMsg("Working on it", 2000),
      toolResultPreview("tu-1", "file contents here"),
    ];

    const result = buildReadResponse(history, 2)!;
    expect(result.type).toBe("tool_result_preview");
    expect(result.content).toContain("[Tool Result] file contents here");
  });
});

// ─── grepMessageHistory ───────────────────────────────────────────────────────

describe("grepMessageHistory", () => {
  const history: BrowserIncomingMessage[] = [
    userMsg("How do I combine image and quality filters?", 1000),
    assistantMsg("You can use the pipe operator to combine them.", 2000),
    resultMsg(500),
  ];

  it("returns matches for a valid regex pattern", () => {
    const result = grepMessageHistory(history, "pipe");
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].snippet).toContain("pipe");
    expect(result.warning).toBeUndefined();
  });

  it("supports ERE alternation with |", () => {
    const result = grepMessageHistory(history, "image|quality");
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.warning).toBeUndefined();
  });

  // Backslash-pipe (\|) matches a literal pipe in JS regex, not alternation.
  // When this yields 0 matches, a warning should help the user.
  it("warns when \\| pattern returns zero matches", () => {
    const result = grepMessageHistory(history, "image\\|quality");
    expect(result.totalMatches).toBe(0);
    expect(result.warning).toMatch(/literal pipe/);
    expect(result.warning).toContain('"|"');
  });

  // If \| actually matches content (message contains a literal pipe), no warning.
  it("does not warn when \\| pattern finds matches", () => {
    const historyWithPipe: BrowserIncomingMessage[] = [userMsg("image|quality is a valid filter", 1000)];
    const result = grepMessageHistory(historyWithPipe, "image\\|quality");
    expect(result.totalMatches).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("does not warn for zero matches without \\|", () => {
    const result = grepMessageHistory(history, "nonexistent_xyz");
    expect(result.totalMatches).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to literal match for invalid regex", () => {
    // Unbalanced bracket is invalid regex -- should fall back to literal match
    const historyWithBracket: BrowserIncomingMessage[] = [userMsg("array[0 is broken syntax", 1000)];
    const result = grepMessageHistory(historyWithBracket, "array[0");
    expect(result.totalMatches).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("filters matches by thread metadata and includes compact thread fields", () => {
    const threadedHistory: BrowserIncomingMessage[] = [
      withThread(userMsg("needle in main", 1000), "main"),
      withThread(userMsg("needle in quest", 2000), "q-1300"),
      withThread(assistantMsg("needle in mixed status", 3000), "q-1289", {
        statusThreadKey: "q-1300",
        statusSummary: "waiting on implementation",
      }),
    ];

    const result = grepMessageHistory(threadedHistory, "needle", { threadKey: "q-1300" });

    expect(result.totalMatches).toBe(2);
    expect(result.matches.map((match) => match.idx)).toEqual([1, 2]);
    expect(result.matches[0]).toMatchObject({ threadKey: "q-1300", threads: ["q-1300"] });
    expect(result.matches[1]).toMatchObject({
      threadKey: "q-1289",
      threads: ["q-1289", "q-1300"],
      threadStatuses: [expect.objectContaining({ threadKey: "q-1300" })],
    });
  });

  it("respects the limit option", () => {
    const bigHistory: BrowserIncomingMessage[] = Array.from({ length: 10 }, (_, i) =>
      userMsg(`message ${i} with keyword`, i * 1000),
    );
    const result = grepMessageHistory(bigHistory, "keyword", { limit: 3 });
    expect(result.totalMatches).toBe(10);
    expect(result.matches).toHaveLength(3);
  });
});

// ─── Compaction events in scan and peek ──────────────────────────────────────

describe("buildPeekTurnScan compactionEvents", () => {
  it("returns compaction events between turns", () => {
    // Turn 0: user -> result, then compaction, then Turn 1: user -> result
    const history: BrowserIncomingMessage[] = [
      userMsg("first task", 1000),
      assistantMsg("working on it", 1100),
      resultMsg(500),
      compactMarker("Context compacted to 4%", 2000, { trigger: "auto", preTokens: 50000 }),
      userMsg("second task", 3000),
      assistantMsg("done", 3100),
      resultMsg(300),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.turns).toHaveLength(2);
    expect(result.compactionEvents).toBeDefined();
    expect(result.compactionEvents).toHaveLength(1);

    const event = result.compactionEvents![0];
    expect(event.idx).toBe(3);
    expect(event.ts).toBe(2000);
    expect(event.trigger).toBe("auto");
    expect(event.preTokens).toBe(50000);
    expect(event.summary).toBe("Context compacted to 4%");
    // Compaction is after turn 0 (which ends at idx 2)
    expect(event.afterTurn).toBe(0);
  });

  it("omits compactionEvents field when no compaction events exist", () => {
    const history: BrowserIncomingMessage[] = [userMsg("hello", 1000), assistantMsg("hi", 1100), resultMsg(200)];

    const result = buildPeekTurnScan(history);
    expect(result.compactionEvents).toBeUndefined();
  });

  it("detects compaction before first turn", () => {
    const history: BrowserIncomingMessage[] = [
      compactMarker("Initial compaction", 500, { trigger: "manual" }),
      userMsg("start", 1000),
      resultMsg(200),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.compactionEvents).toHaveLength(1);
    expect(result.compactionEvents![0].afterTurn).toBe(-1);
  });

  it("detects multiple compaction events", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("t1", 1000),
      resultMsg(100),
      compactMarker("First compaction", 2000),
      userMsg("t2", 3000),
      resultMsg(100),
      compactMarker("Second compaction", 4000),
      userMsg("t3", 5000),
      resultMsg(100),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.turns).toHaveLength(3);
    expect(result.compactionEvents).toHaveLength(2);
    expect(result.compactionEvents![0].afterTurn).toBe(0);
    expect(result.compactionEvents![1].afterTurn).toBe(1);
  });
});

describe("buildPeekDefault compactionEvents", () => {
  it("includes compaction events in default peek within visible range", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("t1", 1000),
      resultMsg(100),
      compactMarker("Compacted", 2000, { trigger: "auto" }),
      userMsg("t2", 3000),
      assistantMsg("response", 3100),
      resultMsg(200),
    ];

    const result = buildPeekDefault(history);
    expect(result.compactionEvents).toBeDefined();
    expect(result.compactionEvents).toHaveLength(1);
    expect(result.compactionEvents![0].summary).toBe("Compacted");
  });

  it("omits compactionEvents when none in visible range", () => {
    const history: BrowserIncomingMessage[] = [userMsg("hello", 1000), assistantMsg("hi", 1100), resultMsg(200)];

    const result = buildPeekDefault(history);
    expect(result.compactionEvents).toBeUndefined();
  });
});

// Full inspection includes all user-authored content, while compact inspection keeps its established budget.
it("reveals structured annotations in read without adding raw fields to compact peek", () => {
  const history: BrowserIncomingMessage[] = [
    {
      type: "user_message",
      content: "",
      timestamp: 1,
      annotations: [{ id: "comment", selectedText: "reference", comment: "long comment ".repeat(1000) }],
    },
  ];
  const read = buildReadResponse(history, 0)!;
  expect(read.content).toContain("[comment 1] long comment");
  expect(read.content.length).toBeGreaterThan(10_000);
  const peek = buildPeekRange(history, { from: 0, count: 1 });
  expect(peek.messages[0].content.length).toBeLessThan(1000);
  expect(peek.messages[0]).not.toHaveProperty("rawMessage");
});
