import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock env-manager and git-utils modules before any imports
vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => Promise.resolve([])),
  getEnv: vi.fn(() => Promise.resolve(null)),
  getEffectiveImage: vi.fn(() => Promise.resolve(null)),
  createEnv: vi.fn(() => Promise.resolve(undefined)),
  updateEnv: vi.fn(() => Promise.resolve(undefined)),
  deleteEnv: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("node:child_process", () => {
  const execSyncMock = vi.fn((_cmd?: string) => "" as any);
  // exec mock: callback-based, delegates to execSync for consistent test behavior.
  // Attaches stdout/stderr to the error object so promisify(exec) can find them,
  // matching Node's custom exec promisify behavior.
  const execMock = vi.fn((...args: any[]) => {
    const cmd = args[0] as string;
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    try {
      const result = execSyncMock(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      const e = err as any;
      if (e.stdout === undefined) e.stdout = "";
      if (e.stderr === undefined) e.stderr = "";
      if (callback) callback(err, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
    }
  });
  return { execSync: execSyncMock, exec: execMock };
});

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string) => null as string | null));
const mockExpandTilde = vi.hoisted(() => vi.fn((p: string) => p)); // pass-through by default
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((_varNames: string[]) => ({}) as Record<string, string>));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  expandTilde: mockExpandTilde,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
    access: vi.fn(async () => {}), // default: file exists (no throw)
  };
});

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  getRepoInfoAsync: vi.fn(async () => null),
  listBranches: vi.fn(() => []),
  listBranchesAsync: vi.fn(async () => []),
  listWorktrees: vi.fn(() => []),
  listWorktreesAsync: vi.fn(async () => []),
  ensureWorktree: vi.fn(),
  ensureWorktreeAsync: vi.fn(),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitFetchAsync: vi.fn(async () => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  gitPullAsync: vi.fn(async () => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
  checkoutBranchAsync: vi.fn(async () => {}),
  removeWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn(async () => ({ removed: true })),
  isWorktreeDirty: vi.fn(() => false),
  isWorktreeDirtyAsync: vi.fn(async () => false),
  archiveBranchAsync: vi.fn(async () => true),
  resolveDefaultBranch: vi.fn(() => "main"),
  getBranchStatus: vi.fn(() => ({ ahead: 0, behind: 0 })),
  deleteArchivedRefAsync: vi.fn(async () => {}),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
  getNextLeaderNumber: vi.fn(() => 1),
  _resetForTest: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: "",
    pushoverApiToken: "",
    pushoverDelaySeconds: 30,
    pushoverEnabled: true,
    pushoverEventFilters: { needsInput: true, review: true, error: true },
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    heavyRepoModeEnabled: false,
    autoApprovalEnabled: false,
    autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4,
    autoApprovalTimeoutSeconds: 45,
    namerConfig: { backend: "claude" },
    autoNamerEnabled: true,
    transcriptionConfig: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: { editor: "none" },
    defaultClaudeBackend: "claude",
    sleepInhibitorEnabled: false,
    sleepInhibitorDurationMinutes: 5,
    questmasterViewMode: "cards",
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: patch.pushoverUserKey ?? "",
    pushoverApiToken: patch.pushoverApiToken ?? "",
    pushoverDelaySeconds: patch.pushoverDelaySeconds ?? 30,
    pushoverEnabled: patch.pushoverEnabled ?? true,
    pushoverEventFilters: patch.pushoverEventFilters ?? { needsInput: true, review: true, error: true },
    pushoverBaseUrl: patch.pushoverBaseUrl ?? "",
    claudeBinary: patch.claudeBinary ?? "",
    codexBinary: patch.codexBinary ?? "",
    maxKeepAlive: patch.maxKeepAlive ?? 0,
    heavyRepoModeEnabled: patch.heavyRepoModeEnabled ?? false,
    autoApprovalEnabled: patch.autoApprovalEnabled ?? false,
    autoApprovalModel: patch.autoApprovalModel ?? "haiku",
    autoApprovalMaxConcurrency: patch.autoApprovalMaxConcurrency ?? 4,
    autoApprovalTimeoutSeconds: patch.autoApprovalTimeoutSeconds ?? 45,
    namerConfig: patch.namerConfig ?? { backend: "claude" },
    autoNamerEnabled: patch.autoNamerEnabled ?? true,
    transcriptionConfig: patch.transcriptionConfig ?? {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: patch.editorConfig ?? { editor: "none" },
    defaultClaudeBackend: patch.defaultClaudeBackend ?? "claude",
    sleepInhibitorEnabled: patch.sleepInhibitorEnabled ?? false,
    sleepInhibitorDurationMinutes: patch.sleepInhibitorDurationMinutes ?? 5,
    questmasterViewMode: patch.questmasterViewMode ?? "cards",
    updatedAt: Date.now(),
  })),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server-id"),
  getClaudeUserDefaultModel: vi.fn(async () => ""),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

