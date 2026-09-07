import type { BrowserIncomingMessage, SessionNotification, ThreadRef } from "../session-types.js";
import { isRootAgentHistoryMessage } from "../root-agent-feed-message.js";
import { isActualHumanUserMessage } from "../user-message-classification.js";
import {
  buildLeaderThreadResponseState,
  leaderResponseThreadKeyForUserMessage,
  pendingLeaderAnswerInputsForThread,
  type LeaderThreadResponseSession,
} from "../leader-thread-response.js";
import {
  routeFromHistoryEntry,
  routeKey,
  threadRouteForTarget,
  type ThreadRouteMetadata,
} from "../thread-routing-metadata.js";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-outcome-reminder.js";
import {
  buildThreadRoutingReminderContent,
  isLeaderAnswerRouteDiagnostic,
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
  type LeaderAnswerRouteDiagnostic,
} from "../../shared/thread-routing-reminder.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { isCanonicalLeaderUserMessageId } from "../leader-user-message-id.js";
import type {
  LeaderThreadOutcomeReminderGuard,
  LeaderThreadOutcomeReminderGuardTarget,
} from "../leader-thread-response-types.js";
import { clearLeaderReadyStatusesBlockedByNeedsInput } from "./thread-routing-reminder.js";

export const THREAD_RESPONSE_REMINDER_SOURCE_ID = THREAD_OUTCOME_REMINDER_SOURCE_ID;
export const THREAD_RESPONSE_REMINDER_SOURCE_LABEL = THREAD_OUTCOME_REMINDER_SOURCE_LABEL;

type LeaderThreadOutcomeSession = {
  id: string;
  messageHistory: BrowserIncomingMessage[];
  pendingCodexInputs?: LeaderThreadResponseSession["pendingCodexInputs"];
  notifications?: SessionNotification[];
  state?: { leaderThreadStatuses?: Record<string, LeaderThreadStatus> };
  leaderThreadOutcomeValidatedHistoryLength?: number;
  pendingLeaderRejectedReadyThreadKeys?: string[];
};

export type LeaderThreadOutcomeTurnSource = "user" | "leader" | "system" | "unknown";

export type LeaderThreadOutcomeValidationResult =
  | { checked: false; reason: "not_leader" | "system_turn" | "no_new_history" }
  | { checked: true; missing: string[]; injected: boolean };

export interface LeaderThreadOutcomeValidationDeps {
  isLeaderSession: (sessionId: string) => boolean;
  getTurnSource?: (session: LeaderThreadOutcomeSession) => LeaderThreadOutcomeTurnSource;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource: { sessionId: string; sessionLabel?: string },
    threadRoute?: ThreadRouteMetadata,
    options?: { leaderThreadOutcomeReminderGuard?: LeaderThreadOutcomeReminderGuard },
  ) => "sent" | "queued" | "dropped" | "no_session";
  persistSession?: (session: LeaderThreadOutcomeSession) => void;
}

type TouchedThread = {
  route: ThreadRouteMetadata;
  key: string;
  earliestTimestamp: number;
  latestTimestamp: number;
  latestIndex: number;
  textEvents: Array<{ text: string; timestamp: number }>;
  rejectedAnswerObserved: boolean;
};

type FreshOutcomeKind = "waiting" | "ready" | "needs-input" | "review";

const BLOCKING_PROMPT_PATTERNS = [
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?Proposed quest(?:\*\*)?\s*:?\s*$/im,
  /^\s*(?:\*\*)?Please confirm or correct\.?(?:\*\*)?\s*$/im,
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?Decision needed(?:\*\*)?\s*:?/im,
];

