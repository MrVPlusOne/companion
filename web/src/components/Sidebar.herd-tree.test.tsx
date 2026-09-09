// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { SESSION_ATTENTION_PROJECTION } from "../../shared/session-attention-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import type { SessionState, SdkSessionInfo } from "../types.js";
import { createSessionAttentionProjectionDefinition } from "../../server/session-attention-projection.js";

const mockConnectSession = vi.fn();
const mockConnectAllSessions = vi.fn();
const mockDisconnectSession = vi.fn();
const mockScrollIntoView = vi.fn();
const dndKitMockState = vi.hoisted(() => ({
  dndContexts: [] as Array<{ onDragEnd?: (event: unknown) => void }>,
  invalidSortableIds: [] as Array<{ id: string; items: string[] }>,
}));

vi.mock("../ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
  connectAllSessions: (...args: unknown[]) => mockConnectAllSessions(...args),
  disconnectSession: (...args: unknown[]) => mockDisconnectSession(...args),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd?: (event: unknown) => void }) => {
    dndKitMockState.dndContexts.push({ onDragEnd });
    return children;
  },
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn((sensor, options) => ({ sensor, options })),
  useSensors: vi.fn((...sensors) => sensors),
}));

vi.mock("@dnd-kit/sortable", async () => {
  const React = await import("react");
  const SortableItemsContext = React.createContext<string[]>([]);
  return {
    SortableContext: ({ children, items }: { children: ReactNode; items: Array<string | number> }) =>
      React.createElement(SortableItemsContext.Provider, { value: items.map((item) => String(item)) }, children),
    verticalListSortingStrategy: {},
    useSortable: ({ id, disabled }: { id: string | number; disabled?: boolean }) => {
      const items = React.useContext(SortableItemsContext);
      const stringId = String(id);
      if (!disabled && !items.includes(stringId)) dndKitMockState.invalidSortableIds.push({ id: stringId, items });
      return {
        attributes: { "data-sortable-id": stringId },
        listeners: { onPointerDown: vi.fn() },
        setNodeRef: vi.fn(),
        transform: null,
        transition: undefined,
        isDragging: false,
      };
    },
    arrayMove: <T,>(array: T[], from: number, to: number) => {
      const next = array.slice();
      const [item] = next.splice(from, 1);
      if (item !== undefined) next.splice(to, 0, item);
      return next;
    },
  };
});

vi.mock("../utils/pending-creation.js", () => ({
  cancelPendingCreation: vi.fn(),
}));

const mockApi = {
  listSessions: vi.fn().mockResolvedValue([]),
  listArchivedSessionsPage: vi.fn().mockResolvedValue({
    sessions: [],
    total: 0,
    offset: 0,
    limit: 25,
    hasMore: false,
    nextOffset: null,
  }),
  getArchivedSessionsSummary: vi.fn().mockResolvedValue({ total: 0 }),
  searchSessions: vi.fn().mockResolvedValue({ query: "", tookMs: 0, totalMatches: 0, results: [] }),
  deleteSession: vi.fn().mockResolvedValue({}),
  archiveSession: vi.fn().mockResolvedValue({}),
  archiveGroup: vi.fn().mockResolvedValue({ ok: true, archived: 1, failed: 0 }),
  unarchiveSession: vi.fn().mockResolvedValue({}),
  createTreeGroup: vi.fn().mockResolvedValue({ ok: true, group: { id: "group-2", name: "Session Space 2" } }),
  assignSessionToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
  assignSessionsToTreeGroup: vi.fn().mockResolvedValue({ ok: true }),
  updateTreeGroups: vi.fn().mockResolvedValue({ ok: true }),
  updateTreeNodeOrder: vi.fn().mockResolvedValue({ ok: true }),
  herdWorkerToLeader: vi
    .fn()
    .mockResolvedValue({ herded: ["worker-1"], notFound: [], conflicts: [], reassigned: [], leaders: [] }),
  refreshSessionGitStatus: vi.fn().mockResolvedValue({ ok: true }),
  getSettings: vi.fn().mockResolvedValue({ serverName: "" }),
  updateSettings: vi.fn().mockResolvedValue({}),
  getTreeGroups: vi
    .fn()
    .mockResolvedValue({ groups: [{ id: "default", name: "Default" }], assignments: {}, nodeOrder: {} }),
};

