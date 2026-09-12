import { access as accessAsync } from "node:fs/promises";
import { stripInternalLauncherSessionState, type CliLauncher } from "../cli-launcher.js";
import {
  getNotificationStatusSnapshot,
  summarizePendingPermissions,
  type NotificationStatusSnapshot,
} from "../bridge/session-registry-controller.js";
import { getSettings } from "../settings-manager.js";
import type { TimerManager } from "../timer-manager.js";
import type { WsBridge } from "../ws-bridge.js";
import { computeSessionTurnMetrics } from "../user-message-classification.js";
import { getLeaderProfilePortraitForSession } from "../leader-profile-assignments.js";
import { buildLeaderActivePhaseSummary } from "../../shared/leader-active-phase-summary.js";
import { getBoard as getBoardController } from "../bridge/board-watchdog-controller.js";
import { projectSessionLifecycleEvents } from "../session-lifecycle-projection.js";
import { SESSION_ATTENTION_PROJECTION } from "../../shared/session-attention-projection.js";
import {
  SESSION_NAVIGATION_PROJECTION,
  sessionNavigationProjectionToSessionFields,
} from "../../shared/session-navigation-projection.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../shared/leader-thread-tabs-projection.js";
import {
  SYNCED_PROJECTION_DESCRIPTORS,
  type SyncedProjectionRestEnvelopeFields,
} from "../../shared/synced-projection-registry.js";
import { THREAD_MONITORING_PROJECTION } from "../../shared/thread-monitoring.js";

type SessionListEntry = ReturnType<CliLauncher["listSessions"]>[number];
const scheduledWorktreeGitStateRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

export interface BuildEnrichedSessionsSnapshotDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  timerManager?: Pick<TimerManager, "listTimers">;
  getSessionName?: (sessionId: string) => string | undefined;
  pendingWorktreeCleanups?: Map<string, Promise<void>>;
}

export function scheduleWorktreeGitStateRefreshForSnapshot(
  wsBridge: Pick<WsBridge, "refreshWorktreeGitStateForSnapshot">,
  sessionId: string,
): void {
  if (scheduledWorktreeGitStateRefreshes.has(sessionId)) return;
  const timer = setTimeout(() => {
    scheduledWorktreeGitStateRefreshes.delete(sessionId);
    try {
      void Promise.resolve(
        wsBridge.refreshWorktreeGitStateForSnapshot(sessionId, {
          broadcastUpdate: true,
          notifyPoller: true,
        }),
      ).catch((error) => {
        console.warn(`[routes] Background worktree git refresh failed for ${sessionId}:`, error);
      });
    } catch (error) {
      console.warn(`[routes] Background worktree git refresh failed for ${sessionId}:`, error);
    }
  }, 0);
  scheduledWorktreeGitStateRefreshes.set(sessionId, timer);
}

export function _resetScheduledWorktreeGitStateRefreshesForTest(): void {
  for (const timer of scheduledWorktreeGitStateRefreshes.values()) {
    clearTimeout(timer);
  }
  scheduledWorktreeGitStateRefreshes.clear();
}

export function buildLeaderActivePhaseSummaryForSnapshot(isOrchestrator: boolean | undefined, bridgeSession: unknown) {
  const board = buildLeaderActiveBoardRowsForSnapshot(isOrchestrator, bridgeSession);
  if (board === undefined) return undefined;
  return buildLeaderActivePhaseSummary(board);
}

export function buildLeaderActiveBoardRowsForSnapshot(isOrchestrator: boolean | undefined, bridgeSession: unknown) {
  if (isOrchestrator !== true) return undefined;
  return hasBoardState(bridgeSession)
    ? getBoardController(bridgeSession as Parameters<typeof getBoardController>[0])
    : [];
}

function hasBoardState(bridgeSession: unknown): boolean {
  return (
    bridgeSession !== null &&
    typeof bridgeSession === "object" &&
    (bridgeSession as { board?: unknown }).board instanceof Map
  );
}

