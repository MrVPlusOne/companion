import { getDefaultModelForBackend } from "../../shared/backend-defaults.js";
import { normalizeCodexMessagePhase } from "../../shared/codex-message-phase.js";
import type { ParsedThreadStatusMarker } from "../../shared/thread-status-marker.js";
import type { CodexResumeTurnSnapshot } from "../codex-adapter.js";
import type { BrowserIncomingMessage, CodexOutboundTurn, ContentBlock, SessionState } from "../session-types.js";
import {
  buildLeaderThreadResponseState,
  finalizeRoutedLeaderResponseMessage,
  isCurrentValidRoutedLeaderResponseMessage,
} from "../leader-thread-response.js";
import type { ThreadRouteMetadata } from "../thread-routing-metadata.js";
import { hasFinalCodexOutcomeEvidence } from "./codex-interrupted-turn-recovery.js";
import { leaderRouteFromRecoveredAssistant } from "./codex-leader-recovery-diagnostic.js";
import { displayOnlyLeaderAnswerThreads } from "./leader-answer-ready-authority.js";
import {
  normalizeLeaderAssistantRouting,
  splitLeaderAssistantContentAtThreadRouteBoundaries,
  updateLeaderThreadStatusesForAssistantOutput,
} from "./thread-routing-reminder.js";

type AssistantHistoryEntry = Extract<BrowserIncomingMessage, { type: "assistant" }>;

type CanonicalRecoveredAssistant = {
  text: string;
  routeKey: string;
  role: NonNullable<AssistantHistoryEntry["leaderThreadRole"]>;
  answerUserMessageIds: string;
};

const LEGACY_FINAL_THREAD_MARKER_RE = /^(\s*)\[thread:(main|q-\d+):F\](?=$|[ \t]|\r?\n)/i;

export type CodexRecoveredAssistantRouteFields = Pick<
  AssistantHistoryEntry,
  "threadKey" | "questId" | "threadRefs" | "threadRoutingError" | "leaderThreadRole" | "leaderAnswerUserMessageIds"
> & {
  content: ContentBlock[];
  threadStatusMarkers?: import("../../shared/thread-status-marker.js").ParsedThreadStatusMarker[];
};

export interface CodexRecoveredAssistantRoutingSessionLike {
  id?: string;
  state: Pick<SessionState, "isOrchestrator" | "model" | "leaderThreadStatuses">;
  messageHistory: BrowserIncomingMessage[];
  _frozenCount?: number;
  pendingLeaderRejectedReadyThreadKeys?: string[];
}

function isLeaderSessionForRecoveredAssistantRouting(session: CodexRecoveredAssistantRoutingSessionLike): boolean {
  return session.state.isOrchestrator === true;
}

function normalizeCodexRecoveredAssistantText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function buildCodexRecoveredAssistantRouteSegments(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
): CodexRecoveredAssistantRouteFields[] {
  const isLeaderSession = isLeaderSessionForRecoveredAssistantRouting(session);
  return splitLeaderAssistantContentAtThreadRouteBoundaries(isLeaderSession, [{ type: "text", text }], null).map(
    (contentSegment) => normalizeLeaderAssistantRouting(isLeaderSession, contentSegment, null),
  );
}

/**
 * Retired `:F` syntax is parsed only as a replay candidate. The returned
 * route fields never enter the recovered-message authoring path; callers must
 * additionally prove that the candidate matches an already-persisted valid
 * legacy response row.
 */
