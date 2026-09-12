// @vitest-environment jsdom

const mockScrollTo = vi.fn();
const mediaState = { touchDevice: false };
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
      matches: query === "(hover: none) and (pointer: coarse)" ? mediaState.touchDevice : false,
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
import type { BrowserIncomingMessage, ChatMessage } from "../types.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../shared/leader-thread-tabs-projection.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { createLeaderThreadTabsProjectionValue } from "../test-fixtures/leader-thread-tabs-projection.js";
import { normalizeHistoryMessageToChatMessages } from "../utils/history-message-normalization.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("../ws.js", () => ({
  sendToSession: mockSendToSession,
}));

vi.mock("../api.js", () => ({
  api: {
    searchSessionMessages: vi.fn().mockResolvedValue({ results: [], hasMore: false, nextOffset: null }),
  },
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
      historyLoading: new Map(),
      historyWindows: new Map(),
      streaming: new Map(),
      streamingByParentToolUseId: new Map(),
      streamingThinking: new Map(),
      streamingThinkingByParentToolUseId: new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: new Map(),
      streamingPausedDuration: new Map(),
      streamingPauseStartedAt: new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      activeTurnRoutes: mockStoreValues.activeTurnRoutes ?? new Map(),
      sessionStuck: new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
      connectionStatus: mockStoreValues.connectionStatus ?? new Map(),
      cliConnected: mockStoreValues.cliConnected ?? new Map(),
      cliEverConnected: mockStoreValues.cliEverConnected ?? new Map(),
      cliDisconnectReason: mockStoreValues.cliDisconnectReason ?? new Map(),
      serverReachable: true,
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
      scrollToMessageId: new Map(),
      pendingScrollToMessageId: new Map(),
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
      sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
      sessionSearch: new Map(),
      threadWindows: mockStoreValues.threadWindows ?? new Map(),
      threadWindowMessages: mockStoreValues.threadWindowMessages ?? new Map(),
      threadWindowRefreshRevisions: new Map(),
      threadWindowAppliedRevisions: new Map(),
      syncedProjectionValues: mockStoreValues.syncedProjectionValues ?? new Map(),
      syncedProjectionKeys: mockStoreValues.syncedProjectionKeys ?? new Set(),
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
  persistLeaderViewportPosition,
  readLeaderViewportPosition,
  requestThreadViewportSnapshot,
} from "../utils/thread-viewport.js";
import { MessageFeed } from "./MessageFeed.js";
import { measureThreadStatusLayoutContribution } from "./MessageFeedThreadStatus.js";

beforeEach(() => {
  mockScrollTo.mockClear();
  mockSetActiveTaskTurnId.mockClear();
  mockSetCollapsibleTurnIds.mockClear();
  mockSendToSession.mockClear();
  mediaState.touchDevice = false;
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  mockStoreValues.messages = new Map();
  mockStoreValues.feedScrollPosition = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.sdkSessions = [];
  mockStoreValues.threadWindows = new Map();
  mockStoreValues.threadWindowMessages = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.activeTurnRoutes = new Map();
  mockStoreValues.sessionNotifications = new Map();
  mockStoreValues.connectionStatus = new Map();
  mockStoreValues.cliConnected = new Map();
  mockStoreValues.cliEverConnected = new Map();
  mockStoreValues.cliDisconnectReason = new Map();
  mockStoreValues.syncedProjectionValues = new Map();
  mockStoreValues.syncedProjectionKeys = new Set();
});

function buildProducerViewportWindows() {
  const history: BrowserIncomingMessage[] = [];
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    for (const threadKey of ["main", "q-4091"] as const) {
      const route = {
        threadKey,
        ...(threadKey === "main" ? {} : { questId: threadKey }),
        threadRefs: [
          {
            threadKey,
            ...(threadKey === "main" ? {} : { questId: threadKey }),
            source: "explicit" as const,
          },
        ],
      };
      history.push(
        {
          type: "user_message",
          id: `${threadKey}-user-${ordinal}`,
          content: `${threadKey} request ${ordinal}`,
          timestamp: ordinal * 10,
          ...route,
        },
        {
          type: "assistant",
          message: {
            id: `${threadKey}-assistant-${ordinal}`,
            type: "message",
            role: "assistant",
            model: "claude",
            content: [{ type: "text", text: `${threadKey} answer ${ordinal}` }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          timestamp: ordinal * 10 + 1,
          ...route,
        },
      );
    }
  }

  return new Map(
    (["main", "q-4091"] as const).map((threadKey) => {
      const sync = buildThreadWindowSync({
        messageHistory: history,
        threadKey,
        fromItem: 0,
        itemCount: 10,
        sectionItemCount: 10,
        visibleItemCount: 3,
      });
      return [
        threadKey,
        {
          window: sync.window,
          messages: sync.entries.flatMap((entry) =>
            normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
          ),
        },
      ];
    }),
  );
}

function installControlledResizeObserver() {
  const original = globalThis.ResizeObserver;
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();

  class ControlledResizeObserver implements ResizeObserver {
    readonly record: { callback: ResizeObserverCallback; targets: Set<Element> };

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: new Set() };
      observers.add(this.record);
    }

    observe(target: Element) {
      this.record.targets.add(target);
    }
    unobserve(target: Element) {
      this.record.targets.delete(target);
    }
    disconnect() {
      this.record.targets.clear();
      observers.delete(this.record);
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ControlledResizeObserver,
  });
  return {
    triggerElement(target: Element) {
      let count = 0;
      for (const observer of observers) {
        if (!observer.targets.has(target)) continue;
        observer.callback([], observer as unknown as ResizeObserver);
        count += 1;
      }
      return count;
    },
    restore() {
      if (original) {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          writable: true,
          value: original,
        });
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
    },
  };
}

