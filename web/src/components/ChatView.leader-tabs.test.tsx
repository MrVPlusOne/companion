// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useSyncExternalStore, type ReactNode } from "react";
import { persistLeaderSelectedThreadKey, readLeaderSelectedThreadKey } from "../utils/thread-viewport.js";
import { navigateToSession, parseHash, threadRouteFromHash } from "../utils/routing.js";
import type { LeaderWorkboardView } from "../store-types.js";
import { installChatViewLeaderProjection } from "../test-fixtures/chat-view-leader-projection.js";
import {
  createModelProvenanceMigration,
  resolveUnknownModelProvenanceAuthority,
} from "../../server/cli-launcher-model-authority.js";
import {
  leaderSession,
  projectionTabKeys,
  movedMarker,
  movedUser,
  needsInputNotification,
  threadMessage,
  transitionMarker,
} from "./chat-view-leader-tabs-fixtures.js";

interface MockStoreState {
  currentSessionId: string | null;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionInfoOpenSessionId: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  changedFiles: Map<string, Set<string>>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  pendingPermissions: Map<string, Map<string, { tool_name?: string; request_id?: string }>>;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  sessions: Map<
    string,
    {
      backend_state?: "initializing" | "resuming" | "recovering" | "connected" | "disconnected" | "broken";
      backend_error?: string | null;
      isOrchestrator?: boolean;
      modelProvenanceMigration?: import("../types.js").ModelProvenanceMigration;
    }
  >;
  cliConnected: Map<string, boolean>;
  cliEverConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  serverReachable: boolean;
  sdkSessions: Array<{
    sessionId: string;
    name?: string;
    archived?: boolean;
    isOrchestrator?: boolean;
    modelProvenanceMigration?: import("../types.js").ModelProvenanceMigration;
  }>;
  sessionNotifications: Map<string, import("../types.js").SessionNotification[]>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionAttentionRecords: Map<string, import("../types.js").SessionAttentionRecord[]>;
  sessionBoards: Map<string, unknown[]>;
  sessionCompletedBoards: Map<string, unknown[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  leaderProjections: Map<string, import("../types.js").LeaderProjectionSnapshot>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
  projectedLeaderTabKeys: string[];
  messages: Map<string, unknown[]>;
  historyLoading: Map<string, boolean>;
  quests: Array<Record<string, unknown> & { questId: string; title: string; status: string }>;
  questDetails: Map<string, import("../types.js").QuestmasterTask>;
  questTitlePreviews: Map<string, import("../types.js").QuestTitlePreview | null>;
  hydrateQuestTitles: ReturnType<typeof vi.fn>;
  sessionNames: Map<string, string>;
  questNamedSessions: Set<string>;
  refreshQuests: ReturnType<typeof vi.fn>;
  refreshQuestSummary: ReturnType<typeof vi.fn>;
  leaderWorkboardViews: Map<string, LeaderWorkboardView>;
  setLeaderWorkboardView: ReturnType<typeof vi.fn>;
  shortcutSettings: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  zoomLevel: number;
}

let mockState: MockStoreState;
const mockSendToSession = vi.fn((_sessionId: string, _msg: unknown) => true);
const mockMessageFeedRenders = vi.fn();
const mockAcknowledgeModelProvenanceMigration = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    currentSessionId: "s1",
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    setSessionInfoOpenSessionId: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    changedFiles: new Map(),
    diffFileStats: new Map(),
    pendingPermissions: new Map(),
    connectionStatus: new Map([["s1", "connected"]]),
    sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
    cliConnected: new Map([["s1", true]]),
    cliEverConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map([["s1", null]]),
    sessionStatus: new Map([["s1", "idle"]]),
    serverReachable: true,
    sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
    sessionNotifications: new Map(),
    sessionAttention: new Map(),
    sessionAttentionRecords: new Map(),
    sessionBoards: new Map(),
    sessionCompletedBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    leaderProjections: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    projectedLeaderTabKeys: [],
    messages: new Map(),
    historyLoading: new Map(),
    quests: [],
    questDetails: new Map(),
    questTitlePreviews: new Map(),
    hydrateQuestTitles: vi.fn().mockResolvedValue(undefined),
    sessionNames: new Map([["s1", "Leader Session"]]),
    questNamedSessions: new Set(),
    refreshQuests: vi.fn().mockResolvedValue(undefined),
    refreshQuestSummary: vi.fn().mockResolvedValue(undefined),
    leaderWorkboardViews: new Map(),
    setLeaderWorkboardView: vi.fn(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    zoomLevel: 1,
    ...overrides,
  };
  if (!overrides.setLeaderWorkboardView) {
    mockState.setLeaderWorkboardView = vi.fn((sessionId: string, view: LeaderWorkboardView | null) => {
      if (view) mockState.leaderWorkboardViews.set(sessionId, view);
      else mockState.leaderWorkboardViews.delete(sessionId);
    });
  }
  const session = mockState.sessions.get("s1");
  const sdkSession = mockState.sdkSessions.find((candidate) => candidate.sessionId === "s1");
  if (session?.isOrchestrator === true || sdkSession?.isOrchestrator === true) {
    installChatViewLeaderProjection(mockState, "s1", mockState.projectedLeaderTabKeys);
  }
}

function setLeaderProjection(
  orderedThreadKeys: readonly string[],
  options?: Parameters<typeof installChatViewLeaderProjection>[3],
) {
  return installChatViewLeaderProjection(mockState, "s1", orderedThreadKeys, options);
}

vi.mock("./ViewportHandoffEntryGate.js", () => ({
  ViewportHandoffThreadEntryGate: ({ children }: any) => children,
  ViewportHandoffSessionEntryGate: ({ children }: any) => children,
}));

vi.mock("../utils/viewport-handoff-client.js", () => ({
  createViewportHandoffEntryId: () => "test-viewport-entry",
  noteViewportSelectionActivity: vi.fn(),
}));

vi.mock("../store.js", () => ({
  useStore: Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => mockState,
  }),
  countUserPermissions: (perms: Map<string, unknown> | undefined): number => perms?.size ?? 0,
  getSessionSearchState: () => ({ query: "", isOpen: false, mode: "strict", category: "all", matches: [] }),
}));

