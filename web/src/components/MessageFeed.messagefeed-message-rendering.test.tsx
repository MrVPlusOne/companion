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
import type { ChatMessage, SessionNotification } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import {
  LEADER_THREAD_TABS_PROJECTION,
  type LeaderThreadTabsProjectionValue,
} from "../../shared/leader-thread-tabs-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../shared/thread-outcome-reminder.js";
import { createLeaderThreadTabsProjectionValue } from "../test-fixtures/leader-thread-tabs-projection.js";

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
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      streamingPausedDuration: mockStoreValues.streamingPausedDuration ?? new Map(),
      streamingPauseStartedAt: mockStoreValues.streamingPauseStartedAt ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
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
      syncedProjectionValues: mockStoreValues.syncedProjectionValues ?? new Map(),
      syncedProjectionKeys: mockStoreValues.syncedProjectionKeys ?? new Set(),
      sessionSearch: mockStoreValues.sessionSearch ?? new Map(),
      compactToolActivity: mockStoreValues.compactToolActivity ?? false,
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
import { getMessageFeedBlockId } from "./message-feed-utils.js";

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

function setStoreNotifications(sessionId: string, notifications: Array<Record<string, unknown> | SessionNotification>) {
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

function setStoreLeaderProjection(
  sessionId: string,
  threadStatuses: LeaderThreadTabsProjectionValue["threadStatuses"],
) {
  const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, sessionId);
  mockStoreValues.syncedProjectionValues = new Map([
    [
      entryId,
      createLeaderThreadTabsProjectionValue({
        tabs: [],
        mainAttention: { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 },
        threadStatuses,
        activePhaseSummary: [],
      }),
    ],
  ]);
  mockStoreValues.syncedProjectionKeys = new Set([entryId]);
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

function makeHerdEvent(
  id: string,
  content: string,
  options: {
    eventKey?: string;
    eventType?: string;
    sessionNum?: number;
    lifecycle?: NonNullable<ChatMessage["takodeHerdEvents"]>[number]["lifecycle"];
    routine?: boolean;
    metadata?: ChatMessage["metadata"];
  } = {},
): ChatMessage {
  return makeMessage({
    id,
    role: "user",
    content,
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.eventKey ? { takodeHerdEventKeys: [options.eventKey] } : {}),
    ...(options.eventType
      ? {
          takodeHerdEvents: [
            {
              event: options.eventType as NonNullable<ChatMessage["takodeHerdEvents"]>[number]["event"],
              sessionId: `worker-${options.sessionNum ?? 2444}`,
              sessionNum: options.sessionNum ?? 2444,
              ts: Date.now(),
              routine:
                options.routine ??
                (options.eventType === "turn_end" ||
                  options.eventType === "worker_stream" ||
                  options.eventType === "board_stalled"),
              ...(options.lifecycle?.length ? { lifecycle: options.lifecycle } : {}),
            },
          ],
        }
      : {}),
  });
}

