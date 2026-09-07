// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  SESSION_NAVIGATION_PROJECTION,
  sessionNavigationProjectionToSessionFields,
  type SessionNavigationProjectionValue,
} from "../../shared/session-navigation-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import { createSessionNavigationProjectionValue } from "../test-fixtures/session-navigation-projection.js";

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getSessionUsageLimits: vi.fn().mockRejectedValue(new Error("skip")),
    getPRStatus: vi.fn().mockRejectedValue(new Error("skip")),
    getClaudeMdFiles: vi.fn().mockResolvedValue({ cwd: "/repo", files: [] }),
    getSessionInfo: vi.fn().mockResolvedValue({ sessionId: "s1", state: "connected", cwd: "/repo", createdAt: 1 }),
    getSessionSystemPrompt: vi.fn().mockResolvedValue({ prompt: null }),
    getSessionInstructionContent: vi.fn(),
    getAutoApprovalConfigForPath: vi.fn().mockResolvedValue({ config: null }),
    getHerdDiagnostics: vi.fn().mockResolvedValue({
      herdDispatcher: { pendingEventCount: 0, eventHistory: [] },
      isGenerating: false,
      cliConnected: true,
      cliInitReceived: true,
      pendingMessagesCount: 0,
      disconnectGraceActive: false,
      herdedWorkers: [],
      pendingPermissionsCount: 0,
    }),
    unherdSession: vi.fn().mockResolvedValue({ ok: true }),
    setSessionPermissionMode: vi
      .fn()
      .mockResolvedValue({ ok: true, sessionId: "worker-1", permissionMode: "codex-auto-review" }),
    listSessions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api.js", () => ({
  api: mockApi,
}));

vi.mock("./McpPanel.js", () => ({
  McpSection: () => <div data-testid="mcp-section">MCP Section</div>,
}));

interface CodexTokenDetails {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  modelContextWindow: number;
}

interface CodexRateLimits {
  primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
}

interface MockStoreState {
  sessionTasks: Map<string, { id: string; status: string; subject: string }[]>;
  sessionTaskHistory: Map<string, { title: string; triggerMessageId: string }[]>;
  requestScrollToTurn: ReturnType<typeof vi.fn>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  sessions: Map<
    string,
    {
      backend_type?: string;
      cwd?: string;
      repo_root?: string;
      git_branch?: string;
      codex_token_details?: CodexTokenDetails;
      claude_token_details?: Omit<CodexTokenDetails, "reasoningOutputTokens">;
      codex_rate_limits?: CodexRateLimits;
      context_used_percent?: number;
      claimedQuestId?: string;
      claimedQuestTitle?: string;
      claimedQuestStatus?: string;
    }
  >;
  sdkSessions: {
    sessionId: string;
    isOrchestrator?: boolean;
    archived?: boolean;
    backendType?: string;
    cwd?: string;
    gitBranch?: string;
    codexTokenDetails?: CodexTokenDetails;
    claudeTokenDetails?: Omit<CodexTokenDetails, "reasoningOutputTokens">;
    sessionNum?: number | null;
    state?: "starting" | "connected" | "running" | "exited";
    createdAt?: number;
    cliConnected?: boolean;
    repoRoot?: string;
    herdedBy?: string;
    permissionMode?: string;
    name?: string;
    claimedQuestId?: string | null;
    claimedQuestTitle?: string | null;
    claimedQuestStatus?: string | null;
  }[];
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  prStatus: Map<string, { available: boolean; pr?: unknown } | null>;
  quests: Array<any>;
  sessionBoards: Map<string, Array<any>>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
  sessionKeywords: Map<string, string[]>;
  sessionNotifications: Map<string, any[]>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  cliConnected: Map<string, boolean>;
  askPermission: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  openQuestOverlay: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  markQuestNamed: ReturnType<typeof vi.fn>;
  clearQuestNamed: ReturnType<typeof vi.fn>;
  setSessionPreview: ReturnType<typeof vi.fn>;
  setSessionTaskHistory: ReturnType<typeof vi.fn>;
  setSessionKeywords: ReturnType<typeof vi.fn>;
  setSessionBoard: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
}

