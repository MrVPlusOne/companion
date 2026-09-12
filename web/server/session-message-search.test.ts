import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import { resolveSessionMessageTarget, searchSessionMessages } from "./session-message-search.js";

function user(
  id: string,
  content: string,
  timestamp: number,
  options: { threadKey?: string; agentSource?: { sessionId: string; sessionLabel?: string } } = {},
): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content,
    timestamp,
    ...(options.agentSource ? { agentSource: options.agentSource } : {}),
    ...(options.threadKey
      ? {
          threadKey: options.threadKey,
          questId: options.threadKey,
          threadRefs: [{ threadKey: options.threadKey, questId: options.threadKey, source: "explicit" as const }],
        }
      : {}),
  };
}

function assistant(id: string, text: string, timestamp: number, threadKey?: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp,
    ...(threadKey
      ? {
          threadKey,
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit" as const }],
        }
      : {}),
  };
}

function compactMarker(id: string, summary: string, timestamp: number): BrowserIncomingMessage {
  return {
    type: "compact_marker",
    id,
    ...(summary ? { summary } : {}),
    timestamp,
  };
}

function recycledMarker(id: string, timestamp: number): BrowserIncomingMessage {
  return {
    type: "compact_marker",
    id,
    markerKind: "session_recycled",
    timestamp,
  };
}

