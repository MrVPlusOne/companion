import { beforeEach, describe, expect, vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockShouldSettingsRuleApprove = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));
vi.mock("./bridge/settings-rule-matcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bridge/settings-rule-matcher.js")>();
  return { ...original, shouldSettingsRuleApprove: mockShouldSettingsRuleApprove };
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WsBridge, type SocketData } from "./ws-bridge.js";
import { subscribeCurrentBrowser } from "./ws-bridge-current-browser-test-helpers.js";
import { SessionStore } from "./session-store.js";
import { normalizePersistedCodexTurn } from "./bridge/session-registry-controller.js";

function createMockSocket(data: SocketData) {
  return { data, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function makeCodexAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let onTurnSteeredCb: ((turnId: string, pendingInputIds: string[], clientUserMessageId?: string) => void) | undefined;
  let onTurnSteerFailedCb:
    | ((pendingInputIds: string[], failure?: any, clientUserMessageId?: string) => void)
    | undefined;
  let currentTurnId: string | null = null;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => (onBrowserMessageCb = cb)),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => (onSessionMetaCb = cb)),
    onDisconnect: vi.fn((cb: () => void) => (onDisconnectCb = cb)),
    onInitError: vi.fn((cb: (error: string) => void) => (onInitErrorCb = cb)),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => (onTurnStartFailedCb = cb)),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => (onTurnStartedCb = cb)),
    onTurnSteered: vi.fn(
      (cb: (turnId: string, pendingInputIds: string[], clientUserMessageId?: string) => void) => (onTurnSteeredCb = cb),
    ),
    onTurnSteerFailed: vi.fn(
      (cb: (pendingInputIds: string[], failure?: any, clientUserMessageId?: string) => void) =>
        (onTurnSteerFailedCb = cb),
    ),
    sendBrowserMessage: vi.fn(() => true),
    rollbackTurns: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    getThreadId: vi.fn(() => "thread-ready"),
    getCurrentTurnId: vi.fn(() => currentTurnId),
    emitBrowserMessage: (msg: any) => {
      if (msg?.type === "result" && msg.data?.codex_turn_id === currentTurnId) currentTurnId = null;
      onBrowserMessageCb?.(msg);
    },
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: (turnId?: string | null) => {
      currentTurnId = turnId === undefined ? currentTurnId : turnId;
      onDisconnectCb?.();
    },
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitTurnStartFailed: (msg: any) => onTurnStartFailedCb?.(msg),
    emitTurnStarted: (turnId: string) => {
      currentTurnId = turnId;
      onTurnStartedCb?.(turnId);
    },
    emitTurnSteered: (turnId: string, pendingInputIds: string[], clientUserMessageId?: string) =>
      onTurnSteeredCb?.(turnId, pendingInputIds, clientUserMessageId),
    emitTurnSteerFailed: (pendingInputIds: string[], failure?: any, clientUserMessageId?: string) =>
      onTurnSteerFailedCb?.(pendingInputIds, failure, clientUserMessageId),
  };
}

function makeReceiptAwareCodexAdapterMock() {
  const adapter = makeCodexAdapterMock() as ReturnType<typeof makeCodexAdapterMock> & {
    onUserMessageRecorded: ReturnType<typeof vi.fn>;
    onUserMessageReceiptObserved: ReturnType<typeof vi.fn>;
    emitUserMessageRecorded: (receipt: { turnId: string; clientUserMessageId: string; itemId?: string }) => void;
    emitUserMessageReceiptObserved: (receipt: {
      turnId: string;
      clientUserMessageId: string;
      itemId?: string;
      observedAt?: number;
    }) => void;
  };
  let receiptCb: ((receipt: { turnId: string; clientUserMessageId: string; itemId?: string }) => void) | undefined;
  let observationCb:
    | ((receipt: { turnId: string; clientUserMessageId: string; itemId?: string; observedAt?: number }) => void)
    | undefined;
  adapter.onUserMessageRecorded = vi.fn((cb) => (receiptCb = cb));
  adapter.onUserMessageReceiptObserved = vi.fn((cb) => (observationCb = cb));
  adapter.emitUserMessageRecorded = (receipt) => receiptCb?.(receipt);
  adapter.emitUserMessageReceiptObserved = (receipt) => observationCb?.(receipt);
  return adapter;
}

