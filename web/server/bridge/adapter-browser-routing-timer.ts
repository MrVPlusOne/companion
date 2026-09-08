import { nextLeaderTimerMessageId } from "../leader-timer-message-id.js";
import type { BrowserUserMessage } from "./adapter-browser-routing-message-types.js";
import type { AdapterBrowserRoutingSessionLike } from "./adapter-browser-routing-types.js";
import { isCanonicalLeaderTimerMessageId, timerReminderMatchesSource } from "../../shared/leader-answer-message-id.js";

type TimerDeliverySession = Pick<AdapterBrowserRoutingSessionLike, "messageHistory" | "pendingCodexInputs"> &
  Partial<Pick<AdapterBrowserRoutingSessionLike, "state" | "recoveryDeliveryTransfers">>;

/** Mint a reference only for timer-manager provenance retained through server-owned queues. */
export function leaderTimerMessageIdForDelivery(
  session: TimerDeliverySession,
  message: BrowserUserMessage,
): string | undefined {
  const firing = message.timerFiring;
  if (
    !firing ||
    !/^t[1-9]\d*$/.test(firing.timerId) ||
    !Number.isSafeInteger(firing.scheduledFireAt) ||
    firing.scheduledFireAt < 0 ||
    message.agentSource?.sessionId !== `timer:${firing.timerId}` ||
    !timerReminderMatchesSource(message.content, message.agentSource?.sessionId)
  ) {
    if (firing?.messageId !== undefined) throw new Error("Retained timer firing provenance is invalid");
    return undefined;
  }
  if (firing.messageId !== undefined) {
    if (!isCanonicalLeaderTimerMessageId(firing.messageId)) {
      throw new Error("Retained timer firing reference is invalid");
    }
    // A retained firing may leave its held owner, but cannot acquire a second
    // committed or currently pending owner under the same reference.
    const committed = session.messageHistory.some(
      (entry) => entry.type === "user_message" && entry.leaderTimerMessageId === firing.messageId,
    );
    const pending = session.pendingCodexInputs.some(
      (input) => input.leaderTimerMessageId === firing.messageId || input.timerFiring?.messageId === firing.messageId,
    );
    if (committed || pending)
      throw new Error(`Retained timer firing ${firing.messageId} is already committed or pending`);
    return firing.messageId;
  }
  const heldMessages = [
    ...(session.state?.pause?.queuedMessages ?? []),
    ...(session.state?.codex_result_error_auto_pause?.heldInputs ?? []),
    ...(session.recoveryDeliveryTransfers ?? []),
  ];
  const reservedIds = [
    ...session.pendingCodexInputs.flatMap((input) => [input.leaderTimerMessageId, input.timerFiring?.messageId]),
    ...heldMessages.map((item) => item.message.timerFiring?.messageId),
  ];
  return nextLeaderTimerMessageId(session.messageHistory, reservedIds);
}
