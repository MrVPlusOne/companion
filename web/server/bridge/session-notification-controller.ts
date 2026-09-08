import type {
  BoardRow,
  BrowserIncomingMessage,
  NeedsInputNotificationQuestion,
  SessionNotification,
} from "../session-types.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import {
  applyLeaderServerCandidateThreadTabEvent,
  canServerCandidateOpenThread,
  normalizeLeaderOpenThreadTabsState,
  normalizeLeaderThreadKey,
  shouldPersistLeaderThreadTab,
} from "../../shared/leader-open-thread-tabs.js";
import {
  type ThreadRouteMetadata,
  normalizeThreadRoute,
  resolveConsistentNotificationThreadRoute,
  routeFromHistoryEntry,
  sameThreadRoute,
  withThreadRoute,
} from "../thread-routing-metadata.js";
import {
  isNeverStartedScheduledLeaderThreadTabRow,
  isScheduledLeaderThreadTabStatus,
  type LeaderThreadTabMutationPolicy,
} from "../../shared/leader-thread-tab-priority.js";
import { THREAD_OUTCOME_REMINDER_SOURCE_ID } from "../../shared/thread-outcome-reminder.js";

type SessionLike = any;

export type AttentionReason = "action" | "error" | "review";
export type NotificationUrgency = "needs-input" | "review" | null;

export interface NotificationStatusSnapshot {
  notificationUrgency: NotificationUrgency;
  activeNotificationCount: number;
  activeNeedsInputNotificationCount: number;
  activeReviewNotificationCount: number;
  mutedNeedsInputNotificationCount: number;
  notificationStatusVersion: number;
  notificationStatusUpdatedAt: number;
}

type BrowserNotificationDeps = {
  broadcastToBrowsers?: (session: SessionLike, msg: BrowserIncomingMessage) => void;
};

type PersistNotificationDeps = BrowserNotificationDeps & {
  persistSession: (session: SessionLike) => void;
  promoteLeaderThreadTabForAttention?: (
    sessionId: string,
    threadKey: string,
    eventAt: number,
    kind: "primary" | "review",
  ) => boolean;
};

type NotifyUserDeps = PersistNotificationDeps & {
  getLeaderThreadTabMutationPolicy?: (sessionId: string, threadKey: string) => LeaderThreadTabMutationPolicy | null;
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => any;
  emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean; notificationId?: string },
  ) => void;
};

type NotifyUserOptions = {
  suggestedAnswers?: string[];
  questions?: NeedsInputNotificationQuestion[];
  threadRoute?: ThreadRouteMetadata;
  suppressThreadTabPromotion?: boolean;
};

type NotifyUserResult = {
  ok: true;
  anchoredMessageId: string | null;
  notificationId: string;
  reused?: boolean;
};

type NotificationDoneDeps = PersistNotificationDeps & {
  broadcastBoard?: (session: SessionLike, board: BoardRow[], completedBoard: BoardRow[]) => void;
  cancelScheduledNotification?: (sessionId: string, notificationId: string) => void;
};

type ResolutionNoticeMode = "pending" | "delivered";

type NotificationDoneOptions = {
  resolutionNotice?: ResolutionNoticeMode;
  resolutionNoticeSource?: "manual" | "response";
  suppressScheduledNotificationCancel?: boolean;
};

type NotificationMuteDeps = PersistNotificationDeps & {
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
};

type ThreadReadyUnreadDeps = PersistNotificationDeps & {
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
};

type ClearAttentionAndMarkReadOptions = {
  mode?: "all" | "session-view";
};

const EXACT_NEEDS_INPUT_RETRY_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export function setAttention(
  session: SessionLike,
  reason: AttentionReason,
  deps: PersistNotificationDeps & { isHerdedWorkerSession?: (session: SessionLike) => boolean },
  options?: { allowHerdedWorker?: boolean },
): void {
  if (deps.isHerdedWorkerSession?.(session) && !options?.allowHerdedWorker) return;
  const current = session.attentionReason as AttentionReason | null;
  const pri = { action: 3, error: 2, review: 1 } as const;
  if (current && pri[current] >= pri[reason]) return;
  session.attentionReason = reason;
  deps.persistSession(session);
}

