import { describe, expect, it } from "vitest";
import { stripInternalLauncherSessionState, type SdkSessionInfo } from "./session-info.js";

function launcherInfo(overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: "session-public-contract",
    state: "connected",
    cwd: "/repo",
    createdAt: 1,
    model: "gpt-5.6",
    backendType: "codex",
    permissionMode: "default",
    askPermission: true,
    isWorktree: true,
    repoRoot: "/repo",
    branch: "jiayi",
    actualBranch: "jiayi-wt-1",
    ...overrides,
  };
}

describe("public launcher session serialization", () => {
  it("keeps public configuration while omitting internal paths, secrets, and recovery state", () => {
    const result = stripInternalLauncherSessionState({
      ...launcherInfo({
        sessionAuthToken: "secret-token",
        codexWorkerV2Cutover: { status: "pending" } as never,
        codexHome: "/private/codex-home",
        blockedEnvKeys: ["TAKODE_ROLE"],
        resumeAt: "provider-history-id",
        sdkDebugLogPath: "/private/sdk-debug.log",
        injectedSystemPrompt: "private injected prompt",
        codexContextWindowDiagnostics: { role: "non_leader", capacitySource: "codex_default" },
        codexInstructionSnapshot: {
          threadId: "thread-private",
          capturedAt: 2,
          lifecycle: "thread_start",
          instructionSourcesReported: true,
          instructionSources: [{ path: "/repo/AGENTS.md", kind: "project", delivery: "direct" }],
          configLayers: [{ kind: "user", path: "/private/codex-home/config.toml" }],
          developerInstructionsConfigured: true,
        },
      }),
      leaderOpenThreadTabs: {
        version: 1,
        orderedOpenThreadKeys: ["q-internal"],
        closedThreadTombstones: [],
        updatedAt: 1,
      },
      leaderThreadStatuses: { "q-internal": { kind: "ready" } },
    } as SdkSessionInfo);

    expect(result).toMatchObject({
      sessionId: "session-public-contract",
      model: "gpt-5.6",
      backendType: "codex",
      permissionMode: "default",
      askPermission: true,
      repoRoot: "/repo",
      branch: "jiayi",
      actualBranch: "jiayi-wt-1",
    });
    for (const field of [
      "sessionAuthToken",
      "codexWorkerV2Cutover",
      "codexHome",
      "blockedEnvKeys",
      "resumeAt",
      "sdkDebugLogPath",
      "injectedSystemPrompt",
      "codexContextWindowDiagnostics",
      "codexInstructionSnapshot",
      "leaderOpenThreadTabs",
      "leaderThreadStatuses",
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("reveals only explicitly requested debug payloads without reopening internal launcher fields", () => {
    const result = stripInternalLauncherSessionState(
      launcherInfo({
        codexHome: "/private/codex-home",
        sdkDebugLogPath: "/private/sdk-debug.log",
        injectedSystemPrompt: "requested injected prompt",
        codexContextWindowDiagnostics: { role: "non_leader", capacitySource: "codex_default" },
        codexInstructionSnapshot: {
          threadId: "thread-requested",
          capturedAt: 2,
          lifecycle: "thread_resume",
          instructionSourcesReported: true,
          instructionSources: [],
          configLayers: [],
          developerInstructionsConfigured: true,
        },
      }),
      {
        includeInjectedSystemPrompt: true,
        includeCodexContextWindowDiagnostics: true,
        includeCodexInstructionSnapshot: true,
      },
    );

    expect(result.injectedSystemPrompt).toBe("requested injected prompt");
    expect(result.codexContextWindowDiagnostics).toMatchObject({ capacitySource: "codex_default" });
    expect(result.codexInstructionSnapshot).toMatchObject({ threadId: "thread-requested", lifecycle: "thread_resume" });
    expect(result).not.toHaveProperty("codexHome");
    expect(result).not.toHaveProperty("sdkDebugLogPath");
  });
});
