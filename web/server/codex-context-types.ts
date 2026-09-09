import type { CodexLeaderCompactionMode } from "../shared/codex-leader-compaction-mode.js";

export type CodexAutoCompactTokenLimitScope = "total" | "body_after_prefix";
export type CodexAutoCompactTokenLimitScopeSource = "configured" | "codex_default";

export type CodexContextCapacitySource =
  | "leader_recycle_guard"
  | "configured_usable_capacity"
  | "codex_config"
  | "codex_default";

export interface CodexContextWindowDiagnostics {
  role: "leader" | "non_leader";
  leaderMode?: CodexLeaderCompactionMode;
  capacitySource: CodexContextCapacitySource;
  /** User-requested effective/usable capacity, when Takode owns one. */
  configuredUsableContextWindow?: number;
  /** Window Takode presents as the current usable/recycle denominator. */
  displayContextWindow?: number;
  /** Raw provider/catalog window passed at the final launch boundary. */
  providerRawContextWindow?: number;
  /** Selected catalog reserve applied to the raw window, when known. */
  catalogEffectiveContextWindowPercent?: number;
  /** Effective provider window derived from the selected catalog, before any recycle display rewrite. */
  providerEffectiveContextWindow?: number;
  /** Launch/config auto-compact setting; not a trigger-time measurement. */
  autoCompactTokenLimit?: number;
  /** Configured or documented-default accounting scope for that setting. */
  autoCompactTokenLimitScope?: CodexAutoCompactTokenLimitScope;
  /** Whether the scope came from explicit config or Codex's documented default. */
  autoCompactTokenLimitScopeSource?: CodexAutoCompactTokenLimitScopeSource;
}

export type CodexCompactionCause = "unknown" | "context_pressure" | "manual" | "model_switch_migration";

export type CodexCompactionCauseSource = "producer" | "takode_manual_request" | "takode_model_switch_guard";

// Keep manual_compact readable for persisted events from the former command routing.
export type CodexLeaderRecycleTrigger = "threshold" | "manual_compact" | "manual_recycle" | "context_window_exhausted";

export interface CodexLeaderRecycleContinuation {
  trigger: CodexLeaderRecycleTrigger;
  requestedAt: number;
  content: string;
  recoveryId?: string;
  threadKey?: string;
  questId?: string;
}

export interface CodexModelSwitchCompactionGuard {
  previousModel?: string;
  nextModel: string;
  createdAt: number;
  expiresAt: number;
  modelActivityObserved?: boolean;
}

export interface SessionContextLengthSnapshot {
  /** Best available current usage observation, never a hidden active-context estimate. */
  contextTokensUsed?: number;
  /** Provider-reported current prompt input, which can omit retained encrypted reasoning. */
  providerReportedInputTokens?: number;
  /** Provider-reported current prompt plus current response output. */
  providerReportedTotalTokens?: number;
  contextUsedPercent?: number;
  modelContextWindow?: number;
  autoCompactTokenLimit?: number;
  autoCompactTokenLimitScope?: CodexAutoCompactTokenLimitScope;
  source: "compact_boundary" | "codex_token_details" | "codex_auto_compact_limit";
  capturedAt: number;
}

export interface SessionCompactionLifecycleEvent {
  type: "compaction";
  id: string;
  timestamp: number;
  backendType?: "claude" | "codex" | "claude-sdk";
  trigger?: "auto" | "manual";
  cause?: CodexCompactionCause;
  /** Evidence source for a classified cause. Missing means unavailable or legacy-unverified. */
  causeSource?: CodexCompactionCauseSource;
  /** Launch-resolved policy captured at event time so later relaunches cannot rewrite history. */
  contextWindowDiagnostics?: CodexContextWindowDiagnostics;
  before?: SessionContextLengthSnapshot;
  after?: SessionContextLengthSnapshot;
  finishedAt?: number;
}

export type SessionLifecycleEvent = SessionCompactionLifecycleEvent;

export interface CodexLeaderRecycleTokenSnapshot {
  contextTokensUsed?: number;
  contextUsedPercent?: number;
  modelContextWindow?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexLeaderRecycleEvent {
  trigger: CodexLeaderRecycleTrigger;
  requestedAt: number;
  previousCliSessionId?: string;
  nextCliSessionId?: string;
  tokenUsage?: CodexLeaderRecycleTokenSnapshot;
}

export interface CodexLeaderRecycleLineage {
  cliSessionIds: string[];
  recycleEvents: CodexLeaderRecycleEvent[];
}
