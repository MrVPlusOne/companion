import { describe, expect, it } from "vitest";
import { buildFeedModel } from "../hooks/use-feed-model.js";
import type { ChatMessage, LeaderThreadResponseProjection, LeaderThreadResponseState } from "../types.js";
import { buildFeedSections } from "./message-feed-sections.js";
import { resolveThreadResponses } from "./thread-response-presentation.js";

const THREAD_KEY = "q-2024";

function user(answerId: string, historyIndex: number): ChatMessage {
  return {
    id: `raw-${answerId}`,
    role: "user",
    content: answerId,
    timestamp: historyIndex,
    historyIndex,
    metadata: {
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: answerId,
      threadKey: THREAD_KEY,
      questId: THREAD_KEY,
      threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" }],
    },
  };
}

function answer(input: { id: string; answerIds: string[]; historyIndex: number; content?: string }): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: input.content ?? input.id,
    timestamp: input.historyIndex,
    historyIndex: input.historyIndex,
    metadata: {
      leaderThreadRole: "answer",
      threadKey: THREAD_KEY,
      questId: THREAD_KEY,
      threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" }],
      threadAnswer: {
        version: 2,
        answerUserMessageIds: input.answerIds,
        observedHistoryLength: input.historyIndex,
      },
    },
  };
}

function answerState(input: {
  id: string;
  answerIds: string[];
  referencedIds: string[];
  coveredAnswerIds?: string[];
  coveredIds?: string[];
  historyIndex: number;
  source?: "explicit" | "legacy";
}): LeaderThreadResponseState {
  return {
    version: 2,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    answerUserMessageIds: input.answerIds,
    referencedUserMessageIds: input.referencedIds,
    coveredAnswerUserMessageIds: input.coveredAnswerIds ?? input.answerIds,
    coveredUserMessageIds: input.coveredIds ?? input.referencedIds,
    currentMessageId: input.id,
    currentHistoryIndex: input.historyIndex,
    createdAt: input.historyIndex,
    updatedAt: input.historyIndex,
    source: input.source ?? "explicit",
  };
}

function projection(overrides: Partial<LeaderThreadResponseProjection> = {}): LeaderThreadResponseProjection {
  return {
    version: 2,
    threadKey: THREAD_KEY,
    cutoverHistoryIndex: 10,
    pendingMessageCount: 0,
    pendingMessages: [],
    ready: true,
    currentAnswers: [
      answerState({
        id: "a-current",
        answerIds: ["u1", "u2"],
        referencedIds: ["raw-u1", "raw-u2"],
        historyIndex: 14,
      }),
      answerState({ id: "b-current", answerIds: ["u3"], referencedIds: ["raw-u3"], historyIndex: 16 }),
    ],
    ...overrides,
  };
}

function sections(messages: ChatMessage[]) {
  return buildFeedSections(buildFeedModel(messages, true).turns, 30);
}

function validMessages(): ChatMessage[] {
  return [
    user("u1", 10),
    user("u2", 11),
    answer({ id: "a-old", answerIds: ["u1", "u2"], historyIndex: 13 }),
    answer({ id: "a-current", answerIds: ["u1", "u2"], historyIndex: 14 }),
    user("u3", 15),
    answer({
      id: "b-current",
      answerIds: ["u3"],
      historyIndex: 16,
      content: "Answer response\n\n{[(Quest Quiz: q-2024)]}",
    }),
  ];
}

