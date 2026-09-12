import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { useStore } from "../store.js";

/** Structured attachment previews; ordinary message text is never parsed as attachment syntax. */
export function AnnotationAttachments({
  annotations,
  onEdit,
  onRemove,
}: {
  annotations: readonly ConversationAnnotation[];
  onEdit?: (annotation: ConversationAnnotation, position: { x: number; y: number }) => void;
  onRemove?: (id: string) => void;
}) {
  if (!annotations.length) return null;
  return (
    <div className="flex flex-wrap gap-2 py-1" data-testid="annotation-attachments">
      {annotations.map((annotation, index) => (
        <details
          key={annotation.id}
          className="group/annotation min-w-0 max-w-full rounded-xl border border-cc-border bg-cc-hover/60 text-sm"
        >
          <summary className="cursor-pointer select-none px-3 py-2 text-cc-fg" aria-label={`Comment ${index + 1}`}>
            Comment {index + 1}
          </summary>
          <div className="max-h-80 max-w-lg space-y-3 overflow-auto border-t border-cc-border p-3">
            <blockquote className="whitespace-pre-wrap break-words border-l-2 border-cc-primary/60 pl-3 text-cc-muted">
              {annotation.selectedText}
            </blockquote>
            <p className="whitespace-pre-wrap break-words">{annotation.comment}</p>
            {(onEdit || onRemove) && (
              <div className="flex gap-3 text-xs">
                {onEdit && (
                  <button
                    type="button"
                    className="cursor-pointer text-cc-primary"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      onEdit(annotation, { x: rect.left, y: rect.top });
                    }}
                  >
                    Edit comment {index + 1}
                  </button>
                )}
                {onRemove && (
                  <button
                    type="button"
                    className="cursor-pointer text-cc-muted hover:text-red-400"
                    onClick={() => onRemove(annotation.id)}
                  >
                    Remove comment {index + 1}
                  </button>
                )}
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/** Draft markers remain attached to source message identity when the feed is windowed. */
export function AnnotationSourceMarkers({ sessionId, messageId }: { sessionId?: string; messageId: string }) {
  const annotations = useStore((state) => (sessionId ? state.composerDrafts.get(sessionId)?.annotations : undefined));
  if (!sessionId || !annotations?.some((annotation) => annotation.sourceMessageId === messageId)) return null;
  return (
    <div className="flex gap-1 py-1" aria-label="Comments on this message">
      {annotations.map(
        (annotation, index) =>
          annotation.sourceMessageId === messageId && (
            <button
              key={annotation.id}
              type="button"
              aria-label={`Edit comment ${index + 1}`}
              className="h-7 min-w-7 cursor-pointer rounded-full border border-cc-primary/50 bg-cc-primary/15 px-2 text-xs text-cc-primary"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                useStore
                  .getState()
                  .setAnnotationEditor({ sessionId, annotation, position: { x: rect.left, y: rect.top } });
              }}
            >
              {index + 1}
            </button>
          ),
      )}
    </div>
  );
}