export function validateLeaderThreadOutcomes(
  session: LeaderThreadOutcomeSession,
  deps: LeaderThreadOutcomeValidationDeps,
  options: { rejectedReadyThreadKeys?: string[] } = {},
): LeaderThreadOutcomeValidationResult {
  if (!deps.isLeaderSession(session.id)) return { checked: false, reason: "not_leader" };

  const history = session.messageHistory ?? [];
  const clearedBlockedReady = clearLeaderReadyStatusesBlockedByNeedsInput({
    notifications: session.notifications,
    state: session.state ?? {},
  });
  const startIndex = clampHistoryIndex(session.leaderThreadOutcomeValidatedHistoryLength, history.length);
  if (startIndex >= history.length) {
    if (clearedBlockedReady) deps.persistSession?.(session);
    return { checked: false, reason: "no_new_history" };
  }
  if (deps.getTurnSource?.(session) === "system") {
    // System-triggered turns must not inject routing reminders, but a semantic
    // rejection recovered from an earlier normal turn still needs the next
    // normal validation boundary. Keep that exact row unconsumed instead of
    // silently losing its actionable diagnostic during recovery/preload work.
    const deferredAnswerRouteRejection = findPersistedAnswerRouteRejection(history, startIndex);
    session.leaderThreadOutcomeValidatedHistoryLength = deferredAnswerRouteRejection?.historyIndex ?? history.length;
    deps.persistSession?.(session);
    return { checked: false, reason: "system_turn" };
  }

  const deferredRejectedReadyThreadKeys = normalizedRejectedReadyThreadKeys(
    session.pendingLeaderRejectedReadyThreadKeys,
  );
  const rejectedReadyThreadKeys = normalizedRejectedReadyThreadKeys([
    ...(options.rejectedReadyThreadKeys ?? []),
    ...deferredRejectedReadyThreadKeys,
  ]);
  const touchedThreads = collectTouchedLeaderThreads(history, startIndex);
  addRejectedReadyThreads(touchedThreads, [...rejectedReadyThreadKeys], history);
  session.leaderThreadOutcomeValidatedHistoryLength = history.length;

  const answerRouteRejection = findPersistedAnswerRouteRejection(history, startIndex);
  if (answerRouteRejection) {
    const delivery = deps.injectUserMessage(
      session.id,
      buildThreadRoutingReminderContent({
        reason: "invalid_answer_route",
        source: "answer_marker",
        answerRouteDiagnostic: answerRouteRejection.diagnostic,
      }),
      {
        sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
        sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
      },
      threadRouteForTarget(answerRouteRejection.diagnostic.selectedThreadKey),
    );
    clearPendingRejectedReadyThreadKeys(session, [
      answerRouteRejection.diagnostic.selectedThreadKey,
      ...answerRouteRejection.diagnostic.ownerGroups.map((group) => group.threadKey),
    ]);
    settleValidatedHistoryLength(session, history);
    deps.persistSession?.(session);
    return {
      checked: true,
      missing: answerRouteMissingThreadKeys(answerRouteRejection.diagnostic),
      injected: delivery !== "dropped" && delivery !== "no_session",
    };
  }

  const missingNeedsInputPrompts = touchedThreads.filter(
    (thread) => hasBlockingApprovalPrompt(thread) && !hasFreshSameThreadNeedsInput(thread, session.notifications ?? []),
  );
  if (missingNeedsInputPrompts.length > 0) {
    const firstMissingPrompt = missingNeedsInputPrompts[0]!;
    const delivery = deps.injectUserMessage(
      session.id,
      buildNeedsInputPromptReminderContent(missingNeedsInputPrompts),
      { sessionId: THREAD_RESPONSE_REMINDER_SOURCE_ID, sessionLabel: THREAD_RESPONSE_REMINDER_SOURCE_LABEL },
      firstMissingPrompt.route,
      {
        leaderThreadOutcomeReminderGuard: {
          version: 1,
          pendingResponseTargets: [],
          missingOutcomeTargets: [],
          missingNeedsInputTargets: missingNeedsInputPrompts.map((thread) => ({
            threadKey: thread.key,
            earliestTimestamp: thread.earliestTimestamp,
            promptTimestamp: blockingPromptTimestamp(thread)!,
          })),
        },
      },
    );
    if (delivery !== "dropped" && delivery !== "no_session") {
      clearPendingRejectedReadyThreadKeys(
        session,
        missingNeedsInputPrompts.map((thread) => thread.key),
      );
    }
    settleValidatedHistoryLength(session, history);
    deps.persistSession?.(session);
    return {
      checked: true,
      missing: missingNeedsInputPrompts.map((thread) => thread.route.threadKey),
      injected: delivery !== "dropped" && delivery !== "no_session",
    };
  }

  const pendingResponseMissing: TouchedThread[] = [];
  const outcomeMissing: TouchedThread[] = [];
  for (const thread of touchedThreads) {
    const outcome = freshOutcomeKind(thread, session.notifications ?? [], session.state?.leaderThreadStatuses);
    const pending = pendingLeaderAnswerCount(session, thread.key);
    if (pending > 0) {
      if (rejectedReadyThreadKeys.has(thread.key) || (outcome !== "waiting" && outcome !== "needs-input")) {
        pendingResponseMissing.push(thread);
      }
    } else if (!outcome) {
      outcomeMissing.push(thread);
    }
  }

  if (pendingResponseMissing.length === 0 && outcomeMissing.length === 0) {
    clearPendingRejectedReadyThreadKeys(session, deferredRejectedReadyThreadKeys);
    deps.persistSession?.(session);
    return { checked: true, missing: [], injected: false };
  }

  const primary = pendingResponseMissing[0] ?? outcomeMissing[0]!;
  const delivery = deps.injectUserMessage(
    session.id,
    pendingResponseMissing.length > 0
      ? buildPendingResponseReminderContent(session, pendingResponseMissing, outcomeMissing)
      : buildOutcomeReminderContent(outcomeMissing),
    { sessionId: THREAD_RESPONSE_REMINDER_SOURCE_ID, sessionLabel: THREAD_RESPONSE_REMINDER_SOURCE_LABEL },
    primary.route,
    {
      leaderThreadOutcomeReminderGuard: {
        version: 1,
        pendingResponseTargets: pendingResponseMissing.map((thread) => {
          const pending = pendingLeaderAnswerSnapshot(session, thread.key);
          return {
            threadKey: thread.key,
            earliestTimestamp: thread.earliestTimestamp,
            pendingAnswerCount: pending.count,
            pendingAnswerUserMessageIds: pending.userMessageIds,
            ...(rejectedReadyThreadKeys.has(thread.key) ? { rejectedReady: true } : {}),
            ...(thread.rejectedAnswerObserved ? { rejectedAnswerObserved: true } : {}),
          };
        }),
        missingOutcomeTargets: outcomeMissing.map((thread) => ({
          threadKey: thread.key,
          earliestTimestamp: thread.earliestTimestamp,
        })),
        missingNeedsInputTargets: [],
      },
    },
  );
  if (delivery !== "dropped" && delivery !== "no_session") {
    clearPendingRejectedReadyThreadKeys(session, deferredRejectedReadyThreadKeys);
  }
  settleValidatedHistoryLength(session, history);
  deps.persistSession?.(session);
  return {
    checked: true,
    missing: [...pendingResponseMissing, ...outcomeMissing].map((thread) => thread.route.threadKey),
    injected: delivery !== "dropped" && delivery !== "no_session",
  };
}

