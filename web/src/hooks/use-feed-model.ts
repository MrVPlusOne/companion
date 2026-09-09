import { useEffect, useMemo, useRef } from "react";
import {
  isSubagentToolName,
  type ChatMessage,
  type ContentBlock,
  type SessionAttentionRecord,
  type ToolResultPreview,
} from "../types.js";
import { EVENT_HEADER_RE } from "../utils/herd-event-parser.js";
import { recordFeedRenderSnapshot } from "../utils/frontend-perf-recorder.js";
import { isInjectedEventMessage } from "../utils/injected-event-message.js";
import { THREAD_OUTCOME_REMINDER_SOURCE_ID } from "../../shared/thread-outcome-reminder.js";
import { THREAD_ROUTING_REMINDER_SOURCE_ID } from "../../shared/thread-routing-reminder.js";
import { isCodexReasoningDetailMessage } from "../utils/codex-reasoning-detail.js";
import { isAssistantMessageRenderable, isToolHiddenFromChat } from "../utils/assistant-message-renderability.js";
import { isBoardProposalMessage } from "../utils/takode-tool-command.js";
import { normalizeCodexMessagePhase } from "../../shared/codex-message-phase.js";
import type { TakodeHerdEventLifecycle } from "../../shared/herd-event-lifecycle.js";
import { getHerdEventCount, getHerdEventLifecycles } from "../utils/herd-event-classification.js";

export interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
  messageId?: string;
  codexSubagent?: NonNullable<NonNullable<ChatMessage["metadata"]>["codexSubagent"]>;
  resultOverride?: ToolResultPreview;
}

export interface ToolMsgGroup {
  kind: "tool_msg_group";
  toolName: string;
  items: ToolItem[];
  firstId: string;
  mixedToolNames?: boolean;
}

export interface SubagentGroup {
  kind: "subagent";
  taskToolUseId: string;
  description: string;
  agentType: string;
  taskInput: Record<string, unknown> | null;
  children: FeedEntry[];
  isBackground: boolean;
  codexSubagent?: NonNullable<NonNullable<ChatMessage["metadata"]>["codexSubagent"]>;
  resultOverride?: ToolResultPreview;
}

export interface SubagentBatch {
  kind: "subagent_batch";
  subagents: SubagentGroup[];
}

export type FeedEntry = { kind: "message"; msg: ChatMessage } | ToolMsgGroup | SubagentGroup | SubagentBatch;

interface TaskInfo {
  description: string;
  agentType: string;
  input: Record<string, unknown>;
}

function filterHiddenToolUseBlocks(msg: ChatMessage): ChatMessage | null {
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return msg;

  const filtered = blocks.filter((b) => !(b.type === "tool_use" && isToolHiddenFromChat(b.name)));
  if (filtered.length === blocks.length) return msg;
  if (filtered.length === 0 && !msg.content.trim() && !msg.notification) return null;
  return { ...msg, contentBlocks: filtered };
}

interface ToolOnlyGroup {
  toolName: string;
  items: ToolItem[];
  mixedToolNames: boolean;
}

/** Extract a tool-only assistant message, including messages with mixed tool types. */
function getToolOnlyGroup(
  msg: ChatMessage,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): ToolOnlyGroup | null {
  if (msg.role !== "assistant") return null;
  if (msg.notification || isBoardProposalMessage(msg)) return null;
  if (anchoredNotificationMessageIds?.has(msg.id)) return null;
  // Some SDK payloads carry assistant text only in `content` while contentBlocks
  // contain tool_use entries. Treat those as mixed messages, not tool-only.
  if (msg.content.trim()) return null;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return null;

  const items: ToolItem[] = [];
  const codexSubagent = msg.metadata?.codexSubagent;
  const childToolResults = msg.metadata?.codexSubagentToolResults;
  for (const b of blocks) {
    if (b.type === "text" && b.text.trim()) return null;
    if (b.type === "thinking") return null;
    if (b.type === "tool_use") {
      items.push({
        id: b.id,
        name: b.name,
        input: b.input,
        messageId: msg.id,
        ...(codexSubagent ? { codexSubagent } : {}),
        ...(childToolResults?.[b.id] ? { resultOverride: childToolResults[b.id] } : {}),
      });
      continue;
    }
    if (b.type !== "text") return null;
  }

  if (items.length === 0) return null;
  const toolName = items[0].name;
  const mixedToolNames = items.some((item) => item.name !== toolName);
  if (mixedToolNames && items.some((item) => isSubagentToolName(item.name))) return null;
  return { toolName, items, mixedToolNames };
}

/** Get Task tool_use IDs from a feed entry */
function getTaskIdsFromEntry(entry: FeedEntry): string[] {
  if (entry.kind === "message") {
    const blocks = entry.msg.contentBlocks || [];
    return blocks
      .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .filter((b) => isSubagentToolName(b.name))
      .map((b) => b.id);
  }
  if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
    return entry.items.map((item) => item.id);
  }
  return [];
}

// File-operation tools get standalone chips (no grouping) so each edit
// shows its own path in the header without redundant double-headers.
export const FILE_TOOL_NAMES = new Set(["Edit", "Write", "Read"]);

function sameToolOwnership(left: ToolItem | undefined, right: ToolItem | undefined): boolean {
  return left?.codexSubagent?.childId === right?.codexSubagent?.childId;
}

/** Group consecutive same-tool messages */
function groupToolMessages(messages: ChatMessage[], anchoredNotificationMessageIds?: ReadonlySet<string>): FeedEntry[] {
  const entries: FeedEntry[] = [];

  for (const originalMsg of messages) {
    const msg = filterHiddenToolUseBlocks(originalMsg);
    if (!msg) continue;
    const toolGroup = getToolOnlyGroup(msg, anchoredNotificationMessageIds);

    if (toolGroup) {
      const last = entries[entries.length - 1];
      // Never merge file-operation tools -- each gets its own standalone chip
      if (
        !toolGroup.mixedToolNames &&
        !FILE_TOOL_NAMES.has(toolGroup.toolName) &&
        last?.kind === "tool_msg_group" &&
        !last.mixedToolNames &&
        last.toolName === toolGroup.toolName &&
        sameToolOwnership(last.items[0], toolGroup.items[0])
      ) {
        last.items.push(...toolGroup.items);
        continue;
      }
      entries.push({
        kind: "tool_msg_group",
        toolName: toolGroup.toolName,
        items: toolGroup.items,
        firstId: msg.id,
        ...(toolGroup.mixedToolNames ? { mixedToolNames: true } : {}),
      });
    } else {
      entries.push({ kind: "message", msg });
    }
  }

  return entries;
}

/** Build feed entries with subagent nesting.
 *  Task ToolMsgGroups are absorbed into SubagentGroups so the Task tool_use
 *  and its children render as a single unified card. */
