import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { htmlFragmentToPlainText, normalizeMathSelectionRange, rangeContainsMath } from "../utils/html-to-markdown.js";

export interface TextSelectionState {
  /** Whether there's an active, non-empty selection within an assistant message */
  isActive: boolean;
  /** The plain text of the selection */
  plainText: string;
  /** The selected Range clipped to eligible chat content for extracting HTML */
  range: Range | null;
  /** Position for the floating menu (x, y relative to viewport) */
  position: { x: number; y: number } | null;
  /** Clears the selection and resets state */
  clear: () => void;
  /** Hides Takode's selection menu without changing the browser selection */
  dismiss: () => void;
}

const EMPTY_STATE: Omit<TextSelectionState, "clear" | "dismiss"> = {
  isActive: false,
  plainText: "",
  range: null,
  position: null,
};

/** Walk up from a node to find the nearest ancestor with a `data-message-id` attribute. */
function findMessageAncestor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && current.dataset.messageId) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

interface SelectedTextBoundaryNodes {
  first: Text;
  last: Text;
}

/** Return the intersection between a Range and one node's contents. */
function intersectRangeWithNodeContents(range: Range, node: Node): Range | null {
  if (!range.intersectsNode(node)) return null;

  const document = node.nodeType === Node.DOCUMENT_NODE ? (node as Document) : node.ownerDocument;
  if (!document) return null;
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);

  const intersection = range.cloneRange();
  if (intersection.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
    intersection.setStart(nodeRange.startContainer, nodeRange.startOffset);
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
    intersection.setEnd(nodeRange.endContainer, nodeRange.endOffset);
  }

  return intersection.collapsed ? null : intersection;
}

/** Return the portion of one text node that is actually covered by a Range. */
function selectedTextWithinNode(range: Range, textNode: Text): string {
  return intersectRangeWithNodeContents(range, textNode)?.toString() ?? "";
}

function nextNodeWithin(root: Node, node: Node): Node | null {
  if (node.firstChild) return node.firstChild;

  let current: Node | null = node;
  while (current && current !== root) {
    if (current.nextSibling) return current.nextSibling;
    current = current.parentNode;
  }
  return null;
}

function previousNodeWithin(root: Node, node: Node): Node | null {
  if (node.previousSibling) {
    let current = node.previousSibling;
    while (current.lastChild) current = current.lastChild;
    return current;
  }

  const parent = node.parentNode;
  return parent && parent !== root ? parent : null;
}

function firstNodeAtRangeStart(range: Range, root: Node): Node | null {
  if (range.startContainer.nodeType === Node.TEXT_NODE) return range.startContainer;
  return range.startContainer.childNodes[range.startOffset] ?? nextNodeWithin(root, range.startContainer);
}

function lastNodeAtRangeEnd(range: Range, root: Node): Node | null {
  if (range.endContainer.nodeType === Node.TEXT_NODE) return range.endContainer;

  let current = range.endContainer.childNodes[range.endOffset - 1] ?? null;
  if (!current) return previousNodeWithin(root, range.endContainer);
  while (current.lastChild) current = current.lastChild;
  return current;
}

function findSubstantiveTextNode(range: Range, root: Node, fromStart: boolean): Text | null {
  let node = fromStart ? firstNodeAtRangeStart(range, root) : lastNodeAtRangeEnd(range, root);
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && selectedTextWithinNode(range, node as Text).trim()) {
      return node as Text;
    }
    node = fromStart ? nextNodeWithin(root, node) : previousNodeWithin(root, node);
  }
  return null;
}

/**
 * Resolve the first and last substantive text nodes selected by a canonical Range.
 *
 * Browser selection endpoints may sit on a wrapper element when the user selects a
 * complete paragraph/list block. Whitespace-only edge slices are ignored for scope
 * ownership, but the original Range and Selection text remain unchanged. Walking
 * inward from each boundary avoids scanning unrelated feed content for invalid spans.
 */
function findSelectedTextBoundaryNodes(range: Range): SelectedTextBoundaryNodes | null {
  const root = range.commonAncestorContainer;
  if (!root || !root.isConnected) return null;

  try {
    const first = findSubstantiveTextNode(range, root, true);
    const last = findSubstantiveTextNode(range, root, false);
    return first && last ? { first, last } : null;
  } catch {
    // Delayed touch evaluation can race with a Markdown subtree replacement.
    return null;
  }
}

function findSelectionMessage(selection: Selection, range: Range, container: HTMLElement): HTMLElement | null {
  const anchorMessage = findMessageAncestor(selection.anchorNode);
  const focusMessage = findMessageAncestor(selection.focusNode);
  let message = anchorMessage && anchorMessage === focusMessage ? anchorMessage : null;

  if (!message) {
    const boundaries = findSelectedTextBoundaryNodes(range);
    if (!boundaries) return null;
    const firstMessage = findMessageAncestor(boundaries.first);
    const lastMessage = findMessageAncestor(boundaries.last);
    message = firstMessage && firstMessage === lastMessage ? firstMessage : null;
  }

  if (!message || !container.contains(message) || message.dataset.messageRole !== "assistant") return null;
  return message;
}

/**
 * Find the one explicit chat Markdown scope that owns all substantive selected text.
 *
 * The returned Range is clipped to that scope so wrapper-level endpoints can include
 * textless message controls or images without leaking them into rich/Markdown copy.
 */
function findOwnedChatSelectionRange(sourceRange: Range, message: HTMLElement): Range | null {
  let ownedRange: Range | null = null;

  for (const scope of message.querySelectorAll<HTMLElement>('[data-chat-selection-scope="true"]')) {
    const intersection = intersectRangeWithNodeContents(sourceRange, scope);
    if (!intersection?.toString().trim()) continue;
    if (ownedRange) return null;
    ownedRange = intersection;
  }

  if (!ownedRange || sourceRange.toString().trim() !== ownedRange.toString().trim()) return null;
  return ownedRange;
}