function findPersistedAnswerRouteRejection(
  history: BrowserIncomingMessage[],
  startIndex: number,
): { diagnostic: LeaderAnswerRouteDiagnostic; historyIndex: number } | null {
  for (let index = startIndex; index < history.length; index += 1) {
    const entry = history[index];
    if (
      entry?.type !== "assistant" ||
      !isRootAgentHistoryMessage(entry) ||
      entry.parent_tool_use_id !== null ||
      entry.leaderThreadRole !== "answer" ||
      entry.threadAnswer !== undefined ||
      entry.threadRoutingError?.reason !== "invalid_answer_route" ||
      entry.threadRoutingError.source !== "answer_marker" ||
      !isLeaderAnswerRouteDiagnostic(entry.threadRoutingError.answerRouteDiagnostic)
    ) {
      continue;
    }
    return { diagnostic: entry.threadRoutingError.answerRouteDiagnostic, historyIndex: index };
  }
  return null;
}

function answerRouteMissingThreadKeys(diagnostic: LeaderAnswerRouteDiagnostic): string[] {
  const ownerThreads = diagnostic.ownerGroups.map((group) => group.threadKey);
  return ownerThreads.length > 0 ? [...new Set(ownerThreads)] : [diagnostic.selectedThreadKey];
}

function pendingLeaderAnswerSnapshot(
  session: LeaderThreadOutcomeSession,
  threadKey: string,
): { count: number; userMessageIds: string[] } {
  const state = buildLeaderThreadResponseState(session, threadKey);
  const queued = pendingLeaderAnswerInputsForThread(session, threadKey);
  return {
    count: state.projection.pendingMessageCount + queued.count,
    userMessageIds: [
      ...new Set([
        ...state.projection.pendingMessages.map((message) => message.userMessageId),
        ...queued.userMessageIds,
      ]),
    ],
  };
}

