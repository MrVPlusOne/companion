import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readGit } from "./git-commit-reader.js";
import { DELIVERY_ID_PATTERN, FULL_COMMIT_SHA_PATTERN } from "../shared/quest-delivery.js";

export interface PortPlan {
  version: 1;
  id: string;
  questId: string;
  actorSessionId: string;
  phaseOccurrenceId: string;
  branch: string;
  createdAt: number;
  baseSha: string;
  headSha: string;
  target: import("../shared/quest-delivery.js").DeliveryTarget;
  targetHeadSha: string;
  groups: Array<import("../shared/quest-delivery.js").RetainedReviewRange & { workerSha?: string; targetSha?: string }>;
  earlierReviews?: import("../shared/quest-delivery.js").RetainedReviewRange[];
  supersededBy?: string;
}

export async function trackingRoot(cwd: string): Promise<string> {
  const commonDir = await readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return join(commonDir, "takode", "port-tracking");
}

export async function loadPortPlan(cwd: string, id: string): Promise<PortPlan> {
  if (!DELIVERY_ID_PATTERN.test(id)) throw new Error("Invalid port preparation ID.");
  const root = await trackingRoot(cwd);
  return parsePlan(JSON.parse(await readFile(join(root, `${id}.json`), "utf8")));
}

export async function savePortPlan(cwd: string, plan: PortPlan): Promise<void> {
  const checked = parsePlan(plan);
  const root = await trackingRoot(cwd);
  await mkdir(root, { recursive: true });
  const temporary = join(root, `${checked.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(root, `${checked.id}.json`));
  const index = await readIndex(root, checked.actorSessionId, checked.branch);
  if (!index.includes(checked.id)) {
    const path = join(root, indexName(checked.actorSessionId, checked.branch));
    const temporaryIndex = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryIndex, JSON.stringify([...index, checked.id]), { mode: 0o600 });
    await rename(temporaryIndex, path);
  }
}

export async function previousPortPlans(cwd: string, actorSessionId: string, branch: string): Promise<PortPlan[]> {
  const index = await readIndex(await trackingRoot(cwd), actorSessionId, branch);
  const plans: PortPlan[] = [];
  for (const id of index) {
    const plan = await loadPortPlan(cwd, id);
    if (plan.actorSessionId !== actorSessionId || plan.branch !== branch)
      throw new Error("Port tracking index ownership mismatch.");
    plans.push(plan);
  }
  return plans;
}

function indexName(actorSessionId: string, branch: string): string {
  return `context-${createHash("sha256")
    .update(JSON.stringify([actorSessionId, branch]))
    .digest("hex")}.json`;
}

async function readIndex(root: string, actorSessionId: string, branch: string): Promise<string[]> {
  try {
    const values: unknown = JSON.parse(await readFile(join(root, indexName(actorSessionId, branch)), "utf8"));
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !DELIVERY_ID_PATTERN.test(value)))
      throw new Error("Invalid port tracking index.");
    return values;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parsePlan(raw: unknown): PortPlan {
  const value = record(raw);
  const target = record(value?.target);
  const strings = [
    value?.actorSessionId,
    value?.phaseOccurrenceId,
    value?.branch,
    target?.repoRoot,
    target?.checkoutPath,
    target?.branch,
  ];
  const groups = value?.groups;
  const earlier = value?.earlierReviews;
  if (
    !value ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !DELIVERY_ID_PATTERN.test(value.id) ||
    typeof value.questId !== "string" ||
    !/^q-\d+$/.test(value.questId) ||
    strings.some((item) => typeof item !== "string" || !item) ||
    !["remote-backed", "worktree", "direct"].includes(String(target?.mode)) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    !validSha(value.baseSha) ||
    !validSha(value.headSha) ||
    !validSha(value.targetHeadSha) ||
    !Array.isArray(groups) ||
    groups.length < 1 ||
    groups.length > 50 ||
    !groups.every(validReview) ||
    (earlier !== undefined && (!Array.isArray(earlier) || earlier.length > 100 || !earlier.every(validReview))) ||
    (value.supersededBy !== undefined &&
      (typeof value.supersededBy !== "string" || !DELIVERY_ID_PATTERN.test(value.supersededBy)))
  ) {
    throw new Error("Invalid port tracking journal; inspect it before further operations.");
  }
  return raw as PortPlan;
}

function validReview(raw: unknown): boolean {
  const value = record(raw);
  return (
    !!value &&
    typeof value.ref === "string" &&
    /^refs\/takode\/review\/[a-f0-9]{32}\/\d+$/.test(value.ref) &&
    validSha(value.baseSha) &&
    validSha(value.tipSha) &&
    Array.isArray(value.commitShas) &&
    value.commitShas.length > 0 &&
    value.commitShas.length <= 500 &&
    value.commitShas.every(validSha) &&
    (value.workerSha === undefined || validSha(value.workerSha)) &&
    (value.targetSha === undefined || (validSha(value.targetSha) && validSha(value.workerSha)))
  );
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && FULL_COMMIT_SHA_PATTERN.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
