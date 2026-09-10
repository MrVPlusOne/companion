import {
  hasQuestReviewMetadata,
  type QuestCreateInput,
  type QuestDone,
  type QuestIdea,
  type QuestInProgress,
  type QuestInvocationProvenance,
  type QuestmasterTask,
  type QuestOwnerKind,
  type QuestOwnerRef,
  type QuestOwnershipEventDraft,
  type QuestRefined,
  type QuestTransitionInput,
} from "./quest-types.js";
import { getName } from "./session-names.js";
import { normalizeTldr } from "./quest-tldr.js";
import { normalizeQuestQuizItems } from "./quest-quiz.js";
import {
  commitShaField,
  currentCommitShaFields,
  getLeaderSessionId,
  nextVersionId,
  normalizeCommitShas,
  normalizeVerificationItems,
} from "./quest-store-helpers.js";
import { normalizeQuestRelationships } from "./quest-relationships.js";
import { appendOwnershipEvent, archivedOwnerTakeoverEvent } from "./quest-ownership.js";
import { appendQuestRecoveryEvent } from "./quest-recovery.js";
import { normalizeQuestCodeCommitEvidenceReplacementEvents } from "./quest-code-commit-evidence.js";
import { normalizeQuestSessionSpaceSlug } from "./quest-session-space.js";
import { normalizeLiveQuest } from "./quest-store-normalize.js";
import {
  getPreviousQuestOwners,
  getQuestOwner,
  normalizeQuestOwnerRef,
  sameQuestOwner,
} from "../shared/quest-owner.js";

export type QuestClaimOptions = {
  allowArchivedOwnerTakeover?: boolean;
  force?: boolean;
  isSessionArchived?: (sessionId: string) => boolean;
  leaderSessionId?: string;
  ownerKind?: QuestOwnerKind;
  ownershipEvent?: QuestOwnershipEventDraft;
  provenance?: QuestInvocationProvenance;
};