function buildEntries(
  messages: ChatMessage[],
  taskInfo: Map<string, TaskInfo>,
  childrenByParent: Map<string, ChatMessage[]>,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): FeedEntry[] {
  const grouped = groupToolMessages(messages, anchoredNotificationMessageIds);

  const result: FeedEntry[] = [];
  for (const entry of grouped) {
    const taskIds = getTaskIdsFromEntry(entry);

    if (taskIds.length === 0) {
      // Non-Task entry — push as-is
      result.push(entry);
      continue;
    }

    // Case A: Pure Task ToolMsgGroup — absorb entirely into SubagentGroups
    if (entry.kind === "tool_msg_group" && isSubagentToolName(entry.toolName)) {
      for (const taskId of taskIds) {
        const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
        const item = entry.items.find((candidate) => candidate.id === taskId);
        const children = childrenByParent.get(taskId);
        const childEntries =
          children && children.length > 0
            ? buildEntries(children, taskInfo, childrenByParent, anchoredNotificationMessageIds)
            : [];
        result.push({
          kind: "subagent",
          taskToolUseId: taskId,
          description: info.description,
          agentType: info.agentType,
          taskInput: info.input,
          children: childEntries,
          isBackground: !!info.input?.run_in_background,
          ...(item?.codexSubagent ? { codexSubagent: item.codexSubagent } : {}),
          ...(item?.resultOverride ? { resultOverride: item.resultOverride } : {}),
        });
      }
      continue;
    }

    // Case B: Mixed message (text + Task tool_use) — emit the text FIRST,
    // then the SubagentGroups. This preserves chronological order: the
    // assistant writes explanatory text before invoking the agent tool.
    if (entry.kind === "message") {
      const filteredBlocks = entry.msg.contentBlocks?.filter(
        (b) => !(b.type === "tool_use" && isSubagentToolName(b.name)),
      );
      result.push({ kind: "message", msg: { ...entry.msg, contentBlocks: filteredBlocks } });
    } else {
      result.push(entry);
    }
    for (const taskId of taskIds) {
      const info = taskInfo.get(taskId) || { description: "Subagent", agentType: "", input: {} };
      const codexSubagent = entry.kind === "message" ? entry.msg.metadata?.codexSubagent : undefined;
      const resultOverride =
        entry.kind === "message" ? entry.msg.metadata?.codexSubagentToolResults?.[taskId] : undefined;
      const children = childrenByParent.get(taskId);
      const childEntries =
        children && children.length > 0
          ? buildEntries(children, taskInfo, childrenByParent, anchoredNotificationMessageIds)
          : [];
      result.push({
        kind: "subagent",
        taskToolUseId: taskId,
        description: info.description,
        agentType: info.agentType,
        taskInput: info.input,
        children: childEntries,
        isBackground: !!info.input?.run_in_background,
        ...(codexSubagent ? { codexSubagent } : {}),
        ...(resultOverride ? { resultOverride } : {}),
      });
    }
  }

  return result;
}

/** Group consecutive SubagentGroup entries into SubagentBatch wrappers. */
function batchSubagents(entries: FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  let i = 0;

  while (i < entries.length) {
    if (entries[i].kind === "subagent") {
      const ownerChildId = (entries[i] as SubagentGroup).codexSubagent?.childId;
      const batch: SubagentGroup[] = [];
      while (
        i < entries.length &&
        entries[i].kind === "subagent" &&
        (entries[i] as SubagentGroup).codexSubagent?.childId === ownerChildId
      ) {
        batch.push(entries[i] as SubagentGroup);
        i++;
      }

      if (batch.length >= 2) {
        result.push({ kind: "subagent_batch", subagents: batch });
      } else {
        result.push(batch[0]);
      }
    } else {
      result.push(entries[i]);
      i++;
    }
  }

  return result;
}

export function groupMessages(
  messages: ChatMessage[],
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
): FeedEntry[] {
  const anchoredIds =
    anchoredNotificationMessageIds instanceof Set
      ? anchoredNotificationMessageIds
      : new Set(anchoredNotificationMessageIds ?? []);
  // Phase 1: Find all Task tool_use IDs across all messages
  const taskInfo = new Map<string, TaskInfo>();
  for (const msg of messages) {
    if (!msg.contentBlocks) continue;
    for (const b of msg.contentBlocks) {
      if (b.type === "tool_use" && isSubagentToolName(b.name)) {
        const { input, id } = b;
        taskInfo.set(id, {
          description: String(input?.description || "Subagent"),
          agentType: String(input?.subagent_type || ""),
          input: (input || {}) as Record<string, unknown>,
        });
      }
    }
  }

  // Phase 2: Partition into top-level and child messages.
  // Also detect orphaned children whose parent Task block was lost (e.g. due to
  // message dedup dropping a split assistant message). Create synthetic taskInfo
  // entries so they still get grouped under a SubagentContainer.
  const childrenByParent = new Map<string, ChatMessage[]>();
  const topLevel: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.parentToolUseId && !msg.metadata?.codexSubagent) {
      if (!taskInfo.has(msg.parentToolUseId)) {
        // Orphaned child — parent Task block was lost. Create synthetic entry.
        taskInfo.set(msg.parentToolUseId, { description: "Subagent", agentType: "", input: {} });
      }
      let arr = childrenByParent.get(msg.parentToolUseId);
      if (!arr) {
        arr = [];
        childrenByParent.set(msg.parentToolUseId, arr);
      }
      arr.push(msg);
    } else {
      topLevel.push(msg);
    }
  }

  // If no Task tool_uses found (including synthetic), skip the overhead
  if (taskInfo.size === 0) {
    return groupToolMessages(messages, anchoredIds);
  }

  // Phase 3: Build grouped entries with subagent nesting.
  // Orphaned subagent groups (no parent entry in topLevel) are appended at the end.
  const entries = buildEntries(topLevel, taskInfo, childrenByParent, anchoredIds);

  // Emit any orphaned subagent groups whose parent Task wasn't in any top-level entry.
  // Skip orphans with synthetic taskInfo (empty input) — these appear when the parent
  // Task block was lost during message dedup or compaction. The synthetic entry has
  // input: {} while real Task entries have input with prompt/description.
  const emittedTaskIds = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "subagent") emittedTaskIds.add(entry.taskToolUseId);
  }
  for (const [taskId, children] of childrenByParent) {
    if (emittedTaskIds.has(taskId)) continue;
    if (children.length === 0) continue;
    const info = taskInfo.get(taskId);
    if (!info) continue;
    // Skip synthetic orphans (empty input = parent Task was never in message history)
    if (Object.keys(info.input).length === 0) continue;
    const childEntries = buildEntries(children, taskInfo, childrenByParent, anchoredIds);
    entries.push({
      kind: "subagent",
      taskToolUseId: taskId,
      description: info.description,
      agentType: info.agentType,
      taskInput: info.input || null,
      children: childEntries,
      isBackground: !!info.input?.run_in_background,
    });
  }

  return batchSubagents(entries);
}

export interface TurnStats {
  messageCount: number;
  toolCount: number;
  subagentCount: number;
  herdEventCount: number;
  herdEventLifecycle?: TakodeHerdEventLifecycle[];
}

/** Assistant message immediately preceding a herd event injection --
 *  a sub-conclusion worth showing in the collapsed turn view. */
export interface SubConclusion {
  /** The assistant FeedEntry (same reference as in agentEntries) */
  entry: FeedEntry;
  /** One-line summary of the herd event(s) that followed, e.g. "Herd: #264 turn_end, #267 turn_end" */
  herdSummary: string;
}

export type CollapsedTurnEntry =
  | { kind: "activity"; key: string; stats: TurnStats }
  | { kind: "entry"; key: string; entry: FeedEntry };

