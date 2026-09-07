import type { BrowserOutgoingMessage } from "./session-types.js";
import type { TurnStartFailureInfo } from "./bridge/adapter-interface.js";
import { isRecoverableCodexTurnStartError } from "./codex-adapter-utils.js";

interface ConfigWriter {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export async function configureCodexDeveloperInstructions(
  transport: ConfigWriter,
  instructions: string | undefined,
): Promise<void> {
  if (!instructions?.trim()) return;
  await transport.call("config/value/write", {
    keyPath: "developer_instructions",
    value: instructions,
    mergeStrategy: "replace",
  });
}

export function handleCodexTurnStartDispatchFailure(
  callback: ((msg: BrowserOutgoingMessage, info?: TurnStartFailureInfo) => void) | null,
  message: BrowserOutgoingMessage,
  error: unknown,
): boolean {
  if (!callback) return false;
  const recoverable = isRecoverableCodexTurnStartError(error);
  if (recoverable) callback(message);
  else callback(message, { recoverable, message: String(error) });
  return true;
}
