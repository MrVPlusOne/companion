/** Maximum UTF-8 bytes returned for one captured instruction source. */
export const MAX_INSTRUCTION_CONTENT_BYTES = 256 * 1024;

export interface CapturedInstructionContent {
  content: string | null;
  /** Why the captured body cannot be shown; never a filesystem error or raw config. */
  unavailableReason?: string;
}

export interface CodexInstructionContentRequest {
  threadId: string;
  capturedAt: number;
  /** "generated" or an index into the selected snapshot's ordered sources. */
  source: string;
}

export interface CodexInstructionContentResponse extends CodexInstructionContentRequest, CapturedInstructionContent {}
