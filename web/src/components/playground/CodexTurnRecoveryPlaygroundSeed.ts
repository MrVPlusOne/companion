import { useStore } from "../../store.js";
import type { SessionState } from "../../types.js";
import {
  PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID,
} from "./fixtures.js";
import { buildPlaygroundActionRequiredRecoveryMessages } from "./CodexRecoveryPlaygroundMessages.js";

type PlaygroundStore = ReturnType<typeof useStore.getState>;

export function seedCodexTurnRecoveryPlaygroundStates(store: PlaygroundStore, session: SessionState): void {
  const recoveryBase = {
    recoveryId: "playground-interrupted-turn",
    originalOwnerId: "playground-interrupted-owner",
    originalProviderTurnId: "playground-provider-turn",
    originalHistoryIndex: 42,
    threadKey: "q-9010",
    questId: "q-9010",
    maxAttempts: 1 as const,
    createdAt: Date.now() - 75_000,
  };

  addRecoverySession(store, session, PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID, {
    backend_state: "recovering",
    backend_reconnect: { attempt: 1, maxAttempts: 5, cycleStartedAt: Date.now() - 15_000 },
    codex_turn_recovery: {
      ...recoveryBase,
      continuationOwnerId: null,
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence: "unknown",
      continuationMode: null,
      attempt: 0,
      updatedAt: Date.now() - 15_000,
    },
    cliConnected: false,
  });

  addRecoverySession(store, session, PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID, {
    backend_state: "connected",
    codex_turn_recovery: {
      ...recoveryBase,
      continuationOwnerId: null,
      status: "recovering",
      reason: "adapter_disconnect",
      historyPresence: "absent",
      continuationMode: null,
      attempt: 0,
      updatedAt: Date.now() - 11_000,
    },
    cliConnected: true,
  });

  addRecoverySession(store, session, PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID, {
    backend_state: "connected",
    codex_turn_recovery: {
      ...recoveryBase,
      continuationOwnerId: "playground-continuation-pending",
      status: "continuation_pending",
      reason: "interrupted_after_activity",
      historyPresence: "unknown",
      continuationMode: "verify_then_continue",
      attempt: 1,
      updatedAt: Date.now() - 8_000,
    },
    cliConnected: true,
  });

  addRecoverySession(store, session, PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID, {
    backend_state: "connected",
    codex_turn_recovery: {
      ...recoveryBase,
      continuationOwnerId: "playground-continuation-active",
      status: "continuation_active",
      reason: "interrupted_after_activity",
      historyPresence: "present",
      continuationMode: "finish_response",
      attempt: 1,
      updatedAt: Date.now() - 4_000,
    },
    cliConnected: true,
  });

  addRecoverySession(store, session, PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID, {
    backend_state: "connected",
    codex_turn_recovery: {
      ...recoveryBase,
      continuationOwnerId: "playground-continuation-action-required",
      status: "action_required",
      reason: "continuation_interrupted",
      historyPresence: "unknown",
      continuationMode: "verify_then_continue",
      attempt: 1,
      updatedAt: Date.now() - 1_000,
    },
    cliConnected: true,
  });
  store.setMessages(
    PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID,
    buildPlaygroundActionRequiredRecoveryMessages(recoveryBase.recoveryId),
  );
  // Pending delivery stays visible without presenting the retained recovery as active work.
  store.setSessionStatus(PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID, "idle");
  store.setPendingCodexInputs(PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID, [
    {
      id: "playground-recovery-pending-followup",
      content: "Check whether the settings change still needs follow-up.",
      timestamp: Date.now(),
      cancelable: true,
    },
  ]);
}

function addRecoverySession(
  store: PlaygroundStore,
  session: SessionState,
  sessionId: string,
  state: Pick<SessionState, "backend_state" | "codex_turn_recovery"> & {
    backend_reconnect?: SessionState["backend_reconnect"];
    cliConnected: boolean;
  },
): void {
  store.addSession({
    ...session,
    session_id: sessionId,
    backend_type: "codex",
    backend_state: state.backend_state,
    backend_error: null,
    ...(state.backend_reconnect ? { backend_reconnect: state.backend_reconnect } : {}),
    codex_turn_recovery: state.codex_turn_recovery,
    model: "gpt-5.3-codex",
  });
  store.setConnectionStatus(sessionId, "connected");
  store.setCliConnected(sessionId, state.cliConnected);
  store.setCliEverConnected(sessionId);
  store.setSessionStatus(sessionId, null);
}