describe("searchSessionMessages", () => {
  it("searches normal sessions across the whole persisted history", () => {
    const response = searchSessionMessages({
      sessionId: "normal-session",
      sessionNum: 123,
      isLeaderSession: false,
      messageHistory: [
        user("old", "older persisted-only request about constellation search", 10, { threadKey: "q-legacy" }),
        user("new", "newer visible request", 20),
      ],
      query: "constellation",
      scope: "current_thread",
    });

    expect(response.scope).toEqual({ kind: "session", label: "Searching in session #123" });
    expect(response.results.map((result) => result.messageId)).toEqual(["old"]);
    expect(response.results[0]).toMatchObject({
      snippet: expect.stringContaining("constellation"),
      sourceLabel: "Main",
      routeThreadKey: "main",
      starred: false,
    });
    expect(response.results[0]?.questId).toBeUndefined();
  });

  it("excludes proven native child rows from root-feed message search", () => {
    // Universal Messages navigates into the ordinary feed. Child-owned matches
    // remain authoritative but are intentionally discoverable through the inspector instead.
    const childAssistant = assistant("child-assistant", "shared child and root phrase", 20);
    childAssistant.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
    const childUser = user("child-user", "shared child and root phrase", 30);
    childUser.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
    const childError: BrowserIncomingMessage = {
      type: "error",
      id: "child-error",
      message: "shared child and root phrase",
      timestamp: 40,
      codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" },
    };
    const response = searchSessionMessages({
      sessionId: "normal-session",
      sessionNum: 123,
      isLeaderSession: false,
      messageHistory: [
        childAssistant,
        assistant("root-assistant", "shared child and root phrase", 10),
        childUser,
        childError,
      ],
      query: "shared child and root phrase",
      filters: { user: true, assistant: true, event: true },
    });

    expect(response.results.map((result) => result.messageId)).toEqual(["root-assistant"]);
    expect(response.results[0]?.historyIndex).toBe(1);
  });

  it("uses Main thread projection for leader current-thread scope", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("main", "main apple request", 10),
        user("quest", "quest-only dragonfruit request", 20, { threadKey: "q-1277" }),
      ],
      query: "",
      scope: "current_thread",
      threadKey: "main",
    });

    expect(response.scope).toEqual({ kind: "current_thread", threadKey: "main", label: "Searching in #456 Main" });
    expect(response.results.map((result) => result.messageId)).toEqual(["main"]);
  });

  it("uses quest-thread projection for leader current-thread typed search", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("main", "main pear request", 10),
        user("quest", "quest pear request", 20, { threadKey: "q-1277" }),
        user("other", "other quest pear request", 30, { threadKey: "q-999" }),
      ],
      query: "pear",
      scope: "current_thread",
      threadKey: "q-1277",
    });

    expect(response.scope).toEqual({
      kind: "current_thread",
      threadKey: "q-1277",
      label: "Searching in #456 thread q-1277",
    });
    expect(response.results.map((result) => result.messageId)).toEqual(["quest"]);
    expect(response.results[0]).toMatchObject({
      sourceLabel: "Thread q-1277",
      routeThreadKey: "q-1277",
      questId: "q-1277",
    });
  });

  it("searches leader across-tabs within the current leader history only", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("main", "main request", 10),
        user("quest", "quest dragonfruit request", 20, { threadKey: "q-1277" }),
      ],
      query: "",
      scope: "leader_all_tabs",
    });

    expect(response.scope).toEqual({ kind: "leader_all_tabs", label: "Searching in #456 across tabs" });
    expect(response.results.map((result) => result.messageId)).toEqual(["quest", "main"]);
    expect(response.results.map((result) => result.sourceLabel)).toEqual(["Thread q-1277", "Main"]);
  });

  it("normalizes legacy current-thread All scope to canonical leader across-tabs results", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("main", "main dragonfruit request", 10),
        user("quest", "quest dragonfruit request", 20, { threadKey: "q-1277" }),
      ],
      query: "dragonfruit",
      scope: "current_thread",
      threadKey: "all",
    });

    expect(response.scope).toEqual({ kind: "leader_all_tabs", label: "Searching in #456 across tabs" });
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "quest",
          sourceThreadKey: "q-1277",
          routeThreadKey: "q-1277",
          questId: "q-1277",
        }),
        expect.objectContaining({ messageId: "main", sourceThreadKey: "main", routeThreadKey: "main" }),
      ]),
    );
    expect(response.results.some((result) => result.routeThreadKey === "all" || result.questId === "all")).toBe(false);
  });

  it("keeps every matching message when leader across-tabs hits share one destination", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("first", "shared destination dragonfruit one", 10, { threadKey: "q-1277" }),
        user("second", "shared destination dragonfruit two", 20, { threadKey: "q-1277" }),
      ],
      query: "dragonfruit",
      scope: "leader_all_tabs",
    });

    expect(response.results.map((result) => result.messageId)).toEqual(["second", "first"]);
    expect(response.results.map((result) => result.routeThreadKey)).toEqual(["q-1277", "q-1277"]);
    expect(response.totalMatches).toBe(2);
  });

  it("routes leader across-tabs matches by the newest non-backfill attachment", () => {
    const moved = user("moved", "canonical attachment dragonfruit", 10, { threadKey: "q-1" });
    moved.threadRefs = [
      { threadKey: "q-1", questId: "q-1", source: "explicit", attachedAt: 10 },
      { threadKey: "q-99", questId: "q-99", source: "backfill", attachedAt: 99 },
      { threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 20 },
    ];
    const aggregate = user("aggregate", "aggregate dragonfruit", 20, { threadKey: "all" });

    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [moved, aggregate],
      query: "dragonfruit",
      scope: "leader_all_tabs",
    });

    expect(response.results).toEqual([
      expect.objectContaining({ messageId: "aggregate", sourceThreadKey: "main", routeThreadKey: "main" }),
      expect.objectContaining({
        messageId: "moved",
        sourceThreadKey: "q-2",
        routeThreadKey: "q-2",
        questId: "q-2",
      }),
    ]);
  });

  it("applies message type filters and paginates newest recents", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("user", "user recent", 10),
        assistant("assistant", "assistant recent", 20),
        user("event", "system event", 30, { agentSource: { sessionId: "herd-events" } }),
      ],
      filters: { user: false, assistant: true, event: true },
      limit: 1,
      offset: 0,
    });

    expect(response.totalMatches).toBe(2);
    expect(response.hasMore).toBe(true);
    expect(response.nextOffset).toBe(1);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({ messageId: "event", category: "event" });
  });

  it("returns only event-category results when only the Events filter is enabled", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("normal-user", "normal user compact request", 10),
        user("injected-event", "herd compact event payload", 20, { agentSource: { sessionId: "herd-events" } }),
        compactMarker("system-event", "Conversation compact summary", 30),
      ],
      query: "compact",
      filters: { user: false, assistant: false, event: true },
      scope: "leader_all_tabs",
    });

    expect(response.results).toHaveLength(2);
    expect(response.results.map((result) => result.messageId)).toEqual(
      expect.arrayContaining(["system-event", "injected-event"]),
    );
    expect(response.results.map((result) => result.messageId)).not.toContain("normal-user");
    expect(response.results.every((result) => result.category === "event")).toBe(true);
    expect(response.results.map((result) => result.role)).toEqual(expect.arrayContaining(["system", "user"]));
  });

  it("labels session recycled markers without compaction wording", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [recycledMarker("session-recycled-1", 20)],
      query: "recycled",
      filters: { user: false, assistant: false, event: true },
      scope: "leader_all_tabs",
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      messageId: "session-recycled-1",
      category: "event",
      role: "system",
      snippet: expect.stringContaining("Session recycled"),
    });
    expect(response.results[0].snippet).not.toContain("compacted");
  });

  it("marks starred results and filters starred-only without changing query ranking", () => {
    const response = searchSessionMessages({
      sessionId: "leader-session",
      sessionNum: 456,
      isLeaderSession: true,
      messageHistory: [
        user("unstarred", "alpha result newer", 30),
        user("starred-low", "alpha result older", 10),
        assistant("starred-high", "alpha result newest assistant", 40),
      ],
      query: "alpha result",
      filters: { user: true, assistant: true, event: false, starredOnly: true },
      starredMessages: {
        "starred-low": {
          messageId: "starred-low",
          role: "user",
          historyIndex: 1,
          sourceThreadKey: "main",
          routeThreadKey: "main",
          timestamp: 10,
          starredAt: 100,
        },
        "starred-high": {
          messageId: "starred-high",
          role: "assistant",
          historyIndex: 2,
          sourceThreadKey: "main",
          routeThreadKey: "main",
          timestamp: 40,
          starredAt: 101,
        },
      },
    });

    expect(response.results.map((result) => result.messageId)).toEqual(["starred-low", "starred-high"]);
    expect(response.results.every((result) => result.starred)).toBe(true);
    expect(response.results.map((result) => result.messageId)).not.toContain("unstarred");
  });
});

// Navigation returns only authoritative identity, never text or an assumed complete client corpus.
it("resolves an exact old message's owner with the same root-feed projection used by search", () => {
  const source = assistant("old-source", "A repeated phrase", 1, "q-42");
  const recent = assistant("recent", "A repeated phrase", 2);
  expect(resolveSessionMessageTarget([source, recent], "old-source", true)).toEqual({
    messageId: "old-source",
    threadKey: "q-42",
  });
  expect(resolveSessionMessageTarget([source], "old-source", false)?.threadKey).toBe("main");
  expect(resolveSessionMessageTarget([source], "missing", true)).toBeNull();
});
it("does not expose a child-only message as a normal feed navigation target", () => {
  const child = assistant("child-source", "Private child text", 1);
  child.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
  expect(resolveSessionMessageTarget([child], "child-source", true)).toBeNull();
});
