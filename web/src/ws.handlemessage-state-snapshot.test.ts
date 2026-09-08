// @vitest-environment jsdom

import type {
  SessionState,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  SessionAttentionRecord,
} from "./types.js";
import { computeHistoryMessagesSyncHash } from "../shared/history-sync-hash.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT, HISTORY_WINDOW_VISIBLE_SECTION_COUNT } from "../shared/history-window.js";

// Mock the names utility before any imports
vi.mock("./utils/names.js", () => ({
  generateUniqueSessionName: vi.fn(() => "Test Session"),
}));

const getDiffStatsMock = vi.fn().mockResolvedValue({ stats: {} });
const listSessionsMock = vi.fn().mockResolvedValue([]);
const playNotificationSoundMock = vi.hoisted(() => vi.fn());

// Mock the API module so PostHog doesn't break in jsdom
vi.mock("./api.js", () => ({
  api: {
    getDiffStats: getDiffStatsMock,
    listSessions: listSessionsMock,
  },
}));

vi.mock("./utils/notification-sound.js", () => ({
  playNotificationSound: playNotificationSoundMock,
}));

let wsModule: typeof import("./ws.js");
let useStore: typeof import("./store.js").useStore;

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------
let lastWs: InstanceType<typeof MockWebSocket>;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });

// ---------------------------------------------------------------------------
// Fresh module state for each test
// ---------------------------------------------------------------------------
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  getDiffStatsMock.mockReset();
  getDiffStatsMock.mockResolvedValue({ stats: {} });
  listSessionsMock.mockReset();
  listSessionsMock.mockResolvedValue([]);
  playNotificationSoundMock.mockReset();
  MockWebSocket.instances = [];

  const storeModule = await import("./store.js");
  useStore = storeModule.useStore;
  useStore.getState().reset();
  localStorage.clear();

  wsModule = await import("./ws.js");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-opus-4-20250514",
    cwd: "/home/user",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "2.1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/home/user",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function fireMessage(data: Record<string, unknown>) {
  lastWs.onmessage!({ data: JSON.stringify(data) });
}

