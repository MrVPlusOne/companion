import { randomUUID } from "node:crypto";
import { SESSION_ATTENTION_PROJECTION } from "../shared/session-attention-projection.js";
import {
  SESSION_NAVIGATION_PROJECTION,
  type SessionNavigationStatus,
} from "../shared/session-navigation-projection.js";
import {
  LEADER_THREAD_TABS_PROJECTION,
  LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
} from "../shared/leader-thread-tabs-projection.js";
import {
  SYNCED_PROJECTION_DESCRIPTOR_LIST,
  type SyncedProjectionEnvelopeFor,
  type SyncedProjectionId,
} from "../shared/synced-projection-registry.js";
import type {
  SyncedProjectionSnapshotMessage,
  SyncedProjectionSubscription,
  SyncedProjectionSubscriptionsAckMessage,
} from "../shared/synced-projection.js";
import { sendToBrowser, type BrowserTransportSocketLike } from "./bridge/browser-transport-controller.js";
import {
  applyLeaderServerCandidateThreadTabEvent,
  MAX_LEADER_OPEN_THREAD_TABS,
  normalizeLeaderOpenThreadTabsState,
} from "../shared/leader-open-thread-tabs.js";
import type { Session } from "./bridge/ws-bridge-session.js";
import type { BrowserIncomingMessage, ThreadTransitionMarker } from "./session-types.js";
import { hasConnectedCurrentBuildBrowserViewingThread } from "./bridge/browser-conversation-window-policy.js";
import { createSessionAttentionProjectionDefinition } from "./session-attention-projection.js";
import { createThreadMonitoringProjectionDefinition } from "./thread-monitoring-projection.js";
import {
  createLeaderThreadTabsProjectionDefinition,
  resolveLeaderThreadTabMutationPolicy,
} from "./leader-thread-tabs-projection.js";
import { collectMessageAttentionRecords } from "../shared/leader-projection.js";
import { createSessionNavigationProjectionDefinition } from "./session-navigation-projection.js";
import type { SdkSessionInfo } from "./session-info.js";
import { SyncedProjectionRuntime, type SyncedProjectionRuntimeMetrics } from "./synced-projection-runtime.js";

export interface WsBridgeSyncedProjectionDeps {
  getSession: (sessionId: string) => Session | undefined;
  listSessions: () => Iterable<Session>;
  getLauncherSessionInfo: (sessionId: string) => SdkSessionInfo | null | undefined;
  getSessionName: (sessionId: string) => string | undefined;
  getPendingTimerCount: (sessionId: string) => number;
  getBackendConnected: (sessionId: string) => boolean;
  getSessionStatus: (sessionId: string) => SessionNavigationStatus;
  getLastActivityAt: (sessionId: string) => number | undefined;
  getLastUserMessageAt: (sessionId: string) => number | undefined;
  getLastMessagePreviewAt: (sessionId: string) => number | undefined;
  persistSession?: (session: Session) => void;
}

const COMPLETED_QUEST_STATUSES = new Set(["done", "completed", "needs_verification"]);
const ACTIVE_ATTENTION_STATES = new Set(["unresolved", "seen", "reopened"]);

function leaderSessionReferencesQuest(session: Session, questIds: ReadonlySet<string>): boolean {
  const matches = (value: unknown) => typeof value === "string" && questIds.has(value.trim().toLowerCase());
  if (session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys.some(matches)) return true;

  for (const row of session.board.values()) {
    const status = row.status?.trim().toLowerCase() ?? "";
    if (row.completedAt === undefined && !COMPLETED_QUEST_STATUSES.has(status) && matches(row.questId)) return true;
  }
  for (const record of session.attentionRecords) {
    if (
      (ACTIVE_ATTENTION_STATES.has(record.state) ||
        (record.state === "muted" && record.type === "needs_input" && record.priority === "needs_input")) &&
      matches(record.route.threadKey || record.threadKey || record.questId)
    ) {
      return true;
    }
  }
  return session.notifications.some(
    (notification) => !notification.done && matches(notification.threadKey || notification.questId),
  );
}

