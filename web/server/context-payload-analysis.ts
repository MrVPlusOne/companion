import type { BrowserIncomingMessage, ContextUsageHistoryEntry, ToolResultPreview } from "./session-types.js";
import { turnNavigationEnd, type TurnBoundary } from "./turn-boundaries.js";

export interface ContextToolSource {
  name: string;
  inputBytes: number;
  commandFamily?: string;
  commandSummary?: string;
}

export interface ContextCommandBreakdown {
  calls: number;
  inputBytes: number;
  resultBytes: number;
  hiddenResultBytes: number;
}

export interface ContextTopCommand {
  family: string;
  bytes: number;
  calls: number;
}

export interface ContextTurnSummary {
  reportedUsage?: ReportedContextUsage | null;
  messageBytes: number;
  toolResultBytes: number;
  hiddenToolResultBytes: number;
  totalObservableBytes: number;
  topCommands?: ContextTopCommand[];
}

export type ReportedContextUsage = Pick<
  ContextUsageHistoryEntry,
  | "timestamp"
  | "source"
  | "contextUsedPercent"
  | "contextTokensUsed"
  | "displayContextTokensUsed"
  | "providerReportedTotalTokens"
  | "modelContextWindow"
  | "leaderRecycleThresholdTokens"
>;

export function contextByteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf-8");
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf-8");
}

export function contextUsageAtTimestamp(
  history: ContextUsageHistoryEntry[] | undefined,
  timestamp: number,
): ReportedContextUsage | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  let best: ContextUsageHistoryEntry | null = null;
  for (const sample of history) {
    if (!Number.isFinite(sample.timestamp) || sample.timestamp > timestamp) continue;
    if (!best || sample.timestamp > best.timestamp) best = sample;
  }
  if (!best) return null;

  return {
    timestamp: best.timestamp,
    source: best.source,
    ...(typeof best.contextUsedPercent === "number" ? { contextUsedPercent: best.contextUsedPercent } : {}),
    ...(typeof best.contextTokensUsed === "number" ? { contextTokensUsed: best.contextTokensUsed } : {}),
    ...(typeof best.displayContextTokensUsed === "number"
      ? { displayContextTokensUsed: best.displayContextTokensUsed }
      : {}),
    ...(typeof best.providerReportedTotalTokens === "number"
      ? { providerReportedTotalTokens: best.providerReportedTotalTokens }
      : {}),
    ...(typeof best.modelContextWindow === "number" ? { modelContextWindow: best.modelContextWindow } : {}),
    ...(typeof best.leaderRecycleThresholdTokens === "number"
      ? { leaderRecycleThresholdTokens: best.leaderRecycleThresholdTokens }
      : {}),
  };
}

function truncateInline(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}

function bashCommandText(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command.trim() : "";
}

function firstBashCommandLine(command: string): string {
  return (
    command
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ?? command.trim()
  );
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && !quote) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      current += ch;
      continue;
    }
    if (!quote && (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && next === "&"))) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) i++;
      continue;
    }
    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function normalizeExecutable(token: string): string {
  const base = token.split("/").pop() || token;
  return base.replace(/^\.\//, "");
}

function commandTokensForSegment(segment: string): string[] {
  const tokens = tokenizeShellSegment(segment);
  while (tokens.length > 0 && isAssignmentToken(tokens[0]!)) tokens.shift();
  while (["command", "time", "sudo"].includes(tokens[0] ?? "")) tokens.shift();
  if (tokens[0] === "env") {
    tokens.shift();
    while (tokens.length > 0 && (tokens[0]!.startsWith("-") || isAssignmentToken(tokens[0]!))) tokens.shift();
  }
  return tokens;
}

function classifyCommandTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const executable = normalizeExecutable(tokens[0]!);
  const subcommand = tokens[1] ?? "";

  if (executable === "cd" || executable === "export" || executable === "source" || executable === ".") return null;
  if (executable === "quest") {
    if (subcommand === "show") return "quest show";
    if (subcommand === "feedback") return "quest feedback";
    if (["list", "status", "grep", "history", "tags", "quiz", "inbox", "mine"].includes(subcommand)) {
      return "quest inspect";
    }
    return "quest other";
  }
  if (executable === "takode") {
    if (subcommand === "scan") return "takode scan";
    if (subcommand === "peek") return "takode peek";
    if (subcommand === "read") return "takode read";
    if (["info", "board", "notify", "worker-stream", "grep", "logs"].includes(subcommand)) return "takode inspect";
    return "takode";
  }
  if (executable === "memory") return "memory";
  if (executable === "rg") return "search";
  if (["grep", "awk", "sed"].includes(executable)) return "text processing";
  if (["cat", "nl", "head", "tail", "less"].includes(executable)) return "file read";
  if (executable === "git") return "git";
  if (["bun", "npm", "pnpm", "yarn", "make"].includes(executable)) return "build/test";
  if (["ls", "find", "du", "wc"].includes(executable)) return "filesystem inspect";
  if (["node", "python", "python3", "tsx", "ts-node"].includes(executable)) return "script";
  return executable || "bash";
}