vi.mock("../api.js", () => ({
  api: {
    listSessions: (...args: unknown[]) => mockApi.listSessions(...args),
    listArchivedSessionsPage: (...args: unknown[]) => mockApi.listArchivedSessionsPage(...args),
    getArchivedSessionsSummary: (...args: unknown[]) => mockApi.getArchivedSessionsSummary(...args),
    searchSessions: (...args: unknown[]) => mockApi.searchSessions(...args),
    deleteSession: (...args: unknown[]) => mockApi.deleteSession(...args),
    archiveSession: (...args: unknown[]) => mockApi.archiveSession(...args),
    archiveGroup: (...args: unknown[]) => mockApi.archiveGroup(...args),
    unarchiveSession: (...args: unknown[]) => mockApi.unarchiveSession(...args),
    createTreeGroup: (...args: unknown[]) => mockApi.createTreeGroup(...args),
    assignSessionToTreeGroup: (...args: unknown[]) => mockApi.assignSessionToTreeGroup(...args),
    assignSessionsToTreeGroup: (...args: unknown[]) => mockApi.assignSessionsToTreeGroup(...args),
    updateTreeGroups: (...args: unknown[]) => mockApi.updateTreeGroups(...args),
    updateTreeNodeOrder: (...args: unknown[]) => mockApi.updateTreeNodeOrder(...args),
    herdWorkerToLeader: (...args: unknown[]) => mockApi.herdWorkerToLeader(...args),
    refreshSessionGitStatus: (...args: unknown[]) => mockApi.refreshSessionGitStatus(...args),
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getTreeGroups: (...args: unknown[]) => mockApi.getTreeGroups(...args),
  },
}));

vi.mock("../utils/copy-utils.js", () => ({
  writeClipboardText: vi.fn().mockResolvedValue(undefined),
}));

