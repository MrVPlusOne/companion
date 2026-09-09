// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlaygroundOriginalThreadSection } from "./PlaygroundOriginalThreadSection.js";

describe("original-thread Playground fixture", () => {
  it("renders one source through server-built windows when switching original, destination, and All views", () => {
    // Exercise the real bubble so the existing gray origin badge cannot drift
    // while the server window and browser projection retain the original row.
    render(<PlaygroundOriginalThreadSection />);
    const fixture = screen.getByTestId("playground-original-thread-visibility");
    const expectOneSource = () =>
      expect(fixture.querySelectorAll('[data-source-id="original-request"]')).toHaveLength(1);
    expectOneSource();
    fireEvent.click(within(fixture).getByRole("button", { name: "Destination thread" }));
    expectOneSource();
    expect(within(fixture).getByTestId("thread-source-badge").textContent).toBe("[thread:main]");
    fireEvent.click(within(fixture).getByRole("button", { name: "Original thread" }));
    expectOneSource();
    fireEvent.click(within(fixture).getByRole("button", { name: "Quest attachment" }));
    expectOneSource();
    fireEvent.click(within(fixture).getByRole("button", { name: "Destination thread" }));
    expectOneSource();
    expect(within(fixture).getByTestId("thread-source-badge").textContent).toBe("[thread:q-41]");
    fireEvent.click(within(fixture).getByRole("button", { name: "All Threads" }));
    expectOneSource();
  });
});
