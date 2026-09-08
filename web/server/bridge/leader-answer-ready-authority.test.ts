import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../session-types.js";
import { leaderAnswerThreadAuthority, finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";
import { displayOnlyLeaderAnswerThreads } from "./leader-answer-ready-authority.js";

type AssistantEntry = Extract<BrowserIncomingMessage, { type: "assistant" }>;
type UserEntry = Extract<BrowserIncomingMessage, { type: "user_message" }>;

function request(userMessageId: string, threadKey: string, associatedThreads: string[] = []): UserEntry {
  return {
    type: "user_message",
    id: `raw-${userMessageId}`,
    leaderUserMessageId: userMessageId,
    leaderResponseCoverageVersion: 1,
    content: `Request ${userMessageId}`,
    timestamp: 1,
    threadKey,
    ...(threadKey === "main" ? {} : { questId: threadKey }),
    threadRefs: [
      ...(threadKey === "main" ? [] : [{ threadKey, questId: threadKey, source: "explicit" as const }]),
      ...associatedThreads.map((associated) => ({
        threadKey: associated,
        questId: associated,
        source: "backfill" as const,
      })),
    ],
  };
}

function answer(
  session: { id: string; messageHistory: BrowserIncomingMessage[] },
  id: string,
  userMessageIds: string[],
  threadKey: string,
): AssistantEntry {
  const entry: AssistantEntry = {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "The referenced requests are complete." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 10,
    threadKey,
    ...(threadKey === "main"
      ? {}
      : {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }],
        }),
    leaderThreadRole: "answer",
    leaderAnswerUserMessageIds: userMessageIds,
    leaderAnswerObservedHistoryLength: session.messageHistory.length,
  };
  session.messageHistory.push(entry);
  expect(finalizeRoutedLeaderResponseMessage(session, entry)).toMatchObject({ finalized: true });
  return entry;
}

describe("automatic answer Ready authority", () => {
  it("allows the actual owners while excluding authored and associated display-only destinations", () => {
    // Metadata comes from normal finalization so this covers the same owner
    // proof and visibility refs the live and recovered bridge paths consume.
    const session = {
      id: "leader",
      messageHistory: [
        request("u1", "main", ["q-3"]),
        request("u2", "q-1"),
        request("u3", "q-2"),
      ] as BrowserIncomingMessage[],
    };
    const grouped = answer(session, "grouped-answer", ["u3", "u1", "u2"], "q-4");

    expect(leaderAnswerThreadAuthority(session, grouped).ownerThreadKeys).toEqual(["main", "q-1", "q-2"]);
    expect(displayOnlyLeaderAnswerThreads(session, [grouped])).toEqual(new Set(["q-4", "q-3"]));
  });

  it("does not let a Main-authored quest answer grant Main Ready authority", () => {
    // Main is a legitimate answer destination without owning this request.
    const session = { id: "leader", messageHistory: [request("u1", "q-42")] as BrowserIncomingMessage[] };
    const fromMain = answer(session, "main-authored", ["u1"], "main");

    expect(leaderAnswerThreadAuthority(session, fromMain).ownerThreadKeys).toEqual(["q-42"]);
    expect(displayOnlyLeaderAnswerThreads(session, [fromMain])).toEqual(new Set(["main"]));
  });

  it("combines current owner coverage across answer segments without reviving superseded coverage", () => {
    // The first row remains presentable after its quest coverage is superseded.
    // Only including the newer owning row grants that quest Ready authority.
    const session = {
      id: "leader",
      messageHistory: [request("u1", "main"), request("u2", "q-42")] as BrowserIncomingMessage[],
    };
    const earlier = answer(session, "earlier-answer", ["u1", "u2"], "main");
    const later = answer(session, "later-answer", ["u2"], "q-42");

    expect(leaderAnswerThreadAuthority(session, earlier).ownerThreadKeys).toEqual(["main"]);
    expect(displayOnlyLeaderAnswerThreads(session, [earlier])).toEqual(new Set(["q-42"]));
    expect(displayOnlyLeaderAnswerThreads(session, [earlier, later])).toEqual(new Set());
  });

  it("keeps fully superseded answer destinations display-only across same-turn complementary answers", () => {
    // An earlier Main-authored answer remains visible after a later quest
    // answer owns the same request. A sibling Main Ready must stay blocked.
    const session = {
      id: "leader",
      messageHistory: [request("u1", "q-42")] as BrowserIncomingMessage[],
    };
    const earlier = answer(session, "main-answer", ["u1"], "main");
    const later = answer(session, "quest-complement", ["u1"], "q-42");

    expect(leaderAnswerThreadAuthority(session, earlier)).toEqual({
      ownerThreadKeys: [],
      visibleThreadKeys: ["main", "q-42"],
    });
    expect(leaderAnswerThreadAuthority(session, later)).toEqual({
      ownerThreadKeys: ["q-42"],
      visibleThreadKeys: ["q-42"],
    });
    expect(displayOnlyLeaderAnswerThreads(session, [earlier, later])).toEqual(new Set(["main"]));

    const restored = JSON.parse(JSON.stringify(session)) as typeof session;
    expect(displayOnlyLeaderAnswerThreads(restored, restored.messageHistory.slice(1) as AssistantEntry[])).toEqual(
      new Set(["main"]),
    );
  });

  it("reconstructs display-only authority on replay and rejects stale owner proof", () => {
    // Persisted snapshots must stay authoritative after restart, and a later
    // request reassignment must not silently become permission to mark Ready.
    const session = {
      id: "leader",
      messageHistory: [request("u1", "q-42", ["q-99"])] as BrowserIncomingMessage[],
    };
    answer(session, "replayed-answer", ["u1"], "main");
    const replayed = JSON.parse(JSON.stringify(session)) as typeof session;
    const replayedAnswer = replayed.messageHistory[1] as AssistantEntry;
    expect(displayOnlyLeaderAnswerThreads(replayed, [replayedAnswer])).toEqual(new Set(["main", "q-99"]));

    const reassigned = replayed.messageHistory[0] as UserEntry;
    reassigned.threadRefs?.push({ threadKey: "q-43", questId: "q-43", source: "explicit", attachedAt: 20 });
    expect(leaderAnswerThreadAuthority(replayed, replayedAnswer)).toEqual({
      ownerThreadKeys: [],
      visibleThreadKeys: [],
    });
    expect(displayOnlyLeaderAnswerThreads(replayed, [replayedAnswer])).toEqual(new Set());
  });
});
