import type { BrowserIncomingMessage, ContentBlock, ChatMessage, ToolResultPreview } from "../types.js";
import { formatThreadAttachmentMarkerSummary, formatThreadTransitionMarkerSummary } from "./thread-projection.js";
import { isTerminalResultInterrupted } from "../../shared/result-interruption.js";
import { getRecoveryModelDeliveryContent } from "./injected-event-message.js";
import {
  parseCommandThreadComment,
  parseThreadTextPrefix,
  stripCommandThreadComment,
} from "../../shared/thread-routing.js";

interface NormalizeHistoryMessageOptions {
  includeSuccessfulResult?: boolean;
  resultRole?: ChatMessage["role"];
  fallbackTimestamp?: number;
  localImages?: ChatMessage["localImages"];
  codexSubagentToolResults?: ReadonlyMap<string, ToolResultPreview>;
}

type ExistingThreadMetadataSource = {
  threadRefs?: NonNullable<ChatMessage["metadata"]>["threadRefs"];
  threadKey?: string;
  questId?: string;
  slackThreadId?: string;
  threadRoutingError?: NonNullable<ChatMessage["metadata"]>["threadRoutingError"];
  threadStatusMarkers?: NonNullable<ChatMessage["metadata"]>["threadStatusMarkers"];
  codexMessagePhase?: NonNullable<ChatMessage["metadata"]>["codexMessagePhase"];
  codexSubagent?: NonNullable<ChatMessage["metadata"]>["codexSubagent"];
  leaderThreadRole?: NonNullable<ChatMessage["metadata"]>["leaderThreadRole"];
  threadAnswer?: NonNullable<ChatMessage["metadata"]>["threadAnswer"];
  threadResponse?: NonNullable<ChatMessage["metadata"]>["threadResponse"];
};

export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function dedupeAssistantContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seenToolIds = new Set<string>();
  const result: ContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use" && block.id) {
      if (seenToolIds.has(block.id)) continue;
      seenToolIds.add(block.id);
    }
    result.push(block);
  }

  if (!result.some((block) => block.type === "tool_use")) return result;

  while (result.length > 1 && isReplayDuplicatedAssistantTail(result)) {
    result.pop();
  }

  return result;
}

function threadRefForRepairedTarget(target: { threadKey: string; questId?: string }): ChatMessage["metadata"] {
  const metadata: ChatMessage["metadata"] = { threadKey: target.threadKey };
  if (target.questId) {
    metadata.questId = target.questId;
    metadata.threadRefs = [{ threadKey: target.threadKey, questId: target.questId, source: "explicit" }];
  }
  return metadata;
}

function mergeThreadMetadata(
  existing: ChatMessage["metadata"] | undefined,
  repaired: ChatMessage["metadata"] | undefined,
): ChatMessage["metadata"] | undefined {
  if (!existing && !repaired) return undefined;
  if (!repaired) return existing;
  const refs = new Map<string, NonNullable<NonNullable<ChatMessage["metadata"]>["threadRefs"]>[number]>();
  for (const ref of existing?.threadRefs ?? []) {
    refs.set(ref.threadKey.toLowerCase(), ref);
  }
  for (const ref of repaired.threadRefs ?? []) {
    refs.set(ref.threadKey.toLowerCase(), ref);
  }
  return {
    ...existing,
    ...repaired,
    ...(refs.size > 0 ? { threadRefs: [...refs.values()] } : {}),
  };
}

function repairThreadPrefixInText(text: string): { text: string; metadata?: ChatMessage["metadata"] } {
  const parsed = parseThreadTextPrefix(text);
  if (!parsed.ok) return { text };
  return { text: parsed.body, metadata: threadRefForRepairedTarget(parsed.target) };
}

function repairThreadPrefixInContentBlocks(blocks: ContentBlock[]): {
  blocks: ContentBlock[];
  metadata?: ChatMessage["metadata"];
} {
  const firstTextIndex = blocks.findIndex((block) => block.type === "text" && block.text.trim());
  if (firstTextIndex >= 0) {
    const block = blocks[firstTextIndex];
    if (!block || block.type !== "text") return { blocks };
    const repaired = repairThreadPrefixInText(block.text);
    if (repaired.metadata) {
      const next = blocks.slice();
      next[firstTextIndex] = { ...block, text: repaired.text };
      return { blocks: next, metadata: repaired.metadata };
    }
  }

  const firstBashIndex = blocks.findIndex(
    (block) => block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string",
  );
  if (firstBashIndex < 0) return { blocks };
  const block = blocks[firstBashIndex];
  if (!block || block.type !== "tool_use" || block.name !== "Bash" || typeof block.input?.command !== "string") {
    return { blocks };
  }
  const target = parseCommandThreadComment(block.input.command);
  if (!target) return { blocks };
  const next = blocks.slice();
  next[firstBashIndex] = {
    ...block,
    input: {
      ...block.input,
      command: stripCommandThreadComment(block.input.command),
    },
  };
  return { blocks: next, metadata: threadRefForRepairedTarget(target) };
}

