import { sessionTag } from "../session-tag.js";
import {
  CODEX_PROCESS_RECONNECT_MAX_ATTEMPTS,
  CODEX_PROVIDER_RESULT_RECONNECT_TIMEOUT_MS,
  beginCodexRecoveryAttempt,
  canContinueCodexOutageRecovery,
  clearCodexRecoveryRuntimeState,
  getCodexRecoveryRuntimeReason,
  invalidateCodexRecoveryAttempt,
  isCodexPersistentOutageRecoveryReason,
  isCurrentCodexRecoveryAttempt,
  resolveCodexAutoRecoveryReason,
  setCodexRecoveryRuntimeReason,
  stopIneligibleCodexOutageRecovery,
  withCodexOutageRecoveryDescriptor,
} from "../codex-process-reconnect.js";
import { normalizeCodexTurnRecoveryState, repairRestoredCodexTurnRecovery } from "./codex-interrupted-turn-recovery.js";
import { normalizePersistedCodexTurn } from "./codex-persisted-turn-normalization.js";
export { normalizePersistedCodexTurn };
import { formatReplyContentForPreview } from "../../shared/reply-context.js";
import { getLastActualHumanInputTimestamp, restoreSessionMessagePreview } from "../user-message-classification.js";
import type { PersistedSession } from "../session-store.js";
import type {
  BoardRow,
  CodexLeaderRecycleContinuation,
  ContextUsageHistoryEntry,
  ContentBlock,
  SessionTaskEntry,
  SessionNotification,
  SessionAttentionRecord,
} from "../session-types.js";
import { detectQuestEvent } from "./quest-detector.js";
import { normalizePersistedRecoveryDeliveryTransfers } from "./recovery-delivery-transfer.js";
import {
  createCodexNativeSubagentRegistry,
  deriveCodexNativeSubagentSnapshot,
  markRestoredCodexNativeSubagentsUnknown,
  normalizeCodexNativeSubagentRegistry,
  type CodexNativeSubagentRegistry,
} from "../codex-native-subagent-state.js";
import {
  clearAttentionAndMarkRead,
  deriveNotificationStatusUpdatedAt,
  getNotificationStatusSnapshot,
  normalizeStatusNumber,
  setAttention,
} from "./session-notification-controller.js";
import type { AttentionReason, NotificationUrgency } from "./session-notification-controller.js";
import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  CLISystemCompactBoundaryMessage,
  QuestLifecycleEventSnapshot,
  SessionState,
  ToolResultPreview,
} from "../session-types.js";
export {
  clearActionAttentionIfNoNotifications,
  clearAttentionAndMarkRead,
  getNotificationStatusSnapshot,
  getUserVisibleSessionNotifications,
  markAllNotificationsDone,
  markAllNotificationsDoneBySessionId,
  markNotificationDone,
  markNotificationDoneBySessionId,
  notifyUser,
  notifyUserBySessionId,
  recordThreadReadyUnreadNotifications,
  setNotificationMuted,
  setNotificationMutedBySessionId,
  setAttention,
} from "./session-notification-controller.js";
export type { NotificationStatusSnapshot } from "./session-notification-controller.js";

type SessionLike = any;
type SessionClaimedQuestState = Omit<QuestLifecycleEventSnapshot, "questId" | "status"> & {
  id: string;
  status?: string;
  verificationInboxUnread?: boolean;
};
type QuestLifecycleEventInput = {
  id: string;
  kind: Extract<BrowserIncomingMessage, { type: "quest_lifecycle_event" }>["kind"];
  timestamp?: number;
};

export interface SessionRegistryDeps {
  makeDefaultState: (sessionId: string, backendType: string) => unknown;
  pruneToolResultsForCurrentHistory: (session: SessionLike) => void;
  broadcastToSession: (sessionId: string, msg: BrowserIncomingMessage) => void;
  refreshSessionConversation: (sessionId: string) => void;
  recomputeAndBroadcastHistoryBytes: (session: SessionLike) => void;
  persistSession: (session: SessionLike) => void;
  persistSessionSync: (sessionId: string) => void;
  broadcastToBrowsers?: (session: SessionLike, msg: BrowserIncomingMessage) => void;
  broadcastBoard?: (session: SessionLike, board: BoardRow[], completedBoard: BoardRow[]) => void;
  broadcastSessionUpdate?: (session: SessionLike, update: Record<string, unknown>) => void;
  requestCliRelaunch?: (sessionId: string) => void;
  emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  attached?: (session: SessionLike) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => any;
  setLastUserMessageAt?: (sessionId: string, timestamp: number | undefined) => void;
  recoveryTimeoutMs?: number;
  maxAdapterRelaunchFailures?: number;
  getHerdedSessionIds?: (leaderId: string) => string[];
  getSessionNum?: (sessionId: string) => number | undefined;
  getSessionName?: (sessionId: string) => string | undefined;
  deriveSessionStatus?: (session: SessionLike & { isGenerating: boolean }) => string | null;
  clearAttentionAndMarkRead?: (session: SessionLike & { isGenerating: boolean }) => void;
  setAttentionReview?: (session: SessionLike & { isGenerating: boolean }) => void;
  broadcastLeaderGroupIdle?: (
    session: SessionLike & { isGenerating: boolean },
    payload: Record<string, unknown>,
  ) => void;
  recordServerEvent?: (
    sessionId: string,
    reason: string,
    payload: Record<string, unknown>,
    backendType: string,
    cwd: string,
  ) => void;
  delayMs?: number;
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean; notificationId?: string },
  ) => void;
  scheduleCompletedNotification?: (sessionId: string, detail: string) => void;
  scheduleResultCompletedNotification?: (sessionId: string) => void;
  scheduleErrorNotification?: (sessionId: string, detail: string) => void;
  resolveQuestTitle?: (questId: string) => Promise<string | undefined>;
  broadcastTaskHistory?: (session: SessionLike) => void;
  onSessionNamedByQuest?: (sessionId: string, title: string) => void;
  invalidateLeaderThreadTabsForQuestIds?: (questIds: readonly string[]) => void;
  finalizeCodexRecoveringTurn?: (session: SessionLike, reason: "recovery_timeout" | "recovery_failed") => void;
}

type SessionRuntimeOptions = {
  pendingPermissions?: Map<string, any>;
  messageHistory?: BrowserIncomingMessage[];
  codexNativeSubagents?: CodexNativeSubagentRegistry;
  frozenCount?: number;
  pendingMessages?: string[];
  forceCompactPending?: boolean;
  pendingCodexTurns?: any[];
  codexTerminalRecoveries?: import("../session-types.js").CodexTurnRecoveryState[];
  pendingCodexInputs?: any[];
  recoveryDeliveryTransfers?: import("./recovery-delivery-transfer.js").RecoveryDeliveryTransfer[];
  pendingCodexRollback?: { numTurns: number; truncateIdx: number; clearCodexState: boolean } | null;
  pendingCodexRollbackError?: string | null;
  codexLeaderRecycleContinuation?: CodexLeaderRecycleContinuation | null;
  pendingStartupMemoryCatalogInjection?: boolean;
  codexFreshTurnRequiredUntilTurnId?: string | null;
  codexModelSwitchCompactionGuard?: import("../session-types.js").CodexModelSwitchCompactionGuard | null;
  codexPendingDeliveryProofSignals?: import("../session-types.js").CodexPendingDeliveryProofSignal[];
  contextUsageHistory?: ContextUsageHistoryEntry[];
  nextEventSeq?: number;
  eventBuffer?: any[];
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  toolResults?: Map<any, any>;
  taskHistory?: SessionTaskEntry[];
  keywords?: string[];
  board?: Map<any, any>;
  completedBoard?: Map<any, any>;
  notifications?: SessionNotification[];
  leaderThreadOutcomeValidatedHistoryLength?: number;
  pendingLeaderRejectedReadyThreadKeys?: string[];
  attentionRecords?: SessionAttentionRecord[];
  notificationCounter?: number;
  notificationStatusVersion?: number;
  notificationStatusUpdatedAt?: number;
  lastReadAt?: number;
  attentionReason?: "action" | "error" | "review" | null;
  manualUnread?: boolean;
};

