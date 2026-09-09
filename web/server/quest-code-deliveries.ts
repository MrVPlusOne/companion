import { createHash } from "node:crypto";
import type { QuestCodeDelivery, QuestDeliveredCommit, RetainedReviewRange } from "../shared/quest-delivery.js";
import { readCommitSummary, readGit } from "./git-commit-reader.js";
import { verifyReplacementWorkEvidence, type WorkEvidenceTargetCaller } from "./work-evidence-replacement.js";
import { inspectPort, ownedPlan, verifyReview, type PortTrackingContext } from "./port-tracking.js";

/** Verify one stable selected target before publishing any new delivery. */
export async function buildCodeDelivery(input: {
  questId: string;
  actorSessionId: string;
  phaseOccurrenceId: string;
  caller: WorkEvidenceTargetCaller;
  commitShas: string[];
  preparationId?: string;
  existing?: { commitShas?: string[]; codeDeliveries?: QuestCodeDelivery[] };
}): Promise<QuestCodeDelivery> {
  const verified = await verifyReplacementWorkEvidence(input.caller, input.commitShas);
  if ("error" in verified) throw new Error(verified.error);
  if (verified.commitShas.length === 0) throw new Error("A delivery requires at least one synchronized commit.");
  const target = {
    repoRoot: verified.repoRoot ?? verified.checkoutPath,
    checkoutPath: verified.checkoutPath,
    branch: verified.branch,
    mode: verified.mode,
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
