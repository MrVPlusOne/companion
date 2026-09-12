import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerLogEntry } from "../../shared/logging.js";
import { subscribeToServerLogs } from "../server-logger.js";
import {
  acknowledgeBrowserConnection,
  beginBrowserConnectionSubscribe,
  classifyBrowserClientPlatform,
  closeBrowserConnectionDiagnostics,
  finishBrowserConnectionSubscribe,
  openBrowserConnectionDiagnostics,
  sendObservedBrowserPayload,
} from "./browser-connection-diagnostics.js";

const sockets: Array<Parameters<typeof openBrowserConnectionDiagnostics>[0]> = [];
let entries: ServerLogEntry[];
let unsubscribe: () => void;

function makeSocket() {
  const socket = {
    data: { browserClientPlatform: "ios" },
    send: vi.fn((_data: string): unknown => 1),
    getBufferedAmount: () => 0,
  };
  sockets.push(socket);
  return socket;
}

function last(event: string) {
  return entries.findLast((entry) => entry.meta?.event === event)?.meta;
}

function probeId(ws: ReturnType<typeof makeSocket>): string {
  return JSON.parse(String(ws.send.mock.calls.at(-1)?.[0])).connection_id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  entries = [];
  unsubscribe = subscribeToServerLogs({ components: ["browser-connection"] }, (entry) => entries.push(entry));
});

afterEach(() => {
  for (const ws of sockets.splice(0)) closeBrowserConnectionDiagnostics(ws);
  unsubscribe();
  vi.useRealTimers();
});