/** Build a new Quest record without performing persistence. */
export function buildCreatedQuest(
  questId: string,
  input: QuestCreateInput,
  liveStore: boolean,
  now = Date.now(),
): QuestmasterTask {
  const status = input.status || "idea";
  const tldr = normalizeTldr(input.tldr);
  const quizItems = normalizeQuestQuizItems(input.quizItems);
  const base = {
    id: liveStore ? questId : `${questId}-v1`,
    questId,
    version: 1,
    title: input.title.trim(),
    ...(input.createdBy ? { createdBy: input.createdBy, lastModifiedBy: input.createdBy } : {}),
    ...(tldr ? { tldr } : {}),
    createdAt: now,
    ...(liveStore ? { statusChangedAt: now } : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(normalizeQuestSessionSpaceSlug(input.sessionSpaceSlug)
      ? { sessionSpaceSlug: normalizeQuestSessionSpaceSlug(input.sessionSpaceSlug) }
      : {}),
    ...(normalizeQuestRelationships(input.relationships, questId)
      ? { relationships: normalizeQuestRelationships(input.relationships, questId) }
      : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(quizItems ? { quizItems } : {}),
  };

  switch (status) {
    case "idea":
      return liveStore
        ? normalizeLiveQuest({
            ...base,
            status: "idea",
            ...(input.description ? { description: input.description } : {}),
          } as QuestIdea)
        : ({
            ...base,
            status: "idea",
            ...(input.description ? { description: input.description } : {}),
          } as QuestIdea);
    case "refined":
      if (!input.description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      return liveStore
        ? normalizeLiveQuest({
            ...base,
            status: "refined",
            description: input.description,
          } as QuestRefined)
        : ({
            ...base,
            status: "refined",
            description: input.description,
          } as QuestRefined);
    default:
      throw new Error(`Cannot create a quest directly in "${status}" status`);
  }
}

/** Build a transitioned Quest record while preserving ownership history and metadata. */
export function buildTransitionedQuest(
  current: QuestmasterTask,
  input: QuestTransitionInput,
  options: { liveStore: boolean; now?: number },
): QuestmasterTask {
  const targetStatus = input.status;
  const liveStore = options.liveStore;

  if (
    targetStatus === current.status &&
    input.lastModifiedBy === undefined &&
    !input.description &&
    !input.sessionId &&
    input.ownerKind === undefined &&
    !input.verificationItems &&
    !input.commitShas &&
    !input.memoryCommitShas &&
    input.relationships === undefined &&
    !input.notes &&
    input.debrief === undefined &&
    input.debriefTldr === undefined &&
    !input.cancelled &&
    !(targetStatus === "done" && hasQuestReviewMetadata(current)) &&
    input.tldr === undefined &&
    input.ownershipEvent === undefined &&
    input.recoveryEvent === undefined
  ) {
    return current;
  }

  const now = options.now ?? Date.now();
  const newVersion = current.version + 1;
  const tldr = input.tldr !== undefined ? normalizeTldr(input.tldr) : normalizeTldr(current.tldr);
  const currentFeedback = current.feedback;
  const currentJourneyRuns = current.journeyRuns;
  const currentQuizItems = normalizeQuestQuizItems(current.quizItems);
  const inputQuizItems = normalizeQuestQuizItems(input.quizItems);
  const quizItems = inputQuizItems ?? currentQuizItems;
  const currentActiveOwner = getQuestOwner(current);
  const previousOwners = getPreviousQuestOwners(current);
  const retainCanonicalHistory = Array.isArray(current.previousOwners);
  const ownershipEvents = appendOwnershipEvent(current.ownershipEvents, input.ownershipEvent, now);
  const recoveryEvents = appendQuestRecoveryEvent(current.recoveryEvents, input.recoveryEvent, now);
  const codeCommitEvidenceReplacementEvents = normalizeQuestCodeCommitEvidenceReplacementEvents(
    current.codeCommitEvidenceReplacementEvents,
  );
  const leaderSessionId = input.leaderSessionId?.trim() || getLeaderSessionId(current);
  const relationships =
    input.relationships !== undefined
      ? normalizeQuestRelationships(input.relationships, current.questId)
      : normalizeQuestRelationships(current.relationships, current.questId);
  const base = {
    id: liveStore ? current.questId : nextVersionId(current.questId, current.version),
    questId: current.questId,
    version: newVersion,
    ...(liveStore ? { statusChangedAt: now, createdAt: current.createdAt } : { prevId: current.id, createdAt: now }),
    ...(liveStore && typeof current.updatedAt === "number" ? { updatedAt: current.updatedAt } : {}),
    ...(current.createdBy ? { createdBy: current.createdBy } : {}),
    ...((input.lastModifiedBy ?? current.lastModifiedBy)
      ? { lastModifiedBy: input.lastModifiedBy ?? current.lastModifiedBy }
      : {}),
    title: current.title,
    ...(tldr ? { tldr } : {}),
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.sessionSpaceSlug ? { sessionSpaceSlug: current.sessionSpaceSlug } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
    ...(leaderSessionId ? { leaderSessionId } : {}),
    ...currentCommitShaFields(current),
    ...(current.codeDeliveries?.length ? { codeDeliveries: current.codeDeliveries } : {}),
    ...(current.deliveryTargetApprovals?.length ? { deliveryTargetApprovals: current.deliveryTargetApprovals } : {}),
    ...(relationships ? { relationships } : {}),
    ...(ownershipEvents?.length ? { ownershipEvents } : {}),
    ...(recoveryEvents?.length ? { recoveryEvents } : {}),
    ...(codeCommitEvidenceReplacementEvents.length > 0 ? { codeCommitEvidenceReplacementEvents } : {}),
    ...(currentJourneyRuns?.length ? { journeyRuns: currentJourneyRuns } : {}),
    ...(quizItems ? { quizItems } : {}),
    ...(Object.prototype.hasOwnProperty.call(current, "outcome") ? { outcome: current.outcome } : {}),
    ...(currentFeedback?.length ? { feedback: currentFeedback } : {}),
  };
  if ((input.commitShas !== undefined || input.memoryCommitShas !== undefined) && targetStatus !== "done") {
    throw new Error("commit SHAs can only be set when completing a quest");
  }
  const inputCommitShas =
    input.commitShas && input.commitShas.length > 0 ? normalizeCommitShas(input.commitShas) : undefined;
  const inputMemoryCommitShas =
    input.memoryCommitShas && input.memoryCommitShas.length > 0
      ? normalizeCommitShas(input.memoryCommitShas)
      : undefined;

  let quest: QuestmasterTask;
  switch (targetStatus) {
    case "idea": {
      appendQuestOwner(previousOwners, currentActiveOwner);
      quest = {
        ...base,
        status: "idea",
        ...previousQuestOwnerFields(previousOwners, retainCanonicalHistory),
        ...("description" in current && current.description ? { description: current.description } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      } as QuestIdea;
      break;
    }
    case "refined": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for refined status");
      }
      appendQuestOwner(previousOwners, currentActiveOwner);
      quest = {
        ...base,
        status: "refined",
        description,
        ...previousQuestOwnerFields(previousOwners, retainCanonicalHistory),
      } as QuestRefined;
      break;
    }
    case "in_progress": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for in_progress status");
      }
      const requestedSessionId = input.sessionId ?? currentActiveOwner?.sessionId;
      const requestedOwnerKind =
        input.ownerKind ?? (input.sessionId ? "takode" : (currentActiveOwner?.kind ?? "takode"));
      const nextOwner = normalizeQuestOwnerRef({ kind: requestedOwnerKind, sessionId: requestedSessionId });
      if (!nextOwner) {
        throw new Error("sessionId is required for in_progress status");
      }
      if (currentActiveOwner && currentActiveOwner.kind !== nextOwner.kind) {
        throw new Error("Cross-provider quest takeover is not supported");
      }
      if (!sameQuestOwner(currentActiveOwner, nextOwner)) appendQuestOwner(previousOwners, currentActiveOwner);
      const nextPreviousOwners = previousOwners.filter((owner) => !sameQuestOwner(owner, nextOwner));
      quest = {
        ...base,
        status: "in_progress",
        description,
        ...activeQuestOwnerFields(nextOwner),
        claimedAt: now,
        ...previousQuestOwnerFields(nextPreviousOwners, retainCanonicalHistory),
      } as QuestInProgress;
      break;
    }
    case "done": {
      const description = input.description ?? ("description" in current ? current.description : undefined);
      if (!description?.trim()) {
        throw new Error("Description is required for done status");
      }
      if (input.cancelled && (input.debrief !== undefined || input.debriefTldr !== undefined)) {
        throw new Error("Final debrief metadata is only supported for completed quests, not cancelled quests");
      }
      const currentDebrief = current.status === "done" && !input.cancelled ? (current as QuestDone).debrief : undefined;
      const debrief = input.debrief !== undefined && !input.cancelled ? input.debrief.trim() : currentDebrief;
      const notes =
        input.notes ?? (current.status === "done" && !input.cancelled ? (current as QuestDone).notes : undefined);
      const debriefTldr = input.cancelled
        ? undefined
        : input.debriefTldr !== undefined
          ? normalizeTldr(input.debriefTldr)
          : current.status === "done"
            ? normalizeTldr((current as QuestDone).debriefTldr)
            : undefined;
      const completedOwner =
        currentActiveOwner ?? normalizeQuestOwnerRef({ kind: input.ownerKind ?? "takode", sessionId: input.sessionId });
      appendQuestOwner(previousOwners, completedOwner);
      const rawItems =
        input.verificationItems ??
        ("verificationItems" in current ? (current as QuestDone).verificationItems : undefined);
      const verificationItems = rawItems && rawItems.length > 0 ? normalizeVerificationItems(rawItems) : [];
      quest = {
        ...base,
        status: "done",
        description,
        claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
        verificationItems,
        ...previousQuestOwnerFields(previousOwners, retainCanonicalHistory),
        ...commitShaField("commitShas", current.commitShas, inputCommitShas),
        ...commitShaField("memoryCommitShas", current.memoryCommitShas, inputMemoryCommitShas),
        completedAt: now,
        ...(input.verificationInboxUnread !== undefined
          ? { verificationInboxUnread: input.verificationInboxUnread }
          : {}),
        ...(notes ? { notes } : {}),
        ...(debrief ? { debrief } : {}),
        ...(debriefTldr ? { debriefTldr } : {}),
        ...(input.cancelled ? { cancelled: true } : {}),
      } as QuestDone;
      break;
    }
    default:
      throw new Error(`Unknown status: ${targetStatus}`);
  }

  return liveStore ? normalizeLiveQuest(quest) : quest;
}

