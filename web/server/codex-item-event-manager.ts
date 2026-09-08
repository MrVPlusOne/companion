import { randomUUID } from "node:crypto";
import { normalizeCodexMessagePhase, type CodexMessagePhase } from "../shared/codex-message-phase.js";
import type { BrowserIncomingMessage, CodexCompactionCause, CodexCompactionCauseSource } from "./session-types.js";
import {
  CodexAgentMessageItem,
  CodexCollabAgentToolCallItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexImageViewItem,
  CodexItem,
  CodexMcpToolCallItem,
  CodexReasoningItem,
  CodexWebSearchItem,
  PendingSubagentToolUse,
  ToolFileChange,
  extractWebSearchQuery,
  extractWebSearchResultText,
  firstNonEmptyString,
  formatCommandForDisplay,
  hasAnyPatchDiff,
  isWriteLikeFileChangeKind,
  mapUnknownFileChangesForTool,
  parseToolArguments,
  safeKind,
  toSafeText,
} from "./codex-adapter-utils.js";
import {
  CodexReasoningDetailAssembler,
  type CodexReasoningDetailPartUpdate,
} from "./codex-reasoning-detail-assembler.js";

type EmitFn = (msg: BrowserIncomingMessage) => void;

type ToolEmitOptions = {
  parentToolUseId?: string | null;
  timestamp?: number;
};

type RouterFailureToolName = "write_stdin";
type CompactionCauseAttribution = { cause: CodexCompactionCause; source?: CodexCompactionCauseSource };

const RAW_EXEC_CALL_CACHE_LIMIT = 50;
const RAW_EXEC_OUTPUT_COMMAND_CACHE_LIMIT = 50;
const RAW_EXEC_OUTPUTS_PER_COMMAND_LIMIT = 5;
const NEXT_COMPACTION_CAUSE_TTL_MS = 60_000;

type TerminalInteractionToolUse = {
  toolUseId: string;
  commandToolUseId: string;
  processId: string;
  stdin: string;
  parentToolUseId: string | null;
};

export class CodexItemEventManager {
  private streamingTextByItemId = new Map<string, string>();
  private messagePhaseByItemId = new Map<string, CodexMessagePhase>();

  private commandStartTimes = new Map<string, number>();
  private commandOutputByItemId = new Map<string, string>();
  private planToolUseSeq = 0;
  private terminalInteractionToolUseSeq = 0;
  private planSignatureByKey = new Map<string, string>();

  private readonly reasoningDetails = new CodexReasoningDetailAssembler();
  private lastMessageFinishedAt: number | null = null;

  private emittedToolUseIds = new Set<string>();
  private emittedToolUseInputsById = new Map<string, Record<string, unknown>>();
  private emittedToolUseNamesById = new Map<string, string>();
  private emittedToolResultIds = new Set<string>();
  private activeToolUseIds = new Set<string>();
  private terminalInteractionByProcessId = new Map<string, TerminalInteractionToolUse>();
  private failedTerminalRouterErrorKeys = new Set<string>();
  private patchChangesByCallId = new Map<string, ToolFileChange[]>();
  private rawExecCommandByCallId = new Map<string, string>();
  private rawExecOutputByCallId = new Map<string, string>();
  private rawExecOutputsByCommand = new Map<string, string[]>();
  private parentToolUseIdByThreadId = new Map<string, string>();
  private parentToolUseIdByItemId = new Map<string, string | null>();
  private pendingSubagentToolUsesByCallId = new Map<string, PendingSubagentToolUse>();
  private nextCompactionCause: (CompactionCauseAttribution & { expiresAt: number }) | null = null;
  private compactionCauseByItemId = new Map<string, CompactionCauseAttribution>();

  constructor(
    private readonly emit: EmitFn,
    private readonly options: { model?: string },
  ) {}

  dispose(): void {
    this.streamingTextByItemId.clear();
    this.messagePhaseByItemId.clear();
    this.commandStartTimes.clear();
    this.commandOutputByItemId.clear();
    this.planSignatureByKey.clear();
    this.reasoningDetails.reset();
    this.emittedToolUseIds.clear();
    this.emittedToolUseInputsById.clear();
    this.emittedToolUseNamesById.clear();
    this.emittedToolResultIds.clear();
    this.activeToolUseIds.clear();
    this.terminalInteractionByProcessId.clear();
    this.failedTerminalRouterErrorKeys.clear();
    this.patchChangesByCallId.clear();
    this.rawExecCommandByCallId.clear();
    this.rawExecOutputByCallId.clear();
    this.rawExecOutputsByCommand.clear();
    this.parentToolUseIdByThreadId.clear();
    this.parentToolUseIdByItemId.clear();
    this.pendingSubagentToolUsesByCallId.clear();
    this.nextCompactionCause = null;
    this.compactionCauseByItemId.clear();
    this.lastMessageFinishedAt = null;
  }

  finishReasoningTurn(turnId: string): void {
    this.reasoningDetails.finishTurn(turnId);
  }

  markMessageFinished(timestamp: number): void {
    this.lastMessageFinishedAt = timestamp;
  }

  markNextCompactionCause(
    cause: CodexCompactionCause,
    now = Date.now(),
    source: CodexCompactionCauseSource | undefined = cause === "manual" ? "takode_manual_request" : undefined,
  ): void {
    this.nextCompactionCause = {
      cause,
      ...(source ? { source } : {}),
      expiresAt: now + NEXT_COMPACTION_CAUSE_TTL_MS,
    };
  }

  clearNextCompactionCause(cause?: CodexCompactionCause): void {
    if (!this.nextCompactionCause || (cause && this.nextCompactionCause.cause !== cause)) return;
    this.nextCompactionCause = null;
  }

  private consumeNextCompactionCause(now = Date.now()): CompactionCauseAttribution {
    const pending = this.nextCompactionCause;
    this.nextCompactionCause = null;
    if (!pending || pending.expiresAt < now) return { cause: "unknown" };
    return { cause: pending.cause, ...(pending.source ? { source: pending.source } : {}) };
  }

