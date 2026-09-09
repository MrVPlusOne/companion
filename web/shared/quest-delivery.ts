import type { DiffFileGroupStats } from "./diff-file-groups.js";

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  timestamp: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  splitStats?: DiffFileGroupStats;
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
  mode: "remote-backed" | "worktree" | "direct";
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
