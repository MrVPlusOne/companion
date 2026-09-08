import { describe, expect, it } from "vitest";
import { CodexItemEventManager } from "../codex-item-event-manager.js";
import type { BrowserIncomingMessage, BufferedBrowserEvent } from "../session-types.js";
import { prepareBoundedConversationSubscribe } from "./browser-conversation-window-policy.js";
import { isHistoryBackedEvent, shouldBufferForReplay } from "./replay-buffer-policy.js";

type Scope = { parent?: string; child?: BrowserIncomingMessage["codexSubagent"] };

function codexStream(text: string, id: string, completedId?: string, scope: Scope = {}): BrowserIncomingMessage[] {
  const messages: BrowserIncomingMessage[] = [];
  const manager = new CodexItemEventManager(
    (message) =>
      messages.push({
        ...message,
        ...(message.type === "assistant" || message.type === "stream_event"
          ? { parent_tool_use_id: scope.parent ?? null }
          : {}),
        ...(scope.child ? { codexSubagent: scope.child } : {}),
      }),
    { model: "test-model" },
  );
  manager.handleItemStarted({ item: { type: "agentMessage", id } });
  manager.handleAgentMessageDelta({ itemId: id, delta: text });
  if (completedId) manager.handleItemCompleted({ item: { type: "agentMessage", id: completedId, text } });
  manager.dispose();
  return messages;
}

function result(child?: BrowserIncomingMessage["codexSubagent"]): BrowserIncomingMessage {
  return {
    type: "result",
    data: { type: "result", subtype: "success", is_error: false },
    ...(child ? { codexSubagent: child } : {}),
  } as BrowserIncomingMessage;
}

function prepare(messages: BrowserIncomingMessage[], lastAckSeq = 0, nextEventSeq?: number, threadKey?: string) {
  const eventBuffer: BufferedBrowserEvent[] = messages
    .filter(shouldBufferForReplay)
    .map((message, index) => ({ seq: index + 1, message }));
  const messageHistory = eventBuffer.map((event) => event.message).filter(isHistoryBackedEvent);
  const before = structuredClone({ eventBuffer, messageHistory });
  const prepared = prepareBoundedConversationSubscribe({
    session: { messageHistory, eventBuffer, nextEventSeq: nextEventSeq ?? eventBuffer.length + 1 },
    socketData: {},
    initialThreadWindow: threadKey
      ? { thread_key: threadKey, from_item: -1, item_count: 30, section_item_count: 10, visible_item_count: 3 }
      : null,
    historyWindowSectionTurnCount: 10,
    historyWindowVisibleSectionCount: 3,
    historyWindowTargetMessageId: undefined,
    historyWindowTargetIndex: undefined,
    lastAckSeq,
    running: true,
    isHistoryBackedEvent,
  });
  expect({ eventBuffer, messageHistory }).toEqual(before);
  return { ...prepared, messageHistory };
}

function textDeltas(events: BufferedBrowserEvent[]): string[] {
  return events.flatMap(({ message }) => {
    if (message.type !== "stream_event") return [];
    const event = message.event as { type?: string; delta?: { type?: string; text?: string } };
    return event.type === "content_block_delta" && event.delta?.type === "text_delta" ? [event.delta.text ?? ""] : [];
  });
}

