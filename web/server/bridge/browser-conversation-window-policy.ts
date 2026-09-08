import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { MAIN_THREAD_KEY, normalizeSelectedFeedThreadKey } from "../../shared/thread-window.js";
import { isQuestThreadKey } from "../../shared/thread-routing.js";
import type {
  ActiveTurnRoute,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BufferedBrowserEvent,
  InitialThreadWindowRequest,
  ReplayableBrowserIncomingMessage,
} from "../session-types.js";
import { findTurnBoundaries } from "../takode-messages.js";
import { isRootAgentHistoryMessage } from "../root-agent-feed-message.js";
import { routeFromHistoryEntry } from "../thread-routing-metadata.js";

export interface BoundedHistoryViewRequest {
  fromTurn: number;
  turnCount: number;
  sectionTurnCount: number;
  visibleSectionCount: number;
  cachedWindowHash?: string;
  targetMessageId?: string;
  targetHistoryIndex?: number;
}

export interface BoundedThreadViewRequest {
  threadKey: string;
  fromItem: number;
  itemCount: number;
  sectionItemCount: number;
  visibleItemCount: number;
  cachedWindowHash?: string;
  targetMessageId?: string;
  targetHistoryIndex?: number;
}

export type BoundedConversationView =
  | { kind: "history"; request: BoundedHistoryViewRequest }
  | { kind: "thread"; request: BoundedThreadViewRequest };

export interface BrowserConversationWindowSocketData {
  conversationView?: BoundedConversationView;
}

export function hasConnectedCurrentBuildBrowserViewingThread(
  sockets: Iterable<{ data?: unknown; readyState?: number }>,
  sourceThreadKey: string,
): boolean {
  const normalizedSource = normalizeSelectedFeedThreadKey(sourceThreadKey);
  if (normalizedSource !== MAIN_THREAD_KEY && !isQuestThreadKey(normalizedSource)) return false;
  for (const socket of sockets) {
    if (socket.readyState !== undefined && socket.readyState !== 1) continue;
    const data = socket.data as BrowserConversationWindowSocketData | undefined;
    const view = data?.conversationView;
    if (view?.kind !== "thread") continue;
    if (normalizeSelectedFeedThreadKey(view.request.threadKey) === normalizedSource) return true;
  }
  return false;
}

interface ConversationWindowSessionLike {
  messageHistory: BrowserIncomingMessage[];
  activeTurnRoute?: ActiveTurnRoute | null;
}

export function prepareBoundedConversationSubscribe(input: {
  session: ConversationWindowSessionLike & { eventBuffer: BufferedBrowserEvent[]; nextEventSeq: number };
  socketData: BrowserConversationWindowSocketData;
  initialThreadWindow: InitialThreadWindowRequest | null;
  historyWindowSectionTurnCount: number | undefined;
  historyWindowVisibleSectionCount: number | undefined;
  historyWindowTargetMessageId: string | undefined;
  historyWindowTargetIndex: number | undefined;
  lastAckSeq: number;
  running: boolean;
  isHistoryBackedEvent: (message: ReplayableBrowserIncomingMessage) => boolean;
}): {
  boundedView: BoundedConversationView | null;
  syncThroughSeq: number;
  replayEvents: BufferedBrowserEvent[];
} {
  const hasHistoryWindow =
    typeof input.historyWindowSectionTurnCount === "number" &&
    input.historyWindowSectionTurnCount > 0 &&
    typeof input.historyWindowVisibleSectionCount === "number" &&
    input.historyWindowVisibleSectionCount > 0;
  const turnCount = hasHistoryWindow
    ? getHistoryWindowTurnCount(input.historyWindowVisibleSectionCount!, input.historyWindowSectionTurnCount!)
    : 0;
  const historyView = hasHistoryWindow
    ? {
        fromTurn: Math.max(
          0,
          findTurnBoundaries(input.session.messageHistory, isRootAgentHistoryMessage).length - turnCount,
        ),
        turnCount,
        sectionTurnCount: input.historyWindowSectionTurnCount!,
        visibleSectionCount: input.historyWindowVisibleSectionCount!,
        targetMessageId: input.historyWindowTargetMessageId,
        targetHistoryIndex: input.historyWindowTargetIndex,
      }
    : null;
  const boundedView = configureBoundedConversationSubscribe({
    socketData: input.socketData,
    initialThreadWindow: input.initialThreadWindow,
    historyWindow: historyView,
  });
  const syncThroughSeq = Math.max(0, input.session.nextEventSeq - 1);
  const shouldReplay =
    (input.lastAckSeq === 0 && input.running) || (input.lastAckSeq > 0 && input.lastAckSeq < syncThroughSeq);
  const replayEvents =
    boundedView && shouldReplay
      ? filterCompletedStreamReplay(input.session.eventBuffer, syncThroughSeq).filter((event) => {
          if (input.lastAckSeq > 0 && event.seq <= input.lastAckSeq) return false;
          if (input.isHistoryBackedEvent(event.message as ReplayableBrowserIncomingMessage)) return false;
          return shouldDeliverBrowserEventToSocket(input.session, event.message, input.socketData);
        })
      : [];
  return { boundedView, syncThroughSeq, replayEvents };
}

