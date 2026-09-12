import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerQuestDeliveryRoutes } from "./quest-deliveries.js";
import * as store from "../quest-store.js";
import * as reader from "../git-commit-reader.js";
import { verifyReview } from "../port-tracking.js";
import {
  deliveryFixture,
  laterDeliveryFixture,
  FIRST_DELIVERY_SHA,
  REVIEW_FIXTURE_SHA,
} from "../../src/test-fixtures/commit-delivery-fixture.js";

vi.mock("../quest-store.js", () => ({ getQuest: vi.fn() }));
vi.mock("../git-commit-reader.js", () => ({ readCommitDetails: vi.fn() }));
vi.mock("../port-tracking.js", () => ({ verifyReview: vi.fn() }));

let app: Hono;
const prefix = `/quests/q-9904/deliveries/${deliveryFixture.id}`;
const quest = () => ({
  questId: "q-9904",
  commitShas: deliveryFixture.commits.map((item) => item.sha),
  codeDeliveries: [deliveryFixture],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(store.getQuest).mockResolvedValue(quest() as never);
  vi.mocked(reader.readCommitDetails).mockImplementation(async (_repo, sha, includeDiff) => ({
    ...deliveryFixture.commits[0]!,
    sha,
    comparison: deliveryFixture.commits[0]!.comparison!,
    ...(sha === REVIEW_FIXTURE_SHA ? { message: "Original review" } : {}),
    ...(includeDiff ? { diff: "original patch\n", truncated: false } : {}),
  }));
  vi.mocked(verifyReview).mockResolvedValue(undefined);
  app = new Hono();
  registerQuestDeliveryRoutes(app);
});

describe("recorded delivery lookup", () => {
  it("keeps the compact view stable after later delivery, with no paths, refs, or patch downloads", async () => {
    // Real projection data contains bulky provenance; only explicit detail operations can expose review entries.
    const before = await (await app.request(prefix)).json();
    vi.mocked(store.getQuest).mockResolvedValue({
      ...quest(),
      codeDeliveries: [deliveryFixture, laterDeliveryFixture],
    } as never);
    expect(await (await app.request(prefix)).json()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("/fixture/repo");
    expect(JSON.stringify(before)).not.toContain("refs/takode");
    expect(before.commits[0].additions).toBe(1234567);
    expect(reader.readCommitDetails).not.toHaveBeenCalled();
  });

  it("serves saved summary-only data and selects an exact recorded commit for full diff", async () => {
    expect((await app.request(`${prefix}/commits/${FIRST_DELIVERY_SHA}?includeDiff=false`)).status).toBe(200);
    expect(reader.readCommitDetails).not.toHaveBeenCalled();
    const full = await (await app.request(`${prefix}/commits/${FIRST_DELIVERY_SHA}`)).json();
    expect(full.diff).toBe("original patch\n");
    expect(full).not.toHaveProperty("recordedStats");
    expect(reader.readCommitDetails).toHaveBeenCalledWith("/fixture/repo", FIRST_DELIVERY_SHA, true);
    expect((await app.request(`${prefix}/commits/${laterDeliveryFixture.commits[0]!.sha}`)).status).toBe(404);
  });

  it("scopes original increments to retained review refs and never adds them to delivered evidence", async () => {
    const history = await (await app.request(`${prefix}/review/${FIRST_DELIVERY_SHA}`)).json();
    expect(history.commitShas).toEqual([REVIEW_FIXTURE_SHA]);
    const review = await (
      await app.request(`${prefix}/commits/${REVIEW_FIXTURE_SHA}?review=true&includeDiff=false`)
    ).json();
    expect(review.message).toBe("Original review");
    expect(verifyReview).toHaveBeenCalledWith("/fixture/repo", deliveryFixture.commits[0]!.review);
    expect(reader.readCommitDetails).toHaveBeenCalledWith("/fixture/repo", REVIEW_FIXTURE_SHA, false);
    expect((await app.request(`${prefix}/commits/${"9".repeat(40)}?review=true`)).status).toBe(404);
    expect((await app.request(`${prefix}/commits/${REVIEW_FIXTURE_SHA}`)).status).toBe(404);
  });

  it("reports missing retained objects and corrected code evidence without substituting another commit", async () => {
    vi.mocked(verifyReview).mockRejectedValue(new Error("Missing retained ref"));
    expect(await (await app.request(`${prefix}/commits/${REVIEW_FIXTURE_SHA}?review=true`)).json()).toMatchObject({
      available: false,
    });
    vi.mocked(store.getQuest).mockResolvedValue({ ...quest(), commitShas: [] } as never);
    expect((await app.request(`${prefix}/commits/${FIRST_DELIVERY_SHA}`)).status).toBe(404);
    expect(reader.readCommitDetails).not.toHaveBeenCalled();
  });
  it("preserves legacy saved counts while the opened view reports its explicitly matched comparison", async () => {
    // Reading old evidence must not rewrite its stored count/baseline or silently match it to a new patch.
    const legacy = structuredClone(deliveryFixture);
    delete legacy.commits[0]!.comparison;
    vi.mocked(store.getQuest).mockResolvedValue({ ...quest(), codeDeliveries: [legacy] } as never);
    const before = JSON.stringify(legacy);
    vi.mocked(reader.readCommitDetails).mockResolvedValueOnce({
      sha: FIRST_DELIVERY_SHA,
      shortSha: "1111111",
      message: "Fresh comparison",
      timestamp: 1,
      comparison: { method: "first-parent-v1", baseSha: "0".repeat(40), parentCount: 2 },
      additions: 12,
      deletions: 3,
      binaryFiles: 0,
      diff: "fresh patch",
      truncated: false,
    });
    const full = await (await app.request(`${prefix}/commits/${FIRST_DELIVERY_SHA}`)).json();
    expect(full).toMatchObject({
      additions: 12,
      deletions: 3,
      comparison: { parentCount: 2 },
      recordedStats: { additions: 1234567, deletions: 246 },
    });
    expect(full.recordedStats).not.toHaveProperty("comparison");
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
