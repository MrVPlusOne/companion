// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage, QuestmasterTask, SessionState } from "../types.js";
import { useStore } from "../store.js";
import { createWsMessageHandler } from "../ws-handlers.js";
import {
  createLeaderThreadTabsProjectionEnvelope,
  createLeaderThreadTabsProjectionValue,
} from "../test-fixtures/leader-thread-tabs-projection.js";
import { MessageFeed } from "./MessageFeed.js";

const apiMocks = vi.hoisted(() => ({
  getQuestValidated: vi.fn().mockResolvedValue({ status: "not-modified", etag: '"response-detail"' }),
}));
const sendToSession = vi.hoisted(() => vi.fn(() => true));

vi.mock("../api.js", () => ({ api: apiMocks }));
vi.mock("../ws.js", () => ({ sendToSession }));
vi.mock("../utils/notification-sound.js", () => ({
  playNotificationSound: vi.fn(),
  playNeedsInputSound: vi.fn(),
  playReviewSound: vi.fn(),
}));

const SESSION_ID = "leader-response-window";
const QUEST_ID = "q-2024";
const UNRELATED_QUEST_ID = "q-9090";
const THREAD_REF = { threadKey: QUEST_ID, questId: QUEST_ID, source: "explicit" as const };
const ASSOCIATED_MAIN_USER_ID = "user-main-attached";
const ASSOCIATED_MAIN_ANSWER_ID = "answer-main-u25";
const ASSOCIATED_MAIN_USER_TEXT = "Main request associated with q-2024";
const ASSOCIATED_MAIN_ANSWER_TEXT = "The Main answer remains the representative in its associated quest.";
const handleMessage = createWsMessageHandler({ disconnectSession: vi.fn(), sendToSession });

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

function leaderSession(): SessionState {
  return {
    session_id: SESSION_ID,
    isOrchestrator: true,
    backend_type: "claude",
    model: "claude-opus-4-20250514",
    cwd: "/tmp/takode",
    tools: [],
    permissionMode: "default",
    claude_code_version: "2.1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "main",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/tmp/takode",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function routedFields() {
  return { threadKey: QUEST_ID, questId: QUEST_ID, threadRefs: [THREAD_REF] };
}

function answerIdForRawUserMessage(id: string): string {
  const ids: Record<string, string> = {
    "user-first": "u1",
    "user-second": "u2",
    "user-third": "u3",
    "user-live": "u4",
    "user-quiz-owner": "u1",
    "user-later": "u2",
    "user-only": "u1",
    "user-older-pending": "u1",
    "user-later-answered": "u2",
    [ASSOCIATED_MAIN_USER_ID]: "u25",
  };
  const answerId = ids[id];
  if (!answerId) throw new Error(`Missing answer ID fixture for ${id}`);
  return answerId;
}

function userMessage(id: string, text: string, timestamp: number, responseCoverage = true): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content: text,
    timestamp,
    ...(responseCoverage
      ? { leaderResponseCoverageVersion: 1 as const, leaderUserMessageId: answerIdForRawUserMessage(id) }
      : {}),
    ...routedFields(),
  };
}

