import { isInactiveCodexRecoverySource } from "./codex-interrupted-turn-recovery.js";
import { randomUUID } from "node:crypto";
import {
  acknowledgeBrowserConnection,
  beginBrowserConnectionSubscribe,
  closeBrowserConnectionDiagnostics,
  finishBrowserConnectionSubscribe,
  openBrowserConnectionDiagnostics,
  sendObservedBrowserPayload,
} from "./browser-connection-diagnostics.js";
import { resolve } from "node:path";
import {
  computeHistoryMessagesSyncHash,
  computeHistoryPayloadSyncHash,
  computeHistoryPrefixSyncHash,
} from "../../shared/history-sync-hash.js";
import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { getLeaderMessageVisualInputs } from "../leader-thread-tabs-projection.js";
import { buildLeaderThreadResponseState } from "../leader-thread-response.js";
import { buildBackendStateSnapshot } from "./backend-state-snapshot.js";
import { attachRecentHistoryIndex } from "./browser-history-index.js";
import {
  buildThreadWindowSync,
  getThreadWindowItemCount,
  MAIN_THREAD_KEY,
  normalizeSelectedFeedThreadKey,
} from "../../shared/thread-window.js";
import { deriveWindowAvailability } from "../../shared/window-availability.js";
import { selectHistoryWindowRange } from "../history-window-selection.js";
import { sessionTag } from "../session-tag.js";
import { findTurnBoundaries } from "../takode-messages.js";
import { getTrafficMessageType, trafficStats } from "../traffic-stats.js";
import { isHistoryBackedEvent, shouldBufferForReplayWithContext } from "./replay-buffer-policy.js";
import { appendResolvedToolResultPreviewsForWindow } from "./history-window-tool-results.js";
import { projectBrowserMessage } from "./browser-message-projection.js";
import {
  completeSyncedProjectionSessionSubscribe,
  handleLeaderThreadTabsUpdate,
  handleSyncedProjectionProtocolMessage,
  isObsoleteLeaderThreadTabOperation,
  prepareSyncedProjectionSessionSubscribe,
  type SyncedProjectionSocketData,
  type SyncedProjectionSubscriptions,
} from "./browser-synced-projection-coordinator.js";
export { isHistoryBackedEvent } from "./replay-buffer-policy.js";
import { codexReasoningSnapshotFields } from "./codex-reasoning-preview-state.js";
import {
  prepareBoundedConversationSubscribe,
  boundedConversationSyncComplete,
  normalizeInitialThreadWindowRequest,
  recordBoundedConversationRequest,
  recordBoundedConversationViewUpdate,
  shouldDeliverBrowserEventToSocket,
  type BoundedConversationView,
  type BrowserConversationWindowSocketData,
} from "./browser-conversation-window-policy.js";
import { stripRecoveryDeliveryTransferMarker } from "./recovery-delivery-transfer-routing-context.js";
import {
  classifyRecoveryDeliveryOwnership,
  unownedRecoveryLinks,
  type BrowserIngressOwnershipResult,
} from "./browser-ingress-ownership.js";
import {
  getNotificationStatusSnapshot,
  getUserVisibleSessionNotifications,
} from "./session-notification-controller.js";
import { compactPendingCodexInputsForBrowser } from "../codex-pending-input-safety.js";
import { isCodexAutoPauseRecoverySummaryFinal } from "../codex-auto-pause-types.js";
import { routeFromHistoryEntry } from "../thread-routing-metadata.js";
import { isRootAgentHistoryMessage } from "../root-agent-feed-message.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import {
  buildPausedDiagnostic,
  canQueuePausedUserMessage,
  isComposerUserMessage,
  isSessionPaused,
  queuePausedUserMessage,
} from "../session-pause.js";
import {
  buildCodexAutoPauseDiagnostic,
  getCodexAutoPauseRecoveryProgress,
  getActiveCodexResultErrorAutoPause,
  isAutomaticCodexAutoPauseInput,
  queueCodexAutoPausedInput,
} from "../codex-result-error-auto-pause.js";
import { projectBrowserSessionState } from "../session-types.js";
import type {
  ActiveCodexReasoningPreview,
  ActiveTurnRoute,
  BoardRow,
  BoardRowSessionStatus,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BufferedBrowserEvent,
  CodexAutoPauseInputSourceKind,
  CodexOutboundTurn,
  PendingCodexInput,
  ProgrammaticHistoryFollowUp,
  PermissionRequest,
  ReplayableBrowserIncomingMessage,
  SessionAttentionRecord,
  SessionNotification,
  SessionTaskEntry,
  SessionState,
  LeaderProjectionSnapshot,
  InitialThreadWindowRequest,
  TakodeHerdBatchSnapshot,
  VsCodeOpenFileCommand,
  VsCodeSelectionState,
  VsCodeWindowState,
} from "../session-types.js";

type AgentSource = { sessionId: string; sessionLabel?: string };
type ProgrammaticUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

type BrowserTransportSocketData = BrowserConversationWindowSocketData &
  SyncedProjectionSocketData & {
    sessionId?: string;
    subscribed?: boolean;
    lastAckSeq?: number;
    initialTreeGroupState?: Promise<BrowserTransportTreeGroupState | null>;
  };

export interface ProgrammaticUserMessageOptions {
  deliveryContent?: ProgrammaticUserMessage["deliveryContent"];
  historyFollowUps?: ProgrammaticHistoryFollowUp[];
  timerFiring?: ProgrammaticUserMessage["timerFiring"];
  replyContext?: ProgrammaticUserMessage["replyContext"];
  sessionId?: string;
  vscodeSelection?: ProgrammaticUserMessage["vscodeSelection"];
  /** Safe human controls, such as answering a pending prompt, may bypass pause. */
  bypassPause?: boolean;
  /** Server-only source classification for Codex result-error auto-pause. */
  autoPauseSourceKind?: CodexAutoPauseInputSourceKind;
  /** Persisted server-only freshness proof for a deferred Thread Outcome Reminder. */
  leaderThreadOutcomeReminderGuard?: ProgrammaticUserMessage["leaderThreadOutcomeReminderGuard"];
  /** Runs only after the routed message is accepted without throwing. */
  afterAccepted?: () => void;
  /** Runs when routing is dropped, rejected, or throws before acceptance. */
  afterRejected?: (reason: "dropped" | "route_rejected" | "route_failed") => void;
}

export interface BrowserTransportSocketLike {
  data?: unknown;
  send(data: string): unknown;
  getBufferedAmount?(): number;
}

export interface BrowserTransportSessionLike {
  id: string;
  searchDataOnly?: boolean;
  backendType: "claude" | "codex" | "claude-sdk";
  browserSockets: Set<unknown>;
  messageHistory: BrowserIncomingMessage[];
  frozenCount: number;
  state: SessionState;
  nextEventSeq: number;
  lastAckSeq: number;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  recoveryDeliveryTransfers?: import("./recovery-delivery-transfer.js").RecoveryDeliveryTransfer[];
  claudeSdkAdapter?: unknown | null;
  taskHistory: SessionTaskEntry[];
  eventBuffer: BufferedBrowserEvent[];
  lastReadAt: number;
  attentionReason: "action" | "error" | "review" | null;
  generationStartedAt: number | null;
  isGenerating?: boolean;
  userMessageIdsThisTurn?: number[];
  activeTurnRoute?: ActiveTurnRoute | null;
  activeCodexReasoningPreview?: ActiveCodexReasoningPreview | null;
  codexReasoningPreviews?: import("./codex-reasoning-preview-state.js").CodexReasoningPreviewsByThread;
  pendingStartupMemoryCatalogInjection?: boolean;
  notifications: unknown[];
  attentionRecords: unknown[];
  notificationStatusVersion?: number;
  notificationStatusUpdatedAt?: number;
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
}

export interface BrowserConversationRefreshSessionLike {
  id: string;
  browserSockets: Set<unknown>;
  messageHistory: BrowserIncomingMessage[];
  nextEventSeq: number;
}

export interface BrowserTransportStateLike {
  vscodeSelectionState: VsCodeSelectionState | null;
  vscodeWindows: Map<string, VsCodeWindowState>;
  vscodeOpenFileQueues: Map<string, VsCodeOpenFileCommand[]>;
  pendingVsCodeOpenResults: Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
}

export interface BrowserTransportLauncherInfo {
  isOrchestrator?: boolean;
  state?: string;
  backendType?: "claude" | "codex" | "claude-sdk";
  killedByIdleManager?: boolean;
  archived?: boolean;
}

export interface BrowserTransportTreeGroupState {
  groups: unknown[];
  assignments: Record<string, unknown>;
  nodeOrder: Record<string, string[]>;
}

