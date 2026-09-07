// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { api } from "../api.js";
import type { SdkSessionInfo } from "../types.js";
import { CodexInstructionsCollapsible } from "./CodexInstructionsCollapsible.js";

vi.mock("../api.js", () => ({
  api: { getSessionInfo: vi.fn(), getSessionInstructionContent: vi.fn() },
}));

type Snapshot = NonNullable<SdkSessionInfo["codexInstructionSnapshot"]>;
type ContentDetail = Awaited<ReturnType<typeof api.getSessionInstructionContent>>;

const snapshot: Snapshot = {
  threadId: "thread-current",
  capturedAt: 100,
  lifecycle: "thread_resume",
  developerInstructionsConfigured: true,
  instructionSourcesReported: true,
  configLayers: [{ kind: "user", path: "/session-home/config.toml" }],
  instructionSources: [
    {
      kind: "global",
      path: "/session-home/AGENTS.md",
      sourcePath: "/Users/me/.codex/AGENTS.md",
      delivery: "copied_snapshot",
    },
    { kind: "project", path: "/repo/nested/repository/AGENTS.md", delivery: "direct" },
  ],
};

function contentDetail(source: string, content: string | null): ContentDetail {
  return { threadId: snapshot.threadId, capturedAt: snapshot.capturedAt, source, content };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe("Codex instruction source viewer", () => {
  it("opens generated, global, and repository captures through the same explicit detail API", async () => {
    // This mirrors server-produced source ordering and global-copy provenance; no path is sent to the API.
    vi.mocked(api.getSessionInstructionContent).mockImplementation(async (_sessionId, request) =>
      contentDetail(request.source, `Captured ${request.source}\n<script>literal instruction text</script>`),
    );
    render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);

    expect(screen.getAllByRole("button", { name: "Developer Instructions" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Codex Instructions" })).not.toBeInTheDocument();
    expect(screen.getByText("Takode launch configuration")).toBeInTheDocument();
    expect(screen.getByText("Loaded snapshot:")).toBeInTheDocument();
    expect(api.getSessionInstructionContent).not.toHaveBeenCalled();

    for (const [source, rowName] of [
      ["generated", "Takode-generated instructions"],
      ["0", "Global instructions: /Users/me/.codex/AGENTS.md"],
      ["1", "Repository instructions: /repo/nested/repository/AGENTS.md"],
    ]) {
      const trigger = screen.getByRole("button", { name: rowName });
      fireEvent.click(trigger);
      expect(api.getSessionInstructionContent).toHaveBeenLastCalledWith("selected-session", {
        threadId: "thread-current",
        capturedAt: 100,
        source,
      });
      const dialog = screen.getByRole("dialog");
      expect(
        await within(dialog).findByText(`Captured ${source} <script>literal instruction text</script>`),
      ).toBeInTheDocument();
      expect(dialog.querySelector("script")).toBeNull();
      expect(dialog.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
      expect(within(dialog).getByText("Captured developer instructions · Read-only")).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Close instruction viewer" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
  });

  it("focuses the viewer, contains Tab, and consumes Escape before a parent dismiss handler", async () => {
    // Session Info also listens on document; closing a nested viewer must keep that parent open.
    vi.mocked(api.getSessionInstructionContent).mockResolvedValue(contentDetail("generated", "captured body"));
    const parentDismiss = vi.fn();
    document.addEventListener("keydown", parentDismiss);
    try {
      render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
      const trigger = screen.getByRole("button", { name: "Takode-generated instructions" });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(trigger);
      const close = screen.getByRole("button", { name: "Close instruction viewer" });
      expect(close).toHaveFocus();
      fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
      const body = screen.getByRole("dialog").querySelector("[data-instruction-content]");
      expect(body).toHaveFocus();
      fireEvent.keyDown(body!, { key: "Tab" });
      expect(close).toHaveFocus();
      parentDismiss.mockClear();
      fireEvent.keyDown(close, { key: "Escape" });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(parentDismiss).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
    } finally {
      document.removeEventListener("keydown", parentDismiss);
    }
  });

  it("shows pending, unavailable, and failed captures without fetching current files", async () => {
    // Legacy or unreadable captured sources remain inspectable as unavailable; they never fall back to live content.
    let resolveContent: ((detail: ContentDetail) => void) | undefined;
    vi.mocked(api.getSessionInstructionContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContent = resolve;
        }),
    );
    render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Global instructions: /Users/me/.codex/AGENTS.md" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading captured instructions…");
    await act(async () =>
      resolveContent?.({ ...contentDetail("0", null), unavailableReason: "This source was not captured." }),
    );
    expect(screen.getByText("This source was not captured.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close instruction viewer" }));

    vi.mocked(api.getSessionInstructionContent).mockRejectedValueOnce(new Error("server unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the captured instructions.");
    expect(api.getSessionInstructionContent).toHaveBeenCalledTimes(2);
    expect(api.getSessionInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["session", "different-session", snapshot, ""],
    ["thread", "selected-session", { ...snapshot, threadId: "thread-new" }, ""],
    ["capture", "selected-session", { ...snapshot, capturedAt: 200 }, ""],
    ["launch", "selected-session", snapshot, "new-process"],
  ])("drops pending content when the selected %s changes", async (_label, sessionId, nextSnapshot, refreshKey) => {
    // A response may arrive after navigation/relaunch. The old capture must never appear, including on return.
    let resolveOld: ((detail: ContentDetail) => void) | undefined;
    vi.mocked(api.getSessionInstructionContent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { rerender } = render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<CodexInstructionsCollapsible sessionId={sessionId} snapshot={nextSnapshot} refreshKey={refreshKey} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => resolveOld?.(contentDetail("generated", "stale private capture")));
    expect(screen.queryByText("stale private capture")).not.toBeInTheDocument();
    rerender(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores a closed source response after a different source is opened", async () => {
    let resolveOld: ((detail: ContentDetail) => void) | undefined;
    vi.mocked(api.getSessionInstructionContent)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(contentDetail("1", "repository capture"));
    render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    fireEvent.click(screen.getByRole("button", { name: "Close instruction viewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Repository instructions: /repo/nested/repository/AGENTS.md" }));
    expect(await screen.findByText("repository capture")).toBeInTheDocument();
    await act(async () => resolveOld?.(contentDetail("generated", "late generated capture")));
    expect(screen.queryByText("late generated capture")).not.toBeInTheDocument();
    expect(screen.getByText("repository capture")).toBeInTheDocument();
  });

  it("rejects a detail response for a different capture identity", async () => {
    vi.mocked(api.getSessionInstructionContent).mockResolvedValue({
      ...contentDetail("generated", "wrong capture"),
      capturedAt: 99,
    });
    render(<CodexInstructionsCollapsible sessionId="selected-session" snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("wrong capture")).not.toBeInTheDocument();
  });
});
