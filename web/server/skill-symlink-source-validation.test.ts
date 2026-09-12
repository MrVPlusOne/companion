import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureSkillSymlinks, type SkillSymlinkRoots } from "./skill-symlink.js";

const tempRoots: string[] = [];
const PROJECT_ROOT = resolve(__dirname, "..", "..");

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeInstallation(): Promise<{
  root: string;
  repoClaudeHome: string;
  repoAgentsHome: string;
  installedAgentsHome: string;
  roots: SkillSymlinkRoots;
}> {
  const root = await mkdtemp(join(tmpdir(), "skill-source-validation-"));
  tempRoots.push(root);
  const mainRepoRoot = join(root, "repo");
  const repoClaudeHome = join(mainRepoRoot, ".claude", "skills");
  const repoAgentsHome = join(mainRepoRoot, ".agents", "skills");
  const installedAgentsHome = join(root, "home", ".agents", "skills");
  const roots = {
    mainRepoRoot,
    claudeSkillsHome: join(root, "home", ".claude", "skills"),
    agentsSkillsHome: installedAgentsHome,
    legacyCodexSkillsHome: join(root, "home", ".codex", "skills"),
  };
  await Promise.all([mkdir(repoClaudeHome, { recursive: true }), mkdir(repoAgentsHome, { recursive: true })]);
  return { root, repoClaudeHome, repoAgentsHome, installedAgentsHome, roots };
}