let mockState: MockStoreState;

function materializeNavigation(sessionId: string, value: SessionNavigationProjectionValue) {
  const index = mockState.sdkSessions.findIndex((session) => session.sessionId === sessionId);
  if (index >= 0) {
    mockState.sdkSessions[index] = {
      ...mockState.sdkSessions[index]!,
      ...sessionNavigationProjectionToSessionFields(value),
    };
  }
}

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTasks: new Map(),
    sessionTaskHistory: new Map(),
    requestScrollToTurn: vi.fn(),
    sessionStatus: new Map([["s1", "idle"]]),
    sessions: new Map([["s1", { backend_type: "codex" }]]),
    sdkSessions: [],
    taskPanelOpen: true,
    setTaskPanelOpen: vi.fn(),
    prStatus: new Map(),
    quests: [],
    sessionBoards: new Map(),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    sessionKeywords: new Map(),
    sessionNotifications: new Map(),
    sessionAttention: new Map(),
    pendingPermissions: new Map(),
    cliConnected: new Map(),
    askPermission: new Map(),
    cliDisconnectReason: new Map(),
    openQuestOverlay: vi.fn(),
    setSessionName: vi.fn((sessionId: string, name: string) => mockState.sessionNames.set(sessionId, name)),
    markRecentlyRenamed: vi.fn(),
    markQuestNamed: vi.fn(),
    clearQuestNamed: vi.fn(),
    setSessionPreview: vi.fn((sessionId: string, preview: string) => mockState.sessionPreviews.set(sessionId, preview)),
    setSessionTaskHistory: vi.fn((sessionId: string, history: any[]) =>
      mockState.sessionTaskHistory.set(sessionId, history),
    ),
    setSessionKeywords: vi.fn((sessionId: string, keywords: string[]) =>
      mockState.sessionKeywords.set(sessionId, keywords),
    ),
    setSessionBoard: vi.fn((sessionId: string, rows: any[]) => mockState.sessionBoards.set(sessionId, rows)),
    setSdkSessions: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStore = (selector: (s: MockStoreState) => unknown) => selector(mockState);
  useStore.getState = () => mockState;
  useStore.setState = (patch: Partial<MockStoreState> | ((state: MockStoreState) => Partial<MockStoreState>)) => {
    const next = typeof patch === "function" ? patch(mockState) : patch;
    mockState = { ...mockState, ...next };
  };
  return {
    useStore,
    countUserPermissions: () => 0,
  };
});

import {
  TaskPanel,
  CodexInstructionsCollapsible,
  CodexRateLimitsSection,
  CodexTokenDetailsSection,
  ClaudeMdCollapsible,
} from "./TaskPanel.js";

function instructionSnapshot(threadId: string) {
  return {
    threadId,
    capturedAt: 1,
    lifecycle: "thread_start" as const,
    instructionSourcesReported: true,
    developerInstructionsConfigured: true,
    configLayers: [],
    instructionSources: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockApi.getClaudeMdFiles.mockResolvedValue({ cwd: "/repo", files: [] });
  mockApi.getSessionInfo.mockResolvedValue({ sessionId: "s1", state: "connected", cwd: "/repo", createdAt: 1 });
  mockApi.getSessionSystemPrompt.mockResolvedValue({ prompt: null });
  mockApi.getAutoApprovalConfigForPath.mockResolvedValue({ config: null });
  resetStore();
});

