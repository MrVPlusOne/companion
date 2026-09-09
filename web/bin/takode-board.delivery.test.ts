import { expect, it, vi } from "vitest";
import { handleBoard } from "./takode-board.js";
import { apiPost } from "./takode-core.js";
import { deliveryFixture } from "../src/test-fixtures/commit-delivery-fixture.js";
import { projectQuestDelivery } from "../shared/quest-delivery.js";

vi.mock("./takode-core.js", async (original) => ({
  ...(await original<typeof import("./takode-core.js")>()),
  apiPost: vi.fn(),
}));

it("forwards the preparation and returns a compact delivery hint at the guarded CLI handoff", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const delivery = { ...deliveryFixture, commits: [deliveryFixture.commits[0]!] };
  vi.mocked(apiPost).mockResolvedValue({
    ok: true,
    questId: "q-9904",
    previousState: "WORKING",
    newState: "MEMORY",
    workFeedbackIndex: 4,
    board: [],
    delivery: projectQuestDelivery("q-9904", delivery),
  });
  await handleBoard("http://fixture", [
    "work-to-memory",
    "q-9904",
    "--commits",
    delivery.commits[0]!.sha,
    "--preparation",
    delivery.id,
    "--work-note",
    "4",
    "--json",
  ]);
  expect(apiPost).toHaveBeenCalledWith(
    "http://fixture",
    "/takode/board/work-to-memory",
    expect.objectContaining({ preparationId: delivery.id }),
  );
  expect(JSON.parse(log.mock.calls[0]![0] as string).delivery).toEqual({
    id: delivery.id,
    commitShas: [delivery.commits[0]!.sha],
  });
  log.mockRestore();
});
