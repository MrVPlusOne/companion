import type { ChatMessage, SessionNotification, ToolResultPreview } from "../types.js";
import {
  leaderResponseAssociatedThreadKeys,
  leaderResponseExactAnswerThreadKey,
} from "../../shared/leader-thread-response-routing.js";
import { parseHerdEvents } from "./herd-event-parser.js";
import { isInjectedEventMessage } from "./injected-event-message.js";
import { parseTakodeNotifyCommand } from "./takode-tool-command.js";

/**
 * Correct display placement only when an available successful notify receipt
 * proves that a persisted anchor predates a newer associated human request.
 * Work is limited to delivered messages and their existing tool previews; raw
 * notification identity, state, history, and action routing remain unchanged.
 */
export function projectNotificationDisplayAnchors(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  messages: ReadonlyArray<ChatMessage>,
  toolResults: ReadonlyMap<string, ToolResultPreview> | undefined,
): ReadonlyArray<SessionNotification> | undefined {
  if (!notifications?.length || !messages.length || !toolResults?.size) return notifications;

  const messagesById = new Map<string, ChatMessage | null>();
  const messagesByIndex = new Map<number, ChatMessage | null>();
  const notificationsById = new Map<string, SessionNotification | null>();
  const occupiedAnchors = new Set<string>();
  for (const notification of notifications) {
    notificationsById.set(notification.id, notificationsById.has(notification.id) ? null : notification);
    if (notification.messageId) occupiedAnchors.add(notification.messageId);
  }
  for (const message of messages) {
    messagesById.set(message.id, messagesById.has(message.id) ? null : message);
    if (Number.isInteger(message.historyIndex) && message.historyIndex! >= 0) {
      messagesByIndex.set(message.historyIndex!, messagesByIndex.has(message.historyIndex!) ? null : message);
    }
  }

  const latestHumanByThread = new Map<string, ChatMessage>();
  const sourceByNotificationId = new Map<string, string | null>();
  const orderedMessages = [...messagesByIndex.entries()].sort(([left], [right]) => left - right);
  for (const [, message] of orderedMessages) {
    if (!message || messagesById.get(message.id) !== message) continue;
    if (message.parentToolUseId != null || message.metadata?.codexSubagent != null) continue;
    if (message.role === "user" && !message.agentSource && !isInjectedEventMessage(message)) {
      for (const threadKey of leaderResponseAssociatedThreadKeys(message.metadata ?? {})) {
        latestHumanByThread.set(threadKey, message);
      }
      continue;
    }
    if (!isRootAssistant(message)) continue;
    const threadKey = leaderResponseExactAnswerThreadKey(message.metadata ?? {});
    if (!threadKey) continue;
    for (const block of message.contentBlocks ?? []) {
      if (
        block.type !== "tool_use" ||
        block.name !== "Bash" ||
        parseTakodeNotifyCommand(String(block.input.command ?? ""))?.category !== "needs-input"
      ) {
        continue;
      }
      const notificationId = successfulNotificationReceipt(toolResults.get(block.id), block.id);
      if (!notificationId) continue;
      const notification = notificationsById.get(notificationId);
      if (!notification || notification.category !== "needs-input") continue;
      // Multiple successful sources for one notification can be a retry; they
      // do not prove which source owns a replacement display anchor.
      if (sourceByNotificationId.has(notificationId)) {
        sourceByNotificationId.set(notificationId, null);
        continue;
      }
      sourceByNotificationId.set(notificationId, null);
      const anchor = notification.messageId ? messagesById.get(notification.messageId) : null;
      const boundary = latestHumanByThread.get(threadKey);
      if (
        !anchor ||
        !isRootAssistant(anchor) ||
        !boundary ||
        messagesByIndex.get(anchor.historyIndex!) !== anchor ||
        anchor.historyIndex! >= boundary.historyIndex! ||
        boundary.historyIndex! >= message.historyIndex! ||
        !Number.isFinite(notification.timestamp) ||
        !Number.isFinite(boundary.timestamp) ||
        boundary.timestamp >= notification.timestamp ||
        leaderResponseExactAnswerThreadKey(anchor.metadata ?? {}) !== threadKey ||
        leaderResponseExactAnswerThreadKey(notification) !== threadKey
      ) {
        continue;
      }
      sourceByNotificationId.set(notificationId, message.id);
    }
  }

  const targetCounts = new Map<string, number>();
  for (const messageId of sourceByNotificationId.values()) {
    if (messageId) targetCounts.set(messageId, (targetCounts.get(messageId) ?? 0) + 1);
  }
  let changed = false;
  const projected = notifications.map((notification) => {
    const messageId = sourceByNotificationId.get(notification.id);
    if (!messageId || notification.messageId === messageId) return notification;
    // Inline hosts support one notification. A move must neither take an
    // existing host nor merge distinct cards into an ambiguous hidden pair.
    if (occupiedAnchors.has(messageId) || targetCounts.get(messageId) !== 1) return notification;
    changed = true;
    return { ...notification, messageId };
  });
  return changed ? projected : notifications;
}

