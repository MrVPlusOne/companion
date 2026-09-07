import type { CodexInstructionSnapshot } from "./codex-adapter-types.js";
import type { SdkSessionInfo } from "./session-info.js";
import type { CodexLeaderRecycleLineage } from "./session-types.js";

export function appendUniqueCliSessionId(
  lineage: CodexLeaderRecycleLineage | undefined,
  cliSessionId: string,
): CodexLeaderRecycleLineage {
  const current = lineage ?? { cliSessionIds: [], recycleEvents: [] };
  if (!cliSessionId || current.cliSessionIds.includes(cliSessionId)) return current;
  return { ...current, cliSessionIds: [...current.cliSessionIds, cliSessionId] };
}

export function applyCodexSessionIdentity(
  session: SdkSessionInfo,
  cliSessionId: string,
  instructionSnapshot?: CodexInstructionSnapshot,
): void {
  session.cliSessionId = cliSessionId;
  if (instructionSnapshot) session.codexInstructionSnapshot = instructionSnapshot;
  session.codexLeaderRecycleLineage = appendUniqueCliSessionId(session.codexLeaderRecycleLineage, cliSessionId);
  const pendingRecycle = session.codexLeaderRecyclePending;
  const recycleEvent = pendingRecycle
    ? session.codexLeaderRecycleLineage.recycleEvents[pendingRecycle.eventIndex]
    : undefined;
  if (recycleEvent && !recycleEvent.nextCliSessionId) recycleEvent.nextCliSessionId = cliSessionId;
}
