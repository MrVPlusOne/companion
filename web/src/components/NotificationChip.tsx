import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import type { ChatMessage, SessionNotification } from "../types.js";
import {
  applySessionNotifications,
  isActionableSessionNotification,
  isClearedNotificationStatus,
  type NotificationStatusSnapshot,
} from "../notification-status.js";
import { attentionLedgerMessageIdForNotificationId } from "../utils/attention-records.js";
import { MAIN_THREAD_KEY } from "../utils/thread-projection.js";
import { formatNeedsInputResponse, getNeedsInputQuestionViews } from "../utils/notification-questions.js";
import {
  getNotificationSourceContext,
  getNotificationTitle,
  shouldShowNeedsInputQuestionPrompt,
} from "../utils/notification-source-context.js";
import {
  resolveNotificationOwnerThreadKey,
  runAfterNotificationOwnerThreadSelected,
} from "../utils/notification-thread.js";
import { getActionableNotificationMessageId } from "../utils/notification-targets.js";
import { normalizeThreadKey } from "../utils/thread-projection.js";
import { NeedsInputSourceTarget } from "./NeedsInputSourceTarget.js";
import { NeedsInputAnswerField } from "./NeedsInputAnswerField.js";

const EMPTY: SessionNotification[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
type NotificationCategory = SessionNotification["category"];
const NOTIFICATION_POPOVER_MIN_BOTTOM_PX = 56;
const NOTIFICATION_POPOVER_ANCHOR_GAP_PX = 8;
const NOTIFICATION_POPOVER_VIEWPORT_GUTTER_PX = 12;

function getNotificationPopoverBottomPx(anchor: HTMLElement | null): number {
  if (typeof window === "undefined" || !anchor) return NOTIFICATION_POPOVER_MIN_BOTTOM_PX;
  const anchorRect = anchor.getBoundingClientRect();
  if (anchorRect.top === 0 && anchorRect.bottom === 0 && anchorRect.width === 0 && anchorRect.height === 0) {
    return NOTIFICATION_POPOVER_MIN_BOTTOM_PX;
  }
  const anchorTop = anchorRect.top;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!Number.isFinite(anchorTop) || viewportHeight <= 0) return NOTIFICATION_POPOVER_MIN_BOTTOM_PX;
  return Math.max(
    NOTIFICATION_POPOVER_MIN_BOTTOM_PX,
    Math.ceil(viewportHeight - anchorTop + NOTIFICATION_POPOVER_ANCHOR_GAP_PX),
  );
}

function useNotificationPopoverLayout(anchor: HTMLElement | null) {
  const [bottomPx, setBottomPx] = useState(NOTIFICATION_POPOVER_MIN_BOTTOM_PX);

  useLayoutEffect(() => {
    const update = () => setBottomPx(getNotificationPopoverBottomPx(anchor));
    update();

    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && anchor) {
      observer = new ResizeObserver(update);
      observer.observe(anchor);
    }

    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [anchor]);

  return {
    "--notification-popover-bottom": `${bottomPx}px`,
    "--notification-popover-available-height": `calc(100dvh - ${bottomPx}px - ${NOTIFICATION_POPOVER_VIEWPORT_GUTTER_PX}px)`,
  } as CSSProperties;
}

function useNotifications(sessionId: string) {
  const all = useStore((s) => s.sessionNotifications?.get(sessionId)) ?? EMPTY;
  const actionable = useMemo(() => all.filter(isActionableSessionNotification), [all]);
  const needsInput = useMemo(() => actionable.filter((n) => n.category === "needs-input"), [actionable]);
  const active = useMemo(() => needsInput.filter((n) => !n.done && !n.muted), [needsInput]);
  const muted = useMemo(() => needsInput.filter((n) => !n.done && n.muted), [needsInput]);
  const done = useMemo(() => needsInput.filter((n) => n.done), [needsInput]);
  return { all: needsInput, active, muted, done };
}