export interface BrowserTransportDeps {
  refreshGitInfoThenRecomputeDiff: (session: BrowserTransportSessionLike, options: { notifyPoller: boolean }) => void;
  prefillSlashCommands: (session: BrowserTransportSessionLike) => void;
  getTreeGroupState: () => Promise<BrowserTransportTreeGroupState>;
  getVsCodeSelectionState: () => unknown;
  getLauncherSessionInfo: (sessionId: string) => BrowserTransportLauncherInfo | null | undefined;
  backendAttached: (session: BrowserTransportSessionLike) => boolean;
  backendConnected: (session: BrowserTransportSessionLike) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  getRouteChain: (sessionId: string) => Promise<void> | undefined;
  setRouteChain: (sessionId: string, task: Promise<void>) => void;
  clearRouteChain: (sessionId: string, task: Promise<void>) => void;
  routeBrowserMessage: (
    session: BrowserTransportSessionLike,
    msg: BrowserOutgoingMessage,
    ws?: BrowserTransportSocketLike,
  ) => Promise<boolean | void> | boolean | void;
  pruneTakodeHerdBatch?: (
    session: BrowserTransportSessionLike,
    batch: TakodeHerdBatchSnapshot | undefined,
  ) => { batch?: TakodeHerdBatchSnapshot; content?: string; changed: boolean };
  abortAutoApproval: (session: BrowserTransportSessionLike, requestId: string) => void;
  broadcastToBrowsers: (session: BrowserTransportSessionLike, msg: BrowserIncomingMessage) => void;
  setAttentionAction: (session: BrowserTransportSessionLike) => void;
  touchActivity?: (sessionId: string) => void;
  notifyImageSendFailure: (session: BrowserTransportSessionLike, err?: unknown) => void;
  broadcastError: (session: BrowserTransportSessionLike, message: string) => void;
  queueCodexPendingStartBatch: (session: BrowserTransportSessionLike, reason: string) => void;
  deriveBackendState: (session: BrowserTransportSessionLike) => NonNullable<SessionState["backend_state"]>;
  getBoard: (sessionId: string) => unknown[];
  getCompletedBoard: (sessionId: string) => unknown[];
  getBoardRowSessionStatuses: (
    sessionId: string,
    board: unknown[],
    completedBoard: unknown[],
  ) => Record<string, BoardRowSessionStatus>;
  recoverToolStartTimesFromHistory: (session: BrowserTransportSessionLike) => void;
  finalizeRecoveredDisconnectedTerminalTools: (session: BrowserTransportSessionLike, reason: string) => void;
  scheduleCodexToolResultWatchdogs: (session: BrowserTransportSessionLike, reason: string) => void;
  recomputeAndBroadcastHistoryBytes: (session: BrowserTransportSessionLike) => void;
  listTimers: (sessionId: string) => unknown[];
  persistSession: (session: BrowserTransportSessionLike) => void;
  recordIncomingRaw?: (sessionId: string, json: string, backendType: string, cwd: string) => void;
  recordOutgoingRaw: (sessionId: string, json: string, backendType: string, cwd: string) => void;
  eventBufferLimit: number;
  browserTransportState: BrowserTransportStateLike;
  idempotentMessageTypes: ReadonlySet<string>;
  processedClientMsgIdLimit: number;
  getSessions: () => Iterable<{ browserSockets: Set<unknown> }>;
  windowStaleMs: number;
  openFileTimeoutMs: number;
  lazyLoadFullHistory?: (session: BrowserTransportSessionLike) => Promise<void>;
  replaceSyncedProjectionSubscriptions?: (
    socket: BrowserTransportSocketLike,
    subscriptions: SyncedProjectionSubscriptions,
  ) => BrowserIncomingMessage[];
  resyncSyncedProjection?: (
    socket: BrowserTransportSocketLike,
    projection: string,
    key: string,
  ) => BrowserIncomingMessage | null;
  removeSyncedProjectionSubscriber?: (socket: BrowserTransportSocketLike) => void;
}

const BROWSER_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "set_codex_ui_mode",
  "set_codex_reasoning_effort",
  "set_codex_service_tier",
  "leader_thread_tabs_update",
]);

const LOCAL_IDEMPOTENT_BROWSER_MESSAGE_TYPES: ReadonlySet<string> = new Set(["leader_thread_tabs_update"]);

const queuedCodexHerdRouteKeys = new WeakMap<BrowserTransportSessionLike, Set<string>>();

function isArchivedReadOnlySession(session: BrowserTransportSessionLike, deps: BrowserTransportDeps): boolean {
  return deps.getLauncherSessionInfo(session.id)?.archived === true;
}

function isArchivedReadOnlyBrowserMessage(msg: BrowserOutgoingMessage): boolean {
  return (
    msg.type === "session_subscribe" ||
    msg.type === "browser_connection_probe_ack" ||
    msg.type === "history_window_request" ||
    msg.type === "thread_window_request" ||
    msg.type === "conversation_view_update" ||
    msg.type === "session_ack" ||
    msg.type === "history_sync_mismatch" ||
    msg.type === "synced_projection_subscribe" ||
    msg.type === "synced_projection_resync" ||
    (msg as { type: string }).type === "ping"
  );
}

export function handleBrowserOpen(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: BrowserTransportDeps,
): void {
  openBrowserConnectionDiagnostics(ws, session.id);
  const data = (ws.data ??= {}) as BrowserTransportSocketData;
  data.subscribed = false;
  data.lastAckSeq = 0;
  delete data.conversationView;
  session.browserSockets.add(ws);
  console.log(
    `[ws-bridge] Browser connected for session ${sessionTag(session.id)} (${session.browserSockets.size} browsers)`,
  );

  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  const isArchived = launcherInfo?.archived === true;
  if (!isArchived) {
    deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
    deps.prefillSlashCommands(session);
  }
  sendToBrowser(ws, {
    type: "session_init",
    session: {
      ...projectBrowserSessionState(session.state),
      isOrchestrator: launcherInfo?.isOrchestrator === true,
    },
    nextEventSeq: session.nextEventSeq,
  } as BrowserIncomingMessage);
  sendToBrowser(ws, {
    type: "codex_pending_inputs",
    inputs: compactPendingCodexInputsForBrowser(session.pendingCodexInputs),
  } as BrowserIncomingMessage);
  (ws.data as BrowserTransportSocketData).initialTreeGroupState = deps.getTreeGroupState().catch((err) => {
    console.warn("[ws-bridge] failed to prepare tree group state on connect:", err);
    return null;
  });
  sendToBrowser(ws, {
    type: "vscode_selection_state",
    state: deps.getVsCodeSelectionState(),
  } as BrowserIncomingMessage);

  if (isArchived) {
    sendToBrowser(ws, { type: "backend_disconnected" } as BrowserIncomingMessage);
    return;
  }

  const hasBackendAttached = deps.backendAttached(session);
  if (!hasBackendAttached) {
    if (launcherInfo?.state === "starting") {
      if (launcherInfo.backendType === "claude-sdk") {
        sendToBrowser(ws, { type: "backend_connected" } as BrowserIncomingMessage);
      } else {
        sendToBrowser(ws, { type: "backend_disconnected" } as BrowserIncomingMessage);
      }
      return;
    }

    const idleKilled = launcherInfo?.killedByIdleManager;
    sendToBrowser(ws, {
      type: "backend_disconnected",
      ...(idleKilled ? { reason: "idle_limit" } : {}),
    } as BrowserIncomingMessage);
    if (isSessionPaused(session)) {
      console.log(
        `[ws-bridge] Browser connected but backend is dead for paused session ${sessionTag(session.id)}; relaunch deferred until unpause`,
      );
    } else if (session.backendType === "codex") {
      console.log(
        `[ws-bridge] Browser connected but Codex backend is dead for session ${sessionTag(session.id)}; passive browser-open recovery is suppressed`,
      );
    } else if (deps.requestCliRelaunch) {
      console.log(
        `[ws-bridge] Browser connected but backend is dead for session ${sessionTag(session.id)}, requesting relaunch`,
      );
      deps.requestCliRelaunch(session.id);
    }
    return;
  }

  if (deps.backendConnected(session)) {
    sendToBrowser(ws, { type: "backend_connected" } as BrowserIncomingMessage);
    return;
  }

  sendToBrowser(ws, {
    type: "backend_disconnected",
    ...(session.state.backend_state === "broken"
      ? { reason: "broken" }
      : session.state.backend_state === "recovery_suppressed"
        ? { reason: "recovery_suppressed" }
        : {}),
  } as BrowserIncomingMessage);
}

export function handleBrowserClose(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: Pick<BrowserTransportDeps, "backendConnected" | "removeSyncedProjectionSubscriber">,
  code?: number,
  reason?: string,
): void {
  closeBrowserConnectionDiagnostics(ws);
  session.browserSockets.delete(ws);
  deps.removeSyncedProjectionSubscriber?.(ws);
  const hasBackend = deps.backendConnected(session);
  console.log(
    `[ws-bridge] Browser disconnected for session ${sessionTag(session.id)} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"}) | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}`,
  );
}

