import { describe, expect, expectTypeOf, it } from "vitest";
import { THREAD_MONITORING_PROJECTION, isThreadMonitoringProjectionValue } from "./thread-monitoring.js";
import {
  LEADER_THREAD_TABS_PROJECTION,
  LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
  isLeaderThreadTabsProjectionValue,
  leaderThreadTabsProjectionEqual,
  reconcileLeaderThreadTabsProjectionValue,
} from "./leader-thread-tabs-projection.js";
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
  isSessionNavigationProjectionValue,
  reconcileSessionNavigationProjectionValue,
  sessionNavigationProjectionEqual,
} from "./session-navigation-projection.js";
import {
  SYNCED_PROJECTION_DESCRIPTORS,
  SYNCED_PROJECTION_DESCRIPTOR_LIST,
  getSyncedProjectionDescriptor,
  isSyncedProjectionEligibleForSession,
  isSyncedProjectionId,
  type SyncedProjectionDescriptor,
  type SyncedProjectionRestEnvelopeFields,
} from "./synced-projection-registry.js";

describe("synchronized projection descriptor registry", () => {
  it("owns one ordered, unique inventory and REST mapping", () => {
    expect(SYNCED_PROJECTION_DESCRIPTOR_LIST.map((descriptor) => descriptor.projection)).toEqual([
      THREAD_MONITORING_PROJECTION,
      SESSION_ATTENTION_PROJECTION,
      SESSION_NAVIGATION_PROJECTION,
      LEADER_THREAD_TABS_PROJECTION,
    ]);
    expect(SYNCED_PROJECTION_DESCRIPTOR_LIST).toHaveLength(Object.keys(SYNCED_PROJECTION_DESCRIPTORS).length);
    expect(new Set(SYNCED_PROJECTION_DESCRIPTOR_LIST.map((descriptor) => descriptor.restField)).size).toBe(
      SYNCED_PROJECTION_DESCRIPTOR_LIST.length,
    );
    expect(SYNCED_PROJECTION_DESCRIPTOR_LIST.map((descriptor) => descriptor.restField)).toEqual([
      "threadMonitoringProjection",
      "sessionAttentionProjection",
      "sessionNavigationProjection",
      "leaderThreadTabsProjection",
    ]);
  });

  it("binds each literal projection ID to its validator, equality, reconciliation, and byte bound", () => {
    // New monitoring snapshots are a separate leader-only authority, not review/unread aliases.
    expect(SYNCED_PROJECTION_DESCRIPTORS[THREAD_MONITORING_PROJECTION]).toMatchObject({
      projection: THREAD_MONITORING_PROJECTION,
      isValue: isThreadMonitoringProjectionValue,
      subscriptionScope: "leader",
    });
    expect(SYNCED_PROJECTION_DESCRIPTORS[SESSION_ATTENTION_PROJECTION]).toMatchObject({
      projection: SESSION_ATTENTION_PROJECTION,
      isValue: isSessionAttentionProjectionValue,
      equal: sessionAttentionProjectionEqual,
      maxValueBytes: SESSION_ATTENTION_PROJECTION_MAX_VALUE_BYTES,
    });
    expect(SYNCED_PROJECTION_DESCRIPTORS[SESSION_NAVIGATION_PROJECTION]).toMatchObject({
      projection: SESSION_NAVIGATION_PROJECTION,
      isValue: isSessionNavigationProjectionValue,
      equal: sessionNavigationProjectionEqual,
      reconcile: reconcileSessionNavigationProjectionValue,
      maxValueBytes: SESSION_NAVIGATION_PROJECTION_MAX_VALUE_BYTES,
    });
    expect(SYNCED_PROJECTION_DESCRIPTORS[LEADER_THREAD_TABS_PROJECTION]).toMatchObject({
      projection: LEADER_THREAD_TABS_PROJECTION,
      isValue: isLeaderThreadTabsProjectionValue,
      equal: leaderThreadTabsProjectionEqual,
      reconcile: reconcileLeaderThreadTabsProjectionValue,
      maxValueBytes: LEADER_THREAD_TABS_PROJECTION_MAX_VALUE_BYTES,
    });
  });

  it("provides literal-preserving lookup and rejects unknown projection IDs", () => {
    const attentionDescriptor = getSyncedProjectionDescriptor(SESSION_ATTENTION_PROJECTION);
    expectTypeOf(attentionDescriptor).toEqualTypeOf<SyncedProjectionDescriptor<typeof SESSION_ATTENTION_PROJECTION>>();
    expect(attentionDescriptor).toBe(SYNCED_PROJECTION_DESCRIPTORS[SESSION_ATTENTION_PROJECTION]);
    expect(getSyncedProjectionDescriptor("unknown-projection")).toBeUndefined();
    expect(getSyncedProjectionDescriptor("__proto__")).toBeUndefined();
    expect(getSyncedProjectionDescriptor("constructor")).toBeUndefined();
    expect(isSyncedProjectionId(SESSION_NAVIGATION_PROJECTION)).toBe(true);
    expect(isSyncedProjectionId("unknown-projection")).toBe(false);
    expect(isSyncedProjectionId("__proto__")).toBe(false);
  });

  it("centralizes request eligibility without replacing server authorization", () => {
    const ordinarySession = { isOrchestrator: false };
    const leaderSession = { isOrchestrator: true };
    expect(
      isSyncedProjectionEligibleForSession(
        SYNCED_PROJECTION_DESCRIPTORS[SESSION_ATTENTION_PROJECTION],
        ordinarySession,
      ),
    ).toBe(true);
    expect(
      isSyncedProjectionEligibleForSession(
        SYNCED_PROJECTION_DESCRIPTORS[SESSION_NAVIGATION_PROJECTION],
        ordinarySession,
      ),
    ).toBe(true);
    expect(
      isSyncedProjectionEligibleForSession(
        SYNCED_PROJECTION_DESCRIPTORS[LEADER_THREAD_TABS_PROJECTION],
        ordinarySession,
      ),
    ).toBe(false);
    expect(
      isSyncedProjectionEligibleForSession(SYNCED_PROJECTION_DESCRIPTORS[LEADER_THREAD_TABS_PROJECTION], leaderSession),
    ).toBe(true);
  });

  it("reuses equal attention values and exposes typed REST envelope fields", () => {
    const previous: SessionAttentionProjectionValue = {
      attentionReason: "review",
      status: { urgency: "review", count: 1 },
    };
    const next: SessionAttentionProjectionValue = {
      attentionReason: "review",
      status: { urgency: "review", count: 1 },
    };
    const descriptor = SYNCED_PROJECTION_DESCRIPTORS[SESSION_ATTENTION_PROJECTION];
    expect(descriptor.reconcile(previous, next)).toBe(previous);

    const restFields: SyncedProjectionRestEnvelopeFields = {
      sessionAttentionProjection: {
        projection: SESSION_ATTENTION_PROJECTION,
        key: "session-1",
        generation: "generation-1",
        revision: 1,
        value: previous,
      },
    };
    expect(restFields.sessionAttentionProjection?.value).toBe(previous);
  });
});
