import { describe, expect, it, vi } from "vitest";
import {
  handleUserMessage,
  routeBrowserMessage,
  routeAdapterBrowserMessage,
  type AdapterBrowserRoutingDeps,
  type AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";
import { deriveActiveTurnRoute } from "./browser-transport-controller.js";
import { commitPendingCodexInputs, removePendingCodexInput } from "./codex-recovery-orchestrator.js";
import { withTrustedRecoveryDeliveryTransferRoute } from "./recovery-delivery-transfer-routing-context.js";
import { buildCodexBatchMessageInputs } from "./codex-pending-start-batch.js";
import { withTrustedCodexRecoveryRoute } from "./codex-recovery-routing-context.js";
import { dispatchQueuedCodexTurns } from "./codex-turn-queue.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CodexOutboundTurn,
  PermissionRequest,
  SessionNotification,
} from "../session-types.js";

function makeSession(notifications: SessionNotification[] = []): AdapterBrowserRoutingSessionLike {
  return {
    id: "leader-session",
    backendType: "claude",
    state: {
      askPermission: true,
      backend_error: null,
      backend_state: "connected",
      codex_rate_limits: undefined,
      codex_image_send_stage: null,
      codex_reasoning_effort: undefined,
      codex_token_details: undefined,
      context_used_percent: 0,
      cwd: "/tmp/session",
      is_compacting: false,
      model: "sonnet",
      num_turns: 0,
      permissionMode: "acceptEdits",
      session_id: "cli-leader-session",
      slash_commands: [],
      total_cost_usd: 0,
      uiMode: "agent",
    },
    messageHistory: [],
    notifications,
    pendingPermissions: new Map<string, PermissionRequest>(),
    evaluatingAborts: new Map(),
    pendingMessages: [],
    pendingCodexTurns: [],
    pendingCodexInputs: [],
    forceCompactPending: false,
    isGenerating: false,
    lastUserMessageDateTag: "",
    lastOutboundUserNdjson: null,
    consecutiveAdapterFailures: 0,
    codexAdapter: null,
    claudeSdkAdapter: null,
  };
}

function makeDeps(options: { isOrchestrator?: boolean } = {}): AdapterBrowserRoutingDeps {
  let nextId = 0;
  return {
    sendToCLI: vi.fn(() => "current" as const),
    isCodexWorkerV2DeliveryFrozen: vi.fn(() => false),
    broadcastToBrowsers: vi.fn(),
    emitTakodeEvent: vi.fn(),
    persistSession: vi.fn(),
    sessionNotificationDeps: {
      isHerdedWorkerSession: vi.fn(() => false),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      scheduleNotification: vi.fn(),
      cancelPermissionNotification: vi.fn(),
    },
    onAgentPaused: vi.fn(),
    getCurrentTurnTriggerSource: vi.fn(() => "user" as const),
    abortAutoApproval: vi.fn(),
    preInterrupt: vi.fn(),
    touchUserMessage: vi.fn(),
    formatVsCodeSelectionPrompt: vi.fn(() => ""),
    getCliSessionId: vi.fn(() => "cli-leader-session"),
    nextUserMessageId: vi.fn(() => `user-${++nextId}`),
    markRunningFromUserDispatch: vi.fn(() => "current" as const),
    trackUserMessageForTurn: vi.fn(),
    setGenerating: vi.fn(),
    broadcastStatusChange: vi.fn(),
    setCodexImageSendStage: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    isHerdEventSource: vi.fn((agentSource) => agentSource?.sessionId === "herd-events"),
    onSessionActivityStateChanged: vi.fn(),
    markTurnInterrupted: vi.fn(),
    armCodexFreshTurnRequirement: vi.fn(),
    clearCodexFreshTurnRequirement: vi.fn(),
    addPendingCodexInput: vi.fn(),
    getCancelablePendingCodexInputs: vi.fn(() => []),
    removePendingCodexInput: vi.fn(() => null),
    clearQueuedTurnLifecycleEntries: vi.fn(),
    queueCodexPendingStartBatch: vi.fn(),
    pokeStaleCodexPendingDelivery: vi.fn(() => false),
    rebuildQueuedCodexPendingStartBatch: vi.fn(),
    trySteerPendingCodexInputs: vi.fn(() => false),
    sendToBrowser: vi.fn(),
    getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: options.isOrchestrator === true })),
    requestCodexIntentionalRelaunch: vi.fn(),
    onPermissionModeChanged: vi.fn(),
    sendControlRequest: vi.fn(),
    requestCodexAutoRecovery: vi.fn(() => false),
    requestCodexLeaderRecycle: vi.fn(async () => ({ ok: true as const })),
    requestCliRelaunch: vi.fn(),
    injectUserMessage: vi.fn((): "sent" => "sent"),
    handleSetModel: vi.fn(),
    handleCodexSetModel: vi.fn(),
    handleSetPermissionMode: vi.fn(),
    handleCodexSetPermissionMode: vi.fn(),
    handleCodexSetUiMode: vi.fn(),
    handleCodexSetReasoningEffort: vi.fn(),
    handleCodexSetServiceTier: vi.fn(),
    handleSetAskPermission: vi.fn(),
    handleInterruptFallback: vi.fn(),
  };
}

function needsInput(id: string, summary: string, timestamp: number, done = false): SessionNotification {
  return {
    id,
    category: "needs-input",
    summary,
    timestamp,
    messageId: null,
    done,
  };
}

function externallyResolvedNeedsInput(
  id: string,
  summary: string,
  timestamp: number,
  threadKey = "main",
): SessionNotification {
  return {
    ...needsInput(id, summary, timestamp, true),
    threadKey,
    ...(threadKey !== "main"
      ? { questId: threadKey, threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] }
      : {}),
    resolutionNotice: {
      status: "pending",
      source: "manual",
      resolvedAt: timestamp + 50,
    },
  };
}

