import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockShouldSettingsRuleApprove = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "test-uuid",
}));
// Mock settings rule loading so real user ~/.claude/settings.json rules don't
// interfere with tests. Tests that need specific rules override this per-call.
vi.mock("./bridge/settings-rule-matcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bridge/settings-rule-matcher.js")>();
  return {
    ...original,
    shouldSettingsRuleApprove: mockShouldSettingsRuleApprove,
  };
});

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { HerdEventDispatcher, isSessionIdleRuntime, renderHerdEventBatch } from "./herd-event-dispatcher.js";
import {
  advanceBoardRow as advanceBoardRowController,
  advanceBoardRowNoGroom as advanceBoardRowNoGroomController,
  getBoard as getBoardController,
  getCompletedBoard as getCompletedBoardController,
  removeBoardRows as removeBoardRowsController,
  upsertBoardRow as upsertBoardRowController,
} from "./bridge/board-watchdog-controller.js";
import {
  cleanupBranchState as cleanupBranchStateIndex,
  updateBranchIndex as updateBranchIndexState,
} from "./bridge/branch-session-index.js";
import { routeBrowserMessage as routeBrowserMessageController } from "./bridge/adapter-browser-routing-controller.js";
import {
  getVsCodeSelectionState as getVsCodeSelectionStateController,
  getVsCodeWindowStates as getVsCodeWindowStatesController,
  pollVsCodeOpenFileCommands as pollVsCodeOpenFileCommandsController,
  requestVsCodeOpenFile as requestVsCodeOpenFileController,
  resolveVsCodeOpenFileResult as resolveVsCodeOpenFileResultController,
  updateVsCodeSelectionState as updateVsCodeSelectionStateController,
  upsertVsCodeWindowState as upsertVsCodeWindowStateController,
} from "./bridge/browser-transport-controller.js";
import {
  refreshGitInfoPublic as refreshGitInfoPublicController,
  setDiffBaseBranch as setDiffBaseBranchController,
} from "./bridge/session-git-state.js";
import { trafficStats } from "./traffic-stats.js";
import {
  applyInitialSessionState as applyInitialSessionStateController,
  addTaskEntry as addTaskEntryController,
  clearAttentionAndMarkRead as clearAttentionAndMarkReadController,
  getHerdDiagnostics as getHerdDiagnosticsController,
  markNotificationDone as markNotificationDoneController,
  notifyUser as notifyUserController,
  setSessionClaimedQuest as setSessionClaimedQuestController,
} from "./bridge/session-registry-controller.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { TurnSteerFailureInfo } from "./bridge/adapter-interface.js";
import {
  codexNativeSubagentChildIdForProviderThread,
  createCodexNativeSubagentRegistry,
} from "./codex-native-subagent-state.js";

function createMockSocket(data: SocketData) {
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

function makeCliSocket(sessionId: string) {
  return createMockSocket({ kind: "cli", sessionId });
}

function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

/** Flush all pending microtasks and setTimeout(0) callbacks so async sendHistorySync and deferred traffic stats complete. */
async function flushAsync() {
  // Flush microtasks (queueMicrotask in traffic stats)
  await Promise.resolve();
  // Flush setTimeout(0) (yieldToEventLoop in sendHistorySync)
  await new Promise((r) => setTimeout(r, 0));
  // One more microtask pass for any traffic stats queued after the yield
  await Promise.resolve();
}

function makeCodexAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let onTurnSteeredCb: ((turnId: string, pendingInputIds: string[]) => void) | undefined;
  let onTurnSteerFailedCb: ((pendingInputIds: string[], info?: TurnSteerFailureInfo) => void) | undefined;
  let currentTurnId: string | null = null;
  const rollbackTurns = vi.fn(async (_numTurns: number) => {});

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => {
      onTurnStartFailedCb = cb;
    }),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => {
      onTurnStartedCb = cb;
    }),
    onTurnSteered: vi.fn((cb: (turnId: string, pendingInputIds: string[]) => void) => {
      onTurnSteeredCb = cb;
    }),
    onTurnSteerFailed: vi.fn((cb: (pendingInputIds: string[], info?: TurnSteerFailureInfo) => void) => {
      onTurnSteerFailedCb = cb;
    }),
    sendBrowserMessage: vi.fn((_msg?: any) => true),
    rollbackTurns,
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    getThreadId: vi.fn(() => "thread-ready"),
    getCurrentTurnId: vi.fn(() => currentTurnId),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: (turnId?: string | null) => {
      currentTurnId = turnId === undefined ? currentTurnId : turnId;
      onDisconnectCb?.();
    },
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitTurnStartFailed: (msg: any) => onTurnStartFailedCb?.(msg),
    emitTurnStarted: (turnId: string) => {
      currentTurnId = turnId;
      onTurnStartedCb?.(turnId);
    },
    emitTurnSteered: (turnId: string, pendingInputIds: string[]) => {
      onTurnSteeredCb?.(turnId, pendingInputIds);
    },
    emitTurnSteerFailed: (pendingInputIds: string[], info?: TurnSteerFailureInfo) => {
      if (info?.kind === "no_active_turn") currentTurnId = null;
      onTurnSteerFailedCb?.(pendingInputIds, info);
    },
    setCurrentTurnIdForTest: (turnId: string | null) => {
      currentTurnId = turnId;
    },
  };
}

function emitCodexSessionReady(
  adapter: ReturnType<typeof makeCodexAdapterMock>,
  overrides: Record<string, unknown> = {},
) {
  adapter.emitSessionMeta({
    cliSessionId: "thread-ready",
    model: "gpt-5.3-codex",
    cwd: "/repo",
    ...overrides,
  });
}

function getPendingCodexTurn(session: { pendingCodexTurns?: unknown[] }) {
  return (session.pendingCodexTurns?.[0] ?? null) as any;
}

function getCodexStartPendingInputs(msg: any) {
  expect(msg?.type).toBe("codex_start_pending");
  expect(Array.isArray(msg?.inputs)).toBe(true);
  return msg.inputs as Array<{ content: string }>;
}

