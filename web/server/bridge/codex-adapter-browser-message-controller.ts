import type {
  ActiveCodexReasoningPreview,
  ActiveTurnRoute,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIResultMessage,
  CodexCompactionCause,
  CodexCompactionCauseSource,
  CodexContextWindowDiagnostics,
  CodexLeaderRecycleTrigger,
  CodexOutboundTurn,
  ContentBlock,
  PermissionRequest,
  ThreadRef,
  ThreadTransitionMarker,
} from "../session-types.js";
import { createLogger } from "../server-logger.js";
import { sessionTag } from "../session-tag.js";
import {
  applyRecentThreadFallbackToLeaderAssistantRouting,
  clearLeaderThreadStatusForActivity,
  hasLeaderRoutedActivityContent,
  leaderAssistantControlMetadata,
  normalizeLeaderAssistantRouting,
  splitLeaderAssistantContentAtThreadRouteBoundaries,
  updateLeaderThreadStatusesForAssistantOutput,
} from "./thread-routing-reminder.js";
import { queueQuestThreadRemindersForCompletedTurn } from "./quest-thread-reminder.js";
import { recordCompactionFinished, recordCompactionStarted } from "./session-lifecycle-events.js";
import {
  discardCodexModelSwitchCompactionGuard,
  markCodexModelSwitchActivity,
  shouldSuppressCodexModelSwitchCompaction,
} from "./codex-model-switch-compaction.js";
import { shouldTrackCodexToolResultRecovery } from "./tool-result-recovery-controller.js";
import { recordContextUsageHistory } from "./context-usage.js";
import { markCodexAutoPauseRecoveryTurnCompleted } from "./codex-auto-pause-recovery-summary.js";
import {
  appendThreadTransitionMarkerForRouteSwitch,
  inferCurrentThreadRoute,
  normalizeThreadRoute,
  routeFromHistoryEntry,
  type ThreadRouteMetadata,
  withThreadRoute,
} from "../thread-routing-metadata.js";
import { computeSessionTurnMetrics } from "../user-message-classification.js";
import { isTerminalResultInterrupted } from "../result-interruption.js";
import { markRecentAskVisibleResponseFromStream } from "../recent-ask-bundles.js";
import {
  decideCodexProviderResultRecovery,
  prepareCodexTurnsForProviderRecovery,
} from "./codex-provider-result-recovery.js";
import { recordCodexHistoryMilestoneProof } from "./codex-recovery-diagnostics.js";
import { isCodexLeaderRecycleMode } from "../../shared/codex-leader-compaction-mode.js";
import {
  clearCodexReasoningPreviewForRoute,
  listCodexReasoningPreviews,
  retainCodexReasoningPreview,
} from "./codex-reasoning-preview-state.js";
import { upsertCodexReasoningDetail } from "./codex-reasoning-detail-state.js";
import { prepareCodexPlanAssistantReplay } from "./codex-assistant-replay-dedup.js";
import {
  clearCodexProviderRetryState,
  clearOrphanedCodexProviderRetryState,
  setCodexProviderRetryState,
} from "./codex-provider-retry-state.js";

const TOOL_PROGRESS_OUTPUT_LIMIT = 12_000;
const DELEGATE_LIVE_ACTIVITY_LIMIT = 800;
const codexContextLog = createLogger("ws-bridge/codex-context");
type CodexBrowserMessageSessionLike = any;
type CodexBrowserMessageAdapterLike = {
  sendBrowserMessage(msg: unknown): void;
};
type AssistantBrowserMessage = Extract<BrowserIncomingMessage, { type: "assistant" }>;
type ToolUseContentBlock = Extract<ContentBlock, { type: "tool_use" }>;

const CODEX_MODEL_ACTIVITY_MESSAGE_TYPES = new Set<BrowserIncomingMessage["type"]>([
  "assistant",
  "stream_event",
  "codex_reasoning_detail",
  "tool_progress",
  "permission_request",
  "result",
]);

function isSubstantiveCodexModelActivity(msg: BrowserIncomingMessage): boolean {
  return CODEX_MODEL_ACTIVITY_MESSAGE_TYPES.has(msg.type);
}

function markCodexProviderReplayUnsafeActivity(
  session: CodexBrowserMessageSessionLike,
  msg: BrowserIncomingMessage,
): boolean {
  if (msg.type === "result" || !isSubstantiveCodexModelActivity(msg)) return false;
  const currentTurnId = session.codexAdapter?.getCurrentTurnId?.() ?? null;
  const owners = currentTurnId
    ? (session.pendingCodexTurns?.filter((turn: CodexOutboundTurn) => turn.turnId === currentTurnId) ?? [])
    : (session.pendingCodexTurns?.filter(
        (turn: CodexOutboundTurn) => turn.status === "backend_acknowledged" && turn.turnTarget === "current",
      ) ?? []);
  let changed = false;
  for (const owner of owners) {
    if (owner.historyIncorporation && owner.historyIncorporation.recordedAt == null) continue;
    if (owner.providerReplayUnsafeActivityObserved) continue;
    owner.providerReplayUnsafeActivityObserved = true;
    recordCodexHistoryMilestoneProof(session, owner, "activity_observed");
    changed = true;
  }
  return changed;
}

function logCodexCompactionStarted(
  session: CodexBrowserMessageSessionLike,
  eventId: string,
  cause: CodexCompactionCause,
  causeSource: CodexCompactionCauseSource | undefined,
  trigger: "auto" | "manual",
): void {
  const event = session.state.lifecycle_events?.find(
    (candidate: { type?: string; id?: string }) => candidate.type === "compaction" && candidate.id === eventId,
  );
  const before = event?.before;
  const diagnostics = event?.contextWindowDiagnostics ?? session.state.codex_context_window_diagnostics;
  codexContextLog.info("Codex compaction started", {
    sessionId: session.id,
    cause,
    causeSource,
    trigger,
    role: diagnostics?.role,
    leaderMode: diagnostics?.leaderMode,
    capacitySource: diagnostics?.capacitySource,
    configuredUsableContextWindow: diagnostics?.configuredUsableContextWindow,
    displayContextWindow: diagnostics?.displayContextWindow,
    providerEffectiveContextWindow: diagnostics?.providerEffectiveContextWindow,
    providerRawContextWindow: diagnostics?.providerRawContextWindow,
    autoCompactTokenLimit: diagnostics?.autoCompactTokenLimit,
    autoCompactTokenLimitScope: diagnostics?.autoCompactTokenLimitScope,
    autoCompactTokenLimitScopeSource: diagnostics?.autoCompactTokenLimitScopeSource,
    providerReportedInputTokens: before?.providerReportedInputTokens,
    providerReportedTotalTokens: before?.providerReportedTotalTokens,
    exactActiveContextAvailable: false,
    runtimeContextWindow: before?.modelContextWindow,
  });
}

function truncateDelegateLiveActivity(text: string): string {
  return text.length > DELEGATE_LIVE_ACTIVITY_LIMIT ? text.slice(-DELEGATE_LIVE_ACTIVITY_LIMIT) : text;
}

