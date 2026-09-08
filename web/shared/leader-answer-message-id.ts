import { isCanonicalLeaderUserMessageId } from "./leader-user-message-id.js";

/** Recognize current references and the exact spelling retained by earlier durable messages. */
export function isCanonicalLeaderTimerMessageId(value: unknown): value is string {
  return typeof value === "string" && /^(?:timer-m|f)[1-9]\d*$/.test(value);
}

export function isCanonicalLeaderAnswerMessageId(value: unknown): value is string {
  return isCanonicalLeaderUserMessageId(value) || isCanonicalLeaderTimerMessageId(value);
}

/** Match timer reminders through exact server-owned pause wrappers without rewriting content. */
export function timerReminderMatchesSource(content: unknown, sourceId: unknown): boolean {
  if (typeof content !== "string" || typeof sourceId !== "string" || !/^timer:t[1-9]\d*$/.test(sourceId)) {
    return false;
  }
  const reminder =
    /^(?:\[Takode auto-pause resumed: (?:[2-9]|[1-9]\d+) similar automatic inputs were coalesced while delivery was paused\.\]\n\n)*\[⏰ Timer (t[1-9]\d*) reminder\]/.exec(
      content,
    );
  return reminder?.[1] === sourceId.slice("timer:".length);
}

/**
 * Persisted firing IDs prove trusted timer ingestion. The matching reminder
 * header excludes cancellation events and other inputs sharing a timer source.
 * Callers separately prove root message ownership and identity uniqueness.
 */
export function isLeaderTimerAnswerTarget(fields: {
  leaderTimerMessageId?: unknown;
  agentSource?: { sessionId?: unknown } | null;
  content?: unknown;
}): boolean {
  return (
    isCanonicalLeaderTimerMessageId(fields.leaderTimerMessageId) &&
    timerReminderMatchesSource(fields.content, fields.agentSource?.sessionId)
  );
}
