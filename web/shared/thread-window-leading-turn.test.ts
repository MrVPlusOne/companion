import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import { buildLeaderThreadResponseState } from "../server/leader-thread-response.js";
import { isUserBoundaryEntry } from "../src/hooks/use-feed-model.js";
import { normalizeHistoryMessageToChatMessages } from "../src/utils/history-message-normalization.js";
import { LEADER_KICKOFF_PREFIX } from "./injected-event-message.js";
import { buildThreadWindowSync } from "./thread-window.js";

const THREAD_KEY = "q-1";

function user(id: string, sourceId?: string): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id,
    content: id,
    timestamp: 1,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" }],
    ...(sourceId ? { agentSource: { sessionId: sourceId, sessionLabel: sourceId } } : {}),
  };
}

function assistant(id: string): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp: 2,
    parent_tool_use_id: null,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" }],
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: id }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function injectedHistory(prefix: BrowserIncomingMessage[], count = 100): BrowserIncomingMessage[] {
  return [
    ...prefix,
    ...Array.from({ length: count }, (_, index) => [
      user(`trigger-${index}`, "herd-events"),
      assistant(`activity-${index}`),
    ]).flat(),
  ];
}

function windowFor(messageHistory: BrowserIncomingMessage[], fromItem: number, itemCount: number) {
  return buildThreadWindowSync({
    messageHistory,
    threadKey: THREAD_KEY,
    fromItem,
    itemCount,
    sectionItemCount: 10,
    visibleItemCount: 3,
  });
}

