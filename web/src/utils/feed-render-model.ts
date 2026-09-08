import type {
  HistoryWindowState,
  LeaderThreadResponseProjection,
  SessionAttentionRecord,
  SessionNotification,
  ThreadWindowState,
} from "../types.js";
import {
  leaderResponseExactAnswerThreadKey,
  leaderResponseMessageIsAssociatedWithThread,
} from "../../shared/leader-thread-response-routing.js";
import type { ChatMessage } from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import type { FeedSection } from "../components/message-feed-sections.js";
import {
  DEFAULT_VISIBLE_SECTION_COUNT,
  buildFeedSections,
  findPreviousSectionStartIndex,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "../components/message-feed-sections.js";
import {
  collectMergedThreadAttachmentKeysForThread,
  enrichThreadOpenedRecordsWithMovement,
  removeMergedThreadAttachmentMarkers,
} from "../components/message-feed-thread-movement.js";
import {
  buildAttentionLedgerMessages,
  buildAttentionRecords,
  mergeChronologicalMessages,
  type AttentionBoardRowSource,
} from "./attention-records.js";
import {
  collectActiveNeedsInputAnchorMessageIds,
  collectMessageToolUseIds,
  collectRetainedNotificationSourceMessageIds,
  filterMessagesForThread,
  isAllThreadsKey,
  isCrossThreadActivityMarkerMessage,
  isMainThreadKey,
  isThreadAttachmentMarkerMessage,
  isThreadTransitionMarkerMessage,
  normalizeThreadKey,
  recoverRoutedNotificationSourceMessages,
} from "./thread-projection.js";
import { composeSelectedFeedMessages } from "./thread-window-messages.js";
import { sanitizeNotificationMessageTargets } from "./notification-targets.js";
import { filterRootAgentFeedMessages } from "./root-agent-feed-message.js";
import { isFullyResolvedNeedsInputReminder } from "./needs-input-reminder.js";

export interface BuildFeedMessageModelInput {
  leaderSessionId: string;
  threadKey: string;
  projectThreadRoutes: boolean;
  allMessages: ChatMessage[];
  historyLoading: boolean;
  selectedFeedWindowEnabled: boolean;
  selectedFeedWindow: ThreadWindowState | null;
  selectedFeedWindowMessages: ChatMessage[];
  threadResponseState?: LeaderThreadResponseProjection | null;
  sessionNotifications?: ReadonlyArray<SessionNotification>;
  sessionAttentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  additionalAttentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  sessionBoard?: ReadonlyArray<AttentionBoardRowSource>;
  sessionCompletedBoard?: ReadonlyArray<AttentionBoardRowSource>;
}

export interface FeedMessageModel {
  normalizedThreadKey: string;
  messagesAvailableForDerivation: ChatMessage[];
  messagesAvailableForProjection: ChatMessage[];
  /** True when authoritative native-child rows were omitted from the ordinary feed projection. */
  hasFilteredNativeChildMessages: boolean;
  baseMessages: ChatMessage[];
  attentionRecords: SessionAttentionRecord[];
  attentionRecordsWithThreadMovement: SessionAttentionRecord[];
  mergedThreadAttachmentKeys: Set<string>;
  visibleBaseMessages: ChatMessage[];
  attentionLedgerMessages: ChatMessage[];
  messages: ChatMessage[];
  visibleToolUseIds?: Set<string>;
  activeNeedsInputAnchorMessageIds: Set<string>;
}

export function buildFeedMessageModel(input: BuildFeedMessageModelInput): FeedMessageModel {
  const normalizedThreadKey = normalizeThreadKey(input.threadKey || "main");
  const activeSelectedFeedWindow = input.selectedFeedWindowEnabled ? input.selectedFeedWindow : null;
  const sanitizedNotifications = sanitizeNotificationMessageTargets(input.sessionNotifications, [
    ...input.allMessages,
    ...input.selectedFeedWindowMessages,
  ]);
  const retainedMessageIds = collectRetainedNotificationSourceMessageIds(sanitizedNotifications, input.threadKey);
  const activeNeedsInputAnchorMessageIds = collectActiveNeedsInputAnchorMessageIds(
    sanitizedNotifications,
    input.threadKey,
  );
  const messagesAvailableForDerivation = composeSelectedFeedMessages({
    allMessages: input.allMessages,
    historyLoading: input.historyLoading,
    selectedFeedWindow: activeSelectedFeedWindow,
    selectedFeedWindowEnabled: input.selectedFeedWindowEnabled,
    selectedFeedWindowMessages: input.selectedFeedWindowMessages,
    retainedMessageIds,
  });
  const messagesAvailableForProjection = recoverRoutedNotificationSourceMessages(
    messagesAvailableForDerivation,
    sanitizedNotifications,
    input.threadKey,
  );
  const rootMessagesAvailableForDerivation = filterRootAgentFeedMessages(messagesAvailableForDerivation);
  const rootMessagesAvailableForProjection =
    messagesAvailableForProjection === messagesAvailableForDerivation
      ? rootMessagesAvailableForDerivation
      : filterRootAgentFeedMessages(messagesAvailableForProjection);
  const hasFilteredNativeChildMessages =
    rootMessagesAvailableForDerivation.length !== messagesAvailableForDerivation.length;
  const routedBaseMessages = input.projectThreadRoutes
    ? filterProjectedMessagesForThread(rootMessagesAvailableForProjection, input.threadKey, activeSelectedFeedWindow)
    : rootMessagesAvailableForDerivation;
  const baseMessages = input.projectThreadRoutes
    ? filterThreadResponseProofMessages(routedBaseMessages, input.threadResponseState, normalizedThreadKey)
    : routedBaseMessages;
  const records =
    input.additionalAttentionRecords && input.additionalAttentionRecords.length > 0
      ? [...(input.sessionAttentionRecords ?? []), ...input.additionalAttentionRecords]
      : input.sessionAttentionRecords;
  const attentionRecords = buildAttentionRecords({
    leaderSessionId: input.leaderSessionId,
    records,
    notifications: sanitizedNotifications,
    boardRows: input.sessionBoard,
    completedBoardRows: input.sessionCompletedBoard,
    messages: rootMessagesAvailableForDerivation,
  });
  const attentionRecordsWithThreadMovement = enrichThreadOpenedRecordsWithMovement(
    attentionRecords,
    rootMessagesAvailableForProjection,
  );
  const mergedThreadAttachmentKeys = collectMergedThreadAttachmentKeysForThread(
    attentionRecordsWithThreadMovement,
    normalizedThreadKey,
  );
  const visibleBaseMessages = removeMergedThreadAttachmentMarkers(baseMessages, mergedThreadAttachmentKeys).filter(
    (message) =>
      !input.projectThreadRoutes ||
      !isMainThreadKey(normalizedThreadKey) ||
      !isFullyResolvedNeedsInputReminder(message, sanitizedNotifications),
  );
  const baseMessageIds = new Set(visibleBaseMessages.map((message) => message.id));
  const isWindowedMainFeed = input.selectedFeedWindowEnabled && isMainThreadKey(normalizedThreadKey);
  const mainWindowTimestampRange =
    isWindowedMainFeed && input.selectedFeedWindow
      ? messageTimestampRange(filterRootAgentFeedMessages(input.selectedFeedWindowMessages))
      : null;
  const attentionLedgerMessages = buildAttentionLedgerMessages(
    attentionRecordsWithThreadMovement,
    normalizedThreadKey,
    {
      availableMessageIds: baseMessageIds,
      windowedMainFeed: isWindowedMainFeed,
      mainWindowFromTimestamp: mainWindowTimestampRange?.from,
      mainWindowToTimestamp: mainWindowTimestampRange?.to,
    },
  );
  const messages = mergeChronologicalMessages(visibleBaseMessages, attentionLedgerMessages);
  const visibleToolUseIds =
    isMainThreadKey(input.threadKey) || isAllThreadsKey(input.threadKey)
      ? undefined
      : collectMessageToolUseIds(messages);

  return {
    normalizedThreadKey,
    messagesAvailableForDerivation,
    messagesAvailableForProjection,
    hasFilteredNativeChildMessages,
    baseMessages,
    attentionRecords,
    attentionRecordsWithThreadMovement,
    mergedThreadAttachmentKeys,
    visibleBaseMessages,
    attentionLedgerMessages,
    messages,
    visibleToolUseIds,
    activeNeedsInputAnchorMessageIds,
  };
}

function filterThreadResponseProofMessages(
  messages: ChatMessage[],
  state: LeaderThreadResponseProjection | null | undefined,
  threadKey: string,
): ChatMessage[] {
  if (!state || normalizeThreadKey(state.threadKey) !== threadKey || isAllThreadsKey(threadKey)) return messages;
  const referencedIds = new Set(state.currentAnswers.flatMap((answer) => answer.referencedUserMessageIds));
  const answerIds = new Set(state.currentAnswers.map((answer) => answer.currentMessageId));
  return messages.filter((message) => {
    if (message.role === "user" && referencedIds.has(message.id)) {
      return leaderResponseMessageIsAssociatedWithThread(message.metadata ?? {}, threadKey);
    }
    const proof = message.metadata?.threadAnswer;
    if (!proof || answerIds.has(message.id)) return true;
    // Generated answer refs are projection hints. After an association is
    // removed, they cannot keep the answer in an unrelated destination.
    const authoredThreadKey = proof.authoredThreadKey ?? leaderResponseExactAnswerThreadKey(message.metadata ?? {});
    return authoredThreadKey === threadKey;
  });
}

function messageTimestampRange(messages: ReadonlyArray<ChatMessage>): { from: number; to: number } | null {
  let from: number | undefined;
  let to: number | undefined;
  for (const message of messages) {
    if (!Number.isFinite(message.timestamp)) continue;
    from = from === undefined ? message.timestamp : Math.min(from, message.timestamp);
    to = to === undefined ? message.timestamp : Math.max(to, message.timestamp);
  }
  if (from === undefined || to === undefined) return null;
  return { from, to };
}

function filterProjectedMessagesForThread(
  messages: ChatMessage[],
  threadKey: string,
  selectedFeedWindow: ThreadWindowState | null,
): ChatMessage[] {
  if (!selectedFeedWindow || isAllThreadsKey(threadKey)) return filterMessagesForThread(messages, threadKey);

  const threadLocalMessages: ChatMessage[] = [];
  const liveMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (typeof message.historyIndex === "number" && message.historyIndex < selectedFeedWindow.source_history_length) {
      if (!isThreadSystemMarkerMessage(message) || filterMessagesForThread([message], threadKey).length > 0) {
        threadLocalMessages.push(message);
      }
      continue;
    }
    liveMessages.push(message);
  }

  return [...threadLocalMessages, ...filterMessagesForThread(liveMessages, threadKey)];
}

