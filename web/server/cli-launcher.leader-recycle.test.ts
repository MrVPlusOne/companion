import { describe, expect, it } from "vitest";
import { CliLauncher } from "./cli-launcher.js";
import type { SdkSessionInfo } from "./session-info.js";

function fixture(overrides: Partial<SdkSessionInfo> = {}) {
  // No store or process is attached: exercise real preparation entirely in memory.
  const launcher = new CliLauncher(0);
  const session: SdkSessionInfo = {
    sessionId: "leader",
    state: "connected",
    cwd: "/repo",
    createdAt: 1,
    backendType: "codex",
    isOrchestrator: true,
    cliSessionId: "original-thread",
    codexLeaderCompactionMode: "compact",
    ...overrides,
  };
  (launcher as unknown as { sessions: Map<string, SdkSessionInfo> }).sessions.set(session.sessionId, session);
  return { launcher, session };
}

describe("explicit Codex leader recycling", () => {
  it.each(["compact", "recycle"] as const)("recycles once without changing %s mode", (mode) => {
    const { launcher, session } = fixture({ codexLeaderCompactionMode: mode });
    expect(launcher.prepareCodexLeaderRecycle("leader", { trigger: "manual_recycle" })).toEqual({ ok: true });
    expect(session.cliSessionId).toBeUndefined();
    expect(session.codexLeaderCompactionMode).toBe(mode);
    expect(session.codexLeaderRecycleLineage?.cliSessionIds).toEqual(["original-thread"]);
    expect(session.codexLeaderRecycleLineage?.recycleEvents).toEqual([
      expect.objectContaining({ trigger: "manual_recycle", previousCliSessionId: "original-thread" }),
    ]);
    expect(session.codexLeaderRecyclePending).toMatchObject({ eventIndex: 0, trigger: "manual_recycle" });

    // A repeated request during replacement must not create a second recycle.
    expect(launcher.prepareCodexLeaderRecycle("leader", { trigger: "manual_recycle" })).toEqual({ ok: true });
    expect(session.codexLeaderRecycleLineage?.recycleEvents).toHaveLength(1);
    launcher.setCLISessionId("leader", "replacement-thread");
    launcher.completeCodexLeaderRecycle("leader");
    expect(session.codexLeaderRecycleLineage?.cliSessionIds).toEqual(["original-thread", "replacement-thread"]);
    expect(session.codexLeaderRecyclePending).toBeNull();
    expect(session.codexLeaderCompactionMode).toBe(mode);
  });

  it.each([
    "threshold",
    "context_window_exhausted",
    "manual_compact",
  ] as const)("keeps %s gated in compact mode", (trigger) => {
    // Only the new explicit command bypasses policy, not automatic or legacy triggers.
    const { launcher, session } = fixture();
    expect(launcher.prepareCodexLeaderRecycle("leader", { trigger }).ok).toBe(false);
    expect(session.cliSessionId).toBe("original-thread");
    expect(session.codexLeaderRecycleLineage).toBeUndefined();
  });

  it.each([
    { isOrchestrator: false },
    { backendType: "claude" },
    { backendType: "claude-sdk" },
  ] as const)("refuses unsupported sessions: %j", (overrides) => {
    const { launcher, session } = fixture(overrides);
    expect(launcher.prepareCodexLeaderRecycle("leader", { trigger: "manual_recycle" }).ok).toBe(false);
    expect(session.cliSessionId).toBe("original-thread");
    expect(session.codexLeaderRecycleLineage).toBeUndefined();
  });
});
