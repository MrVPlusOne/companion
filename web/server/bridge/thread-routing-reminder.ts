import { recordMonitoredThreadResult } from "../thread-monitoring.js";
import type {
  BrowserIncomingMessage,
  ContentBlock,
  SessionNotification,
  ThreadRef,
  ThreadRoutingError,
} from "../session-types.js";
import {
  buildThreadRoutingReminderContent,
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-routing-reminder.js";
import {
  advanceThreadRoutingMarkdownFence,
  formatThreadMarker,
  isThreadTextMarkerLikeAtLineStart,
  parseCommandThreadComment,
  parseThreadTextPrefix,
  parseThreadTextLineStartMarker,
  stripCommandThreadComment,
  type LeaderThreadTextRole,
  type ThreadRoutingMarkdownFenceState,
} from "../../shared/thread-routing.js";
import {
  extractThreadStatusMarkersFromText,
  threadStatusKey,
  type LeaderThreadStatus,
  type ParsedThreadStatusMarker,
} from "../../shared/thread-status-marker.js";
import {
  buildLeaderThreadResponseState,
  leaderResponseThreadKeyForUserMessage,
  pendingLeaderAnswerInputsForThread,
  type LeaderThreadResponseSession,
} from "../leader-thread-response.js";
import {
  inferRecentKnownQuestThreadRoute,
  routeFromHistoryEntry,
  routeKey,
  threadRouteForTarget,
  type ThreadRouteMetadata,
} from "../thread-routing-metadata.js";
import { extractQuestThreadRemindersFromContent } from "./quest-thread-reminder.js";

const THREAD_ROUTING_EXPECTED =
  "Start visible leader text with [thread:main:C], [thread:q-N:C], or an explicit answer marker such as [thread:main:A:u1] / [thread:q-N:A:u1,u2]. Bash commands must start with # thread:main or # thread:q-N.";
const QUEST_QUIZ_DIRECTIVE_LINE_RE = /^\s*\{\[\(Quest Quiz:\s*q-\d+\)\]\}\s*$/i;

export interface LeaderAssistantRouteResult {
  content: ContentBlock[];
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
  threadRoutingError?: ThreadRoutingError;
  leaderThreadRole?: LeaderThreadTextRole;
  leaderAnswerUserMessageIds?: string[];
  questThreadReminders?: string[];
  threadStatusMarkers?: ParsedThreadStatusMarker[];
}

export interface ThreadRoutingReminderInjection {
  content: string;
  route: ThreadRouteMetadata;
  agentSource: {
    sessionId: typeof THREAD_ROUTING_REMINDER_SOURCE_ID;
    sessionLabel: typeof THREAD_ROUTING_REMINDER_SOURCE_LABEL;
  };
}

export interface ThreadRoutingReminderSessionLike {
  messageHistory: BrowserIncomingMessage[];
  userMessageIdsThisTurn?: number[];
  messageCountAtTurnStart?: number;
}

export function leaderTurnObservedHistoryLength(session: ThreadRoutingReminderSessionLike): number | undefined {
  const indexes = (session.userMessageIdsThisTurn ?? []).filter(
    (value) => Number.isInteger(value) && value >= 0 && value < session.messageHistory.length,
  );
  if (indexes.length > 0) return Math.max(...indexes) + 1;
  const turnStart = session.messageCountAtTurnStart;
  return Number.isInteger(turnStart) && turnStart! >= 0 && turnStart! <= session.messageHistory.length
    ? turnStart
    : undefined;
}

export function leaderAssistantControlMetadata(
  session: ThreadRoutingReminderSessionLike,
  routed: Pick<LeaderAssistantRouteResult, "leaderThreadRole" | "leaderAnswerUserMessageIds" | "threadStatusMarkers">,
  hasStableMessageId: boolean,
): Pick<
  BrowserIncomingMessage,
  | "leaderThreadRole"
  | "leaderAnswerUserMessageIds"
  | "leaderAnswerObservedHistoryLength"
  | "deferredThreadStatusMarkers"
> {
  const observedHistoryLength =
    routed.leaderThreadRole === "answer" && hasStableMessageId ? leaderTurnObservedHistoryLength(session) : undefined;
  return {
    ...(routed.leaderThreadRole ? { leaderThreadRole: routed.leaderThreadRole } : {}),
    ...(routed.leaderAnswerUserMessageIds?.length
      ? { leaderAnswerUserMessageIds: routed.leaderAnswerUserMessageIds }
      : {}),
    ...(observedHistoryLength !== undefined ? { leaderAnswerObservedHistoryLength: observedHistoryLength } : {}),
    ...(routed.threadStatusMarkers?.length ? { deferredThreadStatusMarkers: routed.threadStatusMarkers } : {}),
  };
}

export interface LeaderThreadStatusSessionLike {
  id?: string;
  messageHistory?: BrowserIncomingMessage[];
  pendingCodexInputs?: LeaderThreadResponseSession["pendingCodexInputs"];
  notifications?: SessionNotification[];
  state: {
    leaderThreadStatuses?: Record<string, LeaderThreadStatus>;
    threadMonitoring?: import("../../shared/thread-monitoring.js").ThreadMonitoringState;
  };
}

type LeaderReadyBlockerSessionLike = Pick<
  LeaderThreadStatusSessionLike,
  "notifications" | "pendingCodexInputs" | "state"
>;

export interface LeaderThreadStatusUpdateResult {
  records: LeaderThreadStatus[];
  changed: boolean;
  rejectedReadyRoutes?: ThreadRouteMetadata[];
}

function threadRefForTarget(target: { threadKey: string; questId?: string }): ThreadRef | undefined {
  if (target.threadKey === "main") return undefined;
  return {
    threadKey: target.threadKey,
    ...(target.questId ? { questId: target.questId } : {}),
    source: "explicit",
    attachedAt: Date.now(),
  };
}

function mergeThreadRefs(existing: ThreadRef[] | undefined): ThreadRef[] | undefined {
  const refs = new Map<string, ThreadRef>();
  for (const ref of existing ?? []) {
    refs.set(threadStatusKey(ref.threadKey), ref);
  }
  return refs.size > 0 ? [...refs.values()] : undefined;
}

export function hasLeaderRoutedActivityContent(content: ContentBlock[]): boolean {
  return content.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return block.type === "tool_use" || block.type === "tool_result";
  });
}