describe("selected thread leading-turn identity", () => {
  it("keeps one human identity across overlapping injected-heavy windows without backfilling its prompt", () => {
    // Each injected user starts a server range, while all activity remains one frontend human turn.
    const history = injectedHistory([user("human-request")]);
    for (const [fromItem, itemCount] of [
      [61, 30],
      [31, 60],
      [41, 60],
      [11, 90],
    ]) {
      const sync = windowFor(history, fromItem!, itemCount!);
      expect(sync.window.leading_turn_id).toBe("human-request");
      expect(sync.window).toMatchObject({ from_item: fromItem, item_count: itemCount, total_items: 101 });
      expect(
        sync.entries.some((entry) => entry.message.type === "user_message" && entry.message.id === "human-request"),
      ).toBe(false);
    }
    // Loading the actual boundary uses exactly the same id as the ordinary frontend turn.
    expect(windowFor(history, 0, 101).window.leading_turn_id).toBe("human-request");
  });

  it("uses a stable full-source prefix when the thread has no human boundary", () => {
    const kickoff = { ...user("source-kickoff"), content: LEADER_KICKOFF_PREFIX };
    const history = injectedHistory([kickoff]);
    for (const [fromItem, itemCount] of [
      [61, 30],
      [31, 60],
      [0, 101],
    ]) {
      expect(windowFor(history, fromItem!, itemCount!).window.leading_turn_id).toBe("turn-a-source-kickoff");
    }
  });

  it("keeps proven assistant and legacy sourced-user prefix ids aligned with browser normalization", () => {
    const origins = [assistant("assistant-origin"), { ...user("legacy-origin", "herd-events"), id: undefined }];
    for (const origin of origins) {
      const [normalized] = normalizeHistoryMessageToChatMessages(origin, 0);
      const history = injectedHistory([origin], 8);
      expect(windowFor(history, 0, 3).window.leading_turn_id).toBe(`turn-a-${normalized!.id}`);
      expect(windowFor(history, 3, 3).window.leading_turn_id).toBe(`turn-a-${normalized!.id}`);
    }
  });

  it.each<BrowserIncomingMessage>([
    { type: "error", message: "Earlier diagnostic" },
    { type: "compact_marker", timestamp: 1 },
    {
      type: "task_notification",
      task_id: "background-task",
      tool_use_id: "tool",
      status: "completed",
      summary: "Done",
    },
  ])("omits an unproven $type prefix identity while retaining later human identity", (source) => {
    // These system rows normalize to ids other than raw history fallbacks. Do not
    // guess a prefix identity or borrow a later activity row as its origin.
    const origin = { ...source, threadKey: THREAD_KEY, questId: THREAD_KEY };
    const history = injectedHistory([origin], 8);
    expect(normalizeHistoryMessageToChatMessages(origin, 0)).toHaveLength(1);
    expect(windowFor(history, 0, 3).window.leading_turn_id).toBeUndefined();
    expect(windowFor(history, 3, 3).window.leading_turn_id).toBeUndefined();

    const later = [...history, user("later-human"), user("later-trigger", "herd-events"), assistant("later-activity")];
    const withBoundary = windowFor(later, 9, 2);
    expect(
      withBoundary.entries.some((entry) => entry.message.type === "user_message" && entry.message.id === "later-human"),
    ).toBe(true);
    expect(withBoundary.window.leading_turn_id).toBe("later-human");
    expect(windowFor(later, -1, 1).window.leading_turn_id).toBe("later-human");
  });

  it("matches the frontend boundary classifier for human, injected, and legacy kickoff inputs", () => {
    // Keep producer identity aligned with the established FE semantics rather than changing grouping.
    const candidates = [
      user("next-human"),
      user("worker-input", "worker"),
      user("herd-input", "herd-events"),
      user("recovery-input", "system:compaction-recovery"),
      { ...user("legacy-kickoff"), content: LEADER_KICKOFF_PREFIX },
    ];
    for (const candidate of candidates) {
      const [normalized] = normalizeHistoryMessageToChatMessages(candidate, 1);
      const isBoundary = isUserBoundaryEntry({ kind: "message", msg: normalized! });
      const sync = windowFor(
        [user("first-human"), candidate, user("tail-trigger", "herd-events"), assistant("tail")],
        2,
        1,
      );
      expect(sync.window.leading_turn_id).toBe(isBoundary ? candidate.id : "first-human");
    }
  });

  it("does not borrow a human boundary from another thread", () => {
    // Unrelated raw chronology is not membership in the selected thread's projected source stream.
    const foreign = { ...user("foreign-human"), threadKey: "q-2", questId: "q-2", threadRefs: [] };
    const history = injectedHistory([user("local-human"), foreign], 4);
    expect(windowFor(history, 2, 2).window.leading_turn_id).toBe("local-human");
  });

  it("omits the hint when tool support joins two human turns without their intervening boundary", () => {
    const tool = assistant("tool-start");
    tool.message.content.push({ type: "tool_use", id: "background-tool", name: "Task", input: {} });
    const callback = { ...assistant("later-callback"), parent_tool_use_id: "background-tool" };
    const history = [user("first-human"), user("first-trigger", "herd-events"), tool, user("second-human"), callback];
    const sync = windowFor(history, 1, 1);
    // The real closure producer adds the later callback, but its human boundary is outside this window.
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2, 4]);
    expect(sync.window.leading_turn_id).toBeUndefined();
  });

  it("omits the hint for foreign answer proof outside the projected source stream", () => {
    const prompt = {
      ...user("attached-human"),
      threadKey: "main",
      questId: undefined,
      threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" as const, attachedAt: 2 }],
      leaderUserMessageId: "u1",
      leaderResponseCoverageVersion: 1 as const,
    };
    const answer = {
      ...assistant("main-answer"),
      threadKey: "main",
      questId: undefined,
      threadRefs: [],
      leaderThreadRole: "answer" as const,
      threadAnswer: { version: 2 as const, answerUserMessageIds: ["u1"], observedHistoryLength: 1 },
    };
    const history = [prompt, answer, user("latest-trigger", "herd-events"), assistant("latest-activity")];
    const projection = buildLeaderThreadResponseState({ id: "leader", messageHistory: history }, THREAD_KEY).projection;
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: THREAD_KEY,
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 10,
      visibleItemCount: 3,
      currentThreadResponseProjection: projection,
    });
    // This valid response proof preserves the answer's Main ownership and does not become turn-identity authority.
    expect(sync.threadResponseSupportComplete).toBe(true);
    expect(
      sync.entries.some((entry) => entry.message.type === "assistant" && entry.message.message.id === "main-answer"),
    ).toBe(true);
    expect(sync.window.leading_turn_id).toBeUndefined();
  });
});
