import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

describe("Work-to-Memory code evidence guidance", () => {
  it("keeps the orchestration design rubric on active-v2 Work ownership", () => {
    const design = read(".claude/skills/takode-orchestration-design/SKILL.md");

    expect(design).toContain("guarded transition-time SHA attachment before Memory");
    expect(design).not.toContain("Execute assignees should");
    expect(design).not.toContain("Port assignees should");
  });

  it("keeps copyable orchestration commands evidence-complete", () => {
    const journey = read(".claude/skills/takode-orchestration/quest-journey.md");
    const boardUsage = read(".claude/skills/takode-orchestration/board-usage.md");
    const leaderDispatch = read(".claude/skills/leader-dispatch/SKILL.md");

    for (const source of [journey, boardUsage, leaderDispatch]) {
      expect(source).toContain("--commits");
      expect(source).toContain("--no-code");
    }

    expect(journey).toContain("Every Work occurrence, including rework, must supply its own fresh transition evidence");
    expect(journey).toContain('--work-note <feedback-index> --commits "sha1,sha2"');
    expect(journey).toContain("--work-note <feedback-index> --no-code");
    expect(journey).toContain("commit count and diff controls are available as soon as Memory begins");
    expect(boardUsage).toContain("Older stored commits do not replace fresh evidence for a rework occurrence");
    expect(boardUsage).toContain("takode board replace-work-evidence");
    expect(boardUsage).toContain("expected ordered list must exactly match current storage");
    expect(boardUsage).toContain("does not advance the Journey");
  });

  it("keeps Memory deltas and completion guidance from first-attaching Work commits", () => {
    const handoffs = read(".claude/skills/leader-dispatch/references/phase-handoff-examples.md");
    const edgeCases = read(".claude/skills/leader-dispatch/references/edge-cases.md");
    const memoryCompletion = read("web/server/templates/quest-memory-completion.md");

    expect(handoffs).not.toContain("Leader-specific deltas: <synced SHAs");
    expect(handoffs).toContain("missing code evidence routes back to Work");
    expect(edgeCases).toContain("do not send synchronized Work SHAs as a Memory delta");
    expect(memoryCompletion).toContain(
      "Final Memory verifies that tracked Work SHAs are already structured quest metadata",
    );
    expect(memoryCompletion).toContain("memory-repository commits during final Memory");
    expect(memoryCompletion).not.toContain("Final Memory or the leader attaches those SHAs");
  });

  it("keeps optional and taken checkpoint routing behind the right boundary", () => {
    const journey = read(".claude/skills/takode-orchestration/quest-journey.md");
    const boardUsage = read(".claude/skills/takode-orchestration/board-usage.md");
    const workBrief = read("web/shared/quest-journey-phases/work/assignee.md");
    const checkpointBrief = read("web/shared/quest-journey-phases/user-checkpoint/leader.md");

    expect(journey).toContain("direct optional suffix `[work, user-checkpoint, memory]`");
    expect(journey).toContain('--skip-optional-checkpoint "<reason>"');
    expect(journey).toContain("the reason is recorded");
    expect(boardUsage).toContain("Generic `board advance` cannot skip directly from Work into Memory");
    expect(workBrief).toContain("must continue into a later Work occurrence before Memory");
    expect(checkpointBrief).toContain("revise the remaining Journey to `[user-checkpoint, work, memory]`");
  });
});