export function extractLeaderThreadStatusMarkersFromContent(content: ContentBlock[]): {
  content: ContentBlock[];
  markers: ParsedThreadStatusMarker[];
} {
  const markers: ParsedThreadStatusMarker[] = [];
  const nextContent: ContentBlock[] = [];

  for (const block of content) {
    if (block.type !== "text") {
      nextContent.push(block);
      continue;
    }
    const extracted = extractThreadStatusMarkersFromText(block.text);
    markers.push(...extracted.markers);
    if (extracted.text.trim()) {
      nextContent.push({ ...block, text: extracted.text });
    }
  }

  return { content: nextContent, markers };
}

function isMidMessageRouteDividerLine(line: string): boolean {
  return line === "---";
}

function normalizedMidMessageRouteMarkerLine(line: string): string | null {
  if (!isThreadTextMarkerLikeAtLineStart(line)) return null;
  const parsed = parseThreadTextLineStartMarker(line);
  if (!parsed.ok) return line;
  return (
    formatThreadMarker(parsed.target.threadKey, parsed.role, parsed.answerUserMessageIds) +
    (parsed.body ? " " + parsed.body : "")
  );
}

export function splitLeaderAssistantContentAtThreadRouteBoundaries(
  isLeaderSession: boolean,
  content: ContentBlock[],
  parentToolUseId: string | null | undefined,
): ContentBlock[][] {
  if (!isLeaderSession || parentToolUseId) return [content];

  const segments: ContentBlock[][] = [];
  let currentBlocks: ContentBlock[] = [];
  let currentTextLines: string[] = [];
  let canSplitAfterQuiz = false;
  let pendingMidMessageDividerLine: string | null = null;
  let pendingMidMessageDividerBlankLines: string[] = [];
  let markdownFence: ThreadRoutingMarkdownFenceState | null = null;

  const flushText = () => {
    if (pendingMidMessageDividerLine !== null) {
      currentTextLines.push(pendingMidMessageDividerLine);
      currentTextLines.push(...pendingMidMessageDividerBlankLines);
      pendingMidMessageDividerLine = null;
      pendingMidMessageDividerBlankLines = [];
    }
    if (currentTextLines.length === 0) return;
    currentBlocks.push({ type: "text", text: currentTextLines.join("\n") });
    currentTextLines = [];
  };

  const flushSegment = () => {
    flushText();
    if (currentBlocks.length === 0) return;
    segments.push(currentBlocks);
    currentBlocks = [];
  };

  for (const block of content) {
    if (block.type !== "text") {
      flushText();
      currentBlocks.push(block);
      canSplitAfterQuiz = false;
      pendingMidMessageDividerLine = null;
      continue;
    }

    for (const line of block.text.split(/\r?\n/)) {
      const wasInsideFence = markdownFence !== null;
      const fenceTransition = advanceThreadRoutingMarkdownFence(markdownFence, line);
      markdownFence = fenceTransition.fence;
      const isFenceProtectedLine = wasInsideFence || fenceTransition.isFenceLine;

      if (pendingMidMessageDividerLine !== null) {
        const normalizedRouteLine = isFenceProtectedLine ? null : normalizedMidMessageRouteMarkerLine(line);
        if (normalizedRouteLine !== null) {
          pendingMidMessageDividerLine = null;
          pendingMidMessageDividerBlankLines = [];
          flushSegment();
          currentTextLines.push(normalizedRouteLine);
          canSplitAfterQuiz = false;
          continue;
        }
        if (!isFenceProtectedLine && line.trim() === "") {
          pendingMidMessageDividerBlankLines.push(line);
          canSplitAfterQuiz = false;
          continue;
        }
        currentTextLines.push(pendingMidMessageDividerLine);
        currentTextLines.push(...pendingMidMessageDividerBlankLines);
        pendingMidMessageDividerLine = null;
        pendingMidMessageDividerBlankLines = [];
      }

      if (isFenceProtectedLine) {
        currentTextLines.push(line);
        canSplitAfterQuiz = false;
        continue;
      }

      if (isMidMessageRouteDividerLine(line)) {
        pendingMidMessageDividerLine = line;
        pendingMidMessageDividerBlankLines = [];
        canSplitAfterQuiz = false;
        continue;
      }

      const postQuizRouteLine = canSplitAfterQuiz ? normalizedMidMessageRouteMarkerLine(line) : null;
      if (postQuizRouteLine !== null) {
        flushSegment();
        currentTextLines.push(postQuizRouteLine);
        canSplitAfterQuiz = false;
        continue;
      }

      currentTextLines.push(line);
      if (QUEST_QUIZ_DIRECTIVE_LINE_RE.test(line)) {
        canSplitAfterQuiz = true;
      } else if (canSplitAfterQuiz && line.trim() !== "") {
        canSplitAfterQuiz = false;
      }
    }
  }

  flushSegment();
  return segments.length > 0 ? segments : [content];
}

