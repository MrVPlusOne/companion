import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;
let questStore: typeof import("./quest-store.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (value: string) => {
      dir = value;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.get() };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quest-work-commit-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  questStore = await import("./quest-store.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function liveStorePath(): string {
  return join(tempDir, ".companion", "questmaster-live", "store.json");
}

function writeLiveStoreFixture(store: unknown): void {
  mkdirSync(join(tempDir, ".companion", "questmaster-live"), { recursive: true });
  writeFileSync(liveStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

describe("appendQuestCodeCommitEvidenceForOwner", () => {
  it("appends normalized code commits for the exact active owner without replacing earlier evidence", async () => {
    await questStore.createQuest({ title: "Attach Work commits" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");
    await questStore.completeQuest("q-1", [], { commitShas: ["abc1234", "deadbeef"] });
    await questStore.transitionQuest("q-1", { status: "in_progress", sessionId: "sess-1" });

    const updated = await questStore.appendQuestCodeCommitEvidenceForOwner(
      "q-1",
      { kind: "takode", sessionId: "sess-1" },
      ["DEADBEEF", "cafebabe", "CAFEBABE"],
    );

    expect(updated?.status).toBe("in_progress");
    expect(updated?.commitShas).toEqual(["abc1234", "deadbeef", "cafebabe"]);
    expect((await questStore.getQuest("q-1"))?.commitShas).toEqual(["abc1234", "deadbeef", "cafebabe"]);
  });

  it("rejects non-owners and quests that are no longer in progress", async () => {
    await questStore.createQuest({ title: "Guard Work commits" });
    await questStore.transitionQuest("q-1", { status: "refined", description: "Ready" });
    await questStore.claimQuest("q-1", "sess-1");

    await expect(
      questStore.appendQuestCodeCommitEvidenceForOwner("q-1", { kind: "takode", sessionId: "sess-2" }, ["abc1234"]),
    ).rejects.toThrow("exact active quest owner");

    await questStore.completeQuest("q-1", []);
    await expect(
      questStore.appendQuestCodeCommitEvidenceForOwner("q-1", { kind: "takode", sessionId: "sess-1" }, ["abc1234"]),
    ).rejects.toThrow("in-progress quest");
  });

  it("keeps provider identity in the exact-owner check", async () => {
    await questStore.createQuest({ title: "Provider boundary", description: "Ready", status: "refined" });
    await questStore.claimQuest("q-1", "shared-id", { ownerKind: "codex" });

    await expect(
      questStore.appendQuestCodeCommitEvidenceForOwner("q-1", { kind: "takode", sessionId: "shared-id" }, ["abc1234"]),
    ).rejects.toThrow("exact active quest owner");
  });

  it("atomically appends Work commit evidence in the live store", async () => {
    writeLiveStoreFixture({
      format: "mutable_current_record",
      version: 1,
      nextQuestNumber: 2,
      updatedAt: 0,
      quests: [
        {
          id: "q-1",
          questId: "q-1",
          version: 3,
          title: "Active Work",
          status: "in_progress",
          description: "Ready",
          sessionId: "worker-1",
          claimedAt: 200,
          createdAt: 100,
          statusChangedAt: 200,
          commitShas: ["abc1234"],
        },
      ],
    });

    const updated = await questStore.appendQuestCodeCommitEvidenceForOwner(
      "q-1",
      { kind: "takode", sessionId: "worker-1" },
      ["ABC1234", "deadbeef"],
    );

    expect(updated?.commitShas).toEqual(["abc1234", "deadbeef"]);
    const persisted = JSON.parse(readFileSync(liveStorePath(), "utf-8"));
    expect(persisted.quests[0].commitShas).toEqual(["abc1234", "deadbeef"]);
  });
  it("persists fixed delivery provenance through quest normalization and completion", async () => {
    // The isolated store must keep the descriptor together with its code SHAs and separate memory evidence.
    const { deliveryFixture } = await import("../src/test-fixtures/commit-delivery-fixture.js");
    await questStore.createQuest({ title: "Retain delivery", description: "Ready", status: "refined" });
    await questStore.claimQuest("q-1", "fixture-worker");
    const shas = deliveryFixture.commits.map((commit) => commit.sha);
    await questStore.appendQuestCodeCommitEvidenceForOwner(
      "q-1",
      { kind: "takode", sessionId: "fixture-worker" },
      shas,
      deliveryFixture,
    );
    await questStore.completeQuest("q-1", [], { memoryCommitShas: ["deadbeef"] });
    const stored = await questStore.getQuest("q-1");
    expect(stored?.codeDeliveries).toEqual([deliveryFixture]);
    expect(stored?.commitShas).toEqual(shas);
    expect(stored?.memoryCommitShas).toEqual(["deadbeef"]);
  });
});
