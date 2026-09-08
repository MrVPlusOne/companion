import { describe, expect, it, vi } from "vitest";
import type {
  BrowserIncomingMessage,
  ChatMessage,
  ContentBlock,
  SessionNotification,
  ToolResultPreview,
} from "../types.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";
import { projectNotificationDisplayAnchors } from "./notification-targets.js";

type RawAssistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function assistant(
  id: string,
  historyIndex: number,
  content: ContentBlock[],
  overrides: Partial<RawAssistant> = {},
): ChatMessage {
  return normalizeHistoryMessageToChatMessages(
    {
      type: "assistant",
      timestamp: historyIndex * 10,
      parent_tool_use_id: null,
      threadKey: "q-301",
      questId: "q-301",
      threadRefs: [{ threadKey: "q-301", questId: "q-301", source: "explicit" }],
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content,
      },
      ...overrides,
    },
    historyIndex,
  )[0]!;
}

function tool(id: string, historyIndex: number, command: string, overrides: Partial<RawAssistant> = {}): ChatMessage {
  return assistant(
    id,
    historyIndex,
    [{ type: "tool_use", id: `${id}-tool`, name: "Bash", input: { command } }],
    overrides,
  );
}

function receipt(toolUseId = "notify-tool", content = "Notification sent (needs-input, id 870)"): ToolResultPreview {
  return {
    tool_use_id: toolUseId,
    content,
    is_error: false,
    total_size: content.length,
    is_truncated: false,
    duration_seconds: 0.1,
  };
}

function fixture(done = false) {
  const oldAnchor = assistant("old-answer", 10, [{ type: "text", text: "Earlier answer.\n\n{[(Quest Quiz: q-300)]}" }]);
  // A request can belong to another quest while being explicitly attached here.
  // Matching only its immutable owner would miss the intervening human boundary.
  const boundary = normalizeHistoryMessageToChatMessages(
    {
      type: "user_message",
      id: "new-request",
      content: "Prepare the proposal for review.",
      timestamp: 200,
      threadKey: "q-302",
      questId: "q-302",
      threadRefs: [
        { threadKey: "q-302", questId: "q-302", source: "explicit" },
        { threadKey: "q-301", questId: "q-301", source: "backfill" },
      ],
      leaderResponseCoverageVersion: 1,
      leaderUserMessageId: "u2",
    },
    20,
  )[0]!;
  const proposal = tool("proposal", 29, 'takode board propose --summary "Review this proposal."');
  // The notification is created before the executing notify row is persisted.
  const notify = tool("notify", 30, 'takode notify needs-input "Review proposal" --suggest yes --suggest no', {
    timestamp: 335,
  });
  const notification: SessionNotification = {
    id: "n-870",
    category: "needs-input",
    summary: "Review proposal",
    suggestedAnswers: ["yes", "no"],
    questions: [{ prompt: "Approve the proposal?", suggestedAnswers: ["yes", "no"] }],
    timestamp: 300,
    messageId: oldAnchor.id,
    threadKey: "q-301",
    questId: "q-301",
    threadRefs: [{ threadKey: "q-301", questId: "q-301", source: "explicit" }],
    done,
    muted: true,
    mutedAt: 301,
    ...(done
      ? { resolutionNotice: { status: "delivered" as const, source: "response" as const, resolvedAt: 400 } }
      : {}),
  };
  return {
    notification,
    notifications: [notification],
    messages: [oldAnchor, boundary, proposal, notify],
    toolResults: new Map([["notify-tool", receipt()]]),
  };
}