export function clearAttentionAndMarkRead(
  session: SessionLike,
  deps: PersistNotificationDeps,
  options: ClearAttentionAndMarkReadOptions = {},
): void {
  const unreadReviewNotifications = getUserVisibleSessionNotifications(session).filter(
    (notification) => notification.category === "review" && !notification.done,
  );
  const hasThreadScopedReviewNotifications =
    options.mode === "session-view" && unreadReviewNotifications.some(isThreadScopedReviewNotification);
  const shouldAdvanceReadTimestamp = !hasThreadScopedReviewNotifications;
  const hadUnreadReviewNotifications = shouldAdvanceReadTimestamp && unreadReviewNotifications.length > 0;
  const hadManualUnread = session.manualUnread === true;
  if (session.attentionReason === null && !hadUnreadReviewNotifications && !hadManualUnread) return;
  session.manualUnread = false;
  session.attentionReason = null;
  if (shouldAdvanceReadTimestamp) {
    session.lastReadAt = Date.now();
  }
  if (hadUnreadReviewNotifications) {
    touchNotificationStatus(session);
    deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  }
  deps.persistSession(session);
}

export function normalizeStatusNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function deriveNotificationStatusUpdatedAt(
  notifications: ReadonlyArray<Pick<SessionNotification, "timestamp">>,
): number {
  let latest = 0;
  for (const notification of notifications) {
    if (Number.isFinite(notification.timestamp) && notification.timestamp > latest) latest = notification.timestamp;
  }
  return latest;
}

function touchNotificationStatus(session: SessionLike): void {
  session.notificationStatusVersion = normalizeStatusNumber(session.notificationStatusVersion, 0) + 1;
  session.notificationStatusUpdatedAt = Date.now();
}

function isActionableSessionNotification(notification: Pick<SessionNotification, "category">): boolean {
  return notification.category === "needs-input" || notification.category === "review";
}

function isReadReviewNotification(session: SessionLike, notification: SessionNotification): boolean {
  if (notification.category !== "review") return false;
  const timestamp = Number(notification.timestamp ?? 0);
  const lastReadAt = normalizeStatusNumber(session.lastReadAt, 0);
  return timestamp > 0 && lastReadAt >= timestamp;
}

function isThreadScopedReviewNotification(notification: SessionNotification): boolean {
  if (notification.category !== "review") return false;
  const route = normalizeThreadRoute(notification.threadKey, notification.questId);
  return route !== null && route.threadKey !== "main";
}

function scheduledBoardRowForThread(session: SessionLike, threadKey: string): BoardRow | undefined {
  const normalizedThreadKey = normalizeLeaderThreadKey(threadKey);
  const board = session.board;
  const rows: Iterable<BoardRow> = board instanceof Map ? board.values() : Array.isArray(board) ? board : [];
  for (const row of rows) {
    if (normalizeLeaderThreadKey(row.questId) !== normalizedThreadKey) continue;
    return isScheduledLeaderThreadTabStatus(row.status) ? row : undefined;
  }
  return undefined;
}

function openLeaderReviewThreadKeys(session: SessionLike): Set<string> | null {
  if (session.state?.isOrchestrator !== true) return null;
  const openTabs = normalizeLeaderOpenThreadTabsState(session.state?.leaderOpenThreadTabs);
  if (!openTabs) return null;
  const keys = new Set(["main", ...openTabs.orderedOpenThreadKeys]);

  // Active board rows are server-owned visual tab candidates even for restored
  // sessions whose durable open-tab state predates server-side surfacing. Keep
  // their review notifications discoverable while still honoring a newer close.
  const board = session.board;
  const rows: Iterable<BoardRow> = board instanceof Map ? board.values() : Array.isArray(board) ? board : [];
  for (const row of rows) {
    if (!row || row.completedAt !== undefined || !shouldPersistLeaderThreadTab(row.questId)) continue;
    const eventAt = row.threadTabActivatedAt ?? row.createdAt;
    if (
      !canServerCandidateOpenThread(openTabs, row.questId, eventAt, {
        allowTombstoneReopen: !isScheduledLeaderThreadTabStatus(row.status),
      })
    ) {
      continue;
    }
    keys.add(normalizeLeaderThreadKey(row.questId));
  }
  return keys;
}

