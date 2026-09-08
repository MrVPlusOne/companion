import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex-adapter.js";
import type { BrowserIncomingMessage } from "./session-types.js";

function fixture() {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  const requests: Array<{ id: number; method: string }> = [];
  const proc = {
    stdin: new WritableStream<Uint8Array>({
      write: (chunk) => {
        requests.push(JSON.parse(new TextDecoder().decode(chunk)));
      },
    }),
    stdout: new ReadableStream<Uint8Array>({ start: (controller) => (stdout = controller) }),
    stderr: new ReadableStream<Uint8Array>(),
    pid: 12345,
    exited: new Promise<number>(() => {}),
    kill: vi.fn(),
  };
  const adapter = new CodexAdapter(proc as never, "stream-retry-test", { model: "o4-mini" });
  const messages: BrowserIncomingMessage[] = [];
  adapter.onBrowserMessage((message) => messages.push(message));
  const push = (message: unknown) => stdout.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  const reply = async (method: string, result: unknown) => {
    await vi.waitFor(() => expect(requests.some((request) => request.method === method)).toBe(true));
    push({ id: requests.find((request) => request.method === method)!.id, result });
  };
  return { adapter, messages, push, reply, close: () => stdout.close(), requests };
}

describe("Codex adapter stream retry notification path", () => {
  it("carries a confirmed retry to the browser and clears it on resumed output and disconnect", async () => {
    const { adapter, messages, push, reply, close, requests } = fixture();
    await reply("initialize", { userAgent: "codex" });
    await reply("thread/start", { thread: { id: "root-thread" } });
    await vi.waitFor(() => expect(adapter.isConnected()).toBe(true));
    adapter.sendBrowserMessage({ type: "user_message", content: "respond" });
    await reply("turn/start", { turn: { id: "root-turn" } });
    await vi.waitFor(() => expect(adapter.getCurrentTurnId()).toBe("root-turn"));
    const params = { threadId: "root-thread", turnId: "root-turn" };
    const retryMessages = () =>
      messages.filter((message) => message.type === "session_update" && "codex_stream_retry" in message.session);

    // The fixture follows the installed app-server ErrorNotification schema.
    // No result, replay, launch, or raw backend error is synthesized by this signal.
    push({ method: "error", params: { ...params, willRetry: true, error: { message: "provider private detail" } } });
    await vi.waitFor(() => expect(retryMessages()).toHaveLength(1));
    expect(retryMessages()[0]).toEqual({
      type: "session_update",
      session: { codex_stream_retry: { turnId: "root-turn" } },
    });
    expect(messages.filter((message) => message.type === "result" || message.type === "error")).toEqual([]);
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1);

    push({ method: "item/reasoning/textDelta", params: { ...params, delta: "not rendered" } });
    await vi.waitFor(() => expect(retryMessages()).toHaveLength(2));
    expect(retryMessages()[1]).toEqual({ type: "session_update", session: { codex_stream_retry: null } });
    push({ method: "error", params: { ...params, willRetry: true, error: { message: "retry again" } } });
    await vi.waitFor(() => expect(retryMessages()).toHaveLength(3));
    close();
    await vi.waitFor(() => expect(adapter.isConnected()).toBe(false));
    expect(retryMessages().at(-1)).toEqual({ type: "session_update", session: { codex_stream_retry: null } });
  });
});
