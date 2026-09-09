import { describe, expect, it } from "vitest";
import { appendCodeEvidence } from "./quest-delivery-evidence.js";
import { deliveryFixture } from "../src/test-fixtures/commit-delivery-fixture.js";
import type { QuestmasterTask } from "./quest-types.js";

describe("immutable delivery evidence", () => {
  it("preserves prior target and memory SHAs while atomically appending a fixed delivery", () => {
    const quest = {
      status: "in_progress",
      sessionId: "fixture-worker",
      commitShas: ["a".repeat(40)],
      memoryCommitShas: ["b".repeat(40)],
    } as QuestmasterTask;
    const shas = deliveryFixture.commits.map((item) => item.sha);
    const owner = { kind: "takode" as const, sessionId: "fixture-worker" };
    const updated = appendCodeEvidence(quest, owner, shas, deliveryFixture);
    expect(updated.commitShas).toEqual([...quest.commitShas!, ...shas]);
    expect(updated.memoryCommitShas).toEqual(quest.memoryCommitShas);
    expect(updated.codeDeliveries).toEqual([deliveryFixture]);
    // Later target advancement on an idempotent retry must not rewrite the originally recorded target head/time.
    expect(
      appendCodeEvidence(updated, owner, shas, { ...deliveryFixture, recordedAt: 999, targetHeadSha: "9".repeat(40) }),
    ).toBe(updated);
    expect(() =>
      appendCodeEvidence(updated, owner, shas, {
        ...deliveryFixture,
        commits: deliveryFixture.commits.map((item) => ({ ...item, message: "Changed" })),
      }),
    ).toThrow("cannot be changed");
  });
});
