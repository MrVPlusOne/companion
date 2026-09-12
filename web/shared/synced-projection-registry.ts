import {
  SESSION_ATTENTION_PROJECTION,
  SESSION_ATTENTION_PROJECTION_MAX_VALUE_BYTES,
  isSessionAttentionProjectionValue,
  sessionAttentionProjectionEqual,
  type SessionAttentionProjectionValue,
} from "./session-attention-projection.js";
import {
  SESSION_NAVIGATION_PROJECTION,
  SESSION_NAVIGATION_PROJECTION_MAX_VALUE_BYTES,
  applySessionNavigationProjectionPatch,
  isSessionNavigationProjectionValue,
  reconcileSessionNavigationProjectionValue,
  sessionNavigationProjectionEqual,
  type SessionNavigationProjectionValue,
} from "./session-navigation-projection.js";
import {
  LEADER_THREAD_TABS_PROJECTION,
  LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
  applyLeaderThreadTabsProjectionPatch,
  isLeaderThreadTabsProjectionValue,
  leaderThreadTabsProjectionEqual,
  reconcileLeaderThreadTabsProjectionValue,
  type LeaderThreadTabsProjectionValue,
} from "./leader-thread-tabs-projection.js";
import { reconcileValue, type ValueEquality } from "./stable-reconciliation.js";
import type { SyncedProjectionEnvelope } from "./synced-projection.js";
import {
  THREAD_MONITORING_PROJECTION,
  THREAD_MONITORING_MAX_VALUE_BYTES,
  isThreadMonitoringProjectionValue,
  threadMonitoringProjectionEqual,
  type ThreadMonitoringProjectionValue,
} from "./thread-monitoring.js";

export interface SyncedProjectionValueById {
  [THREAD_MONITORING_PROJECTION]: ThreadMonitoringProjectionValue;
  [SESSION_ATTENTION_PROJECTION]: SessionAttentionProjectionValue;
  [SESSION_NAVIGATION_PROJECTION]: SessionNavigationProjectionValue;
  [LEADER_THREAD_TABS_PROJECTION]: LeaderThreadTabsProjectionValue;
}

export type SyncedProjectionId = keyof SyncedProjectionValueById;

export interface SyncedProjectionRestFieldById {
  [THREAD_MONITORING_PROJECTION]: "threadMonitoringProjection";
  [SESSION_ATTENTION_PROJECTION]: "sessionAttentionProjection";
  [SESSION_NAVIGATION_PROJECTION]: "sessionNavigationProjection";
  [LEADER_THREAD_TABS_PROJECTION]: "leaderThreadTabsProjection";
}

export type SyncedProjectionRestField = SyncedProjectionRestFieldById[SyncedProjectionId];
export type SyncedProjectionSubscriptionScope = "session" | "leader";

export interface SyncedProjectionDescriptor<K extends SyncedProjectionId> {
  projection: K;
  restField: SyncedProjectionRestFieldById[K];
  subscriptionScope: SyncedProjectionSubscriptionScope;
  maxValueBytes: number;
  isValue: (value: unknown) => value is SyncedProjectionValueById[K];
  equal: ValueEquality<SyncedProjectionValueById[K]>;
  reconcile: (
    previous: SyncedProjectionValueById[K] | undefined,
    next: SyncedProjectionValueById[K],
  ) => SyncedProjectionValueById[K];
  applyPatch?: (previous: SyncedProjectionValueById[K], patch: unknown) => SyncedProjectionValueById[K] | undefined;
}

/** Type-erased lookup shape used only after a projection ID crosses an unknown wire boundary. */
export interface AnySyncedProjectionDescriptor {
  projection: SyncedProjectionId;
  restField: SyncedProjectionRestField;
  subscriptionScope: SyncedProjectionSubscriptionScope;
  maxValueBytes: number;
  isValue: (value: unknown) => boolean;
  equal: (left: any, right: any) => boolean;
  reconcile: (previous: any, next: any) => unknown;
  applyPatch?: (previous: any, patch: unknown) => unknown;
}

export type SyncedProjectionEnvelopeFor<K extends SyncedProjectionId> = SyncedProjectionEnvelope<
  SyncedProjectionValueById[K]