const mockReadCommitDetails = vi.hoisted(() => vi.fn());
vi.mock("./git-commit-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-commit-reader.js")>()),
  readCommitDetails: mockReadCommitDetails,
}));

const mockMemoryCommitDiff = vi.hoisted(() => vi.fn());
vi.mock("./workstream-memory-service.js", () => ({
  workstreamMemoryService: {
    commitDiff: (...args: unknown[]) => mockMemoryCommitDiff(...args),
  },
}));

import { Hono } from "hono";
import { execSync, exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestratorSystemPrompt, createRoutes } from "./routes.js";
import { _resetModelCache } from "./routes/system.js";
import { trafficStats } from "./traffic-stats.js";
import { _resetServerLoggerForTest, createLogger, initServerLogger } from "./server-logger.js";
import * as serverLoggerModule from "./server-logger.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as questStore from "./quest-store.js";
import * as sessionNames from "./session-names.js";
import * as settingsManager from "./settings-manager.js";
import * as transcriptionEnhancer from "./transcription-enhancer.js";
import { containerManager } from "./container-manager.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    isAlive: vi.fn(() => true),
    relaunch: vi.fn(async () => ({ ok: true })),
    relaunchWithResumeAt: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(),
    setArchived: vi.fn(),
    setWorktreeCleanupState: vi.fn(),
    updateWorktree: vi.fn(),
    removeSession: vi.fn(),
    getOrchestratorGuardrails: vi.fn(() => "# Takode — Cross-Session Orchestration\n..."),
    getPort: vi.fn(() => 3456),
    getMemorySessionSpaceSlug: vi.fn(() => "Takode"),
    verifySessionAuthToken: vi.fn(() => true),
    herdSessions: vi.fn(() => ({ herded: [], notFound: [], conflicts: [], reassigned: [], leaders: [] })),
    unherdSession: vi.fn(() => false),
    getHerdedSessions: vi.fn(() => []),
    // resolveSessionId: pass-through for exact UUIDs (used by resolveId helper in routes)
    resolveSessionId: vi.fn((id: string) => id),
    getSessionNum: vi.fn(() => undefined),
  } as any;
}