export interface Turn {
  id: string;
  userEntry: FeedEntry | null;
  allEntries: FeedEntry[];
  /** Post-processed entries eligible for visible feed presentation. */
  presentationEntries?: FeedEntry[];
  agentEntries: FeedEntry[];
  systemEntries: FeedEntry[];
  /** Messages with notification chips -- always visible even when the turn is collapsed. */
  notificationEntries: FeedEntry[];
  responseEntry: FeedEntry | null;
  /** Sub-conclusions: assistant messages that precede herd events, shown in collapsed view */
  subConclusions: SubConclusion[];
  /** Chronological collapsed-turn projection of hidden activity and priority entries. */
  collapsedEntries?: CollapsedTurnEntry[];
  stats: TurnStats;
}

export interface FeedModel {
  entries: FeedEntry[];
  turns: Turn[];
}

/** Count tool_use blocks and subagents recursively in a list of FeedEntries */
function countEntryStats(entries: FeedEntry[]): {
  messages: number;
  tools: number;
  subagents: number;
  herdEvents: number;
  herdEventLifecycle: TakodeHerdEventLifecycle[];
  lastText: string;
} {
  let messages = 0;
  let tools = 0;
  let subagents = 0;
  let herdEvents = 0;
  const herdEventLifecycle: TakodeHerdEventLifecycle[] = [];
  let lastText = "";

  for (const entry of entries) {
    if (entry.kind === "message") {
      const msg = entry.msg;
      if (isCodexReasoningDetailMessage(msg)) continue;
      if (msg.role === "assistant") {
        // Count tool_use blocks
        let entryTools = 0;
        if (msg.contentBlocks) {
          for (const b of msg.contentBlocks) {
            if (b.type === "tool_use") entryTools++;
          }
        }
        tools += entryTools;
        // Only count as a "message" if it has text content (not just tool invocations)
        const text = msg.content?.trim();
        if (text) {
          messages++;
          lastText = text;
        }
      } else {
        // Track herd orchestration event injections
        if (msg.agentSource?.sessionId === "herd-events") {
          herdEvents += Math.max(getHerdEventCount(msg), 1);
          herdEventLifecycle.push(...getHerdEventLifecycles(msg));
        } else {
          // Non-assistant messages (e.g. user, system) count as messages
          messages++;
        }
      }
    } else if (entry.kind === "tool_msg_group") {
      // Tool results — only count as tools, not messages
      tools += entry.items.length;
    } else if (entry.kind === "subagent") {
      subagents++;
      const childStats = countEntryStats(entry.children);
      messages += childStats.messages;
      tools += childStats.tools;
      subagents += childStats.subagents;
      herdEvents += childStats.herdEvents;
      herdEventLifecycle.push(...childStats.herdEventLifecycle);
      if (childStats.lastText) lastText = childStats.lastText;
    } else if (entry.kind === "subagent_batch") {
      for (const sg of entry.subagents) {
        subagents++;
        const childStats = countEntryStats(sg.children);
        messages += childStats.messages;
        tools += childStats.tools;
        subagents += childStats.subagents;
        herdEvents += childStats.herdEvents;
        herdEventLifecycle.push(...childStats.herdEventLifecycle);
        if (childStats.lastText) lastText = childStats.lastText;
      }
    }
  }

  return { messages, tools, subagents, herdEvents, herdEventLifecycle, lastText };
}

/** Check if a FeedEntry is a system message (compact markers, errors, info dividers).
 *  Permission denied/approved badges and quest_claimed blocks are NOT system entries
 *  — they flow with agent activity so they appear at the correct chronological position in the turn.
 *  quest_submitted currently remains a system entry under this classifier. */
function isSystemEntry(entry: FeedEntry): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "system") return false;
  if (entry.msg.metadata?.attentionRecord) return false;
  if (entry.msg.variant === "denied" || entry.msg.variant === "approved" || entry.msg.variant === "quest_claimed")
    return false;
  return true;
}

/** Keep render groups keyed to the same identity used by turn/window modeling. */
export function getEntryId(entry: FeedEntry): string {
  if (entry.kind === "message") return entry.msg.id;
  if (entry.kind === "tool_msg_group") return entry.firstId;
  if (entry.kind === "subagent_batch") return entry.subagents[0]?.taskToolUseId || "batch";
  return entry.taskToolUseId;
}

export function isUserBoundaryEntry(entry: FeedEntry | null, userBoundarySourceSessionId?: string | null): boolean {
  if (!entry || entry.kind !== "message" || entry.msg.role !== "user") return false;
  if (isInjectedEventMessage(entry.msg)) return false;

  const sourceId = entry.msg.agentSource?.sessionId;
  return sourceId == null || (userBoundarySourceSessionId != null && sourceId === userBoundarySourceSessionId);
}

/** Check if a FeedEntry is a herd event message (user message injected by herd dispatcher). */
function isHerdEventEntry(entry: FeedEntry): entry is Extract<FeedEntry, { kind: "message" }> {
  return entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId === "herd-events";
}

/** Summarize herd event messages into a compact one-liner.
 *  Parses "#N | type | ..." header lines from each message and returns
 *  e.g. "Herd: #264 turn_end, #267 turn_end" */
export function summarizeHerdEvents(herdEntries: FeedEntry[]): string {
  const headers: string[] = [];
  for (const entry of herdEntries) {
    if (entry.kind !== "message") continue;
    for (const line of entry.msg.content.split("\n")) {
      if (!EVENT_HEADER_RE.test(line)) continue;
      // Parse "#5 | turn_end | ✓ 15.3s | ..." -> "#5 turn_end"
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length >= 2) {
        headers.push(`${parts[0]} ${parts[1]}`);
      } else {
        headers.push(parts[0]);
      }
    }
  }
  return headers.length > 0 ? `Herd: ${headers.join(", ")}` : "Herd event";
}

/** Extract sub-conclusions from a turn's entries.
 *  A sub-conclusion is the last assistant text message before a herd event injection.
 *  Only the immediately preceding assistant message qualifies -- intervening tool results,
 *  system messages, or other non-assistant entries break the sequence.
 *  Consecutive herd events are grouped into a single summary. */
function extractSubConclusions(entries: FeedEntry[], excludedMessageIds: Set<string>): SubConclusion[] {
  const subConclusions: SubConclusion[] = [];
  let lastAssistantEntry: FeedEntry | null = null;

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    if (
      entry.kind === "message" &&
      entry.msg.role === "assistant" &&
      entry.msg.content?.trim() &&
      !isCodexReasoningDetailMessage(entry.msg) &&
      !isExplicitCommentary(entry.msg)
    ) {
      // Messages already promoted into another collapsed-visible slot (for
      // example notificationEntries or responseEntry) must not also become a
      // sub-conclusion, or the same assistant message renders twice.
      lastAssistantEntry = excludedMessageIds.has(entry.msg.id) ? null : entry;
      i++;
      continue;
    }

    if (isHerdEventEntry(entry) && lastAssistantEntry) {
      // Collect consecutive herd events
      const herdBatch: FeedEntry[] = [];
      while (i < entries.length && isHerdEventEntry(entries[i])) {
        herdBatch.push(entries[i]);
        i++;
      }

      if (lastAssistantEntry) {
        subConclusions.push({
          entry: lastAssistantEntry,
          herdSummary: summarizeHerdEvents(herdBatch),
        });
      }
      lastAssistantEntry = null;
      continue;
    }

    // Non-assistant, non-herd entry (tool results, system messages, etc.)
    // breaks the assistant→herd sequence
    lastAssistantEntry = null;
    i++;
  }

  return subConclusions;
}

