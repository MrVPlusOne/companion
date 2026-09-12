import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const docs = readFileSync(fileURLToPath(new URL("./templates/quest-skill-docs.md", import.meta.url)), "utf8");

describe("quest skill command and link syntax", () => {
  it.each([
    ["claim", ["--session", "--force", "--reason"]],
    ["reassign", ["--session", "--reason"]],
    ["complete", ["--memory-commit", "--memory-commits", "--debrief-file", "--debrief-tldr-file"]],
    ["show", ["--sections", "--full", "--json"]],
    ["list", ["--verification"]],
    ["feedback", ["--text-file", "--tldr-file", "--phase"]],
    ["grep", ["--count", "--json"]],
  ] as const)("documents the parser's %s command flags", (command, requiredFlags) => {
    // These tokens are consumed by the CLI. Check the command's own synopsis,
    // with flexible whitespace, rather than matching surrounding explanations.
    const synopsis = docs.match(new RegExp(`^quest ${command}\\s+[^\\n]+`, "m"))?.[0] ?? "";
    const flags = synopsis.match(/--[\w-]+/g) ?? [];
    expect(flags).toEqual(expect.arrayContaining([...requiredFlags]));
  });

  it("documents the read-only legacy outcome command without removed mutation verbs", () => {
    // Copying a retired mutation verb would invoke an unsupported CLI operation.
    expect(docs).toMatch(/quest outcome show\s+<id>/);
    expect(docs).not.toMatch(/quest outcome (?:set|use)\b/);
  });

  it("uses canonical feedback URI syntax in the copyable example", () => {
    // The URI grammar is interpreted by Takode navigation. Example IDs and the
    // surrounding prose can change without weakening this protocol check.
    expect(docs).toMatch(/\[q-\d+ feedback #\d+\]\(quest:q-\d+:feedback:\d+\)/);
    expect(docs).not.toMatch(/quest:q-\d+#feedback-/);
  });
});