function seedStaleCodexPendingDeliveryHead(
  session: any,
  options: {
    status?: "queued" | "backend_acknowledged";
    inputs?: Array<{ id: string; content: string }>;
  } = {},
) {
  const status = options.status ?? "backend_acknowledged";
  const now = Date.now();
  const inputs = options.inputs ?? [
    { id: "old-input-1", content: "old pending instruction one" },
    { id: "old-input-2", content: "old pending instruction two" },
  ];
  const pendingInputIds = inputs.map((input) => input.id);

  session.pendingCodexInputs.push(
    ...inputs.map((input) => ({
      id: input.id,
      content: input.content,
      timestamp: now - 120_000,
      cancelable: true,
    })),
  );

  const turn = {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds,
      inputs: inputs.map((input) => ({ content: input.content })),
    },
    userMessageId: pendingInputIds[0],
    pendingInputIds,
    userContent: inputs.map((input) => input.content).join("\n\n"),
    historyIndex: -1,
    status,
    dispatchCount: status === "queued" ? 0 : 1,
    createdAt: now - 120_000,
    updatedAt: now - 90_000,
    acknowledgedAt: status === "backend_acknowledged" ? now - 90_000 : null,
    turnTarget: status === "backend_acknowledged" ? "queued" : null,
    lastError: null,
    turnId: null,
    disconnectedAt: status === "backend_acknowledged" ? now - 80_000 : null,
    resumeConfirmedAt: null,
  };
  session.pendingCodexTurns.push(turn);
  return turn;
}

function getNotificationTestDeps(bridge: WsBridge) {
  return {
    isHerdedWorkerSession: (session: any) => !!(bridge as any).launcher?.getSession(session.id)?.herdedBy,
    broadcastToBrowsers: (session: any, msg: any) => bridge.broadcastToSession(session.id, msg),
    persistSession: (session: any) => bridge.persistSessionById(session.id),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      bridge.emitTakodeEvent(sessionId, type as any, data as any),
    scheduleNotification: () => undefined,
  };
}

function applyClaimedQuest(
  bridge: WsBridge,
  sessionId: string,
  quest: { id: string; title: string; status?: string } | null,
) {
  const session = bridge.getSession(sessionId);
  if (!session) return;
  setSessionClaimedQuestController(session, quest, {
    broadcastToBrowsers: (_session: any, msg: any) => bridge.broadcastToSession(sessionId, msg),
    persistSession: () => bridge.persistSessionById(sessionId),
    getLauncherSessionInfo: (targetSessionId: string) => (bridge as any).launcher?.getSession?.(targetSessionId),
    onSessionNamedByQuest: (targetSessionId: string, title: string) =>
      (bridge as any).onSessionNamedByQuest?.(targetSessionId, title),
  });
}

type TestBridge = WsBridge & {
  setStore(store: SessionStore): void;
  setRecorder(recorder: any): void;
  setTimerManager(timerManager: any): void;
  setImageStore(imageStore: any): void;
  setPushoverNotifier(notifier: any): void;
  setLauncher(launcher: any): void;
  setHerdEventDispatcher(dispatcher: any): void;
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => void): void;
  onPermissionModeChangedCallback(cb: (sessionId: string, newMode: string) => void): void;
  onSessionRelaunchRequestedCallback(cb: (sessionId: string) => void): void;
  onUserMessageCallback(cb: any): void;
  onTurnCompletedCallback(cb: any): void;
  onAgentPausedCallback(cb: any): void;
  applyInitialSessionState(sessionId: string, options: any): void;
  markWorktree(
    sessionId: string,
    repoRoot: string,
    worktreeCwd: string,
    defaultBranch?: string,
    diffBaseBranch?: string,
  ): void;
  getTrafficStatsSnapshot(): any;
  resetTrafficStats(): void;
  setDiffBaseBranch(sessionId: string, branch: string): boolean;
  refreshGitInfoPublic(
    sessionId: string,
    options?: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
  ): Promise<boolean>;
  onSessionArchived(sessionId: string): void;
  onSessionUnarchived(sessionId: string): void;
  getBoard(sessionId: string): any[];
  upsertBoardRow(sessionId: string, row: any): any[] | null;
  removeBoardRows(sessionId: string, questIds: string[]): any[] | null;
  advanceBoardRow(sessionId: string, questId: string): any;
  advanceBoardRowNoGroom(sessionId: string, questId: string): any;
  getCompletedBoard(sessionId: string): any[];
  getCompletedBoardCount(sessionId: string): number;
  getVsCodeSelectionState(): any;
  updateVsCodeSelectionState(nextState: any): boolean;
  getVsCodeWindowStates(): any[];
  upsertVsCodeWindowState(nextState: any): any;
  pollVsCodeOpenFileCommands(sourceId: string, limit?: number): any[];
  resolveVsCodeOpenFileResult(sourceId: string, commandId: string, result: { ok: boolean; error?: string }): boolean;
  requestVsCodeOpenFile(
    target: any,
    options?: { timeoutMs?: number },
  ): Promise<{ sourceId: string; commandId: string }>;
};

