import { describe, expect, it, vi } from "vitest";
import { handleResultMessage, type ResultMessageSessionLike } from "./claude-message-controller.js";
import type { BrowserIncomingMessage, CLIResultMessage, PermissionRequest, SessionState } from "../session-types.js";
import { THREAD_ROUTING_REMINDER_SOURCE_ID } from "../../shared/thread-routing-reminder.js";
import {
  QUEST_THREAD_REMINDER_SOURCE_ID,
  QUEST_THREAD_REMINDER_SOURCE_LABEL,
} from "../../shared/quest-thread-reminder.js";
import { buildLeaderThreadResponseState, finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";

function makeState(): ResultMessageSessionLike["state"] {
  return {
    model: "claude-sonnet-4-5-20250929",
    total_cost_usd: 0,
    user_turn_count: 0,
    agent_turn_count: 0,
    num_turns: 0,
    context_used_percent: 0,
    claude_token_details: undefined,
    leaderThreadStatuses: undefined,
  };
}

function makeSession(): ResultMessageSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    cliResuming: false,
    messageHistory: [],
    notifications: [],
    leaderThreadOutcomeValidatedHistoryLength: 0,
    state: makeState(),
    diffStatsDirty: false,
    generationStartedAt: undefined,
    messageCountAtTurnStart: 0,
    interruptedDuringTurn: false,
    queuedTurnStarts: 0,
    queuedTurnInterruptSources: [],
    userMessageIdsThisTurn: [],
    isGenerating: false,
    lastOutboundUserNdjson: null,
    pendingPermissions: new Map<string, PermissionRequest>(),
    toolStartTimes: new Map(),
  };
}

function makeResult(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 1,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    uuid: "result-1",
    session_id: "s1",
    ...overrides,
  };
}

function makeAssistant(id: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: Date.now(),
  };
}

function directUser(
  id: string,
  content = id,
  options: { threadKey?: string; associatedThreadKeys?: string[] } = {},
): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  const threadKey = options.threadKey ?? "main";
  return {
    type: "user_message",
    id,
    leaderUserMessageId: /^u[1-9]\d*$/.test(id) ? id : undefined,
    content,
    timestamp: 1,
    threadKey,
    ...(threadKey === "main" ? {} : { questId: threadKey }),
    threadRefs: [
      ...(threadKey === "main" ? [] : [{ threadKey, questId: threadKey, source: "explicit" as const, attachedAt: 1 }]),
      ...(options.associatedThreadKeys ?? []).map((associatedThreadKey) => ({
        threadKey: associatedThreadKey,
        questId: associatedThreadKey,
        source: "backfill" as const,
        attachedAt: 2,
      })),
    ],
    leaderResponseCoverageVersion: 1,
  };
}

function routedFinal(
  id: string,
  observedHistoryLength: number,
  options: {
    role?: "commentary" | "answer";
    ready?: boolean;
    readyThreadKey?: string;
    text?: string;
    answerIds?: string[];
    threadKey?: string;
  } = {},
): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  const role = options.role ?? "answer";
  const threadKey = options.threadKey ?? "main";
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [{ type: "text", text: options.text ?? "Polished answer." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 20,
    threadKey,
    ...(threadKey === "main"
      ? {}
      : {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit", attachedAt: 20 }],
        }),
    leaderThreadRole: role,
    ...(role === "answer"
      ? {
          leaderAnswerUserMessageIds: options.answerIds ?? ["u1"],
          leaderAnswerObservedHistoryLength: observedHistoryLength,
        }
      : {}),
    ...(options.ready
      ? {
          deferredThreadStatusMarkers: [
            {
              kind: "ready",
              label: "Thread Ready",
              target:
                (options.readyThreadKey ?? threadKey) === "main"
                  ? { threadKey: "main" }
                  : {
                      threadKey: options.readyThreadKey ?? threadKey,
                      questId: options.readyThreadKey ?? threadKey,
                    },
              summary: "answer complete",
              raw: "{[(Thread Ready: main | answer complete)]}",
              lineIndex: 1,
            },
          ],
        }
      : {}),
  };
}