function emitCodexSessionReady(
  adapter: ReturnType<typeof makeCodexAdapterMock>,
  overrides: Record<string, unknown> = {},
) {
  adapter.emitSessionMeta({ cliSessionId: "thread-ready", model: "gpt-5.3-codex", cwd: "/repo", ...overrides });
}

function getCodexStartPendingInputs(msg: any) {
  expect(msg?.type).toBe("codex_start_pending");
  expect(Array.isArray(msg?.inputs)).toBe(true);
  return msg.inputs as Array<{ content: string }>;
}

function successResult(sessionId: string, turnId: string, result = "completed") {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      duration_ms: 10,
      duration_api_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: `result-${turnId}`,
      session_id: sessionId,
      codex_turn_id: turnId,
      stop_reason: "completed",
    },
  } as any;
}

let bridge: WsBridge;

beforeEach(() => {
  const tempDir = mkdtempSync(join(tmpdir(), "bridge-history-recovery-test-"));
  bridge = new WsBridge();
  (bridge as any).store = new SessionStore(tempDir);
  mockExecSync.mockReset();
  mockExec.mockReset();
  mockShouldSettingsRuleApprove.mockReset().mockResolvedValue(null);
  mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const result = mockExecSync(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (error) {
      if (callback) callback(error, { stdout: "", stderr: "" });
    }
  });
});