  private rememberMessagePhase(itemId: string, value: unknown): void {
    const phase = normalizeCodexMessagePhase(value);
    if (phase) this.messagePhaseByItemId.set(itemId, phase);
  }

  cachePatchApplyChanges(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") return;
    const callId = toSafeText(msg.call_id ?? msg.callId).trim();
    if (!callId) return;
    const changes = mapUnknownFileChangesForTool(msg.changes);
    if (changes.length > 0) {
      this.patchChangesByCallId.set(callId, changes);
    }
  }

  resolveParentToolUseId(params: Record<string, unknown>, itemId?: string): string | null {
    if (itemId && this.parentToolUseIdByItemId.has(itemId)) {
      return this.parentToolUseIdByItemId.get(itemId) ?? null;
    }
    return this.getParentToolUseIdForThreadId(this.getThreadIdFromParams(params));
  }

  handleSubagentTaskComplete(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    const threadId = this.getThreadIdFromParams(params);
    const toolUseId = this.getParentToolUseIdForThreadId(threadId);
    if (!toolUseId) return;

    const resultText =
      toSafeText(
        msg?.last_agent_message ??
          params.last_agent_message ??
          msg?.summary ??
          params.summary ??
          msg?.message ??
          params.message,
      ).trim() || "Subagent completed";

    const parentToolUseId = this.pendingSubagentToolUsesByCallId.get(toolUseId)?.parentToolUseId ?? null;
    this.emitToolResult(toolUseId, resultText, false, parentToolUseId);
  }