function deferredLeaderThreadKeys(session: Session): Set<string> {
  const result = new Set<string>();
  for (const row of session.board.values()) {
    const questId = row.questId.trim().toLowerCase();
    const status = row.status?.trim().toLowerCase() ?? "";
    if (/^q-\d+$/.test(questId) && (status === "queued" || status === "proposed")) result.add(questId);
  }
  return result;
}

export class WsBridgeSyncedProjectionController {
  private readonly runtime: SyncedProjectionRuntime<BrowserTransportSocketLike>;

  constructor(private readonly deps: WsBridgeSyncedProjectionDeps) {
    this.runtime = new SyncedProjectionRuntime({
      generation: randomUUID(),
      maxValueBytes: LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
      onError: (error, context) => {
        console.warn(`[synced-projection] ${context.phase} failed for ${context.projection}/${context.key}:`, error);
      },
    });
    const authorizeSubscription = (_socket: BrowserTransportSocketLike, session: Session) =>
      this.isProjectionVisibleSession(session);
    this.runtime.register(
      createThreadMonitoringProjectionDefinition({
        getSession: deps.getSession,
        isLeaderSession: (session) => this.isLeaderSession(session),
        authorizeSubscription,
      }),
    );
    this.runtime.register(
      createSessionAttentionProjectionDefinition({
        getSession: deps.getSession,
        isHerdedWorkerSession: (session) => !!deps.getLauncherSessionInfo(session.id)?.herdedBy,
        authorizeSubscription,
      }),
    );
    this.runtime.register(
      createSessionNavigationProjectionDefinition({
        getSession: deps.getSession,
        getLauncherSessionInfo: deps.getLauncherSessionInfo,
        getSessionName: deps.getSessionName,
        getPendingTimerCount: deps.getPendingTimerCount,
        getBackendConnected: deps.getBackendConnected,
        getSessionStatus: deps.getSessionStatus,
        getLastActivityAt: deps.getLastActivityAt,
        getLastUserMessageAt: deps.getLastUserMessageAt,
        getLastMessagePreviewAt: deps.getLastMessagePreviewAt,
        authorizeSubscription,
      }),
    );
    this.runtime.register(
      createLeaderThreadTabsProjectionDefinition({
        getSession: deps.getSession,
        listSessions: deps.listSessions,
        isCurrentQuestSourceSession: (session) => this.isProjectionVisibleSession(session),
        isLeaderSession: (session) => this.isLeaderSession(session),
        authorizeSubscription,
      }),
    );
  }

  private isProjectionVisibleSession(session: Session): boolean {
    const launcherInfo = this.deps.getLauncherSessionInfo(session.id);
    return (
      launcherInfo?.hidden !== true &&
      launcherInfo?.archived !== true &&
      session.state.hidden !== true &&
      session.searchDataOnly !== true
    );
  }

  private isLeaderSession(session: Session): boolean {
    return (
      this.isProjectionVisibleSession(session) &&
      (session.state.isOrchestrator === true || this.deps.getLauncherSessionInfo(session.id)?.isOrchestrator === true)
    );
  }

  getLeaderThreadTabMutationPolicy(sessionId: string, threadKey: string) {
    const session = this.deps.getSession(sessionId);
    if (!session) return null;
    return resolveLeaderThreadTabMutationPolicy(session, threadKey, {
      sessions: this.deps.listSessions(),
      isCurrentQuestSourceSession: (candidate) => this.isProjectionVisibleSession(candidate),
      isCurrentQuestLeaderSession: (candidate) => this.isLeaderSession(candidate),
    });
  }

  private applyLeaderThreadTabPromotion(
    session: Session,
    threadKey: string,
    eventAt: number,
    options: Parameters<typeof applyLeaderServerCandidateThreadTabEvent>[3] = {},
    rejectWhenFull = false,
  ): boolean {
    const key = threadKey.trim().toLowerCase();
    if (!this.isLeaderSession(session) || !/^q-\d+$/.test(key) || !Number.isFinite(eventAt) || eventAt < 0) {
      return false;
    }
    const current = normalizeLeaderOpenThreadTabsState(session.state.leaderOpenThreadTabs);
    if (
      rejectWhenFull &&
      !current?.orderedOpenThreadKeys.includes(key) &&
      (current?.orderedOpenThreadKeys.length ?? 0) >= MAX_LEADER_OPEN_THREAD_TABS
    ) {
      return false;
    }
    const next = applyLeaderServerCandidateThreadTabEvent(current, key, eventAt, options);
    if (!next || next === current) return false;
    session.state = { ...session.state, leaderOpenThreadTabs: next };
    this.runtime.invalidate(LEADER_THREAD_TABS_PROJECTION, session.id);
    this.deps.persistSession?.(session);
    return true;
  }

