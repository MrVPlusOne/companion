import { apiGet, apiPost, err } from "./takode-core.js";
import { parseCommitShas } from "./quest-commit-flags.js";
import type { PortTrackingStatus } from "../server/port-tracking.js";

export const PORT_HELP = `Usage: takode port <prepare|seal|landed|status> <quest-id> [preparation-id] [flags]

prepare <quest-id> --base <sha> --confirm-private [--group-tips <sha,...>] [--previous <id>]
  Retain an explicit private linear review range. Default: one cohesive group.
  Use --group-tips to preserve meaningful separate commits. Never guesses ownership.
seal <quest-id> <id> --commits <sha,...>
  Verify and record one final commit per prepared group after normal Git squashing.
landed <quest-id> <id> --source <sha> --target <sha>
  Record each exact cherry-pick result immediately, including partial ports.
status <quest-id> <id>
  Show landed receipts, remaining entries, uncertainty, and the next safe action.

--json returns the same compact status. This helper never rebases, squashes,
cherry-picks, pushes, or resets a branch. Follow /port-changes for those actions.
Retained review refs consume local disk, survive worker cleanup, and are not
backed up by ordinary push. No automatic expiry is added.
`;

export async function handlePort(base: string, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(PORT_HELP);
    return;
  }
  const [action, questId] = args;
  if (!questId || !/^q-\d+$/.test(questId)) err("An exact quest ID is required.");
  if (!action || !["prepare", "seal", "landed", "status"].includes(action)) err(PORT_HELP);
  const flags = new Map<string, string | true>();
  const id = action === "prepare" ? undefined : args[2];
  const permitted = new Set([
    "--json",
    ...(action === "prepare"
      ? ["--base", "--confirm-private", "--group-tips", "--previous"]
      : action === "seal"
        ? ["--commits"]
        : action === "landed"
          ? ["--source", "--target"]
          : []),
  ]);
  for (let i = action === "prepare" ? 2 : 3; i < args.length; i++) {
    const flag = args[i]!;
    if (!permitted.has(flag) || flags.has(flag)) err(`Unknown or repeated flag: ${flag}`);
    if (flag === "--json" || flag === "--confirm-private") {
      flags.set(flag, true);
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) err(`${flag} requires a value.`);
    flags.set(flag, value);
  }
  const value = (name: string) => (typeof flags.get(name) === "string" ? (flags.get(name) as string) : undefined);
  if (action !== "prepare" && (!id || !/^[a-f0-9]{32}$/.test(id))) err("An exact preparation ID is required.");
  const path = `/takode/port/${questId}`;
  const result = (
    action === "status"
      ? await apiGet(base, `${path}/${id}`)
      : await apiPost(base, `${path}/${action}`, {
          id,
          baseSha: value("--base"),
          confirmPrivate: flags.get("--confirm-private") === true,
          groupTips: value("--group-tips") ? parseCommitShas(value("--group-tips")!.split(",")) : undefined,
          previousId: value("--previous"),
          commitShas: value("--commits") ? parseCommitShas(value("--commits")!.split(",")) : undefined,
          workerSha: value("--source"),
          targetSha: value("--target"),
        })
  ) as PortTrackingStatus;
  if (flags.get("--json")) {
    console.log(
      JSON.stringify({
        id: result.id,
        state: result.state,
        landed: result.landed.map(({ workerSha, targetSha }) => ({ workerSha, targetSha })),
        remaining: result.remaining,
        nextAction: result.nextAction,
      }),
    );
    return;
  }
  console.log(`Preparation ${result.id}: ${result.state}`);
  console.log(
    `Landed: ${result.landed.length}; remaining${result.state === "uncertain" ? " (unconfirmed)" : ""}: ${result.remaining.length}`,
  );
  for (const receipt of result.landed) console.log(`  ${receipt.workerSha} -> ${receipt.targetSha}`);
  for (const sha of result.remaining) console.log(`  remaining: ${sha}`);
  console.log(`Next: ${result.nextAction}`);
}