export async function buildEnrichedSessionsSnapshot(
  deps: BuildEnrichedSessionsSnapshotDeps,
  filterFn?: (session: SessionListEntry) => boolean,
) {
  const { launcher, wsBridge, pendingWorktreeCleanups } = deps;
  const sessions = launcher.listSessions().filter((session) => session.hidden !== true);
  const pool = filterFn ? sessions.filter(filterFn) : sessions;
  return buildEnrichedSessionsSnapshotFromEntries(deps, pool);
}

export async function buildEnrichedSessionsSnapshotFromEntries(
  deps: BuildEnrichedSessionsSnapshotDeps,
  pool: SessionListEntry[],
) {
  const { launcher, wsBridge, pendingWorktreeCleanups } = deps;
  const settings = getSettings();
  const heavyRepoModeEnabled = settings.heavyRepoModeEnabled;
  return Promise.all(
    pool.map(async (session) => {
      let s = session;
      let notificationSummary: NotificationStatusSnapshot = {
        notificationUrgency: null,
        activeNotificationCount: 0,
        activeNeedsInputNotificationCount: 0,
        activeReviewNotificationCount: 0,
        mutedNeedsInputNotificationCount: 0,
        notificationStatusVersion: 0,
        notificationStatusUpdatedAt: 0,
      };
      try {
        if (
          pendingWorktreeCleanups &&
          s.worktreeCleanupStatus === "pending" &&
          !pendingWorktreeCleanups.has(s.sessionId)
        ) {
          launcher.setWorktreeCleanupState(s.sessionId, {
            status: "failed",
            error: s.worktreeCleanupError || "Cleanup was interrupted before completion.",
            startedAt: s.worktreeCleanupStartedAt,
            finishedAt: Date.now(),
          });
          s = launcher.getSession(s.sessionId) ?? s;
        }

        const { codexLeaderRecycleThresholdTokens: _hiddenControlThreshold, ...safeSession } =
          stripInternalLauncherSessionState(s);
        const bridgeSession = wsBridge.getSession(s.sessionId);
        const projectionController =
          bridgeSession && !safeSession.archived ? wsBridge.getSyncedProjectionController?.() : undefined;
        const projectionFields: SyncedProjectionRestEnvelopeFields = {};
        const sessionAttentionProjection =
          projectionController?.getSnapshot?.(SESSION_ATTENTION_PROJECTION, s.sessionId) ?? null;
        if (sessionAttentionProjection) {
          projectionFields[SYNCED_PROJECTION_DESCRIPTORS[SESSION_ATTENTION_PROJECTION].restField] =
            sessionAttentionProjection;
        }
        // Herded worker notifications route through the leader/board flow and
        // should not create direct user-facing sidebar markers for the worker.
        notificationSummary =
          bridgeSession && !safeSession.herdedBy ? getNotificationStatusSnapshot(bridgeSession) : notificationSummary;
        if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
          scheduleWorktreeGitStateRefreshForSnapshot(wsBridge, s.sessionId);
        }
        const currentBridgeSession = wsBridge.getSession(s.sessionId) ?? bridgeSession;
        const bridge = currentBridgeSession?.state;
        const leaderThreadTabsProjection =
          safeSession.isOrchestrator === true || bridge?.isOrchestrator === true
            ? (projectionController?.getSnapshot?.(LEADER_THREAD_TABS_PROJECTION, s.sessionId) ?? null)
            : null;
        if (leaderThreadTabsProjection) {
          projectionFields[SYNCED_PROJECTION_DESCRIPTORS[LEADER_THREAD_TABS_PROJECTION].restField] =
            leaderThreadTabsProjection;
        }
        const threadMonitoringProjection = leaderThreadTabsProjection
          ? projectionController?.getSnapshot?.(THREAD_MONITORING_PROJECTION, s.sessionId)
          : null;
        if (threadMonitoringProjection) projectionFields.threadMonitoringProjection = threadMonitoringProjection;
        const turnMetrics = currentBridgeSession
          ? computeSessionTurnMetrics(currentBridgeSession.messageHistory)
          : null;
        if (bridge && turnMetrics) {
          const turnMetricsChanged =
            bridge.user_turn_count !== turnMetrics.userTurnCount ||
            bridge.agent_turn_count !== turnMetrics.agentTurnCount ||
            bridge.num_turns !== turnMetrics.userTurnCount;
          bridge.user_turn_count = turnMetrics.userTurnCount;
          bridge.agent_turn_count = turnMetrics.agentTurnCount;
          bridge.num_turns = turnMetrics.userTurnCount;
          if (turnMetricsChanged && currentBridgeSession) {
            projectionController?.invalidateSessionNavigation?.(currentBridgeSession);
          }
        }
        // Navigation snapshots consume the repaired history-backed turn metrics.
        // When repair changed authority, invalidation above makes getSnapshot
        // publish the new revision to established subscribers before returning it.
        const sessionNavigationProjection =
          projectionController?.getSnapshot?.(SESSION_NAVIGATION_PROJECTION, s.sessionId) ?? null;
        if (sessionNavigationProjection) {
          projectionFields[SYNCED_PROJECTION_DESCRIPTORS[SESSION_NAVIGATION_PROJECTION].restField] =
            sessionNavigationProjection;
        }
        // Persisted archived rows and a narrow pre-restore window have no live
        // projection authority. Preserve only the independent durable/list
        // metadata needed to identify those rows; do not rebuild the full
        // navigation model from bridge, git, history, or status sources.
        const navigationFields = sessionNavigationProjection
          ? sessionNavigationProjectionToSessionFields(sessionNavigationProjection.value)
          : {
              sessionNum: launcher.getSessionNum(s.sessionId) ?? safeSession.sessionNum,
              name: deps.getSessionName?.(s.sessionId) ?? safeSession.name,
              pendingTimerCount:
                deps.timerManager?.listTimers(s.sessionId).length ?? safeSession.pendingTimerCount ?? 0,
            };
        const attention = currentBridgeSession
          ? {
              lastReadAt: currentBridgeSession.lastReadAt,
              attentionReason: currentBridgeSession.attentionReason,
              pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
            }
          : null;
        const leaderProfilePortrait = getLeaderProfilePortraitForSession(
          safeSession,
          settings.leaderProfilePools,
          (portraitId) => launcher.setLeaderProfilePortraitId(s.sessionId, portraitId),
        );
        const leaderProfilePortraitId =
          leaderProfilePortrait && leaderProfilePortrait.poolId !== "fallback"
            ? leaderProfilePortrait.id
            : (safeSession.leaderProfilePortraitId ?? null);
        return {
          ...safeSession,
          ...navigationFields,
          sessionLifecycleEvents: projectSessionLifecycleEvents(bridge?.lifecycle_events),
          leaderProfilePortraitId,
          ...(leaderProfilePortrait ? { leaderProfilePortrait } : {}),
          ...(bridge?.codex_token_details ? { codexTokenDetails: bridge.codex_token_details } : {}),
          ...(bridge?.claude_token_details ? { claudeTokenDetails: bridge.claude_token_details } : {}),
          taskHistory: currentBridgeSession?.taskHistory ?? [],
          keywords: currentBridgeSession?.keywords ?? [],
          pause: bridge?.pause ?? null,
          codexResultErrorAutoPause: bridge?.codex_result_error_auto_pause ?? null,
          codexAutoPausedInputCount:
            bridge?.codex_result_error_auto_pause?.heldInputs.reduce(
              (total, item) => total + Math.max(1, item.count),
              0,
            ) ?? 0,
          ...notificationSummary,
          ...projectionFields,
          ...(attention ?? {}),
          ...(s.isWorktree && s.archived ? { worktreeExists: await archivedWorktreeExists(s.cwd) } : {}),
        };
      } catch (e) {
        console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
        const safeSession = stripInternalLauncherSessionState(s);
        return {
          ...safeSession,
          sessionNum: launcher.getSessionNum(s.sessionId) ?? safeSession.sessionNum,
          name: deps.getSessionName?.(s.sessionId) ?? safeSession.name,
          pendingTimerCount: deps.timerManager?.listTimers(s.sessionId).length ?? safeSession.pendingTimerCount ?? 0,
          ...notificationSummary,
        };
      }
    }),
  );
}

export async function archivedWorktreeExists(cwd: string): Promise<boolean> {
  try {
    await accessAsync(cwd);
    return true;
  } catch {
    return false;
  }
}
