// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerMinimizer } from "./ComposerMinimizer.js";
import { useStore } from "../store.js";

beforeEach(() => useStore.setState({ focusComposerTrigger: 0 }));
afterEach(cleanup);

describe("explicit composer minimization", () => {
  it("hides all draft content from view and accessibility while retaining the same mounted text, image, and comments", () => {
    // Keeping the child mounted is essential for pending uploads and unsaved local editor state.
    const unmounted = vi.fn();
    function Draft() {
      useEffect(() => unmounted, []);
      return (
        <>
          <textarea aria-label="Draft" defaultValue="A long draft" />
          <img src="/fixture.png" alt="Attached image" />
          <button>Comment 1</button>
        </>
      );
    }
    render(
      <ComposerMinimizer destination="session:main">
        <Draft />
      </ComposerMinimizer>,
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Unsaved edit" } });
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "Comment 1" })).toBeNull();
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Restore composer"));
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect((textarea as HTMLTextAreaElement).value).toBe("Unsaved edit");
    expect(screen.getByRole("img").getAttribute("src")).toBe("/fixture.png");
    expect(document.activeElement).toBe(textarea);
  });

  it("responds to a new explicit focus request but not a counter reset, and reveals active voice/editor work", () => {
    const restore = vi.fn();
    useStore.setState({ focusComposerTrigger: 3 });
    const view = render(
      <ComposerMinimizer destination="session:main" onRestore={restore}>
        <textarea aria-label="Draft" />
      </ComposerMinimizer>,
    );
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    act(() => useStore.setState({ focusComposerTrigger: 0 }));
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => useStore.getState().focusComposer());
    expect(screen.getByRole("textbox")).toBe(document.activeElement);
    expect(restore).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    view.rerender(
      <ComposerMinimizer destination="session:main" reveal>
        <textarea aria-label="Draft" />
      </ComposerMinimizer>,
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect((screen.getByLabelText("Minimize composer") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not apply one destination's minimized state to another session or thread", () => {
    const view = render(
      <ComposerMinimizer destination="one:main">
        <textarea aria-label="Draft" />
      </ComposerMinimizer>,
    );
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    view.rerender(
      <ComposerMinimizer destination="two:main">
        <textarea aria-label="Draft" />
      </ComposerMinimizer>,
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