describe("TaskPanel", () => {
  it("renders nothing when closed", () => {
    resetStore({ taskPanelOpen: false });
    const { container } = render(<TaskPanel sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows task sections for Codex sessions when tasks exist", () => {
    // Regression coverage: Codex sessions should display the same task/todo UI
    // as Claude sessions whenever the store has extracted tasks.
    resetStore({
      sessionTasks: new Map([
        [
          "s1",
          [
            { id: "t1", status: "in_progress", subject: "Implement adapter fix" },
            { id: "t2", status: "pending", subject: "Add regression tests" },
          ],
        ],
      ]),
      sessions: new Map([["s1", { backend_type: "codex" }]]),
    });

    render(<TaskPanel sessionId="s1" />);
    expect(screen.getByText("Current To-Dos")).toBeInTheDocument();
    expect(screen.getByText("Implement adapter fix")).toBeInTheDocument();
    expect(screen.getByText("Add regression tests")).toBeInTheDocument();
  });

  it("uses projected backend, paths, branch, and leader role for the selected-session panel", async () => {
    // Navigation projections own summary fields even while the selected bridge
    // and session-list snapshots still carry older values.
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "claude",
            cwd: "/stale/cwd",
            repo_root: "/stale/root",
            git_branch: "stale-branch",
          },
        ],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          sessionNum: 1,
          state: "connected",
          createdAt: 1,
          backendType: "claude",
          cwd: "/stale/cwd",
          repoRoot: "/stale/root",
          gitBranch: "stale-branch",
          isOrchestrator: false,
        },
      ],
    });
    const entryId = syncedProjectionEntryId(SESSION_NAVIGATION_PROJECTION, "s1");
    mockState.syncedProjectionKeys.add(entryId);
    const navigation = createSessionNavigationProjectionValue({
      identity: { backendType: "codex", cwd: "/projected/cwd" },
      topology: { repoRoot: "/projected/root", isOrchestrator: true },
      git: { branch: "projected-branch" },
    });
    mockState.syncedProjectionValues.set(entryId, navigation);
    materializeNavigation("s1", navigation);

    render(<TaskPanel sessionId="s1" />);

    expect(screen.getByRole("button", { name: "Herded Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Herd Diagnostics" })).toBeInTheDocument();
    expect(mockApi.getSessionUsageLimits).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mockApi.getPRStatus).toHaveBeenCalledWith("/projected/cwd", "projected-branch");
      expect(mockApi.getSessionInfo).toHaveBeenCalledWith("s1");
      expect(mockApi.getClaudeMdFiles).not.toHaveBeenCalled();
      expect(mockApi.getAutoApprovalConfigForPath).not.toHaveBeenCalled();
    });
  });

  it("lets a leader confirm a Codex permission profile change for a herded worker", async () => {
    // This covers the leader-side worker control: selecting a new profile must
    // pause for restart confirmation before the server relaunch path is called.
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          sessionNum: 1,
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          backendType: "codex",
          isOrchestrator: true,
        },
        {
          sessionId: "worker-1",
          sessionNum: 2,
          state: "connected",
          cwd: "/repo",
          createdAt: 2,
          backendType: "codex",
          herdedBy: "s1",
          permissionMode: "codex-default",
          name: "Worker One",
        },
      ],
    });

    render(<TaskPanel sessionId="s1" />);

    fireEvent.change(screen.getByLabelText("Codex permissions for Worker One"), {
      target: { value: "auto-review" },
    });

    expect(screen.getByText("Restart worker with Auto-review?")).toBeInTheDocument();
    expect(mockApi.setSessionPermissionMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Restart"));

    await waitFor(() =>
      expect(mockApi.setSessionPermissionMode).toHaveBeenCalledWith("worker-1", "codex-auto-review", {
        leaderSessionId: "s1",
      }),
    );
  });

  it("uses projected worker topology, identity, lifecycle, and permission mode", () => {
    resetStore({
      sdkSessions: [
        {
          sessionId: "s1",
          sessionNum: 1,
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          backendType: "codex",
          isOrchestrator: true,
        },
        {
          sessionId: "worker-1",
          sessionNum: 2,
          state: "exited",
          cwd: "/legacy",
          createdAt: 2,
          backendType: "claude",
          herdedBy: "stale-leader",
          permissionMode: "bypassPermissions",
          name: "Stale worker",
        },
      ],
    });
    const entryId = syncedProjectionEntryId(SESSION_NAVIGATION_PROJECTION, "worker-1");
    mockState.syncedProjectionKeys.add(entryId);
    const navigation = createSessionNavigationProjectionValue({
      identity: {
        name: "Projected worker",
        sessionNum: 9,
        backendType: "codex",
        permissionMode: "codex-auto-review",
      },
      topology: { herdedBy: "s1" },
      lifecycle: { sdkState: "running", status: "running", cliConnected: true },
    });
    mockState.syncedProjectionValues.set(entryId, navigation);
    materializeNavigation("worker-1", navigation);

    render(<TaskPanel sessionId="s1" />);

    expect(screen.getByText("Projected worker")).toBeInTheDocument();
    expect(screen.getByText("#9")).toBeInTheDocument();
    expect(screen.getByLabelText("Codex permissions for Projected worker")).toHaveValue("auto-review");
    expect(screen.queryByText("Stale worker")).toBeNull();
  });

  it("preserves already-loaded archived rows after active-only herded-session refreshes", async () => {
    const leader = {
      sessionId: "s1",
      sessionNum: 1,
      state: "connected" as const,
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      isOrchestrator: true,
    };
    const worker = {
      sessionId: "worker-1",
      sessionNum: 2,
      state: "connected" as const,
      cwd: "/repo",
      createdAt: 2,
      backendType: "codex",
      herdedBy: "s1",
      permissionMode: "codex-default",
      name: "Worker One",
    };
    const archived = {
      sessionId: "archived-1",
      sessionNum: 3,
      state: "exited" as const,
      cwd: "/repo",
      createdAt: 3,
      backendType: "codex",
      archived: true,
      name: "Archived One",
    };
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex" }]]),
      sdkSessions: [leader, worker, archived],
      setSdkSessions: vi.fn((sessions) => {
        mockState.sdkSessions = sessions as MockStoreState["sdkSessions"];
      }),
    });
    mockApi.listSessions.mockResolvedValueOnce([leader, worker]);

    render(<TaskPanel sessionId="s1" />);
    fireEvent.click(screen.getByTitle("Unherd this session"));

    await waitFor(() => expect(mockApi.listSessions).toHaveBeenCalledWith({ includeArchived: false }));
    await waitFor(() =>
      expect(mockState.sdkSessions.map((session) => session.sessionId)).toEqual(["s1", "worker-1", "archived-1"]),
    );
    expect(mockState.sdkSessions.find((session) => session.sessionId === "archived-1")).toEqual(archived);
  });

  it("keeps a single scroll container for long MCP content even without tasks", () => {
    // Regression coverage: when no task list is present, the panel itself
    // must still provide vertical scrolling for long MCP content.
    const { container } = render(<TaskPanel sessionId="s1" />);

    expect(screen.getByTestId("mcp-section")).toBeInTheDocument();
    expect(screen.getByTestId("task-panel-content")).toHaveClass("overflow-y-auto");
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
  });

  it("renders the selected session claimed quest with verification, feedback, and owner details", () => {
    // The right panel should make current quest facts visible so leader prose
    // can focus on decisions and reasoning instead of restating this state.
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            claimedQuestId: "q-42",
            claimedQuestTitle: "Fallback claimed title",
            claimedQuestStatus: "done",
          },
        ],
        ["worker-1", { backend_type: "codex" }],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          sessionNum: 1,
          state: "connected",
          cwd: "/repo",
          createdAt: 2,
          backendType: "codex",
          claimedQuestId: "q-42",
          claimedQuestTitle: "Fallback claimed title",
          claimedQuestStatus: "done",
        },
        {
          sessionId: "worker-1",
          sessionNum: 7,
          state: "running",
          cwd: "/repo",
          createdAt: 1,
          backendType: "codex",
        },
      ],
      quests: [
        {
          id: "q-42-v3",
          questId: "q-42",
          version: 3,
          title: "Verify right panel quest status",
          status: "done",
          description: "Show the accepted quest status facts.",
          createdAt: 1,
          sessionId: "worker-1",
          claimedAt: 2,
          verificationInboxUnread: true,
          verificationItems: [
            { text: "Quest card is visible", checked: true },
            { text: "Detail panel opens", checked: false },
          ],
          feedback: [
            { author: "human", text: "Please check the wait state.", ts: 3, addressed: false },
            { author: "human", text: "Earlier note handled.", ts: 4, addressed: true },
          ],
          commitShas: ["abc1234", "def5678"],
        },
      ],
    });

    render(<TaskPanel sessionId="s1" />);

    expect(screen.getByText("Selected session quest")).toBeInTheDocument();
    expect(screen.getByText("q-42")).toBeInTheDocument();
    expect(screen.getByText("Verify right panel quest status")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("User review checks")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("unread")).toBeInTheDocument();
    expect(screen.getByText("1 open")).toBeInTheDocument();
    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.getByText("Commits")).toBeInTheDocument();
    expect(screen.getByText("1 unaddressed human feedback")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#7" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open details" }));

    expect(mockState.openQuestOverlay).toHaveBeenCalledWith("q-42");
  });

  it("renders a leader board attention row with wait state and compact Journey context", () => {
    resetStore({
      sessions: new Map([["leader", { backend_type: "codex" }]]),
      sdkSessions: [
        { sessionId: "leader", isOrchestrator: true, state: "running", cwd: "/repo", createdAt: 1 },
        { sessionId: "worker-2", sessionNum: 12, state: "running", cwd: "/repo", createdAt: 1 },
      ],
      quests: [
        {
          id: "q-77-v1",
          questId: "q-77",
          version: 1,
          title: "Port accepted quest status",
          status: "in_progress",
          description: "Port the accepted changes.",
          createdAt: 1,
          sessionId: "worker-2",
          claimedAt: 2,
        },
      ],
      sessionBoards: new Map([
        [
          "leader",
          [
            {
              questId: "q-77",
              title: "Port accepted quest status",
              worker: "worker-2",
              workerNum: 12,
              status: "MEMORY",
              waitForInput: ["n-4"],
              updatedAt: 10,
              journey: {
                phaseIds: ["alignment", "work", "memory"],
                mode: "active",
                currentPhaseId: "memory",
                activePhaseIndex: 2,
              },
            },
          ],
        ],
      ]),
    });

    render(<TaskPanel sessionId="leader" />);

    expect(screen.getByText("Board attention row")).toBeInTheDocument();
    expect(screen.getByText("Port accepted quest status")).toBeInTheDocument();
    expect(screen.getByText("Waiting for input: n-4")).toBeInTheDocument();
    expect(screen.getByTestId("quest-journey-compact-summary")).toHaveAttribute("data-journey-mode", "active");
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#12" })).toBeInTheDocument();
  });

  it("shows the exact Codex-loaded instruction snapshot with global provenance", async () => {
    localStorage.setItem("cc-collapse-codex-instructions", "0");
    mockApi.getSessionInfo.mockResolvedValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      codexInstructionSnapshot: {
        threadId: "thread-123",
        capturedAt: Date.UTC(2026, 8, 7, 12, 0, 0),
        lifecycle: "thread_resume",
        instructionSourcesReported: true,
        developerInstructionsConfigured: true,
        configLayers: [{ kind: "user", path: "/session-home/config.toml" }],
        instructionSources: [
          {
            path: "/session-home/AGENTS.md",
            kind: "global",
            sourcePath: "/Users/me/.codex/AGENTS.md",
            delivery: "copied_snapshot",
          },
          { path: "/repo/AGENTS.md", kind: "project", delivery: "direct" },
        ],
      },
    });

    render(<CodexInstructionsCollapsible sessionId="s1" />);

    expect(await screen.findByText("/Users/me/.codex/AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("Loaded snapshot:")).toBeInTheDocument();
    expect(screen.getByText("/repo/AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.getByText(/Instruction details show captured/)).toBeInTheDocument();
  });

  it("refreshes the snapshot when the Codex launch identity changes without painting stale sources", async () => {
    localStorage.setItem("cc-collapse-codex-instructions", "0");
    mockApi.getSessionInfo.mockResolvedValueOnce({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      codexInstructionSnapshot: {
        threadId: "thread-old",
        capturedAt: 1,
        lifecycle: "thread_resume",
        instructionSourcesReported: true,
        developerInstructionsConfigured: true,
        configLayers: [],
        instructionSources: [{ path: "/repo/old/AGENTS.md", kind: "project", delivery: "direct" }],
      },
    });

    const { rerender } = render(
      <CodexInstructionsCollapsible sessionId="s1" refreshKey="pid-1:thread-old:connected" />,
    );
    expect(await screen.findByText("/repo/old/AGENTS.md")).toBeInTheDocument();

    mockApi.getSessionInfo.mockResolvedValueOnce({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      codexInstructionSnapshot: {
        threadId: "thread-old",
        capturedAt: 2,
        lifecycle: "thread_resume",
        instructionSourcesReported: true,
        developerInstructionsConfigured: true,
        configLayers: [],
        instructionSources: [{ path: "/repo/new/AGENTS.md", kind: "project", delivery: "direct" }],
      },
    });
    rerender(<CodexInstructionsCollapsible sessionId="s1" refreshKey="pid-2:thread-old:connected" />);

    expect(screen.queryByText("/repo/old/AGENTS.md")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("/repo/new/AGENTS.md")).toBeInTheDocument();
    expect(mockApi.getSessionInfo).toHaveBeenCalledTimes(2);
  });

  it("renders unknown instruction origins without calling them repository files", () => {
    localStorage.setItem("cc-collapse-codex-instructions", "0");
    render(
      <CodexInstructionsCollapsible
        sessionId="s1"
        fetchWhenMissing={false}
        snapshot={{
          threadId: "thread-unknown",
          capturedAt: 1,
          lifecycle: "thread_start",
          instructionSourcesReported: true,
          developerInstructionsConfigured: false,
          configLayers: [],
          instructionSources: [{ path: "/unclassified/AGENTS.md", kind: "unknown", delivery: "direct" }],
        }}
      />,
    );

    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.queryByText("Repository")).not.toBeInTheDocument();
  });

  it("does not retry a failed instruction-detail request in a render loop", async () => {
    localStorage.setItem("cc-collapse-codex-instructions", "0");
    mockApi.getSessionInfo.mockRejectedValue(new Error("unavailable"));

    render(<CodexInstructionsCollapsible sessionId="s1" />);

    expect(await screen.findByText("Could not load the instruction snapshot.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockApi.getSessionInfo).toHaveBeenCalledOnce();
  });

  it("does not fetch Codex instruction details until the collapsed section is opened", async () => {
    localStorage.setItem("cc-collapse-codex-instructions", "1");
    render(<CodexInstructionsCollapsible sessionId="s1" />);
    expect(mockApi.getSessionInfo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Developer Instructions" }));
    await waitFor(() => expect(mockApi.getSessionInfo).toHaveBeenCalledWith("s1"));
  });

  it("keeps generated instruction content lazy after the shared section opens", async () => {
    // Opening metadata is not permission to download any captured body.
    localStorage.setItem("cc-collapse-codex-instructions", "1");
    mockApi.getSessionInfo.mockResolvedValue({
      sessionId: "s1",
      codexInstructionSnapshot: instructionSnapshot("thread-one"),
    });
    render(<CodexInstructionsCollapsible sessionId="s1" />);

    const sectionButton = screen.getByRole("button", { name: "Developer Instructions" });
    expect(sectionButton).toHaveAttribute("type", "button");
    expect(sectionButton).toHaveAttribute("aria-expanded", "false");
    expect(mockApi.getSessionInstructionContent).not.toHaveBeenCalled();
    fireEvent.click(sectionButton);
    expect(await screen.findByRole("button", { name: "Takode-generated instructions" })).toBeInTheDocument();
    expect(mockApi.getSessionInstructionContent).not.toHaveBeenCalled();
    expect(mockApi.getSessionSystemPrompt).not.toHaveBeenCalled();
  });

  it("distinguishes a developer-instruction load failure from an empty prompt", async () => {
    mockApi.getSessionInstructionContent.mockRejectedValue(new Error("unavailable"));
    render(<CodexInstructionsCollapsible sessionId="s1" snapshot={instructionSnapshot("thread-one")} />);

    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the captured instructions.");
    expect(screen.queryByText("No system prompt recorded")).not.toBeInTheDocument();
  });

  it("does not show one Codex session's developer instructions after switching sessions", async () => {
    // The session is part of viewer identity even if a producer repeats capture timestamps.
    mockApi.getSessionInstructionContent.mockResolvedValueOnce({
      threadId: "thread-one",
      capturedAt: 1,
      source: "generated",
      content: "session one private guidance",
    });
    const { rerender } = render(
      <CodexInstructionsCollapsible sessionId="s1" snapshot={instructionSnapshot("thread-one")} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    expect(await screen.findByText("session one private guidance")).toBeInTheDocument();
    mockApi.getSessionInstructionContent.mockResolvedValueOnce({
      threadId: "thread-two",
      capturedAt: 1,
      source: "generated",
      content: "session two private guidance",
    });
    rerender(<CodexInstructionsCollapsible sessionId="s2" snapshot={instructionSnapshot("thread-two")} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("session one private guidance")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    expect(await screen.findByText("session two private guidance")).toBeInTheDocument();
  });

  it("keeps Claude files out of the Codex task panel", async () => {
    localStorage.setItem("cc-collapse-codex-instructions", "1");
    resetStore({
      sessions: new Map([["s1", { backend_type: "codex", cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", backendType: "codex", cwd: "/repo" }],
    });

    render(<TaskPanel sessionId="s1" />);

    expect(screen.getAllByRole("button", { name: "Developer Instructions" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Codex Instructions" })).not.toBeInTheDocument();
    expect(mockApi.getSessionSystemPrompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "CLAUDE.md" })).not.toBeInTheDocument();
    expect(mockApi.getClaudeMdFiles).not.toHaveBeenCalled();
  });

  it("shows Auto-Approval Rules in CLAUDE.md section when config exists", async () => {
    mockApi.getClaudeMdFiles.mockResolvedValue({
      cwd: "/repo",
      files: [],
    });
    mockApi.getAutoApprovalConfigForPath.mockResolvedValue({
      config: {
        slug: "repo",
        projectPath: "/repo",
        label: "Repo defaults",
        criteria: "Allow harmless commands",
        enabled: true,
      },
    });
    localStorage.setItem("cc-collapse-claudemd", "0");

    render(<ClaudeMdCollapsible cwd="/repo" repoRoot="/repo" />);

    await waitFor(() => expect(mockApi.getAutoApprovalConfigForPath).toHaveBeenCalledWith("/repo", "/repo"), {
      timeout: 5000,
    });

    const autoApprovalButton = await screen.findByRole("button", { name: "Auto-Approval Rules" }, { timeout: 5000 });
    fireEvent.click(autoApprovalButton);
    await screen.findByText("Read-only", {}, { timeout: 5000 });
  });

  it("does not start herd diagnostics polling when the task panel is closed", () => {
    resetStore({
      taskPanelOpen: false,
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
    });

    render(<TaskPanel sessionId="s1" />);

    expect(mockApi.getHerdDiagnostics).not.toHaveBeenCalled();
  });

  it("does not poll herd diagnostics while the section is collapsed", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("cc-collapse-herd-diag", "1");
      resetStore({
        sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      });

      render(<TaskPanel sessionId="s1" />);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(mockApi.getHerdDiagnostics).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the herd diagnostics header visible when first mounted collapsed", () => {
    localStorage.setItem("cc-collapse-herd-diag", "1");
    resetStore({
      sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
    });

    render(<TaskPanel sessionId="s1" />);

    // Regression coverage for q-365: persisted collapsed state must not hide
    // the entire section before diagnostics data has ever loaded.
    expect(screen.getByRole("button", { name: "Herd Diagnostics" })).toBeInTheDocument();
    expect(mockApi.getHerdDiagnostics).not.toHaveBeenCalled();
  });

  it("polls herd diagnostics only when the section is visible", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("cc-collapse-herd-diag", "0");
      resetStore({
        sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
      });

      render(<TaskPanel sessionId="s1" />);

      await vi.advanceTimersByTimeAsync(0);
      expect(mockApi.getHerdDiagnostics).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockApi.getHerdDiagnostics).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexRateLimitsSection", () => {
  it("renders nothing when no rate limits data", () => {
    // Session exists but has no codex_rate_limits
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when both primary and secondary are null", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            codex_rate_limits: { primary: null, secondary: null },
          },
        ],
      ]),
    });
    const { container } = render(<CodexRateLimitsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders primary rate limit bar with percentage and window label", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            codex_rate_limits: {
              primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 7_200_000 },
              secondary: null,
            },
          },
        ],
      ]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("renders both primary and secondary limits", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            codex_rate_limits: {
              primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Date.now() + 3_600_000 },
              secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: Date.now() + 86_400_000 },
            },
          },
        ],
      ]),
    });
    render(<CodexRateLimitsSection sessionId="s1" />);
    // 300 mins = 5h, 10080 mins = 7d
    expect(screen.getByText("5h Limit")).toBeInTheDocument();
    expect(screen.getByText("7d Limit")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("formats codex reset countdown correctly when resetsAt is epoch-seconds", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
      const resetAtSec = Math.floor(Date.now() / 1000) + 7200;
      resetStore({
        sessions: new Map([
          [
            "s1",
            {
              backend_type: "codex",
              codex_rate_limits: {
                primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: resetAtSec },
                secondary: null,
              },
            },
          ],
        ]),
      });
      render(<CodexRateLimitsSection sessionId="s1" />);
      expect(screen.getByText("(2h0m)")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexTokenDetailsSection", () => {
  it("renders nothing when no token details", () => {
    resetStore({ sessions: new Map([["s1", { backend_type: "codex" }]]) });
    const { container } = render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders input and output token counts", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            context_used_percent: 42,
            codex_token_details: {
              inputTokens: 84_230,
              outputTokens: 12_450,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 200_000,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("84.2k")).toBeInTheDocument();
    expect(screen.getByText("12.4k")).toBeInTheDocument();
  });

  it("renders Claude token details from normalized modelUsage", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "claude",
            context_used_percent: 38,
            claude_token_details: {
              inputTokens: 12_000,
              outputTokens: 3_400,
              cachedInputTokens: 98_000,
              modelContextWindow: 200_000,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("12.0k")).toBeInTheDocument();
    expect(screen.getByText("3.4k")).toBeInTheDocument();
    expect(screen.getByText("98.0k")).toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("shows cached and reasoning rows only when non-zero", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            context_used_percent: 55,
            codex_token_details: {
              inputTokens: 100_000,
              outputTokens: 5_000,
              cachedInputTokens: 41_200,
              reasoningOutputTokens: 8_900,
              modelContextWindow: 200_000,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Cached and reasoning should be visible
    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(screen.getByText("41.2k")).toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("8.9k")).toBeInTheDocument();
  });

  it("hides cached and reasoning rows when zero", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            context_used_percent: 20,
            codex_token_details: {
              inputTokens: 10_000,
              outputTokens: 1_000,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 200_000,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Cached")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("uses server-computed context_used_percent, not local calculation", () => {
    // Scenario: inputTokens=289500, outputTokens=2100, contextWindow=258400
    // Naive local calc would give 112%, but server caps at 100
    // This verifies the UI uses the session's context_used_percent (capped at 100)
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            context_used_percent: 100,
            codex_token_details: {
              inputTokens: 289_500,
              outputTokens: 2_100,
              cachedInputTokens: 210_300,
              reasoningOutputTokens: 741,
              modelContextWindow: 258_400,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    // Should show 100%, not 112%
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("112%")).not.toBeInTheDocument();
  });

  it("hides context bar when modelContextWindow is 0", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            backend_type: "codex",
            context_used_percent: 0,
            codex_token_details: {
              inputTokens: 1_000,
              outputTokens: 500,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              modelContextWindow: 0,
            },
          },
        ],
      ]),
    });
    render(<CodexTokenDetailsSection sessionId="s1" />);
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
  });
});
