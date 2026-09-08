// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { useStore } from "../store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, SessionState } from "../types.js";
import { createWsMessageHandler } from "../ws-handlers.js";
import { MessageFeed } from "./MessageFeed.js";

const sendToSession = vi.hoisted(() => vi.fn((_sessionId: string, _message: BrowserOutgoingMessage) => true));
vi.mock("../ws.js", () => ({ sendToSession }));
vi.mock("../api.js", () => ({
  api: {
    getQuestValidated: vi.fn().mockResolvedValue({ status: "not-modified", etag: '"bottom-window"' }),
    searchSessionMessages: vi.fn().mockResolvedValue({ results: [], hasMore: false, nextOffset: null }),
  },
}));
vi.mock("../utils/notification-sound.js", () => ({
  playNotificationSound: vi.fn(),
  playNeedsInputSound: vi.fn(),
  playReviewSound: vi.fn(),
}));

const SESSION_ID = "leader-bottom-window";
const THREAD_KEY = "q-4080";
const handleMessage = createWsMessageHandler({ disconnectSession: vi.fn(), sendToSession });

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

function producerWindow(fromItem: number): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const messageHistory: BrowserIncomingMessage[] = Array.from({ length: 6 }, (_, index) => ({
    type: "user_message",
    id: `request-${index + 1}`,
    content: `Request ${index + 1}`,
    timestamp: 1_700_000_000_000 + index,
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" }],
  }));
  const sync = buildThreadWindowSync({
    messageHistory,
    threadKey: THREAD_KEY,
    fromItem,
    itemCount: 4,
    sectionItemCount: 4,
    visibleItemCount: 1,
  });
  return { type: "thread_window_sync", thread_key: sync.threadKey, entries: sync.entries, window: sync.window };
}

function producerLongTurnWindow(fromItem: number): Extract<BrowserIncomingMessage, { type: "thread_window_sync" }> {
  const route = {
    threadKey: THREAD_KEY,
    questId: THREAD_KEY,
    threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" as const }],
  };
  const messageHistory: BrowserIncomingMessage[] = [
    { type: "user_message", id: "human-start", content: "Follow the work.", timestamp: 1, ...route },
  ];
  for (let index = 0; index < 100; index += 1) {
    messageHistory.push(
      {
        type: "user_message",
        id: `injected-${index}`,
        content: "A worker reported progress.",
        timestamp: index * 2 + 2,
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
        ...route,
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: index * 2 + 3,
        codexMessagePhase: "commentary",
        ...route,
        message: {
          id: `progress-${index}`,
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [{ type: "text", text: `Progress update ${index}.` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    );
  }
  const sync = buildThreadWindowSync({
    messageHistory,
    threadKey: THREAD_KEY,
    fromItem,
    itemCount: 10,
    sectionItemCount: 10,
    visibleItemCount: 1,
  });
  return { type: "thread_window_sync", thread_key: sync.threadKey, entries: sync.entries, window: sync.window };
}

function installViewportGeometry() {
  const descriptors = new Map(
    ["clientHeight", "scrollHeight", "scrollTop"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, key),
    ]),
  );
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTo = Element.prototype.scrollTo;
  const isFeed = (element: HTMLElement) => element.dataset.testid === "message-feed-scroll-container";
  const rows = () => [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
  const contentBottom = () => rows().length * 400;
  let scrollTop = 0;
  const clamp = (value: number) => Math.max(0, Math.min(value, contentBottom() + 12 - 400));

  Object.defineProperties(HTMLDivElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return isFeed(this) ? 400 : 0;
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return isFeed(this) ? contentBottom() + 12 : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        return isFeed(this) ? clamp(scrollTop) : 0;
      },
      set(value: number) {
        if (isFeed(this)) scrollTop = clamp(value);
      },
    },
  });
  Element.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (this instanceof HTMLDivElement && typeof options === "object") this.scrollTop = options.top ?? 0;
  };
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (isFeed(this)) return DOMRect.fromRect({ width: 600, height: 400 });
    const contained = rows().flatMap((row, index) => (row === this || this.contains(row) ? [index] : []));
    if (contained.length > 0) {
      const top = contained[0]! * 400 + 100;
      const bottom = (contained.at(-1)! + 1) * 400;
      return DOMRect.fromRect({ y: top - scrollTop, width: 600, height: bottom - top });
    }
    return originalRect.call(this);
  };

  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    Element.prototype.scrollTo = originalScrollTo;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLDivElement.prototype, key, descriptor);
      else delete (HTMLDivElement.prototype as unknown as Record<string, unknown>)[key];
    }
  };
}

