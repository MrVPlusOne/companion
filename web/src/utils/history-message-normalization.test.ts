import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../types.js";
import { codexTurnRecoverySourceId } from "../../shared/injected-event-message.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

describe("normalizeHistoryMessageToChatMessages", () => {
  it("normalizes routed quest lifecycle history with stable identity and details", () => {
    // The same raw event feeds live delivery and selected-window hydration, so
    // its durable ID, history index, lifecycle kind, and owner route must survive.
    const message = normalizeHistoryMessageToChatMessages(
      {
        type: "quest_lifecycle_event",
        id: "quest-lifecycle-leader-42",
        timestamp: 4200,
        kind: "submitted",
        quest: {
          questId: "q-2003",
          title: "Diagnose recurring alerts",
          status: "done",
          tldr: "Findings are ready for review.",
          tags: ["security", "investigation"],
          leaderSessionId: "leader-1",
        },
        threadKey: "q-2003",
        questId: "q-2003",
        threadRefs: [{ threadKey: "q-2003", questId: "q-2003", source: "explicit" }],
      },
      17,
    )[0]!;

    expect(message).toEqual({
      id: "quest-lifecycle-leader-42",
      role: "system",
      content: "Quest submitted: Diagnose recurring alerts",
      timestamp: 4200,
      historyIndex: 17,
      variant: "quest_submitted",
      metadata: {
        threadKey: "q-2003",
        questId: "q-2003",
        threadRefs: [{ threadKey: "q-2003", questId: "q-2003", source: "explicit" }],
        quest: {
          questId: "q-2003",
          title: "Diagnose recurring alerts",
          status: "done",
          tldr: "Findings are ready for review.",
          tags: ["security", "investigation"],
          leaderSessionId: "leader-1",
        },
      },
    });
  });

  it("stores the raw messageHistory index on visible user and assistant messages", () => {
    // Message links use this raw index so `#/session/123/msg/N` matches
    // Takode CLI reads even when non-rendered history entries exist.
    const user = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "u1",
        content: "Prompt",
        timestamp: 100,
        leaderResponseCoverageVersion: 1,
      },
      3,
    )[0]!;
    const assistant = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "Answer" }],
        },
      },
      5,
    )[0]!;

    expect(user.historyIndex).toBe(3);
    expect(user.metadata?.leaderResponseCoverageVersion).toBe(1);
    expect(assistant.historyIndex).toBe(5);
  });

  it("preserves official Codex assistant phases without inferring missing metadata", () => {
    const base = {
      type: "assistant" as const,
      timestamp: 200,
      parent_tool_use_id: null,
      message: {
        id: "codex-agent-phase",
        type: "message" as const,
        role: "assistant" as const,
        model: "gpt-5.6-sol",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: "text" as const, text: "Answer" }],
      },
    };

    const [finalAnswer] = normalizeHistoryMessageToChatMessages({ ...base, codexMessagePhase: "final_answer" }, 5);
    const [unknown] = normalizeHistoryMessageToChatMessages(
      { ...base, message: { ...base.message, id: "unknown" } },
      6,
    );

    expect(finalAnswer.metadata?.codexMessagePhase).toBe("final_answer");
    expect(unknown.metadata?.codexMessagePhase).toBeUndefined();
  });

  it("preserves legacy routed-response authority on ordinary assistant rows", () => {
    const [message] = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        leaderThreadRole: "response",
        threadKey: "q-2024",
        questId: "q-2024",
        threadRefs: [{ threadKey: "q-2024", questId: "q-2024", source: "explicit" }],
        threadResponse: {
          logicalResponseId: "response-1",
          revisionId: "response-1-r1",
          revisionNumber: 1,
          batchId: "batch-1",
          batchObservedHistoryLength: 8,
          coveredUserMessageIds: ["user-1"],
          contentHash: "hash-1",
        },
        message: {
          id: "assistant-response-1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "Final response" }],
        },
      },
      7,
    );

    expect(message.metadata).toMatchObject({
      leaderThreadRole: "response",
      threadResponse: { revisionId: "response-1-r1", coveredUserMessageIds: ["user-1"] },
    });
  });

  it("preserves explicit routed-answer proof and concise user-message identity", () => {
    const [answer] = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 210,
        parent_tool_use_id: null,
        leaderThreadRole: "answer",
        threadKey: "q-2024",
        questId: "q-2024",
        threadRefs: [{ threadKey: "q-2024", questId: "q-2024", source: "explicit" }],
        threadAnswer: { version: 2, answerUserMessageIds: ["u7"], observedHistoryLength: 9 },
        message: {
          id: "assistant-answer-1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "Explicit answer" }],
        },
      },
      8,
    );
    const [user] = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "raw-user-7",
        content: "Question seven",
        timestamp: 200,
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u7",
      },
      7,
    );

    expect(answer.metadata).toMatchObject({
      leaderThreadRole: "answer",
      threadAnswer: { version: 2, answerUserMessageIds: ["u7"], observedHistoryLength: 9 },
    });
    expect(user.metadata).toMatchObject({ leaderResponseCoverageVersion: 1, leaderUserMessageId: "u7" });
  });

  it.each([
    "timer-m7",
    "timer-m17",
  ])("retains exact timer identity %s through authoritative history normalization", (id) => {
    // Selected windows and full history use the same row normalization. A
    // firing keeps its timer source without becoming a human obligation or
    // rewriting the exact reference retained by a historical row.
    const [timer] = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "timer-firing",
        timestamp: 200,
        content: "[⏰ Timer t2 reminder] Build report",
        agentSource: { sessionId: "timer:t2", sessionLabel: "Timer t2" },
        leaderTimerMessageId: id,
        threadKey: "main",
      },
      7,
    );
    expect(timer.metadata).toMatchObject({ leaderTimerMessageId: id, threadKey: "main" });
    expect(timer.agentSource?.sessionId).toBe("timer:t2");
    expect(timer.metadata?.leaderResponseCoverageVersion).toBeUndefined();
    expect(timer.metadata?.leaderUserMessageId).toBeUndefined();
  });

  it("preserves exact recovery model content while discarding ordinary delivery content", () => {
    // Authoritative history and selected-thread windows share this normalizer.
    // Only the server-produced recovery event retains the separately recorded payload.
    const exactRecoveryContent = [
      "[Source: Resuming Interrupted Work]",
      "[Thread: q-9010]",
      "",
      "Treat Takode history as observed evidence, not omniscient proof.",
    ].join("\n");
    const [recovery] = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "recovery-history",
        content: "Takode queued one recovery follow-up.",
        modelDeliveryContent: exactRecoveryContent,
        timestamp: 100,
        agentSource: { sessionId: codexTurnRecoverySourceId("owner-history") },
      },
      3,
    );
    const [ordinary] = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "ordinary-history",
        content: "Ordinary user message",
        modelDeliveryContent: "PRIVATE ORDINARY DELIVERY CONTENT",
        timestamp: 101,
      },
      4,
    );

    expect(recovery.modelDeliveryContent).toBe(exactRecoveryContent);
    expect(ordinary.modelDeliveryContent).toBeUndefined();
  });

  it("preserves explicit reply metadata on user messages", () => {
    const user = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "u-reply",
        content: "Continue the work",
        replyContext: { previewText: "Original answer", messageId: "msg-1" },
        timestamp: 100,
      },
      3,
    )[0]!;

    expect(user.content).toBe("Continue the work");
    expect(user.metadata?.replyContext).toEqual({ previewText: "Original answer", messageId: "msg-1" });
  });

  it("can expose successful result messages for preview-only callers", () => {
    // Preview callers opt into this path so hover cards can show successful
    // `result` text while the main session feed still omits non-error results.
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const message: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Linked result body",
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: null,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "result-1",
        session_id: "session-1",
      },
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 9, {
      includeSuccessfulResult: true,
      fallbackTimestamp: 999,
    });

    expect(normalized).toEqual([
      {
        id: "hist-result-9",
        role: "assistant",
        content: "Linked result body",
        timestamp: 999,
        historyIndex: 9,
      },
    ]);
    now.mockRestore();
  });

  it("uses the caller-provided replay timestamp for historical error result banners", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const message: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "stream disconnected before completion",
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: null,
        uuid: "result-error",
        session_id: "session-1",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 42, {
      fallbackTimestamp: 999,
    });

    expect(normalized).toEqual([
      {
        id: "hist-error-42",
        role: "system",
        content: "Error: stream disconnected before completion",
        timestamp: 999,
        historyIndex: 42,
        variant: "error",
      },
    ]);
    now.mockRestore();
  });

  it("hides persisted transient provider results while a safe same-turn retry owns them", () => {
    const message: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "stream disconnected before completion",
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "failed",
        uuid: "provider-retry-result",
        session_id: "session-1",
        usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        codex_provider_retry: {
          family: "model_backend_stream_error",
          ownerId: "input-1",
          attempt: 1,
          maxAttempts: 2,
          startedAt: 100,
        },
      },
    };

    expect(normalizeHistoryMessageToChatMessages(message, 43)).toEqual([]);
  });

  it("suppresses legacy Claude user-control diagnostics even without a persisted interrupted flag", () => {
    // Older live servers stored the diagnostic in errors[] before adding the
    // top-level interrupted marker. Replaying that history must not recreate it.
    const message: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 0,
        total_cost_usd: 0,
        stop_reason: "tool_use",
        uuid: "legacy-interrupt",
        session_id: "session-1",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };

    expect(normalizeHistoryMessageToChatMessages(message, 43)).toEqual([]);
  });

  it("preserves approved variant metadata for permission_approved messages", () => {
    const message: BrowserIncomingMessage = {
      type: "permission_approved",
      id: "perm-1",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      summary: "Approved Bash",
      timestamp: 1000,
      request_id: "req-1",
      answers: [{ question: "Proceed?", answer: "Yes" }],
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 7);

    expect(normalized).toEqual([
      {
        id: "perm-1",
        role: "system",
        content: "Approved Bash",
        timestamp: 1000,
        historyIndex: 7,
        variant: "approved",
        metadata: {
          answers: [{ question: "Proceed?", answer: "Yes" }],
        },
      },
    ]);
  });

  it("normalizes thread attachment markers into compact system messages", () => {
    // Attachment markers are persisted in messageHistory and drive Main
    // projection display while keeping the raw marker available to UI filters.
    const message: BrowserIncomingMessage = {
      type: "thread_attachment_marker",
      id: "marker-q-941",
      timestamp: 1234,
      markerKey: "thread-attachment:q-941:m1,m2",
      threadKey: "q-941",
      questId: "q-941",
      attachedAt: 1234,
      attachedBy: "session-1",
      messageIds: ["m1", "m2"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
      count: 2,
      firstMessageId: "m1",
      firstMessageIndex: 1,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 9);

    expect(normalized).toEqual([
      {
        id: "marker-q-941",
        role: "system",
        content: "2 messages moved to q-941",
        timestamp: 1234,
        historyIndex: 9,
        variant: "info",
        metadata: { threadAttachmentMarker: message },
      },
    ]);
  });

  it("normalizes thread transition markers into handoff system messages", () => {
    const message: BrowserIncomingMessage = {
      type: "thread_transition_marker",
      id: "transition-q-940-q-941",
      timestamp: 1235,
      markerKey: "thread-transition:q-940->q-941:7",
      sourceThreadKey: "q-940",
      sourceQuestId: "q-940",
      threadKey: "q-941",
      questId: "q-941",
      transitionedAt: 1235,
      reason: "route_switch",
      sourceMessageIndex: 7,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 10);

    expect(normalized).toEqual([
      {
        id: "transition-q-940-q-941",
        role: "system",
        content: "Work continued from thread:q-940 to thread:q-941",
        timestamp: 1235,
        historyIndex: 10,
        variant: "info",
        metadata: { threadTransitionMarker: message },
      },
    ]);
  });

  it("uses compact audit summaries for cross-thread activity markers when provided", () => {
    const message: BrowserIncomingMessage = {
      type: "cross_thread_activity_marker",
      id: "thread-attach-audit:q-941:a1:m1",
      timestamp: 1236,
      threadKey: "q-941",
      questId: "q-941",
      count: 1,
      activityKind: "thread_attach",
      attachedCount: 4,
      summary: "Thread attach command added 4 Main messages to thread:q-941",
      firstMessageId: "a1",
      lastMessageId: "m1",
      firstHistoryIndex: 7,
      lastHistoryIndex: 8,
      startedAt: 1235,
      updatedAt: 1236,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 8);

    expect(normalized).toEqual([
      {
        id: "thread-attach-audit:q-941:a1:m1",
        role: "system",
        content: "Thread attach command added 4 Main messages to thread:q-941",
        timestamp: 1236,
        historyIndex: 8,
        ephemeral: true,
        metadata: {
          threadKey: "q-941",
          questId: "q-941",
          crossThreadActivityMarker: {
            threadKey: "q-941",
            questId: "q-941",
            count: 1,
            activityKind: "thread_attach",
            attachedCount: 4,
            summary: "Thread attach command added 4 Main messages to thread:q-941",
            firstMessageId: "a1",
            lastMessageId: "m1",
            firstHistoryIndex: 7,
            lastHistoryIndex: 8,
            startedAt: 1235,
            updatedAt: 1236,
          },
        },
      },
    ]);
  });

  it("replays leader user-visible messages as assistant Markdown", () => {
    const message: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: "leader-user-1",
      content: "**Visible** leader update",
      timestamp: 2000,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 11);

    expect(normalized).toEqual([
      {
        id: "leader-user-1",
        role: "assistant",
        content: "**Visible** leader update",
        timestamp: 2000,
        historyIndex: 11,
        metadata: { leaderUserMessage: true },
      },
    ]);
  });

  it("repairs persisted assistant thread prefixes in newline form", () => {
    // Older persisted history may contain the raw marker without routing
    // metadata. History sync repairs that so quest threads project correctly.
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-newline",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941]\nImplementation update" }],
        },
      },
      12,
    )[0]!;

    expect(normalized.content).toBe("Implementation update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "Implementation update" }]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("repairs persisted assistant thread prefixes in same-line form", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-same-line",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941] Same-line update" }],
        },
      },
      13,
    )[0]!;

    expect(normalized.content).toBe("Same-line update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "Same-line update" }]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("leaves no-space same-line quest thread prefixes unrepaired", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-no-space",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941]Implementation update" }],
        },
      },
      14,
    )[0]!;

    expect(normalized.content).toBe("[thread:q-941]Implementation update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "[thread:q-941]Implementation update" }]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("hides persisted main thread markers without adding a quest projection", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:main] General update" }],
        },
      },
      14,
    )[0]!;

    expect(normalized.content).toBe("General update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "General update" }]);
    expect(normalized.metadata).toEqual({ threadKey: "main" });
  });

  it("leaves no-space same-line main thread prefixes unrepaired", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main-no-space",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:main]Using quest workflow" }],
        },
      },
      15,
    )[0]!;

    expect(normalized.content).toBe("[thread:main]Using quest workflow");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "[thread:main]Using quest workflow" }]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("repairs persisted Bash command thread comments as tool routing metadata", () => {
    // Tool calls use shell-comment routing syntax, not chat text prefixes. Older
    // persisted tool-use-only messages may need this repair after history sync.
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-bash-command",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941\npwd" } }],
        },
      },
      16,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("repairs persisted main Bash command comments without adding a quest projection", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main-bash-command",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:main\npwd" } }],
        },
      },
      17,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]);
    expect(normalized.metadata).toEqual({ threadKey: "main" });
  });

  it("does not repair non-standalone Bash command comments", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-inline-bash-comment",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941 && pwd" } }],
        },
      },
      18,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941 && pwd" } },
    ]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("matches replay semantics for visible task_notification messages", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const message: BrowserIncomingMessage = {
      type: "task_notification",
      status: "completed",
      task_id: "task-1",
      summary: "Background task finished",
      tool_use_id: "tool-1",
      output_file: "/tmp/out.txt",
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 4);

    expect(normalized).toEqual([
      {
        id: "task-notif-task-1",
        role: "system",
        content: "Background task finished",
        timestamp: 123456,
        historyIndex: 4,
        variant: "task_completed",
      },
    ]);
    now.mockRestore();
  });

  it("normalizes a server-authored recovery summary without making it a user/model message", () => {
    // The browser history projection is a system row with authoritative structured receipts and thread routing.
    const message: BrowserIncomingMessage = {
      type: "codex_auto_pause_recovery_summary",
      id: "recovery-1",
      timestamp: 100,
      content: "Automatic input recovery: 1 suppressed.",
      searchText: "automatic input recovery detail:board_stalled reason_code:stale_board_state",
      threadKey: "q-42",
      questId: "q-42",
      recovery: {
        family: "copilot_auth_refresh_exhausted",
        pausedAt: 10,
        recoveryConfirmedAt: 20,
        updatedAt: 100,
        status: "settled",
        receipts: [
          {
            groupId: "group-1",
            source: "programmatic",
            sourceLabel: "Herd Events",
            sourceDetail: "board_stalled",
            count: 1,
            coalescedCount: 0,
            queuedAt: 11,
            lastQueuedAt: 11,
            releasedAt: 20,
            terminalAt: 100,
            outcome: "suppressed",
            reasonCode: "stale_board_state",
            reason: "Suppressed because the authoritative board state no longer matched the stalled event.",
          },
        ],
      },
    };

    const [normalized] = normalizeHistoryMessageToChatMessages(message, 8);

    expect(normalized).toMatchObject({
      id: "recovery-1",
      role: "system",
      variant: "info",
      historyIndex: 8,
      metadata: {
        threadKey: "q-42",
        questId: "q-42",
        codexAutoPauseRecoverySummary: message.recovery,
      },
    });
    expect(normalized?.agentSource).toBeUndefined();
  });

  it("preserves native child ownership on rendered terminal results", () => {
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const baseResult: Extract<BrowserIncomingMessage, { type: "result" }> = {
      type: "result" as const,
      data: {
        type: "result" as const,
        subtype: "error_during_execution" as const,
        is_error: true,
        result: "child failed",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        session_id: "session-1",
      },
      codexSubagent: ownership,
    } as Extract<BrowserIncomingMessage, { type: "result" }>;

    const [failed] = normalizeHistoryMessageToChatMessages(baseResult, 15);
    const [successful] = normalizeHistoryMessageToChatMessages(
      {
        ...baseResult,
        data: { ...baseResult.data, subtype: "success", is_error: false, result: "child done" },
      } as BrowserIncomingMessage,
      16,
      { includeSuccessfulResult: true },
    );

    expect(failed).toMatchObject({ variant: "error", metadata: { codexSubagent: ownership } });
    expect(successful).toMatchObject({ content: "child done", metadata: { codexSubagent: ownership } });
  });

  it("preserves stable child error identity, chronology, route, and ownership", () => {
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const [normalized] = normalizeHistoryMessageToChatMessages(
      {
        type: "error",
        id: "child-error-stable",
        message: "Privacy-bounded child failure",
        timestamp: 321,
        threadKey: "q-42",
        questId: "q-42",
        codexSubagent: ownership,
      },
      17,
    );

    expect(normalized).toEqual({
      id: "child-error-stable",
      role: "system",
      content: "Privacy-bounded child failure",
      timestamp: 321,
      historyIndex: 17,
      variant: "error",
      metadata: { threadKey: "q-42", questId: "q-42", codexSubagent: ownership },
    });
  });

  it("attaches child tool results only to matching tool uses in that child message", () => {
    const ownership = { childId: "opaque-child", rootTurnId: "root-turn" };
    const matching = {
      tool_use_id: "shared-tool",
      content: "child-owned result",
      is_error: false,
      total_size: 18,
      is_truncated: false,
    };
    const [normalized] = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: "spawn-tool",
        codexSubagent: ownership,
        message: {
          id: "child-tool-message",
          type: "message",
          role: "assistant",
          model: "gpt-test",
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "tool_use", id: "shared-tool", name: "Bash", input: { command: "pwd" } }],
        },
      },
      18,
      {
        codexSubagentToolResults: new Map([
          ["shared-tool", matching],
          [
            "other-tool",
            {
              tool_use_id: "other-tool",
              content: "other child result",
              is_error: false,
              total_size: 18,
              is_truncated: false,
            },
          ],
        ]),
      },
    );

    expect(normalized?.metadata).toEqual({
      codexSubagent: ownership,
      codexSubagentToolResults: { "shared-tool": matching },
    });
  });
});
