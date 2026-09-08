import { createHash } from "node:crypto";
import { isCanonicalLeaderAnswerMessageId } from "../shared/leader-answer-message-id.js";
import {
  leaderResponseAssociatedThreadKeys,
  leaderResponseAnswerOwnerThreadKeys,
  leaderResponseExactAnswerThreadKey,
  leaderResponseOwnerThreadKey,
  leaderResponseProvenCurrentOwnerThreadKey,
} from "../shared/leader-thread-response-routing.js";
import { normalizeSelectedFeedThreadKey } from "../shared/thread-window.js";
import type {
  LeaderAnswerRouteDiagnostic,
  LeaderAnswerRouteDiagnosticReason,
  LeaderAnswerRouteOwnerGroup,
} from "../shared/thread-routing-reminder.js";
import {
  buildLeaderUserMessageIdentities,
  isCanonicalLeaderUserMessageId,
  type LeaderUserMessageIdentity,
} from "./leader-user-message-id.js";
import { isRootAgentHistoryMessage } from "./root-agent-feed-message.js";
import { buildLeaderTimerMessageIdentities } from "./leader-timer-message-id.js";
import type {
  BrowserIncomingMessage,
  LeaderThreadAnswerMetadata,
  ThreadRef,
  LeaderThreadResponseProjection,
  LeaderThreadResponseState,
  LegacyLeaderThreadResponseRevisionMetadata,
} from "./session-types.js";
import {
  LEADER_THREAD_RESPONSE_VERSION,
  LEGACY_LEADER_THREAD_RESPONSE_VERSION,
} from "./leader-thread-response-types.js";

type PendingLeaderAnswerInput = Pick<
  Extract<BrowserIncomingMessage, { type: "user_message" }>,
  "leaderResponseCoverageVersion" | "leaderUserMessageId" | "threadKey" | "questId" | "threadRefs"
>;

export type LeaderThreadResponseSession = {
  id: string;
  messageHistory: BrowserIncomingMessage[];
  pendingCodexInputs?: ReadonlyArray<PendingLeaderAnswerInput>;
};

export interface PendingLeaderAnswerInputState {
  count: number;
  userMessageIds: string[];
}

type AnswerTargetMessage = LeaderUserMessageIdentity & {
  timestamp: number;
  threadKey: string;
  associatedThreadKeys: string[];
};

type ResponseHistoryMessage = Extract<BrowserIncomingMessage, { type: "assistant" | "leader_user_message" }>;

type LegacyRevision = {
  metadata: LegacyLeaderThreadResponseRevisionMetadata;
  threadKey: string;
  messageId: string;
  historyIndex: number;
  createdAt: number;
};

type LegacyChain = {
  threadKey: string;
  entries: LegacyRevision[];
};

type AnswerCandidate = {
  threadKey: string;
  answerUserMessageIds: string[];
  referencedUserMessageIds: string[];
  messageId: string;
  historyIndex: number;
  createdAt: number;
  source: "explicit" | "legacy";
};

type Evaluation = {
  directMessages: AnswerTargetMessage[];
  answerTargets: AnswerTargetMessage[];
  currentAnswers: LeaderThreadResponseState[];
  coveredMessageIds: Set<string>;
};

type AnswerRouteResolution =
  | {
      ok: true;
      referenced: AnswerTargetMessage[];
      ownerGroups: LeaderAnswerRouteOwnerGroup[];
    }
  | {
      ok: false;
      reason: LeaderAnswerRouteDiagnosticReason;
      ownerGroups: LeaderAnswerRouteOwnerGroup[];
    };

type AnswerRouteSnapshot = Pick<
  Extract<BrowserIncomingMessage, { type: "assistant" }>,
  "threadKey" | "questId" | "threadRefs"
>;

type LegacyPendingBatch = {
  batchId: string;
  legacyBatchId: string;
  userMessageIds: string[];
};

type LegacyPendingBatchTokenPayload = {
  v: typeof LEGACY_LEADER_THREAD_RESPONSE_VERSION;
  t: string;
  h: number;
  ids: string[];
};

