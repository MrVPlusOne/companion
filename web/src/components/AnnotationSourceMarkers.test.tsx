// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { AnnotationAttachments, AnnotationSourceMarkers } from "./AnnotationAttachments.js";
import { SelectionContextMenu } from "./SelectionContextMenu.js";

const comments = [
  { id: "first", selectedText: "First passage", comment: "First feedback", sourceMessageId: "source" },
  { id: "second", selectedText: "Second passage", comment: "Second feedback", sourceMessageId: "source" },
];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 10, 200, 150));
  if (!Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, writable: true, value: () => [] });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    return [new DOMRect(110, this.toString().startsWith("First") ? 20 : 80, 90, 18)] as unknown as DOMRectList;
  });
  useStore.setState({
    annotationHover: null,
    annotationEditor: null,
    composerDrafts: new Map([["session", { text: "Draft", images: [], annotations: comments }]]),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Fixture() {
  const root = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={root} data-message-id="source" className="relative">
        <div data-chat-selection-scope="true">
          <p>
            <a href="#target">First passage</a>
          </p>
          <p>Second passage</p>
        </div>
        <AnnotationSourceMarkers sessionId="session" messageId="source" contentRef={root} />
      </div>
      <AnnotationAttachments
        annotations={useStore.getState().composerDrafts.get("session")!.annotations!}
        sessionId="session"
      />
    </>
  );
}

describe("comment passage previews", () => {
  it("places a low chip's preview above it so the preview does not cover its own trigger", () => {
    // Large drafts can place chips close to the viewport bottom; users must still be able to click them.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "SUMMARY"
        ? new DOMRect(100, window.innerHeight - 60, 120, 30)
        : new DOMRect(100, 10, 200, 150);
    });
    render(<Fixture />);
    fireEvent.pointerEnter(screen.getByLabelText("Comment 1"));
    expect(screen.getByRole("tooltip").style.bottom).toBe("68px");
    expect(screen.getByRole("tooltip").style.top).toBe("");
  });

  it("highlights from either a chip or a floating marker without replacing Markdown or native selection", () => {
    render(<Fixture />);
    const link = screen.getByRole("link");
    const scope = link.closest("[data-chat-selection-scope]")!;
    const originalMarkup = scope.innerHTML;
    const selection = document.createRange();
    selection.selectNodeContents(link);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(selection);
    fireEvent.pointerEnter(screen.getByLabelText("Comment 1"));
    expect(screen.getByRole("tooltip").textContent).toContain("First feedback");
    expect(screen.getByTestId("annotation-passage-highlight").style.top).toBe("10px");
    expect(scope.innerHTML).toBe(originalMarkup);
    expect(screen.getByRole("link")).toBe(link);
    expect(window.getSelection()!.toString()).toBe("First passage");
    fireEvent.pointerLeave(screen.getByLabelText("Comment 1"));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByTestId("annotation-passage-highlight")).toBeNull();
    act(() => screen.getByLabelText("Edit comment 2").focus());
    expect(screen.getByRole("tooltip").textContent).toContain("Second feedback");
    expect(screen.getByTestId("annotation-passage-highlight").style.top).toBe("70px");
    fireEvent.click(screen.getByLabelText("Edit comment 2"));
    expect(useStore.getState().annotationEditor?.annotation.id).toBe("second");
    expect(useStore.getState().annotationHover).toBeNull();
    // Editor ownership survives pointer exit even on touch, where hover does not exist.
    fireEvent.pointerLeave(screen.getByLabelText("Edit comment 2"));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByTestId("annotation-passage-highlight").style.top).toBe("70px");
    act(() => useStore.getState().setAnnotationEditor(null));
    expect(screen.queryByTestId("annotation-passage-highlight")).toBeNull();
  });

  it("keeps marker placement tied to passage order when comments were created in reverse order", () => {
    useStore.setState({
      composerDrafts: new Map([["session", { text: "", images: [], annotations: [...comments].reverse() }]]),
    });
    render(<Fixture />);
    expect(screen.getByLabelText("Edit comment 1").style.top).toBe("70px");
    expect(screen.getByLabelText("Edit comment 2").style.top).toBe("10px");
  });

  it("keeps an unavailable quotation inspectable without highlighting another passage", () => {
    useStore.setState({
      composerDrafts: new Map([
        ["session", { text: "", images: [], annotations: [{ ...comments[0], selectedText: "Not loaded" }] }],
      ]),
    });
    const view = render(<Fixture />);
    fireEvent.pointerEnter(screen.getByLabelText("Edit comment 1"));
    expect(screen.getByRole("tooltip").textContent).toContain("Not loaded");
    expect(screen.queryByTestId("annotation-passage-highlight")).toBeNull();
    view.unmount();
    expect(useStore.getState().annotationHover).toBeNull();
  });

  it("offers Comment and Copy without Quote selected, retaining the selected occurrence", () => {
    // Exercise the actual selection action rather than a direct test-only editor setter.
    const view = render(<Fixture />);
    const range = document.createRange();
    range.selectNodeContents(screen.getByRole("link"));
    render(
      <SelectionContextMenu
        sessionId="session"
        onClose={vi.fn()}
        selection={{
          isActive: true,
          plainText: "First passage",
          range,
          position: { x: 20, y: 30 },
          clear: vi.fn(),
          dismiss: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Quote selected" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(useStore.getState().annotationEditor?.annotation).toMatchObject({
      selectedText: "First passage",
      sourceMessageId: "source",
      sourceAnchor: { scopeIndex: 0, start: 0, end: 13, text: "First passage" },
    });
    view.unmount();
  });
});