function questNeedsInput(
  id: string,
  summary: string,
  timestamp: number,
  questId: string,
  done = false,
): SessionNotification {
  return {
    ...needsInput(id, summary, timestamp, done),
    threadKey: questId,
    questId,
    threadRefs: [{ threadKey: questId, questId, source: "explicit" }],
  };
}

function review(id: string, summary: string, timestamp: number): SessionNotification {
  return {
    id,
    category: "review",
    summary,
    timestamp,
    messageId: null,
    done: false,
  };
}

function userMessage(overrides: Partial<Extract<BrowserOutgoingMessage, { type: "user_message" }>> = {}) {
  return {
    type: "user_message" as const,
    content: "Fresh user message",
    ...overrides,
  };
}

function sentCliContent(deps: AdapterBrowserRoutingDeps): string {
  const raw = vi.mocked(deps.sendToCLI).mock.calls[0]?.[1];
  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string).message.content;
}

function installActiveRouteStatusBroadcast(deps: AdapterBrowserRoutingDeps): void {
  deps.markRunningFromUserDispatch = vi.fn((targetSession, _reason, _interruptSource, historyIndex, activeRoute) => {
    targetSession.isGenerating = true;
    (targetSession as AdapterBrowserRoutingSessionLike & { userMessageIdsThisTurn?: number[] }).userMessageIdsThisTurn =
      typeof historyIndex === "number" ? [historyIndex] : [];
    (targetSession as AdapterBrowserRoutingSessionLike & { activeTurnRoute?: typeof activeRoute }).activeTurnRoute =
      activeRoute ?? null;
    deps.broadcastToBrowsers(targetSession, {
      type: "status_change",
      status: "running",
      activeTurnRoute: deriveActiveTurnRoute(targetSession as any),
    });
    return "current" as const;
  });
}

function makeRecoveryHead(status: CodexOutboundTurn["status"]): CodexOutboundTurn {
  return {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds: ["retained-input"],
      inputs: [{ content: "Retained work" }],
    },
    userMessageId: "retained-input",
    pendingInputIds: ["retained-input"],
    userContent: "Retained work",
    historyIndex: -1,
    status,
    dispatchCount: status === "queued" ? 0 : 1,
    createdAt: 100,
    updatedAt: 200,
    acknowledgedAt: null,
    turnTarget: null,
    lastError: null,
    turnId: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
  };
}

describe("Codex input admission activity", () => {
  it.each([
    { label: "blocked recovery head", status: "recovery_pending" as const, clearedByPoke: false, running: false },
    { label: "dispatchable head", status: "queued" as const, clearedByPoke: false, running: true },
    {
      label: "recovery cleared by the stale-input poke",
      status: "recovery_pending" as const,
      clearedByPoke: true,
      running: true,
    },
  ])("preserves the activity boundary for an idle session with $label", ({ status, clearedByPoke, running }) => {
    // Admission precedes dispatch. A retained recovery head must keep both inputs
    // pending without broadcasting activity; an actually dispatchable head keeps
    // the existing immediate activity behavior. All persistence is mocked.
    const session = makeSession();
    session.backendType = "codex";
    const sendBrowserMessage = vi.fn(() => true);
    session.codexAdapter = { getCurrentTurnId: () => null, isConnected: () => true, sendBrowserMessage };
    const head = makeRecoveryHead(status);
    const retainedHead = structuredClone(head);
    session.pendingCodexTurns.push(head);
    session.pendingCodexInputs.push({
      id: "retained-input",
      content: "Retained work",
      timestamp: 100,
      cancelable: false,
    });
    const deps = makeDeps({ isOrchestrator: true });
    installActiveRouteStatusBroadcast(deps);
    deps.addPendingCodexInput = vi.fn((target, input) => {
      target.pendingCodexInputs.push(input);
    });
    deps.pokeStaleCodexPendingDelivery = vi.fn(() => {
      if (clearedByPoke) head.status = "queued";
      return clearedByPoke;
    });
    deps.queueCodexPendingStartBatch = vi.fn((target, reason) => {
      dispatchQueuedCodexTurns({ ...target, codexFreshTurnRequiredUntilTurnId: null }, reason, {
        pruneStalePendingCodexHerdInputs: vi.fn(),
        setPendingCodexInputsCancelable: vi.fn(),
        persistSession: vi.fn(),
      });
    });

    expect(routeAdapterBrowserMessage(session, userMessage(), null, deps)).toBe(true);

    expect(session.isGenerating).toBe(running);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "browser_user_message");
    expect(sendBrowserMessage).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(session.pendingCodexInputs.map((input) => input.content)).toEqual(["Retained work", "Fresh user message"]);
    if (running) {
      expect(head.status).toBe("dispatched");
      expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    } else {
      expect(head).toEqual(retainedHead);
      expect(deps.broadcastToBrowsers).not.toHaveBeenCalledWith(
        session,
        expect.objectContaining({ type: "status_change", status: "running" }),
      );
    }
  });

  it("retains active-turn steering when a recovery head is also retained", () => {
    // An existing root turn keeps its lifecycle; merely having recovery audit
    // state must not suppress user steering or turn an active session idle.
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    session.codexAdapter = {
      getCurrentTurnId: () => "active-turn",
      isConnected: () => true,
      sendBrowserMessage: vi.fn(() => true),
    };
    session.pendingCodexTurns.push(makeRecoveryHead("recovery_pending"));
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((target, input) => {
      target.pendingCodexInputs.push(input);
    });
    deps.markRunningFromUserDispatch = vi.fn(() => "queued" as const);
    deps.trySteerPendingCodexInputs = vi.fn(() => true);

    expect(routeAdapterBrowserMessage(session, userMessage(), null, deps)).toBe(true);

    expect(session.isGenerating).toBe(true);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledTimes(1);
    expect(deps.trySteerPendingCodexInputs).toHaveBeenCalledWith(session, "browser_user_message");
    expect(deps.queueCodexPendingStartBatch).not.toHaveBeenCalled();
    expect(session.pendingCodexInputs[0]?.content).toBe("Fresh user message");
  });
});

