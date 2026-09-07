import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexAdapter, type CodexSessionMeta } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, SessionState } from "./session-types.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../shared/codex-slash-commands.js";

/** Minimal event-loop yield so the ReadableStream reader can process chunks.
 *  Replaces the original 20-50ms setTimeout calls — 1ms is sufficient. */
const tick = () => new Promise<void>((r) => setTimeout(r, 1));

// ─── Mock Subprocess ──────────────────────────────────────────────────────────

class MockWritableStream {
  chunks: string[] = [];
  private writer = {
    write: async (chunk: Uint8Array) => {
      this.chunks.push(new TextDecoder().decode(chunk));
    },
    releaseLock: () => {},
  };
  getWriter() {
    return this.writer;
  }
}

class MockReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor() {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(data: string) {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }

  close() {
    this.controller?.close();
  }
}

function createMockProcess() {
  const stdinStream = new MockWritableStream();
  const stdoutReadable = new MockReadableStream();
  const stderrReadable = new MockReadableStream();

  let resolveExit: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const proc = {
    stdin: stdinStream,
    stdout: stdoutReadable.stream,
    stderr: stderrReadable.stream,
    pid: 12345,
    exited: exitPromise,
    kill: vi.fn(),
  };

  return { proc, stdin: stdinStream, stdout: stdoutReadable, stderr: stderrReadable };
}

async function initializeAdapter(stdout: MockReadableStream) {
  stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
  await tick();
  stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
  await tick();
}

