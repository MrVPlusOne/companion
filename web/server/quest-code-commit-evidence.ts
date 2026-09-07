import type {
  QuestCodeCommitEvidenceReplacementEvent,
  QuestCodeCommitEvidenceReplacementEventDraft,
} from "./quest-types.js";
import {
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS,
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH,
} from "../shared/quest-code-commit-evidence.js";
import { normalizeCommitShas } from "./quest-store-helpers.js";

export function appendQuestCodeCommitEvidenceReplacementEvent(
  existing: readonly QuestCodeCommitEvidenceReplacementEvent[] | undefined,
  input: QuestCodeCommitEvidenceReplacementEventDraft,
  now: number,
): QuestCodeCommitEvidenceReplacementEvent[] {
  const normalizedExisting = normalizeQuestCodeCommitEvidenceReplacementEvents(existing);
  const event = normalizeQuestCodeCommitEvidenceReplacementEvent({ ...input, ts: now });
  if (!event) throw new Error("Invalid code commit evidence replacement audit event");
  return [...normalizedExisting, event];
}

export function normalizeQuestCodeCommitEvidenceReplacementEvents(
  raw: unknown,
): QuestCodeCommitEvidenceReplacementEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: QuestCodeCommitEvidenceReplacementEvent[] = [];
  for (const value of raw) {
    const event = normalizeQuestCodeCommitEvidenceReplacementEvent(value);
    if (event) events.push(event);
  }
  return events;
}

function normalizeQuestCodeCommitEvidenceReplacementEvent(
  raw: unknown,
): QuestCodeCommitEvidenceReplacementEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<QuestCodeCommitEvidenceReplacementEvent>;
  if (value.operation !== "replace_code_commit_evidence") return null;

  const actorSessionId = nonemptyString(value.actorSessionId);
  const reason = nonemptyString(value.reason);
  const journeyRunId = nonemptyString(value.journeyRunId);
  const phaseOccurrenceId = nonemptyString(value.phaseOccurrenceId);
  const verifiedTargetBranch = nonemptyString(value.verifiedTargetBranch);
  const verifiedTargetHeadSha = fullCommitSha(value.verifiedTargetHeadSha);
  const ts = typeof value.ts === "number" && Number.isFinite(value.ts) && value.ts > 0 ? value.ts : undefined;
  const previousCommitShas = commitShaList(value.previousCommitShas);
  const replacementCommitShas = commitShaList(value.replacementCommitShas);

  if (
    !actorSessionId ||
    !reason ||
    reason.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH ||
    !journeyRunId ||
    !phaseOccurrenceId ||
    !verifiedTargetBranch ||
    !verifiedTargetHeadSha ||
    !ts ||
    !previousCommitShas?.length ||
    !replacementCommitShas?.length ||
    previousCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS ||
    replacementCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS ||
    replacementCommitShas.length < previousCommitShas.length ||
    orderedStringListsEqual(previousCommitShas, replacementCommitShas)
  ) {
    return null;
  }

  return {
    operation: "replace_code_commit_evidence",
    actorSessionId,
    reason,
    previousCommitShas,
    replacementCommitShas,
    journeyRunId,
    phaseOccurrenceId,
    verifiedTargetBranch,
    verifiedTargetHeadSha,
    ts,
  };
}

function commitShaList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return normalizeCommitShas(value);
  } catch {
    return null;
  }
}

function fullCommitSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sha = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function orderedStringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