  private promoteLeaderThreadTabForServerCandidate(session: Session, threadKey: string, eventAt: number): boolean {
    const policy = this.getLeaderThreadTabMutationPolicy(session.id, threadKey);
    return policy?.scheduled || policy?.completed
      ? false
      : this.applyLeaderThreadTabPromotion(session, threadKey, eventAt, { repositionExisting: true }, true);
  }

  promoteLeaderThreadTabForAttachment(sessionId: string, threadKey: string, attachedAt: number): boolean {
    const session = this.deps.getSession(sessionId);
    return session ? this.promoteLeaderThreadTabForServerCandidate(session, threadKey, attachedAt) : false;
  }

  promoteLeaderThreadTabForTransition(sessionId: string, marker: ThreadTransitionMarker): boolean {
    const session = marker.targetThreadFreshness === "new_quest_thread" ? this.deps.getSession(sessionId) : undefined;
    if (!session || !hasConnectedCurrentBuildBrowserViewingThread(session.browserSockets, marker.sourceThreadKey)) {
      return false;
    }
    return this.promoteLeaderThreadTabForServerCandidate(session, marker.threadKey, marker.transitionedAt);
  }

  invalidateSession(session: Session): void {
    this.runtime.transaction(() => {
      for (const descriptor of SYNCED_PROJECTION_DESCRIPTOR_LIST) {
        this.runtime.invalidate(descriptor.projection, session.id);
      }
    });
  }

  invalidateSessionNavigation(session: Session): void {
    this.runtime.invalidate(SESSION_NAVIGATION_PROJECTION, session.id);
  }

  invalidateLeaderThreadTabsForSession(sessionId: string): boolean {
    const session = this.deps.getSession(sessionId);
    return !!session && this.isLeaderSession(session)
      ? this.runtime.invalidate(LEADER_THREAD_TABS_PROJECTION, session.id)
      : false;
  }

  promoteLeaderThreadTabForAttention(
    sessionId: string,
    threadKey: string,
    eventAt: number,
    kind: "primary" | "review",
  ): boolean {
    const session = this.deps.getSession(sessionId);
    if (!session) return false;
    const key = threadKey.trim().toLowerCase();
    const policy = this.getLeaderThreadTabMutationPolicy(session.id, key);
    // Scheduled work stays low, and already-open active work keeps manual order.
    if (
      policy?.neverStartedScheduled ||
      (policy?.inMotion &&
        normalizeLeaderOpenThreadTabsState(session.state.leaderOpenThreadTabs)?.orderedOpenThreadKeys.includes(key))
    ) {
      return false;
    }
    const review = kind === "review";
    return this.applyLeaderThreadTabPromotion(session, key, eventAt, {
      repositionExisting: true,
      placement: review ? "before" : "first",
      ...(review ? { beforeThreadKeys: deferredLeaderThreadKeys(session) } : {}),
      allowTombstoneReopen: policy?.scheduled !== true,
    });
  }

  promoteLeaderThreadTabForMessageAttention(
    sessionId: string,
    message: Extract<BrowserIncomingMessage, { type: "user_message" }>,
  ): boolean {
    const record = collectMessageAttentionRecords(sessionId, [message]).find(
      (candidate) => candidate.type === "quest_reopened_or_rework",
    );
    if (!record) return false;
    return this.promoteLeaderThreadTabForAttention(sessionId, record.route.threadKey, record.updatedAt, "primary");
  }