function setProducerActivity(sessionId: string, threadKey: string, active: boolean) {
  mockStoreValues.sessionStatus = active ? new Map([[sessionId, "running"]]) : new Map();
  mockStoreValues.streamingStartedAt = active ? new Map([[sessionId, Date.now() - 5_000]]) : new Map();
  mockStoreValues.activeTurnRoutes = new Map([
    [sessionId, { threadKey, questId: threadKey === "main" ? undefined : threadKey }],
  ]);
}

function setProducerWindow(sessionId: string, threadKey: "main" | "q-4091") {
  const selected = buildProducerViewportWindows().get(threadKey)!;
  mockStoreValues.threadWindows = new Map([[sessionId, new Map([[threadKey, selected.window]])]]);
  mockStoreValues.threadWindowMessages = new Map([[sessionId, new Map([[threadKey, selected.messages]])]]);
  return selected;
}

function setConnectedLeaderSession(sessionId: string, overrides: Record<string, unknown> = {}) {
  mockStoreValues.sessions = new Map([
    [
      sessionId,
      {
        session_id: sessionId,
        backend_type: "codex",
        backend_state: "connected",
        isOrchestrator: true,
        ...overrides,
      },
    ],
  ]);
  mockStoreValues.connectionStatus = new Map([[sessionId, "connected"]]);
  mockStoreValues.cliConnected = new Map([[sessionId, true]]);
  mockStoreValues.cliEverConnected = new Map([[sessionId, true]]);
  mockStoreValues.cliDisconnectReason = new Map([[sessionId, null]]);
}

function stackedStatusSessionState() {
  return {
    codex_turn_recovery: {
      recoveryId: "recovery-owner",
      originalOwnerId: "recovery-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 7,
      continuationOwnerId: null,
      threadKey: "main",
      status: "recovering",
      reason: "adapter_disconnect",
      attempt: 0,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    },
    codex_provider_retry: {
      family: "model_backend_stream_error",
      ownerId: "input-1",
      attempt: 4,
      maxAttempts: null,
      startedAt: 100,
    },
  };
}

function setProducerThreadStatus(sessionId: string, status: LeaderThreadStatus | null) {
  const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, sessionId);
  const statusKey = status?.threadKey ?? "main";
  mockStoreValues.syncedProjectionValues = new Map([
    [
      entryId,
      createLeaderThreadTabsProjectionValue({
        tabs: [],
        mainAttention: { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 },
        threadStatuses: status ? { [statusKey]: status } : {},
        activePhaseSummary: [],
      }),
    ],
  ]);
  mockStoreValues.syncedProjectionKeys = new Set([entryId]);
}

