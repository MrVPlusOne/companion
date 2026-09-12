import { describe, expect, it } from "vitest";
import { SessionStore, type PersistedSession } from "./session-store.js";

describe("SessionStore root-feed search excerpts", () => {
  it("retains root excerpts while excluding proven native child content", () => {
    // Archived search-only sessions cannot navigate into the child inspector,
    // so newly generated excerpts must mirror the ordinary root-feed surface.
    const messages = [
      { type: "user_message", content: "Root archived request", timestamp: 1000, id: "root-user" },
      {
        type: "assistant",
        message: {
          id: "root-assistant",
          role: "assistant",
          model: "test",
          content: [{ type: "text", text: "Root archived answer" }],
          stop_reason: "end_turn",
          usage: {},
        },
        parent_tool_use_id: null,
        timestamp: 1500,
      },
      {
        type: "assistant",
        message: {
          id: "child-assistant",
          role: "assistant",
          model: "test",
          content: [{ type: "text", text: "Child-only archive search content" }],
          stop_reason: "end_turn",
          usage: {},
        },
        parent_tool_use_id: null,
        timestamp: 2000,
        codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" },
      },
      {
        type: "user_message",
        id: "child-user",
        content: "Child-only archived request",
        timestamp: 2100,
        codexSubagent: { childId: "opaque-child", rootTurnId: "root-turn" },
      },
    ] as PersistedSession["messageHistory"];

    expect(SessionStore.extractSearchExcerpts(messages)).toEqual([
      { type: "user_message", content: "Root archived request", timestamp: 1000, id: "root-user" },
      { type: "assistant", content: "Root archived answer", timestamp: 1500, id: "root-assistant" },
    ]);
  });
});

// Annotation-only requests must remain discoverable after full history is unloaded.
it("includes structured comments in bounded archived search excerpts", () => {
  const excerpts = SessionStore.extractSearchExcerpts([
    {
      type: "user_message",
      content: "",
      timestamp: 1,
      annotations: [{ id: "comment", selectedText: "cache", comment: "What happens on expiry?" }],
    },
  ]);
  expect(excerpts[0].content).toBe("> cache\n[comment 1] What happens on expiry?");
});
