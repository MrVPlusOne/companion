import { projectQuestDelivery, recordedCommitStats, type QuestCodeDelivery } from "../../shared/quest-delivery.js";
import type { QuestDeliveryClient } from "../components/QuestCommitChip.js";

export const DELIVERY_FIXTURE_QUEST = "q-9904";
export const DELIVERY_FIXTURE_ID = "a".repeat(32);
export const LATER_DELIVERY_FIXTURE_ID = "b".repeat(32);
export const FIRST_DELIVERY_SHA = "1".repeat(40);
export const SECOND_DELIVERY_SHA = "2".repeat(40);
export const LATER_DELIVERY_SHA = "3".repeat(40);
export const REVIEW_FIXTURE_SHA = "4".repeat(40);
export const LEGACY_DELIVERY_SHA = "5".repeat(40);

const summary = (sha: string, message: string, additions: number, deletions: number, binaryFiles = 0) => ({
  sha,
  shortSha: sha.slice(0, 7),
  message,
  additions,
  deletions,
  binaryFiles,
  timestamp: 1_789_000_000_000,
  comparison: { method: "first-parent-v1" as const, baseSha: "0".repeat(40), parentCount: 1 },
});

// Use the actual server/shared projection, so fixtures cannot invent browser-only evidence shapes.
export const deliveryFixture: QuestCodeDelivery = {
  id: DELIVERY_FIXTURE_ID,
  actorSessionId: "fixture-worker",
  phaseOccurrenceId: "fixture-work",
  recordedAt: 1_789_000_001_000,
  targetHeadSha: SECOND_DELIVERY_SHA,
  target: { repoRoot: "/fixture/repo", checkoutPath: "/fixture/repo", branch: "integration", mode: "remote-backed" },
  commits: [
    {
      ...summary(
        FIRST_DELIVERY_SHA,
        "Keep line-change statistics visible beside a deliberately long commit title that must remain fully accessible",
        1234567,
        246,
      ),
      comparison: { method: "first-parent-v1", baseSha: "0".repeat(40), parentCount: 2 },
      review: {
        ref: `refs/takode/review/${DELIVERY_FIXTURE_ID}/0`,
        baseSha: "0".repeat(40),
        tipSha: REVIEW_FIXTURE_SHA,
        commitShas: [REVIEW_FIXTURE_SHA],
      },
    },
    {
      ...summary(SECOND_DELIVERY_SHA, "Update the loading illustration", 0, 0, 1),
      comparison: { method: "first-parent-v1", baseSha: null, parentCount: 0 },
    },
  ],
};

export const laterDeliveryFixture: QuestCodeDelivery = {
  ...deliveryFixture,
  id: LATER_DELIVERY_FIXTURE_ID,
  recordedAt: 1_789_000_002_000,
  targetHeadSha: LATER_DELIVERY_SHA,
  commits: [summary(LATER_DELIVERY_SHA, "Fix the later empty-state issue", 16, 5)],
};

export const legacyDeliveryFixture: QuestCodeDelivery = {
  ...deliveryFixture,
  id: "c".repeat(32),
  targetHeadSha: LEGACY_DELIVERY_SHA,
  commits: [{ ...summary(LEGACY_DELIVERY_SHA, "Older saved commit", 9, 2), comparison: undefined }],
};

export function createDeliveryFixtureClient(unavailable = false): QuestDeliveryClient {
  return {
    async delivery(questId, id) {
      if (questId !== DELIVERY_FIXTURE_QUEST) throw new Error("Unknown fixture quest.");
      const record = [deliveryFixture, laterDeliveryFixture, legacyDeliveryFixture].find((item) => item.id === id);
      if (!record) throw new Error("Unknown fixture delivery.");
      return projectQuestDelivery(questId, record);
    },
    async commit(_questId, id, sha, review, includeDiff) {
      if (unavailable) return { sha, available: false, reason: "repo_unavailable" };
      const record = [deliveryFixture, laterDeliveryFixture, legacyDeliveryFixture].find((item) => item.id === id)!;
      const metadata =
        review && sha === REVIEW_FIXTURE_SHA
          ? summary(sha, "Original review increment", 24, 7)
          : record.commits.find((item) => item.sha === sha);
      if (!metadata) throw new Error("Commit is outside this fixture delivery.");
      const current =
        includeDiff && !metadata.comparison
          ? {
              ...metadata,
              additions: 1,
              deletions: 1,
              comparison: { method: "first-parent-v1" as const, baseSha: "0".repeat(40), parentCount: 2 },
            }
          : metadata;
      return {
        ...current,
        recordedStats: includeDiff ? recordedCommitStats(metadata, current) : undefined,
        available: true,
        ...(includeDiff
          ? {
              diff:
                sha === SECOND_DELIVERY_SHA
                  ? ""
                  : `diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const request = repeated();\n+const request = shared();\n`,
            }
          : {}),
      };
    },
    async review(_questId, _id, sha) {
      if (sha !== FIRST_DELIVERY_SHA) return { snapshots: [], commitShas: [] };
      return { snapshots: [{ index: 0, count: 1, label: "Original increments" }], commitShas: [REVIEW_FIXTURE_SHA] };
    },
  };
}