function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") return rec.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function maybeRecordDelegateLiveActivity(session: CodexBrowserMessageSessionLike, msg: BrowserIncomingMessage): void {
  if (!session.state?.delegateChild?.delegateId) return;
  const timestamp = Date.now();
  if (msg.type === "stream_event") {
    const event = msg.event as {
      type?: unknown;
      delta?: { type?: unknown; text?: unknown; thinking?: unknown };
    };
    if (event?.type !== "content_block_delta") return;
    const text =
      event.delta?.type === "text_delta" && typeof event.delta.text === "string"
        ? event.delta.text
        : event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string"
          ? event.delta.thinking
          : "";
    if (!text) return;
    const previous =
      session.delegateLiveActivity?.kind === "assistant" && typeof session.delegateLiveActivity.text === "string"
        ? session.delegateLiveActivity.text
        : "";
    session.delegateLiveActivity = {
      kind: "assistant",
      label: event.delta?.type === "thinking_delta" ? "Assistant thinking" : "Assistant",
      text: truncateDelegateLiveActivity(previous + text),
      status: "running",
      timestamp,
    };
  } else if (msg.type === "assistant") {
    const text = textFromContentBlocks(msg.message?.content);
    if (!text) return;
    session.delegateLiveActivity = {
      kind: "assistant",
      label: "Assistant",
      text: truncateDelegateLiveActivity(text),
      status: "completed",
      timestamp,
    };
  } else if (msg.type === "tool_progress") {
    const previous =
      session.delegateLiveActivity?.kind === "tool" && session.delegateLiveActivity.toolUseId === msg.tool_use_id
        ? session.delegateLiveActivity.text || ""
        : "";
    if (!previous && !msg.output_delta) return;
    session.delegateLiveActivity = {
      kind: "tool",
      label: msg.tool_name,
      toolUseId: msg.tool_use_id,
      text: truncateDelegateLiveActivity(previous + (msg.output_delta || "")),
      status: "running",
      timestamp,
    };
  }
}

function extractTopLevelThinkingStreamText(
  msg: BrowserIncomingMessage,
): { kind: "start" | "delta"; text: string } | null {
  if (msg.type !== "stream_event" || msg.parent_tool_use_id !== null) return null;
  const event = msg.event as
    | {
        type?: unknown;
        content_block?: { type?: unknown; thinking?: unknown };
        delta?: { type?: unknown; thinking?: unknown };
      }
    | undefined;
  if (!event || typeof event !== "object") return null;
  if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
    return {
      kind: "start",
      text: typeof event.content_block.thinking === "string" ? event.content_block.thinking : "",
    };
  }
  if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
    return {
      kind: "delta",
      text: typeof event.delta.thinking === "string" ? event.delta.thinking : "",
    };
  }
  return null;
}

function updateActiveCodexReasoningPreviewFromStream(
  session: CodexBrowserMessageSessionLike,
  msg: BrowserIncomingMessage,
): boolean {
  const thinking = extractTopLevelThinkingStreamText(msg);
  if (!thinking) return false;
  const route = session.activeReasoningAttributionRoute ?? session.activeTurnRoute ?? null;
  if (!route?.threadKey) {
    session.activeCodexReasoningPreview = null;
    return false;
  }
  const turnId =
    typeof session.codexAdapter?.getCurrentTurnId === "function" ? session.codexAdapter.getCurrentTurnId() : null;
  if (thinking.kind === "delta" && !session.activeCodexReasoningPreview) return false;
  const existing = thinking.kind === "delta" ? session.activeCodexReasoningPreview.text : "";
  const preview: ActiveCodexReasoningPreview = {
    ...(thinking.kind === "delta" ? session.activeCodexReasoningPreview : {}),
    text: thinking.kind === "delta" ? existing + thinking.text : thinking.text,
    updatedAt: Date.now(),
    turnId,
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
  };
  session.activeCodexReasoningPreview = preview;
  if (!preview.text.trim()) return false;
  return retainCodexReasoningPreview(session, preview);
}

function retireCompletedCodexReasoningStream(
  session: CodexBrowserMessageSessionLike,
  msg: BrowserIncomingMessage,
): void {
  if (msg.type !== "stream_event" || msg.parent_tool_use_id !== null || !session.activeCodexReasoningPreview) return;
  const event = msg.event as { type?: unknown } | undefined;
  if (event?.type === "content_block_stop") {
    // Completion retires only the delta accumulator. The retained thread row
    // stays visible until authoritative visible content replaces it.
    session.activeCodexReasoningPreview = null;
  }
}

function clearCodexReasoningPreviewForVisibleActivity(
  session: CodexBrowserMessageSessionLike,
  route: ActiveTurnRoute | null | undefined,
  deps: CodexAdapterBrowserMessageDeps,
): boolean {
  if (!clearCodexReasoningPreviewForRoute(session, route)) return false;
  broadcastActiveCodexReasoningPreview(session, deps);
  deps.broadcastBoardParticipantRefresh?.(session);
  return true;
}

function reasoningPreviewBroadcastFields(session: CodexBrowserMessageSessionLike) {
  return { codexReasoningPreviews: listCodexReasoningPreviews(session) };
}

function isTopLevelThinkingOnlyAssistant(msg: BrowserIncomingMessage): boolean {
  if (msg.type !== "assistant" || msg.parent_tool_use_id !== null) return false;
  const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
  return content.length > 0 && content.every((block) => block?.type === "thinking");
}

function hasVisibleTopLevelNonReasoningActivity(msg: AssistantBrowserMessage): boolean {
  if (msg.parent_tool_use_id !== null) return false;
  const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
  return content.some((block) => block?.type !== "thinking");
}

function broadcastActiveCodexReasoningPreview(
  session: CodexBrowserMessageSessionLike,
  deps: CodexAdapterBrowserMessageDeps,
): void {
  deps.broadcastToBrowsers(session, {
    type: "status_change",
    status: "running",
    activeTurnRoute: session.activeTurnRoute ?? null,
    ...reasoningPreviewBroadcastFields(session),
  });
}

function isLeaderSessionForAssistantRouting(
  session: CodexBrowserMessageSessionLike,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): boolean {
  if (session.state?.isOrchestrator === true) return true;
  if (launcherInfo?.isOrchestrator !== true) return false;
  session.state = { ...session.state, isOrchestrator: true };
  return true;
}

function routeFromLeaderAssistantResult(routed: {
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}): ThreadRouteMetadata | undefined {
  if (!routed.threadKey) return undefined;
  return {
    threadKey: routed.threadKey,
    ...(routed.questId ? { questId: routed.questId } : {}),
    ...(routed.threadRefs?.length ? { threadRefs: routed.threadRefs } : {}),
  };
}

function routeForReasoningParent(
  session: CodexBrowserMessageSessionLike,
  parentToolUseId: string,
): ThreadRouteMetadata | null {
  for (let index = session.messageHistory.length - 1; index >= 0; index--) {
    const entry = session.messageHistory[index] as BrowserIncomingMessage;
    if (entry.type !== "assistant") continue;
    const ownsParent = entry.message.content?.some(
      (block: ContentBlock) => block.type === "tool_use" && block.id === parentToolUseId,
    );
    if (!ownsParent) continue;
    return routeFromHistoryEntry(entry) ?? inferCurrentThreadRoute(session.messageHistory.slice(0, index + 1));
  }
  return null;
}

function routeForCodexReasoningDetail(
  session: CodexBrowserMessageSessionLike,
  msg: Extract<BrowserIncomingMessage, { type: "codex_reasoning_detail" }>,
): ThreadRouteMetadata {
  if (msg.parent_tool_use_id) {
    const parentRoute = routeForReasoningParent(session, msg.parent_tool_use_id);
    if (parentRoute) return parentRoute;
  }
  const activeRoute = session.activeReasoningAttributionRoute ?? session.activeTurnRoute;
  return (
    normalizeThreadRoute(activeRoute?.threadKey, activeRoute?.questId) ??
    inferCurrentThreadRoute(session.messageHistory)
  );
}

function activeTurnRouteFromThreadRoute(route: ThreadRouteMetadata): ActiveTurnRoute {
  return {
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
  };
}

