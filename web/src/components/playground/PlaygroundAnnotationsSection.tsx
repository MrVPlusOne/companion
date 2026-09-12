import { ComposerMinimizer } from "../ComposerMinimizer.js";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store.js";
import { useTextSelection } from "../../hooks/useTextSelection.js";
import { SelectionContextMenu } from "../SelectionContextMenu.js";
import { ComposerAnnotations } from "../ComposerAnnotations.js";
import { AnnotationSourceMarkers } from "../AnnotationAttachments.js";
import { MessageBubble } from "../MessageBubble.js";
import type { ChatMessage } from "../../types.js";
import { formatAnnotatedMessage } from "../../../shared/conversation-annotations.js";

const SESSION = "playground-conversation-annotations";
const QUOTE = "The cache expires after one hour.\nA background refresh keeps the result current.";

export function PlaygroundAnnotationsSection() {
  const root = useRef<HTMLDivElement>(null);
  const selection = useTextSelection(root);
  const draft = useStore((state) => state.composerDrafts.get(SESSION));
  const [sent, setSent] = useState<ChatMessage | null>(null);
  useEffect(() => {
    useStore.getState().setComposerDraft(SESSION, {
      text: "Please explain both points before changing anything.",
      images: [],
      annotations: [
        {
          id: "cache-comment",
          selectedText: "The cache expires after one hour.",
          comment: "Could this be configurable?",
          sourceMessageId: "annotation-example",
        },
        {
          id: "refresh-comment",
          selectedText: "A background refresh keeps the result current.",
          comment: "What happens when the refresh fails?",
          sourceMessageId: "annotation-example",
        },
      ],
    });
    return () => {
      useStore.getState().clearComposerDraft(SESSION);
    };
  }, []);
  return (
    <section
      id="interactive-conversation-annotations"
      className="space-y-4 scroll-mt-24"
      data-testid="playground-annotations"
    >
      <h2 className="text-lg font-semibold">Conversation annotations</h2>
      <p className="text-sm text-cc-muted">
        Select a passage to comment. Hover a comment chip or floating marker to see its passage and preview; minimize
        the draft to read more of the feed. This preview changes only local fixture state.
      </p>
      <div ref={root} className="rounded-2xl border border-cc-border bg-cc-card p-4 space-y-4">
        <div className="relative" data-message-id="annotation-example" data-message-role="assistant">
          <div data-chat-selection-scope="true" className="whitespace-pre-wrap text-sm">
            {QUOTE}
          </div>
          <AnnotationSourceMarkers sessionId={SESSION} messageId="annotation-example" />
        </div>
        <SelectionContextMenu selection={selection} sessionId={SESSION} onClose={selection.dismiss} />
        <ComposerMinimizer destination={SESSION}>
          <div className="rounded-2xl border border-cc-border bg-cc-input-bg p-3">
            <img
              alt="Example attached image"
              src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90'%3E%3Crect width='120' height='90' rx='8' fill='%233b4252'/%3E%3Cpath d='M12 72l30-28 22 18 24-36 20 46z' fill='%2388a6ac'/%3E%3C/svg%3E"
              className="mb-2 h-24 rounded-lg border border-cc-border"
            />
            <ComposerAnnotations sessionId={SESSION} threadKey="main" />
            <textarea
              aria-label="Annotation main message"
              className="w-full bg-transparent p-2 text-sm outline-none"
              value={draft?.text ?? ""}
              onChange={(event) =>
                useStore.getState().setComposerDraft(SESSION, { ...draft, text: event.target.value, images: [] })
              }
            />
            <button
              type="button"
              className="rounded-lg bg-cc-primary px-3 py-2 text-sm text-white"
              onClick={() =>
                setSent({
                  id: "stored-annotation-example",
                  role: "user",
                  content: draft?.text ?? "",
                  timestamp: 1,
                  metadata: { annotations: draft?.annotations },
                })
              }
            >
              Preview sent attachments
            </button>
          </div>
        </ComposerMinimizer>
        {sent && <MessageBubble message={sent} interactionMode="read-only" />}
        <details className="text-xs text-cc-muted">
          <summary className="cursor-pointer">Agent message preview</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">
            {formatAnnotatedMessage(draft?.text ?? "", draft?.annotations)}
          </pre>
        </details>
      </div>
    </section>
  );
}
