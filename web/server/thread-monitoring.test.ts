import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage, SessionNotification, SessionState } from "./session-types.js";
import { extractThreadStatusMarkersFromText } from "../shared/thread-status-marker.js";
import { updateLeaderThreadStatusesForAssistantOutput } from "./bridge/thread-routing-reminder.js";
import { clearAttentionAndMarkRead } from "./bridge/session-notification-controller.js";
import {
  acknowledgeMonitoredThreadResult,
  recordMonitoredThreadResult,
  setThreadMonitoring,
} from "./thread-monitoring.js";
import { buildThreadMonitoringProjection } from "./thread-monitoring-projection.js";
import { isThreadMonitoringProjectionValue } from "../shared/thread-monitoring.js";

type Assistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function fixture() {
  return {
    id: "leader",
    state: {
      isOrchestrator: true,
      leaderOpenThreadTabs: { version: 1, orderedOpenThreadKeys: ["q-42"], closedThreadTombstones: [], updatedAt: 0 },
    } as Pick<SessionState, "isOrchestrator" | "leaderOpenThreadTabs" | "leaderThreadStatuses" | "threadMonitoring">,
    messageHistory: [] as BrowserIncomingMessage[],
    notifications: [] as SessionNotification[],
    attentionReason: "review",
    lastReadAt: 0,
  };
}

function publish(
  session: ReturnType<typeof fixture>,
  id: string,
  kind: "Ready" | "Waiting" = "Ready",
  threadKey = "q-42",
) {
  const timestamp = session.messageHistory.length + 1;
  const entry: Assistant = {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "Result is available" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  session.messageHistory.push(entry);
  const parsed = extractThreadStatusMarkersFromText(`{[(Thread ${kind}: ${threadKey} | Result is available)]}`);
  const result = updateLeaderThreadStatusesForAssistantOutput(session, parsed.markers, { messageId: id, timestamp });
  entry.threadStatusMarkers = result.records;
  return result.records;
}

describe("Notify Me result lifecycle", () => {
  it("supports named task tabs only and captures a currently accepted result", () => {
    const session = fixture();
    expect(setThreadMonitoring(session, "main", true)).toBe(false);
    expect(setThreadMonitoring(session, "all", true)).toBe(false);
    publish(session, "initial");
    setThreadMonitoring(session, "q-42", true, 10);
    expect(session.state.threadMonitoring?.threads["q-42"].pending?.messageId).toBe("initial");
    const revision = session.state.threadMonitoring?.revision;
    expect(setThreadMonitoring(session, "q-42", true)).toBe(false);
    expect(session.state.threadMonitoring?.revision).toBe(revision);
  });

  it("survives ordinary reads, tab closure, activity, and persisted restoration", () => {
    // These operations previously made review notifications vanish; monitoring is a separate owner.
    const session = fixture();
    setThreadMonitoring(session, "q-42", true);
    publish(session, "result");
    const pending = session.state.threadMonitoring?.threads["q-42"].pending;
    clearAttentionAndMarkRead(session, { persistSession: () => {} });
    session.state.leaderOpenThreadTabs!.orderedOpenThreadKeys = [];
    session.state.leaderThreadStatuses = {};
    const restored = JSON.parse(JSON.stringify(session)) as typeof session;
    const projection = buildThreadMonitoringProjection(restored);
    expect(restored.state.threadMonitoring?.threads["q-42"].pending).toEqual(pending);
    expect(projection).toMatchObject({ trackedCount: 1, pendingCount: 1, threads: {} });
    expect(isThreadMonitoringProjectionValue(projection)).toBe(true);
  });

  it("acknowledges only the observed result, coalesces new results, and re-arms", () => {
    const session = fixture();
    setThreadMonitoring(session, "q-42", true);
    publish(session, "first");
    const first = session.state.threadMonitoring!.threads["q-42"].pending!.id;
    publish(session, "second");
    expect(acknowledgeMonitoredThreadResult(session, "q-42", first)).toBe(false);
    const second = session.state.threadMonitoring!.threads["q-42"].pending!.id;
    expect(acknowledgeMonitoredThreadResult(session, "q-99", second)).toBe(false);
    expect(acknowledgeMonitoredThreadResult(session, "q-42", second)).toBe(true);
    expect(buildThreadMonitoringProjection(session)).toMatchObject({ trackedCount: 1, pendingCount: 0 });
    publish(session, "third");
    expect(buildThreadMonitoringProjection(session)).toMatchObject({ trackedCount: 1, pendingCount: 1 });
  });

  it("does not revive acknowledged results on replay, summary edits, or duplicate source rows", () => {
    const session = fixture();
    setThreadMonitoring(session, "q-42", true);
    const [first] = publish(session, "first");
    const [second] = publish(session, "second");
    acknowledgeMonitoredThreadResult(session, "q-42", session.state.threadMonitoring!.threads["q-42"].pending!.id);
    session.messageHistory.push(structuredClone(session.messageHistory[0]));
    const restored = structuredClone(session);
    expect(recordMonitoredThreadResult(restored, first)).toBe(false);
    expect(recordMonitoredThreadResult(restored, { ...second, summary: "Edited summary" })).toBe(false);
    expect(buildThreadMonitoringProjection(restored).pendingCount).toBe(0);
  });

  it("leaves tracking quiet on Waiting and rejects Ready while input is unresolved", () => {
    const session = fixture();
    setThreadMonitoring(session, "q-42", true);
    publish(session, "waiting", "Waiting");
    session.notifications.push({
      id: "n-1",
      category: "needs-input",
      timestamp: 1,
      threadKey: "q-42",
      messageId: null,
      done: false,
    });
    expect(publish(session, "blocked")).toEqual([]);
    expect(buildThreadMonitoringProjection(session).pendingCount).toBe(0);
    session.notifications[0].done = true;
    publish(session, "ready");
    session.notifications[0].done = false;
    expect(buildThreadMonitoringProjection(session).pendingCount).toBe(1);
    expect(session.notifications[0].done).toBe(false);
  });

  it("stops tracking explicitly and permits deliberate re-tracking of the current Ready", () => {
    const session = fixture();
    setThreadMonitoring(session, "q-42", true);
    publish(session, "first");
    setThreadMonitoring(session, "q-42", false);
    publish(session, "second");
    expect(buildThreadMonitoringProjection(session)).toMatchObject({ trackedCount: 0, pendingCount: 0 });
    setThreadMonitoring(session, "q-42", true);
    expect(session.state.threadMonitoring?.threads["q-42"].pending?.messageId).toBe("second");
  });

  it("preserves global counts when more than fifty monitored tabs exist", () => {
    const session = fixture();
    for (let index = 1; index <= 75; index++) {
      const key = `q-${index}`;
      setThreadMonitoring(session, key, true);
      publish(session, `ready-${index}`, "Ready", key);
    }
    session.state.leaderOpenThreadTabs!.orderedOpenThreadKeys = Array.from(
      { length: 50 },
      (_, index) => `q-${index + 1}`,
    );
    const projection = buildThreadMonitoringProjection(session);
    expect(projection.pendingCount).toBe(75);
    expect(Object.keys(projection.threads)).toHaveLength(50);
    expect(isThreadMonitoringProjectionValue(projection)).toBe(true);
  });
});