function sameActiveTurnRoute(
  current: ActiveTurnRoute | null | undefined,
  next: ActiveTurnRoute | null | undefined,
): boolean {
  return (current?.threadKey ?? "main") === (next?.threadKey ?? "main") && current?.questId === next?.questId;
}

function isWebSearchToolUseBlock(block: ContentBlock): block is ToolUseContentBlock {
  return block.type === "tool_use" && (block.name === "WebSearch" || block.name === "web_search");
}

function mergeToolUseInputValues(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...previous };

  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    if (typeof value === "string") {
      if (value.trim().length > 0 || !(key in merged)) merged[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0 || !(key in merged)) merged[key] = value;
      continue;
    }
    if (typeof value === "object") {
      const previousValue = merged[key];
      if (previousValue && typeof previousValue === "object" && !Array.isArray(previousValue)) {
        merged[key] = mergeToolUseInputValues(
          previousValue as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else if (!(key in merged) || Object.keys(value as Record<string, unknown>).length > 0) {
        merged[key] = value;
      }
      continue;
    }
    merged[key] = value;
  }

  return merged;
}

function tryEnrichExistingWebSearchToolUse(
  session: CodexBrowserMessageSessionLike,
  incoming: AssistantBrowserMessage,
): AssistantBrowserMessage | null {
  const incomingToolUses = incoming.message.content.filter(isWebSearchToolUseBlock);
  if (incomingToolUses.length === 0) return null;

  const incomingId = incoming.message.id;
  if (!incomingId) return null;

  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const entry = session.messageHistory[i];
    if (entry?.type !== "assistant") continue;
    const existing = entry as AssistantBrowserMessage;
    if (existing.message?.id !== incomingId) continue;

    let changed = false;
    const nextContent = existing.message.content.map((block) => {
      if (!isWebSearchToolUseBlock(block)) return block;
      const incomingBlock = incomingToolUses.find((candidate) => candidate.id === block.id);
      if (!incomingBlock) return block;

      const mergedInput = mergeToolUseInputValues(block.input || {}, incomingBlock.input || {});
      if (JSON.stringify(mergedInput) === JSON.stringify(block.input || {})) return block;

      changed = true;
      return {
        ...block,
        name: incomingBlock.name || block.name,
        input: mergedInput,
      };
    });

    if (!changed) return null;

    const updated: AssistantBrowserMessage = {
      ...existing,
      message: {
        ...existing.message,
        content: nextContent,
      },
    };
    session.messageHistory[i] = updated;
    return updated;
  }

  return null;
}

function updateActiveTurnRouteFromLeaderAssistant(
  session: CodexBrowserMessageSessionLike,
  route: ThreadRouteMetadata | undefined,
  deps: Pick<CodexAdapterBrowserMessageDeps, "broadcastToBrowsers">,
): void {
  if (!route || !session.isGenerating) return;
  const nextRoute = activeTurnRouteFromThreadRoute(route);
  if (sameActiveTurnRoute(session.activeTurnRoute, nextRoute)) return;
  session.activeTurnRoute = nextRoute;
  session.activeReasoningAttributionRoute = nextRoute;
  // A route switch retires the current provider stream so late deltas cannot
  // attach to a different thread. The retained row in the previous thread is
  // intentionally left in place until that thread receives visible output.
  session.activeCodexReasoningPreview = null;
  deps.broadcastToBrowsers(session, {
    type: "status_change",
    status: "running",
    activeTurnRoute: nextRoute,
    ...reasoningPreviewBroadcastFields(session),
  });
}

