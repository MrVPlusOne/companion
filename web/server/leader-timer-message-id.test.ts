import { describe, expect, it } from "vitest";
import { buildLeaderTimerMessageIdentities, nextLeaderTimerMessageId } from "./leader-timer-message-id.js";
import type { BrowserIncomingMessage } from "./session-types.js";

function firing(id: string, leaderTimerMessageId?: string): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id,
    leaderTimerMessageId,
    content: "[⏰ Timer t1 reminder] Check progress",
    agentSource: { sessionId: "timer:t1" },
    timestamp: 1,
    threadKey: "main",
  };
}

describe("leader timer-firing IDs", () => {
  it("keeps recurring firings distinct across history replay without minting historic IDs", () => {
    // Both accepted deliveries belong to t1, while the older reminder predates
    // firing identity and remains outside answer authority.
    const history = [firing("legacy"), firing("first", "f1"), firing("second", "timer-m2")];
    const identities = buildLeaderTimerMessageIdentities(history);
    expect(identities.map((entry) => [entry.userMessageId, entry.historyMessageId])).toEqual([
      ["f1", "first"],
      ["timer-m2", "second"],
    ]);
    expect(buildLeaderTimerMessageIdentities(JSON.parse(JSON.stringify(history)))).toEqual(identities);
    expect(nextLeaderTimerMessageId(history, ["f4", undefined])).toBe("timer-m5");
    expect(nextLeaderTimerMessageId(history, ["timer-m6", "f8"])).toBe("timer-m9");
    expect(nextLeaderTimerMessageId([])).toBe("timer-m1");
  });

  it("rejects duplicate raw or firing identities instead of reassigning authority", () => {
    // Either collision makes target lookup ambiguous. Every colliding firing
    // remains reserved even when none can authorize an answer.
    for (const history of [
      [firing("first", "f100"), firing("second", "f100")],
      [firing("same", "f99"), firing("same", "f100")],
    ]) {
      expect(buildLeaderTimerMessageIdentities(history)).toEqual([]);
      expect(nextLeaderTimerMessageId(history)).toBe("timer-m101");
    }
    expect(nextLeaderTimerMessageId([], ["f9007199254740992"])).toBe("timer-m9007199254740993");
    expect(nextLeaderTimerMessageId([], ["timer-m9007199254740993"])).toBe("timer-m9007199254740994");
  });

  it("excludes cancellation, other injected sources, child ownership, and retired recovery rows", () => {
    const cancel = { ...firing("cancel", "f1"), content: "[⏰ Timer t1 cancelled] Check progress" };
    const injected = { ...firing("injected", "f2"), agentSource: { sessionId: "system:reminder" } };
    const child = {
      ...firing("child", "f3"),
      codexSubagent: { childId: "child-1", rootTurnId: "root-turn" },
    };
    const retired = { ...firing("retired", "f4"), codexTurnRecoveryResolvedAt: 10 };
    expect(buildLeaderTimerMessageIdentities([cancel, injected, child, retired, firing("valid", "f5")])).toMatchObject([
      { userMessageId: "f5", historyMessageId: "valid" },
    ]);
  });

  it("does not let an invalid root envelope lend or alias a valid firing identity", () => {
    // Identity collisions must be checked before excluding malformed sources.
    const duplicate = { ...firing("bad", "f1"), agentSource: { sessionId: "system:other" } };
    expect(buildLeaderTimerMessageIdentities([firing("good", "f1"), duplicate])).toEqual([]);
    expect(
      buildLeaderTimerMessageIdentities([
        firing("good", "f1"),
        { ...duplicate, id: "good", leaderTimerMessageId: undefined },
      ]),
    ).toEqual([]);
  });
});
