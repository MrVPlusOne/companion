// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { buildFeedModel } from "../hooks/use-feed-model.js";
import { useStore } from "../store.js";
import type { BrowserIncomingMessage, ContentBlock, SessionNotification, ToolResultPreview } from "../types.js";
import { collectAnchoredNotificationMessageIds } from "../utils/anchored-notifications.js";
import { buildFeedMessageModel } from "../utils/feed-render-model.js";
import { normalizeHistoryMessageToChatMessages } from "../utils/history-message-normalization.js";
import { FeedNotificationProvider } from "./FeedNotificationContext.js";
import { MessageBubble } from "./MessageBubble.js";
import { ReadyThreadResponseRows } from "./ReadyThreadResponseRows.js";
import type { ThreadResponsePresentation } from "./thread-response-presentation.js";

const markNotificationDone = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const getToolResult = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ api: { markNotificationDone, getToolResult } }));

const SESSION_ID = "leader-proposal-context";
const THREAD_KEY = "q-310";
const PROPOSAL_SUMMARY =
  "## Goal / Acceptance\n\nUse **one shared budget** for each case.\n\n- Preserve tool execution limits.\n- Keep [source context](quest:q-309:feedback:2).\n\nApprove this definition?";
const NOTIFICATION_SUMMARY = "Confirm the proposed budget";
const route = {
  threadKey: THREAD_KEY,
  questId: THREAD_KEY,
  threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" as const }],
};

function assistant(id: string, timestamp: number, content: ContentBlock[]): BrowserIncomingMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp,
    ...route,
    message: { id, content },
  } as BrowserIncomingMessage;
}

function preview(toolUseId: string, content: string): ToolResultPreview {
  return { tool_use_id: toolUseId, content, is_error: false, total_size: content.length, is_truncated: false };
}

function fixture(done: boolean) {
  const notification: SessionNotification = {
    id: "n-870",
    category: "needs-input",
    summary: NOTIFICATION_SUMMARY,
    questions: [{ prompt: "Approve one shared budget?", suggestedAnswers: ["Approve", "Revise"] }],
    timestamp: 350,
    messageId: "old-closure",
    done,
    ...route,
  };
  const proposalResult = preview(
    "proposal-tool",
    JSON.stringify({
      __takode_board__: true,
      board: [],
      proposalReview: {
        questId: THREAD_KEY,
        title: "Simplify retry handling",
        status: "PROPOSED",
        journey: { presetId: "custom", phaseIds: ["alignment", "work", "memory"], mode: "proposed" },
        presentedAt: 300,
        summary: PROPOSAL_SUMMARY,
      },
    }),
  );
  const notifyResult = preview("notify-tool", "Notification sent (needs-input, id 870)");
  const old = assistant("old-closure", 100, [{ type: "text", text: "Earlier work is closed." }]);
  Object.assign(old, { notification });
  const history: BrowserIncomingMessage[] = [
    { type: "user_message", id: "old-request", content: "Review the earlier work.", timestamp: 50, ...route },
    old,
    {
      type: "user_message",
      id: "new-request",
      content: "Implement the simpler approach.",
      timestamp: 200,
      threadKey: "q-311",
      questId: "q-311",
      threadRefs: [
        { threadKey: "q-311", questId: "q-311", source: "explicit" },
        { threadKey: THREAD_KEY, questId: THREAD_KEY, source: "backfill", attachedAt: 250 },
      ],
    },
    assistant("proposal-source", 300, [
      {
        type: "tool_use",
        id: "proposal-tool",
        name: "Bash",
        input: { command: `takode board propose ${THREAD_KEY} --summary '${PROPOSAL_SUMMARY}'` },
      },
    ]),
    { type: "tool_result_preview", previews: [proposalResult] },
    // The observed Codex source was persisted shortly after notification creation.
    assistant("notify-source", 385, [
      {
        type: "tool_use",
        id: "notify-tool",
        name: "Bash",
        input: { command: `takode notify needs-input '${NOTIFICATION_SUMMARY}'` },
      },
    ]),
    { type: "tool_result_preview", previews: [notifyResult] },
    {
      ...assistant("acknowledgement", 400, [{ type: "text", text: "The proposal is ready for confirmation." }]),
      leaderThreadRole: "commentary",
    } as BrowserIncomingMessage,
  ];
  const toolResults = new Map([
    [proposalResult.tool_use_id, proposalResult],
    [notifyResult.tool_use_id, notifyResult],
  ]);
  // Use the real window producer and normalizer so attachment membership and
  // source indices have the same shape as browser delivery.
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey: THREAD_KEY,
    fromItem: 0,
    itemCount: 30,
    sectionItemCount: 10,
    visibleItemCount: 3,
  });
  const delivered = sync.entries.flatMap(({ message, history_index }) =>
    normalizeHistoryMessageToChatMessages(message, history_index),
  );
  const model = buildFeedMessageModel({
    leaderSessionId: SESSION_ID,
    threadKey: THREAD_KEY,
    projectThreadRoutes: true,
    allMessages: [],
    historyLoading: false,
    selectedFeedWindowEnabled: true,
    selectedFeedWindow: sync.window,
    selectedFeedWindowMessages: delivered,
    sessionNotifications: [notification],
    toolResults,
  });
  const feed = buildFeedModel(
    model.messages,
    true,
    0,
    collectAnchoredNotificationMessageIds(model.displayNotifications),
  );
  return { history, notification, toolResults, delivered, model, feed };
}