function existingThreadMetadataFromMessage(msg: ExistingThreadMetadataSource): ChatMessage["metadata"] | undefined {
  if (
    !msg.threadRefs &&
    !msg.threadKey &&
    !msg.questId &&
    !msg.threadRoutingError &&
    !msg.threadStatusMarkers &&
    msg.codexMessagePhase === undefined &&
    !msg.codexSubagent &&
    !msg.leaderThreadRole &&
    !msg.threadAnswer &&
    !msg.threadResponse
  ) {
    return undefined;
  }
  return {
    ...(msg.threadRefs ? { threadRefs: msg.threadRefs } : {}),
    ...(msg.threadKey ? { threadKey: msg.threadKey } : {}),
    ...(msg.questId ? { questId: msg.questId } : {}),
    ...(msg.slackThreadId ? { slackThreadId: msg.slackThreadId } : {}),
    ...(msg.threadRoutingError ? { threadRoutingError: msg.threadRoutingError } : {}),
    ...(msg.threadStatusMarkers ? { threadStatusMarkers: msg.threadStatusMarkers } : {}),
    ...(msg.codexMessagePhase !== undefined ? { codexMessagePhase: msg.codexMessagePhase } : {}),
    ...(msg.codexSubagent ? { codexSubagent: msg.codexSubagent } : {}),
    ...(msg.leaderThreadRole ? { leaderThreadRole: msg.leaderThreadRole } : {}),
    ...(msg.threadAnswer ? { threadAnswer: msg.threadAnswer } : {}),
    ...(msg.threadResponse ? { threadResponse: msg.threadResponse } : {}),
  };
}

export function normalizeLiveAssistantThreadMetadata(msg: Extract<BrowserIncomingMessage, { type: "assistant" }>): {
  content: ContentBlock[];
  metadata?: ChatMessage["metadata"];
} {
  const repairedContent = repairThreadPrefixInContentBlocks(msg.message.content);
  return {
    content: repairedContent.blocks,
    metadata: mergeThreadMetadata(existingThreadMetadataFromMessage(msg), repairedContent.metadata),
  };
}

export function normalizeLiveLeaderUserThreadMetadata(
  msg: Extract<BrowserIncomingMessage, { type: "leader_user_message" }>,
): {
  content: string;
  metadata: NonNullable<ChatMessage["metadata"]>;
} {
  const repaired = repairThreadPrefixInText(msg.content);
  return {
    content: repaired.text,
    metadata: mergeThreadMetadata(
      {
        leaderUserMessage: true,
        ...(existingThreadMetadataFromMessage(msg) ?? {}),
      },
      repaired.metadata,
    )!,
  };
}

export function normalizeCodexReasoningDetailMessage(
  msg: Extract<BrowserIncomingMessage, { type: "codex_reasoning_detail" }>,
  historyIndex?: number,
): ChatMessage {
  return {
    id: msg.id,
    role: "assistant",
    content: msg.text,
    timestamp: msg.timestamp,
    parentToolUseId: msg.parent_tool_use_id,
    ...(historyIndex !== undefined ? { historyIndex } : {}),
    metadata: {
      ...(existingThreadMetadataFromMessage(msg) ?? {}),
      codexReasoningDetail: {
        status: msg.status,
        ...(msg.reasoning_turn_id !== undefined ? { reasoningTurnId: msg.reasoning_turn_id } : {}),
        ...(msg.reasoning_item_ordinal !== undefined ? { reasoningItemOrdinal: msg.reasoning_item_ordinal } : {}),
        ...(msg.provider_item_id !== undefined ? { providerItemId: msg.provider_item_id } : {}),
        ...(msg.summary_index !== undefined ? { summaryIndex: msg.summary_index } : {}),
        ...(msg.thinking_time_ms !== undefined ? { thinkingTimeMs: msg.thinking_time_ms } : {}),
      },
    },
  };
}

