// @vitest-environment jsdom
import { Hono } from "hono";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent.js";
import { registerQuestDeliveryRoutes } from "../../server/routes/quest-deliveries.js";
import { getQuest } from "../../server/quest-store.js";
import { readCommitPatch, readCommitSummary } from "../../server/git-commit-reader.js";
import { verifyReview } from "../../server/port-tracking.js";
import { deliveryCommitHref } from "../../shared/quest-delivery.js";
import { deliveryFixture, FIRST_DELIVERY_SHA, REVIEW_FIXTURE_SHA } from "../test-fixtures/commit-delivery-fixture.js";

vi.mock("../../server/quest-store.js", () => ({ getQuest: vi.fn() }));
vi.mock("../../server/git-commit-reader.js", () => ({ readCommitSummary: vi.fn(), readCommitPatch: vi.fn() }));
vi.mock("../../server/port-tracking.js", () => ({ verifyReview: vi.fn() }));
vi.mock("./DiffViewer.js", () => ({
  DiffViewer: ({ unifiedDiff }: { unifiedDiff: string }) => <pre data-testid="wired-diff">{unifiedDiff}</pre>,
}));

const requests: Array<{ path: string; method: string }> = [];

beforeEach(() => {
  vi.resetAllMocks();
  requests.length = 0;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  vi.mocked(getQuest).mockResolvedValue({
    commitShas: deliveryFixture.commits.map((commit) => commit.sha),
    codeDeliveries: [deliveryFixture],
  } as never);
  vi.mocked(readCommitPatch).mockResolvedValue({ diff: "verified original patch\n", truncated: false });
  vi.mocked(readCommitSummary).mockResolvedValue({
    ...deliveryFixture.commits[0]!,
    sha: REVIEW_FIXTURE_SHA,
    message: "Retained original",
  });
  vi.mocked(verifyReview).mockResolvedValue(undefined);
  const app = new Hono();
  registerQuestDeliveryRoutes(app);
  // Exercise the real frontend URL builder against the real Hono lookup routes, without a live server or user data.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.replace(/^\/api/, "");
      requests.push({ path, method: init?.method ?? "GET" });
      return app.request(path, init);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders exact Markdown delivery links through the real API/viewer path while literal source stays literal", async () => {
  const href = deliveryCommitHref("q-9904", deliveryFixture.id, FIRST_DELIVERY_SHA);
  const link = `[Delivered change](${href})`;
  const { container } = render(<MarkdownContent text={`${link}\n\n\`${link}\``} questLinkSurface="chat-feed" />);
  const trigger = await screen.findByRole("button", { name: /1234567 additions/ });
  expect(container.querySelector("code")?.textContent).toBe(link);
  expect(requests.some((request) => request.path.includes("/commits/"))).toBe(false);
  fireEvent.click(trigger);
  expect(await screen.findByTestId("wired-diff")).toHaveTextContent("verified original patch");
  await waitFor(() =>
    expect(requests).toContainEqual({
      path: `/quests/q-9904/deliveries/${deliveryFixture.id}/commits/${FIRST_DELIVERY_SHA}?review=false&includeDiff=true`,
      method: "GET",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review history" }));
  expect(await screen.findByText("Retained original")).toBeVisible();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
