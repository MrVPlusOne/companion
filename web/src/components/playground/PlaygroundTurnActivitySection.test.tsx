// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeaderThreadResponseState } from "../../../server/leader-thread-response.js";
import { appendThreadTransitionMarkerForRouteSwitch } from "../../../server/thread-routing-metadata.js";
import { buildFeedModel } from "../../hooks/use-feed-model.js";
import { useStore } from "../../store.js";
import { buildTurnActivityFixtureWindow, turnActivityFixture } from "../../test-fixtures/turn-activity-disclosure.js";
import type { BrowserIncomingMessage, SessionState } from "../../types.js";
import { createWsMessageHandler } from "../../ws-handlers.js";
import { normalizeHistoryMessageToChatMessages } from "../../utils/history-message-normalization.js";
import { MessageFeed } from "../MessageFeed.js";
import { TurnEntriesExpanded } from "../MessageFeedTurns.js";
import { PlaygroundTurnActivitySection } from "./PlaygroundTurnActivitySection.js";

vi.mock("../../api.js", () => ({
  api: { getQuestValidated: vi.fn().mockResolvedValue({ status: "not-modified", etag: '"activity-fixture"' }) },
}));
vi.mock("../../ws.js", () => ({ sendToSession: vi.fn(() => false) }));
vi.mock("../../utils/notification-sound.js", () => ({
  playNotificationSound: vi.fn(),
  playNeedsInputSound: vi.fn(),
  playReviewSound: vi.fn(),
}));