/** Build a cancelled Quest record without performing persistence. */
export function buildCancelledQuest(
  current: QuestmasterTask,
  notes: string | undefined,
  liveStore: boolean,
  provenance?: QuestInvocationProvenance,
): QuestDone {
  const now = Date.now();
  const description = "description" in current ? current.description : undefined;
  const tldr = normalizeTldr(current.tldr);
  const currentActiveOwner = getQuestOwner(current);
  const previousOwners = getPreviousQuestOwners(current);
  const retainCanonicalHistory = Array.isArray(current.previousOwners);
  const leaderSessionId = getLeaderSessionId(current);
  const ownershipEvents = appendOwnershipEvent(current.ownershipEvents, undefined, now);
  const codeCommitEvidenceReplacementEvents = normalizeQuestCodeCommitEvidenceReplacementEvents(
    current.codeCommitEvidenceReplacementEvents,
  );
  appendQuestOwner(previousOwners, currentActiveOwner);
  const cancelFeedback = current.feedback;
  const cancelJourneyRuns = current.journeyRuns;
  const cancelQuizItems = normalizeQuestQuizItems(current.quizItems);
  const quest: QuestDone = {
    id: liveStore ? current.questId : nextVersionId(current.questId, current.version),
    questId: current.questId,
    version: current.version + 1,
    ...(liveStore
      ? {
          createdAt: current.createdAt,
          statusChangedAt: now,
          ...(typeof current.updatedAt === "number" ? { updatedAt: current.updatedAt } : {}),
        }
      : {
          prevId: current.id,
          createdAt: now,
        }),
    title: current.title,
    ...(current.createdBy ? { createdBy: current.createdBy } : {}),
    ...((provenance ?? current.lastModifiedBy) ? { lastModifiedBy: provenance ?? current.lastModifiedBy } : {}),
    ...(tldr ? { tldr } : {}),
    ...(current.tags?.length ? { tags: current.tags } : {}),
    ...(current.parentId ? { parentId: current.parentId } : {}),
    ...(current.sessionSpaceSlug ? { sessionSpaceSlug: current.sessionSpaceSlug } : {}),
    ...(current.images?.length ? { images: current.images } : {}),
    ...(leaderSessionId ? { leaderSessionId } : {}),
    ...previousQuestOwnerFields(previousOwners, retainCanonicalHistory),
    ...(ownershipEvents?.length ? { ownershipEvents } : {}),
    ...(codeCommitEvidenceReplacementEvents.length > 0 ? { codeCommitEvidenceReplacementEvents } : {}),
    ...(normalizeQuestRelationships(current.relationships, current.questId)
      ? { relationships: normalizeQuestRelationships(current.relationships, current.questId) }
      : {}),
    ...(current.commitShas?.length ? { commitShas: current.commitShas } : {}),
    ...(current.codeDeliveries?.length ? { codeDeliveries: current.codeDeliveries } : {}),
    ...(current.deliveryTargetApprovals?.length ? { deliveryTargetApprovals: current.deliveryTargetApprovals } : {}),
    ...(cancelJourneyRuns?.length ? { journeyRuns: cancelJourneyRuns } : {}),
    ...(cancelQuizItems ? { quizItems: cancelQuizItems } : {}),
    ...(Object.prototype.hasOwnProperty.call(current, "outcome") ? { outcome: current.outcome } : {}),
    status: "done",
    ...(description ? { description } : {}),
    claimedAt: "claimedAt" in current ? (current as QuestInProgress).claimedAt : now,
    verificationItems: "verificationItems" in current ? (current as QuestDone).verificationItems : [],
    completedAt: now,
    cancelled: true,
    ...(notes ? { notes } : {}),
    ...(cancelFeedback?.length ? { feedback: cancelFeedback } : {}),
  } as QuestDone;
  return liveStore ? (normalizeLiveQuest(quest) as QuestDone) : quest;
}