export async function handleBrowserIngressMessage(
  session: BrowserTransportSessionLike,
  rawMsg: BrowserOutgoingMessage,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): Promise<BrowserIngressOwnershipResult> {
  const msg = stripRecoveryDeliveryTransferMarker(rawMsg);
  if (isArchivedReadOnlySession(session, deps) && !isArchivedReadOnlyBrowserMessage(msg)) {
    return {
      status: "ignored_no_owner",
      reason: "archived_read_only",
      ...unownedRecoveryLinks(msg),
    };
  }

  if (isSessionPaused(session)) {
    if (msg.type === "user_message" && !isComposerUserMessage(session, msg)) {
      if (!canQueuePausedUserMessage(msg)) {
        deps.broadcastError(session, "Session is paused. Raw image messages cannot be safely held; unpause and retry.");
        return { status: "terminal_rejected", reason: "unsafe_raw_image" };
      }
      queuePausedUserMessage(session, "browser", msg);
      deps.persistSession(session);
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { pause: session.state.pause },
      } as BrowserIncomingMessage);
      deps.broadcastError(session, buildPausedDiagnostic(session));
      return { status: "queued_manual_pause" };
    }
  }
  const codexAutoPause = getActiveCodexResultErrorAutoPause(session);
  if (codexAutoPause && msg.type === "user_message" && isAutomaticCodexAutoPauseInput(msg)) {
    if (!canQueuePausedUserMessage(msg)) {
      deps.broadcastError(
        session,
        "Automatic Codex input delivery is paused. Raw image messages cannot be safely held; send a direct composer message to test recovery.",
      );
      return { status: "terminal_rejected", reason: "unsafe_raw_image" };
    }
    queueCodexAutoPausedInput(session, "browser", msg);
    deps.persistSession(session);
    deps.broadcastToBrowsers(session, {
      type: "session_update",
      session: { codex_result_error_auto_pause: session.state.codex_result_error_auto_pause },
    } as BrowserIncomingMessage);
    deps.broadcastError(session, buildCodexAutoPauseDiagnostic(session.state.codex_result_error_auto_pause!));
    return { status: "reheld_auto_pause" };
  }

  let ownershipResult: BrowserIngressOwnershipResult = {
    status: "ignored_no_owner",
    reason: "protocol_handled",
    ...unownedRecoveryLinks(msg),
  };
  const routeTask = async () => {
    const maybeProtocolHandled = handleBrowserProtocolMessage(session, msg, ws, deps);
    const protocolHandled = maybeProtocolHandled instanceof Promise ? await maybeProtocolHandled : maybeProtocolHandled;
    if (protocolHandled) return;
    await deps.routeBrowserMessage(session, msg, ws);
    ownershipResult = classifyRecoveryDeliveryOwnership(session, msg);
  };
  const routePromise =
    shouldSerializeBrowserMessage(msg) ||
    shouldSerializeStartupCatalogMessage(session, msg) ||
    hasSessionRouteInFlight(session.id, deps)
      ? enqueueSessionRoute(session.id, routeTask, deps)
      : Promise.resolve(routeTask());

  try {
    await routePromise;
    return ownershipResult;
  } catch (err) {
    const durableOwnership = classifyRecoveryDeliveryOwnership(session, msg);
    const rejectedLinks =
      durableOwnership.status === "ignored_no_owner" ? durableOwnership.unownedRecoveryLinks : undefined;
    if (msg.type === "user_message" && msg.imageRefs?.length) {
      deps.notifyImageSendFailure(session, err);
    } else {
      console.error(`[ws-bridge] Failed to route browser message for session ${sessionTag(session.id)}:`, err);
      deps.broadcastError(session, "Failed to process message. Please retry.");
    }
    if (durableOwnership.status === "accepted_pending_delivery" || durableOwnership.status === "terminal_receipt") {
      return durableOwnership;
    }
    return {
      status: "terminal_rejected",
      reason: "routing_error",
      ...(rejectedLinks ? { unownedRecoveryLinks: rejectedLinks } : {}),
    };
  }
}

export function handleBrowserMessage(
  session: BrowserTransportSessionLike,
  data: string,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): { messageType: string; completion: Promise<void> | null } {
  deps.recordIncomingRaw?.(session.id, data, session.backendType, session.state.cwd);

  let msg: BrowserOutgoingMessage;
  try {
    msg = JSON.parse(data);
  } catch {
    trafficStats.record({
      sessionId: session.id,
      channel: "browser",
      direction: "in",
      messageType: "invalid_json",
      payloadBytes: Buffer.byteLength(data, "utf-8"),
    });
    console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
    return { messageType: "invalid_json", completion: null };
  }

  // Browser JSON cannot mint timer-firing authority. Internal ingress also
  // resumes server-owned paused/recovery payloads and must retain their proof.
  if (msg.type === "user_message") delete msg.timerFiring;

  trafficStats.record({
    sessionId: session.id,
    channel: "browser",
    direction: "in",
    messageType: getTrafficMessageType(msg),
    payloadBytes: Buffer.byteLength(data, "utf-8"),
  });

  return {
    messageType: msg.type,
    completion: handleBrowserIngressMessage(session, msg, ws, deps).then(() => undefined),
  };
}

export function handleBrowserProtocolMessage(
  session: BrowserTransportSessionLike,
  msg: BrowserOutgoingMessage,
  ws: BrowserTransportSocketLike | undefined,
  deps: BrowserTransportDeps,
): boolean | Promise<boolean> {
  if (msg.type === "browser_connection_probe_ack") {
    if (ws) acknowledgeBrowserConnection(ws, msg.connection_id);
    return true;
  }
  if (msg.type === "session_subscribe") {
    const observingInitialSubscribe = ws && beginBrowserConnectionSubscribe(ws, msg.last_seq, msg.full_history_sync);
    return handleSessionSubscribe(
      session,
      ws,
      msg.last_seq,
      msg.known_frozen_count ?? 0,
      msg.known_frozen_hash,
      msg.history_window_section_turn_count,
      msg.history_window_visible_section_count,
      msg.initial_thread_window,
      deps,
      msg.history_window_target_message_id,
      msg.history_window_target_index,
      msg.full_history_sync,
      msg.synced_projection_subscriptions,
    ).then(
      () => {
        if (ws && observingInitialSubscribe) finishBrowserConnectionSubscribe(ws, true);
        return true;
      },
      (error) => {
        if (ws && observingInitialSubscribe) finishBrowserConnectionSubscribe(ws, false);
        throw error;
      },
    );
  }

  if (handleSyncedProjectionProtocolMessage(session, msg, ws, deps, sendToBrowser)) return true;

  if (msg.type === "history_window_request") {
    if (!ws) return true;
    const socketData = (ws.data ??= {}) as BrowserTransportSocketData;
    recordBoundedConversationRequest(socketData, msg);
    sendHistoryWindowSync(session, ws, {
      fromTurn: msg.from_turn,
      turnCount: msg.turn_count,
      sectionTurnCount: msg.section_turn_count,
      visibleSectionCount: msg.visible_section_count,
      cachedWindowHash: msg.cached_window_hash,
      targetMessageId: msg.target_message_id,
      targetHistoryIndex: msg.target_history_index,
    });
    const complete = boundedConversationSyncComplete(socketData, session.nextEventSeq - 1);
    if (complete) sendToBrowser(ws, complete);
    return true;
  }

  if (msg.type === "thread_window_request") {
    if (!ws) return true;
    const socketData = (ws.data ??= {}) as BrowserTransportSocketData;
    recordBoundedConversationRequest(socketData, msg);
    sendThreadWindowSync(session, ws, {
      threadKey: msg.thread_key,
      fromItem: msg.from_item,
      itemCount: msg.item_count,
      sectionItemCount: msg.section_item_count,
      visibleItemCount: msg.visible_item_count,
      cachedWindowHash: msg.cached_window_hash,
      targetMessageId: msg.target_message_id,
    });
    const complete = boundedConversationSyncComplete(socketData, session.nextEventSeq - 1);
    if (complete) sendToBrowser(ws, complete);
    return true;
  }

  if (msg.type === "conversation_view_update") {
    if (ws) recordBoundedConversationViewUpdate((ws.data ??= {}) as BrowserTransportSocketData, msg);
    return true;
  }

  if (msg.type === "session_ack") {
    handleSessionAck(session, ws, msg.last_seq, deps);
    return true;
  }

  if (msg.type === "history_sync_mismatch") {
    console.warn(
      `[history-sync] Browser reported hash mismatch for session ${sessionTag(session.id)} ` +
        `(frozenCount=${msg.frozen_count}) ` +
        `frozen expected=${msg.expected_frozen_hash} actual=${msg.actual_frozen_hash}; ` +
        `full expected=${msg.expected_full_hash} actual=${msg.actual_full_hash}`,
    );
    return true;
  }

  if ((msg as { type: string }).type === "ping") return true;
  if (isArchivedReadOnlySession(session, deps)) return true;

  if (msg.type === "permission_user_viewing") {
    const requestId = msg.request_id;
    const perm = session.pendingPermissions.get(requestId);
    if (perm?.evaluating) {
      deps.abortAutoApproval(session, requestId);
      perm.evaluating = undefined;
      deps.broadcastToBrowsers(session, {
        type: "permission_needs_attention",
        request_id: requestId,
        timestamp: Date.now(),
      });
      deps.setAttentionAction(session);
      console.log(
        `[ws-bridge] Auto-approval cancelled for ${perm.tool_name} in session ${sessionTag(session.id)} — user opened dialog`,
      );
      deps.persistSession(session);
    }
    return true;
  }

  if (msg.type === "leader_thread_tabs_update" && isObsoleteLeaderThreadTabOperation(msg.operation)) {
    deps.touchActivity?.(session.id);
    return true;
  }

  if (isIdempotentBrowserMessage(msg.type, deps) && "client_msg_id" in msg && msg.client_msg_id) {
    if (session.processedClientMessageIdSet.has(msg.client_msg_id)) return true;
    session.processedClientMessageIds.push(msg.client_msg_id);
    session.processedClientMessageIdSet.add(msg.client_msg_id);
    if (session.processedClientMessageIds.length > deps.processedClientMsgIdLimit) {
      const overflow = session.processedClientMessageIds.length - deps.processedClientMsgIdLimit;
      const removed = session.processedClientMessageIds.splice(0, overflow);
      for (const id of removed) {
        session.processedClientMessageIdSet.delete(id);
      }
    }
    deps.persistSession(session);
  }

  if (msg.type === "leader_thread_tabs_update") {
    deps.touchActivity?.(session.id);
    handleLeaderThreadTabsUpdate(session, msg.operation, deps);
    return true;
  }

  if (BROWSER_ACTIVITY_TYPES.has(msg.type)) {
    deps.touchActivity?.(session.id);
  }

  if (msg.type === "vscode_selection_update") {
    handleVsCodeSelectionUpdate(deps.browserTransportState, msg, deps);
    return true;
  }

  return false;
}

