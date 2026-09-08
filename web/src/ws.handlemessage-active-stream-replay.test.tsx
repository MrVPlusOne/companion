// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prepareBoundedConversationSubscribe } from "../server/bridge/browser-conversation-window-policy.js";
import { sendHistoryWindowSync } from "../server/bridge/browser-transport-controller.js";
import { isHistoryBackedEvent } from "../server/bridge/replay-buffer-policy.js";
import type { BufferedBrowserEvent } from "../server/session-types.js";
import { FeedFooter } from "./components/MessageFeedEntries.js";
import { ActiveStreamReplayPlayground } from "./components/playground/ActiveStreamReplayPlayground.js";
import { useStore } from "./store.js";
import type { BrowserIncomingMessage, SessionState } from "./types.js";
import { createWsMessageHandler } from "./ws-handlers.js";
import { createWsTransport, type WsTransport } from "./ws-transport.js";

vi.mock("./api.js", () => ({
  api: {
    getDiffStats: vi.fn().mockResolvedValue({ stats: {} }),
    listSessions: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("./utils/notification-sound.js", () => ({ playNotificationSound: vi.fn() }));
vi.mock("./components/MarkdownContent.js", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

const SESSION_ID = "active-stream-replay";
const TIMESTAMP = Date.UTC(2026, 8, 8, 12);
const FIRST_TEXT = "The earlier check is still pending.\n\n";
const SECOND_TEXT = "The check is now complete.\n\n";
let transport: WsTransport;
let socket: MockWebSocket;

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    socket = this;
  }
}

function session(): SessionState {
  return {
    session_id: SESSION_ID,
    backend_type: "codex",
    model: "codex",
    cwd: "/tmp/stream-replay-fixture",
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
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/tmp/stream-replay-fixture",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function receive(message: unknown): void {
  socket.onmessage!({ data: JSON.stringify(message) });
}

function assistant(id: string, text: string): Extract<BrowserIncomingMessage, { type: "assistant" }> {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp: TIMESTAMP,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "codex",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function stream(id: string, text: string): BrowserIncomingMessage[] {
  // Codex item starts carry identity; text deltas inherit their stream scope.
  return [
    {
      type: "stream_event",
      event: { type: "message_start", message: { ...assistant(id, "").message, content: [], stop_reason: null } },
      parent_tool_use_id: null,
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null,
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    },
  ];
}

function subscribeToRunningHistory(history: BrowserIncomingMessage[], events: BrowserIncomingMessage[]): void {
  const eventBuffer = events.map((message, index) => ({ seq: index + 1, message })) as BufferedBrowserEvent[];
  const prepared = prepareBoundedConversationSubscribe({
    session: { messageHistory: history, eventBuffer, nextEventSeq: eventBuffer.length + 1 },
    socketData: {},
    initialThreadWindow: null,
    historyWindowSectionTurnCount: 10,
    historyWindowVisibleSectionCount: 3,
    historyWindowTargetMessageId: undefined,
    historyWindowTargetIndex: undefined,
    lastAckSeq: 0,
    running: true,
    isHistoryBackedEvent,
  });
  if (prepared.boundedView?.kind !== "history") throw new Error("Expected producer history window");
  sendHistoryWindowSync(
    { messageHistory: history },
    { send: (json) => receive(JSON.parse(json)) },
    prepared.boundedView.request,
  );
  receive({ type: "event_replay", events: prepared.replayEvents });
  receive({ type: "conversation_sync_complete", through_seq: prepared.syncThroughSeq });
  receive({
    type: "state_snapshot",
    sessionStatus: "running",
    backendConnected: true,
    permissionMode: "default",
    uiMode: null,
    askPermission: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockWebSocket);
  localStorage.clear();
  useStore.getState().reset();
  const handler = createWsMessageHandler({ disconnectSession: vi.fn(), sendToSession: vi.fn(() => true) });
  transport = createWsTransport({
    hasLocalMessages: () => false,
    getKnownFrozenCount: () => 0,
    getKnownFrozenHash: () => undefined,
    getFreshHistoryWindow: () => ({ sectionTurnCount: 10, visibleSectionCount: 3 }),
    onMessage: handler,
  });
  transport.connectSession(SESSION_ID);
  socket.onopen!(new Event("open"));
  receive({ type: "session_init", session: session() });
});

afterEach(() => {
  cleanup();
  transport.disconnectAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("active text replay after an authoritative conversation window", () => {
  it.each([
    "saved-completion",
    "rekeyed-stream",
  ])("retires a streamed replay with a deduplicated completion (%s)", (streamId) => {
    // The bridge may suppress the completed history replay. Its independent
    // stop signal must still clear text without adding a duplicate history row.
    receive(assistant("saved-completion", FIRST_TEXT));
    for (const message of stream(streamId, FIRST_TEXT)) receive(message);
    receive({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Transient reasoning" } },
    });
    useStore.getState().setStreamingStats(SESSION_ID, { startedAt: 12, outputTokens: 34 });
    receive({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });

    const state = useStore.getState();
    expect(state.messages.get(SESSION_ID)?.map((message) => message.id)).toEqual(["saved-completion"]);
    expect(state.streaming.get(SESSION_ID)).toBeUndefined();
    expect(state.streamingThinking.get(SESSION_ID)).toBeUndefined();
    expect(state.streamingStartedAt.get(SESSION_ID)).toBe(12);
    expect(state.streamingOutputTokens.get(SESSION_ID)).toBe(34);
    expect(state.sessionStatus.get(SESSION_ID)).toBe("running");

    // An independently generated same-text message is still an ordinary new
    // message; neither live nor history identity is inferred from the prose.
    for (const message of stream("new-same-text-stream", FIRST_TEXT)) receive(message);
    expect(useStore.getState().streaming.get(SESSION_ID)).toBe(FIRST_TEXT);
    receive({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
    receive(assistant("new-same-text-completion", FIRST_TEXT));
    expect(
      useStore
        .getState()
        .messages.get(SESSION_ID)
        ?.map((message) => message.id),
    ).toEqual(["saved-completion", "new-same-text-completion"]);
    expect(useStore.getState().streaming.get(SESSION_ID)).toBeUndefined();
  });

  it("clears only the matching nested stream without changing root or sibling output", () => {
    // Parented streams have independent buffers even while sharing one browser
    // session. A nested completion must not retire the root or another parent.
    for (const parentToolUseId of [null, "nested-first", "nested-second"]) {
      for (const message of stream(`stream-${parentToolUseId ?? "root"}`, FIRST_TEXT)) {
        receive({ ...message, parent_tool_use_id: parentToolUseId });
      }
      receive({
        type: "stream_event",
        parent_tool_use_id: parentToolUseId,
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Thinking" } },
      });
    }
    receive({ type: "stream_event", parent_tool_use_id: "nested-first", event: { type: "message_stop" } });

    const state = useStore.getState();
    expect(state.streaming.get(SESSION_ID)).toBe(FIRST_TEXT);
    expect(state.streamingThinking.get(SESSION_ID)).toBe("Thinking");
    expect(state.streamingByParentToolUseId.get(SESSION_ID)?.get("nested-first")).toBeUndefined();
    expect(state.streamingThinkingByParentToolUseId.get(SESSION_ID)?.get("nested-first")).toBeUndefined();
    expect(state.streamingByParentToolUseId.get(SESSION_ID)?.get("nested-second")).toBe(FIRST_TEXT);
    expect(state.streamingThinkingByParentToolUseId.get(SESSION_ID)?.get("nested-second")).toBe("Thinking");

    receive({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
    expect(useStore.getState().streamingByParentToolUseId.get(SESSION_ID)?.get("nested-second")).toBe(FIRST_TEXT);
  });

  it("keeps native child completion out of the root live state", () => {
    // Native-child audit events never acquire root stream ownership, even when
    // their transport parent is null.
    for (const message of stream("root-active", FIRST_TEXT)) receive(message);
    receive({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Root reasoning" } },
    });
    const before = useStore.getState();
    receive({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_stop" },
      codexSubagent: { childId: "child-audit", rootTurnId: "root-turn" },
    });

    const after = useStore.getState();
    expect(after.streaming.get(SESSION_ID)).toBe(FIRST_TEXT);
    expect(after.streamingThinking.get(SESSION_ID)).toBe("Root reasoning");
    expect(after.streamingStartedAt.get(SESSION_ID)).toBe(before.streamingStartedAt.get(SESSION_ID));
    expect(after.sessionStatus.get(SESSION_ID)).toBe(before.sessionStatus.get(SESSION_ID));
  });

  it("clears live text on completion even when the completion ID differs from the streaming ID", () => {
    // This live control separates changed provider IDs from the reconnect bug:
    // both completion events reach the browser, so neither leaves stale text.
    for (const message of [
      ...stream("live-stream-first", FIRST_TEXT),
      assistant("live-completed-first", FIRST_TEXT),
      ...stream("live-stream-second", SECOND_TEXT),
      assistant("live-completed-second", SECOND_TEXT),
    ]) {
      receive(message);
    }

    expect(
      useStore
        .getState()
        .messages.get(SESSION_ID)
        ?.map((message) => message.id),
    ).toEqual(["live-completed-first", "live-completed-second"]);
    expect(useStore.getState().streaming.get(SESSION_ID)).toBeUndefined();
    const { container } = render(<FeedFooter sessionId={SESSION_ID} />);
    expect(container.querySelector("[data-feed-streaming-message]")).toBeNull();
  });

  it("does not reconstruct completed paragraphs as a second live footer", () => {
    // Real subscribe filtering formerly removed assistant clear events while
    // keeping both completed streams, concatenating them below correct history.
    const first = assistant("completed-first", FIRST_TEXT);
    const second = assistant("completed-second", SECOND_TEXT);
    subscribeToRunningHistory(
      [first, second],
      [...stream("stream-first", FIRST_TEXT), first, ...stream("stream-second", SECOND_TEXT), second],
    );

    expect(
      useStore
        .getState()
        .messages.get(SESSION_ID)
        ?.map(({ id, content }) => ({ id, content })),
    ).toEqual([
      { id: first.message.id, content: FIRST_TEXT },
      { id: second.message.id, content: SECOND_TEXT },
    ]);
    expect(useStore.getState().streaming.get(SESSION_ID)).toBeUndefined();
    const { container } = render(<FeedFooter sessionId={SESSION_ID} />);
    expect(container.querySelector("[data-feed-streaming-message]")).toBeNull();
  });

  it("restores only genuine unfinished output and retires it when its completion arrives", () => {
    // Completed and streaming item IDs may differ. Lifecycle boundaries still
    // retire completed text, while a new incomplete stream remains visible.
    const first = assistant("completed-first", FIRST_TEXT);
    const second = assistant("completed-second", SECOND_TEXT);
    const activeText = "A follow-up check is underway.\n\n";
    subscribeToRunningHistory(
      [first, second],
      [
        ...stream("stream-first", FIRST_TEXT),
        first,
        ...stream("stream-second", SECOND_TEXT),
        second,
        ...stream("stream-current", activeText),
      ],
    );

    expect(useStore.getState().streaming.get(SESSION_ID)).toBe(activeText);
    const { container } = render(<FeedFooter sessionId={SESSION_ID} />);
    expect(container.querySelector("[data-feed-streaming-message]")?.textContent).toBe(activeText);
    act(() => receive(assistant("completed-current", activeText)));
    expect(container.querySelector("[data-feed-streaming-message]")).toBeNull();
    expect(
      useStore
        .getState()
        .messages.get(SESSION_ID)
        ?.map((message) => message.id),
    ).toEqual([first.message.id, second.message.id, "completed-current"]);
  });

  it("preserves distinct same-text history messages and an independently active same-text stream", () => {
    // Content equality is not ownership: all three messages intentionally share
    // prose, and only the two completed lifecycles are excluded from replay.
    const first = assistant("completed-repeat-first", SECOND_TEXT);
    const second = assistant("completed-repeat-second", SECOND_TEXT);
    subscribeToRunningHistory(
      [first, second],
      [
        ...stream("stream-repeat-first", SECOND_TEXT),
        first,
        ...stream("stream-repeat-second", SECOND_TEXT),
        second,
        ...stream("stream-repeat-current", SECOND_TEXT),
      ],
    );

    const messages = useStore.getState().messages.get(SESSION_ID) ?? [];
    expect(messages.map((message) => message.id)).toEqual([first.message.id, second.message.id]);
    expect(messages.map((message) => message.content)).toEqual([SECOND_TEXT, SECOND_TEXT]);
    expect(useStore.getState().streaming.get(SESSION_ID)).toBe(SECOND_TEXT);
    const { container } = render(<FeedFooter sessionId={SESSION_ID} />);
    expect(container.querySelector("[data-feed-streaming-message]")?.textContent).toBe(SECOND_TEXT);
  });

  it("lets the local Playground complete its active row without deleting equal-text history", () => {
    // The local visual fixture consumes the normalized replay output without a
    // live backend and uses the same completion handler as connected browsers.
    const { container, getByRole, getAllByText, queryAllByText } = render(<ActiveStreamReplayPlayground />);
    expect(getAllByText("The first check is pending.")).toHaveLength(1);
    expect(getAllByText("The first check is complete.")).toHaveLength(1);
    expect(container.querySelector("[data-feed-streaming-message]")?.textContent).toBe(
      "The follow-up check is underway.\n\n",
    );

    fireEvent.click(getByRole("button", { name: "Complete current message" }));
    expect(container.querySelector("[data-feed-streaming-message]")).toBeNull();
    expect(getAllByText("The follow-up check is underway.")).toHaveLength(1);

    fireEvent.click(getByRole("button", { name: "Show distinct equal-text messages" }));
    expect(getAllByText("The check completed successfully.")).toHaveLength(3);
    fireEvent.click(getByRole("button", { name: "Complete current message" }));
    expect(container.querySelector("[data-feed-streaming-message]")).toBeNull();
    expect(getAllByText("The check completed successfully.")).toHaveLength(3);

    fireEvent.click(getByRole("button", { name: "Restore running snapshot" }));
    expect(queryAllByText("The check completed successfully.")).toHaveLength(0);
    expect(getAllByText("The first check is pending.")).toHaveLength(1);
    expect(getAllByText("The first check is complete.")).toHaveLength(1);
    expect(container.querySelector("[data-feed-streaming-message]")?.textContent).toBe(
      "The follow-up check is underway.\n\n",
    );
  });
});
