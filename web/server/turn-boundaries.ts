import type { BrowserIncomingMessage } from "./session-types.js";
import { isCodexLeaderRecoveryDiagnosticSourceId } from "../shared/injected-event-message.js";

export interface TurnBoundary {
  /** Index of the user_message that starts this turn. */
  startIdx: number;
  /** Index of the result message that ends this turn, or -1 if still in progress. */
  endIdx: number;
}

function isSyntheticStopTail(message: BrowserIncomingMessage): boolean {
  if (message.type !== "user_message") return false;
  if (!message.id?.startsWith("stop-")) return false;
  if (!message.agentSource?.sessionId) return false;
  return message.content.startsWith("Session stopped by leader #");
}

function isNonBoundaryRecoveryDiagnostic(message: BrowserIncomingMessage): boolean {
  return message.type === "user_message" && isCodexLeaderRecoveryDiagnosticSourceId(message.agentSource?.sessionId);
}

/** Bound navigation without inventing a completion result for an interrupted turn. */
export function turnNavigationEnd(messages: BrowserIncomingMessage[], turn: TurnBoundary): number {
  if (turn.endIdx >= 0) return turn.endIdx;
  for (let index = turn.startIdx + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.type !== "user_message") continue;
    if (!isSyntheticStopTail(message) && !isNonBoundaryRecoveryDiagnostic(message)) return index - 1;
  }
  return messages.length - 1;
}

/** Find user/result turn boundaries, optionally skipping rows outside a projection. */
export function findTurnBoundaries(
  messages: BrowserIncomingMessage[],
  includeMessage?: (message: BrowserIncomingMessage, historyIndex: number) => boolean,
): TurnBoundary[] {
  const turns: TurnBoundary[] = [];
  let currentStart = -1;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (includeMessage && !includeMessage(message, index)) continue;
    if (message.type === "user_message") {
      if (isSyntheticStopTail(message) || isNonBoundaryRecoveryDiagnostic(message)) continue;
      if (currentStart >= 0) turns.push({ startIdx: currentStart, endIdx: -1 });
      currentStart = index;
    } else if (message.type === "result" && currentStart >= 0) {
      turns.push({ startIdx: currentStart, endIdx: index });
      currentStart = -1;
    }
  }

  if (currentStart >= 0) turns.push({ startIdx: currentStart, endIdx: -1 });
  return turns;
}
