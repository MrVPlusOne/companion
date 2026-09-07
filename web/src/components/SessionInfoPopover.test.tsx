// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { api } from "../api.js";
import { sessionNavigationProjectionToSessionFields } from "../../shared/session-navigation-projection.js";
import { createSessionNavigationProjectionValue } from "../test-fixtures/session-navigation-projection.js";

type MockContextWindowDiagnostics = {
  role: "leader" | "non_leader";
  leaderMode?: "recycle" | "compact";
  capacitySource: "leader_recycle_guard" | "configured_usable_capacity" | "codex_config" | "codex_default";
  configuredUsableContextWindow?: number;
  displayContextWindow?: number;
  providerRawContextWindow?: number;
  catalogEffectiveContextWindowPercent?: number;
  providerEffectiveContextWindow?: number;
  autoCompactTokenLimit?: number;
  autoCompactTokenLimitScope?: "total" | "body_after_prefix";
  autoCompactTokenLimitScopeSource?: "configured" | "codex_default";
};

type MockLifecycleSnapshot = {
  contextTokensUsed?: number;
  providerReportedInputTokens?: number;
  providerReportedTotalTokens?: number;
  contextUsedPercent?: number;
  modelContextWindow?: number;
  autoCompactTokenLimit?: number;
  autoCompactTokenLimitScope?: "total" | "body_after_prefix";
  source: "compact_boundary" | "codex_token_details" | "codex_auto_compact_limit";
  capturedAt: number;
};

type MockLifecycleEvent = {
  type: "compaction";
  id: string;
  timestamp: number;
  backendType?: "claude" | "codex" | "claude-sdk";
  trigger?: "auto" | "manual";
  cause?: "unknown" | "context_pressure" | "manual" | "model_switch_migration";
  causeSource?: "producer" | "takode_manual_request" | "takode_model_switch_guard";
  contextWindowDiagnostics?: MockContextWindowDiagnostics;
  before?: MockLifecycleSnapshot;
  after?: MockLifecycleSnapshot;
  finishedAt?: number;
};

interface MockStoreState {
  sessions: Map<
    string,
    {
      session_id?: string;
      cwd?: string;
      model?: string;
      backend_type?: "claude" | "codex" | "claude-sdk";
      num_turns?: number;
      total_cost_usd?: number;
      context_used_percent?: number;
      message_history_bytes?: number;
      codex_retained_payload_bytes?: number;
      codex_token_details?: {
        modelContextWindow?: number;
        contextTokensUsed?: number;
        providerReportedTotalTokens?: number;
      };
      codex_max_context_length?: number | null;
      codexMaxContextLength?: number;
      codex_reasoning_effort?: string;
      codex_effective_reasoning_effort?: string | null;
      codex_effective_reasoning_effort_reported?: boolean;
      codex_leader_recycle_threshold_tokens?: number;
      codex_leader_compaction_mode?: "recycle" | "compact";
      codex_context_window_diagnostics?: MockContextWindowDiagnostics;
      codex_goal?: {
        threadId: string;
        objective: string;
        status: "active";
        tokenBudget: number | null;
        tokensUsed: number;
        timeUsedSeconds: number;
        createdAt: string | null;
        updatedAt: string | null;
      } | null;
      codex_goal_capability?: { state: "supported"; checkedAt: number; error: null };
      claude_token_details?: { modelContextWindow?: number };
      claude_max_context_length?: number | null;
      claudeMaxContextLength?: number | null;
      isOrchestrator?: boolean;
      lifecycle_events?: MockLifecycleEvent[];
      git_branch?: string | null;
      is_worktree?: boolean;
      git_ahead?: number;
      git_behind?: number;
      total_lines_added?: number;
      total_lines_removed?: number;
      repo_root?: string;
      backend_state?: string;
    }
  >;
  sdkSessions: Array<{
    sessionId: string;
    state?: "starting" | "connected" | "running" | "exited";
    pid?: number;
    cliSessionId?: string;
    cwd?: string;
    createdAt?: number;
    model?: string;
    permissionMode?: string;
    backendType?: "claude" | "codex" | "claude-sdk";
    cliConnected?: boolean;
    gitBranch?: string;
    gitDefaultBranch?: string;
    diffBaseBranch?: string;
    isWorktree?: boolean;
    repoRoot?: string;
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    contextUsedPercent?: number;
    contextTokensUsed?: number | null;
    modelContextWindow?: number | null;
    numTurns?: number;
    userTurnCount?: number;
    agentTurnCount?: number;
    messageHistoryBytes?: number;
    codexRetainedPayloadBytes?: number;
    codexTokenDetails?: {
      modelContextWindow?: number;
      contextTokensUsed?: number;
      providerReportedTotalTokens?: number;
    };
    codexMaxContextLength?: number | null;
    codexReasoningEffort?: string | null;
    codexEffectiveReasoningEffort?: string | null;
    codexEffectiveReasoningEffortReported?: boolean;
    codexLeaderRecycleThresholdTokens?: number;
    codexLeaderCompactionMode?: "recycle" | "compact";
    codexContextWindowDiagnostics?: MockContextWindowDiagnostics;
    claudeTokenDetails?: { modelContextWindow?: number };
    claudeMaxContextLength?: number | null;
    sessionLifecycleEvents?: MockLifecycleEvent[];
    codexLeaderRecycleLineage?: {
      cliSessionIds: string[];
      recycleEvents: Array<{
        trigger: "threshold" | "manual_compact" | "context_window_exhausted";
        requestedAt: number;
        tokenUsage?: { contextTokensUsed?: number };
      }>;
    };
    codexLeaderRecyclePending?: {
      eventIndex: number;
      trigger: "threshold" | "manual_compact" | "context_window_exhausted";
      requestedAt: number;
    } | null;
    sessionNum?: number | null;
    herdedBy?: string;
    isOrchestrator?: boolean;
    archived?: boolean;
    lastActivityAt?: number;
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
  }>;
  sessionTaskHistory: Map<string, Array<{ title: string; source?: "quest"; questId?: string }>>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  connectionStatus: Map<string, string>;
  cliConnected: Map<string, boolean>;
  cliEverConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | "recovery_suppressed" | null>;
  sessionStatus: Map<string, string | null>;
  pendingPermissions: Map<string, unknown>;
  askPermission: Map<string, unknown>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
  serverReachable: boolean;
  updateSdkSession: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function resetStore(taskHistory: Array<{ title: string; source?: "quest"; questId?: string }>) {
  storeState = {
    sessions: new Map([
      [
        "s1",
        {
          session_id: "s1",
          cwd: "/repo",
          model: "gpt-5.3-codex",
          backend_type: "codex",
          num_turns: 2,
          total_cost_usd: 0,
          context_used_percent: 0,
          git_branch: "jiayi",
          is_worktree: true,
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
          repo_root: "/repo",
        },
      ],
    ]),
    sdkSessions: [
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        model: "gpt-5.3-codex",
        permissionMode: "default",
        backendType: "codex",
        cliConnected: true,
        gitBranch: "jiayi",
        isWorktree: true,
        repoRoot: "/repo",
        gitAhead: 0,
        gitBehind: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        contextUsedPercent: 0,
        numTurns: 2,
      },
    ],
    sessionTaskHistory: new Map([["s1", taskHistory]]),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    connectionStatus: new Map([["s1", "connected"]]),
    cliConnected: new Map([["s1", true]]),
    cliEverConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map([["s1", null]]),
    sessionStatus: new Map(),
    pendingPermissions: new Map(),
    askPermission: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    serverReachable: true,
    updateSdkSession: vi.fn(),
  };
}

