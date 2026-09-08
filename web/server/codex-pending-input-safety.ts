import type { PendingCodexInput } from "./session-types.js";
import { isCodexTurnRecoverySourceId } from "../shared/injected-event-message.js";

const DEFAULT_MAX_DELIVERY_BYTES = 1_048_576;
const DEFAULT_BROWSER_PREVIEW_BYTES = 16_384;
const MAX_DELIVERY_BYTES_ENV = "TAKODE_CODEX_PENDING_INPUT_MAX_DELIVERY_BYTES";
const BROWSER_PREVIEW_BYTES_ENV = "TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES";

export interface PendingCodexInputSizeLimit {
  maxBytes: number;
  actualBytes: number;
  overLimit: boolean;
}

export function getCodexPendingInputMaxDeliveryBytes(): number {
  return readPositiveIntegerEnv(MAX_DELIVERY_BYTES_ENV, DEFAULT_MAX_DELIVERY_BYTES);
}

export function getCodexPendingInputBrowserPreviewBytes(): number {
  return readPositiveIntegerEnv(BROWSER_PREVIEW_BYTES_ENV, DEFAULT_BROWSER_PREVIEW_BYTES);
}

export function measureCodexPendingInputDeliveryBytes(
  input: Pick<PendingCodexInput, "content" | "deliveryContent">,
): number {
  return Buffer.byteLength(input.deliveryContent ?? input.content, "utf8");
}

export function getCodexPendingInputSizeLimit(
  input: Pick<PendingCodexInput, "content" | "deliveryContent">,
): PendingCodexInputSizeLimit {
  const maxBytes = getCodexPendingInputMaxDeliveryBytes();
  const actualBytes = measureCodexPendingInputDeliveryBytes(input);
  return {
    maxBytes,
    actualBytes,
    overLimit: actualBytes > maxBytes,
  };
}

export function compactPendingCodexInputsForBrowser(inputs: PendingCodexInput[]): PendingCodexInput[] {
  const maxPreviewBytes = getCodexPendingInputBrowserPreviewBytes();
  return inputs.map((input) => compactPendingCodexInputForBrowser(input, maxPreviewBytes));
}

/** Browser cancellation payload: preserves composer restoration data but omits delivery and server policy fields. */
export function projectCancelledCodexInputForBrowser(input: PendingCodexInput): PendingCodexInput {
  const {
    deliveryContent: _deliveryContent,
    historyFollowUps: _historyFollowUps,
    timerFiring: _timerFiring,
    autoPauseRecoveries: _autoPauseRecoveries,
    leaderThreadOutcomeReminderGuard: _leaderThreadOutcomeReminderGuard,
    queueBeforeOwnerId: _queueBeforeOwnerId,
    requireFreshSuccessor: _requireFreshSuccessor,
    ...browserInput
  } = input;
  return browserInput;
}

/** Bounded origin-correlation metadata for pre-admission rejection; never includes image paths or bytes. */
export function compactRejectedCodexInputForBrowser(input: PendingCodexInput): PendingCodexInput {
  const compacted = compactPendingCodexInputsForBrowser([input])[0]!;
  return {
    id: compacted.id,
    ...(compacted.clientMsgId ? { clientMsgId: compacted.clientMsgId } : {}),
    content: compacted.content,
    ...(compacted.contentBytes ? { contentBytes: compacted.contentBytes } : {}),
    timestamp: compacted.timestamp,
    cancelable: false,
    ...(compacted.payloadTruncated ? { payloadTruncated: true } : {}),
    ...(compacted.threadKey ? { threadKey: compacted.threadKey } : {}),
    ...(compacted.questId ? { questId: compacted.questId } : {}),
    ...(compacted.threadRefs?.length ? { threadRefs: compacted.threadRefs } : {}),
    ...(compacted.slackThreadId ? { slackThreadId: compacted.slackThreadId } : {}),
  };
}

function compactPendingCodexInputForBrowser(input: PendingCodexInput, maxPreviewBytes: number): PendingCodexInput {
  const {
    historyFollowUps: _historyFollowUps,
    timerFiring: _timerFiring,
    autoPauseRecoveries: _autoPauseRecoveries,
    leaderThreadOutcomeReminderGuard: _leaderThreadOutcomeReminderGuard,
    draftImages: _draftImages,
    queueBeforeOwnerId: _queueBeforeOwnerId,
    requireFreshSuccessor: _requireFreshSuccessor,
    ...browserInput
  } = input;
  const recoveryInput = isCodexTurnRecoverySourceId(input.agentSource?.sessionId);
  if (recoveryInput) delete browserInput.deliveryContent;
  const content = compactText(input.content, maxPreviewBytes);
  const deliveryContent =
    !recoveryInput && typeof input.deliveryContent === "string"
      ? compactText(input.deliveryContent, maxPreviewBytes)
      : undefined;
  if (!content.truncated && (!deliveryContent || !deliveryContent.truncated)) return browserInput;
  return {
    ...browserInput,
    content: content.text,
    ...(deliveryContent ? { deliveryContent: deliveryContent.text } : {}),
    contentBytes: content.bytes,
    ...(deliveryContent ? { deliveryContentBytes: deliveryContent.bytes } : {}),
    payloadTruncated: true,
  };
}

function compactText(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  const suffix = `\n\n[Truncated for browser sync: ${bytes} bytes total]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const budget = Math.max(0, maxBytes - suffixBytes);
  return {
    text: truncateUtf8(text, budget) + suffix,
    bytes,
    truncated: true,
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  return buffer
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