function assistantMessage(
  id: string,
  text: string,
  timestamp: number,
  codexMessagePhase?: "commentary" | "final_answer",
  leaderThreadRole?: "commentary" | "answer" | "response",
): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    ...(codexMessagePhase ? { codexMessagePhase } : {}),
    ...(leaderThreadRole ? { leaderThreadRole } : {}),
    ...routedFields(),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-20250514",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function toolMessage(
  id: string,
  toolUseId: string,
  timestamp: number,
): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp,
    parent_tool_use_id: null,
    leaderThreadRole: "commentary",
    ...routedFields(),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-20250514",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "quest show q-2024" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function responseMessage(input: {
  id: string;
  coveredUserMessageIds: string[];
  content: string;
  timestamp: number;
  observedHistoryLength?: number;
}): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp: input.timestamp,
    parent_tool_use_id: null,
    leaderThreadRole: "answer",
    ...routedFields(),
    threadAnswer: {
      version: 2,
      answerUserMessageIds: input.coveredUserMessageIds.map(answerIdForRawUserMessage),
      observedHistoryLength:
        input.observedHistoryLength ??
        Math.max(
          ...input.coveredUserMessageIds.map(
            (id) =>
              ({
                "user-first": 41,
                "user-second": 42,
                "user-third": 45,
                "user-quiz-owner": 41,
                "user-later": 44,
                "user-only": 41,
              })[id] ?? 0,
          ),
        ),
    },
    message: {
      id: input.id,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-20250514",
      content: [{ type: "text", text: input.content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function quest(): QuestmasterTask {
  return {
    id: `${QUEST_ID}-v4`,
    questId: QUEST_ID,
    version: 4,
    title: "Leader thread responses",
    description: "Keep polished responses visible when Ready.",
    status: "done",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_006_000,
    verificationItems: [],
    quizItems: [
      {
        id: "response-history",
        question: "What remains available after a response is revised?",
        answer: "The complete chronological thread history.",
      },
    ],
  };
}

function responseState(
  ready = true,
): NonNullable<Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>["response_state"]> {
  return {
    version: 2,
    threadKey: QUEST_ID,
    cutoverHistoryIndex: 40,
    pendingMessageCount: ready ? 0 : 1,
    pendingMessages: ready
      ? []
      : [
          {
            userMessageId: "u3",
            historyMessageId: "user-third",
            historyIndex: 44,
            askedAt: 1_700_000_005_000,
          },
        ],
    currentAnswers: [
      {
        version: 2,
        threadKey: QUEST_ID,
        questId: QUEST_ID,
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["user-first", "user-second"],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
        currentMessageId: "response-grouped-r1",
        currentHistoryIndex: 42,
        createdAt: 1_700_000_003_000,
        updatedAt: 1_700_000_003_000,
        source: "explicit",
      },
      {
        version: 2,
        threadKey: QUEST_ID,
        questId: QUEST_ID,
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["user-first", "user-second"],
        coveredAnswerUserMessageIds: ["u1", "u2"],
        coveredUserMessageIds: ["user-first", "user-second"],
        currentMessageId: "response-grouped-r2",
        currentHistoryIndex: 43,
        createdAt: 1_700_000_004_000,
        updatedAt: 1_700_000_004_000,
        source: "explicit",
      },
      ...(ready
        ? [
            {
              version: 2 as const,
              threadKey: QUEST_ID,
              questId: QUEST_ID,
              answerUserMessageIds: ["u3"],
              referencedUserMessageIds: ["user-third"],
              coveredAnswerUserMessageIds: ["u3"],
              coveredUserMessageIds: ["user-third"],
              currentMessageId: "response-single-r1",
              currentHistoryIndex: 46,
              createdAt: 1_700_000_007_000,
              updatedAt: 1_700_000_007_000,
              source: "explicit" as const,
            },
          ]
        : []),
    ],
    ready,
  };
}

function associatedMainUserMessage(): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id: ASSOCIATED_MAIN_USER_ID,
    content: ASSOCIATED_MAIN_USER_TEXT,
    timestamp: 1_700_000_021_000,
    leaderResponseCoverageVersion: 1,
    leaderUserMessageId: "u25",
    threadKey: "main",
    threadRefs: [
      {
        threadKey: QUEST_ID,
        questId: QUEST_ID,
        source: "backfill",
        attachedAt: 1_700_000_021_500,
        attachedBy: "leader-session",
      },
    ],
  };
}

function associatedMainAnswerMessage(): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    timestamp: 1_700_000_024_000,
    parent_tool_use_id: null,
    codexMessagePhase: "final_answer",
    leaderThreadRole: "answer",
    threadKey: "main",
    threadAnswer: { version: 2, answerUserMessageIds: ["u25"], observedHistoryLength: 43 },
    message: {
      id: ASSOCIATED_MAIN_ANSWER_ID,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-20250514",
      content: [{ type: "text", text: ASSOCIATED_MAIN_ANSWER_TEXT }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function associatedMainAnswerState(
  projectionThreadKey: string,
): NonNullable<Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>["response_state"]> {
  return {
    version: 2,
    threadKey: projectionThreadKey,
    cutoverHistoryIndex: 40,
    pendingMessageCount: 0,
    pendingMessages: [],
    ready: true,
    currentAnswers: [
      {
        version: 2,
        threadKey: "main",
        answerUserMessageIds: ["u25"],
        referencedUserMessageIds: [ASSOCIATED_MAIN_USER_ID],
        coveredAnswerUserMessageIds: projectionThreadKey === "main" ? ["u25"] : [],
        coveredUserMessageIds: projectionThreadKey === "main" ? [ASSOCIATED_MAIN_USER_ID] : [],
        currentMessageId: ASSOCIATED_MAIN_ANSWER_ID,
        currentHistoryIndex: 43,
        createdAt: 1_700_000_024_000,
        updatedAt: 1_700_000_024_000,
        source: "explicit",
      },
    ],
  };
}

function producerAssociatedMainAnswerWindows(): {
  main: Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>;
  quest: Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>;
} {
  const user = associatedMainUserMessage();
  const answer = associatedMainAnswerMessage();
  const questProgress = assistantMessage(
    "associated-quest-progress",
    "Quest-side implementation detail stays behind expansion.",
    1_700_000_022_000,
    "commentary",
    "commentary",
  );
  const questTool = toolMessage("associated-quest-tool", "associated-tool-show-quest", 1_700_000_023_000);
  const questQuiz = assistantMessage(
    "associated-quest-quiz",
    `{[(Quest Quiz: ${QUEST_ID})]}`,
    1_700_000_025_000,
    "commentary",
    "commentary",
  );
  return {
    main: {
      type: "thread_window_sync",
      thread_key: "main",
      entries: [
        { history_index: 40, message: user },
        { history_index: 43, message: answer },
      ],
      window: {
        thread_key: "main",
        from_item: 0,
        item_count: 2,
        total_items: 2,
        has_older_items: false,
        has_newer_items: false,
        source_history_length: 45,
        section_item_count: 30,
        visible_item_count: 2,
      },
      response_state: associatedMainAnswerState("main"),
    },
    quest: {
      type: "thread_window_sync",
      thread_key: QUEST_ID,
      entries: [
        { history_index: 40, message: user },
        { history_index: 41, message: questProgress },
        { history_index: 42, message: questTool },
        { history_index: 43, message: answer },
        { history_index: 44, message: questQuiz },
      ],
      window: {
        thread_key: QUEST_ID,
        from_item: 0,
        item_count: 5,
        total_items: 5,
        has_older_items: false,
        has_newer_items: false,
        source_history_length: 45,
        section_item_count: 30,
        visible_item_count: 5,
      },
      response_state: associatedMainAnswerState(QUEST_ID),
    },
  };
}

function producerEmptyThreadWindow(threadKey: string): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  return {
    type: "thread_window_sync",
    thread_key: threadKey,
    entries: [],
    window: {
      thread_key: threadKey,
      from_item: 0,
      item_count: 0,
      total_items: 0,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 46,
      section_item_count: 30,
      visible_item_count: 0,
    },
    // Omit response_state so the authoritative replacement clears cached response presentation.
  };
}

function producerThreadWindow(ready = true): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const entries = [
    { history_index: 40, message: userMessage("user-first", "First pending request", 1_700_000_001_000) },
    { history_index: 41, message: userMessage("user-second", "Second pending request", 1_700_000_002_000) },
    {
      history_index: 42,
      message: responseMessage({
        id: "response-grouped-r1",
        coveredUserMessageIds: ["user-first", "user-second"],
        content: "Earlier grouped response",
        timestamp: 1_700_000_003_000,
      }),
    },
    {
      history_index: 43,
      message: responseMessage({
        id: "response-grouped-r2",
        coveredUserMessageIds: ["user-first", "user-second"],
        content: "Current grouped response",
        timestamp: 1_700_000_004_000,
      }),
    },
    { history_index: 44, message: userMessage("user-third", "Third pending request", 1_700_000_005_000) },
    {
      history_index: 45,
      message: assistantMessage(
        "assistant-intermediate",
        "Intermediate leader and tool activity",
        1_700_000_006_000,
        undefined,
        "commentary",
      ),
    },
    ...(ready
      ? [
          {
            history_index: 46,
            message: responseMessage({
              id: "response-single-r1",
              coveredUserMessageIds: ["user-third"],
              content: "Current singleton response",
              timestamp: 1_700_000_007_000,
            }),
          },
          {
            history_index: 47,
            message: assistantMessage(
              "assistant-quiz",
              `{[(Quest Quiz: ${QUEST_ID})]}`,
              1_700_000_008_000,
              undefined,
              "commentary",
            ),
          },
        ]
      : []),
    {
      history_index: 48,
      message: {
        type: "compact_marker",
        id: "hidden-compact",
        summary: "Hidden compact marker",
        timestamp: 1_700_000_009_000,
        ...routedFields(),
      } as BrowserIncomingMessage,
    },
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 49,
      section_item_count: 30,
      visible_item_count: 10,
    },
    response_state: responseState(ready),
  };
}

function producerThreadWindowWithSeparateReady(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const sync = producerThreadWindow();
  const readyStatus = {
    kind: "ready" as const,
    label: "Thread Ready" as const,
    threadKey: QUEST_ID,
    questId: QUEST_ID,
    summary: "responses complete",
    messageId: "assistant-ready",
    timestamp: 1_700_000_009_000,
    updatedAt: 1_700_000_009_000,
  };
  const readyMessage = assistantMessage(
    "assistant-ready",
    "Ready status published after the answer.",
    readyStatus.timestamp,
    undefined,
    "commentary",
  );
  readyMessage.threadStatusMarkers = [readyStatus];
  const entries = [
    ...sync.entries.filter((entry) => entry.history_index !== 48),
    { history_index: 48, message: readyMessage },
    ...sync.entries.filter((entry) => entry.history_index === 48).map((entry) => ({ ...entry, history_index: 49 })),
  ];
  return {
    ...sync,
    entries,
    window: { ...sync.window, item_count: entries.length, total_items: entries.length, source_history_length: 50 },
  };
}

function producerEarlierQuizThenLaterReadyResponse(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const firstResponseTimestamp = 1_700_000_002_000;
  const laterResponseTimestamp = 1_700_000_005_000;
  const observedHistoryLength = 45;
  const entries = [
    {
      history_index: 40,
      message: userMessage("user-quiz-owner", "Request whose response owns the Quiz", 1_700_000_001_000),
    },
    {
      history_index: 41,
      message: responseMessage({
        id: "response-quiz-owner-r1",
        observedHistoryLength: 41,
        coveredUserMessageIds: ["user-quiz-owner"],
        content: "Earlier response with a same-turn Quiz",
        timestamp: firstResponseTimestamp,
      }),
    },
    {
      history_index: 42,
      message: assistantMessage(
        "assistant-earlier-quiz",
        `{[(Quest Quiz: ${QUEST_ID})]}`,
        1_700_000_003_000,
        undefined,
        "commentary",
      ),
    },
    { history_index: 43, message: userMessage("user-later", "Later request without a Quiz", 1_700_000_004_000) },
    {
      history_index: 44,
      message: responseMessage({
        id: "response-later-r1",
        observedHistoryLength: 44,
        coveredUserMessageIds: ["user-later"],
        content: "Later current response without a Quiz",
        timestamp: laterResponseTimestamp,
      }),
    },
  ];

  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: observedHistoryLength,
      section_item_count: 30,
      visible_item_count: entries.length,
    },
    response_state: {
      version: 2,
      threadKey: QUEST_ID,
      cutoverHistoryIndex: 40,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["user-quiz-owner"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["user-quiz-owner"],
          currentMessageId: "response-quiz-owner-r1",
          currentHistoryIndex: 41,
          createdAt: firstResponseTimestamp,
          updatedAt: firstResponseTimestamp,
          source: "explicit",
        },
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u2"],
          referencedUserMessageIds: ["user-later"],
          coveredAnswerUserMessageIds: ["u2"],
          coveredUserMessageIds: ["user-later"],
          currentMessageId: "response-later-r1",
          currentHistoryIndex: 44,
          createdAt: laterResponseTimestamp,
          updatedAt: laterResponseTimestamp,
          source: "explicit",
        },
      ],
      ready: true,
    },
  };
}

