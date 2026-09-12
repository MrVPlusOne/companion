import type { ServerWebSocket } from "bun";
import type { CodexResumeTurnSnapshot, CodexSessionMeta } from "../codex-adapter.js";
import type { ClaudeSdkSessionMeta } from "../claude-sdk-adapter.js";
import type {
  BackendAdapter,
  CompactRequestedAwareAdapter,
  CurrentTurnIdAwareAdapter,
  PendingOutgoingAwareAdapter,
  RateLimitsAwareAdapter,
  TurnSteerFailedAwareAdapter,
  TurnStartedAwareAdapter,
  TurnSteeredAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./adapter-interface.js";
import type { BrowserTransportStateLike } from "./browser-transport-controller.js";
import type { RecoveryDeliveryTransfer } from "./recovery-delivery-transfer.js";
import type { InterruptSource as GenerationInterruptSource } from "./generation-lifecycle.js";
import type { QuestLifecycleStatus } from "./quest-detector.js";
import type {
  ActiveTurnRoute,
  ActiveCodexReasoningPreview,
  BackendType,
  BoardRow,
  BrowserIncomingMessage,
  BufferedBrowserEvent,
  CodexLeaderRecycleContinuation,
  CodexOutboundTurn,
  CodexPendingDeliveryProofSignal,
  ContextUsageHistoryEntry,
  ContentBlock,
  PendingCodexInput,
  PermissionRequest,
  SessionAttentionRecord,
  SessionNotification,
  SessionState,
  SessionTaskEntry,
  TakodeTurnEndEventData,
  TakodeWorkerStreamEventData,
  VsCodeOpenFileCommand,
  VsCodeWindowState,
} from "../session-types.js";
// ─── WebSocket data tags ──────────────────────────────────────────────────────

export interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

export interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  browserClientPlatform?: import("./browser-connection-diagnostics.js").BrowserClientPlatform;
  subscribed?: boolean;
  lastAckSeq?: number;
}

export interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

/** Tracks a pending control_request sent to CLI that expects a control_response. */
export interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

export type TurnTriggerSource = "user" | "leader" | "system" | "unknown";
export type InterruptSource = GenerationInterruptSource;
export type CodexBridgeAdapter = BackendAdapter<CodexSessionMeta> &
  TurnStartedAwareAdapter &
  TurnSteeredAwareAdapter &
  TurnSteerFailedAwareAdapter &
  TurnStartFailedAwareAdapter &
  CurrentTurnIdAwareAdapter &
  RateLimitsAwareAdapter & {
    rollbackTurns: (numTurns: number) => Promise<void>;
    forkThread?: (options?: { rollbackTurns?: number }) => Promise<string>;
    waitForInitialMcpToolAvailability?: (timeoutMs?: number) => Promise<boolean>;
    waitForMcpToolAvailability?: (serverName: string, toolName: string, timeoutMs?: number) => Promise<boolean>;
  } & Partial<{
    refreshSkills: (
      forceReload?: boolean,
      cause?: "initialize" | "skills_changed" | "api" | "manual",
      timeoutMs?: number,
    ) => Promise<string[]>;
  }>;
export type ClaudeSdkBridgeAdapter = BackendAdapter<ClaudeSdkSessionMeta> & CompactRequestedAwareAdapter;

