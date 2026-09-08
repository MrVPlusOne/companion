import type { ChatMessage } from "../types.js";

const INLINE_BOARD_FALLBACK_SUBCOMMANDS = new Set([
  "",
  "show",
  "display",
  "set",
  "add",
  "rm",
  "advance",
  "propose",
  "promote",
  "note",
]);

interface TakodeBoardCommandMatch {
  subcommand: string;
  canUseLiveBoardFallback: boolean;
}

/** Detect `takode board` commands while keeping non-table subcommands as plain terminal rows. */
export function parseTakodeBoardCommand(rawCommand: unknown): TakodeBoardCommandMatch | null {
  const command = stripLeadingEnvAssignments(String(rawCommand || ""));
  const commandMatcher = /(?:^|[\s;&|()])takode\s+board(?:\s+([^\s;&|()]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = commandMatcher.exec(command)) !== null) {
    const segmentStart = command.indexOf("takode", match.index);
    const segment = command.slice(segmentStart).split(/[;&|\n\r]/, 1)[0] ?? "";
    const rawSubcommand = (match[1] ?? "").toLowerCase();
    const isHelp = rawSubcommand === "help" || rawSubcommand === "--help" || /\s--help(?:\s|$)/.test(segment);
    const subcommand = rawSubcommand.startsWith("--") ? "" : rawSubcommand;
    if (isHelp) return { subcommand: "help", canUseLiveBoardFallback: false };
    return { subcommand, canUseLiveBoardFallback: INLINE_BOARD_FALLBACK_SUBCOMMANDS.has(subcommand) };
  }
  return null;
}

/** Strip leading shell-style env assignments from a Bash command preview. */
function stripLeadingEnvAssignments(command: string): string {
  let remaining = command.trimStart();
  const assignmentRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`]+)(?:\s+|$)/;

  for (;;) {
    const match = remaining.match(assignmentRe);
    if (!match) return remaining;
    remaining = remaining.slice(match[0].length).trimStart();
  }
}

/** Parse `takode notify <category>` commands, extracting the notification category. */
export function parseTakodeNotifyCommand(command: string): { category: "needs-input" | "review" } | null {
  const normalized = stripLeadingEnvAssignments(command);
  const match = normalized.match(/^takode\s+notify\s+(needs-input|review)(?=\s|$)/);
  if (!match) return null;
  return { category: match[1] as "needs-input" | "review" };
}

/** Board proposals carry their decision context in a rendered result, not assistant prose. */
export function isBoardProposalMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parentToolUseId == null &&
    !message.metadata?.codexSubagent &&
    (message.contentBlocks ?? []).some(
      (block) =>
        block.type === "tool_use" &&
        block.name === "Bash" &&
        parseTakodeBoardCommand(block.input.command)?.subcommand === "propose",
    )
  );
}

/** Match a root notify source whose retained receipt can carry its historical decision card. */
export function isNeedsInputNotifyMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.parentToolUseId == null &&
    !message.metadata?.codexSubagent &&
    (message.contentBlocks ?? []).some(
      (block) =>
        block.type === "tool_use" &&
        block.name === "Bash" &&
        parseTakodeNotifyCommand(String(block.input.command ?? ""))?.category === "needs-input",
    )
  );
}
