import { useEffect, useRef, useState } from "react";
import { buildThreadWindowSync } from "../../../shared/thread-window.js";
import { api } from "../../api.js";
import { useStore } from "../../store.js";
import type { BrowserIncomingMessage, SessionState } from "../../types.js";
import { createWsMessageHandler } from "../../ws-handlers.js";
import { MessageFeed } from "../MessageFeed.js";
import { Section } from "./shared.js";

const SESSION_ID = "playground-turn-window-stability";
const THREAD_KEY = "q-1";
const HUMAN_ID = "playground-window-human";
const PROMPT = "Follow this long turn while several workers report progress.";
const TIMESTAMP = Date.UTC(2026, 8, 1, 12);
const ROUTE = {
  threadKey: THREAD_KEY,
  questId: THREAD_KEY,
  threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" as const }],
};
const HISTORY: BrowserIncomingMessage[] = [
  { type: "user_message", id: HUMAN_ID, content: PROMPT, timestamp: TIMESTAMP, ...ROUTE },
  ...Array.from({ length: 12 }, (_, index): BrowserIncomingMessage[] => [
    {
      type: "user_message",
      id: `playground-window-event-${index}`,
      content: `Worker progress ${index + 1}`,
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      timestamp: TIMESTAMP + index * 2 + 1,
      ...ROUTE,
    },
    {
      type: "assistant",
      timestamp: TIMESTAMP + index * 2 + 2,
      parent_tool_use_id: null,
      ...ROUTE,
      message: {
        id: `playground-window-update-${index}`,
        type: "message",
        role: "assistant",
        model: "codex",
        content: [
          { type: "text", text: `Audit update ${index + 1}: the worker's result is recorded in this same turn.` },
          {
            type: "tool_use",
            id: `playground-window-tool-${index}`,
            name: "Bash",
            input: { command: "inspect progress" },
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  ]).flat(),
];
const WINDOWS = [
  { label: "Latest window", fromItem: -1, itemCount: 5 },
  { label: "Older window", fromItem: 4, itemCount: 9 },
  { label: "Newer window", fromItem: 6, itemCount: 7 },
  { label: "Complete turn", fromItem: 0, itemCount: 13 },
];
const receive = createWsMessageHandler({ sendToSession: () => false, disconnectSession: () => {} });
const SESSION: SessionState = {
  session_id: SESSION_ID,
  backend_type: "codex",
  isOrchestrator: true,
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

function loadWindow(bounds: { fromItem: number; itemCount: number }, messageHistory: BrowserIncomingMessage[]) {
  const selected = buildThreadWindowSync({
    messageHistory,
    threadKey: THREAD_KEY,
    sectionItemCount: 2,
    visibleItemCount: 3,
    ...bounds,
  });
  receive(SESSION_ID, {
    type: "thread_window_sync",
    thread_key: THREAD_KEY,
    entries: selected.entries,
    window: selected.window,
  });
}

export function PlaygroundTurnWindowStabilitySection() {
  const history = useRef([...HISTORY]);
  const [ready, setReady] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const [pendingRefresh, setPendingRefresh] = useState(false);

  const sendAtLatest = () => {
    loadWindow(WINDOWS[0]!, history.current);
    setSelectedIndex(0);
    const historyIndex = history.current.length;
    const sequence = historyIndex - HISTORY.length + 1;
    const message: BrowserIncomingMessage = {
      type: "user_message",
      id: `playground-window-follow-up-${sequence}`,
      content: `Local follow-up ${sequence}: keep this message at the bottom.`,
      timestamp: TIMESTAMP + historyIndex,
      history_index: historyIndex,
      ...ROUTE,
    };
    history.current.push(message);
    useStore.getState().requestBottomAlignOnNextUserMessage(SESSION_ID);
    receive(SESSION_ID, message);
    setPendingRefresh(true);
  };

  const refreshLatest = () => {
    const window = useStore.getState().threadWindows.get(SESSION_ID)!.get(THREAD_KEY)!;
    // Simulate the latest-view announcement locally: retain requested capacity
    // and resolve -1 against the new history rather than pinning the old slice.
    loadWindow(
      { fromItem: -1, itemCount: Math.max(window.item_count, window.section_item_count * window.visible_item_count) },
      history.current,
    );
    setSelectedIndex(0);
    setPendingRefresh(false);
  };

  useEffect(() => {
    // This local fixture has no backend session or socket. Scope the existing
    // search provider so mounting its real feed cannot query a live session.
    const originalSearch = api.searchSessionMessages;
    const search: typeof originalSearch = async (sessionId, options) => {
      if (sessionId !== SESSION_ID) return originalSearch(sessionId, options);
      return {
        sessionId,
        sessionNum: null,
        query: options?.query ?? "",
        scope: { kind: "current_thread", threadKey: THREAD_KEY, label: "Window fixture" },
        filters: { user: true, assistant: true, event: false },
        totalMatches: 1,
        results: [
          {
            id: HUMAN_ID,
            sessionId,
            sessionNum: null,
            messageId: HUMAN_ID,
            historyIndex: 0,
            role: "user",
            category: "user",
            timestamp: TIMESTAMP,
            snippet: PROMPT,
            fullText: PROMPT,
            routeThreadKey: THREAD_KEY,
            starred: false,
          },
        ],
        nextOffset: null,
        hasMore: false,
        tookMs: 0,
      };
    };
    api.searchSessionMessages = search;
    useStore.getState().addSession(SESSION);
    loadWindow(WINDOWS[0]!, history.current);
    setReady(true);
    return () => {
      if (api.searchSessionMessages === search) api.searchSessionMessages = originalSearch;
      useStore.getState().removeSession(SESSION_ID);
    };
  }, []);

  return (
    <Section
      title="Turn Collapse Across Windows"
      description="At each local scale, read an update and load older or newer windows: your place and manual collapse choice should survive. Send a local follow-up, then refresh the latest window; the new message should remain at the bottom."
    >
      <div className="max-w-3xl space-y-3" data-testid="playground-turn-window-stability">
        <div className="flex flex-wrap gap-2">
          {WINDOWS.map((window, index) => (
            <button
              key={window.label}
              type="button"
              aria-pressed={selectedIndex === index}
              onClick={() => {
                loadWindow(window, history.current);
                setSelectedIndex(index);
                setPendingRefresh(false);
              }}
              className="min-h-11 rounded-md border border-cc-border bg-cc-card px-3 py-2 text-xs text-cc-fg hover:bg-cc-hover aria-pressed:bg-cc-active"
            >
              {window.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Local feed scale">
          <span className="text-xs text-cc-muted">Local scale</span>
          {[0.9, 1, 1.25].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scale === value}
              onClick={() => setScale(value)}
              className="min-h-11 rounded-md border border-cc-border bg-cc-card px-3 py-2 text-xs text-cc-fg hover:bg-cc-hover aria-pressed:bg-cc-active"
            >
              {value * 100}%
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={sendAtLatest}
            disabled={pendingRefresh}
            className="min-h-11 rounded-md border border-cc-border bg-cc-card px-3 py-2 text-xs text-cc-fg hover:bg-cc-hover disabled:opacity-50"
          >
            Send at latest
          </button>
          <button
            type="button"
            onClick={refreshLatest}
            disabled={!pendingRefresh}
            className="min-h-11 rounded-md border border-cc-border bg-cc-card px-3 py-2 text-xs text-cc-fg hover:bg-cc-hover disabled:opacity-50"
          >
            Refresh latest window
          </button>
        </div>
        <p className="text-xs text-cc-muted">
          {pendingRefresh
            ? "Local send received. Refresh the latest window to check that the message stays visible."
            : "Local simulation only. Use the fixture buttons to load slices; feed arrows have no connected backend here."}
        </p>
        <div className="h-[420px] overflow-hidden rounded-xl border border-cc-border bg-cc-bg">
          <div
            data-testid="playground-turn-window-scaled-feed"
            className="flex min-h-0 flex-col"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              width: `${100 / scale}%`,
              height: `${100 / scale}%`,
            }}
          >
            {ready && <MessageFeed sessionId={SESSION_ID} threadKey={THREAD_KEY} showCodexSubagentControl={false} />}
          </div>
        </div>
      </div>
    </Section>
  );
}
