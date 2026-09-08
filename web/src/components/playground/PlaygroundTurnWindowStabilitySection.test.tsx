// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api.js";
import { useStore } from "../../store.js";
import { PlaygroundTurnWindowStabilitySection } from "./PlaygroundTurnWindowStabilitySection.js";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PlaygroundTurnWindowStabilitySection", () => {
  it("keeps actual collapse controls stable across fixture windows without backend requests", async () => {
    // Exercise the real MessageFeed and store against producer-built windows,
    // and ensure this visible fixture never creates or queries a live session.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const originalSearch = api.searchSessionMessages;
    useStore
      .getState()
      .setMessages("unrelated-existing-session", [
        { id: "existing-message", role: "user", content: "Keep existing state.", timestamp: 1 },
      ]);
    const view = render(<PlaygroundTurnWindowStabilitySection />);
    const fixture = within(screen.getByTestId("playground-turn-window-stability"));

    fireEvent.click(await fixture.findByRole("button", { name: "Collapse turn" }));
    for (const label of ["Older window", "Newer window", "Complete turn", "Latest window"]) {
      fireEvent.click(fixture.getByRole("button", { name: label }));
      expect(fixture.getByRole("button", { name: /^Expand turn/ })).toHaveAttribute("aria-expanded", "false");
      expect(fixture.queryByRole("button", { name: "Collapse turn" })).not.toBeInTheDocument();
    }

    fireEvent.click(fixture.getByRole("button", { name: /^Expand turn/ }));
    expect(fixture.getByRole("button", { name: "Collapse turn" })).toHaveAttribute("aria-expanded", "true");
    expect(fixture.getByText(/Audit update 12:/)).toBeVisible();
    view.unmount();

    expect(api.searchSessionMessages).toBe(originalSearch);
    expect(useStore.getState().sessions.has("playground-turn-window-stability")).toBe(false);
    expect(useStore.getState().messages.get("unrelated-existing-session")?.[0]?.id).toBe("existing-message");
    expect(fetch).not.toHaveBeenCalled();
    useStore.getState().removeSession("unrelated-existing-session");
  });
});
