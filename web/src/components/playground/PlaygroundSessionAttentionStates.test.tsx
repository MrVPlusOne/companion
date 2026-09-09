// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { syncedProjectionEntryId } from "../../../shared/synced-projection.js";
import { SESSION_ATTENTION_PROJECTION } from "../../../shared/session-attention-projection.js";
import { useStore } from "../../store.js";
import { PlaygroundSessionAttentionStates } from "./PlaygroundSessionAttentionStates.js";
import { PlaygroundSectionGroup } from "./shared.js";

const button = (slug: string) =>
  document.querySelector(`button[data-session-id="playground-projected-${slug}"]`) as HTMLElement;
const row = (slug: string) => within(button(slug).parentElement as HTMLElement);

beforeEach(() => useStore.getState().reset());

function renderStates() {
  return render(
    <PlaygroundSectionGroup groupId="overview">
      <PlaygroundSessionAttentionStates />
    </PlaygroundSectionGroup>,
  );
}

describe("PlaygroundSessionAttentionStates", () => {
  it("renders the current-build projection matrix and precedence", async () => {
    renderStates();
    await waitFor(() =>
      expect(
        useStore
          .getState()
          .syncedProjectionKeys.has(
            syncedProjectionEntryId(SESSION_ATTENTION_PROJECTION, "playground-projected-needs-input"),
          ),
      ).toBe(true),
    );

    expect(row("timer").getByTestId("session-status-timer-icon")).toHaveAttribute("data-count", "1");
    expect(row("needs-input").getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "action");
    expect(row("needs-input").queryByTestId("session-status-timer-icon")).toBeNull();
    // A prompt is amber attention, not an unread result; keep the status idle.
    expect(row("needs-input").getByTestId("session-status-dot")).toHaveAttribute("data-status", "idle");
    expect(row("leader-checkpoint").getByTestId("session-attention-marker")).toHaveAttribute(
      "data-attention",
      "action",
    );
    expect(row("leader-checkpoint").getByRole("button", { name: /Open .* profile/ })).toHaveAttribute(
      "data-status",
      "idle",
    );
    expect(row("review").getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
    expect(row("muted").getByTestId("session-notification-marker")).toHaveAttribute(
      "data-urgency",
      "muted-needs-input",
    );
    expect(row("cleared").getByTestId("session-status-dot")).toHaveAttribute("data-status", "idle");
    expect(row("cleared").queryByTestId("session-attention-marker")).toBeNull();
    expect(row("permission").getByTestId("session-status-dot")).toHaveAttribute("data-status", "permission");
    expect(row("permission").queryByTestId("session-attention-marker")).toBeNull();
    expect(row("error").getByTestId("session-status-dot")).toHaveAttribute("data-status", "completed_unread");
    expect(screen.getByTestId("status-count-waiting")).toHaveTextContent("1");
    expect(row("cleared").getByTestId("session-reviewer-badge")).toHaveAttribute(
      "data-reviewer-status",
      "completed_unread",
    );
  });

  it("uses the same accepted projection for hover count copy", async () => {
    renderStates();
    await waitFor(() => expect(row("review").getByTestId("session-attention-marker")).toBeInTheDocument());
    fireEvent.mouseEnter(button("review"));
    expect(await screen.findByTestId("session-hover-attention-status")).toHaveTextContent("3 unread conversations");
  });
});
