import { access, mkdtemp, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSkillSymlinks } from "./skill-symlink.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SKILL_ROOT = join(REPO_ROOT, ".claude", "skills", "explain-clearly");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explain-clearly project skill", () => {
  it("exposes the skill identity and invocation through discoverable metadata", async () => {
    // Names, invocation tokens, and source paths are discovery contracts. The
    // description and explanatory prose may be freely reworded.
    const skill = await readFile(join(SKILL_ROOT, "SKILL.md"), "utf-8");
    const metadata = await readFile(join(SKILL_ROOT, "agents", "openai.yaml"), "utf-8");
    expect(skill).toMatch(/^name: explain-clearly$/m);
    expect(metadata).toContain("$explain-clearly");
    for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
      expect(await readFile(join(REPO_ROOT, filename), "utf-8")).toContain(".claude/skills/explain-clearly/");
    }
  });

  it("distributes one canonical Claude source to both supported skill homes", async () => {
    // Takode deliberately falls back from the repo's Claude source for non-Claude
    // agents. This temp-only integration check prevents an unnecessary divergent
    // .agents or legacy .codex copy from becoming the canonical implementation.
    const root = await mkdtemp(join(tmpdir(), "takode-explain-clearly-"));
    tempRoots.push(root);
    const claudeSkillsHome = join(root, "home", ".claude", "skills");
    const agentsSkillsHome = join(root, "home", ".agents", "skills");
    const legacyCodexSkillsHome = join(root, "home", ".codex", "skills");
    await Promise.all([
      mkdir(claudeSkillsHome, { recursive: true }),
      mkdir(agentsSkillsHome, { recursive: true }),
      mkdir(legacyCodexSkillsHome, { recursive: true }),
    ]);

    await ensureSkillSymlinks([], {
      mainRepoRoot: REPO_ROOT,
      claudeSkillsHome,
      agentsSkillsHome,
      legacyCodexSkillsHome,
    });

    expect(await readlink(join(claudeSkillsHome, "explain-clearly"))).toBe(SKILL_ROOT);
    expect(await readlink(join(agentsSkillsHome, "explain-clearly"))).toBe(SKILL_ROOT);
    await expect(access(join(REPO_ROOT, ".agents", "skills", "explain-clearly"))).rejects.toThrow();
    await expect(access(join(REPO_ROOT, ".codex", "skills", "explain-clearly"))).rejects.toThrow();

    const indexSource = await readFile(join(SERVER_DIR, "index.ts"), "utf-8");
    const startupMatch = indexSource.match(/STARTUP_SKILL_SYMLINKS = \[([\s\S]*?)\];/);
    expect(startupMatch).toBeTruthy();
    expect(startupMatch![1]).not.toContain('"explain-clearly"');
  });
});