vi.mock("../hooks/useSessionSearch.js", () => ({ useSessionSearch: () => {} }));
vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn(),
    unarchiveSession: vi.fn(),
    acknowledgeModelProvenanceMigration: mockAcknowledgeModelProvenanceMigration,
  },
}));
vi.mock("../ws.js", () => ({ sendToSession: (sessionId: string, msg: unknown) => mockSendToSession(sessionId, msg) }));
vi.mock("./SearchBar.js", () => ({ SearchBar: () => null }));
vi.mock("./TaskOutlineBar.js", () => ({ TaskOutlineBar: () => null }));
vi.mock("./TodoStatusLine.js", () => ({ TodoStatusLine: () => null }));
vi.mock("./Composer.js", () => ({
  Composer: ({ threadKey, transcriptionThreadTitle }: { threadKey?: string; transcriptionThreadTitle?: string }) => (
    <div
      data-testid="composer"
      data-thread-key={threadKey}
      data-transcription-thread-title={transcriptionThreadTitle}
    />
  ),
}));
vi.mock("./PermissionBanner.js", () => ({
  PermissionBanner: () => null,
  PlanReviewOverlay: () => null,
  PlanCollapsedChip: () => null,
  PermissionsCollapsedChip: () => null,
}));
vi.mock("./MessageFeed.js", () => ({
  MessageFeed: ({
    sessionId,
    threadKey,
    additionalAttentionRecords = [],
  }: {
    sessionId: string;
    threadKey?: string;
    additionalAttentionRecords?: Array<import("../types.js").SessionAttentionRecord>;
  }) => {
    mockMessageFeedRenders({ sessionId, threadKey });
    return (
      <div
        data-testid="message-feed"
        data-thread-key={threadKey}
        data-additional-attention-count={additionalAttentionRecords.length}
      >
        {sessionId}
      </div>
    );
  },
}));
vi.mock("./WorkBoardBar.js", () => ({
  WorkBoardBar: ({
    currentThreadKey,
    onSelectThread,
    openThreadKeys = [],
    onCloseThreadTab,
    onReorderThreadTabs,
    threadRows = [],
  }: {
    currentThreadKey?: string;
    onSelectThread?: (threadKey: string) => void;
    openThreadKeys?: string[];
    onCloseThreadTab?: (threadKey: string, nextThreadKey?: string) => void;
    onReorderThreadTabs?: (orderedThreadKeys: string[]) => void;
    threadRows?: Array<{ threadKey: string; questId?: string; title: string }>;
  }) => (
    <div
      data-testid="work-board-bar"
      data-current-thread-key={currentThreadKey}
      data-open-thread-keys={openThreadKeys.join(",")}
    >
      {mockState.leaderWorkboardViews.get("s1") && (
        <div data-testid="workboard-panel" data-view={mockState.leaderWorkboardViews.get("s1") ?? undefined}>
          {mockState.leaderWorkboardViews.get("s1")}
        </div>
      )}
      {onSelectThread && (
        <>
          <button type="button" data-testid="mock-workboard-main" onClick={() => onSelectThread("main")}>
            Main
          </button>
          {openThreadKeys
            .filter((threadKey) => !threadRows.some((row) => row.threadKey === threadKey))
            .map((threadKey) => (
              <button
                type="button"
                key={`open-${threadKey}`}
                data-testid="mock-workboard-open-thread"
                data-thread-key={threadKey}
                onClick={() => onSelectThread(threadKey)}
              >
                Open {threadKey}
              </button>
            ))}
          {threadRows.map((row) => (
            <button type="button" key={row.threadKey} onClick={() => onSelectThread(row.threadKey)}>
              {row.questId ?? row.threadKey} {row.title}
            </button>
          ))}
        </>
      )}
      {onCloseThreadTab &&
        openThreadKeys.map((threadKey, index) => (
          <button
            type="button"
            key={`close-${threadKey}`}
            data-testid="mock-workboard-close-tab"
            data-thread-key={threadKey}
            onClick={() => onCloseThreadTab(threadKey, openThreadKeys[index + 1])}
          >
            Close {threadKey}
          </button>
        ))}
      {onReorderThreadTabs && (
        <button
          type="button"
          data-testid="mock-workboard-reorder-tabs"
          onClick={() => onReorderThreadTabs([...openThreadKeys].reverse())}
        >
          Reorder tabs
        </button>
      )}
    </div>
  ),
}));
vi.mock("./QuestInlineLink.js", () => ({
  QuestInlineLink: ({ questId, children }: { questId: string; children?: ReactNode }) => (
    <span>{children ?? questId}</span>
  ),
}));
vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./SessionStatusDot.js", () => ({ SessionStatusDot: () => null }));
vi.mock("./GlobalNeedsInputMenu.js", () => ({ GlobalNeedsInputMenu: () => null }));
vi.mock("./CatIcons.js", () => ({ YarnBallDot: () => null }));
vi.mock("./QuestJourneyTimeline.js", () => ({
  isCompletedJourneyPresentationStatus: (status?: string) =>
    ["completed", "done"].includes((status ?? "").toLowerCase()),
  QuestJourneyPreviewCard: () => null,
  QuestJourneyTimeline: () => null,
}));
vi.mock("./session-participant-status.js", () => ({ useParticipantSessionStatusDotProps: () => ({}) }));

import { ChatView } from "./ChatView.js";
import { TopBar } from "./TopBar.js";

function RouteAwareLeaderSession() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = parseHash(hash);
  const threadRoute = route.page === "session" ? threadRouteFromHash(hash) : { hasThreadParam: false, threadKey: null };
  const sessionId = route.page === "session" ? route.sessionId : "s1";

  return (
    <>
      <TopBar />
      <ChatView
        key={sessionId}
        sessionId={sessionId}
        hasThreadRoute={threadRoute.hasThreadParam}
        routeThreadKey={threadRoute.threadKey}
      />
    </>
  );
}

beforeEach(() => {
  resetStore();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  window.location.hash = "#/session/s1";
  mockSendToSession.mockClear();
  mockMessageFeedRenders.mockClear();
  mockAcknowledgeModelProvenanceMigration.mockClear();
});

