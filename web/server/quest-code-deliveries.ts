import { createHash } from "node:crypto";
import type { QuestCodeDelivery, QuestDeliveredCommit, RetainedReviewRange } from "../shared/quest-delivery.js";
import { readCommitSummary, readGit } from "./git-commit-reader.js";
import { verifyReplacementWorkEvidence, type WorkEvidenceTargetCaller } from "./work-evidence-replacement.js";
import { inspectPort, ownedPlan, verifyReview, type PortTrackingContext } from "./port-tracking.js";
import {
  DeliveryEvidenceError,
  resolveDeliveryTargetApproval,
  verifyPublishedDeliveryTarget,
} from "./published-delivery-target.js";
import type { QuestmasterTask } from "./quest-types.js";

/** Verify one stable selected target before publishing any new delivery. */
export async function buildCodeDelivery(input: {
  questId: string;
  actorSessionId: string;
  phaseOccurrenceId: string;
  caller: WorkEvidenceTargetCaller;
  commitShas: string[];
  preparationId?: string;
  deliveryTargetId?: string;
  leaderSessionId?: string;
  existing?: Pick<QuestmasterTask, "commitShas" | "codeDeliveries" | "deliveryTargetApprovals">;
}): Promise<QuestCodeDelivery> {
  if (input.deliveryTargetId && input.preparationId)
    throw new DeliveryEvidenceError(
      "Independent published targets cannot use inherited-target port preparations. Keep original review receipts separately.",
      400,
    );
  const approval = input.deliveryTargetId
    ? resolveDeliveryTargetApproval({ ...input, deliveryTargetId: input.deliveryTargetId })
    : undefined;
  if (approval) await verifyPublishedDeliveryTarget(approval.target);
  const lastRef = approval?.target.refs.at(-1);
  const verified =
    approval && lastRef
      ? {
          repoRoot: approval.target.checkoutPath,
          checkoutPath: approval.target.checkoutPath,
          branch: lastRef.ref.slice("refs/heads/".length),
          mode: "published" as const,
          headSha: lastRef.sha,
          commitShas: [...new Set(approval.target.refs.map((entry) => entry.sha))],
        }
      : await verifyReplacementWorkEvidence(input.caller, input.commitShas);
  if ("error" in verified) {
    const selected = input.caller.worktreePortTarget;
    throw new DeliveryEvidenceError(
      `${verified.error} Configured target: ${selected?.worktreePath ?? selected?.repoRoot ?? input.caller.cwd ?? "unknown"} (${selected?.branch ?? input.caller.actualBranch ?? input.caller.branch ?? "unknown"}). If approved publication used another target, ask the assigned leader to use approve-delivery-target, then supply --delivery-target. Do not repeat a push to repair evidence metadata.`,
      verified.status,
    );
  }
  if (verified.commitShas.length === 0) throw new Error("A delivery requires at least one synchronized commit.");
  const target = {
    repoRoot: verified.repoRoot ?? verified.checkoutPath,
    checkoutPath: verified.checkoutPath,
    branch: verified.branch,
    mode: verified.mode,
    ...(approval ? { publication: { ...approval.target, approvalId: approval.id } } : {}),
  };
  const freshShas = verified.commitShas.filter(
    (sha) => !input.existing?.commitShas?.some((old) => sha.startsWith(old.toLowerCase())),
  );
  if (input.existing && freshShas.length === 0) {
    const requested = new Set(verified.commitShas);
    const existing = input.existing.codeDeliveries?.findLast(
      (delivery) =>
        delivery.actorSessionId === input.actorSessionId &&
        delivery.phaseOccurrenceId === input.phaseOccurrenceId &&
        delivery.target.repoRoot === target.repoRoot &&
        delivery.target.branch === target.branch &&
        delivery.target.checkoutPath === target.checkoutPath &&
        delivery.target.mode === target.mode &&
        delivery.target.publication?.approvalId === target.publication?.approvalId &&
        delivery.commits.every((commit) => requested.has(commit.sha)),
    );
    if (!existing)
      throw new Error(
        "No fresh delivery evidence for this Work occurrence. Historical SHAs do not authorize invented delivery provenance.",
      );
    for (const review of [
      ...existing.commits.flatMap((commit) => (commit.review ? [commit.review] : [])),
      ...(existing.earlierReviews ?? []),
    ]) {
      await verifyReview(target.repoRoot, review);
    }
    if (
      input.preparationId &&
      !existing.commits.some((commit) => commit.review?.ref.includes(`/${input.preparationId}/`))
    ) {
      throw new Error("Preparation does not match the already recorded delivery.");
    }
    await assertDeliveryHead(target, verified.headSha);
    return existing;
  }
  const deliveryShas = input.existing ? freshShas : verified.commitShas;
  const commits: QuestDeliveredCommit[] = [];
  for (const sha of deliveryShas) commits.push(await readCommitSummary(target.checkoutPath, sha));
  let earlierReviews: RetainedReviewRange[] | undefined;
  if (input.preparationId) {
    const context = await portContext(input, target);
    const plan = await ownedPlan(context, input.preparationId);
    if (plan.phaseOccurrenceId !== input.phaseOccurrenceId)
      throw new Error("Preparation belongs to an earlier Work occurrence; record fresh delivery evidence.");
    if ((await inspectPort(context, plan.id)).state !== "landed")
      throw new Error("Port receipts are incomplete or uncertain.");
    if (JSON.stringify(plan.groups.map((group) => group.targetSha)) !== JSON.stringify(deliveryShas)) {
      throw new Error("Delivery commits must exactly match the preparation's ordered landed receipts.");
    }
    for (const [index, group] of plan.groups.entries()) {
      await verifyReview(context.cwd, group);
      const source = await readGit(context.cwd, [
        "show-ref",
        "--hash",
        "--verify",
        `refs/takode/sealed/${plan.id}/${index}`,
      ]);
      if (source !== group.workerSha) throw new Error("Retained sealed commit differs from its receipt.");
      commits[index] = {
        ...commits[index]!,
        workerSha: group.workerSha,
        review: { ref: group.ref, baseSha: group.baseSha, tipSha: group.tipSha, commitShas: group.commitShas },
      };
    }
    earlierReviews = plan.earlierReviews;
    for (const review of earlierReviews ?? []) await verifyReview(context.cwd, review);
  }
  await assertDeliveryHead(target, verified.headSha);
  const id = createHash("sha256")
    .update(JSON.stringify([input.questId, input.actorSessionId, input.phaseOccurrenceId, target, deliveryShas]))
    .digest("hex")
    .slice(0, 32);
  return {
    id,
    recordedAt: Date.now(),
    actorSessionId: input.actorSessionId,
    phaseOccurrenceId: input.phaseOccurrenceId,
    target,
    targetHeadSha: verified.headSha,
    commits,
    ...(earlierReviews?.length ? { earlierReviews } : {}),
  };
}