describe("browser connection diagnostics", () => {
  it("counts encoded bytes per actual recipient without recording the payload", () => {
    // Non-ASCII text catches accidental UTF-16 length accounting; same-session
    // sockets must never borrow each other's counters or receipt authority.
    const first = makeSocket();
    const second = makeSocket();
    openBrowserConnectionDiagnostics(first, "session");
    openBrowserConnectionDiagnostics(second, "session");
    const payload = JSON.stringify({ type: "assistant", content: "private 内容 🐙" });
    sendObservedBrowserPayload(first, payload, "assistant");
    sendObservedBrowserPayload(second, payload, "assistant");
    sendObservedBrowserPayload(first, payload, "assistant");
    closeBrowserConnectionDiagnostics(first);
    expect(last("closed")).toMatchObject({ acceptedMessages: 2, acceptedPayloadBytes: Buffer.byteLength(payload) * 2 });
    closeBrowserConnectionDiagnostics(second);
    expect(last("closed")).toMatchObject({ acceptedMessages: 1, acceptedPayloadBytes: Buffer.byteLength(payload) });
    expect(JSON.stringify(entries)).not.toContain("private");
    expect(new Set(entries.map((entry) => entry.meta?.connectionId)).size).toBe(2);
  });

  it("preserves dropped, backpressured, and throwing send outcomes", () => {
    // A queued send is counted once. A zero/throw is not successful delivery,
    // and instrumentation must return/throw exactly what the socket does.
    const ws = makeSocket();
    openBrowserConnectionDiagnostics(ws, "session");
    ws.send
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(-1)
      .mockImplementationOnce(() => {
        throw new Error("private failure");
      });
    ws.getBufferedAmount = () => 512;
    expect(sendObservedBrowserPayload(ws, "abc", "assistant")).toBe(0);
    expect(sendObservedBrowserPayload(ws, "abc", "assistant")).toBe(-1);
    expect(() => sendObservedBrowserPayload(ws, "abc", "assistant")).toThrow("private failure");
    closeBrowserConnectionDiagnostics(ws);
    expect(last("closed")).toMatchObject({
      attemptedMessages: 3,
      acceptedMessages: 1,
      acceptedPayloadBytes: 3,
      droppedMessages: 1,
      failedMessages: 1,
      backpressuredMessages: 1,
      peakBufferedBytes: 512,
    });
    expect(JSON.stringify(entries)).not.toContain("private failure");
  });

  it("separates server subscribe work from exact-socket marker receipt", () => {
    const ws = makeSocket();
    const other = makeSocket();
    openBrowserConnectionDiagnostics(ws, "session");
    openBrowserConnectionDiagnostics(other, "session");
    vi.advanceTimersByTime(80);
    beginBrowserConnectionSubscribe(ws, 14);
    beginBrowserConnectionSubscribe(other, 0);
    vi.advanceTimersByTime(20);
    finishBrowserConnectionSubscribe(ws, true);
    finishBrowserConnectionSubscribe(other, true);
    const id = probeId(ws);
    acknowledgeBrowserConnection(other, id);
    expect(last("client_marker_received")).toBeUndefined();
    vi.advanceTimersByTime(300);
    acknowledgeBrowserConnection(ws, id);
    expect(last("client_marker_received")).toMatchObject({
      elapsedMs: 400,
      subscribeStartDelayMs: 80,
      subscribeHandlerMs: 20,
      markerReceiptDelayMs: 300,
      initialLastSeq: 14,
    });
    acknowledgeBrowserConnection(ws, id);
    beginBrowserConnectionSubscribe(ws, 0, true);
    finishBrowserConnectionSubscribe(ws, true);
    expect(entries.filter((entry) => entry.meta?.event === "client_marker_received")).toHaveLength(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("warns once for an unfinished sync and cancels timers on receipt or close", () => {
    const ws = makeSocket();
    openBrowserConnectionDiagnostics(ws, "session");
    vi.advanceTimersByTime(10_000);
    expect(last("initial_sync_slow")).toMatchObject({ status: "awaiting_subscribe", warnings: ["slow_initial_sync"] });
    vi.advanceTimersByTime(30_000);
    expect(entries.filter((entry) => entry.meta?.event === "initial_sync_slow")).toHaveLength(1);
    closeBrowserConnectionDiagnostics(ws);
    const next = makeSocket();
    openBrowserConnectionDiagnostics(next, "session");
    beginBrowserConnectionSubscribe(next, 0);
    finishBrowserConnectionSubscribe(next, true);
    acknowledgeBrowserConnection(next, probeId(next));
    const earlyClose = makeSocket();
    openBrowserConnectionDiagnostics(earlyClose, "session");
    closeBrowserConnectionDiagnostics(earlyClose);
    vi.advanceTimersByTime(10_000);
    expect(entries.filter((entry) => entry.meta?.event === "initial_sync_slow")).toHaveLength(1);
  });

  it("reports large initial syncs independently of duration and bounds type metadata", () => {
    const ws = makeSocket();
    openBrowserConnectionDiagnostics(ws, "session");
    beginBrowserConnectionSubscribe(ws, 0);
    sendObservedBrowserPayload(ws, "x".repeat(2 * 1024 * 1024), "state_snapshot");
    for (let index = 0; index < 100; index++) {
      sendObservedBrowserPayload(ws, "x", `type_${String.fromCharCode(97 + index)}`);
    }
    sendObservedBrowserPayload(ws, "x", "private command / secret");
    finishBrowserConnectionSubscribe(ws, true);
    const summary = last("initial_sync_queued")!;
    expect(summary.warnings).toEqual(["large_initial_payload"]);
    expect((summary.largestMessageTypes as unknown[]).length).toBeLessThanOrEqual(8);
    const buckets = summary.largestMessageTypes as Array<{ payloadBytes: number }>;
    expect(
      buckets.reduce((sum, bucket) => sum + bucket.payloadBytes, 0) + Number(summary.otherAcceptedPayloadBytes),
    ).toBe(summary.acceptedPayloadBytes);
    expect(JSON.stringify(entries)).not.toContain("private command");
  });

  it("preserves failed subscribe evidence and closes its timeout", () => {
    const ws = makeSocket();
    openBrowserConnectionDiagnostics(ws, "session");
    beginBrowserConnectionSubscribe(ws, 0, true);
    finishBrowserConnectionSubscribe(ws, false);
    expect(last("initial_sync_failed")).toMatchObject({ status: "subscribe_failed", explicitFullHistory: true });
    vi.advanceTimersByTime(10_000);
    expect(last("initial_sync_slow")).toBeUndefined();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("retains only coarse client classification", () => {
    expect(classifyBrowserClientPlatform("Mozilla iPhone Safari private-token")).toBe("ios");
    expect(classifyBrowserClientPlatform("Mozilla Android Chrome")).toBe("android");
    expect(classifyBrowserClientPlatform("Mozilla Macintosh Safari")).toBe("other");
    expect(classifyBrowserClientPlatform(null)).toBe("unknown");
  });
});