interface MockStoreState {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  currentSessionId: string | null;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  sessionPreviewUpdatedAt: Map<string, number>;
  sessionTaskPreview: Map<string, string>;
  sessionTaskHistory: Map<string, Array<{ title: string; action: string; timestamp: number }>>;
  sessionKeywords: Map<string, string[]>;
  sessionNotifications: Map<string, Array<unknown>>;
  recentlyRenamed: Set<string>;
  questNamedSessions: Set<string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionVersions: Map<string, { generation: string; revision: number }>;
  syncedProjectionKeys: Set<string>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  shortcutSettings: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  searchPreviewSessionId: string | null;
  sessionInfoOpenSessionId: string | null;
  reorderMode: boolean;
  sessionSortMode: "created" | "activity";
  setReorderMode: ReturnType<typeof vi.fn>;
  pendingSessions: Map<string, unknown>;
  serverName: string;
  treeGroups: Array<{ id: string; name: string }>;
  treeAssignments: Map<string, string>;
  treeNodeOrder: Map<string, string[]>;
  collapsedTreeGroups: Set<string>;
  collapsedTreeNodes: Set<string>;
  expandedHerdNodes: Set<string>;
  toggleTreeGroupCollapse: ReturnType<typeof vi.fn>;
  toggleTreeNodeCollapse: ReturnType<typeof vi.fn>;
  toggleHerdNodeExpand: ReturnType<typeof vi.fn>;
  setServerName: ReturnType<typeof vi.fn>;
  setSearchPreviewSessionId: ReturnType<typeof vi.fn>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  removeSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionName: ReturnType<typeof vi.fn>;
  setSessionPreview: ReturnType<typeof vi.fn>;
  setSessionTaskHistory: ReturnType<typeof vi.fn>;
  setSessionKeywords: ReturnType<typeof vi.fn>;
  markRecentlyRenamed: ReturnType<typeof vi.fn>;
  clearRecentlyRenamed: ReturnType<typeof vi.fn>;
  setSdkSessions: ReturnType<typeof vi.fn>;
  closeTerminal: ReturnType<typeof vi.fn>;
  openNewSessionModal: ReturnType<typeof vi.fn>;
  closeNewSessionModal: ReturnType<typeof vi.fn>;
  markSessionViewed: ReturnType<typeof vi.fn>;
  markAllSessionsViewed: ReturnType<typeof vi.fn>;
  markSessionUnread: ReturnType<typeof vi.fn>;
  clearSessionAttention: ReturnType<typeof vi.fn>;
  setTreeGroups: ReturnType<typeof vi.fn>;
  focusComposer: ReturnType<typeof vi.fn>;
}

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "claude-sonnet-4-5-20250929",
    cwd: "/home/user/projects/myapp",
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/home/user/projects/myapp",
    createdAt: Date.now(),
    archived: false,
    ...overrides,
  };
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    sessions: new Map(),
    sdkSessions: [],
    currentSessionId: null,
    cliConnected: new Map(),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map(),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    sessionPreviewUpdatedAt: new Map(),
    sessionTaskPreview: new Map(),
    sessionTaskHistory: new Map(),
    sessionKeywords: new Map(),
    sessionNotifications: new Map(),
    recentlyRenamed: new Set(),
    questNamedSessions: new Set(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionVersions: new Map(),
    syncedProjectionKeys: new Set(),
    diffFileStats: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    searchPreviewSessionId: null,
    sessionInfoOpenSessionId: null,
    reorderMode: false,
    sessionSortMode: "created",
    setReorderMode: vi.fn(),
    pendingSessions: new Map(),
    serverName: "",
    treeGroups: [],
    treeAssignments: new Map(),
    treeNodeOrder: new Map(),
    collapsedTreeGroups: new Set(),
    collapsedTreeNodes: new Set(),
    expandedHerdNodes: new Set(),
    toggleTreeGroupCollapse: vi.fn(),
    toggleTreeNodeCollapse: vi.fn(),
    toggleHerdNodeExpand: vi.fn(),
    setServerName: vi.fn(),
    setSearchPreviewSessionId: vi.fn(),
    setCurrentSession: vi.fn(),
    removeSession: vi.fn(),
    newSession: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSessionName: vi.fn(),
    setSessionPreview: vi.fn(),
    setSessionTaskHistory: vi.fn(),
    setSessionKeywords: vi.fn(),
    markRecentlyRenamed: vi.fn(),
    clearRecentlyRenamed: vi.fn(),
    setSdkSessions: vi.fn(),
    closeTerminal: vi.fn(),
    openNewSessionModal: vi.fn(),
    closeNewSessionModal: vi.fn(),
    markSessionViewed: vi.fn(),
    markAllSessionsViewed: vi.fn(),
    markSessionUnread: vi.fn(),
    clearSessionAttention: vi.fn(),
    setTreeGroups: vi.fn(),
    focusComposer: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  const countUserPermissions = (perms: Map<string, unknown> | undefined): number => perms?.size ?? 0;
  return {
    useStore: useStoreFn,
    countUserPermissions,
    hydrateChatDisplaySettingsFromServer: vi.fn(),
    hydrateShortcutSettingsFromServer: vi.fn().mockResolvedValue(undefined),
  };
});

import { Sidebar } from "./Sidebar.js";
import { resetSessionGitStatusAutoRefreshForTest } from "../utils/session-git-status-auto-refresh.js";

