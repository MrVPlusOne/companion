import { useAnnotationSourceNavigation } from "./use-annotation-source-navigation.js";
import { useEffect } from "react";
import { useStore } from "../store.js";
import { AnnotationAttachments } from "./AnnotationAttachments.js";
import { AnnotationEditor } from "./AnnotationEditor.js";

export function ComposerAnnotations({
  sessionId,
  threadKey,
  threadTitle,
  disabled = false,
}: {
  sessionId: string;
  threadKey: string;
  threadTitle?: string;
  disabled?: boolean;
}) {
  const openSource = useAnnotationSourceNavigation(sessionId, threadKey);
  const draft = useStore((state) => state.composerDrafts.get(sessionId));
  const editor = useStore((state) => state.annotationEditor);
  const annotations = draft?.annotations ?? [];
  const activeEditor =
    editor?.sessionId === sessionId && (!editor.threadKey || editor.threadKey === threadKey) ? editor : null;
  useEffect(
    () => () => {
      const state = useStore.getState();
      if (
        state.annotationEditor?.sessionId === sessionId &&
        (!state.annotationEditor.threadKey || state.annotationEditor.threadKey === threadKey)
      )
        state.setAnnotationEditor(null);
    },
    [sessionId, threadKey],
  );
  const remove = (id: string) => {
    const state = useStore.getState();
    const current = state.composerDrafts.get(sessionId);
    if (current)
      state.setComposerDraft(sessionId, {
        ...current,
        annotations: current.annotations?.filter((entry) => entry.id !== id),
      });
    if (state.annotationEditor?.annotation.id === id) state.setAnnotationEditor(null);
  };
  return (
    <>
      <AnnotationAttachments
        sessionId={sessionId}
        annotations={annotations}
        disabled={disabled}
        onEdit={(annotation) => void openSource(annotation)}
        onRemove={disabled ? undefined : remove}
      />
      {activeEditor?.navigateToSource && (
        <p role="status" className="text-xs text-cc-muted">
          Opening comment at its source…
        </p>
      )}
      {activeEditor && !activeEditor.navigateToSource && !disabled && (
        <AnnotationEditor
          key={`${sessionId}:${threadKey}:${activeEditor.annotation.id}`}
          sessionId={sessionId}
          threadKey={threadKey}
          threadTitle={threadTitle}
          annotation={activeEditor.annotation}
          position={activeEditor.position}
          sourceUnavailable={activeEditor.sourceUnavailable}
          context={{
            activeId: activeEditor.annotation.id,
            activeNumber: annotations.some((entry) => entry.id === activeEditor.annotation.id)
              ? annotations.findIndex((entry) => entry.id === activeEditor.annotation.id) + 1
              : annotations.length + 1,
            selectedText: activeEditor.annotation.selectedText,
            mainComposerText: draft?.text ?? "",
            otherAnnotations: annotations
              .map((entry, index) => ({ ...entry, number: index + 1 }))
              .filter((entry) => entry.id !== activeEditor.annotation.id),
          }}
          onCancel={() => useStore.getState().setAnnotationEditor(null)}
          onRemove={
            annotations.some((entry) => entry.id === activeEditor.annotation.id)
              ? () => remove(activeEditor.annotation.id)
              : undefined
          }
          onSave={(comment) => {
            const state = useStore.getState();
            const current = state.composerDrafts.get(sessionId) ?? { text: "", images: [] };
            const saved = { ...activeEditor.annotation, comment };
            const previous = current.annotations ?? [];
            state.setComposerDraft(sessionId, {
              ...current,
              annotations: previous.some((entry) => entry.id === saved.id)
                ? previous.map((entry) => (entry.id === saved.id ? saved : entry))
                : [...previous, saved],
            });
            state.setAnnotationEditor(null);
          }}
        />
      )}
    </>
  );
}
