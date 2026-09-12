// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useContext, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerMinimizer, ComposerMinimizeButton, ComposerVisibilityContext } from "./ComposerMinimizer.js";
import { useComposerNavigationFocus } from "./use-composer-navigation-focus.js";
import { useComposerTextareaSize } from "./use-composer-textarea-size.js";
import { useStore } from "../store.js";

beforeEach(() => useStore.setState({ focusComposerTrigger: 0 }));
afterEach(cleanup);

function Draft({ unmounted = () => {}, portal = false }: { unmounted?: () => void; portal?: boolean }) {
  const expanded = useContext(ComposerVisibilityContext);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("First line\nSecond line");
  useEffect(() => unmounted, [unmounted]);
  useComposerTextareaSize(ref, text);
  useComposerNavigationFocus({ textareaRef: ref, sessionId: "session", threadKey: "main", usesTouchKeyboard: false });
  return (
    <>
      <textarea
        ref={ref}
        aria-label="Draft"
        aria-expanded={expanded}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div hidden={!expanded}>
        <img src="/fixture.png" alt="Attached image" />
        <button>Comment 1</button>
        <span data-testid="internal-label">Menu label</span>
      </div>
      {portal && createPortal(<button>Attachment preview</button>, document.body)}
    </>
  );
}

function Fixture({
  destination = "session:main",
  reveal = false,
  unmounted,
  portal = false,
}: {
  destination?: string;
  reveal?: boolean;
  unmounted?: () => void;
  portal?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button>Outside</button>
      <ComposerMinimizer destination={destination} expanded={expanded || reveal} onExpandedChange={setExpanded}>
        <Draft unmounted={unmounted} portal={portal} />
        <div hidden={!expanded && !reveal}>
          <ComposerMinimizeButton onClick={() => setExpanded(false)} disabled={reveal} />
        </div>
      </ComposerMinimizer>
    </>
  );
}

const isCollapsed = () => screen.getByTestId("composer-minimizer").getAttribute("data-collapsed") === "true";
const focusDraft = () => act(() => screen.getByRole("textbox").focus());

describe("composer minimization", () => {
  it("keeps the same full draft, image, and comments mounted behind an input-only compact view", () => {
    // Visibility changes must not dispose pending uploads or truncate the draft's later lines.
    const unmounted = vi.fn();
    render(<Fixture unmounted={unmounted} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(isCollapsed()).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
    focusDraft();
    const image = screen.getByRole("img");
    fireEvent.change(textarea, { target: { value: "Unsaved first line\nUnsaved second line" } });
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    expect(isCollapsed()).toBe(true);
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(textarea.value).toBe("Unsaved first line\nUnsaved second line");
    expect(textarea.style.height).toBe("24px");
    expect(screen.queryByRole("button", { name: "Comment 1" })).toBeNull();
    expect(unmounted).not.toHaveBeenCalled();
    focusDraft();
    expect(screen.getByRole("img")).toBe(image);
    expect(document.activeElement).toBe(textarea);
  });

  it("honors only fresh focus requests and keeps active voice/editor work revealed", () => {
    // Historical counters are not active requests; resetting them must not focus an idle input.
    useStore.setState({ focusComposerTrigger: 3 });
    const view = render(<Fixture />);
    act(() => useStore.setState({ focusComposerTrigger: 0 }));
    expect(isCollapsed()).toBe(true);
    act(() => useStore.getState().focusComposer());
    expect(isCollapsed()).toBe(false);
    expect(screen.getByRole("textbox")).toBe(document.activeElement);
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    view.rerender(<Fixture reveal />);
    expect(isCollapsed()).toBe(false);
    expect((screen.getByLabelText("Minimize composer") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not revive old destination or blur requests after a fresh expansion", async () => {
    // A destination round trip starts compact unless an intentional focus actually survives it.
    const view = render(<Fixture destination="one:main" />);
    focusDraft();
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    view.rerender(<Fixture destination="two:main" />);
    expect(isCollapsed()).toBe(true);
    view.rerender(<Fixture destination="one:main" />);
    focusDraft();
    await act(async () => {});
    expect(isCollapsed()).toBe(false);
  });

  it("stays expanded across internal buttons, non-focusable labels, and attachment portals", async () => {
    // Pointer focus loss on non-focusable content is internal interaction, not an outside click.
    render(<Fixture portal />);
    focusDraft();
    act(() => screen.getByRole("button", { name: "Comment 1" }).focus());
    expect(isCollapsed()).toBe(false);
    fireEvent.pointerDown(screen.getByTestId("internal-label"));
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.pointerUp(screen.getByTestId("internal-label"));
    await act(async () => {});
    expect(isCollapsed()).toBe(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Attachment preview" }));
    expect(isCollapsed()).toBe(false);
  });

  it("collapses populated drafts on outside pointers and keyboard focus departure", async () => {
    // Both non-focusable conversation clicks and Tab navigation out of the complete composer count.
    render(<Fixture />);
    focusDraft();
    fireEvent.pointerDown(document.body);
    expect(isCollapsed()).toBe(true);
    focusDraft();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    await act(async () => {});
    expect(isCollapsed()).toBe(true);
  });

  it("cancels deferred blur when focus returns before it settles", async () => {
    // No stale callback may close a composer explicitly reopened in the same event turn.
    render(<Fixture />);
    focusDraft();
    act(() => screen.getByRole("textbox").blur());
    focusDraft();
    await act(async () => {});
    expect(isCollapsed()).toBe(false);
  });
});