/** Keep actions beside the selection, leaving room for native touch handles/callout. */
function computeMenuPosition(rect: DOMRect, touch: boolean): { x: number; y: number } {
  const width = 180;
  const height = 68;
  const gap = touch ? 56 : 6;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth);
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const x = Math.max(left + 8, Math.min(rect.left + rect.width / 2 - width / 2, right - width - 8));
  const above = rect.top - gap - height;
  const y = above >= top + 4 ? above : rect.bottom + gap;
  return { x, y: Math.max(top + 4, Math.min(y, bottom - height - 4)) };
}

/**
 * Detects text selection within assistant message content inside the given container.
 *
 * Returns selection state with position data for rendering a floating context menu.
 * Only activates for non-empty selections fully within a single assistant message.
 * On touch devices, delays evaluation to let the native selection UI finalize.
 */
export function useTextSelection(containerRef: RefObject<HTMLElement | null>): TextSelectionState {
  const [state, setState] = useState<Omit<TextSelectionState, "clear" | "dismiss">>(EMPTY_STATE);
  const rafRef = useRef<number>(0);
  const touchDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we should suppress the next selectionchange (after programmatic clear)
  const suppressRef = useRef(false);
  // Track mouse-down state so we only show the menu after mouseup, not mid-drag
  const mouseDownRef = useRef(false);
  // Track touch state so we only show the menu after touchend, not mid-drag
  const touchActiveRef = useRef(false);
  // Whether the current interaction started with touch (affects menu position)
  const isTouchInteractionRef = useRef(false);

  const suppressSelectionChanges = useCallback((callback: () => void) => {
    suppressRef.current = true;
    callback();
    requestAnimationFrame(() => {
      setTimeout(() => {
        suppressRef.current = false;
      }, 0);
    });
  }, []);

  const clear = useCallback(() => {
    setState(EMPTY_STATE);
    suppressSelectionChanges(() => {
      window.getSelection()?.removeAllRanges();
    });
  }, [suppressSelectionChanges]);

  const dismiss = useCallback(() => {
    setState(EMPTY_STATE);
  }, []);

  const container = containerRef.current;

  useEffect(() => {
    if (!container) return;

    function evaluateSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setState(EMPTY_STATE);
        return;
      }

      if (sel.rangeCount !== 1) {
        setState(EMPTY_STATE);
        return;
      }

      let sourceRange: Range;
      try {
        sourceRange = sel.getRangeAt(0);
      } catch {
        setState(EMPTY_STATE);
        return;
      }

      let ownedRange: Range | null;
      try {
        const message = findSelectionMessage(sel, sourceRange, container!);
        ownedRange = message ? findOwnedChatSelectionRange(sourceRange, message) : null;
      } catch {
        setState(EMPTY_STATE);
        return;
      }
      if (!ownedRange) {
        setState(EMPTY_STATE);
        return;
      }

      let containsMath: boolean;
      let range: Range;
      let rect: DOMRect;
      let plainText: string;
      try {
        containsMath = rangeContainsMath(ownedRange);
        range = containsMath ? normalizeMathSelectionRange(ownedRange) : ownedRange.cloneRange();
        rect =
          typeof ownedRange.getBoundingClientRect === "function"
            ? ownedRange.getBoundingClientRect()
            : sourceRange.getBoundingClientRect();
        plainText = containsMath ? htmlFragmentToPlainText(range) : sel.toString();
      } catch {
        // A delayed evaluation may observe a Range whose rendered nodes were replaced.
        setState(EMPTY_STATE);
        return;
      }

      if (rect.width === 0 && rect.height === 0) {
        setState(EMPTY_STATE);
        return;
      }

      const nextState = {
        isActive: true,
        plainText,
        range,
        position: computeMenuPosition(rect, isTouchInteractionRef.current),
      };

      setState(nextState);
    }

    function scheduleEvaluation() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(evaluateSelection);
    }

    // ─── Mouse handlers (desktop) ────────────────────────────────────
    function handleMouseDown() {
      mouseDownRef.current = true;
      isTouchInteractionRef.current = false;
    }

    function handleMouseUp() {
      mouseDownRef.current = false;
      scheduleEvaluation();
    }

    // ─── Touch handlers (iOS / mobile) ───────────────────────────────
    function handleTouchStart() {
      touchActiveRef.current = true;
      isTouchInteractionRef.current = true;
    }

    function handleTouchEnd() {
      touchActiveRef.current = false;
      // Delay evaluation to let iOS finalize the selection via native handles.
      // Without this, getSelection() may return stale or incomplete results.
      if (touchDelayRef.current) clearTimeout(touchDelayRef.current);
      touchDelayRef.current = setTimeout(scheduleEvaluation, 300);
    }

    // selectionchange fires during drag and after iOS handle adjustments.
    // Only evaluate after the pointer/touch is released.
    function handleSelectionChange() {
      if (suppressRef.current) return;
      if (mouseDownRef.current || touchActiveRef.current) return;
      scheduleEvaluation();
    }

    function handleScroll() {
      if (suppressRef.current) return;
      cancelAnimationFrame(rafRef.current);
      setState(EMPTY_STATE);
    }

    container.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("selectionchange", handleSelectionChange);
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("selectionchange", handleSelectionChange);
      container.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafRef.current);
      if (touchDelayRef.current) clearTimeout(touchDelayRef.current);
    };
  }, [container, suppressSelectionChanges]);

  return { ...state, clear, dismiss };
}
