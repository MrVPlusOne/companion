import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import { buildCodexInstructionSnapshot, captureCodexInstructionSnapshot } from "./codex-instruction-snapshot.js";
import type { CodexInstructionSnapshot } from "./codex-adapter-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";

vi.mock("./codex-instruction-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-instruction-snapshot.js")>();
  return { ...actual, captureCodexInstructionSnapshot: vi.fn(actual.captureCodexInstructionSnapshot) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function producer() {
  type Request = { id: number; method: string };
  const requests: Request[] = [];
  const waiters = new Map<string, ReturnType<typeof deferred<Request>>>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      const request = JSON.parse(new TextDecoder().decode(chunk)) as Request;
      requests.push(request);
      waiters.get(request.method)?.resolve(request);
    },
  });
  return {
    requests,
    proc: {
      stdin,
      stdout,
      stderr: new ReadableStream(),
      pid: 12345,
      exited: new Promise<number>(() => {}),
      kill: vi.fn(),
    },
    next(method: string) {
      const seen = requests.find((request) => request.method === method);
      if (seen) return Promise.resolve(seen);
      const waiter = deferred<Request>();
      waiters.set(method, waiter);
      return waiter.promise;
    },
    reply(id: number, result: unknown) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
    },
    close() {
      controller.close();
    },
  };
}

function snapshot(): CodexInstructionSnapshot {
  return buildCodexInstructionSnapshot({
    threadId: "thread-proof",
    capturedAt: 1234,
    lifecycle: "thread_start",
    instructionSources: [],
    developerInstructionsConfigured: false,
  });
}

describe("Codex instruction capture initialization boundary", () => {
  it("does not publish stale metadata or dispatch queued work after a disconnect during capture", async () => {
    // A deferred capture reproduces slow filesystem I/O without relying on a short timing race.
    const capturing = deferred<void>();
    const captured = deferred<CodexInstructionSnapshot>();
    vi.mocked(captureCodexInstructionSnapshot).mockImplementationOnce(() => {
      capturing.resolve();
      return captured.promise;
    });
    const native = producer();
    const adapter = new CodexAdapter(native.proc as never, "instruction-capture-close");
    const meta = vi.fn();
    const messages: BrowserIncomingMessage[] = [];
    const disconnected = deferred<void>();
    adapter.onSessionMeta(meta);
    adapter.onBrowserMessage((message) => messages.push(message));
    adapter.onDisconnect(() => disconnected.resolve());
    native.reply((await native.next("initialize")).id, {});
    native.reply((await native.next("thread/start")).id, { thread: { id: "thread-proof" }, instructionSources: [] });
    await capturing.promise;
    expect(adapter.sendBrowserMessage({ type: "user_message", content: "queued during capture" })).toBe(true);
    expect(native.requests.some((request) => request.method === "turn/start")).toBe(false);
    native.close();
    await disconnected.promise;
    captured.resolve(snapshot());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adapter.isConnected()).toBe(false);
    expect(meta).not.toHaveBeenCalled();
    expect(messages.some((message) => message.type === "session_init")).toBe(false);
    expect(
      native.requests.some((request) =>
        ["turn/start", "skills/list", "account/rateLimits/read"].includes(request.method),
      ),
    ).toBe(false);
  });

  it("queues new user work until capture completes and publishes the matching snapshot first", async () => {
    const capturing = deferred<void>();
    const captured = deferred<CodexInstructionSnapshot>();
    vi.mocked(captureCodexInstructionSnapshot).mockImplementationOnce(() => {
      capturing.resolve();
      return captured.promise;
    });
    const native = producer();
    const adapter = new CodexAdapter(native.proc as never, "instruction-capture-ready");
    const meta = vi.fn();
    adapter.onSessionMeta(meta);
    native.reply((await native.next("initialize")).id, {});
    native.reply((await native.next("thread/start")).id, { thread: { id: "thread-proof" }, instructionSources: [] });
    await capturing.promise;
    adapter.sendBrowserMessage({ type: "user_message", content: "queued during capture" });
    expect(native.requests.some((request) => request.method === "turn/start")).toBe(false);
    const expected = snapshot();
    captured.resolve(expected);
    const rateLimits = await native.next("account/rateLimits/read");
    expect(meta).toHaveBeenCalledWith(
      expect.objectContaining({ cliSessionId: "thread-proof", instructionSnapshot: expected }),
    );
    native.reply(rateLimits.id, {});
    const turn = await native.next("turn/start");
    native.reply(turn.id, { turn: { id: "turn-after-capture" } });
    native.close();
  });
});