function pendingLeaderAnswerCount(session: LeaderThreadOutcomeSession, threadKey: string): number {
  return pendingLeaderAnswerSnapshot(session, threadKey).count;
}

function touchedThreadFromGuardTarget(target: LeaderThreadOutcomeReminderGuardTarget): TouchedThread | null {
  if (!target || typeof target !== "object" || typeof target.threadKey !== "string") return null;
  const threadKey = target.threadKey.trim().toLowerCase();
  if (
    (threadKey !== "main" && !/^q-\d+$/.test(threadKey)) ||
    !Number.isFinite(target.earliestTimestamp) ||
    target.earliestTimestamp < 0
  ) {
    return null;
  }
  const route = threadRouteForTarget(threadKey);
  return {
    route,
    key: routeKey(route),
    earliestTimestamp: target.earliestTimestamp,
    latestTimestamp: target.earliestTimestamp,
    latestIndex: -1,
    textEvents: [],
    rejectedAnswerObserved: false,
  };
}

export interface RefreshedLeaderThreadOutcomeReminder {
  content: string;
  guard: LeaderThreadOutcomeReminderGuard;
  route: ThreadRouteMetadata;
}

function validPendingGuardSnapshot(target: LeaderThreadOutcomeReminderGuardTarget): boolean {
  return (
    Number.isInteger(target.pendingAnswerCount) &&
    target.pendingAnswerCount! > 0 &&
    Array.isArray(target.pendingAnswerUserMessageIds) &&
    target.pendingAnswerUserMessageIds.every(isCanonicalLeaderUserMessageId) &&
    new Set(target.pendingAnswerUserMessageIds).size === target.pendingAnswerUserMessageIds.length &&
    target.pendingAnswerUserMessageIds.length <= target.pendingAnswerCount! &&
    (target.rejectedReady === undefined || typeof target.rejectedReady === "boolean") &&
    (target.rejectedAnswerObserved === undefined || typeof target.rejectedAnswerObserved === "boolean")
  );
}