export function classifyBashCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized) return "bash";
  const segments = splitShellSegments(firstBashCommandLine(normalized));
  for (const segment of segments) {
    const family = classifyCommandTokens(commandTokensForSegment(segment));
    if (family) return family;
  }
  return "bash";
}

export function summarizeToolContext(name: string, input: Record<string, unknown>): ContextToolSource {
  const inputBytes = contextByteLength(input ?? {});
  if (name !== "Bash") return { name, inputBytes };

  const command = bashCommandText(input);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  return {
    name,
    inputBytes,
    commandFamily: classifyBashCommand(command || description),
    commandSummary: truncateInline(description || firstBashCommandLine(command), 120),
  };
}

export function collectToolContextSources(messages: BrowserIncomingMessage[]): Map<string, ContextToolSource> {
  const result = new Map<string, ContextToolSource>();
  for (const message of messages) {
    if (message.type !== "assistant" || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      result.set(block.id, summarizeToolContext(block.name, block.input ?? {}));
    }
  }
  return result;
}

export function toolPreviewSize(preview: ToolResultPreview): {
  previewBytes: number;
  totalBytes: number;
  hiddenBytes: number;
} {
  const previewBytes = contextByteLength(preview.content);
  const totalBytes = Math.max(preview.total_size, previewBytes);
  return { previewBytes, totalBytes, hiddenBytes: Math.max(0, totalBytes - previewBytes) };
}

export function computeContextTurnSummary(
  messages: BrowserIncomingMessage[],
  turn: TurnBoundary,
  toolSources = collectToolContextSources(messages),
): ContextTurnSummary {
  const endBound = turnNavigationEnd(messages, turn);
  const byCommand = new Map<string, ContextTopCommand>();
  let messageBytes = 0;
  let toolResultBytes = 0;
  let hiddenToolResultBytes = 0;

  for (let i = turn.startIdx; i <= endBound; i++) {
    const message = messages[i];
    if (!message) continue;
    messageBytes += contextByteLength(message);
    if (message.type !== "tool_result_preview") continue;
    for (const preview of message.previews) {
      const sizes = toolPreviewSize(preview);
      toolResultBytes += sizes.totalBytes;
      hiddenToolResultBytes += sizes.hiddenBytes;
      const source = toolSources.get(preview.tool_use_id);
      const family = source?.commandFamily ?? source?.name ?? "unknown";
      const current = byCommand.get(family) ?? { family, bytes: 0, calls: 0 };
      current.bytes += source?.inputBytes ?? 0;
      current.bytes += sizes.totalBytes;
      current.calls += 1;
      byCommand.set(family, current);
    }
  }

  const topCommands = [...byCommand.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  return {
    messageBytes,
    toolResultBytes,
    hiddenToolResultBytes,
    totalObservableBytes: messageBytes + hiddenToolResultBytes,
    ...(topCommands.length > 0 ? { topCommands } : {}),
  };
}
