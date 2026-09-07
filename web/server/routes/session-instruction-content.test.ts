import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MAX_INSTRUCTION_CONTENT_BYTES } from "../../shared/codex-instruction-content.js";
import { buildCodexInstructionSnapshot } from "../codex-instruction-snapshot.js";
import type { SdkSessionInfo } from "../session-info.js";
import { registerSessionInstructionContentRoute } from "./session-instruction-content.js";

function setup() {
  // Start with the same ordered string paths reported by thread/start, not a frontend-invented source shape.
  const snapshot = buildCodexInstructionSnapshot({
    threadId: "provider-thread-a",
    capturedAt: 100,
    lifecycle: "thread_start",
    instructionSources: ["/isolated/AGENTS.md", "/repo/AGENTS.md"],
    developerInstructionsConfigured: true,
  });
  snapshot.contents = {
    generated: { content: "Captured generated guidance" },
    sources: [{ content: "Captured global guidance" }, { content: "Captured repository guidance" }],
  };
  const session: SdkSessionInfo = {
    sessionId: "session-a",
    backendType: "codex",
    cliSessionId: snapshot.threadId,
    state: "connected",
    cwd: "/repo",
    createdAt: 1,
    codexInstructionSnapshot: snapshot,
    injectedSystemPrompt: "Newer generated content must not replace the captured body",
    sessionAuthToken: "private-auth-token",
  };
  const app = new Hono();
  const getSession = vi.fn((id: string) => (id === "session-a" ? session : undefined));
  registerSessionInstructionContentRoute(app, {
    launcher: { getSession },
    resolveId: (id: string) => id,
  });
  const request = (
    source = "0",
    threadId = snapshot.threadId,
    capturedAt = snapshot.capturedAt,
    sessionId = session.sessionId,
  ) =>
    app.request(
      `/sessions/${sessionId}/instruction-content?${new URLSearchParams({ source, threadId, capturedAt: String(capturedAt) })}`,
    );
  return { app, session, snapshot, request, getSession };
}

describe("captured Codex instruction content route", () => {
  it("returns exactly the selected saved source and never the current generated prompt", async () => {
    const { request } = setup();
    for (const [source, content] of [
      ["generated", "Captured generated guidance"],
      ["0", "Captured global guidance"],
      ["1", "Captured repository guidance"],
    ]) {
      const response = await request(source);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ threadId: "provider-thread-a", capturedAt: 100, source, content });
    }
  });

  it("rejects stale thread, capture epoch, and wrong-session selections", async () => {
    const { request, session } = setup();
    expect((await request("0", "provider-thread-b")).status).toBe(409);
    expect((await request("0", "provider-thread-a", 99)).status).toBe(409);
    expect((await request("0", "provider-thread-a", 100, "session-b")).status).toBe(404);
    session.cliSessionId = "replacement-thread";
    expect((await request()).status).toBe(409);
  });

  it("does not accept paths or out-of-snapshot source indices", async () => {
    const { request } = setup();
    // No filesystem-read capability is exposed by this endpoint, even for credential-looking paths.
    for (const source of [
      "/private/auth.json",
      "../config.toml",
      "-1",
      "2",
      "00",
      "1.0",
      "1e0",
      "99999999999999999999",
    ]) {
      const response = await request(source);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private-auth-token");
    }
  });

  it("rechecks snapshot authority after the asynchronous content read", async () => {
    const { session, snapshot, request, getSession } = setup();
    // A relaunch can replace the snapshot while retained evidence is being read.
    getSession.mockReturnValueOnce(session).mockReturnValue({
      ...session,
      codexInstructionSnapshot: { ...snapshot, capturedAt: 101 },
    });
    const response = await request();
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("Captured global guidance");
  });

  it("keeps old path-only snapshots explicitly unavailable without a filesystem or current-prompt fallback", async () => {
    const { snapshot, request } = setup();
    delete snapshot.contents;
    for (const source of ["generated", "0"]) {
      expect(await (await request(source)).json()).toMatchObject({
        content: null,
        unavailableReason: "This snapshot predates instruction-content capture.",
      });
    }
  });

  it("bounds UTF-8 body bytes without presenting a truncated source as complete", async () => {
    const { snapshot, request } = setup();
    snapshot.contents!.sources[0] = { content: "🦊".repeat(MAX_INSTRUCTION_CONTENT_BYTES / 4 + 1) };
    const response = await request();
    expect(await response.json()).toMatchObject({
      content: null,
      unavailableReason: expect.stringContaining("size limit"),
    });
  });

  it("preserves empty captured content and treats an absent snapshot safely", async () => {
    const { snapshot, session, request } = setup();
    snapshot.contents!.sources[0] = { content: "" };
    expect(await (await request()).json()).toMatchObject({ content: "" });
    delete session.codexInstructionSnapshot;
    expect((await request()).status).toBe(409);
  });

  it("rejects missing identity and non-Codex sessions", async () => {
    const { app, session, request } = setup();
    expect((await app.request("/sessions/session-a/instruction-content?source=0")).status).toBe(400);
    session.backendType = "claude";
    expect((await request()).status).toBe(404);
  });
});