export function refreshLeaderThreadOutcomeReminder(
  session: LeaderThreadOutcomeSession,
  guard: LeaderThreadOutcomeReminderGuard | null | undefined,
): RefreshedLeaderThreadOutcomeReminder | null {
  if (
    !guard ||
    typeof guard !== "object" ||
    guard.version !== 1 ||
    !Array.isArray(guard.pendingResponseTargets) ||
    !Array.isArray(guard.missingOutcomeTargets) ||
    !Array.isArray(guard.missingNeedsInputTargets)
  ) {
    return null;
  }
  const allTargets = [
    ...guard.pendingResponseTargets,
    ...guard.missingOutcomeTargets,
    ...guard.missingNeedsInputTargets,
  ];
  if (allTargets.length === 0) return null;
  const normalized = new Map<LeaderThreadOutcomeReminderGuardTarget, TouchedThread>();
  const seenThreadKeys = new Set<string>();
  for (const target of allTargets) {
    const thread = touchedThreadFromGuardTarget(target);
    if (!thread || seenThreadKeys.has(thread.key)) return null;
    seenThreadKeys.add(thread.key);
    normalized.set(target, thread);
  }

  const notifications = session.notifications ?? [];
  const statuses = session.state?.leaderThreadStatuses;
  if (guard.missingNeedsInputTargets.length > 0) {
    if (guard.pendingResponseTargets.length > 0 || guard.missingOutcomeTargets.length > 0) return null;
    const missingNeedsInput: TouchedThread[] = [];
    const refreshedTargets: LeaderThreadOutcomeReminderGuardTarget[] = [];
    for (const target of guard.missingNeedsInputTargets) {
      const thread = normalized.get(target)!;
      if (!Number.isFinite(target.promptTimestamp) || target.promptTimestamp! < 0) return null;
      const notificationExists = notifications.some(
        (notification) =>
          sameThread(thread, notification) &&
          notification.timestamp >= target.promptTimestamp! &&
          notification.category === "needs-input",
      );
      if (notificationExists) continue;
      missingNeedsInput.push(thread);
      refreshedTargets.push({
        threadKey: thread.key,
        earliestTimestamp: thread.earliestTimestamp,
        promptTimestamp: target.promptTimestamp,
      });
    }
    if (missingNeedsInput.length === 0) return null;
    return {
      content: buildNeedsInputPromptReminderContent(missingNeedsInput),
      guard: {
        version: 1,
        pendingResponseTargets: [],
        missingOutcomeTargets: [],
        missingNeedsInputTargets: refreshedTargets,
      },
      route: missingNeedsInput[0]!.route,
    };
  }

  const pendingResponseMissing: TouchedThread[] = [];
  const pendingTargets: LeaderThreadOutcomeReminderGuardTarget[] = [];
  const outcomeMissing: TouchedThread[] = [];
  const outcomeTargets: LeaderThreadOutcomeReminderGuardTarget[] = [];
  const candidates = [
    ...guard.pendingResponseTargets.map((target) => ({ target, wasPending: true })),
    ...guard.missingOutcomeTargets.map((target) => ({ target, wasPending: false })),
  ];
  for (const { target, wasPending } of candidates) {
    if (wasPending && !validPendingGuardSnapshot(target)) return null;
    const thread = normalized.get(target)!;
    const pending = pendingLeaderAnswerSnapshot(session, thread.key);
    const pendingSnapshotUnchanged =
      wasPending &&
      pending.count === target.pendingAnswerCount &&
      pending.userMessageIds.length === target.pendingAnswerUserMessageIds?.length &&
      pending.userMessageIds.every((id, index) => id === target.pendingAnswerUserMessageIds?.[index]);
    thread.rejectedAnswerObserved = target.rejectedAnswerObserved === true && pendingSnapshotUnchanged;
    const rejectedReady = target.rejectedReady === true && pendingSnapshotUnchanged;
    const outcome = freshOutcomeKind(thread, notifications, statuses);
    if (pending.count > 0) {
      if (rejectedReady || (outcome !== "waiting" && outcome !== "needs-input")) {
        pendingResponseMissing.push(thread);
        pendingTargets.push({
          threadKey: thread.key,
          earliestTimestamp: thread.earliestTimestamp,
          pendingAnswerCount: pending.count,
          pendingAnswerUserMessageIds: pending.userMessageIds,
          ...(rejectedReady ? { rejectedReady: true } : {}),
          ...(thread.rejectedAnswerObserved ? { rejectedAnswerObserved: true } : {}),
        });
      }
    } else if (!outcome) {
      outcomeMissing.push(thread);
      outcomeTargets.push({ threadKey: thread.key, earliestTimestamp: thread.earliestTimestamp });
    }
  }
  if (pendingResponseMissing.length === 0 && outcomeMissing.length === 0) return null;
  const primary = pendingResponseMissing[0] ?? outcomeMissing[0]!;
  return {
    content:
      pendingResponseMissing.length > 0
        ? buildPendingResponseReminderContent(session, pendingResponseMissing, outcomeMissing)
        : buildOutcomeReminderContent(outcomeMissing),
    guard: {
      version: 1,
      pendingResponseTargets: pendingTargets,
      missingOutcomeTargets: outcomeTargets,
      missingNeedsInputTargets: [],
    },
    route: primary.route,
  };
}

export function shouldDeliverLeaderThreadOutcomeReminder(
  session: LeaderThreadOutcomeSession,
  guard: LeaderThreadOutcomeReminderGuard | null | undefined,
): boolean {
  return refreshLeaderThreadOutcomeReminder(session, guard) !== null;
}

function clearPendingRejectedReadyThreadKeys(
  session: LeaderThreadOutcomeSession,
  handledThreadKeys: Iterable<string>,
): void {
  if (!session.pendingLeaderRejectedReadyThreadKeys?.length) return;
  const handled = new Set(handledThreadKeys);
  session.pendingLeaderRejectedReadyThreadKeys = session.pendingLeaderRejectedReadyThreadKeys.filter(
    (threadKey) => !handled.has(threadKey),
  );
}

