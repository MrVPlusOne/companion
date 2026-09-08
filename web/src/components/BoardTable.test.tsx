// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardTable, formatCompletedTime, orderBoardRows, type BoardRowData } from "./BoardTable.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";
import { getQuestPhaseColorValue } from "../utils/quest-phase-theme.js";

interface MockStoreState {
  quests: Array<{
    questId: string;
    title?: string;
    status?: string;
    createdAt?: number;
    version?: number;
    id?: string;
  }>;
  sdkSessions: Array<{
    sessionId: string;
    sessionNum?: number;
    archived?: boolean;
    state?: "starting" | "connected" | "running" | "exited";
    status?: "idle" | "running" | "compacting" | "reverting" | null;
    cliConnected?: boolean;
    pendingTimerCount?: number;
  }>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  zoomLevel?: number;
}

const { openQuestOverlay, useStoreMock } = vi.hoisted(() => {
  const openQuestOverlay = vi.fn();
  const useStoreMock = Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => ({ openQuestOverlay }),
  });
  return { openQuestOverlay, useStoreMock };
});

let mockState: MockStoreState;

vi.mock("../store.js", () => ({
  useStore: useStoreMock,
  countUserPermissions: () => 0,
}));

vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span data-testid="session-inline-link" className={className}>
      {children}
    </span>
  ),
}));

beforeEach(() => {
  mockState = {
    quests: [],
    sdkSessions: [],
    sessionAttention: new Map(),
  };
  openQuestOverlay.mockReset();
});

function getPhaseColor(status: string): string | undefined {
  const phase = getQuestJourneyPhaseForState(status);
  return phase ? getQuestPhaseColorValue(phase.color) : undefined;
}