type CodexLeaderRecycleLauncherInfo = {
  isOrchestrator?: boolean;
  cliSessionId?: string | null;
  codexLeaderCompactionMode?: string;
  codexContextWindowDiagnostics?: CodexContextWindowDiagnostics;
  codexServiceTier?: string | null;
  codexLeaderRecycleThresholdTokens?: number;
  codexLeaderRecycleLineage?: {
    recycleEvents?: Array<{
      trigger?: CodexLeaderRecycleTrigger;
      nextCliSessionId?: string;
      tokenUsage?: {
        contextTokensUsed?: number;
        modelContextWindow?: number;
      };
    }>;
  };
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function withCodexContextWindowDiagnostics(
  patch: Record<string, unknown>,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): Record<string, unknown> {
  const diagnostics = launcherInfo?.codexContextWindowDiagnostics;
  if (!diagnostics) return patch;
  return {
    ...patch,
    codex_context_window_diagnostics: { ...diagnostics },
  };
}

function withCodexLeaderDisplayBudget(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): Record<string, unknown> {
  if (!isCodexLeaderSession(session, launcherInfo)) return patch;
  if (
    !isCodexLeaderRecycleMode(launcherInfo?.codexLeaderCompactionMode ?? session.state?.codex_leader_compaction_mode)
  ) {
    return patch;
  }
  const thresholdTokens =
    positiveInteger(launcherInfo?.codexLeaderRecycleThresholdTokens) ??
    positiveInteger(patch.codex_leader_recycle_threshold_tokens) ??
    positiveInteger(session.state?.codex_leader_recycle_threshold_tokens);
  if (!thresholdTokens) return patch;
  const next: Record<string, unknown> = {
    ...patch,
    codex_leader_recycle_threshold_tokens: thresholdTokens,
  };
  const tokenDetails = next.codex_token_details;
  if (tokenDetails && typeof tokenDetails === "object") {
    const details = tokenDetails as Record<string, unknown>;
    const contextTokensUsed = nonNegativeInteger(details.contextTokensUsed);
    next.codex_token_details = {
      ...details,
      modelContextWindow: thresholdTokens,
      ...(contextTokensUsed !== undefined ? { displayContextTokensUsed: contextTokensUsed } : {}),
    };
    if (contextTokensUsed !== undefined) {
      next.context_used_percent = clampPercent(Math.round((contextTokensUsed / thresholdTokens) * 100));
    }
  }
  return next;
}

function mirrorCodexServiceTierToLauncherInfo(
  patch: Record<string, unknown>,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): void {
  if (!launcherInfo || !Object.prototype.hasOwnProperty.call(patch, "codex_service_tier")) return;
  const serviceTier = patch.codex_service_tier;
  launcherInfo.codexServiceTier = typeof serviceTier === "string" && serviceTier.trim() ? serviceTier.trim() : null;
}

function withHistoryTurnMetrics(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const history = Array.isArray(session.messageHistory) ? session.messageHistory : [];
  if (history.length === 0) {
    return preserveExistingTurnMetrics(session, patch);
  }
  const turnMetrics = computeSessionTurnMetrics(history);
  return {
    ...patch,
    user_turn_count: turnMetrics.userTurnCount,
    agent_turn_count: turnMetrics.agentTurnCount,
    num_turns: turnMetrics.userTurnCount,
  };
}

function preserveExistingTurnMetrics(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existingUserTurns = session.state?.user_turn_count;
  const existingAgentTurns = session.state?.agent_turn_count;
  const existingNumTurns = session.state?.num_turns;
  const next = { ...patch };
  if (typeof existingUserTurns === "number" && existingUserTurns > 0 && next.user_turn_count === 0) {
    next.user_turn_count = existingUserTurns;
  }
  if (typeof existingAgentTurns === "number" && existingAgentTurns > 0 && next.agent_turn_count === 0) {
    next.agent_turn_count = existingAgentTurns;
  }
  if (typeof existingNumTurns === "number" && existingNumTurns > 0 && next.num_turns === 0) {
    next.num_turns = existingNumTurns;
  }
  return next;
}

function getLatestThresholdRecycleWatermark(launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined): {
  contextTokensUsed: number;
  recycleThresholdTokens?: number;
  nextCliSessionId?: string;
} | null {
  const recycleEvents = launcherInfo?.codexLeaderRecycleLineage?.recycleEvents;
  if (!Array.isArray(recycleEvents) || recycleEvents.length === 0) return null;
  for (let index = recycleEvents.length - 1; index >= 0; index -= 1) {
    const recycleEvent = recycleEvents[index];
    const watermark = recycleEvent?.tokenUsage?.contextTokensUsed;
    if (recycleEvent?.trigger !== "threshold" || typeof watermark !== "number") continue;
    return {
      contextTokensUsed: watermark,
      ...(typeof recycleEvent.nextCliSessionId === "string" && recycleEvent.nextCliSessionId.trim()
        ? { nextCliSessionId: recycleEvent.nextCliSessionId }
        : {}),
      ...(typeof recycleEvent.tokenUsage?.modelContextWindow === "number"
        ? { recycleThresholdTokens: recycleEvent.tokenUsage.modelContextWindow }
        : {}),
    };
  }
  return null;
}

function shouldTriggerCodexLeaderThresholdRecycle(
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
  contextTokensUsed: number | undefined,
  recycleThresholdTokens: number,
): boolean {
  if (!launcherInfo?.isOrchestrator) return false;
  if (!isCodexLeaderRecycleMode(launcherInfo.codexLeaderCompactionMode)) return false;
  if (typeof contextTokensUsed !== "number") return false;
  if (recycleThresholdTokens <= 0 || contextTokensUsed < recycleThresholdTokens) return false;
  const latestThresholdWatermark = getLatestThresholdRecycleWatermark(launcherInfo);
  const currentCliSessionId = typeof launcherInfo.cliSessionId === "string" ? launcherInfo.cliSessionId : null;
  if (
    latestThresholdWatermark !== null &&
    (latestThresholdWatermark.nextCliSessionId === currentCliSessionId ||
      latestThresholdWatermark.contextTokensUsed === contextTokensUsed ||
      latestThresholdWatermark.recycleThresholdTokens === undefined ||
      latestThresholdWatermark.recycleThresholdTokens === recycleThresholdTokens) &&
    contextTokensUsed <= latestThresholdWatermark.contextTokensUsed
  ) {
    return false;
  }
  return true;
}

export interface CodexAdapterBrowserMessageDeps {
  getLauncherSessionInfo: (sessionId: string) => CodexLeaderRecycleLauncherInfo | null | undefined;
  touchActivity: (sessionId: string) => void;
  clearOptimisticRunningTimer: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  setCodexImageSendStage: (
    session: CodexBrowserMessageSessionLike,
    stage: string,
    options?: { persist?: boolean },
  ) => void;
  sanitizeCodexSessionPatch: (patch: Record<string, unknown>) => Record<string, unknown>;
  cacheSlashCommandState: (session: CodexBrowserMessageSessionLike, sanitized: Record<string, unknown>) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: CodexBrowserMessageSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  persistSession: (session: CodexBrowserMessageSessionLike) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  freezeHistoryThroughCurrentTail: (session: CodexBrowserMessageSessionLike) => void;
  injectCompactionRecovery: (session: CodexBrowserMessageSessionLike) => void;
  trackCodexQuestCommands: (session: CodexBrowserMessageSessionLike, content: ContentBlock[]) => void;
  reconcileCodexQuestToolResult: (
    session: CodexBrowserMessageSessionLike,
    toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  ) => Promise<void>;
  collectCompletedToolStartTimes: (
    session: CodexBrowserMessageSessionLike,
    toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
  ) => number[];
  buildToolResultPreviews: (
    session: CodexBrowserMessageSessionLike,
    toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
  ) => unknown[];
  projectToolResultPreviews?: (
    session: CodexBrowserMessageSessionLike,
    toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
  ) => unknown[];
  broadcastToBrowsers: (session: CodexBrowserMessageSessionLike, msg: BrowserIncomingMessage) => void;
  invalidateLeaderThreadTabsForSession?: (sessionId: string) => boolean | void;
  promoteLeaderThreadTabForTransition?: (sessionId: string, marker: ThreadTransitionMarker) => boolean;
  finalizeSupersededCodexTerminalTools: (
    session: CodexBrowserMessageSessionLike,
    completedToolStartTimes: number[],
  ) => void;
  isDuplicateCodexAssistantReplay: (
    session: CodexBrowserMessageSessionLike,
    assistant: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  ) => boolean;
  completeCodexTurnsForResult: (
    session: CodexBrowserMessageSessionLike,
    msg: CLIResultMessage,
    updatedAt?: number,
    interrupted?: boolean,
  ) => boolean;
  clearCodexFreshTurnRequirement: (
    session: CodexBrowserMessageSessionLike,
    reason: string,
    options?: { completedTurnId?: string | null },
  ) => void;
  reconcileRecoveredQueuedTurnLifecycle?: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  handleResultMessage: (session: CodexBrowserMessageSessionLike, msg: CLIResultMessage) => void;
  queueCodexPendingStartBatch: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  dispatchQueuedCodexTurns: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  maybeFlushQueuedCodexMessages: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  handleCodexPermissionRequest: (
    session: CodexBrowserMessageSessionLike,
    permission: PermissionRequest,
  ) => Promise<void> | void;
  requestCodexLeaderRecycle: (
    session: CodexBrowserMessageSessionLike,
    trigger: CodexLeaderRecycleTrigger,
  ) => Promise<{ ok: boolean; error?: string }>;
  handleCodexResultErrorAutoPause: (
    session: CodexBrowserMessageSessionLike,
    msg: CLIResultMessage,
    completedTurn: CodexOutboundTurn | null,
    interrupted?: boolean,
  ) => Promise<void> | void;
  requestCodexProviderRecovery?: (session: CodexBrowserMessageSessionLike, reason: string) => boolean;
  broadcastBoardParticipantRefresh?: (session: CodexBrowserMessageSessionLike) => void;
  syncSideChatParent?: (session: CodexBrowserMessageSessionLike) => void;
}

function publishThreadTransitionMarker(
  session: CodexBrowserMessageSessionLike,
  marker: ThreadTransitionMarker | null,
  deps: Pick<CodexAdapterBrowserMessageDeps, "broadcastToBrowsers" | "promoteLeaderThreadTabForTransition">,
): void {
  if (!marker) return;
  deps.promoteLeaderThreadTabForTransition?.(session.id, marker);
  deps.broadcastToBrowsers(session, marker);
}

export function isCodexContextWindowExhaustionMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return (
    /\bcodex\b/i.test(message) &&
    /\bran out of room in the model'?s context window\b/i.test(message) &&
    /\b(?:start a new thread|clear earlier history)\b/i.test(message)
  );
}

function getCodexContextWindowExhaustionMessage(msg: BrowserIncomingMessage): string | null {
  if (msg.type === "error") {
    return isCodexContextWindowExhaustionMessage(msg.message) ? msg.message : null;
  }
  if (msg.type !== "result" || !msg.data?.is_error) return null;
  if (isCodexContextWindowExhaustionMessage(msg.data.result)) return msg.data.result || null;
  const matchingError = msg.data.errors?.find(isCodexContextWindowExhaustionMessage);
  return matchingError || null;
}

function isCodexLeaderSession(
  session: CodexBrowserMessageSessionLike,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): boolean {
  return session.state?.isOrchestrator === true || launcherInfo?.isOrchestrator === true;
}

