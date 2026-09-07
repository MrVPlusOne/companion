import { describe, expect, it } from "vitest";
import { applyCodexSessionIdentity } from "./codex-launcher-session-state.js";
import type { SdkSessionInfo } from "./session-info.js";

function session(): SdkSessionInfo {
  return {
    sessionId: "session-1",
    state: "connected",
    cwd: "/repo",
    createdAt: 1,
    backendType: "codex",
    codexLeaderRecycleLineage: { cliSessionIds: ["thread-old"], recycleEvents: [] },
  };
}

describe("Codex launcher session metadata", () => {
  it("stores thread identity and its instruction snapshot atomically", () => {
    const current = session();
    applyCodexSessionIdentity(current, "thread-new", {
      threadId: "thread-new",
      capturedAt: 123,
      lifecycle: "thread_resume",
      instructionSourcesReported: true,
      instructionSources: [{ path: "/repo/AGENTS.md", kind: "project", delivery: "direct" }],
      configLayers: [{ kind: "user", path: "/session/config.toml" }],
      developerInstructionsConfigured: true,
    });

    expect(current.cliSessionId).toBe("thread-new");
    expect(current.codexInstructionSnapshot).toMatchObject({ threadId: "thread-new", lifecycle: "thread_resume" });
    expect(current.codexLeaderRecycleLineage?.cliSessionIds).toEqual(["thread-old", "thread-new"]);
  });
});