describe("bounded subscribe stream completion", () => {
  it.each([0, 1])("replays only the unfinished text after a snapshot (last acknowledged sequence %s)", (lastAckSeq) => {
    // Use the actual Codex producer, including changed completion IDs. The
    // completed rows belong to the snapshot and must not return as live text.
    const prepared = prepare(
      [
        { type: "status_change", status: "running" },
        ...codexStream("The message is pending.", "pending-stream", "pending-completed"),
        ...codexStream("Delivery is confirmed.", "delivery-stream", "delivery-completed"),
        ...codexStream("Checking current work.", "active-stream"),
      ],
      lastAckSeq,
    );
    expect(textDeltas(prepared.replayEvents)).toEqual(["Checking current work."]);
    expect(prepared.messageHistory.filter((message) => message.type === "assistant")).toHaveLength(2);
    expect(prepared.replayEvents.some(({ message }) => message.type === "status_change")).toBe(lastAckSeq === 0);
  });

  it("retires completed text even when the buffer no longer contains its start", () => {
    // A bounded buffer may lose the start; completion ordering still proves
    // that the earlier deltas are represented by completed history.
    const messages = codexStream("Completed text", "stream-id", "completion-id").filter(
      (message) => message.type !== "stream_event" || (message.event as { type: string }).type !== "message_start",
    );
    expect(textDeltas(prepare(messages).replayEvents)).toEqual([]);
    expect(prepare(messages.filter((message) => message.type === "assistant")).replayEvents).toEqual([]);
  });

  it("preserves a genuinely new stream with the same text as completed history", () => {
    // Prose equality is not stream ownership; this second message is active.
    const prepared = prepare([
      ...codexStream("Still waiting.", "old-stream", "old-completion"),
      ...codexStream("Still waiting.", "new-stream"),
    ]);
    expect(textDeltas(prepared.replayEvents)).toEqual(["Still waiting."]);
    expect(prepared.messageHistory).toHaveLength(1);
  });

  it("retires a streamed replay when only its independent stop survives history deduplication", () => {
    // The bridge may suppress the assistant row while still forwarding its
    // lifecycle stop. Later current output must remain available on reconnect.
    const replay = codexStream("Previously completed.", "replay-stream", "replay-completed").filter(
      (message) => message.type !== "assistant",
    );
    expect(textDeltas(prepare([...replay, ...codexStream("Current output.", "current")]).replayEvents)).toEqual([
      "Current output.",
    ]);
  });

  it("keeps completion local to the exact parent and native child ownership", () => {
    // Simultaneous roots, legacy children, and native children must not retire
    // each other's streams, even when provider-facing item IDs are the same.
    const child = { childId: "child", parentChildId: "parent", rootTurnId: "turn-a" };
    const otherTurn = { ...child, rootTurnId: "turn-b" };
    const legacyCompleted = codexStream("old legacy", "item", "done", { parent: "legacy-a" });
    const nativeCompleted = codexStream("old native", "item", "done", { child });
    const prepared = prepare([
      ...codexStream("active root", "item"),
      ...codexStream("active legacy", "item", undefined, { parent: "legacy-b" }),
      ...codexStream("active native", "item", undefined, { child: otherTurn }),
      ...legacyCompleted,
      ...nativeCompleted,
    ]);
    expect(textDeltas(prepared.replayEvents)).toEqual(["active root", "active legacy", "active native"]);
  });

  it("lets a root result retire root and legacy streams while preserving native children", () => {
    // The browser's root result clears both root and parent-keyed live maps;
    // native child results must never clear those root-owned maps.
    const child = { childId: "child", rootTurnId: "turn-a" };
    const prepared = prepare([
      ...codexStream("old root", "root"),
      ...codexStream("old legacy", "legacy", undefined, { parent: "legacy" }),
      ...codexStream("active native", "native", undefined, { child }),
      result(),
    ]);
    expect(textDeltas(prepared.replayEvents)).toEqual(["active native"]);
    const childResult = prepare([
      ...codexStream("active root", "root"),
      ...codexStream("old native", "native", undefined, { child }),
      ...codexStream("active sibling", "sibling", undefined, { child: { childId: "sibling" } }),
      result(child),
    ]);
    expect(textDeltas(childResult.replayEvents)).toEqual(["active root", "active sibling"]);
  });

  it("does not let a completion beyond the snapshot retire the captured active stream", () => {
    // Freeze the snapshot immediately before completion. Future buffer rows
    // cannot claim ownership of content the snapshot still considers active.
    const messages = codexStream("Still active at snapshot", "stream", "completed");
    const completionIndex = messages.findIndex((message) => message.type === "assistant");
    expect(textDeltas(prepare(messages, 0, completionIndex + 1).replayEvents)).toEqual(["Still active at snapshot"]);
  });

  it.each([
    undefined,
    {},
    { content: [null] },
  ])("ignores malformed restored assistant completions before acknowledgment and outside the selected view (%j)", (message) => {
    // Persisted replay validation is intentionally shallow. Unknown rows
    // cannot crash selection or become proof that an unrelated stream ended.
    const malformed = {
      type: "assistant",
      parent_tool_use_id: null,
      threadKey: "q-2",
      message,
    } as unknown as BrowserIncomingMessage;
    const current = codexStream("Unfinished text.", "active").map((event) => ({ ...event, threadKey: "q-1" }));
    const prepared = prepare([malformed, ...current, malformed], 1, undefined, "q-1");
    expect(textDeltas(prepared.replayEvents)).toEqual(["Unfinished text."]);
  });

  it("retires thinking only when its own thinking completion or result is present", () => {
    // Text completion does not clear the browser's independent thinking map.
    const thinking = (text: string): BrowserIncomingMessage => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } },
    });
    const textCompletion = codexStream("Visible answer", "text", "text-complete").find(
      (message) => message.type === "assistant",
    )!;
    const thinkingCompletion: BrowserIncomingMessage = {
      ...textCompletion,
      message: { ...textCompletion.message, content: [{ type: "thinking", thinking: "Finished thought" }] },
    };
    const pending = thinking("Pending thought");
    const thinkingStart: BrowserIncomingMessage = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "Initial thought" },
      },
    };
    expect(prepare([pending, textCompletion]).replayEvents.map((event) => event.message)).toEqual([pending]);
    expect(prepare([thinkingStart, pending, thinkingCompletion]).replayEvents).toEqual([]);
    expect(prepare([pending, result()]).replayEvents).toEqual([]);
  });
});
