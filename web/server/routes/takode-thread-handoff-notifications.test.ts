import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage, SessionNotification } from "../session-types.js";
import { prepareThreadHandoffNotifications } from "./takode-thread-handoff-notifications.js";

type AssistantMessage = Extract<BrowserIncomingMessage, { type: "assistant" }>;

function prompt(id = "prompt-1"): AssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    timestamp: 100,
    threadKey: "main",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text: "Approve the staged rollout, or keep it paused?" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    notification: {
      id: "n-1",
      category: "needs-input",
      timestamp: 101,
      threadKey: "main",
      summary: "Choose rollout timing",
      suggestedAnswers: ["Approve", "Keep paused"],
    },
  };
}

function fixture() {
  const anchor = prompt();
  const notification: SessionNotification = {
    ...anchor.notification!,
    id: "n-1",
    messageId: anchor.message.id,
    done: false,
    muted: true,
    mutedAt: 102,
    questions: [{ prompt: "When should the rollout start?", suggestedAnswers: ["Now", "Later"] }],
  };
  return { messageHistory: [anchor], notifications: [notification] };
}

function handedOffFixture() {
  const session = fixture();
  const destination = { threadKey: "q-7", questId: "q-7" };
  const ref = { ...destination, source: "explicit" as const, attachedAt: 200 };
  Object.assign(session.notifications[0]!, destination, { threadRefs: [ref] });
  Object.assign(session.messageHistory[0]!.notification!, destination, { threadRefs: [ref] });
  session.messageHistory[0]!.threadRefs = [{ ...ref, source: "backfill" }];
  return session;
}