function makeDeps() {
  return {
    hasResultReplay: vi.fn(() => false),
    reconcileReplayState: vi.fn(() => ({ clearedResidualState: false })),
    drainInlineQueuedClaudeTurns: vi.fn(() => false),
    markTurnInterrupted: vi.fn(),
    getCurrentTurnTriggerSource: vi.fn((): "user" | "leader" | "system" | "unknown" => "user"),
    reconcileTerminalResultState: vi.fn(),
    finalizeOrphanedTerminalToolsOnResult: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    freezeHistoryThroughCurrentTail: vi.fn(),
    cancelPermissionNotification: vi.fn(),
    onSessionActivityStateChanged: vi.fn(),
    onResultAttentionAndNotifications: vi.fn(),
    validateLeaderThreadOutcomes: vi.fn(),
    onTurnCompleted: vi.fn(),
    injectUserMessage: vi.fn(),
    refreshSessionConversation: vi.fn(),
    invalidateLeaderThreadTabsForSession: vi.fn(),
  };
}

describe("result-message-controller", () => {
  // Replayed terminal results after reconnect should only reconcile lifecycle drift;
  // they must not append duplicate result history or retrigger normal completion flow.
  it("reconciles replayed results without appending duplicate history", () => {
    const session = makeSession();
    const deps = makeDeps();
    deps.hasResultReplay.mockReturnValue(true);
    deps.reconcileReplayState.mockReturnValue({ clearedResidualState: true });

    handleResultMessage(session, makeResult(), deps);

    expect(session.messageHistory).toHaveLength(0);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "status_change", status: "idle" }),
    );
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.onTurnCompleted).not.toHaveBeenCalled();
  });

  // Covers the normal result path where stale pending permissions are cancelled,
  // the result is persisted, and downstream notification hooks still fire once.
  it("appends the result, clears stale permissions, and notifies downstream handlers", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1,
    } as BrowserIncomingMessage);
    session.pendingPermissions.set("perm-1", {
      request_id: "perm-1",
      tool_name: "Bash",
      input: { command: "pwd" },
      tool_use_id: "tool-1",
      timestamp: 1,
    });
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ total_cost_usd: 2 }), deps);

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ total_cost_usd: 2 }),
      }),
    );
    expect(deps.cancelPermissionNotification).toHaveBeenCalledWith("s1", "perm-1");
    expect(deps.onSessionActivityStateChanged).toHaveBeenCalledWith("s1", "result_cleared_permissions");
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
  });

  it("stamps a routed answer before accepting Ready from the same assistant row", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"));
    const response = routedFinal("final-ready", 1, { ready: true });
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [0];
    session.messageCountAtTurnStart = 1;
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "final-ready-result" }), deps);

    expect(response.threadAnswer).toEqual({
      version: 2,
      answerUserMessageIds: ["u1"],
      observedHistoryLength: 1,
      authoredThreadKey: "main",
      ownerGroups: [{ threadKey: "main", userMessageIds: ["u1"] }],
    });
    expect(session.state.leaderThreadStatuses?.main).toMatchObject({ kind: "ready", messageId: "final-ready" });
    expect(buildLeaderThreadResponseState(session, "main").projection).toMatchObject({
      ready: true,
      pendingMessageCount: 0,
    });
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user");
    expect(deps.invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(session.id);
    expect(deps.refreshSessionConversation).toHaveBeenCalledWith(session.id);
  });

  it("canonicalizes a misrouted result row before broadcasting owner-only coverage", () => {
    // The server must reuse and rebroadcast the existing response row rather
    // than asking the model to reproduce a long accepted-Work explanation.
    const session = makeSession();
    session.messageHistory.push(
      directUser("u37", "Original request", { threadKey: "q-2042", associatedThreadKeys: ["q-2044"] }),
      directUser("u38", "Approval", { threadKey: "q-2042", associatedThreadKeys: ["q-2044"] }),
    );
    const response = routedFinal("canonical-result", 2, {
      threadKey: "q-2044",
      answerIds: ["u37", "u38"],
      text: "The approved behavior is implemented and synchronized.",
    });
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [];
    session.messageCountAtTurnStart = 2;
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "canonical-result-turn" }), deps);

    expect(response).toMatchObject({
      threadKey: "q-2042",
      questId: "q-2042",
      threadAnswer: { answerUserMessageIds: ["u37", "u38"] },
      threadRefs: [
        { threadKey: "q-2042", questId: "q-2042", source: "explicit" },
        { threadKey: "q-2044", questId: "q-2044", source: "backfill" },
      ],
    });
    expect(response.threadRoutingError).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "q-2042").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, "q-2044").projection.currentAnswers).toMatchObject([
      { currentMessageId: "canonical-result", threadKey: "q-2042" },
    ]);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, response, { skipBuffer: true });
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("keeps Ready on the owner and rejects display-thread Ready during canonicalization", () => {
    const accepted = makeSession();
    accepted.messageHistory.push(directUser("u1", "Request", { threadKey: "q-1", associatedThreadKeys: ["q-2"] }));
    const ownerReady = routedFinal("owner-ready", 1, {
      threadKey: "q-2",
      ready: true,
      readyThreadKey: "q-1",
    });
    accepted.messageHistory.push(ownerReady);
    accepted.userMessageIdsThisTurn = [0];
    const acceptedDeps = makeDeps();

    handleResultMessage(accepted, makeResult({ uuid: "owner-ready-result" }), acceptedDeps);

    expect(ownerReady.threadAnswer).toBeDefined();
    expect(accepted.state.leaderThreadStatuses?.["q-1"]).toMatchObject({ kind: "ready" });
    expect(accepted.state.leaderThreadStatuses?.["q-2"]).toBeUndefined();

    const rejected = makeSession();
    rejected.messageHistory.push(directUser("u1", "Request", { threadKey: "q-1", associatedThreadKeys: ["q-2"] }));
    const displayReady = routedFinal("display-ready", 1, {
      threadKey: "q-2",
      ready: true,
      readyThreadKey: "q-2",
    });
    rejected.messageHistory.push(displayReady);
    rejected.userMessageIdsThisTurn = [0];
    const rejectedDeps = makeDeps();

    handleResultMessage(rejected, makeResult({ uuid: "display-ready-result" }), rejectedDeps);

    expect(displayReady.threadAnswer).toMatchObject({
      answerUserMessageIds: ["u1"],
      authoredThreadKey: "q-2",
      ownerGroups: [{ threadKey: "q-1", userMessageIds: ["u1"] }],
    });
    expect(displayReady.threadRoutingError).toBeUndefined();
    expect(rejected.state.leaderThreadStatuses?.["q-1"]).toBeUndefined();
    expect(rejected.state.leaderThreadStatuses?.["q-2"]).toBeUndefined();
    expect(rejectedDeps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(rejected, "user", ["q-2"]);
  });

  it("rejects sibling Ready on a canonicalized display-only thread", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1", "Request", { threadKey: "q-1", associatedThreadKeys: ["q-2"] }));
    const displayReady = routedFinal("display-ready-commentary", 1, {
      role: "commentary",
      threadKey: "q-2",
      ready: true,
      readyThreadKey: "q-2",
      text: "The associated quest is complete.",
    });
    const canonicalized = routedFinal("canonicalized-answer", 1, {
      threadKey: "q-2",
      answerIds: ["u1"],
      text: "The requested implementation is complete.",
    });
    session.messageHistory.push(displayReady, canonicalized);
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "sibling-display-ready-result" }), deps);

    expect(canonicalized).toMatchObject({
      threadKey: "q-1",
      threadAnswer: { answerUserMessageIds: ["u1"] },
    });
    expect(session.state.leaderThreadStatuses?.["q-2"]).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user", ["q-2"]);
  });

  it("allows sibling Ready when the selected thread also owns current answer coverage in the turn", () => {
    const session = makeSession();
    session.messageHistory.push(
      directUser("u1", "Associated request", { threadKey: "q-1", associatedThreadKeys: ["q-2"] }),
      directUser("u2", "Owned request", { threadKey: "q-2" }),
    );
    const ready = routedFinal("owned-ready-commentary", 2, {
      role: "commentary",
      threadKey: "q-2",
      ready: true,
      readyThreadKey: "q-2",
      text: "Both requests are complete.",
    });
    const canonicalized = routedFinal("associated-answer", 2, {
      threadKey: "q-2",
      answerIds: ["u1"],
      text: "The associated request is complete.",
    });
    const owned = routedFinal("owned-answer", 2, {
      threadKey: "q-2",
      answerIds: ["u2"],
      text: "The owned request is complete.",
    });
    session.messageHistory.push(ready, canonicalized, owned);
    session.userMessageIdsThisTurn = [0, 1];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "sibling-owner-ready-result" }), deps);

    expect(canonicalized.threadKey).toBe("q-1");
    expect(owned.threadKey).toBe("q-2");
    expect(session.state.leaderThreadStatuses?.["q-2"]).toMatchObject({
      kind: "ready",
      messageId: ready.message.id,
    });
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user");
  });

  it("rejects display-only Main Ready after a same-turn answer is fully superseded", () => {
    // The first answer remains visible in Main after the later quest answer
    // takes current coverage. Losing current coverage must not grant Main Ready.
    const session = makeSession();
    session.messageHistory.push(directUser("u1", "Quest request", { threadKey: "q-42" }));
    const ready = routedFinal("main-ready-commentary", 1, {
      role: "commentary",
      threadKey: "main",
      ready: true,
    });
    const first = routedFinal("main-authored-answer", 1, {
      threadKey: "main",
      answerIds: ["u1"],
      text: "The requested change is implemented.",
    });
    const later = routedFinal("quest-complementary-answer", 1, {
      threadKey: "q-42",
      answerIds: ["u1"],
      text: "The requested change is now synchronized too.",
    });
    session.messageHistory.push(ready, first, later);
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "superseded-main-ready-result" }), deps);

    expect(first.threadAnswer).toMatchObject({ authoredThreadKey: "main" });
    expect(later.threadAnswer).toMatchObject({ authoredThreadKey: "q-42" });
    expect(buildLeaderThreadResponseState(session, "main").projection.currentAnswers).toMatchObject([
      { currentMessageId: first.message.id, coveredAnswerUserMessageIds: [] },
    ]);
    expect(buildLeaderThreadResponseState(session, "q-42").projection.currentAnswers).toMatchObject([
      { currentMessageId: first.message.id, coveredAnswerUserMessageIds: [] },
      { currentMessageId: later.message.id, coveredAnswerUserMessageIds: ["u1"] },
    ]);
    expect(session.state.leaderThreadStatuses?.main).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user", ["main"]);
  });

  it.each([
    { extraOwner: "q-9", questReady: true },
    { extraOwner: "q-1", questReady: false },
  ])("settles one mixed-owner answer while preserving pending work in $extraOwner", ({ extraOwner, questReady }) => {
    // Producer-shaped root rows cover nonconsecutive IDs from Main and a quest.
    // Ready appears before the answer, including a display-only sibling marker.
    const session = makeSession();
    session.messageHistory.push(
      directUser("u1", "Main request", { associatedThreadKeys: ["q-8"] }),
      directUser("u2", "Unanswered request", { threadKey: extraOwner }),
      directUser("u3", "Quest request", { threadKey: "q-1" }),
    );
    for (const threadKey of ["main", "q-1", "q-8"]) {
      session.messageHistory.push(
        routedFinal(`ready-${threadKey}`, 3, {
          role: "commentary",
          threadKey,
          ready: true,
          text: "The answered requests are complete.",
        }),
      );
    }
    const response = routedFinal("shared-mixed-answer", 3, {
      threadKey: "q-8",
      answerIds: ["u1", "u3"],
      text: "Both requested changes are implemented.",
    });
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [0, 1, 2];
    session.messageCountAtTurnStart = 3;
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "shared-mixed-result" }), deps);

    expect(response).toMatchObject({
      message: {
        id: "shared-mixed-answer",
        content: [{ type: "text", text: "Both requested changes are implemented." }],
      },
      threadKey: "main",
      threadAnswer: {
        answerUserMessageIds: ["u1", "u3"],
        authoredThreadKey: "q-8",
        ownerGroups: [
          { threadKey: "main", userMessageIds: ["u1"] },
          { threadKey: "q-1", userMessageIds: ["u3"] },
        ],
      },
    });
    expect(response.threadRoutingError).toBeUndefined();
    for (const [threadKey, coveredIds] of [
      ["main", ["u1"]],
      ["q-1", ["u3"]],
      ["q-8", []],
    ] as const) {
      expect(buildLeaderThreadResponseState(session, threadKey).projection.currentAnswers).toMatchObject([
        { currentMessageId: response.message.id, coveredAnswerUserMessageIds: coveredIds },
      ]);
    }
    expect(buildLeaderThreadResponseState(session, extraOwner).projection.pendingMessages).toMatchObject([
      { userMessageId: "u2" },
    ]);
    expect(session.state.leaderThreadStatuses?.main).toMatchObject({ kind: "ready" });
    if (questReady) {
      expect(session.state.leaderThreadStatuses?.["q-1"]).toMatchObject({ kind: "ready" });
    } else {
      expect(session.state.leaderThreadStatuses?.["q-1"]).toBeUndefined();
    }
    expect(session.state.leaderThreadStatuses?.["q-8"]).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(
      session,
      "user",
      expect.arrayContaining(questReady ? ["q-8"] : ["q-1", "q-8"]),
    );
    expect(session.messageHistory.filter((entry) => entry.type === "assistant" && entry.threadAnswer)).toEqual([
      response,
    ]);
  });

  it("finalizes all sibling answer segments before applying an earlier Ready commentary marker", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"), directUser("u2"));
    const readyCommentary = routedFinal("ready-commentary", 2, {
      role: "commentary",
      ready: true,
      text: "All requested answers are complete.",
    });
    const answer = routedFinal("combined-answer", 2, { answerIds: ["u1", "u2"] });
    session.messageHistory.push(readyCommentary, answer);
    session.userMessageIdsThisTurn = [0, 1];
    session.messageCountAtTurnStart = 2;
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "multi-segment-ready" }), deps);

    expect(answer.threadAnswer).toEqual({
      version: 2,
      answerUserMessageIds: ["u1", "u2"],
      observedHistoryLength: 2,
      authoredThreadKey: "main",
      ownerGroups: [{ threadKey: "main", userMessageIds: ["u1", "u2"] }],
    });
    expect(buildLeaderThreadResponseState(session, "main").projection.ready).toBe(true);
    expect(session.state.leaderThreadStatuses?.main).toMatchObject({
      kind: "ready",
      messageId: readyCommentary.message.id,
    });
  });

  it("keeps later queued input pending when completing the current turn", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"), directUser("u2", "queued later"));
    const response = routedFinal("final-current", 1);
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [0];
    // Queued promotion can see the later row in the tail; the persisted
    // response observation still proves that only u1 belonged to this turn.
    session.messageCountAtTurnStart = 2;
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "queued-later-result" }), deps);

    expect(response.threadAnswer?.answerUserMessageIds).toEqual(["u1"]);
    expect(
      buildLeaderThreadResponseState(session, "main").projection.pendingMessages.map(
        (message) => message.historyMessageId,
      ),
    ).toEqual(["u2"]);
  });

  it("rejects a commentary Ready attempt and forwards the target to the pending-response validator", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"));
    const commentary = routedFinal("commentary-ready", 1, { role: "commentary", ready: true, text: "Still working." });
    session.messageHistory.push(commentary);
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "invalid-ready-result" }), deps);

    expect(commentary.threadAnswer).toBeUndefined();
    expect(session.state.leaderThreadStatuses?.main).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user", ["main"]);
  });

  it.each([
    "unproven",
    "invalid-control",
    "corrupt-metadata",
  ] as const)("does not let a %s answer anchor Ready after prior coverage is complete", (failure) => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"));
    const prior = routedFinal("prior-final", 1);
    session.messageHistory.push(prior);
    expect(finalizeRoutedLeaderResponseMessage(session, prior)).toMatchObject({ finalized: true });
    delete prior.leaderAnswerObservedHistoryLength;
    delete prior.leaderAnswerUserMessageIds;
    session.messageHistory.push({ type: "result", data: makeResult({ uuid: "prior-result" }) });

    const attempted = routedFinal("attempted-revision", 1, {
      ready: true,
      text: failure === "invalid-control" ? "Polish.\n[thread:side:A:u1]\nInvalid route." : "Polished answer.",
    });
    if (failure === "unproven") delete attempted.leaderAnswerObservedHistoryLength;
    if (failure === "corrupt-metadata") {
      attempted.threadAnswer = {
        version: 2,
        answerUserMessageIds: ["u999"],
        observedHistoryLength: 1,
      };
    }
    session.messageHistory.push(attempted);
    session.userMessageIdsThisTurn = [];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: `failed-ready-${failure}` }), deps);

    expect(session.state.leaderThreadStatuses?.main).toBeUndefined();
    expect(attempted.deferredThreadStatusMarkers).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "user", ["main"]);
  });

  it("does not finalize a routed answer or Ready marker from an interrupted turn", () => {
    const session = makeSession();
    session.messageHistory.push(directUser("u1"));
    const response = routedFinal("partial-final", 1, { ready: true });
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ uuid: "interrupted-final", stop_reason: "interrupted" }), deps);

    expect(response.threadAnswer).toBeUndefined();
    expect(response.deferredThreadStatusMarkers).toBeUndefined();
    expect(buildLeaderThreadResponseState(session, "main").projection.pendingMessageCount).toBe(1);
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("settles timer answers only at a successful completed turn (interrupted=%s)", (interrupted) => {
    // Timer eligibility extends answer targets, not the existing interruption/Ready contract.
    const session = makeSession();
    session.messageHistory.push(directUser("u1", "Unrelated request still owed"), {
      type: "user_message",
      id: "timer-firing",
      content: "[⏰ Timer t1 reminder] Scheduled report",
      timestamp: 2,
      threadKey: "main",
      agentSource: { sessionId: "timer:t1" },
      leaderTimerMessageId: "timer-m1",
    });
    const response = routedFinal("timer-final", 2, { ready: true, answerIds: ["timer-m1"] });
    session.messageHistory.push(response);
    session.userMessageIdsThisTurn = [1];
    const deps = makeDeps();
    handleResultMessage(
      session,
      makeResult({
        uuid: "timer-result",
        ...(interrupted ? { stop_reason: "interrupted" } : {}),
      }),
      deps,
    );
    if (interrupted) {
      expect(response.threadAnswer).toBeUndefined();
      expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    } else {
      expect(response.threadAnswer?.answerUserMessageIds).toEqual(["timer-m1"]);
    }
    expect(session.state.leaderThreadStatuses?.main).toBeUndefined();
    expect(
      buildLeaderThreadResponseState(session, "main").projection.pendingMessages.map((entry) => entry.userMessageId),
    ).toEqual(["u1"]);
  });

  it("keeps transient provider retries out of durable history and terminal hooks", () => {
    // Long-lived network recovery can produce many attempts. The exact retry
    // owner lives in session state, so raw terminal rows must not accumulate.
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: "stream disconnected before completion",
        codex_provider_retry: {
          family: "model_backend_stream_error",
          ownerId: "input-1",
          attempt: 7,
          maxAttempts: null,
          startedAt: 100,
        },
      }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(0);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      {
        type: "result",
        data: expect.objectContaining({
          result: "Transient provider request failed; Takode is retrying.",
          errors: undefined,
          codex_provider_retry: expect.objectContaining({ ownerId: "input-1", attempt: 7 }),
        }),
      },
      { skipBuffer: true },
    );
    expect(JSON.stringify(deps.broadcastToBrowsers.mock.calls)).not.toContain("stream disconnected before completion");
    expect(deps.freezeHistoryThroughCurrentTail).not.toHaveBeenCalled();
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.reconcileTerminalResultState).toHaveBeenCalledWith(session);
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).not.toHaveBeenCalled();
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("normalizes result turn counts from backend history instead of CLI num_turns", () => {
    // Protects both Codex per-result counts and Claude compaction-reset counts:
    // browser-visible result/session_update turn metrics come from history.
    const session = makeSession();
    session.backendType = "codex";
    session.messageHistory.push(
      { type: "user_message", id: "u1", content: "first", timestamp: 1 } as BrowserIncomingMessage,
      {
        type: "user_message",
        id: "event-1",
        content: "timer",
        timestamp: 2,
        agentSource: { sessionId: "timer", sessionLabel: "Timer" },
      } as BrowserIncomingMessage,
      makeAssistant("a1"),
      { type: "result", data: makeResult({ num_turns: 1 }) } as BrowserIncomingMessage,
      { type: "user_message", id: "u2", content: "second", timestamp: 3 } as BrowserIncomingMessage,
      makeAssistant("a2"),
    );
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ num_turns: 1, uuid: "current-result" }), deps);

    expect(session.state).toMatchObject({
      user_turn_count: 2,
      agent_turn_count: 2,
      num_turns: 2,
    });
    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ num_turns: 2, uuid: "current-result" }),
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({
          user_turn_count: 2,
          agent_turn_count: 2,
          num_turns: 2,
        }),
      }),
    );
  });

  it("marks Claude user-control diagnostics as interrupted so they do not trigger error handling", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        stop_reason: "tool_use",
      }),
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        interrupted: true,
        data: expect.objectContaining({
          is_error: true,
          stop_reason: "tool_use",
        }),
      }),
    );
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("marks Claude user-control diagnostics from errors[] as interrupted", () => {
    // Claude WebSocket interruption diagnostics are observed in errors[] when
    // the result field is absent; this producer shape previously leaked into chat.
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        stop_reason: "tool_use",
      }),
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "result", interrupted: true }));
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
  });

  it("skips leader-thread outcome validation for interrupted generation results", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ stop_reason: "interrupted" }), deps);

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "result", interrupted: true }));
    expect(deps.validateLeaderThreadOutcomes).not.toHaveBeenCalled();
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
  });

  it("keeps normal completed leader turns on the outcome validation path", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-status",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "[thread:main] {[(Thread Ready: main | done)]}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1,
      threadKey: "main",
    } as BrowserIncomingMessage);
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("leader");

    handleResultMessage(session, makeResult({ uuid: "normal-completed-leader-result" }), deps);

    const result = session.messageHistory.at(-1) as Extract<BrowserIncomingMessage, { type: "result" }>;
    expect(result.type).toBe("result");
    expect(result.interrupted).toBeUndefined();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "leader");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ uuid: "normal-completed-leader-result" }),
      "leader",
    );
  });

  it("injects a synthetic thread-routing reminder after unrouted leader output", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q970",
        content: "continue in quest thread",
        timestamp: 1,
        threadKey: "q-970",
        questId: "q-970",
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Unrouted leader response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Unrouted leader response",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("leader");

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("[Thread routing reminder]"),
      { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      undefined,
      {
        threadKey: "q-970",
        questId: "q-970",
        threadRefs: [{ threadKey: "q-970", questId: "q-970", source: "explicit" }],
      },
    );
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("Missing thread marker"),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).toContain("on visible leader text");
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).not.toContain("previous leader response");
  });

  it("does not inject thread-routing reminders for system-triggered leader startup output", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "leader-kickoff",
        content: "Leader kickoff",
        timestamp: 1,
        threadKey: "main",
        agentSource: { sessionId: "system:leader-kickoff", sessionLabel: "Leader Kickoff" },
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread-after-system-kickoff",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Ready to coordinate." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Ready to coordinate.",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();
    deps.getCurrentTurnTriggerSource.mockReturnValue("system");

    handleResultMessage(session, makeResult({ uuid: "system-kickoff-result" }), deps);

    expect(deps.injectUserMessage).not.toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("[Thread routing reminder]"),
      expect.anything(),
      undefined,
      expect.anything(),
    );
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
    expect(deps.validateLeaderThreadOutcomes).toHaveBeenCalledWith(session, "system");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ uuid: "system-kickoff-result" }),
      "system",
    );
  });

  it("injects shell-command-specific thread-routing reminders after unrouted leader commands", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q970",
        content: "continue in quest thread",
        timestamp: 1,
        threadKey: "q-970",
        questId: "q-970",
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-command-thread",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "shell_command",
          rawContent: "pwd",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("Missing thread marker on leader shell command"),
      { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      undefined,
      expect.objectContaining({ threadKey: "q-970", questId: "q-970" }),
    );
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).toContain("previous leader shell command");
    expect(deps.injectUserMessage.mock.calls[0]?.[1]).not.toContain("previous leader response");
  });

  it("injects queued quest thread reminders as synthetic user messages after the turn result", () => {
    const session = makeSession();
    session.questThreadRemindersThisTurn = [
      {
        content:
          "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
        route: {
          threadKey: "q-1025",
          questId: "q-1025",
          threadRefs: [{ threadKey: "q-1025", questId: "q-1025", source: "explicit" }],
        },
        agentSource: {
          sessionId: QUEST_THREAD_REMINDER_SOURCE_ID,
          sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL,
        },
      },
    ];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
      { sessionId: QUEST_THREAD_REMINDER_SOURCE_ID, sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL },
      undefined,
      {
        threadKey: "q-1025",
        questId: "q-1025",
        threadRefs: [{ threadKey: "q-1025", questId: "q-1025", source: "explicit" }],
      },
    );
    expect(session.questThreadRemindersThisTurn).toEqual([]);
  });

  it("does not recursively inject thread-routing reminders for reminder-triggered turns", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "thread-routing-reminder-1",
        content: "[Thread routing reminder]\nMissing thread marker.",
        timestamp: 1,
        threadKey: "main",
        agentSource: { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread-after-reminder",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Still unrouted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          source: "visible_text",
          rawContent: "Still unrouted",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });
});
