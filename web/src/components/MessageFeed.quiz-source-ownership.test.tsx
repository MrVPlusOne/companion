// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
} from "../../server/leader-thread-response.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import { useStore } from "../store.js";
import type { BrowserIncomingMessage, QuestmasterTask, SessionState } from "../types.js";
import { createWsMessageHandler } from "../ws-handlers.js";
import { MessageFeed } from "./MessageFeed.js";
import { ReadyThreadResponseRows } from "./ReadyThreadResponseRows.js";

const sendToSession = vi.hoisted(() => vi.fn(() => true));
vi.mock("../ws.js", () => ({ sendToSession }));
vi.mock("../api.js", () => ({
  api: { getQuestValidated: vi.fn().mockResolvedValue({ status: "not-modified", etag: '"quiz-source"' }) },
}));
vi.mock("../utils/notification-sound.js", () => ({
  playNotificationSound: vi.fn(),
  playNeedsInputSound: vi.fn(),
  playReviewSound: vi.fn(),
}));

const SESSION_ID = "leader-quiz-source";
const QUEST_ID = "q-4100";
const QUIZ_DIRECTIVE = `{[(Quest Quiz: ${QUEST_ID})]}`;
const SOURCE_ID = "quiz-source-first";
const PROMPT_TEXT = "Choose whether the follow-up should remain parked.";
const NOTIFICATION_SUMMARY = "A decision remains pending";
const handleMessage = createWsMessageHandler({ disconnectSession: vi.fn(), sendToSession });
const route = {
  threadKey: QUEST_ID,
  questId: QUEST_ID,
  threadRefs: [{ threadKey: QUEST_ID, questId: QUEST_ID, source: "explicit" as const }],
};
type Assistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

beforeEach(() => {
  useStore.getState().reset();
  sendToSession.mockClear();
});
afterEach(cleanup);

