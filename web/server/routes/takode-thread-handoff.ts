import type { Hono } from "hono";
import { isValidQuestId } from "../../shared/quest-journey.js";
import { prepareLeaderThreadHandoff } from "../leader-thread-handoff.js";
import { broadcastNotificationRefresh } from "../bridge/session-notification-controller.js";
import { clearLeaderThreadStatusForActivity } from "../bridge/thread-routing-reminder.js";
import type { BrowserIncomingMessage, ThreadAttachmentMarker, ThreadRef } from "../session-types.js";
import { buildThreadAttachmentSelection, messageIdForThreadAttachment } from "../thread-routing-metadata.js";
import type { RouteContext } from "./context.js";
import { prepareThreadHandoffNotifications } from "./takode-thread-handoff-notifications.js";
import {
  buildThreadAttachmentBoundError,
  pendingThreadAttachmentChangedCount,
  scheduleThreadAttachmentUpdateBroadcast,
  THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES,
} from "./takode-thread-attachment-broadcast.js";

/** Transfer exact unfinished Main requests without answering them or changing raw history. */
export function registerTakodeThreadHandoffRoute(api: Hono, ctx: RouteContext): void {
  const { authenticateTakodeCaller, resolveId, wsBridge } = ctx;
  api.post("/sessions/:id/thread/handoff", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) return c.json({ error: "Can only hand off your own leader requests" }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "A handoff selection is required" }, 400);
    const questId = typeof body.questId === "string" ? body.questId.trim().toLowerCase() : "";
    if (!isValidQuestId(questId)) return c.json({ error: "questId must match q-N format" }, 400);
    const userMessageIds = body.userMessageIds;
    const notificationIds = body.notificationIds ?? [];
    if (
      !Array.isArray(userMessageIds) ||
      userMessageIds.length === 0 ||
      !userMessageIds.every((value) => typeof value === "string") ||
      !Array.isArray(notificationIds) ||
      !notificationIds.every((value) => typeof value === "string") ||
      userMessageIds.length + notificationIds.length > THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES
    ) {
      return c.json({ error: "Select 1-100 exact user/notification IDs, including at least one user ID" }, 400);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);
    const row = session.board.get(questId);
    if (
      !row?.worker ||
      row.completedAt !== undefined ||
      !["PLANNING", "WORKING", "USER_CHECKPOINTING", "MEMORY"].includes(row.status ?? "")
    ) {
      return c.json({ error: "The destination must be an active quest on your work board" }, 409);
    }

    // All preconditions precede mutation, with no await between the snapshot and commit.
    const requestPlan = prepareLeaderThreadHandoff(session, questId, userMessageIds);
    if (!requestPlan.ok) return c.json({ error: requestPlan.error }, 409);
    const notificationPlan = prepareThreadHandoffNotifications(session, questId, notificationIds);
    if (!notificationPlan.ok) return c.json({ error: notificationPlan.error }, 409);
    const changedEntries = new Map<number, BrowserIncomingMessage>();
    for (const request of requestPlan.requests) changedEntries.set(request.historyIndex, request.message);
    for (const anchor of notificationPlan.anchors) changedEntries.set(anchor.historyIndex, anchor.message);
    const changedIndices = [...changedEntries.keys()].sort((a, b) => a - b);
    const boundError = buildThreadAttachmentBoundError({
      questId,
      historyLength: session.messageHistory.length,
      selectedIndices: changedIndices,
      changedCount: changedIndices.length,
      pendingChangedCount: pendingThreadAttachmentChangedCount(id),
    });
    if (boundError) return c.json(boundError, 400);
    const result = {
      ok: true,
      sessionId: id,
      questId,
      handedOffUserMessageIds: requestPlan.requests.map((request) => request.userMessageId),
      alreadyHandedOffUserMessageIds: requestPlan.alreadyHandedOffUserMessageIds,
      notificationIds: notificationPlan.notifications.map((notification) => notification.id),
      alreadyHandedOffNotificationIds: notificationPlan.alreadyHandedOffNotificationIds,
    };
    if (changedIndices.length === 0) return c.json(result);

    const routeSources = [
      ...changedEntries.values(),
      ...notificationPlan.notifications,
      ...notificationPlan.anchors.flatMap(({ message }) =>
        message.type === "assistant" && message.notification ? [message.notification] : [],
      ),
    ];
    const previousTimes = routeSources.flatMap((entry) =>
      (entry.threadRefs ?? []).flatMap((ref) => (typeof ref.attachedAt === "number" ? [ref.attachedAt] : [])),
    );
    const timestamp = Math.max(Date.now(), ...previousTimes.map((value) => value + 1));
    if (!Number.isSafeInteger(timestamp)) {
      return c.json({ error: "Cannot establish a newer authoritative handoff timestamp" }, 409);
    }
    const target = { threadKey: questId, questId };
    const ref: ThreadRef = { ...target, source: "explicit", attachedAt: timestamp, attachedBy: id };
    for (const request of requestPlan.requests) {
      request.message.threadRefs = [...(request.message.threadRefs ?? []), ref];
    }
    for (const notification of notificationPlan.notifications) {
      Object.assign(notification, target, { threadRefs: [...(notification.threadRefs ?? []), ref] });
    }
    for (const { message } of notificationPlan.anchors) {
      message.threadRefs = [...(message.threadRefs ?? []), { ...ref, source: "backfill" }];
      if (message.type === "assistant") {
        const notification = notificationPlan.notifications.find((entry) => entry.messageId === message.message.id)!;
        message.notification ??= {
          id: notification.id,
          category: notification.category,
          summary: notification.summary,
          questions: notification.questions,
          suggestedAnswers: notification.suggestedAnswers,
          timestamp: notification.timestamp,
        };
        Object.assign(message.notification, target, {
          id: notification.id,
          threadRefs: [...(message.notification.threadRefs ?? []), ref],
        });
      }
    }

    const selection = buildThreadAttachmentSelection(session.messageHistory, questId, changedIndices);
    const markerHistoryIndex = session.messageHistory.length;
    const marker: ThreadAttachmentMarker = {
      type: "thread_attachment_marker",
      id: `thread-handoff-${timestamp}-${markerHistoryIndex}`,
      markerKey: `handoff:${selection.markerKey}`,
      timestamp,
      sourceThreadKey: "main",
      ...target,
      attachedAt: timestamp,
      attachedBy: id,
      messageIds: selection.messageIds,
      messageIndices: selection.indices,
      ranges: selection.ranges,
      count: selection.indices.length,
      firstMessageId: selection.firstMessageId,
      firstMessageIndex: selection.firstMessageIndex,
    };
    session.messageHistory.push(marker);
    clearLeaderThreadStatusForActivity(session, target, {
      messageId: marker.id,
      timestamp,
    });
    wsBridge.promoteLeaderThreadTabForAttachment(id, questId, timestamp);
    scheduleThreadAttachmentUpdateBroadcast(wsBridge, id, {
      target,
      source: { threadKey: "main" },
      markers: [marker],
      markerHistoryIndices: [markerHistoryIndex],
      changedMessages: changedIndices.map((historyIndex) => {
        const message = changedEntries.get(historyIndex)!;
        return {
          historyIndex,
          messageId: messageIdForThreadAttachment(message, historyIndex),
          threadRefs: message.threadRefs ?? [],
        };
      }),
      ranges: selection.ranges,
      count: changedIndices.length,
    });
    if (notificationPlan.notifications.length > 0) {
      broadcastNotificationRefresh(session, {
        broadcastToBrowsers: (_session, message) => wsBridge.broadcastToSession(id, message),
        persistSession: () => wsBridge.persistSessionById(id),
      });
    } else {
      wsBridge.persistSessionById(id);
    }
    return c.json(result);
  });
}