function isLeaderBoundaryEntry(entry: FeedEntry): boolean {
  // Only split at user messages. Deprecated assistant suffix tags are treated
  // as literal text and do not affect turn boundaries.
  return isUserBoundaryEntry(entry);
}

function entryIsCollapsedVisible(
  entry: FeedEntry,
  leaderMode: boolean,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
): boolean {
  return (
    entry.kind === "message" &&
    ((entry.msg.role === "assistant" &&
      (entry.msg.notification != null ||
        anchoredNotificationMessageIds?.has(entry.msg.id) === true ||
        isBoardProposalMessage(entry.msg) ||
        (leaderMode && isLeaderNeedsInputStatusMessage(entry.msg)))) ||
      shouldShowAttentionRecordInCollapsedTurn(entry.msg.metadata?.attentionRecord))
  );
}

function shouldShowAttentionRecordInCollapsedTurn(record: SessionAttentionRecord | undefined): boolean {
  if (!record) return false;
  // Journey lifecycle records are filtered before turn-model construction.
  // Of the remaining rows, notification-sourced approval prompts stay turn detail.
  return !(record.type === "needs_input" && record.source.kind === "notification");
}

function messageText(msg: ChatMessage): string {
  const content = msg.content.trim();
  if (content) return content;
  return (msg.contentBlocks ?? [])
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function messagePresentationPhase(msg: ChatMessage): "commentary" | "final_answer" | null {
  if (msg.metadata?.leaderThreadRole === "commentary") return "commentary";
  if (msg.metadata?.leaderThreadRole === "answer") return "final_answer";
  return normalizeCodexMessagePhase(msg.metadata?.codexMessagePhase) ?? null;
}

function isExplicitCommentary(msg: ChatMessage): boolean {
  return messagePresentationPhase(msg) === "commentary";
}

function isExplicitFinalAnswer(msg: ChatMessage): boolean {
  return messagePresentationPhase(msg) === "final_answer";
}

function isExplicitLeaderAnswer(msg: ChatMessage): boolean {
  return msg.metadata?.leaderThreadRole === "answer";
}

function isLegacyPhaseFinalAnswer(msg: ChatMessage): boolean {
  const role = msg.metadata?.leaderThreadRole;
  return (
    (role == null || role === "response") &&
    normalizeCodexMessagePhase(msg.metadata?.codexMessagePhase) === "final_answer"
  );
}

function isAssistantTextResponseEntry(entry: FeedEntry): entry is Extract<FeedEntry, { kind: "message" }> {
  return (
    entry.kind === "message" &&
    entry.msg.role === "assistant" &&
    !isCodexReasoningDetailMessage(entry.msg) &&
    messageText(entry.msg).trim().length > 0
  );
}

function findLastExplicitFinalAnswer(entries: FeedEntry[]): FeedEntry | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isAssistantTextResponseEntry(entry) && isExplicitFinalAnswer(entry.msg)) return entry;
  }
  return null;
}

function toolInputHasNeedsInputNotify(input: Record<string, unknown>): boolean {
  for (const value of Object.values(input)) {
    if (typeof value !== "string") continue;
    if (/\btakode\s+notify\s+needs-input\b/.test(value)) return true;
  }
  return false;
}

function messageHasNeedsInputNotifyTool(msg: ChatMessage): boolean {
  return (msg.contentBlocks ?? []).some(
    (block) => block.type === "tool_use" && toolInputHasNeedsInputNotify(block.input),
  );
}

function entryHasNeedsInputSignal(entry: FeedEntry | null): boolean {
  if (!entry) return false;
  if (entry.kind === "tool_msg_group") return entry.items.some((item) => toolInputHasNeedsInputNotify(item.input));
  if (entry.kind !== "message") return false;

  const { msg } = entry;
  return (
    msg.notification?.category === "needs-input" ||
    msg.metadata?.attentionRecord?.type === "needs_input" ||
    messageHasNeedsInputNotifyTool(msg)
  );
}

function isNeedsInputStatusText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  return (
    /^approval notification `?\d+`? is open\b/i.test(normalized) ||
    /^waiting on confirmation\b/i.test(normalized) ||
    isApprovalCreatedBookkeepingText(normalized) ||
    /\blinked .*needs-input `?\d+`?/i.test(normalized) ||
    /\bwaiting on your (choice|confirmation|decision)\b/i.test(normalized)
  );
}

function isApprovalCreatedBookkeepingText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized || normalized.length > 240 || normalized.split("\n").length > 2) return false;
  return /\bcreated\s+(?:an?\s+|the\s+)?(?:[^.\n]{0,80}\s+)?(?:approval|needs-input)\s+notification\s+`?\d+`?\b/i.test(
    normalized,
  );
}

function isApprovalCreatedBookkeepingEntry(entry: FeedEntry): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "assistant") return false;
  if (entry.msg.metadata?.leaderUserMessage !== true) return false;
  if (entry.msg.notification || entry.msg.metadata?.attentionRecord) return false;
  return isApprovalCreatedBookkeepingText(messageText(entry.msg));
}

const MODEL_ONLY_REMINDER_SOURCE_IDS = new Set([THREAD_OUTCOME_REMINDER_SOURCE_ID, THREAD_ROUTING_REMINDER_SOURCE_ID]);

function isModelOnlyReminderSource(sourceId: string | undefined): boolean {
  return sourceId != null && MODEL_ONLY_REMINDER_SOURCE_IDS.has(sourceId);
}

function isSubstantiveLeaderUserMessage(msg: ChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    msg.metadata?.leaderUserMessage === true &&
    !isCodexReasoningDetailMessage(msg) &&
    !isExplicitCommentary(msg) &&
    messageText(msg).trim().length > 0
  );
}

function isThreadStatusSummaryMessage(msg: ChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    (msg.metadata?.threadStatusMarkers?.length ?? 0) > 0 &&
    !isExplicitCommentary(msg) &&
    messageText(msg).trim().length > 0
  );
}

function isLeaderNeedsInputStatusMessage(msg: ChatMessage): boolean {
  return isSubstantiveLeaderUserMessage(msg) && isNeedsInputStatusText(messageText(msg));
}

function isSubstantiveLeaderResponseEntry(entry: FeedEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.msg.role === "assistant" &&
    !entry.msg.notification &&
    !entry.msg.metadata?.attentionRecord &&
    !isCodexReasoningDetailMessage(entry.msg) &&
    entry.msg.metadata?.leaderThreadRole == null &&
    messagePresentationPhase(entry.msg) === null &&
    messageText(entry.msg).trim().length > 0
  );
}

/** Preserve explicit routed answers per eligible leader segment, but treat
 * provider-phase finals and structural fallbacks as legacy evidence. Legacy
 * history gets at most one representative for the whole direct-human turn;
 * injected boundaries must not manufacture extra answers or anchor a partial
 * bounded-window tail. */