/** Validate and prepare a provider-aware claim transition without writing it. */
export function buildQuestClaimTransitionInput(
  current: QuestmasterTask,
  nextOwner: QuestOwnerRef,
  leaderSessionId: string | undefined,
  options: QuestClaimOptions | undefined,
  existing: QuestmasterTask | null | undefined,
): QuestTransitionInput | null {
  const currentOwner = current.status === "in_progress" ? getQuestOwner(current) : undefined;

  if (sameQuestOwner(currentOwner, nextOwner)) {
    if (!leaderSessionId || getLeaderSessionId(current) === leaderSessionId) return null;
    return {
      status: "in_progress",
      ...activeQuestOwnerFields(nextOwner),
      leaderSessionId,
      ...(options?.provenance ? { lastModifiedBy: options.provenance } : {}),
    };
  }

  let ownershipEvent: QuestOwnershipEventDraft | undefined;
  if (currentOwner) {
    if (currentOwner.kind !== nextOwner.kind) {
      throw new Error(
        `Quest ${current.questId} is already claimed by ${currentOwner.kind} owner ${currentOwner.sessionId}; ` +
          `cross-provider takeover by ${nextOwner.kind} is not supported`,
      );
    }
    const existingSessionId = currentOwner.sessionId;
    const ownerArchived = currentOwner.kind === "takode" && !!options?.isSessionArchived?.(existingSessionId);
    if (options?.allowArchivedOwnerTakeover && ownerArchived) {
      ownershipEvent =
        options.ownershipEvent ??
        archivedOwnerTakeoverEvent({
          actorSessionId: nextOwner.sessionId,
          previousOwnerSessionId: existingSessionId,
          previousLeaderSessionId: getLeaderSessionId(current),
          newLeaderSessionId: leaderSessionId,
        });
    } else if (options?.force) {
      if (!options.ownershipEvent) throw new Error("Ownership takeover audit event is required");
      ownershipEvent = options.ownershipEvent;
    } else {
      const ownerName = currentOwner.kind === "takode" ? getName(existingSessionId) : undefined;
      const ownerLabel = ownerName ? `"${ownerName}" (${existingSessionId.slice(0, 8)})` : existingSessionId;
      throw new Error(`Quest ${current.questId} is already claimed by session ${ownerLabel}`);
    }
  }

  if (existing && existing.questId !== current.questId) {
    throw new Error(
      `Session already has an active quest: ${existing.questId} "${existing.title}". ` +
        `Complete or transition it before claiming another.`,
    );
  }

  return {
    status: "in_progress",
    ...activeQuestOwnerFields(nextOwner),
    ...(options?.provenance ? { lastModifiedBy: options.provenance } : {}),
    ...(leaderSessionId ? { leaderSessionId } : {}),
    ...(ownershipEvent ? { ownershipEvent } : {}),
  };
}