describe("ChatView archived read-only state", () => {
  it("suppresses live startup status for archived sessions", () => {
    // Regression coverage for archived history viewing: stale backend startup
    // metadata should not make the read-only archived view look like it is
    // reconnecting or starting a live session.
    resetStore({
      sessions: new Map([["s1", { backend_state: "initializing", backend_error: null, isOrchestrator: false }]]),
      sdkSessions: [{ sessionId: "s1", archived: true, isOrchestrator: false }],
      cliConnected: new Map([["s1", false]]),
      cliEverConnected: new Map([["s1", false]]),
    });

    render(<ChatView sessionId="s1" />);

    expect(screen.getByText("This session is archived. History is read-only.")).toBeTruthy();
    expect(screen.queryByTestId("live-connection-status-banner")).toBeNull();
    expect(screen.queryByText("Starting session...")).toBeNull();
  });

  it("surfaces the server-owned historical model provenance warning", () => {
    const migration = createModelProvenanceMigration(
      resolveUnknownModelProvenanceAuthority("gpt-5.6-terra"),
      "legacy_relaunch",
      123,
    );
    resetStore({
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true, modelProvenanceMigration: migration }],
    });

    render(<ChatView sessionId="s1" />);

    expect(screen.getByTestId("model-provenance-migration-banner")).toHaveTextContent(migration.warning);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss model provenance migration notice" }));
    expect(mockAcknowledgeModelProvenanceMigration).toHaveBeenCalledWith("s1", migration.eventId);
    expect(screen.getByTestId("model-provenance-migration-banner")).toBeInTheDocument();
  });

  it("keeps an authoritatively acknowledged migration hidden after hydration", () => {
    const migration = {
      ...createModelProvenanceMigration(
        resolveUnknownModelProvenanceAuthority("gpt-5.6-terra"),
        "legacy_relaunch",
        123,
      ),
      acknowledgedAt: 456,
    };
    resetStore({
      sessions: new Map([
        ["s1", { backend_state: "connected", isOrchestrator: true, modelProvenanceMigration: migration }],
      ]),
    });

    render(<ChatView sessionId="s1" />);

    expect(screen.queryByTestId("model-provenance-migration-banner")).toBeNull();
  });
});

