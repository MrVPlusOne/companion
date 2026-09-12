import { formatAnnotatedMessage } from "../shared/conversation-annotations.js";
import type { BrowserIncomingMessage, SessionTaskEntry } from "./session-types.js";
import type { SearchExcerpt } from "./session-store.js";
import { multiWordMatch, normalizeForSearch } from "../shared/search-utils.js";
import type { LeaderActivePhaseSummarySegment } from "../shared/leader-active-phase-summary.js";
import { buildCodexAutoPauseRecoverySearchText } from "./codex-auto-pause-types.js";
import { isRootAgentHistoryMessage } from "./root-agent-feed-message.js";

export type SessionSearchMatchedField =
  | "session_number"
  | "name"
  | "task"
  | "keyword"
  | "branch"
  | "path"
  | "repo"
  | "user_message"
  | "assistant"
  | "recovery_summary"
  | "compact_marker";

export interface SessionSearchDocument {
  sessionId: string;
  sessionNum?: number | null;
  state?: "starting" | "connected" | "running" | "exited";
  model?: string;
  backendType?: "claude" | "codex" | "claude-sdk";
  archived: boolean;
  archivedAt?: number;
  isOrchestrator?: boolean;
  reviewerOf?: number;
  createdAt: number;
  lastActivityAt?: number;
  lastUserMessageAt?: number;
  name?: string;
  taskHistory?: SessionTaskEntry[];
  keywords?: string[];
  gitBranch?: string;
  cwd?: string;
  repoRoot?: string;
  leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
  messageHistory?: BrowserIncomingMessage[] | null;
  /** Lightweight search excerpts for search-data-only archived sessions. */
  searchExcerpts?: SearchExcerpt[];
}

export interface SessionSearchSessionSummary {
  sessionId: string;
  sessionNum: number | null;
  state: "starting" | "connected" | "running" | "exited";
  model?: string;
  backendType?: "claude" | "codex" | "claude-sdk";
  archived: boolean;
  archivedAt?: number;
  isOrchestrator: boolean;
  reviewerOf?: number;
  createdAt: number;
  lastActivityAt?: number;
  lastUserMessageAt?: number;
  name?: string;
  gitBranch?: string;
  cwd: string;
  repoRoot?: string;
  leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
}

export interface SessionSearchResult {
  sessionId: string;
  score: number;
  matchedField: SessionSearchMatchedField;
  matchContext: string | null;
  matchedAt: number;
  session?: SessionSearchSessionSummary;
  messageMatch?: {
    id?: string;
    timestamp: number;
    snippet: string;
  };
}

export interface SearchSessionDocumentsOptions {
  query: string;
  limit?: number;
  includeArchived?: boolean;
  includeReviewers?: boolean;
  leaderOnly?: boolean;
  messageLimitPerSession?: number;
}

export interface SearchSessionDocumentsOutput {
  totalMatches: number;
  results: SessionSearchResult[];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseExactSessionNumberQuery(query: string): number | null {
  const match = query.trim().match(/^#(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function buildSnippet(content: string, qWords: string[], maxLen = 120): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;

  // Find the position of the first matching word to center the snippet around it
  const lower = text.toLowerCase();
  let idx = -1;
  let matchLen = 1;
  for (const w of qWords) {
    const i = lower.indexOf(w);
    if (i >= 0) {
      idx = i;
      matchLen = w.length;
      break;
    }
  }
  if (idx < 0) return text.slice(0, maxLen).trimEnd();

  const contextRadius = Math.floor((maxLen - matchLen) / 2);
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, start + maxLen);
  return text.slice(start, end).trim();
}

function compareCandidates(a: SessionSearchResult, b: SessionSearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.matchedAt !== b.matchedAt) return b.matchedAt - a.matchedAt;
  return a.sessionId.localeCompare(b.sessionId);
}

function pushIfBetter(current: SessionSearchResult | null, next: SessionSearchResult): SessionSearchResult {
  if (!current) return next;
  return compareCandidates(current, next) <= 0 ? current : next;
}