function collectLeaderSegmentResponseRepresentatives(
  rawAgentEntries: FeedEntry[],
  hasUserBoundary: boolean,
  allowOrdinaryLegacyFallback: boolean,
): Set<string> {
  const representativeKeys = new Set<string>();
  let segmentKind: "eligible" | "model-only" | "unknown" = hasUserBoundary ? "eligible" : "unknown";
  let lastExplicitLeaderAnswer: FeedEntry | null = null;
  let lastLegacyPhaseAnswer: FeedEntry | null = null;
  let lastUnknownResponse: FeedEntry | null = null;
  let lastLegacyRepresentative: FeedEntry | null = null;

  const finishSegment = (allowLegacyFallback: boolean) => {
    if (segmentKind !== "eligible") return;
    if (lastExplicitLeaderAnswer) {
      representativeKeys.add(getEntryId(lastExplicitLeaderAnswer));
    } else if (lastLegacyPhaseAnswer) {
      lastLegacyRepresentative = lastLegacyPhaseAnswer;
    } else if (allowLegacyFallback && lastUnknownResponse) {
      lastLegacyRepresentative = lastUnknownResponse;
    }
  };

  for (const entry of rawAgentEntries) {
    if (entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId) {
      const nextSegmentIsModelOnlyReminder = isModelOnlyReminderSource(entry.msg.agentSource.sessionId);
      finishSegment(nextSegmentIsModelOnlyReminder || allowOrdinaryLegacyFallback);
      segmentKind = nextSegmentIsModelOnlyReminder ? "model-only" : hasUserBoundary ? "eligible" : "unknown";
      lastExplicitLeaderAnswer = null;
      lastLegacyPhaseAnswer = null;
      lastUnknownResponse = null;
      continue;
    }

    if (segmentKind !== "eligible" || !isAssistantTextResponseEntry(entry)) continue;
    if (isExplicitLeaderAnswer(entry.msg)) {
      lastExplicitLeaderAnswer = entry;
    } else if (isLegacyPhaseFinalAnswer(entry.msg)) {
      lastLegacyPhaseAnswer = entry;
    } else if (messagePresentationPhase(entry.msg) === null && isSubstantiveLeaderResponseEntry(entry)) {
      lastUnknownResponse = entry;
    }
  }

  finishSegment(allowOrdinaryLegacyFallback);
  if (representativeKeys.size === 0 && lastLegacyRepresentative) {
    representativeKeys.add(getEntryId(lastLegacyRepresentative));
  }
  return representativeKeys;
}

function isPlainLeaderCollapsedSummaryEntry(entry: FeedEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.msg.role === "assistant" &&
    (isSubstantiveLeaderUserMessage(entry.msg) ||
      isThreadStatusSummaryMessage(entry.msg) ||
      isExplicitFinalAnswer(entry.msg)) &&
    !entry.msg.notification &&
    !entry.msg.metadata?.attentionRecord
  );
}

function filterCollapsedVisibleEntriesForModelOnlyReminderSegments(
  rawAgentEntries: FeedEntry[],
  visibleEntries: FeedEntry[],
  leaderMode: boolean,
): FeedEntry[] {
  if (!leaderMode || visibleEntries.length === 0) return visibleEntries;

  const visibleEntryKeys = new Set(visibleEntries.map(getEntryId));
  const retainedVisibleEntryKeys = new Set<string>();
  let modelOnlyReminderSegment = false;

  for (const entry of rawAgentEntries) {
    if (entry.kind === "message" && entry.msg.role === "user" && entry.msg.agentSource?.sessionId) {
      modelOnlyReminderSegment = isModelOnlyReminderSource(entry.msg.agentSource.sessionId);
    }

    const key = getEntryId(entry);
    if (!visibleEntryKeys.has(key)) continue;

    if (modelOnlyReminderSegment && isPlainLeaderCollapsedSummaryEntry(entry)) continue;

    retainedVisibleEntryKeys.add(key);
    if (entryHasNeedsInputSignal(entry)) modelOnlyReminderSegment = false;
  }

  return visibleEntries.filter((entry) => retainedVisibleEntryKeys.has(getEntryId(entry)));
}

