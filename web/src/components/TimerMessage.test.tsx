// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { FeedEntry } from "../hooks/use-feed-model.js";
import { buildFeedModel } from "../hooks/use-feed-model.js";
import { useStore } from "../store.js";
import type { ChatMessage } from "../types.js";
import { FeedEntries } from "./MessageFeedEntries.js";
import { collectTimerMessageBatch, TimerMessageGroup } from "./TimerMessage.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: {} }));

const SESSION_ID = "timer-group-session";
const TIMER_CONTENT =
  "[⏰ Timer t20 reminder] Monitor disjoint ChaiFlow batch\n\nThis is a reminder from your earlier timer note, not a new user instruction.\n\nEarlier note:\nCheck terminal accounting.";
const scrollIntoView = vi.fn();

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeTimer(id: string, timestamp: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return makeMessage({
    id,
    role: "user",
    content: TIMER_CONTENT,
    timestamp,
    agentSource: { sessionId: "timer:t20", sessionLabel: "Timer t20" },
    ...overrides,
  });
}

function asEntries(messages: ChatMessage[]): FeedEntry[] {
  return messages.map((msg) => ({ kind: "message", msg }));
}

function renderFeed(messages: ChatMessage[]) {
  return render(
    <FeedEntries
      entries={asEntries(messages)}
      sessionId={SESSION_ID}
      isCodexSession={true}
      activeCodexTerminalIds={new Set()}
      onOpenCodexTerminal={() => {}}
    />,
  );
}

beforeEach(() => {
  scrollIntoView.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  useStore.setState({
    compactToolActivity: false,
    expandAllInTurn: new Map(),
    sessionSearch: new Map(),
    sessionNotifications: new Map(),
    sessions: new Map(),
    sdkSessions: [],
  });
});

describe("collectTimerMessageBatch", () => {
  it("collects the reported recurring sequence while retaining every unique occurrence", () => {
    const timers = Array.from({ length: 10 }, (_, index) => makeTimer(`timer-${index + 1}`, 1_000 + index * 1_800_000));
    const batch = collectTimerMessageBatch(asEntries(timers), 0);

    expect(batch?.messages.map((message) => message.id)).toEqual(timers.map((message) => message.id));
    expect(batch?.nextIndex).toBe(10);
  });

  it("deduplicates replayed message identity instead of inventing another firing", () => {
    const timer = makeTimer("timer-1", 1_000);
    const batch = collectTimerMessageBatch(asEntries([timer, { ...timer }]), 0);

    expect(batch?.messages).toHaveLength(1);
    expect(batch?.nextIndex).toBe(2);
  });

  it.each([
    [
      "different timer id",
      makeTimer("timer-2", 2_000, {
        content: TIMER_CONTENT.replaceAll("t20", "t21"),
        agentSource: { sessionId: "timer:t21", sessionLabel: "Timer t21" },
      }),
    ],
    ["changed reminder", makeTimer("timer-2", 2_000, { content: `${TIMER_CONTENT}\nChanged detail.` })],
    ["changed route", makeTimer("timer-2", 2_000, { metadata: { threadKey: "q-1903", questId: "q-1903" } })],
    [
      "cancelled timer",
      makeTimer("timer-2", 2_000, { content: "[⏰ Timer t20 cancelled] Monitor disjoint ChaiFlow batch" }),
    ],
  ])("does not merge a %s", (_label, second) => {
    expect(collectTimerMessageBatch(asEntries([makeTimer("timer-1", 1_000), second]), 0)).toBeNull();
  });

  it("crosses only explicitly invisible projection rows", () => {
    const invisible = makeMessage({ id: "empty-assistant", role: "assistant", content: "", timestamp: 1_500 });
    const visible = makeMessage({
      id: "visible-assistant",
      role: "assistant",
      content: "Status changed",
      timestamp: 1_500,
    });
    const first = makeTimer("timer-1", 1_000);
    const second = makeTimer("timer-2", 2_000);

    expect(
      collectTimerMessageBatch(asEntries([first, invisible, second]), 0, {
        isInvisible: (entry) => entry.kind === "message" && entry.msg.id === invisible.id,
      })?.messages,
    ).toHaveLength(2);
    expect(
      collectTimerMessageBatch(asEntries([first, visible, second]), 0, {
        isInvisible: () => false,
      }),
    ).toBeNull();
  });

  it("preserves date boundaries as separate chronological groups", () => {
    const first = makeTimer("timer-1", 1_000);
    const second = makeTimer("timer-2", 86_401_000);
    expect(
      collectTimerMessageBatch(asEntries([first, second]), 0, {
        isDateBoundary: (message) => message.id === second.id,
      }),
    ).toBeNull();
  });
});