export const splitLeaderAssistantContentAtPostQuizThreadRoutes = splitLeaderAssistantContentAtThreadRouteBoundaries;

function threadRoutingErrorForText(
  parsed: Extract<ReturnType<typeof parseThreadTextPrefix>, { ok: false }>,
  content: ContentBlock[],
): ThreadRoutingError {
  return {
    reason: parsed.reason,
    expected: THREAD_ROUTING_EXPECTED,
    source: "visible_text",
    rawContent: content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
    ...(parsed.marker ? { marker: parsed.marker } : {}),
  };
}

function threadRoutingErrorForCommand(command: string): ThreadRoutingError {
  return {
    reason: "missing",
    expected: THREAD_ROUTING_EXPECTED,
    source: "shell_command",
    rawContent: command,
  };
}

function threadRoutingErrorForMissingRole(marker: string, content: ContentBlock[]): ThreadRoutingError {
  return {
    reason: "missing_role",
    expected: THREAD_ROUTING_EXPECTED,
    source: "visible_text",
    marker,
    rawContent: content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
  };
}

export function normalizeLeaderAssistantRouting(
  isLeaderSession: boolean,
  content: ContentBlock[],
  parentToolUseId: string | null | undefined,
): LeaderAssistantRouteResult {
  if (!isLeaderSession || parentToolUseId) return { content };

  const extracted = extractQuestThreadRemindersFromContent(content);
  const statusExtracted = extractLeaderThreadStatusMarkersFromContent(extracted.content);
  const questThreadReminders = extracted.reminders.length > 0 ? { questThreadReminders: extracted.reminders } : {};
  const threadStatusMarkers =
    statusExtracted.markers.length > 0 ? { threadStatusMarkers: statusExtracted.markers } : {};
  const nextContent = statusExtracted.content.map((block) =>
    block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string"
      ? {
          ...block,
          input: {
            ...block.input,
            command: stripCommandThreadComment(String(block.input.command)),
          },
        }
      : block,
  );

  const firstTextIndex = nextContent.findIndex((block) => block.type === "text" && block.text.trim());
  if (firstTextIndex >= 0) {
    const firstText = nextContent[firstTextIndex] as Extract<ContentBlock, { type: "text" }>;
    const parsed = parseThreadTextPrefix(firstText.text);
    if (!parsed.ok) {
      return {
        content: nextContent,
        threadRoutingError: threadRoutingErrorForText(parsed, content),
        ...questThreadReminders,
        ...threadStatusMarkers,
      };
    }
    const routed = nextContent.slice();
    routed[firstTextIndex] = { ...firstText, text: parsed.body };
    const ref = threadRefForTarget(parsed.target);
    const refs = mergeThreadRefs(ref ? [ref] : undefined);
    return {
      content: routed,
      threadKey: parsed.target.threadKey,
      ...(parsed.target.questId ? { questId: parsed.target.questId } : {}),
      ...(refs ? { threadRefs: refs } : {}),
      ...(parsed.role ? { leaderThreadRole: parsed.role } : {}),
      ...(parsed.answerUserMessageIds?.length ? { leaderAnswerUserMessageIds: parsed.answerUserMessageIds } : {}),
      ...(!parsed.role
        ? { threadRoutingError: threadRoutingErrorForMissingRole(formatThreadMarker(parsed.target.threadKey), content) }
        : {}),
      ...questThreadReminders,
      ...threadStatusMarkers,
    };
  }

  const bashBlocks = statusExtracted.content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string",
  );
  if (bashBlocks.length > 0) {
    const target = parseCommandThreadComment(String(bashBlocks[0].input.command));
    if (!target) {
      return {
        content: nextContent,
        threadRoutingError: threadRoutingErrorForCommand(String(bashBlocks[0].input.command)),
        ...questThreadReminders,
        ...threadStatusMarkers,
      };
    }
    const ref = threadRefForTarget(target);
    const refs = mergeThreadRefs(ref ? [ref] : undefined);
    return {
      content: nextContent,
      threadKey: target.threadKey,
      ...(target.questId ? { questId: target.questId } : {}),
      ...(refs ? { threadRefs: refs } : {}),
      ...questThreadReminders,
      ...threadStatusMarkers,
    };
  }

  return {
    content: nextContent,
    ...questThreadReminders,
    ...threadStatusMarkers,
  };
}

