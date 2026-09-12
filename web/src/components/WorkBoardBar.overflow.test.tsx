// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardRowData } from "./BoardTable.js";
import type { QuestTitlePreview, QuestmasterTask, SessionAttentionRecord, SessionState } from "../types.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { getQuestJourneyPhaseForState } from "../../shared/quest-journey.js";
import { getQuestPhaseColorValue } from "../utils/quest-phase-theme.js";
import {
  installWorkBoardProjectionFixture,
  resetWorkBoardProjectionFixture,
  type WorkBoardProjectionPropsFixture,
} from "../test-fixtures/work-board-projection-adapter.js";

interface MockStoreState {
  sessionBoards: Map<string, BoardRowData[]>;
  sessionBoardRowStatuses: Map<string, Record<string, import("../types.js").BoardRowSessionStatus>>;
  sessionCompletedBoards: Map<string, BoardRowData[]>;
  sdkSessions: Array<{ sessionId: string; isOrchestrator?: boolean }>;
  sessions: Map<string, SessionState>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  sessionTaskHistory: Map<string, unknown[]>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  cliConnected: Map<string, boolean>;
  askPermission: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  quests: QuestmasterTask[];
  questDetails: Map<string, QuestmasterTask>;
  questTitlePreviews: Map<string, QuestTitlePreview | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  activeTurnRoutes: Map<string, import("../types.js").ActiveTurnRoute | null>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    sessionCompletedBoards: new Map(),
    sdkSessions: [{ sessionId: "s1", isOrchestrator: true }],
    sessions: new Map(),
    sessionAttention: new Map(),
    sessionNames: new Map(),
    sessionPreviews: new Map(),
    sessionTaskHistory: new Map(),
    pendingPermissions: new Map(),
    cliConnected: new Map(),
    askPermission: new Map(),
    cliDisconnectReason: new Map(),
    quests: [],
    questDetails: new Map(),
    questTitlePreviews: new Map(),
    sessionStatus: new Map(),
    activeTurnRoutes: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign((selector: (s: MockStoreState) => unknown) => selector(mockState), {
    getState: () => ({
      ...mockState,
      requestScrollToMessage: vi.fn(),
      setExpandAllInTurn: vi.fn(),
    }),
  }),
  countUserPermissions: (permissions: Map<string, unknown> | undefined) => permissions?.size ?? 0,
}));

vi.mock("./BoardTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BoardTable.js")>();
  return {
    ...actual,
    BoardTable: () => <div data-testid="board-table" />,
  };
});

const { WorkBoardBar: CurrentWorkBoardBar, buildCompactThreadTabPartition } = await import("./WorkBoardBar.js");

type WorkBoardBarProps = ComponentProps<typeof CurrentWorkBoardBar> &
  Pick<WorkBoardProjectionPropsFixture, "attentionRecords" | "closedThreadKeys">;

function WorkBoardBar(props: WorkBoardBarProps) {
  installWorkBoardProjectionFixture(mockState, props, {
    explicitOpenKeysProvided: Object.hasOwn(props, "openThreadKeys"),
  });
  const { attentionRecords: _attentionRecords, closedThreadKeys: _closedThreadKeys, ...currentProps } = props;
  return <CurrentWorkBoardBar {...currentProps} threadRows={[...(currentProps.threadRows ?? [])]} />;
}

function reviewAttentionRecord(threadKey: string): SessionAttentionRecord {
  return {
    id: `review:${threadKey}`,
    leaderSessionId: "s1",
    type: "review_ready",
    source: { kind: "notification", id: `n-${threadKey}`, questId: threadKey },
    questId: threadKey,
    threadKey,
    title: `${threadKey} ready for review`,
    summary: `Review ${threadKey}`,
    actionLabel: "Review",
    priority: "review",
    state: "unresolved",
    createdAt: 100,
    updatedAt: 100,
    route: { threadKey, questId: threadKey },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: `review:${threadKey}`,
  };
}

function readyResultAttentionRecord(threadKey: string): SessionAttentionRecord {
  return {
    ...reviewAttentionRecord(threadKey),
    id: `thread-ready:${threadKey}`,
    title: `${threadKey} ready`,
    summary: `Thread ready: ${threadKey} | quest complete`,
    dedupeKey: `thread-ready:${threadKey}`,
  };
}

