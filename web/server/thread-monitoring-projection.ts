import { THREAD_MONITORING_PROJECTION, type ThreadMonitoringProjectionValue } from "../shared/thread-monitoring.js";
import { SYNCED_PROJECTION_DESCRIPTORS } from "../shared/synced-projection-registry.js";
import type { Session } from "./bridge/ws-bridge-session.js";
import type { SyncedProjectionDefinition } from "./synced-projection-runtime.js";

export function buildThreadMonitoringProjection(session: {
  state: Pick<Session["state"], "threadMonitoring" | "leaderOpenThreadTabs">;
}): ThreadMonitoringProjectionValue {
  const monitoring = session.state.threadMonitoring;
  const monitors = monitoring?.threads ?? {};
  const open = session.state.leaderOpenThreadTabs?.orderedOpenThreadKeys ?? [];
  return {
    revision: monitoring?.revision ?? 0,
    alertVersion: monitoring?.alertVersion ?? 0,
    trackedCount: Object.keys(monitors).length,
    pendingCount: Object.values(monitors).filter((monitor) => monitor.pending !== null).length,
    threads: Object.fromEntries(
      open
        .slice(0, 50)
        .filter((key) => monitors[key])
        .map((key) => [key, { pendingResultId: monitors[key].pending?.id ?? null }]),
    ),
  };
}

export function createThreadMonitoringProjectionDefinition<TSubscriber>(deps: {
  getSession: (sessionId: string) => Session | undefined;
  isLeaderSession: (session: Session) => boolean;
  authorizeSubscription: (subscriber: TSubscriber, session: Session) => boolean;
}): SyncedProjectionDefinition<Session, readonly unknown[], ThreadMonitoringProjectionValue, TSubscriber> {
  const descriptor = SYNCED_PROJECTION_DESCRIPTORS[THREAD_MONITORING_PROJECTION];
  return {
    projection: descriptor.projection,
    dependencies: ["thread-monitoring", "leader-open-thread-tabs"],
    resolveSource: deps.getSession,
    selectDependencies: (session) => [session.state.threadMonitoring, session.state.leaderOpenThreadTabs],
    dependenciesEqual: (left, right) => left[0] === right[0] && left[1] === right[1],
    derive: buildThreadMonitoringProjection,
    valueEqual: descriptor.equal,
    authorizeSubscription: (subscriber, _key, session) =>
      deps.isLeaderSession(session) && deps.authorizeSubscription(subscriber, session),
    maxValueBytes: descriptor.maxValueBytes,
  };
}
