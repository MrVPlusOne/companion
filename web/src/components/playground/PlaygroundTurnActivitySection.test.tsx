// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeaderThreadResponseState } from "../../../server/leader-thread-response.js";
import { useStore } from "../../store.js";
import { buildTurnActivityFixtureWindow, turnActivityFixture } from "../../test-fixtures/turn-activity-disclosure.js";
import type { SessionState } from "../../types.js";
import { createWsMessageHandler } from "../../ws-handlers.js";
import { MessageFeed } from "../MessageFeed.js";
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
  const disclosure = view.getByRole("button", { name: "Show turn activity · 1m 13s · 3 messages · 5 tools" });
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
  expect(view.getByText(/The list now keeps your filters/).closest("[data-turn-activity]")).toBeNull();
  const expandedSecond = view.getByText(/One additional detail:/);
  expect(expandedSecond.closest("[data-turn-activity]")).toBeNull();
  expect(expandedSecond.compareDocumentPosition(runs[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

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
    const { container } = render(
      <MessageFeed sessionId={turnActivityFixture.sessionId} threadKey={turnActivityFixture.threadKey} />,
    );
    assertDisclosureFlow(container);
  });

  it("offers the same production rendering in Playground without opening a backend session", () => {
    // The focused browser fixture must not fetch, connect, or change source history.
    const before = JSON.stringify(turnActivityFixture);
    const previousResults = useStore.getState().toolResults.get(turnActivityFixture.sessionId);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fixture request"));
    const socket = vi.spyOn(globalThis, "WebSocket");
    const view = render(<PlaygroundTurnActivitySection />);
    assertDisclosureFlow(screen.getByTestId("playground-turn-activity"));
    view.unmount();
    expect(fetch).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(useStore.getState().sessions.has(turnActivityFixture.sessionId)).toBe(false);
    expect(useStore.getState().toolResults.get(turnActivityFixture.sessionId)).toBe(previousResults);
    expect(JSON.stringify(turnActivityFixture)).toBe(before);
  });
});
