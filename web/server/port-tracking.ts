import { createHash } from "node:crypto";
import type { DeliveryTarget, RetainedReviewRange } from "../shared/quest-delivery.js";
import { isAncestor, readGit, resolveCommit } from "./git-commit-reader.js";
import { loadPortPlan, savePortPlan, previousPortPlans, type PortPlan } from "./port-tracking-store.js";

export interface PortTrackingContext {
  questId: string;
  actorSessionId: string;
  phaseOccurrenceId: string;
  cwd: string;
  branch: string;
  target: DeliveryTarget;
}

export interface PortTrackingStatus {
  id: string;
  state: "retained" | "needs-rebase" | "ready-to-port" | "partial" | "landed" | "uncertain" | "superseded";
  landed: Array<{ workerSha: string; targetSha: string }>;
  remaining: string[];
  nextAction: string;
}

/** Retain explicit private review groups. This never rewrites a branch. */
export async function preparePort(
  context: PortTrackingContext,
  input: { baseSha: string; groupTips?: string[]; confirmPrivate: boolean; previousId?: string },
): Promise<PortPlan> {
  if (!input.confirmPrivate) throw new Error("Explicitly confirm this exact range is private and owned by this work.");
  await assertSharedRepository(context);
  await assertCleanWorker(context);
  const headSha = await readGit(context.cwd, ["rev-parse", "HEAD"]);
  const baseSha = await resolveCommit(context.cwd, input.baseSha);
  const targetHeadSha = await targetHead(context);
  const commits = await linearRange(context.cwd, baseSha, headSha);
  await assertPrivateRange(context, commits, targetHeadSha);
  const groupTips = input.groupTips?.length
    ? await Promise.all(input.groupTips.map((tip) => resolveCommit(context.cwd, tip)))
    : [headSha];
  if (groupTips.length > 50 || (input.groupTips !== undefined && input.groupTips.length === 0))
    throw new Error("Choose between one and 50 cohesive groups.");
  if (groupTips.at(-1) !== headSha) throw new Error("The last group must end at the current worker HEAD.");
  let offset = 0;
  const groups: PortPlan["groups"] = [];
  const identity = [
    context.questId,
    context.actorSessionId,
    context.phaseOccurrenceId,
    context.branch,
    context.target,
    baseSha,
    headSha,
    groupTips,
    input.previousId ?? null,
  ];
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
  for (const known of await previousPortPlans(context.cwd, context.actorSessionId, context.branch)) {
    const protectedShas = new Set(
      known.groups
        .filter((group) => group.targetSha)
        .flatMap((group) => [...group.commitShas, group.workerSha!, group.targetSha!]),
    );
    if (commits.some((sha) => protectedShas.has(sha)))
      throw new Error("The candidate range includes previously landed source/review commits.");
    if (
      !known.supersededBy &&
      known.groups.some((group) => !group.targetSha) &&
      known.id !== id &&
      known.id !== input.previousId
    ) {
      throw new Error(
        `Reconcile preparation ${known.id} first; do not bypass an uncertain or partial port by creating a new preparation.`,
      );
    }
  }
  for (const [index, tipSha] of groupTips.entries()) {
    const end = commits.indexOf(tipSha, offset);
    if (end < offset) throw new Error("Group tips must partition the private range in chronological order.");
    groups.push({
      ref: `refs/takode/review/${id}/${index}`,
      baseSha: offset === 0 ? baseSha : commits[offset - 1]!,
      tipSha,
      commitShas: commits.slice(offset, end + 1),
    });
    offset = end + 1;
  }
  const previous = input.previousId ? await ownedPlan(context, input.previousId) : undefined;
  if (previous && previous.supersededBy && previous.supersededBy !== id) {
    throw new Error("The earlier preparation was already superseded by a different preparation.");
  }
  if (previous && previous.groups.some((group) => group.targetSha)) {
    throw new Error(
      "A partial/landed port cannot be replaced. Start a new preparation for only the remaining private work.",
    );
  }
  if (previous && previous.targetHeadSha !== targetHeadSha && previous.groups.some((group) => group.workerSha)) {
    throw new Error(
      "The target advanced after sealing. Reconcile possible partial port receipts before preparing new work.",
    );
  }
  const plan: PortPlan = {
    version: 1,
    id,
    questId: context.questId,
    actorSessionId: context.actorSessionId,
    phaseOccurrenceId: context.phaseOccurrenceId,
    branch: context.branch,
    createdAt: Date.now(),
    baseSha,
    headSha,
    target: context.target,
    targetHeadSha,
    groups,
    ...(previous ? { earlierReviews: [...(previous.earlierReviews ?? []), ...previous.groups.map(reviewOnly)] } : {}),
  };
  // Each ref is create-only. A retry accepts only its exact existing value.
  for (const group of groups) await retainReview(context.cwd, group);
  await assertCleanWorker(context);
  if (
    (await readGit(context.cwd, ["rev-parse", "HEAD"])) !== headSha ||
    (await targetHead(context)) !== targetHeadSha
  ) {
    throw new Error(
      "Worker or target HEAD changed during preparation. Retained refs remain safe; refresh before proceeding.",
    );
  }
  try {
    const existing = await loadPortPlan(context.cwd, id);
    assertPlanOwner(context, existing);
    // Recover an interrupted journal/index or supersession write before acknowledging a retry.
    await savePortPlan(context.cwd, existing);
    if (previous) await savePortPlan(context.cwd, { ...previous, supersededBy: id });
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await savePortPlan(context.cwd, plan);
  if (previous) await savePortPlan(context.cwd, { ...previous, supersededBy: id });
  return plan;
}

/** Validate and remember one final commit per retained cohesive group. */
export async function sealPort(context: PortTrackingContext, id: string, shas: string[]): Promise<PortPlan> {
  const plan = await ownedPlan(context, id);
  if (plan.supersededBy) throw new Error("This preparation was superseded; use the newer preparation.");
  const replacements = await Promise.all(shas.map((sha) => resolveCommit(context.cwd, sha)));
  if (replacements.length !== plan.groups.length)
    throw new Error("Supply exactly one final commit per prepared group.");
  if (plan.groups.every((group, i) => group.workerSha === replacements[i])) return plan;
  if (plan.groups.some((group) => group.workerSha || group.targetSha))
    throw new Error("A sealed or landed preparation cannot be rewritten.");
  await assertCleanWorker(context);
  if ((await targetHead(context)) !== plan.targetHeadSha || plan.baseSha !== plan.targetHeadSha) {
    throw new Error("Rebase and review against the current target, then prepare a fresh range before sealing.");
  }
  if ((await readGit(context.cwd, ["rev-parse", "HEAD"])) !== replacements.at(-1)) {
    throw new Error("Final commits must end at the exact current worker HEAD.");
  }
  let parent = plan.baseSha;
  for (const [index, sha] of replacements.entries()) {
    const group = plan.groups[index]!;
    await verifyReview(context.cwd, group);
    const parents = await readGit(context.cwd, ["show", "-s", "--format=%P", sha]);
    const [tree, reviewedTree] = await Promise.all([
      readGit(context.cwd, ["rev-parse", `${sha}^{tree}`]),
      readGit(context.cwd, ["rev-parse", `${group.tipSha}^{tree}`]),
    ]);
    if (parents !== parent || tree !== reviewedTree)
      throw new Error("Replacement parent/tree does not match its reviewed group.");
    parent = sha;
  }
  if ((await targetHead(context)) !== plan.targetHeadSha)
    throw new Error("Target changed during sealing; inspect before retrying.");
  const sealed = {
    ...plan,
    groups: plan.groups.map((group, index) => ({ ...group, workerSha: replacements[index]! })),
  };
  for (const [index, sha] of replacements.entries()) {
    await retainCommit(context.cwd, `refs/takode/sealed/${plan.id}/${index}`, sha);
  }
  await savePortPlan(context.cwd, sealed);
  return sealed;
}

/** Record a proven target write, including a partial port, without altering Git history. */
export async function recordLandedCommit(
  context: PortTrackingContext,
  id: string,
  workerSha: string,
  targetSha: string,
): Promise<PortPlan> {
  const plan = await ownedPlan(context, id);
  if (plan.supersededBy) throw new Error("This preparation was superseded.");
  const source = await resolveCommit(context.cwd, workerSha);
  const target = await resolveCommit(context.target.checkoutPath, targetSha);
  const index = plan.groups.findIndex((group) => group.workerSha === source);
  if (index < 0) throw new Error("Source commit is not a sealed commit in this preparation.");
  if (plan.groups[index]!.targetSha) {
    if (plan.groups[index]!.targetSha !== target) throw new Error("A landed receipt cannot be replaced.");
    return plan;
  }
  if (plan.groups.slice(0, index).some((group) => !group.targetSha)) throw new Error("Record landed commits in order.");
  const head = await targetHead(context);
  if (!(await isAncestor(context.target.checkoutPath, target, head)))
    throw new Error("Commit is not on the selected target.");
  const expectedParent = index === 0 ? plan.targetHeadSha : plan.groups[index - 1]!.targetSha!;
  const [parent, targetTree, sourceTree] = await Promise.all([
    readGit(context.target.checkoutPath, ["show", "-s", "--format=%P", target]),
    readGit(context.target.checkoutPath, ["rev-parse", `${target}^{tree}`]),
    readGit(context.cwd, ["rev-parse", `${source}^{tree}`]),
  ]);
  if (parent !== expectedParent || targetTree !== sourceTree) {
    if (!/^[a-f0-9]{40}$/.test(parent) || !(await isAncestor(context.target.checkoutPath, expectedParent, parent))) {
      throw new Error("Target commit does not preserve the already-landed prefix.");
    }
    const sourceParent = await readGit(context.cwd, ["show", "-s", "--format=%P", source]);
    const args = ["diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "-r", "-z"];
    const [sourceChange, targetChange] = await Promise.all([
      readGit(context.cwd, [...args, sourceParent, source]),
      readGit(context.target.checkoutPath, [...args, parent, target]),
    ]);
    // Exact path/mode/before-blob/after-blob equality permits unrelated intervening files;
    // unlike patch-id or textual similarity, it cannot hide overwritten shared-file changes.
    if (sourceChange !== targetChange) {
      throw new Error(
        "Target changes differ from the retained file/blob changes. Reconcile and review this changed-base port explicitly.",
      );
    }
  }
  if ((await targetHead(context)) !== head)
    throw new Error("Target changed during receipt verification; retry after inspecting it.");
  const updated = {
    ...plan,
    groups: plan.groups.map((group, i) => (i === index ? { ...group, targetSha: target } : group)),
  };
  await savePortPlan(context.cwd, updated);
  return updated;
}

export async function inspectPort(context: PortTrackingContext, id: string): Promise<PortTrackingStatus> {
  const plan = await ownedPlan(context, id);
  const landed = plan.groups
    .filter((group) => group.targetSha)
    .map((group) => ({ workerSha: group.workerSha!, targetSha: group.targetSha! }));
  const remaining = plan.groups.filter((group) => !group.targetSha).map((group) => group.workerSha ?? group.tipSha);
  const status = (state: PortTrackingStatus["state"], nextAction: string): PortTrackingStatus => ({
    id,
    state,
    landed,
    remaining,
    nextAction,
  });
  if (plan.supersededBy) return status("superseded", `Continue preparation ${plan.supersededBy}.`);
  const head = await targetHead(context);
  for (const receipt of landed) {
    if (!(await isAncestor(context.target.checkoutPath, receipt.targetSha, head))) {
      return status(
        "uncertain",
        "A recorded landing is absent from the selected target. Reconcile target history; do not squash.",
      );
    }
  }
  for (const group of plan.groups) await verifyReview(context.cwd, group);
  const workerHead = await readGit(context.cwd, ["rev-parse", "HEAD"]);
  if (
    plan.groups.every((group) => group.workerSha) &&
    ![plan.groups.at(-1)!.workerSha, landed.at(-1)?.targetSha, head].includes(workerHead)
  ) {
    return {
      ...status(
        "uncertain",
        "Worker HEAD changed beyond this preparation. Preserve and account for that work before any cleanup/reset.",
      ),
      remaining: [...remaining, workerHead],
    };
  }
  if (remaining.length === 0)
    return status(
      "landed",
      "Run the selected-target verification/publication gate, then record this delivery in the Work handoff.",
    );
  const knownTargetHead = landed.at(-1)?.targetSha ?? plan.targetHeadSha;
  if (head !== knownTargetHead) {
    return status(
      "uncertain",
      "The target advanced. Remaining entries are unconfirmed, not proven private. Inspect possible partial ports and record exact landed receipts before further rewriting.",
    );
  }
  if (landed.length > 0)
    return status(
      "partial",
      "Keep landed history intact. Port only the remaining sealed commits after verifying the current target.",
    );
  if (plan.baseSha !== head)
    return status(
      "needs-rebase",
      "Review is retained. Rebase/review the private range, then prepare again with --previous and the new base.",
    );
  if (plan.groups.every((group) => group.workerSha))
    return status(
      "ready-to-port",
      "Port these sealed commits in order; record each target SHA immediately with landed.",
    );
  return status(
    "retained",
    "Review refs are retained. Squash the cohesive groups using Git, then seal the final commit SHAs.",
  );
}

export async function ownedPlan(context: PortTrackingContext, id: string): Promise<PortPlan> {
  await assertSharedRepository(context);
  const plan = await loadPortPlan(context.cwd, id);
  assertPlanOwner(context, plan);
  return plan;
}

export async function verifyReview(cwd: string, review: RetainedReviewRange): Promise<void> {
  if ((await readGit(cwd, ["show-ref", "--hash", "--verify", review.ref])) !== review.tipSha) {
    throw new Error("Retained review reference does not match its recorded tip.");
  }
  const commits = await linearRange(cwd, review.baseSha, review.tipSha);
  if (JSON.stringify(commits) !== JSON.stringify(review.commitShas)) throw new Error("Retained review range changed.");
}

function assertPlanOwner(context: PortTrackingContext, plan: PortPlan): void {
  if (
    plan.questId !== context.questId ||
    plan.actorSessionId !== context.actorSessionId ||
    plan.branch !== context.branch ||
    JSON.stringify(plan.target) !== JSON.stringify(context.target)
  ) {
    throw new Error("Preparation belongs to a different worker, quest, branch, or target.");
  }
}

async function assertCleanWorker(context: PortTrackingContext): Promise<void> {
  if ((await readGit(context.cwd, ["symbolic-ref", "--short", "HEAD"])) !== context.branch)
    throw new Error("Worker branch changed.");
  if (await readGit(context.cwd, ["status", "--porcelain"]))
    throw new Error("Worker has uncommitted changes; preserve them before preparing or sealing.");
}

async function targetHead(context: PortTrackingContext): Promise<string> {
  if ((await readGit(context.target.checkoutPath, ["symbolic-ref", "--short", "HEAD"])) !== context.target.branch) {
    throw new Error("Selected target checkout is on a different branch.");
  }
  return readGit(context.target.checkoutPath, ["rev-parse", "HEAD"]);
}

async function linearRange(cwd: string, base: string, tip: string): Promise<string[]> {
  if (!(await isAncestor(cwd, base, tip))) throw new Error("Review base is not an ancestor of its tip.");
  const rows = (await readGit(cwd, ["rev-list", "--reverse", "--parents", `${base}..${tip}`]))
    .split("\n")
    .filter(Boolean);
  if (rows.length === 0 || rows.length > 500) throw new Error("Choose a nonempty review range of at most 500 commits.");
  const commits: string[] = [];
  let parent = base;
  for (const row of rows) {
    const values = row.split(" ");
    if (values.length !== 2 || values[1] !== parent)
      throw new Error(
        "Only a contiguous linear private range is supported; keep merges and ambiguous ranges unsquashed.",
      );
    commits.push(values[0]!);
    parent = values[0]!;
  }
  return commits;
}

async function assertPrivateRange(context: PortTrackingContext, commits: string[], target: string): Promise<void> {
  // In a proven linear range, any published descendant also makes its first commit reachable.
  const first = commits[0]!;
  if (await isAncestor(context.target.checkoutPath, first, target))
    throw new Error("The range includes an already-landed commit.");
  const published = await readGit(context.cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    first,
    "refs/remotes",
  ]);
  if (published) throw new Error("The range includes a commit reachable from a remote-tracking branch.");
  const authors = new Set(
    (await readGit(context.cwd, ["log", "--format=%ae", `${first}^..${commits.at(-1)}`])).split("\n"),
  );
  if (authors.size !== 1)
    throw new Error("Mixed-author review range requires a separate plan; do not automatically squash it.");
}

async function retainReview(cwd: string, review: RetainedReviewRange): Promise<void> {
  await retainCommit(cwd, review.ref, review.tipSha);
  await verifyReview(cwd, review);
}

async function retainCommit(cwd: string, ref: string, sha: string): Promise<void> {
  try {
    await readGit(cwd, ["update-ref", ref, sha, "0".repeat(40)]);
  } catch (error) {
    if ((await readGit(cwd, ["show-ref", "--hash", "--verify", ref])) !== sha) throw error;
  }
}

async function assertSharedRepository(context: PortTrackingContext): Promise<void> {
  const [worker, target] = await Promise.all(
    [context.cwd, context.target.checkoutPath].map((cwd) =>
      readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ),
  );
  if (worker !== target) throw new Error("Worker and selected target must share the same Git repository.");
}

function reviewOnly(group: PortPlan["groups"][number]): RetainedReviewRange {
  return { ref: group.ref, baseSha: group.baseSha, tipSha: group.tipSha, commitShas: group.commitShas };
}