function isIdempotentBrowserMessage(type: BrowserOutgoingMessage["type"], deps: BrowserTransportDeps): boolean {
  return deps.idempotentMessageTypes.has(type) || LOCAL_IDEMPOTENT_BROWSER_MESSAGE_TYPES.has(type);
}

export function injectUserMessage(
  session: BrowserTransportSessionLike,
  content: string,
  agentSource: AgentSource | undefined,
  takodeHerdBatch: TakodeHerdBatchSnapshot | undefined,
  deps: BrowserTransportDeps,
  threadRoute?: ThreadRouteMetadata,
  options?: ProgrammaticUserMessageOptions,
): "sent" | "queued" {
  const backendLive = deps.backendConnected(session);
  if (isHerdEventSource(agentSource) && session.backendType === "codex") {
    const existing = findMatchingPendingCodexInput(session, content, agentSource, threadRoute);
    if (existing) {
      if (existing.cancelable) {
        deps.queueCodexPendingStartBatch(session, "inject_herd_event_retry");
      }
      return getPendingCodexInputDeliveryState(session, existing.id);
    }
  }

  const sdkAdapterMissingBeforeRoute = session.backendType === "claude-sdk" && !session.claudeSdkAdapter;
  const pendingCodexCountBefore = session.pendingCodexInputs.length;
  const hadRouteInFlight = hasSessionRouteInFlight(session.id, deps);
  const serializeForStartupCatalog = session.pendingStartupMemoryCatalogInjection === true;
  const browserMessage: BrowserOutgoingMessage = {
    type: "user_message",
    content,
    ...(options?.deliveryContent ? { deliveryContent: options.deliveryContent } : {}),
    ...(options?.historyFollowUps?.length ? { historyFollowUps: options.historyFollowUps } : {}),
    ...(options?.timerFiring ? { timerFiring: options.timerFiring } : {}),
    ...(options?.replyContext ? { replyContext: options.replyContext } : {}),
    ...(options?.sessionId ? { session_id: options.sessionId } : {}),
    ...(options?.vscodeSelection ? { vscodeSelection: options.vscodeSelection } : {}),
    ...(options?.autoPauseSourceKind ? { autoPauseSourceKind: options.autoPauseSourceKind } : {}),
    ...(options?.leaderThreadOutcomeReminderGuard
      ? { leaderThreadOutcomeReminderGuard: options.leaderThreadOutcomeReminderGuard }
      : {}),
    ...(agentSource ? { agentSource } : {}),
    ...(takodeHerdBatch ? { takodeHerdBatch } : {}),
    ...(threadRoute ? { threadKey: threadRoute.threadKey } : {}),
    ...(threadRoute?.questId ? { questId: threadRoute.questId } : {}),
    ...(threadRoute?.threadRefs?.length ? { threadRefs: threadRoute.threadRefs } : {}),
  };
  const dropped = Symbol("programmatic-message-dropped");
  const routeHerdMessage = (): Promise<boolean | void> | boolean | void | typeof dropped => {
    if (session.backendType === "codex" && isInactiveCodexRecoverySource(session, agentSource?.sessionId)) {
      return dropped;
    }
    if (isHerdEventSource(agentSource) && takodeHerdBatch && deps.pruneTakodeHerdBatch) {
      const pruned = deps.pruneTakodeHerdBatch(session, takodeHerdBatch);
      if (pruned.changed) {
        if (!pruned.content || !pruned.batch) return dropped;
        return deps.routeBrowserMessage(session, {
          ...browserMessage,
          content: pruned.content,
          takodeHerdBatch: pruned.batch,
        });
      }
    }
    return deps.routeBrowserMessage(session, browserMessage);
  };
  const notifyAccepted = () => {
    try {
      options?.afterAccepted?.();
    } catch (error) {
      console.warn(
        `[ws-bridge] Programmatic message acceptance callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const notifyRejected = (reason: "dropped" | "route_rejected" | "route_failed") => {
    try {
      options?.afterRejected?.(reason);
    } catch (error) {
      console.warn(
        `[ws-bridge] Programmatic message rejection callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const routeAndNotifyAccepted = (): Promise<void> | void => {
    try {
      const routed = routeHerdMessage();
      if (routed === dropped) {
        notifyRejected("dropped");
        return;
      }
      if (routed instanceof Promise) {
        return routed.then(
          (accepted) => {
            if (accepted === false) notifyRejected("route_rejected");
            else notifyAccepted();
          },
          (error) => {
            notifyRejected("route_failed");
            throw error;
          },
        );
      }
      if (routed === false) notifyRejected("route_rejected");
      else notifyAccepted();
    } catch (error) {
      notifyRejected("route_failed");
      throw error;
    }
  };

  if (hadRouteInFlight || serializeForStartupCatalog) {
    if (isHerdEventSource(agentSource) && session.backendType === "codex") {
      const queuedKey = getCodexHerdRouteQueueKey(content, agentSource, threadRoute);
      const queuedKeys = getQueuedCodexHerdRouteKeys(session);
      if (queuedKeys.has(queuedKey)) {
        return "queued";
      }
      queuedKeys.add(queuedKey);
      void enqueueSessionRoute(session.id, routeAndNotifyAccepted, deps)
        .finally(() => {
          queuedKeys.delete(queuedKey);
          if (queuedKeys.size === 0) {
            queuedCodexHerdRouteKeys.delete(session);
          }
        })
        .catch(() => {});
      return "queued";
    }
    void enqueueSessionRoute(session.id, routeAndNotifyAccepted, deps).catch(() => {});
  } else {
    const routed = routeAndNotifyAccepted();
    if (routed instanceof Promise) void routed.catch(() => {});
    if (isHerdEventSource(agentSource) && session.backendType === "codex") {
      const pending = session.pendingCodexInputs
        .slice(pendingCodexCountBefore)
        .find(
          (input) =>
            input.content === content &&
            sameAgentSource(input.agentSource, agentSource) &&
            samePendingThreadRoute(input, threadRoute),
        );
      if (pending) {
        return getPendingCodexInputDeliveryState(session, pending.id);
      }
    }
  }

  if (!backendLive && deps.requestCliRelaunch) {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    if (
      session.backendType !== "codex" &&
      launcherInfo &&
      launcherInfo.state === "exited" &&
      session.state.backend_state !== "broken" &&
      session.state.backend_state !== "recovery_suppressed"
    ) {
      // Claude SDK's missing-adapter route already queues the message and
      // requests relaunch. The post-route fallback remains needed when an SDK
      // adapter object exists but is disconnected and queues internally.
      if (sdkAdapterMissingBeforeRoute) {
        return "queued";
      }
      if (launcherInfo.killedByIdleManager) {
        launcherInfo.killedByIdleManager = false;
        console.log(`[ws-bridge] Clearing idle-killed flag for session ${sessionTag(session.id)} (message inject)`);
      }
      console.log(
        `[ws-bridge] Injected message queued for exited session ${sessionTag(session.id)}, requesting relaunch`,
      );
      deps.requestCliRelaunch(session.id);
    }
  }

  return backendLive ? "sent" : "queued";
}

export function isHerdEventSource(agentSource: AgentSource | undefined): boolean {
  return agentSource?.sessionId === "herd-events";
}

export function sameAgentSource(left: AgentSource | undefined, right: AgentSource | undefined): boolean {
  return (
    (left?.sessionId ?? "") === (right?.sessionId ?? "") && (left?.sessionLabel ?? "") === (right?.sessionLabel ?? "")
  );
}

export function normalizePendingCodexDedupContent(content: string, agentSource?: AgentSource): string {
  if (!isHerdEventSource(agentSource)) return content;
  return content.replace(/ \| \d+[smhd] ago(?=$|\n)/g, "");
}

export function findMatchingPendingCodexInput(
  session: BrowserTransportSessionLike,
  content: string,
  agentSource?: AgentSource,
  threadRoute?: ThreadRouteMetadata,
): PendingCodexInput | null {
  const normalizedContent = normalizePendingCodexDedupContent(content, agentSource);
  for (let i = session.pendingCodexInputs.length - 1; i >= 0; i--) {
    const pending = session.pendingCodexInputs[i];
    if (normalizePendingCodexDedupContent(pending.content, pending.agentSource) !== normalizedContent) continue;
    if (!sameAgentSource(pending.agentSource, agentSource)) continue;
    if (!samePendingThreadRoute(pending, threadRoute)) continue;
    return pending;
  }
  return null;
}

function samePendingThreadRoute(pending: PendingCodexInput, threadRoute?: ThreadRouteMetadata): boolean {
  return (pending.threadKey ?? "main").toLowerCase() === (threadRoute?.threadKey ?? "main").toLowerCase();
}

export function getPendingCodexInputDeliveryState(
  session: BrowserTransportSessionLike,
  inputId: string,
): "sent" | "queued" {
  const pending = session.pendingCodexInputs.find((input) => input.id === inputId);
  if (!pending) return "sent";
  const turn = session.pendingCodexTurns.find((candidate) =>
    (candidate.pendingInputIds ?? [candidate.userMessageId]).includes(inputId),
  );
  if (!turn) return pending.cancelable ? "queued" : "sent";
  if (turn.status === "dispatched" || turn.status === "backend_acknowledged") return "sent";
  return "queued";
}

function getQueuedCodexHerdRouteKeys(session: BrowserTransportSessionLike): Set<string> {
  let keys = queuedCodexHerdRouteKeys.get(session);
  if (!keys) {
    keys = new Set<string>();
    queuedCodexHerdRouteKeys.set(session, keys);
  }
  return keys;
}

function getCodexHerdRouteQueueKey(
  content: string,
  agentSource: AgentSource | undefined,
  threadRoute?: ThreadRouteMetadata,
): string {
  return JSON.stringify({
    content: normalizePendingCodexDedupContent(content, agentSource),
    sessionId: agentSource?.sessionId ?? "",
    sessionLabel: agentSource?.sessionLabel ?? "",
    threadKey: (threadRoute?.threadKey ?? "main").toLowerCase(),
  });
}

export function deriveSessionStatus(
  session: BrowserTransportSessionLike,
  deps: Pick<BrowserTransportDeps, "backendConnected">,
): string | null {
  if (session.state.is_compacting) return "compacting";
  if (!deps.backendConnected(session)) return null;
  if ((session as any).isGenerating) return "running";
  return "idle";
}

export function deriveActiveTurnRoute(session: BrowserTransportSessionLike): ActiveTurnRoute | null {
  if (!session.isGenerating) return null;
  if (session.activeTurnRoute) {
    return session.activeTurnRoute;
  }
  const userMessageIdsThisTurn = session.userMessageIdsThisTurn ?? [];
  for (let i = userMessageIdsThisTurn.length - 1; i >= 0; i--) {
    const historyIndex = userMessageIdsThisTurn[i];
    const route = routeFromHistoryEntry(session.messageHistory[historyIndex]);
    if (!route || route.threadKey === "main") return { threadKey: "main" };
    return {
      threadKey: route.threadKey,
      ...(route.questId ? { questId: route.questId } : {}),
    };
  }
  return { threadKey: "main" };
}

export function isLeaderSession(
  session: BrowserTransportSessionLike,
  deps: Pick<BrowserTransportDeps, "getLauncherSessionInfo">,
): boolean {
  if ((session.state as { isOrchestrator?: boolean }).isOrchestrator === true) return true;
  return deps.getLauncherSessionInfo(session.id)?.isOrchestrator === true;
}

export function buildLeaderProjectionSnapshotForSession(
  session: BrowserTransportSessionLike,
): LeaderProjectionSnapshot {
  const inputs = getLeaderMessageVisualInputs(session);
  return {
    schemaVersion: 2,
    sourceHistoryLength: session.messageHistory.length,
    threadSummaries: inputs.threadSummaries,
    messageAttentionRecords: inputs.attentionRecords,
  };
}

export function sendLeaderProjectionSnapshot(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: Pick<BrowserTransportDeps, "getLauncherSessionInfo">,
): void {
  if (!isLeaderSession(session, deps)) return;
  sendToBrowser(ws, {
    type: "leader_projection_snapshot",
    projection: buildLeaderProjectionSnapshotForSession(session),
  } as BrowserIncomingMessage);
}

export function sendStateSnapshot(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  deps: BrowserTransportDeps,
): void {
  const board = deps.getBoard(session.id) as BoardRow[];
  const completedBoard = deps.getCompletedBoard(session.id) as BoardRow[];
  const notificationStatus = getNotificationStatusSnapshot(session);
  const sessionStatus = deriveSessionStatus(session, deps);
  sendToBrowser(ws, {
    type: "state_snapshot",
    sessionStatus,
    permissionMode: session.state.permissionMode,
    ...buildBackendStateSnapshot(session, deps),
    uiMode: session.state.uiMode ?? null,
    askPermission: session.state.askPermission ?? true,
    generationStartedAt: session.generationStartedAt ?? null,
    activeTurnRoute: deriveActiveTurnRoute(session),
    ...codexReasoningSnapshotFields(session),
    codexAutoPauseRecoveryProgress: getCodexAutoPauseRecoveryProgress(session),
    board,
    completedBoard,
    rowSessionStatuses: deps.getBoardRowSessionStatuses(session.id, board, completedBoard),
    notifications: getUserVisibleSessionNotifications(session),
    attentionRecords: session.attentionRecords,
    notificationUrgency: notificationStatus.notificationUrgency,
    activeNotificationCount: notificationStatus.activeNotificationCount,
    activeNeedsInputNotificationCount: notificationStatus.activeNeedsInputNotificationCount,
    activeReviewNotificationCount: notificationStatus.activeReviewNotificationCount,
    mutedNeedsInputNotificationCount: notificationStatus.mutedNeedsInputNotificationCount,
    notificationStatusVersion: notificationStatus.notificationStatusVersion,
    notificationStatusUpdatedAt: notificationStatus.notificationStatusUpdatedAt,
  } as BrowserIncomingMessage);
}

/** Yield so large history hashing does not monopolize the event loop. */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

export function normalizeKnownFrozenCount(knownFrozenCount: number | undefined): number {
  if (!Number.isFinite(knownFrozenCount)) return 0;
  return Math.max(0, Math.floor(knownFrozenCount ?? 0));
}

export function clampFrozenCount(session: BrowserTransportSessionLike): void {
  session.frozenCount = Math.max(0, Math.min(session.frozenCount, session.messageHistory.length));
}

export function freezeHistoryThroughCurrentTail(session: BrowserTransportSessionLike): void {
  const mutableSummaryIndex = session.messageHistory.findIndex(
    (message) =>
      message.type === "codex_auto_pause_recovery_summary" && !isCodexAutoPauseRecoverySummaryFinal(message.recovery),
  );
  session.frozenCount = mutableSummaryIndex >= 0 ? mutableSummaryIndex : session.messageHistory.length;
}

export async function sendHistorySync(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
): Promise<void> {
  const synced = await sendHistorySyncAttempt(session, ws, knownFrozenCount, knownFrozenHash);
  if (!synced && knownFrozenCount > 0) {
    console.warn(
      `[history-sync] Falling back to full history sync for session ${sessionTag(session.id)} ` +
        `(knownFrozenCount=${normalizeKnownFrozenCount(knownFrozenCount)}, ` +
        `serverHistoryLength=${session.messageHistory.length}, frozenCount=${session.frozenCount})`,
    );
    await sendHistorySyncAttempt(session, ws, 0, undefined);
  }
}

function projectHistorySyncRange(
  history: BrowserIncomingMessage[],
  startIndex: number,
  endIndex: number,
): BrowserIncomingMessage[] {
  const projected: BrowserIncomingMessage[] = [];
  for (let historyIndex = startIndex; historyIndex < endIndex; historyIndex += 1) {
    const message = history[historyIndex];
    if (!message || !isRootAgentHistoryMessage(message)) continue;
    const expectedContiguousIndex = startIndex + projected.length;
    projected.push(
      historyIndex === expectedContiguousIndex && message.history_index == null
        ? message
        : { ...message, history_index: historyIndex },
    );
  }
  return projected;
}

async function sendHistorySyncAttempt(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
): Promise<boolean> {
  const normalizedKnownFrozenCount = normalizeKnownFrozenCount(knownFrozenCount);
  clampFrozenCount(session);
  const frozenCount = session.frozenCount;
  const frozenHistory = session.messageHistory.slice(0, frozenCount);
  const historyHashOptions = {
    suppressRootThinkingOnlyAssistant: session.backendType === "codex",
    includeMessage: isRootAgentHistoryMessage,
  };
  const frozenPrefix = computeHistoryMessagesSyncHash(frozenHistory, 0, historyHashOptions);
  if (normalizedKnownFrozenCount > frozenPrefix.renderedCount) {
    console.warn(
      `[history-sync] Invalid known_frozen_count=${normalizedKnownFrozenCount} ` +
        `for session ${sessionTag(session.id)} authoritativeFrozen=${frozenPrefix.renderedCount} ` +
        `serverHistoryLength=${session.messageHistory.length} frozenCount=${frozenCount}; refusing incremental sync`,
    );
    return false;
  }
  const knownPrefix = computeHistoryPrefixSyncHash(frozenHistory, normalizedKnownFrozenCount, 0, historyHashOptions);
  if (session.messageHistory.length === 0) return true;
  if (normalizedKnownFrozenCount > 0 && typeof knownFrozenHash === "string") {
    if (knownPrefix.hash !== knownFrozenHash) {
      console.warn(
        `[history-sync] Frozen prefix hash mismatch for session ${sessionTag(session.id)} ` +
          `(count=${normalizedKnownFrozenCount}, authoritativeFrozen=${frozenPrefix.renderedCount}, ` +
          `serverHistoryLength=${session.messageHistory.length}, frozenCount=${frozenCount}) ` +
          `expected=${knownPrefix.hash} actual=${knownFrozenHash}; refusing incremental sync`,
      );
      return false;
    }
  }

  const historySnapshot = session.messageHistory.slice();
  const isLargeHistory = historySnapshot.length > 500;
  if (isLargeHistory) await yieldToEventLoop();
  const fullHistory = computeHistoryMessagesSyncHash(historySnapshot, 0, historyHashOptions);
  const frozenBaseHistoryIndex = knownPrefix.sourceCount;
  const frozenDelta = projectHistorySyncRange(historySnapshot, frozenBaseHistoryIndex, frozenCount);
  const hotMessages = projectHistorySyncRange(historySnapshot, frozenCount, historySnapshot.length);
  if (isLargeHistory) await yieldToEventLoop();

  const frozenDeltaJson = JSON.stringify(frozenDelta);
  const hotMessagesJson = JSON.stringify(hotMessages);
  trafficStats.recordHistorySyncBreakdown({
    sessionId: session.id,
    frozenDeltaBytes: Buffer.byteLength(frozenDeltaJson, "utf-8"),
    hotMessagesBytes: Buffer.byteLength(hotMessagesJson, "utf-8"),
    frozenDeltaMessages: frozenDelta.length,
    hotMessagesCount: hotMessages.length,
  });

  const payloadJson =
    `{"type":"history_sync"` +
    `,"frozen_base_count":${normalizedKnownFrozenCount}` +
    `,"frozen_base_history_index":${frozenBaseHistoryIndex}` +
    `,"frozen_delta":${frozenDeltaJson}` +
    `,"hot_messages":${hotMessagesJson}` +
    `,"frozen_count":${frozenCount}` +
    `,"expected_frozen_hash":${JSON.stringify(frozenPrefix.hash)}` +
    `,"expected_full_hash":${JSON.stringify(fullHistory.hash)}}`;
  sendToBrowserRaw(ws, payloadJson, "history_sync");
  return true;
}

export function sendHistoryWindowSync(
  session: Pick<BrowserTransportSessionLike, "messageHistory">,
  ws: BrowserTransportSocketLike,
  options: {
    fromTurn: number;
    turnCount: number;
    sectionTurnCount: number;
    visibleSectionCount: number;
    cachedWindowHash?: string;
    targetMessageId?: string;
    targetHistoryIndex?: number;
  },
): void {
  const normalizedSectionTurnCount = Math.max(1, Math.floor(options.sectionTurnCount));
  const normalizedVisibleSectionCount = Math.max(1, Math.floor(options.visibleSectionCount));
  const normalizedTurnCount = Math.max(
    1,
    Math.floor(
      options.turnCount || getHistoryWindowTurnCount(normalizedVisibleSectionCount, normalizedSectionTurnCount),
    ),
  );
  const turns = findTurnBoundaries(session.messageHistory, isRootAgentHistoryMessage);
  const totalTurns = turns.length;
  let fromTurn = 0;
  let turnCount = 0;
  let startIdx = 0;
  let messages: BrowserIncomingMessage[] = [];

  if (totalTurns > 0) {
    const selected = selectHistoryWindowRange({
      messageHistory: session.messageHistory,
      turns,
      requestedFromTurn: Math.floor(options.fromTurn),
      turnCount: normalizedTurnCount,
      targetMessageId: options.targetMessageId,
      targetHistoryIndex: options.targetHistoryIndex,
      includeMessage: isRootAgentHistoryMessage,
      includeOutsideTurnMessage: (message, historyIndex) =>
        isRootAgentHistoryMessage(message) && message.type === "quest_lifecycle_event" && historyIndex >= 0,
    });
    ({ fromTurn, turnCount, startIdx, messages } = selected);
  } else {
    messages = session.messageHistory.slice();
  }
  messages = appendResolvedToolResultPreviewsForWindow(messages, session.messageHistory);
  const windowHash = computeHistoryPayloadSyncHash({ startIdx, messages });
  const cacheHit = options.cachedWindowHash === windowHash;

  const window = {
    from_turn: fromTurn,
    turn_count: totalTurns === 0 ? 0 : turnCount,
    total_turns: totalTurns,
    ...deriveWindowAvailability({
      from: fromTurn,
      count: totalTurns === 0 ? 0 : turnCount,
      total: totalTurns,
    }),
    start_index: startIdx,
    section_turn_count: normalizedSectionTurnCount,
    visible_section_count: normalizedVisibleSectionCount,
    window_hash: windowHash,
  };

  sendToBrowser(ws, {
    type: "history_window_sync",
    messages: cacheHit ? [] : messages,
    window,
    ...(cacheHit ? { cache_hit: true } : {}),
  } as BrowserIncomingMessage);
}

export function sendThreadWindowSync(
  session: Pick<BrowserTransportSessionLike, "id" | "messageHistory">,
  ws: BrowserTransportSocketLike,
  options: {
    threadKey: string;
    fromItem: number;
    itemCount?: number;
    sectionItemCount: number;
    visibleItemCount: number;
    cachedWindowHash?: string;
    targetMessageId?: string;
    targetHistoryIndex?: number;
  },
): void {
  const normalizedSectionItemCount = Math.max(1, Math.floor(options.sectionItemCount));
  const normalizedVisibleItemCount = Math.max(1, Math.floor(options.visibleItemCount));
  const normalizedItemCount = Math.max(
    1,
    Math.floor(options.itemCount || getThreadWindowItemCount(normalizedVisibleItemCount, normalizedSectionItemCount)),
  );
  const threadKey = normalizeSelectedFeedThreadKey(options.threadKey);
  const responseState = buildLeaderThreadResponseState(session, threadKey);
  const sync = buildThreadWindowSync({
    messageHistory: session.messageHistory,
    threadKey,
    fromItem: options.fromItem,
    itemCount: normalizedItemCount,
    sectionItemCount: normalizedSectionItemCount,
    visibleItemCount: normalizedVisibleItemCount,
    targetMessageId: options.targetMessageId,
    targetHistoryIndex: options.targetHistoryIndex,
    includeMessage: isRootAgentHistoryMessage,
    currentThreadResponseProjection: responseState.projection,
  });
  const windowHash = computeHistoryPayloadSyncHash({
    threadKey: sync.threadKey,
    entries: sync.entries,
  });
  const cacheHit = options.cachedWindowHash === windowHash;

  const window = {
    ...sync.window,
    window_hash: windowHash,
  };

  sendToBrowser(ws, {
    type: "thread_window_sync",
    thread_key: sync.threadKey,
    entries: cacheHit ? [] : sync.entries,
    window,
    ...(sync.threadResponseProjection ? { response_state: sync.threadResponseProjection } : {}),
    ...(cacheHit ? { cache_hit: true } : {}),
  } as BrowserIncomingMessage);
}

function sendBoundedConversationView(
  session: Pick<BrowserTransportSessionLike, "id" | "messageHistory">,
  ws: BrowserTransportSocketLike,
  view: BoundedConversationView,
): void {
  if (view.kind === "thread") sendThreadWindowSync(session, ws, view.request);
  else sendHistoryWindowSync(session, ws, view.request);
}

/** Refresh each subscribed current-build browser from its own bounded selected view. */
export function refreshBrowserConversationViews(session: BrowserConversationRefreshSessionLike): void {
  const throughSeq = session.nextEventSeq++;
  for (const ws of session.browserSockets) {
    const socket = ws as BrowserTransportSocketLike;
    const socketData = (socket.data ??= {}) as BrowserTransportSocketData;
    if (!socketData.subscribed || !socketData.conversationView) continue;
    try {
      sendBoundedConversationView(session, socket, socketData.conversationView);
      sendToBrowser(socket, {
        type: "conversation_sync_complete",
        through_seq: throughSeq,
      });
    } catch {
      session.browserSockets.delete(ws);
    }
  }
}

async function sendInitialTreeGroupState(ws: BrowserTransportSocketLike): Promise<void> {
  const data = (ws.data ??= {}) as BrowserTransportSocketData;
  const pending = data.initialTreeGroupState;
  delete data.initialTreeGroupState;
  if (!pending) return;
  try {
    const treeGroups = await pending;
    if (!treeGroups) return;
    sendToBrowser(ws, {
      type: "tree_groups_update",
      treeGroups: treeGroups.groups,
      treeAssignments: treeGroups.assignments,
      treeNodeOrder: treeGroups.nodeOrder,
    } as BrowserIncomingMessage);
  } catch {
    // Preparation already records the failure; socket cleanup is handled elsewhere.
  }
}

export async function handleSessionSubscribe(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike | undefined,
  lastSeq: number,
  knownFrozenCount: number | undefined,
  knownFrozenHash: string | undefined,
  historyWindowSectionTurnCount: number | undefined,
  historyWindowVisibleSectionCount: number | undefined,
  initialThreadWindow: InitialThreadWindowRequest | undefined,
  deps: BrowserTransportDeps,
  historyWindowTargetMessageId?: string,
  historyWindowTargetIndex?: number,
  explicitFullHistorySync?: boolean,
  syncedProjectionSubscriptions?: SyncedProjectionSubscriptions,
): Promise<void> {
  if (!ws) return;
  const data = (ws.data ??= {}) as BrowserTransportSocketData;
  data.subscribed = true;
  const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  data.lastAckSeq = lastAckSeq;
  const projectionSubscribePreparation = prepareSyncedProjectionSessionSubscribe(
    session,
    ws,
    syncedProjectionSubscriptions,
    deps,
    sendToBrowser,
  );
  if (projectionSubscribePreparation.lazyLoad) await projectionSubscribePreparation.lazyLoad;

  const archivedReadOnly = isArchivedReadOnlySession(session, deps);
  if (!archivedReadOnly) {
    deps.recoverToolStartTimesFromHistory(session);
    deps.finalizeRecoveredDisconnectedTerminalTools(session, "session_subscribe");
    deps.scheduleCodexToolResultWatchdogs(session, "session_subscribe");
  }

  const resolvedIds = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type !== "permission_approved" && msg.type !== "permission_denied") continue;
    const record = msg as Record<string, unknown>;
    const requestId = record.request_id as string | undefined;
    if (requestId) {
      resolvedIds.add(requestId);
      continue;
    }
    if (typeof record.id === "string") {
      const match = record.id.match(/^(?:approval|denial)-(.+)$/);
      if (match) resolvedIds.add(match[1]);
    }
  }

  let cleanedStale = false;
  for (const requestId of session.pendingPermissions.keys()) {
    if (!resolvedIds.has(requestId)) continue;
    session.pendingPermissions.delete(requestId);
    cleanedStale = true;
  }
  if (cleanedStale) deps.persistSession(session);

  completeSyncedProjectionSessionSubscribe(
    session,
    ws,
    syncedProjectionSubscriptions,
    projectionSubscribePreparation.replacedBeforeLazyLoad,
    archivedReadOnly,
    deps,
    sendToBrowser,
  );

  const normalizedInitialThreadWindow = normalizeInitialThreadWindowRequest(
    initialThreadWindow,
    isLeaderSession(session, deps),
  );
  const prepared = prepareBoundedConversationSubscribe({
    session,
    socketData: data,
    initialThreadWindow: normalizedInitialThreadWindow,
    historyWindowSectionTurnCount,
    historyWindowVisibleSectionCount,
    historyWindowTargetMessageId,
    historyWindowTargetIndex,
    lastAckSeq,
    running: deriveSessionStatus(session, deps) === "running",
    isHistoryBackedEvent,
  });
  const { boundedView, syncThroughSeq } = prepared;
  const replayEvents = prepared.replayEvents;

  if (boundedView) {
    sendLeaderProjectionSnapshot(session, ws, deps);
    if (explicitFullHistorySync) await sendHistorySync(session, ws, 0, undefined);
    else sendBoundedConversationView(session, ws, boundedView);
    await yieldToEventLoop();
  }

  if (boundedView) await sendInitialTreeGroupState(ws);
  else void sendInitialTreeGroupState(ws);
  if (replayEvents.length > 0) {
    sendToBrowser(ws, { type: "event_replay", events: replayEvents } as BrowserIncomingMessage);
  }

  if (session.pendingPermissions.size > 0) {
    for (const perm of session.pendingPermissions.values()) {
      sendToBrowser(ws, { type: "permission_request", request: perm } as BrowserIncomingMessage);
    }
  }
  if (session.taskHistory.length > 0) {
    sendToBrowser(ws, { type: "session_task_history", tasks: session.taskHistory } as BrowserIncomingMessage);
  }

  const timers = deps.listTimers(session.id);
  sendToBrowser(ws, { type: "timer_update", timers } as BrowserIncomingMessage);
  if (boundedView) {
    sendToBrowser(ws, { type: "conversation_sync_complete", through_seq: syncThroughSeq });
  }
  deps.recomputeAndBroadcastHistoryBytes(session);
  sendStateSnapshot(session, ws, deps);
}

export function handleSessionAck(
  session: BrowserTransportSessionLike,
  ws: BrowserTransportSocketLike | undefined,
  lastSeq: number,
  deps: Pick<BrowserTransportDeps, "persistSession">,
): void {
  const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  if (ws) {
    const data = (ws.data ??= {}) as { subscribed?: boolean; lastAckSeq?: number };
    const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
    data.lastAckSeq = Math.max(prior, normalized);
  }
  if (normalized > session.lastAckSeq) {
    session.lastAckSeq = normalized;
    deps.persistSession(session);
  }
}

export function broadcastToBrowsers(
  session: BrowserTransportSessionLike,
  msg: BrowserIncomingMessage,
  deps: Pick<BrowserTransportDeps, "eventBufferLimit" | "persistSession" | "recordOutgoingRaw"> &
    Partial<Pick<BrowserTransportDeps, "getLauncherSessionInfo">>,
  options?: { skipBuffer?: boolean },
): void {
  msg = projectBrowserMessage(msg);
  msg = attachRecentHistoryIndex(session.messageHistory, msg);
  if (session.browserSockets.size === 0 && msg.type === "result") {
    console.log(
      `[ws-bridge] ⚠ Broadcasting result to 0 browsers for session ${sessionTag(session.id)} (stored in history: true)`,
    );
  }
  const serStart = performance.now();
  const sequenced = sequenceEvent(session, msg, deps, options);
  const json = JSON.stringify(sequenced);
  const serMs = performance.now() - serStart;
  if (serMs > 50) {
    console.warn(
      `[ws-bridge] Slow JSON.stringify in broadcastToBrowsers: ${serMs.toFixed(1)}ms, type=${msg.type}, len=${json.length}, session=${sessionTag(session.id)}`,
    );
  }

  deps.recordOutgoingRaw(session.id, json, session.backendType, session.state.cwd);

  let successfulFanout = 0;
  for (const ws of session.browserSockets) {
    const socket = ws as BrowserTransportSocketLike;
    const socketData = (socket.data ??= {}) as BrowserTransportSocketData;
    try {
      if (!shouldDeliverBrowserEventToSocket(session, msg, socketData)) continue;
      sendObservedBrowserPayload(socket, json, msg.type);
      successfulFanout++;
    } catch {
      session.browserSockets.delete(ws);
    }
  }
  deferBrowserTrafficStats(json, session.id, msg.type, successfulFanout);
}

export function sendToBrowser(ws: BrowserTransportSocketLike, msg: BrowserIncomingMessage): boolean {
  try {
    msg = projectBrowserMessage(msg);
    const json = JSON.stringify(msg);
    const result = sendObservedBrowserPayload(ws, json, msg.type);
    if (result === 0) return false;
    deferBrowserTrafficStats(
      json,
      (ws.data as { sessionId?: string } | undefined)?.sessionId ?? "unknown",
      msg.type,
      1,
    );
    return true;
  } catch {
    // socket cleanup handled elsewhere
    return false;
  }
}

export function sendToBrowserRaw(ws: BrowserTransportSocketLike, json: string, messageType: string): boolean {
  try {
    const result = sendObservedBrowserPayload(ws, json, messageType);
    if (result === 0) return false;
    deferBrowserTrafficStats(
      json,
      (ws.data as { sessionId?: string } | undefined)?.sessionId ?? "unknown",
      messageType,
      1,
    );
    return true;
  } catch {
    // socket cleanup handled elsewhere
    return false;
  }
}

function shouldSerializeBrowserMessage(msg: BrowserOutgoingMessage): boolean {
  return msg.type === "user_message" && !!msg.imageRefs?.length;
}

function shouldSerializeStartupCatalogMessage(
  session: BrowserTransportSessionLike,
  msg: BrowserOutgoingMessage,
): boolean {
  return msg.type === "user_message" && session.pendingStartupMemoryCatalogInjection === true;
}

function hasSessionRouteInFlight(sessionId: string, deps: BrowserTransportDeps): boolean {
  return deps.getRouteChain(sessionId) !== undefined;
}

function enqueueSessionRoute(
  sessionId: string,
  task: () => Promise<void> | void,
  deps: BrowserTransportDeps,
): Promise<void> {
  const prior = deps.getRouteChain(sessionId);
  let next: Promise<void>;
  if (prior) {
    next = prior.catch(() => {}).then(() => task());
  } else {
    try {
      next = Promise.resolve(task());
    } catch (err) {
      next = Promise.reject(err);
    }
  }
  const tracked = next.finally(() => {
    deps.clearRouteChain(sessionId, tracked);
  });
  deps.setRouteChain(sessionId, tracked);
  return tracked;
}

function sequenceEvent(
  session: BrowserTransportSessionLike,
  msg: BrowserIncomingMessage,
  deps: Pick<BrowserTransportDeps, "eventBufferLimit" | "persistSession"> &
    Partial<Pick<BrowserTransportDeps, "getLauncherSessionInfo">>,
  options?: { skipBuffer?: boolean },
): BrowserIncomingMessage {
  const seq = session.nextEventSeq++;
  const sequenced = { ...msg, seq };
  const isLeader =
    (session.state as { isOrchestrator?: boolean }).isOrchestrator === true ||
    deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;
  if (!options?.skipBuffer && shouldBufferForReplayWithContext(msg, { isLeaderSession: isLeader })) {
    session.eventBuffer.push({ seq, message: msg });
    if (session.eventBuffer.length > deps.eventBufferLimit) {
      session.eventBuffer.splice(0, session.eventBuffer.length - deps.eventBufferLimit);
    }
    deps.persistSession(session);
  }
  return sequenced;
}

function deferBrowserTrafficStats(json: string, sessionId: string, messageType: string, fanout: number): void {
  queueMicrotask(() => {
    trafficStats.record({
      sessionId,
      channel: "browser",
      direction: "out",
      messageType,
      payloadBytes: Buffer.byteLength(json, "utf-8"),
      fanout,
    });
  });
}

export function handleVsCodeSelectionUpdate(
  state: BrowserTransportStateLike,
  msg: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }>,
  deps: BrowserTransportDeps,
): boolean {
  const nextState: VsCodeSelectionState = {
    selection: msg.selection
      ? {
          absolutePath: msg.selection.absolutePath,
          startLine: msg.selection.startLine,
          endLine: msg.selection.endLine,
          lineCount: msg.selection.lineCount,
        }
      : null,
    updatedAt: msg.updatedAt,
    sourceId: msg.sourceId,
    sourceType: msg.sourceType,
    ...(msg.sourceLabel ? { sourceLabel: msg.sourceLabel } : {}),
  };

  return updateVsCodeSelectionState(state, nextState, deps);
}