function filterCompletedStreamReplay(events: BufferedBrowserEvent[], throughSeq: number): BufferedBrowserEvent[] {
  const completedTextScopes = new Set<string>();
  const completedThinkingScopes = new Set<string>();
  const completedOwners = new Set<string>();
  const retained: BufferedBrowserEvent[] = [];

  // Snapshot hydration replaces completed history without running the live
  // assistant/result handlers that clear its stream. Mirror those clears in
  // replay selection, using event order and ownership, never IDs or prose.
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.seq > throughSeq) continue;
    const message = event.message;
    if (message.type !== "assistant" && message.type !== "stream_event" && message.type !== "result") {
      retained.push(event);
      continue;
    }
    const owner = JSON.stringify([
      message.codexSubagent?.childId ?? null,
      message.codexSubagent?.parentChildId ?? null,
      message.codexSubagent?.rootTurnId ?? null,
    ]);
    if (message.type === "result") {
      // A root result also clears legacy parent-keyed streams; native
      // children keep their separate completion authority.
      completedOwners.add(owner);
      retained.push(event);
      continue;
    }
    const scope = JSON.stringify([owner, message.parent_tool_use_id ?? null]);
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (
        Array.isArray(content) &&
        content.every((block) => block && typeof block === "object" && typeof block.type === "string")
      ) {
        completedTextScopes.add(scope);
        if (content.some((block) => block.type === "thinking")) completedThinkingScopes.add(scope);
      }
      retained.push(event);
      continue;
    }
    const payload = message.event as {
      type?: string;
      delta?: { type?: string };
      content_block?: { type?: string };
    };
    if (payload?.type === "message_stop") {
      completedTextScopes.add(scope);
      completedThinkingScopes.add(scope);
      retained.push(event);
      continue;
    }
    const kind =
      payload?.type === "content_block_delta"
        ? payload.delta?.type
        : payload?.type === "content_block_start"
          ? payload.content_block?.type
          : undefined;
    const text = kind === "text" || kind === "text_delta";
    const thinking = kind === "thinking" || kind === "thinking_delta";
    if (
      ((text || thinking) && completedOwners.has(owner)) ||
      (text && completedTextScopes.has(scope)) ||
      (thinking && completedThinkingScopes.has(scope))
    ) {
      continue;
    }
    retained.push(event);
  }
  return retained.reverse();
}

export function normalizeInitialThreadWindowRequest(
  request: InitialThreadWindowRequest | undefined,
  leaderSession: boolean,
): InitialThreadWindowRequest | null {
  if (!request || !leaderSession) return null;
  const threadKey = normalizeSelectedFeedThreadKey(request.thread_key);
  if (threadKey !== MAIN_THREAD_KEY && !isQuestThreadKey(threadKey)) return null;
  if (
    !Number.isFinite(request.from_item) ||
    !Number.isFinite(request.item_count) ||
    request.item_count <= 0 ||
    !Number.isFinite(request.section_item_count) ||
    request.section_item_count <= 0 ||
    !Number.isFinite(request.visible_item_count) ||
    request.visible_item_count <= 0
  ) {
    return null;
  }
  const targetMessageId = request.target_message_id?.trim();
  const targetHistoryIndex =
    typeof request.target_history_index === "number" && Number.isFinite(request.target_history_index)
      ? Math.max(0, Math.floor(request.target_history_index))
      : undefined;
  const cachedWindowHash = request.cached_window_hash?.trim();
  return {
    thread_key: threadKey,
    from_item: request.from_item < 0 ? -1 : Math.floor(request.from_item),
    item_count: Math.max(1, Math.floor(request.item_count)),
    section_item_count: Math.max(1, Math.floor(request.section_item_count)),
    visible_item_count: Math.max(1, Math.floor(request.visible_item_count)),
    ...(cachedWindowHash && !targetMessageId && targetHistoryIndex === undefined
      ? { cached_window_hash: cachedWindowHash }
      : {}),
    ...(targetMessageId ? { target_message_id: targetMessageId } : {}),
    ...(targetHistoryIndex === undefined ? {} : { target_history_index: targetHistoryIndex }),
  };
}

