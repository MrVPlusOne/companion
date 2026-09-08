import type {
  BoardParticipantStatus,
  BoardRow,
  BoardRowSessionStatus,
  BrowserSessionState as SessionState,
  BackendReconnectProgress,
  CodexAppReference,
  CodexSkillReference,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  ToolResultPreview,
  SessionTaskEntry,
  HistoryWindowState,
  InitialThreadWindowRequest,
  LeaderProjectionSnapshot,
  LeaderProjectionThreadRow,
  LeaderProjectionThreadSummary,
  LeaderThreadResponseProjection,
  LeaderThreadAnswerMetadata,
  LegacyLeaderThreadResponseRevisionMetadata,
  LeaderThreadResponseState,
  LeaderStoredThreadRole,
  LeaderThreadTextRole,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  CodexAutoPauseHeldInput,
  CodexAutoPauseRecoveryProgress,
  CodexResultErrorAutoPauseState,
  CodexResultErrorFamily,
  CodexAutoPauseRecoveryOutcome,
  CodexAutoPauseRecoveryReceipt,
  CodexAutoPauseRecoverySummary,
  VsCodeSelectionMetadata,
  VsCodeSelectionState,
  SessionNotification,
  ThreadOutcomeReminderSatisfaction,
  SessionAttentionRecord,
  SessionAttentionRecordPriority,
  SessionAttentionRecordRoute,
  SessionAttentionRecordState,
  SessionAttentionRecordType,
  StarredMessageRecord,
  SessionLifecycleEvent,
  CodexContextWindowDiagnostics,
  ActiveTurnRoute,
  ActiveCodexReasoningPreview,
  SideChatRecord,
  SideChatChildState,
  SideChatContextStrategy,
  SideChatFallbackMode,
  SideChatFallbackReasonCode,
  SideChatFallbackEligibility,
  SideChatNativeEligibility,
  SideChatPreflight,
  SlackThreadRecord,
  SlackThreadChildState,
  ThreadRef,
  ThreadAttachmentMarker,
  ThreadAttachmentMovementSummary,
  ThreadAttachmentUpdate,
  ThreadAttachmentUpdateChangedMessage,
  ThreadAttachmentUpdateEntry,
  ThreadTransitionMarker,
  ThreadWindowEntry,
  ThreadWindowState,
  ThreadRoutingError,
  PausedInboundMessage,
  SessionPauseState,
  TakodeHerdEventBrowserMetadata,
} from "../server/session-types.js";
import type { CodexMessagePhase } from "../shared/codex-message-phase.js";
import { assertNever, isClaudeFamily } from "../server/session-types.js";
import type { ImageRef } from "../server/image-store.js";
import type { SessionTimer } from "../server/timer-types.js";
import type { ReplyContext } from "../shared/reply-context.js";
import type { LeaderThreadStatus } from "../shared/thread-status-marker.js";
import type { ModelAuthorityDecision, ModelProvenanceMigration } from "../server/model-identity-contract.js";
import type { LeaderProfilePool, LeaderProfilePoolSettings } from "../shared/leader-profile-portraits.js";
import type {
  QuestmasterTask,
  QuestListPreview,
  QuestListPreviewFeedbackSummary,
  QuestListPreviewProgress,
  QuestListPreviewPhaseLine,
  QuestAutocompleteCandidate,
  QuestTitlePreview,
  QuestTitlePreviewResponse,
  QuestStatus,
  QuestVerificationItem,
  QuestQuizItem,
  QuestFeedbackEntry,
  QuestRelatedQuest,
  QuestRelatedQuestKind,
  QuestImage,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
  QuestHistoryView,
} from "../server/quest-types.js";

