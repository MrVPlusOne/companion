import { formatAnnotatedMessage } from "../../shared/conversation-annotations.js";
import type { ChatMessage } from "../types.js";

/**
 * Extract the raw markdown text from an assistant message.
 * Joins all text content blocks, falling back to message.content.
 */
export function getMessageMarkdown(message: ChatMessage): string {
  const blocks = message.contentBlocks;
  if (blocks && blocks.length > 0) {
    const textParts = blocks.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text);
    if (textParts.length > 0) return textParts.join("\n\n");
  }
  return message.role === "user"
    ? formatAnnotatedMessage(message.content, message.metadata?.annotations)
    : message.content;
}

/**
 * Strip markdown syntax to produce plain text.
 */
export function getMessagePlainText(message: ChatMessage): string {
  const md = getMessageMarkdown(message);
  return markdownToPlainText(md);
}

/**
 * Strip markdown syntax from arbitrary markdown content.
 */
export function markdownToPlainText(markdown: string): string {
  return stripMarkdown(markdown);
}

/**
 * Remove common markdown formatting to produce readable plain text.
 */
function stripMarkdown(md: string): string {
  const protectedMath = protectMathSource(md);
  let text = protectedMath.text;
  // Remove fenced code block markers (``` lang ... ```)
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    // Keep the content inside, strip the fences
    const inner = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    return inner;
  });
  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");
  // Remove images ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Remove links [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  // Remove strikethrough
  text = text.replace(/~~([^~]+)~~/g, "$1");
  // Remove blockquote markers
  text = text.replace(/^>\s?/gm, "");
  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // Remove list markers (unordered)
  text = text.replace(/^[\t ]*[-*+]\s+/gm, "");
  // Remove list markers (ordered)
  text = text.replace(/^[\t ]*\d+\.\s+/gm, "");
  return protectedMath.restore(text.trim());
}

function protectMathSource(markdown: string): { text: string; restore: (value: string) => string } {
  const spans = findMathSourceSpans(markdown);
  const tokens: string[] = [];
  const chunks: string[] = [];
  let cursor = 0;

  for (const span of spans) {
    chunks.push(escapeMathPlaceholderNulls(markdown.slice(cursor, span.start)));
    const tokenIndex = tokens.push(markdown.slice(span.start, span.end)) - 1;
    chunks.push(`\0M${tokenIndex};`);
    cursor = span.end;
  }
  chunks.push(escapeMathPlaceholderNulls(markdown.slice(cursor)));

  return {
    text: chunks.join(""),
    restore: (value) => restoreMathPlaceholders(value, tokens),
  };
}

interface MathSourceSpan {
  start: number;
  end: number;
}

type OpenMathSource =
  | { kind: "backslash"; start: number; close: ")" | "]" }
  | { kind: "dollar"; start: number; size: number };

/** Find non-overlapping complete math tokens in one forward pass. */
function findMathSourceSpans(source: string): MathSourceSpan[] {
  const spans: MathSourceSpan[] = [];
  let open: OpenMathSource | null = null;
  let slashRun = 0;
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const precedingSlashRun = slashRun;

    if (character === "\\") {
      const escaped = precedingSlashRun % 2 === 1;
      const next = source[index + 1];
      if (open?.kind === "backslash" && !escaped && next === open.close) {
        spans.push({ start: open.start, end: index + 2 });
        open = null;
        slashRun = 0;
        index += 2;
        continue;
      }
      if (!open && !escaped && (next === "(" || next === "[")) {
        open = { kind: "backslash", start: index, close: next === "(" ? ")" : "]" };
        slashRun = 0;
        index += 2;
        continue;
      }

      slashRun += 1;
      index += 1;
      continue;
    }

    slashRun = 0;
    if (character !== "$" || precedingSlashRun % 2 === 1 || open?.kind === "backslash") {
      index += 1;
      continue;
    }

    let runSize = 1;
    while (source[index + runSize] === "$") runSize += 1;

    if (open?.kind === "dollar") {
      if (runSize === open.size) {
        const body = source.slice(open.start + open.size, index);
        const validSingle =
          open.size !== 1 ||
          (Boolean(body) && !/^\s/.test(body) && !/\s$/.test(body) && !/\d/.test(source[index + runSize] ?? ""));
        if (validSingle) spans.push({ start: open.start, end: index + runSize });
        open = null;
      }
      index += runSize;
      continue;
    }

    const next = source[index + runSize];
    if (runSize > 1 || (next && !/\s/.test(next))) open = { kind: "dollar", start: index, size: runSize };
    index += runSize;
  }

  return spans;
}

function escapeMathPlaceholderNulls(value: string): string {
  return value.replaceAll("\0", "\0\0");
}

function restoreMathPlaceholders(value: string, tokens: string[]): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] !== "\0") {
      result += value[index];
      index += 1;
      continue;
    }
    if (value[index + 1] === "\0") {
      result += "\0";
      index += 2;
      continue;
    }
    if (value[index + 1] === "M") {
      let cursor = index + 2;
      while (/\d/.test(value[cursor] ?? "")) cursor += 1;
      if (cursor > index + 2 && value[cursor] === ";") {
        const token = tokens[Number(value.slice(index + 2, cursor))];
        if (token != null) {
          result += token;
          index = cursor + 1;
          continue;
        }
      }
    }

    result += "\0";
    index += 1;
  }

  return result;
}

/**
 * Write text to clipboard with fallback for non-secure contexts (HTTP).
 * navigator.clipboard is undefined on iOS Safari over HTTP — falls back
 * to a temporary textarea + execCommand("copy").
 */
export function writeClipboardText(text: string): Promise<void> {
  const clipboard = typeof window !== "undefined" ? window.navigator.clipboard : globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    return clipboard.writeText(text);
  }
  // Legacy fallback: create a temporary textarea, select, and copy
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
  return Promise.resolve();
}

/**
 * Copy rich text (HTML) to clipboard using the Clipboard API.
 * Falls back to plain text if the ClipboardItem API is unavailable.
 */
export async function copyRichText(html: string, plainText: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
  } else {
    await writeClipboardText(plainText);
  }
}
