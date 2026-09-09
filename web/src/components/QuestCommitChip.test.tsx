// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestCommitChip } from "./QuestCommitChip.js";
import {
  deliveryFixture,
  laterDeliveryFixture,
  createDeliveryFixtureClient,
  DELIVERY_FIXTURE_QUEST,
  FIRST_DELIVERY_SHA,
  SECOND_DELIVERY_SHA,
  REVIEW_FIXTURE_SHA,
} from "../test-fixtures/commit-delivery-fixture.js";

vi.mock("./DiffViewer.js", () => ({
  DiffViewer: ({ unifiedDiff }: { unifiedDiff: string }) => <pre data-testid="delivery-diff">{unifiedDiff}</pre>,
}));

beforeEach(() => {
  // jsdom has no native modal implementation; browser validation separately covers native dialog/focus behavior.
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fixed delivery commit chips", () => {
  it("loads newly inserted chips without depending on another scroll or a visibility callback", async () => {
    // A mounted visible chip must settle even when the browser delays IntersectionObserver delivery.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const client = createDeliveryFixtureClient();
    const view = render(<div />);
    view.rerender(
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={laterDeliveryFixture.id}
        sha={laterDeliveryFixture.commits[0]!.sha}
        client={client}
      >
        Later fix
      </QuestCommitChip>,
    );
    expect(await screen.findByRole("button", { name: /16 additions, 5 deletions/ })).toBeVisible();
  });

  it("keeps full stats/title accessible, loads no patches before click, and opens the exact selected commit", async () => {
    const client = createDeliveryFixtureClient();
    const load = vi.spyOn(client, "commit");
    render(
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={deliveryFixture.id}
        sha={FIRST_DELIVERY_SHA}
        client={client}
      >
        Original label
      </QuestCommitChip>,
    );
    const trigger = await screen.findByRole("button", { name: /1234567 additions, 246 deletions/ });
    expect(trigger).toHaveAttribute("title", expect.stringContaining(deliveryFixture.commits[0]!.message));
    expect(screen.getByTestId("commit-chip-stats")).toHaveTextContent("+1.2M−246");
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(DELIVERY_FIXTURE_QUEST, deliveryFixture.id, FIRST_DELIVERY_SHA, false, true),
    );
    expect(load.mock.calls[0]![2]).toBe(FIRST_DELIVERY_SHA);
    expect(await screen.findByTestId("delivery-diff")).toHaveTextContent("shared()");
  });

  it("opens retained incremental review using the same viewer and returns to the delivered commit", async () => {
    const client = createDeliveryFixtureClient();
    const load = vi.spyOn(client, "commit");
    render(
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={deliveryFixture.id}
        sha={FIRST_DELIVERY_SHA}
        client={client}
      >
        Commit
      </QuestCommitChip>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open commit/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Review history" }));
    expect(await screen.findByText("Original review increment")).toBeVisible();
    expect(load).toHaveBeenCalledWith(DELIVERY_FIXTURE_QUEST, deliveryFixture.id, REVIEW_FIXTURE_SHA, true, true);
    expect(screen.getByText("Review commit")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to delivered commit" }));
    expect(await screen.findByText("Delivered commit")).toBeVisible();
  });

  it("preserves earlier link identity after a later delivery and handles an empty/binary patch as loaded", async () => {
    const client = createDeliveryFixtureClient();
    const load = vi.spyOn(client, "commit");
    const old = (
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={deliveryFixture.id}
        sha={SECOND_DELIVERY_SHA}
        client={client}
      >
        Binary commit
      </QuestCommitChip>
    );
    const view = render(old);
    await screen.findByText("1 binary");
    view.rerender(
      <>
        {old}
        <QuestCommitChip
          questId={DELIVERY_FIXTURE_QUEST}
          deliveryId={laterDeliveryFixture.id}
          sha={laterDeliveryFixture.commits[0]!.sha}
          client={client}
        >
          Later
        </QuestCommitChip>
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open commit Update the loading illustration/ }));
    expect(await screen.findByTestId("delivery-diff")).toBeEmptyDOMElement();
    expect(screen.queryByText("Loading commit diff...")).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(DELIVERY_FIXTURE_QUEST, deliveryFixture.id, SECOND_DELIVERY_SHA, false, true);
    expect(load.mock.calls.every((call) => call[1] === deliveryFixture.id)).toBe(true);
  });

  it("preserves a saved summary and reports an unavailable diff without falling back to another commit", async () => {
    const client = createDeliveryFixtureClient(true);
    render(
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={deliveryFixture.id}
        sha={SECOND_DELIVERY_SHA}
        client={client}
      >
        Commit
      </QuestCommitChip>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open commit/ }));
    expect(await screen.findByText("Commit not available")).toBeVisible();
    expect(screen.queryByTestId("delivery-diff")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close commit modal" }));
    expect(screen.getByRole("button", { name: /Open commit/ })).toHaveFocus();
  });

  it("rejects a mismatched summary rather than choosing the delivery's first commit", async () => {
    const client = createDeliveryFixtureClient();
    render(
      <QuestCommitChip
        questId={DELIVERY_FIXTURE_QUEST}
        deliveryId={deliveryFixture.id}
        sha={"9".repeat(40)}
        client={client}
      >
        Unknown commit
      </QuestCommitChip>,
    );
    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