function buildSessionSummary(doc: SessionSearchDocument): SessionSearchSessionSummary {
  return {
    sessionId: doc.sessionId,
    sessionNum: doc.sessionNum ?? null,
    state: doc.state ?? "exited",
    model: doc.model,
    backendType: doc.backendType,
    archived: doc.archived,
    archivedAt: doc.archivedAt,
    isOrchestrator: doc.isOrchestrator === true,
    reviewerOf: doc.reviewerOf,
    createdAt: doc.createdAt,
    lastActivityAt: doc.lastActivityAt,
    lastUserMessageAt: doc.lastUserMessageAt,
    name: doc.name,
    gitBranch: doc.gitBranch,
    cwd: doc.cwd ?? "",
    repoRoot: doc.repoRoot,
    leaderActivePhaseSummary: doc.leaderActivePhaseSummary,
  };
}

function extractAssistantText(msg: BrowserIncomingMessage): string {
  if (msg.type !== "assistant" || !msg.message?.content) return "";
  const blocks = msg.message.content;
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join(" ").trim();
}

function searchExcerptIsSessionRecycle(excerpt: SearchExcerpt): boolean {
  if (excerpt.type !== "compact_marker") return false;
  if (excerpt.markerKind === "session_recycled") return true;
  return excerpt.content.trim().replace(/^\[|\]$/g, "") === "Session recycled";
}

function messageMatchCandidate(
  doc: SessionSearchDocument,
  qWords: string[],
  matches: (text: string) => boolean,
  maxMessagesToScan: number,
): SessionSearchResult | null {
  const history = doc.messageHistory;

  // Search-data-only path: use lightweight excerpts instead of full history
  if ((!history || history.length === 0) && doc.searchExcerpts && doc.searchExcerpts.length > 0) {
    let scanned = 0;
    for (let i = doc.searchExcerpts.length - 1; i >= 0; i--) {
      if (scanned >= maxMessagesToScan) break;
      scanned++;
      const excerpt = doc.searchExcerpts[i];
      if (!matches(excerpt.content)) continue;

      const matchedField: SessionSearchMatchedField =
        excerpt.type === "user_message"
          ? "user_message"
          : excerpt.type === "assistant"
            ? "assistant"
            : excerpt.type === "recovery_summary"
              ? "recovery_summary"
              : "compact_marker";
      const score =
        excerpt.type === "user_message"
          ? 500
          : excerpt.type === "assistant"
            ? 470
            : excerpt.type === "recovery_summary"
              ? 455
              : 450;
      const isSessionRecycle = searchExcerptIsSessionRecycle(excerpt);
      const prefix =
        excerpt.type === "user_message"
          ? "message"
          : excerpt.type === "assistant"
            ? "assistant"
            : excerpt.type === "recovery_summary"
              ? "recovery"
              : isSessionRecycle
                ? "session recycle"
                : "compaction";
      return {
        sessionId: doc.sessionId,
        score,
        matchedField,
        matchContext: `${prefix}: ${buildSnippet(excerpt.content, qWords)}`,
        matchedAt: excerpt.timestamp || (doc.lastActivityAt ?? doc.createdAt),
        messageMatch: {
          id: excerpt.id,
          timestamp: excerpt.timestamp || (doc.lastActivityAt ?? doc.createdAt),
          snippet: buildSnippet(excerpt.content, qWords),
        },
      };
    }
    return null;
  }

  if (!history || history.length === 0) return null;

  let scanned = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!isRootAgentHistoryMessage(msg)) continue;
    if (scanned >= maxMessagesToScan) break;
    scanned++;

    // Search user messages and server-authored recovery summaries.
    if (msg.type === "user_message") {
      const content = formatAnnotatedMessage(msg.content || "", msg.annotations).trim();
      if (!content) continue;
      if (!matches(content)) continue;

      const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : (doc.lastActivityAt ?? doc.createdAt);
      return {
        sessionId: doc.sessionId,
        score: 500,
        matchedField: "user_message",
        matchContext: `message: ${buildSnippet(content, qWords)}`,
        matchedAt: timestamp,
        messageMatch: { id: msg.id, timestamp, snippet: buildSnippet(content, qWords) },
      };
    }

    if (msg.type === "codex_auto_pause_recovery_summary") {
      const content = (msg.searchText || buildCodexAutoPauseRecoverySearchText(msg.recovery)).trim();
      if (!matches(content)) continue;
      const timestamp = msg.timestamp || doc.lastActivityAt || doc.createdAt;
      return {
        sessionId: doc.sessionId,
        score: 455,
        matchedField: "recovery_summary",
        matchContext: `recovery: ${buildSnippet(content, qWords)}`,
        matchedAt: timestamp,
        messageMatch: { id: msg.id, timestamp, snippet: buildSnippet(content, qWords) },
      };
    }

    if (msg.type === "compact_marker") {
      const markerIsRecycle = msg.markerKind === "session_recycled";
      const content = (msg.summary || (markerIsRecycle ? "[Session recycled]" : "[Context compacted]")).trim();
      if (!matches(content)) continue;

      const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : (doc.lastActivityAt ?? doc.createdAt);
      return {
        sessionId: doc.sessionId,
        score: 450,
        matchedField: "compact_marker",
        matchContext: `${markerIsRecycle ? "session recycle" : "compaction"}: ${buildSnippet(content, qWords)}`,
        matchedAt: timestamp,
        messageMatch: { id: msg.id, timestamp, snippet: buildSnippet(content, qWords) },
      };
    }

    if (msg.type === "assistant") {
      const text = extractAssistantText(msg);
      if (!text || !matches(text)) continue;

      const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : (doc.lastActivityAt ?? doc.createdAt);
      return {
        sessionId: doc.sessionId,
        score: 470,
        matchedField: "assistant",
        matchContext: `assistant: ${buildSnippet(text, qWords)}`,
        matchedAt: timestamp,
        messageMatch: { id: msg.message?.id, timestamp, snippet: buildSnippet(text, qWords) },
      };
    }
  }
  return null;
}