describe("direct user needs-input reminders", () => {
  it("persists and consumes a visible-stream boundary on the next direct human message", async () => {
    const session = makeSession();
    session.isGenerating = true;
    session.recentAskVisibleResponseThreads = new Set(["main"]);
    const deps = makeDeps();

    await handleUserMessage(session, userMessage(), deps);
    await handleUserMessage(session, userMessage({ content: "Another correction" }), deps);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      recentAskBoundaryBefore: "visible_response",
    });
    expect(session.messageHistory[1]).not.toHaveProperty("recentAskBoundaryBefore");
    expect(session.recentAskVisibleResponseThreads).toEqual(new Set());
  });

  it("persists a Thread Outcome Reminder guard on the Codex pending input", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => targetSession.pendingCodexInputs.push(input));
    const guard = {
      version: 1 as const,
      pendingResponseTargets: [],
      missingOutcomeTargets: [{ threadKey: "main", earliestTimestamp: 10 }],
      missingNeedsInputTargets: [],
    };

    routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Thread outcome reminder",
        agentSource: { sessionId: "system:leader-thread-outcome-reminder" },
        threadKey: "main",
        leaderThreadOutcomeReminderGuard: guard,
      }),
      null,
      deps,
    );

    expect(session.pendingCodexInputs[0]?.leaderThreadOutcomeReminderGuard).toEqual(guard);
  });

  it("carries the streamed-response boundary through Codex pending input commit", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    session.recentAskVisibleResponseThreads = new Set(["main"]);
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((targetSession, input) => targetSession.pendingCodexInputs.push(input));

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    expect(session.pendingCodexInputs[0]?.recentAskBoundaryBefore).toBe("visible_response");

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      onUserMessage: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      emitTakodeEvent: vi.fn(),
      scheduleCodexPendingStartBatch: vi.fn(),
    } as any);
    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      recentAskBoundaryBefore: "visible_response",
    });
  });

  it("delivers concise reply context while storing reply metadata separately for Claude CLI", async () => {
    const session = makeSession();
    const deps = makeDeps();

    await handleUserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
      }),
      deps,
    );

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(sentCliContent(deps)).toContain("[reply] Original answer\n\nContinue the work");
    expect(sentCliContent(deps)).not.toContain("<<<REPLY_TO");
    expect(sentCliContent(deps)).not.toContain("codex-agent-random-id");
  });

  it("passes concise reply delivery content to Claude SDK adapter", async () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    const sdkAdapter = { sendBrowserMessage: vi.fn(() => true), isConnected: vi.fn(() => true) };
    session.claudeSdkAdapter = sdkAdapter as any;
    const deps = makeDeps({ isOrchestrator: true });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
        threadKey: "q-941",
        questId: "q-941",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.messageHistory[0]).toMatchObject({
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(sdkAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_message",
        content: expect.stringContaining("[reply] Original answer\n\nContinue the work"),
      }),
    );
    expect(sdkAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringMatching(/^\[User .*? id:u1\] \[thread:q-941\]/),
      }),
    );
    expect(sdkAdapter.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<<<REPLY_TO") }),
    );
  });

  it("broadcasts the routed active turn for Claude SDK quest-thread messages while Main is selected", () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.claudeSdkAdapter = { sendBrowserMessage: vi.fn(() => true), isConnected: vi.fn(() => true) } as any;
    const deps = makeDeps({ isOrchestrator: true });
    installActiveRouteStatusBroadcast(deps);

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Proceed in q-968",
        threadKey: "q-968",
        questId: "q-968",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledWith(session, "user_message", null, 0, {
      threadKey: "q-968",
      questId: "q-968",
    });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "status_change",
        status: "running",
        activeTurnRoute: { threadKey: "q-968", questId: "q-968" },
      }),
    );
  });

  it("injects a reminder before direct user messages with pending same-session needs-input notifications", async () => {
    // Validates both visible browser history ordering and backend delivery text.
    const session = makeSession([
      needsInput("n-1", "Oldest pending question", 100),
      needsInput("n-2", "Resolved question", 200, true),
      needsInput("n-3", "Third newest pending question", 300),
      review("n-4", "Review-only notification", 400),
      needsInput("n-5", "Second newest pending question", 500),
      needsInput("n-6", "Newest pending question", 600),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]?.type).toBe("user_message");
    expect(
      (session.messageHistory[0] as Extract<BrowserIncomingMessage, { type: "user_message" }>).agentSource,
    ).toEqual({
      sessionId: "system:needs-input-reminder",
      sessionLabel: "Needs Input Reminder",
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining(
        "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
      ),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("6. Newest pending question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("5. Second newest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("3. Third newest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("1. Oldest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Resolved question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("Review-only notification"),
    });

    const cliContent = sentCliContent(deps);
    expect(cliContent.indexOf("[Needs-input reminder]")).toBeLessThan(cliContent.indexOf("Fresh user message"));
    expect(cliContent).toContain(
      "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
    );
  });

  it("delivers and consumes deferred resolution notices with the next direct user message", async () => {
    const session = makeSession([externallyResolvedNeedsInput("n-2", "Already handled", 200)]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input resolution notice]"),
      agentSource: {
        sessionId: "system:needs-input-resolution",
        sessionLabel: "Needs Input Resolution",
      },
    });
    expect(sentCliContent(deps)).toContain("Resolved same-session same-thread needs-input (main): 1.");
    expect(sentCliContent(deps)).toContain("2. Already handled (resolved outside the agent).");
    expect(sentCliContent(deps)).toContain(
      "Do not run `takode notify resolve` for these same-session prompts unless a new prompt is recreated later.",
    );
    expect(session.notifications?.[0]?.resolutionNotice).toMatchObject({ status: "delivered" });

    await handleUserMessage(session, userMessage({ content: "Another direct user message" }), deps);
    expect(
      session.messageHistory.filter((entry: any) => entry.id?.startsWith("needs-input-resolution-notice-")),
    ).toHaveLength(1);
  });

  it("keeps unresolved reminders and deferred resolution notices separate in mixed cases", async () => {
    const session = makeSession([
      externallyResolvedNeedsInput("n-2", "Already handled", 200),
      needsInput("n-3", "Still pending", 300),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input resolution notice]"),
    });
    expect(session.messageHistory[1]).toMatchObject({
      content: expect.stringContaining("[Needs-input reminder]"),
    });
    const cliContent = sentCliContent(deps);
    expect(cliContent.indexOf("[Needs-input resolution notice]")).toBeLessThan(
      cliContent.indexOf("[Needs-input reminder]"),
    );
    expect(cliContent).toContain("2. Already handled");
    expect(cliContent).toContain("3. Still pending");
  });

  it("does not deliver resolution notices on programmatic or interrupted-generation turns", async () => {
    const session = makeSession([externallyResolvedNeedsInput("n-2", "Already handled", 200)]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({ agentSource: { sessionId: "system:test", sessionLabel: "System Test" } }),
      deps,
    );
    expect(sentCliContent(deps)).not.toContain("[Needs-input resolution notice]");
    expect(session.notifications?.[0]?.resolutionNotice).toMatchObject({ status: "pending" });

    const interruptedSession = makeSession([externallyResolvedNeedsInput("n-4", "Interrupt handled", 400)]);
    interruptedSession.isGenerating = true;
    const interruptedDeps = makeDeps({ isOrchestrator: true });
    await handleUserMessage(interruptedSession, userMessage({ content: "Interrupting message" }), interruptedDeps);

    expect(sentCliContent(interruptedDeps)).not.toContain("[Needs-input resolution notice]");
    expect(interruptedSession.notifications?.[0]?.resolutionNotice).toMatchObject({ status: "pending" });
  });

  it("filters direct user reminders to pending needs-input notifications from the same quest thread", async () => {
    // A response in one quest thread must not be polluted by unresolved prompts
    // from Main or a different quest thread.
    const session = makeSession([
      needsInput("n-1", "Main pending question", 100),
      questNeedsInput("n-2", "Current quest question", 200, "q-941"),
      questNeedsInput("n-3", "Other quest question", 300, "q-942"),
      questNeedsInput("n-4", "Resolved current quest question", 400, "q-941", true),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({
        content: "Fresh q-941 reply",
        threadKey: "q-941",
        questId: "q-941",
      }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (q-941): 1."),
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("2. Current quest question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Main pending question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Other quest question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("Resolved current quest question"),
    });
    expect(session.messageHistory[1]).toMatchObject({
      type: "user_message",
      content: "Fresh q-941 reply",
      threadKey: "q-941",
      questId: "q-941",
    });

    const cliContent = sentCliContent(deps);
    expect(cliContent).toContain("Unresolved same-session same-thread needs-input notifications (q-941): 1.");
    expect(cliContent).toContain("2. Current quest question");
    expect(cliContent).not.toContain("Main pending question");
    expect(cliContent).not.toContain("Other quest question");
  });

  it("keeps Main direct user reminders scoped away from pending quest-thread needs-input notifications", async () => {
    // Legacy notifications without route metadata behave as Main-scoped; they
    // should remain visible in Main without leaking quest-thread prompts there.
    const session = makeSession([
      needsInput("n-1", "Main pending question", 100),
      questNeedsInput("n-2", "Quest pending question", 200, "q-941"),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage({ content: "Fresh Main reply" }), deps);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (main): 1."),
      threadKey: "main",
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("1. Main pending question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Quest pending question") });

    const cliContent = sentCliContent(deps);
    expect(cliContent).toContain("1. Main pending question");
    expect(cliContent).not.toContain("Quest pending question");
  });

  it("does not inject a reminder when the current leader session has no pending needs-input notifications", async () => {
    // The helper must not inspect unrelated sessions or global state; only this session's inbox matters.
    const unrelatedSession = makeSession([needsInput("n-9", "Other session question", 900)]);
    expect(unrelatedSession.notifications).toHaveLength(1);
    const session = makeSession([]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({ type: "user_message", content: "Fresh user message" });
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("annotates Main-origin leader user messages in metadata and Claude CLI delivery", async () => {
    // Main is an explicit thread source for leaders even though it is not a
    // quest projection, so the model does not infer where the user typed.
    const session = makeSession();
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage({ content: "Main reply" }), deps);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Main reply",
      threadKey: "main",
      leaderUserMessageId: "u1",
    });
    expect(sentCliContent(deps)).toMatch(/^\[User .*? id:u1\] \[thread:main\] Main reply$/);
  });

  it("annotates quest-thread-origin leader user messages in metadata and Claude CLI delivery", async () => {
    // Quest-thread messages must remain clean in durable history while the
    // delivered prompt carries the stable source key for leader/model routing.
    const session = makeSession();
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({
        content: "Quest-thread reply",
        threadKey: "q-941",
        questId: "q-941",
      }),
      deps,
    );

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Quest-thread reply",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
      leaderUserMessageId: "u1",
    });
    expect(sentCliContent(deps)).toMatch(/^\[User .*? id:u1\] \[thread:q-941\] Quest-thread reply$/);
  });

  it("stops listing notifications after they are resolved", async () => {
    // Resolved notifications stay in the inbox for history, but reminders only surface unresolved items.
    const session = makeSession([
      needsInput("n-1", "Already resolved", 100, true),
      needsInput("n-2", "Still pending", 200),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (main): 1."),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("2. Still pending") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Already resolved") });
  });

  it("does not inject before herd or other programmatic messages", async () => {
    // Programmatic messages carry agentSource and must not trigger the direct-user reminder path.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({ agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Fresh user message",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("keeps the behavior scoped to orchestrator sessions", async () => {
    // A non-leader session can have notifications, but this reminder is leader-only.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    const deps = makeDeps({ isOrchestrator: false });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(1);
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("carries direct-user reminders through Codex pending inputs until the user message is committed", () => {
    // Codex queues browser messages before backend acknowledgement, so the reminder travels with the pending input.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(session, userMessage(), null, deps);

    expect(routed).toBe(true);
    expect(session.messageHistory).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Fresh user message",
      needsInputReminderText: expect.stringContaining("[Needs-input reminder]"),
      deliveryContent: expect.stringContaining("[Needs-input reminder]"),
    });
    expect(session.pendingCodexInputs[0]?.deliveryContent).toContain("\n\nFresh user message");

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input reminder]"),
      agentSource: {
        sessionId: "system:needs-input-reminder",
        sessionLabel: "Needs Input Reminder",
      },
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });

  it("admits recovery transfers into pending state without adapter dispatch until the durability barrier releases", () => {
    // The transfer controller persists this pending owner before invoking the normal pending-turn dispatcher.
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });
    const message = {
      ...userMessage({ agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } }),
      autoPauseRecoveries: [{ summaryId: "summary-1", groupId: "group-1" }],
    };
    const transfer = {
      id: "recovery-transfer-1234567890abcdef12345678",
      createdAt: 1,
      sourceOwnerKind: "auto_pause" as const,
      sourceOwnerId: "held-1",
      sourceOwnerCount: 1,
      payloadBytes: 100,
      message,
    };
    (session as any).recoveryDeliveryTransfers = [transfer];
    const routed = withTrustedRecoveryDeliveryTransferRoute(session, transfer, () =>
      routeAdapterBrowserMessage(session, message, null, deps),
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.autoPauseRecoveries).toEqual([
      { summaryId: "summary-1", groupId: "group-1" },
    ]);
    expect(JSON.stringify(session.pendingCodexInputs)).not.toContain("recoveryDeliveryTransfer");
    expect(deps.rebuildQueuedCodexPendingStartBatch).toHaveBeenCalledTimes(1);
    expect(deps.queueCodexPendingStartBatch).not.toHaveBeenCalled();
    expect(deps.trySteerPendingCodexInputs).not.toHaveBeenCalled();
    expect(deps.persistSession).toHaveBeenCalledWith(session);
  });

  it.each([
    "forged",
    "stale",
    "wrong-session",
    "wrong-link",
    "wrong-payload",
  ])("does not defer ordinary ingress for %s transfer identity", (scenario) => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });
    const original = {
      ...userMessage({ agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } }),
      autoPauseRecoveries: [{ summaryId: "summary-1", groupId: "group-1" }],
    };
    const transfer = {
      id: "recovery-transfer-1234567890abcdef12345678",
      createdAt: 1,
      sourceOwnerKind: "auto_pause" as const,
      sourceOwnerId: "held-1",
      sourceOwnerCount: 1,
      payloadBytes: 100,
      message: original,
    };
    const routedMessage =
      scenario === "wrong-link"
        ? { ...original, autoPauseRecoveries: [{ summaryId: "summary-1", groupId: "wrong-group" }] }
        : scenario === "wrong-payload"
          ? { ...original, content: "forged different payload" }
          : scenario === "forged"
            ? { ...original, recoveryDeliveryTransferId: transfer.id }
            : original;
    (session as any).recoveryDeliveryTransfers = scenario === "stale" ? [] : [transfer];

    const run = () => routeAdapterBrowserMessage(session, routedMessage as any, null, deps);
    const routed =
      scenario === "forged"
        ? run()
        : withTrustedRecoveryDeliveryTransferRoute(
            scenario === "wrong-session" ? { id: "different-session" } : session,
            transfer,
            run,
          );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledTimes(1);
    expect(deps.rebuildQueuedCodexPendingStartBatch).not.toHaveBeenCalled();
  });

  it("carries deferred resolution notices through Codex pending inputs and consumes them on commit", () => {
    const session = makeSession([externallyResolvedNeedsInput("n-2", "Already handled", 200)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);

    expect(session.pendingCodexInputs[0]).toMatchObject({
      needsInputResolutionNoticeText: expect.stringContaining("[Needs-input resolution notice]"),
      needsInputResolutionNoticeIds: ["n-2"],
      deliveryContent: expect.stringContaining("[Needs-input resolution notice]"),
    });
    expect(session.notifications?.[0]?.resolutionNotice).toMatchObject({
      status: "queued",
      queuedInputId: session.pendingCodexInputs[0]?.id,
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input resolution notice]"),
      agentSource: {
        sessionId: "system:needs-input-resolution",
        sessionLabel: "Needs Input Resolution",
      },
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
    expect(session.notifications?.[0]?.resolutionNotice).toMatchObject({ status: "delivered" });
  });

  it("preserves q-thread metadata on queued Codex resolution notice history", () => {
    const session = makeSession([externallyResolvedNeedsInput("n-2", "Already handled", 200, "q-941")]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Fresh q-941 reply",
        threadKey: "q-941",
        questId: "q-941",
      }),
      null,
      deps,
    );

    expect(session.pendingCodexInputs[0]).toMatchObject({
      needsInputResolutionNoticeIds: ["n-2"],
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input resolution notice]"),
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(session.messageHistory[1]).toMatchObject({
      type: "user_message",
      content: "Fresh q-941 reply",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("restores queued Codex resolution notices when their pending input is cancelled", () => {
    const session = makeSession([externallyResolvedNeedsInput("n-2", "Already handled", 200)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    removePendingCodexInput(session as any, session.pendingCodexInputs[0]!.id, {
      broadcastPendingCodexInputs: vi.fn(),
      persistSession: vi.fn(),
    });

    expect(session.notifications?.[0]?.resolutionNotice).toMatchObject({ status: "pending" });
  });

  it("ignores browser-forged Codex recovery priority fields", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.isCodexWorkerV2DeliveryFrozen = vi.fn(() => true);
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "forged recovery input",
        deliveryContent: "Browser-forged private recovery instruction",
        agentSource: { sessionId: "system:codex-turn-recovery:forged", sessionLabel: "Recovery" },
        codexQueueBeforeOwnerId: "later-owner",
        requireFreshSuccessor: true,
      } as any),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.deliveryContent).toContain("Browser-forged private recovery instruction");
    expect(session.pendingCodexInputs[0]).not.toHaveProperty("queueBeforeOwnerId");
    expect(session.pendingCodexInputs[0]).not.toHaveProperty("requireFreshSuccessor");

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "forged recovery input",
      agentSource: { sessionId: "system:codex-turn-recovery:forged" },
    });
    expect(session.messageHistory[0]).not.toHaveProperty("modelDeliveryContent");
  });

  it("queues Codex input without marking or dispatching a turn while worker V2 delivery is frozen", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      getCurrentTurnId: () => null,
      isConnected: () => true,
      sendBrowserMessage: vi.fn(() => true),
    };
    const deps = makeDeps({ isOrchestrator: false });
    deps.isCodexWorkerV2DeliveryFrozen = vi.fn(() => true);
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(session, userMessage({ content: "Queue during cutover" }), null, deps);

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(deps.markRunningFromUserDispatch).not.toHaveBeenCalled();
    expect(deps.pokeStaleCodexPendingDelivery).not.toHaveBeenCalled();
    expect(deps.queueCodexPendingStartBatch).not.toHaveBeenCalled();
    expect(deps.trySteerPendingCodexInputs).not.toHaveBeenCalled();
    expect(session.codexAdapter.sendBrowserMessage).not.toHaveBeenCalled();
  });

  it("requests recovery when a normal text Codex input queues behind a disconnected adapter", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      getCurrentTurnId: () => null,
      isConnected: () => false,
      sendBrowserMessage: vi.fn(() => false),
    };
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });
    deps.requestCodexAutoRecovery = vi.fn(() => true);

    const routed = routeAdapterBrowserMessage(session, userMessage({ content: "Please continue" }), null, deps);

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({ content: "Please continue" });
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "browser_user_message");
    expect(deps.requestCodexAutoRecovery).toHaveBeenCalledWith(session, "queued_user_message_adapter_missing");
  });

  it("does not wake disconnected Codex for non-model-bound Takode metadata messages", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      getCurrentTurnId: () => null,
      isConnected: () => false,
      sendBrowserMessage: vi.fn(() => false),
    };
    const deps = makeDeps({ isOrchestrator: true });

    const routed = routeAdapterBrowserMessage(session, { type: "set_codex_ui_mode", uiMode: "plan" }, null, deps);

    expect(routed).toBe(true);
    expect(deps.handleCodexSetUiMode).toHaveBeenCalledWith(session, "plan");
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(deps.queueCodexPendingStartBatch).not.toHaveBeenCalled();
    expect(deps.requestCodexAutoRecovery).not.toHaveBeenCalled();
  });

  it("queues leader skill preloads as one model-bound Codex turn with visible history follow-ups", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      getCurrentTurnId: () => null,
      isConnected: () => true,
      sendBrowserMessage: vi.fn(() => true),
    } as any;
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Leader kickoff",
        deliveryContent: "Leader kickoff\n\nRequired leader skill preloaded: quest\nquest skill body",
        historyFollowUps: [
          {
            content: "Required leader skill preloaded: quest\nquest skill body",
            agentSource: { sessionId: "system:leader-skill-preload:quest", sessionLabel: "Required quest" },
          },
        ],
        agentSource: { sessionId: "system:leader-kickoff", sessionLabel: "Leader Kickoff" },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Leader kickoff",
      deliveryContent: expect.stringContaining("Required leader skill preloaded: quest"),
      historyFollowUps: [
        expect.objectContaining({
          content: expect.stringContaining("Required leader skill preloaded: quest"),
        }),
      ],
    });
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledTimes(1);
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "browser_user_message");
  });

  it("consumes non-leader startup memory catalog prelude on the first real user message", async () => {
    const session = makeSession();
    session.pendingStartupMemoryCatalogInjection = true;
    const deps = makeDeps();
    const recordSeen = vi.fn(async () => {});
    deps.sendToCLI = vi.fn(() => {
      expect(recordSeen).not.toHaveBeenCalled();
      return "current" as const;
    });
    deps.buildMemoryCatalogInjectionBundle = vi.fn(async () => ({
      content: [
        "Memory catalog preloaded",
        "",
        "This automatically injected catalog is the result of `memory catalog show` at injection time. Treat it as an orientation snapshot, not the source of truth.",
        "Memory repo: /tmp/takode-memory",
        "decisions/example.md: Example memory decision.",
      ].join("\n"),
      agentSource: { sessionId: "system:memory-catalog", sessionLabel: "Memory Catalog" },
      truncated: false,
      unavailable: false,
      recordSeen,
    }));

    await routeBrowserMessage(session as any, userMessage({ content: "Do the assigned work" }), undefined, deps);

    expect(session.pendingStartupMemoryCatalogInjection).toBe(false);
    expect(deps.buildMemoryCatalogInjectionBundle).toHaveBeenCalledWith(session);
    expect(deps.sendToCLI).toHaveBeenCalledTimes(1);
    const ndjson = String((deps.sendToCLI as any).mock.calls[0]?.[1] ?? "");
    expect(ndjson).toContain("Do the assigned work");
    expect(ndjson).toContain("Memory catalog preloaded");
    expect(ndjson).toContain("inspect actual memory Markdown files directly");
    expect(session.messageHistory).toEqual([
      expect.objectContaining({ type: "user_message", content: "Do the assigned work" }),
      expect.objectContaining({
        type: "user_message",
        content: expect.stringContaining("Memory catalog preloaded"),
        agentSource: { sessionId: "system:memory-catalog", sessionLabel: "Memory Catalog" },
      }),
    ]);
    expect(recordSeen).toHaveBeenCalledTimes(1);
  });

  it("preserves trusted recovery priority when startup memory augments delivery content", async () => {
    const session = makeSession();
    session.backendType = "codex";
    session.pendingStartupMemoryCatalogInjection = true;
    session.state.codex_turn_recovery = {
      recoveryId: "original-owner",
      originalOwnerId: "original-owner",
      originalProviderTurnId: "turn-original",
      originalHistoryIndex: 0,
      continuationOwnerId: null,
      threadKey: "q-1",
      questId: "q-1",
      status: "continuation_pending",
      reason: "interrupted_after_activity",
      attempt: 1,
      maxAttempts: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => targetSession.pendingCodexInputs.push(input));
    deps.buildMemoryCatalogInjectionBundle = vi.fn(async () => ({
      content: "Memory catalog preloaded\n\nMemory repo: /tmp/takode-memory",
      agentSource: { sessionId: "system:memory-catalog", sessionLabel: "Memory Catalog" },
      truncated: false,
      unavailable: false,
      recordSeen: vi.fn(async () => {}),
    }));
    const message = userMessage({
      content: "Visible recovery status",
      deliveryContent: "Private recovery instruction",
      agentSource: { sessionId: "system:codex-turn-recovery:original-owner", sessionLabel: "Recovery" },
      threadKey: "q-1",
      questId: "q-1",
    });

    await withTrustedCodexRecoveryRoute(
      session,
      {
        recoveryId: "original-owner",
        sourceId: "system:codex-turn-recovery:original-owner",
        visibleContent: "Visible recovery status",
        deliveryContent: "Private recovery instruction",
        threadKey: "q-1",
        questId: "q-1",
        queueBeforeOwnerId: "later-owner",
      },
      () => routeBrowserMessage(session as any, message, undefined, deps),
    );

    expect(session.pendingCodexInputs).toEqual([
      expect.objectContaining({
        content: "Visible recovery status",
        deliveryContent: expect.stringContaining("Memory catalog preloaded"),
        queueBeforeOwnerId: "later-owner",
        requireFreshSuccessor: true,
      }),
    ]);
    const pending = session.pendingCodexInputs[0]!;
    const exactModelDeliveryContent = buildCodexBatchMessageInputs([pending])[0]!.content;
    expect(exactModelDeliveryContent).toBe(pending.deliveryContent);
    expect(exactModelDeliveryContent).toMatch(
      /^\[System .*?\] \[thread:q-1\] Private recovery instruction\n\nThe following memory catalog/,
    );

    commitPendingCodexInputs(session as any, [pending.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Visible recovery status",
      modelDeliveryContent: exactModelDeliveryContent,
      agentSource: { sessionId: "system:codex-turn-recovery:original-owner" },
    });
    expect(session.messageHistory[0]).toHaveProperty("modelDeliveryContent", exactModelDeliveryContent);
  });

  it("retains the startup catalog prelude after an oversized Codex first input", async () => {
    const previousLimit = process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES;
    process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES = "64";
    try {
      const session = makeSession();
      session.backendType = "codex";
      session.pendingStartupMemoryCatalogInjection = true;
      session.codexAdapter = {
        getCurrentTurnId: () => null,
        isConnected: () => true,
        sendBrowserMessage: vi.fn(() => true),
      } as any;
      const deps = makeDeps();
      deps.addPendingCodexInput = vi.fn((targetSession, input) => {
        targetSession.pendingCodexInputs.push(input);
      });
      const firstRecordSeen = vi.fn(async () => {});
      const secondRecordSeen = vi.fn(async () => {});
      deps.buildMemoryCatalogInjectionBundle = vi
        .fn()
        .mockResolvedValueOnce({
          content: "Memory catalog preloaded\n" + "x".repeat(128),
          agentSource: { sessionId: "system:memory-catalog", sessionLabel: "Memory Catalog" },
          truncated: false,
          unavailable: false,
          recordSeen: firstRecordSeen,
        })
        .mockResolvedValueOnce({
          content: "Memory catalog preloaded\nMemory repo: /tmp/takode-memory",
          agentSource: { sessionId: "system:memory-catalog", sessionLabel: "Memory Catalog" },
          truncated: false,
          unavailable: false,
          recordSeen: secondRecordSeen,
        });

      const rejected = await routeBrowserMessage(
        session as any,
        userMessage({ content: "first input" }),
        undefined,
        deps,
      );

      expect(rejected).toBe(false);
      expect(session.pendingStartupMemoryCatalogInjection).toBe(true);
      expect(session.pendingCodexInputs).toHaveLength(0);
      expect(firstRecordSeen).not.toHaveBeenCalled();
      expect(
        session.messageHistory.some(
          (entry) => entry.type === "user_message" && entry.agentSource?.sessionId === "system:memory-catalog",
        ),
      ).toBe(false);

      process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES = "1048576";
      const accepted = await routeBrowserMessage(
        session as any,
        userMessage({ content: "retry input" }),
        undefined,
        deps,
      );

      expect(accepted).toBe(true);
      expect(session.pendingStartupMemoryCatalogInjection).toBe(false);
      expect(session.pendingCodexInputs).toHaveLength(1);
      expect(firstRecordSeen).not.toHaveBeenCalled();
      expect(secondRecordSeen).toHaveBeenCalledTimes(1);
    } finally {
      if (previousLimit === undefined) delete process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES;
      else process.env.TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES = previousLimit;
    }
  });

  it("queues Codex herd inputs as a fresh pending batch instead of steering into an active turn", () => {
    // Herd events are delivered when the leader is idle, or force-delivered by
    // recovery when the active turn is stale. They should wake the leader with
    // a fresh turn instead of steering into that stale active Codex turn.
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    session.codexAdapter = {
      getCurrentTurnId: () => "turn-active",
    } as any;
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "1 event from 1 session\n\n#1380 | turn_end | ✓",
        agentSource: {
          sessionId: "herd-events",
          sessionLabel: "Herd Events",
        },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).not.toHaveBeenCalled();
    expect(deps.trySteerPendingCodexInputs).not.toHaveBeenCalled();
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "herd_event_message");
  });

  it("pokes stale Codex pending delivery when a herd input queues behind a stale head", () => {
    // Herd events are model-bound inputs for leaders. They should get the same
    // immediate stale-head poke as direct user messages, while the recovery
    // primitive itself keeps the connected/idle/no-active-turn safety gates.
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      getCurrentTurnId: () => null,
      isConnected: () => true,
      sendBrowserMessage: vi.fn(() => true),
    } as any;
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "1 event from 1 session\n\n#1380 | turn_end | interrupted",
        agentSource: {
          sessionId: "herd-events",
          sessionLabel: "Herd Events",
        },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.pokeStaleCodexPendingDelivery).toHaveBeenCalledWith(session, "herd_event_message", {
      triggeringInputId: "user-1",
    });
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "herd_event_message");
  });

  it("broadcasts the routed active turn for Codex quest-thread messages while Main is selected", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    installActiveRouteStatusBroadcast(deps);
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Proceed in q-968",
        threadKey: "q-968",
        questId: "q-968",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledWith(session, "user_message", null, undefined, {
      threadKey: "q-968",
      questId: "q-968",
    });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "status_change",
        status: "running",
        activeTurnRoute: { threadKey: "q-968", questId: "q-968" },
      }),
    );
  });

  it.each([
    { label: "direct user", agentSource: undefined },
    { label: "Herd", agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } },
  ])("clears only the same-thread retained reasoning row for $label activity", ({ agentSource }) => {
    // User and Herd messages are visible feed boundaries. Their authoritative
    // routed thread may clear its row without disturbing another thread tab.
    const session = makeSession();
    session.backendType = "codex";
    session.codexReasoningPreviews = {
      "q-968": { text: "Same-thread reasoning", updatedAt: 1, threadKey: "q-968", questId: "q-968" },
      "q-969": { text: "Other-thread reasoning", updatedAt: 2, threadKey: "q-969", questId: "q-969" },
    };
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Visible routed activity",
        threadKey: "q-968",
        questId: "q-968",
        ...(agentSource ? { agentSource } : {}),
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.codexReasoningPreviews).toEqual({
      "q-969": { text: "Other-thread reasoning", updatedAt: 2, threadKey: "q-969", questId: "q-969" },
    });
    expect(deps.broadcastStatusChange).toHaveBeenCalledWith(session, "idle");
  });

  it("queues concise reply delivery content for Codex while preserving clean committed history", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Continue the work",
      deliveryContent: "[reply] Original answer\n\nContinue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(session.messageHistory[0]).not.toHaveProperty("modelDeliveryContent");
    expect(session.lastUserMessage).toBe("[reply] Continue the work");
  });

  it("allocates distinct stable source-envelope IDs across multiple uncommitted Codex inputs", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    expect(routeAdapterBrowserMessage(session, userMessage({ content: "First queued ask" }), null, deps)).toBe(true);
    expect(routeAdapterBrowserMessage(session, userMessage({ content: "Second queued ask" }), null, deps)).toBe(true);

    expect(session.pendingCodexInputs).toMatchObject([
      { leaderUserMessageId: "u1", deliveryContent: expect.stringMatching(/^\[User .*? id:u1\]/) },
      { leaderUserMessageId: "u2", deliveryContent: expect.stringMatching(/^\[User .*? id:u2\]/) },
    ]);
  });

  it("preserves quest-thread metadata through queued Codex pending input commit", () => {
    // Messages composed from a selected quest thread are queued for Codex before
    // becoming durable history, so the pending input must carry projection metadata.
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Follow up from the q-941 thread",
        threadKey: "q-941",
        questId: "q-941",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Follow up from the q-941 thread",
      leaderUserMessageId: "u1",
      deliveryContent: expect.stringMatching(/^\[User .*? id:u1\] \[thread:q-941\] Follow up from the q-941 thread$/),
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Follow up from the q-941 thread",
      leaderUserMessageId: "u1",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("does not commit an all-resolved queued Codex reminder into chat history", () => {
    // Codex can queue a reminder while a notification is active, then commit the
    // pending input after the user has already resolved that notification. The
    // queued user message should still land, but the stale reminder card should not.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    session.notifications![0]!.done = true;

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });

  it("commits truncated queued Codex reminders when an unlisted notification remains active", () => {
    // The reminder text only lists the newest three unresolved notifications.
    // If those listed IDs resolve while an older hidden notification remains
    // active, the queued reminder is still meaningful and must not be suppressed.
    const session = makeSession([
      needsInput("n-1", "Hidden older question", 100),
      needsInput("n-3", "Third newest pending question", 300),
      needsInput("n-5", "Second newest pending question", 500),
      needsInput("n-6", "Newest pending question", 600),
    ]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    expect(session.pendingCodexInputs[0]?.needsInputReminderText).toContain(
      "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
    );
    for (const notification of session.notifications ?? []) {
      if (notification.id === "n-1") continue;
      notification.done = true;
    }

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining(
        "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
      ),
      agentSource: {
        sessionId: "system:needs-input-reminder",
        sessionLabel: "Needs Input Reminder",
      },
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });
});
