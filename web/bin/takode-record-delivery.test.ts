import { beforeEach, expect, it, vi } from "vitest";
import { handleRecordDelivery } from "./takode-record-delivery.js";
import { apiPost } from "./takode-core.js";
import { projectQuestDelivery } from "../shared/quest-delivery.js";
import { deliveryFixture, FIRST_DELIVERY_SHA } from "../src/test-fixtures/commit-delivery-fixture.js";

vi.mock("./takode-core.js", async (original) => ({
  ...(await original<typeof import("./takode-core.js")>()),
  apiPost: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

it("uses real flag validation to submit an exact preparation and emits only compact delivery evidence", async () => {
  vi.mocked(apiPost).mockResolvedValue({
    questId: "q-9904",
    delivery: projectQuestDelivery("q-9904", deliveryFixture),
    injectedSystemPrompt: "not default output".repeat(5000),
  });
  await handleRecordDelivery("http://fixture", [
    "q-9904",
    "--commits",
    FIRST_DELIVERY_SHA,
    "--preparation",
    deliveryFixture.id,
    "--work-note",
    "4",
    "--json",
  ]);
  expect(apiPost).toHaveBeenCalledWith("http://fixture", "/takode/board/record-work-delivery", {
    questId: "q-9904",
    commitShas: [FIRST_DELIVERY_SHA],
    preparationId: deliveryFixture.id,
    workFeedbackIndex: 4,
  });
  const result = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
  expect(result.deliveryId).toBe(deliveryFixture.id);
  expect(result).not.toHaveProperty("injectedSystemPrompt");
  expect(JSON.stringify(result)).not.toContain("refs/takode");
});