function createSessionRuntime(
  sessionId: string,
  backendType: string,
  state: any,
  options: SessionRuntimeOptions = {},
): SessionLike {
  // Internal stream retries belong to the current adapter, never a restored process.
  state.codex_stream_retry = null;
  const processedClientMessageIds = options.processedClientMessageIds ?? [];
  const notifications = options.notifications ?? [];
  const notificationStatusVersion = normalizeStatusNumber(options.notificationStatusVersion, 0);
  const notificationStatusUpdatedAt = normalizeStatusNumber(
    options.notificationStatusUpdatedAt,
    deriveNotificationStatusUpdatedAt(notifications),
  );
  return {
    id: sessionId,
    backendType,
    backendSocket: null,
    codexAdapter: null,
    claudeSdkAdapter: null,
    browserSockets: new Set(),
    state,
    pendingPermissions: options.pendingPermissions ?? new Map(),
    pendingControlRequests: new Map(),
    messageHistory: options.messageHistory ?? [],
    codexNativeSubagents: options.codexNativeSubagents ?? createCodexNativeSubagentRegistry(sessionId),
    frozenCount: options.frozenCount ?? 0,
    pendingMessages: options.pendingMessages ?? [],
    forceCompactPending: options.forceCompactPending ?? false,
    pendingCodexTurns: options.pendingCodexTurns ?? [],
    codexTerminalRecoveries: options.codexTerminalRecoveries ?? [],
    pendingCodexInputs: options.pendingCodexInputs ?? [],
    recoveryDeliveryTransfers: options.recoveryDeliveryTransfers ?? [],
    pendingCodexRollback: options.pendingCodexRollback ?? null,
    pendingCodexRollbackError: options.pendingCodexRollbackError ?? null,
    codexLeaderRecycleContinuation: options.codexLeaderRecycleContinuation ?? null,
    pendingStartupMemoryCatalogInjection: options.pendingStartupMemoryCatalogInjection === true,
    codexFreshTurnRequiredUntilTurnId: options.codexFreshTurnRequiredUntilTurnId ?? null,
    codexModelSwitchCompactionGuard: options.codexModelSwitchCompactionGuard ?? null,
    codexSuppressRecoveryForCurrentCompaction: false,
    codexPendingDeliveryProofSignals: options.codexPendingDeliveryProofSignals ?? [],
    contextUsageHistory: options.contextUsageHistory ?? [],
    pendingCodexRollbackWaiter: null,
    nextEventSeq: options.nextEventSeq ?? 1,
    eventBuffer: options.eventBuffer ?? [],
    lastAckSeq: options.lastAckSeq ?? 0,
    processedClientMessageIds,
    processedClientMessageIdSet: new Set(processedClientMessageIds),
    toolResults: options.toolResults ?? new Map(),
    toolProgressOutput: new Map(),
    pendingQuestCommands: new Map(),
    assistantAccumulator: new Map(),
    toolStartTimes: new Map(),
    worktreeStateFingerprint: "",
    diffStatsCacheKey: undefined,
    diffStatsCacheResult: null,
    codexToolResultWatchdogs: new Map(),
    isGenerating: false,
    generationStartedAt: null,
    questStatusAtTurnStart: null,
    messageCountAtTurnStart: 0,
    interruptedDuringTurn: false,
    interruptSourceDuringTurn: null,
    compactedDuringTurn: false,
    provisionalStuckRecovery: null,
    consecutiveAdapterFailures: 0,
    lastAdapterFailureAt: null,
    intentionalCodexRelaunchUntil: null,
    intentionalCodexRelaunchReason: null,
    userMessageIdsThisTurn: [],
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    recentAskVisibleResponseThreads: new Set(),
    queuedTurnInterruptSources: [],
    queuedTurnActiveRoutes: [],
    cliInitReceived: false,
    lastCliMessageAt: 0,
    lastCliPingAt: 0,
    lastToolProgressAt: 0,
    optimisticRunningTimer: null,
    lastOutboundUserNdjson: null,
    stuckNotifiedAt: null,
    lastReadAt: options.lastReadAt ?? 0,
    lastUserMessageDateTag: "",
    lastMessagePreviewAt: undefined,
    attentionReason: options.attentionReason ?? null,
    manualUnread: options.manualUnread === true,
    codexDisconnectGraceTimer: null,
    disconnectGraceTimer: null,
    disconnectWasGenerating: false,
    seamlessReconnect: false,
    relaunchPending: false,
    taskHistory: options.taskHistory ?? [],
    keywords: options.keywords ?? [],
    board: options.board ?? new Map(),
    completedBoard: options.completedBoard ?? new Map(),
    boardStallStates: new Map(),
    boardDispatchStates: new Map(),
    notifications,
    leaderThreadOutcomeValidatedHistoryLength: options.leaderThreadOutcomeValidatedHistoryLength ?? 0,
    pendingLeaderRejectedReadyThreadKeys: options.pendingLeaderRejectedReadyThreadKeys ?? [],
    attentionRecords: options.attentionRecords ?? [],
    notificationCounter: options.notificationCounter ?? 0,
    notificationStatusVersion,
    notificationStatusUpdatedAt,
    diffStatsDirty: true,
    searchDataOnly: false,
    searchExcerpts: [],
    evaluatingAborts: new Map(),
    cliInitializeSent: false,
    cliResuming: false,
    cliResumingClearTimer: null,
    dropReplayHistoryAfterRevert: false,
    claudeCompactBoundarySeen: false,
  };
}

export function getOrCreateSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  backendType: string | undefined,
  deps: Pick<SessionRegistryDeps, "makeDefaultState">,
): SessionLike {
  let session = sessions.get(sessionId);
  if (!session) {
    const type = backendType || "claude";
    session = createSessionRuntime(sessionId, type, deps.makeDefaultState(sessionId, type));
    sessions.set(sessionId, session);
  } else if (backendType) {
    session.backendType = backendType;
    session.state.backend_type = backendType;
  }
  return session;
}

export function applyInitialSessionState(
  session: SessionLike,
  options: {
    containerizedHostCwd?: string;
    cwd?: string;
    treeGroupId?: string;
    memorySessionSpaceSlug?: string;
    askPermission?: boolean;
    uiMode?: "plan" | "agent";
    resumedFromExternal?: boolean;
    worktree?: {
      repoRoot: string;
      defaultBranch?: string;
      diffBaseBranch?: string;
    };
  },
  deps: { persistSession: (session: SessionLike) => void; prefillSlashCommands: (session: SessionLike) => void },
): void {
  let shouldPersist = false;

  if (options.containerizedHostCwd) {
    session.state.is_containerized = true;
    session.state.cwd = options.containerizedHostCwd;
  }
  if (options.cwd && !session.state.cwd) {
    session.state.cwd = options.cwd;
  }
  if (typeof options.treeGroupId === "string") {
    const normalizedTreeGroupId = options.treeGroupId.trim() || "default";
    if (session.state.treeGroupId !== normalizedTreeGroupId) {
      session.state.treeGroupId = normalizedTreeGroupId;
      shouldPersist = true;
    }
  }
  if (typeof options.memorySessionSpaceSlug === "string") {
    const normalizedMemorySessionSpaceSlug = options.memorySessionSpaceSlug.trim();
    if (normalizedMemorySessionSpaceSlug && session.state.memorySessionSpaceSlug !== normalizedMemorySessionSpaceSlug) {
      session.state.memorySessionSpaceSlug = normalizedMemorySessionSpaceSlug;
      shouldPersist = true;
    }
  }
  if (options.worktree) {
    session.state.is_worktree = true;
    session.state.repo_root = options.worktree.repoRoot;
    session.state.cwd = options.cwd ?? session.state.cwd;
    if (options.worktree.defaultBranch) {
      session.state.git_default_branch = options.worktree.defaultBranch;
    }
    const diffBase = options.worktree.diffBaseBranch || options.worktree.defaultBranch;
    if (diffBase && !session.state.diff_base_branch_explicit && !session.state.diff_base_branch) {
      session.state.diff_base_branch = diffBase;
    }
  }
  if (options.askPermission !== undefined) {
    session.state.askPermission = options.askPermission;
    session.state.uiMode = options.uiMode ?? "plan";
    shouldPersist = true;
  }
  if (options.resumedFromExternal) {
    session.resumedFromExternal = true;
  }
  if (shouldPersist) {
    deps.persistSession(session);
  }
  deps.prefillSlashCommands(session);
}

export function prepareSessionForRevert(
  session: SessionLike,
  truncateIdx: number,
  deps: Pick<SessionRegistryDeps, "pruneToolResultsForCurrentHistory" | "broadcastToSession" | "setLastUserMessageAt">,
  options?: { clearCodexState?: boolean },
): SessionLike {
  session.messageHistory = session.messageHistory.slice(0, truncateIdx);
  session.frozenCount = Math.min(session.frozenCount, session.messageHistory.length);
  deps.pruneToolResultsForCurrentHistory(session);
  session.assistantAccumulator?.clear?.();
  session.pendingMessages = [];
  session.lastOutboundUserNdjson = null;
  session.userMessageIdsThisTurn = [];
  session.queuedTurnStarts = 0;
  session.queuedTurnReasons = [];
  session.queuedTurnUserMessageIds = [];
  session.queuedTurnInterruptSources = [];
  session.queuedTurnActiveRoutes = [];
  session.interruptedDuringTurn = false;
  session.interruptSourceDuringTurn = null;
  session.isGenerating = false;
  session.generationStartedAt = null;
  session.disconnectWasGenerating = false;
  session.seamlessReconnect = false;
  session.toolStartTimes?.clear?.();
  session.toolProgressOutput?.clear?.();
  session.dropReplayHistoryAfterRevert = session.backendType === "claude" || session.backendType === "claude-sdk";

  if (session.taskHistory?.length) {
    const remainingUserMsgIds = new Set(
      session.messageHistory
        .filter((msg: any) => msg.type === "user_message")
        .map((msg: any) => msg.id)
        .filter((id: unknown): id is string => typeof id === "string"),
    );
    const prevCount = session.taskHistory.length;
    session.taskHistory = session.taskHistory.filter((task: any) => remainingUserMsgIds.has(task.triggerMessageId));
    if (session.taskHistory.length !== prevCount) {
      deps.broadcastToSession(session.id, {
        type: "session_task_history",
        tasks: session.taskHistory,
      } as BrowserIncomingMessage);
    }
  }

  session.pendingPermissions.clear();
  deps.broadcastToSession(session.id, { type: "permissions_cleared" } as BrowserIncomingMessage);

  session.eventBuffer = [];
  session.awaitingCompactSummary = false;
  session.claudeCompactBoundarySeen = false;
  session.compactedDuringTurn = false;
  session.provisionalStuckRecovery = null;
  session.forceCompactPending = false;
  if (session.state) session.state.is_compacting = false;

  if (options?.clearCodexState) {
    session.pendingCodexTurns = [];
    session.pendingCodexInputs = [];
    session.codexNativeSubagents = createCodexNativeSubagentRegistry(session.id);
    session.state.codex_native_subagents = deriveCodexNativeSubagentSnapshot(session.codexNativeSubagents);
    session.pendingCodexRollback = null;
    session.pendingCodexRollbackError = null;
    if (session.optimisticRunningTimer) {
      clearTimeout(session.optimisticRunningTimer);
      session.optimisticRunningTimer = null;
    }
    deps.broadcastToSession(session.id, { type: "codex_pending_inputs", inputs: [] } as BrowserIncomingMessage);
  }

  restoreSessionMessagePreview(session);
  deps.setLastUserMessageAt?.(
    session.id,
    getLastActualHumanInputTimestamp(session.messageHistory, session.pendingCodexInputs),
  );
  return session;
}

