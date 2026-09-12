// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWsTransport, type WsTransport } from "./ws-transport.js";

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    MockSocket.instances.push(this);
  }
}

let transport: WsTransport;
const received = vi.fn();

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  MockSocket.instances = [];
  received.mockReset();
  localStorage.clear();
  transport = createWsTransport({
    hasLocalMessages: () => false,
    getKnownFrozenCount: () => 0,
    getKnownFrozenHash: () => undefined,
    getFreshHistoryWindow: () => ({ sectionTurnCount: 10, visibleSectionCount: 3 }),
    onMessage: received,
  });
});

afterEach(() => {
  transport.disconnectAll();
  vi.unstubAllGlobals();
});

it("acknowledges the initial-sync marker without inserting a feed message", () => {
  // The marker follows the producer's state snapshot. Receipt says nothing
  // about React paint and must not enter history, replay, or application state.
  transport.connectSession("session");
  const socket = MockSocket.instances[0]!;
  socket.onopen!();
  socket.onmessage!({ data: JSON.stringify({ type: "state_snapshot", sessionStatus: "idle" }) });
  socket.onmessage!({ data: JSON.stringify({ type: "browser_connection_probe", connection_id: "connection-a" }) });
  expect(received).toHaveBeenCalledTimes(1);
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({
    type: "browser_connection_probe_ack",
    connection_id: "connection-a",
  });
});

it("does not acknowledge a replaced socket's delayed marker", () => {
  // A queued callback from the old physical connection cannot be attributed
  // to the new connection, even though both sockets represent the same session.
  transport.connectSession("session");
  const previous = MockSocket.instances[0]!;
  previous.onopen!();
  transport.reconnectSession("session");
  previous.send.mockClear();
  previous.onmessage!({ data: JSON.stringify({ type: "browser_connection_probe", connection_id: "old-connection" }) });
  expect(previous.send).not.toHaveBeenCalled();
  expect(received).not.toHaveBeenCalled();
});
