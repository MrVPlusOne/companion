import type { Hono } from "hono";
import type { ThreadMonitoringEntry, ThreadMonitoringPage } from "../../shared/thread-monitoring.js";
import { acknowledgeMonitoredThreadResult, setThreadMonitoring } from "../thread-monitoring.js";
import { getQuest } from "../quest-store.js";
import type { RouteContext } from "./context.js";

/** Browser-owned monitoring commands and a bounded global list, independent of tab visibility. */
export function registerThreadMonitoringRoutes(api: Hono, ctx: RouteContext): void {
  api.get("/thread-monitoring", async (c) => {
    const all = c.req.query("filter") === "all";
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "Invalid offset" }, 400);
    const entries: ThreadMonitoringEntry[] = [];
    for (const launcher of ctx.launcher.listSessions()) {
      if (launcher.hidden || launcher.archived) continue;
      const session = ctx.wsBridge.getSession(launcher.sessionId);
      if (!session || !(session.state.isOrchestrator || launcher.isOrchestrator)) continue;
      for (const [threadKey, monitor] of Object.entries(session.state.threadMonitoring?.threads ?? {})) {
        if (!all && !monitor.pending) continue;
        entries.push({
          sessionId: session.id,
          sessionName: launcher.name || "Leader",
          sessionNum: launcher.sessionNum ?? null,
          threadKey,
          title: session.board.get(threadKey)?.title || session.completedBoard.get(threadKey)?.title || threadKey,
          trackedAt: monitor.trackedAt,
          pending: monitor.pending,
        });
      }
    }
    entries.sort(
      (left, right) =>
        (right.pending?.timestamp ?? right.trackedAt) - (left.pending?.timestamp ?? left.trackedAt) ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.threadKey.localeCompare(right.threadKey),
    );
    const page = entries.slice(offset, offset + 50);
    await Promise.all(
      page.map(async (entry) => {
        const quest = await getQuest(entry.threadKey);
        if (quest?.title) entry.title = quest.title;
      }),
    );
    return c.json({
      entries: page,
      total: entries.length,
      nextOffset: offset + page.length < entries.length ? offset + page.length : null,
    } satisfies ThreadMonitoringPage);
  });

  api.post("/sessions/:id/thread-monitoring/:threadKey", async (c) => {
    const id = ctx.resolveId(c.req.param("id"));
    const session = id ? ctx.wsBridge.getSession(id) : undefined;
    const launcher = id ? ctx.launcher.getSession(id) : undefined;
    if (!session || !launcher) return c.json({ error: "Session not found" }, 404);
    if (launcher.archived || !(session.state.isOrchestrator || launcher.isOrchestrator))
      return c.json({ error: "Choose an active leader task tab" }, 409);
    const threadKey = c.req.param("threadKey");
    if (!/^q-\d+$/.test(threadKey)) return c.json({ error: "Notify Me is available on named task tabs" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || !["track", "untrack", "acknowledge"].includes(body.action))
      return c.json({ error: "Invalid monitoring action" }, 400);
    if (
      body.action === "track" &&
      !session.state.threadMonitoring?.threads[threadKey] &&
      !session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys.includes(threadKey) &&
      !session.board.has(threadKey) &&
      !session.completedBoard.has(threadKey)
    ) {
      return c.json({ error: "Open the task tab before enabling Notify Me" }, 409);
    }
    const changed =
      body.action === "acknowledge"
        ? acknowledgeMonitoredThreadResult(session, threadKey, body.resultId)
        : setThreadMonitoring(session, threadKey, body.action === "track");
    if (changed) ctx.wsBridge.persistSessionById(session.id);
    return c.json({ ok: true, changed });
  });
}