function turnEndEventKey(overrides: { interrupted?: boolean; isError?: boolean; userMessageCount?: number } = {}) {
  return [
    "turn_end",
    "worker-2444",
    "stop",
    "31300",
    overrides.isError ? "true" : "",
    overrides.interrupted ? "true" : "",
    overrides.interrupted ? "system" : "",
    "",
    "",
    "",
    "",
    "",
    "q-1789",
    "q-1789",
    "Bash:5",
    "Low remains healthy.",
    "1160",
    "1174",
    "",
    "",
    "",
    overrides.userMessageCount == null ? "" : String(overrides.userMessageCount),
    "",
    "leader",
  ].join("|");
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
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.streamingPausedDuration = new Map();
  mockStoreValues.streamingPauseStartedAt = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.syncedProjectionValues = new Map();
  mockStoreValues.syncedProjectionKeys = new Set();
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
  mockStoreValues.compactToolActivity = false;
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

function setElementScrollHeight(element: HTMLElement, scrollHeight: number) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get() {
      return scrollHeight;
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

describe("MessageFeed - message rendering", () => {
  it("hides model-only reminder acknowledgements in collapsed selected leader threads", () => {
    // Thread Outcome/Status and Routing reminders are model-only workflow nudges.
    // Their follow-up acknowledgement should stay inside collapsed activity,
    // while the preceding substantive user-triggered summary remains visible.
    const sid = "test-leader-reminder-summary-hidden";
    const threadRef = { threadKey: "q-1791", questId: "q-1791", source: "explicit" as const };
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({
        id: "u1",
        role: "user",
        content: "Coordinate q-1791",
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "a-substantive",
        role: "assistant",
        content: "q-1791 Work is ready for review after focused validation.",
        metadata: { leaderUserMessage: true, threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "u-reminder",
        role: "user",
        content: "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
        agentSource: {
          sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
          sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
        },
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "a-tool",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-status", name: "Bash", input: { command: "takode status q-1791" } },
        ],
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "a-reminder-ack",
        role: "assistant",
        content: "Handled the reminder and refreshed the thread status.",
        metadata: { leaderUserMessage: true, threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "u2",
        role: "user",
        content: "Thanks, continue",
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "a-current",
        role: "assistant",
        content: "Continuing with the next step.",
        metadata: { leaderUserMessage: true, threadRefs: [threadRef] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1791" />);

    expect(screen.getByText("q-1791 Work is ready for review after focused validation.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Expand turn/i })).toBeTruthy();
    expect(screen.queryByText("Handled the reminder and refreshed the thread status.")).toBeNull();
    expect(screen.getByText("Continuing with the next step.")).toBeTruthy();
  });

  it("renders routine herd events as compact worker activity inside collapsed selected leader turns", () => {
    // Rework regression for q-1799 feedback #3: in the live selected-thread
    // shape, representative leader prose can split collapsed segments. A
    // routine herd event in that segment must still render as compact worker
    // activity, not as a standalone amber herd chip.
    const sid = "test-selected-thread-routine-herd-collapsed-row";
    const threadRef = { threadKey: "q-1799", questId: "q-1799", source: "explicit" as const };
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Close q-1799", metadata: { threadRefs: [threadRef] } }),
      makeHerdEvent("herd-1", "1 event from 1 session\n\n#2455 | turn_end | ok 1m 30s", {
        eventKey: turnEndEventKey(),
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "a-summary",
        role: "assistant",
        content: "The herd-event grouping and compact chip UI is implemented.",
        metadata: { leaderUserMessage: true, codexMessagePhase: "final_answer", threadRefs: [threadRef] },
      }),
      makeMessage({
        id: "tools-memory",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "cmd-1", name: "Bash", input: { command: "quest show q-1799" } },
          { type: "tool_use", id: "cmd-2", name: "Bash", input: { command: "quest complete q-1799" } },
        ],
        metadata: { threadRefs: [threadRef] },
      }),
      makeMessage({ id: "u2", role: "user", content: "Review another quest", metadata: { threadRefs: [threadRef] } }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1799" />);

    expect(screen.getByRole("button", { name: "Expand turn · 2 tools" })).toBeTruthy();
    expect(screen.queryByText("1 worker event")).toBeNull();
    expect(screen.getByText("The herd-event grouping and compact chip UI is implemented.")).toBeTruthy();
    expect(screen.queryByText("#2455")).toBeNull();
    expect(screen.queryByText("turn_end")).toBeNull();
  });

  it("batches consecutive tool-only messages into one compact activity row", () => {
    // Separate protocol messages should still read as one lightweight run until the user asks for details.
    const sid = "test-compact-tool-run";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Inspect and verify" }),
      makeMessage({
        id: "tools-read",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/src/a.ts" } }],
      }),
      makeMessage({
        id: "tools-bash",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "bun test" } }],
      }),
      makeMessage({ id: "a-final", role: "assistant", content: "Everything passes." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
    expect(screen.getByText("Read file, ran command")).toBeTruthy();
    expect(screen.queryByText("bun test")).toBeNull();
    expect(screen.getByText("Everything passes.")).toBeTruthy();
    const compactRow = screen.getByTestId("compact-tool-activity").closest("[data-compact-tool-activity-row]");
    expect(compactRow).toBeTruthy();
    expect(compactRow?.querySelector(".rounded-full")).toBeNull();
    expect(compactRow?.closest(".turn-container")?.className).toContain("sm:space-y-3");

    fireEvent.click(screen.getByRole("button", { name: /Show 2 tool calls/ }));
    expect(screen.getByText("bun test")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
  });

  it("merges a mixed tool message with the following tool-only message", () => {
    // Codex can put Bash and Read blocks in one assistant payload, then emit another Read payload immediately after it.
    const sid = "test-compact-mixed-tool-boundary";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Inspect the implementation" }),
      makeMessage({
        id: "tools-mixed",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "git status" } },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/src/a.ts" } },
        ],
      }),
      makeMessage({
        id: "tools-read",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "read-2", name: "Read", input: { file_path: "/src/b.ts" } }],
      }),
      makeMessage({ id: "a-final", role: "assistant", content: "Inspection complete." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
    expect(screen.getByText("Ran command, read files")).toBeTruthy();
    expect(screen.queryByText("Read file")).toBeNull();
  });

  it("sanitizes stale root Codex reasoning before grouping sibling tools", () => {
    // Already-hydrated pre-fix state can still carry reasoning in both content fields; it must not split the tool run.
    const sid = "test-stale-root-reasoning-tool-group";
    mockStoreValues.compactToolActivity = true;
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Inspect the implementation" }),
      makeMessage({
        id: "tools-with-stale-reasoning",
        role: "assistant",
        content: "Stale root reasoning",
        contentBlocks: [
          { type: "thinking", thinking: "Stale root reasoning" },
          { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "git status" } },
        ],
      }),
      makeMessage({
        id: "tools-read",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/src/a.ts" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
    expect(screen.getByText("Ran command, read file")).toBeTruthy();
    expect(screen.queryByText("Stale root reasoning")).toBeNull();
  });

  it("merges compact tools across feed entries that render no visible row", () => {
    // Empty retained assistant payloads are not meaningful visual boundaries between adjacent tool activity.
    const sid = "test-compact-tool-invisible-boundary";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Run the checks" }),
      makeMessage({
        id: "tools-bash",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "bun test" } }],
      }),
      makeMessage({ id: "empty-retained", role: "assistant", content: "" }),
      makeMessage({
        id: "tools-read",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/src/a.ts" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
    expect(screen.getByText("Ran command, read file")).toBeTruthy();
  });

  it("groups routine herd events into compact worker-event activity with full expanded details", () => {
    // Producer-shaped herd metadata lets routine worker completion events hide
    // behind the existing quiet activity summary without parsing prose.
    const sid = "test-compact-worker-events";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Monitor worker progress" }),
      makeMessage({
        id: "tools-bash",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "takode scan 2444" } }],
      }),
      makeHerdEvent(
        "herd-1",
        '1 event from 1 session\n\n#2444 | turn_end | ok 31.3s | tools: 5 | [1160]-[1174]\n  [1174] asst: "Low remains healthy."',
        { eventKey: turnEndEventKey() },
      ),
      makeHerdEvent(
        "herd-2",
        '1 event from 1 session\n\n#2444 | turn_end | ok 36.6s | tools: 5 | [1176]-[1190]\n  [1190] asst: "Monitoring continues."',
        { eventKey: turnEndEventKey() },
      ),
      makeMessage({ id: "a-final", role: "assistant", content: "Worker is still healthy." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
    expect(screen.getByText("Ran command, 2 worker events")).toBeTruthy();
    expect(screen.queryByText(/tools: 5/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Show 3 activity items/ }));

    expect(screen.getByText(/takode scan 2444/)).toBeTruthy();
    expect(screen.getAllByText(/#2444/)).toHaveLength(2);
    expect(screen.getByText(/31\.3s.*tools: 5/)).toBeTruthy();
    expect(screen.getByText(/Low remains healthy/)).toBeTruthy();
    expect(screen.getByText("Worker is still healthy.")).toBeTruthy();
  });

  it("compacts interrupted herd chips while preserving permission decisions", () => {
    // Interrupted worker-event chips are compacted into activity, but actual
    // permission/decision UI remains visible outside the quiet worker summary.
    const sid = "test-actionable-worker-event-boundary";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Monitor worker progress" }),
      makeHerdEvent("routine-herd", "1 event from 1 session\n\n#2444 | turn_end | ok 31.3s", {
        eventKey: turnEndEventKey(),
      }),
      makeHerdEvent(
        "interrupted-herd",
        "1 event from 1 session\n\n#2444 | turn_end | Work interrupted | recovery pending",
        {
          eventKey: turnEndEventKey({ interrupted: true }),
          eventType: "turn_end",
          lifecycle: ["interrupted"],
          routine: false,
        },
      ),
      makeHerdEvent(
        "permission-herd",
        "1 event from 1 session\n\n#2444 | permission_request | waiting for decision; Work preserved | Bash needs approval",
        {
          eventType: "permission_request",
          lifecycle: ["waiting_for_decision"],
          routine: false,
        },
      ),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("2 worker events")).toBeTruthy();
    expect(screen.queryByText(/^Work interrupted$/)).toBeNull();
    expect(screen.getByText(/permission_request/)).toBeTruthy();
    expect(screen.getAllByText(/waiting for decision; Work preserved/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(1);
  });

  it("renders notification UI outside a compacted tool-only notify command", () => {
    // Tool-only notify messages bypass MessageBubble, so the feed-level compact group must preserve the fallback panel.
    const sid = "test-compact-tool-notification";
    mockStoreValues.compactToolActivity = true;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Tell me when it is ready" }),
      makeMessage({
        id: "notify-tool-message",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "notify-tool",
            name: "Bash",
            input: { command: 'takode notify review "Ready for review"' },
          },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Ran command")).toBeTruthy();
    expect(screen.queryByText('takode notify review "Ready for review"')).toBeNull();
    expect(screen.getByText("Ready for review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark as reviewed" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Show 1 tool call/ }));
    expect(screen.getAllByText("Ready for review")).toHaveLength(1);
  });

  it("collapses command runs on both sides of a visible thread transition", () => {
    // Thread routing chips remain meaningful boundaries, but harmless notify-list calls inside each run still compact.
    const sid = "test-compact-tools-around-thread-marker";
    mockStoreValues.compactToolActivity = true;
    const timestamp = 1_700_000_000_000;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Inspect both thread segments", timestamp }),
      makeMessage({
        id: "tools-before",
        role: "assistant",
        content: "",
        timestamp: timestamp + 1,
        contentBlocks: [
          { type: "tool_use", id: "notify-list", name: "Bash", input: { command: "takode notify list" } },
          { type: "tool_use", id: "board-detail", name: "Bash", input: { command: "takode board detail q-1777" } },
        ],
      }),
      makeMessage({
        id: "thread-transition",
        role: "system",
        content: "",
        timestamp: timestamp + 2,
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "thread-transition",
            timestamp: timestamp + 2,
            markerKey: "thread-transition:main->q-1777",
            sourceThreadKey: "main",
            threadKey: "q-1777",
            questId: "q-1777",
            transitionedAt: timestamp + 2,
            reason: "route_switch",
          },
        },
      }),
      makeMessage({
        id: "tools-after",
        role: "assistant",
        content: "",
        timestamp: timestamp + 3,
        contentBlocks: [
          { type: "tool_use", id: "takode-list", name: "Bash", input: { command: "takode list" } },
          { type: "tool_use", id: "quest-status", name: "Bash", input: { command: "quest status q-1777" } },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByTestId("compact-tool-activity")).toHaveLength(2);
    expect(screen.getAllByText("Ran 2 commands")).toHaveLength(2);
    expect(screen.getByTestId("thread-transition-marker")).toBeTruthy();
    expect(screen.queryByText("Terminal")).toBeNull();
  });

  it("renders user and assistant messages", () => {
    const sid = "test-render-msgs";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "What is 2+2?" }),
      makeMessage({ id: "a1", role: "assistant", content: "The answer is 4." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("What is 2+2?")).toBeTruthy();
    // The assistant message goes through the mocked Markdown component
    expect(screen.getByText("The answer is 4.")).toBeTruthy();
  });

  it("skips empty assistant messages without blocking later feed entries", () => {
    const sid = "test-empty-assistant-skip";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Before empty row" }),
      // Some Codex retained histories contain assistant rows with no text,
      // blocks, or notification. FeedEntries must advance past them.
      makeMessage({ id: "empty-a1", role: "assistant", content: "" }),
      makeMessage({ id: "a2", role: "assistant", content: "After empty row" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Before empty row")).toBeTruthy();
    expect(screen.getByText("After empty row")).toBeTruthy();
  });

  it("renders marker-only thread status messages as compact chips without raw marker text", () => {
    const sid = "test-thread-status-chip";
    const status = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-941",
      questId: "q-941",
      summary: "waiting on reviewer pass",
      messageId: "status-a1",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    setStoreLeaderProjection(sid, { "q-941": status });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "text", text: "" }],
        turnDurationMs: 18_253,
        metadata: {
          threadStatusMarkers: [status],
          threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.getByLabelText("Thread Waiting for thread:q-941: waiting on reviewer pass")).toBeTruthy();
    expect(document.querySelector('[data-message-id="status-a1"]')).toBeNull();
    expect(screen.queryByText(/\{\[\(Thread Waiting:/)).toBeNull();
  });

  it("keeps narrow thread status chips readable without truncating long wait notes", () => {
    const sid = "test-thread-status-mobile-wrap";
    const status = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-1409",
      questId: "q-1409",
      summary:
        "waiting on collapsed composer safe-area quest, reviewer availability, and the mobile add-to-home-screen screenshot follow-up",
      messageId: "status-mobile",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    setStoreLeaderProjection(sid, { "q-1409": status });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-mobile",
        role: "assistant",
        content: "",
        metadata: {
          threadStatusMarkers: [status],
          threadRefs: [{ threadKey: "q-1409", questId: "q-1409", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1409" />);

    const chip = screen.getByLabelText(
      "Thread Waiting for thread:q-1409: waiting on collapsed composer safe-area quest, reviewer availability, and the mobile add-to-home-screen screenshot follow-up",
    );
    const destination = within(chip).getByTestId("thread-status-destination");
    const summary = within(chip).getByTestId("thread-status-summary");

    // Mobile status chips should show the short destination while preserving full accessible thread metadata.
    expect(destination.textContent).toBe("q-1409");
    expect(destination.textContent).not.toContain("thread:");
    // The wait note owns a full mobile row and wraps instead of using the old truncation treatment.
    expect(summary.className).toContain("basis-full");
    expect(summary.className).toContain("whitespace-normal");
    expect(summary.className).toContain("break-words");
    expect(summary.className).not.toContain("truncate");
    expect(summary.textContent).toContain("mobile add-to-home-screen screenshot follow-up");
  });

  it("renders only the current thread status", () => {
    const sid = "test-thread-status-latest-anchor";
    const oldStatus = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-941",
      questId: "q-941",
      summary: "waiting on reviewer pass",
      messageId: "status-old",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const currentStatus = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-941",
      questId: "q-941",
      summary: "review accepted",
      messageId: "status-new",
      timestamp: 1_700_000_010_000,
      updatedAt: 1_700_000_010_000,
    };
    setStoreLeaderProjection(sid, { "q-941": currentStatus });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-old",
        role: "assistant",
        content: "",
        metadata: {
          threadStatusMarkers: [oldStatus],
          threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
        },
      }),
      makeMessage({
        id: "status-new",
        role: "assistant",
        content: "",
        metadata: {
          threadStatusMarkers: [currentStatus],
          threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.queryByLabelText("Thread Waiting for thread:q-941: waiting on reviewer pass")).toBeNull();
    expect(screen.getByLabelText("Thread Ready for thread:q-941: review accepted")).toBeTruthy();
  });

  it("replaces stale Thread Ready status with a current Thread Waiting status", () => {
    const sid = "test-thread-ready-replaced-by-waiting";
    const oldStatus = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-1702",
      questId: "q-1702",
      summary: "implementation complete",
      messageId: "status-ready-old",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const currentStatus = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-1702",
      questId: "q-1702",
      summary: "waiting on browser validation",
      messageId: "status-waiting-new",
      timestamp: 1_700_000_010_000,
      updatedAt: 1_700_000_010_000,
    };
    setStoreLeaderProjection(sid, { "q-1702": currentStatus });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-ready-old",
        role: "assistant",
        content: "Implementation is ready.",
        metadata: {
          threadStatusMarkers: [oldStatus],
          threadRefs: [{ threadKey: "q-1702", questId: "q-1702", source: "explicit" }],
        },
      }),
      makeMessage({
        id: "status-waiting-new",
        role: "assistant",
        content: "Waiting on browser validation.",
        metadata: {
          threadStatusMarkers: [currentStatus],
          threadRefs: [{ threadKey: "q-1702", questId: "q-1702", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1702" />);

    expect(screen.queryByLabelText("Thread Ready for thread:q-1702: implementation complete")).toBeNull();
    expect(screen.getByLabelText("Thread Waiting for thread:q-1702: waiting on browser validation")).toBeTruthy();
  });

  it("attaches the current thread status to the latest model turn footer", () => {
    const sid = "test-thread-status-latest-turn-footer";
    const base = 1_700_000_000_000;
    const status = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "main",
      summary: "q-1307 dispatched",
      messageId: "status-main",
      timestamp: base,
      updatedAt: base,
    };
    setStoreLeaderProjection(sid, { main: status });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-main",
        role: "assistant",
        content: "Main is clear; the notification-bell bug is now tracked as q-1307.",
        timestamp: base,
        metadata: {
          threadStatusMarkers: [status],
        },
      }),
      makeMessage({
        id: "route-q1306",
        role: "system",
        content: "",
        timestamp: base + 1,
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "route-q1306",
            timestamp: base + 1,
            markerKey: "thread-transition:main->q-1306",
            sourceThreadKey: "main",
            threadKey: "q-1306",
            questId: "q-1306",
            transitionedAt: base + 1,
            reason: "route_switch",
          },
        },
      }),
      makeMessage({
        id: "later-result",
        role: "assistant",
        content: "Later visible turn-end item",
        timestamp: base + 2,
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="main" />);

    const chip = screen.getByLabelText("Thread Ready for Main: q-1307 dispatched");
    const statusFooter = screen.getByTestId("turn-thread-status-footer");
    const routingMarker = screen.getByTestId("thread-transition-marker");
    const laterItem = screen.getByText("Later visible turn-end item");
    const feedEndSlack = document.querySelector("[data-feed-end-slack]");

    expect(screen.getByText("Main is clear; the notification-bell bug is now tracked as q-1307.")).toBeTruthy();
    expect(routingMarker.textContent).toContain("Work continued from current thread to thread:q-1306");
    expect(routingMarker.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(laterItem.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(statusFooter.textContent).toContain("Thread Ready");
    expect(statusFooter.textContent?.startsWith("Status")).toBe(false);
    expect(statusFooter.closest("[data-turn-id]")).toBe(laterItem.closest("[data-turn-id]"));
    expect(document.querySelector('[data-feed-block-id^="current-thread-status:"]')).toBeNull();
    expect(feedEndSlack).toBeTruthy();
    expect(
      (statusFooter.closest("[data-turn-id]") as HTMLElement).compareDocumentPosition(feedEndSlack as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the current thread status footer above expanded turn collapse controls", () => {
    const sid = "test-thread-status-expanded-footer-placement";
    const base = 1_700_000_000_000;
    const status = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-1320",
      questId: "q-1320",
      summary: "memory audit dispatched",
      messageId: "status-q1320",
      timestamp: base,
      updatedAt: base,
    };
    setStoreLeaderProjection(sid, { "q-1320": status });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Coordinate the memory audit", timestamp: base - 1 }),
      makeMessage({
        id: "status-q1320",
        role: "assistant",
        content: "The memory-audit follow-up is represented by q-1322, and q-1321 is blocked on its outcome.",
        timestamp: base,
        metadata: {
          threadStatusMarkers: [status],
          threadRefs: [{ threadKey: "q-1320", questId: "q-1320", source: "explicit" }],
        },
      }),
      makeMessage({
        id: "route-q1320",
        role: "system",
        content: "",
        timestamp: base + 1,
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "route-q1320",
            timestamp: base + 1,
            markerKey: "thread-transition:main->q-1320",
            sourceThreadKey: "main",
            threadKey: "q-1320",
            questId: "q-1320",
            transitionedAt: base + 1,
            reason: "route_switch",
          },
        },
      }),
      makeMessage({
        id: "tool-before-final",
        role: "assistant",
        content: "",
        timestamp: base + 2,
        metadata: {
          threadRefs: [{ threadKey: "q-1320", questId: "q-1320", source: "explicit" }],
        },
        contentBlocks: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "quest create --title ..." },
          },
        ],
      }),
      makeMessage({
        id: "final-response",
        role: "assistant",
        content: "Your memory-audit follow-up is now represented by q-1322.",
        timestamp: base + 3,
        metadata: {
          threadRefs: [{ threadKey: "q-1320", questId: "q-1320", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1320" />);

    const chip = screen.getByLabelText("Thread Ready for thread:q-1320: memory audit dispatched");
    const statusFooter = screen.getByTestId("turn-thread-status-footer");
    const collapseFooter = screen.getByRole("button", { name: "Collapse turn" });
    const feedEndSlack = document.querySelector("[data-feed-end-slack]");

    expect(screen.getByText("Your memory-audit follow-up is now represented by q-1322.")).toBeTruthy();
    expect(collapseFooter).toBeTruthy();
    expect(chip.compareDocumentPosition(collapseFooter as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(statusFooter.closest("[data-turn-id]")).toBe(
      screen.getByText("Your memory-audit follow-up is now represented by q-1322.").closest("[data-turn-id]"),
    );
    expect(document.querySelector('[data-feed-block-id^="current-thread-status:"]')).toBeNull();
    expect(feedEndSlack).toBeTruthy();
    expect(
      (statusFooter.closest("[data-turn-id]") as HTMLElement).compareDocumentPosition(feedEndSlack as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the current thread status footer on a collapsed latest activity turn", () => {
    const sid = "test-thread-status-collapsed-footer-placement";
    const base = 1_700_000_000_000;
    const status = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "main",
      summary: "worker still running",
      messageId: "status-main",
      timestamp: base,
      updatedAt: base,
    };
    setStoreLeaderProjection(sid, { main: status });
    setStoreTurnOverrides(sid, [["u2", false]]);
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Start previous turn", timestamp: base - 2 }),
      makeMessage({ id: "a1", role: "assistant", content: "Previous turn complete", timestamp: base - 1 }),
      makeMessage({ id: "u2", role: "user", content: "Run latest tool-heavy turn", timestamp: base }),
      makeMessage({
        id: "tool-latest",
        role: "assistant",
        content: "",
        timestamp: base + 1,
        contentBlocks: [{ type: "tool_use", id: "tool-latest-use", name: "Bash", input: { command: "date" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="main" />);

    // A collapsed, tool-only latest turn has no assistant message timestamp, so
    // the status must attach to the collapsed activity footer instead.
    const footer = screen.getByTestId("turn-thread-status-footer");
    expect(screen.getByLabelText("Thread Waiting for Main: worker still running")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(footer.closest("[data-turn-id]")?.getAttribute("data-turn-id")).toBe("u2");
    expect(document.querySelector('[data-feed-block-id^="current-thread-status:"]')).toBeNull();
  });

  it("falls back to the latest visible turn for sparse thread projections without model activity", () => {
    const sid = "test-thread-status-sparse-thread-footer";
    const base = 1_700_000_000_000;
    const status = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "main",
      summary: "nothing else to show",
      messageId: "status-main",
      timestamp: base,
      updatedAt: base,
    };
    setStoreLeaderProjection(sid, { main: status });
    setStoreMessages(sid, [
      makeMessage({ id: "u-only", role: "user", content: "Sparse thread context only", timestamp: base }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="main" />);

    // Sparse projections can lack an assistant/model tail. The current status
    // should still remain visible without reintroducing a feed-end status block.
    const footer = screen.getByTestId("turn-thread-status-footer");
    expect(screen.getByText("Sparse thread context only")).toBeTruthy();
    expect(screen.getByLabelText("Thread Ready for Main: nothing else to show")).toBeTruthy();
    expect(footer.closest("[data-turn-id]")?.getAttribute("data-turn-id")).toBe("u-only");
    expect(document.querySelector('[data-feed-block-id^="current-thread-status:"]')).toBeNull();
  });

  it("scrolls to the latest host turn when current thread status is footer metadata", () => {
    const sid = "test-thread-status-scroll-bottom-host-turn";
    const base = 1_700_000_000_000;
    const status = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "main",
      summary: "q-1307 dispatched",
      messageId: "status-main",
      timestamp: base,
      updatedAt: base,
    };
    let jumpToLatest: (() => void) | null = null;
    setStoreLeaderProjection(sid, { main: status });
    setStoreMessages(sid, [
      makeMessage({
        id: "status-main",
        role: "assistant",
        content: "Main is clear; the notification-bell bug is now tracked as q-1307.",
        timestamp: base,
        metadata: { threadStatusMarkers: [status] },
      }),
      makeMessage({
        id: "later-result",
        role: "assistant",
        content: "Later visible turn-end item",
        timestamp: base + 1,
      }),
    ]);

    render(
      <MessageFeed
        sessionId={sid}
        threadKey="main"
        onJumpToLatestReady={(scrollToLatest) => {
          jumpToLatest = scrollToLatest;
        }}
      />,
    );

    const container = screen.getByTestId("message-feed-scroll-container") as HTMLElement;
    const latestBlock = document.querySelector(
      `[data-feed-block-id="${getMessageFeedBlockId("later-result")}"]`,
    ) as HTMLElement | null;
    const statusFooter = screen.getByTestId("turn-thread-status-footer");
    const hostTurn = statusFooter.closest("[data-turn-id]") as HTMLElement | null;
    expect(latestBlock).toBeTruthy();
    expect(hostTurn).toBeTruthy();
    expect(document.querySelector('[data-feed-block-id^="current-thread-status:"]')).toBeNull();

    setElementClientSize(container, 800, 500);
    setElementScrollHeight(container, 1_000);
    for (const block of document.querySelectorAll<HTMLElement>("[data-feed-block-id]")) {
      setElementOffsetMetrics(block, 0, 1);
    }
    setElementOffsetMetrics(latestBlock as HTMLElement, 620, 40);
    setElementOffsetMetrics(hostTurn as HTMLElement, 0, 732);

    act(() => {
      jumpToLatest?.();
    });

    expect(mockScrollTo).toHaveBeenLastCalledWith({ top: 232, behavior: "smooth" });
  });

  it("hides current status chips in All Threads while preserving Main and quest tabs", () => {
    const sid = "test-thread-status-all-threads-scope";
    const mainStatus = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "main",
      summary: "main clear",
      messageId: "main-status",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const questStatus = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-1306",
      questId: "q-1306",
      summary: "waiting on reviewer",
      messageId: "quest-status",
      timestamp: 1_700_000_010_000,
      updatedAt: 1_700_000_010_000,
    };
    setStoreLeaderProjection(sid, { main: mainStatus, "q-1306": questStatus });
    setStoreMessages(sid, [
      makeMessage({
        id: "main-status",
        role: "assistant",
        content: "",
        timestamp: mainStatus.timestamp,
        metadata: { threadStatusMarkers: [mainStatus] },
      }),
      makeMessage({
        id: "quest-status",
        role: "assistant",
        content: "",
        timestamp: questStatus.timestamp,
        metadata: {
          threadStatusMarkers: [questStatus],
          threadRefs: [{ threadKey: "q-1306", questId: "q-1306", source: "explicit" }],
        },
      }),
      makeMessage({ id: "later-main", role: "assistant", content: "Latest main item", timestamp: 1_700_000_020_000 }),
    ]);

    const mainRender = render(<MessageFeed sessionId={sid} threadKey="main" />);
    expect(screen.getByLabelText("Thread Ready for Main: main clear")).toBeTruthy();
    expect(screen.queryByLabelText("Thread Waiting for thread:q-1306: waiting on reviewer")).toBeNull();
    mainRender.unmount();

    const questRender = render(<MessageFeed sessionId={sid} threadKey="q-1306" />);
    expect(screen.queryByLabelText("Thread Ready for Main: main clear")).toBeNull();
    expect(screen.getByLabelText("Thread Waiting for thread:q-1306: waiting on reviewer")).toBeTruthy();
    questRender.unmount();

    render(<MessageFeed sessionId={sid} threadKey="all" />);
    expect(screen.queryByLabelText("Thread Ready for Main: main clear")).toBeNull();
    expect(screen.queryByLabelText("Thread Waiting for thread:q-1306: waiting on reviewer")).toBeNull();
    expect(screen.queryByTestId("turn-thread-status-footer")).toBeNull();
  });

  it("keeps Main needs-input UI on the source message while projecting cross-thread status only", () => {
    const sid = "test-thread-status-does-not-route-notification";
    const status = {
      kind: "waiting" as const,
      label: "Thread Waiting" as const,
      threadKey: "q-1262",
      questId: "q-1262",
      summary: "rework Implement queued to worker",
      messageId: "main-prompt",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const notification: SessionNotification = {
      id: "n-140",
      category: "needs-input",
      summary: "confirm restart-prep reliability quest and dispatch plan",
      suggestedAnswers: ["approve", "revise scope"],
      timestamp: 1_700_000_000_000,
      messageId: "main-prompt",
      threadKey: "main",
      done: false,
    };
    setStoreLeaderProjection(sid, { "q-1262": status });
    setStoreNotifications(sid, [notification]);
    setStoreMessages(sid, [
      makeMessage({
        id: "main-prompt",
        role: "assistant",
        content: "Waiting on your confirmation for the restart-prep reliability quest proposal.",
        notification,
        metadata: {
          threadStatusMarkers: [status],
        },
      }),
    ]);

    const mainRender = render(<MessageFeed sessionId={sid} threadKey="main" />);
    expect(
      screen.getByText("Waiting on your confirmation for the restart-prep reliability quest proposal."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Use suggested answer: approve")).toBeTruthy();
    expect(screen.getByLabelText("Use suggested answer: revise scope")).toBeTruthy();
    expect(screen.queryByLabelText("Thread Waiting for thread:q-1262: rework Implement queued to worker")).toBeNull();

    mainRender.unmount();

    render(<MessageFeed sessionId={sid} threadKey="q-1262" />);
    expect(
      screen.queryByText("Waiting on your confirmation for the restart-prep reliability quest proposal."),
    ).toBeNull();
    expect(screen.queryByLabelText("Use suggested answer: approve")).toBeNull();
    expect(screen.queryByLabelText("Use suggested answer: revise scope")).toBeNull();
    expect(screen.getByLabelText("Thread Waiting for thread:q-1262: rework Implement queued to worker")).toBeTruthy();
  });

  it("hides Thread Ready review attention rows while preserving the current status footer", () => {
    const sid = "test-thread-ready-review-row-hidden";
    const status = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-1661",
      questId: "q-1661",
      summary: "thread-ready noise explained",
      messageId: "ready-message",
      timestamp: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    const notification: SessionNotification = {
      id: "n-ready",
      category: "review",
      summary: "Thread ready: q-1661 | thread-ready noise explained",
      timestamp: 1_700_000_000_000,
      messageId: "ready-message",
      threadKey: "q-1661",
      questId: "q-1661",
      done: false,
    };
    setStoreLeaderProjection(sid, { "q-1661": status });
    setStoreNotifications(sid, [notification]);
    setStoreMessages(sid, [
      makeMessage({
        id: "ready-message",
        role: "assistant",
        content: "",
        timestamp: 1_700_000_000_000,
        metadata: {
          threadStatusMarkers: [status],
          threadRefs: [{ threadKey: "q-1661", questId: "q-1661", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1661" />);

    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByText("Thread ready: q-1661 | thread-ready noise explained")).toBeNull();
    expect(screen.getByLabelText("Thread Ready for thread:q-1661: thread-ready noise explained")).toBeTruthy();
  });

  it("hides resolved Thread Ready notification markers while preserving the current status footer", () => {
    const sid = "test-thread-ready-resolved-marker-hidden";
    const readyAt = 1_700_000_000_000;
    const staleStatus = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-1702",
      questId: "q-1702",
      summary: "earlier implementation complete",
      messageId: "stale-ready-message",
      timestamp: readyAt,
      updatedAt: readyAt,
    };
    const currentStatus = {
      kind: "ready" as const,
      label: "Thread Ready" as const,
      threadKey: "q-1702",
      questId: "q-1702",
      summary: "latest implementation complete",
      messageId: "current-ready-message",
      timestamp: readyAt + 10_000,
      updatedAt: readyAt + 10_000,
    };
    const staleNotification: SessionNotification = {
      id: "n-stale-ready",
      category: "review",
      summary: "Thread ready: q-1702 | earlier implementation complete",
      timestamp: readyAt,
      messageId: "stale-ready-message",
      threadKey: "q-1702",
      questId: "q-1702",
      done: true,
    };
    setStoreLeaderProjection(sid, { "q-1702": currentStatus });
    setStoreNotifications(sid, [staleNotification]);
    setStoreMessages(sid, [
      makeMessage({
        id: "stale-ready-message",
        role: "assistant",
        content: "Earlier implementation complete.",
        timestamp: readyAt,
        metadata: {
          threadStatusMarkers: [staleStatus],
          threadRefs: [{ threadKey: "q-1702", questId: "q-1702", source: "explicit" }],
        },
      }),
      makeMessage({
        id: "current-ready-message",
        role: "assistant",
        content: "Latest implementation complete.",
        timestamp: readyAt + 10_000,
        metadata: {
          threadStatusMarkers: [currentStatus],
          threadRefs: [{ threadKey: "q-1702", questId: "q-1702", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1702" />);

    expect(screen.getByText("Earlier implementation complete.")).toBeTruthy();
    expect(screen.queryByText("Thread ready: q-1702 | earlier implementation complete")).toBeNull();
    expect(screen.queryByLabelText("Mark as not reviewed")).toBeNull();
    expect(screen.getByLabelText("Thread Ready for thread:q-1702: latest implementation complete")).toBeTruthy();
  });

  it("preserves visible resolved needs-input notification markers", () => {
    const sid = "test-resolved-needs-input-marker-visible";
    const notification: SessionNotification = {
      id: "n-resolved-input",
      category: "needs-input",
      summary: "Confirm deployment?",
      timestamp: 1_700_000_000_000,
      messageId: "resolved-needs-input-message",
      threadKey: "q-1702",
      questId: "q-1702",
      done: true,
    };
    setStoreNotifications(sid, [notification]);
    setStoreMessages(sid, [
      makeMessage({
        id: "resolved-needs-input-message",
        role: "assistant",
        content: "Please confirm deployment.",
        timestamp: 1_700_000_000_000,
        metadata: {
          threadRefs: [{ threadKey: "q-1702", questId: "q-1702", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-1702" />);

    expect(screen.getByText("Please confirm deployment.")).toBeTruthy();
    expect(screen.getByText("Confirm deployment?")).toBeTruthy();
    expect(screen.getByLabelText("Mark unhandled")).toBeTruthy();
  });

  it("renders system messages in the feed", () => {
    const sid = "test-system-msg";
    setStoreMessages(sid, [
      makeMessage({ id: "s1", role: "system", content: "Session restored" }),
      makeMessage({ id: "u1", role: "user", content: "Continue" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Session restored")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("groups consecutive identical system error cards into one counted card", () => {
    const sid = "test-grouped-identical-errors";
    const errorText =
      "Error: stream disconnected before completion: error sending request for url (http://localhost:4000/responses)";
    setStoreMessages(sid, [
      makeMessage({ id: "e1", role: "system", content: errorText, variant: "error" }),
      makeMessage({ id: "e2", role: "system", content: errorText, variant: "error" }),
      makeMessage({ id: "e3", role: "system", content: errorText, variant: "error" }),
      makeMessage({ id: "u1", role: "user", content: "Can you recover?" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The feed should show one readable error card plus a total repeat count,
    // while keeping hidden anchors for duplicate message IDs scrollable.
    expect(screen.getAllByText(errorText)).toHaveLength(1);
    expect(screen.getByText("Same error happened 3 times")).toBeTruthy();
    expect(screen.getAllByTestId("grouped-error-message")).toHaveLength(1);
    expect(document.querySelector('[data-message-id="e2"]')).toBeTruthy();
    expect(document.querySelector('[data-message-id="e3"]')).toBeTruthy();
    expect(screen.getByText("Can you recover?")).toBeTruthy();
  });

  it("groups visually adjacent identical errors across suppressed thread markers", () => {
    const sid = "test-errors-separated-only-by-hidden-thread-marker";
    const base = 1_700_000_000_000;
    const errorText =
      "Error: stream disconnected before completion: error sending request for url (http://localhost:4000/responses)";
    setStoreMessages(sid, [
      makeMessage({ id: "e1", role: "system", content: errorText, timestamp: base, variant: "error" }),
      makeMessage({ id: "e2", role: "system", content: errorText, timestamp: base + 1, variant: "error" }),
      makeMessage({
        id: "hidden-route-marker",
        role: "system",
        content: "",
        timestamp: base + 2,
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "hidden-route-marker",
            timestamp: base + 2,
            markerKey: "thread-transition:main->repeated-error-route",
            sourceThreadKey: "main",
            threadKey: "repeated-error-route",
            transitionedAt: base + 2,
            reason: "route_switch",
          },
        },
      }),
      makeMessage({ id: "e3", role: "system", content: errorText, timestamp: base + 3, variant: "error" }),
      makeMessage({ id: "e4", role: "system", content: errorText, timestamp: base + 4, variant: "error" }),
      makeMessage({ id: "visible-boundary", role: "system", content: "Session restored", timestamp: base + 5 }),
      makeMessage({ id: "e5", role: "system", content: errorText, timestamp: base + 6, variant: "error" }),
      makeMessage({ id: "u1", role: "user", content: "Continue after the errors", timestamp: base + 7 }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="main" />);

    // Suppressed route markers do not render in the collapsed feed, so they
    // must not split visually adjacent identical error cards into two groups.
    expect(screen.queryByTestId("thread-transition-marker")).toBeNull();
    expect(screen.getByText("Same error happened 4 times")).toBeTruthy();
    expect(screen.getAllByTestId("grouped-error-message")).toHaveLength(1);
    expect(screen.getAllByText(errorText)).toHaveLength(2);
    expect(screen.getByText("Session restored")).toBeTruthy();
    expect(screen.getByText("Continue after the errors")).toBeTruthy();
    expect(document.querySelector('[data-message-id="e3"]')).toBeTruthy();
    expect(document.querySelector('[data-message-id="e4"]')).toBeTruthy();
  });

  it("does not group non-consecutive repeated errors across intervening messages", () => {
    const sid = "test-nonconsecutive-errors-stay-separate";
    const errorText = "Error: API rate limit exceeded";
    setStoreMessages(sid, [
      makeMessage({ id: "e1", role: "system", content: errorText, variant: "error" }),
      makeMessage({ id: "s1", role: "system", content: "Session restored" }),
      makeMessage({ id: "e2", role: "system", content: errorText, variant: "error" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByText(errorText)).toHaveLength(2);
    expect(screen.queryByText(/Same error happened/)).toBeNull();
    expect(screen.getByText("Session restored")).toBeTruthy();
  });

  it("keeps distinct consecutive errors visible as separate cards", () => {
    const sid = "test-distinct-errors-stay-separate";
    setStoreMessages(sid, [
      makeMessage({ id: "e1", role: "system", content: "Error: API rate limit exceeded", variant: "error" }),
      makeMessage({
        id: "e2",
        role: "system",
        content: "Error: stream disconnected before completion",
        variant: "error",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Error: API rate limit exceeded")).toBeTruthy();
    expect(screen.getByText("Error: stream disconnected before completion")).toBeTruthy();
    expect(screen.queryByText(/Same error happened/)).toBeNull();
  });

  it("uses compact mobile feed gutters for collapsed turns while restoring desktop spacing at sm", () => {
    // Mobile width recovery is intentionally scoped to the feed and collapsed
    // activity chrome; the sm classes keep the existing tablet/desktop rhythm.
    const sid = "test-collapsed-turn-mobile-width";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "Here is the answer" }),
      makeMessage({ id: "u2", role: "user", content: "Second question" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    const scrollContainerClassName = screen.getByTestId("message-feed-scroll-container").className;
    expect(scrollContainerClassName).toContain("px-2");
    expect(scrollContainerClassName).toContain("sm:px-4");
    const collapsedCard = screen.getByText("Here is the answer").closest(".rounded-xl");
    const collapsedShellClassName = collapsedCard?.parentElement?.className ?? "";
    expect(collapsedShellClassName).toContain("gap-2");
    expect(collapsedShellClassName).toContain("sm:gap-3");
    const collapsedRowClassName = screen.getByText("Here is the answer").closest(".px-2\\.5")?.className ?? "";
    expect(collapsedRowClassName).toContain("sm:px-3");
  });

  it("shows model-responding stage while Codex is streaming an image-backed request", () => {
    const sid = "test-responding-image-stage";
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "responding" });
    setStoreStatus(sid, "running");
    setStoreStreaming(sid, "Inspecting the uploaded image");
    setStoreStreamingStartedAt(sid, Date.now() - 4_000);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("Model responding")).toBeNull();
  });

  it("shows only a date marker for same-day messages, no minute marks", () => {
    // Same-day minute marks were removed (q-249) -- only date-change markers remain.
    // The first message in a session always gets a date marker.
    const sid = "test-smart-timestamps-same-minute";
    const base = new Date("2026-02-25T10:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First", timestamp: base + 5_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "Second", timestamp: base + 25_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Only the initial date marker, no per-minute markers
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(1);
  });

  it("does not add extra markers when minute changes on same day", () => {
    // Same-day minute marks were removed (q-249) -- minute changes don't add markers.
    // Only the initial date marker appears.
    const sid = "test-smart-timestamps-minute-boundary";
    const base = new Date("2026-02-25T10:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "M0", timestamp: base + 5_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "M0 response", timestamp: base + 25_000 }),
      makeMessage({ id: "u2", role: "user", content: "M1", timestamp: base + 65_000 }),
      makeMessage({ id: "a2", role: "assistant", content: "M1 response", timestamp: base + 85_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Only 1 marker (the initial date), not 2 (would have been 2 with minute marks)
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(1);
  });

  it("shows a date marker when messages cross a day boundary", () => {
    const sid = "test-cross-day-boundary";
    // Use dates far apart to avoid timezone edge cases
    const day1 = new Date("2026-02-25T12:00:00.000Z").getTime();
    const day2 = new Date("2026-02-26T12:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Day one", timestamp: day1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Day two", timestamp: day2 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // 2 date markers: one for Feb 25, one for Feb 26
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(2);
  });
});