function isDiscoverableLeaderReviewNotification(
  notification: SessionNotification,
  openThreadKeys: Set<string> | null,
): boolean {
  if (notification.category !== "review" || notification.done || !openThreadKeys) return true;
  const route = normalizeThreadRoute(notification.threadKey, notification.questId);
  return openThreadKeys.has(route?.threadKey ?? "main");
}

export function getUserVisibleSessionNotifications(session: SessionLike): SessionNotification[] {
  const openThreadKeys = openLeaderReviewThreadKeys(session);
  return (session.notifications ?? []).filter(
    (notification: SessionNotification) =>
      isActionableSessionNotification(notification) &&
      !isReadReviewNotification(session, notification) &&
      isDiscoverableLeaderReviewNotification(notification, openThreadKeys),
  );
}

export function getNotificationStatusSnapshot(session: SessionLike): NotificationStatusSnapshot {
  let activeNotificationCount = 0;
  let activeNeedsInputNotificationCount = 0;
  let activeReviewNotificationCount = 0;
  let mutedNeedsInputNotificationCount = 0;
  let hasNeedsInput = false;
  let hasReview = false;
  const notifications = getUserVisibleSessionNotifications(session);
  for (const notification of notifications) {
    if (notification.done) continue;
    activeNotificationCount += 1;
    if (notification.category === "needs-input") {
      if (notification.muted) {
        mutedNeedsInputNotificationCount += 1;
        activeNotificationCount -= 1;
        continue;
      }
      hasNeedsInput = true;
      activeNeedsInputNotificationCount += 1;
    }
    if (notification.category === "review") {
      hasReview = true;
      activeReviewNotificationCount += 1;
    }
  }
  return {
    notificationUrgency: hasNeedsInput ? "needs-input" : hasReview ? "review" : null,
    activeNotificationCount,
    activeNeedsInputNotificationCount,
    activeReviewNotificationCount,
    mutedNeedsInputNotificationCount,
    notificationStatusVersion: normalizeStatusNumber(session.notificationStatusVersion, 0),
    notificationStatusUpdatedAt: normalizeStatusNumber(
      session.notificationStatusUpdatedAt,
      deriveNotificationStatusUpdatedAt(notifications),
    ),
  };
}

function buildNotificationUpdateMessage(session: SessionLike): BrowserIncomingMessage {
  const status = getNotificationStatusSnapshot(session);
  return {
    type: "notification_update",
    notifications: getUserVisibleSessionNotifications(session),
    ...status,
  } as BrowserIncomingMessage;
}

/** Publish authoritative notification changes without resolving or recreating a prompt. */
export function broadcastNotificationRefresh(session: SessionLike, deps: PersistNotificationDeps): void {
  touchNotificationStatus(session);
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  clearActionAttentionIfNoNotifications(session, deps);
  deps.persistSession(session);
}