beforeEach(() => {
  useStore.getState().reset();
  localStorage.clear();
  sendToSession.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  act(() => {
    handleMessage(SESSION_ID, { type: "session_init", session: leaderSession() });
    handleMessage(SESSION_ID, producerWindow(0));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MessageFeed bottom navigation across selected-window replacement", () => {
  it("reaches the newest window when both ranges belong to the same human turn", async () => {
    // Injected triggers count toward server window bounds without becoming new
    // human turns. Equal-sized replacement ranges must still honor Go to bottom.
    const older = producerLongTurnWindow(50);
    const latest = producerLongTurnWindow(91);
    expect(older.window.leading_turn_id).toBe("human-start");
    expect(latest.window.leading_turn_id).toBe("human-start");
    act(() => handleMessage(SESSION_ID, older));
    const restoreGeometry = installViewportGeometry();
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={THREAD_KEY} />);
    try {
      const feed = screen.getByTestId("message-feed-scroll-container");
      act(() => {
        feed.scrollTop = 500;
        fireEvent.scroll(feed);
      });
      sendToSession.mockClear();
      fireEvent.click(screen.getByLabelText("Go to bottom"));
      expect(sendToSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ type: "thread_window_request", thread_key: THREAD_KEY, from_item: 91 }),
      );

      await act(async () => handleMessage(SESSION_ID, latest));

      const lastMessage = document.querySelector<HTMLElement>('[data-message-id="progress-99"]')!;
      expect(lastMessage).not.toBeNull();
      expect(lastMessage.getBoundingClientRect().bottom).toBe(feed.clientHeight);
    } finally {
      view.unmount();
      restoreGeometry();
    }
  });

  it.each([
    { manual: false, outcome: "reaches the real bottom after requesting the newest window" },
    { manual: true, outcome: "preserves manual reading chosen after the bottom-arrow click" },
  ])("$outcome", async ({ manual }) => {
    // The old and newest producer windows overlap at Request 3. A preserved
    // reading anchor must not override Go to bottom, but a later manual scroll must.
    const restoreGeometry = installViewportGeometry();
    const view = render(<MessageFeed sessionId={SESSION_ID} threadKey={THREAD_KEY} />);
    try {
      const feed = screen.getByTestId("message-feed-scroll-container");
      const anchor = () => document.querySelector<HTMLElement>('[data-message-id="request-3"]')!;
      act(() => {
        feed.scrollTop = 900;
        fireEvent.scroll(feed);
      });
      expect(anchor().getBoundingClientRect().top).toBe(0);
      sendToSession.mockClear();
      fireEvent.click(screen.getByLabelText("Go to bottom"));
      expect(sendToSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ type: "thread_window_request", thread_key: THREAD_KEY, from_item: 2 }),
      );

      if (manual) {
        act(() => {
          fireEvent.wheel(feed, { deltaY: -100 });
          feed.scrollTop = 850;
          fireEvent.scroll(feed);
        });
      }
      const readingOffset = anchor().getBoundingClientRect().top;
      await act(async () => handleMessage(SESSION_ID, producerWindow(2)));

      expect(screen.getByText("Request 6")).toBeTruthy();
      if (manual) {
        expect(anchor().getBoundingClientRect().top).toBe(readingOffset);
        expect(feed.scrollTop).toBe(50);
      } else {
        const latest = document.querySelector<HTMLElement>('[data-message-id="request-6"]')!;
        expect(latest.getBoundingClientRect().bottom).toBe(feed.clientHeight);
        expect(feed.scrollTop).toBe(1200);
      }
    } finally {
      view.unmount();
      restoreGeometry();
    }
  });
});
