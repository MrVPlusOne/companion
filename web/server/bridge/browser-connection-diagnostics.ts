import { randomUUID } from "node:crypto";
import { createLogger } from "../server-logger.js";

const logger = createLogger("browser-connection");
const LARGE_INITIAL_PAYLOAD_BYTES = 2 * 1024 * 1024;
const SLOW_INITIAL_SYNC_MS = 10_000;
const MAX_MESSAGE_TYPES = 32;
const REPORTED_MESSAGE_TYPES = 8;

export type BrowserClientPlatform = "ios" | "android" | "other" | "unknown";

interface DiagnosticSocket {
  data?: unknown;
  send(data: string): unknown;
  getBufferedAmount?(): number;
}

interface TransferTotals {
  attemptedMessages: number;
  acceptedMessages: number;
  acceptedPayloadBytes: number;
  droppedMessages: number;
  failedMessages: number;
  backpressuredMessages: number;
  peakBufferedBytes: number;
}

interface Connection {
  id: string;
  sessionId: string;
  clientPlatform: BrowserClientPlatform;
  openedAt: number;
  startedAt: number;
  subscribeStartedAt?: number;
  subscribeFinishedAt?: number;
  initialLastSeq?: number;
  explicitFullHistory?: boolean;
  initialPayloadBytes?: number;
  status:
    | "awaiting_subscribe"
    | "subscribing"
    | "awaiting_client_marker"
    | "client_marker_received"
    | "subscribe_failed";
  timer: ReturnType<typeof setTimeout>;
  totals: TransferTotals;
  types: Map<string, { messages: number; payloadBytes: number }>;
}

// Socket ownership bounds the lifetime; only counts and coarse metadata are retained.
const connections = new WeakMap<DiagnosticSocket, Connection>();

