import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { useAnnotationPreview } from "./use-annotation-preview.js";
export { AnnotationSourceMarkers } from "./AnnotationSourceMarkers.js";

/** Structured attachment previews; ordinary message text is never parsed as attachment syntax. */
export function AnnotationAttachments({
  annotations,
  onEdit,
  onRemove,
  sessionId,
}: {
  sessionId?: string;
  annotations: readonly ConversationAnnotation[];
  onEdit?: (annotation: ConversationAnnotation, position: { x: number; y: number }) => void;
  onRemove?: (id: string) => void;
}) {
  if (!annotations.length) return null;
  return (
    <div className="flex flex-wrap gap-2 py-1" data-testid="annotation-attachments">
      {annotations.map((annotation, index) => (
        <AnnotationAttachment
          key={annotation.id}
          annotation={annotation}
          number={index + 1}
          sessionId={sessionId}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}

function AnnotationAttachment({
  annotation,
  number,
  sessionId,
  onEdit,
  onRemove,
}: {
  annotation: ConversationAnnotation;
  number: number;
  sessionId?: string;
  onEdit?: (annotation: ConversationAnnotation, position: { x: number; y: number }) => void;
  onRemove?: (id: string) => void;
}) {
  const { preview, triggerProps, close } = useAnnotationPreview(annotation, number, sessionId);
  return (
    <>
      <details className="group/annotation min-w-0 max-w-full rounded-xl border border-cc-border bg-cc-hover/60 text-sm">
        <summary
          {...triggerProps}
          onClick={close}
          className="cursor-pointer select-none px-3 py-2 text-cc-fg"
          aria-label={`Comment ${number}`}
        >
          Comment {number}
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
                    close();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onEdit(annotation, { x: rect.left, y: rect.top });
                  }}
                >
                  Edit comment {number}
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="cursor-pointer text-cc-muted hover:text-red-400"
                  onClick={() => {
                    close();
                    onRemove(annotation.id);
                  }}
                >
                  Remove comment {number}
                </button>
              )}
            </div>
          )}
        </div>
      </details>
      {preview}
    </>
  );
}
