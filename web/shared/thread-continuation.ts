import type { ContentBlock, ThreadTransitionMarker } from "../server/session-types.js";
import {
  leaderResponseOriginalThreadKey,
  type LeaderResponseThreadRouteFields,
} from "./leader-thread-response-routing.js";

interface ContinuationRoute extends LeaderResponseThreadRouteFields {
  threadAnswer?: { authoredThreadKey?: string };
  codexSubagent?: unknown;
}

/** The routing facts shared by stored history and normalized browser messages. */
interface ContinuationMessage extends ContinuationRoute {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  contentBlocks?: readonly ContentBlock[];
  message?: unknown;
  parent_tool_use_id?: string | null;
  parentToolUseId?: string | null;
  metadata?: ContinuationRoute & { threadTransitionMarker?: ThreadTransitionMarker };
}

/**
 * Select the last still-current departure from one thread. Read authoritative
 * history before slicing windows so paging cannot resurrect an old departure.
 * Incoming requests, status events and shared answer visibility are not work
 * returning; only a transition into the thread or its own agent output is.
 */
export function currentThreadContinuationId<T extends ContinuationMessage>(
  messages: readonly T[],
  threadKey: string,
  includeMessage?: (message: T, index: number) => boolean,
): string | null {
  const target = threadKey.trim().toLowerCase();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (includeMessage && !includeMessage(message, index)) continue;
    const marker =
      message.type === "thread_transition_marker"
        ? (message as unknown as ThreadTransitionMarker)
        : message.metadata?.threadTransitionMarker;
    if (marker) {
      if (marker.threadKey.trim().toLowerCase() === target) return null;
      if (marker.sourceThreadKey.trim().toLowerCase() === target) return marker.id;
      continue;
    }
    if (agentActivityThreadKey(message) === target) return null;
  }
  return null;
}

function agentActivityThreadKey(message: ContinuationMessage): string | null {
  if (
    message.role !== "assistant" &&
    message.type !== "assistant" &&
    message.type !== "leader_user_message" &&
    message.type !== "codex_reasoning_detail"
  )
    return null;
  const rawContent =
    message.message && typeof message.message === "object" && "content" in message.message
      ? message.message.content
      : undefined;
  const blocks: readonly ContentBlock[] = message.contentBlocks ?? (Array.isArray(rawContent) ? rawContent : []);
  const hasOutput =
    (typeof message.content === "string" && message.content.trim()) ||
    message.text?.trim() ||
    blocks.some((block) =>
      block.type === "text"
        ? block.text.trim()
        : block.type === "thinking"
          ? block.thinking.trim()
          : block.type === "tool_use",
    );
  if (!hasOutput) return null;
  const route = message.metadata ?? message;
  if (message.parent_tool_use_id || message.parentToolUseId || route.codexSubagent) return null;
  // An answer can be displayed in several threads; its authored route alone
  // proves where the agent worked. Later context attachments grant no such proof.
  if (route.threadAnswer?.authoredThreadKey) {
    return route.threadAnswer.authoredThreadKey.trim().toLowerCase();
  }
  if (route.threadKey !== undefined || route.questId !== undefined) return leaderResponseOriginalThreadKey(route);
  const refs = (route.threadRefs ?? []).filter((ref) => ref.source !== "backfill" && ref.attachedAt === undefined);
  const keys = new Set(refs.map((ref) => leaderResponseOriginalThreadKey(ref)));
  if (keys.size === 1) return keys.values().next().value ?? null;
  return route.threadRefs?.length ? null : "main";
}