  handleItemStarted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);
    this.parentToolUseIdByItemId.set(item.id, parentToolUseId);

    switch (item.type) {
      case "agentMessage":
        this.streamingTextByItemId.set(item.id, "");
        this.rememberMessagePhase(item.id, (item as CodexAgentMessageItem).phase);
        this.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: this.makeMessageId("agent", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        this.commandStartTimes.set(item.id, Date.now());
        this.commandOutputByItemId.delete(item.id);
        this.emitToolUseStart(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const fileChangeTool = this.buildFileChangeTool(item.id, fc.changes);
        if (!fileChangeTool) {
          break;
        }
        this.emitToolUseStart(item.id, fileChangeTool.toolName, fileChangeTool.input, { parentToolUseId });
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.emitToolUseStart(item.id, this.displayNameForMcpTool(mcp), this.inputForMcpTool(mcp), { parentToolUseId });
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        this.emitToolUseStart(item.id, "WebSearch", this.buildWebSearchToolInput(ws), { parentToolUseId });
        break;
      }

      case "imageView": {
        const imageView = item as CodexImageViewItem;
        this.emitToolUseStart(item.id, "view_image", { path: imageView.path || "" }, { parentToolUseId });
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const thinkingTimeMs =
          typeof this.lastMessageFinishedAt === "number"
            ? Math.max(0, Date.now() - this.lastMessageFinishedAt)
            : undefined;
        this.emitReasoningDetailUpdates(
          this.reasoningDetails.start({
            turnId: toSafeText(params.turnId),
            itemId: item.id,
            summary: r.summary,
            parentToolUseId,
            thinkingTimeMs,
          }),
        );
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;
        const senderThreadId = toSafeText(collab.senderThreadId).trim() || this.getThreadIdFromParams(params);
        this.pendingSubagentToolUsesByCallId.set(item.id, {
          prompt: toSafeText(collab.prompt).trim(),
          startedAt: Date.now(),
          senderThreadId: senderThreadId || null,
          parentToolUseId: this.getParentToolUseIdForThreadId(senderThreadId),
        });
        break;
      }

      case "contextCompaction": {
        const attribution = this.consumeNextCompactionCause();
        this.compactionCauseByItemId.set(item.id, attribution);
        this.emit({
          type: "status_change",
          status: "compacting",
          codexCompactionCause: attribution.cause,
          ...(attribution.source ? { codexCompactionCauseSource: attribution.source } : {}),
        });
        break;
      }

      default:
        break;
    }
  }

  handleReasoningSummaryPartAdded(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    this.reasoningDetails.addPart({
      turnId: toSafeText(params.turnId),
      itemId,
      summaryIndex: params.summaryIndex,
      parentToolUseId: this.resolveParentToolUseId(params, itemId),
    });
  }

  handleReasoningSummaryDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    const delta = typeof params.delta === "string" ? params.delta : typeof params.text === "string" ? params.text : "";
    if (!delta) return;
    this.emitReasoningDetailUpdates(
      this.reasoningDetails.appendDelta({
        turnId: toSafeText(params.turnId),
        itemId,
        summaryIndex: params.summaryIndex,
        delta,
        parentToolUseId: this.resolveParentToolUseId(params, itemId),
      }),
    );
  }

  handleAgentMessageDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    const delta = params.delta as string;
    if (!delta) return;

    if (!itemId) return;
    const currentText = this.streamingTextByItemId.get(itemId) ?? "";
    this.streamingTextByItemId.set(itemId, currentText + delta);
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
      parent_tool_use_id: this.resolveParentToolUseId(params, itemId),
    });
  }

  handleItemUpdated(_params: Record<string, unknown>): void {
    // item/updated is a general update — currently we handle streaming via specific delta events.
  }

  handleTerminalInteraction(params: Record<string, unknown>): void {
    const itemId = toSafeText(params.itemId).trim();
    const processId = toSafeText(params.processId).trim();
    if (!itemId || !processId) return;

    const stdin = typeof params.stdin === "string" ? params.stdin : "";
    const parentToolUseId = this.resolveParentToolUseId(params, itemId);
    const toolUseId = `${itemId}:terminal:${++this.terminalInteractionToolUseSeq}`;

    this.emitToolUseTracked(
      toolUseId,
      "write_stdin",
      {
        session_id: processId,
        chars: stdin,
      },
      { parentToolUseId },
    );

    const summary =
      stdin.length === 0
        ? `Polled session ${processId} via write_stdin(chars="").`
        : `Sent stdin to session ${processId} via write_stdin.`;
    this.emitToolResult(toolUseId, summary, false, parentToolUseId);
    this.rememberTerminalInteraction({
      toolUseId,
      commandToolUseId: itemId,
      processId,
      stdin,
      parentToolUseId,
    });
  }

  handleRawResponseItemCompleted(params: Record<string, unknown>): void {
    const item =
      (params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : null) ??
      (params.responseItem && typeof params.responseItem === "object"
        ? (params.responseItem as Record<string, unknown>)
        : null) ??
      (params.rawResponseItem && typeof params.rawResponseItem === "object"
        ? (params.rawResponseItem as Record<string, unknown>)
        : null);
    if (!item) return;

    const itemType = toSafeText(item.type).trim().toLowerCase();
    if (this.handleRawExecItemCompleted(item, itemType)) {
      return;
    }

    if (itemType === "web_search_call") {
      this.handleRawWebSearchCompleted(params, item);
      return;
    }

    if (itemType !== "function_call") return;

    const toolName = toSafeText(item.name).trim();
    if (toolName !== "view_image") return;

    const toolUseId = toSafeText(item.call_id ?? item.callId ?? item.id).trim() || `raw-${randomUUID()}`;
    const toolInput = parseToolArguments(item.arguments);
    const parentToolUseId = this.resolveParentToolUseId(params, toolUseId);
    this.ensureToolUseData(toolUseId, toolName, toolInput, { parentToolUseId }, true);
    this.emitToolResultOnce(toolUseId, this.buildImageViewResultText(toolInput.path), false, parentToolUseId);
  }

  emitPlanTodoWrite(params: Record<string, unknown>, source: "item_plan_delta" | "turn_plan_updated"): void {
    const todos = this.extractPlanTodos(params);
    const key = toSafeText(params.turnId ?? params.itemId ?? params.threadId ?? source) || source;
    const signature = JSON.stringify(todos);
    const previousSignature = this.planSignatureByKey.get(key);
    if (previousSignature === signature) return;
    // A fresh manager has no local signature memory after reconnect. An
    // authoritative empty turn plan still needs to clear a checklist emitted
    // by the prior adapter, while an unparseable first prose delta remains a
    // no-op. Retain the empty signature so repeats deduplicate locally too.
    if (todos.length === 0 && previousSignature == null && source === "item_plan_delta") return;
    this.planSignatureByKey.set(key, signature);

    // The bridge reconciles this adapter-local sequence with persisted plan
    // history after reconnect, preserving normal uninterrupted A -> B -> A
    // transitions while rekeying only sequence collisions from recreation.
    const toolUseId = `codex-plan-${key}-${++this.planToolUseSeq}`;
    this.emitToolUseTracked(
      toolUseId,
      "TodoWrite",
      { todos },
      {
        parentToolUseId: this.resolveParentToolUseId(params, toolUseId),
      },
    );
  }

  handleItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);
    this.activeToolUseIds.delete(item.id);
    this.clearTerminalInteractionsForCommand(item.id);

    switch (item.type) {
      case "agentMessage": {
        const agentMsg = item as CodexAgentMessageItem;
        const text = agentMsg.text || this.streamingTextByItemId.get(item.id) || "";
        const completedPhase = normalizeCodexMessagePhase(agentMsg.phase);
        const codexMessagePhase = completedPhase ?? this.messagePhaseByItemId.get(item.id);
        const completedAt = Date.now();

        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null },
            usage: { output_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "assistant",
          message: {
            id: this.makeMessageId("agent", item.id),
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
          ...(codexMessagePhase ? { codexMessagePhase } : {}),
          timestamp: completedAt,
        });
        // Completion must retire live text even when the bridge deduplicates
        // the completed assistant row. Item completion is not turn completion.
        this.emit({
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: parentToolUseId,
        });
        this.markMessageFinished(completedAt);
        this.streamingTextByItemId.delete(item.id);
        this.messagePhaseByItemId.delete(item.id);
        break;
      }

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        this.ensureToolUseEmitted(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        this.commandStartTimes.delete(item.id);
        const streamedOutput = (this.commandOutputByItemId.get(item.id) || "").trim();
        this.commandOutputByItemId.delete(item.id);
        const cmdRecord = item as Record<string, unknown>;
        const output = firstNonEmptyString(cmdRecord, [
          "stdout",
          "aggregatedOutput",
          "aggregated_output",
          "formatted_output",
          "output",
        ]);
        const stderr = firstNonEmptyString(cmdRecord, ["stderr", "errorOutput", "error_output"]);
        const directOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const combinedOutput = directOutput || streamedOutput;
        const exitCode = typeof cmd.exitCode === "number" ? cmd.exitCode : 0;
        const durationMs = typeof cmd.durationMs === "number" ? cmd.durationMs : undefined;
        const failed = cmd.status === "failed" || cmd.status === "declined" || exitCode !== 0;

        let resultText = combinedOutput;
        if (!resultText) {
          resultText = `Exit code: ${exitCode}`;
        } else if (exitCode !== 0) {
          resultText = `${resultText}\nExit code: ${exitCode}`;
        }
        resultText = this.takeFullerRawExecOutput(commandStr, resultText) ?? resultText;
        if (durationMs !== undefined && durationMs >= 100) {
          const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
          resultText = `${resultText}\n(${durationStr})`;
        }

        this.emitToolResultOnce(item.id, resultText, failed, parentToolUseId);
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const fileChangeTool = this.buildFileChangeTool(item.id, fc.changes);
        if (fileChangeTool) {
          this.ensureToolUseEmitted(item.id, fileChangeTool.toolName, fileChangeTool.input, { parentToolUseId });
        }
        if (!fileChangeTool && !this.emittedToolUseIds.has(item.id)) {
          this.patchChangesByCallId.delete(item.id);
          break;
        }
        const changes = fileChangeTool
          ? Array.isArray(fileChangeTool.input.changes)
            ? (fileChangeTool.input.changes as ToolFileChange[])
            : []
          : this.resolveFileChangesForTool(item.id, fc.changes);
        const summary = changes.map((c) => `${safeKind(c.kind)}: ${c.path}`).join("\n");
        this.emitToolResult(item.id, summary || "File changes applied", fc.status === "failed", parentToolUseId);
        this.patchChangesByCallId.delete(item.id);
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.ensureToolUseEmitted(item.id, this.displayNameForMcpTool(mcp), this.inputForMcpTool(mcp), {
          parentToolUseId,
        });
        this.emitToolResult(
          item.id,
          this.resultForMcpTool(mcp) || mcp.error || "MCP tool call completed",
          mcp.status === "failed",
          parentToolUseId,
        );
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        const wsQuery = extractWebSearchQuery(ws);
        this.ensureToolUseEmitted(item.id, "WebSearch", this.buildWebSearchToolInput(ws), { parentToolUseId });
        const wsResult = extractWebSearchResultText(ws);
        if (wsResult && wsResult !== wsQuery && wsResult !== "Web search completed") {
          this.emitToolResult(item.id, wsResult, false, parentToolUseId);
        }
        break;
      }

      case "imageView": {
        const imageView = item as CodexImageViewItem;
        const toolInput = { path: imageView.path || "" };
        this.ensureToolUseData(item.id, "view_image", toolInput, { parentToolUseId });
        this.emitToolResultOnce(item.id, this.buildImageViewResultText(toolInput.path), false, parentToolUseId);
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const completedAt = Date.now();
        const thinkingTimeMs =
          typeof this.lastMessageFinishedAt === "number"
            ? Math.max(0, completedAt - this.lastMessageFinishedAt)
            : undefined;
        const updates = this.reasoningDetails.complete({
          turnId: toSafeText(params.turnId),
          itemId: item.id,
          summary: r.summary,
          parentToolUseId,
          thinkingTimeMs,
        });
        this.emitReasoningDetailUpdates(updates);
        if (updates.length > 0) {
          this.markMessageFinished(completedAt);
        }
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;

        const pending = this.pendingSubagentToolUsesByCallId.get(item.id);
        const role = this.extractSubagentRole(collab);
        const description = this.extractSubagentLabel(collab) || role || "Subagent";
        const effectiveParentToolUseId = pending?.parentToolUseId ?? parentToolUseId;
        const input: Record<string, unknown> = {
          prompt: toSafeText(collab.prompt).trim() || pending?.prompt || "",
          description,
          subagent_type: role,
        };

        this.ensureToolUseEmitted(item.id, "Agent", input, {
          parentToolUseId: effectiveParentToolUseId,
          timestamp: pending?.startedAt,
        });

        if (Array.isArray(collab.receiverThreadIds)) {
          for (const threadId of collab.receiverThreadIds) {
            if (typeof threadId === "string" && threadId.trim()) {
              this.parentToolUseIdByThreadId.set(threadId, item.id);
            }
          }
        }

        if (collab.status === "failed" || collab.status === "declined") {
          const errorText = toSafeText(collab.error).trim() || "Subagent failed";
          this.emitToolResult(item.id, errorText, true, effectiveParentToolUseId);
        }
        break;
      }

      case "contextCompaction": {
        const attribution = this.compactionCauseByItemId.get(item.id) ?? { cause: "unknown" as const };
        this.compactionCauseByItemId.delete(item.id);
        this.emit({
          type: "status_change",
          status: null,
          codexCompactionCause: attribution.cause,
          ...(attribution.source ? { codexCompactionCauseSource: attribution.source } : {}),
        });
        break;
      }

      default:
        break;
    }
  }

  emitCommandProgress(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    const startTime = this.commandStartTimes.get(itemId);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    const deltaText = this.extractCommandOutputDelta(params);
    if (deltaText) {
      const prev = this.commandOutputByItemId.get(itemId) || "";
      this.commandOutputByItemId.set(itemId, prev + deltaText);
    }
    this.emit({
      type: "tool_progress",
      tool_use_id: itemId,
      tool_name: "Bash",
      elapsed_time_seconds: elapsed,
      ...(deltaText ? { output_delta: deltaText } : {}),
    });
  }

  emitToolUseTracked(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.emittedToolUseIds.add(toolUseId);
    this.emittedToolUseInputsById.set(toolUseId, input);
    this.emittedToolUseNamesById.set(toolUseId, toolName);
    if (this.isResultBearingToolUse(toolUseId, toolName)) {
      this.activeToolUseIds.add(toolUseId);
    }
    this.emitToolUse(toolUseId, toolName, input, options);
  }

  emitToolResult(toolUseId: string, content: unknown, isError: boolean, parentToolUseId?: string | null): void {
    this.activeToolUseIds.delete(toolUseId);
    const safeContent = typeof content === "string" ? content : JSON.stringify(content);
    const completedAt = Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_result", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: parentToolUseId ?? null,
      timestamp: completedAt,
    });
    this.markMessageFinished(completedAt);
  }

  handleToolRouterError(message: string, targetToolName?: RouterFailureToolName, duplicateScope?: string): boolean {
    if (targetToolName === "write_stdin") {
      if (this.handleWriteStdinRouterError(message)) return true;
      if (this.handleActiveToolRouterError(message, "write_stdin")) return true;
      return this.emitFailedWriteStdinRouterDiagnosticResult({
        message,
        duplicateKey: `diagnostic:${duplicateScope ?? "session"}\n${message}`,
        processId: this.extractWriteStdinFailureProcessId(message) ?? "",
        stdin: "",
      });
    }
    return this.handleActiveToolRouterError(message);
  }

  private handleActiveToolRouterError(message: string, targetToolName?: RouterFailureToolName): boolean {
    if (this.activeToolUseIds.size !== 1) return false;
    const activeToolUseId = Array.from(this.activeToolUseIds).at(-1);
    if (!activeToolUseId) return false;
    if (targetToolName && this.emittedToolUseNamesById.get(activeToolUseId) !== targetToolName) return false;
    const parentToolUseId = this.parentToolUseIdByItemId.get(activeToolUseId) ?? null;
    this.emitToolResultOnce(activeToolUseId, message, true, parentToolUseId);
    return true;
  }

  private handleWriteStdinRouterError(message: string): boolean {
    const processId = this.extractWriteStdinFailureProcessId(message);
    if (processId) {
      const interaction = this.terminalInteractionByProcessId.get(processId);
      if (!interaction) return false;
      if (!this.activeToolUseIds.has(interaction.commandToolUseId)) return false;
      return this.emitFailedWriteStdinRouterResult({
        message,
        duplicateKey: `${interaction.toolUseId}\n${message}`,
        commandToolUseId: interaction.commandToolUseId,
        processId: interaction.processId,
        stdin: interaction.stdin,
        parentToolUseId: interaction.parentToolUseId,
      });
    }

    if (!this.isWriteStdinClosedForSessionFailure(message)) return false;
    const interaction = this.getOnlyActiveTerminalInteraction();
    if (interaction) {
      return this.emitFailedWriteStdinRouterResult({
        message,
        duplicateKey: `${interaction.toolUseId}\n${message}`,
        commandToolUseId: interaction.commandToolUseId,
        processId: interaction.processId,
        stdin: interaction.stdin,
        parentToolUseId: interaction.parentToolUseId,
      });
    }

    const commandToolUseId = this.getOnlyActiveCommandToolUseId();
    if (!commandToolUseId) return false;
    return this.emitFailedWriteStdinRouterResult({
      message,
      duplicateKey: `${commandToolUseId}\n${message}`,
      commandToolUseId,
      processId: "",
      stdin: "",
      parentToolUseId: this.parentToolUseIdByItemId.get(commandToolUseId) ?? null,
    });
  }

  private emitFailedWriteStdinRouterResult(args: {
    message: string;
    duplicateKey: string;
    commandToolUseId: string;
    processId: string;
    stdin: string;
    parentToolUseId: string | null;
  }): boolean {
    const { message, duplicateKey, commandToolUseId, processId, stdin, parentToolUseId } = args;
    if (this.failedTerminalRouterErrorKeys.has(duplicateKey)) return true;
    this.failedTerminalRouterErrorKeys.add(duplicateKey);

    const failedToolUseId = `${commandToolUseId}:terminal-error:${++this.terminalInteractionToolUseSeq}`;
    this.emitToolUseTracked(
      failedToolUseId,
      "write_stdin",
      {
        session_id: processId,
        chars: stdin,
      },
      { parentToolUseId },
    );
    this.emitToolResult(failedToolUseId, message, true, parentToolUseId);
    return true;
  }

  private emitFailedWriteStdinRouterDiagnosticResult(args: {
    message: string;
    duplicateKey: string;
    processId: string;
    stdin: string;
  }): boolean {
    const { message, duplicateKey, processId, stdin } = args;
    if (this.failedTerminalRouterErrorKeys.has(duplicateKey)) return true;
    this.failedTerminalRouterErrorKeys.add(duplicateKey);

    const failedToolUseId = `codex-write-stdin-router-error:${++this.terminalInteractionToolUseSeq}`;
    this.emitToolUseTracked(failedToolUseId, "write_stdin", {
      session_id: processId,
      chars: stdin,
    });
    this.emitToolResult(failedToolUseId, message, true);
    return true;
  }

  private extractWriteStdinFailureProcessId(message: string): string | null {
    const match = message.match(/\bUnknown process id\s+([^\s,.]+)/i);
    return match?.[1]?.trim() || null;
  }

  private isWriteStdinClosedForSessionFailure(message: string): boolean {
    return /\bwrite_stdin\s+failed:\s+stdin is closed for this session\b/i.test(message);
  }

  private getOnlyActiveTerminalInteraction(): TerminalInteractionToolUse | null {
    const activeInteractions = Array.from(this.terminalInteractionByProcessId.values()).filter((interaction) =>
      this.activeToolUseIds.has(interaction.commandToolUseId),
    );
    return activeInteractions.length === 1 ? activeInteractions[0] : null;
  }

  private getOnlyActiveCommandToolUseId(): string | null {
    const activeCommandToolUseIds = Array.from(this.activeToolUseIds).filter(
      (toolUseId) => this.emittedToolUseNamesById.get(toolUseId) === "Bash",
    );
    if (activeCommandToolUseIds.length !== this.activeToolUseIds.size) return null;
    return activeCommandToolUseIds.length === 1 ? activeCommandToolUseIds[0] : null;
  }

  private clearTerminalInteractionsForCommand(commandToolUseId: string): void {
    for (const [processId, interaction] of this.terminalInteractionByProcessId) {
      if (interaction.commandToolUseId !== commandToolUseId) continue;
      this.terminalInteractionByProcessId.delete(processId);
      this.clearFailedTerminalRouterErrorKeysForInteraction(interaction);
    }
    this.clearFailedTerminalRouterErrorKeysForCommand(commandToolUseId);
  }

  private rememberTerminalInteraction(interaction: TerminalInteractionToolUse): void {
    const previous = this.terminalInteractionByProcessId.get(interaction.processId);
    if (previous) this.clearFailedTerminalRouterErrorKeysForInteraction(previous);
    this.terminalInteractionByProcessId.set(interaction.processId, interaction);
  }

  private clearFailedTerminalRouterErrorKeysForInteraction(interaction: TerminalInteractionToolUse): void {
    for (const key of this.failedTerminalRouterErrorKeys) {
      if (key.startsWith(`${interaction.toolUseId}\n`)) {
        this.failedTerminalRouterErrorKeys.delete(key);
      }
    }
  }

  private clearFailedTerminalRouterErrorKeysForCommand(commandToolUseId: string): void {
    for (const key of this.failedTerminalRouterErrorKeys) {
      if (key.startsWith(`${commandToolUseId}\n`)) {
        this.failedTerminalRouterErrorKeys.delete(key);
      }
    }
  }

  private isResultBearingToolUse(toolUseId: string, toolName: string): boolean {
    return !toolUseId.startsWith("codex-plan-") && toolName !== "TodoWrite" && toolName !== "TaskUpdate";
  }

  private resolveFileChangesForTool(toolUseId: string, rawChanges: unknown): ToolFileChange[] {
    const direct = mapUnknownFileChangesForTool(rawChanges);
    const cached = this.patchChangesByCallId.get(toolUseId) || [];
    if (cached.length === 0) return direct;
    if (direct.length === 0) return cached;
    if (!hasAnyPatchDiff(direct) && hasAnyPatchDiff(cached)) return cached;
    return direct;
  }

  private buildFileChangeTool(
    toolUseId: string,
    rawChanges: unknown,
  ): { toolName: "Edit" | "Write"; input: { file_path: string; changes: ToolFileChange[] } } | null {
    const changes = this.resolveFileChangesForTool(toolUseId, rawChanges);
    const firstChange = changes[0];
    if (!firstChange) return null;

    const toolName: "Edit" | "Write" = isWriteLikeFileChangeKind(firstChange.kind) ? "Write" : "Edit";
    const input = {
      file_path: firstChange.path || "",
      changes,
    };
    return this.hasRenderableFileChangeInput(input) ? { toolName, input } : null;
  }

  private hasRenderableFileChangeInput(input: { file_path: string; changes: ToolFileChange[] }): boolean {
    if (
      firstNonEmptyString(input as Record<string, unknown>, [
        "content",
        "text",
        "new_string",
        "newText",
        "new_content",
        "newContent",
      ])
    ) {
      return true;
    }

    return input.changes.some((change) => {
      if (typeof change.diff === "string" && change.diff.trim()) return true;
      return (
        firstNonEmptyString(change as Record<string, unknown>, [
          "content",
          "text",
          "new_string",
          "newText",
          "new_content",
          "newContent",
        ]) !== ""
      );
    });
  }

  private isTakodeDelegateTool(item: CodexMcpToolCallItem): boolean {
    return item.server === "takode_delegate" && (item.tool === "delegate_task" || item.tool === "delegate_command");
  }

  private extractMcpResultText(result: unknown): string | null {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return null;
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return null;
    const texts = content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const rec = block as Record<string, unknown>;
        return rec.type === "text" && typeof rec.text === "string" ? rec.text : "";
      })
      .filter(Boolean);
    return texts.length > 0 ? texts.join("\n") : null;
  }

  private resultForMcpTool(item: CodexMcpToolCallItem): unknown {
    if (this.isTakodeDelegateTool(item)) {
      return this.extractMcpResultText(item.result) ?? item.result;
    }
    return item.result;
  }

  private displayNameForMcpTool(item: CodexMcpToolCallItem): string {
    return this.isTakodeDelegateTool(item) ? "Agent" : "mcp:" + item.server + ":" + item.tool;
  }

  private inputForMcpTool(item: CodexMcpToolCallItem): Record<string, unknown> {
    const args = item.arguments || {};
    if (!this.isTakodeDelegateTool(item)) return args;
    if (item.tool === "delegate_command") {
      const command = typeof args.command === "string" ? args.command : "";
      return {
        ...args,
        description: "Delegated command",
        subagent_type: "delegate_command",
        command,
        prompt: command,
      };
    }
    const task = typeof args.task === "string" ? args.task : "";
    return {
      ...args,
      description: "Delegated task",
      subagent_type: "delegate_task",
      task,
      prompt: task,
    };
  }

  private getThreadIdFromRecord(record: Record<string, unknown> | undefined): string | null {
    if (!record) return null;
    const threadId = toSafeText(
      record.threadId ??
        record.senderThreadId ??
        record.conversationId ??
        record.conversation_id ??
        record.new_thread_id,
    ).trim();
    return threadId || null;
  }

  private getThreadIdFromParams(params: Record<string, unknown>): string | null {
    const direct = this.getThreadIdFromRecord(params);
    if (direct) return direct;

    for (const key of ["item", "turn", "msg"]) {
      const value = params[key];
      if (value && typeof value === "object") {
        const nested = this.getThreadIdFromRecord(value as Record<string, unknown>);
        if (nested) return nested;
      }
    }

    return null;
  }

  private getParentToolUseIdForThreadId(threadId: string | null | undefined): string | null {
    if (!threadId) return null;
    return this.parentToolUseIdByThreadId.get(threadId) ?? null;
  }

  private extractSubagentRole(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const role = toSafeText((agentState as Record<string, unknown>).role).trim();
        if (role) return role;
      }
    }
    return "";
  }

  private extractSubagentLabel(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const rec = agentState as Record<string, unknown>;
        const nickname = toSafeText(rec.nickname ?? rec.agentNickname ?? rec.name).trim();
        if (nickname) return nickname;
      }
    }
    return "";
  }

  private normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
    const status = toSafeText(value).toLowerCase();
    if (status.includes("done") || status.includes("complete") || status.includes("finished")) return "completed";
    if (
      status.includes("progress") ||
      status.includes("doing") ||
      status.includes("active") ||
      status.includes("running") ||
      status.includes("current")
    ) {
      return "in_progress";
    }
    return "pending";
  }

  private extractPlanTodos(
    params: Record<string, unknown>,
  ): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> {
    const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> = [];
    const seen = new Set<unknown>();

    const pushTodo = (value: unknown): void => {
      if (typeof value === "string") {
        const content = value.trim();
        if (content) todos.push({ content, status: "pending" });
        return;
      }
      if (!value || typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      const content = toSafeText(
        rec.content ?? rec.text ?? rec.title ?? rec.step ?? rec.name ?? rec.description ?? rec.task,
      ).trim();
      if (!content) return;
      const activeForm = toSafeText(rec.activeForm ?? rec.active_form ?? rec.inProgressForm).trim() || undefined;
      todos.push({ content, status: this.normalizePlanStatus(rec.status ?? rec.state), activeForm });
    };

    const walk = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushTodo(entry);
          walk(entry);
        }
        return;
      }
      if (typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      for (const key of ["todos", "steps", "items", "plan", "checklist", "tasks", "value", "delta"]) {
        if (key in rec) walk(rec[key]);
      }
    };

    walk(params);
    if (todos.length > 0) return todos;

    const rawDelta = toSafeText(params.delta ?? params.text ?? params.plan ?? "");
    if (!rawDelta) return todos;
    for (const line of rawDelta.split("\n")) {
      const match = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.+)$/);
      if (!match) continue;
      todos.push({
        content: match[2].trim(),
        status: match[1].toLowerCase() === "x" ? "completed" : "pending",
      });
    }
    return todos;
  }

  private emitToolUse(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    const now = options?.timestamp ?? Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_use", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
      timestamp: now,
      tool_start_times: { [toolUseId]: now },
    });
  }

  private emitToolUseStart(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
    });
    this.emitToolUseTracked(toolUseId, toolName, input, options);
  }

  private ensureToolUseEmitted(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
  ): void {
    this.ensureToolUseData(toolUseId, toolName, input, options);
  }

  private ensureToolUseData(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: ToolEmitOptions,
    completedOnly = false,
  ): void {
    if (!this.emittedToolUseIds.has(toolUseId)) {
      if (completedOnly) {
        this.emitToolUseTracked(toolUseId, toolName, input, options);
      } else {
        this.emitToolUseStart(toolUseId, toolName, input, options);
      }
      return;
    }

    const previousInput = this.emittedToolUseInputsById.get(toolUseId) || {};
    const mergedInput = this.mergeToolUseInput(previousInput, input);
    if (JSON.stringify(previousInput) === JSON.stringify(mergedInput)) return;

    this.emittedToolUseInputsById.set(toolUseId, mergedInput);
    this.emitToolUse(toolUseId, toolName, mergedInput, options);
  }

  private emitToolResultOnce(
    toolUseId: string,
    content: unknown,
    isError: boolean,
    parentToolUseId?: string | null,
  ): void {
    if (this.emittedToolResultIds.has(toolUseId)) return;
    this.emittedToolResultIds.add(toolUseId);
    this.emitToolResult(toolUseId, content, isError, parentToolUseId);
  }

  private handleRawExecItemCompleted(item: Record<string, unknown>, itemType: string): boolean {
    if (itemType === "custom_tool_call") {
      const toolName = toSafeText(item.name).trim();
      if (toolName !== "exec") return false;

      const callId = toSafeText(item.call_id ?? item.callId).trim();
      const command = extractRawExecCommand(item.input ?? item.arguments);
      if (!callId || !command) return true;

      this.rawExecCommandByCallId.set(callId, command);
      pruneOldestMapEntries(this.rawExecCommandByCallId, RAW_EXEC_CALL_CACHE_LIMIT);
      const existingOutput = this.rawExecOutputByCallId.get(callId);
      if (existingOutput) {
        this.queueRawExecOutput(command, existingOutput);
        this.rawExecOutputByCallId.delete(callId);
      }
      return true;
    }

    if (itemType !== "custom_tool_call_output" && itemType !== "function_call_output") return false;

    const callId = toSafeText(item.call_id ?? item.callId).trim();
    const output = stripCodexScriptCompletedPreamble(
      extractRawToolOutputText(item.output ?? item.content ?? item.result),
    );
    if (!callId || !output.trim()) return true;

    const command = this.rawExecCommandByCallId.get(callId);
    if (command) {
      this.queueRawExecOutput(command, output);
      this.rawExecOutputByCallId.delete(callId);
    } else {
      this.rawExecOutputByCallId.set(callId, output);
      pruneOldestMapEntries(this.rawExecOutputByCallId, RAW_EXEC_CALL_CACHE_LIMIT);
    }
    return true;
  }

  private queueRawExecOutput(command: string, output: string): void {
    const normalizedCommand = normalizeRawExecCommand(command);
    if (!normalizedCommand || !output.trim()) return;

    const existing = this.rawExecOutputsByCommand.get(normalizedCommand) ?? [];
    existing.push(output.trimEnd());
    this.rawExecOutputsByCommand.set(normalizedCommand, existing.slice(-RAW_EXEC_OUTPUTS_PER_COMMAND_LIMIT));
    pruneOldestMapEntries(this.rawExecOutputsByCommand, RAW_EXEC_OUTPUT_COMMAND_CACHE_LIMIT);
  }

  private takeFullerRawExecOutput(command: string, currentOutput: string): string | null {
    const normalizedCommand = normalizeRawExecCommand(command);
    const candidates = this.rawExecOutputsByCommand.get(normalizedCommand);
    if (!candidates || candidates.length === 0) return null;

    const current = currentOutput.trim();
    const index = candidates.findIndex((candidate) => shouldPreferRawExecOutput(candidate, current));
    if (index < 0) return null;

    const [fuller] = candidates.splice(index, 1);
    if (candidates.length === 0) {
      this.rawExecOutputsByCommand.delete(normalizedCommand);
    } else {
      this.rawExecOutputsByCommand.set(normalizedCommand, candidates);
    }
    return fuller ?? null;
  }

  private mergeToolUseInput(
    previous: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(incoming)) {
      if (value == null) continue;
      if (typeof value === "string") {
        if (value.trim().length > 0 || !(key in merged)) merged[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length > 0 || !(key in merged)) merged[key] = value;
        continue;
      }
      if (typeof value === "object") {
        const previousValue = merged[key];
        if (previousValue && typeof previousValue === "object" && !Array.isArray(previousValue)) {
          merged[key] = this.mergeToolUseInput(
            previousValue as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else if (!(key in merged) || Object.keys(value as Record<string, unknown>).length > 0) {
          merged[key] = value;
        }
        continue;
      }
      merged[key] = value;
    }
    return merged;
  }

  private buildImageViewResultText(path: unknown): string {
    return typeof path === "string" && path.trim().length > 0 ? path : "Image viewed successfully.";
  }

  private handleRawWebSearchCompleted(params: Record<string, unknown>, item: Record<string, unknown>): void {
    const webSearch = this.normalizeRawWebSearchItem(item);
    if (!webSearch) return;

    const parentToolUseId = this.resolveParentToolUseId(params, webSearch.id);
    const webSearchQuery = extractWebSearchQuery(webSearch);
    this.ensureToolUseData(
      webSearch.id,
      "WebSearch",
      this.buildWebSearchToolInput(webSearch),
      { parentToolUseId },
      true,
    );
    const webSearchResult = extractWebSearchResultText(webSearch);
    if (webSearchResult && webSearchResult !== webSearchQuery && webSearchResult !== "Web search completed") {
      this.emitToolResultOnce(webSearch.id, webSearchResult, false, parentToolUseId);
    }
  }

  private normalizeRawWebSearchItem(item: Record<string, unknown>): CodexWebSearchItem | null {
    const id = toSafeText(item.id ?? item.call_id ?? item.callId).trim() || `raw-web-search-${randomUUID()}`;
    const normalized = { ...item, id, type: "webSearch" } as CodexWebSearchItem;
    const action = this.normalizeRawWebSearchAction(item.action);
    if (action) normalized.action = action;
    return normalized;
  }

  private normalizeRawWebSearchAction(action: unknown): CodexWebSearchItem["action"] | undefined {
    if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
    const actionRecord = action as Record<string, unknown>;
    const normalized: NonNullable<CodexWebSearchItem["action"]> = {};

    for (const key of ["type", "url", "pattern", "query", "q"] as const) {
      const value = actionRecord[key];
      if (typeof value === "string" && value.trim()) normalized[key] = value.trim();
    }

    const queries = actionRecord.queries;
    if (Array.isArray(queries)) {
      const queryList = queries.filter(
        (query): query is string => typeof query === "string" && query.trim().length > 0,
      );
      if (queryList.length > 0) normalized.queries = queryList.map((query) => query.trim());
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private buildWebSearchToolInput(item: CodexWebSearchItem): Record<string, unknown> {
    const input: Record<string, unknown> = { query: extractWebSearchQuery(item) };
    if (item.action && Object.keys(item.action).length > 0) {
      input.action = item.action;
    }
    return input;
  }

  private makeMessageId(kind: string, sourceId?: string): string {
    if (sourceId) return `codex-${kind}-${sourceId}`;
    return `codex-${kind}-${randomUUID()}`;
  }

  private emitReasoningDetailUpdates(updates: CodexReasoningDetailPartUpdate[]): void {
    for (const update of updates) {
      this.emit({
        type: "codex_reasoning_detail",
        id: this.makeMessageId("reasoning", update.sourceId),
        text: update.text,
        status: update.status,
        timestamp: Date.now(),
        parent_tool_use_id: update.parentToolUseId,
        reasoning_turn_id: update.turnId,
        reasoning_item_ordinal: update.itemOrdinal,
        provider_item_id: update.providerItemId,
        summary_index: update.summaryIndex,
        ...(update.thinkingTimeMs !== undefined ? { thinking_time_ms: update.thinkingTimeMs } : {}),
      });
    }
  }

  private extractCommandOutputDelta(params: Record<string, unknown>): string {
    const collected: string[] = [];
    const seen = new Set<unknown>();

    const visit = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (typeof value === "string") {
        collected.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const key of ["delta", "text", "output", "stdout", "stderr", "content", "message"]) {
          if (key in obj) visit(obj[key]);
        }
      }
    };

    for (const key of ["delta", "output", "stdout", "stderr", "content"]) {
      visit(params[key]);
    }

    return collected.join("");
  }
}

function extractRawExecCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const cmd = obj.cmd ?? obj.command;
    if (typeof cmd === "string") return normalizeRawExecCommand(cmd);
  }

  if (typeof input !== "string") return "";
  const match = input.match(/\bcmd\s*:\s*("(?:(?:\\.)|[^"\\])*")/s);
  if (!match?.[1]) return "";

  try {
    return normalizeRawExecCommand(JSON.parse(match[1]));
  } catch {
    return "";
  }
}

function normalizeRawExecCommand(command: string): string {
  return command
    .trim()
    .replace(/^#\s*thread:(?:main|q-\d+)\s*\n\s*/i, "")
    .trim();
}

function extractRawToolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const obj = part as Record<string, unknown>;
        return toSafeText(obj.text ?? obj.content ?? obj.output);
      })
      .join("");
  }
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    return toSafeText(obj.text ?? obj.content ?? obj.output);
  }
  return "";
}

function stripCodexScriptCompletedPreamble(output: string): string {
  return output.replace(/^Script completed\nWall time [^\n]*\nOutput:\n?/i, "");
}

function shouldPreferRawExecOutput(candidate: string, currentOutput: string): boolean {
  const full = candidate.trim();
  if (!full || full.length <= currentOutput.length) return false;
  if (!currentOutput) return true;
  return full.includes(currentOutput);
}

function pruneOldestMapEntries<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