export function getVsCodeSelectionState(state: BrowserTransportStateLike): VsCodeSelectionState | null {
  return state.vscodeSelectionState
    ? {
        ...state.vscodeSelectionState,
        selection: state.vscodeSelectionState.selection ? { ...state.vscodeSelectionState.selection } : null,
      }
    : null;
}

export function updateVsCodeSelectionState(
  state: BrowserTransportStateLike,
  nextState: VsCodeSelectionState,
  deps: BrowserTransportDeps,
): boolean {
  if (!shouldAcceptVsCodeSelectionUpdate(state.vscodeSelectionState, nextState)) {
    return false;
  }

  state.vscodeSelectionState = {
    ...nextState,
    selection: nextState.selection ? { ...nextState.selection } : null,
  };
  if (nextState.sourceType === "vscode-window") {
    const currentWindow = state.vscodeWindows.get(nextState.sourceId);
    if (currentWindow) {
      currentWindow.lastSeenAt = Date.now();
      currentWindow.lastActivityAt = Math.max(currentWindow.lastActivityAt, nextState.updatedAt);
      currentWindow.updatedAt = Math.max(currentWindow.updatedAt, nextState.updatedAt);
    }
  }
  broadcastVsCodeSelectionState(state, deps);
  return true;
}

export function getVsCodeWindowStates(
  state: BrowserTransportStateLike,
  deps: BrowserTransportDeps,
): VsCodeWindowState[] {
  return getActiveVsCodeWindows(state, deps.windowStaleMs)
    .map((window) => cloneVsCodeWindowState(window))
    .sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.sourceId.localeCompare(b.sourceId);
    });
}

