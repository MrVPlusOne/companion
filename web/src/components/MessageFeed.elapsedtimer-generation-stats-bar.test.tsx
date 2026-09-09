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
import type { BrowserIncomingMessage, ChatMessage } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import { normalizeCodexReasoningDetailMessage } from "../utils/history-message-normalization.js";

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

vi.mock("../ws.js", () => ({
  sendToSession: (sessionId: string, msg: any) => mockSendToSession(sessionId, msg),
}));

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      messageFrozenCounts: mockStoreValues.messageFrozenCounts ?? new Map(),
      messageFrozenRevisions: mockStoreValues.messageFrozenRevisions ?? new Map(),
      historyLoading: mockStoreValues.historyLoading ?? new Map(),
      historyWindows: mockStoreValues.historyWindows ?? new Map(),
      streaming: mockStoreValues.streaming ?? new Map(),
      streamingByParentToolUseId: mockStoreValues.streamingByParentToolUseId ?? new Map(),
      streamingThinking: mockStoreValues.streamingThinking ?? new Map(),
      streamingThinkingByParentToolUseId: mockStoreValues.streamingThinkingByParentToolUseId ?? new Map(),
      codexReasoningPreviews: mockStoreValues.codexReasoningPreviews ?? new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      streamingPausedDuration: mockStoreValues.streamingPausedDuration ?? new Map(),
      streamingPauseStartedAt: mockStoreValues.streamingPauseStartedAt ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      activeTurnRoutes: mockStoreValues.activeTurnRoutes ?? new Map(),
      sessionStuck: mockStoreValues.sessionStuck ?? new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
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
      sessionBoards: mockStoreValues.sessionBoards ?? new Map(),
      sessionBoardRowStatuses: mockStoreValues.sessionBoardRowStatuses ?? new Map(),
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
import { FeedEntries, FeedFooter } from "./MessageFeedEntries.js";
import { formatActiveReasoningStatusText } from "./MessageFeedStatus.js";
import { MessageBubble } from "./MessageBubble.js";

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

function setStoreActiveTurnRoute(sessionId: string, route: { threadKey: string; questId?: string } | null) {
  const routeMap = new Map();
  routeMap.set(sessionId, route);
  mockStoreValues.activeTurnRoutes = routeMap;
}

function setStoreActiveCodexReasoningPreview(
  sessionId: string,
  preview: { text: string; updatedAt: number; threadKey?: string; questId?: string; truncated?: boolean } | null,
) {
  setStoreCodexReasoningPreviews(sessionId, preview ? [preview] : []);
}

function setStoreCodexReasoningPreviews(
  sessionId: string,
  previews: Array<{ text: string; updatedAt: number; threadKey?: string; questId?: string; truncated?: boolean }>,
) {
  const previewMap = new Map();
  const threadPreviews = new Map();
  for (const preview of previews) {
    const threadKey = preview.threadKey ?? preview.questId;
    if (threadKey) threadPreviews.set(threadKey, preview);
  }
  if (threadPreviews.size > 0) previewMap.set(sessionId, threadPreviews);
  mockStoreValues.codexReasoningPreviews = previewMap;
}

function setStoreBoardProjection(sessionId: string, board: unknown[], rowSessionStatuses: Record<string, unknown>) {
  mockStoreValues.sessionBoards = new Map([[sessionId, board]]);
  mockStoreValues.sessionBoardRowStatuses = new Map([[sessionId, rowSessionStatuses]]);
}

function setStoreSessionBackend(sessionId: string, backend: "claude" | "codex") {
  const map = new Map();
  map.set(sessionId, { backend_type: backend });
  mockStoreValues.sessions = map;
}

function reasoningDetailMessage(
  id: string,
  content: string,
  status: "streaming" | "complete" = "complete",
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp: 1,
    metadata: { codexReasoningDetail: { status } },
  };
}