const THREAD_ROUTE_DIRECTIVE_RE = /^\s*\[thread:/i;
const SHELL_THREAD_ROUTE_DIRECTIVE_RE = /^\s*#\s*thread:/i;
const THREAD_STATUS_DIRECTIVE_RE = /^\s*\{\[\(Thread (?:Waiting|Ready):/i;
const QUEST_QUIZ_DIRECTIVE_RE = /^\s*\{\[\(Quest Quiz:\s*q-\d+\)\]\}\s*$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

export function leaderThreadResponseContentHash(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function normalizeLeaderThreadAnswerMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").trim();
}

function stripQuestQuizDirectives(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;
  const retained: string[] = [];
  for (const line of markdown.split("\n")) {
    const token = line.match(FENCE_RE)?.[1];
    if (fence) {
      retained.push(line);
      if (token && token[0] === fence.marker && token.length >= fence.length) fence = null;
      continue;
    }
    if (token) {
      fence = { marker: token[0]!, length: token.length };
      retained.push(line);
      continue;
    }
    if (!QUEST_QUIZ_DIRECTIVE_RE.test(line)) retained.push(line);
  }
  return retained.join("\n");
}

function isSubstantiveLeaderThreadAnswer(markdown: string): boolean {
  const readable = stripQuestQuizDirectives(normalizeLeaderThreadAnswerMarkdown(markdown))
    .replace(/<!--[^]*?-->/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|\-+=:[\](){}.!?,;\\/]/g, " ");
  return /[\p{L}\p{N}]/u.test(readable);
}

function hasThreadControlDirectives(markdown: string): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const token = line.match(FENCE_RE)?.[1];
    if (fence) {
      if (token && token[0] === fence.marker && token.length >= fence.length) fence = null;
      continue;
    }
    if (token) {
      fence = { marker: token[0]!, length: token.length };
      continue;
    }
    if (
      THREAD_ROUTE_DIRECTIVE_RE.test(line) ||
      SHELL_THREAD_ROUTE_DIRECTIVE_RE.test(line) ||
      THREAD_STATUS_DIRECTIVE_RE.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeThreadKey(value: string): string {
  const threadKey = normalizeSelectedFeedThreadKey(value);
  if (threadKey !== "main" && !/^q-\d+$/.test(threadKey)) throw new Error("threadKey must be main or q-N.");
  return threadKey;
}

export function pendingLeaderAnswerInputsForThread(
  session: Pick<LeaderThreadResponseSession, "pendingCodexInputs">,
  requestedThreadKey: string,
): PendingLeaderAnswerInputState {
  const threadKey = normalizeThreadKey(requestedThreadKey);
  const matching = (session.pendingCodexInputs ?? []).filter(
    (input) => input.leaderResponseCoverageVersion === 1 && leaderResponseOwnerThreadKey(input) === threadKey,
  );
  return {
    count: matching.length,
    userMessageIds: [
      ...new Set(
        matching.flatMap((input) =>
          isCanonicalLeaderUserMessageId(input.leaderUserMessageId) ? [input.leaderUserMessageId] : [],
        ),
      ),
    ],
  };
}

function exactResponseThreadKey(message: ResponseHistoryMessage): string | null {
  return leaderResponseExactAnswerThreadKey(message);
}

function responseMessageId(message: ResponseHistoryMessage): string | null {
  const value = message.type === "assistant" ? message.message.id : message.id;
  return typeof value === "string" && value.trim() ? value : null;
}

function responseMessageMarkdown(message: ResponseHistoryMessage): string {
  if (message.type === "leader_user_message") return normalizeLeaderThreadAnswerMarkdown(message.content);
  return normalizeLeaderThreadAnswerMarkdown(
    message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
  );
}

function responseMessageTimestamp(message: ResponseHistoryMessage): number | null {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : null;
}

function eligibleAssistantAnswer(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): boolean {
  return (
    message.parent_tool_use_id === null &&
    !message.message.content.some((block) => block.type === "tool_use" || block.type === "tool_result")
  );
}

function collectAnswerTargets(
  history: ReadonlyArray<BrowserIncomingMessage>,
  historyLimit: number,
): AnswerTargetMessage[] {
  return [...buildLeaderUserMessageIdentities(history), ...buildLeaderTimerMessageIdentities(history)]
    .filter((entry) => entry.historyIndex < historyLimit)
    .sort((left, right) => left.historyIndex - right.historyIndex)
    .flatMap((entry) => {
      const threadKey = leaderResponseThreadKeyForUserMessage(entry.message);
      if (!threadKey) return [];
      return [
        {
          ...entry,
          timestamp:
            typeof entry.message.timestamp === "number" && Number.isFinite(entry.message.timestamp)
              ? entry.message.timestamp
              : 0,
          threadKey,
          associatedThreadKeys: leaderResponseAssociatedThreadKeys(entry.message),
        },
      ];
    });
}

export function leaderResponseThreadKeyForUserMessage(
  message: Extract<BrowserIncomingMessage, { type: "user_message" }>,
): string | null {
  return leaderResponseOwnerThreadKey(message);
}

function validLegacyRevisionMetadata(value: unknown): value is LegacyLeaderThreadResponseRevisionMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyLeaderThreadResponseRevisionMetadata>;
  return (
    typeof candidate.logicalResponseId === "string" &&
    candidate.logicalResponseId.length > 0 &&
    typeof candidate.revisionId === "string" &&
    candidate.revisionId.length > 0 &&
    Number.isInteger(candidate.revisionNumber) &&
    (candidate.revisionNumber ?? 0) > 0 &&
    typeof candidate.batchId === "string" &&
    candidate.batchId.length > 0 &&
    Number.isInteger(candidate.batchObservedHistoryLength) &&
    (candidate.batchObservedHistoryLength ?? -1) >= 0 &&
    Array.isArray(candidate.coveredUserMessageIds) &&
    candidate.coveredUserMessageIds.length > 0 &&
    candidate.coveredUserMessageIds.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(candidate.coveredUserMessageIds).size === candidate.coveredUserMessageIds.length &&
    typeof candidate.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.contentHash)
  );
}

function parsedLegacyRevision(message: BrowserIncomingMessage, historyIndex: number): LegacyRevision | null {
  if (
    (message.type !== "leader_user_message" && message.type !== "assistant") ||
    !isRootAgentHistoryMessage(message) ||
    !validLegacyRevisionMetadata(message.threadResponse)
  ) {
    return null;
  }
  if (message.type === "assistant" && (message.leaderThreadRole !== "response" || !eligibleAssistantAnswer(message))) {
    return null;
  }
  const threadKey = exactResponseThreadKey(message);
  const markdown = responseMessageMarkdown(message);
  const messageId = responseMessageId(message);
  const createdAt = responseMessageTimestamp(message);
  if (
    !threadKey ||
    !messageId ||
    !isSubstantiveLeaderThreadAnswer(markdown) ||
    message.threadResponse.contentHash !== leaderThreadResponseContentHash(markdown) ||
    createdAt === null ||
    createdAt < 0
  ) {
    return null;
  }
  return { metadata: message.threadResponse, threadKey, messageId, historyIndex, createdAt };
}

function legacyChains(parsed: LegacyRevision[]): LegacyChain[] {
  const byResponseId = new Map<string, LegacyRevision[]>();
  for (const entry of parsed) {
    const existing = byResponseId.get(entry.metadata.logicalResponseId);
    if (existing) existing.push(entry);
    else byResponseId.set(entry.metadata.logicalResponseId, [entry]);
  }
  const chains: LegacyChain[] = [];
  for (const candidates of byResponseId.values()) {
    const entries: LegacyRevision[] = [];
    for (const candidate of candidates) {
      const previous = entries.at(-1);
      if (!previous) {
        if (candidate.metadata.revisionNumber !== 1 || candidate.metadata.parentRevisionId) continue;
      } else if (
        candidate.threadKey !== previous.threadKey ||
        candidate.metadata.batchId !== previous.metadata.batchId ||
        candidate.metadata.batchObservedHistoryLength !== previous.metadata.batchObservedHistoryLength ||
        !sameIds(candidate.metadata.coveredUserMessageIds, previous.metadata.coveredUserMessageIds) ||
        candidate.metadata.revisionNumber !== previous.metadata.revisionNumber + 1 ||
        candidate.metadata.parentRevisionId !== previous.metadata.revisionId
      ) {
        break;
      }
      entries.push(candidate);
    }
    if (entries.length > 0) chains.push({ threadKey: entries[0]!.threadKey, entries });
  }
  return chains.sort((left, right) => left.entries[0]!.historyIndex - right.entries[0]!.historyIndex);
}

function encodeLegacyPendingBatchId(sessionId: string, payload: LegacyPendingBatchTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const checksum = leaderThreadResponseContentHash(`${sessionId}\n${encoded}`).slice(0, 24);
  return `response-batch-v1.${encoded}.${checksum}`;
}

function legacyPendingBatchId(
  sessionId: string,
  threadKey: string,
  observedHistoryLength: number,
  messageIds: readonly string[],
): string {
  return encodeLegacyPendingBatchId(sessionId, {
    v: LEGACY_LEADER_THREAD_RESPONSE_VERSION,
    t: threadKey,
    h: observedHistoryLength,
    ids: [...messageIds],
  });
}

function routedLegacyPendingBatchId(
  sessionId: string,
  threadKey: string,
  observedHistoryLength: number,
  messageIds: readonly string[],
): string {
  const digest = leaderThreadResponseContentHash(
    JSON.stringify({
      v: LEGACY_LEADER_THREAD_RESPONSE_VERSION,
      sessionId,
      threadKey,
      observedHistoryLength,
      messageIds,
    }),
  ).slice(0, 32);
  return `routed-response-batch-v1.${digest}`;
}

function legacyPendingBatches(
  sessionId: string,
  threadKey: string,
  directMessages: readonly AnswerTargetMessage[],
  coveredMessageIds: ReadonlySet<string>,
  observedHistoryLength: number,
): LegacyPendingBatch[] {
  const eligible = directMessages.filter((message) => message.threadKey === threadKey);
  const batches: AnswerTargetMessage[][] = [];
  let current: AnswerTargetMessage[] = [];
  for (const message of eligible) {
    if (coveredMessageIds.has(message.historyMessageId)) {
      if (current.length > 0) batches.push(current);
      current = [];
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches.map((members) => {
    const ids = members.map((member) => member.historyMessageId);
    return {
      batchId: routedLegacyPendingBatchId(sessionId, threadKey, observedHistoryLength, ids),
      legacyBatchId: legacyPendingBatchId(sessionId, threadKey, observedHistoryLength, ids),
      userMessageIds: ids,
    };
  });
}

function evaluateLegacyCandidates(
  session: Pick<LeaderThreadResponseSession, "id" | "messageHistory">,
  directMessages: AnswerTargetMessage[],
  boundedLimit: number,
): AnswerCandidate[] {
  const parsed = session.messageHistory.slice(0, boundedLimit).flatMap((message, historyIndex) => {
    const revision = parsedLegacyRevision(message, historyIndex);
    return revision ? [revision] : [];
  });
  const accepted: LegacyChain[] = [];
  const covered = new Set<string>();
  for (const chain of legacyChains(parsed)) {
    const first = chain.entries[0]!;
    const observedLength = first.metadata.batchObservedHistoryLength;
    if (observedLength > first.historyIndex || observedLength > boundedLimit) continue;
    const observedDirect = directMessages.filter((message) => message.historyIndex < observedLength);
    const observedCovered = new Set<string>();
    for (const prior of accepted) {
      if (prior.entries[0]!.historyIndex >= observedLength) continue;
      prior.entries[0]!.metadata.coveredUserMessageIds.forEach((id) => observedCovered.add(id));
    }
    const batch = legacyPendingBatches(
      session.id,
      chain.threadKey,
      observedDirect,
      observedCovered,
      observedLength,
    ).find(
      (candidate) =>
        (candidate.batchId === first.metadata.batchId || candidate.legacyBatchId === first.metadata.batchId) &&
        sameIds(candidate.userMessageIds, first.metadata.coveredUserMessageIds),
    );
    if (!batch || first.metadata.coveredUserMessageIds.some((id) => covered.has(id))) continue;
    first.metadata.coveredUserMessageIds.forEach((id) => covered.add(id));
    accepted.push(chain);
  }

  const conciseByHistoryId = new Map(
    directMessages.map((message) => [message.historyMessageId, message.userMessageId]),
  );
  return accepted.flatMap((chain) => {
    const first = chain.entries[0]!;
    const latest = chain.entries.at(-1)!;
    const answerUserMessageIds = first.metadata.coveredUserMessageIds.map((id) => conciseByHistoryId.get(id));
    if (answerUserMessageIds.some((id) => !id)) return [];
    return [
      {
        threadKey: chain.threadKey,
        answerUserMessageIds: answerUserMessageIds as string[],
        referencedUserMessageIds: [...first.metadata.coveredUserMessageIds],
        messageId: latest.messageId,
        historyIndex: latest.historyIndex,
        createdAt: latest.createdAt,
        source: "legacy" as const,
      },
    ];
  });
}

function validAnswerMetadata(value: unknown): value is LeaderThreadAnswerMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LeaderThreadAnswerMetadata>;
  return (
    candidate.version === LEADER_THREAD_RESPONSE_VERSION &&
    Array.isArray(candidate.answerUserMessageIds) &&
    candidate.answerUserMessageIds.length > 0 &&
    candidate.answerUserMessageIds.every(isCanonicalLeaderAnswerMessageId) &&
    new Set(candidate.answerUserMessageIds).size === candidate.answerUserMessageIds.length &&
    (candidate.authoredThreadKey === undefined ||
      candidate.authoredThreadKey === "main" ||
      /^q-\d+$/.test(candidate.authoredThreadKey)) &&
    leaderResponseAnswerOwnerThreadKeys(candidate as LeaderThreadAnswerMetadata, "main") !== null &&
    Number.isInteger(candidate.observedHistoryLength) &&
    (candidate.observedHistoryLength ?? -1) >= 0
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function answerOwnerGroups(referenced: readonly AnswerTargetMessage[]): {
  groups: LeaderAnswerRouteOwnerGroup[];
  ownerByMessage: Array<string | null>;
} {
  const ownerByMessage = referenced.map((message) => leaderResponseProvenCurrentOwnerThreadKey(message.message));
  const grouped = new Map<string, string[]>();
  for (let index = 0; index < referenced.length; index += 1) {
    const owner = ownerByMessage[index];
    if (!owner) continue;
    const ids = grouped.get(owner) ?? [];
    ids.push(referenced[index]!.userMessageId);
    grouped.set(owner, ids);
  }
  return {
    groups: [...grouped].map(([threadKey, userMessageIds]) => ({ threadKey, userMessageIds })),
    ownerByMessage,
  };
}

function resolveExplicitAnswerMessagesForOwner(
  answerTargets: readonly AnswerTargetMessage[],
  answerUserMessageIds: readonly string[],
  observedHistoryLength: number,
): AnswerRouteResolution {
  const byId = new Map(answerTargets.map((message) => [message.userMessageId, message]));
  const unresolved = answerUserMessageIds.filter((id) => {
    const message = byId.get(id);
    return !message || message.historyIndex >= observedHistoryLength;
  });
  if (unresolved.length > 0) {
    return { ok: false, reason: "invalid_ids", ownerGroups: [] };
  }

  const referenced = answerUserMessageIds.map((id) => byId.get(id)!) as AnswerTargetMessage[];
  const { groups: ownerGroups, ownerByMessage } = answerOwnerGroups(referenced);
  if (ownerByMessage.some((owner) => owner === null)) {
    // A partial owner map cannot safely describe indivisible grouped prose.
    // Persist only the ambiguity reason so reminder validation cannot mistake
    // the proven subset for a separately correctable answer.
    return { ok: false, reason: "unproven_owner", ownerGroups: [] };
  }
  return { ok: true, referenced, ownerGroups };
}

function answerOwnerProofMatches(
  metadata: LeaderThreadAnswerMetadata,
  ownerGroups: readonly LeaderAnswerRouteOwnerGroup[],
  sourceThreadKey: string,
): boolean {
  const owners = leaderResponseAnswerOwnerThreadKeys(metadata, sourceThreadKey);
  return (
    owners !== null &&
    ownerGroups.every((group) => group.userMessageIds.every((id) => owners.get(id) === group.threadKey))
  );
}

function threadRefRouteKey(ref: ThreadRef): string | null {
  const threadKey = ref.threadKey.trim().toLowerCase();
  const questId = ref.questId?.trim().toLowerCase();
  if (threadKey === "main") return questId ? null : "main";
  if (!/^q-\d+$/.test(threadKey)) return null;
  return questId === threadKey ? threadKey : null;
}

function hasConflictingAuthoritativeAnswerRefs(
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  selectedThreadKey: string,
): boolean {
  return (message.threadRefs ?? []).some(
    (ref) => ref.source !== "backfill" && threadRefRouteKey(ref) !== selectedThreadKey,
  );
}

function answerRouteSnapshot(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): AnswerRouteSnapshot {
  return {
    threadKey: message.threadKey,
    questId: message.questId,
    threadRefs: message.threadRefs,
  };
}

function restoreAnswerRoute(
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  snapshot: AnswerRouteSnapshot,
): void {
  if (snapshot.threadKey === undefined) delete message.threadKey;
  else message.threadKey = snapshot.threadKey;
  if (snapshot.questId === undefined) delete message.questId;
  else message.questId = snapshot.questId;
  if (snapshot.threadRefs === undefined) delete message.threadRefs;
  else message.threadRefs = snapshot.threadRefs;
}

function canonicalizeAnswerRoute(
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  anchorThreadKey: string,
  visibleThreadKeys: readonly string[],
): void {
  const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : 0;
  message.threadKey = anchorThreadKey;
  if (anchorThreadKey === "main") delete message.questId;
  else message.questId = anchorThreadKey;
  const refs: ThreadRef[] = [];
  if (anchorThreadKey !== "main") {
    refs.push({ threadKey: anchorThreadKey, questId: anchorThreadKey, source: "explicit", attachedAt: timestamp });
  }
  for (const threadKey of visibleThreadKeys) {
    if (threadKey === "main" || threadKey === anchorThreadKey) continue;
    refs.push({ threadKey, questId: threadKey, source: "backfill", attachedAt: timestamp });
  }
  if (refs.length === 0) delete message.threadRefs;
  else message.threadRefs = refs;
}

const ANSWER_ROUTE_EXPECTED =
  "Use the supplied IDs of earlier direct user requests or delivered timer firings. Their proven owners determine coverage, and their associated tabs receive the same answer automatically.";

function selectedThreadKeyForDiagnostic(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): string {
  const value = message.threadKey?.trim().toLowerCase();
  return value === "main" || (value !== undefined && /^q-\d+$/.test(value)) ? value : "main";
}

function validDiagnosticAnswerIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isCanonicalLeaderAnswerMessageId) &&
    new Set(value).size === value.length
  );
}

function persistAnswerRouteDiagnostic(
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  diagnostic: LeaderAnswerRouteDiagnostic,
): void {
  message.threadRoutingError = {
    reason: "invalid_answer_route",
    expected: ANSWER_ROUTE_EXPECTED,
    source: "answer_marker",
    answerRouteDiagnostic: diagnostic,
  };
}

function rejectAnswerRoute(
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  reason: LeaderAnswerRouteDiagnosticReason,
  options: {
    selectedThreadKey?: string;
    answerUserMessageIds?: string[];
    ownerGroups?: LeaderAnswerRouteOwnerGroup[];
    missingAssociationUserMessageIds?: string[];
    resultReason?: Extract<FinalizeRoutedLeaderResponseResult, { finalized: false }>["reason"];
  } = {},
): FinalizeRoutedLeaderResponseResult {
  const answerUserMessageIds = options.answerUserMessageIds ?? message.leaderAnswerUserMessageIds;
  if (validDiagnosticAnswerIds(answerUserMessageIds)) {
    persistAnswerRouteDiagnostic(message, {
      reason,
      selectedThreadKey: options.selectedThreadKey ?? selectedThreadKeyForDiagnostic(message),
      answerUserMessageIds: [...answerUserMessageIds],
      ownerGroups: (options.ownerGroups ?? []).map((group) => ({
        threadKey: group.threadKey,
        userMessageIds: [...group.userMessageIds],
      })),
      ...(options.missingAssociationUserMessageIds?.length
        ? { missingAssociationUserMessageIds: [...options.missingAssociationUserMessageIds] }
        : {}),
    });
  }
  return { finalized: false, reason: options.resultReason ?? "invalid_message" };
}

function clearAnswerRouteDiagnostic(message: Extract<BrowserIncomingMessage, { type: "assistant" }>): void {
  if (message.threadRoutingError?.reason === "invalid_answer_route") delete message.threadRoutingError;
}

function parsedExplicitCandidate(
  message: BrowserIncomingMessage,
  historyIndex: number,
  answerTargets: readonly AnswerTargetMessage[],
  boundedLimit: number,
): AnswerCandidate | null {
  if (
    message.type !== "assistant" ||
    !isRootAgentHistoryMessage(message) ||
    message.leaderThreadRole !== "answer" ||
    !eligibleAssistantAnswer(message) ||
    !validAnswerMetadata(message.threadAnswer)
  ) {
    return null;
  }
  const threadKey = exactResponseThreadKey(message);
  const markdown = responseMessageMarkdown(message);
  const messageId = responseMessageId(message);
  const createdAt = responseMessageTimestamp(message);
  const metadata = message.threadAnswer;
  if (
    !threadKey ||
    !messageId ||
    metadata.observedHistoryLength > historyIndex ||
    metadata.observedHistoryLength > boundedLimit ||
    !isSubstantiveLeaderThreadAnswer(markdown) ||
    createdAt === null ||
    createdAt < 0
  ) {
    return null;
  }
  const resolution = resolveExplicitAnswerMessagesForOwner(
    answerTargets,
    metadata.answerUserMessageIds,
    metadata.observedHistoryLength,
  );
  if (!resolution.ok || !answerOwnerProofMatches(metadata, resolution.ownerGroups, threadKey)) return null;
  const referenced = resolution.referenced;
  return {
    threadKey,
    answerUserMessageIds: [...metadata.answerUserMessageIds],
    referencedUserMessageIds: referenced.map((entry) => entry.historyMessageId),
    messageId,
    historyIndex,
    createdAt,
    source: "explicit",
  };
}

function projectCurrentAnswers(
  candidates: AnswerCandidate[],
  answerTargets: readonly AnswerTargetMessage[],
): LeaderThreadResponseState[] {
  const uniqueCandidates: AnswerCandidate[] = [];
  const seenMessageIds = new Set<string>();
  for (const candidate of [...candidates].sort((left, right) => left.historyIndex - right.historyIndex)) {
    if (seenMessageIds.has(candidate.messageId)) continue;
    seenMessageIds.add(candidate.messageId);
    uniqueCandidates.push(candidate);
  }

  const latestByUserMessageId = new Map<string, AnswerCandidate>();
  for (const candidate of uniqueCandidates) {
    candidate.referencedUserMessageIds.forEach((messageId) => latestByUserMessageId.set(messageId, candidate));
  }
  const conciseByHistoryId = new Map(answerTargets.map((message) => [message.historyMessageId, message.userMessageId]));

  return uniqueCandidates.flatMap((candidate) => {
    const coveredUserMessageIds = candidate.referencedUserMessageIds.filter(
      (messageId) => latestByUserMessageId.get(messageId) === candidate,
    );
    // Current coverage remains last-answer-wins per user message. Explicit
    // answers are also presentation history, so retain a structurally valid
    // row even when a later answer owns every repeated ID. Legacy revisions
    // keep their historical current-only behavior.
    if (coveredUserMessageIds.length === 0 && candidate.source !== "explicit") return [];
    const coveredAnswerUserMessageIds = coveredUserMessageIds.map((messageId) => conciseByHistoryId.get(messageId));
    if (coveredAnswerUserMessageIds.some((id) => !id)) return [];
    return [
      {
        version: LEADER_THREAD_RESPONSE_VERSION,
        threadKey: candidate.threadKey,
        ...(candidate.threadKey === "main" ? {} : { questId: candidate.threadKey }),
        answerUserMessageIds: [...candidate.answerUserMessageIds],
        referencedUserMessageIds: [...candidate.referencedUserMessageIds],
        coveredAnswerUserMessageIds: coveredAnswerUserMessageIds as string[],
        coveredUserMessageIds,
        currentMessageId: candidate.messageId,
        currentHistoryIndex: candidate.historyIndex,
        createdAt: candidate.createdAt,
        updatedAt: candidate.createdAt,
        source: candidate.source,
      },
    ];
  });
}

function evaluateResponses(
  session: Pick<LeaderThreadResponseSession, "id" | "messageHistory">,
  historyLimit = session.messageHistory.length,
): Evaluation {
  const boundedLimit = Math.max(0, Math.min(Math.floor(historyLimit), session.messageHistory.length));
  const answerTargets = collectAnswerTargets(session.messageHistory, boundedLimit);
  // Firing answerability is optional. Only direct humans create pending/Ready
  // obligations, and legacy batch revisions remain confined to those humans.
  const directMessages = answerTargets.filter((message) => isCanonicalLeaderUserMessageId(message.userMessageId));
  const candidates = evaluateLegacyCandidates(session, directMessages, boundedLimit);
  for (let historyIndex = 0; historyIndex < boundedLimit; historyIndex += 1) {
    const candidate = parsedExplicitCandidate(
      session.messageHistory[historyIndex]!,
      historyIndex,
      answerTargets,
      boundedLimit,
    );
    if (candidate) candidates.push(candidate);
  }
  const currentAnswers = projectCurrentAnswers(candidates, answerTargets).sort(
    (left, right) => left.currentHistoryIndex - right.currentHistoryIndex,
  );
  return {
    directMessages,
    answerTargets,
    currentAnswers,
    coveredMessageIds: new Set(currentAnswers.flatMap((answer) => answer.coveredUserMessageIds)),
  };
}

function projectCurrentAnswerForThread(
  answer: LeaderThreadResponseState,
  answerTargetsById: ReadonlyMap<string, AnswerTargetMessage>,
  threadKey: string,
  source: BrowserIncomingMessage | undefined,
): LeaderThreadResponseState | null {
  if (
    answer.coveredUserMessageIds.length !== answer.coveredAnswerUserMessageIds.length ||
    (answer.coveredUserMessageIds.length === 0 && answer.source !== "explicit")
  ) {
    return null;
  }
  if (answer.source !== "explicit") return answer.threadKey === threadKey ? answer : null;

  const referencedMessages = answer.referencedUserMessageIds.map((messageId) => answerTargetsById.get(messageId));
  if (referencedMessages.some((message) => !message)) return null;
  const authoredThreadKey =
    source?.type === "assistant" ? (source.threadAnswer?.authoredThreadKey ?? answer.threadKey) : answer.threadKey;
  if (
    authoredThreadKey !== threadKey &&
    !referencedMessages.some((message) => message!.associatedThreadKeys.includes(threadKey))
  ) {
    return null;
  }
  const coveredUserMessageIds = answer.coveredUserMessageIds.filter(
    (id) => answerTargetsById.get(id)?.threadKey === threadKey,
  );
  return {
    ...answer,
    coveredUserMessageIds,
    coveredAnswerUserMessageIds: coveredUserMessageIds.map((id) => answerTargetsById.get(id)!.userMessageId),
  };
}

function buildLeaderThreadResponseStateAt(
  session: Pick<LeaderThreadResponseSession, "id" | "messageHistory">,
  requestedThreadKey: string,
  historyLimit: number,
): { projection: LeaderThreadResponseProjection; responses: LeaderThreadResponseState[] } {
  const threadKey = normalizeThreadKey(requestedThreadKey);
  const boundedLimit = Math.max(0, Math.min(Math.floor(historyLimit), session.messageHistory.length));
  const evaluation = evaluateResponses(session, boundedLimit);
  const answerTargetsById = new Map(
    evaluation.answerTargets.map((message) => [message.historyMessageId, message] as const),
  );
  const currentAnswers = evaluation.currentAnswers.flatMap((answer) => {
    const projected = projectCurrentAnswerForThread(
      answer,
      answerTargetsById,
      threadKey,
      session.messageHistory[answer.currentHistoryIndex],
    );
    return projected ? [projected] : [];
  });
  const ownedMessages = evaluation.directMessages.filter((message) => message.threadKey === threadKey);
  const supportingMessageIds = new Set(currentAnswers.flatMap((answer) => answer.referencedUserMessageIds));
  const projectedMessages = evaluation.answerTargets.filter(
    (message) => message.threadKey === threadKey || supportingMessageIds.has(message.historyMessageId),
  );
  const pendingMessages = ownedMessages
    .filter((message) => !evaluation.coveredMessageIds.has(message.historyMessageId))
    .map((message) => ({
      userMessageId: message.userMessageId,
      historyMessageId: message.historyMessageId,
      historyIndex: message.historyIndex,
      askedAt: message.timestamp,
    }));
  const projection: LeaderThreadResponseProjection = {
    version: LEADER_THREAD_RESPONSE_VERSION,
    threadKey,
    cutoverHistoryIndex: projectedMessages[0]?.historyIndex ?? session.messageHistory.length,
    pendingMessageCount: pendingMessages.length,
    pendingMessages,
    currentAnswers,
    ready: pendingMessages.length === 0,
  };
  return { projection, responses: currentAnswers };
}

export function buildLeaderThreadResponseState(
  session: Pick<LeaderThreadResponseSession, "id" | "messageHistory">,
  requestedThreadKey: string,
): { projection: LeaderThreadResponseProjection; responses: LeaderThreadResponseState[] } {
  return buildLeaderThreadResponseStateAt(session, requestedThreadKey, session.messageHistory.length);
}

export type FinalizeRoutedLeaderResponseResult =
  | {
      finalized: true;
      answerId: string;
    }
  | {
      finalized: false;
      reason: "not_answer" | "already_finalized" | "unproven_observation" | "invalid_message" | "stale";
    };

function otherStoredAnswerUsesMessageId(
  session: LeaderThreadResponseSession,
  current: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  messageId: string,
): boolean {
  return session.messageHistory.some((entry) => {
    if (entry === current || (entry.type !== "assistant" && entry.type !== "leader_user_message")) return false;
    if (responseMessageId(entry) !== messageId) return false;
    return validAnswerMetadata(entry.threadAnswer) || validLegacyRevisionMetadata(entry.threadResponse);
  });
}

/** Separate retained answer visibility from current per-request completion authority. */
export function leaderAnswerThreadAuthority(
  session: LeaderThreadResponseSession,
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
): { ownerThreadKeys: string[]; visibleThreadKeys: string[] } {
  const empty = { ownerThreadKeys: [], visibleThreadKeys: [] };
  const historyIndex = session.messageHistory.indexOf(message);
  if (historyIndex < 0 || !validAnswerMetadata(message.threadAnswer)) return empty;
  const evaluation = evaluateResponses(session);
  const answer = evaluation.currentAnswers.find(
    (answer) => answer.currentHistoryIndex === historyIndex && answer.currentMessageId === message.message.id,
  );
  if (!answer) return empty;
  const covered = new Set(answer.coveredUserMessageIds);
  const referenced = new Set(answer.referencedUserMessageIds);
  return {
    ownerThreadKeys: [
      ...new Set(
        evaluation.answerTargets.filter((entry) => covered.has(entry.historyMessageId)).map((entry) => entry.threadKey),
      ),
    ],
    visibleThreadKeys: [
      ...new Set([
        message.threadAnswer.authoredThreadKey ?? answer.threadKey,
        ...evaluation.answerTargets
          .filter((entry) => referenced.has(entry.historyMessageId))
          .flatMap((entry) => entry.associatedThreadKeys),
      ]),
    ],
  };
}

export function isCurrentValidRoutedLeaderResponseMessage(
  session: LeaderThreadResponseSession,
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
): boolean {
  return leaderAnswerThreadAuthority(session, message).ownerThreadKeys.length > 0;
}

export function finalizeRoutedLeaderResponseMessage(
  session: LeaderThreadResponseSession,
  message: Extract<BrowserIncomingMessage, { type: "assistant" }>,
): FinalizeRoutedLeaderResponseResult {
  if (message.leaderThreadRole !== "answer") return { finalized: false, reason: "not_answer" };
  if (validAnswerMetadata(message.threadAnswer)) return { finalized: false, reason: "already_finalized" };
  const observedHistoryLength = message.leaderAnswerObservedHistoryLength;
  if (
    !Number.isInteger(observedHistoryLength) ||
    (observedHistoryLength ?? -1) < 0 ||
    (observedHistoryLength ?? 0) > session.messageHistory.length
  ) {
    return rejectAnswerRoute(message, "stale", { resultReason: "unproven_observation" });
  }
  const selectedThreadKey = exactResponseThreadKey(message);
  const markdown = responseMessageMarkdown(message);
  const messageId = responseMessageId(message);
  const historyIndex = session.messageHistory.indexOf(message);
  const answerUserMessageIds = message.leaderAnswerUserMessageIds;
  if (!selectedThreadKey) {
    return rejectAnswerRoute(message, "route_control_conflict");
  }
  if (hasThreadControlDirectives(markdown)) {
    return rejectAnswerRoute(message, "route_control_conflict", { selectedThreadKey });
  }
  if (
    !Array.isArray(answerUserMessageIds) ||
    answerUserMessageIds.length === 0 ||
    answerUserMessageIds.some((id) => !isCanonicalLeaderAnswerMessageId(id)) ||
    new Set(answerUserMessageIds).size !== answerUserMessageIds.length
  ) {
    return rejectAnswerRoute(message, "invalid_ids", { selectedThreadKey });
  }
  if (
    !messageId ||
    historyIndex < observedHistoryLength! ||
    !isRootAgentHistoryMessage(message) ||
    !eligibleAssistantAnswer(message) ||
    !isSubstantiveLeaderThreadAnswer(markdown) ||
    message.threadAnswer !== undefined ||
    otherStoredAnswerUsesMessageId(session, message, messageId)
  ) {
    return rejectAnswerRoute(message, "invalid_answer", {
      selectedThreadKey,
      answerUserMessageIds,
    });
  }

  const answerTargets = collectAnswerTargets(session.messageHistory, session.messageHistory.length);
  const resolution = resolveExplicitAnswerMessagesForOwner(answerTargets, answerUserMessageIds, observedHistoryLength!);
  if (!resolution.ok) {
    return rejectAnswerRoute(message, resolution.reason, {
      selectedThreadKey,
      answerUserMessageIds,
      ownerGroups: resolution.ownerGroups,
    });
  }

  const ownerGroups = resolution.ownerGroups;
  if (hasConflictingAuthoritativeAnswerRefs(message, selectedThreadKey)) {
    return rejectAnswerRoute(message, "route_control_conflict", {
      selectedThreadKey,
      answerUserMessageIds,
      ownerGroups,
    });
  }
  const visibleThreadKeys = [
    ...new Set([selectedThreadKey, ...resolution.referenced.flatMap((entry) => entry.associatedThreadKeys)]),
  ];
  // Main visibility uses the normal source route; all additional quest views
  // share this exact row through visibility-only refs.
  const anchorThreadKey = visibleThreadKeys.includes("main")
    ? "main"
    : (ownerGroups.find((group) => group.threadKey === selectedThreadKey)?.threadKey ?? ownerGroups[0]!.threadKey);
  const routeSnapshot = answerRouteSnapshot(message);
  canonicalizeAnswerRoute(message, anchorThreadKey, visibleThreadKeys);

  message.threadAnswer = {
    version: LEADER_THREAD_RESPONSE_VERSION,
    answerUserMessageIds: [...answerUserMessageIds],
    observedHistoryLength: observedHistoryLength!,
    authoredThreadKey: selectedThreadKey,
    ownerGroups,
  };
  if (!isCurrentValidRoutedLeaderResponseMessage(session, message)) {
    delete message.threadAnswer;
    restoreAnswerRoute(message, routeSnapshot);
    return rejectAnswerRoute(message, "stale", {
      selectedThreadKey,
      answerUserMessageIds,
      ownerGroups,
      resultReason: "stale",
    });
  }
  clearAnswerRouteDiagnostic(message);
  return {
    finalized: true,
    answerId: messageId,
  };
}
