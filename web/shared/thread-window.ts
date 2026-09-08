import type {
  BrowserIncomingMessage,
  ContentBlock,
  ThreadWindowEntry,
  ThreadWindowState,
  ThreadTransitionMarker,
  LeaderThreadResponseProjection,
} from "../server/session-types.js";
import {
  leaderResponseAnswerOwnerThreadKeys,
  leaderResponseExactAnswerThreadKey,
  leaderResponseMessageIsAssociatedWithThread,
  leaderResponseOwnerThreadKey,
  leaderResponseProvenCurrentOwnerThreadKey,
} from "./leader-thread-response-routing.js";
import { assignSessionScopedLeaderUserMessageIds } from "./leader-user-message-id.js";
import { deriveWindowAvailability } from "./window-availability.js";
import { isCodexLeaderRecoveryDiagnosticSourceId } from "./injected-event-message.js";
import { toolRelationKey } from "./tool-relation-key.js";
import {
  inferThreadTargetFromTextContent,
  isQuestThreadKey,
  parseCommandThreadComment,
  parseThreadTextPrefix,
} from "./thread-routing.js";

export const MAIN_THREAD_KEY = "main";
export const ALL_THREADS_KEY = "all";
export const THREAD_WINDOW_SUPPORT_RECORD_LIMIT = 64;

export interface BuildThreadWindowInput {
  messageHistory: ReadonlyArray<BrowserIncomingMessage>;
  threadKey: string;
  fromItem: number;
  itemCount: number;
  sectionItemCount: number;
  visibleItemCount: number;
  targetMessageId?: string;
  targetHistoryIndex?: number;
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean;
  currentThreadResponseProjection?: LeaderThreadResponseProjection;
}

interface FeedItem {
  entry: ThreadWindowEntry;
  order: number;
}

interface ConversationRange {
  startItem: number;
  endItem: number;
}

function isConversationStartingUserMessage(
  message: BrowserIncomingMessage | undefined,
): message is Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return message?.type === "user_message" && !isCodexLeaderRecoveryDiagnosticSourceId(message.agentSource?.sessionId);
}

type RouteTarget = { threadKey: string; questId?: string };
type ToolResultPreviewMessage = Extract<BrowserIncomingMessage, { type: "tool_result_preview" }>;
type ToolResultPreviewEntry = ToolResultPreviewMessage["previews"][number];

export function normalizeSelectedFeedThreadKey(threadKey: string): string {
  const normalized = threadKey.trim().toLowerCase();
  return normalized || MAIN_THREAD_KEY;
}

export function getThreadWindowItemCount(visibleItemCount: number, sectionItemCount: number): number {
  return Math.max(1, Math.floor(visibleItemCount)) * Math.max(1, Math.floor(sectionItemCount));
}

export function buildThreadWindowSync(input: BuildThreadWindowInput): {
  threadKey: string;
  entries: ThreadWindowEntry[];
  window: ThreadWindowState;
  threadResponseSupportComplete: boolean;
} {
  const threadKey = normalizeSelectedFeedThreadKey(input.threadKey);
  const sectionItemCount = Math.max(1, Math.floor(input.sectionItemCount));
  const visibleItemCount = Math.max(1, Math.floor(input.visibleItemCount));
  const requestedItemCount = Math.max(
    1,
    Math.floor(input.itemCount || getThreadWindowItemCount(visibleItemCount, sectionItemCount)),
  );
  const items = buildThreadConversationItems(input.messageHistory, threadKey, input.includeMessage);
  const ranges = buildVisibleConversationRanges(items);
  const totalItems = ranges.length;
  const requestedFromItem = Math.floor(input.fromItem);
  const targetRangeIndex = findConversationRangeIndexForTarget(
    items,
    ranges,
    input.targetMessageId,
    input.targetHistoryIndex,
  );
  const initialFromItem =
    totalItems === 0
      ? 0
      : targetRangeIndex != null
        ? Math.max(
            0,
            Math.min(
              targetRangeIndex - Math.floor(requestedItemCount / 2),
              Math.max(0, totalItems - requestedItemCount),
            ),
          )
        : requestedFromItem < 0
          ? Math.max(0, totalItems - requestedItemCount)
          : Math.max(0, Math.min(requestedFromItem, Math.max(0, totalItems - 1)));
  const endItem = Math.min(totalItems, initialFromItem + requestedItemCount);
  const builtEntries = buildThreadWindowEntries({
    messageHistory: input.messageHistory,
    threadKey,
    items,
    ranges,
    fromItem: initialFromItem,
    endItem,
    supportItemLimit: requestedItemCount,
    includeMessage: input.includeMessage,
    currentThreadResponseProjection: input.currentThreadResponseProjection,
  });
  const entries = builtEntries.entries;
  const availability = deriveThreadWindowAvailability({
    items,
    ranges,
    entries,
    fromItem: initialFromItem,
    endItem,
  });
  return {
    threadKey,
    entries,
    threadResponseSupportComplete: builtEntries.threadResponseSupportComplete,
    window: {
      thread_key: threadKey,
      from_item: initialFromItem,
      item_count: Math.max(0, endItem - initialFromItem),
      total_items: totalItems,
      ...availability,
      source_history_length: input.messageHistory.length,
      section_item_count: sectionItemCount,
      visible_item_count: visibleItemCount,
    },
  };
}

function findConversationRangeIndexForTarget(
  items: FeedItem[],
  ranges: ConversationRange[],
  targetMessageId: string | undefined,
  targetHistoryIndex: number | undefined,
): number | null {
  const targetItemIndex = items.findIndex((item) => {
    if (targetMessageId && rawMessageId(item.entry.message, item.entry.history_index) === targetMessageId) return true;
    return typeof targetHistoryIndex === "number" && item.entry.history_index === targetHistoryIndex;
  });
  if (targetItemIndex < 0) return null;
  const rangeIndex = ranges.findIndex((range) => targetItemIndex >= range.startItem && targetItemIndex < range.endItem);
  return rangeIndex >= 0 ? rangeIndex : null;
}

export function buildProjectedThreadEntries(
  messageHistory: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  options?: { includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean },
): ThreadWindowEntry[] {
  const normalizedThreadKey = normalizeSelectedFeedThreadKey(threadKey);
  const items = buildThreadConversationItems(messageHistory, normalizedThreadKey, options?.includeMessage);
  const ranges = buildVisibleConversationRanges(items);
  return buildThreadWindowEntries({
    messageHistory,
    threadKey: normalizedThreadKey,
    items,
    ranges,
    fromItem: 0,
    endItem: ranges.length,
    supportItemLimit: Math.max(1, items.length),
    includeMessage: options?.includeMessage,
  }).entries;
}

