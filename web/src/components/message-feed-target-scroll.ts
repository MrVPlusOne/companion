import type { FeedViewportPosition } from "../utils/thread-viewport.js";
import { persistLeaderViewportPosition } from "../utils/thread-viewport.js";

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function findMessageFeedScrollTarget(container: HTMLDivElement, messageId: string): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>(`[data-message-id="${escapeSelectorValue(messageId)}"]`) ??
    container.querySelector<HTMLElement>(`[data-feed-block-id="tool-group:${escapeSelectorValue(messageId)}"]`)
  );
}

export function scrollMessageFeedTargetIntoView({
  container,
  target,
  targetMessageId,
  targetTurnId,
  sessionId,
  threadKey,
  viewportKey,
  isLeaderSession,
  lastSeenContentBottom,
  getRealContentBottom,
  markProgrammaticScroll,
  setShowScrollButton,
  setAutoFollowEnabled,
  setFeedScrollPosition,
  refs,
}: {
  container: HTMLDivElement;
  target: HTMLElement;
  targetMessageId: string;
  targetTurnId: string;
  sessionId: string;
  threadKey: string;
  viewportKey: string;
  isLeaderSession: boolean;
  lastSeenContentBottom: number | null;
  getRealContentBottom: () => number | null;
  markProgrammaticScroll: (top: number) => void;
  setShowScrollButton: (show: boolean) => void;
  setAutoFollowEnabled: (enabled: boolean) => void;
  setFeedScrollPosition: (viewportKey: string, position: FeedViewportPosition) => void;
  refs: {
    lastScrollTop: { current: number };
    isNearBottom: { current: boolean };
  };
}): FeedViewportPosition {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const visibleTargetHeight = Math.min(targetRect.height, container.clientHeight);
  const targetOffsetTop = Math.max(0, Math.round((container.clientHeight - visibleTargetHeight) / 2));
  const nextTop = container.scrollTop + targetRect.top - containerRect.top - targetOffsetTop;
  markProgrammaticScroll(nextTop);
  container.scrollTop = nextTop;
  refs.lastScrollTop.current = container.scrollTop;
  setAutoFollowEnabled(false);
  refs.isNearBottom.current = false;
  setShowScrollButton(true);

  const settledTargetRect = target.getBoundingClientRect();
  const position: FeedViewportPosition = {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    isAtBottom: false,
    anchorMessageId: targetMessageId,
    anchorTurnId: targetTurnId,
    anchorOffsetTop: settledTargetRect.top - containerRect.top,
    lastSeenContentBottom: lastSeenContentBottom ?? getRealContentBottom(),
  };
  setFeedScrollPosition(viewportKey, position);
  if (isLeaderSession) persistLeaderViewportPosition(sessionId, threadKey, position);
  return position;
}
