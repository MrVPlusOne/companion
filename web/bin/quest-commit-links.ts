import { getQuest } from "../server/quest-store.js";
import {
  DELIVERY_ID_PATTERN,
  commitComparisonLabel,
  deliveryCommitHref,
  projectQuestDelivery,
} from "../shared/quest-delivery.js";

/** Produce fixed, copy-ready links without publishing messages or mutating evidence. */
export async function runCommitLinksCommand(input: {
  questId: string;
  deliveryId: string;
  commitShas?: string[];
  json: boolean;
}): Promise<void> {
  if (!/^q-\d+$/.test(input.questId) || !DELIVERY_ID_PATTERN.test(input.deliveryId))
    throw new Error("Supply an exact quest and delivery ID.");
  const quest = await getQuest(input.questId);
  const delivery = quest?.codeDeliveries?.find((item) => item.id === input.deliveryId);
  if (!delivery) throw new Error("Recorded delivery not found. Do not infer historical delivery provenance.");
  const view = projectQuestDelivery(input.questId, delivery);
  const selected = input.commitShas?.length
    ? input.commitShas.map((sha) => {
        const matches = view.commits.filter((commit) => commit.sha.startsWith(sha.toLowerCase()));
        if (matches.length !== 1) throw new Error(`Commit ${sha} is not an unambiguous member of this delivery.`);
        return matches[0]!;
      })
    : view.commits;
  const links = selected.map((commit) => {
    if (!quest!.commitShas?.includes(commit.sha))
      throw new Error("Delivery references corrected or unavailable code evidence.");
    const href = deliveryCommitHref(input.questId, delivery.id, commit.sha);
    const title = commit.message.replace(/[\\[\]]/g, "\\$&");
    return {
      sha: commit.sha,
      title: commit.message,
      additions: commit.additions,
      deletions: commit.deletions,
      binaryFiles: commit.binaryFiles,
      comparison: commitComparisonLabel(commit.comparison),
      markdown: `[${title}](${href})`,
    };
  });
  if (input.json) console.log(JSON.stringify({ questId: input.questId, deliveryId: delivery.id, commits: links }));
  else {
    console.log("Delivered in this batch:");
    for (const link of links) console.log(link.markdown);
  }
}