function buildLegacyFinalReplayRouteSegments(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
): CodexRecoveredAssistantRouteFields[] | null {
  if (!isLeaderSessionForRecoveredAssistantRouting(session)) return null;
  const segments = splitLeaderAssistantContentAtThreadRouteBoundaries(true, [{ type: "text", text }], null);
  const routed = segments.map((contentSegment) => {
    const firstTextIndex = contentSegment.findIndex((block) => block.type === "text" && block.text.trim());
    if (firstTextIndex < 0) return null;
    const firstText = contentSegment[firstTextIndex] as Extract<ContentBlock, { type: "text" }>;
    const marker = LEGACY_FINAL_THREAD_MARKER_RE.exec(firstText.text);
    if (!marker) return null;

    const rewritten = contentSegment.slice();
    rewritten[firstTextIndex] = {
      ...firstText,
      text: `${marker[1]}[thread:${marker[2]}:C]${firstText.text.slice(marker[0].length)}`,
    };
    const normalized = normalizeLeaderAssistantRouting(true, rewritten, null);
    if (normalized.threadRoutingError || normalized.leaderThreadRole !== "commentary") return null;
    return { ...normalized, leaderThreadRole: "response" as const };
  });
  return routed.every(Boolean) ? (routed as CodexRecoveredAssistantRouteFields[]) : null;
}

export function codexRecoveredAssistantModel(session: CodexRecoveredAssistantRoutingSessionLike): string {
  return session.state.model || getDefaultModelForBackend("codex");
}

function canonicalRouteKeyForRecoveredAssistant(
  entry: Pick<AssistantHistoryEntry, "threadKey" | "questId" | "threadRefs" | "threadRoutingError" | "threadAnswer">,
  routed: CodexRecoveredAssistantRouteFields,
): string {
  // Settlement may choose a different display anchor. Provider replay still
  // carries the originally authored route, which belongs to the same row.
  const authored = entry.threadAnswer?.authoredThreadKey;
  if (authored === "main" || (typeof authored === "string" && /^q-\d+$/.test(authored))) return authored;
  const routedKey = routed.threadKey || routed.questId;
  if (routedKey) return routedKey.trim().toLowerCase() || "main";
  if (entry.threadKey) return entry.threadKey.trim().toLowerCase() || "main";
  if (entry.questId) return entry.questId.trim().toLowerCase() || "main";
  const explicitRef = (entry.threadRefs ?? []).find((ref) => ref.source !== "backfill" && ref.threadKey);
  return explicitRef?.threadKey.trim().toLowerCase() || "main";
}

function canonicalRecoveredAssistantFromRouteFields(
  routed: CodexRecoveredAssistantRouteFields,
  entry: Pick<
    AssistantHistoryEntry,
    | "threadKey"
    | "questId"
    | "threadRefs"
    | "threadRoutingError"
    | "leaderThreadRole"
    | "leaderAnswerUserMessageIds"
    | "threadAnswer"
  > = {},
): CanonicalRecoveredAssistant | null {
  const textBlocks = routed.content.filter((block) => block.type === "text");
  if (textBlocks.length !== 1) return null;
  const normalizedText = normalizeCodexRecoveredAssistantText(textBlocks[0].text || "");
  if (!normalizedText) return null;
  return {
    text: normalizedText,
    routeKey: canonicalRouteKeyForRecoveredAssistant(entry, routed),
    role: routed.leaderThreadRole ?? entry.leaderThreadRole ?? "commentary",
    answerUserMessageIds: (
      routed.leaderAnswerUserMessageIds ??
      entry.threadAnswer?.answerUserMessageIds ??
      entry.leaderAnswerUserMessageIds ??
      []
    ).join(","),
  };
}

function canonicalRecoveredAssistant(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
  entry: Pick<AssistantHistoryEntry, "threadKey" | "questId" | "threadRefs" | "threadRoutingError"> = {},
): CanonicalRecoveredAssistant | null {
  const segments = buildCodexRecoveredAssistantRouteSegments(session, text);
  if (segments.length !== 1) return null;
  return canonicalRecoveredAssistantFromRouteFields(segments[0]!, entry);
}

function canonicalRecoveredAssistantSegments(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
): CanonicalRecoveredAssistant[] | null {
  const canonical = buildCodexRecoveredAssistantRouteSegments(session, text).map((segment) =>
    canonicalRecoveredAssistantFromRouteFields(segment),
  );
  return canonical.every(Boolean) ? (canonical as CanonicalRecoveredAssistant[]) : null;
}

