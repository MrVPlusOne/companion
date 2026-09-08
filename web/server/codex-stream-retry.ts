import type { BrowserIncomingMessage, SessionState } from "./session-types.js";
import { getCodexThreadIdFromParams } from "./codex-native-subagent-adapter-controller.js";

const MODEL_ITEM_TYPES = new Set([
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageGeneration",
]);

/** Tracks reported internal retries without changing Codex or Takode recovery policy. */
export class CodexStreamRetryObserver {
  private turnId: string | null = null;

  constructor(private readonly emit: (message: BrowserIncomingMessage) => void) {}

  observe(
    method: string,
    params: Record<string, unknown>,
    rootThreadId: string | null,
    currentTurnId: string | null,
  ): void {
    if (method === "codex/event/stream_error") {
      const message = record(params.msg)?.message;
      if (message) console.log(`[codex-adapter] Stream error: ${message}`);
    }
    if (!rootThreadId || getCodexThreadIdFromParams(params) !== rootThreadId) return;
    if (this.turnId && this.turnId !== currentTurnId) this.clear();
    const turn = record(params.turn);
    const turnId = params.turnId ?? turn?.id ?? (method === "codex/event/stream_error" ? params.id : null);
    if (method === "thread/status/changed" && record(params.status)?.type === "idle") {
      this.clear();
      return;
    }
    if (typeof turnId !== "string" || !currentTurnId || turnId !== currentTurnId) return;

    // The modern producer maps StreamError to willRetry:true. Legacy StreamError
    // has the same meaning; neither shape supplies a structured attempt count.
    if ((method === "error" && params.willRetry === true) || method === "codex/event/stream_error") {
      this.turnId = turnId;
      this.publish({ turnId });
      return;
    }
    if (!this.turnId) return;
    if (
      method === "turn/completed" ||
      (method === "error" && params.willRetry === false) ||
      isResumedModelActivity(method, params)
    ) {
      this.clear();
    }
  }

  clear(): void {
    if (!this.turnId) return;
    this.turnId = null;
    this.publish(null);
  }

  private publish(state: SessionState["codex_stream_retry"]): void {
    this.emit({ type: "session_update", session: { codex_stream_retry: state } });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isResumedModelActivity(method: string, params: Record<string, unknown>): boolean {
  if (
    method === "item/agentMessage/delta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/textDelta"
  ) {
    return typeof params.delta === "string" && params.delta.length > 0;
  }
  // Existing tool output/completions can race with model retry. Only a new
  // model-produced item establishes resumed activity; user receipts do not.
  return method === "item/started" && MODEL_ITEM_TYPES.has(String(record(params.item)?.type));
}
