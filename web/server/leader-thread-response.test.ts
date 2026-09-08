import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
  isCurrentValidRoutedLeaderResponseMessage,
  leaderThreadResponseContentHash,
} from "./leader-thread-response.js";

function session() {
  return { id: "leader-1", messageHistory: [] as BrowserIncomingMessage[] };
}

function human(userMessageId: string, timestamp: number, threadKey = "main"): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: `raw-${userMessageId}`,
    leaderUserMessageId: userMessageId,
    content: `Ask ${userMessageId}`,
    timestamp,
    threadKey,
    leaderResponseCoverageVersion: 1,
    ...(threadKey === "main"
      ? {}
      : {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit", attachedAt: timestamp }],
        }),
  };
}

function routedAssistant(
  id: string,
  text: string,
  answerUserMessageIds: string[] | undefined,
  observedHistoryLength: number | undefined,
  threadKey = "main",
  role: "commentary" | "answer" = "answer",
): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 100,
    threadKey,
    leaderThreadRole: role,
    ...(answerUserMessageIds ? { leaderAnswerUserMessageIds: answerUserMessageIds } : {}),
    ...(observedHistoryLength === undefined ? {} : { leaderAnswerObservedHistoryLength: observedHistoryLength }),
    ...(threadKey === "main"
      ? {}
      : {
          questId: threadKey,
          threadRefs: [{ threadKey, questId: threadKey, source: "explicit", attachedAt: 100 }],
        }),
  };
}

function appendAnswer(
  target: ReturnType<typeof session>,
  id: string,
  answerUserMessageIds: string[],
  text: string,
  observedHistoryLength: number,
  threadKey = "main",
) {
  const message = routedAssistant(id, text, answerUserMessageIds, observedHistoryLength, threadKey);
  target.messageHistory.push(message);
  expect(finalizeRoutedLeaderResponseMessage(target, message)).toMatchObject({ finalized: true, answerId: id });
  return message;
}

function legacyBatchId(sessionId: string, threadKey: string, historyLength: number, ids: string[]): string {
  const encoded = Buffer.from(JSON.stringify({ v: 1, t: threadKey, h: historyLength, ids })).toString("base64url");
  const checksum = createHash("sha256").update(`${sessionId}\n${encoded}`).digest("hex").slice(0, 24);
  return `response-batch-v1.${encoded}.${checksum}`;
}

function legacyResponse(
  target: ReturnType<typeof session>,
  id: string,
  text: string,
  coveredIds: string[],
  observedHistoryLength: number,
  threadKey = "main",
): Extract<BrowserIncomingMessage, { type: "leader_user_message" }> {
  const logicalResponseId = `legacy-${id}`;
  const message: Extract<BrowserIncomingMessage, { type: "leader_user_message" }> = {
    type: "leader_user_message",
    id,
    content: text,
    timestamp: 50,
    threadKey,
    ...(threadKey === "main"
      ? {}
      : { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] }),
    threadResponse: {
      logicalResponseId,
      revisionId: `${logicalResponseId}-r1`,
      revisionNumber: 1,
      batchId: legacyBatchId(target.id, threadKey, observedHistoryLength, coveredIds),
      batchObservedHistoryLength: observedHistoryLength,
      coveredUserMessageIds: coveredIds,
      contentHash: leaderThreadResponseContentHash(text),
    },
  };
  target.messageHistory.push(message);
  return message;
}