function canonicalExistingRecoveredAssistant(
  session: CodexRecoveredAssistantRoutingSessionLike,
  existing: AssistantHistoryEntry,
): CanonicalRecoveredAssistant | null {
  const textBlocks = existing.message.content.filter((block) => block.type === "text");
  if (textBlocks.length !== 1) return null;
  return canonicalRecoveredAssistant(session, textBlocks[0].text || "", existing);
}

function sameCanonicalRecoveredAssistant(
  left: CanonicalRecoveredAssistant | null,
  right: CanonicalRecoveredAssistant | null,
): boolean {
  return (
    !!left &&
    !!right &&
    left.text === right.text &&
    left.routeKey === right.routeKey &&
    left.role === right.role &&
    left.answerUserMessageIds === right.answerUserMessageIds
  );
}

function canonicalLegacyFinalReplaySegments(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
): CanonicalRecoveredAssistant[] | null {
  const routed = buildLegacyFinalReplayRouteSegments(session, text);
  if (!routed) return null;
  const canonical = routed.map((segment) => canonicalRecoveredAssistantFromRouteFields(segment));
  return canonical.every(Boolean) ? (canonical as CanonicalRecoveredAssistant[]) : null;
}

function isHistoricallyValidLegacyAssistantResponse(
  session: CodexRecoveredAssistantRoutingSessionLike,
  entry: AssistantHistoryEntry,
): boolean {
  if (!session.id || entry.leaderThreadRole !== "response" || !entry.threadResponse) return false;
  const historyIndex = session.messageHistory.indexOf(entry);
  if (historyIndex < 0) return false;
  const threadKey = entry.threadKey?.trim().toLowerCase();
  if (threadKey !== "main" && !/^q-\d+$/.test(threadKey ?? "")) return false;

  const historical = buildLeaderThreadResponseState(
    { id: session.id, messageHistory: session.messageHistory.slice(0, historyIndex + 1) },
    threadKey!,
  );
  return historical.responses.some(
    (response) =>
      response.source === "legacy" &&
      response.currentHistoryIndex === historyIndex &&
      response.currentMessageId === entry.message.id,
  );
}

function matchesRecoveredAssistantCandidate(
  session: CodexRecoveredAssistantRoutingSessionLike,
  existingEntry: AssistantHistoryEntry,
  incoming: CanonicalRecoveredAssistant | null,
  legacyIncoming: CanonicalRecoveredAssistant | null,
): boolean {
  const existing = canonicalExistingRecoveredAssistant(session, existingEntry);
  if (sameCanonicalRecoveredAssistant(existing, incoming)) return true;
  if (!sameCanonicalRecoveredAssistant(existing, legacyIncoming)) return false;
  return isHistoricallyValidLegacyAssistantResponse(session, existingEntry);
}

export function findMatchingRecoveredCodexAssistantReplay(
  session: CodexRecoveredAssistantRoutingSessionLike,
  text: string,
  limit: number,
  afterHistoryIndex = -1,
): AssistantHistoryEntry[] | null {
  const incoming = canonicalRecoveredAssistantSegments(session, text);
  if (!incoming?.length) return null;
  const legacyIncoming = canonicalLegacyFinalReplaySegments(session, text);

  const recentAssistants: AssistantHistoryEntry[] = [];
  for (let i = session.messageHistory.length - 1; i >= 0 && recentAssistants.length < limit; i--) {
    const absoluteHistoryIndex = (session._frozenCount ?? 0) + i;
    if (absoluteHistoryIndex <= afterHistoryIndex) break;
    const entry = session.messageHistory[i];
    if (entry.type === "assistant" && entry.parent_tool_use_id === null) {
      recentAssistants.push(entry);
    }
  }
  recentAssistants.reverse();

  for (let start = 0; start <= recentAssistants.length - incoming.length; start++) {
    let matches = true;
    for (let offset = 0; offset < incoming.length; offset++) {
      const existing = recentAssistants[start + offset]!;
      if (!matchesRecoveredAssistantCandidate(session, existing, incoming[offset]!, legacyIncoming?.[offset] ?? null)) {
        matches = false;
        break;
      }
    }
    if (matches) return recentAssistants.slice(start, start + incoming.length);
  }

  return null;
}