function createMockBridge() {
  return {
    _sessions: {} as Record<string, any>,
    _vscodeSelectionState: null as any,
    _vscodeWindows: [] as any[],
    closeSession: vi.fn(),
    getSession: vi.fn(function (this: any, sessionId: string) {
      if (sessionId in this._sessions) return this._sessions[sessionId];
      const stateEntries = this.getAllSessions();
      const stateEntry = Array.isArray(stateEntries)
        ? stateEntries.find((entry: any) => entry?.session_id === sessionId || entry?.sessionId === sessionId)
        : null;
      const messageHistory = this.getMessageHistory(sessionId) ?? [];
      if (!stateEntry && messageHistory.length === 0) {
        return null;
      }
      return {
        id: sessionId,
        state: stateEntry?.state ?? stateEntry ?? {},
        messageHistory,
        notifications: [],
        pendingPermissions: new Map(),
        taskHistory: [],
        keywords: [],
        lastReadAt: 0,
        attentionReason: null,
        isGenerating: false,
      };
    }),
    getOrCreateSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    refreshWorktreeGitStateForSnapshot: vi.fn(async () => null),
    getLastUserMessage: vi.fn(() => undefined),
    isBackendConnected: vi.fn(() => false),
    markWorktree: vi.fn(),
    applyInitialSessionState: vi.fn(),
    setDiffBaseBranch: vi.fn(() => true),
    refreshGitInfoPublic: vi.fn(async () => true),
    onSessionArchived: vi.fn(),
    onSessionUnarchived: vi.fn(),
    persistSessionById: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
    getVsCodeSelectionState: vi.fn(function (this: any) {
      return this._vscodeSelectionState;
    }),
    updateVsCodeSelectionState: vi.fn(function (this: any, state: any) {
      this._vscodeSelectionState = state;
      return true;
    }),
    getVsCodeWindowStates: vi.fn(function (this: any) {
      return this._vscodeWindows;
    }),
    upsertVsCodeWindowState: vi.fn(function (this: any, state: any) {
      const next = {
        ...state,
        workspaceRoots: [...(state.workspaceRoots ?? [])],
        lastSeenAt: 9999,
      };
      this._vscodeWindows = [...this._vscodeWindows.filter((window: any) => window.sourceId !== state.sourceId), next];
      return next;
    }),
    pollVsCodeOpenFileCommands: vi.fn(() => []),
    resolveVsCodeOpenFileResult: vi.fn(() => true),
    requestVsCodeOpenFile: vi.fn(async () => ({ sourceId: "window-a", commandId: "cmd-1" })),
    addTaskEntry: vi.fn(),
    updateQuestTaskEntries: vi.fn(),
    removeBoardRowFromAll: vi.fn(),
    prepareSessionForRevert: vi.fn(
      (sessionId: string, truncateIdx: number, options?: { clearCodexState?: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        if (!session) return null;
        session.messageHistory = session.messageHistory.slice(0, truncateIdx);
        session.frozenCount = Math.min(session.frozenCount ?? 0, session.messageHistory.length);
        session.assistantAccumulator?.clear?.();
        session.pendingMessages = [];
        session.lastOutboundUserNdjson = null;
        session.userMessageIdsThisTurn = [];
        session.queuedTurnStarts = 0;
        session.queuedTurnReasons = [];
        session.queuedTurnUserMessageIds = [];
        session.queuedTurnInterruptSources = [];
        session.interruptedDuringTurn = false;
        session.interruptSourceDuringTurn = null;
        session.isGenerating = false;
        session.generationStartedAt = null;
        session.disconnectWasGenerating = false;
        session.seamlessReconnect = false;
        session.toolStartTimes?.clear?.();
        session.toolProgressOutput?.clear?.();
        session.dropReplayHistoryAfterRevert = session.backendType === "claude" || session.backendType === "claude-sdk";
        session.pendingPermissions?.clear?.();
        session.eventBuffer = [];
        session.awaitingCompactSummary = false;
        session.claudeCompactBoundarySeen = false;
        session.compactedDuringTurn = false;
        session.forceCompactPending = false;
        if (session.state) session.state.is_compacting = false;
        if (options?.clearCodexState) {
          session.pendingCodexTurns = [];
          session.pendingCodexInputs = [];
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = null;
          if (session.optimisticRunningTimer) session.optimisticRunningTimer = null;
          bridge.broadcastToSession(sessionId, { type: "codex_pending_inputs", inputs: [] });
        }
        bridge.broadcastToSession(sessionId, { type: "permissions_cleared" });
        return session;
      },
    ),
    beginCodexRollback: vi.fn(
      (sessionId: string, plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        const adapter = session?.codexAdapter;
        if (adapter?.isConnected?.() && adapter.rollbackTurns) {
          return {
            promise: adapter.rollbackTurns(plan.numTurns).then(() => {
              const reverted = bridge.prepareSessionForRevert(sessionId, plan.truncateIdx, {
                clearCodexState: plan.clearCodexState,
              });
              bridge.persistSessionSync(sessionId);
              bridge.broadcastToSession(sessionId, { type: "message_history", messages: reverted.messageHistory });
              bridge.broadcastToSession(sessionId, { type: "status_change", status: "idle" });
            }),
            requiresRelaunch: false,
          };
        }
        return { promise: Promise.resolve(), requiresRelaunch: true };
      },
    ),
    persistSessionSync: vi.fn(),
    getMessageHistory: vi.fn(() => []),
    getToolResult: vi.fn(() => null),
    injectUserMessage: vi.fn(() => "sent" as const),
    emitTakodeEvent: vi.fn(),
    subscribeTakodeEvents: vi.fn(() => () => {}),
    routeExternalPermissionResponse: vi.fn(),
    routeExternalInterrupt: vi.fn(async () => {}),
    routeBrowserMessage: vi.fn(function (this: any, session: any, msg: any) {
      if (msg?.type === "permission_response") {
        return this.routeExternalPermissionResponse(
          session,
          {
            type: "permission_response",
            request_id: msg.request_id,
            behavior: msg.behavior,
            ...(msg.updated_input ? { updated_input: msg.updated_input } : {}),
            ...(msg.message ? { message: msg.message } : {}),
          },
          msg.actorSessionId,
        );
      }
      if (msg?.type === "interrupt") {
        return this.routeExternalInterrupt(session, msg.interruptSource);
      }
      return undefined;
    }),
    getTrafficStatsSnapshot: vi.fn(() => ({
      windowStartedAt: 1000,
      capturedAt: 2000,
      totals: { messages: 1, payloadBytes: 10, wireBytes: 10 },
      buckets: [],
      sessions: {},
      historySyncBreakdown: {
        totals: {
          requests: 0,
          frozenDeltaBytes: 0,
          hotMessagesBytes: 0,
          frozenDeltaMessages: 0,
          hotMessagesCount: 0,
        },
        sessions: {},
      },
      toolResultFetches: {
        totals: { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 },
        sessions: {},
        topRepeated: [],
      },
    })),
    resetTrafficStats: vi.fn(),
  } as any;
}

function ensureBridgeSession(
  bridge: ReturnType<typeof createMockBridge>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return (bridge._sessions[sessionId] = {
    id: sessionId,
    state: {},
    browserSockets: new Set(),
    messageHistory: [],
    notifications: [],
    pendingPermissions: new Map(),
    taskHistory: [],
    keywords: [],
    lastReadAt: 0,
    attentionReason: null,
    isGenerating: false,
    ...overrides,
  });
}

function createMockStore() {
  return {
    setArchived: vi.fn(async () => true),
    flushAll: vi.fn(async () => {}),
  } as any;
}

function createMockRecorder() {
  return {
    getRecordingsDir: vi.fn(() => "/tmp/companion-recordings"),
    isGloballyEnabled: vi.fn(() => true),
    getMaxLines: vi.fn(() => 500000),
    isRecording: vi.fn(() => true),
    getRecordingStatus: vi.fn(() => ({ filePath: "/tmp/companion-recordings/session-1.jsonl" })),
    enableForSession: vi.fn(),
    disableForSession: vi.fn(),
    listRecordings: vi.fn(async () => []),
  } as any;
}

function createMockTimerManager() {
  return {
    createTimer: vi.fn(),
    listTimers: vi.fn(() => []),
    cancelTimer: vi.fn(async () => true),
    cancelAllTimers: vi.fn(async () => {}),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let app: Hono;
let launcher: ReturnType<typeof createMockLauncher>;
let bridge: ReturnType<typeof createMockBridge>;
let sessionStore: ReturnType<typeof createMockStore>;
let tracker: ReturnType<typeof createMockTracker>;
let recorder: ReturnType<typeof createMockRecorder>;
let timerManager: ReturnType<typeof createMockTimerManager>;

beforeEach(() => {
  vi.clearAllMocks();
  trafficStats.reset();
  _resetServerLoggerForTest();
  // Reset the LiteLLM model cache so each test starts clean.
  _resetModelCache();
  // Stub global fetch to prevent LiteLLM proxy calls in tests.
  // Model endpoint tests exercise the fallback path (models_cache.json).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no proxy in tests"))),
  );
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  recorder = createMockRecorder();
  timerManager = createMockTimerManager();
  app = new Hono();
  const terminalManager = { getInfo: () => null, spawn: () => "", kill: () => {} } as any;
  app.route(
    "/api",
    createRoutes(
      launcher,
      bridge,
      sessionStore,
      tracker,
      terminalManager,
      undefined,
      recorder,
      undefined,
      timerManager,
    ),
  );

  // Default no-op mocks for container workspace isolation (called during container session creation)
  vi.spyOn(containerManager, "copyWorkspaceToContainer").mockResolvedValue(undefined);
  vi.spyOn(containerManager, "reseedGitAuth").mockImplementation(() => {});
});

// ─── Sessions ────────────────────────────────────────────────────────────────

// ─── SSE Session Creation Streaming ──────────────────────────────────────────

describe("POST /api/quests", () => {
  it("defaults quest session-space metadata from the authenticated creator session", async () => {
    vi.spyOn(questStore, "createQuest").mockImplementationOnce(async (input: any) => ({
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: input.title,
      status: "idea",
      createdAt: Date.now(),
      sessionSpaceSlug: input.sessionSpaceSlug,
    }));
    launcher.getSession.mockImplementation((sessionId: string) =>
      sessionId === "creator" ? ({ sessionId, memorySessionSpaceSlug: "MSI" } as any) : undefined,
    );

    const res = await app.request("/api/quests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-companion-session-id": "creator",
        "x-companion-auth-token": "token",
      },
      body: JSON.stringify({ title: "Creator quest" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ questId: "q-1", sessionSpaceSlug: "MSI" });
    expect(questStore.createQuest).toHaveBeenCalledWith(expect.objectContaining({ sessionSpaceSlug: "MSI" }));
  });

  it("lets explicit quest session-space metadata override the authenticated creator default", async () => {
    vi.spyOn(questStore, "createQuest").mockImplementationOnce(async (input: any) => ({
      id: "q-1-v1",
      questId: "q-1",
      version: 1,
      title: input.title,
      status: "idea",
      createdAt: Date.now(),
      sessionSpaceSlug: input.sessionSpaceSlug,
    }));
    launcher.getSession.mockImplementation((sessionId: string) =>
      sessionId === "creator" ? ({ sessionId, memorySessionSpaceSlug: "MSI" } as any) : undefined,
    );

    const res = await app.request("/api/quests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-companion-session-id": "creator",
        "x-companion-auth-token": "token",
      },
      body: JSON.stringify({ title: "Override quest", sessionSpaceSlug: "Other" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ questId: "q-1", sessionSpaceSlug: "Other" });
    expect(questStore.createQuest).toHaveBeenCalledWith(expect.objectContaining({ sessionSpaceSlug: "Other" }));
  });
});
/** Parse an SSE response body into an array of {event, data} objects */
async function parseSSE(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const events: { event: string; data: string }[] = [];
  // SSE frames are separated by double newlines
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) events.push({ event, data });
  }
  return events;
}

