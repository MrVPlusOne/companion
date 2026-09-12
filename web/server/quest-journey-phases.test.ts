import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QUEST_JOURNEY_PHASES } from "../shared/quest-journey.js";
import {
  ensureBuiltInQuestJourneyPhaseData,
  ensureQuestJourneyPhaseDataForCwd,
  getQuestJourneyPhaseAssigneeBriefPath,
  getQuestJourneyPhaseDataRoot,
  getQuestJourneyPhaseDisplayRoot,
  getQuestJourneyPhaseLeaderBriefPath,
  loadBuiltInQuestJourneyPhases,
  loadQuestJourneyPhaseCatalog,
} from "./quest-journey-phases.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SERVER_DIR, "..");
const tmpHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tmpHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCompanionHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quest-journey-phases-"));
  tmpHomes.push(dir);
  return dir;
}

describe("Quest Journey v2 phase directory loading", () => {
  it("seeds only active v2 phase directories from canonical repo data", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const phases = await loadBuiltInQuestJourneyPhases({ companionHome });

    expect(phases.map((phase) => phase.id)).toEqual(QUEST_JOURNEY_PHASES.map((phase) => phase.id));
    expect(phases.map((phase) => phase.id)).toEqual(["alignment", "work", "user-checkpoint", "memory"]);
    expect(getQuestJourneyPhaseDisplayRoot()).toBe("~/.companion/quest-journey-phases");

    for (const phase of phases) {
      expect(phase.dirPath).toBe(join(getQuestJourneyPhaseDataRoot({ companionHome }), phase.id));
      expect(phase.phaseJsonPath).toBe(join(phase.dirPath, "phase.json"));
      expect(phase.leaderBriefPath).toBe(getQuestJourneyPhaseLeaderBriefPath(phase.id, { companionHome }));
      expect(phase.assigneeBriefPath).toBe(getQuestJourneyPhaseAssigneeBriefPath(phase.id, { companionHome }));
      // Verify installed content against its source rather than copying policy
      // sentences. Swapped roles, stale data, and truncated writes must fail.
      const sourceDir = join(PACKAGE_ROOT, "shared", "quest-journey-phases", phase.id);
      expect(phase.leaderBrief).toBe(await readFile(join(sourceDir, "leader.md"), "utf-8"));
      expect(phase.assigneeBrief).toBe(await readFile(join(sourceDir, "assignee.md"), "utf-8"));
      const metadata = JSON.parse(await readFile(join(sourceDir, "phase.json"), "utf-8"));
      expect(phase.contract).toBe(metadata.contract);
      expect(phase.nextLeaderAction).toBe(metadata.nextLeaderAction);
    }
  });

  it("refreshes active phase files from canonical repo data on reseed", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const workPath = getQuestJourneyPhaseLeaderBriefPath("work", { companionHome });
    await writeFile(workPath, "stale", "utf-8");

    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const refreshed = await readFile(workPath, "utf-8");
    const canonical = await readFile(
      join(PACKAGE_ROOT, "shared", "quest-journey-phases", "work", "leader.md"),
      "utf-8",
    );
    expect(refreshed).toBe(canonical);
  });

  it("removes obsolete live v1 phase directories while preserving active v2 directories", async () => {
    const companionHome = await makeCompanionHome();
    const dataRoot = getQuestJourneyPhaseDataRoot({ companionHome });
    for (const legacy of ["planning", "implement", "code-review", "execute", "port", "bookkeeping"]) {
      await mkdir(join(dataRoot, legacy), { recursive: true });
      await writeFile(join(dataRoot, legacy, "assignee.md"), "stale legacy brief", "utf-8");
    }

    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    for (const legacy of ["planning", "implement", "code-review", "execute", "port", "bookkeeping"]) {
      await expect(readFile(join(dataRoot, legacy, "assignee.md"), "utf-8")).rejects.toThrow();
    }
    for (const phase of QUEST_JOURNEY_PHASES) {
      const canonical = await readFile(
        join(PACKAGE_ROOT, "shared", "quest-journey-phases", phase.id, "assignee.md"),
        "utf-8",
      );
      await expect(readFile(getQuestJourneyPhaseAssigneeBriefPath(phase.id, { companionHome }), "utf-8")).resolves.toBe(
        canonical,
      );
    }
  });

  it("refreshes runtime phase files from the package root nearest the session cwd", async () => {
    const companionHome = await makeCompanionHome();
    const repoRoot = await mkdtemp(join(tmpdir(), "quest-journey-worktree-"));
    tmpHomes.push(repoRoot);
    const packageRoot = join(repoRoot, "web");
    const phaseRoot = join(packageRoot, "shared", "quest-journey-phases");
    await cp(join(PACKAGE_ROOT, "shared", "quest-journey-phases"), phaseRoot, { recursive: true });
    const workPhaseDir = join(packageRoot, "shared", "quest-journey-phases", "work");
    await mkdir(workPhaseDir, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), "{}", "utf-8");
    await writeFile(
      join(workPhaseDir, "phase.json"),
      JSON.stringify({
        id: "work",
        label: "Work",
        color: { name: "green", accent: "#4ade80" },
        boardState: "WORKING",
        assigneeRole: "worker",
        contract: "Fresh from worktree cwd for v2 Work.",
        nextLeaderAction: "fresh next action from worktree cwd",
        aliases: [],
      }),
      "utf-8",
    );
    await writeFile(join(workPhaseDir, "leader.md"), "# Work -- Leader Brief\n\nFresh from worktree cwd", "utf-8");
    await writeFile(join(workPhaseDir, "assignee.md"), "# Work -- Assignee Brief\n\nFresh from worktree cwd", "utf-8");

    const refreshed = await ensureQuestJourneyPhaseDataForCwd(join(repoRoot, "nested", "session"), { companionHome });

    expect(refreshed).toBe(true);
    await expect(
      readFile(getQuestJourneyPhaseAssigneeBriefPath("work", { companionHome }), "utf-8"),
    ).resolves.toContain("Fresh from worktree cwd");
  });

  it("builds a read-only active v2 phase catalog with source metadata and exact display paths", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const catalog = await loadQuestJourneyPhaseCatalog({ packageRoot: PACKAGE_ROOT, companionHome });

    expect(catalog.map((phase) => phase.id)).toEqual(["alignment", "work", "user-checkpoint", "memory"]);
    expect(catalog[0]).toEqual(
      expect.objectContaining({
        id: "alignment",
        label: "Alignment",
        sourceType: "built-in",
        leaderBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/leader.md",
        assigneeBriefDisplayPath: "~/.companion/quest-journey-phases/alignment/assignee.md",
      }),
    );
    expect(catalog.find((phase) => phase.id === "work")).toEqual(
      expect.objectContaining({
        boardState: "WORKING",
        assigneeRole: "worker",
        assigneeBriefDisplayPath: "~/.companion/quest-journey-phases/work/assignee.md",
      }),
    );
  });
});
