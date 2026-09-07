import { useEffect, useState } from "react";
import { api } from "../../api.js";
import type { SdkSessionInfo } from "../../types.js";
import { CodexInstructionsCollapsible } from "../CodexInstructionsCollapsible.js";
import { Card, Section } from "./shared.js";

const SESSION_ID = "playground-codex-instruction-viewer";
const SNAPSHOT: NonNullable<SdkSessionInfo["codexInstructionSnapshot"]> = {
  threadId: "thread-instruction-capture",
  capturedAt: Date.UTC(2026, 8, 7, 12),
  lifecycle: "thread_resume",
  developerInstructionsConfigured: true,
  instructionSourcesReported: true,
  configLayers: [{ kind: "user", path: "/Users/example/.companion/codex-home/session/config.toml" }],
  instructionSources: [
    {
      kind: "global",
      sourcePath: "/Users/example/.codex/AGENTS.md",
      path: "/Users/example/.companion/codex-home/session/AGENTS.md",
      delivery: "copied_snapshot",
    },
    {
      kind: "project",
      path: "/Users/example/Projects/a-repository-with-a-long-name/packages/application/AGENTS.md",
      delivery: "direct",
    },
    { kind: "project", path: "/Users/example/Projects/archived-source/AGENTS.md", delivery: "direct" },
  ],
};

export function PlaygroundCodexInstructionsSection() {
  const [mode, setMode] = useState<"captured" | "loading" | "error">("captured");

  useEffect(() => {
    const original = api.getSessionInstructionContent;
    const fixture: typeof original = async (sessionId, request) => {
      if (sessionId !== SESSION_ID) return original(sessionId, request);
      if (mode === "loading") return new Promise(() => {});
      if (mode === "error") throw new Error("Playground instruction detail failure");
      const content =
        request.source === "generated"
          ? "# Session guidance\n\nUse the assigned workspace. Keep tool output concise.\n\nThis is the captured generated instruction body."
          : request.source === "0"
            ? "# Global guidance\n\nPrefer clear explanations and focused changes.\n\nThis copy was captured when the process launched."
            : request.source === "1"
              ? "# Repository guidance\n\nRun relevant checks before committing.\n\nLiteral content stays intact: <script>example</script>\n\nA long line: " +
                "captured-content-".repeat(30)
              : null;
      return {
        ...request,
        content,
        ...(content === null ? { unavailableReason: "Captured content is unavailable for this older source." } : {}),
      };
    };
    api.getSessionInstructionContent = fixture;
    return () => {
      if (api.getSessionInstructionContent === fixture) api.getSessionInstructionContent = original;
    };
  }, [mode]);

  return (
    <Section
      title="Codex Developer Instructions"
      description="One section groups generated guidance and loaded files; each row opens its captured content in the same read-only viewer."
    >
      <div className="max-w-lg space-y-3">
        <label className="flex items-center gap-2 text-xs text-cc-muted">
          Viewer response
          <select
            aria-label="Instruction viewer response"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
            className="rounded border border-cc-border bg-cc-card px-2 py-1 text-cc-fg"
          >
            <option value="captured">Captured content</option>
            <option value="loading">Loading</option>
            <option value="error">Request failed</option>
          </select>
        </label>
        <Card label="Captured sources with global provenance and a long repository path">
          <CodexInstructionsCollapsible
            key={mode}
            sessionId={SESSION_ID}
            snapshot={SNAPSHOT}
            fetchWhenMissing={false}
          />
        </Card>
      </div>
    </Section>
  );
}
