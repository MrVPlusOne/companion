import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../session-types.js";
import {
  handleCodexAdapterBrowserMessage,
  type CodexAdapterBrowserMessageDeps,
} from "./codex-adapter-browser-message-controller.js";
import { buildBackendStateSnapshot } from "./backend-state-snapshot.js";
import { isReplayableBufferedEvent, shouldBufferForReplay } from "./replay-buffer-policy.js";
import {
  buildPersistedSessionPayload,
  restorePersistedSessions,
  setBackendState,
} from "./session-registry-controller.js";

function update(turnId: string | null): BrowserIncomingMessage {
  return { type: "session_update", session: { codex_stream_retry: turnId ? { turnId } : null } };
}

describe("Codex internal retry server state", () => {
  it("broadcasts one authoritative state while repeated reports update liveness without activity proof", async () => {
    const session = {
      id: "session-retry",
      state: { codex_stream_retry: null },
      codexAdapter: { getCurrentTurnId: () => "current-turn" },
      pendingCodexTurns: [{ userMessageId: "owner", providerReplayUnsafeActivityObserved: false }],
      messageHistory: [],
    };
    const deps = {
      touchActivity: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      clearOptimisticRunningTimer: vi.fn(),
    };
    const handle = (message: BrowserIncomingMessage) =>
      handleCodexAdapterBrowserMessage(session, message, deps as unknown as CodexAdapterBrowserMessageDeps);

    await handle(update("current-turn"));
    await handle(update("current-turn"));
    await handle(update("other-turn"));
    expect(session.state.codex_stream_retry).toEqual({ turnId: "current-turn" });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledTimes(1);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, update("current-turn"));
    expect(deps.touchActivity).toHaveBeenCalledTimes(2);
    expect(deps.persistSession).not.toHaveBeenCalled();
    expect(deps.clearOptimisticRunningTimer).not.toHaveBeenCalled();
    expect(session.pendingCodexTurns[0].providerReplayUnsafeActivityObserved).toBe(false);
    expect(session.messageHistory).toEqual([]);

    await handle(update(null));
    expect(session.state.codex_stream_retry).toBeNull();
    expect(deps.broadcastToBrowsers).toHaveBeenLastCalledWith(session, update(null));
  });

  it("never buffers the ephemeral progress or its clear for replay", () => {
    for (const message of [update("current-turn"), update(null)]) {
      expect(shouldBufferForReplay(message)).toBe(false);
      expect(isReplayableBufferedEvent({ seq: 1, message })).toBe(false);
    }
    // A disconnect patch still carries authoritative backend/error state.
    expect(
      shouldBufferForReplay({
        type: "session_update",
        session: { backend_state: "disconnected", codex_stream_retry: null },
      }),
    ).toBe(true);
  });

  it("uses current adapter ownership for every reconnect snapshot", () => {
    const session = {
      state: { codex_stream_retry: { turnId: "current-turn" } },
      codexAdapter: { getCurrentTurnId: () => "current-turn" as string | null },
    };
    const deps = {
      backendConnected: () => true,
      deriveBackendState: () => "connected" as const,
    };
    const first = buildBackendStateSnapshot(session, deps);
    const second = buildBackendStateSnapshot(session, deps);
    expect(first.codexStreamRetry).toEqual({ turnId: "current-turn" });
    expect(second.codexStreamRetry).toEqual(first.codexStreamRetry);
    session.codexAdapter.getCurrentTurnId = () => "next-turn";
    expect(buildBackendStateSnapshot(session, deps).codexStreamRetry).toBeNull();
    session.codexAdapter.getCurrentTurnId = () => "current-turn";
    expect(buildBackendStateSnapshot(session, { ...deps, backendConnected: () => false }).codexStreamRetry).toBeNull();
  });

  it.each([
    "disconnected",
    "initializing",
    "resuming",
    "recovering",
    "broken",
    "recovery_suppressed",
  ] as const)("clears stream progress when the backend becomes %s", (backendState) => {
    const session = {
      state: { backend_state: "connected", backend_error: null, codex_stream_retry: { turnId: "current-turn" } },
    };
    const broadcastSessionUpdate = vi.fn();
    setBackendState(session, backendState, null, { broadcastSessionUpdate });
    expect(session.state.codex_stream_retry).toBeNull();
    expect(broadcastSessionUpdate).toHaveBeenCalledWith(session, {
      backend_state: backendState,
      backend_error: null,
      codex_stream_retry: null,
    });
  });

  it("drops stale persisted retry state at restore and excludes it from the next disk payload", async () => {
    // Entire restore is in-memory with inert dependencies; no live session or
    // durable user directory is opened, written, or reset by this test.
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        {
          id: "restored-retry",
          state: { backend_type: "codex", codex_stream_retry: { turnId: "old-process-turn" } },
          messageHistory: [],
          pendingPermissions: [],
          pendingMessages: [],
          pendingCodexInputs: [],
          pendingCodexTurns: [],
        },
      ],
      {
        recoverToolStartTimesFromHistory: vi.fn(),
        finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
        scheduleCodexToolResultWatchdogs: vi.fn(),
        reconcileRestoredBoardState: vi.fn(async () => {}),
      },
    );
    const session = sessions.get("restored-retry");
    expect(session.state.codex_stream_retry).toBeNull();
    session.state.codex_stream_retry = { turnId: "new-process-turn" };
    expect(buildPersistedSessionPayload(session).state).not.toHaveProperty("codex_stream_retry");
    expect(session.state.codex_stream_retry).toEqual({ turnId: "new-process-turn" });
  });
});
