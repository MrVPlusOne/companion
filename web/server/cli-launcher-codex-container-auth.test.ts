import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { renderContainerCodexFileWrite, prepareCodexSpawn } from "./cli-launcher-codex.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takode-codex-container-launch-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function normalizeMaiHostname(input: string): string {
  let normalized = input.replace(/[^A-Za-z0-9._-]/g, "-");
  while (normalized.length > 0 && /^[._-]/.test(normalized)) normalized = normalized.slice(1);
  while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return normalized.slice(0, 64).replace(/[._-]+$/, "") || "host";
}

describe("Codex container launch materialization", () => {
  it("chooses a collision-free quoted heredoc marker for instruction contents", () => {
    const script = renderContainerCodexFileWrite(
      "/root/.codex/AGENTS.md",
      "before\n__COMPANION_CODEX_GLOBAL_INSTRUCTIONS__\necho should-stay-data\nafter\n",
      "__COMPANION_CODEX_GLOBAL_INSTRUCTIONS__",
    );

    expect(script).toContain("<<'__COMPANION_CODEX_GLOBAL_INSTRUCTIONS___1'");
    expect(script).toContain("\n__COMPANION_CODEX_GLOBAL_INSTRUCTIONS__\necho should-stay-data\nafter\n");
    expect(script).toMatch(/after\n__COMPANION_CODEX_GLOBAL_INSTRUCTIONS___1$/);
  });

  it("uses the MAI wrapper host CODEX_HOME without falling back to the legacy global file", async () => {
    const root = await tempRoot();
    const wrapperRoot = join(root, "wrapper");
    const wrapperPath = join(wrapperRoot, "codex.sh");
    const hostCodexHome = join(root, "mai-host-home");
    const legacyCodexHome = join(root, "legacy-home");
    const codexHome = join(root, "session-homes");
    const agentsSkillsHome = join(root, "agents-skills");
    await Promise.all([
      mkdir(join(wrapperRoot, ".run"), { recursive: true }),
      mkdir(hostCodexHome, { recursive: true }),
      mkdir(legacyCodexHome, { recursive: true }),
      mkdir(agentsSkillsHome, { recursive: true }),
    ]);
    await writeFile(join(wrapperRoot, ".mai-agents-root"), "", "utf-8");
    await writeFile(wrapperPath, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
    await chmod(wrapperPath, 0o755);
    await writeFile(join(hostCodexHome, "AGENTS.md"), "MAI host global guidance\n", "utf-8");
    await writeFile(join(legacyCodexHome, "AGENTS.md"), "legacy global must not leak\n", "utf-8");
    const hostNames = new Set([hostname(), hostname().split(".")[0] || hostname()]);
    for (const hostName of hostNames) {
      await writeFile(
        join(wrapperRoot, ".run", `.env-${normalizeMaiHostname(hostName)}`),
        `CODEX_HOME="${hostCodexHome}"\n`,
        "utf-8",
      );
    }

    const spec = await prepareCodexSpawn(
      "mai-session",
      { cwd: "/workspace" },
      {
        codexBinary: wrapperPath,
        codexHome,
        codexLegacyHome: legacyCodexHome,
        codexAgentsSkillsHome: agentsSkillsHome,
        codexSandbox: "workspace-write",
        codexSpawnPrepYieldEveryMs: Number.POSITIVE_INFINITY,
      },
    );

    const sessionInstructionPath = join(codexHome, "mai-session", "AGENTS.md");
    expect(await readFile(sessionInstructionPath, "utf-8")).toBe("MAI host global guidance\n");
    expect(spec.instructionContext.globalSources).toContainEqual({
      loadedPath: sessionInstructionPath,
      sourcePath: join(hostCodexHome, "AGENTS.md"),
      delivery: "copied_snapshot",
    });
  });

  it("refreshes auth and materializes the isolated global instruction snapshot before every Codex exec", async () => {
    const root = await tempRoot();
    const codexHome = join(root, "codex-home");
    const legacyCodexHome = join(root, "legacy-codex-home");
    const agentsSkillsHome = join(root, "agents-skills");
    await mkdir(legacyCodexHome, { recursive: true });
    await mkdir(agentsSkillsHome, { recursive: true });
    await writeFile(join(legacyCodexHome, "AGENTS.md"), "isolated global guidance\n", "utf-8");

    const spec = await prepareCodexSpawn(
      "test-session-id",
      { cwd: "/workspace" },
      {
        containerId: "abc123def456",
        codexHome,
        codexLegacyHome: legacyCodexHome,
        codexAgentsSkillsHome: agentsSkillsHome,
        codexSandbox: "workspace-write",
        codexSpawnPrepYieldEveryMs: Number.POSITIVE_INFINITY,
      },
    );

    const bashIndex = spec.spawnCmd.indexOf("-lc");
    expect(bashIndex).toBeGreaterThan(-1);
    const innerScript = spec.spawnCmd[bashIndex + 1];

    // Containers keep /root/.codex writable, so launch prep refreshes both
    // auth and the effective global instruction snapshot before app-server.
    expect(innerScript).toContain("if [ -f /companion-host-codex/auth.json ]; then");
    expect(innerScript).toContain("rm -f /root/.codex/auth.json");
    expect(innerScript).toContain("cp /companion-host-codex/auth.json /root/.codex/auth.json");
    expect(innerScript).toContain("isolated global guidance");
    expect(innerScript).toContain('cat > "/root/.codex/AGENTS.md"');
    expect(innerScript.indexOf("isolated global guidance")).toBeLessThan(innerScript.indexOf("exec 'codex'"));
    expect(spec.instructionContext.globalSources).toContainEqual({
      loadedPath: "/root/.codex/AGENTS.md",
      sourcePath: join(legacyCodexHome, "AGENTS.md"),
      delivery: "copied_snapshot",
    });
  });
});