  promoteLeaderThreadTabForQuest(questId: string, eventAt: number, _sourceSessionId: string): number {
    const normalizedQuestId = questId.trim().toLowerCase();
    if (!/^q-\d+$/.test(normalizedQuestId) || !Number.isFinite(eventAt) || eventAt < 0) return 0;
    const questIds = new Set([normalizedQuestId]);
    let changed = 0;

    for (const session of this.deps.listSessions()) {
      if (!this.isLeaderSession(session) || !leaderSessionReferencesQuest(session, questIds)) continue;
      if (this.applyLeaderThreadTabPromotion(session, normalizedQuestId, eventAt, { repositionExisting: true })) {
        changed += 1;
      }
    }
    return changed;
  }

  invalidateLeaderThreadTabsForSessionQuestState(sessionId: string): number {
    const session = this.deps.getSession(sessionId);
    return session
      ? this.invalidateLeaderThreadTabsForQuestIds([
          session.state.claimedQuestId ?? "",
          ...session.board.keys(),
          ...session.completedBoard.keys(),
        ])
      : 0;
  }

  invalidateLeaderThreadTabsForQuestIds(questIds: Iterable<string>): number {
    const normalizedQuestIds = new Set(
      [...questIds].map((questId) => questId.trim().toLowerCase()).filter((questId) => /^q-\d+$/.test(questId)),
    );
    if (normalizedQuestIds.size === 0) return 0;

    let invalidated = 0;
    this.runtime.transaction(() => {
      for (const session of this.deps.listSessions()) {
        if (
          !this.isLeaderSession(session) ||
          !this.runtime.hasSubscribers(LEADER_THREAD_TABS_PROJECTION, session.id) ||
          !leaderSessionReferencesQuest(session, normalizedQuestIds)
        ) {
          continue;
        }
        if (this.runtime.invalidate(LEADER_THREAD_TABS_PROJECTION, session.id)) invalidated += 1;
      }
    });
    return invalidated;
  }

  invalidateAllSessions(): void {
    this.runtime.transaction(() => {
      for (const session of this.deps.listSessions()) this.invalidateSession(session);
    });
  }

  getSnapshot<K extends SyncedProjectionId>(projection: K, sessionId: string): SyncedProjectionEnvelopeFor<K> | null {
    return this.runtime.getSnapshot(projection, sessionId) as SyncedProjectionEnvelopeFor<K> | null;
  }

  replaceSubscriptions(
    socket: BrowserTransportSocketLike,
    subscriptions: readonly SyncedProjectionSubscription[],
  ): Array<SyncedProjectionSnapshotMessage | SyncedProjectionSubscriptionsAckMessage> {
    const replacement = this.runtime.replaceSubscriptions(socket, subscriptions, (subscriber, envelope) => {
      if (!sendToBrowser(subscriber, { type: "synced_projection_update", ...envelope })) {
        throw new Error("Synced projection subscriber is not sendable");
      }
    });
    return [
      ...replacement.snapshots.map((envelope) => ({ type: "synced_projection_snapshot" as const, ...envelope })),
      {
        type: "synced_projection_subscriptions_ack",
        subscriptions: replacement.acceptedSubscriptions,
        complete: true,
      },
    ];
  }

  resync(socket: BrowserTransportSocketLike, projection: string, key: string): SyncedProjectionSnapshotMessage | null {
    const envelope = this.runtime.resync(socket, projection, key);
    return envelope ? { type: "synced_projection_snapshot", ...envelope } : null;
  }

  removeSubscriber(socket: BrowserTransportSocketLike): void {
    this.runtime.removeSubscriber(socket);
  }

  hasSubscription(socket: BrowserTransportSocketLike, projection: string, key: string): boolean {
    return this.runtime.hasSubscription(socket, projection, key);
  }

  hasSessionNavigationSubscription(socket: BrowserTransportSocketLike, sessionId: string): boolean {
    return this.hasSubscription(socket, SESSION_NAVIGATION_PROJECTION, sessionId);
  }

  removeSession(sessionId: string): void {
    for (const descriptor of SYNCED_PROJECTION_DESCRIPTOR_LIST) {
      this.runtime.removeKey(descriptor.projection, sessionId);
    }
  }

  getMetrics(): Readonly<SyncedProjectionRuntimeMetrics> {
    return this.runtime.getMetrics();
  }

  flushForTest(): Promise<void> {
    return this.runtime.flushForTest();
  }
}
