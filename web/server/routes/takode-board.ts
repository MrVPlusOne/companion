import type { Hono } from "hono";
import * as questStore from "../quest-store.js";
import {
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS,
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH,
} from "../../shared/quest-code-commit-evidence.js";
import { verifyReplacementWorkEvidence } from "../work-evidence-replacement.js";
import {
  canonicalizeQuestJourneyPhaseId,
  FREE_WORKER_WAIT_FOR_TOKEN,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPhaseIndices,
  getInvalidQuestJourneyPhaseIds,
  getQuestJourneyProposalSignature,
  isLegacyQuestJourneyPhaseId,
  isQuestJourneyOptionalUserCheckpoint,
  isValidQuestId,
  isValidWaitForRef,
  normalizeKnownQuestJourneyPhaseIds,
  normalizeQuestJourneyPhaseIds,
  normalizeQuestJourneyPlan,
  rebaseQuestJourneyPhaseNotes,
  reviseQuestJourneySuffix,
  validateQuestJourneyCompletedPrefixRevision,
  validateQuestJourneyPhaseSequence,
  validateQuestJourneyPhaseSequenceMutation,
  validateQuestJourneyPersistedPhaseMutation,
  validateQuestJourneyUserCheckpointNotes,
  validateQuestJourneyUserCheckpointRemoval,
  type QuestJourneyLifecycleMode,
  type QuestJourneyPhaseId,
  type QuestJourneyPhaseNoteRebaseWarning,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";
import { canonicalizeQuestJourneyLifecycleMode } from "../../shared/quest-journey.js";
import {
  advanceBoardRow as advanceBoardRowController,
  getBoard as getBoardController,
  getBoardQueueWarnings as getBoardQueueWarningsController,
  getBoardWorkerSlotUsage as getBoardWorkerSlotUsageController,
  getCompletedBoard as getCompletedBoardController,
  removeBoardRows as removeBoardRowsController,
  upsertBoardRow as upsertBoardRowController,
} from "../bridge/board-watchdog-controller.js";
import { QUEST_JOURNEY_STATES, type BoardRow } from "../session-types.js";
import type { RouteContext } from "./context.js";
import type { QuestmasterTask } from "../quest-types.js";
import { normalizeCommitShas } from "../quest-store-helpers.js";
import { broadcastQuestUpdate } from "./quest-helpers.js";
import { getQuestDisplayOwner, getTakodeQuestOwnerSessionId } from "../../shared/quest-owner.js";
import {
  hasUnaddressedHumanFeedback,
  resolveActiveWorkPhaseContext,
  resolveCurrentWorkFeedback,
  findAssignedBoardRowsForWorker,
  type ActiveWorkPhaseContext,
} from "./work-evidence-context.js";
import { registerWorkDeliveryRoutes } from "./work-deliveries.js";
import { buildCodeDelivery } from "../quest-code-deliveries.js";
import { projectQuestDelivery } from "../../shared/quest-delivery.js";

interface PhaseNoteEdit {
  index: number;
  note?: string;
}

interface BoardProposalReviewPayload {
  questId: string;
  title?: string;
  status: string;
  journey: QuestJourneyPlanState;
  presentedAt: number;
  summary?: string;
  scheduling?: Record<string, unknown>;
}

function isDirectCodexOwnedQuest(quest: QuestmasterTask): boolean {
  if (quest.status !== "in_progress" && quest.status !== "done") return false;
  return getQuestDisplayOwner(quest)?.kind === "codex";
}

interface WorkToMemoryTarget {
  memoryIndex: number;
  phaseSkipReasons?: Record<string, string>;
}

function resolveWorkToMemoryTarget(
  context: ActiveWorkPhaseContext,
  skipOptionalUserCheckpointReason: string | undefined,
): WorkToMemoryTarget | { error: string } {
  const { currentJourney, phaseIds, currentPhaseIndex } = context;
  const memoryIndex = phaseIds.findIndex((phaseId, index) => index > currentPhaseIndex && phaseId === "memory");
  if (memoryIndex < 0) {
    return { error: "The active v2 Journey has no Memory phase after the current Work occurrence." };
  }

  const interveningIndices = phaseIds
    .map((phaseId, index) => ({ phaseId, index }))
    .filter(({ index }) => index > currentPhaseIndex && index < memoryIndex);
  if (interveningIndices.length === 0) {
    if (skipOptionalUserCheckpointReason) {
      return { error: "No optional User Checkpoint lies between the current Work occurrence and Memory." };
    }
    return { memoryIndex };
  }

  if (interveningIndices.length === 1 && interveningIndices[0]?.phaseId === "user-checkpoint") {
    const checkpointIndex = interveningIndices[0].index;
    if (!skipOptionalUserCheckpointReason) {
      return {
        error:
          "A User Checkpoint lies before Memory. Optional checkpoints require a skip reason; required or taken checkpoints require a later Work occurrence before Memory.",
      };
    }
    if (!isQuestJourneyOptionalUserCheckpoint(phaseIds, currentJourney.phaseNotes, checkpointIndex)) {
      return {
        error:
          "This User Checkpoint is required and cannot be skipped. Revise the Journey to insert a later Work occurrence after the checkpoint before entering Memory.",
      };
    }
    return {
      memoryIndex,
      phaseSkipReasons: {
        ...(currentJourney.phaseSkipReasons ?? {}),
        [String(checkpointIndex)]: skipOptionalUserCheckpointReason,
      },
    };
  }

  return {
    error:
      `Cannot enter Memory because planned phase occurrence(s) remain after the current Work occurrence: ` +
      `${interveningIndices.map(({ phaseId }) => phaseId).join(", ")}. Advance or settle those occurrences first.`,
  };
}

function normalizeJourneyMode(value: unknown): QuestJourneyLifecycleMode | undefined {
  if (typeof value !== "string") return undefined;
  return canonicalizeQuestJourneyLifecycleMode(value) ?? undefined;
}

function normalizePhaseNoteEdits(value: unknown): PhaseNoteEdit[] | null {
  if (!Array.isArray(value)) return null;
  const edits: PhaseNoteEdit[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const index = (entry as { index?: unknown }).index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
    const rawNote = (entry as { note?: unknown }).note;
    if (rawNote === null) {
      edits.push({ index });
      continue;
    }
    if (typeof rawNote !== "string") return null;
    const note = rawNote.trim();
    edits.push(note ? { index, note } : { index });
  }
  return edits;
}

function applyPhaseNoteEdits(
  existingNotes: Record<string, string> | undefined,
  edits: readonly PhaseNoteEdit[],
  phaseCount: number,
): Record<string, string> | undefined {
  const nextNotes = new Map<string, string>(Object.entries(existingNotes ?? {}));
  for (const edit of edits) {
    if (edit.index >= phaseCount) {
      throw new Error(`Phase note index ${edit.index + 1} is out of range for the current Journey.`);
    }
    const key = String(edit.index);
    if (edit.note) nextNotes.set(key, edit.note);
    else nextNotes.delete(key);
  }
  return nextNotes.size > 0
    ? Object.fromEntries([...nextNotes.entries()].sort((a, b) => Number(a[0]) - Number(b[0])))
    : undefined;
}

function normalizeProposalMetadata(
  value: unknown,
): Pick<NonNullable<QuestJourneyPlanState["presentation"]>, "summary" | "scheduling"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as { summary?: unknown; scheduling?: unknown };
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : undefined;
  const scheduling =
    raw.scheduling && typeof raw.scheduling === "object" && !Array.isArray(raw.scheduling)
      ? { ...(raw.scheduling as Record<string, unknown>) }
      : undefined;
  return {
    ...(summary ? { summary } : {}),
    ...(scheduling ? { scheduling } : {}),
  };
}

function buildProposalReviewPayload(row: {
  questId: string;
  title?: string;
  status?: string;
  journey?: QuestJourneyPlanState;
}): BoardProposalReviewPayload | undefined {
  const journey = row.journey;
  const presentation = journey?.presentation;
  if (!journey || presentation?.state !== "presented" || !presentation.presentedAt) return undefined;
  return {
    questId: row.questId,
    ...(row.title ? { title: row.title } : {}),
    status: row.status ?? "PROPOSED",
    journey,
    presentedAt: presentation.presentedAt,
    ...(presentation.summary ? { summary: presentation.summary } : {}),
    ...(presentation.scheduling ? { scheduling: presentation.scheduling } : {}),
  };
}

function findPreservedPhaseIndex(
  phaseIds: readonly QuestJourneyPhaseId[],
  currentPhaseId: QuestJourneyPhaseId,
  previousIndex: number | undefined,
): number | undefined {
  const matches = phaseIds
    .map((phaseId, index) => ({ phaseId, index }))
    .filter((entry) => entry.phaseId === currentPhaseId)
    .map((entry) => entry.index);
  if (matches.length === 0) return undefined;
  if (previousIndex === undefined) return matches.length === 1 ? matches[0] : undefined;
  return matches.find((index) => index >= previousIndex) ?? matches[matches.length - 1];
}

