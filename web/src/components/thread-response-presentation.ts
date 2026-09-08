import {
  leaderResponseAnswerOwnerThreadKeys,
  leaderResponseExactAnswerThreadKey,
  leaderResponseMessageIsAssociatedWithThread,
  leaderResponseProvenCurrentOwnerThreadKey,
} from "../../shared/leader-thread-response-routing.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import type { ChatMessage, LeaderThreadResponseProjection, LeaderThreadResponseState } from "../types.js";
import { getAssistantVisibleMarkdown } from "../utils/assistant-message-renderability.js";
import { normalizeThreadKey } from "../utils/thread-projection.js";
import { extractQuestQuizMarkerIds, stripQuestQuizMarkers } from "./AssistantQuestQuizContent.js";
import type { FeedSection } from "./message-feed-sections.js";
import { isUserBoundaryEntry } from "../hooks/use-feed-model.js";

export interface ThreadResponseReferencedUserMessage {
  historyMessageId: string;
  userMessageId: string;
  content: string;
  attachmentCount?: number;
}

export interface CurrentThreadResponsePresentationItem {
  response: LeaderThreadResponseState;
  anchorUserMessageId: string;
  anchorTurnId: string;
  anchorOrder: number;
  sourceTurnId: string;
  messageEntry: Extract<FeedEntry, { kind: "message" }>;
  collapsedMessageEntry: Extract<FeedEntry, { kind: "message" }>;
  referencedUserMessages?: readonly ThreadResponseReferencedUserMessage[];
}

export interface ThreadResponseQuizGroup {
  hostTurnId: string;
  questIds: readonly string[];
}

export interface ThreadResponsePresentation {
  ready: boolean;
  cutoverHistoryIndex: number;
  pendingMessageCount: number;
  currentResponses: readonly CurrentThreadResponsePresentationItem[];
  currentResponseMessageIds: ReadonlySet<string>;
  quizGroups: readonly ThreadResponseQuizGroup[];
  layoutSignature: string;
}

function presentationEntries(turn: Turn): FeedEntry[] {
  return turn.presentationEntries ?? turn.allEntries;
}

function collapsedResponseEntry(
  entry: Extract<FeedEntry, { kind: "message" }>,
): Extract<FeedEntry, { kind: "message" }> {
  const markdown = getAssistantVisibleMarkdown(entry.msg);
  if (extractQuestQuizMarkerIds(markdown).length === 0) return entry;
  const visibleContent = stripQuestQuizMarkers(markdown);
  let contentBlocks: ChatMessage["contentBlocks"];
  if (entry.msg.contentBlocks) {
    contentBlocks = [];
    for (const block of entry.msg.contentBlocks) {
      if (block.type !== "text") {
        contentBlocks.push(block);
        continue;
      }
      const visibleText = stripQuestQuizMarkers(block.text);
      if (visibleText) contentBlocks.push({ ...block, text: visibleText });
    }
  }
  return {
    ...entry,
    msg: {
      ...entry.msg,
      content: visibleContent,
      ...(contentBlocks ? { contentBlocks } : {}),
    },
  };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAuthoritativeCurrentResponseMessage(message: ChatMessage, answer: LeaderThreadResponseState): boolean {
  const metadata = message.metadata;
  const explicitProof =
    answer.source === "explicit" &&
    metadata?.leaderThreadRole === "answer" &&
    metadata.threadAnswer?.version === answer.version &&
    stringArraysEqual(metadata.threadAnswer.answerUserMessageIds, answer.answerUserMessageIds);
  const legacyProof =
    answer.source === "legacy" &&
    (metadata?.leaderThreadRole === "response" ||
      (metadata?.leaderUserMessage === true && metadata.leaderThreadRole == null)) &&
    stringArraysEqual(metadata?.threadResponse?.coveredUserMessageIds ?? [], answer.referencedUserMessageIds);
  if (
    message.role !== "assistant" ||
    (!explicitProof && !legacyProof) ||
    metadata?.codexSubagent ||
    message.parentToolUseId != null
  ) {
    return false;
  }
  if (!Number.isInteger(message.historyIndex) || message.historyIndex !== answer.currentHistoryIndex) return false;
  return leaderResponseExactAnswerThreadKey(metadata ?? {}) === normalizeThreadKey(answer.threadKey);
}

function collectQuestQuizGroups(
  sections: readonly FeedSection[],
  cutoverHistoryIndex: number,
): ThreadResponseQuizGroup[] {
  const groups: ThreadResponseQuizGroup[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const turn of section.turns) {
      const questIds: string[] = [];
      for (const entry of presentationEntries(turn)) {
        if (
          entry.kind !== "message" ||
          entry.msg.role !== "assistant" ||
          !Number.isInteger(entry.msg.historyIndex) ||
          entry.msg.historyIndex! < cutoverHistoryIndex
        )
          continue;
        for (const questId of extractQuestQuizMarkerIds(getAssistantVisibleMarkdown(entry.msg))) {
          if (seen.has(questId)) continue;
          seen.add(questId);
          questIds.push(questId);
        }
      }
      // Ready collapse may relocate current responses to their covered prompt, but a Quiz
      // remains owned by the turn that actually carried its hidden directive.
      if (questIds.length > 0) groups.push({ hostTurnId: turn.id, questIds });
    }
  }
  return groups;
}

