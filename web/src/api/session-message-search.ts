const BASE = "/api";

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

export interface GlobalStarredMessageSearchResult extends Omit<MessageSearchResult, "role" | "category" | "starred"> {
  sessionName?: string;
  sessionState?: "starting" | "connected" | "running" | "exited";
  archived: boolean;
  archivedAt?: number;
  reviewerOf?: number;
  role: "user" | "assistant";
  category: "user" | "assistant";
  starred: true;
  starredAt: number;
}

export interface GlobalStarredMessageSearchResponse {
  query: string;
  totalMatches: number;
  results: GlobalStarredMessageSearchResult[];
  nextOffset: number | null;
  hasMore: boolean;
  tookMs: number;
}

export interface SearchSessionMessagesOptions {
  query?: string;
  scope?: MessageSearchScopeKind;
  threadKey?: string | null;
  filters?: Partial<MessageSearchFilters>;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface SearchGlobalStarredMessagesOptions {
  query?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export async function searchSessionMessages(
  sessionId: string,
  options?: SearchSessionMessagesOptions,
): Promise<MessageSearchResponse> {
  const params = new URLSearchParams();
  if (options?.query) params.set("q", options.query);
  if (options?.scope) params.set("scope", options.scope);
  if (options?.threadKey) params.set("threadKey", options.threadKey);
  if (typeof options?.limit === "number") params.set("limit", String(options.limit));
  if (typeof options?.offset === "number") params.set("offset", String(options.offset));
  if (typeof options?.filters?.user === "boolean") params.set("includeUser", options.filters.user ? "true" : "false");
  if (typeof options?.filters?.assistant === "boolean") {
    params.set("includeAssistant", options.filters.assistant ? "true" : "false");
  }
  if (typeof options?.filters?.event === "boolean") {
    params.set("includeEvents", options.filters.event ? "true" : "false");
  }
  if (typeof options?.filters?.starredOnly === "boolean") {
    params.set("starredOnly", options.filters.starredOnly ? "true" : "false");
  }

  const query = params.toString();
  const res = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/message-search${query ? `?${query}` : ""}`,
    {
      signal: options?.signal,
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json() as Promise<MessageSearchResponse>;
}

export async function searchGlobalStarredMessages(
  options?: SearchGlobalStarredMessagesOptions,
): Promise<GlobalStarredMessageSearchResponse> {
  const params = new URLSearchParams();
  if (options?.query) params.set("q", options.query);
  if (typeof options?.limit === "number") params.set("limit", String(options.limit));
  if (typeof options?.offset === "number") params.set("offset", String(options.offset));

  const query = params.toString();
  const res = await fetch(`${BASE}/sessions/starred-message-search${query ? `?${query}` : ""}`, {
    signal: options?.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json() as Promise<GlobalStarredMessageSearchResponse>;
}

/** Read the server-owned route for one stable source message, including messages outside the loaded window. */
export async function resolveSessionMessageTarget(
  sessionId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<{ messageId: string; threadKey: string } | null> {
  const response = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/message-target/${encodeURIComponent(messageId)}`,
    { signal },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Source navigation failed (${response.status})`);
  return response.json();
}
