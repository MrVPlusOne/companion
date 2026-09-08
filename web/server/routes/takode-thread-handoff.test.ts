import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage, SessionNotification } from "../session-types.js";
import { buildLeaderThreadResponseState, finalizeRoutedLeaderResponseMessage } from "../leader-thread-response.js";
import { updateLeaderThreadStatusesForAssistantOutput } from "../bridge/thread-routing-reminder.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { leaderResponseProvenCurrentOwnerThreadKey } from "../../shared/leader-thread-response-routing.js";
import { extractThreadStatusMarkersFromText } from "../../shared/thread-status-marker.js";
import { registerTakodeThreadHandoffRoute } from "./takode-thread-handoff.js";
import { registerTakodeNotificationResponseRoute } from "./takode-notification-response.js";
import { _resetThreadAttachmentBroadcastsForTest } from "./takode-thread-attachment-broadcast.js";
import type { RouteContext } from "./context.js";

type Human = Extract<BrowserIncomingMessage, { type: "user_message" }>;
type Assistant = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function human(id: string): Human {
  return {
    type: "user_message",
    id: `raw-${id}`,
    content: `Complete request ${id}`,
    timestamp: Number(id.slice(1)),
    threadKey: "main",
    leaderUserMessageId: id,
    leaderResponseCoverageVersion: 1,
  };
}

