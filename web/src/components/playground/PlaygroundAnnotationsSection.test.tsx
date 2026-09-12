// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlaygroundAnnotationsSection } from "./PlaygroundAnnotationsSection.js";
import { useStore } from "../../store.js";

beforeEach(() => {
  useStore.getState().reset();
  Element.prototype.scrollIntoView = vi.fn();
  // The fixture owns source-marker measurement; jsdom supplies no ResizeObserver implementation.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it("demonstrates an input-only draft with preserved multiline text and hidden attachments", () => {
  // This fixture uses the same expansion boundary and sizing hook as the assembled composer.
  render(<PlaygroundAnnotationsSection />);
  const input = screen.getByLabelText("Annotation main message") as HTMLTextAreaElement;
  const original = input.value;
  expect(original.split("\n")).toHaveLength(2);
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("img", { name: "Example attached image" })).toBeNull();
  act(() => input.focus());
  const image = screen.getByRole("img", { name: "Example attached image" });
  fireEvent.click(screen.getByLabelText("Minimize composer"));
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.value).toBe(original);
  expect(image.closest("[hidden]")).toBeTruthy();
  act(() => input.focus());
  expect(screen.getByRole("img", { name: "Example attached image" })).toBe(image);
  fireEvent.pointerDown(screen.getByRole("heading", { name: "Conversation annotations" }));
  expect(input.getAttribute("aria-expanded")).toBe("false");
});