export function upsertVsCodeWindowState(
  state: BrowserTransportStateLike,
  nextState: Omit<VsCodeWindowState, "lastSeenAt">,
): VsCodeWindowState {
  const current = state.vscodeWindows.get(nextState.sourceId);
  if (current && nextState.updatedAt < current.updatedAt) {
    return cloneVsCodeWindowState(current);
  }

  const now = Date.now();
  const normalized: VsCodeWindowState = {
    sourceId: nextState.sourceId,
    sourceType: "vscode-window",
    workspaceRoots: [
      ...new Set(
        nextState.workspaceRoots
          .filter((root) => typeof root === "string" && root.trim().length > 0)
          .map((root) => {
            const normalizedRoot = resolve(root).replace(/\\/g, "/");
            return normalizedRoot === "/" ? normalizedRoot : normalizedRoot.replace(/\/+$/, "");
          }),
      ),
    ],
    updatedAt: nextState.updatedAt,
    lastActivityAt: nextState.lastActivityAt,
    lastSeenAt: now,
    ...(nextState.sourceLabel ? { sourceLabel: nextState.sourceLabel } : {}),
  };
  state.vscodeWindows.set(normalized.sourceId, normalized);
  return cloneVsCodeWindowState(normalized);
}

export function touchVsCodeWindow(state: BrowserTransportStateLike, sourceId: string): VsCodeWindowState | null {
  const current = state.vscodeWindows.get(sourceId);
  if (!current) return null;
  current.lastSeenAt = Date.now();
  return cloneVsCodeWindowState(current);
}