function producerReasoningDetail(
  id: string,
  content: string,
  options: {
    status?: "streaming" | "complete";
    threadKey?: string;
    parentToolUseId?: string | null;
    reasoningTurnId?: string;
    summaryIndex?: number;
    timestamp?: number;
  } = {},
): ChatMessage {
  const threadKey = options.threadKey ?? "main";
  const raw: Extract<BrowserIncomingMessage, { type: "codex_reasoning_detail" }> = {
    type: "codex_reasoning_detail",
    id,
    text: content,
    status: options.status ?? "complete",
    timestamp: options.timestamp ?? 1,
    parent_tool_use_id: options.parentToolUseId ?? null,
    reasoning_turn_id: options.reasoningTurnId ?? "turn-reasoning-group",
    summary_index: options.summaryIndex ?? 0,
    threadKey,
    ...(threadKey === "main" ? {} : { questId: threadKey }),
  };
  return normalizeCodexReasoningDetailMessage(raw);
}

function renderReasoningEntries(
  entries: FeedEntry[],
  options: { sessionId?: string; minuteBoundaryLabels?: Map<string, string> } = {},
) {
  return render(
    <FeedEntries
      entries={entries}
      sessionId={options.sessionId ?? "reasoning-group-session"}
      currentThreadKey="all"
      minuteBoundaryLabels={options.minuteBoundaryLabels}
      isCodexSession
      activeCodexTerminalIds={new Set()}
      onOpenCodexTerminal={vi.fn()}
    />,
  );
}

