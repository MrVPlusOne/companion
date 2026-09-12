// @vitest-environment jsdom

const mockScrollTo = vi.fn();
const mockSendToSession = vi.hoisted(() => vi.fn(() => true));

beforeAll(() => {
  Element.prototype.scrollTo = mockScrollTo;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)" ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatMessage, ThreadWindowState } from "../types.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("../ws.js", () => ({
  sendToSession: mockSendToSession,
}));

const mockStoreValues: Record<string, unknown> = {};
const mockSetCollapsibleTurnIds = vi.fn();
const mockSetActiveTaskTurnId = vi.fn();

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      composerDrafts: mockStoreValues.composerDrafts ?? new Map(),
      messageFrozenCounts: new Map(),
      messageFrozenRevisions: new Map(),
      historyLoading: mockStoreValues.historyLoading ?? new Map(),
      historyWindows: mockStoreValues.historyWindows ?? new Map(),
      streaming: new Map(),
      streamingByParentToolUseId: new Map(),
      streamingThinking: new Map(),
      streamingThinkingByParentToolUseId: new Map(),
      streamingStartedAt: new Map(),
      streamingOutputTokens: new Map(),
      streamingPausedDuration: new Map(),
      streamingPauseStartedAt: new Map(),
      sessionStatus: new Map(),
      sessionStuck: new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
      toolProgress: new Map(),
      toolResults: new Map(),
      toolStartTimestamps: new Map(),
      sdkSessions: mockStoreValues.sdkSessions ?? [],
      feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
      turnActivityOverrides: new Map(),
      autoExpandedTurnIds: new Map(),
      toggleTurnActivity: vi.fn(),
      scrollToTurnId: new Map(),
      clearScrollToTurn: vi.fn(),
      scrollToMessageId: mockStoreValues.scrollToMessageId ?? new Map(),
      pendingScrollToMessageId: mockStoreValues.pendingScrollToMessageId ?? new Map(),
      clearScrollToMessage: vi.fn(),
      clearPendingScrollToMessageId: vi.fn(),
      expandAllInTurn: new Map(),
      clearExpandAllInTurn: vi.fn(),
      bottomAlignNextUserMessage: new Set(),
      sessionTaskHistory: new Map(),
      pendingUserUploads: new Map(),
      pendingCodexInputs: new Map(),
      activeTaskTurnId: new Map(),
      setActiveTaskTurnId: mockSetActiveTaskTurnId,
      backgroundAgentNotifs: new Map(),
      sessionNotifications: new Map(),
      sessionSearch: new Map(),
      threadWindows: mockStoreValues.threadWindows ?? new Map(),
      threadWindowMessages: mockStoreValues.threadWindowMessages ?? new Map(),
      threadWindowRefreshRevisions: mockStoreValues.threadWindowRefreshRevisions ?? new Map(),
      threadWindowAppliedRevisions: mockStoreValues.threadWindowAppliedRevisions ?? new Map(),
    };
    return selector(state);
  };
  useStore.getState = () => ({
    feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
    setFeedScrollPosition: vi.fn(),
    collapseAllTurnActivity: vi.fn(),
    setCollapsibleTurnIds: mockSetCollapsibleTurnIds,
    turnActivityOverrides: new Map(),
    autoExpandedTurnIds: new Map(),
    toggleTurnActivity: vi.fn(),
    focusTurn: vi.fn(),
    keepTurnExpanded: vi.fn(),
    clearBottomAlignOnNextUserMessage: vi.fn(),
    clearScrollToMessage: vi.fn(),
    clearPendingScrollToMessageId: vi.fn(),
    clearPendingScrollToMessageIndex: vi.fn(),
    clearExpandAllInTurn: vi.fn(),
    setComposerDraft: vi.fn(),
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
    sessionSearchMessageMatchesCategory: () => true,
  };
});

import {
  getFeedViewportKey,
  persistLeaderViewportPosition,
  readLeaderViewportPosition,
  requestThreadViewportSnapshot,
} from "../utils/thread-viewport.js";
import { MessageFeed } from "./MessageFeed.js";
import {
  createSyntheticLargeLeaderFeedFixture,
  SYNTHETIC_PRIMARY_THREAD_KEY,
} from "../test-fixtures/large-leader-feed-fixture.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setStoreMessages(sessionId: string, messages: ChatMessage[]) {
  mockStoreValues.messages = new Map([[sessionId, messages]]);
}

function makeThreadWindow(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  return {
    thread_key: "q-941",
    from_item: 0,
    item_count: 12,
    total_items: 12,
    has_older_items: false,
    has_newer_items: false,
    source_history_length: 12,
    section_item_count: 6,
    visible_item_count: 3,
    ...overrides,
  };
}