export function finalizeCodexRollback(
  session: SessionLike,
  deps: Pick<
    SessionRegistryDeps,
    "recomputeAndBroadcastHistoryBytes" | "persistSessionSync" | "broadcastToSession" | "refreshSessionConversation"
  >,
  revertedSession: SessionLike | null,
): void {
  const waiter = session.pendingCodexRollbackWaiter;
  session.pendingCodexRollback = null;
  session.pendingCodexRollbackError = null;
  waiter?.resolve();
  session.pendingCodexRollbackWaiter = null;
  if (!revertedSession) return;
  deps.recomputeAndBroadcastHistoryBytes(session);
  deps.persistSessionSync(session.id);
  deps.refreshSessionConversation(session.id);
  deps.broadcastToSession(session.id, { type: "status_change", status: "idle" } as BrowserIncomingMessage);
}

export function beginCodexRollback(
  session: SessionLike,
  plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean },
  deps: Pick<SessionRegistryDeps, "persistSession">,
  onFinalize: () => void,
): { promise: Promise<void>; requiresRelaunch: boolean } {
  if (!Number.isInteger(plan.numTurns) || plan.numTurns < 1) {
    return {
      promise: Promise.reject(new Error(`Invalid rollback turn count: ${plan.numTurns}`)),
      requiresRelaunch: false,
    };
  }
  if (!Number.isInteger(plan.truncateIdx) || plan.truncateIdx < 0) {
    return {
      promise: Promise.reject(new Error(`Invalid rollback truncate index: ${plan.truncateIdx}`)),
      requiresRelaunch: false,
    };
  }

  session.pendingCodexRollback = plan;
  session.pendingCodexRollbackError = null;
  deps.persistSession(session);

  const liveAdapter = session.codexAdapter;
  if (liveAdapter?.isConnected()) {
    return {
      promise: liveAdapter
        .rollbackTurns(plan.numTurns)
        .then(() => {
          onFinalize();
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = message;
          session.pendingCodexRollbackWaiter?.reject(new Error(message));
          session.pendingCodexRollbackWaiter = null;
          deps.persistSession(session);
          throw err;
        }),
      requiresRelaunch: false,
    };
  }

  const promise = new Promise<void>((resolve, reject) => {
    session.pendingCodexRollbackWaiter = { resolve, reject };
    deps.persistSession(session);
  });
  return { promise, requiresRelaunch: true };
}

function normalizePersistedCodexLeaderRecycleContinuation(value: unknown): CodexLeaderRecycleContinuation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const trigger =
    record.trigger === "threshold" ||
    record.trigger === "manual_compact" ||
    record.trigger === "manual_recycle" ||
    record.trigger === "context_window_exhausted"
      ? record.trigger
      : null;
  if (!trigger || typeof record.content !== "string" || !record.content.trim()) return null;
  return {
    trigger,
    requestedAt: typeof record.requestedAt === "number" ? record.requestedAt : Date.now(),
    content: record.content,
    ...(typeof record.recoveryId === "string" && record.recoveryId.trim() ? { recoveryId: record.recoveryId } : {}),
    ...(typeof record.threadKey === "string" && record.threadKey.trim() ? { threadKey: record.threadKey } : {}),
    ...(typeof record.questId === "string" && record.questId.trim() ? { questId: record.questId } : {}),
  };
}

function normalizePersistedCodexModelSwitchCompactionGuard(
  value: unknown,
): import("../session-types.js").CodexModelSwitchCompactionGuard | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.nextModel !== "string" || !record.nextModel.trim()) return null;
  if (typeof record.expiresAt !== "number" || record.expiresAt <= Date.now()) return null;
  return {
    ...(typeof record.previousModel === "string" && record.previousModel.trim()
      ? { previousModel: record.previousModel }
      : {}),
    nextModel: record.nextModel,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    expiresAt: record.expiresAt,
    ...(typeof record.modelActivityObserved === "boolean"
      ? { modelActivityObserved: record.modelActivityObserved }
      : {}),
  };
}

export async function restorePersistedSessions(
  sessions: Map<string, SessionLike>,
  persisted: any[],
  deps: {
    recoverToolStartTimesFromHistory: (session: SessionLike) => void;
    finalizeRecoveredDisconnectedTerminalTools: (session: SessionLike, reason: string) => void;
    scheduleCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    reconcileRestoredBoardState: (session: SessionLike) => Promise<void>;
    setLastUserMessageAt?: (sessionId: string, timestamp: number | undefined) => void;
    resumeRecoveryDeliveryTransfers?: (session: SessionLike) => Promise<void>;
    persistHistoryMetadataRepair?: (session: SessionLike, expectedFrozenCount: number) => Promise<void>;
  },
): Promise<number> {
  let count = 0;
  for (const p of persisted) {
    if (sessions.has(p.id)) continue;
    // Pre-discriminator `attentionReason: "review"` is ambiguous with stale or
    // closed notification-derived review state. Preserve those safeguards by
    // recognizing manual unread only when the explicit persisted bit exists.
    const restoredManualUnread = p.manualUnread === true;

    // Archived sessions loaded with search-data-only: skip heavyweight restore
    if (p._searchDataOnly) {
      const session = createSessionRuntime(p.id, p.state.backend_type || "claude", p.state, {
        pendingPermissions: new Map(),
        messageHistory: [],
        codexNativeSubagents: normalizeCodexNativeSubagentRegistry(p.codexNativeSubagents, p.id),
        frozenCount: 0,
        pendingMessages: [],
        forceCompactPending: false,
        pendingCodexTurns: [],
        pendingCodexInputs: [],
        pendingCodexRollback: null,
        pendingCodexRollbackError: null,
        codexLeaderRecycleContinuation: null,
        codexFreshTurnRequiredUntilTurnId: null,
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        toolResults: new Map(),
        contextUsageHistory: Array.isArray(p.contextUsageHistory) ? p.contextUsageHistory : [],
        lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
        attentionReason: p.attentionReason ?? null,
        manualUnread: restoredManualUnread,
        taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
        board: new Map(Array.isArray(p.board) ? p.board.map((row: any) => [row.questId, row]) : []),
        completedBoard: new Map(
          Array.isArray(p.completedBoard) ? p.completedBoard.map((row: any) => [row.questId, row]) : [],
        ),
        notifications: Array.isArray(p.notifications) ? p.notifications : [],
        attentionRecords: Array.isArray(p.attentionRecords) ? p.attentionRecords : [],
        notificationStatusVersion: normalizeStatusNumber(p.notificationStatusVersion, 0),
        notificationStatusUpdatedAt:
          typeof p.notificationStatusUpdatedAt === "number" ? p.notificationStatusUpdatedAt : undefined,
        notificationCounter: Array.isArray(p.notifications)
          ? p.notifications.reduce((max: number, n: SessionNotification) => {
              const num = parseInt(n.id.replace("n-", ""), 10);
              return Number.isFinite(num) && num > max ? num : max;
            }, 0)
          : 0,
      });
      session.state.backend_type = session.backendType;
      session.state.backend_state = session.state.backend_state ?? "disconnected";
      session.state.backend_error = session.state.backend_error ?? null;
      session.state.codex_turn_recovery = normalizeCodexTurnRecoveryState(session.state.codex_turn_recovery);
      markRestoredCodexNativeSubagentsUnknown(session.codexNativeSubagents);
      session.state.codex_native_subagents = deriveCodexNativeSubagentSnapshot(session.codexNativeSubagents);
      session.searchDataOnly = true;
      session.searchExcerpts = p._searchExcerpts ?? [];
      sessions.set(p.id, session);
      count += 1;
      continue;
    }

    const restoredCodexTurns = Array.isArray(p.pendingCodexTurns)
      ? p.pendingCodexTurns.map((turn: any) => normalizePersistedCodexTurn(turn))
      : [];
    const session = createSessionRuntime(p.id, p.state.backend_type || "claude", p.state, {
      pendingPermissions: new Map(p.pendingPermissions || []),
      messageHistory: p.messageHistory || [],
      codexNativeSubagents: normalizeCodexNativeSubagentRegistry(p.codexNativeSubagents, p.id),
      frozenCount:
        typeof p._frozenCount === "number" ? Math.max(0, Math.min(p._frozenCount, (p.messageHistory || []).length)) : 0,
      pendingMessages: p.pendingMessages || [],
      forceCompactPending:
        typeof (p as { forceCompactPending?: unknown }).forceCompactPending === "boolean"
          ? ((p as { forceCompactPending: boolean }).forceCompactPending ?? false)
          : false,
      pendingCodexTurns: restoredCodexTurns,
      codexTerminalRecoveries: Array.isArray(p.codexTerminalRecoveries)
        ? p.codexTerminalRecoveries.flatMap((value: unknown) => {
            const recovery = normalizeCodexTurnRecoveryState(value);
            return recovery ? [{ ...recovery, status: "action_required" as const }] : [];
          })
        : [],
      pendingCodexInputs: Array.isArray(p.pendingCodexInputs) ? p.pendingCodexInputs : [],
      recoveryDeliveryTransfers: normalizePersistedRecoveryDeliveryTransfers(p.recoveryDeliveryTransfers),
      pendingCodexRollback:
        p.pendingCodexRollback &&
        typeof p.pendingCodexRollback === "object" &&
        Number.isInteger((p.pendingCodexRollback as { numTurns?: number }).numTurns) &&
        Number.isInteger((p.pendingCodexRollback as { truncateIdx?: number }).truncateIdx) &&
        typeof (p.pendingCodexRollback as { clearCodexState?: unknown }).clearCodexState === "boolean" &&
        (p.pendingCodexRollback as { numTurns: number }).numTurns > 0 &&
        (p.pendingCodexRollback as { truncateIdx: number }).truncateIdx >= 0
          ? {
              numTurns: (p.pendingCodexRollback as { numTurns: number }).numTurns,
              truncateIdx: (p.pendingCodexRollback as { truncateIdx: number }).truncateIdx,
              clearCodexState: (p.pendingCodexRollback as { clearCodexState: boolean }).clearCodexState,
            }
          : null,
      pendingCodexRollbackError: typeof p.pendingCodexRollbackError === "string" ? p.pendingCodexRollbackError : null,
      codexLeaderRecycleContinuation: normalizePersistedCodexLeaderRecycleContinuation(
        p.codexLeaderRecycleContinuation,
      ),
      pendingStartupMemoryCatalogInjection: p.pendingStartupMemoryCatalogInjection === true,
      codexFreshTurnRequiredUntilTurnId:
        typeof p.codexFreshTurnRequiredUntilTurnId === "string" ? p.codexFreshTurnRequiredUntilTurnId : null,
      codexModelSwitchCompactionGuard: normalizePersistedCodexModelSwitchCompactionGuard(
        p.codexModelSwitchCompactionGuard,
      ),
      codexPendingDeliveryProofSignals: Array.isArray(p.codexPendingDeliveryProofSignals)
        ? p.codexPendingDeliveryProofSignals
        : [],
      contextUsageHistory: Array.isArray(p.contextUsageHistory) ? p.contextUsageHistory : [],
      nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
      eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
      lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
      processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
      toolResults: new Map(Array.isArray(p.toolResults) ? p.toolResults : []),
      lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
      attentionReason: p.attentionReason ?? null,
      manualUnread: restoredManualUnread,
      taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      board: new Map(Array.isArray(p.board) ? p.board.map((row: any) => [row.questId, row]) : []),
      completedBoard: new Map(
        Array.isArray(p.completedBoard) ? p.completedBoard.map((row: any) => [row.questId, row]) : [],
      ),
      notifications: Array.isArray(p.notifications) ? p.notifications : [],
      leaderThreadOutcomeValidatedHistoryLength: Math.min(
        normalizeStatusNumber(p.leaderThreadOutcomeValidatedHistoryLength, (p.messageHistory || []).length),
        (p.messageHistory || []).length,
      ),
      pendingLeaderRejectedReadyThreadKeys: Array.isArray(p.pendingLeaderRejectedReadyThreadKeys)
        ? p.pendingLeaderRejectedReadyThreadKeys.filter(
            (threadKey: unknown): threadKey is string =>
              typeof threadKey === "string" && (threadKey === "main" || /^q-\d+$/.test(threadKey)),
          )
        : [],
      attentionRecords: Array.isArray(p.attentionRecords) ? p.attentionRecords : [],
      notificationStatusVersion: normalizeStatusNumber(p.notificationStatusVersion, 0),
      notificationStatusUpdatedAt:
        typeof p.notificationStatusUpdatedAt === "number" ? p.notificationStatusUpdatedAt : undefined,
      notificationCounter: Array.isArray(p.notifications)
        ? p.notifications.reduce((max: number, n: SessionNotification) => {
            const num = parseInt(n.id.replace("n-", ""), 10);
            return Number.isFinite(num) && num > max ? num : max;
          }, 0)
        : 0,
    });
    session.state.backend_type = session.backendType;
    session.state.backend_state = session.state.backend_state ?? "disconnected";
    session.state.backend_error = session.state.backend_error ?? null;
    const restoredRecoveryRepair = repairRestoredCodexTurnRecovery(session);
    session.state.codex_turn_recovery = restoredRecoveryRepair.state;
    markRestoredCodexNativeSubagentsUnknown(session.codexNativeSubagents);
    session.state.codex_native_subagents = deriveCodexNativeSubagentSnapshot(session.codexNativeSubagents);

    for (const perm of session.pendingPermissions.values()) {
      if (perm.evaluating) perm.evaluating = undefined;
    }

    restoreSessionMessagePreview(session);
    deps.setLastUserMessageAt?.(
      session.id,
      getLastActualHumanInputTimestamp(session.messageHistory, session.pendingCodexInputs),
    );

    deps.recoverToolStartTimesFromHistory(session);
    deps.finalizeRecoveredDisconnectedTerminalTools(session, "restore_from_disk");
    deps.scheduleCodexToolResultWatchdogs(session, "restore_from_disk");
    await deps.reconcileRestoredBoardState(session);

    sessions.set(p.id, session);
    if (restoredRecoveryRepair.resolvedByHistoricalSuccess) {
      const expectedFrozenCount = Math.max(0, Math.min(session.frozenCount, session.messageHistory.length));
      await deps.persistHistoryMetadataRepair?.(session, expectedFrozenCount);
      console.log(
        `[session-registry] Retired resolved Codex recovery state from restored history for ${sessionTag(session.id)}`,
      );
    }
    await deps.resumeRecoveryDeliveryTransfers?.(session);
    count += 1;
  }
  if (count > 0) {
    console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
  }
  return count;
}