> & { projection: K };

export type AnySyncedProjectionEnvelope = {
  [K in SyncedProjectionId]: SyncedProjectionEnvelopeFor<K>;
}[SyncedProjectionId];

export type SyncedProjectionRestEnvelopeFields = {
  [K in SyncedProjectionId as SyncedProjectionRestFieldById[K]]?: SyncedProjectionEnvelopeFor<K>;
};

function defineSyncedProjectionDescriptor<K extends SyncedProjectionId>(
  descriptor: SyncedProjectionDescriptor<K>,
): SyncedProjectionDescriptor<K> {
  return descriptor;
}

export const SYNCED_PROJECTION_DESCRIPTORS = {
  [THREAD_MONITORING_PROJECTION]: defineSyncedProjectionDescriptor({
    projection: THREAD_MONITORING_PROJECTION,
    restField: "threadMonitoringProjection",
    subscriptionScope: "leader",
    maxValueBytes: THREAD_MONITORING_MAX_VALUE_BYTES,
    isValue: isThreadMonitoringProjectionValue,
    equal: threadMonitoringProjectionEqual,
    reconcile: (previous, next) => reconcileValue(previous, next, threadMonitoringProjectionEqual),
  }),
  [SESSION_ATTENTION_PROJECTION]: defineSyncedProjectionDescriptor({
    projection: SESSION_ATTENTION_PROJECTION,
    restField: "sessionAttentionProjection",
    subscriptionScope: "session",
    maxValueBytes: SESSION_ATTENTION_PROJECTION_MAX_VALUE_BYTES,
    isValue: isSessionAttentionProjectionValue,
    equal: sessionAttentionProjectionEqual,
    reconcile: (previous, next) => reconcileValue(previous, next, sessionAttentionProjectionEqual),
  }),
  [SESSION_NAVIGATION_PROJECTION]: defineSyncedProjectionDescriptor({
    projection: SESSION_NAVIGATION_PROJECTION,
    restField: "sessionNavigationProjection",
    subscriptionScope: "session",
    maxValueBytes: SESSION_NAVIGATION_PROJECTION_MAX_VALUE_BYTES,
    isValue: isSessionNavigationProjectionValue,
    equal: sessionNavigationProjectionEqual,
    reconcile: reconcileSessionNavigationProjectionValue,
    applyPatch: applySessionNavigationProjectionPatch,
  }),
  [LEADER_THREAD_TABS_PROJECTION]: defineSyncedProjectionDescriptor({
    projection: LEADER_THREAD_TABS_PROJECTION,
    restField: "leaderThreadTabsProjection",
    subscriptionScope: "leader",
    maxValueBytes: LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
    isValue: isLeaderThreadTabsProjectionValue,
    equal: leaderThreadTabsProjectionEqual,
    reconcile: reconcileLeaderThreadTabsProjectionValue,
    applyPatch: applyLeaderThreadTabsProjectionPatch,
  }),
} satisfies { [K in SyncedProjectionId]: SyncedProjectionDescriptor<K> };

export const SYNCED_PROJECTION_DESCRIPTOR_LIST = Object.values(
  SYNCED_PROJECTION_DESCRIPTORS,
) as readonly AnySyncedProjectionDescriptor[];

export function isSyncedProjectionId(value: unknown): value is SyncedProjectionId {
  return typeof value === "string" && Object.hasOwn(SYNCED_PROJECTION_DESCRIPTORS, value);
}

export function getSyncedProjectionDescriptor<K extends SyncedProjectionId>(
  projection: K,
): SyncedProjectionDescriptor<K>;
export function getSyncedProjectionDescriptor(projection: string): AnySyncedProjectionDescriptor | undefined;
export function getSyncedProjectionDescriptor(projection: string): AnySyncedProjectionDescriptor | undefined {
  return isSyncedProjectionId(projection) ? SYNCED_PROJECTION_DESCRIPTORS[projection] : undefined;
}

export function isSyncedProjectionEligibleForSession(
  descriptor: AnySyncedProjectionDescriptor,
  session: { isOrchestrator: boolean },
): boolean {
  return descriptor.subscriptionScope === "session" || session.isOrchestrator;
}
