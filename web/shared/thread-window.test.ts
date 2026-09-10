import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import { computeHistoryPayloadSyncHash } from "./history-sync-hash.js";
import {
  buildProjectedThreadEntries,
  buildThreadWindowSync,
  THREAD_WINDOW_SUPPORT_RECORD_LIMIT,
} from "./thread-window.js";

function user(id: string, content: string, threadKey?: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...(threadKey ? { threadKey, questId: threadKey } : {}),
    ...(threadKey ? { threadRefs: [{ threadKey, questId: threadKey, source: "explicit" as const }] } : {}),
  };
}

function assistant(
  id: string,
  text: string,
  options: { threadKey?: string; toolUseId?: string; parentToolUseId?: string } = {},
): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content: options.toolUseId
        ? [
            { type: "text", text },
            { type: "tool_use", id: options.toolUseId, name: "Read", input: { file_path: "a.ts" } },
          ]
        : [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: options.parentToolUseId ?? null,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...(options.threadKey ? { threadKey: options.threadKey, questId: options.threadKey } : {}),
    ...(options.threadKey
      ? { threadRefs: [{ threadKey: options.threadKey, questId: options.threadKey, source: "explicit" as const }] }
      : {}),
  };
}

function bashAssistant(
  id: string,
  command: string,
  options: { threadKey?: string; toolUseId: string },
): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content: [
        { type: "text", text: "running shell command" },
        { type: "tool_use", id: options.toolUseId, name: "Bash", input: { command } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...(options.threadKey ? { threadKey: options.threadKey, questId: options.threadKey } : {}),
    ...(options.threadKey
      ? { threadRefs: [{ threadKey: options.threadKey, questId: options.threadKey, source: "explicit" as const }] }
      : {}),
  };
}

function attachmentMarker(overrides: Partial<BrowserIncomingMessage> = {}): BrowserIncomingMessage {
  return {
    type: "thread_attachment_marker",
    id: "marker-q1",
    timestamp: 3,
    markerKey: "thread-attachment:q-1:u2",
    threadKey: "q-1",
    questId: "q-1",
    attachedAt: 3,
    attachedBy: "leader-1",
    messageIds: ["u2"],
    messageIndices: [1],
    ranges: ["1"],
    count: 1,
    firstMessageId: "u2",
    firstMessageIndex: 1,
    ...overrides,
  };
}

function transitionMarker(overrides: {
  id: string;
  sourceThreadKey: string;
  threadKey: string;
}): BrowserIncomingMessage {
  return {
    type: "thread_transition_marker",
    id: overrides.id,
    timestamp: 3,
    markerKey: `thread-transition:${overrides.sourceThreadKey}->${overrides.threadKey}:0`,
    sourceThreadKey: overrides.sourceThreadKey,
    ...(overrides.sourceThreadKey === "main" ? {} : { sourceQuestId: overrides.sourceThreadKey }),
    threadKey: overrides.threadKey,
    questId: overrides.threadKey,
    transitionedAt: 3,
    reason: "route_switch",
  };
}

function toolResultPreview(toolUseId: string, content = "preview"): BrowserIncomingMessage {
  return {
    type: "tool_result_preview",
    previews: [
      {
        tool_use_id: toolUseId,
        content,
        is_error: false,
        total_size: content.length,
        is_truncated: false,
      },
    ],
  };
}

function multiToolResultPreview(entries: Array<{ toolUseId: string; content: string }>): BrowserIncomingMessage {
  return {
    type: "tool_result_preview",
    previews: entries.map((entry) => ({
      tool_use_id: entry.toolUseId,
      content: entry.content,
      is_error: false,
      total_size: entry.content.length,
      is_truncated: false,
    })),
  };
}

function successfulResult(id: string): BrowserIncomingMessage {
  return {
    type: "result",
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    data: {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      session_id: "s1",
      total_cost_usd: 0,
      result: "done",
    },
  };
}

function failedResult(id: string): BrowserIncomingMessage {
  const success = successfulResult(id) as Extract<BrowserIncomingMessage, { type: "result" }>;
  return {
    ...success,
    data: {
      ...success.data,
      subtype: "error_during_execution",
      is_error: true,
      result: "failed",
    },
  };
}