export function removeSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: {
    clearOptimisticRunningTimer: (session: SessionLike, reason: string) => void;
    clearAllCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    clearCodexDisconnectGraceTimer?: (session: SessionLike, reason: string) => void;
    cleanupBranchState: (sessionId: string) => void;
    removeStoredSession?: (sessionId: string) => void;
    removeImages?: (sessionId: string) => void;
    removeSyncedProjectionSubscriber?: (socket: unknown) => void;
    removeSessionAttentionProjection?: (sessionId: string) => void;
  },
): void {
  const session = sessions.get(sessionId);
  if (session) {
    deps.clearOptimisticRunningTimer(session, "remove_session");
    deps.clearAllCodexToolResultWatchdogs(session, "remove_session");
    deps.clearCodexDisconnectGraceTimer?.(session, "remove_session");
    clearCodexRecoveryRuntimeState(session);
    for (const socket of session.browserSockets) deps.removeSyncedProjectionSubscriber?.(socket);
  }
  deps.removeSessionAttentionProjection?.(sessionId);
  sessions.delete(sessionId);
  deps.cleanupBranchState(sessionId);
  deps.removeStoredSession?.(sessionId);
  deps.removeImages?.(sessionId);
}

export function closeSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: {
    clearOptimisticRunningTimer: (session: SessionLike, reason: string) => void;
    clearAllCodexToolResultWatchdogs: (session: SessionLike, reason: string) => void;
    clearCodexDisconnectGraceTimer?: (session: SessionLike, reason: string) => void;
    cleanupBranchState: (sessionId: string) => void;
    removeStoredSession?: (sessionId: string) => void;
    removeImages?: (sessionId: string) => void;
    removeSyncedProjectionSubscriber?: (socket: unknown) => void;
    removeSessionAttentionProjection?: (sessionId: string) => void;
  },
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  deps.clearOptimisticRunningTimer(session, "close_session");
  deps.clearAllCodexToolResultWatchdogs(session, "close_session");
  deps.clearCodexDisconnectGraceTimer?.(session, "close_session");
  clearCodexRecoveryRuntimeState(session);

  if (session.backendSocket) {
    try {
      session.backendSocket.close();
    } catch {}
    session.backendSocket = null;
  }
  if (session.codexAdapter) {
    session.codexAdapter.disconnect().catch(() => {});
    session.codexAdapter = null;
  }
  for (const ws of session.browserSockets) {
    deps.removeSyncedProjectionSubscriber?.(ws);
    try {
      ws.close();
    } catch {}
  }
  session.browserSockets.clear();

  deps.removeSessionAttentionProjection?.(sessionId);
  sessions.delete(sessionId);
  deps.cleanupBranchState(sessionId);
  deps.removeStoredSession?.(sessionId);
  deps.removeImages?.(sessionId);
}

export function buildPersistedSessionPayload(session: SessionLike): PersistedSession {
  const { codex_stream_retry: _streamRetry, ...state } = session.state;
  return {
    id: session.id,
    state,
    messageHistory: session.messageHistory,
    codexNativeSubagents: session.codexNativeSubagents,
    pendingMessages: session.pendingMessages,
    forceCompactPending: session.forceCompactPending,
    pendingCodexTurns: session.pendingCodexTurns,
    codexTerminalRecoveries: session.codexTerminalRecoveries,
    pendingCodexInputs: session.pendingCodexInputs,
    recoveryDeliveryTransfers: session.recoveryDeliveryTransfers,
    pendingCodexRollback: session.pendingCodexRollback,
    pendingCodexRollbackError: session.pendingCodexRollbackError,
    codexLeaderRecycleContinuation: session.codexLeaderRecycleContinuation,
    codexFreshTurnRequiredUntilTurnId: session.codexFreshTurnRequiredUntilTurnId,
    codexModelSwitchCompactionGuard: session.codexModelSwitchCompactionGuard,
    codexPendingDeliveryProofSignals: session.codexPendingDeliveryProofSignals,
    contextUsageHistory: session.contextUsageHistory,
    pendingPermissions: Array.from(session.pendingPermissions.entries()),
    eventBuffer: session.eventBuffer,
    nextEventSeq: session.nextEventSeq,
    lastAckSeq: session.lastAckSeq,
    processedClientMessageIds: session.processedClientMessageIds,
    toolResults: Array.from(session.toolResults.entries()),
    lastReadAt: session.lastReadAt,
    attentionReason: session.attentionReason,
    ...(session.manualUnread === true ? { manualUnread: true } : {}),
    taskHistory: session.taskHistory,
    keywords: session.keywords,
    board: Array.from(session.board.values()),
    completedBoard: Array.from(session.completedBoard.values()),
    notifications: session.notifications,
    leaderThreadOutcomeValidatedHistoryLength: session.leaderThreadOutcomeValidatedHistoryLength,
    pendingLeaderRejectedReadyThreadKeys: session.pendingLeaderRejectedReadyThreadKeys,
    attentionRecords: session.attentionRecords,
    notificationStatusVersion: session.notificationStatusVersion,
    notificationStatusUpdatedAt: session.notificationStatusUpdatedAt,
  };
}

export function backendConnected(session: SessionLike): boolean {
  switch (session.backendType) {
    case "claude":
      return !!session.backendSocket;
    case "codex":
      return !!session.codexAdapter?.isConnected();
    case "claude-sdk":
      return !!session.claudeSdkAdapter?.isConnected();
    default:
      return false;
  }
}

export function backendAttached(session: SessionLike): boolean {
  return !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter);
}