function producerLaterAnswerWhileOlderPending(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const entries = [
    {
      history_index: 40,
      message: userMessage("user-older-pending", "Older implementation request", 1_700_000_001_000),
    },
    { history_index: 41, message: userMessage("user-later-answered", "Later clarification", 1_700_000_002_000) },
    {
      history_index: 42,
      message: responseMessage({
        id: "answer-later-clarification",
        observedHistoryLength: 42,
        coveredUserMessageIds: ["user-later-answered"],
        content: "The clarification is fully answered while implementation continues.",
        timestamp: 1_700_000_003_000,
      }),
    },
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 43,
      section_item_count: 30,
      visible_item_count: entries.length,
    },
    response_state: {
      version: 2,
      threadKey: QUEST_ID,
      cutoverHistoryIndex: 40,
      pendingMessageCount: 1,
      pendingMessages: [
        { userMessageId: "u1", historyMessageId: "user-older-pending", historyIndex: 40, askedAt: 1_700_000_001_000 },
      ],
      currentAnswers: [
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u2"],
          referencedUserMessageIds: ["user-later-answered"],
          coveredAnswerUserMessageIds: ["u2"],
          coveredUserMessageIds: ["user-later-answered"],
          currentMessageId: "answer-later-clarification",
          currentHistoryIndex: 42,
          createdAt: 1_700_000_003_000,
          updatedAt: 1_700_000_003_000,
          source: "explicit",
        },
      ],
      ready: false,
    },
  };
}

const UNRESOLVED_PROMPT_ONE_ID = "needs-input-prompt-one";
const UNRESOLVED_PROMPT_TWO_ID = "needs-input-prompt-two";
const STALE_EMBEDDED_PROMPT_ID = "stale-embedded-needs-input-prompt";
const STALE_HERD_ANCHOR_ID = "stale-herd-anchor";

function producerAnswerWithUnresolvedNeedsInputPrompts(): Extract<
  BrowserIncomingMessage,
  { type: "thread_window_sync" }
> {
  const currentAnswer = responseMessage({
    id: "answer-before-needs-input",
    observedHistoryLength: 43,
    coveredUserMessageIds: ["user-later-answered"],
    content: "The clarification is answered before the next decision.",
    timestamp: 1_700_000_003_000,
  });
  const staleEmbeddedPrompt = assistantMessage(
    STALE_EMBEDDED_PROMPT_ID,
    "Stale embedded prompt must not override authoritative notification state.",
    1_700_000_004_000,
    undefined,
    "commentary",
  );
  staleEmbeddedPrompt.notification = {
    id: "n-stale-embedded",
    category: "needs-input",
    timestamp: 1_700_000_004_000,
    summary: "Stale embedded decision",
  };
  const firstPrompt = assistantMessage(
    UNRESOLVED_PROMPT_ONE_ID,
    "Choose the deployment boundary.\n\nOption A keeps the current release; option B pauses for another review.",
    1_700_000_005_000,
    undefined,
    "commentary",
  );
  firstPrompt.notification = {
    id: "n-outdated-prompt-snapshot",
    category: "needs-input",
    timestamp: 1_700_000_004_500,
    summary: "Outdated embedded prompt snapshot",
  };
  const secondPrompt = assistantMessage(
    UNRESOLVED_PROMPT_TWO_ID,
    "Confirm whether the follow-up should remain parked while the first choice is unresolved.",
    1_700_000_007_000,
    undefined,
    "commentary",
  );
  const quiz = assistantMessage(
    "needs-input-quiz",
    `{[(Quest Quiz: ${QUEST_ID})]}`,
    1_700_000_008_000,
    undefined,
    "commentary",
  );
  const staleHerdAnchor: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    id: STALE_HERD_ANCHOR_ID,
    content: "1 event from 1 session\n\n#2594 | turn_end | complete",
    timestamp: 1_700_000_009_000,
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    ...routedFields(),
  };
  const entries = [
    {
      history_index: 40,
      message: userMessage("user-older-pending", "Older implementation request", 1_700_000_001_000),
    },
    { history_index: 41, message: userMessage("user-later-answered", "Later clarification", 1_700_000_002_000) },
    { history_index: 42, message: currentAnswer },
    { history_index: 43, message: staleEmbeddedPrompt },
    { history_index: 44, message: firstPrompt },
    { history_index: 45, message: toolMessage("needs-input-tool", "needs-input-tool-use", 1_700_000_006_000) },
    { history_index: 46, message: secondPrompt },
    { history_index: 47, message: quiz },
    { history_index: 48, message: staleHerdAnchor },
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 49,
      section_item_count: 30,
      visible_item_count: entries.length,
    },
    response_state: {
      version: 2,
      threadKey: QUEST_ID,
      cutoverHistoryIndex: 40,
      pendingMessageCount: 1,
      pendingMessages: [
        { userMessageId: "u1", historyMessageId: "user-older-pending", historyIndex: 40, askedAt: 1_700_000_001_000 },
      ],
      currentAnswers: [
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u2"],
          referencedUserMessageIds: ["user-later-answered"],
          coveredAnswerUserMessageIds: ["u2"],
          coveredUserMessageIds: ["user-later-answered"],
          currentMessageId: "answer-before-needs-input",
          currentHistoryIndex: 42,
          createdAt: 1_700_000_003_000,
          updatedAt: 1_700_000_003_000,
          source: "explicit",
        },
      ],
      ready: false,
    },
  };
}

function needsInputNotificationUpdate(
  notifications: Array<{
    id: string;
    messageId: string | null;
    summary: string;
    done?: boolean;
    muted?: boolean;
    threadKey?: string;
  }>,
): Extract<BrowserIncomingMessage, { type: "notification_update" }> {
  return {
    type: "notification_update",
    notifications: notifications.map((notification, index) => ({
      category: "needs-input",
      timestamp: 1_700_000_010_000 + index,
      done: false,
      threadKey: QUEST_ID,
      questId: QUEST_ID,
      ...notification,
      ...(notification.threadKey === "main" ? { questId: undefined } : {}),
    })),
    notificationStatusVersion: 10,
  };
}

function producerAsynchronousAnswerFromLaterTurn(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const answerText = "The earlier request is complete after asynchronous work.";
  const answerTimestamp = 1_700_000_004_000;
  const entries = [
    {
      history_index: 40,
      message: userMessage("user-older-pending", "Earlier asynchronous request", 1_700_000_001_000),
    },
    {
      history_index: 41,
      message: assistantMessage(
        "async-work-progress",
        "The earlier request is still running.",
        1_700_000_002_000,
        undefined,
        "commentary",
      ),
    },
    {
      history_index: 42,
      message: userMessage("user-later-answered", "Later request that triggered completion", 1_700_000_003_000),
    },
    {
      history_index: 43,
      message: responseMessage({
        id: "answer-earlier-from-later-turn",
        observedHistoryLength: 43,
        coveredUserMessageIds: ["user-older-pending"],
        content: `${answerText}\n\n{[(Quest Quiz: ${QUEST_ID})]}`,
        timestamp: answerTimestamp,
      }),
    },
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 44,
      section_item_count: 30,
      visible_item_count: entries.length,
    },
    response_state: {
      version: 2,
      threadKey: QUEST_ID,
      cutoverHistoryIndex: 40,
      pendingMessageCount: 1,
      pendingMessages: [
        {
          userMessageId: "u2",
          historyMessageId: "user-later-answered",
          historyIndex: 42,
          askedAt: 1_700_000_003_000,
        },
      ],
      currentAnswers: [
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["user-older-pending"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["user-older-pending"],
          currentMessageId: "answer-earlier-from-later-turn",
          currentHistoryIndex: 43,
          createdAt: answerTimestamp,
          updatedAt: answerTimestamp,
          source: "explicit",
        },
      ],
      ready: false,
    },
  };
}

