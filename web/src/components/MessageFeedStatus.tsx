import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import type {
  ActiveTurnRoute,
  ChatMessage,
  PendingCodexInput,
  PendingUserUpload,
  SdkSessionInfo,
  SessionState,
} from "../types.js";
import { YarnBallDot } from "./CatIcons.js";
import { ImagePreviewGroup } from "./ImagePreviewGroup.js";
import { buildUserImagePreviewItems } from "./image-preview-utils.js";
import { MessageBubble } from "./MessageBubble.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";
import { NotificationChip } from "./NotificationChip.js";
import { TimerChip } from "./TimerWidget.js";
import { formatElapsed, formatTokens, getFooterFeedBlockId, getPendingCodexFeedBlockId } from "./message-feed-utils.js";
import { formatReplyContentForPreview } from "../utils/reply-context.js";
import { normalizeThreadKey } from "../utils/thread-projection.js";
import { getRecoverableSessionConnectionPresentation } from "../utils/recoverable-session-connection.js";

const FLOATING_FEED_CHIP_CLASS =
  "relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-cc-border bg-cc-card/95 px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.22)] backdrop-blur-md";

export function ElapsedTimer({
  sessionId,
  latestIndicatorVisible = false,
  onJumpToLatest,
  variant = "bar",
  currentThreadKey = "main",
  onSelectThread,
  onVisibleHeightChange,
  preserveFloatingRowWhenHidden = false,
}: {
  sessionId: string;
  latestIndicatorVisible?: boolean;
  onJumpToLatest?: () => void;
  variant?: "bar" | "floating";
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
  onVisibleHeightChange?: (height: number) => void;
  preserveFloatingRowWhenHidden?: boolean;
}) {
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const streamingPausedDuration = useStore((s) => s.streamingPausedDuration.get(sessionId) ?? 0);
  const streamingPauseStartedAt = useStore((s) => s.streamingPauseStartedAt.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const streamRetry = useStore((s) => s.sessions?.get(sessionId)?.codex_stream_retry ?? null);
  const activeTurnRoute = useStore((s) => s.activeTurnRoutes?.get(sessionId));
  const bridgeIsOrchestrator = useStore((s) => s.sessions?.get(sessionId)?.isOrchestrator === true);
  const bridgeClaimedQuestId = useStore((s) => s.sessions?.get(sessionId)?.claimedQuestId ?? null);
  const sdkIsOrchestrator = useStore(
    (s) => s.sdkSessions?.find((session) => session.sessionId === sessionId)?.isOrchestrator === true,
  );
  const sdkReviewerOf = useStore(
    (s) => s.sdkSessions?.find((session) => session.sessionId === sessionId)?.reviewerOf ?? null,
  );
  const sdkClaimedQuestId = useStore(
    (s) => s.sdkSessions?.find((session) => session.sessionId === sessionId)?.claimedQuestId ?? null,
  );
  const reviewedQuestId = useStore((s) => findReviewedQuestId(sessionId, s.sdkSessions ?? [], s.sessions ?? new Map()));
  const isStuck = useStore((s) => s.sessionStuck.get(sessionId) ?? false);
  const isLeaderSession = bridgeIsOrchestrator || sdkIsOrchestrator;
  const [elapsed, setElapsed] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const measuredFloatingRowRef = useRef<{ sessionId: string; height: number } | null>(null);

  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    const calcElapsed = () => {
      const pauseOffset =
        streamingPausedDuration + (streamingPauseStartedAt ? Date.now() - streamingPauseStartedAt : 0);
      return Math.max(0, Date.now() - start - pauseOffset);
    };
    setElapsed(calcElapsed());
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus, streamingPausedDuration, streamingPauseStartedAt]);

  const showTimer = sessionStatus === "running" && (elapsed > 0 || !!streamRetry);

  useLayoutEffect(() => {
    if (!onVisibleHeightChange) return;
    if (!showTimer) {
      onVisibleHeightChange(0);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const reportHeight = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (variant === "floating" && height > 0) {
        measuredFloatingRowRef.current = { sessionId, height };
      }
      onVisibleHeightChange(height);
    };
    reportHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [onVisibleHeightChange, sessionId, showTimer, streamingOutputTokens, variant]);

  if (!showTimer) {
    const reservedHeight =
      variant === "floating" && preserveFloatingRowWhenHidden && measuredFloatingRowRef.current?.sessionId === sessionId
        ? measuredFloatingRowRef.current.height
        : 0;
    return reservedHeight > 0 ? (
      <div
        aria-hidden="true"
        className="pointer-events-none w-0 shrink-0"
        data-feed-activity-reservation="true"
        style={{ height: `${reservedHeight}px` }}
      />
    ) : null;
  }

  const handleRelaunch = () => {
    api.relaunchSession(sessionId).catch(() => {});
  };
  const activeTurnNavigationTarget = leaderActiveTurnNavigationTarget(activeTurnRoute, currentThreadKey, {
    isLeaderSession,
  });

  const label = isStuck
    ? "Session may be stuck"
    : streamingPauseStartedAt
      ? "Napping..."
      : streamRetry
        ? "Retrying response..."
        : formatActiveTurnLabel(activeTurnRoute, currentThreadKey, {
            isLeaderSession,
            isReviewerSession: sdkReviewerOf !== null,
            claimedQuestId: bridgeClaimedQuestId ?? sdkClaimedQuestId,
            reviewedQuestId,
          });
  const retryDetail = streamRetry
    ? "Codex reported a retryable error and is retrying this response. Its attempt count is unavailable."
    : undefined;
  const dotColor = isStuck
    ? "text-cc-attention"
    : streamingPauseStartedAt
      ? "text-cc-attention"
      : "text-cc-primary animate-pulse";
  const canNavigateActiveTurn =
    variant === "floating" && !!onSelectThread && !!activeTurnNavigationTarget && !isStuck && !streamingPauseStartedAt;
  const floatingChipContents = (
    <>
      <span className="pointer-events-none absolute inset-0 bg-cc-hover/20" />
      <span className="relative flex min-w-0 items-center gap-1.5">
        <YarnBallDot className={dotColor} />
        <span className="truncate text-cc-fg/90" title={retryDetail}>
          {label}
        </span>
        <span className="text-cc-muted/75">{formatElapsed(elapsed)}</span>
        {(streamingOutputTokens ?? 0) > 0 && (
          <span className="hidden truncate text-cc-muted/70 sm:inline">
            ↓ {formatTokens(streamingOutputTokens ?? 0)}
          </span>
        )}
      </span>
      {isStuck && (
        <button
          onClick={handleRelaunch}
          className="relative ml-1 text-cc-attention hover:text-cc-attention-strong underline cursor-pointer"
        >
          Relaunch
        </button>
      )}
    </>
  );

  if (variant === "floating") {
    if (canNavigateActiveTurn && onSelectThread && activeTurnNavigationTarget) {
      const targetThreadKey = activeTurnNavigationTarget;
      return (
        <div ref={rootRef} className="pointer-events-auto relative" data-feed-activity-row="true">
          <button
            type="button"
            onClick={() => onSelectThread(targetThreadKey)}
            className={`${FLOATING_FEED_CHIP_CLASS} cursor-pointer text-left transition-colors hover:border-white/14 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70`}
            data-active-turn-target={targetThreadKey}
            aria-label={`Jump to active thread ${targetThreadKey}`}
            title={`Jump to active thread ${targetThreadKey}`}
          >
            {floatingChipContents}
          </button>
        </div>
      );
    }

    return (
      <div ref={rootRef} className="pointer-events-auto" data-feed-activity-row="true">
        <div className={`${FLOATING_FEED_CHIP_CLASS} cursor-default`} data-active-turn-target="">
          {floatingChipContents}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="shrink-0 flex items-center gap-1.5 border-t border-cc-border bg-cc-card px-3 sm:px-4 py-1.5 text-[11px] text-cc-muted font-mono-code"
    >
      <YarnBallDot className={dotColor} />
      <span title={retryDetail}>{label}</span>
      <span className="text-cc-muted/60">(</span>
      <span>{formatElapsed(elapsed)}</span>
      {(streamingOutputTokens ?? 0) > 0 && (
        <>
          <span className="text-cc-muted/40">·</span>
          <span>↓ {formatTokens(streamingOutputTokens ?? 0)}</span>
        </>
      )}
      <span className="text-cc-muted/60">)</span>
      {isStuck && (
        <button
          onClick={handleRelaunch}
          className="ml-1 text-cc-attention hover:text-cc-attention-strong underline cursor-pointer"
        >
          Relaunch
        </button>
      )}
      {latestIndicatorVisible && onJumpToLatest && (
        <button
          type="button"
          onClick={onJumpToLatest}
          className="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-full border border-cc-primary/25 bg-cc-card/70 px-2.5 py-0.5 text-[11px] font-medium text-cc-fg transition-colors hover:bg-cc-hover cursor-pointer"
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-cc-primary animate-pulse" />
          <span className="truncate">New content below</span>
        </button>
      )}
    </div>
  );
}

function collapsePreviewWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatActiveReasoningStatusText(text: string): string {
  const trimmed = text.trim();
  const titleMatch = trimmed.match(/^\*\*([^\n*][^\n]*?)\*\*(?:\s|$)/);
  if (titleMatch?.[1]?.trim()) {
    return collapsePreviewWhitespace(titleMatch[1]);
  }
  return collapsePreviewWhitespace(trimmed);
}

export function CodexTurnRecoveryChip({
  sessionId,
  currentThreadKey = "main",
  onSelectThread,
}: {
  sessionId: string;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailPosition, setDetailPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const storedRecovery = useStore((s) => s.sessions?.get(sessionId)?.codex_turn_recovery ?? null);
  const recovery = storedRecovery?.status === "action_required" ? null : storedRecovery;

  const destination = normalizeThreadKey(recovery?.threadKey || "main");
  const current = normalizeThreadKey(currentThreadKey || "main");
  const canNavigate = !!recovery && !!onSelectThread && destination !== current;
  const verificationFirst = recovery?.continuationMode !== "finish_response";
  const replayingOriginal = recovery?.status === "recovering" && recovery.historyPresence === "absent";
  const label = recovery
    ? recovery.status === "recovering"
      ? replayingOriginal
        ? "Retrying interrupted input"
        : "Reconnecting interrupted work"
      : recovery.status === "continuation_active"
        ? verificationFirst
          ? "Checking interrupted work"
          : "Finishing interrupted response"
        : verificationFirst
          ? "Interrupted-work check queued"
          : "Response continuation queued"
    : "";
  const detail = recovery
    ? recovery.status === "recovering"
      ? replayingOriginal
        ? "Takode proved the original input never entered Codex history and is replaying it once. No action is needed yet."
        : "Takode is reconnecting this session so it can finish the interrupted work. No action is needed yet."
      : recovery.status === "continuation_pending"
        ? verificationFirst
          ? "Takode queued one follow-up to inspect prior work before finishing what is missing. The original input will not be replayed."
          : "Takode queued one follow-up to finish the interrupted response. The original input will not be replayed."
        : verificationFirst
          ? "Takode is checking prior work before finishing what is missing. The original input was not replayed."
          : "Takode is finishing the interrupted response. The original input was not replayed."
    : "";
  const detailVisible = !!recovery && detailOpen;

  useLayoutEffect(() => {
    if (!detailVisible) {
      setDetailPosition(null);
      return;
    }
    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const buttonRect = button.getBoundingClientRect();
      const width = Math.min(336, Math.max(0, window.innerWidth - 16));
      const maxHeight = Math.max(0, window.innerHeight - 16);
      const height = Math.min(detailRef.current?.offsetHeight || 176, maxHeight);
      const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - width - 8));
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      const aboveTop = buttonRect.top - height - 8;
      const top = aboveTop >= 8 ? Math.min(aboveTop, maxTop) : Math.max(8, Math.min(buttonRect.bottom + 8, maxTop));
      setDetailPosition({ left, top, width });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [detailVisible, detail]);

  if (!recovery) return null;

  return (
    <div className="pointer-events-auto relative">
      <button
        ref={buttonRef}
        type="button"
        className={`${FLOATING_FEED_CHIP_CLASS} cursor-pointer text-left transition-colors hover:border-white/14 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70`}
        aria-expanded={detailOpen}
        aria-controls={`codex-turn-recovery-detail-${sessionId}`}
        title={detail}
        data-testid="codex-turn-recovery-chip"
        onClick={() => setDetailOpen((open) => !open)}
      >
        <span className="relative h-2 w-2 shrink-0 animate-pulse rounded-full bg-cc-primary" aria-hidden="true" />
        <span className="relative truncate text-cc-fg/90">{label}</span>
      </button>
      {detailVisible &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={detailRef}
            id={`codex-turn-recovery-detail-${sessionId}`}
            data-testid="codex-turn-recovery-detail"
            className="fixed z-[100] overflow-y-auto rounded-lg border border-cc-border bg-cc-card p-3 text-left shadow-xl"
            style={{
              left: detailPosition?.left ?? 8,
              top: detailPosition?.top ?? 8,
              width: detailPosition?.width ?? Math.min(336, Math.max(0, window.innerWidth - 16)),
              maxHeight: Math.max(0, window.innerHeight - 16),
              visibility: detailPosition ? "visible" : "hidden",
            }}
            role="status"
          >
            <div className="text-[11px] font-medium text-cc-fg">{label}</div>
            <div className="mt-1 text-[11px] leading-snug text-cc-muted">{detail}</div>
            <div className="mt-1.5 text-[10px] text-cc-muted/70">
              Work to check: {recovery.questId ?? recovery.threadKey}
            </div>
            {canNavigate && onSelectThread && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-full border border-cc-primary/30 px-2.5 py-1 text-[11px] text-cc-primary transition-colors hover:bg-cc-hover"
                  onClick={() => onSelectThread(destination)}
                >
                  Open affected thread
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function CodexProviderRetryChip({ sessionId }: { sessionId: string }) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [detailPosition, setDetailPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const retry = useStore((s) => s.sessions?.get(sessionId)?.codex_provider_retry ?? null);

  const detailOpen = !!retry && (hoverOpen || pinnedOpen);
  const persistentOutageRetry = retry?.maxAttempts === null;
  const label = retry
    ? persistentOutageRetry
      ? `Retrying message (attempt ${retry.attempt})`
      : `Retrying message (${retry.attempt} of ${retry.maxAttempts})`
    : "Retrying message";
  const detail = retry
    ? persistentOutageRetry
      ? `Takode is retrying this message about every 30 seconds. Attempt ${retry.attempt} is underway. ` +
        "No action is needed while this status remains visible."
      : `Takode is retrying this message, attempt ${retry.attempt} of ${retry.maxAttempts}. ` +
        "You can keep working. If all attempts fail, this session will show what to do next."
    : "";

  useLayoutEffect(() => {
    if (!detailOpen) {
      setDetailPosition(null);
      return;
    }
    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const buttonRect = button.getBoundingClientRect();
      const width = Math.min(304, Math.max(0, window.innerWidth - 16));
      const maxHeight = Math.max(0, window.innerHeight - 16);
      const height = Math.min(detailRef.current?.offsetHeight || 120, maxHeight);
      const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - width - 8));
      const aboveTop = buttonRect.top - height - 8;
      const maxTop = Math.max(8, window.innerHeight - height - 8);
      const top = aboveTop >= 8 ? Math.min(aboveTop, maxTop) : Math.max(8, Math.min(buttonRect.bottom + 8, maxTop));
      setDetailPosition({ left, top, width });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [detailOpen, detail]);

  if (!retry) return null;

  return (
    <div
      className="pointer-events-auto relative"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`${FLOATING_FEED_CHIP_CLASS} cursor-pointer text-left transition-colors hover:border-white/14 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70`}
        aria-expanded={detailOpen}
        aria-controls={`codex-provider-retry-detail-${sessionId}`}
        title={detail}
        data-testid="codex-provider-retry-chip"
        onClick={() => setPinnedOpen((open) => !open)}
      >
        <span className="pointer-events-none absolute inset-0 bg-cc-hover/20" />
        <span className="relative h-2 w-2 shrink-0 animate-pulse rounded-full bg-cc-primary" aria-hidden="true" />
        <span className="relative truncate text-cc-fg/90">{label}</span>
      </button>

      {detailOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={detailRef}
            id={`codex-provider-retry-detail-${sessionId}`}
            data-testid="codex-provider-retry-detail"
            className="fixed z-[100] overflow-y-auto rounded-lg border border-cc-border bg-cc-card p-3 text-left shadow-xl"
            style={{
              left: detailPosition?.left ?? 8,
              top: detailPosition?.top ?? 8,
              width: detailPosition?.width ?? Math.min(304, Math.max(0, window.innerWidth - 16)),
              maxHeight: Math.max(0, window.innerHeight - 16),
              visibility: detailPosition ? "visible" : "hidden",
            }}
            role="status"
          >
            <div className="text-[11px] font-medium text-cc-fg">{label}</div>
            <div className="mt-1 text-[11px] leading-snug text-cc-muted">{detail}</div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function RecoverableConnectionChip({ sessionId }: { sessionId: string }) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const connectionStatus = useStore((s) => s.connectionStatus?.get(sessionId) ?? "disconnected");
  const session = useStore((s) => s.sessions?.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected?.get(sessionId) ?? false);
  const cliEverConnected = useStore((s) => s.cliEverConnected?.get(sessionId) ?? false);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason?.get(sessionId) ?? null);
  const serverReachable = useStore((s) => s.serverReachable ?? true);
  const presentation = getRecoverableSessionConnectionPresentation({
    backendState: session?.backend_state,
    reconnectProgress: session?.backend_reconnect,
    browserConnectionStatus: connectionStatus,
    cliConnected,
    cliEverConnected,
    idlePaused: cliDisconnectReason === "idle_limit",
    serverReachable,
  });

  if (!presentation) return null;

  const detailOpen = hoverOpen || pinnedOpen;
  const dotClassName = presentation.kind === "reconnecting" ? "bg-cc-primary animate-pulse" : "bg-cc-muted";

  function handleResume() {
    api.relaunchSession(sessionId).catch(() => {});
  }

  return (
    <div
      className="pointer-events-auto relative"
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <button
        type="button"
        className={`${FLOATING_FEED_CHIP_CLASS} cursor-pointer text-left transition-colors hover:border-white/14 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70`}
        aria-expanded={detailOpen}
        aria-controls={`recoverable-connection-detail-${sessionId}`}
        title={presentation.detail}
        data-testid="recoverable-connection-chip"
        onClick={() => setPinnedOpen((open) => !open)}
      >
        <span className="pointer-events-none absolute inset-0 bg-cc-hover/20" />
        <span className={`relative h-2 w-2 shrink-0 rounded-full ${dotClassName}`} aria-hidden="true" />
        <span className="relative truncate text-cc-fg/90">{presentation.label}</span>
      </button>

      {detailOpen && (
        <div
          id={`recoverable-connection-detail-${sessionId}`}
          data-testid="recoverable-connection-detail"
          className="absolute bottom-full left-0 z-20 mb-2 w-[min(19rem,calc(100vw-1rem))] rounded-lg border border-cc-border bg-cc-card p-3 text-left shadow-xl"
          role="status"
        >
          <div className="text-[11px] font-medium text-cc-fg">{presentation.label}</div>
          <div className="mt-1 text-[11px] leading-snug text-cc-muted">{presentation.detail}</div>
          <button
            type="button"
            className="mt-2 inline-flex items-center rounded-md border border-cc-border px-2 py-1 text-[11px] font-medium text-cc-fg transition-colors hover:border-cc-primary/40 hover:bg-cc-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
            onClick={handleResume}
          >
            {presentation.actionLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export function FeedStatusPill({
  sessionId,
  currentThreadKey = "main",
  onVisibleHeightChange,
  onRunwayHeightChange,
  onSelectThread,
}: {
  sessionId: string;
  currentThreadKey?: string;
  onVisibleHeightChange?: (height: number) => void;
  onRunwayHeightChange?: (height: number) => void;
  onSelectThread?: (threadKey: string) => void;
}) {
  const leftStackRef = useRef<HTMLDivElement>(null);
  const rightStackRef = useRef<HTMLDivElement>(null);
  const [activityVisibleHeight, setActivityVisibleHeight] = useState(0);

  useLayoutEffect(() => {
    if (!onVisibleHeightChange && !onRunwayHeightChange) return;
    const reportHeight = () => {
      const leftStack = leftStackRef.current;
      const leftHeight = leftStack?.getBoundingClientRect().height ?? 0;
      const rightHeight = rightStackRef.current?.getBoundingClientRect().height ?? 0;
      const reservation = leftStack?.querySelector<HTMLElement>(':scope > [data-feed-activity-reservation="true"]');
      const reservationHeight = reservation?.getBoundingClientRect().height ?? 0;
      const rowGap = leftStack ? Number.parseFloat(getComputedStyle(leftStack).rowGap) || 0 : 0;
      const visibleLeftHeight = reservation
        ? Math.max(0, leftHeight - reservationHeight - (leftHeight > reservationHeight ? rowGap : 0))
        : leftHeight;
      onVisibleHeightChange?.(Math.ceil(Math.max(visibleLeftHeight, rightHeight)));
      onRunwayHeightChange?.(Math.ceil(Math.max(leftHeight, rightHeight)));
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(reportHeight);
    if (leftStackRef.current) observer.observe(leftStackRef.current);
    if (rightStackRef.current) observer.observe(rightStackRef.current);
    return () => observer.disconnect();
  }, [activityVisibleHeight, onRunwayHeightChange, onVisibleHeightChange, sessionId]);

  return (
    <>
      <div
        ref={leftStackRef}
        data-testid="feed-status-pill-left"
        data-feed-floating-stack="left"
        className="pointer-events-none absolute bottom-2 left-2 z-10 flex max-w-[calc(100vw-1rem)] flex-col items-start gap-1.5 sm:bottom-3 sm:left-3"
      >
        <CodexTurnRecoveryChip
          sessionId={sessionId}
          currentThreadKey={currentThreadKey}
          onSelectThread={onSelectThread}
        />
        <CodexProviderRetryChip sessionId={sessionId} />
        <RecoverableConnectionChip sessionId={sessionId} />
        <ElapsedTimer
          sessionId={sessionId}
          variant="floating"
          currentThreadKey={currentThreadKey}
          onSelectThread={onSelectThread}
          onVisibleHeightChange={setActivityVisibleHeight}
          preserveFloatingRowWhenHidden
        />
      </div>
      <div
        ref={rightStackRef}
        data-testid="feed-status-pill-right"
        data-feed-floating-stack="right"
        className="pointer-events-none absolute bottom-2 right-2 z-10 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3"
      >
        <TimerChip sessionId={sessionId} />
        <NotificationChip sessionId={sessionId} currentThreadKey={currentThreadKey} onSelectThread={onSelectThread} />
      </div>
    </>
  );
}

function formatActiveTurnLabel(
  activeTurnRoute: ActiveTurnRoute | null | undefined,
  currentThreadKey: string,
  context: {
    isLeaderSession: boolean;
    isReviewerSession: boolean;
    claimedQuestId?: string | null;
    reviewedQuestId?: string | null;
  },
): string {
  if (context.isLeaderSession) {
    if (!activeTurnRoute) return "Purring...";
    if (normalizeThreadKey(activeTurnRoute.threadKey) === normalizeThreadKey(currentThreadKey)) return "Active here";
    return `Active in ${activeTurnRoute.questId ?? activeTurnRoute.threadKey}`;
  }

  if (context.isReviewerSession) {
    const activeQuestId = questIdFromRoute(activeTurnRoute);
    const reviewerQuestId =
      activeQuestId ?? normalizeQuestId(context.reviewedQuestId) ?? normalizeQuestId(context.claimedQuestId);
    return reviewerQuestId ? `Reviewing ${reviewerQuestId}` : "Purring...";
  }

  return "Purring...";
}

function leaderActiveTurnNavigationTarget(
  activeTurnRoute: ActiveTurnRoute | null | undefined,
  currentThreadKey: string,
  context: { isLeaderSession: boolean },
): string | null {
  if (!context.isLeaderSession || !activeTurnRoute?.threadKey) return null;
  const targetThreadKey = normalizeThreadKey(activeTurnRoute.threadKey);
  if (!targetThreadKey) return null;
  if (targetThreadKey === normalizeThreadKey(currentThreadKey)) return null;
  return targetThreadKey;
}

function findReviewedQuestId(
  sessionId: string,
  sdkSessions: SdkSessionInfo[],
  sessions: Map<string, SessionState>,
): string | null {
  const reviewer = sdkSessions.find((session) => session.sessionId === sessionId);
  if (reviewer?.reviewerOf === undefined) return null;

  const reviewed = sdkSessions.find((session) => session.sessionNum === reviewer.reviewerOf);
  if (!reviewed) return null;

  return (
    normalizeQuestId(reviewed.claimedQuestId) ?? normalizeQuestId(sessions.get(reviewed.sessionId)?.claimedQuestId)
  );
}

function questIdFromRoute(activeTurnRoute: ActiveTurnRoute | null | undefined): string | null {
  if (!activeTurnRoute) return null;
  return normalizeQuestId(activeTurnRoute.questId) ?? normalizeQuestId(activeTurnRoute.threadKey);
}

function normalizeQuestId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^q-\d+$/.test(trimmed) ? trimmed : null;
}

export function PendingCodexInputList({ sessionId, inputs }: { sessionId: string; inputs: PendingCodexInput[] }) {
  const restorations = useStore((state) => state.pendingUserUploadRestorations.get(sessionId));
  if (inputs.length === 0) return null;

  const failedCount = inputs.filter((input) => input.deliveryState === "failed").length;
  const label =
    failedCount === inputs.length ? "Delivery failed" : failedCount > 0 ? "Message delivery" : "Pending delivery";

  return (
    <div className="space-y-2" data-feed-block-id={getFooterFeedBlockId("pending-codex-inputs")}>
      <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-cc-muted/60">
        <span>{label}</span>
      </div>
      <div className="flex flex-col gap-2">
        {inputs.map((input) => {
          const preview = formatReplyContentForPreview(input.content, input.replyContext).trim().replace(/\s+/g, " ");
          const truncated = preview.length > 120 ? `${preview.slice(0, 120)}...` : preview;
          const failed = input.deliveryState === "failed";
          const restoration = input.clientMsgId ? restorations?.get(input.clientMsgId) : undefined;
          const localImages = restoration?.images.flatMap((image) =>
            image.prepared
              ? [
                  {
                    imageId: image.prepared.imageRef.imageId,
                    name: image.name,
                    base64: image.base64,
                    mediaType: image.mediaType,
                  },
                ]
              : [],
          );
          const previewItems = input.imageRefs?.length
            ? buildUserImagePreviewItems(
                {
                  id: `pending-codex-${input.id}`,
                  role: "user",
                  content: input.content,
                  timestamp: input.timestamp,
                  images: input.imageRefs,
                  ...(localImages?.length ? { localImages } : {}),
                },
                sessionId,
              )
            : [];
          const canEdit = Boolean(restoration);
          return (
            <div
              key={input.id}
              data-feed-block-id={getPendingCodexFeedBlockId(input.id)}
              data-delivery-state={failed ? "failed" : "pending"}
              className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm text-cc-fg ${
                failed ? "border-cc-error/25 bg-cc-error/8" : "border-amber-500/20 bg-amber-500/8"
              }`}
            >
              <span
                className={`inline-flex h-2 w-2 shrink-0 rounded-full ${failed ? "bg-cc-error" : "bg-cc-attention"}`}
              />
              <div className="min-w-0 flex-1" title={preview || "Pending message"}>
                <span className="block truncate">{truncated || "Pending message"}</span>
                {failed && (
                  <span className="block truncate text-xs text-cc-error/90">
                    {input.failureMessage || "Codex rejected this input before delivery."}
                  </span>
                )}
                {previewItems.length ? (
                  <ImagePreviewGroup
                    images={previewItems}
                    className="!mt-1 !gap-1 !pb-0"
                    testId={`pending-codex-image-preview-group-${input.id}`}
                    size="small"
                  />
                ) : null}
              </div>
              {failed ? (
                <>
                  <button
                    type="button"
                    disabled={!input.cancelable}
                    onClick={() => sendToSession(sessionId, { type: "retry_pending_codex_input", id: input.id })}
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      input.cancelable
                        ? "border-cc-primary/30 text-cc-primary hover:bg-cc-hover cursor-pointer"
                        : "border-cc-border text-cc-muted/40 cursor-not-allowed"
                    }`}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    disabled={!input.cancelable}
                    onClick={() => sendToSession(sessionId, { type: "cancel_pending_codex_input", id: input.id })}
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      input.cancelable
                        ? "border-cc-border text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                        : "border-cc-border text-cc-muted/40 cursor-not-allowed"
                    }`}
                    title={
                      canEdit ? "Cancel delivery and restore this message to the composer" : "Cancel failed delivery"
                    }
                  >
                    {canEdit ? "Edit" : "Cancel"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!input.cancelable}
                  onClick={() => sendToSession(sessionId, { type: "cancel_pending_codex_input", id: input.id })}
                  className={`shrink-0 rounded-full p-1 transition-colors ${
                    input.cancelable
                      ? "text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                      : "text-cc-muted/40 cursor-not-allowed"
                  }`}
                  title={input.cancelable ? "Cancel pending message" : "Pending message is already being delivered"}
                  aria-label={
                    input.cancelable ? "Cancel pending message" : "Pending message is already being delivered"
                  }
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PendingUserUploadList({
  sessionId,
  uploads,
  showTimestamp = true,
  questLinkSurface = "legacy",
}: {
  sessionId: string;
  uploads: PendingUserUpload[];
  showTimestamp?: boolean;
  questLinkSurface?: QuestLinkSurface;
}) {
  if (uploads.length === 0) return null;

  const label = uploads.every((upload) => upload.stage === "failed") ? "Delivery failed" : "Pending delivery";
  return (
    <div className="space-y-2" data-feed-block-id={getFooterFeedBlockId("pending-user-uploads")}>
      <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-cc-muted/60">
        <span>{label}</span>
      </div>
      <div className="flex flex-col gap-3">
        {uploads.map((upload) => {
          const msg: ChatMessage = {
            id: `pending-upload-${upload.id}`,
            role: "user",
            content: upload.content,
            localImages: upload.images.map(({ name, base64, mediaType }) => ({
              name,
              base64,
              mediaType,
            })),
            timestamp: upload.timestamp,
            ...(upload.annotations?.length ||
            upload.vscodeSelection ||
            upload.replyContext ||
            upload.threadKey ||
            upload.questId
              ? {
                  metadata: {
                    ...(upload.annotations?.length ? { annotations: upload.annotations } : {}),
                    ...(upload.replyContext ? { replyContext: upload.replyContext } : {}),
                    ...(upload.vscodeSelection ? { vscodeSelection: upload.vscodeSelection } : {}),
                    ...(upload.threadKey ? { threadKey: upload.threadKey } : {}),
                    ...(upload.questId ? { questId: upload.questId } : {}),
                  },
                }
              : {}),
            ephemeral: true,
            pendingState: upload.stage === "delivering" ? "delivering" : "failed",
            pendingError: upload.error,
            clientMsgId: upload.id,
          };

          const handleRestoreToDraft = () => {
            const store = useStore.getState();
            store.removePendingUserUpload(sessionId, upload.id);
            store.setComposerDraft(sessionId, {
              text: upload.content,
              images: upload.images,
              annotations: upload.annotations,
            });
            store.setReplyContext(sessionId, upload.replyContext ?? null);
            store.focusComposer();
          };

          const handleRetry = () => {
            if (!upload.prepared) return;
            const sent = sendToSession(sessionId, {
              type: "user_message",
              content: upload.content,
              deliveryContent: upload.prepared.deliveryContent,
              imageRefs: upload.prepared.imageRefs,
              ...(upload.annotations?.length ? { annotations: upload.annotations } : {}),
              ...(upload.replyContext ? { replyContext: upload.replyContext } : {}),
              ...(upload.vscodeSelection ? { vscodeSelection: upload.vscodeSelection } : {}),
              ...(upload.threadKey ? { threadKey: upload.threadKey } : {}),
              ...(upload.questId ? { questId: upload.questId } : {}),
              session_id: sessionId,
              client_msg_id: upload.id,
              inputSource: "composer",
            });
            useStore
              .getState()
              .updatePendingUserUpload(sessionId, upload.id, (current) =>
                sent
                  ? { ...current, stage: "delivering", error: undefined }
                  : { ...current, stage: "failed", error: "Connection lost before delivery." },
              );
          };

          return (
            <div key={upload.id} className="space-y-1.5">
              <MessageBubble
                message={msg}
                sessionId={sessionId}
                showTimestamp={showTimestamp}
                questLinkSurface={questLinkSurface}
              />
              <div className="flex justify-end gap-2 pr-10 text-xs">
                {upload.stage === "failed" && (
                  <>
                    {upload.prepared && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        className="rounded-full border border-cc-primary/30 bg-cc-card px-3 py-1 text-cc-primary transition-colors hover:bg-cc-hover cursor-pointer"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleRestoreToDraft}
                      className="rounded-full border border-cc-border bg-cc-card px-3 py-1 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