export function pollVsCodeOpenFileCommands(
  state: BrowserTransportStateLike,
  sourceId: string,
  limit = 1,
): VsCodeOpenFileCommand[] {
  touchVsCodeWindow(state, sourceId);
  const queue = state.vscodeOpenFileQueues.get(sourceId);
  if (!queue || queue.length === 0) return [];
  return queue.splice(0, Math.max(1, limit)).map((command) => ({
    ...command,
    target: { ...command.target },
  }));
}

export function resolveVsCodeOpenFileResult(
  state: BrowserTransportStateLike,
  sourceId: string,
  commandId: string,
  result: { ok: boolean; error?: string },
): boolean {
  const pending = state.pendingVsCodeOpenResults.get(commandId);
  if (!pending) return false;
  state.pendingVsCodeOpenResults.delete(commandId);
  clearTimeout(pending.timeout);
  touchVsCodeWindow(state, sourceId);
  if (result.ok) {
    pending.resolve();
  } else {
    pending.reject(new Error(result.error?.trim() || "VS Code failed to open the requested file."));
  }
  return true;
}

export async function requestVsCodeOpenFile(
  state: BrowserTransportStateLike,
  target: {
    absolutePath: string;
    line?: number;
    column?: number;
    endLine?: number;
    targetKind?: "file" | "directory";
  },
  deps: BrowserTransportDeps,
  options?: { timeoutMs?: number },
): Promise<{ sourceId: string; commandId: string }> {
  const sourceWindow = selectVsCodeWindowForFile(state, target.absolutePath, deps.windowStaleMs);
  if (!sourceWindow) {
    throw new Error("No running VS Code was detected on this machine.");
  }

  const command: VsCodeOpenFileCommand = {
    commandId: randomUUID(),
    sourceId: sourceWindow.sourceId,
    target: {
      absolutePath: target.absolutePath,
      ...(target.targetKind === "directory"
        ? { targetKind: "directory" as const }
        : {
            line: Math.max(1, target.line ?? 1),
            column: Math.max(1, target.column ?? 1),
            ...(Number.isFinite(target.endLine)
              ? { endLine: Math.max(Math.max(1, target.line ?? 1), Number(target.endLine)) }
              : {}),
          }),
    },
    createdAt: Date.now(),
  };
  let queue = state.vscodeOpenFileQueues.get(sourceWindow.sourceId);
  if (!queue) {
    queue = [];
    state.vscodeOpenFileQueues.set(sourceWindow.sourceId, queue);
  }
  queue.push(command);

  const timeoutMs = options?.timeoutMs ?? deps.openFileTimeoutMs;
  const completion = new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      state.pendingVsCodeOpenResults.delete(command.commandId);
      rejectPromise(new Error("Timed out waiting for VSCode on this machine to open the file."));
    }, timeoutMs);
    state.pendingVsCodeOpenResults.set(command.commandId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
    });
  });

  await completion;
  return {
    sourceId: sourceWindow.sourceId,
    commandId: command.commandId,
  };
}

