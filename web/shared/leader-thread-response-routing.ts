import { isCanonicalLeaderAnswerMessageId } from "./leader-answer-message-id.js";

export interface LeaderResponseThreadRouteFields {
  threadKey?: string;
  questId?: string;
  threadRefs?: ReadonlyArray<{
    threadKey: string;
    questId?: string;
    source: "explicit" | "inferred" | "backfill";
    attachedAt?: number;
  }>;
}

function validThreadKey(value: string | undefined): string | null {
  const key = value?.trim().toLowerCase();
  return key === "main" || (key !== undefined && /^q-\d+$/.test(key)) ? key : null;
}

function routeThreadKey(threadKey: string | undefined, questId: string | undefined): string | null {
  const directThread = validThreadKey(threadKey);
  const directQuest = validThreadKey(questId);
  if (directThread && directQuest && directThread !== directQuest) return null;
  return directThread ?? directQuest;
}

/**
 * Resolve the single current thread that owns answer coverage for a direct
 * human message. The newest explicit/inferred attachment transfers ownership;
 * backfill references affect visibility only.
 */
/**
 * Resolve the current owner only when persisted route evidence proves one.
 * This accepts a valid authoritative reassignment, but unlike the compatibility
 * helper it never defaults malformed or route-less rows to Main.
 */
export function leaderResponseProvenCurrentOwnerThreadKey(fields: LeaderResponseThreadRouteFields): string | null {
  let attached: { threadKey: string; attachedAt: number; index: number } | null = null;
  for (let index = 0; index < (fields.threadRefs?.length ?? 0); index += 1) {
    const ref = fields.threadRefs![index]!;
    if (ref.source === "backfill") continue;
    const threadKey = routeThreadKey(ref.threadKey, ref.questId);
    if (!threadKey) return null;
    const attachedAt =
      typeof ref.attachedAt === "number" && Number.isFinite(ref.attachedAt) ? ref.attachedAt : Number.NEGATIVE_INFINITY;
    if (
      !attached ||
      attachedAt > attached.attachedAt ||
      (attachedAt === attached.attachedAt && index > attached.index)
    ) {
      attached = { threadKey, attachedAt, index };
    }
  }
  if (attached) return attached.threadKey;
  return routeThreadKey(fields.threadKey, fields.questId);
}

/**
 * Resolve a stable owner suitable for automatic answer-route repair. The
 * direct stored route must be valid and every authoritative ref must agree;
 * reassigned, malformed, or route-less rows fail closed instead of being
 * silently canonicalized from a stale owner shape.
 */
export function leaderResponseStableOwnerThreadKeyForRepair(fields: LeaderResponseThreadRouteFields): string | null {
  const direct = routeThreadKey(fields.threadKey, fields.questId);
  if (!direct) return null;
  for (const ref of fields.threadRefs ?? []) {
    if (ref.source === "backfill") continue;
    const threadKey = routeThreadKey(ref.threadKey, ref.questId);
    if (!threadKey || threadKey !== direct) return null;
  }
  return direct;
}

export function leaderResponseOwnerThreadKey(fields: LeaderResponseThreadRouteFields): string | null {
  let attached: { threadKey: string; attachedAt: number; index: number } | null = null;
  for (let index = 0; index < (fields.threadRefs?.length ?? 0); index += 1) {
    const ref = fields.threadRefs![index]!;
    if (ref.source === "backfill") continue;
    const threadKey = routeThreadKey(ref.threadKey, ref.questId);
    if (!threadKey) continue;
    const attachedAt =
      typeof ref.attachedAt === "number" && Number.isFinite(ref.attachedAt) ? ref.attachedAt : Number.NEGATIVE_INFINITY;
    if (
      !attached ||
      attachedAt > attached.attachedAt ||
      (attachedAt === attached.attachedAt && index > attached.index)
    ) {
      attached = { threadKey, attachedAt, index };
    }
  }
  if (attached) return attached.threadKey;
  return routeThreadKey(fields.threadKey, fields.questId) ?? "main";
}