function buildThreadWindowEntries(input: {
  messageHistory: ReadonlyArray<BrowserIncomingMessage>;
  threadKey: string;
  items: FeedItem[];
  ranges: ConversationRange[];
  fromItem: number;
  endItem: number;
  supportItemLimit: number;
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean;
  currentThreadResponseProjection?: LeaderThreadResponseProjection;
}): { entries: ThreadWindowEntry[]; threadResponseSupportComplete: boolean } {
  const selectedItems = selectConversationItems(input.items, input.ranges.slice(input.fromItem, input.endItem));
  const selectedOrFallbackItems =
    selectedItems.length > 0
      ? selectedItems
      : selectRecentStandalonePreviewItems(input.items, input.ranges, input.supportItemLimit);
  const responseSupport = addCurrentThreadResponseSupport(
    input.messageHistory,
    input.threadKey,
    selectedOrFallbackItems,
    input.currentThreadResponseProjection,
    input.includeMessage,
  );
  const sourceExpandedItems =
    input.threadKey === MAIN_THREAD_KEY
      ? expandMainAttachmentSourceItems(input.messageHistory, input.items, responseSupport.items, input.includeMessage)
      : responseSupport.items;
  const expandedItems = expandToolClosureItems(
    input.messageHistory,
    sourceExpandedItems,
    { orphanPreviewFallback: selectedItems.length === 0 },
    input.includeMessage,
  );
  return {
    entries: dedupeEntries(
      filterThreadAnswerVisibility(
        expandedItems,
        input.threadKey,
        input.currentThreadResponseProjection,
        responseSupport.complete,
      ),
    ),
    threadResponseSupportComplete: responseSupport.complete,
  };
}

function filterThreadAnswerVisibility(
  items: FeedItem[],
  threadKey: string,
  projection: LeaderThreadResponseProjection | undefined,
  supportComplete: boolean,
): FeedItem[] {
  if (!projection || projection.threadKey !== threadKey || threadKey === ALL_THREADS_KEY) return items;
  const answerIds = new Set(supportComplete ? projection.currentAnswers.map((answer) => answer.currentMessageId) : []);
  return items.filter(({ entry: { message } }) => {
    if (message.type !== "assistant" || !message.threadAnswer || answerIds.has(message.message.id)) return true;
    // Derived visibility needs the complete bounded proof. In fallback history,
    // retain only the authored source; persisted refs cannot bypass this gate.
    const authoredThreadKey = message.threadAnswer.authoredThreadKey ?? leaderResponseExactAnswerThreadKey(message);
    return authoredThreadKey === threadKey;
  });
}

