import { createHash } from "node:crypto";
import { copyFile, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const CODEX_GLOBAL_INSTRUCTION_FILENAMES = ["AGENTS.override.md", "AGENTS.md"] as const;
const MANIFEST_FILENAME = ".takode-global-instructions.json";

export interface CodexGlobalInstructionSnapshot {
  filename: (typeof CODEX_GLOBAL_INSTRUCTION_FILENAMES)[number];
  contents: string;
}

interface ManagedInstructionManifest {
  version: 1;
  files: Partial<Record<(typeof CODEX_GLOBAL_INSTRUCTION_FILENAMES)[number], { sourcePath: string; sha256: string }>>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function readManifest(codexHome: string): Promise<ManagedInstructionManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(codexHome, MANIFEST_FILENAME), "utf-8"));
    return parsed?.version === 1 && parsed.files && typeof parsed.files === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function preserveUnexpectedDestination(dest: string): Promise<void> {
  if (!(await pathExists(dest))) return;
  let backup = `${dest}.takode-preserved`;
  for (let suffix = 2; await pathExists(backup); suffix += 1) {
    backup = `${dest}.takode-preserved.${suffix}`;
  }
  await copyFile(dest, backup);
  console.warn(`[cli-launcher] Preserved unexpected session instruction file at ${backup}`);
}

async function destinationMatchesManagedSnapshot(
  dest: string,
  managed: { sha256: string } | undefined,
): Promise<boolean> {
  if (!managed) return false;
  try {
    const stat = await lstat(dest);
    if (!stat.isFile()) return false;
    return digest(await readFile(dest, "utf-8")) === managed.sha256;
  } catch {
    return false;
  }
}

/** Snapshot the native global candidates from the effective host Codex home. */
export async function syncCodexGlobalInstructionFiles(codexHome: string, sourceHome: string): Promise<void> {
  const destinationHome = resolve(codexHome);
  const sourceRoot = resolve(sourceHome);
  if (destinationHome === sourceRoot) return;

  const previous = await readManifest(destinationHome);
  const next: ManagedInstructionManifest = { version: 1, files: {} };
  for (const filename of CODEX_GLOBAL_INSTRUCTION_FILENAMES) {
    const sourcePath = join(sourceRoot, filename);
    const dest = join(destinationHome, filename);
    let contents: string | null = null;
    try {
      contents = await readFile(sourcePath, "utf-8");
    } catch {
      // Missing/unreadable candidates are absent from the isolated snapshot.
    }

    const previousManaged = previous?.files?.[filename];
    const destinationIsManaged = await destinationMatchesManagedSnapshot(dest, previousManaged);
    if (contents === null) {
      if (!destinationIsManaged) await preserveUnexpectedDestination(dest);
      await unlink(dest).catch(() => {});
      continue;
    }

    if (!destinationIsManaged) await preserveUnexpectedDestination(dest);
    await unlink(dest).catch(() => {});
    await writeFile(dest, contents, "utf-8");
    next.files[filename] = { sourcePath, sha256: digest(contents) };
  }
  await writeFile(join(destinationHome, MANIFEST_FILENAME), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export async function readEffectiveCodexGlobalInstructions(
  codexHome: string,
): Promise<CodexGlobalInstructionSnapshot | null> {
  for (const filename of CODEX_GLOBAL_INSTRUCTION_FILENAMES) {
    try {
      const contents = await readFile(join(codexHome, filename), "utf-8");
      if (contents.trim()) return { filename, contents };
    } catch {
      // Native Codex falls through from a missing/unreadable override to AGENTS.md.
    }
  }
  return null;
}

export function renderContainerCodexGlobalInstructionWrite(
  snapshot: CodexGlobalInstructionSnapshot | null,
  renderFile: (path: string, contents: string, marker: string) => string,
): string {
  const commands = [
    "mkdir -p /root/.codex",
    ...CODEX_GLOBAL_INSTRUCTION_FILENAMES.map((filename) => `rm -f /root/.codex/${filename}`),
  ];
  if (snapshot) {
    commands.push(
      renderFile(`/root/.codex/${snapshot.filename}`, snapshot.contents, "__COMPANION_CODEX_GLOBAL_INSTRUCTIONS__"),
    );
  }
  return commands.join("\n");
}