/** Apply a proven display move to copies of the delivered message annotations. */
export function projectNotificationMessageAnnotations(
  messages: ChatMessage[],
  original: ReadonlyArray<SessionNotification> | undefined,
  projected: ReadonlyArray<SessionNotification> | undefined,
): ChatMessage[] {
  if (!original || !projected || original === projected) return messages;
  const moved = new Map<string, SessionNotification>();
  const targets = new Map<string, SessionNotification | null>();
  projected.forEach((notification, index) => {
    if (notification.messageId === original[index]?.messageId || !notification.messageId) return;
    moved.set(notification.id, notification);
    targets.set(notification.messageId, targets.has(notification.messageId) ? null : notification);
  });
  return messages.map((message) => {
    const target = targets.get(message.id);
    const stale = message.notification?.id ? moved.get(message.notification.id) : undefined;
    if (target) return { ...message, notification: target };
    if (!stale || stale.messageId === message.id) return message;
    const { notification: _notification, ...withoutNotification } = message;
    return withoutNotification;
  });
}

function isRootAssistant(message: ChatMessage): boolean {
  return message.role === "assistant" && message.parentToolUseId == null && !message.metadata?.codexSubagent;
}

function successfulNotificationReceipt(result: ToolResultPreview | undefined, toolUseId: string): string | null {
  if (
    !result ||
    result.tool_use_id !== toolUseId ||
    result.is_error ||
    result.is_truncated ||
    result.synthetic_reason ||
    result.content.length > 1024
  ) {
    return null;
  }
  const match = /^Notification sent \(needs-input, id (\d+)\)(?:\r?\n\(\d+(?:\.\d+)?(?:ms|s)\))?\s*$/.exec(
    result.content,
  );
  return match ? `n-${match[1]}` : null;
}

export function getActionableNotificationMessageId(
  notification: Pick<SessionNotification, "category" | "messageId">,
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "content" | "agentSource">> | undefined,
): string | null {
  if (!notification.messageId) return null;
  if (notification.category !== "needs-input") return notification.messageId;
  const anchor = messages?.find((message) => message.id === notification.messageId);
  if (!anchor) return notification.messageId;
  return isRelevantNeedsInputAnchor(anchor) ? notification.messageId : null;
}

export function sanitizeNotificationMessageTargets(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "content" | "agentSource">>,
): ReadonlyArray<SessionNotification> | undefined {
  if (!notifications || notifications.length === 0 || messages.length === 0) return notifications;
  let changed = false;
  const sanitized = notifications.map((notification) => {
    if (getActionableNotificationMessageId(notification, messages) === notification.messageId) return notification;
    changed = true;
    return { ...notification, messageId: null };
  });
  return changed ? sanitized : notifications;
}

function isRelevantNeedsInputAnchor(message: Pick<ChatMessage, "content" | "agentSource">): boolean {
  if (message.agentSource?.sessionId !== "herd-events") return true;
  const events = parseHerdEvents(message.content);
  if (events.length === 0) return true;
  return events.some((event) => event.header.includes("| notification_needs_input"));
}
