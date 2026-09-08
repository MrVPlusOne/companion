import { CodexSubagentTurnSegment } from "./CodexSubagentTurnSegment.js";
import { TurnCollapseBar } from "./TurnActivitySummary.js";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type {
  ChatMessage,
  ContentBlock,
  ThreadAttachmentMarker,
  ThreadTransitionMarker,
  ToolResultPreview,
} from "../types.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { isSubagentToolName } from "../types.js";
import {
  isUserBoundaryEntry,
  type FeedEntry,
  type SubagentBatch,
  type SubagentGroup,
  type ToolMsgGroup,
  type Turn,
} from "../hooks/use-feed-model.js";
import { CodexThinkingInline, HerdEventMessage, MessageBubble } from "./MessageBubble.js";
import { EVENT_HEADER_RE, HERD_CHIP_BASE, HERD_CHIP_INTERACTIVE } from "../utils/herd-event-parser.js";
import { ToolBlock, getToolIcon, getToolLabel, ToolIcon, type ToolResultScope } from "./ToolBlock.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";
import { CollapseFooter, TurnToggleFooter } from "./CollapseFooter.js";
import { AssistantQuestQuizContent, extractQuestQuizMarkerIds } from "./AssistantQuestQuizContent.js";
import { LiveCodexTerminalStub, LiveDurationBadge } from "./MessageFeedLiveActivity.js";
import {
  appendTimedMessagesFromEntries,
  buildMinuteBoundaryLabelMap,
  getApprovalBatchFeedBlockId,
  getFooterFeedBlockId,
  getMessageFeedBlockId,
  getSubagentFeedBlockId,
  getToolGroupFeedBlockId,
  getTurnFeedBlockId,
  isTimedChatMessage,
} from "./message-feed-utils.js";
import { findPreviousSectionStartIndex, type FeedSection } from "./message-feed-sections.js";
import { YarnBallDot, YarnBallSpinner } from "./CatIcons.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import {
  formatThreadAttachmentMarkerDetail,
  isAllThreadsKey,
  isCrossThreadActivityMarkerMessage,
  isThreadAttachmentMarkerMessage,
  isThreadTransitionMarkerMessage,
} from "../utils/thread-projection.js";
import { useFeedDisplayNotifications } from "./FeedNotificationContext.js";
import { AttentionLedgerRow } from "./AttentionLedgerRow.js";
import { isAttentionLedgerMessage } from "../utils/attention-records.js";
import { collectAnchoredNotificationMessageIds } from "../utils/anchored-notifications.js";
import { getAssistantVisibleMarkdown, isAssistantMessageRenderable } from "../utils/assistant-message-renderability.js";
import { DelegateTrace, extractDelegateId, useDelegateCommandTrace } from "./DelegateCommandTrace.js";
import { parseSubagentResultText, SubagentResult } from "./SubagentResult.js";
import { isCompactToolActivityItem } from "./CompactToolActivity.js";
import { ToolMessageGroup } from "./ToolMessageGroup.js";
import { CompactFeedActivity, type CompactFeedActivitySegment } from "./CompactFeedActivity.js";
import { isCompactableHerdEventMessage } from "../utils/herd-event-classification.js";
import { canGroupCodexReasoningDetails, isCodexReasoningDetailMessage } from "../utils/codex-reasoning-detail.js";
import { CodexReasoningDetailGroup } from "./CodexReasoningDetail.js";
import { collectTimerMessageBatch, TimerMessageGroup } from "./TimerMessage.js";
import { MinuteBoundaryTimestamp } from "./MinuteBoundaryTimestamp.js";
import { SubagentSectionHeader } from "./SubagentSectionHeader.js";
import {
  readyThreadResponseAppliesToTurn,
  threadResponsePresentationTouchesTurn,
  type ThreadResponsePresentation,
} from "./thread-response-presentation.js";
import { ReadyThreadResponseRows, readyThreadResponseTurnHasContent } from "./ReadyThreadResponseRows.js";
import { ExpandedCurrentThreadResponse } from "./ThreadResponsePresentationChrome.js";
import { getTurnSummaryDurationMs } from "./message-feed-turn-duration.js";
import { InlineMessageTimingVisibilityContext } from "./MessageTimestamp.js";
import { TurnThreadStatusFooter } from "./MessageFeedThreadStatus.js";

function useExpandForScrollTarget(
  sessionId: string,
  containedMessageIds: string[],
  setOpen: (v: boolean) => void,
): void {
  const expandTargetId = useStore((s) => s.expandAllInTurn.get(sessionId));
  useEffect(() => {
    if (expandTargetId && containedMessageIds.includes(expandTargetId)) {
      setOpen(true);
    }
  }, [expandTargetId, containedMessageIds, setOpen]);
}

function isApprovalEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "system" && entry.msg.variant === "approved";
}

function getErrorMessageIdentity(entry: FeedEntry): string | null {
  if (entry.kind !== "message") return null;
  if (entry.msg.role !== "system" || entry.msg.variant !== "error") return null;
  const normalized = entry.msg.content.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

function isInvisibleFeedEntry(
  entry: FeedEntry,
  suppressThreadSystemMarkers: boolean,
  assistantIsRenderable: (message: ChatMessage) => boolean,
): boolean {
  if (entry.kind !== "message") return false;
  if (suppressThreadSystemMarkers && isThreadSystemMarkerMessage(entry.msg)) return true;
  return !assistantIsRenderable(entry.msg);
}

function GroupedErrorMessages({
  messages,
  sessionId,
  currentThreadKey,
  onSelectThread,
  interactionMode,
  toolResultOverrides,
  toolResultScope,
  questLinkSurface,
}: {
  messages: ChatMessage[];
  sessionId: string;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  interactionMode?: "default" | "read-only";
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope?: ToolResultScope;
  questLinkSurface: QuestLinkSurface;
}) {
  const first = messages[0];
  if (!first) return null;
  const countText = `Same error happened ${messages.length} times`;

  return (
    <div
      data-testid="grouped-error-message"
      data-message-id={first.id}
      data-message-role={first.role}
      data-message-variant={first.variant}
      data-feed-block-id={getMessageFeedBlockId(first.id)}
      aria-label={`${countText}: ${first.content}`}
      className="space-y-1.5"
    >
      <MessageBubble
        message={first}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        interactionMode={interactionMode}
        toolResultOverrides={toolResultOverrides}
        toolResultScope={toolResultScope}
        questLinkSurface={questLinkSurface}
      />
      <div className="flex justify-start pl-8 sm:pl-9">
        <span className="inline-flex max-w-full items-center rounded-full border border-cc-error/20 bg-cc-error/8 px-2 py-0.5 text-[11px] font-medium text-cc-error">
          {countText}
        </span>
      </div>
      {messages.slice(1).map((message) => (
        <span
          key={message.id}
          data-message-id={message.id}
          data-message-role={message.role}
          data-message-variant={message.variant}
          data-feed-block-id={getMessageFeedBlockId(message.id)}
          aria-hidden="true"
          className="sr-only"
        />
      ))}
    </div>
  );
}

function ApprovalBatchGroup({ messages, sessionId }: { messages: ChatMessage[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  useExpandForScrollTarget(sessionId, messageIds, setExpanded);
  return (
    <div
      className="flex justify-end animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={getApprovalBatchFeedBlockId(messages[0]?.id ?? `count:${count}`)}
    >
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
          {expanded ? (
            <div className="space-y-0.5">
              {messages.map((msg) => (
                <div key={msg.id} className="line-clamp-1">
                  {msg.content}
                </div>
              ))}
            </div>
          ) : (
            <span>
              {count} tool{count !== 1 ? "s" : ""} auto-approved
            </span>
          )}
        </div>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-green-400/40 shrink-0 mt-0.5 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
    </div>
  );
}

function getHerdBatchFeedBlockId(messageId: string): string {
  return `herd-batch:${messageId}`;
}

function isHerdEventEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId === "herd-events";
}

function isCompactableHerdEventEntry(entry: FeedEntry): entry is { kind: "message"; msg: ChatMessage } {
  return isHerdEventEntry(entry) && isCompactableHerdEventMessage(entry.msg);
}

function isThreadSystemMarkerMessage(message: ChatMessage): boolean {
  return (
    isThreadAttachmentMarkerMessage(message) ||
    isThreadTransitionMarkerMessage(message) ||
    isCrossThreadActivityMarkerMessage(message)
  );
}

function entryHasModelActivity(entry: FeedEntry): boolean {
  if (entry.kind !== "message") return true;
  return entry.msg.role === "assistant";
}

function turnPresentationEntries(turn: Turn): FeedEntry[] {
  return turn.presentationEntries ?? turn.allEntries;
}

function turnHasModelActivity(turn: Turn): boolean {
  return turnPresentationEntries(turn).some(entryHasModelActivity);
}

function latestStatusHostTurnId(sections: FeedSection[]): string | null {
  let latestTurnId: string | null = null;
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex--) {
    const turns = sections[sectionIndex].turns;
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
      const turn = turns[turnIndex];
      latestTurnId ??= turn.id;
      if (turnHasModelActivity(turn)) return turn.id;
    }
  }
  return latestTurnId;
}

