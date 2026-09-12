import { randomUUID } from "node:crypto";
import type { CodexAdapterDisconnectDiagnostics } from "./codex-adapter-diagnostics-types.js";
import type { RecorderManager } from "./recorder.js";
import type { JsonRpcMessageSummary } from "./codex-jsonrpc-transport.js";
import { createLogger } from "./server-logger.js";

const logger = createLogger("codex-close");
const MAX_RPC_ENTRIES = 12;

type CloseEvent =
  | "codex_adapter_transport_closed"
  | "codex_process_exited_before_transport_close"
  | "codex_process_exit_after_transport_close";

/** Persist compact lifecycle evidence even when raw protocol recording is off. */
export function recordCodexClose(
  event: CloseEvent,
  diagnostics: CodexAdapterDisconnectDiagnostics,
  recorder?: RecorderManager,
): void {
  logger.info(event, buildCodexCloseLogContext(diagnostics));
  // Retain the existing full diagnostic in an explicitly enabled recording.
  recorder?.recordServerEvent(
    diagnostics.sessionId,
    event,
    diagnostics as unknown as Record<string, unknown>,
    "codex",
    diagnostics.adapter.cwd ?? "",
  );
}

/** Prefer stable references to already retained evidence instead of duplicating it. */
export function buildCodexCloseLogContext(diagnostics: CodexAdapterDisconnectDiagnostics): Record<string, unknown> {
  const transport = diagnostics.transport;
  const pending = diagnostics.pendingRpcRequests;
  return {
    sessionId: diagnostics.sessionId,
    closeId: diagnostics.closeId,
    capturedAt: diagnostics.capturedAt,
    reason: diagnostics.reason,
    process: diagnostics.process,
    connected: diagnostics.adapter.connected,
    initialized: diagnostics.adapter.initialized,
    transport: transport
      ? {
          closedAt: transport.closedAt,
          closeContext: compactLabel(transport.closeContext),
          bufferedChars: transport.bufferedChars,
          lastIncomingAt: transport.lastIncomingAt,
          lastOutgoingAt: transport.lastOutgoingAt,
          recentIncoming: transport.recentIncoming.slice(-MAX_RPC_ENTRIES).map(compactRpcSummary),
          recentOutgoing: transport.recentOutgoing.slice(-MAX_RPC_ENTRIES).map(compactRpcSummary),
        }
      : null,
    pendingRequests: pending
      .slice(0, MAX_RPC_ENTRIES)
      .map(({ id, method, ageMs }) => ({ id, method: compactLabel(method), ageMs })),
    omittedPendingRequests: Math.max(0, pending.length - MAX_RPC_ENTRIES),
    skillRefresh: {
      inFlightCount: diagnostics.skillRefresh.inFlightCount,
      inFlightCauses: diagnostics.skillRefresh.inFlight.slice(0, MAX_RPC_ENTRIES).map((entry) => entry.cause),
      stale: diagnostics.skillRefresh.stale,
    },
    resource: diagnostics.resource,
    evidence: {
      sessionId: diagnostics.sessionId,
      codexThreadId: diagnostics.adapter.threadId,
      codexTurnId: diagnostics.adapter.currentTurnId,
      recording: diagnostics.recording
        ? {
            filePath: diagnostics.recording.filePath,
            lineCount: diagnostics.recording.lineCount,
            bufferedLines: diagnostics.recording.bufferedLines,
          }
        : null,
      // Session/time identify the retained transcript and stderr log window.
      // This is a size choice, not a prohibition on inspecting local contents.
      stderrPresent: diagnostics.stderrTail !== null,
    },
  };
}

function compactRpcSummary(entry: JsonRpcMessageSummary): JsonRpcMessageSummary {
  return {
    direction: entry.direction,
    ts: entry.ts,
    bytes: entry.bytes,
    method: entry.method === null ? null : compactLabel(entry.method),
    id: entry.id,
    kind: entry.kind,
  };
}

function compactLabel(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 160)} [${value.length} chars]`;
}

/** Record intent before sending a signal; this is not proof that a process exited. */
export function recordCodexProcessTermination(
  session: { sessionId: string; backendType?: string } | undefined,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  initiator: string,
): void {
  if (session?.backendType !== "codex") return;
  logger.info("codex_process_termination_requested", {
    sessionId: session.sessionId,
    requestId: randomUUID(),
    requestedAt: Date.now(),
    pid,
    signal,
    initiator,
  });
}
