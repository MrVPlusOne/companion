// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setMeasuredRailWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 24,
        width,
        height: 24,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this);
      }
      disconnect() {}
      unobserve() {}
    },
  );
}

function getWorkBoardBarSection() {
  const section = document.querySelector<HTMLElement>('[data-playground-section-id="interactive-work-board-bar"]');
  if (!section) {
    throw new Error("Work Board Bar Playground section was not rendered");
  }
  return within(section);
}

// Mock markdown renderer used by MessageBubble/PermissionBanner

vi.mock("./ViewportHandoffEntryGate.js", () => ({
  ViewportHandoffThreadEntryGate: ({ children }: any) => children,
  ViewportHandoffSessionEntryGate: ({ children }: any) => children,
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";
import { PlaygroundSideChatStates } from "./playground/SideChatPlaygroundStates.js";
import { PlaygroundReasoningDetailStates } from "./playground/ReasoningDetailStates.js";
import { PlaygroundCodexSubagentStates } from "./playground/CodexSubagentPlaygroundStates.js";
import { PlaygroundChatViewRecoveryStates } from "./playground/ChatViewRecoveryPlaygroundStates.js";
import { PLAYGROUND_RECOVERY_MODEL_DELIVERY_CONTENT } from "./playground/CodexRecoveryPlaygroundMessages.js";
import { PlaygroundDiffViewerSection } from "./playground/DiffViewerPlaygroundSection.js";
import { PLAYGROUND_AUTO_PAUSE_RECOVERY_ENTRY } from "./playground/AutoPausePlaygroundStates.js";
import { MOCK_SESSION_ID, PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID } from "./playground/fixtures.js";
import { PlaygroundUniversalSearchStates } from "./playground/search-sidebar-states.js";
import { PlaygroundOverviewSections } from "./playground/sections-overview.js";
import {
  PlaygroundDelegateTaskPendingLiveActivityGroup,
  PlaygroundDelegateTaskPendingNoHandoffGroup,
  PlaygroundHerdSummaryBar,
  PlaygroundSelectionContextMenu,
} from "./playground/shared.js";
import { usePlaygroundSeed } from "./playground/usePlaygroundSeed.js";
import { useStore } from "../store.js";

function PlaygroundOverviewOnly() {
  usePlaygroundSeed();
  return <PlaygroundOverviewSections />;
}

function PlaygroundRecoveryStatesOnly() {
  usePlaygroundSeed();
  return <PlaygroundChatViewRecoveryStates />;
}

describe("Playground", () => {
  it("contrasts one-message-per-destination Recent browsing with exhaustive scoped Messages hits", async () => {
    // The paired fixture makes the product boundary inspectable without relying on live session history.
    render(<PlaygroundUniversalSearchStates />);

    const recentPreview = within(screen.getByTestId("playground-universal-recent-preview"));
    expect(
      recentPreview.getByText("Recent shows one newest human message for each navigable destination."),
    ).toBeTruthy();
    expect(await recentPreview.findAllByTestId("recent-ask-bundle")).toHaveLength(3);
    expect(recentPreview.getAllByRole("button", { name: /Open newest message in/ })).toHaveLength(3);

    const messagesPreview = within(screen.getByTestId("playground-universal-messages-preview"));
    expect(
      messagesPreview.getByText(
        "Messages keeps every match in the selected scope, including multiple messages from the same destination.",
      ),
    ).toBeTruthy();
    expect(messagesPreview.getByText("Searching in #1277 across tabs")).toBeTruthy();
    expect(messagesPreview.getByRole("button", { name: "Current tab" })).toHaveAttribute("aria-pressed", "false");
    expect(messagesPreview.getByRole("button", { name: "Current tab" })).toBeDisabled();
    expect(messagesPreview.getByRole("button", { name: "Across tabs" })).toHaveAttribute("aria-pressed", "true");
    const messageRows = await messagesPreview.findAllByRole("option");
    expect(messageRows).toHaveLength(3);
    expect(messageRows[0]).toHaveTextContent(
      "Search should return every matching message in scope instead of one result per destination.",
    );
    expect(messageRows[1]).toHaveTextContent("When a search has two matching messages in this tab, keep both results.");
    expect(messageRows.filter((row) => row.textContent?.includes("Thread q-1931"))).toHaveLength(2);
    expect(messageRows[2]).toHaveTextContent("Thread q-1927");
  });

  it("documents collapsed and expanded grouped reasoning-detail states", () => {
    useStore.getState().reset();
    render(<PlaygroundReasoningDetailStates />);

    expect(screen.getByText("Grouped collapsed")).toBeInTheDocument();
    expect(screen.getByText("Grouped expanded")).toBeInTheDocument();
    const groups = screen.getAllByTestId("codex-reasoning-detail-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).not.toHaveAttribute("open");
    expect(groups[1]).toHaveAttribute("open");
    expect(screen.getAllByText("3 summaries")).toHaveLength(2);
    expect(screen.getAllByText("Preparing the final handoff")).toHaveLength(3);
    expect(
      within(groups[1])
        .getAllByTestId("codex-reasoning-expanded-title")
        .map((node) => node.textContent),
    ).toEqual(["Addressing review feedback", "Planning validation coverage", "Preparing the final handoff"]);
  });

  it("documents a root-only main feed with exact child activity retained in the inspector", async () => {
    // This producer-shaped state exercises the real MessageFeed collector and
    // the inspector's independent canonical history path in one Playground fixture.
    useStore.getState().reset();
    render(<PlaygroundCodexSubagentStates />);

    const feed = within(screen.getByTestId("playground-codex-root-only-feed"));
    expect(feed.getByText("Show only the root agent's activity here.")).toBeInTheDocument();
    expect(feed.getByTestId("codex-reasoning-detail-group")).toHaveTextContent("Confirming root-only activity");
    expect(feed.getByText("2 summaries")).toBeInTheDocument();
    expect(feed.getAllByTestId("codex-live-terminal-chip")).toHaveLength(1);
    expect(feed.getByTestId("codex-live-terminal-chip")).toHaveTextContent("tail");
    expect(feed.queryByText("Child-only answer stays in the inspector.")).toBeNull();
    expect(feed.queryByText("Child-only reasoning")).toBeNull();
    expect(feed.queryByText("Checking child result")).toBeNull();
    expect(feed.queryByText("src/child-only.ts")).toBeNull();
    expect(feed.queryByText("child-only tool result")).toBeNull();
    expect(feed.queryByText("Child-only failure stays in the inspector.")).toBeNull();

    fireEvent.click(feed.getByTestId("feed-codex-subagents"));
    const inspector = await screen.findByTestId("codex-subagent-inspector");
    fireEvent.click(within(inspector).getByRole("button", { name: /schema_audit, Working, Transcript available/i }));

    expect(await within(inspector).findByText("Child-only answer stays in the inspector.")).toBeInTheDocument();
    const childReasoning = within(inspector).getByTestId("codex-reasoning-detail-group");
    expect(childReasoning).toHaveTextContent("Checking child result");
    expect(within(inspector).getByText("2 summaries")).toBeInTheDocument();
    fireEvent.click(within(childReasoning).getByTestId("codex-reasoning-group-title"));
    expect(within(childReasoning).getByText("This official summary belongs in the inspector.")).toBeInTheDocument();
    expect(
      within(childReasoning).getByText("The exact child-owned result remains bounded and readable."),
    ).toBeInTheDocument();
    expect(within(inspector).getByText("Child-only failure stays in the inspector.")).toHaveClass("text-cc-error");
    fireEvent.click(within(inspector).getByRole("button", { name: /Show 1 tool call: Read file/i }));
    fireEvent.click(within(inspector).getByRole("button", { name: /Read File.*src\/child-only\.ts/i }));
    expect(within(inspector).getByText("child-only tool result")).toBeInTheDocument();
  });

  it("documents Leader-only inline timing suppression without losing menu time metadata", () => {
    useStore.getState().reset();
    render(<PlaygroundOverviewOnly />);

    const normalTiming = within(screen.getByTestId("playground-normal-inline-timing"));
    expect(normalTiming.getByTestId("message-timestamp")).toHaveTextContent("· 42s");

    const leaderTiming = within(screen.getByTestId("playground-leader-inline-timing"));
    expect(leaderTiming.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    fireEvent.click(leaderTiming.getByRole("button", { name: "Message options" }));
    const leaderMetadata = screen.getByTestId("message-time-assistant-menu-metadata");
    expect(leaderMetadata).toHaveAttribute("role", "note");
    expect(leaderMetadata).toHaveTextContent("Message time");
    expect(within(leaderMetadata).getByRole("time")).toBeInTheDocument();
    expect(leaderMetadata).not.toHaveTextContent("Time unavailable");
    fireEvent.keyDown(document, { key: "Escape" });

    const validMenu = within(screen.getByTestId("playground-valid-message-menu"));
    fireEvent.click(validMenu.getByRole("button", { name: "Message options" }));
    expect(screen.getByTestId("message-time-user-menu-metadata")).not.toHaveTextContent("Time unavailable");
    fireEvent.keyDown(document, { key: "Escape" });

    const unavailableMenu = within(screen.getByTestId("playground-unavailable-message-menu"));
    fireEvent.click(unavailableMenu.getByRole("button", { name: "Message options" }));
    const unavailableMetadata = screen.getByTestId("message-time-user-menu-metadata");
    expect(unavailableMetadata).toHaveTextContent("Message time");
    expect(unavailableMetadata).toHaveTextContent("Time unavailable");
    expect(within(unavailableMetadata).queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    const routedFinalSection = document.getElementById("overview-routed-answers");
    expect(routedFinalSection).toBeTruthy();
    const routedFinalStates = within(routedFinalSection!);
    const withToolsCard = routedFinalStates.getByTestId("playground-unified-footer-with-tools");
    expect(withToolsCard).toHaveClass("min-w-0", "max-w-[430px]", "overflow-hidden");
    const withTools = within(withToolsCard);
    expect(withTools.getByRole("button", { name: "Expand turn · 2 tools" })).toHaveAttribute("aria-expanded", "false");
    const groupedCoverage = withTools.getAllByTestId("thread-response-answer-count");
    expect(groupedCoverage).toHaveLength(2);
    expect(groupedCoverage[0]).toHaveTextContent("Answers 2 messages");
    expect(groupedCoverage[1]).toHaveTextContent("Answers 2 messages");
    expect(withTools.getByText(/detailed accepted-Work answer/)).toBeVisible();
    expect(withTools.getByText(/later answer adds the final mobile result/)).toBeVisible();
    fireEvent.click(groupedCoverage[0]!);
    const coveragePreview = screen.getByRole("dialog", { name: "Referenced user messages" });
    expect(coveragePreview).toHaveTextContent("Please foreground the polished result when this work is ready.");
    expect(coveragePreview).toHaveTextContent("Please include the mobile behavior too.");
    expect(withTools.getByRole("button", { name: "Expand turn · 2 tools" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(groupedCoverage[0]!);
    expect(screen.queryByRole("dialog", { name: "Referenced user messages" })).not.toBeInTheDocument();
    expect(withTools.getAllByRole("button", { name: "Message options" })).toHaveLength(2);

    const withoutToolsCard = routedFinalStates.getByTestId("playground-unified-footer-without-tools");
    expect(withoutToolsCard).toHaveClass("min-w-0", "w-full", "max-w-[320px]", "overflow-hidden");
    const withoutTools = within(withoutToolsCard);
    expect(withoutTools.getByRole("button", { name: "Expand turn" })).toHaveAttribute("aria-expanded", "false");
    expect(withoutTools.getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    expect(withoutTools.getByRole("button", { name: "Message options" })).toBeVisible();
    expect(withoutTools.queryByText(/tools?/i)).not.toBeInTheDocument();

    const associatedMainCard = routedFinalStates.getByTestId("playground-associated-main-answer");
    expect(associatedMainCard).toHaveClass("min-w-0", "w-full", "max-w-[430px]", "overflow-hidden");
    const associatedMain = within(associatedMainCard);
    expect(associatedMain.getByTestId("thread-response-answer-count")).toHaveTextContent("Answers 1 message");
    expect(associatedMain.getByTestId("thread-source-badge")).toHaveTextContent("[thread:main]");
    expect(associatedMain.getByRole("button", { name: "Expand turn · 1 tool" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(associatedMainCard.querySelectorAll('[data-message-id="playground-associated-main-answer"]')).toHaveLength(
      1,
    );

    const expandedCard = routedFinalStates.getByTestId("playground-unified-footer-expanded");
    expect(expandedCard).toHaveClass("min-w-0", "max-w-[430px]");
    const expanded = within(expandedCard);
    expect(expanded.getByRole("button", { name: "Collapse turn" })).toHaveAttribute("aria-expanded", "true");
    const expandedCoverage = expanded.getByTestId("thread-response-answer-count");
    expect(expandedCoverage).toHaveTextContent("Answers 2 messages");
    fireEvent.click(expandedCoverage);
    expect(screen.getByRole("dialog", { name: "Referenced user messages" })).toHaveTextContent(
      "Please include the mobile behavior too.",
    );
    expect(expanded.getByRole("button", { name: "Collapse turn" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(expandedCoverage);
    const expandedCurrent = expanded
      .getByText("The later answer adds the final mobile result without compressing the detailed answer above it.")
      .closest<HTMLElement>("[data-testid='thread-response-current-expanded']")!;
    expect(expandedCurrent).toBeInTheDocument();
    expect(within(expandedCurrent).getByRole("button", { name: "Message options" })).toBeVisible();
    const expandedMessageRow = within(expandedCurrent)
      .getByTestId("markdown")
      .closest<HTMLElement>("[class~='group/msg']")!;
    expect(expandedMessageRow).toBeInTheDocument();
    expect(expandedMessageRow).not.toHaveClass("gap-2", "sm:gap-3");
    expect(expandedMessageRow.children).toHaveLength(1);

    const sharedAnswer = within(routedFinalStates.getByTestId("playground-multi-owner-answer"));
    const sharedCoverage = sharedAnswer.getByTestId("thread-response-answer-count");
    expect(sharedCoverage).toHaveTextContent("Answers 2 messages");
    fireEvent.click(sharedCoverage);
    expect(screen.getByRole("dialog", { name: "Referenced user messages" })).toHaveTextContent(
      "Please handle my Main request.",
    );
    expect(screen.getByRole("dialog", { name: "Referenced user messages" })).toHaveTextContent(
      "Please include this quest's request in the same answer.",
    );
    fireEvent.click(sharedCoverage);
    // The pinned decision fixture reuses both answers but renders its source
    // Quiz only once beside the retained prompt and notification.
    const pinnedDecision = within(routedFinalStates.getByTestId("playground-pinned-quiz-source"));
    expect(pinnedDecision.getAllByTestId("thread-response-answer-count")).toHaveLength(2);
    expect(pinnedDecision.getAllByRole("region", { name: "Quest quiz" })).toHaveLength(1);
    expect(pinnedDecision.getByText("Choose whether the follow-up should remain parked.")).toBeVisible();
    expect(pinnedDecision.getByText("Choose the follow-up boundary")).toBeVisible();
    // Each recurring firing keeps its own report and exact firing reference,
    // even though both previews name the same recurring timer schedule.
    const timerReports = within(routedFinalStates.getByTestId("playground-timer-answer-reports"));
    expect(
      timerReports.getByText("The scheduled build checks passed. The release candidate is ready for its review."),
    ).toBeVisible();
    expect(
      timerReports.getByText("The next scheduled check found one new test failure in the release candidate."),
    ).toBeVisible();
    const timerCoverage = timerReports.getAllByTestId("thread-response-answer-count");
    expect(timerCoverage).toHaveLength(2);
    for (const [index, badge] of timerCoverage.entries()) {
      expect(badge).toHaveTextContent("Answers 1 message");
      fireEvent.click(badge);
      const preview = screen.getByRole("dialog", { name: "Referenced user messages" });
      expect(within(preview).getByText(`timer-m${index + 1}`)).toBeVisible();
      expect(preview).toHaveTextContent("[⏰ Timer t2 reminder] Check build health");
      fireEvent.click(badge);
    }
    expect(routedFinalStates.getAllByTestId("thread-response-answer-count")).toHaveLength(10);
    expect(routedFinalStates.queryByText("Current answer")).not.toBeInTheDocument();
    expect(routedFinalStates.queryByText("Leader activity")).not.toBeInTheDocument();
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Routed Answers" }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(screen.getByRole("heading", { name: "Inline Quest Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show idle state" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Inline Quest Preview" })).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();
    expect(screen.getByText("Leader Session Return Stability")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show activity chip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show thread status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show both status chips" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show needs-input pill" })).toBeTruthy();
    expect(screen.getByTestId("playground-leader-session-return")).toBeTruthy();
    expect(screen.getByText("Shortcut Hints")).toBeTruthy();
    expect(screen.getByText("Timer Messages")).toBeTruthy();
    expect(screen.getByText("Grouped repeated error cards")).toBeTruthy();
    expect(screen.getByText("Same error happened 8 times")).toBeTruthy();
    expect(screen.getByTestId("playground-grouped-repeated-error-feed")).toHaveClass("h-[360px]");

    const repeatedErrorText =
      "Error: stream disconnected before completion: error sending request for url (http://localhost:4000/responses)";
    expect(screen.getAllByText(repeatedErrorText)).toHaveLength(2);
    expect(screen.getByText("Session restored after operator intervention")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();
    expect(screen.getByTestId("playground-mobile-feed-width")).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Streaming text from MessageFeed mock state should also be rendered.
    expect(within(realChat).getByText("I'm updating tests and then I'll run the full suite.")).toBeTruthy();

    expect(within(realChat).getByText("Thread routing reminder")).toBeTruthy();
    expect(within(realChat).getByText("model-only")).toBeTruthy();
    expect(within(realChat).queryByText(/Missing thread marker/)).toBeNull();

    fireEvent.click(within(realChat).getByRole("button", { name: "Expand Thread routing reminder" }));
    expect(within(realChat).getByText(/^\[Thread routing reminder\]/)).toBeTruthy();
  }, 30_000);

  it("documents the live full-block and partial chat selection controls", () => {
    // The fixture mirrors the failing and working screenshots with the real hook
    // and menu, so browser validation can exercise element-boundary selections.
    render(<PlaygroundSelectionContextMenu />);

    expect(screen.getByTestId("playground-full-block-selection")).toBeTruthy();
    expect(screen.getByTestId("playground-full-block-selection-source").textContent).toContain(
      "The leader conflated three visually similar boundaries",
    );
    expect(screen.getByText(/Select the complete paragraph and list/)).toBeTruthy();
    expect(screen.getByTestId("playground-full-block-selection-quote").textContent).toBe(
      "Quoted selection appears here.",
    );
  });

  it("documents inline, display, malformed, wide, and streaming math states", () => {
    // The Playground is the browser-validation fixture for every message-flow
    // Markdown state introduced by the shared math renderer.
    render(<PlaygroundOverviewSections />);

    expect(screen.getByRole("heading", { name: "Markdown Math" })).toBeTruthy();
    expect(screen.getByText("Assistant message — inline and display delimiter compatibility")).toBeTruthy();
    expect(screen.getByText("Wide display math — constrained mobile-width surface")).toBeTruthy();
    expect(screen.getByText("Rendered selection — copy and quote use one source token")).toBeTruthy();
    expect(screen.getByText("Malformed, unsupported, and streaming delimiter states")).toBeTruthy();
    const streamingFixture = screen.getByTestId("playground-streaming-math");
    const incompleteOutput = streamingFixture.textContent;
    expect(streamingFixture).toHaveAttribute("data-stream-complete", "false");

    fireEvent.click(screen.getByRole("button", { name: "Toggle streaming delimiter" }));
    expect(streamingFixture).toHaveAttribute("data-stream-complete", "true");
    expect(streamingFixture.textContent).not.toBe(incompleteOutput);
  });

  it("documents native browser opening and retained alternatives for HTML file links", () => {
    // The shared message-link change must remain directly inspectable in the Playground.
    render(<PlaygroundOverviewSections />);

    expect(screen.getByRole("heading", { name: "File Link Context Menu" })).toBeTruthy();
    expect(screen.getByText("Chat markdown with browser, editor, and image file links")).toBeTruthy();
    expect(screen.getByText(/interactive HTML demo/)).toBeTruthy();
  });

  it("documents multi-file Write blocks whose change diff fields contain raw file content", () => {
    render(<PlaygroundOverviewSections />);

    expect(screen.getByRole("button", { name: /Write File.*2 files/ })).toBeTruthy();
    expect(screen.getByText("full_datagen_inner.sh")).toBeTruthy();
    expect(screen.getByText("launch_tmux_retry.sh")).toBeTruthy();
    expect(document.body).toHaveTextContent("set -uo pipefail");
    expect(document.body).toHaveTextContent("tmux new-session");
  });

  it("documents visible, expanded, and acknowledged-hidden migration notice states", () => {
    // Playground must retain all user-visible states needed by the later desktop/mobile Execute pass.
    render(<PlaygroundOverviewSections />);

    const compactCard = screen.getByText("Compact migration notice").parentElement?.parentElement;
    const expandedCard = screen.getByText("Expanded migration details").parentElement?.parentElement;
    const hiddenCard = screen.getByText("Acknowledged migration hidden").parentElement?.parentElement;
    expect(compactCard).toBeTruthy();
    expect(expandedCard).toBeTruthy();
    expect(hiddenCard).toBeTruthy();
    expect(within(compactCard!).getByRole("status", { name: "Model provenance migration notice" })).toBeTruthy();
    expect(expandedCard?.querySelector("details")).toHaveAttribute("open");
    expect(within(hiddenCard!).queryByRole("status", { name: "Model provenance migration notice" })).toBeNull();
    expect(screen.getByTestId("playground-acknowledged-migration-hidden")).toBeEmptyDOMElement();
  });

  it("documents first-line Side Chat action controls and fallback reason states", () => {
    render(<Playground />);

    expect(screen.getByText("Desktop hover first-line native menu")).toBeTruthy();
    expect(screen.getByText("Keyboard focus first-line menu trigger")).toBeTruthy();
    expect(screen.getByText("Fallback reason and replay stay in menu")).toBeTruthy();
    expect(screen.getByText("Mobile touch first-line menu trigger")).toBeTruthy();
    expect(screen.getAllByText(/tiny action menu trigger sits at the end of the first line/i)).toHaveLength(2);
    expect(screen.getByText(/tiny touch trigger remains in the first line/i)).toBeTruthy();
    expect(screen.getByText(/Native fork unavailable: Codex native fork skipped/)).toBeTruthy();
    expect(screen.getByText("Replay Side Chat")).toBeTruthy();
    expect(screen.getByText("Confirm replay Side Chat")).toBeTruthy();
  });

  it("documents pending delegate trace states in Playground fixtures", () => {
    render(
      <>
        <PlaygroundDelegateTaskPendingNoHandoffGroup />
        <PlaygroundDelegateTaskPendingLiveActivityGroup />
      </>,
    );

    expect(screen.queryByText("Agent starting...")).toBeNull();
    for (const activitiesButton of screen.getAllByText("Activities")) {
      fireEvent.click(activitiesButton);
    }

    expect(
      screen.getByText(
        "Waiting for delegate handoff through end_delegation. No delegate activity has been recorded yet.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Delegate child is stopped or idle without an end_delegation handoff. Takode is keeping the trace inspectable while the parent waits for the bounded no-handoff path.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("I cannot know the exact fork-memory sentinel from inherited context. I used no tools."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open raw delegate transcript: del_waiting123" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open raw delegate transcript: del_live123" })).toBeTruthy();
  });

  it("keeps the missing Side Chat child-message snapshot stable across unrelated store updates", () => {
    // Missing child-session messages are a normal Playground state. The selector
    // fallback must be referentially stable so unrelated fixture updates, such as
    // seeding notification rows, do not trigger React's external-store loop guard.
    useStore.getState().reset();
    render(<PlaygroundSideChatStates />);

    expect(screen.getByText("Open read-only Side Chat panel")).toBeTruthy();

    act(() => {
      useStore.setState({ sessionNotifications: new Map([["unrelated-session", []]]) });
    });

    expect(screen.getByText("Open read-only Side Chat panel")).toBeTruthy();
  });

  it("shows the voice mode selector before the recording label in Playground composer states", () => {
    render(<Playground />);

    expect(screen.queryByLabelText("Current input level")).toBeNull();
    expect(screen.queryByLabelText("Recent input level history")).toBeNull();
    expect(screen.getAllByLabelText("Current and recent input level").length).toBeGreaterThanOrEqual(3);

    const editRow = screen.getByTestId("playground-recording-mode-row-edit");
    const editToggle = within(editRow).getByTestId("playground-recording-mode-toggle-edit");
    const editRecordingLabel = within(editRow).getByText("Recording");
    expect(editToggle.compareDocumentPosition(editRecordingLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(editRow).getByLabelText("Current and recent input level")).toBeTruthy();

    const appendRow = screen.getByTestId("playground-recording-mode-row-append");
    const appendToggle = within(appendRow).getByTestId("playground-recording-mode-toggle-append");
    const appendRecordingLabel = within(appendRow).getByText("Recording");
    expect(appendToggle.compareDocumentPosition(appendRecordingLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(appendRow).getByLabelText("Current and recent input level")).toBeTruthy();
    expect(screen.getByText("Rerun as append")).toBeTruthy();
    expect(screen.getByText("Rerun as voice edit")).toBeTruthy();
    expect(screen.getByText("Rerunning as voice edit...")).toBeTruthy();
    expect(screen.getAllByLabelText("Dismiss alternate voice rerun offer")).toHaveLength(2);
    expect(screen.getAllByTestId("alternate-voice-rerun-offer")).toHaveLength(2);
    // Full Playground rendering is intentionally broad documentation coverage;
    // aggregate jsdom contention can exceed 20s as the fixture catalog grows.
  }, 30_000);

  it("documents Composer backend-native permission selector states", () => {
    render(<Playground />);

    expect(screen.getByText("Claude permission selector menu")).toBeTruthy();
    expect(screen.getByText("Codex permission change confirmation")).toBeTruthy();
    expect(screen.getByTestId("composer-permission-mode-menu")).toHaveTextContent("Delegate");
    expect(screen.getByTestId("composer-permission-mode-menu")).toHaveTextContent("Don't ask");
    expect(screen.getByTestId("composer-permission-mode-popover")).toHaveTextContent(
      "Change permissions to Full access?",
    );
    expect(screen.getByText("Codex model and effort selector")).toBeTruthy();
    expect(screen.getByText("Codex model selector — narrow layout")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Model and effort: 5.6 Sol Ultra" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("composer-model-summary-menu")).toHaveTextContent("Model");
    expect(screen.getByTestId("composer-model-summary-menu")).toHaveTextContent("Effort");
    expect(screen.getByTestId("composer-model-summary-menu")).not.toHaveTextContent("Effective");
    expect(screen.getByTestId("composer-model-summary-menu")).toHaveTextContent("Speed");
    expect(screen.getByTestId("composer-model-summary-menu")).toHaveTextContent("Reset to default");
    expect(screen.getByTestId("composer-reasoning-warning")).toHaveTextContent(
      "Runtime is using High instead of Ultra.",
    );
    // The full Playground is intentionally broad documentation coverage and
    // can exceed the default jsdom budget in the aggregate suite.
  }, 20_000);

  it("documents paused recovery guidance and completed terminal receipts", () => {
    // Message-related lifecycle states must remain inspectable without a live server or backend.
    render(<Playground />);

    expect(screen.getByText("Held inputs — waiting for session recovery")).toBeTruthy();
    expect(screen.getByText("Held inputs — release accepted")).toBeTruthy();
    expect(screen.getByText("Held inputs — checking current message")).toBeTruthy();
    expect(screen.getByText("Held inputs — current message running")).toBeTruthy();
    expect(screen.getByText("Held inputs — choose another model")).toBeTruthy();
    expect(screen.getByText("Held inputs — Copilot sign-in required")).toBeTruthy();
    expect(screen.getByText("Reconnecting (2 of 5)")).toBeTruthy();
    expect(screen.getByText("Retrying message (attempt 4)")).toBeTruthy();
    expect(screen.getAllByText(/Cause: Copilot sign-in failed at/)).toHaveLength(1);
    expect(screen.getAllByText(/Cause: The model connection dropped repeatedly at/)).toHaveLength(4);
    expect(screen.getByText(/Cause: The selected model is not available at/)).toBeTruthy();
    expect(
      screen.getByText(
        "Takode is checking this session with your current message. Held inputs will send if it finishes successfully.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your current message is running. Held automatic inputs will send when it finishes successfully.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("playground-auto-pause-idle-mobile-width").className).toContain("max-w-[320px]");
    expect(screen.getByTestId("playground-auto-pause-releasing-mobile-width").className).toContain("max-w-[320px]");
    expect(screen.getByTestId("playground-auto-pause-mobile-width").className).toContain("max-w-[320px]");
    expect(screen.getByTestId("playground-auto-pause-active-mobile-width").className).toContain("max-w-[320px]");
    expect(screen.getByTestId("playground-auto-pause-action-required-mobile-width").className).toContain(
      "max-w-[320px]",
    );
    for (const stateId of ["idle", "releasing", "testing", "active", "unsupported-model", "failed-held"]) {
      const state = within(screen.getByTestId(`playground-auto-pause-${stateId}`));
      const banner = state.getByTestId("composer-paused-banner");
      expect(banner.className).toContain("border-cc-attention/75");
      expect(banner.className).toContain("bg-cc-attention-bg");
      expect(state.getByTestId("composer-paused-chip").className).toContain("text-cc-attention-strong");
      expect(state.getByTestId("composer-auto-pause-guidance").className).toContain("text-cc-fg");
      expect(state.getByTestId("composer-auto-pause-release")).toBeTruthy();
    }
    const idleRelease = within(screen.getByTestId("playground-auto-pause-idle")).getByTestId(
      "composer-auto-pause-release",
    );
    expect(idleRelease).toHaveTextContent("Release now");
    expect(idleRelease).not.toBeDisabled();
    expect(idleRelease.className).toContain("min-h-8");
    expect(idleRelease.className).toContain("shrink-0");
    expect(idleRelease.parentElement?.className).toContain("flex-wrap");
    const releasing = within(screen.getByTestId("playground-auto-pause-releasing"));
    expect(releasing.getByTestId("composer-auto-pause-release")).toHaveTextContent("Releasing…");
    expect(releasing.getByTestId("composer-auto-pause-release")).toBeDisabled();
    expect(releasing.getByTestId("composer-auto-pause-guidance")).toHaveTextContent(
      "Takode accepted your request and is releasing the held inputs.",
    );
    expect(document.body.textContent).not.toContain("PRIVATE RAW PROVIDER ERROR");
    expect(document.body.textContent).not.toContain("PRIVATE HELD HERD PAYLOAD");
    expect(document.body.textContent).not.toContain("PRIVATE TRUSTED ROUTE LABEL");
    const realChat = within(screen.getByTestId("playground-real-chat-stack"));
    expect(realChat.getByRole("region", { name: "Automatic input recovery summary" })).toBeTruthy();
    expect(realChat.getByText("Herd Events · turn_end")).toBeTruthy();
    expect(realChat.getByText("Herd Events · board_stalled")).toBeTruthy();

    const lifecycleCard = screen.getByText("Lifecycle detail behind count-only grouping").closest(".border");
    expect(lifecycleCard).toBeTruthy();
    const lifecycle = within(lifecycleCard as HTMLElement);
    expect(lifecycle.getByText("4 worker events")).toBeTruthy();
    expect(lifecycle.queryByText(/waiting for decision; Work preserved/)).toBeNull();
    expect(lifecycle.queryByText(/same Work resumed after decision wait/)).toBeNull();
    expect(lifecycle.queryByText(/context compacted; same Work continued/)).toBeNull();
    expect(lifecycle.queryByText(/Work interrupted/)).toBeNull();

    fireEvent.click(lifecycle.getByRole("button", { name: "Show 4 activity items: 4 worker events" }));
    expect(lifecycle.getByText(/waiting for decision; Work preserved/)).toBeTruthy();
    expect(lifecycle.getByText(/same Work resumed after decision wait/)).toBeTruthy();
    expect(lifecycle.getByText(/context compacted; same Work continued/)).toBeTruthy();
    expect(lifecycle.getByText(/Work interrupted/)).toBeTruthy();
  });

  it("documents active Codex recovery progress and the audit-only terminal state", () => {
    // Current recovery progress stays inspectable, while terminal state remains
    // in server/audit authority without recreating the retired attention chip.
    // A queued follow-up remains visible while the session is idle.
    vi.useFakeTimers();
    render(<PlaygroundRecoveryStatesOnly />);
    act(() => vi.advanceTimersByTime(1_000));

    const states = [
      {
        testId: "playground-codex-turn-recovery-recovering",
        label: "Reconnecting interrupted work",
        detail: "reconnecting this session so it can finish the interrupted work",
      },
      {
        testId: "playground-codex-turn-recovery-replay",
        label: "Retrying interrupted input",
        detail: "proved the original input never entered Codex history and is replaying it once",
      },
      {
        testId: "playground-codex-turn-recovery-continuation-pending",
        label: "Interrupted-work check queued",
        detail: "queued one follow-up to inspect prior work before finishing what is missing",
      },
      {
        testId: "playground-codex-turn-recovery-continuation-active",
        label: "Finishing interrupted response",
        detail: "finishing the interrupted response",
      },
    ];

    for (const state of states) {
      const preview = within(screen.getByTestId(state.testId));
      const chip = preview.getByTestId("codex-turn-recovery-chip");
      expect(chip).toHaveTextContent(state.label);
      fireEvent.click(chip);
      const detailId = chip.getAttribute("aria-controls");
      const detail = detailId ? document.getElementById(detailId) : null;
      expect(detail).toHaveTextContent(state.detail);
      expect(detail).toHaveTextContent("Work to check: q-9010");
      fireEvent.click(chip);
    }

    const terminalElement = screen.getByTestId("playground-codex-turn-recovery-action-required");
    const terminal = within(terminalElement);
    expect(useStore.getState().sessionStatus.get(PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID)).toBe("idle");
    expect(terminal.getByText("Pending delivery")).toBeInTheDocument();
    expect(terminal.getByText("Check whether the settings change still needs follow-up.")).toBeInTheDocument();
    expect(terminalElement.querySelector('[data-feed-activity-row="true"]')).toBeNull();
    expect(terminal.queryByTestId("codex-turn-recovery-chip")).toBeNull();
    expect(terminal.queryByTestId("codex-turn-recovery-detail")).toBeNull();
    expect(terminal.queryByRole("button", { name: "Open affected thread" })).toBeNull();
    expect(terminal.queryByRole("button", { name: "Work is complete" })).toBeNull();
    expect(terminal.getByText(/verified the already-completed side effects/)).toBeInTheDocument();

    const recoveryEventChip = terminal.getByRole("button", { name: "Expand Resuming Interrupted Work" });
    expect(recoveryEventChip).toHaveAttribute("aria-expanded", "false");
    expect(terminal.queryByText(/persisted observations; they may be incomplete/)).toBeNull();
    fireEvent.click(recoveryEventChip);
    const recoveryEventDetail = terminal.getByRole("region", { name: "Resuming Interrupted Work details" });
    expect(recoveryEventDetail).toHaveTextContent(/does not by itself prove Codex received or completed/);
    expect(recoveryEventDetail).toHaveTextContent(
      `Message size: ${PLAYGROUND_RECOVERY_MODEL_DELIVERY_CONTENT.length.toLocaleString()} characters`,
    );
    expect(within(recoveryEventDetail).getByTestId("markdown").textContent).toBe(
      PLAYGROUND_RECOVERY_MODEL_DELIVERY_CONTENT,
    );

    const diagnosticChip = terminal.getByRole("button", { name: "Expand Why Automatic Retry Stopped" });
    expect(diagnosticChip).not.toHaveClass("border-cc-attention/55");
    expect(terminal.queryByText(/otherwise no action is required/)).toBeNull();
    fireEvent.click(diagnosticChip);
    const diagnosticDetail = terminal.getByRole("region", { name: "Why Automatic Retry Stopped details" });
    const diagnosticText = within(diagnosticDetail).getByTestId("markdown").textContent ?? "";
    expect(diagnosticText).toContain("Send a new instruction in this thread only if");
    expect(diagnosticText).toContain("otherwise no action is required");
    expect(terminal.queryByText(/Check interrupted work/)).toBeNull();
    expect(terminal.queryByText(/Work is complete/)).toBeNull();
  });

  it("renders real ChatView and MessageFeed recovery fixtures without a socket", () => {
    // Producer-shaped Playground state must remain renderable when there is no
    // authoritative transport. The incomplete readiness static reproduces the
    // isolated Execute environment that previously dereferenced socket.send.
    vi.stubGlobal(
      "WebSocket",
      class DisconnectedPlaygroundWebSocket {
        static OPEN = undefined;
      },
    );

    render(<Playground />);

    const realChatElement = screen.getByTestId("playground-real-chat-stack");
    const realChat = within(realChatElement);
    expect(realChatElement).toBeInTheDocument();
    expect(screen.getByTestId("playground-mobile-feed-width")).toBeInTheDocument();
    expect(realChat.getByRole("region", { name: "Automatic input recovery summary" })).toBeTruthy();
    expect(realChat.getByText("Herd Events · turn_end")).toBeTruthy();
    expect(realChat.getByText("Herd Events · board_stalled")).toBeTruthy();
    const seededRecovery = useStore
      .getState()
      .messages.get(MOCK_SESSION_ID)
      ?.find((message) => message.id === PLAYGROUND_AUTO_PAUSE_RECOVERY_ENTRY.id);
    expect(seededRecovery).toMatchObject({
      id: PLAYGROUND_AUTO_PAUSE_RECOVERY_ENTRY.id,
      metadata: { codexAutoPauseRecoverySummary: PLAYGROUND_AUTO_PAUSE_RECOVERY_ENTRY.recovery },
    });

    const olderSectionButton = realChat.getByRole("button", { name: "Load older section" });
    expect(olderSectionButton).toBeTruthy();
    fireEvent.click(olderSectionButton);

    // Explicit progress invariant: the disconnected action returns, the tree
    // stays mounted without fake loading, and the normalized row remains singular.
    const realChatAfterHistoryElement = screen.getByTestId("playground-real-chat-stack");
    expect(realChatAfterHistoryElement).toBeInTheDocument();
    const realChatAfterHistory = within(realChatAfterHistoryElement);
    expect(realChatAfterHistory.getByTestId("message-feed-overlay")).toBeInTheDocument();
    expect(realChatAfterHistory.queryByText("Loading older section...")).not.toBeInTheDocument();
    expect(realChatAfterHistory.getByRole("button", { name: "Load older section" })).toBeInTheDocument();
    expect(realChatAfterHistory.getAllByTestId("codex-auto-pause-recovery-summary")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "A runtime error occurred" })).not.toBeInTheDocument();

    const questThreadFeed = within(screen.getByTestId("playground-quest-thread-projection"));
    const olderThreadButton = questThreadFeed.getByRole("button", { name: "Load older section" });
    fireEvent.click(olderThreadButton);

    const questThreadAfterActionElement = screen.getByTestId("playground-quest-thread-projection");
    expect(questThreadAfterActionElement).toBeInTheDocument();
    const questThreadAfterAction = within(questThreadAfterActionElement);
    expect(questThreadAfterAction.getByTestId("message-feed-overlay")).toBeInTheDocument();
    expect(questThreadAfterAction.queryByText("Loading older section...")).not.toBeInTheDocument();
    expect(questThreadAfterAction.getByRole("button", { name: "Load older section" })).toBeInTheDocument();

    const realChatAfterThreadAction = within(screen.getByTestId("playground-real-chat-stack"));
    expect(realChatAfterThreadAction.getByTestId("message-feed-overlay")).toBeInTheDocument();
    expect(realChatAfterThreadAction.getAllByTestId("codex-auto-pause-recovery-summary")).toHaveLength(1);
    expect(realChatAfterThreadAction.queryByText("Loading older section...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "A runtime error occurred" })).not.toBeInTheDocument();
  }, 20_000);

  it("documents the mobile user-message navigator in its open touch overlay state", () => {
    render(<Playground />);

    expect(screen.getByText("Mobile touch selector with fixed solid overlay")).toBeTruthy();
    const openTouchSelector = screen
      .getAllByRole("dialog", { name: "User message selector" })
      .find((dialog) => dialog.parentElement === document.body && dialog.className.includes("fixed"));

    expect(openTouchSelector).toBeTruthy();
    expect(openTouchSelector?.className).toContain("bg-cc-card");
  });

  it("documents the labeled New Session modal layout", () => {
    render(<Playground />);

    const modal = screen.getByTestId("playground-new-session-modal-layout");
    expect(within(modal).getByText("Engine")).toBeTruthy();
    expect(within(modal).getByText("Permission mode")).toBeTruthy();
    expect(within(modal).getByText("Codex options")).toBeTruthy();
    expect(within(modal).getByText("Network access")).toBeTruthy();
    expect(within(modal).getByText("Workspace")).toBeTruthy();
    expect(within(modal).getByText("Runtime")).toBeTruthy();
    expect(within(modal).getByText("Model")).toBeTruthy();
    expect(within(modal).getByText("Default (gpt-5.5) ▾")).toBeTruthy();
  });

  it("documents the quest commit diff slot with a flush sticky file header", () => {
    render(<PlaygroundDiffViewerSection />);

    const diffSlot = screen.getByTestId("playground-quest-commit-diff-slot");
    const loadingSlot = screen.getByTestId("playground-quest-commit-loading-slot");
    const diffContent = diffSlot.querySelector(".quest-commit-diff-content");
    expect(diffSlot).toHaveClass("h-64", "min-h-0", "pt-0", "px-4", "pb-4");
    expect(loadingSlot).toHaveClass("h-64", "min-h-0", "pt-0", "px-4", "pb-4");
    expect(within(loadingSlot).getByText("Loading commit diff...")).toBeTruthy();
    expect(diffContent?.firstElementChild).toHaveClass("diff-viewer");
    expect(within(diffSlot).getAllByRole("button", { name: "Collapse file" })).toHaveLength(2);
    const aggregate = screen.getByLabelText("Overall changes: 3 additions, 1 deletions");
    expect(aggregate).toBeTruthy();
    expect(aggregate).not.toHaveTextContent("Overall");
    expect(screen.getByLabelText("Code changes: 2 additions, 1 deletions")).toBeTruthy();
    expect(screen.getByLabelText("Tests changes: 1 additions, 0 deletions")).toBeTruthy();
    expect(screen.getByTestId("playground-quest-commit-diff-stats")).not.toHaveTextContent("Overall");
    const codeOnlyStats = screen.getByTestId("playground-code-only-stats");
    expect(within(codeOnlyStats).getByLabelText("Code changes: 7 additions, 0 deletions")).toBeTruthy();
    expect(within(codeOnlyStats).queryByLabelText(/^Tests changes:/)).toBeNull();
    expect([...diffSlot.querySelectorAll<HTMLElement>(".diff-file-header")].map((header) => header.title)).toEqual([
      "web/server/quest-cli-memory-commit-flags.ts",
      "web/server/quest-cli-memory-commit-flags.test.ts",
    ]);
  });

  it("documents leader thread routing and full Main activity", () => {
    render(<Playground />);

    expect(screen.getByText("Leader Main stream — full activity visible")).toBeTruthy();
    expect(screen.getByText("Leader thread switcher")).toBeTruthy();
    expect(screen.getByText("Checked worker state, inspected the board, and prepared the next dispatch.")).toBeTruthy();
    expect(
      screen.getByText(
        "Approved #70's plan for q-43. It's a clean unification: resize once at store time (1920px max).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/@to\(user\)/)).toBeNull();
  });

  it("documents projected scheduled priority and dismissal parity on desktop and mobile", () => {
    setMeasuredRailWidth(430);
    render(<PlaygroundOverviewOnly />);

    const desktop = within(screen.getByTestId("playground-projected-thread-tabs-desktop"));
    const mobile = within(screen.getByTestId("playground-projected-thread-tabs-mobile"));
    for (const scope of [desktop, mobile]) {
      const rail = scope.getByTestId("thread-tab-rail");
      expect(rail).toHaveAttribute("data-overflow", "more-tabs-list");
      expect(rail).toHaveAttribute("data-hidden-tab-count", "3");
      const visibleTabs = scope.getAllByTestId("thread-tab");
      expect(visibleTabs.map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-9001", "q-9004", "q-9003"]);
      const needsInput = visibleTabs.find((tab) => tab.getAttribute("data-thread-key") === "q-9001")!;
      const completedWaiting = visibleTabs.find((tab) => tab.getAttribute("data-thread-key") === "q-9004")!;
      const reviewUnread = visibleTabs.find((tab) => tab.getAttribute("data-thread-key") === "q-9003")!;
      expect(needsInput).toHaveAttribute("data-needs-input", "true");
      expect(needsInput).toHaveAttribute("data-blue-notification", "true");
      expect(within(needsInput).getByTestId("thread-tab-needs-input-bell")).toBeTruthy();
      expect(within(needsInput).queryByTestId("thread-tab-blue-notification-bell")).toBeNull();
      expect(needsInput).toHaveAttribute("data-closable", "false");
      expect(within(needsInput).queryByTestId("thread-tab-close")).toBeNull();
      expect(within(needsInput).getByTestId("thread-tab-title")).toHaveAttribute(
        "data-title-color",
        "var(--color-cc-phase-thread-tab-title-work, #166534)",
      );
      fireEvent.mouseEnter(needsInput);
      expect(within(needsInput).getByTestId("thread-tab-title")).toHaveAttribute(
        "data-title-color",
        "var(--color-cc-phase-thread-tab-title-work, #166534)",
      );
      expect(completedWaiting).toHaveAttribute("data-closable", "true");
      expect(within(completedWaiting).getByTestId("thread-tab-title")).toHaveAttribute(
        "data-title-color",
        "var(--color-cc-fg)",
      );
      expect(reviewUnread).toHaveAttribute("data-blue-notification", "true");
      expect(reviewUnread).toHaveAttribute("data-closable", "true");
      expect(within(reviewUnread).getByTestId("thread-tab-blue-notification-bell")).toBeTruthy();
      expect(within(reviewUnread).getByRole("button", { name: "Close q-9003" })).toBeTruthy();
      expect(scope.getByTestId("thread-tabs-more-button")).toHaveAttribute("data-has-muted-needs-input", "true");

      fireEvent.click(within(needsInput).getByTestId("thread-tab-select"));
      fireEvent.click(scope.getByTestId("quest-thread-journey-hover-target"));
      const preview = within(screen.getAllByTestId("quest-thread-journey-hover-card").at(-1)!).getByTestId(
        "quest-journey-preview-card",
      );
      expect(preview).toHaveTextContent("3 phases · Total 4m");
      expect(
        within(preview)
          .getAllByTestId("quest-journey-phase-duration")
          .map((node) => node.textContent),
      ).toEqual(["1m", "3m"]);
      expect(preview).not.toHaveTextContent("Duration unavailable");
    }

    fireEvent.click(mobile.getByTestId("thread-tabs-more-button"));
    const moreRows = mobile.getAllByTestId("thread-tabs-more-row");
    expect(moreRows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-9005", "q-9002", "q-9006"]);
    const mutedRow = moreRows[0]!;
    const queuedRow = moreRows[1]!;
    const proposedRow = moreRows[2]!;
    expect(mutedRow).toHaveAttribute("data-muted-needs-input", "true");
    expect(within(mutedRow).getByTestId("thread-tab-muted-needs-input-bell")).toBeTruthy();
    expect(within(mutedRow).getByRole("button", { name: "Close q-9005" })).toBeTruthy();
    expect(within(queuedRow).getByRole("button", { name: "Close q-9002" })).toBeTruthy();
    expect(within(proposedRow).getByRole("button", { name: "Close q-9006" })).toBeTruthy();
  });

  it("documents additive source projection without source attachment markers", () => {
    render(<PlaygroundOverviewOnly />);

    expect(screen.queryByText("Thread opened")).toBeNull();
    expect(
      screen
        .getAllByTestId("attention-ledger-row")
        .some((row) => row.getAttribute("data-attention-type") === "quest_thread_created"),
    ).toBe(false);

    expect(screen.getAllByText("Earlier context attached to the implementation quest.").length).toBeGreaterThan(0);

    const marker = screen.getAllByTestId("thread-system-marker-cluster")[0];
    expect(marker).toHaveTextContent("Work continued from Main to thread:q-9002");
    expect(marker).not.toHaveTextContent("activities in thread:");
    expect(within(marker).queryByText("Jump")).toBeNull();
    expect(within(marker).getByRole("button", { name: "Main" })).toBeTruthy();
    expect(within(marker).getAllByRole("button", { name: "thread:q-9002" }).length).toBeGreaterThan(0);
    fireEvent.click(within(marker).getByRole("button", { name: "Details" }));
    expect(marker).toHaveTextContent("1 message moved to thread:q-9001");
    expect(
      screen.queryByLabelText(
        "Thread Waiting for thread:q-9002: waiting for q-9001 to finish before mobile status chip wrapping can be visually checked on the narrow add-to-home-screen layout",
      ),
    ).toBeNull();
    expect(screen.getByLabelText("Thread Ready for thread:q-9003: dispatch plan is ready")).toBeTruthy();
    const phaseThread = screen.getByTestId("playground-codex-phase-thread");
    const phaseFinal = within(phaseThread).getByText(
      "The dispatch plan is ready with the requested worker assignment.",
    );
    expect(phaseFinal).toBeTruthy();
    expect(
      within(phaseThread).queryByText("Checking the internal worker queue before publishing the dispatch plan."),
    ).toBeNull();
    const phaseTurn = phaseFinal.closest("[data-turn-id]");
    expect(phaseTurn).toBeTruthy();
    const phaseActivityButtons = within(phaseTurn as HTMLElement).getAllByRole("button", { name: /Expand turn/ });
    fireEvent.click(phaseActivityButtons.at(-1)!);
    expect(
      within(phaseThread).getByText("Checking the internal worker queue before publishing the dispatch plan."),
    ).toBeTruthy();
    expect(document.querySelector('[data-message-id="playground-thread-status-batch"]')).toBeNull();
    expect(screen.getAllByText("The initial q-9001 answer is complete and remains in history.").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByLabelText("Thread Ready for thread:q-9001: initial implementation answer complete"),
    ).toBeNull();

    const questProjection = screen.getByTestId("playground-quest-thread-projection");
    expect(questProjection).toHaveTextContent("Work continued from thread:q-9001 to thread:q-9002");
    expect(questProjection).not.toHaveTextContent("Work continued from thread:q-9002 to thread:q-9001");

    const allProjection = screen.getByTestId("playground-all-thread-projection");
    expect(allProjection).toHaveTextContent("Work continued from thread:q-9001 to thread:q-9002");
    expect(allProjection).toHaveTextContent("Work continued from thread:q-9002 to thread:q-9001");

    const mainProjection = screen.getByTestId("playground-main-thread-projection");
    expect(mainProjection).toHaveTextContent("Work continued from Main to thread:q-9002");
    expect(mainProjection).not.toHaveTextContent("Work continued from thread:q-9001 to thread:q-9002");
  });

  it("documents waiting counts in the lightweight herd summary mock", () => {
    // This covers the Playground mock state without rendering the full
    // Playground page, which is intentionally heavy and can make a tiny
    // count-cluster assertion too slow in the full suite.
    render(<PlaygroundHerdSummaryBar isExpanded={false} />);

    expect(screen.getAllByLabelText("1 waiting session with scheduled timer").length).toBeGreaterThan(0);
  });

  it("documents resolved reminder suppression while retaining the needs-input card in Main", () => {
    render(<Playground />);

    const mainProjection = screen.getByTestId("playground-resolved-reminder-main-projection");
    expect(within(mainProjection).queryByText("Historical needs-input reminder")).toBeNull();
    const decisionCard = within(mainProjection).getByTestId("attention-ledger-row");
    expect(decisionCard).toHaveAttribute("data-attention-type", "needs_input");
    expect(decisionCard).toHaveTextContent("Choose the retained implementation scope");
    expect(within(decisionCard).getByRole("button", { name: "Answer" })).toBeTruthy();
  });

  it("documents Journey lifecycle rows as audit-only while banners retain status", () => {
    render(<Playground />);

    const ledger = screen.getByTestId("playground-attention-ledger-records");
    expect(within(ledger).getByTestId("playground-lifecycle-feed-policy")).toHaveTextContent(
      "retained for audit but intentionally omitted from ordinary feeds",
    );
    expect(within(ledger).queryByText("Journey started")).toBeNull();
    expect(within(ledger).queryByText("Journey finished")).toBeNull();
    expect(
      within(ledger)
        .getAllByTestId("attention-ledger-row")
        .some((row) => ["quest_journey_started", "quest_completed_recent"].includes(row.dataset.attentionType ?? "")),
    ).toBe(false);
    const banner = screen.getAllByTestId("quest-thread-banner")[0];
    expect(within(banner).getByTestId("quest-journey-compact-summary")).toHaveTextContent("Work");
  });

  it("documents Work Board Bar tab shrinking, phase legend, and shared quest hover states", async () => {
    setMeasuredRailWidth(392);
    render(<Playground />);

    const workBoardBar = getWorkBoardBarSection();
    fireEvent.click(workBoardBar.getByText("Seed board data"));

    const rail = workBoardBar.getByTestId("thread-tab-rail");
    expect(rail).toHaveAttribute("data-overflow", "more-tabs-list");
    expect(within(rail).queryByText("Tabs")).not.toBeInTheDocument();
    const tabStrip = workBoardBar.getByTestId("thread-tab-strip");
    expect(tabStrip).toHaveAttribute("data-overflow-mode", "more-tabs");
    expect(tabStrip.getAttribute("style") ?? "").toContain("--thread-tab-width: 76px");
    expect(tabStrip).toHaveClass("overflow-visible");
    const moreButton = workBoardBar.getByTestId("thread-tabs-more-button");
    expect(moreButton).toHaveAttribute("data-hidden-count", "3");
    expect(workBoardBar.getByText("Resolve VSCode QA Stack Conflicts")).toBeInTheDocument();
    expect(workBoardBar.getByTestId("workboard-main-banner")).toBeTruthy();
    expect(
      rail.compareDocumentPosition(workBoardBar.getByTestId("workboard-main-banner")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(workBoardBar.getByTestId("workboard-active-button")).toBeInTheDocument();
    expect(
      workBoardBar
        .getByTestId("workboard-active-button")
        .compareDocumentPosition(workBoardBar.getByTestId("workboard-phase-summary")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(workBoardBar.queryByTestId("workboard-current-thread")).toBeNull();
    expect(workBoardBar.getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
    expect(workBoardBar.getByTestId("thread-main-tab")).toHaveAttribute("aria-pressed", "true");
    expect(workBoardBar.getByTestId("thread-main-tab")).toHaveClass(
      "border-cc-primary/45",
      "border-b-transparent",
      "bg-cc-card",
      "text-cc-fg",
    );
    expect(workBoardBar.getByTestId("thread-main-tab")).not.toHaveClass(
      "border-violet-100/45",
      "border-amber-400/60",
      "border-cc-primary/70",
    );
    expect(workBoardBar.getByTestId("workboard-phase-summary")).toHaveTextContent("1 Work");
    const mainTitle = within(workBoardBar.getByTestId("thread-main-tab")).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "false");
    expect(
      within(workBoardBar.getByTestId("thread-main-tab")).queryByTestId("thread-tab-active-output-indicator"),
    ).toBeNull();
    expect(mainTitle.getAttribute("style") ?? "").not.toContain("animation");
    expect(mainTitle).not.toHaveClass("border");
    expect(mainTitle).not.toHaveClass("bg-sky-400/10");

    const tabs = workBoardBar.getAllByTestId("thread-tab");
    expect(tabs.map((tab) => tab.getAttribute("data-min-label"))).toEqual(["q-1932", "q-42", "q-55"]);
    expect(within(rail).queryByText("Active")).not.toBeInTheDocument();
    expect(tabs[0]).toHaveClass(
      "min-w-[var(--thread-tab-width)]",
      "max-w-[14rem]",
      "flex-[1_1_var(--thread-tab-width)]",
    );
    const q42Tab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-42");
    expect(q42Tab).toBeTruthy();
    expect(q42Tab!).toHaveAttribute("data-closable", "false");
    expect(within(q42Tab!).queryByTestId("thread-tab-close")).not.toBeInTheDocument();
    fireEvent.click(moreButton);
    const moreRows = workBoardBar.getAllByTestId("thread-tabs-more-row");
    expect(moreRows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-61", "q-77", "q-88"]);
    expect(moreRows.find((row) => row.getAttribute("data-thread-key") === "q-61")).toHaveAttribute(
      "data-hidden",
      "true",
    );
    expect(moreRows.find((row) => row.getAttribute("data-thread-key") === "q-77")).toHaveAttribute(
      "data-hidden",
      "true",
    );
    expect(moreRows.find((row) => row.getAttribute("data-thread-key") === "q-88")).toHaveAttribute(
      "data-hidden",
      "true",
    );
    const completedMoreRow = moreRows.find((row) => row.getAttribute("data-thread-key") === "q-88")!;
    // The Playground keeps this completed row in authoritative Thread Waiting,
    // so its hidden title demonstrates the temporary normal-foreground override.
    expect(within(completedMoreRow).getByTestId("thread-tabs-more-row-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
    fireEvent.click(moreButton);
    const activeOutputTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-42");
    expect(activeOutputTab).toHaveAttribute("data-active-output", "true");
    const activeOutputMarker = within(activeOutputTab!).getByTestId("thread-tab-active-output-indicator");
    expect(activeOutputMarker).toHaveAttribute("data-reduced-motion-static", "true");
    expect(activeOutputMarker).toHaveAttribute("data-dot-position", "stripe-origin");
    expect(activeOutputMarker).toHaveAttribute("data-stripe-origin", "top-left");
    expect(activeOutputMarker).toHaveClass("inset-0");
    expect(within(activeOutputMarker).getByTestId("thread-tab-active-output-glint-track")).toHaveClass("inset-x-1");
    expect(within(activeOutputMarker).getByTestId("thread-tab-active-output-glint")).toHaveClass(
      "thread-tab-output-glint",
    );
    expect(within(activeOutputMarker).getByTestId("thread-tab-active-output-dot")).toHaveClass(
      "left-1",
      "top-0",
      "h-2",
      "w-2",
      "-translate-x-1/2",
      "-translate-y-1/2",
    );
    expect(within(activeOutputTab!).getByTestId("thread-tab-needs-input-bell")).toHaveClass("relative", "z-10");
    expect(within(activeOutputTab!).getByTestId("thread-tab-title")).toHaveAttribute("data-active-output", "true");
    expect(within(activeOutputTab!).getByTestId("thread-tab-title").getAttribute("style") ?? "").not.toContain(
      "animation",
    );
    const queuedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-55");
    expect(queuedTab).toHaveAttribute("data-active-output", "false");
    expect(within(queuedTab!).queryByTestId("thread-tab-active-output-indicator")).toBeNull();
    expect(within(queuedTab!).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
    expect(moreRows.find((row) => row.getAttribute("data-thread-key") === "q-88")).toHaveTextContent(
      "Reviewed collapsed-result handling",
    );
    const activeQuestTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-42");
    expect(activeQuestTab).toHaveAttribute("data-has-quest-hover", "true");
    expect(activeQuestTab).not.toHaveAttribute("title");
    expect(within(activeQuestTab!).queryByRole("button", { name: /Preview q-/ })).toBeNull();

    fireEvent.mouseEnter(activeQuestTab!);
    const hoverCard = await screen.findByTestId("quest-hover-card");
    expect(within(hoverCard).getByText("Fix mobile sidebar overflow")).toBeTruthy();
    expect(within(hoverCard).getByTestId("quest-journey-preview-card")).toBeTruthy();
    const journey = within(hoverCard).getByTestId("quest-journey-timeline");
    expect(journey).toHaveAttribute("data-journey-mode", "active");
    expect(
      Array.from(journey.querySelectorAll("li[data-phase-index]")).map((row) =>
        Number(row.getAttribute("data-phase-index")),
      ),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(within(journey).getByText("Sixth previous phase hidden by default in tab hover previews.")).toBeTruthy();
    expect(within(journey).getByText("First visible previous phase for the tab hover clamp.")).toBeTruthy();
    expect(within(journey).getByRole("button", { name: "Show 2 earlier phases" })).toBeTruthy();
    expect(within(hoverCard).getByTestId("quest-hover-worker-session")).toHaveTextContent("Worker");
    expect(within(hoverCard).queryByTestId("quest-hover-reviewer-session")).toBeNull();
    expect(within(hoverCard).getByRole("link", { name: "Worker #5 Clear Mesa" })).toBeTruthy();
    expect(within(hoverCard).queryByRole("link", { name: "Reviewer #6 Review Lead" })).toBeNull();

    fireEvent.click(workBoardBar.getByRole("button", { name: "Quest thread" }));
    const selectedActiveQuestTab = workBoardBar
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-42")!;
    expect(within(selectedActiveQuestTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "true");
    expect(selectedActiveQuestTab).toHaveClass(
      "border-cc-primary/45",
      "border-b-transparent",
      "bg-cc-card",
      "text-cc-fg",
    );
    expect(selectedActiveQuestTab).not.toHaveClass("border-violet-100/45", "border-amber-400/60");
    expect(selectedActiveQuestTab).toHaveAttribute("data-active-output", "true");
    expect(within(selectedActiveQuestTab).getByTestId("thread-tab-active-output-indicator")).toBeTruthy();

    fireEvent.click(workBoardBar.getByText("Simulate moved-message tab"));
    const movedTabs = workBoardBar.getAllByTestId("thread-tab");
    expect(movedTabs[0]).toHaveAttribute("data-thread-key", "q-99");
    expect(movedTabs[0]).toHaveAttribute("data-new-tab", "true");
    expect(workBoardBar.queryByTestId("workboard-main-banner")).toBeNull();
    expect(workBoardBar.getByTestId("thread-tab-rail")).toBeTruthy();

    fireEvent.click(workBoardBar.getByText("Main banner"));
    expect(workBoardBar.getByTestId("workboard-projection-main")).toHaveAttribute("aria-pressed", "true");
    expect(workBoardBar.getByTestId("workboard-projection-all")).toHaveAttribute("aria-pressed", "false");
    expect(workBoardBar.getByTestId("workboard-other-button")).toHaveTextContent("3Other");
    expect(workBoardBar.queryByTestId("workboard-off-board-threads")).toBeNull();
    fireEvent.click(workBoardBar.getByTestId("workboard-other-button"));
    expect(workBoardBar.getByTestId("workboard-other-threads-content")).toHaveTextContent(
      "Off-board routed discussion",
    );
  });

  it("documents an unselected completed Waiting tab with normal foreground text", () => {
    // The dedicated control makes the completed-plus-Waiting state visible in
    // the real Playground component while Main remains selected as a contrast.
    setMeasuredRailWidth(392);
    render(<Playground />);

    const workBoardBar = getWorkBoardBarSection();
    fireEvent.click(workBoardBar.getByText("Seed board data"));
    fireEvent.click(workBoardBar.getByText("Show waiting completed tab"));

    const waitingTab = workBoardBar
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-88")!;
    expect(within(waitingTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "false");
    expect(within(waitingTab).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
    expect(within(waitingTab).queryByTestId("thread-tab-needs-input-bell")).toBeNull();
    expect(within(waitingTab).queryByTestId("thread-tab-blue-notification-bell")).toBeNull();
    expect(within(waitingTab).queryByTestId("thread-tab-active-output-indicator")).toBeNull();
  });

  it("documents the approved active v2 phase palette with separate readable text and accent tokens", () => {
    // Keep a browser-ready fixture for all active phase colors, including the
    // checkpoint amber that is normally represented as a pause inside Work.
    render(<Playground />);

    const palette = screen.getByTestId("playground-v2-phase-palette");
    const expected = [
      { id: "alignment", name: "alignment", text: "#0369a1", accent: "#0ea5e9" },
      { id: "work", name: "work", text: "#166534", accent: "#4ade80" },
      { id: "user-checkpoint", name: "amber", text: "#8a4b00", accent: "#fbbf24" },
      { id: "memory", name: "memory", text: "#6d28d9", accent: "#8b5cf6" },
    ];

    for (const phase of expected) {
      const card = within(palette).getByTestId(`playground-v2-phase-${phase.id}`);
      expect(card).toHaveAttribute("data-phase-color", phase.name);
      expect(within(card).getByTestId(`playground-v2-phase-${phase.id}-text`)).toHaveAttribute(
        "style",
        `color: var(--color-cc-phase-${phase.name}, ${phase.text});`,
      );
      expect(within(card).getByTestId(`playground-v2-phase-${phase.id}-accent`).getAttribute("style") ?? "").toContain(
        `var(--color-cc-phase-${phase.name}, ${phase.accent})`,
      );
      expect(within(card).getByTestId("quest-journey-compact-summary")).toHaveTextContent(
        within(card).getByTestId(`playground-v2-phase-${phase.id}-text`).textContent ?? "",
      );
    }
  });

  it("documents the desktop Work Board Bar tab crowd overflowing into More before labels collapse", () => {
    setMeasuredRailWidth(1880);
    render(<Playground />);

    const workBoardBar = getWorkBoardBarSection();
    fireEvent.click(workBoardBar.getByText("Seed board data"));
    fireEvent.click(workBoardBar.getByText("Simulate desktop tab crowd"));

    const rail = workBoardBar.getByTestId("thread-tab-rail");
    expect(rail).toHaveAttribute("data-overflow", "more-tabs-list");
    const tabs = workBoardBar.getAllByTestId("thread-tab");
    expect(tabs.map((tab) => tab.getAttribute("data-thread-key"))).toEqual([
      "q-42",
      "q-1101",
      "q-1102",
      "q-1103",
      "q-1104",
      "q-1105",
      "q-1106",
      "q-1107",
      "q-1108",
      "q-1112",
    ]);
    expect(workBoardBar.getByTestId("thread-tab-strip").getAttribute("style") ?? "").toContain(
      "--thread-tab-width: 160px",
    );
    expect(tabs[0]).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
    expect(workBoardBar.getByTestId("thread-tabs-more-button")).toHaveAttribute("data-hidden-count", "7");
  });

  it("documents compact quest-thread banners without chip note counts and with tap previews", () => {
    render(<Playground />);

    expect(screen.getAllByText(/long Quest Journey preview clamped around the current phase/).length).toBeGreaterThan(
      0,
    );

    const banner = screen.getAllByTestId("quest-thread-banner")[0];
    expect(banner).toHaveClass("py-1");
    expect(within(banner).getByTestId("quest-thread-meta-strip")).toHaveClass("flex-[1_1_auto]");
    expect(within(banner).getByTestId("quest-thread-participant-strip")).toHaveClass("inline-flex");
    expect(within(banner).getByTestId("quest-journey-compact-summary")).toHaveTextContent("Work");
    expect(within(banner).getByTestId("quest-journey-compact-summary")).not.toHaveTextContent("note");
    expect(within(banner).getByLabelText("Worker #1321 Clear Mesa")).toBeTruthy();
    expect(within(banner).queryByLabelText("Reviewer #1306 Review Lead")).toBeNull();
    expect(within(banner).getByTestId("quest-thread-commit-button")).toHaveTextContent("2 commits");
    const mobileParticipantPreview = screen.getByTestId("playground-mobile-participant-labels");
    const mobileParticipantBanners = within(mobileParticipantPreview).getAllByTestId("quest-thread-banner");
    expect(within(mobileParticipantBanners[0]).getByText("Worker")).toHaveClass("max-[319px]:hidden");
    expect(within(mobileParticipantBanners[0]).getByTestId("session-role-icon-worker")).toBeInTheDocument();
    expect(within(mobileParticipantBanners[1]).getByText("Leader")).toHaveClass("max-[319px]:hidden");
    expect(within(mobileParticipantBanners[1]).getByTestId("session-role-icon-leader")).toBeInTheDocument();

    const queuedBanner = screen.getAllByTestId("quest-thread-banner")[1];
    expect(within(queuedBanner).getByTestId("quest-thread-queued-status-chip")).toHaveTextContent(
      "Queued, waiting for #1801, q-1367, free worker",
    );
    expect(within(queuedBanner).queryByTestId("quest-thread-wait-pill")).not.toBeInTheDocument();
    expect(within(queuedBanner).queryByTestId("quest-journey-compact-summary")).not.toBeInTheDocument();
    const staleQueuedDoneBanner = screen.getAllByTestId("quest-thread-banner")[2];
    expect(within(staleQueuedDoneBanner).queryByTestId("quest-thread-queued-status-chip")).not.toBeInTheDocument();
    expect(staleQueuedDoneBanner).not.toHaveTextContent("Queued, waiting for free worker");
    expect(within(staleQueuedDoneBanner).getByTestId("quest-journey-compact-summary")).toHaveTextContent("Completed");

    fireEvent.click(within(banner).getByTestId("quest-thread-journey-hover-target"));
    const hoverCard = screen.getByTestId("quest-thread-journey-hover-card");
    expect(hoverCard).toBeTruthy();
    const preview = within(hoverCard).getByTestId("quest-journey-preview-card");
    expect(preview).toHaveTextContent("3 phases · Total 4m");
    expect(
      within(preview)
        .getAllByTestId("quest-journey-phase-duration")
        .map((node) => node.textContent),
    ).toEqual(["1m", "3m"]);
    expect(preview).not.toHaveTextContent("Duration unavailable");
    expect(preview).toHaveTextContent("Work owns implementation, validation, and sync evidence.");

    const completedBanner = screen.getAllByTestId("quest-thread-banner")[3];
    fireEvent.click(within(completedBanner).getByTestId("quest-thread-journey-hover-target"));
    const completedPreview = within(screen.getAllByTestId("quest-thread-journey-hover-card").at(-1)!).getByTestId(
      "quest-journey-preview-card",
    );
    expect(completedPreview).toHaveTextContent("3 phases · Partial 3m");
    expect(
      within(completedPreview)
        .getAllByTestId("quest-journey-phase-duration")
        .map((node) => node.textContent),
    ).toEqual(["1m", "2m"]);
  });
});
