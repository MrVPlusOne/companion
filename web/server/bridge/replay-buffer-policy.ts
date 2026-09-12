import type {
  BrowserIncomingMessage,
  BufferedBrowserEvent,
  ReplayableBrowserIncomingMessage,
} from "../session-types.js";

const NON_REPLAYABLE_BROWSER_EVENT_TYPES = new Set<string>([
  "session_init",
  "browser_connection_probe",
  "event_replay",
  "leader_group_idle",
  "quest_list_updated",
  "session_quest_claimed",
  "quest_lifecycle_event",
  "session_name_update", // Legacy persisted-event-buffer tombstone; no current-build producer.
  "tree_groups_update",
  "leader_projection_snapshot",
  "synced_projection_snapshot",
  "synced_projection_update",
  "synced_projection_subscriptions_ack",
  "codex_pending_inputs",
]);

export function shouldBufferForReplay(msg: BrowserIncomingMessage): msg is ReplayableBrowserIncomingMessage {
  return shouldBufferForReplayWithContext(msg);
}

export function isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
  return (
    msg.type === "assistant" ||
    msg.type === "codex_reasoning_detail" ||
    msg.type === "result" ||
    msg.type === "user_message" ||
    msg.type === "leader_user_message" ||
    msg.type === "codex_auto_pause_recovery_summary" ||
    msg.type === "error" ||
    msg.type === "tool_result_preview" ||
    msg.type === "permission_request" ||
    msg.type === "permission_denied" ||
    msg.type === "permission_approved" ||
    msg.type === "compact_boundary" ||
    msg.type === "compact_summary" ||
    msg.type === "compact_marker" ||
    msg.type === "quest_lifecycle_event"
  );
}

export function shouldBufferForReplayWithContext(
  msg: BrowserIncomingMessage,
  context?: { isLeaderSession?: boolean },
): msg is ReplayableBrowserIncomingMessage {
  if (NON_REPLAYABLE_BROWSER_EVENT_TYPES.has(msg.type)) return false;
  if (msg.type === "session_update" && "codex_stream_retry" in msg.session && Object.keys(msg.session).length === 1) {
    return false;
  }
  if (context?.isLeaderSession === true && isTopLevelTextStreamDelta(msg)) return false;
  return true;
}

export function isReplayableBufferedEvent(
  event: unknown,
  context?: { isLeaderSession?: boolean },
): event is BufferedBrowserEvent {
  if (!event || typeof event !== "object") return false;
  const maybeEvent = event as { seq?: unknown; message?: unknown };
  if (typeof maybeEvent.seq !== "number") return false;
  if (!maybeEvent.message || typeof maybeEvent.message !== "object") return false;
  const maybeMessage = maybeEvent.message as { type?: unknown };
  return (
    typeof maybeMessage.type === "string" &&
    shouldBufferForReplayWithContext(maybeMessage as BrowserIncomingMessage, context)
  );
}

function isTopLevelTextStreamDelta(msg: BrowserIncomingMessage): boolean {
  if (msg.type !== "stream_event") return false;
  if (msg.parent_tool_use_id !== null) return false;
  const event = msg.event;
  if (!event || typeof event !== "object") return false;
  const maybeEvent = event as { type?: unknown; delta?: unknown };
  if (maybeEvent.type !== "content_block_delta") return false;
  const delta = maybeEvent.delta;
  if (!delta || typeof delta !== "object") return false;
  const maybeDelta = delta as { type?: unknown; text?: unknown };
  return maybeDelta.type === "text_delta" && typeof maybeDelta.text === "string";
}
