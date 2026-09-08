import { describe, expect, it } from "vitest";
import { buildThreadRoutingReminderContent, isLeaderAnswerRouteDiagnostic } from "./thread-routing-reminder.js";

describe("buildThreadRoutingReminderContent", () => {
  it("accepts timer and mixed answer diagnostics while rejecting recurring timer IDs", () => {
    // The same compact reference grammar is used by parsed answers and their
    // persisted rejection diagnostics; timer IDs are not firing identities.
    const diagnostic = {
      reason: "invalid_ids",
      selectedThreadKey: "main",
      answerUserMessageIds: ["u1", "f2"],
      ownerGroups: [],
    };
    expect(isLeaderAnswerRouteDiagnostic(diagnostic)).toBe(true);
    expect(isLeaderAnswerRouteDiagnostic({ ...diagnostic, answerUserMessageIds: ["t2"] })).toBe(false);
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      answerRouteDiagnostic: {
        reason: "invalid_ids",
        selectedThreadKey: "main",
        answerUserMessageIds: ["f2"],
        ownerGroups: [],
      },
    });
    expect(content).toContain("timer-firing `fN` IDs");
    expect(content).toContain("Never use recurring timer `tN`");
    const routing = buildThreadRoutingReminderContent({ reason: "missing", source: "visible_text" });
    expect(routing).toContain("[thread:main:A:f1]");
    expect(routing).toContain("Timer progress remains commentary");
  });

  // Leaders recovering from compaction need to know whether visible text or a shell command missed routing.
  it("identifies missing markers on visible leader text", () => {
    const content = buildThreadRoutingReminderContent({ reason: "missing", source: "visible_text" });

    expect(content).toContain("Missing thread marker on visible leader text");
    expect(content).toContain("previous visible leader message");
    expect(content).toContain("`[thread:main:C]` / `[thread:q-N:C]`");
    expect(content).toContain("`[thread:main:A:u1]` / `[thread:q-N:A:u1,u2]`");
    expect(content).toContain("standalone `---` line immediately before the next role-bearing marker");
    expect(content).toContain("One answer shared across tabs needs only one marker");
    expect(content).toContain("For distinct content or roles");
    expect(content).toContain("`# thread:main` or `# thread:q-N`");
    expect(content).not.toContain("previous leader response");
  });

  // Shell-command reminders should not imply that the user-visible assistant text was the mistake.
  it("identifies missing markers on leader shell commands", () => {
    const content = buildThreadRoutingReminderContent({ reason: "missing", source: "shell_command" });

    expect(content).toContain("Missing thread marker on leader shell command");
    expect(content).toContain("previous leader shell command");
    expect(content).toContain("`# thread:main` or `# thread:q-N`");
    expect(content).toContain("`[thread:main:C]` / `[thread:q-N:C]`");
    expect(content).toContain("`[thread:main:A:u1]` / `[thread:q-N:A:u1,u2]`");
    expect(content).toContain("standalone `---` line immediately before each later role-bearing marker");
    expect(content).not.toContain("previous leader response");
  });

  // Older persisted routing errors may lack source metadata; keep the copy honest about uncertainty.
  it("uses uncertainty wording when the routing source is unavailable", () => {
    const content = buildThreadRoutingReminderContent({ reason: "missing" });

    expect(content).toContain("output type is unavailable");
    expect(content).toContain("If it was visible leader text");
    expect(content).toContain("standalone `---` line immediately before each later role-bearing marker");
    expect(content).toContain("If it was a leader shell command");
    expect(content).not.toContain("previous leader response");
  });

  it("keeps invalid marker details with visible text attribution", () => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid",
      source: "visible_text",
      marker: "[thread:side]",
    });

    expect(content).toContain("Invalid marker: [thread:side] on visible leader text");
  });

  it("retains a historical missing-association diagnostic without teaching an obsolete correction", () => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      source: "answer_marker",
      answerRouteDiagnostic: {
        reason: "missing_association",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u37", "u38"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u37", "u38"] }],
        missingAssociationUserMessageIds: ["u38"],
      },
    });

    expect(content).toContain("Invalid answer route from q-2044");
    expect(content).toContain("Historical routing rejection: q-2044 lacked associations for u38");
    expect(content).toContain("Current answers automatically follow the union");
    expect(content).toContain(
      "Do not discover history indices, attach the answer, split the answer, or repeat its prose",
    );
    expect(content).not.toContain("send only a brief correction");
    expect(content).not.toContain("[thread:q-2042:A:u37,u38]");
    expect(content).toContain("Do not mark q-2044 Ready");
  });

  it("retains a historical Main restriction while teaching automatic routing in either direction", () => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      source: "answer_marker",
      answerRouteDiagnostic: {
        reason: "disallowed_main_backfill",
        selectedThreadKey: "main",
        answerUserMessageIds: ["u37", "u38"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u37", "u38"] }],
      },
    });

    expect(content).toContain("Historical routing rejection: Main was selected for quest-owned prompts: u37,u38");
    expect(content).toContain("automatic routing between Main and quests in either direction");
    expect(content).not.toContain("Main cannot be used");
    expect(content).not.toContain("[thread:q-2042:A:u37,u38]");
  });

  it("explains otherwise parsed but ineligible answer rows", () => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      source: "answer_marker",
      answerRouteDiagnostic: {
        reason: "invalid_answer",
        selectedThreadKey: "main",
        answerUserMessageIds: ["u7"],
        ownerGroups: [],
      },
    });

    expect(content).toContain("answer metadata or message shape is invalid: u7");
    expect(content).toContain("Use the supplied earlier human `uN` or timer-firing `fN` IDs");
    expect(content).toContain("did not gain coverage");
  });

  it.each([
    "unproven_owner",
    "nonconsecutive_ids",
    "stale",
    "route_control_conflict",
  ] as const)("does not suggest an exact correction for %s evidence", (reason) => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      source: "answer_marker",
      answerRouteDiagnostic: {
        reason,
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u37", "u38"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u37", "u38"] }],
      },
    });

    expect(content).toContain("Current answers may cover nonconsecutive IDs and different owning threads");
    expect(content).toContain("Each thread receives coverage only for its own referenced requests");
    expect(content).not.toContain("inspect current ownership and pending IDs before writing");
    expect(content).not.toContain("Authoritative owner:");
    expect(content).not.toContain("[thread:q-2042:A:u37,u38]");
  });

  it("keeps a historical mixed-owner rejection readable without requiring separate answers", () => {
    const content = buildThreadRoutingReminderContent({
      reason: "invalid_answer_route",
      source: "answer_marker",
      answerRouteDiagnostic: {
        reason: "multiple_owners",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u37", "u38"],
        ownerGroups: [
          { threadKey: "q-2042", userMessageIds: ["u37"] },
          { threadKey: "main", userMessageIds: ["u38"] },
        ],
      },
    });

    expect(content).toContain("q-2042 (u37); Main (u38)");
    expect(content).toContain("Historical routing rejection");
    expect(content).toContain("Current answers support different owning threads");
    expect(content).toContain("Takode routes one stored answer automatically");
    expect(content).not.toContain("[thread:q-2042:A:u37,u38]");
    expect(content).not.toContain("[thread:main:A:u37,u38]");
  });

  it("identifies invalid IDs and unproven owners without treating a group as one owner", () => {
    // Current failures still identify the exact IDs; removed authoring rules
    // must not reappear in either the precise or incomplete-evidence fallback.
    for (const reason of ["invalid_ids", "unproven_owner"] as const) {
      const content = buildThreadRoutingReminderContent({
        reason: "invalid_answer_route",
        answerRouteDiagnostic: {
          reason,
          selectedThreadKey: "main",
          answerUserMessageIds: ["u7", "u9"],
          ownerGroups: [],
        },
      });
      expect(content).toContain("u7,u9");
      expect(content).toContain("did not gain coverage");
      expect(content).not.toContain("one current owner for the listed IDs");
      expect(content).not.toContain("Historical routing rejection");
    }
    const fallback = buildThreadRoutingReminderContent({ reason: "invalid_answer_route" });
    expect(fallback).toContain("do not guess a correction from incomplete evidence");
    expect(fallback).not.toContain("one corrected owner-thread marker");
  });

  it("rejects malformed persisted semantic diagnostics", () => {
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "multiple_owners",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u1", "u2"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1", "u2"] }],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "route_control_conflict",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u1", "u2"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1"] }],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "missing_association",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u1"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1"] }],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "missing_association",
        selectedThreadKey: "q-2042",
        answerUserMessageIds: ["u1"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1"] }],
        missingAssociationUserMessageIds: ["u1"],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "missing_association",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u1", "u2", "u3"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u1", "u2", "u3"] }],
        missingAssociationUserMessageIds: ["u3", "u1"],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "disallowed_main_backfill",
        selectedThreadKey: "main",
        answerUserMessageIds: ["u1"],
        ownerGroups: [{ threadKey: "main", userMessageIds: ["u1"] }],
      }),
    ).toBe(false);
    expect(
      isLeaderAnswerRouteDiagnostic({
        reason: "missing_association",
        selectedThreadKey: "q-2044",
        answerUserMessageIds: ["u1", "u2"],
        ownerGroups: [{ threadKey: "q-2042", userMessageIds: ["u2", "u1"] }],
        missingAssociationUserMessageIds: ["u1"],
      }),
    ).toBe(false);
  });
});
