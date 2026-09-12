import { describe, expect, it } from "vitest";
import { CliLauncher } from "./cli-launcher.js";
import { getOrchestratorGuardrails } from "./cli-launcher-instructions.js";

describe("CliLauncher.getOrchestratorGuardrails", () => {
  it.each([
    undefined,
    "claude",
    "claude-sdk",
    "codex",
  ] as const)("forwards the %s backend to the canonical builder", (backend) => {
    // This stateless facade must preserve backend selection. Calling it on the
    // prototype avoids unrelated process and filesystem fixtures.
    expect(CliLauncher.prototype.getOrchestratorGuardrails(backend)).toBe(getOrchestratorGuardrails(backend));
  });
});