function entryHistoryIndex(entry: FeedEntry | null | undefined): number | null {
  return entry?.kind === "message" && Number.isInteger(entry.msg.historyIndex) ? entry.msg.historyIndex! : null;
}

function alignOverlappingAnswerAnchors(responses: CurrentThreadResponsePresentationItem[]): void {
  const parents = responses.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  const firstResponseByPrompt = new Map<string, number>();
  responses.forEach((item, index) => {
    for (const messageId of item.response.referencedUserMessageIds) {
      const first = firstResponseByPrompt.get(messageId);
      if (first === undefined) firstResponseByPrompt.set(messageId, index);
      else union(index, first);
    }
  });

  const latestAnchorByRoot = new Map<number, CurrentThreadResponsePresentationItem>();
  responses.forEach((item, index) => {
    const root = find(index);
    const latest = latestAnchorByRoot.get(root);
    if (!latest || item.anchorOrder > latest.anchorOrder) latestAnchorByRoot.set(root, item);
  });
  responses.forEach((item, index) => {
    const anchor = latestAnchorByRoot.get(find(index));
    if (!anchor) return;
    item.anchorUserMessageId = anchor.anchorUserMessageId;
    item.anchorTurnId = anchor.anchorTurnId;
    item.anchorOrder = anchor.anchorOrder;
  });
}

export function threadResponsePresentationTouchesTurn(turn: Turn, presentation: ThreadResponsePresentation): boolean {
  return (
    presentation.currentResponses.some((item) => item.anchorTurnId === turn.id || item.sourceTurnId === turn.id) ||
    presentation.quizGroups.some((group) => group.hostTurnId === turn.id)
  );
}

export function readyThreadResponseAppliesToTurn(turn: Turn, presentation: ThreadResponsePresentation): boolean {
  const boundaryHistoryIndex = entryHistoryIndex(turn.userEntry);
  if (boundaryHistoryIndex != null) return boundaryHistoryIndex >= presentation.cutoverHistoryIndex;

  const messageHistoryIndexes = turn.allEntries
    .map((entry) => entryHistoryIndex(entry))
    .filter((historyIndex): historyIndex is number => historyIndex != null);
  const firstMessageHistoryIndex = messageHistoryIndexes.length > 0 ? Math.min(...messageHistoryIndexes) : null;
  return firstMessageHistoryIndex != null && firstMessageHistoryIndex >= presentation.cutoverHistoryIndex;
}

