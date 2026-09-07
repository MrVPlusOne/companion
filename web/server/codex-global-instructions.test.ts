import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readEffectiveCodexGlobalInstructions,
  renderContainerCodexGlobalInstructionWrite,
  syncCodexGlobalInstructionFiles,
} from "./codex-global-instructions.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takode-codex-instructions-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex global instruction isolation", () => {
  it("snapshots both native candidates and dereferences user symlinks", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    const userGuide = join(root, "USER_GUIDE.md");
    await writeFile(userGuide, "global defaults\n", "utf-8");
    await symlink(userGuide, join(sourceHome, "AGENTS.md"));
    await writeFile(join(sourceHome, "AGENTS.override.md"), "temporary override\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);

    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("global defaults\n");
    expect(await readFile(join(sessionHome, "AGENTS.override.md"), "utf-8")).toBe("temporary override\n");
    await expect(readlink(join(sessionHome, "AGENTS.md"))).rejects.toThrow();
  });

  it("keeps a launch snapshot stable until the next synchronization", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    const source = join(sourceHome, "AGENTS.md");
    await writeFile(source, "first launch\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    await writeFile(source, "next launch\n", "utf-8");
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("first launch\n");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("next launch\n");
  });

  it("preserves an unexpected session file before replacing it and removes stale managed copies", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    await writeFile(join(sourceHome, "AGENTS.md"), "host global\n", "utf-8");
    await writeFile(join(sessionHome, "AGENTS.md"), "unexpected session data\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    expect(await readFile(join(sessionHome, "AGENTS.md.takode-preserved"), "utf-8")).toBe("unexpected session data\n");
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("host global\n");

    await rm(join(sourceHome, "AGENTS.md"));
    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    await expect(readFile(join(sessionHome, "AGENTS.md"), "utf-8")).rejects.toThrow();
  });

  it("preserves a session snapshot that changed after Takode last managed it", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    await writeFile(join(sourceHome, "AGENTS.md"), "first host version\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    await writeFile(join(sessionHome, "AGENTS.md"), "manual session edit\n", "utf-8");
    await writeFile(join(sourceHome, "AGENTS.md"), "second host version\n", "utf-8");
    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);

    expect(await readFile(join(sessionHome, "AGENTS.md.takode-preserved"), "utf-8")).toBe("manual session edit\n");
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("second host version\n");
  });

  it("preserves successive unexpected session files without overwriting an earlier backup", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    await writeFile(join(sourceHome, "AGENTS.md"), "host version one\n", "utf-8");
    await writeFile(join(sessionHome, "AGENTS.md"), "unexpected before management\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);
    await writeFile(join(sessionHome, "AGENTS.md"), "unexpected after management\n", "utf-8");
    await writeFile(join(sourceHome, "AGENTS.md"), "host version two\n", "utf-8");
    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);

    expect(await readFile(join(sessionHome, "AGENTS.md.takode-preserved"), "utf-8")).toBe(
      "unexpected before management\n",
    );
    expect(await readFile(join(sessionHome, "AGENTS.md.takode-preserved.2"), "utf-8")).toBe(
      "unexpected after management\n",
    );
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("host version two\n");
  });

  it("replaces an unexpected session symlink without modifying its target", async () => {
    const root = await tempRoot();
    const sourceHome = join(root, "source");
    const sessionHome = join(root, "session");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(sessionHome, { recursive: true });
    const unrelated = join(root, "unrelated.md");
    await writeFile(unrelated, "do not overwrite\n", "utf-8");
    await symlink(unrelated, join(sessionHome, "AGENTS.md"));
    await writeFile(join(sourceHome, "AGENTS.md"), "host global\n", "utf-8");

    await syncCodexGlobalInstructionFiles(sessionHome, sourceHome);

    expect(await readFile(unrelated, "utf-8")).toBe("do not overwrite\n");
    expect(await readFile(join(sessionHome, "AGENTS.md"), "utf-8")).toBe("host global\n");
    await expect(readlink(join(sessionHome, "AGENTS.md"))).rejects.toThrow();
  });

  it("selects the first non-empty native candidate for container materialization", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "AGENTS.override.md"), " \n", "utf-8");
    await writeFile(join(root, "AGENTS.md"), "base global\n", "utf-8");

    const snapshot = await readEffectiveCodexGlobalInstructions(root);
    expect(snapshot).toEqual({ filename: "AGENTS.md", contents: "base global\n" });

    const rendered = renderContainerCodexGlobalInstructionWrite(snapshot, (path, contents) => `${path}\n${contents}`);
    expect(rendered).toContain("rm -f /root/.codex/AGENTS.override.md");
    expect(rendered).toContain("/root/.codex/AGENTS.md\nbase global");
    expect(rendered).not.toContain(root);
  });
});