export function hasRouteableNonBashToolActivity(content: ContentBlock[]): boolean {
  return content.some((block) => {
    if (block.type === "tool_result") return true;
    return block.type === "tool_use" && block.name !== "Bash";
  });
}

function shouldPreserveRoutingErrorForRecentThreadFallback(
  error: LeaderAssistantRouteResult["threadRoutingError"],
): boolean {
  if (!error) return false;
  return error.source !== "visible_text" || error.reason !== "missing";
}

export function applyRecentThreadFallbackToLeaderAssistantRouting(
  isLeaderSession: boolean,
  routed: LeaderAssistantRouteResult,
  history: BrowserIncomingMessage[],
  parentToolUseId: string | null | undefined,
): LeaderAssistantRouteResult {
  if (!isLeaderSession || parentToolUseId) return routed;
  if (routed.threadKey) return routed;
  if (!hasRouteableNonBashToolActivity(routed.content)) return routed;
  if (shouldPreserveRoutingErrorForRecentThreadFallback(routed.threadRoutingError)) return routed;

  const fallbackRoute = inferRecentKnownQuestThreadRoute(history);
  if (!fallbackRoute) return routed;
  const { threadRoutingError: _threadRoutingError, ...routeable } = routed;
  return {
    ...routeable,
    threadKey: fallbackRoute.threadKey,
    ...(fallbackRoute.questId ? { questId: fallbackRoute.questId } : {}),
    ...(fallbackRoute.threadRefs?.length ? { threadRefs: fallbackRoute.threadRefs } : {}),
  };
}