function prompt(id: string, text: string): Assistant {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    threadKey: "main",
    timestamp: 10,
    leaderThreadRole: "commentary",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function fixture(history: BrowserIncomingMessage[] = [human("u1"), human("u2")]) {
  const session = {
    id: "leader",
    messageHistory: history,
    notifications: [] as SessionNotification[],
    pendingPermissions: new Map(),
    board: new Map([["q-42", { questId: "q-42", worker: "worker", status: "WORKING", createdAt: 1, updatedAt: 1 }]]),
    state: { leaderThreadStatuses: {} },
  };
  const bridge = {
    getSession: vi.fn(() => session),
    broadcastToSession: vi.fn(),
    persistSessionById: vi.fn(),
    promoteLeaderThreadTabForAttachment: vi.fn(),
    injectUserMessage: vi.fn(() => "sent"),
  };
  const auth = vi.fn(() => ({ callerId: "leader", caller: { isOrchestrator: true } }));
  const app = new Hono();
  const context = {
    wsBridge: bridge,
    launcher: { getSession: () => ({ sessionId: "leader" }) },
    authenticateTakodeCaller: auth,
    resolveId: (id: string) => id,
  } as unknown as RouteContext;
  registerTakodeThreadHandoffRoute(app, context);
  registerTakodeNotificationResponseRoute(app, context, {
    persistSession: () => bridge.persistSessionById("leader"),
  });
  const handoff = (body: Record<string, unknown> = { questId: "q-42", userMessageIds: ["u1"] }) =>
    app.request("/sessions/leader/thread/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { session, bridge, auth, app, handoff };
}

function ready(session: ReturnType<typeof fixture>["session"], threadKey: string) {
  const markers = extractThreadStatusMarkersFromText(`{[(Thread Ready: ${threadKey} | complete)]}`).markers;
  return updateLeaderThreadStatusesForAssistantOutput(session, markers, { messageId: "ready", timestamp: 100 });
}

afterEach(() => {
  _resetThreadAttachmentBroadcastsForTest();
  vi.useRealTimers();
});

describe("Main-to-quest responsibility handoff", () => {
  it("moves only selected pending IDs, preserves raw history, and retains every Ready guard", async () => {
    // Route the actual mutation through Hono; eligibility alone must never set Main Ready.
    const { session, bridge, handoff } = fixture();
    const original = structuredClone(session.messageHistory);
    ready(session, "q-42");
    expect((await handoff()).status).toBe(200);
    expect(session.state.leaderThreadStatuses).not.toHaveProperty("q-42");
    expect(session.state.leaderThreadStatuses).not.toHaveProperty("main");
    expect(session.messageHistory[0]).toMatchObject(original[0]!);
    expect(session.messageHistory[1]).toEqual(original[1]);
    expect(session.messageHistory).toHaveLength(3);
    expect(
      buildLeaderThreadResponseState(session, "main").projection.pendingMessages.map((row) => row.userMessageId),
    ).toEqual(["u2"]);
    expect(
      buildLeaderThreadResponseState(session, "q-42").projection.pendingMessages.map((row) => row.userMessageId),
    ).toEqual(["u1"]);
    expect(ready(session, "main").records).toEqual([]);
    expect(ready(session, "q-42").records).toEqual([]);
    expect(bridge.persistSessionById).toHaveBeenCalledTimes(1);

    await handoff({ questId: "q-42", userMessageIds: ["u2"] });
    expect(ready(session, "main").records).toHaveLength(1);
    expect(ready(session, "q-42").records).toEqual([]);
  });

  it("is idempotent and broadcasts bounded reference changes rather than full history", async () => {
    vi.useFakeTimers();
    const { session, bridge, handoff } = fixture();
    const first = await (await handoff()).json();
    const snapshot = structuredClone(session.messageHistory);
    expect(await (await handoff()).json()).toMatchObject({
      handedOffUserMessageIds: [],
      alreadyHandedOffUserMessageIds: ["u1"],
    });
    expect(session.messageHistory).toEqual(snapshot);
    expect(Object.keys(first).sort()).toEqual([
      "alreadyHandedOffNotificationIds",
      "alreadyHandedOffUserMessageIds",
      "handedOffUserMessageIds",
      "notificationIds",
      "ok",
      "questId",
      "sessionId",
    ]);
    vi.advanceTimersByTime(100);
    const updates = bridge.broadcastToSession.mock.calls.map((call) => call[1]);
    expect(updates).toEqual([
      expect.objectContaining({
        type: "thread_attachment_update",
        affectedThreadKeys: ["main", "q-42"],
        maxChangedMessages: 100,
        updates: [
          expect.objectContaining({
            changedMessages: [expect.objectContaining({ historyIndex: 0, messageId: "raw-u1" })],
          }),
        ],
      }),
    ]);
    expect(bridge.persistSessionById).toHaveBeenCalledTimes(1);
  });

  it("moves the exact decision without resolving it or changing its original question and board wait", async () => {
    const source = prompt("decision", "May I proceed with the selected change?");
    source.notification = {
      id: "n-1",
      category: "needs-input",
      timestamp: 10,
      threadKey: "main",
      summary: "Approve change",
    };
    const { session, handoff, bridge } = fixture([human("u1"), source]);
    const selected: SessionNotification = {
      ...source.notification,
      id: "n-1",
      messageId: "decision",
      done: false,
      muted: true,
      mutedAt: 11,
      questions: [{ prompt: "May I proceed?", suggestedAnswers: ["Yes", "No"] }],
    };
    const unrelated = { ...selected, id: "n-2", messageId: "other", muted: false };
    session.notifications.push(selected, unrelated);
    Object.assign(session.board.get("q-42")!, { waitForInput: ["n-1"] });
    const original = structuredClone(selected);
    const res = await handoff({ questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-1"] });
    expect(res.status).toBe(200);
    expect(selected).toMatchObject({ ...original, threadKey: "q-42", questId: "q-42" });
    expect(source.message.content).toEqual([{ type: "text", text: "May I proceed with the selected change?" }]);
    expect(source.notification).toMatchObject({ id: "n-1", threadKey: "q-42", questId: "q-42" });
    expect(unrelated.threadKey).toBe("main");
    expect(session.board.get("q-42")).toHaveProperty("waitForInput", ["n-1"]);
    expect(ready(session, "main").records).toEqual([]);
    expect(ready(session, "q-42").records).toEqual([]);
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "leader",
      expect.objectContaining({
        type: "notification_update",
        notifications: expect.arrayContaining([expect.objectContaining({ id: "n-1", threadKey: "q-42", done: false })]),
      }),
    );
    const retry = await handoff({ questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-1"] });
    expect(await retry.json()).toMatchObject({ alreadyHandedOffNotificationIds: ["n-1"] });
  });

  it("fails atomically for invalid request/decision selections, inactive destinations, and old history", async () => {
    // Rejection must leave both request ownership and decision authority untouched.
    for (const body of [
      { questId: "q-42", userMessageIds: ["u1", "u999"] },
      { questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-999"] },
      { questId: "q-43", userMessageIds: ["u1"] },
    ]) {
      const { session, bridge, handoff } = fixture();
      const before = structuredClone(session.messageHistory);
      expect((await handoff(body)).status).toBe(409);
      expect(session.messageHistory).toEqual(before);
      expect(bridge.persistSessionById).not.toHaveBeenCalled();
    }
    const old = fixture(Array.from({ length: 305 }, (_, index) => human(`u${index + 1}`)));
    expect((await old.handoff()).status).toBe(400);
    expect(old.session.messageHistory[0]?.threadRefs).toBeUndefined();
    expect(old.bridge.persistSessionById).not.toHaveBeenCalled();
  });

  it.each(["absent", "id-less"])("retains retry proof for a legacy %s notification payload", async (kind) => {
    // Both accepted legacy shapes must remain retryable after the first command succeeds.
    const source = prompt("legacy-decision", "May I proceed?");
    if (kind === "id-less") source.notification = { category: "needs-input", timestamp: 10, threadKey: "main" };
    const { session, handoff } = fixture([human("u1"), source]);
    session.notifications.push({
      id: "n-1",
      category: "needs-input",
      timestamp: 10,
      threadKey: "main",
      messageId: "legacy-decision",
      done: false,
    });
    const selection = { questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-1"] };
    expect((await handoff(selection)).status).toBe(200);
    expect(source.notification).toMatchObject({ id: "n-1", threadKey: "q-42" });
    expect(await (await handoff(selection)).json()).toMatchObject({ alreadyHandedOffNotificationIds: ["n-1"] });
  });

  it("uses newer ownership evidence than both canonical and inline notification refs", async () => {
    // Direct routes alone are insufficient: Ready and retries use the latest authoritative ref.
    const future = Date.now() + 100_000;
    const source = prompt("decision", "May I proceed?");
    source.notification = {
      id: "n-1",
      category: "needs-input",
      timestamp: 10,
      threadKey: "main",
      threadRefs: [{ threadKey: "main", source: "explicit", attachedAt: future + 1 }],
    };
    const { session, handoff } = fixture([human("u1"), source]);
    session.notifications.push({
      ...source.notification,
      id: "n-1",
      messageId: "decision",
      done: false,
      threadRefs: [{ threadKey: "main", source: "explicit", attachedAt: future }],
    });
    const selection = { questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-1"] };
    expect((await handoff(selection)).status).toBe(200);
    expect(leaderResponseProvenCurrentOwnerThreadKey(session.notifications[0]!)).toBe("q-42");
    expect(leaderResponseProvenCurrentOwnerThreadKey(source.notification)).toBe("q-42");
    expect(await (await handoff(selection)).json()).toMatchObject({ alreadyHandedOffNotificationIds: ["n-1"] });
  });

  it("routes the real decision reply to the quest even when the submitting tab still says Main", async () => {
    // Exercise the existing response route after handoff: only the actual reply resolves its decision.
    const source = prompt("decision", "May I proceed?");
    source.notification = { id: "n-1", category: "needs-input", timestamp: 10, threadKey: "main" };
    const { session, handoff, app, bridge } = fixture([human("u1"), source]);
    session.notifications.push({ ...source.notification, id: "n-1", messageId: "decision", done: false });
    const selection = { questId: "q-42", userMessageIds: ["u1"], notificationIds: ["n-1"] };
    expect((await handoff(selection)).status).toBe(200);
    expect(session.notifications[0]?.done).toBe(false);
    const reply = await app.request("/sessions/leader/notifications/n-1/response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Yes, proceed.", threadKey: "main" }),
    });
    expect(reply.status).toBe(200);
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      "leader",
      "Yes, proceed.",
      undefined,
      undefined,
      expect.objectContaining({ threadKey: "q-42", questId: "q-42" }),
      expect.objectContaining({
        replyContext: expect.objectContaining({ notificationId: "n-1", messageId: "decision" }),
      }),
    );
    expect(session.notifications[0]?.done).toBe(true);
    expect(await (await handoff(selection)).json()).toMatchObject({ alreadyHandedOffNotificationIds: ["n-1"] });
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated settled shared answers in producer-built windows across persistence", async () => {
    const prior = human("u1");
    prior.threadRefs = [{ threadKey: "q-42", questId: "q-42", source: "backfill" }];
    const { session, handoff } = fixture([prior, human("u2")]);
    const answer = prompt("shared-answer", "The earlier request is complete.");
    Object.assign(answer, {
      threadKey: "q-42",
      questId: "q-42",
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
      leaderThreadRole: "answer",
      leaderAnswerUserMessageIds: ["u1"],
      leaderAnswerObservedHistoryLength: 2,
    });
    session.messageHistory.push(answer);
    expect(finalizeRoutedLeaderResponseMessage(session, answer).finalized).toBe(true);
    const proof = structuredClone(answer.threadAnswer);
    expect((await handoff({ questId: "q-42", userMessageIds: ["u2"] })).status).toBe(200);
    expect(answer.threadAnswer).toEqual(proof);
    const restored = { id: session.id, messageHistory: JSON.parse(JSON.stringify(session.messageHistory)) };
    for (const threadKey of ["main", "q-42"]) {
      const state = buildLeaderThreadResponseState(restored, threadKey).projection;
      expect(state.currentAnswers.some((row) => row.currentMessageId === "shared-answer")).toBe(true);
      const window = buildThreadWindowSync({
        messageHistory: restored.messageHistory,
        threadKey,
        fromItem: -1,
        itemCount: 20,
        sectionItemCount: 20,
        visibleItemCount: 20,
        currentThreadResponseProjection: state,
      });
      expect(window.threadResponseSupportComplete).toBe(true);
      expect(
        window.entries.filter(
          (entry) => entry.message.type === "assistant" && entry.message.message.id === "shared-answer",
        ),
      ).toHaveLength(1);
    }
  });

  it("keeps one Main notice while later quest discussion stays in the destination", async () => {
    // This is the product handoff: keep the raw request, publish one notice,
    // and deliver later commentary only through the selected quest window.
    const { session, handoff } = fixture([human("u1")]);
    await handoff();
    const notice = prompt("main-notice", "Continuing this discussion in [the quest](quest:q-42).");
    const progress = prompt("quest-progress", "The requested change is in progress.");
    Object.assign(progress, {
      threadKey: "q-42",
      questId: "q-42",
      threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "explicit" }],
    });
    session.messageHistory.push(notice, progress);
    const view = (threadKey: string) =>
      buildThreadWindowSync({
        messageHistory: session.messageHistory,
        threadKey,
        fromItem: -1,
        itemCount: 20,
        sectionItemCount: 20,
        visibleItemCount: 20,
        currentThreadResponseProjection: buildLeaderThreadResponseState(session, threadKey).projection,
      }).entries.map((entry) => entry.message);
    expect(
      view("main").filter((entry) => entry.type === "assistant" && entry.message.id === notice.message.id),
    ).toHaveLength(1);
    expect(view("main")).not.toContain(progress);
    expect(view("q-42")).toContain(progress);
    expect(view("q-42")).toContain(session.messageHistory[0]);
    expect(
      session.messageHistory.filter((entry) => entry.type === "user_message" && entry.id === "raw-u1"),
    ).toHaveLength(1);
  });
});
