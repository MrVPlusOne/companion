// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble.js";
import { useStore } from "../store.js";
import type { ChatMessage } from "../types.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 100));
  if (!Range.prototype.getClientRects)
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, writable: true, value: () => [] });
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(10, 20, 100, 18)] as unknown as DOMRectList);
  useStore.setState({
    annotationEditor: null,
    annotationHover: null,
    composerDrafts: new Map([
      [
        "session",
        {
          text: "",
          images: [],
          annotations: [
            { id: "note", sourceMessageId: "source", selectedText: "Selected passage.", comment: "Please clarify." },
          ],
        },
      ],
    ]),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])("renders passage markers for assistant text with structured blocks=%s", (structured) => {
  // Assistant content commonly arrives as blocks. Both real MessageBubble projection branches must expose annotations.
  const message: ChatMessage = {
    id: "source",
    role: "assistant",
    content: "Selected passage.",
    timestamp: 1,
    ...(structured ? { contentBlocks: [{ type: "text" as const, text: "Selected passage." }] } : {}),
  };
  render(
    <div data-message-id="source" data-message-role="assistant">
      <MessageBubble message={message} sessionId="session" />
    </div>,
  );
  fireEvent.pointerEnter(screen.getByLabelText("Edit comment 1"));
  expect(screen.getByRole("tooltip").textContent).toContain("Please clarify.");
  expect(screen.getByTestId("annotation-passage-highlight")).toBeTruthy();
});
