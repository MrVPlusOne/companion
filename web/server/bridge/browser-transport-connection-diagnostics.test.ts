import { describe, expect, it, vi } from "vitest";
import { subscribeToServerLogs } from "../server-logger.js";
import type { ServerLogEntry } from "../../shared/logging.js";
import {
  broadcastToBrowsers,
  handleBrowserClose,
  handleBrowserMessage,
  handleBrowserOpen,
  sendToBrowserRaw,
  type BrowserTransportDeps,
  type BrowserTransportSessionLike,
} from "./browser-transport-controller.js";
import { shouldBufferForReplay } from "./replay-buffer-policy.js";

function fixture() {
  const session: BrowserTransportSessionLike = {
    id: "diagnostic-session",
    backendType: "codex",
    browserSockets: new Set(),
    messageHistory: [],
    frozenCount: 0,
    state: {
      session_id: "diagnostic-session",
      cwd: "/fixture",
      permissionMode: "default",
    } as BrowserTransportSessionLike["state"],
    nextEventSeq: 1,
    lastAckSeq: 0,
    pendingPermissions: new Map(),
    pendingCodexInputs: [],
    pendingCodexTurns: [],
    taskHistory: [],
    eventBuffer: [],
    lastReadAt: 0,
    attentionReason: null,
    generationStartedAt: null,
    notifications: [],
    attentionRecords: [],
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
  };
  const deps = {
    eventBufferLimit: 100,
    persistSession: vi.fn(),
    recordOutgoingRaw: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    prefillSlashCommands: vi.fn(),
    getTreeGroupState: async () => ({ groups: [], assignments: {}, nodeOrder: {} }),
    getVsCodeSelectionState: () => null,
    getLauncherSessionInfo: () => ({ isOrchestrator: false, state: "connected", backendType: "codex" }),
    backendAttached: () => true,
    backendConnected: () => true,
    getRouteChain: () => undefined,
    routeBrowserMessage: vi.fn(),
    deriveBackendState: () => "connected",
    getBoard: () => [],
    getCompletedBoard: () => [],
    getBoardRowSessionStatuses: () => ({}),
    recoverToolStartTimesFromHistory: vi.fn(),
    finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
    scheduleCodexToolResultWatchdogs: vi.fn(),
    recomputeAndBroadcastHistoryBytes: vi.fn(),
    listTimers: () => [],
    idempotentMessageTypes: new Set(),
  } as unknown as BrowserTransportDeps;
  const socket = { data: { sessionId: session.id, browserClientPlatform: "ios" }, send: vi.fn((_raw: string) => 1) };
  return { session, deps, socket };
}

describe("connection diagnostics in browser transport", () => {
  it("keeps the first subscribe's completion when a later subscribe finishes sooner", async () => {
    // Initial tree preparation may await while another subscribe completes.
    // The later request must not claim that the first initialization is queued.
    const { session, deps, socket } = fixture();
    let releaseTree!: (value: { groups: never[]; assignments: {}; nodeOrder: {} }) => void;
    const tree = new Promise<{ groups: never[]; assignments: {}; nodeOrder: {} }>((resolve) => {
      releaseTree = resolve;
    });
    deps.getTreeGroupState = () => tree;
    const entries: ServerLogEntry[] = [];
    const unsubscribe = subscribeToServerLogs({ components: ["browser-connection"] }, (entry) => entries.push(entry));
    const subscribe = (lastSeq: number) =>
      handleBrowserMessage(
        session,
        JSON.stringify({
          type: "session_subscribe",
          last_seq: lastSeq,
          history_window_section_turn_count: 10,
          history_window_visible_section_count: 3,
        }),
        socket,
        deps,
      ).completion;
    try {
      handleBrowserOpen(session, socket, deps);
      const first = subscribe(0);
      await subscribe(17);
      expect(entries.some((entry) => entry.meta?.event === "initial_sync_queued")).toBe(false);
      releaseTree({ groups: [], assignments: {}, nodeOrder: {} });
      await first;
      expect(entries.filter((entry) => entry.meta?.event === "initial_sync_queued")).toHaveLength(1);
      expect(entries.find((entry) => entry.meta?.event === "initial_sync_queued")?.meta?.initialLastSeq).toBe(0);
    } finally {
      releaseTree({ groups: [], assignments: {}, nodeOrder: {} });
      handleBrowserClose(session, socket, deps);
      unsubscribe();
    }
  });

  it.each([0, 17])("accounts for real open/subscribe/direct/broadcast paths with last_seq=%s", async (lastSeq) => {
    // Cold and nonzero-sequence reconnects use the existing bounded producer
    // path. Only the new diagnostic marker is added after the state snapshot.
    const { session, deps, socket } = fixture();
    const entries: ServerLogEntry[] = [];
    const unsubscribe = subscribeToServerLogs({ components: ["browser-connection"] }, (entry) => entries.push(entry));
    try {
      handleBrowserOpen(session, socket, deps);
      const subscribe = handleBrowserMessage(
        session,
        JSON.stringify({
          type: "session_subscribe",
          last_seq: lastSeq,
          history_window_section_turn_count: 10,
          history_window_visible_section_count: 3,
        }),
        socket,
        deps,
      );
      await subscribe.completion;
      const messages = socket.send.mock.calls.map(([json]) => JSON.parse(json));
      expect(messages.slice(-2).map((message) => message.type)).toEqual(["state_snapshot", "browser_connection_probe"]);
      expect(messages.some((message) => message.type === "history_window_sync")).toBe(true);
      expect(messages.some((message) => message.type === "history_sync")).toBe(false);
      const queued = entries.find((entry) => entry.meta?.event === "initial_sync_queued")!.meta!;
      const initialBytes = socket.send.mock.calls.reduce((sum, [json]) => sum + Buffer.byteLength(json), 0);
      expect(queued).toMatchObject({
        initialLastSeq: lastSeq,
        acceptedMessages: messages.length,
        acceptedPayloadBytes: initialBytes,
        initialSyncAcceptedPayloadBytes: initialBytes,
      });

      const marker = messages.at(-1)!;
      expect(shouldBufferForReplay(marker)).toBe(false);
      await handleBrowserMessage(
        session,
        JSON.stringify({ type: "browser_connection_probe_ack", connection_id: marker.connection_id }),
        socket,
        deps,
      ).completion;
      expect(entries.some((entry) => entry.meta?.event === "client_marker_received")).toBe(true);
      expect(deps.routeBrowserMessage).not.toHaveBeenCalled();
      expect(session.eventBuffer).toHaveLength(0);
      expect(session.messageHistory).toHaveLength(0);

      sendToBrowserRaw(socket, JSON.stringify({ type: "timer_update", timers: [] }), "timer_update");
      broadcastToBrowsers(session, { type: "session_update", session: { model: "fixture-model" } }, deps);
      handleBrowserClose(session, socket, deps);
      const totalBytes = socket.send.mock.calls.reduce((sum, [json]) => sum + Buffer.byteLength(json), 0);
      expect(entries.at(-1)!.meta).toMatchObject({
        event: "closed",
        acceptedPayloadBytes: totalBytes,
        initialSyncAcceptedPayloadBytes: initialBytes,
      });
    } finally {
      handleBrowserClose(session, socket, deps);
      unsubscribe();
    }
  });
});
