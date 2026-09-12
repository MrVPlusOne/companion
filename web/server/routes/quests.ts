import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import * as questStore from "../quest-store.js";
import { registerQuestDeliveryRoutes } from "./quest-deliveries.js";
import { readCommitDetails } from "../git-commit-reader.js";
import { recordedCommitStats } from "../../shared/quest-delivery.js";
import type {
  QuestAutocompleteCandidate,
  QuestCreateInput,
  QuestFeedbackEntry,
  QuestPatchInput,
  QuestRecoveryEventDraft,
  QuestTitlePreview,
  QuestTransitionInput,
  QuestmasterTask,
} from "../quest-types.js";
import { hasQuestReviewMetadata } from "../quest-types.js";
import { normalizeCommitShas } from "../quest-store-helpers.js";
import {
  buildQuestListPreview,
  getQuestListPageAsync,
  type QuestListPageOptions,
  type QuestListSortColumn,
} from "../quest-list-filters.js";
import { SERVER_GIT_CMD } from "../constants.js";
import {
  addTaskEntry as addTaskEntryController,
  setSessionClaimedQuest as setSessionClaimedQuestController,
  updateQuestTaskEntries as updateQuestTaskEntriesController,
} from "../bridge/session-registry-controller.js";
import { broadcastQuestUpdate, buildQuestTitlePreview } from "./quest-helpers.js";
import type { OptionalAuthResult, RouteContext } from "./context.js";
import { isSharpUnavailableError, SHARP_UNAVAILABLE_MESSAGE } from "../image-store.js";
import { isLegacyQuestJourneyPhaseId, normalizeKnownQuestJourneyPhaseIds } from "../../shared/quest-journey.js";
import {
  isDeletedQuestFeedbackEntry,
  liveQuestFeedbackEntries,
  tombstoneQuestFeedbackEntry,
} from "../../shared/quest-feedback.js";
import type { BoardRow, QuestLifecycleEventSnapshot, SessionState } from "../session-types.js";
import type { SdkSessionInfo } from "../session-info.js";
import { normalizeTldr, QUEST_TLDR_WARNING_HEADER, tldrWarningForContent } from "../quest-tldr.js";
import {
  QUEST_PHASE_DOCUMENTATION_WARNING_HEADER,
  resolveQuestFeedbackDocumentation,
  sameQuestFeedbackDocumentationScope,
  type QuestBoardRowCandidate,
} from "../quest-phase-docs.js";
import { evaluateQuestStatusMutationGuard, getQuestStatusOwnerSessionIds } from "../quest-status-guard.js";
import { formatLeaderRecoveryWarning, QUEST_LEADER_RECOVERY_WARNING_HEADER } from "../quest-recovery.js";
import { getQuestSessionSpaceCandidates } from "../quest-session-space.js";
import type { MemoryRepoOptions } from "../workstream-memory-types.js";
import { refreshGitInfoPublic as refreshGitInfoPublicController } from "../bridge/session-git-state.js";
import {
  getPreviousQuestOwners,
  getQuestDisplayOwner,
  getTakodeQuestOwnerSessionId,
} from "../../shared/quest-owner.js";

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_QUEST_TITLE_IDS = 100;
const SUMMARY_FEEDBACK_PREFIXES = ["summary:", "refreshed summary:"];
const FINAL_MEMORY_STATEMENT_RE = /^memory (updated|update deferred|update not needed):\s*\S.*$/gim;

type ClaimedQuestProjection = Omit<QuestLifecycleEventSnapshot, "questId" | "status"> & {
  id: string;
  status?: string;
  verificationInboxUnread?: boolean;
};

function normalizeRequestedCommitSha(value: string): string | null {
  const sha = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

function shouldIncludeCommitDiff(c: Context): boolean {
  return c.req.query("includeDiff") !== "false";
}

function memoryDiffSourceFiles(
  sourceFiles: import("../workstream-memory-types.js").MemoryCommitSourceFile[] | undefined,
) {
  return (sourceFiles ?? []).map((sourceFile) => ({
    status: sourceFile.status,
    path: sourceFile.path,
    ...(sourceFile.previousPath ? { previousPath: sourceFile.previousPath } : {}),
    oldText: sourceFile.oldText,
    newText: sourceFile.newText,
  }));
}

function isAgentSummaryFeedback(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return SUMMARY_FEEDBACK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function findLatestAgentSummaryFeedbackIndex(entries: QuestFeedbackEntry[], target?: QuestFeedbackEntry): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.author !== "agent") continue;
    if (target && !sameQuestFeedbackDocumentationScope(entry, target)) continue;
    if (isAgentSummaryFeedback(entry.text)) return index;
  }
  return -1;
}

function setTldrWarningHeader(c: { header: (name: string, value: string) => void }, warning: string | null): void {
  if (warning) c.header(QUEST_TLDR_WARNING_HEADER, warning);
}

function questJsonEtag(value: unknown): string {
  return `"quest-${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}"`;
}