function getCompletedExploreImplementRevisionAllowance(
  existingMode: QuestJourneyLifecycleMode,
  existingPhaseIds: readonly QuestJourneyPhaseId[],
  currentPhaseIndex: number | undefined,
  fromIndex: number,
  replacementPhaseIds: readonly QuestJourneyPhaseId[],
): { adjacentExploreImplementIndex: number; removedCheckpointIndex?: number } | undefined {
  if (existingMode !== "active") return undefined;
  if (currentPhaseIndex === undefined) return undefined;
  if (fromIndex !== currentPhaseIndex + 1) return undefined;
  if (existingPhaseIds[currentPhaseIndex] !== "explore") return undefined;
  if (replacementPhaseIds[0] !== "implement") return undefined;

  return {
    adjacentExploreImplementIndex: currentPhaseIndex,
    ...(existingPhaseIds[fromIndex] === "user-checkpoint" ? { removedCheckpointIndex: fromIndex } : {}),
  };
}

function validateExplicitUserCheckpointSkips(
  phaseIds: readonly QuestJourneyPhaseId[],
  phaseNotes: Record<string, string> | undefined,
  phaseSkipReasons: Record<string, string> | undefined,
  currentPhaseIndex: number | undefined,
  nextActivePhaseIndex: number | undefined,
): string | undefined {
  if (currentPhaseIndex === undefined || nextActivePhaseIndex === undefined) return undefined;
  if (nextActivePhaseIndex <= currentPhaseIndex + 1) return undefined;

  for (let index = currentPhaseIndex + 1; index < nextActivePhaseIndex; index += 1) {
    if (phaseIds[index] !== "user-checkpoint") continue;
    if (!isQuestJourneyOptionalUserCheckpoint(phaseIds, phaseNotes, index)) {
      return "Cannot skip a mandatory User Checkpoint. User Checkpoints are mandatory by default unless the approved phase note makes that checkpoint optional with a concrete skip condition.";
    }
    if (!phaseSkipReasons?.[String(index)]?.trim()) {
      return "Cannot skip an optional User Checkpoint without recording that its approved skip condition is satisfied. Use `takode board advance --skip-optional-checkpoint <reason>` when another Work occurrence follows, or `takode board work-to-memory ... --skip-optional-checkpoint <reason>` when Memory follows directly.";
    }
  }
  return undefined;
}

function parseNotificationNumericId(notificationId: string): number | null {
  const match = /^n-(\d+)$/.exec(notificationId);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeNeedsInputNotificationId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return `n-${value}`;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numericId = Number.parseInt(trimmed, 10);
    return numericId > 0 ? `n-${numericId}` : null;
  }
  const numericId = parseNotificationNumericId(trimmed.toLowerCase());
  return numericId !== null ? `n-${numericId}` : null;
}

interface TakodeBoardRoutesDeps {
  launcher: RouteContext["launcher"];
  wsBridge: RouteContext["wsBridge"];
  authenticateTakodeCaller: RouteContext["authenticateTakodeCaller"];
  resolveId: RouteContext["resolveId"];
  boardWatchdogDeps: any;
  workBoardStateDeps: any;
  buildBoardRowSessionStatuses: (rows: BoardRow[]) => Promise<Record<string, unknown>>;
  resolveSessionDeps: (board: BoardRow[]) => string[];
}