function getReplaySensitiveBlockSignature(block: ContentBlock): string | null {
  if (block.type === "text") return `text:${block.text}`;
  if (block.type === "thinking") return `thinking:${block.thinking}`;
  return null;
}

function isReplayDuplicatedAssistantTail(blocks: ContentBlock[]): boolean {
  const tailIndex = blocks.length - 1;
  const tailSignature = getReplaySensitiveBlockSignature(blocks[tailIndex]!);
  if (!tailSignature) return false;

  for (let index = tailIndex - 1; index >= 0; index--) {
    const candidateSignature = getReplaySensitiveBlockSignature(blocks[index]!);
    if (candidateSignature !== tailSignature) continue;

    for (let between = index + 1; between < tailIndex; between++) {
      if (blocks[between]?.type === "tool_use") return true;
    }
  }

  return false;
}

export function normalizeHistoryMessageToChatMessages(
  histMsg: BrowserIncomingMessage,
  historyIndex: number,
  options: NormalizeHistoryMessageOptions = {},
): ChatMessage[] {
  const {
    includeSuccessfulResult = false,
    resultRole = "assistant",
    fallbackTimestamp,
    localImages,
    codexSubagentToolResults,
  } = options;

  if (histMsg.type === "codex_reasoning_detail") {
    return [normalizeCodexReasoningDetailMessage(histMsg, historyIndex)];
  }

  if (histMsg.type === "quest_lifecycle_event") {
    const label = histMsg.kind === "submitted" ? "Quest submitted" : "Quest claimed";
    return [
      {
        id: histMsg.id,
        role: "system",
        content: `${label}: ${histMsg.quest.title}`,
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: histMsg.kind === "submitted" ? "quest_submitted" : "quest_claimed",
        metadata: {
          ...(existingThreadMetadataFromMessage(histMsg) ?? {}),
          quest: histMsg.quest,
        },
      },
    ];
  }

  if (histMsg.type === "user_message") {
    const stableMessageId = typeof histMsg.id === "string" && histMsg.id.trim().length > 0 ? histMsg.id : null;
    const threadMetadata = {
      ...(histMsg.threadRefs ? { threadRefs: histMsg.threadRefs } : {}),
      ...(histMsg.threadKey ? { threadKey: histMsg.threadKey } : {}),
      ...(histMsg.questId ? { questId: histMsg.questId } : {}),
      ...(histMsg.slackThreadId ? { slackThreadId: histMsg.slackThreadId } : {}),
      ...(histMsg.threadRoutingError ? { threadRoutingError: histMsg.threadRoutingError } : {}),
      ...(histMsg.codexSubagent ? { codexSubagent: histMsg.codexSubagent } : {}),
      ...(histMsg.leaderResponseCoverageVersion
        ? { leaderResponseCoverageVersion: histMsg.leaderResponseCoverageVersion }
        : {}),
      ...(histMsg.leaderUserMessageId ? { leaderUserMessageId: histMsg.leaderUserMessageId } : {}),
      ...(histMsg.leaderTimerMessageId ? { leaderTimerMessageId: histMsg.leaderTimerMessageId } : {}),
    };
    const metadata: ChatMessage["metadata"] = {
      ...(histMsg.replyContext ? { replyContext: histMsg.replyContext } : {}),
      ...(histMsg.vscodeSelection ? { vscodeSelection: histMsg.vscodeSelection } : {}),
      ...(stableMessageId ? {} : { starStableMessageId: false }),
      ...threadMetadata,
    };
    const modelDeliveryContent = getRecoveryModelDeliveryContent(histMsg);
    return [
      {
        id: stableMessageId ?? `hist-user-${historyIndex}`,
        role: "user",
        content: histMsg.content,
        timestamp: histMsg.timestamp,
        historyIndex,
        ...(histMsg.images?.length ? { images: histMsg.images } : {}),
        ...(localImages?.length ? { localImages } : {}),
        ...(typeof histMsg.client_msg_id === "string" ? { clientMsgId: histMsg.client_msg_id } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(histMsg.agentSource ? { agentSource: histMsg.agentSource } : {}),
        ...(modelDeliveryContent !== undefined ? { modelDeliveryContent } : {}),
        ...(histMsg.takodeHerdEventKeys?.length ? { takodeHerdEventKeys: histMsg.takodeHerdEventKeys } : {}),
        ...(histMsg.takodeHerdEvents?.length ? { takodeHerdEvents: histMsg.takodeHerdEvents } : {}),
        ...(histMsg.threadOutcomeReminder ? { threadOutcomeReminder: histMsg.threadOutcomeReminder } : {}),
      },
    ];
  }

  if (histMsg.type === "leader_user_message") {
    const stableMessageId = typeof histMsg.id === "string" && histMsg.id.trim().length > 0 ? histMsg.id : null;
    const existingMetadata: ChatMessage["metadata"] = {
      leaderUserMessage: true,
      ...(stableMessageId ? {} : { starStableMessageId: false }),
      ...(histMsg.threadRefs ? { threadRefs: histMsg.threadRefs } : {}),
      ...(histMsg.threadKey ? { threadKey: histMsg.threadKey } : {}),
      ...(histMsg.questId ? { questId: histMsg.questId } : {}),
      ...(histMsg.threadRoutingError ? { threadRoutingError: histMsg.threadRoutingError } : {}),
      ...(histMsg.threadResponse ? { threadResponse: histMsg.threadResponse } : {}),
    };
    const repaired = repairThreadPrefixInText(histMsg.content);
    const metadata = mergeThreadMetadata(existingMetadata, repaired.metadata);
    return [
      {
        id: stableMessageId ?? `hist-leader-user-${historyIndex}`,
        role: "assistant",
        content: repaired.text,
        timestamp: histMsg.timestamp,
        historyIndex,
        metadata,
        ...(histMsg.notification ? { notification: histMsg.notification } : {}),
      },
    ];
  }

  if (histMsg.type === "assistant") {
    const msg = histMsg.message;
    const dedupedContent = dedupeAssistantContentBlocks(msg.content);
    const repairedContent = repairThreadPrefixInContentBlocks(dedupedContent);
    const normalizedContent = repairedContent.blocks;
    const existingMetadata = existingThreadMetadataFromMessage(histMsg);
    const metadata = mergeThreadMetadata(existingMetadata, repairedContent.metadata);
    const childToolResults = histMsg.codexSubagent
      ? Object.fromEntries(
          normalizedContent.flatMap((block) =>
            block.type === "tool_use" && codexSubagentToolResults?.has(block.id)
              ? [[block.id, codexSubagentToolResults.get(block.id)!]]
              : [],
          ),
        )
      : {};
    const enrichedMetadata =
      Object.keys(childToolResults).length > 0 ? { ...metadata, codexSubagentToolResults: childToolResults } : metadata;
    return [
      {
        id: msg.id,
        role: "assistant",
        content: extractTextFromBlocks(normalizedContent),
        contentBlocks: normalizedContent,
        timestamp: histMsg.timestamp || Date.now(),
        historyIndex,
        parentToolUseId: histMsg.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        cliUuid: (histMsg as Record<string, unknown>).uuid as string | undefined,
        ...((histMsg as Record<string, unknown>).notification
          ? { notification: (histMsg as Record<string, unknown>).notification as ChatMessage["notification"] }
          : {}),
        ...(enrichedMetadata ? { metadata: enrichedMetadata } : {}),
        ...(typeof (histMsg as Record<string, unknown>).turn_duration_ms === "number"
          ? { turnDurationMs: (histMsg as Record<string, unknown>).turn_duration_ms as number }
          : {}),
      },
    ];
  }

  if (histMsg.type === "compact_marker") {
    const markerKind =
      (histMsg as { markerKind?: "compaction" | "session_recycled" }).markerKind === "session_recycled"
        ? "session_recycled"
        : "compaction";
    const defaultContent = markerKind === "session_recycled" ? "Session recycled" : "Conversation compacted";
    return [
      {
        id: histMsg.id || `compact-${historyIndex}`,
        role: "system",
        content: histMsg.summary || defaultContent,
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "info",
        metadata: { compactMarkerKind: markerKind },
      },
    ];
  }

  if (histMsg.type === "codex_auto_pause_recovery_summary") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: histMsg.content,
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "info",
        metadata: {
          codexAutoPauseRecoverySummary: histMsg.recovery,
          ...(histMsg.threadRefs ? { threadRefs: histMsg.threadRefs } : {}),
          ...(histMsg.threadKey ? { threadKey: histMsg.threadKey } : {}),
          ...(histMsg.questId ? { questId: histMsg.questId } : {}),
        },
      },
    ];
  }

  if (histMsg.type === "thread_attachment_marker") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: formatThreadAttachmentMarkerSummary(histMsg),
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "info",
        metadata: { threadAttachmentMarker: histMsg },
      },
    ];
  }

  if (histMsg.type === "thread_transition_marker") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: formatThreadTransitionMarkerSummary(histMsg),
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "info",
        metadata: { threadTransitionMarker: histMsg },
      },
    ];
  }

  if (histMsg.type === "cross_thread_activity_marker") {
    const destination = histMsg.questId ?? histMsg.threadKey;
    const countLabel = `${histMsg.count} ${histMsg.count === 1 ? "activity" : "activities"}`;
    const content = histMsg.summary ?? `${countLabel} in thread:${destination}`;
    return [
      {
        id: histMsg.id,
        role: "system",
        content,
        timestamp: histMsg.timestamp,
        historyIndex,
        ephemeral: true,
        metadata: {
          threadKey: histMsg.threadKey,
          ...(histMsg.questId ? { questId: histMsg.questId } : {}),
          crossThreadActivityMarker: {
            threadKey: histMsg.threadKey,
            ...(histMsg.questId ? { questId: histMsg.questId } : {}),
            count: histMsg.count,
            ...(histMsg.activityKind ? { activityKind: histMsg.activityKind } : {}),
            ...(histMsg.summary ? { summary: histMsg.summary } : {}),
            ...(typeof histMsg.attachedCount === "number" ? { attachedCount: histMsg.attachedCount } : {}),
            firstMessageId: histMsg.firstMessageId,
            lastMessageId: histMsg.lastMessageId,
            ...(typeof histMsg.firstHistoryIndex === "number" ? { firstHistoryIndex: histMsg.firstHistoryIndex } : {}),
            ...(typeof histMsg.lastHistoryIndex === "number" ? { lastHistoryIndex: histMsg.lastHistoryIndex } : {}),
            startedAt: histMsg.startedAt,
            updatedAt: histMsg.updatedAt,
          },
        },
      },
    ];
  }

  if (histMsg.type === "permission_denied") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: histMsg.summary,
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "denied",
      },
    ];
  }

  if (histMsg.type === "permission_approved") {
    return [
      {
        id: histMsg.id,
        role: "system",
        content: histMsg.summary,
        timestamp: histMsg.timestamp,
        historyIndex,
        variant: "approved",
        ...(histMsg.answers?.length ? { metadata: { answers: histMsg.answers } } : {}),
      },
    ];
  }

  if (histMsg.type === "task_notification") {
    if (!histMsg.summary) return [];
    return [
      {
        id: `task-notif-${histMsg.task_id || historyIndex}`,
        role: "system",
        content: histMsg.summary,
        timestamp: Date.now(),
        historyIndex,
        variant: "task_completed",
      },
    ];
  }

  if (histMsg.type === "error") {
    const metadata = existingThreadMetadataFromMessage(histMsg);
    return [
      {
        id: histMsg.id ?? `hist-error-${historyIndex}`,
        role: "system",
        content: histMsg.message,
        timestamp: histMsg.timestamp ?? fallbackTimestamp ?? Date.now(),
        historyIndex,
        variant: "error",
        ...(metadata ? { metadata } : {}),
      },
    ];
  }

  if (histMsg.type === "result") {
    const metadata = existingThreadMetadataFromMessage(histMsg);
    const result = histMsg.data as {
      is_error?: boolean;
      errors?: string[];
      result?: string;
      codex_provider_retry?: unknown;
    };
    if (result.codex_provider_retry) return [];
    if (!result.is_error) {
      if (!includeSuccessfulResult || histMsg.interrupted || !result.result) return [];
      return [
        {
          id: `hist-result-${historyIndex}`,
          role: resultRole,
          content: result.result,
          timestamp: fallbackTimestamp ?? Date.now(),
          historyIndex,
          ...(metadata ? { metadata } : {}),
        },
      ];
    }
    if (isTerminalResultInterrupted(result, { explicitInterrupted: histMsg.interrupted === true })) return [];
    const errorText = result.errors?.length ? result.errors.join(", ") : result.result || "An error occurred";
    return [
      {
        id: `hist-error-${historyIndex}`,
        role: "system",
        content: `Error: ${errorText}`,
        timestamp: fallbackTimestamp ?? Date.now(),
        historyIndex,
        variant: "error",
        ...(metadata ? { metadata } : {}),
      },
    ];
  }

  return [];
}