beforeEach(() => {
  mockScrollTo.mockClear();
  mockSetActiveTaskTurnId.mockClear();
  mockSetCollapsibleTurnIds.mockClear();
  mockSendToSession.mockClear();
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  mockStoreValues.messages = new Map();
  mockStoreValues.historyLoading = new Map();
  mockStoreValues.historyWindows = new Map();
  mockStoreValues.feedScrollPosition = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.sdkSessions = [];
  mockStoreValues.threadWindows = new Map();
  mockStoreValues.scrollToMessageId = new Map();
  mockStoreValues.pendingScrollToMessageId = new Map();
  mockStoreValues.threadWindowMessages = new Map();
  mockStoreValues.threadWindowRefreshRevisions = new Map();
  mockStoreValues.threadWindowAppliedRevisions = new Map();
});

describe("MessageFeed thread viewport restoration", () => {
  it("revalidates producer-shaped cached Main and quest windows during warm switches", () => {
    // Cached unselected windows can miss routed live events because the server
    // filters live traffic to the active socket view. Every real selection gets
    // one bounded latest-window revalidation.
    const sid = "test-cached-warm-switches";
    const fixture = createSyntheticLargeLeaderFeedFixture();
    const makeWindow = (threadKey: string, itemCount: number): ThreadWindowState => ({
      thread_key: threadKey,
      from_item: 0,
      item_count: itemCount,
      total_items: itemCount,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: fixture.selectedWindowSourceHistoryLength,
      section_item_count: 10,
      visible_item_count: 3,
      window_hash: `cached-${threadKey}`,
    });
    setStoreMessages(sid, fixture.allMessages);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          ["main", makeWindow("main", fixture.selectedMainWindowMessages.length)],
          [
            SYNTHETIC_PRIMARY_THREAD_KEY,
            makeWindow(SYNTHETIC_PRIMARY_THREAD_KEY, fixture.selectedQuestWindowMessages.length),
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([
      [
        sid,
        new Map([
          ["main", fixture.selectedMainWindowMessages],
          [SYNTHETIC_PRIMARY_THREAD_KEY, fixture.selectedQuestWindowMessages],
        ]),
      ],
    ]);

    const view = render(<MessageFeed key="main" sessionId={sid} threadKey="main" />);
    view.rerender(
      <MessageFeed key={SYNTHETIC_PRIMARY_THREAD_KEY} sessionId={sid} threadKey={SYNTHETIC_PRIMARY_THREAD_KEY} />,
    );
    view.rerender(<MessageFeed key="main-return" sessionId={sid} threadKey="main" />);

    const transportCalls = mockSendToSession.mock.calls as unknown as Array<
      [string, { type?: string; thread_key?: string; cached_window_hash?: string }]
    >;
    const threadRequests = transportCalls
      .filter(([, message]) => message.type === "thread_window_request")
      .map(([, message]) => message);
    expect(threadRequests.map((message) => message.thread_key)).toEqual(["main", SYNTHETIC_PRIMARY_THREAD_KEY, "main"]);
    expect(threadRequests.map((message) => message.cached_window_hash)).toEqual([
      "cached-main",
      `cached-${SYNTHETIC_PRIMARY_THREAD_KEY}`,
      "cached-main",
    ]);
  });

  it("restores a browser-local persisted leader viewport when memory state is missing", async () => {
    const sid = "test-persisted-leader-viewport";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 420,
      scrollHeight: 1600,
      isAtBottom: false,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      render(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(420));
      expect(screen.queryByText("Main setup")).toBeNull();
      expect(screen.getByText("Quest update")).toBeTruthy();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("snapshots the visible message as the leader viewport anchor", () => {
    // Long turns can contain several message rows. Saving the concrete visible
    // message keeps return navigation anchored to the exact content, not just
    // the beginning of the host turn.
    const sid = "test-visible-message-anchor-snapshot";
    setStoreMessages(sid, [
      makeMessage({ id: "u-anchor", role: "user", content: "Earlier request" }),
      makeMessage({ id: "a-visible", role: "assistant", content: "Visible answer" }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 2000 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 500 : 0;
      },
      set() {},
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: -180, width: 600, height: 40 });
      }
      if (this instanceof HTMLElement && this.dataset.messageId === "a-visible") {
        return DOMRect.fromRect({ x: 0, y: 50, width: 600, height: 80 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 400 });
      }
      return originalRect.call(this);
    };

    try {
      render(<MessageFeed sessionId={sid} threadKey="main" />);

      requestThreadViewportSnapshot(sid);

      const stored = readLeaderViewportPosition(sid, "main");
      expect(stored?.anchorMessageId).toBe("a-visible");
      expect(stored?.anchorTurnId).toBe("u-anchor");
      expect(stored?.anchorOffsetTop).toBe(50);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("lets user intent replace a stale pending anchor across copied-live-shaped windows", () => {
    // Restart regression: copied-live Main has 304 projected items. A stale target-117
    // subscribe returns the 30-item window at 245, while the latest target-130 window
    // starts at 274 and no longer contains 117. User intent must retire the old exact
    // restore before that producer-shaped replacement, including its queued RAF work.
    const sid = "test-user-scroll-cancels-pending-restart-anchor";
    const staleWindowMessages = Array.from({ length: 30 }, (_, index) =>
      makeMessage({
        id: index === 10 ? "msg-117" : `stale-window-${245 + index}`,
        role: "user",
        content: index === 10 ? "Main item 117" : `Stale window item ${245 + index}`,
        historyIndex: 17_000 + index,
        timestamp: 17_000 + index,
      }),
    );
    const latestWindowMessages = Array.from({ length: 30 }, (_, index) =>
      makeMessage({
        id: index === 5 ? "msg-130" : `latest-window-${274 + index}`,
        role: "user",
        content: index === 5 ? "Main item 130" : `Latest window item ${274 + index}`,
        historyIndex: 19_000 + index,
        timestamp: 19_000 + index,
      }),
    );
    const makeMainWindow = (fromItem: number, hasNewerItems: boolean): ThreadWindowState =>
      makeThreadWindow({
        thread_key: "main",
        from_item: fromItem,
        item_count: 30,
        total_items: 304,
        has_older_items: true,
        has_newer_items: hasNewerItems,
        source_history_length: 19_087,
      });
    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(245, true)]])]]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", staleWindowMessages]])]]);
    mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 1]])]]);
    persistLeaderViewportPosition(sid, "main", {
      scrollTop: 11_600,
      scrollHeight: 14_000,
      isAtBottom: false,
      anchorMessageId: "msg-117",
      anchorTurnId: "msg-117",
      anchorOffsetTop: 100,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const immediateRequestAnimationFrame = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    const messageTop = new Map<string, number>();
    staleWindowMessages.forEach((message, index) => messageTop.set(message.id, 10_900 + index * 80));
    latestWindowMessages.forEach((message, index) => messageTop.set(message.id, 12_600 + index * 80));
    let scrollTopValue = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 14_000 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        if (this.classList.contains("overflow-y-auto")) scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId && messageTop.has(this.dataset.messageId)) {
        return DOMRect.fromRect({
          x: 0,
          y: messageTop.get(this.dataset.messageId)! - scrollTopValue,
          width: 600,
          height: 80,
        });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 600 });
      }
      return originalRect.call(this);
    };

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      const container = screen.getByTestId("message-feed-scroll-container");

      expect(scrollTopValue).toBe(11_600);
      expect(frames.length).toBeGreaterThan(0);
      expect(screen.getByText("Main item 117")).toBeTruthy();
      expect(screen.queryByText("Main item 130")).toBeNull();

      // The explicit newer-section control must cancel the stale restore before
      // its bounded latest-window response or any queued post-layout callback runs.
      fireEvent.click(screen.getByRole("button", { name: "Load newer section" }));
      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(274, false)]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", latestWindowMessages]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 2]])]]);
      scrollTopValue = 13_000;
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      fireEvent.scroll(container);

      expect(screen.queryByText("Main item 117")).toBeNull();
      expect(
        screen.getByText("Main item 130").closest<HTMLElement>("[data-message-id='msg-130']")?.getBoundingClientRect()
          .top,
      ).toBe(0);

      requestThreadViewportSnapshot(sid);

      expect(readLeaderViewportPosition(sid, "main")?.anchorMessageId).toBe("msg-130");
      while (frames.length > 0) frames.shift()?.(0);
      expect(scrollTopValue).toBe(13_000);
      expect(readLeaderViewportPosition(sid, "main")?.anchorMessageId).toBe("msg-130");
    } finally {
      vi.stubGlobal("requestAnimationFrame", immediateRequestAnimationFrame);
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("retires a search message route only after deliberate viewport movement", async () => {
    // Universal Search can target a stable message outside the latest bounded
    // Main window. The route owns the initial target-centered hydration and
    // flash, then deliberate movement replaces that history entry so a passive
    // Browser Back return restores the newly saved stable anchor instead.
    const sid = "test-search-route-user-scroll-retirement";
    const makeWindowMessages = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, index) => {
        const ordinal = first + index;
        return makeMessage({
          id: ordinal === 45 ? "search-target" : ordinal === 55 ? "manual-anchor" : `main-${ordinal}`,
          role: "user",
          content: ordinal === 45 ? "Searched message" : ordinal === 55 ? "Later reading position" : `Main ${ordinal}`,
          historyIndex: ordinal - 1,
          timestamp: ordinal,
        });
      });
    const latestWindow = makeWindowMessages(102, 131);
    const targetWindow = makeWindowMessages(30, 59);
    const makeMainWindow = (fromItem: number, hasNewerItems: boolean) =>
      makeThreadWindow({
        thread_key: "main",
        from_item: fromItem,
        item_count: 30,
        total_items: 131,
        has_older_items: fromItem > 0,
        has_newer_items: hasNewerItems,
        source_history_length: 131,
      });
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 10_500;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 13_500 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        if (this.classList.contains("overflow-y-auto")) scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId) {
        const id = this.dataset.messageId;
        const ordinal = id === "search-target" ? 45 : id === "manual-anchor" ? 55 : Number(id.slice("main-".length));
        if (Number.isFinite(ordinal)) {
          return DOMRect.fromRect({ x: 0, y: ordinal * 100 - scrollTopValue, width: 600, height: 80 });
        }
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 600 });
      }
      return originalRect.call(this);
    };

    try {
      setStoreMessages(sid, []);
      mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(101, false)]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", latestWindow]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 1]])]]);
      mockStoreValues.scrollToMessageId = new Map([[sid, "search-target"]]);
      mockStoreValues.pendingScrollToMessageId = new Map([[sid, "search-target"]]);
      window.location.hash = `#/session/${sid}/msg/search-target?thread=main&quest=q-7`;

      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() =>
        expect(mockSendToSession).toHaveBeenCalledWith(
          sid,
          expect.objectContaining({ target_message_id: "search-target", type: "thread_window_request" }),
        ),
      );
      expect(screen.queryByText("Searched message")).toBeNull();

      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(29, true)]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", targetWindow]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 2]])]]);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      const targetRow = screen.getByText("Searched message").closest<HTMLElement>("[data-message-id]");
      await waitFor(() => expect(targetRow?.classList.contains("message-scroll-highlight")).toBe(true));
      const container = screen.getByTestId("message-feed-scroll-container");
      const historyLength = history.length;
      fireEvent.scroll(container);
      expect(window.location.hash).toContain("/msg/search-target");

      fireEvent.wheel(container, { deltaY: 120 });
      scrollTopValue = 5_500;
      fireEvent.scroll(container);
      expect(window.location.hash).toBe(`#/session/${sid}?thread=main&quest=q-7`);
      expect(history.length).toBe(historyLength);
      mockStoreValues.scrollToMessageId = new Map();
      mockStoreValues.pendingScrollToMessageId = new Map();
      view.unmount();
      expect(readLeaderViewportPosition(sid, "main")?.anchorMessageId).toBe("manual-anchor");

      window.location.hash = "/session/other";
      history.back();
      await waitFor(() => expect(window.location.hash).toBe(`#/session/${sid}?thread=main&quest=q-7`));
      mockSendToSession.mockClear();
      scrollTopValue = 10_500;
      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(101, false)]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", latestWindow]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 3]])]]);
      const returned = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() =>
        expect(mockSendToSession).toHaveBeenCalledWith(
          sid,
          expect.objectContaining({ target_message_id: "manual-anchor", type: "thread_window_request" }),
        ),
      );
      expect(mockSendToSession).not.toHaveBeenCalledWith(
        sid,
        expect.objectContaining({ target_message_id: "search-target" }),
      );

      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", makeMainWindow(29, true)]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", targetWindow]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 4]])]]);
      returned.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(scrollTopValue).toBe(5_500));
      expect(screen.getByText("Later reading position")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("restores a saved message anchor inside a long selected-thread turn", async () => {
    // Restoring only the turn anchor can land at the start of a long turn,
    // which is materially earlier than the content the user was reading.
    const sid = "test-restore-message-anchor-inside-long-turn";
    const windowMessages = [
      makeMessage({ id: "u-anchor", role: "user", content: "Long request", historyIndex: 1 }),
      makeMessage({ id: "a-visible", role: "assistant", content: "Exact visible answer", historyIndex: 2 }),
    ];
    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([[sid, new Map([["q-941", makeThreadWindow({ item_count: 2 })]])]]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 999,
      scrollHeight: 3000,
      isAtBottom: false,
      anchorMessageId: "a-visible",
      anchorTurnId: "u-anchor",
      anchorOffsetTop: 80,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 3000 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 700 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId === "a-visible") {
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTopValue, width: 600, height: 100 });
      }
      if (this instanceof HTMLElement && this.dataset.turnId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: 300 - scrollTopValue, width: 600, height: 1300 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 700 });
      }
      return originalRect.call(this);
    };

    try {
      render(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(1370));
      expect(screen.getByText("Exact visible answer")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("defaults missing leader viewport state to the latest bottom", () => {
    const sid = "test-missing-leader-viewport-bottom";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({ id: "a-main-1", role: "assistant", content: "Main answer" }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1200 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 400 : 0;
      },
    });

    try {
      render(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(mockScrollTo).toHaveBeenCalledWith({ top: 788, behavior: "auto" });
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("waits for the selected thread window before restoring a persisted anchor", async () => {
    // The selected tab can restore before its server-backed thread window has
    // hydrated. Anchored viewport restore must wait so a pre-window render does
    // not consume the saved state and leave the user at scrollTop=0.
    const sid = "test-persisted-anchor-after-window";
    const liveThreadMessage = makeMessage({
      id: "live-q941",
      role: "assistant",
      content: "Live quest shell",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const windowMessages = [
      makeMessage({ id: "u-before", role: "user", content: "Earlier request", historyIndex: 1 }),
      makeMessage({ id: "a-before", role: "assistant", content: "Earlier answer", historyIndex: 2 }),
      makeMessage({ id: "u-anchor", role: "user", content: "Saved anchor request", historyIndex: 3 }),
      makeMessage({ id: "a-anchor", role: "assistant", content: "Saved anchor answer", historyIndex: 4 }),
    ];
    setStoreMessages(sid, [liveThreadMessage]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 1600,
      scrollHeight: 5226,
      isAtBottom: false,
      anchorTurnId: "u-anchor",
      anchorOffsetTop: -120,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTopValue, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      expect(scrollTopValue).toBe(0);
      expect(mockScrollTo).not.toHaveBeenCalled();

      mockStoreValues.threadWindows = new Map([[sid, new Map([["q-941", makeThreadWindow()]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(1570));
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("reapplies a later saved viewport for the same selected thread key", async () => {
    // A user can first visit a selected quest tab before scrolling it. When
    // switching away later, the newly saved viewport must invalidate the prior
    // "restored" marker for the same session/thread key.
    const sid = "test-reapply-later-anchor-same-thread";
    const liveThreadMessage = makeMessage({
      id: "live-q941",
      role: "assistant",
      content: "Live quest shell",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const windowMessages = [
      makeMessage({ id: "u-before", role: "user", content: "Earlier request", historyIndex: 1 }),
      makeMessage({ id: "a-before", role: "assistant", content: "Earlier answer", historyIndex: 2 }),
      makeMessage({ id: "u-anchor", role: "user", content: "Saved anchor request", historyIndex: 3 }),
      makeMessage({ id: "a-anchor", role: "assistant", content: "Saved anchor answer", historyIndex: 4 }),
    ];
    setStoreMessages(sid, [liveThreadMessage]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([[sid, new Map([["q-941", makeThreadWindow()]])]]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTopValue, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
      expect(scrollTopValue).toBe(0);

      persistLeaderViewportPosition(sid, "q-941", {
        scrollTop: 1600,
        scrollHeight: 5226,
        isAtBottom: false,
        anchorTurnId: "u-anchor",
        anchorOffsetTop: -120,
      });
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(1570));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("prefers durable leader viewport storage over stale memory state", async () => {
    // Session switching can leave a stale in-memory viewport cache from an
    // earlier render. The browser-local durable state is the source of truth
    // for leader session return, so it must win when restoring the selected tab.
    const sid = "test-leader-durable-viewport-wins";
    const liveThreadMessage = makeMessage({
      id: "live-q941",
      role: "assistant",
      content: "Live quest shell",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const windowMessages = [
      makeMessage({ id: "u-before", role: "user", content: "Earlier request", historyIndex: 1 }),
      makeMessage({ id: "a-before", role: "assistant", content: "Earlier answer", historyIndex: 2 }),
      makeMessage({ id: "u-anchor", role: "user", content: "Saved anchor request", historyIndex: 3 }),
      makeMessage({ id: "a-anchor", role: "assistant", content: "Saved anchor answer", historyIndex: 4 }),
    ];
    setStoreMessages(sid, [liveThreadMessage]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([[sid, new Map([["q-941", makeThreadWindow()]])]]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
    mockStoreValues.feedScrollPosition = new Map([
      [getFeedViewportKey(sid, "q-941"), { scrollTop: 0, scrollHeight: 5226, isAtBottom: false }],
    ]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 1600,
      scrollHeight: 5226,
      isAtBottom: false,
      anchorTurnId: "u-anchor",
      anchorOffsetTop: -120,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-anchor") {
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTopValue, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      render(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(scrollTopValue).toBe(1570));
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("restores selected-thread anchors without local section-window resets", async () => {
    // Server-backed selected-thread windows already provide the visible
    // conversation range. Local section-window state is ignored for those
    // windows, and touching it during restore can schedule auto-follow work
    // that loses the restored scroll before the final feed settles.
    const sid = "test-windowed-thread-anchor-no-section-reset";
    const windowMessages = Array.from({ length: 12 }, (_, index) =>
      makeMessage({
        id: `u-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 6 ? "Saved anchor request" : `Thread item ${index + 1}`,
        historyIndex: index + 1,
      }),
    );
    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "q-941",
            makeThreadWindow({
              item_count: 12,
              total_items: 12,
              visible_item_count: 12,
              section_item_count: 2,
            }),
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 1600,
      scrollHeight: 5226,
      isAtBottom: false,
      anchorTurnId: "u-7",
      anchorOffsetTop: -120,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-7") {
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTopValue, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      render(<MessageFeed sessionId={sid} threadKey="q-941" sectionTurnCount={2} />);

      await waitFor(() => expect(scrollTopValue).toBe(1570));
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("reapplies selected-thread anchors when the scroll container is replaced", async () => {
    // Browser validation for session return showed the durable anchor restore
    // ran, then the final visible feed was a fresh top-positioned container. The
    // restore latch must track which DOM container received the saved viewport,
    // not only the saved viewport signature.
    const sid = "test-windowed-thread-anchor-after-container-replace";
    const windowMessages = Array.from({ length: 12 }, (_, index) =>
      makeMessage({
        id: `u-${index + 1}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 6 ? "Saved anchor request" : `Thread item ${index + 1}`,
        historyIndex: index + 1,
      }),
    );
    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "q-941",
            makeThreadWindow({
              item_count: 12,
              total_items: 12,
              visible_item_count: 12,
              section_item_count: 2,
            }),
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
    persistLeaderViewportPosition(sid, "q-941", {
      scrollTop: 1600,
      scrollHeight: 5226,
      isAtBottom: false,
      anchorTurnId: "u-7",
      anchorOffsetTop: -120,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const scrollTopByElement = new WeakMap<HTMLDivElement, number>();
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 5226 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? (scrollTopByElement.get(this) ?? 0) : 0;
      },
      set(value) {
        if (this.classList.contains("overflow-y-auto")) {
          scrollTopByElement.set(this, value as number);
        }
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.turnId === "u-7") {
        const container = this.closest<HTMLDivElement>("[data-testid='message-feed-scroll-container']");
        const scrollTop = container ? (scrollTopByElement.get(container) ?? 0) : 0;
        return DOMRect.fromRect({ x: 0, y: 1450 - scrollTop, width: 600, height: 100 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" sectionTurnCount={2} />);

      await waitFor(() => expect(screen.getByTestId("message-feed-scroll-container").scrollTop).toBe(1570));
      const restoredContainer = screen.getByTestId("message-feed-scroll-container");

      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", []]])]]);
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" sectionTurnCount={2} />);
      expect(screen.queryByTestId("message-feed-scroll-container")).toBeNull();

      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-941", windowMessages]])]]);
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" sectionTurnCount={2} />);

      await waitFor(() => {
        const replacementContainer = screen.getByTestId("message-feed-scroll-container");
        expect(replacementContainer).not.toBe(restoredContainer);
        expect(replacementContainer.scrollTop).toBe(1570);
      });
      expect(screen.getByText("Saved anchor request")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("requests the saved Main anchor window before falling back to proportional scroll", async () => {
    // Reopened q-1794 regression: a live leader Main Thread can reopen with a
    // valid saved anchor outside the currently hydrated thread window. Restore
    // must request the anchor-centered window instead of consuming the saved
    // state against older visible content and landing far above the target.
    const sid = "test-main-anchor-window-before-fallback";
    const olderWindowMessages = [
      makeMessage({ id: "u-q1812", role: "user", content: "q-1812 request", historyIndex: 80 }),
      makeMessage({ id: "a-q1812-error", role: "assistant", content: "Recovery error region", historyIndex: 81 }),
    ];
    const targetWindowMessages = [
      makeMessage({ id: "u-q1813", role: "user", content: "q-1813 request", historyIndex: 120 }),
      makeMessage({ id: "a-q1813-answer", role: "assistant", content: "Completed q-1813 answer", historyIndex: 121 }),
    ];
    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "main",
            makeThreadWindow({
              thread_key: "main",
              from_item: 80,
              item_count: 12,
              total_items: 140,
              has_older_items: true,
              has_newer_items: true,
              source_history_length: 140,
            }),
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", olderWindowMessages]])]]);
    mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 1]])]]);
    persistLeaderViewportPosition(sid, "main", {
      scrollTop: 2400,
      scrollHeight: 6400,
      isAtBottom: false,
      anchorMessageId: "a-q1813-answer",
      anchorTurnId: "u-q1813",
      anchorOffsetTop: 96,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 6400 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 846 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId === "a-q1813-answer") {
        return DOMRect.fromRect({ x: 0, y: 1520 - scrollTopValue, width: 600, height: 180 });
      }
      if (this instanceof HTMLElement && this.dataset.turnId === "u-q1813") {
        return DOMRect.fromRect({ x: 0, y: 1320 - scrollTopValue, width: 600, height: 420 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 846 });
      }
      return originalRect.call(this);
    };

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="main" />);

      await waitFor(() =>
        expect(mockSendToSession).toHaveBeenCalledWith(
          sid,
          expect.objectContaining({
            type: "thread_window_request",
            thread_key: "main",
            target_message_id: "a-q1813-answer",
          }),
        ),
      );
      expect(scrollTopValue).toBe(0);
      expect(screen.getByText("Recovery error region")).toBeTruthy();

      mockStoreValues.threadWindows = new Map([
        [
          sid,
          new Map([
            [
              "main",
              makeThreadWindow({
                thread_key: "main",
                from_item: 116,
                item_count: 12,
                total_items: 140,
                has_older_items: true,
                has_newer_items: true,
                source_history_length: 140,
              }),
            ],
          ]),
        ],
      ]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", targetWindowMessages]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", 2]])]]);
      rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      await waitFor(() => expect(scrollTopValue).toBe(1424));
      expect(screen.getByText("Completed q-1813 answer")).toBeTruthy();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("keeps the saved Main anchor after target hydration rolls back to an older visible message", async () => {
    // Producer-shaped 30-item Main windows reproduce the desktop return race:
    // the old window snapshots msg-117, target hydration synchronously restores
    // msg-130, then the late layout-signature effect restores msg-117 before the
    // queued saved-anchor verification runs. Repeated returns must let msg-130
    // win and remain the durable viewport rather than persisting the rollback.
    const sid = "test-main-target-hydration-late-layout-rollback";
    const makeMainMessages = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, index) => {
        const ordinal = first + index;
        return makeMessage({
          id: `msg-${ordinal}`,
          role: "user",
          content: `Main item ${ordinal}`,
          historyIndex: ordinal - 1,
          timestamp: ordinal,
        });
      });
    const olderWindowMessages = makeMainMessages(88, 117);
    const targetWindowMessages = makeMainMessages(102, 131);
    const makeMainWindow = (fromItem: number, windowHash: string): ThreadWindowState => ({
      thread_key: "main",
      from_item: fromItem,
      item_count: 30,
      total_items: 131,
      has_older_items: fromItem > 0,
      has_newer_items: fromItem + 30 < 131,
      source_history_length: 131,
      section_item_count: 10,
      visible_item_count: 3,
      window_hash: windowHash,
    });
    const setMainWindow = (window: ThreadWindowState, messages: ChatMessage[], revision: number) => {
      mockStoreValues.threadWindows = new Map([[sid, new Map([["main", window]])]]);
      mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["main", messages]])]]);
      mockStoreValues.threadWindowAppliedRevisions = new Map([[sid, new Map([["main", revision]])]]);
    };

    setStoreMessages(sid, []);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    persistLeaderViewportPosition(sid, "main", {
      scrollTop: 12900,
      scrollHeight: 14000,
      isAtBottom: false,
      anchorMessageId: "msg-130",
      anchorTurnId: "msg-130",
      anchorOffsetTop: 100,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const immediateRequestAnimationFrame = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    let scrollTopValue = 11700;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 14000 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        if (this.classList.contains("overflow-y-auto")) scrollTopValue = value as number;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this instanceof HTMLElement && this.dataset.messageId?.startsWith("msg-")) {
        const ordinal = Number(this.dataset.messageId.slice("msg-".length));
        return DOMRect.fromRect({ x: 0, y: ordinal * 100 - scrollTopValue, width: 600, height: 80 });
      }
      if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
        return DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 600 });
      }
      return originalRect.call(this);
    };

    const flushQueuedAnimationFrames = async () => {
      for (let frame = 0; frame < 20 && frames.length > 0; frame += 1) {
        const callbacks = frames.splice(0);
        await act(async () => {
          callbacks.forEach((callback) => callback(frame));
          await Promise.resolve();
        });
      }
    };

    try {
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        scrollTopValue = 11700;
        setMainWindow(makeMainWindow(87, `older-${cycle}`), olderWindowMessages, cycle * 2 - 1);
        const view = render(<MessageFeed key={`return-${cycle}`} sessionId={sid} threadKey="main" />);
        await flushQueuedAnimationFrames();
        expect(screen.getByText("Main item 117")).toBeTruthy();

        setMainWindow(makeMainWindow(101, `target-${cycle}`), targetWindowMessages, cycle * 2);
        view.rerender(<MessageFeed key={`return-${cycle}`} sessionId={sid} threadKey="main" />);
        expect(screen.getByText("Main item 130")).toBeTruthy();

        await flushQueuedAnimationFrames();
        expect(scrollTopValue).toBe(12900);
        expect(
          screen.getByText("Main item 130").closest<HTMLElement>("[data-message-id='msg-130']")?.getBoundingClientRect()
            .top,
        ).toBe(100);

        view.unmount();
        expect(readLeaderViewportPosition(sid, "main")?.anchorMessageId).toBe("msg-130");
      }
    } finally {
      vi.stubGlobal("requestAnimationFrame", immediateRequestAnimationFrame);
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
    }
  });

  it("restores Main independently after visiting a short quest thread", () => {
    // Regression for q-976: a short quest projection must not leave Main at
    // the oldest messages when returning to the Main projection.
    const sid = "test-thread-aware-main-restore";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({ id: "a-main-1", role: "assistant", content: "Main answer" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Short quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.feedScrollPosition = new Map([
      [getFeedViewportKey(sid, "main"), { scrollTop: 300, scrollHeight: 1200, isAtBottom: false }],
      [getFeedViewportKey(sid, "q-941"), { scrollTop: 0, scrollHeight: 300, isAtBottom: true }],
    ]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1800 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      scrollTopValue = 0;

      rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(scrollTopValue).toBe(450);
      expect(screen.getByText("Main setup")).toBeTruthy();
      expect(screen.queryByText("Short quest update")).toBeNull();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it.each([
    { label: "normal Main", isLeader: false, threadKey: "main" },
    { label: "leader All Threads", isLeader: true, threadKey: "all" },
  ])("waits for the history window before requesting a saved off-window anchor in $label", async ({
    isLeader,
    threadKey,
  }) => {
    // Current-build normal and All feeds receive authoritative history windows. Cached
    // rows must not consume an off-window saved anchor before that window arrives.
    const sid = `test-delayed-history-anchor-${threadKey}`;
    const savedPosition = {
      scrollTop: 2_400,
      scrollHeight: 6_400,
      isAtBottom: false,
      anchorMessageId: "target-answer",
      anchorTurnId: "target-request",
      anchorOffsetTop: 96,
    };
    setStoreMessages(sid, [
      makeMessage({ id: "cached-request", role: "user", content: "Cached earlier request", historyIndex: 10 }),
      makeMessage({ id: "cached-answer", role: "assistant", content: "Cached earlier answer", historyIndex: 11 }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: isLeader }]]);
    mockStoreValues.historyLoading = new Map([[sid, true]]);
    if (isLeader) {
      persistLeaderViewportPosition(sid, threadKey, savedPosition);
    } else {
      mockStoreValues.feedScrollPosition = new Map([[getFeedViewportKey(sid, threadKey), savedPosition]]);
    }

    const view = render(<MessageFeed sessionId={sid} threadKey={threadKey} />);
    await Promise.resolve();
    expect(mockSendToSession).not.toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ type: "history_window_request", target_message_id: "target-answer" }),
    );

    mockStoreValues.historyLoading = new Map();
    mockStoreValues.historyWindows = new Map([
      [
        sid,
        {
          from_turn: 10,
          turn_count: 30,
          total_turns: 100,
          has_older_items: true,
          has_newer_items: true,
          start_index: 10,
          section_turn_count: 10,
          visible_section_count: 3,
        },
      ],
    ]);
    view.rerender(<MessageFeed sessionId={sid} threadKey={threadKey} />);

    await waitFor(() =>
      expect(mockSendToSession).toHaveBeenCalledWith(
        sid,
        expect.objectContaining({
          type: "history_window_request",
          from_turn: -1,
          target_message_id: "target-answer",
        }),
      ),
    );
  });

  it("keeps All Threads scroll independent from Main", () => {
    // All Threads is a global projection, so it needs its own viewport state
    // instead of borrowing Main's reading position.
    const sid = "test-thread-aware-all-independent";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main-1", role: "user", content: "Main setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Quest update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);
    mockStoreValues.feedScrollPosition = new Map([
      [getFeedViewportKey(sid, "main"), { scrollTop: 300, scrollHeight: 1600, isAtBottom: false }],
      [getFeedViewportKey(sid, "all"), { scrollTop: 700, scrollHeight: 1600, isAtBottom: false }],
    ]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="all" />);
      expect(scrollTopValue).toBe(700);

      rerender(<MessageFeed sessionId={sid} threadKey="main" />);

      expect(scrollTopValue).toBe(300);
      expect(screen.getByText("Main setup")).toBeTruthy();
      expect(screen.queryByText("Quest update")).toBeNull();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });

  it("uses a just-snapshotted leader thread viewport after reconnect history replacement", async () => {
    const sid = "test-reconnect-history-uses-fresh-snapshot";
    const firstMessage = makeMessage({
      id: "a-q941-before",
      role: "assistant",
      content: "Quest update before reconnect",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const secondMessage = makeMessage({
      id: "a-q941-after",
      role: "assistant",
      content: "Quest update after reconnect",
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    setStoreMessages(sid, [firstMessage]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollHeightValue = 1200;
    let scrollTopValue = 760;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollHeightValue : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 400 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
      scrollTopValue = 760;
      mockScrollTo.mockClear();

      requestThreadViewportSnapshot(sid);
      expect(readLeaderViewportPosition(sid, "q-941")?.isAtBottom).toBe(true);

      scrollHeightValue = 1500;
      scrollTopValue = 0;
      setStoreMessages(sid, [firstMessage, secondMessage]);
      rerender(<MessageFeed sessionId={sid} threadKey="q-941" />);

      await waitFor(() => expect(mockScrollTo).toHaveBeenCalledWith({ top: 1088, behavior: "auto" }));
      expect(screen.getByText("Quest update after reconnect")).toBeTruthy();
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      else delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      else delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
      if (originalScrollTop) Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      else delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
    }
  });
});