function producerFinalResponseOnlyThreadWindow(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const responseTimestamp = 1_700_000_004_000;
  const entries = [
    { history_index: 40, message: userMessage("user-only", "Only pending request", 1_700_000_003_000) },
    {
      history_index: 41,
      message: responseMessage({
        id: "response-only-r1",
        observedHistoryLength: 42,
        coveredUserMessageIds: ["user-only"],
        content: "Only current response",
        timestamp: responseTimestamp,
      }),
    },
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 42,
      section_item_count: 30,
      visible_item_count: 10,
    },
    response_state: {
      version: 2,
      threadKey: QUEST_ID,
      cutoverHistoryIndex: 40,
      pendingMessageCount: 0,
      pendingMessages: [],
      currentAnswers: [
        {
          version: 2,
          threadKey: QUEST_ID,
          questId: QUEST_ID,
          answerUserMessageIds: ["u1"],
          referencedUserMessageIds: ["user-only"],
          coveredAnswerUserMessageIds: ["u1"],
          coveredUserMessageIds: ["user-only"],
          currentMessageId: "response-only-r1",
          currentHistoryIndex: 41,
          createdAt: responseTimestamp,
          updatedAt: responseTimestamp,
          source: "explicit",
        },
      ],
      ready: true,
    },
  };
}

function producerFinalResponseWithToolThreadWindow(): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const sync = producerFinalResponseOnlyThreadWindow();
  const response = sync.entries[1]!;
  const responseState = sync.response_state!;
  return {
    ...sync,
    entries: [
      sync.entries[0]!,
      { history_index: 41, message: toolMessage("assistant-tool", "tool-show-quest", 1_700_000_003_500) },
      { ...response, history_index: 42 },
    ],
    window: {
      ...sync.window,
      item_count: 3,
      total_items: 3,
      source_history_length: 43,
    },
    response_state: {
      ...responseState,
      currentAnswers: responseState.currentAnswers.map((answer) => ({
        ...answer,
        currentHistoryIndex: 42,
      })),
    },
  };
}

function producerMixedCutoverThreadWindow(
  options: { includePreCutoverQuiz?: boolean; includePostCutoverQuiz?: boolean } = {},
): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const postCutover = producerThreadWindow();
  const postCutoverEntries =
    options.includePostCutoverQuiz === false
      ? postCutover.entries.filter((entry) => entry.history_index !== 47)
      : postCutover.entries;
  const entries = [
    {
      history_index: 36,
      message: userMessage("user-before-cutover", "Request before response coverage", 1_699_999_996_000, false),
    },
    {
      history_index: 37,
      message: assistantMessage(
        "assistant-before-cutover-final",
        "Phase-aware response before response coverage",
        1_699_999_997_000,
        "final_answer",
      ),
    },
    ...(options.includePreCutoverQuiz
      ? [
          {
            history_index: 38,
            message: assistantMessage(
              "assistant-before-cutover-quiz",
              `{[(Quest Quiz: ${QUEST_ID})]}`,
              1_699_999_998_000,
              "commentary",
            ),
          },
        ]
      : []),
    {
      history_index: 39,
      message: assistantMessage(
        "assistant-before-cutover-commentary",
        "Pre-cutover commentary stays behind expansion",
        1_699_999_999_000,
        "commentary",
      ),
    },
    ...postCutoverEntries,
  ];
  return {
    ...postCutover,
    entries,
    window: {
      ...postCutover.window,
      item_count: entries.length,
      total_items: entries.length,
      visible_item_count: entries.length,
    },
  };
}

function producerLegacyPhaseOnlyThreadWindow(
  options: { separateQuiz?: boolean } = {},
): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const status = (kind: "waiting" | "ready", messageId: string, timestamp: number) => ({
    kind,
    label: kind === "ready" ? ("Thread Ready" as const) : ("Thread Waiting" as const),
    threadKey: QUEST_ID,
    questId: QUEST_ID,
    summary: kind === "ready" ? "legacy work complete" : "legacy work continues",
    messageId,
    timestamp,
    updatedAt: timestamp,
  });
  const phaseMessage = (
    id: string,
    text: string,
    timestamp: number,
    kind: "waiting" | "ready",
    leaderThreadRole?: "commentary" | "response",
  ) => {
    const message = assistantMessage(id, text, timestamp, "final_answer", leaderThreadRole);
    message.threadStatusMarkers = [status(kind, id, timestamp)];
    return message;
  };
  const herdMessage = (id: string, text: string, timestamp: number): BrowserIncomingMessage => ({
    type: "user_message",
    id,
    content: text,
    timestamp,
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    ...routedFields(),
  });
  const entries = [
    {
      history_index: 10,
      message: userMessage(
        "user-before-cutover",
        "Legacy request before explicit answer coverage",
        1_700_000_001_000,
        false,
      ),
    },
    {
      history_index: 11,
      message: phaseMessage(
        "legacy-setup",
        "Created and dispatched the follow-up quest.",
        1_700_000_002_000,
        "waiting",
      ),
    },
    { history_index: 12, message: toolMessage("legacy-tool", "legacy-tool-use", 1_700_000_003_000) },
    {
      history_index: 13,
      message: herdMessage("legacy-herd-1", "#2609 | turn_end | alignment complete", 1_700_000_004_000),
    },
    {
      history_index: 14,
      message: phaseMessage(
        "legacy-progress",
        "The worker is finishing the guarded transition.",
        1_700_000_005_000,
        "waiting",
      ),
    },
    { history_index: 15, message: herdMessage("legacy-herd-2", "#2609 | turn_end | Work complete", 1_700_000_006_000) },
    {
      history_index: 16,
      message: assistantMessage(
        "legacy-transition",
        "The transition finished; Memory is running.",
        1_700_000_007_000,
        undefined,
        "response",
      ),
    },
    {
      history_index: 17,
      message: herdMessage("legacy-herd-3", "#2609 | turn_end | Memory complete", 1_700_000_008_000),
    },
    {
      history_index: 18,
      message: options.separateQuiz
        ? assistantMessage(
            "legacy-completion",
            "Collapsed turns now have one unified footer.",
            1_700_000_009_000,
            "final_answer",
            "response",
          )
        : phaseMessage(
            "legacy-completion",
            `Collapsed turns now have one unified footer.\n\n{[(Quest Quiz: ${QUEST_ID})]}`,
            1_700_000_009_000,
            "ready",
            "response",
          ),
    },
    ...(options.separateQuiz
      ? [
          {
            history_index: 19,
            message: phaseMessage(
              "legacy-quiz",
              `{[(Quest Quiz: ${QUEST_ID})]}`,
              1_700_000_010_000,
              "ready",
              "commentary",
            ),
          },
        ]
      : []),
  ];
  return {
    type: "thread_window_sync",
    thread_key: QUEST_ID,
    entries,
    window: {
      thread_key: QUEST_ID,
      from_item: 0,
      item_count: entries.length,
      total_items: entries.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: options.separateQuiz ? 20 : 19,
      section_item_count: 30,
      visible_item_count: entries.length,
    },
  };
}

function installAssociatedReadyStatuses() {
  useStore.getState().applySyncedProjectionSnapshot(
    createLeaderThreadTabsProjectionEnvelope({
      key: SESSION_ID,
      value: createLeaderThreadTabsProjectionValue({
        tabs: [],
        mainAttention: { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 },
        activePhaseSummary: [],
        threadStatuses: {
          main: {
            kind: "ready",
            label: "Thread Ready",
            threadKey: "main",
            summary: "Main answer complete",
            messageId: ASSOCIATED_MAIN_ANSWER_ID,
            timestamp: 1_700_000_026_000,
            updatedAt: 1_700_000_026_000,
          },
          [QUEST_ID]: {
            kind: "ready",
            label: "Thread Ready",
            threadKey: QUEST_ID,
            questId: QUEST_ID,
            summary: "Associated quest view complete",
            messageId: "associated-quest-quiz",
            timestamp: 1_700_000_027_000,
            updatedAt: 1_700_000_027_000,
          },
        },
      }),
    }),
  );
}