export function notifyUser(
  session: SessionLike,
  category: SessionNotification["category"],
  summary: string,
  deps: NotifyUserDeps,
  options: NotifyUserOptions = {},
): NotifyUserResult {
  const timestamp = Date.now();
  const preferredThreadRoute = options.threadRoute ?? activeNotificationThreadRoute(session);
  const isLeaderSession = deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;
  const preferVisibleTextAnchor =
    isLeaderSession && category === "needs-input" && !deps.isHerdedWorkerSession?.(session);
  let anchorIndex = findLastNotificationAnchorIndex(session, { preferredThreadRoute, preferVisibleTextAnchor });
  let anchor = anchorIndex !== undefined ? getNotificationAnchor(session.messageHistory[anchorIndex]) : undefined;
  const candidateThreadRoute =
    preferredThreadRoute ?? resolveConsistentNotificationThreadRoute(session.messageHistory, anchorIndex, "pending");
  const suggestedAnswers =
    category === "needs-input" && options.suggestedAnswers?.length ? options.suggestedAnswers : undefined;
  const questions = category === "needs-input" && options.questions?.length ? options.questions : undefined;

  const existingNeedsInput =
    category === "needs-input"
      ? findExactActiveNeedsInputNotification(
          session,
          summary,
          suggestedAnswers,
          questions,
          candidateThreadRoute,
          timestamp,
        )
      : null;
  if (existingNeedsInput) {
    if (anchor) {
      maybeReanchorReusedNotification(existingNeedsInput, anchor, candidateThreadRoute);
      (anchor.message as Record<string, unknown>).notification = withThreadRoute(
        buildAnchoredNotification(existingNeedsInput),
        candidateThreadRoute,
      );
      markSatisfiedThreadOutcomeReminders(session, existingNeedsInput, anchorIndex);
      deps.broadcastToBrowsers?.(session, {
        type: "notification_anchored",
        messageId: anchor.id,
        notification: withThreadRoute(buildAnchoredNotification(existingNeedsInput), candidateThreadRoute),
      } as BrowserIncomingMessage);
    }
    touchNotificationStatus(session);
    deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
    deps.persistSession(session);
    return {
      ok: true,
      anchoredMessageId: existingNeedsInput.messageId ?? null,
      notificationId: existingNeedsInput.id,
      reused: true,
    };
  }

  let createdFallbackMessage: BrowserIncomingMessage | null = null;

  if (!anchor && isLeaderSession && category === "needs-input" && !deps.isHerdedWorkerSession?.(session)) {
    createdFallbackMessage = {
      type: "leader_user_message",
      id: `leader-needs-input-${timestamp}-${session.messageHistory.length}`,
      content: `Needs input: ${summary}`,
      timestamp,
    };
    session.messageHistory.push(createdFallbackMessage);
    anchorIndex = session.messageHistory.length - 1;
    anchor = getNotificationAnchor(createdFallbackMessage);
  }

  const anchoredMessageId = anchor?.id ?? null;
  const nextNotificationCounter = Number.isInteger(session.notificationCounter) ? session.notificationCounter + 1 : 1;
  session.notificationCounter = nextNotificationCounter;
  const notificationId = `n-${nextNotificationCounter}`;
  const threadRoute =
    preferredThreadRoute ??
    resolveConsistentNotificationThreadRoute(session.messageHistory, anchorIndex, notificationId);
  if (createdFallbackMessage) {
    createdFallbackMessage.threadKey = threadRoute.threadKey;
    if (threadRoute.questId) createdFallbackMessage.questId = threadRoute.questId;
    if (threadRoute.threadRefs?.length) createdFallbackMessage.threadRefs = threadRoute.threadRefs;
  }
  const anchoredNotification = withThreadRoute(
    {
      id: notificationId,
      category,
      timestamp,
      summary,
      ...(suggestedAnswers ? { suggestedAnswers } : {}),
      ...(questions ? { questions } : {}),
    },
    threadRoute,
  );

  const notif: SessionNotification = withThreadRoute(
    {
      id: notificationId,
      category,
      summary,
      ...(suggestedAnswers ? { suggestedAnswers } : {}),
      ...(questions ? { questions } : {}),
      timestamp,
      messageId: anchoredMessageId,
      done: false,
    },
    threadRoute,
  );
  session.notifications.push(notif);
  if (notif.category === "needs-input") {
    surfaceCreatedNeedsInputThreadTab(session, threadRoute, timestamp, deps);
    markSatisfiedThreadOutcomeReminders(session, notif, anchorIndex);
  } else if (notif.category === "review" && !options.suppressThreadTabPromotion) {
    deps.promoteLeaderThreadTabForAttention?.(session.id, threadRoute.threadKey, timestamp, "review");
  }
  touchNotificationStatus(session);

  if (deps.isHerdedWorkerSession?.(session)) {
    if (category === "needs-input") {
      deps.emitTakodeEvent?.(session.id, "notification_needs_input", {
        summary,
        notificationId: notif.id,
        messageId: anchoredMessageId,
        ...(suggestedAnswers ? { suggestedAnswers } : {}),
        ...(questions ? { questions } : {}),
        ...(anchorIndex !== undefined ? { msg_index: anchorIndex } : {}),
        threadKey: threadRoute.threadKey,
        ...(threadRoute.questId ? { questId: threadRoute.questId } : {}),
      });
    }
    deps.persistSession(session);
    return { ok: true, anchoredMessageId, notificationId: notif.id };
  }

  if (anchor) {
    (anchor.message as Record<string, unknown>).notification = anchoredNotification;
  }

  if (createdFallbackMessage) deps.broadcastToBrowsers?.(session, createdFallbackMessage);

  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));

  if (category === "needs-input" || category === "review") {
    const reason = category === "needs-input" ? "action" : "review";
    setAttention(session, reason, deps);
  }

  if (category === "needs-input" || category === "review") {
    deps.scheduleNotification?.(
      session.id,
      category === "needs-input" ? "question" : "completed",
      summary,
      category === "needs-input" ? { skipReadCheck: true, notificationId: notif.id } : { skipReadCheck: true },
    );
  }

  if (anchor) {
    deps.broadcastToBrowsers?.(session, {
      type: "notification_anchored",
      messageId: anchoredMessageId,
      notification: anchoredNotification,
    } as BrowserIncomingMessage);
  }

  deps.persistSession(session);
  return { ok: true, anchoredMessageId, notificationId: notif.id };
}

