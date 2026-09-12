import {
  CODEX_LEADER_RECOVERY_DIAGNOSTIC_SOURCE_ID,
  CODEX_LEADER_RECOVERY_DIAGNOSTIC_SOURCE_LABEL,
  CODEX_TURN_RECOVERY_SOURCE_LABEL,
  codexTurnRecoverySourceId,
} from "../../../shared/injected-event-message.js";
import type { ChatMessage } from "../../types.js";
import { makePlaygroundMessage } from "./fixtures.js";

export const PLAYGROUND_RECOVERY_MODEL_DELIVERY_CONTENT = [
  "[System 11:04 AM] [thread:q-9010] Takode could not confirm that the previous turn completed its response.",
  "",
  "This is a separately owned verification-first continuation. The original user payload was not replayed; available history or outcome evidence is incomplete.",
  "",
  "Takode has evidence that the original input was recorded. An incomplete recovery view does not establish that your model context was lost.",
  "",
  "Continue from the request and partial work already in your context. Only if a necessary detail is missing, use `takode read 901 42 --limit 40` or `takode peek 901 --turn-containing 42 --count 20`.",
  "",
  "Takode history and these commands expose only Takode's persisted observations; they may be incomplete and do not prove all Codex-internal progress, partial tool execution, or external effects.",
  "",
  "Tool or external effects may already have occurred. Before repeating an action whose outcome is uncertain, verify that operation's current state. Do not repeat already-completed work.",
  "",
  "Continue only the missing work within the original authorization and thread route. If safe continuation remains unclear, report the unfinished/action-required state instead of guessing or claiming completion.",
].join("\n");

export function buildPlaygroundActionRequiredRecoveryMessages(recoveryId: string): ChatMessage[] {
  return [
    makePlaygroundMessage({
      id: "playground-interrupted-owner",
      role: "user",
      content: "Finish the interrupted leader work without repeating completed side effects.",
      timestamp: Date.now() - 8_000,
    }),
    makePlaygroundMessage({
      id: "playground-continuation-action-required",
      role: "user",
      content: "Takode is resuming this interrupted work without repeating actions that already completed.",
      modelDeliveryContent: PLAYGROUND_RECOVERY_MODEL_DELIVERY_CONTENT,
      timestamp: Date.now() - 6_000,
      agentSource: {
        sessionId: codexTurnRecoverySourceId(recoveryId),
        sessionLabel: CODEX_TURN_RECOVERY_SOURCE_LABEL,
      },
    }),
    makePlaygroundMessage({
      id: "playground-continuation-partial",
      role: "assistant",
      content: "I verified the already-completed side effects, but the continuation stopped before its final answer.",
      timestamp: Date.now() - 4_000,
    }),
    makePlaygroundMessage({
      id: "playground-codex-recovery-diagnostic-msg",
      role: "user",
      content: [
        "Takode stopped after the partial response above.",
        "Some model or tool activity had already happened, so retrying automatically could repeat actions.",
        "Takode retained this recovery note for audit. Send a new instruction in this thread only if the intended outcome is still missing; otherwise no action is required.",
      ].join("\n"),
      timestamp: Date.now() - 2_000,
      agentSource: {
        sessionId: CODEX_LEADER_RECOVERY_DIAGNOSTIC_SOURCE_ID,
        sessionLabel: CODEX_LEADER_RECOVERY_DIAGNOSTIC_SOURCE_LABEL,
      },
    }),
  ];
}
