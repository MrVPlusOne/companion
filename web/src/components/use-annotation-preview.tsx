import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { useStore } from "../store.js";

/** One hover/focus preview owns its highlight and can be entered to scroll long comments. */
export function useAnnotationPreview(annotation: ConversationAnnotation, number: number, sessionId?: string) {
  const owner = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const close = useCallback(() => {
    setAnchor(null);
    const state = useStore.getState();
    if (state.annotationHover?.owner === owner) state.setAnnotationHover(null);
  }, [owner]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const state = useStore.getState();
      if (state.annotationHover?.owner === owner) state.setAnnotationHover(null);
    },
    [owner, annotation.id, sessionId],
  );
  useEffect(() => {
    if (!anchor) return;
    const scroll = (event: Event) => {
      if (!card.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);
  const show = (event: SyntheticEvent<HTMLElement>) => {
    if ("pointerType" in event && event.pointerType === "touch") return;
    if (useStore.getState().annotationEditor?.annotation.id === annotation.id) return;
    cancelHide();
    setAnchor(event.currentTarget);
    if (sessionId) useStore.getState().setAnnotationHover({ sessionId, annotationId: annotation.id, owner });
  };
  const hide = () => {
    cancelHide();
    timer.current = setTimeout(close, 120);
  };
  const rect = anchor?.getBoundingClientRect();
  const width = rect ? Math.min(340, window.innerWidth - 16) : 0;
  const above = rect ? window.innerHeight - rect.bottom < Math.min(240, rect.top) : false;
  const preview =
    rect && anchor?.isConnected
      ? createPortal(
          <div
            ref={card}
            id={owner}
            role="tooltip"
            onPointerEnter={cancelHide}
            onPointerLeave={hide}
            onFocus={cancelHide}
            onBlur={hide}
            tabIndex={0}
            style={{
              position: "fixed",
              width,
              left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
              ...(above ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
              maxHeight: Math.max(40, Math.min(280, above ? rect.top - 16 : window.innerHeight - rect.bottom - 16)),
            }}
            className="z-[1300] space-y-2 overflow-auto rounded-xl border border-cc-border bg-cc-card p-3 text-sm text-cc-fg shadow-xl"
          >
            <div className="text-xs font-medium text-cc-muted">Comment {number}</div>
            <blockquote className="whitespace-pre-wrap break-words border-l-2 border-cc-primary/60 pl-2 text-cc-muted">
              {annotation.selectedText}
            </blockquote>
            <p className="whitespace-pre-wrap break-words">{annotation.comment}</p>
          </div>,
          document.body,
        )
      : null;
  return {
    preview,
    close,
    triggerProps: {
      onPointerEnter: show,
      onPointerLeave: hide,
      onFocus: (event: SyntheticEvent<HTMLElement>) => {
        if (event.currentTarget.matches(":focus-visible")) show(event);
      },
      onBlur: hide,
      "aria-describedby": anchor ? owner : undefined,
    },
  };
}