describe("ChatView leader open thread tabs", () => {
  it("hydrates authoritative open tabs from the synchronized projection before history loads", () => {
    resetStore({
      sessions: new Map([["s1", { backend_state: "connected", backend_error: null, isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true }],
      projectedLeaderTabKeys: projectionTabKeys(["q-1200", "q-927"]),
      historyLoading: new Map([["s1", true]]),
    });

    const view = render(<ChatView sessionId="s1" />);

    expect(within(view.container).getByTestId("work-board-bar")).toHaveAttribute(
      "data-open-thread-keys",
      "q-1200,q-927",
    );
  });

  it("sends open and close operations to the server without writing localStorage", () => {
    resetStore({
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Quest thread MVP", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    fireEvent.click(scope.getByRole("button", { name: /q-941 quest thread mvp/i }));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "open", threadKey: "q-941", placement: "first" },
    });
    expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBeNull();

    fireEvent.click(scope.getByTestId("mock-workboard-close-tab"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "");
    expect(mockSendToSession).toHaveBeenLastCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "close", threadKey: "q-941", closedAt: expect.any(Number) },
    });
  });

  it("persists a browser-local selected leader tab without writing open-tab localStorage", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Persisted selection", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);

    fireEvent.click(scope.getByRole("button", { name: /q-941 persisted selection/i }));

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(localStorage.getItem("test-server:cc-leader-open-thread-tabs:s1")).toBeNull();
  });

  it("hydrates one canonical retained-tab title across header, banner, and navigation consumers", async () => {
    const hydrateQuestTitles = vi.fn().mockResolvedValue(undefined);
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1932"]),
      // Cold retained-tab hydration may have only the authoritative open key;
      // no board row or routed history row is required to recover the header.
      messages: new Map([["s1", []]]),
      quests: [],
      questTitlePreviews: new Map([
        ["q-1932", { questId: "q-1932", title: "Resolve VSCode QA Stack Conflicts", version: 3, updatedAt: 30 }],
      ]),
      hydrateQuestTitles,
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-1932" />);
    const scope = within(view.container);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1932");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("q-1932Resolve VSCode QA Stack Conflicts");
    expect(scope.getByTestId("composer")).toHaveAttribute(
      "data-transcription-thread-title",
      "q-1932: Resolve VSCode QA Stack Conflicts",
    );
    await waitFor(() => expect(hydrateQuestTitles).toHaveBeenCalledWith(["q-1932"], { force: true }));

    // A later partial board snapshot may keep the tab available, but must not
    // downgrade any of the shared title consumers back to the quest id.
    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-1932", title: "q-1932", status: "WORKING", updatedAt: 40 }]],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-1932" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1932");
    expect(scope.getByTestId("quest-thread-banner")).toHaveTextContent("q-1932Resolve VSCode QA Stack Conflicts");

    // A soft browser reconnect with unchanged open keys must revalidate the
    // bounded title projection in case this browser missed a retitle event.
    mockState.connectionStatus = new Map([["s1", "disconnected"]]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-1932" />);
    mockState.connectionStatus = new Map([["s1", "connected"]]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-1932" />);
    await waitFor(() => expect(hydrateQuestTitles).toHaveBeenLastCalledWith(["q-1932"], { force: true }));
  });

  it("passes the selected leader thread title to the composer for voice transcription vocabulary", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1210"]),
      messages: new Map([["s1", [threadMessage("q-1210", 2)]]]),
      quests: [
        {
          questId: "q-1210",
          title: "Use active leader thread tab as voice transcription context",
          status: "in_progress",
        },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={true} routeThreadKey="q-1210" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("composer")).toHaveAttribute("data-thread-key", "q-1210"));
    expect(scope.getByTestId("composer")).toHaveAttribute(
      "data-transcription-thread-title",
      "q-1210: Use active leader thread tab as voice transcription context",
    );
  });

  it("restores the browser-local selected leader tab when returning without an explicit thread route", async () => {
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Restore me", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-key", "q-941");
  });

  it.each([
    false,
    true,
  ])("preserves tab order across session return (new activation: %s)", async (activateWhileAway) => {
    // Follow the real URL rewrite after restoring the saved selection. A fixed
    // route prop misses the second render that used to promote the viewed tab.
    resetStore({
      sessions: new Map([
        ...leaderSession(),
        ["s2", { backend_state: "connected", backend_error: null, isOrchestrator: false }],
      ]),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777", "q-555"]),
      messages: new Map([["s1", [threadMessage("q-941", 1), threadMessage("q-777", 2), threadMessage("q-555", 3)]]]),
      quests: [
        { questId: "q-941", title: "First tab", status: "in_progress" },
        { questId: "q-777", title: "Viewed tab", status: "in_progress" },
        { questId: "q-555", title: "Resumed tab", status: "in_progress" },
      ],
    });
    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);
    fireEvent.click(scope.getByRole("button", { name: /q-777 viewed tab/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/session/s1?thread=q-777"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777,q-555");

    for (let visit = 0; visit < 2; visit++) {
      act(() => navigateToSession("s2", true));
      expect(scope.getByTestId("message-feed")).toHaveTextContent("s2");
      const expectedOrder = activateWhileAway ? ["q-555", "q-941", "q-777"] : ["q-941", "q-777", "q-555"];
      // Consume the producer-shaped authoritative order, including a fresh
      // activation received while away; restoring selection must not undo it.
      setLeaderProjection(expectedOrder);
      mockSendToSession.mockClear();
      act(() => navigateToSession("s1", true));

      await waitFor(() => expect(window.location.hash).toBe("#/session/s1?thread=q-777"));
      expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-777");
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", expectedOrder.join(","));
      expect(readLeaderSelectedThreadKey("s1")).toBe("q-777");
      expect(mockSendToSession).not.toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ type: "leader_thread_tabs_update" }),
      );
    }
  });

  it("does not mount Main before restoring a server-open browser-local selected tab", () => {
    // The feed owns viewport save/restore side effects. If a returning leader
    // session first mounts Main and only later restores a saved quest tab,
    // selected-thread content can be snapshotted under the Main viewport key.
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Initial restore", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);

    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(mockMessageFeedRenders.mock.calls[0]?.[0]).toEqual({ sessionId: "s1", threadKey: "q-941" });
    expect(mockMessageFeedRenders).not.toHaveBeenCalledWith({ sessionId: "s1", threadKey: "main" });
  });

  it("preserves an explicit leader thread route while session metadata is still hydrating", async () => {
    window.location.hash = "#/session/s1?thread=q-941";
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: new Map(),
      sdkSessions: [],
      messages: new Map(),
      quests: [{ questId: "q-941", title: "Hydrating route", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={true} routeThreadKey="q-941" />);
    expect(window.location.hash).toBe("#/session/s1?thread=q-941");
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");

    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", 2)]]]),
      quests: [{ questId: "q-941", title: "Hydrating route", status: "in_progress" }],
    });
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={true} routeThreadKey="q-941" />);

    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(window.location.hash).toBe("#/session/s1?thread=q-941");
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
  });

  it("falls back to Main when the browser-local selected tab is no longer server-open", async () => {
    persistLeaderSelectedThreadKey("s1", "q-999");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-999", 3)]]]),
      quests: [
        { questId: "q-941", title: "Still open", status: "in_progress" },
        { questId: "q-999", title: "Closed elsewhere", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("main");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
  });

  it("lets an explicit thread route override browser-local selected tab restore", async () => {
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777"]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Stored tab", status: "in_progress" },
        { questId: "q-777", title: "Routed tab", status: "in_progress" },
      ],
    });
    window.location.hash = "#/session/s1?thread=q-777";

    const view = render(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-777" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-777"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-777");
  });

  it.each([
    ["topbar-workboard-shortcut", "active"],
    ["topbar-completed-shortcut", "completed"],
  ] as const)("opens the %s panel in place from a quest thread", async (shortcutTestId, expectedView) => {
    persistLeaderSelectedThreadKey("s1", "q-42");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-42"]),
      sdkSessions: [{ sessionId: "s1", archived: false, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-42", status: "IMPLEMENTING", title: "Active", updatedAt: 2 }]]]),
      sessionCompletedBoards: new Map([
        ["s1", [{ questId: "q-41", status: "DONE", title: "Completed", updatedAt: 1, completedAt: 1 }]],
      ]),
      messages: new Map([["s1", [threadMessage("q-42", 2)]]]),
      quests: [{ questId: "q-42", title: "Routed quest", status: "in_progress" }],
    });
    window.location.hash = "#/session/s1?thread=q-42";

    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-42"));
    expect(scope.queryByTestId("workboard-panel")).not.toBeInTheDocument();

    fireEvent.click(scope.getByTestId(shortcutTestId));
    view.rerender(<RouteAwareLeaderSession />);

    await waitFor(() => expect(scope.getByTestId("workboard-panel")).toHaveAttribute("data-view", expectedView));
    expect(window.location.hash).toBe("#/session/s1?thread=q-42");
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-42");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-current-thread-key", "q-42");
    expect(scope.getByTestId("workboard-panel")).toHaveAttribute("data-view", expectedView);
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-42");
  });

  it("renders server-owned tabs and applies remote close updates from another browser", () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777"]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Closed elsewhere", status: "in_progress" },
        { questId: "q-777", title: "Still open", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");

    setLeaderProjection(["q-777"]);
    view.rerender(<ChatView sessionId="s1" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-777");
  });

  it("sends manual reorder operations without changing selected tab or viewport ownership", () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777", "q-555"]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3), threadMessage("q-555", 4)]]]),
      quests: [
        { questId: "q-941", title: "First tab", status: "in_progress" },
        { questId: "q-777", title: "Second tab", status: "in_progress" },
        { questId: "q-555", title: "Third tab", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    fireEvent.click(scope.getByRole("button", { name: /q-777 second tab/i }));
    mockSendToSession.mockClear();

    fireEvent.click(scope.getByTestId("mock-workboard-reorder-tabs"));

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-555,q-777,q-941");
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-777");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "reorder", orderedOpenThreadKeys: ["q-555", "q-777", "q-941"] },
    });

    setLeaderProjection(["q-555", "q-777", "q-941"]);
    view.rerender(<ChatView sessionId="s1" />);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-555,q-777,q-941");
  });

  it("preserves manual order when a route-aware local tab click selects an already-open tab", async () => {
    window.location.hash = "#/session/s1?thread=q-1376";
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1376", "q-1350", "q-1361", "q-1360"]),
      messages: new Map([
        [
          "s1",
          [
            threadMessage("q-1376", 1),
            threadMessage("q-1350", 2),
            threadMessage("q-1361", 3),
            threadMessage("q-1360", 4),
          ],
        ],
      ]),
      quests: [
        { questId: "q-1376", title: "First manually ordered tab", status: "in_progress" },
        { questId: "q-1350", title: "Second manually ordered tab", status: "in_progress" },
        { questId: "q-1361", title: "Clicked existing tab", status: "in_progress" },
        { questId: "q-1360", title: "Fourth manually ordered tab", status: "in_progress" },
      ],
    });

    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-1376"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1376,q-1350,q-1361,q-1360");
    mockSendToSession.mockClear();

    fireEvent.click(scope.getByRole("button", { name: /q-1361 clicked existing tab/i }));

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-1361"));
    expect(window.location.hash).toBe("#/session/s1?thread=q-1361");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1376,q-1350,q-1361,q-1360");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("keeps newly opened tabs immediately after Main without reordering existing manual order", () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777"]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3), threadMessage("q-555", 4)]]]),
      quests: [
        { questId: "q-941", title: "First tab", status: "in_progress" },
        { questId: "q-777", title: "Second tab", status: "in_progress" },
        { questId: "q-555", title: "New tab", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    fireEvent.click(scope.getByTestId("mock-workboard-reorder-tabs"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-777,q-941");
    mockSendToSession.mockClear();

    fireEvent.click(scope.getByRole("button", { name: /q-555 new tab/i }));

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-555,q-777,q-941");
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "open", threadKey: "q-555", placement: "first" },
    });
  });

  it("reapplies first placement when a route opens a stale hidden tab that is already persisted", async () => {
    window.location.hash = "#/session/s1?thread=q-1376";
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1361", "q-1360", "q-1350", "q-1339", "q-1202", "q-1156", "q-1376"]),
      messages: new Map([
        [
          "s1",
          [
            threadMessage("q-1361", 1),
            threadMessage("q-1360", 2),
            threadMessage("q-1350", 3),
            threadMessage("q-1339", 4),
            threadMessage("q-1202", 5),
            threadMessage("q-1156", 6),
            threadMessage("q-1376", 7),
          ],
        ],
      ]),
      quests: [
        { questId: "q-1361", title: "Older visible A", status: "in_progress" },
        { questId: "q-1360", title: "Older visible B", status: "in_progress" },
        { questId: "q-1350", title: "Older visible C", status: "in_progress" },
        { questId: "q-1339", title: "Older visible D", status: "in_progress" },
        { questId: "q-1202", title: "Older hidden A", status: "in_progress" },
        { questId: "q-1156", title: "Older hidden B", status: "in_progress" },
        { questId: "q-1376", title: "Newest hidden tab", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute routeThreadKey="q-1376" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute(
        "data-open-thread-keys",
        "q-1376,q-1361,q-1360,q-1350,q-1339,q-1202,q-1156",
      ),
    );
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "leader_thread_tabs_update",
      operation: { type: "open", threadKey: "q-1376", placement: "first" },
    });
  });

  it("keeps a fresh creation tab first when the selected route is unchanged", async () => {
    window.location.hash = "#/session/s1?thread=q-1391";
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1391", "q-1376", "q-1361"]),
      sessionBoards: new Map([["s1", []]]),
      messages: new Map([
        [
          "s1",
          [
            threadMessage("q-1391", 10),
            threadMessage("q-1376", 20),
            threadMessage("q-1361", 30),
            threadMessage("q-1395", 200),
          ],
        ],
      ]),
      quests: [
        { questId: "q-1391", title: "Older selected route", status: "done" },
        { questId: "q-1376", title: "Older visible tab", status: "in_progress" },
        { questId: "q-1361", title: "Older visible tab B", status: "in_progress" },
        { questId: "q-1395", title: "Newly created follow-up", status: "in_progress" },
      ],
    });

    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-1391"));
    mockSendToSession.mockClear();

    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-1395", status: "ALIGNMENT", title: "Newly created follow-up", updatedAt: 200 }]],
    ]);
    setLeaderProjection(["q-1395", "q-1391", "q-1376", "q-1361"]);
    view.rerender(<RouteAwareLeaderSession />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute(
        "data-open-thread-keys",
        "q-1395,q-1391,q-1376,q-1361",
      ),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not reassert an already processed route after authoritative tab updates", async () => {
    window.location.hash = "#/session/s1?thread=q-1391";
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1391", "q-1376"]),
      messages: new Map([
        ["s1", [threadMessage("q-1391", 10), threadMessage("q-1376", 20), threadMessage("q-1395", 200)]],
      ]),
      quests: [
        { questId: "q-1391", title: "Older selected route", status: "done" },
        { questId: "q-1376", title: "Older visible tab", status: "in_progress" },
        { questId: "q-1395", title: "Server-opened follow-up", status: "in_progress" },
      ],
    });

    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-1391"));
    mockSendToSession.mockClear();

    setLeaderProjection(["q-1395", "q-1391", "q-1376"]);
    view.rerender(<RouteAwareLeaderSession />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1395,q-1391,q-1376"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("keeps a server-open tab selectable while active needs-input rows are still hydrated separately", async () => {
    window.location.hash = "#/session/s1";
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-900001", "q-900002", "q-900003", "q-900004"]),
      sessionNotifications: new Map([
        ["s1", [needsInputNotification("q-900002", 120), needsInputNotification("q-900003", 100)]],
      ]),
      messages: new Map([["s1", [threadMessage("q-900004", 1)]]]),
      quests: [
        { questId: "q-900001", title: "Active UI routing tab", status: "in_progress" },
        { questId: "q-900002", title: "Needs input thread A", status: "in_progress" },
        { questId: "q-900003", title: "Needs input thread B", status: "in_progress" },
        { questId: "q-900004", title: "Completed thread", status: "done" },
      ],
    });

    const view = render(<RouteAwareLeaderSession />);
    const scope = within(view.container);

    // Regression for active leader sessions with scoped needs-input prompts:
    // route repair must trust already-open server tabs even when their
    // projected thread rows lag behind notification/thread hydration.
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    fireEvent.click(scope.getByRole("button", { name: /q-900001 active ui routing tab/i }));

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-900001"));
    expect(window.location.hash).toBe("#/session/s1?thread=q-900001");
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-900001");
  });

  it("keeps leader tabs open when their quests complete or finish a Journey", () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-777"]),
      sessionBoards: new Map([
        [
          "s1",
          [
            { questId: "q-941", status: "IMPLEMENTING", title: "Completing tab", updatedAt: 2 },
            { questId: "q-777", status: "IMPLEMENTING", title: "Still active", updatedAt: 1 },
          ],
        ],
      ]),
      messages: new Map([["s1", [threadMessage("q-941", 2), threadMessage("q-777", 3)]]]),
      quests: [
        { questId: "q-941", title: "Completing tab", status: "in_progress" },
        { questId: "q-777", title: "Still active", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");

    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-777", status: "IMPLEMENTING", title: "Still active", updatedAt: 4 }]],
    ]);
    mockState.sessionCompletedBoards = new Map([
      [
        "s1",
        [
          {
            questId: "q-941",
            status: "DONE",
            title: "Completing tab",
            updatedAt: 5,
            completedAt: 5,
            journey: { mode: "completed", phaseIds: ["alignment", "implement", "port"] },
          },
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941,q-777");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("persists active board-row quest tabs before completion so board removal does not drop them", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-1231", status: "PORTING", title: "Permission CLI", createdAt: 8, updatedAt: 10 }]],
      ]),
      messages: new Map([["s1", [threadMessage("q-1231", 10)]]]),
      quests: [{ questId: "q-1231", title: "Permission CLI", status: "in_progress" }],
    });

    setLeaderProjection(["q-1231"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1231"));
    expect(mockSendToSession).not.toHaveBeenCalled();
    mockState.sessionBoards = new Map([["s1", []]]);
    mockState.sessionCompletedBoards = new Map([
      [
        "s1",
        [
          {
            questId: "q-1231",
            status: "DONE",
            title: "Permission CLI",
            updatedAt: 20,
            completedAt: 20,
            journey: { mode: "completed", phaseIds: ["alignment", "implement", "port"] },
          },
        ],
      ],
    ]);
    mockState.quests = [{ questId: "q-1231", title: "Permission CLI", status: "done" }];
    setLeaderProjection(["q-1231"]);
    view.rerender(<ChatView sessionId="s1" />);

    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1231");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("inserts newly active board-row candidates before older open leader tabs", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-old-a", "q-old-b", "q-old-c"]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-new", status: "IMPLEMENTING", title: "New active quest", updatedAt: 30 }]],
      ]),
      messages: new Map([
        [
          "s1",
          [
            threadMessage("q-old-a", 1),
            threadMessage("q-old-b", 2),
            threadMessage("q-old-c", 3),
            threadMessage("q-new", 30),
          ],
        ],
      ]),
      quests: [
        { questId: "q-old-a", title: "Older tab A", status: "in_progress" },
        { questId: "q-old-b", title: "Older tab B", status: "in_progress" },
        { questId: "q-old-c", title: "Older tab C", status: "in_progress" },
        { questId: "q-new", title: "New active quest", status: "in_progress" },
      ],
    });

    setLeaderProjection(["q-new", "q-old-a", "q-old-b", "q-old-c"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute(
        "data-open-thread-keys",
        "q-new,q-old-a,q-old-b,q-old-c",
      ),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("opens a manually created idea quest at the left edge when it first becomes active", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-8", "q-5", "q-6"]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-7", status: "ALIGNMENT", title: "Manually created idea", updatedAt: 70 }]],
      ]),
      messages: new Map([["s1", [threadMessage("q-8", 80), threadMessage("q-5", 50), threadMessage("q-6", 60)]]]),
      quests: [
        { questId: "q-8", title: "Existing visible quest", status: "in_progress" },
        { questId: "q-5", title: "Older visible quest", status: "in_progress" },
        { questId: "q-6", title: "Older visible quest B", status: "in_progress" },
        { questId: "q-7", title: "Manually created idea", status: "in_progress" },
      ],
    });

    setLeaderProjection(["q-7", "q-8", "q-5", "q-6"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-7,q-8,q-5,q-6"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("promotes routed needs-input notification quest tabs while the board is empty", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-13", "q-8", "q-11", "q-12"]),
      sessionBoards: new Map([["s1", []]]),
      sessionNotifications: new Map([
        ["s1", [needsInputNotification("q-10", 100), needsInputNotification("q-12", 120)]],
      ]),
      messages: new Map([["s1", [threadMessage("q-13", 13), threadMessage("q-8", 8), threadMessage("q-11", 11)]]]),
      quests: [
        { questId: "q-13", title: "Visible quest", status: "in_progress" },
        { questId: "q-8", title: "Visible quest B", status: "in_progress" },
        { questId: "q-11", title: "Visible quest C", status: "in_progress" },
        { questId: "q-10", title: "Absent notification quest", status: "in_progress" },
        { questId: "q-12", title: "Hidden notification quest", status: "in_progress" },
      ],
    });

    setLeaderProjection(["q-12", "q-10", "q-13", "q-8", "q-11"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-12,q-10,q-13,q-8,q-11"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("applies server-owned needs-input tab promotion across authoritative refreshes", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-13"]),
      sessionBoards: new Map([["s1", []]]),
      sessionNotifications: new Map([
        ["s1", [needsInputNotification("q-10", 100), needsInputNotification("q-12", 120)]],
      ]),
      messages: new Map([["s1", [threadMessage("q-13", 13)]]]),
      quests: [
        { questId: "q-13", title: "Visible quest", status: "in_progress" },
        { questId: "q-10", title: "Notification quest A", status: "in_progress" },
        { questId: "q-12", title: "Notification quest B", status: "in_progress" },
      ],
    });

    setLeaderProjection(["q-12", "q-10", "q-13"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-12,q-10,q-13"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();

    setLeaderProjection(["q-12", "q-10", "q-13"]);
    view.rerender(<ChatView sessionId="s1" />);
    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-12,q-10,q-13"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();

    mockState.sessionNotifications = new Map([
      ["s1", [needsInputNotification("q-10", 140), needsInputNotification("q-12", 120)]],
    ]);
    setLeaderProjection(["q-10", "q-12", "q-13"]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-10,q-12,q-13"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not reopen a needs-input notification tab after a newer explicit close", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-13"]),
      sessionBoards: new Map([["s1", []]]),
      sessionNotifications: new Map([["s1", [needsInputNotification("q-12", 120)]]]),
      messages: new Map([["s1", [threadMessage("q-13", 13)]]]),
      quests: [
        { questId: "q-13", title: "Visible quest", status: "in_progress" },
        { questId: "q-12", title: "Closed notification quest", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-13"));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("reapplies first placement when a fresh board row surfaces an already-open stale tab", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-old-a", "q-old-b", "q-new"]),
      sessionBoards: new Map([["s1", []]]),
      messages: new Map([
        ["s1", [threadMessage("q-old-a", 1), threadMessage("q-old-b", 2), threadMessage("q-new", 30)]],
      ]),
      quests: [
        { questId: "q-old-a", title: "Older tab A", status: "in_progress" },
        { questId: "q-old-b", title: "Older tab B", status: "in_progress" },
        { questId: "q-new", title: "Freshly surfaced quest", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-old-a,q-old-b,q-new");

    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-new", status: "IMPLEMENTING", title: "Freshly surfaced quest", updatedAt: 30 }]],
    ]);
    setLeaderProjection(["q-new", "q-old-a", "q-old-b"]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-new,q-old-a,q-old-b"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("surfaces an already-open idea quest when it later becomes active even if its row timestamp is stale", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-8", "q-5", "q-6", "q-7"]),
      sessionBoards: new Map([["s1", []]]),
      messages: new Map([
        [
          "s1",
          [threadMessage("q-8", 80), threadMessage("q-5", 50), threadMessage("q-6", 60), threadMessage("q-7", 70)],
        ],
      ]),
      quests: [
        { questId: "q-8", title: "Existing visible quest", status: "in_progress" },
        { questId: "q-5", title: "Older visible quest", status: "in_progress" },
        { questId: "q-6", title: "Older visible quest B", status: "in_progress" },
        { questId: "q-7", title: "Idea refined later", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-8,q-5,q-6,q-7");

    // Regression: idea-created quest threads can already exist in the persisted
    // tab list before their board row appears. The activation event should
    // promote that existing tab even when the board timestamp is older than the
    // current server-owned tab-state timestamp.
    mockState.sessionBoards = new Map([
      ["s1", [{ questId: "q-7", status: "ALIGNMENT", title: "Idea refined later", updatedAt: 70 }]],
    ]);
    setLeaderProjection(["q-7", "q-8", "q-5", "q-6"]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-7,q-8,q-5,q-6"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("repairs an already-open active board row into the leftmost leader tab prefix on hydration", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-old-a", "q-new", "q-old-b"]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-new", status: "IMPLEMENTING", title: "Active hidden quest", updatedAt: 30 }]],
      ]),
      messages: new Map([
        ["s1", [threadMessage("q-old-a", 1), threadMessage("q-old-b", 2), threadMessage("q-new", 30)]],
      ]),
      quests: [
        { questId: "q-old-a", title: "Older tab A", status: "in_progress" },
        { questId: "q-old-b", title: "Older tab B", status: "in_progress" },
        { questId: "q-new", title: "Active hidden quest", status: "in_progress" },
      ],
    });

    setLeaderProjection(["q-new", "q-old-a", "q-old-b"]);
    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-new,q-old-a,q-old-b"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("uses fresh board activation time to reopen a previously closed queued quest", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      sessionBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-1231",
              status: "WORKING",
              title: "Resumed queued quest",
              createdAt: 10,
              threadTabActivatedAt: 30,
              updatedAt: 30,
            },
          ],
        ],
      ]),
      quests: [{ questId: "q-1231", title: "Resumed queued quest", status: "in_progress" }],
    });

    setLeaderProjection(["q-1231"]);
    const view = render(<ChatView sessionId="s1" />);
    await waitFor(() =>
      expect(within(view.container).getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1231"),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not resurrect an active quest thread that the user explicitly closed", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-1231", status: "PORTING", title: "Closed quest", createdAt: 10, updatedAt: 30 }]],
      ]),
      messages: new Map([["s1", [threadMessage("q-1231", 10)]]]),
      quests: [{ questId: "q-1231", title: "Closed quest", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", ""));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not force unrelated historical completed quests into open thread tabs", async () => {
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      sessionCompletedBoards: new Map([
        [
          "s1",
          [{ questId: "q-888", status: "DONE", title: "Historical completed quest", updatedAt: 10, completedAt: 10 }],
        ],
      ]),
      messages: new Map([["s1", [threadMessage("q-888", 10)]]]),
      quests: [{ questId: "q-888", title: "Historical completed quest", status: "done" }],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", ""));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("surfaces a fresh Main to quest transition marker without changing the selected tab", async () => {
    const transitionedAt = 100;
    // Regression for the browser Execute failure: the marker itself is the
    // source evidence for the server-owned projected target even when Questmaster rows lag behind.
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-9003"]),
      sessionCompletedBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-9003",
              status: "DONE",
              title: "Completed existing target",
              updatedAt: transitionedAt - 20,
              completedAt: transitionedAt - 10,
            },
          ],
        ],
      ]),
      messages: new Map([["s1", [{ id: "seed-main-source", role: "user", content: "Source Main", timestamp: 1 }]]]),
      quests: [],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      [
        "s1",
        [
          { id: "seed-main-source", role: "user", content: "Source Main", timestamp: 1 },
          transitionMarker("q-9001", transitionedAt),
          threadMessage("q-9001", transitionedAt + 1),
        ],
      ],
    ]);
    setLeaderProjection(["q-9001", "q-9003"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-9001,q-9003"),
    );
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(readLeaderSelectedThreadKey("s1")).not.toBe("q-9001");
    expect(window.location.hash).not.toContain("thread=q-9001");
    expect(mockSendToSession).not.toHaveBeenCalled();

    fireEvent.click(scope.getByRole("button", { name: /^q-9001 q-9001$/i }));
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-9001"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-9001");
    expect(window.location.hash).toBe("#/session/s1?thread=q-9001");
  });

  it("surfaces a live Main transition marker that arrives before history loading finishes", async () => {
    const transitionedAt = 100;
    const liveMarker = {
      ...transitionMarker("q-1648", transitionedAt),
      historyIndex: -1,
    };
    const persistedMarker = {
      ...liveMarker,
      historyIndex: 5,
    };
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      historyLoading: new Map([["s1", true]]),
      messages: new Map([["s1", []]]),
      quests: [{ questId: "q-1648", title: "Fresh quest thread", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));

    mockState.messages = new Map([["s1", [liveMarker]]]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(mockSendToSession).not.toHaveBeenCalled();

    mockState.messages = new Map([["s1", [persistedMarker]]]);
    mockState.historyLoading = new Map([["s1", false]]);
    setLeaderProjection(["q-1648"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1648"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(readLeaderSelectedThreadKey("s1")).not.toBe("q-1648");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not surface a Main transition marker for an existing quest target", async () => {
    const transitionedAt = 100;
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1648"]),
      messages: new Map([["s1", [threadMessage("q-1648", transitionedAt - 10)]]]),
      quests: [{ questId: "q-1648", title: "Existing quest thread", status: "in_progress" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-1648", transitionedAt - 10),
          transitionMarker("q-1648", transitionedAt, { targetThreadFreshness: "existing_quest_thread" }),
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(readLeaderSelectedThreadKey("s1")).not.toBe("q-1648");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not surface an already-open completed transition target", async () => {
    const transitionedAt = 100;
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-1648"]),
      messages: new Map([["s1", [threadMessage("q-1648", transitionedAt - 10)]]]),
      quests: [{ questId: "q-1648", title: "Completed quest thread", status: "done" }],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-1648", transitionedAt - 10),
          transitionMarker("q-1648", transitionedAt, { targetThreadFreshness: "new_quest_thread" }),
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(readLeaderSelectedThreadKey("s1")).not.toBe("q-1648");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not surface a Main transition marker after manual navigation away from Main", async () => {
    const transitionedAt = 1;
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", transitionedAt)]]]),
      quests: [
        { questId: "q-941", title: "Selected thread", status: "in_progress" },
        { questId: "q-1648", title: "Fresh quest thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    fireEvent.click(scope.getByRole("button", { name: /q-941 Selected thread/i }));
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      ["s1", [threadMessage("q-941", transitionedAt), transitionMarker("q-1648", transitionedAt)]],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not select or reopen duplicate, replayed, non-Main, or tombstoned transition markers", async () => {
    const transitionedAt = 100;
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys([]),
      messages: new Map([["s1", []]]),
      quests: [
        { questId: "q-1648", title: "Fresh quest thread", status: "in_progress" },
        { questId: "q-closed", title: "Closed quest thread", status: "in_progress" },
        { questId: "q-941", title: "Source quest", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));

    mockState.messages = new Map([
      [
        "s1",
        [
          transitionMarker("q-1648", transitionedAt),
          transitionMarker("q-closed", transitionedAt),
          transitionMarker("q-ignored", transitionedAt + 1, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    setLeaderProjection(["q-1648"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1648"));
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(mockSendToSession).not.toHaveBeenCalled();

    fireEvent.click(scope.getByTestId("mock-workboard-main"));
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    mockSendToSession.mockClear();
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("surfaces the target thread when a fresh attachment marker moves context from the selected source thread", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Target thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941"),
    );
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("reapplies first placement when a fresh attachment marker surfaces an already-open stale tab", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-1006"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10), threadMessage("q-1006", attachedAt - 9)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Target thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          threadMessage("q-1006", attachedAt - 4),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941"),
    );
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941");
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("surfaces moved context without selecting it when the attachment source is not the selected thread", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10)]]]),
      quests: [
        { questId: "q-941", title: "Selected thread", status: "in_progress" },
        { questId: "q-1006", title: "Target thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "main" }),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not create or select a closed completed target from an attachment marker", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Completed target", status: "done" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ operation: expect.objectContaining({ threadKey: "q-1006" }) }),
    );
  });

  it("does not select an already-open completed target or reopen it", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941", "q-1006"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10), threadMessage("q-1006", attachedAt - 9)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Completed target", status: "done" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));

    mockSendToSession.mockClear();
    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          threadMessage("q-1006", attachedAt - 4),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(readLeaderSelectedThreadKey("s1")).toBe("q-941");
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ operation: expect.objectContaining({ threadKey: "q-1006" }) }),
    );
  });

  it("does not select when the user manually navigated after the attachment time", async () => {
    const attachedAt = 1;
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Target thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    const sourceButton = await scope.findByRole("button", { name: /q-941 source thread/i });
    fireEvent.click(sourceButton);
    mockSendToSession.mockClear();

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("does not select when the marker did not move the latest user-authored message", async () => {
    const attachedAt = Date.now();
    persistLeaderSelectedThreadKey("s1", "q-941");
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", [threadMessage("q-941", attachedAt - 10)]]]),
      quests: [
        { questId: "q-941", title: "Source thread", status: "in_progress" },
        { questId: "q-1006", title: "Target thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);
    const scope = within(view.container);
    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));

    mockState.messages = new Map([
      [
        "s1",
        [
          threadMessage("q-941", attachedAt - 5),
          movedUser("q-1006", attachedAt),
          movedMarker("q-1006", attachedAt, { sourceThreadKey: "q-941", sourceQuestId: "q-941" }),
          movedUser("q-2000", attachedAt + 1, 9),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" hasThreadRoute={false} routeThreadKey={null} />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "q-941"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("opens fresh server-created candidates but suppresses candidates older than a user close", async () => {
    const attachedAt = Date.now();
    resetStore({
      sessions: leaderSession(),
      projectedLeaderTabKeys: projectionTabKeys(["q-941"]),
      messages: new Map([["s1", []]]),
      quests: [
        { questId: "q-941", title: "Existing thread", status: "in_progress" },
        { questId: "q-1005", title: "Closed thread", status: "in_progress" },
        { questId: "q-1006", title: "Fresh thread", status: "in_progress" },
      ],
    });

    const view = render(<ChatView sessionId="s1" />);
    const scope = within(view.container);
    mockState.messages = new Map([["s1", [movedUser("q-1005", attachedAt), movedMarker("q-1005", attachedAt)]]]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() => expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main"));
    expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-941");
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ operation: expect.objectContaining({ threadKey: "q-1005" }) }),
    );

    const freshAttachedAt = attachedAt + 10;
    mockState.messages = new Map([
      [
        "s1",
        [
          movedUser("q-1005", attachedAt),
          movedMarker("q-1005", attachedAt),
          movedUser("q-1006", freshAttachedAt),
          movedMarker("q-1006", freshAttachedAt),
          threadMessage("q-941", freshAttachedAt + 1),
        ],
      ],
    ]);
    setLeaderProjection(["q-1006", "q-941"]);
    view.rerender(<ChatView sessionId="s1" />);

    await waitFor(() =>
      expect(scope.getByTestId("work-board-bar")).toHaveAttribute("data-open-thread-keys", "q-1006,q-941"),
    );
    expect(scope.getByTestId("message-feed")).toHaveAttribute("data-thread-key", "main");
    expect(mockSendToSession).not.toHaveBeenCalled();
  });
});
