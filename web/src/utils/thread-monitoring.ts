import { THREAD_MONITORING_PROJECTION } from "../../shared/thread-monitoring.js";
import { getSyncedProjectionValue } from "../store-synced-projections.js";
import { useStore } from "../store.js";

/** Capture the version observed at submission; later delivery must never acknowledge newer output. */
export function observedThreadMonitorResultId(sessionId: string, threadKey?: string): string | undefined {
  return (
    getSyncedProjectionValue(useStore.getState(), THREAD_MONITORING_PROJECTION, sessionId)?.threads[threadKey ?? "main"]
      ?.pendingResultId ?? undefined
  );
}
