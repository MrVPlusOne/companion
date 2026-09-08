import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage, ContentBlock, SessionNotification } from "../session-types.js";
import { notifyUser } from "./session-notification-controller.js";

function assistant(id: string, content: ContentBlock[], threadKey = "q-42"): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 1,
    threadKey,
  };
}

function request(threadKey: string, attached = false): BrowserIncomingMessage {
  return {
    type: "user_message",
    id: "current-request",
    content: "Prepare the requested proposal.",
    timestamp: 2,
    threadKey,
    ...(attached ? { threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "backfill" as const }] } : {}),
  };
}

const oldPrompt = () => assistant("older-quiz", [{ type: "text", text: "Old closure.\n{[(Quest Quiz: q-42)]}" }]);
const tool = (id: string) =>
  assistant(id, [
    { type: "tool_use", id: `call-${id}`, name: "Bash", input: { command: "takode board propose q-42" } },
  ]);

function notify(messageHistory: BrowserIncomingMessage[], leader = true) {
  const session = {
    id: "leader",
    messageHistory,
    notifications: [] as SessionNotification[],
    notificationCounter: 0,
    activeTurnRoute: { threadKey: "q-42", questId: "q-42" },
    state: {},
    pendingPermissions: new Map(),
    attentionReason: null,
  };
  const result = notifyUser(session, "needs-input", "Confirm this proposal", {
    getLauncherSessionInfo: () => ({ isOrchestrator: leader }),
    persistSession: vi.fn(),
  });
  return { result, session };
}

describe("leader notification source request boundary", () => {
  it.each([false, true])("does not borrow an older Quiz prompt across a new request (attached: %s)", (attached) => {
    // The notify command itself can reach history only after its HTTP call.
    // The completed proposal tool is then the newest source in this request.
    const old = oldPrompt();
    const human = request(attached ? "q-43" : "q-42", attached);
    const proposal = tool("proposal");
    const beforeOld = structuredClone(old);
    const { result, session } = notify([old, human, proposal]);

    expect(result.anchoredMessageId).toBe("proposal");
    expect(old).toEqual(beforeOld);
    expect(human.threadKey).toBe(attached ? "q-43" : "q-42");
    expect(session.notifications[0]).toMatchObject({ messageId: "proposal", done: false, threadKey: "q-42" });
  });

  it("still prefers substantive decision prose within the current request over subsequent tools", () => {
    const prompt = assistant("current-prompt", [{ type: "text", text: "Here is the complete current decision." }]);
    const { result } = notify([oldPrompt(), request("q-42"), prompt, tool("activity")]);
    expect(result.anchoredMessageId).toBe("current-prompt");
  });

  it("uses the chronological fallback when a new request has no eligible assistant source", () => {
    // An empty current segment must not resurrect the prior decision as its prompt.
    const { result, session } = notify([oldPrompt(), request("q-42")]);
    expect(result.anchoredMessageId).toMatch(/^leader-needs-input-/);
    expect(session.messageHistory.at(-1)).toMatchObject({
      type: "leader_user_message",
      threadKey: "q-42",
      content: "Needs input: Confirm this proposal",
    });
  });

  it("keeps another thread's request from replacing a still-relevant source segment", () => {
    const { result } = notify([oldPrompt(), request("q-43"), tool("activity")]);
    expect(result.anchoredMessageId).toBe("older-quiz");
  });

  it("does not change worker tool anchoring", () => {
    const { result } = notify([oldPrompt(), request("q-42"), tool("activity")], false);
    expect(result.anchoredMessageId).toBe("activity");
  });
});
