import {
  apiDelete,
  apiGet,
  apiPost,
  assertKnownFlags,
  err,
  formatInlineText,
  formatTimestampCompact,
  getCallerSessionId,
  parseFlags,
  parseIntegerFlag,
  readOptionTextFile,
} from "./takode-core.js";
import { handleRecordDelivery } from "./takode-record-delivery.js";
import { handleDeliveryTarget, deliveryTargetFlag, DELIVERY_TARGET_HELP } from "./takode-delivery-target.js";
import type { QuestDeliveryView } from "../shared/quest-delivery.js";
import { parseCommitShas } from "./quest-commit-flags.js";
import {
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS,
  MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH,
} from "../shared/quest-code-commit-evidence.ts";
// ─── Board ─────────────────────────────────────────────────────────────────

import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  canonicalizeQuestJourneyPhaseId,
  formatWaitForRefLabel,
  type BoardQueueWarning,
  getInvalidQuestJourneyPhaseIds,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  isQuestWaitForBlockingState,
  normalizeQuestJourneyPhaseIds,
  QUEST_JOURNEY_STATES,
  QUEST_JOURNEY_HINTS,
  getWaitForRefKind,
  isValidQuestId,
  isValidWaitForRef,
  type QuestJourneyPhaseId,
  type QuestJourneyPhaseNoteRebaseWarning,
  type QuestJourneyPlanState,
  validateQuestJourneyPhaseSequence,
  validateQuestJourneyUserCheckpointNotes,
} from "../shared/quest-journey.ts";

export const BOARD_HELP = `Usage: takode board [show|detail|set|revise|propose|promote|note|work-to-memory|replace-work-evidence|advance|rm] ...

Quest Journey work board for the current leader session.

Subcommands:
  show                    Show the board (default)
  detail <quest-id>       Show full Journey details for one board row
  set <quest-id>          Add or update a board row
  revise <quest-id>       Replace an existing Journey suffix
  propose <quest-id>      Create a proposed Journey row
  promote <quest-id>      Promote a proposed Journey row into execution
  note <quest-id>         Add or clear a per-phase Journey note
  work-to-memory <quest-id>
                          Worker-owned transition from Work to Memory
  approve-delivery-target <quest-id>
                          Assigned leader records an independent published target
  delivery-targets <quest-id>
                          Inspect immutable target approvals; --target reveals detail
  replace-work-evidence <quest-id>
                          Audited correction of invalid Work commit evidence
  advance <quest-id>      Move through non-Work Journey boundaries
  rm <quest-id> [...]     Remove quests from the active board

Examples:
  takode board show
  takode board show --full
  takode board detail q-12
  takode board set q-12 --status PLANNING
  takode board set q-12 --phases alignment,work,memory --preset v2-work
  takode board revise q-12 --from-position 2 --expect-phase work --phases work,memory
  takode board set q-12 --status WORKING --active-phase-position 2
  takode board propose q-12 --phases alignment,work,memory --summary "Approve the goal, constraints, and scheduling for this proposed Journey." --preset v2-work --wait-for-input 3
  takode board promote q-12 --worker 5
  takode board note q-12 3 --text "Inspect only the follow-up diff"
  takode board work-to-memory q-12 --work-note 4 --commits "abc1234,def5678"
  takode board work-to-memory q-13 --work-note 5 --no-code
  takode board replace-work-evidence q-13 --expected-commits "bad1234" --commits "abc1234" --reason "Correct mistyped delivery evidence"
  takode board set q-12 --status QUEUED --wait-for ${FREE_WORKER_WAIT_FOR_TOKEN}
  takode board set q-12 --status USER_CHECKPOINTING --wait-for-input 3,4
  takode board set q-12 --clear-wait-for-input
  takode board set q-12 --worker 5 --wait-for q-7,#9
  takode board advance q-12 --skip-optional-checkpoint "Alignment found no user-visible tradeoff"
  takode board advance q-12
  takode board rm q-12
`;

export const BOARD_DETAIL_HELP = `Usage: takode board detail <quest-id> [--json]

Show full board-owned Quest Journey details, notes, timings, and revision metadata for one quest row.
`;

export const BOARD_SET_HELP = `Usage: takode board set <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--title <title>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids> | --journey-file <path|->] [--preset <id>] [--full|--verbose] [--json]
       takode board add <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--title <title>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids> | --journey-file <path|->] [--preset <id>] [--full|--verbose] [--json]

Add or update a board row for a quest. Use this to create the initial Journey; once a row already has a Journey, use takode board revise for phase-plan changes.

Quest Journey phases:
  --phases alignment,work,memory
  --phases alignment,work,user-checkpoint,work,memory  # only for preset checkpoint pauses
  --journey-file <path|-> reads { phases: [{ id, note? }] } JSON for initial Journey creation
  --preset <id> labels the planned phase sequence; use with --phases
  --active-phase-position <n> pins the active occurrence for repeated phases using a 1-based phase position
  --wait-for-input links active rows to same-session needs-input notifications by ID (for example 3 or n-3)
  --clear-wait-for-input removes any existing linked needs-input wait state

Quest Journey v2 has one active workflow: Alignment -> Work -> Memory. User Checkpoint is a durable pause/resume inside Work for decisions outside the approved envelope. Legacy v1 phase IDs are historical-read only and are rejected for new active rows.

Zero-tracked-change work still ends in Memory. Work owns any necessary sync/push duties for tracked changes inside the approved envelope.
`;

export const BOARD_REVISE_HELP = `Usage: takode board revise <quest-id> --from-position <n> --expect-phase <id> (--phases <ids> | --journey-file <path|->) [--preset <id>] [--full|--verbose] [--json]

Replace an existing Journey suffix. Phase positions are 1-based in CLI usage. The existing phase at --from-position must match --expect-phase, so repeated phases and stale position references fail closed.

Replace only current or future active v2 phases. Legacy v1 phase IDs are historical-read only and cannot be introduced by revise.

Use --journey-file when the replacement suffix needs notes:
  { "phases": [{ "id": "work", "note": "Preserve the approved safety boundary." }, { "id": "memory" }] }
`;

export const BOARD_PROPOSE_HELP = `Usage: takode board propose <quest-id> [--title <title>] --summary <text> (--phases <ids> | --journey-file <path|->) [--preset <id>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--full|--verbose] [--json]

Create and render a proposed pre-dispatch Journey row. The mandatory --summary is the approval packet that used to be sent as separate leader chat text: include the goal/acceptance context, key tradeoff, dependencies, and scheduling/approval question that the user needs, but do not restate the Journey because the proposal UI already renders it. Existing proposed Journey changes should use takode board revise. Use --journey-file for batch phase and note setup; omit standard-phase notes unless unusual phase-specific handling is needed. Optional User Checkpoints require a user-checkpoint phase note with a concrete skip condition; skipping one later requires recording why the condition is satisfied.
`;

export const BOARD_PRESENT_HELP = `takode board present was removed. Use takode board propose <quest-id> --summary <text> ... so the proposal preview renders directly from the propose result.

`;

export const BOARD_PROMOTE_HELP = `Usage: takode board promote <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--full|--verbose] [--json]

Promote an existing proposed Journey into active execution without redefining its phases. By default this clears any proposal hold linked through --wait-for-input.
`;

export const BOARD_NOTE_HELP = `Usage: takode board note <quest-id> <phase-position> [--text <text> | --clear] [--full|--verbose] [--json]

Add or clear a lightweight per-phase Journey note. Phase positions are 1-based in CLI usage.
`;