function leaderSession(): SessionState {
  return {
    session_id: SESSION_ID,
    isOrchestrator: true,
    backend_type: "codex",
    model: "gpt-5.5",
    cwd: "/tmp/takode",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
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

function quest(): QuestmasterTask {
  return {
    id: "quiz-source-quest",
    questId: QUEST_ID,
    version: 1,
    title: "Quiz source ownership",
    description: "Preserve the source of each Quiz occurrence.",
    status: "done",
    createdAt: 1,
    completedAt: 2,
    verificationItems: [],
    quizItems: [{ id: "source", question: "What owns this Quiz?", answer: "Its original assistant message." }],
  };
}

function assistant(id: string, texts: string[], historyIndex: number): Assistant {
  return {
    type: "assistant",
    timestamp: 1_700_000_000_000 + historyIndex,
    parent_tool_use_id: null,
    codexMessagePhase: "commentary",
    leaderThreadRole: "commentary",
    ...route,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: texts.map((text) => ({ type: "text", text })),
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function appendAnsweredRequest(history: BrowserIncomingMessage[], ordinal: number): void {
  history.push({
    type: "user_message",
    id: `request-${ordinal}`,
    content: `Review completed result ${ordinal}.`,
    timestamp: 1_700_000_000_000 + history.length,
    leaderUserMessageId: `u${ordinal}`,
    leaderResponseCoverageVersion: 1,
    ...route,
  });
  const answer = assistant(`answer-${ordinal}`, [`Completed result ${ordinal}.`], history.length);
  answer.codexMessagePhase = "final_answer";
  answer.leaderThreadRole = "answer";
  answer.leaderAnswerUserMessageIds = [`u${ordinal}`];
  answer.leaderAnswerObservedHistoryLength = history.length;
  history.push(answer);
  expect(finalizeRoutedLeaderResponseMessage({ id: SESSION_ID, messageHistory: history }, answer).finalized).toBe(true);
}

function notificationUpdate(done = false): Extract<BrowserIncomingMessage, { type: "notification_update" }> {
  return {
    type: "notification_update",
    notificationStatusVersion: done ? 2 : 1,
    notifications: [
      {
        id: "source-decision",
        category: "needs-input",
        messageId: SOURCE_ID,
        summary: NOTIFICATION_SUMMARY,
        timestamp: 1_700_000_000_010,
        done,
        threadKey: QUEST_ID,
        questId: QUEST_ID,
      },
    ],
  };
}

function installHistory(history: BrowserIncomingMessage[], contentBlocksOnly = false): void {
  // Finalize answers and use the shared producer to derive both the bounded
  // window and its exact response proof; the browser receives the normal wire shape.
  const projection = buildLeaderThreadResponseState({ id: SESSION_ID, messageHistory: history }, QUEST_ID).projection;
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey: QUEST_ID,
    fromItem: 0,
    itemCount: 10,
    sectionItemCount: 10,
    visibleItemCount: 3,
    currentThreadResponseProjection: projection,
  });
  expect(sync.threadResponseSupportComplete).toBe(true);
  act(() => {
    handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
    useStore.getState().upsertQuestDetail(quest(), { etag: '"quiz-source"' });
    handleMessage(SESSION_ID, {
      type: "thread_window_sync",
      thread_key: QUEST_ID,
      entries: sync.entries,
      window: sync.window,
      response_state: sync.threadResponseProjection,
    });
    handleMessage(SESSION_ID, notificationUpdate());
    if (contentBlocksOnly) {
      // The supported block-only display shape lacks the compatibility string,
      // while retaining the producer's original content blocks and message identity.
      const source = useStore
        .getState()
        .threadWindowMessages.get(SESSION_ID)
        ?.get(QUEST_ID)
        ?.find((m) => m.id === SOURCE_ID);
      if (!source) throw new Error("Missing Quiz source in the produced window");
      source.content = "";
    }
  });
}

function singleSourceHistory(): BrowserIncomingMessage[] {
  const history: BrowserIncomingMessage[] = [];
  appendAnsweredRequest(history, 1);
  history.push(assistant(SOURCE_ID, [PROMPT_TEXT, QUIZ_DIRECTIVE], history.length));
  // A worker quotation is retained as user-role audit content. It must not
  // become a second assistant Quiz occurrence in either presentation mode.
  history.push({
    type: "user_message",
    id: "worker-quote",
    content: `1 event from 1 session\n\n#12 | turn_end | complete\n${QUIZ_DIRECTIVE}`,
    timestamp: 1_700_000_000_003,
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    ...route,
  });
  return history;
}

describe("MessageFeed Quiz source ownership", () => {
  it.each([
    false,
    true,
  ])("renders one pinned-source Quiz through collapse toggles with contentBlocksOnly=%s", (contentBlocksOnly) => {
    const history = singleSourceHistory();
    const rawBefore = JSON.stringify(history);
    installHistory(history, contentBlocksOnly);
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen.getByText("Review completed result 1.").closest<HTMLElement>("[data-turn-id]")!;
    const assertOneSource = () => {
      expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
      expect(within(turn).getAllByText(NOTIFICATION_SUMMARY)).toHaveLength(1);
      expect(within(turn).getAllByText(PROMPT_TEXT)).toHaveLength(1);
      expect(view.container.querySelectorAll(`[data-message-id="${SOURCE_ID}"]`)).toHaveLength(1);
    };

    assertOneSource();
    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));
    assertOneSource();
    fireEvent.click(within(turn).getByRole("button", { name: /Show turn activity/ }));
    assertOneSource();
    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));
    assertOneSource();

    act(() => handleMessage(SESSION_ID, notificationUpdate(true)));
    expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(within(turn).queryByText(NOTIFICATION_SUMMARY)).not.toBeInTheDocument();
    expect(JSON.stringify(history)).toBe(rawBefore);
  });

  it("preserves distinct same-quest Quiz sources in expanded history", () => {
    // Occurrence identity is the source message, not the quest ID or identical
    // Quiz content. Fixing one duplicated occurrence must preserve a later real one.
    const history = singleSourceHistory();
    appendAnsweredRequest(history, 2);
    history.push(assistant("quiz-source-second", ["A later legitimate Quiz.", QUIZ_DIRECTIVE], history.length));
    const rawBefore = JSON.stringify(history);
    installHistory(history);
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    for (const ordinal of [1, 2]) {
      const turn = screen.getByText(`Review completed result ${ordinal}.`).closest<HTMLElement>("[data-turn-id]")!;
      const expand = within(turn).queryByRole("button", { name: /Show turn activity/ });
      if (expand) fireEvent.click(expand);
      expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    }
    expect(screen.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(2);
    expect(view.container.querySelectorAll(`[data-message-id="${SOURCE_ID}"]`)).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-message-id="quiz-source-second"]')).toHaveLength(1);
    expect(screen.getAllByText(NOTIFICATION_SUMMARY)).toHaveLength(1);
    expect(JSON.stringify(history)).toBe(rawBefore);
  });

  it.each([false, true])("keeps an ungrouped Quiz on its later pinned source with a mixed group=%s", (mixedGroup) => {
    // The existing grouping policy assigns this quest's separate row to the
    // earlier source. The later pinned source still owns its inline occurrence;
    // if it also owns another grouped Quiz, strip only that matching directive.
    const history: BrowserIncomingMessage[] = [];
    appendAnsweredRequest(history, 1);
    history.push(assistant("quiz-source-earlier", [QUIZ_DIRECTIVE], history.length));
    appendAnsweredRequest(history, 2);
    history.push(
      assistant(
        SOURCE_ID,
        [PROMPT_TEXT, QUIZ_DIRECTIVE, ...(mixedGroup ? ["{[(Quest Quiz: q-4101)]}"] : [])],
        history.length,
      ),
    );
    const rawBefore = JSON.stringify(history);
    installHistory(history);
    act(() => {
      if (mixedGroup) useStore.getState().upsertQuestDetail({ ...quest(), id: "second-quiz-quest", questId: "q-4101" });
    });
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={QUEST_ID} />);
    const turn = screen.getByText("Review completed result 2.").closest<HTMLElement>("[data-turn-id]")!;
    const assertRetainedSources = () => {
      expect(within(turn).getAllByRole("region", { name: "Quest quiz" })).toHaveLength(mixedGroup ? 2 : 1);
      expect(within(turn).getAllByText(PROMPT_TEXT)).toHaveLength(1);
      expect(within(turn).getAllByText(NOTIFICATION_SUMMARY)).toHaveLength(1);
      expect(view.container.querySelectorAll(`[data-message-id="${SOURCE_ID}"]`)).toHaveLength(1);
    };
    assertRetainedSources();
    fireEvent.click(within(turn).getByRole("button", { name: /Hide turn activity/ }));
    assertRetainedSources();
    fireEvent.click(within(turn).getByRole("button", { name: /Show turn activity/ }));
    assertRetainedSources();
    expect(JSON.stringify(history)).toBe(rawBefore);
  });

  it.each([undefined, 9])("keeps a retained legacy or pre-cutover prompt unchanged at index %s", (historyIndex) => {
    // A retained source cannot borrow a same-quest group produced after cutover.
    // Missing legacy indices are also insufficient evidence to remove its directive.
    installHistory(singleSourceHistory());
    const source = useStore
      .getState()
      .threadWindowMessages.get(SESSION_ID)
      ?.get(QUEST_ID)
      ?.find((m) => m.id === SOURCE_ID);
    if (!source) throw new Error("Missing Quiz source in the produced window");
    const entry: Extract<FeedEntry, { kind: "message" }> = { kind: "message", msg: { ...source, historyIndex } };
    const turn: Turn = {
      id: "retained-source-turn",
      userEntry: null,
      allEntries: [entry],
      presentationEntries: [entry],
      agentEntries: [entry],
      systemEntries: [],
      notificationEntries: [],
      responseEntry: null,
      subConclusions: [],
      collapsedEntries: [],
      stats: { messageCount: 1, toolCount: 0, subagentCount: 0, herdEventCount: 0 },
    };
    const renderEntry = vi.fn((item: FeedEntry) => <div>{item.kind === "message" ? item.msg.content : null}</div>);
    render(
      <ReadyThreadResponseRows
        turn={turn}
        presentation={{
          ready: false,
          cutoverHistoryIndex: 10,
          pendingMessageCount: 1,
          currentResponses: [],
          currentResponseMessageIds: new Set(),
          quizGroups: [{ hostTurnId: turn.id, questIds: [QUEST_ID] }],
          layoutSignature: "retained-legacy-source",
        }}
        sessionId={SESSION_ID}
        questLinkSurface="chat-feed"
        activeNeedsInputAnchorMessageIds={new Set([SOURCE_ID])}
        renderEntry={renderEntry}
      />,
    );
    expect(renderEntry).toHaveBeenCalledExactlyOnceWith(entry);
    expect(renderEntry.mock.calls[0]![0]).toBe(entry);
    expect(entry.msg.content).toContain(QUIZ_DIRECTIVE);
  });
});
