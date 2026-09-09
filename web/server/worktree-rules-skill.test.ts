import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(new URL("../../.claude/skills/worktree-rules/SKILL.md", import.meta.url));

function readWorktreeRulesSkill(): string {
  return readFileSync(skillPath, "utf8");
}

describe("worktree-rules skill", () => {
  it("orders remote-backed branch mismatch stop before mutating pull commands", () => {
    const skill = readWorktreeRulesSkill();
    const branchCheck = "git -C <BASE_REPO> symbolic-ref --short HEAD";
    const mismatchStop = "If the current base-repo branch is not exactly `<BASE_BRANCH>`, stop";
    const pullCommand =
      "git -C <BASE_REPO> fetch origin <BASE_BRANCH> && git -C <BASE_REPO> pull --ff-only origin <BASE_BRANCH>";

    // q-1466 regression coverage: agents often copy fenced command blocks
    // literally, so the mutating pull must not appear before the mismatch stop.
    expect(skill.indexOf(branchCheck)).toBeGreaterThanOrEqual(0);
    expect(skill.indexOf(mismatchStop)).toBeGreaterThan(skill.indexOf(branchCheck));
    expect(skill.indexOf(pullCommand)).toBeGreaterThan(skill.indexOf(mismatchStop));
  });

  it("fast-forwards a clean target but preserves a landed commit when the documented pull encounters divergence", () => {
    // Exercise the documented update flag only in three freshly created local repositories.
    // Never execute arbitrary shell text from a skill, use real remotes, or inherit Git path/config overrides.
    const root = mkdtempSync(join(tmpdir(), "port-update-test-"));
    const target = join(root, "target");
    const remote = join(root, "remote.git");
    const other = join(root, "other");
    const hooks = join(root, "empty-hooks");
    mkdirSync(target);
    mkdirSync(hooks);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of Object.keys(env)) {
      if (
        /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|TEMPLATE_DIR|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*)$/.test(
          key,
        )
      )
        delete env[key];
    }
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
    const configure = (cwd: string) => {
      git(cwd, "config", "user.name", "Fixture");
      git(cwd, "config", "user.email", "fixture@example.invalid");
      git(cwd, "config", "core.hooksPath", hooks);
    };
    const commit = (cwd: string, name: string) => {
      writeFileSync(join(cwd, name), `${name}\n`);
      git(cwd, "add", name);
      git(cwd, "commit", "-m", name);
      return git(cwd, "rev-parse", "HEAD");
    };
    const flag = readWorktreeRulesSkill().match(
      /git -C <BASE_REPO> pull (--ff-only|--rebase) origin <BASE_BRANCH>/,
    )?.[1];
    try {
      expect(flag).toBeDefined();
      git(target, "-c", `init.templateDir=${hooks}`, "init", "-b", "integration");
      configure(target);
      commit(target, "base");
      git(root, "clone", "--bare", target, remote);
      git(remote, "config", "core.hooksPath", hooks);
      git(target, "remote", "add", "origin", remote);
      git(root, "clone", remote, other);
      configure(other);
      const firstRemote = commit(other, "first-remote");
      git(other, "push", "origin", "integration");
      git(target, "pull", flag!, "origin", "integration");
      expect(git(target, "rev-parse", "HEAD")).toBe(firstRemote);
      git(target, "config", "pull.rebase", "true");
      const landed = commit(target, "landed-local");
      commit(other, "second-remote");
      git(other, "push", "origin", "integration");
      expect(() => git(target, "pull", flag!, "origin", "integration")).toThrow();
      expect(git(target, "rev-parse", "HEAD")).toBe(landed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches selected-target commits before Memory and keeps memory commits separate", () => {
    const skill = readWorktreeRulesSkill();

    expect(skill).toContain('takode board work-to-memory q-N --work-note <feedback-index> --commits "sha1,sha2"');
    expect(skill).toContain("takode board work-to-memory q-N --work-note <feedback-index> --no-code");
    expect(skill).toContain("old metadata does not replace fresh transition evidence");
    expect(skill).toContain("commit counts and diff controls are available immediately");
    expect(skill).toContain("Final Memory must not be the first phase to attach accepted Work code SHAs");
    expect(skill).toContain("`--memory-commit` / `--memory-commits`");
    expect(skill).not.toContain("Final Memory should attach those SHAs");
    expect(skill).not.toContain("quest complete q-N --commits");
  });
});
