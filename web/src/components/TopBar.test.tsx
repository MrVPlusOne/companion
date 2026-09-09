// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { LeaderWorkboardView } from "../store-types.js";
import {
  SESSION_NAVIGATION_PROJECTION,
  sessionNavigationProjectionToSessionFields,
} from "../../shared/session-navigation-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../shared/leader-thread-tabs-projection.js";
import {
  createLeaderThreadTabsProjectionTab,
  createLeaderThreadTabsProjectionValue,
} from "../test-fixtures/leader-thread-tabs-projection.js";
import { createSessionNavigationProjectionValue } from "../test-fixtures/session-navigation-projection.js";

const mockNavigateTo = vi.fn();
const mockNavigateToSession = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
    pauseSession: vi.fn().mockResolvedValue({ ok: true }),
    unpauseSession: vi.fn().mockResolvedValue({ ok: true }),
    getSessionNotifications: vi.fn().mockResolvedValue([]),
    getBackendModels: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ sessionDefaults: undefined }),
    updateSessionConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false, session: {}, sessionState: {} }),
    fetchNotificationContext: vi.fn().mockResolvedValue(null),
    markNotificationDone: vi.fn().mockResolvedValue({ ok: true }),
    updateLeaderProfilePortrait: vi.fn(),
  },
}));
vi.mock("../utils/navigation.js", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));
vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(() => true),
}));
vi.mock("./SessionInfoPopover.js", () => ({
  SessionInfoPopover: ({
    anchorElement,
    onConfigure,
  }: {
    anchorElement?: HTMLElement | null;
    onConfigure?: (sessionId: string) => void;
  }) => (
    <div data-testid="session-info-popover" data-anchor-present={anchorElement ? "true" : "false"}>
      <button type="button" data-testid="mock-session-info-configure" onClick={() => onConfigure?.("s1")}>
        Configure Session
      </button>
    </div>
  ),
}));
vi.mock("./BoardTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BoardTable.js")>();
  return {
    ...actual,
    BoardTable: ({
      board,
      mode = "active",
    }: {
      board: Array<{ questId: string; status?: string; updatedAt: number }>;
      mode?: string;
    }) => (
      <div data-testid="board-table" data-mode={mode}>
        {board.length} rows
      </div>
    ),
  };
});

