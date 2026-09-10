import { describe, expect, it, vi } from "vitest";
import type {
  BrowserIncomingMessage,
  ChatMessage,
  SessionAttentionRecord,
  SessionNotification,
  ThreadWindowState,
} from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import { buildFeedMessageModel, buildFeedWindowModel } from "./feed-render-model.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: 1,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<SessionNotification> & { id: string; messageId: string | null }) {
  return {
    category: "needs-input" as const,
    timestamp: 1,
    done: false,
    summary: "Needs input",
    ...overrides,
  };
}

function makeWindow(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  const window = {
    thread_key: "main",
    from_item: 20,
    item_count: 1,
    total_items: 30,
    source_history_length: 20,
    section_item_count: 50,
    visible_item_count: 3,
    ...overrides,
  };
  return {
    ...window,
    has_older_items: overrides.has_older_items ?? window.from_item > 0,
    has_newer_items: overrides.has_newer_items ?? window.from_item + window.item_count < window.total_items,
  };
}

function makeRawUserMessage(overrides: {
  id: string;
  content: string;
  timestamp: number;
  threadKey?: string;
}): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: overrides.id,
    content: overrides.content,
    timestamp: overrides.timestamp,
    ...(overrides.threadKey ? { threadKey: overrides.threadKey, questId: overrides.threadKey } : {}),
    ...(overrides.threadKey
      ? { threadRefs: [{ threadKey: overrides.threadKey, questId: overrides.threadKey, source: "explicit" as const }] }
      : {}),
  };
}

function makeRawNeedsInputReminder(overrides: {
  id: string;
  timestamp: number;
  totalCount: number;
  entries: Array<{ id: string; summary: string }>;
}): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id: overrides.id,
    content: [
      "[Needs-input reminder]",
      `Unresolved same-session same-thread needs-input notifications (main): ${overrides.totalCount}.${
        overrides.totalCount > overrides.entries.length ? ` Showing newest ${overrides.entries.length}.` : ""
      }`,
      ...overrides.entries.map((entry) => `  ${entry.id}. ${entry.summary}`),
      "Review or resolve these before assuming the user's latest message answered them.",
    ].join("\n"),
    timestamp: overrides.timestamp,
    agentSource: {
      sessionId: "system:needs-input-reminder",
      sessionLabel: "Needs Input Reminder",
    },
  };
}

function normalizeRawUserMessage(message: Extract<BrowserIncomingMessage, { type: "user_message" }>): ChatMessage {
  return normalizeHistoryMessageToChatMessages(message, 0)[0]!;
}

function makeAttentionRecord(overrides: Partial<SessionAttentionRecord> & { id: string }): SessionAttentionRecord {
  const createdAt = overrides.createdAt ?? 1;
  return {
    leaderSessionId: "leader-1",
    type: "review_ready",
    source: { kind: "manual", signature: overrides.id },
    threadKey: "main",
    title: "Attention item",
    summary: "Attention item",
    actionLabel: "Open",
    priority: "review",
    state: "unresolved",
    createdAt,
    updatedAt: createdAt,
    route: { threadKey: "main" },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: overrides.id,
    ...overrides,
  };
}

function makeAttachmentMarker(
  overrides: Partial<NonNullable<NonNullable<ChatMessage["metadata"]>["threadAttachmentMarker"]>> = {},
) {
  return {
    type: "thread_attachment_marker" as const,
    id: "marker-q941",
    timestamp: 300,
    markerKey: "thread-attachment:q-941:m-attached",
    threadKey: "q-941",
    questId: "q-941",
    attachedAt: 300,
    attachedBy: "leader-1",
    messageIds: ["m-attached"],
    messageIndices: [1],
    ranges: ["1"],
    count: 1,
    firstMessageId: "m-attached",
    firstMessageIndex: 1,
    ...overrides,
  };
}

function makeTransitionMarker(overrides: {
  id: string;
  sourceThreadKey: string;
  threadKey: string;
}): Extract<BrowserIncomingMessage, { type: "thread_transition_marker" }> {
  return {
    type: "thread_transition_marker",
    id: overrides.id,
    timestamp: 300,
    markerKey: `thread-transition:${overrides.sourceThreadKey}->${overrides.threadKey}:0`,
    sourceThreadKey: overrides.sourceThreadKey,
    ...(overrides.sourceThreadKey === "main" ? {} : { sourceQuestId: overrides.sourceThreadKey }),
    threadKey: overrides.threadKey,
    questId: overrides.threadKey,
    transitionedAt: 300,
    reason: "route_switch",
  };
}

