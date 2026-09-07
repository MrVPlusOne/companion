/**
 * Codex App-Server Adapter
 *
 * Translates between the Codex app-server JSON-RPC protocol (stdin/stdout)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code or Codex is
 * the backend.
 */

import { randomUUID } from "node:crypto";
import {
  clearCodexProviderFailureEvidence,
  createCodexProviderFailureEvidenceState,
  providerFailureContextForResult,
  recordCodexProviderFailureStderr,
} from "./codex-provider-failure-context.js";
import type { Subprocess } from "bun";
import {
  formatVsCodeSelectionPrompt,
  type BrowserIncomingMessage,
  type BrowserOutgoingMessage,
  type CodexAppReference,
  type CodexSkillReference,
  type SessionState,
  type CLIResultMessage,
} from "./session-types.js";
import type { CodexAdapterOptions, CodexInstructionSnapshot, CodexSessionMeta } from "./codex-adapter-types.js";
import { captureCodexInstructionSnapshot } from "./codex-instruction-snapshot.js";
import {
  buildCodexResumeSnapshot,
  buildCodexCollabMode,
  assertRequiredCodexResumeThread,
  extractCodexAppsPage,
  extractCodexMentionInputs,
  extractCodexSkillReferences,
  formatCodexInitializationError,
  formatPendingRpcRequests,
  isCodexCollaborationModeUnsupportedError,
  isCodexServiceTierRejection,
  isCodexTransportClosedError,
  isMissingCodexRolloutError,
  isCompactSlashCommand,
  isRecoverableCodexTurnStartError,
  mapCodexApprovalPolicy,
  mapCodexSandboxPolicy,
  normalizeCodexServiceTier,
  noteCodexTransportCloseForWave,
  toSafeText,
  unwrapShellWrappedCommand,
  type CodexResumeSnapshot,
} from "./codex-adapter-utils.js";
import {
  codexGoalCapabilityPatch,
  codexGoalStatePatch,
  CODEX_GOAL_UNKNOWN_CAPABILITY,
  normalizeCodexGoal,
  type CodexGoalSetInput,
  type CodexGoalSetMode,
  type CodexGoalState,
} from "./codex-goal.js";
import { clearCodexGoal, refreshCodexGoal, setCodexGoal } from "./codex-adapter-goal-controller.js";
import {
  buildCodexEffectiveReasoningEffortPatch,
  buildCodexTokenUsagePatch,
  updateCodexRateLimits,
  type CodexRateLimitSet,
} from "./codex-adapter-session-updates.js";
import { CodexApprovalManager } from "./codex-approval-manager.js";
import { CodexAsyncDispatchQueue } from "./codex-async-dispatch-queue.js";
import { CodexItemEventManager } from "./codex-item-event-manager.js";
import {
  buildCodexBatchInput,
  CodexUserMessageReceiptObserver,
  resolveCodexClientUserMessageId,
  type CodexUserMessageReceipt,
} from "./codex-user-message-receipt-observer.js";
import { JsonRpcTransport, isPidAlive } from "./codex-jsonrpc-transport.js";
import {
  CodexNativeSubagentAdapterController,
  getCodexThreadIdFromParams,
} from "./codex-native-subagent-adapter-controller.js";
import { CodexMcpManager } from "./codex-mcp-manager.js";
import { CodexMcpToolAvailability } from "./codex-mcp-tool-availability.js";
import { getRouterFailureToolName, isToolRouterFailureMessage } from "./codex-router-failure-utils.js";
import type {
  CodexAdapterDisconnectDiagnostics,
  CodexSkillChangeDiagnostics,
} from "./codex-adapter-diagnostics-types.js";
import { hasSkillChangeCauseMetadata, isTakodeDelegateStartupReady } from "./codex-adapter-startup-utils.js";
import type {
  BackendAdapter,
  CurrentTurnIdAwareAdapter,
  RateLimitsAwareAdapter,
  TurnSteerFailureInfo,
  TurnStartedAwareAdapter,
  TurnStartFailedAwareAdapter,
  TurnStartFailureInfo,
} from "./bridge/adapter-interface.js";
import { classifyCodexTurnSteerFailure } from "./codex-steer-failure.js";
import {
  configureCodexDeveloperInstructions,
  handleCodexTurnStartDispatchFailure,
} from "./codex-adapter-initialization.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../shared/codex-slash-commands.js";
import {
  codexEffectiveReasoningEffortPatch,
  readCodexReasoningEffortReport,
  UNREPORTED_CODEX_REASONING_EFFORT,
} from "../shared/codex-reasoning-effort.js";
import type {
  CodexSkillRefreshCause,
  CodexSkillRefreshDiagnostics,
  CodexSkillRefreshStats,
} from "./codex-adapter-refresh-types.js";

const TURN_START_ACK_TIMEOUT_MS = 60_000;
const STDERR_ROUTER_LINE_BUFFER_MAX = 64 * 1024;
const INITIAL_SKILL_METADATA_REFRESH_TIMEOUT_MS = 5_000;
const INITIAL_MCP_TOOL_AVAILABILITY_REFRESH_TIMEOUT_MS = 5_000;

export type { CodexResumeSnapshot, CodexResumeTurnSnapshot } from "./codex-adapter-utils.js";
export type { CodexSessionMeta } from "./codex-adapter-types.js";

// ─── JSON-RPC Transport ───────────────────────────────────────────────────────

// ─── Codex Adapter ────────────────────────────────────────────────────────────

