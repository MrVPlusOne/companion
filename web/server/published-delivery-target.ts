import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PublishedDeliveryTarget, QuestDeliveryTargetApproval } from "../shared/quest-delivery.js";
import type { QuestmasterTask } from "./quest-types.js";
import { readGit, resolveCommit } from "./git-commit-reader.js";

export class DeliveryEvidenceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 503 = 409,
  ) {
    super(message);
  }
}

/** Reject malformed or oversized target specifications before touching Git or durable state. */
export function parsePublishedDeliveryTarget(value: unknown): PublishedDeliveryTarget {
  const item = value as PublishedDeliveryTarget | undefined;
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    Object.keys(item).some((key) => !["checkoutPath", "remote", "repositoryUrl", "refs"].includes(key)) ||
    typeof item.checkoutPath !== "string" ||
    !isAbsolute(item.checkoutPath) ||
    typeof item.remote !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(item.remote) ||
    typeof item.repositoryUrl !== "string" ||
    !item.repositoryUrl ||
    /[\r\n\0]/.test(item.repositoryUrl) ||
    !Array.isArray(item.refs) ||
    item.refs.length === 0 ||
    item.refs.length > 100
  ) {
    throw new DeliveryEvidenceError(
      "Expected an absolute checkoutPath, remote, repositoryUrl and 1-100 exact published refs.",
      400,
    );
  }
  const refs = new Set<string>();
  for (const entry of item.refs) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).some((key) => key !== "ref" && key !== "sha") ||
      typeof entry.ref !== "string" ||
      !entry.ref.startsWith("refs/heads/") ||
      typeof entry.sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(entry.sha) ||
      refs.has(entry.ref)
    ) {
      throw new DeliveryEvidenceError(
        "Published refs must be unique refs/heads/... names paired with full lowercase commit SHAs.",
        400,
      );
    }
    refs.add(entry.ref);
  }
  return {
    checkoutPath: item.checkoutPath,
    remote: item.remote,
    repositoryUrl: item.repositoryUrl,
    refs: item.refs.map(({ ref, sha }) => ({ ref, sha })),
  };
}

/** Approval identity binds the exact repository/refs to this leader, worker and Work occurrence. */
export function deliveryTargetApprovalId(
  questId: string,
  approval: Omit<QuestDeliveryTargetApproval, "id" | "approvedAt">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        questId,
        approval.leaderSessionId,
        approval.workerSessionId,
        approval.phaseOccurrenceId,
        approval.target,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** A worker can select an existing leader approval, never submit a target override directly. */
export function resolveDeliveryTargetApproval(input: {
  questId: string;
  leaderSessionId?: string;
  actorSessionId: string;
  phaseOccurrenceId: string;
  deliveryTargetId: string;
  existing?: Pick<QuestmasterTask, "deliveryTargetApprovals">;
  commitShas: string[];
}): QuestDeliveryTargetApproval {
  const approval = input.existing?.deliveryTargetApprovals?.find((item) => item.id === input.deliveryTargetId);
  if (
    !approval ||
    approval.leaderSessionId !== input.leaderSessionId ||
    approval.workerSessionId !== input.actorSessionId ||
    approval.phaseOccurrenceId !== input.phaseOccurrenceId
  ) {
    throw new DeliveryEvidenceError(
      "Delivery target approval does not belong to this assigned leader, worker and current Work occurrence.",
      403,
    );
  }
  const target = parsePublishedDeliveryTarget(approval.target);
  if (deliveryTargetApprovalId(input.questId, { ...approval, target }) !== approval.id)
    throw new DeliveryEvidenceError(
      "Stored delivery target approval is invalid; ask the assigned leader to record a fresh approval.",
    );
  const shas = [...new Set(target.refs.map((entry) => entry.sha))];
  if (JSON.stringify(input.commitShas) !== JSON.stringify(shas))
    throw new DeliveryEvidenceError(
      "Commit evidence must exactly match the approved published refs in delivery order.",
    );
  return { ...approval, target };
}

/** Read-only verification: exact remote heads plus local commit objects, without fetching or moving any ref. */
export async function verifyPublishedDeliveryTarget(target: PublishedDeliveryTarget): Promise<void> {
  const label = `${target.checkoutPath} (${target.remote})`;
  try {
    const root = await readGit(target.checkoutPath, ["rev-parse", "--show-toplevel"]);
    if ((await realpath(root)) !== (await realpath(target.checkoutPath)))
      throw new DeliveryEvidenceError(
        `Published delivery checkout must name the repository's checkout root: ${target.checkoutPath}.`,
      );
    const remote = await readGit(target.checkoutPath, ["remote", "get-url", target.remote]);
    if (remote !== target.repositoryUrl)
      throw new DeliveryEvidenceError(
        `Configured remote ${target.remote} at ${target.checkoutPath} differs from the approved repository URL.`,
      );
    for (const { ref, sha } of target.refs) {
      await readGit(target.checkoutPath, ["check-ref-format", ref]);
      if ((await resolveCommit(target.checkoutPath, sha)) !== sha)
        throw new DeliveryEvidenceError(`Published commit ${sha} is unavailable in ${label}.`);
    }
  } catch (error) {
    if (error instanceof DeliveryEvidenceError) throw error;
    throw new DeliveryEvidenceError(
      `Cannot verify local objects or configured remote for published delivery at ${label}. Restore the approved checkout/objects before recording; do not repeat a push to repair metadata.`,
    );
  }
  let output: string;
  try {
    // Restrict Git transport helpers; all values are separate argv entries, and publication is only read.
    output = await readGit(target.checkoutPath, [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      "protocol.file.allow=always",
      "ls-remote",
      "--refs",
      "--",
      target.repositoryUrl,
      ...target.refs.map((entry) => entry.ref),
    ]);
  } catch {
    throw new DeliveryEvidenceError(
      `Cannot read published refs for ${label}. Publication is unverified, not undone; retry read-only verification after restoring remote access, without repeating publication.`,
      503,
    );
  }
  const heads = new Map(
    output.split("\n").map((line) => {
      const [sha, ref] = line.split("\t");
      return [ref, sha];
    }),
  );
  for (const { ref, sha } of target.refs) {
    if (heads.get(ref) !== sha)
      throw new DeliveryEvidenceError(
        `Published target mismatch for ${ref} at ${label}: expected ${sha}, found ${heads.get(ref) ?? "missing"}. Ask the leader to reconcile the approved refs; do not repeat a push to repair evidence metadata.`,
      );
  }
}