function shouldAcceptVsCodeSelectionUpdate(current: VsCodeSelectionState | null, next: VsCodeSelectionState): boolean {
  if (!current) return true;
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt > current.updatedAt;
  }
  if (next.sourceId !== current.sourceId) {
    return next.sourceId > current.sourceId;
  }
  return true;
}

function broadcastVsCodeSelectionState(state: BrowserTransportStateLike, deps: BrowserTransportDeps): void {
  const msg: Extract<BrowserIncomingMessage, { type: "vscode_selection_state" }> = {
    type: "vscode_selection_state",
    state: state.vscodeSelectionState,
  };
  for (const session of deps.getSessions()) {
    for (const ws of session.browserSockets) {
      sendToBrowser(ws as BrowserTransportSocketLike, msg);
    }
  }
}

function cloneVsCodeWindowState(window: VsCodeWindowState): VsCodeWindowState {
  return {
    ...window,
    workspaceRoots: [...window.workspaceRoots],
  };
}

function normalizePathForVsCodeMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function getVsCodeWindowRootMatchLength(window: VsCodeWindowState, absolutePath: string): number {
  const normalizedPath = normalizePathForVsCodeMatch(absolutePath);
  let best = -1;
  for (const root of window.workspaceRoots) {
    const normalizedRoot = normalizePathForVsCodeMatch(root);
    if (!normalizedRoot) continue;
    if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
      best = Math.max(best, normalizedRoot.length);
    }
  }
  return best;
}

function getActiveVsCodeWindows(
  state: BrowserTransportStateLike,
  windowStaleMs: number,
  now = Date.now(),
): VsCodeWindowState[] {
  const active: VsCodeWindowState[] = [];
  for (const window of state.vscodeWindows.values()) {
    if (now - window.lastSeenAt <= windowStaleMs) {
      active.push(window);
    }
  }
  return active;
}

function selectVsCodeWindowForFile(
  state: BrowserTransportStateLike,
  absolutePath: string,
  windowStaleMs: number,
): VsCodeWindowState | null {
  const candidates = getActiveVsCodeWindows(state, windowStaleMs);
  if (candidates.length === 0) return null;

  const ranked = candidates.map((window) => ({
    window,
    rootMatchLength: getVsCodeWindowRootMatchLength(window, absolutePath),
  }));

  ranked.sort((a, b) => {
    const aContains = a.rootMatchLength >= 0 ? 1 : 0;
    const bContains = b.rootMatchLength >= 0 ? 1 : 0;
    if (aContains !== bContains) return bContains - aContains;
    if (a.rootMatchLength !== b.rootMatchLength) return b.rootMatchLength - a.rootMatchLength;
    if (a.window.lastActivityAt !== b.window.lastActivityAt) {
      return b.window.lastActivityAt - a.window.lastActivityAt;
    }
    if (a.window.updatedAt !== b.window.updatedAt) {
      return b.window.updatedAt - a.window.updatedAt;
    }
    return a.window.sourceId.localeCompare(b.window.sourceId);
  });

  return ranked[0]?.window ?? null;
}