function isThreadSystemMarkerMessage(message: ChatMessage): boolean {
  return (
    isThreadAttachmentMarkerMessage(message) ||
    isThreadTransitionMarkerMessage(message) ||
    isCrossThreadActivityMarkerMessage(message)
  );
}

export interface BuildFeedWindowModelInput {
  turns: Turn[];
  sectionTurnCount: number;
  sectionWindowStart: number | null;
  selectedFeedWindowEnabled: boolean;
  historyWindow: HistoryWindowState | null;
  selectedFeedWindow: ThreadWindowState | null;
  streamingText?: string;
  historyLoading: boolean;
  messageCount: number;
}

export interface FeedWindowModel {
  sections: FeedSection[];
  activeHistoryWindow: HistoryWindowState | null;
  isWindowedHistory: boolean;
  activeThreadWindow: ThreadWindowState | null;
  isWindowedFeed: boolean;
  totalSections: number;
  latestVisibleSectionStartIndex: number;
  visibleSectionStartIndex: number;
  visibleSectionEndIndex: number;
  visibleSections: FeedSection[];
  visibleWindowSignature: string;
  visibleTurns: Turn[];
  showConversationLoading: boolean;
  previousSectionStartIndex: number | null;
  nextSectionStartIndex: number | null;
  hasOlderSections: boolean;
  hasNewerSections: boolean;
}

