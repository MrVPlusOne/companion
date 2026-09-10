// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store.js";
import { PlaygroundThreadContinuationSection } from "./PlaygroundThreadContinuationSection.js";

vi.mock("../../api.js", () => ({ api: { getQuestValidated: vi.fn().mockResolvedValue({ status: "not-modified" }) } }));
vi.mock("../../ws.js", () => ({ sendToSession: vi.fn(() => false) }));
beforeEach(() => {
  useStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("temporary continuation Playground", () => {
  it.each(["main", "q-42"])("clears and replaces the %s notice while retaining navigation and All audit", (source) => {
    // The fixture uses the real route-switch and bounded-window producers, then
    // the ordinary feed projection and renderer. UI selection never edits history.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    render(<PlaygroundThreadContinuationSection />);
    fireEvent.change(screen.getByRole("combobox", { name: "Continuation source" }), { target: { value: source } });
    const feed = within(screen.getByTestId("continuation-feed"));
    const departure = feed.getByTestId("thread-transition-marker");
    expect(departure.textContent).toBe("Work continued from current thread to thread:q-43");
    const firstId = departure.getAttribute("data-message-id");
    fireEvent.click(within(departure).getByRole("button", { name: "thread:q-43" }));
    expect(screen.getByText("Viewing thread:q-43")).toBeTruthy();
    expect(feed.queryByTestId("thread-transition-marker")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source thread" }));
    expect(feed.getByTestId("thread-transition-marker").getAttribute("data-message-id")).toBe(firstId);

    fireEvent.click(screen.getByRole("button", { name: "Work returned" }));
    expect(feed.queryByTestId("thread-transition-marker")).toBeNull();
    expect(feed.getByText("Back in this thread: the list checks passed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All Threads" }));
    expect(feed.getAllByTestId("thread-transition-marker").length).toBeGreaterThanOrEqual(3);
    expect(feed.getByText("Checking the detail view, pass 1.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Work left again" }));
    fireEvent.click(screen.getByRole("button", { name: "Source thread" }));
    expect(feed.getAllByTestId("thread-transition-marker")).toHaveLength(1);
    expect(feed.getByTestId("thread-transition-marker").getAttribute("data-message-id")).not.toBe(firstId);
    const toggle = feed.getByRole("button", { name: /Hide turn activity/ });
    fireEvent.click(toggle);
    fireEvent.click(feed.getByRole("button", { name: /Show turn activity/ }));
    expect(feed.getAllByTestId("thread-transition-marker")).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
