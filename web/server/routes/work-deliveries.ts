import type { Context, Hono } from "hono";
import type { RouteContext } from "./context.js";
import type { BoardRow } from "../session-types.js";
import * as questStore from "../quest-store.js";
import { getTakodeQuestOwnerSessionId } from "../../shared/quest-owner.js";
import { normalizeCommitShas } from "../quest-store-helpers.js";
import { buildCodeDelivery, portContext } from "../quest-code-deliveries.js";
import { preparePort, sealPort, recordLandedCommit, inspectPort } from "../port-tracking.js";
import { projectQuestDelivery } from "../../shared/quest-delivery.js";
import { broadcastQuestUpdate } from "./quest-helpers.js";
import { registerWorkDeliveryTargetRoutes } from "./work-delivery-targets.js";
import { DeliveryEvidenceError } from "../published-delivery-target.js";
import {
  findAssignedBoardRowsForWorker,
  hasUnaddressedHumanFeedback,
  resolveActiveWorkPhaseContext,
  resolveCurrentWorkFeedback,
} from "./work-evidence-context.js";

export interface WorkDeliveryRoutesDeps {
  launcher: RouteContext["launcher"];
  wsBridge: RouteContext["wsBridge"];
  authenticateTakodeCaller: RouteContext["authenticateTakodeCaller"];
  acquireWorkEvidenceMutationLock: (leaderId: string, questId: string) => (() => void) | null;
}

