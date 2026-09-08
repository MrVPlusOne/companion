import { leaderResponseProvenCurrentOwnerThreadKey } from "../shared/leader-thread-response-routing.js";
import { buildLeaderThreadResponseState, type LeaderThreadResponseSession } from "./leader-thread-response.js";
import {
  buildLeaderUserMessageIdentities,
  isCanonicalLeaderUserMessageId,
  type LeaderUserMessageIdentity,
} from "./leader-user-message-id.js";

/**
 * Select exact committed, pending Main requests without changing history or
 * answer coverage. Proven same-leader handoff retries are returned separately,
 * including after the destination has answered them.
 */
export function prepareLeaderThreadHandoff(
  session: LeaderThreadResponseSession,
  questId: string,
  userMessageIds: readonly string[],
):
  | { ok: true; requests: LeaderUserMessageIdentity[]; alreadyHandedOffUserMessageIds: string[] }
  | { ok: false; error: string } {
  if (!/^q-\d+$/.test(questId)) return { ok: false, error: "questId must match q-N format" };
  if (userMessageIds.length === 0 || userMessageIds.some((id) => !isCanonicalLeaderUserMessageId(id))) {
    return { ok: false, error: "Provide exact user-message IDs such as u1" };
  }
  if (new Set(userMessageIds).size !== userMessageIds.length) {
    return { ok: false, error: "User-message IDs must not repeat" };
  }

  const identities = new Map(
    buildLeaderUserMessageIdentities(session.messageHistory).map((entry) => [entry.userMessageId, entry]),
  );
  const pending = new Set(
    buildLeaderThreadResponseState(session, "main").projection.pendingMessages.map((entry) => entry.userMessageId),
  );
  const requests: LeaderUserMessageIdentity[] = [];
  const alreadyHandedOffUserMessageIds: string[] = [];
  for (const userMessageId of userMessageIds) {
    const request = identities.get(userMessageId);
    if (!request) {
      return { ok: false, error: `${userMessageId} is not a committed direct user request` };
    }
    const owner = leaderResponseProvenCurrentOwnerThreadKey(request.message);
    if (owner === questId && isSameLeaderHandoff(request, session.id, questId)) {
      alreadyHandedOffUserMessageIds.push(userMessageId);
      continue;
    }
    if (owner !== "main" || !pending.has(userMessageId)) {
      return { ok: false, error: `${userMessageId} must be an unanswered request currently owned by Main` };
    }
    requests.push(request);
  }
  return { ok: true, requests, alreadyHandedOffUserMessageIds };
}

function isSameLeaderHandoff(request: LeaderUserMessageIdentity, sessionId: string, questId: string): boolean {
  const { threadKey, questId: originalQuestId, threadRefs } = request.message;
  if (leaderResponseProvenCurrentOwnerThreadKey({ threadKey, questId: originalQuestId }) !== "main") return false;
  return (threadRefs ?? []).some(
    (ref) =>
      ref.source === "explicit" &&
      ref.threadKey === questId &&
      ref.questId === questId &&
      ref.attachedBy === sessionId &&
      typeof ref.attachedAt === "number" &&
      Number.isFinite(ref.attachedAt),
  );
}