function makeErrorResult(result: string): Extract<BrowserIncomingMessage, { type: "result" }> {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: null,
      uuid: "result-error",
      session_id: "session-1",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function buildMessageModel(
  input: Partial<Parameters<typeof buildFeedMessageModel>[0]> &
    Pick<Parameters<typeof buildFeedMessageModel>[0], "allMessages" | "sessionNotifications">,
) {
  return buildFeedMessageModel({
    leaderSessionId: "leader-1",
    threadKey: "main",
    projectThreadRoutes: true,
    historyLoading: false,
    selectedFeedWindowEnabled: true,
    selectedFeedWindow: makeWindow(),
    selectedFeedWindowMessages: [],
    ...input,
  });
}

function makeTurn(id: string): Turn {
  return {
    id,
    userEntry: null,
    allEntries: [],
    agentEntries: [],
    systemEntries: [],
    notificationEntries: [],
    responseEntry: null,
    subConclusions: [],
    stats: {
      messageCount: 0,
      toolCount: 0,
      subagentCount: 0,
      herdEventCount: 0,
    },
  };
}

describe("feed render model builders", () => {
  it("keeps proven native child rows in derivation history but out of every ordinary feed projection", () => {
    // Native-child history remains authoritative for the inspector, while Main,
    // quest, All Threads, and unthreaded preview feeds expose root-owned rows only.
    const questRef = { threadKey: "q-1975", questId: "q-1975", source: "explicit" as const };
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const rootMain = makeMessage({ id: "root-main", role: "assistant", content: "Root Main answer", timestamp: 10 });
    const rootQuest = makeMessage({
      id: "root-quest",
      role: "assistant",
      content: "Root quest answer",
      timestamp: 20,
      metadata: { threadKey: "q-1975", questId: "q-1975", threadRefs: [questRef] },
    });
    const childRows = [
      makeMessage({
        id: "child-answer",
        role: "assistant",
        content: "Child answer",
        timestamp: 30,
        metadata: { codexSubagent: ownership },
      }),
      makeMessage({
        id: "child-reasoning",
        role: "assistant",
        content: "**Child reasoning**\nHidden from root feed",
        timestamp: 31,
        metadata: {
          codexSubagent: ownership,
          codexReasoningDetail: { status: "complete", reasoningTurnId: "child-reasoning-turn" },
        },
      }),
      makeMessage({
        id: "child-error",
        role: "system",
        content: "Child failure",
        timestamp: 32,
        variant: "error",
        metadata: { codexSubagent: ownership, threadKey: "q-1975", questId: "q-1975", threadRefs: [questRef] },
      }),
    ];
    const allMessages = [rootMain, rootQuest, ...childRows];

    const main = buildMessageModel({
      allMessages,
      selectedFeedWindowEnabled: false,
      sessionNotifications: [],
      threadKey: "main",
    });
    const quest = buildMessageModel({
      allMessages,
      selectedFeedWindowEnabled: false,
      sessionNotifications: [],
      threadKey: "q-1975",
    });
    const all = buildMessageModel({
      allMessages,
      selectedFeedWindowEnabled: false,
      sessionNotifications: [],
      threadKey: "all",
    });
    const preview = buildMessageModel({
      allMessages,
      projectThreadRoutes: false,
      selectedFeedWindowEnabled: false,
      sessionNotifications: [],
    });

    expect(main.messagesAvailableForDerivation.map((message) => message.id)).toEqual(
      allMessages.map((message) => message.id),
    );
    expect([main, quest, all, preview].every((model) => model.hasFilteredNativeChildMessages)).toBe(true);
    expect(main.messages.map((message) => message.id)).toEqual(["root-main"]);
    expect(quest.messages.map((message) => message.id)).toEqual(["root-quest"]);
    expect(all.messages.map((message) => message.id)).toEqual(["root-main", "root-quest"]);
    expect(preview.messages.map((message) => message.id)).toEqual(["root-main", "root-quest"]);
    expect([main, quest, all, preview].flatMap((model) => model.messages)).not.toContainEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ codexSubagent: ownership }) }),
    );
  });

  it("filters proven child rows from a selected feed window without deleting its authoritative source", () => {
    // Selected-window caches intentionally retain child ownership for inspector
    // and replay authority; only the ordinary rendered projection is root-only.
    const ownership = { childId: "window-child", rootTurnId: "window-root-turn" };
    const root = makeMessage({
      id: "window-root",
      role: "assistant",
      content: "Visible root window row",
      timestamp: 100,
      historyIndex: 20,
    });
    const child = makeMessage({
      id: "window-child",
      role: "assistant",
      content: "Hidden child window row",
      timestamp: 101,
      historyIndex: 21,
      metadata: { codexSubagent: ownership },
    });
    const model = buildMessageModel({
      allMessages: [root, child],
      selectedFeedWindow: makeWindow({ from_item: 20, item_count: 2, source_history_length: 22 }),
      selectedFeedWindowMessages: [root, child],
      sessionNotifications: [],
    });

    expect(model.messagesAvailableForDerivation.map((message) => message.id)).toEqual(["window-root", "window-child"]);
    expect(model.hasFilteredNativeChildMessages).toBe(true);
    expect(model.messages.map((message) => message.id)).toEqual(["window-root"]);
  });

  it("does not derive root attention from a child-owned rework-shaped user message", () => {
    // Message-derived attention is root UI state. Child transcript text must
    // remain authoritative without creating a synthetic Main ledger row.
    const childFeedback = makeMessage({
      id: "child-rework-feedback",
      role: "user",
      content: "This needs rework; please ask the agent to fix it.",
      timestamp: 100,
      metadata: {
        codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" },
        threadKey: "q-1975",
        questId: "q-1975",
        threadRefs: [{ threadKey: "q-1975", questId: "q-1975", source: "explicit" }],
      },
    });

    const model = buildMessageModel({
      allMessages: [childFeedback],
      selectedFeedWindowEnabled: false,
      sessionNotifications: [],
    });

    expect(model.messagesAvailableForDerivation).toEqual([childFeedback]);
    expect(model.attentionRecords).toEqual([]);
    expect(model.attentionLedgerMessages).toEqual([]);
    expect(model.messages).toEqual([]);
  });

  it("does not let child timestamps widen selected Main attention-ledger bounds", () => {
    // Window bounds describe the visible root projection, not hidden child
    // history that happened to share the producer-selected raw window.
    const root = makeMessage({
      id: "root-window-row",
      role: "assistant",
      content: "Visible root row",
      timestamp: 100,
      historyIndex: 0,
    });
    const child = makeMessage({
      id: "late-child-window-row",
      role: "assistant",
      content: "Hidden late child row",
      timestamp: 1_000,
      historyIndex: 1,
      metadata: { codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" } },
    });

    const model = buildMessageModel({
      allMessages: [root, child],
      selectedFeedWindow: makeWindow({ from_item: 0, item_count: 2, total_items: 2, source_history_length: 2 }),
      selectedFeedWindowMessages: [root, child],
      sessionNotifications: [],
      sessionAttentionRecords: [makeAttentionRecord({ id: "outside-root-window", createdAt: 900, updatedAt: 900 })],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["root-window-row"]);
    expect(model.attentionLedgerMessages).toEqual([]);
  });

  it("hides a fully resolved producer-shaped reminder from leader Main while retaining its decision record", () => {
    // The reminder is durable history, but ordinary Main should show only the
    // real resolved needs-input record. All Threads must retain the raw row.
    const timestamp = 100;
    const reminder = normalizeRawUserMessage(
      makeRawNeedsInputReminder({
        id: "needs-input-reminder-resolved",
        timestamp,
        totalCount: 1,
        entries: [{ id: "17", summary: "Choose rollout scope" }],
      }),
    );
    const resolvedNotification = makeNotification({
      id: "n-17",
      messageId: null,
      timestamp,
      summary: "Choose rollout scope",
      threadKey: "q-2028",
      questId: "q-2028",
      done: true,
    });

    const main = buildMessageModel({
      allMessages: [reminder],
      selectedFeedWindow: makeWindow({
        from_item: 0,
        item_count: 1,
        total_items: 1,
        source_history_length: 1,
      }),
      selectedFeedWindowMessages: [reminder],
      sessionNotifications: [resolvedNotification],
    });
    const all = buildMessageModel({
      allMessages: [reminder],
      threadKey: "all",
      selectedFeedWindowEnabled: false,
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [resolvedNotification],
    });

    expect(main.messagesAvailableForDerivation.map((message) => message.id)).toEqual([reminder.id]);
    expect(main.baseMessages.map((message) => message.id)).toEqual([reminder.id]);
    expect(main.visibleBaseMessages).toEqual([]);
    expect(main.attentionLedgerMessages).toEqual([
      expect.objectContaining({
        id: "attention-ledger:notification:n-17",
        metadata: expect.objectContaining({
          attentionRecord: expect.objectContaining({ type: "needs_input", state: "resolved" }),
        }),
      }),
    ]);
    expect(main.messages.map((message) => message.id)).toEqual(["attention-ledger:notification:n-17"]);
    expect(all.messages.map((message) => message.id)).toEqual([reminder.id]);
  });

  it("keeps active, partial, unavailable, and resolution-notice rows outside the narrow Main filter", () => {
    // Current producer headers include same-thread routing. Truncated reminders
    // must stay visible when an unlisted prompt is active, and the separate
    // resolution-notice source must never be swept into this cleanup.
    const activeReminder = normalizeRawUserMessage(
      makeRawNeedsInputReminder({
        id: "needs-input-reminder-active",
        timestamp: 200,
        totalCount: 1,
        entries: [{ id: "18", summary: "Active question" }],
      }),
    );
    const partialReminder = normalizeRawUserMessage(
      makeRawNeedsInputReminder({
        id: "needs-input-reminder-partial",
        timestamp: 400,
        totalCount: 4,
        entries: [
          { id: "6", summary: "Newest resolved question" },
          { id: "5", summary: "Second resolved question" },
          { id: "3", summary: "Third resolved question" },
        ],
      }),
    );
    const unavailableReminder = normalizeRawUserMessage(
      makeRawNeedsInputReminder({
        id: "needs-input-reminder-unavailable",
        timestamp: 500,
        totalCount: 1,
        entries: [{ id: "99", summary: "Unavailable question" }],
      }),
    );
    const resolutionNotice = makeMessage({
      id: "needs-input-resolution-notice",
      role: "user",
      content: "[Needs-input resolution notice]\nResolved same-session same-thread needs-input (main): 1.",
      timestamp: 600,
      agentSource: {
        sessionId: "system:needs-input-resolution",
        sessionLabel: "Needs Input Resolution",
      },
    });
    const model = buildMessageModel({
      allMessages: [activeReminder, partialReminder, unavailableReminder, resolutionNotice],
      selectedFeedWindowEnabled: false,
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [
        makeNotification({ id: "n-18", messageId: null, timestamp: 180, summary: "Active question" }),
        makeNotification({ id: "n-6", messageId: null, timestamp: 360, done: true }),
        makeNotification({ id: "n-5", messageId: null, timestamp: 350, done: true }),
        makeNotification({ id: "n-3", messageId: null, timestamp: 330, done: true }),
        makeNotification({ id: "n-1", messageId: null, timestamp: 300, summary: "Hidden active question" }),
      ],
    });

    expect(model.visibleBaseMessages.map((message) => message.id)).toEqual([
      activeReminder.id,
      partialReminder.id,
      unavailableReminder.id,
      resolutionNotice.id,
    ]);
  });

  it("keeps an active Main notification source visible when the selected window would otherwise omit it", () => {
    const proposal = makeMessage({
      id: "a-proposal",
      role: "assistant",
      content: "Proposed follow-up quest that needs approval.",
      timestamp: 100,
      historyIndex: 4,
    });
    const tail = makeMessage({
      id: "a-tail",
      role: "assistant",
      content: "Visible tail message.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [proposal, tail],
      selectedFeedWindowMessages: [tail],
      sessionNotifications: [makeNotification({ id: "n-main", messageId: proposal.id })],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "inactive-between-retained-source-and-window",
          state: "resolved",
          createdAt: 150,
          updatedAt: 150,
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-proposal", "a-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("derives exact unresolved needs-input anchors from sanitized owner-local notification state", () => {
    const questPrompt = makeMessage({
      id: "q-prompt",
      role: "assistant",
      content: "Quest decision prompt",
      timestamp: 100,
      historyIndex: 4,
    });
    const mutedQuestPrompt = makeMessage({
      id: "q-muted-prompt",
      role: "assistant",
      content: "Muted but unresolved quest prompt",
      timestamp: 110,
      historyIndex: 5,
    });
    const doneQuestPrompt = makeMessage({
      id: "q-done-prompt",
      role: "assistant",
      content: "Resolved quest prompt",
      timestamp: 120,
      historyIndex: 6,
    });
    const staleHerdAnchor = makeMessage({
      id: "stale-herd-anchor",
      role: "user",
      content: "1 event from 1 session\n\n#2594 | turn_end | complete",
      timestamp: 130,
      historyIndex: 7,
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      metadata: { threadRefs: [{ threadKey: "q-2040", questId: "q-2040", source: "explicit" }] },
    });
    const mainPrompt = makeMessage({
      id: "main-prompt",
      role: "assistant",
      content: "Main decision prompt",
      timestamp: 140,
      historyIndex: 8,
    });
    const selectedTail = makeMessage({
      id: "q-tail",
      role: "assistant",
      content: "Selected quest tail",
      timestamp: 200,
      historyIndex: 25,
      metadata: { threadRefs: [{ threadKey: "q-2040", questId: "q-2040", source: "explicit" }] },
    });
    const notifications = [
      makeNotification({ id: "n-q", messageId: questPrompt.id, threadKey: "q-2040", questId: "q-2040" }),
      makeNotification({
        id: "n-q-duplicate",
        messageId: questPrompt.id,
        threadKey: "q-2040",
        questId: "q-2040",
      }),
      makeNotification({
        id: "n-q-muted",
        messageId: mutedQuestPrompt.id,
        threadKey: "q-2040",
        questId: "q-2040",
        muted: true,
      }),
      makeNotification({
        id: "n-q-done",
        messageId: doneQuestPrompt.id,
        threadKey: "q-2040",
        questId: "q-2040",
        done: true,
      }),
      makeNotification({
        id: "n-stale-herd",
        messageId: staleHerdAnchor.id,
        threadKey: "q-2040",
        questId: "q-2040",
      }),
      makeNotification({ id: "n-main", messageId: mainPrompt.id, threadKey: "main" }),
      makeNotification({ id: "n-missing", messageId: "missing-q-anchor", threadKey: "q-2040", questId: "q-2040" }),
    ];

    const questModel = buildMessageModel({
      threadKey: "q-2040",
      allMessages: [questPrompt, mutedQuestPrompt, doneQuestPrompt, staleHerdAnchor, mainPrompt, selectedTail],
      selectedFeedWindow: makeWindow({ thread_key: "q-2040" }),
      selectedFeedWindowMessages: [selectedTail],
      sessionNotifications: notifications,
    });

    expect([...questModel.activeNeedsInputAnchorMessageIds]).toEqual([
      questPrompt.id,
      mutedQuestPrompt.id,
      "missing-q-anchor",
    ]);
    expect(questModel.visibleBaseMessages.map((message) => message.id)).toEqual([
      questPrompt.id,
      mutedQuestPrompt.id,
      selectedTail.id,
    ]);

    const mainModel = buildMessageModel({
      threadKey: "main",
      allMessages: [questPrompt, mutedQuestPrompt, doneQuestPrompt, staleHerdAnchor, mainPrompt, selectedTail],
      selectedFeedWindow: makeWindow({ thread_key: "main" }),
      selectedFeedWindowMessages: [],
      sessionNotifications: notifications,
    });

    expect([...mainModel.activeNeedsInputAnchorMessageIds]).toEqual([mainPrompt.id]);
    expect(mainModel.visibleBaseMessages.map((message) => message.id)).toEqual([mainPrompt.id]);
  });

  it("keeps an active Main review notification source as a normal feed event", () => {
    const reviewSource = makeMessage({
      id: "a-review-ready",
      role: "assistant",
      content: "q-1130 is ready for review.",
      timestamp: 100,
      historyIndex: 4,
    });
    const tail = makeMessage({
      id: "a-tail",
      role: "assistant",
      content: "Visible tail message.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [reviewSource, tail],
      selectedFeedWindowMessages: [tail],
      sessionNotifications: [
        makeNotification({
          id: "n-review",
          category: "review",
          messageId: reviewSource.id,
          summary: "q-1130 ready for review",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-review-ready", "a-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps an active Main notification source visible when Main opens before its selected window arrives", () => {
    const proposal = makeMessage({
      id: "a-main-checkpoint",
      role: "assistant",
      content: "Main checkpoint question that needs approval.",
      timestamp: 100,
      historyIndex: 4,
    });
    const rawTail = makeMessage({
      id: "a-raw-tail",
      role: "assistant",
      content: "Raw historical tail that still waits for the Main thread window.",
      timestamp: 200,
      historyIndex: 25,
    });
    const liveMarker = makeMessage({
      id: "a-live-marker",
      role: "assistant",
      content: "Live marker after reconnect.",
      timestamp: 300,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [proposal, rawTail, liveMarker],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [makeNotification({ id: "n-main", messageId: proposal.id })],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-checkpoint", "a-live-marker"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps windowed Main attention ledger rows bounded to producer-selected window timestamps", () => {
    const rawWindowStart = makeRawUserMessage({
      id: "u-visible-window-start",
      content: "Visible Main window start.",
      timestamp: 1_000,
    });
    const rawWindowEnd = makeRawUserMessage({
      id: "u-visible-window-end",
      content: "Visible Main window end.",
      timestamp: 1_100,
    });
    const window = makeWindow({
      from_item: 25,
      item_count: 2,
      total_items: 60,
      has_older_items: true,
      has_newer_items: true,
      source_history_length: 60,
    });
    const selectedFeedWindowMessages = [
      ...normalizeHistoryMessageToChatMessages(rawWindowStart, 25),
      ...normalizeHistoryMessageToChatMessages(rawWindowEnd, 26),
    ];

    const model = buildMessageModel({
      allMessages: [],
      selectedFeedWindow: window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "old-active-review",
          state: "unresolved",
          createdAt: 100,
          updatedAt: 100,
          title: "Old active review item",
        }),
        makeAttentionRecord({
          id: "old-active-needs-input",
          type: "needs_input",
          priority: "needs_input",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          title: "Old active needs-input item",
          actionLabel: "Answer",
        }),
        makeAttentionRecord({
          id: "in-window-review",
          state: "unresolved",
          createdAt: 1_050,
          updatedAt: 1_050,
          title: "In-window review item",
        }),
        makeAttentionRecord({
          id: "in-window-needs-input",
          type: "needs_input",
          priority: "needs_input",
          state: "unresolved",
          createdAt: 1_075,
          updatedAt: 1_075,
          title: "In-window needs-input item",
          actionLabel: "Answer",
        }),
        makeAttentionRecord({
          id: "after-window-resolved",
          state: "resolved",
          createdAt: 5_000,
          updatedAt: 5_000,
          title: "After-window resolved item",
        }),
      ],
    });

    expect(selectedFeedWindowMessages.map((message) => message.id)).toEqual([
      "u-visible-window-start",
      "u-visible-window-end",
    ]);
    expect(model.attentionLedgerMessages.map((message) => message.metadata?.attentionRecord?.id)).toEqual([
      "in-window-review",
      "in-window-needs-input",
    ]);
    expect(model.messages.map((message) => message.id)).toEqual([
      "u-visible-window-start",
      "attention-ledger:in-window-review",
      "attention-ledger:in-window-needs-input",
      "u-visible-window-end",
    ]);
  });

  it("keeps Journey-finished records hidden across selected Main windows", () => {
    const olderWindowStart = makeMessage({
      id: "a-older-window-start",
      role: "assistant",
      content: "Older Main window start.",
      timestamp: 1_000,
      historyIndex: 25,
    });
    const olderWindowEnd = makeMessage({
      id: "a-older-window-end",
      role: "assistant",
      content: "Older Main window end.",
      timestamp: 1_100,
      historyIndex: 26,
    });
    const journeyWindowStart = makeMessage({
      id: "a-journey-window-start",
      role: "assistant",
      content: "Journey window start.",
      timestamp: 4_900,
      historyIndex: 50,
    });
    const journeyWindowEnd = makeMessage({
      id: "a-journey-window-end",
      role: "assistant",
      content: "Journey window end.",
      timestamp: 5_100,
      historyIndex: 51,
    });
    const journeyFinished = makeNotification({
      id: "n-journey-finished",
      category: "review",
      messageId: null,
      summary: "q-1151 finished: Keep Journey chips anchored",
      timestamp: 5_000,
      threadKey: "q-1151",
      questId: "q-1151",
    });

    const olderModel = buildMessageModel({
      allMessages: [olderWindowStart, olderWindowEnd],
      selectedFeedWindowMessages: [olderWindowStart, olderWindowEnd],
      sessionNotifications: [journeyFinished],
    });
    const journeyModel = buildMessageModel({
      allMessages: [journeyWindowStart, journeyWindowEnd],
      selectedFeedWindowMessages: [journeyWindowStart, journeyWindowEnd],
      sessionNotifications: [journeyFinished],
    });

    expect(olderModel.attentionLedgerMessages).toHaveLength(0);
    expect(olderModel.messages.map((message) => message.id)).toEqual(["a-older-window-start", "a-older-window-end"]);
    expect(journeyModel.attentionRecords).toEqual([
      expect.objectContaining({ id: "notification:n-journey-finished", ledgerEligible: true }),
    ]);
    expect(journeyModel.attentionLedgerMessages).toHaveLength(0);
    expect(journeyModel.messages.map((message) => message.id)).toEqual([
      "a-journey-window-start",
      "a-journey-window-end",
    ]);
  });

  it("does not render Main ledger rows before selected-window timestamp bounds arrive", () => {
    const model = buildMessageModel({
      allMessages: [],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "old-resolved",
          state: "resolved",
          createdAt: 100,
          updatedAt: 100,
          title: "Old resolved item",
        }),
        makeAttentionRecord({
          id: "old-active",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          title: "Old active item",
        }),
      ],
    });

    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("does not derive cold Main ledger bounds from retained or live visible messages", () => {
    const retainedSource = makeMessage({
      id: "a-retained-main-source",
      role: "assistant",
      content: "Retained Main source.",
      timestamp: 100,
      historyIndex: -1,
    });
    const liveMessage = makeMessage({
      id: "a-live-main-message",
      role: "assistant",
      content: "Live Main output.",
      timestamp: 300,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [retainedSource, liveMessage],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "cold-start-active",
          state: "unresolved",
          createdAt: 50,
          updatedAt: 50,
          title: "Cold start active item",
        }),
        makeAttentionRecord({
          id: "pseudo-window-inactive",
          state: "resolved",
          createdAt: 150,
          updatedAt: 150,
          title: "Pseudo-window inactive item",
        }),
      ],
    });

    expect(model.attentionLedgerMessages).toHaveLength(0);
    expect(model.messages.map((message) => message.id)).toEqual(["a-retained-main-source", "a-live-main-message"]);
  });

  it("does not leak routed quest notification sources into the Main feed model", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });
    const mainTail = makeMessage({
      id: "a-main-tail",
      role: "assistant",
      content: "Main feed tail remains visible.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [questSource, mainTail],
      selectedFeedWindowMessages: [mainTail],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("does not leak routed quest notification sources during cold Main selected-feed startup", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });
    const liveMain = makeMessage({
      id: "a-main-live",
      role: "assistant",
      content: "Main live marker.",
      timestamp: 200,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [questSource, liveMain],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-live"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps backfilled source messages visible in Main without rendering attachment markers", () => {
    const mainSetup = makeMessage({
      id: "m-main",
      role: "user",
      content: "Main setup",
      timestamp: 100,
      historyIndex: 0,
    });
    const attached = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Main context attached to q-941",
      timestamp: 200,
      historyIndex: 1,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "1 message moved to q-941",
      timestamp: 300,
      historyIndex: 2,
      metadata: { threadAttachmentMarker: makeAttachmentMarker() },
    });

    const model = buildMessageModel({
      selectedFeedWindowEnabled: false,
      allMessages: [mainSetup, attached, marker],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["m-main", "m-attached"]);
  });

  it("uses server-retained selected-window Main attachment sources without rendering marker rows", () => {
    const attached = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Main context attached to q-941 from outside the selected window",
      timestamp: 100,
      historyIndex: 4,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
    });
    const questOnly = makeMessage({
      id: "m-quest-only",
      role: "assistant",
      content: "Future q-941-only response",
      timestamp: 120,
      historyIndex: 5,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "2 messages moved to q-941",
      timestamp: 300,
      historyIndex: 25,
      metadata: {
        threadAttachmentMarker: makeAttachmentMarker({
          messageIds: [attached.id, questOnly.id],
          firstMessageId: attached.id,
          count: 2,
        }),
      },
    });
    const tail = makeMessage({
      id: "a-visible-tail",
      role: "assistant",
      content: "Visible Main tail",
      timestamp: 400,
      historyIndex: 26,
    });

    const model = buildMessageModel({
      allMessages: [attached, questOnly, marker, tail],
      selectedFeedWindowMessages: [attached, tail],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["m-attached", "a-visible-tail"]);
  });

  it("keeps source and destination quest membership without rendering source attachment markers", () => {
    const sourceMessage = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Source quest context attached to q-941",
      timestamp: 200,
      historyIndex: 1,
      metadata: {
        threadRefs: [
          { threadKey: "q-940", questId: "q-940", source: "explicit" },
          { threadKey: "q-941", questId: "q-941", source: "backfill" },
        ],
      },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "1 message moved to q-941",
      timestamp: 300,
      historyIndex: 2,
      metadata: {
        threadAttachmentMarker: makeAttachmentMarker({ sourceThreadKey: "q-940", sourceQuestId: "q-940" }),
      },
    });

    const sourceModel = buildMessageModel({
      threadKey: "q-940",
      selectedFeedWindowEnabled: false,
      allMessages: [sourceMessage, marker],
      sessionNotifications: [],
    });
    const destinationModel = buildMessageModel({
      threadKey: "q-941",
      selectedFeedWindowEnabled: false,
      allMessages: [sourceMessage, marker],
      sessionNotifications: [],
    });

    expect(sourceModel.messages.map((message) => message.id)).toEqual(["m-attached"]);
    expect(destinationModel.messages.map((message) => message.id)).toEqual(["m-attached"]);
  });

  it("recovers routed notification sources for the owner quest thread without adding a fallback ledger row", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });

    const model = buildMessageModel({
      threadKey: "q-983",
      allMessages: [questSource],
      selectedFeedWindow: makeWindow({ thread_key: "q-983" }),
      selectedFeedWindowMessages: [],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-q983-plan"]);
    expect(model.messages[0]?.metadata?.threadRefs).toEqual([
      { threadKey: "q-983", questId: "q-983", source: "inferred" },
    ]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("uses a synthetic decision row when a needs-input notification points at a producer-shaped turn_end herd event", () => {
    const history: BrowserIncomingMessage[] = [
      makeRawUserMessage({
        id: "u-q1237",
        content: "Continue q-1237 review coordination.",
        timestamp: 100,
        threadKey: "q-1237",
      }),
      {
        type: "user_message",
        id: "herd-turn-end",
        content: "1 event from 1 session\n\n#1590 | turn_end | ✓ 2m 54s | tools: 30",
        timestamp: 200,
        agentSource: { sessionId: "herd-events" },
        threadKey: "q-1237",
        questId: "q-1237",
        threadRefs: [{ threadKey: "q-1237", questId: "q-1237", source: "explicit" }],
      },
    ];
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1237",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "q-1237",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [
        makeNotification({
          id: "n-q1237",
          messageId: "herd-turn-end",
          threadKey: "q-1237",
          questId: "q-1237",
          summary: "Approve q-1237 review handoff?",
        }),
      ],
    });

    expect(sync.entries.map((entry) => (entry.message as { id?: string }).id)).toEqual(["u-q1237", "herd-turn-end"]);
    expect(model.attentionRecords[0]?.route).toEqual({ threadKey: "q-1237", questId: "q-1237" });
    expect(model.attentionLedgerMessages.map((message) => message.id)).toEqual([
      "attention-ledger:notification:n-q1237",
    ]);
    expect(model.messages.map((message) => message.id)).toContain("herd-turn-end");
    expect(model.messages.map((message) => message.id)).toContain("attention-ledger:notification:n-q1237");
  });

  it("retains producer Journey lifecycle records without projecting standalone feed rows", () => {
    const journeyStarted = makeAttentionRecord({
      id: "board-journey-started:q-1353:100",
      type: "quest_journey_started",
      source: { kind: "board", id: "q-1353", questId: "q-1353", signature: "started:100" },
      questId: "q-1353",
      threadKey: "q-1353",
      title: "Journey started",
      summary: "Add voice input to needs-input custom answers",
      priority: "created",
      state: "resolved",
      createdAt: 100,
      updatedAt: 100,
      resolvedAt: 100,
      route: { threadKey: "q-1353", questId: "q-1353" },
      chipEligible: false,
      dedupeKey: "board-journey-started:q-1353:100",
    });
    const journeyFinished = makeAttentionRecord({
      id: "board-journey-finished:q-1353:200",
      type: "quest_completed_recent",
      source: { kind: "board", id: "q-1353", questId: "q-1353", signature: "finished:200" },
      questId: "q-1353",
      threadKey: "q-1353",
      title: "Journey finished",
      summary: "Add voice input to needs-input custom answers",
      priority: "review",
      state: "unresolved",
      createdAt: 200,
      updatedAt: 200,
      route: { threadKey: "q-1353", questId: "q-1353" },
      chipEligible: false,
      dedupeKey: "board-journey-finished:q-1353:200",
    });
    const journeyRestarted = makeAttentionRecord({
      ...journeyStarted,
      id: "board-journey-started:q-1353:300",
      source: { kind: "board", id: "q-1353", questId: "q-1353", signature: "started:300" },
      createdAt: 300,
      updatedAt: 300,
      resolvedAt: 300,
      dedupeKey: "board-journey-started:q-1353:300",
    });
    const commonInput = {
      allMessages: [
        makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests", timestamp: 50 }),
        makeMessage({
          id: "a-q1353",
          role: "assistant",
          content: "Quest-thread work update",
          timestamp: 150,
          metadata: {
            threadRefs: [{ threadKey: "q-1353", questId: "q-1353", source: "explicit" }],
          },
        }),
      ],
      sessionNotifications: [],
      sessionAttentionRecords: [journeyStarted, journeyFinished, journeyRestarted],
    };

    const main = buildMessageModel({ ...commonInput, threadKey: "main", selectedFeedWindowEnabled: false });
    const ownerThread = buildMessageModel({
      ...commonInput,
      threadKey: "q-1353",
      selectedFeedWindow: makeWindow({ thread_key: "q-1353" }),
    });
    const otherThread = buildMessageModel({
      ...commonInput,
      threadKey: "q-1354",
      selectedFeedWindow: makeWindow({ thread_key: "q-1354" }),
    });
    const allThreads = buildMessageModel({ ...commonInput, threadKey: "all", selectedFeedWindowEnabled: false });

    const ledgerIds = (model: ReturnType<typeof buildMessageModel>) =>
      model.attentionLedgerMessages.map((message) => message.metadata?.attentionRecord?.id);

    expect(main.attentionRecords.map((record) => [record.id, record.journeyLifecycleStatus])).toEqual([
      ["board-journey-started:q-1353:100", "completed"],
      ["board-journey-finished:q-1353:200", "completed"],
      ["board-journey-started:q-1353:300", "active"],
    ]);
    expect(ledgerIds(main)).toEqual([]);
    expect(ledgerIds(ownerThread)).toEqual([]);
    expect(ledgerIds(otherThread)).toEqual([]);
    expect(ledgerIds(allThreads)).toEqual([]);
    expect(ownerThread.messages.map((message) => message.id)).toContain("a-q1353");
    expect(ownerThread.messages.some((message) => message.id.startsWith("attention-ledger:"))).toBe(false);
  });

  it("derives bounded local section metadata separately from scroll/runtime behavior", () => {
    const turns = Array.from({ length: 8 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: false,
      historyWindow: null,
      selectedFeedWindow: null,
      historyLoading: false,
      messageCount: 16,
    });

    expect(model.sections).toHaveLength(4);
    expect(model.visibleSections.map((section) => section.id)).toEqual(["turn-3", "turn-5", "turn-7"]);
    expect(model.hasOlderSections).toBe(true);
    expect(model.hasNewerSections).toBe(false);
    expect(model.previousSectionStartIndex).toBe(0);
    expect(model.nextSectionStartIndex).toBe(2);
  });

  it("uses active selected-thread window metadata for older/newer boundaries", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: true,
      historyWindow: null,
      selectedFeedWindow: makeWindow({
        thread_key: "q-1027",
        from_item: 2,
        item_count: 6,
        total_items: 10,
        has_older_items: true,
        has_newer_items: true,
        section_item_count: 2,
        visible_item_count: 3,
      }),
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.visibleSections).toHaveLength(2);
    expect(model.hasOlderSections).toBe(true);
    expect(model.hasNewerSections).toBe(true);
    expect(model.previousSectionStartIndex).toBeNull();
    expect(model.nextSectionStartIndex).toBeNull();
  });

  it("uses explicit selected-thread availability as the canonical boundary state", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: true,
      historyWindow: null,
      selectedFeedWindow: makeWindow({
        thread_key: "q-1027",
        from_item: 2,
        item_count: 6,
        total_items: 10,
        has_older_items: false,
        has_newer_items: false,
      }),
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.hasOlderSections).toBe(false);
    expect(model.hasNewerSections).toBe(false);
  });

  it("uses explicit history-window availability as the canonical boundary state", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: false,
      historyWindow: {
        from_turn: 0,
        turn_count: 6,
        total_turns: 12,
        has_older_items: false,
        has_newer_items: false,
        start_index: 0,
        section_turn_count: 2,
        visible_section_count: 3,
      },
      selectedFeedWindow: null,
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.hasOlderSections).toBe(false);
    expect(model.hasNewerSections).toBe(false);
  });

  it("keeps canonical thread-window entry order aligned with the render-model target", () => {
    const rawThreadMessage = {
      type: "user_message",
      id: "u-q1080",
      content: "Selected thread message",
      timestamp: 100,
      threadKey: "q-1080",
      questId: "q-1080",
      threadRefs: [{ threadKey: "q-1080", questId: "q-1080", source: "explicit" }],
    } satisfies BrowserIncomingMessage;
    const sync = buildThreadWindowSync({
      messageHistory: [rawThreadMessage],
      threadKey: "q-1080",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 50,
      visibleItemCount: 3,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "q-1080",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });

    expect(sync.entries.map((entry) => (entry.message as { id?: string }).id)).toEqual(
      model.messages.map((message) => message.id),
    );
    expect(sync.window).toMatchObject({
      thread_key: "q-1080",
      from_item: 0,
      item_count: 1,
      total_items: 1,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 1,
    });
  });

  it("treats selected-thread window messages as an already routed local conversation", () => {
    const threadWindow = makeWindow({
      thread_key: "q-1080",
      from_item: 0,
      item_count: 1,
      total_items: 1,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: 4,
    });
    const localThreadMessage = makeMessage({
      id: "u-q1080",
      role: "user",
      content: "Selected thread request",
      timestamp: 100,
      historyIndex: 1,
      metadata: {
        threadKey: "q-1080",
        questId: "q-1080",
        threadRefs: [{ threadKey: "q-1080", questId: "q-1080", source: "explicit" }],
      },
    });
    const localUnroutedResult = makeMessage({
      id: "hist-result-2",
      role: "system",
      content: "Error: failed",
      timestamp: 101,
      historyIndex: 2,
    });
    const liveUnroutedTail = makeMessage({
      id: "live-main-tail",
      role: "assistant",
      content: "Main live tail",
      timestamp: 200,
      historyIndex: 4,
    });

    const model = buildMessageModel({
      threadKey: "q-1080",
      allMessages: [liveUnroutedTail],
      selectedFeedWindow: threadWindow,
      selectedFeedWindowMessages: [localThreadMessage, localUnroutedResult],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["u-q1080", "hist-result-2"]);
  });

  it("does not append indexed attached history after a newer bounded quest window", () => {
    // This mirrors the live q-1926 failure shape: early attached history remains
    // canonical, but a selected latest window must not append it after completion.
    const threadWindow = makeWindow({
      thread_key: "q-1926",
      from_item: 30,
      item_count: 2,
      total_items: 32,
      has_older_items: true,
      has_newer_items: false,
      source_history_length: 40,
    });
    const completion = makeMessage({
      id: "completion",
      role: "assistant",
      content: "q-1926 is complete",
      timestamp: 130,
      historyIndex: 38,
      metadata: { threadKey: "q-1926", questId: "q-1926" },
    });
    const quiz = makeMessage({
      id: "quiz",
      role: "assistant",
      content: "Quest quiz",
      timestamp: 131,
      historyIndex: 39,
      metadata: { threadKey: "q-1926", questId: "q-1926" },
    });
    const attachedRequest = makeMessage({
      id: "early-request",
      role: "user",
      content: "Prepare update slides",
      timestamp: 100,
      historyIndex: 1,
      metadata: { threadRefs: [{ threadKey: "q-1926", questId: "q-1926", source: "backfill" }] },
    });
    const reasoning = makeMessage({
      id: "early-reasoning",
      role: "assistant",
      content: "Preparing presentation materials",
      timestamp: 101,
      historyIndex: 2,
      metadata: {
        threadKey: "q-1926",
        questId: "q-1926",
        codexReasoningDetail: { status: "complete" },
      },
    });

    const model = buildMessageModel({
      threadKey: "q-1926",
      allMessages: [attachedRequest, reasoning, completion, quiz],
      selectedFeedWindow: threadWindow,
      selectedFeedWindowMessages: [completion, quiz],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["completion", "quiz"]);
  });

  it("retires an outbound notice when its selected thread has received a return transition", () => {
    const sourceMarker = makeTransitionMarker({
      id: "transition-q1139-q1141",
      sourceThreadKey: "q-1139",
      threadKey: "q-1141",
    });
    const inboundMarker = makeTransitionMarker({
      id: "transition-q1141-q1139",
      sourceThreadKey: "q-1141",
      threadKey: "q-1139",
    });
    const sync = buildThreadWindowSync({
      messageHistory: [sourceMarker, inboundMarker],
      threadKey: "q-1139",
      fromItem: 0,
      itemCount: 2,
      sectionItemCount: 50,
      visibleItemCount: 3,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "q-1139",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });

    expect(sync.entries).toEqual([]);
    expect(model.messages).toEqual([]);
  });

  it("projects producer-shaped Main-origin handoff markers in the Main selected window", () => {
    const mainToDestination = makeTransitionMarker({
      id: "transition-main-q948",
      sourceThreadKey: "main",
      threadKey: "q-948",
    });
    const unrelatedPair = makeTransitionMarker({
      id: "transition-q950-q951",
      sourceThreadKey: "q-950",
      threadKey: "q-951",
    });
    const history: BrowserIncomingMessage[] = [
      {
        type: "user_message",
        id: "main-request",
        content: "Please work on q-948",
        timestamp: 100,
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 110,
        message: {
          id: "main-tool-use",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "tool_use", id: "tool-view-image", name: "View", input: { file_path: "screenshot.png" } }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-view-image",
            content: "viewed screenshot",
            is_error: false,
            total_size: 17,
            is_truncated: false,
          },
        ],
      },
      mainToDestination,
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 130,
        threadKey: "q-948",
        questId: "q-948",
        threadRefs: [{ threadKey: "q-948", questId: "q-948", source: "explicit" }],
        message: {
          id: "destination-output",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "Continuing in q-948" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      unrelatedPair,
    ];
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "main",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });

    expect(sync.entries.map((entry) => (entry.message as { id?: string }).id)).toEqual([
      "main-request",
      undefined,
      undefined,
      "transition-main-q948",
    ]);
    expect(model.messages.map((message) => message.id)).toEqual([
      "main-request",
      "main-tool-use",
      "transition-main-q948",
    ]);
    expect(model.messages.map((message) => message.content)).toContain("Work continued from Main to thread:q-948");
    expect(model.messages.map((message) => message.content)).not.toContain("Continuing in q-948");
    expect(model.messages.map((message) => message.content)).not.toContain(
      "Work continued from thread:q-950 to thread:q-951",
    );
  });

  it("keeps a historical quest event out of a later unrelated Main handoff", () => {
    // This is the screenshot sequence from q-2008 in producer form: the q-2003
    // lifecycle row predates the Main-to-q-2006 dispatch and remains owner-routed.
    const q2003Event: BrowserIncomingMessage = {
      type: "quest_lifecycle_event",
      id: "quest-lifecycle-q2003",
      timestamp: 100,
      kind: "submitted",
      quest: { questId: "q-2003", title: "Diagnose recurring alerts", status: "done" },
      threadKey: "q-2003",
      questId: "q-2003",
      threadRefs: [{ threadKey: "q-2003", questId: "q-2003", source: "explicit" }],
    };
    const history: BrowserIncomingMessage[] = [
      q2003Event,
      makeRawUserMessage({ id: "u-main-q2006", content: "Create q-2006", timestamp: 200 }),
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 300,
        message: {
          id: "a-main-q2006",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "Creating and dispatching q-2006" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      makeTransitionMarker({ id: "transition-main-q2006", sourceThreadKey: "main", threadKey: "q-2006" }),
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 400,
        threadKey: "q-2006",
        questId: "q-2006",
        threadRefs: [{ threadKey: "q-2006", questId: "q-2006", source: "explicit" }],
        message: {
          id: "a-q2006",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "q-2006 is dispatched" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ];
    const modelFor = (threadKey: string) => {
      const sync = buildThreadWindowSync({
        messageHistory: history,
        threadKey,
        fromItem: 0,
        itemCount: 10,
        sectionItemCount: 10,
        visibleItemCount: 3,
      });
      const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
        normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
      );
      return buildMessageModel({
        threadKey,
        allMessages: threadKey === "all" ? selectedFeedWindowMessages : [],
        selectedFeedWindowEnabled: threadKey !== "all",
        selectedFeedWindow: threadKey === "all" ? null : sync.window,
        selectedFeedWindowMessages,
        sessionNotifications: [],
      });
    };

    expect(modelFor("main").messages.map((message) => message.id)).toEqual([
      "u-main-q2006",
      "a-main-q2006",
      "transition-main-q2006",
    ]);
    expect(modelFor("q-2003").messages.map((message) => message.id)).toEqual(["quest-lifecycle-q2003"]);
    expect(modelFor("q-2006").messages.map((message) => message.id)).toEqual(["a-q2006"]);
    expect(modelFor("all").messages.map((message) => message.id)).toContain("quest-lifecycle-q2003");
  });

  it("anchors producer-shaped historical result errors before later recovered output in selected Main windows", () => {
    // Historical `result` rows do not carry their own timestamp. This mirrors
    // session 1401: two failed result rows at 17:42 followed by recovered output
    // at 17:44 should stay in conversation order even if replay normalization
    // happens later and assigns the errors a newer client timestamp.
    const now = vi.spyOn(Date, "now").mockReturnValue(3000);
    const history: BrowserIncomingMessage[] = [
      {
        type: "user_message",
        id: "timer-t53",
        content: "Backstop q1175 dashboard",
        timestamp: 1000,
      },
      makeErrorResult(
        "stream disconnected before completion: error sending request for url (http://localhost:4000/responses)",
      ),
      {
        type: "user_message",
        id: "herd-after-error",
        content: "Worker turn_end and session_error summary",
        timestamp: 1100,
      },
      makeErrorResult(
        "stream disconnected before completion: error sending request for url (http://localhost:4000/responses)",
      ),
      {
        type: "user_message",
        id: "server-restarted",
        content: "server restarted. continue ongoing work",
        timestamp: 2000,
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 2100,
        message: {
          id: "recovered-output",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "Ongoing work is continuing after the restart." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ];
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "main",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });
    const ids = model.messages.map((message) => message.id);

    expect(ids.indexOf("hist-error-1")).toBeGreaterThan(ids.indexOf("timer-t53"));
    expect(ids.indexOf("hist-error-1")).toBeLessThan(ids.indexOf("server-restarted"));
    expect(ids.indexOf("hist-error-3")).toBeGreaterThan(ids.indexOf("herd-after-error"));
    expect(ids.indexOf("hist-error-3")).toBeLessThan(ids.indexOf("server-restarted"));
    expect(ids.indexOf("recovered-output")).toBeGreaterThan(ids.indexOf("server-restarted"));
    now.mockRestore();
  });
});