export function notifyUserBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  category: SessionNotification["category"],
  summary: string,
  deps: NotifyUserDeps,
  options: NotifyUserOptions = {},
): NotifyUserResult | { ok: false; error: string } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };
  return notifyUser(session, category, summary, deps, options);
}

function threadReadyUnreadSummary(record: LeaderThreadStatus): string {
  const label = record.questId ?? record.threadKey;
  return `Thread ready: ${label}${record.summary ? ` | ${record.summary}` : ""}`;
}

function hasThreadReadyUnreadNotification(session: SessionLike, record: LeaderThreadStatus, summary: string): boolean {
  const route = normalizeThreadRoute(record.threadKey, record.questId) ?? { threadKey: "main" };
  return (session.notifications ?? []).some((notification: SessionNotification) => {
    if (notification.category !== "review") return false;
    if (notification.messageId !== record.messageId) return false;
    if (notification.summary !== summary) return false;
    const notificationRoute = normalizeThreadRoute(notification.threadKey, notification.questId) ?? {
      threadKey: "main",
    };
    return sameThreadRoute(notificationRoute, route);
  });
}

export function recordThreadReadyUnreadNotifications(
  session: SessionLike,
  records: ReadonlyArray<LeaderThreadStatus>,
  deps: ThreadReadyUnreadDeps,
): boolean {
  const readyRecords = records.filter((record) => record.kind === "ready");
  if (readyRecords.length === 0) return false;

  session.notifications ??= [];
  let changed = false;
  for (const record of readyRecords) {
    const threadRoute = normalizeThreadRoute(record.threadKey, record.questId) ?? { threadKey: "main" };
    const summary = threadReadyUnreadSummary(record);
    if (hasThreadReadyUnreadNotification(session, record, summary)) continue;

    const nextNotificationCounter = Number.isInteger(session.notificationCounter) ? session.notificationCounter + 1 : 1;
    session.notificationCounter = nextNotificationCounter;
    const notification: SessionNotification = withThreadRoute(
      {
        id: `n-${nextNotificationCounter}`,
        category: "review",
        summary,
        timestamp: record.timestamp,
        messageId: record.messageId,
        done: false,
      },
      threadRoute,
    );
    session.notifications.push(notification);
    deps.promoteLeaderThreadTabForAttention?.(session.id, threadRoute.threadKey, record.timestamp, "review");
    changed = true;
  }

  if (!changed) return false;
  touchNotificationStatus(session);
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  setAttention(session, "review", deps);
  deps.persistSession(session);
  return true;
}

function surfaceCreatedNeedsInputThreadTab(
  session: SessionLike,
  route: ThreadRouteMetadata,
  eventAt: number,
  deps: Pick<NotifyUserDeps, "getLauncherSessionInfo" | "getLeaderThreadTabMutationPolicy">,
): void {
  const isLeader =
    session.state?.isOrchestrator === true || deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;
  if (!isLeader || !shouldPersistLeaderThreadTab(route.threadKey)) return;
  const scheduledRow = scheduledBoardRowForThread(session, route.threadKey);
  const mutationPolicy =
    deps.getLeaderThreadTabMutationPolicy?.(session.id, route.threadKey) ??
    (scheduledRow
      ? {
          inMotion: false,
          scheduled: true,
          neverStartedScheduled: isNeverStartedScheduledLeaderThreadTabRow(scheduledRow),
          completed: false,
          canClose: true,
        }
      : null);
  if (mutationPolicy?.neverStartedScheduled) return;
  const existingState = normalizeLeaderOpenThreadTabsState(session.state?.leaderOpenThreadTabs);
  const nextState = applyLeaderServerCandidateThreadTabEvent(existingState, route.threadKey, eventAt, {
    repositionExisting: true,
    allowTombstoneReopen: mutationPolicy?.scheduled !== true,
  });
  if (!nextState || nextState === existingState) return;
  session.state = { ...(session.state ?? {}), leaderOpenThreadTabs: nextState };
}