function addCurrentThreadResponseSupport(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  selectedItems: FeedItem[],
  projection: LeaderThreadResponseProjection | undefined,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): { items: FeedItem[]; complete: boolean } {
  if (!projection || normalizeSelectedFeedThreadKey(projection.threadKey) !== threadKey) {
    return { items: selectedItems, complete: true };
  }

  if (
    projection.pendingMessages.length !== projection.pendingMessageCount ||
    projection.ready !== (projection.pendingMessageCount === 0)
  ) {
    return { items: selectedItems, complete: false };
  }

  const referencedIds = new Set<string>();
  for (const answer of projection.currentAnswers) {
    referencedIds.add(answer.currentMessageId);
    answer.referencedUserMessageIds.forEach((id) => referencedIds.add(id));
  }
  projection.pendingMessages.forEach((pending) => referencedIds.add(pending.historyMessageId));
  if (referencedIds.size > THREAD_WINDOW_SUPPORT_RECORD_LIMIT) return { items: selectedItems, complete: false };

  const usersById = new Map<string, { message: BrowserIncomingMessage; historyIndex: number }>();
  const duplicateUserIds = new Set<string>();
  messages.forEach((message, historyIndex) => {
    if (message.type !== "user_message" || !message.id) return;
    if (usersById.has(message.id)) duplicateUserIds.add(message.id);
    usersById.set(message.id, { message, historyIndex });
  });
  const userMessageIdsByHistoryId = projectedLeaderUserMessageIdsByHistoryId(messages);
  const required = new Map<string, FeedItem>();
  const addRequired = (message: BrowserIncomingMessage, historyIndex: number): boolean => {
    if (includeMessage && !includeMessage(message, historyIndex)) return false;
    const item = { order: historyIndex, entry: { message, history_index: historyIndex } };
    required.set(entryKey(item.entry), item);
    return true;
  };

  const pendingHistoryIds = new Set<string>();
  const pendingUserIds = new Set<string>();
  const pendingHistoryIndexes = new Set<number>();
  for (const pending of projection.pendingMessages) {
    const historyIndex = pending.historyIndex;
    const message = Number.isInteger(historyIndex) ? messages[historyIndex] : undefined;
    if (
      pendingHistoryIds.has(pending.historyMessageId) ||
      pendingUserIds.has(pending.userMessageId) ||
      pendingHistoryIndexes.has(historyIndex) ||
      !pendingProjectionMatchesMessage(
        message,
        pending,
        threadKey,
        userMessageIdsByHistoryId.get(pending.historyMessageId),
      ) ||
      !addRequired(message, historyIndex)
    ) {
      return { items: selectedItems, complete: false };
    }
    pendingHistoryIds.add(pending.historyMessageId);
    pendingUserIds.add(pending.userMessageId);
    pendingHistoryIndexes.add(historyIndex);
  }

  if (projection.currentAnswers.length === 0) {
    if (required.size > THREAD_WINDOW_SUPPORT_RECORD_LIMIT) return { items: selectedItems, complete: false };
    return { items: [...selectedItems, ...required.values()], complete: true };
  }

  const seenAnswerMessageIds = new Set<string>();
  const seenAnswerHistoryIndexes = new Set<number>();
  for (const answer of projection.currentAnswers) {
    const historyIndex = answer.currentHistoryIndex;
    const message = messages[historyIndex];
    const answerThreadKey = normalizeSelectedFeedThreadKey(answer.threadKey);
    const associationProjection = answerThreadKey !== threadKey;
    const messageId =
      message?.type === "leader_user_message"
        ? message.id
        : message?.type === "assistant" &&
            message.parent_tool_use_id === null &&
            !message.message.content.some((block) => block.type === "tool_use" || block.type === "tool_result")
          ? message.message.id
          : null;
    const explicitProof =
      answer.source === "explicit" &&
      message?.type === "assistant" &&
      message.leaderThreadRole === "answer" &&
      message.threadAnswer?.version === projection.version &&
      sameStringArray(message.threadAnswer.answerUserMessageIds, answer.answerUserMessageIds);
    const legacyProof =
      answer.source === "legacy" &&
      (message?.type === "leader_user_message" ||
        (message?.type === "assistant" && message.leaderThreadRole === "response")) &&
      sameStringArray(message.threadResponse?.coveredUserMessageIds ?? [], answer.referencedUserMessageIds);
    if (
      !message ||
      (message.type !== "leader_user_message" && message.type !== "assistant") ||
      !messageId ||
      seenAnswerMessageIds.has(messageId) ||
      seenAnswerHistoryIndexes.has(historyIndex) ||
      messageId !== answer.currentMessageId ||
      (!explicitProof && !legacyProof) ||
      (associationProjection && answer.source !== "explicit") ||
      leaderResponseExactAnswerThreadKey(message) !== answerThreadKey ||
      answer.referencedUserMessageIds.length !== answer.answerUserMessageIds.length ||
      answer.coveredUserMessageIds.length !== answer.coveredAnswerUserMessageIds.length ||
      (answer.coveredUserMessageIds.length === 0 && answer.source !== "explicit") ||
      !addRequired(message, historyIndex)
    ) {
      return { items: selectedItems, complete: false };
    }
    seenAnswerMessageIds.add(messageId);
    seenAnswerHistoryIndexes.add(historyIndex);
    const ownerThreadKeys = leaderResponseAnswerOwnerThreadKeys(
      message.type === "assistant" && message.threadAnswer
        ? message.threadAnswer
        : { answerUserMessageIds: answer.answerUserMessageIds },
      answerThreadKey,
    );
    if (!ownerThreadKeys) return { items: selectedItems, complete: false };
    const authoredThreadKey =
      message.type === "assistant" ? (message.threadAnswer?.authoredThreadKey ?? answerThreadKey) : answerThreadKey;
    let visibleInThread = authoredThreadKey === threadKey;

    for (let index = 0; index < answer.referencedUserMessageIds.length; index += 1) {
      const referencedId = answer.referencedUserMessageIds[index]!;
      const referenced = usersById.get(referencedId);
      if (
        !referenced ||
        duplicateUserIds.has(referencedId) ||
        referenced.message.type !== "user_message" ||
        referenced.message.agentSource != null ||
        referenced.message.codexSubagent != null ||
        leaderResponseProvenCurrentOwnerThreadKey(referenced.message) !==
          ownerThreadKeys.get(answer.answerUserMessageIds[index]!) ||
        userMessageIdsByHistoryId.get(referencedId) !== answer.answerUserMessageIds[index] ||
        !addRequired(referenced.message, referenced.historyIndex)
      ) {
        return { items: selectedItems, complete: false };
      }
      visibleInThread ||= leaderResponseMessageIsAssociatedWithThread(referenced.message, threadKey);
    }
    if (!visibleInThread) return { items: selectedItems, complete: false };

    for (let index = 0; index < answer.coveredUserMessageIds.length; index += 1) {
      const coveredId = answer.coveredUserMessageIds[index]!;
      const referencedIndex = answer.referencedUserMessageIds.indexOf(coveredId);
      const covered = usersById.get(coveredId);
      if (
        referencedIndex < 0 ||
        answer.answerUserMessageIds[referencedIndex] !== answer.coveredAnswerUserMessageIds[index] ||
        !covered ||
        leaderResponseProvenCurrentOwnerThreadKey(covered.message) !== threadKey
      ) {
        return { items: selectedItems, complete: false };
      }
    }
  }

  const quizItems = latestQuestQuizSupportItems(messages, threadKey, projection.cutoverHistoryIndex, includeMessage);
  for (const item of quizItems) required.set(entryKey(item.entry), item);

  if (threadKey === MAIN_THREAD_KEY) {
    const sourceHistoryIndexes = [
      ...projection.currentAnswers.map((answer) => answer.currentHistoryIndex),
      ...quizItems.map((item) => item.entry.history_index),
    ];
    const sourceBoundaryItems = mainResponseSourceBoundarySupportItems(messages, sourceHistoryIndexes);
    for (const item of sourceBoundaryItems) {
      if (!addRequired(item.entry.message, item.entry.history_index)) {
        return { items: selectedItems, complete: false };
      }
    }
  }

  if (required.size > THREAD_WINDOW_SUPPORT_RECORD_LIMIT) return { items: selectedItems, complete: false };
  return { items: [...selectedItems, ...required.values()], complete: true };
}

function pendingProjectionMatchesMessage(
  message: BrowserIncomingMessage | undefined,
  pending: LeaderThreadResponseProjection["pendingMessages"][number],
  threadKey: string,
  expectedUserMessageId: string | undefined,
): message is Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return (
    message?.type === "user_message" &&
    message.id === pending.historyMessageId &&
    expectedUserMessageId === pending.userMessageId &&
    message.leaderResponseCoverageVersion === 1 &&
    leaderResponseOwnerThreadKey(message) === threadKey
  );
}

function projectedLeaderUserMessageIdsByHistoryId(
  messages: ReadonlyArray<BrowserIncomingMessage>,
): Map<string, string> {
  const eligible = messages.flatMap((message) =>
    message.type === "user_message" && message.id && message.leaderResponseCoverageVersion === 1 ? [message] : [],
  );
  const assignedIds = assignSessionScopedLeaderUserMessageIds(eligible.map((message) => message.leaderUserMessageId));
  return new Map(eligible.map((message, index) => [message.id!, assignedIds[index]!]));
}

/**
 * Main leader windows do not know which upstream session is the worker's
 * `herdedBy` source. Preserve every user-shaped boundary that could therefore
 * own an answer or Quiz source turn, back to the latest direct-human boundary.
 * The caller's support cap keeps this conservative closure bounded.
 */
function mainResponseSourceBoundarySupportItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  sourceHistoryIndexes: readonly number[],
): FeedItem[] {
  const sourceIndexes = new Set(
    sourceHistoryIndexes.filter((historyIndex) => Number.isInteger(historyIndex) && historyIndex >= 0),
  );
  if (sourceIndexes.size === 0) return [];

  const latestSourceIndex = Math.max(...sourceIndexes);
  const candidateBoundaryIndexes: number[] = [];
  const requiredBoundaryIndexes = new Set<number>();
  for (let historyIndex = 0; historyIndex <= latestSourceIndex; historyIndex += 1) {
    if (sourceIndexes.has(historyIndex)) {
      candidateBoundaryIndexes.forEach((candidateIndex) => requiredBoundaryIndexes.add(candidateIndex));
    }

    const message = messages[historyIndex];
    if (
      !message ||
      !isConversationStartingUserMessage(message) ||
      leaderResponseOwnerThreadKey(message) !== MAIN_THREAD_KEY
    ) {
      continue;
    }
    if (message.agentSource?.sessionId == null) candidateBoundaryIndexes.length = 0;
    candidateBoundaryIndexes.push(historyIndex);
  }

  return [...requiredBoundaryIndexes].map((historyIndex) => ({
    order: historyIndex,
    entry: { message: messages[historyIndex]!, history_index: historyIndex },
  }));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const QUEST_QUIZ_DIRECTIVE_RE = /^\s*\{\[\(Quest Quiz:\s*(q-\d+)\)\]\}\s*$/i;
const MARKDOWN_FENCE_RE = /^\s*(`{3,}|~{3,})/;

function questQuizIds(text: string): string[] {
  const ids: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const token = line.match(MARKDOWN_FENCE_RE)?.[1];
    if (fence) {
      if (token && token[0] === fence.marker && token.length >= fence.length) fence = null;
      continue;
    }
    if (token) {
      fence = { marker: token[0]!, length: token.length };
      continue;
    }
    const match = line.match(QUEST_QUIZ_DIRECTIVE_RE);
    if (match) ids.push(match[1]!.toLowerCase());
  }
  return ids;
}

function questQuizMessageText(message: BrowserIncomingMessage): string | null {
  if (message.type === "leader_user_message") return message.content;
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return null;
  return message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function messageParticipatesInResponseThread(message: BrowserIncomingMessage, threadKey: string): boolean {
  if (message.type === "user_message") return leaderResponseOwnerThreadKey(message) === threadKey;
  return threadKey === MAIN_THREAD_KEY ? !hasExplicitNonMainRoute(message) : messageHasThreadRef(message, threadKey);
}

function latestQuestQuizSupportItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  cutoverHistoryIndex: number,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  const latestByQuest = new Map<string, FeedItem>();
  messages.forEach((message, historyIndex) => {
    const text = questQuizMessageText(message);
    if (
      historyIndex < cutoverHistoryIndex ||
      !text ||
      !messageParticipatesInResponseThread(message, threadKey) ||
      (includeMessage && !includeMessage(message, historyIndex))
    )
      return;
    for (const questId of questQuizIds(text)) {
      latestByQuest.set(questId, { order: historyIndex, entry: { message, history_index: historyIndex } });
    }
  });
  return [...latestByQuest.values()];
}

function threadWindowEntryRendersChatRow(message: BrowserIncomingMessage): boolean {
  // Match the default browser normalization path: previews and successful turn
  // results enrich nearby rows but do not produce standalone feed messages.
  if (message.type === "tool_result_preview") return false;
  if (message.type === "task_notification") return Boolean(message.summary);
  if (message.type === "result") {
    const result = message.data as { is_error?: boolean } | undefined;
    return Boolean(result?.is_error && !message.interrupted);
  }
  return true;
}

function deriveThreadWindowAvailability(input: {
  items: FeedItem[];
  ranges: ConversationRange[];
  entries: ThreadWindowEntry[];
  fromItem: number;
  endItem: number;
}) {
  const fallback = deriveWindowAvailability({
    from: input.fromItem,
    count: Math.max(0, input.endItem - input.fromItem),
    total: input.ranges.length,
  });
  if (input.ranges.length === 0 || input.items.length === 0 || input.entries.length === 0) return fallback;

  const itemIndexByKey = new Map<string, number>();
  input.items.forEach((item, index) => {
    itemIndexByKey.set(entryKey(item.entry), index);
  });

  const representedItemIndexes = new Set<number>();
  input.entries.forEach((entry) => {
    const index = itemIndexByKey.get(entryKey(entry));
    if (index !== undefined) representedItemIndexes.add(index);
  });

  const hasUnrepresentedRangeItems = (range: ConversationRange) => {
    for (let index = range.startItem; index < range.endItem; index++) {
      if (!representedItemIndexes.has(index)) return true;
    }
    return false;
  };

  return {
    has_older_items: input.ranges.some((range, index) => index < input.fromItem && hasUnrepresentedRangeItems(range)),
    has_newer_items: input.ranges.some((range, index) => index >= input.endItem && hasUnrepresentedRangeItems(range)),
  };
}

function buildThreadConversationItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  const items = buildFeedItems(messages, threadKey, includeMessage);
  if (threadKey === ALL_THREADS_KEY) return items;
  return dedupeFeedItems(addTurnClosingResults(items, messages, includeMessage));
}

function buildFeedItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  if (threadKey === ALL_THREADS_KEY) {
    return messages.flatMap((message, index) =>
      includeMessage && !includeMessage(message, index)
        ? []
        : [{ order: index, entry: { message, history_index: index } }],
    );
  }
  if (threadKey === MAIN_THREAD_KEY) return buildMainFeedItems(messages, includeMessage);
  return buildQuestThreadFeedItems(messages, threadKey, includeMessage);
}

function buildMainFeedItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  const items: FeedItem[] = [];
  const toolUseRoutes = toolUseRoutesById(messages, includeMessage);
  let hiddenRun: Array<{ message: BrowserIncomingMessage; index: number }> = [];
  let hiddenRunRoute: RouteTarget | null = null;

  const flushHiddenRun = (throughIndex?: number) => {
    if (!hiddenRunRoute || hiddenRun.length === 0) return;
    const attachAuditItem = buildMainThreadAttachAuditItem(
      hiddenRun,
      hiddenRunRoute,
      messages,
      throughIndex,
      includeMessage,
    );
    if (attachAuditItem) {
      items.push(attachAuditItem);
    } else if (!isQuestThreadKey(hiddenRunRoute.threadKey)) {
      items.push(buildCrossThreadActivityItem(hiddenRun, hiddenRunRoute));
    }
    hiddenRun = [];
    hiddenRunRoute = null;
  };

  messages.forEach((message, index) => {
    if (includeMessage && !includeMessage(message, index)) return;
    if (message.type === "tool_result_preview") {
      const visiblePreview = mainVisibleToolResultPreview(message, toolUseRoutes);
      if (!visiblePreview) return;
      if (visiblePreview !== message) {
        flushHiddenRun();
        items.push({ order: index, entry: { message: visiblePreview, history_index: index } });
        return;
      }
    }
    if (message.type === "thread_attachment_marker") {
      flushHiddenRun(index);
      return;
    }
    if (message.type === "thread_transition_marker") {
      flushHiddenRun();
      if (normalizeSelectedFeedThreadKey(message.sourceThreadKey) === MAIN_THREAD_KEY) {
        items.push({ order: index, entry: { message, history_index: index } });
      }
      return;
    }
    if (!hasExplicitNonMainRoute(message)) {
      flushHiddenRun();
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }

    const route = explicitNonMainRoute(message);
    if (!route || isHerdEventMessage(message)) return;
    if (hiddenRunRoute && hiddenRunRoute.threadKey !== route.threadKey) {
      flushHiddenRun();
    }
    hiddenRunRoute = route;
    hiddenRun.push({ message, index });
  });

  flushHiddenRun();
  return items;
}

function toolUseRoutesById(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): Map<string, RouteTarget | null> {
  const routes = new Map<string, RouteTarget | null>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if ((includeMessage && !includeMessage(message, index)) || message.type !== "assistant") continue;
    const route = explicitNonMainRoute(message);
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      routes.set(toolRelationKey(message, block.id), route);
    }
  }
  return routes;
}

function mainVisibleToolResultPreview(
  message: Extract<BrowserIncomingMessage, { type: "tool_result_preview" }>,
  toolUseRoutes: ReadonlyMap<string, RouteTarget | null>,
): BrowserIncomingMessage | null {
  const previews = message.previews.filter((preview) => {
    const route = toolUseRoutes.get(toolRelationKey(message, preview.tool_use_id));
    return !route || !isQuestThreadKey(route.threadKey);
  });
  if (previews.length === 0) return null;
  if (previews.length === message.previews.length) return message;
  return { ...message, previews };
}

function buildQuestThreadFeedItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  const includedToolRelations = new Set<string>();
  messages.forEach((message, index) => {
    if (includeMessage && !includeMessage(message, index)) return;
    if (
      !messageHasThreadRef(message, threadKey) &&
      !threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)
    ) {
      return;
    }
    for (const relationKey of messageToolRelationKeys(message)) includedToolRelations.add(relationKey);
    if (message.type === "tool_result_preview") {
      for (const preview of message.previews) {
        includedToolRelations.add(toolRelationKey(message, preview.tool_use_id));
      }
    }
    if (typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === "string") {
      includedToolRelations.add(
        toolRelationKey(message, (message as { parent_tool_use_id: string }).parent_tool_use_id),
      );
    }
  });

  const items: FeedItem[] = [];
  messages.forEach((message, index) => {
    if (includeMessage && !includeMessage(message, index)) return;
    if (threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    if (messageHasThreadRef(message, threadKey)) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    if (typeof parentToolUseId === "string" && includedToolRelations.has(toolRelationKey(message, parentToolUseId))) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    if (messageToolRelationKeys(message).some((relationKey) => includedToolRelations.has(relationKey))) {
      items.push({ order: index, entry: { message, history_index: index } });
    }
  });
  return items;
}

function addTurnClosingResults(
  items: FeedItem[],
  messages: ReadonlyArray<BrowserIncomingMessage>,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  if (items.length === 0) return items;

  const includedIndexes = new Set(items.map((item) => item.order));
  const additions: FeedItem[] = [];
  for (const range of buildMessageTurnRanges(messages, includeMessage)) {
    const endMessage = messages[range.endIndex];
    if (
      !endMessage ||
      (includeMessage && !includeMessage(endMessage, range.endIndex)) ||
      endMessage.type !== "result"
    ) {
      continue;
    }
    let hasIncludedTurnContent = false;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      if (includedIndexes.has(index)) {
        hasIncludedTurnContent = true;
        break;
      }
    }
    if (!hasIncludedTurnContent || includedIndexes.has(range.endIndex)) continue;
    additions.push({
      order: range.endIndex,
      entry: { message: endMessage, history_index: range.endIndex },
    });
  }

  return additions.length === 0 ? items : [...items, ...additions];
}

function buildMessageTurnRanges(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = messages.length > 0 ? 0 : -1;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (includeMessage && !includeMessage(message, index)) continue;
    if (isConversationStartingUserMessage(message)) {
      if (startIndex >= 0 && index > startIndex) {
        ranges.push({ startIndex, endIndex: index - 1 });
      }
      startIndex = index;
      continue;
    }
    if (message.type === "result" && startIndex >= 0) {
      ranges.push({ startIndex, endIndex: index });
      startIndex = index + 1;
    }
  }

  if (startIndex >= 0 && startIndex < messages.length) {
    ranges.push({ startIndex, endIndex: messages.length - 1 });
  }
  return ranges;
}

function buildConversationRanges(items: FeedItem[]): ConversationRange[] {
  if (items.length === 0) return [];

  const ranges: ConversationRange[] = [];
  let startItem = 0;
  for (let index = 0; index < items.length; index++) {
    const message = items[index]?.entry.message;
    if (isConversationStartingUserMessage(message) && index > startItem) {
      ranges.push({ startItem, endItem: index });
      startItem = index;
      continue;
    }
    if (message?.type === "result") {
      ranges.push({ startItem, endItem: index + 1 });
      startItem = index + 1;
    }
  }

  if (startItem < items.length) {
    ranges.push({ startItem, endItem: items.length });
  }
  return ranges;
}

function buildVisibleConversationRanges(items: FeedItem[]): ConversationRange[] {
  return buildConversationRanges(items).filter((range) =>
    items.slice(range.startItem, range.endItem).some((item) => threadWindowEntryRendersChatRow(item.entry.message)),
  );
}

function selectConversationItems(items: FeedItem[], ranges: ConversationRange[]): FeedItem[] {
  return ranges.flatMap((range) => items.slice(range.startItem, range.endItem));
}

function selectRecentStandalonePreviewItems(
  items: FeedItem[],
  visibleRanges: ConversationRange[],
  supportItemLimit: number,
): FeedItem[] {
  if (visibleRanges.length > 0) return [];
  return items.filter((item) => item.entry.message.type === "tool_result_preview").slice(-supportItemLimit);
}

function expandMainAttachmentSourceItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  allItems: FeedItem[],
  selectedItems: FeedItem[],
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  if (selectedItems.length === 0) return selectedItems;

  const relevantMarkers = collectSelectedMainAttachmentMarkers(messages, allItems, selectedItems, includeMessage);
  if (relevantMarkers.length === 0) return selectedItems;

  const sourceIds = new Set<string>();
  for (const marker of relevantMarkers) {
    for (const messageId of marker.messageIds) sourceIds.add(messageId);
  }
  if (sourceIds.size === 0) return selectedItems;

  const expanded = [...selectedItems];
  messages.forEach((message, index) => {
    if (includeMessage && !includeMessage(message, index)) return;
    if (!sourceIds.has(rawMessageId(message, index))) return;
    if (!isMainAttachmentSourceMessage(message)) return;
    expanded.push({ order: index, entry: { message, history_index: index } });
  });
  return expanded;
}

function collectSelectedMainAttachmentMarkers(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  allItems: FeedItem[],
  selectedItems: FeedItem[],
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
) {
  const selectedKeys = new Set(selectedItems.map((item) => entryKey(item.entry)));
  const selectedItemIndexes: number[] = [];
  allItems.forEach((item, index) => {
    if (selectedKeys.has(entryKey(item.entry))) selectedItemIndexes.push(index);
  });
  if (selectedItemIndexes.length === 0) return [];

  const selectedSpans = selectedItemIndexes.map((itemIndex) => {
    const previousItemOrder = allItems[itemIndex - 1]?.order ?? -1;
    return { afterOrder: previousItemOrder, throughOrder: allItems[itemIndex]!.order };
  });
  const latestSelectedItemIndex = selectedItemIndexes[selectedItemIndexes.length - 1];
  if (latestSelectedItemIndex === allItems.length - 1) {
    selectedSpans.push({ afterOrder: allItems[latestSelectedItemIndex]!.order, throughOrder: messages.length - 1 });
  }

  return messages.filter((message, index) => {
    if ((includeMessage && !includeMessage(message, index)) || message.type !== "thread_attachment_marker") {
      return false;
    }
    const sourceKey = message.sourceThreadKey ?? message.sourceQuestId;
    if (sourceKey && normalizeSelectedFeedThreadKey(sourceKey) !== MAIN_THREAD_KEY) return false;
    return selectedSpans.some((span) => index > span.afterOrder && index <= span.throughOrder);
  }) as Array<Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>>;
}

function isMainAttachmentSourceMessage(message: BrowserIncomingMessage): boolean {
  if (hasExplicitNonMainRoute(message)) return false;
  return (message.threadRefs ?? []).some((ref) => {
    return ref.source === "backfill" && normalizeSelectedFeedThreadKey(ref.threadKey) !== MAIN_THREAD_KEY;
  });
}

function expandToolClosureItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  selectedItems: FeedItem[],
  options: { orphanPreviewFallback: boolean },
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem[] {
  if (selectedItems.length === 0) return selectedItems;

  const allowedToolRelations = new Set<string>();
  for (const item of selectedItems) {
    if (item.entry.message.type === "tool_result_preview") continue;
    if (!threadWindowEntryRendersChatRow(item.entry.message)) continue;
    for (const relationKey of relatedToolRelationKeys(item.entry.message)) {
      allowedToolRelations.add(relationKey);
    }
  }

  const selectedEntryKeys = new Set(selectedItems.map((item) => entryKey(item.entry)));
  const retainedSelectedSupportKeys = new Set<string>();
  let supportRecordCount = 0;
  for (let index = selectedItems.length - 1; index >= 0; index--) {
    const item = selectedItems[index]!;
    const message = item.entry.message;
    if (message.type === "tool_result_preview" || threadWindowEntryRendersChatRow(message)) continue;
    if (supportRecordCount >= THREAD_WINDOW_SUPPORT_RECORD_LIMIT) continue;
    retainedSelectedSupportKeys.add(entryKey(item.entry));
    supportRecordCount += 1;
  }
  const retainedSelectedItems = selectedItems.filter((item) => {
    const message = item.entry.message;
    if (message.type === "tool_result_preview") return false;
    return threadWindowEntryRendersChatRow(message) || retainedSelectedSupportKeys.has(entryKey(item.entry));
  });

  const previewRelations = options.orphanPreviewFallback
    ? new Set(
        selectedItems.flatMap((item) =>
          item.entry.message.type === "tool_result_preview"
            ? item.entry.message.previews.map((preview) => toolRelationKey(item.entry.message, preview.tool_use_id))
            : [],
        ),
      )
    : allowedToolRelations;
  const eligibleMessages = inputMessagesWithIndexes(messages).filter(
    ({ message, index }) => !includeMessage || includeMessage(message, index),
  );
  const mandatoryPreviewItems = options.orphanPreviewFallback
    ? []
    : collectLatestPreviewItemsForToolRelations(eligibleMessages, allowedToolRelations);
  const mandatoryPreviewRelations = new Set(
    mandatoryPreviewItems.flatMap((item) =>
      item.entry.message.type === "tool_result_preview"
        ? item.entry.message.previews.map((preview) => toolRelationKey(item.entry.message, preview.tool_use_id))
        : [],
    ),
  );
  const supportItems: FeedItem[] = [];
  const previewRelationsAdded = new Set<string>();
  const previewCandidates = options.orphanPreviewFallback
    ? selectedItems.map((item) => ({ message: item.entry.message, index: item.order }))
    : eligibleMessages;
  for (
    let candidateIndex = previewCandidates.length - 1;
    candidateIndex >= 0 && supportRecordCount < THREAD_WINDOW_SUPPORT_RECORD_LIMIT;
    candidateIndex--
  ) {
    const { message, index } = previewCandidates[candidateIndex]!;
    if (message.type === "tool_result_preview") {
      const previews = message.previews
        .filter((preview) => {
          const relationKey = toolRelationKey(message, preview.tool_use_id);
          return (
            previewRelations.has(relationKey) &&
            !mandatoryPreviewRelations.has(relationKey) &&
            !previewRelationsAdded.has(relationKey)
          );
        })
        .slice(0, THREAD_WINDOW_SUPPORT_RECORD_LIMIT - supportRecordCount);
      if (previews.length === 0) continue;
      previews.forEach((preview) => previewRelationsAdded.add(toolRelationKey(message, preview.tool_use_id)));
      supportRecordCount += previews.length;
      supportItems.push({
        order: index,
        entry: {
          message: previews.length === message.previews.length ? message : { ...message, previews },
          history_index: index,
        },
      });
    }
  }

  if (options.orphanPreviewFallback || allowedToolRelations.size === 0) {
    return [...retainedSelectedItems, ...supportItems];
  }

  const closureRelations = new Set<string>();
  for (
    let index = messages.length - 1;
    index >= 0 && supportRecordCount < THREAD_WINDOW_SUPPORT_RECORD_LIMIT;
    index--
  ) {
    const message = messages[index]!;
    if ((includeMessage && !includeMessage(message, index)) || message.type === "tool_result_preview") continue;
    const relationKeys = relatedToolRelationKeys(message).filter(
      (relationKey) => allowedToolRelations.has(relationKey) && !closureRelations.has(relationKey),
    );
    if (relationKeys.length === 0) continue;
    relationKeys.forEach((relationKey) => closureRelations.add(relationKey));
    if (selectedEntryKeys.has(entryKey({ message, history_index: index }))) continue;
    supportRecordCount += 1;
    supportItems.push({ order: index, entry: { message, history_index: index } });
  }
  return [...retainedSelectedItems, ...mandatoryPreviewItems, ...supportItems];
}

function inputMessagesWithIndexes(messages: ReadonlyArray<BrowserIncomingMessage>) {
  return messages.map((message, index) => ({ message, index }));
}

function collectLatestPreviewItemsForToolRelations(
  candidates: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  toolRelations: ReadonlySet<string>,
): FeedItem[] {
  if (toolRelations.size === 0) return [];

  const remainingToolRelations = new Set(toolRelations);
  const previewItems: FeedItem[] = [];
  for (
    let candidateIndex = candidates.length - 1;
    candidateIndex >= 0 && remainingToolRelations.size > 0;
    candidateIndex--
  ) {
    const { message, index } = candidates[candidateIndex]!;
    if (message.type !== "tool_result_preview") continue;

    const previews: ToolResultPreviewEntry[] = [];
    for (const preview of message.previews) {
      const relationKey = toolRelationKey(message, preview.tool_use_id);
      if (!remainingToolRelations.has(relationKey)) continue;
      remainingToolRelations.delete(relationKey);
      previews.push(preview);
    }
    if (previews.length === 0) continue;

    previewItems.push({
      order: index,
      entry: {
        message: previews.length === message.previews.length ? message : { ...message, previews },
        history_index: index,
      },
    });
  }

  return previewItems;
}

function dedupeFeedItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const deduped: FeedItem[] = [];
  for (const item of items.sort((a, b) => a.order - b.order)) {
    const key = entryKey(item.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function dedupeEntries(items: FeedItem[]): ThreadWindowEntry[] {
  const seen = new Set<string>();
  const entries: ThreadWindowEntry[] = [];
  for (const item of items.sort((a, b) => a.order - b.order)) {
    const key = entryKey(item.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item.entry);
  }
  return entries;
}

function entryKey(entry: ThreadWindowEntry): string {
  return `${entry.history_index}:${rawMessageId(entry.message, entry.history_index)}`;
}

function buildCrossThreadActivityItem(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
): FeedItem {
  const first = hiddenRun[0]!;
  const last = hiddenRun[hiddenRun.length - 1] ?? first;
  const firstId = rawMessageId(first.message, first.index);
  const lastId = rawMessageId(last.message, last.index);
  return {
    order: first.index,
    entry: {
      synthetic: true,
      history_index: first.index,
      message: {
        type: "cross_thread_activity_marker",
        id: `cross-thread-activity:${route.threadKey}:${firstId}`,
        timestamp: timestampForRawMessage(last.message),
        threadKey: route.threadKey,
        ...(route.questId ? { questId: route.questId } : {}),
        count: hiddenRun.length,
        firstMessageId: firstId,
        lastMessageId: lastId,
        firstHistoryIndex: first.index,
        lastHistoryIndex: last.index,
        startedAt: timestampForRawMessage(first.message),
        updatedAt: timestampForRawMessage(last.message),
      } as BrowserIncomingMessage,
    },
  };
}

function buildMainThreadAttachAuditItem(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  throughIndex?: number,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): FeedItem | null {
  if (!isQuestThreadKey(route.threadKey)) return null;

  const attachCommand = firstThreadAttachCommand(hiddenRun, route);
  if (!attachCommand) return null;

  const marker = findMainSourceAttachmentMarker(
    messages,
    attachCommand.index,
    throughIndex,
    attachCommand.target,
    includeMessage,
  );
  if (!marker) return null;

  const commandId = rawMessageId(attachCommand.message, attachCommand.index);
  const markerId = rawMessageId(marker.message, marker.index);
  const destination = marker.message.questId ?? marker.message.threadKey;
  const attachedCount = marker.message.count;
  const messageLabel = attachedCount === 1 ? "message" : "messages";
  return {
    order: attachCommand.index,
    entry: {
      synthetic: true,
      history_index: attachCommand.index,
      message: {
        type: "cross_thread_activity_marker",
        id: `thread-attach-audit:${destination}:${commandId}:${markerId}`,
        timestamp: timestampForRawMessage(marker.message),
        threadKey: marker.message.threadKey,
        ...(marker.message.questId ? { questId: marker.message.questId } : {}),
        count: 1,
        activityKind: "thread_attach",
        attachedCount,
        summary: `Thread attach command added ${attachedCount} Main ${messageLabel} to thread:${destination}`,
        firstMessageId: commandId,
        lastMessageId: markerId,
        firstHistoryIndex: attachCommand.index,
        lastHistoryIndex: marker.index,
        startedAt: timestampForRawMessage(attachCommand.message),
        updatedAt: timestampForRawMessage(marker.message),
      } as BrowserIncomingMessage,
    },
  };
}

function firstThreadAttachCommand(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
): { message: BrowserIncomingMessage; index: number; target: RouteTarget } | null {
  for (const item of hiddenRun) {
    const command = threadAttachCommandText(item.message);
    if (!command) continue;
    const target = threadAttachCommandTarget(command);
    if (!target || !sameRouteTarget(target, route)) continue;
    return { ...item, target };
  }
  return null;
}

function threadAttachCommandText(message: BrowserIncomingMessage): string | null {
  if (message.type !== "assistant") return null;
  const block = message.message.content.find((candidate) => {
    return candidate.type === "tool_use" && candidate.name === "Bash" && typeof candidate.input?.command === "string";
  });
  if (!block || block.type !== "tool_use" || block.name !== "Bash" || typeof block.input.command !== "string") {
    return null;
  }
  return /\btakode\s+thread\s+attach\s+q-\d+\b/.test(block.input.command) ? block.input.command : null;
}

function threadAttachCommandTarget(command: string): RouteTarget | null {
  const match = /\btakode\s+thread\s+attach\s+(q-\d+)\b/.exec(command);
  if (!match) return null;
  const threadKey = normalizeSelectedFeedThreadKey(match[1]!);
  return { threadKey, questId: threadKey };
}

function sameRouteTarget(left: RouteTarget, right: RouteTarget): boolean {
  return (
    normalizeSelectedFeedThreadKey(left.threadKey) === normalizeSelectedFeedThreadKey(right.threadKey) ||
    normalizeSelectedFeedThreadKey(left.questId ?? "") === normalizeSelectedFeedThreadKey(right.threadKey) ||
    normalizeSelectedFeedThreadKey(left.threadKey) === normalizeSelectedFeedThreadKey(right.questId ?? "")
  );
}

function findMainSourceAttachmentMarker(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  afterIndex: number,
  throughIndex: number | undefined,
  target: RouteTarget,
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): { message: Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>; index: number } | null {
  const endIndex = throughIndex ?? messages.length - 1;
  for (let index = afterIndex + 1; index <= endIndex; index++) {
    const message = messages[index];
    if (!message || (includeMessage && !includeMessage(message, index))) continue;
    if (message.type !== "thread_attachment_marker") continue;
    if (!sameRouteTarget({ threadKey: message.threadKey, questId: message.questId }, target)) continue;
    if (!attachmentMarkerHasMainSource(message)) continue;
    return { message, index };
  }
  return null;
}

function attachmentMarkerHasMainSource(message: Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>) {
  const sourceKey = message.sourceThreadKey ?? message.sourceQuestId;
  return !sourceKey || normalizeSelectedFeedThreadKey(sourceKey) === MAIN_THREAD_KEY;
}

function normalizedRouteKeys(message: BrowserIncomingMessage, includeBackfill: boolean): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeSelectedFeedThreadKey(value);
    if (!normalized || normalized === MAIN_THREAD_KEY) return;
    keys.add(normalized);
  };

  if (message.type === "thread_attachment_marker" || message.type === "thread_transition_marker") return keys;

  add(message.threadKey);
  add(message.questId);
  for (const ref of message.threadRefs ?? []) {
    if (!includeBackfill && ref.source === "backfill") continue;
    add(ref.threadKey);
    add(ref.questId);
  }

  const repaired = repairedRouteForMessage(message);
  add(repaired?.threadKey);
  add(repaired?.questId);

  const inferred = inferredHerdEventRoute(message);
  add(inferred?.threadKey);
  add(inferred?.questId);
  return keys;
}

function messageHasThreadRef(message: BrowserIncomingMessage, threadKey: string): boolean {
  return normalizedRouteKeys(message, true).has(normalizeSelectedFeedThreadKey(threadKey));
}

function hasExplicitNonMainRoute(message: BrowserIncomingMessage): boolean {
  return normalizedRouteKeys(message, false).size > 0;
}

function explicitNonMainRoute(message: BrowserIncomingMessage): RouteTarget | null {
  const metadataRoute = routeFromMessageFields(message, false);
  if (metadataRoute) return metadataRoute;
  return repairedRouteForMessage(message) ?? inferredHerdEventRoute(message);
}

function routeFromMessageFields(message: BrowserIncomingMessage, includeBackfill: boolean): RouteTarget | null {
  if (message.type === "thread_attachment_marker" || message.type === "thread_transition_marker") return null;
  if (message.threadKey && normalizeSelectedFeedThreadKey(message.threadKey) !== MAIN_THREAD_KEY) {
    return {
      threadKey: normalizeSelectedFeedThreadKey(message.threadKey),
      ...(message.questId ? { questId: message.questId } : {}),
    };
  }
  if (message.questId && normalizeSelectedFeedThreadKey(message.questId) !== MAIN_THREAD_KEY) {
    return { threadKey: normalizeSelectedFeedThreadKey(message.questId), questId: message.questId };
  }
  const ref = (message.threadRefs ?? []).find((candidate) => {
    return (
      (includeBackfill || candidate.source !== "backfill") &&
      normalizeSelectedFeedThreadKey(candidate.threadKey) !== MAIN_THREAD_KEY
    );
  });
  if (!ref) return null;
  return {
    threadKey: normalizeSelectedFeedThreadKey(ref.threadKey),
    ...(ref.questId ? { questId: ref.questId } : {}),
  };
}

function repairedRouteForMessage(message: BrowserIncomingMessage): RouteTarget | null {
  if (message.type === "user_message" || message.type === "leader_user_message") {
    const parsed = parseThreadTextPrefix(message.content);
    return parsed.ok ? parsed.target : null;
  }
  if (message.type !== "assistant") return null;
  const content = message.message.content;
  const firstText = content.find((block) => block.type === "text" && block.text.trim());
  if (firstText?.type === "text") {
    const parsed = parseThreadTextPrefix(firstText.text);
    if (parsed.ok) return parsed.target;
  }
  const firstBash = content.find(
    (block) => block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string",
  );
  if (!firstBash || firstBash.type !== "tool_use" || typeof firstBash.input.command !== "string") return null;
  return parseCommandThreadComment(firstBash.input.command);
}

function isHerdEventMessage(message: BrowserIncomingMessage): boolean {
  return (message as { agentSource?: { sessionId?: string } }).agentSource?.sessionId === "herd-events";
}

function inferredHerdEventRoute(message: BrowserIncomingMessage): RouteTarget | null {
  if (!isHerdEventMessage(message)) return null;
  const content = message.type === "user_message" ? message.content : null;
  if (typeof content !== "string") return null;
  const target = inferThreadTargetFromTextContent(content);
  if (!target || normalizeSelectedFeedThreadKey(target.threadKey) === MAIN_THREAD_KEY) return null;
  return {
    threadKey: normalizeSelectedFeedThreadKey(target.threadKey),
    ...(target.questId ? { questId: target.questId } : {}),
  };
}

function transitionMarkerInvolvesThread(marker: ThreadTransitionMarker, threadKey: string): boolean {
  const target = normalizeSelectedFeedThreadKey(threadKey);
  return (
    normalizeSelectedFeedThreadKey(marker.sourceThreadKey) === target ||
    normalizeSelectedFeedThreadKey(marker.sourceQuestId ?? "") === target ||
    normalizeSelectedFeedThreadKey(marker.threadKey) === target ||
    normalizeSelectedFeedThreadKey(marker.questId ?? "") === target
  );
}

function threadSystemMarkerVisibleInQuestThread(
  message: BrowserIncomingMessage,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
): boolean {
  void messages;
  if (message.type === "thread_attachment_marker") return false;
  if (message.type === "thread_transition_marker") return transitionMarkerInvolvesThread(message, threadKey);
  return false;
}

function messageToolUseIds(message: BrowserIncomingMessage): string[] {
  const blocks = contentBlocksForMessage(message);
  return blocks
    .map((block) => {
      if (block.type === "tool_use") return block.id;
      if (block.type === "tool_result") return block.tool_use_id;
      return null;
    })
    .filter((id): id is string => Boolean(id));
}

function messageToolRelationKeys(message: BrowserIncomingMessage): string[] {
  return messageToolUseIds(message).map((toolUseId) => toolRelationKey(message, toolUseId));
}

function relatedToolRelationKeys(message: BrowserIncomingMessage): string[] {
  const relations = new Set(messageToolRelationKeys(message));
  if (message.type === "tool_result_preview") {
    for (const preview of message.previews) relations.add(toolRelationKey(message, preview.tool_use_id));
  }
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parentToolUseId === "string") relations.add(toolRelationKey(message, parentToolUseId));
  return [...relations];
}

function contentBlocksForMessage(message: BrowserIncomingMessage): ContentBlock[] {
  if (message.type === "assistant") return message.message.content;
  return [];
}

function rawMessageId(message: BrowserIncomingMessage, fallbackIndex: number): string {
  if ("id" in message && typeof message.id === "string") return message.id;
  if (message.type === "assistant") return message.message.id;
  return `history-${fallbackIndex}`;
}

function timestampForRawMessage(message: BrowserIncomingMessage): number {
  if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
  return Date.now();
}