function updateCurrentSdkSession(patch: Partial<MockStoreState["sdkSessions"][number]>) {
  const session = storeState.sdkSessions.find((candidate) => candidate.sessionId === "s1");
  if (!session) throw new Error("missing session fixture");
  Object.assign(session, patch);
}

function setNavigationProjection(
  sessionId: string,
  value = createSessionNavigationProjectionValue({ identity: { sessionNum: null } }),
) {
  const existingIndex = storeState.sdkSessions.findIndex((session) => session.sessionId === sessionId);
  const existing = existingIndex >= 0 ? storeState.sdkSessions[existingIndex] : undefined;
  const session = {
    ...existing,
    ...sessionNavigationProjectionToSessionFields(value),
    sessionId,
  } as MockStoreState["sdkSessions"][number];
  if (existingIndex >= 0) storeState.sdkSessions[existingIndex] = session;
  else storeState.sdkSessions.push(session);
}

vi.mock("../store.js", () => ({
  countUserPermissions: () => 0,
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

vi.mock("./TaskPanel.js", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    GitHubPRSection: () => null,
    McpCollapsible: () => null,
    ClaudeMdCollapsible: () => <div data-testid="claude-md-section" />,
    CodexInstructionsCollapsible: ({
      snapshot,
      snapshotLoading,
      snapshotFailed,
      refreshKey,
    }: {
      snapshot?: { threadId?: string };
      snapshotLoading?: boolean;
      snapshotFailed?: boolean;
      refreshKey?: string;
    }) => (
      <div
        data-testid="codex-instructions-section"
        data-thread-id={snapshot?.threadId ?? ""}
        data-loading={snapshotLoading ? "true" : "false"}
        data-failed={snapshotFailed ? "true" : "false"}
        data-refresh-key={refreshKey ?? ""}
      />
    ),
    HerdDiagnosticsSection: () => null,
    SystemPromptCollapsible: ({ title = "System Prompt" }: { title?: string }) => (
      <div data-testid="system-prompt-section">{title}</div>
    ),
    SectionHeader: ({ title, collapsed, onToggle }: { title: string; collapsed: boolean; onToggle: () => void }) => (
      <button type="button" aria-expanded={!collapsed} onClick={onToggle}>
        {title}
      </button>
    ),
    usePersistedCollapse: (_key: string, defaultCollapsed = false) => {
      const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
      return [collapsed, () => setCollapsed((value) => !value)] as const;
    },
  };
});

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
    listSessions: vi.fn(),
    getSessionInfo: vi.fn(),
    openSessionDirectory: vi.fn(),
    relaunchSession: vi.fn(),
    updateLeaderProfilePortrait: vi.fn(),
  },
}));

import { SessionInfoPopover } from "./SessionInfoPopover.js";

const TAKO_PORTRAIT = {
  id: "tako1-01",
  poolId: "tako",
  label: "Tako 1.1",
  smallUrl: "/leader-profile-portraits/tako/tako1-01.v2.96.webp",
  largeUrl: "/leader-profile-portraits/tako/tako1-01.v2.320.webp",
  smallSize: 96,
  largeSize: 320,
  smallBytes: 2912,
  largeBytes: 19216,
};