export function deriveBackendState(session: SessionLike): NonNullable<SessionState["backend_state"]> {
  if (session.state.backend_state === "broken") return "broken";
  if (session.state.backend_state === "recovery_suppressed") return "recovery_suppressed";
  if (backendConnected(session)) return "connected";
  if (
    session.state.backend_state === "initializing" ||
    session.state.backend_state === "resuming" ||
    session.state.backend_state === "recovering"
  ) {
    return session.state.backend_state;
  }
  return "disconnected";
}

export function setBackendState(
  session: SessionLike,
  backendState: NonNullable<SessionState["backend_state"]>,
  backendError: string | null,
  deps: Pick<SessionRegistryDeps, "broadcastSessionUpdate">,
): void {
  const clearProviderRetry =
    (backendState === "broken" || backendState === "recovery_suppressed") && !!session.state.codex_provider_retry;
  const clearStreamRetry = backendState !== "connected" && !!session.state.codex_stream_retry;
  const changed =
    session.state.backend_state !== backendState ||
    session.state.backend_error !== backendError ||
    clearProviderRetry ||
    clearStreamRetry;
  session.state.backend_state = backendState;
  session.state.backend_error = backendError;
  if (clearProviderRetry) session.state.codex_provider_retry = null;
  if (clearStreamRetry) session.state.codex_stream_retry = null;
  if (!changed) return;
  deps.broadcastSessionUpdate?.(session, {
    backend_state: backendState,
    backend_error: backendError,
    ...(clearProviderRetry ? { codex_provider_retry: null } : {}),
    ...(clearStreamRetry ? { codex_stream_retry: null } : {}),
  });
}

export function setBackendReconnectProgress(
  session: SessionLike,
  progress: SessionState["backend_reconnect"],
  deps: Pick<SessionRegistryDeps, "broadcastSessionUpdate">,
): void {
  const current = session.state.backend_reconnect ?? null;
  const next = progress ?? null;
  const changed =
    current?.attempt !== next?.attempt ||
    current?.maxAttempts !== next?.maxAttempts ||
    current?.cycleStartedAt !== next?.cycleStartedAt ||
    current?.outageOwnerId !== next?.outageOwnerId ||
    current?.outageFamily !== next?.outageFamily;
  session.state.backend_reconnect = next;
  if (!changed) return;
  deps.broadcastSessionUpdate?.(session, { backend_reconnect: next });
}

function markCodexReconnectAttempt(
  session: SessionLike,
  attempt: number,
  maxAttempts: number,
  reason: string,
  deps: Pick<SessionRegistryDeps, "broadcastSessionUpdate">,
): void {
  const normalizedAttempt = Math.max(1, Math.min(Math.floor(attempt), maxAttempts));
  const existing = session.state.backend_reconnect;
  setBackendReconnectProgress(
    session,
    withCodexOutageRecoveryDescriptor(
      {
        attempt: normalizedAttempt,
        maxAttempts,
        cycleStartedAt:
          normalizedAttempt > 1 && typeof existing?.cycleStartedAt === "number" ? existing.cycleStartedAt : Date.now(),
      },
      session,
      reason,
    ),
    deps,
  );
}

export function beginCodexManualReconnectCycle(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "persistSession" | "broadcastSessionUpdate" | "maxAdapterRelaunchFailures">,
): boolean {
  if (session.backendType !== "codex") return false;
  clearCodexRecoveryRuntimeState(session);
  (session as any).consecutiveAdapterFailures = 0;
  (session as any).lastAdapterFailureAt = null;
  setCodexRecoveryRuntimeReason(session, "manual_reconnect");
  setBackendReconnectProgress(session, null, deps);
  const maxAttempts = deps.maxAdapterRelaunchFailures ?? CODEX_PROCESS_RECONNECT_MAX_ATTEMPTS;
  markCodexReconnectAttempt(session, 1, maxAttempts, "manual_reconnect", deps);
  setBackendState(session, "recovering", null, deps);
  deps.persistSession(session);
  return true;
}

export function requestCodexAutoRecovery(
  session: SessionLike,
  reason: string,
  deps: Pick<
    SessionRegistryDeps,
    | "requestCliRelaunch"
    | "persistSession"
    | "emitTakodeEvent"
    | "attached"
    | "getLauncherSessionInfo"
    | "broadcastSessionUpdate"
    | "broadcastToBrowsers"
    | "recoveryTimeoutMs"
    | "maxAdapterRelaunchFailures"
    | "finalizeCodexRecoveringTurn"
  >,
): boolean {
  const launcherInfo = deps.getLauncherSessionInfo?.(session.id);
  if (!deps.requestCliRelaunch) return false;
  if (launcherInfo?.archived || launcherInfo?.killedByIdleManager || session.state.pause?.pausedAt) return false;
  if (session.state.backend_state === "broken" || session.state.backend_state === "recovery_suppressed") return false;
  const maxFailures = deps.maxAdapterRelaunchFailures ?? CODEX_PROCESS_RECONNECT_MAX_ATTEMPTS;
  if ((session as any).consecutiveAdapterFailures >= maxFailures) {
    if (canContinueCodexOutageRecovery(session, reason, launcherInfo)) {
      (session as any).consecutiveAdapterFailures = 0;
      (session as any).lastAdapterFailureAt = null;
    } else if (reason !== "adapter_disconnect") {
      suppressCodexAutomaticRecovery(
        session,
        `automatic recovery suppressed after ${maxFailures} failed attempts`,
        deps,
      );
      return false;
    }
  }
  setCodexRecoveryRuntimeReason(session, reason);
  const recordedFailures = (session as any).consecutiveAdapterFailures ?? 0;
  const nextAttempt = Math.min(
    reason === "adapter_disconnect" ? Math.max(1, recordedFailures) : recordedFailures + 1,
    maxFailures,
  );
  markCodexReconnectAttempt(session, nextAttempt, maxFailures, reason, deps);
  setBackendState(session, "recovering", null, deps);
  deps.persistSession(session);
  console.log(`[ws-bridge] Requesting Codex auto-recovery for session ${sessionTag(session.id)} (${reason})`);
  const attemptToken = beginCodexRecoveryAttempt(session);
  deps.requestCliRelaunch(session.id);
  const recoveryTimeoutMs = isCodexPersistentOutageRecoveryReason(reason)
    ? (deps.recoveryTimeoutMs ?? 30_000)
    : reason.includes("provider_result:")
      ? Math.max(deps.recoveryTimeoutMs ?? 30_000, CODEX_PROVIDER_RESULT_RECONNECT_TIMEOUT_MS)
      : (deps.recoveryTimeoutMs ?? 30_000);
  setTimeout(() => {
    if (!isCurrentCodexRecoveryAttempt(session, attemptToken)) return;
    if (session.state.backend_state !== "recovering") return;
    if (deps.attached?.(session)) return;
    if (stopIneligibleCodexOutageRecovery(session, reason, deps)) return;
    console.warn(
      `[ws-bridge] Codex auto-recovery timeout for session ${sessionTag(session.id)} (${reason}) -- retrying or settling`,
    );
    const failures = noteCodexAutomaticRecoveryFailure(session, deps);
    if (canContinueCodexOutageRecovery(session, reason, deps.getLauncherSessionInfo?.(session.id))) {
      if (failures >= maxFailures) {
        (session as any).consecutiveAdapterFailures = 0;
        (session as any).lastAdapterFailureAt = null;
      }
      requestCodexAutoRecovery(session, reason, deps);
      return;
    }
    if (failures >= maxFailures) {
      suppressCodexAutomaticRecovery(
        session,
        `Automatic recovery timed out after ${failures} attempts. Use Reconnect to start a fresh cycle.`,
        deps,
      );
    } else {
      setBackendState(session, "disconnected", null, deps);
    }
    clearCodexRecoveryRuntimeState(session);
    setBackendReconnectProgress(session, null, deps);
    deps.emitTakodeEvent?.(session.id, "session_disconnected", {
      wasGenerating: session.isGenerating,
      reason: "recovery_timeout",
    });
    deps.finalizeCodexRecoveringTurn?.(session, "recovery_timeout");
    deps.persistSession(session);
  }, recoveryTimeoutMs);
  return true;
}

export function markCodexAutoRecoveryFailed(
  session: SessionLike,
  deps: Pick<
    SessionRegistryDeps,
    | "attached"
    | "emitTakodeEvent"
    | "persistSession"
    | "broadcastSessionUpdate"
    | "broadcastToBrowsers"
    | "finalizeCodexRecoveringTurn"
    | "maxAdapterRelaunchFailures"
    | "requestCliRelaunch"
    | "getLauncherSessionInfo"
    | "recoveryTimeoutMs"
  >,
): void {
  if (session.backendType !== "codex") return;
  if (session.state.backend_state !== "recovering") return;
  if (deps.attached?.(session)) return;
  invalidateCodexRecoveryAttempt(session);
  const reason = resolveCodexAutoRecoveryReason(session, getCodexRecoveryRuntimeReason(session));
  if (reason && stopIneligibleCodexOutageRecovery(session, reason, deps)) return;
  const failures = noteCodexAutomaticRecoveryFailure(session, deps);
  const maxFailures = deps.maxAdapterRelaunchFailures ?? CODEX_PROCESS_RECONNECT_MAX_ATTEMPTS;
  if (failures >= maxFailures) {
    suppressCodexAutomaticRecovery(
      session,
      `Automatic recovery failed after ${failures} attempts. Use Reconnect to start a fresh cycle.`,
      deps,
    );
  } else {
    setBackendState(session, "disconnected", null, deps);
  }
  clearCodexRecoveryRuntimeState(session);
  deps.emitTakodeEvent?.(session.id, "session_disconnected", {
    wasGenerating: session.isGenerating,
    reason: "recovery_failed",
  });
  deps.finalizeCodexRecoveringTurn?.(session, "recovery_failed");
  deps.persistSession(session);
}

export function clearCodexAutomaticRecoverySuppression(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "persistSession" | "broadcastSessionUpdate">,
): void {
  if (session.backendType !== "codex") return;
  (session as any).consecutiveAdapterFailures = 0;
  (session as any).lastAdapterFailureAt = null;
  clearCodexRecoveryRuntimeState(session);
  setBackendReconnectProgress(session, null, deps);
  if (session.state.backend_state === "recovery_suppressed") {
    setBackendState(session, "disconnected", null, deps);
  }
  deps.persistSession(session);
}

