import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionTimerFile } from "./timer-types.js";

// ─── Mock store state (module-level, shared by mock and tests) ───────────────

const mockFiles = new Map<string, SessionTimerFile>();

// Mock the timer-store module so tests don't touch disk.
vi.mock("./timer-store.js", () => ({
  loadTimers: vi.fn(async (sessionId: string) => {
    return mockFiles.get(sessionId) ?? { sessionId, nextId: 1, timers: [] };
  }),
  saveTimers: vi.fn(async (data: SessionTimerFile) => {
    mockFiles.set(data.sessionId, JSON.parse(JSON.stringify(data)));
  }),
  deleteTimers: vi.fn(async (sessionId: string) => {
    mockFiles.delete(sessionId);
  }),
  listTimerSessions: vi.fn(async () => [...mockFiles.keys()]),
  getTimerDir: vi.fn(() => "/tmp/mock-timers"),
}));

// Import after mock so the mock is in effect.
import { TimerManager } from "./timer-manager.js";

function createMockBridge(options?: { backendConnected?: () => boolean; sessionPaused?: () => boolean }) {
  return {
    injectUserMessage: vi.fn(() => (options?.backendConnected?.() === false ? ("queued" as const) : ("sent" as const))),
    broadcastToSession: vi.fn(),
    isBackendConnected: vi.fn(() => options?.backendConnected?.() ?? true),
    isSessionPaused: vi.fn(() => options?.sessionPaused?.() ?? false),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TimerManager", () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let manager: TimerManager;
  let backendConnected: boolean;
  let sessionPaused: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-04-08T12:00:00Z") });
    mockFiles.clear();
    backendConnected = true;
    sessionPaused = false;
    bridge = createMockBridge({ backendConnected: () => backendConnected, sessionPaused: () => sessionPaused });
    manager = new TimerManager(bridge);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe("createTimer", () => {
    it("creates a one-shot delay timer", async () => {
      const timer = await manager.createTimer("session-1", {
        title: "check the build",
        description: "Inspect the latest failing shard if the build is red.",
        in: "30m",
      });

      expect(timer.id).toBe("t1");
      expect(timer.type).toBe("delay");
      expect(timer.title).toBe("check the build");
      expect(timer.description).toBe("Inspect the latest failing shard if the build is red.");
      expect(timer.nextFireAt).toBe(Date.now() + 1_800_000);
      expect(timer.fireCount).toBe(0);
    });

    it("creates a recurring timer", async () => {
      const timer = await manager.createTimer("session-1", {
        title: "refresh context",
        every: "10m",
      });

      expect(timer.id).toBe("t1");
      expect(timer.type).toBe("recurring");
      expect(timer.intervalMs).toBe(600_000);
    });

    it("persists an explicit normalized timer destination", async () => {
      // The stored destination must survive later activity in another thread.
      const timer = await manager.createTimer("session-1", {
        title: "check build",
        in: "5m",
        threadKey: " Q-42 ",
      });

      expect(timer.threadKey).toBe("q-42");
      expect(mockFiles.get("session-1")?.timers[0].threadKey).toBe("q-42");
    });

    it.each(["", "all", "q-nope", 42, null])("rejects an invalid explicit destination: %s", async (threadKey) => {
      // REST input is untrusted even though the TypeScript input is a string.
      await expect(
        manager.createTimer("session-1", { title: "check build", in: "5m", threadKey: threadKey as string }),
      ).rejects.toThrow("Timer thread must be main or q-N");
      expect(mockFiles.size).toBe(0);
    });

    it("increments timer IDs", async () => {
      const t1 = await manager.createTimer("session-1", { title: "a", in: "5m" });
      const t2 = await manager.createTimer("session-1", { title: "b", in: "10m" });
      const t3 = await manager.createTimer("session-1", { title: "c", every: "15m" });

      expect(t1.id).toBe("t1");
      expect(t2.id).toBe("t2");
      expect(t3.id).toBe("t3");
    });

    it("broadcasts timer update to browsers", async () => {
      await manager.createTimer("session-1", { title: "test", in: "5m" });

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: expect.arrayContaining([expect.objectContaining({ id: "t1" })]),
      });
    });

    it("rejects empty title", async () => {
      await expect(manager.createTimer("session-1", { title: "", in: "5m" })).rejects.toThrow("title is required");
    });

    it("rejects when timer limit is reached", async () => {
      // Create 50 timers (the max)
      for (let i = 0; i < 50; i++) {
        await manager.createTimer("session-1", { title: `timer ${i}`, in: "30m" });
      }
      // The 51st should be rejected
      await expect(manager.createTimer("session-1", { title: "one too many", in: "5m" })).rejects.toThrow(
        "Timer limit reached",
      );
    });
  });

  describe("cancelTimer", () => {
    it("removes a timer", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      const cancelled = await manager.cancelTimer("session-1", "t1");

      expect(cancelled).toBe(true);
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("returns false for non-existent timer", async () => {
      const cancelled = await manager.cancelTimer("session-1", "t99");
      expect(cancelled).toBe(false);
    });

    it("broadcasts after cancel", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      bridge.broadcastToSession.mockClear();

      await manager.cancelTimer("session-1", "t1");

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: [],
      });
    });

    it("injects a cancellation message into the session", async () => {
      await manager.createTimer("session-1", {
        title: "check the build",
        description: "Inspect the latest failing shard if the build is red.",
        in: "5m",
      });
      bridge.injectUserMessage.mockClear();

      await manager.cancelTimer("session-1", "t1");

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "session-1",
        "[⏰ Timer t1 cancelled] check the build",
        { sessionId: "timer:t1", sessionLabel: "Timer t1" },
        undefined,
        undefined,
      );
    });

    it("routes cancellation to the recorded destination without firing authority", async () => {
      // A cancellation shares the timer source label but is not an occurrence
      // that an explicit answer may cover.
      await manager.createTimer("session-1", { title: "check build", in: "5m", threadKey: "q-42" });
      await manager.cancelTimer("session-1", "t1");

      const call = bridge.injectUserMessage.mock.calls[0];
      expect(call[4]).toEqual({
        threadKey: "q-42",
        questId: "q-42",
        threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
      });
      expect(call[5]).toBeUndefined();
    });
  });

  describe("listTimers", () => {
    it("returns empty array for unknown session", () => {
      expect(manager.listTimers("unknown")).toEqual([]);
    });

    it("returns all timers for a session", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      await manager.createTimer("session-1", { title: "b", every: "10m" });

      const timers = manager.listTimers("session-1");
      expect(timers).toHaveLength(2);
    });
  });

  describe("cancelAllTimers", () => {
    it("removes all timers for a session", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      await manager.createTimer("session-1", { title: "b", every: "10m" });

      await manager.cancelAllTimers("session-1");

      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("broadcasts empty timer list", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      bridge.broadcastToSession.mockClear();

      await manager.cancelAllTimers("session-1");

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: [],
      });
    });
  });

  describe("sweep (firing timers)", () => {
    /** Access the private sweep method for direct testing without waiting for setInterval. */
    async function triggerSweep(mgr: TimerManager) {
      await (mgr as any).sweep();
    }

    it("fires a one-shot delay timer when due", async () => {
      await manager.createTimer("session-1", {
        title: "do something",
        description: "Open the latest incident thread and summarize the blocker.",
        in: "5m",
      });

      // Advance time past the timer's fire time
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "session-1",
        "[⏰ Timer t1 reminder] do something\n\nThis is a reminder from your earlier timer note, not a new user instruction.\n\nEarlier note:\nOpen the latest incident thread and summarize the blocker.",
        {
          sessionId: "timer:t1",
          sessionLabel: "Timer t1",
        },
        undefined,
        undefined,
        { timerFiring: { timerId: "t1", scheduledFireAt: new Date("2026-04-08T12:05:00Z").getTime() } },
      );
      // One-shot should be removed after firing
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("fires a recurring timer and advances nextFireAt", async () => {
      await manager.createTimer("session-1", {
        title: "ping",
        description: "Check whether the watch job still needs attention.",
        every: "10m",
      });

      // First fire
      vi.advanceTimersByTime(10 * 60_000 + 1);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "session-1",
        "[⏰ Timer t1 reminder] ping\n\nThis is a reminder from your earlier timer note, not a new user instruction.\n\nEarlier note:\nCheck whether the watch job still needs attention.",
        {
          sessionId: "timer:t1",
          sessionLabel: "Timer t1",
        },
        undefined,
        undefined,
        { timerFiring: { timerId: "t1", scheduledFireAt: new Date("2026-04-08T12:10:00Z").getTime() } },
      );
      // Recurring timer should still exist
      const timers = manager.listTimers("session-1");
      expect(timers).toHaveLength(1);
      expect(timers[0].fireCount).toBe(1);
      expect(timers[0].nextFireAt).toBeGreaterThan(Date.now());

      // Second fire
      bridge.injectUserMessage.mockClear();
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      expect(manager.listTimers("session-1")[0].fireCount).toBe(2);
      expect(bridge.injectUserMessage.mock.calls[0][5]).toEqual({
        timerFiring: { timerId: "t1", scheduledFireAt: new Date("2026-04-08T12:20:00Z").getTime() },
      });
    });

    it("preserves the on-time connected-session timer message", async () => {
      // On-time connected delivery should keep the existing concise reminder shape
      // without late-delivery or skipped-occurrence annotations.
      await manager.createTimer("session-1", {
        title: "check status",
        description: "Read the dashboard and report only current blockers.",
        in: "5m",
      });

      vi.advanceTimersByTime(5 * 60_000 + 1);
      await triggerSweep(manager);

      const content = bridge.injectUserMessage.mock.calls[0]?.[1] as string;
      expect(content).toBe(
        "[⏰ Timer t1 reminder] check status\n\nThis is a reminder from your earlier timer note, not a new user instruction.\n\nEarlier note:\nRead the dashboard and report only current blockers.",
      );
      expect(content).not.toContain("initially scheduled");
      expect(content).not.toContain("skipped");
    });

    it("does not fire a timer before its time", async () => {
      await manager.createTimer("session-1", { title: "not yet", in: "30m" });

      vi.advanceTimersByTime(5 * 60_000); // Only 5 minutes
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
      expect(manager.listTimers("session-1")).toHaveLength(1);
    });

    it("handles recurring catchup (fires once, skips missed intervals)", async () => {
      await manager.createTimer("session-1", { title: "check", every: "10m" });

      // Advance 35 minutes (missed 3 intervals)
      vi.advanceTimersByTime(35 * 60_000 + 1);
      await triggerSweep(manager);

      // Should fire exactly once
      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      // nextFireAt should be advanced past "now"
      const timers = manager.listTimers("session-1");
      expect(timers[0].nextFireAt).toBeGreaterThan(Date.now());
      expect(timers[0].fireCount).toBe(1);
    });

    it("fires a coalesced recurring timer event while the backend is disconnected", async () => {
      // Disconnected is a transport state, so due recurring timers still enqueue
      // work through the normal injected-message path and let recovery happen
      // on demand instead of waiting for a later reconnect.
      await manager.createTimer("session-1", {
        title: "priority check",
        description: "Look at only the active incident lane.",
        every: "10m",
      });

      backendConnected = false;
      vi.advanceTimersByTime(35 * 60_000 + 1);
      const result = await (manager as any).sweep();

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      expect(result.fired).toEqual([{ sessionId: "session-1", timerId: "t1", delivery: "queued" }]);
      const content = bridge.injectUserMessage.mock.calls[0]?.[1] as string;
      expect(content).toContain("2 earlier due occurrences were skipped while the session was unavailable.");
      expect(content).toContain("This timer was initially scheduled to fire at 2026-04-08T12:30:00.000Z.");
      expect(content).toContain("Earlier note:\nLook at only the active incident lane.");
      // Catch-up identifies the newest delivered occurrence, never the skipped
      // intervals or actual late wall-clock delivery time.
      expect(bridge.injectUserMessage.mock.calls[0][5]).toEqual({
        timerFiring: { timerId: "t1", scheduledFireAt: new Date("2026-04-08T12:30:00Z").getTime() },
      });

      const [timer] = manager.listTimers("session-1");
      expect(timer.fireCount).toBe(1);
      expect(timer.lastFiredAt).toBe(Date.now());
      expect(timer.nextFireAt).toBe(new Date("2026-04-08T12:40:00Z").getTime());
    });

    it("fires one-shot timers once even when late and backend-disconnected", async () => {
      // One-shot timers intentionally keep using injectUserMessage while offline
      // so the existing queued-message/relaunch path can deliver them exactly once.
      await manager.createTimer("session-1", {
        title: "single late reminder",
        description: "Send the one-time handoff.",
        in: "5m",
      });

      backendConnected = false;
      vi.advanceTimersByTime(11 * 60_000);
      await triggerSweep(manager);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      const content = bridge.injectUserMessage.mock.calls[0]?.[1] as string;
      expect(content).toContain("This timer was initially scheduled to fire at 2026-04-08T12:05:00.000Z.");
      expect(content).toContain("Earlier note:\nSend the one-time handoff.");
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("holds due timers while a session is paused and fires after unpause", async () => {
      // Paused sessions must not turn scheduled reminders into model input.
      // Keeping the timer due lets unpause resume the normal timer path.
      await manager.createTimer("session-1", {
        title: "paused reminder",
        description: "Resume only after explicit unpause.",
        in: "5m",
      });

      sessionPaused = true;
      vi.advanceTimersByTime(6 * 60_000);
      const pausedResult = await (manager as any).sweep();

      expect(pausedResult.skipped).toEqual([{ sessionId: "session-1", timerId: "t1", reason: "session_paused" }]);
      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
      expect(manager.listTimers("session-1")[0]).toMatchObject({ fireCount: 0 });

      sessionPaused = false;
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      expect(bridge.injectUserMessage.mock.calls[0]?.[1]).toContain("[⏰ Timer t1 reminder] paused reminder");
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("coalesces recurring timer occurrences missed while the session is paused", async () => {
      // Paused recurring timers behave like downtime: unpause delivers the newest
      // due occurrence once and reports older occurrences as skipped.
      await manager.createTimer("session-1", {
        title: "pause coalescing",
        description: "Only the newest recurrence should fire.",
        every: "10m",
      });

      sessionPaused = true;
      vi.advanceTimersByTime(10 * 60_000 + 1);
      await triggerSweep(manager);
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
      expect(manager.listTimers("session-1")[0]).toMatchObject({
        fireCount: 0,
        nextFireAt: new Date("2026-04-08T12:10:00Z").getTime(),
      });

      sessionPaused = false;
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      const content = bridge.injectUserMessage.mock.calls[0]?.[1] as string;
      expect(content).toContain("2 earlier due occurrences were skipped while the session was unavailable.");
      expect(content).toContain("This timer was initially scheduled to fire at 2026-04-08T12:30:00.000Z.");

      const [timer] = manager.listTimers("session-1");
      expect(timer.fireCount).toBe(1);
      expect(timer.nextFireAt).toBe(new Date("2026-04-08T12:40:00Z").getTime());
    });

    it("cancelled timer never fires", async () => {
      await manager.createTimer("session-1", { title: "bye", in: "5m" });
      await manager.cancelTimer("session-1", "t1");

      // Clear mock after cancelTimer's notification, then verify sweep doesn't fire
      bridge.injectUserMessage.mockClear();
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    });

    it("does not reuse timer IDs after all timers fire and are removed", async () => {
      // Create two one-shot timers: t1 and t2
      await manager.createTimer("session-1", { title: "first", in: "5m" });
      await manager.createTimer("session-1", { title: "second", in: "10m" });

      // Fire both timers (sweep removes one-shot timers after firing)
      vi.advanceTimersByTime(15 * 60_000);
      await triggerSweep(manager);

      // All timers should be gone from memory
      expect(manager.listTimers("session-1")).toHaveLength(0);

      // Creating a new timer should NOT reuse t1 -- nextId should have been
      // preserved on disk even though the session was evicted from memory
      const t3 = await manager.createTimer("session-1", { title: "third", in: "5m" });
      expect(t3.id).toBe("t3");
    });
  });

  describe("startAll (server restart recovery)", () => {
    it.each(["main", "q-42"])("restores and fires the recorded %s destination", async (threadKey) => {
      // Restart and later leader thread selection cannot retarget a timer.
      await manager.createTimer("session-1", { title: "restored destination", in: "5m", threadKey });
      manager.destroy();
      manager = new TimerManager(bridge);
      await manager.startAll();
      vi.setSystemTime(new Date("2026-04-08T12:05:00Z"));

      await manager.sweepDueTimersNow();

      expect(bridge.injectUserMessage.mock.calls[0][4]).toMatchObject({ threadKey });
      expect(bridge.injectUserMessage.mock.calls[0][5]).toEqual({
        timerFiring: { timerId: "t1", scheduledFireAt: Date.now() },
      });
    });

    it("loads timers from disk on startup", async () => {
      // Pre-populate the mock store with saved timer data
      mockFiles.set("session-saved", {
        sessionId: "session-saved",
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: "session-saved",
            title: "restored timer",
            description: "restore detail",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: Date.now() + 600_000,
            intervalMs: 600_000,
            createdAt: Date.now() - 3_600_000,
            fireCount: 5,
          },
        ],
      });

      await manager.startAll();

      const timers = manager.listTimers("session-saved");
      expect(timers).toHaveLength(1);
      expect(timers[0].title).toBe("restored timer");
      // Old persisted timers stay unassociated; loading does not migrate them
      // using whatever thread happens to be active at restart.
      expect(timers[0]).not.toHaveProperty("threadKey");
      vi.setSystemTime(new Date("2026-04-08T12:10:00Z"));
      await manager.sweepDueTimersNow();
      expect(bridge.injectUserMessage.mock.calls[0][4]).toBeUndefined();
      expect(mockFiles.get("session-saved")?.timers[0]).not.toHaveProperty("threadKey");
    });
  });
});