beforeEach(() => {
  useStore.getState().reset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixtureSession(backend: "claude" | "codex"): SessionState {
  return {
    session_id: turnActivityFixture.sessionId,
    backend_type: backend,
    isOrchestrator: true,
    model: "fixture",
    cwd: "/tmp/playground",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/tmp/playground",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function assertDisclosureFlow(container: HTMLElement) {
  const turn = container.querySelector<HTMLElement>('[data-turn-id="activity-request"]')!;
  const view = within(turn);
  // Retain the existing Turn.stats accounting, including its superseded-answer case.
  const disclosure = view.getByRole("button", {
    name: "Show turn activity · 1m 13s · 3 messages · 5 tools · 2 worker events",
  });
  const firstAnswer = view.getByText(/The list now keeps your filters/);
  const secondAnswer = view.getByText(/One additional detail:/);
  expect(disclosure.compareDocumentPosition(firstAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(view.getAllByRole("button", { name: /Show turn activity/ })).toHaveLength(1);
  expect(turn.querySelectorAll("[data-turn-activity]")).toHaveLength(0);
  expect(secondAnswer).toBeVisible();

  disclosure.focus();
  fireEvent.click(disclosure);
  expect(view.getByRole("button", { name: /Hide turn activity/ })).toBe(disclosure);
  expect(document.activeElement).toBe(disclosure);
  const runs = turn.querySelectorAll<HTMLElement>("[data-turn-activity]");
  expect(runs).toHaveLength(3);
  expect(within(runs[0]!).getByText(/I’ll check how the list restores/)).toBeVisible();
  expect(within(runs[1]!).getByText(/I’m also checking/)).toBeVisible();
  // The producer-authored continuation markers stay inside
  // the same guide as adjacent activity, rather than splitting it into five runs.
  const transitions = view.getAllByTestId("thread-transition-marker");
  expect(transitions).toHaveLength(2);
  expect(transitions[0].closest("[data-turn-activity]")).toBe(runs[0]);
  expect(transitions[1].closest("[data-turn-activity]")).toBe(runs[1]);
  // Provider final_answer on a leader commentary row does not make it an
  // explicit answer or justify a different visual level from other activity.
  expect(view.getByText(/The worker has confirmed filter restoration/).closest("[data-turn-activity]")).toBe(runs[0]);
  expect(view.getByText(/The list now keeps your filters/).closest("[data-turn-activity]")).toBeNull();
  const expandedSecond = view.getByText(/One additional detail:/);
  expect(expandedSecond.closest("[data-turn-activity]")).toBeNull();
  expect(expandedSecond.compareDocumentPosition(runs[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

  // Expanding each worker event retains its complete audit text in place and
  // does not add an answer or replace the turn's persistent control.
  for (const run of [runs[0]!, runs[1]!]) {
    fireEvent.click(within(run).getByRole("button", { name: /^Show .*activity item/ }));
  }
  expect(within(runs[0]!).getByText(/Filter restoration checks passed\./)).toBeVisible();
  expect(within(runs[1]!).getByText(/Separate-list filter checks passed\./)).toBeVisible();

  // The post-answer tool batch remains inspectable rather than moving before the answers.
  fireEvent.click(within(runs[2]!).getByRole("button", { name: /Show 2 tool calls/ }));
  expect(within(runs[2]!).getByText("inspect regression cases")).toBeVisible();
  fireEvent.click(disclosure);
  expect(view.getByRole("button", { name: /Show turn activity/ })).toBe(disclosure);
  expect(document.activeElement).toBe(disclosure);
  expect(view.getByText(/One additional detail:/)).toBeVisible();
  expect(turn.querySelectorAll("[data-turn-activity]")).toHaveLength(0);
}

describe("turn activity disclosure integration", () => {
  it("keeps the retained fixture aligned with the server response and shared-window producers", () => {
    // This snapshot contains synthetic finalized history, not frontend-authored response proof.
    const projection = buildLeaderThreadResponseState(
      {
        id: turnActivityFixture.sessionId,
        messageHistory: structuredClone(turnActivityFixture.history),
      },
      turnActivityFixture.threadKey,
    ).projection;
    expect(projection).toEqual(turnActivityFixture.projection);
    const window = buildTurnActivityFixtureWindow();
    expect(window.threadResponseSupportComplete).toBe(true);
    expect(window.threadResponseProjection?.currentAnswers).toHaveLength(2);
    const history: BrowserIncomingMessage[] = [];
    for (const message of turnActivityFixture.history) {
      if (message.type !== "thread_transition_marker") {
        history.push(message);
        continue;
      }
      expect(
        appendThreadTransitionMarkerForRouteSwitch(
          history,
          { threadKey: message.threadKey, questId: message.questId },
          message.timestamp,
        ),
      ).toEqual(message);
    }
  });

  it.each([
    "claude",
    "codex",
  ] as const)("preserves chronology and the single mounted control in the %s MessageFeed", (backend) => {
    // Exercise the real store delivery and MessageFeed path on producer-built windows.
    const receive = createWsMessageHandler({ sendToSession: () => false, disconnectSession: () => {} });
    const sync = buildTurnActivityFixtureWindow();
    act(() => {
      receive(turnActivityFixture.sessionId, { type: "session_init", session: fixtureSession(backend) });
      receive(turnActivityFixture.sessionId, {
        type: "thread_window_sync",
        thread_key: turnActivityFixture.threadKey,
        entries: sync.entries,
        window: sync.window,
        response_state: sync.threadResponseProjection,
      });
      for (const message of turnActivityFixture.history) {
        if (message.type === "tool_result_preview") receive(turnActivityFixture.sessionId, message);
      }
    });
    const onSelectThread = vi.fn();
    const { container } = render(
      <MessageFeed
        sessionId={turnActivityFixture.sessionId}
        threadKey={turnActivityFixture.threadKey}
        onSelectThread={onSelectThread}
      />,
    );
    assertDisclosureFlow(container);
    fireEvent.click(screen.getByRole("button", { name: /^Show turn activity/ }));
    const marker = within(screen.getAllByTestId("thread-transition-marker")[0]);
    fireEvent.click(marker.getByRole("button", { name: "current thread" }));
    expect(onSelectThread).toHaveBeenLastCalledWith("q-42");
    fireEvent.click(marker.getByRole("button", { name: "thread:q-43" }));
    expect(onSelectThread).toHaveBeenLastCalledWith("q-43");
  });

  it.each([
    { type: "error", id: "guide-error", timestamp: 1788955202600, message: "Background check failed." },
    {
      type: "compact_marker",
      id: "guide-compaction",
      timestamp: 1788955202600,
      summary: "Earlier activity compacted.",
    },
    {
      type: "task_notification",
      task_id: "guide-check",
      tool_use_id: "activity-first-tools-0",
      status: "completed",
      summary: "Background filter check finished.",
    },
  ] satisfies BrowserIncomingMessage[])("keeps $type events visible without breaking the guide", (event) => {
    // Unrouted events belong to full history, not an invented quest route. Use
    // the real normalizer/model to derive Turn data for the shared renderer.
    const index = turnActivityFixture.history.findIndex((message) => message.type === "thread_transition_marker");
    const history = turnActivityFixture.history.map((message, messageIndex) =>
      messageIndex === index ? event : message,
    );
    const model = buildFeedModel(
      history.flatMap((message, historyIndex) => normalizeHistoryMessageToChatMessages(message, historyIndex)),
      true,
    );
    const normalizedEvent = normalizeHistoryMessageToChatMessages(event, index)[0];
    const { container } = render(
      <TurnEntriesExpanded
        turn={model.turns[0]}
        sessionId={turnActivityFixture.sessionId}
        isCodexSession
        activeCodexTerminalIds={new Set()}
        onOpenCodexTerminal={() => {}}
      />,
    );
    const runs = container.querySelectorAll("[data-turn-activity]");
    expect(runs).toHaveLength(3);
    expect(screen.getByText(normalizedEvent.content)).toBeVisible();
    expect(container.querySelector(`[data-message-id="${normalizedEvent.id}"]`)?.closest("[data-turn-activity]")).toBe(
      runs[0],
    );
    expect(screen.getByText(/One additional detail:/).closest("[data-turn-activity]")).toBeNull();
    expect(model.turns[1].id).toBe("activity-next-request");
    expect(screen.queryByText("Does that also work when I open an item in a new tab?")).not.toBeInTheDocument();
  });

  it("offers the same production rendering in Playground without opening a backend session", () => {
    // The focused browser fixture must not fetch, connect, or change source history.
    const before = JSON.stringify(turnActivityFixture);
    const previousResults = useStore.getState().toolResults.get(turnActivityFixture.sessionId);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const socket = vi.spyOn(globalThis, "WebSocket");
    const view = render(<PlaygroundTurnActivitySection />);
    assertDisclosureFlow(screen.getByTestId("playground-turn-activity"));
    // The reported long-duration example uses the real summary control and
    // retains its formatted value and counts when switching display states.
    const duration = within(screen.getByTestId("playground-turn-duration"));
    const summary = "17h 13min · 9 messages · 18 tools · 5 worker events";
    const control = duration.getByRole("button", { name: `Show turn activity · ${summary}` });
    fireEvent.click(control);
    expect(duration.getByRole("button", { name: `Hide turn activity · ${summary}` })).toBe(control);
    view.unmount();
    expect(fetch).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.has(turnActivityFixture.sessionId)).toBe(false);
    expect(useStore.getState().toolResults.get(turnActivityFixture.sessionId)).toBe(previousResults);
    expect(JSON.stringify(turnActivityFixture)).toBe(before);
  });

  it("retains worker audit and tool access when compact tool activity is disabled", () => {
    // The common activity level also hosts ordinary tool groups. Their separate
    // display preference must not change answer selection or lose worker detail.
    useStore.setState({ compactToolActivity: false });
    render(<PlaygroundTurnActivitySection />);
    const view = within(screen.getByTestId("playground-turn-activity"));
    fireEvent.click(view.getByRole("button", { name: /^Show turn activity/ }));
    expect(view.getByText("inspect regression cases")).toBeVisible();
    expect(view.getByText(/The list now keeps your filters/)).toBeVisible();
    expect(view.getByText(/One additional detail:/)).toBeVisible();
    fireEvent.click(view.getByRole("button", { name: /#8.*turn_end/ }));
    expect(view.getByText(/Filter restoration checks passed\./)).toBeVisible();
    expect(view.getAllByRole("button", { name: /^Hide turn activity/ })).toHaveLength(1);
  });
});
