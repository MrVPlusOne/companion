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
import { HERD_EVENT_LIFECYCLE_LABELS } from "../shared/herd-event-lifecycle.js";

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
    expect(orchestration.content).toContain("Required leader skill preloaded: takode-orchestration");
    expect(orchestration.content).toContain("content for /repo/.claude/skills/takode-orchestration/SKILL.md");
    expect(orchestration.content).toContain("Do not reread this mandatory skill via tool calls");
    expect(orchestration.content).not.toContain("Provenance:");
    expect(orchestration.content).not.toContain("Bundle hash");
    expect(orchestration.content).not.toContain("Files:");
    expect(orchestration.content).not.toContain("bytes");
    expect(orchestration.content).not.toContain("BEGIN FILE");
    expect(orchestration.content).not.toContain("quest-journey.md");
    expect(orchestration.content).not.toContain("board-usage.md");
    expect(orchestration.agentSource.sessionId).toBe(`${LEADER_SKILL_PRELOAD_SOURCE_ID_PREFIX}takode-orchestration`);
    expect(isLeaderSkillPreloadSourceId(orchestration.agentSource.sessionId)).toBe(true);
  });

  it("preloads the accepted-Work-before-Memory contract from the real orchestration skill", async () => {
    const bundles = await buildLeaderSkillPreloadBundles();
    const orchestration = bundles.find((bundle) => bundle.skillName === "takode-orchestration");

    expect(orchestration?.content).toContain("Report accepted Work before Memory closure");
    expect(orchestration?.content).toContain("send final Memory to the normal same worker without waiting for closure");
    expect(orchestration?.content).toContain("Ordinary read-only follow-ups during Memory use accepted evidence");
    expect(orchestration?.content).toContain("Final Memory is mandatory");
    expect(orchestration?.content).toContain("Use the supplied user-message IDs and available conversation context");
    expect(orchestration?.content).toContain("Prefer one self-contained explicit answer per user request");
    expect(orchestration?.content).toContain("progress, status, recovery, verification, bookkeeping");
    expect(orchestration?.content).toContain("inspect source messages or earlier answers only when needed");
    expect(orchestration?.content).toContain("apply `explain-clearly`");
    expect(orchestration?.content).toContain(
      "accepted-Work response normally carries the substantive user-facing answer",
    );
    expect(orchestration?.content).toContain("Final Memory closure is commentary by default");
    expect(orchestration?.content).toContain("materially completes, corrects, or changes the prior response");
    expect(orchestration?.content).toContain("Repeat IDs only when genuinely useful information requires");
    expect(orchestration?.content).toContain("collapsed presentation shows the complete answer set together");
    expect(orchestration?.content).toContain("implementation is still owed");
    expect(orchestration?.content).toContain("they are answers only when setup or dispatch itself fully satisfies");
    expect(orchestration?.content).toContain("remain non-answers and receive a precise actionable diagnostic");
    expect(orchestration?.content).not.toContain("Quest completion responses are answers");
    for (const label of Object.values(HERD_EVENT_LIFECYCLE_LABELS)) {
      expect(orchestration?.content).toContain(label);
    }
  });

  it("preloads automatic answer routing from the canonical skill", async () => {
    // Inspect the actual model-bound skill, including negative assertions for the
    // former restrictions that forced leaders to repeat routing work.
    const bundles = await buildLeaderSkillPreloadBundles();
    const orchestration = bundles.find((bundle) => bundle.skillName === "takode-orchestration");

    expect(orchestration?.content).toContain("Write the answer once using its supplied references");
    expect(orchestration?.content).toContain("[thread:main:A:f1]");
    expect(orchestration?.content).toContain("`--thread main` selects Main explicitly");
    expect(orchestration?.content).toContain("A firing is optional to answer");
    expect(orchestration?.content).toContain("takode read <leader-session> fN");
    expect(orchestration?.content).toContain(
      "Answers may cover nonconsecutive IDs and messages with different owning threads",
    );
    expect(orchestration?.content).toContain("union of Main and quest tabs associated with any referenced prompt");
    expect(orchestration?.content).toContain("The exact prose and message identity are retained");
    expect(orchestration?.content).toContain(
      "Do not discover numeric history indices, attach the answer, or duplicate its prose",
    );
    expect(orchestration?.content).toContain("Each thread receives coverage only for its own referenced user requests");
    expect(orchestration?.content).toContain("visibility alone never completes unrelated work");
    expect(orchestration?.content).toContain("One answer shared across tabs needs only one marker");
    expect(orchestration?.content).not.toContain("retrieve or reread every listed user message");
    expect(orchestration?.content).not.toContain("single authoritative owner shared by every covered ID");
    expect(orchestration?.content).not.toContain("all covered IDs share one proven owner");
    expect(orchestration?.content).not.toContain("ownerless or mixed-owner sets");
  });

  it("preloads the worker-context authority rule from the real leader-dispatch skill", async () => {
    const bundles = await buildLeaderSkillPreloadBundles();
    const leaderDispatch = bundles.find((bundle) => bundle.skillName === "leader-dispatch");

    expect(leaderDispatch?.content).toContain("Preserve source authority in every leader-authored worker context");
    expect(leaderDispatch?.content).toContain("Do not promote leader synthesis into accepted scope");
    expect(leaderDispatch?.content).not.toContain("Leader-only deltas");
  });

  it("delivers required reply shortcuts from the real notification guidance", async () => {
    // Read the installed-source manifest and build the model-bound delivery,
    // rather than checking a copied fixture that could drift from the skill.
    const bundles = await buildLeaderSkillPreloadBundles();
    const delivery = buildLeaderPreloadDeliveryContent("Leader kickoff", bundles);

    expect(delivery).toContain("Whenever you ask the user a question, include one or two concise suggested replies");
    expect(delivery).toContain("for a binary question, include both choices");
    expect(delivery).toContain("never preselected answers or authorization");
    expect(delivery).toContain("the user can always give a custom response");
    expect(delivery).toContain("Keep valid alternatives in that context");
    expect(delivery).toContain("the command continues to accept more suggestions");
    expect(delivery).not.toContain("suggested answers are optional");
    expect(delivery).not.toContain("Use `--suggest` only for concise obvious options");
    expect(delivery).not.toContain("When the answer choices are obvious and short");
  });

  it("keeps visible preload events separate while model delivery is atomic", async () => {
    const readFile = vi.fn(async (path: string) => `content for ${path}`);
    const bundles = await buildLeaderSkillPreloadBundles({ packageRoot: "/repo", readFile });

    const delivery = buildLeaderPreloadDeliveryContent("Leader kickoff", bundles);
    const followUps = buildLeaderSkillPreloadHistoryFollowUps(bundles);

    expect(delivery).toContain("Leader kickoff");
    expect(delivery).toContain("Required leader skill preloaded: takode-orchestration");
    expect(delivery).toContain("Required leader skill preloaded: leader-decision-communication");
    expect(delivery).toContain("Required leader skill preloaded: quest");
    expect(delivery).toContain("via tool calls");
    expect(followUps).toHaveLength(5);
    expect(followUps[0]?.content).toContain("Required leader skill preloaded: takode-orchestration");
    expect(followUps[0]?.agentSource?.sessionId).toBe(`${LEADER_SKILL_PRELOAD_SOURCE_ID_PREFIX}takode-orchestration`);
  });
});