function parseWrittenJsonLines(chunks: string[]): any[] {
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    const mock = createMockProcess();
    proc = mock.proc;
    stdin = mock.stdin;
    stdout = mock.stdout;
  });

  it("extracts webSearch query from action fields when query is absent", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();

    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "webSearch",
            id: "ws_action_query",
            action: { type: "search", query: "codex cli skills documentation" },
          },
        },
      }) + "\n",
    );

    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.name === "WebSearch");
      });
    expect(toolMsg).toBeDefined();

    const content = (toolMsg as { message: { content: Array<{ type: string; input?: { query: string } }> } }).message
      .content;
    const toolBlock = content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { query: string } }).input.query).toBe("codex cli skills documentation");
  });

  it("surfaces rawResponseItem/completed view_image function calls as completed tool blocks", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "rawResponseItem/completed",
        params: {
          item: {
            type: "function_call",
            name: "view_image",
            arguments: '{"path":"/tmp/proof.png"}',
            call_id: "call_view_image_1",
          },
        },
      }) + "\n",
    );

    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
          .content;
        return content.some((b) => b.type === "tool_use" && b.name === "view_image" && b.id === "call_view_image_1");
      });

    expect(toolMsg).toBeDefined();
    const toolBlock = (
      toolMsg as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/proof.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "call_view_image_1");
      });
    expect(resultMsg).toBeDefined();
  });

  it("normalizes raw web_search_call search actions into WebSearch tool input", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    // Regression coverage for Codex Responses-style Web Search completion
    // items, which carry the query under action rather than the older webSearch
    // item shape Takode already handled.
    stdout.push(
      JSON.stringify({
        method: "rawResponseItem/completed",
        params: {
          item: {
            type: "web_search_call",
            id: "ws_raw_search",
            status: "completed",
            action: {
              type: "search",
              query: "June 2026 Visa Bulletin employment final action dates",
              queries: ["June 2026 Visa Bulletin employment final action dates"],
            },
          },
        },
      }) + "\n",
    );
    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
          .content;
        return content.some((b) => b.type === "tool_use" && b.name === "WebSearch" && b.id === "ws_raw_search");
      });

    expect(toolMsg).toBeDefined();
    const toolBlock = (
      toolMsg as {
        message: { content: Array<{ type: string; input?: { query?: string; action?: Record<string, unknown> } }> };
      }
    ).message.content.find((b) => b.type === "tool_use");
    expect(toolBlock?.input?.query).toBe("June 2026 Visa Bulletin employment final action dates");
    expect(toolBlock?.input?.action?.type).toBe("search");
    expect(toolBlock?.input?.action?.queries).toEqual(["June 2026 Visa Bulletin employment final action dates"]);
  });

  it("normalizes raw web_search_call open_page actions into WebSearch URL detail", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    // URL-only open_page actions should still produce useful visible detail,
    // even when there is no query string for the WebSearch preview.
    stdout.push(
      JSON.stringify({
        method: "rawResponseItem/completed",
        params: {
          responseItem: {
            type: "web_search_call",
            id: "ws_raw_open",
            status: "completed",
            action: {
              type: "open_page",
              url: "https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/2026/visa-bulletin-for-june-2026.html",
            },
          },
        },
      }) + "\n",
    );
    await tick();

    const toolMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
          .content;
        return content.some((b) => b.type === "tool_use" && b.name === "WebSearch" && b.id === "ws_raw_open");
      });
    expect(toolMsg).toBeDefined();

    const toolBlock = (
      toolMsg as {
        message: { content: Array<{ type: string; input?: { query?: string; action?: Record<string, unknown> } }> };
      }
    ).message.content.find((b) => b.type === "tool_use");
    expect(toolBlock?.input?.query).toBe("");
    expect(toolBlock?.input?.action?.type).toBe("open_page");
    expect(toolBlock?.input?.action?.url).toBe(
      "https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/2026/visa-bulletin-for-june-2026.html",
    );

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } })
          .message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "ws_raw_open");
      });
    expect(resultMsg).toBeDefined();
    const resultBlock = (
      resultMsg as { message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> } }
    ).message.content.find((b) => b.type === "tool_result");
    expect(resultBlock?.content).toContain("visa-bulletin-for-june-2026.html");
  });

  it("deduplicates replayed rawResponseItem/completed view_image calls", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    const rawViewImage = JSON.stringify({
      method: "rawResponseItem/completed",
      params: {
        item: {
          type: "function_call",
          name: "view_image",
          arguments: '{"path":"/tmp/replayed.png"}',
          call_id: "call_view_image_replay",
        },
      },
    });

    stdout.push(rawViewImage + "\n");
    stdout.push(rawViewImage + "\n");

    await tick();

    const toolUseMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
      return content.some((b) => b.type === "tool_use" && b.id === "call_view_image_replay");
    });

    expect(toolUseMsgs).toHaveLength(1);
  });

  it("surfaces imageView item started/completed notifications as a completed tool block", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-1",
            path: "/tmp/from-item-started.png",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-1",
            path: "/tmp/from-item-started.png",
          },
        },
      }) + "\n",
    );

    await tick();

    const toolUseMsgs = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string; name?: string; id?: string }> } }).message
        .content;
      return content.some((b) => b.type === "tool_use" && b.name === "view_image" && b.id === "image-view-item-1");
    });

    expect(toolUseMsgs).toHaveLength(1);
    const toolBlock = (
      toolUseMsgs[0] as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/from-item-started.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "image-view-item-1");
      });
    expect(resultMsg).toBeDefined();
  });

  it("backfills imageView path on completion before emitting the final tool_result", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-2",
            path: "",
          },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "imageView",
            id: "image-view-item-2",
            path: "/tmp/from-completed.png",
          },
        },
      }) + "\n",
    );

    await tick();

    const lastToolUseMsg = messages
      .filter((m) => m.type === "assistant")
      .filter((m) => {
        const content = (m as { message: { content: Array<{ type: string; id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_use" && b.id === "image-view-item-2");
      })
      .at(-1);
    expect(lastToolUseMsg).toBeDefined();
    const toolBlock = (
      lastToolUseMsg as { message: { content: Array<{ type: string; input?: { path?: string } }> } }
    ).message.content.find((b) => b.type === "tool_use");
    expect((toolBlock as { input: { path?: string } }).input.path).toBe("/tmp/from-completed.png");

    const resultMsg = messages
      .filter((m) => m.type === "assistant")
      .find((m) => {
        const content = (m as { message: { content: Array<{ type: string; tool_use_id?: string }> } }).message.content;
        return content.some((b) => b.type === "tool_result" && b.tool_use_id === "image-view-item-2");
      });
    expect(resultMsg).toBeDefined();
  });

  it("captures Codex-reported instruction sources with the thread metadata", async () => {
    const metaCalls: CodexSessionMeta[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.4",
      cwd: "/project",
      instructions: "Takode guardrails",
      instructionContext: {
        globalSources: [
          {
            loadedPath: "/session-home/AGENTS.md",
            sourcePath: "/Users/me/.codex/AGENTS.md",
            delivery: "copied_snapshot",
          },
        ],
        configLayers: [{ kind: "user", path: "/session-home/config.toml" }],
      },
    });
    adapter.onSessionMeta((meta) => metaCalls.push(meta));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: {} }) + "\n");
    await tick();
    stdout.push(
      JSON.stringify({
        id: 3,
        result: {
          thread: { id: "thr_456" },
          instructionSources: ["/session-home/AGENTS.md", "/project/AGENTS.md"],
        },
      }) + "\n",
    );
    await tick();

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]).toMatchObject({
      cliSessionId: "thr_456",
      model: "gpt-5.4",
      instructionSnapshot: {
        threadId: "thr_456",
        lifecycle: "thread_start",
        instructionSourcesReported: true,
        developerInstructionsConfigured: true,
        instructionSources: [
          {
            path: "/session-home/AGENTS.md",
            kind: "global",
            sourcePath: "/Users/me/.codex/AGENTS.md",
            delivery: "copied_snapshot",
          },
          { path: "/project/AGENTS.md", kind: "project", delivery: "direct" },
        ],
      },
    });
  });

  it("uses Codex thread responses and settings updates as the effective effort authority", async () => {
    // Requested launch state stays separate; only app-server response/notification
    // fields can mark an effort as runtime-reported.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", {
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_effort" }, reasoningEffort: "high" } }) + "\n");
    await tick();

    const initial = messages.find((msg) => msg.type === "session_init");
    expect(initial?.type === "session_init" ? initial.session : null).toMatchObject({
      codex_reasoning_effort: "ultra",
      codex_effective_reasoning_effort: "high",
      codex_effective_reasoning_effort_reported: true,
    });

    stdout.push(
      JSON.stringify({
        method: "thread/settings/updated",
        params: { threadId: "thr_effort", threadSettings: { effort: "ultra" } },
      }) + "\n",
    );
    await tick();
    const update = messages.filter((msg) => msg.type === "session_update").at(-1);
    expect(update?.type === "session_update" ? update.session : null).toMatchObject({
      codex_effective_reasoning_effort: "ultra",
      codex_effective_reasoning_effort_reported: true,
    });
  });

  it("reports effective effort as unknown when an older thread response omits it", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { reasoningEffort: "ultra" });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    await initializeAdapter(stdout);
    const initial = messages.find((msg) => msg.type === "session_init");
    expect(initial?.type === "session_init" ? initial.session : null).toMatchObject({
      codex_reasoning_effort: "ultra",
      codex_effective_reasoning_effort: null,
      codex_effective_reasoning_effort_reported: false,
    });
  });

  // ── Item completion handlers ───────────────────────────────────────────────

  it("emits tool_result on webSearch item/completed", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started for webSearch
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "webSearch", id: "ws_1", query: "typescript guide" } },
      }) + "\n",
    );
    await tick();

    // item/completed for webSearch
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_1",
            query: "typescript guide",
            action: { type: "navigate", url: "https://example.com/guide" },
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    const resultMsg = toolResults[toolResults.length - 1] as {
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> };
    };
    const resultBlock = resultMsg.message.content.find((b) => b.type === "tool_result");
    expect(resultBlock?.tool_use_id).toBe("ws_1");
    expect(resultBlock?.content).toContain("https://example.com/guide");
  });

  it("prefers structured webSearch results over echoing the query", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            type: "webSearch",
            id: "ws_2",
            query: "Codex CLI skills documentation",
          },
        },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_2",
            query: "Codex CLI skills documentation",
            results: [
              {
                title: "OpenAI Codex CLI docs",
                url: "https://platform.openai.com/docs/codex",
                snippet: "Official setup and skills documentation.",
              },
            ],
          },
        },
      }) + "\n",
    );
    await tick();

    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    const resultMsg = toolResults[toolResults.length - 1] as {
      message: { content: Array<{ type: string; tool_use_id?: string; content?: string }> };
    };
    const resultBlock = resultMsg.message.content.find((b) => b.type === "tool_result");
    expect(resultBlock?.tool_use_id).toBe("ws_2");
    expect(resultBlock?.content).toContain("OpenAI Codex CLI docs");
    expect(resultBlock?.content).toContain("https://platform.openai.com/docs/codex");
    expect(resultBlock?.content).not.toBe("Codex CLI skills documentation");
  });

  // Regression: Codex web search items with no real result data caused the
  // adapter to emit the query text as the tool_result, which the ToolBlock
  // then displayed as "RESULT: <query>". The fix suppresses tool_result
  // emission when the result would just echo the query.
  it("skips tool_result when webSearch result would echo the query", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          item: { type: "webSearch", id: "ws_echo", query: "Codex CLI skills documentation" },
        },
      }) + "\n",
    );
    await tick();

    // item/completed — only has query, no real result fields. The adapter's
    // extractWebSearchResultText falls through to "Web search completed" or
    // returns the query itself.
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "webSearch",
            id: "ws_echo",
            query: "Codex CLI skills documentation",
          },
        },
      }) + "\n",
    );
    await tick();

    // No tool_result should be emitted — the only result would be the query
    const toolResults = messages.filter((m) => {
      if (m.type !== "assistant") return false;
      const content = (m as { message: { content: Array<{ type: string }> } }).message.content;
      return content.some((b) => b.type === "tool_result");
    });
    expect(toolResults.length).toBe(0);
  });

  it("emits content_block_stop on reasoning item/completed", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    // item/started for reasoning (opens thinking block)
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
      }) + "\n",
    );
    await tick();

    // item/completed for reasoning (should close thinking block)
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { item: { type: "reasoning", id: "r_1", summary: "Thinking about the problem..." } },
      }) + "\n",
    );
    await tick();

    const blockStops = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_stop",
    );
    expect(blockStops.length).toBeGreaterThanOrEqual(1);
  });

  it("does not disconnect when reasoning summary payload is non-string", async () => {
    // Regression: Codex may send summary/content in structured object form.
    // The adapter must coerce safely instead of throwing and dropping transport.
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    const onDisconnect = vi.fn();
    adapter.onBrowserMessage((msg) => messages.push(msg));
    adapter.onDisconnect(onDisconnect);

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { item: { type: "reasoning", id: "r_obj" } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "reasoning",
            id: "r_obj",
            summary: { text: "Structured reasoning summary" },
          },
        },
      }) + "\n",
    );
    await tick();

    const thinkingMsgs = messages.filter(
      (m) =>
        m.type === "assistant" &&
        (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
    );
    const reasoningDetails = messages.filter((m) => m.type === "codex_reasoning_detail");
    expect(thinkingMsgs).toHaveLength(0);
    expect(reasoningDetails).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("emits stable completed detail rows for top-level reasoning summaries", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await tick();
    stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
    await tick();

    adapter.sendBrowserMessage({ type: "user_message", content: "Think about this" } as BrowserOutgoingMessage);
    await tick();

    // Resolve rateLimits/read + turn/start
    stdout.push(JSON.stringify({ id: 3, result: {} }) + "\n");
    await tick();
    stdout.push(JSON.stringify({ id: 4, result: { turn: { id: "turn_1" } } }) + "\n");
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { turnId: "turn_1", item: { type: "reasoning", id: "r_t1", summary: ["First summary"] } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { turnId: "turn_1", item: { type: "reasoning", id: "r_t1", summary: ["First summary"] } },
      }) + "\n",
    );
    await tick();

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { turnId: "turn_1", item: { type: "reasoning", id: "r_t2", summary: ["Second summary"] } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: { turnId: "turn_1", item: { type: "reasoning", id: "r_t2", summary: ["Second summary"] } },
      }) + "\n",
    );
    await tick();

    const reasoningAssistants = messages.filter(
      (m) =>
        m.type === "assistant" &&
        (m as { message: { content: Array<{ type: string }> } }).message.content.some((b) => b.type === "thinking"),
    );
    const thinkingStops = messages.filter(
      (m) => m.type === "stream_event" && (m as { event: { type: string } }).event?.type === "content_block_stop",
    );
    const completedDetails = messages.filter((m) => m.type === "codex_reasoning_detail" && m.status === "complete");

    expect(reasoningAssistants).toHaveLength(0);
    expect(completedDetails).toEqual([
      expect.objectContaining({ id: "codex-reasoning-turn_1-0-0", text: "First summary" }),
      expect.objectContaining({ id: "codex-reasoning-turn_1-1-0", text: "Second summary" }),
    ]);
    expect(thinkingStops.length).toBeGreaterThanOrEqual(2);
  });

  it("emits live reasoning summary updates under one stable detail id", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));

    await initializeAdapter(stdout);

    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { turnId: "turn_live", item: { type: "reasoning", id: "r_live", summary: ["Inspecting "] } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/reasoning/summaryTextDelta",
        params: { turnId: "turn_live", itemId: "r_live", summaryIndex: 0, delta: "session state" },
      }) + "\n",
    );
    await tick();

    expect(messages.filter((message) => message.type === "codex_reasoning_detail")).toEqual([
      expect.objectContaining({
        type: "codex_reasoning_detail",
        id: "codex-reasoning-turn_live-0-0",
        text: "Inspecting ",
        status: "streaming",
      }),
      expect.objectContaining({
        type: "codex_reasoning_detail",
        id: "codex-reasoning-turn_live-0-0",
        text: "Inspecting session state",
        status: "streaming",
      }),
    ]);
  });

  it("keeps producer summary parts separate when completion changes the item id", async () => {
    const messages: BrowserIncomingMessage[] = [];
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini" });
    adapter.onBrowserMessage((msg) => messages.push(msg));
    await initializeAdapter(stdout);

    const parts = [
      "**Addressing BugPilot Issues**\n\nFirst body.",
      "**Planning Cluster Access**\n\nSecond body.",
      "**Requesting Worker Details**\n\nThird body.",
    ];
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: { turnId: "turn_multi", item: { type: "reasoning", id: "stream-item", summary: [] } },
      }) + "\n",
    );
    await tick();
    stdout.push(
      JSON.stringify({
        method: "item/reasoning/textDelta",
        params: { turnId: "turn_multi", itemId: "stream-item", delta: "hidden raw reasoning" },
      }) + "\n",
    );
    await tick();
    expect(messages.filter((message) => message.type === "codex_reasoning_detail")).toHaveLength(0);

    for (let summaryIndex = 0; summaryIndex < parts.length; summaryIndex++) {
      stdout.push(
        JSON.stringify({
          method: "item/reasoning/summaryPartAdded",
          params: { turnId: "turn_multi", itemId: "stream-item", summaryIndex },
        }) + "\n",
      );
      stdout.push(
        JSON.stringify({
          method: "item/reasoning/summaryTextDelta",
          params: { turnId: "turn_multi", itemId: "stream-item", summaryIndex, delta: parts[summaryIndex] },
        }) + "\n",
      );
      await tick();
    }

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          turnId: "turn_multi",
          item: { type: "reasoning", id: "completed-item", summary: parts },
        },
      }) + "\n",
    );
    await tick();

    const details = messages.filter((message) => message.type === "codex_reasoning_detail");
    expect(new Set(details.map((message) => message.id))).toEqual(
      new Set(["codex-reasoning-turn_multi-0-0", "codex-reasoning-turn_multi-0-1", "codex-reasoning-turn_multi-0-2"]),
    );
    expect(details.filter((message) => message.status === "complete")).toEqual(
      parts.map((text, summaryIndex) =>
        expect.objectContaining({
          id: `codex-reasoning-turn_multi-0-${summaryIndex}`,
          summary_index: summaryIndex,
          text,
        }),
      ),
    );
    expect(details.every((message) => parts.includes(message.text))).toBe(true);
  });
});
