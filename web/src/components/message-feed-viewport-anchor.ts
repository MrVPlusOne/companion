import type { FeedViewportPosition } from "../utils/thread-viewport.js";

export interface FeedViewportAnchor {
  messageId: string | null;
  turnId: string | null;
  /** Visual viewport pixels, preserved unchanged in saved anchor records. */
  offsetTop: number;
}

/** Convert visual rectangle distances using this element's actual vertical scale. */
export function getFeedViewportScale(container: HTMLElement, rect = container.getBoundingClientRect()): number {
  const style = getComputedStyle(container);
  let layoutHeight = style.height.endsWith("px") ? Number.parseFloat(style.height) : 0;
  if (layoutHeight > 0 && style.boxSizing !== "border-box") {
    for (const value of [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]) {
      layoutHeight += Number.parseFloat(value) || 0;
    }
  }
  // Computed height preserves fractional layout pixels that offsetHeight rounds
  // away. Detached/zero-layout fixtures can fall back without inventing zoom.
  if (!(layoutHeight > 0)) layoutHeight = container.offsetHeight || container.clientHeight;
  const scale = rect.height / layoutHeight;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Measure a feed element in the scroll container's layout coordinate system. */
export function getFeedElementScrollOffset(
  container: HTMLDivElement,
  element: HTMLElement,
  edge: "top" | "bottom",
  scale = getFeedViewportScale(container),
): number {
  const containerRect = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.height > 0 || rect[edge] !== containerRect.top) {
    return container.scrollTop + (rect[edge] - containerRect.top) / scale;
  }
  // Keep existing no-layout test behavior. In a painted feed, offsetTop may be
  // relative to a nested offsetParent and cannot supply the scroller origin.
  if (edge === "top") return element.offsetTop;
  return element.offsetTop + element.offsetHeight || container.scrollHeight;
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function findVisibleTurnAnchorInContainer(
  container: HTMLDivElement,
): Omit<FeedViewportAnchor, "messageId"> | null {
  const containerRect = container.getBoundingClientRect();
  const turns = container.querySelectorAll<HTMLElement>("[data-turn-id]");
  for (const turn of turns) {
    const rect = turn.getBoundingClientRect();
    if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
      return {
        turnId: turn.dataset.turnId ?? null,
        offsetTop: rect.top - containerRect.top,
      };
    }
  }
  return null;
}

export function findVisibleMessageAnchorInContainer(
  container: HTMLDivElement,
  messageId: string,
): FeedViewportAnchor | null {
  const target = container.querySelector<HTMLElement>(`[data-message-id="${escapeSelectorValue(messageId)}"]`);
  if (!target) return null;
  const containerRect = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return null;
  const turn = target.closest<HTMLElement>("[data-turn-id]");
  return {
    messageId,
    turnId: turn?.dataset.turnId ?? null,
    offsetTop: rect.top - containerRect.top,
  };
}

export function isSystemErrorMessageAnchor(container: HTMLDivElement, messageId: string): boolean {
  const target = container.querySelector<HTMLElement>(`[data-message-id="${escapeSelectorValue(messageId)}"]`);
  return target?.dataset.messageRole === "system" && target.dataset.messageVariant === "error";
}

export function findVisiblePreviousAnchorForPersistence({
  container,
  previousAnchorId,
  explicitTargetId,
}: {
  container: HTMLDivElement;
  previousAnchorId: string | null;
  explicitTargetId: string | null | undefined;
}): FeedViewportAnchor | null {
  if (!previousAnchorId) return null;
  if (isSystemErrorMessageAnchor(container, previousAnchorId) && explicitTargetId !== previousAnchorId) return null;
  return findVisibleMessageAnchorInContainer(container, previousAnchorId);
}

export function getViewportAnchorOffset(
  container: HTMLDivElement | null,
  position: FeedViewportPosition,
): number | null {
  if (!container) return null;
  const selector = position.anchorMessageId
    ? `[data-message-id="${escapeSelectorValue(position.anchorMessageId)}"]`
    : `[data-turn-id="${escapeSelectorValue(position.anchorTurnId ?? "")}"]`;
  const target = container.querySelector<HTMLElement>(selector);
  return target ? target.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
}

export function isViewportAnchorAtSavedOffset(
  container: HTMLDivElement | null,
  position: FeedViewportPosition,
): boolean {
  const currentOffset = getViewportAnchorOffset(container, position);
  const targetOffset = position.anchorOffsetTop ?? 0;
  return currentOffset != null && Math.abs(currentOffset - targetOffset) <= 3;
}

export function schedulePostLayoutViewportAnchorRestore({
  container,
  position,
  restore,
  isActive,
  onSettled,
}: {
  container: { current: HTMLDivElement | null };
  position: FeedViewportPosition;
  restore: (position: FeedViewportPosition) => boolean;
  isActive?: () => boolean;
  onSettled?: () => void;
}): void {
  requestAnimationFrame(() => {
    if (isActive?.() === false) return;
    const currentOffset = getViewportAnchorOffset(container.current, position);
    const targetOffset = position.anchorOffsetTop ?? 0;
    if (currentOffset != null && Math.abs(currentOffset - targetOffset) <= 3) {
      onSettled?.();
      return;
    }
    restore(position);
    requestAnimationFrame(() => {
      if (isActive?.() === false) return;
      restore(position);
      const settledOffset = getViewportAnchorOffset(container.current, position);
      if (settledOffset != null && Math.abs(settledOffset - targetOffset) <= 3) onSettled?.();
    });
  });
}

export function findVisibleFeedAnchorInContainer(container: HTMLDivElement): FeedViewportAnchor | null {
  const containerRect = container.getBoundingClientRect();
  const isOrdinaryViewportAnchor = (element: HTMLElement) =>
    !(element.dataset.messageRole === "system" && element.dataset.messageVariant === "error");
  const findFirstVisible = (selector: string) => {
    const elements = container.querySelectorAll<HTMLElement>(selector);
    for (const element of elements) {
      if (!isOrdinaryViewportAnchor(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        return { element, rect };
      }
    }
    return null;
  };

  const visibleMessage = findFirstVisible("[data-message-id]");
  if (visibleMessage) {
    const turn = visibleMessage.element.closest<HTMLElement>("[data-turn-id]");
    return {
      messageId: visibleMessage.element.dataset.messageId ?? null,
      turnId: turn?.dataset.turnId ?? null,
      offsetTop: visibleMessage.rect.top - containerRect.top,
    };
  }

  const visibleTurn = findFirstVisible("[data-turn-id]");
  if (!visibleTurn) return null;

  return {
    messageId: null,
    turnId: visibleTurn.element.dataset.turnId ?? null,
    offsetTop: visibleTurn.rect.top - containerRect.top,
  };
}
