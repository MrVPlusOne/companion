import type {
  ActiveTurnRoute,
  ActiveCodexReasoningPreview,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CodexModelSwitchCompactionGuard,
  CodexLeaderRecycleTrigger,
  CodexOutboundTurn,
  PendingCodexInput,
  PermissionRequest,
  SessionNotification,
  SessionState,
} from "../session-types.js";
import type { CodexReasoningPreviewsByThread } from "./codex-reasoning-preview-state.js";
import type { MemoryCatalogInjectionBundle } from "../memory-catalog-injection-utils.js";
import type { ModelAuthorityDecision } from "../model-identity-contract.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import type { RecoveryDeliveryTransfer } from "./recovery-delivery-transfer.js";

export type InterruptSource = "user" | "leader" | "system";

export type ControlResponseHandler = {
  subtype: string;
  resolve: (response: unknown) => void;
};

type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

type SessionNotificationDeps = {
  isHerdedWorkerSession?: (session: AdapterBrowserRoutingSessionLike) => boolean;
  broadcastToBrowsers?: (session: AdapterBrowserRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: AdapterBrowserRoutingSessionLike) => void;
  schedulePermissionNotification?: (session: AdapterBrowserRoutingSessionLike, request: PermissionRequest) => void;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean },
  ) => void;
  cancelPermissionNotification?: (sessionId: string, requestId: string) => void;
};

export interface AdapterBrowserRoutingSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  state: Pick<
    SessionState,
    | "askPermission"
    | "backend_error"
    | "backend_reconnect"
    | "backend_state"
    | "claude_token_details"
    | "codex_rate_limits"
    | "codex_image_send_stage"
    | "codex_reasoning_effort"
    | "codex_provider_retry"
    | "codex_effective_reasoning_effort"
    | "codex_effective_reasoning_effort_reported"
    | "codex_service_tier"
    | "codex_token_details"
    | "codex_result_error_auto_pause"
    | "codex_turn_recovery"
    | "context_used_percent"
    | "cwd"
    | "is_compacting"
    | "leaderThreadStatuses"
    | "memorySessionSpaceSlug"
    | "model"
    | "num_turns"
    | "permissionMode"
    | "pause"
    | "session_id"
    | "slash_commands"
    | "total_cost_usd"
    | "uiMode"
  >;
  messageHistory: BrowserIncomingMessage[];
  frozenCount?: number;
  attentionReason?: "action" | "error" | "review" | null;
  notifications?: SessionNotification[];
  pendingPermissions: Map<string, PermissionRequest>;
  evaluatingAborts: Map<string, AbortController>;
  pendingMessages: string[];
  pendingCodexTurns: CodexOutboundTurn[];
  pendingCodexInputs: PendingCodexInput[];
  recoveryDeliveryTransfers?: RecoveryDeliveryTransfer[];
  forceCompactPending: boolean;
  pendingStartupMemoryCatalogInjection?: boolean;
  isGenerating: boolean;
  recentAskVisibleResponseThreads?: Set<string>;
  activeCodexReasoningPreview?: ActiveCodexReasoningPreview | null;
  codexReasoningPreviews?: CodexReasoningPreviewsByThread;
  codexModelSwitchCompactionGuard?: CodexModelSwitchCompactionGuard | null;
  backendSocket?: unknown;
  lastUserMessage?: string;
  lastMessagePreviewAt?: number;
  lastUserMessageDateTag: string;
  lastOutboundUserNdjson: string | null;
  consecutiveAdapterFailures: number;
  codexAdapter: {
    sendBrowserMessage(msg: unknown): boolean;
    getCurrentTurnId(): string | null;
    isConnected(): boolean;
  } | null;
  claudeSdkAdapter: {
    sendBrowserMessage(msg: unknown): boolean;
    isConnected?(): boolean;
  } | null;
}