function requestHasMatchingEtag(c: Context, etag: string): boolean {
  const header = c.req.header("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === etag || part === "*");
}

function cacheValidatedJson(c: Context, value: unknown) {
  const etag = questJsonEtag(value);
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (requestHasMatchingEtag(c, etag)) return c.body(null, 304);
  return c.json(value);
}

function questListPageOptions(c: Context): QuestListPageOptions {
  return {
    status: c.req.query("status"),
    tags: c.req.query("tags"),
    tag: c.req.query("tag"),
    excludeTags: c.req.query("excludeTags"),
    session: c.req.query("session") ?? c.req.query("sessionId"),
    text: c.req.query("text"),
    verification: c.req.query("verification"),
    offset: parseIntegerQuery(c.req.query("offset")),
    limit: parseIntegerQuery(c.req.query("limit")),
    sortColumn: normalizeQuestListSortColumn(c.req.query("sortColumn")),
    sortDirection: normalizeQuestListSortDirection(c.req.query("sortDirection")),
  };
}

function isAuthenticatedCompanionCaller(
  auth: OptionalAuthResult,
): auth is Exclude<OptionalAuthResult, null | { response: Response }> {
  return auth !== null && !("response" in auth);
}

function setDescriptionTldrWarningHeaderForAgentWrite(
  c: { header: (name: string, value: string) => void },
  auth: OptionalAuthResult,
  description: unknown,
  tldr: unknown,
): void {
  if (!isAuthenticatedCompanionCaller(auth)) return;
  setTldrWarningHeader(c, tldrWarningForContent("description", description, tldr));
}

function setDebriefTldrWarningHeaderForAgentWrite(
  c: { header: (name: string, value: string) => void },
  auth: OptionalAuthResult,
  debrief: unknown,
  debriefTldr: unknown,
): void {
  if (!isAuthenticatedCompanionCaller(auth)) return;
  setTldrWarningHeader(c, tldrWarningForContent("debrief", debrief, debriefTldr));
}

function parseIntegerQuery(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeRequestedQuestTitleIds(values: string[] | undefined): { ids: string[]; exceededLimit: boolean } {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of values ?? []) {
    for (const token of value.split(",")) {
      const questId = token.trim().toLowerCase();
      if (!/^q-\d+$/.test(questId) || seen.has(questId)) continue;
      seen.add(questId);
      if (ids.length >= MAX_QUEST_TITLE_IDS) return { ids, exceededLimit: true };
      ids.push(questId);
    }
  }

  return { ids, exceededLimit: false };
}

function withoutSidecarQuestFields<T extends { createdBy?: unknown; lastModifiedBy?: unknown; ownerKind?: unknown }>(
  input: T,
): Omit<T, "createdBy" | "lastModifiedBy" | "ownerKind"> {
  const { createdBy: _createdBy, lastModifiedBy: _lastModifiedBy, ownerKind: _ownerKind, ...safeInput } = input;
  return safeInput;
}

function withoutInternalQuestPatchFields(
  input: QuestPatchInput & { createdBy?: unknown; ownerKind?: unknown },
): QuestPatchInput {
  const {
    createdBy: _createdBy,
    feedback: _feedback,
    journeyRuns: _journeyRuns,
    lastModifiedBy: _lastModifiedBy,
    ownerKind: _ownerKind,
    quizItems: _quizItems,
    ...contentPatch
  } = input;
  return contentPatch;
}

function getTakodeDisplayOwnerSessionId(quest: QuestmasterTask): string | undefined {
  const owner = getQuestDisplayOwner(quest);
  return owner?.kind === "takode" ? owner.sessionId : undefined;
}

function isDirectCodexOwnedQuest(quest: QuestmasterTask): boolean {
  if (quest.status !== "in_progress" && quest.status !== "done") return false;
  return getQuestDisplayOwner(quest)?.kind === "codex";
}

function normalizeQuestListSortColumn(value: string | undefined): QuestListSortColumn | undefined {
  switch (value) {
    case "cards":
    case "quest":
    case "title":
    case "owner":
    case "leader":
    case "status":
    case "verify":
    case "feedback":
    case "updated":
      return value;
    default:
      return undefined;
  }
}

function normalizeQuestListSortDirection(value: string | undefined): "asc" | "desc" | undefined {
  if (value === "asc" || value === "desc") return value;
  return undefined;
}

function feedbackEntryWithoutTldr(entry: QuestFeedbackEntry): QuestFeedbackEntry {
  const { tldr: _tldr, ...rest } = entry;
  return rest;
}

function questRepoCandidates(quest: QuestmasterTask, launcher: RouteContext["launcher"], sha: string): string[] {
  // Recorded delivery provenance remains authoritative after session cleanup or a target change.
  // Missing retained objects must not silently redirect the viewer to today's session checkout.
  const delivery = quest.codeDeliveries?.find((item) => item.commits.some((commit) => commit.sha === sha));
  if (delivery) {
    const path = delivery.target.repoRoot;
    return typeof path === "string" && isAbsolute(path) ? [path] : [];
  }
  const activeTakodeOwner = getTakodeQuestOwnerSessionId(quest);
  const sessionIds = [
    ...(activeTakodeOwner ? [activeTakodeOwner] : []),
    ...getPreviousQuestOwners(quest)
      .filter((owner) => owner.kind === "takode")
      .map((owner) => owner.sessionId),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const sessionId of sessionIds) {
    const session = launcher.getSession(sessionId);
    if (!session) continue;
    for (const path of [session.repoRoot, session.cwd]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }

  return paths;
}

function memoryRepoCandidates(quest: QuestmasterTask, launcher: RouteContext["launcher"]): MemoryRepoOptions[] {
  return getQuestSessionSpaceCandidates(quest, {
    resolveSessionSpaceSlug: (sessionId) => launcher.getSession(sessionId)?.memorySessionSpaceSlug,
    defaultSessionSpaceSlug: launcher.getMemorySessionSpaceSlug(),
  }).map((sessionSpaceSlug) => ({ sessionSpaceSlug, readOnly: true }));
}

function resolveClaimLeaderSessionId(
  launcher: RouteContext["launcher"],
  workerSession: { herdedBy?: string } | null | undefined,
): string | undefined {
  const leaderSessionId = typeof workerSession?.herdedBy === "string" ? workerSession.herdedBy.trim() : "";
  if (!leaderSessionId) return undefined;
  const leaderSession = launcher.getSession(leaderSessionId);
  return leaderSession?.isOrchestrator === true ? leaderSessionId : undefined;
}

function resolveSubmittedSessionId(
  rawSessionId: unknown,
  resolveId: RouteContext["resolveId"],
): { raw: string; sessionId: string } {
  const raw = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
  if (!raw) return { raw: "", sessionId: "" };
  return { raw, sessionId: resolveId(raw) ?? "" };
}

function isActiveV2JourneyRow(row: BoardRow): boolean {
  const status = (row.status ?? "").trim().toUpperCase();
  if (status === "PROPOSED" || status === "QUEUED") return false;
  const phaseIds = normalizeKnownQuestJourneyPhaseIds(row.journey?.phaseIds);
  return phaseIds.length > 0 && phaseIds.every((phaseId) => !isLegacyQuestJourneyPhaseId(phaseId));
}

function findActiveV2BoardRowsForQuest(
  questId: string,
  launcher: RouteContext["launcher"],
  wsBridge: RouteContext["wsBridge"],
): Array<{ leaderSessionId: string; row: BoardRow }> {
  const normalizedQuestId = questId.toLowerCase();
  const rows: Array<{ leaderSessionId: string; row: BoardRow }> = [];
  const visited = new Set<string>();
  const candidateSessionIds = [
    ...launcher.listSessions().map((session) => session.sessionId),
    ...Object.keys((wsBridge as { _sessions?: Record<string, unknown> })._sessions ?? {}),
  ];
  for (const sessionId of candidateSessionIds) {
    if (!sessionId || visited.has(sessionId)) continue;
    visited.add(sessionId);
    const bridgeSession = wsBridge.getSession(sessionId);
    if (!bridgeSession?.board) continue;
    const row = [...bridgeSession.board.values()].find(
      (candidate: BoardRow) => candidate.questId.toLowerCase() === normalizedQuestId && isActiveV2JourneyRow(candidate),
    );
    if (row) rows.push({ leaderSessionId: bridgeSession.id, row });
  }
  return rows;
}

function countFinalMemoryStatements(quest: QuestmasterTask, workerSessionId: string): number {
  return liveQuestFeedbackEntries(quest.feedback)
    .filter(
      (entry) => entry.author === "agent" && entry.authorSessionId === workerSessionId && entry.phaseId === "memory",
    )
    .reduce((count, entry) => count + [...entry.text.matchAll(FINAL_MEMORY_STATEMENT_RE)].length, 0);
}

function hasCurrentWorkEvidence(quest: QuestmasterTask, workerSessionId: string): boolean {
  return liveQuestFeedbackEntries(quest.feedback).some(
    (entry) =>
      entry.author === "agent" &&
      entry.authorSessionId === workerSessionId &&
      entry.phaseId === "work" &&
      (entry.kind === "phase_summary" || entry.kind === undefined) &&
      entry.text.trim().length >= 80,
  );
}

function hasUnaddressedHumanFeedback(quest: QuestmasterTask): boolean {
  return liveQuestFeedbackEntries(quest.feedback).some((entry) => entry.author === "human" && entry.addressed !== true);
}

function hasServerAuthorizedLocalCompletionTarget(
  state: Partial<SessionState> | undefined,
  launcherSession: Pick<SdkSessionInfo, "isWorktree" | "worktreePortTarget"> | undefined,
): boolean {
  const target = launcherSession?.worktreePortTarget;
  return (
    state?.is_worktree === true &&
    launcherSession?.isWorktree === true &&
    typeof target?.repoRoot === "string" &&
    target.repoRoot.trim().length > 0 &&
    typeof target.branch === "string" &&
    target.branch.trim().length > 0 &&
    typeof target.worktreePath === "string" &&
    target.worktreePath.trim().length > 0
  );
}

export function validateV2CompletionGitState(
  state: Partial<SessionState> | undefined,
  storedCodeCommitShas: string[] | undefined,
  options: { localOnly?: boolean } = {},
): string | undefined {
  if (!state) return "Cannot verify worker git state for v2 Memory completion.";
  if (!options.localOnly) {
    const comparisonTarget = (state.diff_base_branch || state.git_default_branch || "").trim();
    if (!comparisonTarget) {
      return "Worker git comparison target is uncertain; refresh or sync before completion.";
    }
    if (!Number.isFinite(state.git_ahead) || !Number.isFinite(state.git_behind)) {
      return "Worker git sync state is uncertain; refresh before completion.";
    }
    if (state.git_ahead !== 0) {
      return "Worker checkout is ahead of its comparison target; sync/Port before completion.";
    }
    if (state.git_behind !== 0) {
      return "Worker checkout is behind its comparison target; refresh or sync before completion.";
    }
  }
  if (state.git_status_refresh_error) return `Worker git state is uncertain: ${state.git_status_refresh_error}`;
  if (state.diff_stats_skipped_reason)
    return `Worker tracked-change state is uncertain: ${state.diff_stats_skipped_reason}`;
  const changedLines = (state.total_lines_added ?? 0) + (state.total_lines_removed ?? 0);
  if (changedLines > 0 && (storedCodeCommitShas?.length ?? 0) === 0) {
    return "Worker has tracked project changes but Work -> Memory did not record code commit metadata.";
  }
  return undefined;
}

function validateV2CompletionCodeCommitSubmission(
  currentQuest: QuestmasterTask,
  submittedCommitShas: unknown,
): { error: string; status: 400 | 409 } | undefined {
  if (submittedCommitShas === undefined) return undefined;
  if (!Array.isArray(submittedCommitShas)) {
    return { error: "commitShas must be an array when provided.", status: 400 };
  }

  let normalizedSubmitted: string[];
  try {
    normalizedSubmitted = normalizeCommitShas(submittedCommitShas);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid commitShas.", status: 400 };
  }
  const stored = new Set((currentQuest.commitShas ?? []).map((sha) => sha.toLowerCase()));
  const newlyIntroduced = normalizedSubmitted.filter((sha) => !stored.has(sha));
  if (newlyIntroduced.length > 0) {
    return {
      error:
        "v2 final Memory cannot attach new code commit SHAs; record synchronized target commits during Work -> Memory.",
      status: 409,
    };
  }
  return undefined;
}

export function createQuestRoutes(ctx: RouteContext) {
  const api = new Hono();
  registerQuestDeliveryRoutes(api);
  const { launcher, wsBridge, imageStore, authenticateCompanionCallerOptional, execCaptureStdoutAsync, resolveId } =
    ctx;
  const bridgeAny = wsBridge as any;

  const setClaimedQuest = (
    sessionId: string,
    quest: ClaimedQuestProjection | null,
    lifecycleEvent?: { id: string; kind: "claimed" | "submitted"; timestamp?: number },
  ) => {
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    setSessionClaimedQuestController(
      session,
      quest,
      {
        broadcastToBrowsers: (_session, msg) => wsBridge.broadcastToSession(sessionId, msg as any),
        persistSession: () => wsBridge.persistSessionById(sessionId),
        getLauncherSessionInfo: (targetSessionId) => launcher.getSession(targetSessionId),
        onSessionNamedByQuest: (targetSessionId, title) =>
          (wsBridge as any).onSessionNamedByQuest?.(targetSessionId, title),
        invalidateLeaderThreadTabsForQuestIds: wsBridge.invalidateLeaderThreadTabsForQuestIds?.bind(wsBridge),
      },
      lifecycleEvent,
    );
  };

  type V2CompletionBody = {
    commitShas?: unknown;
    memoryCommitShas?: unknown;
    debrief?: unknown;
    debriefTldr?: unknown;
    sessionId?: unknown;
    v2CompletionSync?: unknown;
  };

  const guardV2MemoryCompletion = async (
    questId: string,
    currentQuest: QuestmasterTask,
    auth: OptionalAuthResult,
    body: V2CompletionBody,
    targetSessionId: string,
  ): Promise<Response | null> => {
    if (isDirectCodexOwnedQuest(currentQuest)) return null;
    const activeV2Rows = findActiveV2BoardRowsForQuest(questId, launcher, wsBridge);
    if (activeV2Rows.length === 0) return null;
    if (!auth)
      return new Response(JSON.stringify({ error: "Authenticated v2 Memory completion is required." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    if ("response" in auth) return auth.response;
    if (activeV2Rows.length > 1) {
      return new Response(
        JSON.stringify({ error: "Multiple active v2 board rows exist for this quest; reconcile the board first." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const [{ leaderSessionId, row }] = activeV2Rows;
    const workerSessionId = row.worker;
    const currentOwnerSessionId = getTakodeQuestOwnerSessionId(currentQuest) ?? "";
    if (!workerSessionId || currentOwnerSessionId !== workerSessionId) {
      return new Response(
        JSON.stringify({ error: "v2 Memory completion requires the exact assigned and claimed worker." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (auth.caller.reviewerOf !== undefined) {
      return new Response(JSON.stringify({ error: "Reviewer sessions cannot complete v2 Memory quests." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    const callerIsAssignedWorker = auth.callerId === workerSessionId;
    const callerIsOwningLeader = auth.caller.isOrchestrator === true && auth.callerId === leaderSessionId;
    if (!callerIsAssignedWorker && !callerIsOwningLeader) {
      return new Response(
        JSON.stringify({ error: "Only the assigned worker or owning leader may complete v2 Memory." }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    if (targetSessionId && targetSessionId !== workerSessionId) {
      return new Response(JSON.stringify({ error: "v2 Memory completion sessionId must match the assigned worker." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if ((row.status ?? "").trim().toUpperCase() !== "MEMORY") {
      return new Response(
        JSON.stringify({
          error: `v2 Memory completion requires board state MEMORY; current state is ${row.status ?? "unknown"}.`,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if ((row.waitForInput ?? []).length > 0) {
      return new Response(
        JSON.stringify({ error: "Cannot complete v2 Memory while a User Checkpoint is unresolved." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (hasUnaddressedHumanFeedback(currentQuest)) {
      return new Response(
        JSON.stringify({ error: "Cannot complete v2 Memory while human feedback remains unaddressed." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (typeof body.debrief !== "string" || !body.debrief.trim()) {
      return new Response(JSON.stringify({ error: "Final debrief is required for v2 Memory completion." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!normalizeTldr(body.debriefTldr)) {
      return new Response(JSON.stringify({ error: "Final debrief TLDR is required for v2 Memory completion." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const memoryStatementCount = countFinalMemoryStatements(currentQuest, workerSessionId);
    if (memoryStatementCount !== 1) {
      return new Response(
        JSON.stringify({
          error: `v2 Memory completion requires exactly one final memory statement; found ${memoryStatementCount}.`,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    if (!hasCurrentWorkEvidence(currentQuest, workerSessionId)) {
      return new Response(
        JSON.stringify({ error: "v2 Memory completion requires accepted Work evidence from the assigned worker." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const codeCommitSubmissionError = validateV2CompletionCodeCommitSubmission(currentQuest, body.commitShas);
    if (codeCommitSubmissionError) {
      return new Response(JSON.stringify({ error: codeCommitSubmissionError.error }), {
        status: codeCommitSubmissionError.status,
        headers: { "content-type": "application/json" },
      });
    }

    const refreshGit = async (sessionId: string): Promise<boolean> => {
      const session = wsBridge.getSession(sessionId);
      const deps = bridgeAny.getSessionGitStateDeps?.();
      if (session && deps) {
        try {
          await refreshGitInfoPublicController(session as any, deps, {
            broadcastUpdate: true,
            notifyPoller: true,
            force: true,
          });
          return true;
        } catch {
          return false;
        }
      }
      return (
        (await bridgeAny.refreshGitInfoPublic?.(sessionId, {
          broadcastUpdate: true,
          notifyPoller: true,
          force: true,
        })) ?? false
      );
    };
    if (!(await refreshGit(workerSessionId))) {
      return new Response(JSON.stringify({ error: "Cannot refresh worker git state for v2 Memory completion." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    const workerBridgeSession = wsBridge.getSession(workerSessionId);
    const workerState = workerBridgeSession?.state;
    if (!workerState?.cwd) {
      return new Response(JSON.stringify({ error: "Cannot verify worker git state for v2 Memory completion." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    const trackedStatus = (
      await execCaptureStdoutAsync(`${SERVER_GIT_CMD} status --porcelain --untracked-files=no`, workerState.cwd)
    ).trim();
    if (trackedStatus) {
      return new Response(
        JSON.stringify({ error: "Worker has uncommitted tracked changes; clean or sync them before completion." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const localOnly =
      body.v2CompletionSync === "local-clean" &&
      hasServerAuthorizedLocalCompletionTarget(workerState, launcher.getSession(workerSessionId));
    const gitStateError = validateV2CompletionGitState(workerState, currentQuest.commitShas, { localOnly });
    if (gitStateError) {
      return new Response(JSON.stringify({ error: gitStateError }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    return null;
  };
  const claimedQuestEvent = (quest: QuestmasterTask) => ({
    id: quest.questId,
    title: quest.title,
    status: quest.status,
    ...(quest.description !== undefined ? { description: quest.description } : {}),
    ...(quest.tldr !== undefined ? { tldr: quest.tldr } : {}),
    ...(quest.tags !== undefined ? { tags: quest.tags } : {}),
    ...(quest.images !== undefined ? { images: quest.images } : {}),
    ...("verificationItems" in quest ? { verificationItems: quest.verificationItems } : {}),
    ...(hasQuestReviewMetadata(quest) ? { verificationInboxUnread: quest.verificationInboxUnread } : {}),
    ...(quest.leaderSessionId ? { leaderSessionId: quest.leaderSessionId } : {}),
  });
  const lifecycleEvent = (kind: "claimed" | "submitted", quest: QuestmasterTask, sessionId: string) => {
    const occurredAt =
      kind === "claimed"
        ? "claimedAt" in quest
          ? quest.claimedAt
          : undefined
        : "completedAt" in quest
          ? quest.completedAt
          : undefined;
    const revision = occurredAt ?? quest.statusChangedAt ?? quest.updatedAt ?? quest.version ?? quest.createdAt;
    return {
      id: `quest_${kind}-${quest.questId}-${sessionId}-${revision}`,
      kind,
      ...(typeof occurredAt === "number" ? { timestamp: occurredAt } : {}),
    };
  };
  const isClaimEdge = (current: QuestmasterTask | null, next: QuestmasterTask, sessionId: string): boolean =>
    next.status === "in_progress" &&
    getTakodeQuestOwnerSessionId(next) === sessionId &&
    (current?.status !== "in_progress" || getTakodeQuestOwnerSessionId(current) !== sessionId);
  const isSubmissionEdge = (current: QuestmasterTask | null, next: QuestmasterTask): boolean =>
    !hasQuestReviewMetadata(current) && hasQuestReviewMetadata(next);
  const boardRowCandidatesForQuest = (quest: QuestmasterTask): QuestBoardRowCandidate[] => {
    if (isDirectCodexOwnedQuest(quest)) return [];
    const leaderIds = new Set<string>();
    if (quest.leaderSessionId) leaderIds.add(quest.leaderSessionId);
    for (const session of launcher.listSessions()) {
      const sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
      if (sessionId && session.isOrchestrator === true && session.archived !== true) leaderIds.add(sessionId);
    }
    const candidates: QuestBoardRowCandidate[] = [];
    for (const leaderSessionId of leaderIds) {
      const leaderSession = launcher.getSession(leaderSessionId);
      if (leaderSession?.archived === true) continue;
      const row = wsBridge.getSession(leaderSessionId)?.board?.get(quest.questId);
      if (row) candidates.push({ leaderSessionId, row });
    }
    return candidates;
  };

  const boardAssignsQuestToWorker = (quest: QuestmasterTask, workerSessionId: string): boolean =>
    boardRowCandidatesForQuest(quest).some((candidate) => candidate.row.worker === workerSessionId);

  const leaderCanReassignToWorker = (leaderSessionId: string, workerSessionId: string, questId: string): boolean => {
    const worker = launcher.getSession(workerSessionId);
    if (worker?.herdedBy === leaderSessionId) return true;
    const leaderSession = wsBridge.getSession(leaderSessionId);
    return leaderSession?.board?.get(questId)?.worker === workerSessionId;
  };

  const ownershipReason = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

  const buildLeaderCompletionRecoveryEvent = (
    quest: QuestmasterTask,
    auth: OptionalAuthResult,
    body: {
      force?: unknown;
      reason?: unknown;
      debrief?: unknown;
      debriefTldr?: unknown;
      commitShas?: unknown;
      memoryCommitShas?: unknown;
    },
    items: import("../quest-types.js").QuestVerificationItem[],
    activeV2Rows: Array<{ leaderSessionId: string; row: BoardRow }>,
  ): QuestRecoveryEventDraft | Response | null => {
    if (body.force !== true) return null;
    if (isDirectCodexOwnedQuest(quest)) {
      return new Response(
        JSON.stringify({ error: "Takode leader recovery cannot complete a direct Codex-owned quest." }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }
    const reason = ownershipReason(body.reason);
    if (!auth || "response" in auth) {
      return new Response(JSON.stringify({ error: "Leader recovery requires Companion session auth." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    if (!reason) {
      return new Response(JSON.stringify({ error: "Leader recovery requires --reason <text>." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    const owningLeaderIds = new Set<string>(activeV2Rows.map((row) => row.leaderSessionId));
    if (quest.leaderSessionId) owningLeaderIds.add(quest.leaderSessionId);
    if (auth.caller.isOrchestrator !== true || !owningLeaderIds.has(auth.callerId)) {
      return new Response(JSON.stringify({ error: "Leader recovery requires the authenticated owning leader." }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    const previousOwnerSessionId = getTakodeQuestOwnerSessionId(quest) ?? getTakodeDisplayOwnerSessionId(quest) ?? "";
    const workerInfo = previousOwnerSessionId ? launcher.getSession(previousOwnerSessionId) : undefined;
    const workerBridgeSession = previousOwnerSessionId ? wsBridge.getSession(previousOwnerSessionId) : undefined;
    return {
      operation: "leader_complete",
      actorSessionId: auth.callerId,
      reason,
      previousStatus: quest.status,
      ...(previousOwnerSessionId ? { previousOwnerSessionId } : {}),
      ...(quest.leaderSessionId ? { previousLeaderSessionId: quest.leaderSessionId } : {}),
      boardRows: activeV2Rows.map(({ leaderSessionId, row }) => ({
        leaderSessionId,
        ...(row.status ? { status: row.status } : {}),
        ...(row.worker ? { workerSessionId: row.worker } : {}),
        ...(row.journey?.phaseIds?.length ? { phaseIds: row.journey.phaseIds } : {}),
        ...(typeof row.journey?.activePhaseIndex === "number"
          ? { activePhaseIndex: row.journey.activePhaseIndex }
          : {}),
        ...(row.waitForInput?.length ? { waitForInputCount: row.waitForInput.length } : {}),
      })),
      ...(previousOwnerSessionId
        ? {
            workerState: {
              sessionId: previousOwnerSessionId,
              known: !!workerInfo,
              ...(workerInfo?.archived === true ? { archived: true } : {}),
              ...(workerBridgeSession ? { hasBridgeSession: true } : {}),
              ...(workerBridgeSession?.state?.cwd ? { hasCwd: true } : {}),
              ...(workerBridgeSession?.state?.git_status_refreshed_at ? { gitStatusKnown: true } : {}),
            },
          }
        : {}),
      supplied: {
        verificationItemCount: items.length,
        commitShas: Array.isArray(body.commitShas)
          ? body.commitShas.filter((sha): sha is string => typeof sha === "string")
          : [],
        memoryCommitShas: Array.isArray(body.memoryCommitShas)
          ? body.memoryCommitShas.filter((sha): sha is string => typeof sha === "string")
          : [],
        hasDebrief: typeof body.debrief === "string" && body.debrief.trim().length > 0,
        hasDebriefTldr: !!normalizeTldr(body.debriefTldr),
      },
      bypassedChecks: [
        "ordinary worker-owned completion was unavailable by explicit leader recovery",
        ...(activeV2Rows.length > 0
          ? ["v2 Memory completion guard and worker git/worktree checks were bypassed by owning-leader force"]
          : []),
      ],
    };
  };

  const activeOwnerSessionId = (quest: QuestmasterTask | null): string | null =>
    (quest ? getTakodeQuestOwnerSessionId(quest) : undefined) ?? null;

  const callerLeadsQuestOwner = (leaderSessionId: string, quest: QuestmasterTask): boolean => {
    if (!leaderSessionId) return false;
    for (const ownerSessionId of getQuestStatusOwnerSessionIds(quest)) {
      const ownerSession = launcher.getSession(ownerSessionId);
      if (ownerSession?.herdedBy === leaderSessionId) return true;
      if (leaderCanReassignToWorker(leaderSessionId, ownerSessionId, quest.questId)) return true;
    }
    return false;
  };

  const guardStatusMutation = (
    c: Context,
    auth: OptionalAuthResult,
    quest: QuestmasterTask,
    body: { force?: unknown; reason?: unknown; sessionId?: unknown },
  ): Response | null => {
    if (auth && "response" in auth) return auth.response;
    if (body.force === true && !auth) {
      return c.json({ error: "Forced quest status changes require Companion session auth" }, 403);
    }

    const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
    if (bodySession.raw && !bodySession.sessionId) {
      return c.json({ error: `Unknown sessionId: ${bodySession.raw}` }, 400);
    }
    const result = evaluateQuestStatusMutationGuard(quest, {
      callerSessionId: auth?.callerId,
      callerIsLeader: auth?.caller.isOrchestrator === true,
      callerLeadsCurrentOwner: auth ? callerLeadsQuestOwner(auth.callerId, quest) : false,
      force: body.force === true,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      targetSessionId: bodySession.sessionId || undefined,
    });
    return result.ok ? null : c.json({ error: result.message }, 403);
  };

  const persistSessionTaskHistory = (sessionId: string) => {
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    wsBridge.broadcastToSession(sessionId, { type: "session_task_history", tasks: session.taskHistory } as any);
    wsBridge.persistSessionById(sessionId);
  };

  const addQuestTaskEntry = (sessionId: string, quest: QuestmasterTask, triggerMsgId: string) => {
    const trackedSession = wsBridge.getSession(sessionId);
    if (!trackedSession) return;
    addTaskEntryController(
      trackedSession,
      {
        title: quest.title,
        action: "new",
        timestamp: Date.now(),
        triggerMessageId: triggerMsgId,
        source: "quest",
        questId: quest.questId,
      },
      {
        broadcastTaskHistory: () => persistSessionTaskHistory(sessionId),
        persistSession: () => wsBridge.persistSessionById(sessionId),
      },
    );
  };

  // ─── Questmaster (~/.companion/questmaster/) ──────────────────────

  // ─── Quest image upload/serve ────────────────────────────────────
  // Must be registered before parameterized /:questId routes.

  api.post("/quests/_images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      return c.json(image, 201);
    } catch (e: unknown) {
      if (isSharpUnavailableError(e)) {
        return c.json({ error: SHARP_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/quests/_images/:imageId", async (c) => {
    const result = await questStore.readQuestImageFile(c.req.param("imageId"));
    if (!result) return c.json({ error: "Image not found" }, 404);
    return new Response(new Uint8Array(result.data), {
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // Notification endpoint for the quest CLI tool — triggers browser refresh.
  // Must be registered before parameterized /:questId routes.
  api.post("/quests/_notify", (c) => {
    broadcastQuestUpdate(wsBridge);
    return c.json({ ok: true });
  });

  const syncDoneQuestBoardState = (questId: string, quest: QuestmasterTask): void => {
    if (quest.status !== "done" || isDirectCodexOwnedQuest(quest)) return;
    const boardBridge = wsBridge as {
      completeDoneBoardRowsForQuest?: (questId: string) => string[];
      completeQueuedBoardRowsForQuest?: (questId: string) => string[];
    };
    if (boardBridge.completeDoneBoardRowsForQuest) {
      boardBridge.completeDoneBoardRowsForQuest(questId);
      return;
    }
    boardBridge.completeQueuedBoardRowsForQuest?.(questId);
  };

  const transitionQuestAndSync = async (
    questId: string,
    input: import("../quest-types.js").QuestTransitionInput,
    currentOverride?: import("../quest-types.js").QuestmasterTask | null,
  ): Promise<import("../quest-types.js").QuestmasterTask | null> => {
    const current = currentOverride === undefined ? await questStore.getQuest(questId) : currentOverride;
    const currentSessionId = current ? (getTakodeQuestOwnerSessionId(current) ?? null) : null;
    const currentReviewOwnerSessionId =
      current && hasQuestReviewMetadata(current) ? (getTakodeDisplayOwnerSessionId(current) ?? null) : null;
    const quest = await questStore.transitionQuest(questId, input);
    if (!quest) return null;

    const nextSessionId = getTakodeQuestOwnerSessionId(quest) ?? null;
    if (currentSessionId && currentSessionId !== nextSessionId) {
      setClaimedQuest(currentSessionId, null);
    }
    if (currentReviewOwnerSessionId && !hasQuestReviewMetadata(quest)) {
      setClaimedQuest(currentReviewOwnerSessionId, null);
    }
    if (nextSessionId) {
      setClaimedQuest(
        nextSessionId,
        claimedQuestEvent(quest),
        isClaimEdge(current, quest, nextSessionId) ? lifecycleEvent("claimed", quest, nextSessionId) : undefined,
      );
    } else if (hasQuestReviewMetadata(quest)) {
      const reviewOwner = getTakodeDisplayOwnerSessionId(quest);
      if (reviewOwner) {
        setClaimedQuest(
          reviewOwner,
          claimedQuestEvent(quest),
          isSubmissionEdge(current, quest) ? lifecycleEvent("submitted", quest, reviewOwner) : undefined,
        );
      }
    }

    syncDoneQuestBoardState(questId, quest);
    broadcastQuestUpdate(wsBridge, quest);
    return quest;
  };

  api.get("/quests", async (c) => {
    const parentId = c.req.query("parentId");
    const sourceQuests = await questStore.listQuests();
    const scopedQuests = parentId ? sourceQuests.filter((quest) => quest.parentId === parentId) : sourceQuests;
    const page = await getQuestListPageAsync(scopedQuests, {
      ...questListPageOptions(c),
      offset: parseIntegerQuery(c.req.query("offset")) ?? 0,
      limit: parseIntegerQuery(c.req.query("limit")) ?? 50,
    });
    c.header("X-Companion-Deprecated", "GET /api/quests now returns a bounded preview page; use /api/quests/_page");
    return cacheValidatedJson(c, page);
  });

  api.get("/quests/_summary", async (c) => {
    const page = await getQuestListPageAsync(await questStore.listQuests(), {
      limit: 1,
    });
    const counts = page.counts;
    return cacheValidatedJson(c, {
      total: counts.all,
      active: counts.idea + counts.refined + counts.in_progress,
      counts,
    });
  });

  api.get("/quests/_page", async (c) => {
    const page = await getQuestListPageAsync(await questStore.listQuests(), questListPageOptions(c));
    return cacheValidatedJson(c, page);
  });

  api.get("/quests/_autocomplete", async (c) => {
    const candidates: QuestAutocompleteCandidate[] = (await questStore.listQuests()).map((quest) => ({
      questId: quest.questId,
      title: quest.title,
    }));
    return cacheValidatedJson(c, candidates);
  });

  api.get("/quests/_titles", async (c) => {
    const { ids, exceededLimit } = normalizeRequestedQuestTitleIds(c.req.queries("ids"));
    if (exceededLimit) {
      return c.json({ error: `At most ${MAX_QUEST_TITLE_IDS} quest IDs may be requested` }, 400);
    }

    const questsById = new Map(
      (await questStore.listQuests()).map((quest) => [quest.questId.trim().toLowerCase(), quest] as const),
    );
    const quests: QuestTitlePreview[] = [];
    const missingQuestIds: string[] = [];
    for (const questId of ids) {
      const quest = questsById.get(questId);
      if (!quest) {
        missingQuestIds.push(questId);
        continue;
      }
      quests.push(buildQuestTitlePreview(quest));
    }

    return cacheValidatedJson(c, { quests, missingQuestIds });
  });

  api.get("/quests/:questId", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);
    return cacheValidatedJson(c, quest);
  });

  api.get("/quests/:questId/history", async (c) => {
    const history = await questStore.getQuestHistoryView(c.req.param("questId"));
    return c.json(history);
  });

  api.get("/quests/:questId/commits/:sha", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);

    const sha = normalizeRequestedCommitSha(c.req.param("sha"));
    const includeDiff = shouldIncludeCommitDiff(c);
    if (!sha) return c.json({ error: "Invalid commit SHA" }, 400);
    if (!quest.commitShas?.some((storedSha) => storedSha.toLowerCase() === sha)) {
      return c.json({ error: "Commit not attached to this quest" }, 404);
    }

    const repoCandidates = questRepoCandidates(quest, launcher, sha);
    if (repoCandidates.length === 0) {
      return c.json({ sha, available: false, reason: "repo_unavailable" });
    }

    for (const repoRoot of repoCandidates) {
      try {
        const details = await readCommitDetails(repoRoot, sha, includeDiff, MAX_DIFF_BYTES);
        const recorded = quest.codeDeliveries
          ?.flatMap((delivery) => delivery.commits)
          .find((commit) => commit.sha === details.sha);
        return c.json({ ...details, recordedStats: recordedCommitStats(recorded, details), available: true });
      } catch {
        // Try the next known repo candidate for this quest.
      }
    }

    return c.json({ sha, available: false, reason: "commit_not_available" });
  });

  api.get("/quests/:questId/memory-commits/:sha", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);

    const sha = normalizeRequestedCommitSha(c.req.param("sha"));
    if (!sha) return c.json({ error: "Invalid commit SHA" }, 400);
    if (!quest.memoryCommitShas?.some((storedSha) => storedSha.toLowerCase() === sha)) {
      return c.json({ error: "Memory commit not attached to this quest" }, 404);
    }

    const includeDiff = shouldIncludeCommitDiff(c);
    const { workstreamMemoryService } = await import("../workstream-memory-service.js");
    for (const options of memoryRepoCandidates(quest, launcher)) {
      const update = await workstreamMemoryService.commitDiff(options, sha);
      if (!update) continue;

      return c.json({
        sha: update.commit.sha,
        shortSha: update.commit.shortSha,
        message: update.commit.message,
        timestamp: update.commit.timestamp,
        ...(includeDiff
          ? {
              diff: update.diff,
              sourceFiles: memoryDiffSourceFiles(update.sourceFiles),
            }
          : {}),
        available: true,
      });
    }

    return c.json({ sha, available: false, reason: "commit_not_available" });
  });

  api.get("/quests/:questId/version/:versionId", async (c) => {
    const version = await questStore.getQuestVersion(c.req.param("versionId"));
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json(version);
  });

  api.get("/quests/:questId/quiz", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);
    return c.json({ questId: quest.questId, quizItems: quest.quizItems ?? [] });
  });

  api.put("/quests/:questId/quiz", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.patchQuest(c.req.param("questId"), { quizItems: body.quizItems ?? body.items });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as QuestCreateInput & {
      lastModifiedBy?: unknown;
      ownerKind?: unknown;
    };
    try {
      const safeBody = withoutSidecarQuestFields(body);
      const createInput =
        typeof safeBody.sessionSpaceSlug === "string"
          ? safeBody
          : {
              ...safeBody,
              ...(auth?.caller.memorySessionSpaceSlug ? { sessionSpaceSlug: auth.caller.memorySessionSpaceSlug } : {}),
            };
      const quest = await questStore.createQuest(createInput);
      broadcastQuestUpdate(wsBridge);
      setDescriptionTldrWarningHeaderForAgentWrite(c, auth, body.description, body.tldr);
      return c.json(quest, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as QuestPatchInput & {
      createdBy?: unknown;
      debrief?: unknown;
      debriefTldr?: unknown;
      ownerKind?: unknown;
    };
    try {
      const quest = await questStore.patchQuest(c.req.param("questId"), withoutInternalQuestPatchFields(body));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      const ownerSessionId = getTakodeQuestOwnerSessionId(quest);
      if (
        typeof body.title === "string" &&
        quest.status === "in_progress" &&
        ownerSessionId &&
        body.title.trim().length > 0
      ) {
        // Keep quest-owned session names in sync when a claimed quest is retitled.
        // setSessionClaimedQuest publishes detailed claim state and invalidates the canonical navigation row.
        // The name store remains durable through the quest-name callback.
        setClaimedQuest(ownerSessionId, claimedQuestEvent(quest));
        // Update task history entries that reference this quest
        const session = wsBridge.getSession(ownerSessionId);
        if (session) {
          updateQuestTaskEntriesController(session, quest.questId, quest.title, {
            broadcastTaskHistory: () => persistSessionTaskHistory(ownerSessionId),
            persistSession: () => wsBridge.persistSessionById(ownerSessionId),
          });
        }
      }
      broadcastQuestUpdate(wsBridge, quest);
      if (body.description !== undefined || body.tldr !== undefined) {
        const warningTldr =
          body.tldr !== undefined ? body.tldr : body.description !== undefined ? undefined : quest.tldr;
        const warningDescription =
          body.description !== undefined ? body.description : "description" in quest ? quest.description : undefined;
        setDescriptionTldrWarningHeaderForAgentWrite(c, auth, warningDescription, warningTldr);
      }
      if (body.debrief !== undefined || body.debriefTldr !== undefined) {
        const warningDebrief =
          body.debrief !== undefined ? body.debrief : quest.status === "done" ? quest.debrief : undefined;
        const warningDebriefTldr =
          body.debriefTldr !== undefined
            ? body.debriefTldr
            : body.debrief !== undefined
              ? undefined
              : quest.status === "done"
                ? quest.debriefTldr
                : undefined;
        setDebriefTldrWarningHeaderForAgentWrite(c, auth, warningDebrief, warningDebriefTldr);
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/transition", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = (await c.req.json().catch(() => ({}))) as QuestTransitionInput & {
      createdBy?: unknown;
      force?: unknown;
      reason?: unknown;
    };
    try {
      const questId = c.req.param("questId");
      const current = await questStore.getQuest(questId);
      if (!current) return c.json({ error: "Quest not found" }, 404);
      if (body.status === "done") {
        const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
        if (bodySession.raw && !bodySession.sessionId) {
          return c.json({ error: `Unknown sessionId: ${bodySession.raw}` }, 400);
        }
        const v2GuardResponse = await guardV2MemoryCompletion(questId, current, auth, body, bodySession.sessionId);
        if (v2GuardResponse) return v2GuardResponse;
      }
      const guardResponse = guardStatusMutation(c, auth, current, body);
      if (guardResponse) return guardResponse;
      const { force: _force, reason: _reason, ...transitionInput } = withoutSidecarQuestFields(body);
      const quest = await transitionQuestAndSync(questId, transitionInput, current);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (body.description !== undefined || body.tldr !== undefined) {
        const warningTldr =
          body.tldr !== undefined ? body.tldr : body.description !== undefined ? undefined : quest.tldr;
        const warningDescription =
          body.description !== undefined ? body.description : "description" in quest ? quest.description : undefined;
        setDescriptionTldrWarningHeaderForAgentWrite(c, auth, warningDescription, warningTldr);
      }
      if (body.debrief !== undefined || body.debriefTldr !== undefined) {
        const warningDebrief =
          body.debrief !== undefined ? body.debrief : quest.status === "done" ? quest.debrief : undefined;
        const warningDebriefTldr =
          body.debriefTldr !== undefined
            ? body.debriefTldr
            : body.debrief !== undefined
              ? undefined
              : quest.status === "done"
                ? quest.debriefTldr
                : undefined;
        setDebriefTldrWarningHeaderForAgentWrite(c, auth, warningDebrief, warningDebriefTldr);
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/quests/:questId", async (c) => {
    const questId = c.req.param("questId");
    const current = await questStore.getQuest(questId);
    const deleted = await questStore.deleteQuest(questId);
    if (!deleted) return c.json({ error: "Quest not found" }, 404);
    if (!current || !isDirectCodexOwnedQuest(current)) wsBridge.removeBoardRowFromAll(questId);
    broadcastQuestUpdate(wsBridge);
    return c.json({ ok: true });
  });

  api.post("/quests/:questId/claim", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
    const authSessionId = auth ? auth.callerId : "";
    if (bodySession.raw && !bodySession.sessionId) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${bodySession.raw}. ` +
            "Claim a quest from an active Companion session or choose a valid session in Questmaster.",
        },
        400,
      );
    }
    if (authSessionId && bodySession.sessionId && bodySession.sessionId !== authSessionId) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const sessionId = bodySession.sessionId || authSessionId;
    if (!sessionId) {
      return c.json({ error: "sessionId is required (or provide Companion auth headers)" }, 400);
    }
    const knownSession = launcher.getSession(sessionId);
    if (!knownSession) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${sessionId}. ` +
            "Claim a quest from an active Companion session or choose a valid session in Questmaster.",
        },
        400,
      );
    }
    // Hard enforcement: leader/orchestrator sessions cannot claim quests (q-87)
    if (knownSession.isOrchestrator) {
      return c.json({ error: "Leader sessions cannot claim quests. Dispatch to a worker instead." }, 403);
    }
    const leaderSessionId = resolveClaimLeaderSessionId(launcher, knownSession);
    try {
      const questId = c.req.param("questId");
      const force = body.force === true;
      const reason = ownershipReason(body.reason);
      const current = await questStore.getQuest(questId);
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const previousOwnerSessionId = activeOwnerSessionId(current);
      if (force) {
        if (!authSessionId) return c.json({ error: "Force claim requires Companion session auth" }, 403);
        if (!previousOwnerSessionId || previousOwnerSessionId === sessionId) {
          return c.json({ error: "Force claim requires a quest owned by another session" }, 400);
        }
        if (!reason) return c.json({ error: "Force claim reason is required" }, 400);
        const previousOwnerArchived = !!launcher.getSession(previousOwnerSessionId)?.archived;
        if (!previousOwnerArchived && !boardAssignsQuestToWorker(current, sessionId)) {
          return c.json(
            {
              error:
                "Force claim requires the previous owner to be archived or an active board row assigning this quest to this worker",
            },
            403,
          );
        }
      }
      const quest = await questStore.claimQuest(c.req.param("questId"), sessionId, {
        allowArchivedOwnerTakeover: true,
        isSessionArchived: (sid: string) => !!launcher.getSession(sid)?.archived,
        ...(force ? { force: true } : {}),
        ...(leaderSessionId ? { leaderSessionId } : {}),
        ...(force && previousOwnerSessionId
          ? {
              ownershipEvent: {
                operation: "force_claim",
                actorSessionId: authSessionId,
                previousOwnerSessionId,
                newOwnerSessionId: sessionId,
                reason,
                ...(current?.leaderSessionId ? { previousLeaderSessionId: current.leaderSessionId } : {}),
                ...(leaderSessionId ? { newLeaderSessionId: leaderSessionId } : {}),
              },
            }
          : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge, quest);
      if (previousOwnerSessionId && previousOwnerSessionId !== sessionId) {
        setClaimedQuest(previousOwnerSessionId, null);
      }
      // setSessionClaimedQuest publishes detailed claim state and invalidates the canonical navigation row,
      // while the callback cancels in-flight namers and persists the quest-owned name.
      setClaimedQuest(
        sessionId,
        claimedQuestEvent(quest),
        isClaimEdge(current, quest, sessionId) ? lifecycleEvent("claimed", quest, sessionId) : undefined,
      );
      console.log(`[quest-claim] Setting session name for ${sessionId} to "${quest.title}" (quest ${quest.questId})`);
      // Use the last user message as trigger so clicking the quest chip scrolls
      // to the user message that initiated the claim (matches auto-namer behavior).
      const session = wsBridge.getSession(sessionId);
      let triggerMsgId = "quest-" + quest.questId;
      if (session) {
        for (let i = session.messageHistory.length - 1; i >= 0; i--) {
          const m = session.messageHistory[i];
          if (m.type === "user_message" && m.id) {
            triggerMsgId = m.id;
            break;
          }
        }
      }
      addQuestTaskEntry(sessionId, quest, triggerMsgId);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/reassign", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    if (!auth) return c.json({ error: "Reassign requires Companion session auth" }, 403);
    if (!auth.caller.isOrchestrator) {
      return c.json({ error: "Only leader sessions can reassign quest ownership" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
    if (bodySession.raw && !bodySession.sessionId) {
      return c.json({ error: `Unknown sessionId: ${bodySession.raw}` }, 400);
    }
    const targetSessionId = bodySession.sessionId;
    if (!targetSessionId) return c.json({ error: "sessionId is required" }, 400);
    const targetSession = launcher.getSession(targetSessionId);
    if (!targetSession) return c.json({ error: `Unknown sessionId: ${targetSessionId}` }, 400);
    if (targetSession.isOrchestrator) return c.json({ error: "Leaders cannot be assigned quest ownership" }, 403);
    if (targetSession.archived) return c.json({ error: "Cannot reassign quest ownership to an archived session" }, 400);
    const reason = ownershipReason(body.reason);
    if (!reason) return c.json({ error: "Reassign reason is required" }, 400);

    const questId = c.req.param("questId");
    const current = await questStore.getQuest(questId);
    if (!current) return c.json({ error: "Quest not found" }, 404);
    const previousOwnerSessionId = activeOwnerSessionId(current);
    if (!previousOwnerSessionId) return c.json({ error: "Only in-progress quests can be reassigned" }, 400);
    if (previousOwnerSessionId === targetSessionId) {
      return c.json({ error: "Quest is already owned by the target session" }, 400);
    }
    if (!leaderCanReassignToWorker(auth.callerId, targetSessionId, questId)) {
      return c.json(
        { error: "Leader can only reassign to a herded worker or the worker assigned on this leader's board row" },
        403,
      );
    }

    try {
      const quest = await questStore.claimQuest(questId, targetSessionId, {
        force: true,
        leaderSessionId: auth.callerId,
        ownershipEvent: {
          operation: "reassign",
          actorSessionId: auth.callerId,
          previousOwnerSessionId,
          newOwnerSessionId: targetSessionId,
          reason,
          ...(current.leaderSessionId ? { previousLeaderSessionId: current.leaderSessionId } : {}),
          newLeaderSessionId: auth.callerId,
        },
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge, quest);
      setClaimedQuest(previousOwnerSessionId, null);
      setClaimedQuest(targetSessionId, claimedQuestEvent(quest), lifecycleEvent("claimed", quest, targetSessionId));
      addQuestTaskEntry(targetSessionId, quest, "quest-" + quest.questId);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/complete", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const items = body.verificationItems as import("../quest-types.js").QuestVerificationItem[] | undefined;
    if (!items || !Array.isArray(items)) return c.json({ error: "verificationItems array is required" }, 400);
    const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
    const authSessionId = auth ? auth.callerId : "";
    const authIsOrchestrator = auth ? auth.caller.isOrchestrator : false;
    if (bodySession.raw && !bodySession.sessionId) {
      return c.json({ error: "sessionId does not belong to a known companion session" }, 400);
    }
    if (authSessionId && bodySession.sessionId && bodySession.sessionId !== authSessionId && !authIsOrchestrator) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const targetSessionId = bodySession.sessionId;
    if (targetSessionId && !launcher.getSession(targetSessionId)) {
      return c.json({ error: "sessionId does not belong to a known companion session" }, 400);
    }
    try {
      const currentQuest = await questStore.getQuest(c.req.param("questId"));
      if (!currentQuest) return c.json({ error: "Quest not found" }, 404);
      const activeV2Rows = findActiveV2BoardRowsForQuest(c.req.param("questId"), launcher, wsBridge);
      const recoveryEventOrResponse = buildLeaderCompletionRecoveryEvent(currentQuest, auth, body, items, activeV2Rows);
      if (recoveryEventOrResponse instanceof Response) return recoveryEventOrResponse;
      const recoveryEvent = recoveryEventOrResponse ?? undefined;
      const v2GuardResponse = recoveryEvent
        ? null
        : await guardV2MemoryCompletion(c.req.param("questId"), currentQuest, auth, body, targetSessionId);
      if (v2GuardResponse) return v2GuardResponse;
      const guardResponse = guardStatusMutation(c, auth, currentQuest, body);
      if (guardResponse) return guardResponse;
      const currentOwnerSessionId = getTakodeQuestOwnerSessionId(currentQuest) ?? "";
      const commitShas = Array.isArray(body.commitShas) ? body.commitShas : undefined;
      const memoryCommitShas = Array.isArray(body.memoryCommitShas) ? body.memoryCommitShas : undefined;
      const quest = await questStore.completeQuest(c.req.param("questId"), items, {
        commitShas,
        memoryCommitShas,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        ...(typeof body.debrief === "string" ? { debrief: body.debrief } : {}),
        ...(typeof body.debriefTldr === "string" ? { debriefTldr: body.debriefTldr } : {}),
        ...(recoveryEvent ? { recoveryEvent } : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      syncDoneQuestBoardState(c.req.param("questId"), quest);
      broadcastQuestUpdate(wsBridge, quest);
      // Update session's quest status so browsers can show review-pending state.
      const reviewOwnerSessionId =
        targetSessionId || currentOwnerSessionId || getTakodeDisplayOwnerSessionId(quest) || "";
      if (reviewOwnerSessionId && hasQuestReviewMetadata(quest) && !isDirectCodexOwnedQuest(quest)) {
        setClaimedQuest(
          reviewOwnerSessionId,
          claimedQuestEvent(quest),
          isSubmissionEdge(currentQuest, quest) ? lifecycleEvent("submitted", quest, reviewOwnerSessionId) : undefined,
        );
      }
      setDebriefTldrWarningHeaderForAgentWrite(c, auth, body.debrief, body.debriefTldr);
      if (recoveryEvent) c.header(QUEST_LEADER_RECOVERY_WARNING_HEADER, formatLeaderRecoveryWarning(recoveryEvent));
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/done", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        notes?: string;
        cancelled?: boolean;
        debrief?: string;
        debriefTldr?: string;
        sessionId?: string;
        commitShas?: string[];
        memoryCommitShas?: string[];
        v2CompletionSync?: string;
        force?: boolean;
        reason?: string;
      };
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
      if (bodySession.raw && !bodySession.sessionId) {
        return c.json({ error: `Unknown sessionId: ${bodySession.raw}` }, 400);
      }
      const v2GuardResponse = await guardV2MemoryCompletion(
        c.req.param("questId"),
        current,
        auth,
        body,
        bodySession.sessionId,
      );
      if (v2GuardResponse) return v2GuardResponse;
      const guardResponse = guardStatusMutation(c, auth, current, body);
      if (guardResponse) return guardResponse;
      const quest = await transitionQuestAndSync(
        c.req.param("questId"),
        {
          status: "done",
          ...(body.notes ? { notes: body.notes } : {}),
          ...(body.debrief !== undefined ? { debrief: body.debrief } : {}),
          ...(body.debriefTldr !== undefined ? { debriefTldr: body.debriefTldr } : {}),
          ...(bodySession.sessionId ? { sessionId: bodySession.sessionId } : {}),
          ...(body.commitShas?.length ? { commitShas: body.commitShas } : {}),
          ...(body.memoryCommitShas?.length ? { memoryCommitShas: body.memoryCommitShas } : {}),
          ...(body.cancelled ? { cancelled: true } : {}),
        },
        current,
      );
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      c.header("X-Companion-Deprecated", 'Use /api/quests/:questId/transition with {status:"done"}');
      setDebriefTldrWarningHeaderForAgentWrite(c, auth, body.debrief, body.debriefTldr);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/cancel", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { notes?: string; force?: boolean; reason?: string };
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const guardResponse = guardStatusMutation(c, auth, current, body);
      if (guardResponse) return guardResponse;
      const quest = await questStore.cancelQuest(c.req.param("questId"), body.notes);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      // Clear the claimed quest from the active owner session since it's now cancelled.
      const currentOwnerSessionId = getTakodeQuestOwnerSessionId(current);
      if (currentOwnerSessionId) setClaimedQuest(currentOwnerSessionId, null);
      if (current && hasQuestReviewMetadata(current)) {
        const reviewOwner = getTakodeDisplayOwnerSessionId(current);
        if (reviewOwner) setClaimedQuest(reviewOwner, null);
      }
      if (!isDirectCodexOwnedQuest(current)) wsBridge.removeBoardRowFromAll(c.req.param("questId"));
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId/verification/:index", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const index = parseInt(c.req.param("index"), 10);
    if (Number.isNaN(index)) return c.json({ error: "Invalid index" }, 400);
    try {
      const quest = await questStore.checkVerificationItem(c.req.param("questId"), index, body.checked ?? false);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/read", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationRead(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      if (hasQuestReviewMetadata(quest)) {
        const reviewOwner = getTakodeDisplayOwnerSessionId(quest);
        if (reviewOwner) {
          setClaimedQuest(reviewOwner, claimedQuestEvent(quest));
        }
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/inbox", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationInboxUnread(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      if (hasQuestReviewMetadata(quest)) {
        const reviewOwner = getTakodeDisplayOwnerSessionId(quest);
        if (reviewOwner) {
          setClaimedQuest(reviewOwner, claimedQuestEvent(quest));
        }
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Append a feedback entry to a quest's thread
  api.post("/quests/:questId/feedback", async (c) => {
    const auth = authenticateCompanionCallerOptional(c);
    if (auth && "response" in auth) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const text = body.text;
    const tldr = normalizeTldr(body.tldr);
    const author = body.author === "agent" ? "agent" : "human";
    const bodySession = resolveSubmittedSessionId(body.sessionId, resolveId);
    const authSessionId = auth ? auth.callerId : "";
    if (bodySession.raw && !bodySession.sessionId) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${bodySession.raw}. ` + "Agent feedback must include a valid Companion session ID.",
        },
        400,
      );
    }
    if (authSessionId && bodySession.sessionId && bodySession.sessionId !== authSessionId) {
      return c.json({ error: "sessionId does not match authenticated caller" }, 403);
    }
    const resolvedAuthorSessionId = bodySession.sessionId || authSessionId;
    if (author === "agent" && resolvedAuthorSessionId.length === 0) {
      return c.json({ error: "sessionId is required for agent feedback (or provide Companion auth headers)" }, 400);
    }
    const authorSessionId = resolvedAuthorSessionId || undefined;
    if (!text || typeof text !== "string" || !text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    if (authorSessionId && !launcher.getSession(authorSessionId)) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${authorSessionId}. ` +
            "Feedback session attribution requires a valid Companion session ID.",
        },
        400,
      );
    }
    try {
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      const entry: import("../quest-types.js").QuestFeedbackEntry = { author, text: text.trim(), ts: Date.now() };
      if (tldr) entry.tldr = tldr;
      if (authorSessionId) entry.authorSessionId = authorSessionId;
      const hasImagesField = body.images !== undefined;
      if (Array.isArray(body.images) && body.images.length > 0) entry.images = body.images;
      const documentation = resolveQuestFeedbackDocumentation({
        quest: current,
        authorSessionId,
        request: body,
        boardRows: boardRowCandidatesForQuest(current),
      });
      if (documentation.error)
        return c.json({ error: documentation.error }, (documentation.status ?? 400) as 400 | 409);
      Object.assign(entry, documentation.entryPatch);
      if (documentation.warning) c.header(QUEST_PHASE_DOCUMENTATION_WARNING_HEADER, documentation.warning);

      let nextFeedback = [...existing, entry];
      let entryForWarning = entry;
      if (author === "agent" && isAgentSummaryFeedback(entry.text)) {
        const summaryIndex = findLatestAgentSummaryFeedbackIndex(existing, entry);
        if (summaryIndex !== -1) {
          nextFeedback = [...existing];
          const previousEntry = nextFeedback[summaryIndex]!;
          const hasTldrField = body.tldr !== undefined;
          const shouldCarryPreviousTldr = !hasTldrField && previousEntry.text === entry.text;
          const previousBase = shouldCarryPreviousTldr ? previousEntry : feedbackEntryWithoutTldr(previousEntry);
          const updatedEntry = {
            ...previousBase,
            text: entry.text,
            ...(hasTldrField && entry.tldr ? { tldr: entry.tldr } : {}),
            ts: entry.ts,
            ...(authorSessionId ? { authorSessionId } : {}),
            ...(hasImagesField ? { images: entry.images } : {}),
          };
          nextFeedback[summaryIndex] = updatedEntry;
          entryForWarning = updatedEntry;
        }
      }

      const quest = await questStore.patchQuest(
        c.req.param("questId"),
        {
          feedback: nextFeedback,
          ...(documentation.journeyRuns ? { journeyRuns: documentation.journeyRuns } : {}),
        },
        { current },
      );
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (author === "agent") {
        setTldrWarningHeader(c, tldrWarningForContent("feedback", entryForWarning.text, entryForWarning.tldr));
      }
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Edit an existing feedback entry by index
  api.patch("/quests/:questId/feedback/:index", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      if (isDeletedQuestFeedbackEntry(existing[index])) return c.json({ error: "Feedback entry was deleted" }, 400);
      const updated = [...existing];
      if (typeof body.text === "string" && body.text.trim())
        updated[index] = { ...updated[index], text: body.text.trim() };
      if (body.tldr !== undefined) {
        updated[index] = { ...updated[index], tldr: normalizeTldr(body.tldr) };
      }
      if (body.images !== undefined)
        updated[index] = {
          ...updated[index],
          images: Array.isArray(body.images) && body.images.length > 0 ? body.images : undefined,
        };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (updated[index]?.author === "agent") {
        setTldrWarningHeader(c, tldrWarningForContent("feedback", updated[index]?.text, updated[index]?.tldr));
      }
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Delete an existing feedback entry by index
  api.delete("/quests/:questId/feedback/:index", async (c) => {
    try {
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      const entry = existing[index];
      if (isDeletedQuestFeedbackEntry(entry)) return c.json({ error: "Feedback entry was already deleted" }, 400);
      const updated = [...existing];
      updated[index] = tombstoneQuestFeedbackEntry(entry!, Date.now());
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Toggle addressed status on a feedback entry
  api.post("/quests/:questId/feedback/:index/addressed", async (c) => {
    try {
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("../quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current
          ? ((current as { feedback?: import("../quest-types.js").QuestFeedbackEntry[] }).feedback ?? [])
          : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      if (isDeletedQuestFeedbackEntry(existing[index])) return c.json({ error: "Feedback entry was deleted" }, 400);
      const updated = [...existing];
      updated[index] = { ...updated[index], addressed: !updated[index].addressed };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated }, { current });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      const quest = await questStore.addQuestImages(c.req.param("questId"), [image]);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      if (isSharpUnavailableError(e)) {
        return c.json({ error: SHARP_UNAVAILABLE_MESSAGE }, 503);
      }
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/quests/:questId/images/:imageId", async (c) => {
    try {
      const quest = await questStore.removeQuestImage(c.req.param("questId"), c.req.param("imageId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      broadcastQuestUpdate(wsBridge);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  return api;
}
