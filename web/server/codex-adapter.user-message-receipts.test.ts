import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

class MockWritableStream {
  chunks: string[] = [];
  private readonly writer = {
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

  push(data: string): void {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }
}

function createMockProcess() {
  const stdin = new MockWritableStream();
  const stdout = new MockReadableStream();
  const stderr = new MockReadableStream();
  const proc = {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    pid: 12345,
    exited: new Promise<number>(() => {}),
    kill: vi.fn(),
  };
  return { proc, stdin, stdout };
}

function parseWrittenJsonLines(stdin: MockWritableStream): any[] {
  return stdin.chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findLastRequest(stdin: MockWritableStream, method: string): any {
  const request = parseWrittenJsonLines(stdin)
    .filter((line) => line.method === method)
    .at(-1);
  expect(request?.id).toEqual(expect.any(Number));
  return request;
}

async function initializeAdapter(stdout: MockReadableStream): Promise<void> {
  stdout.push(JSON.stringify({ id: 1, result: { userAgent: "codex" } }) + "\n");
  await tick();
  stdout.push(JSON.stringify({ id: 2, result: { thread: { id: "thr_123" } } }) + "\n");
  await tick();
}

async function startActiveTurn(
  adapter: CodexAdapter,
  stdin: MockWritableStream,
  stdout: MockReadableStream,
  turnId = "turn_active",
): Promise<void> {
  adapter.sendBrowserMessage({ type: "user_message", content: "start active turn" } as BrowserOutgoingMessage);
  await tick();
  const request = findLastRequest(stdin, "turn/start");
  stdout.push(JSON.stringify({ id: request.id, result: { turn: { id: turnId } } }) + "\n");
  await tick();
}

function pushUserMessageReceipt(
  stdout: MockReadableStream,
  method: "item/started" | "item/completed",
  options: { clientId?: string; turnId?: string; itemId?: string; type?: string },
): void {
  stdout.push(
    JSON.stringify({
      method,
      params: {
        threadId: "thr_123",
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        item: {
          id: options.itemId ?? "user_item_1",
          type: options.type ?? "userMessage",
          ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
          content: [{ type: "text", text: "recorded input" }],
        },
      },
    }) + "\n",
  );
}

describe("CodexAdapter user-message history receipts", () => {
  let proc: ReturnType<typeof createMockProcess>["proc"];
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;

  beforeEach(() => {
    ({ proc, stdin, stdout } = createMockProcess());
  });

  async function makeAdapter(): Promise<CodexAdapter> {
    const adapter = new CodexAdapter(proc as never, "test-session", { model: "o4-mini", cwd: "/tmp" });
    await tick();
    await initializeAdapter(stdout);
    return adapter;
  }

  it("passes an explicit client id to turn/start and releases a pre-ACK receipt after onTurnStarted", async () => {
    const adapter = await makeAdapter();
    const events: string[] = [];
    const receipts: unknown[] = [];
    const observations: unknown[] = [];
    adapter.onTurnStarted((turnId) => events.push(`started:${turnId}`));
    adapter.onUserMessageReceiptObserved((receipt) => {
      events.push(`observed:${receipt.clientUserMessageId}`);
      observations.push(receipt);
    });
    adapter.onUserMessageRecorded((receipt) => {
      events.push(`recorded:${receipt.clientUserMessageId}`);
      receipts.push(receipt);
    });

    adapter.sendBrowserMessage({
      type: "codex_start_pending",
      pendingInputIds: ["pending-1"],
      clientUserMessageId: "batch-explicit",
      inputs: [{ content: "first pending input" }],
    });
    await tick();

    const request = findLastRequest(stdin, "turn/start");
    expect(request.params.clientUserMessageId).toBe("batch-explicit");

    // Codex persists the item before answering the RPC. Do not let that race
    // prove incorporation until Takode knows which start request was accepted.
    pushUserMessageReceipt(stdout, "item/started", {
      clientId: "batch-explicit",
      turnId: "turn_start",
    });
    await tick();
    expect(receipts).toHaveLength(0);
    expect(observations).toEqual([
      expect.objectContaining({
        clientUserMessageId: "batch-explicit",
        turnId: "turn_start",
        itemId: "user_item_1",
        observedAt: expect.any(Number),
      }),
    ]);

    stdout.push(JSON.stringify({ id: request.id, result: { turn: { id: "turn_start" } } }) + "\n");
    await tick();

    expect(events).toEqual(["observed:batch-explicit", "started:turn_start", "recorded:batch-explicit"]);
    expect(receipts).toEqual([
      expect.objectContaining({
        clientUserMessageId: "batch-explicit",
        turnId: "turn_start",
        itemId: "user_item_1",
        observedAt: expect.any(Number),
      }),
    ]);

    // item/started and item/completed describe the same durable history item.
    pushUserMessageReceipt(stdout, "item/completed", {
      clientId: "batch-explicit",
      turnId: "turn_start",
    });
    await tick();
    expect(receipts).toHaveLength(1);
  });

  it("derives turn/start client id from the first pending input and emits a post-ACK receipt", async () => {
    const adapter = await makeAdapter();
    const recorded = vi.fn();
    adapter.onUserMessageRecorded(recorded);

    adapter.sendBrowserMessage({
      type: "codex_start_pending",
      pendingInputIds: ["pending-first", "pending-second"],
      inputs: [{ content: "first" }, { content: "second" }],
    });
    await tick();

    const request = findLastRequest(stdin, "turn/start");
    expect(request.params.clientUserMessageId).toBe("pending-first");
    stdout.push(JSON.stringify({ id: request.id, result: { turn: { id: "turn_derived" } } }) + "\n");
    await tick();

    pushUserMessageReceipt(stdout, "item/completed", {
      clientId: "pending-first",
      turnId: "turn_derived",
      itemId: "derived_item",
    });
    await tick();

    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserMessageId: "pending-first",
        turnId: "turn_derived",
        itemId: "derived_item",
        observedAt: expect.any(Number),
      }),
    );
  });

