import { useState, useMemo, useRef, useCallback, useContext, useLayoutEffect, useEffect, memo } from "react";
import type { ChatMessage, ContentBlock, ToolResultPreview } from "../types.js";
import { isSubagentToolName } from "../types.js";
import {
  ToolBlock,
  getToolIcon,
  getToolLabel,
  parseTakodeNotifyCommand,
  ToolIcon,
  type ToolResultScope,
} from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";
import { AssistantQuestQuizContent } from "./AssistantQuestQuizContent.js";
import { HighlightedText } from "./HighlightedText.js";
import { CollapseFooter } from "./CollapseFooter.js";
import { Lightbox } from "./Lightbox.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { StarredMessageRailMarker } from "./StarredMessageIndicator.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE, parseHerdEvents } from "../utils/herd-event-parser.js";
import { getHerdEventHeaderSummary } from "../utils/herd-event-classification.js";
import { useStore } from "../store.js";
import { formatVsCodeSelectionAttachmentLabel } from "../utils/vscode-context.js";
import { navigateToSession } from "../utils/routing.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import { QuestClaimBlock } from "./QuestClaimBlock.js";
import { getDisplayReplyContext } from "../utils/reply-context.js";
import { getSingleAnchoredNotification } from "../utils/anchored-notifications.js";
import { buildThreadOutcomeReminderViewModel } from "../utils/thread-outcome-reminder.js";
import { buildInjectedEventMessageViewModel } from "../utils/injected-event-message.js";
import { InjectedEventMessageView } from "./InjectedEventMessageView.js";
import { isStandaloneReminderMessage, StandaloneReminderMessageView } from "./StandaloneReminderMessageView.js";
import { FILE_TOOL_NAMES } from "../hooks/use-feed-model.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import { resolveSessionNavigation } from "../utils/session-navigation-resolver.js";
import { NotificationMarker } from "./NotificationMarker.js";
import { formatThreadMarker } from "../../shared/thread-routing.js";
import { isAllThreadsKey, normalizeThreadKey } from "../utils/thread-projection.js";
import { ImagePreviewGroup } from "./ImagePreviewGroup.js";
import {
  buildAssistantImagePreviewItems,
  buildUserImagePreviewItems,
  type ImagePreviewItem,
} from "./image-preview-utils.js";
import { SideChatSummary, useSideChatForMessage } from "./SideChatControls.js";
import { AssistantMessageMenu, UserMessageMenu } from "./MessageActionMenus.js";
import { MessageTimestamp } from "./MessageTimestamp.js";
import { shouldShowCompactGuidance } from "../utils/assistant-message-guidance.js";
import { isStarActionableMessage } from "../utils/starred-messages.js";
import { useMessageStarActions } from "./use-message-star-actions.js";
import { CodexAutoPauseRecoverySummary } from "./CodexAutoPauseRecoverySummary.js";
import { CompactToolActivity, isCompactToolActivityItem, type CompactToolActivityItem } from "./CompactToolActivity.js";
import {
  isAssistantMessageRenderable,
  isToolHiddenFromChat,
  projectAssistantMessageForRendering,
} from "../utils/assistant-message-renderability.js";
import { isCodexReasoningDetailMessage } from "../utils/codex-reasoning-detail.js";
import { CodexReasoningDetail } from "./CodexReasoningDetail.js";
import { useMessageSearchHighlight, type SearchHighlightInfo } from "../hooks/use-message-search-highlight.js";
import { reconcileLocalImagePreviewUrls } from "../local-image-previews.js";
import { useFeedDisplayNotifications } from "./FeedNotificationContext.js";
import { TimerMessage } from "./TimerMessage.js";

export { NotificationMarker } from "./NotificationMarker.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

/** Detect assistant messages whose final projected host has no visible content. */
export function isEmptyAssistantMessage(msg: ChatMessage): boolean {
  return msg.role === "assistant" && !isAssistantMessageRenderable(msg);
}

function useFeedStarredMessage(sessionId: string | undefined, message: ChatMessage): boolean {
  const starred = useStore((s) =>
    Boolean(sessionId && message.id && s.sessions.get(sessionId)?.starredMessages?.[message.id]),
  );
  return starred && isStarActionableMessage(message);
}

