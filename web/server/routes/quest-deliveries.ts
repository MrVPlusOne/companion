import type { Hono } from "hono";
import { getQuest } from "../quest-store.js";
import {
  DELIVERY_ID_PATTERN,
  FULL_COMMIT_SHA_PATTERN,
  projectQuestDelivery,
  recordedCommitStats,
  type QuestCodeDelivery,
} from "../../shared/quest-delivery.js";
import { readCommitDetails } from "../git-commit-reader.js";
import { verifyReview } from "../port-tracking.js";

export function registerQuestDeliveryRoutes(api: Hono): void {
  api.get("/quests/:questId/deliveries/:deliveryId", async (c) => {
    const delivery = await findDelivery(c.req.param("questId"), c.req.param("deliveryId"));
    if (!delivery) return c.json({ error: "Recorded delivery not found." }, 404);
    return c.json(projectQuestDelivery(c.req.param("questId"), delivery));
  });

  api.get("/quests/:questId/deliveries/:deliveryId/review/:sha", async (c) => {
    const delivery = await findDelivery(c.req.param("questId"), c.req.param("deliveryId"));
    const selected = delivery?.commits.find((commit) => commit.sha === c.req.param("sha"));
    if (!delivery || !selected) return c.json({ error: "Commit not in the recorded delivery." }, 404);
    const ranges = [...(selected.review ? [selected.review] : []), ...(delivery.earlierReviews ?? [])];
    const snapshot = c.req.query("snapshot") ?? "0";
    if (!/^\d+$/.test(snapshot)) return c.json({ error: "Invalid review snapshot." }, 400);
    const range = ranges[Number(snapshot)];
    return c.json({
      snapshots: ranges.map((item, index) => ({
        index,
        count: item.commitShas.length,
        label: selected.review && index === 0 ? "Original increments" : "Earlier review snapshot",
      })),
      commitShas: range?.commitShas ?? [],
    });
  });

  api.get("/quests/:questId/deliveries/:deliveryId/commits/:sha", async (c) => {
    const questId = c.req.param("questId");
    const delivery = await findDelivery(questId, c.req.param("deliveryId"));
    const sha = c.req.param("sha").toLowerCase();
    if (!delivery || !FULL_COMMIT_SHA_PATTERN.test(sha)) return c.json({ error: "Recorded commit not found." }, 404);
    const isReview = c.req.query("review") === "true";
    const selected = delivery.commits.find((commit) => commit.sha === sha);
    const ranges = [
      ...delivery.commits.flatMap((commit) => (commit.review ? [commit.review] : [])),
      ...(delivery.earlierReviews ?? []),
    ];
    const review = isReview ? ranges.find((range) => range.commitShas.includes(sha)) : undefined;
    const quest = await getQuest(questId);
    if (isReview ? !review : !selected || !quest?.commitShas?.includes(sha)) {
      return c.json({ error: "Commit is not attached to this delivery's authoritative evidence." }, 404);
    }
    const includeDiff = c.req.query("includeDiff") !== "false";
    if (!isReview && !includeDiff)
      return c.json({ ...selected, workerSha: undefined, review: undefined, available: true });
    try {
      if (review) await verifyReview(delivery.target.repoRoot, review);
      const details = await readCommitDetails(delivery.target.repoRoot, sha, includeDiff);
      return c.json({
        ...details,
        recordedStats: isReview ? undefined : recordedCommitStats(selected, details),
        available: true,
      });
    } catch (error) {
      console.warn(
        "[quest-delivery] Commit evidence unavailable:",
        sha,
        error instanceof Error ? error.message : error,
      );
      return c.json({ sha, available: false, reason: "commit_not_available" });
    }
  });
}

async function findDelivery(questId: string, id: string): Promise<QuestCodeDelivery | undefined> {
  if (!/^q-\d+$/.test(questId) || !DELIVERY_ID_PATTERN.test(id)) return undefined;
  return (await getQuest(questId))?.codeDeliveries?.find((delivery) => delivery.id === id);
}