/** Tracking changes refs/receipts only; recording uses the same lock as Work -> Memory. */
export function registerWorkDeliveryRoutes(api: Hono, deps: WorkDeliveryRoutesDeps): void {
  registerWorkDeliveryTargetRoutes(api, deps);
  async function resolveWorker(c: Context, questId: string, publication = false, workNote?: number) {
    const auth = deps.authenticateTakodeCaller(c);
    if ("response" in auth) throw new WorkRouteError("Worker authentication required.", 403);
    if (auth.caller.reviewerOf !== undefined || auth.caller.isOrchestrator)
      throw new WorkRouteError("Only the assigned worker may change Work delivery state.", 403);
    if (!/^q-\d+$/.test(questId)) throw new WorkRouteError("Invalid quest ID.", 400);
    const quest = await questStore.getQuest(questId);
    if (!quest || quest.status !== "in_progress" || getTakodeQuestOwnerSessionId(quest) !== auth.callerId) {
      throw new WorkRouteError("Claimed in-progress quest ownership is required.", 403);
    }
    const matches = findAssignedBoardRowsForWorker({ ...deps, workerSessionId: auth.callerId, questId });
    if (matches.length !== 1) throw new WorkRouteError("An unambiguous worker board assignment is required.", 409);
    const match = matches[0]!;
    assertActiveWork(match.row);
    const scope = resolveActiveWorkPhaseContext(match.leaderSessionId, match.row, quest);
    if ("error" in scope) throw new WorkRouteError(scope.error, 409);
    if (publication) {
      if (hasUnaddressedHumanFeedback(quest))
        throw new WorkRouteError("Resolve human feedback before recording accepted delivery.", 409);
      const note = resolveCurrentWorkFeedback({
        quest,
        authorSessionId: auth.callerId,
        activeScope: scope,
        requestedIndex: workNote,
      });
      if ("error" in note) throw new WorkRouteError(note.error, 409);
    }
    return { auth, quest, match, scope };
  }

  api.post("/takode/port/:questId/:action", async (c) => {
    let release: (() => void) | null = null;
    try {
      const questId = c.req.param("questId");
      const action = c.req.param("action");
      const body = await c.req.json();
      const worker = await resolveWorker(c, questId);
      release = deps.acquireWorkEvidenceMutationLock(worker.match.leaderSessionId, questId);
      if (!release) throw new WorkRouteError("Another Work evidence operation is active.", 409);
      const context = await portContext({
        questId,
        actorSessionId: worker.auth.callerId,
        phaseOccurrenceId: worker.scope.phaseOccurrenceId,
        caller: worker.auth.caller,
      });
      let id = typeof body.id === "string" ? body.id : "";
      if (action === "prepare") {
        const plan = await preparePort(context, {
          baseSha: typeof body.baseSha === "string" ? body.baseSha : "",
          groupTips: body.groupTips === undefined ? undefined : normalizeCommitShas(body.groupTips),
          confirmPrivate: body.confirmPrivate === true,
          previousId: typeof body.previousId === "string" ? body.previousId : undefined,
        });
        id = plan.id;
      } else if (action === "seal") {
        await sealPort(context, id, normalizeCommitShas(body.commitShas));
      } else if (action === "landed") {
        await recordLandedCommit(
          context,
          id,
          typeof body.workerSha === "string" ? body.workerSha : "",
          typeof body.targetSha === "string" ? body.targetSha : "",
        );
      } else {
        throw new WorkRouteError("Unknown port action; use prepare, seal, or landed.", 400);
      }
      return c.json(await inspectPort(context, id));
    } catch (error) {
      return workError(c, error);
    } finally {
      release?.();
    }
  });

  api.get("/takode/port/:questId/:id", async (c) => {
    try {
      const questId = c.req.param("questId");
      if (!/^q-\d+$/.test(questId)) throw new WorkRouteError("Invalid quest ID.", 400);
      const auth = deps.authenticateTakodeCaller(c);
      if ("response" in auth) return auth.response;
      // The immutable journal's actor/quest/branch/target checks still apply after Work ends.
      const context = await portContext({
        questId,
        actorSessionId: auth.callerId,
        phaseOccurrenceId: "inspection",
        caller: auth.caller,
      });
      return c.json(await inspectPort(context, c.req.param("id")));
    } catch (error) {
      return workError(c, error);
    }
  });

  api.post("/takode/board/record-work-delivery", async (c) => {
    let release: (() => void) | null = null;
    try {
      const body = await c.req.json();
      const questId = typeof body.questId === "string" ? body.questId : "";
      const workNote = body.workFeedbackIndex;
      if (
        body.deliveryTargetId !== undefined &&
        (typeof body.deliveryTargetId !== "string" || !/^[a-f0-9]{32}$/.test(body.deliveryTargetId))
      )
        throw new WorkRouteError("deliveryTargetId requires an exact approved target ID.", 400);
      if (body.target !== undefined)
        throw new WorkRouteError("Use a leader-approved deliveryTargetId, not a target override.", 400);
      if (workNote !== undefined && (!Number.isInteger(workNote) || workNote < 0))
        throw new WorkRouteError("Invalid Work note index.", 400);
      const worker = await resolveWorker(c, questId, true, workNote);
      release = deps.acquireWorkEvidenceMutationLock(worker.match.leaderSessionId, questId);
      if (!release) throw new WorkRouteError("Another Work evidence operation is active.", 409);
      const delivery = await buildCodeDelivery({
        questId,
        actorSessionId: worker.auth.callerId,
        phaseOccurrenceId: worker.scope.phaseOccurrenceId,
        caller: worker.auth.caller,
        existing: worker.quest,
        leaderSessionId: worker.match.leaderSessionId,
        deliveryTargetId: body.deliveryTargetId,
        commitShas: normalizeCommitShas(body.commitShas),
        preparationId: typeof body.preparationId === "string" ? body.preparationId : undefined,
      });
      if (delivery.commits.length === 0) throw new WorkRouteError("A delivery requires at least one commit.", 400);
      const refreshed = await resolveWorker(c, questId, true, workNote);
      if (
        refreshed.match.leaderSessionId !== worker.match.leaderSessionId ||
        refreshed.scope.phaseOccurrenceId !== worker.scope.phaseOccurrenceId
      ) {
        throw new WorkRouteError("Work assignment changed while verifying delivery.", 409);
      }
      const updated = await questStore.appendQuestCodeCommitEvidenceForOwner(
        questId,
        { kind: "takode", sessionId: worker.auth.callerId },
        delivery.commits.map((commit) => commit.sha),
        delivery,
      );
      if (!updated) throw new WorkRouteError("Quest no longer exists.", 409);
      broadcastQuestUpdate(deps.wsBridge, updated);
      return c.json({
        questId,
        delivery: projectQuestDelivery(questId, updated.codeDeliveries!.find((item) => item.id === delivery.id)!),
      });
    } catch (error) {
      return workError(c, error);
    } finally {
      release?.();
    }
  });
}

function assertActiveWork(row: BoardRow): void {
  if (row.status !== "WORKING" || (row.waitForInput?.length ?? 0) > 0) {
    throw new WorkRouteError("Active Work with no unresolved User Checkpoint is required.", 409);
  }
}

class WorkRouteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}

function workError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "Work delivery operation failed.";
  if (!(error instanceof WorkRouteError)) console.warn("[work-delivery] Operation rejected:", message);
  return c.json(
    { error: message },
    error instanceof WorkRouteError || error instanceof DeliveryEvidenceError ? error.status : 409,
  );
}