describe("TimerMessageGroup", () => {
  it("renders one counted row and discloses timestamped full occurrence history", () => {
    const messages = [makeTimer("timer-1", 1_786_919_543_955), makeTimer("timer-2", 1_786_921_345_075)];
    const { container } = render(<TimerMessageGroup messages={messages} sessionId={SESSION_ID} />);

    expect(screen.getByText("2 firings")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "t20 occurrence history" })).toBeNull();
    expect(container.querySelector('[data-message-id="timer-2"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Expand 2 firings for t20/ }));
    const history = screen.getByRole("list", { name: "t20 occurrence history" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(2);
    expect(within(history).getByText("Occurrence 1")).toBeTruthy();
    expect(within(history).getByText("Occurrence 2")).toBeTruthy();
    expect(within(history).getAllByText(/Earlier note:/)).toHaveLength(2);
    expect(screen.queryByText("timer-1")).toBeNull();
  });

  it("opens and scrolls to a child identity requested by message navigation", async () => {
    const messages = [makeTimer("timer-1", 1_000), makeTimer("timer-2", 2_000), makeTimer("timer-3", 3_000)];
    useStore.setState({ expandAllInTurn: new Map([[SESSION_ID, "timer-3"]]) });

    render(<TimerMessageGroup messages={messages} sessionId={SESSION_ID} />);

    await waitFor(() => expect(screen.getByRole("list", { name: "t20 occurrence history" })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Collapse 3 firings for t20/ })).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("opens the group when a child is the current search match", async () => {
    const messages = [makeTimer("timer-1", 1_000), makeTimer("timer-2", 2_000)];
    useStore.setState({
      sessionSearch: new Map([
        [
          SESSION_ID,
          {
            query: "terminal accounting",
            isOpen: true,
            mode: "strict",
            category: "event",
            matches: [{ messageId: "timer-2" }],
            currentMatchIndex: 0,
          },
        ],
      ]),
    });

    render(<TimerMessageGroup messages={messages} sessionId={SESSION_ID} />);
    await waitFor(() => expect(screen.getByRole("list", { name: "t20 occurrence history" })).toBeTruthy());
    expect(document.querySelector('[data-message-id="timer-2"]')).toBeTruthy();
  });
});

describe("timer grouping in FeedEntries", () => {
  it("compacts the ten distinct producer-shaped firings into one row", () => {
    // Session-scoped firing references distinguish answer targets while
    // compatible recurring events keep their existing presentation group.
    const messages = Array.from({ length: 10 }, (_, index) =>
      makeTimer(`timer-${index + 1}`, 1_000 + index * 1_800_000, {
        metadata: { leaderTimerMessageId: `f${index + 1}`, threadKey: "main" },
      }),
    );
    renderFeed(messages);

    expect(screen.getAllByTestId("timer-message-group")).toHaveLength(1);
    expect(screen.getByText("10 firings")).toBeTruthy();
    expect(screen.getAllByText("Monitor disjoint ChaiFlow batch")).toHaveLength(1);
  });

  it("does not merge across visible conversation or visible failures", () => {
    renderFeed([
      makeTimer("timer-1", 1_000),
      makeMessage({ id: "assistant", role: "assistant", content: "Substantive update", timestamp: 1_500 }),
      makeTimer("timer-2", 2_000),
      makeMessage({ id: "error", role: "system", content: "Backend failed", timestamp: 2_500, variant: "error" }),
      makeTimer("timer-3", 3_000),
    ]);

    expect(screen.queryByTestId("timer-message-group")).toBeNull();
    expect(screen.getAllByText("Monitor disjoint ChaiFlow batch")).toHaveLength(3);
    expect(screen.getByText("Substantive update")).toBeTruthy();
    expect(screen.getByText("Backend failed")).toBeTruthy();
  });

  it("groups across a non-renderable hydration row and renders duplicate identity once", () => {
    const first = makeTimer("timer-1", 1_000);
    const second = makeTimer("timer-2", 2_000);
    const { rerender } = renderFeed([
      first,
      makeMessage({ id: "empty", role: "assistant", content: "", timestamp: 1_500 }),
      second,
    ]);
    expect(screen.getByText("2 firings")).toBeTruthy();

    rerender(
      <FeedEntries
        entries={asEntries([first, { ...first }])}
        sessionId={SESSION_ID}
        isCodexSession={true}
        activeCodexTerminalIds={new Set()}
        onOpenCodexTerminal={() => {}}
      />,
    );
    expect(screen.queryByTestId("timer-message-group")).toBeNull();
    expect(screen.getAllByText("Monitor disjoint ChaiFlow batch")).toHaveLength(1);
  });
});

describe("timer collapsed-turn boundaries", () => {
  it("keeps timer work inside activity instead of replacing substantive leader prose", () => {
    const user = makeMessage({ id: "user", role: "user", content: "Monitor the batch", timestamp: 500 });
    const response = makeMessage({
      id: "response",
      role: "assistant",
      content: "The batch is healthy.",
      timestamp: 750,
      metadata: { leaderUserMessage: true, codexMessagePhase: "final_answer" },
    });
    const timers = [makeTimer("timer-1", 1_000), makeTimer("timer-2", 2_000)];
    const turn = buildFeedModel([user, response, ...timers], true).turns[0];

    expect(turn.notificationEntries.map((entry) => (entry.kind === "message" ? entry.msg.id : null))).toEqual([
      "response",
    ]);
    expect(turn.agentEntries.map((entry) => (entry.kind === "message" ? entry.msg.id : null))).toEqual([
      "timer-1",
      "timer-2",
    ]);
  });
});
