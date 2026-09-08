import type { BackendReconnectProgress, CodexProviderRetryState } from "./codex-outbound-turn-types.js";

/** Server-owned backend lifecycle and transient recovery presentation. */
export interface BackendSessionState {
  /** Server-authored backend lifecycle state. */
  backend_state?:
    | "initializing"
    | "resuming"
    | "recovering"
    | "connected"
    | "disconnected"
    | "recovery_suppressed"
    | "broken";
  /** Server-authored backend failure detail for disconnected/broken states. */
  backend_error?: string | null;
  /** Server-authored Codex process reconnect progress. */
  backend_reconnect?: BackendReconnectProgress | null;
  /** Server-authored same-turn provider retry progress, separate from process reconnects. */
  codex_provider_retry?: CodexProviderRetryState | null;
  /** Codex-reported internal retry for the current root turn; never restored from disk. */
  codex_stream_retry?: { turnId: string } | null;
}
