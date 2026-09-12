import type { DiffFileGroupStats } from "./diff-file-groups.js";

/** A recorded, deterministic commit comparison; root commits use the empty tree. */
export interface CommitComparison {
  method: "first-parent-v1";
  baseSha: string | null;
  parentCount: number;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  timestamp: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  splitStats?: DiffFileGroupStats;
  comparison?: CommitComparison;
}

export interface RetainedReviewRange {
  ref: string;
  baseSha: string;
  tipSha: string;
  commitShas: string[];
}

export interface DeliveryTarget {
  repoRoot: string;
  checkoutPath: string;
  branch: string;
  mode: "remote-backed" | "worktree" | "direct" | "published";
  publication?: PublishedDeliveryTarget & { approvalId: string };
}

/** Exact published branch heads, ordered in delivery order, in an independent checkout. */
export interface PublishedDeliveryTarget {
  checkoutPath: string;
  remote: string;
  repositoryUrl: string;
  refs: Array<{ ref: string; sha: string }>;
}

/** An immutable leader authorization scoped to one assigned worker and Work occurrence. */
export interface QuestDeliveryTargetApproval {
  id: string;
  approvedAt: number;
  leaderSessionId: string;
  workerSessionId: string;
  phaseOccurrenceId: string;
  target: PublishedDeliveryTarget;
}

export interface QuestDeliveredCommit extends CommitSummary {
  workerSha?: string;
  review?: RetainedReviewRange;
}

/** Immutable Git provenance; assistant messages separately own presentation time. */
export interface QuestCodeDelivery {
  id: string;
  recordedAt: number;
  actorSessionId: string;
  phaseOccurrenceId: string;
  target: DeliveryTarget;
  targetHeadSha: string;
  commits: QuestDeliveredCommit[];
  earlierReviews?: RetainedReviewRange[];
}

/** Browser/CLI projection deliberately omits paths, refs, and complete review ranges. */
export interface QuestDeliveryView {
  id: string;
  questId: string;
  branch: string;
  recordedAt: number;
  commits: Array<CommitSummary & { reviewCount: number }>;
  earlierReviewCount: number;
}

export const DELIVERY_ID_PATTERN = /^[a-f0-9]{32}$/;
export const FULL_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export function deliveryCommitHref(questId: string, deliveryId: string, sha: string): string {
  return `quest:${questId}:delivery:${deliveryId}:commit:${sha}`;
}

export function projectQuestDelivery(questId: string, delivery: QuestCodeDelivery): QuestDeliveryView {
  return {
    id: delivery.id,
    questId,
    branch: delivery.target.branch,
    recordedAt: delivery.recordedAt,
    commits: delivery.commits.map(({ workerSha: _worker, review, ...summary }) => ({
      ...summary,
      reviewCount: review?.commitShas.length ?? 0,
    })),
    earlierReviewCount: delivery.earlierReviews?.length ?? 0,
  };
}

/** Keep a missing historical baseline distinct from a newly verified comparison. */
export function commitComparisonLabel(comparison?: CommitComparison): string {
  if (comparison?.method !== "first-parent-v1") return "Baseline unrecorded";
  if (comparison.baseSha === null) return "Initial tree";
  return comparison.parentCount > 1 ? "Vs first parent (merge)" : "Vs parent";
}

/** Preserve old saved counts when their baseline is unknown or today's comparison differs. */
export function recordedCommitStats(recorded: CommitSummary | undefined, current: Partial<CommitSummary>) {
  if (!recorded || typeof current.additions !== "number") return undefined;
  if (
    recorded.comparison &&
    recorded.comparison.method === current.comparison?.method &&
    recorded.comparison.baseSha === current.comparison?.baseSha &&
    recorded.comparison.parentCount === current.comparison?.parentCount &&
    recorded.additions === current.additions &&
    recorded.deletions === current.deletions &&
    recorded.binaryFiles === current.binaryFiles
  )
    return undefined;
  return {
    additions: recorded.additions,
    deletions: recorded.deletions,
    binaryFiles: recorded.binaryFiles,
    comparison: recorded.comparison,
  };
}
