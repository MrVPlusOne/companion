import type { BrowserIncomingMessage, ContentBlock, StarredMessageRecord } from "./session-types.js";
import { authoritativeMessageOwner } from "./authoritative-message-owner.js";
import { isRootAgentHistoryMessage } from "./root-agent-feed-message.js";
import {
  ALL_THREADS_KEY,
  MAIN_THREAD_KEY,
  buildProjectedThreadEntries,
  normalizeSelectedFeedThreadKey,
} from "../shared/thread-window.js";
import {
  compareSearchRanks,
  prepareSearchQuery,
  rankSearchFields,
  tokenizeSearchText,
  type SearchRank,
} from "../shared/search-utils.js";

export type MessageSearchScopeKind = "session" | "current_thread" | "leader_all_tabs";
export type MessageSearchCategory = "user" | "assistant" | "event";

export interface MessageSearchFilters {
  user: boolean;
  assistant: boolean;
  event: boolean;
  starredOnly?: boolean;
}

export type MessageSearchScope =
  | { kind: "session"; label: string }
  | { kind: "current_thread"; threadKey: string; label: string }
  | { kind: "leader_all_tabs"; label: string };

export interface MessageSearchResult {
  id: string;
  sessionId: string;
  sessionNum: number | null;
  messageId: string;
  historyIndex: number;
  role: "user" | "assistant" | "system";
  category: MessageSearchCategory;
  timestamp: number;
  snippet: string;
  fullText?: string;
  matchRanges?: Array<{ start: number; end: number }>;
  matchedText?: string;
  routeThreadKey?: string;
  sourceThreadKey?: string;
  sourceLabel?: string;
  questId?: string;
  starred: boolean;
}

export interface MessageSearchResponse {
  sessionId: string;
  sessionNum: number | null;
  query: string;
  scope: MessageSearchScope;
  filters: MessageSearchFilters;
  totalMatches: number;
  results: MessageSearchResult[];
  nextOffset: number | null;
  hasMore: boolean;
  tookMs: number;
}

export interface SearchSessionMessagesInput {
  sessionId: string;
  sessionNum: number | null;
  isLeaderSession: boolean;
  messageHistory: ReadonlyArray<BrowserIncomingMessage>;
  query?: string;
  scope?: MessageSearchScopeKind;
  threadKey?: string | null;
  filters?: Partial<MessageSearchFilters>;
  limit?: number;
  offset?: number;
  starredMessages?: Record<string, StarredMessageRecord>;
}

interface CandidateMessage {
  message: BrowserIncomingMessage;
  messageId: string;
  historyIndex: number;
  role: MessageSearchResult["role"];
  category: MessageSearchCategory;
  timestamp: number;
  text: string;
  sourceThreadKey: string;
  sourceLabel: string;
  routeThreadKey?: string;
  questId?: string;
}

const DEFAULT_FILTERS: MessageSearchFilters = {
  user: true,
  assistant: false,
  event: false,
};

/** Resolve one root-feed message's authoritative destination without returning history or payload text. */
export function resolveSessionMessageTarget(
  history: ReadonlyArray<BrowserIncomingMessage>,
  messageId: string,
  isLeaderSession: boolean,
): { messageId: string; threadKey: string } | null {
  const entries = buildProjectedThreadEntries(history, ALL_THREADS_KEY, { includeMessage: isRootAgentHistoryMessage });
  const matches = entries.filter((entry) => rawMessageId(entry.message, entry.history_index) === messageId);
  if (matches.length !== 1 || matches[0].message.type !== "assistant") return null;
  return {
    messageId,
    threadKey: isLeaderSession ? authoritativeMessageOwner(matches[0].message).threadKey : MAIN_THREAD_KEY,
  };
}