describe("explicit routed leader answers", () => {
  it("ignores pre-cutover history and projects concise pending IDs", () => {
    const target = session();
    target.messageHistory.push(
      { type: "user_message", id: "legacy", content: "Old ask", timestamp: 1, threadKey: "main" },
      human("u1", 2),
      human("u2", 3),
    );

    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      version: 2,
      cutoverHistoryIndex: 1,
      pendingMessageCount: 2,
      pendingMessages: [
        { userMessageId: "u1", historyMessageId: "raw-u1", historyIndex: 1 },
        { userMessageId: "u2", historyMessageId: "raw-u2", historyIndex: 2 },
      ],
      currentAnswers: [],
      ready: false,
    });
  });

  it("answers a later clarification while older work remains pending, then reaches Ready asynchronously", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2));
    appendAnswer(target, "answer-u2", ["u2"], "Clarification answered.", 2);

    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 1,
      pendingMessages: [{ userMessageId: "u1" }],
      currentAnswers: [
        {
          currentMessageId: "answer-u2",
          answerUserMessageIds: ["u2"],
          coveredAnswerUserMessageIds: ["u2"],
        },
      ],
      ready: false,
    });

    appendAnswer(target, "answer-u1", ["u1"], "Earlier implementation complete.", 3);
    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 0,
      currentAnswers: [
        { currentMessageId: "answer-u2", coveredAnswerUserMessageIds: ["u2"] },
        { currentMessageId: "answer-u1", coveredAnswerUserMessageIds: ["u1"] },
      ],
      ready: true,
    });
  });

  it("allows one answer to cover consecutive messages", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2));
    const answer = appendAnswer(target, "answer-both", ["u1", "u2"], "Combined answer.", 2);

    expect(answer.threadAnswer).toEqual({
      version: 2,
      answerUserMessageIds: ["u1", "u2"],
      observedHistoryLength: 2,
      authoredThreadKey: "main",
      ownerGroups: [{ threadKey: "main", userMessageIds: ["u1", "u2"] }],
    });
    expect(buildLeaderThreadResponseState(target, "main").responses[0]).toMatchObject({
      answerUserMessageIds: ["u1", "u2"],
      referencedUserMessageIds: ["raw-u1", "raw-u2"],
      coveredAnswerUserMessageIds: ["u1", "u2"],
      coveredUserMessageIds: ["raw-u1", "raw-u2"],
    });
  });

  it("supersedes only the repeated IDs while retaining append-only answer history", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2));
    appendAnswer(target, "answer-both", ["u1", "u2"], "First combined answer.", 2);
    appendAnswer(target, "answer-u2-new", ["u2"], "Updated second answer.", 3);

    expect(buildLeaderThreadResponseState(target, "main").responses).toMatchObject([
      {
        currentMessageId: "answer-both",
        answerUserMessageIds: ["u1", "u2"],
        coveredAnswerUserMessageIds: ["u1"],
      },
      {
        currentMessageId: "answer-u2-new",
        answerUserMessageIds: ["u2"],
        coveredAnswerUserMessageIds: ["u2"],
      },
    ]);
  });

  it("retains fully superseded explicit answers for presentation without restoring coverage authority", () => {
    // Leaders may deliberately add a complementary answer for the same request.
    // Both exact rows stay presentable, but only the latest row owns coverage/Ready.
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2));
    const earlier = appendAnswer(target, "answer-both-earlier", ["u1", "u2"], "Detailed accepted Work answer.", 2);
    const later = appendAnswer(target, "answer-both-later", ["u1", "u2"], "Material Memory addition.", 3);

    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        {
          currentMessageId: "answer-both-earlier",
          answerUserMessageIds: ["u1", "u2"],
          referencedUserMessageIds: ["raw-u1", "raw-u2"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
        },
        {
          currentMessageId: "answer-both-later",
          answerUserMessageIds: ["u1", "u2"],
          referencedUserMessageIds: ["raw-u1", "raw-u2"],
          coveredAnswerUserMessageIds: ["u1", "u2"],
          coveredUserMessageIds: ["raw-u1", "raw-u2"],
        },
      ],
    });
    expect(isCurrentValidRoutedLeaderResponseMessage(target, earlier)).toBe(false);
    expect(isCurrentValidRoutedLeaderResponseMessage(target, later)).toBe(true);
  });

  it("rejects unknown, unseen, and duplicate IDs atomically", () => {
    // Relaxing answer grouping must not accept nonexistent or unobserved sources.
    const cases: Array<{ ids: string[]; observed: number; thread?: string }> = [
      { ids: ["u9"], observed: 2 },
      { ids: ["u2"], observed: 1 },
      { ids: ["u1", "u1"], observed: 2 },
    ];
    for (const [index, testCase] of cases.entries()) {
      const target = session();
      target.messageHistory.push(human("u1", 1), human("u2", 2), human("u3", 3));
      const answer = routedAssistant(
        `invalid-${index}`,
        "Invalid answer.",
        testCase.ids,
        testCase.observed,
        testCase.thread ?? "main",
      );
      target.messageHistory.push(answer);
      expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
        finalized: false,
        reason: "invalid_message",
      });
      expect(answer.threadAnswer).toBeUndefined();
    }
  });

  it.each([
    { ids: ["u2", "u1"], observed: 2, thread: "main", pending: ["u3"] },
    { ids: ["u1", "u3"], observed: 3, thread: "main", pending: ["u2"] },
    { ids: ["u2"], observed: 3, thread: "q-42", pending: ["u1", "u3"] },
  ])("accepts existing references $ids from $thread without changing unrelated coverage", (testCase) => {
    // References identify exact requests; chronological adjacency and the
    // authored tab do not limit a valid answer's coverage.
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2), human("u3", 3));
    const answer = appendAnswer(
      target,
      "referenced-answer",
      testCase.ids,
      "One answer for the referenced requests.",
      testCase.observed,
      testCase.thread,
    );

    expect(answer.threadAnswer?.answerUserMessageIds).toEqual(testCase.ids);
    expect(answer.threadRoutingError).toBeUndefined();
    const main = buildLeaderThreadResponseState(target, "main").projection;
    expect(main.pendingMessages.map((message) => message.userMessageId)).toEqual(testCase.pending);
    expect(main.currentAnswers).toMatchObject([
      { currentMessageId: "referenced-answer", answerUserMessageIds: testCase.ids },
    ]);
    if (testCase.thread !== "main") {
      expect(buildLeaderThreadResponseState(target, testCase.thread).projection.currentAnswers).toMatchObject([
        { currentMessageId: "referenced-answer", coveredAnswerUserMessageIds: [], coveredUserMessageIds: [] },
      ]);
    }
  });

  it("recomputes current ownership from the newest authoritative non-backfill reference", () => {
    const target = session();
    const moved = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    moved.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "explicit", attachedAt: 2 }];
    target.messageHistory.push(moved);

    expect(buildLeaderThreadResponseState(target, "main").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(target, "q-42").projection.pendingMessages).toMatchObject([
      { userMessageId: "u1" },
    ]);

    const mainAnswer = appendAnswer(target, "main-authored-answer", ["u1"], "Answer from Main.", 1);
    expect(mainAnswer.threadAnswer?.ownerGroups).toEqual([{ threadKey: "q-42", userMessageIds: ["u1"] }]);
    expect(buildLeaderThreadResponseState(target, "q-42").projection).toMatchObject({
      ready: true,
      currentAnswers: [{ currentMessageId: "main-authored-answer", coveredAnswerUserMessageIds: ["u1"] }],
    });

    appendAnswer(target, "moved-answer", ["u1"], "Quest-thread answer.", 1, "q-42");
    expect(buildLeaderThreadResponseState(target, "q-42").projection.ready).toBe(true);
  });

  it("keeps a current answer valid when the answer row gains visibility-only backfill refs", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1, "q-42"));
    const answer = appendAnswer(target, "answer-q42", ["u1"], "Quest answer.", 1, "q-42");
    answer.threadRefs = [
      ...(answer.threadRefs ?? []),
      { threadKey: "q-99", questId: "q-99", source: "backfill", attachedAt: 200 },
    ];

    expect(buildLeaderThreadResponseState(target, "q-42").projection.ready).toBe(true);
    expect(buildLeaderThreadResponseState(target, "q-42").responses[0]?.currentMessageId).toBe("answer-q42");
  });

  it("keeps backfill visibility separate from answer ownership", () => {
    const target = session();
    const attached = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    attached.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(attached);

    expect(buildLeaderThreadResponseState(target, "main").projection.pendingMessages).toMatchObject([
      { userMessageId: "u1" },
    ]);
    expect(buildLeaderThreadResponseState(target, "q-42").projection.pendingMessageCount).toBe(0);
  });

  it("canonicalizes one q-owner route mismatch without regenerating the response row", () => {
    // This reproduces the q-2042 -> q-2044 failure: display association is
    // already proven, so only answer authority should move to the shared owner.
    const target = session();
    const first = human("u37", 1, "q-2042") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const second = human("u38", 2, "q-2042") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    first.threadRefs = [
      ...(first.threadRefs ?? []),
      { threadKey: "q-2044", questId: "q-2044", source: "backfill", attachedAt: 3 },
    ];
    second.threadRefs = [
      ...(second.threadRefs ?? []),
      { threadKey: "q-2044", questId: "q-2044", source: "backfill", attachedAt: 4 },
    ];
    const progress = routedAssistant(
      "dispatch-progress",
      "Approved and dispatched; implementation is still in progress.",
      undefined,
      undefined,
      "q-2042",
      "commentary",
    );
    target.messageHistory.push(first, second, progress);
    expect(buildLeaderThreadResponseState(target, "q-2042").projection.pendingMessageCount).toBe(2);

    const answer = routedAssistant(
      "implemented-answer",
      "The approved behavior is now implemented and synchronized.",
      ["u37", "u38"],
      2,
      "q-2044",
    );
    const originalText = answer.message.content;
    const originalTimestamp = answer.timestamp;
    target.messageHistory.push(answer);
    const historyIndex = target.messageHistory.indexOf(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toEqual({
      finalized: true,
      answerId: "implemented-answer",
    });
    expect(target.messageHistory[historyIndex]).toBe(answer);
    expect(answer.message.content).toBe(originalText);
    expect(answer.timestamp).toBe(originalTimestamp);
    expect(answer).toMatchObject({
      threadKey: "q-2042",
      questId: "q-2042",
      threadAnswer: { version: 2, answerUserMessageIds: ["u37", "u38"], observedHistoryLength: 2 },
      threadRefs: [
        { threadKey: "q-2042", questId: "q-2042", source: "explicit" },
        { threadKey: "q-2044", questId: "q-2044", source: "backfill" },
      ],
    });
    expect(answer.threadRoutingError).toBeUndefined();

    expect(buildLeaderThreadResponseState(target, "q-2042").projection).toMatchObject({
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [{ currentMessageId: "implemented-answer", threadKey: "q-2042" }],
    });
    expect(buildLeaderThreadResponseState(target, "q-2044").projection.currentAnswers).toMatchObject([
      { currentMessageId: "implemented-answer", threadKey: "q-2042" },
    ]);
  });

  it("canonicalizes a Main-owned answer selected in an associated quest", () => {
    // Main ownership has no authoritative quest ref. The selected quest is
    // retained only as a backfill so live and bounded views can project it.
    const target = session();
    const request = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(request);
    const answer = routedAssistant("main-owner-answer", "Completed implementation.", ["u1"], 1, "q-42");
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
      finalized: true,
    });
    expect(answer.threadKey).toBe("main");
    expect(answer.questId).toBeUndefined();
    expect(answer.threadRefs).toEqual([
      expect.objectContaining({ threadKey: "q-42", questId: "q-42", source: "backfill" }),
    ]);
    expect(buildLeaderThreadResponseState(target, "main").projection.currentAnswers[0]?.currentMessageId).toBe(
      "main-owner-answer",
    );
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers[0]?.currentMessageId).toBe(
      "main-owner-answer",
    );
  });

  it.each([
    "route-less",
    "conflicting-route",
  ] as const)("rejects exact Main coverage when the prompt owner is %s", (shape) => {
    const target = session();
    const request = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    if (shape === "route-less") {
      delete request.threadKey;
    } else {
      request.threadKey = "main";
      request.questId = "q-42";
    }
    target.messageHistory.push(request);
    const answer = routedAssistant("unproven-main-owner", "Answer.", ["u1"], 1, "main");
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
      finalized: false,
      reason: "invalid_message",
    });
    expect(answer.threadAnswer).toBeUndefined();
    expect(answer.threadRoutingError?.answerRouteDiagnostic).toMatchObject({
      reason: "unproven_owner",
      selectedThreadKey: "main",
      answerUserMessageIds: ["u1"],
      ownerGroups: [],
    });
  });

  it("routes grouped and reassigned requests automatically from any authored destination", () => {
    // One exact answer can cover multiple proven owners and gains the authored
    // destination without a separate manual association operation.
    const mixed = session();
    mixed.messageHistory.push(human("u1", 1, "q-1"), human("u2", 2, "q-2"));
    const mixedAnswer = routedAssistant("mixed", "Grouped answer.", ["u1", "u2"], 2, "q-3");
    mixed.messageHistory.push(mixedAnswer);
    expect(finalizeRoutedLeaderResponseMessage(mixed, mixedAnswer)).toMatchObject({
      finalized: true,
    });
    expect(mixedAnswer.threadAnswer).toMatchObject({
      answerUserMessageIds: ["u1", "u2"],
      ownerGroups: [
        { threadKey: "q-1", userMessageIds: ["u1"] },
        { threadKey: "q-2", userMessageIds: ["u2"] },
      ],
    });
    expect(mixedAnswer.threadRoutingError).toBeUndefined();
    for (const [threadKey, covered] of [
      ["q-1", ["u1"]],
      ["q-2", ["u2"]],
      ["q-3", []],
    ] as const) {
      expect(buildLeaderThreadResponseState(mixed, threadKey).projection.currentAnswers).toMatchObject([
        { currentMessageId: "mixed", answerUserMessageIds: ["u1", "u2"], coveredAnswerUserMessageIds: covered },
      ]);
    }

    const reassigned = session();
    const reassignedRequest = human("u1", 1, "q-1") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    reassignedRequest.threadRefs = [
      ...(reassignedRequest.threadRefs ?? []),
      { threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 2 },
      { threadKey: "q-3", questId: "q-3", source: "backfill", attachedAt: 3 },
    ];
    reassigned.messageHistory.push(reassignedRequest);
    const reassignedAnswer = routedAssistant("reassigned", "Answer.", ["u1"], 1, "q-3");
    reassigned.messageHistory.push(reassignedAnswer);
    expect(finalizeRoutedLeaderResponseMessage(reassigned, reassignedAnswer)).toMatchObject({ finalized: true });
    expect(reassignedAnswer.threadAnswer).toMatchObject({
      ownerGroups: [{ threadKey: "q-2", userMessageIds: ["u1"] }],
    });
    expect(reassignedAnswer).toMatchObject({ threadKey: "q-2", questId: "q-2" });
    expect(buildLeaderThreadResponseState(reassigned, "q-2").projection.ready).toBe(true);

    const unassociated = session();
    unassociated.messageHistory.push(human("u1", 1, "q-1"));
    const unassociatedAnswer = routedAssistant("unassociated", "Answer.", ["u1"], 1, "q-2");
    unassociated.messageHistory.push(unassociatedAnswer);
    expect(finalizeRoutedLeaderResponseMessage(unassociated, unassociatedAnswer)).toMatchObject({
      finalized: true,
    });
    expect(unassociatedAnswer.threadAnswer).toMatchObject({
      ownerGroups: [{ threadKey: "q-1", userMessageIds: ["u1"] }],
    });
    expect(buildLeaderThreadResponseState(unassociated, "q-2").projection.currentAnswers).toMatchObject([
      { currentMessageId: "unassociated", coveredAnswerUserMessageIds: [] },
    ]);

    const mainBackfill = session();
    mainBackfill.messageHistory.push(human("u1", 1, "q-1"));
    const mainAnswer = routedAssistant("main-backfill", "Answer.", ["u1"], 1, "main");
    mainBackfill.messageHistory.push(mainAnswer);
    expect(finalizeRoutedLeaderResponseMessage(mainBackfill, mainAnswer)).toMatchObject({ finalized: true });
    expect(mainAnswer.threadKey).toBe("main");
    expect(mainAnswer.threadAnswer).toMatchObject({
      ownerGroups: [{ threadKey: "q-1", userMessageIds: ["u1"] }],
    });
    expect(buildLeaderThreadResponseState(mainBackfill, "q-1").projection.currentAnswers).toMatchObject([
      { currentMessageId: "main-backfill", coveredAnswerUserMessageIds: ["u1"] },
    ]);
  });

  it("preserves a valid answer with a Ready marker aimed at a display-only thread", () => {
    // Status authority is checked by the bridge independently; a misplaced
    // Ready marker must not discard valid answer prose or its owner proof.
    const target = session();
    const request = human("u1", 1, "q-1") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [
      ...(request.threadRefs ?? []),
      { threadKey: "q-2", questId: "q-2", source: "backfill", attachedAt: 2 },
    ];
    target.messageHistory.push(request);
    const answer = routedAssistant("conflicting-status", "Answer.", ["u1"], 1, "q-2");
    answer.deferredThreadStatusMarkers = [
      {
        kind: "ready",
        label: "Thread Ready",
        target: { threadKey: "q-2", questId: "q-2" },
        summary: "display thread complete",
        raw: "{[(Thread Ready: q-2 | display thread complete)]}",
        lineIndex: 1,
      },
    ];
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({ finalized: true });
    expect(answer).toMatchObject({
      threadKey: "q-1",
      questId: "q-1",
      threadAnswer: { ownerGroups: [{ threadKey: "q-1", userMessageIds: ["u1"] }] },
    });
    expect(answer.threadRoutingError).toBeUndefined();
  });

  it("projects the exact Main-owned u25 answer identity into its q-2024 backfill association", () => {
    const target = session();
    const request = human("u25", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [{ threadKey: "q-2024", questId: "q-2024", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(request);
    appendAnswer(target, "answer-u25", ["u25"], "Main answer for the attached request.", 1);

    const main = buildLeaderThreadResponseState(target, "main").projection;
    const quest = buildLeaderThreadResponseState(target, "q-2024").projection;
    expect(main).toMatchObject({
      threadKey: "main",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        {
          threadKey: "main",
          answerUserMessageIds: ["u25"],
          referencedUserMessageIds: ["raw-u25"],
          coveredAnswerUserMessageIds: ["u25"],
          coveredUserMessageIds: ["raw-u25"],
          currentMessageId: "answer-u25",
          currentHistoryIndex: 1,
          source: "explicit",
        },
      ],
    });
    expect(quest).toMatchObject({
      threadKey: "q-2024",
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        {
          threadKey: "main",
          answerUserMessageIds: ["u25"],
          referencedUserMessageIds: ["raw-u25"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
          currentMessageId: "answer-u25",
          currentHistoryIndex: 1,
          source: "explicit",
        },
      ],
    });
    expect(quest.currentAnswers[0]?.currentMessageId).toBe(main.currentAnswers[0]?.currentMessageId);
    expect(quest.currentAnswers[0]?.currentHistoryIndex).toBe(main.currentAnswers[0]?.currentHistoryIndex);
    expect(buildLeaderThreadResponseState(target, "q-999").projection.currentAnswers).toEqual([]);

    request.threadRefs = [];
    expect(buildLeaderThreadResponseState(target, "q-2024").projection.currentAnswers).toEqual([]);

    request.threadRefs = [
      { threadKey: "q-2024", questId: "q-2024", source: "backfill", attachedAt: 2 },
      { threadKey: "q-2030", questId: "q-2030", source: "explicit", attachedAt: 3 },
    ];
    expect(buildLeaderThreadResponseState(target, "main").projection.currentAnswers).toEqual([]);
    expect(buildLeaderThreadResponseState(target, "q-2024").projection.currentAnswers).toEqual([]);
    expect(buildLeaderThreadResponseState(target, "q-2030").projection).toMatchObject({
      pendingMessages: [{ userMessageId: "u25" }],
      currentAnswers: [],
      ready: false,
    });
  });

  it("projects one Main answer across multiple current quest associations independently", () => {
    const target = session();
    const request = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [
      { threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 },
      { threadKey: "q-43", questId: "q-43", source: "backfill", attachedAt: 3 },
    ];
    target.messageHistory.push(request);
    appendAnswer(target, "multi-associated-answer", ["u1"], "One Main answer.", 1);

    const identity = {
      threadKey: "main",
      currentMessageId: "multi-associated-answer",
      currentHistoryIndex: 1,
      source: "explicit",
    } as const;
    const mainBefore = buildLeaderThreadResponseState(target, "main").projection;
    const q42Before = buildLeaderThreadResponseState(target, "q-42").projection;
    const q43Before = buildLeaderThreadResponseState(target, "q-43").projection;

    expect(mainBefore.currentAnswers).toMatchObject([identity]);
    expect(q42Before.currentAnswers).toMatchObject([identity]);
    expect(q43Before.currentAnswers).toMatchObject([identity]);
    expect(buildLeaderThreadResponseState(target, "q-44").projection.currentAnswers).toEqual([]);

    request.threadRefs = request.threadRefs.filter((ref) => ref.threadKey !== "q-42");

    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toEqual([]);
    expect(buildLeaderThreadResponseState(target, "main").projection).toEqual(mainBefore);
    expect(buildLeaderThreadResponseState(target, "q-43").projection).toEqual(q43Before);
  });

  it("projects a grouped answer through the union of its referenced prompt associations", () => {
    // A destination needs one related prompt to show the entire stored answer,
    // while full original references stay distinct from local coverage.
    const target = session();
    const first = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const second = human("u2", 2) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    first.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 3 }];
    target.messageHistory.push(first, second);
    appendAnswer(target, "main-answer", ["u1", "u2"], "Indivisible grouped Main answer.", 2);

    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      {
        currentMessageId: "main-answer",
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["raw-u1", "raw-u2"],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
      },
    ]);

    second.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 4 }];
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      {
        threadKey: "main",
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["raw-u1", "raw-u2"],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
        currentMessageId: "main-answer",
      },
    ]);

    appendAnswer(target, "main-answer-u2", ["u2"], "Updated second answer.", 3);
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      { currentMessageId: "main-answer", coveredAnswerUserMessageIds: [] },
      { currentMessageId: "main-answer-u2", coveredAnswerUserMessageIds: [] },
    ]);
  });

  it("projects each retained answer through its own prompt association union", () => {
    // A later grouped answer does not erase complementary prose; both complete
    // source rows appear through their related prompt's current association.
    const target = session();
    const first = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const second = human("u2", 2) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    first.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 3 }];
    target.messageHistory.push(first, second);
    appendAnswer(target, "main-answer-u1", ["u1"], "Quest-safe answer.", 2);
    appendAnswer(target, "main-answer-grouped", ["u1", "u2"], "Grouped Main-only answer.", 3);

    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      {
        currentMessageId: "main-answer-u1",
        referencedUserMessageIds: ["raw-u1"],
        coveredUserMessageIds: [],
      },
      {
        currentMessageId: "main-answer-grouped",
        referencedUserMessageIds: ["raw-u1", "raw-u2"],
        coveredUserMessageIds: [],
      },
    ]);

    first.threadRefs = [];
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toEqual([]);
  });

  it("does not treat a persisted Main backfill as association for a quest-owned answer", () => {
    // Main backfills are not produced by prompt attachment. Reverse-direction
    // answers use actual Main ownership or their authored Main destination.
    const target = session();
    const request = human("u1", 1, "q-42") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [...(request.threadRefs ?? []), { threadKey: "main", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(request);
    appendAnswer(target, "quest-answer", ["u1"], "Quest-owned answer.", 1, "q-42");

    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      { threadKey: "q-42", currentMessageId: "quest-answer", coveredAnswerUserMessageIds: ["u1"] },
    ]);
    expect(buildLeaderThreadResponseState(target, "main").projection.currentAnswers).toEqual([]);
  });

  it("cross-projects deterministic fallback IDs without rewriting the source user message", () => {
    const target = session();
    const request = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.leaderUserMessageId = undefined;
    request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(request);
    appendAnswer(target, "fallback-id-answer", ["u1"], "Answer using the deterministic ID.", 1);

    expect(request.leaderUserMessageId).toBeUndefined();
    expect(buildLeaderThreadResponseState(target, "q-42").projection).toMatchObject({
      cutoverHistoryIndex: 0,
      currentAnswers: [
        {
          threadKey: "main",
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["raw-u1"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
          currentMessageId: "fallback-id-answer",
        },
      ],
    });
  });

  it("does not let commentary satisfy answer coverage", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1));
    const commentary = routedAssistant("commentary", "Still working.", undefined, undefined, "main", "commentary");
    target.messageHistory.push(commentary);

    expect(finalizeRoutedLeaderResponseMessage(target, commentary)).toEqual({
      finalized: false,
      reason: "not_answer",
    });
    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 1,
      ready: false,
      currentAnswers: [],
    });
  });

  it("stores one mixed-owner answer and scopes coverage independently across every related destination", () => {
    // This fixture combines gaps, reversed references, multiple owners, a
    // display-only association, and an unrelated pending request in that tab.
    const target = session();
    const mainRequest = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const questRequest = human("u3", 3, "q-1") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const otherRequest = human("u5", 5, "q-2") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    mainRequest.threadRefs = [{ threadKey: "q-3", questId: "q-3", source: "backfill", attachedAt: 6 }];
    questRequest.threadRefs?.push({ threadKey: "q-2", questId: "q-2", source: "backfill", attachedAt: 7 });
    otherRequest.threadRefs?.push({ threadKey: "q-4", questId: "q-4", source: "backfill", attachedAt: 8 });
    target.messageHistory.push(mainRequest, human("u2", 2), questRequest, human("u4", 4, "q-3"), otherRequest);
    const answer = routedAssistant(
      "combined-answer",
      "The complete combined answer is written once.",
      ["u5", "u1", "u3"],
      5,
      "q-6",
    );
    const originalContent = answer.message.content;
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({ finalized: true });
    expect(target.messageHistory).toHaveLength(6);
    expect(target.messageHistory[5]).toBe(answer);
    expect(answer.message.content).toBe(originalContent);
    expect(answer).toMatchObject({
      threadKey: "main",
      threadAnswer: {
        authoredThreadKey: "q-6",
        answerUserMessageIds: ["u5", "u1", "u3"],
        ownerGroups: [
          { threadKey: "q-2", userMessageIds: ["u5"] },
          { threadKey: "main", userMessageIds: ["u1"] },
          { threadKey: "q-1", userMessageIds: ["u3"] },
        ],
      },
    });
    const expected = [
      { threadKey: "main", covered: ["u1"], pending: ["u2"] },
      { threadKey: "q-1", covered: ["u3"], pending: [] },
      { threadKey: "q-2", covered: ["u5"], pending: [] },
      { threadKey: "q-3", covered: [], pending: ["u4"] },
      { threadKey: "q-4", covered: [], pending: [] },
      { threadKey: "q-6", covered: [], pending: [] },
    ];
    for (const { threadKey, covered, pending } of expected) {
      const projection = buildLeaderThreadResponseState(target, threadKey).projection;
      expect(projection.currentAnswers).toMatchObject([
        {
          currentMessageId: "combined-answer",
          currentHistoryIndex: 5,
          threadKey: "main",
          answerUserMessageIds: ["u5", "u1", "u3"],
          referencedUserMessageIds: ["raw-u5", "raw-u1", "raw-u3"],
          coveredAnswerUserMessageIds: covered,
          coveredUserMessageIds: covered.map((id) => `raw-${id}`),
        },
      ]);
      expect(projection.pendingMessages.map((message) => message.userMessageId)).toEqual(pending);
      expect(projection.ready).toBe(pending.length === 0);
    }
    expect(buildLeaderThreadResponseState(target, "q-999").projection.currentAnswers).toEqual([]);
  });

  it("retains the authored destination after its prompt association is removed", () => {
    // The authored tab is independent of automatically generated backfills.
    const target = session();
    const request = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    request.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 2 }];
    target.messageHistory.push(request);
    const answer = appendAnswer(target, "authored-destination", ["u1"], "Answer from the quest tab.", 1, "q-42");
    request.threadRefs = [];

    expect(answer.threadAnswer?.authoredThreadKey).toBe("q-42");
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toMatchObject([
      { currentMessageId: "authored-destination", coveredAnswerUserMessageIds: [] },
    ]);
    expect(buildLeaderThreadResponseState(target, "main").projection.ready).toBe(true);
  });

  it("invalidates the entire recorded owner snapshot after one referenced request is reassigned", () => {
    // A replay must not reinterpret an old answer as proof of completion for a
    // newly assigned owner, or retain partial coverage for indivisible prose.
    const target = session();
    const reassigned = human("u2", 2, "q-1") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    target.messageHistory.push(human("u1", 1), reassigned);
    const answer = appendAnswer(target, "before-reassignment", ["u1", "u2"], "Combined work is complete.", 2);
    const originalProof = structuredClone(answer.threadAnswer);
    reassigned.threadRefs?.push({ threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 200 });

    expect(isCurrentValidRoutedLeaderResponseMessage(target, answer)).toBe(false);
    expect(answer.threadAnswer).toEqual(originalProof);
    const restored = JSON.parse(JSON.stringify(target)) as ReturnType<typeof session>;
    for (const current of [target, restored]) {
      expect(buildLeaderThreadResponseState(current, "main").projection).toMatchObject({
        pendingMessages: [{ userMessageId: "u1" }],
        currentAnswers: [],
        ready: false,
      });
      expect(buildLeaderThreadResponseState(current, "q-2").projection).toMatchObject({
        pendingMessages: [{ userMessageId: "u2" }],
        currentAnswers: [],
        ready: false,
      });
      expect(buildLeaderThreadResponseState(current, "q-1").projection.currentAnswers).toEqual([]);
    }
  });

  it("replays grouped answers with stable identity and preserves complementary answer rows", () => {
    // Restart reconstruction reuses recorded source rows and owner proof; a
    // later same-request answer changes coverage without duplicating prose.
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2, "q-42"));
    appendAnswer(target, "combined-earlier", ["u1", "u2"], "Detailed completion answer.", 2);
    appendAnswer(target, "combined-later", ["u2", "u1"], "Additional useful result.", 3, "q-42");
    const restored = JSON.parse(JSON.stringify(target)) as ReturnType<typeof session>;
    const restoredAnswer = restored.messageHistory[3] as Extract<BrowserIncomingMessage, { type: "assistant" }>;

    expect(finalizeRoutedLeaderResponseMessage(restored, restoredAnswer)).toEqual({
      finalized: false,
      reason: "already_finalized",
    });
    expect(restored.messageHistory).toHaveLength(4);
    for (const threadKey of ["main", "q-42"]) {
      const before = buildLeaderThreadResponseState(target, threadKey).projection;
      const after = buildLeaderThreadResponseState(restored, threadKey).projection;
      expect(after).toEqual(before);
      expect(after.currentAnswers).toMatchObject([
        { currentMessageId: "combined-earlier", currentHistoryIndex: 2, coveredAnswerUserMessageIds: [] },
        {
          currentMessageId: "combined-later",
          currentHistoryIndex: 3,
          coveredAnswerUserMessageIds: [threadKey === "main" ? "u1" : "u2"],
        },
      ]);
    }
  });

  it("keeps prior single-owner answer metadata valid without granting mixed-owner legacy proof", () => {
    // Older explicit metadata has no owner snapshot. It remains valid only
    // when all referenced requests still share the stored answer's owner.
    const target = session();
    target.messageHistory.push(human("u1", 1, "q-42"), human("u2", 2, "q-42"));
    const answer = appendAnswer(target, "persisted-single-owner", ["u1", "u2"], "Previously stored answer.", 2, "q-42");
    answer.threadAnswer = { version: 2, answerUserMessageIds: ["u1", "u2"], observedHistoryLength: 2 };
    expect(buildLeaderThreadResponseState(target, "q-42").projection.ready).toBe(true);
    expect(isCurrentValidRoutedLeaderResponseMessage(target, answer)).toBe(true);

    const second = target.messageHistory[1] as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    second.threadRefs?.push({ threadKey: "q-43", questId: "q-43", source: "explicit", attachedAt: 200 });
    expect(isCurrentValidRoutedLeaderResponseMessage(target, answer)).toBe(false);
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toEqual([]);
    expect(buildLeaderThreadResponseState(target, "q-43").projection.pendingMessages).toMatchObject([
      { userMessageId: "u2" },
    ]);
  });

  it("rejects malformed Main and quest answer-source routes before they can project", () => {
    const mainTarget = session();
    mainTarget.messageHistory.push(human("u1", 1));
    const malformedMain = routedAssistant("malformed-main", "Malformed Main answer.", ["u1"], 1);
    malformedMain.questId = "q-42";
    mainTarget.messageHistory.push(malformedMain);
    expect(finalizeRoutedLeaderResponseMessage(mainTarget, malformedMain)).toMatchObject({ reason: "invalid_message" });
    expect(buildLeaderThreadResponseState(mainTarget, "main").projection.currentAnswers).toEqual([]);

    const questTarget = session();
    questTarget.messageHistory.push(human("u1", 1, "q-42"));
    const malformedQuest = routedAssistant("malformed-quest", "Malformed quest answer.", ["u1"], 1, "q-42");
    malformedQuest.questId = "q-99";
    questTarget.messageHistory.push(malformedQuest);
    expect(finalizeRoutedLeaderResponseMessage(questTarget, malformedQuest)).toMatchObject({
      reason: "invalid_message",
    });
    expect(buildLeaderThreadResponseState(questTarget, "q-42").projection.currentAnswers).toEqual([]);
  });

  it("rejects conflicting authoritative answer references without rewriting the source route", () => {
    // Display backfills may add destinations; a second authoritative route
    // cannot be silently converted into valid answer ownership.
    const target = session();
    target.messageHistory.push(human("u1", 1, "q-42"));
    const answer = routedAssistant("conflicting-authority", "Answer.", ["u1"], 1, "q-42");
    answer.threadRefs?.push({ threadKey: "q-99", questId: "q-99", source: "explicit", attachedAt: 200 });
    const sourceRoute = structuredClone({
      threadKey: answer.threadKey,
      questId: answer.questId,
      threadRefs: answer.threadRefs,
    });
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
      finalized: false,
      reason: "invalid_message",
    });
    expect(answer).toMatchObject(sourceRoute);
    expect(answer.threadAnswer).toBeUndefined();
    expect(buildLeaderThreadResponseState(target, "q-42").projection.pendingMessageCount).toBe(1);
  });

  it.each([
    "child",
    "agent",
    "injected",
    "ambiguous-id",
    "malformed-owner",
  ] as const)("rejects grouped coverage atomically when a referenced source is %s", (shape) => {
    // Answer routing remains restricted to proven direct-human root sources.
    const target = session();
    const source = human("u2", 2, "q-42") as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    if (shape === "child") source.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
    if (shape === "agent") source.agentSource = { sessionId: "worker", sessionLabel: "Worker" };
    if (shape === "injected") source.content = "[System] You are a leader session. Recover the active board.";
    if (shape === "malformed-owner") {
      source.threadRefs = [{ threadKey: "q-42", questId: "q-99", source: "explicit", attachedAt: 2 }];
    }
    target.messageHistory.push(human("u1", 1), source);
    if (shape === "ambiguous-id") target.messageHistory.push({ ...source, id: "duplicate-source" });
    const answer = routedAssistant("invalid-source", "Combined answer.", ["u1", "u2"], target.messageHistory.length);
    target.messageHistory.push(answer);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
      finalized: false,
      reason: "invalid_message",
    });
    expect(answer.threadAnswer).toBeUndefined();
    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessages: [{ userMessageId: "u1" }],
      currentAnswers: [],
      ready: false,
    });
  });

  it.each([
    { ownerGroups: [] },
    { ownerGroups: [{ threadKey: "main", userMessageIds: ["u1", "u2"] }] },
    {
      ownerGroups: [
        { threadKey: "main", userMessageIds: ["u1"] },
        { threadKey: "q-42", userMessageIds: ["u1"] },
      ],
    },
    {
      ownerGroups: [
        { threadKey: "main", userMessageIds: ["u1"] },
        { threadKey: "q-42", userMessageIds: ["u2", "u2"] },
      ],
    },
  ])("rejects a persisted owner snapshot that does not exactly prove its references: $ownerGroups", ({
    ownerGroups,
  }) => {
    // Malformed or tampered snapshots cannot grant partial coverage on restart.
    const target = session();
    target.messageHistory.push(human("u1", 1), human("u2", 2, "q-42"));
    const answer = appendAnswer(target, "invalid-snapshot", ["u1", "u2"], "Recorded answer.", 2);
    answer.threadAnswer!.ownerGroups = ownerGroups;

    expect(isCurrentValidRoutedLeaderResponseMessage(target, answer)).toBe(false);
    expect(buildLeaderThreadResponseState(target, "main").projection.currentAnswers).toEqual([]);
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toEqual([]);
  });

  it("fails closed on unproven, tool-bearing, conflicting-control, child, or detached answer rows", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1));

    const unproven = routedAssistant("unproven", "Answer.", ["u1"], undefined);
    target.messageHistory.push(unproven);
    expect(finalizeRoutedLeaderResponseMessage(target, unproven)).toMatchObject({ reason: "unproven_observation" });

    const toolBearing = routedAssistant("tool-bearing", "Answer.", ["u1"], 1);
    toolBearing.message.content.push({ type: "tool_use", id: "tool", name: "Bash", input: { command: "true" } });
    target.messageHistory.push(toolBearing);
    expect(finalizeRoutedLeaderResponseMessage(target, toolBearing)).toMatchObject({ reason: "invalid_message" });

    const conflicting = routedAssistant("conflicting", "[thread:main:C] Conflicting role.", ["u1"], 1);
    target.messageHistory.push(conflicting);
    expect(finalizeRoutedLeaderResponseMessage(target, conflicting)).toMatchObject({ reason: "invalid_message" });

    const child = routedAssistant("child", "Child answer.", ["u1"], 1);
    child.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
    target.messageHistory.push(child);
    expect(finalizeRoutedLeaderResponseMessage(target, child)).toMatchObject({ reason: "invalid_message" });

    const detached = routedAssistant("detached", "Detached answer.", ["u1"], 1);
    expect(finalizeRoutedLeaderResponseMessage(target, detached)).toMatchObject({ reason: "invalid_message" });
    expect(buildLeaderThreadResponseState(target, "main").projection.pendingMessageCount).toBe(1);
  });

  it("rejects a Quiz-only answer while allowing a Quiz beside substantive prose", () => {
    // Hidden Quiz directives cannot become answer proof by contributing their letters and digits.
    const target = session();
    target.messageHistory.push(human("u1", 1, "q-42"));

    const quizOnly = routedAssistant("quiz-only", "{[(Quest Quiz: q-42)]}", ["u1"], 1, "q-42");
    target.messageHistory.push(quizOnly);
    expect(finalizeRoutedLeaderResponseMessage(target, quizOnly)).toMatchObject({ reason: "invalid_message" });
    expect(buildLeaderThreadResponseState(target, "q-42").projection.pendingMessageCount).toBe(1);

    const answered = routedAssistant(
      "answer-with-quiz",
      "The requested implementation is complete.\n{[(Quest Quiz: q-42)]}",
      ["u1"],
      1,
      "q-42",
    );
    target.messageHistory.push(answered);
    expect(finalizeRoutedLeaderResponseMessage(target, answered)).toMatchObject({ finalized: true });
  });

  it("rejects unfenced control directives while allowing fenced examples", () => {
    for (const [id, text] of [
      ["answer-marker", "Answer.\n[thread:q-2:A:u1]\nMisrouted continuation."],
      ["missing-role", "Answer.\n[thread:q-2]\nMissing role."],
      ["invalid-role", "Answer.\n[thread:q-2:F]\nInvalid role."],
      ["unknown-target", "Answer.\n[thread:side:A:u1]\nUnknown target."],
    ] as const) {
      const target = session();
      target.messageHistory.push(human("u1", 1));
      const answer = routedAssistant(id, text, ["u1"], 1);
      target.messageHistory.push(answer);
      expect(finalizeRoutedLeaderResponseMessage(target, answer)).toMatchObject({
        finalized: false,
        reason: "invalid_message",
      });
    }

    const fencedTarget = session();
    fencedTarget.messageHistory.push(human("u1", 1));
    const fenced = routedAssistant("fenced-example", "Example:\n```text\n[thread:q-2:F]\n```", ["u1"], 1);
    fencedTarget.messageHistory.push(fenced);
    expect(finalizeRoutedLeaderResponseMessage(fencedTarget, fenced)).toMatchObject({ finalized: true });
  });

  it("is idempotent and rejects a reused answer message ID", () => {
    const target = session();
    target.messageHistory.push(human("u1", 1));
    const answer = appendAnswer(target, "stable-answer", ["u1"], "Stable answer.", 1);

    expect(finalizeRoutedLeaderResponseMessage(target, answer)).toEqual({
      finalized: false,
      reason: "already_finalized",
    });
    const duplicate = routedAssistant("stable-answer", "Duplicate ID.", ["u1"], 1);
    target.messageHistory.push(duplicate);
    expect(finalizeRoutedLeaderResponseMessage(target, duplicate)).toMatchObject({ reason: "invalid_message" });
  });

  it("keeps valid legacy response rows source-local and rejects corrupted legacy proof", () => {
    const target = session();
    const first = human("u1", 1) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    const second = human("u2", 2) as Extract<BrowserIncomingMessage, { type: "user_message" }>;
    first.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 3 }];
    second.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill", attachedAt: 4 }];
    target.messageHistory.push(first, second);
    const response = legacyResponse(target, "legacy-final", "Legacy answer.", ["raw-u1", "raw-u2"], 2);

    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 0,
      ready: true,
      currentAnswers: [
        {
          currentMessageId: "legacy-final",
          answerUserMessageIds: ["u1", "u2"],
          coveredAnswerUserMessageIds: ["u1", "u2"],
          source: "legacy",
        },
      ],
    });
    expect(buildLeaderThreadResponseState(target, "q-42").projection.currentAnswers).toEqual([]);

    response.content = "Tampered response.";
    expect(buildLeaderThreadResponseState(target, "main").projection).toMatchObject({
      pendingMessageCount: 2,
      ready: false,
      currentAnswers: [],
    });
  });
});
