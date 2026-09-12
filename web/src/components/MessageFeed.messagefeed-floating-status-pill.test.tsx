// @vitest-environment jsdom

// jsdom does not implement scrollIntoView; polyfill it before any React rendering
const mockScrollIntoView = vi.fn();
const mockScrollTo = vi.fn();
const mediaState = { touchDevice: false };

beforeAll(() => {
  Element.prototype.scrollIntoView = mockScrollIntoView;
  Element.prototype.scrollTo = mockScrollTo;
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

import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ChatMessage } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";

// Mock react-markdown to avoid ESM issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

// Build a mock for the store that returns configurable values per session
const mockStoreValues: Record<string, unknown> = {};
const mockToggleTurnActivity = vi.fn();
const mockFocusTurn = vi.fn();
const mockClearScrollToTurn = vi.fn();
const mockClearScrollToMessage = vi.fn();
const mockSetActiveTaskTurnId = vi.fn();
const mockKeepTurnExpanded = vi.fn();
const mockSetCollapsibleTurnIds = vi.fn();
const mockSetFeedScrollPosition = vi.fn();
const mockCollapseAllTurnActivity = vi.fn();
const mockClearBottomAlignOnNextUserMessage = vi.fn();
const mockSetComposerDraft = vi.fn();
const mockSendToSession: any = vi.fn(() => true);
const mockRelaunchSession = vi.fn().mockResolvedValue({});

vi.mock("../ws.js", () => ({
  sendToSession: (sessionId: string, msg: any) => mockSendToSession(sessionId, msg),
}));

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: (...args: unknown[]) => mockRelaunchSession(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      composerDrafts: mockStoreValues.composerDrafts ?? new Map(),
      messageFrozenCounts: mockStoreValues.messageFrozenCounts ?? new Map(),
      messageFrozenRevisions: mockStoreValues.messageFrozenRevisions ?? new Map(),
      historyLoading: mockStoreValues.historyLoading ?? new Map(),
      historyWindows: mockStoreValues.historyWindows ?? new Map(),
      streaming: mockStoreValues.streaming ?? new Map(),
      streamingByParentToolUseId: mockStoreValues.streamingByParentToolUseId ?? new Map(),
      streamingThinking: mockStoreValues.streamingThinking ?? new Map(),
      streamingThinkingByParentToolUseId: mockStoreValues.streamingThinkingByParentToolUseId ?? new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      streamingPausedDuration: mockStoreValues.streamingPausedDuration ?? new Map(),
      streamingPauseStartedAt: mockStoreValues.streamingPauseStartedAt ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      sessionStuck: mockStoreValues.sessionStuck ?? new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
      connectionStatus: mockStoreValues.connectionStatus ?? new Map(),
      cliConnected: mockStoreValues.cliConnected ?? new Map(),
      cliEverConnected: mockStoreValues.cliEverConnected ?? new Map(),
      cliDisconnectReason: mockStoreValues.cliDisconnectReason ?? new Map(),
      serverReachable: mockStoreValues.serverReachable ?? true,
      toolProgress: mockStoreValues.toolProgress ?? new Map(),
      toolResults: mockStoreValues.toolResults ?? new Map(),
      toolStartTimestamps: mockStoreValues.toolStartTimestamps ?? new Map(),
      sdkSessions: mockStoreValues.sdkSessions ?? [],
      feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
      turnActivityOverrides: mockStoreValues.turnActivityOverrides ?? new Map(),
      autoExpandedTurnIds: mockStoreValues.autoExpandedTurnIds ?? new Map(),
      toggleTurnActivity: mockToggleTurnActivity,
      scrollToTurnId: mockStoreValues.scrollToTurnId ?? new Map(),
      clearScrollToTurn: mockClearScrollToTurn,
      scrollToMessageId: mockStoreValues.scrollToMessageId ?? new Map(),
      clearScrollToMessage: mockClearScrollToMessage,
      expandAllInTurn: mockStoreValues.expandAllInTurn ?? new Map(),
      clearExpandAllInTurn: vi.fn(),
      bottomAlignNextUserMessage: mockStoreValues.bottomAlignNextUserMessage ?? new Set(),
      sessionTaskHistory: mockStoreValues.sessionTaskHistory ?? new Map(),
      pendingUserUploads: mockStoreValues.pendingUserUploads ?? new Map(),
      pendingCodexInputs: mockStoreValues.pendingCodexInputs ?? new Map(),
      activeTaskTurnId: mockStoreValues.activeTaskTurnId ?? new Map(),
      setActiveTaskTurnId: mockSetActiveTaskTurnId,
      backgroundAgentNotifs: mockStoreValues.backgroundAgentNotifs ?? new Map(),
      sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
      sessionAttentionRecords: mockStoreValues.sessionAttentionRecords ?? new Map(),
      sessionSearch: mockStoreValues.sessionSearch ?? new Map(),
    };
    return selector(state);
  };
  useStore.getState = () => ({
    feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
    setFeedScrollPosition: mockSetFeedScrollPosition,
    collapseAllTurnActivity: mockCollapseAllTurnActivity,
    setCollapsibleTurnIds: mockSetCollapsibleTurnIds,
    turnActivityOverrides: mockStoreValues.turnActivityOverrides ?? new Map(),
    autoExpandedTurnIds: mockStoreValues.autoExpandedTurnIds ?? new Map(),
    toggleTurnActivity: mockToggleTurnActivity,
    focusTurn: mockFocusTurn,
    keepTurnExpanded: mockKeepTurnExpanded,
    clearBottomAlignOnNextUserMessage: mockClearBottomAlignOnNextUserMessage,
    setComposerDraft: mockSetComposerDraft,
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: (state: Record<string, unknown>, _sessionId: string) => {
      return { query: "", isOpen: false, mode: "strict", category: "all", matches: [], currentMatchIndex: -1 };
    },
    sessionSearchMessageMatchesCategory: () => true,
  };
});

