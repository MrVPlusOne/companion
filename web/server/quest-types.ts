import type { QuestCodeDelivery, QuestDeliveryTargetApproval } from "../shared/quest-delivery.js";
// ─── Questmaster Types ───────────────────────────────────────────────────────
//
// Progressive types: each stage extends the previous, strictly adding fields
// where practical.
//
// Legacy quest storage persisted a full version chain on disk (`q-1-v1.json`,
// `q-1-v2.json`, ...). The newer live store keeps only one mutable current
// record per quest on the hot path, but it preserves the latest revision-shaped
// `id`/`version` fields for compatibility with existing UI and CLI code.
//
// ─── Quest ownership model ───────────────────────────────────────────────────
//
// A session can own any number of quests across all statuses, but at most ONE
// quest may be `in_progress` per session at a time. This invariant is enforced
// by claimQuest() in quest-store.ts — attempting to claim a second quest while
// one is already in_progress throws an error. The rationale:
//
//   - The UI and auto-namer show the active quest's metadata (title, ID).
//     Multiple concurrent in_progress quests would create ambiguity about
//     which one to display.
//   - getActiveQuestForSession(sessionId) returns the single in_progress quest
//     for a session, or null. It's used by the auto-namer to include quest
//     context in naming prompts.
//   - Quests in other states (done, refined, idea) are
//     unaffected — a session can have any number of those.

import type { QuestJourneyPhaseId } from "../shared/quest-journey.js";
import type { QuestInvocationProvenance, QuestOwnerKind, QuestOwnerRef } from "../shared/quest-owner.js";

export type { QuestInvocationProvenance, QuestOwnerKind, QuestOwnerRef } from "../shared/quest-owner.js";

export type QuestStatus = "idea" | "refined" | "in_progress" | "done";
export type LegacyQuestStatus = QuestStatus | "needs_verification";
export type QuestFeedbackKind = "comment" | "phase_summary" | "phase_finding" | "review" | "artifact" | "system";
export type QuestJourneyRunStatus = "active" | "completed" | "archived" | "manual";
export type QuestPhaseOccurrenceStatus = "pending" | "active" | "completed" | "skipped" | "manual";
export type QuestRelatedQuestKind = "follow_up_of" | "has_follow_up" | "references" | "referenced_by";

export interface QuestVerificationItem {
  text: string;
  checked: boolean;
}

export interface QuestQuizItem {
  /** Stable item id for UI keys and incremental refreshes. */
  id: string;
  /** Active-recall prompt shown before the answer is revealed. */
  question: string;
  /** Reference answer hidden by default in UI surfaces. */
  answer: string;
  /** Optional short provenance note, such as a phase, file, or decision source. */
  source?: string;
}

/** Explicit persisted relationships authored by humans or agents. */
export interface QuestRelationships {
  /** Earlier quests this quest explicitly follows up on. */
  followUpOf?: string[];
}

/** Derived read model combining explicit relationships and detected quest references. */
export interface QuestRelatedQuest {
  questId: string;
  kind: QuestRelatedQuestKind;
  explicit: boolean;
}

/** A single entry in the quest feedback thread (PR-review style). */
export interface QuestFeedbackEntry {
  /** Stable optional identifier for newer structured feedback/documentation entries. */
  entryId?: string;
  author: "human" | "agent";
  /** Entry role. Omitted legacy entries are plain comments. */
  kind?: QuestFeedbackKind;
  text: string;
  /** Human-readable scan summary for long feedback/comment text. */
  tldr?: string;
  ts: number;
  /** Companion session ID that submitted this entry, including on-behalf-of-user feedback. */
  authorSessionId?: string;
  /** Provider-aware invocation that submitted this entry, when available. */
  provenance?: QuestInvocationProvenance;
  /** Images attached to this feedback entry */
  images?: QuestImage[];
  /** Whether this feedback has been addressed (only meaningful for human entries) */
  addressed?: boolean;
  /** Tombstone timestamp preserving this entry's stable zero-based index after deletion. */
  deletedAt?: number;
  /** Stable Journey run this entry documents, when phase-scoped. */
  journeyRunId?: string;
  /** Stable phase occurrence this entry documents, when available. */
  phaseOccurrenceId?: string;
  /** Canonical Quest Journey phase id for scoped entries. */
  phaseId?: QuestJourneyPhaseId;
  /** Zero-based phase index within the run/board plan. */
  phaseIndex?: number;
  /** One-based phase position within the run/board plan. */
  phasePosition?: number;
  /** One-based occurrence count for repeated phases of the same phase id. */
  phaseOccurrence?: number;
}

