import { useMemo, useCallback } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { useStore } from "../store.js";
import { copyRichText, writeClipboardText } from "../utils/copy-utils.js";
import { htmlFragmentToMarkdown, htmlFragmentToRichText } from "../utils/html-to-markdown.js";
import type { TextSelectionState } from "../hooks/useTextSelection.js";

interface SelectionContextMenuProps {
  selection: TextSelectionState;
  sessionId: string;
  onClose: () => void;
}

export function formatSelectedTextAsBlockquote(text: string): string | null {
  const selectedText = text.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (!selectedText.trim()) return null;

  return selectedText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Floating context menu shown when the user selects text in an assistant message.
 * Offers "Quote selected" (injects blockquote into composer) and a "Copy" submenu
 * with three formats: rich text, markdown, and plain text.
 */
export function SelectionContextMenu({ selection, sessionId, onClose }: SelectionContextMenuProps) {
  const handleQuote = useCallback(() => {
    const blockquote = formatSelectedTextAsBlockquote(selection.plainText);
    if (!blockquote) return;

    const store = useStore.getState();
    const currentDraft = store.composerDrafts.get(sessionId);
    const currentText = currentDraft?.text ?? "";
    const separator = currentText.length > 0 ? "\n\n" : "";
    const newText = currentText + separator + blockquote + "\n\n";

    store.setComposerDraft(sessionId, {
      ...currentDraft,
      text: newText,
      images: currentDraft?.images ?? [],
    });

    // Signal the Composer to focus
    store.focusComposer();

    // Clear both the menu and the browser selection
    selection.clear();
    onClose();
  }, [selection, sessionId, onClose]);

  const handleComment = useCallback(() => {
    if (!selection.plainText.trim()) return;
    const node = selection.range?.startContainer;
    const element = node instanceof Element ? node : node?.parentElement;
    const sourceMessageId = element?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    useStore.getState().setAnnotationEditor({
      sessionId,
      annotation: {
        id: crypto.randomUUID(),
        selectedText: selection.plainText,
        comment: "",
        ...(sourceMessageId ? { sourceMessageId } : {}),
      },
      ...(selection.position ? { position: selection.position } : {}),
    });
    selection.clear();
    onClose();
  }, [selection, sessionId, onClose]);

  const handleCopyRichText = useCallback(() => {
    if (!selection.range) return;
    try {
      const { html, plainText } = htmlFragmentToRichText(selection.range);
      copyRichText(html, plainText).catch((e) => console.error("Failed to copy rich text:", e));
    } catch (e) {
      // Range may have become stale if the DOM re-rendered since selection
      console.error("Selection range became invalid:", e);
    }
    onClose();
  }, [selection, onClose]);

  const handleCopyMarkdown = useCallback(() => {
    if (!selection.range) return;
    try {
      const markdown = htmlFragmentToMarkdown(selection.range);
      writeClipboardText(markdown).catch((e) => console.error("Failed to copy markdown:", e));
    } catch (e) {
      console.error("Selection range became invalid:", e);
    }
    onClose();
  }, [selection, onClose]);

  const handleCopyPlainText = useCallback(() => {
    writeClipboardText(selection.plainText).catch((e) => console.error("Failed to copy plain text:", e));
    onClose();
  }, [selection, onClose]);

  const items = useMemo<ContextMenuItem[]>(
    () => [
      { label: "Quote selected", onClick: handleQuote },
      { label: "Comment", onClick: handleComment },
      {
        label: "Copy",
        onClick: () => {},
        children: [
          { label: "Rich text", onClick: handleCopyRichText },
          { label: "Markdown", onClick: handleCopyMarkdown },
          { label: "Plain text", onClick: handleCopyPlainText },
        ],
      },
    ],
    [handleQuote, handleComment, handleCopyRichText, handleCopyMarkdown, handleCopyPlainText],
  );

  if (!selection.isActive || !selection.position) return null;

  return <ContextMenu x={selection.position.x} y={selection.position.y} items={items} onClose={onClose} />;
}