export interface Session {
  id: string;
  backendType: BackendType;
  backendSocket: ServerWebSocket<SocketData> | null;
  codexAdapter: CodexBridgeAdapter | null;
  claudeSdkAdapter: ClaudeSdkBridgeAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  /** Pending control_requests sent TO CLI, keyed by request_id */
  pendingControlRequests: Map<string, PendingControlRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Persisted server-only native Codex child registry; provider IDs never enter SessionState. */
  codexNativeSubagents: import("../codex-native-subagent-state.js").CodexNativeSubagentRegistry;
  /** Number of history entries that belong to the frozen prefix persisted in the append-only log. */
  frozenCount: number;
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** True after Takode has queued a forced `/compact` and is waiting for the
   *  relaunched Claude session to actually begin the real compaction cycle. */
  forceCompactPending: boolean;
  /** Authoritative Codex outbound user-turn queue (persisted across disconnect/relaunch). */
  pendingCodexTurns: CodexOutboundTurn[];
  codexTerminalRecoveries: import("../session-types.js").CodexTurnRecoveryState[];
  /** Codex inputs accepted by Takode but not yet delivered to Codex. */
  pendingCodexInputs: PendingCodexInput[];
  /** Server-only persisted payload owners while recovery-linked inputs cross into normal delivery. */
  recoveryDeliveryTransfers: RecoveryDeliveryTransfer[];
  /** Pending Codex thread rollback to run on the next connected adapter. */
  pendingCodexRollback: { numTurns: number; truncateIdx: number; clearCodexState: boolean } | null;
  /** Last error from a pending Codex rollback, if any. */
  pendingCodexRollbackError: string | null;
  /** Resolver for an in-flight deferred Codex rollback request. */
  pendingCodexRollbackWaiter: { resolve: () => void; reject: (err: Error) => void } | null;
  /** Monotonic sequence for broadcast events */
  nextEventSeq: number;
  /** Recent broadcast events for reconnect replay */
  eventBuffer: BufferedBrowserEvent[];
  /** Highest acknowledged seq seen from any browser for this session */
  lastAckSeq: number;
  /** Recently processed browser client_msg_id values for idempotency on reconnect retries */
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** Full tool results indexed by tool_use_id for lazy fetch */
  toolResults: Map<string, { content: string; is_error: boolean; timestamp: number }>;
  /** Retained live tool output tails (tool_use_id -> output) for transcript fallback. */
  toolProgressOutput: Map<string, string>;
  /** Parsed quest lifecycle commands pending completion, keyed by tool_use_id. */
  pendingQuestCommands: Map<
    string,
    { questId: string; targetStatus?: QuestLifecycleStatus; verificationInboxUnread?: boolean }
  >;
  /** Set after compact_boundary; the next user text message is the summary */
  awaitingCompactSummary?: boolean;
  /** Claude WebSocket only: a real compact_boundary arrived for the current compaction cycle. */
  claudeCompactBoundarySeen?: boolean;
  /** Accumulates content blocks for assistant messages with the same ID (parallel tool calls) */
  assistantAccumulator: Map<
    string,
    { contentBlockIds: Set<string>; currentHistoryMessageId?: string; rawContent?: ContentBlock[] }
  >;
  /** Wall-clock start times for tool calls (tool_use_id → Date.now()). Transient, not persisted. */
  toolStartTimes: Map<string, number>;
  /** Cheap fingerprint of linked-worktree metadata used to skip unnecessary git refreshes. */
  worktreeStateFingerprint: string;
  /** Last stable-input diff-stat cache entry for avoiding repeated expensive numstat work. */
  diffStatsCacheKey?: string;
  diffStatsCacheResult?: {
    totalLinesAdded: number;
    totalLinesRemoved: number;
    skippedReason: string | null;
  } | null;
  /** Codex-only watchdog timers for tool calls that started but never produced tool_result. */
  codexToolResultWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  /** Whether the CLI is actively generating a response (transient, not persisted) */
  isGenerating: boolean;
  /** Latest producer status used only when current server lifecycle is otherwise idle. */
  navigationProducerStatus?: import("../../shared/session-navigation-projection.js").SessionNavigationStatus;
  /** Last launcher activity sample published through the navigation projection. */
  navigationLastActivityAt?: number;
  /** Coalescing bucket for navigationLastActivityAt; null means sampled with no timestamp. */
  navigationActivityBucket?: number | null;
  /** When isGenerating became true (epoch ms), for stuck detection + timer restore */
  generationStartedAt: number | null;
  /** Quest status snapshot at turn start, for detecting changes in turn_end events */
  questStatusAtTurnStart: string | null;
  /** Message history length at turn start, for computing message ID range in turn_end */
  messageCountAtTurnStart: number;
  /** Set when handleInterrupt is called during generation, cleared at turn end */
  interruptedDuringTurn: boolean;
  /** Source of the current turn interruption (if interruptedDuringTurn=true). */
  interruptSourceDuringTurn: InterruptSource | null;
  /** Optional restart-prep metadata for a user-sourced interrupt. */
  restartPrepInterruptOperationId?: string | null;
  restartPrepInterruptOrigin?: "restart_prep" | null;
  /** Consecutive SDK/adapter disconnect count without a successful turn completion.
   *  Used to cap auto-relaunch attempts and prevent infinite respawn loops. */
  consecutiveAdapterFailures: number;
  /** Timestamp of the latest adapter disconnect failure for decay/reset windows. */
  lastAdapterFailureAt: number | null;
  /** Expected disconnect deadline for an intentional Codex relaunch. */
  intentionalCodexRelaunchUntil: number | null;
  /** Debug label for the current intentional Codex relaunch guard. */
  intentionalCodexRelaunchReason: string | null;
  /** Whether context compaction occurred during the current turn (for turn_end herd events) */
  compactedDuringTurn: boolean;
  /** Provisional stuck recovery already reported while waiting for a connected Codex turn to settle. */
  provisionalStuckRecovery: import("./generation-lifecycle.js").ProvisionalStuckRecovery | null;
  /** One-shot continuation prompt injected after an intentional Codex leader recycle. */
  codexLeaderRecycleContinuation: CodexLeaderRecycleContinuation | null;
  /** Non-leader startup memory catalog prelude waiting for the first real model-bound input. */
  pendingStartupMemoryCatalogInjection?: boolean;
  /** Message history indices of user messages received during the current turn (for turn_end herd events) */
  userMessageIdsThisTurn: number[];
  /** Synthetic quest-thread attachment reminders queued from leader assistant output for delivery after result. */
  questThreadRemindersThisTurn?: import("./quest-thread-reminder.js").QuestThreadReminderInjection[];
  /** Thread/quest route associated with the currently active turn, when known. */
  activeTurnRoute?: ActiveTurnRoute | null;
  /** Volatile top-level Codex reasoning preview for the active turn. */
  activeCodexReasoningPreview?: ActiveCodexReasoningPreview | null;
  codexReasoningPreviews?: import("./codex-reasoning-preview-state.js").CodexReasoningPreviewsByThread;
  /** Number of follow-up turns queued while a current turn is still running. */
  queuedTurnStarts: number;
  /** Dispatch reasons for queued follow-up turns (aligned with queuedTurnStarts). */
  queuedTurnReasons: string[];
  /** User message history IDs per queued follow-up turn. */
  queuedTurnUserMessageIds: number[][];
  /** Threads where top-level visible streamed response text has started since the last direct human input. */
  recentAskVisibleResponseThreads: Set<string>;
  /** Interrupt sources aligned with queued follow-up turns.
   *  A queued follow-up does not prove the active turn was interrupted. */
  queuedTurnInterruptSources: (InterruptSource | null)[];
  /** Explicit active-thread route aligned with queued follow-up turns. */
  queuedTurnActiveRoutes?: (ActiveTurnRoute | null)[];
  /** Codex-only: active turn id that must end before a follow-up can start a fresh turn.
   *  Used for denied ExitPlanMode so new input does not get steered into the old plan turn. */
  codexFreshTurnRequiredUntilTurnId: string | null;
  /** One-shot guard for Codex's model-switch resume migration compaction. */
  codexModelSwitchCompactionGuard: import("../session-types.js").CodexModelSwitchCompactionGuard | null;
  /** True while a model-switch migration compaction should not inject Takode recovery. */
  codexSuppressRecoveryForCurrentCompaction: boolean;
  /** Bounded, payload-free breadcrumbs for diagnosing pending-delivery blockage. */
  codexPendingDeliveryProofSignals: CodexPendingDeliveryProofSignal[];
  /** Bounded reported-token/context usage samples for opt-in diagnostics. */
  contextUsageHistory?: ContextUsageHistoryEntry[];
  /** Whether system.init has been received since the last CLI connect.
   *  False during --resume replay — messages sent before init are dropped by CLI. */
  cliInitReceived: boolean;
  /** Last message received from CLI (epoch ms), for stuck detection */
  lastCliMessageAt: number;
  /** Last keep_alive or WebSocket ping from CLI (epoch ms), for disconnect diagnostics */
  lastCliPingAt: number;
  /** Last tool_progress from any tool (epoch ms). Prevents false "stuck"
   *  warnings when a tool (Bash, Agent, etc.) is legitimately running. */
  lastToolProgressAt: number;
  /** Optimistic running rollback timer started when a user message is dispatched. */
  optimisticRunningTimer: ReturnType<typeof setTimeout> | null;
  /**
   * The last user message NDJSON sent to the CLI. Set when a user message is
   * forwarded to the CLI, cleared when the turn completes (result message).
   * If the CLI disconnects mid-turn, this is re-queued in pendingMessages so
   * the message is automatically re-sent after --resume reconnect.
   */
  lastOutboundUserNdjson: string | null;
  /** When stuck notification was sent (epoch ms), to avoid repeated notifications */
  stuckNotifiedAt: number | null;
  /** Server-side activity preview (mirrors browser's sessionTaskPreview) */
  lastActivityPreview?: string;
  /** Cached truncated content of the last user message (avoids scanning messageHistory) */
  lastUserMessage?: string;
  lastMessagePreviewAt?: number;
  /** Calendar date key (YYYY-MM-DD) of the last CLI-bound user message, for date-boundary injection. */
  lastUserMessageDateTag: string;
  /** Epoch ms when the user last viewed this session (server-authoritative) */
  lastReadAt: number;
  /** Current attention reason: why this session needs the user's attention */
  attentionReason: "action" | "error" | "review" | null;
  /** Codex-only: defers disconnect interruption side-effects while reconnect/resume may recover the turn. */
  codexDisconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  /** Grace period timer for CLI disconnect — delays side-effects to allow seamless reconnect.
   *  The Claude Code CLI disconnects every 5 minutes for token refresh and reconnects in ~13s.
   *  If the CLI reconnects within the grace period, the disconnect is invisible to the system. */
  disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the CLI was generating when the grace timer started (preserved for deferred handling). */
  disconnectWasGenerating: boolean;
  /** Set when the CLI reconnects within the grace period (token refresh, not relaunch).
   *  Consumed by system.init handler to skip force-clearing isGenerating. */
  seamlessReconnect: boolean;
  /** Set by onBeforeRelaunch — prevents handleCLIOpen from treating the new
   *  CLI connection as a seamless reconnect (which would preserve stale isGenerating). */
  relaunchPending: boolean;
  /** High-level task history recognized by the session auto-namer */
  taskHistory: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords: string[];
  /** Leader work board: quest ID → row. Ephemeral per leader session, persisted across restarts. */
  board: Map<string, BoardRow>;
  /** Completed board items (moved here by rm/advance instead of being deleted). Newest-first by completedAt. */
  completedBoard: Map<string, BoardRow>;
  /** Per-row stall tracking for board warnings (not persisted). */
  boardStallStates: Map<string, { signature: string; stalledSince: number; warnedAt: number | null }>;
  /** Per-row queued dispatchability tracking for one-shot nudges (not persisted). */
  boardDispatchStates: Map<string, { signature: string; warnedAt: number | null; notificationId?: string | null }>;
  /** Per-session notification inbox entries from `takode notify`. */
  notifications: SessionNotification[];
  /** History length after the latest leader-thread outcome validation pass. */
  leaderThreadOutcomeValidatedHistoryLength?: number;
  /** Recovered Ready rejections awaiting the next normal outcome-validation boundary. */
  pendingLeaderRejectedReadyThreadKeys: string[];
  /** Server-authoritative attention records for Main ledger rows and top chips. */
  attentionRecords: SessionAttentionRecord[];
  /** Monotonic counter for notification IDs (survives deletion without collisions). */
  notificationCounter: number;
  /** Monotonic legacy notification-summary version; projection revisions are independent. */
  notificationStatusVersion?: number;
  /** Epoch ms of the latest notification-summary authority change. */
  notificationStatusUpdatedAt?: number;
  /** Explicit user-owned unread marker, cleared only by an authoritative read action. */
  manualUnread: boolean;
  /** Whether agent activity has occurred since the last diff computation */
  diffStatsDirty: boolean;
  /** True when this archived session was loaded with only search-relevant data.
   *  Full messageHistory will be lazy-loaded on first browser subscribe. */
  searchDataOnly: boolean;
  /** Lightweight search excerpts for search-data-only sessions. */
  searchExcerpts: import("../session-store.js").SearchExcerpt[];
  /** Whether this session was created by resuming an external CLI session (VS Code/terminal) */
  resumedFromExternal?: boolean;
  /** AbortControllers for in-flight LLM auto-approval evaluations, keyed by request_id.
   *  Used to cancel the LLM subprocess when the user responds manually. Transient — not persisted. */
  evaluatingAborts: Map<string, AbortController>;
  /** Whether we've sent the `initialize` control_request with appendSystemPrompt
   *  to the current CLI process (WebSocket sessions only). Reset on relaunch so
   *  new processes get fresh instructions. Prevents double-sends on seamless reconnects. */
  cliInitializeSent: boolean;
  /** True while a relaunched CLI is replaying old messages via --resume.
   *  During this window, system.status permissionMode changes must NOT
   *  overwrite uiMode — the replayed mode is stale and would revert
   *  user-approved mode transitions (e.g. ExitPlanMode → agent). */
  cliResuming: boolean;
  /** Debounce timer for clearing cliResuming after the last replayed system.init.
   *  The CLI replays ALL historical system.init messages (one per subagent),
   *  so we can't clear cliResuming on the first one — must wait for the replay
   *  to finish (no more system.init within the debounce window). */
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  /** True only for the first replay after a revert. While set, replayed
   *  history-backed Claude messages that are no longer present in the truncated
   *  messageHistory must be ignored instead of being re-appended. */
  dropReplayHistoryAfterRevert: boolean;
}

export interface WorkerStreamCheckpointResult {
  ok: true;
  streamed: boolean;
  reason: "streamed" | "not_generating" | "no_activity" | "dispatcher_unavailable";
  msgRange?: NonNullable<TakodeWorkerStreamEventData["msgRange"]>;
}

export type GitSessionKey =
  | "git_branch"
  | "git_default_branch"
  | "diff_base_branch"
  | "git_head_sha"
  | "diff_base_start_sha"
  | "is_worktree"
  | "is_containerized"
  | "repo_root"
  | "git_ahead"
  | "git_behind"
  | "total_lines_added"
  | "total_lines_removed"
  | "diff_stats_skipped_reason";