export function clearLeaderThreadStatusForActivity(
  session: LeaderThreadStatusSessionLike,
  route: ThreadRouteMetadata | null | undefined,
  anchor: { messageId: string; timestamp: number },
): boolean {
  if (!route) return false;
  const key = routeKey(route);
  const current = session.state.leaderThreadStatuses?.[key];
  if (!current || current.messageId === anchor.messageId) return false;

  const statuses = { ...(session.state.leaderThreadStatuses ?? {}) };
  delete statuses[key];
  session.state.leaderThreadStatuses = statuses;
  return true;
}

export function clearLeaderThreadStatusForCoveredUserMessage(
  session: LeaderThreadStatusSessionLike,
  message: Extract<BrowserIncomingMessage, { type: "user_message" }>,
): boolean {
  if (message.leaderResponseCoverageVersion !== 1 || !message.id) return false;
  const threadKey = leaderResponseThreadKeyForUserMessage(message);
  return threadKey
    ? clearLeaderThreadStatusForActivity(session, threadRouteForTarget(threadKey), {
        messageId: message.id,
        timestamp: message.timestamp,
      })
    : false;
}

export function hasUnresolvedLeaderNeedsInputForThread(
  session: Pick<LeaderReadyBlockerSessionLike, "notifications">,
  requestedThreadKey: string,
): boolean {
  const threadKey = threadStatusKey(requestedThreadKey);
  return (session.notifications ?? []).some(
    (notification) =>
      notification.category === "needs-input" &&
      !notification.done &&
      leaderResponseThreadKeyForUserMessage({
        type: "user_message",
        content: "",
        timestamp: notification.timestamp,
        id: notification.id,
        threadKey: notification.threadKey,
        questId: notification.questId,
        threadRefs: notification.threadRefs,
      }) === threadKey,
  );
}

export function clearLeaderReadyStatusesBlockedByNeedsInput(session: LeaderReadyBlockerSessionLike): boolean {
  const statuses = session.state.leaderThreadStatuses;
  if (!statuses) return false;
  let next: Record<string, LeaderThreadStatus> | null = null;
  for (const [key, status] of Object.entries(statuses)) {
    if (status.kind !== "ready" || !hasUnresolvedLeaderNeedsInputForThread(session, status.threadKey || key)) continue;
    next ??= { ...statuses };
    delete next[key];
  }
  if (!next) return false;
  session.state.leaderThreadStatuses = next;
  return true;
}

export function recordLeaderThreadStatusMarkers(
  session: LeaderThreadStatusSessionLike,
  markers: ParsedThreadStatusMarker[] | undefined,
  anchor: { messageId: string; timestamp: number },
): LeaderThreadStatus[] {
  return updateLeaderThreadStatusesForAssistantOutput(session, markers, anchor).records;
}