import {
  MessageFeed,
  ElapsedTimer,
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "./MessageFeed.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeFeedEntryMessage(msg: ChatMessage): FeedEntry {
  return { kind: "message", msg };
}

function makeTurnForSections({
  id,
  userEntry = null,
  systemEntries = [],
  agentEntries = [],
  responseEntry = null,
}: {
  id: string;
  userEntry?: FeedEntry | null;
  systemEntries?: FeedEntry[];
  agentEntries?: FeedEntry[];
  responseEntry?: FeedEntry | null;
}): Turn {
  return {
    id,
    userEntry,
    allEntries: [...systemEntries, ...agentEntries, ...(responseEntry ? [responseEntry] : [])],
    agentEntries,
    systemEntries,
    notificationEntries: [],
    responseEntry,
    subConclusions: [],
    stats: {
      messageCount: 0,
      toolCount: 0,
      subagentCount: 0,
      herdEventCount: 0,
    },
  };
}

function makeSectionTurns(totalTurns: number): Turn[] {
  return Array.from({ length: totalTurns }, (_, index) => {
    const turnNumber = index + 1;
    return makeTurnForSections({
      id: `turn-${turnNumber}`,
      userEntry: makeFeedEntryMessage(
        makeMessage({
          id: `u${turnNumber}`,
          role: "user",
          content: `Turn ${turnNumber}`,
        }),
      ),
    });
  });
}

function makeSectionedMessages(sectionCount: number, turnsPerSection = 50): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let timestamp = 1_700_000_000_000;

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
    for (let turnIndex = 0; turnIndex < turnsPerSection; turnIndex++) {
      const turnNumber = sectionIndex * turnsPerSection + turnIndex + 1;
      const label =
        turnIndex === 0 ? `Section ${sectionIndex + 1} marker` : `Section ${sectionIndex + 1} turn ${turnIndex + 1}`;
      messages.push(
        makeMessage({
          id: `u${turnNumber}`,
          role: "user",
          content: label,
          timestamp: timestamp++,
        }),
      );
    }
  }

  return messages;
}

function setStoreMessages(sessionId: string, msgs: ChatMessage[]) {
  const map = new Map();
  map.set(sessionId, msgs);
  mockStoreValues.messages = map;
}

function setStoreStreaming(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streaming = map;
}

function setStoreThinking(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streamingThinking = map;
}

function setStorePendingCodexInputs(sessionId: string, inputs: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, inputs);
  mockStoreValues.pendingCodexInputs = map;
}

function setStorePendingUserUploads(sessionId: string, uploads: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, uploads);
  mockStoreValues.pendingUserUploads = map;
}

function setStoreNotifications(sessionId: string, notifications: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, notifications);
  mockStoreValues.sessionNotifications = map;
}

function setStoreHistoryLoading(sessionId: string, loading: boolean) {
  const map = new Map();
  if (loading) map.set(sessionId, true);
  mockStoreValues.historyLoading = map;
}

