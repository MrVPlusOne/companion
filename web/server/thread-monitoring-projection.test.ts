import { describe, expect, it, vi } from "vitest";
import { WsBridge } from "./ws-bridge.js";
import { setThreadMonitoring, acknowledgeMonitoredThreadResult } from "./thread-monitoring.js";
import { THREAD_MONITORING_PROJECTION } from "../shared/thread-monitoring.js";

describe("monitoring synchronized authority", () => {
  it("subscribes a restored leader whose role is still owned by launcher metadata", () => {
    const bridge = new WsBridge();
    bridge.getOrCreateSession("leader");
    bridge.launcher = { getSession: () => ({ isOrchestrator: true }) } as any;
    const messages = bridge
      .getSyncedProjectionController()
      .replaceSubscriptions(
        { data: { kind: "browser", sessionId: "leader" }, send: vi.fn(), close: vi.fn(), readyState: 1 } as any,
        [{ projection: THREAD_MONITORING_PROJECTION, key: "leader" }],
      );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "synced_projection_snapshot", projection: THREAD_MONITORING_PROJECTION }),
    );
  });
  it("broadcasts persistent changes to separate browsers and restores a fresh snapshot on reconnect", async () => {
    const bridge = new WsBridge();
    const session = bridge.getOrCreateSession("leader");
    session.state.isOrchestrator = true;
    session.state.leaderOpenThreadTabs = {
      version: 1,
      orderedOpenThreadKeys: ["q-42"],
      closedThreadTombstones: [],
      updatedAt: 1,
    };
    session.state.leaderThreadStatuses = {
      "q-42": {
        kind: "ready",
        label: "Thread Ready",
        threadKey: "q-42",
        messageId: "result",
        timestamp: 1,
        summary: "Ready",
        updatedAt: 1,
      },
    };
    const controller = bridge.getSyncedProjectionController();
    const sockets = [1, 2].map(() => ({
      data: { kind: "browser", sessionId: "leader" },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    }));
    for (const socket of sockets)
      controller.replaceSubscriptions(socket as any, [{ projection: THREAD_MONITORING_PROJECTION, key: "leader" }]);
    setThreadMonitoring(session, "q-42", true);
    bridge.persistSessionById(session.id);
    await controller.flushForTest();
    for (const socket of sockets)
      expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw))).toContainEqual(
        expect.objectContaining({
          projection: THREAD_MONITORING_PROJECTION,
          value: expect.objectContaining({ trackedCount: 1, pendingCount: 1 }),
        }),
      );
    const pending = session.state.threadMonitoring!.threads["q-42"].pending!.id;
    acknowledgeMonitoredThreadResult(session, "q-42", pending);
    bridge.persistSessionById(session.id);
    await controller.flushForTest();
    const reconnect = controller.replaceSubscriptions(
      { data: { kind: "browser", sessionId: "leader" }, send: vi.fn(), close: vi.fn(), readyState: 1 } as any,
      [{ projection: THREAD_MONITORING_PROJECTION, key: "leader" }],
    );
    expect(reconnect).toContainEqual(
      expect.objectContaining({
        type: "synced_projection_snapshot",
        value: expect.objectContaining({ trackedCount: 1, pendingCount: 0 }),
      }),
    );
  });
});