async function assertDeliveryHead(target: QuestCodeDelivery["target"], expected: string): Promise<void> {
  if (target.mode === "published") {
    if (!target.publication)
      throw new DeliveryEvidenceError("Published delivery lacks its approved target descriptor.");
    await verifyPublishedDeliveryTarget(target.publication);
    return;
  }
  const [branch, head] = await Promise.all([
    readGit(target.checkoutPath, ["symbolic-ref", "--short", "HEAD"]),
    readGit(target.checkoutPath, ["rev-parse", `refs/heads/${target.branch}`]),
  ]);
  if (branch !== target.branch || head !== expected) {
    throw new Error("Selected target changed while collecting delivery evidence; refresh and retry.");
  }
}

export async function portContext(
  input: { questId: string; actorSessionId: string; phaseOccurrenceId: string; caller: WorkEvidenceTargetCaller },
  target?: QuestCodeDelivery["target"],
): Promise<PortTrackingContext> {
  if (input.caller.isWorktree !== true || !input.caller.cwd)
    throw new Error("Port tracking requires an isolated worker worktree.");
  const verified = target ? null : await verifyReplacementWorkEvidence(input.caller, []);
  if (verified && "error" in verified) throw new Error(verified.error);
  const selected =
    target ??
    (verified && !("error" in verified)
      ? {
          repoRoot: verified.repoRoot ?? verified.checkoutPath,
          checkoutPath: verified.checkoutPath,
          branch: verified.branch,
          mode: verified.mode,
        }
      : null);
  if (!selected) throw new Error("Cannot resolve selected target.");
  if (selected.mode === "published")
    throw new Error("Independent published targets do not use inherited-target port tracking.");
  const branch = input.caller.actualBranch ?? input.caller.branch;
  if (!branch || branch === selected.branch)
    throw new Error("Private worker branch must differ from the delivery target.");
  return {
    questId: input.questId,
    actorSessionId: input.actorSessionId,
    phaseOccurrenceId: input.phaseOccurrenceId,
    cwd: input.caller.cwd,
    branch,
    target: selected,
  };
}
