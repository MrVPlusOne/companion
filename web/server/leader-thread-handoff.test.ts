import { describe, expect, it } from "vitest";
import { parseThreadStatusMarkerLine, type LeaderThreadStatus } from "../shared/thread-status-marker.js";
import { prepareLeaderThreadHandoff } from "./leader-thread-handoff.js";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
  type LeaderThreadResponseSession,
} from "./leader-thread-response.js";
import {
  clearLeaderThreadStatusForCoveredUserMessage,
  updateLeaderThreadStatusesForAssistantOutput,
} from "./bridge/thread-routing-reminder.js";
import type { BrowserIncomingMessage, SessionNotification } from "./session-types.js";

type UserMessage = Extract<BrowserIncomingMessage, { type: "user_message" }>;

function human(userMessageId: string, threadKey = "main"): UserMessage {
  return {
    type: "user_message",
    id: `raw-${userMessageId}`,
    leaderUserMessageId: userMessageId,
    leaderResponseCoverageVersion: 1,
    content: `Request ${userMessageId}`,
    timestamp: Number(userMessageId.slice(1)),
    threadKey,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit", attachedAt: 1 }] }),
  };
}

function session(...messages: BrowserIncomingMessage[]) {
  return {
    id: "leader",
    messageHistory: messages,
    state: { leaderThreadStatuses: {} as Record<string, LeaderThreadStatus> },
  };
}

function moveRequests(target: LeaderThreadResponseSession, userMessageIds: string[], questId = "q-42") {
  const prepared = prepareLeaderThreadHandoff(target, questId, userMessageIds);
  if (!prepared.ok) throw new Error(prepared.error);
  for (const request of prepared.requests) {
    request.message.threadRefs = [
      ...(request.message.threadRefs ?? []),
      { threadKey: questId, questId, source: "explicit", attachedAt: 100, attachedBy: target.id },
    ];
  }
  return prepared;
}

function appendAnswer(target: LeaderThreadResponseSession, userMessageIds: string[], threadKey = "main") {
  const answer: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
    type: "assistant",
    message: {
      id: `answer-${target.messageHistory.length}`,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "The referenced requests are complete." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 200,
    threadKey,
    leaderThreadRole: "answer",
    leaderAnswerUserMessageIds: userMessageIds,
    leaderAnswerObservedHistoryLength: target.messageHistory.length,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit", attachedAt: 200 }] }),
  };
  target.messageHistory.push(answer);
  expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({ finalized: true });
  return answer;
}

function readyMarker(threadKey: string) {
  return parseThreadStatusMarkerLine(`{[(Thread Ready: ${threadKey} | complete)]}`)!;
}