  it("keeps user receipts independent when assistant streaming and completion IDs differ", async () => {
    const adapter = await makeAdapter();
    const messages: BrowserIncomingMessage[] = [];
    const recorded = vi.fn();
    adapter.onBrowserMessage((message) => messages.push(message));
    adapter.onUserMessageRecorded(recorded);
    adapter.sendBrowserMessage({
      type: "codex_start_pending",
      pendingInputIds: ["pending-rekeyed-assistant"],
      clientUserMessageId: "batch-rekeyed-assistant",
      inputs: [{ content: "Inspect the pending work" }],
    });
    await tick();
    const request = findLastRequest(stdin, "turn/start");
    expect(request.params.clientUserMessageId).toBe("batch-rekeyed-assistant");
    stdout.push(JSON.stringify({ id: request.id, result: { turn: { id: "turn_rekeyed" } } }) + "\n");
    await tick();

    // Provider assistant IDs can change on completion. Neither output event
    // proves that the independently identified user input entered history.
    stdout.push(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thr_123",
          turnId: "turn_rekeyed",
          item: { type: "agentMessage", id: "assistant-streaming", phase: "commentary" },
        },
      }) + "\n",
    );
    stdout.push(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { threadId: "thr_123", turnId: "turn_rekeyed", itemId: "assistant-streaming", delta: "Inspecting " },
      }) + "\n",
    );
    await tick();
    expect(recorded).not.toHaveBeenCalled();

    pushUserMessageReceipt(stdout, "item/started", {
      clientId: "batch-rekeyed-assistant",
      turnId: "turn_rekeyed",
      itemId: "user-receipt",
    });
    await tick();
    expect(recorded).toHaveBeenCalledOnce();

    stdout.push(
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thr_123",
          turnId: "turn_rekeyed",
          item: {
            type: "agentMessage",
            id: "assistant-completed",
            phase: "commentary",
            text: "Inspecting the pending work.",
          },
        },
      }) + "\n",
    );
    // The second notification for the real user item must remain one receipt,
    // even with an assistant completion interleaved between its notifications.
    pushUserMessageReceipt(stdout, "item/completed", {
      clientId: "batch-rekeyed-assistant",
      turnId: "turn_rekeyed",
      itemId: "user-receipt",
    });
    await tick();

    expect(recorded).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        clientUserMessageId: "batch-rekeyed-assistant",
        turnId: "turn_rekeyed",
        itemId: "user-receipt",
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "stream_event",
        event: expect.objectContaining({
          type: "message_start",
          message: expect.objectContaining({ id: "codex-agent-assistant-streaming" }),
        }),
      }),
    );
    expect(messages.filter((message) => message.type === "assistant")).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          id: "codex-agent-assistant-completed",
          content: [{ type: "text", text: "Inspecting the pending work." }],
        }),
        codexMessagePhase: "commentary",
      }),
    ]);
  });

  it("passes a client id to turn/steer and releases its receipt after onTurnSteered", async () => {
    const adapter = await makeAdapter();
    await startActiveTurn(adapter, stdin, stdout);

    const events: string[] = [];
    const recorded = vi.fn((receipt: { clientUserMessageId: string }) => {
      events.push(`recorded:${receipt.clientUserMessageId}`);
    });
    adapter.onTurnSteered((turnId, pendingIds) => events.push(`steered:${turnId}:${pendingIds.join(",")}`));
    adapter.onUserMessageRecorded(recorded);

    adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ["pending-steer"],
      clientUserMessageId: "batch-steer",
      expectedTurnId: "turn_active",
      inputs: [{ content: "steered input" }],
    });
    await tick();

    const request = findLastRequest(stdin, "turn/steer");
    expect(request.params).toMatchObject({
      expectedTurnId: "turn_active",
      clientUserMessageId: "batch-steer",
    });

    pushUserMessageReceipt(stdout, "item/completed", {
      clientId: "batch-steer",
      turnId: "turn_active",
      itemId: "steer_item",
    });
    await tick();
    expect(recorded).not.toHaveBeenCalled();

    stdout.push(JSON.stringify({ id: request.id, result: { turnId: "turn_active" } }) + "\n");
    await tick();

    expect(events).toEqual(["steered:turn_active:pending-steer", "recorded:batch-steer"]);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUserMessageId: "batch-steer",
        turnId: "turn_active",
        itemId: "steer_item",
        observedAt: expect.any(Number),
      }),
    );
  });

  it("ignores non-user items and user-message items without a usable client id or turn id", async () => {
    const adapter = await makeAdapter();
    const recorded = vi.fn();
    adapter.onUserMessageRecorded(recorded);

    pushUserMessageReceipt(stdout, "item/started", {
      type: "agentMessage",
      clientId: "batch-ignored",
      turnId: "turn_ignored",
    });
    pushUserMessageReceipt(stdout, "item/started", {
      clientId: "   ",
      turnId: "turn_ignored",
      itemId: "blank_client",
    });
    pushUserMessageReceipt(stdout, "item/completed", {
      clientId: "batch-ignored",
      itemId: "missing_turn",
    });
    await tick();

    expect(recorded).not.toHaveBeenCalled();
  });
});