export function buildFeedWindowModel(input: BuildFeedWindowModelInput): FeedWindowModel {
  const sections = buildFeedSections(input.turns, input.sectionTurnCount);
  const activeHistoryWindow = input.selectedFeedWindowEnabled ? null : input.historyWindow;
  const isWindowedHistory = activeHistoryWindow !== null;
  const activeThreadWindow = input.selectedFeedWindowEnabled ? input.selectedFeedWindow : null;
  const isWindowedFeed = isWindowedHistory || activeThreadWindow !== null;
  const totalSections = sections.length;
  const latestVisibleSectionStartIndex = findVisibleSectionStartIndex(sections, DEFAULT_VISIBLE_SECTION_COUNT);
  const visibleSectionStartIndex = isWindowedFeed ? 0 : (input.sectionWindowStart ?? latestVisibleSectionStartIndex);
  const visibleSectionEndIndex = isWindowedFeed
    ? sections.length
    : findVisibleSectionEndIndex(sections, visibleSectionStartIndex, DEFAULT_VISIBLE_SECTION_COUNT);
  const visibleSections = isWindowedFeed ? sections : sections.slice(visibleSectionStartIndex, visibleSectionEndIndex);
  // Different bounded slices can belong to the same stable human turn. Layout
  // restoration still needs to observe that their loaded range has changed.
  const windowRange = activeThreadWindow
    ? `thread:${activeThreadWindow.from_item}:${activeThreadWindow.item_count}`
    : activeHistoryWindow
      ? `history:${activeHistoryWindow.from_turn}:${activeHistoryWindow.turn_count}`
      : "local";
  const visibleWindowSignature = `${windowRange}|${visibleSections.map((section) => section.id).join("|")}`;
  const visibleTurns = visibleSections.flatMap((section) => section.turns);
  const previousSectionStartIndex = isWindowedFeed
    ? null
    : findPreviousSectionStartIndex(sections, visibleSectionStartIndex);
  const nextSectionStartIndex =
    !isWindowedFeed && visibleSectionStartIndex + 1 < sections.length ? visibleSectionStartIndex + 1 : null;
  const activeThreadAvailability = activeThreadWindow;
  const activeHistoryAvailability = activeHistoryWindow;
  const hasOlderSections = activeThreadAvailability
    ? activeThreadAvailability.has_older_items
    : activeHistoryAvailability
      ? activeHistoryAvailability.has_older_items
      : previousSectionStartIndex !== null;
  const hasNewerSections = activeThreadAvailability
    ? activeThreadAvailability.has_newer_items
    : activeHistoryAvailability
      ? activeHistoryAvailability.has_newer_items
      : input.sectionWindowStart !== null && nextSectionStartIndex !== null;

  return {
    sections,
    activeHistoryWindow,
    isWindowedHistory,
    activeThreadWindow,
    isWindowedFeed,
    totalSections,
    latestVisibleSectionStartIndex,
    visibleSectionStartIndex,
    visibleSectionEndIndex,
    visibleSections,
    visibleWindowSignature,
    visibleTurns,
    showConversationLoading: input.historyLoading && input.messageCount === 0 && !input.streamingText,
    previousSectionStartIndex,
    nextSectionStartIndex,
    hasOlderSections,
    hasNewerSections,
  };
}