beforeEach(() => {
  vi.clearAllMocks();
  dndKitMockState.dndContexts.length = 0;
  dndKitMockState.invalidSortableIds.length = 0;
  resetSessionGitStatusAutoRefreshForTest();
  mockApi.refreshSessionGitStatus.mockResolvedValue({ ok: true });
  mockApi.getSettings.mockResolvedValue({ serverName: "" });
  localStorage.clear();
  vi.stubGlobal("alert", vi.fn());
  Element.prototype.scrollIntoView = mockScrollIntoView;
  mockState = createMockState();
  window.location.hash = "";
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("Sidebar herd tree behavior", { timeout: 10000 }, () => {
  it("uses the post-bootstrap server scope for sidebar group visible limits", async () => {
    localStorage.setItem("cc-server-id", "server-a");
    localStorage.setItem("server-a:cc-sidebar-group-visible-limits", '{"default":5}');
    localStorage.setItem("server-b:cc-sidebar-group-visible-limits", '{"default":20}');
    mockApi.getSettings.mockResolvedValue({ serverName: "", serverId: "server-b" });
    const sessionIds = Array.from({ length: 12 }, (_, index) => `session-${index + 1}`);
    mockState = createMockState({
      sessions: new Map(sessionIds.map((id) => [id, makeSession(id, { model: id })])),
      sdkSessions: sessionIds.map((id, index) =>
        makeSdkSession(id, { name: id, model: id, sessionNum: index + 1, createdAt: index + 1 }),
      ),
      sessionNames: new Map(sessionIds.map((id) => [id, id])),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(sessionIds.map((id) => [id, "default"])),
    });

    render(<Sidebar />);

    await waitFor(() => expect(localStorage.getItem("cc-server-id")).toBe("server-b"));
    await waitFor(() => expect(screen.getByText("session-12")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Show \d+ more sessions in Default/ })).not.toBeInTheDocument();
  });

  it("names the sidebar search clear button for assistive technology", () => {
    mockState = createMockState({
      sessions: new Map([["search-session", makeSession("search-session", { model: "search-model" })]]),
      sdkSessions: [makeSdkSession("search-session", { name: "Searchable Session", sessionNum: 91, createdAt: 100 })],
      sessionNames: new Map([["search-session", "Searchable Session"]]),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map([["search-session", "default"]]),
    });

    render(<Sidebar />);
    fireEvent.change(screen.getByTitle("Search sessions"), { target: { value: "Searchable" } });

    expect(screen.getByRole("button", { name: "Clear session search" })).toBeInTheDocument();
  });

  it("keeps legacy search-result attention ahead of a scheduled timer", async () => {
    const sessionId = "legacy-search-attention";
    mockState = createMockState({
      sessions: new Map([[sessionId, makeSession(sessionId, { model: "search-attention-model" })]]),
      sdkSessions: [
        makeSdkSession(sessionId, {
          name: "Legacy Search Attention",
          sessionNum: 92,
          createdAt: 100,
          cliConnected: true,
          pendingTimerCount: 1,
        }),
      ],
      sessionNames: new Map([[sessionId, "Legacy Search Attention"]]),
      sessionAttention: new Map([[sessionId, "error"]]),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map([[sessionId, "default"]]),
    });

    mockApi.searchSessions.mockResolvedValueOnce({
      query: "Legacy Search",
      tookMs: 1,
      totalMatches: 1,
      results: [
        {
          sessionId,
          score: 100,
          matchedField: "name",
          matchContext: "name: Legacy Search Attention",
          matchedAt: 100,
        },
      ],
    });

    render(<Sidebar />);
    fireEvent.change(screen.getByTitle("Search sessions"), { target: { value: "Legacy Search" } });

    const row = (await screen.findAllByText("Legacy Search Attention"))[0]!.closest("button")!;
    expect(within(row).getByTestId("session-status-stripe")).toHaveAttribute("data-status", "completed_unread");
    expect(within(row).queryByTestId("session-status-timer-icon")).not.toBeInTheDocument();
  });

  it("keeps legacy cron-row attention ahead of a scheduled timer", async () => {
    const sessionId = "legacy-cron-attention";
    mockState = createMockState({
      sessions: new Map([[sessionId, makeSession(sessionId, { model: "cron-attention-model" })]]),
      sdkSessions: [
        makeSdkSession(sessionId, {
          name: "Legacy Cron Attention",
          sessionNum: 93,
          createdAt: 100,
          cliConnected: true,
          cronJobId: "cron-job-1",
          cronJobName: "Attention cron",
          pendingTimerCount: 1,
        }),
      ],
      sessionNames: new Map([[sessionId, "Legacy Cron Attention"]]),
      sessionAttention: new Map([[sessionId, "review"]]),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map([[sessionId, "default"]]),
    });

    render(<Sidebar />);
    if (!screen.queryByText("Legacy Cron Attention")) {
      fireEvent.click(screen.getByRole("button", { name: /Scheduled Runs \(1\)/ }));
    }

    const row = (await screen.findByText("Legacy Cron Attention")).closest("button")!;
    expect(within(row).getByTestId("session-status-stripe")).toHaveAttribute("data-status", "completed_unread");
    expect(within(row).queryByTestId("session-status-timer-icon")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
  });

  it("keeps a projected timer-backed unread session row consistent with its group and hover counts", async () => {
    // Model the post-session-list state: the synchronized projection owns the
    // row, group, and hover while conflicting legacy summary/inbox inputs are
    // retained only as fallback. This catches a dropped Sidebar-to-tree
    // authority handoff, the exact failure class behind q-1978.
    const sessionId = "unread-timer-leader";
    const projectionEntryId = syncedProjectionEntryId(SESSION_ATTENTION_PROJECTION, sessionId);
    const projectionValue = {
      attentionReason: "review" as const,
      status: { urgency: "review" as const, count: 3 },
    };
    const projectionEnvelope = {
      type: "synced_projection_snapshot" as const,
      projection: SESSION_ATTENTION_PROJECTION,
      key: sessionId,
      generation: "sidebar-regression-generation",
      revision: 7,
      value: projectionValue,
    };
    mockState = createMockState({
      sessions: new Map([[sessionId, makeSession(sessionId, { model: "unread-timer-model" })]]),
      sdkSessions: [
        makeSdkSession(sessionId, {
          name: "Unread Timer Leader",
          isOrchestrator: true,
          sessionNum: 2522,
          cliConnected: true,
          pendingTimerCount: 1,
          // A fresh legacy clear plus stale full-inbox input must not override
          // the installed projection authority.
          notificationUrgency: null,
          activeNotificationCount: 0,
          activeReviewNotificationCount: 0,
          notificationStatusVersion: 12,
          notificationStatusUpdatedAt: 12_000,
          sessionAttentionProjection: projectionEnvelope,
        }),
      ],
      sessionNames: new Map([[sessionId, "Unread Timer Leader"]]),
      sessionAttention: new Map([[sessionId, "review"]]),
      syncedProjectionValues: new Map([[projectionEntryId, projectionValue]]),
      syncedProjectionVersions: new Map([
        [projectionEntryId, { generation: projectionEnvelope.generation, revision: projectionEnvelope.revision }],
      ]),
      syncedProjectionKeys: new Set([projectionEntryId]),
      sessionNotifications: new Map([
        [
          sessionId,
          [
            {
              id: "stale-legacy-input",
              category: "needs-input",
              summary: "Stale legacy input",
              timestamp: 1,
              done: false,
              messageId: null,
            },
          ],
        ],
      ]),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map([[sessionId, "default"]]),
    });

    render(<Sidebar />);

    expect(screen.getByTestId("status-count-unread")).toHaveTextContent("1");
    const row = screen.getByText("Unread Timer Leader").closest("button")!;
    expect(within(row).getByTestId("session-status-dot")).toHaveAttribute("data-status", "completed_unread");
    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
    expect(within(row).queryByTestId("session-status-timer-icon")).not.toBeInTheDocument();
    expect(within(row).queryByTestId("session-notification-marker")).not.toBeInTheDocument();
    fireEvent.mouseEnter(row);
    await waitFor(() => {
      expect(screen.getByTestId("session-hover-attention-status")).toHaveTextContent("3 unread conversations");
    });
    expect(mockConnectSession).not.toHaveBeenCalledWith(sessionId);
  });

  it.each([
    false,
    true,
  ])("keeps a read leader's needs-input prompt amber without blue unread (selected=%s)", async (selected) => {
    // Use the real producer for the reported shape: all review notifications
    // are read, but an unrelated thread's checkpoint is still unresolved.
    const sessionId = "read-leader-with-checkpoint";
    const source = {
      id: sessionId,
      state: { isOrchestrator: true },
      attentionReason: null,
      lastReadAt: 300,
      pendingPermissions: new Map(),
      notificationStatusVersion: 2,
      notifications: [
        { id: "review", category: "review", timestamp: 200, done: true, threadKey: "main" },
        { id: "checkpoint", category: "needs-input", timestamp: 100, done: false, threadKey: "q-1" },
      ],
    } as any;
    const definition = createSessionAttentionProjectionDefinition({
      getSession: () => source,
      isHerdedWorkerSession: () => false,
      authorizeSubscription: () => true,
    });
    const value = definition.derive(source, sessionId, definition.selectDependencies(source, sessionId));
    const entryId = syncedProjectionEntryId(SESSION_ATTENTION_PROJECTION, sessionId);
    mockState = createMockState({
      currentSessionId: selected ? sessionId : null,
      sdkSessions: [makeSdkSession(sessionId, { name: "Read Leader", isOrchestrator: true, cliConnected: true })],
      sessionAttention: new Map([[sessionId, value.attentionReason]]),
      syncedProjectionValues: new Map([[entryId, value]]),
      syncedProjectionKeys: new Set([entryId]),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map([[sessionId, "default"]]),
    });

    render(<Sidebar />);

    const row = screen.getByText("Read Leader").closest("button")!;
    expect(within(row).getByTestId("session-status-dot")).toHaveAttribute("data-status", "idle");
    expect(screen.queryByTestId("status-count-unread")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "action");
    fireEvent.mouseEnter(row);
    await waitFor(() => {
      expect(screen.getByTestId("session-hover-attention-status")).toHaveTextContent("1 needs-input notification");
    });
    expect(source.notifications[1].done).toBe(false);
    expect(source.lastReadAt).toBe(300);
  });

  it("places group sortables in the group context and updates group order on group drag", async () => {
    mockState = createMockState({
      sessions: new Map([
        ["alpha-session", makeSession("alpha-session", { model: "alpha-model" })],
        ["beta-session", makeSession("beta-session", { model: "beta-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("alpha-session", { name: "Alpha Session", sessionNum: 71, createdAt: 100 }),
        makeSdkSession("beta-session", { name: "Beta Session", sessionNum: 72, createdAt: 200 }),
      ],
      sessionNames: new Map([
        ["alpha-session", "Alpha Session"],
        ["beta-session", "Beta Session"],
      ]),
      treeGroups: [
        { id: "alpha", name: "Alpha Space" },
        { id: "beta", name: "Beta Space" },
      ],
      treeAssignments: new Map([
        ["alpha-session", "alpha"],
        ["beta-session", "beta"],
      ]),
    });

    render(<Sidebar />);

    expect(dndKitMockState.dndContexts).toHaveLength(1);
    expect(dndKitMockState.invalidSortableIds).toEqual([]);

    await act(async () => {
      dndKitMockState.dndContexts[0]!.onDragEnd?.({ active: { id: "beta" }, over: { id: "alpha" } });
    });

    await waitFor(() => {
      expect(mockApi.updateTreeGroups).toHaveBeenCalledWith({
        groups: [
          { id: "default", name: "Default" },
          { id: "beta", name: "Beta Space" },
          { id: "alpha", name: "Alpha Space" },
        ],
        assignments: {
          "alpha-session": "alpha",
          "beta-session": "beta",
        },
      });
    });
    expect(mockApi.assignSessionToTreeGroup).not.toHaveBeenCalled();
    expect(mockApi.updateTreeNodeOrder).not.toHaveBeenCalled();
  });

  it("hovering a herded worker highlights its leader and shows leader info in hover card", async () => {
    const leaderSessionId = "leader-1";
    const workerSessionId = "worker-1";
    mockState = createMockState({
      sessions: new Map([
        [leaderSessionId, makeSession(leaderSessionId, { model: "leader-model" })],
        [workerSessionId, makeSession(workerSessionId, { model: "worker-model" })],
      ]),
      sdkSessions: [
        makeSdkSession(leaderSessionId, {
          name: "Leader Session",
          isOrchestrator: true,
          sessionNum: 7,
          createdAt: 1700000000000,
        }),
        makeSdkSession(workerSessionId, {
          name: "Worker Session",
          herdedBy: leaderSessionId,
          sessionNum: 11,
          createdAt: 1700000001000,
        }),
      ],
      sessionNames: new Map([
        [leaderSessionId, "Leader Session"],
        [workerSessionId, "Worker Session"],
      ]),
      expandedHerdNodes: new Set([leaderSessionId]),
    });

    render(<Sidebar />);
    fireEvent.mouseEnter(screen.getByText("Worker Session").closest("button")!);

    await waitFor(() => {
      expect(screen.getByText("Herded by")).toBeInTheDocument();
      const section = screen.getByTestId("session-hover-herded-by");
      expect(within(section).getByRole("button", { name: "#7" })).toBeInTheDocument();
    });
  });

  it("keeps workers grouped under the correct leader when multiple herds are expanded", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-alpha", makeSession("leader-alpha", { model: "leader-alpha-model" })],
        ["worker-alpha", makeSession("worker-alpha", { model: "worker-alpha-model" })],
        ["leader-beta", makeSession("leader-beta", { model: "leader-beta-model" })],
        ["worker-beta", makeSession("worker-beta", { model: "worker-beta-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-alpha", {
          name: "Leader Alpha",
          isOrchestrator: true,
          sessionNum: 7,
          createdAt: 1700000001000,
        }),
        makeSdkSession("worker-alpha", {
          name: "Worker Alpha",
          herdedBy: "leader-alpha",
          sessionNum: 8,
          createdAt: 1700000002000,
        }),
        makeSdkSession("leader-beta", {
          name: "Leader Beta",
          isOrchestrator: true,
          sessionNum: 9,
          createdAt: 1700000003000,
        }),
        makeSdkSession("worker-beta", {
          name: "Worker Beta",
          herdedBy: "leader-beta",
          sessionNum: 10,
          createdAt: 1700000004000,
        }),
      ],
      sessionNames: new Map([
        ["leader-alpha", "Leader Alpha"],
        ["worker-alpha", "Worker Alpha"],
        ["leader-beta", "Leader Beta"],
        ["worker-beta", "Worker Beta"],
      ]),
      expandedHerdNodes: new Set(["leader-alpha", "leader-beta"]),
    });

    render(<Sidebar />);

    const leaderAlphaButton = screen.getByText("Leader Alpha").closest("button")!;
    const workerAlphaButton = screen.getByText("Worker Alpha").closest("button")!;
    const leaderBetaButton = screen.getByText("Leader Beta").closest("button")!;
    const workerBetaButton = screen.getByText("Worker Beta").closest("button")!;

    expect(
      leaderAlphaButton.compareDocumentPosition(workerAlphaButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(leaderBetaButton.compareDocumentPosition(workerBetaButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not add redundant herd highlight rings when leader info panel is open in tree view", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-2", makeSession("leader-2", { model: "leader-open-model" })],
        ["worker-2", makeSession("worker-2", { model: "worker-open-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-2", {
          name: "Leader Open",
          isOrchestrator: true,
          sessionNum: 21,
          createdAt: 1700000002000,
        }),
        makeSdkSession("worker-2", {
          name: "Worker Open",
          herdedBy: "leader-2",
          sessionNum: 22,
          createdAt: 1700000003000,
        }),
      ],
      sessionNames: new Map([
        ["leader-2", "Leader Open"],
        ["worker-2", "Worker Open"],
      ]),
      sessionInfoOpenSessionId: "leader-2",
      expandedHerdNodes: new Set(["leader-2"]),
    });

    render(<Sidebar />);
    expect(screen.getByText("Worker Open").closest("button")).not.toHaveClass("ring-amber-400/45");
  });

  it("does not add redundant herd highlight rings when worker info panel is open in tree view", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-3", makeSession("leader-3", { model: "leader-worker-open-model" })],
        ["worker-3", makeSession("worker-3", { model: "worker-worker-open-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-3", {
          name: "Leader Worker Open",
          isOrchestrator: true,
          sessionNum: 31,
          createdAt: 1700000004000,
        }),
        makeSdkSession("worker-3", {
          name: "Worker Worker Open",
          herdedBy: "leader-3",
          sessionNum: 32,
          createdAt: 1700000005000,
        }),
      ],
      sessionNames: new Map([
        ["leader-3", "Leader Worker Open"],
        ["worker-3", "Worker Worker Open"],
      ]),
      sessionInfoOpenSessionId: "worker-3",
      expandedHerdNodes: new Set(["leader-3"]),
    });

    render(<Sidebar />);
    expect(screen.getByText("Leader Worker Open").closest("button")).not.toHaveClass("ring-amber-400/70");
  });

  it("tree view renders herd leaders before expanded worker rows", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-first", makeSession("leader-first", { model: "leader-first-model" })],
        ["worker-first", makeSession("worker-first", { model: "worker-first-model" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-first", { name: "Leader First", isOrchestrator: true, sessionNum: 41, createdAt: 100 }),
        makeSdkSession("worker-first", {
          name: "Worker First",
          herdedBy: "leader-first",
          sessionNum: 42,
          createdAt: 300,
        }),
      ],
      sessionNames: new Map([
        ["leader-first", "Leader First"],
        ["worker-first", "Worker First"],
      ]),
      expandedHerdNodes: new Set(["leader-first"]),
    });

    render(<Sidebar />);

    const leaderAfter = screen.getByText("Leader First").closest("button")!;
    const workerAfter = screen.getByText("Worker First").closest("button")!;
    expect(leaderAfter.compareDocumentPosition(workerAfter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("refreshes stale expanded worker git rows in the background", async () => {
    const staleAt = Date.now() - 10 * 60_000;
    mockState = createMockState({
      sessions: new Map([
        ["leader-refresh", makeSession("leader-refresh", { model: "leader-refresh-model", is_worktree: true })],
        [
          "worker-refresh",
          makeSession("worker-refresh", {
            model: "worker-refresh-model",
            is_worktree: true,
            git_branch: "worker-refresh",
            git_ahead: 1,
            total_lines_added: 12,
            git_status_refreshed_at: staleAt,
          }),
        ],
      ]),
      sdkSessions: [
        makeSdkSession("leader-refresh", {
          name: "Leader Refresh",
          isOrchestrator: true,
          isWorktree: true,
          sessionNum: 61,
          createdAt: 100,
        }),
        makeSdkSession("worker-refresh", {
          name: "Worker Refresh",
          herdedBy: "leader-refresh",
          isWorktree: true,
          sessionNum: 62,
          createdAt: 200,
        }),
      ],
      sessionNames: new Map([
        ["leader-refresh", "Leader Refresh"],
        ["worker-refresh", "Worker Refresh"],
      ]),
      expandedHerdNodes: new Set(["leader-refresh"]),
    });

    render(<Sidebar />);

    await waitFor(() => {
      expect(mockApi.refreshSessionGitStatus).toHaveBeenCalledWith("worker-refresh", { force: false });
    });
  });

  it("tree view keeps workers in their leader's assigned group across projects", () => {
    mockState = createMockState({
      sessions: new Map([
        ["leader-cross-project", makeSession("leader-cross-project", { cwd: "/home/user/project-leader" })],
        ["leader-peer", makeSession("leader-peer", { cwd: "/home/user/project-leader" })],
        ["worker-cross-project", makeSession("worker-cross-project", { cwd: "/home/user/project-worker" })],
      ]),
      sdkSessions: [
        makeSdkSession("leader-cross-project", {
          name: "Cross Project Leader",
          cwd: "/home/user/project-leader",
          isOrchestrator: true,
          sessionNum: 51,
          createdAt: 100,
        }),
        makeSdkSession("leader-peer", {
          name: "Newer Leader-Project Peer",
          cwd: "/home/user/project-leader",
          sessionNum: 52,
          createdAt: 300,
        }),
        makeSdkSession("worker-cross-project", {
          name: "Cross Project Worker",
          cwd: "/home/user/project-worker",
          herdedBy: "leader-cross-project",
          sessionNum: 53,
          createdAt: 400,
        }),
      ],
      sessionNames: new Map([
        ["leader-cross-project", "Cross Project Leader"],
        ["leader-peer", "Newer Leader-Project Peer"],
        ["worker-cross-project", "Cross Project Worker"],
      ]),
      treeGroups: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      treeAssignments: new Map([
        ["leader-cross-project", "alpha"],
        ["leader-peer", "alpha"],
        ["worker-cross-project", "beta"],
      ]),
      expandedHerdNodes: new Set(["leader-cross-project"]),
    });

    render(<Sidebar />);

    const workerButton = screen.getByText("Cross Project Worker").closest("button")!;
    const betaHeader = screen.getByText("Beta");
    expect(workerButton.compareDocumentPosition(betaHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