describe("prepareThreadHandoffNotifications", () => {
  it("prepares only explicitly selected prompts without mutating identity, decisions, or unrelated Main input", () => {
    // Muting is an attention preference; the still-unresolved prompt must retain
    // its exact record and choices through handoff preflight.
    const session = fixture();
    session.notifications.push({ ...session.notifications[0]!, id: "n-2", messageId: "another-prompt" });
    const before = structuredClone(session);
    const result = prepareThreadHandoffNotifications(session, "q-7", ["n-1"]);

    expect(result).toEqual({
      ok: true,
      notifications: [session.notifications[0]],
      alreadyHandedOffNotificationIds: [],
      anchors: [{ historyIndex: 0, message: session.messageHistory[0] }],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.notifications[0]).toBe(session.notifications[0]);
    expect(result.anchors[0]!.message).toBe(session.messageHistory[0]);
    expect(session).toEqual(before);
  });

  it("accepts an empty selection without inferring notification ownership", () => {
    expect(prepareThreadHandoffNotifications(fixture(), "q-7", [])).toEqual({
      ok: true,
      notifications: [],
      alreadyHandedOffNotificationIds: [],
      anchors: [],
    });
  });

  it.each([
    { ids: ["n-1", "n-1"] },
    { ids: ["1"] },
    { ids: ["n-01"] },
    { ids: ["n-0"] },
    { ids: ["N-1"] },
    { ids: [" n-1"] },
  ])("rejects duplicate or noncanonical IDs $ids", ({ ids }) => {
    expect(prepareThreadHandoffNotifications(fixture(), "q-7", ids)).toMatchObject({ ok: false });
  });

  it("rejects unknown, duplicated, resolved, or non-needs-input notification records", () => {
    // Reusing another prompt or toggling done would discard actual decision state.
    const session = fixture();
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-2"])).toMatchObject({ ok: false });
    session.notifications.push({ ...session.notifications[0]! });
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.notifications.pop();
    session.notifications[0]!.done = true;
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.notifications[0]!.done = false;
    session.notifications[0]!.category = "review";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("requires exactly one original assistant anchor and matching notification metadata", () => {
    const session = fixture();
    session.notifications[0]!.messageId = null;
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.notifications[0]!.messageId = "missing";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.notifications[0]!.messageId = "prompt-1";
    session.messageHistory.push(prompt());
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.messageHistory.pop();
    session.messageHistory[0]!.notification!.id = "n-2";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("does not use child activity, tool-only output, or hidden controls as the visible prompt", () => {
    const session = fixture();
    const anchor = session.messageHistory[0]!;
    anchor.parent_tool_use_id = "child-tool";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    anchor.parent_tool_use_id = null;
    anchor.codexSubagent = { childId: "child-1" };
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    delete anchor.codexSubagent;
    anchor.message.content = [{ type: "tool_use", id: "tool-1", name: "exec", input: { cmd: "true" } }];
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    anchor.message.content = [
      { type: "text", text: "[thread:main:C]\n{[(Thread Waiting: main | work)]}\n<!-- hidden -->" },
    ];
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("accepts absent legacy notification metadata only with independently proven Main prompt ownership", () => {
    const session = fixture();
    delete session.notifications[0]!.threadKey;
    delete session.messageHistory[0]!.notification;
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: true });
    delete session.messageHistory[0]!.threadKey;
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("rejects conflicting direct routes and authoritative reassignment even when a backfill looks correct", () => {
    const session = fixture();
    session.notifications[0]!.questId = "q-8";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    delete session.notifications[0]!.questId;
    session.messageHistory[0]!.threadRefs = [
      { threadKey: "q-8", questId: "q-8", source: "explicit", attachedAt: 150 },
      { threadKey: "q-7", questId: "q-7", source: "backfill", attachedAt: 160 },
    ];
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("recognizes exact handoff retries without adding a second mutation or changing prompt history", () => {
    // A transferred notification retains its original Main assistant anchor;
    // destination backfill proves that the original prompt remains accessible.
    const session = handedOffFixture();
    const before = structuredClone(session);
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toEqual({
      ok: true,
      notifications: [],
      alreadyHandedOffNotificationIds: ["n-1"],
      anchors: [],
    });
    expect(session).toEqual(before);
    expect(prepareThreadHandoffNotifications(session, "q-8", ["n-1"])).toMatchObject({ ok: false });
  });

  it("preserves a resolved target retry and its queued resolution notice while rejecting a resolved Main move", () => {
    // The user may answer after the original handoff succeeded but before a
    // lost HTTP response is retried. That retry must not reopen the decision.
    const session = handedOffFixture();
    Object.assign(session.notifications[0]!, {
      done: true,
      resolutionNotice: {
        status: "queued",
        source: "response",
        resolvedAt: 300,
        queuedInputId: "answer-1",
      },
    });
    const before = structuredClone(session);
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toEqual({
      ok: true,
      notifications: [],
      alreadyHandedOffNotificationIds: ["n-1"],
      anchors: [],
    });
    expect(session).toEqual(before);

    const main = fixture();
    main.notifications[0]!.done = true;
    const mainBefore = structuredClone(main);
    expect(prepareThreadHandoffNotifications(main, "q-7", ["n-1"])).toMatchObject({ ok: false });
    expect(main).toEqual(mainBefore);
  });

  it("rejects partial retry state with missing destination context or a stale anchored route", () => {
    const session = handedOffFixture();
    delete session.messageHistory[0]!.threadRefs;
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
    session.messageHistory[0]!.threadRefs = [{ threadKey: "q-7", questId: "q-7", source: "backfill" }];
    session.messageHistory[0]!.notification!.threadKey = "main";
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1"])).toMatchObject({ ok: false });
  });

  it("does not partially mutate an earlier valid prompt when a later selected notification is invalid", () => {
    const session = fixture();
    const before = structuredClone(session);
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1", "n-2"])).toMatchObject({ ok: false });
    expect(session).toEqual(before);
  });

  it("rejects distinct notifications sharing one selected anchor instead of overwriting its prompt metadata", () => {
    // Legacy prompts can lack inline notification metadata, so duplicate
    // selections must still not produce two competing mutations of one anchor.
    const session = fixture();
    delete session.messageHistory[0]!.notification;
    session.notifications.push({ ...session.notifications[0]!, id: "n-2" });
    const before = structuredClone(session);
    expect(prepareThreadHandoffNotifications(session, "q-7", ["n-1", "n-2"])).toMatchObject({ ok: false });
    expect(session).toEqual(before);
  });
});
