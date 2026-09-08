import { describe, expect, it } from "vitest";
import {
  extractActivityPreview,
  getAssistantContentAppendBlocks,
  handleAssistantMessage,
  handleAssistantMessageWithRuntime,
  type AssistantMessageSessionLike,
} from "./claude-message-controller.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import type { BrowserIncomingMessage, CLIAssistantMessage, ContentBlock } from "../session-types.js";
import { buildLeaderThreadResponseState, finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";

function makeSession(): AssistantMessageSessionLike {
  return {
    id: "s-assistant",
    backendType: "claude",
    cliResuming: false,
    dropReplayHistoryAfterRevert: false,
    isGenerating: false,
    messageHistory: [],
    assistantAccumulator: new Map(),
    toolStartTimes: new Map(),
    toolProgressOutput: new Map(),
    diffStatsDirty: false,
    lastActivityPreview: undefined,
    state: {
      model: "claude-sonnet-4-5-20250929",
      context_used_percent: 0,
    },
  };
}

function makeAssistant(
  content: ContentBlock[],
  id = `assistant-${Math.random().toString(36).slice(2)}`,
): CLIAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `${id}-uuid`,
    session_id: "s-assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function makeThreadStatus({
  kind = "waiting",
  threadKey,
  summary = kind === "waiting" ? "waiting on reviewer pass" : "ready for review",
  messageId = "status-old",
  timestamp = 10,
}: {
  kind?: LeaderThreadStatus["kind"];
  threadKey: string;
  summary?: string;
  messageId?: string;
  timestamp?: number;
}): LeaderThreadStatus {
  return {
    kind,
    label: kind === "waiting" ? "Thread Waiting" : "Thread Ready",
    threadKey,
    ...(threadKey !== "main" ? { questId: threadKey } : {}),
    summary,
    messageId,
    timestamp,
    updatedAt: timestamp,
  };
}

function routeAssistantMessage(
  session: AssistantMessageSessionLike,
  content: ContentBlock[],
  overrides: Partial<Parameters<typeof handleAssistantMessage>[2]> = {},
): BrowserIncomingMessage {
  const broadcasts: BrowserIncomingMessage[] = [];
  handleAssistantMessage(session, makeAssistant(content), {
    hasAssistantReplay: () => false,
    getLauncherSessionInfo: () => null,
    broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
    persistSession: () => {},
    ...overrides,
  });
  expect(broadcasts).toHaveLength(1);
  return broadcasts[0];
}

