import { getQuestOwner, sameQuestOwner } from "../shared/quest-owner.js";
import type { QuestCodeDelivery } from "../shared/quest-delivery.js";
import type { QuestmasterTask, QuestOwnerRef } from "./quest-types.js";
import { commitShaField } from "./quest-store-helpers.js";

/** One atomic quest-store update keeps delivery provenance and code evidence together. */
export function appendCodeEvidence(
  current: QuestmasterTask,
  owner: QuestOwnerRef,
  commitShas: string[],
  delivery?: QuestCodeDelivery,
): QuestmasterTask {
  if (current.status !== "in_progress")
    throw new Error("Code commit evidence can only be attached to an in-progress quest");
  const activeOwner = getQuestOwner(current);
  if (!activeOwner || !sameQuestOwner(activeOwner, owner))
    throw new Error("Only the exact active quest owner may attach in-progress code commit evidence");
  if (
    delivery &&
    (delivery.actorSessionId !== owner.sessionId ||
      JSON.stringify(delivery.commits.map((commit) => commit.sha)) !== JSON.stringify(commitShas))
  ) {
    throw new Error("Delivery identity must match the exact code commit SHA submission and owner.");
  }
  const existing = delivery && current.codeDeliveries?.find((candidate) => candidate.id === delivery.id);
  if (
    existing &&
    JSON.stringify({ ...existing, recordedAt: 0, targetHeadSha: "" }) !==
      JSON.stringify({ ...delivery, recordedAt: 0, targetHeadSha: "" })
  ) {
    throw new Error("A recorded delivery cannot be changed.");
  }
  const fields = commitShaField("commitShas", current.commitShas, commitShas);
  const next = fields.commitShas ?? [];
  if ((!delivery || existing) && JSON.stringify(next) === JSON.stringify(current.commitShas ?? [])) return current;
  return {
    ...current,
    ...fields,
    ...(delivery && !existing ? { codeDeliveries: [...(current.codeDeliveries ?? []), delivery] } : {}),
    updatedAt: Date.now(),
  } as QuestmasterTask;
}
