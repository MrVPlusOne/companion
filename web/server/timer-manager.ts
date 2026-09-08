import type { WsBridge } from "./ws-bridge.js";
import type { SessionTimer, SessionTimerFile, TimerCreateInput } from "./timer-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import { resolveTimerSchedule } from "./timer-parse.js";
import * as timerStore from "./timer-store.js";
import { normalizeThreadTarget } from "../shared/thread-routing.js";
import { normalizeThreadRoute } from "./thread-routing-metadata.js";

const SWEEP_INTERVAL_MS = 5_000;
const MAX_TIMERS_PER_SESSION = 50;
const LATE_TIMER_THRESHOLD_MS = 5 * 60_000;
const LOG_TAG = "[timer-manager]";

interface TimerFireContext {
  scheduledFireAt: number;
  skippedCount?: number;
}

export interface TimerSweepResult {
  fired: Array<{
    sessionId: string;
    timerId: string;
    delivery: "sent" | "queued" | "paused_queued" | "dropped" | "no_session";
  }>;
  skipped: Array<{
    sessionId: string;
    timerId: string;
    reason: "session_paused";
  }>;
}

export class TimerManager {
  /** In-memory cache: sessionId -> SessionTimerFile */
  private sessions = new Map<string, SessionTimerFile>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private wsBridge: WsBridge) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Load all timer files from disk and start the sweep loop. Called at server startup. */
  async startAll(): Promise<void> {
    const sessionIds = await timerStore.listTimerSessions();
    let loaded = 0;
    for (const sid of sessionIds) {
      const data = await timerStore.loadTimers(sid);
      if (data.timers.length > 0) {
        this.sessions.set(sid, data);
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log(`${LOG_TAG} Loaded timers for ${loaded} session(s)`);
    }

    this.startSweep();
  }

  /** Stop the sweep loop and clear in-memory state. Called on shutdown. */
  destroy(): void {
    this.stopSweep();
    this.sessions.clear();
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  /** Create a new timer for a session. Returns the created timer. */
  async createTimer(sessionId: string, input: TimerCreateInput): Promise<SessionTimer> {
    const title = input.title?.trim();
    if (!title) throw new Error("Timer title is required");
    const threadTarget = typeof input.threadKey === "string" ? normalizeThreadTarget(input.threadKey) : null;
    if (input.threadKey !== undefined && !threadTarget) {
      throw new Error("Timer thread must be main or q-N");
    }

    const schedule = resolveTimerSchedule(input);
    if (!Number.isFinite(schedule.nextFireAt)) throw new Error("Invalid timer schedule: non-finite fire time");

    const file = await this.getOrCreateFile(sessionId);
    if (file.timers.length >= MAX_TIMERS_PER_SESSION) {
      throw new Error(`Timer limit reached (max ${MAX_TIMERS_PER_SESSION} per session)`);
    }

    const id = `t${file.nextId++}`;

    const timer: SessionTimer = {
      id,
      sessionId,
      ...(threadTarget ? { threadKey: threadTarget.threadKey } : {}),
      title,
      description: input.description?.trim() ?? "",
      type: schedule.type,
      originalSpec: schedule.originalSpec,
      nextFireAt: schedule.nextFireAt,
      intervalMs: schedule.intervalMs,
      createdAt: Date.now(),
      fireCount: 0,
    };

    file.timers.push(timer);
    this.persistSession(sessionId);
    this.broadcastTimers(sessionId);

    console.log(
      `${LOG_TAG} Created timer ${id} for session ${sessionId.slice(0, 8)} ` +
        `(${timer.type}, fires ${new Date(timer.nextFireAt).toISOString()})`,
    );

    return timer;
  }

  /** Cancel (delete) a timer. Returns true if found and removed.
   *  Injects a message into the session so the agent knows the user cancelled it. */
  async cancelTimer(sessionId: string, timerId: string): Promise<boolean> {
    const file = this.sessions.get(sessionId);
    if (!file) return false;

    const idx = file.timers.findIndex((t) => t.id === timerId);
    if (idx === -1) return false;

    const timer = file.timers[idx];
    file.timers.splice(idx, 1);
    this.persistAndEvictIfEmpty(sessionId);
    this.broadcastTimers(sessionId);

    // Notify the agent that the user manually cancelled this timer
    const content = `[⏰ Timer ${timerId} cancelled] ${timer.title}`;
    this.wsBridge.injectUserMessage(
      sessionId,
      content,
      { sessionId: `timer:${timerId}`, sessionLabel: `Timer ${timerId}` },
      undefined,
      normalizeThreadRoute(timer.threadKey) ?? undefined,
    );

    console.log(`${LOG_TAG} Cancelled timer ${timerId} for session ${sessionId.slice(0, 8)}`);
    return true;
  }

  /** List all active timers for a session. */
  listTimers(sessionId: string): SessionTimer[] {
    return this.sessions.get(sessionId)?.timers ?? [];
  }

  /** Return sessions with at least one due timer. Future timers remain scheduled. */
  getDueTimerSessionIds(now = Date.now()): string[] {
    const sessionIds: string[] = [];
    for (const [sessionId, file] of this.sessions) {
      if (file.timers.some((timer) => timer.nextFireAt <= now)) {
        sessionIds.push(sessionId);
      }
    }
    return sessionIds;
  }

  /** Run one immediate due-timer sweep. Used at startup so due timers do not wait for browser navigation. */
  async sweepDueTimersNow(now = Date.now()): Promise<TimerSweepResult> {
    return this.sweep(now);
  }

  /** Cancel all timers for a session (on archive). Deletes persistence file. */
  async cancelAllTimers(sessionId: string): Promise<void> {
    const had = this.sessions.has(sessionId);
    this.sessions.delete(sessionId);

    await timerStore.deleteTimers(sessionId);

    if (had) {
      this.broadcastTimers(sessionId);
      console.log(`${LOG_TAG} Cancelled all timers for session ${sessionId.slice(0, 8)}`);
    }
  }

  // ── Sweep ──────────────────────────────────────────────────────────────────

  private startSweep(): void {
    this.stopSweep();
    this.sweepTimer = setInterval(() => {
      void this.sweepDueTimersNow();
    }, SWEEP_INTERVAL_MS);
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Check all timers, fire any that are due. */
  private async sweep(now = Date.now()): Promise<TimerSweepResult> {
    const result: TimerSweepResult = { fired: [], skipped: [] };

    for (const [sessionId, file] of this.sessions) {
      const toRemove = new Set<string>();
      let changed = false;

      for (const timer of file.timers) {
        if (timer.nextFireAt > now) continue;

        if (this.isSessionPaused(sessionId)) {
          result.skipped.push({ sessionId, timerId: timer.id, reason: "session_paused" });
          continue;
        }

        const fireContext =
          timer.type === "recurring" && timer.intervalMs && timer.intervalMs > 0
            ? this.resolveRecurringFireContext(timer, now)
            : { scheduledFireAt: timer.nextFireAt };
        // Timer is due -- fire it.
        const delivery = this.fireTimer(sessionId, timer, fireContext);
        result.fired.push({ sessionId, timerId: timer.id, delivery });
        timer.lastFiredAt = now;
        timer.fireCount++;
        changed = true;

        if (timer.type === "recurring" && timer.intervalMs && timer.intervalMs > 0) {
          timer.nextFireAt = fireContext.scheduledFireAt + timer.intervalMs;
        } else {
          // One-shot (delay or at), or recurring with corrupt intervalMs: remove after firing
          toRemove.add(timer.id);
        }
      }

      if (toRemove.size > 0) {
        file.timers = file.timers.filter((t) => !toRemove.has(t.id));
      }

      if (changed) {
        try {
          await this.persistAndEvictIfEmptyNow(sessionId);
        } catch (err) {
          console.error(`${LOG_TAG} Failed to persist timers for ${sessionId.slice(0, 8)}:`, err);
        }
        this.broadcastTimers(sessionId);
      }
    }

    return result;
  }

  /** Fire a single timer: inject user message into the session. */
  private fireTimer(
    sessionId: string,
    timer: SessionTimer,
    context: TimerFireContext,
  ): "sent" | "queued" | "paused_queued" | "dropped" | "no_session" {
    const content =
      `[⏰ Timer ${timer.id} reminder] ${timer.title}` +
      `\n\nThis is a reminder from your earlier timer note, not a new user instruction.` +
      this.formatSkippedOccurrences(context.skippedCount) +
      this.formatLateDeliveryNote(context.scheduledFireAt, Date.now()) +
      (timer.description ? `\n\nEarlier note:\n${timer.description}` : "");
    const result = this.wsBridge.injectUserMessage(
      sessionId,
      content,
      { sessionId: `timer:${timer.id}`, sessionLabel: `Timer ${timer.id}` },
      undefined,
      normalizeThreadRoute(timer.threadKey) ?? undefined,
      { timerFiring: { timerId: timer.id, scheduledFireAt: context.scheduledFireAt } },
    );
    console.log(`${LOG_TAG} Fired timer ${timer.id} for session ${sessionId.slice(0, 8)}: ${result}`);
    return result;
  }

  private resolveRecurringFireContext(timer: SessionTimer, now: number): TimerFireContext {
    const intervalMs = timer.intervalMs;
    if (!intervalMs || intervalMs <= 0) return { scheduledFireAt: timer.nextFireAt };
    const skippedCount = Math.floor((now - timer.nextFireAt) / intervalMs);
    return {
      scheduledFireAt: timer.nextFireAt + skippedCount * intervalMs,
      skippedCount,
    };
  }

  private isSessionPaused(sessionId: string): boolean {
    const bridge = this.wsBridge as WsBridge & { isSessionPaused?: (sessionId: string) => boolean };
    return bridge.isSessionPaused?.(sessionId) ?? false;
  }

  private formatSkippedOccurrences(skippedCount: number | undefined): string {
    if (!skippedCount || skippedCount <= 0) return "";
    const noun = skippedCount === 1 ? "occurrence was" : "occurrences were";
    return `\n\n${skippedCount} earlier due ${noun} skipped while the session was unavailable.`;
  }

  private formatLateDeliveryNote(scheduledFireAt: number, deliveredAt: number): string {
    if (deliveredAt - scheduledFireAt <= LATE_TIMER_THRESHOLD_MS) return "";
    return `\n\nThis timer was initially scheduled to fire at ${new Date(scheduledFireAt).toISOString()}.`;
  }

  // ── Browser sync ───────────────────────────────────────────────────────────

  /** Broadcast current timer list for a session to all connected browsers. */
  private broadcastTimers(sessionId: string): void {
    const timers = this.sessions.get(sessionId)?.timers ?? [];
    const msg: BrowserIncomingMessage = { type: "timer_update", timers };
    this.wsBridge.broadcastToSession(sessionId, msg);
  }

  // ── Persistence helpers ────────────────────────────────────────────────────

  /** Get the in-memory file for a session, loading from disk to recover nextId
   *  if this session had timers previously. Falls back to a fresh file. */
  private async getOrCreateFile(sessionId: string): Promise<SessionTimerFile> {
    let file = this.sessions.get(sessionId);
    if (!file) {
      // Try loading from disk -- recovers nextId even after all timers were removed
      file = await timerStore.loadTimers(sessionId);
      this.sessions.set(sessionId, file);
    }
    return file;
  }

  /** Persist to disk (nextId must survive even when empty), then evict from
   *  memory if no active timers remain. Only cancelAllTimers deletes the disk file. */
  private persistAndEvictIfEmpty(sessionId: string): void {
    this.persistAndEvictIfEmptyNow(sessionId).catch((err) => {
      console.error(`${LOG_TAG} Failed to persist timers for ${sessionId.slice(0, 8)}:`, err);
    });
  }

  private async persistAndEvictIfEmptyNow(sessionId: string): Promise<void> {
    await this.persistSessionNow(sessionId);
    const file = this.sessions.get(sessionId);
    if (file && file.timers.length === 0) this.sessions.delete(sessionId);
  }

  /** Save session timer state to disk (fire-and-forget). */
  private persistSession(sessionId: string): void {
    this.persistSessionNow(sessionId).catch((err) => {
      console.error(`${LOG_TAG} Failed to persist timers for ${sessionId.slice(0, 8)}:`, err);
    });
  }

  private async persistSessionNow(sessionId: string): Promise<void> {
    const file = this.sessions.get(sessionId);
    if (!file) return;
    await timerStore.saveTimers(file);
  }
}