describe("GET /api/quests/:questId/commits/:sha", () => {
  const fullSha = "abc1234" + "0".repeat(33);
  const comparison = { method: "first-parent-v1", baseSha: "0".repeat(40), parentCount: 1 };
  const details = {
    sha: fullSha,
    shortSha: "abc1234",
    message: "Attach commits to quests",
    timestamp: 1713292534000,
    comparison,
  };

  it.each([
    true,
    false,
  ])("uses the immutable delivery repository when its objects are available=%s", async (available) => {
    // Recorded provenance must survive a changed session target; missing objects never substitute another repo.
    const sha = "a".repeat(40);
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      questId: "q-1",
      status: "done",
      sessionId: "session-1",
      commitShas: [sha],
      codeDeliveries: [{ target: { repoRoot: "/independent/published" }, commits: [{ sha }] }],
    } as any);
    launcher.getSession.mockReturnValue({ sessionId: "session-1", repoRoot: "/unrelated/current" } as any);
    mockReadCommitDetails.mockImplementation(async () => {
      if (!available) throw new Error("Retained objects unavailable");
      return { ...details, sha, message: "Independent delivery" };
    });
    const res = await app.request(`/api/quests/q-1/commits/${sha}?includeDiff=false`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(
      available
        ? { available: true, message: "Independent delivery" }
        : { available: false, reason: "commit_not_available" },
    );
    expect(mockReadCommitDetails).toHaveBeenCalledExactlyOnceWith("/independent/published", sha, false, 512 * 1024);
  });

  it("returns git-backed commit details for a SHA attached to the quest", async () => {
    // Git-plumbing reconciliation is exercised with real merges in git-commit-reader.test.ts.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      questId: "q-1",
      status: "done",
      sessionId: "session-1",
      commitShas: ["abc1234"],
    } as any);
    launcher.getSession.mockReturnValue({ sessionId: "session-1", cwd: "/repo/worktree", repoRoot: "/repo" } as any);
    mockReadCommitDetails.mockResolvedValue({
      ...details,
      additions: 15,
      deletions: 4,
      splitStats: { code: { additions: 12, deletions: 4 }, tests: { additions: 3, deletions: 0 } },
      diff: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n",
      truncated: false,
    });
    const res = await app.request("/api/quests/q-1/commits/abc1234");
    expect(res.status).toBe(200);
    const value = await res.json();
    expect(value).toMatchObject({
      ...details,
      additions: 15,
      deletions: 4,
      available: true,
      splitStats: { code: { additions: 12, deletions: 4 }, tests: { additions: 3, deletions: 0 } },
    });
    expect(value.diff).toContain("diff --git");
    expect(mockReadCommitDetails).toHaveBeenCalledWith("/repo", "abc1234", true, 512 * 1024);
  });

  it("returns an unavailable state when the commit cannot be found locally", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      questId: "q-1",
      status: "done",
      sessionId: "session-1",
      commitShas: ["deadbee"],
    } as any);
    launcher.getSession.mockReturnValue({ sessionId: "session-1", cwd: "/repo/worktree", repoRoot: "/repo" } as any);
    mockReadCommitDetails.mockRejectedValue(new Error("unknown revision"));
    const res = await app.request("/api/quests/q-1/commits/deadbee");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sha: "deadbee", available: false, reason: "commit_not_available" });
  });

  it("can return code commit metadata without loading the patch", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      questId: "q-1",
      status: "done",
      sessionId: "session-1",
      commitShas: ["abc1234"],
    } as any);
    launcher.getSession.mockReturnValue({ sessionId: "session-1", cwd: "/repo/worktree", repoRoot: "/repo" } as any);
    mockReadCommitDetails.mockResolvedValue({ ...details, message: "Readable title" });
    const res = await app.request("/api/quests/q-1/commits/abc1234?includeDiff=false");
    expect(res.status).toBe(200);
    const value = await res.json();
    expect(value).toMatchObject({ ...details, message: "Readable title", available: true });
    expect(value.diff).toBeUndefined();
    expect(value.additions).toBeUndefined();
    expect(mockReadCommitDetails).toHaveBeenCalledWith("/repo", "abc1234", false, 512 * 1024);
  });

  it("keeps historical saved stats distinct from the current parent comparison in the ordinary viewer", async () => {
    const saved = { ...details, additions: 90, deletions: 20, binaryFiles: 0, comparison: undefined };
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      questId: "q-1",
      status: "done",
      commitShas: [fullSha],
      codeDeliveries: [{ target: { repoRoot: "/independent/published" }, commits: [saved] }],
    } as any);
    mockReadCommitDetails.mockResolvedValue({ ...details, additions: 1, deletions: 1, binaryFiles: 0, diff: "patch" });
    const value = await (await app.request(`/api/quests/q-1/commits/${fullSha}`)).json();
    expect(value).toMatchObject({
      additions: 1,
      deletions: 1,
      comparison,
      recordedStats: { additions: 90, deletions: 20 },
    });
    expect(saved.comparison).toBeUndefined();
  });
});