export function searchSessionDocuments(
  docs: SessionSearchDocument[],
  options: SearchSessionDocumentsOptions,
): SearchSessionDocumentsOutput {
  const exactSessionNum = parseExactSessionNumberQuery(options.query);
  const q = normalizeForSearch(options.query);
  if (!q) return { totalMatches: 0, results: [] };
  const qWords = q.split(/\s+/).filter(Boolean);
  const matches_ = (text: string) => {
    const n = normalizeForSearch(text);
    return qWords.every((w) => n.includes(w));
  };

  const includeArchived = options.includeArchived !== false;
  const includeReviewers = options.includeReviewers === true;
  const leaderOnly = options.leaderOnly === true;
  const limit = clampInt(Math.floor(options.limit ?? 50), 1, 200);
  const messageLimitPerSession = clampInt(Math.floor(options.messageLimitPerSession ?? 400), 50, 2000);

  const matches: SessionSearchResult[] = [];

  for (const doc of docs) {
    if (!includeArchived && doc.archived) continue;
    if (!includeReviewers && doc.reviewerOf !== undefined) continue;
    if (leaderOnly && doc.isOrchestrator !== true) continue;

    const recencyTs = doc.lastActivityAt ?? doc.createdAt ?? 0;
    let best: SessionSearchResult | null = null;

    if (exactSessionNum !== null && doc.sessionNum === exactSessionNum) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 1100,
        matchedField: "session_number",
        matchContext: null,
        matchedAt: recencyTs,
      });
    }

    const name = (doc.name || "").trim();
    if (name && matches_(name)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 1000,
        matchedField: "name",
        matchContext: null,
        matchedAt: recencyTs,
      });
    }

    const task = (doc.taskHistory || []).find((t) => matches_(t.title));
    if (task) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 920,
        matchedField: "task",
        matchContext: `task: ${task.title}`,
        matchedAt: task.timestamp || recencyTs,
      });
    }

    const kw = (doc.keywords || []).find((k) => matches_(k));
    if (kw) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 880,
        matchedField: "keyword",
        matchContext: `keyword: ${kw}`,
        matchedAt: recencyTs,
      });
    }

    const branch = (doc.gitBranch || "").trim();
    if (branch && matches_(branch)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 840,
        matchedField: "branch",
        matchContext: `branch: ${branch}`,
        matchedAt: recencyTs,
      });
    }

    const cwd = (doc.cwd || "").trim();
    if (cwd && matches_(cwd)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 810,
        matchedField: "path",
        matchContext: `path: ${cwd}`,
        matchedAt: recencyTs,
      });
    }

    const repoRoot = (doc.repoRoot || "").trim();
    if (repoRoot && matches_(repoRoot)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 800,
        matchedField: "repo",
        matchContext: `repo: ${repoRoot}`,
        matchedAt: recencyTs,
      });
    }

    const msgCandidate = messageMatchCandidate(doc, qWords, matches_, messageLimitPerSession);
    if (msgCandidate) {
      best = pushIfBetter(best, msgCandidate);
    }

    if (best) matches.push({ ...best, session: buildSessionSummary(doc) });
  }

  matches.sort(compareCandidates);
  return {
    totalMatches: matches.length,
    results: matches.slice(0, limit),
  };
}
