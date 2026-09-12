import type { ThreadMonitoringPage } from "../../shared/thread-monitoring.js";

export async function fetchThreadMonitoring(
  filter: "pending" | "all",
  offset = 0,
  signal?: AbortSignal,
): Promise<ThreadMonitoringPage> {
  const response = await fetch(`/api/thread-monitoring?filter=${filter}&offset=${offset}`, { signal });
  if (!response.ok) throw new Error("Could not load monitored tasks");
  return response.json();
}

export async function updateThreadMonitoring(
  sessionId: string,
  threadKey: string,
  action: "track" | "untrack" | "acknowledge",
  resultId?: string,
): Promise<void> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/thread-monitoring/${encodeURIComponent(threadKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, resultId }),
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || "Could not update Notify Me");
  }
}