function makeThreadStatus(
  threadKey: "main" | "q-4091",
  messageId: string,
  overrides: Partial<LeaderThreadStatus> = {},
): LeaderThreadStatus {
  return {
    kind: "waiting",
    label: "Thread Waiting",
    threadKey,
    summary: "status geometry under validation",
    messageId,
    timestamp: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function setNeedsInputNotification(sessionId: string) {
  mockStoreValues.sessionNotifications = new Map([
    [
      sessionId,
      [
        {
          id: "needs-input-visible",
          category: "needs-input",
          summary: "Choose the next step",
          timestamp: Date.now(),
          messageId: "main-assistant-4",
          done: false,
        },
      ],
    ],
  ]);
}

function installActivityViewportGeometry(messages: ChatMessage[], clientHeight: number, initialScrollTop: number) {
  const positions = new Map(messages.map((message, index) => [message.id, 100 + index * 120]));
  const lastMessageId = messages.at(-1)!.id;
  let lastMessageHeight = 80;
  let scrollTop = initialScrollTop;
  const descriptors = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop"),
  };
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const rowHeight = 27;
  const rowGap = 6;
  let currentThreadStatusHeight = rowHeight;
  const messageContentBottom = () => Math.max(...positions.values()) + lastMessageHeight;
  const threadStatusFooterHeight = () =>
    document.querySelector('[data-testid="turn-thread-status-footer"]') ? currentThreadStatusHeight : 0;
  const contentBottom = () => messageContentBottom() + threadStatusFooterHeight();
  const renderedSlack = () => {
    const spacer = document.querySelector<HTMLElement>("[data-feed-end-slack]");
    return Number.parseFloat(spacer?.style.height ?? "") || 12;
  };
  const clamp = (value: number) => Math.max(0, Math.min(value, contentBottom() + renderedSlack() - clientHeight));
  const directStatusRowCount = (element: HTMLElement) =>
    [...element.children].filter((child) => child instanceof HTMLDivElement || child instanceof HTMLButtonElement)
      .length;

  Object.defineProperties(HTMLDivElement.prototype, {
    scrollHeight: {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? contentBottom() + renderedSlack() : 0;
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? clientHeight : 0;
      },
    },
    scrollTop: {
      configurable: true,
      get() {
        if (!this.classList.contains("overflow-y-auto")) return 0;
        // Browser engines synchronously clamp an out-of-range scrollTop when a
        // trailing spacer shrinks. Model that layout behavior on every read.
        scrollTop = clamp(scrollTop);
        return scrollTop;
      },
      set(value) {
        if (this.classList.contains("overflow-y-auto")) scrollTop = clamp(value as number);
      },
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    // Any geometry read can force browser layout and clamp an out-of-range
    // scrollTop before React's later layout effects add compensation.
    scrollTop = clamp(scrollTop);
    if (this.dataset.testid === "feed-status-pill-left") {
      const rows = directStatusRowCount(this);
      const height = rows === 0 ? 0 : rows * rowHeight + (rows - 1) * rowGap;
      return DOMRect.fromRect({ width: 220, height });
    }
    if (this.dataset.testid === "feed-status-pill-right") {
      return DOMRect.fromRect({ width: 220, height: directStatusRowCount(this) > 0 ? rowHeight : 0 });
    }
    if (this.dataset.feedActivityRow === "true") {
      return DOMRect.fromRect({ width: 180, height: rowHeight });
    }
    if (this.dataset.feedActivityReservation === "true") {
      return DOMRect.fromRect({ height: Number.parseFloat(this.style.height) || 0 });
    }
    if (this.dataset.turnId) {
      const height = Math.max(1, threadStatusFooterHeight());
      return DOMRect.fromRect({ y: contentBottom() - height - scrollTop, width: 600, height });
    }
    if (this.dataset.testid === "turn-thread-status-footer") {
      return DOMRect.fromRect({ width: 420, height: threadStatusFooterHeight() });
    }
    const absoluteTop = this.dataset.messageId ? positions.get(this.dataset.messageId) : undefined;
    if (absoluteTop != null) {
      const height = this.dataset.messageId === lastMessageId ? lastMessageHeight : 80;
      return DOMRect.fromRect({ y: absoluteTop - scrollTop, width: 600, height });
    }
    if (this instanceof HTMLDivElement && this.classList.contains("overflow-y-auto")) {
      return DOMRect.fromRect({ width: 600, height: clientHeight });
    }
    return originalRect.call(this);
  };
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: (element: Element, pseudoElt?: string | null) => {
      const style = originalGetComputedStyle(element, pseudoElt);
      if ((element as HTMLElement).dataset.testid !== "feed-status-pill-left") return style;
      return new Proxy(style, {
        get(target, property, receiver) {
          if (property === "rowGap") return `${rowGap}px`;
          return Reflect.get(target, property, receiver);
        },
      });
    },
  });
  mockScrollTo.mockImplementation(function (this: HTMLDivElement, options: ScrollToOptions) {
    if (this.classList.contains("overflow-y-auto")) this.scrollTop = options.top ?? 0;
  });

  return {
    get contentBottom() {
      return contentBottom();
    },
    get scrollTop() {
      return clamp(scrollTop);
    },
    get scrollHeight() {
      return contentBottom() + renderedSlack();
    },
    get slack() {
      return renderedSlack();
    },
    get threadStatusFooterHeight() {
      return threadStatusFooterHeight();
    },
    growLastMessage(delta: number) {
      lastMessageHeight += delta;
    },
    setScrollTop(value: number) {
      scrollTop = clamp(value);
    },
    setThreadStatusFooterHeight(value: number) {
      currentThreadStatusHeight = value;
    },
    setPhysicalBottom() {
      scrollTop = contentBottom() + renderedSlack() - clientHeight;
    },
    setRealContentBottom() {
      scrollTop = contentBottom() - clientHeight;
    },
    restore() {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperty(globalThis, "getComputedStyle", {
        configurable: true,
        writable: true,
        value: originalGetComputedStyle,
      });
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(HTMLDivElement.prototype, key, descriptor);
        else delete (HTMLDivElement.prototype as unknown as Record<string, unknown>)[key];
      }
      mockScrollTo.mockImplementation(() => undefined);
    },
  };
}

