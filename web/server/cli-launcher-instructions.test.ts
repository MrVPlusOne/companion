import { describe, expect, it } from "vitest";
import {
  buildCompanionInstructions,
  buildInjectedSystemPromptForDebug,
  getOrchestratorGuardrails,
} from "./cli-launcher-instructions.js";
import { TAKODE_LINK_SYNTAX_INSTRUCTIONS } from "./link-syntax.js";
import { QUEST_JOURNEY_PHASES } from "../shared/quest-journey.js";
import {
  getQuestJourneyPhaseAssigneeBriefDisplayPath,
  getQuestJourneyPhaseLeaderBriefDisplayPath,
} from "./quest-journey-phases.js";

describe("buildCompanionInstructions", () => {
  it.each([
    undefined,
    "claude",
    "claude-sdk",
    "codex",
  ] as const)("selects backend-specific sections for %s", (backend) => {
    // Section presence tests backend selection without freezing the rules inside.
    const result = buildCompanionInstructions({ backend });
    expect(result.includes("## Responding to Leaders")).toBe(backend !== "codex");
    expect(result.includes("## Native Computer Use")).toBe(backend === "codex");
  });

  it("includes session identity only when a session number is supplied", () => {
    // The identity is launch data, not a shared example's session number.
    expect(buildCompanionInstructions({ sessionNum: 42 })).toContain("You are Takode session #42.");
    expect(buildCompanionInstructions()).not.toContain("## Session Identity");
  });

  it.each([
    "claude",
    "claude-sdk",
    "codex",
  ] as const)("includes the canonical shared link section in ordinary and leader %s prompts", (backend) => {
    // Catch omitted or truncated sections across roles/projects. Wording changes
    // update the canonical source only; this is an assembly contract.
    expect(TAKODE_LINK_SYNTAX_INSTRUCTIONS.trim()).not.toBe("");
    const prompts = [
      buildCompanionInstructions({ backend }),
      buildInjectedSystemPromptForDebug({
        backend,
        isOrchestrator: true,
        worktree: { branch: "feature", repoRoot: "/projects/example" },
      }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain(`## Link Syntax\n\n${TAKODE_LINK_SYNTAX_INSTRUCTIONS}`);
    }
  });

  it("keeps copyable native link examples in supported URI syntax", () => {
    // The frontend interprets these URI grammars. Do not freeze example IDs or
    // surrounding instructions, but catch malformed or retired link syntax.
    expect(TAKODE_LINK_SYNTAX_INSTRUCTIONS).toMatch(/\[q-\d+ feedback #\d+\]\(quest:q-\d+:feedback:\d+\)/);
    expect(TAKODE_LINK_SYNTAX_INSTRUCTIONS).not.toMatch(/quest:q-\d+#feedback-/);
    expect(TAKODE_LINK_SYNTAX_INSTRUCTIONS).toMatch(/\[[^\]]+\]\(file:[^)]+:\d+\)/);
  });

  it("includes worktree guardrails when worktree is provided", () => {
    const result = buildCompanionInstructions({
      worktree: { branch: "test-branch", repoRoot: "/repo" },
    });
    expect(result).toContain("Worktree Session");
    expect(result).toContain("test-branch");
    expect(result).toContain("Base branch / port target: `test-branch`");
  });

  it("uses explicit worktree port target in sync context", () => {
    const result = buildCompanionInstructions({
      worktree: {
        branch: "leader-target-wt-1234-wt-5678",
        parentBranch: "leader-target-wt-1234",
        repoRoot: "/repo",
        portTarget: {
          repoRoot: "/repo",
          branch: "leader-target-wt-1234",
          worktreePath: "/worktrees/repo/leader-target-wt-1234",
          sourceSessionNum: 7,
          sourceLabel: "#7 Leader WT",
        },
      },
    });

    expect(result).toContain("leader-target-wt-1234-wt-5678");
    expect(result).toContain("Base branch / port target: `leader-target-wt-1234`");
    expect(result).toContain("Port target worktree: `/worktrees/repo/leader-target-wt-1234`");
    expect(result).toContain("Port target source: #7 Leader WT");
  });

  it("renders explicit leader worktree targets from worker sync metadata", () => {
    const result = buildCompanionInstructions({
      worktree: {
        branch: "main-wt-5892-wt-6573",
        parentBranch: "main-wt-5892",
        repoRoot: "/Users/jiayiwei/Code/yolo",
        portTarget: {
          repoRoot: "/Users/jiayiwei/Code/yolo",
          branch: "main-wt-5892",
          worktreePath: "/Users/jiayiwei/.companion/worktrees/yolo/main-wt-5892",
          sourceSessionNum: 2468,
          sourceLabel: "#2468 QA Data Leader",
        },
      },
    });

    expect(result).toContain("Base repo checkout: `/Users/jiayiwei/Code/yolo`");
    expect(result).toContain("Base branch / port target: `main-wt-5892`");
    expect(result).toContain("Port target worktree: `/Users/jiayiwei/.companion/worktrees/yolo/main-wt-5892`");
    expect(result).toContain("Port target source: #2468 QA Data Leader");
  });

  it("appends caller instructions unchanged", () => {
    // Caller-provided content must survive composition, including its own markup.
    const extraInstructions = "Custom context\n`literal syntax` and **formatting**";
    expect(buildCompanionInstructions({ extraInstructions }).endsWith(extraInstructions)).toBe(true);
  });
});

describe("getOrchestratorGuardrails", () => {
  it("defaults to the Claude family and shares that selection with Claude SDK", () => {
    expect(getOrchestratorGuardrails()).toBe(getOrchestratorGuardrails("claude"));
    expect(getOrchestratorGuardrails("claude-sdk")).toBe(getOrchestratorGuardrails("claude"));
  });

  it("selects the tool invocation syntax supported by each backend", () => {
    // A swapped backend branch would teach calls to unavailable tools. These
    // exact tool/argument tokens are intentional contracts, not prose preferences.
    const claude = getOrchestratorGuardrails("claude");
    const codex = getOrchestratorGuardrails("codex");
    expect(claude).toContain("run_in_background: true");
    expect(claude).not.toContain("delegate_task(task)");
    expect(codex).toContain("delegate_task(task)");
    expect(codex).not.toContain("run_in_background: true");
  });

  it.each(["claude", "codex"] as const)("assembles the current phase catalog into %s guidance", (backend) => {
    // Paths and board states must follow the live catalog instead of stale copied
    // phase data; the prose of each phase remains owned by its canonical source.
    const result = getOrchestratorGuardrails(backend);
    for (const phase of QUEST_JOURNEY_PHASES) {
      expect(result).toContain(`| ${phase.label} | \`${phase.boardState}\` |`);
      expect(result).toContain(getQuestJourneyPhaseLeaderBriefDisplayPath(phase.id));
      expect(result).toContain(getQuestJourneyPhaseAssigneeBriefDisplayPath(phase.id));
    }
  });
});

describe("buildInjectedSystemPromptForDebug", () => {
  it.each(["claude", "claude-sdk", "codex"] as const)("adds leader guardrails only to %s leaders", (backend) => {
    // Exercise the same composition used for offline inspection: role selection
    // must include the complete backend-specific section and preserve append order.
    const guardrails = getOrchestratorGuardrails(backend);
    const worker = buildInjectedSystemPromptForDebug({ sessionNum: 8, backend });
    const leader = buildInjectedSystemPromptForDebug({ sessionNum: 8, backend, isOrchestrator: true });
    expect(worker).toBe(buildCompanionInstructions({ sessionNum: 8, backend }));
    expect(worker).not.toContain("## Leader Thread Routing");
    expect(leader.endsWith(guardrails)).toBe(true);
    expect(leader.includes("## Native Computer Use")).toBe(backend === "codex");
  });

  it("preserves caller context after the selected leader guardrails", () => {
    const extraInstructions = "Context for this launch\nKeep `source text` intact.";
    const result = buildInjectedSystemPromptForDebug({ backend: "codex", isOrchestrator: true, extraInstructions });
    expect(result.endsWith(`${getOrchestratorGuardrails("codex")}\n\n${extraInstructions}`)).toBe(true);
  });
});