export interface AdapterBrowserRoutingDeps {
  sendToCLI: (
    session: AdapterBrowserRoutingSessionLike,
    ndjson: string,
    opts?: {
      deferUntilCliReady?: boolean;
      skipUserDispatchLifecycle?: boolean;
      userMessageHistoryIndex?: number;
    },
  ) => UserDispatchTurnTarget | null;
  broadcastToBrowsers: (session: AdapterBrowserRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>, actorSessionId?: string) => void;
  persistSession: (session: AdapterBrowserRoutingSessionLike) => void;
  persistHistoryMetadataRepair?: (
    session: AdapterBrowserRoutingSessionLike,
    expectedFrozenCount: number,
  ) => Promise<void>;
  refreshBrowserConversationViews?: (session: AdapterBrowserRoutingSessionLike) => void;
  invalidateLeaderThreadTabsForSession?: (sessionId: string) => boolean;
  promoteLeaderThreadTabForMessageAttention?: (
    sessionId: string,
    message: Extract<BrowserIncomingMessage, { type: "user_message" }>,
  ) => boolean;
  sessionNotificationDeps: SessionNotificationDeps;
  onAgentPaused?: (sessionId: string, history: AdapterBrowserRoutingSessionLike["messageHistory"], cwd: string) => void;
  getCurrentTurnTriggerSource: (session: AdapterBrowserRoutingSessionLike) => "user" | "leader" | "system" | "unknown";
  abortAutoApproval: (session: AdapterBrowserRoutingSessionLike, requestId: string) => void;
  preInterrupt: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
  touchUserMessage: (sessionId: string, timestamp?: number) => void;
  formatVsCodeSelectionPrompt: (selection: NonNullable<BrowserUserMessage["vscodeSelection"]>) => string;
  getCliSessionId: (session: AdapterBrowserRoutingSessionLike) => string;
  nextUserMessageId: (ts: number) => string;
  onUserMessage?: (
    sessionId: string,
    history: AdapterBrowserRoutingSessionLike["messageHistory"],
    cwd: string,
    wasGenerating: boolean,
  ) => void;
  markRunningFromUserDispatch: (
    session: AdapterBrowserRoutingSessionLike,
    reason: string,
    interruptSource?: InterruptSource | null,
    userMessageHistoryIndex?: number,
    activeTurnRoute?: ActiveTurnRoute | null,
  ) => UserDispatchTurnTarget | null;
  trackUserMessageForTurn: (
    session: AdapterBrowserRoutingSessionLike,
    historyIndex: number,
    turnTarget: UserDispatchTurnTarget,
  ) => void;
  setGenerating: (session: AdapterBrowserRoutingSessionLike, generating: boolean, reason: string) => void;
  broadcastStatusChange: (
    session: AdapterBrowserRoutingSessionLike,
    status: "idle" | "running" | "compacting" | "reverting" | null,
  ) => void;
  setCodexImageSendStage: (
    session: AdapterBrowserRoutingSessionLike,
    stage: SessionState["codex_image_send_stage"],
    options?: { persist?: boolean },
  ) => void;
  notifyImageSendFailure: (session: AdapterBrowserRoutingSessionLike, err?: unknown) => void;
  isHerdEventSource: (agentSource: BrowserUserMessage["agentSource"]) => boolean;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  markTurnInterrupted: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
  armCodexFreshTurnRequirement: (session: AdapterBrowserRoutingSessionLike, turnId: string, reason: string) => void;
  clearCodexFreshTurnRequirement: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  addPendingCodexInput: (session: AdapterBrowserRoutingSessionLike, input: PendingCodexInput) => void;
  getCancelablePendingCodexInputs: (session: AdapterBrowserRoutingSessionLike) => PendingCodexInput[];
  removePendingCodexInput: (session: AdapterBrowserRoutingSessionLike, id: string) => PendingCodexInput | null;
  releaseCodexAutoPausedInputs?: (
    session: AdapterBrowserRoutingSessionLike,
    pausedAt: number,
  ) => Promise<"accepted" | "in_progress" | "stale">;
  clearQueuedTurnLifecycleEntries: (session: AdapterBrowserRoutingSessionLike) => void;
  queueCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  pokeStaleCodexPendingDelivery: (
    session: AdapterBrowserRoutingSessionLike,
    reason: string,
    options?: { triggeringInputId?: string },
  ) => boolean;
  rebuildQueuedCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike) => void;
  trySteerPendingCodexInputs: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  sendToBrowser: (ws: unknown, msg: BrowserIncomingMessage) => void;
  isCodexWorkerV2DeliveryFrozen: (sessionId: string) => boolean;
  getLauncherSessionInfo: (sessionId: string) =>
    | {
        archived?: boolean;
        askPermission?: boolean;
        cliSessionId?: string;
        codexLeaderCompactionMode?: string;
        codexReasoningEffort?: string;
        codexServiceTier?: string | null;
        codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
        herdedBy?: string | null;
        isOrchestrator?: boolean;
        killedByIdleManager?: boolean;
        model?: string;
        modelAuthority?: ModelAuthorityDecision;
        permissionMode?: string;
        state?: string;
        uiMode?: "plan" | "agent";
      }
    | null
    | undefined;
  requestCodexIntentionalRelaunch: (
    session: AdapterBrowserRoutingSessionLike,
    reason: string,
    delayMs?: number,
  ) => void;
  onPermissionModeChanged?: (sessionId: string, newMode: string) => void;
  sendControlRequest: (
    session: AdapterBrowserRoutingSessionLike,
    request: Record<string, unknown>,
    onResponse?: ControlResponseHandler,
  ) => void;
  requestCodexAutoRecovery: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  requestCodexLeaderRecycle: (
    session: AdapterBrowserRoutingSessionLike,
    trigger: CodexLeaderRecycleTrigger,
  ) => Promise<{ ok: boolean; error?: string }>;
  requestCliRelaunch?: (sessionId: string) => void;
  buildMemoryCatalogInjectionBundle?: (
    session: AdapterBrowserRoutingSessionLike,
  ) => MemoryCatalogInjectionBundle | Promise<MemoryCatalogInjectionBundle>;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
  ) => "sent" | "queued" | "dropped" | "no_session";
  handleSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleCodexSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetUiMode: (session: AdapterBrowserRoutingSessionLike, uiMode: "plan" | "agent") => void;
  handleCodexSetReasoningEffort: (session: AdapterBrowserRoutingSessionLike, effort: string) => void;
  handleCodexSetServiceTier: (session: AdapterBrowserRoutingSessionLike, serviceTier: string | null) => void;
  handleSetAskPermission: (session: AdapterBrowserRoutingSessionLike, askPermission: boolean) => void;
  handleInterruptFallback: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
}