interface MockStoreState {
  currentSessionId: string | null;
  zoomLevel: number;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionTimers: Map<string, Array<{ id: string }>>;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionInfoOpenSessionId: ReturnType<typeof vi.fn>;
  codexSubagentInspector: { sessionId: string } | null;
  openCodexSubagentInspector: ReturnType<typeof vi.fn>;
  closeCodexSubagentInspector: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  sessions: Map<
    string,
    {
      cwd?: string;
      permissionMode?: string;
      backend_type?: string;
      claimedQuestStatus?: string;
      claimedQuestVerificationInboxUnread?: boolean;
      isOrchestrator?: boolean;
      pause?: any;
      codex_native_subagents?: any;
    }
  >;
  sdkSessions: {
    sessionId: string;
    createdAt: number;
    archived?: boolean;
    cwd?: string;
    name?: string;
    sessionNum?: number | null;
    model?: string;
    permissionMode?: string;
    backendType?: string;
    cliSessionId?: string | null;
    cliConnected?: boolean;
    state?: "idle" | "starting" | "connected" | "running" | "compacting" | "exited" | null;
    claimedQuestStatus?: string | null;
    claimedQuestVerificationInboxUnread?: boolean;
    pause?: any;
    pausedInputQueueCount?: number;
    pendingTimerCount?: number;
    isOrchestrator?: boolean;
    leaderProfilePortrait?: {
      id: string;
      poolId: string;
      label: string;
      smallUrl: string;
      largeUrl: string;
      smallSize: number;
      largeSize: number;
      smallBytes: number;
      largeBytes: number;
    };
  }[];
  updateSdkSession: ReturnType<typeof vi.fn>;
  changedFiles: Map<string, Set<string>>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionNotifications: Map<string, Array<any>>;
  sessionNames: Map<string, string>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  sessionBoards: Map<
    string,
    Array<{ questId: string; status?: string; updatedAt: number; worker?: string; workerNum?: number }>
  >;
  sessionBoardRowStatuses: Map<string, Record<string, unknown>>;
  sessionCompletedBoards: Map<
    string,
    Array<{ questId: string; status?: string; updatedAt: number; completedAt?: number }>
  >;
  leaderWorkboardViews: Map<string, LeaderWorkboardView>;
  setLeaderWorkboardView: ReturnType<typeof vi.fn>;
  quests: { status: string }[];
  questSummary: { active: number } | null;
  refreshQuestSummary: ReturnType<typeof vi.fn>;
  questNamedSessions: Set<string>;
  sessionPreviews: Map<string, string>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
  sessionTaskHistory: Map<string, unknown[]>;
  askPermission: Map<string, boolean>;
  activeTurnRoutes: Map<string, unknown>;
  shortcutSettings?: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  openSessionSearch: ReturnType<typeof vi.fn>;
  closeSessionSearch: ReturnType<typeof vi.fn>;
  setSessionNotifications: ReturnType<typeof vi.fn>;
  requestScrollToMessage: ReturnType<typeof vi.fn>;
  setExpandAllInTurn: ReturnType<typeof vi.fn>;
  requestBottomAlignOnNextUserMessage: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function leaderProjectionState(sessionId = "s1") {
  const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, sessionId);
  return {
    syncedProjectionValues: new Map([
      [
        entryId,
        createLeaderThreadTabsProjectionValue({
          tabs: [
            createLeaderThreadTabsProjectionTab("q-1", { active: true, canClose: false }),
            createLeaderThreadTabsProjectionTab("q-2", { completed: true }),
          ],
          mainAttention: {},
          threadStatuses: {},
          activePhaseSummary: [{ label: "Implement", count: 1, tone: "phase" }],
        }),
      ],
    ]),
    syncedProjectionKeys: new Set([entryId]),
  };
}

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    zoomLevel: 1,
    cliConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map([["s1", "idle"]]),
    sessionTimers: new Map(),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    setSessionInfoOpenSessionId: vi.fn(),
    codexSubagentInspector: null,
    openCodexSubagentInspector: vi.fn(),
    closeCodexSubagentInspector: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    updateSdkSession: vi.fn(),
    changedFiles: new Map(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    sessionNotifications: new Map(),
    sessionNames: new Map(),
    diffFileStats: new Map(),
    sessionBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    sessionCompletedBoards: new Map(),
    leaderWorkboardViews: new Map(),
    setLeaderWorkboardView: vi.fn(),
    quests: [],
    questSummary: null,
    refreshQuestSummary: vi.fn().mockResolvedValue(undefined),
    questNamedSessions: new Set(),
    sessionPreviews: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    sessionTaskHistory: new Map(),
    askPermission: new Map(),
    activeTurnRoutes: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    openSessionSearch: vi.fn(),
    closeSessionSearch: vi.fn(),
    setSessionNotifications: vi.fn(),
    requestScrollToMessage: vi.fn(),
    setExpandAllInTurn: vi.fn(),
    requestBottomAlignOnNextUserMessage: vi.fn(),
    ...overrides,
  };
  if (!overrides.setLeaderWorkboardView) {
    storeState.setLeaderWorkboardView = vi.fn((sessionId: string, view: LeaderWorkboardView | null) => {
      if (view) storeState.leaderWorkboardViews.set(sessionId, view);
      else storeState.leaderWorkboardViews.delete(sessionId);
    });
  }
}

vi.mock("../store.js", () => {
  const useStore: any = (selector: (s: MockStoreState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return {
    useStore,
    countUserPermissions: (perms: Map<string, unknown> | undefined): number => {
      if (!perms) return 0;
      let count = 0;
      for (const p of perms.values()) {
        const perm = p as { evaluating?: boolean; autoApproved?: string };
        if (!perm?.evaluating && !perm?.autoApproved) count++;
      }
      return count;
    },
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
  };
});

import { getCurrentTopBarSessionState, TopBar } from "./TopBar.js";
import { WorkBoardBar } from "./WorkBoardBar.js";
import { getGlobalNeedsInputEntries } from "./GlobalNeedsInputMenu.js";
import { api } from "../api.js";

beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1280;
  window.location.hash = "";
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  resetStore();
});