function activeNotificationThreadRoute(session: SessionLike): ThreadRouteMetadata | null {
  return normalizeThreadRoute(session.activeTurnRoute?.threadKey, session.activeTurnRoute?.questId);
}

function markSatisfiedThreadOutcomeReminders(
  session: SessionLike,
  notification: SessionNotification,
  anchorIndex: number | undefined,
): void {
  if (anchorIndex === undefined) return;
  const notificationRoute = normalizeThreadRoute(notification.threadKey, notification.questId) ?? { threadKey: "main" };
  const anchorTimestamp = Number(session.messageHistory[anchorIndex]?.timestamp ?? 0);
  const notificationTimestamp = Number(notification.timestamp);

  for (let index = anchorIndex + 1; index < session.messageHistory.length; index += 1) {
    const entry = session.messageHistory[index] as BrowserIncomingMessage & {
      threadOutcomeReminder?: Record<string, unknown>;
    };
    if (entry.type !== "user_message") continue;
    if (entry.agentSource?.sessionId !== THREAD_OUTCOME_REMINDER_SOURCE_ID) continue;
    if (entry.threadOutcomeReminder?.status === "satisfied") continue;
    if (!sameThreadRoute(routeFromHistoryEntry(entry) ?? { threadKey: "main" }, notificationRoute)) continue;

    const reminderTimestamp = Number(entry.timestamp ?? 0);
    if (reminderTimestamp < anchorTimestamp || reminderTimestamp > notificationTimestamp) continue;
    entry.threadOutcomeReminder = {
      status: "satisfied",
      notificationId: notification.id,
      ...(notification.summary ? { notificationSummary: notification.summary } : {}),
      satisfiedAt: notificationTimestamp,
    };
  }
}

function anchorMatchesThreadRoute(session: SessionLike, anchorIndex: number, route: ThreadRouteMetadata): boolean {
  const anchorRoute = routeFromHistoryEntry(session.messageHistory[anchorIndex]) ?? { threadKey: "main" };
  return sameThreadRoute(anchorRoute, route);
}

function getSortedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.board?.values) return [];
  return Array.from(session.board.values() as Iterable<BoardRow>).sort((a, b) => a.createdAt - b.createdAt);
}

function getSortedCompletedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.completedBoard?.values) return [];
  return Array.from(session.completedBoard.values() as Iterable<BoardRow>).sort(
    (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
}

function removeNotificationLinksFromBoardRows(session: SessionLike, notifId: string): boolean {
  const normalizedNotificationId = notifId.trim().toLowerCase();
  if (!/^n-\d+$/.test(normalizedNotificationId)) return false;

  let changed = false;
  const boardMaps = [session.board, session.completedBoard].filter(
    (boardMap): boardMap is Map<string, BoardRow> => !!boardMap?.values,
  );
  for (const boardMap of boardMaps) {
    for (const row of boardMap.values()) {
      if (!Array.isArray(row.waitForInput) || row.waitForInput.length === 0) continue;
      const currentIds = [
        ...new Set(row.waitForInput.map((notificationId: string) => notificationId.trim().toLowerCase())),
      ]
        .filter((notificationId) => /^n-\d+$/.test(notificationId))
        .sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10));
      if (!currentIds.includes(normalizedNotificationId)) continue;

      const nextIds = currentIds.filter((notificationId) => notificationId !== normalizedNotificationId);
      row.waitForInput = nextIds.length > 0 ? nextIds : undefined;
      boardMap.set(row.questId, row);
      changed = true;
    }
  }

  return changed;
}

