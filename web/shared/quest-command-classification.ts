const READ_ONLY_COMMANDS = new Set(["list", "mine", "grep", "show", "status", "history", "tags", "commit-links"]);
const STDIN_FILE_FLAGS = new Set([
  "--title-file",
  "--desc-file",
  "--tldr-file",
  "--items-file",
  "--debrief-file",
  "--debrief-tldr-file",
  "--notes-file",
  "--text-file",
  "--summary-file",
]);
const VALUE_FLAGS = new Set([
  "--author",
  "--commit",
  "--commits",
  "--delivery",
  "--count",
  "--debrief",
  "--debrief-file",
  "--debrief-tldr",
  "--debrief-tldr-file",
  "--desc",
  "--desc-file",
  "--follow-up-of",
  "--image",
  "--images",
  "--items",
  "--items-file",
  "--journey-run",
  "--kind",
  "--last",
  "--max-dim",
  "--memory-commit",
  "--memory-commits",
  "--notes",
  "--notes-file",
  "--phase",
  "--phase-occurrence",
  "--phase-occurrence-id",
  "--phase-position",
  "--reason",
  "--sections",
  "--session",
  "--session-space",
  "--status",
  "--summary",
  "--summary-file",
  "--base",
  "--message",
  "--history-index",
  "--advance-through",
  "--tag",
  "--tags",
  "--text",
  "--text-file",
  "--title",
  "--title-file",
  "--tldr",
  "--tldr-file",
  "--verification",
]);

export type QuestCommandClassification = {
  kind: "read" | "mutation" | "reassign" | "unknown";
  questId?: string;
  flatFeedbackAdd?: boolean;
};

/** Classify command authority and target without depending on a CLI process. */
export function classifyQuestCommand(args: readonly string[]): QuestCommandClassification {
  const command = args[0];
  if (!command || READ_ONLY_COMMANDS.has(command)) return { kind: "read" };
  if (command === "feedback") return classifyFeedbackCommand(args);
  if (command === "outcome") {
    const positionals = questCommandPositionals(args);
    return positionals[0] === "show" ? { kind: "read" } : { kind: "unknown" };
  }
  if (command === "quiz") {
    const positionals = questCommandPositionals(args);
    if (positionals[0] === "show") return { kind: "read" };
    if (positionals[0] !== "set" && positionals[0] !== "clear") return { kind: "unknown" };
    const questId = normalizedQuestId(positionals[1]);
    return { kind: "mutation", ...(questId ? { questId } : {}) };
  }
  if (["help", "--help", "-h", "resize-image", "optimize-image"].includes(command)) return { kind: "read" };
  if (command === "reassign") {
    const questId = normalizedQuestId(questCommandPositionals(args)[0]);
    return { kind: "reassign", ...(questId ? { questId } : {}) };
  }
  const mutation = [
    "create",
    "claim",
    "complete",
    "done",
    "cancel",
    "transition",
    "later",
    "inbox",
    "edit",
    "check",
    "address",
    "delete",
  ].includes(command);
  if (!mutation) return { kind: "unknown" };
  const questId = command === "create" ? undefined : normalizedQuestId(questCommandPositionals(args)[0]);
  return { kind: "mutation", ...(questId ? { questId } : {}) };
}

/** Return whether argv describes a Quest record mutation. */
export function isQuestMutationCommand(args: readonly string[]): boolean {
  return classifyQuestCommand(args).kind !== "read";
}

/** Return whether argv explicitly consumes stdin through a rich-text file flag. */
export function questCommandReadsStdin(args: readonly string[]): boolean {
  return args.some((arg, index) => STDIN_FILE_FLAGS.has(arg) && args[index + 1] === "-");
}

/** Parse positional argv using the Quest CLI's known valued and boolean flags. */
export function questCommandPositionals(args: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg) && args[index + 1] !== undefined && !args[index + 1]!.startsWith("--")) index += 1;
  }
  return positionals;
}

function classifyFeedbackCommand(args: readonly string[]): QuestCommandClassification {
  const positionals = questCommandPositionals(args);
  const subcommand = positionals[0] ?? "";
  if (["list", "latest", "show"].includes(subcommand)) return { kind: "read" };
  const explicitAdd = subcommand === "add";
  const explicitEdit = subcommand === "edit";
  const shorthandQuestId = normalizedQuestId(subcommand);
  if (!explicitAdd && !explicitEdit && !shorthandQuestId) return { kind: "unknown" };
  const questId = shorthandQuestId ?? normalizedQuestId(positionals[1]);
  const addCommand = explicitAdd || !!shorthandQuestId;
  return {
    kind: "mutation",
    ...(questId ? { questId } : {}),
    ...(addCommand && !hasPhaseScopeFlag(args) ? { flatFeedbackAdd: true } : {}),
  };
}

function normalizedQuestId(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase();
  return value && /^q-\d+$/.test(value) ? value : undefined;
}

function hasPhaseScopeFlag(args: readonly string[]): boolean {
  return args.some((arg) =>
    [
      "--phase",
      "--phase-position",
      "--phase-occurrence",
      "--phase-occurrence-id",
      "--journey-run",
      "--infer-phase",
    ].includes(arg),
  );
}
