import { beforeEach, describe, expect, it, vi } from "vitest";
import { getQuest } from "../server/quest-store.js";
import { runCommitLinksCommand } from "./quest-commit-links.js";
import { classifyQuestCommand, questCommandPositionals } from "../shared/quest-command-classification.js";
import {
  deliveryFixture,
  laterDeliveryFixture,
  FIRST_DELIVERY_SHA,
} from "../src/test-fixtures/commit-delivery-fixture.js";

vi.mock("../server/quest-store.js", () => ({ getQuest: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(getQuest).mockResolvedValue({
    commitShas: deliveryFixture.commits.map((item) => item.sha),
    codeDeliveries: [deliveryFixture, laterDeliveryFixture],
  } as never);
});

describe("exact commit-link authoring", () => {
  it("authors only an explicit delivery/subset and omits retained ranges and paths from JSON", async () => {
    await runCommitLinksCommand({
      questId: "q-9904",
      deliveryId: deliveryFixture.id,
      commitShas: [FIRST_DELIVERY_SHA],
      json: true,
    });
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(output.commits).toHaveLength(1);
    expect(output.commits[0].markdown).toContain(
      `quest:q-9904:delivery:${deliveryFixture.id}:commit:${FIRST_DELIVERY_SHA}`,
    );
    expect(JSON.stringify(output)).not.toContain("refs/takode");
    expect(JSON.stringify(output)).not.toContain("/fixture/repo");
    expect(output.commits[0].additions).toBe(1234567);
  });

  it("fails closed for an unrelated commit or invented delivery ID", async () => {
    await expect(
      runCommitLinksCommand({
        questId: "q-9904",
        deliveryId: deliveryFixture.id,
        commitShas: ["9".repeat(40)],
        json: false,
      }),
    ).rejects.toThrow("member");
    await expect(runCommitLinksCommand({ questId: "q-9904", deliveryId: "9".repeat(32), json: false })).rejects.toThrow(
      "not found",
    );
  });

  it("classifies authoring as read-only and keeps delivery flag values out of positional arguments", () => {
    const args = ["commit-links", "q-9904", "--delivery", deliveryFixture.id, "--commits", FIRST_DELIVERY_SHA];
    expect(classifyQuestCommand(args)).toEqual({ kind: "read" });
    expect(questCommandPositionals(args)).toEqual(["q-9904"]);
  });
  it("introduces only the chosen later batch while earlier links and complete quest evidence remain available", async () => {
    // Reporting a later batch must not expand to the accumulated quest commit list.
    const all = [...deliveryFixture.commits, ...laterDeliveryFixture.commits].map((item) => item.sha);
    vi.mocked(getQuest).mockResolvedValue({
      commitShas: all,
      codeDeliveries: [deliveryFixture, laterDeliveryFixture],
    } as never);
    await runCommitLinksCommand({ questId: "q-9904", deliveryId: laterDeliveryFixture.id, json: false });
    const lines = vi.mocked(console.log).mock.calls.map((call) => call[0]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Delivered in this batch:");
    expect(lines[1]).toContain(laterDeliveryFixture.commits[0]!.sha);
    expect(lines[1]).not.toContain(FIRST_DELIVERY_SHA);
    vi.mocked(console.log).mockClear();
    await runCommitLinksCommand({ questId: "q-9904", deliveryId: deliveryFixture.id, json: true });
    const original = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(original.commits[0].sha).toBe(FIRST_DELIVERY_SHA);
    expect(original.commits[0].comparison).toBe("Vs first parent (merge)");
    expect(all).toHaveLength(3);
  });
});