function noteCodexAutomaticRecoveryFailure(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "maxAdapterRelaunchFailures">,
): number {
  const current =
    typeof (session as any).consecutiveAdapterFailures === "number" ? (session as any).consecutiveAdapterFailures : 0;
  const failures = Math.min(current + 1, (deps.maxAdapterRelaunchFailures ?? CODEX_PROCESS_RECONNECT_MAX_ATTEMPTS) + 1);
  (session as any).consecutiveAdapterFailures = failures;
  (session as any).lastAdapterFailureAt = Date.now();
  return failures;
}

function suppressCodexAutomaticRecovery(
  session: SessionLike,
  message: string,
  deps: Pick<
    SessionRegistryDeps,
    "broadcastSessionUpdate" | "broadcastToBrowsers" | "emitTakodeEvent" | "persistSession"
  >,
): void {
  const diagnostic = `Codex automatic recovery is paused: ${message}`;
  setBackendState(session, "recovery_suppressed", diagnostic, deps);
  deps.broadcastToBrowsers?.(session, { type: "backend_disconnected", reason: "recovery_suppressed" });
  deps.broadcastToBrowsers?.(session, { type: "error", message: diagnostic });
  deps.emitTakodeEvent?.(session.id, "session_disconnected", {
    wasGenerating: session.isGenerating,
    reason: "recovery_suppressed",
  });
  console.error(`[ws-bridge] ${diagnostic} for session ${sessionTag(session.id)}`);
  deps.persistSession(session);
}

export function hasAssistantReplay(session: SessionLike, messageId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "assistant"; message: { id?: string } } =>
      message.type === "assistant" && (message as { message?: { id?: string } }).message?.id === messageId,
  );
}

export function hasUserPromptReplay(session: SessionLike, cliUuid: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "user_message"; cliUuid?: string } =>
      message.type === "user_message" && (message as { cliUuid?: string }).cliUuid === cliUuid,
  );
}

export function hasResultReplay(session: SessionLike, resultUuid: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "result"; data?: { uuid?: string } } =>
      message.type === "result" && (message as { data?: { uuid?: string } }).data?.uuid === resultUuid,
  );
}

export function hasToolResultPreviewReplay(session: SessionLike, toolUseId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (message): message is BrowserIncomingMessage & { type: "tool_result_preview"; previews?: ToolResultPreview[] } =>
      message.type === "tool_result_preview" &&
      Array.isArray((message as { previews?: ToolResultPreview[] }).previews) &&
      ((message as { previews?: ToolResultPreview[] }).previews || []).some(
        (preview) => preview.tool_use_id === toolUseId,
      ),
  );
}

export function hasTaskNotificationReplay(session: SessionLike, taskId: string, toolUseId: string): boolean {
  return !!findHistoryReplayEntry(
    session,
    (
      message,
    ): message is BrowserIncomingMessage & { type: "task_notification"; task_id: string; tool_use_id: string } =>
      message.type === "task_notification" &&
      (message as { task_id?: string }).task_id === taskId &&
      (message as { tool_use_id?: string }).tool_use_id === toolUseId,
  );
}

export function hasCompactBoundaryReplay(
  session: SessionLike,
  cliUuid: string | undefined,
  meta: CLISystemCompactBoundaryMessage["compact_metadata"],
): boolean {
  if (cliUuid) {
    const matchedUuid = findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "compact_marker"; cliUuid?: string } =>
        message.type === "compact_marker" && (message as { cliUuid?: string }).cliUuid === cliUuid,
    );
    if (matchedUuid) return true;
  }

  const last = session.messageHistory[session.messageHistory.length - 1] as
    | { type?: string; trigger?: string; preTokens?: number; summary?: string }
    | undefined;
  return (
    last?.type === "compact_marker" &&
    !last.summary &&
    (last.trigger ?? null) === (meta?.trigger ?? null) &&
    (last.preTokens ?? null) === (meta?.pre_tokens ?? null)
  );
}

function findHistoryReplayEntry<T extends BrowserIncomingMessage>(
  session: SessionLike,
  predicate: (message: BrowserIncomingMessage) => message is T,
): T | undefined {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const entry = session.messageHistory[i];
    if (predicate(entry)) return entry;
  }
  return undefined;
}

type TurnTriggerSource = "user" | "leader" | "system" | "unknown";

type IdleState = {
  timer: ReturnType<typeof setTimeout> | null;
  idleSince: number | null;
  notifiedWhileIdle: boolean;
  leaderUnreadSetByGroupIdle: boolean;
};

export interface LeaderIdleStateLike {
  leaderGroupIdleStates: Map<string, IdleState>;
  sessions: Map<string, SessionLike & { isGenerating: boolean }>;
}

type LeaderIdleDeps = {
  getLauncherSessionInfo: NonNullable<SessionRegistryDeps["getLauncherSessionInfo"]>;
  getHerdedSessionIds: NonNullable<SessionRegistryDeps["getHerdedSessionIds"]>;
  getSessionNum: NonNullable<SessionRegistryDeps["getSessionNum"]>;
  getSessionName: NonNullable<SessionRegistryDeps["getSessionName"]>;
  deriveSessionStatus: NonNullable<SessionRegistryDeps["deriveSessionStatus"]>;
  clearAttentionAndMarkRead: NonNullable<SessionRegistryDeps["clearAttentionAndMarkRead"]>;
  setAttentionReview: NonNullable<SessionRegistryDeps["setAttentionReview"]>;
  scheduleCompletedNotification: NonNullable<SessionRegistryDeps["scheduleCompletedNotification"]>;
  broadcastLeaderGroupIdle: NonNullable<SessionRegistryDeps["broadcastLeaderGroupIdle"]>;
  recordServerEvent: NonNullable<SessionRegistryDeps["recordServerEvent"]>;
  delayMs: NonNullable<SessionRegistryDeps["delayMs"]>;
};

export function markSessionUnread(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession">,
): boolean {
  if (deps.isHerdedWorkerSession?.(session)) return true;
  session.manualUnread = true;
  session.attentionReason = "review";
  deps.persistSession(session);
  return true;
}

export function markSessionUnreadBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: Pick<SessionRegistryDeps, "isHerdedWorkerSession" | "broadcastToBrowsers" | "persistSession">,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return markSessionUnread(session, deps);
}

export function getAllSessionStates(sessions: Map<string, SessionLike>): SessionState[] {
  return Array.from(sessions.values()).map((session) => session.state);
}

export function isSessionBusy(sessions: Map<string, SessionLike>, sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.isGenerating || session.pendingPermissions.size > 0;
}

export async function killSession(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: { killLauncher: (sessionId: string) => Promise<boolean> },
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (session?.claudeSdkAdapter) {
    try {
      await session.claudeSdkAdapter.disconnect();
    } catch {}
  }
  return deps.killLauncher(sessionId);
}

export function getLastUserMessage(sessions: Map<string, SessionLike>, sessionId: string): string | undefined {
  return sessions.get(sessionId)?.lastUserMessage;
}

export function getMessageHistory(
  sessions: Map<string, SessionLike>,
  sessionId: string,
): BrowserIncomingMessage[] | null {
  const session = sessions.get(sessionId);
  return session ? session.messageHistory : null;
}

export function getSessionMessages(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  from: number,
  to: number,
): BrowserIncomingMessage[] | null {
  const history = getMessageHistory(sessions, sessionId);
  if (!history) return null;
  const clampedFrom = Math.max(0, from);
  const clampedTo = Math.min(history.length - 1, to);
  if (clampedFrom > clampedTo) return [];
  return history.slice(clampedFrom, clampedTo + 1);
}

export function getSessionActivityPreview(sessions: Map<string, SessionLike>, sessionId: string): string | undefined {
  return sessions.get(sessionId)?.lastActivityPreview;
}

export function getSessionKeywords(sessions: Map<string, SessionLike>, sessionId: string): string[] {
  return sessions.get(sessionId)?.keywords ?? [];
}

export function getSessionTaskHistory(sessions: Map<string, SessionLike>, sessionId: string): SessionTaskEntry[] {
  return sessions.get(sessionId)?.taskHistory ?? [];
}

export function getHerdDiagnostics(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  now = Date.now(),
  deps?: { getHerdDispatcherDiagnostics?: (sessionId: string) => Record<string, unknown> },
): Record<string, unknown> | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const generationElapsedMs =
    session.isGenerating && session.generationStartedAt ? now - session.generationStartedAt : null;
  let oldestToolAgeMs: number | null = null;
  for (const startedAt of session.toolStartTimes.values()) {
    const age = now - startedAt;
    if (oldestToolAgeMs === null || age > oldestToolAgeMs) oldestToolAgeMs = age;
  }
  return {
    isGenerating: session.isGenerating,
    generationStartedAt: session.generationStartedAt,
    generationElapsedMs,
    queuedTurnStarts: session.queuedTurnStarts,
    queuedTurnReasons: session.queuedTurnReasons,
    cliConnected: backendConnected(session),
    cliInitReceived: session.cliInitReceived,
    pendingMessagesCount: session.pendingMessages.length,
    pendingPermissionsCount: session.pendingPermissions.size,
    disconnectGraceActive: session.disconnectGraceTimer !== null,
    disconnectWasGenerating: session.disconnectWasGenerating,
    seamlessReconnect: session.seamlessReconnect,
    stuckNotifiedAt: session.stuckNotifiedAt,
    toolStartTimesCount: session.toolStartTimes.size,
    oldestToolAgeMs,
    ...(deps?.getHerdDispatcherDiagnostics ? { herdDispatcher: deps.getHerdDispatcherDiagnostics(sessionId) } : {}),
  };
}

