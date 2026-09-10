import type { Context, Hono } from "hono";
import * as questStore from "../quest-store.js";
import { getTakodeQuestOwnerSessionId } from "../../shared/quest-owner.js";
import type { QuestDeliveryTargetApproval } from "../../shared/quest-delivery.js";
import {
  DeliveryEvidenceError,
  deliveryTargetApprovalId,
  parsePublishedDeliveryTarget,
  verifyPublishedDeliveryTarget,
} from "../published-delivery-target.js";
import {
  findAssignedBoardRowsForWorker,
  hasUnaddressedHumanFeedback,
  resolveActiveWorkPhaseContext,
} from "./work-evidence-context.js";
import type { WorkDeliveryRoutesDeps } from "./work-deliveries.js";

/** Approval is a leader-owned, occurrence-scoped decision; it never changes the session integration target. */
export function registerWorkDeliveryTargetRoutes(api: Hono, deps: WorkDeliveryRoutesDeps): void {
  async function leaderScope(c: Context, questId: string) {
    const auth = deps.authenticateTakodeCaller(c);
    if ("response" in auth || !auth.caller.isOrchestrator || auth.caller.reviewerOf !== undefined)
      throw new DeliveryEvidenceError("Only the assigned leader may approve an independent delivery target.", 403);
    if (!/^q-\d+$/.test(questId)) throw new DeliveryEvidenceError("Invalid quest ID.", 400);
    const quest = await questStore.getQuest(questId);
    const workerSessionId = quest && getTakodeQuestOwnerSessionId(quest);
    if (!quest || quest.status !== "in_progress" || !workerSessionId)
      throw new DeliveryEvidenceError("A claimed in-progress quest is required.", 409);
    const matches = findAssignedBoardRowsForWorker({ ...deps, workerSessionId, questId });
    if (matches.length !== 1 || matches[0]!.leaderSessionId !== auth.callerId)
      throw new DeliveryEvidenceError("The authenticated leader must own the unique active worker assignment.", 403);
    const { row } = matches[0]!;
    if (row.status !== "WORKING" || row.waitForInput?.length || hasUnaddressedHumanFeedback(quest))
      throw new DeliveryEvidenceError("Active Work with no unresolved checkpoint or human feedback is required.");
    const scope = resolveActiveWorkPhaseContext(auth.callerId, row, quest);
    if ("error" in scope) throw new DeliveryEvidenceError(scope.error);
    return { leaderSessionId: auth.callerId, workerSessionId, phaseOccurrenceId: scope.phaseOccurrenceId };
  }

  api.post("/takode/board/approve-delivery-target", async (c) => {
    let release: (() => void) | null = null;
    try {
      const body = await c.req.json();
      const questId = typeof body.questId === "string" ? body.questId : "";
      const scope = await leaderScope(c, questId);
      const target = parsePublishedDeliveryTarget(body.target);
      release = deps.acquireWorkEvidenceMutationLock(scope.leaderSessionId, questId);
      if (!release) throw new DeliveryEvidenceError("Another Work evidence operation is active.");
      await verifyPublishedDeliveryTarget(target);
      if (JSON.stringify(await leaderScope(c, questId)) !== JSON.stringify(scope))
        throw new DeliveryEvidenceError("Work assignment changed during target approval; refresh before approving.");
      const approval: QuestDeliveryTargetApproval = {
        id: deliveryTargetApprovalId(questId, { ...scope, target }),
        approvedAt: Date.now(),
        ...scope,
        target,
      };
      const updated = await questStore.appendQuestDeliveryTargetApproval(questId, approval);
      if (!updated) throw new DeliveryEvidenceError("Quest no longer exists.");
      return c.json({ questId, approvalId: approval.id, refCount: target.refs.length });
    } catch (error) {
      if (error instanceof DeliveryEvidenceError) return c.json({ error: error.message }, error.status);
      console.warn("[delivery-target] Approval failed:", error);
      return c.json({ error: "Cannot record delivery target approval; no publication operation was attempted." }, 503);
    } finally {
      release?.();
    }
  });

  api.get("/takode/board/delivery-targets/:questId/:approvalId?", async (c) => {
    const auth = deps.authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    const questId = c.req.param("questId");
    if (!/^q-\d+$/.test(questId)) return c.json({ error: "Invalid quest ID." }, 400);
    const approvals = (await questStore.getQuest(questId))?.deliveryTargetApprovals ?? [];
    const id = c.req.param("approvalId");
    if (id) {
      const approval = approvals.find((item) => item.id === id);
      return approval ? c.json({ questId, approval }) : c.json({ error: "Delivery target approval not found." }, 404);
    }
    return c.json({
      questId,
      approvals: approvals.map((item) => ({
        id: item.id,
        approvedAt: item.approvedAt,
        phaseOccurrenceId: item.phaseOccurrenceId,
        refCount: item.target.refs.length,
      })),
    });
  });
}
