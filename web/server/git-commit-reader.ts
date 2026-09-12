import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeDiffFileStats } from "../shared/diff-file-groups.js";
import type { CommitComparison, CommitSummary } from "../shared/quest-delivery.js";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Run Git without a shell; inputs remain arguments, never executable source. */
export async function readGit(cwd: string, args: readonly string[]): Promise<string> {
  return (await runGit(cwd, args)).trimEnd();
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

export async function resolveCommit(cwd: string, value: string): Promise<string> {
  if (!/^[a-f0-9]{7,40}$/i.test(value)) throw new Error("Expected a commit SHA, not a revision expression.");
  return (await readGit(cwd, ["rev-parse", "--verify", `${value}^{commit}`])).toLowerCase();
}

export async function isAncestor(cwd: string, sha: string, head: string): Promise<boolean> {
  try {
    await readGit(cwd, ["merge-base", "--is-ancestor", sha, head]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

type CommitMetadata = Pick<CommitSummary, "sha" | "shortSha" | "message" | "timestamp"> & {
  comparison: CommitComparison;
};

/** Read metadata only, or a matching summary and patch, without implicit merge defaults. */
export async function readCommitDetails(
  cwd: string,
  sha: string,
  includeDiff: boolean,
  maxPatchBytes = MAX_PATCH_BYTES,
): Promise<CommitMetadata & Partial<CommitSummary> & { diff?: string; truncated?: boolean }> {
  const metadata = await readCommitMetadata(cwd, sha);
  if (!includeDiff) return metadata;
  const [stats, patch] = await Promise.all([readStats(cwd, metadata), readPatch(cwd, metadata, maxPatchBytes)]);
  return { ...metadata, ...stats, ...patch };
}

/** Metadata and totals are saved at delivery time; reading them never downloads the patch. */
export async function readCommitSummary(cwd: string, sha: string): Promise<CommitSummary> {
  const metadata = await readCommitMetadata(cwd, sha);
  return { ...metadata, ...(await readStats(cwd, metadata)) };
}

export async function readCommitPatch(cwd: string, sha: string): Promise<{ diff: string; truncated: boolean }> {
  return readPatch(cwd, await readCommitMetadata(cwd, sha));
}

async function readCommitMetadata(cwd: string, sha: string): Promise<CommitMetadata> {
  const resolved = await resolveCommit(cwd, sha);
  const [raw, object] = await Promise.all([
    readGit(cwd, [
      "--no-replace-objects",
      "show",
      "--no-show-signature",
      "-s",
      "--format=%H%x00%h%x00%s%x00%ct",
      resolved,
    ]),
    readGit(cwd, ["--no-replace-objects", "cat-file", "-p", resolved]),
  ]);
  const [fullSha, shortSha, message, timestamp] = raw.split("\0");
  // Pretty-format parent lists can hide shallow boundaries; the commit object owns its actual parents.
  const parents = object
    .split("\n\n", 1)[0]!
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
  if (
    !/^[a-f0-9]{40}$/.test(resolved) ||
    fullSha !== resolved ||
    parents.some((parent) => !/^[a-f0-9]{40}$/.test(parent))
  ) {
    throw new Error("Invalid Git commit metadata.");
  }
  return {
    sha: fullSha!,
    shortSha: shortSha!,
    message: message ?? "",
    timestamp: Number(timestamp) * 1000,
    comparison: { method: "first-parent-v1", baseSha: parents[0] ?? null, parentCount: parents.length },
  };
}

function comparisonArgs(metadata: CommitMetadata, format: "stats" | "patch"): string[] {
  // Use the same explicit trees and formatting policy for saved totals and the opened patch.
  const options = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--no-color",
    "--no-relative",
    "--ignore-submodules=none",
    ...(format === "stats" ? ["--numstat", "-z"] : ["--patch"]),
  ];
  return metadata.comparison.baseSha
    ? ["--no-replace-objects", "diff", ...options, metadata.comparison.baseSha, metadata.sha, "--"]
    : ["--no-replace-objects", "diff-tree", "--root", "-r", "--no-commit-id", ...options, metadata.sha, "--"];
}

async function readStats(cwd: string, metadata: CommitMetadata) {
  const numstat = await readGit(cwd, comparisonArgs(metadata, "stats"));
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  const files = [];
  for (const row of numstat.split("\0")) {
    const first = row.indexOf("\t");
    const second = row.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = row.slice(0, first);
    const removed = row.slice(first + 1, second);
    const path = row.slice(second + 1);
    const binary = added === "-" || removed === "-";
    const add = binary ? 0 : Number.parseInt(added, 10);
    const del = binary ? 0 : Number.parseInt(removed, 10);
    if (!Number.isFinite(add) || !Number.isFinite(del)) throw new Error("Invalid Git line statistics.");
    additions += add;
    deletions += del;
    if (binary) binaryFiles += 1;
    files.push({ path, additions: add, deletions: del });
  }
  return { additions, deletions, binaryFiles, splitStats: summarizeDiffFileStats(files) };
}

async function readPatch(
  cwd: string,
  metadata: CommitMetadata,
  maxBytes = MAX_PATCH_BYTES,
): Promise<{ diff: string; truncated: boolean }> {
  const patch = await runGit(cwd, comparisonArgs(metadata, "patch"));
  const bytes = Buffer.from(patch, "utf8");
  return { diff: bytes.subarray(0, maxBytes).toString("utf8"), truncated: bytes.length > maxBytes };
}
