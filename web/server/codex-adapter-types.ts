import type { RecorderManager } from "./recorder.js";
import type { CodexResumeSnapshot } from "./codex-adapter-utils.js";

export type CodexInstructionSourceKind = "global" | "project" | "unknown";

export interface CodexInstructionSourceSnapshot {
  /** Environment-native path Codex reported as loaded. */
  path: string;
  kind: CodexInstructionSourceKind;
  /** Original user-global source copied into the isolated session home. */
  sourcePath?: string;
  delivery?: "copied_snapshot" | "direct";
}

export interface CodexConfigLayerSourceSnapshot {
  kind: "user" | "project" | "system" | "session_flags" | "managed" | "legacy_managed" | "unknown";
  path?: string;
  label?: string;
  profile?: string;
}

export interface CodexInstructionSnapshot {
  threadId: string;
  capturedAt: number;
  lifecycle: "thread_start" | "thread_resume";
  instructionSourcesReported: boolean;
  instructionSources: CodexInstructionSourceSnapshot[];
  configLayers: CodexConfigLayerSourceSnapshot[];
  developerInstructionsConfigured: boolean;
}

export interface CodexAdapterOptions {
  model?: string;
  cwd?: string;
  approvalMode?: string;
  askPermission?: boolean;
  uiMode?: "plan" | "agent";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  reasoningEffort?: string;
  /** Per-turn Codex app-server reasoning summary mode. Undefined preserves app-server defaults. */
  reasoningSummary?: "auto" | "concise" | "detailed";
  /** Codex app-server service tier for future turns. null/undefined means Standard. */
  serviceTier?: string | null;
  /** If provided, resume an existing thread instead of starting a new one. */
  threadId?: string;
  /** If provided, initialization must resume this exact thread and must not fall back to a fresh thread. */
  requireResumeThreadId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
  /** Companion instructions injected via session-scoped Codex config before thread start/resume. */
  instructions?: string;
  /** Safe launcher-known provenance used to classify Codex-reported instruction sources. */
  instructionContext?: import("./codex-instruction-snapshot.js").CodexInstructionContext;
  /** Optional stderr/context captured by the launcher for early startup failures. */
  failureContextProvider?: () => string | null;
}

export interface CodexSessionMeta {
  cliSessionId?: string;
  model?: string;
  cwd?: string;
  resumeSnapshot?: CodexResumeSnapshot | null;
  instructionSnapshot?: CodexInstructionSnapshot;
}
