import { useStore } from "./store.js";
import { observedThreadMonitorResultId } from "./utils/thread-monitoring.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, McpServerConfig, SdkSessionInfo } from "./types.js";
import { createWsTransport } from "./ws-transport.js";
import { createWsMessageHandler, resolveSessionFilePath } from "./ws-handlers.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT, HISTORY_WINDOW_VISIBLE_SECTION_COUNT } from "../shared/history-window.js";
import { getThreadWindowItemCount } from "../shared/thread-window.js";
import type { WsIncomingMessageContext } from "./ws-message-context.js";
import { resolveInitialLeaderThreadKey } from "./utils/initial-leader-thread.js";
import { getCachedThreadWindowHash } from "./utils/history-window-cache.js";
import { messageIdFromHash, parseHash, resolveSessionIdFromRoute, threadRouteFromHash } from "./utils/routing.js";
import { ALL_THREADS_KEY } from "./utils/thread-projection.js";
import { readLeaderViewportPosition, requestThreadViewportSnapshot } from "./utils/thread-viewport.js";
import {
  SYNCED_PROJECTION_DESCRIPTOR_LIST,
  isSyncedProjectionEligibleForSession,
} from "../shared/synced-projection-registry.js";
import { syncedProjectionEntryId, type SyncedProjectionSubscription } from "../shared/synced-projection.js";
import { announceBackendConnectionOpen } from "./build-compatibility.js";
import {
  projectedLeaderOpenThreadTabs,
  resolveLeaderThreadTabsProjection,
} from "./utils/leader-thread-tabs-resolver.js";

let handleIncomingMessage:
  | ((sessionId: string, data: BrowserIncomingMessage, context: WsIncomingMessageContext) => void)
  | null = null;
let pendingVsCodeSelectionUpdate: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }> | null = null;

function getInitialLeaderThreadWindow(
  sessionId: string,
): Extract<BrowserOutgoingMessage, { type: "session_subscribe" }>["initial_thread_window"] {
  const store = useStore.getState();
  const sdkSession = store.sdkSessions.find((session) => session.sessionId === sessionId);
  const bridgeSession = store.sessions.get(sessionId);
  const leaderTabsProjection = resolveLeaderThreadTabsProjection(store, sessionId);
  const isLeaderSession =
    leaderTabsProjection.projectionState === "accepted" ||
    bridgeSession?.isOrchestrator === true ||
    sdkSession?.isOrchestrator === true;
  if (!isLeaderSession) return undefined;

  const route = typeof window === "undefined" ? null : parseHash(window.location.hash);
  const routeSessionId =
    route?.page === "session" ? resolveSessionIdFromRoute(route.sessionId, store.sdkSessions) : null;
  const routeMatchesSession = routeSessionId === sessionId;
  const threadRoute = routeMatchesSession
    ? threadRouteFromHash(window.location.hash)
    : { hasThreadParam: false, threadKey: null };
  const threadKey = resolveInitialLeaderThreadKey({
    sessionId,
    isLeaderSession,
    hasThreadRoute: threadRoute.hasThreadParam,
    routeThreadKey: threadRoute.threadKey,
    leaderOpenThreadTabs: projectedLeaderOpenThreadTabs(leaderTabsProjection),
  });
  if (threadKey === ALL_THREADS_KEY) return undefined;

  const existingWindow = store.threadWindows.get(sessionId)?.get(threadKey);
  const sectionItemCount = existingWindow?.section_item_count ?? HISTORY_WINDOW_SECTION_TURN_COUNT;
  const visibleItemCount = existingWindow?.visible_item_count ?? HISTORY_WINDOW_VISIBLE_SECTION_COUNT;
  const itemCount = existingWindow?.item_count ?? getThreadWindowItemCount(visibleItemCount, sectionItemCount);
  const savedViewport = readLeaderViewportPosition(sessionId, threadKey);
  const targetMessageId =
    store.scrollToMessageId.get(sessionId) ??
    store.pendingScrollToMessageId.get(sessionId) ??
    (routeMatchesSession ? messageIdFromHash(window.location.hash) : null) ??
    (savedViewport?.isAtBottom ? null : (savedViewport?.anchorMessageId ?? savedViewport?.anchorTurnId ?? null));
  const targetHistoryIndex = store.pendingScrollToMessageIndex.get(sessionId);
  const hasTarget = Boolean(targetMessageId) || typeof targetHistoryIndex === "number";
  const cachedWindowHash =
    existingWindow && !hasTarget
      ? getCachedThreadWindowHash(sessionId, {
          threadKey,
          fromItem: existingWindow.from_item,
          itemCount,
          sectionItemCount,
          visibleItemCount,
        })
      : undefined;

  return {
    thread_key: threadKey,
    from_item: hasTarget ? -1 : (existingWindow?.from_item ?? -1),
    item_count: itemCount,
    section_item_count: sectionItemCount,
    visible_item_count: visibleItemCount,
    ...(cachedWindowHash ? { cached_window_hash: cachedWindowHash } : {}),
    ...(targetMessageId ? { target_message_id: targetMessageId } : {}),
    ...(typeof targetHistoryIndex === "number" ? { target_history_index: targetHistoryIndex } : {}),
  };
}

