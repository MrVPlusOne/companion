import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleBoard } from "./takode-board.js";
import { handleRecordDelivery } from "./takode-record-delivery.js";
import { handleDeliveryTarget } from "./takode-delivery-target.js";
import { apiGet, apiPost } from "./takode-core.js";
import { deliveryFixture } from "../src/test-fixtures/commit-delivery-fixture.js";
import { projectQuestDelivery } from "../shared/quest-delivery.js";

vi.mock("./takode-core.js", async (original) => ({
  ...(await original<typeof import("./takode-core.js")>()),
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  err: (message: string) => {
    throw new Error(message);
  },
}));
let root: string;
const id = "c".repeat(32);
const sha = deliveryFixture.commits[0]!.sha;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "delivery-target-cli-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("routes the leader command, reads exact target JSON and emits only operational approval metadata", async () => {
  // A bulky backend field must not leak through compact JSON, even on an uncommon command.
  const target = {
    checkoutPath: "/fixture/source",
    remote: "origin",
    repositoryUrl: "https://example.com/repo.git",
    refs: [{ ref: "refs/heads/user/change", sha }],
  };
  const path = join(root, "target.json");
  writeFileSync(path, JSON.stringify(target));
  vi.mocked(apiPost).mockResolvedValue({
    approvalId: id,
    refCount: 1,
    injectedSystemPrompt: "hidden".repeat(10000),
    target,
  });
  await handleBoard("http://fixture", ["approve-delivery-target", "q-1", "--target-file", path, "--json"]);
  expect(apiPost).toHaveBeenCalledWith("http://fixture", "/takode/board/approve-delivery-target", {
    questId: "q-1",
    target,
  });
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
    questId: "q-1",
    approvalId: id,
    refCount: 1,
  });
});

it("keeps list output compact and reveals persisted target detail only by explicit ID", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    approvals: [
      {
        id,
        approvedAt: 1,
        phaseOccurrenceId: "work-occurrence",
        refCount: 3,
        target: { checkoutPath: "/hidden/source" },
        injectedSystemPrompt: "hidden".repeat(10000),
      },
    ],
  });
  await handleDeliveryTarget("http://fixture", "delivery-targets", ["q-1", "--json"]);
  const compact = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
  expect(compact.approvals[0]).toEqual({ id, approvedAt: 1, phaseOccurrenceId: "work-occurrence", refCount: 3 });
  vi.mocked(apiGet).mockResolvedValue({ approval: { id, target: { checkoutPath: "/explicit/source" } } });
  await handleDeliveryTarget("http://fixture", "delivery-targets", ["q-1", "--target", id, "--json"]);
  expect(apiGet).toHaveBeenLastCalledWith("http://fixture", `/takode/board/delivery-targets/q-1/${id}`);
  expect(JSON.parse(vi.mocked(console.log).mock.calls[1]![0] as string).approval.target.checkoutPath).toBe(
    "/explicit/source",
  );
});

it.each([
  "record-work-delivery",
  "work-to-memory",
])("passes target authority through %s without a raw override", async (action) => {
  vi.mocked(apiPost).mockResolvedValue({
    questId: "q-1",
    board: [],
    newState: "MEMORY",
    workFeedbackIndex: 0,
    delivery: projectQuestDelivery("q-1", deliveryFixture),
  });
  await handleBoard("http://fixture", [action, "q-1", "--commits", sha, "--delivery-target", id, "--json"]);
  expect(apiPost).toHaveBeenCalledWith(
    "http://fixture",
    `/takode/board/${action}`,
    expect.objectContaining({ deliveryTargetId: id, commitShas: [sha] }),
  );
});

it.each(["--preparation", "--no-code"])("rejects incompatible %s before a request", async (flag) => {
  const extra = flag === "--preparation" ? [flag, id] : [flag];
  await expect(
    handleBoard("http://fixture", ["work-to-memory", "q-1", "--commits", sha, "--delivery-target", id, ...extra]),
  ).rejects.toThrow("cannot combine");
  expect(apiPost).not.toHaveBeenCalled();
});

it("rejects malformed IDs and raw target flags before a request", async () => {
  await expect(
    handleRecordDelivery("http://fixture", ["q-1", "--commits", sha, "--delivery-target", "bad"]),
  ).rejects.toThrow("exact leader-approved");
  await expect(
    handleRecordDelivery("http://fixture", ["q-1", "--commits", sha, "--target-file", "bad"]),
  ).rejects.toThrow();
  expect(apiPost).not.toHaveBeenCalled();
});