/** Reject a mutation when another provider-aware owner currently holds the Quest. */
export function assertQuestMutationOwner(
  quest: QuestmasterTask,
  requestedOwner: QuestOwnerRef,
  action: "cancel" | "edit",
): void {
  const activeOwner = quest.status === "in_progress" ? getQuestOwner(quest) : undefined;
  if (!activeOwner || sameQuestOwner(activeOwner, requestedOwner)) return;
  throw new Error(
    `Quest ${quest.questId} is owned by ${activeOwner.kind} owner ${activeOwner.sessionId}; ` +
      `${requestedOwner.kind} owner ${requestedOwner.sessionId} cannot ${action} it`,
  );
}

function activeQuestOwnerFields(owner: QuestOwnerRef): { sessionId: string; ownerKind?: "codex" } {
  return {
    sessionId: owner.sessionId,
    ...(owner.kind === "codex" ? { ownerKind: "codex" as const } : {}),
  };
}

function appendQuestOwner(owners: QuestOwnerRef[], owner: QuestOwnerRef | undefined): void {
  if (!owner || owners.some((candidate) => sameQuestOwner(candidate, owner))) return;
  owners.push(owner);
}

function previousQuestOwnerFields(
  owners: QuestOwnerRef[],
  retainCanonicalHistory: boolean,
): { previousOwnerSessionIds?: string[]; previousOwners?: QuestOwnerRef[] } {
  const takodeSessionIds = owners.filter((owner) => owner.kind === "takode").map((owner) => owner.sessionId);
  const useCanonicalHistory = retainCanonicalHistory || owners.some((owner) => owner.kind === "codex");
  return {
    ...(takodeSessionIds.length ? { previousOwnerSessionIds: takodeSessionIds } : {}),
    ...(useCanonicalHistory && owners.length ? { previousOwners: owners } : {}),
  };
}
