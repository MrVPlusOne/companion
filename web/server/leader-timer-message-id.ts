import { isCanonicalLeaderTimerMessageId, isLeaderTimerAnswerTarget } from "../shared/leader-answer-message-id.js";
import { isRootAgentHistoryMessage } from "./root-agent-feed-message.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { LeaderUserMessageIdentity } from "./leader-user-message-id.js";

/**
 * Resolve only persisted, unambiguous delivered firing identities. Historical
 * reminders have no fallback ID, and corrupt duplicate IDs cannot cover work.
 */
export function buildLeaderTimerMessageIdentities(
  history: ReadonlyArray<BrowserIncomingMessage>,
): LeaderUserMessageIdentity[] {
  const rawCounts = new Map<string, number>();
  const firingCounts = new Map<string, number>();
  for (const message of history) {
    if (message.type !== "user_message" || !isRootAgentHistoryMessage(message)) continue;
    if (message.id) rawCounts.set(message.id, (rawCounts.get(message.id) ?? 0) + 1);
    const id = message.leaderTimerMessageId;
    if (isCanonicalLeaderTimerMessageId(id)) firingCounts.set(id, (firingCounts.get(id) ?? 0) + 1);
  }
  return history.flatMap((message, historyIndex) => {
    if (
      message.type !== "user_message" ||
      !isRootAgentHistoryMessage(message) ||
      !message.id ||
      !isLeaderTimerAnswerTarget(message) ||
      rawCounts.get(message.id) !== 1 ||
      firingCounts.get(message.leaderTimerMessageId!) !== 1
    ) {
      return [];
    }
    return [{ userMessageId: message.leaderTimerMessageId!, historyMessageId: message.id, historyIndex, message }];
  });
}

/** Allocate after every persisted or queued reference, including rejected rows. */
export function nextLeaderTimerMessageId(
  history: ReadonlyArray<BrowserIncomingMessage>,
  reservedIds: ReadonlyArray<string | undefined> = [],
): string {
  const persistedIds = history.flatMap((message) =>
    message.type === "user_message" && isRootAgentHistoryMessage(message) ? [message.leaderTimerMessageId] : [],
  );
  const max = [...persistedIds, ...reservedIds].reduce((max, id) => {
    if (!isCanonicalLeaderTimerMessageId(id)) return max;
    const ordinal = BigInt(id.slice("timer-m".length));
    return ordinal > max ? ordinal : max;
  }, 0n);
  return `timer-m${max + 1n}`;
}