function suppressRelocatedAnswersFromExpandedSourceTurns(
  presentation: ThreadResponsePresentation | null | undefined,
  expandedTurnIds: ReadonlySet<string>,
): ThreadResponsePresentation | null {
  if (!presentation) return null;
  const currentResponses = presentation.currentResponses.filter(
    (item) => item.anchorTurnId === item.sourceTurnId || !expandedTurnIds.has(item.sourceTurnId),
  );
  if (currentResponses.length === presentation.currentResponses.length) return presentation;
  return {
    ...presentation,
    currentResponses,
    currentResponseMessageIds: new Set(currentResponses.map((item) => item.response.currentMessageId)),
  };
}

function formatHerdBatchTimeRange(messages: ChatMessage[]): string {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  const firstLabel = fmt(first.timestamp);
  const lastLabel = fmt(last.timestamp);
  return firstLabel === lastLabel ? firstLabel : `${firstLabel} – ${lastLabel}`;
}

function HerdEventBatchGroup({ messages, sessionId }: { messages: ChatMessage[]; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;
  const timeRange = formatHerdBatchTimeRange(messages);
  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  useExpandForScrollTarget(sessionId, messageIds, setExpanded);

  const totalLines = messages.reduce((sum, msg) => {
    const lines = msg.content.split("\n").filter((line) => EVENT_HEADER_RE.test(line));
    return sum + lines.length;
  }, 0);
  const eventCount = totalLines || count;

  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={getHerdBatchFeedBlockId(messages[0]?.id ?? `count:${count}`)}
    >
      <div className="pl-9">
        <button onClick={() => setExpanded((v) => !v)} className={`${HERD_CHIP_BASE} ${HERD_CHIP_INTERACTIVE}`}>
          <span className="text-amber-500/50 shrink-0 text-[10px]">◇</span>
          <span>
            {eventCount} herd update{eventCount !== 1 ? "s" : ""} · {timeRange}
          </span>
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-2.5 h-2.5 text-cc-muted/40 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M6 3l5 5-5 5V3z" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 mt-1">
          {messages.map((msg) => (
            <HerdEventMessage key={msg.id} message={msg} showTimestamp={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadMarkerClusterRow({
  messages,
  onSelectThread,
}: {
  messages: ChatMessage[];
  onSelectThread?: (threadKey: string) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const moveSummary = summarizeThreadAttachmentMarkers(messages);
  const transitionSummary = summarizeThreadTransitionMarkers(messages);
  const activitySummary = summarizeCrossThreadActivityMarkers(messages);
  if (!moveSummary && !transitionSummary && !activitySummary) return null;
  const firstMessage = messages[0];
  const firstThreadKey =
    moveSummary?.destinations[0]?.threadKey ??
    transitionSummary?.destinations[0]?.threadKey ??
    activitySummary?.destinations[0]?.threadKey;
  const details = buildThreadMarkerClusterDetails(messages);
  const showDetails = details.length > 0 && (messages.length > 1 || !!moveSummary || !!transitionSummary);
  const testId =
    [moveSummary, transitionSummary, activitySummary].filter(Boolean).length > 1
      ? "thread-system-marker-cluster"
      : moveSummary
        ? "thread-attachment-marker"
        : transitionSummary
          ? "thread-transition-marker"
          : "cross-thread-activity-marker";

  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out] pl-9"
      data-testid={testId}
      data-thread-key={firstThreadKey}
      data-message-id={firstMessage?.id}
      data-feed-block-id={getMessageFeedBlockId(firstMessage?.id ?? "thread-marker-cluster")}
    >
      <div className="max-w-full space-y-0.5 text-[11px] text-cc-muted font-mono-code">
        {moveSummary && (
          <div>
            <MoveSummaryLine summary={moveSummary} onSelectThread={onSelectThread} />
            {showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {transitionSummary && (
          <div>
            <TransitionSummaryLine summary={transitionSummary} onSelectThread={onSelectThread} />
            {!moveSummary && showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {activitySummary && (
          <div>
            <ActivitySummaryLine summary={activitySummary} onSelectThread={onSelectThread} />
            {!moveSummary && !transitionSummary && showDetails && (
              <>
                <span className="mx-1.5 text-cc-muted/35">·</span>
                <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen((v) => !v)} />
              </>
            )}
          </div>
        )}
        {detailsOpen && showDetails && (
          <div className="mt-1 max-w-3xl space-y-0.5 text-cc-muted/70" data-testid="thread-marker-cluster-details">
            {details.map((detail, index) => (
              <div key={`${detail}-${index}`}>{detail}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-cc-primary hover:text-cc-primary/80 underline-offset-2 hover:underline"
      aria-expanded={open}
    >
      Details
    </button>
  );
}

type ThreadMarkerDestinationSummary = {
  threadKey: string;
  label: string;
  count: number;
};

function MoveSummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { count: number; destinations: ThreadMarkerDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  const grouped = summary.destinations.length > 1;
  const countLabel = `${summary.count} ${summary.count === 1 ? "message" : "messages"} moved to `;
  return (
    <>
      {!grouped && <span>{countLabel}</span>}
      {summary.destinations.map((destination, index) => (
        <span key={destination.threadKey}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          {grouped && (
            <span>
              {destination.count}{" "}
              {index === 0 ? `${destination.count === 1 ? "message" : "messages"} moved to ` : "to "}
            </span>
          )}
          <ThreadMarkerDestinationButton destination={destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function ActivitySummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { count: number; destinations: ThreadMarkerDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  const countLabel = `${summary.count} ${summary.count === 1 ? "activity" : "activities"} in `;
  return (
    <>
      <span>{countLabel}</span>
      {summary.destinations.map((destination, index) => (
        <span key={destination.threadKey}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          <ThreadMarkerDestinationButton destination={destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function TransitionSummaryLine({
  summary,
  onSelectThread,
}: {
  summary: { transitions: ThreadTransitionDestinationSummary[] };
  onSelectThread?: (threadKey: string) => void;
}) {
  return (
    <>
      {summary.transitions.map((transition, index) => (
        <span key={transition.markerId}>
          {index > 0 && <span className="text-cc-muted">, </span>}
          <span>Work continued from </span>
          <ThreadMarkerDestinationButton destination={transition.source} onSelectThread={onSelectThread} />
          <span> to </span>
          <ThreadMarkerDestinationButton destination={transition.destination} onSelectThread={onSelectThread} />
        </span>
      ))}
    </>
  );
}

function ThreadMarkerDestinationButton({
  destination,
  onSelectThread,
}: {
  destination: ThreadMarkerDestinationSummary;
  onSelectThread?: (threadKey: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectThread?.(destination.threadKey)}
      className="text-cc-primary hover:text-cc-primary/80 underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline disabled:text-cc-muted/60"
      disabled={!onSelectThread}
      title={`Open ${destination.label}`}
    >
      {destination.label}
    </button>
  );
}

function summarizeCrossThreadActivityMarkers(messages: ChatMessage[]): {
  count: number;
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const destinations = new Map<string, ThreadMarkerDestinationSummary>();
  let count = 0;
  for (const message of messages) {
    const marker = message.metadata?.crossThreadActivityMarker;
    if (!marker) continue;
    count += marker.count;
    const destination = marker.questId ?? marker.threadKey;
    const existing = destinations.get(marker.threadKey);
    if (existing) {
      existing.count += marker.count;
    } else {
      destinations.set(marker.threadKey, {
        threadKey: marker.threadKey,
        label: `thread:${destination}`,
        count: marker.count,
      });
    }
  }
  if (count === 0 || destinations.size === 0) return null;
  return { count, destinations: [...destinations.values()] };
}

function summarizeThreadAttachmentMarkers(messages: ChatMessage[]): {
  count: number;
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const destinations = new Map<string, ThreadMarkerDestinationSummary>();
  let count = 0;
  for (const message of messages) {
    const marker = message.metadata?.threadAttachmentMarker;
    if (!marker) continue;
    count += marker.count;
    const destination = marker.questId ?? marker.threadKey;
    const existing = destinations.get(marker.threadKey);
    if (existing) {
      existing.count += marker.count;
    } else {
      destinations.set(marker.threadKey, {
        threadKey: marker.threadKey,
        label: `thread:${destination}`,
        count: marker.count,
      });
    }
  }
  if (count === 0 || destinations.size === 0) return null;
  return { count, destinations: [...destinations.values()] };
}

type ThreadTransitionDestinationSummary = {
  markerId: string;
  source: ThreadMarkerDestinationSummary;
  destination: ThreadMarkerDestinationSummary;
};

function summarizeThreadTransitionMarkers(messages: ChatMessage[]): {
  transitions: ThreadTransitionDestinationSummary[];
  destinations: ThreadMarkerDestinationSummary[];
} | null {
  const transitions: ThreadTransitionDestinationSummary[] = [];
  for (const message of messages) {
    const marker = message.metadata?.threadTransitionMarker;
    if (!marker) continue;
    const source = marker.sourceQuestId ?? marker.sourceThreadKey;
    const destination = marker.questId ?? marker.threadKey;
    transitions.push({
      markerId: marker.id,
      source: {
        threadKey: marker.sourceThreadKey,
        label: formatThreadLabel(source),
        count: 1,
      },
      destination: {
        threadKey: marker.threadKey,
        label: formatThreadLabel(destination),
        count: 1,
      },
    });
  }
  if (transitions.length === 0) return null;
  return { transitions, destinations: transitions.map((transition) => transition.destination) };
}

function buildThreadMarkerClusterDetails(messages: ChatMessage[]): string[] {
  const details: string[] = [];
  for (const message of messages) {
    const attachment = message.metadata?.threadAttachmentMarker;
    if (attachment) {
      details.push(formatThreadAttachmentDetail(attachment));
      continue;
    }
    const transition = message.metadata?.threadTransitionMarker;
    if (transition) {
      // Thread transition markers currently have no detail fields beyond the
      // summary itself. Omitting them here prevents a Details toggle whose body
      // only repeats "Work continued from ... to ...", while preserving detail
      // rows for attachment/activity markers that carry distinct audit data.
      continue;
    }
    const activity = message.metadata?.crossThreadActivityMarker;
    if (activity) {
      const destination = activity.questId ?? activity.threadKey;
      const countLabel = `${activity.count} ${activity.count === 1 ? "activity" : "activities"}`;
      details.push(activity.summary ?? `${countLabel} in thread:${destination}`);
    }
  }
  return details;
}

function formatThreadAttachmentDetail(marker: ThreadAttachmentMarker): string {
  return formatThreadAttachmentMarkerDetail(marker);
}

function formatThreadLabel(threadKey: string): string {
  return threadKey === "main" ? "Main" : `thread:${threadKey}`;
}

export const FeedEntries = memo(function FeedEntries({
  entries,
  sessionId,
  currentThreadKey,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  suppressThreadSystemMarkers = false,
  interactionMode = "default",
  toolResultOverrides,
  toolResultScope = "session",
  questLinkSurface = "legacy",
  threadResponsePresentation,
}: {
  entries: FeedEntry[];
  sessionId: string;
  currentThreadKey?: string;
  minuteBoundaryLabels?: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  suppressThreadSystemMarkers?: boolean;
  interactionMode?: "default" | "read-only";
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope?: ToolResultScope;
  questLinkSurface?: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
}) {
  const compactToolActivity = useStore((state) => state.compactToolActivity);
  const inboxNotifications = useStore((state) => state.sessionNotifications?.get(sessionId));
  const notifications = useFeedDisplayNotifications(sessionId, inboxNotifications);
  const sideChats = useStore((state) => state.sessions.get(sessionId)?.slackThreads);
  const anchoredNotificationMessageIds = useMemo(
    () => new Set(collectAnchoredNotificationMessageIds(notifications)),
    [notifications],
  );
  const visibleAssistantChildMessageIds = useMemo(
    () => new Set(Object.values(sideChats ?? {}).map((sideChat) => sideChat.anchorMessageId)),
    [sideChats],
  );
  const rendered = useMemo(() => {
    const assistantIsRenderable = (message: ChatMessage) =>
      isAssistantMessageRenderable(message, {
        isCodexSession,
        hasAnchoredNotification: anchoredNotificationMessageIds.has(message.id),
        hasVisibleSideChat: visibleAssistantChildMessageIds.has(message.id),
      });
    const result: React.ReactNode[] = [];
    let i = 0;
    // Keep every branch in this manual renderer loop advancing `i`, assigning
    // `i` to a larger cursor, or returning. A skipped row must not spin render.
    while (i < entries.length) {
      const entry = entries[i];
      if (entry.kind === "message" && !assistantIsRenderable(entry.msg)) {
        i++;
        continue;
      }
      const timerBatch = collectTimerMessageBatch(entries, i, {
        isInvisible: (candidate) => isInvisibleFeedEntry(candidate, suppressThreadSystemMarkers, assistantIsRenderable),
        isDateBoundary: (message) => minuteBoundaryLabels?.has(message.id) === true,
      });
      if (timerBatch) {
        result.push(
          <TimerMessageGroup
            key={`timer-group:${timerBatch.messages[0]?.id ?? i}`}
            messages={timerBatch.messages}
            sessionId={sessionId}
            dateLabel={minuteBoundaryLabels?.get(timerBatch.messages[0]?.id ?? "")}
            questLinkSurface={questLinkSurface}
          />,
        );
        i = timerBatch.nextIndex;
        continue;
      }
      if (
        compactToolActivity &&
        ((entry.kind === "tool_msg_group" && entry.items.every(isCompactToolActivityItem)) ||
          isCompactableHerdEventEntry(entry))
      ) {
        const segments: CompactFeedActivitySegment[] = [];
        let j = i + 1;
        let pendingToolGroups: ToolMsgGroup[] = [];
        let pendingHerdMessages: ChatMessage[] = [];
        const flushToolGroups = () => {
          if (pendingToolGroups.length > 0) segments.push({ kind: "tool", groups: pendingToolGroups });
          pendingToolGroups = [];
        };
        const flushHerdMessages = () => {
          if (pendingHerdMessages.length > 0) segments.push({ kind: "worker_event", messages: pendingHerdMessages });
          pendingHerdMessages = [];
        };
        if (entry.kind === "tool_msg_group") pendingToolGroups.push(entry);
        else pendingHerdMessages.push(entry.msg);
        while (j < entries.length) {
          const candidate = entries[j];
          if (candidate.kind === "tool_msg_group" && candidate.items.every(isCompactToolActivityItem)) {
            flushHerdMessages();
            pendingToolGroups.push(candidate);
            j++;
            continue;
          }
          if (isCompactableHerdEventEntry(candidate)) {
            flushToolGroups();
            pendingHerdMessages.push(candidate.msg);
            j++;
            continue;
          }
          if (isInvisibleFeedEntry(candidate, suppressThreadSystemMarkers, assistantIsRenderable)) {
            j++;
            continue;
          }
          break;
        }
        flushToolGroups();
        flushHerdMessages();
        result.push(
          <CompactFeedActivity
            key={`compact-activity:${entry.kind === "tool_msg_group" ? entry.firstId : entry.msg.id}`}
            segments={segments}
            sessionId={sessionId}
            isCodexSession={isCodexSession}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            interactionMode={interactionMode}
            toolResultOverrides={toolResultOverrides}
            toolResultScope={toolResultScope}
            questLinkSurface={questLinkSurface}
          />,
        );
        i = j;
        continue;
      }
      if (entry.kind === "message" && isCodexReasoningDetailMessage(entry.msg)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length) {
          const candidate = entries[j];
          if (candidate.kind !== "message") break;
          if (minuteBoundaryLabels?.has(candidate.msg.id)) break;
          if (!canGroupCodexReasoningDetails(batch[batch.length - 1], candidate.msg)) break;
          batch.push(candidate.msg);
          j++;
        }
        if (batch.length >= 2) {
          const markerLabel = minuteBoundaryLabels?.get(entry.msg.id);
          result.push(
            <div key={`reasoning-group:${entry.msg.id}`}>
              {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
              <CodexReasoningDetailGroup messages={batch} sessionId={sessionId} questLinkSurface={questLinkSurface} />
            </div>,
          );
          i = j;
          continue;
        }
      }
      if (isApprovalEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isApprovalEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<ApprovalBatchGroup key={batch[0].id} messages={batch} sessionId={sessionId} />);
          i = j;
          continue;
        }
      }
      if (isCompactableHerdEventEntry(entry)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length && isCompactableHerdEventEntry(entries[j])) {
          batch.push((entries[j] as { kind: "message"; msg: ChatMessage }).msg);
          j++;
        }
        if (batch.length >= 2) {
          result.push(<HerdEventBatchGroup key={`herd-batch:${batch[0].id}`} messages={batch} sessionId={sessionId} />);
          i = j;
          continue;
        }
      }
      if (entry.kind === "message" && isThreadSystemMarkerMessage(entry.msg)) {
        const batch: ChatMessage[] = [entry.msg];
        let j = i + 1;
        while (j < entries.length) {
          const next = entries[j];
          if (next.kind !== "message" || !isThreadSystemMarkerMessage(next.msg)) break;
          batch.push(next.msg);
          j++;
        }
        if (!suppressThreadSystemMarkers) {
          result.push(<ThreadMarkerClusterRow key={entry.msg.id} messages={batch} onSelectThread={onSelectThread} />);
        }
        i = j;
        continue;
      }
      const errorIdentity = getErrorMessageIdentity(entry);
      if (errorIdentity !== null) {
        const batch: ChatMessage[] = [(entry as { kind: "message"; msg: ChatMessage }).msg];
        let j = i + 1;
        while (j < entries.length) {
          const next = entries[j];
          if (getErrorMessageIdentity(next) === errorIdentity) {
            batch.push((next as { kind: "message"; msg: ChatMessage }).msg);
            j++;
            continue;
          }
          if (isInvisibleFeedEntry(next, suppressThreadSystemMarkers, assistantIsRenderable)) {
            j++;
            continue;
          }
          break;
        }
        if (batch.length >= 2) {
          result.push(
            <GroupedErrorMessages
              key={`error-batch:${batch[0].id}`}
              messages={batch}
              sessionId={sessionId}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
              interactionMode={interactionMode}
              toolResultOverrides={toolResultOverrides}
              toolResultScope={toolResultScope}
              questLinkSurface={questLinkSurface}
            />,
          );
          i = j;
          continue;
        }
      }
      if (entry.kind === "message" && isAttentionLedgerMessage(entry.msg)) {
        const record = entry.msg.metadata?.attentionRecord;
        if (record) {
          result.push(
            <div
              key={entry.msg.id}
              data-message-id={entry.msg.id}
              data-message-role={entry.msg.role}
              data-message-variant={entry.msg.variant}
              data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
            >
              <AttentionLedgerRow
                record={record}
                sessionId={sessionId}
                currentThreadKey={currentThreadKey}
                onSelectThread={onSelectThread}
              />
            </div>,
          );
          i++;
          continue;
        }
      }
      const ownedToolResults =
        entry.kind === "message" && entry.msg.metadata?.codexSubagentToolResults
          ? new Map(Object.entries(entry.msg.metadata.codexSubagentToolResults))
          : undefined;
      const entryToolResults = ownedToolResults ?? toolResultOverrides;
      const entryToolResultScope =
        entry.kind === "message" && entry.msg.metadata?.codexSubagent ? "overrides-only" : toolResultScope;
      if (entry.kind === "tool_msg_group") {
        result.push(
          <ToolMessageGroup
            key={entry.firstId || i}
            group={entry}
            sessionId={sessionId}
            isCodexSession={isCodexSession}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            interactionMode={interactionMode}
            toolResultOverrides={toolResultOverrides}
            toolResultScope={toolResultScope}
            questLinkSurface={questLinkSurface}
          />,
        );
      } else if (entry.kind === "subagent") {
        result.push(
          <SubagentContainer
            key={entry.taskToolUseId}
            group={entry}
            sessionId={sessionId}
            minuteBoundaryLabels={minuteBoundaryLabels}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            interactionMode={interactionMode}
            toolResultOverrides={toolResultOverrides}
            toolResultScope={toolResultScope}
            questLinkSurface={questLinkSurface}
          />,
        );
      } else if (entry.kind === "subagent_batch") {
        result.push(
          <SubagentBatchContainer
            key={entry.subagents[0]?.taskToolUseId || i}
            batch={entry}
            sessionId={sessionId}
            minuteBoundaryLabels={minuteBoundaryLabels}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            interactionMode={interactionMode}
            toolResultOverrides={toolResultOverrides}
            toolResultScope={toolResultScope}
            questLinkSurface={questLinkSurface}
          />,
        );
      } else {
        const isTimed = isTimedChatMessage(entry.msg);
        const markerLabel = isTimed ? minuteBoundaryLabels?.get(entry.msg.id) : undefined;
        const currentResponse = threadResponsePresentation?.currentResponses.find(
          (item) => item.response.coveredUserMessageIds.length > 0 && item.response.currentMessageId === entry.msg.id,
        );
        const bubble = (
          <MessageBubble
            message={entry.msg}
            sessionId={sessionId}
            showTimestamp={isTimed && entry.msg.role === "assistant" && typeof entry.msg.turnDurationMs === "number"}
            currentThreadKey={currentThreadKey}
            onSelectThread={onSelectThread}
            interactionMode={interactionMode}
            backendType={isCodexSession ? "codex" : undefined}
            toolResultOverrides={entryToolResults}
            toolResultScope={entryToolResultScope}
            questLinkSurface={questLinkSurface}
          />
        );
        result.push(
          <div
            key={entry.msg.id}
            data-message-id={entry.msg.id}
            data-message-role={entry.msg.role}
            data-message-variant={entry.msg.variant}
            data-feed-block-id={getMessageFeedBlockId(entry.msg.id)}
          >
            {markerLabel && <MinuteBoundaryTimestamp timestamp={entry.msg.timestamp} label={markerLabel} />}
            {currentResponse ? (
              <ExpandedCurrentThreadResponse
                messageCount={currentResponse.response.answerUserMessageIds.length}
                referencedMessages={currentResponse.referencedUserMessages}
              >
                <HidePawContext.Provider value={true}>{bubble}</HidePawContext.Provider>
              </ExpandedCurrentThreadResponse>
            ) : (
              bubble
            )}
          </div>,
        );
      }
      i++;
    }
    return result;
  }, [
    activeCodexTerminalIds,
    anchoredNotificationMessageIds,
    compactToolActivity,
    entries,
    isCodexSession,
    currentThreadKey,
    minuteBoundaryLabels,
    onOpenCodexTerminal,
    onSelectThread,
    interactionMode,
    questLinkSurface,
    sessionId,
    suppressThreadSystemMarkers,
    threadResponsePresentation,
    toolResultOverrides,
    toolResultScope,
    visibleAssistantChildMessageIds,
  ]);

  return <>{rendered}</>;
});

function CollapsedTurnRows({
  turn,
  sessionId,
  currentThreadKey,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  questLinkSurface,
  threadResponsePresentation,
  activeNeedsInputAnchorMessageIds,
  preserveHostQuestQuiz,
}: {
  turn: Turn;
  sessionId: string;
  currentThreadKey: string;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  questLinkSurface: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
  activeNeedsInputAnchorMessageIds: ReadonlySet<string>;
  preserveHostQuestQuiz: boolean;
}) {
  const collapsedEntries = turn.collapsedEntries ?? [];
  if (threadResponsePresentation) {
    return (
      <ReadyThreadResponseRows
        turn={turn}
        presentation={threadResponsePresentation}
        sessionId={sessionId}
        questLinkSurface={questLinkSurface}
        activeNeedsInputAnchorMessageIds={activeNeedsInputAnchorMessageIds}
        renderEntry={(entry) => (
          <FeedEntries
            entries={[entry]}
            sessionId={sessionId}
            currentThreadKey={currentThreadKey}
            minuteBoundaryLabels={minuteBoundaryLabels}
            isCodexSession={isCodexSession}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            onSelectThread={onSelectThread}
            suppressThreadSystemMarkers
            questLinkSurface={questLinkSurface}
          />
        )}
      />
    );
  }
  // The fallback Ready path has no response presentation to carry a separate Quiz row.
  // Rebuild only directives already owned by this turn, and skip any representative that renders one itself.
  const hiddenHostQuizIds = preserveHostQuestQuiz
    ? (() => {
        const visibleQuizIds = new Set(
          collapsedEntries.flatMap((row) =>
            row.kind === "entry" && row.entry.kind === "message"
              ? extractQuestQuizMarkerIds(getAssistantVisibleMarkdown(row.entry.msg))
              : [],
          ),
        );
        return [
          ...new Set(
            turnPresentationEntries(turn).flatMap((entry) =>
              entry.kind === "message" && entry.msg.role === "assistant"
                ? extractQuestQuizMarkerIds(getAssistantVisibleMarkdown(entry.msg))
                : [],
            ),
          ),
        ].filter((questId) => !visibleQuizIds.has(questId));
      })()
    : [];
  return (
    <>
      {collapsedEntries.map((row) => {
        if (row.kind === "activity") return null;

        return (
          <div key={row.key} className="px-2.5 py-2 sm:px-3">
            <HidePawContext.Provider value={true}>
              {isCompactableHerdEventEntry(row.entry) ? (
                <CompactFeedActivity
                  segments={[{ kind: "worker_event", messages: [row.entry.msg] }]}
                  sessionId={sessionId}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={onOpenCodexTerminal}
                  questLinkSurface={questLinkSurface}
                />
              ) : (
                <FeedEntries
                  entries={[row.entry]}
                  sessionId={sessionId}
                  currentThreadKey={currentThreadKey}
                  minuteBoundaryLabels={minuteBoundaryLabels}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={onOpenCodexTerminal}
                  onSelectThread={onSelectThread}
                  suppressThreadSystemMarkers
                  questLinkSurface={questLinkSurface}
                />
              )}
            </HidePawContext.Provider>
          </div>
        );
      })}
      {hiddenHostQuizIds.length > 0 && (
        <div className="min-w-0 px-2.5 pb-2 sm:px-3" data-testid="thread-response-quiz">
          <AssistantQuestQuizContent
            text={hiddenHostQuizIds.map((questId) => `{[(Quest Quiz: ${questId})]}`).join("\n")}
            sessionId={sessionId}
            questLinkSurface={questLinkSurface}
          />
        </div>
      )}
    </>
  );
}

export const TurnEntriesExpanded = memo(function TurnEntriesExpanded({
  turn,
  sessionId,
  currentThreadKey,
  durationMs,
  threadStatusFooter,
  onCollapse,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  questLinkSurface,
  threadResponsePresentation,
}: {
  turn: Turn;
  sessionId: string;
  currentThreadKey: string;
  durationMs: number | null;
  threadStatusFooter?: ReactNode;
  onCollapse: () => void;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  questLinkSurface: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
}) {
  const headerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      {turn.agentEntries.length > 0 && (
        <TurnCollapseBar ref={headerRef} stats={turn.stats} durationMs={durationMs} onClick={onCollapse} />
      )}
      <FeedEntries
        entries={turnPresentationEntries(turn)}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        minuteBoundaryLabels={minuteBoundaryLabels}
        isCodexSession={isCodexSession}
        activeCodexTerminalIds={activeCodexTerminalIds}
        onOpenCodexTerminal={onOpenCodexTerminal}
        onSelectThread={onSelectThread}
        questLinkSurface={questLinkSurface}
        threadResponsePresentation={threadResponsePresentation}
      />
      {threadStatusFooter}
      <TurnToggleFooter expanded headerRef={headerRef} onToggle={onCollapse} />
    </>
  );
});

function getCommittedCodexStreamingText(raw: string): string {
  if (!raw) return "";
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline < 0) return "";
  return raw.slice(0, lastNewline + 1);
}

function SubagentBatchContainer({
  batch,
  sessionId,
  minuteBoundaryLabels,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  interactionMode = "default",
  toolResultOverrides,
  toolResultScope = "session",
  questLinkSurface = "legacy",
}: {
  batch: SubagentBatch;
  sessionId: string;
  minuteBoundaryLabels?: Map<string, string>;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  interactionMode?: "default" | "read-only";
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope?: ToolResultScope;
  questLinkSurface?: QuestLinkSurface;
}) {
  return (
    <div
      className="animate-[fadeSlideIn_0.2s_ease-out]"
      data-feed-block-id={`subagent-batch:${batch.subagents[0]?.taskToolUseId || "empty"}`}
    >
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0 space-y-2">
          {batch.subagents.map((sg) => (
            <SubagentContainer
              key={sg.taskToolUseId}
              group={sg}
              sessionId={sessionId}
              minuteBoundaryLabels={minuteBoundaryLabels}
              activeCodexTerminalIds={activeCodexTerminalIds}
              onOpenCodexTerminal={onOpenCodexTerminal}
              interactionMode={interactionMode}
              toolResultOverrides={toolResultOverrides}
              toolResultScope={toolResultScope}
              questLinkSurface={questLinkSurface}
              inBatch
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SubagentContainer({
  group,
  sessionId,
  inBatch,
  minuteBoundaryLabels,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  interactionMode = "default",
  toolResultOverrides,
  toolResultScope = "session",
  questLinkSurface = "legacy",
}: {
  group: SubagentGroup;
  sessionId: string;
  inBatch?: boolean;
  minuteBoundaryLabels?: Map<string, string>;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  interactionMode?: "default" | "read-only";
  toolResultOverrides?: ReadonlyMap<string, ToolResultPreview>;
  toolResultScope?: ToolResultScope;
  questLinkSurface?: QuestLinkSurface;
}) {
  const [open, setOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [bgOutput, setBgOutput] = useState<string | null>(null);
  const headerRef = useRef<HTMLButtonElement>(null);
  const label = group.description || "Subagent";
  const agentType = group.agentType;
  const isDelegateTask = agentType === "delegate_task";
  const isLegacyDelegateCommand = agentType === "delegate_command";
  const isDelegate = isDelegateTask || isLegacyDelegateCommand;
  const delegatePrompt =
    typeof group.taskInput?.task === "string"
      ? group.taskInput.task
      : typeof group.taskInput?.command === "string"
        ? group.taskInput.command
        : typeof group.taskInput?.prompt === "string"
          ? group.taskInput.prompt
          : "";
  const childCount = group.children.length;
  const hasPrompt = !!group.taskInput?.prompt;

  const childMessageIds = useMemo(
    () => group.children.filter((e) => e.kind === "message").map((e) => (e as { msg: ChatMessage }).msg.id),
    [group.children],
  );
  useExpandForScrollTarget(sessionId, childMessageIds, setOpen);

  const readOnly = interactionMode === "read-only";
  const isolateToolState = !!group.codexSubagent || toolResultScope === "overrides-only";
  const storedResultPreview = useStore((s) => s.toolResults.get(sessionId)?.get(group.taskToolUseId));
  const resultPreview =
    group.resultOverride ??
    toolResultOverrides?.get(group.taskToolUseId) ??
    (isolateToolState ? undefined : storedResultPreview);
  const storedStreamingText = useStore(
    (s) => s.streamingByParentToolUseId.get(sessionId)?.get(group.taskToolUseId) || "",
  );
  const rawStreamingText = readOnly || isolateToolState ? "" : storedStreamingText;
  const storedThinkingText = useStore(
    (s) => s.streamingThinkingByParentToolUseId.get(sessionId)?.get(group.taskToolUseId) || "",
  );
  const rawThinkingText = readOnly || isolateToolState ? "" : storedThinkingText;
  const storedProgressElapsedSeconds = useStore(
    (s) => s.toolProgress.get(sessionId)?.get(group.taskToolUseId)?.elapsedSeconds,
  );
  const progressElapsedSeconds = isolateToolState ? undefined : storedProgressElapsedSeconds;
  const storedStartTimestamp = useStore((s) => s.toolStartTimestamps.get(sessionId)?.get(group.taskToolUseId));
  const startTimestamp = isolateToolState ? undefined : storedStartTimestamp;
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => (isCodexSession ? getCommittedCodexStreamingText(rawStreamingText) : rawStreamingText),
    [isCodexSession, rawStreamingText],
  );
  const storedBgNotif = useStore((s) => s.backgroundAgentNotifs.get(sessionId)?.get(group.taskToolUseId));
  const bgNotif = readOnly || isolateToolState ? undefined : storedBgNotif;
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isEffectivelyComplete = group.isBackground ? bgNotif != null : resultPreview != null || bgNotif != null;
  const isAbandoned = !isEffectivelyComplete && sessionStatus !== "running" && !group.isBackground;

  const lastEntry = [...group.children]
    .reverse()
    .find((entry) => entry.kind !== "message" || !isCodexReasoningDetailMessage(entry.msg));
  const lastPreview = useMemo(() => {
    if (!lastEntry) return "";
    if (lastEntry.kind === "tool_msg_group") {
      return `${getToolLabel(lastEntry.toolName)}${lastEntry.items.length > 1 ? ` ×${lastEntry.items.length}` : ""}`;
    }
    if (lastEntry.kind === "message" && lastEntry.msg.role === "assistant") {
      const text = lastEntry.msg.content?.trim();
      if (text) return text.length > 60 ? text.slice(0, 60) + "..." : text;
      const toolBlock = lastEntry.msg.contentBlocks?.find(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (toolBlock) return getToolLabel(toolBlock.name);
    }
    return "";
  }, [lastEntry]);

  const parsedResultPreview = useMemo(() => {
    if (!resultPreview?.content) return null;
    return parseSubagentResultText(resultPreview.content);
  }, [resultPreview]);
  const delegateId = useMemo(
    () => extractDelegateId(parsedResultPreview ?? resultPreview?.content),
    [parsedResultPreview, resultPreview?.content],
  );

  const collapsedPreview = useMemo(() => {
    if (isDelegate && delegatePrompt) return "";
    if (parsedResultPreview) {
      const text = parsedResultPreview.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    if (streamingText) {
      const text = streamingText.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    if (rawThinkingText && !isCodexSession) {
      const text = rawThinkingText.trim();
      return text.length > 120 ? text.slice(0, 120) + "..." : text;
    }
    return lastPreview;
  }, [delegatePrompt, isCodexSession, isDelegate, lastPreview, parsedResultPreview, rawThinkingText, streamingText]);

  const {
    trace: delegateTrace,
    error: delegateTraceError,
    count: delegateTraceCount,
  } = useDelegateCommandTrace({
    sessionId,
    isDelegate: isDelegate && !readOnly,
    delegatePrompt,
    isLegacyCommand: isLegacyDelegateCommand,
    delegateId,
    resultComplete: !!resultPreview,
  });

  const card = (
    <div
      className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card"
      data-feed-block-id={getSubagentFeedBlockId(group.taskToolUseId)}
    >
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
        <ToolIcon type={isLegacyDelegateCommand ? "terminal" : "agent"} />
        <span className="text-xs font-medium text-cc-fg truncate">{label}</span>
        {isDelegate && delegatePrompt && (
          <span
            className="min-w-0 flex-1 truncate rounded-md bg-cc-code-bg/70 px-2 py-1 font-mono-code text-[11px] text-cc-code-fg"
            title={delegatePrompt}
          >
            {delegatePrompt}
          </span>
        )}
        {agentType && !isDelegate && (
          <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">{agentType}</span>
        )}
        {!open && collapsedPreview && (
          <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">{collapsedPreview}</span>
        )}
        <LiveDurationBadge
          finalDurationSeconds={
            group.isBackground
              ? bgNotif
                ? resultPreview?.duration_seconds
                : undefined
              : resultPreview?.duration_seconds
          }
          progressElapsedSeconds={progressElapsedSeconds}
          startTimestamp={startTimestamp}
          isComplete={isEffectivelyComplete || isAbandoned}
        />
        <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
          {childCount + delegateTraceCount > 0
            ? childCount + delegateTraceCount
            : isEffectivelyComplete
              ? "✓"
              : isAbandoned
                ? "—"
                : group.isBackground
                  ? "bg"
                  : "0"}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border">
          {hasPrompt && (
            <div className="border-b border-cc-border/50">
              <SubagentSectionHeader label="Prompt" open={promptOpen} onToggle={() => setPromptOpen(!promptOpen)} />
              {promptOpen && (
                <div className="px-3 pb-2">
                  <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                    {String(group.taskInput!.prompt)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {(childCount > 0 ||
            delegateTraceCount > 0 ||
            rawStreamingText ||
            (rawThinkingText && !isCodexSession) ||
            delegateTraceError) && (
            <div className="border-b border-cc-border/50">
              <SubagentSectionHeader
                label="Activities"
                open={activitiesOpen}
                onToggle={() => setActivitiesOpen(!activitiesOpen)}
              />
              {activitiesOpen && (
                <div className="px-3 pb-2 space-y-3">
                  {childCount > 0 && (
                    <FeedEntries
                      entries={group.children}
                      sessionId={sessionId}
                      minuteBoundaryLabels={minuteBoundaryLabels}
                      isCodexSession={isCodexSession}
                      activeCodexTerminalIds={activeCodexTerminalIds}
                      onOpenCodexTerminal={onOpenCodexTerminal}
                      interactionMode={interactionMode}
                      toolResultOverrides={toolResultOverrides}
                      toolResultScope={group.codexSubagent ? "overrides-only" : toolResultScope}
                      questLinkSurface={questLinkSurface}
                    />
                  )}
                  {delegateTraceCount > 0 && (
                    <DelegateTrace trace={delegateTrace!} sessionId={sessionId} questLinkSurface={questLinkSurface} />
                  )}
                  {delegateTraceError && delegateTraceCount === 0 && (
                    <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2 text-[11px] text-cc-muted">
                      Delegate trace unavailable: {delegateTraceError}
                    </div>
                  )}
                  {rawThinkingText && !isCodexSession && (
                    <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2">
                      <CodexThinkingInline text={rawThinkingText} />
                    </div>
                  )}
                  {rawStreamingText && (
                    <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2">
                      {isCodexSession ? (
                        <div className="text-[13px] text-cc-fg">
                          <MarkdownContent
                            text={streamingText}
                            sessionId={sessionId}
                            questLinkSurface={questLinkSurface}
                          />
                          <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                        </div>
                      ) : (
                        <pre className="font-serif-assistant text-[14px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                          {streamingText}
                          <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {group.isBackground && childCount === 0 && bgNotif && (
            <div className="border-b border-cc-border/50">
              <div className="px-3 py-2">
                <div className="text-[11px] text-cc-muted">{bgNotif.summary}</div>
                {bgNotif.outputFile && !bgOutput && (
                  <button
                    onClick={async () => {
                      const resp = await fetch(
                        `/api/sessions/${sessionId}/agent-output?path=${encodeURIComponent(bgNotif.outputFile!)}`,
                      );
                      if (resp.ok) setBgOutput(await resp.text());
                    }}
                    className="text-[11px] text-cc-accent hover:underline mt-1 cursor-pointer"
                  >
                    View full output
                  </button>
                )}
                {bgOutput && (
                  <pre className="text-[11px] text-cc-text font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto mt-1 bg-cc-bg-code rounded p-2">
                    {bgOutput}
                  </pre>
                )}
              </div>
            </div>
          )}

          {childCount === 0 &&
            delegateTraceCount === 0 &&
            !rawStreamingText &&
            !(rawThinkingText && !isCodexSession) &&
            !isEffectivelyComplete &&
            !isAbandoned && (
              <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
                <YarnBallSpinner className="w-3.5 h-3.5" />
                <span>{group.isBackground ? "Running in background..." : "Agent starting..."}</span>
              </div>
            )}

          {childCount === 0 && isAbandoned && (
            <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
          )}

          {resultPreview && (
            <div className="border-t border-cc-border/50">
              <SubagentSectionHeader label="Result" open={resultOpen} onToggle={() => setResultOpen(!resultOpen)} />
              {resultOpen && (
                <SubagentResult
                  preview={resultPreview}
                  parsedText={parsedResultPreview}
                  sessionId={sessionId}
                  toolUseId={group.taskToolUseId}
                  questLinkSurface={questLinkSurface}
                  delegate={{
                    isDelegate,
                    isLegacyCommand: isLegacyDelegateCommand,
                    delegateId,
                    prompt: delegatePrompt,
                    trace: delegateTrace,
                  }}
                />
              )}
            </div>
          )}

          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );

  if (inBatch) return card;

  return (
    <div className="animate-[fadeSlideIn_0.2s_ease-out]">
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">{card}</div>
      </div>
    </div>
  );
}

export const FeedFooter = memo(function FeedFooter({
  sessionId,
  visibleToolUseIds,
  questLinkSurface = "legacy",
}: {
  sessionId: string;
  visibleToolUseIds?: Set<string>;
  questLinkSurface?: QuestLinkSurface;
}) {
  const toolProgress = useStore((s) => s.toolProgress.get(sessionId));
  const rawStreamingText = useStore((s) => s.streaming.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isCodexSession = useStore((s) => s.sessions.get(sessionId)?.backend_type === "codex");
  const streamingText = useMemo(
    () => (isCodexSession ? getCommittedCodexStreamingText(rawStreamingText || "") : rawStreamingText || ""),
    [isCodexSession, rawStreamingText],
  );

  return (
    <>
      {sessionStatus === "compacting" && !rawStreamingText && (
        <div
          className="flex items-center gap-2 text-[12px] text-cc-muted font-mono-code pl-9 py-1 animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-block-id={getFooterFeedBlockId("compacting")}
        >
          <YarnBallDot className="text-cc-primary animate-pulse" />
          <span>Compacting conversation...</span>
        </div>
      )}

      {toolProgress &&
        toolProgress.size > 0 &&
        !rawStreamingText &&
        !isCodexSession &&
        (() => {
          const nonTaskProgress = Array.from(toolProgress.entries())
            .filter(([toolUseId]) => !visibleToolUseIds || visibleToolUseIds.has(toolUseId))
            .map(([, progress]) => progress)
            .filter((p) => !isSubagentToolName(p.toolName));
          if (nonTaskProgress.length === 0) return null;
          return (
            <div
              className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9"
              data-feed-block-id={getFooterFeedBlockId("tool-progress")}
            >
              <YarnBallDot className="text-cc-primary animate-pulse" />
              {nonTaskProgress.map((p, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-cc-muted/40">·</span>}
                  <span>{getToolLabel(p.toolName)}</span>
                  <span className="text-cc-muted/60">{p.elapsedSeconds}s</span>
                </span>
              ))}
            </div>
          );
        })()}

      {rawStreamingText && (
        <div
          className="animate-[fadeSlideIn_0.2s_ease-out]"
          data-feed-streaming-message="true"
          data-feed-block-id={getFooterFeedBlockId("streaming")}
        >
          <div className="flex items-start gap-3">
            <PawTrailAvatar isStreaming />
            <div className="flex-1 min-w-0">
              {isCodexSession ? (
                <div>
                  <MarkdownContent text={streamingText} sessionId={sessionId} questLinkSurface={questLinkSurface} />
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </div>
              ) : (
                <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                  {streamingText}
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export const TurnEntries = memo(function TurnEntries({
  sections,
  sessionId,
  currentThreadKey,
  leaderMode,
  showInlineMessageTiming,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  turnStates,
  toggleTurn,
  userBoundarySourceSessionId,
  questLinkSurface,
  threadResponsePresentation,
  activeNeedsInputAnchorMessageIds,
  visibleThreadStatuses,
  onThreadStatusLayoutContributionChange,
}: {
  sections: FeedSection[];
  sessionId: string;
  currentThreadKey: string;
  leaderMode: boolean;
  showInlineMessageTiming: boolean;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  turnStates: Array<{ defaultExpanded: boolean; isActivityExpanded: boolean } | undefined>;
  toggleTurn: (turnId: string) => void;
  userBoundarySourceSessionId?: string | null;
  questLinkSurface: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
  activeNeedsInputAnchorMessageIds: ReadonlySet<string>;
  visibleThreadStatuses: LeaderThreadStatus[];
  onThreadStatusLayoutContributionChange?: (height: number) => void;
}) {
  const turns = useMemo(() => sections.flatMap((section) => section.turns), [sections]);
  const expandedTurnIds = useMemo(
    () => new Set(turns.flatMap((turn, index) => (turnStates[index]?.isActivityExpanded === true ? [turn.id] : []))),
    [turns, turnStates],
  );
  const collapsedAnswerPresentation = useMemo(
    () => suppressRelocatedAnswersFromExpandedSourceTurns(threadResponsePresentation, expandedTurnIds),
    [expandedTurnIds, threadResponsePresentation],
  );
  const latestThreadResponseUpdatedAt = Math.max(
    0,
    ...(threadResponsePresentation?.currentResponses
      .filter((item) => item.response.coveredUserMessageIds.length > 0)
      .map((item) => item.response.updatedAt) ?? []),
  );
  const readyThreadResponsePresentation =
    threadResponsePresentation?.ready &&
    visibleThreadStatuses.some((status) => status.kind === "ready" && status.timestamp >= latestThreadResponseUpdatedAt)
      ? threadResponsePresentation
      : null;
  const threadStatusFooterTurnId = useMemo(
    () => (visibleThreadStatuses.length > 0 ? latestStatusHostTurnId(sections) : null),
    [sections, visibleThreadStatuses.length],
  );
  const minuteBoundaryLabels = useMemo(() => {
    const visibleTimedMessages: ChatMessage[] = [];

    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      const isActivityExpanded = turnStates[index]?.isActivityExpanded ?? false;

      if (turn.userEntry?.kind === "message" && isTimedChatMessage(turn.userEntry.msg)) {
        visibleTimedMessages.push(turn.userEntry.msg);
      }

      if (isActivityExpanded) {
        appendTimedMessagesFromEntries(turnPresentationEntries(turn), visibleTimedMessages);
      } else if (
        !readyThreadResponsePresentation ||
        !readyThreadResponseAppliesToTurn(turn, readyThreadResponsePresentation)
      ) {
        appendTimedMessagesFromEntries(turn.systemEntries, visibleTimedMessages);
      }
    }

    return buildMinuteBoundaryLabelMap(visibleTimedMessages);
  }, [readyThreadResponsePresentation, turns, turnStates]);
  return (
    <InlineMessageTimingVisibilityContext.Provider value={showInlineMessageTiming}>
      {(() => {
        let globalIndex = 0;
        return sections.map((section) => (
          <div key={section.id} data-feed-section-id={section.id} className="space-y-3 sm:space-y-5">
            {section.turns.map((turn) => {
              const turnIndex = globalIndex++;
              const turnState = turnStates[turnIndex];
              const isActivityExpanded = turnState?.isActivityExpanded ?? false;
              const preserveHostQuestQuiz = turnIndex === turns.length - 1 && turnState?.defaultExpanded === false;
              const expandedThreadResponsePresentation =
                threadResponsePresentation && readyThreadResponseAppliesToTurn(turn, threadResponsePresentation)
                  ? threadResponsePresentation
                  : null;
              const currentAnswerBelongsToTurn =
                collapsedAnswerPresentation != null &&
                threadResponsePresentationTouchesTurn(turn, collapsedAnswerPresentation);
              const collapsedThreadResponsePresentation =
                readyThreadResponsePresentation &&
                collapsedAnswerPresentation &&
                readyThreadResponseAppliesToTurn(turn, readyThreadResponsePresentation)
                  ? collapsedAnswerPresentation
                  : collapsedAnswerPresentation &&
                      currentAnswerBelongsToTurn &&
                      readyThreadResponseAppliesToTurn(turn, collapsedAnswerPresentation)
                    ? collapsedAnswerPresentation
                    : null;
              const hasCollapsedContent = collapsedThreadResponsePresentation
                ? readyThreadResponseTurnHasContent(
                    turn,
                    collapsedThreadResponsePresentation,
                    activeNeedsInputAnchorMessageIds,
                  )
                : (turn.collapsedEntries?.some((row) => row.kind === "entry") ?? false) ||
                  turn.subConclusions.length > 0;
              const hasCollapsedCurrentAnswer =
                collapsedThreadResponsePresentation?.currentResponses.some((item) => item.anchorTurnId === turn.id) ??
                false;
              const turnSummaryDuration = getTurnSummaryDurationMs(turn, turns[turnIndex + 1] ?? null, leaderMode);
              const showThreadStatusFooter = turn.id === threadStatusFooterTurnId;
              const threadStatusFooter = showThreadStatusFooter ? (
                <TurnThreadStatusFooter
                  statuses={visibleThreadStatuses}
                  currentThreadKey={currentThreadKey}
                  onSelectThread={onSelectThread}
                  onLayoutContributionChange={onThreadStatusLayoutContributionChange}
                />
              ) : null;

              return (
                <div key={turn.id}>
                  <div
                    data-turn-id={turn.id}
                    data-feed-block-id={getTurnFeedBlockId(turn.id)}
                    className="turn-container space-y-2 sm:space-y-3"
                    data-user-turn={
                      isUserBoundaryEntry(turn.userEntry, userBoundarySourceSessionId) ? "true" : undefined
                    }
                  >
                    {turn.userEntry && (
                      <FeedEntries
                        entries={[turn.userEntry]}
                        sessionId={sessionId}
                        currentThreadKey={currentThreadKey}
                        minuteBoundaryLabels={minuteBoundaryLabels}
                        isCodexSession={isCodexSession}
                        activeCodexTerminalIds={activeCodexTerminalIds}
                        onOpenCodexTerminal={onOpenCodexTerminal}
                        onSelectThread={onSelectThread}
                        questLinkSurface={questLinkSurface}
                      />
                    )}

                    {!isActivityExpanded && !collapsedThreadResponsePresentation && (
                      <CodexSubagentTurnSegment sessionId={sessionId} turnId={turn.id} />
                    )}
                    {isActivityExpanded ? (
                      turnPresentationEntries(turn).length > 0 && (
                        <TurnEntriesExpanded
                          turn={turn}
                          sessionId={sessionId}
                          currentThreadKey={currentThreadKey}
                          durationMs={turnSummaryDuration}
                          threadStatusFooter={threadStatusFooter}
                          minuteBoundaryLabels={minuteBoundaryLabels}
                          isCodexSession={isCodexSession}
                          activeCodexTerminalIds={activeCodexTerminalIds}
                          onOpenCodexTerminal={onOpenCodexTerminal}
                          onSelectThread={onSelectThread}
                          onCollapse={() => toggleTurn(turn.id)}
                          questLinkSurface={questLinkSurface}
                          threadResponsePresentation={expandedThreadResponsePresentation}
                        />
                      )
                    ) : (
                      <>
                        {!collapsedThreadResponsePresentation && turn.systemEntries.length > 0 && (
                          <FeedEntries
                            entries={turn.systemEntries}
                            sessionId={sessionId}
                            currentThreadKey={currentThreadKey}
                            minuteBoundaryLabels={minuteBoundaryLabels}
                            isCodexSession={isCodexSession}
                            activeCodexTerminalIds={activeCodexTerminalIds}
                            onOpenCodexTerminal={onOpenCodexTerminal}
                            onSelectThread={onSelectThread}
                            suppressThreadSystemMarkers
                            questLinkSurface={questLinkSurface}
                          />
                        )}
                        {hasCollapsedContent && (
                          <div
                            className={
                              hasCollapsedCurrentAnswer
                                ? "flex min-w-0 items-start"
                                : "flex min-w-0 items-start gap-2 sm:gap-3"
                            }
                            data-testid={hasCollapsedCurrentAnswer ? "thread-response-collapsed-shell" : undefined}
                          >
                            {!hasCollapsedCurrentAnswer && <PawTrailAvatar />}
                            <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                              {!collapsedThreadResponsePresentation && turn.subConclusions.length > 0 && (
                                <div className="px-3 pt-2 space-y-1.5">
                                  <HidePawContext.Provider value={true}>
                                    {turn.subConclusions.map((sc, scIdx) => (
                                      <FeedEntries
                                        key={scIdx}
                                        entries={[sc.entry]}
                                        sessionId={sessionId}
                                        currentThreadKey={currentThreadKey}
                                        isCodexSession={isCodexSession}
                                        activeCodexTerminalIds={activeCodexTerminalIds}
                                        onOpenCodexTerminal={onOpenCodexTerminal}
                                        onSelectThread={onSelectThread}
                                        questLinkSurface={questLinkSurface}
                                      />
                                    ))}
                                  </HidePawContext.Provider>
                                </div>
                              )}
                              <CollapsedTurnRows
                                turn={turn}
                                sessionId={sessionId}
                                currentThreadKey={currentThreadKey}
                                minuteBoundaryLabels={minuteBoundaryLabels}
                                isCodexSession={isCodexSession}
                                activeCodexTerminalIds={activeCodexTerminalIds}
                                onOpenCodexTerminal={onOpenCodexTerminal}
                                onSelectThread={onSelectThread}
                                questLinkSurface={questLinkSurface}
                                threadResponsePresentation={collapsedThreadResponsePresentation}
                                activeNeedsInputAnchorMessageIds={activeNeedsInputAnchorMessageIds}
                                preserveHostQuestQuiz={preserveHostQuestQuiz}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {(!isActivityExpanded || turnPresentationEntries(turn).length === 0) && threadStatusFooter}
                    {!isActivityExpanded && turnPresentationEntries(turn).length > 0 && (
                      <TurnToggleFooter
                        expanded={false}
                        onToggle={() => toggleTurn(turn.id)}
                        toolCount={turn.stats.toolCount}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ));
      })()}
    </InlineMessageTimingVisibilityContext.Provider>
  );
});
