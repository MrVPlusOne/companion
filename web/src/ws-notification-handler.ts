import { useStore } from "./store.js";
import type { BrowserIncomingMessage } from "./types.js";
import { applySessionNotifications } from "./notification-status.js";
import { playNeedsInputSound, playReviewSound } from "./utils/notification-sound.js";

type NotificationUpdateMessage = Extract<BrowserIncomingMessage, { type: "notification_update" }>;

let lastNotificationSoundAt = 0;
const NOTIFICATION_SOUND_DEBOUNCE_MS = 1000;

/** Shares the existing alert gate so Ready and monitoring updates sound only once. */
export function playNewMonitoredResultSound(): void {
  const now = Date.now();
  if (
    document.hasFocus() ||
    !useStore.getState().notificationSound ||
    now - lastNotificationSoundAt < NOTIFICATION_SOUND_DEBOUNCE_MS
  )
    return;
  lastNotificationSoundAt = now;
  void playReviewSound();
}

/** Applies one server-authored inbox update and handles its optional user alert. */
export function handleNotificationUpdateMessage(sessionId: string, data: NotificationUpdateMessage): void {
  const store = useStore.getState();
  const newNotifications = data.notifications ?? [];
  const oldNotifications = store.sessionNotifications?.get(sessionId) ?? [];
  const oldIds = new Set(oldNotifications.map((notification) => notification.id));
  const added = newNotifications.filter((notification) => !notification.done && !oldIds.has(notification.id));

  const applied = applySessionNotifications(
    sessionId,
    newNotifications,
    {
      notificationUrgency: data.notificationUrgency,
      activeNotificationCount: data.activeNotificationCount,
      activeNeedsInputNotificationCount: data.activeNeedsInputNotificationCount,
      activeReviewNotificationCount: data.activeReviewNotificationCount,
      mutedNeedsInputNotificationCount: data.mutedNeedsInputNotificationCount,
      notificationStatusVersion: data.notificationStatusVersion,
      notificationStatusUpdatedAt: data.notificationStatusUpdatedAt,
    },
    { authoritativeStatus: true },
  );
  if (!applied) return;

  // Play differentiated sounds for new notifications while the tab is unfocused.
  const now = Date.now();
  if (
    added.length === 0 ||
    document.hasFocus() ||
    !store.notificationSound ||
    now - lastNotificationSoundAt < NOTIFICATION_SOUND_DEBOUNCE_MS
  ) {
    return;
  }

  lastNotificationSoundAt = now;
  if (added.some((notification) => notification.category === "needs-input")) {
    playNeedsInputSound();
  } else if (added.some((notification) => notification.category === "review")) {
    playReviewSound();
  }
}