async function maybeRecycleCodexLeaderForContextWindowExhaustion(
  session: CodexBrowserMessageSessionLike,
  outgoing: BrowserIncomingMessage | null,
  deps: CodexAdapterBrowserMessageDeps,
): Promise<boolean> {
  if (!outgoing) return false;
  const errorMessage = getCodexContextWindowExhaustionMessage(outgoing);
  if (!errorMessage) return false;
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (!isCodexLeaderSession(session, launcherInfo)) return false;
  if (
    !isCodexLeaderRecycleMode(launcherInfo?.codexLeaderCompactionMode ?? session.state?.codex_leader_compaction_mode)
  ) {
    return false;
  }

  const recycle = await deps.requestCodexLeaderRecycle(session, "context_window_exhausted");
  if (!recycle.ok) {
    deps.broadcastToBrowsers(session, {
      type: "error",
      message: recycle.error || "Failed to recycle Codex leader session after context-window exhaustion",
    });
  }
  return true;
}

function routeForCodexSubagentMessage(
  session: CodexBrowserMessageSessionLike,
  message: BrowserIncomingMessage,
): ThreadRouteMetadata | null {
  const rootTurnId = message.codexSubagent?.rootTurnId;
  if (!rootTurnId) return null;
  const rootIndex = session.messageHistory.findIndex(
    (entry: BrowserIncomingMessage) => entry.type === "user_message" && entry.id === rootTurnId,
  );
  if (rootIndex < 0) return null;
  const rootMessage = session.messageHistory[rootIndex] as BrowserIncomingMessage;
  return routeFromHistoryEntry(rootMessage) ?? inferCurrentThreadRoute(session.messageHistory.slice(0, rootIndex + 1));
}

function withCodexSubagentRootRoute(
  session: CodexBrowserMessageSessionLike,
  message: BrowserIncomingMessage,
): BrowserIncomingMessage {
  const route = routeForCodexSubagentMessage(session, message);
  return route ? (withThreadRoute(message, route) as BrowserIncomingMessage) : message;
}

function filterNewCodexSubagentToolPreviews(
  session: CodexBrowserMessageSessionLike,
  message: BrowserIncomingMessage,
  previews: unknown[],
): unknown[] {
  const childId = message.codexSubagent?.childId;
  if (!childId) return [];
  const existingToolIds = new Set<string>();
  for (const entry of session.messageHistory as BrowserIncomingMessage[]) {
    if (entry.type !== "tool_result_preview" || entry.codexSubagent?.childId !== childId) continue;
    for (const preview of entry.previews) existingToolIds.add(preview.tool_use_id);
  }
  return previews.filter((preview) => {
    const toolUseId =
      preview && typeof preview === "object" && typeof (preview as { tool_use_id?: unknown }).tool_use_id === "string"
        ? (preview as { tool_use_id: string }).tool_use_id
        : null;
    return !!toolUseId && !existingToolIds.has(toolUseId);
  });
}

/**
 * Child-owned Codex rows are chronological audit data, not root-agent output.
 * Keep them out of leader routing, quest command/status, recent-ask, retry, and
 * root reasoning-preview state while preserving stable message identity.
 */
async function handleCodexSubagentOwnedMessage(
  session: CodexBrowserMessageSessionLike,
  message: BrowserIncomingMessage,
  deps: CodexAdapterBrowserMessageDeps,
): Promise<void> {
  const routed = withCodexSubagentRootRoute(session, message);

  if (routed.type === "error") {
    const duplicate =
      !!routed.id &&
      session.messageHistory.some((entry: BrowserIncomingMessage) => entry.type === "error" && entry.id === routed.id);
    if (duplicate) return;
    session.messageHistory.push(routed);
    deps.persistSession(session);
    deps.syncSideChatParent?.(session);
    deps.broadcastToBrowsers(session, routed);
    return;
  }

  if (routed.type === "codex_reasoning_detail") {
    const update = upsertCodexReasoningDetail(session, routed);
    if (!update.changed) return;
    deps.persistSession(session);
    deps.syncSideChatParent?.(session);
    deps.broadcastToBrowsers(session, update.message);
    return;
  }

  if (routed.type === "assistant") {
    const timestamp = typeof routed.timestamp === "number" ? routed.timestamp : Date.now();
    let outgoing: AssistantBrowserMessage | null = { ...routed, timestamp };
    const toolResults = (outgoing.message.content ?? []).filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      const previews = filterNewCodexSubagentToolPreviews(
        session,
        routed,
        deps.projectToolResultPreviews?.(session, toolResults) ?? [],
      );
      if (previews.length > 0) {
        const previewMessage = withCodexSubagentRootRoute(session, {
          type: "tool_result_preview",
          previews,
          codexSubagent: routed.codexSubagent,
        } as BrowserIncomingMessage);
        session.messageHistory.push(previewMessage);
        deps.broadcastToBrowsers(session, previewMessage);
      }
      const nonResult = outgoing.message.content.filter((block) => block.type !== "tool_result");
      outgoing =
        nonResult.length > 0
          ? ({
              ...outgoing,
              message: { ...outgoing.message, content: nonResult },
            } as AssistantBrowserMessage)
          : null;
    }
    if (outgoing) {
      const planReplay = prepareCodexPlanAssistantReplay(session, outgoing);
      outgoing = planReplay.message;
      if (!planReplay.isDuplicate && !deps.isDuplicateCodexAssistantReplay(session, outgoing)) {
        session.messageHistory.push(outgoing);
        deps.broadcastToBrowsers(session, outgoing);
      }
    }
    deps.persistSession(session);
    deps.syncSideChatParent?.(session);
    return;
  }

  // Child progress remains visible audit data but never feeds root tool
  // progress/timing/watchdog maps.
  deps.broadcastToBrowsers(session, routed);
}