function normalizedRejectedReadyThreadKeys(threadKeys: string[] | undefined): Set<string> {
  return new Set(
    (threadKeys ?? [])
      .map((threadKey) => threadKey.trim().toLowerCase())
      .filter((threadKey) => threadKey === "main" || /^q-\d+$/.test(threadKey)),
  );
}

function addRejectedReadyThreads(
  touchedThreads: TouchedThread[],
  rejectedReadyThreadKeys: string[] | undefined,
  history: BrowserIncomingMessage[],
): void {
  const existing = new Set(touchedThreads.map((thread) => thread.key));
  const latestIndex = Math.max(0, history.length - 1);
  const latestTimestamp = history.length > 0 ? getHistoryTimestamp(history.at(-1)!) : 0;
  for (const rawThreadKey of rejectedReadyThreadKeys ?? []) {
    const threadKey = rawThreadKey.trim().toLowerCase();
    if (threadKey !== "main" && !/^q-\d+$/.test(threadKey)) continue;
    const key = routeKey({ threadKey });
    if (existing.has(key)) continue;
    existing.add(key);
    touchedThreads.push({
      route: threadRouteForTarget(threadKey),
      key,
      earliestTimestamp: latestTimestamp,
      latestTimestamp,
      latestIndex,
      textEvents: [],
      rejectedAnswerObserved: false,
    });
  }
  touchedThreads.sort((left, right) => left.latestIndex - right.latestIndex);
}

function settleValidatedHistoryLength(session: LeaderThreadOutcomeSession, history: BrowserIncomingMessage[]): void {
  session.leaderThreadOutcomeValidatedHistoryLength = Math.max(
    session.leaderThreadOutcomeValidatedHistoryLength ?? 0,
    history.length,
  );
}

function clampHistoryIndex(value: number | undefined, historyLength: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return Math.min(value, historyLength);
}

function collectTouchedLeaderThreads(history: BrowserIncomingMessage[], startIndex: number): TouchedThread[] {
  const byThread = new Map<string, TouchedThread>();
  const touch = (
    route: ThreadRouteMetadata,
    timestamp: number,
    index: number,
    text?: string,
    rejectedAnswerObserved = false,
  ) => {
    const key = routeKey(route);
    const existing = byThread.get(key);
    if (!existing) {
      byThread.set(key, {
        route,
        key,
        earliestTimestamp: timestamp,
        latestTimestamp: timestamp,
        latestIndex: index,
        textEvents: text ? [{ text, timestamp }] : [],
        rejectedAnswerObserved,
      });
      return;
    }
    existing.earliestTimestamp = Math.min(existing.earliestTimestamp, timestamp);
    if (
      timestamp > existing.latestTimestamp ||
      (timestamp === existing.latestTimestamp && index > existing.latestIndex)
    ) {
      existing.route = route;
      existing.latestTimestamp = timestamp;
      existing.latestIndex = index;
    }
    if (text) existing.textEvents.push({ text, timestamp });
    existing.rejectedAnswerObserved ||= rejectedAnswerObserved;
  };

  for (let index = startIndex; index < history.length; index += 1) {
    const entry = history[index]!;
    const timestamp = getHistoryTimestamp(entry);
    if (
      isRootAgentHistoryMessage(entry) &&
      isActualHumanUserMessage(entry) &&
      entry.id &&
      entry.leaderResponseCoverageVersion === 1
    ) {
      const threadKey = leaderResponseThreadKeyForUserMessage(entry);
      if (threadKey) touch(threadRouteForTarget(threadKey), timestamp, index);
    }
    const text = getLeaderVisibleOutputText(entry);
    const route = text ? routeFromHistoryEntry(entry) : null;
    if (text && route) {
      const rejectedAnswerObserved =
        entry.type === "assistant" && entry.leaderThreadRole === "answer" && entry.threadAnswer === undefined;
      touch(route, timestamp, index, text, rejectedAnswerObserved);
    }
  }
  return [...byThread.values()].sort((left, right) => left.latestIndex - right.latestIndex);
}