export function configureBoundedConversationSubscribe(input: {
  socketData: BrowserConversationWindowSocketData;
  initialThreadWindow: InitialThreadWindowRequest | null;
  historyWindow: BoundedHistoryViewRequest | null;
}): BoundedConversationView | null {
  const view = input.initialThreadWindow
    ? threadViewFromInitialRequest(input.initialThreadWindow)
    : input.historyWindow
      ? ({ kind: "history", request: input.historyWindow } as const)
      : null;
  if (!view) {
    delete input.socketData.conversationView;
    return null;
  }
  input.socketData.conversationView = view;
  return view;
}

export function setBoundedHistoryView(
  socketData: BrowserConversationWindowSocketData,
  request: BoundedHistoryViewRequest,
): void {
  if (!socketData.conversationView) return;
  socketData.conversationView = { kind: "history", request };
}

export function setBoundedThreadView(
  socketData: BrowserConversationWindowSocketData,
  request: BoundedThreadViewRequest,
): void {
  if (!socketData.conversationView) return;
  socketData.conversationView = {
    kind: "thread",
    request: { ...request, threadKey: normalizeSelectedFeedThreadKey(request.threadKey) },
  };
}

export function recordBoundedConversationRequest(
  socketData: BrowserConversationWindowSocketData,
  request: Extract<BrowserOutgoingMessage, { type: "history_window_request" | "thread_window_request" }>,
): void {
  if (!request.activate_view) return;
  if (request.type === "history_window_request") {
    setBoundedHistoryView(socketData, {
      fromTurn: request.from_turn,
      turnCount: request.turn_count,
      sectionTurnCount: request.section_turn_count,
      visibleSectionCount: request.visible_section_count,
      cachedWindowHash: request.cached_window_hash,
      targetMessageId: request.target_message_id,
      targetHistoryIndex: request.target_history_index,
    });
    return;
  }
  setBoundedThreadView(socketData, {
    threadKey: request.thread_key,
    fromItem: request.from_item,
    itemCount: request.item_count,
    sectionItemCount: request.section_item_count,
    visibleItemCount: request.visible_item_count,
    cachedWindowHash: request.cached_window_hash,
    targetMessageId: request.target_message_id,
  });
}

export function recordBoundedConversationViewUpdate(
  socketData: BrowserConversationWindowSocketData,
  update: Extract<BrowserOutgoingMessage, { type: "conversation_view_update" }>,
): void {
  if (!socketData.conversationView) return;
  if (!validPositiveWindow(update.from, update.count, update.section_count, update.visible_count)) return;
  const threadKey = normalizeSelectedFeedThreadKey(update.thread_key ?? MAIN_THREAD_KEY);
  if (update.view === "thread" && threadKey !== MAIN_THREAD_KEY && !isQuestThreadKey(threadKey)) return;
  if (update.view === "history") {
    setBoundedHistoryView(socketData, {
      fromTurn: update.from,
      turnCount: update.count,
      sectionTurnCount: update.section_count,
      visibleSectionCount: update.visible_count,
      cachedWindowHash: update.cached_window_hash,
    });
    return;
  }
  setBoundedThreadView(socketData, {
    threadKey,
    fromItem: update.from,
    itemCount: update.count,
    sectionItemCount: update.section_count,
    visibleItemCount: update.visible_count,
    cachedWindowHash: update.cached_window_hash,
  });
}

function validPositiveWindow(from: number, count: number, sectionCount: number, visibleCount: number): boolean {
  return (
    Number.isFinite(from) &&
    Number.isFinite(count) &&
    count > 0 &&
    Number.isFinite(sectionCount) &&
    sectionCount > 0 &&
    Number.isFinite(visibleCount) &&
    visibleCount > 0
  );
}

export function boundedConversationSyncComplete(
  socketData: BrowserConversationWindowSocketData,
  throughSeq: number,
): Extract<BrowserIncomingMessage, { type: "conversation_sync_complete" }> | null {
  return socketData.conversationView
    ? { type: "conversation_sync_complete", through_seq: Math.max(0, Math.floor(throughSeq)) }
    : null;
}

export function shouldDeliverBrowserEventToSocket(
  session: ConversationWindowSessionLike,
  message: BrowserIncomingMessage,
  socketData: BrowserConversationWindowSocketData,
): boolean {
  if (message.type === "history_sync") return false;
  if (!isConversationScopedMessage(message)) return true;

  const view = socketData.conversationView;
  if (!view) return false;
  if (view.kind === "history") return true;
  const selectedThreadKey = normalizeSelectedFeedThreadKey(view.request.threadKey);
  const routeKeys = conversationRouteKeys(session, message);
  if (selectedThreadKey === MAIN_THREAD_KEY) return routeKeys.size === 0 || routeKeys.has(MAIN_THREAD_KEY);
  return routeKeys.has(selectedThreadKey);
}

