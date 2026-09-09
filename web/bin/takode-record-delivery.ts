import { apiPost, assertKnownFlags, err, parseFlags, parseIntegerFlag } from "./takode-core.js";
import { parseCommitShas } from "./quest-commit-flags.js";
import type { QuestDeliveryView } from "../shared/quest-delivery.js";

export const RECORD_DELIVERY_HELP = `Usage: takode board record-work-delivery <quest-id> --commits <sha,...> [--preparation <id>] [--work-note <index>] [--json]

Record an already verified/synchronized delivery while staying in Work. Uses the
same evidence guard as Work -> Memory. It does not port, push, or advance a phase.
After using port tracking, supply --preparation to attach retained review evidence.
`;

export async function handleRecordDelivery(base: string, args: string[]): Promise<void> {
  const questId = args[0];
  if (!questId || !/^q-\d+$/.test(questId)) err(RECORD_DELIVERY_HELP);
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(flags, new Set(["commits", "preparation", "work-note", "json"]), RECORD_DELIVERY_HELP);
  if (typeof flags.commits !== "string") err("--commits requires the ordered synchronized target SHAs.");
  if (flags.preparation === true) err("--preparation requires its exact ID.");
  const result = (await apiPost(base, "/takode/board/record-work-delivery", {
    questId,
    commitShas: parseCommitShas(flags.commits.split(",")),
    preparationId: flags.preparation,
    workFeedbackIndex: parseIntegerFlag(flags, "work-note", "Work note"),
  })) as { questId: string; delivery: QuestDeliveryView };
  if (flags.json)
    console.log(
      JSON.stringify({
        questId,
        deliveryId: result.delivery.id,
        commitShas: result.delivery.commits.map((commit) => commit.sha),
        branch: result.delivery.branch,
      }),
    );
  else
    console.log(
      `${questId}: recorded delivery ${result.delivery.id} (${result.delivery.commits.length} commits); still in Work.\nAuthor links: quest commit-links ${questId} --delivery ${result.delivery.id}`,
    );
}
