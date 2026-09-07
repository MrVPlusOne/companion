import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(SERVER_DIR, "index.ts");
const ORCHESTRATION_DESIGN_SKILL_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "takode-orchestration-design",
  "SKILL.md",
);
const LEADER_DECISION_COMMUNICATION_SKILL_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "leader-decision-communication",
  "SKILL.md",
);
const QUEST_DESIGN_SKILL_PATH = join(SERVER_DIR, "..", "..", ".claude", "skills", "quest-design", "SKILL.md");
const SKEPTIC_REVIEW_SKILL_PATH = join(SERVER_DIR, "..", "..", ".claude", "skills", "skeptic-review", "SKILL.md");
const WORKTREE_RULES_SKILL_PATH = join(SERVER_DIR, "..", "..", ".claude", "skills", "worktree-rules", "SKILL.md");
const LEADER_DISPATCH_SKILL_PATH = join(SERVER_DIR, "..", "..", ".claude", "skills", "leader-dispatch", "SKILL.md");
const TAKODE_ORCHESTRATION_SKILL_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "takode-orchestration",
  "SKILL.md",
);
const LEADER_DISPATCH_EDGE_CASES_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "leader-dispatch",
  "references",
  "edge-cases.md",
);
const LEADER_DISPATCH_PHASE_HANDOFF_EXAMPLES_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "leader-dispatch",
  "references",
  "phase-handoff-examples.md",
);
const TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH = join(
  SERVER_DIR,
  "..",
  "..",
  ".claude",
  "skills",
  "takode-orchestration",
  "quest-journey.md",
);
const WORK_LEADER_BRIEF_PATH = join(SERVER_DIR, "..", "shared", "quest-journey-phases", "work", "leader.md");
const WORK_ASSIGNEE_BRIEF_PATH = join(SERVER_DIR, "..", "shared", "quest-journey-phases", "work", "assignee.md");
const MEMORY_LEADER_BRIEF_PATH = join(SERVER_DIR, "..", "shared", "quest-journey-phases", "memory", "leader.md");
const USER_CHECKPOINT_LEADER_BRIEF_PATH = join(
  SERVER_DIR,
  "..",
  "shared",
  "quest-journey-phases",
  "user-checkpoint",
  "leader.md",
);
const USER_CHECKPOINT_ASSIGNEE_BRIEF_PATH = join(
  SERVER_DIR,
  "..",
  "shared",
  "quest-journey-phases",
  "user-checkpoint",
  "assignee.md",
);
const CLI_LAUNCHER_INSTRUCTIONS_PATH = join(SERVER_DIR, "cli-launcher-instructions.ts");
const COMPACTION_RECOVERY_PROMPTS_PATH = join(SERVER_DIR, "compaction-recovery-prompts.ts");
const QUEST_SKILL_TEMPLATE_PATH = join(SERVER_DIR, "templates", "quest-skill-docs.md");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const QUEST_JOURNEY_SKILL_SLUGS = [
  "quest-journey-alignment",
  "quest-journey-explore",
  "quest-journey-implement",
  "quest-journey-code-review",
  "quest-journey-mental-simulation",
  "quest-journey-execute",
  "quest-journey-outcome-review",
  "quest-journey-user-checkpoint",
  "quest-journey-bookkeeping",
  "quest-journey-port",
  "quest-journey-planning",
  "quest-journey-implementation",
  "quest-journey-skeptic-review",
  "quest-journey-reviewer-groom",
  "quest-journey-porting",
];