describe("explicit answer presentation", () => {
  it("maps each current answer after its last effective prompt and separates Quiz", () => {
    const result = resolveThreadResponses(sections(validMessages()), projection(), THREAD_KEY);

    expect(result?.currentResponses.map((item) => [item.response.currentMessageId, item.anchorUserMessageId])).toEqual([
      ["a-current", "raw-u2"],
      ["b-current", "raw-u3"],
    ]);
    expect(result?.currentResponses[0]?.referencedUserMessages).toEqual([
      { historyMessageId: "raw-u1", userMessageId: "u1", content: "u1" },
      { historyMessageId: "raw-u2", userMessageId: "u2", content: "u2" },
    ]);
    expect(result?.currentResponses[1]?.collapsedMessageEntry.msg.content).toBe("Answer response");
    expect(result?.currentResponses[1]?.collapsedMessageEntry).not.toBe(result?.currentResponses[1]?.messageEntry);
    expect(result?.currentResponses[1]?.messageEntry.msg.content).toContain("{[(Quest Quiz: q-2024)]}");
    expect(result?.quizGroups).toEqual([{ hostTurnId: "raw-u3", questIds: ["q-2024"] }]);
  });

  it("preserves marker-free response content and identity, including surrounding whitespace", () => {
    // Ready response resolution runs during feed renders. A marker-free answer must not be cloned
    // merely because parsing normalizes whitespace, or unrelated feed updates bypass memoization.
    const messages = validMessages();
    const exactContent = "\nAnswer response without a Quiz\n";
    messages.find((message) => message.id === "b-current")!.content = exactContent;

    const result = resolveThreadResponses(sections(messages), projection(), THREAD_KEY);
    const response = result?.currentResponses[1];

    expect(response?.collapsedMessageEntry).toBe(response?.messageEntry);
    expect(response?.collapsedMessageEntry.msg).toBe(response?.messageEntry.msg);
    expect(response?.collapsedMessageEntry.msg.content).toBe(exactContent);
  });

  it("collects and strips a Quiz carried only in current-answer text blocks", () => {
    const messages = validMessages();
    const current = messages.find((message) => message.id === "b-current")!;
    current.content = "";
    current.contentBlocks = [
      { type: "text", text: "Block-only answer\n\n{[(Quest Quiz: q-2024)]}" },
      { type: "tool_use", id: "preserved-tool", name: "Read", input: { file_path: "README.md" } },
    ];

    const result = resolveThreadResponses(sections(messages), projection(), THREAD_KEY);
    const presented = result?.currentResponses[1];

    expect(presented?.messageEntry.msg.contentBlocks).toEqual([
      { type: "text", text: "Block-only answer\n\n{[(Quest Quiz: q-2024)]}" },
      { type: "tool_use", id: "preserved-tool", name: "Read", input: { file_path: "README.md" } },
    ]);
    expect(presented?.collapsedMessageEntry.msg.content).toBe("Block-only answer");
    expect(presented?.collapsedMessageEntry.msg.contentBlocks).toEqual([
      { type: "text", text: "Block-only answer" },
      { type: "tool_use", id: "preserved-tool", name: "Read", input: { file_path: "README.md" } },
    ]);
    expect(result?.quizGroups).toEqual([{ hostTurnId: "raw-u3", questIds: ["q-2024"] }]);
  });

  it("keeps a Quiz with the earlier turn that actually contains its directive", () => {
    const messages = validMessages();
    messages.find((message) => message.id === "a-current")!.content += "\n\n{[(Quest Quiz: q-2024)]}";
    messages.find((message) => message.id === "b-current")!.content = "Later answer without a Quiz";

    const result = resolveThreadResponses(sections(messages), projection(), THREAD_KEY);

    expect(result?.quizGroups).toEqual([{ hostTurnId: "raw-u2", questIds: ["q-2024"] }]);
    expect(result?.currentResponses[0]?.collapsedMessageEntry.msg.content).toBe("a-current");
    expect(result?.currentResponses[1]?.collapsedMessageEntry.msg.content).toBe("Later answer without a Quiz");
  });

  it("supports partial supersession with effective coverage distinct from original references", () => {
    const messages = [
      user("u1", 10),
      user("u2", 11),
      answer({ id: "a-current", answerIds: ["u1", "u2"], historyIndex: 14 }),
      answer({ id: "b-current", answerIds: ["u2"], historyIndex: 16 }),
    ];
    const state = projection({
      currentAnswers: [
        answerState({
          id: "a-current",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          coveredAnswerIds: ["u1"],
          coveredIds: ["raw-u1"],
          historyIndex: 14,
        }),
        answerState({ id: "b-current", answerIds: ["u2"], referencedIds: ["raw-u2"], historyIndex: 16 }),
      ],
    });

    const result = resolveThreadResponses(sections(messages), state, THREAD_KEY);
    expect(result?.currentResponses.map((item) => [item.response.currentMessageId, item.anchorUserMessageId])).toEqual([
      ["a-current", "raw-u2"],
      ["b-current", "raw-u2"],
    ]);
    expect(result?.currentResponses[0]?.referencedUserMessages).toEqual([
      { historyMessageId: "raw-u1", userMessageId: "u1", content: "u1" },
      { historyMessageId: "raw-u2", userMessageId: "u2", content: "u2" },
    ]);
    expect(result?.currentResponses[1]?.referencedUserMessages).toEqual([
      { historyMessageId: "raw-u2", userMessageId: "u2", content: "u2" },
    ]);
  });

  it("keeps fully superseded explicit rows paired with their original prompts in source chronology", () => {
    // The later answer owns coverage, but the earlier exact row remains part of
    // the collapsed answer set so a shorter lifecycle recap cannot displace it.
    const messages = [
      user("u1", 10),
      user("u2", 11),
      answer({ id: "answer-earlier", answerIds: ["u1", "u2"], historyIndex: 14, content: "Detailed answer" }),
      answer({ id: "answer-later", answerIds: ["u1", "u2"], historyIndex: 16, content: "Complementary answer" }),
    ];
    const state = projection({
      currentAnswers: [
        answerState({
          id: "answer-earlier",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          coveredAnswerIds: [],
          coveredIds: [],
          historyIndex: 14,
        }),
        answerState({
          id: "answer-later",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          historyIndex: 16,
        }),
      ],
    });

    const result = resolveThreadResponses(sections(messages), state, THREAD_KEY);

    expect(result?.currentResponses.map((item) => [item.response.currentMessageId, item.anchorUserMessageId])).toEqual([
      ["answer-earlier", "raw-u2"],
      ["answer-later", "raw-u2"],
    ]);
    expect(result?.currentResponses.map((item) => item.messageEntry.msg.content)).toEqual([
      "Detailed answer",
      "Complementary answer",
    ]);
    expect(result?.currentResponses[0]?.messageEntry.msg.id).toBe("answer-earlier");
    expect(result?.currentResponses[0]?.collapsedMessageEntry).toBe(result?.currentResponses[0]?.messageEntry);
    expect(result?.currentResponses[0]?.referencedUserMessages).toEqual([
      { historyMessageId: "raw-u1", userMessageId: "u1", content: "u1" },
      { historyMessageId: "raw-u2", userMessageId: "u2", content: "u2" },
    ]);
  });

  it("keeps overlapping answer sets chronological when later coverage points to an earlier prompt", () => {
    // Without shared-set anchoring, the later u1 answer would render before
    // the earlier grouped answer merely because u1 appears before u2.
    const messages = [
      user("u1", 10),
      user("u2", 11),
      answer({ id: "answer-earlier-group", answerIds: ["u1", "u2"], historyIndex: 14 }),
      answer({ id: "answer-later-u1", answerIds: ["u1"], historyIndex: 16 }),
    ];
    const state = projection({
      currentAnswers: [
        answerState({
          id: "answer-earlier-group",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          coveredAnswerIds: ["u2"],
          coveredIds: ["raw-u2"],
          historyIndex: 14,
        }),
        answerState({ id: "answer-later-u1", answerIds: ["u1"], referencedIds: ["raw-u1"], historyIndex: 16 }),
      ],
    });

    expect(
      resolveThreadResponses(sections(messages), state, THREAD_KEY)?.currentResponses.map((item) => [
        item.response.currentMessageId,
        item.anchorUserMessageId,
      ]),
    ).toEqual([
      ["answer-earlier-group", "raw-u2"],
      ["answer-later-u1", "raw-u2"],
    ]);
  });

  it("fails closed for overlapping effective coverage or mismatched answer proof", () => {
    const overlap = projection({
      currentAnswers: [
        ...projection().currentAnswers,
        answerState({ id: "b-current", answerIds: ["u2"], referencedIds: ["raw-u2"], historyIndex: 16 }),
      ],
    });
    expect(resolveThreadResponses(sections(validMessages()), overlap, THREAD_KEY)).toBeNull();

    const mismatch = projection({
      currentAnswers: [
        { ...projection().currentAnswers[0]!, answerUserMessageIds: ["u9"] },
        projection().currentAnswers[1]!,
      ],
    });
    expect(resolveThreadResponses(sections(validMessages()), mismatch, THREAD_KEY)).toBeNull();

    const emptyLegacy = projection({
      currentAnswers: [
        answerState({
          id: "a-current",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          coveredAnswerIds: [],
          coveredIds: [],
          historyIndex: 14,
          source: "legacy",
        }),
        projection().currentAnswers[1]!,
      ],
    });
    expect(resolveThreadResponses(sections(validMessages()), emptyLegacy, THREAD_KEY)).toBeNull();
  });

  it("retains current answer identity while an older request remains pending", () => {
    const messages = [...validMessages(), user("u4", 17)];
    const active = projection({
      ready: false,
      pendingMessageCount: 1,
      pendingMessages: [{ userMessageId: "u4", historyMessageId: "raw-u4", historyIndex: 17, askedAt: 17 }],
    });

    const result = resolveThreadResponses(sections(messages), active, THREAD_KEY);
    expect(result?.ready).toBe(false);
    expect(result?.currentResponses.map((item) => item.response.currentMessageId)).toEqual(["a-current", "b-current"]);
  });

  it("accepts validated legacy rows but rejects commentary carrying legacy metadata", () => {
    const messages = validMessages();
    const legacy = messages.find((message) => message.id === "a-current")!;
    legacy.metadata = {
      ...legacy.metadata,
      leaderThreadRole: undefined,
      leaderUserMessage: true,
      threadAnswer: undefined,
      threadResponse: {
        logicalResponseId: "legacy",
        revisionId: "legacy-r1",
        revisionNumber: 1,
        batchId: "legacy-batch",
        batchObservedHistoryLength: 14,
        coveredUserMessageIds: ["raw-u1", "raw-u2"],
        contentHash: "legacy-hash",
      },
    };
    const legacyState = projection({
      currentAnswers: [
        answerState({
          id: "a-current",
          answerIds: ["u1", "u2"],
          referencedIds: ["raw-u1", "raw-u2"],
          historyIndex: 14,
          source: "legacy",
        }),
        projection().currentAnswers[1]!,
      ],
    });
    expect(resolveThreadResponses(sections(messages), legacyState, THREAD_KEY)).not.toBeNull();

    legacy.metadata = { ...legacy.metadata, leaderUserMessage: false, leaderThreadRole: "commentary" };
    expect(resolveThreadResponses(sections(messages), legacyState, THREAD_KEY)).toBeNull();
  });

  it("projects one Main answer into an associated quest without changing its stable identity", () => {
    const attachedMainUser: ChatMessage = {
      id: "raw-u25",
      role: "user",
      content: "Main request associated with q-2024",
      timestamp: 10,
      historyIndex: 10,
      metadata: {
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u25",
        threadKey: "main",
        threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
      },
    };
    const mainAnswer: ChatMessage = {
      id: "answer-main-u25",
      role: "assistant",
      content: "Main answer reused by the associated quest",
      timestamp: 11,
      historyIndex: 11,
      metadata: {
        leaderThreadRole: "answer",
        threadKey: "main",
        threadAnswer: { version: 2, answerUserMessageIds: ["u25"], observedHistoryLength: 11 },
      },
    };
    const state = projection({
      cutoverHistoryIndex: 10,
      currentAnswers: [
        {
          ...answerState({
            id: mainAnswer.id,
            answerIds: ["u25"],
            referencedIds: [attachedMainUser.id],
            coveredIds: [],
            coveredAnswerIds: [],
            historyIndex: 11,
          }),
          threadKey: "main",
          questId: undefined,
        },
      ],
    });

    const result = resolveThreadResponses(sections([attachedMainUser, mainAnswer]), state, THREAD_KEY);

    expect(result?.currentResponses).toHaveLength(1);
    expect(result?.currentResponses[0]).toMatchObject({
      anchorUserMessageId: attachedMainUser.id,
      response: { threadKey: "main", currentMessageId: mainAnswer.id },
    });
    expect(result?.currentResponses[0]?.messageEntry.msg.id).toBe(mainAnswer.id);
    expect(result?.currentResponses[0]?.collapsedMessageEntry.msg.id).toBe(mainAnswer.id);
    expect(result?.currentResponseMessageIds).toEqual(new Set([mainAnswer.id]));

    const conflictingRouteAnswer: ChatMessage = {
      ...mainAnswer,
      metadata: { ...mainAnswer.metadata, questId: THREAD_KEY },
    };
    expect(resolveThreadResponses(sections([attachedMainUser, conflictingRouteAnswer]), state, THREAD_KEY)).toBeNull();
    expect(
      resolveThreadResponses(
        sections([attachedMainUser, { ...mainAnswer, historyIndex: undefined }]),
        state,
        THREAD_KEY,
      ),
    ).toBeNull();
  });

  it("keeps canonical quest-owned answers chronological in another associated quest", () => {
    const ownerThreadKey = "q-2042";
    const selectedThreadKey = "q-2044";
    const prompts: ChatMessage[] = [
      {
        id: "raw-u37",
        role: "user",
        content: "Implement the approved behavior",
        timestamp: 10,
        historyIndex: 10,
        metadata: {
          leaderResponseCoverageVersion: 1,
          leaderUserMessageId: "u37",
          threadKey: ownerThreadKey,
          questId: ownerThreadKey,
          threadRefs: [
            { threadKey: ownerThreadKey, questId: ownerThreadKey, source: "explicit" },
            { threadKey: selectedThreadKey, questId: selectedThreadKey, source: "backfill" },
          ],
        },
      },
      {
        id: "raw-u38",
        role: "user",
        content: "Proceed with Work",
        timestamp: 11,
        historyIndex: 11,
        metadata: {
          leaderResponseCoverageVersion: 1,
          leaderUserMessageId: "u38",
          threadKey: ownerThreadKey,
          questId: ownerThreadKey,
          threadRefs: [
            { threadKey: ownerThreadKey, questId: ownerThreadKey, source: "explicit" },
            { threadKey: selectedThreadKey, questId: selectedThreadKey, source: "backfill" },
          ],
        },
      },
    ];
    const sourceRoute = {
      threadKey: ownerThreadKey,
      questId: ownerThreadKey,
      threadRefs: [{ threadKey: ownerThreadKey, questId: ownerThreadKey, source: "explicit" as const }],
    };
    const earlierAnswer: ChatMessage = {
      id: "earlier-design-answer",
      role: "assistant",
      content: "The approved design keeps every valid answer visible.",
      timestamp: 14,
      historyIndex: 14,
      metadata: {
        ...sourceRoute,
        leaderThreadRole: "answer",
        threadAnswer: { version: 2, answerUserMessageIds: ["u37", "u38"], observedHistoryLength: 12 },
      },
    };
    const canonicalAnswer: ChatMessage = {
      id: "approved-behavior-implemented",
      role: "assistant",
      content: "The approved behavior is now implemented.",
      timestamp: 16,
      historyIndex: 16,
      metadata: {
        ...sourceRoute,
        threadRefs: [
          ...sourceRoute.threadRefs,
          { threadKey: selectedThreadKey, questId: selectedThreadKey, source: "backfill" },
        ],
        leaderThreadRole: "answer",
        threadAnswer: { version: 2, answerUserMessageIds: ["u37", "u38"], observedHistoryLength: 12 },
      },
    };
    const state: LeaderThreadResponseProjection = {
      version: 2,
      threadKey: selectedThreadKey,
      cutoverHistoryIndex: 10,
      pendingMessageCount: 0,
      pendingMessages: [],
      ready: true,
      currentAnswers: [
        {
          version: 2,
          threadKey: ownerThreadKey,
          questId: ownerThreadKey,
          answerUserMessageIds: ["u37", "u38"],
          referencedUserMessageIds: ["raw-u37", "raw-u38"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
          currentMessageId: earlierAnswer.id,
          currentHistoryIndex: 14,
          createdAt: 14,
          updatedAt: 14,
          source: "explicit",
        },
        {
          version: 2,
          threadKey: ownerThreadKey,
          questId: ownerThreadKey,
          answerUserMessageIds: ["u37", "u38"],
          referencedUserMessageIds: ["raw-u37", "raw-u38"],
          coveredAnswerUserMessageIds: [],
          coveredUserMessageIds: [],
          currentMessageId: canonicalAnswer.id,
          currentHistoryIndex: 16,
          createdAt: 16,
          updatedAt: 16,
          source: "explicit",
        },
      ],
    };

    const result = resolveThreadResponses(
      sections([...prompts, earlierAnswer, canonicalAnswer]),
      state,
      selectedThreadKey,
    );

    expect(result?.currentResponses.map((item) => item.response.currentMessageId)).toEqual([
      earlierAnswer.id,
      canonicalAnswer.id,
    ]);
    expect(result?.currentResponses.map((item) => item.messageEntry.msg.content)).toEqual([
      "The approved design keeps every valid answer visible.",
      "The approved behavior is now implemented.",
    ]);
    expect(result?.currentResponses.every((item) => item.response.threadKey === ownerThreadKey)).toBe(true);
    expect(result?.currentResponses.every((item) => item.anchorUserMessageId === "raw-u38")).toBe(true);
  });

  it("requires complete original-prompt proof before projecting grouped Main prose", () => {
    const attachedMainUser: ChatMessage = {
      id: "raw-u25",
      role: "user",
      content: "Attached Main request",
      timestamp: 10,
      historyIndex: 10,
      metadata: {
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u25",
        threadKey: "main",
        threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
      },
    };
    const groupedMainAnswer: ChatMessage = {
      id: "answer-main-group",
      role: "assistant",
      content: "One Main answer covers both requests",
      timestamp: 12,
      historyIndex: 12,
      metadata: {
        leaderThreadRole: "answer",
        threadKey: "main",
        threadAnswer: { version: 2, answerUserMessageIds: ["u25", "u26"], observedHistoryLength: 12 },
      },
    };
    const state = projection({
      cutoverHistoryIndex: 10,
      currentAnswers: [
        {
          ...answerState({
            id: groupedMainAnswer.id,
            answerIds: ["u25", "u26"],
            referencedIds: [attachedMainUser.id, "raw-u26"],
            coveredAnswerIds: [],
            coveredIds: [],
            historyIndex: 12,
          }),
          threadKey: "main",
          questId: undefined,
        },
      ],
    });

    expect(resolveThreadResponses(sections([attachedMainUser, groupedMainAnswer]), state, THREAD_KEY)).toBeNull();

    const secondAssociatedMainUser: ChatMessage = {
      id: "raw-u26",
      role: "user",
      content: "Second associated Main request",
      timestamp: 11,
      historyIndex: 11,
      metadata: {
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u26",
        threadKey: "main",
        threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
      },
    };
    const result = resolveThreadResponses(
      sections([attachedMainUser, secondAssociatedMainUser, groupedMainAnswer]),
      state,
      THREAD_KEY,
    );

    expect(result?.currentResponses[0]?.response).toMatchObject({
      answerUserMessageIds: ["u25", "u26"],
      referencedUserMessageIds: ["raw-u25", "raw-u26"],
      coveredAnswerUserMessageIds: [],
      coveredUserMessageIds: [],
    });
  });

  it("fails closed when a projected Main answer loses its selected-thread association", () => {
    const detachedMainUser: ChatMessage = {
      id: "raw-u25",
      role: "user",
      content: "Detached Main request",
      timestamp: 10,
      historyIndex: 10,
      metadata: {
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u25",
        threadKey: "main",
      },
    };
    const mainAnswer: ChatMessage = {
      id: "answer-main-u25",
      role: "assistant",
      content: "Detached Main answer",
      timestamp: 11,
      historyIndex: 11,
      metadata: {
        leaderThreadRole: "answer",
        threadKey: "main",
        threadAnswer: { version: 2, answerUserMessageIds: ["u25"], observedHistoryLength: 11 },
      },
    };
    const currentAnswer = {
      ...answerState({
        id: mainAnswer.id,
        answerIds: ["u25"],
        referencedIds: [detachedMainUser.id],
        historyIndex: 11,
      }),
      threadKey: "main",
      questId: undefined,
    };

    expect(
      resolveThreadResponses(
        sections([detachedMainUser, mainAnswer]),
        projection({ cutoverHistoryIndex: 10, currentAnswers: [currentAnswer] }),
        THREAD_KEY,
      ),
    ).toBeNull();
    expect(
      resolveThreadResponses(
        sections([
          {
            ...detachedMainUser,
            metadata: {
              ...detachedMainUser.metadata,
              threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
            },
          },
          mainAnswer,
        ]),
        { ...projection({ cutoverHistoryIndex: 10, currentAnswers: [currentAnswer] }), threadKey: "q-9999" },
        "q-9999",
      ),
    ).toBeNull();
    expect(
      resolveThreadResponses(
        sections([
          {
            ...detachedMainUser,
            metadata: {
              ...detachedMainUser.metadata,
              threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
            },
          },
          {
            ...mainAnswer,
            metadata: {
              ...mainAnswer.metadata,
              leaderThreadRole: "response",
              threadAnswer: undefined,
              threadResponse: {
                logicalResponseId: "legacy",
                revisionId: "legacy-r1",
                revisionNumber: 1,
                batchId: "legacy-batch",
                batchObservedHistoryLength: 11,
                coveredUserMessageIds: [detachedMainUser.id],
                contentHash: "legacy-hash",
              },
            },
          },
        ]),
        projection({
          cutoverHistoryIndex: 10,
          currentAnswers: [{ ...currentAnswer, source: "legacy" }],
        }),
        THREAD_KEY,
      ),
    ).toBeNull();
  });

  it("keeps backfill visibility separate and preserves normal fallbacks", () => {
    const backfilledMain: ChatMessage = {
      id: "main-backfill",
      role: "user",
      content: "Main-owned context",
      timestamp: 17,
      historyIndex: 17,
      metadata: {
        leaderResponseCoverageVersion: 1,
        threadKey: "main",
        threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill" }],
      },
    };

    expect(
      resolveThreadResponses(sections([...validMessages(), backfilledMain]), projection(), THREAD_KEY),
    ).not.toBeNull();
    expect(
      resolveThreadResponses(sections(validMessages()), projection({ cutoverHistoryIndex: 12 }), THREAD_KEY),
    ).toBeNull();
    expect(resolveThreadResponses(sections(validMessages()), undefined, THREAD_KEY)).toBeNull();
    expect(resolveThreadResponses(sections(validMessages()), projection(), "all")).toBeNull();
  });
});