function setStoreFeedScrollPosition(
  sessionId: string,
  pos: {
    scrollTop: number;
    scrollHeight: number;
    isAtBottom: boolean;
    anchorTurnId?: string | null;
    anchorOffsetTop?: number;
    lastSeenContentBottom?: number | null;
  },
) {
  const map = new Map();
  map.set(sessionId, pos);
  map.set(`${sessionId}:thread:main`, pos);
  mockStoreValues.feedScrollPosition = map;
}

function setStoreParentStreaming(sessionId: string, entries: Record<string, string>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(entries)));
  mockStoreValues.streamingByParentToolUseId = map;
}

function setStoreParentThinking(sessionId: string, entries: Record<string, string>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(entries)));
  mockStoreValues.streamingThinkingByParentToolUseId = map;
}

function setStoreStatus(sessionId: string, status: string | null) {
  const statusMap = new Map();
  if (status) statusMap.set(sessionId, status);
  mockStoreValues.sessionStatus = statusMap;
}

function setStoreSessionBackend(sessionId: string, backend: "claude" | "codex") {
  const map = new Map();
  map.set(sessionId, { backend_type: backend });
  mockStoreValues.sessions = map;
}

function setStoreSessionState(sessionId: string, session: Record<string, unknown>) {
  const map = new Map();
  map.set(sessionId, session);
  mockStoreValues.sessions = map;
}

function setStoreConnectionState(
  sessionId: string,
  {
    browser = "connected",
    cliConnected = false,
    cliEverConnected = true,
    cliDisconnectReason = null,
    serverReachable = true,
  }: {
    browser?: "connecting" | "connected" | "disconnected";
    cliConnected?: boolean;
    cliEverConnected?: boolean;
    cliDisconnectReason?: "idle_limit" | "broken" | "recovery_suppressed" | null;
    serverReachable?: boolean;
  } = {},
) {
  mockStoreValues.connectionStatus = new Map([[sessionId, browser]]);
  mockStoreValues.cliConnected = new Map([[sessionId, cliConnected]]);
  mockStoreValues.cliEverConnected = cliEverConnected ? new Map([[sessionId, true]]) : new Map();
  mockStoreValues.cliDisconnectReason = new Map([[sessionId, cliDisconnectReason]]);
  mockStoreValues.serverReachable = serverReachable;
}

function setStoreStreamingStartedAt(sessionId: string, startedAt: number | undefined) {
  const map = new Map();
  if (startedAt !== undefined) map.set(sessionId, startedAt);
  mockStoreValues.streamingStartedAt = map;
}

function setStoreStreamingOutputTokens(sessionId: string, tokens: number | undefined) {
  const map = new Map();
  if (tokens !== undefined) map.set(sessionId, tokens);
  mockStoreValues.streamingOutputTokens = map;
}

function setStoreToolProgress(
  sessionId: string,
  entries: Array<{ toolUseId: string; toolName: string; elapsedSeconds: number; output?: string }>,
) {
  const toolProgressMap = new Map();
  const sessionProgress = new Map();
  for (const entry of entries) {
    sessionProgress.set(entry.toolUseId, {
      toolName: entry.toolName,
      elapsedSeconds: entry.elapsedSeconds,
      ...(entry.output ? { output: entry.output } : {}),
    });
  }
  toolProgressMap.set(sessionId, sessionProgress);
  mockStoreValues.toolProgress = toolProgressMap;
}

function setStoreToolStartTimestamps(sessionId: string, timestamps: Record<string, number>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(timestamps)));
  mockStoreValues.toolStartTimestamps = map;
}

function setStoreToolResults(
  sessionId: string,
  results: Record<string, { content: string; is_truncated: boolean; duration_seconds?: number; is_error?: boolean }>,
) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(results)));
  mockStoreValues.toolResults = map;
}

function setStoreSdkSessionRole(sessionId: string, overrides: { isOrchestrator?: boolean; herdedBy?: string } = {}) {
  mockStoreValues.sdkSessions = [
    {
      sessionId,
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      ...(overrides.isOrchestrator ? { isOrchestrator: true } : {}),
      ...(overrides.herdedBy ? { herdedBy: overrides.herdedBy } : {}),
    },
  ];
}

function setStoreScrollToTurn(sessionId: string, turnId: string) {
  const map = new Map();
  map.set(sessionId, turnId);
  mockStoreValues.scrollToTurnId = map;
}

function setStoreScrollToMessage(sessionId: string, messageId: string) {
  const map = new Map();
  map.set(sessionId, messageId);
  mockStoreValues.scrollToMessageId = map;
}