async function writeSkill(skillsHome: string, slug: string, content: string): Promise<string> {
  const skillDir = join(skillsHome, slug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");
  return skillDir;
}

function validSkillContent(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Test ${name}\n---\n\n# ${body}\n`;
}

describe("skill source payload validation", () => {
  it("falls back from an empty agent source and exposes the canonical skill through the installed path", async () => {
    // This exercises the real filesystem path selection in disposable roots and
    // proves the installed non-Claude link exposes the current canonical guidance.
    const installation = await makeInstallation();
    const slug = "orchestration-guide";
    const canonicalContent = await readFile(
      join(PROJECT_ROOT, ".claude", "skills", "takode-orchestration", "SKILL.md"),
      "utf-8",
    );
    const canonicalDir = await writeSkill(installation.repoClaudeHome, slug, canonicalContent);
    await mkdir(join(installation.repoAgentsHome, slug), { recursive: true });

    await ensureSkillSymlinks([slug], installation.roots);

    const installedDir = join(installation.installedAgentsHome, slug);
    expect((await lstat(installedDir)).isSymbolicLink()).toBe(true);
    expect(await readlink(installedDir)).toBe(canonicalDir);
    expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toContain(
      "One fresh reply may make one exact substitution",
    );
  });

  it("fails over for missing, blank, malformed, non-file, and broken agent payloads", async () => {
    // Each invalid source shape must select the populated canonical source
    // without probing or mutating any real global skill installation.
    const installation = await makeInstallation();
    const slugs = [
      "missing-payload",
      "blank-payload",
      "malformed-payload",
      "missing-metadata",
      "missing-body",
      "non-file-payload",
      "broken-source",
    ];
    const canonicalDirs = new Map<string, string>();
    for (const slug of slugs) {
      canonicalDirs.set(slug, await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, slug)));
    }
    await writeSkill(installation.repoAgentsHome, "blank-payload", "  \n");
    await writeSkill(installation.repoAgentsHome, "malformed-payload", "# Missing skill frontmatter\n");
    await writeSkill(
      installation.repoAgentsHome,
      "missing-metadata",
      "---\nname: missing-metadata\n---\n\n# Missing description\n",
    );
    await writeSkill(
      installation.repoAgentsHome,
      "missing-body",
      "---\nname: missing-body\ndescription: Missing body\n---\n",
    );
    await mkdir(join(installation.repoAgentsHome, "non-file-payload", "SKILL.md"), { recursive: true });
    await symlink(join(installation.root, "missing-source"), join(installation.repoAgentsHome, "broken-source"));

    await ensureSkillSymlinks(slugs, installation.roots);

    for (const slug of slugs) {
      const installedDir = join(installation.installedAgentsHome, slug);
      expect((await lstat(installedDir)).isSymbolicLink()).toBe(true);
      expect(await readlink(installedDir)).toBe(canonicalDirs.get(slug));
      expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toContain(`# ${slug}`);
    }
  });

  it("preserves precedence for a valid distinct agent source", async () => {
    // A readable, nonblank regular SKILL.md remains an intentional non-Claude override.
    const installation = await makeInstallation();
    const slug = "distinct-guide";
    await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, "Canonical guide"));
    const agentContent = validSkillContent(slug, "Distinct agent guide");
    const agentDir = await writeSkill(installation.repoAgentsHome, slug, agentContent);

    await ensureSkillSymlinks([slug], installation.roots);

    const installedDir = join(installation.installedAgentsHome, slug);
    expect(await readlink(installedDir)).toBe(agentDir);
    expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toBe(agentContent);
  });

  it("accepts semantic quoted, literal, and folded metadata values", async () => {
    // Repository skills use both quoted scalars and folded block descriptions;
    // those real values must remain eligible distinct non-Claude sources.
    const installation = await makeInstallation();
    const accepted = new Map([
      ["plain-string", "---\nname: plain-string\ndescription: Ordinary nonempty text\n---\n\n# Plain body\n"],
      ["double-quoted", '---\nname: "double-quoted"\ndescription: "Useful quoted description"\n---\n\n# Quoted body\n'],
      [
        "single-quoted",
        "---\nname: 'single-quoted'\ndescription: 'It''s a useful description'\n---\n\n# Quoted body\n",
      ],
      [
        "literal-description",
        "---\nname: literal-description\ndescription: |-\n  First literal line.\n  Second literal line.\n---\n\n# Literal body\n",
      ],
      [
        "folded-description",
        "---\nname: folded-description\ndescription: >-\n  First folded line\n  continues here.\n---\n\n# Folded body\n",
      ],
      ["quoted-scalar-text", '---\nname: "null"\ndescription: "42"\n---\n\n# Quoted scalar body\n'],
      ["quoted-y-lower", '---\nname: quoted-y-lower\ndescription: "y"\n---\n\n# Quoted alias body\n'],
      ["quoted-y-upper", '---\nname: quoted-y-upper\ndescription: "Y"\n---\n\n# Quoted alias body\n'],
      ["quoted-n-lower", "---\nname: quoted-n-lower\ndescription: 'n'\n---\n\n# Quoted alias body\n"],
      ["quoted-n-upper", "---\nname: quoted-n-upper\ndescription: 'N'\n---\n\n# Quoted alias body\n"],
      [
        "literal-scalar-text",
        "---\nname: literal-scalar-text\ndescription: |-\n  null\n---\n\n# Literal scalar body\n",
      ],
    ]);
    for (const [slug, content] of accepted) {
      await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, "Canonical fallback"));
      await writeSkill(installation.repoAgentsHome, slug, content);
    }

    await ensureSkillSymlinks([...accepted.keys()], installation.roots);

    for (const [slug, content] of accepted) {
      const installedDir = join(installation.installedAgentsHome, slug);
      expect(await readlink(installedDir)).toBe(join(installation.repoAgentsHome, slug));
      expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toBe(content);
    }
  });

  it("accepts the repository's real quoted and folded skill metadata", async () => {
    // Running the real source catalog against disposable destinations catches
    // compatibility drift in currently tracked skill frontmatter forms.
    const installation = await makeInstallation();
    const roots = { ...installation.roots, mainRepoRoot: PROJECT_ROOT };

    await ensureSkillSymlinks(["takode-orchestration", "skeptic-review"], roots);

    const orchestration = await readFile(
      join(installation.installedAgentsHome, "takode-orchestration", "SKILL.md"),
      "utf-8",
    );
    const skeptic = await readFile(join(installation.installedAgentsHome, "skeptic-review", "SKILL.md"), "utf-8");
    // The installed bytes must come from the canonical source; policy wording
    // is not part of the metadata compatibility contract.
    expect(orchestration).toBe(
      await readFile(join(PROJECT_ROOT, ".claude", "skills", "takode-orchestration", "SKILL.md"), "utf-8"),
    );
    expect(skeptic).toBe(
      await readFile(join(PROJECT_ROOT, ".claude", "skills", "skeptic-review", "SKILL.md"), "utf-8"),
    );
  });

  it("rejects semantic blanks and comments in metadata and bodies", async () => {
    // Surface tokens are insufficient: required values and the instruction body
    // must carry semantic text after quotes, comments, and block markers are resolved.
    const installation = await makeInstallation();
    const rejected = new Map([
      ["empty-double", '---\nname: empty-double\ndescription: ""\n---\n\n# Body\n'],
      ["empty-single", "---\nname: empty-single\ndescription: ''\n---\n\n# Body\n"],
      ["comment-value", "---\nname: comment-value\ndescription: # only a comment\n---\n\n# Body\n"],
      ["quoted-comment", '---\nname: quoted-comment\ndescription: "# only a comment"\n---\n\n# Body\n'],
      ["empty-block", "---\nname: empty-block\ndescription: >-\n---\n\n# Body\n"],
      ["comment-block", "---\nname: comment-block\ndescription: |\n  # only a comment\n---\n\n# Body\n"],
      ["comment-body", "---\nname: comment-body\ndescription: Useful description\n---\n\n<!-- only a comment -->\n"],
    ]);
    const canonicalDirs = new Map<string, string>();
    for (const [slug, content] of rejected) {
      canonicalDirs.set(
        slug,
        await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, "Canonical fallback")),
      );
      await writeSkill(installation.repoAgentsHome, slug, content);
    }

    await ensureSkillSymlinks([...rejected.keys()], installation.roots);

    for (const slug of rejected.keys()) {
      const installedDir = join(installation.installedAgentsHome, slug);
      expect(await readlink(installedDir)).toBe(canonicalDirs.get(slug));
      expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toContain("# Canonical fallback");
    }
  });

  it("rejects implicit non-string and unsupported YAML metadata forms", async () => {
    // Required metadata must resolve to strings inside the supported subset;
    // typed scalars and structural YAML forms cannot suppress canonical fallback.
    const installation = await makeInstallation();
    const unsupported = new Map([
      ["null-name", "---\nname: null\ndescription: Useful description\n---\n\n# Body\n"],
      ["tilde-value", "---\nname: tilde-value\ndescription: ~\n---\n\n# Body\n"],
      ["boolean-value", "---\nname: boolean-value\ndescription: true\n---\n\n# Body\n"],
      ["boolean-y-lower", "---\nname: boolean-y-lower\ndescription: y\n---\n\n# Body\n"],
      ["boolean-y-upper", "---\nname: boolean-y-upper\ndescription: Y\n---\n\n# Body\n"],
      ["boolean-n-lower", "---\nname: boolean-n-lower\ndescription: n\n---\n\n# Body\n"],
      ["boolean-n-upper", "---\nname: boolean-n-upper\ndescription: N\n---\n\n# Body\n"],
      ["numeric-value", "---\nname: numeric-value\ndescription: 42\n---\n\n# Body\n"],
      ["float-value", "---\nname: float-value\ndescription: 3.14\n---\n\n# Body\n"],
      ["exponent-value", "---\nname: exponent-value\ndescription: 1e6\n---\n\n# Body\n"],
      ["hex-value", "---\nname: hex-value\ndescription: 0x2A\n---\n\n# Body\n"],
      ["infinite-value", "---\nname: infinite-value\ndescription: -.Inf\n---\n\n# Body\n"],
      ["nan-value", "---\nname: nan-value\ndescription: .NaN\n---\n\n# Body\n"],
      ["date-value", "---\nname: date-value\ndescription: 2026-07-31\n---\n\n# Body\n"],
      ["timestamp-value", "---\nname: timestamp-value\ndescription: 2026-07-31T12:34:56Z\n---\n\n# Body\n"],
      ["flow-list", "---\nname: flow-list\ndescription: [one, two]\n---\n\n# Body\n"],
      ["flow-map", "---\nname: flow-map\ndescription: {key: value}\n---\n\n# Body\n"],
      ["explicit-tag", "---\nname: explicit-tag\ndescription: !!str tagged\n---\n\n# Body\n"],
      ["custom-tag", "---\nname: custom-tag\ndescription: !custom tagged\n---\n\n# Body\n"],
      ["anchor-value", "---\nname: anchor-value\ndescription: &label anchored\n---\n\n# Body\n"],
      ["alias-value", "---\nname: alias-value\ndescription: *label\n---\n\n# Body\n"],
      ["sequence-value", "---\nname: sequence-value\ndescription: - item\n---\n\n# Body\n"],
      ["mapping-value", "---\nname: mapping-value\ndescription: key: value\n---\n\n# Body\n"],
    ]);
    const canonicalDirs = new Map<string, string>();
    for (const [slug, content] of unsupported) {
      canonicalDirs.set(
        slug,
        await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, "Canonical fallback")),
      );
      await writeSkill(installation.repoAgentsHome, slug, content);
    }

    await ensureSkillSymlinks([...unsupported.keys()], installation.roots);

    for (const slug of unsupported.keys()) {
      const installedDir = join(installation.installedAgentsHome, slug);
      expect(await readlink(installedDir)).toBe(canonicalDirs.get(slug));
      expect(await readFile(join(installedDir, "SKILL.md"), "utf-8")).toContain("# Canonical fallback");
    }
  });

  it("rejects duplicate required metadata keys", async () => {
    // Ambiguous duplicate name or description fields fail closed instead of
    // relying on first- or last-key YAML parser behavior.
    const installation = await makeInstallation();
    const duplicates = new Map([
      [
        "duplicate-name",
        "---\nname: duplicate-name\nname: other-name\ndescription: Useful description\n---\n\n# Body\n",
      ],
      [
        "duplicate-description",
        "---\nname: duplicate-description\ndescription: First description\ndescription: Second description\n---\n\n# Body\n",
      ],
    ]);
    const canonicalDirs = new Map<string, string>();
    for (const [slug, content] of duplicates) {
      canonicalDirs.set(
        slug,
        await writeSkill(installation.repoClaudeHome, slug, validSkillContent(slug, "Canonical fallback")),
      );
      await writeSkill(installation.repoAgentsHome, slug, content);
    }

    await ensureSkillSymlinks([...duplicates.keys()], installation.roots);

    for (const slug of duplicates.keys()) {
      expect(await readlink(join(installation.installedAgentsHome, slug))).toBe(canonicalDirs.get(slug));
    }
  });

  it("rejects partial disposable roots before creating any destination", async () => {
    // The runtime guard complements the required-root type so JavaScript and
    // casted callers cannot mix disposable and persistent destinations.
    const installation = await makeInstallation();
    const partialRoots = { mainRepoRoot: installation.roots.mainRepoRoot } as SkillSymlinkRoots;

    await expect(ensureSkillSymlinks(["partial-roots"], partialRoots)).rejects.toThrow("Disposable roots must provide");

    await expect(lstat(join(installation.root, "home"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes stale installed links and reports skips when neither source is usable", async () => {
    // Fail-closed installation leaves no discoverable link when both ordered
    // sources are invalid, and the summary reports destinations actually skipped.
    const installation = await makeInstallation();
    const slug = "unusable-guide";
    const invalidSource = await writeSkill(installation.repoClaudeHome, slug, "<!-- no skill payload -->\n");
    await writeSkill(installation.repoAgentsHome, slug, "  \n");
    const installedClaudeDir = join(installation.roots.claudeSkillsHome, slug);
    const installedAgentsDir = join(installation.roots.agentsSkillsHome, slug);
    await Promise.all([
      mkdir(installation.roots.claudeSkillsHome, { recursive: true }),
      mkdir(installation.roots.agentsSkillsHome, { recursive: true }),
    ]);
    await Promise.all([symlink(invalidSource, installedClaudeDir), symlink(invalidSource, installedAgentsDir)]);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message: string) => logs.push(message));

    await ensureSkillSymlinks([slug], installation.roots);

    await expect(lstat(installedClaudeDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(installedAgentsDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(logs).toContain("[skill-symlink] Installed none; skipped unusable-guide:claude, unusable-guide:agents");
    logSpy.mockRestore();
  });
});