describe("projectNotificationDisplayAnchors", () => {
  it.each([false, true])("projects the exact source tool for a stale notification, done=%s", (done) => {
    // Presentation may move both active and historical prompts, but must not
    // rewrite durable notification state or copy the earlier answer/Quiz.
    const source = fixture(done);
    const unchanged: SessionNotification = { ...source.notification, id: "n-871", category: "review" };
    const notifications = [source.notification, unchanged];
    const original = structuredClone(source);
    const result = projectNotificationDisplayAnchors(notifications, source.messages, source.toolResults)!;

    expect(result).not.toBe(notifications);
    expect(result[0]).toEqual({ ...source.notification, messageId: "notify" });
    expect(result[0]).not.toBe(source.notification);
    expect(result[0]!.questions).toBe(source.notification.questions);
    expect(result[0]!.suggestedAnswers).toBe(source.notification.suggestedAnswers);
    expect(result[0]!.threadRefs).toBe(source.notification.threadRefs);
    expect(result[0]!.resolutionNotice).toBe(source.notification.resolutionNotice);
    expect(result[1]).toBe(unchanged);
    expect(source).toEqual(original);
  });

  it.each(["\n(123ms)", "\n(0.1s)"])("accepts the normal CLI duration suffix %j", (suffix) => {
    const source = fixture();
    source.toolResults.set("notify-tool", receipt("notify-tool", `Notification sent (needs-input, id 870)${suffix}`));
    expect(
      projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)?.[0]?.messageId,
    ).toBe("notify");
  });

  it("uses source history order even when bounded entries arrive out of order", () => {
    const source = fixture();
    const messages = [source.messages[3]!, source.messages[0]!, source.messages[2]!, source.messages[1]!];
    expect(projectNotificationDisplayAnchors(source.notifications, messages, source.toolResults)?.[0]?.messageId).toBe(
      "notify",
    );
    expect(messages.map((message) => message.id)).toEqual(["notify", "old-answer", "proposal", "new-request"]);
  });

  it("preserves the original array when the current anchor is already valid", () => {
    const source = fixture();
    source.notification.messageId = "proposal";
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
    expect(projectNotificationDisplayAnchors(undefined, source.messages, source.toolResults)).toBeUndefined();
    const empty: SessionNotification[] = [];
    expect(projectNotificationDisplayAnchors(empty, source.messages, source.toolResults)).toBe(empty);
  });

  it.each([
    ["failed", { is_error: true }],
    ["truncated", { is_truncated: true }],
    ["synthetic", { synthetic_reason: "orphaned_tool" }],
    ["wrong tool identity", { tool_use_id: "another-tool" }],
    ["wrong notification", { content: "Notification sent (needs-input, id 871)" }],
    ["wrong category", { content: "Notification sent (review, id 870)" }],
    ["extra output", { content: "Notification sent (needs-input, id 870)\nAnother notification may exist." }],
  ] satisfies [string, Partial<ToolResultPreview>][])("rejects a %s receipt", (_name, patch) => {
    // A nearby tool or a plausible-looking preview cannot provide authority to
    // relocate a notification without the exact successful producer receipt.
    const source = fixture();
    source.toolResults.set("notify-tool", { ...receipt(), ...patch });
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("leaves missing receipt evidence unchanged", () => {
    const source = fixture();
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, undefined)).toBe(
      source.notifications,
    );
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, new Map())).toBe(
      source.notifications,
    );
  });

  it("rejects ambiguous successful source tools for the same notification", () => {
    const source = fixture();
    source.messages.push(tool("second-notify", 31, 'takode notify needs-input "Review proposal"'));
    source.toolResults.set("second-notify-tool", receipt("second-notify-tool"));
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("preserves separate anchors when two notify calls share one proposed display host", () => {
    // MessageBubble supports one inline notification per source message. Two
    // proven receipts must not merge two working cards into a rejected pair.
    const source = fixture();
    source.messages.splice(
      1,
      0,
      assistant("other-old-answer", 11, [{ type: "text", text: "Another earlier prompt." }]),
    );
    source.messages.at(-1)!.contentBlocks!.push({
      type: "tool_use",
      id: "other-notify-tool",
      name: "Bash",
      input: { command: 'takode notify needs-input "Another question"' },
    });
    source.notifications.push({ ...source.notification, id: "n-871", messageId: "other-old-answer" });
    source.toolResults.set(
      "other-notify-tool",
      receipt("other-notify-tool", "Notification sent (needs-input, id 871)"),
    );
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("does not move a card onto another notification's existing host", () => {
    const source = fixture();
    source.notifications.push({ ...source.notification, id: "n-871", messageId: "notify" });
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([
    'echo "takode notify needs-input"',
    'takode notify review "Review proposal"',
  ])("rejects a non-producing command %j", (command) => {
    const source = fixture();
    source.messages[3] = tool("notify", 30, command);
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("requires an intervening direct human request associated with the destination", () => {
    const source = fixture();
    const noBoundary = source.messages.filter((message) => message.id !== "new-request");
    expect(projectNotificationDisplayAnchors(source.notifications, noBoundary, source.toolResults)).toBe(
      source.notifications,
    );
    source.messages[1]!.agentSource = { sessionId: "herd-events" };
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
    delete source.messages[1]!.agentSource;
    source.messages[1]!.metadata!.threadRefs = [{ threadKey: "q-302", questId: "q-302", source: "explicit" }];
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([
    "native",
    "parent-tool",
  ])("does not borrow a %s child-owned human boundary for a root notification", (kind) => {
    // Projection runs before ordinary root-feed filtering, so ownership must be
    // checked on the request proof as well as the assistant receipt source.
    const source = fixture();
    if (kind === "native") {
      source.messages[1]!.metadata!.codexSubagent = { childId: "opaque-child", rootTurnId: "root-turn" };
    } else {
      source.messages[1]!.parentToolUseId = "parent-tool";
    }
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each(["old anchor", "source tool", "notification"])("rejects a foreign route on the %s", (target) => {
    const source = fixture();
    const route = {
      threadKey: "q-303",
      questId: "q-303",
      threadRefs: [{ threadKey: "q-303", questId: "q-303", source: "explicit" as const }],
    };
    if (target === "notification") Object.assign(source.notification, route);
    else Object.assign(source.messages[target === "old anchor" ? 0 : 3]!.metadata!, route);
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([
    { parent_tool_use_id: "parent-tool" },
    { codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" } },
  ] satisfies Partial<RawAssistant>[])("rejects child-owned source tools %j", (ownership) => {
    const source = fixture();
    source.messages[3] = tool("notify", 30, 'takode notify needs-input "Review proposal"', ownership);
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([
    "old-anchor id",
    "old-anchor index",
    "source id",
    "source index",
  ])("rejects duplicate %s proof", (duplicate) => {
    const source = fixture();
    const original = source.messages[duplicate.startsWith("old") ? 0 : 3]!;
    source.messages.push({
      ...original,
      id: duplicate.endsWith("id") ? original.id : "conflicting-row",
      historyIndex: duplicate.endsWith("index") ? original.historyIndex : 40,
    });
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([undefined, -1, Number.NaN])("requires a valid old-anchor history index: %s", (historyIndex) => {
    const source = fixture();
    source.messages[0]!.historyIndex = historyIndex;
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("requires the old anchor to be delivered", () => {
    const source = fixture();
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages.slice(1), source.toolResults)).toBe(
      source.notifications,
    );
  });

  it.each([
    100, 199, 200,
  ])("does not reinterpret a notification created before the request boundary: %s", (timestamp) => {
    const source = fixture();
    source.notification.timestamp = timestamp;
    expect(projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)).toBe(
      source.notifications,
    );
  });

  it("does not rescan every tool result for every notification", () => {
    // A long delivered window and inbox must not multiply preview lookups;
    // source evidence is indexed once and reused for notification projection.
    const source = fixture();
    for (let index = 0; index < 100; index += 1) {
      source.messages.push(tool(`irrelevant-${index}`, 40 + index, 'printf "ordinary tool output"'));
      source.notifications.push({ ...source.notification, id: `n-${900 + index}` });
    }
    const get = vi.spyOn(source.toolResults, "get");
    const projected = projectNotificationDisplayAnchors(source.notifications, source.messages, source.toolResults)!;
    expect(projected[0]!.messageId).toBe("notify");
    expect(projected.slice(1)).toEqual(source.notifications.slice(1));
    expect(get.mock.calls.length).toBeLessThanOrEqual(source.messages.length);
  });
});