export function searchSessionMessages(input: SearchSessionMessagesInput): MessageSearchResponse {
  const startedAt = Date.now();
  const query = (input.query ?? "").trim();
  const limit = clampInteger(input.limit, 20, 1, 200);
  const offset = clampInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const filters = { ...DEFAULT_FILTERS, ...input.filters };
  const scope = resolveMessageSearchScope({
    requestedScope: input.scope,
    requestedThreadKey: input.threadKey,
    isLeaderSession: input.isLeaderSession,
    sessionNum: input.sessionNum,
  });
  const projectionKey = scope.kind === "current_thread" ? scope.threadKey : ALL_THREADS_KEY;
  const entries = buildProjectedThreadEntries(input.messageHistory, projectionKey, {
    includeMessage: (message) => isRootAgentHistoryMessage(message),
  });
  const candidates = entries
    .map((entry) =>
      buildCandidate({
        sessionId: input.sessionId,
        entryMessage: entry.message,
        historyIndex: entry.history_index,
        scope,
      }),
    )
    .filter((candidate): candidate is CandidateMessage => candidate !== null)
    .filter((candidate) => filters[candidate.category])
    .filter((candidate) => !filters.starredOnly || Boolean(input.starredMessages?.[candidate.messageId]));

  const matched: CandidateMessage[] = query
    ? candidates
        .map((candidate) => ({ candidate, rank: rankSearchFields([{ rank: 0, text: candidate.text }], query) }))
        .filter((match): match is { candidate: CandidateMessage; rank: SearchRank } => match.rank !== null)
        .sort(compareRankedCandidates)
        .map((match) => match.candidate)
    : [...candidates].sort((left, right) => right.timestamp - left.timestamp || right.historyIndex - left.historyIndex);

  const page = matched.slice(offset, offset + limit);
  const results = page.map((candidate) =>
    candidateToResult(input.sessionId, input.sessionNum, candidate, query, input.starredMessages),
  );
  const nextOffset = offset + results.length < matched.length ? offset + results.length : null;

  return {
    sessionId: input.sessionId,
    sessionNum: input.sessionNum,
    query,
    scope,
    filters,
    totalMatches: matched.length,
    results,
    nextOffset,
    hasMore: nextOffset !== null,
    tookMs: Date.now() - startedAt,
  };
}

function resolveMessageSearchScope(input: {
  requestedScope: MessageSearchScopeKind | undefined;
  requestedThreadKey: string | null | undefined;
  isLeaderSession: boolean;
  sessionNum: number | null;
}): MessageSearchScope {
  const sessionLabel = formatSessionNumber(input.sessionNum);
  if (!input.isLeaderSession) {
    return {
      kind: "session",
      label:
        typeof input.sessionNum === "number" ? `Searching in session ${sessionLabel}` : "Searching in current session",
    };
  }
  const requestedThreadKey = normalizeSelectedFeedThreadKey(input.requestedThreadKey || MAIN_THREAD_KEY);
  if (input.requestedScope === "leader_all_tabs" || requestedThreadKey === ALL_THREADS_KEY) {
    return { kind: "leader_all_tabs", label: `Searching in ${sessionLabel} across tabs` };
  }
  const threadKey = requestedThreadKey;
  return {
    kind: "current_thread",
    threadKey,
    label:
      threadKey === MAIN_THREAD_KEY
        ? `Searching in ${sessionLabel} Main`
        : `Searching in ${sessionLabel} thread ${threadKey}`,
  };
}

function buildCandidate(input: {
  sessionId: string;
  entryMessage: BrowserIncomingMessage;
  historyIndex: number;
  scope: MessageSearchScope;
}): CandidateMessage | null {
  const normalized = normalizeRawMessage(input.entryMessage, input.historyIndex, input.sessionId);
  if (!normalized || !normalized.text.trim()) return null;
  const route = inferResultRoute(input.entryMessage, input.scope);
  return {
    ...normalized,
    sourceThreadKey: route.sourceThreadKey,
    sourceLabel: formatThreadSourceLabel(route.sourceThreadKey),
    routeThreadKey: route.routeThreadKey,
    ...(route.questId ? { questId: route.questId } : {}),
  };
}

