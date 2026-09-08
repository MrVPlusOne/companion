import type { LeaderThreadTextRole } from "../shared/thread-routing.js";
import type { ParsedThreadStatusMarker } from "../shared/thread-status-marker.js";

export const LEADER_THREAD_RESPONSE_VERSION = 2 as const;
export const LEGACY_LEADER_THREAD_RESPONSE_VERSION = 1 as const;

export type LeaderStoredThreadRole = LeaderThreadTextRole | "response";

export type LeaderAnswerTrackedUserMetadata = {
  /** Post-cutover direct-human messages participate in leader answer coverage. */
  leaderResponseCoverageVersion?: 1;
  /** Concise stable session-scoped ID exposed only in leader source envelopes. */
  leaderUserMessageId?: string;
  /** Stable session-scoped reference to one server-delivered timer firing. */
  leaderTimerMessageId?: string;
};

/** Control metadata retained on ordinary routed leader assistant rows until turn settlement. */
export type LeaderRoutedAssistantMetadata = {
  leaderThreadRole?: LeaderStoredThreadRole;
  leaderAnswerUserMessageIds?: string[];
  leaderAnswerObservedHistoryLength?: number;
  /** Read-only in-flight compatibility for turns created by the former `:F` model. */
  leaderResponseObservedHistoryLength?: number;
  deferredThreadStatusMarkers?: ParsedThreadStatusMarker[];
  threadAnswer?: LeaderThreadAnswerMetadata;
  /** Read-only compatibility for persisted server-defined response batches. */
  threadResponse?: LegacyLeaderThreadResponseRevisionMetadata;
};

/** Read-only compatibility shape for dedicated response rows persisted before routed answers. */
export interface LegacyLeaderThreadResponseMessage<Notification, ThreadReference, RoutingError> {
  type: "leader_user_message";
  content: string;
  timestamp: number;
  id: string;
  notification?: Notification;
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadReference[];
  threadRoutingError?: RoutingError;
  threadResponse?: LegacyLeaderThreadResponseRevisionMetadata;
}

/** Persisted metadata for the rejected server-defined batch/revision design. Never authored anew. */
export interface LegacyLeaderThreadResponseRevisionMetadata {
  logicalResponseId: string;
  revisionId: string;
  parentRevisionId?: string;
  revisionNumber: number;
  batchId: string;
  batchObservedHistoryLength: number;
  coveredUserMessageIds: string[];
  contentHash: string;
}

/** Immutable proof stored on one explicit routed leader answer. */
export interface LeaderThreadAnswerMetadata {
  version: typeof LEADER_THREAD_RESPONSE_VERSION;
  /** Explicit human (uN) or timer-message (timer-mN; retained legacy fN) references. */
  answerUserMessageIds: string[];
  observedHistoryLength: number;
  /** Original selected tab, retained independently of automatically derived visibility. */
  authoredThreadKey?: string;
  /** Per-request owners at settlement; later reassignment must not silently transfer answer authority. */
  ownerGroups?: Array<{ threadKey: string; userMessageIds: string[] }>;
}

export interface LeaderThreadOutcomeReminderGuardTarget {
  threadKey: string;
  earliestTimestamp: number;
  /** Pending-answer reminders retain the exact unresolved identity snapshot they describe. */
  pendingAnswerCount?: number;
  pendingAnswerUserMessageIds?: string[];
  /** Pending-answer reminders retain a rejected-Ready override for this target. */
  rejectedReady?: boolean;
  /** Pending-answer reminders retain correction-only wording for already-emitted rejected prose. */
  rejectedAnswerObserved?: boolean;
  /** Missing-needs-input reminders retain their exact detected prompt boundary. */
  promptTimestamp?: number;
}

/** Persisted server-only freshness proof for deferred Thread Outcome Reminder delivery. */
export interface LeaderThreadOutcomeReminderGuard {
  version: 1;
  pendingResponseTargets: LeaderThreadOutcomeReminderGuardTarget[];
  missingOutcomeTargets: LeaderThreadOutcomeReminderGuardTarget[];
  missingNeedsInputTargets: LeaderThreadOutcomeReminderGuardTarget[];
}

/** Compact answer-row pointer used by selected-thread presentation and coverage authority. */
export interface LeaderThreadResponseState {
  version: typeof LEADER_THREAD_RESPONSE_VERSION;
  /** Source route of the stored answer row; request ownership is independent. */
  threadKey: string;
  questId?: string;
  /** Complete concise ID list written in the answer marker. */
  answerUserMessageIds: string[];
  /** Complete raw history IDs originally referenced by this answer. */
  referencedUserMessageIds: string[];
  /** Current concise coverage owned by the projection's target thread. Explicit visibility-only rows may be empty. */
  coveredAnswerUserMessageIds: string[];
  /** Raw history IDs matching the answer's current per-ID coverage. Empty only for retained explicit rows. */
  coveredUserMessageIds: string[];
  currentMessageId: string;
  currentHistoryIndex: number;
  createdAt: number;
  updatedAt: number;
  source: "explicit" | "legacy";
}

/** Browser-only exact pending-message projection used for fail-closed presentation support. */
export interface LeaderThreadPendingMessageProjection {
  userMessageId: string;
  historyMessageId: string;
  historyIndex: number;
  askedAt: number;
}

export interface LeaderThreadResponseProjection {
  version: typeof LEADER_THREAD_RESPONSE_VERSION;
  /** Presentation target; current answer rows may retain another source route. */
  threadKey: string;
  cutoverHistoryIndex: number;
  pendingMessageCount: number;
  pendingMessages: LeaderThreadPendingMessageProjection[];
  /**
   * Chronological answer rows. Non-empty `covered*` fields are the sole
   * current coverage/Ready authority; fully superseded explicit rows remain
   * with empty `covered*` fields for presentation only.
   */
  currentAnswers: LeaderThreadResponseState[];
  ready: boolean;
}