describe("SessionInfoPopover", () => {
  beforeEach(() => {
    window.location.hash = "#/session/s1";
    vi.mocked(api.listSessions).mockReset();
    vi.mocked(api.listSessions).mockResolvedValue([]);
    vi.mocked(api.getSessionInfo).mockReset();
    vi.mocked(api.getSessionInfo).mockImplementation(
      async (sessionId) =>
        ({
          state: "connected",
          cwd: "/repo",
          createdAt: 1,
          ...storeState.sdkSessions.find((session) => session.sessionId === sessionId),
          sessionId,
        }) as Awaited<ReturnType<typeof api.getSessionInfo>>,
    );
    vi.mocked(api.openSessionDirectory).mockReset();
    vi.mocked(api.openSessionDirectory).mockResolvedValue({
      ok: true,
      absolutePath: "/repo",
      openedPath: "/repo",
      platform: "darwin",
    });
    vi.mocked(api.relaunchSession).mockReset();
    vi.mocked(api.relaunchSession).mockResolvedValue({} as Awaited<ReturnType<typeof api.relaunchSession>>);
    vi.mocked(api.updateLeaderProfilePortrait).mockReset();
  });

  it("anchors under the provided title-area affordance with viewport clamping", () => {
    resetStore([]);
    window.innerWidth = 430;
    window.innerHeight = 932;
    const anchor = {
      getBoundingClientRect: () =>
        ({
          left: 36,
          right: 240,
          top: 8,
          bottom: 42,
          width: 204,
          height: 34,
          x: 36,
          y: 8,
          toJSON: () => ({}),
        }) as DOMRect,
    } as HTMLElement;

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} anchorElement={anchor} />);

    const popover = screen.getByText("Session Info").parentElement?.parentElement as HTMLElement;
    expect(popover).toHaveStyle({ left: "28px", top: "50px", width: "390px" });
  });

  it("offers a Configure Session entry point", () => {
    resetStore([]);
    const onConfigure = vi.fn();

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} onConfigure={onConfigure} />);

    fireEvent.click(screen.getByTestId("session-info-configure-session"));
    expect(onConfigure).toHaveBeenCalledWith("s1");
  });

  it("renders Codex instruction sources instead of Claude files", async () => {
    resetStore([]);
    vi.mocked(api.getSessionInfo).mockResolvedValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      codexInstructionSnapshot: {
        threadId: "thread-snapshot",
        capturedAt: 1,
        lifecycle: "thread_start",
        instructionSourcesReported: true,
        instructionSources: [],
        configLayers: [],
        developerInstructionsConfigured: true,
      },
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(await screen.findByTestId("codex-instructions-section")).toHaveAttribute(
      "data-thread-id",
      "thread-snapshot",
    );
    expect(screen.queryByTestId("claude-md-section")).not.toBeInTheDocument();
    expect(screen.getByTestId("system-prompt-section")).toHaveTextContent("Developer Instructions");
  });

  it("shows instruction details as loading until the selected-session snapshot resolves", async () => {
    resetStore([]);
    let resolveDetail: ((detail: Awaited<ReturnType<typeof api.getSessionInfo>>) => void) | undefined;
    vi.mocked(api.getSessionInfo).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByTestId("codex-instructions-section")).toHaveAttribute("data-loading", "true");
    expect(screen.getByTestId("codex-instructions-section")).toHaveAttribute("data-thread-id", "");

    resolveDetail?.({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      codexInstructionSnapshot: {
        threadId: "thread-loaded",
        capturedAt: 1,
        lifecycle: "thread_start",
        instructionSourcesReported: true,
        instructionSources: [],
        configLayers: [],
        developerInstructionsConfigured: true,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("codex-instructions-section")).toHaveAttribute("data-thread-id", "thread-loaded"),
    );
    expect(screen.getByTestId("codex-instructions-section")).toHaveAttribute("data-loading", "false");
  });

  it("preserves the Claude instruction presentation", () => {
    resetStore([]);
    storeState.sessions.set("s1", { backend_type: "claude", cwd: "/repo" });
    storeState.sdkSessions = [
      { sessionId: "s1", state: "connected", cwd: "/repo", createdAt: 1, backendType: "claude" },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByTestId("claude-md-section")).toBeInTheDocument();
    expect(screen.getByTestId("system-prompt-section")).toHaveTextContent("System Prompt");
    expect(screen.queryByTestId("codex-instructions-section")).not.toBeInTheDocument();
  });

  it("does not render Codex Goal controls while preserving unrelated session details", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    // Keep an active server-authored Goal in the fixture so this regression
    // guard proves UI removal does not require clearing or hiding backend state.
    session.codex_goal = {
      threadId: "thread-active",
      objective: "Keep running safely",
      status: "active",
      tokenBudget: 120_000,
      tokensUsed: 34_200,
      timeUsedSeconds: 300,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:05:00.000Z",
    };
    session.codex_goal_capability = { state: "supported", checkedAt: Date.now(), error: null };

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} onConfigure={() => {}} />);

    expect(screen.queryByText("Codex Goal")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Codex Goal objective")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Codex Goal token budget")).not.toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Working Directory")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-configure-session")).toBeInTheDocument();
  });

  it("keeps one reasoning selector and warns compactly about a runtime mismatch", () => {
    // The editable Ultra setting remains the only ordinary value while the
    // Codex-reported High runtime state still produces a truthful diagnostic.
    resetStore([]);
    updateCurrentSdkSession({
      codexReasoningEffort: "ultra",
      codexEffectiveReasoningEffort: "high",
      codexEffectiveReasoningEffortReported: true,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const reasoning = screen.getByText("ultra").closest("button");
    expect(reasoning).toBeInTheDocument();
    expect(reasoning).toHaveAttribute("title", "Reasoning effort (relaunch required). Selected: Ultra; runtime: High");
    expect(screen.queryByText("Requested")).not.toBeInTheDocument();
    expect(screen.queryByText("Effective")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-info-reasoning-warning")).toHaveTextContent(
      "Runtime is using High instead of Ultra.",
    );
  });

  it("labels launch settings as applying on resume when backend is disconnected but Takode is reachable", () => {
    resetStore([]);
    updateCurrentSdkSession({ cliConnected: false });
    storeState.connectionStatus.set("s1", "connected");

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getAllByTitle("Applies on resume")[0]).toBeEnabled();
    const reasoning = screen.getByText("default").closest("button");
    expect(reasoning).toHaveAttribute("title", "Applies on resume. Selected: Default; runtime effort: not reported");
    expect(reasoning).toBeEnabled();
  });

  it("keeps the list portrait after session detail loads and opens profile editing from it", async () => {
    resetStore([]);
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: "/repo",
        backendType: "codex",
        isOrchestrator: true,
        leaderProfilePortrait: TAKO_PORTRAIT,
      },
    ];
    vi.mocked(api.getSessionInfo).mockResolvedValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      isOrchestrator: true,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    await waitFor(() => expect(api.getSessionInfo).toHaveBeenCalledWith("s1"));
    expect(screen.getByText("Leader profile")).toBeInTheDocument();
    const editButton = screen.getByRole("button", { name: "Edit leader profile picture" });
    fireEvent.click(editButton);

    expect(screen.getByRole("dialog", { name: "Leader profile" })).toBeInTheDocument();
    expect(screen.getAllByText("Tako 1.1")).toHaveLength(2);
    expect(screen.getByText("Tako")).toBeInTheDocument();
  });

  it("shows recoverable disconnected detail and manual resume in session info", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    storeState.sessions.set("s1", { ...(session ?? {}), backend_state: "connected" });
    updateCurrentSdkSession({ cliConnected: false });
    storeState.cliEverConnected = new Map([["s1", true]]);

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const detail = screen.getByTestId("session-info-recoverable-connection");
    expect(within(detail).getByText("Disconnected")).toBeInTheDocument();
    expect(detail).toHaveTextContent(
      "This session is offline. You can keep typing; Takode will reconnect when there is something to send.",
    );

    fireEvent.click(within(detail).getByRole("button", { name: "Reconnect now" }));
    expect(api.relaunchSession).toHaveBeenCalledWith("s1");
  });

  it("does not close when clicking inside the leader profile picker portal", () => {
    resetStore([]);
    const onClose = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);
      vi.runAllTimers();

      const pickerNode = document.createElement("div");
      pickerNode.setAttribute("data-leader-profile-portrait-picker", "true");
      document.body.appendChild(pickerNode);
      fireEvent.mouseDown(pickerNode);

      expect(onClose).not.toHaveBeenCalled();
      pickerNode.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates to questmaster focused quest when clicking a quest history row", () => {
    resetStore([
      { title: "Install ripgrep in agent environment", source: "quest", questId: "q-67" },
      { title: "Fix codex usage bars stuck at zero" },
    ]);
    const onClose = vi.fn();
    render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Install ripgrep in agent environment" }));

    expect(window.location.hash).toBe("#/questmaster?quest=q-67");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render quest history row as a link when questId is missing", () => {
    resetStore([{ title: "Quest without id", source: "quest" }]);
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "Quest without id" })).toBeNull();
    expect(screen.getByText("Quest without id")).toBeInTheDocument();
  });

  it("renders quest task rows without native hover tooltips", () => {
    resetStore([{ title: "Open q-42", source: "quest", questId: "q-42" }]);
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const questButton = screen.getByRole("button", { name: "Open q-42" });
    expect(questButton).not.toHaveAttribute("title");
  });

  it("keeps task history compact and auto-scrolls to newest task", async () => {
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(420);
    try {
      resetStore(Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i + 1}` })));
      render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

      const scroller = screen.getByTestId("task-history-scroll");
      expect(scroller).toHaveClass("max-h-40");
      expect(scroller).toHaveClass("overflow-y-auto");
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(420);
      });
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("does not close when clicking inside ClaudeMdEditor portal content", () => {
    resetStore([]);
    const onClose = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);
      vi.runAllTimers();

      const modalNode = document.createElement("div");
      modalNode.setAttribute("data-claude-md-editor-root", "true");
      document.body.appendChild(modalNode);
      fireEvent.mouseDown(modalNode);

      expect(onClose).not.toHaveBeenCalled();
      modalNode.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close when clicking inside SystemPromptModal portal content", () => {
    // System prompt modal is portaled to document.body, so clicks inside it
    // would normally trigger the popover's outside-click handler. The guard
    // for data-session-info-modal prevents this.
    resetStore([]);
    const onClose = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);
      vi.runAllTimers();

      const modalNode = document.createElement("div");
      modalNode.setAttribute("data-session-info-modal", "true");
      document.body.appendChild(modalNode);
      fireEvent.mouseDown(modalNode);

      expect(onClose).not.toHaveBeenCalled();
      modalNode.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses projected model, git, and detail stats ahead of stale selected-session fields", () => {
    resetStore([]);
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        identity: { model: "gpt-5.6" },
        git: { branch: "projected-branch", ahead: 3, linesAdded: 12 },
        detail: { userTurnCount: 8, contextUsedPercent: 37, messageHistoryBytes: 1_048_576 },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("gpt-5.6")).toBeInTheDocument();
    expect(screen.getByText("projected-branch")).toBeInTheDocument();
    expect(screen.getByText("8 turns")).toBeInTheDocument();
    expect(screen.getByText("37% context")).toBeInTheDocument();
    expect(screen.getByText("1.0 MB replay")).toBeInTheDocument();
    expect(screen.queryByText("jiayi")).toBeNull();
  });

  it("renders git branch and diff stats near the top below the path", () => {
    resetStore([{ title: "Task one" }]);
    updateCurrentSdkSession({
      gitBranch: "jiayi-wt-5788",
      isWorktree: true,
      gitAhead: 1,
      gitBehind: 5,
      totalLinesAdded: 69,
      totalLinesRemoved: 13,
    });
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const pathLine = screen.getByTitle("/repo");
    const branch = screen.getByText("jiayi-wt-5788");
    const tasksLabel = screen.getByText("Tasks");

    expect(branch.textContent).toContain("jiayi-wt-5788");
    expect(screen.getByText("1↑")).toBeInTheDocument();
    expect(screen.getByText("5↓")).toBeInTheDocument();
    expect(screen.getByText("+69")).toBeInTheDocument();
    expect(screen.getByText("-13")).toBeInTheDocument();
    expect(pathLine.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(branch.compareDocumentPosition(tasksLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows worktree and base repo paths separately with the trailing worktree segment emphasized", () => {
    resetStore([]);
    updateCurrentSdkSession({
      cwd: "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
      repoRoot: "/Users/test/Code/companion",
      isWorktree: true,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Base repo")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-path-worktree-tail")).toHaveTextContent("jiayi-wt-3116");
    expect(screen.getByTestId("session-info-path-repo-tail")).toHaveTextContent("companion");
    expect(screen.getByTitle("/Users/test/.companion/worktrees/companion/jiayi-wt-3116")).toBeInTheDocument();
    expect(screen.getByTitle("/Users/test/Code/companion")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-path-worktree-scroller")).toHaveClass("overflow-x-auto");
    expect(screen.getByTestId("session-info-path-worktree-tail")).toHaveTextContent(
      "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
    );
    expect(screen.getByRole("button", { name: "Copy Worktree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Base repo" })).toBeInTheDocument();
  });

  it("opens the session working directory through the system file browser", async () => {
    resetStore([]);
    updateCurrentSdkSession({
      cwd: "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
      repoRoot: "/Users/test/Code/companion",
      isWorktree: true,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const button = await screen.findByTestId("session-info-open-working-directory");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.openSessionDirectory).toHaveBeenCalledWith("s1", "working-directory");
    });
  });

  it("opens visible worktree and base repo directory rows through the system file browser", async () => {
    resetStore([]);
    updateCurrentSdkSession({
      cwd: "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
      repoRoot: "/Users/test/Code/companion",
      isWorktree: true,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Worktree" }));
    await waitFor(() => {
      expect(api.openSessionDirectory).toHaveBeenCalledWith("s1", "worktree");
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Base repo" }));
    await waitFor(() => {
      expect(api.openSessionDirectory).toHaveBeenCalledWith("s1", "base-repo");
    });
  });

  it("shows an inline error when the system file browser cannot open the working directory", async () => {
    resetStore([]);
    vi.mocked(api.openSessionDirectory).mockRejectedValue(new Error("Cannot open directory"));

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const button = await screen.findByTestId("session-info-open-working-directory");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    expect(await screen.findByTestId("session-info-open-directory-error")).toHaveTextContent("Cannot open directory");
  });

  it("shows concise herd relationship chips in the info panel", () => {
    resetStore([]);
    storeState.sdkSessions = [
      {
        sessionId: "leader-1",
        cwd: "/repo",
        backendType: "codex",
        sessionNum: 7,
        isOrchestrator: true,
      },
      {
        sessionId: "s1",
        cwd: "/repo/worker",
        backendType: "codex",
        sessionNum: 11,
        herdedBy: "leader-1",
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Herded by")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-herded-by")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#7" })).toBeInTheDocument();
  });

  it("shows concise herding chips for leader sessions in the info panel", () => {
    resetStore([]);
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: "/repo",
        backendType: "codex",
        sessionNum: 11,
        isOrchestrator: false,
      },
      {
        sessionId: "worker-1",
        cwd: "/repo/worktree-1",
        backendType: "codex",
        sessionNum: 21,
        herdedBy: "stale-leader",
      },
      {
        sessionId: "worker-2",
        cwd: "/repo/worktree-2",
        backendType: "claude",
        sessionNum: 22,
        herdedBy: "stale-leader",
      },
    ];
    storeState.sessionNames = new Map([
      ["worker-1", "Fix notification links"],
      ["worker-2", "Improve hover chips"],
    ]);
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({ identity: { sessionNum: 11 }, topology: { isOrchestrator: true } }),
    );
    setNavigationProjection(
      "worker-1",
      createSessionNavigationProjectionValue({ identity: { sessionNum: 21 }, topology: { herdedBy: "s1" } }),
    );
    setNavigationProjection(
      "worker-2",
      createSessionNavigationProjectionValue({ identity: { sessionNum: 22 }, topology: { herdedBy: "s1" } }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Herding")).toBeInTheDocument();
    const section = screen.getByTestId("session-info-herding");
    expect(within(section).getByRole("link", { name: "#21" })).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "#22" })).toBeInTheDocument();
    expect(within(section).queryByText("Fix notification links")).toBeNull();
    expect(within(section).queryByText("Improve hover chips")).toBeNull();
  });

  it("closes when herd relationship chips navigate", () => {
    resetStore([]);
    const onClose = vi.fn();
    storeState.sdkSessions = [
      {
        sessionId: "leader-1",
        cwd: "/repo",
        backendType: "codex",
        sessionNum: 7,
        isOrchestrator: true,
      },
      {
        sessionId: "s1",
        cwd: "/repo/worker",
        backendType: "codex",
        sessionNum: 11,
        herdedBy: "leader-1",
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);

    fireEvent.click(screen.getByRole("link", { name: "#7" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#/session/leader-1");
  });

  it("shows the max context window rounded to whole K tokens", () => {
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        detail: {
          userTurnCount: 2,
          contextUsedPercent: 73,
          modelContextWindow: 258_400,
          messageHistoryBytes: 1_572_864,
          codexRetainedPayloadBytes: 2_621_440,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB replay")).toBeInTheDocument();
    expect(screen.getByText("2.5 MB retained")).toBeInTheDocument();
    expect(screen.getByText(/258 K tokens/)).toBeInTheDocument();

    const contextRow = screen.getByTestId("session-context-stats");
    const payloadRow = screen.getByTestId("session-payload-stats");
    expect(within(contextRow).getByText("73% context")).toBeInTheDocument();
    expect(within(contextRow).getByText(/258 K tokens/)).toBeInTheDocument();
    expect(within(contextRow).queryByText("1.5 MB replay")).toBeNull();
    expect(within(payloadRow).getByText("2 turns")).toBeInTheDocument();
    expect(within(payloadRow).getByText("1.5 MB replay")).toBeInTheDocument();
    expect(within(payloadRow).getByText("2.5 MB retained")).toBeInTheDocument();
    expect(within(payloadRow).queryByText("73% context")).toBeNull();
    expect(within(payloadRow).queryByText(/258 K tokens/)).toBeNull();
  });

  it("uses the Codex leader recycle threshold as the effective context window", () => {
    updateCurrentSdkSession({ codexLeaderCompactionMode: "recycle" });
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        topology: { isOrchestrator: true },
        detail: {
          contextUsedPercent: 6,
          contextTokensUsed: 57_000,
          modelContextWindow: 950_000,
          codexLeaderRecycleThresholdTokens: 260_000,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("22% context")).toBeInTheDocument();
    expect(screen.getByText(/260 K tokens/)).toBeInTheDocument();
    expect(screen.queryByText("6% context")).toBeNull();
    expect(screen.queryByText("950 K tokens")).toBeNull();
  });

  it("ignores a stale recycle threshold for a Codex leader in compact mode", () => {
    updateCurrentSdkSession({ codexLeaderCompactionMode: "compact" });
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        topology: { isOrchestrator: true },
        detail: {
          contextUsedPercent: 55,
          contextTokensUsed: 423_969,
          modelContextWindow: 770_000,
          codexLeaderRecycleThresholdTokens: 545_000,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("55% context")).toBeInTheDocument();
    expect(screen.getByText("770 K tokens")).toBeInTheDocument();
    expect(screen.queryByText("78% context")).toBeNull();
    expect(screen.queryByText("545 K tokens")).toBeNull();
  });

  it("uses projected effective context as the Codex leader recycle threshold", () => {
    updateCurrentSdkSession({ codexLeaderCompactionMode: "recycle" });
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        topology: { isOrchestrator: true },
        detail: {
          contextUsedPercent: 6,
          contextTokensUsed: 57_000,
          modelContextWindow: 950_000,
          effectiveContextWindow: 260_000,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("22% context")).toBeInTheDocument();
    expect(screen.getByText(/260 K tokens/)).toBeInTheDocument();
    expect(screen.queryByText("6% context")).toBeNull();
    expect(screen.queryByText(/950 K tokens/)).toBeNull();
  });

  it("honors a projected recycle-threshold clear over stale SDK metadata", () => {
    updateCurrentSdkSession({
      isOrchestrator: true,
      codexLeaderRecycleThresholdTokens: 260_000,
      contextTokensUsed: 57_000,
      modelContextWindow: 950_000,
      codexLeaderCompactionMode: "recycle",
    });
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        topology: { isOrchestrator: true },
        detail: {
          contextUsedPercent: 6,
          contextTokensUsed: 57_000,
          modelContextWindow: 950_000,
          effectiveContextWindow: 950_000,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("6% context")).toBeInTheDocument();
    expect(screen.getByText(/950 K tokens/)).toBeInTheDocument();
    expect(screen.queryByText("22% context")).toBeNull();
    expect(screen.queryByText(/260 K tokens/)).toBeNull();
  });

  it("keeps non-leader Codex sessions on provider context metrics", () => {
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        detail: {
          contextUsedPercent: 6,
          contextTokensUsed: 57_000,
          modelContextWindow: 950_000,
          codexLeaderRecycleThresholdTokens: 260_000,
        },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("6% context")).toBeInTheDocument();
    expect(screen.getByText(/950 K tokens/)).toBeInTheDocument();
    expect(screen.queryByText("22% context")).toBeNull();
    expect(screen.queryByText("260 K tokens")).toBeNull();
  });

  it("keeps non-Codex sessions on history wording and hides retained payload", () => {
    setNavigationProjection(
      "s1",
      createSessionNavigationProjectionValue({
        identity: { backendType: "claude-sdk", model: "claude-sonnet-4-5" },
        detail: { contextUsedPercent: 41, modelContextWindow: 200_000, messageHistoryBytes: 972_800 },
      }),
    );

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("950 KB history")).toBeInTheDocument();
    expect(screen.queryByText(/retained/)).toBeNull();
  });

  it("uses current session-row metadata for context stats after restore", () => {
    resetStore([]);
    storeState.sessions = new Map();
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        backendType: "codex",
        contextUsedPercent: 73,
        modelContextWindow: 258_400,
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText(/258 K tokens/)).toBeInTheDocument();
  });

  it("shows effective Codex context primary and configured usable target secondarily after restore", () => {
    resetStore([]);
    storeState.sessions = new Map();
    storeState.sdkSessions = [
      {
        sessionId: "s31",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        backendType: "codex",
        numTurns: 12,
        messageHistoryBytes: 1_572_864,
        codexRetainedPayloadBytes: 2_621_440,
        contextUsedPercent: 7,
        codexMaxContextLength: 600_000,
        modelContextWindow: 258_400,
      },
    ];

    render(<SessionInfoPopover sessionId="s31" onClose={() => {}} />);

    expect(screen.getByText("7% context")).toBeInTheDocument();
    expect(screen.getByText(/258 K tokens/)).toHaveAttribute(
      "title",
      "Backend reported usable context window. Configured usable target is 600 K tokens.",
    );
    expect(screen.getByText(/600 K tokens/)).toBeInTheDocument();

    const contextRow = screen.getByTestId("session-context-stats");
    const payloadRow = screen.getByTestId("session-payload-stats");
    expect(within(contextRow).getByText("7% context")).toBeInTheDocument();
    expect(within(contextRow).getByText("258 K tokens")).toBeInTheDocument();
    expect(within(contextRow).getByText("600 K tokens")).toBeInTheDocument();
    expect(within(contextRow).getByText("target")).toBeInTheDocument();
    expect(within(contextRow).queryByText("1.5 MB replay")).toBeNull();
    expect(within(payloadRow).getByText("12 turns")).toBeInTheDocument();
    expect(within(payloadRow).getByText("1.5 MB replay")).toBeInTheDocument();
    expect(within(payloadRow).getByText("2.5 MB retained")).toBeInTheDocument();
    expect(within(payloadRow).queryByText("7% context")).toBeNull();
    expect(within(payloadRow).queryByText("600 K tokens")).toBeNull();
    expect(within(payloadRow).queryByText("target")).toBeNull();
  });

  it("uses current session-row recycle metadata for restored Codex leaders", () => {
    resetStore([]);
    storeState.sessions = new Map();
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        backendType: "codex",
        isOrchestrator: true,
        contextUsedPercent: 6,
        contextTokensUsed: 57_000,
        modelContextWindow: 950_000,
        codexLeaderRecycleThresholdTokens: 260_000,
        codexLeaderCompactionMode: "recycle",
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("22% context")).toBeInTheDocument();
    expect(screen.getByText("260 K tokens")).toBeInTheDocument();
    expect(screen.queryByText("950 K tokens")).toBeNull();
  });

  it("loads bounded context diagnostics only for the selected Session Info popover", async () => {
    resetStore([]);
    vi.mocked(api.getSessionInfo).mockResolvedValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      codexContextWindowDiagnostics: {
        role: "non_leader",
        capacitySource: "configured_usable_capacity",
        configuredUsableContextWindow: 770_000,
        displayContextWindow: 770_000,
        providerRawContextWindow: 810_527,
        catalogEffectiveContextWindowPercent: 95,
        providerEffectiveContextWindow: 770_000,
        autoCompactTokenLimit: 693_000,
        autoCompactTokenLimitScope: "total",
        autoCompactTokenLimitScopeSource: "codex_default",
      },
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(api.getSessionInfo).toHaveBeenCalledTimes(1);
    expect(api.getSessionInfo).toHaveBeenCalledWith("s1");
    const section = await screen.findByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    const diagnostics = within(section).getByTestId("codex-context-diagnostics");
    expect(within(diagnostics).getByText("Non-leader · Configured capacity")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Configured usable target")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Provider effective window")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Displayed denominator")).toBeInTheDocument();
    expect(within(diagnostics).getByText("Provider launch window")).toBeInTheDocument();
    expect(within(diagnostics).getByText("693K · total (Codex default)")).toBeInTheDocument();
    expect(diagnostics).toHaveTextContent("95% · reserve 5%");
    expect(diagnostics).toHaveTextContent("Launch/config provenance; not an event-time active-context measurement.");
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("shows Codex leader recycle lineage and pending recycle state", () => {
    resetStore([]);
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: "/repo",
        backendType: "codex",
        isOrchestrator: true,
        codexLeaderRecyclePending: {
          eventIndex: 1,
          trigger: "manual_compact",
          requestedAt: 1_746_000_000_000,
        },
        codexLeaderRecycleLineage: {
          cliSessionIds: ["thread-a", "thread-b"],
          recycleEvents: [
            {
              trigger: "threshold",
              requestedAt: 1_745_999_000_000,
              tokenUsage: { contextTokensUsed: 270_000 },
            },
            {
              trigger: "manual_compact",
              requestedAt: 1_746_000_000_000,
              tokenUsage: { contextTokensUsed: 180_000 },
            },
          ],
        },
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const section = screen.getByTestId("session-lifecycle-debug");
    expect(within(section).getByRole("button", { name: "Session Lifecycle" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(section).queryByText("Pending manual /compact recycle")).not.toBeInTheDocument();

    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText("Pending manual /compact recycle")).toBeInTheDocument();
    expect(within(section).getByText("thread-a")).toBeInTheDocument();
    expect(within(section).getByText("thread-b")).toBeInTheDocument();
    expect(within(section).getByText("Threshold recycle")).toBeInTheDocument();
    expect(within(section).getByText("Manual /compact recycle")).toBeInTheDocument();
    expect(within(section).getByText(/270K context/)).toBeInTheDocument();
    expect(within(section).getByText(/180K context/)).toBeInTheDocument();
  });

  it("loads Codex leader recycle lineage from selected-session detail", async () => {
    resetStore([]);
    updateCurrentSdkSession({ isOrchestrator: true });
    vi.mocked(api.getSessionInfo).mockResolvedValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      backendType: "codex",
      isOrchestrator: true,
      codexLeaderRecycleLineage: {
        cliSessionIds: ["thread-a", "thread-b"],
        recycleEvents: [
          {
            trigger: "manual_compact",
            requestedAt: 1_746_000_000_000,
            tokenUsage: { contextTokensUsed: 180_000 },
          },
        ],
      },
      codexLeaderRecyclePending: null,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(api.getSessionInfo).toHaveBeenCalledWith("s1");
    const section = await screen.findByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText("thread-a")).toBeInTheDocument();
    expect(within(section).getByText("thread-b")).toBeInTheDocument();
    expect(within(section).getByText("Manual /compact recycle")).toBeInTheDocument();
    expect(within(section).getByText(/180K context/)).toBeInTheDocument();
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("renders legacy Codex compactions as cause-unknown without inventing active context", () => {
    resetStore([]);
    updateCurrentSdkSession({
      sessionLifecycleEvents: [
        {
          type: "compaction",
          id: "compact-boundary-1",
          timestamp: 1_746_000_000_000,
          backendType: "claude",
          trigger: "auto",
          before: {
            contextTokensUsed: 180_000,
            contextUsedPercent: 90,
            source: "compact_boundary",
            capturedAt: 1_746_000_000_000,
          },
        },
        {
          type: "compaction",
          id: "compact-boundary-2",
          timestamp: 1_746_000_100_000,
          backendType: "codex",
          before: {
            contextTokensUsed: 270_000,
            source: "codex_token_details",
            capturedAt: 1_746_000_100_000,
          },
          after: {
            contextTokensUsed: 95_000,
            source: "codex_token_details",
            capturedAt: 1_746_000_110_000,
          },
        },
      ],
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const section = screen.getByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText("Claude compaction · auto")).toBeInTheDocument();
    expect(within(section).getByText("Before 180K context (90%)")).toBeInTheDocument();
    expect(within(section).getAllByText("After unknown")).toHaveLength(1);
    expect(within(section).getByText("Codex compaction · automatic cause unknown")).toBeInTheDocument();
    expect(within(section).getByText("Provider input 270K")).toBeInTheDocument();
    expect(within(section).getByText("Provider last total unknown")).toBeInTheDocument();
    expect(
      within(section).getByText("Exact active context and trigger cause unavailable from Codex app-server"),
    ).toBeInTheDocument();
    expect(within(section).getByText("After provider input 95K")).toBeInTheDocument();
    expect(within(section).queryByText(/Charged context/)).toBeNull();
  });

  it("does not repeat a legacy configured-limit lower bound as measured charge", () => {
    resetStore([]);
    updateCurrentSdkSession({
      sessionLifecycleEvents: [
        {
          type: "compaction",
          id: "compact-pressure-legacy",
          timestamp: 1_777_500_000_000,
          backendType: "codex",
          trigger: "auto",
          cause: "context_pressure",
          before: {
            contextTokensUsed: 693_000,
            providerReportedInputTokens: 423_969,
            providerReportedTotalTokens: 430_000,
            contextUsedPercent: 90,
            modelContextWindow: 770_000,
            autoCompactTokenLimit: 693_000,
            autoCompactTokenLimitScope: "total",
            source: "codex_auto_compact_limit",
            capturedAt: 1_777_500_000_000,
          },
          after: {
            contextTokensUsed: 55_000,
            providerReportedInputTokens: 54_440,
            providerReportedTotalTokens: 55_000,
            contextUsedPercent: 7,
            modelContextWindow: 770_000,
            source: "codex_token_details",
            capturedAt: 1_777_500_010_000,
          },
        },
      ],
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const section = screen.getByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText("Codex compaction · automatic cause unknown")).toBeInTheDocument();
    expect(within(section).getByText("Provider input 424K / 770K (55%)")).toBeInTheDocument();
    expect(within(section).getByText("Provider last total 430K / 770K (56%)")).toBeInTheDocument();
    expect(
      within(section).getByText("Exact active context and trigger cause unavailable from Codex app-server"),
    ).toBeInTheDocument();
    expect(within(section).getByText("After provider last total 55K / 770K (7%)")).toBeInTheDocument();
    expect(within(section).queryByText(/Charged context/)).toBeNull();
  });

  it("shows a producer-proven pressure cause without inventing its active token count", () => {
    resetStore([]);
    updateCurrentSdkSession({
      sessionLifecycleEvents: [
        {
          type: "compaction",
          id: "compact-pressure-proven",
          timestamp: 1_777_500_000_000,
          backendType: "codex",
          trigger: "auto",
          cause: "context_pressure",
          causeSource: "producer",
          before: {
            contextTokensUsed: 430_000,
            providerReportedInputTokens: 423_969,
            providerReportedTotalTokens: 430_000,
            contextUsedPercent: 56,
            modelContextWindow: 770_000,
            autoCompactTokenLimit: 693_000,
            autoCompactTokenLimitScope: "total",
            source: "codex_token_details",
            capturedAt: 1_777_500_000_000,
          },
        },
      ],
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const section = screen.getByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText("Codex compaction · context pressure")).toBeInTheDocument();
    expect(within(section).getByText("Provider last total 430K / 770K (56%)")).toBeInTheDocument();
    expect(within(section).getByText("Exact active context unavailable from Codex app-server")).toBeInTheDocument();
    expect(within(section).queryByText(/Charged context/)).toBeNull();
  });

  it.each([
    ["manual", "takode_manual_request", "Codex compaction · manual request"],
    [
      "model_switch_migration",
      "takode_model_switch_guard",
      "Codex compaction · model switch migration (Takode inferred)",
    ],
  ] as const)("keeps %s classification separate from active-context accounting", (cause, causeSource, title) => {
    resetStore([]);
    updateCurrentSdkSession({
      sessionLifecycleEvents: [
        {
          type: "compaction",
          id: `compact-${cause}`,
          timestamp: 1_777_500_000_000,
          backendType: "codex",
          trigger: cause === "manual" ? "manual" : "auto",
          cause,
          causeSource,
          before: {
            contextTokensUsed: 15_000,
            providerReportedInputTokens: 14_000,
            providerReportedTotalTokens: 15_000,
            contextUsedPercent: 2,
            modelContextWindow: 650_000,
            autoCompactTokenLimit: 585_000,
            source: "codex_token_details",
            capturedAt: 1_777_500_000_000,
          },
        },
      ],
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const section = screen.getByTestId("session-lifecycle-debug");
    fireEvent.click(within(section).getByRole("button", { name: "Session Lifecycle" }));

    expect(within(section).getByText(title)).toBeInTheDocument();
    expect(within(section).getByText("Provider input 14K / 650K (2%)")).toBeInTheDocument();
    expect(within(section).getByText("Provider last total 15K / 650K (2%)")).toBeInTheDocument();
    expect(within(section).getByText("Exact active context unavailable from Codex app-server")).toBeInTheDocument();
    expect(within(section).queryByText(/Charged context/)).toBeNull();
  });

  it("shows turns, context, and context window for Claude SDK sessions (no cost)", () => {
    resetStore([]);
    updateCurrentSdkSession({
      backendType: "claude-sdk",
      numTurns: 7,
      contextUsedPercent: 41,
      modelContextWindow: 200_000,
    });

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("41% context")).toBeInTheDocument();
    expect(screen.getByText("200 K tokens")).toBeInTheDocument();
    // Turns now shown for all backends
    expect(screen.getByText("7 turns")).toBeInTheDocument();
    // Cost is never shown
    expect(screen.queryByText("$1.25")).toBeNull();
  });
});