describe("index startup skill registration", () => {
  it("registers canonical startup skills without stale hardcoded slugs", async () => {
    // If a nonexistent project skill is reintroduced here, startup will recreate
    // warning spam and potentially broken symlink state. Guard the actual
    // STARTUP_SKILL_SYMLINKS registration list in index.ts directly.
    const source = await readFile(INDEX_PATH, "utf-8");
    const match = source.match(/STARTUP_SKILL_SYMLINKS = \[([\s\S]*?)\];/);
    expect(match).toBeTruthy();

    const registered = [...match![1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);

    expect(registered).not.toContain("cron-scheduling");
    expect(registered).toContain("takode-orchestration");
    expect(registered).toContain("leader-dispatch");
    expect(registered).toContain("leader-decision-communication");
    expect(registered).toContain("confirm");
    expect(registered).not.toContain("quest-journey-planning");
    expect(registered).not.toContain("quest-journey-explore");
    expect(registered).not.toContain("quest-journey-implement");
    expect(registered).not.toContain("quest-journey-code-review");
    expect(registered).not.toContain("quest-journey-mental-simulation");
    expect(registered).not.toContain("quest-journey-execute");
    expect(registered).not.toContain("quest-journey-outcome-review");
    expect(registered).not.toContain("quest-journey-user-checkpoint");
    expect(registered).not.toContain("quest-journey-bookkeeping");
    expect(registered).not.toContain("quest-journey-port");
    expect(registered).not.toContain("quest-journey-implementation");
    expect(registered).not.toContain("quest-journey-skeptic-review");
    expect(registered).not.toContain("quest-journey-reviewer-groom");
    expect(registered).not.toContain("quest-journey-porting");
    expect(registered).toContain("self-groom");
    expect(registered).toContain("reviewer-groom");
    expect(registered).toContain("skeptic-review");
    expect(registered).toContain("worktree-rules");
    expect(registered).not.toContain("playwright-e2e-tester");
  });

  it("does not keep Quest Journey phase skills as repo skill sources or documented installed skills", async () => {
    const docs = await Promise.all([
      readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8"),
      readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8"),
    ]);

    for (const slug of QUEST_JOURNEY_SKILL_SLUGS) {
      await expect(access(join(REPO_ROOT, ".claude", "skills", slug, "SKILL.md"))).rejects.toThrow();
      for (const doc of docs) {
        expect(doc).not.toContain(slug);
      }
    }

    for (const doc of docs) {
      expect(doc).toContain("~/.companion/quest-journey-phases/<phase-id>/");
      expect(doc).toContain("Avoid adding global skills for context-dependent instructions");
      expect(doc).toContain(
        "Historical and canonical phase skill slugs remain internal Quest Journey compatibility metadata only",
      );
    }
  });

  it("documents a narrow orchestration design placement skill", async () => {
    const [skill, claudeDocs, agentsDocs] = await Promise.all([
      readFile(ORCHESTRATION_DESIGN_SKILL_PATH, "utf-8"),
      readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8"),
      readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8"),
    ]);

    expect(skill).toContain("name: takode-orchestration-design");
    expect(skill).toContain("Use when designing, reviewing, or changing Takode");
    expect(skill).toContain("Do not use for ordinary quest execution");
    expect(skill).toContain("Placement Rubric");
    expect(skill).toContain("Source-Of-Truth Check");
    expect(skill).toContain("Avoid new project skills under legacy `.codex/skills`");
    expect(skill).toContain("Leader-specific deltas");
    expect(skill).toContain("read-only implementation follow-ups");
    expect(skill).toContain("consult the context-rich responsible worker");
    expect(skill).toContain("accepted Work/Memory evidence before reopening source yourself");
    expect(skill).toContain("A tiny direct worker errand may also bypass quest lifecycle");
    expect(skill).toContain("Fail closed to a normal quest when scope expands");
    expect(skill).toContain("Do not create a quest or authorize changes");
    expect(skill).toContain("Workers should communicate at meaningful quest milestones");
    expect(skill).toContain("concise user-facing outcome summaries");
    expect(skill).not.toContain("quest-journey-implement");

    for (const docs of [claudeDocs, agentsDocs]) {
      expect(docs).toContain("`takode-orchestration-design`");
      expect(docs).toContain(".claude/skills/takode-orchestration-design/");
    }

    await expect(
      access(join(REPO_ROOT, ".agents", "skills", "takode-orchestration-design", "SKILL.md")),
    ).rejects.toThrow();
    await expect(
      access(join(REPO_ROOT, ".codex", "skills", "takode-orchestration-design", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("keeps decision-first leader communication in one focused skill", async () => {
    const [
      skill,
      questDesign,
      leaderDispatch,
      orchestration,
      journey,
      checkpointLeader,
      checkpointAssignee,
      launcher,
      claudeDocs,
      agentsDocs,
    ] = await Promise.all([
      readFile(LEADER_DECISION_COMMUNICATION_SKILL_PATH, "utf-8"),
      readFile(QUEST_DESIGN_SKILL_PATH, "utf-8"),
      readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH, "utf-8"),
      readFile(USER_CHECKPOINT_LEADER_BRIEF_PATH, "utf-8"),
      readFile(USER_CHECKPOINT_ASSIGNEE_BRIEF_PATH, "utf-8"),
      readFile(CLI_LAUNCHER_INSTRUCTIONS_PATH, "utf-8"),
      readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8"),
      readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8"),
    ]);

    expect(skill).toContain("name: leader-decision-communication");
    expect(skill).toContain("decision, approval, confirmation, clarification, proposal, action request");
    expect(skill).toContain("material status update");
    expect(skill).toContain("For a **status update with no user decision**");
    expect(skill).toContain("Use familiar language");
    expect(skill).toContain("Do not use a hard length limit");
    expect(skill).toContain("The reference is not a substitute for the decision surface");
    // Safety-driven fidelity and cost changes must remain visible user decisions, not hidden scope.
    expect(skill).toContain("make the assumption a named user decision");
    expect(skill).toContain("unless existing policy or an approved contract already covers that exact change");
    expect(skill).toContain("A protected access method alone is not evidence");
    expect(skill).toContain("credential and authority safeguards still remain mandatory");
    expect(skill).toContain("fresh explicit approval");
    expect(skill).toContain("visible-prompt-before-notify");
    expect(skill).toContain("interruption, replay, idempotence, and routing policy");

    // Protect the plain-language decision-first order itself, not merely skill discovery.
    const orderedMarkers = [
      "**Problem or current state**",
      "**Practical consequence**",
      "**Recommendation**",
      "**Choices and key tradeoffs**",
      "**Exact requested answer**",
    ];
    let previousIndex = -1;
    for (const marker of orderedMarkers) {
      const markerIndex = skill.indexOf(marker);
      expect(markerIndex).toBeGreaterThan(previousIndex);
      previousIndex = markerIndex;
    }
    expect(skill).toContain("Can the user decide without understanding internal implementation?");
    expect(skill).toContain("Two things block the test run");
    expect(skill.indexOf("I recommend preparing the bundle")).toBeLessThan(skill.indexOf("Reply **Bundle: yes/no**"));

    const completeRuleMarkers = [
      "This skill is the authoritative owner of Takode's decision-first communication rule",
      "## Choose the Message Shape",
      "## Apply the Necessity Filter",
      "Commands, hashes, internal paths, process or job identifiers",
      "Can the user decide without understanding internal implementation?",
    ];
    const pointerOnlySources = [
      questDesign,
      leaderDispatch,
      orchestration,
      journey,
      checkpointLeader,
      checkpointAssignee,
      launcher,
    ];
    for (const marker of completeRuleMarkers) {
      expect(skill).toContain(marker);
      for (const pointerOnlySource of pointerOnlySources) {
        expect(pointerOnlySource).not.toContain(marker);
      }
    }
    for (const pointerSource of pointerOnlySources) {
      expect(pointerSource).toContain("leader-decision-communication");
    }

    // Existing checkpoint safety remains owned by its operational surfaces.
    expect(checkpointLeader).toContain("visible decision section before calling `takode notify`");
    expect(checkpointLeader).toContain("fresh explicit approval before external consequences");
    expect(checkpointLeader).toContain("--wait-for-input");
    expect(launcher).toContain("Do not fire the notification before the detailed text is visible");
    expect(launcher).toContain("Link the affected active board row with `--wait-for-input`");

    for (const docs of [claudeDocs, agentsDocs]) {
      expect(docs).toContain("`leader-decision-communication`");
      expect(docs).toContain(".claude/skills/leader-decision-communication/");
    }
    await expect(
      access(join(REPO_ROOT, ".agents", "skills", "leader-decision-communication", "SKILL.md")),
    ).rejects.toThrow();
    await expect(
      access(join(REPO_ROOT, ".codex", "skills", "leader-decision-communication", "SKILL.md")),
    ).rejects.toThrow();
  });

  it("keeps the loaded Quest Journey guidance aligned with the v2 active catalog", async () => {
    const [source, topLevelSource] = await Promise.all([
      readFile(TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
    ]);

    expect(source).toContain("`alignment -> work -> memory`");
    expect(source).toContain("Quest Journey v2 has one active workflow for quest-backed work");
    expect(source).toContain("Direct worker errands are not Quest Journey states");
    expect(source).toContain("| Work | `WORKING` |");
    expect(source).toContain("| User Checkpoint | `USER_CHECKPOINTING` |");
    expect(source).toContain("| Memory | `MEMORY` |");
    expect(source).toContain("Legacy v1 phase IDs are rejected for new active rows and revisions");
    expect(source).toContain("A recoverable interruption does not create a new or smaller Work occurrence");
    expect(source).toContain("~/.companion/quest-journey-phases/work/leader.md");
    expect(source).toContain("owns the recovery-routing rule");
    expect(source).toContain("worker returns the compact Work handoff and stops the Work turn");
    expect(source).toContain("without waiting for Memory closure");
    expect(source).toContain("Ordinary read-only follow-up questions during Memory");
    expect(source).toContain("do not reopen the quest");
    expect(source).not.toContain("allow one short verification window");
    expect(source).not.toContain("exact-once replay proof and recovery-suppression boundaries remain authoritative");
    expect(source).not.toContain("`EXECUTING`");
    expect(source).not.toContain("`OUTCOME_REVIEWING`");
    expect(topLevelSource).toContain("Externally consequential User Checkpoints require fresh explicit approval");
    expect(topLevelSource).toContain("A material edit alone is not approval");
    expect(topLevelSource).toContain("One fresh reply may make one exact substitution");
    expect(topLevelSource).toContain("Otherwise fail closed, republish the exact packet");
    expect(topLevelSource).toContain("fresh explicit approval before external consequences");
    expect(topLevelSource).toContain("Harmless typo-only corrections can still proceed");
    expect(topLevelSource).toContain("Route read-only implementation follow-ups to context-rich sources");
    expect(topLevelSource).toContain("Report accepted Work before Memory closure");
    expect(topLevelSource).toContain("send final Memory to the normal same worker without waiting for closure");
    expect(topLevelSource).toContain("Ordinary read-only follow-ups during Memory use accepted evidence");
    expect(topLevelSource).toContain("Use direct worker errands only for tiny context-rich follow-ups");
    expect(topLevelSource).toContain("They create no quest, board row, claim, phase note, Memory closure");
    expect(topLevelSource).toContain("promote to a normal quest/Journey");
    expect(topLevelSource).toContain("accepted Work/Memory evidence before reopening source yourself");
    expect(topLevelSource).toContain("Do not create a quest or authorize changes for a clarification");
    expect(topLevelSource).toContain("System-interrupted worker events can be provisional");
    expect(topLevelSource).toContain("~/.companion/quest-journey-phases/work/leader.md");
    expect(topLevelSource).toContain("That brief owns the complete recovery rule");
    expect(topLevelSource).not.toContain("allow one short verification window");
    expect(topLevelSource).not.toContain("exact-once replay proof or recovery suppression");
  });

  it("keeps leader answer quality canonical while phase briefs own Work and Memory timing", async () => {
    const [orchestration, workLeader, memoryLeader, launcher] = await Promise.all([
      readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
      readFile(WORK_LEADER_BRIEF_PATH, "utf-8"),
      readFile(MEMORY_LEADER_BRIEF_PATH, "utf-8"),
      readFile(CLI_LAUNCHER_INSTRUCTIONS_PATH, "utf-8"),
    ]);

    expect(orchestration).toContain("retrieve or reread every listed user message");
    expect(orchestration).toContain("inspect every earlier visible valid answer");
    expect(orchestration).toContain("Prefer one self-contained explicit answer per user request");
    expect(orchestration).toContain("apply `explain-clearly`");
    expect(orchestration).toContain("complementary addition, correction, or material completion");
    expect(orchestration).toContain("Repeat IDs only when genuinely useful information requires");
    expect(orchestration).toContain("collapsed presentation shows the complete answer set together");
    expect(orchestration).toContain("Final Memory closure is commentary by default");

    expect(workLeader).toContain("normally carries the substantive `:A:<ids>` answer");
    expect(workLeader).toContain("canonical answer-quality rule in `takode-orchestration`");
    expect(memoryLeader).toContain("Report routine Memory completion as routed commentary/status");
    expect(memoryLeader).toContain("materially completes, corrects, or changes the prior response");

    expect(launcher).toContain("Before emitting \\`:A:<ids>\\`, retrieve or reread every listed user message");
    expect(launcher).toContain("Prefer one self-contained explicit answer per user request");
    expect(launcher).toContain("publish routine Memory closure with \\`[thread:q-N:C]\\`");
    for (const source of [orchestration, launcher]) {
      expect(source).not.toContain("Quest completion responses are answers");
      expect(source).not.toContain("publish the polished completion answer");
    }
  });

  it("keeps canonical design-to-build rules owned by the lifecycle guide", async () => {
    const [questDesign, leaderDispatch, orchestration, lifecycle] = await Promise.all([
      readFile(QUEST_DESIGN_SKILL_PATH, "utf-8"),
      readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH, "utf-8"),
    ]);

    expect(questDesign).toContain("one end-to-end `Goal / Acceptance` in one quest");
    expect(questDesign).toContain(
      "same-quest implementation, design-only closure, or a separate implementation successor",
    );
    expect(questDesign).toContain("apply the exception and active-successor rules");

    expect(leaderDispatch).toContain("Leaders own user intent and corrections");
    expect(leaderDispatch).toContain(
      "workers own technical Work and the guarded Work -> Memory transition with synchronized selected-target SHAs or explicit zero-code evidence",
    );
    expect(leaderDispatch).toContain("records and applies the user-approved continuation");
    expect(leaderDispatch).toContain("revises the title when it still reads as design-only");
    expect(leaderDispatch).toContain(
      "updates the description/TLDR when they no longer cover the full approved design-and-build scope",
    );
    expect(leaderDispatch).toContain("final Memory is only the backstop");
    expect(leaderDispatch).toContain("returns the current quest to its assigned worker in Work");
    expect(leaderDispatch).toContain("Apply the separation, reopening, and active-successor rules");
    expect(leaderDispatch).not.toContain("After Alignment, leaders own advancement.");
    expect(leaderDispatch).not.toContain("later decision or Execute phase");

    expect(orchestration).toContain("Do not split one design-and-build outcome at its checkpoint");
    expect(orchestration).toContain("reconcile a design-only title and any stale description/TLDR before Work resumes");
    expect(orchestration).toContain("Return the current quest to its assigned worker in Work after the decision");
    expect(orchestration).toContain("Apply the delivery-evidence checklist");
    expect(orchestration).toContain("not delivery evidence");

    // Keep full exception and evidence semantics in one lifecycle owner; hot-path skills
    // carry only their role-specific trigger plus a pointer to this guide.
    for (const source of [questDesign, leaderDispatch, orchestration]) {
      expect(source).toContain("quest-journey.md");
      expect(source).not.toContain("materially distinct risk or audit isolation");
      expect(source).not.toContain("synchronized commit or artifact evidence");
    }
    expect(lifecycle).toContain("genuinely optional or deferred work");
    expect(lifecycle).toContain("materially distinct risk or audit isolation");
    expect(lifecycle).toContain("valid implementation successor is already active");
    expect(lifecycle).toContain("reconcile the quest metadata before resuming Work");
    expect(lifecycle).toContain("revise the title when it still reads as design-only");
    expect(lifecycle).toContain("Do not defer this correction to final Memory");
    expect(lifecycle).toContain("synchronized commit or artifact evidence");
    expect(lifecycle).toContain("design-only or investigation quests may enter Memory");
  });

  it("keeps leader-created quest records intent-first without discarding useful context", async () => {
    // Source evidence should survive for worker grounding without becoming leader-invented binding scope.
    const [questDesign, leaderDispatch, orchestration] = await Promise.all([
      readFile(QUEST_DESIGN_SKILL_PATH, "utf-8"),
      readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
      readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
    ]);

    expect(questDesign).toContain("requirements and constraints the user supplied or confirmed");
    expect(questDesign).toContain("material a worker could not reasonably recover independently");
    expect(questDesign).toContain("Preserve leader analysis, examples, and possible approaches as non-binding context");
    expect(questDesign).toContain("Detailed investigation, planning, technical design, validation details");
    expect(questDesign).toContain("belong to Work unless the user confirmed them");
    expect(questDesign).toContain("only user-supplied, confirmed, or mandatory acceptance checks");

    expect(leaderDispatch).toContain("Follow `quest-design`'s authority boundary");
    expect(leaderDispatch).toContain("useful source evidence and intent-first worker context");
    expect(orchestration).toContain("Keep the quest record intent-first and self-contained");
    expect(orchestration).toContain("leave unconfirmed leader ideas and detailed planning to Work");
    expect(orchestration).toContain("The quest record still needs a concise local summary");

    for (const source of [questDesign, leaderDispatch, orchestration]) {
      expect(source).not.toContain("Keep detailed scope, evidence, acceptance criteria, non-goals");
      expect(source).not.toContain("Put detailed grounding, evidence, acceptance bullets, non-goals");
    }
  });

  it("keeps leader-authored worker-context authority in one complete owner", async () => {
    const [leaderDispatch, questDesign, orchestration, journey, workLeader, workAssignee, phaseExamples, launcher] =
      await Promise.all([
        readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
        readFile(QUEST_DESIGN_SKILL_PATH, "utf-8"),
        readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
        readFile(TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH, "utf-8"),
        readFile(WORK_LEADER_BRIEF_PATH, "utf-8"),
        readFile(WORK_ASSIGNEE_BRIEF_PATH, "utf-8"),
        readFile(LEADER_DISPATCH_PHASE_HANDOFF_EXAMPLES_PATH, "utf-8"),
        readFile(CLI_LAUNCHER_INSTRUCTIONS_PATH, "utf-8"),
      ]);

    const completeRuleMarkers = [
      "Preserve source authority in every leader-authored worker context",
      "Persistence, a leader label, or Alignment approval does not make a requirement user-approved",
      "Do not promote leader synthesis into accepted scope",
      "Leader-inferred product behavior, implementation approaches, test seams, failure policies, validators, thresholds, and hard gates",
    ];

    for (const marker of completeRuleMarkers) {
      expect(leaderDispatch).toContain(marker);
      for (const pointerOnlySource of [
        questDesign,
        orchestration,
        journey,
        workLeader,
        workAssignee,
        phaseExamples,
        launcher,
      ]) {
        expect(pointerOnlySource).not.toContain(marker);
      }
    }

    expect(leaderDispatch).toContain("recording or forwarding substantive human feedback");
    expect(leaderDispatch).toContain("phase handoffs, corrections, recovery steering");
    expect(workLeader).toContain(
      "Alignment approval confirms the worker's understanding of the authorized scope and the intended Journey routing",
    );
    expect(workLeader).toContain(
      "by itself it does not promote worker findings, leader paraphrases, or proposed approaches into requirements",
    );
    expect(workLeader).toContain("complete worker-context authority rule in the preloaded `leader-dispatch` skill");
    expect(workLeader).not.toContain("--author human");
    expect(launcher).toContain("complete worker-context authority rule in the preloaded");
    expect(launcher).toContain("leader-dispatch");

    for (const naturalHandoffSource of [leaderDispatch, workLeader, phaseExamples, launcher]) {
      expect(naturalHandoffSource).not.toContain("Leader-only deltas");
    }
    expect(phaseExamples).not.toContain("Leader-specific deltas:");
  });

  it("keeps the complete Work recovery rule owned by the canonical leader brief", async () => {
    const [leaderBrief, assigneeBrief, leaderDispatch, orchestration, journey, launcher, recoveryPrompts] =
      await Promise.all([
        readFile(WORK_LEADER_BRIEF_PATH, "utf-8"),
        readFile(WORK_ASSIGNEE_BRIEF_PATH, "utf-8"),
        readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
        readFile(TAKODE_ORCHESTRATION_SKILL_PATH, "utf-8"),
        readFile(TAKODE_ORCHESTRATION_QUEST_JOURNEY_PATH, "utf-8"),
        readFile(CLI_LAUNCHER_INSTRUCTIONS_PATH, "utf-8"),
        readFile(COMPACTION_RECOVERY_PROMPTS_PATH, "utf-8"),
      ]);

    const completeRuleMarkers = [
      "Recovery preserves the full remaining authorized Work envelope",
      "allow one short verification window",
      "interrupt the stale turn",
      "do not override Takode's exact-once replay proof or recovery suppression",
    ];

    expect(leaderBrief).toContain("authoritative source for recovery routing inside an active Work occurrence");
    for (const marker of completeRuleMarkers) {
      expect(leaderBrief).toContain(marker);
      for (const pointerOnlySource of [
        assigneeBrief,
        leaderDispatch,
        orchestration,
        journey,
        launcher,
        recoveryPrompts,
      ]) {
        expect(pointerOnlySource).not.toContain(marker);
      }
    }

    expect(assigneeBrief).not.toContain("recovery pending");
    for (const pointerSource of [leaderDispatch, orchestration, journey, recoveryPrompts]) {
      expect(pointerSource).toContain("~/.companion/quest-journey-phases/work/leader.md");
    }
    expect(launcher).toContain('getQuestJourneyPhaseLeaderBriefDisplayPath("work")');
  });

  it("keeps leader dispatch hot path compact while preserving handoff references", async () => {
    const [source, edgeCases, phaseExamples, worktreeRules] = await Promise.all([
      readFile(LEADER_DISPATCH_SKILL_PATH, "utf-8"),
      readFile(LEADER_DISPATCH_EDGE_CASES_PATH, "utf-8"),
      readFile(LEADER_DISPATCH_PHASE_HANDOFF_EXAMPLES_PATH, "utf-8"),
      readFile(WORKTREE_RULES_SKILL_PATH, "utf-8"),
    ]);

    expect(source).toContain("This section is the visible reference catalog");
    expect(source).toContain("ordinary Markdown reference headings are not loaded until you read the file");
    expect(source).toContain("references/edge-cases.md");
    expect(source).toContain("memory-specific handoff/completion deltas");
    expect(source).toContain("references/phase-handoff-examples.md");
    expect(source).toContain("direct worker errand");
    expect(source).toContain("Dispatch Approval Rubric");
    expect(source).toContain("Direct create/dispatch is allowed only when");
    expect(source).toContain("Pre-dispatch approval is mandatory when");
    expect(source).toContain("Use delayed approval via User Checkpoint");
    expect(source).toContain("Externally consequential User Checkpoints need fresh explicit approval");
    expect(source).toContain("A material edit alone is not approval");
    expect(source).toContain('"Change the batch limit to 120" is edit-only');
    expect(source).toContain('"Approve the bounded operation with batch limit 120" may approve');
    expect(source).toContain("ambiguous referents; dependent changes");
    expect(source).toContain("changed monitor/stop conditions, safety implications, consequences, or tradeoffs");
    expect(source).toContain("all require republishing and reapproval");
    expect(source).toContain("Harmless typo-only corrections can be recorded");
    // Dispatch owns the authority/checkpoint rule while the decision skill owns presentation.
    expect(source).toContain("Separate access and authority safety from payload transformation");
    expect(source).toContain("protected access method does not by itself make the payload secret");
    expect(source).toContain("explicit User Checkpoint decision");
    expect(source).toContain("Evidence can justify a transformation; it does not by itself authorize broader scope");
    expect(source).toContain("Normal non-transforming safeguards remain mandatory");
    expect(source).toContain("Send this only after authorization and board recording:");
    expect(source).not.toContain("Send this only after approval and board recording:");
    expect(source).toContain("Read this phase brief first:");
    expect(source).toContain("short natural Work authorization is sufficient");
    expect(source).not.toContain("Leader-only deltas");
    expect(source).toContain("Do not convert the worker-authored Alignment note into a Work prompt");
    expect(source).toContain("For read-only implementation follow-ups");
    expect(source).toContain("Direct Worker Errands");
    expect(source).toContain("one-turn, context-rich, read-only follow-ups");
    expect(source).toContain("The audit trail is the ordinary session/thread history");
    expect(source).toContain("Fail closed");
    expect(source).toContain("route to the context-rich source before re-deriving technical details");
    expect(source).toContain("accepted Work/Memory note, before reopening source yourself");
    expect(source).toContain("Do not create a new quest or authorize code changes for a clarification");
    expect(source).toContain("Provide only genuinely useful context the assignee cannot infer");
    expect(source).toContain("For recovery of an active Work occurrence");
    expect(source).toContain("~/.companion/quest-journey-phases/work/leader.md");
    expect(source).toContain("it owns the complete rule");
    expect(source).not.toContain("allow one short verification window");
    expect(source).not.toContain(
      "Existing exact-once replay proof and recovery-suppression rules remain authoritative",
    );
    expect(source).not.toContain("Memory command mechanics live in the relevant phase briefs");

    expect(edgeCases).toContain("## Memory-Specific Dispatch Deltas");
    expect(edgeCases).toContain("Final Memory owns durable-state closure");
    expect(edgeCases).toContain("Do not require routine `memory update not needed` statements");
    expect(edgeCases).not.toContain("Read this reference only when");

    expect(phaseExamples).toContain("## Work");
    expect(phaseExamples).toContain("## Direct Worker Errand");
    expect(phaseExamples).toContain("Quick direct errand, not a Quest Journey");
    expect(phaseExamples).toContain("promoted to a normal quest");
    expect(phaseExamples).toContain("Alignment approved. Proceed with Work");
    expect(phaseExamples).toContain("That is sufficient when no new context exists");
    expect(phaseExamples).toContain("write it naturally and keep it narrow");
    expect(phaseExamples).not.toContain("Leader-only deltas");
    expect(phaseExamples).not.toContain("Leader-specific deltas:");
    expect(phaseExamples).toContain("## Memory");
    expect(phaseExamples).toContain("## Separate Review Quest");
    expect(phaseExamples).not.toContain("Read this reference only when");

    expect(worktreeRules).toContain("Do not silently narrow the gate to focused tests");
    expect(worktreeRules).toContain("route the worker back to fix it before the quest can be marked done");
    expect(worktreeRules).toContain("open an immediate fix quest");
  });

  it("keeps skeptic-review summary creation guidance from teaching lossy long summaries", async () => {
    const source = await readFile(SKEPTIC_REVIEW_SKILL_PATH, "utf-8");

    expect(source).toContain('quest feedback add <quest_id> --text "Summary: ..."');
    expect(source).toContain("--text-file /tmp/summary.md");
    expect(source).toContain("--tldr-file /tmp/summary-tldr.md");
    expect(source).toContain("for long multi-topic content");
  });

  it("keeps worktree port guidance responsible for final Memory handoff context", async () => {
    const source = await readFile(WORKTREE_RULES_SKILL_PATH, "utf-8");

    // /port-changes owns sync evidence, but final Memory owns durable closure.
    expect(source).toContain("Run the required pre-push gate");
    expect(source).toContain("For tracked code/test changes, verify the main repo before pushing");
    expect(source).toContain("focused affected tests for the accepted change");
    expect(source).toContain("cd <BASE_REPO>/web && bun --no-install run test");
    expect(source).toContain("Do not silently narrow the gate to focused tests");
    expect(source).toContain("do not push");
    expect(source).toContain("open an immediate fix quest");
    expect(source).toContain('takode board work-to-memory q-N --work-note <feedback-index> --commits "sha1,sha2"');
    expect(source).toContain("takode board work-to-memory q-N --work-note <feedback-index> --no-code");
    expect(source).toContain("Sync/push is not final quest closure");
    expect(source).toContain("Final Memory still owns final User review check settlement");
    expect(source).toContain("structured final debrief metadata");
    expect(source).toContain("Final debrief draft:");
    expect(source).toContain("Debrief TLDR draft:");
    expect(source).toContain("accepted-state summary");
    expect(source).toContain("Do not add routine `memory update not needed` statements during Work-owned sync");
    expect(source).toContain("self-contained quest-journey understanding");
    expect(source).toContain("Keep routine commit hashes, branch names, command lists");
  });

  it("documents the full gate for tracked code/test changes in quest-facing guidance", async () => {
    const docs = await Promise.all([
      readFile(join(REPO_ROOT, "CLAUDE.md"), "utf-8"),
      readFile(join(REPO_ROOT, "AGENTS.md"), "utf-8"),
      readFile(QUEST_SKILL_TEMPLATE_PATH, "utf-8"),
    ]);

    for (const doc of docs) {
      expect(doc).toContain("For tracked code/test changes");
      expect(doc).toContain("cd web && bun --no-install run typecheck");
      expect(doc).toContain("cd web && bun --no-install run test");
      expect(doc).toContain("cd web && bun --no-install run format:check");
      expect(doc).not.toContain("For refactor quests");
    }
  });
});