function recoveredStatusMarkerAlreadyApplied(entry: AssistantHistoryEntry, marker: ParsedThreadStatusMarker): boolean {
  return (entry.threadStatusMarkers ?? []).some(
    (status) =>
      status.messageId === entry.message.id &&
      status.kind === marker.kind &&
      status.threadKey === marker.target.threadKey &&
      status.summary === marker.summary,
  );
}

function reconcileCompletedRecoveredAssistantControls(
  session: CodexRecoveredAssistantRoutingSessionLike,
  entry: AssistantHistoryEntry,
  routed: CodexRecoveredAssistantRouteFields,
  answerObservationHistoryLength: number | undefined,
): boolean {
  let changed = false;
  // Canonical matching includes route, role, and answer IDs. Preserve legacy
  // roleless commentary instead of promoting replay into fresh authority.
  if (
    routed.leaderThreadRole === "answer" &&
    routed.leaderAnswerUserMessageIds?.length &&
    answerObservationHistoryLength !== undefined &&
    !isCurrentValidRoutedLeaderResponseMessage({ id: session.id ?? "", messageHistory: session.messageHistory }, entry)
  ) {
    if (entry.leaderAnswerObservedHistoryLength !== answerObservationHistoryLength) {
      entry.leaderAnswerObservedHistoryLength = answerObservationHistoryLength;
      changed = true;
    }
    if (entry.leaderAnswerUserMessageIds?.join(",") !== routed.leaderAnswerUserMessageIds.join(",")) {
      entry.leaderAnswerUserMessageIds = [...routed.leaderAnswerUserMessageIds];
      changed = true;
    }
  }
  const incomingMarkers = (routed.threadStatusMarkers ?? []).filter(
    (marker) =>
      !recoveredStatusMarkerAlreadyApplied(entry, marker) &&
      !(entry.deferredThreadStatusMarkers ?? []).some(
        (existing) =>
          existing.kind === marker.kind &&
          existing.target.threadKey === marker.target.threadKey &&
          existing.summary === marker.summary,
      ),
  );
  if (incomingMarkers.length > 0) {
    entry.deferredThreadStatusMarkers = [...(entry.deferredThreadStatusMarkers ?? []), ...incomingMarkers];
    changed = true;
  }
  return changed;
}

function deferRecoveredRejectedReadyThreads(
  session: CodexRecoveredAssistantRoutingSessionLike,
  threadKeys: Iterable<string>,
): boolean {
  const pending = new Set(session.pendingLeaderRejectedReadyThreadKeys ?? []);
  const before = pending.size;
  for (const rawThreadKey of threadKeys) {
    const threadKey = rawThreadKey.trim().toLowerCase();
    if (threadKey === "main" || /^q-\d+$/.test(threadKey)) pending.add(threadKey);
  }
  if (pending.size === before) return false;
  session.pendingLeaderRejectedReadyThreadKeys = [...pending];
  return true;
}

function recoveredResponseObservationHistoryLength(
  session: CodexRecoveredAssistantRoutingSessionLike,
  pending: Pick<CodexOutboundTurn, "historyIndex"> &
    Partial<Pick<CodexOutboundTurn, "userMessageId" | "pendingInputIds" | "historyIncorporation">>,
): number | undefined {
  const ownerIds = recoveredOwnerIds(pending);
  const localIndexes = session.messageHistory.flatMap((message, index) =>
    message.type === "user_message" && message.id && ownerIds.has(message.id) ? [index] : [],
  );
  if (localIndexes.length > 0) return Math.max(...localIndexes) + 1;

  const absoluteIndexes = [
    ...(pending.historyIncorporation?.historyIndexes ?? []).filter((index): index is number => Number.isInteger(index)),
    ...(Number.isInteger(pending.historyIndex) && pending.historyIndex >= 0 ? [pending.historyIndex] : []),
  ];
  if (absoluteIndexes.length === 0) return undefined;
  const localBoundary = Math.max(...absoluteIndexes) - (session._frozenCount ?? 0) + 1;
  return localBoundary >= 0 && localBoundary <= session.messageHistory.length ? localBoundary : undefined;
}

