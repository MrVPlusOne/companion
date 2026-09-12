import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAdapterDisconnectDiagnostics } from "./codex-adapter-diagnostics-types.js";
import { recordCodexClose, recordCodexProcessTermination } from "./codex-close-diagnostics.js";
import { _resetServerLoggerForTest, initServerLogger, queryServerLogs } from "./server-logger.js";

function fixture(): CodexAdapterDisconnectDiagnostics {
  return {
    closeId: "close-fixture",
    reason: "transport_close",
    sessionId: "session-fixture",
    capturedAt: 200,
    process: { pid: 123, pidAlive: true, exitCode: null, eofToExitMs: null },
    adapter: {
      threadId: "thread-fixture",
      currentTurnId: "turn-fixture",
      model: "fixture",
      cwd: "/fixture",
      approvalMode: null,
      sandbox: null,
      connected: true,
      initialized: true,
    },
    transport: {
      closeId: "close-fixture",
      sessionId: "session-fixture",
      closedAt: 200,
      closeContext: "stdout_eof(buffer=0)",
      bufferedChars: 0,
      pendingRequests: [],
      lastIncomingAt: 190,
      lastOutgoingAt: 180,
      recentIncoming: [
        { direction: "in", ts: 190, bytes: 100, method: "item/completed", id: null, kind: "notification" },
      ],
      recentOutgoing: [{ direction: "out", ts: 180, bytes: 80, method: "turn/start", id: 1, kind: "request" }],
    },
    pendingRpcRequests: Array.from({ length: 20 }, (_, id) => ({ id, method: "thread/read", ageMs: id + 10 })),
    skillRefresh: {
      inFlightCount: 0,
      inFlight: [],
      last: null,
      lastChange: null,
      stats: { coalesced: 0, deferred: 0, executed: 0, failed: 0, suppressed: 0 },
      stale: true,
      staleSince: 1,
      retryCount: 0,
    },
    stderrTail: "already retained local evidence ".repeat(10000),
    resource: { rssMb: 100, heapUsedMb: 50 },
    recording: null,
  };
}

describe("Codex close diagnostic retention", () => {
  let logDir: string;
  beforeEach(async () => {
    _resetServerLoggerForTest();
    logDir = await mkdtemp(join(tmpdir(), "codex-close-logs-"));
    initServerLogger(0, { logDir, captureConsole: false });
  });
  afterEach(async () => {
    _resetServerLoggerForTest();
    await rm(logDir, { recursive: true, force: true });
  });

  it("persists bounded RPC and evidence references without enabling recording", async () => {
    // Existing local content remains inspectable through session/thread/turn
    // identity; ordinary close records avoid copying a large retained payload.
    const diagnostics = fixture();
    diagnostics.pendingRpcRequests[0]!.method = "unexpected-method".repeat(1000);
    recordCodexClose("codex_adapter_transport_closed", diagnostics);
    const logs = await queryServerLogs({ components: ["codex-close"] });
    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({
      sessionId: "session-fixture",
      meta: {
        closeId: "close-fixture",
        process: { pid: 123, pidAlive: true, exitCode: null },
        transport: { closeContext: "stdout_eof(buffer=0)", lastIncomingAt: 190, lastOutgoingAt: 180 },
        omittedPendingRequests: 8,
        evidence: {
          sessionId: "session-fixture",
          codexThreadId: "thread-fixture",
          codexTurnId: "turn-fixture",
          recording: null,
          stderrPresent: true,
        },
      },
    });
    expect((logs.entries[0]!.meta?.pendingRequests as unknown[]).length).toBe(12);
    expect(JSON.stringify(logs.entries[0]).length).toBeLessThan(5000);
  });

  it("keeps signal requests and exit ordering distinct and retains opted-in recording evidence", async () => {
    const diagnostics = fixture();
    diagnostics.recording = {
      filePath: "/fixture/recording.jsonl",
      lineCount: 42,
      bufferedLines: 2,
      flushing: false,
      closed: false,
    };
    const recorder = { recordServerEvent: vi.fn() };
    recordCodexClose("codex_adapter_transport_closed", diagnostics, recorder as never);
    recordCodexProcessTermination(
      { sessionId: diagnostics.sessionId, backendType: "codex" },
      123,
      "SIGTERM",
      "relaunch",
    );
    diagnostics.process = { pid: 123, pidAlive: false, exitCode: 143, eofToExitMs: 22 };
    recordCodexClose("codex_process_exit_after_transport_close", diagnostics, recorder as never);
    const logs = await queryServerLogs({ components: ["codex-close"] });
    const ordered = [...logs.entries].sort((a, b) => a.seq - b.seq);
    expect(ordered.map((entry) => entry.message)).toEqual([
      "codex_adapter_transport_closed",
      "codex_process_termination_requested",
      "codex_process_exit_after_transport_close",
    ]);
    expect(ordered[1]?.meta).toMatchObject({
      pid: 123,
      signal: "SIGTERM",
      initiator: "relaunch",
      requestId: expect.any(String),
    });
    expect(ordered[2]?.meta).toMatchObject({
      closeId: "close-fixture",
      process: { exitCode: 143, eofToExitMs: 22 },
      evidence: { recording: { filePath: "/fixture/recording.jsonl", lineCount: 42 } },
    });
    expect(recorder.recordServerEvent).toHaveBeenCalledWith(
      diagnostics.sessionId,
      "codex_process_exit_after_transport_close",
      diagnostics,
      "codex",
      "/fixture",
    );
  });

  it("does not add Codex termination diagnostics to other backends", async () => {
    // The shared launcher must preserve Claude's existing lifecycle behavior.
    recordCodexProcessTermination(
      { sessionId: "claude-fixture", backendType: "claude" },
      123,
      "SIGTERM",
      "launcher.kill",
    );
    recordCodexProcessTermination(undefined, 123, "SIGTERM", "launcher.kill");
    expect((await queryServerLogs({ components: ["codex-close"] })).entries).toHaveLength(0);
  });
});