export function setSessionClaimedQuest(
  session: SessionLike,
  quest: SessionClaimedQuestState | null,
  deps: Pick<
    SessionRegistryDeps,
    | "broadcastToBrowsers"
    | "persistSession"
    | "getLauncherSessionInfo"
    | "onSessionNamedByQuest"
    | "invalidateLeaderThreadTabsForQuestIds"
  >,
  lifecycleEventInput?: QuestLifecycleEventInput,
): void {
  console.log(
    `[ws-bridge] setSessionClaimedQuest: quest=${quest?.id ?? "null"} title="${quest?.title ?? ""}" status=${quest?.status ?? "null"} browsers=${session.browserSockets.size} session=${session.id}`,
  );
  const prevId = session.state.claimedQuestId ?? null;
  const prevTitle = session.state.claimedQuestTitle ?? null;
  const prevStatus = session.state.claimedQuestStatus ?? null;
  const prevReviewInboxUnread = session.state.claimedQuestVerificationInboxUnread;
  const prevLeaderSessionId = session.state.claimedQuestLeaderSessionId ?? null;
  const nextId = quest?.id ?? null;
  const nextTitle = quest?.title ?? null;
  const nextStatus = quest?.status ?? null;
  const nextReviewInboxUnread = quest?.verificationInboxUnread;
  const nextLeaderSessionId = quest?.leaderSessionId ?? null;
  const claimStateChanged = !(
    prevId === nextId &&
    prevTitle === nextTitle &&
    prevStatus === nextStatus &&
    prevReviewInboxUnread === nextReviewInboxUnread &&
    prevLeaderSessionId === nextLeaderSessionId
  );
  if (claimStateChanged) {
    session.state.claimedQuestId = quest?.id;
    session.state.claimedQuestTitle = quest?.title;
    session.state.claimedQuestStatus = quest?.status;
    session.state.claimedQuestVerificationInboxUnread = quest?.verificationInboxUnread;
    session.state.claimedQuestLeaderSessionId = quest?.leaderSessionId;
    const projectionClaimChanged =
      prevId !== nextId || prevStatus !== nextStatus || prevLeaderSessionId !== nextLeaderSessionId;
    if (projectionClaimChanged) {
      const affectedQuestIds = [...new Set([prevId, nextId].filter((id): id is string => !!id))];
      if (affectedQuestIds.length > 0) deps.invalidateLeaderThreadTabsForQuestIds?.(affectedQuestIds);
    }
    const isQuestActive =
      !!quest?.title &&
      (quest?.status === "in_progress" ||
        quest?.status === "needs_verification" ||
        (quest?.status === "done" && quest.verificationInboxUnread !== undefined));
    const isOrchestrator = deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;
    if (isQuestActive && !isOrchestrator && deps.onSessionNamedByQuest) {
      deps.onSessionNamedByQuest(session.id, quest.title);
    }
    deps.broadcastToBrowsers?.(session, {
      type: "session_quest_claimed",
      quest: quest
        ? {
            id: quest.id,
            title: quest.title,
            status: quest.status,
            verificationInboxUnread: quest.verificationInboxUnread,
            leaderSessionId: quest.leaderSessionId,
          }
        : null,
    } as BrowserIncomingMessage);
  }
  const duplicateLifecycleEvent = lifecycleEventInput
    ? session.messageHistory.some(
        (message: BrowserIncomingMessage) =>
          message.type === "quest_lifecycle_event" && message.id === lifecycleEventInput.id,
      )
    : false;
  if (quest && lifecycleEventInput && !duplicateLifecycleEvent) {
    const timestamp = lifecycleEventInput.timestamp ?? Date.now();
    const questSnapshot: QuestLifecycleEventSnapshot = {
      questId: quest.id,
      title: quest.title,
      status: quest.status ?? (lifecycleEventInput.kind === "submitted" ? "done" : "in_progress"),
      ...(quest.description !== undefined ? { description: quest.description } : {}),
      ...(quest.tldr !== undefined ? { tldr: quest.tldr } : {}),
      ...(quest.tags !== undefined ? { tags: quest.tags } : {}),
      ...(quest.images !== undefined ? { images: quest.images } : {}),
      ...(quest.verificationItems !== undefined ? { verificationItems: quest.verificationItems } : {}),
      ...(quest.leaderSessionId !== undefined ? { leaderSessionId: quest.leaderSessionId } : {}),
    };
    const lifecycleEvent: BrowserIncomingMessage = {
      type: "quest_lifecycle_event",
      id: lifecycleEventInput.id,
      timestamp,
      kind: lifecycleEventInput.kind,
      quest: questSnapshot,
      threadKey: quest.id,
      questId: quest.id,
      threadRefs: [{ threadKey: quest.id, questId: quest.id, source: "explicit" }],
    };
    session.messageHistory.push(lifecycleEvent);
    deps.broadcastToBrowsers?.(session, lifecycleEvent);
  }
  if (!claimStateChanged && (!lifecycleEventInput || duplicateLifecycleEvent || !quest)) return;
  deps.persistSession(session);
}

export function setSessionClaimedQuestBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  quest: SessionClaimedQuestState | null,
  deps: Pick<
    SessionRegistryDeps,
    "broadcastToBrowsers" | "persistSession" | "getLauncherSessionInfo" | "onSessionNamedByQuest"
  >,
  lifecycleEvent?: QuestLifecycleEventInput,
): void {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[ws-bridge] setSessionClaimedQuest: session ${sessionId} not found`);
    return;
  }
  setSessionClaimedQuest(session, quest, deps, lifecycleEvent);
}

export function getNotifications(sessions: Map<string, SessionLike>, sessionId: string): SessionNotification[] {
  return sessions.get(sessionId)?.notifications ?? [];
}

export function summarizePendingPermissions(session: SessionLike): string | null {
  if (session.pendingPermissions.size === 0) return null;
  const tools = new Set<string>();
  for (const perm of session.pendingPermissions.values()) {
    tools.add(perm.tool_name);
  }
  if (tools.has("ExitPlanMode")) return "pending plan";
  if (tools.has("AskUserQuestion")) return "pending question";
  if (tools.size === 1) return `pending ${[...tools][0]}`;
  return `${session.pendingPermissions.size} pending permissions`;
}

export function countPendingUserPermissions(session: SessionLike): number {
  let count = 0;
  for (const perm of session.pendingPermissions.values()) {
    if (!perm?.evaluating && !perm?.autoApproved) count++;
  }
  return count;
}

export function getSessionActivitySnapshot(session: SessionLike): {
  notificationUrgency: NotificationUrgency;
  activeNotificationCount: number;
  activeNeedsInputNotificationCount: number;
  activeReviewNotificationCount: number;
  mutedNeedsInputNotificationCount: number;
  notificationStatusVersion: number;
  notificationStatusUpdatedAt: number;
} {
  return getNotificationStatusSnapshot(session);
}

export function getCurrentTurnTriggerSource(
  session: SessionLike,
  deps: { isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) => boolean },
): TurnTriggerSource {
  for (const historyIndex of session.userMessageIdsThisTurn) {
    const entry = session.messageHistory[historyIndex] as
      | Extract<BrowserIncomingMessage, { type: "user_message" }>
      | undefined;
    if (!entry || entry.type !== "user_message") continue;
    if (!entry.agentSource) return "user";
    if (deps.isSystemSourceTag(entry.agentSource)) return "system";
    return "leader";
  }
  return "unknown";
}

export function shouldNotifyHumanOnResult(
  session: SessionLike,
  turnTriggerSource: TurnTriggerSource,
  deps: {
    isHerdedWorkerSession: (session: SessionLike) => boolean;
    isLeaderSession: (session: SessionLike) => boolean;
  },
): boolean {
  if (deps.isHerdedWorkerSession(session)) {
    return turnTriggerSource === "user";
  }
  if (deps.isLeaderSession(session)) return false;
  return true;
}

export function handleResultAttentionAndNotifications(
  session: SessionLike,
  resultMsg: CLIResultMessage,
  turnTriggerSource: TurnTriggerSource,
  deps: Pick<
    SessionRegistryDeps,
    | "isHerdedWorkerSession"
    | "getLauncherSessionInfo"
    | "broadcastToBrowsers"
    | "persistSession"
    | "emitTakodeEvent"
    | "scheduleResultCompletedNotification"
    | "scheduleErrorNotification"
  >,
): void {
  const isHerdedWorker = deps.isHerdedWorkerSession?.(session) ?? false;
  const shouldNotifyHuman = shouldNotifyHumanOnResult(session, turnTriggerSource, {
    isHerdedWorkerSession: () => isHerdedWorker,
    isLeaderSession: (targetSession) => deps.getLauncherSessionInfo?.(targetSession.id)?.isOrchestrator === true,
  });

  if (shouldNotifyHuman) {
    setAttention(session, resultMsg.is_error ? "error" : "review", deps, {
      allowHerdedWorker: isHerdedWorker && turnTriggerSource === "user",
    });
  }

  if (resultMsg.is_error) {
    const message = typeof resultMsg.result === "string" ? resultMsg.result.slice(0, 200) : "Unknown error";
    deps.emitTakodeEvent?.(session.id, "session_error", { error: message });
  }

  if (!shouldNotifyHuman) return;
  if (resultMsg.is_error) {
    deps.scheduleErrorNotification?.(
      session.id,
      typeof resultMsg.result === "string" ? resultMsg.result.slice(0, 100) : "Error",
    );
    return;
  }
  deps.scheduleResultCompletedNotification?.(session.id);
}

export function markSessionRead(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  clearAttentionAndMarkRead(session, deps);
  return true;
}

export function markAllSessionsRead(
  sessions: Map<string, SessionLike>,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  for (const session of sessions.values()) {
    clearAttentionAndMarkRead(session, deps);
  }
}

export function clearActionAttentionIfNoPermissions(
  session: SessionLike,
  deps: Pick<SessionRegistryDeps, "broadcastToBrowsers" | "persistSession">,
): void {
  if (session.pendingPermissions.size !== 0 || session.attentionReason !== "action") return;
  session.attentionReason = null;
  deps.persistSession?.(session);
}

export function onSessionActivityStateChanged(
  state: LeaderIdleStateLike,
  sessionId: string,
  reason: string,
  deps: LeaderIdleDeps,
): void {
  const info = deps.getLauncherSessionInfo(sessionId);
  if (!info) return;
  if (info.isOrchestrator) {
    updateLeaderGroupIdleState(state, sessionId, `${reason}:leader`, deps);
  }
  if (info.herdedBy) {
    updateLeaderGroupIdleState(state, info.herdedBy, `${reason}:worker`, deps);
  }
}

export function updateLeaderGroupIdleState(
  state: LeaderIdleStateLike,
  leaderId: string,
  reason: string,
  deps: LeaderIdleDeps,
): void {
  const leaderInfo = deps.getLauncherSessionInfo(leaderId);
  if (!leaderInfo?.isOrchestrator) {
    const stale = state.leaderGroupIdleStates.get(leaderId);
    if (stale) {
      clearLeaderGroupIdleTimer(stale);
      state.leaderGroupIdleStates.delete(leaderId);
    }
    return;
  }
  const members = [leaderId, ...deps.getHerdedSessionIds(leaderId)];
  const allIdle = members.every((memberId) => {
    const session = state.sessions.get(memberId);
    if (!session) return false;
    return deps.deriveSessionStatus(session) === "idle" && session.pendingPermissions.size === 0;
  });
  const idleState = getOrCreateLeaderGroupIdleState(state, leaderId);
  if (!allIdle) {
    clearLeaderGroupIdleTimer(idleState);
    idleState.idleSince = null;
    idleState.notifiedWhileIdle = false;
    if (idleState.leaderUnreadSetByGroupIdle) {
      const leaderSession = state.sessions.get(leaderId);
      if (leaderSession?.attentionReason === "review" && leaderSession.manualUnread !== true) {
        deps.clearAttentionAndMarkRead(leaderSession);
      }
      idleState.leaderUnreadSetByGroupIdle = false;
    }
    return;
  }
  if (idleState.notifiedWhileIdle || idleState.timer) return;
  idleState.idleSince = Date.now();
  const leaderNum = deps.getSessionNum(leaderId);
  const leaderTag = leaderNum !== undefined ? `#${leaderNum}` : leaderId.slice(0, 8);
  idleState.timer = setTimeout(() => {
    idleState.timer = null;
    if (idleState.notifiedWhileIdle) return;
    const leaderSession = state.sessions.get(leaderId);
    if (!leaderSession) return;
    const now = Date.now();
    const idleForMs = idleState.idleSince ? Math.max(0, now - idleState.idleSince) : deps.delayMs;
    const name = deps.getSessionName(leaderId);
    const leaderLabel =
      leaderNum !== undefined && name
        ? `#${leaderNum} ${name}`
        : leaderNum !== undefined
          ? `#${leaderNum}`
          : name || leaderId.slice(0, 8);
    const detail = `${leaderLabel} is idle and waiting for attention`;
    const priorAttention = leaderSession.attentionReason;
    deps.setAttentionReview(leaderSession);
    deps.scheduleCompletedNotification(leaderId, detail);
    deps.broadcastLeaderGroupIdle(leaderSession, {
      type: "leader_group_idle",
      leader_session_id: leaderId,
      leader_label: leaderLabel,
      member_count: members.length,
      idle_for_ms: idleForMs,
      timestamp: now,
    });
    idleState.leaderUnreadSetByGroupIdle = priorAttention === null && leaderSession.attentionReason === "review";
    idleState.notifiedWhileIdle = true;
  }, deps.delayMs);
  deps.recordServerEvent(
    leaderId,
    "leader_group_idle_timer_started",
    { reason, members: members.length },
    leaderInfo.backendType ?? "claude",
    leaderInfo.cwd,
  );
  console.log(`[ws-bridge] Group idle timer started for ${leaderTag} (reason: ${reason}, members: ${members.length})`);
}