function attentionRecord(overrides: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord {
  return {
    id: "attention-1",
    leaderSessionId: "s1",
    type: "needs_input",
    source: { kind: "manual", id: "attention-1" },
    questId: "q-983",
    threadKey: "q-983",
    title: "Need decision",
    summary: "Need decision summary",
    actionLabel: "Answer",
    priority: "needs_input",
    state: "seen",
    createdAt: 100,
    updatedAt: 200,
    route: { threadKey: "q-983", questId: "q-983" },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "attention-1",
    ...overrides,
  };
}

// ===========================================================================
// Connection
// ===========================================================================
describe("handleMessage: state_snapshot", () => {
  it("updates session status, CLI connection, and askPermission from snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
    });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().cliEverConnected.get("s1")).toBe(true);
    expect(useStore.getState().askPermission.get("s1")).toBe(false);
  });

  it("keeps an idle leader idle when reconnect hydrates a running worker projection", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: { ...makeSession("s1"), isOrchestrator: true } });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
      board: [{ questId: "q-975", worker: "worker-1", workerNum: 2463, status: "WORKING" }],
      rowSessionStatuses: {
        "q-975": {
          worker: {
            sessionId: "worker-1",
            sessionNum: 2463,
            status: "running",
            activeTurnRoute: { threadKey: "q-975", questId: "q-975" },
            generationStartedAt: 123,
          },
          reviewer: null,
        },
      },
    });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
    expect(useStore.getState().sessionBoardRowStatuses.get("s1")?.["q-975"]?.worker?.status).toBe("running");
  });

  it("hydrates per-thread Codex reasoning and preserves it across an idle snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
      activeTurnRoute: { threadKey: "q-975", questId: "q-975" },
      codexReasoningPreviews: [
        {
          text: "Inspecting thread routing",
          updatedAt: 123,
          threadKey: "q-975",
          questId: "q-975",
        },
      ],
    });

    expect(useStore.getState().codexReasoningPreviews.get("s1")?.get("q-975")).toMatchObject({
      text: "Inspecting thread routing",
      threadKey: "q-975",
    });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
      codexReasoningPreviews: [
        {
          text: "Inspecting thread routing",
          updatedAt: 123,
          threadKey: "q-975",
          questId: "q-975",
        },
      ],
    });

    expect(useStore.getState().codexReasoningPreviews.get("s1")?.has("q-975")).toBe(true);
  });

  it("restores and replaces authoritative recovery progress on reconnect", () => {
    // Reconnect/restart must reconstruct recovery progress from server turn
    // ownership, not a stale composer submit remembered by this browser.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      codexAutoPauseRecoveryProgress: "active",
    });

    expect(useStore.getState().sessions.get("s1")?.codex_result_error_auto_pause_recovery_progress).toBe("active");

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      codexAutoPauseRecoveryProgress: null,
    });

    expect(useStore.getState().sessions.get("s1")?.codex_result_error_auto_pause_recovery_progress).toBeNull();
  });

  it("stores backendState and backendError from the authoritative snapshot", () => {
    // The browser should trust the server snapshot for broken/recovering
    // backend health rather than inferring it from transient local state.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      backendState: "broken",
      backendError: "Codex initialization failed: Transport closed",
      uiMode: null,
      askPermission: true,
    });

    const session = useStore.getState().sessions.get("s1");
    expect(session?.backend_state).toBe("broken");
    expect(session?.backend_error).toBe("Codex initialization failed: Transport closed");
  });

  it("hydrates authoritative same-turn provider retry state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      backendState: "recovering",
      codexProviderRetry: {
        family: "model_backend_stream_error",
        ownerId: "input-1",
        attempt: 2,
        maxAttempts: 2,
        startedAt: 100,
      },
      uiMode: null,
      askPermission: true,
    });

    expect(useStore.getState().sessions.get("s1")?.codex_provider_retry).toMatchObject({
      ownerId: "input-1",
      attempt: 2,
      maxAttempts: 2,
    });
  });

  it("replaces transient Codex stream retry state on reconnect", () => {
    // A second browser sees the same confirmed retry, and an explicit null from
    // the server retires it without relying on local activity or elapsed time.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    const snapshot = {
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "default",
      backendConnected: true,
      backendState: "connected",
      uiMode: null,
      askPermission: true,
    };
    fireMessage({ ...snapshot, codexStreamRetry: { turnId: "turn-1" } });
    expect(useStore.getState().sessions.get("s1")?.codex_stream_retry).toEqual({ turnId: "turn-1" });
    fireMessage({ ...snapshot, codexStreamRetry: null });
    expect(useStore.getState().sessions.get("s1")?.codex_stream_retry).toBeNull();
  });

  it("replaces interrupted-turn recovery state from the authoritative snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    const recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 7,
      continuationOwnerId: "continuation-owner",
      threadKey: "q-1987",
      questId: "q-1987",
      status: "continuation_pending" as const,
      reason: "interrupted_after_activity" as const,
      attempt: 1 as const,
      maxAttempts: 1 as const,
      createdAt: 100,
      updatedAt: 110,
    };

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "default",
      backendConnected: true,
      backendState: "connected",
      codexTurnRecovery: recovery,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().sessions.get("s1")?.codex_turn_recovery).toEqual(recovery);

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      backendState: "connected",
      codexTurnRecovery: null,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().sessions.get("s1")?.codex_turn_recovery).toBeNull();
  });

  it("sets backendConnected to false and sessionStatus to null when CLI is disconnected", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // First set connected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    // Then snapshot with CLI disconnected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });

  it("does not let an older state snapshot restore stale notification status", () => {
    // A reconnect snapshot can arrive after a newer global notification-status
    // update. Version ordering prevents the older inbox from reviving an amber dot.
    useStore.getState().setSdkSessions([
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      },
    ]);
    useStore.setState({ sessionAttention: new Map([["s1", null]]) });
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      attentionReason: "action",
      notifications: [{ id: "n1", category: "needs-input", timestamp: 1000, messageId: null, done: false }],
      notificationStatusVersion: 4,
      notificationStatusUpdatedAt: 4000,
    });

    const sdkSession = useStore.getState().sdkSessions.find((session) => session.sessionId === "s1")!;
    expect(sdkSession.notificationUrgency).toBeNull();
    expect(sdkSession.activeNotificationCount).toBe(0);
    expect(useStore.getState().sessionNotifications.get("s1")).toBeUndefined();
    expect(useStore.getState().sessionAttention.get("s1")).toBeNull();
  });

  it("does not recompute an authoritative snapshot count from raw historical reviews", () => {
    // q-1735 live sequence: compact summary is one, the equal-version session
    // snapshot historically carried five raw unresolved rows, and the next
    // compact refresh returned to one. Authoritative snapshot fields prevent
    // the middle payload from ever surfacing five.
    useStore.getState().setSdkSessions([
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        isOrchestrator: true,
        notificationUrgency: "review",
        activeNotificationCount: 1,
        activeReviewNotificationCount: 1,
        notificationStatusVersion: 7,
        notificationStatusUpdatedAt: 7000,
      },
    ]);
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      notifications: [
        { id: "n-old-1", category: "review", timestamp: 1000, threadKey: "q-old-1", done: false },
        { id: "n-old-2", category: "review", timestamp: 1100, threadKey: "q-old-2", done: false },
        { id: "n-old-3", category: "review", timestamp: 1200, threadKey: "q-old-3", done: false },
        { id: "n-old-4", category: "review", timestamp: 1300, threadKey: "q-old-4", done: false },
        { id: "n-current", category: "review", timestamp: 3000, threadKey: "q-current", done: false },
      ],
      notificationUrgency: "review",
      activeNotificationCount: 1,
      activeNeedsInputNotificationCount: 0,
      activeReviewNotificationCount: 1,
      mutedNeedsInputNotificationCount: 0,
      notificationStatusVersion: 7,
      notificationStatusUpdatedAt: 7000,
    });

    expect(useStore.getState().sdkSessions.find((session) => session.sessionId === "s1")).toMatchObject({
      notificationUrgency: "review",
      activeNotificationCount: 1,
      activeReviewNotificationCount: 1,
      notificationStatusVersion: 7,
    });
  });

  it("hydrates and replaces server-authoritative attention records from snapshots and live updates", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      attentionRecords: [attentionRecord({ state: "seen" })],
    });
    expect(useStore.getState().sessionAttentionRecords.get("s1")?.[0]?.state).toBe("seen");

    fireMessage({
      type: "attention_records_update",
      attentionRecords: [attentionRecord({ id: "attention-2", state: "dismissed", dedupeKey: "attention-2" })],
    });
    expect(
      useStore
        .getState()
        .sessionAttentionRecords.get("s1")
        ?.map((record) => record.state),
    ).toEqual(["dismissed"]);

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
      attentionRecords: [],
    });
    expect(useStore.getState().sessionAttentionRecords.get("s1")).toBeUndefined();
  });
});
