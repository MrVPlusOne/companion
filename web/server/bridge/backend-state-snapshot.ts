import type { CodexOutboundTurn, SessionState } from "../session-types.js";
import { getLiveCodexProviderRetryState } from "./codex-provider-retry-state.js";

export interface BackendStateSnapshotSessionLike {
  state: Pick<
    SessionState,
    "backend_error" | "backend_reconnect" | "codex_provider_retry" | "codex_stream_retry" | "codex_turn_recovery"
  >;
  codexAdapter?: { getCurrentTurnId(): string | null } | null;
  pendingCodexTurns?: Array<Pick<CodexOutboundTurn, "userMessageId" | "status">>;
}

export interface BackendStateSnapshotDeps<Session extends BackendStateSnapshotSessionLike> {
  backendConnected: (session: Session) => boolean;
  deriveBackendState: (session: Session) => NonNullable<SessionState["backend_state"]>;
}

export function buildBackendStateSnapshot<Session extends BackendStateSnapshotSessionLike>(
  session: Session,
  deps: BackendStateSnapshotDeps<Session>,
): {
  backendConnected: boolean;
  backendState: NonNullable<SessionState["backend_state"]>;
  backendError: string | null;
  backendReconnect: SessionState["backend_reconnect"];
  codexProviderRetry: SessionState["codex_provider_retry"];
  codexStreamRetry: SessionState["codex_stream_retry"];
  codexTurnRecovery: SessionState["codex_turn_recovery"];
} {
  return {
    backendConnected: deps.backendConnected(session),
    backendState: deps.deriveBackendState(session),
    backendError: session.state.backend_error ?? null,
    backendReconnect: session.state.backend_reconnect ?? null,
    codexProviderRetry: getLiveCodexProviderRetryState(session),
    codexStreamRetry:
      deps.backendConnected(session) &&
      session.state.codex_stream_retry?.turnId === session.codexAdapter?.getCurrentTurnId()
        ? (session.state.codex_stream_retry ?? null)
        : null,
    codexTurnRecovery: session.state.codex_turn_recovery ?? null,
  };
}
