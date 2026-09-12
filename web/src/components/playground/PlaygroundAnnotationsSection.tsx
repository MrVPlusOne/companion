import { useComposerTextareaSize } from "../use-composer-textarea-size.js";
import { ComposerMinimizer, ComposerMinimizeButton, ComposerVisibilityContext } from "../ComposerMinimizer.js";
import { useContext, useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const editing = useStore((state) => state.annotationEditor?.sessionId === SESSION);
  const visible = expanded || editing;
  useEffect(() => {
    useStore.getState().setComposerDraft(SESSION, {
      text: "Please explain both points before changing anything.\nKeep this second line and the attachments when minimized.",
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
        Select a passage to comment. Click a chip to open its editor at the passage, or hover for a preview. Minimize
        the draft to read more of the feed: only its first line stays visible, and attachments return when you expand
        the input. This preview changes only local fixture state.
      </p>
      <div
        ref={root}
        data-annotation-preview-session={SESSION}
        className="rounded-2xl border border-cc-border bg-cc-card p-4 space-y-4"
      >
        <div className="relative" data-message-id="annotation-example" data-message-role="assistant">
          <div data-chat-selection-scope="true" className="whitespace-pre-wrap text-sm">
            {QUOTE}
          </div>
          <AnnotationSourceMarkers sessionId={SESSION} messageId="annotation-example" />
        </div>
        <SelectionContextMenu selection={selection} sessionId={SESSION} onClose={selection.dismiss} />
        <ComposerMinimizer destination={SESSION} expanded={visible} onExpandedChange={setExpanded}>
          <div className="rounded-2xl border border-cc-border bg-cc-input-bg">
            <div hidden={!visible}>
              <img
                alt="Example attached image"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90'%3E%3Crect width='120' height='90' rx='8' fill='%233b4252'/%3E%3Cpath d='M12 72l30-28 22 18 24-36 20 46z' fill='%2388a6ac'/%3E%3C/svg%3E"
                className="mb-2 h-24 rounded-lg border border-cc-border"
              />
              <ComposerAnnotations sessionId={SESSION} threadKey="main" />
            </div>
            <DraftTextarea
              aria-label="Annotation main message"
              value={draft?.text ?? ""}
              onChange={(event) =>
                useStore.getState().setComposerDraft(SESSION, { ...draft, text: event.target.value, images: [] })
              }
            />
            <div hidden={!visible}>
              <div className="flex items-center gap-2 p-2">
                <ComposerMinimizeButton disabled={editing} onClick={() => setExpanded(false)} />
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
            </div>
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

function DraftTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const expanded = useContext(ComposerVisibilityContext);
  useComposerTextareaSize(ref, String(props.value ?? ""));
  return (
    <div
      className={expanded ? "" : "px-4 py-2.5"}
      onClick={() => {
        if (!expanded) ref.current?.focus();
      }}
    >
      <textarea
        {...props}
        ref={ref}
        rows={1}
        wrap={expanded ? "soft" : "off"}
        aria-expanded={expanded}
        className={`block w-full bg-transparent text-sm outline-none resize-none ${expanded ? "px-4 py-2" : "p-0 leading-6 overflow-hidden"}`}
      />
    </div>
  );
}