export const BOARD_ADVANCE_HELP = `Usage: takode board advance <quest-id> [--skip-optional-checkpoint <reason>] [--full|--verbose] [--json]

Advance a quest through non-Work Quest Journey boundaries. Advancing from the final planned phase removes the row, even when that Journey never included \`port\`. This command does not perform Work -> Memory; use \`takode board work-to-memory\` with structured commit or zero-code evidence.

Use --skip-optional-checkpoint only when the next phase is a User Checkpoint with an approved optional phase note, the concrete skip condition has been satisfied, and the resulting transition is not Work -> Memory. The reason is recorded on the board row.
`;

export const BOARD_WORK_TO_MEMORY_HELP = `Usage: takode board work-to-memory <quest-id> [--work-note <feedback-index>] (--commit <sha> | --commits <sha1,sha2> | --no-code) [--preparation <id> | --delivery-target <approval-id>] [--skip-optional-checkpoint <reason>] [--full|--verbose] [--json]

Independent publication: the assigned leader first uses approve-delivery-target;
the worker supplies --delivery-target with its exact approved commits. This is
read-only publication verification, not a push retry or session-target mutation.

Authenticated worker-owned transition from Work to Memory. The caller must be the assigned worker, must have claimed the quest, must have a current Work phase note, and the board row must have no unresolved User Checkpoint. Provide synchronized target-repository code SHAs with --commit/--commits, or use --no-code only when this Work occurrence made no tracked project changes. When one planned optional User Checkpoint sits directly between the current Work occurrence and Memory, use --skip-optional-checkpoint only after its approved optional condition is satisfied. Required or taken checkpoints must continue into a later Work occurrence before the guarded transition.
`;

export const BOARD_REPLACE_WORK_EVIDENCE_HELP = `Usage: takode board replace-work-evidence <quest-id> --expected-commits <sha1,sha2> --commits <sha1,sha2> --reason <text> [--json]

Authenticated worker-owned correction for invalid structured Work code commit evidence. The expected list must exactly match the currently stored ordered list, the replacement cannot contain fewer commits, and each list is limited to ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS} unique commits. Replacement commits are resolved to full SHAs and must be reachable from the configured selected-target checkout. This command does not advance the Journey; refresh the current Work note and use the ordinary guarded Work -> Memory transition afterward.
`;

export const BOARD_RM_HELP = `Usage: takode board rm <quest-id> [<quest-id> ...] [--full|--verbose] [--json]

Remove one or more quests from the active board.
`;

interface BoardRow {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  journey?: QuestJourneyPlanState;
  status?: string;
  waitFor?: string[];
  waitForInput?: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface BoardParticipantStatus {
  sessionId: string;
  sessionNum?: number | null;
  name?: string;
  status: "running" | "idle" | "disconnected" | "archived";
}

interface BoardRowSessionStatus {
  worker?: BoardParticipantStatus;
  reviewer?: BoardParticipantStatus | null;
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

interface BoardJourneySpecPhase {
  id: string;
  note?: string;
}

interface BoardJourneySpec {
  title?: string;
  presetId?: string;
  phases: BoardJourneySpecPhase[];
  revisionReason?: string;
  presentation?: {
    summary?: string;
    scheduling?: Record<string, unknown>;
  };
}

function normalizeBoardWaitForInputNotificationId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numericId = Number.parseInt(trimmed, 10);
    return numericId > 0 ? `n-${numericId}` : null;
  }
  const match = /^n-(\d+)$/i.exec(trimmed);
  if (!match) return null;
  const numericId = Number.parseInt(match[1], 10);
  return numericId > 0 ? `n-${numericId}` : null;
}

function formatBoardWaitForInputNotificationLabel(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId.trim());
  return match ? match[1] : notificationId;
}

function formatBoardWaitForInputNotificationList(notificationIds: string[]): string {
  return notificationIds.map((notificationId) => formatBoardWaitForInputNotificationLabel(notificationId)).join(", ");
}

function normalizeBoardJourneySpec(raw: unknown): BoardJourneySpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    err("Journey file must be a JSON object.");
  }
  const spec = raw as Record<string, unknown>;
  const rawPhases = spec.phases ?? spec.phaseIds;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    err("Journey file requires a non-empty phases array.");
  }

  const phases = rawPhases.map((entry, index): BoardJourneySpecPhase => {
    if (typeof entry === "string") return { id: entry };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      err(`Journey file phase ${index + 1} must be a string phase id or an object with id/note.`);
    }
    const phase = entry as Record<string, unknown>;
    if (typeof phase.id !== "string" || !phase.id.trim()) {
      err(`Journey file phase ${index + 1} requires a non-empty id.`);
    }
    if (phase.note !== undefined && typeof phase.note !== "string") {
      err(`Journey file phase ${index + 1} note must be a string when provided.`);
    }
    return {
      id: phase.id.trim(),
      ...(typeof phase.note === "string" && phase.note.trim() ? { note: phase.note.trim() } : {}),
    };
  });

  const invalid = getInvalidQuestJourneyPhaseIds(phases.map((phase) => phase.id));
  if (invalid.length > 0) {
    err(`Invalid Quest Journey phase(s) in journey file: ${invalid.join(", ")}`);
  }
  const normalizedPhaseIds = normalizeQuestJourneyPhaseIds(phases.map((phase) => phase.id));
  const sequenceError = validateQuestJourneyPhaseSequence(normalizedPhaseIds);
  if (sequenceError) err(sequenceError);
  const phaseNotes = Object.fromEntries(
    phases.flatMap((phase, index) => (phase.note ? [[String(index), phase.note]] : [])),
  );
  const checkpointNoteError = validateQuestJourneyUserCheckpointNotes(
    normalizedPhaseIds,
    Object.keys(phaseNotes).length > 0 ? phaseNotes : undefined,
  );
  if (checkpointNoteError) err(checkpointNoteError);

  const presentation =
    spec.presentation && typeof spec.presentation === "object" && !Array.isArray(spec.presentation)
      ? (spec.presentation as Record<string, unknown>)
      : undefined;
  const scheduling =
    presentation?.scheduling && typeof presentation.scheduling === "object" && !Array.isArray(presentation.scheduling)
      ? { ...(presentation.scheduling as Record<string, unknown>) }
      : undefined;

  return {
    phases,
    ...(typeof spec.title === "string" && spec.title.trim() ? { title: spec.title.trim() } : {}),
    ...(typeof spec.presetId === "string" && spec.presetId.trim() ? { presetId: spec.presetId.trim() } : {}),
    ...(typeof spec.revisionReason === "string" && spec.revisionReason.trim()
      ? { revisionReason: spec.revisionReason.trim() }
      : {}),
    ...(presentation
      ? {
          presentation: {
            ...(typeof presentation.summary === "string" && presentation.summary.trim()
              ? { summary: presentation.summary.trim() }
              : {}),
            ...(scheduling ? { scheduling } : {}),
          },
        }
      : {}),
  };
}

async function readBoardJourneySpec(pathOrDash: string, flagName = "--journey-file"): Promise<BoardJourneySpec> {
  const raw = await readOptionTextFile(pathOrDash, flagName);
  try {
    return normalizeBoardJourneySpec(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      err(`Cannot parse ${flagName} JSON: ${error.message}`);
    }
    throw error;
  }
}