describe("assistant-message-controller", () => {
  // Validates that replayed assistant snapshots only append genuinely new blocks
  // and do not re-emit previously-seen tool_use IDs when the same message arrives in parts.
  it("appends only novel assistant content blocks after overlap while deduping repeated tool_use ids", () => {
    const seenToolUseIds = new Set(["tool-1"]);
    const append = getAssistantContentAppendBlocks(
      [
        { type: "text", text: "alpha" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
      ] as any,
      [
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        { type: "text", text: "beta" },
        { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
      ] as any,
      seenToolUseIds,
    );

    expect(append).toEqual([
      { type: "text", text: "beta" },
      { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
    ]);
    expect(seenToolUseIds.has("tool-2")).toBe(true);
  });

  it("keeps one explicit answer intent across cumulative same-id chunks", () => {
    const session = makeSession() as AssistantMessageSessionLike & {
      userMessageIdsThisTurn: number[];
      messageCountAtTurnStart: number;
    };
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "user_message",
      id: "raw-u1",
      leaderUserMessageId: "u1",
      content: "Please answer.",
      timestamp: 1,
      threadKey: "main",
      leaderResponseCoverageVersion: 1,
    });
    session.userMessageIdsThisTurn = [0];
    session.messageCountAtTurnStart = 1;
    const deps = {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: () => {},
      persistSession: () => {},
    };
    const first = makeAssistant([{ type: "text", text: "[thread:main:A:u1]\nFirst half." }], "chunked-final");
    const second = makeAssistant(
      [
        { type: "text", text: "[thread:main:A:u1]\nFirst half." },
        { type: "text", text: "Second half." },
      ],
      "chunked-final",
    );

    handleAssistantMessage(session, first, deps);
    handleAssistantMessage(session, second, deps);

    const response = session.messageHistory.find(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> =>
        entry.type === "assistant" && entry.message.id === "chunked-final",
    )!;
    expect(response).toMatchObject({
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
      leaderAnswerObservedHistoryLength: 1,
    });
    expect(response.threadAnswer).toBeUndefined();
    expect(response.message.content).toEqual([
      { type: "text", text: "First half." },
      { type: "text", text: "Second half." },
    ]);
    expect(finalizeRoutedLeaderResponseMessage(session, response)).toMatchObject({ finalized: true });
    expect(response.threadAnswer).toEqual({
      version: 2,
      answerUserMessageIds: ["u1"],
      observedHistoryLength: 1,
      authoredThreadKey: "main",
      ownerGroups: [{ threadKey: "main", userMessageIds: ["u1"] }],
    });
  });

  // Covers the two supported task-preview sources so push-notification context
  // stays aligned whether the assistant emitted TodoWrite or TaskUpdate blocks.
  it("extracts the active preview from TodoWrite and TaskUpdate tool_use blocks", () => {
    const session = makeSession();

    extractActivityPreview(session, [
      {
        type: "tool_use",
        name: "TodoWrite",
        input: {
          todos: [
            { status: "pending", content: "later" },
            { status: "in_progress", activeForm: "Reviewing the merged assistant payload" },
          ],
        },
      },
    ]);
    expect(session.lastActivityPreview).toBe("Reviewing the merged assistant payload");

    extractActivityPreview(session, [
      {
        type: "tool_use",
        name: "TaskUpdate",
        input: {
          status: "in_progress",
          activeForm: "Finishing the next ws-bridge controller slice",
        },
      },
    ]);
    expect(session.lastActivityPreview).toBe("Finishing the next ws-bridge controller slice");
  });

  it("notifies runtime deps only for newly observed tool_use blocks", () => {
    const session = makeSession();
    const observed: string[] = [];
    const deps = {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: () => {},
      persistSession: () => {},
      setGenerating: () => {},
      broadcastStatusRunning: () => {},
      onToolUseObserved: (_session: AssistantMessageSessionLike, block: { id?: string }) => {
        if (block.id) observed.push(block.id);
      },
    };

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 61" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 61" } },
            { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "a.ts" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    expect(observed).toEqual(["tool-1", "tool-2"]);
  });

  it("drops id-less assistant replay while post-revert replay suppression is active", () => {
    const session = makeSession();
    session.cliResuming = true;
    session.dropReplayHistoryAfterRevert = true;
    const deps = {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: () => {},
      persistSession: () => {},
      setGenerating: () => {},
      broadcastStatusRunning: () => {},
      onToolUseObserved: () => {},
    };

    handleAssistantMessageWithRuntime(
      session,
      {
        type: "assistant",
        uuid: "sdk-replayed-no-id",
        parent_tool_use_id: null,
        message: {
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "stale replayed assistant" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      } as any,
      deps,
    );

    expect(session.messageHistory).toHaveLength(0);
  });

  it("keeps explicit answer syntax leader-only", () => {
    const session = makeSession();
    session.state.isOrchestrator = false;

    handleAssistantMessage(
      session,
      makeAssistant([{ type: "text", text: "[thread:main:A:u1] Ordinary standalone prose." }], "non-leader-answer"),
      { hasAssistantReplay: () => false, broadcastToBrowsers: () => {}, persistSession: () => {} },
    );

    const message = session.messageHistory.find(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> => entry.type === "assistant",
    )!;
    expect(message.leaderThreadRole).toBeUndefined();
    expect(message.threadAnswer).toBeUndefined();
    expect(message.message.content).toEqual([{ type: "text", text: "[thread:main:A:u1] Ordinary standalone prose." }]);
  });

  it("strips leader thread text prefixes and persists quest thread metadata", () => {
    // The controller path, not only the parser, must store the routed body and
    // metadata that drive quest-thread projections in the UI.
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nRouted update" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Routed update" },
    ]);
    expect(session.messageHistory[0]).toMatchObject(msg);
  });

  it("strips valid inline thread status markers and defers status until turn completion", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        {
          type: "text",
          text: [
            "[thread:q-941:C]",
            "Dispatched reviewer.",
            "{[(Thread Waiting: q-941 | waiting on reviewer pass)]}",
          ].join("\n"),
        },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistant = broadcasts.find((msg) => msg.type === "assistant");
    expect(assistant).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      deferredThreadStatusMarkers: [
        {
          kind: "waiting",
          label: "Thread Waiting",
          target: { threadKey: "q-941", questId: "q-941" },
          summary: "waiting on reviewer pass",
        },
      ],
    });
    expect(assistant?.type === "assistant" ? assistant.message.content : []).toEqual([
      { type: "text", text: "Dispatched reviewer." },
    ]);
    expect(session.state.leaderThreadStatuses?.["q-941"]).toBeUndefined();
    expect(broadcasts.some((message) => message.type === "session_update")).toBe(false);
  });

  it("strips standalone Thread Ready markers even when the response has no routed prose", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: "  {[(Thread Ready: q-1259 | clarified routing markers are separate from Thread Waiting/Ready status markers)]}  ",
          },
        ],
        "standalone-ready",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistant = broadcasts.find((msg) => msg.type === "assistant");
    expect(assistant).toMatchObject({
      type: "assistant",
      deferredThreadStatusMarkers: [
        {
          kind: "ready",
          label: "Thread Ready",
          target: { threadKey: "q-1259", questId: "q-1259" },
          summary: "clarified routing markers are separate from Thread Waiting/Ready status markers",
        },
      ],
    });
    expect(assistant?.type === "assistant" ? assistant.message.content : []).toEqual([]);
    expect(assistant?.type === "assistant" ? assistant.threadRefs : undefined).toBeUndefined();
    expect(assistant?.type === "assistant" ? assistant.threadKey : undefined).toBeUndefined();
    expect(session.state.leaderThreadStatuses?.["q-1259"]).toBeUndefined();
  });

  it("defers Thread Ready unread attention until the turn result is successful", () => {
    const session = makeSession() as AssistantMessageSessionLike & {
      notifications: any[];
      notificationCounter: number;
      attentionReason: "action" | "error" | "review" | null;
    };
    session.state.isOrchestrator = true;
    session.notifications = [];
    session.notificationCounter = 0;
    session.attentionReason = null;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        {
          type: "text",
          text: "[thread:q-1539:C]\nDone.\n{[(Thread Ready: q-1539 | quest complete)]}",
        },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    expect(session.notifications).toEqual([]);
    expect(session.attentionReason).toBeNull();
    expect(broadcasts.find((message) => message.type === "assistant")).toMatchObject({
      type: "assistant",
      deferredThreadStatusMarkers: [
        expect.objectContaining({ kind: "ready", target: expect.objectContaining({ threadKey: "q-1539" }) }),
      ],
    });
    expect(broadcasts.some((message) => message.type === "notification_update")).toBe(false);
  });

  it("does not let cross-thread status markers route ordinary Main-thread prose", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        {
          type: "text",
          text: [
            "Waiting on your confirmation for the restart-prep reliability quest proposal.",
            "{[(Thread Waiting: q-1262 | rework Implement queued to worker)]}",
          ].join("\n"),
        },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const msg = broadcasts.find((message) => message.type === "assistant");
    expect(msg).toBeDefined();

    expect(msg!).toMatchObject({
      type: "assistant",
      deferredThreadStatusMarkers: [
        expect.objectContaining({
          kind: "waiting",
          target: { threadKey: "q-1262", questId: "q-1262" },
          summary: "rework Implement queued to worker",
        }),
      ],
    });
    expect(msg!.type === "assistant" ? msg!.message.content : []).toEqual([
      { type: "text", text: "Waiting on your confirmation for the restart-prep reliability quest proposal." },
    ]);
    expect(msg!.type === "assistant" ? msg!.threadRefs : undefined).toBeUndefined();
    expect(msg!.type === "assistant" ? msg!.threadKey : undefined).toBeUndefined();
  });

  it("keeps invalid marker-looking lines visible and does not create Thread Needs Input status", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
      { type: "text", text: "Status typo\n{[(Thread Needs Input: main | ask user)]}" },
    ]);

    expect(msg.type === "assistant" ? msg.message.content : []).toEqual([
      { type: "text", text: "Status typo\n{[(Thread Needs Input: main | ask user)]}" },
    ]);
    expect(msg.type === "assistant" ? msg.threadStatusMarkers : undefined).toBeUndefined();
    expect(session.state.leaderThreadStatuses).toBeUndefined();
  });

  it("supports multiple thread statuses in one assistant response and newest status wins per thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        {
          type: "text",
          text: [
            "Batch update.",
            "{[(Thread Waiting: q-941 | waiting on reviewer pass)]}",
            "{[(Thread Ready: q-942 | implementation complete)]}",
            "{[(Thread Ready: q-941 | review accepted)]}",
          ].join("\n"),
        },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistant = broadcasts.find((msg) => msg.type === "assistant");
    expect(
      assistant?.type === "assistant"
        ? assistant.deferredThreadStatusMarkers?.map((status) => status.target.threadKey)
        : [],
    ).toEqual(["q-941", "q-942", "q-941"]);
    expect(session.state.leaderThreadStatuses?.["q-941"]).toBeUndefined();
    expect(session.state.leaderThreadStatuses?.["q-942"]).toBeUndefined();
    expect(assistant?.type === "assistant" ? assistant.threadRefs : undefined).toBeUndefined();
    expect(assistant?.type === "assistant" ? assistant.threadKey : undefined).toBeUndefined();
  });

  it("preserves unrelated thread statuses when routed output touches a different thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const existing = makeThreadStatus({ threadKey: "q-941", summary: "worker still running" });
    session.state.leaderThreadStatuses = { "q-941": existing };
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(session, makeAssistant([{ type: "text", text: "[thread:q-942:C]\nReviewer dispatched." }]), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });

    expect(session.state.leaderThreadStatuses).toEqual({ "q-941": existing });
    expect(broadcasts.some((msg) => msg.type === "session_update")).toBe(false);
  });

  it("clears a same-thread status when fresh routed tool activity begins", () => {
    // Live q-1850 regression: a user posted a screenshot, then the leader's
    // routed view_image tool appeared while the previous Ready footer remained.
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.state.leaderThreadStatuses = {
      "q-1850": makeThreadStatus({ kind: "ready", threadKey: "q-1850", summary: "evidence matching explained" }),
    };
    session.messageHistory.push({
      type: "user_message",
      id: "fresh-user",
      content: "Has this fix been deployed?",
      timestamp: 20,
      threadKey: "q-1850",
      questId: "q-1850",
    });
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([{ type: "tool_use", id: "view-1", name: "view_image", input: { path: "/tmp/evidence.png" } }]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    expect(session.state.leaderThreadStatuses?.["q-1850"]).toBeUndefined();
    expect(broadcasts).toEqual([
      expect.objectContaining({ type: "assistant", threadKey: "q-1850", questId: "q-1850" }),
    ]);
  });

  it("preserves another thread's status when routed tool activity begins", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const existing = makeThreadStatus({ kind: "waiting", threadKey: "q-1850", summary: "waiting on worker" });
    session.state.leaderThreadStatuses = { "q-1850": existing };
    session.messageHistory.push({
      type: "user_message",
      id: "other-user",
      content: "Inspect this screenshot",
      timestamp: 20,
      threadKey: "q-1851",
      questId: "q-1851",
    });
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([{ type: "tool_use", id: "view-2", name: "view_image", input: { path: "/tmp/other.png" } }]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    expect(session.state.leaderThreadStatuses).toEqual({ "q-1850": existing });
    expect(broadcasts.some((msg) => msg.type === "session_update")).toBe(false);
  });

  it("clears a same-thread status when fresh routed output has no marker", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.state.leaderThreadStatuses = {
      "q-941": makeThreadStatus({ threadKey: "q-941", summary: "old status" }),
    };
    const broadcasts: BrowserIncomingMessage[] = [];
    const invalidateLeaderThreadTabsForSession = vi.fn();

    handleAssistantMessage(
      session,
      makeAssistant([{ type: "text", text: "[thread:q-941:C]\nImplementation update." }]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
        invalidateLeaderThreadTabsForSession,
      },
    );

    expect(session.state.leaderThreadStatuses?.["q-941"]).toBeUndefined();
    expect(invalidateLeaderThreadTabsForSession).toHaveBeenCalledWith(session.id);
    expect(broadcasts.some((message) => message.type === "session_update")).toBe(false);
  });

  it("clears only routed activity threads across a split leader response", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const untouched = makeThreadStatus({ threadKey: "q-943", summary: "unrelated wait" });
    session.state.leaderThreadStatuses = {
      "q-941": makeThreadStatus({ threadKey: "q-941", summary: "old q-941" }),
      "q-942": makeThreadStatus({ kind: "ready", threadKey: "q-942", summary: "old q-942" }),
      "q-943": untouched,
    };
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        { type: "text", text: "[thread:q-941:C]\nChecking q-941.\n---\n[thread:q-942:C]" },
        { type: "tool_use", id: "view-split", name: "view_image", input: { path: "/tmp/q-942.png" } },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    expect(session.state.leaderThreadStatuses).toEqual({ "q-943": untouched });
    expect(
      broadcasts
        .filter((msg) => msg.type === "assistant")
        .map((msg) => (msg.type === "assistant" ? msg.threadKey : null)),
    ).toEqual(["q-941", "q-942"]);
  });

  it("replaces a same-thread status when fresh routed output has a new marker", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.state.leaderThreadStatuses = {
      "q-941": makeThreadStatus({ kind: "waiting", threadKey: "q-941", summary: "old status" }),
    };
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant([
        {
          type: "text",
          text: "[thread:q-941:C]\nImplementation complete.\n{[(Thread Ready: q-941 | ready for review)]}",
        },
      ]),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    expect(session.state.leaderThreadStatuses?.["q-941"]).toBeUndefined();
    expect(broadcasts.find((msg) => msg.type === "assistant")).toMatchObject({
      type: "assistant",
      deferredThreadStatusMarkers: [
        expect.objectContaining({ kind: "ready", target: { threadKey: "q-941", questId: "q-941" } }),
      ],
    });
  });

  it("updates the active running route when leader assistant output is routed to a quest thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.isGenerating = true;
    session.activeTurnRoute = { threadKey: "main" };
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(session, makeAssistant([{ type: "text", text: "[thread:q-941:C]\nRouted update" }]), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });

    expect(session.activeTurnRoute).toEqual({ threadKey: "q-941", questId: "q-941" });
    expect(broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assistant", threadKey: "q-941", questId: "q-941" }),
        expect.objectContaining({
          type: "status_change",
          status: "running",
          activeTurnRoute: { threadKey: "q-941", questId: "q-941" },
        }),
      ]),
    );
  });

  it("persists source-thread transition markers before routed quest handoffs", () => {
    // When a leader thread moves from one quest to another, the source thread
    // needs a durable handoff marker so the UI does not look like it stopped.
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "previous-q940", content: [] } as any,
      threadKey: "q-940",
      questId: "q-940",
      threadRefs: [{ threadKey: "q-940", questId: "q-940", source: "explicit" }],
    });
    session.messageHistory.push({ type: "tool_result_preview", previews: [] });
    const broadcasts: BrowserIncomingMessage[] = [];
    const promoteLeaderThreadTabForTransition = vi.fn();

    handleAssistantMessage(session, makeAssistant([{ type: "text", text: "[thread:q-941:C]\nDispatching worker" }]), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
      promoteLeaderThreadTabForTransition,
    });

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toMatchObject({
      type: "thread_transition_marker",
      sourceThreadKey: "q-940",
      sourceQuestId: "q-940",
      threadKey: "q-941",
      questId: "q-941",
      reason: "route_switch",
    });
    expect(broadcasts[1]).toMatchObject({ type: "assistant", threadKey: "q-941", questId: "q-941" });
    expect(session.messageHistory).toHaveLength(4);
    expect(session.messageHistory[2]).toMatchObject({ type: "thread_transition_marker" });
    expect(promoteLeaderThreadTabForTransition).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ threadKey: "q-941", sourceThreadKey: "q-940" }),
    );
  });

  it("persists Main-origin transition markers after a Main request routes into a quest thread", () => {
    // Production can route a Main request through one or more Main tool rows
    // before the leader starts writing in the quest thread. Main still needs a
    // source-visible handoff marker so the original tab does not look stalled.
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "user_message",
      id: "main-request",
      content: "Please work on q-948",
      timestamp: 1,
    });
    session.messageHistory.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "main-tool-use",
        content: [{ type: "tool_use", id: "tool-view-image", name: "View", input: { file_path: "screenshot.png" } }],
      } as any,
    });
    session.messageHistory.push({
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
    });
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(session, makeAssistant([{ type: "text", text: "[thread:q-948:C]\nContinuing there" }]), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toMatchObject({
      type: "thread_transition_marker",
      sourceThreadKey: "main",
      threadKey: "q-948",
      questId: "q-948",
      reason: "route_switch",
      sourceMessageIndex: 0,
      targetThreadFreshness: "new_quest_thread",
    });
    expect(broadcasts[0]).not.toHaveProperty("sourceQuestId");
    expect(broadcasts[1]).toMatchObject({ type: "assistant", threadKey: "q-948", questId: "q-948" });
    expect(session.messageHistory[3]).toMatchObject({ type: "thread_transition_marker", sourceThreadKey: "main" });
  });

  it("marks Main-origin transition markers to prior quest targets as existing", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "previous-q948", content: [] } as any,
      threadKey: "q-948",
      questId: "q-948",
      threadRefs: [{ threadKey: "q-948", questId: "q-948", source: "explicit" }],
    });
    session.messageHistory.push({
      type: "user_message",
      id: "main-request",
      content: "Please continue the existing quest",
      timestamp: 1,
    });
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(session, makeAssistant([{ type: "text", text: "[thread:q-948:C]\nContinuing there" }]), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });

    expect(broadcasts[0]).toMatchObject({
      type: "thread_transition_marker",
      sourceThreadKey: "main",
      threadKey: "q-948",
      targetThreadFreshness: "existing_quest_thread",
    });
    expect(broadcasts[1]).toMatchObject({ type: "assistant", threadKey: "q-948", questId: "q-948" });
  });

  it("does not infer source-thread transition markers across Main assistant boundaries", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "previous-q940", content: [] } as any,
      threadKey: "q-940",
      questId: "q-940",
      threadRefs: [{ threadKey: "q-940", questId: "q-940", source: "explicit" }],
    });

    routeAssistantMessage(session, [{ type: "text", text: "Global Main update" }]);
    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nSeparate quest update" }]);

    expect(msg).toMatchObject({ type: "assistant", threadKey: "q-941", questId: "q-941" });
    expect(session.messageHistory).toHaveLength(3);
    expect(session.messageHistory.some((entry) => entry.type === "thread_transition_marker")).toBe(false);
  });

  it("strips same-line leader thread prefixes and persists quest thread metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C] Same-line routed update" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Same-line routed update" },
    ]);
  });

  it("routes post-quiz thread marker prose into the target quest thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: [
              "[thread:q-1567:C]",
              "[q-1567](quest:q-1567) is complete.",
              "",
              "{[(Quest Quiz: q-1567)]}",
              "[thread:q-1570:C] [q-1570](quest:q-1570) is dispatched.",
            ].join("\n"),
          },
        ],
        "post-quiz-route",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistantBroadcasts = broadcasts.filter((msg) => msg.type === "assistant");
    expect(assistantBroadcasts).toHaveLength(2);
    expect(assistantBroadcasts[0]).toMatchObject({
      type: "assistant",
      threadKey: "q-1567",
      questId: "q-1567",
    });
    expect(assistantBroadcasts[0]?.type === "assistant" ? assistantBroadcasts[0].message.content : []).toEqual([
      {
        type: "text",
        text: "[q-1567](quest:q-1567) is complete.\n\n{[(Quest Quiz: q-1567)]}",
      },
    ]);
    expect(assistantBroadcasts[1]).toMatchObject({
      type: "assistant",
      threadKey: "q-1570",
      questId: "q-1570",
    });
    expect(assistantBroadcasts[1]?.type === "assistant" ? assistantBroadcasts[1].message.content : []).toEqual([
      { type: "text", text: "[q-1570](quest:q-1570) is dispatched." },
    ]);
    expect(JSON.stringify(session.messageHistory)).not.toContain("[thread:q-1570:C]");
    expect(session.messageHistory.some((entry) => entry.type === "thread_transition_marker")).toBe(true);
  });

  it("splits mid-message leader thread routes on a standalone divider and line-start marker", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: [
              "[thread:q-1695:C]",
              "Approved Option A is recorded.",
              "---",
              "[thread:q-1693:C]No separator still routes after the split divider.",
            ].join("\n"),
          },
        ],
        "mid-message-route",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistantBroadcasts = broadcasts.filter((msg) => msg.type === "assistant");
    expect(assistantBroadcasts).toHaveLength(2);
    expect(assistantBroadcasts[0]).toMatchObject({ type: "assistant", threadKey: "q-1695", questId: "q-1695" });
    expect(assistantBroadcasts[0]?.type === "assistant" ? assistantBroadcasts[0].message.content : []).toEqual([
      { type: "text", text: "Approved Option A is recorded." },
    ]);
    expect(assistantBroadcasts[1]).toMatchObject({ type: "assistant", threadKey: "q-1693", questId: "q-1693" });
    expect(assistantBroadcasts[1]?.type === "assistant" ? assistantBroadcasts[1].message.content : []).toEqual([
      { type: "text", text: "No separator still routes after the split divider." },
    ]);
    expect(JSON.stringify(session.messageHistory)).not.toContain("[thread:q-1693:C]");
    expect(session.messageHistory.some((entry) => entry.type === "thread_transition_marker")).toBe(true);
  });

  it.each([
    ["divider / invalid role", ["---"], "[thread:q-1693:X] Invalid role.", "invalid_role", undefined],
    ["divider / unknown target", ["---"], "[thread:side:A:u1] Unknown target.", "invalid", undefined],
    ["divider / missing role", ["---"], "[thread:q-1693] Missing role.", "missing_role", "q-1693"],
    ["quiz / invalid role", ["{[(Quest Quiz: q-1695)]}"], "[thread:q-1693:X] Invalid role.", "invalid_role", undefined],
    ["quiz / unknown target", ["{[(Quest Quiz: q-1695)]}"], "[thread:side:A:u1] Unknown target.", "invalid", undefined],
    ["quiz / missing role", ["{[(Quest Quiz: q-1695)]}"], "[thread:q-1693] Missing role.", "missing_role", "q-1693"],
  ] as const)("splits malformed secondary routing into an independently invalid row: %s", (_, boundary, marker, reason, threadKey) => {
    const session = makeSession() as AssistantMessageSessionLike & {
      userMessageIdsThisTurn: number[];
      messageCountAtTurnStart: number;
    };
    session.state.isOrchestrator = true;
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q-1695",
        leaderUserMessageId: "u1",
        content: "Answer q-1695.",
        timestamp: 1,
        threadKey: "q-1695",
        questId: "q-1695",
        threadRefs: [{ threadKey: "q-1695", questId: "q-1695", source: "explicit" }],
        leaderResponseCoverageVersion: 1,
      },
      {
        type: "user_message",
        id: "u-q-1693",
        leaderUserMessageId: "u2",
        content: "Answer q-1693.",
        timestamp: 2,
        threadKey: "q-1693",
        questId: "q-1693",
        threadRefs: [{ threadKey: "q-1693", questId: "q-1693", source: "explicit" }],
        leaderResponseCoverageVersion: 1,
      },
    );
    session.userMessageIdsThisTurn = [0, 1];
    session.messageCountAtTurnStart = 2;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: ["[thread:q-1695:A:u1]", "Valid first answer.", ...boundary, marker].join("\n"),
          },
        ],
        `malformed-secondary-${reason}-${boundary[0] === "---" ? "divider" : "quiz"}`,
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistantBroadcasts = broadcasts.filter(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> => entry.type === "assistant",
    );
    expect(assistantBroadcasts).toHaveLength(2);
    expect(assistantBroadcasts[0]).toMatchObject({
      threadKey: "q-1695",
      questId: "q-1695",
      leaderThreadRole: "answer",
    });
    expect(assistantBroadcasts[1]).toMatchObject({
      ...(threadKey ? { threadKey, questId: threadKey } : {}),
      threadRoutingError: { reason, source: "visible_text" },
    });
    expect(assistantBroadcasts[1]?.leaderThreadRole).toBeUndefined();
    expect(assistantBroadcasts[1]?.threadAnswer).toBeUndefined();
    expect(JSON.stringify(assistantBroadcasts[0]?.message.content)).not.toContain(marker);

    expect(finalizeRoutedLeaderResponseMessage(session, assistantBroadcasts[0]!)).toMatchObject({ finalized: true });
    expect(buildLeaderThreadResponseState(session, "q-1695").projection.pendingMessageCount).toBe(0);
    expect(buildLeaderThreadResponseState(session, "q-1693").projection.pendingMessageCount).toBe(1);
  });

  it("splits post-quiz leader routes when markdown spacing leaves a blank line after the divider", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    // Regression for the q-1718/q-1721 leak: markdown-style spacing around a
    // post-quiz divider must still treat the divider and route marker as
    // server-owned split metadata, not visible prose in the source thread.
    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: [
              "[thread:q-1718:C]",
              "[q-1718](quest:q-1718) is complete.",
              "",
              "{[(Quest Quiz: q-1718)]}",
              "",
              "---",
              "",
              "[thread:q-1721:C] [q-1721](quest:q-1721) is now dispatched.",
            ].join("\n"),
          },
        ],
        "post-quiz-route-with-markdown-spacing",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistantBroadcasts = broadcasts.filter((msg) => msg.type === "assistant");
    expect(assistantBroadcasts).toHaveLength(2);
    expect(assistantBroadcasts[0]).toMatchObject({ type: "assistant", threadKey: "q-1718", questId: "q-1718" });
    expect(assistantBroadcasts[0]?.type === "assistant" ? assistantBroadcasts[0].message.content : []).toEqual([
      { type: "text", text: "[q-1718](quest:q-1718) is complete.\n\n{[(Quest Quiz: q-1718)]}" },
    ]);
    expect(assistantBroadcasts[1]).toMatchObject({ type: "assistant", threadKey: "q-1721", questId: "q-1721" });
    expect(assistantBroadcasts[1]?.type === "assistant" ? assistantBroadcasts[1].message.content : []).toEqual([
      { type: "text", text: "[q-1721](quest:q-1721) is now dispatched." },
    ]);
    expect(JSON.stringify(session.messageHistory)).not.toContain("[thread:q-1721:C]");
    expect(JSON.stringify(session.messageHistory)).not.toContain("\n---\n");
    expect(session.messageHistory.some((entry) => entry.type === "thread_transition_marker")).toBe(true);
  });

  it("does not split mid-message route syntax inside triple-backtick fences", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: [
              "[thread:q-1695:C]",
              "Example:",
              "```text",
              "---",
              "[thread:q-1693:C] literal example",
              "```",
              "---",
              "> [thread:q-1694:C] quoted marker stays in the original segment",
            ].join("\n"),
          },
        ],
        "mid-message-route-fence",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const assistantBroadcasts = broadcasts.filter((msg) => msg.type === "assistant");
    expect(assistantBroadcasts).toHaveLength(1);
    expect(assistantBroadcasts[0]).toMatchObject({ type: "assistant", threadKey: "q-1695", questId: "q-1695" });
    expect(assistantBroadcasts[0]?.type === "assistant" ? assistantBroadcasts[0].message.content : []).toEqual([
      {
        type: "text",
        text: [
          "Example:",
          "```text",
          "---",
          "[thread:q-1693:C] literal example",
          "```",
          "---",
          "> [thread:q-1694:C] quoted marker stays in the original segment",
        ].join("\n"),
      },
    ]);
  });

  it.each([
    ["tilde", "~~~text", "~~~~"],
    ["indented longer backtick", "  ````text", "  `````"],
  ] as const)("does not split route-like examples inside %s fences", (_, opening, closing) => {
    const session = makeSession() as AssistantMessageSessionLike & {
      userMessageIdsThisTurn: number[];
      messageCountAtTurnStart: number;
    };
    session.state.isOrchestrator = true;
    session.messageHistory.push({
      type: "user_message",
      id: "fenced-example-user",
      leaderUserMessageId: "u1",
      content: "Show the literal routing example.",
      timestamp: 1,
      threadKey: "q-1695",
      questId: "q-1695",
      threadRefs: [{ threadKey: "q-1695", questId: "q-1695", source: "explicit" }],
      leaderResponseCoverageVersion: 1,
    });
    session.userMessageIdsThisTurn = [0];
    session.messageCountAtTurnStart = 1;
    const broadcasts: BrowserIncomingMessage[] = [];

    handleAssistantMessage(
      session,
      makeAssistant(
        [
          {
            type: "text",
            text: [
              "[thread:q-1695:A:u1]",
              "Literal example:",
              opening,
              "---",
              "[thread:q-1693:X] not a real route",
              closing,
            ].join("\n"),
          },
        ],
        `fenced-route-${opening[0]}`,
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const response = broadcasts.find(
      (entry): entry is Extract<BrowserIncomingMessage, { type: "assistant" }> => entry.type === "assistant",
    )!;
    expect(broadcasts.filter((entry) => entry.type === "assistant")).toHaveLength(1);
    expect(response).toMatchObject({
      threadKey: "q-1695",
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
    });
    expect(response.message.content).toEqual([
      {
        type: "text",
        text: ["Literal example:", opening, "---", "[thread:q-1693:X] not a real route", closing].join("\n"),
      },
    ]);
    expect(finalizeRoutedLeaderResponseMessage(session, response)).toMatchObject({ finalized: true });
  });

  it("does not append raw split-route content from same-id cumulative snapshots", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];
    const firstContent: ContentBlock[] = [
      {
        type: "text",
        text: [
          "[thread:q-1567:C]",
          "[q-1567](quest:q-1567) is complete.",
          "",
          "{[(Quest Quiz: q-1567)]}",
          "[thread:q-1570:C] [q-1570](quest:q-1570) is dispatched.",
        ].join("\n"),
      },
    ];
    const appendedTool: ContentBlock = {
      type: "tool_use",
      id: "tool-after-route",
      name: "Bash",
      input: { command: "quest show q-1570" },
    };

    handleAssistantMessage(session, makeAssistant(firstContent, "post-quiz-route-cumulative"), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });
    handleAssistantMessage(session, makeAssistant([...firstContent, appendedTool], "post-quiz-route-cumulative"), {
      hasAssistantReplay: () => false,
      broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
      persistSession: () => {},
    });

    const q1567Entry = session.messageHistory.find(
      (entry) => entry.type === "assistant" && entry.threadKey === "q-1567",
    ) as Extract<BrowserIncomingMessage, { type: "assistant" }> | undefined;
    const q1570Entry = session.messageHistory.find(
      (entry) => entry.type === "assistant" && entry.threadKey === "q-1570",
    ) as Extract<BrowserIncomingMessage, { type: "assistant" }> | undefined;

    expect(q1567Entry?.message.content).toEqual([
      {
        type: "text",
        text: "[q-1567](quest:q-1567) is complete.\n\n{[(Quest Quiz: q-1567)]}",
      },
    ]);
    expect(q1570Entry?.message.content).toEqual([
      { type: "text", text: "[q-1570](quest:q-1570) is dispatched." },
      appendedTool,
    ]);
    expect(JSON.stringify(session.messageHistory)).not.toContain("[thread:");
    expect(broadcasts.filter((msg) => msg.type === "assistant")).toHaveLength(3);
  });

  it("routes leader text when launcher info says orchestrator and session state has not caught up", () => {
    const session = makeSession();
    delete session.state.isOrchestrator;

    const msg = routeAssistantMessage(
      session,
      [{ type: "text", text: "[thread:q-966:C] Launcher-derived Claude route" }],
      { getLauncherSessionInfo: () => ({ isOrchestrator: true }) },
    );

    expect(session.state.isOrchestrator).toBe(true);
    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-966",
      questId: "q-966",
      threadRefs: [{ threadKey: "q-966", questId: "q-966", source: "explicit" }],
    });
    expect(msg.type === "assistant" ? msg.message.content : []).toMatchObject([
      { type: "text", text: "Launcher-derived Claude route" },
    ]);
  });

  it("strips quest thread reminders from leader assistant text and queues a synthetic reminder", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
      {
        type: "text",
        text: [
          "[thread:main:C]",
          "Created q-1025 with the approved scope.",
          "",
          "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
        ].join("\n"),
      },
    ]);

    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: "Created q-1025 with the approved scope." });
    expect(session.questThreadRemindersThisTurn).toMatchObject([
      {
        content:
          "Thread reminder: attach any prior messages that clearly belong to q-1025 with `takode thread attach`.",
        route: { threadKey: "main" },
        agentSource: {
          sessionId: "system:quest-thread-reminder",
          sessionLabel: "Quest Thread Reminder",
        },
      },
    ]);
  });

  it("preserves unrouted leader text and records missing prefix metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "Unmarked leader text" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "missing", source: "visible_text", rawContent: "Unmarked leader text" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text", text: "Unmarked leader text" });
  });

  it("preserves unrouted leader text and records invalid prefix metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:side]\nWrong marker" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "invalid", source: "visible_text", marker: "[thread:side]" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content[0].type === "text" ? content[0].text : "").toBe("[thread:side]\nWrong marker");
  });

  it("rejects no-space same-line leader thread prefixes", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]No separator" }]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "invalid_role", source: "visible_text", marker: "[thread:q-941:C]" },
    });
    const content = msg.type === "assistant" ? msg.message.content : [];
    expect(content[0].type === "text" ? content[0].text : "").toBe("[thread:q-941:C]No separator");
  });

  it("strips Bash command thread comments and persists command thread metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941\npwd" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    const block = msg.type === "assistant" ? msg.message.content[0] : null;
    expect(block).toMatchObject({ type: "tool_use", input: { command: "pwd" } });
  });

  it("routes unthreaded leader tool activity to the most recent quest thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nInspecting the attached screenshot." }]);
    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-view-image", name: "view_image", input: { path: "/tmp/screenshot.png" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "inferred" }],
    });
    expect(msg.type === "assistant" ? msg.threadRoutingError : undefined).toBeUndefined();
  });

  it("routes mixed unmarked text plus non-Bash tool activity to the most recent quest thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nPreparing to inspect the file." }]);
    const msg = routeAssistantMessage(session, [
      { type: "text", text: "Reading the relevant file now." },
      { type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "web/server/example.ts" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "inferred" }],
    });
    expect(msg.type === "assistant" ? msg.threadRoutingError : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.message.content : []).toEqual([
      { type: "text", text: "Reading the relevant file now." },
      { type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "web/server/example.ts" } },
    ]);
  });

  it("routes cumulative text-then-tool snapshots to the most recent quest thread", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;
    const broadcasts: BrowserIncomingMessage[] = [];

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nPreparing to inspect the file." }]);
    handleAssistantMessage(
      session,
      makeAssistant([{ type: "text", text: "Reading the relevant file now." }], "mixed-cumulative"),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );
    handleAssistantMessage(
      session,
      makeAssistant(
        [
          { type: "text", text: "Reading the relevant file now." },
          { type: "tool_use", id: "tool-read-cumulative", name: "Read", input: { file_path: "web/server/example.ts" } },
        ],
        "mixed-cumulative",
      ),
      {
        hasAssistantReplay: () => false,
        broadcastToBrowsers: (_session, msg) => broadcasts.push(msg),
        persistSession: () => {},
      },
    );

    const entry = session.messageHistory.find(
      (message) => message.type === "assistant" && message.message.id === "mixed-cumulative",
    ) as Extract<BrowserIncomingMessage, { type: "assistant" }> | undefined;
    expect(entry).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "inferred" }],
    });
    expect(entry?.threadRoutingError).toBeUndefined();
    expect(entry?.message.content).toEqual([
      { type: "text", text: "Reading the relevant file now." },
      { type: "tool_use", id: "tool-read-cumulative", name: "Read", input: { file_path: "web/server/example.ts" } },
    ]);
    expect(broadcasts.at(-1)).toMatchObject({
      type: "assistant",
      threadKey: "q-941",
      questId: "q-941",
    });
  });

  it("keeps unthreaded leader tool activity in Main when no quest thread is known", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-edit", name: "Edit", input: { file_path: "web/server/example.ts" } },
    ]);

    expect(msg.type === "assistant" ? msg.threadKey : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.questId : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRefs : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRoutingError : undefined).toBeUndefined();
  });

  it("does not let the recent-thread fallback override explicit Main routing", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nQuest-local work." }]);
    const msg = routeAssistantMessage(session, [{ type: "text", text: "[thread:main:C]\nGlobal status update." }]);

    expect(msg).toMatchObject({ type: "assistant", threadKey: "main" });
    expect(msg.type === "assistant" ? msg.questId : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRefs : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.message.content : []).toEqual([
      { type: "text", text: "Global status update." },
    ]);
  });

  it("does not let the recent-thread fallback override command-level Main routing", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nQuest-local work." }]);
    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-global", name: "Bash", input: { command: "# thread:main\npwd" } },
    ]);

    expect(msg).toMatchObject({ type: "assistant", threadKey: "main" });
    expect(msg.type === "assistant" ? msg.questId : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRefs : undefined).toBeUndefined();
    const block = msg.type === "assistant" ? msg.message.content[0] : null;
    expect(block).toMatchObject({ type: "tool_use", input: { command: "pwd" } });
  });

  it("does not apply the recent-thread fallback to non-leader sessions", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "previous-q941", content: [] } as any,
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });

    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "web/server/example.ts" } },
    ]);

    expect(msg.type === "assistant" ? msg.threadKey : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.questId : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRefs : undefined).toBeUndefined();
  });

  it("preserves unrouted Bash command and records shell-command routing metadata", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "missing", source: "shell_command", rawContent: "pwd" },
    });
    const block = msg.type === "assistant" ? msg.message.content[0] : null;
    expect(block).toMatchObject({ type: "tool_use", input: { command: "pwd" } });
  });

  it("does not let the recent-thread fallback override unmarked Bash diagnostics", () => {
    const session = makeSession();
    session.state.isOrchestrator = true;

    routeAssistantMessage(session, [{ type: "text", text: "[thread:q-941:C]\nQuest-local work." }]);
    const msg = routeAssistantMessage(session, [
      { type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pwd" } },
    ]);

    expect(msg).toMatchObject({
      type: "assistant",
      threadRoutingError: { reason: "missing", source: "shell_command", rawContent: "pwd" },
    });
    expect(msg.type === "assistant" ? msg.threadKey : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.questId : undefined).toBeUndefined();
    expect(msg.type === "assistant" ? msg.threadRefs : undefined).toBeUndefined();
  });
});