function attachBoardFacade(bridge: WsBridge): TestBridge {
  const anyBridge = bridge as any;
  anyBridge.setStore = (store: SessionStore) => {
    bridge.store = store;
  };
  anyBridge.setRecorder = (recorder: any) => {
    bridge.recorder = recorder;
  };
  anyBridge.setTimerManager = (timerManager: any) => {
    bridge.timerManager = timerManager;
  };
  anyBridge.setImageStore = (imageStore: any) => {
    bridge.imageStore = imageStore;
  };
  anyBridge.setPushoverNotifier = (notifier: any) => {
    bridge.pushoverNotifier = notifier;
  };
  anyBridge.setLauncher = (launcher: any) => {
    bridge.launcher = launcher;
  };
  anyBridge.setHerdEventDispatcher = (dispatcher: any) => {
    bridge.herdEventDispatcher = dispatcher;
  };
  anyBridge.onCLIRelaunchNeededCallback = (cb: (sessionId: string) => void) => {
    bridge.onCLIRelaunchNeeded = cb;
  };
  anyBridge.onPermissionModeChangedCallback = (cb: (sessionId: string, newMode: string) => void) => {
    bridge.onPermissionModeChanged = cb;
  };
  anyBridge.onSessionRelaunchRequestedCallback = (cb: (sessionId: string) => void) => {
    bridge.onSessionRelaunchRequested = cb;
  };
  anyBridge.onUserMessageCallback = (cb: any) => {
    bridge.onUserMessage = cb;
  };
  anyBridge.onTurnCompletedCallback = (cb: any) => {
    bridge.onTurnCompleted = cb;
  };
  anyBridge.onAgentPausedCallback = (cb: any) => {
    bridge.onAgentPaused = cb;
  };
  bridge.herdEventDispatcher = new HerdEventDispatcher(
    {
      subscribeTakodeEvents: () => () => {},
      injectUserMessage: () => "no_session",
      getSession: (sessionId: string) => bridge.getSession(sessionId) as any,
    },
    {
      getHerdedSessions: (orchId: string) => bridge.launcher?.getHerdedSessions?.(orchId) ?? [],
      getSession: (sessionId: string) => bridge.launcher?.getSession?.(sessionId),
    },
    {
      requestCliRelaunch: (sessionId: string) => bridge.onCLIRelaunchNeeded?.(sessionId),
      getSessionNum: (sessionId: string) => bridge.launcher?.getSessionNum?.(sessionId),
      getSessionName: (sessionId: string) => bridge.sessionNameGetter?.(sessionId),
      getSessions: () => anyBridge.sessions,
      getLeaderIdleDeps: () => anyBridge.getSessionRegistryDeps(),
    },
  );
  anyBridge.applyInitialSessionState = (sessionId: string, options: any) => {
    const session = bridge.getOrCreateSession(sessionId);
    applyInitialSessionStateController(session as any, options, {
      persistSession: (targetSession) => bridge.persistSessionById((targetSession as any).id),
      prefillSlashCommands: (targetSession) => anyBridge.prefillSlashCommands.call(anyBridge, targetSession),
    });
  };
  anyBridge.markWorktree = (
    sessionId: string,
    repoRoot: string,
    worktreeCwd: string,
    defaultBranch?: string,
    diffBaseBranch?: string,
  ) => {
    anyBridge.applyInitialSessionState(sessionId, {
      cwd: worktreeCwd,
      worktree: { repoRoot, defaultBranch, diffBaseBranch },
    });
  };
  anyBridge.getTrafficStatsSnapshot = () => trafficStats.snapshot();
  anyBridge.resetTrafficStats = () => {
    trafficStats.reset();
  };
  anyBridge.setDiffBaseBranch = (sessionId: string, branch: string) => {
    const session = bridge.getSession(sessionId);
    if (!session) return false;
    setDiffBaseBranchController(session as any, branch, anyBridge.getSessionGitStateDeps());
    return true;
  };
  anyBridge.refreshGitInfoPublic = async (
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ) => {
    const session = bridge.getSession(sessionId);
    if (!session) return false;
    await refreshGitInfoPublicController(session as any, anyBridge.getSessionGitStateDeps(), options);
    return true;
  };
  anyBridge.onSessionArchived = (sessionId: string) => {
    cleanupBranchStateIndex(sessionId, {
      branchToSessions: anyBridge.branchToSessions,
      sessionBranches: anyBridge.sessionBranches,
      lastCrossSessionRefreshAt: anyBridge.lastCrossSessionRefreshAt,
    });
  };
  anyBridge.onSessionUnarchived = (sessionId: string) => {
    const session = bridge.getSession(sessionId);
    if (!session) return;
    updateBranchIndexState(session, {
      isArchived: bridge.launcher?.getSession(session.id)?.archived === true,
      branchToSessions: anyBridge.branchToSessions,
      sessionBranches: anyBridge.sessionBranches,
    });
  };
  const workBoardStateDeps = {
    getBoardDispatchableSignature: (session: any, questId: string) =>
      anyBridge.getBoardDispatchableSignature(session.id, questId),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) => {
      const session = bridge.getSession(sessionId);
      if (!session) return false;
      return markNotificationDoneController(session, notifId, done, {
        broadcastToBrowsers: (_session: any, msg: any) => bridge.broadcastToSession(sessionId, msg),
        persistSession: () => bridge.persistSessionById(sessionId),
      });
    },
    broadcastBoard: (session: any, board: unknown[], completedBoard: unknown[]) =>
      bridge.broadcastToSession(session.id, { type: "board_updated", board, completedBoard } as any),
    persistSession: (session: any) => bridge.persistSessionById(session.id),
    notifyReview: (sessionId: string, summary: string) => {
      const session = bridge.getSession(sessionId);
      if (session) notifyUserController(session, "review", summary, getNotificationTestDeps(bridge));
    },
  };
  anyBridge.getBoard = (sessionId: string) =>
    bridge.getSession(sessionId) ? getBoardController(bridge.getSession(sessionId)!) : [];
  anyBridge.upsertBoardRow = (sessionId: string, row: any) =>
    bridge.getSession(sessionId)
      ? upsertBoardRowController(bridge.getSession(sessionId)!, row, workBoardStateDeps)
      : null;
  anyBridge.removeBoardRows = (sessionId: string, questIds: string[]) =>
    bridge.getSession(sessionId)
      ? removeBoardRowsController(bridge.getSession(sessionId)!, questIds, workBoardStateDeps)
      : null;
  anyBridge.advanceBoardRow = (sessionId: string, questId: string) =>
    bridge.getSession(sessionId)
      ? advanceBoardRowController(
          bridge.getSession(sessionId)!,
          questId,
          [
            "QUEUED",
            "PLANNING",
            "EXPLORING",
            "IMPLEMENTING",
            "CODE_REVIEWING",
            "MENTAL_SIMULATING",
            "EXECUTING",
            "OUTCOME_REVIEWING",
            "BOOKKEEPING",
            "PORTING",
          ],
          workBoardStateDeps,
        )
      : null;
  anyBridge.advanceBoardRowNoGroom = (sessionId: string, questId: string) =>
    bridge.getSession(sessionId)
      ? advanceBoardRowNoGroomController(bridge.getSession(sessionId)!, questId, workBoardStateDeps)
      : null;
  anyBridge.getCompletedBoard = (sessionId: string) =>
    bridge.getSession(sessionId) ? getCompletedBoardController(bridge.getSession(sessionId)!) : [];
  anyBridge.getCompletedBoardCount = (sessionId: string) => bridge.getSession(sessionId)?.completedBoard.size ?? 0;
  anyBridge.getVsCodeSelectionState = () => getVsCodeSelectionStateController(anyBridge.browserTransportState);
  anyBridge.updateVsCodeSelectionState = (nextState: any) =>
    updateVsCodeSelectionStateController(
      anyBridge.browserTransportState,
      nextState,
      anyBridge.getBrowserTransportDeps(),
    );
  anyBridge.getVsCodeWindowStates = () =>
    getVsCodeWindowStatesController(anyBridge.browserTransportState, anyBridge.getBrowserTransportDeps());
  anyBridge.upsertVsCodeWindowState = (nextState: any) =>
    upsertVsCodeWindowStateController(anyBridge.browserTransportState, nextState);
  anyBridge.pollVsCodeOpenFileCommands = (sourceId: string, limit = 1) =>
    pollVsCodeOpenFileCommandsController(anyBridge.browserTransportState, sourceId, limit);
  anyBridge.resolveVsCodeOpenFileResult = (
    sourceId: string,
    commandId: string,
    result: { ok: boolean; error?: string },
  ) => resolveVsCodeOpenFileResultController(anyBridge.browserTransportState, sourceId, commandId, result);
  anyBridge.requestVsCodeOpenFile = (target: any, options?: { timeoutMs?: number }) =>
    requestVsCodeOpenFileController(
      anyBridge.browserTransportState,
      target,
      anyBridge.getBrowserTransportDeps(),
      options,
    );
  anyBridge.routeBrowserMessage = (session: any, msg: any, ws?: any) =>
    routeBrowserMessageController(session, msg, ws, anyBridge.getBrowserRoutingDeps());
  return bridge as TestBridge;
}

