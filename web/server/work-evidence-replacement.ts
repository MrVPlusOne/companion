import { isAbsolute, resolve } from "node:path";
import * as gitUtils from "./git-utils.js";

export type WorkEvidenceTargetMode = "remote-backed" | "worktree" | "direct";

interface WorkEvidenceTargetConfig {
  checkoutPath: string;
  branch: string;
  mode: WorkEvidenceTargetMode;
  repoRoot?: string;
}

export interface WorkEvidenceTargetCaller {
  isWorktree?: boolean;
  cwd?: string;
  branch?: string;
  actualBranch?: string;
  worktreePortTarget?: { repoRoot?: string; branch?: string; worktreePath?: string };
}

export interface VerifiedWorkEvidenceTarget extends WorkEvidenceTargetConfig {
  headSha: string;
  commitShas: string[];
}

export type WorkEvidenceTargetResult = VerifiedWorkEvidenceTarget | { error: string; status: 409 | 503 };

/** Verify replacement commits against one stable selected-target branch head. */
export async function verifyReplacementWorkEvidence(
  caller: WorkEvidenceTargetCaller,
  replacementCommitShas: readonly string[],
): Promise<WorkEvidenceTargetResult> {
  const target = resolveWorkEvidenceTarget(caller);
  if ("error" in target) return { error: target.error, status: 409 };

  const initialIdentity = await readTargetIdentity(target);
  if ("error" in initialIdentity) return initialIdentity;

  const resolvedCommitShas: string[] = [];
  const seen = new Set<string>();
  for (const requestedSha of replacementCommitShas) {
    const resolved = await resolveReplacementCommit(target, requestedSha);
    if ("error" in resolved) return resolved;
    if (seen.has(resolved.sha)) continue;
    seen.add(resolved.sha);
    resolvedCommitShas.push(resolved.sha);
  }

  for (const fullSha of resolvedCommitShas) {
    const reachable = await verifyCommitReachability(target, fullSha, initialIdentity.headSha);
    if (reachable) return reachable;
  }

  const finalIdentity = await readTargetIdentity(target);
  if ("error" in finalIdentity) return finalIdentity;
  if (finalIdentity.headSha !== initialIdentity.headSha) {
    return {
      error: "The selected Work evidence target branch changed during verification; refresh and retry.",
      status: 409,
    };
  }

  return { ...target, headSha: initialIdentity.headSha, commitShas: resolvedCommitShas };
}

function resolveWorkEvidenceTarget(caller: WorkEvidenceTargetCaller): WorkEvidenceTargetConfig | { error: string } {
  if (caller.isWorktree === true) {
    const target = caller.worktreePortTarget;
    const repoRoot = typeof target?.repoRoot === "string" ? target.repoRoot.trim() : "";
    const branch = typeof target?.branch === "string" ? target.branch.trim() : "";
    const worktreePath = typeof target?.worktreePath === "string" ? target.worktreePath.trim() : "";
    if (!repoRoot || !branch) {
      return {
        error:
          "Cannot identify the selected port target from this worktree session; refresh the session target metadata before replacing Work evidence.",
      };
    }
    const checkoutPath = worktreePath || repoRoot;
    if (!isAbsolute(checkoutPath) || !isAbsolute(repoRoot)) {
      return { error: "Selected port target paths must be absolute." };
    }
    return {
      checkoutPath,
      repoRoot,
      branch,
      mode: worktreePath ? "worktree" : "remote-backed",
    };
  }

  const checkoutPath = typeof caller.cwd === "string" ? caller.cwd.trim() : "";
  const branch =
    (typeof caller.actualBranch === "string" ? caller.actualBranch.trim() : "") ||
    (typeof caller.branch === "string" ? caller.branch.trim() : "");
  if (!checkoutPath || !branch) {
    return { error: "Cannot identify the selected checkout and branch for this worker session." };
  }
  if (!isAbsolute(checkoutPath)) {
    return { error: "Selected worker checkout path must be absolute." };
  }
  return { checkoutPath, branch, mode: "direct" };
}

async function readTargetIdentity(
  target: WorkEvidenceTargetConfig,
): Promise<{ headSha: string } | { error: string; status: 409 | 503 }> {
  const repoInfo = await gitUtils.getRepoInfoAsync(target.checkoutPath);
  if (!repoInfo) {
    return {
      error: `Selected Work evidence target is not an available Git checkout: ${target.checkoutPath}`,
      status: 409,
    };
  }
  if (target.repoRoot && resolve(repoInfo.repoRoot) !== resolve(target.repoRoot)) {
    return {
      error: "Selected Work evidence target resolves to a different repository than the session port target.",
      status: 409,
    };
  }
  if (repoInfo.currentBranch !== target.branch) {
    return {
      error: `Selected Work evidence target must have branch ${target.branch} checked out; current branch is ${repoInfo.currentBranch}.`,
      status: 409,
    };
  }

  try {
    const ref = shellQuote(`refs/heads/${target.branch}^{commit}`);
    const headSha = (await gitUtils.gitAsync(`rev-parse --verify ${ref}`, target.checkoutPath)).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      return { error: "Selected Work evidence target returned an invalid branch-head commit.", status: 503 };
    }
    return { headSha };
  } catch (error) {
    console.warn(`[routes] Failed to resolve selected Work evidence target branch at ${target.checkoutPath}:`, error);
    return { error: "Cannot resolve the selected Work evidence target branch; refresh and retry.", status: 503 };
  }
}

async function resolveReplacementCommit(
  target: WorkEvidenceTargetConfig,
  requestedSha: string,
): Promise<{ sha: string } | { error: string; status: 409 }> {
  try {
    const sha = (await gitUtils.gitAsync(`rev-parse --verify ${requestedSha}^{commit}`, target.checkoutPath))
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { error: `Replacement commit ${requestedSha} did not resolve to a full commit SHA.`, status: 409 };
    }
    return { sha };
  } catch {
    return {
      error: `Replacement commit ${requestedSha} does not exist in the selected Work evidence target.`,
      status: 409,
    };
  }
}

async function verifyCommitReachability(
  target: WorkEvidenceTargetConfig,
  fullSha: string,
  headSha: string,
): Promise<{ error: string; status: 409 | 503 } | null> {
  try {
    await gitUtils.gitAsync(`merge-base --is-ancestor ${fullSha} ${headSha}`, target.checkoutPath);
    return null;
  } catch (error) {
    if (commandExitCode(error) !== 1) {
      console.warn(
        `[routes] Failed to verify replacement Work evidence reachability at ${target.checkoutPath}:`,
        error,
      );
      return { error: "Cannot verify replacement commit reachability in the selected target; retry.", status: 503 };
    }
    return {
      error: `Replacement commit ${fullSha} is not reachable from the selected Work evidence target branch head.`,
      status: 409,
    };
  }
}

function commandExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