describe("thread status layout contribution measurement", () => {
  it("includes the effective gap from the previous sibling", () => {
    const parent = document.createElement("div");
    const previous = document.createElement("div");
    const footer = document.createElement("div");
    parent.append(previous, footer);
    vi.spyOn(previous, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 100, height: 20 }));
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ y: 128, height: 24 }));

    expect(measureThreadStatusLayoutContribution(footer)).toBe(32);
  });

  it("falls back to border-box height plus computed margins", () => {
    const footer = document.createElement("div");
    footer.style.marginTop = "8px";
    footer.style.marginBottom = "4px";
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ height: 24 }));

    expect(measureThreadStatusLayoutContribution(footer)).toBe(36);
  });
});

describe("MessageFeed activity viewport stability", () => {
  it.each([
    { threadKey: "main" as const, readingTop: 580, anchorIndex: 4, label: "manual near-bottom Main" },
    { threadKey: "q-4091" as const, readingTop: 340, anchorIndex: 2, label: "scrolled-away quest" },
  ])("keeps the exact $label anchor stable across repeated activity and idle changes", async ({
    threadKey,
    readingTop,
    anchorIndex,
  }) => {
    // The selected windows come from the production server builder and history normalizer.
    // Manual positions are not auto-following, so status-only transitions must preserve both
    // the stable message identity and its exact viewport offset.
    const sid = `activity-anchor-${threadKey}`;
    const selected = setProducerWindow(sid, threadKey);
    const anchor = selected.messages[anchorIndex]!;
    setConnectedLeaderSession(sid);
    setProducerActivity(sid, threadKey, true);
    persistLeaderViewportPosition(sid, threadKey, {
      scrollTop: readingTop,
      scrollHeight: 1_052,
      isAtBottom: false,
      anchorMessageId: anchor.id,
      anchorTurnId: anchor.id,
      anchorOffsetTop: 0,
      lastSeenContentBottom: 1_020,
    });
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, readingTop);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey={threadKey} />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      const anchorElement = document.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`)!;
      for (const active of [false, true, false, true]) {
        setProducerActivity(sid, threadKey, active);
        view.rerender(<MessageFeed sessionId={sid} threadKey={threadKey} />);
        await waitFor(() => expect(Boolean(screen.queryByText("Active here"))).toBe(active));
        expect(geometry.scrollTop).toBe(readingTop);
        expect(anchorElement.getBoundingClientRect().top).toBe(0);
        requestThreadViewportSnapshot(sid);
        expect(readLeaderViewportPosition(sid, threadKey)?.anchorMessageId).toBe(anchor.id);
      }
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it.each([
    { label: "the activity row by itself", stacked: false, needsInput: false },
    { label: "stacked recovery and retry rows", stacked: true, needsInput: true },
  ])("keeps a physical-bottom viewport stable with $label", async ({ stacked, needsInput }) => {
    // This models native scrollTop clamping: without a retained activity slot, idle would
    // shrink the trailing spacer by one row (and one real flex gap in the stacked case).
    const sid = `activity-physical-bottom-${stacked ? "stacked" : "single"}`;
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid, stacked ? stackedStatusSessionState() : {});
    if (needsInput) setNeedsInputNotification(sid);
    setProducerActivity(sid, "main", true);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      if (stacked) {
        expect(screen.getByTestId("codex-turn-recovery-chip")).toBeTruthy();
        expect(screen.getByTestId("codex-provider-retry-chip")).toBeTruthy();
      }
      if (needsInput)
        expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeTruthy();
      await waitFor(() => expect(geometry.slack).toBeGreaterThan(12));
      geometry.setPhysicalBottom();
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      fireEvent.scroll(scrollContainer);
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const baseline = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorOffset: lastElement.getBoundingClientRect().top,
        slack: geometry.slack,
      };

      for (const active of [false, true, false, true]) {
        setProducerActivity(sid, "main", active);
        view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
        await waitFor(() => expect(Boolean(screen.queryByText("Active here"))).toBe(active));
        expect(geometry.scrollHeight).toBe(baseline.scrollHeight);
        expect(geometry.scrollTop).toBe(baseline.scrollTop);
        expect(lastElement.getBoundingClientRect().top).toBe(baseline.anchorOffset);
        expect(geometry.slack).toBe(baseline.slack);
      }
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps activity changes neutral while late content settlement follows the real bottom", async () => {
    // A content-root ResizeObserver is the downstream path that can amplify a native clamp.
    // Growing the final producer-shaped message is intentional follow-latest movement; hiding
    // activity in the same settlement must not add another status-height delta.
    const sid = "activity-late-settlement";
    const selected = setProducerWindow(sid, "main");
    setConnectedLeaderSession(sid, stackedStatusSessionState());
    setProducerActivity(sid, "main", true);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      geometry.setRealContentBottom();
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      fireEvent.scroll(scrollContainer);
      const baselineSlack = geometry.slack;
      const baselineTop = geometry.scrollTop;

      geometry.growLastMessage(48);
      setProducerActivity(sid, "main", false);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Active here")).toBeNull());
      expect(geometry.slack).toBe(baselineSlack);

      const contentRoot = document.querySelector<HTMLElement>("[data-feed-end-slack]")!.parentElement!;
      await act(async () => {
        expect(resize.triggerElement(contentRoot)).toBeGreaterThan(0);
      });

      expect(geometry.scrollTop).toBe(baselineTop + 48);
      expect(geometry.contentBottom - geometry.scrollTop - scrollContainer.clientHeight).toBe(0);
      expect(geometry.slack).toBe(baselineSlack);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps the reserved runway out of idle mobile navigation clearance", async () => {
    // The invisible activity reservation belongs only to scroll geometry. Once the actual chip
    // hides, touch navigation returns to its base offset instead of staying artificially lifted.
    const sid = "activity-mobile-clearance";
    const selected = setProducerWindow(sid, "main");
    const anchor = selected.messages[4]!;
    mediaState.touchDevice = true;
    setConnectedLeaderSession(sid);
    setProducerActivity(sid, "main", true);
    persistLeaderViewportPosition(sid, "main", {
      scrollTop: 580,
      scrollHeight: 1_052,
      isAtBottom: false,
      anchorMessageId: anchor.id,
      anchorTurnId: anchor.id,
      anchorOffsetTop: 0,
      lastSeenContentBottom: 1_020,
    });
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 580);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      const navFabs = screen.getByTestId("message-feed-nav-fabs");
      await waitFor(() => expect(navFabs.style.bottom).toBe("43px"));
      const activeSlack = geometry.slack;

      setProducerActivity(sid, "main", false);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Active here")).toBeNull());

      await waitFor(() => expect(navFabs.style.bottom).toBe("12px"));
      expect(geometry.slack).toBe(activeSlack);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("removes centered empty-state clearance when only the hidden reservation remains", async () => {
    // FeedStatusPill is also used over centered empty/loading states. The retained row must
    // preserve scroll runway only; it must not leave an idle empty state visibly padded.
    const sid = "activity-centered-clearance";
    setConnectedLeaderSession(sid);
    setProducerActivity(sid, "main", true);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(
      [{ id: "geometry-only", role: "assistant", content: "", timestamp: 1 }],
      400,
      0,
    );

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      const centered = screen.getByTestId("message-feed-centered-state");
      await waitFor(() => expect(centered.style.paddingBottom).toBe("91px"));

      setProducerActivity(sid, "main", false);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Active here")).toBeNull());

      await waitFor(() => expect(centered.style.paddingBottom).toBe(""));
      expect(document.querySelector('[data-feed-activity-reservation="true"]')).toBeTruthy();
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it.each([
    { label: "real-content bottom", position: "real" as const },
    { label: "physical bottom", position: "physical" as const },
  ])("keeps the exact viewport stable when the in-flow thread status clears at the $label", async ({ position }) => {
    // The footer is real in-flow content, unlike the activity overlay. Once measured, removing
    // it transfers exactly that contribution into trailing slack so neither native clamping nor
    // the feed's real-bottom callbacks can move the visible message content.
    const sid = `thread-status-removal-${position}`;
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, makeThreadStatus("main", last.id));
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(27),
      );
      if (position === "physical") geometry.setPhysicalBottom();
      else geometry.setRealContentBottom();
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      fireEvent.scroll(scrollContainer);
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const before = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: lastElement.getBoundingClientRect().top,
        slack: geometry.slack,
      };
      expect(geometry.threadStatusFooterHeight).toBe(27);

      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());
      const slack = document.querySelector<HTMLElement>("[data-feed-end-slack]")!;

      expect(geometry.threadStatusFooterHeight).toBe(0);
      expect(Number(slack.dataset.feedThreadStatusCompensation)).toBe(27);
      expect(geometry.slack).toBe(before.slack + 27);
      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it.each([
    "main",
    "q-4091",
  ] as const)("keeps a manually chosen %s-thread anchor stable when the thread status clears", async (threadKey) => {
    const sid = `thread-status-manual-${threadKey}`;
    const selected = setProducerWindow(sid, threadKey);
    const anchor = selected.messages[4]!;
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, makeThreadStatus(threadKey, last.id));
    persistLeaderViewportPosition(sid, threadKey, {
      scrollTop: 580,
      scrollHeight: 1_079,
      isAtBottom: false,
      anchorMessageId: anchor.id,
      anchorTurnId: anchor.id,
      anchorOffsetTop: 0,
      lastSeenContentBottom: 1_047,
    });
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 580);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey={threadKey} />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(27),
      );
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      geometry.setScrollTop(580);
      fireEvent.scroll(scrollContainer);
      const anchorElement = document.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`)!;
      const before = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: anchorElement.getBoundingClientRect().top,
      };

      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey={threadKey} />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());

      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(anchorElement.getBoundingClientRect().top).toBe(before.anchorTop);
      requestThreadViewportSnapshot(sid);
      expect(readLeaderViewportPosition(sid, threadKey)?.anchorMessageId).toBe(anchor.id);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps thread-status removal separate from a simultaneous activity change", async () => {
    const sid = "thread-status-combined-stability";
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, makeThreadStatus("main", last.id));
    setProducerActivity(sid, "main", true);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      expect(screen.getByText("Thread Waiting")).toBeTruthy();
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(27),
      );
      geometry.setPhysicalBottom();
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const before = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: lastElement.getBoundingClientRect().top,
        slack: geometry.slack,
      };

      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());
      const slack = document.querySelector<HTMLElement>("[data-feed-end-slack]")!;

      expect(screen.getByText("Active here")).toBeTruthy();
      expect(Number(slack.dataset.feedOverlayRunwayHeight)).toBe(before.slack);
      expect(Number(slack.dataset.feedThreadStatusCompensation)).toBe(27);
      expect(geometry.slack).toBe(before.slack + 27);
      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop);

      setProducerActivity(sid, "main", false);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Active here")).toBeNull());

      expect(Number(slack.dataset.feedOverlayRunwayHeight)).toBe(before.slack);
      expect(Number(slack.dataset.feedThreadStatusCompensation)).toBe(27);
      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop);

      setProducerThreadStatus(
        sid,
        makeThreadStatus("main", last.id, {
          kind: "waiting",
          label: "Thread Waiting",
          summary: "new status after activity settles",
          updatedAt: 1_700_000_000_100,
        }),
      );
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() => expect(Number(slack.dataset.feedThreadStatusCompensation)).toBe(0));

      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("intentionally follows the first thread-status appearance at the real bottom", async () => {
    // A newly visible status is new in-flow content, so a user already following latest should
    // advance enough to reveal it. Only a later removal or shrink receives compensation.
    const sid = "thread-status-first-appearance";
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, null);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      geometry.setRealContentBottom();
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      fireEvent.scroll(scrollContainer);
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const before = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: lastElement.getBoundingClientRect().top,
      };

      setProducerThreadStatus(sid, makeThreadStatus("main", last.id));
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());

      expect(geometry.scrollHeight).toBe(before.scrollHeight + 27);
      expect(geometry.scrollTop).toBe(before.scrollTop + 27);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop - 27);
      expect(
        Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
      ).toBe(0);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps a physical-bottom anchor stable when a wrapping thread status becomes shorter", async () => {
    // The production measurement is dynamic rather than a fixed 27px assumption. This models a
    // wrapped mobile status becoming a compact desktop-sized status without shrinking the range.
    const sid = "thread-status-variable-height";
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(
      sid,
      makeThreadStatus("main", last.id, {
        summary: "A longer status summary that wraps onto additional lines in a narrow viewport",
      }),
    );
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);
    geometry.setThreadStatusFooterHeight(55);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(55),
      );
      geometry.setPhysicalBottom();
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const before = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: lastElement.getBoundingClientRect().top,
      };

      geometry.setThreadStatusFooterHeight(27);
      setProducerThreadStatus(
        sid,
        makeThreadStatus("main", last.id, {
          kind: "waiting",
          label: "Thread Waiting",
          summary: "short status",
          updatedAt: 1_700_000_000_100,
        }),
      );
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(28),
      );

      expect(geometry.scrollHeight).toBe(before.scrollHeight);
      expect(geometry.scrollTop).toBe(before.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(before.anchorTop);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("remeasures the same status after hidden-to-visible re-entry", async () => {
    const sid = "thread-status-reentry-height";
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    const status = makeThreadStatus("main", last.id, {
      summary: "the same status object is deliberately reused after being hidden",
    });
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, status);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);
    geometry.setThreadStatusFooterHeight(55);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(55),
      );
      geometry.setPhysicalBottom();
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;

      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());
      const hidden = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorTop: lastElement.getBoundingClientRect().top,
      };

      geometry.setThreadStatusFooterHeight(27);
      setProducerThreadStatus(sid, status);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(28),
      );

      expect(geometry.scrollHeight).toBe(hidden.scrollHeight);
      expect(geometry.scrollTop).toBe(hidden.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(hidden.anchorTop);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps status high-water isolated per Main and quest viewport scope", async () => {
    const sid = "thread-status-scope-isolation";
    const main = setProducerWindow(sid, "main");
    const last = main.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, makeThreadStatus("main", last.id));
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(main.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      geometry.setScrollTop(400);
      fireEvent.scroll(scrollContainer);
      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(27),
      );

      setProducerWindow(sid, "q-4091");
      view.rerender(<MessageFeed sessionId={sid} threadKey="q-4091" />);
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(0),
      );

      setProducerWindow(sid, "main");
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(27),
      );
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("invalidates a still-visible Main status measurement after visiting another thread", async () => {
    const sid = "thread-status-scope-reentry";
    const main = setProducerWindow(sid, "main");
    const last = main.messages.at(-1)!;
    const status = makeThreadStatus("main", last.id, {
      summary: "the same projected status remains authoritative while another thread is selected",
    });
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, status);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(main.messages, 400, 0);
    geometry.setThreadStatusFooterHeight(55);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight),
        ).toBe(55),
      );
      const scrollContainer = screen.getByTestId("message-feed-scroll-container");
      geometry.setScrollTop(400);
      fireEvent.wheel(scrollContainer, { deltaY: -40 });
      fireEvent.scroll(scrollContainer);
      requestThreadViewportSnapshot(sid);
      const saved = readLeaderViewportPosition(sid, "main")!;
      expect(saved.isAtBottom).toBe(false);
      expect(saved.anchorMessageId).toBeTruthy();
      const beforeScrollHeight = geometry.scrollHeight;

      setProducerWindow(sid, "q-4091");
      view.rerender(<MessageFeed sessionId={sid} threadKey="q-4091" />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());

      geometry.setThreadStatusFooterHeight(27);
      setProducerWindow(sid, "main");
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      await waitFor(() =>
        expect(
          Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusCompensation),
        ).toBe(28),
      );

      expect(geometry.scrollHeight).toBe(beforeScrollHeight);
      expect(Number(document.querySelector<HTMLElement>("[data-feed-end-slack]")?.dataset.feedThreadStatusHeight)).toBe(
        27,
      );
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("refreshes latest-content bookkeeping after compensated status removal", async () => {
    const sid = "thread-status-latest-bookkeeping";
    const selected = setProducerWindow(sid, "main");
    const anchor = selected.messages[4]!;
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setProducerThreadStatus(sid, makeThreadStatus("main", last.id));
    persistLeaderViewportPosition(sid, "main", {
      scrollTop: 400,
      scrollHeight: 1_079,
      isAtBottom: false,
      anchorMessageId: anchor.id,
      anchorTurnId: anchor.id,
      anchorOffsetTop: 180,
      lastSeenContentBottom: 1_047,
    });
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 400);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Thread Waiting")).toBeTruthy());
      setProducerThreadStatus(sid, null);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Thread Waiting")).toBeNull());

      geometry.growLastMessage(20);
      const contentRoot = document.querySelector<HTMLElement>("[data-feed-content-root]")!;
      await act(async () => {
        expect(resize.triggerElement(contentRoot)).toBeGreaterThan(0);
      });

      await waitFor(() => expect(screen.getByText("New content below")).toBeTruthy());
      expect(geometry.scrollTop).toBe(400);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });

  it("keeps the screenshot-shaped right needs-input state stable as activity hides", async () => {
    // With one equal-height row on each side, max(left, right) already stays constant. This
    // negative control prevents overstating the single-row clamp as proof of the exact screenshot.
    const sid = "activity-screenshot-negative-control";
    const selected = setProducerWindow(sid, "main");
    const last = selected.messages.at(-1)!;
    setConnectedLeaderSession(sid);
    setNeedsInputNotification(sid);
    setProducerActivity(sid, "main", true);
    const resize = installControlledResizeObserver();
    const geometry = installActivityViewportGeometry(selected.messages, 400, 0);

    try {
      const view = render(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.getByText("Active here")).toBeTruthy());
      expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeTruthy();
      geometry.setPhysicalBottom();
      const lastElement = document.querySelector<HTMLElement>(`[data-message-id="${last.id}"]`)!;
      const baseline = {
        scrollHeight: geometry.scrollHeight,
        scrollTop: geometry.scrollTop,
        anchorOffset: lastElement.getBoundingClientRect().top,
      };

      setProducerActivity(sid, "main", false);
      view.rerender(<MessageFeed sessionId={sid} threadKey="main" />);
      await waitFor(() => expect(screen.queryByText("Active here")).toBeNull());

      expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeTruthy();
      expect(geometry.scrollHeight).toBe(baseline.scrollHeight);
      expect(geometry.scrollTop).toBe(baseline.scrollTop);
      expect(lastElement.getBoundingClientRect().top).toBe(baseline.anchorOffset);
    } finally {
      geometry.restore();
      resize.restore();
    }
  });
});
