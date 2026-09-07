import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_INSTRUCTION_CONTENT_BYTES } from "../shared/codex-instruction-content.js";
import { captureCodexInstructionSnapshot } from "./codex-instruction-snapshot.js";
import { resolveCapturedInstructionContent } from "./codex-instruction-content.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const THREAD = "thread-instruction-viewer";
const SEPARATOR = "\n\n--- project-doc ---\n\n";

function record(type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: "2026-09-07T12:00:00.000Z", type, payload })}\n`;
}

function nativeContext(text: string, full = true): string {
  // Current native producers retain the assembled model text as an AGENTS world-state section,
  // then persist the turn-context boundary after placing those instructions in model history.
  return (
    record("world_state", { full, state: { agents_md: { text } } }) +
    record("turn_context", { turn_id: "turn-current" })
  );
}

describe("captured Codex instruction content", () => {
  let directory: string;
  let rollout: string;
  let source: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "codex-instruction-content-"));
    rollout = join(directory, "rollout.jsonl");
    source = join(directory, "AGENTS.md");
    await fs.writeFile(rollout, record("session_meta", { id: THREAD, session_id: "distinct-native-tree" }));
    await fs.writeFile(source, "repository instructions");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Every mutable fixture is owned by this test's freshly created disposable directory.
    await fs.rm(directory, { recursive: true, force: true });
  });

  function capture(
    options: {
      sources?: string[];
      global?: string;
      lifecycle?: "thread_start" | "thread_resume";
      generated?: string;
    } = {},
  ) {
    return captureCodexInstructionSnapshot({
      threadId: THREAD,
      capturedAt: 1234,
      lifecycle: options.lifecycle ?? "thread_start",
      instructionSources: options.sources ?? [source],
      developerInstructions: options.generated ?? "  Generated session instructions\n",
      rolloutPath: rollout,
      instructionContext: {
        globalSources: options.global
          ? [{ loadedPath: options.global, sourcePath: "/original/AGENTS.md", delivery: "copied_snapshot" }]
          : [],
        configLayers: [],
      },
    });
  }

  it("captures generated instructions exactly and waits for native proof before showing file content", async () => {
    const snapshot = await capture();
    expect(await resolveCapturedInstructionContent(snapshot, "generated")).toEqual({
      content: "  Generated session instructions\n",
    });
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();

    await fs.appendFile(rollout, nativeContext("repository instructions"));
    expect(await resolveCapturedInstructionContent(snapshot, "0")).toEqual({ content: "repository instructions" });
  });

  it("keeps captured content stable when source files change before or after viewing", async () => {
    const snapshot = await capture();
    await fs.writeFile(source, "later repository text");
    await fs.appendFile(rollout, nativeContext("repository instructions"));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
    await fs.unlink(source);
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
  });

  it("matches global trimming, provider order, and a repository byte-budget cutoff", async () => {
    const global = join(directory, "AGENTS.override.md");
    const nested = join(directory, "nested", "AGENTS.md");
    await fs.mkdir(join(directory, "nested"));
    await fs.writeFile(global, " \n global instructions \n");
    await fs.writeFile(nested, "nested € guidance");
    const snapshot = await capture({ sources: [global, source, nested], global });
    const truncated = Buffer.from("nested € guidance").subarray(0, 9).toString("utf8");
    await fs.appendFile(
      rollout,
      nativeContext(`global instructions${SEPARATOR}repository instructions\n\n${truncated}`),
    );
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("global instructions");
    expect((await resolveCapturedInstructionContent(snapshot, "1")).content).toBe("repository instructions");
    expect((await resolveCapturedInstructionContent(snapshot, "2")).content).toBe(truncated);
  });

  it("never treats pre-resume retained text as proof until a new native context reconciles it", async () => {
    await fs.appendFile(rollout, nativeContext("old repository instructions"));
    const snapshot = await capture({ lifecycle: "thread_resume" });
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();

    await fs.appendFile(rollout, nativeContext("repository instructions", false));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
  });

  it("accepts an unchanged native baseline only after the resumed thread produces its next context", async () => {
    // Native warm resume can retain its loaded AGENTS cache and emit no new world-state section.
    await fs.appendFile(rollout, nativeContext("repository instructions"));
    const snapshot = await capture({ lifecycle: "thread_resume" });
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
    await fs.appendFile(rollout, record("turn_context", { turn_id: "turn-after-resume" }));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
  });

  it("fails closed when current source bytes disagree with the native retained snapshot", async () => {
    const snapshot = await capture();
    await fs.appendFile(rollout, nativeContext("a different loaded snapshot"));
    expect(await resolveCapturedInstructionContent(snapshot, "0")).toMatchObject({
      content: null,
      unavailableReason: expect.stringContaining("could not be matched"),
    });
  });

  it("supports the legacy native user_instructions field without accepting user-message lookalikes", async () => {
    const snapshot = await capture();
    await fs.appendFile(
      rollout,
      record("response_item", {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrepository instructions\n</INSTRUCTIONS>",
          },
        ],
      }),
    );
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
    await fs.appendFile(
      rollout,
      record("turn_context", { turn_id: "legacy-turn", user_instructions: "repository instructions" }),
    );
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
  });

  it("ignores an incomplete turn-context record until the producer finishes it", async () => {
    const snapshot = await capture();
    const context = nativeContext("repository instructions");
    await fs.appendFile(rollout, context.slice(0, -1));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
    await fs.appendFile(rollout, "\n");
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
  });

  it("requires the exact thread header and rejects a replaced rollout", async () => {
    const snapshot = await capture();
    await fs.unlink(rollout);
    await fs.writeFile(
      rollout,
      record("session_meta", { id: "another-thread", session_id: THREAD }) + nativeContext("repository instructions"),
    );
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
  });

  it("allows the common AGENTS-to-CLAUDE instruction alias", async () => {
    const aliasTarget = join(directory, "CLAUDE.md");
    await fs.writeFile(aliasTarget, "aliased repository instructions");
    await fs.unlink(source);
    await fs.symlink(aliasTarget, source);
    const snapshot = await capture();
    await fs.appendFile(rollout, nativeContext("aliased repository instructions"));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("aliased repository instructions");
  });

  it("rejects an instruction alias pointing at credential-bearing configuration", async () => {
    const unsafeTarget = join(directory, "auth.json");
    await fs.writeFile(unsafeTarget, "test credential sentinel");
    await fs.unlink(source);
    await fs.symlink(unsafeTarget, source);
    const snapshot = await capture();
    await fs.appendFile(rollout, nativeContext("test credential sentinel"));
    expect(JSON.stringify(snapshot.contents)).not.toContain("test credential sentinel");
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
  });

  it("allows a bounded native prefix from an oversized repository file and caps generated bodies", async () => {
    await fs.writeFile(source, "r".repeat(MAX_INSTRUCTION_CONTENT_BYTES + 100));
    const snapshot = await capture({ generated: "€".repeat(MAX_INSTRUCTION_CONTENT_BYTES / 2) });
    await fs.appendFile(rollout, nativeContext("r".repeat(100)));
    expect((await resolveCapturedInstructionContent(snapshot, "generated")).content).toBeNull();
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("r".repeat(100));
  });

  it("handles unmaterialized rollouts and missing source files without rejecting initialization", async () => {
    await fs.unlink(rollout);
    const snapshot = await capture();
    await fs.writeFile(rollout, record("session_meta", { id: THREAD }) + nativeContext("repository instructions"));
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBe("repository instructions");
    await fs.unlink(source);
    await expect(capture()).resolves.toMatchObject({ threadId: THREAD });
  });

  it("returns an unavailable snapshot within the capture deadline when filesystem work stalls", async () => {
    vi.useFakeTimers();
    vi.mocked(fs.open).mockImplementationOnce(() => new Promise(() => {}));
    const pending = capture();
    await vi.advanceTimersByTimeAsync(1001);
    await expect(pending).resolves.toMatchObject({
      contents: { generated: { content: "  Generated session instructions\n" }, sources: [{ content: null }] },
    });
  });

  it("does not carry a baseline across malformed retained evidence", async () => {
    await fs.appendFile(rollout, nativeContext("repository instructions"));
    const snapshot = await capture({ lifecycle: "thread_resume" });
    await fs.appendFile(
      rollout,
      '{"type":"world_state","payload":\n' + record("turn_context", { turn_id: "after-corruption" }),
    );
    expect((await resolveCapturedInstructionContent(snapshot, "0")).content).toBeNull();
  });
});