function expectCodexStartPendingTurnLike(
  turn: any,
  expected: {
    firstContent?: string;
    firstContentContaining?: string;
    forbidNativeImageTransport?: boolean;
    status?: string;
    dispatchCount?: number;
    userContent?: string;
    turnId?: string | null;
    turnTarget?: string | null;
  } = {},
) {
  expect(turn).toBeTruthy();
  expect(turn.adapterMsg?.type).toBe("codex_start_pending");
  const inputs = getCodexStartPendingInputs(turn.adapterMsg);
  expect(inputs.length).toBeGreaterThan(0);
  if (expected.firstContent !== undefined) {
    expect(inputs[0]?.content).toBe(expected.firstContent);
  }
  if (expected.firstContentContaining !== undefined) {
    expect(inputs[0]?.content).toContain(expected.firstContentContaining);
  }
  if (expected.forbidNativeImageTransport) {
    expect((inputs[0] as any)?.local_images).toBeUndefined();
  }
  if (expected.status !== undefined) {
    expect(turn.status).toBe(expected.status);
  }
  if (expected.dispatchCount !== undefined) {
    expect(turn.dispatchCount).toBe(expected.dispatchCount);
  }
  if (expected.userContent !== undefined) {
    expect(turn.userContent).toBe(expected.userContent);
  }
  if ("turnId" in expected) {
    expect(turn.turnId).toBe(expected.turnId);
  }
  if ("turnTarget" in expected) {
    expect(turn.turnTarget).toBe(expected.turnTarget);
  }
}

function makeClaudeSdkAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onCompactRequestedCb: (() => void) | undefined;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onCompactRequested: vi.fn((cb: () => void) => {
      onCompactRequestedCb = cb;
    }),
    sendBrowserMessage: vi.fn(),
    drainPendingOutgoing: vi.fn((): any[] => []),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitCompactRequested: () => onCompactRequestedCb?.(),
  };
}

let bridge: TestBridge;
let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  store = new SessionStore(tempDir);
  bridge = attachBoardFacade(new WsBridge());
  bridge.setStore(store);
  bridge.resetTrafficStats();
  mockExecSync.mockReset();
  mockExec.mockReset();
  mockShouldSettingsRuleApprove.mockReset().mockResolvedValue(null);
  // Default: mockExec delegates to mockExecSync so tests that set up
  // mockExecSync automatically work for async computeDiffStatsAsync too.
  mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const result = mockExecSync(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      if (callback) callback(err, { stdout: "", stderr: "" });
    }
  });
});