function getSyncedProjectionSubscriptions(sessionId: string): SyncedProjectionSubscription[] | undefined {
  const store = useStore.getState();
  if (store.currentSessionId !== sessionId) return undefined;

  const subscriptions: SyncedProjectionSubscription[] = [];
  const seen = new Set<string>();
  for (const sdkSession of store.sdkSessions) {
    if (sdkSession.archived || seen.has(sdkSession.sessionId)) continue;
    seen.add(sdkSession.sessionId);
    const isOrchestrator =
      sdkSession.isOrchestrator === true || store.sessions.get(sdkSession.sessionId)?.isOrchestrator === true;
    for (const descriptor of SYNCED_PROJECTION_DESCRIPTOR_LIST) {
      const entryId = syncedProjectionEntryId(descriptor.projection, sdkSession.sessionId);
      const hasObservedProjection =
        store.syncedProjectionKeys.has(entryId) || Object.hasOwn(sdkSession, descriptor.restField);
      if (!isSyncedProjectionEligibleForSession(descriptor, { isOrchestrator }) && !hasObservedProjection) continue;
      subscriptions.push({ projection: descriptor.projection, key: sdkSession.sessionId });
    }
  }
  subscriptions.sort(
    (left, right) => left.projection.localeCompare(right.projection) || left.key.localeCompare(right.key),
  );
  return subscriptions;
}

function getInitialHistoryWindowTarget(sessionId: string): {
  targetMessageId?: string;
  targetHistoryIndex?: number;
} {
  const store = useStore.getState();
  const threadWindow = getInitialLeaderThreadWindow(sessionId);
  if (threadWindow?.target_message_id || typeof threadWindow?.target_history_index === "number") return {};
  const route = typeof window === "undefined" ? null : parseHash(window.location.hash);
  const routeSessionId =
    route?.page === "session" ? resolveSessionIdFromRoute(route.sessionId, store.sdkSessions) : null;
  const routeTarget = routeSessionId === sessionId ? messageIdFromHash(window.location.hash) : null;
  const targetMessageId =
    store.pendingScrollToMessageId.get(sessionId) ?? store.scrollToTurnId.get(sessionId) ?? routeTarget ?? undefined;
  const targetHistoryIndex = store.pendingScrollToMessageIndex.get(sessionId);
  return {
    ...(targetMessageId ? { targetMessageId } : {}),
    ...(typeof targetHistoryIndex === "number" ? { targetHistoryIndex } : {}),
  };
}

const transport = createWsTransport({
  hasLocalMessages: (sessionId) => {
    const store = useStore.getState();
    const messages = store.messages.get(sessionId);
    const historyWindow = store.historyWindows.get(sessionId);
    return Boolean(messages && messages.length > 0 && !historyWindow);
  },
  getKnownFrozenCount: (sessionId) => {
    return useStore.getState().messageFrozenCounts.get(sessionId) ?? 0;
  },
  getKnownFrozenHash: (sessionId) => {
    return useStore.getState().messageFrozenHashes.get(sessionId);
  },
  getFreshHistoryWindow: (sessionId) => {
    const target = getInitialHistoryWindowTarget(sessionId);
    return {
      sectionTurnCount: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visibleSectionCount: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      ...target,
    };
  },
  getInitialThreadWindow: getInitialLeaderThreadWindow,
  getSyncedProjectionSubscriptions,
  onConnecting: (sessionId) => {
    const store = useStore.getState();
    const initialThreadWindow = getInitialLeaderThreadWindow(sessionId);
    store.setPendingThreadWindowRequest(
      sessionId,
      initialThreadWindow && !store.threadWindows.get(sessionId)?.has(initialThreadWindow.thread_key)
        ? initialThreadWindow.thread_key
        : null,
    );
    store.setConnectionStatus(sessionId, "connecting");
  },
  onConnected: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "connected");
    announceBackendConnectionOpen();
    if (pendingVsCodeSelectionUpdate) {
      const delivered = transport.sendGlobalMessage(pendingVsCodeSelectionUpdate, sessionId);
      if (delivered) {
        pendingVsCodeSelectionUpdate = null;
      }
    }
  },
  onDisconnected: (sessionId) => {
    void requestThreadViewportSnapshot(sessionId);
    const store = useStore.getState();
    store.setPendingThreadWindowRequest(sessionId, null);
    store.setConnectionStatus(sessionId, "disconnected");
  },
  shouldReconnect: (sessionId) => {
    const store = useStore.getState();
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    return Boolean(sdkSession && !sdkSession.archived);
  },
  onMessage: (sessionId, data, context) => {
    handleIncomingMessage?.(sessionId, data, context);
  },
});