describe("BoardTable", () => {
  it("shows Wait For for active board rows", () => {
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "Quest",
      "Sessions",
      "Journey",
      "Title",
      "Wait For",
    ]);
    expect(screen.getByRole("columnheader", { name: "Wait For" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Completed Time" })).not.toBeInTheDocument();
  });

  it("adds a separate thread action only when thread navigation is enabled", () => {
    const onSelectQuestThread = vi.fn();
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} selectedThreadKey="q-335" onSelectQuestThread={onSelectQuestThread} />);

    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toEqual([
      "Thread",
      "Quest",
      "Sessions",
      "Journey",
      "Title",
      "Wait For",
    ]);
    expect(screen.getByRole("columnheader", { name: "Thread" })).toBeInTheDocument();
    const action = screen.getByTestId("board-thread-action");
    const actionCell = action.closest("td");
    const questCell = screen.getByRole("button", { name: "q-335" }).closest("td");
    expect(actionCell).toBeTruthy();
    expect(questCell).toBeTruthy();
    expect(actionCell!.compareDocumentPosition(questCell!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action).toHaveTextContent("Current");
    fireEvent.click(action);
    expect(onSelectQuestThread).toHaveBeenCalledWith("q-335");
    expect(screen.getByRole("button", { name: "q-335" })).toBeInTheDocument();
  });

  it("shows Completed Time instead of Wait For for completed rows", () => {
    const completedAt = Date.UTC(2026, 3, 16, 18, 45, 0);
    const board: BoardRowData[] = [
      {
        questId: "q-335",
        title: "Show completed time",
        status: "MEMORY",
        waitFor: ["q-999"],
        updatedAt: completedAt,
        completedAt,
      },
    ];

    render(<BoardTable board={board} mode="completed" />);

    expect(screen.getByRole("columnheader", { name: "Completed Time" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Wait For" })).not.toBeInTheDocument();
    expect(screen.getByText(formatCompletedTime(completedAt))).toBeInTheDocument();
    expect(screen.queryByText("q-999")).not.toBeInTheDocument();
  });

  it("renders an em dash when a completed row is missing completedAt", () => {
    const board: BoardRowData[] = [{ questId: "q-335", title: "Show completed time", updatedAt: 1 }];

    render(<BoardTable board={board} mode="completed" />);

    expect(screen.getByRole("columnheader", { name: "Completed Time" })).toBeInTheDocument();
    expect(screen.getAllByText("\u2014").length).toBeGreaterThan(0);
  });

  it("renders quest-journey labels with phase metadata colors", () => {
    const board: BoardRowData[] = [
      { questId: "q-1", status: "QUEUED", updatedAt: 1 },
      { questId: "q-2", status: "PLANNING", updatedAt: 2 },
      { questId: "q-3", status: "WORKING", updatedAt: 3 },
      { questId: "q-4", status: "USER_CHECKPOINTING", updatedAt: 4 },
      { questId: "q-5", status: "MEMORY", updatedAt: 5 },
      { questId: "q-6", status: "EXPLORING", updatedAt: 6 },
      { questId: "q-7", status: "IMPLEMENTING", updatedAt: 7 },
      { questId: "q-8", status: "CODE_REVIEWING", updatedAt: 8 },
      { questId: "q-9", status: "MENTAL_SIMULATING", updatedAt: 9 },
      { questId: "q-10", status: "OUTCOME_REVIEWING", updatedAt: 10 },
      { questId: "q-11", status: "BOOKKEEPING", updatedAt: 11 },
      { questId: "q-12", status: "PORTING", updatedAt: 12 },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("Queued")).toHaveClass("text-cc-muted");
    expect(screen.getByText("Alignment")).toHaveStyle({
      color: getPhaseColor("PLANNING"),
    });
    expect(screen.getByText("Work")).toHaveStyle({
      color: getPhaseColor("WORKING"),
    });
    expect(screen.getByText("User Checkpoint")).toHaveStyle({
      color: getPhaseColor("USER_CHECKPOINTING"),
    });
    expect(screen.getByText("Memory")).toHaveStyle({
      color: getPhaseColor("MEMORY"),
    });
    expect(screen.getByText("Explore")).toHaveStyle({
      color: getPhaseColor("EXPLORING"),
    });
    expect(screen.getByText("Implement")).toHaveStyle({
      color: getPhaseColor("IMPLEMENTING"),
    });
    expect(screen.getByText("Code Review")).toHaveStyle({
      color: getPhaseColor("CODE_REVIEWING"),
    });
    expect(screen.getByText("Mental Simulation")).toHaveStyle({
      color: getPhaseColor("MENTAL_SIMULATING"),
    });
    expect(screen.getByText("Outcome Review")).toHaveStyle({
      color: getPhaseColor("OUTCOME_REVIEWING"),
    });
    expect(screen.getByText("Bookkeeping")).toHaveStyle({
      color: getPhaseColor("BOOKKEEPING"),
    });
    expect(screen.getByText("Port")).toHaveStyle({
      color: getPhaseColor("PORTING"),
    });
  });

  it("falls back to the raw status for unknown values", () => {
    const board: BoardRowData[] = [{ questId: "q-1", status: "CUSTOM_STATUS", updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getByText("CUSTOM_STATUS")).toHaveClass("text-cc-muted");
  });

  it("keeps board Journey rendering compact and current-phase-first", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "WORKING",
        journey: {
          presetId: "v2-work",
          phaseIds: ["alignment", "work", "memory"],
          currentPhaseId: "work",
          phaseNotes: { "1": "Inspect only the follow-up diff" },
          revisionReason: "Need a checkpoint before Memory",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "active");
    expect(within(summary).getByText("Work")).toBeInTheDocument();
    expect(within(summary).getByText("2/3")).toBeInTheDocument();
    expect(within(summary).getByText("1 note")).toBeInTheDocument();
    expect(summary).not.toHaveAttribute("title");
    expect(screen.queryByText("Alignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Inspect only the follow-up diff")).not.toBeInTheDocument();
  });

  it("summarizes the active repeated phase occurrence by position", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-720",
        status: "USER_CHECKPOINTING",
        journey: {
          presetId: "checkpoint-loop",
          phaseIds: ["alignment", "work", "user-checkpoint", "work", "user-checkpoint", "work", "memory"],
          activePhaseIndex: 4,
          currentPhaseId: "user-checkpoint",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(within(summary).getByText("User Checkpoint")).toBeInTheDocument();
    expect(within(summary).getByText("5/7")).toBeInTheDocument();
  });

  it("keeps proposed Journey board cells to one status instead of the planned phase sequence", () => {
    // Proposed rows can carry an active index, but the compact cell must still
    // describe the proposal rather than displaying any of its planned phases.
    const board: BoardRowData[] = [
      {
        questId: "q-924",
        status: "PROPOSED",
        journey: {
          mode: "proposed",
          presetId: "v2-work",
          phaseIds: ["alignment", "work", "memory"],
          activePhaseIndex: 1,
          currentPhaseId: "work",
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "proposed");
    expect(within(summary).getByText("Proposed")).toBeInTheDocument();
    expect(summary).not.toHaveTextContent(/Alignment|Work|Memory|->/);
    expect(within(summary).getByText("3 phases")).toBeInTheDocument();
  });

  it("shows the full Journey preview on Work Board Journey hover", async () => {
    mockState.quests = [
      {
        id: "q-924-v1",
        questId: "q-924",
        version: 1,
        title: "Make Journey UI useful",
        status: "refined",
        createdAt: 1,
      },
    ];
    const board: BoardRowData[] = [
      {
        questId: "q-924",
        title: "Fallback title",
        status: "PROPOSED",
        journey: {
          mode: "proposed",
          presetId: "v2-work",
          phaseIds: ["alignment", "work", "memory"],
          phaseNotes: {
            "0": "",
            "1": "Build the compact preview UI",
          },
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);
    fireEvent.mouseEnter(screen.getByTestId("board-journey-hover-target"));

    const card = await screen.findByTestId("board-journey-hover-card");
    expect(within(card).getByText("q-924")).toBeInTheDocument();
    expect(within(card).getByText("Make Journey UI useful")).toBeInTheDocument();
    expect(within(card).getByText("Alignment")).toBeInTheDocument();
    expect(within(card).getByText("Work")).toBeInTheDocument();
    expect(within(card).getByText("Memory")).toBeInTheDocument();
    expect(within(card).getByText("Build the compact preview UI")).toHaveAttribute("data-purpose-kind", "authored");
    expect(within(card).getByText("Build the compact preview UI")).toHaveClass("ml-[1.375rem]");
    expect(within(card).queryByText(/Do a lightweight read-in/)).not.toBeInTheDocument();
    expect(within(card).getAllByTestId("quest-journey-phase-purpose")).toHaveLength(1);

    fireEvent.click(within(card).getByRole("button", { name: /q-924 Make Journey UI useful/ }));
    expect(openQuestOverlay).toHaveBeenCalledWith("q-924");
  });

  it("shows compact Journey durations in the hover preview", () => {
    mockState.quests = [
      {
        id: "q-1016-v1",
        questId: "q-1016",
        version: 1,
        title: "Track phase durations",
        status: "in_progress",
        createdAt: 1,
      },
    ];
    const board: BoardRowData[] = [
      {
        questId: "q-1016",
        title: "Fallback title",
        status: "WORKING",
        journey: {
          mode: "active",
          phaseIds: ["alignment", "work", "memory"],
          activePhaseIndex: 1,
          currentPhaseId: "work",
          phaseTimings: {
            "0": { startedAt: 1_000, endedAt: 61_000 },
            "1": { startedAt: 61_000, endedAt: 181_000 },
          },
        },
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);
    fireEvent.mouseEnter(screen.getByTestId("board-journey-hover-target"));

    const card = screen.getByTestId("board-journey-hover-card");
    expect(within(card).getByText(/3 phases · Total 3m/)).toBeInTheDocument();
    expect(
      within(card)
        .getAllByTestId("quest-journey-phase-duration")
        .map((node) => node.textContent),
    ).toEqual(["1m", "2m"]);
  });

  it("renders completed board Journey rows without active current-phase cues", async () => {
    mockState.quests = [
      {
        id: "q-953-v1",
        questId: "q-953",
        version: 1,
        title: "Use noninteractive Git editors",
        status: "done",
        createdAt: 1,
      },
    ];
    const board: BoardRowData[] = [
      {
        questId: "q-953",
        title: "Use noninteractive Git editors",
        status: "MEMORY",
        journey: {
          mode: "active",
          presetId: "v2-work",
          phaseIds: ["alignment", "work", "memory"],
          currentPhaseId: "memory",
        },
        updatedAt: 2,
        completedAt: 3,
      },
    ];

    render(<BoardTable board={board} mode="completed" />);

    // Completed board rows should not make the compact cell or hover card look like an active phase.
    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "completed");
    expect(within(summary).getByText("Completed")).toBeInTheDocument();
    expect(within(summary).queryByText("Port")).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("board-journey-hover-target"));
    const card = await screen.findByTestId("board-journey-hover-card");
    const timeline = within(card).getByTestId("quest-journey-timeline");
    expect(timeline).toHaveAttribute("data-journey-mode", "completed");
    expect(within(card).getByText("Completed Journey")).toBeInTheDocument();
    expect(within(card).queryByText("Active Journey")).not.toBeInTheDocument();
    expect(within(card).queryByText("current")).not.toBeInTheDocument();
    for (const phaseRow of timeline.querySelectorAll("li")) {
      expect(phaseRow).toHaveAttribute("data-phase-current", "false");
      expect(phaseRow).toHaveAttribute("data-phase-state", "finished");
    }
  });

  it("renders worker and reviewer session links in a wrapping same-line row with their own status dots", () => {
    const board: BoardRowData[] = [{ questId: "q-1", worker: "worker-1", workerNum: 11, updatedAt: 1 }];

    render(
      <BoardTable
        board={board}
        rowSessionStatuses={{
          "q-1": {
            worker: { sessionId: "worker-1", sessionNum: 11, status: "running" },
            reviewer: { sessionId: "reviewer-1", sessionNum: 12, status: "idle" },
          },
        }}
      />,
    );

    expect(screen.getByText("#11")).toBeInTheDocument();
    expect(screen.getByText("#12")).toBeInTheDocument();
    const sessionsCell = screen.getByText("#11").closest("td");
    expect(sessionsCell).toHaveClass("min-w-[8rem]", "whitespace-normal");
    const sessionsLayout = screen.getByText("#11").closest("div");
    expect(sessionsLayout).toHaveClass("flex-row", "flex-wrap", "gap-x-3", "gap-y-1");
    expect(sessionsLayout).not.toHaveClass("flex-col");
    const dots = screen.getAllByTestId("session-status-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute("data-status", "running");
    expect(dots[1]).toHaveAttribute("data-status", "idle");
  });

  it("prefers live session status over stale participant snapshots", () => {
    // Board rows can be less fresh than the sidebar. Participant chips should
    // use the same live store status as the sidebar when that session is known.
    mockState.sdkSessions = [
      {
        sessionId: "worker-live",
        sessionNum: 11,
        state: "running",
        status: "running",
        archived: false,
        cliConnected: true,
      },
      { sessionId: "reviewer-live", sessionNum: 12, state: "exited", archived: false, cliConnected: false },
      {
        sessionId: "worker-idle",
        sessionNum: 13,
        state: "connected",
        status: "idle",
        archived: false,
        cliConnected: true,
      },
    ];
    const board: BoardRowData[] = [
      { questId: "q-1", worker: "worker-live", workerNum: 11, updatedAt: 2 },
      { questId: "q-2", worker: "worker-idle", workerNum: 13, updatedAt: 1 },
    ];

    render(
      <BoardTable
        board={board}
        rowSessionStatuses={{
          "q-1": {
            worker: { sessionId: "worker-live", sessionNum: 11, status: "idle" },
            reviewer: { sessionId: "reviewer-live", sessionNum: 12, status: "running" },
          },
          "q-2": {
            worker: { sessionId: "worker-idle", sessionNum: 13, status: "running" },
            reviewer: null,
          },
        }}
      />,
    );

    expect(screen.getAllByTestId("session-status-dot").map((dot) => dot.getAttribute("data-status"))).toEqual([
      "running",
      "disconnected",
      "idle",
    ]);
  });

  it("uses the timer icon for otherwise idle participant sessions with active timers", () => {
    // Participant chips share the leader banner status path. They should show
    // scheduled timer state for idle sessions without overriding active states.
    mockState.sdkSessions = [
      {
        sessionId: "worker-timed",
        sessionNum: 11,
        state: "connected",
        status: "idle",
        archived: false,
        cliConnected: true,
        pendingTimerCount: 1,
      },
      {
        sessionId: "reviewer-running",
        sessionNum: 12,
        state: "running",
        status: "running",
        archived: false,
        cliConnected: true,
        pendingTimerCount: 1,
      },
      {
        sessionId: "worker-snapshot",
        sessionNum: 13,
        state: "connected",
        status: "idle",
        archived: false,
        cliConnected: true,
        pendingTimerCount: 2,
      },
    ];
    const board: BoardRowData[] = [
      { questId: "q-1", worker: "worker-timed", workerNum: 11, updatedAt: 2 },
      { questId: "q-2", worker: "worker-snapshot", workerNum: 13, updatedAt: 1 },
    ];

    render(
      <BoardTable
        board={board}
        rowSessionStatuses={{
          "q-1": {
            worker: { sessionId: "worker-timed", sessionNum: 11, status: "idle" },
            reviewer: { sessionId: "reviewer-running", sessionNum: 12, status: "running" },
          },
          "q-2": {
            worker: { sessionId: "worker-snapshot", sessionNum: 13, status: "idle" },
            reviewer: null,
          },
        }}
      />,
    );

    expect(screen.getAllByTestId("session-status-timer-icon").map((icon) => icon.getAttribute("data-count"))).toEqual([
      "1",
      "2",
    ]);
    expect(screen.getByTitle("1 scheduled timer")).toBeInTheDocument();
    expect(screen.getByTitle("2 scheduled timers")).toBeInTheDocument();
    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "running");
  });

  it("uses canonical timer data when a participant has only a session id", () => {
    // Covers the participant hook branch where the board row has only a session
    // id and the canonical navigation row carries the scheduled timer count.
    mockState.sdkSessions = [
      {
        sessionId: "worker-timer-only",
        sessionNum: 21,
        state: "connected",
        status: "idle",
        archived: false,
        cliConnected: true,
        pendingTimerCount: 1,
      },
    ];
    const board: BoardRowData[] = [{ questId: "q-1", worker: "worker-timer-only", workerNum: 21, updatedAt: 1 }];

    render(<BoardTable board={board} />);

    expect(screen.getByTestId("session-status-timer-icon")).toHaveAttribute("data-count", "1");
    expect(screen.getByTitle("1 scheduled timer")).toBeInTheDocument();
    expect(screen.queryByTestId("session-status-dot")).toBeNull();
  });

  it("renders only linked wait-for-input ids for active rows", () => {
    const board: BoardRowData[] = [
      {
        questId: "q-1",
        status: "WORKING",
        waitForInput: ["n-3", "n-8"],
        waitFor: ["q-2"],
        updatedAt: 1,
      },
    ];

    render(<BoardTable board={board} />);

    expect(screen.getByText("input 3")).toBeInTheDocument();
    expect(screen.getByText("input 8")).toBeInTheDocument();
    expect(screen.queryByText("q-2")).not.toBeInTheDocument();
  });

  it("orders active rows by journey status priority first", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "MEMORY", updatedAt: 1 },
      { questId: "q-2", status: "QUEUED", updatedAt: 2 },
      { questId: "q-3", status: "WORKING", updatedAt: 3 },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-1", "q-3", "q-2"]);
  });

  it("orders rows by recency within the same status when there are no dependencies", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "WORKING", updatedAt: 1_000 },
      { questId: "q-2", status: "WORKING", updatedAt: 5_000 },
      { questId: "q-3", status: "WORKING", updatedAt: 3_000 },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-2", "q-3", "q-1"]);
  });

  it("topologically orders queued rows based on quest wait-for dependencies", () => {
    const ordered = orderBoardRows([
      { questId: "q-3", status: "QUEUED", updatedAt: 9_000, waitFor: ["q-2"] },
      { questId: "q-1", status: "QUEUED", updatedAt: 1_000 },
      { questId: "q-2", status: "QUEUED", updatedAt: 5_000, waitFor: ["q-1"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-1", "q-2", "q-3"]);
  });

  it("ignores missing dependencies and falls back safely on cycles within queued rows", () => {
    const ordered = orderBoardRows([
      { questId: "q-1", status: "QUEUED", updatedAt: 1_000, waitFor: ["q-999"] },
      { questId: "q-2", status: "QUEUED", updatedAt: 3_000, waitFor: ["q-3"] },
      { questId: "q-3", status: "QUEUED", updatedAt: 2_000, waitFor: ["q-2"] },
    ]);

    expect(ordered.map((row) => row.questId)).toEqual(["q-2", "q-3", "q-1"]);
  });
});
