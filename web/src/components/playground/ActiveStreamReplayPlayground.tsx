import { useEffect } from "react";
import { useStore } from "../../store.js";
import type { BrowserIncomingMessage, SessionState } from "../../types.js";
import { createWsMessageHandler } from "../../ws-handlers.js";
import { MessageBubble } from "../MessageBubble.js";
import { FeedFooter } from "../MessageFeedEntries.js";

const SESSION_ID = "playground-active-stream-replay";
const TIMESTAMP = Date.UTC(2026, 8, 8, 12);
const CURRENT_MESSAGE_ID = "playground-stream-current-completed";
const ACTIVE_TEXT = "The follow-up check is underway.\n\n";
const EQUAL_TEXT = "The check completed successfully.\n\n";
const receive = createWsMessageHandler({ sendToSession: () => false, disconnectSession: () => {} });
const SESSION: SessionState = {
  session_id: SESSION_ID,
  backend_type: "codex",
  model: "codex",
  cwd: "/tmp/playground",
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
  repo_root: "/tmp/playground",
  git_ahead: 0,
  git_behind: 0,
  total_lines_added: 0,
  total_lines_removed: 0,
};

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

function restore(equalText: boolean): void {
  // Maintained sanitized post-reconnect payload: server-backed integration tests
  // own replay selection; the Playground exercises its normal browser output.
  receive(SESSION_ID, {
    type: "history_window_sync",
    messages: [
      assistant("playground-stream-first-completed", equalText ? EQUAL_TEXT : "The first check is pending.\n\n"),
      assistant("playground-stream-second-completed", equalText ? EQUAL_TEXT : "The first check is complete.\n\n"),
    ],
    window: {
      from_turn: 0,
      turn_count: 0,
      total_turns: 0,
      has_older_items: false,
      has_newer_items: false,
      start_index: 0,
      section_turn_count: 10,
      visible_section_count: 3,
    },
  });
  receive(SESSION_ID, {
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: { ...assistant("playground-stream-current-live", "").message, content: [], stop_reason: null },
    },
  });
  receive(SESSION_ID, {
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: equalText ? EQUAL_TEXT : ACTIVE_TEXT },
    },
  });
  receive(SESSION_ID, {
    type: "state_snapshot",
    sessionStatus: "running",
    backendConnected: true,
    permissionMode: SESSION.permissionMode,
    uiMode: null,
    askPermission: false,
  });
}

/** Show completed history and the independently active text after reconnect. */
export function ActiveStreamReplayPlayground() {
  const messages = useStore((state) => state.messages.get(SESSION_ID));
  const streaming = useStore((state) => state.streaming.get(SESSION_ID));

  useEffect(() => {
    useStore.getState().addSession(SESSION);
    restore(false);
    return () => useStore.getState().removeSession(SESSION_ID);
  }, []);

  return (
    <div className="space-y-4" data-testid="playground-active-stream-replay">
      <p className="text-xs text-cc-muted">
        Completed messages remain visible after reconnect. Only the unfinished message keeps the typing cursor.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md border border-cc-border px-3 py-2 text-xs hover:bg-cc-hover"
          onClick={() => restore(false)}
        >
          Restore running snapshot
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-cc-border px-3 py-2 text-xs hover:bg-cc-hover disabled:opacity-50"
          disabled={!streaming}
          onClick={() => {
            if (streaming) receive(SESSION_ID, assistant(CURRENT_MESSAGE_ID, streaming));
          }}
        >
          Complete current message
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-cc-border px-3 py-2 text-xs hover:bg-cc-hover"
          onClick={() => restore(true)}
        >
          Show distinct equal-text messages
        </button>
      </div>
      <div className="space-y-4 rounded-lg border border-cc-border bg-cc-bg p-4">
        {messages?.map((message) => (
          <MessageBubble key={message.id} message={message} sessionId={SESSION_ID} />
        ))}
        <FeedFooter sessionId={SESSION_ID} />
      </div>
      <p className="text-xs text-cc-muted">Local example only. These controls do not send input to a real session.</p>
    </div>
  );
}
