import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, memo } from "react";
import { useStore } from "../store.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE } from "../utils/herd-event-parser.js";
import { ToolBlock, getPreview, getToolIcon, getToolLabel, ToolIcon, formatDuration } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { ElapsedTimer, FeedStatusPill, PendingCodexInputList, PendingUserUploadList } from "./MessageFeedStatus.js";
import { FeedFooter, TurnEntries } from "./MessageFeedEntries.js";
import { MessageFeedTopControls } from "./MessageFeedTopControls.js";
import { type FeedViewportPosition, getFeedViewportKey } from "../utils/thread-viewport.js";
import {
  CodexTerminalInspector,
  LiveCodexTerminalStub,
  LiveDurationBadge,
  collectCodexTerminalEntries,
  collectLiveSubagentEntries,
  getCodexTerminalRevealAt,
  getLiveSubagentRevealAt,
  type CodexTerminalEntry,
  type LiveSubagentEntry,
} from "./MessageFeedLiveActivity.js";
import {
  DEFAULT_VISIBLE_SECTION_COUNT,
  FEED_SECTION_TURN_COUNT,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  type TurnOffsetIndex,
} from "./message-feed-sections.js";
import {
  EMPTY_MESSAGES,
  collectFeedBlockIdsFromNode,
  escapeSelectorValue,
  formatElapsed,
  buildMinuteBoundaryLabelMap,
  getApprovalBatchFeedBlockId,
  getFooterFeedBlockId,
  getMessageFeedBlockId,
  getSubagentFeedBlockId,
  getToolGroupFeedBlockId,
  getTurnFeedBlockId,
  appendTimedMessagesFromEntries,
  isTimedChatMessage,
} from "./message-feed-utils.js";
import { isSubagentToolName } from "../types.js";
import { isAllThreadsKey, isMainThreadKey, normalizeThreadKey } from "../utils/thread-projection.js";
import { useMessageFeedPending } from "./use-message-feed-pending.js";
import type { SessionAttentionRecord } from "../types.js";
import { YarnBallDot, YarnBallSpinner } from "./CatIcons.js";
import { PawTrailAvatar, PawCounterContext, PawScrollProvider, HidePawContext } from "./PawTrail.js";
import { isTouchDevice } from "../utils/mobile.js";
import { sendToSession } from "../ws.js";
import { canAutoCollapseReadyThread, useCollapsePolicy } from "../hooks/use-collapse-policy.js";
import { useTextSelection } from "../hooks/useTextSelection.js";
import { SelectionContextMenu } from "./SelectionContextMenu.js";
import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { buildFeedMessageModel, buildFeedWindowModel } from "../utils/feed-render-model.js";
import {
  hasMissingSelectedThreadWindowContext,
  shouldShowSelectedThreadWindowLoading,
} from "./message-feed-selected-window.js";
import { useSelectedThreadWindowRefresh } from "./message-feed-selected-thread-refresh.js";
import {
  getSavedViewportRestoreKey,
  readSavedViewportPosition,
  useIdempotentState,
  useExactViewportRestore,
  useViewportBoundaryNavigation,
  useUserViewportNavigationIntent,
} from "./message-feed-viewport-state.js";
import { useMessageFeedSectionWindowLoaders } from "./message-feed-section-window-loaders.js";
import { useMessageFeedBoundedConversation } from "./message-feed-bounded-conversation.js";
import type { UserNavigationTarget } from "./message-feed-user-navigation.js";
import { useMessageFeedUserNavigationTargets, useUserMessageNavigation } from "./message-feed-user-navigation-hook.js";
import { getMissingScrollTargetWindowAction, type PendingTargetWindowRequest } from "./message-feed-scroll-target.js";
import { useThreadWindowRequester } from "./message-feed-thread-window-request.js";
import { flashMessageFeedTarget } from "./message-feed-target-highlight.js";
import {
  getInitialThreadWindowTarget,
  getRouteMessageTargetForThread,
  getSavedViewportTargetMessageId,
} from "./message-feed-route-target.js";
import { findMessageFeedScrollTarget, scrollMessageFeedTargetIntoView } from "./message-feed-target-scroll.js";
import { useMessageFeedManualScrollHandlers } from "./message-feed-manual-scroll.js";
import * as viewportAnchor from "./message-feed-viewport-anchor.js";
import { markHistoryReceiveRenderCommitted } from "../utils/frontend-perf-recorder.js";
import { MessageFeedNavigationControls } from "./MessageFeedNavigationControls.js";
import { resolveThreadResponses } from "./thread-response-presentation.js";
import { MessageFeedCenteredState } from "./MessageFeedCenteredState.js";
import { useCodexSafeFeedModel } from "../hooks/use-codex-safe-feed-model.js";
import { useMessageFeedStatusContentBottomSync, useMessageFeedStatusLayout } from "./use-message-feed-status-layout.js";
import { MessageFeedEndSlack } from "./MessageFeedEndSlack.js";
import { useMessageFeedViewportPersistence } from "./use-message-feed-viewport-persistence.js";
import { noteViewportDeliberateActivity } from "../utils/viewport-handoff-client.js";
import {
  isUserBoundaryEntry,
  type FeedEntry,
  type SubagentBatch,
  type SubagentGroup,
  type ToolMsgGroup,
  type Turn,
  type TurnStats,
} from "../hooks/use-feed-model.js";