export async function handleCodexAdapterBrowserMessage(
  session: CodexBrowserMessageSessionLike,
  msg: BrowserIncomingMessage,
  deps: CodexAdapterBrowserMessageDeps,
): Promise<void> {
  if (msg.codexSubagent) {
    await handleCodexSubagentOwnedMessage(session, msg, deps);
    return;
  }
  if (msg.type === "session_update" && "codex_stream_retry" in msg.session) {
    const retry = msg.session.codex_stream_retry ?? null;
    if (retry && retry.turnId !== session.codexAdapter?.getCurrentTurnId?.()) return;
    if (retry) {
      deps.touchActivity(session.id);
      session.lastCliMessageAt = Date.now();
    }
    if ((session.state.codex_stream_retry?.turnId ?? null) === (retry?.turnId ?? null)) return;
    session.state.codex_stream_retry = retry;
    deps.broadcastToBrowsers(session, { type: "session_update", session: { codex_stream_retry: retry } });
    return;
  }
  deps.touchActivity(session.id);
  session.lastCliMessageAt = Date.now();
  deps.clearOptimisticRunningTimer(session, `codex_output:${msg.type}`);
  const replaySafetyProofChanged = markCodexProviderReplayUnsafeActivity(session, msg);
  if ((isSubstantiveCodexModelActivity(msg) && markCodexModelSwitchActivity(session)) || replaySafetyProofChanged) {
    deps.persistSession(session);
  }
  if (msg.type === "codex_reasoning_detail") {
    const routed = withThreadRoute(msg, routeForCodexReasoningDetail(session, msg));
    const update = upsertCodexReasoningDetail(session, routed);
    if (update.changed) {
      const hasCurrentThreadStatus = Object.keys(session.state.leaderThreadStatuses ?? {}).length > 0;
      const launcherInfo = hasCurrentThreadStatus ? deps.getLauncherSessionInfo?.(session.id) : null;
      if (
        update.activityChanged &&
        hasCurrentThreadStatus &&
        isLeaderSessionForAssistantRouting(session, launcherInfo)
      ) {
        const statusChanged = clearLeaderThreadStatusForActivity(session, routed, {
          messageId: routed.id,
          timestamp: routed.timestamp,
        });
        if (statusChanged) deps.invalidateLeaderThreadTabsForSession?.(session.id);
      }
      deps.persistSession(session);
      deps.syncSideChatParent?.(session);
      deps.broadcastToBrowsers(session, update.message);
    }
    return;
  }
  maybeRecordDelegateLiveActivity(session, msg);
  markRecentAskVisibleResponseFromStream(session, msg);
  const activeReasoningPreviewChanged = updateActiveCodexReasoningPreviewFromStream(session, msg);
  if (activeReasoningPreviewChanged) {
    broadcastActiveCodexReasoningPreview(session, deps);
    deps.broadcastBoardParticipantRefresh?.(session);
  } else {
    retireCompletedCodexReasoningStream(session, msg);
  }
  if (session.state.codex_image_send_stage && (msg.type === "stream_event" || msg.type === "assistant")) {
    deps.setCodexImageSendStage(session, "responding", { persist: false });
  }

  let outgoing: BrowserIncomingMessage | null = msg;
  let activeRouteFromAssistant: ThreadRouteMetadata | undefined;

  if (msg.type === "session_init") {
    const sanitized = deps.sanitizeCodexSessionPatch(msg.session as unknown as Record<string, unknown>);
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    const enriched = withHistoryTurnMetrics(
      session,
      withCodexLeaderDisplayBudget(
        session,
        withCodexContextWindowDiagnostics({ ...sanitized, backend_type: "codex" }, launcherInfo),
        launcherInfo,
      ),
    );
    const initializedState = session.state.codex_native_subagents
      ? {
          ...enriched,
          codex_native_subagents: session.state.codex_native_subagents,
        }
      : enriched;
    session.state = { ...session.state, ...initializedState };
    session.cliInitReceived = true;
    deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
    deps.persistSession(session);
    outgoing = {
      ...msg,
      session: initializedState as unknown as typeof msg.session,
    } as BrowserIncomingMessage;
  } else if (msg.type === "session_update") {
    const sanitized = deps.sanitizeCodexSessionPatch(msg.session as unknown as Record<string, unknown>);
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    mirrorCodexServiceTierToLauncherInfo(sanitized, launcherInfo);
    const enriched = withHistoryTurnMetrics(
      session,
      withCodexLeaderDisplayBudget(session, { ...sanitized, backend_type: "codex" }, launcherInfo),
    );
    session.state = { ...session.state, ...enriched };
    if ("context_used_percent" in enriched || "codex_token_details" in enriched) {
      recordContextUsageHistory(session, "codex_token_usage");
    }
    outgoing = {
      ...msg,
      session: enriched as unknown as typeof msg.session,
    } as BrowserIncomingMessage;
    deps.cacheSlashCommandState(session, enriched);
    deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
    const recycleThresholdTokens =
      positiveInteger(session.state.codex_leader_recycle_threshold_tokens) ??
      positiveInteger(launcherInfo?.codexLeaderRecycleThresholdTokens) ??
      0;
    const contextTokensUsed = session.state.codex_token_details?.contextTokensUsed;
    if (shouldTriggerCodexLeaderThresholdRecycle(launcherInfo, contextTokensUsed, recycleThresholdTokens)) {
      const recycle = await deps.requestCodexLeaderRecycle(session, "threshold");
      if (!recycle.ok) {
        deps.broadcastToBrowsers(session, {
          type: "error",
          message: recycle.error || "Failed to recycle Codex leader session",
        });
      }
    }
    deps.persistSession(session);
  } else if (msg.type === "status_change") {
    const wasCompacting = session.state.is_compacting;
    session.state.is_compacting = msg.status === "compacting";
    if (msg.status === "compacting" && !wasCompacting) {
      const rawReportedCause = msg.codexCompactionCause ?? "unknown";
      const rawReportedCauseSource = msg.codexCompactionCauseSource;
      const reportedCause =
        rawReportedCause === "context_pressure" && rawReportedCauseSource !== "producer" ? "unknown" : rawReportedCause;
      if (reportedCause === "manual") {
        discardCodexModelSwitchCompactionGuard(session);
      }
      const suppressModelSwitchMigration =
        reportedCause === "model_switch_migration" ||
        (reportedCause === "unknown" && shouldSuppressCodexModelSwitchCompaction(session));
      const cause = suppressModelSwitchMigration ? "model_switch_migration" : reportedCause;
      const causeSource: CodexCompactionCauseSource | undefined = suppressModelSwitchMigration
        ? "takode_model_switch_guard"
        : cause === "manual"
          ? (rawReportedCauseSource ?? "takode_manual_request")
          : cause === "context_pressure" && rawReportedCauseSource === "producer"
            ? "producer"
            : undefined;
      const ts = Date.now();
      const markerId = `compact-boundary-${ts}`;
      recordCompactionStarted(session, {
        id: markerId,
        timestamp: ts,
        trigger: cause === "manual" ? "manual" : "auto",
        cause,
        causeSource,
      });
      logCodexCompactionStarted(session, markerId, cause, causeSource, cause === "manual" ? "manual" : "auto");
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { lifecycle_events: session.state.lifecycle_events },
      } as BrowserIncomingMessage);
      if (suppressModelSwitchMigration) {
        outgoing = null;
        console.log(
          `[ws-bridge] Suppressing Codex model-switch migration compaction recovery for session ${sessionTag(session.id)}`,
        );
      } else {
        session.compactedDuringTurn = true;
        deps.emitTakodeEvent(session.id, "compaction_started", {
          cause,
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
        session.messageHistory.push({
          type: "compact_marker",
          timestamp: ts,
          id: markerId,
        });
        deps.freezeHistoryThroughCurrentTail(session);
        deps.broadcastToBrowsers(session, {
          type: "compact_boundary",
          id: markerId,
          timestamp: ts,
        } as BrowserIncomingMessage);
      }
    }
    if (wasCompacting && msg.status !== "compacting") {
      if (session.codexSuppressRecoveryForCurrentCompaction) {
        recordCompactionFinished(session);
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { lifecycle_events: session.state.lifecycle_events },
        } as BrowserIncomingMessage);
        session.codexSuppressRecoveryForCurrentCompaction = false;
        outgoing = null;
      } else {
        recordCompactionFinished(session);
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { lifecycle_events: session.state.lifecycle_events },
        } as BrowserIncomingMessage);
        deps.emitTakodeEvent(session.id, "compaction_finished", {
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
        deps.injectCompactionRecovery(session);
      }
    }
    deps.persistSession(session);
  } else if (msg.type === "assistant" && isTopLevelThinkingOnlyAssistant(msg)) {
    outgoing = null;
  } else if (msg.type === "assistant") {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    const isLeaderSession = isLeaderSessionForAssistantRouting(session, launcherInfo);
    const contentSegments = splitLeaderAssistantContentAtThreadRouteBoundaries(
      isLeaderSession,
      msg.message.content || [],
      msg.parent_tool_use_id,
    );
    if (contentSegments.length > 1) {
      const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      const resolvedMessageId = msg.message.id ?? msg.uuid ?? `assistant-${timestamp}-${session.messageHistory.length}`;
      for (const [segmentIndex, contentSegment] of contentSegments.entries()) {
        const routed = applyRecentThreadFallbackToLeaderAssistantRouting(
          isLeaderSession,
          normalizeLeaderAssistantRouting(isLeaderSession, contentSegment, msg.parent_tool_use_id),
          session.messageHistory,
          msg.parent_tool_use_id,
        );
        const segmentRoute = routeFromLeaderAssistantResult(routed);
        if (routed.questThreadReminders?.length) {
          queueQuestThreadRemindersForCompletedTurn(session, routed.questThreadReminders, segmentRoute);
        }
        const segmentMessageId = segmentIndex === 0 ? resolvedMessageId : `${resolvedMessageId}:route-${segmentIndex}`;
        let normalizedAssistant: AssistantBrowserMessage = {
          ...msg,
          message: {
            ...msg.message,
            id: segmentMessageId,
            content: routed.content,
          },
          timestamp,
          ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
          ...(routed.questId ? { questId: routed.questId } : {}),
          ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
          ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
          ...leaderAssistantControlMetadata(session, routed, Boolean(msg.message.id ?? msg.uuid)),
        };
        const content: ContentBlock[] = normalizedAssistant.message.content || [];
        const now = Date.now();
        for (const block of content) {
          if (
            block.type === "tool_use" &&
            block.id &&
            shouldTrackCodexToolResultRecovery(block) &&
            !session.toolStartTimes.has(block.id)
          ) {
            session.toolStartTimes.set(block.id, now);
            session.toolProgressOutput.delete(block.id);
          }
        }
        deps.trackCodexQuestCommands(session, content);
        if (deps.isDuplicateCodexAssistantReplay(session, normalizedAssistant)) continue;
        if (hasVisibleTopLevelNonReasoningActivity(normalizedAssistant)) {
          clearCodexReasoningPreviewForVisibleActivity(session, segmentRoute, deps);
        }
        const transitionMarker = appendThreadTransitionMarkerForRouteSwitch(
          session.messageHistory,
          normalizeThreadRoute(normalizedAssistant.threadKey, normalizedAssistant.questId),
        );
        publishThreadTransitionMarker(session, transitionMarker, deps);
        session.messageHistory.push(normalizedAssistant);
        const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
          session,
          undefined,
          { messageId: normalizedAssistant.message.id, timestamp },
          hasLeaderRoutedActivityContent(normalizedAssistant.message.content) ? segmentRoute : undefined,
        );
        if (statusUpdate.changed) deps.invalidateLeaderThreadTabsForSession?.(session.id);
        deps.persistSession(session);
        deps.syncSideChatParent?.(session);
        deps.broadcastToBrowsers(session, normalizedAssistant);
        updateActiveTurnRouteFromLeaderAssistant(session, segmentRoute, deps);
      }
      return;
    }
    const routed = applyRecentThreadFallbackToLeaderAssistantRouting(
      isLeaderSession,
      normalizeLeaderAssistantRouting(isLeaderSession, msg.message.content || [], msg.parent_tool_use_id),
      session.messageHistory,
      msg.parent_tool_use_id,
    );
    activeRouteFromAssistant = routeFromLeaderAssistantResult(routed);
    if (routed.questThreadReminders?.length) {
      queueQuestThreadRemindersForCompletedTurn(session, routed.questThreadReminders, activeRouteFromAssistant);
    }
    const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const resolvedMessageId = msg.message.id ?? msg.uuid ?? `assistant-${timestamp}-${session.messageHistory.length}`;
    const routedMsg = {
      ...msg,
      message: {
        ...msg.message,
        id: resolvedMessageId,
        content: routed.content,
      },
      timestamp,
      ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
      ...(routed.questId ? { questId: routed.questId } : {}),
      ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
      ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
      ...leaderAssistantControlMetadata(session, routed, Boolean(msg.message.id ?? msg.uuid)),
    };
    msg = routedMsg;
    outgoing = routedMsg;
    const content: ContentBlock[] = routedMsg.message.content || [];
    const now = Date.now();
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.id &&
        shouldTrackCodexToolResultRecovery(block) &&
        !session.toolStartTimes.has(block.id)
      ) {
        session.toolStartTimes.set(block.id, now);
        session.toolProgressOutput.delete(block.id);
      }
    }
    deps.trackCodexQuestCommands(session, content);
    const toolResults = content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        await deps.reconcileCodexQuestToolResult(session, block);
      }
      const completedToolStartTimes = deps.collectCompletedToolStartTimes(session, toolResults);
      const previews = deps.buildToolResultPreviews(session, toolResults);
      if (previews.length > 0) {
        const previewMsg: BrowserIncomingMessage = {
          type: "tool_result_preview",
          previews,
          ...(routedMsg.codexSubagent ? { codexSubagent: routedMsg.codexSubagent } : {}),
        } as BrowserIncomingMessage;
        session.messageHistory.push(previewMsg);
        deps.broadcastToBrowsers(session, previewMsg);
        deps.persistSession(session);
        deps.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
      }

      const nonResult = content.filter((block: ContentBlock) => block.type !== "tool_result");
      if (nonResult.length === 0) {
        outgoing = null;
      } else {
        outgoing = {
          ...routedMsg,
          message: { ...routedMsg.message, content: nonResult },
        } as BrowserIncomingMessage;
      }
    }
  } else if (msg.type === "tool_progress") {
    if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
      const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
      const merged = prev + msg.output_delta;
      session.toolProgressOutput.set(
        msg.tool_use_id,
        merged.length > TOOL_PROGRESS_OUTPUT_LIMIT ? merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT) : merged,
      );
    }
  }

  if (outgoing?.type === "assistant") {
    const assistantTimestamp = outgoing.timestamp || Date.now();
    let normalizedAssistant: AssistantBrowserMessage = {
      ...outgoing,
      timestamp: assistantTimestamp,
    };
    const enrichedWebSearch = tryEnrichExistingWebSearchToolUse(session, normalizedAssistant);
    if (enrichedWebSearch) {
      deps.persistSession(session);
      deps.syncSideChatParent?.(session);
      deps.broadcastToBrowsers(session, enrichedWebSearch);
      return;
    }
    const planReplay = prepareCodexPlanAssistantReplay(session, normalizedAssistant);
    normalizedAssistant = planReplay.message;
    if (planReplay.isDuplicate || deps.isDuplicateCodexAssistantReplay(session, normalizedAssistant)) {
      deps.syncSideChatParent?.(session);
      return;
    }
    if (hasVisibleTopLevelNonReasoningActivity(normalizedAssistant)) {
      clearCodexReasoningPreviewForVisibleActivity(session, activeRouteFromAssistant, deps);
    }
    outgoing = normalizedAssistant;
  }

  if (outgoing?.type === "assistant") {
    const transitionMarker = appendThreadTransitionMarkerForRouteSwitch(
      session.messageHistory,
      normalizeThreadRoute(outgoing.threadKey, outgoing.questId),
    );
    publishThreadTransitionMarker(session, transitionMarker, deps);
    session.messageHistory.push(outgoing);
    const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
      session,
      undefined,
      { messageId: outgoing.message.id, timestamp: outgoing.timestamp || Date.now() },
      hasLeaderRoutedActivityContent(outgoing.message.content) ? activeRouteFromAssistant : undefined,
    );
    if (statusUpdate.changed) deps.invalidateLeaderThreadTabsForSession?.(session.id);
    deps.persistSession(session);
    deps.syncSideChatParent?.(session);
  } else if (outgoing?.type === "result") {
    if (await maybeRecycleCodexLeaderForContextWindowExhaustion(session, outgoing, deps)) {
      return;
    }
    const codexTurnId = typeof outgoing.data.codex_turn_id === "string" ? outgoing.data.codex_turn_id : null;
    const completedTurn =
      codexTurnId && Array.isArray(session.pendingCodexTurns)
        ? ((session.pendingCodexTurns.find((turn: CodexOutboundTurn) => turn.turnId === codexTurnId) ??
            null) as CodexOutboundTurn | null)
        : ((session.pendingCodexTurns?.[0] ?? null) as CodexOutboundTurn | null);
    const resultInterrupted = isTerminalResultInterrupted(outgoing.data, {
      explicitInterrupted: outgoing.interrupted === true,
      sessionInterrupted: session.interruptedDuringTurn === true,
    });
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    const providerRecovery = decideCodexProviderResultRecovery(
      session,
      outgoing.data as CLIResultMessage,
      completedTurn,
    );
    const originalTurnId = completedTurn?.turnId ?? null;
    const wantsRetryTurn =
      !resultInterrupted && providerRecovery.kind === "recover" && providerRecovery.retryTurn && !!completedTurn;
    const retryTurn =
      wantsRetryTurn && completedTurn && providerRecovery.kind === "recover"
        ? prepareCodexTurnsForProviderRecovery(
            session,
            completedTurn,
            providerRecovery.family,
            providerRecovery.attempt,
            Date.now(),
          )
        : null;
    const retainTurnForRetry = retryTurn !== null;
    if (retainTurnForRetry) {
      deps.reconcileRecoveredQueuedTurnLifecycle?.(session, "codex_provider_result_retry");
    }
    if (
      !retainTurnForRetry &&
      !deps.completeCodexTurnsForResult(session, outgoing.data, Date.now(), resultInterrupted)
    ) {
      deps.syncSideChatParent?.(session);
      return;
    }

    let recoveryRequested = false;
    if (providerRecovery.kind === "recover") {
      recoveryRequested =
        deps.requestCodexProviderRecovery?.(
          session,
          `provider_result:${providerRecovery.family}:attempt_${providerRecovery.attempt}`,
        ) ?? false;
      if (recoveryRequested && retryTurn) {
        const retryState = setCodexProviderRetryState(
          session,
          {
            family: providerRecovery.family,
            ownerId: retryTurn.userMessageId,
            attempt: providerRecovery.attempt,
            maxAttempts: providerRecovery.maxAttempts,
            startedAt: Date.now(),
          },
          (state) =>
            deps.broadcastToBrowsers(session, {
              type: "session_update",
              session: { codex_provider_retry: state },
            }),
        );
        outgoing = {
          ...outgoing,
          data: { ...outgoing.data, codex_provider_retry: retryState },
        };
      } else {
        clearCodexProviderRetryState(session, retryTurn?.userMessageId ?? completedTurn?.userMessageId, (state) =>
          deps.broadcastToBrowsers(session, {
            type: "session_update",
            session: { codex_provider_retry: state },
          }),
        );
      }
      if (!recoveryRequested && retryTurn) {
        retryTurn.turnId = originalTurnId;
        deps.completeCodexTurnsForResult(session, outgoing.data, Date.now(), resultInterrupted);
      }
      deps.persistSession(session);
    } else {
      clearCodexProviderRetryState(session, completedTurn?.userMessageId, (state) =>
        deps.broadcastToBrowsers(session, {
          type: "session_update",
          session: { codex_provider_retry: state },
        }),
      );
    }
    clearOrphanedCodexProviderRetryState(session, (state) =>
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { codex_provider_retry: state },
      }),
    );

    deps.clearCodexFreshTurnRequirement(session, "codex_turn_completed", {
      completedTurnId: typeof outgoing.data.codex_turn_id === "string" ? outgoing.data.codex_turn_id : null,
    });
    deps.handleResultMessage(session, outgoing.data as CLIResultMessage);
    const recoverySummaryChanged =
      providerRecovery.kind === "recover" && recoveryRequested && retryTurn
        ? false
        : markCodexAutoPauseRecoveryTurnCompleted(
            session,
            retryTurn ?? completedTurn,
            outgoing.data.is_error === true,
            resultInterrupted,
            Date.now(),
            deps,
          );
    if (recoverySummaryChanged) {
      if (resultInterrupted) deps.freezeHistoryThroughCurrentTail(session);
      deps.persistSession(session);
    }
    deps.syncSideChatParent?.(session);
    const maybeAutoPause = deps.handleCodexResultErrorAutoPause(
      session,
      outgoing.data as CLIResultMessage,
      retryTurn ?? completedTurn,
      resultInterrupted,
    );
    if (maybeAutoPause instanceof Promise) {
      await maybeAutoPause;
    }
    if (providerRecovery.kind === "recover") {
      if (!recoveryRequested) {
        deps.broadcastToBrowsers(session, {
          type: "error",
          message:
            "Codex provider recovery could not start. Session state and queued input remain preserved; use Reconnect to retry.",
        });
      }
      return;
    }
    if (providerRecovery.kind === "terminal_model_not_supported" || providerRecovery.kind === "exhausted") {
      return;
    }
    if (!session.isGenerating) {
      deps.queueCodexPendingStartBatch(session, "codex_turn_completed");
    }
    deps.dispatchQueuedCodexTurns(session, "codex_turn_completed");
    deps.maybeFlushQueuedCodexMessages(session, "codex_turn_completed_non_user");
    return;
  }

  if (outgoing?.type === "permission_request") {
    const maybe = deps.handleCodexPermissionRequest(session, outgoing.request);
    if (maybe instanceof Promise) {
      await maybe;
    }
    outgoing = null;
  }

  if (await maybeRecycleCodexLeaderForContextWindowExhaustion(session, outgoing, deps)) {
    return;
  }

  if (outgoing) {
    deps.broadcastToBrowsers(session, outgoing);
    if (outgoing.type === "assistant") {
      updateActiveTurnRouteFromLeaderAssistant(session, activeRouteFromAssistant, deps);
    }
  }
}

