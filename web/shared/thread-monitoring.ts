export const THREAD_MONITORING_PROJECTION = "thread-monitoring" as const;
export const THREAD_MONITORING_MAX_VALUE_BYTES = 16 * 1024;

export interface MonitoredThreadResult {
  id: string;
  messageId: string;
  timestamp: number;
  summary: string;
}

export interface ThreadMonitor {
  trackedAt: number;
  afterHistoryIndex: number;
  pending: MonitoredThreadResult | null;
}

/** Durable user preference and acknowledgement state, separate from view/read state. */
export interface ThreadMonitoringState {
  revision: number;
  alertVersion: number;
  threads: Record<string, ThreadMonitor>;
}

/** Global counts plus small presentation records for the currently open tabs. */
export interface ThreadMonitoringProjectionValue {
  revision: number;
  alertVersion: number;
  trackedCount: number;
  pendingCount: number;
  threads: Record<string, { pendingResultId: string | null }>;
}

export interface ThreadMonitoringEntry {
  sessionId: string;
  sessionName: string;
  sessionNum: number | null;
  threadKey: string;
  title: string;
  trackedAt: number;
  pending: MonitoredThreadResult | null;
}

export interface ThreadMonitoringPage {
  entries: ThreadMonitoringEntry[];
  total: number;
  nextOffset: number | null;
}

export function isThreadMonitoringProjectionValue(value: unknown): value is ThreadMonitoringProjectionValue {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ThreadMonitoringProjectionValue;
  if (
    ![candidate.revision, candidate.alertVersion, candidate.trackedCount, candidate.pendingCount].every(
      (number) => Number.isSafeInteger(number) && number >= 0,
    )
  )
    return false;
  if (
    candidate.pendingCount > candidate.trackedCount ||
    !candidate.threads ||
    typeof candidate.threads !== "object" ||
    Array.isArray(candidate.threads)
  )
    return false;
  const entries = Object.entries(candidate.threads);
  return (
    entries.length <= Math.min(50, candidate.trackedCount) &&
    entries.every(
      ([key, entry]) =>
        /^q-\d+$/.test(key) &&
        key.length <= 80 &&
        entry &&
        typeof entry === "object" &&
        (entry.pendingResultId === null ||
          (typeof entry.pendingResultId === "string" && /^\d+$/.test(entry.pendingResultId))),
    ) &&
    entries.filter(([, entry]) => entry.pendingResultId !== null).length <= candidate.pendingCount
  );
}

export function threadMonitoringProjectionEqual(
  left: ThreadMonitoringProjectionValue,
  right: ThreadMonitoringProjectionValue,
): boolean {
  return (
    left.revision === right.revision &&
    left.alertVersion === right.alertVersion &&
    left.trackedCount === right.trackedCount &&
    left.pendingCount === right.pendingCount &&
    JSON.stringify(left.threads) === JSON.stringify(right.threads)
  );
}