export type {
  BoardParticipantStatus,
  BoardRow,
  BoardRowSessionStatus,
  SessionState,
  BackendReconnectProgress,
  CodexAppReference,
  CodexSkillReference,
  PermissionRequest,
  ContentBlock,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  CreationProgressEvent,
  ToolResultPreview,
  SessionTaskEntry,
  HistoryWindowState,
  InitialThreadWindowRequest,
  LeaderProjectionSnapshot,
  LeaderProjectionThreadRow,
  LeaderProjectionThreadSummary,
  LeaderThreadResponseProjection,
  LeaderThreadAnswerMetadata,
  LegacyLeaderThreadResponseRevisionMetadata,
  LeaderThreadResponseState,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  ImageRef,
  VsCodeSelectionMetadata,
  VsCodeSelectionState,
  SessionTimer,
  SessionNotification,
  SessionAttentionRecord,
  SessionAttentionRecordPriority,
  SessionAttentionRecordRoute,
  SessionAttentionRecordState,
  SessionAttentionRecordType,
  StarredMessageRecord,
  SessionLifecycleEvent,
  CodexContextWindowDiagnostics,
  ActiveTurnRoute,
  ActiveCodexReasoningPreview,
  SideChatRecord,
  SideChatChildState,
  SideChatContextStrategy,
  SideChatFallbackMode,
  SideChatFallbackReasonCode,
  SideChatFallbackEligibility,
  SideChatNativeEligibility,
  SideChatPreflight,
  SlackThreadRecord,
  SlackThreadChildState,
  ThreadRef,
  ThreadAttachmentMarker,
  ThreadAttachmentMovementSummary,
  ThreadAttachmentUpdate,
  ThreadAttachmentUpdateChangedMessage,
  ThreadAttachmentUpdateEntry,
  ThreadTransitionMarker,
  ThreadWindowEntry,
  ThreadWindowState,
  ThreadRoutingError,
  PausedInboundMessage,
  SessionPauseState,
  TakodeHerdEventBrowserMetadata,
  CodexAutoPauseHeldInput,
  CodexAutoPauseRecoveryProgress,
  CodexResultErrorAutoPauseState,
  CodexResultErrorFamily,
  CodexAutoPauseRecoveryOutcome,
  CodexAutoPauseRecoveryReceipt,
  CodexAutoPauseRecoverySummary,
};
export type { TreeGroup, TreeGroupState } from "../server/tree-group-store.js";
export type {
  ModelAuthorityDecision,
  ModelProvenanceMigration,
} from "../server/model-identity-contract.js";
export type {
  StreamCurrentState,
  StreamEntryType,
  StreamFactStatus,
  StreamLink,
  StreamOwner,
  StreamPinnedFact,
  StreamRecord,
  StreamStatus,
  StreamTimelineEntry,
} from "../server/stream-types.js";
export { assertNever, isClaudeFamily };
export type {
  QuestmasterTask,
  QuestListPreview,
  QuestListPreviewFeedbackSummary,
  QuestListPreviewProgress,
  QuestListPreviewPhaseLine,
  QuestAutocompleteCandidate,
  QuestTitlePreview,
  QuestTitlePreviewResponse,
  QuestStatus,
  QuestVerificationItem,
  QuestQuizItem,
  QuestFeedbackEntry,
  QuestRelatedQuest,
  QuestRelatedQuestKind,
  QuestImage,
  QuestCreateInput,
  QuestPatchInput,
  QuestTransitionInput,
  QuestHistoryView,
};

/** Tool names that spawn subagent sessions. Older CLI versions use "Task",
 *  newer ones use "Agent". Both must be recognized for grouping and filtering. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Task", "Agent"]);
export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

export interface LocalImageAttachment {
  name: string;
  base64?: string;
  mediaType: string;
  /** Stable server attachment identity once upload preparation succeeds. */
  imageId?: string;
  /** Browser-local blob URL; never sent to the backend or persisted. */
  previewUrl?: string;
}

