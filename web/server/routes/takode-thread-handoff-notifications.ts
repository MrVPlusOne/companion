import {
  leaderResponseProvenCurrentOwnerThreadKey,
  type LeaderResponseThreadRouteFields,
} from "../../shared/leader-thread-response-routing.js";
import { normalizeThreadTarget, parseThreadTextPrefix } from "../../shared/thread-routing.js";
import { extractThreadStatusMarkersFromText } from "../../shared/thread-status-marker.js";
import type { Session } from "../bridge/ws-bridge-session.js";
import { isRootAgentHistoryMessage } from "../root-agent-feed-message.js";
import type { BrowserIncomingMessage, SessionNotification } from "../session-types.js";

type NotificationAnchor = { historyIndex: number; message: BrowserIncomingMessage };

export type ThreadHandoffNotificationsPreparation =
  | {
      ok: true;
      notifications: SessionNotification[];
      alreadyHandedOffNotificationIds: string[];
      anchors: NotificationAnchor[];
    }
  | { ok: false; error: string };

/**
 * Prepare exact unresolved Main prompts for an atomic handoff without changing
 * their identity, decisions, or history. New moves retain the original objects;
 * already-transferred prompts are reported separately for idempotent retries.
 */
export function prepareThreadHandoffNotifications(
  session: Pick<Session, "messageHistory" | "notifications">,
  questId: string,
  notificationIds: readonly string[],
): ThreadHandoffNotificationsPreparation {
  if (!/^q-\d+$/.test(questId)) return { ok: false, error: "questId must be a canonical q-N ID" };
  if (
    notificationIds.some((id) => !/^n-[1-9]\d*$/.test(id)) ||
    new Set(notificationIds).size !== notificationIds.length
  ) {
    return { ok: false, error: "notificationIds must contain unique canonical n-N IDs" };
  }

  const notifications: SessionNotification[] = [];
  const alreadyHandedOffNotificationIds: string[] = [];
  const anchors: NotificationAnchor[] = [];
  const selectedAnchorIndices = new Set<number>();
  for (const id of notificationIds) {
    const matching = session.notifications.filter((notification) => notification.id === id);
    const notification = matching[0];
    if (matching.length !== 1 || !notification || notification.category !== "needs-input") {
      return { ok: false, error: `${id} must identify exactly one needs-input notification` };
    }
    if (!notification.messageId?.trim()) return { ok: false, error: `${id} has no original prompt message ID` };
    const matchingAnchors = session.messageHistory.flatMap((message, historyIndex) =>
      message.type === "assistant" && message.message.id === notification.messageId ? [{ historyIndex, message }] : [],
    );
    const anchor = matchingAnchors[0];
    if (matchingAnchors.length !== 1 || !anchor || !isOriginalMainPrompt(anchor.message)) {
      return { ok: false, error: `${id} must retain exactly one substantive root assistant prompt owned by Main` };
    }
    if (selectedAnchorIndices.has(anchor.historyIndex)) {
      return { ok: false, error: `${id} shares its original prompt with another selected notification` };
    }
    selectedAnchorIndices.add(anchor.historyIndex);
    const payload = anchor.message.notification;
    if (payload && ((payload.id !== undefined && payload.id !== id) || payload.category !== "needs-input")) {
      return { ok: false, error: `${id} does not match its anchored notification metadata` };
    }

    // Older notifications can omit their own route, but the original prompt
    // must prove Main ownership; never infer Main from two missing routes.
    const owner = consistentOwner(notification, "main");
    if (
      owner === questId &&
      payload &&
      payload.id === id &&
      consistentOwner(payload) === questId &&
      anchor.message.threadRefs?.some(
        (ref) => ref.source === "backfill" && ref.threadKey === questId && ref.questId === questId,
      )
    ) {
      alreadyHandedOffNotificationIds.push(id);
      continue;
    }
    if (notification.done) return { ok: false, error: `${id} must be unresolved for a new handoff` };
    if (owner === "main" && (!payload || consistentOwner(payload, "main") === "main")) {
      notifications.push(notification);
      anchors.push(anchor);
      continue;
    }
    return { ok: false, error: `${id} has conflicting ownership or is not a Main prompt handed off to ${questId}` };
  }
  return { ok: true, notifications, alreadyHandedOffNotificationIds, anchors };
}

function consistentOwner(fields: LeaderResponseThreadRouteFields, missingRouteOwner?: string): string | null {
  const thread = fields.threadKey === undefined ? undefined : normalizeThreadTarget(fields.threadKey)?.threadKey;
  const quest = fields.questId === undefined ? undefined : normalizeThreadTarget(fields.questId)?.threadKey;
  if ((fields.threadKey !== undefined && !thread) || (fields.questId !== undefined && (!quest || quest === "main"))) {
    return null;
  }
  if (thread && quest && thread !== quest) return null;
  const direct = thread ?? quest;
  if (!direct) {
    if (!missingRouteOwner || fields.threadRefs?.some((ref) => ref.source !== "backfill")) return null;
    return missingRouteOwner;
  }
  return leaderResponseProvenCurrentOwnerThreadKey(fields) === direct ? direct : null;
}

function isOriginalMainPrompt(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): boolean {
  if (!isRootAgentHistoryMessage(message) || message.parent_tool_use_id != null || message.threadRoutingError) {
    return false;
  }
  if (consistentOwner(message) !== "main") return false;
  const text = message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const parsed = parseThreadTextPrefix(text);
  if (parsed.ok ? parsed.target.threadKey !== "main" : parsed.reason !== "missing") return false;
  const visible = extractThreadStatusMarkersFromText(parsed.ok ? parsed.body : text).text.replace(/<!--[^]*?-->/g, "");
  return /[\p{L}\p{N}]/u.test(visible);
}
