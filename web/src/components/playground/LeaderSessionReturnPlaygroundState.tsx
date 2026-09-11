import { useState } from "react";
import { LEADER_THREAD_TABS_PROJECTION } from "../../../shared/leader-thread-tabs-projection.js";
import { syncedProjectionEntryId } from "../../../shared/synced-projection.js";
import { useStore } from "../../store.js";
import { resolveLeaderThreadTabsProjection } from "../../utils/leader-thread-tabs-resolver.js";
import { persistLeaderSelectedThreadKey } from "../../utils/thread-viewport.js";
import { ChatView } from "../ChatView.js";
import { PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID, PLAYGROUND_LEADER_RETURN_SESSION_ID } from "./fixtures.js";
import { Section } from "./shared.js";

export function LeaderSessionReturnPlaygroundState() {
  const [activeSessionId, setActiveSessionId] = useState(PLAYGROUND_LEADER_RETURN_SESSION_ID);
  const [returnEpoch, setReturnEpoch] = useState(0);
  const [settlementRevision, setSettlementRevision] = useState(0);
  const [activityRunning, setActivityRunning] = useState(false);
  const [threadStatusVisible, setThreadStatusVisible] = useState(false);
  const [threadStatusWrapped, setThreadStatusWrapped] = useState(false);
  const [needsInputVisible, setNeedsInputVisible] = useState(false);
  const [restoredTabPreview, setRestoredTabPreview] = useState(false);
  const showingLeader = activeSessionId === PLAYGROUND_LEADER_RETURN_SESSION_ID;

  const resetLeaderMain = () => {
    setRestoredTabPreview(false);
    persistLeaderSelectedThreadKey(PLAYGROUND_LEADER_RETURN_SESSION_ID, "main");
    setActiveSessionId(PLAYGROUND_LEADER_RETURN_SESSION_ID);
    setReturnEpoch((current) => current + 1);
  };
  const applyLeaderActivity = (nextRunning: boolean) => {
    const store = useStore.getState();
    store.setSessionStatus(PLAYGROUND_LEADER_RETURN_SESSION_ID, nextRunning ? "running" : "idle");
    store.setActiveTurnRoute(
      PLAYGROUND_LEADER_RETURN_SESSION_ID,
      nextRunning ? { threadKey: "q-1944", questId: "q-1944" } : null,
    );
    store.setStreamingStats(
      PLAYGROUND_LEADER_RETURN_SESSION_ID,
      nextRunning ? { startedAt: Date.now() - 7_000, outputTokens: 0 } : null,
    );
    setActivityRunning(nextRunning);
  };
  const toggleLeaderActivity = () => applyLeaderActivity(!activityRunning);
  const applyThreadStatus = (visible: boolean, wrapped: boolean) => {
    const store = useStore.getState();
    const projection = resolveLeaderThreadTabsProjection(store, PLAYGROUND_LEADER_RETURN_SESSION_ID);
    if (projection.projectionState !== "accepted") return;
    const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, PLAYGROUND_LEADER_RETURN_SESSION_ID);
    const currentVersion = store.syncedProjectionVersions.get(entryId);
    const generation = currentVersion?.generation ?? "playground-leader-return-tabs";
    const revision = (currentVersion?.revision ?? 1) + 1;
    const timestamp = Date.now();
    store.applySyncedProjectionSnapshot({
      type: "synced_projection_snapshot",
      projection: LEADER_THREAD_TABS_PROJECTION,
      key: PLAYGROUND_LEADER_RETURN_SESSION_ID,
      generation,
      revision,
      value: {
        ...projection.value,
        threadStatuses: visible
          ? {
              main: {
                kind: "waiting",
                label: "Thread Waiting",
                threadKey: "main",
                summary: wrapped
                  ? "waiting for a deliberately long validation summary that wraps on a narrow mobile viewport"
                  : "waiting for viewport validation",
                messageId: "playground-leader-return-thread-status",
                timestamp,
                updatedAt: timestamp,
              },
            }
          : {},
      },
    });
    setThreadStatusVisible(visible);
    setThreadStatusWrapped(wrapped);
  };
  const toggleThreadStatus = () => applyThreadStatus(!threadStatusVisible, threadStatusWrapped);
  const toggleThreadStatusWrapping = () => applyThreadStatus(true, !threadStatusWrapped);
  const toggleNeedsInput = () => {
    const nextVisible = !needsInputVisible;
    useStore.getState().setSessionNotifications(
      PLAYGROUND_LEADER_RETURN_SESSION_ID,
      nextVisible
        ? [
            {
              id: "playground-leader-return-needs-input",
              category: "needs-input",
              summary: "Choose the next viewport validation step",
              timestamp: Date.now(),
              messageId: "synthetic-tail-main-130",
              threadKey: "main",
              done: false,
            },
          ]
        : [],
    );
    setNeedsInputVisible(nextVisible);
  };
  const toggleBothStatusChips = () => {
    const nextVisible = !(activityRunning && threadStatusVisible);
    applyLeaderActivity(nextVisible);
    applyThreadStatus(nextVisible, threadStatusWrapped);
  };
  const applyLateSettlement = () => {
    const revision = settlementRevision + 1;
    useStore.getState().setSessionCompletedBoard(PLAYGROUND_LEADER_RETURN_SESSION_ID, [
      {
        questId: "q-1944",
        title: `Completed tab late settlement ${revision}`,
        status: "DONE",
        updatedAt: Date.now(),
        completedAt: Date.now() - 20_000,
      },
    ]);
    setSettlementRevision(revision);
  };

  return (
    <Section
      title="Leader Session Return Stability"
      description="Keep Main selected, scroll to a recognizable message, switch away and back, and confirm the viewport stays fixed. The middle-tab preview shows a restored selection retaining its position between neighboring tabs."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            setActiveSessionId(
              showingLeader ? PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID : PLAYGROUND_LEADER_RETURN_SESSION_ID,
            )
          }
          className="rounded-lg border border-cc-border bg-cc-hover px-3 py-1.5 text-xs font-medium text-cc-fg hover:bg-cc-active"
        >
          {showingLeader ? "Switch to away session" : "Return to leader session"}
        </button>
        <button
          type="button"
          onClick={() => {
            persistLeaderSelectedThreadKey(PLAYGROUND_LEADER_RETURN_SESSION_ID, "q-1945");
            setRestoredTabPreview(true);
            setActiveSessionId(PLAYGROUND_LEADER_RETURN_SESSION_ID);
            setReturnEpoch((current) => current + 1);
          }}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          Preview middle-tab return
        </button>
        <button
          type="button"
          onClick={toggleLeaderActivity}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          {activityRunning ? "Hide activity chip" : "Show activity chip"}
        </button>
        <button
          type="button"
          onClick={toggleThreadStatus}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          {threadStatusVisible ? "Hide thread status" : "Show thread status"}
        </button>
        <button
          type="button"
          onClick={toggleThreadStatusWrapping}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          {threadStatusWrapped ? "Use short thread status" : "Use wrapping thread status"}
        </button>
        <button
          type="button"
          onClick={toggleBothStatusChips}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          {activityRunning && threadStatusVisible ? "Hide both status chips" : "Show both status chips"}
        </button>
        <button
          type="button"
          onClick={toggleNeedsInput}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          {needsInputVisible ? "Hide needs-input pill" : "Show needs-input pill"}
        </button>
        <button
          type="button"
          onClick={applyLateSettlement}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          Apply late settlement
        </button>
        <button
          type="button"
          onClick={resetLeaderMain}
          className="rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg"
        >
          Reset leader to Main
        </button>
        <span className="text-xs text-cc-muted" data-testid="playground-leader-return-active-session">
          {showingLeader ? "Leader return target" : "Away session"} · activity {activityRunning ? "running" : "idle"} ·
          thread status {threadStatusVisible ? "visible" : "hidden"} · needs input{" "}
          {needsInputVisible ? "visible" : "hidden"} · late revision {settlementRevision}
        </span>
      </div>
      <div
        data-testid="playground-leader-session-return"
        className="h-[620px] max-w-4xl overflow-hidden rounded-xl border border-cc-border bg-cc-card"
      >
        <ChatView
          key={`${activeSessionId}:${returnEpoch}`}
          sessionId={activeSessionId}
          hasThreadRoute={restoredTabPreview}
          routeThreadKey={restoredTabPreview ? "q-1945" : null}
        />
      </div>
    </Section>
  );
}
