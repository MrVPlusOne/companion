import { useEffect, useRef, useMemo, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import {
  GitHubPRSection,
  McpCollapsible,
  ClaudeMdCollapsible,
  CodexInstructionsCollapsible,
  HerdDiagnosticsSection,
  SectionHeader,
  SystemPromptCollapsible,
  usePersistedCollapse,
} from "./TaskPanel.js";
import {
  formatModel,
  getCodexReasoningEffortOptions,
  getModelsForBackend,
  toModelOptions,
  type ModelOption,
} from "../utils/backends.js";
import { buildCodexReasoningAuthorityDisplay } from "../utils/codex-reasoning-display.js";
import type { SessionViewModel } from "../utils/session-view-model.js";
import { resolveSessionNavigation } from "../utils/session-navigation-resolver.js";
import { navigateTo } from "../utils/navigation.js";
import { sendToSession } from "../ws.js";
import { CompactSessionLink } from "./CompactSessionLink.js";
import { SessionPathSummary } from "./SessionPathSummary.js";
import { SessionContextStats, SessionPayloadStats } from "./SessionPayloadStats.js";
import { api, type SessionDirectoryOpenTarget } from "../api.js";
import type { CodexContextWindowDiagnostics, SdkSessionInfo, SessionLifecycleEvent } from "../types.js";
import { LeaderProfilePortraitButton } from "./LeaderProfilePortraitButton.js";
import { getRecoverableSessionConnectionPresentation } from "../utils/recoverable-session-connection.js";
import { formatContextWindowLabel } from "../utils/token-format.js";
import { isCodexLeaderRecycleMode } from "../../shared/codex-leader-compaction-mode.js";

const POPOVER_MARGIN = 12;
const POPOVER_GAP = 8;
const POPOVER_WIDTH = 390;
const POPOVER_MIN_HEIGHT = 180;

interface SessionDetailState {
  key: string;
  status: "loading" | "loaded" | "failed";
  detail: SdkSessionInfo | null;
}

function mergeModelOptions(backendType: "claude" | "codex", dynamicModels: ModelOption[], currentModel: string) {
  const merged = [...dynamicModels, ...getModelsForBackend(backendType)].filter((option) => option.value);
  if (currentModel && !merged.some((option) => option.value === currentModel)) {
    merged.unshift({ value: currentModel, label: currentModel, icon: "" });
  }
  const seen = new Set<string>();
  return merged.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

export function SessionInfoPopover({
  sessionId,
  onClose,
  anchorElement,
  onConfigure,
}: {
  sessionId: string;
  onClose: () => void;
  anchorElement?: HTMLElement | null;
  onConfigure?: (sessionId: string) => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const session = sessions.get(sessionId);
  const sdkSession = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const sdkSessions = useStore((s) => s.sdkSessions);
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const resolvedNavigation = useStore((s) => resolveSessionNavigation(s, sessionId));
  const sessionVm = resolvedNavigation?.viewModel ?? null;
  const cwd = sessionVm?.cwd ?? null;
  const model = sessionVm?.model ?? "";
  const backendType = sessionVm?.backendType ?? "claude";
  const popoverRef = useRef<HTMLDivElement>(null);
  const taskHistoryScrollRef = useRef<HTMLDivElement>(null);

  // Stats
  const turns = sessionVm?.numTurns ?? 0;
  const historyBytes = sessionVm?.messageHistoryBytes ?? 0;
  const codexRetainedPayloadBytes = sessionVm?.codexRetainedPayloadBytes ?? 0;
  const isCodexSession = backendType === "codex";

  // Git
  const gitBranch = sessionVm?.gitBranch ?? null;
  const isWorktree = sessionVm?.isWorktree ?? false;
  const gitAhead = sessionVm?.gitAhead ?? 0;
  const gitBehind = sessionVm?.gitBehind ?? 0;
  const linesAdded = sessionVm?.totalLinesAdded ?? 0;
  const linesRemoved = sessionVm?.totalLinesRemoved ?? 0;
  const diffStatsSkippedReason = sessionVm?.diffStatsSkippedReason ?? null;

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const targetEl = e.target instanceof Element ? e.target : null;
      if (
        targetEl?.closest("[data-claude-md-editor-root='true']") ||
        targetEl?.closest("[data-session-info-modal='true']") ||
        targetEl?.closest("[data-leader-profile-portrait-picker='true']")
      ) {
        return;
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Keep task history anchored to newest entry so long histories open at the latest item.
  useEffect(() => {
    const container = taskHistoryScrollRef.current;
    if (!container || !taskHistory || taskHistory.length === 0) return;
    container.scrollTop = container.scrollHeight;
  }, [sessionId, taskHistory]);

  const browserConnectionStatus = useStore((s) => s.connectionStatus.get(sessionId) ?? "disconnected");
  const isConnected = browserConnectionStatus === "connected";
  const cliConnected = resolvedNavigation?.sidebarItem.isConnected ?? sdkSession?.cliConnected ?? false;
  const cliEverConnected = useStore((s) => s.cliEverConnected.get(sessionId) ?? false);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason.get(sessionId) ?? null);
  const serverReachable = useStore((s) => s.serverReachable);
  const codexReasoningEffort = sessionVm?.codexReasoningEffort || "";
  const codexEffectiveReasoningEffort = sessionVm?.codexEffectiveReasoningEffort ?? null;
  const codexEffectiveReasoningEffortReported = sessionVm?.codexEffectiveReasoningEffortReported === true;
  const modelTitle = !isConnected
    ? "Reconnect to Takode to change model"
    : cliConnected
      ? backendType === "codex"
        ? `Model: ${model} (relaunch required)`
        : `Model: ${model} (click to change)`
      : "Applies on resume";
  const modelBackend = backendType === "codex" ? "codex" : "claude";
  const reasoningTitle = !isConnected
    ? "Reconnect to Takode to change reasoning"
    : cliConnected
      ? "Reasoning effort (relaunch required)"
      : "Applies on resume";
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showReasoningDropdown, setShowReasoningDropdown] = useState(false);
  const [openDirectoryError, setOpenDirectoryError] = useState("");
  const [openingDirectoryTarget, setOpeningDirectoryTarget] = useState<SessionDirectoryOpenTarget | null>(null);
  const sessionDetailKey = `${sessionId}:${sessionVm?.pid ?? ""}:${sessionVm?.cliSessionId ?? ""}:${cliConnected ? "connected" : "disconnected"}`;
  const [sdkSessionDetailState, setSdkSessionDetailState] = useState<SessionDetailState>(() => ({
    key: sessionDetailKey,
    status: "loading",
    detail: null,
  }));
  const [dynamicModelOptions, setDynamicModelOptions] = useState<ModelOption[]>([]);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const reasoningDropdownRef = useRef<HTMLDivElement>(null);
  const modelOptions = useMemo(
    () => mergeModelOptions(modelBackend, dynamicModelOptions, model),
    [modelBackend, dynamicModelOptions, model],
  );
  const codexReasoningOptions = getCodexReasoningEffortOptions({
    modelOptions,
    model,
    currentEffort: codexReasoningEffort,
  });
  const selectedCodexModel = modelOptions.find((option) => option.value === model);
  const defaultReasoningValue = selectedCodexModel?.defaultReasoningLevel?.trim().toLowerCase() || "";
  const labelForReasoningEffort = (effort: string) =>
    getCodexReasoningEffortOptions({ modelOptions, model, currentEffort: effort, includeDefault: false }).find(
      (option) => option.value === effort,
    )?.label || effort;
  const reasoningAuthority = buildCodexReasoningAuthorityDisplay({
    requested: codexReasoningEffort,
    effective: codexEffectiveReasoningEffort,
    effectiveReported: codexEffectiveReasoningEffortReported,
    runtimeConnected: cliConnected,
    defaultRequested: defaultReasoningValue,
    defaultRequestedLabel: defaultReasoningValue ? labelForReasoningEffort(defaultReasoningValue) : undefined,
    labelForEffort: labelForReasoningEffort,
  });

  useEffect(() => {
    let cancelled = false;
    const getBackendModels = (api as { getBackendModels?: typeof api.getBackendModels }).getBackendModels;
    if (!getBackendModels) {
      setDynamicModelOptions([]);
      return;
    }
    getBackendModels(backendType)
      .then((models) => {
        if (!cancelled) setDynamicModelOptions(toModelOptions(models));
      })
      .catch(() => {
        if (!cancelled) setDynamicModelOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [backendType]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (reasoningDropdownRef.current && !reasoningDropdownRef.current.contains(e.target as Node)) {
        setShowReasoningDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSdkSessionDetailState({ key: sessionDetailKey, status: "loading", detail: null });
    api
      .getSessionInfo(sessionId)
      .then((detail) => {
        if (!cancelled) setSdkSessionDetailState({ key: sessionDetailKey, status: "loaded", detail });
      })
      .catch(() => {
        if (!cancelled) setSdkSessionDetailState({ key: sessionDetailKey, status: "failed", detail: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionDetailKey, sessionId]);

  const currentSessionDetailState =
    sdkSessionDetailState.key === sessionDetailKey
      ? sdkSessionDetailState
      : ({ key: sessionDetailKey, status: "loading", detail: null } satisfies SessionDetailState);
  const backendLabel = backendType === "codex" ? "Codex" : "Claude";
  const hasGit = gitBranch || gitAhead > 0 || gitBehind > 0 || linesAdded > 0 || linesRemoved > 0;
  const effectiveSdkSession = currentSessionDetailState.detail
    ? { ...sdkSession, ...currentSessionDetailState.detail }
    : sdkSession;
  const codexLeaderCompactionMode = effectiveSdkSession?.codexLeaderCompactionMode;
  const contextStats = getSessionInfoContextStats(sessionVm, codexLeaderCompactionMode);
  const contextPercent = contextStats.contextPercent;
  const contextWindow = contextStats.contextWindow;
  const configuredContextWindow = getConfiguredMaxContextLength(sessionVm);
  const contextWindowTitle = getContextWindowTitle(sessionVm, contextWindow);
  const hasStats =
    turns > 0 || contextPercent > 0 || contextWindow > 0 || historyBytes > 0 || codexRetainedPayloadBytes > 0;
  const codexLeaderRecycleLineage = effectiveSdkSession?.codexLeaderRecycleLineage;
  const codexLeaderRecyclePending = effectiveSdkSession?.codexLeaderRecyclePending;
  const lifecycleEvents = effectiveSdkSession?.sessionLifecycleEvents ?? [];
  const contextWindowDiagnostics = effectiveSdkSession?.codexContextWindowDiagnostics;
  const hasLifecycleDebug =
    lifecycleEvents.length > 0 ||
    !!contextWindowDiagnostics ||
    !!codexLeaderRecyclePending ||
    !!(
      codexLeaderRecycleLineage &&
      (codexLeaderRecycleLineage.cliSessionIds.length > 0 || codexLeaderRecycleLineage.recycleEvents.length > 0)
    );
  const [lifecycleCollapsed, toggleLifecycleCollapsed] = usePersistedCollapse(
    "cc-collapse-session-lifecycle-debug",
    true,
  );
  const taskEntries = (taskHistory ?? []).map((task) => ({
    ...task,
    title: task.title.trim(),
  }));
  const isOrchestrator = resolvedNavigation?.sidebarItem.isOrchestrator ?? effectiveSdkSession?.isOrchestrator ?? false;
  const herdedBy = resolvedNavigation?.sidebarItem.herdedBy ?? effectiveSdkSession?.herdedBy;
  const herdedSessions = useMemo(() => {
    if (!isOrchestrator) return [];
    return sdkSessions.flatMap((sdk) => {
      const resolved = resolveSessionNavigation({ sdkSessions }, sdk.sessionId);
      return resolved?.sidebarItem.herdedBy === sessionId && !resolved.sidebarItem.archived ? [sdk.sessionId] : [];
    });
  }, [isOrchestrator, sdkSessions, sessionId]);
  const leaderSession = useMemo(() => {
    if (isOrchestrator || !herdedBy) return null;
    const leader = sdkSessions.find((sdk) => sdk.sessionId === herdedBy && !sdk.archived);
    return leader?.sessionId ?? herdedBy;
  }, [herdedBy, isOrchestrator, sdkSessions]);
  const directoryDisabledReason = !cwd ? "No working directory is available for this session." : "";
  const canOpenWorkingDirectory = !!cwd;
  const canOpenPathRows = Boolean(sessionVm?.isWorktree && sessionVm.repoRoot && sessionVm.repoRoot !== cwd);
  const recoverableConnectionPresentation = getRecoverableSessionConnectionPresentation({
    backendState: session?.backend_state,
    reconnectProgress: session?.backend_reconnect,
    browserConnectionStatus,
    cliConnected,
    cliEverConnected,
    idlePaused: resolvedNavigation?.sidebarItem.idleKilled ?? cliDisconnectReason === "idle_limit",
    serverReachable,
  });
  const leaderProfilePortrait = isOrchestrator ? effectiveSdkSession?.leaderProfilePortrait : null;
  const popoverStyle = useMemo(() => {
    if (typeof window === "undefined") return undefined;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const anchorRect = anchorElement?.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, Math.max(0, viewportWidth - POPOVER_MARGIN * 2));
    const left = Math.min(
      Math.max(POPOVER_MARGIN, anchorRect?.left ?? viewportWidth - width - POPOVER_MARGIN),
      Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN),
    );
    const candidateTop = (anchorRect?.bottom ?? 44) + POPOVER_GAP;
    const viewportMaxHeight = Math.floor(viewportHeight * 0.8);
    const maxHeight = Math.min(
      viewportMaxHeight,
      Math.max(POPOVER_MIN_HEIGHT, viewportHeight - candidateTop - POPOVER_MARGIN),
    );
    const top = Math.min(
      Math.max(POPOVER_MARGIN, candidateTop),
      Math.max(POPOVER_MARGIN, viewportHeight - maxHeight - POPOVER_MARGIN),
    );
    return { left, top, width, maxHeight } satisfies CSSProperties;
  }, [anchorElement]);

  async function handleOpenSessionDirectory(target: SessionDirectoryOpenTarget) {
    if (!cwd || openingDirectoryTarget) return;
    setOpeningDirectoryTarget(target);
    setOpenDirectoryError("");
    try {
      await api.openSessionDirectory(sessionId, target);
    } catch (error) {
      setOpenDirectoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningDirectoryTarget(null);
    }
  }

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-cc-border bg-cc-card shadow-xl"
      style={popoverStyle}
    >
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-cc-border">
        <span className="text-[12px] font-semibold text-cc-fg">Session Info</span>
        <button
          onClick={onClose}
          className="flex items-center justify-center w-5 h-5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Backend + model + cwd */}
        <div className="px-4 py-2.5 space-y-1.5">
          {leaderProfilePortrait && (
            <div className="flex items-center gap-3 rounded-lg border border-cc-border/60 bg-cc-hover/20 px-2.5 py-2">
              <LeaderProfilePortraitButton
                sessionId={sessionId}
                portrait={leaderProfilePortrait}
                size="lg"
                ariaLabel="Edit leader profile picture"
                title="Edit profile picture"
              />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-cc-fg">{leaderProfilePortrait.label}</div>
                <div className="text-[11px] text-cc-muted">Leader profile</div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-medium ${backendType === "codex" ? "text-blue-500" : "text-[#D97757]"}`}>
              {backendLabel}
            </span>
            {model && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                    disabled={!isConnected}
                    className={`flex items-center gap-0.5 text-[11px] transition-colors select-none ${
                      !isConnected
                        ? "cursor-not-allowed opacity-30 text-cc-muted"
                        : "cursor-pointer text-cc-muted hover:text-cc-fg"
                    }`}
                    title={modelTitle}
                  >
                    <span>{formatModel(model)}</span>
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                  {showModelDropdown && (
                    <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-52 overflow-y-auto rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg">
                      {modelOptions.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => {
                            sendToSession(sessionId, { type: "set_model", model: m.value });
                            setShowModelDropdown(false);
                          }}
                          className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                            m.value === model ? "font-medium text-cc-primary" : "text-cc-fg"
                          }`}
                        >
                          <span className="mr-1.5">{m.icon}</span>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {onConfigure && (
            <button
              type="button"
              data-testid="session-info-configure-session"
              onClick={() => onConfigure(sessionId)}
              className="inline-flex items-center rounded-md border border-cc-border px-2 py-1 text-[11px] font-medium text-cc-fg transition-colors hover:border-cc-primary/40 hover:bg-cc-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
            >
              Configure Session
            </button>
          )}
          {recoverableConnectionPresentation && (
            <div
              className="rounded-lg border border-cc-border/70 bg-cc-hover/20 px-2.5 py-2"
              data-testid="session-info-recoverable-connection"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    recoverableConnectionPresentation.kind === "reconnecting"
                      ? "bg-cc-primary animate-pulse"
                      : "bg-cc-muted"
                  }`}
                  aria-hidden="true"
                />
                <span className="text-[11px] font-medium text-cc-fg">{recoverableConnectionPresentation.label}</span>
              </div>
              <div className="mt-1 text-[11px] leading-snug text-cc-muted">
                {recoverableConnectionPresentation.detail}
              </div>
              <button
                type="button"
                className="mt-2 inline-flex items-center rounded-md border border-cc-border px-2 py-1 text-[11px] font-medium text-cc-fg transition-colors hover:border-cc-primary/40 hover:bg-cc-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
                onClick={() => api.relaunchSession(sessionId).catch(console.error)}
              >
                {recoverableConnectionPresentation.actionLabel}
              </button>
            </div>
          )}
          {isCodexSession && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-cc-muted/60">Reasoning</span>
                <div className="relative" ref={reasoningDropdownRef}>
                  <button
                    onClick={() => setShowReasoningDropdown(!showReasoningDropdown)}
                    disabled={!isConnected}
                    className={`flex items-center gap-0.5 text-[11px] transition-colors select-none ${
                      !isConnected
                        ? "cursor-not-allowed opacity-30 text-cc-muted"
                        : "cursor-pointer text-cc-muted hover:text-cc-fg"
                    }`}
                    title={`${reasoningTitle}. ${reasoningAuthority.title}`}
                  >
                    <span>
                      {codexReasoningOptions.find((x) => x.value === codexReasoningEffort)?.label.toLowerCase() ||
                        "default"}
                    </span>
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                  {showReasoningDropdown && (
                    <div className="absolute left-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg">
                      {codexReasoningOptions.map((effort) => (
                        <button
                          key={effort.value || "default"}
                          onClick={() => {
                            sendToSession(sessionId, { type: "set_codex_reasoning_effort", effort: effort.value });
                            setShowReasoningDropdown(false);
                          }}
                          className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                            effort.value === codexReasoningEffort ? "font-medium text-cc-primary" : "text-cc-fg"
                          }`}
                        >
                          {effort.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {reasoningAuthority.warningLabel && (
                <div
                  data-testid="session-info-reasoning-warning"
                  role="status"
                  className="flex items-start gap-1.5 rounded-md border border-cc-warning/25 bg-cc-warning/10 px-2 py-1.5 text-[10px] leading-snug text-cc-warning"
                  title={reasoningAuthority.title}
                >
                  <span aria-hidden="true" className="shrink-0 font-semibold">
                    !
                  </span>
                  <span>{reasoningAuthority.warningLabel}</span>
                </div>
              )}
            </div>
          )}
          {cwd && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Working Directory</span>
                <button
                  type="button"
                  data-testid="session-info-open-working-directory"
                  className="hidden sm:inline-flex items-center gap-1 rounded-md border border-cc-border px-2 py-1 text-[11px] text-cc-muted transition-colors hover:border-cc-primary/40 hover:bg-cc-hover hover:text-cc-fg disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={!canOpenWorkingDirectory || openingDirectoryTarget !== null}
                  title={directoryDisabledReason || "Open this session's working directory in the system file browser"}
                  onClick={() => {
                    void handleOpenSessionDirectory("working-directory");
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                    <path d="M6 3.5h6.5V10" />
                    <path d="M12.5 3.5 6 10" />
                    <path d="M12.5 12.5h-9v-9" />
                  </svg>
                  {openingDirectoryTarget === "working-directory" ? "Opening" : "Open"}
                </button>
              </div>
              <SessionPathSummary
                cwd={cwd}
                repoRoot={sessionVm?.repoRoot}
                isWorktree={sessionVm?.isWorktree}
                testIdPrefix="session-info-path"
                interactivePaths
                openingPathKey={
                  openingDirectoryTarget === "worktree"
                    ? "worktree"
                    : openingDirectoryTarget === "base-repo"
                      ? "repo"
                      : null
                }
                onOpenPath={
                  canOpenPathRows
                    ? (row) => {
                        const target = row.key === "repo" ? "base-repo" : "worktree";
                        void handleOpenSessionDirectory(target);
                      }
                    : undefined
                }
              />
              {openDirectoryError && (
                <div data-testid="session-info-open-directory-error" className="text-[11px] leading-snug text-cc-error">
                  {openDirectoryError}
                </div>
              )}
            </div>
          )}
          {/* Git summary */}
          {hasGit && (
            <div>
              {gitBranch && (
                <div className="flex items-center gap-1.5 text-[11px] text-cc-muted leading-tight">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    {isWorktree ? (
                      <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                    ) : (
                      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    )}
                  </svg>
                  <span className="truncate">{gitBranch}</span>
                  {isWorktree && (
                    <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-1 rounded shrink-0">wt</span>
                  )}
                </div>
              )}
              {(gitAhead > 0 || gitBehind > 0 || linesAdded > 0 || linesRemoved > 0 || diffStatsSkippedReason) && (
                <div className="flex items-center gap-2 mt-1 text-[11px] text-cc-muted">
                  {(gitAhead > 0 || gitBehind > 0) && (
                    <span className="flex items-center gap-1">
                      {gitAhead > 0 && <span className="text-green-500">{gitAhead}&#8593;</span>}
                      {gitBehind > 0 && <span className="text-cc-warning">{gitBehind}&#8595;</span>}
                    </span>
                  )}
                  {(linesAdded > 0 || linesRemoved > 0) && (
                    <span className="flex items-center gap-1">
                      <span className="text-green-500">+{linesAdded}</span>
                      <span className="text-red-400">-{linesRemoved}</span>
                    </span>
                  )}
                  {diffStatsSkippedReason && <span>{diffStatsSkippedReason}</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Task history */}
        {(herdedSessions.length > 0 || leaderSession) && (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-2">
            {herdedSessions.length > 0 && (
              <div data-testid="session-info-herding">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herding</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {herdedSessions.map((hs) => (
                    <CompactSessionLink
                      key={hs}
                      sessionId={hs}
                      className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer transition-colors"
                      onNavigate={onClose}
                    />
                  ))}
                </div>
              </div>
            )}
            {leaderSession && (
              <div data-testid="session-info-herded-by">
                <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Herded by</span>
                <div className="mt-1">
                  <CompactSessionLink
                    sessionId={leaderSession}
                    className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 cursor-pointer transition-colors"
                    onNavigate={onClose}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Task history */}
        {taskEntries.length > 0 && (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-cc-muted/60">Tasks</span>
            <div
              ref={taskHistoryScrollRef}
              data-testid="task-history-scroll"
              className="max-h-40 overflow-y-auto pr-2 pb-1 space-y-1.5"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              {taskEntries.map((task, i) => {
                const questId = task.questId;
                return (
                  <div key={i} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-1.5">
                    <span className="text-[10px] tabular-nums text-right text-cc-muted/60 mt-px">{i + 1}.</span>
                    {task.source === "quest" && questId ? (
                      <QuestTaskChip questId={questId} title={task.title} onNavigate={onClose} />
                    ) : (
                      <span
                        className={`text-left text-[11px] leading-snug line-clamp-1 ${task.source === "quest" ? "text-amber-400" : "text-cc-fg"}`}
                      >
                        {task.title}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Stats */}
        {hasStats && (
          <div className="px-4 py-2 border-t border-cc-border/50 space-y-1.5">
            <SessionContextStats
              contextPercent={contextPercent}
              contextWindow={contextWindow}
              contextWindowTitle={contextWindowTitle}
              configuredContextWindow={configuredContextWindow}
              configuredContextWindowKind={isCodexSession ? "usable-target" : "raw-max"}
            />
            <SessionPayloadStats
              turns={turns}
              contextPercent={contextPercent}
              contextWindow={contextWindow}
              contextWindowTitle={contextWindowTitle}
              configuredContextWindow={configuredContextWindow}
              configuredContextWindowKind={isCodexSession ? "usable-target" : "raw-max"}
              historyBytes={historyBytes}
              codexRetainedPayloadBytes={codexRetainedPayloadBytes}
              isCodexSession={isCodexSession}
              lastActivityAt={sessionVm?.lastActivityAt}
              highlightHighHistoryBytes
              showContextStats={false}
            />
          </div>
        )}

        {hasLifecycleDebug && (
          <div className="border-t border-cc-border/50" data-testid="session-lifecycle-debug">
            <SectionHeader
              title="Session Lifecycle"
              collapsed={lifecycleCollapsed}
              onToggle={toggleLifecycleCollapsed}
            />
            {!lifecycleCollapsed && (
              <div className="px-4 py-2 space-y-2">
                {contextWindowDiagnostics && (
                  <CodexContextDiagnosticsPanel
                    diagnostics={contextWindowDiagnostics}
                    runtimeContextWindow={sessionVm?.backendReportedContextWindow}
                    displayContextWindow={contextWindow}
                  />
                )}
                {codexLeaderRecyclePending && (
                  <div className="text-[11px] text-amber-400">
                    Pending {formatCodexLeaderRecycleTrigger(codexLeaderRecyclePending.trigger).toLowerCase()} recycle
                  </div>
                )}
                {codexLeaderRecycleLineage?.cliSessionIds.length ? (
                  <div className="space-y-1">
                    <div className="text-[10px] text-cc-muted/70">CLI sessions</div>
                    <div className="space-y-1">
                      {codexLeaderRecycleLineage.cliSessionIds.map((cliSessionId, index) => (
                        <div key={`${cliSessionId}-${index}`} className="text-[11px] text-cc-fg/90 font-mono break-all">
                          {cliSessionId}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {codexLeaderRecycleLineage?.recycleEvents.length ? (
                  <div className="space-y-1">
                    <div className="text-[10px] text-cc-muted/70">Recycle events</div>
                    <div className="space-y-1.5">
                      {codexLeaderRecycleLineage.recycleEvents.map((event, index) => (
                        <div key={`${event.requestedAt}-${index}`} className="rounded-lg bg-cc-hover/40 px-2 py-1.5">
                          <div className="text-[11px] text-cc-fg">
                            {formatCodexLeaderRecycleTrigger(event.trigger)} recycle
                          </div>
                          <div className="mt-0.5 text-[10px] text-cc-muted">
                            {formatRecycleTimestamp(event.requestedAt)}
                            {typeof event.tokenUsage?.contextTokensUsed === "number"
                              ? ` • ${formatLifecycleTokenCount(event.tokenUsage.contextTokensUsed)} context`
                              : " • context unknown"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {lifecycleEvents.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] text-cc-muted/70">Compaction events</div>
                    <div className="space-y-1.5">
                      {lifecycleEvents.map((event) => (
                        <LifecycleEventRow key={event.id} event={event} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Herd diagnostics — only for leader sessions */}
        {isOrchestrator && (
          <div className="border-t border-cc-border/50">
            <HerdDiagnosticsSection sessionId={sessionId} />
          </div>
        )}

        {/* GitHub PR, MCP, and backend-specific instruction sources */}
        <GitHubPRSection sessionId={sessionId} />
        <McpCollapsible sessionId={sessionId} />
        {isCodexSession ? (
          <CodexInstructionsCollapsible
            sessionId={sessionId}
            snapshot={effectiveSdkSession?.codexInstructionSnapshot}
            fetchWhenMissing={false}
            refreshKey={sessionDetailKey}
            snapshotLoading={currentSessionDetailState.status === "loading"}
            snapshotFailed={currentSessionDetailState.status === "failed"}
          />
        ) : (
          <>
            {cwd && <ClaudeMdCollapsible cwd={cwd} repoRoot={sessionVm?.repoRoot} />}
            <SystemPromptCollapsible sessionId={sessionId} />
          </>
        )}
      </div>
    </div>
  );
}

function getSessionInfoContextStats(
  sessionVm: SessionViewModel | null,
  codexLeaderCompactionMode?: string,
): { contextPercent: number; contextWindow: number } {
  const defaultStats = {
    contextPercent: sessionVm?.contextUsedPercent ?? 0,
    contextWindow: sessionVm?.modelContextWindow ?? 0,
  };
  const thresholdTokens = positiveNumber(sessionVm?.codexLeaderRecycleThresholdTokens);
  if (
    !thresholdTokens ||
    sessionVm?.backendType !== "codex" ||
    sessionVm.isOrchestrator !== true ||
    !isCodexLeaderRecycleMode(codexLeaderCompactionMode)
  ) {
    return defaultStats;
  }
  const contextTokensUsed = positiveNumber(sessionVm.contextTokensUsed);
  return {
    contextPercent: contextTokensUsed ? (contextTokensUsed / thresholdTokens) * 100 : defaultStats.contextPercent,
    contextWindow: thresholdTokens,
  };
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function getConfiguredMaxContextLength(sessionVm: SessionViewModel | null): number | undefined {
  return sessionVm?.backendType === "codex"
    ? (sessionVm.codexMaxContextLength ?? undefined)
    : (sessionVm?.claudeMaxContextLength ?? undefined);
}

function getContextWindowTitle(sessionVm: SessionViewModel | null, contextWindow: number): string | undefined {
  const configuredMaxContextLength = getConfiguredMaxContextLength(sessionVm);
  if (!configuredMaxContextLength) return undefined;
  const backendReportedContextWindow = sessionVm?.backendReportedContextWindow;
  if (contextWindow !== configuredMaxContextLength && backendReportedContextWindow === contextWindow) {
    return sessionVm?.backendType === "codex"
      ? `Backend reported usable context window. Configured usable target is ${formatContextWindowLabel(
          configuredMaxContextLength,
        )}.`
      : `Backend reported usable context window. Raw configured max context is ${formatContextWindowLabel(
          configuredMaxContextLength,
        )}.`;
  }
  if (contextWindow !== configuredMaxContextLength) return undefined;
  if (backendReportedContextWindow && backendReportedContextWindow < configuredMaxContextLength) {
    return `Configured max context window. Backend token metadata currently reports ${formatContextWindowLabel(backendReportedContextWindow)}.`;
  }
  return sessionVm?.backendType === "codex" ? "Configured usable context target." : "Configured max context window.";
}

function LifecycleEventRow({ event }: { event: SessionLifecycleEvent }) {
  if (event.type !== "compaction") return null;
  const title = formatCompactionTitle(event);
  const codexEvent = event.backendType === "codex";
  return (
    <div className="rounded-lg bg-cc-hover/40 px-2 py-1.5">
      <div className="text-[11px] text-cc-fg">{title}</div>
      <div className="mt-0.5 text-[10px] text-cc-muted">{formatRecycleTimestamp(event.timestamp)}</div>
      {codexEvent ? (
        <div className="mt-1 space-y-0.5 text-[10px] text-cc-muted">
          <div>Provider input {formatProviderInputSnapshot(event.before)}</div>
          <div>Provider last total {formatProviderTotalSnapshot(event.before)}</div>
          <div>{formatCodexCompactionUnavailability(event)}</div>
          <div>{formatCodexAfterSnapshot(event.after)}</div>
        </div>
      ) : (
        <div className="mt-1 grid grid-cols-2 gap-1 text-[10px] text-cc-muted">
          <span>Before {formatContextSnapshot(event.before)}</span>
          <span>After {formatContextSnapshot(event.after)}</span>
        </div>
      )}
    </div>
  );
}

function CodexContextDiagnosticsPanel({
  diagnostics,
  runtimeContextWindow,
  displayContextWindow,
}: {
  diagnostics: CodexContextWindowDiagnostics;
  runtimeContextWindow?: number;
  displayContextWindow?: number;
}) {
  const role = diagnostics.role === "leader" ? "Leader" : "Non-leader";
  const policy = formatContextCapacityPolicy(diagnostics);
  const displayed = positiveNumber(displayContextWindow) ?? positiveNumber(diagnostics.displayContextWindow);
  return (
    <div className="rounded-lg bg-cc-hover/40 px-2 py-1.5" data-testid="codex-context-diagnostics">
      <div className="text-[10px] text-cc-muted/70">Context policy</div>
      <div className="mt-0.5 text-[11px] text-cc-fg">
        {role} · {policy}
      </div>
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-[10px] text-cc-muted">
        {positiveNumber(diagnostics.configuredUsableContextWindow) && (
          <ContextDiagnosticValue label="Configured usable target" value={diagnostics.configuredUsableContextWindow!} />
        )}
        {positiveNumber(runtimeContextWindow) && (
          <ContextDiagnosticValue label="Runtime effective window" value={runtimeContextWindow!} />
        )}
        {positiveNumber(diagnostics.providerEffectiveContextWindow) && (
          <ContextDiagnosticValue
            label="Provider effective window"
            value={diagnostics.providerEffectiveContextWindow!}
          />
        )}
        {displayed && <ContextDiagnosticValue label="Displayed denominator" value={displayed} />}
        {positiveNumber(diagnostics.providerRawContextWindow) && (
          <ContextDiagnosticValue label="Provider launch window" value={diagnostics.providerRawContextWindow!} />
        )}
        {positiveNumber(diagnostics.autoCompactTokenLimit) && (
          <>
            <span>Configured auto-compact</span>
            <span className="text-right tabular-nums text-cc-fg/90">
              {formatLifecycleTokenCount(diagnostics.autoCompactTokenLimit!)} ·{" "}
              {formatAutoCompactScope(
                diagnostics.autoCompactTokenLimitScope,
                diagnostics.autoCompactTokenLimitScopeSource,
              )}
            </span>
          </>
        )}
        {positiveNumber(diagnostics.catalogEffectiveContextWindowPercent) && (
          <>
            <span>Catalog effective capacity</span>
            <span className="text-right tabular-nums text-cc-fg/90">
              {`${Math.round(diagnostics.catalogEffectiveContextWindowPercent!)}% · reserve ${Math.max(
                0,
                100 - diagnostics.catalogEffectiveContextWindowPercent!,
              )}%`}
            </span>
          </>
        )}
      </div>
      <div className="mt-1 text-[9px] text-cc-muted/70">
        Launch/config provenance; not an event-time active-context measurement.
      </div>
    </div>
  );
}

function ContextDiagnosticValue({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span>{label}</span>
      <span className="text-right tabular-nums text-cc-fg/90">{formatLifecycleTokenCount(value)}</span>
    </>
  );
}

function formatContextCapacityPolicy(diagnostics: CodexContextWindowDiagnostics): string {
  if (diagnostics.role === "leader") {
    return diagnostics.leaderMode === "compact" ? "Compact" : "Recycle";
  }
  if (diagnostics.capacitySource === "configured_usable_capacity") return "Configured capacity";
  if (diagnostics.capacitySource === "codex_config") return "Codex config";
  return "Codex default";
}

function formatCompactionTitle(event: Extract<SessionLifecycleEvent, { type: "compaction" }>): string {
  const backend = formatLifecycleBackend(event.backendType);
  if (event.cause === "context_pressure" && event.causeSource === "producer") {
    return `${backend} compaction · context pressure`;
  }
  if (event.cause === "manual") return `${backend} compaction · manual request`;
  if (event.cause === "model_switch_migration")
    return `${backend} compaction · model switch migration (Takode inferred)`;
  if (event.backendType === "codex") return `${backend} compaction · automatic cause unknown`;
  return `${backend} compaction${event.trigger ? ` · ${event.trigger}` : ""}`;
}

function formatProviderInputSnapshot(
  snapshot: Extract<SessionLifecycleEvent, { type: "compaction" }>["before"],
): string {
  if (!snapshot) return "unknown";
  const tokens =
    snapshot.providerReportedInputTokens ??
    (snapshot.source === "codex_token_details" ? snapshot.contextTokensUsed : undefined);
  if (typeof tokens !== "number") return "unknown";
  const window = snapshot.modelContextWindow;
  if (typeof window !== "number" || window <= 0) return formatLifecycleTokenCount(tokens);
  return `${formatLifecycleTokenCount(tokens)} / ${formatLifecycleTokenCount(window)} (${Math.round((tokens / window) * 100)}%)`;
}

function formatProviderTotalSnapshot(
  snapshot: Extract<SessionLifecycleEvent, { type: "compaction" }>["before"],
): string {
  const tokens = snapshot?.providerReportedTotalTokens;
  if (typeof tokens !== "number") return "unknown";
  return formatSnapshotTokens(tokens, snapshot?.modelContextWindow);
}

function formatCodexAfterSnapshot(snapshot: Extract<SessionLifecycleEvent, { type: "compaction" }>["after"]): string {
  if (!snapshot) return "After unknown";
  const providerTotal = snapshot.providerReportedTotalTokens;
  if (typeof providerTotal === "number") {
    return `After provider last total ${formatSnapshotTokens(providerTotal, snapshot.modelContextWindow)}`;
  }
  const providerInput = snapshot.providerReportedInputTokens ?? snapshot.contextTokensUsed;
  if (typeof providerInput !== "number") return "After unknown";
  return `After provider input ${formatSnapshotTokens(providerInput, snapshot.modelContextWindow)}`;
}

function formatSnapshotTokens(tokens: number, window: number | undefined): string {
  if (typeof window !== "number" || window <= 0) return formatLifecycleTokenCount(tokens);
  return `${formatLifecycleTokenCount(tokens)} / ${formatLifecycleTokenCount(window)} (${Math.round((tokens / window) * 100)}%)`;
}

function formatAutoCompactScope(scope: string | undefined, source: string | undefined): string {
  const sourceLabel = source === "configured" ? "configured" : source === "codex_default" ? "Codex default" : null;
  const scopeLabel = scope === "body_after_prefix" ? "body after prefix" : scope === "total" ? "total" : null;
  if (scopeLabel && sourceLabel) return `${scopeLabel} (${sourceLabel})`;
  if (scopeLabel) return scopeLabel;
  return "scope unknown/default";
}

function formatCodexCompactionUnavailability(event: Extract<SessionLifecycleEvent, { type: "compaction" }>): string {
  const causeIsKnown =
    event.cause === "manual" ||
    event.cause === "model_switch_migration" ||
    (event.cause === "context_pressure" && event.causeSource === "producer");
  return causeIsKnown
    ? "Exact active context unavailable from Codex app-server"
    : "Exact active context and trigger cause unavailable from Codex app-server";
}

function formatRecycleTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCodexLeaderRecycleTrigger(trigger: string): string {
  if (trigger === "manual_compact") return "Manual /compact";
  if (trigger === "context_window_exhausted") return "Context exhausted";
  return "Threshold";
}

function formatContextSnapshot(snapshot: Extract<SessionLifecycleEvent, { type: "compaction" }>["before"]): string {
  if (!snapshot || typeof snapshot.contextTokensUsed !== "number") return "unknown";
  const tokenText = `${formatLifecycleTokenCount(snapshot.contextTokensUsed)} context`;
  if (typeof snapshot.contextUsedPercent !== "number") return tokenText;
  return `${tokenText} (${Math.round(snapshot.contextUsedPercent)}%)`;
}

function formatLifecycleTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
  return String(count);
}

function formatLifecycleBackend(backendType: SessionLifecycleEvent["backendType"]): string {
  if (backendType === "codex") return "Codex";
  if (backendType === "claude-sdk") return "Claude SDK";
  return "Claude";
}

/** Quest chip in task history; hover popups are intentionally disabled here to keep scrolling smooth. */
function QuestTaskChip({ questId, title, onNavigate }: { questId: string; title: string; onNavigate: () => void }) {
  return (
    <button
      type="button"
      className="text-left text-[11px] leading-snug line-clamp-1 text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2 cursor-pointer"
      onClick={() => {
        navigateTo(`/questmaster?quest=${encodeURIComponent(questId)}`);
        onNavigate();
      }}
    >
      {title}
    </button>
  );
}