export class CodexAdapter
  implements
    BackendAdapter<CodexSessionMeta>,
    TurnStartedAwareAdapter,
    TurnStartFailedAwareAdapter,
    CurrentTurnIdAwareAdapter,
    RateLimitsAwareAdapter
{
  private transport: JsonRpcTransport;
  private nativeSubagents: CodexNativeSubagentAdapterController;
  private proc: Subprocess;
  private sessionId: string;
  private options: CodexAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: CodexSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCbs = new Set<(error: string) => void>();
  private turnStartFailedCb: ((msg: BrowserOutgoingMessage, info?: TurnStartFailureInfo) => void) | null = null;
  private turnStartedCb: ((turnId: string, source?: "local" | "codex_goal_continuation") => void) | null = null;
  private turnSteeredCb: ((turnId: string, pendingInputIds: string[], clientUserMessageId?: string) => void) | null =
    null;
  private turnSteerFailedCb:
    | ((pendingInputIds: string[], info?: TurnSteerFailureInfo, clientUserMessageId?: string) => void)
    | null = null;

  // State
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private suppressedTurnResultIds = new Set<string>();
  private retiredTurnIds = new Set<string>();
  private toolRouterErrorByTurnId = new Map<string, string>();
  private handledWriteStdinRouterErrorByTurnId = new Map<string, string>();
  private suppressedWriteStdinRouterCompletionByTurnId = new Map<string, string>();
  private connected = false;
  private initialized = false;
  private initFailed = false;
  private collaborationModeSupported = true;

  // Last few raw JSON-RPC messages for debugging unexpected disconnects
  private recentRawMessages: string[] = [];
  private static readonly RAW_MESSAGE_RING_SIZE = 5;
  private processStderrLineBuffer = "";
  private providerFailureEvidence = createCodexProviderFailureEvidenceState();
  private lastDisconnectDiagnostics: CodexAdapterDisconnectDiagnostics | null = null;
  private inFlightSkillRefreshes = new Map<string, CodexSkillRefreshDiagnostics>();
  private lastSkillRefreshDiagnostics: CodexSkillRefreshDiagnostics | null = null;
  private lastSkillChangeDiagnostics: CodexSkillChangeDiagnostics | null = null;

  // Automatic skills/changed notifications mark metadata stale but do not
  // refresh live sessions. Manual refresh and relaunch remain the pickup paths.
  private _skillsStale = false;
  private _skillsStaleSince: number | null = null;
  private _lastSkillsChangedAt: number | null = null;
  private _skillsChangeCount = 0;
  private _skillRefreshRetryCount = 0;
  private _initialSkillMetadataRefreshPending = false;
  private _initialSkillMetadataRefreshQueued = false;
  private _initialMcpToolAvailabilityRefreshPending = false;
  private _initialMcpToolAvailabilityRefreshQueued = false;
  private _initialMcpToolAvailabilityRefreshInFlight = false;
  private _initialMcpToolAvailabilityRefreshCompleted = false;
  private mcpToolAvailability = new CodexMcpToolAvailability();
  skillRefreshStats: CodexSkillRefreshStats = { coalesced: 0, deferred: 0, executed: 0, failed: 0, suppressed: 0 };

  private itemEventManager: CodexItemEventManager;
  private userMessageReceiptObserver = new CodexUserMessageReceiptObserver();
  private mcpManager: CodexMcpManager;

  // Resolve when the current turn ends (used by interruptAndWaitForTurnEnd)
  private turnEndResolvers: Array<() => void> = [];

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];
  private outgoingDispatch: CodexAsyncDispatchQueue;
  // Latest known Codex skill metadata, keyed by skill name for fast `$skill` parsing.
  private skillPathByName = new Map<string, string>();

  // Pending approval requests (Codex sends these as JSON-RPC requests with an id)
  private approvalManager: CodexApprovalManager;

  // Codex account rate limits (fetched after init, updated via notification)
  private _rateLimits: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null = null;
  // Codex can publish multiple limit buckets (for example, "codex" and model-specific IDs).
  // Keep the latest values per limitId and prefer the canonical "codex" bucket for UI parity
  // with the official usage page.
  private rateLimitsByLimitId = new Map<string, CodexRateLimitSet>();
  private static readonly VALID_REASONING_EFFORTS = new Set("none minimal low medium high xhigh max ultra".split(" "));

  constructor(proc: Subprocess, sessionId: string, options: CodexAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Codex process must have stdio pipes");
    }

    this.transport = new JsonRpcTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
      sessionId,
      options.recorder,
      options.cwd || "",
    );
    this.outgoingDispatch = new CodexAsyncDispatchQueue(
      (label, error) =>
        console.warn(`[codex-adapter] Outgoing dispatch failed (${label}) for session ${this.sessionId}:`, error),
      () => this.nativeSubagents.drainDiscovery(),
    );
    this.nativeSubagents = new CodexNativeSubagentAdapterController(
      this.transport,
      () => this.currentTurnId === null && this.pendingOutgoing.length === 0 && !this.outgoingDispatch.hasPending(),
      () => this.currentTurnId,
    );
    this.itemEventManager = new CodexItemEventManager((msg) => this.emit(msg), {
      model: this.options.model,
    });
    this.mcpManager = new CodexMcpManager(this.transport, (msg) => this.emit(msg), sessionId);
    this.approvalManager = new CodexApprovalManager(
      this.transport,
      (msg) => this.emit(msg),
      { cwd: this.options.cwd },
      {
        resolveParentToolUseId: (params, itemId) => this.itemEventManager.resolveParentToolUseId(params, itemId),
        emitToolUseTracked: (toolUseId, toolName, input, options) =>
          this.itemEventManager.emitToolUseTracked(toolUseId, toolName, input, options),
        emitToolResult: (toolUseId, content, isError, parentToolUseId) =>
          this.itemEventManager.emitToolResult(toolUseId, content, isError, parentToolUseId),
      },
    );
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Keep a short raw-input ring buffer for post-mortem debugging.
    this.transport.onRawIncoming((line) => {
      const truncated = line.length > 200 ? line.substring(0, 200) + "..." : line;
      this.recentRawMessages.push(truncated);
      if (this.recentRawMessages.length > CodexAdapter.RAW_MESSAGE_RING_SIZE) {
        this.recentRawMessages.shift();
      }
    });

    // Propagate transport close (stdout ends) to the adapter.
    // This fires independently of proc.exited — stdout can close while
    // the process node wrapper is still alive, leaving the adapter in a
    // stale "connected" state that rejects messages with "Transport closed".
    this.transport.onClose(() => {
      if (!this.connected) return; // already handled by proc.exited
      const diagnostics = this.captureDisconnectDiagnostics("transport_close");
      const pendingRequests = diagnostics.pendingRpcRequests;
      console.log(
        `[codex-adapter] Transport closed for session ${sessionId} ` +
          `(pid=${proc.pid}, pidAlive=${isPidAlive(proc.pid)}, closeContext=${this.transport.getCloseContext()})` +
          ` closeId=${diagnostics.closeId}` +
          ` currentTurnId=${diagnostics.adapter.currentTurnId ?? "none"}` +
          ` (process may still be running)` +
          `${pendingRequests.length ? `, pendingRpcRequests=${formatPendingRpcRequests(pendingRequests)}` : ""}`,
      );
      this.options.recorder?.recordServerEvent(
        this.sessionId,
        "codex_adapter_transport_closed",
        diagnostics as unknown as Record<string, unknown>,
        "codex",
        this.options.cwd || "",
      );
      noteCodexTransportCloseForWave(diagnostics);
      if (this.recentRawMessages.length > 0) {
        console.log(
          `[codex-adapter] Last ${this.recentRawMessages.length} raw messages before close for ${sessionId}:`,
        );
        for (const msg of this.recentRawMessages) {
          console.log(`  ${msg}`);
        }
      }
      this.connected = false;
      // Wake any turn-end waiters so they don't hang after disconnect
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this._clearSkillRefreshTimer();
      this.itemEventManager.dispose();
      this.approvalManager.dispose();
      this.disconnectCb?.();
    });

    // Monitor process exit
    proc.exited.then((exitCode) => {
      if (!this.connected) {
        this.recordProcessExitAfterTransportClose(exitCode);
        return;
      }
      const diagnostics = this.captureDisconnectDiagnostics("process_exit", exitCode);
      console.log(
        `[codex-adapter] Process exited for session ${sessionId} ` +
          `(pid=${proc.pid}, code=${exitCode}, closeContext=${this.transport.getCloseContext()}, closeId=${diagnostics.closeId}, connected was true — transport.onClose did not fire first)`,
      );
      this.options.recorder?.recordServerEvent(
        this.sessionId,
        "codex_process_exited_before_transport_close",
        diagnostics as unknown as Record<string, unknown>,
        "codex",
        this.options.cwd || "",
      );
      this.connected = false;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this._clearSkillRefreshTimer();
      this.itemEventManager.dispose();
      this.approvalManager.dispose();
      this.disconnectCb?.();
    });

    // Start initialization
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getRateLimits() {
    return this._rateLimits;
  }

  async refreshSkills(
    forceReload = false,
    cause: CodexSkillRefreshCause = "manual",
    timeoutMs?: number,
  ): Promise<string[]> {
    const cwds = this.options.cwd ? [this.options.cwd] : [];
    const request = this.transport.request(
      "skills/list",
      {
        ...(cwds.length > 0 ? { cwds } : {}),
        ...(forceReload ? { forceReload: true } : {}),
      },
      timeoutMs,
    );
    const refresh = this.startSkillRefreshDiagnostics(cause, forceReload, cwds, request.id);
    let result: unknown;
    try {
      result = await request.promise;
      this.finishSkillRefreshDiagnostics(refresh.refreshId, "succeeded", null);
    } catch (err) {
      this.finishSkillRefreshDiagnostics(refresh.refreshId, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
    const skillMetadata = extractCodexSkillReferences(result, this.options.cwd);
    this.skillPathByName = new Map();
    for (const skill of skillMetadata) {
      const path = skill.path.trim();
      if (!path) continue;
      this.skillPathByName.set(skill.name, path);
      this.skillPathByName.set(skill.name.toLowerCase(), path);
    }
    const skills = skillMetadata.map((skill) => skill.name);
    const apps = await this.refreshApps(forceReload, timeoutMs);
    this._skillsStale = false;
    this._skillsStaleSince = null;
    this.emit({
      type: "session_update",
      session: {
        skills,
        skill_metadata: skillMetadata,
        apps,
        skills_stale: false,
        apps_stale: false,
        skills_stale_since: null,
        skills_last_changed_at: this._lastSkillsChangedAt,
        skills_last_change_reason: null,
        skills_change_count: this._skillsChangeCount,
      },
    });
    return skills;
  }

  private async refreshApps(forceRefetch = false, timeoutMs?: number): Promise<CodexAppReference[]> {
    if (!this.transport.isConnected()) return [];
    const apps: CodexAppReference[] = [];
    let cursor: string | null = null;

    try {
      do {
        const result = await this.transport.call(
          "app/list",
          {
            ...(cursor ? { cursor } : {}),
            ...(this.threadId ? { threadId: this.threadId } : {}),
            ...(forceRefetch ? { forceRefetch: true } : {}),
          },
          timeoutMs,
        );
        const page = extractCodexAppsPage(result);
        apps.push(...page.apps);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (err) {
      console.warn(`[codex-adapter] app/list failed for session ${this.sessionId}:`, err);
      return [];
    }

    const deduped = new Map(apps.map((app) => [app.id, app]));
    return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private _markSkillsChanged(params: unknown): void {
    const payload =
      params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    const now = Date.now();
    this._skillsStale = true;
    this._skillsStaleSince ??= now;
    this._lastSkillsChangedAt = now;
    this._skillsChangeCount++;
    this.skillRefreshStats.suppressed++;

    const diagnostics: CodexSkillChangeDiagnostics = {
      changeId: randomUUID(),
      receivedAt: now,
      sessionId: this.sessionId,
      cwd: this.options.cwd ?? null,
      currentTurnId: this.currentTurnId,
      connected: this.connected,
      initialized: this.initialized,
      payloadKeys: Object.keys(payload).sort(),
      payloadHasCauseMetadata: hasSkillChangeCauseMetadata(payload),
      staleSince: this._skillsStaleSince,
      action: "marked_stale_without_auto_refresh",
    };
    this.lastSkillChangeDiagnostics = diagnostics;

    console.warn(
      `[codex-adapter] skills/changed received for session ${this.sessionId}; ` +
        `marked skill/app metadata stale without automatic refresh ` +
        `(payloadKeys=${diagnostics.payloadKeys.join(",") || "none"}, ` +
        `payloadHasCauseMetadata=${diagnostics.payloadHasCauseMetadata}, ` +
        `currentTurnId=${this.currentTurnId ?? "none"})`,
    );
    this.options.recorder?.recordServerEvent(
      this.sessionId,
      "codex_skills_changed_marked_stale",
      diagnostics as unknown as Record<string, unknown>,
      "codex",
      this.options.cwd || "",
    );
    this.emitSkillMetadataStaleState();
  }

  private drainPendingInitialSkillMetadataRefresh(): void {
    if (!this._initialSkillMetadataRefreshPending) return;
    this.queueInitialSkillMetadataRefresh();
  }

  private drainPendingInitialMcpToolAvailabilityRefresh(): void {
    if (!this._initialMcpToolAvailabilityRefreshPending) return;
    this.queueInitialMcpToolAvailabilityRefresh();
  }

  _clearSkillRefreshTimer(): void {
    // Retained for disconnect cleanup/test compatibility after removing the
    // coalesced automatic refresh timer.
  }

  private emitSkillMetadataStaleState(): void {
    this.emit({
      type: "session_update",
      session: {
        skills_stale: this._skillsStale,
        apps_stale: this._skillsStale,
        skills_stale_since: this._skillsStaleSince,
        skills_last_changed_at: this._lastSkillsChangedAt,
        skills_last_change_reason: this._skillsStale ? "skills_changed" : null,
        skills_change_count: this._skillsChangeCount,
      },
    });
  }

  private scheduleInitialSkillMetadataRefresh(): void {
    this._initialSkillMetadataRefreshPending = true;
    this.queueInitialSkillMetadataRefresh();
  }

  private scheduleInitialMcpToolAvailabilityRefresh(): void {
    if (this._initialMcpToolAvailabilityRefreshCompleted || this._initialMcpToolAvailabilityRefreshInFlight) {
      return;
    }
    this._initialMcpToolAvailabilityRefreshPending = true;
    this.queueInitialMcpToolAvailabilityRefresh();
  }

  private async runInitialMcpToolAvailabilityRefreshIfIdle(cause: string): Promise<boolean> {
    if (!this._initialMcpToolAvailabilityRefreshPending) return false;
    if (!this.connected || this.initFailed) {
      this._initialMcpToolAvailabilityRefreshPending = false;
      return false;
    }
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Deferring initial MCP tool availability refresh for session ${this.sessionId}; turn ${this.currentTurnId} is active (cause=${cause})`,
      );
      return false;
    }

    this._initialMcpToolAvailabilityRefreshPending = false;
    this._initialMcpToolAvailabilityRefreshInFlight = true;
    try {
      console.log(
        `[codex-adapter] Reloading MCP servers for initial tool availability in session ${this.sessionId} (cause=${cause})`,
      );
      const servers = await this.mcpManager.handleReloadAndGetStatus(INITIAL_MCP_TOOL_AVAILABILITY_REFRESH_TIMEOUT_MS);
      this.mcpToolAvailability.record(servers);
      this._initialMcpToolAvailabilityRefreshCompleted = true;
      return true;
    } catch (err) {
      if (!this.connected) return false;
      console.warn(`[codex-adapter] Initial MCP tool availability refresh failed for session ${this.sessionId}:`, err);
      return false;
    } finally {
      this._initialMcpToolAvailabilityRefreshInFlight = false;
    }
  }

  private queueInitialMcpToolAvailabilityRefresh(): void {
    if (this._initialMcpToolAvailabilityRefreshQueued) return;
    this._initialMcpToolAvailabilityRefreshQueued = true;
    this.enqueueOutgoingDispatch("initial_mcp_tool_availability_refresh", async () => {
      this._initialMcpToolAvailabilityRefreshQueued = false;
      if (!this._initialMcpToolAvailabilityRefreshPending) return;
      if (this.pendingOutgoing.length > 0) {
        console.log(
          `[codex-adapter] Deferring initial MCP tool availability refresh for session ${this.sessionId}; ${this.pendingOutgoing.length} outgoing message(s) are queued`,
        );
        return;
      }
      await this.runInitialMcpToolAvailabilityRefreshIfIdle("startup");
    });
  }

  async waitForInitialMcpToolAvailability(
    timeoutMs = INITIAL_MCP_TOOL_AVAILABILITY_REFRESH_TIMEOUT_MS,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._initialMcpToolAvailabilityRefreshCompleted) return true;
      if (!this.connected || this.initFailed) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this._initialMcpToolAvailabilityRefreshCompleted;
  }

  async waitForMcpToolAvailability(serverName: string, toolName: string, timeoutMs = 10_000): Promise<boolean> {
    return this.mcpToolAvailability.waitFor(
      serverName,
      toolName,
      timeoutMs,
      () => this.connected && !this.initFailed,
      async () => {
        if (this._initialMcpToolAvailabilityRefreshPending || this._initialMcpToolAvailabilityRefreshInFlight) {
          await this.runInitialMcpToolAvailabilityRefreshIfIdle(`wait_for_${serverName}_${toolName}`);
        }
      },
    );
  }

  private queueInitialSkillMetadataRefresh(): void {
    if (this._initialSkillMetadataRefreshQueued) return;
    this._initialSkillMetadataRefreshQueued = true;
    this.enqueueOutgoingDispatch("initial_skill_metadata_refresh", async () => {
      this._initialSkillMetadataRefreshQueued = false;
      if (!this._initialSkillMetadataRefreshPending) return;
      if (!this.connected || this.initFailed) {
        this._initialSkillMetadataRefreshPending = false;
        return;
      }
      if (this.currentTurnId) {
        this.skillRefreshStats.deferred++;
        this._skillRefreshRetryCount++;
        console.log(
          `[codex-adapter] Deferring initial skill/app metadata refresh for session ${this.sessionId}; turn ${this.currentTurnId} is active`,
        );
        return;
      }
      this._initialSkillMetadataRefreshPending = false;
      try {
        this.skillRefreshStats.executed++;
        await this.refreshSkills(true, "initialize", INITIAL_SKILL_METADATA_REFRESH_TIMEOUT_MS);
      } catch (err) {
        this.skillRefreshStats.failed++;
        if (!this.connected) return;
        console.warn(`[codex-adapter] Initial skill/app metadata refresh failed for session ${this.sessionId}:`, err);
      }
    });
  }

  private startSkillRefreshDiagnostics(
    cause: CodexSkillRefreshCause,
    forceReload: boolean,
    cwds: string[],
    rpcId: number,
  ): CodexSkillRefreshDiagnostics {
    const refresh: CodexSkillRefreshDiagnostics = {
      refreshId: randomUUID(),
      cause,
      forceReload,
      cwds,
      rpcId,
      startedAt: Date.now(),
      completedAt: null,
      status: "in_flight",
      error: null,
      inFlightAtStart: this.inFlightSkillRefreshes.size,
    };
    this.inFlightSkillRefreshes.set(refresh.refreshId, refresh);
    this.lastSkillRefreshDiagnostics = refresh;
    return refresh;
  }

  private finishSkillRefreshDiagnostics(refreshId: string, status: "succeeded" | "failed", error: string | null): void {
    const refresh = this.inFlightSkillRefreshes.get(refreshId);
    if (!refresh) return;
    const completed: CodexSkillRefreshDiagnostics = {
      ...refresh,
      completedAt: Date.now(),
      status,
      error,
    };
    this.inFlightSkillRefreshes.delete(refreshId);
    this.lastSkillRefreshDiagnostics = completed;
  }

  private captureDisconnectDiagnostics(
    reason: CodexAdapterDisconnectDiagnostics["reason"],
    exitCode: number | null = null,
  ): CodexAdapterDisconnectDiagnostics {
    const transport = this.transport.getCloseDiagnostics();
    const memory = process.memoryUsage();
    const diagnostics: CodexAdapterDisconnectDiagnostics = {
      closeId: transport?.closeId ?? randomUUID(),
      reason,
      sessionId: this.sessionId,
      capturedAt: Date.now(),
      process: {
        pid: this.proc.pid,
        pidAlive: isPidAlive(this.proc.pid),
        exitCode,
        eofToExitMs: transport && exitCode !== null ? Math.max(0, Date.now() - transport.closedAt) : null,
      },
      adapter: {
        threadId: this.threadId,
        currentTurnId: this.currentTurnId,
        model: this.options.model ?? null,
        cwd: this.options.cwd ?? null,
        approvalMode: this.options.approvalMode ?? null,
        sandbox: this.options.sandbox ?? null,
        connected: this.connected,
        initialized: this.initialized,
      },
      transport,
      pendingRpcRequests: transport?.pendingRequests ?? this.transport.getPendingRequests(),
      skillRefresh: {
        inFlightCount: this.inFlightSkillRefreshes.size,
        inFlight: [...this.inFlightSkillRefreshes.values()],
        last: this.lastSkillRefreshDiagnostics,
        lastChange: this.lastSkillChangeDiagnostics,
        stats: { ...this.skillRefreshStats },
        stale: this._skillsStale,
        staleSince: this._skillsStaleSince,
        retryCount: this._skillRefreshRetryCount,
      },
      stderrTail: this.options.failureContextProvider?.() || null,
      resource: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      recording: this.options.recorder?.getActiveRecorderStats(this.sessionId) ?? null,
    };
    this.lastDisconnectDiagnostics = diagnostics;
    return diagnostics;
  }

  private recordProcessExitAfterTransportClose(exitCode: number): void {
    const previous = this.lastDisconnectDiagnostics;
    if (!previous) return;
    const diagnostics = this.captureDisconnectDiagnostics("transport_close", exitCode);
    console.log(
      `[codex-adapter] Process exited after transport close for session ${this.sessionId} ` +
        `(pid=${this.proc.pid}, code=${exitCode}, closeId=${diagnostics.closeId}, eofToExitMs=${diagnostics.process.eofToExitMs ?? "unknown"})`,
    );
    this.options.recorder?.recordServerEvent(
      this.sessionId,
      "codex_process_exit_after_transport_close",
      diagnostics as unknown as Record<string, unknown>,
      "codex",
      this.options.cwd || "",
    );
  }

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    // If initialization failed, reject all new messages
    if (this.initFailed) {
      return false;
    }

    // Queue messages if not yet initialized (init is async)
    if (!this.initialized || !this.threadId) {
      if (
        msg.type === "user_message" ||
        msg.type === "codex_start_pending" ||
        msg.type === "codex_steer_pending" ||
        msg.type === "permission_response" ||
        msg.type === "set_codex_service_tier" ||
        msg.type === "mcp_get_status" ||
        msg.type === "mcp_toggle" ||
        msg.type === "mcp_reconnect" ||
        msg.type === "mcp_set_servers"
      ) {
        this.pendingOutgoing.push(msg);
        return true; // accepted, will be sent after init
      }
      // Non-queueable messages are dropped if not connected
      if (!this.connected) return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.enqueueOutgoingDispatch("user_message", () => this.handleOutgoingUserMessage(msg));
        return true;
      case "codex_start_pending":
        this.enqueueOutgoingDispatch("codex_start_pending", () => this.handleOutgoingPendingBatchStart(msg));
        return true;
      case "codex_steer_pending":
        this.enqueueOutgoingDispatch("codex_steer_pending", () => this.handleOutgoingPendingBatchSteer(msg));
        return true;
      case "permission_response":
        this.enqueueOutgoingDispatch("permission_response", () => this.handleOutgoingPermissionResponse(msg));
        return true;
      case "interrupt":
        this.enqueueOutgoingDispatch("interrupt", () => this.handleOutgoingInterrupt());
        return true;
      case "set_model":
        console.warn("[codex-adapter] Runtime model switching not supported by Codex");
        return false;
      case "set_codex_service_tier":
        this.options.serviceTier = normalizeCodexServiceTier(msg.serviceTier);
        return true;
      case "set_permission_mode":
        console.warn("[codex-adapter] Runtime permission mode switching not supported by Codex");
        return false;
      case "mcp_get_status":
        this.enqueueOutgoingDispatch("mcp_get_status", async () => {
          await this.mcpManager.handleGetStatus();
        });
        return true;
      case "mcp_toggle":
        this.enqueueOutgoingDispatch("mcp_toggle", () => this.mcpManager.handleToggle(msg.serverName, msg.enabled));
        return true;
      case "mcp_reconnect":
        this.enqueueOutgoingDispatch("mcp_reconnect", () => this.mcpManager.handleReconnect());
        return true;
      case "mcp_set_servers":
        this.enqueueOutgoingDispatch("mcp_set_servers", () => this.mcpManager.handleSetServers(msg.servers));
        return true;
      default:
        return false;
    }
  }

  private enqueueOutgoingDispatch(label: string, run: () => Promise<void>): void {
    this.outgoingDispatch.enqueue(label, run);
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  getNativeSubagentController(): CodexNativeSubagentAdapterController {
    return this.nativeSubagents;
  }

  onSessionMeta(cb: (meta: CodexSessionMeta) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  getLastDisconnectDiagnostics(): CodexAdapterDisconnectDiagnostics | null {
    return this.lastDisconnectDiagnostics;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCbs.add(cb);
  }

  onTurnStartFailed(cb: (msg: BrowserOutgoingMessage, info?: TurnStartFailureInfo) => void): void {
    this.turnStartFailedCb = cb;
  }

  onTurnStarted(cb: (turnId: string, source?: "local" | "codex_goal_continuation") => void): void {
    this.turnStartedCb = cb;
  }

  onTurnSteered(cb: (turnId: string, pendingInputIds: string[], clientUserMessageId?: string) => void): void {
    this.turnSteeredCb = cb;
  }

  onTurnSteerFailed(
    cb: (pendingInputIds: string[], info?: TurnSteerFailureInfo, clientUserMessageId?: string) => void,
  ): void {
    this.turnSteerFailedCb = cb;
  }

  onUserMessageRecorded(cb: (receipt: CodexUserMessageReceipt) => void): void {
    this.userMessageReceiptObserver.setCallback(cb);
  }

  onUserMessageReceiptObserved(cb: (receipt: CodexUserMessageReceipt) => void): void {
    this.userMessageReceiptObserver.setObservationCallback(cb);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 5000))]);
    } catch {}
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  async refreshGoal(): Promise<CodexGoalState | null> {
    if (!this.threadId) throw new Error("No Codex thread started yet");
    const result = await refreshCodexGoal(this.transport, this.threadId);
    this.emit({ type: "session_update", session: result.patch });
    return result.goal;
  }

  async setGoal(input: CodexGoalSetInput, mode: CodexGoalSetMode = "edit"): Promise<CodexGoalState | null> {
    if (!this.threadId) throw new Error("No Codex thread started yet");
    const result = await setCodexGoal(this.transport, this.threadId, input, mode);
    this.emit({ type: "session_update", session: result.patch });
    return result.goal;
  }

  async clearGoal(): Promise<void> {
    if (!this.threadId) throw new Error("No Codex thread started yet");
    this.emit({ type: "session_update", session: await clearCodexGoal(this.transport, this.threadId) });
  }

  handleProcessStderr(text: string): void {
    recordCodexProviderFailureStderr(this.providerFailureEvidence, text);
    for (const message of this.extractWriteStdinRouterFailuresFromStderrChunk(text)) {
      this.handleToolRouterFailureMessage(message);
    }
  }

  async rollbackTurns(numTurns: number): Promise<void> {
    if (!this.threadId) {
      throw new Error("No Codex thread started yet");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error(`Invalid rollback turn count: ${numTurns}`);
    }

    const activeTurnId = this.currentTurnId;
    if (activeTurnId) {
      // Revert should not surface an extra interrupted result into Takode
      // history, because the route already truncated browser history to the
      // pre-revert state before we mutate the backend thread.
      this.suppressedTurnResultIds.add(activeTurnId);
      try {
        await this.interruptAndWaitForTurnEnd();
      } catch (err) {
        this.suppressedTurnResultIds.delete(activeTurnId);
        throw err;
      }
    }

    try {
      await this.transport.call("thread/rollback", {
        threadId: this.threadId,
        numTurns,
      });
    } catch (err) {
      if (activeTurnId) {
        this.suppressedTurnResultIds.delete(activeTurnId);
      }
      throw err;
    }
  }

  async forkThread(options: { rollbackTurns?: number } = {}): Promise<string> {
    if (!this.threadId) throw new Error("No Codex thread started yet");
    const result = (await this.transport.call("thread/fork", this.buildThreadParams({ threadId: this.threadId }))) as {
      thread: { id: string };
    };
    const threadId = result.thread.id;
    if (options.rollbackTurns) {
      try {
        await this.transport.call("thread/rollback", { threadId, numTurns: options.rollbackTurns });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Rollback failed: ${message}`);
      }
    }
    return threadId;
  }

  // ── Initialization ──────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      let resumeSnapshot: CodexResumeSnapshot | null = null;
      let runtimeReasoningEffort = UNREPORTED_CODEX_REASONING_EFFORT;
      let threadLifecycle: CodexInstructionSnapshot["lifecycle"] = "thread_start";
      let threadInstructionResult: { thread: { id: string; path?: unknown }; instructionSources?: unknown } | undefined;
      // Step 1: Send initialize request
      const result = (await this.transport.call("initialize", {
        clientInfo: {
          name: "thecompanion",
          title: "The Companion",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      })) as Record<string, unknown>;

      // Step 2: Send initialized notification
      await this.transport.notify("initialized", {});

      await configureCodexDeveloperInstructions(this.transport, this.options.instructions);

      // Step 3: Start or resume a thread
      if (this.options.threadId) {
        try {
          // Resume an existing thread
          const resumeResult = (await this.transport.call(
            "thread/resume",
            this.buildThreadParams({ threadId: this.options.threadId }),
          )) as { thread: Record<string, unknown> & { id: string }; instructionSources?: unknown };
          this.threadId = resumeResult.thread.id;
          threadLifecycle = "thread_resume";
          threadInstructionResult = resumeResult;
          runtimeReasoningEffort = readCodexReasoningEffortReport(resumeResult);
          resumeSnapshot = buildCodexResumeSnapshot(resumeResult.thread);
          assertRequiredCodexResumeThread(this.threadId, this.options.requireResumeThreadId);
          // Only set currentTurnId if the turn is truly in-progress AND the
          // thread itself isn't idle. After a CLI restart, the thread reports
          // idle but the last turn's status may still say "inProgress" — that
          // turn is stale (it was in-progress in the dead process).
          const threadIsIdle = resumeSnapshot?.threadStatus === "idle";
          this.currentTurnId =
            !threadIsIdle && resumeSnapshot?.lastTurn?.status === "inProgress" ? resumeSnapshot.lastTurn.id : null;
        } catch (err) {
          // Fresh or partially-initialized Codex threads may fail resume with
          // "no rollout found". Fall back to a fresh thread to avoid a stuck session.
          if (!isMissingCodexRolloutError(err) || this.options.requireResumeThreadId) throw err;
          console.warn(
            `[codex-adapter] thread/resume failed for ${this.options.threadId}: ${err}. Starting a fresh thread.`,
          );
          const threadResult = (await this.transport.call("thread/start", this.buildThreadParams())) as {
            thread: { id: string; path?: unknown };
            instructionSources?: unknown;
          };
          this.threadId = threadResult.thread.id;
          threadLifecycle = "thread_start";
          threadInstructionResult = threadResult;
          runtimeReasoningEffort = readCodexReasoningEffortReport(threadResult);
        }
      } else {
        // Start a new thread
        const threadResult = (await this.transport.call("thread/start", this.buildThreadParams())) as {
          thread: { id: string; path?: unknown };
          instructionSources?: unknown;
        };
        this.threadId = threadResult.thread.id;
        threadInstructionResult = threadResult;
        runtimeReasoningEffort = readCodexReasoningEffortReport(threadResult);
      }

      this.connected = true;
      this.nativeSubagents.setRootProviderThreadId(this.threadId);

      const instructionSnapshot = await captureCodexInstructionSnapshot({
        threadId: this.threadId,
        capturedAt: Date.now(),
        lifecycle: threadLifecycle,
        instructionSources: threadInstructionResult?.instructionSources,
        rolloutPath: threadInstructionResult?.thread.path,
        instructionContext: this.options.instructionContext,
        developerInstructions: this.options.instructions,
      });
      if (!this.connected || !this.transport.isConnected()) return;
      this.initialized = true;
      // Notify session metadata. Codex's thread response is the authority for
      // which AGENTS.md files actually entered this thread's instruction chain.
      this.sessionMetaCb?.({
        cliSessionId: this.threadId,
        model: this.options.model,
        cwd: this.options.cwd,
        resumeSnapshot,
        instructionSnapshot,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "codex",
        model: this.options.model || "",
        codex_service_tier: normalizeCodexServiceTier(this.options.serviceTier),
        codex_goal: null,
        codex_goal_capability: CODEX_GOAL_UNKNOWN_CAPABILITY,
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: this.options.approvalMode || "suggest",
        ...(this.options.uiMode ? { uiMode: this.options.uiMode } : {}),
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [...CODEX_LOCAL_SLASH_COMMANDS],
        skills: [],
        skill_metadata: [],
        apps: [],
        skills_stale: false,
        apps_stale: false,
        skills_stale_since: null,
        skills_last_changed_at: null,
        skills_last_change_reason: null,
        skills_change_count: 0,
        total_cost_usd: 0,
        user_turn_count: 0,
        agent_turn_count: 0,
        num_turns: 0,
        context_used_percent: 0,
        codex_retained_payload_bytes: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        ...(this.options.reasoningEffort ? { codex_reasoning_effort: this.options.reasoningEffort } : {}),
        ...codexEffectiveReasoningEffortPatch(runtimeReasoningEffort),
      };

      this.emit({ type: "session_init", session: state });

      // Fetch initial rate limits — await so the RPC completes before flushing
      // queued messages. Without this, a concurrent rateLimits write and
      // turn/start write can interleave on the shared stdin pipe.
      try {
        const rateLimitsResult = await this.transport.call("account/rateLimits/read", {});
        this.updateRateLimits(rateLimitsResult as Record<string, unknown>);
      } catch {
        /* best-effort — don't fail init if rate limits fetch errors */
      }

      // Flush any messages that were queued during initialization
      if (this.pendingOutgoing.length > 0) {
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
        this.drainPendingInitialMcpToolAvailabilityRefresh();
      }

      this.scheduleInitialSkillMetadataRefresh();
      this.nativeSubagents.requestDiscovery();
    } catch (err) {
      const errorMsg = formatCodexInitializationError(err, this.options.failureContextProvider?.());
      console.error(`[codex-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      // Discard any messages queued during the failed init attempt
      this.pendingOutgoing.length = 0;
      for (const cb of this.initErrorCbs) {
        try {
          cb(errorMsg);
        } catch (callbackErr) {
          console.error("[codex-adapter] init-error listener failed:", callbackErr);
        }
      }
    }
  }

  // ── Outgoing message handlers ───────────────────────────────────────────

  private async handleOutgoingUserMessage(msg: {
    type: "user_message";
    content: string;
    images?: { media_type: string; data: string }[];
    vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
  }): Promise<void> {
    // User message is the latest completed message before Codex starts reasoning.
    this.itemEventManager.markMessageFinished(Date.now());
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }

    // If a turn is already in progress, interrupt it first and wait for it to
    // complete. Sending turn/start while a turn is active causes Codex to
    // error or crash (observed as sudden disconnects, especially with image
    // attachments whose large base64 payloads amplify the timing window).
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Turn ${this.currentTurnId} already in progress for session ${this.sessionId}, interrupting before new turn`,
      );
      await this.interruptAndWaitForTurnEnd();
    }

    await this.runInitialMcpToolAvailabilityRefreshIfIdle("before_user_turn");

    // VS Code selection metadata is ambient UI context, not explicit user
    // content. A plain /compact must still reach Codex's compaction endpoint
    // even when the composer attached selection metadata to the turn.
    if (isCompactSlashCommand(msg.content) && !msg.images?.length) {
      this.itemEventManager.markNextCompactionCause("manual");
      try {
        await this.transport.call("thread/compact/start", {
          threadId: this.threadId,
        });
        return;
      } catch (err) {
        this.itemEventManager.clearNextCompactionCause("manual");
        const requeued = handleCodexTurnStartDispatchFailure(this.turnStartFailedCb, msg, err);
        if (requeued && isCodexTransportClosedError(err)) {
          console.warn(
            `[codex-adapter] thread/compact/start transport closed; message re-queued for session ${this.sessionId}`,
          );
          return;
        }
        this.emit({ type: "error", message: `Failed to start compaction: ${err}` });
        return;
      }
    }

    const input: Array<{
      type: string;
      name?: string;
      text?: string;
      url?: string;
      path?: string;
      text_elements?: unknown[];
    }> = [];

    // Backend delivery is text-only. Any image payload that still reaches the
    // adapter is ignored defensively; the prompt should already contain file
    // path annotations that the model can read as normal files.
    if (msg.images?.length) {
      console.warn(
        `[codex-adapter] Ignoring unexpected image payloads for session ${this.sessionId}; expected text-only attachment path annotations`,
      );
    }

    // Add text
    input.push({ type: "text", text: msg.content, text_elements: [] });
    input.push(...extractCodexMentionInputs(msg.content, this.skillPathByName));
    if (msg.vscodeSelection) {
      input.push({ type: "text", text: formatVsCodeSelectionPrompt(msg.vscodeSelection), text_elements: [] });
    }

    // Log when payload is large (images, long prompts) to help diagnose
    // transport issues — Codex reads JSON-RPC from stdin, so huge lines
    // can cause event loop blocks and process crashes.
    const estimatedChars = input.reduce(
      (sum, i) => sum + (i.name?.length || 0) + (i.url?.length || 0) + (i.path?.length || 0) + (i.text?.length || 0),
      0,
    );
    if (estimatedChars > 500_000) {
      console.warn(
        `[codex-adapter] Large turn/start payload: ~${(estimatedChars / 1024).toFixed(0)}KB for session ${this.sessionId}`,
      );
    }

    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
      serviceTier: normalizeCodexServiceTier(this.options.serviceTier),
    };
    if (this.options.reasoningSummary) {
      turnStartParams.summary = this.options.reasoningSummary;
    }
    const collaborationMode = this.collaborationModeSupported
      ? buildCodexCollabMode(this.options, getDefaultModelForBackend("codex"), CodexAdapter.VALID_REASONING_EFFORTS)
      : null;
    if (collaborationMode) {
      turnStartParams.collaborationMode = collaborationMode;
    }

    try {
      const result = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
        turn: { id: string };
      };
      this.handleTurnStartAcknowledged(result.turn.id, null);
    } catch (err) {
      // Older Codex builds may reject collaborationMode. If so, retry once
      // without it and remember to skip it for future turns.
      if (collaborationMode && isCodexCollaborationModeUnsupportedError(err)) {
        this.collaborationModeSupported = false;
        delete turnStartParams.collaborationMode;
        console.warn(`[codex-adapter] collaborationMode not supported; falling back for session ${this.sessionId}`);
        try {
          const retry = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
            turn: { id: string };
          };
          this.handleTurnStartAcknowledged(retry.turn.id, null);
          return;
        } catch (retryErr) {
          const serviceTierRetry = await this.retryTurnStartWithoutServiceTier(turnStartParams, retryErr);
          if (serviceTierRetry) {
            this.handleTurnStartAcknowledged(serviceTierRetry, null);
            return;
          }
          const requeued = handleCodexTurnStartDispatchFailure(this.turnStartFailedCb, msg, retryErr);
          if (requeued && isRecoverableCodexTurnStartError(retryErr)) {
            console.warn(
              `[codex-adapter] turn/start did not acknowledge; message re-queued for session ${this.sessionId}: ${retryErr}`,
            );
            return;
          }
          this.emit({ type: "error", message: `Failed to start turn: ${retryErr}` });
          return;
        }
      }

      const serviceTierRetry = await this.retryTurnStartWithoutServiceTier(turnStartParams, err);
      if (serviceTierRetry) {
        this.handleTurnStartAcknowledged(serviceTierRetry, null);
        return;
      }
      const requeued = handleCodexTurnStartDispatchFailure(this.turnStartFailedCb, msg, err);
      if (requeued && isRecoverableCodexTurnStartError(err)) {
        console.warn(
          `[codex-adapter] turn/start did not acknowledge; message re-queued for session ${this.sessionId}: ${err}`,
        );
        return;
      }
      this.emit({ type: "error", message: `Failed to start turn: ${err}` });
    }
  }

  private async handleOutgoingPendingBatchStart(
    msg: Extract<BrowserOutgoingMessage, { type: "codex_start_pending" }>,
  ): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Turn ${this.currentTurnId} already in progress for session ${this.sessionId}, interrupting before pending batch start`,
      );
      await this.interruptAndWaitForTurnEnd();
    }

    const input = buildCodexBatchInput(msg.inputs, formatVsCodeSelectionPrompt);
    const clientUserMessageId = resolveCodexClientUserMessageId(msg);
    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
      serviceTier: normalizeCodexServiceTier(this.options.serviceTier),
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    };
    if (this.options.reasoningSummary) {
      turnStartParams.summary = this.options.reasoningSummary;
    }
    const collaborationMode = this.collaborationModeSupported
      ? buildCodexCollabMode(this.options, getDefaultModelForBackend("codex"), CodexAdapter.VALID_REASONING_EFFORTS)
      : null;
    if (collaborationMode) turnStartParams.collaborationMode = collaborationMode;

    try {
      const result = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
        turn: { id: string };
      };
      this.handleTurnStartAcknowledged(result.turn.id, clientUserMessageId);
    } catch (err) {
      if (collaborationMode && isCodexCollaborationModeUnsupportedError(err)) {
        this.collaborationModeSupported = false;
        delete turnStartParams.collaborationMode;
        try {
          const retry = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
            turn: { id: string };
          };
          this.handleTurnStartAcknowledged(retry.turn.id, clientUserMessageId);
          return;
        } catch (retryErr) {
          const serviceTierRetry = await this.retryTurnStartWithoutServiceTier(turnStartParams, retryErr);
          if (serviceTierRetry) {
            this.handleTurnStartAcknowledged(serviceTierRetry, clientUserMessageId);
            return;
          }
          const requeued = handleCodexTurnStartDispatchFailure(this.turnStartFailedCb, msg, retryErr);
          if (requeued && isRecoverableCodexTurnStartError(retryErr)) return;
          this.emit({ type: "error", message: `Failed to start pending Codex batch: ${retryErr}` });
          return;
        }
      }
      const serviceTierRetry = await this.retryTurnStartWithoutServiceTier(turnStartParams, err);
      if (serviceTierRetry) {
        this.handleTurnStartAcknowledged(serviceTierRetry, clientUserMessageId);
        return;
      }
      const requeued = handleCodexTurnStartDispatchFailure(this.turnStartFailedCb, msg, err);
      if (requeued && isRecoverableCodexTurnStartError(err)) return;
      this.emit({ type: "error", message: `Failed to start pending Codex batch: ${err}` });
    }
  }

  private async handleOutgoingPendingBatchSteer(
    msg: Extract<BrowserOutgoingMessage, { type: "codex_steer_pending" }>,
  ): Promise<void> {
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }
    const input = buildCodexBatchInput(msg.inputs, formatVsCodeSelectionPrompt);
    const clientUserMessageId = resolveCodexClientUserMessageId(msg);
    try {
      const result = (await this.transport.call("turn/steer", {
        threadId: this.threadId,
        input,
        expectedTurnId: msg.expectedTurnId,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      })) as { turnId: string };
      this.turnSteeredCb?.(result.turnId, msg.pendingInputIds, clientUserMessageId ?? undefined);
      this.userMessageReceiptObserver.acknowledge(clientUserMessageId);
    } catch (err) {
      const failure = classifyCodexTurnSteerFailure(msg.expectedTurnId, this.currentTurnId, err);
      const recoveredStaleTurn =
        failure.kind === "active_turn_mismatch" ||
        (failure.kind === "no_active_turn" && this.recoverStaleTurnSteerFailure(msg.expectedTurnId));
      if (msg.clientUserMessageId) {
        this.turnSteerFailedCb?.(msg.pendingInputIds, failure, msg.clientUserMessageId);
      } else {
        this.turnSteerFailedCb?.(msg.pendingInputIds, failure);
      }
      if (failure.kind === "active_turn_mismatch") {
        this.reconcileActiveTurnMismatch(msg.expectedTurnId, failure.foundTurnId);
      }
      if (recoveredStaleTurn) return;
      this.emit({ type: "error", message: `Failed to steer active Codex turn: ${err}` });
    }
  }

  private reconcileActiveTurnMismatch(expectedTurnId: string, foundTurnId: string): void {
    console.log(
      `[codex-adapter] Codex reported active turn ${foundTurnId} while steering stale turn ${expectedTurnId}; ` +
        `reconciling current turn for session ${this.sessionId}`,
    );
    this.currentTurnId = foundTurnId;
  }

  private recoverStaleTurnSteerFailure(expectedTurnId: string): boolean {
    if (this.currentTurnId && this.currentTurnId !== expectedTurnId) return false;

    this.retiredTurnIds.add(expectedTurnId);
    if (this.retiredTurnIds.size > 32) {
      this.retiredTurnIds.delete(this.retiredTurnIds.values().next().value!);
    }

    if (this.currentTurnId === expectedTurnId) {
      console.log(
        `[codex-adapter] Codex rejected turn/steer for stale turn ${expectedTurnId}; clearing current turn for session ${this.sessionId}`,
      );
      this.currentTurnId = null;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this.drainPendingInitialSkillMetadataRefresh();
      this.drainPendingInitialMcpToolAvailabilityRefresh();
      if (this.emitCompletedResultForHandledWriteStdinRouterError(expectedTurnId)) {
        return true;
      }
      const routerError = this.toolRouterErrorByTurnId.get(expectedTurnId);
      if (routerError) {
        this.toolRouterErrorByTurnId.delete(expectedTurnId);
        this.suppressedTurnResultIds.add(expectedTurnId);
        this.emitTurnResult({
          turnId: expectedTurnId,
          status: "failed",
          errorMessage: routerError,
        });
      }
    } else {
      console.log(
        `[codex-adapter] Codex rejected turn/steer for already-cleared turn ${expectedTurnId}; suppressing stale steer error for session ${this.sessionId}`,
      );
    }

    return true;
  }

  private async handleOutgoingPermissionResponse(msg: {
    type: "permission_response";
    request_id: string;
    behavior: "allow" | "deny";
    updated_input?: Record<string, unknown>;
  }): Promise<void> {
    await this.approvalManager.handleOutgoingPermissionResponse(msg);
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;

    try {
      await this.transport.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      console.warn("[codex-adapter] Interrupt failed:", err);
    }
  }

  /**
   * Interrupt the current turn and wait for it to end (turn/completed
   * notification clears `currentTurnId`). Times out after 5s to avoid
   * hanging indefinitely if Codex never sends turn/completed.
   */
  private async interruptAndWaitForTurnEnd(): Promise<void> {
    await this.handleOutgoingInterrupt();

    if (!this.currentTurnId) return; // Already cleared

    const TIMEOUT_MS = 5_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this resolver so handleTurnCompleted doesn't call stale fn
        const idx = this.turnEndResolvers.indexOf(onEnd);
        if (idx >= 0) this.turnEndResolvers.splice(idx, 1);
        if (this.currentTurnId) {
          console.warn(
            `[codex-adapter] Turn ${this.currentTurnId} did not complete within ${TIMEOUT_MS}ms after interrupt for session ${this.sessionId}, proceeding anyway`,
          );
          this.currentTurnId = null;
          this.drainPendingInitialSkillMetadataRefresh();
          this.drainPendingInitialMcpToolAvailabilityRefresh();
        }
        resolve();
      }, TIMEOUT_MS);

      const onEnd = () => {
        clearTimeout(timer);
        resolve();
      };
      this.turnEndResolvers.push(onEnd);
    });
  }

  // ── Incoming notification handlers ──────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Verbose per-notification logging removed — use protocol recordings for debugging.
    const nativeDisposition = this.nativeSubagents.observeNotification(method, params);

    try {
      if (nativeDisposition.finishReasoningTurnId) {
        this.itemEventManager.finishReasoningTurn(nativeDisposition.finishReasoningTurnId);
      }
      if (nativeDisposition.suppressDefault) return;
      switch (method) {
        case "item/started":
          this.userMessageReceiptObserver.observe(params);
          this.itemEventManager.handleItemStarted(params);
          break;
        case "codex/event/patch_apply_begin":
        case "codex/event/patch_apply_end":
          this.itemEventManager.cachePatchApplyChanges(params);
          break;
        case "item/agentMessage/delta":
          this.itemEventManager.handleAgentMessageDelta(params);
          break;
        case "item/commandExecution/outputDelta":
          // Streaming command output — emit as tool_progress so the browser
          // can render live elapsed time and incremental terminal output.
          this.itemEventManager.emitCommandProgress(params);
          break;
        case "item/commandExecution/terminalInteraction":
          this.itemEventManager.handleTerminalInteraction(params);
          break;
        case "item/fileChange/outputDelta":
          // Streaming file change output. Same as above.
          break;
        case "item/reasoning/summaryTextDelta":
          this.itemEventManager.handleReasoningSummaryDelta(params);
          break;
        case "item/reasoning/summaryPartAdded":
          this.itemEventManager.handleReasoningSummaryPartAdded(params);
          break;
        case "item/reasoning/textDelta":
          // Raw reasoning content is not an official summary and must not be displayed.
          break;
        case "item/mcpToolCall/progress": {
          // MCP tool call progress — map to tool_progress
          const itemId = params.itemId as string | undefined;
          const threadId = params.threadId as string | undefined;
          if (itemId) {
            this.emit({
              type: "tool_progress",
              tool_use_id: itemId,
              tool_name: "mcp_tool_call",
              elapsed_time_seconds: 0,
            });
          }
          break;
        }
        case "item/plan/delta":
          this.itemEventManager.emitPlanTodoWrite(params, "item_plan_delta");
          break;
        case "item/updated":
          this.itemEventManager.handleItemUpdated(params);
          break;
        case "item/completed":
          this.userMessageReceiptObserver.observe(params);
          this.itemEventManager.handleItemCompleted(params);
          break;
        case "rawResponseItem/completed":
          this.itemEventManager.handleRawResponseItemCompleted(params);
          break;
        case "turn/started":
          this.handleTurnStarted(params);
          break;
        case "turn/completed":
          this.handleTurnCompleted(params);
          break;
        case "turn/plan/updated":
          this.itemEventManager.emitPlanTodoWrite(params, "turn_plan_updated");
          break;
        case "codex/event/task_complete":
          this.itemEventManager.handleSubagentTaskComplete(params);
          break;
        case "turn/diff/updated":
          // Could show diff, but not needed for MVP
          break;
        case "thread/started":
          // Thread started after init — nothing to emit.
          break;
        case "thread/status/changed":
          this.handleThreadStatusChanged(params);
          break;
        case "thread/settings/updated":
          this.emit({ type: "session_update", session: buildCodexEffectiveReasoningEffortPatch(params) });
          break;
        case "thread/tokenUsage/updated":
          this.handleTokenUsageUpdated(params);
          break;
        case "thread/goal/updated":
          this.handleGoalUpdated(params);
          break;
        case "thread/goal/cleared":
          this.handleGoalCleared(params);
          break;
        case "account/updated":
        case "account/login/completed":
          // Auth events
          break;
        case "account/rateLimits/updated":
          this.updateRateLimits(params);
          break;
        case "skills/changed":
          this._markSkillsChanged(params);
          break;
        case "app/list/updated":
          this.emit({
            type: "session_update",
            session: {
              apps: extractCodexAppsPage(params).apps,
            },
          });
          break;
        case "mcpServer/startupStatus/updated":
          this.mcpManager.handleStartupStatusUpdated(params);
          if (isTakodeDelegateStartupReady(params)) {
            this.scheduleInitialMcpToolAvailabilityRefresh();
          }
          break;
        case "codex/event/stream_error": {
          const msg = params.msg as { message?: string } | undefined;
          if (msg?.message) {
            console.log(`[codex-adapter] Stream error: ${msg.message}`);
          }
          break;
        }
        case "codex/event/error": {
          const msg = params.msg as { message?: string } | undefined;
          if (msg?.message) {
            console.error(`[codex-adapter] Codex error: ${msg.message}`);
            this.handleToolRouterFailureMessage(msg.message);
          }
          break;
        }
        default:
          // Unknown notification, log for debugging
          // Silently ignore — protocol recordings capture all messages for debugging.
          break;
      }
    } catch (err) {
      console.error(`[codex-adapter] Error handling notification ${method}:`, err);
    } finally {
      this.nativeSubagents.clearNotificationContext();
    }
  }

  // ── Incoming request handlers (approval requests) ───────────────────────

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      this.approvalManager.handleRequest(method, id, params);
    } catch (err) {
      console.error(`[codex-adapter] Error handling request ${method}:`, err);
    }
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const status = params.status as Record<string, unknown> | undefined;
    if (!status) return;
    const threadId = getCodexThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;

    if (status.type === "idle" && this.currentTurnId) {
      const staleTurnId = this.currentTurnId;
      console.log(
        `[codex-adapter] Thread reported idle while currentTurnId=${staleTurnId} is set; clearing stale turn for session ${this.sessionId}`,
      );
      this.currentTurnId = null;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      this.drainPendingInitialSkillMetadataRefresh();
      this.drainPendingInitialMcpToolAvailabilityRefresh();
      if (this.emitCompletedResultForHandledWriteStdinRouterError(staleTurnId)) {
        return;
      }
      const routerError = this.toolRouterErrorByTurnId.get(staleTurnId);
      if (routerError) {
        this.toolRouterErrorByTurnId.delete(staleTurnId);
        this.suppressedTurnResultIds.add(staleTurnId);
        this.emitTurnResult({
          turnId: staleTurnId,
          status: "failed",
          errorMessage: routerError,
        });
      }
    }
  }

  private handleTurnStarted(params: Record<string, unknown>): void {
    const turn = params.turn as { id?: unknown } | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId) return;
    if (this.retiredTurnIds.has(turnId)) return;
    const threadId = getCodexThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    if (this.currentTurnId === turnId) return;
    if (this.currentTurnId) return;
    this.currentTurnId = turnId;
    this.turnStartedCb?.(turnId, "codex_goal_continuation");
  }

  private handleGoalUpdated(params: Record<string, unknown>): void {
    const goal = normalizeCodexGoal(params.goal ?? params.threadGoal ?? params);
    if (!goal) return;
    if (this.threadId && goal.threadId !== this.threadId) return;
    this.emit({
      type: "session_update",
      session: {
        ...codexGoalStatePatch(goal),
        ...codexGoalCapabilityPatch("supported"),
      },
    });
  }

  private handleGoalCleared(params: Record<string, unknown>): void {
    const threadId = getCodexThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    this.emit({
      type: "session_update",
      session: {
        ...codexGoalStatePatch(null),
        ...codexGoalCapabilityPatch("supported"),
      },
    });
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as { id: string; status: string; error?: { message: string } } | undefined;
    const threadId = getCodexThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) {
      return;
    }

    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (turnId) {
      this.toolRouterErrorByTurnId.delete(turnId);
      this.itemEventManager.finishReasoningTurn(turnId);
      const ignoreStaleCompletion = !!this.currentTurnId && this.currentTurnId !== turnId;
      if (ignoreStaleCompletion) {
        this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
        this.suppressedWriteStdinRouterCompletionByTurnId.delete(turnId);
        this.suppressedTurnResultIds.delete(turnId);
        console.log(
          `[codex-adapter] Ignoring stale completion for turn ${turnId} while current turn is ${this.currentTurnId ?? "none"} in session ${this.sessionId}`,
        );
        return;
      }
    }
    this.currentTurnId = null;
    // Wake any callers waiting for the turn to end (e.g. interruptAndWaitForTurnEnd)
    for (const resolve of this.turnEndResolvers.splice(0)) resolve();
    this.drainPendingInitialSkillMetadataRefresh();
    this.drainPendingInitialMcpToolAvailabilityRefresh();
    this.nativeSubagents.drainDiscovery();

    if (turnId && this.suppressedTurnResultIds.delete(turnId)) {
      this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
      this.suppressedWriteStdinRouterCompletionByTurnId.delete(turnId);
      return;
    }

    if (turnId) {
      const suppressedWriteStdinRouterError = this.suppressedWriteStdinRouterCompletionByTurnId.get(turnId);
      if (suppressedWriteStdinRouterError) {
        this.suppressedWriteStdinRouterCompletionByTurnId.delete(turnId);
        this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
        if (
          !turn?.error?.message ||
          this.isSameWriteStdinRouterFailure(turn.error.message, suppressedWriteStdinRouterError)
        ) {
          return;
        }
      }

      const handledWriteStdinRouterError = this.handledWriteStdinRouterErrorByTurnId.get(turnId);
      if (
        handledWriteStdinRouterError &&
        this.isSameWriteStdinRouterFailure(turn?.error?.message, handledWriteStdinRouterError)
      ) {
        this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
        this.emitTurnResult({
          turnId,
          status: "completed",
        });
        return;
      }
      this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
    }

    // Always emit a result — even for interrupted turns — so the server
    // transitions to idle. For internal interrupts (new message while a turn
    // was active), the next turn/start will immediately set generating=true
    // again, so the brief idle flash is imperceptible.
    this.emitTurnResult({
      turnId,
      status: turn?.status || "end_turn",
      errorMessage: turn?.error?.message,
    });
  }

  private emitCompletedResultForHandledWriteStdinRouterError(turnId: string): boolean {
    const handledMessage = this.handledWriteStdinRouterErrorByTurnId.get(turnId);
    if (!handledMessage) return false;
    this.suppressedWriteStdinRouterCompletionByTurnId.set(turnId, handledMessage);
    this.handledWriteStdinRouterErrorByTurnId.delete(turnId);
    this.toolRouterErrorByTurnId.delete(turnId);
    this.emitTurnResult({
      turnId,
      status: "completed",
    });
    return true;
  }

  private isSameWriteStdinRouterFailure(errorMessage: string | undefined, handledMessage: string): boolean {
    if (!errorMessage) return false;
    const normalizedError = errorMessage.trim();
    const normalizedHandled = handledMessage.trim();
    return normalizedError === normalizedHandled || normalizedError.includes(normalizedHandled);
  }

  private emitTurnResult(args: { turnId?: string | null; status: string; errorMessage?: string }): void {
    const isSuccess = args.status === "completed" || args.status === "interrupted";
    const result: CLIResultMessage = {
      type: "result",
      subtype: isSuccess ? "success" : "error_during_execution",
      is_error: !isSuccess,
      result: args.errorMessage,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: args.status,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...(typeof args.turnId === "string" ? { codex_turn_id: args.turnId } : {}),
      ...(() => {
        const context = providerFailureContextForResult(this.providerFailureEvidence, args.errorMessage);
        return context ? { codex_provider_failure_context: context } : {};
      })(),
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    if (isSuccess) {
      clearCodexProviderFailureEvidence(this.providerFailureEvidence);
    }
    this.emit({ type: "result", data: result });
  }

  private handleToolRouterFailureMessage(message: string): void {
    const isToolRouterFailure = isToolRouterFailureMessage(message);
    const routerFailureToolName = getRouterFailureToolName(message);
    const renderedAsToolResult = isToolRouterFailure
      ? this.itemEventManager.handleToolRouterError(
          message,
          routerFailureToolName ?? undefined,
          this.currentTurnId ?? undefined,
        )
      : false;
    if (this.currentTurnId && isToolRouterFailure) {
      if (renderedAsToolResult && routerFailureToolName === "write_stdin") {
        this.handledWriteStdinRouterErrorByTurnId.set(this.currentTurnId, message);
        this.toolRouterErrorByTurnId.delete(this.currentTurnId);
      } else {
        this.handledWriteStdinRouterErrorByTurnId.delete(this.currentTurnId);
        this.toolRouterErrorByTurnId.set(this.currentTurnId, message);
      }
    }
    if (!renderedAsToolResult) {
      this.emit({ type: "error", message });
    }
  }

  private extractWriteStdinRouterFailuresFromStderrChunk(text: string): string[] {
    if (!text) return [];
    this.processStderrLineBuffer += text;
    const lines = this.processStderrLineBuffer.split(/\r?\n/);
    this.processStderrLineBuffer = lines.pop() ?? "";
    if (this.processStderrLineBuffer.length > STDERR_ROUTER_LINE_BUFFER_MAX) {
      this.processStderrLineBuffer = this.processStderrLineBuffer.slice(-STDERR_ROUTER_LINE_BUFFER_MAX);
    }

    const messages: string[] = [];
    for (const line of lines) {
      const message = this.extractWriteStdinRouterFailureFromStderrLine(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private extractWriteStdinRouterFailureFromStderrLine(line: string): string | null {
    const normalized = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!normalized.includes("codex_core::tools::router")) return null;
    const match = normalized.match(/\berror\s*=\s*(write_stdin failed:.*)$/i);
    return match?.[1]?.trim() || null;
  }

  private updateRateLimits(data: Record<string, unknown>): void {
    this._rateLimits = updateCodexRateLimits(data, this.rateLimitsByLimitId);
    if (!this._rateLimits) return;
    this.emit({
      type: "session_update",
      session: {
        codex_rate_limits: {
          primary: this._rateLimits.primary,
          secondary: this._rateLimits.secondary,
        },
      },
    });
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    const threadId = getCodexThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    const updates = buildCodexTokenUsagePatch(params);
    if (Object.keys(updates).length > 0) {
      this.emit({
        type: "session_update",
        session: updates,
      });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    const source = this.nativeSubagents.getCurrentMessageSource();
    if (source && this.nativeSubagents.emitOwnedBrowserMessage(msg, source)) return;
    this.browserMessageCb?.(msg);
  }

  private handleTurnStartAcknowledged(turnId: string, clientUserMessageId: string | null): void {
    this.currentTurnId = turnId;
    this.turnStartedCb?.(turnId);
    this.userMessageReceiptObserver.acknowledge(clientUserMessageId);
  }

  private buildThreadParams(extra?: Record<string, unknown>): Record<string, unknown> {
    const params: Record<string, unknown> = {
      ...extra,
      model: this.options.model,
      cwd: this.options.cwd,
    };
    const approvalPolicy = mapCodexApprovalPolicy(this.options.approvalMode, this.options.askPermission);
    const sandbox = this.options.sandbox ?? mapCodexSandboxPolicy(this.options.approvalMode);
    if (approvalPolicy) params.approvalPolicy = approvalPolicy;
    if (sandbox) params.sandbox = sandbox;
    return params;
  }

  private shouldFallbackServiceTier(err: unknown): boolean {
    return (
      !!normalizeCodexServiceTier(this.options.serviceTier) &&
      !isRecoverableCodexTurnStartError(err) &&
      isCodexServiceTierRejection(err)
    );
  }

  private async retryTurnStartWithoutServiceTier(
    turnStartParams: Record<string, unknown>,
    err: unknown,
  ): Promise<string | null> {
    const failedTier = normalizeCodexServiceTier(this.options.serviceTier);
    if (!failedTier || !this.shouldFallbackServiceTier(err)) return null;

    this.options.serviceTier = null;
    turnStartParams.serviceTier = null;
    this.emit({
      type: "session_update",
      session: { codex_service_tier: null },
    });
    this.emit({
      type: "error",
      message: `Codex service tier "${failedTier}" was rejected; falling back to Standard for this turn.`,
    });

    try {
      const retry = (await this.transport.call("turn/start", turnStartParams, TURN_START_ACK_TIMEOUT_MS)) as {
        turn: { id: string };
      };
      return retry.turn.id;
    } catch (retryErr) {
      console.warn(
        `[codex-adapter] Standard fallback after service-tier rejection also failed for session ${this.sessionId}:`,
        retryErr,
      );
      return null;
    }
  }
}