function recoveredOwnerIds(
  pending: Partial<Pick<CodexOutboundTurn, "userMessageId" | "pendingInputIds">>,
): Set<string> {
  return new Set([pending.userMessageId, ...(pending.pendingInputIds ?? [])].filter((id): id is string => Boolean(id)));
}

function recoveredReplayLowerBoundHistoryIndex(
  session: CodexRecoveredAssistantRoutingSessionLike,
  pending: Pick<CodexOutboundTurn, "historyIndex"> &
    Partial<Pick<CodexOutboundTurn, "userMessageId" | "pendingInputIds" | "historyIncorporation">>,
): number {
  const frozenCount = session._frozenCount ?? 0;
  const ownerIds = recoveredOwnerIds(pending);
  const exactOwnerIndexes = session.messageHistory.flatMap((message, index) =>
    message.type === "user_message" && message.id && ownerIds.has(message.id) ? [frozenCount + index] : [],
  );
  const recordedOwnerIndexes = (pending.historyIncorporation?.historyIndexes ?? []).filter((index): index is number =>
    Number.isInteger(index),
  );
  return Math.max(pending.historyIndex, ...recordedOwnerIndexes, ...exactOwnerIndexes);
}

export function recoverAgentMessagesFromResumedTurn<S extends CodexRecoveredAssistantRoutingSessionLike>(
  session: S,
  turn: CodexResumeTurnSnapshot,
  pending: Pick<CodexOutboundTurn, "disconnectedAt" | "historyIndex"> &
    Partial<Pick<CodexOutboundTurn, "userMessageId" | "pendingInputIds" | "historyIncorporation">>,
  deps: {
    codexAssistantReplayScanLimit: number;
    broadcastToBrowsers: (session: S, message: BrowserIncomingMessage) => void;
    refreshBrowserConversationViews?: (session: S) => void;
    invalidateLeaderThreadTabsForSession?: (sessionId: string) => boolean | void;
  },
): { count: number; latestLeaderRoute: ThreadRouteMetadata | null } {
  let matchedOrRecovered = 0;
  let latestLeaderRoute: ThreadRouteMetadata | null = null;
  const controlCandidates = new Map<AssistantHistoryEntry, boolean>();
  const isLeaderSession = session.state.isOrchestrator === true;
  const baseTs = pending.disconnectedAt ?? Date.now();
  const responseObservationHistoryLength = recoveredResponseObservationHistoryLength(session, pending);
  const replayAfterHistoryIndex = recoveredReplayLowerBoundHistoryIndex(session, pending);
  const completed = turn.status === "completed" && turn.error == null && hasFinalCodexOutcomeEvidence(turn);
  const queueControlCandidate = (entry: AssistantHistoryEntry, metadataChanged = false) => {
    if (
      metadataChanged ||
      entry.leaderThreadRole === "answer" ||
      entry.leaderAnswerObservedHistoryLength !== undefined ||
      entry.leaderAnswerUserMessageIds !== undefined ||
      entry.leaderResponseObservedHistoryLength !== undefined ||
      entry.deferredThreadStatusMarkers?.length
    ) {
      controlCandidates.set(entry, (controlCandidates.get(entry) ?? false) || metadataChanged);
    }
  };

  for (let i = 0; i < turn.items.length; i++) {
    const item = turn.items[i];
    if (item.type !== "agentMessage") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) continue;
    const routedSegments = buildCodexRecoveredAssistantRouteSegments(session, text);
    const itemId = typeof item.id === "string" ? item.id : `${turn.id}-${i}`;
    const isGenericItemId = /^item-\d+$/.test(itemId);
    const replayMatches = isGenericItemId
      ? findMatchingRecoveredCodexAssistantReplay(
          session,
          text,
          deps.codexAssistantReplayScanLimit,
          replayAfterHistoryIndex,
        )
      : null;
    if (replayMatches) {
      for (const [matchIndex, replayMatch] of replayMatches.entries()) {
        const routed = routedSegments[matchIndex];
        const metadataChanged =
          completed && routed
            ? reconcileCompletedRecoveredAssistantControls(
                session,
                replayMatch,
                routed,
                responseObservationHistoryLength,
              )
            : false;
        latestLeaderRoute = leaderRouteFromRecoveredAssistant(isLeaderSession, replayMatch) ?? latestLeaderRoute;
        queueControlCandidate(replayMatch, metadataChanged);
      }
      matchedOrRecovered++;
      continue;
    }

    const baseAssistantId = isGenericItemId ? `codex-agent-${turn.id}-${itemId}` : `codex-agent-${itemId}`;
    const existingIndex = session.messageHistory.findLastIndex(
      (message) => message.type === "assistant" && message.message?.id === baseAssistantId,
    );
    const existing =
      existingIndex >= 0 && (session._frozenCount ?? 0) + existingIndex > replayAfterHistoryIndex
        ? session.messageHistory[existingIndex]
        : undefined;
    const incomingSingle =
      routedSegments.length === 1 ? canonicalRecoveredAssistantFromRouteFields(routedSegments[0]!) : null;
    const legacyIncoming = canonicalLegacyFinalReplaySegments(session, text);
    const legacyIncomingSingle = legacyIncoming?.length === 1 ? legacyIncoming[0]! : null;
    const exactExisting =
      existing?.type === "assistant" &&
      matchesRecoveredAssistantCandidate(session, existing, incomingSingle, legacyIncomingSingle)
        ? existing
        : null;
    if (exactExisting) {
      const metadataChanged = completed
        ? reconcileCompletedRecoveredAssistantControls(
            session,
            exactExisting,
            routedSegments[0]!,
            responseObservationHistoryLength,
          )
        : false;
      latestLeaderRoute = leaderRouteFromRecoveredAssistant(isLeaderSession, exactExisting) ?? latestLeaderRoute;
      queueControlCandidate(exactExisting, metadataChanged);
      matchedOrRecovered++;
      continue;
    }

    const assistantId =
      existingIndex >= 0 && !isGenericItemId ? `${baseAssistantId}:recovered-${turn.id}` : baseAssistantId;
    for (const [segmentIndex, routed] of routedSegments.entries()) {
      const segmentAssistantId = segmentIndex === 0 ? assistantId : `${assistantId}:route-${segmentIndex}`;
      const assistant: AssistantHistoryEntry = {
        type: "assistant",
        message: {
          id: segmentAssistantId,
          type: "message",
          role: "assistant",
          model: codexRecoveredAssistantModel(session),
          content: routed.content,
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        codexMessagePhase: normalizeCodexMessagePhase(item.phase),
        timestamp: baseTs + i + 1 + segmentIndex / 1000,
        ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
        ...(routed.questId ? { questId: routed.questId } : {}),
        ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
        ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
        ...(routed.leaderThreadRole ? { leaderThreadRole: routed.leaderThreadRole } : {}),
        ...(routed.leaderAnswerUserMessageIds?.length
          ? { leaderAnswerUserMessageIds: routed.leaderAnswerUserMessageIds }
          : {}),
        ...(routed.leaderThreadRole === "answer" && responseObservationHistoryLength !== undefined
          ? { leaderAnswerObservedHistoryLength: responseObservationHistoryLength }
          : {}),
        ...(routed.threadStatusMarkers?.length ? { deferredThreadStatusMarkers: routed.threadStatusMarkers } : {}),
      };
      session.messageHistory.push(assistant);
      deps.broadcastToBrowsers(session, assistant);
      queueControlCandidate(assistant);
      latestLeaderRoute = leaderRouteFromRecoveredAssistant(isLeaderSession, assistant) ?? latestLeaderRoute;
      matchedOrRecovered++;
    }
  }

  let conversationChanged = false;
  let projectionChanged = false;
  const answerCanAnchorReady = new Map<AssistantHistoryEntry, boolean>();

  // Finalize every recovered answer before applying any Ready marker from a
  // sibling segment in the same completed provider turn.
  if (completed && session.id) {
    for (const candidate of controlCandidates.keys()) {
      if (candidate.leaderThreadRole !== "answer") continue;
      const finalized = finalizeRoutedLeaderResponseMessage(
        { id: session.id, messageHistory: session.messageHistory },
        candidate,
      );
      if (finalized.finalized) {
        controlCandidates.set(candidate, true);
        projectionChanged = true;
      }
      answerCanAnchorReady.set(
        candidate,
        finalized.finalized ||
          isCurrentValidRoutedLeaderResponseMessage(
            { id: session.id, messageHistory: session.messageHistory },
            candidate,
          ),
      );
    }
  }

  const displayOnlyReadyThreadKeys = session.id
    ? displayOnlyLeaderAnswerThreads({ id: session.id, messageHistory: session.messageHistory }, [
        ...controlCandidates.keys(),
      ])
    : new Set<string>();

  for (const [candidate, metadataChanged] of controlCandidates) {
    let candidateChanged = metadataChanged;
    const answerIsInvalid = candidate.leaderThreadRole === "answer" && answerCanAnchorReady.get(candidate) !== true;
    if (completed && candidate.deferredThreadStatusMarkers?.length) {
      const authorityRejectedReadyThreadKeys = candidate.deferredThreadStatusMarkers
        .filter(
          (marker) =>
            marker.kind === "ready" && (answerIsInvalid || displayOnlyReadyThreadKeys.has(marker.target.threadKey)),
        )
        .map((marker) => marker.target.threadKey);
      deferRecoveredRejectedReadyThreads(session, authorityRejectedReadyThreadKeys);
      const markersToApply = candidate.deferredThreadStatusMarkers.filter(
        (marker) =>
          marker.kind !== "ready" || (!answerIsInvalid && !displayOnlyReadyThreadKeys.has(marker.target.threadKey)),
      );
      const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(session, markersToApply, {
        messageId: candidate.message.id,
        timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : baseTs,
      });
      if (statusUpdate.records.length > 0) {
        candidate.threadStatusMarkers = [...(candidate.threadStatusMarkers ?? []), ...statusUpdate.records];
      }
      candidateChanged ||= statusUpdate.changed;
      projectionChanged ||= statusUpdate.changed;
      deferRecoveredRejectedReadyThreads(
        session,
        (statusUpdate.rejectedReadyRoutes ?? []).map((route) => route.threadKey),
      );
    }
    if (candidate.leaderAnswerObservedHistoryLength !== undefined) {
      delete candidate.leaderAnswerObservedHistoryLength;
      candidateChanged = true;
    }
    if (candidate.leaderAnswerUserMessageIds !== undefined) {
      delete candidate.leaderAnswerUserMessageIds;
      candidateChanged = true;
    }
    if (candidate.leaderResponseObservedHistoryLength !== undefined) {
      delete candidate.leaderResponseObservedHistoryLength;
      candidateChanged = true;
    }
    if (candidate.deferredThreadStatusMarkers) {
      delete candidate.deferredThreadStatusMarkers;
      candidateChanged = true;
    }
    if (candidateChanged) {
      conversationChanged = true;
      deps.broadcastToBrowsers(session, candidate);
    }
  }
  if (projectionChanged && session.id) deps.invalidateLeaderThreadTabsForSession?.(session.id);
  if (conversationChanged) deps.refreshBrowserConversationViews?.(session);
  return { count: matchedOrRecovered, latestLeaderRoute };
}