export interface QuestPhaseOccurrence {
  occurrenceId: string;
  phaseId: QuestJourneyPhaseId;
  /** Zero-based phase index within this run. */
  phaseIndex: number;
  /** One-based phase position within this run. */
  phasePosition: number;
  /** One-based occurrence count for repeated phases of the same phase id. */
  phaseOccurrence: number;
  status: QuestPhaseOccurrenceStatus;
  boardState?: string;
  assigneeSessionId?: string;
  assigneeSessionNum?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface QuestJourneyRun {
  runId: string;
  leaderSessionId?: string;
  workerSessionId?: string;
  workerSessionNum?: number;
  source: "board" | "manual";
  sourceBoardSessionId?: string;
  sourceBoardCreatedAt?: number;
  phaseIds: QuestJourneyPhaseId[];
  status: QuestJourneyRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  phaseOccurrences: QuestPhaseOccurrence[];
}

/** An image attached to a quest, stored on disk. */
export interface QuestImage {
  /** Unique image ID (used for filename) */
  id: string;
  /** Original filename from upload */
  filename: string;
  /** MIME type (image/png, image/jpeg, etc.) */
  mimeType: string;
  /** Absolute path on disk (~/.companion/questmaster/images/<id>.<ext>) */
  path: string;
}

export type QuestOwnershipOperation = "force_claim" | "reassign" | "archived_owner_takeover";
export type QuestRecoveryOperation = "leader_complete";

export interface QuestOwnershipEvent {
  operation: QuestOwnershipOperation;
  actorSessionId: string;
  previousOwnerSessionId: string;
  newOwnerSessionId: string;
  ts: number;
  reason: string;
  previousLeaderSessionId?: string;
  newLeaderSessionId?: string;
}

export type QuestOwnershipEventDraft = Omit<QuestOwnershipEvent, "ts">;

export interface QuestRecoveryBoardSnapshot {
  leaderSessionId: string;
  status?: string;
  workerSessionId?: string;
  phaseIds?: QuestJourneyPhaseId[];
  activePhaseIndex?: number;
  waitForInputCount?: number;
}

export interface QuestRecoveryWorkerSnapshot {
  sessionId: string;
  known: boolean;
  archived?: boolean;
  hasBridgeSession?: boolean;
  hasCwd?: boolean;
  gitStatusKnown?: boolean;
}

export interface QuestRecoverySuppliedMetadata {
  verificationItemCount: number;
  commitShas: string[];
  memoryCommitShas: string[];
  hasDebrief: boolean;
  hasDebriefTldr: boolean;
}

export interface QuestRecoveryEvent {
  operation: QuestRecoveryOperation;
  actorSessionId: string;
  reason: string;
  ts: number;
  previousStatus: QuestStatus;
  previousOwnerSessionId?: string;
  previousLeaderSessionId?: string;
  boardRows: QuestRecoveryBoardSnapshot[];
  workerState?: QuestRecoveryWorkerSnapshot;
  supplied: QuestRecoverySuppliedMetadata;
  bypassedChecks: string[];
}

export type QuestRecoveryEventDraft = Omit<QuestRecoveryEvent, "ts">;

export interface QuestCodeCommitEvidenceReplacementEvent {
  operation: "replace_code_commit_evidence";
  actorSessionId: string;
  reason: string;
  previousCommitShas: string[];
  replacementCommitShas: string[];
  journeyRunId: string;
  phaseOccurrenceId: string;
  verifiedTargetBranch: string;
  verifiedTargetHeadSha: string;
  ts: number;
}

export type QuestCodeCommitEvidenceReplacementEventDraft = Omit<QuestCodeCommitEvidenceReplacementEvent, "ts">;

// ─── Base fields shared by all stages ────────────────────────────────────────

interface QuestBase {
  /** Opaque current-record identifier. Legacy backups use ids like "q-1-v3". */
  id: string;
  /** Stable across versions: "q-1" */
  questId: string;
  /** Monotonic live revision counter for the current quest record. */
  version: number;
  /** Legacy-only backlink used when reading version-history backups. */
  prevId?: string;
  title: string;
  /** Human-readable scan summary for long quest descriptions. */
  tldr?: string;
  /** When the quest was originally created. */
  createdAt: number;
  /** Provider-aware invocation that created this quest, when available. */
  createdBy?: QuestInvocationProvenance;
  /** Last in-place modification (checkbox toggle, patch, image change).
   *  Only set by in-place mutations; absent on freshly created versions. */
  updatedAt?: number;
  /** Provider-aware invocation responsible for the latest mutation, when available. */
  lastModifiedBy?: QuestInvocationProvenance;
  /** Last status transition time. Preserves Questmaster recency ordering. */
  statusChangedAt?: number;
  tags?: string[];
  /** Stable questId of parent task (for subtasks) */
  parentId?: string;
  /** Session-space slug this quest belongs to. Older quests may omit it and resolve through provenance fallback. */
  sessionSpaceSlug?: string;
  /** Attached images stored on disk */
  images?: QuestImage[];
  /** Past owners in chronological order. Excludes the current active owner. */
  previousOwnerSessionIds?: string[];
  /** Provider-aware past owners in chronological order. Excludes the current active owner. */
  previousOwners?: QuestOwnerRef[];
  /** Append-only audit trail for explicit or compatibility ownership takeovers. */
  ownershipEvents?: QuestOwnershipEvent[];
  /** Append-only audit trail for explicit leader recovery escape hatches. */
  recoveryEvents?: QuestRecoveryEvent[];
  /** Append-only audit trail for corrections to structured code commit evidence. */
  codeCommitEvidenceReplacementEvents?: QuestCodeCommitEvidenceReplacementEvent[];
  /** Current/relevant orchestrating leader session for feedback routing, when known. */
  leaderSessionId?: string;
  /** Fixed delivery targets and retained review evidence; omitted from list/preview payloads. */
  codeDeliveries?: QuestCodeDelivery[];
  deliveryTargetApprovals?: QuestDeliveryTargetApproval[];
  /** Ordered synced commit SHAs associated with this quest's verification handoff. */
  commitShas?: string[];
  /** Ordered memory repo commit SHAs associated with this quest's Memory handoff. */
  memoryCommitShas?: string[];
  /** Explicit quest relationships. Supplemental backlinks are derived at read time. */
  relationships?: QuestRelationships;
  /** Read-only summary for CLI/UI inspection. Not persisted. */
  relatedQuests?: QuestRelatedQuest[];
  /** Durable Quest Journey run snapshots used by phase-scoped documentation. */
  journeyRuns?: QuestJourneyRun[];
  /** Active-recall quiz items attached to this quest. */
  quizItems?: QuestQuizItem[];
  /**
   * Opaque legacy payload from the rejected quest-owned Outcome model.
   * Preserve exactly across mutations, but never promote it into active UI, search,
   * completion, debrief, or leader-message authority.
   */
  outcome?: unknown;
  /** Threaded feedback conversation that must survive quest version transitions. */
  feedback?: QuestFeedbackEntry[];
}

// ─── Progressive stage types (each extends the previous) ─────────────────────

/** Idea: raw thought, description optional */
export type QuestIdea = QuestBase & {
  status: "idea";
  description?: string;
};

/** Refined: fleshed out, description required */
export type QuestRefined = QuestBase & {
  status: "refined";
  description: string;
};

/** In Progress: claimed by a session */
export type QuestInProgress = Omit<QuestRefined, "status"> & {
  status: "in_progress";
  /** Active owner session ID (historically named sessionId for compatibility). */
  sessionId: string;
  /** Active owner provider. Missing means Takode for legacy records. */
  ownerKind?: QuestOwnerKind;
  claimedAt: number;
};

/** Done: completed, optionally awaiting human review through separate metadata. */
export type QuestDone = Omit<QuestInProgress, "status" | "sessionId" | "ownerKind" | "claimedAt"> & {
  status: "done";
  /** Active owner is cleared when done; sessionId may be present in legacy data. */
  sessionId?: string;
  /** Preserved for compatibility/history display when available. */
  claimedAt?: number;
  completedAt: number;
  verificationItems: QuestVerificationItem[];
  /**
   * Present only while a completed quest is still in the review workflow.
   * true means fresh review inbox; false means acknowledged/under review.
   * Undefined means final done, not in review surfaces.
   */
  verificationInboxUnread?: boolean;
  /** Free-form closure notes (commit hashes, reasoning, references, etc.) */
  notes?: string;
  /** Final user-facing outcome debrief for completed quests. */
  debrief?: string;
  /** Human-readable scan summary for long final debriefs. */
  debriefTldr?: string;
  /** If true, this quest was cancelled/aborted rather than completed */
  cancelled?: boolean;
};

// ─── Union type ──────────────────────────────────────────────────────────────

export type QuestmasterTask = QuestIdea | QuestRefined | QuestInProgress | QuestDone;

export interface QuestListPreviewProgress {
  checked: number;
  total: number;
}

export interface QuestListPreviewFeedbackSummary {
  humanTotal: number;
  humanUnaddressed: number;
  humanAddressed: number;
}

export interface QuestListPreviewPhaseLine {
  key: string;
  label: string;
  metaLabel?: string;
  text: string;
}

export interface QuestListPreview {
  preview: true;
  id: string;
  questId: string;
  version: number;
  title: string;
  status: QuestStatus;
  tldr?: string;
  createdAt: number;
  updatedAt?: number;
  statusChangedAt?: number;
  tags?: string[];
  parentId?: string;
  sessionSpaceSlug?: string;
  sessionId?: string;
  /** Active owner provider. Missing means Takode for legacy records. */
  ownerKind?: QuestOwnerKind;
  claimedAt?: number;
  previousOwnerSessionIds?: string[];
  previousOwners?: QuestOwnerRef[];
  leaderSessionId?: string;
  completedAt?: number;
  verificationInboxUnread?: boolean;
  cancelled?: boolean;
  debriefTldr?: string;
  relationships?: QuestRelationships;
  relatedQuests?: QuestRelatedQuest[];
  journeyRuns?: QuestJourneyRun[];
  verificationProgress?: QuestListPreviewProgress;
  feedbackSummary?: QuestListPreviewFeedbackSummary;
  phasePreviewLines?: QuestListPreviewPhaseLine[];
}

export interface QuestAutocompleteCandidate {
  questId: string;
  title: string;
}

/** Minimal canonical metadata for bounded by-id browser hydration and live quest updates. */
export interface QuestTitlePreview {
  questId: string;
  title: string;
  version: number;
  /** Canonical record freshness. Older persisted quests may omit this outside the exact projection. */
  updatedAt?: number;
  /** Ordered synchronized code commits. Omitted only by legacy or title-only producers. */
  commitShas?: string[];
}

export interface QuestTitlePreviewResponse {
  quests: QuestTitlePreview[];
  missingQuestIds: string[];
}

export function hasQuestReviewMetadata(quest: QuestmasterTask | null | undefined): quest is QuestDone {
  return quest?.status === "done" && quest.cancelled !== true && typeof quest.verificationInboxUnread === "boolean";
}

export function isQuestReviewInboxUnread(quest: QuestmasterTask | null | undefined): boolean {
  return hasQuestReviewMetadata(quest) && quest.verificationInboxUnread === true;
}

export type QuestHistoryMode = "live" | "legacy_backup" | "unavailable";

export interface QuestHistoryView {
  mode: QuestHistoryMode;
  entries: QuestmasterTask[];
  message?: string;
  backupDir?: string;
}

export interface QuestMigrationUnreadableFile {
  file: string;
  questId: string;
  error: string;
}

export interface QuestMigrationBlockedQuest {
  questId: string;
  files: string[];
  errors: string[];
}

export type QuestMigrationSnapshotStatus = "readable" | "missing" | "unreadable";

export interface QuestStoreMigrationReport {
  legacyQuestCount: number;
  migratedQuestCount: number;
  snapshotQuestCount: number;
  snapshotStatus: QuestMigrationSnapshotStatus;
  snapshotError?: string;
  snapshotMismatchQuestIds: string[];
  unreadableFiles: QuestMigrationUnreadableFile[];
  blockedQuests: QuestMigrationBlockedQuest[];
}

// ─── Input types (for APIs) ──────────────────────────────────────────────────

export interface QuestCreateInput {
  title: string;
  /** Provider-aware invocation that created the quest, when called through a sidecar. */
  createdBy?: QuestInvocationProvenance;
  description?: string;
  tldr?: string;
  status?: QuestStatus;
  tags?: string[];
  parentId?: string;
  sessionSpaceSlug?: string;
  relationships?: QuestRelationships;
  /** Pre-saved images to attach on creation */
  images?: QuestImage[];
  quizItems?: QuestQuizItem[];
}

/** Same-stage edits (e.g., fixing a typo). Does NOT create a new version. */
export interface QuestPatchInput {
  /** Provider-aware invocation responsible for this edit, when available. */
  lastModifiedBy?: QuestInvocationProvenance;
  title?: string;
  description?: string;
  tldr?: string;
  tags?: string[];
  sessionSpaceSlug?: string;
  relationships?: QuestRelationships;
  /** Replace the feedback thread (used by the append endpoint after adding an entry) */
  feedback?: QuestFeedbackEntry[];
  /** Replace durable Journey run snapshots used by phase-scoped documentation */
  journeyRuns?: QuestJourneyRun[];
  /** Replace active-recall quiz items attached to this quest. */
  quizItems?: QuestQuizItem[];
}

/** Status transitions. Always creates a new version linked to the previous. */
export interface QuestTransitionInput {
  status: QuestStatus;
  /** Provider-aware invocation responsible for this transition, when available. */
  lastModifiedBy?: QuestInvocationProvenance;
  /** Required for refined+ */
  description?: string;
  /** Human-readable scan summary for long descriptions. */
  tldr?: string;
  /** Required for in_progress+ */
  sessionId?: string;
  /** Owner provider for in_progress. Missing means Takode for compatibility. */
  ownerKind?: QuestOwnerKind;
  /** Optional orchestrating leader session to preserve for feedback routing. */
  leaderSessionId?: string;
  /** Optional ownership audit event to append when the active owner changes. */
  ownershipEvent?: QuestOwnershipEventDraft;
  /** Optional leader recovery audit event to append for explicit escape hatches. */
  recoveryEvent?: QuestRecoveryEventDraft;
  /** Human-review checklist. Accepts strings (normalized to {text, checked:false}) or full objects. */
  verificationItems?: (QuestVerificationItem | string)[];
  /** Ordered synced commit SHAs to attach at verification handoff. */
  commitShas?: string[];
  /** Ordered memory repo commit SHAs to attach at Memory handoff. */
  memoryCommitShas?: string[];
  /** Explicit quest relationships to carry into this new status version. */
  relationships?: QuestRelationships;
  /** Active-recall quiz items to carry into this new status version. */
  quizItems?: QuestQuizItem[];
  /** Review inbox state for done quests that are awaiting/under human review. */
  verificationInboxUnread?: boolean;
  /** Closure notes for done status (commit hashes, reasoning, etc.) */
  notes?: string;
  /** Final user-facing outcome debrief for completed quests. */
  debrief?: string;
  /** Human-readable scan summary for long final debriefs. */
  debriefTldr?: string;
  /** If true, marks this as cancelled/aborted rather than completed */
  cancelled?: boolean;
}