/** Classify a request without retaining its user agent, address, or URL. */
export function classifyBrowserClientPlatform(userAgent: string | null): BrowserClientPlatform {
  if (!userAgent) return "unknown";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

/** Start a new observation for every session WebSocket, including reconnects. */
export function openBrowserConnectionDiagnostics(ws: DiagnosticSocket, sessionId: string): void {
  const previous = connections.get(ws);
  if (previous) clearTimeout(previous.timer);
  const rawPlatform = (ws.data as { browserClientPlatform?: unknown } | undefined)?.browserClientPlatform;
  const clientPlatform =
    rawPlatform === "ios" || rawPlatform === "android" || rawPlatform === "other" ? rawPlatform : "unknown";
  const connection: Connection = {
    id: randomUUID(),
    sessionId,
    clientPlatform,
    openedAt: Date.now(),
    startedAt: performance.now(),
    status: "awaiting_subscribe",
    timer: setTimeout(() => {
      logConnection(connection, "initial_sync_slow", true);
    }, SLOW_INITIAL_SYNC_MS),
    totals: {
      attemptedMessages: 0,
      acceptedMessages: 0,
      acceptedPayloadBytes: 0,
      droppedMessages: 0,
      failedMessages: 0,
      backpressuredMessages: 0,
      peakBufferedBytes: 0,
    },
    types: new Map(),
  };
  connection.timer.unref?.();
  connections.set(ws, connection);
  logConnection(connection, "opened");
}

/** Preserve the transport's result/exception while observing actual send attempts. */
export function sendObservedBrowserPayload(ws: DiagnosticSocket, json: string, messageType: string): unknown {
  const connection = connections.get(ws);
  if (!connection) return ws.send(json);
  const totals = connection.totals;
  totals.attemptedMessages++;
  let result: unknown;
  try {
    result = ws.send(json);
  } catch (error) {
    totals.failedMessages++;
    throw error;
  }
  if (result === 0) {
    totals.droppedMessages++;
    return result;
  }
  // Bun's -1 means accepted with backpressure, not a negative byte count.
  const bytes = Buffer.byteLength(json, "utf8");
  totals.acceptedMessages++;
  totals.acceptedPayloadBytes += bytes;
  if (result === -1) totals.backpressuredMessages++;
  const buffered = ws.getBufferedAmount?.();
  if (typeof buffered === "number" && Number.isFinite(buffered)) {
    totals.peakBufferedBytes = Math.max(totals.peakBufferedBytes, buffered);
  }
  const key =
    /^[a-z_]{1,64}$/.test(messageType) &&
    (connection.types.has(messageType) || connection.types.size < MAX_MESSAGE_TYPES)
      ? messageType
      : "other";
  const bucket = connection.types.get(key) ?? { messages: 0, payloadBytes: 0 };
  bucket.messages++;
  bucket.payloadBytes += bytes;
  connection.types.set(key, bucket);
  return result;
}

/** Return ownership of the first subscribe observation; sequence zero alone does not prove a cold load. */
export function beginBrowserConnectionSubscribe(ws: DiagnosticSocket, lastSeq: number, fullHistory?: boolean): boolean {
  const connection = connections.get(ws);
  if (!connection || connection.status !== "awaiting_subscribe") return false;
  connection.subscribeStartedAt = performance.now();
  connection.initialLastSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  connection.explicitFullHistory = fullHistory === true;
  connection.status = "subscribing";
  return true;
}

/** Finish server handling and queue a content-free receipt marker behind the initial sync. */
export function finishBrowserConnectionSubscribe(ws: DiagnosticSocket, ok: boolean): void {
  const connection = connections.get(ws);
  if (!connection || connection.status !== "subscribing") return;
  connection.subscribeFinishedAt = performance.now();
  connection.status = ok ? "awaiting_client_marker" : "subscribe_failed";
  if (ok) {
    const marker = JSON.stringify({ type: "browser_connection_probe", connection_id: connection.id });
    try {
      sendObservedBrowserPayload(ws, marker, "browser_connection_probe");
    } catch {
      // Counted by the send observer. A diagnostic marker must not fail the subscription.
    }
  } else {
    clearTimeout(connection.timer);
  }
  connection.initialPayloadBytes = connection.totals.acceptedPayloadBytes;
  logConnection(connection, ok ? "initial_sync_queued" : "initial_sync_failed", !ok);
}

/** Accept a receipt only from the exact socket and outstanding initial marker. */
export function acknowledgeBrowserConnection(ws: DiagnosticSocket, connectionId: string): void {
  const connection = connections.get(ws);
  if (!connection || connection.id !== connectionId || connection.status !== "awaiting_client_marker") return;
  clearTimeout(connection.timer);
  connection.status = "client_marker_received";
  logConnection(connection, "client_marker_received");
}

/** Record lifetime totals, including early disconnects, and release diagnostic state. */
export function closeBrowserConnectionDiagnostics(ws: DiagnosticSocket): void {
  const connection = connections.get(ws);
  if (!connection) return;
  clearTimeout(connection.timer);
  logConnection(connection, "closed");
  connections.delete(ws);
}

function logConnection(connection: Connection, event: string, warn = false): void {
  const now = performance.now();
  const elapsedMs = Math.round(now - connection.startedAt);
  const initialBytes = connection.initialPayloadBytes ?? connection.totals.acceptedPayloadBytes;
  const warnings = [
    ...(event !== "opened" && initialBytes >= LARGE_INITIAL_PAYLOAD_BYTES ? ["large_initial_payload"] : []),
    ...(event !== "closed" && elapsedMs >= SLOW_INITIAL_SYNC_MS ? ["slow_initial_sync"] : []),
    ...(connection.totals.droppedMessages + connection.totals.failedMessages > 0 ? ["send_not_accepted"] : []),
  ];
  const byType = [...connection.types].map(([messageType, totals]) => ({ messageType, ...totals }));
  byType.sort((a, b) => b.payloadBytes - a.payloadBytes);
  const largestMessageTypes = byType.slice(0, REPORTED_MESSAGE_TYPES);
  const meta = {
    sessionId: connection.sessionId,
    connectionId: connection.id,
    event,
    clientPlatform: connection.clientPlatform,
    openedAt: connection.openedAt,
    elapsedMs,
    status: connection.status,
    initialLastSeq: connection.initialLastSeq,
    explicitFullHistory: connection.explicitFullHistory,
    subscribeStartDelayMs:
      connection.subscribeStartedAt === undefined
        ? undefined
        : Math.round(connection.subscribeStartedAt - connection.startedAt),
    subscribeHandlerMs:
      connection.subscribeStartedAt === undefined || connection.subscribeFinishedAt === undefined
        ? undefined
        : Math.round(connection.subscribeFinishedAt - connection.subscribeStartedAt),
    markerReceiptDelayMs:
      event === "client_marker_received" && connection.subscribeFinishedAt !== undefined
        ? Math.round(now - connection.subscribeFinishedAt)
        : undefined,
    initialSyncAcceptedPayloadBytes: connection.initialPayloadBytes,
    ...connection.totals,
    largestMessageTypes,
    otherAcceptedPayloadBytes: byType
      .slice(REPORTED_MESSAGE_TYPES)
      .reduce((total, bucket) => total + bucket.payloadBytes, 0),
    warnings,
    payloadUnit: "utf8_bytes_before_compression",
  };
  if (warn || warnings.length) logger.warn("Browser connection transfer", meta);
  else logger.info("Browser connection transfer", meta);
}
