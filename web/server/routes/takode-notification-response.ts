import type { Hono } from "hono";
import { formatReplyContentForAssistant } from "../../shared/reply-context.js";
import { markNotificationDone as markNotificationDoneController } from "../bridge/session-registry-controller.js";
import { normalizeThreadRoute } from "../thread-routing-metadata.js";
import type { RouteContext } from "./context.js";
import { acknowledgeMonitoredThreadResult } from "../thread-monitoring.js";

type NotificationPersistDeps = Parameters<typeof markNotificationDoneController>[3];

export function registerTakodeNotificationResponseRoute(
  api: Hono,
  ctx: RouteContext,
  notificationPersistDeps: NotificationPersistDeps,
) {
  const { launcher, wsBridge, resolveId } = ctx;

  api.post("/sessions/:id/notifications/:notifId/response", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const launcherSession = launcher.getSession(id);
    if (!launcherSession) return c.json({ error: "Session not found" }, 404);
    if (launcherSession.archived) return c.json({ error: "Cannot send to archived session" }, 409);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const notifId = c.req.param("notifId");
    const notification = session.notifications.find(
      (entry) => entry.id === notifId && entry.category === "needs-input",
    );
    if (!notification) return c.json({ error: "Notification not found" }, 404);
    if (notification.done) {
      markNotificationDoneController(session, notifId, true, notificationPersistDeps);
      return c.json({ ok: true, sessionId: id, notificationId: notifId, delivery: "already_done", changed: false });
    }

    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const bodyThreadKey =
      typeof body.threadKey === "string"
        ? body.threadKey
        : typeof body.thread_key === "string"
          ? body.thread_key
          : null;
    const bodyQuestId = typeof body.questId === "string" ? body.questId : null;
    const bodyThreadRoute = bodyThreadKey || bodyQuestId ? normalizeThreadRoute(bodyThreadKey, bodyQuestId) : null;
    if ((bodyThreadKey || bodyQuestId) && !bodyThreadRoute) {
      return c.json({ error: "threadKey must be main or q-N" }, 400);
    }

    const notificationThreadRoute = normalizeThreadRoute(notification.threadKey, notification.questId);
    const threadRoute = notificationThreadRoute ?? bodyThreadRoute ?? { threadKey: "main" };
    const previewText = notification.summary || "Needs your input";
    const replyContext = {
      ...(notification.messageId ? { messageId: notification.messageId } : {}),
      notificationId: notification.id,
      previewText,
    };
    markNotificationDoneController(session, notifId, true, notificationPersistDeps, {
      resolutionNotice: "pending",
      resolutionNoticeSource: "response",
      suppressScheduledNotificationCancel: true,
    });
    const delivery = wsBridge.injectUserMessage(id, body.content, undefined, undefined, threadRoute, {
      deliveryContent: formatReplyContentForAssistant(body.content, replyContext),
      replyContext,
      sessionId: id,
      bypassPause: true,
    });

    if (delivery !== "sent" && delivery !== "queued") {
      markNotificationDoneController(session, notifId, false, notificationPersistDeps);
      return c.json({ error: "Response could not be delivered", delivery }, 503);
    }

    notificationPersistDeps.cancelScheduledNotification?.(id, notifId);
    if (acknowledgeMonitoredThreadResult(session, threadRoute.threadKey, body.threadMonitorResultId)) {
      wsBridge.persistSessionById(id);
    }
    return c.json({ ok: true, sessionId: id, notificationId: notifId, delivery, changed: true });
  });
}