/**
 * Resolve an answer row's exact authoritative route. Unlike direct-user
 * ownership, this must not fall malformed data back to Main: the stored answer
 * itself is proof-bearing and therefore fails closed on incomplete or
 * conflicting route fields.
 */
export function leaderResponseExactAnswerThreadKey(fields: LeaderResponseThreadRouteFields): string | null {
  const threadKey = validThreadKey(fields.threadKey);
  if (!threadKey) return null;
  const authoritativeRefs = (fields.threadRefs ?? []).filter((ref) => ref.source !== "backfill");

  if (threadKey === "main") {
    if (fields.questId?.trim() || authoritativeRefs.length > 0) return null;
    return leaderResponseOwnerThreadKey(fields) === "main" ? "main" : null;
  }

  if (
    validThreadKey(fields.questId) !== threadKey ||
    !authoritativeRefs.some((ref) => routeThreadKey(ref.threadKey, ref.questId) === threadKey)
  ) {
    return null;
  }
  return leaderResponseOwnerThreadKey(fields) === threadKey ? threadKey : null;
}

/** Decode exact per-prompt owner proof; older answers retain their single source owner. */
export function leaderResponseAnswerOwnerThreadKeys(
  answer: { answerUserMessageIds: readonly string[]; ownerGroups?: unknown },
  sourceThreadKey: string,
): Map<string, string> | null {
  const ids = answer.answerUserMessageIds;
  if (ids.length === 0 || ids.some((id) => !isCanonicalLeaderAnswerMessageId(id)) || new Set(ids).size !== ids.length) {
    return null;
  }
  const source = validThreadKey(sourceThreadKey);
  if (!source) return null;
  if (answer.ownerGroups === undefined) return new Map(ids.map((id) => [id, source]));
  if (!Array.isArray(answer.ownerGroups) || answer.ownerGroups.length === 0) return null;

  const owners = new Map<string, string>();
  const seenThreads = new Set<string>();
  const referenced = new Set(ids);
  for (const group of answer.ownerGroups) {
    if (!group || typeof group !== "object") return null;
    const threadKey = typeof group.threadKey === "string" ? validThreadKey(group.threadKey) : null;
    if (
      !threadKey ||
      seenThreads.has(threadKey) ||
      !Array.isArray(group.userMessageIds) ||
      group.userMessageIds.length === 0
    ) {
      return null;
    }
    seenThreads.add(threadKey);
    for (const id of group.userMessageIds) {
      if (!isCanonicalLeaderAnswerMessageId(id) || !referenced.has(id) || owners.has(id)) return null;
      owners.set(id, threadKey);
    }
  }
  return owners.size === ids.length ? owners : null;
}

/**
 * Resolve every thread where a direct human message is currently visible for
 * answer presentation. The owning route is always included. Backfill refs add
 * visibility without transferring ownership; a newer authoritative assignment
 * replaces the original direct route through `leaderResponseOwnerThreadKey`.
 */
export function leaderResponseAssociatedThreadKeys(fields: LeaderResponseThreadRouteFields): string[] {
  const keys = new Set<string>();
  const ownerThreadKey = leaderResponseOwnerThreadKey(fields);
  if (ownerThreadKey) keys.add(ownerThreadKey);

  for (const ref of fields.threadRefs ?? []) {
    if (ref.source !== "backfill") continue;
    const threadKey = routeThreadKey(ref.threadKey, ref.questId);
    // Backfill is the visibility-only mechanism used to attach a Main-owned
    // request to a quest. Main visibility is already governed by ownership;
    // accepting a persisted/corrupt Main backfill would incorrectly leak a
    // quest-owned request back into Main.
    if (threadKey && /^q-\d+$/.test(threadKey)) keys.add(threadKey);
  }

  return [...keys];
}

export function leaderResponseMessageIsAssociatedWithThread(
  fields: LeaderResponseThreadRouteFields,
  requestedThreadKey: string,
): boolean {
  const threadKey = validThreadKey(requestedThreadKey);
  return threadKey !== null && leaderResponseAssociatedThreadKeys(fields).includes(threadKey);
}
