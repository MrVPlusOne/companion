import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTimerFile } from "../timer-types.js";
import type { RouteContext } from "./context.js";
import { TimerManager } from "../timer-manager.js";
import { createTimerRoutes } from "./timers.js";

const savedFiles = new Map<string, SessionTimerFile>();

// Exercise the real manager and HTTP route without reading or writing live
// session timers. Serialization also proves the destination is persisted.
vi.mock("../timer-store.js", () => ({
  loadTimers: vi.fn(async (sessionId: string) => savedFiles.get(sessionId) ?? { sessionId, nextId: 1, timers: [] }),
  saveTimers: vi.fn(async (data: SessionTimerFile) => {
    savedFiles.set(data.sessionId, JSON.parse(JSON.stringify(data)));
  }),
}));
vi.mock("../session-names.js", () => ({ getAllNames: vi.fn(() => ({})) }));

function setup(options: { leader?: boolean; generating?: boolean; threadKey?: string; missingSession?: boolean } = {}) {
  const session = options.missingSession
    ? undefined
    : {
        state: { isOrchestrator: options.leader ?? true },
        isGenerating: options.generating ?? true,
        activeTurnRoute: options.threadKey === undefined ? null : { threadKey: options.threadKey },
      };
  const wsBridge = {
    getSession: vi.fn(() => session),
    broadcastToSession: vi.fn(),
  };
  const timerManager = new TimerManager(wsBridge as unknown as ConstructorParameters<typeof TimerManager>[0]);
  const app = createTimerRoutes({
    wsBridge,
    timerManager,
    launcher: { getSession: vi.fn(() => ({ isOrchestrator: options.leader ?? true })) },
    authenticateTakodeCaller: () => ({ sessionId: "timer-owner" }),
    resolveId: () => "timer-owner",
  } as unknown as RouteContext);
  return { app, session, timerManager };
}

function createTimer(app: ReturnType<typeof createTimerRoutes>, extra: Record<string, unknown> = {}) {
  return app.request("/sessions/timer-owner/timers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Check build", in: "5m", ...extra }),
  });
}

describe("timer creation destinations", () => {
  beforeEach(() => savedFiles.clear());

  it.each(["main", "q-42"])("defaults a running leader timer to the active %s thread", async (threadKey) => {
    // The active route is authoritative only for a currently generating turn.
    const { app } = setup({ threadKey });
    const response = await createTimer(app);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ timer: { threadKey } });
    expect(savedFiles.get("timer-owner")?.timers[0].threadKey).toBe(threadKey);
  });

  it("uses an explicit destination instead of the current active thread", async () => {
    const { app, session } = setup({ threadKey: "q-42" });
    const response = await createTimer(app, { threadKey: "main" });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ timer: { threadKey: "main" } });
    expect(session?.activeTurnRoute?.threadKey).toBe("q-42");
  });

  it.each([
    { generating: false, threadKey: "q-42" },
    { generating: true },
    { generating: true, threadKey: "invalid" },
    { missingSession: true },
  ])("requires an explicit leader destination without reliable active context: %j", async (options) => {
    // Idle/stale history and missing bridge state cannot silently choose Main
    // or the last quest; launcher identity still protects disconnected leaders.
    const { app } = setup(options);
    const response = await createTimer(app);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Leader timer requires --thread main or --thread q-N when no active thread is known",
    });
    expect(savedFiles.size).toBe(0);
  });

  it("accepts an explicit destination without an active leader turn", async () => {
    const { app } = setup({ generating: false });
    const response = await createTimer(app, { threadKey: "q-42" });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ timer: { threadKey: "q-42" } });
  });

  it("rejects malformed destinations at the HTTP boundary", async () => {
    const { app } = setup({ threadKey: "main" });
    const response = await createTimer(app, { threadKey: 42 });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Timer thread must be main or q-N" });
    expect(savedFiles.size).toBe(0);
  });

  it("keeps non-leader timers unassociated when no destination is supplied", async () => {
    // Worker and standalone timer creation retains its existing input contract.
    const { app } = setup({ leader: false, generating: false });
    const response = await createTimer(app);

    expect(response.status).toBe(201);
    expect((await response.json()).timer).not.toHaveProperty("threadKey");
    expect(savedFiles.get("timer-owner")?.timers[0]).not.toHaveProperty("threadKey");
  });
});