function formatBoardParticipantStatus(
  participant: BoardParticipantStatus | undefined,
  fallbackNum?: number,
  opts?: { empty?: string },
): string {
  if (participant) return `#${participant.sessionNum ?? fallbackNum ?? "?"} ${participant.status}`;
  if (fallbackNum !== undefined) return `#${fallbackNum} unknown`;
  return opts?.empty ?? "--";
}

function formatBoardWorkerReviewerSummary(row: BoardRow, rowStatus: BoardRowSessionStatus | undefined): string {
  if (!row.worker && row.workerNum === undefined) return "--";
  const worker = formatBoardParticipantStatus(rowStatus?.worker, row.workerNum);
  const reviewer = rowStatus?.reviewer
    ? formatBoardParticipantStatus(rowStatus.reviewer, rowStatus.reviewer.sessionNum ?? undefined)
    : "no reviewer";
  return `${worker} / ${reviewer}`;
}

function formatBoardQueueWarnings(queueWarnings: BoardQueueWarning[] | undefined): string[] {
  if (!queueWarnings || queueWarnings.length === 0) return [];
  return queueWarnings.map((warning) =>
    warning.action ? `- ${warning.summary} Next: ${warning.action}` : `- ${warning.summary}`,
  );
}

function formatBoardPhaseNoteRebaseWarnings(warnings: QuestJourneyPhaseNoteRebaseWarning[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings.map((warning) => {
    const phaseLabel = getQuestJourneyPhase(warning.previousPhaseId)?.label ?? warning.previousPhaseId;
    return `- note[${warning.previousIndex + 1}] ${phaseLabel} occurrence ${warning.previousOccurrence} was dropped during revision: ${warning.note}`;
  });
}

function formatBoardPhaseNoteLines(row: BoardRow): string[] {
  const entries = Object.entries(row.journey?.phaseNotes ?? {})
    .map(([rawIndex, note]) => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0) return null;
      const phaseId = row.journey?.phaseIds?.[index];
      const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId ?? "Unknown";
      return `note[${index + 1}] ${phaseLabel}: ${note}`;
    })
    .filter((line): line is string => line !== null);
  return entries;
}

function formatBoardPhaseSkipReasonLines(row: BoardRow): string[] {
  const entries = Object.entries(row.journey?.phaseSkipReasons ?? {})
    .map(([rawIndex, reason]) => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0) return null;
      const phaseId = row.journey?.phaseIds?.[index];
      const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId ?? "Unknown";
      return `skip[${index + 1}] ${phaseLabel}: ${reason}`;
    })
    .filter((line): line is string => line !== null);
  return entries;
}

function formatBoardJourneyPathLine(row: BoardRow): string | null {
  const phaseIds = row.journey?.phaseIds ?? [];
  if (phaseIds.length === 0) return null;
  const currentIndex = getQuestJourneyCurrentPhaseIndex(row.journey, row.status);
  const segments = phaseIds.map((phaseId, index) => {
    const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId;
    const segment = `${index + 1}. ${phaseLabel}`;
    return currentIndex === index ? `[${segment}]` : segment;
  });
  return `journey: ${segments.join(" -> ")}`;
}

interface BoardRowDecisionContext {
  blockingQuestIds: Set<string>;
  dispatchableQuestIds: Set<string>;
  resolvedSessionDeps?: Set<string>;
  workerSlotUsage?: { used: number; limit: number };
}

function wantsFullBoardOutput(flags: Record<string, string | boolean>): boolean {
  return flags.full === true || flags.verbose === true;
}

function buildBoardRowDecisionContext(
  board: BoardRow[],
  opts?: {
    allBoardRows?: BoardRow[];
    resolvedSessionDeps?: Set<string>;
    queueWarnings?: BoardQueueWarning[];
    workerSlotUsage?: { used: number; limit: number };
  },
): BoardRowDecisionContext {
  return {
    blockingQuestIds: new Set(
      (opts?.allBoardRows || board).filter((row) => isQuestWaitForBlockingState(row.status)).map((row) => row.questId),
    ),
    dispatchableQuestIds: new Set(
      (opts?.queueWarnings ?? [])
        .filter((warning) => warning.kind === "dispatchable")
        .map((warning) => warning.questId),
    ),
    resolvedSessionDeps: opts?.resolvedSessionDeps,
    workerSlotUsage: opts?.workerSlotUsage,
  };
}

function getBoardRowBlockedDeps(row: BoardRow, context: BoardRowDecisionContext): string[] {
  return (row.waitFor || []).filter((waitForRef) => {
    const kind = getWaitForRefKind(waitForRef);
    if (kind === "session") return !context.resolvedSessionDeps?.has(waitForRef);
    if (kind === "quest") return context.blockingQuestIds.has(waitForRef);
    if (kind === "free-worker") {
      const usage = context.workerSlotUsage;
      return usage ? usage.used >= usage.limit : true;
    }
    return true;
  });
}

function formatBoardRowWaitForState(row: BoardRow, context: BoardRowDecisionContext): string {
  const isQueuedRow = (row.status || "").trim().toUpperCase() === "QUEUED";
  const linkedInputWaits = row.waitForInput || [];
  const blockedDeps = getBoardRowBlockedDeps(row, context);
  if (!isQueuedRow && linkedInputWaits.length > 0) {
    return `input ${formatBoardWaitForInputNotificationList(linkedInputWaits)}`;
  }
  if (isQueuedRow && context.dispatchableQuestIds.has(row.questId)) return "ready";
  if (isQueuedRow && blockedDeps.length > 0) {
    return `wait ${blockedDeps.map((dep) => formatWaitForRefLabel(dep)).join(", ")}`;
  }
  return "--";
}

function formatBoardRowNextAction(row: BoardRow, context: BoardRowDecisionContext): string {
  const isQueuedRow = (row.status || "").trim().toUpperCase() === "QUEUED";
  const linkedInputWaits = row.waitForInput || [];
  const blockedDeps = getBoardRowBlockedDeps(row, context);
  if (!isQueuedRow && linkedInputWaits.length > 0) {
    return `wait for user input (${formatBoardWaitForInputNotificationList(linkedInputWaits)})`;
  }
  if (isQueuedRow && context.dispatchableQuestIds.has(row.questId)) return "dispatch now";
  if (isQueuedRow && blockedDeps.length > 0) {
    return `wait for ${blockedDeps.map((dep) => formatWaitForRefLabel(dep)).join(", ")}`;
  }
  return row.journey?.nextLeaderAction ?? (QUEST_JOURNEY_HINTS[row.status || ""] || "--");
}

function formatBoardPhaseTimingLines(row: BoardRow): string[] {
  const phaseTimings = row.journey?.phaseTimings ?? {};
  return Object.entries(phaseTimings)
    .map(([rawIndex, timing]) => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0) return null;
      const phaseId = row.journey?.phaseIds?.[index];
      const phaseLabel = getQuestJourneyPhase(phaseId)?.label ?? phaseId ?? "Unknown";
      const started = timing.startedAt ? formatTimestampCompact(timing.startedAt) : "not started";
      const ended = timing.endedAt ? formatTimestampCompact(timing.endedAt) : "open";
      return `phase[${index + 1}] ${phaseLabel}: ${started} -> ${ended}`;
    })
    .filter((line): line is string => line !== null);
}