function expectNoNotificationSurfaceTone(element: HTMLElement) {
  expect(element.className).not.toContain("border-amber-400/35");
  expect(element.className).not.toContain("bg-amber-400/10");
  expect(element.className).not.toContain("text-amber-100");
  expect(element.className).not.toContain("border-blue-400/35");
  expect(element.className).not.toContain("bg-blue-400/10");
  expect(element.className).not.toContain("text-blue-100");
}

function getPhaseColor(status: string): string | undefined {
  const phase = getQuestJourneyPhaseForState(status);
  return phase ? getQuestPhaseColorValue(phase.color) : undefined;
}

function waitingThreadStatus(threadKey: string): LeaderThreadStatus {
  return {
    kind: "waiting",
    label: "Thread Waiting",
    threadKey,
    questId: threadKey,
    summary: "waiting for worker",
    messageId: `${threadKey}-waiting`,
    timestamp: 20,
    updatedAt: 20,
  };
}

function setMeasuredRailWidth(width: number, threadTabWidth = width) {
  setMeasuredRailWidthWithThreadResolver(width, () => threadTabWidth);
}

function setMeasuredRailWidthByThreadKey(width: number, threadTabWidths: Record<string, number>) {
  setMeasuredRailWidthWithThreadResolver(width, (threadKey) => threadTabWidths[threadKey] ?? width);
}

function setMeasuredRailWidthWithThreadResolver(width: number, threadTabWidthForKey: (threadKey: string) => number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const threadKey = this.getAttribute("data-thread-key");
    const measuredWidth =
      this.getAttribute("data-testid") === "thread-tab-strip" ||
      this.getAttribute("data-testid") === "thread-tabs-more-button"
        ? width
        : this.getAttribute("data-thread-tab-width-source") === "true" && threadKey
          ? threadTabWidthForKey(threadKey)
          : width;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: measuredWidth,
      bottom: 24,
      width: measuredWidth,
      height: 24,
      toJSON: () => ({}),
    } as DOMRect;
  });
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

const THREAD_ROWS = Array.from({ length: 5 }, (_, index) => {
  const questNumber = index + 1;
  return {
    threadKey: `q-${questNumber}`,
    questId: `q-${questNumber}`,
    title: `Quest ${questNumber} thread`,
    messageCount: questNumber,
  };
});

