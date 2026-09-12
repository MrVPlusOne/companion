import type { ConversationAnnotation } from "../shared/conversation-annotations.js";
import type { ImageRef } from "./image-store.js";
import type { ReplyContext } from "../shared/reply-context.js";
import type { CodexAutoPauseRecoveryLink } from "./codex-auto-pause-types.js";
import type { CodexAutoPauseInputSourceKind } from "./codex-outbound-turn-types.js";
import type { LeaderThreadOutcomeReminderGuard } from "./leader-thread-response-types.js";
import type { TimerFiring } from "./timer-types.js";
import type { TakodeHerdBatchSnapshot, ThreadRef, VsCodeSelectionMetadata } from "./session-types.js";

export interface PendingCodexInputImageDraft {
  name: string;
  base64: string;
  mediaType: string;
}

export interface ProgrammaticHistoryFollowUp {
  content: string;
  agentSource?: { sessionId: string; sessionLabel?: string };
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}

export type CodexPendingInputDeliveryState = "failed";
export type CodexPendingInputFailureReason = "pending_input_too_large" | "nonrecoverable_turn_start";

export interface PendingCodexInput {
  id: string;
  clientMsgId?: string;
  content: string;
  /** Original UTF-8 byte length when content is compacted for browser sync. */
  contentBytes?: number;
  timestamp: number;
  cancelable: boolean;
  imageRefs?: ImageRef[];
  draftImages?: PendingCodexInputImageDraft[];
  deliveryContent?: string;
  /** Original UTF-8 byte length when deliveryContent is compacted for browser sync. */
  deliveryContentBytes?: number;
  /** Server-only visible/history entries committed after this model-bound input. */
  historyFollowUps?: ProgrammaticHistoryFollowUp[];
  /** True only for browser-facing compact snapshots, never for model delivery state. */
  payloadTruncated?: boolean;
  annotations?: ConversationAnnotation[];
  replyContext?: ReplyContext;
  needsInputReminderText?: string;
  needsInputResolutionNoticeText?: string;
  needsInputResolutionNoticeIds?: string[];
  agentSource?: { sessionId: string; sessionLabel?: string };
  takodeHerdBatch?: TakodeHerdBatchSnapshot;
  vscodeSelection?: VsCodeSelectionMetadata;
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
  slackThreadId?: string;
  recentAskBoundaryBefore?: "visible_response";
  leaderResponseCoverageVersion?: 1;
  leaderUserMessageId?: string;
  /** Retains the same firing reference through queueing, receipt, and recovery. */
  leaderTimerMessageId?: string;
  /** Original server-only occurrence proof, including any retained firing reference. */
  timerFiring?: TimerFiring;
  /** Server-only source classification used by Codex result-error auto-pause. */
  autoPauseSourceKind?: CodexAutoPauseInputSourceKind;
  /** Server-only correlation for a held input released into normal Codex delivery. */
  autoPauseRecoveries?: CodexAutoPauseRecoveryLink[];
  /** Server-only freshness proof for a deferred Thread Outcome Reminder. */
  leaderThreadOutcomeReminderGuard?: LeaderThreadOutcomeReminderGuard;
  /** Server-only FIFO insertion target for a separately owned recovery continuation. */
  queueBeforeOwnerId?: string;
  /** Server-only boundary that keeps later work out of the recovery continuation turn. */
  requireFreshSuccessor?: boolean;
  /** Persisted terminal delivery state; absence means the input is still deliverable. */
  deliveryState?: CodexPendingInputDeliveryState;
  failureReason?: Extract<CodexPendingInputFailureReason, "nonrecoverable_turn_start">;
  /** Fixed browser-safe guidance, never raw provider error text. */
  failureMessage?: string;
  failedAt?: number;
}

export interface CodexPendingBatchInput {
  content: string;
  vscodeSelection?: VsCodeSelectionMetadata;
}
