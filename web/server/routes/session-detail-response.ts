import {
  buildCodexPendingDeliveryDiagnostics,
  type CodexPendingDeliveryDiagnostics,
  type CodexPendingDeliveryDiagnosticsDetails,
} from "../codex-pending-delivery-diagnostics.js";
import type { SdkSessionInfo } from "../session-info.js";
import { stripInternalLauncherSessionState } from "../session-info.js";
import type { SessionState } from "../session-types.js";
import { projectSessionLifecycleEvents } from "../session-lifecycle-projection.js";

type PendingDeliverySession = Parameters<typeof buildCodexPendingDeliveryDiagnostics>[0];

export function buildBrowserSessionDetail(
  session: SdkSessionInfo,
  bridgeState: SessionState | undefined,
  options: {
    includeCodexContextWindowDiagnostics: boolean;
    includeCodexInstructionSnapshot: boolean;
    isGenerating: boolean;
  },
): Record<string, unknown> {
  const rest = stripInternalLauncherSessionState(session, {
    includeCodexContextWindowDiagnostics: options.includeCodexContextWindowDiagnostics,
    includeCodexInstructionSnapshot: options.includeCodexInstructionSnapshot,
  });
  return {
    ...rest,
    ...(options.includeCodexContextWindowDiagnostics
      ? {
          codexContextWindowDiagnostics:
            bridgeState?.codex_context_window_diagnostics ?? rest.codexContextWindowDiagnostics,
        }
      : {}),
    treeGroupId: bridgeState?.treeGroupId ?? rest.treeGroupId ?? null,
    memorySessionSpaceSlug: bridgeState?.memorySessionSpaceSlug ?? rest.memorySessionSpaceSlug ?? null,
    gitBranch: bridgeState?.git_branch ?? null,
    gitDefaultBranch: bridgeState?.git_default_branch ?? null,
    diffBaseBranch: bridgeState?.diff_base_branch ?? null,
    isWorktree: rest.isWorktree ?? bridgeState?.is_worktree ?? false,
    repoRoot: rest.repoRoot ?? bridgeState?.repo_root ?? null,
    branch: rest.branch ?? (bridgeState?.is_worktree ? bridgeState.git_branch : undefined),
    actualBranch: rest.actualBranch ?? (bridgeState?.is_worktree ? bridgeState.git_branch : undefined),
    pause: bridgeState?.pause ?? null,
    pausedInputQueueCount: bridgeState?.pause?.queuedMessages.length ?? 0,
    codexResultErrorAutoPause: bridgeState?.codex_result_error_auto_pause ?? null,
    codexEffectiveReasoningEffort: bridgeState?.codex_effective_reasoning_effort ?? null,
    codexEffectiveReasoningEffortReported: bridgeState?.codex_effective_reasoning_effort_reported === true,
    codexAutoPausedInputCount:
      bridgeState?.codex_result_error_auto_pause?.heldInputs.reduce(
        (total, item) => total + Math.max(1, item.count),
        0,
      ) ?? 0,
    sessionLifecycleEvents: projectSessionLifecycleEvents(bridgeState?.lifecycle_events, {
      includeContextWindowDiagnostics: options.includeCodexContextWindowDiagnostics,
    }),
    isGenerating: options.isGenerating,
  };
}

export function buildTakodeInfoSafeSession(
  session: SdkSessionInfo,
  bridgeState: SessionState | undefined,
): Record<string, unknown> {
  const safeSession = stripInternalLauncherSessionState(session, {
    includeInjectedSystemPrompt: true,
    includeCodexContextWindowDiagnostics: true,
  });
  return {
    ...safeSession,
    codexContextWindowDiagnostics:
      bridgeState?.codex_context_window_diagnostics ?? safeSession.codexContextWindowDiagnostics ?? null,
  };
}

export function buildTakodeCodexPendingDeliveryFields(session: PendingDeliverySession | null | undefined): {
  codexPendingDelivery: CodexPendingDeliveryDiagnostics | null;
  codexPendingDeliveryDetails: CodexPendingDeliveryDiagnosticsDetails | null;
} {
  if (session?.backendType !== "codex") {
    return { codexPendingDelivery: null, codexPendingDeliveryDetails: null };
  }
  return {
    codexPendingDelivery: buildCodexPendingDeliveryDiagnostics(session),
    codexPendingDeliveryDetails: buildCodexPendingDeliveryDiagnostics(session, { details: true }),
  };
}