function printBoardDetailText(
  row: BoardRow,
  opts?: {
    allBoardRows?: BoardRow[];
    resolvedSessionDeps?: Set<string>;
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    workerSlotUsage?: { used: number; limit: number };
  },
): void {
  const context = buildBoardRowDecisionContext([row], {
    allBoardRows: opts?.allBoardRows,
    resolvedSessionDeps: opts?.resolvedSessionDeps,
    queueWarnings: opts?.queueWarnings,
    workerSlotUsage: opts?.workerSlotUsage,
  });
  const journeyPathLine = formatBoardJourneyPathLine(row);
  const noteLines = formatBoardPhaseNoteLines(row);
  const skipLines = formatBoardPhaseSkipReasonLines(row);
  const timingLines = formatBoardPhaseTimingLines(row);
  const rowStatus = opts?.rowSessionStatuses?.[row.questId];

  console.log(`${row.questId} -- ${row.title || "(untitled)"}`);
  console.log(`status: ${row.status || "--"}`);
  console.log(`worker/reviewer: ${formatBoardWorkerReviewerSummary(row, rowStatus)}`);
  console.log(`wait-for: ${formatBoardRowWaitForState(row, context)}`);
  console.log(`action: ${formatBoardRowNextAction(row, context)}`);
  if (journeyPathLine) console.log(journeyPathLine);
  if (noteLines.length > 0) {
    console.log("notes:");
    for (const line of noteLines) console.log(`  ${line}`);
  }
  if (skipLines.length > 0) {
    console.log("skips:");
    for (const line of skipLines) console.log(`  ${line}`);
  }
  if (timingLines.length > 0) {
    console.log("history:");
    for (const line of timingLines) console.log(`  ${line}`);
  }
  if (row.journey?.revisionCount || row.journey?.revisionReason || row.journey?.revisedAt) {
    console.log("revision:");
    if (row.journey.revisionCount) console.log(`  count: ${row.journey.revisionCount}`);
    if (row.journey.revisedAt) console.log(`  last revised: ${formatTimestampCompact(row.journey.revisedAt)}`);
    if (row.journey.revisionReason) console.log(`  reason: ${row.journey.revisionReason}`);
  }
  console.log(`created: ${formatTimestampCompact(row.createdAt)}`);
  console.log(`updated: ${formatTimestampCompact(row.updatedAt)}`);
  if (row.completedAt) console.log(`completed: ${formatTimestampCompact(row.completedAt)}`);
}

