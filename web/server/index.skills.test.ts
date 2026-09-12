import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(SERVER_DIR, "index.ts");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const QUEST_JOURNEY_SKILL_SLUGS = [
  "quest-journey-alignment",
  "quest-journey-explore",
  "quest-journey-implement",
  "quest-journey-code-review",
  "quest-journey-mental-simulation",
  "quest-journey-execute",
  "quest-journey-outcome-review",
  "quest-journey-user-checkpoint",
  "quest-journey-bookkeeping",
  "quest-journey-port",
  "quest-journey-planning",
  "quest-journey-implementation",
  "quest-journey-skeptic-review",
  "quest-journey-reviewer-groom",
  "quest-journey-porting",
];

describe("index startup skill registration", () => {
  it("registers canonical startup skills without stale hardcoded slugs", async () => {
    // If a nonexistent project skill is reintroduced here, startup will recreate
    // warning spam and potentially broken symlink state. Guard the actual
    // STARTUP_SKILL_SYMLINKS registration list in index.ts directly.
    const source = await readFile(INDEX_PATH, "utf-8");
    const match = source.match(/STARTUP_SKILL_SYMLINKS = \[([\s\S]*?)\];/);
    expect(match).toBeTruthy();

    const registered = [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);

    expect(registered).not.toContain("cron-scheduling");
    expect(registered).toContain("takode-orchestration");
    expect(registered).toContain("leader-dispatch");
    expect(registered).toContain("leader-decision-communication");
    expect(registered).toContain("confirm");
    expect(registered).not.toContain("quest-journey-planning");
    expect(registered).not.toContain("quest-journey-explore");
    expect(registered).not.toContain("quest-journey-implement");
    expect(registered).not.toContain("quest-journey-code-review");
    expect(registered).not.toContain("quest-journey-mental-simulation");
    expect(registered).not.toContain("quest-journey-execute");
    expect(registered).not.toContain("quest-journey-outcome-review");
    expect(registered).not.toContain("quest-journey-user-checkpoint");
    expect(registered).not.toContain("quest-journey-bookkeeping");
    expect(registered).not.toContain("quest-journey-port");
    expect(registered).not.toContain("quest-journey-implementation");
    expect(registered).not.toContain("quest-journey-skeptic-review");
    expect(registered).not.toContain("quest-journey-reviewer-groom");
    expect(registered).not.toContain("quest-journey-porting");
    expect(registered).toContain("self-groom");
    expect(registered).toContain("reviewer-groom");
    expect(registered).toContain("skeptic-review");
    expect(registered).toContain("worktree-rules");
    expect(registered).not.toContain("playwright-e2e-tester");
  });

  it("does not keep Quest Journey phase skills as repo skill sources or documented installed skills", async () => {
    const docs = await Promise.all([
      readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8"),
      readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8"),
    ]);

    for (const slug of QUEST_JOURNEY_SKILL_SLUGS) {
      await expect(access(join(REPO_ROOT, ".claude", "skills", slug, "SKILL.md"))).rejects.toThrow();
      for (const doc of docs) {
        expect(doc).not.toContain(slug);
      }
    }

    for (const doc of docs) {
      expect(doc).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    }
  });

  it.each([
    "takode-orchestration-design",
    "leader-decision-communication",
  ])("keeps %s discoverable from its canonical source", async (slug) => {
    // Preserve identity, discoverability, and source ownership without copying
    // the design/communication policy or its examples into assertions.
    const relativeRoot = `.claude/skills/${slug}`;
    const skill = await readFile(join(REPO_ROOT, relativeRoot, "SKILL.md"), "utf-8");
    expect(skill).toMatch(new RegExp(`^name: ${slug}$`, "m"));
    for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
      expect(await readFile(join(REPO_ROOT, filename), "utf-8")).toContain(`${relativeRoot}/`);
    }
    for (const directory of [".agents", ".codex"]) {
      await expect(access(join(REPO_ROOT, directory, "skills", slug, "SKILL.md"))).rejects.toThrow();
    }
  });

  it("documents executable full-gate commands using the no-install package runner", async () => {
    // Omitting `run` selects Bun's built-in test runner instead of this repo's
    // Vitest script; omitting --no-install permits unintended dependency setup.
    for (const filename of ["CLAUDE.md", "AGENTS.md", "web/server/templates/quest-skill-docs.md"]) {
      const source = await readFile(join(REPO_ROOT, filename), "utf-8");
      for (const script of ["typecheck", "test", "format:check"]) {
        expect(source).toContain(`bun --no-install run ${script}`);
      }
    }
  });
});
