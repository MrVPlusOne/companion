// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { useAnnotationSourceNavigation } from "./use-annotation-source-navigation.js";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), navigate: vi.fn() }));
vi.mock("../api/session-message-search.js", async (original) => ({
  ...(await original<typeof import("../api/session-message-search.js")>()),
  resolveSessionMessageTarget: mocks.resolve,
}));
vi.mock("../utils/routing.js", async (original) => ({
  ...(await original<typeof import("../utils/routing.js")>()),
  navigateToSessionMessageId: (...args: unknown[]) => mocks.navigate(...args),
}));
const annotation = {
  id: "comment",
  sourceMessageId: "source",
  selectedText: "Repeated words",
  comment: "A saved comment",
};
function Harness({ loaded = true, thread = "main" }: { loaded?: boolean; thread?: string }) {
  const open = useAnnotationSourceNavigation("session", thread);
  return (
    <div data-feed-session-id="session" data-feed-thread-key={thread}>
      {loaded && (
        <div data-message-id="source">
          <p data-chat-selection-scope="true">Repeated words</p>
        </div>
      )}
      <button onClick={() => void open(annotation)}>Open comment</button>
    </div>
  );
}
beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.navigate.mockReset();
  useStore.setState({
    annotationEditor: null,
    annotationHover: null,
    scrollToMessageId: new Map(),
    expandAllInTurn: new Map(),
    composerDrafts: new Map([["session", { text: "Draft", images: [], annotations: [annotation] }]]),
  });
});
afterEach(cleanup);
it("uses bounded-feed navigation before opening beside an already mounted source", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("Open comment"));
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(useStore.getState().scrollToMessageId.get("session")).toBe("source");
  expect(useStore.getState().annotationEditor?.navigateToSource).toBe(true);
  // MessageFeed clears this only after its target request/scroll finishes.
  act(() => useStore.getState().clearScrollToMessage("session"));
  expect(useStore.getState().annotationEditor).toMatchObject({
    annotation,
    navigateToSource: false,
    sourceUnavailable: false,
  });
});
it("uses the server-owned thread for a source outside the loaded window", async () => {
  mocks.resolve.mockResolvedValue({ messageId: "source", threadKey: "other" });
  mocks.navigate.mockImplementation(() => useStore.getState().requestScrollToMessage("session", "source"));
  const view = render(<Harness loaded={false} />);
  fireEvent.click(screen.getByText("Open comment"));
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith("session", "source", {
      threadKey: "other",
      preserveMainThreadRoute: true,
    }),
  );
  expect(useStore.getState().annotationEditor?.threadKey).toBe("other");
  view.rerender(<Harness loaded thread="other" />);
  act(() => useStore.getState().clearScrollToMessage("session"));
  expect(useStore.getState().annotationEditor?.navigateToSource).toBe(false);
});
it("keeps the comment editable when the source is unavailable", async () => {
  mocks.resolve.mockResolvedValue(null);
  render(<Harness loaded={false} />);
  fireEvent.click(screen.getByText("Open comment"));
  await waitFor(() => expect(useStore.getState().annotationEditor?.sourceUnavailable).toBe(true));
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it.each(["navigation", "removal"])("ignores a late source lookup after %s", async (action) => {
  let complete!: (value: { messageId: string; threadKey: string }) => void;
  mocks.resolve.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const view = render(<Harness loaded={false} />);
  fireEvent.click(screen.getByText("Open comment"));
  if (action === "navigation") view.rerender(<Harness loaded={false} thread="other" />);
  else act(() => useStore.getState().clearComposerDraft("session"));
  await act(async () => complete({ messageId: "source", threadKey: "main" }));
  expect(useStore.getState().annotationEditor).toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
});
