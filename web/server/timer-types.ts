// ─── Session Timer Types ─────────────────────────────────────────────────────

/** A single session-scoped timer. */
export interface SessionTimer {
  /** Short readable ID: "t1", "t2", etc. */
  id: string;
  /** Session that owns this timer. */
  sessionId: string;
  /** Recorded leader destination ("main" or "q-N"); absent on unassociated timers. */
  threadKey?: string;
  /** Concise one-line summary for humans scanning timer lists. */
  title: string;
  /** Additional detail for the model when the timer fires. */
  description: string;
  /** Timer schedule type. */
  type: "delay" | "at" | "recurring";
  /** Original spec as entered by the user (e.g. "30m", "3pm", "every 10m"). */
  originalSpec: string;
  /** Absolute epoch ms when a one-shot timer should fire. For recurring, the NEXT fire time. */
  nextFireAt: number;
  /** For recurring timers: interval in ms. */
  intervalMs?: number;
  /** When the timer was created (epoch ms). */
  createdAt: number;
  /** Last time this timer fired (epoch ms), if ever. */
  lastFiredAt?: number;
  /** Total number of times this timer has fired. */
  fireCount: number;
}

/** Persisted JSON file format for a session's timers. */
export interface SessionTimerFile {
  sessionId: string;
  /** Counter for generating "t{N}" IDs. */
  nextId: number;
  timers: SessionTimer[];
}

/** Input for creating a timer via REST API or CLI. Exactly one of in/at/every must be provided. */
export interface TimerCreateInput {
  title: string;
  description?: string;
  /** Explicit leader destination; otherwise creation may use the current active thread. */
  threadKey?: string;
  /** Relative delay: "30m", "2h", "45s" */
  in?: string;
  /** Wall-clock time: "3pm", "15:00", "3:30pm" */
  at?: string;
  /** Recurring interval: "10m", "1h", "30s" */
  every?: string;
}

/** Server-owned provenance for one timer occurrence, retained through delivery holds. */
export interface TimerFiring {
  timerId: string;
  scheduledFireAt: number;
  /** Assigned firing reference when an admitted input is held and delivered again. */
  messageId?: string;
}