export function registerTakodeBoardRoutes(api: Hono, deps: TakodeBoardRoutesDeps): void {
  const {
    launcher,
    wsBridge,
    authenticateTakodeCaller,
    resolveId,
    boardWatchdogDeps,
    workBoardStateDeps,
    buildBoardRowSessionStatuses,
    resolveSessionDeps,
  } = deps;
  const workEvidenceMutationLocks = new Set<string>();

  const workEvidenceMutationLockKey = (leaderSessionId: string, questId: string): string =>
    `${leaderSessionId}\0${questId.trim().toLowerCase()}`;
  const isWorkEvidenceMutationLocked = (leaderSessionId: string, questId: string): boolean =>
    workEvidenceMutationLocks.has(workEvidenceMutationLockKey(leaderSessionId, questId));
  const acquireWorkEvidenceMutationLock = (leaderSessionId: string, questId: string): (() => void) | null => {
    const key = workEvidenceMutationLockKey(leaderSessionId, questId);
    if (workEvidenceMutationLocks.has(key)) return null;
    workEvidenceMutationLocks.add(key);
    return () => workEvidenceMutationLocks.delete(key);
  };

  registerWorkDeliveryRoutes(api, { launcher, wsBridge, authenticateTakodeCaller, acquireWorkEvidenceMutationLock });

  function syncDoneQuestBoardState(questId: string): void {
    const boardBridge = wsBridge as {
      completeDoneBoardRowsForQuest?: (questId: string) => string[];
      completeQueuedBoardRowsForQuest?: (questId: string) => string[];
    };
    if (boardBridge.completeDoneBoardRowsForQuest) {
      boardBridge.completeDoneBoardRowsForQuest(questId);
      return;
    }
    boardBridge.completeQueuedBoardRowsForQuest?.(questId);
  }

  async function cleanupDoneBoardRows(bridgeSession: any): Promise<void> {
    const activeQuestIds = [...bridgeSession.board.values()].map((row: BoardRow) => row.questId);
    for (const questId of activeQuestIds) {
      const quest = await questStore.getQuest(questId).catch(() => null);
      if (quest?.status !== "done") continue;
      syncDoneQuestBoardState(questId);
    }
  }

  api.post("/takode/board/work-to-memory", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (auth.caller.reviewerOf !== undefined) {
      return c.json({ error: "Reviewer sessions cannot use the worker-owned Work -> Memory transition." }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim() : "";
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    const workFeedbackIndex =
      typeof body.workFeedbackIndex === "number" && Number.isInteger(body.workFeedbackIndex)
        ? body.workFeedbackIndex
        : undefined;
    if (body.workFeedbackIndex !== undefined && workFeedbackIndex === undefined) {
      return c.json({ error: "workFeedbackIndex must be an integer when provided." }, 400);
    }
    const skipOptionalUserCheckpointReason =
      typeof body.skipOptionalUserCheckpointReason === "string"
        ? body.skipOptionalUserCheckpointReason.trim()
        : undefined;
    if (
      body.skipOptionalUserCheckpointReason !== undefined &&
      (!skipOptionalUserCheckpointReason || typeof body.skipOptionalUserCheckpointReason !== "string")
    ) {
      return c.json({ error: "skipOptionalUserCheckpointReason must be a non-empty string when provided." }, 400);
    }

    const hasCommitMode = Object.prototype.hasOwnProperty.call(body, "commitShas");
    if (body.noCode !== undefined && body.noCode !== true) {
      return c.json({ error: "noCode must be true when provided." }, 400);
    }
    const hasNoCodeMode = body.noCode === true;
    if (
      body.preparationId !== undefined &&
      (typeof body.preparationId !== "string" || !/^[a-f0-9]{32}$/.test(body.preparationId) || hasNoCodeMode)
    ) {
      return c.json({ error: "preparationId requires an exact preparation ID and code commit evidence." }, 400);
    }
    if (hasCommitMode === hasNoCodeMode) {
      return c.json({ error: "Work -> Memory requires exactly one code evidence mode: commitShas or noCode." }, 400);
    }

    let commitShas: string[] | undefined;
    if (hasCommitMode) {
      if (!Array.isArray(body.commitShas) || body.commitShas.length === 0) {
        return c.json({ error: "commitShas must be a non-empty array when provided." }, 400);
      }
      try {
        commitShas = normalizeCommitShas(body.commitShas);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid commitShas." }, 400);
      }
      if (commitShas.length === 0) {
        return c.json({ error: "commitShas must contain at least one unique commit SHA." }, 400);
      }
    }

    const quest = await questStore.getQuest(questId).catch(() => null);
    if (!quest) return c.json({ error: `Quest not found: ${questId}` }, 404);
    if (quest.status !== "in_progress" || getTakodeQuestOwnerSessionId(quest) !== auth.callerId) {
      return c.json(
        { error: "Only the assigned worker that has claimed this in-progress quest may transition Work to Memory." },
        403,
      );
    }
    if (hasUnaddressedHumanFeedback(quest)) {
      return c.json({ error: "Cannot transition Work to Memory while human feedback remains unaddressed." }, 409);
    }

    const matches = findAssignedBoardRowsForWorker({
      wsBridge,
      launcher,
      workerSessionId: auth.callerId,
      questId,
    });
    if (matches.length === 0) {
      return c.json({ error: "No active board row assigns this quest to the authenticated worker." }, 404);
    }
    if (matches.length > 1) {
      return c.json(
        {
          error:
            "Multiple active board rows assign this quest to the worker; ask the leader to reconcile the board first.",
        },
        409,
      );
    }

    const initialMatch = matches[0]!;
    const releaseWorkEvidenceMutationLock = acquireWorkEvidenceMutationLock(initialMatch.leaderSessionId, questId);
    if (!releaseWorkEvidenceMutationLock) {
      return c.json({ error: "Another Work evidence mutation is still in progress; retry afterward." }, 409);
    }

    try {
      const normalizedStatus = (initialMatch.row.status ?? "").trim().toUpperCase();
      if (normalizedStatus !== "WORKING") {
        return c.json(
          {
            error: `Work -> Memory requires board state WORKING; current state is ${initialMatch.row.status ?? "unknown"}.`,
          },
          409,
        );
      }
      if ((initialMatch.row.waitForInput ?? []).length > 0) {
        return c.json({ error: "Cannot transition to Memory while a User Checkpoint is unresolved." }, 409);
      }

      const initialWorkContext = resolveActiveWorkPhaseContext(initialMatch.leaderSessionId, initialMatch.row, quest);
      if ("error" in initialWorkContext) return c.json({ error: initialWorkContext.error }, 409);
      const initialWorkNote = resolveCurrentWorkFeedback({
        quest,
        authorSessionId: auth.callerId,
        activeScope: initialWorkContext,
        ...(workFeedbackIndex !== undefined ? { requestedIndex: workFeedbackIndex } : {}),
      });
      if ("error" in initialWorkNote) return c.json({ error: initialWorkNote.error }, 409);
      const initialTarget = resolveWorkToMemoryTarget(initialWorkContext, skipOptionalUserCheckpointReason);
      if ("error" in initialTarget) return c.json({ error: initialTarget.error }, 409);

      if (
        hasNoCodeMode &&
        quest.codeDeliveries?.some((delivery) => delivery.phaseOccurrenceId === initialWorkContext.phaseOccurrenceId)
      ) {
        return c.json(
          {
            error:
              "This Work occurrence already recorded tracked changes; supply its synchronized commit evidence instead of no-code.",
          },
          409,
        );
      }

      if (commitShas) {
        try {
          const delivery = await buildCodeDelivery({
            questId,
            actorSessionId: auth.callerId,
            phaseOccurrenceId: initialWorkContext.phaseOccurrenceId,
            caller: auth.caller,
            commitShas,
            existing: quest,
            ...(typeof body.preparationId === "string" ? { preparationId: body.preparationId } : {}),
          });
          commitShas = delivery.commits.map((commit) => commit.sha);
          const updated = await questStore.appendQuestCodeCommitEvidenceForOwner(
            questId,
            { kind: "takode", sessionId: auth.callerId },
            commitShas,
            delivery,
          );
          if (!updated) return c.json({ error: `Quest not found: ${questId}` }, 404);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Cannot attach code commit evidence.";
          if (
            message.includes("in-progress quest") ||
            message.includes("exact active quest owner") ||
            message.includes("code commit SHA")
          ) {
            return c.json({ error: message }, 409);
          }
          console.warn(`[routes] Failed to attach Work commit evidence for ${questId}:`, error);
          return c.json({ error: `Cannot attach code commit evidence for ${questId}; try again.` }, 503);
        }
      }

      // Quest-store persistence above is asynchronous. Always re-read the durable
      // quest before touching the board so a concurrent status or owner change fails closed.
      const evidenceQuest = await questStore.getQuest(questId).catch(() => null);
      if (!evidenceQuest) return c.json({ error: `Quest not found: ${questId}` }, 404);
      if (evidenceQuest.status !== "in_progress" || getTakodeQuestOwnerSessionId(evidenceQuest) !== auth.callerId) {
        return c.json(
          { error: "Quest ownership changed while preparing Work -> Memory; retry after refreshing." },
          409,
        );
      }
      if (hasUnaddressedHumanFeedback(evidenceQuest)) {
        return c.json({ error: "Cannot transition Work to Memory while human feedback remains unaddressed." }, 409);
      }
      if (commitShas) {
        const storedCommitShas = new Set((evidenceQuest.commitShas ?? []).map((sha) => sha.toLowerCase()));
        if (commitShas.some((sha) => !storedCommitShas.has(sha))) {
          return c.json(
            { error: "Persisted Work commit evidence changed before Memory entry; refresh and retry." },
            409,
          );
        }
      }
      const refreshedMatches = findAssignedBoardRowsForWorker({
        wsBridge,
        launcher,
        workerSessionId: auth.callerId,
        questId,
      });
      if (refreshedMatches.length !== 1 || refreshedMatches[0]!.leaderSessionId !== initialMatch.leaderSessionId) {
        return c.json(
          { error: "The assigned Work board row changed while recording evidence; refresh and retry." },
          409,
        );
      }
      const [{ leaderSessionId, row }] = refreshedMatches;
      const refreshedStatus = (row.status ?? "").trim().toUpperCase();
      if (refreshedStatus !== "WORKING") {
        return c.json(
          { error: `Work -> Memory requires board state WORKING; current state is ${row.status ?? "unknown"}.` },
          409,
        );
      }
      if ((row.waitForInput ?? []).length > 0) {
        return c.json({ error: "Cannot transition to Memory while a User Checkpoint is unresolved." }, 409);
      }

      const leaderSession = wsBridge.getSession(leaderSessionId);
      if (!leaderSession) return c.json({ error: "Leader board session is unavailable." }, 409);
      const activeWorkContext = resolveActiveWorkPhaseContext(leaderSessionId, row, evidenceQuest);
      if ("error" in activeWorkContext) return c.json({ error: activeWorkContext.error }, 409);
      const workNote = resolveCurrentWorkFeedback({
        quest: evidenceQuest,
        authorSessionId: auth.callerId,
        activeScope: activeWorkContext,
        ...(workFeedbackIndex !== undefined ? { requestedIndex: workFeedbackIndex } : {}),
      });
      if ("error" in workNote) return c.json({ error: workNote.error }, 409);

      const target = resolveWorkToMemoryTarget(activeWorkContext, skipOptionalUserCheckpointReason);
      if ("error" in target) return c.json({ error: target.error }, 409);
      const { currentJourney, phaseIds } = activeWorkContext;

      // Publish the freshly re-read structured evidence before the board advertises Memory,
      // including historical commit truth carried through an explicit no-code Work occurrence.
      broadcastQuestUpdate(wsBridge, evidenceQuest);

      const board = upsertBoardRowController(
        leaderSession,
        {
          questId: row.questId,
          status: "MEMORY",
          worker: row.worker,
          workerNum: row.workerNum,
          journey: {
            ...currentJourney,
            mode: "active",
            phaseIds,
            activePhaseIndex: target.memoryIndex,
            currentPhaseId: "memory",
            ...(target.phaseSkipReasons ? { phaseSkipReasons: target.phaseSkipReasons } : {}),
          },
        },
        workBoardStateDeps,
      );

      return c.json({
        ok: true,
        questId: row.questId,
        leaderSessionId,
        previousState: row.status,
        newState: "MEMORY",
        workFeedbackIndex: workNote.index,
        delivery: evidenceQuest.codeDeliveries
          ?.filter((item) => item.phaseOccurrenceId === activeWorkContext.phaseOccurrenceId)
          .at(-1)
          ? projectQuestDelivery(
              questId,
              evidenceQuest
                .codeDeliveries!.filter((item) => item.phaseOccurrenceId === activeWorkContext.phaseOccurrenceId)
                .at(-1)!,
            )
          : undefined,
        board,
        rowSessionStatuses: await buildBoardRowSessionStatuses(board),
        queueWarnings: getBoardQueueWarningsController(leaderSession, boardWatchdogDeps),
        workerSlotUsage: getBoardWorkerSlotUsageController(leaderSessionId, boardWatchdogDeps),
        resolvedSessionDeps: resolveSessionDeps(board),
      });
    } finally {
      releaseWorkEvidenceMutationLock();
    }
  });

  api.post("/takode/board/replace-work-evidence", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    if (auth.caller.reviewerOf !== undefined) {
      return c.json({ error: "Reviewer sessions cannot replace Work code commit evidence." }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim() : "";
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    if (!Array.isArray(body.expectedCommitShas) || body.expectedCommitShas.length === 0) {
      return c.json({ error: "expectedCommitShas must be a non-empty array." }, 400);
    }
    if (!Array.isArray(body.commitShas) || body.commitShas.length === 0) {
      return c.json({ error: "commitShas must be a non-empty array." }, 400);
    }

    let expectedCommitShas: string[];
    let replacementCommitShas: string[];
    try {
      expectedCommitShas = normalizeCommitShas(body.expectedCommitShas);
      replacementCommitShas = normalizeCommitShas(body.commitShas);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid commit evidence." }, 400);
    }
    if (expectedCommitShas.length === 0 || replacementCommitShas.length === 0) {
      return c.json({ error: "Expected and replacement commit SHA lists must both be non-empty." }, 400);
    }
    if (
      expectedCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS ||
      replacementCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS
    ) {
      return c.json(
        {
          error: `Expected and replacement lists support at most ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS} commits each.`,
        },
        400,
      );
    }
    if (replacementCommitShas.length < expectedCommitShas.length) {
      return c.json({ error: "Replacement commit evidence cannot contain fewer commits than the expected list." }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason must be a non-empty string." }, 400);
    if (reason.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH) {
      return c.json(
        { error: `reason must be at most ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH} characters.` },
        400,
      );
    }
    if (
      expectedCommitShas.length === replacementCommitShas.length &&
      expectedCommitShas.every((sha, index) => sha === replacementCommitShas[index])
    ) {
      return c.json({ error: "Replacement commit evidence must differ from the expected stored evidence." }, 400);
    }

    const quest = await questStore.getQuest(questId).catch(() => null);
    if (!quest) return c.json({ error: `Quest not found: ${questId}` }, 404);
    if (quest.status !== "in_progress" || getTakodeQuestOwnerSessionId(quest) !== auth.callerId) {
      return c.json(
        { error: "Only the assigned worker that has claimed this in-progress quest may replace Work evidence." },
        403,
      );
    }
    const storedCommitShas = normalizeCommitShas(quest.commitShas ?? []);
    if (
      storedCommitShas.length !== expectedCommitShas.length ||
      storedCommitShas.some((sha, index) => sha !== expectedCommitShas[index])
    ) {
      return c.json({ error: "Stored code commit evidence does not exactly match the expected ordered commits." }, 409);
    }

    const matches = findAssignedBoardRowsForWorker({
      wsBridge,
      launcher,
      workerSessionId: auth.callerId,
      questId,
    });
    if (matches.length === 0) {
      return c.json({ error: "No active board row assigns this quest to the authenticated worker." }, 404);
    }
    if (matches.length > 1) {
      return c.json(
        { error: "Multiple active board rows assign this quest to the worker; ask the leader to reconcile the board." },
        409,
      );
    }

    const initialMatch = matches[0]!;
    if ((initialMatch.row.status ?? "").trim().toUpperCase() !== "WORKING") {
      return c.json(
        {
          error: `Replacing Work evidence requires board state WORKING; current state is ${initialMatch.row.status ?? "unknown"}.`,
        },
        409,
      );
    }
    if ((initialMatch.row.waitForInput ?? []).length > 0) {
      return c.json({ error: "Cannot replace Work evidence while a User Checkpoint is unresolved." }, 409);
    }
    const initialWorkContext = resolveActiveWorkPhaseContext(initialMatch.leaderSessionId, initialMatch.row, quest);
    if ("error" in initialWorkContext) return c.json({ error: initialWorkContext.error }, 409);
    const initialLeaderSessionId = initialMatch.leaderSessionId;
    const initialRowCreatedAt = initialMatch.row.createdAt;
    const initialPhaseOccurrenceId = initialWorkContext.phaseOccurrenceId;
    const releaseWorkEvidenceMutationLock = acquireWorkEvidenceMutationLock(initialLeaderSessionId, questId);
    if (!releaseWorkEvidenceMutationLock) {
      return c.json({ error: "Another Work evidence mutation is already in progress." }, 409);
    }

    try {
      const verifiedTarget = await verifyReplacementWorkEvidence(auth.caller, replacementCommitShas);
      if ("error" in verifiedTarget) return c.json({ error: verifiedTarget.error }, verifiedTarget.status);

      const refreshedMatches = findAssignedBoardRowsForWorker({
        wsBridge,
        launcher,
        workerSessionId: auth.callerId,
        questId,
      });
      if (
        refreshedMatches.length !== 1 ||
        refreshedMatches[0]!.leaderSessionId !== initialLeaderSessionId ||
        refreshedMatches[0]!.row.createdAt !== initialRowCreatedAt
      ) {
        return c.json({ error: "The assigned Work board row changed while verifying replacement evidence." }, 409);
      }
      const refreshedMatch = refreshedMatches[0]!;
      if ((refreshedMatch.row.status ?? "").trim().toUpperCase() !== "WORKING") {
        return c.json({ error: "The assigned board row left Work while verifying replacement evidence." }, 409);
      }
      if ((refreshedMatch.row.waitForInput ?? []).length > 0) {
        return c.json({ error: "A User Checkpoint became unresolved while verifying replacement evidence." }, 409);
      }
      const refreshedContext = resolveActiveWorkPhaseContext(refreshedMatch.leaderSessionId, refreshedMatch.row, quest);
      if ("error" in refreshedContext || refreshedContext.phaseOccurrenceId !== initialPhaseOccurrenceId) {
        return c.json({ error: "The active Work phase occurrence changed while verifying replacement evidence." }, 409);
      }

      let updated: QuestmasterTask | null;
      try {
        updated = await questStore.replaceQuestCodeCommitEvidenceForOwner(
          questId,
          { kind: "takode", sessionId: auth.callerId },
          {
            expectedCommitShas,
            replacementCommitShas: verifiedTarget.commitShas,
            reason,
            journeyRunId: refreshedContext.journeyRunId,
            phaseOccurrenceId: refreshedContext.phaseOccurrenceId,
            verifiedTargetBranch: verifiedTarget.branch,
            verifiedTargetHeadSha: verifiedTarget.headSha,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Cannot replace Work code commit evidence.";
        const lower = message.toLowerCase();
        if (
          lower.includes("in-progress quest") ||
          lower.includes("active quest owner") ||
          lower.includes("commit evidence") ||
          lower.includes("commit sha") ||
          lower.includes("expected") ||
          lower.includes("replacement")
        ) {
          return c.json({ error: message }, 409);
        }
        console.warn(`[routes] Failed to replace Work commit evidence for ${questId}:`, error);
        return c.json({ error: `Cannot replace Work code commit evidence for ${questId}; try again.` }, 503);
      }
      if (!updated) return c.json({ error: `Quest not found: ${questId}` }, 404);

      broadcastQuestUpdate(wsBridge, updated);
      const replacementEvent = updated.codeCommitEvidenceReplacementEvents?.at(-1);
      return c.json({
        ok: true,
        questId,
        previousCommitShas: expectedCommitShas,
        commitShas: verifiedTarget.commitShas,
        target: {
          mode: verifiedTarget.mode,
          checkoutPath: verifiedTarget.checkoutPath,
          branch: verifiedTarget.branch,
          headSha: verifiedTarget.headSha,
        },
        correction: {
          journeyRunId: refreshedContext.journeyRunId,
          phaseOccurrenceId: refreshedContext.phaseOccurrenceId,
          ...(replacementEvent?.ts ? { ts: replacementEvent.ts } : {}),
        },
      });
    } finally {
      releaseWorkEvidenceMutationLock();
    }
  });

  api.get("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    // Only the session owner can read their own board
    if (id !== auth.callerId) {
      return c.json({ error: "Can only read your own board" }, 403);
    }

    const bridgeSession = wsBridge.getSession(id);
    if (bridgeSession) await cleanupDoneBoardRows(bridgeSession);
    const board = bridgeSession ? getBoardController(bridgeSession) : [];
    const resolve = c.req.query("resolve") === "true";
    const includeCompleted = c.req.query("include_completed") === "true";
    const completedBoard = includeCompleted && bridgeSession ? getCompletedBoardController(bridgeSession) : [];
    const rowSessionStatuses = await buildBoardRowSessionStatuses([...board, ...completedBoard]);

    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses,
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      ...(includeCompleted ? { completedBoard } : {}),
      ...(resolve ? { resolvedSessionDeps: resolveSessionDeps(board) } : {}),
    });
  });

  api.post("/sessions/:id/board", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim() : "";
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }
    if (typeof body.noCode === "boolean") {
      return c.json(
        {
          error:
            "Board no-code markers were removed. Use the active v2 Alignment -> Work -> Memory flow; Work owns tracked sync duties when needed.",
        },
        400,
      );
    }

    // Auto-populate quest metadata from the quest store for compact board and lifecycle displays.
    let title: string | undefined = typeof body.title === "string" ? body.title : undefined;
    let questTldr: string | undefined;
    let quest: QuestmasterTask | null;
    try {
      quest = await questStore.getQuest(questId);
    } catch (e) {
      console.warn(`[routes] Failed to verify quest ownership for ${questId}:`, e);
      return c.json({ error: `Cannot verify quest ownership for ${questId}; try again.` }, 503);
    }
    if (quest && isDirectCodexOwnedQuest(quest)) {
      return c.json(
        { error: `Cannot add ${questId} to a Takode Work Board while it is owned by a direct Codex task.` },
        409,
      );
    }
    if (quest) {
      if (title === undefined) title = quest.title;
      questTldr = quest.tldr ?? "";
    }

    // Validate and normalize waitFor entries
    let waitFor: string[] | undefined;
    if (Array.isArray(body.waitFor)) {
      const parsed = body.waitFor
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      const invalid = parsed.filter((ref: string) => !isValidWaitForRef(ref));
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for value(s): ${invalid.join(", ")} -- use q-N for quests, #N for sessions, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
          },
          400,
        );
      }
      waitFor = parsed;
    }
    if (body.waitFor !== undefined && !Array.isArray(body.waitFor)) {
      return c.json({ error: "waitFor must be an array when provided" }, 400);
    }

    let waitForInput: string[] | undefined;
    const clearWaitForInput = body.clearWaitForInput === true;
    if (clearWaitForInput && body.waitForInput !== undefined) {
      return c.json({ error: "Use either waitForInput or clearWaitForInput, not both" }, 400);
    }
    if (Array.isArray(body.waitForInput)) {
      const parsed: Array<{ value: unknown; normalized: string | null }> = body.waitForInput
        .map((value: unknown) => ({ value, normalized: normalizeNeedsInputNotificationId(value) }))
        .filter((entry: { value: unknown; normalized: string | null }) => entry.value !== undefined);
      const invalid = parsed.filter((entry) => entry.normalized === null).map((entry) => String(entry.value).trim());
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid wait-for-input value(s): ${invalid.join(", ")} -- use same-session needs-input notification IDs like 3 or n-3`,
          },
          400,
        );
      }
      const normalizedIds = parsed
        .map((entry) => entry.normalized)
        .filter((notificationId): notificationId is string => typeof notificationId === "string");
      waitForInput = [...new Set(normalizedIds)].sort(
        (a: string, b: string) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10),
      );
    } else if (body.waitForInput !== undefined) {
      return c.json({ error: "waitForInput must be an array when provided" }, 400);
    }
    if (clearWaitForInput) waitForInput = [];

    const bridgeSession = wsBridge.getSession(id);
    const existingRow = bridgeSession?.board.get(questId) ?? null;
    const persistedPhaseError = existingRow?.journey
      ? validateQuestJourneyPersistedPhaseMutation(existingRow.journey, existingRow.status)
      : undefined;
    if (persistedPhaseError) return c.json({ error: persistedPhaseError }, 409);
    if (waitForInput && waitForInput.length > 0) {
      if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);
      const missing = waitForInput.filter(
        (notificationId) =>
          !bridgeSession.notifications.some(
            (notification) =>
              notification.id === notificationId &&
              notification.category === "needs-input" &&
              notification.done !== true,
          ),
      );
      if (missing.length > 0) {
        return c.json(
          {
            error: `Unknown or already-resolved same-session needs-input notification ID(s): ${missing.join(", ")}`,
          },
          400,
        );
      }
    }

    if (body.presentProposal === true) {
      if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);
      if (!existingRow || existingRow.status?.trim().toUpperCase() !== "PROPOSED") {
        return c.json({ error: "Presenting a Journey requires an existing proposed Journey row." }, 400);
      }
      const existingPhaseIds = normalizeKnownQuestJourneyPhaseIds(existingRow.journey?.phaseIds ?? []);
      if (existingRow.journey?.mode !== "proposed" || existingPhaseIds.length === 0) {
        return c.json({ error: "Presenting a Journey requires an existing proposed Journey row with phases." }, 400);
      }
      if (waitFor && waitFor.length > 0) {
        return c.json({ error: "Presented proposed Journey rows do not use queue wait-for dependencies." }, 400);
      }

      const normalizedDraft = normalizeQuestJourneyPlan(existingRow.journey, "PROPOSED");
      const metadata = {
        ...normalizeProposalMetadata(existingRow.journey?.presentation),
        ...normalizeProposalMetadata(body.presentation),
      };
      const presentation = {
        state: "presented" as const,
        signature: getQuestJourneyProposalSignature(normalizedDraft),
        presentedAt: Date.now(),
        ...metadata,
      };
      if (isWorkEvidenceMutationLocked(id, questId)) {
        return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
      }
      const board = upsertBoardRowController(
        bridgeSession,
        {
          questId,
          title,
          questTldr,
          journey: {
            ...normalizedDraft,
            mode: "proposed",
            presentation,
          },
          status: "PROPOSED",
          waitForInput,
        },
        workBoardStateDeps,
      );
      const presentedRow = board.find((row) => row.questId === questId);
      return c.json({
        board,
        rowSessionStatuses: await buildBoardRowSessionStatuses(board),
        queueWarnings: getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps),
        workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
        resolvedSessionDeps: resolveSessionDeps(board),
        ...(presentedRow ? { proposalReview: buildProposalReviewPayload(presentedRow) } : {}),
      });
    }

    let journey: QuestJourneyPlanState | undefined;
    let firstPlannedPhaseState: string | undefined;
    const explicitStatus = typeof body.status === "string" ? body.status.trim() || undefined : undefined;
    const explicitStatusUpper = explicitStatus?.toUpperCase();
    if (explicitStatusUpper && !(QUEST_JOURNEY_STATES as readonly string[]).includes(explicitStatusUpper)) {
      return c.json(
        {
          error:
            "Invalid active Quest Journey state. Active v2 states are PROPOSED, QUEUED, PLANNING, WORKING, USER_CHECKPOINTING, and MEMORY. Legacy v1 states are historical-read only.",
        },
        400,
      );
    }
    const explicitStatusPhase = getQuestJourneyPhaseForState(explicitStatus ?? null)?.id;
    const requestedMode = normalizeJourneyMode(body.journeyMode);
    if (body.journeyMode !== undefined && !requestedMode) {
      return c.json({ error: "journeyMode must be `active` or `proposed` when provided" }, 400);
    }
    const existingJourney = existingRow?.journey;
    const existingMode: QuestJourneyLifecycleMode =
      normalizeJourneyMode(existingJourney?.mode) ??
      ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED" ? "proposed" : "active");
    const targetMode = requestedMode ?? (explicitStatusUpper === "PROPOSED" ? "proposed" : (existingMode ?? "active"));
    if (existingRow && existingMode === "active" && targetMode === "proposed") {
      return c.json(
        {
          error:
            "Active Journey rows cannot be converted back to proposed drafts. Revise current/future active phases or append later occurrences instead.",
        },
        400,
      );
    }
    const revisionReason =
      typeof body.revisionReason === "string" && body.revisionReason.trim() ? body.revisionReason.trim() : undefined;
    if (typeof body.revisionReason === "string" && !revisionReason) {
      return c.json({ error: "Journey revision reason must not be empty" }, 400);
    }
    const phaseNoteEdits = normalizePhaseNoteEdits(body.phaseNoteEdits);
    if (body.phaseNoteEdits !== undefined && phaseNoteEdits === null) {
      return c.json({ error: "phaseNoteEdits must be an array of { index, note } edits when provided" }, 400);
    }
    const explicitActivePhaseIndex =
      typeof body.activePhaseIndex === "number" && Number.isInteger(body.activePhaseIndex)
        ? body.activePhaseIndex
        : null;
    if (body.activePhaseIndex !== undefined && (explicitActivePhaseIndex === null || explicitActivePhaseIndex < 0)) {
      return c.json({ error: "activePhaseIndex must be a non-negative integer when provided" }, 400);
    }
    if (targetMode === "proposed" && explicitStatus && explicitStatusUpper !== "PROPOSED") {
      return c.json({ error: "Proposed Journey rows must use status PROPOSED." }, 400);
    }
    if (targetMode === "active" && explicitStatusUpper === "PROPOSED") {
      return c.json({ error: "Status PROPOSED is only valid for proposed Journey rows." }, 400);
    }

    let typedPhaseIds: QuestJourneyPhaseId[] | undefined;
    const existingPhaseIds = normalizeKnownQuestJourneyPhaseIds(existingJourney?.phaseIds ?? []);
    if (existingJourney && Array.isArray(body.phases)) {
      return c.json(
        {
          error:
            "Existing Journey rows cannot be revised with board set or board propose. Use takode board revise for Journey changes.",
        },
        400,
      );
    }
    if (Array.isArray(body.phases)) {
      const phaseIds = body.phases
        .filter((s: unknown) => typeof s === "string" && s.trim())
        .map((s: string) => s.trim());
      if (phaseIds.length === 0) {
        return c.json({ error: "Quest Journey phases require at least one phase ID" }, 400);
      }
      const invalid = getInvalidQuestJourneyPhaseIds(phaseIds);
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid Quest Journey phase(s): ${invalid.join(", ")}. Active v2 phases are alignment, work, user-checkpoint, and memory; legacy v1 phase IDs are historical-read only.`,
          },
          400,
        );
      }
      typedPhaseIds = normalizeQuestJourneyPhaseIds(phaseIds) as QuestJourneyPhaseId[];
      const sequenceError = validateQuestJourneyPhaseSequence(typedPhaseIds);
      if (sequenceError) return c.json({ error: sequenceError }, 400);
      firstPlannedPhaseState = getQuestJourneyPhase(typedPhaseIds[0])?.boardState;
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      if (
        targetMode === "active" &&
        existingCurrentPhaseId &&
        !typedPhaseIds.includes(existingCurrentPhaseId) &&
        !explicitStatus
      ) {
        return c.json(
          {
            error:
              "Revised phases must include the current phase unless you also set an explicit status for the new active boundary.",
          },
          400,
        );
      }
      const checkpointPausesWork = explicitStatusPhase === "user-checkpoint" && typedPhaseIds.includes("work");
      if (explicitStatusPhase && !typedPhaseIds.includes(explicitStatusPhase) && !checkpointPausesWork) {
        return c.json(
          {
            error: `Status ${body.status} does not match the revised phase plan. Include its phase in --phases or change --status.`,
          },
          400,
        );
      }
    }

    const resolvedPhaseIds = typedPhaseIds ?? existingPhaseIds;
    const resolvedSequenceError =
      existingJourney && existingMode === "active"
        ? validateQuestJourneyPhaseSequenceMutation({
            existingPlan: existingJourney,
            existingStatus: existingRow?.status,
            nextPhaseIds: resolvedPhaseIds,
          })
        : validateQuestJourneyPhaseSequence(resolvedPhaseIds);
    if (resolvedSequenceError) return c.json({ error: resolvedSequenceError }, 400);
    if (typedPhaseIds && existingJourney && existingMode === "active") {
      const removalError = validateQuestJourneyUserCheckpointRemoval(
        existingPhaseIds,
        typedPhaseIds,
        existingJourney.phaseNotes,
      );
      if (removalError) return c.json({ error: removalError }, 400);
    }
    if (requestedMode === "active" && (!existingRow || existingMode !== "proposed" || existingPhaseIds.length === 0)) {
      return c.json(
        {
          error:
            "Promoting a Journey requires an existing proposed Journey row. Create it with `takode board propose` or revise an existing proposed row with `takode board revise`.",
        },
        400,
      );
    }
    if (phaseNoteEdits && resolvedPhaseIds.length === 0) {
      return c.json(
        { error: "Phase notes require an existing Journey row or explicit --phases for the target row." },
        400,
      );
    }
    if (targetMode === "proposed" && explicitActivePhaseIndex !== null) {
      return c.json({ error: "Proposed Journey rows cannot set an activePhaseIndex." }, 400);
    }
    if (targetMode === "active" && explicitActivePhaseIndex !== null && resolvedPhaseIds.length === 0) {
      return c.json({ error: "activePhaseIndex requires an existing Journey row or explicit --phases." }, 400);
    }
    if (
      targetMode === "active" &&
      explicitActivePhaseIndex !== null &&
      explicitActivePhaseIndex >= resolvedPhaseIds.length
    ) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} is out of range for the current Journey.`,
        },
        400,
      );
    }
    const explicitActivePhaseId =
      explicitActivePhaseIndex !== null && explicitActivePhaseIndex < resolvedPhaseIds.length
        ? resolvedPhaseIds[explicitActivePhaseIndex]
        : undefined;
    const explicitCheckpointPausesWork = explicitStatusPhase === "user-checkpoint" && explicitActivePhaseId === "work";
    if (
      explicitStatusPhase &&
      explicitActivePhaseId &&
      explicitStatusPhase !== explicitActivePhaseId &&
      !explicitCheckpointPausesWork
    ) {
      return c.json(
        {
          error: `activePhaseIndex ${explicitActivePhaseIndex} points to ${explicitActivePhaseId}, which does not match status ${body.status}.`,
        },
        400,
      );
    }

    if (
      existingJourney &&
      existingMode === "active" &&
      targetMode === "active" &&
      (typedPhaseIds || phaseNoteEdits || explicitActivePhaseIndex !== null || explicitStatusPhase)
    ) {
      const historyError = validateQuestJourneyCompletedPrefixRevision({
        existingPlan: existingJourney,
        existingStatus: existingRow?.status,
        ...(typedPhaseIds ? { nextPhaseIds: typedPhaseIds } : {}),
        ...(phaseNoteEdits ? { phaseNoteEditIndices: phaseNoteEdits.map((edit) => edit.index) } : {}),
        ...(explicitActivePhaseIndex !== null ? { nextActivePhaseIndex: explicitActivePhaseIndex } : {}),
      });
      if (historyError) return c.json({ error: historyError }, 400);
    }

    let phaseNoteRebaseWarnings: QuestJourneyPhaseNoteRebaseWarning[] = [];
    let phaseNotes = existingJourney?.phaseNotes;
    if (typedPhaseIds && existingJourney) {
      const rebaseResult = rebaseQuestJourneyPhaseNotes(existingJourney.phaseNotes, existingPhaseIds, typedPhaseIds);
      phaseNotes = rebaseResult.phaseNotes;
      phaseNoteRebaseWarnings = rebaseResult.warnings;
    }
    if (phaseNoteEdits) {
      try {
        phaseNotes = applyPhaseNoteEdits(phaseNotes, phaseNoteEdits, resolvedPhaseIds.length);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : "Invalid phase note update." }, 400);
      }
    }
    const checkpointNoteError = validateQuestJourneyUserCheckpointNotes(resolvedPhaseIds, phaseNotes);
    if (checkpointNoteError) return c.json({ error: checkpointNoteError }, 400);

    let activePhaseIndex: number | undefined;
    if (targetMode === "active" && resolvedPhaseIds.length > 0) {
      const existingCurrentPhaseId = getQuestJourneyPhase(existingJourney?.currentPhaseId)?.id;
      const existingCurrentPhaseIndex = getQuestJourneyCurrentPhaseIndex(existingJourney, existingRow?.status);
      if (explicitActivePhaseIndex !== null) {
        activePhaseIndex = explicitActivePhaseIndex;
      } else if (explicitStatusPhase) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, explicitStatusPhase, existingCurrentPhaseIndex);
      } else if (typedPhaseIds && existingMode === "active" && existingCurrentPhaseId) {
        activePhaseIndex = findPreservedPhaseIndex(resolvedPhaseIds, existingCurrentPhaseId, existingCurrentPhaseIndex);
        if (
          activePhaseIndex === undefined &&
          getQuestJourneyPhaseIndices(resolvedPhaseIds, existingCurrentPhaseId).length > 1
        ) {
          return c.json(
            {
              error:
                "The current Journey phase is repeated but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
            },
            400,
          );
        }
      } else if ((requestedMode === "active" && existingMode === "proposed") || !existingRow?.status) {
        activePhaseIndex = 0;
      }
      if (
        explicitStatusPhase &&
        explicitActivePhaseIndex === null &&
        activePhaseIndex === undefined &&
        getQuestJourneyPhaseIndices(resolvedPhaseIds, explicitStatusPhase).length > 1
      ) {
        return c.json(
          {
            error:
              "Status points to a repeated Journey phase but the active occurrence is ambiguous. Re-run with activePhaseIndex (CLI: --active-phase-position).",
          },
          400,
        );
      }
      if (
        existingJourney &&
        existingMode === "active" &&
        (explicitActivePhaseIndex !== null || explicitStatusPhase) &&
        activePhaseIndex !== undefined
      ) {
        const historyError = validateQuestJourneyCompletedPrefixRevision({
          existingPlan: existingJourney,
          existingStatus: existingRow?.status,
          nextActivePhaseIndex: activePhaseIndex,
        });
        if (historyError) return c.json({ error: historyError }, 400);
      }
      if (existingJourney && existingMode === "active" && (explicitActivePhaseIndex !== null || explicitStatusPhase)) {
        const skipError = validateExplicitUserCheckpointSkips(
          resolvedPhaseIds,
          phaseNotes,
          existingJourney.phaseSkipReasons,
          existingCurrentPhaseIndex,
          activePhaseIndex,
        );
        if (skipError) return c.json({ error: skipError }, 400);
      }
    }

    const presentationMetadata = normalizeProposalMetadata(body.presentation);
    const hasPresentationMetadata = Object.keys(presentationMetadata).length > 0;
    const shouldPresentProposedJourney = targetMode === "proposed" && !!typedPhaseIds;
    if (shouldPresentProposedJourney && !presentationMetadata.summary) {
      return c.json(
        {
          error: "Proposed Journey rows require a non-empty summary. CLI: use takode board propose --summary <text>.",
        },
        400,
      );
    }
    const draftMutation =
      targetMode === "proposed" && (typedPhaseIds || phaseNoteEdits || revisionReason || hasPresentationMetadata);
    const resolvedPresetId =
      typedPhaseIds && typeof body.presetId === "string" && body.presetId.trim()
        ? body.presetId.trim()
        : (existingJourney?.presetId ?? (typedPhaseIds ? "custom" : undefined));
    const presentation =
      targetMode === "proposed"
        ? {
            ...(existingJourney?.presentation ?? {}),
            ...presentationMetadata,
            state: shouldPresentProposedJourney
              ? ("presented" as const)
              : (existingJourney?.presentation?.state ?? ("draft" as const)),
            ...(shouldPresentProposedJourney
              ? {
                  signature: getQuestJourneyProposalSignature({
                    presetId: resolvedPresetId,
                    phaseIds: resolvedPhaseIds,
                    ...(phaseNotes ? { phaseNotes } : {}),
                  }),
                  presentedAt: Date.now(),
                }
              : draftMutation
                ? {
                    state: "draft" as const,
                    signature: undefined,
                    presentedAt: undefined,
                  }
                : {}),
          }
        : undefined;

    if (
      typedPhaseIds ||
      phaseNoteEdits ||
      revisionReason ||
      requestedMode ||
      explicitActivePhaseIndex !== null ||
      hasPresentationMetadata
    ) {
      journey = {
        phaseIds: resolvedPhaseIds.length > 0 ? resolvedPhaseIds : [],
        presetId: resolvedPresetId,
        mode: targetMode,
        ...(targetMode === "active" && activePhaseIndex !== undefined ? { activePhaseIndex } : {}),
        ...(phaseNotes ? { phaseNotes } : {}),
        ...(targetMode === "proposed" ? { presentation } : { presentation: undefined }),
        ...(revisionReason ? { revisionReason } : {}),
      };
    }

    const implicitQueuedStatus =
      !explicitStatus &&
      explicitActivePhaseIndex === null &&
      targetMode === "active" &&
      typeof body.worker !== "string" &&
      waitFor !== undefined &&
      !existingRow?.status
        ? "QUEUED"
        : undefined;
    const explicitActiveStatus =
      explicitActivePhaseId !== undefined ? getQuestJourneyPhase(explicitActivePhaseId)?.boardState : undefined;
    const defaultActiveStatus =
      explicitActiveStatus ??
      firstPlannedPhaseState ??
      (resolvedPhaseIds.length > 0 ? getQuestJourneyPhase(resolvedPhaseIds[0])?.boardState : undefined);
    const mergedStatus =
      explicitStatus ??
      (targetMode === "proposed"
        ? "PROPOSED"
        : (implicitQueuedStatus ??
          ((existingRow?.status || "").trim().toUpperCase() === "PROPOSED"
            ? defaultActiveStatus
            : (existingRow?.status?.trim() ?? defaultActiveStatus))));
    const mergedStatusUpper = (mergedStatus || "").trim().toUpperCase();
    const existingStatusUpper = (existingRow?.status ?? "").trim().toUpperCase();
    const targetsActiveV2Journey =
      targetMode === "active" &&
      (!existingRow ||
        existingPhaseIds.length === 0 ||
        existingPhaseIds.every((phaseId) => !isLegacyQuestJourneyPhaseId(phaseId)));
    if (targetsActiveV2Journey && mergedStatusUpper === "MEMORY" && existingStatusUpper !== "MEMORY") {
      return c.json(
        {
          error:
            "Active v2 Work -> Memory must use `takode board work-to-memory` with explicit synchronized commit or no-code evidence.",
        },
        409,
      );
    }
    const mergedWaitFor =
      targetMode === "proposed" ? undefined : waitFor !== undefined ? waitFor : existingRow?.waitFor;
    const mergedWaitForInput = waitForInput !== undefined ? waitForInput : existingRow?.waitForInput;
    const mergedIsQueued = mergedStatusUpper === "QUEUED";
    if (targetMode === "proposed" && typeof body.worker === "string" && body.worker.trim()) {
      return c.json({ error: "Proposed Journey rows cannot be assigned to a worker yet." }, 400);
    }
    if (targetMode === "proposed" && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error:
            "Proposed Journey rows do not use queue wait-for dependencies. Use wait-for-input to hold for approval.",
        },
        400,
      );
    }
    if (mergedIsQueued && mergedWaitForInput && mergedWaitForInput.length > 0) {
      return c.json(
        {
          error: "wait-for-input is only valid on active board rows; clear it before moving a row to QUEUED.",
        },
        400,
      );
    }
    if (waitFor && waitFor.length > 0 && waitForInput && waitForInput.length > 0) {
      return c.json(
        {
          error:
            "wait-for and wait-for-input cannot both be set on the same row. Use wait-for for QUEUED rows or wait-for-input for active rows.",
        },
        400,
      );
    }
    if (!mergedIsQueued && waitFor && waitFor.length > 0) {
      return c.json(
        {
          error: "wait-for is only valid on QUEUED board rows; clear it before moving a row active.",
        },
        400,
      );
    }
    if (targetMode === "active" && mergedStatusUpper === "PROPOSED") {
      return c.json({ error: "Active Journey rows cannot keep status PROPOSED." }, 400);
    }
    if (mergedIsQueued && (!mergedWaitFor || mergedWaitFor.length === 0)) {
      return c.json(
        {
          error: `Queued rows require an explicit wait-for reason -- use q-N, #N, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
        },
        400,
      );
    }
    if (mergedIsQueued) {
      const quest = await questStore.getQuest(questId).catch(() => null);
      if (quest?.status === "done") {
        syncDoneQuestBoardState(questId);
        return c.json({ error: `Cannot queue ${questId}: quest is already done.` }, 409);
      }
    }

    const statusForUpsert = mergedStatus;
    const workerForUpsert = targetMode === "proposed" ? "" : typeof body.worker === "string" ? body.worker : undefined;
    const workerNumForUpsert =
      targetMode === "proposed" ? undefined : typeof body.workerNum === "number" ? body.workerNum : undefined;

    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }
    const board = bridgeSession
      ? upsertBoardRowController(
          bridgeSession,
          {
            questId,
            title,
            questTldr,
            worker: workerForUpsert,
            workerNum: workerNumForUpsert,
            journey,
            status: statusForUpsert,
            waitFor: targetMode === "proposed" ? [] : waitFor,
            waitForInput,
          },
          workBoardStateDeps,
        )
      : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    const changedRow = board.find((row) => row.questId === questId);
    const proposalReview = changedRow ? buildProposalReviewPayload(changedRow) : undefined;
    return c.json({
      board,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
      ...(proposalReview ? { proposalReview } : {}),
      ...(phaseNoteRebaseWarnings.length > 0 ? { phaseNoteRebaseWarnings } : {}),
    });
  });

  api.delete("/sessions/:id/board/:questId", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questIds = c.req
      .param("questId")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (questIds.length === 0) return c.json({ error: "questId is required" }, 400);
    const invalid = questIds.filter((qid) => !isValidQuestId(qid));
    if (invalid.length > 0) {
      return c.json(
        { error: `Invalid quest ID(s): ${invalid.join(", ")} -- must match q-NNN format (e.g., q-1, q-42)` },
        400,
      );
    }
    if (questIds.some((questId) => isWorkEvidenceMutationLocked(id, questId))) {
      return c.json({ error: "Cannot remove a board row while a Work evidence mutation is in progress." }, 409);
    }

    const bridgeSession = wsBridge.getSession(id);
    const board = bridgeSession ? removeBoardRowsController(bridgeSession, questIds, workBoardStateDeps) : null;
    if (!board) return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({
      board,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
    });
  });

  api.post("/sessions/:id/board/:questId/revise", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questId = c.req.param("questId").trim();
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: 'Invalid quest ID "' + questId + '": must match q-NNN format (e.g., q-1, q-42)' }, 400);
    }
    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }

    const bridgeSession = wsBridge.getSession(id);
    if (!bridgeSession) return c.json({ error: "Session not found in bridge" }, 404);

    const existingRow = bridgeSession.board.get(questId) ?? null;
    if (!existingRow?.journey) {
      return c.json(
        {
          error:
            "Cannot revise " +
            questId +
            ": no existing Journey row found. Use takode board set to create the initial Journey.",
        },
        404,
      );
    }
    const persistedPhaseError = validateQuestJourneyPersistedPhaseMutation(existingRow.journey, existingRow.status);
    if (persistedPhaseError) return c.json({ error: persistedPhaseError }, 409);

    const body = await c.req.json().catch(() => ({}));
    const fromIndex =
      typeof body.fromIndex === "number" && Number.isInteger(body.fromIndex) ? body.fromIndex : undefined;
    if (fromIndex === undefined || fromIndex < 0) {
      return c.json({ error: "fromIndex must be a non-negative integer." }, 400);
    }

    const expectedPhaseId =
      typeof body.expectedPhaseId === "string" ? canonicalizeQuestJourneyPhaseId(body.expectedPhaseId) : null;
    if (!expectedPhaseId) {
      return c.json({ error: "expectedPhaseId must name a valid Journey phase." }, 400);
    }

    if (!Array.isArray(body.phases)) {
      return c.json({ error: "phases must be an array of replacement Journey phase IDs." }, 400);
    }
    const rawReplacementPhases = body.phases
      .filter((value: unknown) => typeof value === "string" && value.trim())
      .map((value: string) => value.trim());
    if (rawReplacementPhases.length === 0) {
      return c.json({ error: "Journey revision requires at least one replacement phase." }, 400);
    }
    const invalid = getInvalidQuestJourneyPhaseIds(rawReplacementPhases);
    if (invalid.length > 0) {
      return c.json({ error: "Invalid Quest Journey phase(s): " + invalid.join(", ") }, 400);
    }
    const replacementPhaseIds = normalizeQuestJourneyPhaseIds(rawReplacementPhases);

    const phaseNoteEdits = normalizePhaseNoteEdits(body.phaseNoteEdits);
    if (body.phaseNoteEdits !== undefined && phaseNoteEdits === null) {
      return c.json({ error: "phaseNoteEdits must be an array of { index, note } edits when provided" }, 400);
    }
    const outOfRangeNote = phaseNoteEdits?.find((edit) => edit.index >= replacementPhaseIds.length);
    if (outOfRangeNote) {
      return c.json(
        {
          error: "Phase note index " + (outOfRangeNote.index + 1) + " is out of range for the replacement suffix.",
        },
        400,
      );
    }
    const replacementPhaseNotes =
      phaseNoteEdits && phaseNoteEdits.length > 0
        ? Object.fromEntries(phaseNoteEdits.flatMap((edit) => (edit.note ? [[String(edit.index), edit.note]] : [])))
        : undefined;

    const existingJourney = existingRow.journey;
    const existingPhaseIds = normalizeKnownQuestJourneyPhaseIds(existingJourney.phaseIds ?? []);
    const existingMode: QuestJourneyLifecycleMode =
      normalizeJourneyMode(existingJourney.mode) ??
      ((existingRow.status || "").trim().toUpperCase() === "PROPOSED" ? "proposed" : "active");

    const currentPhaseIndex = getQuestJourneyCurrentPhaseIndex(existingJourney, existingRow.status);
    const exploreImplementAllowance = getCompletedExploreImplementRevisionAllowance(
      existingMode,
      existingPhaseIds,
      currentPhaseIndex,
      fromIndex,
      replacementPhaseIds,
    );
    const nextPhaseCandidate = [...existingPhaseIds.slice(0, fromIndex), ...replacementPhaseIds];
    const historyError = validateQuestJourneyCompletedPrefixRevision({
      existingPlan: existingJourney,
      existingStatus: existingRow.status,
      nextPhaseIds: nextPhaseCandidate,
    });
    if (historyError) return c.json({ error: historyError }, 400);

    if (existingMode === "active" && currentPhaseIndex !== undefined && fromIndex <= currentPhaseIndex) {
      return c.json(
        {
          error:
            "Active Journey revisions must start after the current phase. Completed and current phase occurrences are not revised in place.",
        },
        400,
      );
    }

    const revision = reviseQuestJourneySuffix({
      existingPhaseIds,
      fromIndex,
      expectedPhaseId,
      replacementPhaseIds,
      existingPhaseNotes: existingJourney.phaseNotes,
      replacementPhaseNotes,
    });
    if (revision.error) return c.json({ error: revision.error }, 400);
    const nextPhaseIds = revision.phaseIds ?? [];
    let revisedPhaseNotes = revision.phaseNotes;
    if (phaseNoteEdits) {
      const nextNotes = new Map<string, string>(Object.entries(revisedPhaseNotes ?? {}));
      for (const edit of phaseNoteEdits) {
        const key = String(fromIndex + edit.index);
        if (edit.note) nextNotes.set(key, edit.note);
        else nextNotes.delete(key);
      }
      revisedPhaseNotes = nextNotes.size > 0 ? Object.fromEntries([...nextNotes.entries()]) : undefined;
    }

    const sequenceError = validateQuestJourneyPhaseSequenceMutation({
      existingPlan: existingJourney,
      existingStatus: existingRow.status,
      nextPhaseIds,
      allowedAdjacentExploreImplementIndex: exploreImplementAllowance?.adjacentExploreImplementIndex,
    });
    if (sequenceError) return c.json({ error: sequenceError }, 400);
    if (existingMode === "active") {
      const removalError = validateQuestJourneyUserCheckpointRemoval(
        existingPhaseIds,
        nextPhaseIds,
        existingJourney.phaseNotes,
        { allowedRemovedUserCheckpointIndex: exploreImplementAllowance?.removedCheckpointIndex },
      );
      if (removalError) return c.json({ error: removalError }, 400);
    }
    const checkpointNoteError = validateQuestJourneyUserCheckpointNotes(nextPhaseIds, revisedPhaseNotes);
    if (checkpointNoteError) return c.json({ error: checkpointNoteError }, 400);

    const presentation =
      existingMode === "proposed"
        ? {
            ...(existingJourney.presentation ?? {}),
            state: "draft" as const,
            signature: undefined,
            presentedAt: undefined,
          }
        : undefined;
    const revisionReason =
      typeof body.revisionReason === "string" && body.revisionReason.trim() ? body.revisionReason.trim() : undefined;
    const journey: QuestJourneyPlanState = {
      phaseIds: nextPhaseIds,
      presetId:
        typeof body.presetId === "string" && body.presetId.trim()
          ? body.presetId.trim()
          : (existingJourney.presetId ?? "custom"),
      mode: existingMode,
      ...(existingMode === "active" && currentPhaseIndex !== undefined ? { activePhaseIndex: currentPhaseIndex } : {}),
      ...(revisedPhaseNotes ? { phaseNotes: revisedPhaseNotes } : {}),
      ...(existingMode === "proposed" ? { presentation } : { presentation: undefined }),
      ...(revisionReason ? { revisionReason } : {}),
    };

    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }
    const board = upsertBoardRowController(
      bridgeSession,
      {
        questId,
        title: existingRow.title,
        questTldr: existingRow.questTldr,
        journey,
        status: existingRow.status,
      },
      workBoardStateDeps,
    );

    return c.json({
      board,
      rowSessionStatuses: await buildBoardRowSessionStatuses(board),
      queueWarnings: getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps),
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(board),
      ...(revision.warnings.length > 0 ? { phaseNoteRebaseWarnings: revision.warnings } : {}),
    });
  });

  api.post("/sessions/:id/board/:questId/advance", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only modify your own board" }, 403);
    }

    const questId = c.req.param("questId").trim();
    if (!questId) return c.json({ error: "questId is required" }, 400);
    if (!isValidQuestId(questId)) {
      return c.json({ error: `Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)` }, 400);
    }
    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }

    const bridgeSession = wsBridge.getSession(id);
    const existingRow = bridgeSession?.board.get(questId);
    const persistedPhaseError = existingRow?.journey
      ? validateQuestJourneyPersistedPhaseMutation(existingRow.journey, existingRow.status)
      : undefined;
    if (persistedPhaseError) return c.json({ error: persistedPhaseError }, 409);
    const body = await c.req.json().catch(() => undefined);
    const skipOptionalUserCheckpointReason =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      typeof (body as { skipOptionalUserCheckpointReason?: unknown }).skipOptionalUserCheckpointReason === "string"
        ? (body as { skipOptionalUserCheckpointReason: string }).skipOptionalUserCheckpointReason.trim()
        : undefined;
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "skipOptionalUserCheckpointReason" in body &&
      !skipOptionalUserCheckpointReason
    ) {
      return c.json({ error: "skipOptionalUserCheckpointReason must be a non-empty string when provided" }, 400);
    }
    if (isWorkEvidenceMutationLocked(id, questId)) {
      return c.json({ error: "Cannot mutate this board row while a Work evidence mutation is in progress." }, 409);
    }
    const result = bridgeSession
      ? advanceBoardRowController(bridgeSession, questId, QUEST_JOURNEY_STATES, workBoardStateDeps, {
          ...(skipOptionalUserCheckpointReason ? { skipOptionalUserCheckpointReason } : {}),
        })
      : null;
    if (!result) return c.json({ error: "Quest not found on board" }, 404);
    if ("error" in result) return c.json({ error: result.error }, 409);
    return c.json({
      ...result,
      completedCount: bridgeSession?.completedBoard.size ?? 0,
      rowSessionStatuses: await buildBoardRowSessionStatuses(result.board),
      queueWarnings: bridgeSession ? getBoardQueueWarningsController(bridgeSession, boardWatchdogDeps) : [],
      workerSlotUsage: getBoardWorkerSlotUsageController(id, boardWatchdogDeps),
      resolvedSessionDeps: resolveSessionDeps(result.board),
    });
  });
}