export const MessageBubble = memo(function MessageBubble({
  message,
  sessionId,
  showTimestamp = true,
  currentThreadKey,
  onSelectThread,
  showSideChatActions = true,
  interactionMode = "default",
  backendType,
  toolResultOverrides,
  toolResultScope = "session",
  questLinkSurface = "legacy",
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp?: boolean;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  showSideChatActions?: boolean;
  interactionMode?: "default" | "read-only";
  backendType?: "claude" | "codex" | "claude-sdk";
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope?: ToolResultScope;
  questLinkSurface?: QuestLinkSurface;
}) {
  // Search highlight state -- must be called unconditionally (hooks can't be after early returns)
  const searchHighlight = useMessageSearchHighlight(sessionId, message);
  const storedBackendType = useStore((state) =>
    message.role === "assistant" && sessionId ? state.sessions.get(sessionId)?.backend_type : undefined,
  );
  const isCodexSession = (backendType ?? storedBackendType) === "codex";

  if (isCodexReasoningDetailMessage(message)) {
    return <CodexReasoningDetail message={message} sessionId={sessionId} questLinkSurface={questLinkSurface} />;
  }

  if (message.role === "system") {
    if (message.metadata?.codexAutoPauseRecoverySummary) {
      return <CodexAutoPauseRecoverySummary summary={message.metadata.codexAutoPauseRecoverySummary} />;
    }
    if (message.variant === "error") {
      const isContextLimit = shouldShowCompactGuidance(message.content);
      return (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-cc-error/8 border border-cc-error/20 animate-[fadeSlideIn_0.2s_ease-out]">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-error shrink-0 mt-0.5">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11a1 1 0 100 2 1 1 0 000-2z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-cc-error">{message.content}</p>
            {isContextLimit && (
              <p className="text-xs text-cc-muted mt-1">
                Try <code className="px-1 py-0.5 rounded bg-cc-code-bg/30 text-[11px] font-mono-code">/compact</code> to
                shrink retained context before retrying, or start a new session.
              </p>
            )}
          </div>
        </div>
      );
    }
    if (message.variant === "denied") {
      return (
        <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-red-500/10 text-xs text-red-400/80 font-mono-code">
            <svg
              className="w-3 h-3 text-red-400/60 shrink-0"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="8" cy="8" r="6.5" />
              <line x1="4" y1="12" x2="12" y2="4" />
            </svg>
            <span>{message.content}</span>
          </div>
        </div>
      );
    }
    if (message.variant === "approved") {
      const answers = message.metadata?.answers;
      if (answers?.length) {
        return (
          <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
            <div className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs font-mono-code max-w-[85%]">
              <svg
                className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5.5 8.5l2 2 3.5-4" />
              </svg>
              <div className="min-w-0">
                {answers.map((a, i) => (
                  <div key={i} className="text-cc-muted">
                    <span className="text-cc-fg/70">{a.question}</span>
                    <span className="text-cc-muted/60"> → </span>
                    <span className="text-green-400/80">{a.answer}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }
      return <AutoApprovedChip content={message.content} reason={message.metadata?.autoApprovalReason} />;
    }
    // Quest lifecycle blocks — rendered as collapsible cards in the feed
    if ((message.variant === "quest_claimed" || message.variant === "quest_submitted") && message.metadata?.quest) {
      return (
        <div className="animate-[fadeSlideIn_0.2s_ease-out]">
          <QuestClaimBlock
            quest={message.metadata.quest}
            variant={message.variant === "quest_submitted" ? "submitted" : "claimed"}
            questLinkSurface={questLinkSurface}
          />
        </div>
      );
    }
    // Background task completion — lightweight chip showing what async work
    // finished. Helps the user understand why the model auto-started a new turn.
    if (message.variant === "task_completed") {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 leading-snug animate-[fadeSlideIn_0.2s_ease-out]">
          <span className="text-blue-400/60 shrink-0">◆</span>
          <span className="truncate">{message.content}</span>
        </div>
      );
    }
    // Expandable compact marker
    if (message.id.startsWith("compact-boundary-")) {
      return <CompactMarker message={message} sessionId={sessionId} questLinkSurface={questLinkSurface} />;
    }
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <span className="text-[11px] text-cc-muted italic font-mono-code shrink-0 px-1">{message.content}</span>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
    );
  }

  const injectedEventMessage = buildInjectedEventMessageViewModel(message);
  if (message.role === "user" && injectedEventMessage) {
    return (
      <InjectedEventMessageView
        event={injectedEventMessage}
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  // Herd events: render as compact left-side notification (not a user bubble)
  if (message.role === "user" && message.agentSource?.sessionId === "herd-events") {
    return <HerdEventMessage message={message} showTimestamp={showTimestamp} />;
  }

  // Timer events: render as compact expandable cards instead of normal user bubbles.
  if (message.role === "user" && message.agentSource?.sessionId?.startsWith("timer:")) {
    return (
      <TimerMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  if (message.role === "user" && isStandaloneReminderMessage(message)) {
    return (
      <StandaloneReminderMessageView
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  const threadOutcomeReminder = buildThreadOutcomeReminderViewModel(message);
  if (message.role === "user" && threadOutcomeReminder) {
    return (
      <ThreadOutcomeReminderMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  if (message.role === "user") {
    return (
      <UserMessage
        message={message}
        sessionId={sessionId}
        showTimestamp={showTimestamp}
        searchHighlight={searchHighlight}
        currentThreadKey={currentThreadKey}
        readOnly={interactionMode === "read-only"}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  // Assistant message
  return (
    <AssistantMessage
      message={message}
      sessionId={sessionId}
      showTimestamp={showTimestamp}
      searchHighlight={searchHighlight}
      currentThreadKey={currentThreadKey}
      onSelectThread={onSelectThread}
      showSideChatActions={showSideChatActions && interactionMode !== "read-only"}
      readOnly={interactionMode === "read-only"}
      isCodexSession={isCodexSession}
      toolResultOverrides={toolResultOverrides}
      toolResultScope={toolResultScope}
      questLinkSurface={questLinkSurface}
    />
  );
});

/** Auto-collapse content that exceeds a height threshold.
 *  Shows a gradient fade and "Show more" pill when collapsed. */
const COLLAPSE_THRESHOLD = 300;

function CollapsibleContent({ children }: { children: React.ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setNeedsCollapse(el.scrollHeight > COLLAPSE_THRESHOLD);
  }, [children]);

  const isCollapsed = needsCollapse && collapsed;

  return (
    <div className="relative">
      <div ref={contentRef} style={isCollapsed ? { maxHeight: COLLAPSE_THRESHOLD, overflow: "hidden" } : undefined}>
        {children}
      </div>
      {isCollapsed && (
        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-cc-user-bubble to-transparent pointer-events-none" />
      )}
      {needsCollapse && (
        <div className={`flex justify-center ${isCollapsed ? "-mt-3 relative z-10" : "mt-1"}`}>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="text-[11px] text-cc-muted hover:text-cc-fg bg-cc-user-bubble border border-cc-border/30 px-3 py-0.5 rounded-full cursor-pointer transition-colors"
          >
            {collapsed ? "Show more" : "Show less"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Badge shown on user messages injected by an agent (via takode CLI or cron).
 *  Displays a bolt icon + sender label. Click to see details / navigate to source session. */
function AgentSourceBadge({ source }: { source: { sessionId: string; sessionLabel?: string } }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const label = source.sessionLabel || source.sessionId.slice(0, 8);
  const isCron = source.sessionId.startsWith("cron:");
  const isSystem = source.sessionId === "system" || source.sessionId.startsWith("system:");
  const isTimer = source.sessionId.startsWith("timer:");
  const hasOpenableSession = !isCron && !isSystem && !isTimer;

  const toggle = useCallback(() => {
    if (menuPos) {
      setMenuPos(null);
    } else {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ x: rect.left, y: rect.bottom + 4 });
    }
  }, [menuPos]);

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [];
    if (hasOpenableSession) {
      list.push({
        label: `Open session`,
        onClick: () => {
          window.location.hash = `#/sessions/${source.sessionId}`;
        },
      });
    }
    list.push({
      label: `ID: ${source.sessionId.slice(0, 12)}${source.sessionId.length > 12 ? "…" : ""}`,
      onClick: () => {
        writeClipboardText(source.sessionId).catch(console.error);
      },
    });
    return list;
  }, [source.sessionId, hasOpenableSession]);

  return (
    <div className="mb-1.5">
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 text-[10px] text-cc-muted/70 hover:text-cc-muted transition-colors cursor-pointer"
        title="Sent by an agent"
        data-testid="agent-source-badge"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 text-cc-primary/60 shrink-0">
          <path d="M9.5 2L3 9.5h5L6.5 14l7.5-7.5h-5L9.5 2z" />
        </svg>
        <span className="font-mono-code">via {label}</span>
      </button>
      {menuPos && <ContextMenu x={menuPos.x} y={menuPos.y} items={items} onClose={() => setMenuPos(null)} />}
    </div>
  );
}

type MessageThreadBadgeCandidate = {
  threadKey: string;
  source?: NonNullable<NonNullable<ChatMessage["metadata"]>["threadRefs"]>[number]["source"];
};

function getMessageThreadBadgeCandidates(message: ChatMessage): MessageThreadBadgeCandidate[] {
  const metadata = message.metadata;
  if (!metadata) return [];
  const candidates: MessageThreadBadgeCandidate[] = [];
  const add = (threadKey: string | undefined, source?: MessageThreadBadgeCandidate["source"]) => {
    const normalized = threadKey?.trim();
    if (!normalized) return;
    candidates.push(source ? { threadKey: normalized, source } : { threadKey: normalized });
  };
  add(metadata.threadKey);
  add(metadata.questId);
  for (const ref of metadata.threadRefs ?? []) {
    add(ref.threadKey, ref.source);
  }
  return candidates;
}

function getMessageThreadBadgeKey(message: ChatMessage, currentThreadKey?: string): string | null {
  const candidates = getMessageThreadBadgeCandidates(message);
  const fallback = candidates[0]?.threadKey ?? null;
  if (!currentThreadKey || isAllThreadsKey(currentThreadKey)) return fallback;

  const normalizedCurrentThread = normalizeThreadKey(currentThreadKey);
  const crossThreadCandidate = candidates.find(
    (candidate) => normalizeThreadKey(candidate.threadKey) !== normalizedCurrentThread,
  );
  if (crossThreadCandidate) return crossThreadCandidate.threadKey;

  const backfillCandidate = candidates.find((candidate) => candidate.source === "backfill");
  return backfillCandidate?.threadKey ?? null;
}

function ThreadSourceBadge({ threadKey }: { threadKey: string }) {
  return (
    <div className="mb-1.5">
      <span
        className="inline-flex max-w-full items-center rounded-md border border-cc-border/40 bg-cc-hover/35 px-1.5 py-0.5 font-mono-code text-[10px] leading-none text-cc-muted/80"
        data-testid="thread-source-badge"
      >
        {formatThreadMarker(threadKey)}
      </span>
    </div>
  );
}

/** Compact inline rendering for herd event summaries — collapsed by default.
 *  Shows one-line event headers (#N | turn_end | ...) with a toggle chevron.
 *  Expanding reveals the full injected peek-style activity content. */
export function HerdEventMessage({
  message,
  defaultExpanded = false,
}: {
  message: ChatMessage;
  showTimestamp: boolean;
  defaultExpanded?: boolean;
}) {
  // The content is formatted by formatHerdEventBatch():
  // "N events from N sessions\n\n#34 | turn_end | ✓ 56.3s\n  [120] user: ...\n  [121] asst: ...\n#35 | ..."
  // Parse into events: each starts with a #N line (header) followed by indented activity lines.
  const events = useMemo(() => parseHerdEvents(message.content), [message.content]);

  if (events.length === 0) {
    // Fallback for unexpected format — render as simple muted text
    return (
      <div
        className="text-[11px] text-cc-muted font-mono-code pl-9 py-0.5 animate-[fadeSlideIn_0.2s_ease-out]"
        data-worker-event
      >
        {message.content}
      </div>
    );
  }

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out] space-y-1">
      {events.map((evt, i) => (
        <HerdEventEntry key={i} header={evt.header} activity={evt.activity} defaultExpanded={defaultExpanded} />
      ))}
    </div>
  );
}

function splitHerdEventHeader(header: string): { sessionLabel: string | null; remainder: string } {
  const match = header.match(/^(#\d+)(.*)$/);
  if (!match) return { sessionLabel: null, remainder: header };
  return { sessionLabel: match[1], remainder: match[2] || "" };
}

/** A single herd event rendered as a compact expandable chip.
 *  Every event is clickable. Collapsed: inline pill showing the event header
 *  (e.g. "#287 | turn_end | ✓ 53.6s"). Expanded: full content -- activity lines
 *  for turn_end events, or the untruncated header for other event types. */
function HerdEventEntry({
  header,
  activity,
  defaultExpanded = false,
}: {
  header: string;
  activity: string[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasActivity = activity.some((line) => line.trim().length > 0);
  const { sessionLabel, remainder } = useMemo(() => splitHerdEventHeader(header), [header]);
  const summaryHeader = useMemo(() => getHerdEventHeaderSummary(header), [header]);
  const { remainder: summaryRemainder } = useMemo(() => splitHerdEventHeader(summaryHeader), [summaryHeader]);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const sessionNum = useMemo(() => {
    if (!sessionLabel) return null;
    const raw = sessionLabel.slice(1);
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, [sessionLabel]);
  const sdkInfo = useMemo(
    () => (sessionNum == null ? null : (sdkSessions.find((session) => session.sessionNum === sessionNum) ?? null)),
    [sdkSessions, sessionNum],
  );
  const resolvedSessionId = sdkInfo?.sessionId ?? null;
  const resolvedNavigation = useStore((state) =>
    resolvedSessionId ? resolveSessionNavigation(state, resolvedSessionId) : null,
  );
  const sessionItem = resolvedNavigation?.sidebarItem ?? null;

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleExpanded();
    },
    [toggleExpanded],
  );

  const handleSessionClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!resolvedSessionId) return;
      navigateToSession(resolvedSessionId);
    },
    [resolvedSessionId],
  );

  const handleSessionKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
    }
  }, []);

  const handleSessionMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!sessionItem) return;
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
      setHoverRect(e.currentTarget.getBoundingClientRect());
    },
    [sessionItem],
  );

  const handleSessionMouseLeave = useCallback(() => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }, []);

  const handleHoverCardEnter = useCallback(() => {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }, []);

  const handleHoverCardLeave = useCallback(() => {
    setHoverRect(null);
  }, []);

  return (
    <div className="pl-9" data-worker-event>
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={handleContainerKeyDown}
        aria-expanded={expanded}
        className={`${HERD_CHIP_BASE} ${HERD_CHIP_INTERACTIVE}`}
      >
        <span className="text-amber-500/50 shrink-0 text-[10px]">◇</span>
        {sessionLabel ? (
          resolvedSessionId ? (
            <button
              type="button"
              onClick={handleSessionClick}
              onKeyDown={handleSessionKeyDown}
              onMouseEnter={handleSessionMouseEnter}
              onMouseLeave={handleSessionMouseLeave}
              className="shrink-0 rounded-sm font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2 cursor-pointer focus-visible:outline-none focus-visible:text-amber-300 focus-visible:underline focus-visible:decoration-dotted focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-cc-card"
              aria-label={`Open session ${sessionLabel}`}
              title={`Open session ${sessionLabel}`}
            >
              {sessionLabel}
            </button>
          ) : (
            <span className="shrink-0">{sessionLabel}</span>
          )
        ) : null}
        <span className={expanded ? "break-words min-w-0" : "truncate min-w-0 max-w-[60ch]"}>
          {sessionLabel ? (expanded ? remainder : summaryRemainder) : expanded ? header : summaryHeader}
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-2.5 h-2.5 shrink-0 text-cc-muted/40 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 3l5 5-5 5V3z" />
        </svg>
      </div>
      {resolvedSessionId && sessionItem && hoverRect && (
        <SessionHoverCard
          session={sessionItem}
          sessionName={resolvedNavigation?.sidebarItem.name}
          sessionPreview={resolvedNavigation?.sidebarItem.lastMessagePreview || undefined}
          taskHistory={sessionTaskHistory.get(resolvedSessionId)}
          cliSessionId={sdkInfo?.cliSessionId}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
        />
      )}
      {expanded && hasActivity && (
        <pre
          className="mt-1 ml-1 px-2.5 py-2 rounded-md border border-cc-border/20 bg-cc-card/30
          text-[10px] text-cc-muted/80 font-mono-code leading-relaxed
          whitespace-pre-wrap break-words overflow-x-auto max-h-[400px] overflow-y-auto"
        >
          {activity.join("\n")}
        </pre>
      )}
    </div>
  );
}

// Re-export herd event parsing utilities for backward compatibility
export { EVENT_HEADER_RE, parseHerdEvents } from "../utils/herd-event-parser.js";

function ThreadOutcomeReminderMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
  questLinkSurface,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
  questLinkSurface: QuestLinkSurface;
}) {
  const [expanded, setExpanded] = useState(false);
  const notifications = useStore((s) => (sessionId ? s.sessionNotifications?.get(sessionId) : undefined));
  const reminder = buildThreadOutcomeReminderViewModel(message, notifications);
  if (!reminder) return null;
  const renderedTitle = searchHighlight?.query ? (
    <HighlightedText
      text={reminder.title}
      query={searchHighlight.query}
      mode={searchHighlight.mode}
      isCurrent={searchHighlight.isCurrent}
    />
  ) : (
    reminder.title
  );

  return (
    <div className="pl-9 py-0.5 animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="max-w-3xl">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${reminder.title}`}
              className="inline-flex max-w-full items-center gap-2 rounded-md border border-cc-border/35 bg-cc-hover/20 px-2 py-1 text-left text-[11px] leading-snug text-cc-muted/85 transition-colors hover:border-cc-border/55 hover:bg-cc-hover/35 hover:text-cc-fg/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cc-primary/60"
              data-testid="thread-outcome-reminder-chip"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`h-3 w-3 shrink-0 text-cc-muted/55 transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                className="h-3.5 w-3.5 shrink-0 text-cc-primary/65"
                aria-hidden="true"
              >
                <path d="M8 2.5v5l3 1.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="8" cy="8" r="5.5" />
              </svg>
              <span className="min-w-0 truncate font-mono-code">{renderedTitle}</span>
            </button>
            {expanded && (
              <div className="mt-1.5 rounded-md border border-cc-border/20 bg-cc-card/35 px-2.5 py-2 text-left">
                {reminder.satisfiedSummary && (
                  <div className="mb-1.5 text-[11px] leading-snug text-cc-muted">
                    Satisfied by needs-input: {reminder.satisfiedSummary}
                  </div>
                )}
                <MarkdownContent
                  text={reminder.rawContent}
                  variant="conservative"
                  sessionId={sessionId}
                  searchHighlight={searchHighlight}
                  questLinkSurface={questLinkSurface}
                />
              </div>
            )}
          </div>
          {showTimestamp && <MessageTimestamp timestamp={message.timestamp} />}
        </div>
      </div>
    </div>
  );
}

/** Read-only reply chip shown above user message bubbles when the user replied to a specific assistant message. */
export function UserReplyChip({ previewText, messageId }: { previewText: string; messageId?: string }) {
  const handleClick = useCallback(() => {
    if (!messageId) return;
    const target = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    // Brief highlight flash
    target.classList.add("reply-highlight-flash");
    setTimeout(() => target.classList.remove("reply-highlight-flash"), 1500);
  }, [messageId]);

  return (
    <div
      className={`flex items-center gap-1.5 mb-1.5 text-[11px] text-cc-muted/80 max-w-full min-w-0${messageId ? " cursor-pointer hover:text-cc-muted transition-colors" : ""}`}
      onClick={messageId ? handleClick : undefined}
      role={messageId ? "button" : undefined}
      title={messageId ? "Scroll to original message" : undefined}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3 h-3 shrink-0 text-cc-primary/60"
      >
        <path d="M6 3L2 7l4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 7h7a4 4 0 014 4v1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{previewText}</span>
    </div>
  );
}

function UserMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
  currentThreadKey,
  readOnly,
  questLinkSurface,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
  currentThreadKey?: string;
  readOnly: boolean;
  questLinkSurface: QuestLinkSurface;
}) {
  const [lightboxSelection, setLightboxSelection] = useState<{
    id: string;
    src: string;
    usesLocalPreview: boolean;
  } | null>(null);

  const isCodex = useStore((s) => s.sessions.get(sessionId ?? "")?.backend_type === "codex");
  const starred = useFeedStarredMessage(sessionId, message);
  const starAction = useMessageStarActions(sessionId, message);
  const messagesBySession = useStore((s) => s.messages);
  const sessionMessages = sessionId ? (messagesBySession.get(sessionId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const canRevert = useMemo(() => {
    if (!sessionId) return false;
    if (!isCodex) return true;
    const idx = sessionMessages.findIndex((m) => m.id === message.id);
    if (idx < 0) return true;
    for (let i = idx - 1; i >= 0; i--) {
      const prior = sessionMessages[i];
      if (prior?.role !== "user") return true;
      return false;
    }
    return true;
  }, [sessionId, isCodex, sessionMessages, message.id]);

  const replyContext = useMemo(
    () => getDisplayReplyContext(message.content, message.metadata?.replyContext),
    [message.content, message.metadata?.replyContext],
  );
  const displayContent = replyContext ? replyContext.userMessage : message.content;
  const imagePreviewItems = useMemo(() => buildUserImagePreviewItems(message, sessionId), [message, sessionId]);
  const retireLocalImage = useCallback(
    (image: ImagePreviewItem) => {
      if (!sessionId || !image.localImageId) return;
      const state = useStore.getState();
      const current =
        state.messages.get(sessionId)?.find((candidate) => candidate.id === message.id) ??
        [...(state.threadWindowMessages.get(sessionId)?.values() ?? [])]
          .flat()
          .find((candidate) => candidate.id === message.id);
      if (!current?.localImages?.length) return;
      const nextLocalImages = current.localImages.filter((local) => local.imageId !== image.localImageId);
      state.updateMessage(sessionId, message.id, {
        localImages: nextLocalImages.length > 0 ? nextLocalImages : undefined,
      });
    },
    [message.id, sessionId],
  );
  const handleImageError = useCallback(
    (image: ImagePreviewItem) => {
      if (lightboxSelection?.id === image.id && image.fallback) {
        setLightboxSelection({ id: image.id, src: image.fallback.fullUrl, usesLocalPreview: false });
      }
      retireLocalImage(image);
    },
    [lightboxSelection?.id, retireLocalImage],
  );
  const handleLocalPreviewReleased = useCallback(
    (previewUrls: string[]) => {
      if (!sessionId || previewUrls.length === 0) return;
      const state = useStore.getState();
      const previewUrlSet = new Set(previewUrls);
      const current =
        state.messages.get(sessionId)?.find((candidate) => candidate.id === message.id) ??
        [...(state.threadWindowMessages.get(sessionId)?.values() ?? [])]
          .flat()
          .find((candidate) => candidate.id === message.id);
      if (current?.localImages?.some((image) => image.previewUrl && previewUrlSet.has(image.previewUrl))) {
        const nextLocalImages = current.localImages.filter(
          (image) => !image.previewUrl || !previewUrlSet.has(image.previewUrl),
        );
        state.updateMessage(sessionId, message.id, {
          localImages: nextLocalImages.length > 0 ? nextLocalImages : undefined,
        });
      }
      reconcileLocalImagePreviewUrls(useStore.getState(), sessionId);
    },
    [message.id, sessionId],
  );

  useEffect(() => {
    if (!lightboxSelection) return;
    const selectedImage = imagePreviewItems.find((image) => image.id === lightboxSelection.id);
    if (!selectedImage) {
      setLightboxSelection(null);
      return;
    }
    if (
      lightboxSelection.usesLocalPreview &&
      selectedImage.localImageId &&
      selectedImage.fullUrl !== lightboxSelection.src
    ) {
      setLightboxSelection({ id: selectedImage.id, src: selectedImage.fullUrl, usesLocalPreview: true });
    }
  }, [imagePreviewItems, lightboxSelection]);

  useEffect(() => {
    setLightboxSelection(null);
  }, [message.id]);
  const threadKey = getMessageThreadBadgeKey(message, currentThreadKey);
  const pendingLabel =
    message.pendingState === "uploading"
      ? "Uploading image…"
      : message.pendingState === "delivering"
        ? "Sending…"
        : message.pendingState === "failed"
          ? message.pendingError || "Send failed"
          : null;

  return (
    <div className="relative flex justify-end items-start gap-1 group/msg animate-[fadeSlideIn_0.2s_ease-out]">
      {!readOnly && starred && (
        <span className="pointer-events-none absolute left-0 top-2.5 z-20 flex w-10 items-center sm:w-[calc(20%_-_0.375rem)] sm:max-w-40">
          <StarredMessageRailMarker
            side="user"
            onUnstar={starAction.actionable && starAction.starred ? starAction.toggleStarred : undefined}
          />
          <span className="pointer-events-none ml-1 h-px min-w-0 flex-1 bg-gradient-to-r from-amber-300/30 to-amber-300/0" />
        </span>
      )}
      <div
        data-testid="user-message-bubble"
        className="relative z-10 min-w-0 max-w-[calc(100%_-_2rem)] sm:max-w-[80%] sm:min-w-[200px] px-3 sm:px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg"
      >
        {threadKey && <ThreadSourceBadge threadKey={threadKey} />}
        {message.agentSource && <AgentSourceBadge source={message.agentSource} />}
        {replyContext && <UserReplyChip previewText={replyContext.previewText} messageId={replyContext.messageId} />}
        {message.metadata?.vscodeSelection && (
          <div className="mb-2 flex">
            <div
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted"
              title={message.metadata.vscodeSelection.relativePath}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
              </svg>
              <span className="truncate font-mono-code">
                {formatVsCodeSelectionAttachmentLabel(message.metadata.vscodeSelection)}
              </span>
            </div>
          </div>
        )}
        <ImagePreviewGroup
          key={message.id}
          images={imagePreviewItems}
          className="!mt-0 mb-1"
          testId="user-image-preview-group"
          onOpenImage={(image) =>
            setLightboxSelection({
              id: image.id,
              src: image.fullUrl,
              usesLocalPreview: Boolean(image.localImageId),
            })
          }
          onImageSettled={retireLocalImage}
          onImageError={handleImageError}
          localPreviewSessionId={sessionId}
          onLocalPreviewReleased={handleLocalPreviewReleased}
          size="message"
        />
        {pendingLabel && <div className="mb-2 text-[11px] text-cc-muted/80 font-mono-code">{pendingLabel}</div>}
        <CollapsibleContent>
          <MarkdownContent
            text={displayContent}
            variant="conservative"
            sessionId={sessionId}
            searchHighlight={searchHighlight}
            fileLinkMode={readOnly ? "text-only" : "interactive"}
            questLinkSurface={questLinkSurface}
          />
        </CollapsibleContent>
        {showTimestamp && <MessageTimestamp timestamp={message.timestamp} />}
      </div>
      {!readOnly && !message.pendingState && (
        <UserMessageMenu message={message} sessionId={sessionId} canRevert={canRevert} />
      )}
      {lightboxSelection && (
        <Lightbox src={lightboxSelection.src} alt="attachment" onClose={() => setLightboxSelection(null)} />
      )}
    </div>
  );
}

interface ToolGroupItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type GroupedBlock =
  | { kind: "content"; block: ContentBlock }
  | { kind: "tool_group"; name: string; items: ToolGroupItem[] };

type RenderedGroupedBlock =
  | GroupedBlock
  | { kind: "tool_activity"; groups: Array<Extract<GroupedBlock, { kind: "tool_group" }>>; items: ToolGroupItem[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const groups: GroupedBlock[] = [];

  for (const block of blocks) {
    // Skip Task blocks — they render as SubagentContainers in MessageFeed,
    // not as standalone ToolBlocks. Without this filter, every subagent would
    // appear twice: once as an inline Agent chip (SubagentContainer) and once
    // as a "Subagent" ToolBlock chip.
    if (block.type === "tool_use" && isSubagentToolName(block.name)) continue;
    if (block.type === "tool_use" && isToolHiddenFromChat(block.name)) continue;

    if (block.type === "tool_use") {
      const last = groups[groups.length - 1];
      // Never merge file-operation tools -- each gets its own standalone chip
      if (!FILE_TOOL_NAMES.has(block.name) && last?.kind === "tool_group" && last.name === block.name) {
        last.items.push({ id: block.id, name: block.name, input: block.input });
      } else {
        groups.push({
          kind: "tool_group",
          name: block.name,
          items: [{ id: block.id, name: block.name, input: block.input }],
        });
      }
    } else {
      groups.push({ kind: "content", block });
    }
  }

  return groups;
}

function compactToolGroups(groups: GroupedBlock[]): RenderedGroupedBlock[] {
  const compacted: RenderedGroupedBlock[] = [];
  let index = 0;

  while (index < groups.length) {
    const group = groups[index];
    if (group.kind !== "tool_group" || !group.items.every(isCompactToolActivityItem)) {
      compacted.push(group);
      index++;
      continue;
    }

    const activityGroups: Array<Extract<GroupedBlock, { kind: "tool_group" }>> = [];
    const items: ToolGroupItem[] = [];
    while (index < groups.length) {
      const candidate = groups[index];
      if (candidate.kind !== "tool_group" || !candidate.items.every(isCompactToolActivityItem)) break;
      activityGroups.push(candidate);
      items.push(...candidate.items);
      index++;
    }
    compacted.push({ kind: "tool_activity", groups: activityGroups, items });
  }

  return compacted;
}

function getInlineToolNotificationCategory(blocks: ContentBlock[]): "needs-input" | "review" | null {
  for (const block of blocks) {
    if (block.type !== "tool_use" || block.name !== "Bash") continue;
    const match = parseTakodeNotifyCommand(String(block.input.command ?? ""));
    if (match) return match.category;
  }
  return null;
}

function AssistantMessage({
  message,
  sessionId,
  showTimestamp,
  searchHighlight,
  currentThreadKey,
  onSelectThread,
  showSideChatActions,
  readOnly,
  isCodexSession,
  toolResultOverrides,
  toolResultScope,
  questLinkSurface,
}: {
  message: ChatMessage;
  sessionId?: string;
  showTimestamp: boolean;
  searchHighlight?: SearchHighlightInfo;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  showSideChatActions: boolean;
  readOnly: boolean;
  isCodexSession: boolean;
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope: ToolResultScope;
  questLinkSurface: QuestLinkSurface;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const hidePaw = useContext(HidePawContext);
  const inboxNotifications = useStore((s) => (sessionId ? s.sessionNotifications?.get(sessionId) : undefined));
  const authoritativeNotifications = useFeedDisplayNotifications(sessionId, inboxNotifications);
  const notificationStateLoaded = useStore((s) => {
    if (!sessionId) return false;
    if (s.sessionNotifications.has(sessionId)) return true;
    const session = s.sdkSessions.find((candidate) => candidate.sessionId === sessionId);
    return (
      session?.notificationUrgency !== undefined ||
      session?.activeNotificationCount !== undefined ||
      session?.activeNeedsInputNotificationCount !== undefined ||
      session?.activeReviewNotificationCount !== undefined ||
      session?.mutedNeedsInputNotificationCount !== undefined ||
      session?.notificationStatusVersion !== undefined ||
      session?.notificationStatusUpdatedAt !== undefined
    );
  });
  const inboxAnchoredNotification = useMemo(
    () => (message.id ? getSingleAnchoredNotification(authoritativeNotifications, message.id) : null),
    [authoritativeNotifications, message.id],
  );
  const resolvedNotification = notificationStateLoaded ? inboxAnchoredNotification : message.notification;
  const compactToolActivity = useStore((state) => state.compactToolActivity);
  const threadKey = getMessageThreadBadgeKey(message, currentThreadKey);
  const starred = useFeedStarredMessage(sessionId, message);
  const starAction = useMessageStarActions(sessionId, message);
  const sideChat = useSideChatForMessage(sessionId, message);
  const assistantImagePreviewItems = useMemo(
    () => (readOnly ? [] : buildAssistantImagePreviewItems(message, sessionId)),
    [message, readOnly, sessionId],
  );
  const projection = useMemo(
    () =>
      projectAssistantMessageForRendering(message, {
        isCodexSession,
        hasAnchoredNotification: resolvedNotification != null,
        hasVisibleSideChat: !readOnly && sideChat != null,
      }),
    [isCodexSession, message, readOnly, resolvedNotification, sideChat],
  );
  const blocks = projection.blocks;
  const grouped = useMemo(() => groupContentBlocks(blocks), [blocks]);
  const renderedGroups = useMemo(
    () => (compactToolActivity ? compactToolGroups(grouped) : grouped),
    [compactToolActivity, grouped],
  );
  const compactInlineNotificationCategory =
    compactToolActivity && !resolvedNotification ? getInlineToolNotificationCategory(blocks) : null;
  const suppressToolNotificationMarker = !!resolvedNotification || !!compactInlineNotificationCategory;
  const hasTextContent =
    projection.hasTextBlock || projection.hasThinkingBlock || projection.shouldRenderContentFallback;
  const firstContentGroupIndex = projection.shouldRenderContentFallback
    ? -1
    : renderedGroups.findIndex((group) => group.kind === "content");
  const showRailMarker = !hidePaw || (!readOnly && starred);
  const unstarFromRail = starAction.actionable && starAction.starred ? starAction.toggleStarred : undefined;

  if (!projection.renderable) return null;

  if (blocks.length === 0 && projection.shouldRenderContentFallback) {
    return (
      <div
        className={`group/msg relative flex items-start animate-[fadeSlideIn_0.2s_ease-out] ${showRailMarker ? "gap-2 sm:gap-3" : ""}`}
      >
        {showRailMarker &&
          (!readOnly && starred ? (
            <StarredMessageRailMarker side="assistant" onUnstar={unstarFromRail} />
          ) : (
            <PawTrailAvatar />
          ))}
        <div ref={contentRef} className="flex-1 min-w-0">
          {threadKey && <ThreadSourceBadge threadKey={threadKey} />}
          {!readOnly && hasTextContent && (
            <AssistantMessageMenu
              message={message}
              contentRef={contentRef}
              sessionId={sessionId}
              currentThreadKey={currentThreadKey}
              showSideChatActions={showSideChatActions}
            />
          )}
          {readOnly ? (
            <MarkdownContent
              text={projection.fallbackText}
              sessionId={sessionId}
              searchHighlight={searchHighlight}
              fileLinkMode="text-only"
              questLinkSurface={questLinkSurface}
            />
          ) : (
            <AssistantQuestQuizContent
              text={projection.fallbackText}
              sessionId={sessionId}
              searchHighlight={searchHighlight}
              enableChatSelectionMenu
              questLinkSurface={questLinkSurface}
            />
          )}
          <ImagePreviewGroup images={assistantImagePreviewItems} testId="assistant-image-preview-group" />
          {!readOnly && resolvedNotification && (
            <NotificationMarker
              category={resolvedNotification.category}
              summary={resolvedNotification.summary}
              notificationId={resolvedNotification.id}
              sessionId={sessionId}
              messageId={message.id}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
            />
          )}
          {showTimestamp && <MessageTimestamp timestamp={message.timestamp} turnDurationMs={message.turnDurationMs} />}
          {showSideChatActions && sideChat && <SideChatSummary sideChat={sideChat} sessionId={sessionId} />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group/msg relative flex items-start animate-[fadeSlideIn_0.2s_ease-out] ${showRailMarker ? "gap-2 sm:gap-3" : ""}`}
    >
      {showRailMarker &&
        (!readOnly && starred ? (
          <StarredMessageRailMarker side="assistant" onUnstar={unstarFromRail} />
        ) : (
          <PawTrailAvatar />
        ))}
      <div ref={contentRef} className="flex-1 min-w-0 space-y-3">
        {threadKey && <ThreadSourceBadge threadKey={threadKey} />}
        {projection.shouldRenderContentFallback && (
          <div className="flow-root">
            {!readOnly && hasTextContent && (
              <AssistantMessageMenu
                message={message}
                contentRef={contentRef}
                sessionId={sessionId}
                currentThreadKey={currentThreadKey}
                showSideChatActions={showSideChatActions}
              />
            )}
            {readOnly ? (
              <MarkdownContent
                text={projection.fallbackText}
                sessionId={sessionId}
                searchHighlight={searchHighlight}
                fileLinkMode="text-only"
                questLinkSurface={questLinkSurface}
              />
            ) : (
              <AssistantQuestQuizContent
                text={projection.fallbackText}
                sessionId={sessionId}
                searchHighlight={searchHighlight}
                enableChatSelectionMenu
                questLinkSurface={questLinkSurface}
              />
            )}
          </div>
        )}
        {renderedGroups.map((group, i) => {
          if (group.kind === "content") {
            const renderedBlock = (
              <ContentBlockRenderer
                key={i}
                block={group.block}
                sessionId={sessionId}
                parentMessageId={message.id}
                searchHighlight={searchHighlight}
                suppressNotificationMarker={suppressToolNotificationMarker}
                currentThreadKey={currentThreadKey}
                onSelectThread={onSelectThread}
                readOnly={readOnly}
                toolResultOverrides={toolResultOverrides}
                toolResultScope={toolResultScope}
                questLinkSurface={questLinkSurface}
              />
            );
            if (!projection.shouldRenderContentFallback && hasTextContent && i === firstContentGroupIndex) {
              return (
                <div key={i} className="flow-root">
                  {!readOnly && (
                    <AssistantMessageMenu
                      message={message}
                      contentRef={contentRef}
                      sessionId={sessionId}
                      currentThreadKey={currentThreadKey}
                      showSideChatActions={showSideChatActions}
                    />
                  )}
                  {renderedBlock}
                </div>
              );
            }
            return renderedBlock;
          }
          if (group.kind === "tool_activity") {
            return (
              <CompactToolActivity
                key={i}
                items={group.items as CompactToolActivityItem[]}
                sessionId={sessionId}
                containedMessageIds={[message.id]}
              >
                {group.groups.map((detailGroup, detailIndex) => (
                  <DetailedToolGroup
                    key={`${detailGroup.items[0]?.id ?? detailIndex}`}
                    group={detailGroup}
                    sessionId={sessionId}
                    parentMessageId={message.id}
                    suppressNotificationMarker={suppressToolNotificationMarker}
                    currentThreadKey={currentThreadKey}
                    onSelectThread={onSelectThread}
                    readOnly={readOnly}
                    toolResultOverrides={toolResultOverrides}
                    toolResultScope={toolResultScope}
                    questLinkSurface={questLinkSurface}
                  />
                ))}
              </CompactToolActivity>
            );
          }
          return (
            <DetailedToolGroup
              key={i}
              group={group}
              sessionId={sessionId}
              parentMessageId={message.id}
              suppressNotificationMarker={suppressToolNotificationMarker}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
              readOnly={readOnly}
              toolResultOverrides={toolResultOverrides}
              toolResultScope={toolResultScope}
              questLinkSurface={questLinkSurface}
            />
          );
        })}
        <ImagePreviewGroup images={assistantImagePreviewItems} testId="assistant-image-preview-group" />
        {!readOnly && resolvedNotification && (
          <NotificationMarker
            category={resolvedNotification.category}
            summary={resolvedNotification.summary}
            notificationId={resolvedNotification.id}
            sessionId={sessionId}
            messageId={message.id}
            currentThreadKey={currentThreadKey}
            onSelectThread={onSelectThread}
          />
        )}
        {!readOnly && compactInlineNotificationCategory && (
          <NotificationMarker
            category={compactInlineNotificationCategory}
            sessionId={sessionId}
            messageId={message.id}
            currentThreadKey={currentThreadKey}
            onSelectThread={onSelectThread}
          />
        )}
        {showTimestamp && <MessageTimestamp timestamp={message.timestamp} turnDurationMs={message.turnDurationMs} />}
        {showSideChatActions && sideChat && <SideChatSummary sideChat={sideChat} sessionId={sessionId} />}
      </div>
    </div>
  );
}