export interface ComposerDraftImage extends LocalImageAttachment {
  base64: string;
  id: string;
  status: "reading" | "uploading" | "ready" | "failed";
  error?: string;
  prepared?: {
    imageRef: ImageRef;
    path: string;
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: ContentBlock[];
  images?: ImageRef[];
  localImages?: LocalImageAttachment[];
  timestamp: number;
  parentToolUseId?: string | null;
  isStreaming?: boolean;
  model?: string;
  stopReason?: string | null;
  /** Total wall-clock duration for the completed assistant turn. */
  turnDurationMs?: number;
  /** For system messages: "error" renders prominently, "denied" shows a compact denial chip, "approved" shows a green approval chip, "quest_claimed"/"quest_submitted" show collapsible quest details, default renders as subtle divider */
  variant?: "error" | "info" | "denied" | "approved" | "quest_claimed" | "quest_submitted" | "task_completed";
  /** Extra structured data for rich rendering (e.g. AskUserQuestion answers, quest claim details) */
  metadata?: {
    answers?: { question: string; answer: string }[];
    /** LLM rationale for auto-approved permissions (rendered separately from the summary). */
    autoApprovalReason?: string;
    /** Preserved leader-visible history row, including legacy publications and notification anchors. */
    leaderUserMessage?: boolean;
    /** Post-cutover direct-human messages participate in leader answer coverage. */
    leaderResponseCoverageVersion?: 1;
    /** Concise stable session-scoped ID exposed in leader source envelopes. */
    leaderUserMessageId?: string;
    /** Server-issued identity of one timer firing, separate from its recurring timer ID. */
    leaderTimerMessageId?: string;
    /** Immutable proof for an explicit routed leader answer. */
    threadAnswer?: LeaderThreadAnswerMetadata;
    /** Read-only compatibility for persisted server-defined response batches. */
    threadResponse?: LegacyLeaderThreadResponseRevisionMetadata;
    /** Explicit commentary/answer role for normal routed leader text. */
    leaderThreadRole?: LeaderStoredThreadRole;
    /** False when the UI id is a history fallback id rather than a raw stable protocol id. */
    starStableMessageId?: boolean;
    /** Optional quest/thread memberships. Main is implicit for every message. */
    threadRefs?: ThreadRef[];
    threadKey?: string;
    questId?: string;
    slackThreadId?: string;
    threadAttachmentMarker?: ThreadAttachmentMarker;
    threadTransitionMarker?: ThreadTransitionMarker;
    crossThreadActivityMarker?: {
      threadKey: string;
      questId?: string;
      count: number;
      activityKind?: "thread_attach";
      summary?: string;
      attachedCount?: number;
      firstMessageId: string;
      lastMessageId: string;
      firstHistoryIndex?: number;
      lastHistoryIndex?: number;
      startedAt: number;
      updatedAt: number;
    };
    attentionRecord?: SessionAttentionRecord;
    codexAutoPauseRecoverySummary?: CodexAutoPauseRecoverySummary;
    /** Official Codex classification for an assistant item; absent means unknown. */
    codexMessagePhase?: CodexMessagePhase;
    codexSubagent?: import("../shared/codex-native-subagent-types.js").CodexNativeSubagentOwnership;
    /** Child-owned tool results attached to the exact child message that declared each tool use. */
    codexSubagentToolResults?: Record<string, ToolResultPreview>;
    codexReasoningDetail?: {
      status: "streaming" | "complete";
      reasoningTurnId?: string;
      reasoningItemOrdinal?: number;
      providerItemId?: string;
      summaryIndex?: number;
      thinkingTimeMs?: number;
    };
    compactMarkerKind?: "compaction" | "session_recycled";
    threadStatusMarkers?: LeaderThreadStatus[];
    threadRoutingError?: ThreadRoutingError;
    replyContext?: ReplyContext;
    vscodeSelection?: VsCodeSelectionMetadata;
    quest?: {
      questId: string;
      title: string;
      description?: string;
      tldr?: string;
      status: string;
      tags?: string[];
      images?: QuestImage[];
      verificationItems?: QuestVerificationItem[];
      leaderSessionId?: string;
    };
  };
  /** Present when this user message was injected programmatically (e.g. via takode CLI or cron). */
  agentSource?: { sessionId: string; sessionLabel?: string };
  /** Exact model-bound payload retained only for committed interrupted-turn recovery events. */
  modelDeliveryContent?: string;
  /** Structured herd-event keys preserved from server delivery metadata. */
  takodeHerdEventKeys?: string[];
  /** Minimal browser-facing herd-event metadata for UI classification. */
  takodeHerdEvents?: TakodeHerdEventBrowserMetadata[];
  /** State recorded when a Thread Outcome Reminder was later satisfied by a concrete outcome. */
  threadOutcomeReminder?: ThreadOutcomeReminderSatisfaction;
  /** Assistant message UUID from CLI, for revert support */
  cliUuid?: string;
  /** Notification anchored to this message (set by takode notify). */
  notification?: {
    id?: string;
    category: SessionNotification["category"];
    timestamp: number;
    summary?: string;
    suggestedAnswers?: string[];
  };
  /** Browser-only message not present in server messageHistory; excluded from sync hash verification. */
  ephemeral?: boolean;
  /** Browser-only pending upload/send state for local user messages. */
  pendingState?: "uploading" | "delivering" | "failed";
  pendingError?: string;
  clientMsgId?: string;
  /** Raw server messageHistory index, used for Takode CLI-compatible message links. */
  historyIndex?: number;
}

export interface PendingUserUpload {
  id: string;
  content: string;
  images: ComposerDraftImage[];
  timestamp: number;
  stage: "delivering" | "failed";
  error?: string;
  replyContext?: ReplyContext;
  vscodeSelection?: VsCodeSelectionMetadata;
  threadKey?: string;
  questId?: string;
  prepared?: {
    deliveryContent: string;
    imageRefs: ImageRef[];
  };
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blockedBy?: string[];
}

export type { PublicSdkSessionInfo as SdkSessionInfo } from "../server/session-info.js";