function setStoreBottomAlignNextUserMessage(sessionId: string, enabled = true) {
  const set = new Set<string>();
  if (enabled) set.add(sessionId);
  mockStoreValues.bottomAlignNextUserMessage = set;
}

function resetStore() {
  mockToggleTurnActivity.mockReset();
  mockFocusTurn.mockReset();
  mockClearScrollToTurn.mockReset();
  mockClearScrollToMessage.mockReset();
  mockSetActiveTaskTurnId.mockReset();
  mockKeepTurnExpanded.mockReset();
  mockSetCollapsibleTurnIds.mockReset();
  mockSetFeedScrollPosition.mockReset();
  mockCollapseAllTurnActivity.mockReset();
  mockClearBottomAlignOnNextUserMessage.mockReset();
  mockSetComposerDraft.mockReset();
  mockSendToSession.mockReset();
  mockSendToSession.mockReturnValue(true);
  mockRelaunchSession.mockReset();
  mockRelaunchSession.mockResolvedValue({});
  mockStoreValues.messages = new Map();
  mockStoreValues.messageFrozenCounts = new Map();
  mockStoreValues.messageFrozenRevisions = new Map();
  mockStoreValues.historyWindows = new Map();
  mockStoreValues.streaming = new Map();
  mockStoreValues.streamingByParentToolUseId = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.streamingPausedDuration = new Map();
  mockStoreValues.streamingPauseStartedAt = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.connectionStatus = new Map();
  mockStoreValues.cliConnected = new Map();
  mockStoreValues.cliEverConnected = new Map();
  mockStoreValues.cliDisconnectReason = new Map();
  mockStoreValues.serverReachable = true;
  mockStoreValues.toolProgress = new Map();
  mockStoreValues.toolResults = new Map();
  mockStoreValues.toolStartTimestamps = new Map();
  mockStoreValues.turnActivityOverrides = new Map();
  mockStoreValues.autoExpandedTurnIds = new Map();
  mockStoreValues.backgroundAgentNotifs = new Map();
  mockStoreValues.scrollToTurnId = new Map();
  mockStoreValues.scrollToMessageId = new Map();
  mockStoreValues.expandAllInTurn = new Map();
  mockStoreValues.bottomAlignNextUserMessage = new Set();
  mockStoreValues.sessionTaskHistory = new Map();
  mockStoreValues.pendingCodexInputs = new Map();
  mockStoreValues.activeTaskTurnId = new Map();
  mockStoreValues.sdkSessions = [];
}

/** Set explicit overrides for turn activity expansion per session.
 *  Each entry: [turnId, expanded: boolean]. */
function setStoreTurnOverrides(sessionId: string, overrides: [string, boolean][]) {
  const map = new Map();
  map.set(sessionId, new Map(overrides));
  mockStoreValues.turnActivityOverrides = map;
}

function setStoreAutoExpandedTurns(sessionId: string, turnIds: string[]) {
  const map = new Map();
  map.set(sessionId, new Set(turnIds));
  mockStoreValues.autoExpandedTurnIds = map;
}

async function flushFeedObservers() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setElementOffsetMetrics(element: HTMLElement, offsetTop: number, offsetHeight: number) {
  Object.defineProperty(element, "offsetTop", {
    configurable: true,
    get() {
      return offsetTop;
    },
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    get() {
      return offsetHeight;
    },
  });
}

function setElementClientSize(element: HTMLElement, width: number, height: number) {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get() {
      return width;
    },
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get() {
      return height;
    },
  });
}

beforeEach(() => {
  resetStore();
  mockScrollIntoView.mockClear();
  mockScrollTo.mockClear();
  mediaState.touchDevice = false;
});