describe("Main-to-quest request handoff preparation", () => {
  it("selects only the exact pending IDs without changing source rows or visibility-only associations", () => {
    // Existing backfill gives quest visibility but still requires a real ownership transfer.
    const target = session(human("u1"), human("u2"), human("u3"));
    const first = target.messageHistory[0] as UserMessage;
    first.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 10 }];
    const before = structuredClone(target);
    const prepared = prepareLeaderThreadHandoff(target, "q-42", ["u3", "u1"]);

    expect(prepared).toMatchObject({
      ok: true,
      requests: [
        { userMessageId: "u3", historyMessageId: "raw-u3", historyIndex: 2 },
        { userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 0 },
      ],
      alreadyHandedOffUserMessageIds: [],
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.requests[1]?.message).toBe(first);
    expect(target).toEqual(before);
  });

  it.each([
    { ids: [] },
    { ids: ["u1", "u1"] },
    { ids: ["u1", "u0"] },
    { ids: ["u1", "raw-u2"] },
    { ids: ["u1", "u99"] },
  ])("rejects invalid selections atomically: $ids", ({ ids }) => {
    // A valid first ID must not be changed when a later member is invalid.
    const target = session(human("u1"), human("u2"));
    const before = structuredClone(target);
    expect(prepareLeaderThreadHandoff(target, "q-42", ids)).toMatchObject({ ok: false });
    expect(target).toEqual(before);
  });

  it.each(["main", "all", "q-invalid"])("rejects an invalid destination %s", (questId) => {
    // Destination authorization belongs to the route; the pure helper still requires its canonical key.
    expect(prepareLeaderThreadHandoff(session(human("u1")), questId, ["u1"])).toMatchObject({ ok: false });
  });

  it.each([
    "covered",
    "quest-owned",
    "route-less",
    "conflicting",
    "malformed-ref",
  ] as const)("rejects a %s request without granting fallback Main ownership", (shape) => {
    // Compatibility presentation fallbacks cannot authorize a durable transfer.
    const second = human("u2", shape === "quest-owned" ? "q-9" : "main");
    if (shape === "route-less") delete second.threadKey;
    if (shape === "conflicting") second.questId = "q-9";
    if (shape === "malformed-ref") {
      second.threadRefs = [{ threadKey: "q-9", questId: "q-8", source: "explicit", attachedAt: 10 }];
    }
    const target = session(human("u1"), second);
    if (shape === "covered") appendAnswer(target, ["u2"]);
    const before = structuredClone(target);

    expect(prepareLeaderThreadHandoff(target, "q-42", ["u1", "u2"])).toMatchObject({ ok: false });
    expect(target).toEqual(before);
  });

  it.each([
    "agent",
    "child",
    "injected",
    "pre-cutover",
    "duplicate-id",
  ] as const)("rejects a %s source as a direct request", (shape) => {
    // The same root/direct-human identity rules used by answers govern handoffs.
    const second = human("u2");
    if (shape === "agent") second.agentSource = { sessionId: "worker" };
    if (shape === "child") second.codexSubagent = { childId: "child", rootTurnId: "root-turn" };
    if (shape === "injected") second.content = "[System] You are a leader session. Recover the active board.";
    if (shape === "pre-cutover") delete second.leaderResponseCoverageVersion;
    const target = session(human("u1"), second);
    if (shape === "duplicate-id") target.messageHistory.push({ ...second, id: "duplicate-raw-u2" });
    const before = structuredClone(target);

    expect(prepareLeaderThreadHandoff(target, "q-42", ["u1", "u2"])).toMatchObject({ ok: false });
    expect(target).toEqual(before);
  });

  it("rejects queued-only requests and leaves their separate Ready blocker intact", () => {
    // Accepted provider input is still Main work until it commits; the handoff cannot rewrite that queue.
    const target = { ...session(human("u1")), pendingCodexInputs: [human("u2")] };
    const before = structuredClone(target);
    expect(prepareLeaderThreadHandoff(target, "q-42", ["u1", "u2"])).toMatchObject({ ok: false });
    expect(target).toEqual(before);
    moveRequests(target, ["u1"]);
    expect(buildLeaderThreadResponseState(target, "main").projection.ready).toBe(true);
    expect(
      updateLeaderThreadStatusesForAssistantOutput(target, [readyMarker("main")], {
        messageId: "notice",
        timestamp: 101,
      }).rejectedReadyRoutes,
    ).toMatchObject([{ threadKey: "main" }]);
  });

  it("recognizes only authenticated same-destination retries, including after an answer", () => {
    // A lost command response can be retried without reopening completed destination work.
    const target = session(human("u1"), human("u2"));
    moveRequests(target, ["u1"]);
    appendAnswer(target, ["u1"], "q-42");
    const restored = JSON.parse(JSON.stringify(target)) as typeof target;
    const before = structuredClone(restored);

    expect(prepareLeaderThreadHandoff(restored, "q-42", ["u1", "u2"])).toMatchObject({
      ok: true,
      requests: [{ userMessageId: "u2" }],
      alreadyHandedOffUserMessageIds: ["u1"],
    });
    expect(prepareLeaderThreadHandoff(restored, "q-42", ["u1"])).toEqual({
      ok: true,
      requests: [],
      alreadyHandedOffUserMessageIds: ["u1"],
    });
    expect(restored).toEqual(before);
    expect(buildLeaderThreadResponseState(restored, "q-42").projection.ready).toBe(true);
  });

  it.each([
    "quest-origin",
    "other-leader",
    "inferred",
    "missing-time",
    "other-destination",
  ] as const)("rejects %s ownership as retry proof", (shape) => {
    // Merely being quest-owned is insufficient proof of this leader's Main handoff.
    const request = human("u1", shape === "quest-origin" ? "q-42" : "main");
    request.threadRefs = [
      {
        threadKey: "q-42",
        questId: "q-42",
        source: shape === "inferred" ? "inferred" : "explicit",
        ...(shape === "missing-time" ? {} : { attachedAt: 100 }),
        attachedBy: shape === "other-leader" ? "other-leader" : "leader",
      },
    ];
    const target = session(request);
    expect(prepareLeaderThreadHandoff(target, shape === "other-destination" ? "q-43" : "q-42", ["u1"])).toMatchObject({
      ok: false,
    });
  });

  it("moves pending authority while preserving unrelated requests and existing cross-thread answers", () => {
    // The earlier answer is authored after the pending request but covers a different ID.
    // Selecting only pending IDs cannot invalidate its immutable owner proof.
    const answered = human("u1");
    answered.threadRefs = [{ threadKey: "q-9", questId: "q-9", source: "backfill", attachedAt: 10 }];
    const moving = human("u2");
    const target = session(answered, moving, human("u3"));
    const answer = appendAnswer(target, ["u1"], "q-9");
    const answerBefore = structuredClone(answer);
    const mainAnswers = buildLeaderThreadResponseState(target, "main").projection.currentAnswers;
    const associatedAnswers = buildLeaderThreadResponseState(target, "q-9").projection.currentAnswers;
    moveRequests(target, ["u2"]);

    expect(target.messageHistory[1]).toBe(moving);
    expect(moving).toMatchObject({ id: "raw-u2", content: "Request u2", timestamp: 2, threadKey: "main" });
    for (const current of [target, JSON.parse(JSON.stringify(target)) as typeof target]) {
      expect(buildLeaderThreadResponseState(current, "main").projection).toMatchObject({
        pendingMessages: [{ userMessageId: "u3" }],
        ready: false,
        currentAnswers: mainAnswers,
      });
      expect(buildLeaderThreadResponseState(current, "q-42").projection).toMatchObject({
        pendingMessages: [{ userMessageId: "u2", historyMessageId: "raw-u2", historyIndex: 1 }],
        ready: false,
        currentAnswers: [],
      });
      expect(buildLeaderThreadResponseState(current, "q-9").projection.currentAnswers).toEqual(associatedAnswers);
    }
    expect(answer).toEqual(answerBefore);
  });

  it("clears stale destination status and keeps destination Ready blocked until substantive completion", () => {
    // The route will use this existing activity hook when transferred ownership arrives.
    const target = session(human("u1"));
    target.state.leaderThreadStatuses["q-42"] = {
      ...readyMarker("q-42"),
      threadKey: "q-42",
      questId: "q-42",
      messageId: "old-ready",
      timestamp: 0,
      updatedAt: 0,
    };
    const moved = moveRequests(target, ["u1"]).requests[0]!;
    expect(clearLeaderThreadStatusForCoveredUserMessage(target, moved.message)).toBe(true);
    expect(target.state.leaderThreadStatuses["q-42"]).toBeUndefined();
    const status = updateLeaderThreadStatusesForAssistantOutput(target, [readyMarker("main"), readyMarker("q-42")], {
      messageId: "handoff-notice",
      timestamp: 101,
    });
    expect(status.records).toMatchObject([{ threadKey: "main", kind: "ready" }]);
    expect(status.rejectedReadyRoutes).toMatchObject([{ threadKey: "q-42" }]);
    expect(target.state.leaderThreadStatuses["q-42"]).toBeUndefined();
    const answer = appendAnswer(target, ["u1"], "q-42");
    expect(
      updateLeaderThreadStatusesForAssistantOutput(target, [readyMarker("q-42")], {
        messageId: answer.message.id,
        timestamp: answer.timestamp!,
      }).records,
    ).toMatchObject([{ threadKey: "q-42", kind: "ready" }]);
  });

  it("does not resolve or reroute an existing Main user decision", () => {
    // Notification authority is independent; moving a request is not an answer to its pending decision.
    const notification: SessionNotification = {
      id: "decision",
      category: "needs-input",
      summary: "Choose an approach",
      timestamp: 10,
      messageId: null,
      done: false,
      threadKey: "main",
    };
    const target = { ...session(human("u1")), notifications: [notification] };
    const before = structuredClone(notification);
    moveRequests(target, ["u1"]);
    expect(
      updateLeaderThreadStatusesForAssistantOutput(target, [readyMarker("main")], {
        messageId: "notice",
        timestamp: 101,
      }).rejectedReadyRoutes,
    ).toMatchObject([{ threadKey: "main" }]);
    expect(notification).toEqual(before);
  });
});
