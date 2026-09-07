import type {
  BackendType,
  BoardRow,
  CodexResultErrorAutoPauseState,
  CodexLeaderRecycleLineage,
  CodexLeaderRecycleTrigger,
  SessionPauseState,
  SessionState,
  SessionTaskEntry,
} from "./session-types.js";
import type { LeaderActivePhaseSummarySegment } from "../shared/leader-active-phase-summary.js";
import type { LeaderProfilePortrait } from "../shared/leader-profile-portraits.js";
import type { ModelAuthorityDecision, ModelProvenanceMigration } from "./model-identity-contract.js";
import type { CodexLeaderCompactionMode } from "../shared/codex-leader-compaction-mode.js";
import type { CodexMultiAgentVersion } from "../shared/codex-multi-agent-version.js";
import type { CodexContextWindowDiagnostics, SessionLifecycleEvent } from "./codex-context-types.js";
import type { CodexWorkerV2CutoverState } from "./codex-worker-v2-cutover-state.js";
import type { SyncedProjectionRestEnvelopeFields } from "../shared/synced-projection-registry.js";
import type { CodexInstructionSnapshot } from "./codex-adapter-types.js";
import type { SessionNavigationProjectionValue } from "../shared/session-navigation-projection.js";

export interface SdkSessionInfo extends SyncedProjectionRestEnvelopeFields {
  sessionId: string;
  /** Monotonic public integer ID. Delegate children can intentionally omit this. */
  sessionNum?: number;
  /** False for hidden delegate children that keep UUID/Codex identity but do not consume public #N numbers. */
  publicSessionNumber?: boolean;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  /** Managed Codex model winner plus the precedence/override trace used at launch. */
  modelAuthority?: ModelAuthorityDecision;
  /** Historical server-owned warning for one-time unknown-provenance migration. */
  modelProvenanceMigration?: ModelProvenanceMigration;
  permissionMode?: string;
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  /** Codex collaboration UI mode, kept separate from the permission profile. */
  uiMode?: "plan" | "agent";
  cwd: string;
  createdAt: number;
  /** Epoch ms of last user or CLI activity (used by idle manager) */
  lastActivityAt?: number;
  /** Epoch ms of last user message (used for sidebar activity sort) */
  lastUserMessageAt?: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  /** Codex leader recycle lineage across fresh-thread swaps within one Takode session. */
  codexLeaderRecycleLineage?: CodexLeaderRecycleLineage;
  /** Resolved Codex leader recycle threshold derived at launch from source model effective context. */
  codexLeaderRecycleThresholdTokens?: number;
  /** Pending Codex leader recycle awaiting a fresh replacement thread and recovery prompt. */
  codexLeaderRecyclePending?: {
    eventIndex: number;
    trigger: CodexLeaderRecycleTrigger;
    requestedAt: number;
  } | null;
  /** Codex leader context management mode. Missing values normalize to recycle. */
  codexLeaderCompactionMode?: CodexLeaderCompactionMode;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** Async cleanup state for archived worktree sessions. */
  worktreeCleanupStatus?: "pending" | "done" | "failed";
  /** Last background cleanup error, if any. */
  worktreeCleanupError?: string;
  /** Epoch ms when background cleanup started. */
  worktreeCleanupStartedAt?: number;
  /** Epoch ms when background cleanup finished (success or failure). */
  worktreeCleanupFinishedAt?: number;
  /** User-facing session name */
  name?: string;
  /** Hidden implementation session, omitted from normal session lists. */
  hidden?: boolean;
  /** Parent/root session when this session backs a Side Chat workspace. */
  parentSessionId?: string;
  /** Side Chat id, persisted under the legacy slackThreadId key for compatibility. */
  slackThreadId?: string;
  slackThreadAnchorMessageId?: string;
  slackThreadAnchorHistoryIndex?: number;
  /** Hidden thread sessions are hard read-only regardless of normal permission mode. */
  slackThreadReadOnly?: boolean;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Intentional diff-stat budget skip reason, distinct from refresh failures. */
  diffStatsSkippedReason?: string | null;
  /** Epoch ms for the last server git metadata refresh attempt. */
  gitStatusRefreshedAt?: number;
  /** Last git refresh error, if any. */
  gitStatusRefreshError?: string | null;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Reasoning effort selected for Codex sessions (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Takode-selected Codex multi-agent implementation used for launch and rollback. */
  codexMultiAgentVersion?: CodexMultiAgentVersion;
  /** Existing-worker fresh-thread rollout and rollback provenance. */
  codexWorkerV2Cutover?: CodexWorkerV2CutoverState;
  /** Codex app-server service tier selected for future turns. null/undefined means Standard. */
  codexServiceTier?: string | null;
  /** Optional per-session Codex usable context capacity target. */
  codexMaxContextLength?: number;
  /** Launch-resolved context/compaction contract. Omitted from normal session-list payloads. */
  codexContextWindowDiagnostics?: CodexContextWindowDiagnostics;
  /** Claude reasoning effort selected at launch. */
  claudeReasoningEffort?: string;
  /** Optional Claude max-context override; currently 1M beta only. */
  claudeMaxContextLength?: number;
  /** Optional per-session Codex home override, reused across relaunches. */
  codexHome?: string;
  /** Server-owned snapshot of the instruction/config sources reported for the current Codex thread. */
  codexInstructionSnapshot?: CodexInstructionSnapshot;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Number of active timers currently waiting on this session. */
  pendingTimerCount?: number;
  /** Emergency pause state for this session, when paused. */
  pause?: SessionPauseState | null;
  /** Number of inputs held while this session is paused. */
  pausedInputQueueCount?: number;
  /** Codex-only auto-pause state for repeated classified terminal result errors. */
  codexResultErrorAutoPause?: CodexResultErrorAutoPauseState | null;
  /** Number of coalesced automatic inputs held by Codex result-error auto-pause. */
  codexAutoPausedInputCount?: number;
  /** Highest active Takode notification urgency restored from the session inbox. */
  notificationUrgency?: "needs-input" | "review" | null;
  /** Number of unresolved Takode notifications for sidebar snapshots. */
  activeNotificationCount?: number;
  /** Number of muted unresolved needs-input notifications for sidebar snapshots. */
  mutedNeedsInputNotificationCount?: number;
  /** Set by idle manager before killing, lets the UI show a less alarming indicator */
  killedByIdleManager?: boolean;
  /** Whether --resume has already been retried once after a fast exit */
  resumeRetried?: boolean;

  // Worktree fields
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path */
  repoRoot?: string;
  /** Conceptual branch this session is working on (what user selected) */
  branch?: string;
  /** Actual git branch in the worktree (may differ for -wt-N branches) */
  actualBranch?: string;
  /** Branch/repo target that worktree changes should port back to. */
  worktreePortTarget?: {
    repoRoot: string;
    branch: string;
    worktreePath?: string;
    sourceSessionId?: string;
    sourceSessionNum?: number | null;
    sourceLabel?: string;
  };

  /** Whether this is an assistant-mode session */
  isAssistant?: boolean;
  /** Whether this is an orchestrator session (has herd/orchestration privileges) */
  isOrchestrator?: boolean;
  /** Stable built-in leader profile portrait assignment. */
  leaderProfilePortraitId?: string | null;
  /** Server-owned active Quest Journey phase counts for leader sidebar chips. */
  leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Env profile slug used at creation, for re-resolving env vars on relaunch */
  envSlug?: string;
  /** Env keys removed after env profile resolution and before fresh session identity injection. */
  blockedEnvKeys?: string[];
  /** Durable session-space/group assignment. `default` means confirmed default; null means unknown. */
  treeGroupId?: string | null;
  /** Authoritative Takode memory/session-space slug for default memory repo resolution. */
  memorySessionSpaceSlug?: string;
  /** When true, the session auto-namer is suppressed (e.g. temporary reviewer sessions) */
  noAutoName?: boolean;
  /** Session number of the parent session this reviewer is reviewing (reviewer lifecycle) */
  reviewerOf?: number;
  /** Server-issued secret used to authenticate privileged REST calls from this session. */
  sessionAuthToken?: string;
  /** One-shot: resume-session-at UUID for revert (cleared after use) */
  resumeAt?: string;
  /** The Companion-injected system prompt constructed at launch time (for debugging in Session Info). */
  injectedSystemPrompt?: string;
  /** Stable per-session Claude SDK debug log path for transport/process debugging. */
  sdkDebugLogPath?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
}

const PUBLIC_LAUNCHER_SESSION_FIELDS = [
  "sessionId",
  "sessionNum",
  "pid",
  "state",
  "exitCode",
  "model",
  "modelAuthority",
  "modelProvenanceMigration",
  "permissionMode",
  "askPermission",
  "uiMode",
  "cwd",
  "createdAt",
  "lastActivityAt",
  "lastUserMessageAt",
  "cliSessionId",
  "codexLeaderRecycleLineage",
  "codexLeaderRecycleThresholdTokens",
  "codexLeaderRecyclePending",
  "codexLeaderCompactionMode",
  "archived",
  "archivedAt",
  "worktreeCleanupStatus",
  "worktreeCleanupError",
  "worktreeCleanupStartedAt",
  "worktreeCleanupFinishedAt",
  "name",
  "hidden",
  "backendType",
  "gitBranch",
  "gitAhead",
  "gitBehind",
  "totalLinesAdded",
  "totalLinesRemoved",
  "diffStatsSkippedReason",
  "gitStatusRefreshedAt",
  "gitStatusRefreshError",
  "codexInternetAccess",
  "codexSandbox",
  "codexReasoningEffort",
  "codexMultiAgentVersion",
  "codexServiceTier",
  "codexMaxContextLength",
  "claudeReasoningEffort",
  "claudeMaxContextLength",
  "cronJobId",
  "cronJobName",
  "pendingTimerCount",
  "pause",
  "pausedInputQueueCount",
  "codexResultErrorAutoPause",
  "codexAutoPausedInputCount",
  "notificationUrgency",
  "activeNotificationCount",
  "mutedNeedsInputNotificationCount",
  "killedByIdleManager",
  "isWorktree",
  "repoRoot",
  "branch",
  "actualBranch",
  "worktreePortTarget",
  "isAssistant",
  "isOrchestrator",
  "leaderProfilePortraitId",
  "leaderActivePhaseSummary",
  "herdedBy",
  "envSlug",
  "treeGroupId",
  "memorySessionSpaceSlug",
  "reviewerOf",
  "containerId",
  "containerName",
  "containerImage",
] as const satisfies readonly (keyof SdkSessionInfo)[];

type PublicLauncherSessionField = (typeof PUBLIC_LAUNCHER_SESSION_FIELDS)[number];
type PublicLauncherProjectionOverrideField =
  | "state"
  | "cwd"
  | "createdAt"
  | "codexLeaderRecycleThresholdTokens"
  | "name"
  | "gitStatusRefreshedAt"
  | "cronJobId"
  | "cronJobName"
  | "herdedBy"
  | "lastActivityAt"
  | "lastUserMessageAt"
  | "reviewerOf";

/** Browser-safe SDK session row returned by session list/detail APIs. */
export type PublicSdkSessionInfo = Pick<
  SdkSessionInfo,
  Exclude<PublicLauncherSessionField, keyof SessionNavigationProjectionValue>
> &
  Pick<SdkSessionInfo, PublicLauncherProjectionOverrideField> &
  SyncedProjectionRestEnvelopeFields &
  Partial<SessionNavigationProjectionValue> & {
    branch?: string;
    actualBranch?: string;
    codexInternetAccess?: boolean | null;
    claudeReasoningEffort?: string | null;
    codexContextWindowDiagnostics?: CodexContextWindowDiagnostics;
    codexInstructionSnapshot?: Omit<CodexInstructionSnapshot, "contents">;
    injectedSystemPrompt?: string;
    activeNeedsInputNotificationCount?: number;
    activeReviewNotificationCount?: number;
    notificationStatusVersion?: number;
    notificationStatusUpdatedAt?: number;
    worktreeExists?: boolean;
    worktreeDirty?: boolean;
    leaderProfilePortrait?: LeaderProfilePortrait;
    leaderActiveBoardRows?: BoardRow[];
    attentionReason?: "action" | "error" | "review" | null;
    lastReadAt?: number;
    pendingPermissionSummary?: string | null;
    taskHistory?: SessionTaskEntry[];
    keywords?: string[];
    claimedQuestVerificationInboxUnread?: boolean;
    lastMessagePreviewAt?: number;
    numTurns?: number;
    codexTokenDetails?: SessionState["codex_token_details"];
    claudeTokenDetails?: SessionState["claude_token_details"];
    sessionLifecycleEvents?: SessionLifecycleEvent[];
  };

/**
 * Serialize launcher state through an explicit public allowlist before it
 * crosses a browser or CLI API boundary. Type-only narrowing is insufficient:
 * spreading an `SdkSessionInfo` object would otherwise retain future internal
 * recovery fields and session-local paths at runtime.
 */
export function stripInternalLauncherSessionState(
  info: SdkSessionInfo,
  options: {
    includeInjectedSystemPrompt?: boolean;
    includeCodexContextWindowDiagnostics?: boolean;
    includeCodexInstructionSnapshot?: boolean;
  } = {},
): PublicSdkSessionInfo {
  const result: Record<string, unknown> = {};
  for (const field of PUBLIC_LAUNCHER_SESSION_FIELDS) {
    const value = info[field];
    if (value !== undefined) result[field] = value;
  }
  if (options.includeInjectedSystemPrompt && info.injectedSystemPrompt !== undefined) {
    result.injectedSystemPrompt = info.injectedSystemPrompt;
  }
  if (options.includeCodexContextWindowDiagnostics && info.codexContextWindowDiagnostics !== undefined) {
    result.codexContextWindowDiagnostics = info.codexContextWindowDiagnostics;
  }
  if (options.includeCodexInstructionSnapshot && info.codexInstructionSnapshot !== undefined) {
    const snapshot = info.codexInstructionSnapshot;
    result.codexInstructionSnapshot = {
      threadId: snapshot.threadId,
      capturedAt: snapshot.capturedAt,
      lifecycle: snapshot.lifecycle,
      instructionSourcesReported: snapshot.instructionSourcesReported,
      developerInstructionsConfigured: snapshot.developerInstructionsConfigured,
      instructionSources: snapshot.instructionSources.map(({ path, kind, sourcePath, delivery }) => ({
        path,
        kind,
        ...(sourcePath !== undefined ? { sourcePath } : {}),
        ...(delivery !== undefined ? { delivery } : {}),
      })),
      configLayers: snapshot.configLayers.map(({ kind, path, label, profile }) => ({
        kind,
        ...(path !== undefined ? { path } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(profile !== undefined ? { profile } : {}),
      })),
    };
  }
  return result as PublicSdkSessionInfo;
}