export function trackCodexQuestCommands(session: SessionLike, content: ContentBlock[]): void {
  for (const block of content) {
    if (block.type !== "tool_use" || block.name !== "Bash") continue;
    const command = typeof block.input.command === "string" ? block.input.command : "";
    if (!command) continue;
    const parsed = detectQuestEvent({ kind: "command", text: command });
    if (!parsed?.questId) continue;
    session.pendingQuestCommands.set(block.id, {
      questId: parsed.questId,
      targetStatus: parsed.targetStatus,
      verificationInboxUnread: parsed.verificationInboxUnread,
    });
  }
}

export async function reconcileCodexQuestToolResult(
  session: SessionLike,
  toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  deps: Pick<
    SessionRegistryDeps,
    | "resolveQuestTitle"
    | "broadcastTaskHistory"
    | "persistSession"
    | "broadcastToBrowsers"
    | "getLauncherSessionInfo"
    | "onSessionNamedByQuest"
  >,
): Promise<void> {
  const pending = session.pendingQuestCommands.get(toolResult.tool_use_id);
  if (!pending) return;
  session.pendingQuestCommands.delete(toolResult.tool_use_id);
  if (toolResult.is_error) return;
  const raw = typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content);
  const parsedResult = detectQuestEvent({ kind: "result", text: raw });
  if (!parsedResult) return;
  const questId = parsedResult?.questId || pending.questId;
  const status = parsedResult?.status || pending.targetStatus;
  if (!questId || !status) return;
  const title = await resolveQuestLifecycleTitle(session, questId, parsedResult?.title, deps);
  if (status === "done") {
    const verificationInboxUnread = parsedResult.verificationInboxUnread ?? pending.verificationInboxUnread;
    if (verificationInboxUnread !== undefined) {
      setSessionClaimedQuest(session, { id: questId, title, status, verificationInboxUnread }, deps);
      return;
    }
    if (session.state.claimedQuestId === questId) {
      setSessionClaimedQuest(session, null, deps);
    }
    return;
  }
  setSessionClaimedQuest(session, { id: questId, title, status }, deps);
  if (status !== "in_progress") return;
  const alreadyTracked = session.taskHistory.some(
    (entry: SessionTaskEntry) => entry.source === "quest" && entry.questId === questId,
  );
  if (alreadyTracked) return;
  let triggerMsgId = `quest-${questId}`;
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const msg = session.messageHistory[i];
    if (msg.type === "user_message" && msg.id) {
      triggerMsgId = msg.id;
      break;
    }
  }
  addTaskEntry(
    session,
    {
      title,
      action: "new",
      timestamp: Date.now(),
      triggerMessageId: triggerMsgId,
      source: "quest",
      questId,
    },
    deps,
  );
}

export function addTaskEntry(
  session: SessionLike,
  entry: SessionTaskEntry,
  deps: Pick<SessionRegistryDeps, "broadcastTaskHistory" | "persistSession">,
): void {
  if (entry.action === "revise") {
    const last = session.taskHistory[session.taskHistory.length - 1];
    if (last) last.title = entry.title;
  } else {
    const last = session.taskHistory[session.taskHistory.length - 1];
    if (isConsecutiveDuplicateTaskEntry(last, entry)) return;
    session.taskHistory.push(entry);
  }
  deps.broadcastTaskHistory?.(session);
  deps.persistSession(session);
}

function isConsecutiveDuplicateTaskEntry(previous: SessionTaskEntry | undefined, next: SessionTaskEntry): boolean {
  if (!previous) return false;
  return (
    previous.action === next.action &&
    previous.title === next.title &&
    previous.triggerMessageId === next.triggerMessageId &&
    previous.source === next.source &&
    previous.questId === next.questId
  );
}

export function updateQuestTaskEntries(
  session: SessionLike,
  questId: string,
  newTitle: string,
  deps: Pick<SessionRegistryDeps, "broadcastTaskHistory" | "persistSession">,
): void {
  let changed = false;
  for (const entry of session.taskHistory) {
    if (entry.source === "quest" && entry.questId === questId && entry.title !== newTitle) {
      entry.title = newTitle;
      changed = true;
    }
  }
  if (changed) {
    deps.broadcastTaskHistory?.(session);
    deps.persistSession(session);
  }
}

export function mergeKeywords(
  session: SessionLike,
  newKeywords: string[],
  deps: Pick<SessionRegistryDeps, "persistSession">,
): void {
  if (newKeywords.length === 0) return;
  const existing = new Set(session.keywords);
  for (const keyword of newKeywords) existing.add(keyword);
  session.keywords = [...existing].slice(0, 30);
  deps.persistSession(session);
}

async function resolveQuestLifecycleTitle(
  session: SessionLike,
  questId: string,
  parsedTitle: string | undefined,
  deps: Pick<SessionRegistryDeps, "resolveQuestTitle">,
): Promise<string> {
  const candidateTitle = parsedTitle?.trim();
  if (candidateTitle && !isBareQuestIdTitle(candidateTitle, questId)) return candidateTitle;
  const currentTitle =
    session.state.claimedQuestId === questId && typeof session.state.claimedQuestTitle === "string"
      ? session.state.claimedQuestTitle.trim()
      : "";
  if (currentTitle && !isBareQuestIdTitle(currentTitle, questId)) return currentTitle;
  if (deps.resolveQuestTitle) {
    try {
      const resolvedTitle = (await deps.resolveQuestTitle(questId))?.trim();
      if (resolvedTitle && !isBareQuestIdTitle(resolvedTitle, questId)) return resolvedTitle;
    } catch {}
  }
  return currentTitle || candidateTitle || questId;
}

function isBareQuestIdTitle(title: string | null | undefined, questId?: string): boolean {
  if (!title) return false;
  const normalized = title.trim().toLowerCase();
  if (!/^q-\d+$/.test(normalized)) return false;
  return questId ? normalized === questId.toLowerCase() : true;
}

function clearLeaderGroupIdleTimer(state: IdleState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function getOrCreateLeaderGroupIdleState(state: LeaderIdleStateLike, leaderId: string): IdleState {
  let current = state.leaderGroupIdleStates.get(leaderId);
  if (!current) {
    current = { timer: null, idleSince: null, notifiedWhileIdle: false, leaderUnreadSetByGroupIdle: false };
    state.leaderGroupIdleStates.set(leaderId, current);
  }
  return current;
}