describe("thread window hydration", () => {
  it("exports full projected entries with the same Main filtering used by thread windows", () => {
    const history = [
      user("u1", "main visible"),
      user("u2", "quest hidden", "q-1277"),
      user("u3", "main visible later"),
    ];

    const mainIds = buildProjectedThreadEntries(history, "main").map((entry) =>
      entry.message.type === "user_message" ? entry.message.id : entry.history_index,
    );
    const questIds = buildProjectedThreadEntries(history, "q-1277").map((entry) =>
      entry.message.type === "user_message" ? entry.message.id : entry.history_index,
    );

    expect(mainIds).toEqual(["u1", "u3"]);
    expect(questIds).toEqual(["u2"]);
  });

  it("returns bounded selected quest feed items with tool closure context", () => {
    const history = [
      user("u1", "unrelated", "q-2"),
      user("u2", "quest request", "q-1"),
      assistant("a3", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      assistant("a4", "tool result follow-up", { parentToolUseId: "tool-1" }),
      user("u5", "also unrelated", "q-3"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.threadKey).toBe("q-1");
    expect(sync.window.total_items).toBe(1);
    expect(sync.window.item_count).toBe(1);
    expect(
      sync.entries.map((entry) => (entry.message.type === "assistant" ? entry.message.message.id : entry.message.id)),
    ).toEqual(["u2", "a3", "a4"]);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2, 3]);
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(false);
  });

  it("uses thread-local conversation turns as the quest window unit", () => {
    const history = [
      user("u1", "quest request", "q-1"),
      assistant("a2", "small tool-only step", { threadKey: "q-1", toolUseId: "tool-1" }),
      assistant("a3", "tool result follow-up", { parentToolUseId: "tool-1" }),
      assistant("a4", "final answer", { threadKey: "q-1" }),
      user("u5", "second quest request", "q-1"),
      assistant("a6", "second answer", { threadKey: "q-1" }),
    ];

    const firstTurn = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(firstTurn.window.total_items).toBe(2);
    expect(firstTurn.window.item_count).toBe(1);
    expect(firstTurn.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2, 3]);
    expect(firstTurn.window.has_older_items).toBe(false);
    expect(firstTurn.window.has_newer_items).toBe(true);

    const secondTurn = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(secondTurn.window.total_items).toBe(2);
    expect(secondTurn.entries.map((entry) => entry.history_index)).toEqual([4, 5]);
    expect(secondTurn.window.has_older_items).toBe(true);
    expect(secondTurn.window.has_newer_items).toBe(false);
  });

  it("replays routed turn results into the thread-local conversation state", () => {
    const history = [
      user("u1", "quest request", "q-1"),
      assistant("a2", "quest work", { threadKey: "q-1" }),
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          session_id: "s1",
          total_cost_usd: 0,
          result: "done",
        },
      },
      user("u4", "main follow-up"),
    ] satisfies BrowserIncomingMessage[];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.window.total_items).toBe(1);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "assistant", "result"]);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
  });

  it("expands tool closure context across requested quest window boundaries", () => {
    const history = [
      assistant("a1", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-1",
            content: "preview",
            is_error: false,
            total_size: 7,
            is_truncated: false,
          },
        ],
      },
      assistant("a2", "tool result follow-up", { parentToolUseId: "tool-1" }),
    ] satisfies BrowserIncomingMessage[];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.window.item_count).toBe(1);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview", "assistant"]);
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(false);
  });

  it("expands tool result closure in All Threads windows", () => {
    const history = [
      bashAssistant("a1", "takode board show", { toolUseId: "tool-all" }),
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          session_id: "s1",
          total_cost_usd: 0,
          result: "done",
        },
      },
      toolResultPreview("tool-all", "board output"),
      user("u4", "later user message"),
    ] satisfies BrowserIncomingMessage[];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "all",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    // The result closes the selected All Threads range before the matching preview,
    // so this fails if All Threads returns before tool-result closure expansion.
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "result", "tool_result_preview"]);
    expect(sync.window.has_newer_items).toBe(true);
  });

  it("keeps newer availability when closure expansion does not cover every newer logical item", () => {
    const history = [
      assistant("a1", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      user("u2", "intermediate quest message", "q-1"),
      assistant("a3", "tool result follow-up", { parentToolUseId: "tool-1" }),
      user("u4", "tail quest message", "q-1"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 2]);
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(true);
  });

  it("preserves current Main feed semantics without returning quest-thread messages", () => {
    const history = [
      user("u1", "main request"),
      user("u2", "quest request", "q-1"),
      assistant("a3", "quest reply", { threadKey: "q-1" }),
      user("u4", "main follow-up"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(
      sync.entries.map((entry) => (entry.message.type === "assistant" ? entry.message.message.id : entry.message.id)),
    ).toEqual(["u1", "u4"]);
  });

  it("keeps q-thread tool result previews out of Main while preserving them in the quest thread", () => {
    const history = [
      user("u1", "main request"),
      assistant("a2", "quest tool", { threadKey: "q-1119", toolUseId: "tool-q" }),
      toolResultPreview("tool-q", "quest preview"),
      user("u4", "main follow-up"),
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const questSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1119",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(mainSync.entries.map((entry) => entry.history_index)).toEqual([0, 3]);
    expect(mainSync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(questSync.entries.map((entry) => entry.history_index)).toEqual([1, 2]);
    expect(questSync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview"]);
  });

  it("projects recent-thread fallback tool activity into the inferred quest thread", () => {
    const history = [
      assistant("a1", "quest update", { threadKey: "q-1596" }),
      {
        ...assistant("a2", "image read", { toolUseId: "tool-image-read" }),
        threadKey: "q-1596",
        questId: "q-1596",
        threadRefs: [{ threadKey: "q-1596", questId: "q-1596", source: "inferred" as const }],
      },
      toolResultPreview("tool-image-read", "image preview"),
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const questSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1596",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(mainSync.entries.map((entry) => entry.message.type)).toEqual([]);
    expect(questSync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(questSync.entries.map((entry) => entry.message.type)).toEqual([
      "assistant",
      "assistant",
      "tool_result_preview",
    ]);
  });

  it("preserves Main previews for visible and orphaned tools", () => {
    const visibleMainHistory = [
      assistant("a1", "main tool", { toolUseId: "tool-main" }),
      toolResultPreview("tool-main", "main preview"),
    ];
    const orphanHistory = [toolResultPreview("tool-orphan", "orphan preview")];

    const visibleMainSync = buildThreadWindowSync({
      messageHistory: visibleMainHistory,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const orphanSync = buildThreadWindowSync({
      messageHistory: orphanHistory,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(visibleMainSync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview"]);
    expect(orphanSync.entries.map((entry) => entry.message.type)).toEqual(["tool_result_preview"]);
  });

  it("keeps backfilled source messages visible in Main without rendering attachment markers", () => {
    const attachedMain = {
      ...user("u2", "main context attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const history = [user("u1", "main request"), attachedMain, attachmentMarker(), user("u4", "main follow-up")];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 3]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message", "user_message"]);
  });

  it("surfaces a compact Main audit row for q-routed thread attach commands that attach Main source messages", () => {
    const attachedMainMessage = {
      ...user("u6211", "Main follow-up with screenshot context"),
      threadRefs: [{ threadKey: "q-1152", questId: "q-1152", source: "backfill" as const }],
    };
    const attachedMainTool = {
      ...assistant("a6212", "viewing attached screenshot", { toolUseId: "tool-view-image" }),
      threadRefs: [{ threadKey: "q-1152", questId: "q-1152", source: "backfill" as const }],
    };
    const mainToQuest = transitionMarker({
      id: "transition-main-q1152",
      sourceThreadKey: "main",
      threadKey: "q-1152",
    });
    const attachCommand = bashAssistant(
      "a6224",
      "# thread:q-1152\nquest feedback add q-1152 --text-file /tmp/body.md && takode thread attach q-1152 --turn 417",
      { threadKey: "q-1152", toolUseId: "tool-attach-q1152" },
    );
    const marker = attachmentMarker({
      id: "marker-q1152-main-source",
      threadKey: "q-1152",
      questId: "q-1152",
      count: 4,
      messageIds: ["u6211", "a6212", "history-2", "transition-main-q1152"],
      messageIndices: [0, 1, 2, 3],
      ranges: ["0-3"],
      firstMessageId: "u6211",
      firstMessageIndex: 0,
    });
    const futureQuestTool = bashAssistant("a6230", "# thread:q-1152\nquest status q-1152", {
      threadKey: "q-1152",
      toolUseId: "tool-future-q1152",
    });
    const history = [
      attachedMainMessage,
      attachedMainTool,
      toolResultPreview("tool-view-image", "screenshot opened"),
      mainToQuest,
      attachCommand,
      toolResultPreview("tool-attach-q1152", "Attached 6211, 6212, 6213, 6214 to q-1152"),
      marker,
      futureQuestTool,
      toolResultPreview("tool-future-q1152", "quest status output"),
      user("u6232", "Main continues after manual nudge"),
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const questSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1152",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(mainSync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2, 3, 4, 9]);
    expect(mainSync.entries.map((entry) => entry.message.type)).toEqual([
      "user_message",
      "assistant",
      "tool_result_preview",
      "thread_transition_marker",
      "cross_thread_activity_marker",
      "user_message",
    ]);
    expect(mainSync.entries[4]?.message).toEqual(
      expect.objectContaining({
        type: "cross_thread_activity_marker",
        activityKind: "thread_attach",
        threadKey: "q-1152",
        attachedCount: 4,
        summary: "Thread attach command added 4 Main messages to thread:q-1152",
      }),
    );
    expect(mainSync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(mainSync.entries.some((entry) => entry.message === futureQuestTool)).toBe(false);
    expect(
      mainSync.entries.some(
        (entry) =>
          entry.message.type === "tool_result_preview" &&
          entry.message.previews.some((preview) => preview.tool_use_id === "tool-attach-q1152"),
      ),
    ).toBe(false);

    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 4, message: attachCommand }));
    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 5 }));
    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 7, message: futureQuestTool }));
    expect(questSync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("does not add a Main attach audit row for q-routed thread attach commands that attach another quest source", () => {
    const sourceQuestMessage = {
      ...user("u1", "source quest context", "q-1140"),
      threadRefs: [
        { threadKey: "q-1140", questId: "q-1140", source: "explicit" as const },
        { threadKey: "q-1152", questId: "q-1152", source: "backfill" as const },
      ],
    };
    const attachCommand = bashAssistant("a2", "# thread:q-1152\ntakode thread attach q-1152 --turn 417", {
      threadKey: "q-1152",
      toolUseId: "tool-attach-q-source",
    });
    const history = [
      user("u0", "main request"),
      sourceQuestMessage,
      attachCommand,
      attachmentMarker({
        id: "marker-q1152-source-quest",
        threadKey: "q-1152",
        questId: "q-1152",
        sourceThreadKey: "q-1140",
        sourceQuestId: "q-1140",
        messageIds: ["u1"],
        messageIndices: [1],
        ranges: ["1"],
        count: 1,
        firstMessageId: "u1",
        firstMessageIndex: 1,
      }),
      user("u4", "main tail"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 4]);
    expect(sync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("retains Main attachment sources for a latest window without hydrating marker rows", () => {
    const attachedMain = {
      ...user("u2", "old Main context attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const futureQuestOnly = user("u3", "future q-1-only reply", "q-1");
    const marker = attachmentMarker({
      id: "marker-q1-late",
      timestamp: 4,
      messageIds: ["u2", "u3"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
      count: 2,
      firstMessageId: "u2",
      firstMessageIndex: 1,
    });
    const history = [user("u1", "main request"), attachedMain, futureQuestOnly, marker, user("u5", "main follow-up")];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 4]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(sync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(sync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("retains Main attachment sources when the suppressed marker is appended after the latest Main item", () => {
    const attachedMain = {
      ...user("u2", "old Main source attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const futureQuestOnly = user("u4", "future q-1-only reply", "q-1");
    const marker = attachmentMarker({
      id: "marker-q1-tail",
      timestamp: 5,
      messageIds: ["u2", "u4"],
      messageIndices: [1, 3],
      ranges: ["1", "3"],
      count: 2,
      firstMessageId: "u2",
      firstMessageIndex: 1,
    });
    const history = [
      user("u1", "main request"),
      attachedMain,
      user("u3", "current Main tail"),
      futureQuestOnly,
      marker,
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(sync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(sync.entries.some((entry) => (entry.message as { id?: string }).id === "u4")).toBe(false);
  });

  it("keeps source quest messages visible without rendering source attachment markers", () => {
    const sourceMessage = {
      ...user("u2", "source quest context", "q-2"),
      threadRefs: [
        { threadKey: "q-2", questId: "q-2", source: "explicit" as const },
        { threadKey: "q-1", questId: "q-1", source: "backfill" as const },
      ],
    };
    const history = [
      user("u1", "main request"),
      sourceMessage,
      attachmentMarker({ sourceThreadKey: "q-2", sourceQuestId: "q-2" }),
    ];

    const sourceSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-2",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sourceSync.entries.map((entry) => entry.history_index)).toEqual([1]);
    expect(destinationSync.entries.map((entry) => entry.history_index)).toEqual([1]);
  });

  it("scopes quest route-switch handoffs to affected thread windows", () => {
    const sourceToDestination = transitionMarker({
      id: "transition-q1139-q1141",
      sourceThreadKey: "q-1139",
      threadKey: "q-1141",
    });
    const unrelatedPair = transitionMarker({
      id: "transition-q1141-q1135",
      sourceThreadKey: "q-1141",
      threadKey: "q-1135",
    });
    const history = [
      user("u1", "source quest visible before handoff", "q-1139"),
      sourceToDestination,
      unrelatedPair,
      user("u4", "destination quest receives work", "q-1141"),
    ];

    const sourceSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1139",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1141",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const thirdThreadSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1140",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    // The window producer retains only each thread's current departure. Inbound
    // markers and unrelated transitions remain in raw/All audit, not this view.
    expect(sourceSync.entries.map((entry) => entry.message)).toEqual([history[0], sourceToDestination]);
    expect(destinationSync.entries.map((entry) => entry.message)).toEqual([unrelatedPair, history[3]]);
    expect(thirdThreadSync.entries).toEqual([]);
  });

  it("keeps Main-origin route-switch handoffs visible in the Main source window", () => {
    const mainToDestination = transitionMarker({
      id: "transition-main-q948",
      sourceThreadKey: "main",
      threadKey: "q-948",
    });
    const unrelatedPair = transitionMarker({
      id: "transition-q950-q951",
      sourceThreadKey: "q-950",
      threadKey: "q-951",
    });
    const history = [
      user("u1", "Please work on q-948"),
      assistant("a2", "Checking context", { toolUseId: "tool-view-image" }),
      toolResultPreview("tool-view-image", "Viewed screenshot"),
      mainToDestination,
      assistant("a5", "Continuing in the quest thread", { threadKey: "q-948" }),
      unrelatedPair,
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-948",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const thirdThreadSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-949",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    // This mirrors the producer-owned Main window shape for the production
    // feedback: a Main request can do local tool work before moving output into
    // a quest tab, and Main still needs the durable handoff marker.
    expect(mainSync.entries.map((entry) => entry.message)).toEqual([
      history[0],
      history[1],
      history[2],
      mainToDestination,
    ]);
    expect(destinationSync.entries.map((entry) => entry.message)).toEqual([history[4]]);
    expect(thirdThreadSync.entries).toEqual([]);
  });

  it("keeps an earlier quest lifecycle event in its exact thread and history position", () => {
    // Producer-shaped regression for q-2008: a completed q-2003 event precedes
    // a later Main-to-q-2006 dispatch and must never migrate into that handoff.
    const q2003Event: BrowserIncomingMessage = {
      type: "quest_lifecycle_event",
      id: "quest-lifecycle-q2003",
      timestamp: 300,
      kind: "submitted",
      quest: { questId: "q-2003", title: "Diagnose recurring alerts", status: "done" },
      threadKey: "q-2003",
      questId: "q-2003",
      threadRefs: [{ threadKey: "q-2003", questId: "q-2003", source: "explicit" }],
    };
    const q2003ToMain = transitionMarker({
      id: "transition-q2003-main",
      sourceThreadKey: "q-2003",
      threadKey: "main",
    });
    const mainToQ2006 = transitionMarker({
      id: "transition-main-q2006",
      sourceThreadKey: "main",
      threadKey: "q-2006",
    });
    const history = [
      user("u100", "Complete the alert investigation", "q-2003"),
      assistant("a200", "The findings are ready", { threadKey: "q-2003" }),
      q2003Event,
      q2003ToMain,
      user("u500", "Create and dispatch q-2006"),
      assistant("a600", "Creating the changelog quest"),
      mainToQ2006,
      assistant("a800", "q-2006 is dispatched", { threadKey: "q-2006" }),
    ];
    const options = { fromItem: 0, itemCount: 20, sectionItemCount: 10, visibleItemCount: 3 };
    const main = buildThreadWindowSync({ messageHistory: history, threadKey: "main", ...options });
    const q2003 = buildThreadWindowSync({ messageHistory: history, threadKey: "q-2003", ...options });
    const q2006 = buildThreadWindowSync({ messageHistory: history, threadKey: "q-2006", ...options });
    const all = buildThreadWindowSync({ messageHistory: history, threadKey: "all", ...options });
    const indexes = (sync: ReturnType<typeof buildThreadWindowSync>) =>
      sync.entries.map((entry) => entry.history_index);

    expect(indexes(main)).toEqual([4, 5, 6]);
    expect(indexes(q2003)).toEqual([0, 1, 2, 3]);
    expect(indexes(q2006)).toEqual([7]);
    expect(indexes(all)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(q2003.entries.filter((entry) => entry.message === q2003Event)).toHaveLength(1);
    expect(main.entries.some((entry) => entry.message === q2003Event)).toBe(false);
    expect(q2006.entries.some((entry) => entry.message === q2003Event)).toBe(false);
  });

  it("uses Main cross-thread markers for non-quest hidden activity", () => {
    const history = [
      user("u1", "main request"),
      user("u2", "side thread", "project-notes"),
      assistant("a3", "side reply", { threadKey: "project-notes" }),
      user("u4", "quest request", "q-1"),
      assistant("a5", "quest reply", { threadKey: "q-1" }),
      user("u6", "main follow-up"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.message.type)).toEqual([
      "user_message",
      "cross_thread_activity_marker",
      "user_message",
    ]);
    expect(sync.entries[1]?.message).toEqual(
      expect.objectContaining({
        type: "cross_thread_activity_marker",
        threadKey: "project-notes",
        count: 2,
      }),
    );
  });

  it("counts renderable Main ranges so more than 90 result-only turns cannot produce a false empty window", () => {
    // This producer-shaped tail exceeds the former 90-range cap and must still expose bounded recent Main content.
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 50; i++) {
      history.push(user(`u${i}`, `main request ${i}`));
      history.push(assistant(`a${i}`, `main response ${i}`));
      history.push(successfulResult(`r${i}`));
    }
    for (let i = 0; i < 140; i++) {
      history.push(user(`uq${i}`, `quest request ${i}`, "q-1205"));
      history.push(assistant(`aq${i}`, `quest response ${i}`, { threadKey: "q-1205" }));
      history.push(successfulResult(`rq${i}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 30,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });

    const visibleMessages = sync.entries.filter((entry) => {
      if (entry.message.type === "result") return false;
      return entry.message.type !== "tool_result_preview";
    });

    expect(sync.window.total_items).toBe(50);
    expect(sync.window.item_count).toBe(30);
    expect(visibleMessages.length).toBeGreaterThanOrEqual(10);
    expect(
      sync.entries.some(
        (entry) => entry.message.type === "user_message" && entry.message.content === "main request 20",
      ),
    ).toBe(true);
    expect(sync.entries.every((entry) => entry.history_index < 150)).toBe(true);
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(false);
  });

  it("counts standalone rows so more than 90 preview-only ranges cannot produce a false empty window", () => {
    // Producer-valid preview/result support tails must not consume the visible page budget.
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 50; i++) {
      history.push(user(`u${i}`, `main request ${i}`));
      history.push(assistant(`a${i}`, `main response ${i}`));
      history.push(successfulResult(`r${i}`));
    }
    const visibleHistoryLength = history.length;
    for (let i = 0; i < 140; i++) {
      history.push(toolResultPreview(`orphan-tool-${i}`, `support preview ${i}`));
      history.push(successfulResult(`support-result-${i}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 30,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });
    const standaloneRows = sync.entries.filter((entry) => {
      if (entry.message.type === "tool_result_preview") return false;
      if (entry.message.type !== "result") return true;
      return Boolean((entry.message.data as { is_error?: boolean }).is_error && !entry.message.interrupted);
    });

    expect(sync.window).toEqual(
      expect.objectContaining({ total_items: 50, item_count: 30, has_older_items: true, has_newer_items: false }),
    );
    expect(standaloneRows.length).toBeGreaterThan(0);
    expect(sync.entries.every((entry) => entry.history_index < visibleHistoryLength)).toBe(true);
  });

  it("delivers matching Main tool closure outside the visible range without leaking unrelated previews", () => {
    // Support records are relation-bounded to selected tool rows and keep source ordering and identity.
    const mixedPreview = {
      type: "tool_result_preview",
      previews: [
        ...(
          toolResultPreview("tool-main", "main closure") as Extract<
            BrowserIncomingMessage,
            { type: "tool_result_preview" }
          >
        ).previews,
        ...(
          toolResultPreview("tool-other", "unrelated closure") as Extract<
            BrowserIncomingMessage,
            { type: "tool_result_preview" }
          >
        ).previews,
      ],
    } satisfies BrowserIncomingMessage;
    const history = [
      assistant("a1", "main tool", { toolUseId: "tool-main" }),
      successfulResult("r1"),
      mixedPreview,
      user("u4", "later visible Main row"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.window).toEqual(
      expect.objectContaining({ total_items: 2, item_count: 1, has_older_items: false, has_newer_items: true }),
    );
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    const preview = sync.entries[2]?.message;
    expect(preview?.type).toBe("tool_result_preview");
    if (preview?.type === "tool_result_preview") {
      expect(preview.previews.map((entry) => entry.tool_use_id)).toEqual(["tool-main"]);
    }
    expect(new Set(sync.entries.map((entry) => entry.history_index)).size).toBe(sync.entries.length);
  });

  it("delivers mandatory previews for more than the optional support cap of visible Main Bash tools", () => {
    // A selected conversation may have many visible tool rows; known results are mandatory closure, not optional support.
    const toolIds = Array.from({ length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT + 6 }, (_, index) => `main-bash-${index}`);
    const history: BrowserIncomingMessage[] = [
      user("u1", "main asks for a batch"),
      ...toolIds.map((toolUseId, index) => bashAssistant(`a${index + 1}`, `cmd ${index}`, { toolUseId })),
      successfulResult("r1"),
      multiToolResultPreview(toolIds.map((toolUseId, index) => ({ toolUseId, content: `main result ${index}` }))),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const previews = sync.entries.flatMap((entry) =>
      entry.message.type === "tool_result_preview" ? entry.message.previews : [],
    );

    expect(sync.window).toEqual(
      expect.objectContaining({ total_items: 1, item_count: 1, has_older_items: false, has_newer_items: false }),
    );
    expect(previews.map((preview) => preview.tool_use_id).sort()).toEqual([...toolIds].sort());
    expect(sync.entries.filter((entry) => entry.message.type === "tool_result_preview")).toHaveLength(1);
  });

  it("delivers mandatory previews for more than the optional support cap of visible quest Bash tools", () => {
    // Quest-thread closure has the same correctness invariant as Main while preserving thread routing.
    const toolIds = Array.from({ length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT + 3 }, (_, index) => `quest-bash-${index}`);
    const history: BrowserIncomingMessage[] = [
      user("uq1", "quest asks for a batch", "q-1205"),
      ...toolIds.map((toolUseId, index) =>
        bashAssistant(`aq${index + 1}`, `quest cmd ${index}`, { threadKey: "q-1205", toolUseId }),
      ),
      successfulResult("rq1"),
      multiToolResultPreview(toolIds.map((toolUseId, index) => ({ toolUseId, content: `quest result ${index}` }))),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1205",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const previews = sync.entries.flatMap((entry) =>
      entry.message.type === "tool_result_preview" ? entry.message.previews : [],
    );

    expect(previews.map((preview) => preview.tool_use_id).sort()).toEqual([...toolIds].sort());
    expect(sync.entries.some((entry) => entry.message.type === "user_message" && entry.message.id === "uq1")).toBe(
      true,
    );
    expect(sync.window).toEqual(
      expect.objectContaining({ total_items: 1, item_count: 1, has_older_items: false, has_newer_items: false }),
    );
  });

  it("uses the latest mandatory preview and can close multiple tools from one preview record", () => {
    // One mixed source preview record may supply the latest result for multiple visible tools.
    const history = [
      user("u1", "main tool pair"),
      bashAssistant("a1", "cmd one", { toolUseId: "tool-one" }),
      bashAssistant("a2", "cmd two", { toolUseId: "tool-two" }),
      successfulResult("r1"),
      toolResultPreview("tool-one", "old one"),
      toolResultPreview("tool-two", "old two"),
      multiToolResultPreview([
        { toolUseId: "tool-one", content: "latest one" },
        { toolUseId: "tool-two", content: "latest two" },
        { toolUseId: "tool-other", content: "unrelated latest" },
      ]),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const previewEntries = sync.entries.filter(
      (entry): entry is typeof entry & { message: Extract<BrowserIncomingMessage, { type: "tool_result_preview" }> } =>
        entry.message.type === "tool_result_preview",
    );

    expect(previewEntries).toHaveLength(1);
    expect(previewEntries[0]?.history_index).toBe(6);
    expect(previewEntries[0]?.message.previews.map((preview) => [preview.tool_use_id, preview.content])).toEqual([
      ["tool-one", "latest one"],
      ["tool-two", "latest two"],
    ]);
  });

  it("keeps optional support bounded after mandatory closure", () => {
    // Secondary parent rows are still optional support and stay capped after mandatory previews are present.
    const toolIds = Array.from(
      { length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT + 8 },
      (_, index) => `support-bash-${index}`,
    );
    const history: BrowserIncomingMessage[] = [
      user("u1", "main asks for many tools"),
      ...toolIds.map((toolUseId, index) => bashAssistant(`a${index + 1}`, `support cmd ${index}`, { toolUseId })),
      successfulResult("r1"),
      multiToolResultPreview(toolIds.map((toolUseId, index) => ({ toolUseId, content: `support result ${index}` }))),
      ...toolIds.map((toolUseId, index) =>
        assistant(`ap${index + 1}`, `parent closure ${index}`, { parentToolUseId: toolUseId }),
      ),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const mandatoryPreviewCount = sync.entries.reduce((count, entry) => {
      return entry.message.type === "tool_result_preview" ? count + entry.message.previews.length : count;
    }, 0);
    const optionalSupportCount = sync.entries.filter((entry) => {
      if (entry.message.type === "result" && !entry.message.data.is_error) return true;
      return entry.message.type === "assistant" && entry.message.parent_tool_use_id != null;
    }).length;

    expect(mandatoryPreviewCount).toBe(toolIds.length);
    expect(optionalSupportCount).toBeLessThanOrEqual(THREAD_WINDOW_SUPPORT_RECORD_LIMIT);
  });

  it("keeps selected tool closure in the payload hash so stale incomplete caches miss", () => {
    // Adding mandatory previews changes the server hash, causing older preview-incomplete caches to be refetched.
    const history = [
      user("u1", "main tool"),
      bashAssistant("a1", "cmd", { toolUseId: "hash-tool" }),
      successfulResult("r1"),
      toolResultPreview("hash-tool", "hash result"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const brokenEntries = sync.entries.filter((entry) => entry.message.type !== "tool_result_preview");
    const fixedHash = computeHistoryPayloadSyncHash({ threadKey: sync.threadKey, entries: sync.entries });
    const brokenHash = computeHistoryPayloadSyncHash({ threadKey: sync.threadKey, entries: brokenEntries });

    expect(sync.entries.some((entry) => entry.message.type === "tool_result_preview")).toBe(true);
    expect(fixedHash).not.toBe(brokenHash);
  });

  it("delivers mandatory closure for All Threads windows while leaving orphan fallback bounded", () => {
    const toolIds = Array.from({ length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT + 2 }, (_, index) => `all-bash-${index}`);
    const allHistory: BrowserIncomingMessage[] = [
      user("u1", "global asks for tools"),
      ...toolIds.map((toolUseId, index) => bashAssistant(`a${index + 1}`, `all cmd ${index}`, { toolUseId })),
      successfulResult("r1"),
      multiToolResultPreview(toolIds.map((toolUseId, index) => ({ toolUseId, content: `all result ${index}` }))),
    ];

    const allSync = buildThreadWindowSync({
      messageHistory: allHistory,
      threadKey: "all",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const allPreviews = allSync.entries.flatMap((entry) =>
      entry.message.type === "tool_result_preview" ? entry.message.previews : [],
    );
    const orphanSync = buildThreadWindowSync({
      messageHistory: Array.from({ length: THREAD_WINDOW_SUPPORT_RECORD_LIMIT + 10 }, (_, index) =>
        toolResultPreview(`orphan-${index}`, `orphan ${index}`),
      ),
      threadKey: "main",
      fromItem: -1,
      itemCount: 10,
      sectionItemCount: 10,
      visibleItemCount: 1,
    });

    expect(allPreviews.map((preview) => preview.tool_use_id).sort()).toEqual([...toolIds].sort());
    expect(orphanSync.entries).toHaveLength(10);
    expect(orphanSync.entries.every((entry) => entry.message.type === "tool_result_preview")).toBe(true);
  });

  it("keeps target-message windows visible while adding mandatory preview closure", () => {
    const history: BrowserIncomingMessage[] = [];
    for (let index = 0; index < 8; index++) {
      history.push(user(`u${index}`, `message ${index}`));
      history.push(bashAssistant(`a${index}`, `cmd ${index}`, { toolUseId: `target-tool-${index}` }));
      history.push(successfulResult(`r${index}`));
      history.push(toolResultPreview(`target-tool-${index}`, `target result ${index}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 2,
      sectionItemCount: 2,
      visibleItemCount: 1,
      targetMessageId: "u3",
    });
    const visibleIds = new Set(
      sync.entries.flatMap((entry) =>
        entry.message.type === "assistant"
          ? entry.message.message.content.map((block) => (block.type === "tool_use" ? block.id : null))
          : [],
      ),
    );
    visibleIds.delete(null);
    const previewIds = new Set(
      sync.entries.flatMap((entry) =>
        entry.message.type === "tool_result_preview"
          ? entry.message.previews.map((preview) => preview.tool_use_id)
          : [],
      ),
    );

    expect(sync.entries.some((entry) => entry.message.type === "user_message" && entry.message.id === "u3")).toBe(true);
    expect(previewIds).toEqual(visibleIds);
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(true);
  });

  it("sanitizes selected mixed previews without authorizing unrelated later closure", () => {
    // In-range preview metadata is support, not a relation seed for unrelated tools in the same batch.
    const mixedPreview = {
      type: "tool_result_preview",
      previews: [
        ...(
          toolResultPreview("tool-main", "selected closure") as Extract<
            BrowserIncomingMessage,
            { type: "tool_result_preview" }
          >
        ).previews,
        ...(
          toolResultPreview("tool-other", "unrelated in-range closure") as Extract<
            BrowserIncomingMessage,
            { type: "tool_result_preview" }
          >
        ).previews,
      ],
    } satisfies BrowserIncomingMessage;
    const history = [
      assistant("a1", "selected main tool", { toolUseId: "tool-main" }),
      mixedPreview,
      successfulResult("r1"),
      toolResultPreview("tool-other", "later unrelated preview"),
      assistant("a5", "later unrelated parent closure", { parentToolUseId: "tool-other" }),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const previewEntries = sync.entries.filter((entry) => entry.message.type === "tool_result_preview");
    const supportRecordCount = sync.entries.reduce((count, entry) => {
      if (entry.message.type === "tool_result_preview") return count + entry.message.previews.length;
      if (entry.message.type === "result" && !entry.message.data.is_error) return count + 1;
      return count;
    }, 0);

    expect(sync.window).toEqual(
      expect.objectContaining({ item_count: 1, total_items: 2, has_older_items: false, has_newer_items: true }),
    );
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(previewEntries).toHaveLength(1);
    expect(previewEntries[0]?.message).toEqual(
      expect.objectContaining({
        type: "tool_result_preview",
        previews: [expect.objectContaining({ tool_use_id: "tool-main", content: "selected closure" })],
      }),
    );
    expect(supportRecordCount).toBeLessThanOrEqual(THREAD_WINDOW_SUPPORT_RECORD_LIMIT);
    expect(new Set(sync.entries.map((entry) => entry.history_index)).size).toBe(sync.entries.length);
  });

  it("bounds repeated matching support updates and retains the latest preview", () => {
    // A single visible tool row must not pull an unbounded matching replay/update tail into one browser window.
    const history: BrowserIncomingMessage[] = [
      assistant("a1", "main tool", { toolUseId: "tool-main" }),
      successfulResult("r1"),
    ];
    for (let index = 0; index < 140; index++) {
      history.push(toolResultPreview("tool-main", `matching preview ${index}`));
      history.push(successfulResult(`support-result-${index}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    const previews = sync.entries.filter(
      (entry): entry is typeof entry & { message: Extract<BrowserIncomingMessage, { type: "tool_result_preview" }> } =>
        entry.message.type === "tool_result_preview",
    );

    expect(sync.window.item_count).toBe(1);
    expect(sync.entries.length).toBeLessThanOrEqual(2 + THREAD_WINDOW_SUPPORT_RECORD_LIMIT);
    expect(previews).toHaveLength(1);
    expect(previews[0]?.history_index).toBe(history.length - 2);
    expect(previews[0]?.message.previews).toEqual([
      expect.objectContaining({ tool_use_id: "tool-main", content: "matching preview 139" }),
    ]);
  });

  it("preserves a standalone failed result while filtering successful result-only ranges", () => {
    // Failed results render as diagnostics and therefore cannot be discarded with invisible successful results.
    const history = [
      user("uq1", "quest request", "q-1205"),
      assistant("aq1", "quest response", { threadKey: "q-1205" }),
      successfulResult("r1"),
      user("uq2", "quest retry", "q-1205"),
      assistant("aq2", "quest failure", { threadKey: "q-1205" }),
      failedResult("r2"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 30,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });

    expect(sync.window.total_items).toBe(1);
    expect(sync.entries.map((entry) => entry.message)).toEqual([history[5]]);
  });

  it("keeps a genuinely empty Main projection empty", () => {
    // Successful result metadata alone is not conversation content and must not invent an available window.
    const sync = buildThreadWindowSync({
      messageHistory: [successfulResult("r1"), successfulResult("r2")],
      threadKey: "main",
      fromItem: -1,
      itemCount: 30,
      sectionItemCount: 10,
      visibleItemCount: 3,
    });

    expect(sync.entries).toEqual([]);
    expect(sync.window).toEqual(
      expect.objectContaining({ total_items: 0, has_older_items: false, has_newer_items: false }),
    );
  });

  it("uses matching rendered feed items as the window unit for large histories", () => {
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 1_000; i++) {
      history.push(user(`u${i}`, `message ${i}`, i % 100 === 0 ? "q-1" : "q-2"));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: -1,
      itemCount: 3,
      sectionItemCount: 3,
      visibleItemCount: 1,
    });

    expect(sync.window.source_history_length).toBe(1_000);
    expect(sync.window.total_items).toBe(10);
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(false);
    expect(sync.entries).toHaveLength(3);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([700, 800, 900]);
  });

  it("centers a thread window on a target message id when requested", () => {
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(user(`u${i}`, `message ${i}`));
      history.push(assistant(`a${i}`, `answer ${i}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 4,
      sectionItemCount: 2,
      visibleItemCount: 2,
      targetMessageId: "u6",
    });

    expect(sync.window.from_item).toBe(4);
    expect(sync.window.item_count).toBe(4);
    expect(sync.entries.some((entry) => entry.message.type === "user_message" && entry.message.id === "u6")).toBe(true);
    expect(sync.entries.map((entry) => entry.history_index)).toContain(12);
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(true);
  });

  it("centers a thread window on a legacy raw history index when requested", () => {
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(user(`u${i}`, `message ${i}`));
      history.push(assistant(`a${i}`, `answer ${i}`));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 4,
      sectionItemCount: 2,
      visibleItemCount: 2,
      targetHistoryIndex: 12,
    });

    expect(sync.window.from_item).toBe(4);
    expect(sync.entries.map((entry) => entry.history_index)).toContain(12);
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(true);
  });

  it("projects a server-authored recovery summary into its producer-shaped quest thread", () => {
    // The durable receipt carries ordinary server routing metadata and must not be frontend-invented or Main-leaking.
    const summary: BrowserIncomingMessage = {
      type: "codex_auto_pause_recovery_summary",
      id: "recovery-q-42",
      timestamp: 2,
      content: "Automatic input recovery: 1 delivered.",
      searchText: "automatic input recovery outcome:delivered",
      threadKey: "q-42",
      questId: "q-42",
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
      recovery: {
        family: "copilot_auth_refresh_exhausted",
        pausedAt: 1,
        recoveryConfirmedAt: 2,
        updatedAt: 3,
        status: "settled",
        receipts: [],
      },
    };
    const history = [user("u1", "main request"), summary];
    const windowOptions = { fromItem: -1, itemCount: 10, sectionItemCount: 5, visibleItemCount: 2 };
    const quest = buildThreadWindowSync({ messageHistory: history, threadKey: "q-42", ...windowOptions });
    const main = buildThreadWindowSync({ messageHistory: history, threadKey: "main", ...windowOptions });

    expect(quest.entries.map((entry) => entry.message.type)).toContain("codex_auto_pause_recovery_summary");
    expect(main.entries.map((entry) => entry.message.type)).not.toContain("codex_auto_pause_recovery_summary");
  });

  it("selects bounded ordinary windows from root rows instead of child-owned conversation ranges", () => {
    // The server window budget must be spent on rows the ordinary feed can
    // render; child-heavy tails remain available only through the inspector.
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const history: BrowserIncomingMessage[] = [
      user("root-user", "visible root request"),
      assistant("root-answer", "visible root answer"),
      successfulResult("root-result"),
    ];
    for (let index = 0; index < 4; index++) {
      const childUser = user(`child-user-${index}`, `hidden child request ${index}`);
      childUser.codexSubagent = ownership;
      const childAnswer = assistant(`child-answer-${index}`, `hidden child answer ${index}`);
      childAnswer.codexSubagent = ownership;
      const childResult = successfulResult(`child-result-${index}`);
      childResult.codexSubagent = ownership;
      history.push(childUser, childAnswer, childResult);
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 2,
      sectionItemCount: 1,
      visibleItemCount: 2,
      includeMessage: (message) => message.codexSubagent == null,
    });

    expect(sync.window).toEqual(
      expect.objectContaining({
        from_item: 0,
        item_count: 1,
        total_items: 1,
        source_history_length: history.length,
        has_older_items: false,
        has_newer_items: false,
      }),
    );
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(sync.entries.every((entry) => entry.message.codexSubagent == null)).toBe(true);
  });

  it("preserves raw history indexes while excluding ineligible rows before projected routing and closure", () => {
    // Search/feed consumers may exclude authoritative native-child rows, but
    // retained root targets must keep their durable raw history positions and
    // child-only routed runs must not synthesize Main activity markers.
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const childQuest = user("child-quest", "hidden child quest activity", "q-1975");
    childQuest.codexSubagent = ownership;
    const rootMain = user("root-main", "visible root activity");
    const history: BrowserIncomingMessage[] = [childQuest, rootMain];

    const entries = buildProjectedThreadEntries(history, "main", {
      includeMessage: (message) => message.codexSubagent == null,
    });

    expect(entries).toEqual([{ message: rootMain, history_index: 1 }]);
  });

  it("keeps root tool closure owner-scoped when a child reuses the same provider tool id", () => {
    // Provider tool ids are not session-global. Root-facing projections must
    // retain the root result at its raw index without admitting child support.
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const rootTool = bashAssistant("root-tool", "root command", { toolUseId: "shared-tool-id" });
    const childTool = bashAssistant("child-tool", "child command", { toolUseId: "shared-tool-id" });
    childTool.codexSubagent = ownership;
    const childSupport = assistant("child-support", "hidden child follow-up", {
      parentToolUseId: "shared-tool-id",
    });
    childSupport.codexSubagent = ownership;
    const childPreview = toolResultPreview("shared-tool-id", "hidden child result");
    childPreview.codexSubagent = ownership;
    const rootPreview = toolResultPreview("shared-tool-id", "visible root result");
    const history: BrowserIncomingMessage[] = [
      user("root-user", "run the root command"),
      rootTool,
      childTool,
      childSupport,
      childPreview,
      rootPreview,
    ];

    const entries = buildProjectedThreadEntries(history, "main", {
      includeMessage: (message) => message.codexSubagent == null,
    });

    expect(entries.map((entry) => entry.history_index)).toEqual([0, 1, 5]);
    expect(entries.some((entry) => entry.message === childTool || entry.message === childSupport)).toBe(false);
    const preview = entries.at(-1)?.message;
    expect(preview?.type).toBe("tool_result_preview");
    if (preview?.type === "tool_result_preview") {
      expect(preview.codexSubagent).toBeUndefined();
      expect(preview.previews).toEqual([expect.objectContaining({ content: "visible root result" })]);
    }
  });

  it("does not reintroduce an excluded child result at the next root turn boundary", () => {
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const childResult = successfulResult("child-result");
    childResult.codexSubagent = ownership;
    const history: BrowserIncomingMessage[] = [
      user("root-one", "first root turn"),
      assistant("root-answer", "root answer"),
      childResult,
      user("root-two", "second root turn"),
    ];

    const entries = buildProjectedThreadEntries(history, "main", {
      includeMessage: (message) => message.codexSubagent == null,
    });

    expect(entries.map((entry) => entry.history_index)).toEqual([0, 1, 3]);
    expect(entries.some((entry) => entry.message === childResult)).toBe(false);
  });

  it("keeps reasoning details in chronological order only in their attributed thread", () => {
    const reasoning: BrowserIncomingMessage = {
      type: "codex_reasoning_detail",
      id: "codex-reasoning-r1",
      text: "**Inspecting route state**\n\nFull detail.",
      status: "complete",
      timestamp: 2,
      parent_tool_use_id: null,
      threadKey: "q-1842",
      questId: "q-1842",
      threadRefs: [{ threadKey: "q-1842", questId: "q-1842", source: "explicit" }],
    };
    const history = [
      user("u1", "quest request", "q-1842"),
      reasoning,
      assistant("a1", "answer", { threadKey: "q-1842" }),
    ];
    const options = { fromItem: -1, itemCount: 10, sectionItemCount: 5, visibleItemCount: 2 };

    const quest = buildThreadWindowSync({ messageHistory: history, threadKey: "q-1842", ...options });
    const main = buildThreadWindowSync({ messageHistory: history, threadKey: "main", ...options });

    expect(quest.entries.map((entry) => entry.message.type)).toEqual([
      "user_message",
      "codex_reasoning_detail",
      "assistant",
    ]);
    expect(main.entries.map((entry) => entry.message.type)).not.toContain("codex_reasoning_detail");
  });
});
