import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  lstatSync: vi.fn((_targetDir: string): any => {
    throw missingPathError();
  }),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn(),
}));

function missingPathError(): Error & { code: string } {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

const execMock = vi.hoisted(() =>
  vi.fn((command: string, options: { cwd?: string }, callback: (error: Error | null, stdout: string) => void) => {
    if (command.includes("rev-parse --git-common-dir")) {
      if (options.cwd?.startsWith("/repo")) {
        callback(null, "/repo/.git\n");
        return;
      }
      callback(null, "/main-checkout/.git\n");
      return;
    }
    callback(new Error(`Unexpected command: ${command}`), "");
  }),
);

vi.mock("node:os", () => ({
  homedir: () => "/home/tester",
}));

vi.mock("node:fs", () => fsMocks);
vi.mock("node:child_process", () => ({
  exec: execMock,
}));

import { ensureQuestmasterIntegration } from "./quest-integration.js";

function writtenFile(path: string): string {
  const write = fsMocks.writeFileSync.mock.calls.find((call) => call[0] === path);
  expect(write).toBeDefined();
  return String(write?.[1] ?? "");
}

describe("ensureQuestmasterIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.lstatSync.mockImplementation((_targetDir: string) => {
      throw missingPathError();
    });
  });

  it.each([false, true])("writes canonical quest files to both supported homes (existing=%s)", async (existing) => {
    // Prove missing/stale installations receive complete current templates, not
    // just a few policy phrases. All writes and cleanup remain mocked.
    fsMocks.existsSync.mockReturnValue(existing);
    await ensureQuestmasterIntegration(3456, "/repo/web");
    for (const [filename, template] of [
      ["SKILL.md", "quest-skill-docs.md"],
      ["memory-completion.md", "quest-memory-completion.md"],
    ]) {
      const canonical = await readFile(new URL(`./templates/${template}`, import.meta.url), "utf-8");
      for (const home of [".claude", ".agents"]) {
        expect(writtenFile(`/home/tester/${home}/skills/quest/${filename}`)).toBe(canonical);
      }
    }
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      "/home/tester/.codex/skills/quest/SKILL.md",
      expect.anything(),
      "utf-8",
    );
  });

  it("replaces stale agents quest symlinks before writing the generated quest skill", async () => {
    // Covers the legacy migration state where ~/.agents/skills/quest pointed at
    // ~/.codex/skills/quest. The generated quest skill must become a real,
    // current agents skill before legacy Codex cleanup can remove that target.
    fsMocks.lstatSync.mockImplementation((targetDir: string) => {
      if (targetDir === "/home/tester/.agents/skills/quest") {
        return { isSymbolicLink: () => true, isDirectory: () => false };
      }
      throw missingPathError();
    });

    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.unlinkSync).toHaveBeenCalledWith("/home/tester/.agents/skills/quest");
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.agents/skills/quest", { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.agents/skills/quest/SKILL.md",
      expect.stringContaining("name: quest"),
      "utf-8",
    );
    const unlinkCallIndex = fsMocks.unlinkSync.mock.calls.findIndex(
      (call) => call[0] === "/home/tester/.agents/skills/quest",
    );
    const writeCallIndex = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => call[0] === "/home/tester/.agents/skills/quest/SKILL.md",
    );
    expect(fsMocks.unlinkSync.mock.invocationCallOrder[unlinkCallIndex]).toBeLessThan(
      fsMocks.writeFileSync.mock.invocationCallOrder[writeCallIndex]!,
    );
  });

  it("writes a copied global quest wrapper targeting the stable main checkout", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-1/web");

    const sharedWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.companion/bin/quest",
    );
    expect(sharedWrite).toBeDefined();

    const sharedWrapper = String(sharedWrite?.[1] ?? "");
    expect(sharedWrapper).toContain('exec bun "/repo/web/bin/quest.ts" "$@"');
    expect(sharedWrapper).toContain('exec "$HOME/.bun/bin/bun" "/repo/web/bin/quest.ts" "$@"');
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-1/web/bin/quest.ts");
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      "/home/tester/.companion/bin/servers/server-a/quest",
      expect.anything(),
      "utf-8",
    );

    const memoryWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.companion/bin/memory",
    );
    expect(memoryWrite).toBeDefined();
    const memoryWrapper = String(memoryWrite?.[1] ?? "");
    expect(memoryWrapper).toContain('exec bun "/repo/web/bin/memory.ts" "$@"');
    expect(memoryWrapper).not.toContain("/repo/worktrees/wt-1/web/bin/memory.ts");

    const streamWrite = fsMocks.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/tester/.companion/bin/stream",
    );
    expect(streamWrite).toBeDefined();
    const streamWrapper = String(streamWrite?.[1] ?? "");
    expect(streamWrapper).toContain('exec bun "/repo/web/bin/stream.ts" "$@"');
    expect(streamWrapper).not.toContain("/repo/worktrees/wt-1/web/bin/stream.ts");
  });

  it("writes ~/.local/bin quest, memory, and stream shims that delegate to ~/.companion/bin", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.mkdirSync).toHaveBeenCalledWith("/home/tester/.local/bin", { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/quest",
      expect.stringContaining('exec "$HOME/.companion/bin/quest" "$@"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/quest", 0o755);
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/memory",
      expect.stringContaining('exec "$HOME/.companion/bin/memory" "$@"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/memory", 0o755);
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/stream",
      expect.stringContaining('exec "$HOME/.companion/bin/stream" "$@"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/stream", 0o755);
  });

  it("writes a ~/.local/bin/rg compatibility shim", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/web");

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("rg (companion shim) 0.0.0"),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining('if [ "$1" = "--files" ]; then'),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining("grep_args=("),
      "utf-8",
    );
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/home/tester/.local/bin/rg",
      expect.stringContaining('exec grep "${grep_args[@]}" -- "$pattern" "${positional[@]:1}"'),
      "utf-8",
    );
    expect(fsMocks.chmodSync).toHaveBeenCalledWith("/home/tester/.local/bin/rg", 0o755);
  });

  it("keeps copied quest wrappers identical across worktrees of the same repo", async () => {
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-a/web");
    await ensureQuestmasterIntegration(3456, "/repo/worktrees/wt-b/web");

    const sharedWrites = fsMocks.writeFileSync.mock.calls.filter(
      (call) => call[0] === "/home/tester/.companion/bin/quest",
    );
    expect(sharedWrites).toHaveLength(2);
    expect(sharedWrites[0]?.[1]).toBe(sharedWrites[1]?.[1]);

    const sharedWrapper = String(sharedWrites[1]?.[1] ?? "");
    expect(sharedWrapper).toContain("/repo/web/bin/quest.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-a/web/bin/quest.ts");
    expect(sharedWrapper).not.toContain("/repo/worktrees/wt-b/web/bin/quest.ts");
  });
});