describe("Codex pending input delivery", () => {
  it("rejects oversized deliveryContent before it enters pending Codex state", async () => {
    process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES = "32";
    try {
      const sid = "s-codex-oversized-pending";
      const browser = makeBrowserSocket(sid);
      const otherBrowser = makeBrowserSocket(sid);
      bridge.getOrCreateSession(sid, "codex");
      bridge.handleBrowserOpen(browser, sid);
      bridge.handleBrowserOpen(otherBrowser, sid);
      browser.send.mockClear();
      otherBrowser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "short visible message",
          deliveryContent: `/private/model/path/${"x".repeat(64)}`,
          client_msg_id: "oversized-origin-owner",
        }),
      );
      await Promise.resolve();

      const session = bridge.getSession(sid)!;
      expect(session.pendingCodexInputs).toHaveLength(0);
      expect(session.pendingCodexTurns).toHaveLength(0);
      const originMessages = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const rejection = originMessages.find((msg: any) => msg.type === "codex_pending_input_failed");
      expect(rejection).toMatchObject({
        reason: "pending_input_too_large",
        input: {
          clientMsgId: "oversized-origin-owner",
          content: "short visible message",
        },
      });
      expect(JSON.stringify(rejection)).not.toContain("/private/model/path");
      expect(
        otherBrowser.send.mock.calls
          .map(([arg]: [string]) => JSON.parse(arg))
          .some((msg: any) => msg.type === "codex_pending_input_failed"),
      ).toBe(false);
      expect(
        originMessages.some((msg: any) => msg.type === "error" && msg.message.includes("too large to queue safely")),
      ).toBe(true);
    } finally {
      delete process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES;
    }
  });

  it("compacts browser pending-input snapshots and keeps them out of replay buffers", async () => {
    process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES = "1000";
    process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES = "64";
    try {
      const sid = "s-codex-compact-pending";
      const browser = makeBrowserSocket(sid);
      bridge.getOrCreateSession(sid, "codex");
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      const deliveryContent = "delivery: " + "x".repeat(200);
      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "visible",
          deliveryContent,
        }),
      );
      await Promise.resolve();

      const session = bridge.getSession(sid)!;
      expect(session.pendingCodexInputs[0]?.deliveryContent).toBe(deliveryContent);
      const pendingBroadcast = browser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .find((msg: any) => msg.type === "codex_pending_inputs");
      expect(pendingBroadcast?.inputs[0]?.payloadTruncated).toBe(true);
      expect(pendingBroadcast?.inputs[0]?.deliveryContent).not.toBe(deliveryContent);
      expect(pendingBroadcast?.inputs[0]?.deliveryContentBytes).toBe(Buffer.byteLength(deliveryContent, "utf8"));
      expect(session.eventBuffer.some((event: any) => event.message?.type === "codex_pending_inputs")).toBe(false);
    } finally {
      delete process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES;
      delete process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES;
    }
  });

  it("keeps Codex user input pending until turn/start acknowledges delivery", async () => {
    const sid = "s-codex-pending";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-pending", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "steer me later",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "steer me later",
    });
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(false);

    const pendingBroadcast = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .find((msg: any) => msg.type === "codex_pending_inputs");
    expect(pendingBroadcast?.inputs).toHaveLength(1);

    adapter.emitTurnStarted("turn-pending");

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(true);
  });

  it("cancels still-local pending Codex input before delivery", async () => {
    const sid = "s-codex-cancel-pending";
    const browser = makeBrowserSocket(sid);
    bridge.getOrCreateSession(sid, "codex");
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do not deliver this",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const pendingId = session.pendingCodexInputs[0]?.id;
    expect(pendingId).toBeTruthy();
    expect(session.pendingCodexInputs[0]?.cancelable).toBe(true);
    expect(session.pendingCodexTurns).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: pendingId,
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "do not deliver this"),
    ).toBe(false);
  });

  it("restores pending Codex inputs across restart and delivers them on reconnect", async () => {
    const sid = "s-codex-persisted-pending";
    store.saveSync({
      id: sid,
      state: bridge.getOrCreateSession(sid, "codex").state,
      messageHistory: [],
      pendingMessages: [],
      pendingCodexInputs: [
        {
          id: "pending-persisted-1",
          content: "re-deliver me after restart",
          timestamp: 1,
          cancelable: true,
          draftImages: [],
          deliveryContent: "re-deliver me after restart",
        },
      ],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();

    const adapter = makeCodexAdapterMock();
    restored.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-pending" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["pending-persisted-1"],
      }),
    );
  });

  it("repairs restored root authority, suppresses completed-owner replay, and dispatches the successor once", async () => {
    // A pre-upgrade server can persist an acknowledged original dispatch even
    // after substantial model activity, with a later continuation still
    // queued behind it. The same captured failure also mislabeled the provider
    // root as child `/root`, which hid terminal results from root lifecycle.
    // Restart must repair both authorities before sending only the continuation.
    const sid = "s-codex-restored-completed-owner";
    const originalOwnerId = "original-completed-owner";
    const continuationOwnerId = "queued-continuation-owner";
    const originalContent = "finish the already completed work";
    const continuationContent = "continue only the remaining follow-up";
    const rootProviderThreadId = "thread-restored-completed-owner";
    const initial = bridge.getOrCreateSession(sid, "codex");
    const corruptRegistry = createCodexNativeSubagentRegistry(sid, { coverage: "complete" });
    const corruptRootChildId = codexNativeSubagentChildIdForProviderThread(corruptRegistry, rootProviderThreadId);
    corruptRegistry.childrenByProviderThreadId[rootProviderThreadId] = {
      publicChildId: corruptRootChildId,
      providerParentThreadId: "provider-child-thread",
      spawnRootProviderTurnId: "turn-original-completed",
      feedRootTurnKey: originalOwnerId,
      agentPath: "/root",
      depth: 2,
      spawnOrder: 1,
      status: "done",
      statusObservedAt: 1_250,
      transcriptAvailability: "partial",
      turnsByProviderTurnId: {},
      seenActivityEventIds: ["interacted:root-misclassified-as-child"],
    };
    corruptRegistry.nextSpawnOrder = 2;

    store.saveSync({
      id: sid,
      state: initial.state,
      messageHistory: [
        {
          type: "user_message",
          id: originalOwnerId,
          content: originalContent,
          timestamp: 1_000,
        },
        {
          type: "assistant",
          message: {
            id: "completed-owner-tool",
            type: "message",
            role: "assistant",
            model: "gpt-5.6-sol",
            content: [{ type: "tool_use", id: "tool-completed-owner", name: "Read", input: { file_path: "a.ts" } }],
            stop_reason: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 1_100,
          codexSubagent: {
            childId: corruptRootChildId,
            rootTurnId: originalOwnerId,
          },
        },
        {
          type: "assistant",
          message: {
            id: "completed-owner-response",
            type: "message",
            role: "assistant",
            model: "gpt-5.6-sol",
            content: [{ type: "text", text: "The original work is complete." }],
            stop_reason: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: 1_200,
          codexSubagent: {
            childId: corruptRootChildId,
            rootTurnId: originalOwnerId,
          },
        },
      ],
      pendingMessages: [],
      pendingCodexInputs: [
        {
          id: continuationOwnerId,
          content: continuationContent,
          deliveryContent: continuationContent,
          timestamp: 1_300,
          cancelable: true,
          draftImages: [],
        },
      ],
      pendingCodexTurns: [
        {
          adapterMsg: {
            type: "codex_start_pending",
            pendingInputIds: [originalOwnerId],
            inputs: [{ content: originalContent }],
          },
          userMessageId: originalOwnerId,
          pendingInputIds: [originalOwnerId],
          userContent: originalContent,
          historyIndex: 0,
          status: "backend_acknowledged",
          dispatchCount: 8,
          createdAt: 1_000,
          updatedAt: 1_250,
          acknowledgedAt: 1_050,
          turnTarget: "current",
          lastError: null,
          turnId: "turn-original-completed",
          disconnectedAt: null,
          resumeConfirmedAt: null,
          autoPauseSourceKind: "manual",
        },
        {
          adapterMsg: {
            type: "codex_start_pending",
            pendingInputIds: [continuationOwnerId],
            inputs: [{ content: continuationContent }],
          },
          userMessageId: continuationOwnerId,
          pendingInputIds: [continuationOwnerId],
          userContent: continuationContent,
          historyIndex: -1,
          status: "queued",
          dispatchCount: 0,
          createdAt: 1_300,
          updatedAt: 1_300,
          acknowledgedAt: null,
          turnTarget: null,
          lastError: null,
          turnId: null,
          disconnectedAt: null,
          resumeConfirmedAt: null,
          autoPauseSourceKind: "manual",
        },
      ],
      pendingPermissions: [],
      codexNativeSubagents: corruptRegistry,
    });
    await store.flushAll();

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();

    const adapter = makeCodexAdapterMock();
    restored.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-completed-owner" });
    await Promise.resolve();

    const startMessages = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((msg: any) => msg?.type === "codex_start_pending");
    expect(startMessages).toHaveLength(1);
    expect(getCodexStartPendingInputs(startMessages[0]).map((input) => input.content)).toEqual([continuationContent]);
    expect(JSON.stringify(startMessages)).not.toContain(originalContent);

    const restoredSession = restored.getSession(sid)!;
    expect(restoredSession.codexNativeSubagents.rootProviderThreadId).toBe(rootProviderThreadId);
    expect(restoredSession.codexNativeSubagents.childrenByProviderThreadId[rootProviderThreadId]).toBeUndefined();
    for (const messageId of ["completed-owner-tool", "completed-owner-response"]) {
      const restoredRootMessage = restoredSession.messageHistory.find(
        (message: any) => message.type === "assistant" && message.message?.id === messageId,
      );
      expect(restoredRootMessage?.codexSubagent).toBeUndefined();
    }
    expect(restoredSession.pendingCodexTurns).toEqual([
      expect.objectContaining({
        userMessageId: continuationOwnerId,
        status: "dispatched",
        dispatchCount: 1,
      }),
    ]);
    expect(restoredSession.codexPendingDeliveryProofSignals).toEqual([
      expect.objectContaining({
        kind: "resume_snapshot",
        turnId: "turn-original-completed",
        classification: expect.stringContaining("retry_suppressed_model_activity"),
      }),
    ]);

    // Repeated session metadata cannot resurrect or redispatch the retired
    // owner while the legitimate continuation is waiting for acknowledgement.
    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-completed-owner" });
    await Promise.resolve();
    expect(
      adapter.sendBrowserMessage.mock.calls.filter((args) => args[0]?.type === "codex_start_pending"),
    ).toHaveLength(1);

    adapter.emitTurnStarted("turn-queued-continuation");
    await Promise.resolve();
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "continuation completed",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "result-queued-continuation",
        session_id: sid,
        codex_turn_id: "turn-queued-continuation",
      },
    });
    await Promise.resolve();

    const committedUserMessages = restoredSession.messageHistory.filter(
      (message: any) => message.type === "user_message",
    );
    expect(committedUserMessages.filter((message: any) => message.content === originalContent)).toHaveLength(1);
    expect(committedUserMessages.filter((message: any) => message.content === continuationContent)).toHaveLength(1);
    expect(restoredSession.pendingCodexInputs).toHaveLength(0);
    expect(restoredSession.pendingCodexTurns).toHaveLength(0);
  });

  it("pokes a stale acknowledged pending-delivery head before a leader-injected follow-up", async () => {
    const sid = "s-codex-stale-leader-poke";
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-leader", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    adapter.sendBrowserMessage.mockClear();

    const delivery = bridge.injectUserMessage(sid, "new leader instruction", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
    ]);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(2);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "new leader instruction",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, false, true]);
    expect(session.pendingCodexTurns[1]?.adapterMsg).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: [session.pendingCodexInputs[2]?.id],
      }),
    );
    expect(session.pendingCodexTurns[1]?.status).toBe("queued");
    warnSpy.mockRestore();
  });

  it("dispatches a stale queued pending-delivery head without absorbing the leader trigger", async () => {
    const sid = "s-codex-stale-queued-leader-poke";
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-queued-leader", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, { status: "queued" });
    adapter.sendBrowserMessage.mockClear();

    const delivery = bridge.injectUserMessage(sid, "new leader instruction after queued head", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
    ]);
    expect(
      getCodexStartPendingInputs(retried).some((input) => input.content === "new leader instruction after queued head"),
    ).toBe(false);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "new leader instruction after queued head",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, false, true]);
    expect(session.pendingCodexTurns[1]?.adapterMsg).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: [session.pendingCodexInputs[2]?.id],
      }),
    );
    expect(getCodexStartPendingInputs(session.pendingCodexTurns[1]?.adapterMsg).map((input) => input.content)).toEqual([
      "new leader instruction after queued head",
    ]);
    expect(session.pendingCodexTurns[1]?.status).toBe("queued");
    warnSpy.mockRestore();
  });

  it("uses the same stale pending-delivery poke for browser/user messages", async () => {
    const sid = "s-codex-stale-browser-poke";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-browser", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, {
      inputs: [{ id: "old-browser-input", content: "old browser pending instruction" }],
    });
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "new browser instruction",
      }),
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-browser-input"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old browser pending instruction",
    ]);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(2);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old browser pending instruction",
      "new browser instruction",
    ]);
    warnSpy.mockRestore();
  });

  it("dispatches a stale queued pending-delivery head without absorbing the browser trigger", async () => {
    const sid = "s-codex-stale-queued-browser-poke";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-queued-browser", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, {
      status: "queued",
      inputs: [{ id: "old-queued-browser-input", content: "old queued browser instruction" }],
    });
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "new browser instruction after queued head",
      }),
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-queued-browser-input"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old queued browser instruction",
    ]);
    expect(
      getCodexStartPendingInputs(retried).some(
        (input) => input.content === "new browser instruction after queued head",
      ),
    ).toBe(false);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old queued browser instruction",
      "new browser instruction after queued head",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, true]);
    expect(getCodexStartPendingInputs(session.pendingCodexTurns[1]?.adapterMsg).map((input) => input.content)).toEqual([
      "new browser instruction after queued head",
    ]);
    warnSpy.mockRestore();
  });

  it("settles a stale acknowledged head with local activity instead of replaying it", async () => {
    // The connected watchdog/poke path must use exact-owner local model
    // activity as delivery proof. Replaying the old head would duplicate work
    // and keep the later user input trapped behind it.
    const sid = "s-codex-stale-head-local-activity";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-activity", model: "gpt-5.6-sol", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    const oldOwnerId = "old-alignment-owner";
    session.messageHistory.push(
      { type: "user_message", id: oldOwnerId, content: "completed alignment work", timestamp: 1_000 },
      {
        type: "assistant",
        message: {
          id: "old-alignment-response",
          type: "message",
          role: "assistant",
          model: "gpt-5.6-sol",
          content: [{ type: "text", text: "Alignment evidence already produced." }],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 1_100,
      },
    );
    session.pendingCodexTurns.push({
      adapterMsg: {
        type: "codex_start_pending",
        pendingInputIds: [oldOwnerId],
        inputs: [{ content: "completed alignment work" }],
      },
      userMessageId: oldOwnerId,
      pendingInputIds: [oldOwnerId],
      userContent: "completed alignment work",
      historyIndex: 0,
      status: "backend_acknowledged",
      dispatchCount: 4,
      createdAt: 1_000,
      updatedAt: 1_100,
      acknowledgedAt: 1_050,
      turnTarget: "current",
      lastError: null,
      turnId: "turn-completed-alignment",
      disconnectedAt: 1_075,
      resumeConfirmedAt: null,
      autoPauseSourceKind: "manual",
    });
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "new work after completed alignment" }),
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const dispatched = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(getCodexStartPendingInputs(dispatched).map((input) => input.content)).toEqual([
      "new work after completed alignment",
    ]);
    expect(JSON.stringify(dispatched)).not.toContain("completed alignment work");
    expect(session.pendingCodexTurns).toEqual([
      expect.objectContaining({
        userContent: "new work after completed alignment",
        status: "dispatched",
        dispatchCount: 1,
      }),
    ]);

    adapter.emitTurnStarted("turn-new-work");
    await Promise.resolve();
    expect(
      session.messageHistory.filter(
        (message: any) => message.type === "user_message" && message.content === "completed alignment work",
      ),
    ).toHaveLength(1);
    expect(
      session.messageHistory.filter(
        (message: any) => message.type === "user_message" && message.content === "new work after completed alignment",
      ),
    ).toHaveLength(1);
  });

  it("does not retry stale pending delivery while Codex reports an active current turn", async () => {
    const sid = "s-codex-stale-current-turn";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-active-current", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    adapter.setCurrentTurnIdForTest("turn-active");
    adapter.sendBrowserMessage.mockClear();

    bridge.injectUserMessage(sid, "follow-up for active turn", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    const sentMessages = adapter.sendBrowserMessage.mock.calls.map((call: any[]) => call[0]);
    expect(sentMessages).not.toContainEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        type: "codex_steer_pending",
        expectedTurnId: "turn-active",
      }),
    );
    expect(staleHead.status).toBe("backend_acknowledged");
    expect(staleHead.dispatchCount).toBe(1);
  });

  it("keeps a failed expected/found active-turn steer recoverable and commits the image input once", async () => {
    const sid = "s-codex-active-turn-mismatch";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-active-mismatch", model: "gpt-5.5", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    adapter.emitTurnStarted("turn-d3a1");
    adapter.sendBrowserMessage.mockClear();
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "message with image after active-turn mismatch",
        client_msg_id: "client-image-1",
        imageRefs: [
          {
            imageId: "image-1",
            media_type: "image/jpeg",
            optimized: true,
            sourceName: "pasted.png",
          },
        ],
      }),
    );
    await Promise.resolve();

    const steer = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(steer).toEqual(
      expect.objectContaining({
        type: "codex_steer_pending",
        expectedTurnId: "turn-d3a1",
      }),
    );
    expect(steer.pendingInputIds).toEqual([session.pendingCodexInputs[0]?.id]);
    expect(steer.inputs[0]?.content).toContain("message with image after active-turn mismatch");
    // Image storage follows the test process home, including isolated test runs
    // and developer machines with a different home directory.
    expect(steer.inputs[0]?.content).toContain(join(homedir(), ".companion", "images", sid));
    expect(steer.inputs[0]?.content).toContain("image-1.takode-agent.jpeg");
    expect(steer.inputs[0]?.images).toBeUndefined();
    expect(steer.inputs[0]?.local_images).toBeUndefined();

    session.pendingCodexTurns.unshift({
      adapterMsg: {
        type: "codex_start_pending",
        pendingInputIds: ["active-turn-input"],
        inputs: [{ content: "already active turn input" }],
      },
      userMessageId: "active-turn-input",
      pendingInputIds: ["active-turn-input"],
      userContent: "already active turn input",
      historyIndex: -1,
      status: "backend_acknowledged",
      dispatchCount: 1,
      createdAt: Date.now() - 1_000,
      updatedAt: Date.now() - 1_000,
      acknowledgedAt: Date.now() - 1_000,
      turnTarget: "current",
      lastError: null,
      turnId: "turn-c014",
      disconnectedAt: null,
      resumeConfirmedAt: null,
      autoPauseSourceKind: "manual",
    });

    adapter.emitTurnSteerFailed(steer.pendingInputIds, {
      kind: "active_turn_mismatch",
      expectedTurnId: "turn-d3a1",
      foundTurnId: "turn-c014",
    });
    adapter.setCurrentTurnIdForTest("turn-c014");
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "message with image after active-turn mismatch",
      cancelable: true,
      clientMsgId: "client-image-1",
    });
    expect(session.pendingCodexInputs[0]?.imageRefs).toEqual([
      expect.objectContaining({
        imageId: "image-1",
        media_type: "image/jpeg",
        optimized: true,
      }),
    ]);
    expect(
      session.messageHistory.filter(
        (msg: any) => msg.type === "user_message" && msg.content === "message with image after active-turn mismatch",
      ),
    ).toHaveLength(0);
    expect(
      browser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .some((msg: any) => msg.type === "error" && msg.message.includes("Failed to steer active Codex turn")),
    ).toBe(false);

    adapter.setCurrentTurnIdForTest(null);
    adapter.sendBrowserMessage.mockClear();
    adapter.emitBrowserMessage({
      type: "result",
      data: { is_error: false, result: "completed stale active turn", codex_turn_id: "turn-c014" },
    });
    await Promise.resolve();

    const retry = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retry).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: [session.pendingCodexInputs[0]?.id],
      }),
    );
    expect(getCodexStartPendingInputs(retry)[0]?.content).toContain("image-1.takode-agent.jpeg");
    expect((getCodexStartPendingInputs(retry)[0] as any)?.images).toBeUndefined();
    expect((getCodexStartPendingInputs(retry)[0] as any)?.local_images).toBeUndefined();

    adapter.emitTurnStarted("turn-retry");
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(0);
    const committed = session.messageHistory.filter(
      (msg: any) => msg.type === "user_message" && msg.content === "message with image after active-turn mismatch",
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      client_msg_id: "client-image-1",
      images: [
        expect.objectContaining({
          imageId: "image-1",
          media_type: "image/jpeg",
          optimized: true,
        }),
      ],
    });
  });

  it("releases an exact provider-inactive owner and retries queued image/text input in order", async () => {
    // Producer-shaped regression for the q-1958 live sequence: the provider
    // rejects a steer because the exact tracked turn is no longer active. The
    // stale acknowledged owner must not block the image or later text input.
    const sid = "s-codex-no-active-steer-retry";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-no-active-steer", model: "gpt-5.6-sol", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "active owner" }));
    await Promise.resolve();
    adapter.emitTurnStarted("turn-provider-inactive");
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "queued image owner",
        client_msg_id: "client-image-owner",
        imageRefs: [{ imageId: "queued-image", media_type: "image/jpeg", optimized: true, sourceName: "queued.png" }],
      }),
    );
    await Promise.resolve();

    const imageSteer = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((msg: any) => msg?.type === "codex_steer_pending");
    expect(imageSteer).toMatchObject({
      expectedTurnId: "turn-provider-inactive",
      pendingInputIds: [expect.any(String)],
    });

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt", interruptSource: "user" }));
    await Promise.resolve();
    adapter.emitTurnSteerFailed(imageSteer.pendingInputIds, {
      kind: "no_active_turn",
      expectedTurnId: "turn-provider-inactive",
    });
    await Promise.resolve();

    const outboundAfterFailure = adapter.sendBrowserMessage.mock.calls.map((args: any[]) => args[0]);
    expect(outboundAfterFailure.map((msg: any) => msg.type)).toEqual([
      "codex_steer_pending",
      "interrupt",
      "codex_start_pending",
    ]);
    const imageRetry = outboundAfterFailure[2];
    expect(imageRetry).toMatchObject({
      type: "codex_start_pending",
      pendingInputIds: imageSteer.pendingInputIds,
    });
    expect(getCodexStartPendingInputs(imageRetry)[0]?.content).toContain("queued image owner");
    expect(getCodexStartPendingInputs(imageRetry)[0]?.content).toContain("queued-image.takode-agent.jpeg");
    expect((getCodexStartPendingInputs(imageRetry)[0] as any)?.images).toBeUndefined();
    expect((getCodexStartPendingInputs(imageRetry)[0] as any)?.local_images).toBeUndefined();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(session.pendingCodexTurns[0]).toMatchObject({ status: "dispatched", turnId: null });
    expect(session.isGenerating).toBe(true);
    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({ content: "queued image owner", cancelable: false }),
    ]);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "later text owner", client_msg_id: "client-later-owner" }),
    );
    await Promise.resolve();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(3);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "queued image owner",
      "later text owner",
    ]);

    adapter.emitTurnStarted("turn-retried-owner");
    await Promise.resolve();
    const laterSteer = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find(
        (msg: any) =>
          msg?.type === "codex_steer_pending" && msg.inputs?.some((input: any) => input.content === "later text owner"),
      );
    expect(laterSteer).toMatchObject({
      expectedTurnId: "turn-retried-owner",
      pendingInputIds: [expect.any(String)],
    });
    adapter.emitTurnSteered("turn-retried-owner", laterSteer.pendingInputIds);
    await Promise.resolve();

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "retried owners completed",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "result-retried-owners",
        session_id: sid,
        codex_turn_id: "turn-retried-owner",
      },
    });
    await Promise.resolve();

    const committedContents = session.messageHistory
      .filter((msg: any) => msg.type === "user_message")
      .map((msg: any) => msg.content);
    expect(committedContents).toEqual(["active owner", "queued image owner", "later text owner"]);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
  });

  it("settles a screenshot-shaped stuck owner without replaying it on the watchdog cycle", async () => {
    // Regression for the retained production loop reported on August 28, 2026:
    // an old server left generation running after a provider turn disappeared,
    // retained the completed owner as backend_acknowledged/current, and queued a
    // continuation after a failed steer. The five-minute watchdog must use the
    // completed owner's local activity as exact delivery proof, never replay it,
    // and release only the queued continuation once.
    vi.useFakeTimers();
    try {
      const now = new Date("2026-08-28T05:30:00.000Z").getTime();
      vi.setSystemTime(now);

      const sid = "s-codex-stuck-owner-watchdog";
      const browser = makeBrowserSocket(sid);
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter, {
        cliSessionId: "thread-stuck-owner-watchdog",
        model: "gpt-5.6-sol",
        cwd: "/repo",
      });
      bridge.handleBrowserOpen(browser, sid);

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({ type: "user_message", content: "already completed original work" }),
      );
      await Promise.resolve();
      const originalStart = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
      expect(originalStart).toMatchObject({ type: "codex_start_pending" });

      adapter.emitTurnStarted("turn-original-owner");
      await Promise.resolve();

      const session = bridge.getSession(sid)!;
      const originalOwner = session.pendingCodexTurns[0]!;
      expect(originalOwner).toMatchObject({
        status: "backend_acknowledged",
        turnTarget: "current",
        turnId: "turn-original-owner",
        dispatchCount: 1,
      });

      session.messageHistory.push({
        type: "assistant",
        message: {
          id: "completed-original-owner-response",
          type: "message",
          role: "assistant",
          model: "gpt-5.6-sol",
          content: [{ type: "text", text: "The original work is complete." }],
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        timestamp: now - 240_000,
      });

      adapter.sendBrowserMessage.mockClear();
      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({ type: "user_message", content: "queued continuation after recovery" }),
      );
      await Promise.resolve();

      const steer = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
      expect(steer).toMatchObject({
        type: "codex_steer_pending",
        expectedTurnId: "turn-original-owner",
        pendingInputIds: [expect.any(String)],
      });

      // Preserve the exact legacy state rather than invoking the current
      // provider-inactive fast path: the adapter knows there is no active turn,
      // but the bridge still thinks the old owner is generating.
      adapter.setCurrentTurnIdForTest(null);
      adapter.emitTurnSteerFailed(steer.pendingInputIds);
      await Promise.resolve();

      expect(session.isGenerating).toBe(true);
      expect(adapter.getCurrentTurnId()).toBeNull();
      expect(session.pendingCodexTurns).toHaveLength(2);
      expect(session.pendingCodexTurns[0]).toBe(originalOwner);
      expect(session.pendingCodexTurns[1]).toMatchObject({
        status: "queued",
        turnTarget: null,
        userContent: "queued continuation after recovery",
      });

      adapter.sendBrowserMessage.mockClear();
      session.generationStartedAt = now - 300_001;
      session.lastCliMessageAt = now - 300_001;
      session.lastToolProgressAt = 0;
      session.toolStartTimes.clear();
      bridge.startStuckSessionWatchdog();

      vi.advanceTimersByTime(31_000);
      await Promise.resolve();

      const watchdogStarts = adapter.sendBrowserMessage.mock.calls
        .map((args: any[]) => args[0])
        .filter((msg: any) => msg?.type === "codex_start_pending");
      expect(watchdogStarts).toHaveLength(1);
      expect(getCodexStartPendingInputs(watchdogStarts[0]).map((input) => input.content)).toEqual([
        "queued continuation after recovery",
      ]);
      expect(JSON.stringify(watchdogStarts)).not.toContain("already completed original work");
      expect(originalOwner.dispatchCount).toBe(1);
      expect(session.pendingCodexTurns).toEqual([
        expect.objectContaining({
          userContent: "queued continuation after recovery",
          status: "dispatched",
          dispatchCount: 1,
        }),
      ]);
      expect(session.codexPendingDeliveryProofSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "resume_snapshot",
            turnId: "turn-original-owner",
            classification: expect.stringContaining("retry_suppressed_model_activity"),
          }),
        ]),
      );

      // A later pending-delivery sweep cannot resurrect either the completed
      // owner or a second copy of the continuation while acknowledgement is pending.
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(
        adapter.sendBrowserMessage.mock.calls.filter((args: any[]) => args[0]?.type === "codex_start_pending"),
      ).toHaveLength(1);

      adapter.emitTurnStarted("turn-queued-continuation");
      await Promise.resolve();
      adapter.emitBrowserMessage({
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "continuation completed",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: "completed",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          uuid: "result-stuck-owner-watchdog",
          session_id: sid,
          codex_turn_id: "turn-queued-continuation",
        },
      });
      await Promise.resolve();

      const committedContents = session.messageHistory
        .filter((msg: any) => msg.type === "user_message")
        .map((msg: any) => msg.content);
      expect(committedContents).toEqual(["already completed original work", "queued continuation after recovery"]);
      expect(session.pendingCodexInputs).toHaveLength(0);
      expect(session.pendingCodexTurns).toHaveLength(0);
      expect(session.isGenerating).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not retry stale pending delivery while the session is actively generating", async () => {
    const sid = "s-codex-stale-generating";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-active-generating", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 1_000;
    adapter.sendBrowserMessage.mockClear();

    bridge.injectUserMessage(sid, "queued during active generation", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(staleHead.status).toBe("backend_acknowledged");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "queued during active generation",
    ]);
  });

  it("leaves adapter-missing pending delivery on the existing relaunch path", async () => {
    const sid = "s-codex-missing-adapter-still-recovers";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const session = bridge.getOrCreateSession(sid, "codex");
    session.state.backend_state = "connected";

    const delivery = bridge.injectUserMessage(sid, "wake missing adapter", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledTimes(1);
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(session.state.backend_state).toBe("recovering");
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("wake missing adapter");
  });
});
