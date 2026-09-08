import { describe, expect, it } from "vitest";
import {
  leaderResponseAnswerOwnerThreadKeys,
  leaderResponseAssociatedThreadKeys,
  leaderResponseExactAnswerThreadKey,
  leaderResponseMessageIsAssociatedWithThread,
  leaderResponseOwnerThreadKey,
  leaderResponseProvenCurrentOwnerThreadKey,
  leaderResponseStableOwnerThreadKeyForRepair,
} from "./leader-thread-response-routing.js";

describe("leader answer ownership routing", () => {
  it("requires complete owner proof for mixed user requests and timer firings", () => {
    // Owner partitions retain one answer identity across both target types.
    const ownerGroups = [
      { threadKey: "main", userMessageIds: ["u1"] },
      { threadKey: "q-2", userMessageIds: ["timer-m1", "timer-m2"] },
    ];
    expect(
      leaderResponseAnswerOwnerThreadKeys(
        { answerUserMessageIds: ["timer-m1", "u1", "timer-m2"], ownerGroups },
        "main",
      ),
    ).toEqual(
      new Map([
        ["u1", "main"],
        ["timer-m1", "q-2"],
        ["timer-m2", "q-2"],
      ]),
    );
    expect(
      leaderResponseAnswerOwnerThreadKeys({ answerUserMessageIds: ["timer-m1", "u1"], ownerGroups }, "main"),
    ).toBeNull();
    expect(leaderResponseAnswerOwnerThreadKeys({ answerUserMessageIds: ["t1"] }, "main")).toBeNull();
    // Even a complete owner partition cannot make the removed syntax valid.
    expect(
      leaderResponseAnswerOwnerThreadKeys(
        {
          answerUserMessageIds: ["u1", "f1"],
          ownerGroups: [
            { threadKey: "main", userMessageIds: ["u1"] },
            { threadKey: "q-2", userMessageIds: ["f1"] },
          ],
        },
        "main",
      ),
    ).toBeNull();
  });

  it("decodes an exact owner partition independently from authored order and source route", () => {
    // One stored answer can cover nonadjacent prompts from several owners.
    expect(
      leaderResponseAnswerOwnerThreadKeys(
        {
          answerUserMessageIds: ["u7", "u1", "u4"],
          ownerGroups: [
            { threadKey: "main", userMessageIds: ["u1"] },
            { threadKey: "q-2", userMessageIds: ["u4", "u7"] },
          ],
        },
        "main",
      ),
    ).toEqual(
      new Map([
        ["u1", "main"],
        ["u4", "q-2"],
        ["u7", "q-2"],
      ]),
    );
    expect(leaderResponseAnswerOwnerThreadKeys({ answerUserMessageIds: ["u1", "u4"] }, "q-2")).toEqual(
      new Map([
        ["u1", "q-2"],
        ["u4", "q-2"],
      ]),
    );
  });

  it("does not downgrade malformed or incomplete owner partitions to legacy single-owner proof", () => {
    // Missing, repeated, extra, or malformed entries cannot manufacture coverage.
    for (const ownerGroups of [
      null,
      [],
      "main",
      [{}],
      [{ threadKey: "main", userMessageIds: ["u1"] }],
      [{ threadKey: "main", userMessageIds: ["u1", "u2", "u3"] }],
      [{ threadKey: "all", userMessageIds: ["u1", "u2"] }],
      [
        { threadKey: "main", userMessageIds: ["u1"] },
        { threadKey: "q-2", userMessageIds: ["u1", "u2"] },
      ],
      [
        { threadKey: "main", userMessageIds: ["u1"] },
        { threadKey: "main", userMessageIds: ["u2"] },
      ],
    ]) {
      expect(
        leaderResponseAnswerOwnerThreadKeys({ answerUserMessageIds: ["u1", "u2"], ownerGroups }, "main"),
      ).toBeNull();
    }
    expect(leaderResponseAnswerOwnerThreadKeys({ answerUserMessageIds: ["u1", "u1"] }, "main")).toBeNull();
  });

  it("uses the newest non-backfill assignment instead of the original route", () => {
    expect(
      leaderResponseOwnerThreadKey({
        threadKey: "main",
        threadRefs: [
          { threadKey: "q-1", questId: "q-1", source: "explicit", attachedAt: 10 },
          { threadKey: "q-2", questId: "q-2", source: "inferred", attachedAt: 20 },
        ],
      }),
    ).toBe("q-2");
  });

  it("keeps backfill membership visibility-only", () => {
    expect(
      leaderResponseOwnerThreadKey({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill", attachedAt: 20 }],
      }),
    ).toBe("main");
  });

  it("projects q-only backfill membership alongside the current owner without reviving older assignments", () => {
    expect(
      leaderResponseAssociatedThreadKeys({
        threadKey: "main",
        threadRefs: [
          { threadKey: "q-1", questId: "q-1", source: "backfill", attachedAt: 10 },
          { threadKey: "q-2", questId: "q-2", source: "backfill", attachedAt: 20 },
          { threadKey: "main", source: "backfill", attachedAt: 30 },
        ],
      }),
    ).toEqual(["main", "q-1", "q-2"]);

    const reassigned = {
      threadKey: "main",
      threadRefs: [
        { threadKey: "q-1", questId: "q-1", source: "explicit" as const, attachedAt: 10 },
        { threadKey: "q-3", questId: "q-3", source: "backfill" as const, attachedAt: 15 },
        { threadKey: "q-2", questId: "q-2", source: "inferred" as const, attachedAt: 20 },
        { threadKey: "main", source: "backfill" as const, attachedAt: 30 },
      ],
    };
    expect(leaderResponseAssociatedThreadKeys(reassigned)).toEqual(["q-2", "q-3"]);
    expect(leaderResponseMessageIsAssociatedWithThread(reassigned, "main")).toBe(false);
    expect(leaderResponseMessageIsAssociatedWithThread(reassigned, "q-1")).toBe(false);
    expect(leaderResponseMessageIsAssociatedWithThread(reassigned, "q-2")).toBe(true);
    expect(leaderResponseMessageIsAssociatedWithThread(reassigned, "q-3")).toBe(true);
  });

  it("fails malformed direct ownership conservatively to Main", () => {
    expect(leaderResponseOwnerThreadKey({ threadKey: "q-1", questId: "q-2" })).toBe("main");
  });

  it("proves current ownership without compatibility fallback", () => {
    expect(leaderResponseProvenCurrentOwnerThreadKey({})).toBeNull();
    expect(leaderResponseProvenCurrentOwnerThreadKey({ threadKey: "main" })).toBe("main");
    expect(leaderResponseProvenCurrentOwnerThreadKey({ threadKey: "q-1", questId: "q-2" })).toBeNull();
    expect(
      leaderResponseProvenCurrentOwnerThreadKey({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 20 }],
      }),
    ).toBe("q-2");
    expect(
      leaderResponseProvenCurrentOwnerThreadKey({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-2", questId: "q-3", source: "explicit", attachedAt: 20 }],
      }),
    ).toBeNull();
  });

  it("requires strict owner evidence for automatic answer-route repair", () => {
    expect(leaderResponseStableOwnerThreadKeyForRepair({})).toBeNull();
    expect(leaderResponseStableOwnerThreadKeyForRepair({ threadKey: "main" })).toBe("main");
    expect(leaderResponseStableOwnerThreadKeyForRepair({ threadKey: "q-1", questId: "q-2" })).toBeNull();
    expect(
      leaderResponseStableOwnerThreadKeyForRepair({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 20 }],
      }),
    ).toBeNull();
    expect(
      leaderResponseStableOwnerThreadKeyForRepair({
        threadKey: "q-2",
        questId: "q-2",
        threadRefs: [
          { threadKey: "q-2", questId: "q-2", source: "explicit", attachedAt: 10 },
          { threadKey: "q-3", questId: "q-3", source: "backfill", attachedAt: 20 },
        ],
      }),
    ).toBe("q-2");
    expect(
      leaderResponseStableOwnerThreadKeyForRepair({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-2", questId: "q-3", source: "explicit", attachedAt: 20 }],
      }),
    ).toBeNull();
  });

  it("accepts only exact answer-source routes and fails malformed Main or quest metadata closed", () => {
    expect(leaderResponseExactAnswerThreadKey({ threadKey: "main" })).toBe("main");
    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" }],
      }),
    ).toBe("main");
    expect(leaderResponseExactAnswerThreadKey({ threadKey: "main", questId: "q-1" })).toBeNull();
    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "main",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "explicit" }],
      }),
    ).toBeNull();

    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "q-1",
        questId: "q-1",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "explicit" }],
      }),
    ).toBe("q-1");
    expect(leaderResponseExactAnswerThreadKey({ threadKey: "q-1", questId: "q-1" })).toBeNull();
    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "q-1",
        questId: "q-2",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "explicit" }],
      }),
    ).toBeNull();
    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "q-1",
        questId: "q-1",
        threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" }],
      }),
    ).toBeNull();
    expect(
      leaderResponseExactAnswerThreadKey({
        threadKey: "q-1",
        questId: "q-1",
        threadRefs: [{ threadKey: "q-2", questId: "q-3", source: "explicit" }],
      }),
    ).toBeNull();
  });
});