describe("TopBar", () => {
  it.each([
    ["action", "idle"],
    ["review", "completed_unread"],
    ["error", "completed_unread"],
    [null, "idle"],
  ] as const)("keeps %s attention distinct from unread results", (reason, expectedStatus) => {
    // A needs-input prompt can remain after every result was read. Its
    // attention must not turn the selected session's header blue.
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, cliConnected: true, state: "idle" }],
      sessionAttention: new Map([["s1", reason]]),
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", expectedStatus);
  });

  it("derives the global needs-input aggregate from unresolved needs-input notifications only", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", createdAt: 40, cliConnected: true, state: "running", sessionNum: 11, name: "One" },
        { sessionId: "s2", createdAt: 30, cliConnected: true, state: "idle", sessionNum: 12, name: "Two" },
        { sessionId: "archived", createdAt: 20, archived: true, sessionNum: 13, name: "Archived" },
      ],
      sessionNotifications: new Map([
        [
          "s1",
          [
            { id: "n-1", category: "needs-input", summary: "Need scope", timestamp: 3, messageId: "m1", done: false },
            { id: "review", category: "review", summary: "Review", timestamp: 4, messageId: "m2", done: false },
          ],
        ],
        [
          "s2",
          [
            { id: "done", category: "needs-input", summary: "Done", timestamp: 5, messageId: "m3", done: true },
            { id: "n-2", category: "needs-input", summary: "Need launch", timestamp: 6, messageId: "m4", done: false },
          ],
        ],
        [
          "archived",
          [{ id: "hidden", category: "needs-input", summary: "Archived", timestamp: 7, messageId: "m5", done: false }],
        ],
      ]),
    });

    const entries = getGlobalNeedsInputEntries(storeState as any);

    expect(entries.map((entry) => entry.notification.id)).toEqual(["n-2", "n-1"]);
    expect(entries.map((entry) => entry.sessionNum)).toEqual([12, 11]);
  });

  it("renders the global needs-input control at zero without counting other attention states", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s-running", createdAt: 40, cliConnected: true, state: "running" },
        { sessionId: "s-waiting", createdAt: 30, cliConnected: true, state: "idle" },
        { sessionId: "s-unread", createdAt: 20, cliConnected: true, state: "idle" },
      ],
      sessionStatus: new Map([
        ["s-running", "running"],
        ["s-waiting", "idle"],
        ["s-unread", "idle"],
      ]),
      cliConnected: new Map([
        ["s-running", true],
        ["s-waiting", true],
        ["s-unread", true],
      ]),
      pendingPermissions: new Map([["s-waiting", new Map([["perm-1", {}]])]]),
      sessionAttention: new Map([["s-unread", "review"]]),
      sessionNotifications: new Map([
        [
          "s-unread",
          [{ id: "review", category: "review", summary: "Review only", timestamp: Date.now(), done: false }],
        ],
      ]),
    });

    render(<TopBar />);

    expect(
      screen.getByRole("button", { name: "0 unresolved needs-input notifications across sessions" }),
    ).toBeInTheDocument();
  });

  it("keeps pause controls out of the top bar", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([["s1", { cwd: "/repo", pause: null }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 40, cliConnected: true, state: "connected", name: "Active" }],
    });

    render(<TopBar />);

    expect(screen.queryByTitle("Pause session")).not.toBeInTheDocument();
  });

  it("uses projected current-session status, permission, name, and timer authority", () => {
    resetStore({
      currentSessionId: "s1",
      sessionNames: new Map([["s1", "Stale name"]]),
      sessionStatus: new Map([["s1", "running"]]),
      sessionTimers: new Map([["s1", [{ id: "stale-timer" }]]]),
      pendingPermissions: new Map([["s1", new Map([["stale-permission", {}]])]]),
      questNamedSessions: new Set(["s1"]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, state: "running", name: "Stale name" }],
    });
    storeState.sdkSessions[0]!.isOrchestrator = true;
    storeState.sdkSessions[0]!.leaderProfilePortrait = {} as never;
    const entryId = syncedProjectionEntryId(SESSION_NAVIGATION_PROJECTION, "s1");
    storeState.syncedProjectionKeys.add(entryId);
    const navigation = createSessionNavigationProjectionValue({
      identity: { name: "Projected name" },
      lifecycle: { status: null, pendingPermissionCount: 0, pendingTimerCount: 0 },
    });
    storeState.syncedProjectionValues.set(entryId, navigation);
    storeState.sdkSessions[0] = {
      ...storeState.sdkSessions[0]!,
      ...sessionNavigationProjectionToSessionFields(navigation),
    };

    const current = getCurrentTopBarSessionState(storeState as never);

    expect(current).toMatchObject({
      sessionName: "Projected name",
      status: null,
      currentPermCount: 0,
      activeTimerCount: 0,
      isQuestNamed: false,
      leaderProfilePortrait: undefined,
    });
  });

  it("shows the timer status icon for an otherwise idle current session with active timers", () => {
    resetStore({
      currentSessionId: "s1",
      cliConnected: new Map([["s1", true]]),
      sessionStatus: new Map([["s1", "idle"]]),
      sessionTimers: new Map([["s1", [{ id: "timer-1" }]]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: true,
          state: "connected",
          name: "Timed",
          pendingTimerCount: 1,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-timer-icon")).toHaveAttribute("data-count", "1");
    expect(screen.queryByTestId("session-status-dot")).toBeNull();
  });

  it("keeps running top-bar status ahead of active timers", () => {
    resetStore({
      currentSessionId: "s1",
      cliConnected: new Map([["s1", true]]),
      sessionStatus: new Map([["s1", "running"]]),
      sessionTimers: new Map([["s1", [{ id: "timer-1" }]]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: true,
          state: "running",
          name: "Running",
          pendingTimerCount: 1,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "running");
    expect(screen.queryByTestId("session-status-timer-icon")).toBeNull();
  });

  it("uses route-owned chrome on full-page routes without showing the current session title", () => {
    resetStore({
      currentSessionId: "s1",
      sidebarOpen: false,
      sessionNames: new Map([["s1", "Main Session"]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 40, cliConnected: true, state: "connected", name: "Main Session" }],
    });

    render(<TopBar fullPageLabel="Memory" />);

    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.queryByText("Main Session")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Toggle sidebar"));
    expect(storeState.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("does not expose paused-state controls in the top bar", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            pause: {
              pausedAt: 123,
              queuedMessages: [
                { id: "p1", queuedAt: 124, source: "browser", message: { type: "user_message", content: "held" } },
                {
                  id: "p2",
                  queuedAt: 125,
                  source: "programmatic",
                  message: { type: "user_message", content: "later" },
                },
              ],
            },
          },
        ],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: false,
          state: "exited",
          name: "Emergency Hold",
          pause: {
            pausedAt: 123,
            queuedMessages: [],
          },
          pausedInputQueueCount: 2,
        },
      ],
      cliConnected: new Map([["s1", false]]),
    });

    render(<TopBar />);

    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Unpause session (2 held inputs)")).not.toBeInTheDocument();
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });

  it("does not expose reconnect for archived selected sessions", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          archived: true,
          cliConnected: false,
          state: "exited",
          name: "Archived Leader",
          isOrchestrator: true,
        },
      ],
      cliConnected: new Map([["s1", false]]),
    });

    render(<TopBar />);

    expect(screen.getByText("Archived Leader")).toBeInTheDocument();
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });

  it("opens an aggregated needs-input menu across sessions", () => {
    resetStore({
      sessionNotifications: new Map([
        [
          "s1",
          [
            {
              id: "n-1",
              category: "needs-input",
              summary: "Pick deployment window",
              timestamp: 1,
              messageId: "m1",
              done: false,
            },
          ],
        ],
        [
          "s2",
          [
            {
              id: "n-2",
              category: "needs-input",
              summary: "Confirm rollback plan",
              timestamp: 2,
              messageId: "m2",
              done: false,
            },
            { id: "review", category: "review", summary: "Review", timestamp: 3, messageId: "m3", done: false },
          ],
        ],
      ]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 10, sessionNum: 101, name: "Worker One" },
        { sessionId: "s2", createdAt: 20, sessionNum: 102, name: "Worker Two" },
      ],
    });

    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: "2 unresolved needs-input notifications across sessions" }));

    expect(screen.getByRole("dialog", { name: "Global needs-input notifications" })).toBeInTheDocument();
    expect(screen.getByText("#102 Worker Two")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to source for Confirm rollback plan" })).toBeInTheDocument();
    expect(screen.getByText("#101 Worker One")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to source for Pick deployment window" })).toBeInTheDocument();
  });

  it("stops quest badge polling while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      render(<TopBar />);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(1);

      visibilityState = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows session number next to the session name in the title area", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Main Session" }],
    });

    render(<TopBar />);
    expect(screen.getByText("#111")).toBeInTheDocument();
    expect(screen.getByText("Main Session")).toBeInTheDocument();
  });

  it("keeps the leader identity compact in the TopBar", () => {
    // The TopBar already pairs the session number with the leader profile and
    // name, so it must not duplicate the quest-banner role chip treatment.
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Coordinator Session"]]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Coordinator Session", isOrchestrator: true },
      ],
    });

    render(<TopBar />);

    const identityButton = screen.getByRole("button", { name: "Leader #111 Coordinator Session" });
    expect(identityButton).toHaveTextContent("#111Coordinator Session");
    expect(identityButton).not.toHaveTextContent("Leader");
    expect(screen.queryByTestId("topbar-leader-session-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-role-icon-leader")).not.toBeInTheDocument();
  });

  it("uses selected quest recorded commits as the diff button target in leader quest routes", () => {
    window.location.hash = "#/session/s1?thread=q-42";
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([
        ["s1", { cwd: "/repo/leader", isOrchestrator: true }],
        ["worker", { cwd: "/repo/worker" }],
      ]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Leader Session", isOrchestrator: true },
        { sessionId: "worker", createdAt: 2, sessionNum: 222, name: "Worker Session", cwd: "/repo/worker" },
      ],
      sessionBoards: new Map([["s1", [{ questId: "q-42", status: "IMPLEMENTING", updatedAt: 1, worker: "worker" }]]]),
      quests: [
        {
          id: "q-42-v1",
          questId: "q-42",
          version: 1,
          title: "Recorded commits",
          status: "in_progress",
          description: "Recorded commit fixture.",
          createdAt: 1,
          sessionId: "worker",
          claimedAt: 1,
          commitShas: ["abc1234", "def5678"],
        } as any,
      ],
      changedFiles: new Map([
        ["s1", new Set(["/repo/leader/leader.ts"])],
        ["worker", new Set(["/repo/worker/changed.ts", "/repo/worker/other.ts"])],
      ]),
    });

    render(<TopBar />);

    const diffButton = screen.getByRole("button", { name: "Show q-42 recorded commits" });
    expect(diffButton).toHaveAttribute("title", "Show q-42 recorded commits");
    expect(diffButton).toHaveTextContent("2");
  });

  it("keeps generic diff button copy for non-leader sessions", () => {
    resetStore({
      currentSessionId: "worker",
      sessions: new Map([["worker", { cwd: "/repo/worker" }]]),
      sdkSessions: [
        { sessionId: "worker", createdAt: 2, sessionNum: 222, name: "Worker Session", cwd: "/repo/worker" },
      ],
      changedFiles: new Map([["worker", new Set(["/repo/worker/changed.ts"])]]),
    });

    render(<TopBar />);

    const diffButton = screen.getByRole("button", { name: "Show diffs" });
    expect(diffButton).toHaveAttribute("title", "Show diffs");
    expect(screen.queryByRole("button", { name: "Show leader diffs" })).not.toBeInTheDocument();
  });

  it("shows a leader portrait before the leader session name and routes it to session info", async () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Leader Session"]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Leader Session",
          isOrchestrator: true,
          leaderProfilePortrait: {
            id: "tako1-01",
            poolId: "tako",
            label: "Tako 1.1",
            smallUrl: "/leader-profile-portraits/tako/tako1-01.v2.96.webp",
            largeUrl: "/leader-profile-portraits/tako/tako1-01.v2.320.webp",
            smallSize: 96,
            largeSize: 320,
            smallBytes: 2912,
            largeBytes: 19216,
          },
        },
      ],
    });

    render(<TopBar />);
    const portrait = screen.getByTestId("topbar-leader-profile-portrait");
    expect(portrait).toBeInTheDocument();
    expect(portrait).toHaveAttribute("width", "96");
    expect(portrait).toHaveAttribute("height", "96");
    expect(portrait).toHaveAttribute("loading", "eager");
    expect(portrait).toHaveAttribute("decoding", "async");
    expect(screen.getByText("Leader Session")).toBeInTheDocument();

    fireEvent.click(portrait);

    expect(screen.queryByRole("dialog", { name: "Leader profile" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("session-info-popover")).toHaveAttribute("data-anchor-present", "true");
    });
  });

  it("opens Configure Session from Session Info in the global modal layer", async () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            backend_type: "codex",
            model: "gpt-5.4",
            permissionMode: "codex-default",
            codex_service_tier: null,
          },
        ],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 1533,
          name: "Codex Session",
          backendType: "codex",
          model: "gpt-5.4",
          permissionMode: "codex-default",
        },
      ],
    });

    render(<TopBar />);
    fireEvent.click(screen.getByText("Codex Session"));

    await waitFor(() => expect(screen.getByTestId("session-info-popover")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("mock-session-info-configure"));

    const dialog = await screen.findByRole("dialog", { name: "Configure Session" });
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
  });

  it("does not show a duplicate plan/agent mode label in title bar", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "plan", backend_type: "codex" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Main Session",
          permissionMode: "plan",
          backendType: "codex",
        },
      ],
    });

    render(<TopBar />);
    expect(screen.queryByTitle("Current mode: Plan")).not.toBeInTheDocument();
  });

  it("shows desktop leader Workboard and Completed shortcuts when the current leader has counts", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });

    render(<TopBar />);

    expect(screen.getByTestId("topbar-workboard-shortcut")).toHaveTextContent("1 Implement");
    expect(screen.getByTestId("topbar-workboard-shortcut")).not.toHaveTextContent("Workboard");
    expect(screen.getByTestId("topbar-workboard-phase-summary")).toHaveTextContent("1 Implement");
    expect(screen.getByTestId("topbar-completed-shortcut")).toHaveTextContent("1Completed");
  });

  it("places desktop leader shortcuts before the notification bell and search controls", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" },
        { sessionId: "s2", createdAt: 2, name: "Worker Session", sessionNum: 12 },
      ],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
      sessionNotifications: new Map([
        [
          "s2",
          [{ id: "n-1", category: "needs-input", summary: "Need scope", timestamp: 3, messageId: "m1", done: false }],
        ],
      ]),
    });

    render(<TopBar />);

    const workboard = screen.getByTestId("topbar-workboard-shortcut");
    const completed = screen.getByTestId("topbar-completed-shortcut");
    const bell = screen.getByTitle("Needs-input notifications across sessions");
    const search = screen.getByTitle("Universal Search");
    expect(workboard.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(completed.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bell.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens desktop leader shortcuts in place without routing away from the current thread", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });
    window.location.hash = "#/session/s1?thread=q-1";

    render(<TopBar />);

    fireEvent.click(screen.getByTestId("topbar-workboard-shortcut"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", "active");
    expect(window.location.hash).toBe("#/session/s1?thread=q-1");

    fireEvent.click(screen.getByTestId("topbar-completed-shortcut"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", "completed");
    expect(window.location.hash).toBe("#/session/s1?thread=q-1");
  });

  it("toggles desktop leader shortcuts closed when the selected shortcut is clicked again", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
      leaderWorkboardViews: new Map([["s1", "active"]]),
    });

    const view = render(<TopBar />);

    fireEvent.click(screen.getByTestId("topbar-workboard-shortcut"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", null);

    storeState.leaderWorkboardViews.set("s1", "completed");
    view.rerender(<TopBar />);

    fireEvent.click(screen.getByTestId("topbar-completed-shortcut"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", null);
  });

  it.each([
    ["topbar-workboard-shortcut", "active", "active"],
    ["topbar-completed-shortcut", "completed", "completed"],
  ] as const)("opens the %s panel in place from a quest thread", (shortcutTestId, expectedView, expectedMode) => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
      ...leaderProjectionState(),
    });
    window.location.hash = "#/session/s1?thread=q-1";

    const view = render(
      <>
        <TopBar />
        <WorkBoardBar sessionId="s1" currentThreadKey="q-1" />
      </>,
    );

    expect(screen.queryByTestId("workboard-main-banner")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId(shortcutTestId));

    expect(window.location.hash).toBe("#/session/s1?thread=q-1");
    view.unmount();
    render(
      <>
        <TopBar />
        <WorkBoardBar sessionId="s1" currentThreadKey="q-1" />
      </>,
    );
    expect(screen.queryByTestId("workboard-main-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("workboard-panel")).toHaveAttribute("data-view", expectedView);
    expect(screen.getByTestId("board-table")).toHaveAttribute("data-mode", expectedMode);
  });

  it("does not let stale bridge role state revive leader shortcuts for a canonical worker row", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: false, name: "Worker Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });

    render(<TopBar />);

    expect(screen.queryByTestId("topbar-workboard-shortcut")).not.toBeInTheDocument();
    expect(screen.queryByTestId("topbar-completed-shortcut")).not.toBeInTheDocument();
  });

  it("shows checked quest marker from SDK metadata for a selected snapshot-only session", () => {
    // Direct navigation to an archived/exited session may render the title from
    // the /api/sessions snapshot before any live session state exists.
    resetStore({
      currentSessionId: "archived-worker",
      sessions: new Map(),
      cliConnected: new Map([["archived-worker", false]]),
      sessionStatus: new Map(),
      sessionNames: new Map([["archived-worker", "Use active leader thread tab as voice transcription context"]]),
      questNamedSessions: new Set(["archived-worker"]),
      sdkSessions: [
        {
          sessionId: "archived-worker",
          createdAt: 1,
          archived: true,
          state: "exited",
          sessionNum: 1544,
          name: "Use active leader thread tab as voice transcription context",
          claimedQuestStatus: "done",
          claimedQuestVerificationInboxUnread: true,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByText("☑ Use active leader thread tab as voice transcription context")).toBeInTheDocument();
  });

  it("preserves incomplete quest marker for selected in-progress SDK sessions", () => {
    resetStore({
      currentSessionId: "worker",
      sessions: new Map(),
      cliConnected: new Map([["worker", true]]),
      sessionNames: new Map([["worker", "Fix stale quest completion status in session sidebar titles"]]),
      questNamedSessions: new Set(["worker"]),
      sdkSessions: [
        {
          sessionId: "worker",
          createdAt: 1,
          state: "connected",
          sessionNum: 1550,
          name: "Fix stale quest completion status in session sidebar titles",
          claimedQuestStatus: "in_progress",
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByText("☐ Fix stale quest completion status in session sidebar titles")).toBeInTheDocument();
  });

  it("shows diff badge count only for files within cwd", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, state: "connected", cwd: "/repo" }],
      changedFiles: new Map([
        ["s1", new Set(["/repo/src/a.ts", "/repo/src/b.ts", "/Users/stan/.claude/plans/plan.md"])],
      ]),
    });

    render(<TopBar />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("hides diff badge when all changed files are out of scope", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, state: "connected", cwd: "/repo" }],
      changedFiles: new Map([["s1", new Set(["/Users/stan/.claude/plans/plan.md"])]]),
    });

    render(<TopBar />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("publishes opened session info panel id for sidebar-linked highlights", async () => {
    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: /session s1/i }));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith("s1");
    });

    fireEvent.click(screen.getByRole("button", { name: /session s1/i }));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith(null);
    });
  });

  it("ignores the removed browser-only session info section event", () => {
    render(<TopBar />);

    // A stale page or extension may still dispatch the old event; without the
    // editor there must be no empty popover shell or retained section anchor.
    window.dispatchEvent(
      new CustomEvent("takode:open-session-info", {
        detail: { sessionId: "s1", section: "codex-goal" },
      }),
    );

    expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
    expect(storeState.setSessionInfoOpenSessionId).not.toHaveBeenCalledWith("s1");
  });

  it("removes the duplicate title-bar copy and right-side session info buttons", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Main Session",
          cliSessionId: "cli-session-123",
        },
      ],
    });

    render(<TopBar />);

    expect(screen.queryByTitle(/Copy CLI Session ID/)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Session info")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /main session/i })).toBeInTheDocument();
  });

  it("shows the enabled search shortcut in the hover title", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
    });

    render(<TopBar />);
    expect(screen.getByTitle("Universal Search (Ctrl+Shift+F)")).toBeInTheDocument();
  });

  it("opens the single app-level Universal Search affordance", () => {
    // Keep one top-bar control for the shared Universal Search/Recent modal.
    const onOpenUniversalSearch = vi.fn();

    render(<TopBar onOpenUniversalSearch={onOpenUniversalSearch} />);

    expect(screen.queryByRole("button", { name: "Open Recent asks" })).toBeNull();
    expect(screen.getAllByTestId("topbar-universal-search")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Universal Search" }));
    expect(onOpenUniversalSearch).toHaveBeenCalledTimes(1);
  });
  it("keeps session-local Codex subagent access out of the global top bar", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            backend_type: "codex",
            codex_native_subagents: {
              revision: 3,
              coverage: "partial",
              session: { total: 5, statusCounts: {}, activeCount: 2, unresolvedCount: 1 },
              children: [],
              turns: {},
            },
          },
        ],
      ]),
    });

    render(<TopBar />);

    expect(screen.queryByTestId("topbar-codex-subagents")).toBeNull();
    expect(screen.queryByRole("button", { name: /Codex subagents/i })).toBeNull();
  });
});