function normalizeRawMessage(
  message: BrowserIncomingMessage,
  historyIndex: number,
  sessionId: string,
): Omit<CandidateMessage, "sourceThreadKey" | "sourceLabel" | "routeThreadKey" | "questId"> | null {
  if (message.type === "user_message") {
    const sourceId = message.agentSource?.sessionId;
    return {
      message,
      messageId: rawMessageId(message, historyIndex),
      historyIndex,
      role: "user",
      category: !sourceId || sourceId === sessionId ? "user" : "event",
      timestamp: timestampForRawMessage(message),
      text: message.content,
    };
  }
  if (message.type === "leader_user_message") {
    return {
      message,
      messageId: rawMessageId(message, historyIndex),
      historyIndex,
      role: "assistant",
      category: "assistant",
      timestamp: timestampForRawMessage(message),
      text: message.content,
    };
  }
  if (message.type === "assistant") {
    return {
      message,
      messageId: rawMessageId(message, historyIndex),
      historyIndex,
      role: "assistant",
      category: "assistant",
      timestamp: timestampForRawMessage(message),
      text: textFromContentBlocks(message.message.content),
    };
  }
  const eventText = eventTextForMessage(message);
  if (!eventText) return null;
  return {
    message,
    messageId: rawMessageId(message, historyIndex),
    historyIndex,
    role: "system",
    category: "event",
    timestamp: timestampForRawMessage(message),
    text: eventText,
  };
}

function candidateToResult(
  sessionId: string,
  sessionNum: number | null,
  candidate: CandidateMessage,
  query: string,
  starredMessages: Record<string, StarredMessageRecord> | undefined,
): MessageSearchResult {
  const snippetInfo = buildSnippet(candidate.text, query);
  return {
    id: `${sessionId}:${candidate.historyIndex}:${candidate.messageId}`,
    sessionId,
    sessionNum,
    messageId: candidate.messageId,
    historyIndex: candidate.historyIndex,
    role: candidate.role,
    category: candidate.category,
    starred: Boolean(starredMessages?.[candidate.messageId]),
    timestamp: candidate.timestamp,
    snippet: snippetInfo.snippet,
    ...(candidate.text.length > snippetInfo.snippet.length ? { fullText: candidate.text } : {}),
    ...(snippetInfo.matchRanges.length > 0 ? { matchRanges: snippetInfo.matchRanges } : {}),
    ...(snippetInfo.matchedText ? { matchedText: snippetInfo.matchedText } : {}),
    routeThreadKey: candidate.routeThreadKey,
    sourceThreadKey: candidate.sourceThreadKey,
    sourceLabel: candidate.sourceLabel,
    ...(candidate.questId ? { questId: candidate.questId } : {}),
  };
}

function compareRankedCandidates(
  left: { candidate: CandidateMessage; rank: SearchRank },
  right: { candidate: CandidateMessage; rank: SearchRank },
): number {
  return (
    compareSearchRanks(left.rank, right.rank) ||
    right.candidate.timestamp - left.candidate.timestamp ||
    right.candidate.historyIndex - left.candidate.historyIndex
  );
}

function inferResultRoute(
  message: BrowserIncomingMessage,
  scope: MessageSearchScope,
): {
  sourceThreadKey: string;
  routeThreadKey?: string;
  questId?: string;
} {
  if (scope.kind === "current_thread") {
    const questId = scope.threadKey !== MAIN_THREAD_KEY ? scope.threadKey : undefined;
    return {
      sourceThreadKey: scope.threadKey,
      routeThreadKey: scope.threadKey,
      ...(questId ? { questId } : {}),
    };
  }

  if (scope.kind === "session") {
    return { sourceThreadKey: MAIN_THREAD_KEY, routeThreadKey: MAIN_THREAD_KEY };
  }

  const owner = authoritativeMessageOwner(message);
  return {
    sourceThreadKey: owner.threadKey,
    routeThreadKey: owner.threadKey,
    ...(owner.questId ? { questId: owner.questId } : {}),
  };
}

function formatSessionNumber(sessionNum: number | null): string {
  return typeof sessionNum === "number" ? `#${sessionNum}` : "current session";
}