describe("WorkBoardBar overflow tabs", () => {
  beforeEach(() => {
    resetWorkBoardProjectionFixture();
    resetStore();
    setMeasuredRailWidth(392);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pins the selected tab into the compact strip without mutating source order", () => {
    const sourceTabs = THREAD_ROWS.map((row) => ({ threadKey: row.threadKey }));
    // The selected tab is visually pinned into the compact strip, but the source order must stay server-owned.
    const partition = buildCompactThreadTabPartition({
      tabs: sourceTabs,
      currentThreadKey: "q-5",
      railWidth: 392,
    });

    expect(partition.visibleThreadKeys).toEqual(["q-1", "q-2", "q-5"]);
    expect(partition.hiddenThreadKeys).toEqual(["q-3", "q-4"]);
    expect(sourceTabs.map((tab) => tab.threadKey)).toEqual(["q-1", "q-2", "q-3", "q-4", "q-5"]);
  });

  it("marks the thread tab strip for mobile animation-stability overrides", () => {
    render(<WorkBoardBar sessionId="s1" currentThreadKey="q-1" openThreadKeys={["q-1"]} threadRows={THREAD_ROWS} />);

    expect(screen.getByTestId("thread-tab-strip")).toHaveClass("mobile-scroll-stable-surface", "w-full");
  });

  it("keeps visible tab widths fluid when the close affordance is hovered", () => {
    setMeasuredRailWidth(960, 180);

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1", "q-2", "q-3"]}
        onCloseThreadTab={vi.fn()}
        threadRows={THREAD_ROWS.slice(0, 3)}
      />,
    );

    const strip = view.getByTestId("thread-tab-strip");
    const selectedClose = within(
      view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!,
    ).getByTestId("thread-tab-close");
    fireEvent.pointerEnter(selectedClose, { pointerType: "mouse" });

    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip).toHaveAttribute("data-frozen-thread-tab-width", "");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    for (const tab of view.getAllByTestId("thread-tab")) {
      expect(tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
      expect(tab).not.toHaveClass("flex-none");
    }

    view.rerender(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-2"
        openThreadKeys={["q-2", "q-3"]}
        onCloseThreadTab={vi.fn()}
        threadRows={THREAD_ROWS.slice(0, 3)}
      />,
    );

    const rerenderedStrip = view.getByTestId("thread-tab-strip");
    expect(rerenderedStrip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(rerenderedStrip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-2", "q-3"]);
    for (const tab of view.getAllByTestId("thread-tab")) {
      expect(tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
      expect(tab).not.toHaveClass("flex-none");
    }
  });

  it("keeps sortable tabs on fluid sizing during close-button hover", () => {
    setMeasuredRailWidthByThreadKey(960, {
      main: 241.5,
      "q-1": 303.75,
      "q-2": 287.25,
    });

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1", "q-2"]}
        onCloseThreadTab={vi.fn()}
        onReorderThreadTabs={vi.fn()}
        threadRows={THREAD_ROWS.slice(0, 2)}
      />,
    );

    const strip = view.getByTestId("thread-tab-strip");
    const mainTab = view.getByTestId("thread-main-tab");
    const q1Tab = view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;
    const q2Tab = view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-2")!;

    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(q1Tab).toHaveAttribute("data-thread-tab-width-source", "true");

    fireEvent.pointerEnter(within(q1Tab).getByTestId("thread-tab-close"), { pointerType: "mouse" });

    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(mainTab.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(q1Tab.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(q2Tab.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(mainTab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
    expect(q1Tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
    expect(q2Tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
    expect(q1Tab).not.toHaveClass("flex-none");
    expect(q2Tab).not.toHaveClass("flex-none");
  });

  it("keeps quest hover cards from freezing or shrinking the tab strip", async () => {
    setMeasuredRailWidthByThreadKey(960, {
      main: 240,
      "q-1": 300,
      "q-2": 280,
    });
    resetStore({
      sessionBoards: new Map([
        ["s1", [{ questId: "q-1", title: "Atlas hover target", status: "IMPLEMENTING", updatedAt: 1 }]],
      ]),
      quests: [
        {
          id: "q-1-v1",
          questId: "q-1",
          version: 1,
          title: "Atlas hover target",
          description: "Hovering this tab should only open the quest card.",
          status: "in_progress",
          tags: [],
          createdAt: 1,
          updatedAt: 1,
          statusChangedAt: 1,
          sessionId: "worker-q-1",
          claimedAt: 1,
        },
      ],
    });

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="main"
        openThreadKeys={["q-2"]}
        onCloseThreadTab={vi.fn()}
        threadRows={[{ threadKey: "q-2", questId: "q-2", title: "Closable background thread", messageCount: 2 }]}
      />,
    );

    const strip = view.getByTestId("thread-tab-strip");
    const hoverTab = view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!;

    fireEvent.pointerEnter(strip, { pointerType: "mouse" });
    fireEvent.mouseEnter(hoverTab);

    expect(await screen.findByTestId("quest-hover-card")).toHaveTextContent("Atlas hover target");
    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    expect(hoverTab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
    expect(hoverTab).not.toHaveClass("flex-none");
    expect(view.getByTestId("thread-main-tab")).toHaveClass(
      "min-w-[var(--thread-tab-width)]",
      "flex-[1_1_var(--thread-tab-width)]",
    );
  });

  it("does not freeze tab widths for touch entry", () => {
    setMeasuredRailWidth(960, 180);

    const { getByTestId, getAllByTestId } = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1", "q-2"]}
        onCloseThreadTab={vi.fn()}
        threadRows={THREAD_ROWS.slice(0, 2)}
      />,
    );

    const closeButton = within(
      getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!,
    ).getByTestId("thread-tab-close");
    fireEvent.pointerEnter(closeButton, { pointerType: "touch" });

    expect(getByTestId("thread-tab-strip")).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(getByTestId("thread-tab-strip").getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    for (const tab of getAllByTestId("thread-tab")) {
      expect(tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
      expect(tab).not.toHaveClass("flex-none");
    }
  });

  it("keeps More rows preview-free while preserving visible rail previews and keyboard selection", async () => {
    // Cached quest details reproduce the obstructing card without relying on a network fetch.
    // Opening More must also dismiss an existing rail preview before the pointer enters its rows.
    const user = userEvent.setup();
    const onSelectThread = vi.fn();
    resetStore({
      quests: THREAD_ROWS.map((row) => ({
        id: `${row.questId}-v1`,
        questId: row.questId,
        version: 1,
        title: row.title,
        description: "Quest details belong in the visible rail preview.",
        status: "done",
        completedAt: 1,
        verificationItems: [],
        tags: [],
        createdAt: 1,
        updatedAt: 1,
        statusChangedAt: 1,
      })),
    });
    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={THREAD_ROWS.map((row) => row.threadKey)}
        onSelectThread={onSelectThread}
        threadRows={THREAD_ROWS}
      />,
    );

    const railTab = screen.getAllByTestId("thread-tab")[0]!;
    await user.hover(railTab);
    expect(screen.getByTestId("quest-hover-card")).toHaveTextContent("Quest 1 thread");
    fireEvent.click(screen.getByTestId("thread-tabs-more-button"));
    expect(screen.queryByTestId("quest-hover-card")).not.toBeInTheDocument();

    const rows = screen.getAllByTestId("thread-tabs-more-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      await user.hover(row);
      expect(screen.queryByTestId("quest-hover-card")).not.toBeInTheDocument();
      expect(within(row).getByTestId("thread-tabs-more-row-title")).toHaveTextContent(/Quest [34] thread/);
      expect(row).toHaveTextContent("Done");
    }
    const select = within(rows[1]!).getByTestId("thread-tabs-more-row-select");
    select.focus();
    await user.keyboard("{Enter}");
    expect(onSelectThread).toHaveBeenCalledWith("q-4");
    expect(screen.queryByTestId("thread-tabs-more-list")).not.toBeInTheDocument();

    await user.hover(railTab);
    expect(screen.getByTestId("quest-hover-card")).toHaveTextContent("Quest 1 thread");
  });

  it("keeps More-menu interactions free of close-hover frozen widths", async () => {
    setMeasuredRailWidth(392, 76);
    const onCloseThreadTab = vi.fn();

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={THREAD_ROWS}
      />,
    );

    const strip = screen.getByTestId("thread-tab-strip");
    fireEvent.pointerEnter(
      within(
        screen.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!,
      ).getByTestId("thread-tab-close"),
      { pointerType: "mouse" },
    );
    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    expect(screen.getByTestId("thread-tabs-more-list")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("thread-tabs-more-list")).not.toBeInTheDocument();
    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");

    fireEvent.pointerEnter(
      within(
        screen.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!,
      ).getByTestId("thread-tab-close"),
      { pointerType: "mouse" },
    );
    fireEvent.click(screen.getByTestId("thread-tabs-more-button"));
    const q4Row = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;

    fireEvent.click(within(q4Row).getByLabelText("Close q-4"));

    expect(onCloseThreadTab).toHaveBeenCalledWith("q-4", "q-5");
    expect(screen.getByTestId("thread-tabs-more-list")).toBeInTheDocument();
    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
  });

  it("keeps fluid tab widths when the last hidden tab leaves More during a visible close", () => {
    // At 472px, five tabs need a More menu with one hidden tab, while four tabs fit without More.
    // Closing a visible tab should not leave the strip in a fixed-width hover state while the final hidden tab promotes.
    setMeasuredRailWidth(472, 76);

    const view = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onCloseThreadTab={vi.fn()}
        threadRows={THREAD_ROWS}
      />,
    );

    expect(view.getByTestId("thread-tabs-more-button")).toHaveAttribute("data-hidden-count", "1");
    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual([
      "q-1",
      "q-2",
      "q-3",
      "q-5",
    ]);

    const strip = view.getByTestId("thread-tab-strip");
    fireEvent.pointerEnter(
      within(
        view.getAllByTestId("thread-tab").find((tab) => tab.getAttribute("data-thread-key") === "q-1")!,
      ).getByTestId("thread-tab-close"),
      { pointerType: "mouse" },
    );

    expect(strip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(strip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");

    view.rerender(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-4", "q-5"]}
        onCloseThreadTab={vi.fn()}
        threadRows={THREAD_ROWS}
      />,
    );

    const promotedStrip = view.getByTestId("thread-tab-strip");
    expect(view.queryByTestId("thread-tabs-more-button")).not.toBeInTheDocument();
    expect(view.getAllByTestId("thread-tab").map((tab) => tab.getAttribute("data-thread-key"))).toEqual([
      "q-1",
      "q-2",
      "q-4",
      "q-5",
    ]);
    expect(promotedStrip).toHaveAttribute("data-close-target-width-frozen", "false");
    expect(promotedStrip.getAttribute("style") ?? "").not.toContain("--thread-tab-frozen-width");
    for (const tab of view.getAllByTestId("thread-tab")) {
      expect(tab).toHaveClass("min-w-[var(--thread-tab-width)]", "flex-[1_1_var(--thread-tab-width)]");
      expect(tab).not.toHaveClass("flex-none");
    }
  });

  it("uses wider desktop tab packing so readable labels overflow into More earlier", () => {
    const sourceTabs = Array.from({ length: 12 }, (_, index) => ({ threadKey: `q-${index + 1}` }));
    // The approved desktop case has enough physical room for many 68px tabs, but those labels are not useful.
    const partition = buildCompactThreadTabPartition({
      tabs: sourceTabs,
      currentThreadKey: "q-12",
      railWidth: 1880,
    });

    expect(partition.visibleThreadKeys).toEqual([
      "q-1",
      "q-2",
      "q-3",
      "q-4",
      "q-5",
      "q-6",
      "q-7",
      "q-8",
      "q-9",
      "q-12",
    ]);
    expect(partition.hiddenThreadKeys).toEqual(["q-10", "q-11"]);
    expect(sourceTabs.map((tab) => tab.threadKey)).toEqual([
      "q-1",
      "q-2",
      "q-3",
      "q-4",
      "q-5",
      "q-6",
      "q-7",
      "q-8",
      "q-9",
      "q-10",
      "q-11",
      "q-12",
    ]);
  });

  it("shows More tabs with hidden status aggregation and selects hidden rows from the list", async () => {
    const onSelectThread = vi.fn();
    const onReorderThreadTabs = vi.fn();
    // Hidden q-3 owns needs-input state and hidden q-4 owns active output, so the More button must aggregate both.
    resetStore({
      sessionStatus: new Map([["s1", "running"]]),
      activeTurnRoutes: new Map([["s1", { threadKey: "q-4", questId: "q-4" }]]),
      sessionBoards: new Map([
        ["s1", [{ questId: "q-3", title: "Quest 3 thread", status: "WAITING", updatedAt: 3, waitForInput: ["user"] }]],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onSelectThread={onSelectThread}
        onReorderThreadTabs={onReorderThreadTabs}
        threadRows={THREAD_ROWS}
      />,
    );

    const visibleTabs = await screen.findAllByTestId("thread-tab");
    expect(visibleTabs.map((tab) => tab.getAttribute("data-thread-key"))).toEqual(["q-1", "q-2", "q-5"]);
    expect(visibleTabs.every((tab) => tab.getAttribute("data-reorderable") === "true")).toBe(true);
    expect(
      visibleTabs.every(
        (tab) => within(tab).getByTestId("thread-tab-select").getAttribute("aria-roledescription") === "sortable",
      ),
    ).toBe(true);
    const moreButton = screen.getByTestId("thread-tabs-more-button");
    expect(screen.getByTestId("thread-tab-rail")).toHaveAttribute("data-overflow", "more-tabs-list");
    expect(moreButton).toHaveAttribute("data-hidden-count", "2");
    expect(moreButton).toHaveAttribute("data-has-active-output", "true");
    expect(moreButton).toHaveAttribute("data-has-needs-input", "true");
    expect(visibleTabs.every((tab) => tab.getAttribute("data-reorderable") === "true")).toBe(true);
    expect(screen.getByTestId("thread-main-tab")).not.toHaveAttribute("data-reorderable", "true");
    expect(moreButton).not.toHaveAttribute("aria-roledescription", "sortable");

    fireEvent.click(moreButton);
    const rows = screen.getAllByTestId("thread-tabs-more-row");
    expect(rows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-3", "q-4"]);
    expect(rows.every((row) => row.getAttribute("data-hidden") === "true")).toBe(true);
    expect(rows.find((row) => row.getAttribute("data-thread-key") === "q-3")).toHaveAttribute("data-hidden", "true");
    expect(rows.find((row) => row.getAttribute("data-thread-key") === "q-4")).toHaveAttribute(
      "data-active-output",
      "true",
    );

    fireEvent.click(
      within(rows.find((row) => row.getAttribute("data-thread-key") === "q-4")!).getByTestId(
        "thread-tabs-more-row-select",
      ),
    );
    expect(onSelectThread).toHaveBeenCalledWith("q-4");
    expect(screen.queryByTestId("thread-tabs-more-list")).not.toBeInTheDocument();
  });

  it("aggregates hidden blue notification nudges without treating More itself as viewing the notification", async () => {
    const onSelectThread = vi.fn();

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onSelectThread={onSelectThread}
        threadRows={THREAD_ROWS}
        attentionRecords={[reviewAttentionRecord("q-4")]}
      />,
    );

    const moreButton = await screen.findByTestId("thread-tabs-more-button");
    expect(moreButton).toHaveAttribute("data-has-blue-notification", "true");
    expectNoNotificationSurfaceTone(moreButton);
    expect(within(moreButton).getByTestId("thread-tab-blue-notification-bell")).toHaveClass("text-cc-info");

    fireEvent.click(moreButton);
    expect(onSelectThread).not.toHaveBeenCalled();

    const q4Row = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    expect(q4Row).toHaveAttribute("data-hidden", "true");
    expect(q4Row).toHaveAttribute("data-blue-notification", "true");
    expect(within(q4Row).getByTestId("thread-tab-blue-notification-bell")).toBeInTheDocument();

    fireEvent.click(within(q4Row).getByTestId("thread-tabs-more-row-select"));
    expect(onSelectThread).toHaveBeenCalledWith("q-4");
  });

  it("renders Thread Ready unread attention as a blue bell on a visible thread tab", async () => {
    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="main"
        openThreadKeys={["q-4"]}
        threadRows={THREAD_ROWS}
        attentionRecords={[readyResultAttentionRecord("q-4")]}
      />,
    );

    const q4Tab = (await screen.findAllByTestId("thread-tab")).find(
      (tab) => tab.getAttribute("data-thread-key") === "q-4",
    )!;
    expect(q4Tab).toHaveAttribute("data-blue-notification", "true");
    expect(q4Tab).toHaveAttribute("data-needs-input", "false");
    expect(within(q4Tab).getByTestId("thread-tab-blue-notification-bell")).toHaveClass("text-cc-info");
  });

  it("keeps active needs-input ahead of Thread Ready blue unread attention", async () => {
    resetStore({
      sessionBoards: new Map([
        ["s1", [{ questId: "q-4", title: "Quest 4 thread", status: "WAITING", updatedAt: 4, waitForInput: ["user"] }]],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="main"
        openThreadKeys={["q-4"]}
        threadRows={THREAD_ROWS}
        attentionRecords={[readyResultAttentionRecord("q-4")]}
      />,
    );

    const q4Tab = (await screen.findAllByTestId("thread-tab")).find(
      (tab) => tab.getAttribute("data-thread-key") === "q-4",
    )!;
    expect(q4Tab).toHaveAttribute("data-blue-notification", "true");
    expect(q4Tab).toHaveAttribute("data-needs-input", "true");
    expect(within(q4Tab).getByTestId("thread-tab-needs-input-bell")).toHaveClass("text-cc-attention");
    expect(within(q4Tab).queryByTestId("thread-tab-blue-notification-bell")).not.toBeInTheDocument();
  });

  it("aggregates hidden needs-input nudges without tinting the More button surface", async () => {
    resetStore({
      sessionBoards: new Map([
        ["s1", [{ questId: "q-4", title: "Quest 4 thread", status: "WAITING", updatedAt: 4, waitForInput: ["user"] }]],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        threadRows={THREAD_ROWS}
      />,
    );

    const moreButton = await screen.findByTestId("thread-tabs-more-button");
    expect(moreButton).toHaveAttribute("data-has-needs-input", "true");
    expectNoNotificationSurfaceTone(moreButton);
    expect(within(moreButton).getByTestId("thread-tab-needs-input-bell")).toHaveClass("text-cc-attention");
  });

  it("prioritizes hidden needs-input over review attention on More and hidden rows", async () => {
    resetStore({
      sessionBoards: new Map([
        ["s1", [{ questId: "q-4", title: "Quest 4 thread", status: "WAITING", updatedAt: 4, waitForInput: ["user"] }]],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        threadRows={THREAD_ROWS}
        attentionRecords={[reviewAttentionRecord("q-4")]}
      />,
    );

    const moreButton = await screen.findByTestId("thread-tabs-more-button");
    expect(moreButton).toHaveAttribute("data-has-needs-input", "true");
    expect(moreButton).toHaveAttribute("data-has-blue-notification", "true");
    expectNoNotificationSurfaceTone(moreButton);
    expect(within(moreButton).getByTestId("thread-tab-needs-input-bell")).toHaveClass("text-cc-attention");
    expect(within(moreButton).queryByTestId("thread-tab-blue-notification-bell")).not.toBeInTheDocument();

    fireEvent.click(moreButton);
    const q4Row = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    expect(q4Row).toHaveAttribute("data-hidden", "true");
    expect(q4Row).toHaveAttribute("data-needs-input", "true");
    expect(q4Row).toHaveAttribute("data-blue-notification", "true");
    expect(within(q4Row).getByTestId("thread-tab-needs-input-bell")).toHaveClass("text-cc-attention");
    expect(within(q4Row).queryByTestId("thread-tab-blue-notification-bell")).not.toBeInTheDocument();
  });

  it("uses muted completed color for completed hidden rows in the More tabs list", async () => {
    resetStore({
      sessionCompletedBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-4",
              title: "Finished hidden thread",
              status: "PORTING",
              updatedAt: 4,
              completedAt: 4,
              journey: {
                presetId: "full-code",
                phaseIds: ["alignment", "implement", "code-review", "port"],
                currentPhaseId: "port",
              },
            },
          ],
        ],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        threadRows={THREAD_ROWS}
      />,
    );

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    const completedRow = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    const completedTitle = within(completedRow).getByTestId("thread-tabs-more-row-title");
    expect(completedTitle).toHaveAttribute("data-title-color", "var(--color-cc-muted)");
    expect(completedTitle).not.toHaveStyle({
      color: getPhaseColor("PORTING"),
    });
  });

  it("uses normal foreground for a completed hidden row with authoritative Thread Waiting", async () => {
    // Hidden rows use the same completed-plus-Waiting override as visible tabs,
    // without turning the aggregate More control into a new attention surface.
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            leaderThreadStatuses: { "q-4": waitingThreadStatus("q-4") },
          } as unknown as SessionState,
        ],
      ]),
      sessionCompletedBoards: new Map([
        [
          "s1",
          [
            {
              questId: "q-4",
              title: "Waiting hidden thread",
              status: "DONE",
              updatedAt: 4,
              completedAt: 4,
            },
          ],
        ],
      ]),
    });

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        threadRows={THREAD_ROWS}
      />,
    );

    const moreButton = await screen.findByTestId("thread-tabs-more-button");
    expect(moreButton).toHaveAttribute("data-has-needs-input", "false");
    expect(moreButton).toHaveAttribute("data-has-blue-notification", "false");
    fireEvent.click(moreButton);
    const waitingRow = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    expect(within(waitingRow).getByTestId("thread-tabs-more-row-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
  });

  it("keeps unfinished off-board quest tab titles unmuted and closable", async () => {
    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1"]}
        onCloseThreadTab={vi.fn()}
        threadRows={[
          {
            threadKey: "q-1",
            questId: "q-1",
            title: "Unfinished off-board thread",
            status: "in_progress",
            messageCount: 2,
            section: "done",
          },
        ]}
      />,
    );

    const tab = await screen.findByTestId("thread-tab");
    expect(tab).toHaveAttribute("data-closable", "true");
    expect(within(tab).getByTestId("thread-tab-title")).toHaveAttribute("data-title-color", "");
  });

  it("lets completed quest status override stale active board phase color on selected open tabs", async () => {
    resetStore({
      sessionBoards: new Map([
        ["s1", [{ questId: "q-1259", title: "Completed but stale active row", status: "PORTING", updatedAt: 10 }]],
      ]),
      quests: [
        {
          id: "q-1259",
          questId: "q-1259",
          version: 1,
          title: "Completed but stale active row",
          description: "",
          status: "done",
          tags: [],
          createdAt: 1,
          updatedAt: 10,
          statusChangedAt: 10,
          completedAt: 10,
          verificationItems: [],
        },
      ],
    });

    render(<WorkBoardBar sessionId="s1" currentThreadKey="q-1259" openThreadKeys={["q-1259"]} threadRows={[]} />);

    const tab = await screen.findByTestId("thread-tab");
    const title = within(tab).getByTestId("thread-tab-title");
    expect(within(tab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "true");
    expect(title).toHaveAttribute("data-title-color", "var(--color-cc-muted)");
    expect(title).not.toHaveStyle({
      color: getPhaseColor("PORTING"),
    });
    expectNoNotificationSurfaceTone(tab);
  });

  it("shows a hydrated canonical title for a retained removed-board tab in More", async () => {
    // A server-owned open key can be hidden in More after its cancelled quest
    // disappears from both board collections and the paged quest list.
    resetStore({
      questDetails: new Map([
        [
          "q-1932",
          {
            id: "q-1932-v2",
            questId: "q-1932",
            version: 2,
            title: "Old cached title",
            description: "Stale detail body",
            status: "done",
            createdAt: 1,
            updatedAt: 20,
            completedAt: 20,
            verificationItems: [],
          } as QuestmasterTask,
        ],
      ]),
      questTitlePreviews: new Map([
        ["q-1932", { questId: "q-1932", title: "Resolve VSCode QA Stack Conflicts", version: 3, updatedAt: 30 }],
      ]),
    });
    setMeasuredRailWidth(320);

    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-1"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-1932"]}
        threadRows={THREAD_ROWS}
      />,
    );

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    const retainedRow = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-1932");
    expect(retainedRow).toBeDefined();
    expect(retainedRow).toHaveTextContent("Resolve VSCode QA Stack Conflicts");
    expect(retainedRow).not.toHaveTextContent("Old cached title");
  });

  it("keeps the More tabs list open after a hidden row close", async () => {
    const onCloseThreadTab = vi.fn();
    // Close fallback should still use the full ordered tab list, even when the closed tab is hidden in More.
    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={THREAD_ROWS}
      />,
    );

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    const q4Row = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    fireEvent.click(within(q4Row).getByLabelText("Close q-4"));

    expect(onCloseThreadTab).toHaveBeenCalledWith("q-4", "q-5");
    expect(screen.getByTestId("thread-tabs-more-list")).toBeInTheDocument();
  });

  it("keeps the More tabs list open across multiple hidden row closes", async () => {
    const onCloseThreadTab = vi.fn();
    const view = render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={THREAD_ROWS}
      />,
    );

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    const firstCloseRow = screen.getByLabelText("Close q-4").closest("[data-testid='thread-tabs-more-row']");
    expect(firstCloseRow).toHaveAttribute("data-thread-key", "q-4");
    fireEvent.click(within(firstCloseRow as HTMLElement).getByLabelText("Close q-4"));
    expect(screen.getByTestId("thread-tabs-more-list")).toBeInTheDocument();

    // Simulate the server-owned tab state after the first close while preserving the open popover state.
    view.rerender(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-5"]}
        onCloseThreadTab={onCloseThreadTab}
        threadRows={THREAD_ROWS}
      />,
    );

    const remainingRows = screen.getAllByTestId("thread-tabs-more-row");
    expect(remainingRows.map((row) => row.getAttribute("data-thread-key"))).toEqual(["q-3"]);
    fireEvent.click(within(remainingRows[0]).getByLabelText("Close q-3"));

    expect(onCloseThreadTab).toHaveBeenNthCalledWith(1, "q-4", "q-5");
    expect(onCloseThreadTab).toHaveBeenNthCalledWith(2, "q-3", "q-5");
    expect(screen.getByTestId("thread-tabs-more-list")).toBeInTheDocument();
  });

  it("persists overflow reorder only through the explicit More tabs reorder mode", async () => {
    const onSelectThread = vi.fn();
    const onReorderThreadTabs = vi.fn();

    // Reorder mode disables row selection and persists through the same server-owned order callback as rail drag.
    render(
      <WorkBoardBar
        sessionId="s1"
        currentThreadKey="q-5"
        openThreadKeys={["q-1", "q-2", "q-3", "q-4", "q-5"]}
        onSelectThread={onSelectThread}
        onReorderThreadTabs={onReorderThreadTabs}
        threadRows={THREAD_ROWS}
      />,
    );

    fireEvent.click(await screen.findByTestId("thread-tabs-more-button"));
    fireEvent.click(screen.getByTestId("thread-tabs-more-reorder-toggle"));

    const q4Row = screen
      .getAllByTestId("thread-tabs-more-row")
      .find((row) => row.getAttribute("data-thread-key") === "q-4")!;
    expect(q4Row).toHaveAttribute("data-reorderable", "true");
    fireEvent.click(within(q4Row).getByTestId("thread-tabs-more-row-select"));
    expect(onSelectThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Move q-4 up"));
    fireEvent.click(screen.getByText("Done"));

    expect(onReorderThreadTabs).toHaveBeenCalledWith(["q-1", "q-2", "q-4", "q-3", "q-5"]);
    expect(screen.queryByTestId("thread-tabs-more-list")).not.toBeInTheDocument();
  });
});
