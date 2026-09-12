import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("copyable Work-to-Memory commands", () => {
  it.each([
    ".claude/skills/takode-orchestration/quest-journey.md",
    ".claude/skills/takode-orchestration/board-usage.md",
    ".claude/skills/worktree-rules/SKILL.md",
    ".claude/skills/worktree-rules/references/port-tracking.md",
    "web/server/templates/quest-memory-completion.md",
  ])("includes the required transition flags and compatible evidence modes in %s", (path) => {
    // These are executable command examples, not prose keywords: omitting the
    // Work note or supplying conflicting evidence modes makes the command fail.
    const source = readFileSync(resolve(ROOT, path), "utf8");
    const commands = source.match(/^takode board work-to-memory [^\n]+/gm) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const flags: string[] = command.match(/--[\w-]+/g) ?? [];
      expect(flags).toContain("--work-note");
      expect(flags.filter((flag) => ["--commit", "--commits", "--no-code"].includes(flag))).toHaveLength(1);
      expect(flags.includes("--preparation") && flags.includes("--delivery-target")).toBe(false);
    }
  });
});
