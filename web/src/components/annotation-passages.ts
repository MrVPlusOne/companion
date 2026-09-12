import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";

const SCOPE = '[data-chat-selection-scope="true"]';

/** Capture the selected occurrence, including when the same words appear repeatedly in a message. */
export function captureAnnotationSource(
  range: Range | null,
): Pick<ConversationAnnotation, "sourceMessageId" | "sourceAnchor"> {
  if (!range) return {};
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const message = element?.closest<HTMLElement>("[data-message-id]");
  if (!message) return {};
  const sourceMessageId = message.dataset.messageId;
  const scopes = Array.from(message.querySelectorAll<HTMLElement>(SCOPE));
  const scopeIndex = scopes.findIndex(
    (scope) => scope.contains(range.startContainer) && scope.contains(range.endContainer),
  );
  if (scopeIndex < 0) return { sourceMessageId };
  const prefix = document.createRange();
  prefix.selectNodeContents(scopes[scopeIndex]);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const text = range.toString();
  return { sourceMessageId, ...(text ? { sourceAnchor: { scopeIndex, start, end: start + text.length, text } } : {}) };
}

/** Resolve only a verified occurrence; old annotations without offsets require a unique literal match. */
export function resolveAnnotationRange(root: HTMLElement, annotation: ConversationAnnotation): Range | null {
  const scopes = Array.from(root.querySelectorAll<HTMLElement>(SCOPE));
  const anchor = annotation.sourceAnchor;
  if (anchor) {
    const scope = scopes[anchor.scopeIndex];
    if (!scope || scope.textContent?.slice(anchor.start, anchor.end) !== anchor.text) return null;
    return textRange(scope, anchor.start, anchor.end);
  }
  let match: Range | null = null;
  for (const scope of scopes) {
    const text = scope.textContent ?? "";
    const start = text.indexOf(annotation.selectedText);
    if (start < 0) continue;
    if (match || text.indexOf(annotation.selectedText, start + 1) >= 0) return null;
    match = textRange(scope, start, start + annotation.selectedText.length);
  }
  return match;
}

function textRange(scope: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}