function useNotificationSummary(sessionId: string): NotificationStatusSnapshot {
  const notificationUrgency = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.notificationUrgency,
  );
  const activeNotificationCount = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.activeNotificationCount,
  );
  const activeNeedsInputNotificationCount = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.activeNeedsInputNotificationCount,
  );
  const activeReviewNotificationCount = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.activeReviewNotificationCount,
  );
  const notificationStatusVersion = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.notificationStatusVersion,
  );
  const notificationStatusUpdatedAt = useStore(
    (s) => s.sdkSessions.find((entry) => entry.sessionId === sessionId)?.notificationStatusUpdatedAt,
  );
  return useMemo(
    () => ({
      notificationUrgency,
      activeNotificationCount,
      activeNeedsInputNotificationCount,
      activeReviewNotificationCount,
      notificationStatusVersion,
      notificationStatusUpdatedAt,
    }),
    [
      notificationUrgency,
      activeNotificationCount,
      activeNeedsInputNotificationCount,
      activeReviewNotificationCount,
      notificationStatusVersion,
      notificationStatusUpdatedAt,
    ],
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getNotificationBreakdown(notifications: ReadonlyArray<Pick<SessionNotification, "category" | "muted">>) {
  let needsInput = 0;
  let review = 0;
  for (const notification of notifications) {
    if (notification.category === "needs-input" && notification.muted) continue;
    if (notification.category === "needs-input") needsInput += 1;
    else if (notification.category === "review") review += 1;
  }
  return { needsInput, review, waiting: 0 };
}

function getSummaryBreakdown(summary: NotificationStatusSnapshot) {
  const count = summary.activeNeedsInputNotificationCount ?? summary.activeNotificationCount ?? 0;
  if (count <= 0) return { needsInput: 0, review: 0, waiting: 0 };
  if (summary.notificationUrgency === "needs-input") return { needsInput: count, review: 0, waiting: 0 };
  return { needsInput: 0, review: 0, waiting: 0 };
}

function getEffectiveNotificationBreakdown(
  notifications: ReadonlyArray<Pick<SessionNotification, "category" | "muted">>,
  summary: NotificationStatusSnapshot,
) {
  if (isClearedNotificationStatus(summary)) return { needsInput: 0, review: 0, waiting: 0 };
  const live = getNotificationBreakdown(notifications);
  const liveTotal = live.needsInput + live.review + live.waiting;
  const summaryCount = summary.activeNotificationCount ?? 0;
  const summaryNeedsInputCount = summary.activeNeedsInputNotificationCount;
  const hasFreshSummary =
    summary.notificationStatusVersion !== undefined || summary.notificationStatusUpdatedAt !== undefined;
  const summaryUrgency = summary.notificationUrgency;
  if (hasFreshSummary && summaryNeedsInputCount !== undefined && summaryNeedsInputCount !== live.needsInput) {
    return { needsInput: summaryNeedsInputCount, review: 0, waiting: 0 };
  }
  if (hasFreshSummary && summaryCount > 0 && summaryUrgency) {
    const liveDisagreesWithSummary =
      liveTotal !== summaryCount ||
      (summaryUrgency === "needs-input" && live.needsInput === 0) ||
      (summaryUrgency === "review" && live.needsInput > 0);
    if (liveDisagreesWithSummary) return getSummaryBreakdown(summary);
  }
  if (hasFreshSummary && summaryCount > 0 && summaryUrgency === null && liveTotal !== summaryCount) {
    return getSummaryBreakdown(summary);
  }
  return live;
}

function formatChipAriaLabel({
  needsInput,
  review,
  waiting,
  mutedNeedsInput,
}: {
  needsInput: number;
  review: number;
  waiting: number;
  mutedNeedsInput: number;
}): string {
  const parts: string[] = [];
  if (needsInput > 0)
    parts.push(`${needsInput} ${needsInput === 1 ? "needs-input notification" : "needs-input notifications"}`);
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? "waiting status" : "waiting statuses"}`);
  if (mutedNeedsInput > 0) {
    parts.push(`${mutedNeedsInput} muted needs-input ${mutedNeedsInput === 1 ? "notification" : "notifications"}`);
  }
  return parts.length > 0 ? `Notification inbox: ${parts.join(", ")}` : "Notification inbox: no active notifications";
}

function NotificationCountInline({
  category,
  count,
  labelText,
  tone = "active",
}: {
  category: NotificationCategory;
  count: number;
  labelText: string;
  tone?: "active" | "muted";
}) {
  const isNeedsInput = category === "needs-input";
  const isReview = category === "review";
  const mutedTone = tone === "muted";
  const iconClassName = mutedTone
    ? "text-cc-muted"
    : isNeedsInput
      ? "text-cc-attention"
      : isReview
        ? "text-cc-info"
        : "text-cc-muted/85";
  const label = isNeedsInput ? "Needs input" : isReview ? "Review" : "Waiting";

  return (
    <span
      data-testid={`notification-chip-${category}`}
      className="inline-flex items-center gap-1 whitespace-nowrap"
      aria-hidden="true"
      title={`${label}: ${count}`}
    >
      <span className="text-cc-fg/95">{count}</span>
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        {category === "waiting" ? (
          <>
            <path d="M8 2.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5z" />
            <path d="M8 5.25V8l1.75 1.1" />
          </>
        ) : (
          <>
            <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 2.5-1.5 4-1.5 4h12s-1.5-1.5-1.5-4A4.5 4.5 0 0 0 8 1.5z" />
            <path d="M6 12a2 2 0 0 0 4 0" />
          </>
        )}
      </svg>
      <span
        className={
          mutedTone
            ? "text-cc-muted"
            : isNeedsInput
              ? "text-cc-attention"
              : isReview
                ? "text-cc-info"
                : "text-cc-muted/85"
        }
      >
        {labelText}
      </span>
    </span>
  );
}

function parseSingleQuestSummary(summary?: string): { before: string; questId: string; after: string } | null {
  if (!summary) return null;
  const matches = Array.from(summary.matchAll(/\b(q-\d+)\b/gi));
  if (matches.length !== 1 || matches[0].index == null) return null;
  const questId = matches[0][1];
  const start = matches[0].index;
  const end = start + matches[0][0].length;
  return {
    before: summary.slice(0, start),
    questId,
    after: summary.slice(end),
  };
}

function getCompactReviewSummary(
  summary?: string,
): { text: string; questSummary: { before: string; questId: string; after: string } | null } | null {
  if (!summary) return null;

  const singleQuestMatch = summary.match(/^\s*(q-\d+)\s+ready\s+for\s+review(?:\s*:\s*(.+?))?\s*$/i);
  if (singleQuestMatch) {
    const questId = singleQuestMatch[1];
    const title = singleQuestMatch[2]?.trim();
    return {
      text: title ? `${questId}: ${title}` : questId,
      questSummary: {
        before: "",
        questId,
        after: title ? `: ${title}` : "",
      },
    };
  }

  const multiQuestMatch = summary.match(/^\s*\d+\s+quests?\s+ready\s+for\s+review\s*:\s*(.+?)\s*$/i);
  if (multiQuestMatch) {
    return {
      text: multiQuestMatch[1].trim(),
      questSummary: null,
    };
  }

  return { text: summary, questSummary: parseSingleQuestSummary(summary) };
}

function getCurrentNotificationStatus(sessionId: string): NotificationStatusSnapshot {
  const session = useStore.getState().sdkSessions.find((entry) => entry.sessionId === sessionId);
  return {
    notificationUrgency: session?.notificationUrgency,
    activeNotificationCount: session?.activeNotificationCount,
    activeNeedsInputNotificationCount: session?.activeNeedsInputNotificationCount,
    activeReviewNotificationCount: session?.activeReviewNotificationCount,
    mutedNeedsInputNotificationCount: session?.mutedNeedsInputNotificationCount,
    notificationStatusVersion: session?.notificationStatusVersion,
    notificationStatusUpdatedAt: session?.notificationStatusUpdatedAt,
  };
}

function markLocalNotificationMuted(sessionId: string, notificationId: string, muted: boolean) {
  const store = useStore.getState();
  const notifications = store.sessionNotifications.get(sessionId);
  if (!notifications) return;
  const nextNotifications = notifications.map((notification) => {
    if (notification.id !== notificationId) return notification;
    if (muted) return { ...notification, muted: true, mutedAt: Date.now() };
    const { muted: _muted, mutedAt: _mutedAt, ...rest } = notification;
    return rest;
  });
  store.setSessionNotifications(sessionId, nextNotifications);
  applySessionNotifications(sessionId, nextNotifications, getCurrentNotificationStatus(sessionId));
}

// ─── Notification Item ───────────────────────────────────────────────────────

function NotificationItem({
  notif,
  sessionId,
  currentThreadKey,
  onSelectThread,
}: {
  notif: SessionNotification;
  sessionId: string;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const toggleDone = useCallback(() => {
    api.markNotificationDone(sessionId, notif.id, !notif.done).catch(() => {});
  }, [sessionId, notif.id, notif.done]);

  const ownerThreadKey = resolveNotificationOwnerThreadKey(notif);
  const messages = useStore((s) => s.messages?.get(sessionId) ?? EMPTY_MESSAGES);
  const threadWindowMessages = useStore((s) => s.threadWindowMessages?.get(sessionId));
  const notificationTargetMessages = useMemo(() => {
    const ownerWindowMessages = threadWindowMessages?.get(ownerThreadKey) ?? EMPTY_MESSAGES;
    const selectedThreadKey = normalizeThreadKey(currentThreadKey ?? MAIN_THREAD_KEY);
    const selectedWindowMessages =
      selectedThreadKey !== ownerThreadKey
        ? (threadWindowMessages?.get(selectedThreadKey) ?? EMPTY_MESSAGES)
        : EMPTY_MESSAGES;
    if (ownerWindowMessages.length === 0 && selectedWindowMessages.length === 0) return messages;
    return [...messages, ...ownerWindowMessages, ...selectedWindowMessages];
  }, [currentThreadKey, messages, ownerThreadKey, threadWindowMessages]);
  const actionableMessageId = getActionableNotificationMessageId(notif, notificationTargetMessages);
  const fallbackChipMessageId =
    notif.category === "needs-input" && !actionableMessageId && ownerThreadKey !== MAIN_THREAD_KEY
      ? attentionLedgerMessageIdForNotificationId(notif.id)
      : null;
  const jumpTargetMessageId = actionableMessageId ?? fallbackChipMessageId;

  const jumpToMessage = useCallback(() => {
    if (!jumpTargetMessageId) return;
    runAfterNotificationOwnerThreadSelected({
      notification: notif,
      currentThreadKey,
      onSelectThread,
      action: () => {
        const store = useStore.getState();
        store.requestScrollToMessage(sessionId, jumpTargetMessageId);
        store.setExpandAllInTurn(sessionId, jumpTargetMessageId);
      },
    });
    // Don't close panel -- user may want to click multiple notifications
  }, [sessionId, notif, currentThreadKey, onSelectThread, jumpTargetMessageId]);

  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, string>>({});
  const [togglingMute, setTogglingMute] = useState(false);
  const [muteError, setMuteError] = useState<string | null>(null);
  const questionViews = useMemo(
    () => (notif.category === "needs-input" ? getNeedsInputQuestionViews(notif) : []),
    [notif],
  );
  const setQuestionAnswer = useCallback((key: string, value: string) => {
    setAnswersByQuestion((prev) => ({ ...prev, [key]: value }));
  }, []);
  const startReply = useCallback(
    (answerText?: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      runAfterNotificationOwnerThreadSelected({
        notification: notif,
        currentThreadKey,
        onSelectThread,
        action: () => {
          const store = useStore.getState();
          const current = store.composerDrafts.get(sessionId);
          store.setReplyContext(sessionId, {
            ...(notif.messageId ? { messageId: notif.messageId } : {}),
            notificationId: notif.id,
            previewText: notif.summary || "Needs your input",
          });
          if (answerText !== undefined) {
            store.setComposerDraft(sessionId, { ...current, text: answerText, images: current?.images ?? [] });
          }
          store.focusComposer();
        },
      });
    },
    [sessionId, notif, currentThreadKey, onSelectThread],
  );

  const isNeedsInput = notif.category === "needs-input";
  const isMutableNeedsInput = isNeedsInput && !notif.done;
  const isMutedNeedsInput = isMutableNeedsInput && Boolean(notif.muted);
  const canSendResponse =
    isNeedsInput &&
    !notif.done &&
    questionViews.length > 0 &&
    questionViews.every((q) => answersByQuestion[q.key]?.trim());
  const sendResponse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!canSendResponse) return;
      runAfterNotificationOwnerThreadSelected({
        notification: notif,
        currentThreadKey,
        onSelectThread,
        action: () => {
          const ownerThreadKey = resolveNotificationOwnerThreadKey(notif);
          const threadKey = ownerThreadKey || MAIN_THREAD_KEY;
          const content = formatNeedsInputResponse(notif.summary, questionViews, answersByQuestion);
          api
            .sendNeedsInputResponse(sessionId, notif.id, {
              content,
              threadKey,
              ...(threadKey !== MAIN_THREAD_KEY ? { questId: notif.questId ?? threadKey } : {}),
            })
            .then(() => {
              useStore.getState().requestBottomAlignOnNextUserMessage?.(sessionId);
              setAnswersByQuestion({});
            })
            .catch(() => {});
        },
      });
    },
    [answersByQuestion, canSendResponse, currentThreadKey, notif, onSelectThread, questionViews, sessionId],
  );
  const toggleMuted = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isMutableNeedsInput || togglingMute) return;
      const nextMuted = !notif.muted;
      setTogglingMute(true);
      setMuteError(null);
      api
        .setNotificationMuted(sessionId, notif.id, nextMuted)
        .then(() => {
          markLocalNotificationMuted(sessionId, notif.id, nextMuted);
        })
        .catch((error) => {
          const message = error instanceof Error && error.message ? error.message : "Please retry.";
          setMuteError(`${nextMuted ? "Mute" : "Unmute"} failed. ${message}`);
        })
        .finally(() => setTogglingMute(false));
    },
    [isMutableNeedsInput, notif.id, notif.muted, sessionId, togglingMute],
  );
  const compactReviewSummary = notif.category === "review" ? getCompactReviewSummary(notif.summary) : null;
  const label = compactReviewSummary?.text || getNotificationTitle(notif);
  const questSummary = compactReviewSummary?.questSummary ?? null;
  const labelClassName = notif.done ? "text-cc-muted line-through" : "text-cc-fg/90";
  const sourceContext = useMemo(
    () => (isNeedsInput ? getNotificationSourceContext(notif, notificationTargetMessages, actionableMessageId) : null),
    [actionableMessageId, isNeedsInput, notif, notificationTargetMessages],
  );
  const voiceThreadTitle = ownerThreadKey === MAIN_THREAD_KEY ? "Main Thread" : (notif.questId ?? ownerThreadKey);

  const renderLabel = () => {
    if (!questSummary) {
      return <span className={`block max-w-full truncate ${labelClassName}`}>{label}</span>;
    }

    return (
      <span className={`block max-w-full truncate ${labelClassName}`}>
        {questSummary.before}
        <QuestInlineLink
          questId={questSummary.questId}
          stopPropagation={true}
          className={`font-mono-code hover:underline ${notif.done ? "text-cc-muted" : "text-cc-primary"}`}
        >
          {questSummary.questId}
        </QuestInlineLink>
        {questSummary.after}
      </span>
    );
  };

  const handleJumpKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    jumpToMessage();
  };

  return (
    <div
      className="flex items-start gap-2 px-3 py-2 hover:bg-cc-hover/40 transition-colors group"
      data-testid="notification-inbox-row"
      data-notification-id={notif.id}
      data-notification-category={notif.category}
      data-muted={isMutedNeedsInput ? "true" : undefined}
    >
      {/* Checkbox */}
      <button
        onClick={toggleDone}
        className="mt-0.5 shrink-0 w-4 h-4 rounded border border-cc-border/60 flex items-center justify-center cursor-pointer hover:border-cc-primary/50 transition-colors"
        aria-label={notif.done ? "Mark as active" : "Mark as done"}
      >
        {notif.done && (
          <svg
            className="w-3 h-3 text-cc-primary"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 8.5l3 3 6-6" />
          </svg>
        )}
      </button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <span
              className={`mt-[0.35rem] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                isMutedNeedsInput
                  ? "border border-cc-muted/70 bg-cc-muted/45"
                  : isNeedsInput
                    ? "bg-cc-attention"
                    : notif.category === "review"
                      ? "bg-cc-info"
                      : "bg-cc-muted/65"
              }`}
            />
            {isNeedsInput ? (
              <div className="min-w-0 flex-1">
                <NeedsInputSourceTarget
                  title={label}
                  sourceContext={sourceContext}
                  titleClassName={labelClassName}
                  testIdPrefix="notification"
                />
              </div>
            ) : jumpTargetMessageId ? (
              <div
                role="button"
                tabIndex={0}
                onClick={jumpToMessage}
                onKeyDown={handleJumpKeyDown}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <div className="text-[12px] text-left">{renderLabel()}</div>
              </div>
            ) : (
              <div className="text-[12px] text-left">{renderLabel()}</div>
            )}
          </div>
          {isMutableNeedsInput && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 pl-3 sm:justify-end sm:pl-0">
              <button
                type="button"
                onClick={toggleMuted}
                disabled={togglingMute}
                className="inline-flex items-center rounded border border-cc-border/70 bg-cc-card px-2 py-0.5 text-[11px] font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-muted/45 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                aria-label={`${isMutedNeedsInput ? "Unmute" : "Mute"} ${label}`}
              >
                {togglingMute ? "..." : isMutedNeedsInput ? "Unmute" : "Mute"}
              </button>
              {jumpTargetMessageId && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    jumpToMessage();
                  }}
                  className="inline-flex items-center rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-0.5 text-[11px] font-medium text-cc-attention transition-colors hover:bg-cc-attention-bg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-attention/45 cursor-pointer"
                  aria-label={`Go to source for ${label}`}
                >
                  Go to
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 pl-3 text-[10px] text-cc-muted">
          {isMutedNeedsInput && (
            <span className="rounded border border-cc-border/70 bg-cc-hover/35 px-1 py-px font-medium">Muted</span>
          )}
          <span className="text-cc-muted">{formatRelativeTime(notif.timestamp)}</span>
        </div>
        {isNeedsInput && !notif.done && (
          <div className="mt-2 space-y-2 pl-3" data-testid="notification-answer-actions">
            {questionViews.map((question, index) => (
              <div key={question.key} className="space-y-1.5" data-testid="notification-question-block">
                {shouldShowNeedsInputQuestionPrompt({
                  prompt: question.prompt,
                  title: label,
                  questionCount: questionViews.length,
                }) && (
                  <div className="text-[11px] leading-snug text-cc-fg/80">
                    {questionViews.length > 1 && <span className="text-cc-muted">{index + 1}. </span>}
                    {question.prompt}
                  </div>
                )}
                {question.suggestedAnswers.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {question.suggestedAnswers.map((answer) => (
                      <button
                        key={answer}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQuestionAnswer(question.key, answer);
                        }}
                        className="max-w-full truncate rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-0.5 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 cursor-pointer"
                        title={`Use suggested answer: ${answer}`}
                      >
                        {answer}
                      </button>
                    ))}
                  </div>
                )}
                <NeedsInputAnswerField
                  sessionId={sessionId}
                  notification={notif}
                  question={question}
                  questionCount={questionViews.length}
                  value={answersByQuestion[question.key] ?? ""}
                  onChange={(value) => setQuestionAnswer(question.key, value)}
                  placeholder="Answer"
                  sourceContext={sourceContext}
                  threadKey={ownerThreadKey}
                  threadTitle={voiceThreadTitle}
                  textareaClassName="border-cc-border/60 px-2 py-1 text-[12px] text-cc-fg"
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={sendResponse}
                disabled={!canSendResponse}
                className="rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-0.5 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                Send Response
              </button>
              <button
                type="button"
                onClick={startReply()}
                className="rounded border border-cc-border/60 px-2 py-0.5 text-[11px] cc-muted-readable transition-colors hover:border-cc-primary/40 hover:text-cc-fg cursor-pointer"
              >
                Use composer
              </button>
            </div>
          </div>
        )}
        {muteError && <p className="mt-2 pl-3 text-[10px] leading-snug text-cc-error">{muteError}</p>}
      </div>
    </div>
  );
}

// ─── Notification Popover ────────────────────────────────────────────────────

function NotificationPopover({
  sessionId,
  onClose,
  anchor,
  currentThreadKey,
  onSelectThread,
}: {
  sessionId: string;
  onClose: () => void;
  anchor: HTMLElement | null;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const { active, muted, done } = useNotifications(sessionId);
  const questOverlayId = useStore((s) => s.questOverlayId);
  const [showDone, setShowDone] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverLayoutStyle = useNotificationPopoverLayout(anchor);
  const markAllRead = useCallback(() => {
    for (const notification of active) {
      api.markNotificationDone(sessionId, notification.id, true).catch(() => {});
    }
  }, [active, sessionId]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (questOverlayId) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [onClose, questOverlayId]);

  // Click-outside to close (mousedown for early dismissal)
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (questOverlayId) return;
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer to avoid closing immediately from the chip click that opened this
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, questOverlayId]);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed inset-x-3 bottom-[var(--notification-popover-bottom)] z-50 flex max-h-[min(60vh,28rem,var(--notification-popover-available-height))] flex-col overflow-hidden rounded-2xl border border-cc-border bg-cc-card/95 shadow-[0_25px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:inset-x-auto sm:right-3 sm:w-[36rem] md:w-[39rem] sm:max-w-[calc(100vw-1.5rem)] sm:max-h-[min(60vh,34rem,var(--notification-popover-available-height))]"
      style={popoverLayoutStyle}
      role="dialog"
      aria-label="Notification inbox"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cc-border/50 shrink-0">
        <h2 className="text-[13px] font-medium text-cc-fg">
          Notifications
          {(active.length > 0 || muted.length > 0) && (
            <span className="ml-1.5 text-[11px] text-cc-muted font-normal">({active.length})</span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          {active.length > 0 && (
            <button
              onClick={markAllRead}
              className="text-[11px] text-cc-primary hover:text-cc-primary-hover transition-colors px-1.5 py-0.5 cursor-pointer"
            >
              Read All
            </button>
          )}
          <button
            onClick={onClose}
            className="text-cc-muted hover:text-cc-fg transition-colors p-1 -mr-1 cursor-pointer"
            aria-label="Close"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Notification list */}
      <div className="overflow-y-auto flex-1">
        {active.length === 0 && muted.length === 0 && done.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-cc-muted">No notifications</p>
        ) : (
          <>
            {active.length > 0 && (
              <div className="divide-y divide-cc-border/20">
                {[...active].reverse().map((n) => (
                  <NotificationItem
                    key={n.id}
                    notif={n}
                    sessionId={sessionId}
                    currentThreadKey={currentThreadKey}
                    onSelectThread={onSelectThread}
                  />
                ))}
              </div>
            )}

            {muted.length > 0 && (
              <section className="border-t border-cc-border/60" aria-label="Muted needs-input notifications">
                <div className="flex items-center justify-between bg-cc-hover/20 px-3 py-1.5">
                  <span className="text-[11px] font-medium text-cc-muted">Muted</span>
                  <span className="text-[10px] text-cc-muted/70">{muted.length}</span>
                </div>
                <div className="divide-y divide-cc-border/20">
                  {[...muted].reverse().map((n) => (
                    <NotificationItem
                      key={n.id}
                      notif={n}
                      sessionId={sessionId}
                      currentThreadKey={currentThreadKey}
                      onSelectThread={onSelectThread}
                    />
                  ))}
                </div>
              </section>
            )}

            {done.length > 0 && (
              <div className="border-t border-cc-border/30">
                <button
                  onClick={() => setShowDone((p) => !p)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-cc-muted hover:text-cc-fg cursor-pointer transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${showDone ? "rotate-90" : ""}`}
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M6 4l4 4-4 4z" />
                  </svg>
                  Done ({done.length})
                </button>
                {showDone && (
                  <div className="divide-y divide-cc-border/10 opacity-60">
                    {[...done].reverse().map((n) => (
                      <NotificationItem
                        key={n.id}
                        notif={n}
                        sessionId={sessionId}
                        currentThreadKey={currentThreadKey}
                        onSelectThread={onSelectThread}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Notification Chip (floating pill) ───────────────────────────────────────

/** Floating pill for needs-input notifications. Review status is owned by thread tabs. */
export function NotificationChip({
  sessionId,
  currentThreadKey,
  onSelectThread,
}: {
  sessionId: string;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const { active, muted } = useNotifications(sessionId);
  const summary = useNotificationSummary(sessionId);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const { needsInput, review, waiting } = useMemo(
    () => getEffectiveNotificationBreakdown(active, summary),
    [active, summary],
  );
  const mutedNeedsInput = muted.length;
  const ariaLabel = useMemo(
    () => formatChipAriaLabel({ needsInput, review, waiting, mutedNeedsInput }),
    [mutedNeedsInput, needsInput, review, waiting],
  );
  const hasNeedsInput = needsInput > 0;
  const hasMutedNeedsInput = mutedNeedsInput > 0;

  const toggle = useCallback(() => setOpen((p) => !p), []);
  const close = useCallback(() => setOpen(false), []);

  if (needsInput + waiting === 0 && !hasMutedNeedsInput) return null;

  return (
    <>
      <button
        ref={chipRef}
        onClick={toggle}
        aria-label={ariaLabel}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1 overflow-hidden rounded-[18px] border border-cc-border bg-cc-card/95 px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.22)] backdrop-blur-md cursor-pointer hover:border-cc-muted/35 transition-colors"
      >
        <span className="pointer-events-none absolute inset-0 bg-cc-hover/20" />
        <span className="relative inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
          {hasNeedsInput ? (
            <NotificationCountInline category="needs-input" count={needsInput} labelText="needs input" />
          ) : hasMutedNeedsInput ? (
            <NotificationCountInline category="needs-input" count={0} labelText="needs input" tone="muted" />
          ) : (
            <NotificationCountInline category="waiting" count={waiting} labelText="status" />
          )}
        </span>
      </button>

      {open && (
        <NotificationPopover
          sessionId={sessionId}
          onClose={close}
          anchor={chipRef.current}
          currentThreadKey={currentThreadKey}
          onSelectThread={onSelectThread}
        />
      )}
    </>
  );
}
