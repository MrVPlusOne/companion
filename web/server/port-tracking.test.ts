import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGit, readCommitPatch, readCommitSummary } from "./git-commit-reader.js";
import {
  preparePort,
  sealPort,
  inspectPort,
  recordLandedCommit,
  verifyReview,
  type PortTrackingContext,
} from "./port-tracking.js";
import { loadPortPlan } from "./port-tracking-store.js";
import { buildCodeDelivery } from "./quest-code-deliveries.js";

let root: string;
let repo: string;
let worker: string;
let base: string;
let context: PortTrackingContext;

beforeEach(async () => {
  // All branch rewrites, worktree deletion, and GC below are confined to this newly created repository.
  root = await realpath(await mkdtemp(join(tmpdir(), "port-tracking-test-")));
  repo = join(root, "repo");
  worker = join(root, "worker");
  await mkdir(repo);
  await readGit(repo, ["init", "-b", "integration"]);
  await readGit(repo, ["config", "user.name", "Fixture Author"]);
  await readGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  await readGit(repo, ["config", "core.hooksPath", join(root, "empty-hooks")]);
  base = await commit(repo, "base\n", "base.txt");
  await readGit(repo, ["worktree", "add", "-b", "private-work", worker, "integration"]);
  context = {
    questId: "q-1",
    actorSessionId: "worker",
    phaseOccurrenceId: "work-occurrence",
    cwd: worker,
    branch: "private-work",
    target: { repoRoot: repo, checkoutPath: repo, branch: "integration", mode: "remote-backed" },
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commit(cwd: string, contents: string, path = "feature.txt"): Promise<string> {
  await writeFile(join(cwd, path), contents);
  await readGit(cwd, ["add", path]);
  await readGit(cwd, ["commit", "-m", `Update ${path}`]);
  return readGit(cwd, ["rev-parse", "HEAD"]);
}

async function squash(): Promise<string> {
  await readGit(worker, ["reset", "--soft", base]);
  await readGit(worker, ["commit", "-m", "Deliver cohesive change"]);
  return readGit(worker, ["rev-parse", "HEAD"]);
}

async function land(sha: string): Promise<string> {
  // A different committer guarantees that source and target SHAs differ even in a fast test.
  await readGit(repo, ["-c", "user.name=Fixture Porter", "cherry-pick", sha]);
  return readGit(repo, ["rev-parse", "HEAD"]);
}

describe("squash-aware port tracking in disposable repositories", () => {
  it("records a later private fix without rewriting or redisplaying the already-landed prefix", async () => {
    // Two deliveries share a quest; independent target changes must retain their exact identities.
    const caller = {
      isWorktree: true,
      cwd: worker,
      actualBranch: context.branch,
      worktreePortTarget: { repoRoot: repo, branch: "integration" },
    };
    await commit(worker, "one\n");
    await commit(worker, "one\ntwo\n");
    const firstPlan = await preparePort(context, { baseSha: base, confirmPrivate: true });
    const firstSource = await squash();
    await sealPort(context, firstPlan.id, [firstSource]);
    const firstTarget = await land(firstSource);
    await recordLandedCommit(context, firstPlan.id, firstSource, firstTarget);
    const firstDelivery = await buildCodeDelivery({
      ...context,
      caller,
      commitShas: [firstTarget],
      preparationId: firstPlan.id,
    });
    await readGit(worker, ["reset", "--hard", "integration"]);
    context = { ...context, phaseOccurrenceId: "later-work" };
    await commit(worker, "one\ntwo\nfix one\n");
    await commit(worker, "one\ntwo\nfix one\nfix two\n");
    const otherFirst = await commit(repo, "independent one\n", "other.txt");
    const otherSecond = await commit(repo, "independent two\n", "other.txt");
    const draft = await preparePort(context, { baseSha: firstTarget, confirmPrivate: true });
    await readGit(worker, ["rebase", "--onto", "integration", firstTarget]);
    base = otherSecond;
    const prepared = await preparePort(context, { baseSha: base, previousId: draft.id, confirmPrivate: true });
    const source = await squash();
    await sealPort(context, prepared.id, [source]);
    const target = await land(source);
    await recordLandedCommit(context, prepared.id, source, target);
    const later = await buildCodeDelivery({
      ...context,
      caller,
      commitShas: [firstTarget, target],
      preparationId: prepared.id,
      existing: { commitShas: [firstTarget], codeDeliveries: [firstDelivery] },
    });
    expect(later.commits.map((item) => item.sha)).toEqual([target]);
    expect(firstDelivery.commits.map((item) => item.sha)).toEqual([firstTarget]);
    expect(await readGit(repo, ["rev-parse", `${target}^`])).toBe(otherSecond);
    expect(await readGit(repo, ["rev-parse", `${otherSecond}^`])).toBe(otherFirst);
    expect(await readGit(repo, ["rev-parse", `${otherFirst}^`])).toBe(firstTarget);
    expect(
      await buildCodeDelivery({
        ...context,
        caller,
        commitShas: [firstTarget, target],
        preparationId: prepared.id,
        existing: { commitShas: [firstTarget, target], codeDeliveries: [firstDelivery, later] },
      }),
    ).toBe(later);
    await expect(
      buildCodeDelivery({
        ...context,
        caller,
        commitShas: [firstTarget],
        existing: { commitShas: [firstTarget], codeDeliveries: [firstDelivery] },
      }),
    ).rejects.toThrow("No fresh delivery");
  }, 30_000);

  it("retains incremental and sealed objects through cleanup and GC, and records only the delivered SHA", async () => {
    const first = await commit(worker, "first\n");
    const second = await commit(worker, "first\nsecond\n");
    const plan = await preparePort(context, { baseSha: base, confirmPrivate: true });
    expect(await readGit(worker, ["rev-parse", "HEAD"])).toBe(second);
    expect((await preparePort(context, { baseSha: base, confirmPrivate: true })).id).toBe(plan.id);
    const final = await squash();
    await sealPort(context, plan.id, [final]);
    expect((await inspectPort(context, plan.id)).state).toBe("ready-to-port");
    const target = await land(final);
    expect(target).not.toBe(final);
    expect((await inspectPort(context, plan.id)).state).toBe("uncertain");
    await recordLandedCommit(context, plan.id, final, target);
    await recordLandedCommit(context, plan.id, final, target);
    expect((await inspectPort(context, plan.id)).state).toBe("landed");
    const delivery = await buildCodeDelivery({
      questId: context.questId,
      actorSessionId: context.actorSessionId,
      phaseOccurrenceId: context.phaseOccurrenceId,
      commitShas: [target],
      preparationId: plan.id,
      caller: {
        isWorktree: true,
        cwd: worker,
        actualBranch: context.branch,
        worktreePortTarget: { repoRoot: repo, branch: "integration" },
      },
    });
    expect(delivery.commits.map((item) => item.sha)).toEqual([target]);
    expect(delivery.commits[0]!.review?.commitShas).toEqual([first, second]);
    expect(delivery.commits[0]!.workerSha).toBe(final);
    // Remove every worker-owned ordinary ref/reflog before GC to exercise actual retention, not accidental reachability.
    await readGit(repo, ["worktree", "remove", worker]);
    await readGit(repo, ["branch", "-D", "private-work"]);
    await readGit(repo, ["reflog", "expire", "--expire=now", "--all"]);
    await readGit(repo, ["gc", "--prune=now"]);
    await verifyReview(repo, delivery.commits[0]!.review!);
    expect((await readCommitPatch(repo, first)).diff).toContain("+first");
    expect((await readCommitPatch(repo, second)).diff).toContain("+second");
    expect(await readGit(repo, ["rev-parse", `refs/takode/sealed/${plan.id}/0`])).toBe(final);
    expect((await loadPortPlan(repo, plan.id)).groups[0]!.targetSha).toBe(target);
  });

  it("preserves meaningful separate groups and refuses to bypass an interrupted partial port", async () => {
    const first = await commit(worker, "one\n");
    const second = await commit(worker, "two\n", "other.txt");
    const plan = await preparePort(context, { baseSha: base, groupTips: [first, second], confirmPrivate: true });
    await sealPort(context, plan.id, [first, second]);
    const landed = await land(first);
    // A missing receipt must not be interpreted as permission to squash the original range again.
    await expect(preparePort(context, { baseSha: base, confirmPrivate: true })).rejects.toThrow(
      "Reconcile preparation",
    );
    await recordLandedCommit(context, plan.id, first, landed);
    const partial = await inspectPort(context, plan.id);
    expect(partial.state).toBe("partial");
    expect(partial.remaining).toEqual([second]);
    await expect(preparePort(context, { baseSha: base, confirmPrivate: true, previousId: plan.id })).rejects.toThrow(
      "previously landed",
    );
    const target = await land(second);
    await recordLandedCommit(context, plan.id, second, target);
    expect((await inspectPort(context, plan.id)).state).toBe("landed");
  });

  it("retains both review versions when unrelated target changes require a rebase", async () => {
    const original = await commit(worker, "private\n");
    await commit(repo, "unrelated\n", "other.txt");
    const plan = await preparePort(context, { baseSha: base, confirmPrivate: true });
    expect((await inspectPort(context, plan.id)).state).toBe("needs-rebase");
    await readGit(worker, ["rebase", "integration"]);
    const newBase = await readGit(repo, ["rev-parse", "HEAD"]);
    const rebased = await readGit(worker, ["rev-parse", "HEAD"]);
    const refreshed = await preparePort(context, { baseSha: newBase, confirmPrivate: true, previousId: plan.id });
    expect(refreshed.earlierReviews?.[0]!.commitShas).toEqual([original]);
    expect(refreshed.groups[0]!.commitShas).toEqual([rebased]);
    expect((await inspectPort(context, plan.id)).state).toBe("superseded");
    await sealPort(context, refreshed.id, [rebased]);
    const target = await land(rebased);
    await recordLandedCommit(context, refreshed.id, rebased, target);
    expect(await readGit(repo, ["rev-parse", `${target}^`])).toBe(newBase);
  });

  it("flags target advancement and reconciles an exact disjoint-file port without changing the prefix", async () => {
    const first = await commit(worker, "one\n");
    const second = await commit(worker, "two\n", "other.txt");
    const plan = await preparePort(context, { baseSha: base, groupTips: [first, second], confirmPrivate: true });
    await sealPort(context, plan.id, [first, second]);
    const target = await land(first);
    await recordLandedCommit(context, plan.id, first, target);
    const advanced = await commit(repo, "another agent\n", "independent.txt");
    expect((await inspectPort(context, plan.id)).state).toBe("uncertain");
    await expect(preparePort(context, { baseSha: target, confirmPrivate: true })).rejects.toThrow();
    expect(await readGit(repo, ["rev-parse", "HEAD"])).toBe(advanced);
    expect(await readGit(repo, ["rev-parse", `${advanced}^`])).toBe(target);
    const final = await land(second);
    await recordLandedCommit(context, plan.id, second, final);
    expect((await inspectPort(context, plan.id)).state).toBe("landed");
    expect(await readGit(repo, ["rev-parse", `${final}^`])).toBe(advanced);
  });

  it("does not accept a changed-base receipt that overwrites another agent's file changes", async () => {
    const first = await commit(worker, "one\n");
    const second = await commit(worker, "two\n", "other.txt");
    const plan = await preparePort(context, { baseSha: base, groupTips: [first, second], confirmPrivate: true });
    await sealPort(context, plan.id, [first, second]);
    const target = await land(first);
    await recordLandedCommit(context, plan.id, first, target);
    await commit(repo, "another agent's content\n", "other.txt");
    // Simulate an incorrect conflict resolution only in the disposable fixture.
    const overwrite = await commit(repo, "two\n", "other.txt");
    await expect(recordLandedCommit(context, plan.id, second, overwrite)).rejects.toThrow("file/blob changes");
    expect((await inspectPort(context, plan.id)).state).toBe("uncertain");
  });

  it("rejects content-changing replacements, dirty work, published commits, and mixed authors", async () => {
    const first = await commit(worker, "reviewed\n");
    const plan = await preparePort(context, { baseSha: base, confirmPrivate: true });
    await writeFile(join(worker, "feature.txt"), "uncommitted\n");
    await expect(sealPort(context, plan.id, [first])).rejects.toThrow("uncommitted");
    const changed = await commit(worker, "changed after review\n");
    await expect(sealPort(context, plan.id, [changed])).rejects.toThrow("parent/tree");
    await readGit(worker, ["update-ref", "refs/remotes/example/private", changed]);
    await expect(preparePort(context, { baseSha: base, confirmPrivate: true })).rejects.toThrow("remote-tracking");
    await readGit(worker, ["update-ref", "-d", "refs/remotes/example/private"]);
    await writeFile(join(worker, "feature.txt"), "different author\n");
    await readGit(worker, ["add", "feature.txt"]);
    await readGit(worker, ["commit", "--author=Other <other@example.invalid>", "-m", "Other work"]);
    await expect(preparePort(context, { baseSha: base, confirmPrivate: true })).rejects.toThrow("Mixed-author");
  });

  it("keeps binary and whitespace-sensitive changes honest in compact summaries and full patches", async () => {
    await writeFile(join(worker, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(worker, "name with spaces.txt"), "line with trailing spaces  \n");
    await readGit(worker, ["add", "."]);
    await readGit(worker, ["commit", "-m", "Binary and text"]);
    const sha = await readGit(worker, ["rev-parse", "HEAD"]);
    const summary = await readCommitSummary(worker, sha);
    expect(summary.binaryFiles).toBe(1);
    expect(summary.additions).toBe(1);
    expect(summary).not.toHaveProperty("diff");
    expect((await readCommitPatch(worker, sha)).diff).toContain("+line with trailing spaces  \n");
  });
});