function setStoreSessionState(sessionId: string, session: Record<string, unknown>) {
  const map = new Map();
  map.set(sessionId, session);
  mockStoreValues.sessions = map;
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

function setStoreSdkSessions(
  sessions: Array<{
    sessionId: string;
    isOrchestrator?: boolean;
    herdedBy?: string;
    reviewerOf?: number;
    sessionNum?: number;
    claimedQuestId?: string | null;
  }>,
) {
  mockStoreValues.sdkSessions = sessions.map((session) => ({
    sessionId: session.sessionId,
    state: "connected",
    cwd: "/test",
    createdAt: Date.now(),
    ...(session.isOrchestrator ? { isOrchestrator: true } : {}),
    ...(session.herdedBy ? { herdedBy: session.herdedBy } : {}),
    ...(session.reviewerOf !== undefined ? { reviewerOf: session.reviewerOf } : {}),
    ...(session.sessionNum !== undefined ? { sessionNum: session.sessionNum } : {}),
    ...(session.claimedQuestId ? { claimedQuestId: session.claimedQuestId } : {}),
  }));
}

function setStoreSdkSessionRole(
  sessionId: string,
  overrides: {
    isOrchestrator?: boolean;
    herdedBy?: string;
    reviewerOf?: number;
    sessionNum?: number;
    claimedQuestId?: string | null;
  } = {},
) {
  setStoreSdkSessions([
    {
      sessionId,
      ...overrides,
    },
  ]);
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
  mockStoreValues.messages = new Map();
  mockStoreValues.messageFrozenCounts = new Map();
  mockStoreValues.messageFrozenRevisions = new Map();
  mockStoreValues.historyWindows = new Map();
  mockStoreValues.streaming = new Map();
  mockStoreValues.streamingByParentToolUseId = new Map();
  mockStoreValues.streamingThinking = new Map();
  mockStoreValues.streamingThinkingByParentToolUseId = new Map();
  mockStoreValues.codexReasoningPreviews = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.streamingPausedDuration = new Map();
  mockStoreValues.streamingPauseStartedAt = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.activeTurnRoutes = new Map();
  mockStoreValues.sessions = new Map();
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
  mockStoreValues.sessionBoards = new Map();
  mockStoreValues.sessionBoardRowStatuses = new Map();
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

describe("ElapsedTimer - generation stats bar", () => {
  it("renders stats bar when session is running", () => {
    const sid = "test-stats";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
  });

  it("does not render stats bar when session is idle", () => {
    const sid = "test-idle";
    setStoreStatus(sid, "idle");

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("shows output tokens in stats bar when available", () => {
    const sid = "test-tokens-stats";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    // Should show "2.5k" token count
    expect(screen.getByText(/2\.5k/)).toBeTruthy();
  });

  it("labels running turns as active here when the visible thread matches", () => {
    const sid = "test-active-here";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} currentThreadKey="q-975" />);

    expect(screen.getByText("Active here")).toBeTruthy();
  });

  it("keeps reasoning text out of the floating activity chip", () => {
    const sid = "test-active-reasoning-preview";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreActiveCodexReasoningPreview(sid, {
      text: "**Inspecting route metadata**\n\nThe detailed body should not appear in the chip.",
      updatedAt: Date.now(),
      threadKey: "q-975",
      questId: "q-975",
    });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-975" />);

    expect(screen.getByText("Active here")).toBeTruthy();
    expect(screen.queryByTestId("active-codex-reasoning-preview")).toBeNull();
    expect(screen.queryByText(/detailed body/i)).toBeNull();
  });

  it("formats active Codex reasoning status as title-only or compact fallback", () => {
    expect(formatActiveReasoningStatusText("**Improving UX for Debriefing**\n\nI'm noticing details.")).toBe(
      "Improving UX for Debriefing",
    );
    expect(formatActiveReasoningStatusText("No title available\nwith a body")).toBe("No title available with a body");
  });

  it("hides the active Codex reasoning preview when it does not match the active route", () => {
    const sid = "test-active-reasoning-preview-mismatch";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreActiveCodexReasoningPreview(sid, {
      text: "Wrong tab reasoning",
      updatedAt: Date.now(),
      threadKey: "q-976",
      questId: "q-976",
    });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-975" />);

    expect(screen.queryByTestId("active-codex-reasoning-preview")).toBeNull();
  });

  it("keeps projected worker reasoning text out of the leader floating chip", () => {
    const sid = "test-leader-worker-reasoning-preview";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 9000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreBoardProjection(sid, [{ questId: "q-975", worker: "worker-1", workerNum: 2463, updatedAt: 1 }], {
      "q-975": {
        worker: {
          sessionId: "worker-1",
          sessionNum: 2463,
          status: "running",
          activeTurnRoute: { threadKey: "q-975", questId: "q-975" },
          generationStartedAt: Date.now() - 12_000,
          codexReasoningPreviews: [
            {
              text: "Checking the Journey handoff state",
              updatedAt: Date.now(),
              threadKey: "q-975",
              questId: "q-975",
            },
          ],
        },
        reviewer: null,
      },
    });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-1802" />);

    expect(screen.getByText("Active in q-975")).toBeTruthy();
    expect(screen.queryByTestId("active-codex-reasoning-preview")).toBeNull();
    expect(screen.queryByText("Checking the Journey handoff state")).toBeNull();
  });

  it("does not project matching worker activity into an idle leader chip", () => {
    const sid = "test-idle-leader-active-worker-matching";
    setStoreStatus(sid, "idle");
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreBoardProjection(sid, [{ questId: "q-975", worker: "worker-1", workerNum: 2463, updatedAt: 1 }], {
      "q-975": {
        worker: {
          sessionId: "worker-1",
          sessionNum: 2463,
          status: "running",
          activeTurnRoute: { threadKey: "q-975", questId: "q-975" },
          generationStartedAt: Date.now() - 12_000,
        },
        reviewer: null,
      },
    });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-975" />);

    expect(screen.queryByText("Active here")).toBeNull();
    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("does not project cross-thread worker activity into an idle leader chip", () => {
    const sid = "test-idle-leader-active-worker-other-thread";
    setStoreStatus(sid, "idle");
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreBoardProjection(sid, [{ questId: "q-975", worker: "worker-1", workerNum: 2463, updatedAt: 1 }], {
      "q-975": {
        worker: {
          sessionId: "worker-1",
          sessionNum: 2463,
          status: "running",
          activeTurnRoute: { threadKey: "q-975", questId: "q-975" },
          generationStartedAt: Date.now() - 12_000,
        },
        reviewer: null,
      },
    });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="main" />);

    expect(screen.queryByText("Active in q-975")).toBeNull();
    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("renders a persistent reasoning detail collapsed by default and expands the full summary", () => {
    render(
      <MessageBubble
        message={reasoningDetailMessage(
          "reasoning-1",
          "**Considering UX for route mapping**\n\nI'm thinking about a new user experience for the full available message line without truncation.",
        )}
        backendType="codex"
      />,
    );

    const detail = screen.getByTestId("codex-reasoning-detail");
    expect(detail.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("codex-reasoning-title").textContent).toBe("Considering UX for route mapping");
    expect(screen.queryByText(/\*\*Considering UX/)).toBeNull();

    fireEvent.click(screen.getByText("Considering UX for route mapping"));
    expect(detail.hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("codex-reasoning-body").textContent).toContain(
      "full available message line without truncation.",
    );
  });

  it("does not render root Codex streaming thinking through the legacy footer", () => {
    const sid = "test-root-streaming-thinking-footer";
    setStoreSessionBackend(sid, "codex");
    setStoreStatus(sid, "running");
    setStoreThinking(
      sid,
      "**Considering tool constraints**\n\nI need to look at the patch tool, which is currently long enough to trigger the old compact footer truncation.",
    );

    render(<FeedFooter sessionId={sid} visibleToolUseIds={new Set()} />);

    expect(screen.queryByText(/\*\*Considering tool constraints/)).toBeNull();
    expect(screen.queryByText(/I need to look at the patch tool/)).toBeNull();
  });

  it("uses the approved generic Reasoning label for titleless official summaries", () => {
    render(
      <MessageBubble
        message={reasoningDetailMessage("reasoning-titleless", "A body without a parseable provider title.")}
        backendType="codex"
      />,
    );

    expect(screen.getByTestId("codex-reasoning-title").textContent).toBe("Reasoning");
    expect(screen.getByTestId("codex-reasoning-title").textContent).not.toContain("A body without");
  });

  it("renders independent chronological reasoning details without merging their identities", () => {
    render(
      <>
        <MessageBubble message={reasoningDetailMessage("reasoning-main", "**Main trace**\n\nMain body.")} />
        <MessageBubble message={reasoningDetailMessage("reasoning-quest", "**Quest trace**\n\nQuest body.")} />
      </>,
    );

    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(2);
    expect(screen.getByText("Main trace")).toBeTruthy();
    expect(screen.getByText("Quest trace")).toBeTruthy();
  });

  it("groups consecutive producer-shaped reasoning details and expands their complete ordered history", () => {
    const messages = [
      producerReasoningDetail("reasoning-part-0", "**Inspecting state**\n\nFirst complete body.", {
        summaryIndex: 0,
      }),
      producerReasoningDetail("reasoning-part-1", "**Checking boundaries**\n\nSecond complete body.", {
        summaryIndex: 1,
      }),
      producerReasoningDetail("reasoning-part-2", "**Preparing handoff**\n\nThird complete body.", {
        status: "streaming",
        summaryIndex: 2,
      }),
    ];

    const view = renderReasoningEntries(messages.map(makeFeedEntryMessage));

    const group = screen.getByTestId("codex-reasoning-detail-group");
    expect(group.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("codex-reasoning-group-title").textContent).toBe("Preparing handoff");
    expect(screen.getByTestId("codex-reasoning-group-count").textContent).toBe("3 summaries");
    expect(screen.queryAllByTestId("codex-reasoning-detail")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("codex-reasoning-group-title"));

    expect(group.hasAttribute("open")).toBe(true);
    expect(screen.getAllByTestId("codex-reasoning-expanded-title").map((node) => node.textContent)).toEqual([
      "Inspecting state",
      "Checking boundaries",
      "Preparing handoff",
    ]);
    expect(screen.getAllByTestId("codex-reasoning-body").map((node) => node.textContent)).toEqual([
      "First complete body.",
      "Second complete body.",
      "Third complete body.",
    ]);
    expect(view.container.querySelector('[data-message-id="reasoning-part-1"]')).toBeTruthy();
    expect(view.container.querySelector('[data-message-id="reasoning-part-2"]')).toBeTruthy();
  });

  it("preserves tool, route, and minute boundaries between reasoning details", () => {
    const first = producerReasoningDetail("reasoning-before-tool", "**Before tool**\n\nFirst body.", {
      summaryIndex: 0,
    });
    const second = producerReasoningDetail("reasoning-after-tool", "**After tool**\n\nSecond body.", {
      summaryIndex: 1,
    });
    const toolBoundary: FeedEntry = {
      kind: "tool_msg_group",
      toolName: "Bash",
      firstId: "tool-boundary",
      items: [{ id: "tool-boundary-use", name: "Bash", input: { command: "printf boundary" } }],
    };

    const toolView = renderReasoningEntries([makeFeedEntryMessage(first), toolBoundary, makeFeedEntryMessage(second)]);
    expect(screen.queryAllByTestId("codex-reasoning-detail-group")).toHaveLength(0);
    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(2);
    toolView.unmount();

    const routedA = producerReasoningDetail("reasoning-route-a", "**Route A**\n\nA.", {
      threadKey: "q-100",
      summaryIndex: 0,
    });
    const routedB = producerReasoningDetail("reasoning-route-b", "**Route B**\n\nB.", {
      threadKey: "q-200",
      summaryIndex: 1,
    });
    const routeView = renderReasoningEntries([makeFeedEntryMessage(routedA), makeFeedEntryMessage(routedB)]);
    expect(screen.queryAllByTestId("codex-reasoning-detail-group")).toHaveLength(0);
    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(2);
    routeView.unmount();

    renderReasoningEntries([makeFeedEntryMessage(first), makeFeedEntryMessage(second)], {
      minuteBoundaryLabels: new Map([[second.id, "12:01 PM"]]),
    });
    expect(screen.queryAllByTestId("codex-reasoning-detail-group")).toHaveLength(0);
    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(2);
    expect(screen.getByTestId("minute-boundary-timestamp").textContent).toBe("12:01 PM");
  });

  it("opens a grouped reasoning run when navigation targets a retained member identity", async () => {
    const sid = "test-reasoning-group-scroll-target";
    const first = producerReasoningDetail("reasoning-target-0", "**First summary**\n\nFirst body.", {
      summaryIndex: 0,
    });
    const second = producerReasoningDetail("reasoning-target-1", "**Target summary**\n\nTarget body.", {
      summaryIndex: 1,
    });
    mockStoreValues.expandAllInTurn = new Map([[sid, second.id]]);

    const view = renderReasoningEntries([makeFeedEntryMessage(first), makeFeedEntryMessage(second)], {
      sessionId: sid,
    });
    await act(async () => Promise.resolve());

    expect(screen.getByTestId("codex-reasoning-detail-group").hasAttribute("open")).toBe(true);
    expect(view.container.querySelector(`[data-message-id="${second.id}"]`)).toBeTruthy();
    expect(screen.getByText("Target body.")).toBeTruthy();
  });

  it("keeps a completed persistent reasoning detail available while the session is idle", () => {
    const sid = "test-persistent-reasoning-idle";
    setStoreStatus(sid, "idle");
    render(
      <MessageBubble
        message={reasoningDetailMessage(
          "reasoning-idle",
          "**Checking the Journey handoff state**\n\nPersistent body after idle.",
        )}
      />,
    );

    expect(screen.getByTestId("codex-reasoning-title").textContent).toBe("Checking the Journey handoff state");
  });

  it("settles a streaming reasoning update into the same persistent row", () => {
    const view = render(
      <MessageBubble
        message={reasoningDetailMessage("reasoning-live", "**Inspecting state**\n\nPartial", "streaming")}
      />,
    );
    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(1);

    view.rerender(
      <MessageBubble
        message={reasoningDetailMessage("reasoning-live", "**Inspecting state**\n\nComplete summary", "complete")}
      />,
    );
    expect(screen.getAllByTestId("codex-reasoning-detail")).toHaveLength(1);
    fireEvent.click(screen.getByText("Inspecting state"));
    expect(screen.getByTestId("codex-reasoning-body").textContent).toBe("Complete summary");
  });

  it("labels running turns with the active quest when another thread is visible", () => {
    const sid = "test-active-elsewhere";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} currentThreadKey="main" />);

    expect(screen.getByText("Active in q-975")).toBeTruthy();
  });

  // The floating leader chip must navigate from authoritative route metadata,
  // while same-tab and no-route states remain inert even though the visible copy is nearby.
  it("jumps from a quest tab to active Main when leader route targets Main", () => {
    const sid = "test-active-main-jump";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "main" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(
      <ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-975" onSelectThread={onSelectThread} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to active thread main" }));
    expect(screen.getByText("Active in main")).toBeTruthy();
    expect(onSelectThread).toHaveBeenCalledWith("main");
  });

  it("jumps from All Threads to the active quest route", () => {
    const sid = "test-active-all-threads-jump";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="all" onSelectThread={onSelectThread} />);

    fireEvent.click(screen.getByRole("button", { name: "Jump to active thread q-975" }));
    expect(onSelectThread).toHaveBeenCalledWith("q-975");
  });

  it("jumps from Main to another visible active quest tab", () => {
    const sid = "test-active-visible-quest-jump";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-976", questId: "q-976" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="main" onSelectThread={onSelectThread} />);

    fireEvent.click(screen.getByRole("button", { name: "Jump to active thread q-976" }));
    expect(onSelectThread).toHaveBeenCalledWith("q-976");
  });

  it("forwards hidden More Tabs targets through the same route-derived thread selection", () => {
    const sid = "test-active-hidden-more-jump";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-hidden", questId: "q-1209" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="main" onSelectThread={onSelectThread} />);

    fireEvent.click(screen.getByRole("button", { name: "Jump to active thread q-hidden" }));
    expect(screen.getByText("Active in q-1209")).toBeTruthy();
    expect(onSelectThread).toHaveBeenCalledWith("q-hidden");
  });

  it("keeps Active here states non-navigational", () => {
    const sid = "test-active-here-not-clickable";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(
      <ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="q-975" onSelectThread={onSelectThread} />,
    );

    expect(screen.getByText("Active here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Jump to active thread/i })).toBeNull();
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("keeps no-target leader states non-navigational", () => {
    const sid = "test-active-no-target-not-clickable";
    const onSelectThread = vi.fn();
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, null);
    setStoreSdkSessionRole(sid, { isOrchestrator: true });

    render(<ElapsedTimer sessionId={sid} variant="floating" currentThreadKey="main" onSelectThread={onSelectThread} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Jump to active thread/i })).toBeNull();
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("uses the neutral label for worker turns even when the active route carries a quest", () => {
    const sid = "test-worker-active";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-975", questId: "q-975" });

    render(<ElapsedTimer sessionId={sid} currentThreadKey="main" />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("Working on q-975")).toBeNull();
    expect(screen.queryByText("Active in q-975")).toBeNull();
  });

  it("uses the neutral label for worker turns when a claimed quest is present", () => {
    const sid = "test-worker-claimed";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreSessionState(sid, { claimedQuestId: "q-1198" });

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("Working on q-1198")).toBeNull();
  });

  it("keeps direct worker chats neutral when only stale previous-quest metadata remains", () => {
    const sid = "test-worker-stale-direct-chat";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "main" });
    setStoreSessionState(sid, { claimedQuestId: "q-1478" });

    render(<ElapsedTimer sessionId={sid} currentThreadKey="main" />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("Working on q-1478")).toBeNull();
    expect(screen.queryByText(/Working on q-/)).toBeNull();
  });

  it("labels reviewer turns as reviewing when the active route carries a quest", () => {
    const sid = "test-reviewer-active";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "q-1195", questId: "q-1195" });
    setStoreSdkSessionRole(sid, { reviewerOf: 1523 });

    render(<ElapsedTimer sessionId={sid} currentThreadKey="main" />);

    expect(screen.getByText("Reviewing q-1195")).toBeTruthy();
    expect(screen.queryByText("Active in q-1195")).toBeNull();
  });

  it("uses reviewed session quest metadata for reviewer turns when available", () => {
    const sid = "test-reviewer-parent-quest";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreSdkSessions([
      { sessionId: "worker-1195", sessionNum: 1523, claimedQuestId: "q-1195" },
      { sessionId: sid, reviewerOf: 1523 },
    ]);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Reviewing q-1195")).toBeTruthy();
  });

  it("falls back to purring for reviewers without reliable quest metadata", () => {
    const sid = "test-reviewer-no-quest";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreActiveTurnRoute(sid, { threadKey: "main" });
    setStoreSdkSessionRole(sid, { reviewerOf: 1523 });

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText(/Active in/)).toBeNull();
    expect(screen.queryByText(/Reviewing q-/)).toBeNull();
  });
});