function threadViewFromInitialRequest(request: InitialThreadWindowRequest): BoundedConversationView {
  return {
    kind: "thread",
    request: {
      threadKey: normalizeSelectedFeedThreadKey(request.thread_key),
      fromItem: request.from_item,
      itemCount: request.item_count,
      sectionItemCount: request.section_item_count,
      visibleItemCount: request.visible_item_count,
      cachedWindowHash: request.cached_window_hash,
      targetMessageId: request.target_message_id,
      targetHistoryIndex: request.target_history_index,
    },
  };
}

function isConversationScopedMessage(message: BrowserIncomingMessage): boolean {
  return (
    message.type === "assistant" ||
    message.type === "user_message" ||
    message.type === "leader_user_message" ||
    message.type === "stream_event" ||
    message.type === "tool_progress" ||
    message.type === "tool_use_summary" ||
    message.type === "tool_result_preview" ||
    message.type === "result" ||
    message.type === "task_notification" ||
    message.type === "codex_auto_pause_recovery_summary" ||
    message.type === "quest_lifecycle_event" ||
    message.type === "thread_attachment_marker" ||
    message.type === "thread_transition_marker" ||
    message.type === "cross_thread_activity_marker"
  );
}

function conversationRouteKeys(session: ConversationWindowSessionLike, message: BrowserIncomingMessage): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    keys.add(normalizeSelectedFeedThreadKey(value));
  };
  const threaded = message as BrowserIncomingMessage & {
    threadKey?: string;
    questId?: string;
    threadRefs?: Array<{ threadKey: string; questId?: string }>;
  };
  add(threaded.threadKey);
  add(threaded.questId);
  for (const ref of threaded.threadRefs ?? []) {
    add(ref.threadKey);
    add(ref.questId);
  }
  const directRoute = routeFromHistoryEntry(threaded);
  add(directRoute?.threadKey);
  add(directRoute?.questId);

  if (keys.size === 0 && usesActiveTurnRoute(message)) {
    add(session.activeTurnRoute?.threadKey);
    add(session.activeTurnRoute?.questId);
  }
  if (keys.size === 0 && message.type === "tool_result_preview") {
    for (const routeKey of recentToolPreviewRouteKeys(session.messageHistory, message)) keys.add(routeKey);
  }
  if (keys.size === 0 && message.type === "result") {
    for (const routeKey of recentTurnRouteKeys(session.messageHistory)) keys.add(routeKey);
  }
  if (keys.size === 0) keys.add(MAIN_THREAD_KEY);
  return keys;
}

function recentTurnRouteKeys(history: BrowserIncomingMessage[]): Set<string> {
  const routes = new Set<string>();
  for (let index = history.length - 1; index >= 0; index--) {
    const candidate = history[index];
    if (!candidate || candidate.type === "result") continue;
    const route = routeFromHistoryEntry(candidate);
    if (route) routes.add(normalizeSelectedFeedThreadKey(route.threadKey));
    if (candidate.type === "user_message") break;
  }
  return routes;
}

function usesActiveTurnRoute(message: BrowserIncomingMessage): boolean {
  return (
    message.type === "stream_event" ||
    message.type === "tool_progress" ||
    message.type === "tool_use_summary" ||
    message.type === "tool_result_preview" ||
    message.type === "result" ||
    message.type === "assistant"
  );
}

function recentToolPreviewRouteKeys(
  history: BrowserIncomingMessage[],
  previewMessage: Extract<BrowserIncomingMessage, { type: "tool_result_preview" }>,
): Set<string> {
  const pendingIds = new Set(previewMessage.previews.map((preview) => preview.tool_use_id));
  const routes = new Set<string>();
  const start = Math.max(0, history.length - 512);
  for (let index = history.length - 1; index >= start && pendingIds.size > 0; index--) {
    const candidate = history[index];
    if (candidate?.type !== "assistant") continue;
    const matchingIds = candidate.message.content.flatMap((block) =>
      block.type === "tool_use" && pendingIds.has(block.id) ? [block.id] : [],
    );
    if (matchingIds.length === 0) continue;
    matchingIds.forEach((toolUseId) => pendingIds.delete(toolUseId));
    const route = routeFromHistoryEntry(candidate);
    routes.add(normalizeSelectedFeedThreadKey(route?.threadKey ?? MAIN_THREAD_KEY));
  }
  return routes;
}
