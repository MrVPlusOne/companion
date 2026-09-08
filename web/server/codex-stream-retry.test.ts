import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import { CodexStreamRetryObserver } from "./codex-stream-retry.js";

const active = { threadId: "root-thread", turnId: "root-turn" };
const reportedRetry = { ...active, willRetry: true, error: { message: "Sensitive provider details" } };

function fixture() {
  const messages: BrowserIncomingMessage[] = [];
  const observer = new CodexStreamRetryObserver((message) => messages.push(message));
  return {
    observer,
    messages,
    notify: (method: string, params: Record<string, unknown>) =>
      observer.observe(method, params, active.threadId, active.turnId),
  };
}

describe("Codex internal stream retry observation", () => {
  it("reports only the exact retrying root turn without inventing a counter", () => {
    const { messages, notify } = fixture();
    // Modern ErrorNotification has no structured attempt count. Legacy Event.id
    // identifies the submission, while msg is the tagged StreamError payload.
    notify("error", reportedRetry);
    notify("error", reportedRetry);
    notify("codex/event/stream_error", {
      id: active.turnId,
      conversationId: active.threadId,
      msg: { type: "stream_error", message: "Reconnecting... 2/5" },
    });
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toEqual({ type: "session_update", session: { codex_stream_retry: { turnId: active.turnId } } });
    }
    expect(JSON.stringify(messages)).not.toMatch(/Sensitive|Reconnecting|attempt/);
  });

  it.each([
    { ...reportedRetry, willRetry: false },
    { ...reportedRetry, willRetry: "true" },
    { ...reportedRetry, willRetry: undefined },
    { ...reportedRetry, threadId: "child-thread" },
    { ...reportedRetry, threadId: undefined },
    { ...reportedRetry, turnId: "stale-turn" },
    { ...reportedRetry, turnId: undefined },
  ])("does not infer retry from malformed, terminal, missing, or foreign ownership", (params) => {
    const { messages, notify } = fixture();
    notify("error", params);
    expect(messages).toEqual([]);
  });

  it("keeps retry visible across metadata, user receipt, old tool output, and foreign activity", () => {
    const { messages, notify } = fixture();
    notify("error", reportedRetry);
    for (const [method, params] of [
      ["thread/tokenUsage/updated", active],
      ["thread/status/changed", { threadId: active.threadId, status: { type: "active" } }],
      ["item/started", { ...active, item: { type: "userMessage" } }],
      ["item/started", { ...active, item: { type: "subAgentActivity" } }],
      ["item/completed", { ...active, item: { type: "commandExecution" } }],
      ["item/commandExecution/outputDelta", { ...active, delta: "tool output" }],
      ["item/agentMessage/delta", { ...active, delta: "" }],
      ["item/agentMessage/delta", { ...active, threadId: "child-thread", delta: "child" }],
      ["item/agentMessage/delta", { ...active, turnId: "old-turn", delta: "stale" }],
      ["error", { ...reportedRetry, turnId: "old-turn", willRetry: false }],
      ["turn/completed", { threadId: active.threadId, turn: { id: "old-turn", status: "failed" } }],
    ] as const) {
      notify(method, params);
    }
    expect(messages).toHaveLength(1);
  });

  it.each([
    ["item/agentMessage/delta", { ...active, delta: "response resumed" }],
    ["item/reasoning/summaryTextDelta", { ...active, delta: "official summary" }],
    ["item/reasoning/textDelta", { ...active, delta: "unrendered reasoning" }],
    ["item/started", { ...active, item: { type: "commandExecution" } }],
    ["error", { ...reportedRetry, willRetry: false }],
    ["turn/completed", { threadId: active.threadId, turn: { id: active.turnId, status: "completed" } }],
    ["turn/completed", { threadId: active.threadId, turn: { id: active.turnId, status: "interrupted" } }],
    ["thread/status/changed", { threadId: active.threadId, status: { type: "idle" } }],
  ] as const)("clears on matching resumed or terminal signal %s", (method, params) => {
    const { messages, notify } = fixture();
    notify("error", reportedRetry);
    notify(method, params);
    expect(messages.at(-1)).toEqual({ type: "session_update", session: { codex_stream_retry: null } });
    expect(messages).toHaveLength(2);
  });

  it("clears idempotently at adapter disposal and allows a later confirmed retry", () => {
    const { observer, messages, notify } = fixture();
    notify("error", reportedRetry);
    observer.clear();
    observer.clear();
    notify("error", reportedRetry);
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)).toEqual({
      type: "session_update",
      session: { codex_stream_retry: { turnId: active.turnId } },
    });
  });
});
