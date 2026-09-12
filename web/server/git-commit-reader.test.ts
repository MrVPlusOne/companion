import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommitDetails, readCommitPatch, readCommitSummary, readGit } from "./git-commit-reader.js";

let repo: string;
let root: string;

async function commitTree(parents: string[], message: string) {
  const tree = await readGit(repo, ["write-tree"]);
  return readGit(repo, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]);
}

beforeEach(async () => {
  // All objects/index writes and cleanup belong to this freshly created disposable repository.
  repo = await mkdtemp(join(tmpdir(), "commit-comparison-"));
  await readGit(repo, ["-c", "init.templateDir=", "init"]);
  await readGit(repo, ["config", "user.name", "Comparison Fixture"]);
  await readGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "runtime.txt"), "old runtime\n");
  await readGit(repo, ["add", "runtime.txt"]);
  root = await commitTree([], "Initial files");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("explicit commit comparisons", () => {
  it("uses the empty tree for roots and keeps metadata-only requests free of stats and patches", async () => {
    const metadata = await readCommitDetails(repo, root, false);
    expect(metadata.comparison).toEqual({ method: "first-parent-v1", baseSha: null, parentCount: 0 });
    expect(metadata).not.toHaveProperty("diff");
    expect(metadata).not.toHaveProperty("additions");
    const full = await readCommitDetails(repo, root, true);
    expect(full).toMatchObject({ additions: 1, deletions: 0, binaryFiles: 0 });
    expect(full.diff).toContain("+old runtime\n");
  });

  it("uses the same first-parent tree for merge totals and patches, including unchanged earlier-layer files", async () => {
    // A new merge can contain an existing layer: combined output would omit its unchanged file.
    await writeFile(join(repo, "runtime.txt"), "new runtime\n");
    await readGit(repo, ["add", "runtime.txt"]);
    const runtime = await commitTree([root], "Update runtime");
    await readGit(repo, ["read-tree", root]);
    await writeFile(join(repo, "eval.txt"), "existing eval\n");
    await writeFile(join(repo, "unchanged.txt"), "existing layer file\n");
    await readGit(repo, ["add", "eval.txt", "unchanged.txt"]);
    const previousEval = await commitTree([root], "Previous eval");
    await readGit(repo, ["read-tree", runtime]);
    await writeFile(join(repo, "eval.txt"), "existing eval\nnew eval\n");
    await readGit(repo, ["add", "eval.txt", "unchanged.txt"]);
    const merge = await commitTree([runtime, previousEval], "Update eval");
    await readGit(repo, ["config", "log.diffMerges", "combined"]);
    await readGit(repo, ["config", "diff.algorithm", "histogram"]);
    const summary = await readCommitSummary(repo, merge);
    const full = await readCommitDetails(repo, merge, true);
    expect(summary).toMatchObject({ additions: 3, deletions: 0, comparison: { baseSha: runtime, parentCount: 2 } });
    expect(full).toMatchObject(summary);
    expect(full.diff).toContain("diff --git a/unchanged.txt b/unchanged.txt");
    expect(full.diff).toContain("+existing layer file\n");
    expect(full.diff).not.toContain("diff --cc");
    expect(full.diff?.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))).toHaveLength(3);
  });

  it("preserves binary and whitespace/path-sensitive evidence with totals independent of patch truncation", async () => {
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, "name with\ttab.txt"), "trailing spaces  \n");
    await readGit(repo, ["add", "."]);
    const commit = await commitTree([root], "Add binary and text");
    const summary = await readCommitSummary(repo, commit);
    expect(summary).toMatchObject({
      additions: 1,
      deletions: 0,
      binaryFiles: 1,
      comparison: { baseSha: root, parentCount: 1 },
    });
    expect((await readCommitPatch(repo, commit)).diff).toContain("+trailing spaces  \n");
    const bounded = await readCommitDetails(repo, commit, true, 12);
    expect(bounded).toMatchObject({ additions: 1, binaryFiles: 1, truncated: true });
    expect(Buffer.byteLength(bounded.diff!)).toBe(12);
  });
  it("does not mistake a shallow boundary for an initial tree or substitute a missing parent", async () => {
    // The repository is disposable; shallow walker metadata must not redefine the stored commit's baseline.
    await writeFile(join(repo, "runtime.txt"), "new runtime\n");
    await readGit(repo, ["add", "runtime.txt"]);
    const commit = await commitTree([root], "Shallow tip");
    await writeFile(join(repo, ".git", "shallow"), `${commit}\n`);
    expect((await readCommitSummary(repo, commit)).comparison).toMatchObject({ baseSha: root, parentCount: 1 });
    await rm(join(repo, ".git", "objects", root.slice(0, 2), root.slice(2)));
    await expect(readCommitDetails(repo, commit, true)).rejects.toThrow();
  });
});