function getLeaderVisibleOutputText(entry: BrowserIncomingMessage): string | null {
  if (entry.type === "leader_user_message") return hasText(entry.content) ? entry.content : null;
  if (entry.type !== "assistant" || entry.parent_tool_use_id !== null) return null;
  const text = entry.message.content
    .flatMap((block) => (block.type === "text" && hasText(block.text) ? [block.text] : []))
    .join("\n");
  return hasText(text) ? text : null;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function getHistoryTimestamp(entry: BrowserIncomingMessage): number {
  const timestamp = (entry as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
}

function blockingPromptTimestamp(thread: TouchedThread): number | null {
  let latest: number | null = null;
  for (const event of thread.textEvents) {
    if (!BLOCKING_PROMPT_PATTERNS.some((pattern) => pattern.test(event.text))) continue;
    latest = latest === null ? event.timestamp : Math.max(latest, event.timestamp);
  }
  return latest;
}

function hasBlockingApprovalPrompt(thread: TouchedThread): boolean {
  return blockingPromptTimestamp(thread) !== null;
}

function freshOutcomeKind(
  thread: TouchedThread,
  notifications: SessionNotification[],
  threadStatuses?: Record<string, LeaderThreadStatus>,
): FreshOutcomeKind | null {
  const status = threadStatuses?.[thread.key];
  if (status && status.timestamp >= thread.earliestTimestamp) return status.kind;

  for (const notification of notifications) {
    if (!sameThread(thread, notification) || notification.timestamp < thread.earliestTimestamp) continue;
    if (notification.category === "needs-input" && !notification.done) return "needs-input";
    if (notification.category === "waiting" && !notification.done) return "waiting";
    if (notification.category === "review") return "review";
  }
  return null;
}

function hasFreshSameThreadNeedsInput(thread: TouchedThread, notifications: SessionNotification[]): boolean {
  const promptTimestamp = blockingPromptTimestamp(thread);
  if (promptTimestamp === null) return false;
  return notifications.some(
    (notification) =>
      sameThread(thread, notification) &&
      notification.timestamp >= promptTimestamp &&
      notification.category === "needs-input" &&
      !notification.done,
  );
}

function sameThread(
  thread: TouchedThread,
  notification: { threadKey?: string; questId?: string; threadRefs?: ThreadRef[] },
) {
  const notificationThreadKey =
    notification.threadKey ?? notification.questId ?? notification.threadRefs?.[0]?.threadKey;
  return routeKey({ threadKey: notificationThreadKey }) === thread.key;
}

function buildPendingResponseReminderContent(
  session: LeaderThreadOutcomeSession,
  pendingMissing: TouchedThread[],
  outcomeMissing: TouchedThread[],
): string {
  const pendingStates = pendingMissing.map((thread) => {
    const state = buildLeaderThreadResponseState(session, thread.key);
    const queued = pendingLeaderAnswerInputsForThread(session, thread.key);
    const { userMessageIds } = pendingLeaderAnswerSnapshot(session, thread.key);
    return { thread, state, queued, userMessageIds };
  });
  const pendingLabels = pendingStates.map(({ thread, state, queued, userMessageIds }) => {
    const unresolvedCount = state.projection.pendingMessageCount + queued.count;
    const unavailableCount = Math.max(0, unresolvedCount - userMessageIds.length);
    const label = [
      ...userMessageIds,
      ...(unavailableCount > 0 ? [`${unavailableCount} unavailable-ID input${unavailableCount === 1 ? "" : "s"}`] : []),
    ].join(",");
    return `${formatThreadLabel(thread.key)} (${label})`;
  });
  const firstPendingId = pendingStates
    .flatMap(({ state }) => state.projection.pendingMessages.map((message) => message.userMessageId))
    .at(0);
  const rejectedAnswer = pendingStates.find(({ thread }) => thread.rejectedAnswerObserved);
  const correction = rejectedAnswer ? buildRejectedAnswerCorrection(rejectedAnswer) : [];
  return [
    "Answer reminder: direct user messages still need explicit routed answer coverage before the thread can be Ready.",
    `Pending answer IDs: ${pendingLabels.join("; ")}.`,
    ...correction,
    ...(rejectedAnswer
      ? []
      : [
          "Answer with `[thread:main:A:u1]` or `[thread:q-N:A:u1,u2]`, listing the exact earlier IDs covered by that answer.",
        ]),
    ...(firstPendingId
      ? [
          `Retrieve an exact earlier message with \`takode read ${session.id} ${firstPendingId}\`; both the leader session and session-scoped user-message ID are required.`,
        ]
      : []),
    "If work is not complete, use a fresh Thread Waiting marker or same-thread needs-input notification instead of Thread Ready.",
    ...(outcomeMissing.length > 0
      ? [
          `Also missing a normal Waiting/Ready/notification outcome for: ${formatThreadLabels(outcomeMissing)}.`,
          ...buildOutcomeOnlyAuthoringGuidance(),
        ]
      : []),
  ].join("\n");
}

function buildRejectedAnswerCorrection(rejected: { thread: TouchedThread; userMessageIds: string[] }): string[] {
  const marker =
    rejected.userMessageIds.length > 0
      ? `[thread:${rejected.thread.route.threadKey}:A:${rejected.userMessageIds.join(",")}]`
      : `[thread:${rejected.thread.route.threadKey}:A:<pending-id>]`;
  return [
    `Takode retained the prior answer prose, but its explicit marker or listed IDs did not establish current coverage for ${formatThreadLabel(rejected.thread.key)}.`,
    `Do not regenerate the full explanation. Send a brief corrected answer using ${marker} and only the exact pending IDs shown above.`,
  ];
}

function buildOutcomeReminderContent(missing: TouchedThread[]): string {
  return [
    "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
    `Missing outcome marker for: ${formatThreadLabels(missing)}.`,
    "This is about outcome status for already routed leader output, not a request for another answer; it is not diagnosing missing `[thread:...]` visible-text markers or `# thread:...` shell-command markers.",
    ...buildOutcomeOnlyAuthoringGuidance(),
    "Before marking a thread Ready, verify any promised durable action is actually complete: quest creation/refinement, board rows, needs-input notifications, worker sends, phase dispatches, Port/push, or other external records. If not, mark the thread Waiting or incomplete instead.",
    'Use `takode notify needs-input "..."` only for user-blocking prompts. For non-blocking thread status, add a standalone `{[(Thread Waiting: thread | summary)]}` or `{[(Thread Ready: thread | summary)]}` line to your assistant response.',
  ].join("\n");
}

function buildOutcomeOnlyAuthoringGuidance(): string[] {
  return [
    "For a thread with no pending direct-user answer that only needs an outcome marker, route any accompanying progress, status, recovery, verification, or bookkeeping prose as commentary with `[thread:main:C]` or `[thread:q-N:C]`; do not emit another `:A:<ids>` answer merely to carry that outcome.",
    "Prefer one self-contained explicit answer per user request or grouped request set. A later same-ID answer is only for genuinely useful complementary or corrective information and should avoid repetition because the collapsed view shows the complete answer set.",
  ];
}

function buildNeedsInputPromptReminderContent(missing: TouchedThread[]): string {
  return [
    "Needs-input notification reminder: this leader response appears to ask for a blocking user decision, but no fresh same-thread `takode notify needs-input` notification was created.",
    `Blocking prompt detected for: ${formatThreadLabels(missing)}.`,
    "This is about a missing same-thread needs-input notification after routed leader output; it is not diagnosing missing `[thread:...]` visible-text markers or `# thread:...` shell-command markers.",
    "Send the blocking prompt as routed commentary with `[thread:main:C]` or `[thread:q-N:C]`, then create the fresh same-thread needs-input notification. After the user answers, use a later explicit `[thread:main:A:u1]` or `[thread:q-N:A:u1]` answer.",
    "Existing unresolved needs-input prompts do not cover a new approval or decision prompt.",
  ].join("\n");
}

function formatThreadLabels(threads: TouchedThread[]): string {
  return threads.map((thread) => formatThreadLabel(thread.route.threadKey)).join(", ");
}

function formatThreadLabel(threadKey: string): string {
  return threadKey === "main" ? "Main" : threadKey;
}