describe("GET /api/quests/:questId/memory-commits/:sha", () => {
  it("returns memory commit details for a SHA attached to the quest", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [{ text: "verify", checked: false }],
      memoryCommitShas: ["abc1234"],
    } as any);
    mockMemoryCommitDiff.mockResolvedValueOnce({
      repo: { root: "/memory", serverId: "s", serverSlug: "prod", sessionSpaceSlug: "Takode", initialized: true },
      commit: {
        sha: "abc1234567890abcdef",
        shortSha: "abc1234",
        timestamp: 1713292534000,
        message: "Record memory decision",
        authorName: "Takode",
        authorEmail: "takode-memory@local",
        actor: null,
        quest: "q-1",
        session: null,
        sources: ["q-1"],
        changedFiles: [{ status: "M", path: "decisions/example.md" }],
      },
      diff: "diff --git a/decisions/example.md b/decisions/example.md\n",
      sourceFiles: [
        {
          status: "M",
          path: "decisions/example.md",
          oldText: "old\n",
          newText: "new\n",
        },
      ],
    });

    const res = await app.request("/api/quests/q-1/memory-commits/abc1234", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sha: "abc1234567890abcdef",
      shortSha: "abc1234",
      message: "Record memory decision",
      diff: expect.stringContaining("diff --git"),
      sourceFiles: [{ path: "decisions/example.md", oldText: "old\n", newText: "new\n" }],
      available: true,
    });
    expect(mockMemoryCommitDiff).toHaveBeenCalledWith({ sessionSpaceSlug: "Takode", readOnly: true }, "abc1234");
  });

  it("resolves memory commits from the quest Journey worker memory space", async () => {
    // This covers done quests like q-1489, where the attached memory commit was
    // authored in MSI even though the viewer request runs from a Takode session.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [],
      memoryCommitShas: ["abc1234"],
      journeyRuns: [
        {
          runId: "run-1",
          workerSessionId: "worker-msi",
          source: "board",
          phaseIds: ["alignment", "memory"],
          status: "completed",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          phaseOccurrences: [],
        },
      ],
    } as any);
    launcher.getSession.mockImplementation((sessionId: string) =>
      sessionId === "worker-msi" ? ({ sessionId, memorySessionSpaceSlug: "MSI" } as any) : undefined,
    );
    mockMemoryCommitDiff.mockResolvedValueOnce({
      repo: { root: "/memory/prod/MSI", serverId: "s", serverSlug: "prod", sessionSpaceSlug: "MSI", initialized: true },
      commit: {
        sha: "abc1234567890abcdef",
        shortSha: "abc1234",
        timestamp: 1713292534000,
        message: "Record MSI memory",
        authorName: "Takode",
        authorEmail: "takode-memory@local",
        actor: null,
        quest: "q-1",
        session: "worker-msi",
        sources: ["q-1"],
        changedFiles: [{ status: "M", path: "current/slack-reading-state.md" }],
      },
      diff: "diff --git a/current/slack-reading-state.md b/current/slack-reading-state.md\n",
      sourceFiles: [],
    });

    const res = await app.request("/api/quests/q-1/memory-commits/abc1234?includeDiff=false", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sha: "abc1234567890abcdef",
      shortSha: "abc1234",
      message: "Record MSI memory",
      available: true,
    });
    expect(mockMemoryCommitDiff).toHaveBeenCalledTimes(1);
    expect(mockMemoryCommitDiff).toHaveBeenCalledWith({ sessionSpaceSlug: "MSI", readOnly: true }, "abc1234");
  });

  it("resolves memory commits from explicit quest session-space metadata first", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [],
      sessionSpaceSlug: "MSI",
      previousOwnerSessionIds: ["worker-takode"],
      memoryCommitShas: ["abc1234"],
    } as any);
    launcher.getSession.mockImplementation((sessionId: string) =>
      sessionId === "worker-takode" ? ({ sessionId, memorySessionSpaceSlug: "Takode" } as any) : undefined,
    );
    mockMemoryCommitDiff.mockResolvedValueOnce({
      repo: { root: "/memory/prod/MSI", serverId: "s", serverSlug: "prod", sessionSpaceSlug: "MSI", initialized: true },
      commit: {
        sha: "abc1234567890abcdef",
        shortSha: "abc1234",
        timestamp: 1713292534000,
        message: "Record explicit space",
        authorName: "Takode",
        authorEmail: "takode-memory@local",
        actor: null,
        quest: "q-1",
        session: null,
        sources: ["q-1"],
        changedFiles: [{ status: "M", path: "current/state.md" }],
      },
      diff: "diff --git a/current/state.md b/current/state.md\n",
      sourceFiles: [],
    });

    const res = await app.request("/api/quests/q-1/memory-commits/abc1234?includeDiff=false", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      message: "Record explicit space",
      available: true,
    });
    expect(mockMemoryCommitDiff).toHaveBeenCalledTimes(1);
    expect(mockMemoryCommitDiff).toHaveBeenCalledWith({ sessionSpaceSlug: "MSI", readOnly: true }, "abc1234");
  });

  it("rejects memory commits that are not attached to the quest", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [],
      memoryCommitShas: ["abc1234"],
    } as any);

    const res = await app.request("/api/quests/q-1/memory-commits/deadbee", { method: "GET" });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "Memory commit not attached to this quest" });
    expect(mockMemoryCommitDiff).not.toHaveBeenCalled();
  });

  it("reports attached memory commits as unavailable after provenance and default spaces miss", async () => {
    // A stale or cross-space SHA should stay gracefully unavailable after every
    // read-only candidate misses instead of being treated as a route/session failure.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [],
      previousOwnerSessionIds: ["worker-msi"],
      memoryCommitShas: ["abc1234"],
    } as any);
    launcher.getSession.mockImplementation((sessionId: string) =>
      sessionId === "worker-msi" ? ({ sessionId, memorySessionSpaceSlug: "MSI" } as any) : undefined,
    );
    mockMemoryCommitDiff.mockResolvedValue(null);

    const res = await app.request("/api/quests/q-1/memory-commits/abc1234", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sha: "abc1234",
      available: false,
      reason: "commit_not_available",
    });
    expect(mockMemoryCommitDiff).toHaveBeenNthCalledWith(1, { sessionSpaceSlug: "MSI", readOnly: true }, "abc1234");
    expect(mockMemoryCommitDiff).toHaveBeenNthCalledWith(2, { sessionSpaceSlug: "Takode", readOnly: true }, "abc1234");
  });

  it("reports attached memory commits as unavailable when the local memory repo cannot resolve them", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      claimedAt: Date.now(),
      verificationItems: [],
      memoryCommitShas: ["abc1234"],
    } as any);
    mockMemoryCommitDiff.mockResolvedValueOnce(null);

    const res = await app.request("/api/quests/q-1/memory-commits/abc1234", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      sha: "abc1234",
      available: false,
      reason: "commit_not_available",
    });
    expect(mockMemoryCommitDiff).toHaveBeenCalledWith({ sessionSpaceSlug: "Takode", readOnly: true }, "abc1234");
  });
});