export function resolveThreadResponses(
  sections: readonly FeedSection[],
  state: LeaderThreadResponseProjection | null | undefined,
  threadKey: string,
  enabled = true,
  proofMessages: readonly ChatMessage[] = [],
): ThreadResponsePresentation | null {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  if (!enabled || normalizedThreadKey === "all") return null;
  if (
    !state ||
    !Number.isInteger(state.cutoverHistoryIndex) ||
    state.cutoverHistoryIndex < 0 ||
    normalizeThreadKey(state.threadKey) !== normalizedThreadKey ||
    state.currentAnswers.length === 0
  ) {
    return null;
  }

  if (state.ready !== (state.pendingMessageCount === 0)) return null;
  const projectedUserMessageIds = new Map<string, string>();
  let conflictingProjectedUserMessageId = false;
  const registerProjectedUserMessageId = (historyMessageId: string, userMessageId: string) => {
    const existing = projectedUserMessageIds.get(historyMessageId);
    if (existing && existing !== userMessageId) conflictingProjectedUserMessageId = true;
    else projectedUserMessageIds.set(historyMessageId, userMessageId);
  };
  for (const pending of state.pendingMessages) {
    registerProjectedUserMessageId(pending.historyMessageId, pending.userMessageId);
  }
  for (const response of state.currentAnswers) {
    if (response.referencedUserMessageIds.length !== response.answerUserMessageIds.length) return null;
    response.referencedUserMessageIds.forEach((historyMessageId, index) => {
      registerProjectedUserMessageId(historyMessageId, response.answerUserMessageIds[index]!);
    });
  }
  if (conflictingProjectedUserMessageId) return null;

  const directUsers = new Map<
    string,
    {
      turnId: string;
      order: number;
      historyIndex: number;
      userMessageId: string;
      ownerThreadKey: string;
      message: ChatMessage;
    }
  >();
  const visibleOwnedDirectUserIds = new Set<string>();
  const seenVisibleDirectUserIds = new Set<string>();
  let duplicateVisibleDirectUser = false;
  let invalidVisibleDirectUser = false;
  const responseEntries = new Map<
    string,
    { turnId: string; order: number; entry: Extract<FeedEntry, { kind: "message" }> }
  >();
  const duplicateResponseEntryIds = new Set<string>();
  let order = 0;
  for (const section of sections) {
    for (const turn of section.turns) {
      if (isUserBoundaryEntry(turn.userEntry) && turn.userEntry?.kind === "message") {
        const userMessage = turn.userEntry.msg;
        const ownerThreadKey = leaderResponseProvenCurrentOwnerThreadKey(userMessage.metadata ?? {});
        const projectedUserMessageId = projectedUserMessageIds.get(userMessage.id);
        const persistedUserMessageId = userMessage.metadata?.leaderUserMessageId;
        if (userMessage.metadata?.leaderResponseCoverageVersion === 1 && ownerThreadKey) {
          if (ownerThreadKey === normalizedThreadKey) visibleOwnedDirectUserIds.add(userMessage.id);
          if (!leaderResponseMessageIsAssociatedWithThread(userMessage.metadata, normalizedThreadKey)) continue;

          if (seenVisibleDirectUserIds.has(userMessage.id)) duplicateVisibleDirectUser = true;
          seenVisibleDirectUserIds.add(userMessage.id);
          if (persistedUserMessageId && projectedUserMessageId && persistedUserMessageId !== projectedUserMessageId) {
            invalidVisibleDirectUser = true;
          }
          const userMessageId = persistedUserMessageId ?? projectedUserMessageId;
          if (typeof userMessageId === "string" && typeof userMessage.historyIndex === "number") {
            directUsers.set(userMessage.id, {
              turnId: turn.id,
              order,
              historyIndex: userMessage.historyIndex,
              userMessageId,
              ownerThreadKey,
              message: userMessage,
            });
          }
        }
      }
      for (const entry of presentationEntries(turn)) {
        if (entry.kind !== "message") continue;
        if (responseEntries.has(entry.msg.id)) duplicateResponseEntryIds.add(entry.msg.id);
        responseEntries.set(entry.msg.id, { turnId: turn.id, order, entry });
      }
      order += 1;
    }
  }

  if (duplicateVisibleDirectUser || invalidVisibleDirectUser) return null;

  // The server may include every original prompt as bounded proof, while only
  // prompts associated with this tab belong in its visible conversation.
  const referencedUsers = new Map<
    string,
    { historyIndex: number; userMessageId: string; ownerThreadKey: string; message: ChatMessage }
  >(directUsers);
  const seenProofIds = new Set<string>();
  for (const message of proofMessages) {
    if (!projectedUserMessageIds.has(message.id)) continue;
    if (seenProofIds.has(message.id)) return null;
    seenProofIds.add(message.id);
    const ownerThreadKey = leaderResponseProvenCurrentOwnerThreadKey(message.metadata ?? {});
    const projectedId = projectedUserMessageIds.get(message.id)!;
    if (
      message.role !== "user" ||
      message.agentSource != null ||
      message.metadata?.codexSubagent ||
      message.parentToolUseId != null ||
      message.metadata?.leaderResponseCoverageVersion !== 1 ||
      !Number.isInteger(message.historyIndex) ||
      !ownerThreadKey ||
      (message.metadata.leaderUserMessageId && message.metadata.leaderUserMessageId !== projectedId)
    )
      return null;
    const existing = referencedUsers.get(message.id);
    if (
      existing &&
      (existing.historyIndex !== message.historyIndex ||
        existing.ownerThreadKey !== ownerThreadKey ||
        existing.userMessageId !== projectedId)
    )
      return null;
    referencedUsers.set(message.id, {
      historyIndex: message.historyIndex!,
      userMessageId: projectedId,
      ownerThreadKey,
      message,
    });
  }

  const pendingIds = new Set<string>();
  const pendingAnswerIds = new Set<string>();
  for (const pending of state.pendingMessages) {
    const directUser = directUsers.get(pending.historyMessageId);
    if (
      pendingIds.has(pending.historyMessageId) ||
      pendingAnswerIds.has(pending.userMessageId) ||
      !directUser ||
      directUser.ownerThreadKey !== normalizedThreadKey ||
      directUser.userMessageId !== pending.userMessageId
    ) {
      return null;
    }
    pendingIds.add(pending.historyMessageId);
    pendingAnswerIds.add(pending.userMessageId);
  }
  if (state.pendingMessages.length !== state.pendingMessageCount) return null;

  const coveredIds = new Set<string>();
  const seenResponseMessageIds = new Set<string>();
  const seenResponseHistoryIndexes = new Set<number>();
  const currentResponses: CurrentThreadResponsePresentationItem[] = [];
  for (const response of state.currentAnswers) {
    const responseThreadKey = normalizeThreadKey(response.threadKey);
    const associationProjection = responseThreadKey !== normalizedThreadKey;
    if (
      (responseThreadKey !== "main" && !/^q-\d+$/.test(responseThreadKey)) ||
      (associationProjection && response.source !== "explicit") ||
      response.referencedUserMessageIds.length === 0 ||
      response.referencedUserMessageIds.length !== response.answerUserMessageIds.length ||
      response.coveredUserMessageIds.length !== response.coveredAnswerUserMessageIds.length ||
      (response.coveredUserMessageIds.length === 0 && response.source !== "explicit") ||
      new Set(response.referencedUserMessageIds).size !== response.referencedUserMessageIds.length ||
      new Set(response.coveredUserMessageIds).size !== response.coveredUserMessageIds.length ||
      response.coveredUserMessageIds.some((messageId) => !response.referencedUserMessageIds.includes(messageId)) ||
      seenResponseMessageIds.has(response.currentMessageId) ||
      seenResponseHistoryIndexes.has(response.currentHistoryIndex) ||
      duplicateResponseEntryIds.has(response.currentMessageId)
    ) {
      return null;
    }
    seenResponseMessageIds.add(response.currentMessageId);
    seenResponseHistoryIndexes.add(response.currentHistoryIndex);
    const located = responseEntries.get(response.currentMessageId);
    if (!located || !isAuthoritativeCurrentResponseMessage(located.entry.msg, response)) return null;

    const answerMetadata = located.entry.msg.metadata?.threadAnswer;
    const ownerThreadKeys = leaderResponseAnswerOwnerThreadKeys(
      answerMetadata ?? { answerUserMessageIds: response.answerUserMessageIds },
      responseThreadKey,
    );
    if (!ownerThreadKeys) return null;
    const referencedAnchors = response.referencedUserMessageIds.map((messageId) => referencedUsers.get(messageId));
    if (
      referencedAnchors.some(
        (anchor, index) =>
          !anchor ||
          anchor.historyIndex < state.cutoverHistoryIndex ||
          anchor.ownerThreadKey !== ownerThreadKeys.get(response.answerUserMessageIds[index]!) ||
          anchor.userMessageId !== response.answerUserMessageIds[index],
      )
    ) {
      return null;
    }
    if (!answerMetadata?.ownerGroups)
      for (let index = 1; index < referencedAnchors.length; index += 1) {
        if (referencedAnchors[index - 1]!.historyIndex >= referencedAnchors[index]!.historyIndex) return null;
      }
    const visibleAnchors = response.referencedUserMessageIds.flatMap((messageId) => {
      const anchor = directUsers.get(messageId);
      return anchor ? [anchor] : [];
    });
    const authoredThreadKey = answerMetadata?.authoredThreadKey ?? responseThreadKey;
    if (visibleAnchors.length === 0 && authoredThreadKey !== normalizedThreadKey) return null;
    const coverageAnchors = response.coveredUserMessageIds.map((messageId) => directUsers.get(messageId));
    if (
      coverageAnchors.some(
        (anchor, index) =>
          !anchor ||
          anchor.historyIndex < state.cutoverHistoryIndex ||
          anchor.ownerThreadKey !== normalizedThreadKey ||
          anchor.userMessageId !== response.coveredAnswerUserMessageIds[index],
      )
    ) {
      return null;
    }
    if (!answerMetadata?.ownerGroups)
      for (let index = 1; index < coverageAnchors.length; index += 1) {
        if (coverageAnchors[index - 1]!.order >= coverageAnchors[index]!.order) return null;
      }
    for (const messageId of response.coveredUserMessageIds) {
      if (coveredIds.has(messageId) || pendingIds.has(messageId)) return null;
      coveredIds.add(messageId);
    }
    const lastAnchor = visibleAnchors.reduce<(typeof visibleAnchors)[number] | undefined>(
      (latest, anchor) => (!latest || anchor.order > latest.order ? anchor : latest),
      undefined,
    );
    currentResponses.push({
      response,
      anchorUserMessageId: lastAnchor?.message.id ?? located.turnId,
      anchorTurnId: lastAnchor?.turnId ?? located.turnId,
      anchorOrder: lastAnchor?.order ?? located.order,
      sourceTurnId: located.turnId,
      messageEntry: located.entry,
      collapsedMessageEntry: collapsedResponseEntry(located.entry),
      referencedUserMessages: referencedAnchors.map((anchor) => {
        const attachmentCount = Math.max(anchor!.message.images?.length ?? 0, anchor!.message.localImages?.length ?? 0);
        return {
          historyMessageId: anchor!.message.id,
          userMessageId: anchor!.userMessageId,
          content: anchor!.message.content,
          ...(attachmentCount > 0 ? { attachmentCount } : {}),
        };
      }),
    });
  }

  for (const messageId of visibleOwnedDirectUserIds) {
    if (!coveredIds.has(messageId) && !pendingIds.has(messageId)) return null;
  }

  // Answers sharing any original prompt form one visible answer set. Anchor
  // that set after its latest prompt so the rows can stay in source chronology
  // even when later per-ID coverage points back to an earlier prompt.
  alignOverlappingAnswerAnchors(currentResponses);
  currentResponses.sort(
    (left, right) =>
      left.anchorOrder - right.anchorOrder || left.response.currentHistoryIndex - right.response.currentHistoryIndex,
  );
  const quizGroups = collectQuestQuizGroups(sections, state.cutoverHistoryIndex);
  const pendingSignature = state.pendingMessages
    .map((pending) => `${pending.userMessageId}:${pending.historyMessageId}:${pending.historyIndex}`)
    .join("|");
  const responseSignature = currentResponses
    .map(
      ({ response }) =>
        `${response.currentMessageId}:${response.threadKey}:${response.answerUserMessageIds.join(",")}:${response.coveredAnswerUserMessageIds.join(",")}:${response.source}`,
    )
    .join("|");

  const quizSignature = quizGroups.map((group) => `${group.hostTurnId}:${group.questIds.join(",")}`).join("|");

  return {
    ready: state.ready,
    cutoverHistoryIndex: state.cutoverHistoryIndex,
    pendingMessageCount: state.pendingMessageCount,
    currentResponses,
    currentResponseMessageIds: new Set(currentResponses.map(({ response }) => response.currentMessageId)),
    quizGroups,
    layoutSignature: `${state.cutoverHistoryIndex}:${state.ready ? "ready" : "active"}:${state.pendingMessageCount}:${responseSignature}:${pendingSignature}:${quizSignature}`,
  };
}
