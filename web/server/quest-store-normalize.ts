import type { QuestmasterTask } from "./quest-types.js";
import { normalizeQuestQuizItems } from "./quest-quiz.js";
import { normalizeQuestCodeCommitEvidenceReplacementEvents } from "./quest-code-commit-evidence.js";
import { normalizeQuestRecoveryEvents } from "./quest-recovery.js";
import { normalizeQuestOwnership } from "./quest-store-helpers.js";
import { normalizeQuestRelationships, stripDerivedQuestRelationships } from "./quest-relationships.js";

export function normalizeLiveQuest(quest: QuestmasterTask): QuestmasterTask {
  const normalized = normalizeQuestOwnership(stripDerivedQuestRelationships({ ...quest })) as QuestmasterTask & {
    id: string;
    createdAt: number;
    questId: string;
    prevId?: string;
    statusChangedAt?: number;
    version: number;
  };
  normalized.id = normalized.questId;
  delete normalized.prevId;
  normalized.createdAt = normalized.createdAt || Date.now();
  normalized.version = Number.isInteger(normalized.version) && normalized.version > 0 ? normalized.version : 1;
  normalized.statusChangedAt =
    typeof normalized.statusChangedAt === "number" && normalized.statusChangedAt > 0
      ? normalized.statusChangedAt
      : normalized.createdAt;
  const relationships = normalizeQuestRelationships(normalized.relationships, normalized.questId);
  if (relationships) normalized.relationships = relationships;
  else delete normalized.relationships;
  const quizItems = normalizeQuestQuizItems(normalized.quizItems);
  if (quizItems) normalized.quizItems = quizItems;
  else delete normalized.quizItems;
  const recoveryEvents = normalizeQuestRecoveryEvents((normalized as { recoveryEvents?: unknown }).recoveryEvents);
  if (recoveryEvents.length > 0) normalized.recoveryEvents = recoveryEvents;
  else delete normalized.recoveryEvents;
  const codeCommitEvidenceReplacementEvents = normalizeQuestCodeCommitEvidenceReplacementEvents(
    (normalized as { codeCommitEvidenceReplacementEvents?: unknown }).codeCommitEvidenceReplacementEvents,
  );
  if (codeCommitEvidenceReplacementEvents.length > 0) {
    normalized.codeCommitEvidenceReplacementEvents = codeCommitEvidenceReplacementEvents;
  } else {
    delete normalized.codeCommitEvidenceReplacementEvents;
  }
  return normalized;
}
