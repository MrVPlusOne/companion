import { useEffect, useState } from "react";
import { useStore } from "../../store.js";
import type { SessionState } from "../../types.js";
import { McpSection } from "../McpPanel.js";
import { MOCK_MCP_SERVERS } from "./fixtures.js";

const SESSION_ID = "playground-mcp-status";
const SESSION: SessionState = {
  session_id: SESSION_ID,
  backend_type: "codex",
  model: "gpt-5.5",
  cwd: "/playground",
  tools: [],
  permissionMode: "default",
  claude_code_version: "",
  mcp_servers: [],
  agents: [],
  slash_commands: [],
  skills: [],
  total_cost_usd: 0,
  num_turns: 0,
  context_used_percent: 0,
  is_compacting: false,
  git_branch: "main",
  is_worktree: false,
  is_containerized: false,
  repo_root: "/playground",
  git_ahead: 0,
  git_behind: 0,
  total_lines_added: 0,
  total_lines_removed: 0,
};

type StatusMode = "failed" | "empty" | "recovered";

export function PlaygroundMcpStatus() {
  const [mode, setMode] = useState<StatusMode>("failed");

  useEffect(() => {
    const previousSession = useStore.getState().sessions.get(SESSION_ID);
    const previousServers = useStore.getState().mcpServers.get(SESSION_ID);
    // This synthetic session has no transport or connected state, so mounting
    // the real section cannot fetch status or change any live MCP configuration.
    useStore.setState((state) => ({
      sessions: new Map(state.sessions).set(SESSION_ID, {
        ...SESSION,
        mcp_status_error:
          mode === "recovered" ? null : "Failed to get MCP status: Error: mcpServerStatus/list timed out after 5000ms",
      }),
      mcpServers: new Map(state.mcpServers).set(SESSION_ID, mode === "empty" ? [] : MOCK_MCP_SERVERS),
    }));
    return () => {
      useStore.setState((state) => {
        const sessions = new Map(state.sessions);
        const mcpServers = new Map(state.mcpServers);
        if (previousSession) sessions.set(SESSION_ID, previousSession);
        else sessions.delete(SESSION_ID);
        if (previousServers) mcpServers.set(SESSION_ID, previousServers);
        else mcpServers.delete(SESSION_ID);
        return { sessions, mcpServers };
      });
    };
  }, [mode]);

  return (
    <div className="space-y-3" data-testid="playground-mcp-status">
      <label className="flex flex-wrap items-center gap-2 text-xs text-cc-muted">
        Status response
        <select
          aria-label="MCP status response"
          value={mode}
          onChange={(event) => setMode(event.target.value as StatusMode)}
          className="rounded border border-cc-border bg-cc-card px-2 py-1 text-cc-fg"
        >
          <option value="failed">Failed with known servers</option>
          <option value="empty">Failed before first status</option>
          <option value="recovered">Recovered</option>
        </select>
      </label>
      <div className="w-full max-w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
        <McpSection sessionId={SESSION_ID} />
      </div>
    </div>
  );
}