handleIncomingMessage = createWsMessageHandler({
  disconnectSession: (sessionId) => {
    transport.disconnectSession(sessionId);
  },
  sendToSession: (sessionId, msg) => transport.sendToSession(sessionId, msg),
  requestSyncedProjectionResync: (carrierSessionId, projection, key) =>
    transport.requestSyncedProjectionResync(carrierSessionId, projection, key),
  hasPendingSyncedProjectionResync: (carrierSessionId, projection, key) =>
    transport.hasPendingSyncedProjectionResync(carrierSessionId, projection, key),
  resolveSyncedProjectionResync: (carrierSessionId, projection, key) =>
    transport.resolveSyncedProjectionResync(carrierSessionId, projection, key),
  noteAcceptedSyncedProjectionSnapshot: (carrierSessionId, projection, key) =>
    transport.noteAcceptedSyncedProjectionSnapshot(carrierSessionId, projection, key),
  consumeSyncedProjectionSubscriptionsAck: (carrierSessionId, subscriptions) =>
    transport.consumeSyncedProjectionSubscriptionsAck(carrierSessionId, subscriptions),
});

export { resolveSessionFilePath };

export function connectSession(sessionId: string) {
  const store = useStore.getState();
  const existingMessages = store.messages.get(sessionId);
  if ((!existingMessages || existingMessages.length === 0) && !store.historyDelivered.has(sessionId)) {
    store.setHistoryLoading(sessionId, true);
  }
  transport.connectSession(sessionId);
}

export function disconnectSession(sessionId: string) {
  transport.disconnectSession(sessionId);
}

export function disconnectAll() {
  transport.disconnectAll();
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  transport.connectAllSessions(sessions);
}

export function waitForConnection(sessionId: string): Promise<void> {
  return transport.waitForConnection(sessionId);
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage): boolean {
  if (msg.type === "user_message" && !msg.agentSource) {
    msg = { ...msg, threadMonitorResultId: observedThreadMonitorResultId(sessionId, msg.threadKey ?? msg.questId) };
  }
  return transport.sendToSession(sessionId, msg);
}

export function requestFullHistorySync(sessionId: string): boolean {
  return transport.requestFullHistorySync(sessionId);
}

export function refreshSyncedProjectionSubscriptions(sessionId?: string | null): boolean {
  const carrierSessionId = sessionId ?? useStore.getState().currentSessionId;
  if (!carrierSessionId) return false;
  return transport.refreshSyncedProjectionSubscriptions(carrierSessionId);
}

export function sendVsCodeSelectionUpdate(
  update: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }>,
): boolean {
  const preferredSessionId = useStore.getState().currentSessionId;
  const delivered = transport.sendGlobalMessage(update, preferredSessionId);
  if (!delivered) {
    pendingVsCodeSelectionUpdate = update;
  }
  return delivered;
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}

const FORCE_RECONNECT_AFTER_HIDDEN_MS = 60_000;

function ensureActiveSessionConnection(options?: { forceReconnect?: boolean }) {
  const store = useStore.getState();
  const currentSessionId = store.currentSessionId;
  if (!currentSessionId) return;

  const sdkSession = store.sdkSessions.find((s) => s.sessionId === currentSessionId);
  if (!sdkSession || sdkSession.archived) return;

  const socketState = transport.getSocketState(currentSessionId);
  if (options?.forceReconnect) {
    void requestThreadViewportSnapshot(currentSessionId);
    transport.reconnectSession(currentSessionId);
    return;
  }

  if (socketState === WebSocket.OPEN || socketState === WebSocket.CONNECTING) {
    return;
  }

  connectSession(currentSessionId);
}

// ── Page visibility/mobile resume: recover from background-stale sockets ──
if (typeof document !== "undefined" && typeof window !== "undefined") {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      void requestThreadViewportSnapshot(useStore.getState().currentSessionId, {
        publishHandoff: true,
        keepalive: true,
        reason: "background",
      });
      return;
    }

    const hiddenDuration = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    ensureActiveSessionConnection({
      forceReconnect: hiddenDuration >= FORCE_RECONNECT_AFTER_HIDDEN_MS,
    });
  });

  window.addEventListener("pageshow", (event) => {
    const persisted = "persisted" in event && event.persisted === true;
    ensureActiveSessionConnection({ forceReconnect: persisted });
  });

  window.addEventListener("pagehide", () => {
    void requestThreadViewportSnapshot(useStore.getState().currentSessionId, {
      publishHandoff: true,
      keepalive: true,
      reason: "pagehide",
    });
  });

  window.addEventListener("online", () => {
    ensureActiveSessionConnection({ forceReconnect: true });
  });
}

// ── Page unload: close all WebSockets so the browser tears down TCP connections ──
// Without this, Safari reuses stale keep-alive connections after a dev server
// restart, causing the reloaded page to hang indefinitely. Closing WebSockets
// on beforeunload forces Safari to open fresh TCP connections on the next load.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    void requestThreadViewportSnapshot(useStore.getState().currentSessionId, {
      publishHandoff: true,
      keepalive: true,
      reason: "unload",
    });
    transport.closeAllForUnload();
  });
}
