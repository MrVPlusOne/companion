import { describe, expect, it } from "vitest";
import { buildCodexInstructionSnapshot, normalizeCodexInstructionPath } from "./codex-instruction-snapshot.js";

describe("Codex instruction snapshots", () => {
  it("normalizes macOS private temp aliases before classifying launcher-known global copies", () => {
    expect(normalizeCodexInstructionPath("/private/tmp/takode/home/AGENTS.md", "darwin")).toBe(
      "/tmp/takode/home/AGENTS.md",
    );
    expect(normalizeCodexInstructionPath("/private/var/folders/test/AGENTS.md", "darwin")).toBe(
      "/var/folders/test/AGENTS.md",
    );
    expect(normalizeCodexInstructionPath("/private/tmp/takode/home/AGENTS.md", "linux")).toBe(
      "/private/tmp/takode/home/AGENTS.md",
    );
  });

  it("preserves provider order and classifies only launcher-known global copies", () => {
    const snapshot = buildCodexInstructionSnapshot({
      threadId: "thread-1",
      capturedAt: 123,
      lifecycle: "thread_start",
      instructionSources: ["/session-home/AGENTS.md", "/repo/AGENTS.md", "/repo/packages/app/AGENTS.override.md", ""],
      instructionContext: {
        globalSources: [
          {
            loadedPath: "/session-home/AGENTS.md",
            sourcePath: "/Users/me/.codex/AGENTS.md",
            delivery: "copied_snapshot",
          },
        ],
        configLayers: [{ kind: "user", path: "/session-home/config.toml" }],
      },
      developerInstructionsConfigured: true,
    });

    expect(snapshot.instructionSourcesReported).toBe(true);
    expect(snapshot.instructionSources).toEqual([
      {
        path: "/session-home/AGENTS.md",
        kind: "global",
        sourcePath: "/Users/me/.codex/AGENTS.md",
        delivery: "copied_snapshot",
      },
      { path: "/repo/AGENTS.md", kind: "project", delivery: "direct" },
      { path: "/repo/packages/app/AGENTS.override.md", kind: "project", delivery: "direct" },
    ]);
  });

  it("distinguishes an unsupported field from an authoritative empty source list", () => {
    const base = {
      threadId: "thread-1",
      capturedAt: 123,
      lifecycle: "thread_resume" as const,
      developerInstructionsConfigured: false,
    };
    expect(buildCodexInstructionSnapshot({ ...base, instructionSources: undefined }).instructionSourcesReported).toBe(
      false,
    );
    expect(buildCodexInstructionSnapshot({ ...base, instructionSources: [] })).toMatchObject({
      instructionSourcesReported: true,
      instructionSources: [],
    });
  });
});