export function updateLeaderThreadStatusesForAssistantOutput(
  session: LeaderThreadStatusSessionLike,
  markers: ParsedThreadStatusMarker[] | undefined,
  anchor: { messageId: string; timestamp: number },
  activityRoute?: ThreadRouteMetadata,
): LeaderThreadStatusUpdateResult {
  if (!markers?.length && !activityRoute) return { records: [], changed: false };

  const statuses = { ...(session.state.leaderThreadStatuses ?? {}) };
  const records: LeaderThreadStatus[] = [];
  const rejectedReadyRoutes: ThreadRouteMetadata[] = [];
  const markerThreadKeys = new Set<string>();
  let changed = false;
  for (const marker of markers ?? []) {
    const key = threadStatusKey(marker.target.threadKey);
    const blockedReady =
      marker.kind === "ready" &&
      session.id &&
      session.messageHistory &&
      (buildLeaderThreadResponseState(
        { id: session.id, messageHistory: session.messageHistory },
        marker.target.threadKey,
      ).projection.pendingMessageCount > 0 ||
        pendingLeaderAnswerInputsForThread(session, marker.target.threadKey).count > 0 ||
        hasUnresolvedLeaderNeedsInputForThread(session, marker.target.threadKey));
    if (blockedReady) {
      rejectedReadyRoutes.push(threadRouteForTarget(marker.target.threadKey));
      if (statuses[key]) {
        delete statuses[key];
        changed = true;
      }
      continue;
    }
    markerThreadKeys.add(key);
    const record: LeaderThreadStatus = {
      kind: marker.kind,
      label: marker.label,
      threadKey: marker.target.threadKey,
      ...(marker.target.questId ? { questId: marker.target.questId } : {}),
      summary: marker.summary,
      messageId: anchor.messageId,
      timestamp: anchor.timestamp,
      updatedAt: Date.now(),
    };
    statuses[key] = record;
    if (session.messageHistory)
      recordMonitoredThreadResult({ state: session.state, messageHistory: session.messageHistory }, record);
    records.push(record);
    changed = true;
  }

  if (activityRoute) {
    const touchedKey = routeKey(activityRoute);
    const current = statuses[touchedKey];
    if (current && current.messageId !== anchor.messageId && !markerThreadKeys.has(touchedKey)) {
      delete statuses[touchedKey];
      changed = true;
    }
  }

  if (changed) {
    session.state.leaderThreadStatuses = statuses;
  }
  return {
    records,
    changed,
    ...(rejectedReadyRoutes.length > 0 ? { rejectedReadyRoutes } : {}),
  };
}

function findTriggeringTurnRoute(session: ThreadRoutingReminderSessionLike): ThreadRouteMetadata {
  const ids = session.userMessageIdsThisTurn ?? [];
  for (let index = ids.length - 1; index >= 0; index--) {
    const entry = session.messageHistory[ids[index]!] as BrowserIncomingMessage | undefined;
    const route = routeFromHistoryEntry(entry);
    if (route) return route;
  }
  return threadRouteForTarget("main");
}

function wasTriggeredByThreadRoutingReminder(session: ThreadRoutingReminderSessionLike): boolean {
  for (const historyIndex of session.userMessageIdsThisTurn ?? []) {
    const entry = session.messageHistory[historyIndex] as BrowserIncomingMessage | undefined;
    if (entry?.type !== "user_message") continue;
    if (entry.agentSource?.sessionId === THREAD_ROUTING_REMINDER_SOURCE_ID) return true;
  }
  return false;
}

function firstCurrentTurnHistoryIndex(session: ThreadRoutingReminderSessionLike): number {
  const ids = session.userMessageIdsThisTurn ?? [];
  if (ids.length === 0) return Math.max(0, session.messageHistory.length - 1);
  return Math.max(0, Math.min(...ids));
}

function findThreadRoutingErrorForCurrentTurn(session: ThreadRoutingReminderSessionLike): ThreadRoutingError | null {
  const startIndex = firstCurrentTurnHistoryIndex(session);
  for (let index = session.messageHistory.length - 1; index >= startIndex; index--) {
    const entry = session.messageHistory[index];
    if (!entry) continue;
    if (entry.type === "result") continue;
    if (
      entry.type === "assistant" &&
      entry.threadRoutingError &&
      entry.threadRoutingError.reason !== "invalid_answer_route"
    ) {
      return entry.threadRoutingError;
    }
  }
  return null;
}

export function buildThreadRoutingReminderForCompletedTurn(
  session: ThreadRoutingReminderSessionLike,
): ThreadRoutingReminderInjection | null {
  if (wasTriggeredByThreadRoutingReminder(session)) return null;
  const error = findThreadRoutingErrorForCurrentTurn(session);
  if (!error) return null;
  return {
    content: buildThreadRoutingReminderContent({
      reason: error.reason,
      ...(error.source ? { source: error.source } : {}),
      ...(error.marker ? { marker: error.marker } : {}),
    }),
    route: findTriggeringTurnRoute(session),
    agentSource: {
      sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
    },
  };
}
