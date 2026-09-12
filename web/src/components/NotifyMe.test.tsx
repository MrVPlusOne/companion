// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NotifyMeControl, NotifyMeControlView } from "./NotifyMe.js";
import { NotifyMeResults } from "./GlobalNotifyMeMenu.js";
import { useStore } from "../store.js";
import { buildThreadMonitoringProjection } from "../../server/thread-monitoring-projection.js";
import { THREAD_MONITORING_PROJECTION, type ThreadMonitoringEntry } from "../../shared/thread-monitoring.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry: ThreadMonitoringEntry = {
  sessionId: "leader",
  sessionNum: 12,
  sessionName: "Research",
  threadKey: "q-42",
  title: "Compare design options",
  trackedAt: 1,
  pending: { id: "2", messageId: "result", timestamp: 2, summary: "The comparison is ready." },
};

describe("Notify Me controls", () => {
  it("keeps opening a result separate from acknowledging or untracking it", () => {
    const open = vi.fn();
    const action = vi.fn();
    render(<NotifyMeResults entries={[entry]} onOpen={open} onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare design options" }));
    expect(open).toHaveBeenCalledWith(entry);
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(action).toHaveBeenLastCalledWith(entry, "acknowledge");
    fireEvent.click(screen.getByRole("button", { name: "Stop tracking" }));
    expect(action).toHaveBeenLastCalledWith(entry, "untrack");
  });

  it("shows the monitored icon for quiet targets and a distinct waiting-result state", () => {
    const { rerender } = render(
      <NotifyMeControlView enabled pending={false} onToggle={() => {}} onAcknowledge={() => {}} />,
    );
    expect(screen.getByRole("img", { name: "Monitored task" })).toBeTruthy();
    expect(screen.queryByText("Acknowledge")).toBeNull();
    rerender(<NotifyMeControlView enabled pending onToggle={() => {}} onAcknowledge={() => {}} />);
    expect(screen.getByRole("img", { name: "Monitored task has a result waiting" })).toBeTruthy();
  });

  it("sends the observed result token and waits for server authority instead of clearing locally", async () => {
    // Consume the actual producer's projection, including its closed/open-tab selection boundary.
    const value = buildThreadMonitoringProjection({
      state: {
        leaderOpenThreadTabs: { version: 1, orderedOpenThreadKeys: ["q-42"], closedThreadTombstones: [], updatedAt: 0 },
        threadMonitoring: {
          revision: 2,
          alertVersion: 1,
          threads: { "q-42": { trackedAt: 1, afterHistoryIndex: 0, pending: entry.pending } },
        },
      },
    });
    useStore.getState().applySyncedProjectionSnapshot({
      projection: THREAD_MONITORING_PROJECTION,
      key: "leader",
      generation: "monitor-test",
      revision: 1,
      value,
    });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    render(<NotifyMeControl sessionId="leader" threadKey="q-42" />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "acknowledge", resultId: "2" });
    expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy();
    useStore.getState().applySyncedProjectionSnapshot({
      projection: THREAD_MONITORING_PROJECTION,
      key: "leader",
      generation: "monitor-test",
      revision: 2,
      value: { ...value, revision: 3, pendingCount: 0, threads: { "q-42": { pendingResultId: null } } },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull());
  });

  it("offers no monitoring control for aggregate or Main views", () => {
    const { container } = render(
      <>
        <NotifyMeControl sessionId="leader" threadKey="main" />
        <NotifyMeControl sessionId="leader" threadKey="all" />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});