function scoreNeedsInputPreviewCandidate(entry: FeedEntry): number {
  if (entry.kind !== "message" || entry.msg.role !== "assistant") return Number.NEGATIVE_INFINITY;
  if (isCodexReasoningDetailMessage(entry.msg) || isExplicitCommentary(entry.msg)) {
    return Number.NEGATIVE_INFINITY;
  }

  const text = messageText(entry.msg);
  if (!text || isNeedsInputStatusText(text)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (messageHasNeedsInputNotifyTool(entry.msg)) score += 8;
  if (/\b(Proposed Quest|Goal \/ Acceptance|Findings|Checkpoint|Recommendation|Decision|Journey)\b/i.test(text)) {
    score += 5;
  }
  const bulletCount = text.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
  if (bulletCount >= 3) score += 3;
  else if (bulletCount > 0) score += 1;
  if (/\[(?:q-\d+|#\d+)[^\]]*\]\((?:quest|session):/.test(text)) score += 2;
  if (text.length >= 120) score += 2;
  if (text.length >= 400) score += 1;

  return score;
}

function nearestPreviewCandidate(
  entries: FeedEntry[],
  start: number,
  step: 1 | -1,
): { index: number; score: number } | null {
  for (let index = start; index >= 0 && index < entries.length; index += step) {
    const score = scoreNeedsInputPreviewCandidate(entries[index]);
    if (score > 0) return { index, score };
  }
  return null;
}

function chooseNeedsInputSegmentPreview(
  hiddenEntries: FeedEntry[],
  previousVisibleEntry: FeedEntry | null,
  nextVisibleEntry: FeedEntry | null,
): FeedEntry | null {
  const candidates: Array<{ index: number; score: number }> = [];

  if (entryHasNeedsInputSignal(nextVisibleEntry)) {
    const candidate = nearestPreviewCandidate(hiddenEntries, hiddenEntries.length - 1, -1);
    if (candidate) candidates.push({ ...candidate, score: candidate.score + 6 });
  }

  if (entryHasNeedsInputSignal(previousVisibleEntry)) {
    const candidate = nearestPreviewCandidate(hiddenEntries, 0, 1);
    if (candidate) candidates.push({ ...candidate, score: candidate.score + 6 });
  }

  for (let index = 0; index < hiddenEntries.length; index++) {
    if (!entryHasNeedsInputSignal(hiddenEntries[index])) continue;
    const sameEntryScore = scoreNeedsInputPreviewCandidate(hiddenEntries[index]);
    if (sameEntryScore > 0) candidates.push({ index, score: sameEntryScore + 10 });

    const before = nearestPreviewCandidate(hiddenEntries, index - 1, -1);
    if (before) candidates.push({ ...before, score: before.score + 4 });

    const after = nearestPreviewCandidate(hiddenEntries, index + 1, 1);
    if (after) candidates.push({ ...after, score: after.score + 4 });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.index - a.index;
  });
  return hiddenEntries[candidates[0].index] ?? null;
}

function filterCollapsedVisibleEntriesForNeedsInputBookkeeping(
  rawAgentEntries: FeedEntry[],
  visibleEntries: FeedEntry[],
  leaderMode: boolean,
): FeedEntry[] {
  if (!leaderMode || visibleEntries.length === 0) return visibleEntries;

  const visibleEntryKeys = new Set(visibleEntries.map(getEntryId));
  const retainedVisibleEntryKeys = new Set<string>();
  let hiddenEntries: FeedEntry[] = [];
  let previousVisibleEntry: FeedEntry | null = null;
  let previousVisibleNeedsInputSegmentHasPreview = false;

  for (const entry of rawAgentEntries) {
    const key = getEntryId(entry);
    if (!visibleEntryKeys.has(key)) {
      hiddenEntries.push(entry);
      continue;
    }

    const segmentPreview = chooseNeedsInputSegmentPreview(hiddenEntries, previousVisibleEntry, entry);
    const hasCurrentNeedsInputPreview = segmentPreview !== null;
    const followsNeedsInputSegmentWithPreview =
      previousVisibleNeedsInputSegmentHasPreview && entryHasNeedsInputSignal(previousVisibleEntry);
    if (
      isApprovalCreatedBookkeepingEntry(entry) &&
      (hasCurrentNeedsInputPreview || followsNeedsInputSegmentWithPreview)
    ) {
      hiddenEntries.push(entry);
      continue;
    }

    retainedVisibleEntryKeys.add(key);
    hiddenEntries = [];
    previousVisibleEntry = entry;
    previousVisibleNeedsInputSegmentHasPreview = entryHasNeedsInputSignal(entry) && hasCurrentNeedsInputPreview;
  }

  return visibleEntries.filter((entry) => retainedVisibleEntryKeys.has(getEntryId(entry)));
}

function buildCollapsedTurnEntries(
  entries: FeedEntry[],
  visibleEntryKeys: ReadonlySet<string>,
  leaderMode: boolean,
): { collapsedEntries: CollapsedTurnEntry[]; promotedEntryKeys: Set<string> } {
  const collapsedEntries: CollapsedTurnEntry[] = [];
  const promotedEntryKeys = new Set<string>();
  let hiddenStartKey: string | null = null;
  let hiddenEntries: FeedEntry[] = [];
  let previousVisibleEntry: FeedEntry | null = null;

  const pushHiddenActivity = (entriesToPush: FeedEntry[], startKey: string | null) => {
    if (startKey === null || entriesToPush.length === 0) return;
    const stats = countEntryStats(entriesToPush);
    collapsedEntries.push({
      kind: "activity",
      key: `activity:${startKey}:${entriesToPush.length}`,
      stats: {
        messageCount: stats.messages,
        toolCount: stats.tools,
        subagentCount: stats.subagents,
        herdEventCount: stats.herdEvents,
        ...(stats.herdEventLifecycle.length > 0 ? { herdEventLifecycle: stats.herdEventLifecycle } : {}),
      },
    });
  };

  const flushHiddenActivity = (nextVisibleEntry: FeedEntry | null) => {
    if (hiddenStartKey === null || hiddenEntries.length === 0) return;
    const promotedEntry = leaderMode
      ? chooseNeedsInputSegmentPreview(hiddenEntries, previousVisibleEntry, nextVisibleEntry)
      : null;

    if (promotedEntry) {
      const promotedKey = getEntryId(promotedEntry);
      const promotedIndex = hiddenEntries.findIndex((entry) => getEntryId(entry) === promotedKey);
      const before = hiddenEntries.slice(0, promotedIndex);
      const after = hiddenEntries.slice(promotedIndex + 1);
      pushHiddenActivity(before, before.length > 0 ? getEntryId(before[0]) : null);
      collapsedEntries.push({ kind: "entry", key: `entry:${promotedKey}`, entry: promotedEntry });
      promotedEntryKeys.add(promotedKey);
      pushHiddenActivity(after, after.length > 0 ? getEntryId(after[0]) : null);
    } else {
      pushHiddenActivity(hiddenEntries, hiddenStartKey);
    }

    hiddenStartKey = null;
    hiddenEntries = [];
  };

  for (const entry of entries) {
    const key = getEntryId(entry);
    if (visibleEntryKeys.has(key)) {
      flushHiddenActivity(entry);
      collapsedEntries.push({ kind: "entry", key: `entry:${key}`, entry });
      previousVisibleEntry = entry;
      continue;
    }
    hiddenStartKey ??= key;
    hiddenEntries.push(entry);
  }

  flushHiddenActivity(null);
  return { collapsedEntries, promotedEntryKeys };
}

/** Build a Turn from accumulated entries */
function isFeedEntryRenderable(
  entry: FeedEntry,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
  visibleAssistantChildMessageIds?: ReadonlySet<string>,
): boolean {
  if (entry.kind !== "message" || entry.msg.role !== "assistant") return true;
  return isAssistantMessageRenderable(entry.msg, {
    hasAnchoredNotification: anchoredNotificationMessageIds?.has(entry.msg.id),
    hasVisibleSideChat: visibleAssistantChildMessageIds?.has(entry.msg.id),
  });
}

function makeTurn(
  userEntry: FeedEntry | null,
  entries: FeedEntry[],
  turnIndex: number,
  leaderMode = false,
  leaderSessionMode = leaderMode,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
  visibleAssistantChildMessageIds?: ReadonlySet<string>,
): Turn {
  // Separate system messages (always visible) from collapsible agent activity
  const rawAgentEntries: FeedEntry[] = [];
  const systemEntries: FeedEntry[] = [];
  for (const e of entries) {
    if (isSystemEntry(e)) {
      systemEntries.push(e);
    } else {
      rawAgentEntries.push(e);
    }
  }

  // Preserve raw entries for audit, replay, routing, and viewport identity, but
  // derive presentation from assistant entries that still have visible output
  // after marker/content projection. Invisible rows must not create collapsed
  // activity, representatives, or counts.
  const presentationAgentEntries = rawAgentEntries.filter((entry) =>
    isFeedEntryRenderable(entry, anchoredNotificationMessageIds, visibleAssistantChildMessageIds),
  );
  const presentationEntries = entries.filter((entry) =>
    isFeedEntryRenderable(entry, anchoredNotificationMessageIds, visibleAssistantChildMessageIds),
  );

  const s = countEntryStats(presentationAgentEntries);

  // Existing notification and attention rows remain collapsed-visible. Explicit
  // routed answers may represent their eligible segments, while provider-phase
  // finals and structural unknowns are legacy evidence with at most one
  // representative for the whole source-anchored turn. Model-only reminder
  // output and unanchored bounded-window tails remain activity.
  const leaderSegmentRepresentativeKeys =
    leaderMode || leaderSessionMode
      ? collectLeaderSegmentResponseRepresentatives(presentationAgentEntries, userEntry !== null, !leaderMode)
      : new Set<string>();
  const notificationEntryCandidates: FeedEntry[] = [];
  for (const e of presentationAgentEntries) {
    if (
      (leaderMode && leaderSegmentRepresentativeKeys.has(getEntryId(e))) ||
      entryIsCollapsedVisible(e, leaderMode, anchoredNotificationMessageIds)
    ) {
      notificationEntryCandidates.push(e);
    }
  }
  const reminderFilteredEntries = filterCollapsedVisibleEntriesForModelOnlyReminderSegments(
    presentationAgentEntries,
    notificationEntryCandidates,
    leaderMode,
  );
  const notificationEntries = filterCollapsedVisibleEntriesForNeedsInputBookkeeping(
    presentationAgentEntries,
    reminderFilteredEntries,
    leaderMode,
  );

  // Ordinary/Main/All turns prefer the last explicit routed/Codex final answer. Only
  // when no final answer exists do unannotated messages use the legacy last-text
  // fallback; explicit commentary stays activity. Selected leader threads use
  // the segment-aware representatives above instead.
  let responseEntry: FeedEntry | null = null;
  if (!leaderMode) {
    const notificationEntryKeys = new Set(notificationEntries.map(getEntryId));
    if (leaderSessionMode) {
      for (let i = presentationAgentEntries.length - 1; i >= 0; i--) {
        const entry = presentationAgentEntries[i];
        if (notificationEntryKeys.has(getEntryId(entry))) continue;
        if (leaderSegmentRepresentativeKeys.has(getEntryId(entry))) {
          responseEntry = entry;
          break;
        }
      }
    } else {
      const explicitFinalAnswerEntry = findLastExplicitFinalAnswer(presentationAgentEntries);
      if (explicitFinalAnswerEntry && !notificationEntryKeys.has(getEntryId(explicitFinalAnswerEntry))) {
        responseEntry = explicitFinalAnswerEntry;
      }
    }
    if (!responseEntry && !leaderSessionMode && !findLastExplicitFinalAnswer(presentationAgentEntries)) {
      for (let i = presentationAgentEntries.length - 1; i >= 0; i--) {
        const entry = presentationAgentEntries[i];
        if (notificationEntryKeys.has(getEntryId(entry))) continue;
        if (isAssistantTextResponseEntry(entry) && !isExplicitCommentary(entry.msg)) {
          responseEntry = entry;
          break;
        }
      }
    }
  }

  const collapsedVisibleEntryKeys = new Set<string>();
  const collapsedVisibleMessageIds = new Set<string>();
  for (const entry of notificationEntries) {
    collapsedVisibleEntryKeys.add(getEntryId(entry));
    if (entry.kind === "message") collapsedVisibleMessageIds.add(entry.msg.id);
  }
  if (responseEntry) {
    collapsedVisibleEntryKeys.add(getEntryId(responseEntry));
    if (responseEntry.kind === "message") collapsedVisibleMessageIds.add(responseEntry.msg.id);
  }
  const { collapsedEntries, promotedEntryKeys } = buildCollapsedTurnEntries(
    presentationAgentEntries,
    collapsedVisibleEntryKeys,
    leaderMode,
  );
  for (const key of promotedEntryKeys) collapsedVisibleEntryKeys.add(key);

  const agentEntries = presentationAgentEntries.filter((entry) => !collapsedVisibleEntryKeys.has(getEntryId(entry)));

  // Extract sub-conclusions for normal sessions only. In leader sessions,
  // ordinary assistant text is private activity unless server metadata marks
  // it as a routed response or a preserved leader-visible history row.
  const subConclusions = leaderMode ? [] : extractSubConclusions(presentationEntries, collapsedVisibleMessageIds);

  // Stable ID: prefer user message ID, fall back to first agent entry ID, then synthetic
  const id = userEntry
    ? userEntry.kind === "message"
      ? userEntry.msg.id
      : `turn-u-${turnIndex}`
    : entries.length > 0
      ? `turn-a-${getEntryId(entries[0])}`
      : `turn-${turnIndex}`;

  return {
    id,
    userEntry,
    allEntries: entries,
    presentationEntries,
    agentEntries,
    systemEntries,
    notificationEntries,
    responseEntry,
    subConclusions,
    collapsedEntries,
    stats: {
      // Subtract responseEntry and notificationEntries; remaining count reflects
      // messages still inside the collapsible agent activity section.
      messageCount:
        s.messages - (responseEntry ? 1 : 0) - countEntryStats(notificationEntries).messages - promotedEntryKeys.size,
      toolCount: s.tools,
      subagentCount: s.subagents,
      herdEventCount: s.herdEvents,
      ...(s.herdEventLifecycle.length > 0 ? { herdEventLifecycle: s.herdEventLifecycle } : {}),
    },
  };
}

/** Group flat feed entries into turns.
 *  Leader mode splits only on real human user boundaries. Injected user-shaped
 *  updates carry agentSource and remain inside the current agent turn. */
export function groupIntoTurns(
  entries: FeedEntry[],
  leaderMode = false,
  startTurnIndex = 0,
  anchoredNotificationMessageIds?: ReadonlySet<string>,
  userBoundarySourceSessionId?: string | null,
  visibleAssistantChildMessageIds?: ReadonlySet<string>,
  leaderSessionMode = leaderMode,
): Turn[] {
  const turns: Turn[] = [];
  let currentUser: FeedEntry | null = null;
  let currentEntries: FeedEntry[] = [];

  for (const entry of entries) {
    const isBoundary = leaderMode
      ? isLeaderBoundaryEntry(entry)
      : isUserBoundaryEntry(entry, userBoundarySourceSessionId);
    if (isBoundary) {
      // Flush previous turn
      if (currentUser !== null || currentEntries.length > 0) {
        turns.push(
          makeTurn(
            currentUser,
            currentEntries,
            startTurnIndex + turns.length,
            leaderMode,
            leaderSessionMode,
            anchoredNotificationMessageIds,
            visibleAssistantChildMessageIds,
          ),
        );
      }
      currentUser = entry;
      currentEntries = [];
    } else {
      currentEntries.push(entry);
    }
  }

  // Flush final turn
  if (currentUser !== null || currentEntries.length > 0) {
    turns.push(
      makeTurn(
        currentUser,
        currentEntries,
        startTurnIndex + turns.length,
        leaderMode,
        leaderSessionMode,
        anchoredNotificationMessageIds,
        visibleAssistantChildMessageIds,
      ),
    );
  }

  return turns;
}

export function buildFeedModel(
  messages: ChatMessage[],
  leaderMode = false,
  startTurnIndex = 0,
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
  userBoundarySourceSessionId?: string | null,
  visibleAssistantChildMessageIds?: ReadonlySet<string> | readonly string[],
  leaderSessionMode = leaderMode,
): FeedModel {
  const anchoredIds =
    anchoredNotificationMessageIds instanceof Set
      ? anchoredNotificationMessageIds
      : new Set(anchoredNotificationMessageIds ?? []);
  const visibleChildIds =
    visibleAssistantChildMessageIds instanceof Set
      ? visibleAssistantChildMessageIds
      : new Set(visibleAssistantChildMessageIds ?? []);
  const entries = groupMessages(messages, anchoredIds);
  const turns = groupIntoTurns(
    entries,
    leaderMode,
    startTurnIndex,
    anchoredIds,
    userBoundarySourceSessionId,
    visibleChildIds,
    leaderSessionMode,
  );
  return { entries, turns };
}

function shouldMergeFirstActiveTurnIntoLastFrozenTurn(baseTurn: Turn, nextTurn: Turn): boolean {
  if (nextTurn.userEntry !== null) return false;
  return true;
}

function concatFeedModels(
  base: FeedModel,
  next: FeedModel,
  leaderMode = false,
  anchoredNotificationMessageIds?: ReadonlySet<string> | readonly string[],
  userBoundarySourceSessionId?: string | null,
  visibleAssistantChildMessageIds?: ReadonlySet<string> | readonly string[],
  leaderSessionMode = leaderMode,
): FeedModel {
  if (base.entries.length === 0) return next;
  if (next.entries.length === 0) return base;

  // When the frozen/active boundary falls between two assistant messages
  // with no user message in between (e.g., a task_notification-triggered turn),
  // the active model's first turn has userEntry === null. Merge it into the
  // last frozen turn so they appear as one continuous agent turn in the UI,
  // rather than creating a phantom turn boundary that causes incorrect collapsing.
  let mergedTurns: Turn[];
  if (
    next.turns.length > 0 &&
    base.turns.length > 0 &&
    shouldMergeFirstActiveTurnIntoLastFrozenTurn(base.turns[base.turns.length - 1], next.turns[0])
  ) {
    const lastBase = base.turns[base.turns.length - 1];
    const firstNext = next.turns[0];
    // Re-derive the merged turn via makeTurn so stats, response entry,
    // and system/agent separation are all consistent.
    const merged = makeTurn(
      lastBase.userEntry,
      [...lastBase.allEntries, ...firstNext.allEntries],
      base.turns.length - 1,
      leaderMode,
      leaderSessionMode,
      anchoredNotificationMessageIds instanceof Set
        ? anchoredNotificationMessageIds
        : new Set(anchoredNotificationMessageIds ?? []),
      visibleAssistantChildMessageIds instanceof Set
        ? visibleAssistantChildMessageIds
        : new Set(visibleAssistantChildMessageIds ?? []),
    );
    mergedTurns = [...base.turns.slice(0, -1), merged, ...next.turns.slice(1)];
  } else {
    mergedTurns = [...base.turns, ...next.turns];
  }

  return {
    entries: [...base.entries, ...next.entries],
    turns: mergedTurns,
  };
}

function haveSameMessageRefs(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useFeedModel(
  messages: ChatMessage[],
  config?: {
    leaderMode?: boolean;
    leaderSessionMode?: boolean;
    frozenCount?: number;
    frozenRevision?: number;
    anchoredNotificationMessageIds?: readonly string[];
    userBoundarySourceSessionId?: string | null;
    visibleAssistantChildMessageIds?: readonly string[];
    /** Server-proven identity for a leading turn whose human boundary is outside the loaded window. */
    leadingTurnId?: string;
    perf?: { sessionId: string; threadKey: string };
  },
): FeedModel {
  const leaderMode = config?.leaderMode ?? false;
  const leaderSessionMode = config?.leaderSessionMode ?? leaderMode;
  const frozenCount = Math.max(0, Math.min(config?.frozenCount ?? 0, messages.length));
  const frozenRevision = config?.frozenRevision ?? 0;
  const anchoredNotificationMessageIds = config?.anchoredNotificationMessageIds ?? [];
  const userBoundarySourceSessionId = config?.userBoundarySourceSessionId ?? null;
  const leadingTurnId = config?.leadingTurnId;
  const visibleAssistantChildMessageIds = config?.visibleAssistantChildMessageIds ?? [];
  const visibleAssistantChildSignature = visibleAssistantChildMessageIds.join("\0");
  const anchoredNotificationSignature = anchoredNotificationMessageIds.join("\0");
  const perfSessionId = config?.perf?.sessionId;
  const perfThreadKey = config?.perf?.threadKey;
  const cacheRef = useRef<{
    leaderMode: boolean;
    leaderSessionMode: boolean;
    frozenCount: number;
    frozenRevision: number;
    anchoredNotificationSignature: string;
    userBoundarySourceSessionId: string | null;
    visibleAssistantChildSignature: string;
    frozenMessages: ChatMessage[];
    frozenModel: FeedModel;
  } | null>(null);

  const model = useMemo(() => {
    const frozenMessages = messages.slice(0, frozenCount);
    const activeMessages = messages.slice(frozenCount);

    let frozenModel: FeedModel;
    const cached = cacheRef.current;
    if (
      cached &&
      cached.leaderMode === leaderMode &&
      cached.leaderSessionMode === leaderSessionMode &&
      cached.frozenCount === frozenCount &&
      cached.frozenRevision === frozenRevision &&
      cached.anchoredNotificationSignature === anchoredNotificationSignature &&
      cached.userBoundarySourceSessionId === userBoundarySourceSessionId &&
      cached.visibleAssistantChildSignature === visibleAssistantChildSignature &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages)
    ) {
      frozenModel = cached.frozenModel;
    } else if (
      cached &&
      cached.leaderMode === leaderMode &&
      cached.leaderSessionMode === leaderSessionMode &&
      cached.frozenRevision === frozenRevision &&
      cached.anchoredNotificationSignature === anchoredNotificationSignature &&
      cached.userBoundarySourceSessionId === userBoundarySourceSessionId &&
      cached.visibleAssistantChildSignature === visibleAssistantChildSignature &&
      frozenCount >= cached.frozenCount &&
      haveSameMessageRefs(cached.frozenMessages, frozenMessages.slice(0, cached.frozenCount))
    ) {
      const newlyFrozen = frozenMessages.slice(cached.frozenCount);
      const deltaModel = buildFeedModel(
        newlyFrozen,
        leaderMode,
        cached.frozenModel.turns.length,
        anchoredNotificationMessageIds,
        userBoundarySourceSessionId,
        visibleAssistantChildMessageIds,
        leaderSessionMode,
      );
      frozenModel = concatFeedModels(
        cached.frozenModel,
        deltaModel,
        leaderMode,
        anchoredNotificationMessageIds,
        userBoundarySourceSessionId,
        visibleAssistantChildMessageIds,
        leaderSessionMode,
      );
    } else {
      frozenModel = buildFeedModel(
        frozenMessages,
        leaderMode,
        0,
        anchoredNotificationMessageIds,
        userBoundarySourceSessionId,
        visibleAssistantChildMessageIds,
        leaderSessionMode,
      );
    }

    cacheRef.current = {
      leaderMode,
      leaderSessionMode,
      frozenCount,
      frozenRevision,
      anchoredNotificationSignature,
      userBoundarySourceSessionId,
      visibleAssistantChildSignature,
      frozenMessages,
      frozenModel,
    };

    const activeModel = buildFeedModel(
      activeMessages,
      leaderMode,
      frozenModel.turns.length,
      anchoredNotificationMessageIds,
      userBoundarySourceSessionId,
      visibleAssistantChildMessageIds,
      leaderSessionMode,
    );
    const combined = concatFeedModels(
      frozenModel,
      activeModel,
      leaderMode,
      anchoredNotificationMessageIds,
      userBoundarySourceSessionId,
      visibleAssistantChildMessageIds,
      leaderSessionMode,
    );
    const leadingTurn = combined.turns[0];
    if (!leadingTurnId || !leadingTurn || leadingTurn.userEntry !== null || leadingTurn.id === leadingTurnId) {
      return combined;
    }
    // Window bounds can move inside one human turn. Keep its identity without
    // inserting an unloaded message or mutating the cached frozen model.
    return { ...combined, turns: [{ ...leadingTurn, id: leadingTurnId }, ...combined.turns.slice(1)] };
  }, [
    messages,
    leaderMode,
    leaderSessionMode,
    frozenCount,
    frozenRevision,
    anchoredNotificationMessageIds,
    anchoredNotificationSignature,
    userBoundarySourceSessionId,
    leadingTurnId,
    visibleAssistantChildMessageIds,
    visibleAssistantChildSignature,
  ]);

  useEffect(() => {
    if (!perfSessionId || !perfThreadKey) return;
    recordFeedRenderSnapshot({
      sessionId: perfSessionId,
      threadKey: perfThreadKey,
      messageCount: messages.length,
      entryCount: model.entries.length,
      turnCount: model.turns.length,
    });
  }, [messages.length, model.entries.length, model.turns.length, perfSessionId, perfThreadKey]);

  return model;
}