export function markNotificationDone(
  session: SessionLike,
  notifId: string,
  done: boolean,
  deps: NotificationDoneDeps,
  options: NotificationDoneOptions = {},
): boolean {
  const notif = session.notifications.find((entry: SessionNotification) => entry.id === notifId);
  if (!notif) return false;
  if (notif.done === done) {
    if (done && notif.category === "needs-input" && !options.suppressScheduledNotificationCancel) {
      deps.cancelScheduledNotification?.(session.id, notifId);
    }
    if (done) broadcastNotificationRefresh(session, deps);
    return true;
  }
  notif.done = done;
  updateResolutionNoticeForDoneChange(notif, done, options);
  touchNotificationStatus(session);
  const clearedBoardWaits =
    done && notif.category === "needs-input" ? removeNotificationLinksFromBoardRows(session, notifId) : false;
  if (done && notif.category === "needs-input" && !options.suppressScheduledNotificationCancel) {
    deps.cancelScheduledNotification?.(session.id, notifId);
  }
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  if (clearedBoardWaits) {
    deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
  }
  if (done) clearActionAttentionIfNoNotifications(session, deps);
  deps.persistSession(session);
  return true;
}

export function markNotificationDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  notifId: string,
  done: boolean,
  deps: NotificationDoneDeps,
  options: NotificationDoneOptions = {},
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return markNotificationDone(session, notifId, done, deps, options);
}

export function setNotificationMuted(
  session: SessionLike,
  notifId: string,
  muted: boolean,
  deps: NotificationMuteDeps,
): boolean {
  const notif = session.notifications.find((entry: SessionNotification) => entry.id === notifId);
  if (!notif || notif.category !== "needs-input" || notif.done) return false;
  const currentlyMuted = notif.muted === true;
  if (currentlyMuted === muted) {
    broadcastNotificationRefresh(session, deps);
    return true;
  }

  if (muted) {
    notif.muted = true;
    notif.mutedAt = Date.now();
  } else {
    delete notif.muted;
    delete notif.mutedAt;
  }

  touchNotificationStatus(session);
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  if (muted) {
    clearActionAttentionIfNoNotifications(session, deps);
  } else {
    setAttention(session, "action", deps);
  }
  deps.persistSession(session);
  return true;
}

export function setNotificationMutedBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  notifId: string,
  muted: boolean,
  deps: NotificationMuteDeps,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return setNotificationMuted(session, notifId, muted, deps);
}

export function markAllNotificationsDone(
  session: SessionLike,
  done: boolean,
  deps: NotificationDoneDeps,
  options: NotificationDoneOptions = {},
): number {
  let count = 0;
  let clearedBoardWaits = false;
  for (const notif of session.notifications) {
    if (notif.done === done) continue;
    notif.done = done;
    updateResolutionNoticeForDoneChange(notif, done, options);
    if (done && notif.category === "needs-input") {
      clearedBoardWaits = removeNotificationLinksFromBoardRows(session, notif.id) || clearedBoardWaits;
      if (!options.suppressScheduledNotificationCancel) {
        deps.cancelScheduledNotification?.(session.id, notif.id);
      }
    }
    count += 1;
  }
  if (count > 0) {
    touchNotificationStatus(session);
    deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
    if (clearedBoardWaits) {
      deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
    }
    if (done) clearActionAttentionIfNoNotifications(session, deps);
    deps.persistSession(session);
  } else if (done) {
    broadcastNotificationRefresh(session, deps);
  }
  return count;
}

export function markAllNotificationsDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  done: boolean,
  deps: NotificationDoneDeps,
  options: NotificationDoneOptions = {},
): number {
  const session = sessions.get(sessionId);
  if (!session) return -1;
  return markAllNotificationsDone(session, done, deps, options);
}

export function clearActionAttentionIfNoNotifications(session: SessionLike, deps: BrowserNotificationDeps): void {
  if (session.pendingPermissions.size > 0) return;
  const hasOpenNeedsInput = session.notifications.some(
    (notif: SessionNotification) => !notif.done && !notif.muted && notif.category === "needs-input",
  );
  if (!hasOpenNeedsInput && session.attentionReason === "action") {
    session.attentionReason = null;
  }
}

function findLastNotificationAnchorIndex(
  session: SessionLike,
  options: {
    preferredThreadRoute?: ThreadRouteMetadata | null;
    preferVisibleTextAnchor?: boolean;
  } = {},
): number | undefined {
  if (options.preferVisibleTextAnchor) {
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      if (!isVisibleNotificationAnchor(session.messageHistory[i])) continue;
      if (options.preferredThreadRoute && !anchorMatchesThreadRoute(session, i, options.preferredThreadRoute)) {
        continue;
      }
      return i;
    }
  }
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    if (!getNotificationAnchor(session.messageHistory[i])) continue;
    if (options.preferredThreadRoute && !anchorMatchesThreadRoute(session, i, options.preferredThreadRoute)) {
      continue;
    }
    return i;
  }
  return undefined;
}