function formatThreadSourceLabel(threadKey: string): string {
  return threadKey === MAIN_THREAD_KEY ? "Main" : `Thread ${threadKey}`;
}

function buildSnippet(
  text: string,
  query: string,
): {
  snippet: string;
  matchRanges: Array<{ start: number; end: number }>;
  matchedText?: string;
} {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!query.trim()) return { snippet: truncateSnippet(collapsed), matchRanges: [] };

  const queryTokens = prepareSearchQuery(query) ?? [];
  const haystackTokens = tokenizeSearchText(collapsed);
  const firstMatch = haystackTokens.find((token) =>
    queryTokens.some((queryToken) => token.value === queryToken || token.value.startsWith(queryToken)),
  );
  if (!firstMatch) return { snippet: truncateSnippet(collapsed), matchRanges: [] };

  const desiredContext = 70;
  const start = Math.max(0, firstMatch.start - desiredContext);
  const end = Math.min(collapsed.length, firstMatch.end + desiredContext);
  const snippetStart = start > 0 ? nextWordBoundary(collapsed, start) : 0;
  const snippetEnd = end < collapsed.length ? previousWordBoundary(collapsed, end) : collapsed.length;
  const prefix = snippetStart > 0 ? "..." : "";
  const suffix = snippetEnd < collapsed.length ? "..." : "";
  const body = collapsed.slice(snippetStart, snippetEnd).trim();
  const snippet = `${prefix}${body}${suffix}`;
  const bodyOffset = prefix.length - snippetStart;
  const matchRanges = haystackTokens
    .filter((token) => token.start >= snippetStart && token.end <= snippetEnd)
    .filter((token) =>
      queryTokens.some((queryToken) => token.value === queryToken || token.value.startsWith(queryToken)),
    )
    .map((token) => ({ start: token.start + bodyOffset, end: token.end + bodyOffset }));
  return {
    snippet,
    matchRanges,
    matchedText: collapsed.slice(firstMatch.start, firstMatch.end),
  };
}

function truncateSnippet(text: string, limit = 180): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}...`;
}

function nextWordBoundary(text: string, index: number): number {
  const nextSpace = text.indexOf(" ", index);
  return nextSpace === -1 ? index : nextSpace + 1;
}

function previousWordBoundary(text: string, index: number): number {
  const previousSpace = text.lastIndexOf(" ", index);
  return previousSpace === -1 ? index : previousSpace;
}

function textFromContentBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function eventTextForMessage(message: BrowserIncomingMessage): string | null {
  switch (message.type) {
    case "compact_marker":
      return (
        message.summary ?? (message.markerKind === "session_recycled" ? "Session recycled" : "Conversation compacted")
      );
    case "thread_attachment_marker":
      return `Thread attachment moved ${message.count} message${message.count === 1 ? "" : "s"} to thread ${
        message.questId ?? message.threadKey
      }`;
    case "thread_transition_marker":
      return `Thread transition from ${message.sourceQuestId ?? message.sourceThreadKey} to ${
        message.questId ?? message.threadKey
      }`;
    case "cross_thread_activity_marker":
      return message.summary ?? `${message.count} activities in thread ${message.questId ?? message.threadKey}`;
    case "permission_denied":
    case "permission_approved":
    case "permission_auto_approved":
      return message.summary;
    case "permission_auto_denied":
      return message.reason;
    case "permission_needs_attention":
      return message.reason ?? "Permission needs attention";
    case "task_notification":
      return message.summary ?? null;
    case "result": {
      const data = message.data as { is_error?: boolean; result?: string; errors?: string[] };
      if (data.is_error) return data.errors?.join("\n") || data.result || "Turn failed";
      return data.result ?? null;
    }
    default:
      return null;
  }
}

function rawMessageId(message: BrowserIncomingMessage, fallbackIndex: number): string {
  if ("id" in message && typeof message.id === "string") return message.id;
  if (message.type === "assistant") return message.message.id;
  return `history-${fallbackIndex}`;
}

function timestampForRawMessage(message: BrowserIncomingMessage): number {
  if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
  return 0;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
