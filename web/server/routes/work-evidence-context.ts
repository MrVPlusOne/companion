import {
  getQuestJourneyCurrentPhaseIndex,
  normalizeQuestJourneyPlan,
  type QuestJourneyPlanState,
  type QuestJourneyPhaseId,
} from "../../shared/quest-journey.js";
import { indexedLiveQuestFeedbackEntries } from "../../shared/quest-feedback.js";
import type { BoardRow } from "../session-types.js";
import type { QuestmasterTask } from "../quest-types.js";
import type { RouteContext } from "./context.js";

export function hasUnaddressedHumanFeedback(quest: QuestmasterTask): boolean {
  return indexedLiveQuestFeedbackEntries(quest.feedback).some(
    (entry) => entry.author === "human" && entry.addressed !== true,
  );
}

export interface ActiveWorkPhaseContext {
  currentJourney: QuestJourneyPlanState;
  phaseIds: QuestJourneyPhaseId[];
  currentPhaseIndex: number;
  journeyRunId: string;
  phaseOccurrenceId: string;
}

export function resolveActiveWorkPhaseContext(
  leaderSessionId: string,
  row: BoardRow,
  quest: QuestmasterTask,
): ActiveWorkPhaseContext | { error: string } {
  const currentJourney = normalizeQuestJourneyPlan(row.journey, row.status);
  const phaseIds = [...currentJourney.phaseIds];
  const currentPhaseIndex = getQuestJourneyCurrentPhaseIndex({ ...currentJourney, phaseIds }, row.status);
  if (currentPhaseIndex === undefined || phaseIds[currentPhaseIndex] !== "work") {
    return { error: "Work -> Memory requires an unambiguous current Work phase occurrence." };
  }
  const journeyRunId = `board-${leaderSessionId.slice(0, 8)}-${row.createdAt}`;
  const snapshottedOccurrenceId = quest.journeyRuns
    ?.find((run) => run.runId === journeyRunId)
    ?.phaseOccurrences.find((occurrence) => occurrence.phaseIndex === currentPhaseIndex)?.occurrenceId;
  return {
    currentJourney,
    phaseIds,
    currentPhaseIndex,
    journeyRunId,
    phaseOccurrenceId: snapshottedOccurrenceId ?? `${journeyRunId}:p${currentPhaseIndex + 1}`,
  };
}

export function resolveCurrentWorkFeedback(args: {
  quest: QuestmasterTask;
  authorSessionId: string;
  activeScope: Pick<ActiveWorkPhaseContext, "journeyRunId" | "phaseOccurrenceId">;
  requestedIndex?: number;
}): { index: number } | { error: string } {
  const hasCurrentRunSnapshot = (args.quest.journeyRuns ?? []).some(
    (run) => run.runId === args.activeScope.journeyRunId,
  );
  const candidateEntries = indexedLiveQuestFeedbackEntries(args.quest.feedback).filter(({ index, ...entry }) => {
    if (args.requestedIndex !== undefined && index !== args.requestedIndex) return false;
    const isEligibleWorkNote =
      entry.author === "agent" &&
      entry.authorSessionId === args.authorSessionId &&
      entry.phaseId === "work" &&
      (entry.kind === "phase_summary" || entry.kind === undefined) &&
      entry.text.trim().length >= 80;
    if (!isEligibleWorkNote) return false;

    const matchesActiveScope =
      entry.journeyRunId === args.activeScope.journeyRunId &&
      entry.phaseOccurrenceId === args.activeScope.phaseOccurrenceId;
    if (matchesActiveScope) return true;
    if (hasCurrentRunSnapshot) return false;

    // Compatibility for phase notes created before board-backed run snapshots existed.
    return (
      entry.journeyRunId === undefined &&
      entry.phaseOccurrenceId === undefined &&
      entry.phaseIndex === undefined &&
      entry.phasePosition === undefined &&
      entry.phaseOccurrence === undefined
    );
  });
  const latest = candidateEntries.at(-1);
  if (latest) return { index: latest.index };
  if (args.requestedIndex !== undefined) {
    return { error: `Feedback #${args.requestedIndex} is not the current Work phase note by this worker.` };
  }
  return {
    error:
      "A Work phase note for the active Journey run and phase occurrence is required before Work can transition to Memory.",
  };
}

export function findAssignedBoardRowsForWorker(args: {
  wsBridge: RouteContext["wsBridge"];
  launcher: RouteContext["launcher"];
  workerSessionId: string;
  questId: string;
}): Array<{ leaderSessionId: string; row: BoardRow }> {
  const normalizedQuestId = args.questId.toLowerCase();
  const bridgeCompat = args.wsBridge as {
    findAssignedBoardRowsForWorker?: (
      workerSessionId: string,
      questId: string,
    ) => Array<{ leaderSessionId: string; row: BoardRow }>;
  };
  if (typeof bridgeCompat.findAssignedBoardRowsForWorker === "function") {
    return bridgeCompat.findAssignedBoardRowsForWorker(args.workerSessionId, args.questId);
  }
  const matches: Array<{ leaderSessionId: string; row: BoardRow }> = [];
  for (const launcherSession of args.launcher.listSessions?.() ?? []) {
    const sessionId = launcherSession.sessionId ?? (launcherSession as { id?: string }).id;
    if (!sessionId) continue;
    const bridgeSession = args.wsBridge.getSession(sessionId);
    if (!bridgeSession?.board) continue;
    const row = [...bridgeSession.board.values()].find(
      (candidate: BoardRow) =>
        candidate.questId.toLowerCase() === normalizedQuestId && candidate.worker === args.workerSessionId,
    );
    if (row) matches.push({ leaderSessionId: bridgeSession.id, row });
  }
  return matches;
}
