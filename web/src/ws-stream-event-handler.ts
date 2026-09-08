import { useStore } from "./store.js";
import type { BrowserIncomingMessage } from "./types.js";

type StreamEventMessage = Extract<BrowserIncomingMessage, { type: "stream_event" }>;

/** Apply root-agent live deltas without letting native child audit streams mutate root UI state. */
export function handleStreamEventMessage(sessionId: string, data: StreamEventMessage): void {
  if (data.codexSubagent) return;
  const store = useStore.getState();
  const event = data.event as Record<string, unknown>;
  if (!event || typeof event !== "object") return;

  if (event.type === "message_stop") {
    // History replay may suppress the completed assistant row. The independent
    // stream boundary still retires only its parent's transient output.
    store.setStreaming(sessionId, null, data.parent_tool_use_id);
    store.setStreamingThinking(sessionId, null, data.parent_tool_use_id);
    return;
  }

  if (event.type === "message_start" && !store.streamingStartedAt.has(sessionId)) {
    store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
  }

  if (event.type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "thinking") {
      store.setStreamingThinking(
        sessionId,
        typeof block.thinking === "string" ? block.thinking : "",
        data.parent_tool_use_id,
      );
    }
  }

  if (event.type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      const parentToolUseId = data.parent_tool_use_id;
      const isTopLevelLeaderText =
        !parentToolUseId &&
        (store.sessions.get(sessionId)?.isOrchestrator === true ||
          store.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true));
      if (!isTopLevelLeaderText) {
        const current = parentToolUseId
          ? store.streamingByParentToolUseId.get(sessionId)?.get(parentToolUseId) || ""
          : store.streaming.get(sessionId) || "";
        store.setStreaming(sessionId, current + delta.text, parentToolUseId);
      }
    }
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      const parentToolUseId = data.parent_tool_use_id;
      const current = parentToolUseId
        ? store.streamingThinkingByParentToolUseId.get(sessionId)?.get(parentToolUseId) || ""
        : store.streamingThinking.get(sessionId) || "";
      store.setStreamingThinking(sessionId, current + delta.thinking, parentToolUseId);
    }
  }

  if (event.type === "message_delta") {
    const usage = (event as { usage?: { output_tokens?: number } }).usage;
    if (usage?.output_tokens) store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
  }
}