beforeEach(() => {
  useStore.getState().reset();
  markNotificationDone.mockClear();
  getToolResult.mockClear();
});
afterEach(cleanup);

describe("Source-owned proposal and notification presentation", () => {
  it.each([false, true])("shows the original proposal and exact notify source in order with done=%s", async (done) => {
    const { history, notification, toolResults, delivered, model, feed } = fixture(done);
    const before = JSON.stringify({ history, notification, delivered });
    useStore.setState({
      compactToolActivity: true,
      sessionNotifications: new Map([[SESSION_ID, [notification]]]),
      toolResults: new Map([[SESSION_ID, toolResults]]),
      messages: new Map([[SESSION_ID, delivered]]),
    });
    const presentation: ThreadResponsePresentation = {
      ready: true,
      cutoverHistoryIndex: 0,
      pendingMessageCount: 0,
      currentResponses: [],
      currentResponseMessageIds: new Set(),
      quizGroups: [],
      layoutSignature: "source-owned-decisions",
    };
    const view = render(
      <FeedNotificationProvider sessionId={SESSION_ID} notifications={model.displayNotifications}>
        {feed.turns.map((turn) => (
          <div key={turn.id}>
            {turn.userEntry?.kind === "message" && (
              <div data-source={turn.userEntry.msg.id}>{turn.userEntry.msg.content}</div>
            )}
            <ReadyThreadResponseRows
              turn={turn}
              presentation={presentation}
              sessionId={SESSION_ID}
              questLinkSurface="chat-feed"
              activeNeedsInputAnchorMessageIds={model.activeNeedsInputAnchorMessageIds}
              renderEntry={(entry) =>
                entry.kind === "message" && (
                  <div data-source={entry.msg.id}>
                    <MessageBubble
                      message={entry.msg}
                      sessionId={SESSION_ID}
                      currentThreadKey={THREAD_KEY}
                      backendType="codex"
                    />
                  </div>
                )
              }
            />
          </div>
        ))}
      </FeedNotificationProvider>,
    );

    // Real proposal markup must survive bounded delivery and collapsed source
    // retention for both pending and resolved decisions, without rewriting data.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Goal / Acceptance" })).toBeInTheDocument());
    expect(screen.getByText("one shared budget").tagName).toBe("STRONG");
    expect(screen.getByText("Preserve tool execution limits.").closest("li")).not.toBeNull();
    expect(screen.getByRole("link", { name: "source context" }).getAttribute("href")).toContain(
      "quest=q-309&feedback=2",
    );
    expect(screen.getAllByText("Approve this definition?")).toHaveLength(1);
    expect(screen.getAllByText(NOTIFICATION_SUMMARY)).toHaveLength(1);
    expect(view.container.querySelector('[data-notification-id="n-870"]')?.closest("[data-source]")).toHaveAttribute(
      "data-source",
      "notify-source",
    );
    expect(
      [...view.container.querySelectorAll("[data-source]")].map((element) => element.getAttribute("data-source")),
    ).toEqual(["old-request", "new-request", "proposal-source", "notify-source"]);
    expect(screen.queryByText("Earlier work is closed.")).not.toBeInTheDocument();
    expect(getToolResult).not.toHaveBeenCalled();
    expect(JSON.stringify({ history, notification, delivered })).toBe(before);
    expect(useStore.getState().sessionNotifications.get(SESSION_ID)?.[0]).toBe(notification);

    // Display relocation never changes the authoritative notification action ID.
    fireEvent.click(screen.getByRole("button", { name: done ? "Mark unhandled" : "Mark handled" }));
    expect(markNotificationDone).toHaveBeenCalledWith(SESSION_ID, "n-870", !done);
  });
});
