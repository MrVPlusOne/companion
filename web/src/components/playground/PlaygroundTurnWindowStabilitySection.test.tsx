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
  it("keeps the local send after the producer refresh advances its history watermark", async () => {
    // The echo must survive authoritative replacement, not merely remain as a
    // live tail on an old window. All delivery stays inside this local fixture.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const socket = vi.spyOn(globalThis, "WebSocket");
    const view = render(<PlaygroundTurnWindowStabilitySection />);
    const fixture = within(screen.getByTestId("playground-turn-window-stability"));
    await fixture.findByRole("button", { name: "Collapse turn" });
    const sessionId = "playground-turn-window-stability";
    const selectedWindow = () => useStore.getState().threadWindows.get(sessionId)!.get("q-1")!;
    const previousHistoryLength = selectedWindow().source_history_length;
    fireEvent.click(fixture.getByRole("button", { name: "90%" }));
    fireEvent.click(fixture.getByRole("button", { name: "Send at latest" }));

    const sentText = "Local follow-up 1: keep this message at the bottom.";
    expect(fixture.getAllByText(sentText)).toHaveLength(1);
    expect(selectedWindow().source_history_length).toBe(previousHistoryLength);
    expect(fixture.getByRole("button", { name: "Send at latest" })).toBeDisabled();
    fireEvent.click(fixture.getByRole("button", { name: "Refresh latest window" }));

    expect(fixture.getAllByText(sentText)).toHaveLength(1);
    expect(selectedWindow().source_history_length).toBe(previousHistoryLength + 1);
    expect(selectedWindow().has_newer_items).toBe(false);
    expect(fixture.queryByRole("button", { name: "Load newer section" })).not.toBeInTheDocument();
    expect(fixture.getByRole("button", { name: "Refresh latest window" })).toBeDisabled();
    expect(useStore.getState().connectionStatus.get(sessionId)).not.toBe("connected");
    view.unmount();

    expect(fetch).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.has(sessionId)).toBe(false);
  });

  it("keeps collapse stable across locally scaled fixture windows without backend requests", async () => {
    // Exercise the real MessageFeed and store against producer-built windows,
    // and ensure this visible fixture never creates or queries a live session.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const originalSearch = api.searchSessionMessages;
    const globalZoom = useStore.getState().zoomLevel;
    const savedZoom = localStorage.getItem("cc-zoom-level");
    useStore
      .getState()
      .setMessages("unrelated-existing-session", [
        { id: "existing-message", role: "user", content: "Keep existing state.", timestamp: 1 },
      ]);
    const view = render(<PlaygroundTurnWindowStabilitySection />);
    const fixture = within(screen.getByTestId("playground-turn-window-stability"));

    fireEvent.click(await fixture.findByRole("button", { name: "Collapse turn" }));
    const feed = fixture.getByTestId("message-feed-scroll-container");
    for (const scale of [0.9, 1, 1.25]) {
      const scaleButton = fixture.getByRole("button", { name: `${scale * 100}%` });
      fireEvent.click(scaleButton);
      expect(scaleButton).toHaveAttribute("aria-pressed", "true");
      // The real feed stays mounted inside a CSS transform. These controls must
      // not change the user's app-wide zoom or replace the collapse state.
      const scaledFeed = fixture.getByTestId("playground-turn-window-scaled-feed");
      expect(scaledFeed).toContainElement(feed);
      expect(scaledFeed).toHaveStyle({ transform: `scale(${scale})`, transformOrigin: "top left" });
      for (const label of ["Older window", "Newer window", "Complete turn", "Latest window"]) {
        fireEvent.click(fixture.getByRole("button", { name: label }));
        expect(fixture.getByRole("button", { name: /^Expand turn/ })).toHaveAttribute("aria-expanded", "false");
        expect(fixture.queryByRole("button", { name: "Collapse turn" })).not.toBeInTheDocument();
      }
    }

    fireEvent.click(fixture.getByRole("button", { name: /^Expand turn/ }));
    expect(fixture.getByRole("button", { name: "Collapse turn" })).toHaveAttribute("aria-expanded", "true");
    expect(fixture.getByText(/Audit update 12:/)).toBeVisible();
    view.unmount();

    expect(api.searchSessionMessages).toBe(originalSearch);
    expect(useStore.getState().sessions.has("playground-turn-window-stability")).toBe(false);
    expect(useStore.getState().messages.get("unrelated-existing-session")?.[0]?.id).toBe("existing-message");
    expect(useStore.getState().zoomLevel).toBe(globalZoom);
    expect(localStorage.getItem("cc-zoom-level")).toBe(savedZoom);
    expect(fetch).not.toHaveBeenCalled();
    useStore.getState().removeSession("unrelated-existing-session");
  });
});