/** Format board output as JSON with a marker for frontend detection. */
function formatBoardOutput(
  board: BoardRow[],
  opts?: {
    operation?: string;
    completedCount?: number;
    completedBoard?: BoardRow[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
    proposalReview?: BoardProposalReviewPayload;
    delivery?: { id: string; commitShas: string[] };
    workerSlotUsage?: { used: number; limit: number };
  },
): string {
  const {
    operation,
    completedCount,
    completedBoard,
    rowSessionStatuses,
    queueWarnings,
    phaseNoteRebaseWarnings,
    proposalReview,
    delivery,
    workerSlotUsage,
  } = opts ?? {};
  return JSON.stringify(
    {
      __takode_board__: true,
      board,
      ...(rowSessionStatuses ? { rowSessionStatuses } : {}),
      ...(queueWarnings ? { queueWarnings } : {}),
      ...(phaseNoteRebaseWarnings ? { phaseNoteRebaseWarnings } : {}),
      ...(proposalReview ? { proposalReview } : {}),
      ...(delivery ? { delivery } : {}),
      ...(workerSlotUsage ? { workerSlotUsage } : {}),
      ...(operation ? { operation } : {}),
      ...(completedCount != null ? { completedCount } : {}),
      ...(completedBoard ? { completedBoard } : {}),
    },
    null,
    2,
  );
}

/** Print board in a human-readable table with Quest Journey state and next-action hints. */
function printBoardText(
  board: BoardRow[],
  opts?: {
    allBoardRows?: BoardRow[];
    resolvedSessionDeps?: Set<string>;
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    workerSlotUsage?: { used: number; limit: number };
    includeDetails?: boolean;
  },
): void {
  if (board.length === 0) {
    console.log("Board is empty.");
    return;
  }

  const { allBoardRows, resolvedSessionDeps, rowSessionStatuses, queueWarnings, workerSlotUsage, includeDetails } =
    opts ?? {};
  const decisionContext = buildBoardRowDecisionContext(board, {
    allBoardRows,
    resolvedSessionDeps,
    queueWarnings,
    workerSlotUsage,
  });

  console.log("");
  const qCol = 8;
  const tCol = 20;
  const ownerCol = 30;
  const sCol = 18;
  const waitCol = 16;
  console.log(
    `${"QUEST".padEnd(qCol)} ${"TITLE".padEnd(tCol)} ${"WORKER / REVIEWER".padEnd(ownerCol)} ${"STATE".padEnd(sCol)} ${"WAIT-FOR".padEnd(waitCol)} ACTION`,
  );
  console.log("-".repeat(qCol + tCol + ownerCol + sCol + waitCol + 22));

  for (const row of board) {
    const quest = row.questId.padEnd(qCol);
    // Truncate to (tCol - 3) to leave room for the "…" character and column padding
    const titleStr = row.title ? (row.title.length > tCol - 2 ? row.title.slice(0, tCol - 3) + "…" : row.title) : "--";
    const title = titleStr.padEnd(tCol);
    const rowStatus = rowSessionStatuses?.[row.questId];
    const ownerStr = formatBoardWorkerReviewerSummary(row, rowStatus);
    const owner = ownerStr.slice(0, ownerCol - 1).padEnd(ownerCol);
    const state = (row.status || "--").padEnd(sCol);
    const waitForStr = formatBoardRowWaitForState(row, decisionContext);
    const waitForDisplay = waitForStr.slice(0, waitCol - 1).padEnd(waitCol);
    const nextAction = formatBoardRowNextAction(row, decisionContext);

    console.log(`${quest} ${title} ${owner} ${state} ${waitForDisplay} ${nextAction}`);
    if (!includeDetails) continue;
    const journeyPathLine = formatBoardJourneyPathLine(row);
    if (journeyPathLine) {
      console.log(
        `${"".padEnd(qCol)} ${"".padEnd(tCol)} ${"".padEnd(ownerCol)} ${"".padEnd(sCol)} ${"".padEnd(waitCol)} ${journeyPathLine}`,
      );
    }
    for (const noteLine of formatBoardPhaseNoteLines(row)) {
      console.log(
        `${"".padEnd(qCol)} ${"".padEnd(tCol)} ${"".padEnd(ownerCol)} ${"".padEnd(sCol)} ${"".padEnd(waitCol)} ${noteLine}`,
      );
    }
  }
  console.log("");
}

/** Output board as JSON in `--json` mode, otherwise as human-readable text. */
function outputBoard(
  board: BoardRow[],
  jsonMode: boolean,
  opts?: {
    operation?: string;
    resolvedSessionDeps?: Set<string>;
    completedCount?: number;
    completedBoard?: BoardRow[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
    proposalReview?: BoardProposalReviewPayload;
    delivery?: { id: string; commitShas: string[] };
    workerSlotUsage?: { used: number; limit: number };
    includeDetails?: boolean;
    includeCompletedSummary?: boolean;
  },
): void {
  const {
    operation,
    resolvedSessionDeps,
    completedCount,
    completedBoard,
    rowSessionStatuses,
    queueWarnings,
    phaseNoteRebaseWarnings,
    proposalReview,
    delivery,
    workerSlotUsage,
    includeDetails,
    includeCompletedSummary,
  } = opts ?? {};
  if (jsonMode) {
    console.log(
      formatBoardOutput(board, {
        operation,
        completedCount,
        completedBoard,
        rowSessionStatuses,
        queueWarnings,
        phaseNoteRebaseWarnings,
        proposalReview,
        delivery,
        workerSlotUsage,
      }),
    );
    return;
  }

  printBoardText(board, {
    allBoardRows: board,
    resolvedSessionDeps,
    rowSessionStatuses,
    queueWarnings,
    workerSlotUsage,
    includeDetails,
  });
  // Print completed items table when --all flag includes them
  if (completedBoard && completedBoard.length > 0) {
    console.log("── Completed ──────────────────────────────────────────");
    printBoardText(completedBoard, { rowSessionStatuses, queueWarnings, workerSlotUsage, includeDetails });
  }
  if (includeCompletedSummary !== false && completedCount && completedCount > 0 && !completedBoard) {
    console.log(`${completedCount} quest${completedCount === 1 ? "" : "s"} completed`);
  }
  for (const line of formatBoardPhaseNoteRebaseWarnings(phaseNoteRebaseWarnings)) {
    console.log(line);
  }
  for (const line of formatBoardQueueWarnings(queueWarnings)) {
    console.log(line);
  }
}

function outputBoardMutation(
  board: BoardRow[],
  jsonMode: boolean,
  opts: {
    affectedQuestIds: string[];
    operation: string;
    fullOutput?: boolean;
    includeMissingAffectedSummary?: boolean;
    resolvedSessionDeps?: Set<string>;
    completedCount?: number;
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
    queueWarnings?: BoardQueueWarning[];
    phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
    proposalReview?: BoardProposalReviewPayload;
    delivery?: { id: string; commitShas: string[] };
    workerSlotUsage?: { used: number; limit: number };
  },
): void {
  if (jsonMode || opts.fullOutput) {
    outputBoard(board, jsonMode, {
      operation: opts.operation,
      resolvedSessionDeps: opts.resolvedSessionDeps,
      completedCount: opts.completedCount,
      rowSessionStatuses: opts.rowSessionStatuses,
      queueWarnings: opts.queueWarnings,
      phaseNoteRebaseWarnings: opts.phaseNoteRebaseWarnings,
      proposalReview: opts.proposalReview,
      delivery: opts.delivery,
      workerSlotUsage: opts.workerSlotUsage,
      includeDetails: true,
    });
    return;
  }

  console.log(opts.operation);
  const affected = new Set(opts.affectedQuestIds.map((questId) => questId.toLowerCase()));
  const affectedRows = board.filter((row) => affected.has(row.questId.toLowerCase()));
  if (affectedRows.length > 0) {
    printBoardText(affectedRows, {
      allBoardRows: board,
      resolvedSessionDeps: opts.resolvedSessionDeps,
      rowSessionStatuses: opts.rowSessionStatuses,
      queueWarnings: opts.queueWarnings,
      workerSlotUsage: opts.workerSlotUsage,
      includeDetails: false,
    });
  } else if (opts.includeMissingAffectedSummary !== false && opts.affectedQuestIds.length > 0) {
    console.log(`changed: ${opts.affectedQuestIds.join(", ")} (not on active board)`);
  }
  for (const line of formatBoardPhaseNoteRebaseWarnings(opts.phaseNoteRebaseWarnings)) {
    console.log(line);
  }
  for (const line of formatBoardQueueWarnings(opts.queueWarnings)) {
    console.log(line);
  }
}

export async function handleBoard(base: string, args: string[]): Promise<void> {
  const selfId = getCallerSessionId();
  const sub = args[0];

  // No subcommand or "show": display board
  if (!sub || sub === "show" || sub.startsWith("--")) {
    const flags = parseFlags(sub === "show" ? args.slice(1) : args);
    const includeCompleted = flags.all === true;
    const fullOutput = wantsFullBoardOutput(flags);
    const queryParams = `resolve=true${includeCompleted ? "&include_completed=true" : ""}`;
    const result = (await apiGet(base, `/sessions/${encodeURIComponent(selfId)}/board?${queryParams}`)) as {
      board: BoardRow[];
      completedCount?: number;
      completedBoard?: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolvedSessionDeps = new Set(result.resolvedSessionDeps ?? []);
    outputBoard(result.board, flags.json === true, {
      resolvedSessionDeps,
      completedCount: result.completedCount,
      completedBoard: includeCompleted ? result.completedBoard : undefined,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
      includeDetails: fullOutput,
      includeCompletedSummary: fullOutput || includeCompleted,
    });
    return;
  }

  if (sub === "detail") {
    const questId = args[1];
    const usage = "Usage: takode board detail <quest-id> [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    const result = (await apiGet(
      base,
      `/sessions/${encodeURIComponent(selfId)}/board?resolve=true&include_completed=true`,
    )) as {
      board: BoardRow[];
      completedBoard?: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const allRows = [...result.board, ...(result.completedBoard ?? [])];
    const row = allRows.find((candidate) => candidate.questId.toLowerCase() === questId.toLowerCase());
    if (!row) err(`No active or completed board row found for ${questId}.`);
    if (flags.json === true) {
      console.log(
        JSON.stringify(
          {
            __takode_board_detail__: true,
            row,
            rowSessionStatus: result.rowSessionStatuses?.[row.questId],
            queueWarnings: result.queueWarnings?.filter((warning) => warning.questId === row.questId),
          },
          null,
          2,
        ),
      );
      return;
    }
    printBoardDetailText(row, {
      allBoardRows: allRows,
      resolvedSessionDeps: new Set(result.resolvedSessionDeps ?? []),
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings?.filter((warning) => warning.questId === row.questId),
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "revise") {
    const questId = args[1];
    const usage =
      "Usage: takode board revise <quest-id> --from-position <n> --expect-phase <id> (--phases <ids> | --journey-file <path|->) [--preset <id>] [--full|--verbose] [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    if (flags["dry-run"] !== undefined) err("--dry-run is not supported for board revise.");
    if (flags.reason !== undefined || flags["revise-reason"] !== undefined) {
      err("Journey revision reasons are no longer required; omit --reason and --revise-reason.");
    }
    if (flags["spec-file"] !== undefined) err("Use --journey-file with takode board revise.");
    const fromPosition = parseIntegerFlag(flags, "from-position", "from position");
    if (fromPosition === undefined) err("--from-position is required.");
    if (fromPosition <= 0) err("--from-position must be a positive integer.");
    const expectedPhaseId =
      typeof flags["expect-phase"] === "string" ? canonicalizeQuestJourneyPhaseId(flags["expect-phase"]) : null;
    if (!expectedPhaseId) err("--expect-phase must name a valid Journey phase.");
    if (typeof flags.phases === "string" && typeof flags["journey-file"] === "string") {
      err("Use either --phases or --journey-file, not both.");
    }
    if (flags["journey-file"] === true) err("--journey-file requires a path or '-' for stdin.");

    const body: Record<string, unknown> = {
      fromIndex: fromPosition - 1,
      expectedPhaseId,
    };
    if (typeof flags["journey-file"] === "string") {
      const spec = await readBoardJourneySpec(flags["journey-file"], "--journey-file");
      body.phases = normalizeQuestJourneyPhaseIds(spec.phases.map((phase) => phase.id));
      body.phaseNoteEdits = spec.phases.map((phase, index) => ({ index, note: phase.note ?? null }));
      if (typeof flags.preset === "string" && flags.preset.trim()) body.presetId = flags.preset.trim();
      else if (spec.presetId) body.presetId = spec.presetId;
    } else if (typeof flags.phases === "string") {
      const phases = flags.phases
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (phases.length === 0) err("Invalid replacement Journey phases: provide at least one phase ID.");
      const invalid = getInvalidQuestJourneyPhaseIds(phases);
      if (invalid.length > 0) {
        err(
          `Invalid Quest Journey phase(s): ${invalid.join(", ")} -- active v2 phases are alignment, work, user-checkpoint, and memory`,
        );
      }
      body.phases = normalizeQuestJourneyPhaseIds(phases);
      if (typeof flags.preset === "string" && flags.preset.trim()) body.presetId = flags.preset.trim();
    } else {
      err("Use --phases or --journey-file with takode board revise.");
    }

    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/board/${encodeURIComponent(questId)}/revise`,
      body,
    )) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: [questId],
      operation: `revise ${questId}: updated`,
      fullOutput: wantsFullBoardOutput(flags),
      resolvedSessionDeps: new Set(result.resolvedSessionDeps ?? []),
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "add" || sub === "set" || sub === "propose" || sub === "promote") {
    const questId = args[1];
    const usageBySub =
      sub === "propose"
        ? `Usage: takode board propose <quest-id> [--title "..."] --summary <text> [--phases <ids> | --journey-file <path|->] [--preset <id>] [--wait-for-input <id,id...> | --clear-wait-for-input] [--full|--verbose] [--json]`
        : sub === "promote"
          ? `Usage: takode board promote <quest-id> [--worker <session>] [--status <state>] [--active-phase-position <n>] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--full|--verbose] [--json]`
          : `Usage: takode board ${sub} <quest-id> [--worker <session>] [--status "..."] [--active-phase-position <n>] [--title "..."] [--wait-for q-X,#Y,${FREE_WORKER_WAIT_FOR_TOKEN}] [--wait-for-input <id,id...> | --clear-wait-for-input] [--phases <ids> | --journey-file <path|->] [--preset <id>] [--full|--verbose] [--json]`;
    if (!questId) err(usageBySub);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    const isProposalCommand = sub === "propose";
    const isPromoteCommand = sub === "promote";
    const activePhasePosition = parseIntegerFlag(flags, "active-phase-position", "active phase position");
    if (flags["no-code"] === true || flags["code-change"] === true) {
      err("Board no-code flags were removed. Use the active v2 Alignment -> Work -> Memory flow.");
    }

    const body: Record<string, unknown> = { questId };
    if (isProposalCommand) body.journeyMode = "proposed";
    if (isPromoteCommand) body.journeyMode = "active";
    if (isPromoteCommand && flags["force-promote-unpresented"] === true) {
      body.forcePromoteUnpresented = true;
    }
    if (activePhasePosition !== undefined) {
      if (activePhasePosition <= 0) err("--active-phase-position must be a positive integer.");
      if (isProposalCommand) {
        err("Proposed Journey rows cannot set an active phase position. Promote the row first.");
      }
      body.activePhaseIndex = activePhasePosition - 1;
    }
    if (typeof flags.status === "string") body.status = flags.status;
    if (typeof flags.title === "string") body.title = flags.title;
    if (isProposalCommand) {
      if (flags.summary === true || typeof flags.summary !== "string" || !flags.summary.trim()) {
        err("takode board propose requires --summary with the full approval context.");
      }
      body.presentation = { summary: flags.summary.trim() };
    } else if (flags.summary !== undefined) {
      err("Use --summary only with takode board propose.");
    }
    const journeyFileFlag =
      typeof flags["journey-file"] === "string"
        ? "journey-file"
        : typeof flags["spec-file"] === "string"
          ? "spec-file"
          : undefined;
    if (flags["journey-file"] === true) err("--journey-file requires a path or '-' for stdin.");
    if (flags["spec-file"] === true) err("--spec-file requires a path or '-' for stdin.");
    if (journeyFileFlag) {
      if (isPromoteCommand) err("takode board promote reuses the existing Journey. Use takode board revise first.");
      if (journeyFileFlag === "spec-file" && !isProposalCommand) err("Use --journey-file with takode board set.");
      if (typeof flags.phases === "string") err("Use either --journey-file or --phases, not both.");
      const spec = await readBoardJourneySpec(flags[journeyFileFlag] as string, `--${journeyFileFlag}`);
      body.phases = normalizeQuestJourneyPhaseIds(spec.phases.map((phase) => phase.id));
      body.phaseNoteEdits = spec.phases.map((phase, index) => ({ index, note: phase.note ?? null }));
      if (spec.title && !("title" in body)) body.title = spec.title;
      if (typeof flags.preset === "string" && flags.preset.trim()) body.presetId = flags.preset.trim();
      else if (spec.presetId) body.presetId = spec.presetId;
      else body.presetId = "custom";
      if (spec.presentation) {
        body.presentation = {
          ...(body.presentation && typeof body.presentation === "object" ? body.presentation : {}),
          ...spec.presentation,
          ...(isProposalCommand ? { summary: (body.presentation as { summary: string }).summary } : {}),
        };
      }
    } else if (typeof flags.phases === "string") {
      if (isPromoteCommand) {
        err("takode board promote reuses the existing Journey. Revise it first with takode board revise.");
      }
      const phases = flags.phases
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (phases.length === 0) {
        err("Invalid Quest Journey phases: provide at least one phase ID.");
      }
      const invalid = getInvalidQuestJourneyPhaseIds(phases);
      if (invalid.length > 0) {
        err(
          `Invalid Quest Journey phase(s): ${invalid.join(", ")} -- active v2 phases are alignment, work, user-checkpoint, and memory`,
        );
      }
      body.phases = normalizeQuestJourneyPhaseIds(phases);
      const sequenceError = validateQuestJourneyPhaseSequence(body.phases as QuestJourneyPhaseId[]);
      if (sequenceError) err(sequenceError);
      if (typeof flags.preset === "string" && flags.preset.trim()) {
        body.presetId = flags.preset.trim();
      }
    } else if (typeof flags.preset === "string") {
      err("Use --preset only with --phases or --journey-file so the planned Quest Journey is explicit.");
    } else if (isProposalCommand) {
      err("Use --phases or --journey-file with takode board propose so the proposed Journey is explicit.");
    }
    if (flags["revise-reason"] !== undefined || flags.reason !== undefined) {
      err("Journey revision reasons are no longer required; use takode board revise for existing Journey changes.");
    }
    if (typeof flags["wait-for"] === "string") {
      if (isProposalCommand) {
        err(
          "Proposed Journey rows do not use --wait-for. Use --wait-for-input when the proposal is waiting on approval.",
        );
      }
      const waitFor = flags["wait-for"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const invalid = waitFor.filter((ref) => !isValidWaitForRef(ref));
      if (invalid.length > 0)
        err(
          `Invalid wait-for value(s): ${invalid.join(", ")} -- use q-N for quests, #N for sessions, or ${FREE_WORKER_WAIT_FOR_TOKEN}`,
        );
      body.waitFor = waitFor;
    }
    if (flags["clear-wait-for-input"] === true && typeof flags["wait-for-input"] === "string") {
      err("Use either --wait-for-input or --clear-wait-for-input, not both.");
    }
    if (typeof flags["wait-for"] === "string" && typeof flags["wait-for-input"] === "string") {
      err("Invalid board update: --wait-for and --wait-for-input cannot be combined on the same row.");
    }
    let explicitStatus = typeof flags.status === "string" ? flags.status.trim().toUpperCase() : null;
    if (isProposalCommand) {
      body.status = "PROPOSED";
      explicitStatus = "PROPOSED";
    } else if (isPromoteCommand && typeof flags["wait-for"] === "string" && !explicitStatus) {
      body.status = "QUEUED";
      explicitStatus = "QUEUED";
    }
    if (typeof flags["wait-for"] === "string" && explicitStatus && explicitStatus !== "QUEUED") {
      err("Invalid board update: --wait-for is only valid on QUEUED rows.");
    }
    if (typeof flags["wait-for-input"] === "string" && explicitStatus === "QUEUED") {
      err("Invalid board update: --wait-for-input is only valid on active rows.");
    }
    if (typeof flags["wait-for-input"] === "string") {
      const rawIds = flags["wait-for-input"]
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (rawIds.length === 0) {
        err("Invalid wait-for-input value: provide one or more notification IDs like 3 or n-3.");
      }
      const normalizedIds = rawIds.map((notificationId) => ({
        notificationId,
        normalized: normalizeBoardWaitForInputNotificationId(notificationId),
      }));
      const invalid = normalizedIds.filter((entry) => entry.normalized === null).map((entry) => entry.notificationId);
      if (invalid.length > 0) {
        err(`Invalid wait-for-input value(s): ${invalid.join(", ")} -- use needs-input notification IDs like 3 or n-3`);
      }
      body.waitForInput = [...new Set(normalizedIds.map((entry) => entry.normalized!))];
    }
    if (flags["clear-wait-for-input"] === true) {
      body.clearWaitForInput = true;
    } else if (isPromoteCommand && typeof flags["wait-for-input"] !== "string") {
      body.clearWaitForInput = true;
    }
    if (typeof flags.worker === "string") {
      if (isProposalCommand) {
        err("Proposed Journey rows cannot be assigned to a worker yet. Promote the row first.");
      }
      const workerRef = flags.worker;
      if (!workerRef) {
        // Empty string means "clear worker assignment"
        body.worker = "";
        body.workerNum = null;
      } else {
        // Resolve worker ref -- use the info endpoint to get session ID and num
        try {
          const info = (await apiGet(base, `/sessions/${encodeURIComponent(workerRef)}/info`)) as {
            sessionId: string;
            sessionNum: number;
          };
          body.worker = info.sessionId;
          body.workerNum = info.sessionNum;
        } catch {
          // Fallback: store the ref as-is
          body.worker = workerRef;
        }
      }
      // When changing the worker (reassigning or clearing), clear stale waitFor
      // dependencies unless the user explicitly provided --wait-for in the same command
      if (!("waitFor" in body)) {
        body.waitFor = [];
      }
    }

    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
      proposalReview?: BoardProposalReviewPayload;
      delivery?: { id: string; commitShas: string[] };
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    if (isProposalCommand && result.proposalReview && flags.json !== true && !wantsFullBoardOutput(flags)) {
      outputBoard(result.board, true, {
        operation: `${sub} ${questId}: updated`,
        resolvedSessionDeps: resolved,
        rowSessionStatuses: result.rowSessionStatuses,
        queueWarnings: result.queueWarnings,
        phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
        proposalReview: result.proposalReview,
        workerSlotUsage: result.workerSlotUsage,
      });
      return;
    }
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: [questId],
      operation: `${sub} ${questId}: updated`,
      fullOutput: wantsFullBoardOutput(flags),
      resolvedSessionDeps: resolved,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
      proposalReview: result.proposalReview,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "present") {
    err("takode board present was removed. Use takode board propose <quest-id> --summary <text> ...");
  }

  if (sub === "note") {
    const questId = args[1];
    const usage =
      "Usage: takode board note <quest-id> <phase-position> [--text <text> | --clear] [--full|--verbose] [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const phasePositionRaw = args[2];
    if (!phasePositionRaw) err(usage);
    const phasePosition = Number.parseInt(phasePositionRaw, 10);
    if (!Number.isInteger(phasePosition) || phasePosition <= 0) {
      err("Phase position must be a positive integer.");
    }
    const flags = parseFlags(args.slice(3));
    const hasText = typeof flags.text === "string";
    const wantsClear = flags.clear === true;
    if (hasText === wantsClear) {
      err("Use exactly one of --text or --clear.");
    }
    const body: Record<string, unknown> = {
      questId,
      phaseNoteEdits: [
        {
          index: phasePosition - 1,
          note: hasText ? flags.text : null,
        },
      ],
    };
    const result = (await apiPost(base, `/sessions/${encodeURIComponent(selfId)}/board`, body)) as {
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      phaseNoteRebaseWarnings?: QuestJourneyPhaseNoteRebaseWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: [questId],
      operation: `note ${questId}: updated`,
      fullOutput: wantsFullBoardOutput(flags),
      resolvedSessionDeps: resolved,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      phaseNoteRebaseWarnings: result.phaseNoteRebaseWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "advance-no-groom") {
    err("`takode board advance-no-groom` was removed. Use the active v2 Alignment -> Work -> Memory flow.");
  }

  if (sub === "replace-work-evidence") {
    const questId = args[1];
    const usage = BOARD_REPLACE_WORK_EVIDENCE_HELP.trim();
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    assertKnownFlags(flags, new Set(["expected-commits", "commits", "reason", "json"]), usage);
    if (flags["expected-commits"] === true) err("--expected-commits requires a comma-separated commit SHA list.");
    if (flags.commits === true) err("--commits requires a comma-separated commit SHA list.");
    if (flags.reason === true) err("--reason requires a non-empty explanation.");

    let expectedCommitShas: string[];
    let replacementCommitShas: string[];
    try {
      expectedCommitShas = parseCommitShas(
        typeof flags["expected-commits"] === "string"
          ? flags["expected-commits"].split(",").map((value) => value.trim())
          : [],
      );
      replacementCommitShas = parseCommitShas(
        typeof flags.commits === "string" ? flags.commits.split(",").map((value) => value.trim()) : [],
      );
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
    }
    if (expectedCommitShas.length === 0) err("--expected-commits must contain at least one commit SHA.");
    if (replacementCommitShas.length === 0) err("--commits must contain at least one replacement commit SHA.");
    if (
      expectedCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS ||
      replacementCommitShas.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS
    ) {
      err(
        `Expected and replacement lists support at most ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_COMMITS} commits each.`,
      );
    }
    if (replacementCommitShas.length < expectedCommitShas.length) {
      err("Replacement commit evidence cannot contain fewer commits than the expected list.");
    }
    const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
    if (!reason) err("--reason requires a non-empty explanation.");
    if (reason.length > MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH) {
      err(`--reason must be at most ${MAX_QUEST_CODE_COMMIT_EVIDENCE_REPLACEMENT_REASON_LENGTH} characters.`);
    }
    if (
      expectedCommitShas.length === replacementCommitShas.length &&
      expectedCommitShas.every((sha, index) => sha === replacementCommitShas[index])
    ) {
      err("Replacement commit evidence must differ from the expected stored evidence.");
    }

    const result = (await apiPost(base, "/takode/board/replace-work-evidence", {
      questId,
      expectedCommitShas,
      commitShas: replacementCommitShas,
      reason,
    })) as {
      ok: true;
      questId: string;
      previousCommitShas: string[];
      commitShas: string[];
      target: { mode: string; checkoutPath: string; branch: string; headSha: string };
      correction: { journeyRunId: string; phaseOccurrenceId: string; ts?: number };
    };
    if (flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${result.questId}: replaced Work code evidence (${result.previousCommitShas.length} -> ${result.commitShas.length})`,
    );
    console.log(`previous: ${result.previousCommitShas.join(", ")}`);
    console.log(`replacement: ${result.commitShas.join(", ")}`);
    console.log(
      `target: ${formatInlineText(result.target.checkoutPath)} ${formatInlineText(result.target.branch)} @ ${result.target.headSha.slice(0, 12)}`,
    );
    return;
  }

  if (sub === "approve-delivery-target" || sub === "delivery-targets") {
    if (args.includes("--help")) console.log(DELIVERY_TARGET_HELP);
    else await handleDeliveryTarget(base, sub, args.slice(1));
    return;
  }

  if (sub === "record-work-delivery") {
    await handleRecordDelivery(base, args.slice(1));
    return;
  }

  if (sub === "work-to-memory") {
    const questId = args[1];
    const usage = BOARD_WORK_TO_MEMORY_HELP.trim();
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    const deliveryTargetId = deliveryTargetFlag(flags);
    const workFeedbackIndex = parseIntegerFlag(flags, "work-note", "Work feedback index");
    if (workFeedbackIndex !== undefined && workFeedbackIndex < 0) err("--work-note must be a non-negative integer.");
    if (flags.preparation === true) err("--preparation requires an exact preparation ID.");
    if (flags["no-code"] === true && flags.preparation) err("--preparation requires commit evidence.");
    if (flags.commit === true) err("--commit requires a commit SHA.");
    if (flags.commits === true) err("--commits requires a comma-separated commit SHA list.");
    const noCode = flags["no-code"] === true;
    if (typeof flags["no-code"] === "string") err("--no-code does not take a value.");
    let commitShas: string[];
    try {
      commitShas = parseCommitShas([
        ...(typeof flags.commit === "string" ? [flags.commit] : []),
        ...(typeof flags.commits === "string" ? flags.commits.split(",").map((value) => value.trim()) : []),
      ]);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
    }
    if (noCode === commitShas.length > 0) {
      err(
        "Use exactly one Work evidence mode: --commit/--commits for synchronized target SHAs, or --no-code for genuine zero-tracked-change Work.",
      );
    }
    if (flags["skip-optional-checkpoint"] === true) {
      err("--skip-optional-checkpoint requires a reason explaining why the approved skip condition is satisfied.");
    }
    const skipOptionalUserCheckpointReason =
      typeof flags["skip-optional-checkpoint"] === "string" ? flags["skip-optional-checkpoint"].trim() : undefined;
    const result = (await apiPost(base, "/takode/board/work-to-memory", {
      questId,
      ...(workFeedbackIndex !== undefined ? { workFeedbackIndex } : {}),
      ...(commitShas.length > 0 ? { commitShas } : { noCode: true }),
      ...(skipOptionalUserCheckpointReason ? { skipOptionalUserCheckpointReason } : {}),
      ...(typeof flags.preparation === "string" ? { preparationId: flags.preparation } : {}),
      ...(deliveryTargetId ? { deliveryTargetId } : {}),
    })) as {
      ok: true;
      questId: string;
      previousState?: string;
      newState: string;
      workFeedbackIndex: number;
      delivery?: QuestDeliveryView;
      board: BoardRow[];
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    if (result.delivery && flags.json !== true)
      console.log(
        `Delivery ${result.delivery.id}. Author links: quest commit-links ${questId} --delivery ${result.delivery.id}`,
      );
    const evidence =
      commitShas.length > 0
        ? `${commitShas.length} code commit${commitShas.length === 1 ? "" : "s"}`
        : "no code changes";
    const operation = `${result.questId}: ${result.previousState ?? "WORKING"} -> ${result.newState} (Work note #${result.workFeedbackIndex}, ${evidence})`;
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: [result.questId],
      operation,
      fullOutput: wantsFullBoardOutput(flags),
      resolvedSessionDeps: new Set(result.resolvedSessionDeps ?? []),
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
      delivery: result.delivery
        ? { id: result.delivery.id, commitShas: result.delivery.commits.map((commit) => commit.sha) }
        : undefined,
    });
    return;
  }

  if (sub === "advance") {
    const questId = args[1];
    const usage =
      "Usage: takode board advance <quest-id> [--skip-optional-checkpoint <reason>] [--full|--verbose] [--json]";
    if (!questId) err(usage);
    if (!isValidQuestId(questId)) err(`Invalid quest ID "${questId}": must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(2));
    if (flags["skip-optional-checkpoint"] === true) {
      err("--skip-optional-checkpoint requires a reason explaining why the approved skip condition is satisfied.");
    }
    const advanceBody =
      typeof flags["skip-optional-checkpoint"] === "string" && flags["skip-optional-checkpoint"].trim()
        ? { skipOptionalUserCheckpointReason: flags["skip-optional-checkpoint"].trim() }
        : undefined;

    const result = (await apiPost(
      base,
      `/sessions/${encodeURIComponent(selfId)}/board/${encodeURIComponent(questId)}/${sub}`,
      advanceBody,
    )) as {
      board: BoardRow[];
      removed: boolean;
      previousState?: string;
      newState?: string;
      skippedStates?: string[];
      completedCount?: number;
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };

    let operation: string;
    if (result.removed) {
      operation = `${questId}: completed (moved to history)`;
    } else if (result.previousState && result.newState) {
      operation = `${questId}: ${result.previousState} -> ${result.newState}`;
    } else {
      operation = `advanced ${questId}`;
    }
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: [questId],
      operation,
      fullOutput: wantsFullBoardOutput(flags),
      includeMissingAffectedSummary: !result.removed,
      resolvedSessionDeps: resolved,
      completedCount: result.completedCount,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  if (sub === "rm") {
    const questIds = args.slice(1).filter((a) => !a.startsWith("--"));
    if (questIds.length === 0) err("Usage: takode board rm <quest-id> [<quest-id> ...] [--full|--verbose] [--json]");
    const invalid = questIds.filter((id) => !isValidQuestId(id));
    if (invalid.length > 0)
      err(`Invalid quest ID(s): ${invalid.join(", ")} -- must match q-NNN format (e.g., q-1, q-42)`);
    const flags = parseFlags(args.slice(1));

    const result = (await apiDelete(base, `/sessions/${encodeURIComponent(selfId)}/board/${questIds.join(",")}`)) as {
      board: BoardRow[];
      completedCount?: number;
      resolvedSessionDeps?: string[];
      rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
      queueWarnings?: BoardQueueWarning[];
      workerSlotUsage?: { used: number; limit: number };
    };
    const resolved = new Set(result.resolvedSessionDeps ?? []);
    outputBoardMutation(result.board, flags.json === true, {
      affectedQuestIds: questIds,
      operation: `removed ${questIds.join(", ")}`,
      fullOutput: wantsFullBoardOutput(flags),
      includeMissingAffectedSummary: false,
      resolvedSessionDeps: resolved,
      completedCount: result.completedCount,
      rowSessionStatuses: result.rowSessionStatuses,
      queueWarnings: result.queueWarnings,
      workerSlotUsage: result.workerSlotUsage,
    });
    return;
  }

  err(
    `Unknown board subcommand: ${sub}\nUsage: takode board [show|detail|set|revise|propose|promote|note|advance|rm] ...`,
  );
}