export function flushQueuedMessagesToCodexAdapter(
  session: CodexBrowserMessageSessionLike,
  adapter: CodexBrowserMessageAdapterLike,
  reason: string,
  deps: Pick<CodexAdapterBrowserMessageDeps, "dispatchQueuedCodexTurns">,
): void {
  if (session.pendingMessages.length === 0) return;
  if (session.codexAdapter !== adapter) return;
  if (session.state.backend_state !== "connected") {
    console.log(
      `[ws-bridge] Deferring flush of ${session.pendingMessages.length} queued message(s) for session ${sessionTag(session.id)} until Codex session is connected (${reason})`,
    );
    return;
  }
  const queued = session.pendingMessages.splice(0);
  const stillQueued: string[] = [];
  const sendNow: BrowserOutgoingMessage[] = [];
  for (const raw of queued) {
    try {
      const msg = JSON.parse(raw) as BrowserOutgoingMessage;
      if (msg.type === "user_message") {
        console.warn(
          `[ws-bridge] Unexpected raw queued Codex user_message for session ${sessionTag(session.id)}; ` +
            "Codex user turns should only exist in pendingCodexTurns.",
        );
        stillQueued.push(raw);
        continue;
      }
      sendNow.push(msg);
    } catch {
      console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
      stillQueued.push(raw);
    }
  }
  session.pendingMessages = stillQueued;
  if (sendNow.length === 0) {
    if (stillQueued.length > 0) {
      console.log(
        `[ws-bridge] Deferring ${stillQueued.length} queued non-user message(s) for session ${sessionTag(session.id)} (${reason})`,
      );
    }
    deps.dispatchQueuedCodexTurns(session, `${reason}_after_pending_message_scan`);
    return;
  }
  console.log(
    `[ws-bridge] Flushing ${sendNow.length} queued message(s) to Codex adapter for session ${sessionTag(session.id)} (${reason})`,
  );
  for (const msg of sendNow) {
    try {
      adapter.sendBrowserMessage(msg);
    } catch {
      console.warn(`[ws-bridge] Failed to flush queued message for Codex session ${sessionTag(session.id)}`);
    }
  }
  deps.dispatchQueuedCodexTurns(session, `${reason}_after_non_user_flush`);
}