function makeDomRect(height: number, width = 0): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("MessageFeed - floating status pill", () => {
  it("renders the compact lower-left running indicator inside the feed", () => {
    const sid = "test-feed-status-pill";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Still working" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.getByText("10s")).toBeTruthy();
    expect(screen.getByText(/2\.5k/)).toBeTruthy();
  });

  it("renders a recoverable disconnected chip with click/tap detail and manual resume", () => {
    const sid = "test-feed-disconnected-chip";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Idle session" })]);
    setStoreSessionState(sid, { backend_state: "connected" });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("live-connection-status-banner")).toBeNull();
    const chip = screen.getByTestId("recoverable-connection-chip");
    expect(chip).toHaveTextContent("Disconnected");

    fireEvent.click(chip);

    expect(screen.getByTestId("recoverable-connection-detail")).toHaveTextContent(
      "This session is offline. You can keep typing; Takode will reconnect when there is something to send.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }));
    expect(mockRelaunchSession).toHaveBeenCalledWith(sid);
  });

  it("renders the recoverable disconnected chip over an empty feed state", () => {
    const sid = "test-feed-empty-disconnected-chip";
    setStoreSessionState(sid, { backend_state: "connected" });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Start a conversation")).toBeTruthy();
    const chip = screen.getByTestId("recoverable-connection-chip");
    expect(chip).toHaveTextContent("Disconnected");
  });

  it("reserves empty-state clearance for the lower-left recoverable chip", () => {
    const sid = "test-feed-empty-disconnected-chip-clearance";
    setStoreSessionState(sid, { backend_state: "connected" });
    setStoreConnectionState(sid);

    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "feed-status-pill-left") {
          return makeDomRect(27, 116);
        }
        return makeDomRect(0, 0);
      });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("message-feed-centered-state").style.paddingBottom).toBe("91px");
    expect(screen.getByTestId("recoverable-connection-chip")).toHaveTextContent("Disconnected");

    getBoundingClientRectSpy.mockRestore();
  });

  it("renders the recoverable reconnecting chip over a loading feed state", () => {
    const sid = "test-feed-loading-reconnecting-chip";
    setStoreHistoryLoading(sid, true);
    setStoreSessionState(sid, { backend_state: "recovering" });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Loading conversation...")).toBeTruthy();
    const chip = screen.getByTestId("recoverable-connection-chip");
    expect(chip).toHaveTextContent("Reconnecting");
  });

  it("opens recoverable connection detail on hover for pointer users", () => {
    const sid = "test-feed-disconnected-hover-chip";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Idle session" })]);
    setStoreSessionState(sid, { backend_state: "connected" });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    const chip = screen.getByTestId("recoverable-connection-chip");
    fireEvent.mouseEnter(chip.parentElement ?? chip);

    expect(screen.getByTestId("recoverable-connection-detail")).toHaveTextContent(
      "This session is offline. You can keep typing; Takode will reconnect when there is something to send.",
    );

    fireEvent.mouseLeave(chip.parentElement ?? chip);
    expect(screen.queryByTestId("recoverable-connection-detail")).toBeNull();
  });

  it("renders reconnecting as the same unobtrusive feed affordance", () => {
    const sid = "test-feed-reconnecting-chip";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Recovering session" })]);
    setStoreSessionState(sid, {
      backend_state: "recovering",
      backend_reconnect: { attempt: 2, maxAttempts: 5, cycleStartedAt: 100 },
    });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    const chip = screen.getByTestId("recoverable-connection-chip");
    expect(chip).toHaveTextContent("Reconnecting (2 of 5)");
    fireEvent.click(chip);
    expect(screen.getByTestId("recoverable-connection-detail")).toHaveTextContent(
      "Takode is reconnecting this session, attempt 2 of 5. You can keep typing; messages will send when it reconnects.",
    );
  });

  it("shows exact-owner interrupted work recovery separately from backend reconnect", () => {
    const sid = "test-feed-turn-recovery";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Partial tool work" })]);
    setStoreSessionState(sid, {
      backend_state: "recovering",
      backend_reconnect: { attempt: 1, maxAttempts: 5, cycleStartedAt: 100 },
      codex_turn_recovery: {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
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
    });
    setStoreConnectionState(sid);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("codex-turn-recovery-chip")).toHaveTextContent("Reconnecting interrupted work");
    expect(screen.getByTestId("recoverable-connection-chip")).toHaveTextContent("Reconnecting (1 of 5)");
  });

  it("labels a proven-absent one-shot replay separately from reconnect and continuation", () => {
    const sid = "test-feed-turn-replay";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Recovery evidence ready" })]);
    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
        originalProviderTurnId: "turn-original",
        originalHistoryIndex: 7,
        continuationOwnerId: null,
        threadKey: "main",
        status: "recovering",
        reason: "adapter_disconnect",
        historyPresence: "absent",
        continuationMode: null,
        attempt: 0,
        maxAttempts: 1,
        createdAt: 100,
        updatedAt: 110,
      },
    });
    setStoreConnectionState(sid, { cliConnected: true });

    render(<MessageFeed sessionId={sid} />);
    const chip = screen.getByTestId("codex-turn-recovery-chip");
    expect(chip).toHaveTextContent("Retrying interrupted input");
    fireEvent.click(chip);
    expect(screen.getByTestId("codex-turn-recovery-detail")).toHaveTextContent(
      "proved the original input never entered Codex history and is replaying it once",
    );
  });

  it("explains that a separate queued continuation will not replay the original request", () => {
    const sid = "test-feed-turn-continuation";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Partial tool work" })]);
    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
        originalProviderTurnId: "turn-original",
        originalHistoryIndex: 7,
        continuationOwnerId: "continuation-owner",
        threadKey: "q-1987",
        questId: "q-1987",
        status: "continuation_pending",
        reason: "interrupted_after_activity",
        continuationMode: "verify_then_continue",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 100,
        updatedAt: 110,
      },
    });
    setStoreConnectionState(sid, { cliConnected: true });
    const onSelectThread = vi.fn();

    render(<MessageFeed sessionId={sid} threadKey="main" onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByTestId("codex-turn-recovery-chip"));

    expect(screen.getByTestId("codex-turn-recovery-detail")).toHaveTextContent(
      "queued one follow-up to inspect prior work before finishing what is missing. The original input will not be replayed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open affected thread" }));
    expect(onSelectThread).toHaveBeenCalledWith("q-1987");
  });

  it.each(["main", "q-1987"])("hides terminal interrupted-work attention in the %s feed", (threadKey) => {
    const sid = `test-feed-turn-action-required-${threadKey}`;
    setStoreMessages(sid, [makeMessage({ role: "user", content: "Later unrelated input" })]);
    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
        originalProviderTurnId: "turn-original",
        originalHistoryIndex: 7,
        continuationOwnerId: "continuation-owner",
        threadKey,
        ...(threadKey !== "main" ? { questId: threadKey } : {}),
        status: "action_required",
        reason: "continuation_interrupted",
        attempt: 1,
        maxAttempts: 1,
        createdAt: 100,
        updatedAt: 110,
      },
    });
    setStoreConnectionState(sid, { cliConnected: true });

    render(<MessageFeed sessionId={sid} threadKey={threadKey} />);

    expect(screen.queryByTestId("codex-turn-recovery-chip")).toBeNull();
    expect(screen.queryByTestId("codex-turn-recovery-detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open affected thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Work is complete" })).toBeNull();
    expect((mockStoreValues.sessions as Map<string, any>).get(sid)?.codex_turn_recovery).toMatchObject({
      recoveryId: "original-owner",
      status: "action_required",
      threadKey,
    });
  });

  it.each([
    ["continuation_dispatch_failed", "could not start the follow-up"],
    ["continuation_failed", "follow-up ended with an error"],
    ["recovery_timeout", "could not reconnect in time"],
    ["adapter_disconnect", "stopped when the session disconnected"],
    ["interrupted_after_activity", "stopped after some actions had already run"],
    ["recovery_failed", "could not finish reconnecting"],
  ] as const)("hides the retired attention surface for %s", (reason, expectedReason) => {
    const sid = `test-feed-turn-action-${reason}`;
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Partial tool work" })]);
    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: {
        recoveryId: "original-owner",
        originalOwnerId: "original-owner",
        originalProviderTurnId: "turn-original",
        originalHistoryIndex: 7,
        continuationOwnerId: "continuation-owner",
        threadKey: "q-1987",
        questId: "q-1987",
        status: "action_required",
        reason,
        attempt: 1,
        maxAttempts: 1,
        createdAt: 100,
        updatedAt: 110,
      },
    });
    setStoreConnectionState(sid, { cliConnected: true });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("codex-turn-recovery-chip")).toBeNull();
    expect(screen.queryByText(expectedReason)).toBeNull();
    expect(screen.queryByText("Check interrupted work")).toBeNull();
    expect(screen.queryByRole("button", { name: "Work is complete" })).toBeNull();
  });

  it("keeps the remaining interrupted-work progress detail inside a short viewport", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 140 });

    try {
      const sid = "test-feed-turn-recovery-short-viewport";
      setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Partial tool work" })]);
      setStoreSessionState(sid, {
        backend_state: "connected",
        codex_turn_recovery: {
          recoveryId: "original-owner",
          originalOwnerId: "original-owner",
          originalProviderTurnId: "turn-original",
          originalHistoryIndex: 7,
          continuationOwnerId: "continuation-owner",
          threadKey: "main",
          status: "continuation_pending",
          reason: "interrupted_after_activity",
          continuationMode: "verify_then_continue",
          attempt: 1,
          maxAttempts: 1,
          createdAt: 100,
          updatedAt: 110,
        },
      });
      setStoreConnectionState(sid, { cliConnected: true });

      render(<MessageFeed sessionId={sid} />);
      const chip = screen.getByTestId("codex-turn-recovery-chip");
      vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({
        x: 220,
        y: 4,
        top: 4,
        left: 220,
        bottom: 32,
        right: 260,
        width: 40,
        height: 28,
        toJSON: () => ({}),
      } as DOMRect);
      fireEvent.click(chip);

      const detail = screen.getByTestId("codex-turn-recovery-detail");
      expect(detail.parentElement).toBe(document.body);
      expect(detail).toHaveClass("fixed", "overflow-y-auto");
      expect(detail).toHaveStyle({
        left: "8px",
        top: "8px",
        width: "224px",
        maxHeight: "124px",
        visibility: "visible",
      });
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("removes recovery progress without announcing attention when the state becomes action required", () => {
    const sid = "test-feed-turn-recovery-live-announcement";
    const continuationRecovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 7,
      continuationOwnerId: "continuation-owner",
      threadKey: "main",
      status: "continuation_active",
      reason: "interrupted_after_activity",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 100,
      updatedAt: 110,
    };
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Partial tool work" })]);
    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: continuationRecovery,
    });
    setStoreConnectionState(sid, { cliConnected: true });

    const { rerender } = render(<MessageFeed sessionId={sid} />);
    expect(screen.getByTestId("codex-turn-recovery-chip")).toHaveTextContent("Checking interrupted work");

    setStoreSessionState(sid, {
      backend_state: "connected",
      codex_turn_recovery: {
        ...continuationRecovery,
        status: "action_required",
        reason: "continuation_interrupted",
        updatedAt: 120,
      },
    });
    rerender(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("codex-turn-recovery-chip")).toBeNull();
    expect(screen.queryByTestId("codex-turn-recovery-announcement")).toBeNull();
    expect(screen.queryByTestId("codex-turn-recovery-detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Work is complete" })).toBeNull();
  });

  it("shows confirmed Codex stream retries in the generation chip and restores normal activity", () => {
    // This is the session_update shape emitted for an exact root-turn willRetry
    // notification. Quiet generation alone must never manufacture retry state.
    const sid = "test-feed-stream-retry";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Working" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 180_000);
    setStoreSessionState(sid, { backend_type: "codex", backend_state: "connected" });
    setStoreConnectionState(sid, { cliConnected: true });
    const { rerender } = render(<MessageFeed sessionId={sid} />);
    expect(screen.getByText("Purring...")).toBeInTheDocument();
    expect(screen.queryByText("Retrying response...")).toBeNull();

    setStoreSessionState(sid, { codex_stream_retry: { turnId: "turn-1" } });
    rerender(<MessageFeed sessionId={sid} />);
    expect(screen.getByText("Retrying response...")).toHaveAttribute(
      "title",
      expect.stringContaining("attempt count is unavailable"),
    );
    expect(screen.queryByText("Purring...")).toBeNull();
    expect(screen.queryByTestId("codex-provider-retry-chip")).toBeNull();

    setStoreSessionState(sid, { codex_stream_retry: null });
    rerender(<MessageFeed sessionId={sid} />);
    expect(screen.getByText("Purring...")).toBeInTheDocument();
    expect(screen.queryByText("Retrying response...")).toBeNull();

    // The activity chip remains owned by this session's running lifecycle.
    setStoreStatus(sid, "idle");
    rerender(<MessageFeed sessionId={sid} />);
    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("shows message retry separately from session reconnect progress in plain language", () => {
    const sid = "test-feed-provider-retry-chip";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Retrying safely" })]);
    setStoreSessionState(sid, {
      backend_state: "recovering",
      backend_reconnect: { attempt: 2, maxAttempts: 5, cycleStartedAt: 100 },
      codex_provider_retry: {
        family: "model_backend_stream_error",
        ownerId: "input-1",
        attempt: 4,
        maxAttempts: null,
        startedAt: 100,
      },
    });
    setStoreConnectionState(sid);

    const { rerender } = render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("codex-provider-retry-chip")).toHaveTextContent("Retrying message (attempt 4)");
    expect(screen.getByTestId("recoverable-connection-chip")).toHaveTextContent("Reconnecting (2 of 5)");
    fireEvent.click(screen.getByTestId("codex-provider-retry-chip"));
    expect(screen.getByTestId("codex-provider-retry-detail")).toHaveTextContent(
      "retrying this message about every 30 seconds. Attempt 4 is underway",
    );

    setStoreSessionState(sid, {
      backend_state: "connected",
      backend_reconnect: null,
      codex_provider_retry: null,
    });
    setStoreConnectionState(sid, { cliConnected: true });
    rerender(<MessageFeed sessionId={sid} />);
    expect(screen.queryByTestId("codex-provider-retry-chip")).toBeNull();
    expect(screen.queryByTestId("recoverable-connection-chip")).toBeNull();
  });

  it("keeps the message-retry detail inside a short viewport", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });

    try {
      const sid = "test-feed-provider-retry-short-viewport";
      setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Retrying" })]);
      setStoreSessionState(sid, {
        backend_state: "recovering",
        codex_provider_retry: {
          family: "model_backend_stream_error",
          ownerId: "input-1",
          attempt: 12,
          maxAttempts: null,
          startedAt: 100,
        },
      });
      setStoreConnectionState(sid);

      render(<MessageFeed sessionId={sid} />);
      const chip = screen.getByTestId("codex-provider-retry-chip");
      vi.spyOn(chip, "getBoundingClientRect").mockReturnValue({
        x: 220,
        y: 4,
        top: 4,
        left: 220,
        bottom: 32,
        right: 260,
        width: 40,
        height: 28,
        toJSON: () => ({}),
      } as DOMRect);
      fireEvent.click(chip);

      const detail = screen.getByTestId("codex-provider-retry-detail");
      expect(detail.parentElement).toBe(document.body);
      expect(detail).toHaveClass("fixed", "overflow-y-auto");
      expect(detail).toHaveStyle({
        left: "8px",
        top: "8px",
        width: "224px",
        maxHeight: "84px",
        visibility: "visible",
      });
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("does not render the recoverable chip for unrecoverable broken sessions", () => {
    const sid = "test-feed-broken-no-chip";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Broken session" })]);
    setStoreSessionState(sid, { backend_state: "broken" });
    setStoreConnectionState(sid, { cliDisconnectReason: "broken" });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("recoverable-connection-chip")).toBeNull();
  });

  it("shows all four mobile nav buttons with touch spacing and lifts them above the floating notification chip stack", () => {
    const sid = "test-feed-mobile-nav-clearance";
    mediaState.touchDevice = true;
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Scroll target" })]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 120,
      scrollHeight: 600,
      isAtBottom: false,
    });
    setStoreNotifications(sid, [
      {
        id: "notif-1",
        category: "needs-input",
        summary: "Quest q-464 needs input",
        timestamp: Date.now(),
        messageId: "msg-anchor",
        done: false,
      },
    ]);

    // q-464: the mobile nav stack should reserve clearance above the measured
    // lower-right floating-status chips. Stub that stack's rect directly so the
    // test validates the offset math without depending on jsdom layout.
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "feed-status-pill-right") {
          return makeDomRect(26, 144);
        }
        return makeDomRect(0, 0);
      });

    render(<MessageFeed sessionId={sid} />);

    const navFabs = screen.getByTestId("message-feed-nav-fabs");
    const topButton = within(navFabs).getByLabelText("Go to top");
    const previousButton = within(navFabs).getByLabelText("Previous user message");
    const nextButton = within(navFabs).getByLabelText("Next user message");
    const bottomButton = within(navFabs).getByLabelText("Go to bottom");

    expect(topButton).toBeTruthy();
    expect(previousButton).toBeTruthy();
    expect(nextButton).toBeTruthy();
    expect(bottomButton).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeTruthy();
    expect(navFabs.style.bottom).toBe("42px");
    expect(navFabs.className).toContain("gap-2");
    expect(navFabs.className).toContain("items-center");
    expect(topButton.className).toContain("h-10");
    expect(topButton.className).toContain("w-10");
    expect(previousButton.className).toContain("h-10");
    expect(nextButton.className).toContain("w-10");
    expect(bottomButton.className).toContain("h-10");

    getBoundingClientRectSpy.mockRestore();
  });

  it("excludes leader kickoff injected events from previous and next user-message navigation targets", () => {
    const sid = "test-feed-injected-event-navigation";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First real user turn", timestamp: 1000 }),
      makeMessage({
        id: "kickoff",
        role: "user",
        content: "[System] You are a leader session. Historical kickoff without source metadata.",
        timestamp: 1001,
      }),
      makeMessage({ id: "u2", role: "user", content: "Second real user turn", timestamp: 1002 }),
    ]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 120,
      scrollHeight: 600,
      isAtBottom: false,
    });

    const { container } = render(<MessageFeed sessionId={sid} />);

    expect(container.querySelectorAll("[data-user-turn]")).toHaveLength(2);
  });
});
