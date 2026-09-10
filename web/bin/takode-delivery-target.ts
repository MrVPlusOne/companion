import { readFile } from "node:fs/promises";
import { apiGet, apiPost, assertKnownFlags, err, parseFlags } from "./takode-core.js";

export const DELIVERY_TARGET_HELP = `Usage: takode board approve-delivery-target <quest-id> --target-file <path> [--json]
       takode board delivery-targets <quest-id> [--target <approval-id>] [--json]

The assigned leader records an already-authorized independent publication target
for the current worker and Work occurrence. This verifies existing publication;
it never pushes, moves a branch, repairs another quest, or changes session targets.

Target JSON: { "checkoutPath": "/absolute/independent-checkout", "remote": "origin",
  "repositoryUrl": "https://example.com/team/project.git",
  "refs": [{ "ref": "refs/heads/user/change", "sha": "<full lowercase SHA>" }] }
List refs in delivery order. Each exact head must exist locally and at the remote.
The worker supplies --delivery-target <approval-id> alongside the exact --commits
on record-work-delivery or work-to-memory, without --preparation or --no-code.
Use delivery-targets --target for the full persisted approval, including paths/refs.
`;

/** Record or inspect target authority without publishing code or changing a session's target. */
export async function handleDeliveryTarget(base: string, action: string, args: string[]): Promise<void> {
  const questId = args[0];
  if (!questId || !/^q-\d+$/.test(questId)) err(DELIVERY_TARGET_HELP);
  const flags = parseFlags(args.slice(1));
  assertKnownFlags(
    flags,
    new Set(action === "approve-delivery-target" ? ["target-file", "json"] : ["target", "json"]),
    DELIVERY_TARGET_HELP,
  );
  if (action === "approve-delivery-target") {
    if (typeof flags["target-file"] !== "string") err("--target-file requires the approved target JSON file.");
    const target = JSON.parse(await readFile(flags["target-file"], "utf8"));
    const result = (await apiPost(base, "/takode/board/approve-delivery-target", { questId, target })) as {
      approvalId: string;
      refCount: number;
    };
    if (flags.json) console.log(JSON.stringify({ questId, approvalId: result.approvalId, refCount: result.refCount }));
    else
      console.log(
        `${questId}: approved delivery target ${result.approvalId} (${result.refCount} refs). Worker: use --delivery-target ${result.approvalId} with the approved commits.`,
      );
    return;
  }
  if (flags.target !== undefined && (typeof flags.target !== "string" || !/^[a-f0-9]{32}$/.test(flags.target)))
    err("--target requires an exact approval ID.");
  const result = (await apiGet(
    base,
    `/takode/board/delivery-targets/${questId}${flags.target ? `/${flags.target}` : ""}`,
  )) as {
    approval?: unknown;
    approvals?: Array<{ id: string; approvedAt: number; phaseOccurrenceId: string; refCount: number }>;
  };
  if (flags.target) {
    console.log(JSON.stringify({ questId, approval: result.approval }, null, flags.json ? undefined : 2));
  } else {
    const approvals =
      result.approvals?.map(({ id, approvedAt, phaseOccurrenceId, refCount }) => ({
        id,
        approvedAt,
        phaseOccurrenceId,
        refCount,
      })) ?? [];
    if (flags.json) console.log(JSON.stringify({ questId, approvals }));
    else
      console.log(
        approvals.length
          ? approvals.map((item) => `${item.id} (${item.refCount} refs; ${item.phaseOccurrenceId})`).join("\n")
          : `${questId}: no independent delivery target approvals.`,
      );
  }
}

/** Shared flag guard for both worker-owned delivery paths. */
export function deliveryTargetFlag(flags: Record<string, string | boolean>): string | undefined {
  const id = flags["delivery-target"];
  if (id === undefined) return undefined;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    err("--delivery-target requires an exact leader-approved target ID.");
  if (flags.preparation || flags["no-code"])
    err("--delivery-target uses published evidence and cannot combine with --preparation or --no-code.");
  return id;
}
