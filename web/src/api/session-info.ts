import type { SdkSessionInfo } from "../types.js";
import type {
  CodexInstructionContentRequest,
  CodexInstructionContentResponse,
} from "../../shared/codex-instruction-content.js";

const BASE = "/api";

async function getSessionInfoResponse(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

export async function listSessions(options?: { includeArchived?: boolean }): Promise<SdkSessionInfo[]> {
  const params = new URLSearchParams();
  if (typeof options?.includeArchived === "boolean") {
    params.set("includeArchived", options.includeArchived ? "true" : "false");
  }
  const query = params.toString();
  return getSessionInfoResponse(`/sessions${query ? `?${query}` : ""}`) as Promise<SdkSessionInfo[]>;
}

export function getSessionInfo(sessionId: string): Promise<SdkSessionInfo> {
  return getSessionInfoResponse(
    `/sessions/${encodeURIComponent(sessionId)}?includeCodexContextWindowDiagnostics=true&includeCodexInstructionSnapshot=true`,
  ) as Promise<SdkSessionInfo>;
}

export function getSessionInstructionContent(
  sessionId: string,
  selection: CodexInstructionContentRequest,
): Promise<CodexInstructionContentResponse> {
  const query = new URLSearchParams({ ...selection, capturedAt: String(selection.capturedAt) });
  return getSessionInfoResponse(
    `/sessions/${encodeURIComponent(sessionId)}/instruction-content?${query}`,
  ) as Promise<CodexInstructionContentResponse>;
}
