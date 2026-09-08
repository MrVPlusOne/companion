import { describe, expect, it } from "vitest";
import {
  isCanonicalLeaderAnswerMessageId,
  isCanonicalLeaderTimerMessageId,
  isLeaderTimerAnswerTarget,
  timerReminderMatchesSource,
} from "./leader-answer-message-id.js";

describe("leader answer message identities", () => {
  it("accepts direct-user and individual-firing IDs without accepting timer schedule IDs", () => {
    // Current timer-mN and retained fN records use exact, distinct spellings;
    // accepting either does not alias one to the other or accept schedule IDs.
    for (const id of ["u1", "timer-m1", "timer-m200", "f1", "f200"])
      expect(isCanonicalLeaderAnswerMessageId(id)).toBe(true);
    for (const id of [
      "t1",
      "timer-m0",
      "timer-m01",
      "timer-m-1",
      "TIMER-M1",
      "timer-m1suffix",
      "f0",
      "f01",
      "F1",
      "u0",
      "f1,f2",
      undefined,
    ]) {
      expect(isCanonicalLeaderAnswerMessageId(id)).toBe(false);
    }
    expect(isCanonicalLeaderTimerMessageId("u1")).toBe(false);
  });

  it("requires a persisted firing ID and a matching timer reminder source", () => {
    // Cancellation events use the same source and must stay ineligible even
    // when malformed history happens to carry an fN field.
    const firing = {
      leaderTimerMessageId: "timer-m1",
      agentSource: { sessionId: "timer:t2" },
      content: "[⏰ Timer t2 reminder] Check progress",
    };
    expect(isLeaderTimerAnswerTarget(firing)).toBe(true);
    for (const override of [
      { leaderTimerMessageId: undefined },
      { content: "[⏰ Timer t2 cancelled] Check progress" },
      { content: "[⏰ Timer t3 reminder] Check progress" },
      { content: "ordinary direct input" },
      { agentSource: { sessionId: "worker:1" } },
      { agentSource: { sessionId: "timer:t02" } },
      { agentSource: undefined },
    ]) {
      expect(isLeaderTimerAnswerTarget({ ...firing, ...override })).toBe(false);
    }
  });

  it("recognizes genuine resumed firings through repeated exact pause wrappers", () => {
    // The server wraps a coalesced held input whenever a group with count >1
    // drains. A later pause/drain can retain an earlier wrapper in the content.
    const reminder = "[⏰ Timer t2 reminder] Check progress";
    const wrap = (count: number) =>
      `[Takode auto-pause resumed: ${count} similar automatic inputs were coalesced while delivery was paused.]\n\n`;
    for (const prefix of ["", wrap(2), wrap(12) + wrap(3)]) {
      const content = prefix + reminder;
      expect(timerReminderMatchesSource(content, "timer:t2")).toBe(true);
      expect(
        isLeaderTimerAnswerTarget({ content, agentSource: { sessionId: "timer:t2" }, leaderTimerMessageId: "f1" }),
      ).toBe(true);
      expect(timerReminderMatchesSource(content, "timer:t3")).toBe(false);
      expect(timerReminderMatchesSource(prefix + "[⏰ Timer t2 cancelled] Check progress", "timer:t2")).toBe(false);
    }
    for (const invalidPrefix of [
      wrap(0),
      wrap(1),
      wrap(-2),
      wrap(2.5),
      wrap(2).replace(": 2 ", ": 02 "),
      wrap(2).replace("resumed:", "resume:"),
      wrap(2).replace("\n\n", "\n"),
      wrap(2).replace("\n\n", "\r\n\r\n"),
      wrap(2) + " ",
      wrap(2) + "Untrusted prefix\n\n",
    ]) {
      expect(timerReminderMatchesSource(invalidPrefix + reminder, "timer:t2")).toBe(false);
    }
  });
});
