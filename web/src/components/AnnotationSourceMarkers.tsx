import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { useStore } from "../store.js";
import { resolveAnnotationRange } from "./annotation-passages.js";
import { useAnnotationPreview } from "./use-annotation-preview.js";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Position {
  id: string;
  left: number;
  top: number;
  rects: Rect[];
}
const EMPTY: ConversationAnnotation[] = [];

/** Overlay source passages without rewriting Markdown, links, or the user's DOM selection. */
export function AnnotationSourceMarkers({
  sessionId,
  messageId,
  contentRef,
}: {
  sessionId?: string;
  messageId: string;
  contentRef?: RefObject<HTMLDivElement | null>;
}) {
  const annotations = useStore((state) =>
    sessionId ? (state.composerDrafts.get(sessionId)?.annotations ?? EMPTY) : EMPTY,
  );
  const editor = useStore((state) => (state.annotationEditor?.sessionId === sessionId ? state.annotationEditor : null));
  const highlightedId = useStore((state) =>
    state.annotationHover?.sessionId === sessionId ? state.annotationHover?.annotationId : undefined,
  );
  const entries = useMemo(
    () =>
      [
        ...annotations,
        ...(editor && !annotations.some((item) => item.id === editor.annotation.id) ? [editor.annotation] : []),
      ]
        .map((annotation, index) => ({ annotation, number: index + 1 }))
        .filter((entry) => entry.annotation.sourceMessageId === messageId),
    [annotations, editor, messageId],
  );
  const overlay = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const lastPositions = useRef("");
  useLayoutEffect(() => {
    const root = contentRef?.current ?? overlay.current?.parentElement;
    if (!root || !entries.length) return;
    let queued: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      queued = null;
      const bounds = root.getBoundingClientRect();
      const scale = root.offsetWidth ? bounds.width / root.offsetWidth || 1 : 1;
      const next = entries.map(({ annotation }) => {
        const range = resolveAnnotationRange(root, annotation);
        const rects = Array.from(range?.getClientRects?.() ?? [])
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({
            left: (Math.max(bounds.left, rect.left) - bounds.left) / scale,
            top: (rect.top - bounds.top) / scale,
            width: Math.max(0, Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left)) / scale,
            height: rect.height / scale,
          }))
          .filter((rect) => rect.width > 0);
        // Missing legacy anchors retain an inspectable marker without guessing a passage.
        const top = rects[0]?.top ?? Math.max(0, bounds.height / scale - 24);
        return {
          id: annotation.id,
          left: Math.max(0, (Math.min(bounds.right - 6, window.innerWidth - 24) - bounds.left) / scale),
          top,
          rects,
        };
      });
      next.sort((a, b) => a.top - b.top);
      for (let index = 1; index < next.length; index++)
        next[index].top = Math.max(next[index].top, next[index - 1].top + 22);
      const signature = JSON.stringify(next);
      if (signature === lastPositions.current) return;
      lastPositions.current = signature;
      setPositions(next);
    };
    const schedule = () => {
      if (queued === null) queued = setTimeout(measure, 0);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => !overlay.current?.contains(record.target))) schedule();
    });
    mutation.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (queued !== null) clearTimeout(queued);
    };
  }, [entries, contentRef]);
  if (!sessionId || !entries.length) return null;
  return (
    <div
      ref={overlay}
      data-annotation-overlay
      aria-label="Comments on this message"
      className="pointer-events-none absolute inset-0"
      style={{ margin: 0 }}
    >
      {entries.map(({ annotation, number }) => {
        const position = positions.find((item) => item.id === annotation.id);
        if (!position) return null;
        return (
          <div key={annotation.id}>
            {(highlightedId === annotation.id || editor?.annotation.id === annotation.id) &&
              position.rects.map((rect, index) => (
                <span
                  key={index}
                  data-testid="annotation-passage-highlight"
                  aria-hidden="true"
                  className="absolute rounded-sm bg-cc-primary/20 outline outline-1 outline-cc-primary/40"
                  style={rect}
                />
              ))}
            <PassageMarker annotation={annotation} number={number} sessionId={sessionId} position={position} />
          </div>
        );
      })}
    </div>
  );
}

function PassageMarker({
  annotation,
  number,
  sessionId,
  position,
}: {
  annotation: ConversationAnnotation;
  number: number;
  sessionId: string;
  position: Position;
}) {
  const { preview, triggerProps, close } = useAnnotationPreview(annotation, number, sessionId);
  return (
    <>
      <button
        type="button"
        {...triggerProps}
        aria-label={`Edit comment ${number}`}
        title={
          position.rects.length ? `Comment ${number}` : `Comment ${number}: quoted passage is not visible in this view`
        }
        className="pointer-events-auto absolute z-10 h-5 min-w-5 rounded-full border border-cc-primary/60 bg-cc-card px-1 text-[10px] text-cc-primary shadow-sm hover:bg-cc-hover"
        style={{ left: position.left, top: position.top }}
        onClick={(event) => {
          close();
          const rect = event.currentTarget.getBoundingClientRect();
          useStore.getState().setAnnotationEditor({ sessionId, annotation, position: { x: rect.left, y: rect.top } });
        }}
      >
        {number}
      </button>
      {preview}
    </>
  );
}