describe("Codex evidence-aware history recovery", () => {
  it("synthesizes receipt identity before dispatching a restored-style queued batch", async () => {
    const sid = "s-restored-queued-identity";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    const session = bridge.getSession(sid)!;
    session.pendingCodexInputs.push({
      id: "restored-owner",
      content: "restored queued work",
      timestamp: 1,
      cancelable: true,
    });
    session.pendingCodexTurns.push(
      normalizePersistedCodexTurn({
        adapterMsg: {
          type: "codex_start_pending",
          pendingInputIds: ["restored-owner"],
          inputs: [{ content: "restored queued work" }],
        },
        userMessageId: "restored-owner",
        pendingInputIds: ["restored-owner"],
        userContent: "restored queued work",
        historyIndex: -1,
        status: "queued",
        dispatchCount: 0,
        createdAt: 1,
        updatedAt: 1,
        acknowledgedAt: null,
        turnTarget: null,
        lastError: null,
        turnId: null,
        disconnectedAt: null,
        resumeConfirmedAt: null,
      }),
    );

    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-queued" });
    await Promise.resolve();

    const start = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    expect(start.clientUserMessageId).toEqual(expect.any(String));
    expect(session.pendingCodexTurns[0]?.historyIncorporation).toMatchObject({
      inputIds: ["restored-owner"],
      clientUserMessageId: start.clientUserMessageId,
    });

    adapter.emitTurnStarted("turn-restored-queued");
    adapter.emitUserMessageReceiptObserved({
      turnId: "turn-restored-queued",
      clientUserMessageId: start.clientUserMessageId,
    });
    adapter.emitUserMessageRecorded({
      turnId: "turn-restored-queued",
      clientUserMessageId: start.clientUserMessageId,
    });
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.messageHistory).toContainEqual(
      expect.objectContaining({ type: "user_message", id: "restored-owner", content: "restored queued work" }),
    );
  });

  it("keeps pre-ACK post-receipt tool activity ahead of provider replay", async () => {
    const sid = "s-pre-ack-receipt-activity";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-pre-ack-receipt" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "perform one effect" }));
    const start = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    const observedAt = Date.now();
    adapter.emitUserMessageReceiptObserved({
      turnId: "turn-pre-ack",
      clientUserMessageId: start.clientUserMessageId,
      observedAt,
    });
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "pre-ack-tool",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "tool_use", id: "tool-pre-ack", name: "Bash", input: { command: "echo effect" } }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: observedAt + 1,
    });
    await Promise.resolve();

    adapter.emitTurnStarted("turn-pre-ack");
    adapter.emitUserMessageRecorded({
      turnId: "turn-pre-ack",
      clientUserMessageId: start.clientUserMessageId,
    });
    await Promise.resolve();

    const tracked = bridge.getSession(sid)!.pendingCodexTurns[0]!;
    expect(tracked.historyIncorporation).toMatchObject({
      recordedAt: observedAt,
      recordedSource: "live",
    });
    expect(tracked.historyIncorporation!.activityStartHistoryIndex).toBe(tracked.historyIndex);
    expect(tracked.providerReplayUnsafeActivityObserved).toBe(true);

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "stream disconnected before completion while error sending request to /responses",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "result-pre-ack",
        session_id: sid,
        codex_turn_id: "turn-pre-ack",
        stop_reason: "error",
      },
    });
    await flushAsync();

    expect(bridge.getSession(sid)!.pendingCodexTurns).toEqual([
      expect.objectContaining({
        userMessageId: tracked.userMessageId,
        status: "recovery_pending",
        terminalHistoryReconciliation: expect.objectContaining({
          action: "continue",
          continuationMode: "verify_then_continue",
        }),
      }),
    ]);
    expect(
      adapter.sendBrowserMessage.mock.calls
        .map((args: any[]) => args[0])
        .filter((message: any) => message?.type === "codex_start_pending"),
    ).toHaveLength(1);
  });

  it("restores a pre-ACK recorded start without replaying its effectful payload", async () => {
    const sid = "s-pre-ack-start-resume";
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-pre-ack-start-resume" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    bridge.getSession(sid)!.state.isOrchestrator = true;

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "effect before ack" }));
    const start = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    const ownerId = start.pendingInputIds[0] as string;
    adapter1.emitUserMessageReceiptObserved({
      turnId: "turn-pre-ack-start-resume",
      clientUserMessageId: start.clientUserMessageId,
    });
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "pre-ack-resume-effect",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "tool_use", id: "tool-resume", name: "Bash", input: { command: "echo effect" } }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    adapter1.emitDisconnect("turn-pre-ack-start-resume");

    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const resumedTurn = {
      id: "turn-pre-ack-start-resume",
      status: "interrupted",
      error: null,
      itemsView: "full" as const,
      items: [
        { type: "userMessage", clientId: start.clientUserMessageId, content: [] },
        { type: "commandExecution", id: "tool-resume" },
      ],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-pre-ack-start-resume",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-pre-ack-start-resume",
        threadStatus: "idle",
        turnCount: 1,
        turns: [resumedTurn],
        lastTurn: resumedTurn,
      },
    });
    await flushAsync();

    const starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(1);
    expect(starts[0].pendingInputIds).not.toContain(ownerId);
    expect(getCodexStartPendingInputs(starts[0])[0]?.content).toContain("verification-first continuation");
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: ownerId,
      status: "continuation_pending",
      historyPresence: "present",
      continuationMode: "verify_then_continue",
    });
  });

  it("continues verification-first when turn/start records effects before its ACK fails", async () => {
    const sid = "s-pre-ack-start-failure";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-pre-ack-start-failure" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "perform one effect" }));
    const start = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    const originalOwnerId = start.pendingInputIds[0] as string;
    adapter.emitUserMessageReceiptObserved({
      turnId: "turn-pre-ack-start-failure",
      clientUserMessageId: start.clientUserMessageId,
    });
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "start-effect",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "tool_use", id: "tool-start", name: "Bash", input: { command: "echo effect" } }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    adapter.emitTurnStartFailed(start);
    await flushAsync();

    const starts = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(2);
    expect(starts[1].pendingInputIds).not.toContain(originalOwnerId);
    expect(getCodexStartPendingInputs(starts[1])[0]?.content).toContain("verification-first continuation");
    expect(bridge.getSession(sid)!.pendingCodexTurns.some((turn) => turn.userMessageId === originalOwnerId)).toBe(
      false,
    );
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId,
      status: "continuation_pending",
      historyPresence: "present",
      continuationMode: "verify_then_continue",
    });
  });

  it("tracks a steered owner before ACK and continues verification-first after a recorded failure", async () => {
    const sid = "s-pre-ack-steer-failure";
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-pre-ack-steer" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    adapter1.emitTurnStarted("turn-active");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "perform the steered effect" }),
    );
    const steer = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_steer_pending");
    expect(steer).toMatchObject({
      expectedTurnId: "turn-active",
      pendingInputIds: [expect.any(String)],
      clientUserMessageId: expect.any(String),
    });
    const ownerId = steer.pendingInputIds[0] as string;
    const provisional = bridge.getSession(sid)!.pendingCodexTurns.filter((turn) => turn.userMessageId === ownerId);
    expect(provisional).toHaveLength(1);
    expect(provisional[0]).toMatchObject({ status: "dispatched", turnId: "turn-active" });

    adapter1.emitUserMessageReceiptObserved({
      turnId: "turn-active",
      clientUserMessageId: steer.clientUserMessageId,
    });
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "steer-effect",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "tool_use", id: "tool-steer", name: "Bash", input: { command: "echo effect" } }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    adapter1.emitTurnSteerFailed(
      [ownerId],
      { kind: "other", expectedTurnId: "turn-active", message: "temporary steer failure" },
      steer.clientUserMessageId,
    );
    await Promise.resolve();

    const retained = bridge.getSession(sid)!.pendingCodexTurns.filter((turn) => turn.userMessageId === ownerId);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      status: "recovery_pending",
      historyIncorporation: { recordedSource: "live" },
      terminalHistoryReconciliation: { action: "continue", continuationMode: "verify_then_continue" },
    });

    adapter1.emitDisconnect("turn-active");
    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-pre-ack-steer" });
    await flushAsync();

    const starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(1);
    expect(starts[0].pendingInputIds).not.toContain(ownerId);
    expect(getCodexStartPendingInputs(starts[0])[0]?.content).toContain("verification-first continuation");
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: ownerId,
      status: "continuation_pending",
      continuationMode: "verify_then_continue",
    });
  });

  it("hard-stops a terminal pre-ACK steer failure without starting a continuation", async () => {
    const sid = "s-terminal-pre-ack-steer";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-terminal-steer" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    adapter.emitTurnStarted("turn-active");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "perform the protected steer" }),
    );
    const steer = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_steer_pending");
    const ownerId = steer.pendingInputIds[0] as string;
    adapter.emitUserMessageReceiptObserved({
      turnId: "turn-active",
      clientUserMessageId: steer.clientUserMessageId,
    });
    expect(bridge.getSession(sid)!.pendingCodexTurns[0]).toMatchObject({
      historyIncorporation: { recordedSource: "live" },
    });

    adapter.emitTurnSteerFailed(
      [ownerId],
      { kind: "other", expectedTurnId: "turn-active", message: "HTTP 401 Unauthorized" },
      steer.clientUserMessageId,
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(session.state).toMatchObject({
      backend_state: "broken",
      backend_error: expect.stringContaining("HTTP 401 Unauthorized"),
    });
    expect(session.pendingCodexTurns).toEqual([
      expect.objectContaining({
        userMessageId: ownerId,
        status: "recovery_pending",
        terminalHistoryReconciliation: expect.objectContaining({ action: "action_required" }),
      }),
    ]);
    expect(
      adapter.sendBrowserMessage.mock.calls
        .map((args: any[]) => args[0])
        .filter((message: any) => message?.type === "codex_start_pending"),
    ).toHaveLength(0);
    expect(session.state.codex_turn_recovery).toBeFalsy();

    adapter.sendBrowserMessage.mockClear();
    adapter.emitBrowserMessage(successResult(sid, "turn-active"));
    await flushAsync();

    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: ownerId,
      status: "action_required",
      reason: "recovery_failed",
    });
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
  });

  it("replays a proven-absent steered batch once without borrowing earlier-owner activity", async () => {
    // The active automatic owner is recorded and starts reasoning. A later
    // direct steer is RPC-accepted but never reaches Codex history before EOF.
    const sid = "s-recover-absent-steer";
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-absent-steer" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    bridge.getSession(sid)!.state.isOrchestrator = true;

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run the automatic task",
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
        threadKey: "q-9000",
        questId: "q-9000",
      }),
    );
    const firstStart = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    const firstClientId = firstStart?.clientUserMessageId as string;
    expect(firstClientId).toEqual(expect.any(String));
    adapter1.emitTurnStarted("turn-shared");
    adapter1.emitUserMessageRecorded({ turnId: "turn-shared", clientUserMessageId: firstClientId });
    adapter1.emitBrowserMessage({
      type: "codex_reasoning_detail",
      id: "initial-reasoning",
      text: "Working on the automatic task",
      status: "complete",
      timestamp: Date.now(),
      parent_tool_use_id: null,
      reasoning_turn_id: "turn-shared",
      reasoning_item_ordinal: 0,
      provider_item_id: "initial-reasoning-provider",
    } as any);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "answer this direct request",
        threadKey: "q-9001",
        questId: "q-9001",
      }),
    );
    const steer = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_steer_pending");
    expect(steer).toMatchObject({
      expectedTurnId: "turn-shared",
      pendingInputIds: [expect.any(String)],
      clientUserMessageId: expect.any(String),
    });
    const directOwnerId = steer.pendingInputIds[0] as string;
    const originalSteerClientId = steer.clientUserMessageId as string;
    adapter1.emitTurnSteered("turn-shared", [directOwnerId], originalSteerClientId);
    expect(bridge.getSession(sid)!.pendingCodexInputs.map((input) => input.id)).toContain(directOwnerId);

    adapter1.emitDisconnect("turn-shared");
    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const interruptedTurn = {
      id: "turn-shared",
      status: "interrupted",
      error: null,
      itemsView: "full" as const,
      items: [
        { type: "userMessage", clientId: firstClientId, content: [{ type: "text", text: "run the automatic task" }] },
        { type: "reasoning", summary: ["Working on the automatic task"] },
      ],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-absent-steer",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-absent-steer",
        threadStatus: "idle",
        turnCount: 1,
        turns: [interruptedTurn],
        lastTurn: interruptedTurn,
      },
    });
    await flushAsync();

    const recoveryStarts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(recoveryStarts).toHaveLength(1);
    expect(getCodexStartPendingInputs(recoveryStarts[0])[0]?.content).toContain("finish only the missing response");
    const recoveryState = bridge.getSession(sid)!.state.codex_turn_recovery;
    expect(recoveryState).toMatchObject({
      originalOwnerId: firstStart.pendingInputIds[0],
      continuationMode: "finish_response",
      status: "continuation_pending",
    });
    const continuationOwnerId = recoveryState!.continuationOwnerId!;
    expect(bridge.getSession(sid)!.pendingCodexTurns.map((turn) => turn.userMessageId)).toEqual([
      continuationOwnerId,
      directOwnerId,
    ]);
    expect(recoveryStarts[0].pendingInputIds).toEqual([continuationOwnerId]);
    expect(recoveryStarts[0].pendingInputIds).not.toContain(directOwnerId);
    expect(
      bridge.getSession(sid)!.pendingCodexTurns.find((turn) => turn.userMessageId === directOwnerId),
    ).toMatchObject({
      status: "recovery_pending",
      dispatchCount: 1,
      historyIncorporation: { attempt: 0, recordedAt: null },
      terminalHistoryReconciliation: { presence: "absent", action: "replay" },
    });

    adapter2.emitUserMessageRecorded({ turnId: "turn-shared", clientUserMessageId: originalSteerClientId });
    expect(
      bridge.getSession(sid)!.pendingCodexTurns.find((turn) => turn.userMessageId === directOwnerId)
        ?.historyIncorporation?.recordedAt,
    ).toBeNull();

    const continuationClientId = recoveryStarts[0].clientUserMessageId as string;
    adapter2.emitTurnStarted("turn-initial-continuation");
    expect(bridge.getSession(sid)!.codexFreshTurnRequiredUntilTurnId).toBe("turn-initial-continuation");
    adapter2.emitUserMessageRecorded({
      turnId: "turn-initial-continuation",
      clientUserMessageId: originalSteerClientId,
    });
    expect(
      adapter2.sendBrowserMessage.mock.calls
        .map((args: any[]) => args[0])
        .filter((message: any) => message?.type === "codex_steer_pending")
        .some((message: any) => message.pendingInputIds?.includes(directOwnerId)),
    ).toBe(false);
    adapter2.emitUserMessageRecorded({
      turnId: "turn-initial-continuation",
      clientUserMessageId: continuationClientId,
    });
    adapter2.emitBrowserMessage(successResult(sid, "turn-initial-continuation"));
    await flushAsync();
    expect(bridge.getSession(sid)!.codexFreshTurnRequiredUntilTurnId).toBeNull();

    const allStarts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(allStarts).toHaveLength(2);
    const replay = allStarts[1];
    expect(getCodexStartPendingInputs(replay)).toEqual([
      expect.objectContaining({ content: "answer this direct request" }),
    ]);
    expect(replay.clientUserMessageId).not.toBe(originalSteerClientId);
    expect(String(replay.clientUserMessageId).split(":")[0]).toBe(originalSteerClientId.split(":")[0]);
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: directOwnerId,
      status: "recovering",
      historyPresence: "absent",
    });

    adapter2.emitTurnStarted("turn-direct-replay");
    adapter2.emitDisconnect("turn-direct-replay");
    const adapter3 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter3 as any);
    const replayTurn = {
      id: "turn-direct-replay",
      status: "interrupted",
      error: null,
      itemsView: "full" as const,
      items: [],
    };
    adapter3.emitSessionMeta({
      cliSessionId: "thread-absent-steer",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-absent-steer",
        threadStatus: "idle",
        turnCount: 3,
        turns: [interruptedTurn, replayTurn],
        lastTurn: replayTurn,
      },
    });
    await flushAsync();
    expect(adapter3.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "codex_start_pending" }),
    );
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: directOwnerId,
      status: "action_required",
      reason: "recovery_failed",
    });
  });

  it.each([
    false,
    true,
  ])("drains recorded and absent same-turn co-owners in FIFO order (old terminal: %s)", async (oldTerminal) => {
    // Each steer owns its own receipt boundary even though all three inputs
    // shared one provider turn. Recovery must finish A, then B, before the
    // proven-absent C payload is replayed as a fresh turn.
    const sid = "s-recover-same-turn-fifo";
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-same-turn-fifo" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    bridge.getSession(sid)!.state.isOrchestrator = true;

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "first owner", threadKey: "q-9100", questId: "q-9100" }),
    );
    const firstStart = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    const firstOwnerId = firstStart.pendingInputIds[0] as string;
    const firstClientId = firstStart.clientUserMessageId as string;
    adapter1.emitTurnStarted("turn-shared-fifo");
    adapter1.emitUserMessageRecorded({ turnId: "turn-shared-fifo", clientUserMessageId: firstClientId });

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "second owner", threadKey: "q-9101", questId: "q-9101" }),
    );
    const secondSteer = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_steer_pending")
      .at(-1);
    const secondOwnerId = secondSteer.pendingInputIds[0] as string;
    const secondClientId = secondSteer.clientUserMessageId as string;
    adapter1.emitTurnSteered("turn-shared-fifo", [secondOwnerId], secondClientId);
    adapter1.emitUserMessageRecorded({ turnId: "turn-shared-fifo", clientUserMessageId: secondClientId });

    // Re-keyed duplicate assistant completion is presentation-only: the
    // exact user's receipt and post-receipt activity must survive deduplication.
    const timestamp = Date.now();
    for (const id of ["assistant-stream-identity", "assistant-completion-identity"]) {
      adapter1.emitBrowserMessage({
        type: "assistant",
        timestamp,
        parent_tool_use_id: null,
        codexMessagePhase: "commentary",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: "gpt-6-astra",
          stop_reason: null,
          content: [{ type: "text", text: "[thread:q-9101:C] Checking the second owner." }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }
    await Promise.resolve();
    const secondTracked = bridge
      .getSession(sid)!
      .pendingCodexTurns.find((turn) => turn.userMessageId === secondOwnerId)!;
    expect(secondTracked.historyIncorporation?.recordedAt).not.toBeNull();
    expect(secondTracked.providerReplayUnsafeActivityObserved).toBe(true);
    expect(
      bridge
        .getSession(sid)!
        .messageHistory.filter(
          (entry) =>
            entry.type === "assistant" &&
            entry.message.content.some(
              (block) => block.type === "text" && block.text.includes("Checking the second owner."),
            ),
        ),
    ).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "third owner", threadKey: "q-9102", questId: "q-9102" }),
    );
    const thirdSteer = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_steer_pending")
      .at(-1);
    const thirdOwnerId = thirdSteer.pendingInputIds[0] as string;
    const thirdClientId = thirdSteer.clientUserMessageId as string;
    adapter1.emitTurnSteered("turn-shared-fifo", [thirdOwnerId], thirdClientId);

    // A terminal Main recovery must remain unresolved without monopolizing
    // the continuation slot needed by independent quest-owned input.
    const oldRecovery = {
      recoveryId: "older-main-owner",
      originalOwnerId: "older-main-owner",
      originalProviderTurnId: "older-provider-turn",
      originalHistoryIndex: 0,
      continuationOwnerId: "older-continuation",
      threadKey: "main",
      status: "action_required" as const,
      reason: "continuation_interrupted" as const,
      historyPresence: "unknown" as const,
      continuationMode: "verify_then_continue" as const,
      attempt: 1,
      maxAttempts: 1 as const,
      createdAt: 1,
      updatedAt: 2,
    };
    if (oldTerminal) bridge.getSession(sid)!.state.codex_turn_recovery = oldRecovery;
    adapter1.emitDisconnect("turn-shared-fifo");
    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const interruptedTurn = {
      id: "turn-shared-fifo",
      status: "interrupted",
      error: null,
      itemsView: "full" as const,
      items: [
        { type: "userMessage", clientId: firstClientId, content: [{ type: "text", text: "first owner" }] },
        { type: "reasoning", summary: ["working on first"] },
        { type: "userMessage", clientId: secondClientId, content: [{ type: "text", text: "second owner" }] },
        { type: "reasoning", summary: ["working on second"] },
      ],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-same-turn-fifo",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-same-turn-fifo",
        threadStatus: "idle",
        turnCount: 1,
        turns: [interruptedTurn],
        lastTurn: interruptedTurn,
      },
    });
    await flushAsync();

    let starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(1);
    expect(bridge.getSession(sid)!.codexTerminalRecoveries).toEqual(oldTerminal ? [oldRecovery] : []);
    const firstContinuationOwnerId = starts[0].pendingInputIds[0] as string;
    expect(firstContinuationOwnerId).not.toBe(firstOwnerId);
    expect(getCodexStartPendingInputs(starts[0])[0]?.content).toContain("finish only the missing response");
    expect(bridge.getSession(sid)!.pendingCodexTurns.map((turn) => turn.userMessageId)).toEqual([
      firstContinuationOwnerId,
      secondOwnerId,
      thirdOwnerId,
    ]);
    expect(bridge.getSession(sid)!.pendingCodexTurns[1]).toMatchObject({
      status: "recovery_pending",
      terminalHistoryReconciliation: { presence: "present", action: "continue" },
    });
    expect(bridge.getSession(sid)!.pendingCodexTurns[2]).toMatchObject({
      status: "recovery_pending",
      terminalHistoryReconciliation: { presence: "absent", action: "replay" },
      historyIncorporation: { clientUserMessageId: thirdClientId, attempt: 0 },
    });

    adapter2.emitTurnStarted("turn-first-continuation");
    adapter2.emitUserMessageRecorded({
      turnId: "turn-first-continuation",
      clientUserMessageId: starts[0].clientUserMessageId,
    });
    adapter2.emitBrowserMessage(successResult(sid, "turn-first-continuation"));
    await flushAsync();

    starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(2);
    const secondContinuation = starts[1];
    const secondContinuationOwnerId = secondContinuation.pendingInputIds[0] as string;
    expect(secondContinuationOwnerId).not.toBe(secondOwnerId);
    expect(getCodexStartPendingInputs(secondContinuation)[0]?.content).toContain("finish only the missing response");
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: secondOwnerId,
      continuationOwnerId: secondContinuationOwnerId,
      threadKey: "q-9101",
    });

    adapter2.emitTurnStarted("turn-second-continuation");
    adapter2.emitUserMessageRecorded({
      turnId: "turn-second-continuation",
      clientUserMessageId: secondContinuation.clientUserMessageId,
    });
    adapter2.emitBrowserMessage(successResult(sid, "turn-second-continuation"));
    await flushAsync();

    starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(3);
    expect(bridge.getSession(sid)!.codexTerminalRecoveries).toEqual(oldTerminal ? [oldRecovery] : []);
    const replay = starts[2];
    expect(replay.pendingInputIds).toEqual([thirdOwnerId]);
    expect(getCodexStartPendingInputs(replay)).toEqual([expect.objectContaining({ content: "third owner" })]);
    expect(replay.clientUserMessageId).not.toBe(thirdClientId);
    expect(String(replay.clientUserMessageId).endsWith(":1")).toBe(true);
    expect(
      adapter2.sendBrowserMessage.mock.calls
        .map((args: any[]) => args[0])
        .filter((message: any) => message?.type === "codex_steer_pending")
        .some((message: any) => message.pendingInputIds?.includes(thirdOwnerId)),
    ).toBe(false);
    adapter2.emitTurnStarted("turn-final-input");
    adapter2.emitUserMessageRecorded({ turnId: "turn-final-input", clientUserMessageId: replay.clientUserMessageId });
    adapter2.emitBrowserMessage(successResult(sid, "turn-final-input"));
    await flushAsync();
    expect(bridge.getSession(sid)!.pendingCodexInputs).toEqual([]);
    expect(bridge.getSession(sid)!.pendingCodexTurns).toEqual([]);
    expect(bridge.getSession(sid)!.codexTerminalRecoveries).toEqual(oldTerminal ? [oldRecovery] : []);
    for (const ownerId of [firstOwnerId, secondOwnerId, thirdOwnerId]) {
      expect(
        bridge.getSession(sid)!.messageHistory.filter((entry) => entry.type === "user_message" && entry.id === ownerId),
      ).toHaveLength(1);
    }
  });

  it("treats a resume snapshot without an explicit full items view as unknown", async () => {
    const sid = "s-recover-missing-items-view";
    const adapter1 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-missing-items-view" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    bridge.getSession(sid)!.state.isOrchestrator = true;

    const request = "perform the potentially stateful work";
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: request, threadKey: "q-9200", questId: "q-9200" }),
    );
    const originalStart = adapter1.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    adapter1.emitTurnStarted("turn-missing-items-view");
    adapter1.emitDisconnect("turn-missing-items-view");

    const adapter2 = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const incompleteTurn = {
      id: "turn-missing-items-view",
      status: "interrupted",
      error: null,
      items: [],
    };
    adapter2.emitSessionMeta({
      cliSessionId: "thread-missing-items-view",
      model: "gpt-5.6-sol",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-missing-items-view",
        threadStatus: "idle",
        turnCount: 1,
        turns: [incompleteTurn],
        lastTurn: incompleteTurn,
      },
    });
    await flushAsync();

    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: originalStart.pendingInputIds[0],
      historyPresence: "unknown",
      continuationMode: "verify_then_continue",
      status: "continuation_pending",
    });
    const starts = adapter2.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(1);
    expect(getCodexStartPendingInputs(starts[0])[0]?.content).toContain("verification-first continuation");
    expect(getCodexStartPendingInputs(starts[0])[0]?.content).not.toBe(request);
    expect(starts[0].clientUserMessageId).not.toBe(originalStart.clientUserMessageId);
  });

  it("does not let a shared terminal result settle an unreceipted steer", async () => {
    const sid = "s-terminal-unreceipted-steer";
    const adapter = makeReceiptAwareCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-terminal-unreceipted" });
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    await subscribeCurrentBrowser(bridge, browser);
    bridge.getSession(sid)!.state.isOrchestrator = true;

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "received owner", threadKey: "q-9300", questId: "q-9300" }),
    );
    const firstStart = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .find((message: any) => message?.type === "codex_start_pending");
    adapter.emitTurnStarted("turn-terminal-shared");
    adapter.emitUserMessageRecorded({
      turnId: "turn-terminal-shared",
      clientUserMessageId: firstStart.clientUserMessageId,
    });

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({ type: "user_message", content: "unreceipted owner", threadKey: "q-9301", questId: "q-9301" }),
    );
    const steer = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_steer_pending")
      .at(-1);
    const unreceiptedOwnerId = steer.pendingInputIds[0] as string;
    adapter.emitTurnSteered("turn-terminal-shared", [unreceiptedOwnerId], steer.clientUserMessageId);

    adapter.emitBrowserMessage(successResult(sid, "turn-terminal-shared"));
    await flushAsync();

    const starts = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message?.type === "codex_start_pending");
    expect(starts).toHaveLength(2);
    const recoveryStart = starts[1];
    expect(recoveryStart.pendingInputIds).not.toContain(unreceiptedOwnerId);
    expect(getCodexStartPendingInputs(recoveryStart)[0]?.content).toContain("verification-first continuation");
    expect(getCodexStartPendingInputs(recoveryStart)[0]?.content).not.toBe("unreceipted owner");
    expect(bridge.getSession(sid)!.state.codex_turn_recovery).toMatchObject({
      originalOwnerId: unreceiptedOwnerId,
      historyPresence: "unknown",
      continuationMode: "verify_then_continue",
      status: "continuation_pending",
      threadKey: "q-9301",
    });
    expect(bridge.getSession(sid)!.pendingCodexTurns).toHaveLength(1);
    expect(bridge.getSession(sid)!.pendingCodexTurns[0].userMessageId).toBe(recoveryStart.pendingInputIds[0]);
    expect(
      bridge
        .getSession(sid)!
        .messageHistory.filter((message: any) => message.type === "user_message" && message.id === unreceiptedOwnerId),
    ).toHaveLength(1);
  });
});
