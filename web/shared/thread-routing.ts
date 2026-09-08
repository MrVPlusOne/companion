import { isCanonicalLeaderAnswerMessageId } from "./leader-answer-message-id.js";

export type ThreadRouteTarget = {
  threadKey: string;
  questId?: string;
};

export type LeaderThreadTextRole = "commentary" | "answer";

export type ThreadRouteParseResult =
  | {
      ok: true;
      target: ThreadRouteTarget;
      role?: LeaderThreadTextRole;
      answerUserMessageIds?: string[];
      body: string;
    }
  | {
      ok: false;
      reason: "missing" | "invalid" | "invalid_role";
      marker?: string;
      body: string;
    };

const TEXT_THREAD_MARKER_RE =
  /^\[thread:(main|q-\d+)(?::(C)|:A:((?:u|timer-m)[1-9]\d*(?:,(?:u|timer-m)[1-9]\d*)*))?\](?=$|[ \t]|\r?\n)/i;
const TEXT_THREAD_MARKER_AT_LINE_START_RE =
  /^\[thread:(main|q-\d+)(?::(C)|:A:((?:u|timer-m)[1-9]\d*(?:,(?:u|timer-m)[1-9]\d*)*))?\]/i;
const TEXT_THREAD_DESTINATION_PREFIX_RE = /^\[thread:(main|q-\d+):/i;
const MARKDOWN_FENCE_RE = /^\s*(`{3,}|~{3,})/;
const COMMAND_THREAD_COMMENT_RE = /^#\s*thread:(main|q-\d+)\s*$/;
const QUEST_MENTION_RE = /\bq-\d+\b/gi;
const LEADING_QUEST_TARGET_RE = /^(?:work on|advance|review|reopen)\b/i;

export type ThreadRoutingMarkdownFenceState = {
  marker: string;
  length: number;
};

export function advanceThreadRoutingMarkdownFence(
  fence: ThreadRoutingMarkdownFenceState | null,
  line: string,
): { fence: ThreadRoutingMarkdownFenceState | null; isFenceLine: boolean } {
  const token = line.match(MARKDOWN_FENCE_RE)?.[1];
  if (!token) return { fence, isFenceLine: false };
  if (fence) {
    return {
      fence: token[0] === fence.marker && token.length >= fence.length ? null : fence,
      isFenceLine: true,
    };
  }
  return { fence: { marker: token[0]!, length: token.length }, isFenceLine: true };
}

export function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/.test(threadKey);
}

export function normalizeThreadTarget(raw: string): ThreadRouteTarget | null {
  const threadKey = raw.trim().toLowerCase();
  if (threadKey === "main") return { threadKey };
  if (isQuestThreadKey(threadKey)) return { threadKey, questId: threadKey };
  return null;
}

export function inferThreadTargetFromTextContent(text: string): ThreadRouteTarget | null {
  const uniqueQuestIds = uniqueQuestMentions(text);
  if (uniqueQuestIds.length === 1) {
    return normalizeThreadTarget(uniqueQuestIds[0]);
  }

  const leadingLine = firstLeadingQuestTargetLine(text);
  if (!leadingLine) return null;

  const leadingQuestIds = uniqueQuestMentions(leadingLine);
  if (leadingQuestIds.length !== 1) return null;
  return normalizeThreadTarget(leadingQuestIds[0]);
}

export function formatThreadMarker(
  threadKey: string,
  role?: LeaderThreadTextRole,
  answerUserMessageIds: readonly string[] = [],
): string {
  if (role === "answer") {
    if (
      answerUserMessageIds.length === 0 ||
      answerUserMessageIds.some((id) => !isCanonicalLeaderAnswerMessageId(id)) ||
      new Set(answerUserMessageIds).size !== answerUserMessageIds.length
    ) {
      throw new Error("Answer thread markers require one or more canonical user or timer-firing IDs.");
    }
    return `[thread:${threadKey}:A:${answerUserMessageIds.join(",")}]`;
  }
  const suffix = role === "commentary" ? ":C" : "";
  return `[thread:${threadKey}${suffix}]`;
}

export function isThreadTextMarkerLikeAtLineStart(text: string): boolean {
  return /^\[thread:/i.test(text);
}

export function parseThreadTextPrefix(text: string): ThreadRouteParseResult {
  const markerStart = firstNonWhitespaceIndex(text);
  if (markerStart === null) return { ok: false, reason: "missing", body: text };

  const candidate = text.slice(markerStart);
  const match = TEXT_THREAD_MARKER_RE.exec(candidate);
  if (!match) {
    const markerLike = isThreadTextMarkerLikeAtLineStart(candidate) ? extractThreadMarkerLike(candidate) : undefined;
    const reason =
      markerLike && TEXT_THREAD_DESTINATION_PREFIX_RE.test(candidate)
        ? "invalid_role"
        : markerLike
          ? "invalid"
          : "missing";
    return { ok: false, reason, marker: markerLike, body: text };
  }

  const target = normalizeThreadTarget(match[1]);
  const marker = match[0];
  if (!target) return { ok: false, reason: "invalid", marker, body: text };
  const body = removeSingleThreadMarkerSeparator(candidate.slice(marker.length));
  const conflictingMarker = firstUnfencedThreadTextMarkerLike(body);
  if (conflictingMarker) {
    return { ok: false, reason: "invalid_role", marker: conflictingMarker, body: text };
  }
  const role = normalizeThreadTextRole(match[2], match[3]);
  const answerUserMessageIds = normalizeAnswerUserMessageIds(match[3]);
  if (match[3] && !answerUserMessageIds) {
    return { ok: false, reason: "invalid_role", marker: extractThreadMarkerLike(candidate), body: text };
  }
  return {
    ok: true,
    target,
    ...(role ? { role } : {}),
    ...(answerUserMessageIds ? { answerUserMessageIds } : {}),
    body,
  };
}

export function parseThreadTextLineStartMarker(text: string): ThreadRouteParseResult {
  const match = TEXT_THREAD_MARKER_AT_LINE_START_RE.exec(text);
  if (!match) {
    const markerLike = isThreadTextMarkerLikeAtLineStart(text) ? extractThreadMarkerLike(text) : undefined;
    const reason =
      markerLike && TEXT_THREAD_DESTINATION_PREFIX_RE.test(text) ? "invalid_role" : markerLike ? "invalid" : "missing";
    return { ok: false, reason, marker: markerLike, body: text };
  }

  const target = normalizeThreadTarget(match[1]);
  const marker = match[0];
  if (!target) return { ok: false, reason: "invalid", marker, body: text };
  const body = removeSingleThreadMarkerSeparator(text.slice(marker.length));
  const conflictingMarker = firstUnfencedThreadTextMarkerLike(body);
  if (conflictingMarker) {
    return { ok: false, reason: "invalid_role", marker: conflictingMarker, body: text };
  }
  const role = normalizeThreadTextRole(match[2], match[3]);
  const answerUserMessageIds = normalizeAnswerUserMessageIds(match[3]);
  if (match[3] && !answerUserMessageIds) {
    return { ok: false, reason: "invalid_role", marker: extractThreadMarkerLike(text), body: text };
  }
  return {
    ok: true,
    target,
    ...(role ? { role } : {}),
    ...(answerUserMessageIds ? { answerUserMessageIds } : {}),
    body,
  };
}

function normalizeThreadTextRole(
  commentaryMarker: string | undefined,
  answerIds: string | undefined,
): LeaderThreadTextRole | undefined {
  if (answerIds) return "answer";
  return commentaryMarker?.toUpperCase() === "C" ? "commentary" : undefined;
}

function normalizeAnswerUserMessageIds(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const ids = value.toLowerCase().split(",");
  return new Set(ids).size === ids.length ? ids : undefined;
}

function firstUnfencedThreadTextMarkerLike(text: string): string | null {
  let fence: ThreadRoutingMarkdownFenceState | null = null;
  for (const line of text.split(/\r?\n/)) {
    const wasInsideFence = fence !== null;
    const transition = advanceThreadRoutingMarkdownFence(fence, line);
    fence = transition.fence;
    if (wasInsideFence || transition.isFenceLine) {
      continue;
    }
    const candidate = line.trimStart();
    if (isThreadTextMarkerLikeAtLineStart(candidate)) return extractThreadMarkerLike(candidate);
  }
  return null;
}

export function parseCommandThreadComment(command: string): ThreadRouteTarget | null {
  const lines = command.split(/\r?\n/);
  const first = firstNonEmptyLine(lines);
  if (!first) return null;
  const match = COMMAND_THREAD_COMMENT_RE.exec(first.text);
  return match ? normalizeThreadTarget(match[1]) : null;
}

export function stripCommandThreadComment(command: string): string {
  const lines = command.split(/\r?\n/);
  const first = firstNonEmptyLine(lines);
  if (!first || !COMMAND_THREAD_COMMENT_RE.test(first.text)) return command;
  return removeLineAt(lines, first.index);
}

function firstNonEmptyLine(lines: string[]): { index: number; text: string } | null {
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index]?.trim() ?? "";
    if (text) return { index, text };
  }
  return null;
}

function firstNonWhitespaceIndex(text: string): number | null {
  const match = /\S/.exec(text);
  return match ? match.index : null;
}

function extractThreadMarkerLike(text: string): string {
  return /^\[thread:[^\]]*\]/.exec(text)?.[0] ?? text.split(/\r?\n/, 1)[0] ?? text;
}

function uniqueQuestMentions(text: string): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(QUEST_MENTION_RE)) {
    mentions.add(match[0].toLowerCase());
  }
  return [...mentions];
}

function firstLeadingQuestTargetLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const candidate = stripTranscriptPrefix(line.trim());
    if (!candidate) continue;
    if (LEADING_QUEST_TARGET_RE.test(candidate)) return candidate;
    if (uniqueQuestMentions(candidate).length > 0) return null;
  }
  return null;
}

function stripTranscriptPrefix(line: string): string {
  const withoutIndex = line.replace(/^\[\d+\]\s+/, "");
  const withoutSpeaker = withoutIndex.replace(/^(?:leader|user|human|system|agent(?:\([^)]*\))?)\s*:\s*/i, "");
  return withoutSpeaker.replace(/^["']+/, "").trimStart();
}

function removeLineAt(lines: string[], index: number): string {
  const next = lines.slice();
  next.splice(index, 1);
  return next.join("\n").replace(/^\n+/, "");
}

function removeSingleThreadMarkerSeparator(body: string): string {
  if (body.startsWith("\r\n")) return body.slice(2);
  if (body.startsWith("\n") || body.startsWith("\r") || body.startsWith(" ") || body.startsWith("\t")) {
    return body.slice(1);
  }
  return body;
}