function installReadyStatus(timestamp = 1_700_000_010_000, messageId = "response-single-r1") {
  useStore.getState().applySyncedProjectionSnapshot(
    createLeaderThreadTabsProjectionEnvelope({
      key: SESSION_ID,
      value: createLeaderThreadTabsProjectionValue({
        tabs: [],
        mainAttention: { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 },
        activePhaseSummary: [],
        threadStatuses: {
          [QUEST_ID]: {
            kind: "ready",
            label: "Thread Ready",
            threadKey: QUEST_ID,
            questId: QUEST_ID,
            summary: "responses complete",
            messageId,
            timestamp,
            updatedAt: timestamp,
          },
        },
      }),
    }),
  );
}

describe("MessageFeed explicit answer selected-window integration", () => {
  beforeEach(() => {
    useStore.getState().reset();
    apiMocks.getQuestValidated.mockClear();
    sendToSession.mockClear();
    act(() => {
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerThreadWindow());
      installReadyStatus();
    });
  });

  it("reuses one Main answer identity across collapsed and expanded Main and associated quest projections", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      const windows = producerAssociatedMainAnswerWindows();
      handleMessage(SESSION_ID, windows.main);
      handleMessage(SESSION_ID, windows.quest);
      handleMessage(SESSION_ID, producerEmptyThreadWindow(UNRELATED_QUEST_ID));
      installAssociatedReadyStatuses();
    });

    const view = render(<MessageFeed key="main" sessionId={SESSION_ID} threadKey="main" />);
    const assertOneAnswerIdentity = () => {
      expect(screen.getAllByText(ASSOCIATED_MAIN_ANSWER_TEXT)).toHaveLength(1);
      expect(view.container.querySelectorAll(`[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"]`)).toHaveLength(1);
    };

    const mainTurn = view.container
      .querySelector<HTMLElement>(`[data-message-id="${ASSOCIATED_MAIN_USER_ID}"]`)!
      .closest<HTMLElement>("[data-turn-id]")!;
    assertOneAnswerIdentity();
    expect(within(mainTurn).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    expect(
      view.container.querySelector(
        `[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"] [data-testid="thread-source-badge"]`,
      ),
    ).toBeNull();
    expect(within(mainTurn).getAllByRole("button", { name: /Show turn activity/ })).toHaveLength(1);

    fireEvent.click(within(mainTurn).getByRole("button", { name: /Show turn activity/ }));
    assertOneAnswerIdentity();
    expect(
      screen
        .getByText(ASSOCIATED_MAIN_ANSWER_TEXT)
        .closest<HTMLElement>("[data-testid='thread-response-current-expanded']"),
    ).toBeInTheDocument();
    expect(within(mainTurn).getByRole("button", { name: /Hide turn activity/ })).toBeVisible();
    fireEvent.click(within(mainTurn).getByRole("button", { name: /Hide turn activity/ }));
    assertOneAnswerIdentity();

    view.rerender(<MessageFeed key={QUEST_ID} sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const questTurn = view.container
      .querySelector<HTMLElement>(`[data-message-id="${ASSOCIATED_MAIN_USER_ID}"]`)!
      .closest<HTMLElement>("[data-turn-id]")!;
    const collapsedAnswerRow = view.container.querySelector<HTMLElement>(
      `[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"]`,
    )!;
    assertOneAnswerIdentity();
    expect(within(questTurn).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    expect(within(collapsedAnswerRow).getByTestId("thread-source-badge")).toHaveTextContent("[thread:main]");
    expect(
      within(questTurn).queryByText("Quest-side implementation detail stays behind expansion."),
    ).not.toBeInTheDocument();
    expect(within(questTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();
    expect(within(questTurn).queryByText(/Quest Quiz:/i)).not.toBeInTheDocument();
    expect(within(questTurn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);

    fireEvent.click(within(questTurn).getByRole("button", { name: /Show turn activity.*1 tool/ }));
    assertOneAnswerIdentity();
    expect(within(questTurn).getByText("Quest-side implementation detail stays behind expansion.")).toBeVisible();
    const expandedAnswerRow = view.container.querySelector<HTMLElement>(
      `[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"]`,
    )!;
    expect(within(expandedAnswerRow).getByTestId("thread-source-badge")).toHaveTextContent("[thread:main]");
    // This quest only displays the Main-owned answer; current-answer chrome
    // follows the selected thread's own request coverage.
    expect(
      screen
        .getByText(ASSOCIATED_MAIN_ANSWER_TEXT)
        .closest<HTMLElement>("[data-testid='thread-response-current-expanded']"),
    ).not.toBeInTheDocument();
    expect(within(questTurn).getByRole("button", { name: /Hide turn activity/ })).toBeVisible();
    expect(within(questTurn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);

    fireEvent.click(within(questTurn).getByRole("button", { name: /Hide turn activity/ }));
    assertOneAnswerIdentity();
    expect(within(questTurn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);

    view.rerender(<MessageFeed key={UNRELATED_QUEST_ID} sessionId={SESSION_ID} threadKey={UNRELATED_QUEST_ID} />);
    expect(screen.queryByText(ASSOCIATED_MAIN_ANSWER_TEXT)).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(`[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"]`)).toHaveLength(0);

    act(() => handleMessage(SESSION_ID, producerEmptyThreadWindow(QUEST_ID)));
    view.rerender(<MessageFeed key={`${QUEST_ID}-detached`} sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    expect(screen.queryByText(ASSOCIATED_MAIN_ANSWER_TEXT)).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(`[data-message-id="${ASSOCIATED_MAIN_ANSWER_ID}"]`)).toHaveLength(0);
  });

  it("keeps a separate Main-owned Quiz in a fallback Ready collapse", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      const sync = producerAssociatedMainAnswerWindows().main;
      const readyStatus = {
        kind: "ready" as const,
        label: "Thread Ready" as const,
        threadKey: "main",
        summary: "Main answer complete",
        messageId: ASSOCIATED_MAIN_ANSWER_ID,
        timestamp: 1_700_000_026_000,
        updatedAt: 1_700_000_026_000,
      };
      const answer = sync.entries.find((entry) => entry.history_index === 43)?.message;
      if (answer?.type !== "assistant") throw new Error("Expected Main answer fixture");
      answer.threadStatusMarkers = [readyStatus];
      const routedQuiz = assistantMessage("main-owned-quiz", `{[(Quest Quiz: ${QUEST_ID})]}`, 1_700_000_025_000);
      const { questId: _questId, threadRefs: _threadRefs, ...mainQuiz } = routedQuiz;
      handleMessage(SESSION_ID, {
        ...sync,
        entries: [...sync.entries, { history_index: 44, message: { ...mainQuiz, threadKey: "main" } }],
        window: { ...sync.window, item_count: 3, total_items: 3, visible_item_count: 3 },
        response_state: undefined,
      });
      installAssociatedReadyStatuses();
    });

    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey="main" />);
    const turn = view.container
      .querySelector<HTMLElement>(`[data-message-id="${ASSOCIATED_MAIN_USER_ID}"]`)!
      .closest<HTMLElement>("[data-turn-id]")!;
    expect(within(turn).getByText(ASSOCIATED_MAIN_ANSWER_TEXT)).toBeVisible();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).queryByText(/Quest Quiz:/i)).not.toBeInTheDocument();
  });

  it("shows only one defensible legacy representative while preserving complete expanded chronology", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerLegacyPhaseOnlyThreadWindow());
      installReadyStatus(1_700_000_010_000, "legacy-completion");
    });

    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen
      .getByText("Legacy request before explicit answer coverage")
      .closest<HTMLElement>("[data-turn-id]")!;

    expect(within(turn).getByText("Collapsed turns now have one unified footer.")).toBeVisible();
    expect(within(turn).queryByText("Created and dispatched the follow-up quest.")).not.toBeInTheDocument();
    expect(within(turn).queryByText("The worker is finishing the guarded transition.")).not.toBeInTheDocument();
    expect(within(turn).queryByText("The transition finished; Memory is running.")).not.toBeInTheDocument();
    expect(within(turn).queryByTestId("thread-response-answer-count")).not.toBeInTheDocument();
    expect(within(turn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-message-id="legacy-completion"]')).toHaveLength(1);
    expect(within(turn).getByRole("region", { name: "Quest quiz" })).toBeVisible();

    fireEvent.click(within(turn).getByRole("button", { name: /Show turn activity.*1 tool/ }));
    const setup = within(turn).getByText("Created and dispatched the follow-up quest.");
    const progress = within(turn).getByText("The worker is finishing the guarded transition.");
    const transition = within(turn).getByText("The transition finished; Memory is running.");
    const completion = within(turn).getByText("Collapsed turns now have one unified footer.");
    expect(setup.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(progress.compareDocumentPosition(transition) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(transition.compareDocumentPosition(completion) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    for (const messageId of ["legacy-setup", "legacy-progress", "legacy-transition", "legacy-completion"]) {
      expect(view.container.querySelectorAll(`[data-message-id="${messageId}"]`)).toHaveLength(1);
    }
    expect(within(turn).getByRole("button", { name: /Hide turn activity/ })).toBeVisible();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);

    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));
    expect(within(turn).getByText("Collapsed turns now have one unified footer.")).toBeVisible();
    expect(within(turn).queryByText("Created and dispatched the follow-up quest.")).not.toBeInTheDocument();
    expect(within(turn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);
  });

  it("keeps a separate Quiz on its fallback Ready turn through collapse toggles", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerLegacyPhaseOnlyThreadWindow({ separateQuiz: true }));
      const quiz = useStore
        .getState()
        .threadWindowMessages.get(SESSION_ID)
        ?.get(QUEST_ID)
        ?.find((message) => message.id === "legacy-quiz");
      if (!quiz) throw new Error("Expected fallback Quiz fixture");
      quiz.content = "";
      quiz.contentBlocks = [{ type: "text", text: `{[(Quest Quiz: ${QUEST_ID})]}` }];
      installReadyStatus(1_700_000_010_000, "legacy-quiz");
    });

    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen
      .getByText("Legacy request before explicit answer coverage")
      .closest<HTMLElement>("[data-turn-id]")!;

    expect(within(turn).getByText("Collapsed turns now have one unified footer.")).toBeVisible();
    expect(within(turn).queryByText("Created and dispatched the follow-up quest.")).not.toBeInTheDocument();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).queryByText(/Quest Quiz:/i)).not.toBeInTheDocument();

    fireEvent.click(within(turn).getByRole("button", { name: /Show turn activity.*1 tool/ }));
    expect(within(turn).getByText("Created and dispatched the follow-up quest.")).toBeVisible();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);

    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
  });

  it("preserves the pre-cutover collapsed response while using response rows after cutover", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerMixedCutoverThreadWindow());
      installReadyStatus();
    });

    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const legacyResponse = screen.getByText("Phase-aware response before response coverage");
    expect(legacyResponse).toBeVisible();
    expect(screen.queryByText("Pre-cutover commentary stays behind expansion")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("thread-response-current")).toHaveLength(3);
    expect(screen.getByText("Earlier grouped response")).toBeVisible();
    expect(screen.getByText("Current grouped response")).toBeVisible();
    expect(screen.getByText("Current singleton response")).toBeVisible();
  });

  it("excludes a pre-cutover Quiz directive from the Ready response presentation", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(
        SESSION_ID,
        producerMixedCutoverThreadWindow({ includePreCutoverQuiz: true, includePostCutoverQuiz: false }),
      );
      installReadyStatus();
    });

    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(screen.getByText("Phase-aware response before response coverage")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Quest quiz" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("thread-response-current")).toHaveLength(3);
  });

  it("shows every valid answer in chronology after its original prompts and one Quiz when Ready", () => {
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const first = screen.getByText("First pending request");
    const second = screen.getByText("Second pending request");
    const third = screen.getByText("Third pending request");
    const earlierGrouped = screen.getByText("Earlier grouped response");
    const grouped = screen.getByText("Current grouped response");
    const singleton = screen.getByText("Current singleton response");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(second.compareDocumentPosition(earlierGrouped) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(earlierGrouped.compareDocumentPosition(grouped) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(third.compareDocumentPosition(singleton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const answerCounts = screen.getAllByTestId("thread-response-answer-count");
    expect(answerCounts).toHaveLength(3);
    expect(answerCounts[0]).toHaveTextContent("Answers 2 messages");
    expect(answerCounts[1]).toHaveTextContent("Answers 2 messages");
    expect(answerCounts[2]).toHaveTextContent("Answers 1 message");
    expect(screen.queryByText("Current answer")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("thread-response-current")).toHaveLength(3);
    for (const answer of [earlierGrouped, grouped, singleton]) {
      const shell = answer.closest<HTMLElement>("[data-testid='thread-response-collapsed-shell']")!;
      expect(shell).toBeInTheDocument();
      expect(shell).not.toHaveClass("gap-2", "sm:gap-3");
      expect(shell.children).toHaveLength(1);
      const messageRow = answer.closest<HTMLElement>("[class~='group/msg']")!;
      expect(messageRow).toBeInTheDocument();
      expect(messageRow).not.toHaveClass("gap-2", "sm:gap-3");
      expect(messageRow.children).toHaveLength(1);
      expect(within(messageRow).getByRole("button", { name: "Message options" })).toBeVisible();
    }
    expect(screen.queryByText("Intermediate leader and tool activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden compact marker")).not.toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(screen.queryByText(/Quest Quiz:/i)).not.toBeInTheDocument();
  });

  it("reveals superseded revisions and intermediate activity in unchanged expanded chronology", () => {
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const thirdTurn = screen.getByText("Third pending request").closest<HTMLElement>("[data-turn-id]")!;
    fireEvent.click(within(thirdTurn).getByRole("button", { name: /Show turn activity/i }));

    expect(screen.getByText("Intermediate leader and tool activity")).toBeVisible();
    expect(screen.getByText("Current singleton response")).toBeVisible();
    const singletonFrame = screen
      .getByText("Current singleton response")
      .closest<HTMLElement>("[data-testid='thread-response-current-expanded']")!;
    expect(singletonFrame).toBeInTheDocument();
    expect(singletonFrame).toHaveClass("border-cc-primary/25");
    expect(singletonFrame).not.toHaveClass("bg-cc-primary/[0.045]");
    expect(within(singletonFrame).queryByText("Current answer")).not.toBeInTheDocument();
    expect(within(singletonFrame).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    const singletonMessageRow = within(singletonFrame)
      .getByText("Current singleton response")
      .closest<HTMLElement>("[class~='group/msg']")!;
    expect(singletonMessageRow).toBeInTheDocument();
    expect(singletonMessageRow).not.toHaveClass("gap-2", "sm:gap-3");
    expect(singletonMessageRow.children).toHaveLength(1);
    expect(within(singletonFrame).getByRole("button", { name: "Message options" })).toBeVisible();
    expect(screen.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);

    const secondTurn = screen.getByText("Second pending request").closest<HTMLElement>("[data-turn-id]")!;
    fireEvent.click(within(secondTurn).getByRole("button", { name: /Show turn activity/i }));
    const earlier = screen.getByText("Earlier grouped response");
    const current = screen.getByText("Current grouped response");
    expect(earlier).toBeVisible();
    expect(current).toBeVisible();
    expect(earlier.closest("[data-testid='thread-response-current-expanded']")).toBeNull();
    const groupedFrame = current.closest<HTMLElement>("[data-testid='thread-response-current-expanded']")!;
    expect(groupedFrame).toBeInTheDocument();
    expect(within(groupedFrame).queryByText("Current answer")).not.toBeInTheDocument();
    expect(within(groupedFrame).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 2 messages");
    const groupedMessageRow = within(groupedFrame)
      .getByText("Current grouped response")
      .closest<HTMLElement>("[class~='group/msg']")!;
    expect(groupedMessageRow).toBeInTheDocument();
    expect(groupedMessageRow).not.toHaveClass("gap-2", "sm:gap-3");
    expect(groupedMessageRow.children).toHaveLength(1);
    expect(within(groupedFrame).getByRole("button", { name: "Message options" })).toBeVisible();
    expect(earlier.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("collapses on a separate fresh Ready commentary row and restores it through manual expansion", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerThreadWindowWithSeparateReady());
      installReadyStatus(1_700_000_009_000, "assistant-ready");
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(screen.getByText("Current singleton response")).toBeVisible();
    expect(screen.queryByText("Ready status published after the answer.")).not.toBeInTheDocument();

    const thirdTurn = screen.getByText("Third pending request").closest<HTMLElement>("[data-turn-id]")!;
    const quiz = within(thirdTurn).getByRole("region", { name: "Quest quiz" });
    const expand = within(thirdTurn).getByRole("button", { name: /Show turn activity/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    // The single top summary precedes retained Quiz content without changing its host.
    expect(quiz.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);

    expand.focus();
    fireEvent.click(expand);
    expect(screen.getByText("Ready status published after the answer.")).toBeVisible();
    expect(screen.getByText("Current singleton response")).toBeVisible();
    const collapse = within(thirdTurn).getByRole("button", { name: /Hide turn activity/ });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(collapse);

    fireEvent.click(collapse);
    expect(screen.queryByText("Ready status published after the answer.")).not.toBeInTheDocument();
    expect(screen.getByText("Current singleton response")).toBeVisible();
    expect(screen.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    const restoredExpand = within(thirdTurn).getByRole("button", { name: /Show turn activity/ });
    expect(restoredExpand).toBeVisible();
    expect(document.activeElement).toBe(restoredExpand);
  });

  it("keeps an earlier Quiz with its producing turn when a later Ready turn collapses", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerEarlierQuizThenLaterReadyResponse());
      installReadyStatus(1_700_000_006_000, "response-later-r1");
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const quizOwnerTurn = screen
      .getByText("Request whose response owns the Quiz")
      .closest<HTMLElement>("[data-turn-id]")!;
    const laterTurn = screen.getByText("Later request without a Quiz").closest<HTMLElement>("[data-turn-id]")!;
    const quiz = within(quizOwnerTurn).getByRole("region", { name: "Quest quiz" });

    expect(quiz).toBeVisible();
    expect(within(laterTurn).queryByRole("region", { name: "Quest quiz" })).not.toBeInTheDocument();
    expect(quiz.compareDocumentPosition(laterTurn) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    fireEvent.click(within(laterTurn).getByRole("button", { name: /Show turn activity/ }));
    expect(within(laterTurn).getByText("Later current response without a Quiz")).toBeVisible();
    expect(within(laterTurn).queryByRole("region", { name: "Quest quiz" })).not.toBeInTheDocument();
    fireEvent.click(within(laterTurn).getByRole("button", { name: /Hide turn activity/ }));
    expect(within(laterTurn).queryByRole("region", { name: "Quest quiz" })).not.toBeInTheDocument();

    fireEvent.click(within(quizOwnerTurn).getByRole("button", { name: /Show turn activity/ }));
    expect(within(quizOwnerTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();
    expect(screen.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    fireEvent.click(within(quizOwnerTurn).getByRole("button", { name: /Hide turn activity/ }));
    expect(within(quizOwnerTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();
  });

  it("keeps exact unresolved needs-input prompts beside a current answer and Quiz until resolution", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerAnswerWithUnresolvedNeedsInputPrompts());
      handleMessage(
        SESSION_ID,
        needsInputNotificationUpdate([
          { id: "n-prompt-one", messageId: UNRESOLVED_PROMPT_ONE_ID, summary: "Choose deployment boundary" },
          {
            id: "n-prompt-two",
            messageId: UNRESOLVED_PROMPT_TWO_ID,
            summary: "Confirm follow-up state",
            muted: true,
          },
        ]),
      );
    });
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen.getByText("Later clarification").closest<HTMLElement>("[data-turn-id]")!;

    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));

    const answer = within(turn).getByText("The clarification is answered before the next decision.");
    const firstPrompt = within(turn).getByText(/Choose the deployment boundary/);
    const secondPrompt = within(turn).getByText(/Confirm whether the follow-up should remain parked/);
    expect(turn.textContent?.indexOf(answer.textContent ?? "")).toBeLessThan(
      turn.textContent?.indexOf(firstPrompt.textContent ?? "") ?? -1,
    );
    expect(turn.textContent?.indexOf(firstPrompt.textContent ?? "")).toBeLessThan(
      turn.textContent?.indexOf(secondPrompt.textContent ?? "") ?? -1,
    );
    expect(view.container.querySelectorAll('[data-message-id="answer-before-needs-input"]')).toHaveLength(1);
    expect(view.container.querySelectorAll(`[data-message-id="${UNRESOLVED_PROMPT_ONE_ID}"]`)).toHaveLength(1);
    expect(view.container.querySelectorAll(`[data-message-id="${UNRESOLVED_PROMPT_TWO_ID}"]`)).toHaveLength(1);
    expect(within(turn).queryByText(/Stale embedded prompt/)).not.toBeInTheDocument();
    expect(within(turn).getAllByTestId("thread-response-needs-input-prompt")).toHaveLength(2);
    expect(within(turn).getAllByTestId("thread-response-answer-count")).toHaveLength(1);
    expect(within(turn).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    expect(within(turn).getByText("Choose deployment boundary")).toBeVisible();
    expect(within(turn).queryByText("Outdated embedded prompt snapshot")).not.toBeInTheDocument();
    expect(within(turn).getByText("Confirm follow-up state")).toBeVisible();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);
    expect(within(turn).queryByLabelText(/Thread Ready/)).not.toBeInTheDocument();

    act(() => {
      handleMessage(
        SESSION_ID,
        needsInputNotificationUpdate([
          {
            id: "n-prompt-one",
            messageId: UNRESOLVED_PROMPT_ONE_ID,
            summary: "Choose deployment boundary",
            done: true,
          },
          {
            id: "n-prompt-two",
            messageId: UNRESOLVED_PROMPT_TWO_ID,
            summary: "Confirm follow-up state",
            muted: true,
          },
        ]),
      );
    });
    expect(within(turn).queryByText(/Choose the deployment boundary/)).not.toBeInTheDocument();
    expect(within(turn).getByText(/Confirm whether the follow-up should remain parked/)).toBeVisible();

    act(() => {
      handleMessage(
        SESSION_ID,
        needsInputNotificationUpdate([
          {
            id: "n-prompt-one",
            messageId: UNRESOLVED_PROMPT_ONE_ID,
            summary: "Choose deployment boundary",
            done: true,
          },
          {
            id: "n-prompt-two",
            messageId: UNRESOLVED_PROMPT_TWO_ID,
            summary: "Confirm follow-up state",
            muted: true,
            done: true,
          },
        ]),
      );
    });
    expect(within(turn).queryByText(/Choose the deployment boundary/)).not.toBeInTheDocument();
    expect(within(turn).queryByText(/Confirm whether the follow-up should remain parked/)).not.toBeInTheDocument();
    expect(within(turn).getByText("The clarification is answered before the next decision.")).toBeVisible();
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);
  });

  it("fails closed for wrong-thread, missing, and stale herd needs-input anchor targets", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerAnswerWithUnresolvedNeedsInputPrompts());
      handleMessage(
        SESSION_ID,
        needsInputNotificationUpdate([
          {
            id: "n-wrong-thread",
            messageId: UNRESOLVED_PROMPT_ONE_ID,
            summary: "Wrong owner",
            threadKey: "main",
          },
          { id: "n-missing", messageId: "missing-anchor", summary: "Missing source" },
          { id: "n-stale-herd", messageId: STALE_HERD_ANCHOR_ID, summary: "Stale herd source" },
        ]),
      );
    });
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen.getByText("Later clarification").closest<HTMLElement>("[data-turn-id]")!;

    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));

    expect(within(turn).getByText("The clarification is answered before the next decision.")).toBeVisible();
    expect(within(turn).queryByText(/Choose the deployment boundary/)).not.toBeInTheDocument();
    expect(within(turn).queryByText(/Confirm whether the follow-up should remain parked/)).not.toBeInTheDocument();
    expect(within(turn).queryByText(/Stale embedded prompt/)).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(`[data-message-id="${STALE_HERD_ANCHOR_ID}"]`)).toHaveLength(0);
    expect(within(turn).queryByTestId("thread-response-needs-input-prompt")).not.toBeInTheDocument();
    expect(within(turn).getAllByTestId("thread-response-answer-count")).toHaveLength(1);
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).getAllByRole("button", { name: /Show turn activity.*1 tool/ })).toHaveLength(1);
  });

  it("keeps a later clarification answer visible while an older request remains pending", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      handleMessage(SESSION_ID, producerLaterAnswerWhileOlderPending());
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(screen.getByText("Older implementation request")).toBeVisible();
    expect(screen.getByText("Later clarification")).toBeVisible();
    expect(screen.getByText("The clarification is fully answered while implementation continues.")).toBeVisible();
    const laterTurn = screen.getByText("Later clarification").closest<HTMLElement>("[data-turn-id]")!;
    fireEvent.click(within(laterTurn).getByRole("button", { name: /Hide turn activity/ }));
    expect(within(laterTurn).getByTestId("thread-response-current")).toBeVisible();
    expect(
      within(laterTurn).getByText("The clarification is fully answered while implementation continues."),
    ).toBeVisible();
    expect(useStore.getState().threadWindowResponseStates.get(SESSION_ID)?.get(QUEST_ID)).toMatchObject({
      ready: false,
      pendingMessages: [{ userMessageId: "u1" }],
    });
  });

  it("shows one asynchronous answer while its distinct source turn expands and collapses", () => {
    // Relocation is presentation-only: expanding the real source swaps hosts instead of duplicating DOM identity.
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerAsynchronousAnswerFromLaterTurn());
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const answerText = "The earlier request is complete after asynchronous work.";
    const anchorTurn = screen.getByText("Earlier asynchronous request").closest<HTMLElement>("[data-turn-id]")!;
    const sourceTurn = screen
      .getByText("Later request that triggered completion")
      .closest<HTMLElement>("[data-turn-id]")!;

    expect(screen.getAllByText(answerText)).toHaveLength(1);
    expect(within(sourceTurn).getByText(answerText)).toBeVisible();
    expect(within(sourceTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();

    expect(within(anchorTurn).getByRole("button", { name: /Show turn activity/ })).toBeVisible();
    expect(within(anchorTurn).queryByTestId("thread-response-current")).not.toBeInTheDocument();

    fireEvent.click(within(sourceTurn).getByRole("button", { name: /Hide turn activity/ }));
    expect(screen.getAllByText(answerText)).toHaveLength(1);
    expect(within(anchorTurn).getByTestId("thread-response-current")).toBeVisible();
    expect(within(anchorTurn).getByText(answerText)).toBeVisible();
    expect(within(sourceTurn).queryByText(answerText)).not.toBeInTheDocument();
    expect(within(sourceTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();

    fireEvent.click(within(sourceTurn).getByRole("button", { name: /Show turn activity/ }));
    expect(screen.getAllByText(answerText)).toHaveLength(1);
    expect(within(anchorTurn).queryByTestId("thread-response-current")).not.toBeInTheDocument();
    expect(within(sourceTurn).getByText(answerText)).toBeVisible();
    expect(within(sourceTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();

    fireEvent.click(within(sourceTurn).getByRole("button", { name: /Hide turn activity/ }));
    expect(screen.getAllByText(answerText)).toHaveLength(1);
    expect(within(anchorTurn).getByTestId("thread-response-current")).toBeVisible();
    expect(within(sourceTurn).getByRole("region", { name: "Quest quiz" })).toBeVisible();
  });

  it("keeps both explicit toggle states for an answer-only Ready turn", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      handleMessage(SESSION_ID, producerFinalResponseOnlyThreadWindow());
      installReadyStatus(1_700_000_004_000, "response-only-r1");
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const turn = screen.getByText("Only pending request").closest<HTMLElement>("[data-turn-id]")!;
    expect(within(turn).queryByRole("button", { name: /Leader activity/i })).not.toBeInTheDocument();
    const expand = within(turn).getByRole("button", { name: /Show turn activity/ });
    expect(within(turn).getAllByRole("button", { name: /Show turn activity/ })).toHaveLength(1);
    fireEvent.click(expand);

    expect(screen.getByText("Only current response")).toBeVisible();
    const collapse = within(turn).getByRole("button", { name: /Hide turn activity/ });
    expect(collapse).toBeVisible();
    fireEvent.click(collapse);
    expect(within(turn).getByRole("button", { name: /Show turn activity/ })).toBeVisible();
  });

  it("keeps one top summary for hidden tool activity in a Ready turn", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      handleMessage(SESSION_ID, producerFinalResponseWithToolThreadWindow());
      installReadyStatus(1_700_000_005_000, "response-only-r1");
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    const turn = screen.getByText("Only pending request").closest<HTMLElement>("[data-turn-id]")!;
    expect(within(turn).queryByText("Leader activity")).not.toBeInTheDocument();
    const expand = within(turn).getByRole("button", { name: /Show turn activity.*1 tool/ });
    expect(within(turn).getAllByRole("button", { name: /Show turn activity/ })).toHaveLength(1);
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);
    const toolDisclosure = within(turn).getByRole("button", { name: /Show 1 tool call: Ran command/ });
    fireEvent.click(toolDisclosure);
    expect(within(turn).getByText("quest show q-2024")).toBeVisible();
    expect(within(turn).getByRole("button", { name: /Hide turn activity/ })).toHaveAttribute("aria-expanded", "true");

    const topCollapse = within(turn).getByRole("button", { name: /Hide turn activity/ });
    topCollapse.focus();
    fireEvent.click(topCollapse);
    const restoredExpand = within(turn).getByRole("button", { name: /Show turn activity.*1 tool/ });
    expect(document.activeElement).toBe(restoredExpand);
  });

  it("fails closed immediately when a new live covered user message outruns the cached response state", () => {
    act(() => {
      handleMessage(SESSION_ID, userMessage("user-live", "A new request arrived", 1_700_000_011_000));
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(screen.getByText("A new request arrived")).toBeVisible();
    expect(screen.queryByTestId("thread-response-current")).not.toBeInTheDocument();
  });

  it("requires a Ready marker at least as fresh as the current response revision", () => {
    act(() => {
      useStore.getState().reset();
      handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
      useStore.getState().upsertQuestDetail(quest(), { etag: '"response-detail"' });
      handleMessage(SESSION_ID, producerThreadWindow());
      installReadyStatus(1_700_000_000_000);
    });
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(screen.getAllByTestId("thread-response-current")).toHaveLength(2);
    expect(screen.getByText("Earlier grouped response")).toBeVisible();
    expect(screen.getByText("Intermediate leader and tool activity")).toBeVisible();
    expect(screen.getByText("Current singleton response")).toBeVisible();
    expect(
      screen.getByText("Current singleton response").closest("[data-testid='thread-response-current-expanded']"),
    ).toBeInTheDocument();
  });

  it("keeps prior current-answer identity visible while newer coverage is pending", () => {
    act(() => handleMessage(SESSION_ID, producerThreadWindow(false)));
    render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);

    expect(useStore.getState().threadWindowResponseStates.get(SESSION_ID)?.get(QUEST_ID)?.ready).toBe(false);
    expect(screen.getAllByTestId("thread-response-current")).toHaveLength(2);
    expect(screen.getByText("Earlier grouped response")).toBeVisible();
    expect(screen.getByText("Current grouped response")).toBeVisible();
    expect(screen.getByText("Intermediate leader and tool activity")).toBeVisible();
    const secondTurn = screen.getByText("Second pending request").closest<HTMLElement>("[data-turn-id]")!;
    fireEvent.click(within(secondTurn).getByRole("button", { name: /Show turn activity/i }));
    expect(screen.getByText("Earlier grouped response")).toBeVisible();
    const current = screen.getByText("Current grouped response");
    const frame = current.closest<HTMLElement>("[data-testid='thread-response-current-expanded']")!;
    expect(frame).toBeInTheDocument();
    expect(within(frame).getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 2 messages");
  });
});
