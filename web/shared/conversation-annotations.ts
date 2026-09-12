/** A saved user comment paired with the exact text selected from a conversation. */
export interface ConversationAnnotation {
  id: string;
  selectedText: string;
  comment: string;
  sourceMessageId?: string;
  /** Rendered-text offsets within one source Markdown scope; text verifies the anchor after remounts. */
  sourceAnchor?: { scopeIndex: number; start: number; end: number; text: string };
}

/** The original composer payload when annotations accompany a question answer. */
export interface AnnotationMessage {
  content: string;
  annotations: ConversationAnnotation[];
}

export function readAnnotationMessage(value: unknown): AnnotationMessage | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof (value as AnnotationMessage).content !== "string") {
    throw new Error("Invalid annotated answer.");
  }
  const message = value as AnnotationMessage;
  return { content: message.content, annotations: readConversationAnnotations(message.annotations) };
}

/** Validate attachment structure without changing the user's quotation or comment. */
export function readConversationAnnotations(value: unknown): ConversationAnnotation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Annotations must be an array.");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.selectedText !== "string" ||
      !entry.selectedText.trim() ||
      typeof entry.comment !== "string" ||
      !entry.comment.trim() ||
      (entry.sourceMessageId !== undefined && typeof entry.sourceMessageId !== "string")
    )
      throw new Error("Each annotation needs a unique ID, selected text, and a comment.");
    ids.add(entry.id);
    const anchor = entry.sourceAnchor;
    if (
      anchor !== undefined &&
      (!anchor ||
        !Number.isSafeInteger(anchor.scopeIndex) ||
        anchor.scopeIndex < 0 ||
        !Number.isSafeInteger(anchor.start) ||
        anchor.start < 0 ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.end <= anchor.start ||
        typeof anchor.text !== "string" ||
        anchor.text.length !== anchor.end - anchor.start)
    )
      throw new Error("Invalid annotation source anchor.");
    return {
      id: entry.id,
      selectedText: entry.selectedText,
      comment: entry.comment,
      ...(entry.sourceMessageId !== undefined ? { sourceMessageId: entry.sourceMessageId } : {}),
      ...(anchor
        ? { sourceAnchor: { scopeIndex: anchor.scopeIndex, start: anchor.start, end: anchor.end, text: anchor.text } }
        : {}),
    };
  });
}

/** Format the agent-facing user message; attachment identity stays in structured metadata. */
export function formatAnnotatedMessage(content: string, annotations?: readonly ConversationAnnotation[]): string {
  if (!annotations?.length) return content;
  const comments = annotations
    .map(
      (annotation, index) =>
        `${annotation.selectedText
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n[comment ${index + 1}] ${annotation.comment}`,
    )
    .join("\n\n");
  return content.trim() ? `${comments}\n\n---\n${content}` : comments;
}