function isVisibleNotificationAnchor(entry: BrowserIncomingMessage | undefined): boolean {
  const anchor = getNotificationAnchor(entry);
  if (!anchor) return false;
  if (anchor.message.type === "leader_user_message") return hasNonEmptyText(anchor.message.content);
  return anchor.message.message.content.some((block) => block.type === "text" && hasNonEmptyText(block.text));
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function findExactActiveNeedsInputNotification(
  session: SessionLike,
  summary: string,
  suggestedAnswers: string[] | undefined,
  questions: NeedsInputNotificationQuestion[] | undefined,
  threadRoute: ThreadRouteMetadata,
  timestamp: number,
): SessionNotification | null {
  return (
    (session.notifications ?? []).find((notification: SessionNotification) => {
      if (notification.category !== "needs-input" || notification.done || notification.muted) return false;
      if (timestamp - notification.timestamp > EXACT_NEEDS_INPUT_RETRY_DEDUPE_WINDOW_MS) return false;
      if (notification.summary !== summary) return false;
      const notificationRoute = normalizeThreadRoute(notification.threadKey, notification.questId) ?? {
        threadKey: "main",
      };
      if (!sameThreadRoute(notificationRoute, threadRoute)) return false;
      return (
        stringArraysEqual(notification.suggestedAnswers, suggestedAnswers) &&
        questionsEqual(notification.questions, questions)
      );
    }) ?? null
  );
}

function stringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function questionsEqual(
  left: NeedsInputNotificationQuestion[] | undefined,
  right: NeedsInputNotificationQuestion[] | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((leftQuestion, index) => {
    const rightQuestion = normalizedRight[index];
    if (!rightQuestion || leftQuestion.prompt !== rightQuestion.prompt) return false;
    return stringArraysEqual(leftQuestion.suggestedAnswers, rightQuestion.suggestedAnswers);
  });
}

function buildAnchoredNotification(notification: SessionNotification): Omit<SessionNotification, "messageId" | "done"> {
  return {
    id: notification.id,
    category: notification.category,
    timestamp: notification.timestamp,
    ...(notification.summary ? { summary: notification.summary } : {}),
    ...(notification.suggestedAnswers ? { suggestedAnswers: notification.suggestedAnswers } : {}),
    ...(notification.questions ? { questions: notification.questions } : {}),
  };
}

function maybeReanchorReusedNotification(
  notification: SessionNotification,
  anchor: { id: string; message: Extract<BrowserIncomingMessage, { type: "assistant" | "leader_user_message" }> },
  threadRoute: ThreadRouteMetadata,
): void {
  if (notification.messageId === anchor.id) return;
  notification.messageId = anchor.id;
  notification.threadKey = threadRoute.threadKey;
  if (threadRoute.questId) notification.questId = threadRoute.questId;
  else delete notification.questId;
  if (threadRoute.threadRefs?.length) notification.threadRefs = threadRoute.threadRefs;
  else delete notification.threadRefs;
}

function getNotificationAnchor(entry: BrowserIncomingMessage | undefined):
  | {
      id: string;
      message: Extract<BrowserIncomingMessage, { type: "assistant" | "leader_user_message" }>;
    }
  | undefined {
  if (!entry) return undefined;
  if (entry.type === "assistant" && entry.parent_tool_use_id == null && entry.message?.id) {
    return { id: entry.message.id, message: entry };
  }
  if (entry.type === "leader_user_message" && entry.id) {
    return { id: entry.id, message: entry };
  }
  return undefined;
}

function updateResolutionNoticeForDoneChange(
  notification: SessionNotification,
  done: boolean,
  options: NotificationDoneOptions,
): void {
  if (notification.category !== "needs-input") return;
  if (!done) {
    delete notification.resolutionNotice;
    return;
  }
  if (!options.resolutionNotice) return;
  const resolvedAt = Date.now();
  notification.resolutionNotice = {
    status: options.resolutionNotice,
    source: options.resolutionNoticeSource ?? "manual",
    resolvedAt,
    ...(options.resolutionNotice === "delivered" ? { deliveredAt: resolvedAt } : {}),
  };
}