function DetailedToolGroup({
  group,
  sessionId,
  parentMessageId,
  suppressNotificationMarker,
  currentThreadKey,
  onSelectThread,
  readOnly,
  toolResultOverrides,
  toolResultScope,
  questLinkSurface,
}: {
  group: Extract<GroupedBlock, { kind: "tool_group" }>;
  sessionId?: string;
  parentMessageId?: string;
  suppressNotificationMarker: boolean;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  readOnly: boolean;
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope: ToolResultScope;
  questLinkSurface: QuestLinkSurface;
}) {
  if (group.items.length === 1) {
    const item = group.items[0];
    return (
      <ToolBlock
        name={item.name}
        input={item.input}
        toolUseId={item.id}
        sessionId={sessionId}
        parentMessageId={parentMessageId}
        suppressNotificationMarker={suppressNotificationMarker}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        disableInlineSpecialCases={readOnly}
        resultOverride={toolResultOverrides?.get(item.id)}
        suppressStoredResult={toolResultScope === "overrides-only"}
        readOnly={readOnly}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  return (
    <ToolGroupBlock
      name={group.name}
      items={group.items}
      sessionId={sessionId}
      parentMessageId={parentMessageId}
      suppressNotificationMarker={suppressNotificationMarker}
      currentThreadKey={currentThreadKey}
      onSelectThread={onSelectThread}
      readOnly={readOnly}
      toolResultOverrides={toolResultOverrides}
      toolResultScope={toolResultScope}
      questLinkSurface={questLinkSurface}
    />
  );
}

/** Auto-approved chip — shows what was approved on line 1, LLM rationale on line 2 in muted text. */
function AutoApprovedChip({ content, reason }: { content: string; reason?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-start gap-1.5 px-3 py-1.5 rounded-[14px] rounded-br-[4px] bg-green-500/10 text-xs text-green-400/80 font-mono-code max-w-[85%] text-left cursor-pointer hover:bg-green-500/15 transition-colors"
      >
        <svg
          className="w-3 h-3 text-green-400/60 shrink-0 mt-0.5"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.5 8.5l2 2 3.5-4" />
        </svg>
        <div className="min-w-0">
          <span className={expanded ? "" : "line-clamp-1"}>{content}</span>
          {reason && (
            <span className={`block text-[10px] text-green-400/40 mt-0.5 ${expanded ? "" : "line-clamp-1"}`}>
              {reason}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

function CompactMarker({
  message,
  sessionId,
  questLinkSurface,
}: {
  message: ChatMessage;
  sessionId?: string;
  questLinkSurface: QuestLinkSurface;
}) {
  const [expanded, setExpanded] = useState(false);
  const markerKind = message.metadata?.compactMarkerKind === "session_recycled" ? "session_recycled" : "compaction";
  const label = markerKind === "session_recycled" ? "Session recycled" : "Conversation compacted";
  const hasSummary = message.content && message.content !== label;

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-cc-border" />
        <button
          onClick={() => hasSummary && setExpanded(!expanded)}
          className={`flex items-center gap-1.5 text-[11px] text-cc-muted italic font-mono-code shrink-0 px-2 py-0.5 rounded-md transition-colors ${
            hasSummary ? "hover:bg-cc-hover cursor-pointer" : ""
          }`}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3 h-3 shrink-0 opacity-60"
          >
            <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round" />
          </svg>
          <span>{label}</span>
          {hasSummary && (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          )}
        </button>
        <div className="flex-1 h-px bg-cc-border" />
      </div>
      {expanded && hasSummary && (
        <div className="mt-2 mx-4 max-h-96 overflow-y-auto rounded-lg border border-cc-border bg-cc-card p-3">
          <MarkdownContent
            text={message.content}
            sessionId={sessionId}
            enableChatSelectionMenu
            questLinkSurface={questLinkSurface}
          />
        </div>
      )}
    </div>
  );
}

function ContentBlockRenderer({
  block,
  sessionId,
  parentMessageId,
  searchHighlight,
  suppressNotificationMarker = false,
  currentThreadKey,
  onSelectThread,
  readOnly = false,
  toolResultOverrides,
  toolResultScope,
  questLinkSurface,
}: {
  block: ContentBlock;
  sessionId?: string;
  parentMessageId?: string;
  searchHighlight?: { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;
  suppressNotificationMarker?: boolean;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  readOnly?: boolean;
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope: ToolResultScope;
  questLinkSurface: QuestLinkSurface;
}) {
  const isCodex = useStore((s) => (sessionId ? s.sessions.get(sessionId)?.backend_type === "codex" : false));

  if (block.type === "text") {
    return readOnly ? (
      <MarkdownContent
        text={block.text}
        sessionId={sessionId}
        searchHighlight={searchHighlight}
        fileLinkMode="text-only"
        questLinkSurface={questLinkSurface}
      />
    ) : (
      <AssistantQuestQuizContent
        text={block.text}
        sessionId={sessionId}
        searchHighlight={searchHighlight}
        enableChatSelectionMenu
        questLinkSurface={questLinkSurface}
      />
    );
  }

  if (block.type === "thinking") {
    return <ThinkingBlock text={block.thinking} thinkingTimeMs={block.thinking_time_ms} isCodex={isCodex} />;
  }

  if (block.type === "tool_use") {
    return (
      <ToolBlock
        name={block.name}
        input={block.input}
        toolUseId={block.id}
        sessionId={sessionId}
        parentMessageId={parentMessageId}
        suppressNotificationMarker={suppressNotificationMarker}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        disableInlineSpecialCases={readOnly}
        resultOverride={toolResultOverrides?.get(block.id)}
        suppressStoredResult={toolResultScope === "overrides-only"}
        readOnly={readOnly}
        questLinkSurface={questLinkSurface}
      />
    );
  }

  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    const isError = block.is_error;
    return (
      <div
        className={`text-xs font-mono-code rounded-lg px-3 py-2 border ${
          isError ? "bg-cc-error/5 border-cc-error/20 text-cc-error" : "bg-cc-card border-cc-border text-cc-muted"
        } max-h-40 overflow-y-auto whitespace-pre-wrap`}
      >
        {content}
      </div>
    );
  }

  return null;
}

function ToolGroupBlock({
  name,
  items,
  sessionId,
  parentMessageId,
  suppressNotificationMarker = false,
  currentThreadKey,
  onSelectThread,
  readOnly = false,
  toolResultOverrides,
  toolResultScope,
  questLinkSurface,
}: {
  name: string;
  items: ToolGroupItem[];
  sessionId?: string;
  parentMessageId?: string;
  suppressNotificationMarker?: boolean;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  readOnly?: boolean;
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope: ToolResultScope;
  questLinkSurface: QuestLinkSurface;
}) {
  const [open, setOpen] = useState(true);
  const headerRef = useRef<HTMLButtonElement>(null);
  const iconType = getToolIcon(name);
  const label = getToolLabel(name);

  // Edit/Write groups: flat stack of inline diffs, no group card wrapper.
  // Each ToolBlock renders as EditInline (flat diff) via its own early return.
  if (name === "Edit" || name === "Write") {
    return (
      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <ToolBlock
            key={item.id || i}
            name={item.name}
            input={item.input}
            toolUseId={item.id}
            sessionId={sessionId}
            parentMessageId={parentMessageId}
            suppressNotificationMarker={suppressNotificationMarker}
            currentThreadKey={currentThreadKey}
            onSelectThread={onSelectThread}
            disableInlineSpecialCases={readOnly}
            resultOverride={toolResultOverrides?.get(item.id)}
            suppressStoredResult={toolResultScope === "overrides-only"}
            readOnly={readOnly}
            questLinkSurface={questLinkSurface}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="text-xs font-medium text-cc-fg">{label}</span>
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums">
          {items.length}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border px-3 py-2 flex flex-col gap-1.5">
          {items.map((item, i) => (
            <ToolBlock
              key={item.id || i}
              name={item.name}
              input={item.input}
              toolUseId={item.id}
              sessionId={sessionId}
              parentMessageId={parentMessageId}
              hideLabel={name === "Bash"}
              suppressNotificationMarker={suppressNotificationMarker}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
              disableInlineSpecialCases={readOnly}
              resultOverride={toolResultOverrides?.get(item.id)}
              suppressStoredResult={toolResultScope === "overrides-only"}
              readOnly={readOnly}
              questLinkSurface={questLinkSurface}
            />
          ))}
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function formatThinkingSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0";
  return (ms / 1000).toFixed(1).replace(/\.0$/, "");
}

function normalizeCodexThinkingSummary(text: string): string {
  const trimmed = text.trim();
  const wrapped = trimmed.match(/^\*\*([\s\S]+?)\*\*$/);
  return wrapped ? wrapped[1].trim() : text;
}

const CODEX_THINKING_PREVIEW_MAX_CHARS = 80;

export function CodexThinkingInline({ text, thinkingTimeMs }: { text: string; thinkingTimeMs?: number }) {
  const [open, setOpen] = useState(false);
  const summaryText = normalizeCodexThinkingSummary(text);
  const isLongSummary = summaryText.length > CODEX_THINKING_PREVIEW_MAX_CHARS;
  const visibleSummary =
    isLongSummary && !open ? `${summaryText.slice(0, CODEX_THINKING_PREVIEW_MAX_CHARS).trimEnd()}` : summaryText;
  const timeSuffix = typeof thinkingTimeMs === "number" ? ` (${formatThinkingSeconds(thinkingTimeMs)} s)` : "";

  return (
    <div className="flex items-start gap-1.5 text-xs text-cc-muted leading-relaxed py-0.5">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-3.5 h-3.5 text-cc-muted/80 shrink-0 mt-[1px]"
      >
        <path d="M8 2.5a4 4 0 014 4c0 1.4-.7 2.5-1.7 3.2-.5.3-.8.9-.8 1.5V12H6.5v-.8c0-.6-.3-1.2-.8-1.5A3.9 3.9 0 014 6.5a4 4 0 014-4z" />
        <path d="M6.2 13.5h3.6M6.7 15h2.6" strokeLinecap="round" />
      </svg>
      <p className="whitespace-pre-wrap break-words">
        {visibleSummary}
        {timeSuffix}
        {isLongSummary && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="inline-flex items-center ml-1 text-cc-muted/80 hover:text-cc-fg transition-colors cursor-pointer align-baseline"
            aria-label={open ? "Collapse thinking summary" : "Expand thinking summary"}
            title={open ? "Collapse" : "Expand"}
          >
            …
          </button>
        )}
      </p>
    </div>
  );
}

function ThinkingBlock({ text, thinkingTimeMs, isCodex }: { text: string; thinkingTimeMs?: number; isCodex: boolean }) {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLButtonElement>(null);

  if (isCodex) {
    return <CodexThinkingInline text={text} thinkingTimeMs={thinkingTimeMs} />;
  }

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden">
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-cc-muted hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="font-medium">Thinking</span>
        <span className="text-cc-muted/60">{text.length} chars</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0">
          <pre className="text-xs text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
            {text}
          </pre>
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