export { ElapsedTimer };
export {
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "./message-feed-sections.js";
const LIVE_ACTIVITY_RAIL_DWELL_MS = 5_000;
const EMPTY_ATTENTION_RECORDS: SessionAttentionRecord[] = [];
const SECTION_WINDOW_TRIGGER_PX = 96;
const SECTION_BOUNDARY_CONTROL_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-cc-border bg-cc-card/80 px-3 py-1.5 text-xs text-cc-muted";

export function MessageFeed({
  sessionId,
  threadKey = "main",
  projectThreadRoutes = true,
  sectionTurnCount = FEED_SECTION_TURN_COUNT,
  latestIndicatorMode = "overlay",
  onLatestIndicatorVisibleChange,
  onJumpToLatestReady,
  onSelectThread,
  additionalAttentionRecords = EMPTY_ATTENTION_RECORDS,
  showCodexSubagentControl = true,
}: {
  sessionId: string;
  threadKey?: string;
  projectThreadRoutes?: boolean;
  sectionTurnCount?: number;
  latestIndicatorMode?: "overlay" | "external";
  onLatestIndicatorVisibleChange?: (visible: boolean) => void;
  onJumpToLatestReady?: ((scrollToLatest: (() => void) | null) => void) | undefined;
  onSelectThread?: (threadKey: string) => void;
  additionalAttentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  showCodexSubagentControl?: boolean;
}) {
  const allMessages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const historyLoading = useStore((s) => s.historyLoading.get(sessionId) ?? false);
  const normalizedThreadKey = useMemo(() => normalizeThreadKey(threadKey || "main"), [threadKey]);
  const isLeaderSession = useStore(
    (s) =>
      s.sessions?.get(sessionId)?.isOrchestrator === true ||
      s.sdkSessions?.some((sdk) => sdk.sessionId === sessionId && sdk.isOrchestrator === true) === true,
  );
  const threadResponseState = useStore((s) => s.threadWindowResponseStates?.get(sessionId)?.get(normalizedThreadKey));
  const herdingLeaderSessionId = useStore((s) => s.sdkSessions?.find((sdk) => sdk.sessionId === sessionId)?.herdedBy);
  const userNavigationSourceSessionId = herdingLeaderSessionId ?? sessionId;
  const selectedFeedWindowEnabled = useMemo(() => {
    if (isAllThreadsKey(normalizedThreadKey)) return false;
    return isLeaderSession;
  }, [isLeaderSession, normalizedThreadKey]);
  const collapseLeaderThreadActivity =
    isLeaderSession && !isMainThreadKey(normalizedThreadKey) && !isAllThreadsKey(normalizedThreadKey);
  const viewportKey = useMemo(() => getFeedViewportKey(sessionId, threadKey), [sessionId, threadKey]);
  const {
    feedEndScrollSlack,
    feedEndSlackProps,
    centeredFeedStatusClearancePx,
    floatingStatusHeight,
    mobileNavBottomOffsetPx,
    setFloatingStatusHeight,
    setFloatingStatusRunwayHeight,
    handleThreadStatusLayoutContributionChange,
    visibleThreadStatuses,
    threadStatusLayoutKey,
  } = useMessageFeedStatusLayout(sessionId, normalizedThreadKey);
  const savedScrollPos = readSavedViewportPosition({
    sessionId,
    viewportKey,
    normalizedThreadKey,
    isLeaderSession,
  });
  const savedViewportRestoreKey = getSavedViewportRestoreKey(viewportKey, savedScrollPos);
  const selectedFeedWindow = useStore((s) => s.threadWindows?.get(sessionId)?.get(normalizedThreadKey) ?? null);
  const selectedFeedWindowMessages = useStore(
    (s) => s.threadWindowMessages?.get(sessionId)?.get(normalizedThreadKey) ?? EMPTY_MESSAGES,
  );
  const threadWindowRefreshRevision = useStore((s) => s.threadWindowRefreshRevisions?.get(sessionId) ?? 0);
  const selectedThreadWindowRevision = useStore(
    (s) => s.threadWindowAppliedRevisions?.get(sessionId)?.get(normalizedThreadKey) ?? 0,
  );
  const selectedThreadWindowNeedsRefresh =
    selectedFeedWindowEnabled &&
    selectedFeedWindow !== null &&
    selectedThreadWindowRevision < threadWindowRefreshRevision;
  const scrollToMessageId = useStore((s) => s.scrollToMessageId.get(sessionId));
  const pendingScrollToMessageId = useStore((s) => s.pendingScrollToMessageId?.get(sessionId));
  const routeScrollToMessageId = getRouteMessageTargetForThread(normalizedThreadKey);
  const savedViewportTargetMessageId = getSavedViewportTargetMessageId(savedScrollPos);
  const [pendingInitialThreadWindowKey, setPendingInitialThreadWindowKey] = useState<string | null>(null);
  const connectionStatus = useStore((s) => s.connectionStatus?.get(sessionId) ?? "disconnected");
  const sessionNotifications = useStore((s) => s.sessionNotifications?.get(sessionId));
  const sideChats = useStore((s) => s.sessions.get(sessionId)?.slackThreads);
  const visibleAssistantChildMessageIds = useMemo(
    () => Object.values(sideChats ?? {}).map((sideChat) => sideChat.anchorMessageId),
    [sideChats],
  );
  const sessionAttentionRecords = useStore((s) => s.sessionAttentionRecords?.get(sessionId));
  const sessionBoard = useStore((s) => s.sessionBoards?.get(sessionId));
  const sessionCompletedBoard = useStore((s) => s.sessionCompletedBoards?.get(sessionId));
  const feedMessageModel = useMemo(
    () =>
      buildFeedMessageModel({
        leaderSessionId: sessionId,
        threadKey,
        projectThreadRoutes,
        allMessages,
        historyLoading,
        selectedFeedWindow,
        selectedFeedWindowEnabled,
        selectedFeedWindowMessages,
        threadResponseState,
        sessionNotifications,
        sessionAttentionRecords,
        additionalAttentionRecords,
        sessionBoard,
        sessionCompletedBoard,
      }),
    [
      additionalAttentionRecords,
      allMessages,
      historyLoading,
      projectThreadRoutes,
      selectedFeedWindow,
      selectedFeedWindowEnabled,
      selectedFeedWindowMessages,
      threadResponseState,
      sessionAttentionRecords,
      sessionBoard,
      sessionCompletedBoard,
      sessionId,
      sessionNotifications,
      threadKey,
    ],
  );
  const { messages, visibleToolUseIds, hasFilteredNativeChildMessages, activeNeedsInputAnchorMessageIds } =
    feedMessageModel;
  const { pendingUserUploads, pendingCodexInputs } = useMessageFeedPending(sessionId, normalizedThreadKey);
  const frozenCount = useStore((s) => s.messageFrozenCounts.get(sessionId) ?? 0);
  const frozenRevision = useStore((s) => s.messageFrozenRevisions.get(sessionId) ?? 0);
  const historyWindow = useStore((s) => s.historyWindows.get(sessionId) ?? null);
  const leaderProjection = useStore((s) => s.leaderProjections?.get(sessionId) ?? null);
  const starredMessages = useStore((s) => s.sessions.get(sessionId)?.starredMessages);
  const streamingText = useStore((s) => s.streaming.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const toolResults = useStore((s) => s.toolResults.get(sessionId));
  const toolStartTimestamps = useStore((s) => s.toolStartTimestamps.get(sessionId));
  const backgroundAgentNotifs = useStore((s) => s.backgroundAgentNotifs.get(sessionId));
  const currentSessionStatus = useStore((s) => s.sessionStatus.get(sessionId) ?? null);
  const activeTurnRoute = useStore((s) => s.activeTurnRoutes?.get(sessionId) ?? null);
  const parentStreamingByToolUseId = useStore((s) => s.streamingByParentToolUseId.get(sessionId));
  const shouldBottomAlignNextUserMessage = useStore((s) => s.bottomAlignNextUserMessage.has(sessionId));
  const pawCounter = useRef<import("./PawTrail.js").PawCounterState>({ next: 0, cache: new Map() });
  const containerRef = useRef<HTMLDivElement>(null);
  const textSelection = useTextSelection(containerRef);
  const contentRootRef = useRef<HTMLDivElement>(null);
  const feedEndScrollSlackRef = useRef(feedEndScrollSlack);
  feedEndScrollSlackRef.current = feedEndScrollSlack;
  const autoFollowEnabledRef = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const isNearBottom = useRef(savedScrollPos ? savedScrollPos.isAtBottom : true);
  const lastScrollTopRef = useRef(savedScrollPos?.scrollTop ?? 0);
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const bottomAlignMessageIdRef = useRef<string | null>(null);
  const pendingChangedFeedBlockIdsRef = useRef<Set<string>>(new Set());
  const pendingAutoFollowFallbackRef = useRef(false);
  const autoFollowRafRef = useRef<number | null>(null);
  const didTrackContentRef = useRef(false);
  const lastSeenContentBottomRef = useRef<number | null>(null);
  const lastObservedContentBottomRef = useRef<number | null>(null);
  const suppressLatestPillOnRestoreRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useIdempotentState(false);
  const [showLatestPill, setShowLatestPill] = useIdempotentState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [sectionWindowStart, setSectionWindowStart] = useState<number | null>(null);
  const [pendingSectionLoadDirection, setPendingSectionLoadDirection] = useState<"older" | "newer" | null>(null);
  const [selectedCodexTerminalId, setSelectedCodexTerminalId] = useState<string | null>(null);
  const [dismissedSubagentChips, setDismissedSubagentChips] = useState<Map<string, string>>(new Map());
  const [liveActivityRailVersion, setLiveActivityRailVersion] = useState(0);
  const [navigatorStarredOnly, setNavigatorStarredOnly] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isTouch = useMemo(() => isTouchDevice(), []);
  const taskTurnOffsetsRef = useRef<TurnOffsetIndex[]>([]);
  const restoredViewportRef = useRef<{ key: string; container: HTMLDivElement | null } | null>(null);
  const restoredViewportScopeRef = useRef(`${sessionId}:${normalizedThreadKey}`);
  const overlayViewportRef = useRef<HTMLDivElement>(null);
  const lastViewportAnchorRef = useRef<{
    viewportKey: string;
    signature: string;
    wasAutoFollowing: boolean;
    anchor: viewportAnchor.FeedViewportAnchor | null;
  } | null>(null);
  const pendingSectionLoadKeyRef = useRef<string | null>(null);
  const pendingTargetWindowRequestRef = useRef<PendingTargetWindowRequest | null>(null);
  const notedDeliberateMessageTargetRef = useRef<string | null>(null);
  const pendingViewportAnchorWindowRequestRef = useRef<PendingTargetWindowRequest | null>(null);
  const [exactRestoreRef, cancelExactRestore] = useExactViewportRestore(restoredViewportRef, containerRef);
  const handleUserNavigationIntent = useUserViewportNavigationIntent(
    cancelExactRestore,
    sessionId,
    normalizedThreadKey,
  );

  useLayoutEffect(() => {
    markHistoryReceiveRenderCommitted(sessionId);
  }, [allMessages, historyLoading, historyWindow, leaderProjection, selectedFeedWindow, sessionId]);

  useLayoutEffect(() => {
    const scope = `${sessionId}:${normalizedThreadKey}`;
    if (restoredViewportScopeRef.current === scope) return;
    restoredViewportScopeRef.current = scope;
    restoredViewportRef.current = null;
    lastViewportAnchorRef.current = null;
    pendingTargetWindowRequestRef.current = null;
    pendingViewportAnchorWindowRequestRef.current = null;
    exactRestoreRef.current = null;
  }, [normalizedThreadKey, sessionId]);

  const codexTerminalEntries = useMemo(
    () => (isCodexSession ? collectCodexTerminalEntries(messages, toolResults, toolProgress, toolStartTimestamps) : []),
    [isCodexSession, messages, toolProgress, toolResults, toolStartTimestamps],
  );
  const { turns } = useCodexSafeFeedModel({
    messages,
    // The canonical frozen count is indexed against the unfiltered store. Once
    // native-child rows are removed, that prefix no longer aligns with the
    // projected array and can split adjacent live root activity across cache
    // boundaries. Rebuild the bounded root projection instead.
    frozenCount: hasFilteredNativeChildMessages ? 0 : frozenCount,
    isCodexSession,
    leaderMode: collapseLeaderThreadActivity,
    leaderSessionMode: isLeaderSession && isCodexSession,
    frozenRevision,
    sessionNotifications,
    userBoundarySourceSessionId: herdingLeaderSessionId ?? null,
    visibleAssistantChildMessageIds,
    perf: { sessionId, threadKey: normalizedThreadKey },
  });
  const latestGlobalMessageId = allMessages.at(-1)?.id ?? "";
  const userNavigationTargets = useMessageFeedUserNavigationTargets({
    allMessagesLength: allMessages.length,
    herdingLeaderSessionId,
    isLeaderSession,
    latestGlobalMessageId,
    normalizedThreadKey,
    sessionId,
    starredMessages,
    threadWindowRefreshRevision,
    turns,
    userNavigationSourceSessionId,
  });
  const activeUserNavigationTargets = useMemo(
    () => (navigatorStarredOnly ? userNavigationTargets.filter((target) => target.starred) : userNavigationTargets),
    [navigatorStarredOnly, userNavigationTargets],
  );
  const activeLiveSubagentEntries = useMemo(
    () =>
      collectLiveSubagentEntries(
        turns,
        currentSessionStatus,
        toolResults,
        toolProgress,
        toolStartTimestamps,
        backgroundAgentNotifs,
        parentStreamingByToolUseId,
      ),
    [
      backgroundAgentNotifs,
      currentSessionStatus,
      parentStreamingByToolUseId,
      toolProgress,
      toolResults,
      toolStartTimestamps,
      turns,
    ],
  );
  const activeCodexTerminalEntries = useMemo(
    () => (currentSessionStatus === "running" ? codexTerminalEntries.filter((entry) => entry.result == null) : []),
    [codexTerminalEntries, currentSessionStatus],
  );
  const visibleLiveSubagentEntries = useMemo(() => {
    const now = Date.now();
    return activeLiveSubagentEntries.filter(
      (entry) =>
        getLiveSubagentRevealAt(entry, now) <= now &&
        dismissedSubagentChips.get(entry.taskToolUseId) !== entry.freshnessToken,
    );
  }, [activeLiveSubagentEntries, dismissedSubagentChips, liveActivityRailVersion]);
  const visibleCodexTerminalRailEntries = useMemo(() => {
    const now = Date.now();
    return activeCodexTerminalEntries.filter((entry) => getCodexTerminalRevealAt(entry, now) <= now);
  }, [activeCodexTerminalEntries, liveActivityRailVersion]);
  const activeCodexTerminalIds = useMemo(
    () => new Set(activeCodexTerminalEntries.map((entry) => entry.toolUseId)),
    [activeCodexTerminalEntries],
  );
  const selectedCodexTerminal = useMemo(
    () => codexTerminalEntries.find((entry) => entry.toolUseId === selectedCodexTerminalId) ?? null,
    [codexTerminalEntries, selectedCodexTerminalId],
  );
  const latestMessage = messages[messages.length - 1] ?? null;
  useEffect(() => {
    if (!selectedCodexTerminalId) return;
    if (codexTerminalEntries.some((entry) => entry.toolUseId === selectedCodexTerminalId)) return;
    setSelectedCodexTerminalId(null);
  }, [codexTerminalEntries, selectedCodexTerminalId]);

  useEffect(() => {
    if (activeCodexTerminalEntries.length === 0 && activeLiveSubagentEntries.length === 0) return;
    const now = Date.now();
    const pendingRevealTimes = [
      ...activeCodexTerminalEntries.map((entry) => getCodexTerminalRevealAt(entry, now)),
      ...activeLiveSubagentEntries.map((entry) => getLiveSubagentRevealAt(entry, now)),
    ].filter((revealAt) => revealAt > now);
    if (pendingRevealTimes.length === 0) return;
    const nextRevealAt = Math.min(...pendingRevealTimes);
    const timeout = setTimeout(() => {
      setLiveActivityRailVersion((version) => version + 1);
    }, nextRevealAt - now);
    return () => clearTimeout(timeout);
  }, [activeCodexTerminalEntries, activeLiveSubagentEntries]);

  const findVisibleTurnAnchor = useCallback(viewportAnchor.findVisibleTurnAnchorInContainer, []);
  const findVisibleFeedAnchor = useCallback(viewportAnchor.findVisibleFeedAnchorInContainer, []);

  const markProgrammaticScroll = useCallback((top: number) => {
    programmaticScrollTargetRef.current = top;
  }, []);

  const setContainerScrollTop = useCallback(
    (top: number) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTop = top;
      lastScrollTopRef.current = top;
    },
    [markProgrammaticScroll],
  );

  const scrollContainerTo = useCallback(
    (top: number, behavior: ScrollBehavior) => {
      const container = containerRef.current;
      if (!container) return;
      markProgrammaticScroll(top);
      container.scrollTo({ top, behavior });
      if (behavior !== "smooth") {
        lastScrollTopRef.current = top;
      }
    },
    [markProgrammaticScroll],
  );

  const getFeedBlockBottom = useCallback((container: HTMLDivElement, element: HTMLElement) => {
    const offsetBottom = element.offsetTop + element.offsetHeight;
    if (offsetBottom > 0) {
      return offsetBottom;
    }
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 || rect.bottom !== containerRect.top) {
      return container.scrollTop + (rect.bottom - containerRect.top);
    }
    return container.scrollHeight;
  }, []);

  const getRealContentBottom = useCallback(() => {
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container) return null;
    const fallbackBottom = Math.max(0, Math.round(container.scrollHeight - feedEndScrollSlackRef.current));
    if (!contentRoot) return fallbackBottom;
    const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
    if (blocks.length === 0) {
      return fallbackBottom;
    }
    let maxBottom = 0;
    for (const block of blocks) {
      maxBottom = Math.max(maxBottom, getFeedBlockBottom(container, block));
    }
    if (maxBottom >= container.scrollHeight - 1) {
      return fallbackBottom;
    }
    return Math.max(0, Math.min(fallbackBottom, Math.round(maxBottom)));
  }, [getFeedBlockBottom]);

  const getLowestFeedBlockBottom = useCallback(
    (blockIds: Iterable<string>, fallbackToLatestBlock = false) => {
      const container = containerRef.current;
      const contentRoot = contentRootRef.current;
      if (!container || !contentRoot) return null;

      let maxBottom: number | null = null;
      for (const blockId of blockIds) {
        const element = contentRoot.querySelector<HTMLElement>(
          `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
        );
        if (!element) continue;
        const bottom = getFeedBlockBottom(container, element);
        maxBottom = maxBottom == null ? bottom : Math.max(maxBottom, bottom);
      }

      if (maxBottom != null || !fallbackToLatestBlock) {
        return maxBottom;
      }

      const blocks = contentRoot.querySelectorAll<HTMLElement>("[data-feed-block-id]");
      const lastBlock = blocks[blocks.length - 1];
      return lastBlock ? getFeedBlockBottom(container, lastBlock) : null;
    },
    [getFeedBlockBottom],
  );

  useMessageFeedViewportPersistence({
    autoFollowEnabledRef,
    containerRef,
    exactRestoreRef,
    findVisibleFeedAnchor,
    getRealContentBottom,
    isLeaderSession,
    isNearBottom,
    lastSeenContentBottomRef,
    normalizedThreadKey,
    pendingScrollToMessageId,
    scrollToMessageId,
    sessionId,
    viewportKey,
  });

  const feedWindowModel = useMemo(
    () =>
      buildFeedWindowModel({
        turns,
        sectionTurnCount,
        sectionWindowStart,
        selectedFeedWindowEnabled,
        historyWindow,
        selectedFeedWindow,
        streamingText,
        historyLoading,
        messageCount: messages.length,
      }),
    [
      historyLoading,
      historyWindow,
      messages.length,
      sectionTurnCount,
      sectionWindowStart,
      selectedFeedWindow,
      selectedFeedWindowEnabled,
      streamingText,
      turns,
    ],
  );
  const {
    sections,
    activeHistoryWindow,
    activeThreadWindow,
    isWindowedFeed,
    totalSections,
    latestVisibleSectionStartIndex,
    visibleSectionStartIndex,
    visibleSections,
    visibleWindowSignature,
    visibleTurns,
    showConversationLoading,
    previousSectionStartIndex,
    nextSectionStartIndex,
    hasOlderSections,
    hasNewerSections,
  } = feedWindowModel;
  const threadResponsePresentation = resolveThreadResponses(
    visibleSections,
    threadResponseState,
    normalizedThreadKey,
    isLeaderSession,
    feedMessageModel.messagesAvailableForDerivation,
  );
  const latestThreadResponseUpdatedAt = Math.max(
    0,
    ...(threadResponsePresentation?.currentResponses
      .filter((item) => item.response.coveredUserMessageIds.length > 0)
      .map((item) => item.response.updatedAt) ?? []),
  );
  const responseStateHasTrackedWork =
    threadResponseState != null &&
    (threadResponseState.pendingMessageCount > 0 || threadResponseState.currentAnswers.length > 0);
  const readyCollapseSettled = canAutoCollapseReadyThread({
    activeTurnThreadKey: activeTurnRoute?.threadKey,
    currentThreadKey: normalizedThreadKey,
    sessionStatus: currentSessionStatus,
  });
  const validatedReadyCollapse = readyCollapseSettled && threadResponsePresentation?.ready === true;
  // Main owns Ready collapse too; All Threads remains aggregate and leaderMode stays quest-only.
  const fallbackReadyCollapse =
    readyCollapseSettled && isLeaderSession && !isAllThreadsKey(normalizedThreadKey) && !responseStateHasTrackedWork;
  const isLoadingOlderSection = pendingSectionLoadDirection === "older";
  const isLoadingNewerSection = pendingSectionLoadDirection === "newer";
  const latestPillLabel = hasNewerSections ? "Latest section below" : "New content below";
  const missingSelectedWindowHasContext = hasMissingSelectedThreadWindowContext({
    selectedFeedWindowEnabled,
    hasActiveThreadWindow: Boolean(activeThreadWindow),
    historyLoading,
    messageCount: allMessages.length,
    frozenCount,
    historyWindowTotalTurns: historyWindow?.total_turns ?? 0,
    leaderProjectionSourceHistoryLength: leaderProjection?.sourceHistoryLength ?? 0,
  });
  const { turnStates, toggleTurn } = useCollapsePolicy({
    autoCollapseReadyAfter: validatedReadyCollapse ? latestThreadResponseUpdatedAt : null,
    autoCollapseReadyThreadKey: validatedReadyCollapse || fallbackReadyCollapse ? normalizedThreadKey : null,
    sessionId,
    turns: visibleTurns,
  });
  const collapseLayoutSignature = useMemo(
    () => turnStates.map((state) => `${state.turnId}:${state.isActivityExpanded ? "1" : "0"}`).join("|"),
    [turnStates],
  );
  const activeNeedsInputAnchorSignature = [...activeNeedsInputAnchorMessageIds].sort().join(",");
  const viewportLayoutSignature = `${visibleWindowSignature}::${collapseLayoutSignature}::${threadResponsePresentation?.layoutSignature ?? "no-responses"}::${activeNeedsInputAnchorSignature}`;

  const markSectionLoadPending = useCallback((direction: "older" | "newer", key: string) => {
    if (pendingSectionLoadKeyRef.current === key) return false;
    pendingSectionLoadKeyRef.current = key;
    setPendingSectionLoadDirection(direction);
    return true;
  }, []);

  const requestThreadWindow = useThreadWindowRequester({
    activeThreadWindow,
    normalizedThreadKey,
    sectionTurnCount,
    sessionId,
    setPendingInitialThreadWindowKey,
  });

  useSelectedThreadWindowRefresh({
    activeThreadWindow,
    connectionStatus,
    normalizedThreadKey,
    requestThreadWindow,
    selectedFeedWindowEnabled,
    selectedThreadWindowNeedsRefresh,
    sessionId,
    targetMessageId: getInitialThreadWindowTarget(
      scrollToMessageId,
      pendingScrollToMessageId,
      routeScrollToMessageId,
      savedViewportTargetMessageId,
    ),
  });

  useEffect(() => {
    if (selectedFeedWindowEnabled && !activeThreadWindow) return;
    setPendingInitialThreadWindowKey((current) => (current === normalizedThreadKey ? null : current));
  }, [activeThreadWindow, normalizedThreadKey, selectedFeedWindowEnabled]);

  useEffect(() => {
    pendingSectionLoadKeyRef.current = null;
    setPendingSectionLoadDirection(null);
  }, [activeHistoryWindow, activeThreadWindow, sectionWindowStart]);
  const collapsibleTurnIds = useMemo(
    () => visibleTurns.filter((t) => t.agentEntries.length > 0).map((t) => t.id),
    [visibleTurns],
  );

  useEffect(() => {
    useStore.getState().setCollapsibleTurnIds(sessionId, collapsibleTurnIds);
  }, [sessionId, collapsibleTurnIds]);

  useEffect(() => {
    if (isWindowedFeed) {
      setSectionWindowStart(null);
      return;
    }
    setSectionWindowStart((current) => {
      if (current == null) return null;
      if (sections.length === 0) return null;
      const normalizedCurrent = Math.min(current, sections.length - 1);
      const next = findSectionWindowStartIndexForTarget(sections, normalizedCurrent, DEFAULT_VISIBLE_SECTION_COUNT);
      return next === latestVisibleSectionStartIndex ? null : next;
    });
  }, [isWindowedFeed, latestVisibleSectionStartIndex, sections]);

  const getSectionWindowStartForTurnId = useCallback(
    (turnId: string): number | null => {
      const targetSectionIndex = sections.findIndex((section) => section.turns.some((turn) => turn.id === turnId));
      if (targetSectionIndex < 0) return null;
      const nextStartIndex = findSectionWindowStartIndexForTarget(
        sections,
        targetSectionIndex,
        DEFAULT_VISIBLE_SECTION_COUNT,
      );
      return nextStartIndex === latestVisibleSectionStartIndex ? null : nextStartIndex;
    },
    [latestVisibleSectionStartIndex, sections],
  );

  const restoreTurnAnchor = useCallback(
    (anchorTurnId: string, anchorOffsetTop = 0) => {
      const container = containerRef.current;
      if (!container) return false;
      const target = container.querySelector<HTMLElement>(`[data-turn-id="${escapeSelectorValue(anchorTurnId)}"]`);
      if (!target) return false;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchorOffsetTop;
      markProgrammaticScroll(nextTop);
      container.scrollTop = nextTop;
      lastScrollTopRef.current = container.scrollTop;
      return true;
    },
    [markProgrammaticScroll],
  );

  const restoreSavedScrollPosition = useCallback(
    (pos: FeedViewportPosition) => {
      const el = containerRef.current;
      if (!el) return false;
      const nextTop =
        el.scrollHeight === pos.scrollHeight
          ? pos.scrollTop
          : pos.scrollHeight > 0
            ? pos.scrollTop * (el.scrollHeight / pos.scrollHeight)
            : null;
      if (nextTop == null || !Number.isFinite(nextTop)) return false;
      markProgrammaticScroll(nextTop);
      el.scrollTop = nextTop;
      lastScrollTopRef.current = el.scrollTop;
      return true;
    },
    [markProgrammaticScroll],
  );

  const restoreFeedAnchor = useCallback(
    (anchor: viewportAnchor.FeedViewportAnchor) => {
      const container = containerRef.current;
      if (!container) return false;

      const restoreSelector = (selector: string) => {
        const target = container.querySelector<HTMLElement>(selector);
        if (!target) return false;
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop = container.scrollTop + targetRect.top - containerRect.top - anchor.offsetTop;
        markProgrammaticScroll(nextTop);
        container.scrollTop = nextTop;
        lastScrollTopRef.current = container.scrollTop;
        return true;
      };

      if (anchor.messageId && restoreSelector(`[data-message-id="${escapeSelectorValue(anchor.messageId)}"]`)) {
        return true;
      }

      if (anchor.turnId && restoreSelector(`[data-turn-id="${escapeSelectorValue(anchor.turnId)}"]`)) {
        return true;
      }

      return false;
    },
    [markProgrammaticScroll],
  );

  const restoreSavedViewportAnchor = useCallback(
    (pos: FeedViewportPosition) => {
      if (pos.anchorMessageId) {
        if (
          restoreFeedAnchor({
            messageId: pos.anchorMessageId,
            turnId: null,
            offsetTop: pos.anchorOffsetTop ?? 0,
          })
        ) {
          return true;
        }
        if (pos.anchorTurnId && restoreTurnAnchor(pos.anchorTurnId, 0)) {
          return true;
        }
        return false;
      }
      return pos.anchorTurnId ? restoreTurnAnchor(pos.anchorTurnId, pos.anchorOffsetTop ?? 0) : false;
    },
    [restoreFeedAnchor, restoreTurnAnchor],
  );

  const snapshotViewportAnchor = useCallback(
    (container: HTMLDivElement) => {
      lastViewportAnchorRef.current = {
        viewportKey,
        signature: viewportLayoutSignature,
        wasAutoFollowing: autoFollowEnabledRef.current,
        anchor: findVisibleFeedAnchor(container),
      };
    },
    [findVisibleFeedAnchor, viewportKey, viewportLayoutSignature],
  );

  const moveSectionWindow = useCallback(
    (nextStartIndex: number | null) => {
      const el = containerRef.current;
      const anchor = el ? findVisibleTurnAnchor(el) : null;
      setSectionWindowStart(nextStartIndex);
      requestAnimationFrame(() => {
        if (anchor?.turnId) {
          restoreTurnAnchor(anchor.turnId, anchor.offsetTop ?? 0);
        }
      });
    },
    [findVisibleTurnAnchor, restoreTurnAnchor],
  );

  const ensureSectionForTurnVisible = useCallback(
    (turnId: string): boolean => {
      const nextStartIndex = getSectionWindowStartForTurnId(turnId);
      if (nextStartIndex === sectionWindowStart) return false;
      if (nextStartIndex == null && visibleSectionStartIndex === latestVisibleSectionStartIndex) return false;
      moveSectionWindow(nextStartIndex);
      return true;
    },
    [
      getSectionWindowStartForTurnId,
      moveSectionWindow,
      sectionWindowStart,
      latestVisibleSectionStartIndex,
      visibleSectionStartIndex,
    ],
  );

  const scrollToFeedBlock = useCallback(
    (blockId: string, turnId: string) => {
      handleUserNavigationIntent();
      const sectionChanged = ensureSectionForTurnVisible(turnId);
      const scheduleScroll = () => {
        requestAnimationFrame(() => {
          const contentRoot = contentRootRef.current;
          const target = contentRoot?.querySelector<HTMLElement>(
            `[data-feed-block-id="${escapeSelectorValue(blockId)}"]`,
          );
          if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            flashMessageFeedTarget(target);
          }
        });
      };
      if (sectionChanged) {
        requestAnimationFrame(scheduleScroll);
        return;
      }
      scheduleScroll();
    },
    [ensureSectionForTurnVisible, handleUserNavigationIntent],
  );

  const { historyWindowRevision, requestHistoryWindow } = useMessageFeedBoundedConversation({
    activeHistoryWindow,
    activeThreadWindow,
    connectionStatus,
    normalizedThreadKey,
    selectedFeedWindowEnabled,
    sessionId,
  });

  const requestViewportAnchorWindowIfMissing = useCallback(
    (pos: FeedViewportPosition, restoreKey: string) => {
      const targetMessageId = pos.anchorMessageId ?? pos.anchorTurnId;
      const useThreadWindow = selectedFeedWindowEnabled && activeThreadWindow;
      const useHistoryWindow = !selectedFeedWindowEnabled && activeHistoryWindow;
      if (!targetMessageId || (!useThreadWindow && !useHistoryWindow)) return false;

      const revision = useThreadWindow ? selectedThreadWindowRevision : historyWindowRevision;
      const requestKey = `${normalizedThreadKey}:${restoreKey}:${targetMessageId}`;
      const action = getMissingScrollTargetWindowAction({
        pending: pendingViewportAnchorWindowRequestRef.current,
        requestKey,
        revision,
      });
      if (action.kind === "request") {
        const requested = useThreadWindow
          ? requestThreadWindow(-1, undefined, targetMessageId)
          : requestHistoryWindow(
              -1,
              activeHistoryWindow?.turn_count || sectionTurnCount * DEFAULT_VISIBLE_SECTION_COUNT,
              activeHistoryWindow?.section_turn_count ?? sectionTurnCount,
              activeHistoryWindow?.visible_section_count ?? DEFAULT_VISIBLE_SECTION_COUNT,
              targetMessageId,
            );
        if (!requested) return false;
        pendingViewportAnchorWindowRequestRef.current = action.pending;
        return true;
      }
      if (action.kind === "wait") return true;
      pendingViewportAnchorWindowRequestRef.current = null;
      return false;
    },
    [
      activeHistoryWindow,
      activeThreadWindow,
      historyWindowRevision,
      normalizedThreadKey,
      requestHistoryWindow,
      requestThreadWindow,
      sectionTurnCount,
      selectedFeedWindowEnabled,
      selectedThreadWindowRevision,
    ],
  );

  const { handleLoadNewerSection, handleLoadOlderSection, explicitSectionLoad } = useMessageFeedSectionWindowLoaders({
    activeThreadWindow,
    activeHistoryWindow,
    autoFollowEnabledRef,
    latestVisibleSectionStartIndex,
    markPending: markSectionLoadPending,
    moveSectionWindow,
    nextSectionStartIndex,
    normalizedThreadKey,
    pendingRequestKeyRef: pendingSectionLoadKeyRef,
    previousSectionStartIndex,
    requestHistoryWindow,
    requestThreadWindow,
    setShowScrollButton,
    onUserNavigationIntent: handleUserNavigationIntent,
  });

  const triggerSectionLoadNearBoundary = useCallback(
    (direction: "older" | "newer") => {
      if (pendingSectionLoadKeyRef.current) return;
      if (direction === "older") {
        if (!hasOlderSections) return;
        handleLoadOlderSection();
        return;
      }
      if (!hasNewerSections) return;
      handleLoadNewerSection();
    },
    [handleLoadNewerSection, handleLoadOlderSection, hasNewerSections, hasOlderSections],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (activeThreadWindow && hasNewerSections) {
        const latestFromItem = Math.max(0, activeThreadWindow.total_items - activeThreadWindow.item_count);
        autoFollowEnabledRef.current = true;
        requestThreadWindow(latestFromItem);
        return;
      }
      if (activeHistoryWindow && hasNewerSections) {
        const turnCount =
          activeHistoryWindow.turn_count ||
          getHistoryWindowTurnCount(activeHistoryWindow.visible_section_count, activeHistoryWindow.section_turn_count);
        const latestFromTurn = Math.max(0, activeHistoryWindow.total_turns - turnCount);
        autoFollowEnabledRef.current = true;
        requestHistoryWindow(
          latestFromTurn,
          turnCount,
          activeHistoryWindow.section_turn_count,
          activeHistoryWindow.visible_section_count,
        );
        return;
      }
      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;
        autoFollowEnabledRef.current = true;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      };
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) {
        performScroll();
        return;
      }
      setSectionWindowStart(null);
      requestAnimationFrame(performScroll);
    },
    [
      getRealContentBottom,
      activeThreadWindow,
      hasNewerSections,
      activeHistoryWindow,
      requestThreadWindow,
      requestHistoryWindow,
      scrollContainerTo,
      sectionWindowStart,
      totalSections,
    ],
  );

  const [handleScrollToBottomClick, handleScrollToTopClick] = useViewportBoundaryNavigation({
    cancelPendingRestore: handleUserNavigationIntent,
    containerRef,
    scrollToBottom,
  });

  const {
    handleScrollToPreviousUserMessageClick,
    handleScrollToNextUserMessageClick,
    handleSelectUserNavigationTarget,
  } = useUserMessageNavigation({
    containerRef,
    contentRootRef,
    userNavigationTargets: activeUserNavigationTargets,
    activeHistoryWindow,
    activeThreadWindow,
    normalizedThreadKey,
    visibleWindowSignature,
    autoFollowEnabledRef,
    markSectionLoadPending,
    requestThreadWindow,
    requestHistoryWindow,
    ensureSectionForTurnVisible,
    scrollToFeedBlock,
    scrollToBottom,
    onUserNavigationIntent: handleUserNavigationIntent,
  });

  const navFabButtonClassName = isTouch
    ? "h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
    : "h-8 w-8 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer";
  const navFabStackClassName = isTouch
    ? `gap-2 ${isScrolling ? "opacity-60" : "opacity-0 pointer-events-none"}`
    : "gap-4";
  const resetVisibleSectionsToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (activeThreadWindow && hasNewerSections) {
        const latestFromItem = Math.max(0, activeThreadWindow.total_items - activeThreadWindow.item_count);
        autoFollowEnabledRef.current = true;
        requestThreadWindow(latestFromItem);
        return;
      }
      if (activeHistoryWindow && hasNewerSections) {
        const turnCount =
          activeHistoryWindow.turn_count ||
          getHistoryWindowTurnCount(activeHistoryWindow.visible_section_count, activeHistoryWindow.section_turn_count);
        const latestFromTurn = Math.max(0, activeHistoryWindow.total_turns - turnCount);
        autoFollowEnabledRef.current = true;
        requestHistoryWindow(
          latestFromTurn,
          turnCount,
          activeHistoryWindow.section_turn_count,
          activeHistoryWindow.visible_section_count,
        );
        return;
      }
      if (sectionWindowStart == null || totalSections <= DEFAULT_VISIBLE_SECTION_COUNT) return;
      autoFollowEnabledRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        scrollContainerTo(targetTop, behavior);
      });
    },
    [
      activeThreadWindow,
      getRealContentBottom,
      hasNewerSections,
      activeHistoryWindow,
      requestThreadWindow,
      requestHistoryWindow,
      scrollContainerTo,
      sectionWindowStart,
      totalSections,
    ],
  );

  const flushAutoFollow = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const changedBlockIds = new Set(pendingChangedFeedBlockIdsRef.current);
    pendingChangedFeedBlockIdsRef.current.clear();
    const useFallback = pendingAutoFollowFallbackRef.current;
    pendingAutoFollowFallbackRef.current = false;

    if (!autoFollowEnabledRef.current) return;

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      changedBlockIds.forEach((blockId) => pendingChangedFeedBlockIdsRef.current.add(blockId));
      pendingAutoFollowFallbackRef.current = true;
      setSectionWindowStart(null);
      requestAnimationFrame(() => {
        if (autoFollowEnabledRef.current) {
          if (autoFollowRafRef.current != null) return;
          autoFollowRafRef.current = requestAnimationFrame(() => {
            autoFollowRafRef.current = null;
            flushAutoFollow();
          });
        }
      });
      return;
    }

    const lowestBottom = getLowestFeedBlockBottom(changedBlockIds, useFallback);
    if (lowestBottom == null) return;
    const bottomAlignMessageId = bottomAlignMessageIdRef.current;
    const bottomAlignTarget = bottomAlignMessageId
      ? contentRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${escapeSelectorValue(bottomAlignMessageId)}"]`,
        )
      : null;
    const targetBottom = bottomAlignTarget ? getFeedBlockBottom(container, bottomAlignTarget) : lowestBottom;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(targetBottom - container.clientHeight)));
    const currentTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop));
    const nextTargetTop = Math.max(currentTop, targetTop);
    if (Math.abs(container.scrollTop - nextTargetTop) > 1) {
      setContainerScrollTop(nextTargetTop);
    }
    const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
    isNearBottom.current = realContentBottom - nextTargetTop - container.clientHeight < 120;
    lastSeenContentBottomRef.current = realContentBottom;
    lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
    setShowScrollButton(false);
    setShowLatestPill(false);
    if (bottomAlignMessageId) {
      bottomAlignMessageIdRef.current = null;
    }
  }, [
    getFeedBlockBottom,
    getLowestFeedBlockBottom,
    getRealContentBottom,
    sectionWindowStart,
    setContainerScrollTop,
    totalSections,
  ]);

  const scheduleAutoFollowFlush = useCallback(
    (useFallback = false) => {
      if (useFallback) {
        pendingAutoFollowFallbackRef.current = true;
      }
      if (autoFollowRafRef.current != null) return;
      autoFollowRafRef.current = requestAnimationFrame(() => {
        autoFollowRafRef.current = null;
        flushAutoFollow();
      });
    },
    [flushAutoFollow],
  );

  const updateLatestPillForContentBottom = useCallback(
    (realContentBottom: number | null) => {
      if (!didTrackContentRef.current) {
        didTrackContentRef.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (autoFollowEnabledRef.current) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (hasNewerSections) {
        setShowLatestPill(true);
        return;
      }
      if (suppressLatestPillOnRestoreRef.current) {
        suppressLatestPillOnRestoreRef.current = false;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      if (realContentBottom == null) {
        setShowLatestPill(false);
        return;
      }
      const container = containerRef.current;
      const hasContentBelowViewport = container
        ? realContentBottom > container.scrollTop + container.clientHeight + 8
        : false;
      if (!hasContentBelowViewport) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      const baseline = lastSeenContentBottomRef.current;
      if (baseline == null) {
        lastSeenContentBottomRef.current = realContentBottom;
        setShowLatestPill(false);
        return;
      }
      setShowLatestPill(realContentBottom > baseline + 8);
    },
    [hasNewerSections],
  );
  useMessageFeedStatusContentBottomSync(
    threadStatusLayoutKey,
    getRealContentBottom,
    lastObservedContentBottomRef,
    lastSeenContentBottomRef,
    setShowLatestPill,
  );

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const currentScrollTop = el.scrollTop;
    const realContentBottom = getRealContentBottom() ?? el.scrollHeight;
    const nearBottom = realContentBottom - currentScrollTop - el.clientHeight < 120;
    const nearOlderBoundary = currentScrollTop <= SECTION_WINDOW_TRIGGER_PX;
    const nearNewerBoundary = realContentBottom - currentScrollTop - el.clientHeight <= SECTION_WINDOW_TRIGGER_PX;
    const isProgrammaticScroll =
      programmaticScrollTargetRef.current != null &&
      Math.abs(currentScrollTop - programmaticScrollTargetRef.current) <= 2;
    if (isProgrammaticScroll) {
      programmaticScrollTargetRef.current = null;
    }
    const scrollingUp = currentScrollTop < lastScrollTopRef.current - 4;
    const scrollingDown = currentScrollTop > lastScrollTopRef.current + 4;
    if (!isProgrammaticScroll) {
      if (scrollingUp || scrollingDown) handleKeyboardScroll();
      if (scrollingUp) {
        autoFollowEnabledRef.current = false;
      } else if (!nearBottom) {
        autoFollowEnabledRef.current = false;
      } else if (nearBottom && !hasNewerSections) {
        autoFollowEnabledRef.current = true;
      } else if (hasNewerSections) {
        autoFollowEnabledRef.current = false;
      }
    }
    isNearBottom.current = nearBottom;
    if (autoFollowEnabledRef.current && nearBottom && !hasNewerSections) {
      lastSeenContentBottomRef.current = realContentBottom;
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowLatestPill(false);
      resetVisibleSectionsToLatest("auto");
    } else if (!isProgrammaticScroll && scrollingUp && nearOlderBoundary) {
      triggerSectionLoadNearBoundary("older");
    } else if (!isProgrammaticScroll && scrollingDown && nearNewerBoundary) {
      triggerSectionLoadNearBoundary("newer");
    }
    const shouldShow = !nearBottom || !autoFollowEnabledRef.current;
    setShowScrollButton((prev) => (prev === shouldShow ? prev : shouldShow));
    setIsScrolling(true);
    clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1500);
    lastScrollTopRef.current = currentScrollTop;
    snapshotViewportAnchor(el);
  }

  const { handleKeyboardScroll, handlePointerDown, handleTouchMove, handleWheel } = useMessageFeedManualScrollHandlers({
    boundaryTriggerPx: SECTION_WINDOW_TRIGGER_PX,
    containerRef,
    getRealContentBottom,
    onUserNavigationIntent: handleUserNavigationIntent,
    triggerSectionLoadNearBoundary,
  });

  useLayoutEffect(() => {
    if (showConversationLoading) return;
    const pos = readSavedViewportPosition({
      sessionId,
      viewportKey,
      normalizedThreadKey,
      isLeaderSession,
    });
    const restoreKey = getSavedViewportRestoreKey(viewportKey, pos);
    const restoredViewport = restoredViewportRef.current;
    const container = containerRef.current;
    if (restoredViewport?.key === restoreKey && restoredViewport.container === container) return;
    if (messages.length === 0 && (pos?.anchorMessageId || pos?.anchorTurnId)) return;
    const desiredSectionWindowStart =
      !isWindowedFeed && pos?.anchorTurnId ? getSectionWindowStartForTurnId(pos.anchorTurnId) : null;
    if (!isWindowedFeed && desiredSectionWindowStart !== sectionWindowStart) {
      setSectionWindowStart(desiredSectionWindowStart);
      return;
    }
    if (pos && !pos.isAtBottom && (pos.anchorMessageId || pos.anchorTurnId)) {
      if (selectedFeedWindowEnabled && !activeThreadWindow) return;
      if (!selectedFeedWindowEnabled && !activeHistoryWindow && historyLoading) return;
      const pendingExactRestore = { restoreKey, position: pos };
      exactRestoreRef.current = pendingExactRestore;
      lastViewportAnchorRef.current = null;
      if (restoreSavedViewportAnchor(pos)) {
        pendingViewportAnchorWindowRequestRef.current = null;
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
        viewportAnchor.schedulePostLayoutViewportAnchorRestore({
          container: containerRef,
          position: pos,
          restore: restoreSavedViewportAnchor,
          isActive: () => exactRestoreRef.current === pendingExactRestore,
          onSettled: () => {
            if (exactRestoreRef.current === pendingExactRestore) exactRestoreRef.current = null;
          },
        });
      } else if (requestViewportAnchorWindowIfMissing(pos, restoreKey)) {
        return;
      } else if (restoreSavedScrollPosition(pos)) {
        exactRestoreRef.current = null;
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      } else {
        exactRestoreRef.current = null;
        scrollToBottom("auto");
      }
    } else if (pos && !pos.isAtBottom) {
      if (restoreSavedScrollPosition(pos)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      }
    } else if (activeThreadWindow && hasNewerSections) {
      const el = containerRef.current;
      autoFollowEnabledRef.current = false;
      isNearBottom.current = false;
      setShowScrollButton(true);
      if (el) {
        lastScrollTopRef.current = el.scrollTop;
      }
    } else {
      scrollToBottom("auto");
    }
    restoredViewportRef.current = { key: restoreKey, container: containerRef.current };
  }, [
    activeHistoryWindow,
    activeThreadWindow,
    getSectionWindowStartForTurnId,
    hasNewerSections,
    historyLoading,
    isLeaderSession,
    isWindowedFeed,
    messages.length,
    normalizedThreadKey,
    restoreSavedScrollPosition,
    restoreSavedViewportAnchor,
    requestViewportAnchorWindowIfMissing,
    savedViewportRestoreKey,
    scrollToBottom,
    sectionWindowStart,
    selectedFeedWindowEnabled,
    selectedThreadWindowRevision,
    sessionId,
    showConversationLoading,
    viewportKey,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    didTrackContentRef.current = savedScrollPos?.lastSeenContentBottom != null;
    lastSeenContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    lastObservedContentBottomRef.current = savedScrollPos?.lastSeenContentBottom ?? null;
    suppressLatestPillOnRestoreRef.current = savedScrollPos?.lastSeenContentBottom != null;
    setShowLatestPill(false);
  }, [savedScrollPos?.lastSeenContentBottom, sessionId, showConversationLoading, viewportKey]);

  useEffect(() => {
    if (showConversationLoading) return;
    updateLatestPillForContentBottom(getRealContentBottom());
  }, [
    getRealContentBottom,
    messages.length,
    showConversationLoading,
    streamingText,
    toolProgress,
    updateLatestPillForContentBottom,
  ]);

  useEffect(() => {
    onLatestIndicatorVisibleChange?.(showLatestPill);
  }, [onLatestIndicatorVisibleChange, showLatestPill]);

  useEffect(() => {
    onJumpToLatestReady?.(() => scrollToBottom());
    return () => onJumpToLatestReady?.(null);
  }, [onJumpToLatestReady, scrollToBottom]);

  useLayoutEffect(() => {
    if (!shouldBottomAlignNextUserMessage) return;
    if (!latestMessage || latestMessage.role !== "user") return;

    const alignLatestUserMessage = () => {
      const container = containerRef.current;
      if (!container) return;
      const target = container.querySelector<HTMLElement>(
        `[data-message-id="${escapeSelectorValue(latestMessage.id)}"]`,
      );
      if (!target) return;
      const messageBottom = getFeedBlockBottom(container, target);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(messageBottom - container.clientHeight)));
      autoFollowEnabledRef.current = true;
      isNearBottom.current = true;
      setContainerScrollTop(targetTop);
      lastSeenContentBottomRef.current = getRealContentBottom();
      lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
      setShowScrollButton(false);
      setShowLatestPill(false);
      bottomAlignMessageIdRef.current = latestMessage.id;
      useStore.getState().clearBottomAlignOnNextUserMessage(sessionId);
    };

    if (sectionWindowStart != null && totalSections > DEFAULT_VISIBLE_SECTION_COUNT) {
      setSectionWindowStart(null);
      requestAnimationFrame(alignLatestUserMessage);
      return;
    }
    alignLatestUserMessage();
  }, [
    getFeedBlockBottom,
    getRealContentBottom,
    latestMessage,
    sectionWindowStart,
    sessionId,
    setContainerScrollTop,
    shouldBottomAlignNextUserMessage,
    totalSections,
  ]);

  useEffect(() => {
    if (showConversationLoading) return;
    if (!toolProgress || toolProgress.size === 0) return;
    scheduleAutoFollowFlush(true);
  }, [scheduleAutoFollowFlush, showConversationLoading, toolProgress]);

  useEffect(() => {
    if (showConversationLoading) return;
    const container = containerRef.current;
    const contentRoot = contentRootRef.current;
    if (!container || !contentRoot) return;

    lastObservedContentBottomRef.current = getRealContentBottom();

    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            let sawMutation = false;
            for (const mutation of mutations) {
              sawMutation = true;
              collectFeedBlockIdsFromNode(mutation.target, pendingChangedFeedBlockIdsRef.current);
              mutation.addedNodes.forEach((node) =>
                collectFeedBlockIdsFromNode(node, pendingChangedFeedBlockIdsRef.current),
              );
            }
            if (sawMutation) {
              scheduleAutoFollowFlush();
            }
          });

    mutationObserver?.observe(contentRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const realContentBottom = getRealContentBottom();
            if (realContentBottom == null || realContentBottom === lastObservedContentBottomRef.current) return;
            lastObservedContentBottomRef.current = realContentBottom;
            if (!autoFollowEnabledRef.current) {
              updateLatestPillForContentBottom(realContentBottom);
            }
            scheduleAutoFollowFlush(true);
          });

    resizeObserver?.observe(contentRoot);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (autoFollowRafRef.current != null) {
        cancelAnimationFrame(autoFollowRafRef.current);
        autoFollowRafRef.current = null;
      }
      pendingChangedFeedBlockIdsRef.current.clear();
      pendingAutoFollowFallbackRef.current = false;
    };
  }, [getRealContentBottom, scheduleAutoFollowFlush, showConversationLoading, updateLatestPillForContentBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previous = lastViewportAnchorRef.current;
    if (previous && previous.viewportKey === viewportKey && previous.signature !== viewportLayoutSignature) {
      if (previous.wasAutoFollowing) {
        const realContentBottom = getRealContentBottom() ?? container.scrollHeight;
        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const targetTop = Math.max(0, Math.min(maxScrollTop, Math.ceil(realContentBottom - container.clientHeight)));
        setContainerScrollTop(targetTop);
        isNearBottom.current = true;
        lastSeenContentBottomRef.current = realContentBottom;
        lastObservedContentBottomRef.current = lastSeenContentBottomRef.current;
        setShowScrollButton(false);
        setShowLatestPill(false);
      } else if (previous.anchor && restoreFeedAnchor(previous.anchor)) {
        autoFollowEnabledRef.current = false;
        isNearBottom.current = false;
        setShowScrollButton(true);
      }
    }
    snapshotViewportAnchor(container);
  }, [
    getRealContentBottom,
    restoreFeedAnchor,
    setContainerScrollTop,
    snapshotViewportAnchor,
    viewportKey,
    viewportLayoutSignature,
  ]);

  const scrollToTurnId = useStore((s) => s.scrollToTurnId.get(sessionId));
  const clearScrollToTurn = useStore((s) => s.clearScrollToTurn);
  useEffect(() => {
    if (!scrollToTurnId) return;
    handleUserNavigationIntent();
    clearScrollToTurn(sessionId);
    autoFollowEnabledRef.current = false;
    const overrides = useStore.getState().turnActivityOverrides.get(sessionId);
    const isExpanded = overrides?.get(scrollToTurnId);
    if (isExpanded !== true) {
      useStore.getState().keepTurnExpanded(sessionId, scrollToTurnId);
    }
    const sectionChanged = ensureSectionForTurnVisible(scrollToTurnId);
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const target = el.querySelector(`[data-turn-id="${escapeSelectorValue(scrollToTurnId)}"]`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [clearScrollToTurn, ensureSectionForTurnVisible, handleUserNavigationIntent, scrollToTurnId, sessionId]);

  const expandAllInTurnTarget = useStore((s) => s.expandAllInTurn.get(sessionId));
  const clearScrollToMessage = useStore((s) => s.clearScrollToMessage);
  const clearPendingScrollToMessageId = useStore((s) => s.clearPendingScrollToMessageId);
  const clearExpandAllInTurn = useStore((s) => s.clearExpandAllInTurn);
  useEffect(() => {
    if (!scrollToMessageId) {
      notedDeliberateMessageTargetRef.current = null;
      return;
    }
    if (notedDeliberateMessageTargetRef.current !== scrollToMessageId) {
      notedDeliberateMessageTargetRef.current = scrollToMessageId;
      noteViewportDeliberateActivity(sessionId, normalizedThreadKey);
    }
    cancelExactRestore();
    autoFollowEnabledRef.current = false;

    const targetTurn = turns.find(
      (t) =>
        t.allEntries.some(
          (e) =>
            (e.kind === "message" && e.msg.id === scrollToMessageId) ||
            (e.kind === "tool_msg_group" && e.firstId === scrollToMessageId),
        ) ||
        (t.userEntry?.kind === "message" && t.userEntry.msg.id === scrollToMessageId),
    );
    if (!targetTurn) {
      if (selectedFeedWindowEnabled || activeHistoryWindow) {
        const key = `${normalizedThreadKey}:${scrollToMessageId}`;
        const action = getMissingScrollTargetWindowAction({
          pending: pendingTargetWindowRequestRef.current,
          requestKey: key,
          revision: selectedFeedWindowEnabled ? selectedThreadWindowRevision : historyWindowRevision,
        });
        if (action.kind === "request") {
          pendingTargetWindowRequestRef.current = action.pending;
          if (selectedFeedWindowEnabled) {
            requestThreadWindow(-1, undefined, scrollToMessageId);
          } else if (activeHistoryWindow) {
            requestHistoryWindow(
              -1,
              activeHistoryWindow.turn_count || sectionTurnCount * DEFAULT_VISIBLE_SECTION_COUNT,
              activeHistoryWindow.section_turn_count,
              activeHistoryWindow.visible_section_count,
              scrollToMessageId,
            );
          }
          return;
        }
        if (action.kind === "wait") return;
        pendingTargetWindowRequestRef.current = null;
      }
      clearScrollToMessage(sessionId);
      clearPendingScrollToMessageId(sessionId);
      const lastTurn = turns[turns.length - 1];
      if (lastTurn) {
        useStore.getState().focusTurn(sessionId, lastTurn.id);
        ensureSectionForTurnVisible(lastTurn.id);
        requestAnimationFrame(() => {
          containerRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "end" });
          clearExpandAllInTurn(sessionId);
        });
      }
      return;
    }
    pendingTargetWindowRequestRef.current = null;

    useStore.getState().focusTurn(sessionId, targetTurn.id);
    const sectionChanged = ensureSectionForTurnVisible(targetTurn.id);

    let scrollAttempts = 0;
    const scheduleScroll = () => {
      requestAnimationFrame(() => {
        const el = containerRef.current;
        if (!el) return;
        const targetElement = findMessageFeedScrollTarget(el, scrollToMessageId);
        if (targetElement) {
          scrollMessageFeedTargetIntoView({
            container: el,
            target: targetElement,
            targetMessageId: scrollToMessageId,
            targetTurnId: targetTurn.id,
            sessionId,
            threadKey: normalizedThreadKey,
            viewportKey,
            isLeaderSession,
            lastSeenContentBottom: lastSeenContentBottomRef.current,
            getRealContentBottom,
            markProgrammaticScroll,
            setShowScrollButton,
            setFeedScrollPosition: useStore.getState().setFeedScrollPosition,
            refs: { lastScrollTop: lastScrollTopRef, autoFollowEnabled: autoFollowEnabledRef, isNearBottom },
          });
          flashMessageFeedTarget(targetElement);
          clearScrollToMessage(sessionId);
          clearPendingScrollToMessageId(sessionId);
          clearExpandAllInTurn(sessionId);
        } else if (scrollAttempts < 5) {
          scrollAttempts += 1;
          scheduleScroll();
        } else {
          clearScrollToMessage(sessionId);
          clearPendingScrollToMessageId(sessionId);
          clearExpandAllInTurn(sessionId);
        }
      });
    };
    if (sectionChanged) {
      requestAnimationFrame(scheduleScroll);
      return;
    }
    scheduleScroll();
  }, [
    activeHistoryWindow,
    cancelExactRestore,
    clearExpandAllInTurn,
    clearPendingScrollToMessageId,
    clearScrollToMessage,
    ensureSectionForTurnVisible,
    getRealContentBottom,
    historyWindowRevision,
    isLeaderSession,
    markProgrammaticScroll,
    normalizedThreadKey,
    requestThreadWindow,
    requestHistoryWindow,
    scrollToMessageId,
    selectedFeedWindowEnabled,
    selectedThreadWindowRevision,
    sessionId,
    setShowScrollButton,
    turns,
    viewportKey,
  ]);

  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const setActiveTaskTurnId = useStore((s) => s.setActiveTaskTurnId);
  const taskTriggerIds = useMemo(
    () => new Set((taskHistory || []).map((task) => task.triggerMessageId)),
    [taskHistory],
  );
  const firstTaskTurnId = taskHistory?.[0]?.triggerMessageId ?? null;

  const rebuildTaskTurnOffsets = useCallback(() => {
    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0) {
      taskTurnOffsetsRef.current = [];
      return;
    }
    const nextOffsets: TurnOffsetIndex[] = [];
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    for (const target of targets) {
      const turnId = target.dataset.turnId;
      if (!turnId || !taskTriggerIds.has(turnId)) continue;
      nextOffsets.push({ turnId, offsetTop: target.offsetTop });
    }
    taskTurnOffsetsRef.current = nextOffsets;
  }, [taskTriggerIds]);

  useLayoutEffect(() => {
    rebuildTaskTurnOffsets();
    if (containerRef.current) {
      setActiveTaskTurnId(
        sessionId,
        findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, containerRef.current.scrollTop, firstTaskTurnId),
      );
    }

    const el = containerRef.current;
    if (!el || taskTriggerIds.size === 0 || typeof ResizeObserver === "undefined") {
      return;
    }

    let rafId = 0;
    const scheduleRebuild = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rebuildTaskTurnOffsets();
        setActiveTaskTurnId(
          sessionId,
          findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId),
        );
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleRebuild();
    });
    const targets = el.querySelectorAll<HTMLElement>("[data-turn-id]");
    targets.forEach((target) => observer.observe(target));

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [firstTaskTurnId, rebuildTaskTurnOffsets, sessionId, setActiveTaskTurnId, taskTriggerIds, visibleTurns]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !taskHistory || taskHistory.length === 0) return;

    let rafId = 0;
    const recalc = () => {
      const activeTurnId = findActiveTaskTurnIdForScroll(taskTurnOffsetsRef.current, el.scrollTop, firstTaskTurnId);
      setActiveTaskTurnId(sessionId, activeTurnId);
    };

    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(recalc);
    };

    recalc();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, [firstTaskTurnId, sessionId, setActiveTaskTurnId, taskHistory, visibleTurns]);

  const showSelectedWindowLoading = shouldShowSelectedThreadWindowLoading({
    messageCount: messages.length,
    pendingUserUploadCount: pendingUserUploads.length,
    pendingCodexInputCount: pendingCodexInputs.length,
    hasStreamingText: Boolean(streamingText),
    selectedFeedWindowEnabled,
    hasActiveThreadWindow: Boolean(activeThreadWindow),
    missingSelectedWindowHasContext,
    pendingInitialThreadWindowKey,
    normalizedThreadKey,
  });

  const feedTopControls = (
    <MessageFeedTopControls
      sessionId={sessionId}
      terminals={visibleCodexTerminalRailEntries}
      subagents={visibleLiveSubagentEntries}
      selectedToolUseId={selectedCodexTerminalId}
      onSelect={setSelectedCodexTerminalId}
      onSelectSubagent={(taskToolUseId, turnId) => scrollToFeedBlock(getSubagentFeedBlockId(taskToolUseId), turnId)}
      onDismissSubagent={(taskToolUseId, freshnessToken) => {
        setDismissedSubagentChips((prev) => new Map(prev).set(taskToolUseId, freshnessToken));
      }}
      showCodexSubagents={showCodexSubagentControl}
    />
  );
  if (showConversationLoading || showSelectedWindowLoading) {
    return (
      <MessageFeedCenteredState
        variant="loading"
        topControls={feedTopControls}
        clearancePx={centeredFeedStatusClearancePx}
        sessionId={sessionId}
        threadKey={threadKey}
        onSelectThread={onSelectThread}
        onVisibleHeightChange={setFloatingStatusHeight}
      />
    );
  }

  if (messages.length === 0 && pendingUserUploads.length === 0 && pendingCodexInputs.length === 0 && !streamingText) {
    return (
      <MessageFeedCenteredState
        variant="empty"
        topControls={feedTopControls}
        clearancePx={centeredFeedStatusClearancePx}
        sessionId={sessionId}
        threadKey={threadKey}
        onSelectThread={onSelectThread}
        onVisibleHeightChange={setFloatingStatusHeight}
      />
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div
        ref={overlayViewportRef}
        data-testid="message-feed-overlay"
        data-chat-feed-width-source="true"
        className="relative flex-1 min-h-0 overflow-hidden"
      >
        <div
          ref={containerRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onTouchMove={handleTouchMove}
          onPointerDown={handlePointerDown}
          data-testid="message-feed-scroll-container"
          data-feed-session-id={sessionId}
          data-feed-thread-key={normalizedThreadKey}
          className="message-feed-scroll-surface mobile-scroll-stable-surface h-full overflow-y-auto overflow-x-hidden px-2 sm:px-4 py-4 sm:py-6"
          style={{ overscrollBehavior: "contain" }}
        >
          <PawScrollProvider scrollRef={containerRef}>
            <PawCounterContext.Provider value={pawCounter}>
              <div
                ref={contentRootRef}
                className="max-w-3xl mx-auto space-y-3 sm:space-y-5"
                data-feed-content-root="true"
              >
                {hasOlderSections && (
                  <div className="flex justify-center pb-2" aria-live="polite">
                    {isLoadingOlderSection ? (
                      <div className={SECTION_BOUNDARY_CONTROL_CLASS}>
                        <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                        Loading older section...
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={explicitSectionLoad.older}
                        className={`${SECTION_BOUNDARY_CONTROL_CLASS} transition-colors hover:border-cc-primary/30 hover:bg-cc-hover hover:text-cc-fg focus:outline-none focus:ring-2 focus:ring-cc-primary/40`}
                      >
                        <YarnBallDot className="text-cc-muted/70" />
                        Load older section
                      </button>
                    )}
                  </div>
                )}
                <TurnEntries
                  sections={visibleSections}
                  sessionId={sessionId}
                  currentThreadKey={threadKey}
                  leaderMode={collapseLeaderThreadActivity}
                  showInlineMessageTiming={!isLeaderSession}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={setSelectedCodexTerminalId}
                  onSelectThread={onSelectThread}
                  turnStates={turnStates}
                  toggleTurn={toggleTurn}
                  userBoundarySourceSessionId={herdingLeaderSessionId ?? null}
                  questLinkSurface="chat-feed"
                  threadResponsePresentation={threadResponsePresentation}
                  activeNeedsInputAnchorMessageIds={activeNeedsInputAnchorMessageIds}
                  visibleThreadStatuses={visibleThreadStatuses}
                  onThreadStatusLayoutContributionChange={handleThreadStatusLayoutContributionChange}
                />
                {hasNewerSections && (
                  <div className="flex justify-center pt-1" aria-live="polite">
                    {isLoadingNewerSection ? (
                      <div className={SECTION_BOUNDARY_CONTROL_CLASS}>
                        <YarnBallSpinner className="h-3 w-3 text-cc-muted" />
                        Loading newer section...
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={explicitSectionLoad.newer}
                        className={`${SECTION_BOUNDARY_CONTROL_CLASS} transition-colors hover:border-cc-primary/30 hover:bg-cc-hover hover:text-cc-fg focus:outline-none focus:ring-2 focus:ring-cc-primary/40`}
                      >
                        <YarnBallDot className="text-cc-muted/70" />
                        Load newer section
                      </button>
                    )}
                  </div>
                )}
                {pendingUserUploads.length > 0 && (
                  <PendingUserUploadList
                    sessionId={sessionId}
                    uploads={pendingUserUploads}
                    showTimestamp={!isLeaderSession}
                    questLinkSurface="chat-feed"
                  />
                )}
                {isCodexSession && pendingCodexInputs.length > 0 && (
                  <PendingCodexInputList sessionId={sessionId} inputs={pendingCodexInputs} />
                )}
                <FeedFooter sessionId={sessionId} visibleToolUseIds={visibleToolUseIds} questLinkSurface="chat-feed" />
                <MessageFeedEndSlack {...feedEndSlackProps} />
              </div>
            </PawCounterContext.Provider>
          </PawScrollProvider>
        </div>

        <FeedStatusPill
          sessionId={sessionId}
          onVisibleHeightChange={setFloatingStatusHeight}
          onRunwayHeightChange={setFloatingStatusRunwayHeight}
          currentThreadKey={threadKey}
          onSelectThread={onSelectThread}
        />

        {feedTopControls}

        {isCodexSession && selectedCodexTerminal && (
          <CodexTerminalInspector
            sessionId={sessionId}
            terminal={selectedCodexTerminal}
            onClose={() => setSelectedCodexTerminalId(null)}
            viewportRef={overlayViewportRef}
          />
        )}

        {showLatestPill && latestIndicatorMode !== "external" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:px-4">
            <button
              type="button"
              onClick={handleScrollToBottomClick}
              className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-cc-primary/25 bg-cc-card/95 px-4 py-2 text-sm font-medium text-cc-fg shadow-lg backdrop-blur-sm transition-colors hover:bg-cc-hover cursor-pointer"
              title="Jump to latest"
              aria-label="Jump to latest"
            >
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full bg-cc-primary ${
                  hasNewerSections ? "" : "animate-pulse"
                }`}
              />
              <span className="truncate">{latestPillLabel}</span>
            </button>
          </div>
        )}

        <MessageFeedNavigationControls
          showScrollButton={showScrollButton}
          navFabStackClassName={navFabStackClassName}
          isTouch={isTouch}
          mobileNavBottomOffsetPx={mobileNavBottomOffsetPx}
          navFabButtonClassName={navFabButtonClassName}
          sessionId={sessionId}
          normalizedThreadKey={normalizedThreadKey}
          isLeaderSession={isLeaderSession}
          useServerSearch={!herdingLeaderSessionId}
          containerRef={containerRef}
          contentRootRef={contentRootRef}
          userNavigationTargets={userNavigationTargets}
          visibleWindowSignature={visibleWindowSignature}
          navigatorStarredOnly={navigatorStarredOnly}
          onNavigatorStarredOnlyChange={setNavigatorStarredOnly}
          onScrollToTop={handleScrollToTopClick}
          onPreviousUserMessage={handleScrollToPreviousUserMessageClick}
          onNextUserMessage={handleScrollToNextUserMessageClick}
          onSelectUserNavigationTarget={handleSelectUserNavigationTarget}
          onScrollToBottom={handleScrollToBottomClick}
        />

        {/* Floating context menu for text selection within assistant messages */}
        <SelectionContextMenu selection={textSelection} sessionId={sessionId} onClose={textSelection.dismiss} />
      </div>
    </div>
  );
}
