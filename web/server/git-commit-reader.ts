import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { summarizeDiffFileStats } from "../shared/diff-file-groups.js";
import type { CommitSummary } from "../shared/quest-delivery.js";

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

/** Metadata and line totals never require downloading the patch. */
export async function readCommitSummary(cwd: string, sha: string): Promise<CommitSummary> {
  const resolved = await resolveCommit(cwd, sha);
  const [metadata, numstat] = await Promise.all([
    readGit(cwd, ["show", "-s", "--format=%H%x00%h%x00%s%x00%ct", resolved]),
    readGit(cwd, ["show", "--format=", "--numstat", "--no-renames", "-z", resolved]),
  ]);
  const [fullSha, shortSha, message, timestamp] = metadata.split("\0");
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
  return {
    sha: fullSha!,
    shortSha: shortSha!,
    message: message ?? "",
    timestamp: Number(timestamp) * 1000,
    additions,
    deletions,
    binaryFiles,
    splitStats: summarizeDiffFileStats(files),
  };
}

export async function readCommitPatch(cwd: string, sha: string): Promise<{ diff: string; truncated: boolean }> {
  const resolved = await resolveCommit(cwd, sha);
  const patch = await runGit(cwd, ["show", "--format=", "--patch", "--no-color", resolved]);
  const bytes = Buffer.from(patch, "utf8");
  return { diff: bytes.subarray(0, MAX_PATCH_BYTES).toString("utf8"), truncated: bytes.length > MAX_PATCH_BYTES };
}
