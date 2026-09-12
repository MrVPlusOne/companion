import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  buildLeaderPreloadDeliveryContent,
  buildLeaderSkillPreloadBundles,
  buildLeaderSkillPreloadHistoryFollowUps,
  LEADER_SKILL_PRELOAD_MANIFEST,
} from "./leader-skill-preload.js";
import {
  isLeaderSkillPreloadSourceId,
  LEADER_SKILL_PRELOAD_SOURCE_ID_PREFIX,
} from "../shared/injected-event-message.js";

describe("leader skill preload builder", () => {
  it("builds one manifest-backed preload bundle per mandatory leader skill", async () => {
    const readFile = vi.fn(async (path: string) => `content for ${path}`);

    const bundles = await buildLeaderSkillPreloadBundles({ packageRoot: "/repo", readFile });

    expect(bundles.map((bundle) => bundle.skillName)).toEqual([
      "takode-orchestration",
      "leader-dispatch",
      "leader-decision-communication",
      "confirm",
      "quest",
    ]);
    expect(LEADER_SKILL_PRELOAD_MANIFEST.find((entry) => entry.skillName === "takode-orchestration")?.files).toEqual([
      ".claude/skills/takode-orchestration/SKILL.md",
    ]);
    // The injected leader prompt calls this skill preloaded, so the manifest must make that claim true.
    expect(
      LEADER_SKILL_PRELOAD_MANIFEST.find((entry) => entry.skillName === "leader-decision-communication")?.files,
    ).toEqual([".claude/skills/leader-decision-communication/SKILL.md"]);
    expect(LEADER_SKILL_PRELOAD_MANIFEST.find((entry) => entry.skillName === "quest")?.files).toEqual([
      "web/server/templates/quest-skill-docs.md",
    ]);
    expect(readFile).toHaveBeenCalledTimes(5);

    const orchestration = bundles[0]!;
    expect(orchestration.content).toContain("content for /repo/.claude/skills/takode-orchestration/SKILL.md");
    expect(orchestration.content).not.toContain("quest-journey.md");
    expect(orchestration.content).not.toContain("board-usage.md");
    expect(orchestration.agentSource.sessionId).toBe(`${LEADER_SKILL_PRELOAD_SOURCE_ID_PREFIX}takode-orchestration`);
    expect(isLeaderSkillPreloadSourceId(orchestration.agentSource.sessionId)).toBe(true);
  });

  it("loads each canonical skill source into the actual preload bundle", async () => {
    // Real-source integration catches a stale/wrong source or dropped content.
    // Editing a skill's prose does not require a second copy in this test.
    const bundles = await buildLeaderSkillPreloadBundles();
    for (const bundle of bundles) {
      const entry = LEADER_SKILL_PRELOAD_MANIFEST.find((item) => item.skillName === bundle.skillName)!;
      expect(bundle.files.map((file) => file.repoPath)).toEqual(entry.files);
      for (const file of bundle.files) {
        const canonical = await readFile(new URL(`../../${file.repoPath}`, import.meta.url), "utf-8");
        expect(file.content).toBe(canonical);
        expect(bundle.content).toContain(canonical.trimEnd());
      }
    }
  });

  it("keeps visible preload events separate while model delivery is atomic", async () => {
    const readFile = vi.fn(async (path: string) => `content for ${path}`);
    const bundles = await buildLeaderSkillPreloadBundles({ packageRoot: "/repo", readFile });

    const delivery = buildLeaderPreloadDeliveryContent("Leader kickoff", bundles);
    const followUps = buildLeaderSkillPreloadHistoryFollowUps(bundles);

    expect(delivery.startsWith("Leader kickoff")).toBe(true);
    for (const bundle of bundles) expect(delivery).toContain(bundle.content);
    expect(followUps).toEqual(bundles.map(({ content, agentSource }) => ({ content, agentSource })));
  });
});
