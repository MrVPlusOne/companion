import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockShouldSettingsRuleApprove = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));
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
import type { CodexOutboundTurn } from "./session-types.js";
import { beginCodexTurnRecoveryContinuation } from "./bridge/codex-interrupted-turn-recovery.js";
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
  let onTurnStartFailedCb: ((msg: any, info?: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let onTurnSteeredCb: ((turnId: string, pendingInputIds: string[]) => void) | undefined;
  let onTurnSteerFailedCb: ((pendingInputIds: string[]) => void) | undefined;
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
    onTurnStartFailed: vi.fn((cb: (msg: any, info?: any) => void) => {
      onTurnStartFailedCb = cb;
    }),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => {
      onTurnStartedCb = cb;
    }),
    onTurnSteered: vi.fn((cb: (turnId: string, pendingInputIds: string[]) => void) => {
      onTurnSteeredCb = cb;
    }),
    onTurnSteerFailed: vi.fn((cb: (pendingInputIds: string[]) => void) => {
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
    emitTurnStartFailed: (msg: any, info?: any) => onTurnStartFailedCb?.(msg, info),
    emitTurnStarted: (turnId: string) => {
      currentTurnId = turnId;
      onTurnStartedCb?.(turnId);
    },
    emitTurnSteered: (turnId: string, pendingInputIds: string[]) => {
      onTurnSteeredCb?.(turnId, pendingInputIds);
    },
    emitTurnSteerFailed: (pendingInputIds: string[]) => {
      onTurnSteerFailedCb?.(pendingInputIds);
    },
  };
}

function makeReceiptAwareCodexAdapterMock() {
  const adapter = makeCodexAdapterMock() as ReturnType<typeof makeCodexAdapterMock> & {
    onUserMessageRecorded: ReturnType<typeof vi.fn>;
    onUserMessageReceiptObserved: ReturnType<typeof vi.fn>;
  };
  adapter.onUserMessageRecorded = vi.fn();
  adapter.onUserMessageReceiptObserved = vi.fn();
  return adapter;
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

async function beginInterruptedTurnContinuation(bridge: WsBridge, sessionId: string) {
  const session = bridge.getSession(sessionId)!;
  const timestamp = Date.now() - 1;
  const historyIndex = session.messageHistory.length;
  const userContent = "Finish the interrupted work.";
  session.messageHistory.push({
    type: "user_message",
    id: "original-owner",
    content: userContent,
    timestamp,
    threadKey: "main",
  });
  const original: CodexOutboundTurn = {
    adapterMsg: { type: "user_message", content: userContent },
    userMessageId: "original-owner",
    userContent,
    historyIndex,
    status: "completed",
    dispatchCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    acknowledgedAt: timestamp,
    turnTarget: null,
    lastError: null,
    turnId: "turn-original",
    disconnectedAt: timestamp,
    resumeConfirmedAt: null,
  };
  // Production establishes exact recovery ownership before injection. Its
  // acceptance callback binds the new owner and dispatches the continuation.
  expect(
    beginCodexTurnRecoveryContinuation(
      session,
      original,
      { threadKey: "main" },
      (bridge as any).getCodexRecoveryOrchestratorDeps(),
    ),
  ).toBe(true);
  await Promise.resolve();
  expect(session.pendingCodexInputs[0]?.id).toBeTruthy();
  expect(session.state.codex_turn_recovery).toMatchObject({
    originalOwnerId: "original-owner",
    continuationOwnerId: session.pendingCodexInputs[0]?.id,
    status: "continuation_pending",
  });
  return session;
}

function installReleasedRecoveryReceipt(session: any, pendingInput: any) {
  pendingInput.autoPauseRecoveries = [{ summaryId: "recovery-summary", groupId: "held-group" }];
  session.messageHistory.push({
    type: "codex_auto_pause_recovery_summary",
    id: "recovery-summary",
    timestamp: 1,
    content: "Automatic input recovery: 1 awaiting delivery.",
    searchText: "automatic input recovery outcome:released_to_delivery",
    recovery: {
      family: "copilot_auth_refresh_exhausted",
      pausedAt: 1,
      recoveryConfirmedAt: 2,
      updatedAt: 2,
      status: "releasing",
      receipts: [
        {
          groupId: "held-group",
          source: "programmatic",
          sourceLabel: "Herd Events",
          count: 1,
          coalescedCount: 0,
          queuedAt: 1,
          lastQueuedAt: 1,
          releasedAt: 2,
          outcome: "released_to_delivery",
          reasonCode: "manual_recovery_succeeded",
          reason: "Manual recovery succeeded; queued for exact-once delivery.",
        },
      ],
    },
  });
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

// localDateKey is a private static — access via `any` cast for testing.
// ─── Helper: build a system.init NDJSON string ────────────────────────────────

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

describe("Codex turn-start failure re-queue", () => {
  // When Codex cannot confirm turn/start, history-aware owners must not be replayed
  // blindly. Takode continues verification-first unless a terminal boundary applies.

  it("registers onTurnStartFailed callback during adapter attachment", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    expect(adapter.onTurnStartFailed).toHaveBeenCalledOnce();
  });

  it("queues verification-first continuation when turn/start acceptance is uncertain", async () => {
    // Receipt callbacks opt this production-shaped adapter into evidence-aware tracking.
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));

    const failedMsg = { type: "user_message", content: "hello" };
    const sessionBeforeFailure = bridge.getSession("s1")!;
    installReleasedRecoveryReceipt(sessionBeforeFailure, sessionBeforeFailure.pendingCodexInputs[0]);
    adapter.emitTurnStartFailed(failedMsg);
    await flushAsync();

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContentContaining: "verification-first continuation",
      status: "dispatched",
      dispatchCount: 1,
    });
    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "continuation_pending",
      continuationMode: "verify_then_continue",
    });
    expect(
      (session.messageHistory.find((entry: any) => entry.type === "codex_auto_pause_recovery_summary") as any).recovery
        .receipts[0].outcome,
    ).toBe("released_to_delivery");
  });

  it("persists nonrecoverable turn-start failure until exact-owner retry", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);

    const browser = makeBrowserSocket("s1");
    const otherBrowser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserOpen(otherBrowser, "s1");
    otherBrowser.send.mockClear();
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "oversized",
        client_msg_id: "failed-owner-client",
        imageRefs: [{ imageId: "failed-image", media_type: "image/png", optimized: true }],
      }),
    );

    // Model a released held input: a nonrecoverable turn/start rejection must terminally update its durable receipt.
    const sessionBeforeFailure = bridge.getSession("s1")!;
    installReleasedRecoveryReceipt(sessionBeforeFailure, sessionBeforeFailure.pendingCodexInputs[0]);

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    adapter.emitTurnStartFailed(
      { type: "user_message", content: "oversized" },
      {
        recoverable: false,
        message: "input_too_large: max_chars=1048576",
      },
    );

    const session = bridge.getSession("s1")!;
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({
        clientMsgId: "failed-owner-client",
        content: "oversized",
        cancelable: true,
        deliveryState: "failed",
        failureReason: "nonrecoverable_turn_start",
        failureMessage: "Codex rejected this input before delivery.",
        failedAt: expect.any(Number),
        imageRefs: [expect.objectContaining({ imageId: "failed-image", media_type: "image/png" })],
      }),
    ]);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.isGenerating).toBe(false);
    expect(
      otherBrowser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .some(
          (msg: any) =>
            msg.type === "codex_pending_inputs" &&
            msg.inputs?.some(
              (input: any) => input.clientMsgId === "failed-owner-client" && input.deliveryState === "failed",
            ),
        ),
    ).toBe(true);
    const recoverySummary = session.messageHistory.find(
      (entry: any) => entry.type === "codex_auto_pause_recovery_summary",
    ) as any;
    expect(recoverySummary.recovery).toMatchObject({
      status: "settled",
      receipts: [expect.objectContaining({ outcome: "failed", reasonCode: "nonrecoverable_turn_start" })],
    });
    expect(
      browser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .some((msg: any) => msg.type === "error" && msg.message.includes("input_too_large")),
    ).toBe(true);

    await store.flushAll();
    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();
    const restoredSession = restored.getSession("s1")!;
    expect(restoredSession.pendingCodexInputs[0]).toMatchObject({
      id: session.pendingCodexInputs[0]?.id,
      deliveryState: "failed",
      failureReason: "nonrecoverable_turn_start",
    });

    const adapter2 = makeCodexAdapterMock();
    restored.attachCodexAdapter("s1", adapter2 as any);
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-failed-owner-retry" });
    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalled();

    const restoredBrowser = makeBrowserSocket("s1");
    restored.handleBrowserOpen(restoredBrowser, "s1");
    expect(
      restoredBrowser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .some(
          (msg: any) =>
            msg.type === "codex_pending_inputs" &&
            msg.inputs?.some(
              (input: any) =>
                input.id === restoredSession.pendingCodexInputs[0]?.id && input.deliveryState === "failed",
            ),
        ),
    ).toBe(true);

    await restored.handleBrowserMessage(
      restoredBrowser,
      JSON.stringify({
        type: "retry_pending_codex_input",
        id: restoredSession.pendingCodexInputs[0]?.id,
        client_msg_id: "retry-failed-owner-action",
      }),
    );
    await Promise.resolve();

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retry = adapter2.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retry).toMatchObject({
      type: "codex_start_pending",
      pendingInputIds: [restoredSession.pendingCodexInputs[0]?.id],
    });
    expect(getCodexStartPendingInputs(retry)[0]?.content).toContain("failed-image.takode-agent.png");
    expect((getCodexStartPendingInputs(retry)[0] as any)?.images).toBeUndefined();
    expect((getCodexStartPendingInputs(retry)[0] as any)?.local_images).toBeUndefined();
    expect(restoredSession.pendingCodexInputs[0]).toEqual(expect.not.objectContaining({ deliveryState: "failed" }));
    expect(restoredSession.processedClientMessageIdSet.has("retry-failed-owner-action")).toBe(true);
    await restored.handleBrowserMessage(
      restoredBrowser,
      JSON.stringify({
        type: "retry_pending_codex_input",
        id: restoredSession.pendingCodexInputs[0]?.id,
        client_msg_id: "retry-failed-owner-action",
      }),
    );
    expect(adapter2.sendBrowserMessage).toHaveBeenCalledTimes(1);

    adapter2.emitTurnStarted("turn-failed-owner-retry");
    await Promise.resolve();
    expect(restoredSession.pendingCodexInputs).toHaveLength(0);
    expect(
      restoredSession.messageHistory.filter(
        (entry: any) => entry.type === "user_message" && entry.content === "oversized",
      ),
    ).toHaveLength(1);
  });

  it("stops a rejected interrupted-turn continuation as durable action-required work", async () => {
    const sid = "s-recovery-continuation-start-failure";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const session = await beginInterruptedTurnContinuation(bridge, sid);
    const outbound = adapter.sendBrowserMessage.mock.calls.at(-1)?.[0];

    adapter.emitTurnStartFailed(outbound, { recoverable: false, message: "input_too_large" });
    await Promise.resolve();

    expect(session.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
    });
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    expect(session.attentionReason).toBe("error");

    await store.flushAll();
    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();
    expect(restored.getSession(sid)?.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
    });
    expect(restored.getSession(sid)?.pendingCodexInputs).toHaveLength(0);
    expect(restored.getSession(sid)?.pendingCodexTurns).toHaveLength(0);
  });

  it("fails an unacknowledged interrupted-turn continuation closed after its optimistic timeout", async () => {
    const sid = "s-recovery-continuation-ack-timeout";
    vi.useFakeTimers();
    try {
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter);
      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      const session = await beginInterruptedTurnContinuation(bridge, sid);
      expect(getPendingCodexTurn(session)).toMatchObject({ status: "dispatched", turnId: null });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(session.state.codex_turn_recovery).toMatchObject({
        status: "action_required",
        reason: "continuation_dispatch_failed",
        raisedAttention: false,
      });
      expect(session.pendingCodexInputs).toHaveLength(0);
      expect(session.pendingCodexTurns).toHaveLength(0);
      expect(session.isGenerating).toBe(false);
      expect(session.attentionReason).toBeNull();
      expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
      await store.flushAll();
    } finally {
      vi.useRealTimers();
    }

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();
    expect(restored.getSession(sid)?.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
    });
    expect(restored.getSession(sid)?.pendingCodexInputs).toHaveLength(0);
    expect(restored.getSession(sid)?.pendingCodexTurns).toHaveLength(0);
  });

  it("hard-stops a terminal failure of the one allowed original-input replay", async () => {
    const sid = "s-terminal-original-replay";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "replay once" }));
    const session = bridge.getSession(sid)!;
    const pending = getPendingCodexTurn(session);
    const history = pending.historyIncorporation;
    expect(history).toBeTruthy();
    history.attempt = 1;
    history.clientUserMessageId = `${history.batchId}:1`;
    pending.adapterMsg.clientUserMessageId = history.clientUserMessageId;
    session.state.codex_turn_recovery = {
      recoveryId: pending.userMessageId,
      originalOwnerId: pending.userMessageId,
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: pending.historyIndex,
      continuationOwnerId: null,
      threadKey: "main",
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence: "absent",
      continuationMode: null,
      attempt: 0,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const replayMessage = structuredClone(pending.adapterMsg);

    adapter.emitTurnStartFailed(replayMessage, {
      recoverable: false,
      message: "input_too_large: max_chars=1048576",
    });
    await Promise.resolve();

    expect(session.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: pending.userMessageId,
      status: "action_required",
      reason: "recovery_failed",
    });
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.attentionReason).toBe("error");
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
  });

  it("retains an attempt-1 receipt through recoverable ACK loss and settles from resumed history", async () => {
    const sid = "s-replay-ack-loss";
    const relaunch = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunch);
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "replay once" }));
    const session = bridge.getSession(sid)!;
    const replay = getPendingCodexTurn(session);
    const history = replay.historyIncorporation;
    history.attempt = 1;
    history.clientUserMessageId = `${history.batchId}:1`;
    replay.adapterMsg.clientUserMessageId = history.clientUserMessageId;
    session.state.codex_turn_recovery = {
      recoveryId: replay.userMessageId,
      originalOwnerId: replay.userMessageId,
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: replay.historyIndex,
      continuationOwnerId: null,
      threadKey: "main",
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence: "absent",
      continuationMode: null,
      attempt: 0,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const clientUserMessageId = history.clientUserMessageId;

    adapter1.emitTurnStartFailed(structuredClone(replay.adapterMsg));
    await Promise.resolve();

    expect(relaunch).toHaveBeenCalledWith(sid);
    expect(getPendingCodexTurn(session)).toBe(replay);
    expect(replay).toMatchObject({
      status: "recovery_pending",
      historyIncorporation: { attempt: 1, clientUserMessageId },
    });
    expect(session.state).toMatchObject({
      backend_state: "recovering",
      codex_turn_recovery: { originalOwnerId: replay.userMessageId, status: "recovering" },
    });

    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const completed = {
      id: "turn-replayed",
      status: "completed",
      error: null,
      itemsView: "full" as const,
      items: [
        { type: "userMessage", clientId: clientUserMessageId, content: [] },
        { type: "agentMessage", text: "Recovered final response." },
      ],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-replayed",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-replayed",
        threadStatus: "idle",
        turnCount: 1,
        turns: [completed],
        lastTurn: completed,
      },
    });
    await flushAsync();

    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.state.codex_turn_recovery).toBeNull();
  });

  it("retains a one-shot continuation receipt through recoverable ACK loss", async () => {
    const sid = "s-continuation-ack-loss";
    const relaunch = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunch);
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const session = await beginInterruptedTurnContinuation(bridge, sid);
    const continuation = getPendingCodexTurn(session);
    const continuationOwnerId = continuation.userMessageId;
    const clientUserMessageId = continuation.historyIncorporation!.clientUserMessageId;

    adapter1.emitTurnStartFailed(structuredClone(continuation.adapterMsg));
    await Promise.resolve();

    expect(relaunch).toHaveBeenCalledWith(sid);
    expect(getPendingCodexTurn(session)).toBe(continuation);
    expect(continuation).toMatchObject({
      status: "recovery_pending",
      historyIncorporation: { clientUserMessageId },
    });
    expect(session.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: "original-owner",
      continuationOwnerId,
      status: "recovering",
    });

    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const completed = {
      id: "turn-continuation-recovered",
      status: "completed",
      error: null,
      itemsView: "full" as const,
      items: [
        { type: "userMessage", clientId: clientUserMessageId, content: [] },
        { type: "agentMessage", text: "Finished the interrupted response." },
      ],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-continuation-recovered",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-continuation-recovered",
        threadStatus: "idle",
        turnCount: 1,
        turns: [completed],
        lastTurn: completed,
      },
    });
    await flushAsync();

    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.state.codex_turn_recovery).toBeNull();
  });

  it("dispatches a later queued owner after an owner-local payload rejection", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "will fail" }));
    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "must continue" }));
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);

    adapter.emitTurnStartFailed(
      { type: "user_message", content: "will fail" },
      { recoverable: false, message: "input_too_large: max_chars=1048576" },
    );
    await Promise.resolve();

    const session = bridge.getSession("s1")!;
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(2);
    const laterStart = adapter.sendBrowserMessage.mock.calls[1]?.[0] as any;
    expect(getCodexStartPendingInputs(laterStart).map((input) => input.content)).toEqual(["must continue"]);
    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({ content: "will fail", deliveryState: "failed", cancelable: true }),
      expect.objectContaining({ content: "must continue", cancelable: false }),
    ]);
    expect(session.isGenerating).toBe(true);

    adapter.emitTurnStarted("turn-later-owner");
    await Promise.resolve();
    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({ content: "will fail", deliveryState: "failed", cancelable: true }),
    ]);
    expect(
      session.messageHistory.filter((entry: any) => entry.type === "user_message" && entry.content === "must continue"),
    ).toHaveLength(1);
  });

  it.each([
    ["authentication", "HTTP 401 Unauthorized"],
    ["certificate", "HTTP 403 Forbidden: invalid peer certificate"],
    ["unsupported model", "model_not_supported: requested model is not supported"],
    ["explicit cancellation", "cancelled by user"],
  ])("hard-stops later queued owners after a terminal %s turn/start failure", async (_label, message) => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "will fail" }));
    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "must wait" }));
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);

    adapter.emitTurnStartFailed(
      { type: "user_message", content: "will fail" },
      { recoverable: false, message: message as string },
    );
    await Promise.resolve();

    const session = bridge.getSession("s1")!;
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    expect(session.state).toMatchObject({
      backend_state: "broken",
      backend_error: expect.stringContaining(message as string),
    });
    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({ content: "will fail", deliveryState: "failed", cancelable: true }),
      expect.objectContaining({ content: "must wait" }),
    ]);
    expect(session.pendingCodexTurns).toEqual([
      expect.objectContaining({ userContent: "must wait", status: "queued" }),
    ]);
    expect(session.isGenerating).toBe(false);
  });

  it("fails closed for stale retry ids and cancels the exact failed owner", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "failed cancellable owner", client_msg_id: "failed-cancel" }),
    );
    adapter.emitTurnStartFailed(
      { type: "user_message", content: "failed cancellable owner" },
      { recoverable: false, message: "input_too_large: max_chars=1048576" },
    );

    const session = bridge.getSession("s1")!;
    const failedId = session.pendingCodexInputs[0]?.id;
    expect(failedId).toBeTruthy();
    adapter.sendBrowserMessage.mockClear();
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "retry_pending_codex_input", id: "stale-failed-owner" }),
    );
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(session.pendingCodexInputs[0]).toMatchObject({ id: failedId, deliveryState: "failed" });

    browser.send.mockClear();
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: failedId,
        client_msg_id: "cancel-failed-owner-action",
      }),
    );
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(
      browser.send.mock.calls
        .map(([arg]: [string]) => JSON.parse(arg))
        .some(
          (msg: any) =>
            msg.type === "codex_pending_input_cancelled" &&
            msg.input?.id === failedId &&
            msg.input?.clientMsgId === "failed-cancel",
        ),
    ).toBe(true);
    expect(session.processedClientMessageIdSet.has("cancel-failed-owner-action")).toBe(true);
  });

  it("flushes verification-first continuation to a new adapter on reattach", async () => {
    // First adapter: simulate receipt-aware turn-start failure.
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));
    const original = adapter1.sendBrowserMessage.mock.calls[0]?.[0] as any;
    adapter1.emitTurnStartFailed(original);
    await flushAsync();
    const queuedContinuation = getPendingCodexTurn(bridge.getSession("s1")!);
    expectCodexStartPendingTurnLike(queuedContinuation, {
      firstContentContaining: "verification-first continuation",
      status: "dispatched",
    });
    // Model the already-authored continuation being returned to the queue when its adapter closes.
    queuedContinuation.status = "queued";
    adapter1.emitDisconnect();

    // Second adapter: should receive the already-authoritative queued continuation.
    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter2 as any);
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-reattach" });
    await flushAsync();

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const reattachedCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const reattachedMsg = reattachedCalls[0]?.[0] as any;
    expect(reattachedMsg).toBeDefined();
    expect(getCodexStartPendingInputs(reattachedMsg)[0]?.content).toContain("verification-first continuation");
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContentContaining: "verification-first continuation",
      status: "dispatched",
    });
  });

  it("does not flush queued messages before Codex session_meta confirms reconnect", () => {
    // Guards the session-140 regression boundary: queued messages must wait
    // for session_meta so resume reconciliation runs before any replay.
    const session = bridge.getOrCreateSession("s1", "codex");
    session.pendingCodexTurns.push({
      adapterMsg: { type: "user_message", content: "hello again" },
      userMessageId: "queued-before-session-meta",
      userContent: "hello again",
      historyIndex: -1,
      status: "queued",
      dispatchCount: 0,
      createdAt: 1,
      updatedAt: 1,
      acknowledgedAt: null,
      turnTarget: null,
      lastError: null,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();

    emitCodexSessionReady(adapter, { cliSessionId: "thread-reattach" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello again" }),
    );
    expect(session.pendingMessages).toHaveLength(0);
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: { type: "user_message", content: "hello again" },
      status: "dispatched",
    });
  });

  it("executes pending Codex rollback on session reattach before resume hydration", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    session.messageHistory = [];
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    emitCodexSessionReady(adapter, {
      cliSessionId: "thread-rollback-reattach",
      resumeSnapshot: {
        threadId: "thread-rollback-reattach",
        turnCount: 3,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [{ type: "userMessage", text: "stale replay text" }],
          },
        ],
        lastTurn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [{ type: "userMessage", text: "stale replay text" }],
        },
        threadStatus: "idle",
      },
    });
    await promise;

    expect(adapter.rollbackTurns).toHaveBeenCalledWith(2);
    expect(session.pendingCodexRollback).toBeNull();
    expect(session.messageHistory).toEqual([]);
  });

  it("records pending Codex rollback failure on session reattach without hydrating stale resume history", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    adapter.rollbackTurns.mockRejectedValueOnce(new Error("rollback refused"));
    bridge.attachCodexAdapter("s1", adapter as any);

    emitCodexSessionReady(adapter, {
      cliSessionId: "thread-rollback-failure",
      resumeSnapshot: {
        threadId: "thread-rollback-failure",
        turnCount: 3,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [{ type: "userMessage", text: "stale replay text" }],
          },
        ],
        lastTurn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [{ type: "userMessage", text: "stale replay text" }],
        },
        threadStatus: "idle",
      },
    });

    await expect(promise).rejects.toThrow("rollback refused");
    expect(session.pendingCodexRollback).toBeNull();
    expect(session.pendingCodexRollbackError).toBe("rollback refused");
    expect(session.messageHistory).toEqual([]);
  });

  it("preserves pending Codex rollback across init error so a later reconnect can retry", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    adapter.emitInitError("codex init failed");

    await expect(promise).rejects.toThrow("codex init failed");
    expect(session.pendingCodexRollback).toEqual({ numTurns: 2, truncateIdx: 0, clearCodexState: true });
    expect(session.pendingCodexRollbackError).toBe("codex init failed");
    expect(session.messageHistory).toEqual([]);
  });

  it("ignores a late receipt-aware turn/start failure from a stale adapter", async () => {
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "replay me" }));

    // Simulate authoritative reconnect work being dispatched through adapter2 before adapter1's
    // delayed failure arrives. The stale callback must not mutate or duplicate adapter2's live owner.
    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter2 as any);
    const session = bridge.getSession("s1")!;
    const activeHead = getPendingCodexTurn(session);
    activeHead.status = "queued";
    activeHead.turnId = null;
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-active" });
    expect(adapter2.sendBrowserMessage).toHaveBeenCalledOnce();
    expect(activeHead).toMatchObject({ status: "dispatched", dispatchCount: 2 });
    const recoveryBefore = structuredClone(session.state.codex_turn_recovery ?? null);
    const historyBefore = structuredClone(activeHead.historyIncorporation);
    adapter2.sendBrowserMessage.mockClear();

    adapter1.emitTurnStartFailed(structuredClone(activeHead.adapterMsg));
    await flushAsync();

    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalled();
    expect(getPendingCodexTurn(session)).toBe(activeHead);
    expect(activeHead).toMatchObject({ status: "dispatched", dispatchCount: 2 });
    expect(activeHead.historyIncorporation).toEqual(historyBefore);
    expect(session.state.codex_turn_recovery ?? null).toEqual(recoveryBefore);
    expect(session.pendingMessages).toHaveLength(0);
  });
});
