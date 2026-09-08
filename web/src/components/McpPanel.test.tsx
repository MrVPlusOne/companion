// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { McpServerDetail, SessionState } from "../types.js";
import { useStore } from "../store.js";
import { sendMcpGetStatus, sendMcpReconnect, sendMcpSetServers, sendMcpToggle } from "../ws.js";
import { McpSection } from "./McpPanel.js";

vi.mock("../ws.js", () => ({
  sendMcpGetStatus: vi.fn(),
  sendMcpReconnect: vi.fn(),
  sendMcpSetServers: vi.fn(),
  sendMcpToggle: vi.fn(),
}));

const STATUS_ERROR = "Request timed out while listing MCP servers.";
const FAILED_SERVER: McpServerDetail = {
  name: "database",
  status: "failed",
  error: "Connection refused",
  config: { type: "stdio", command: "database-mcp" },
  scope: "project",
};

function session(sessionId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: sessionId,
    backend_type: "codex",
    model: "gpt-5.5",
    cwd: "/test",
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
    repo_root: "/test",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
});

describe("McpSection status-fetch failures", () => {
  it("shows a failed first fetch without claiming no servers are configured", () => {
    // A failed inventory request cannot establish that the configured-server list is empty.
    useStore.setState({
      sessions: new Map([["s1", session("s1", { mcp_status_error: STATUS_ERROR })]]),
    });
    render(<McpSection sessionId="s1" />);

    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t refresh MCP server status.");
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);
    expect(screen.queryByText(/No MCP servers configured/)).not.toBeInTheDocument();
    expect(sendMcpGetStatus).not.toHaveBeenCalled();

    act(() => useStore.getState().updateSession("s1", { mcp_status_error: null }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
  });

  it("retains known servers, their own errors, and controls while only server updates clear the status error", () => {
    // The status-fetch failure belongs to the section and must not replace server-specific diagnostics.
    useStore.setState({
      sessions: new Map([["s1", session("s1", { mcp_status_error: STATUS_ERROR })]]),
      mcpServers: new Map([["s1", [FAILED_SERVER]]]),
      cliConnected: new Map([["s1", true]]),
    });
    render(<McpSection sessionId="s1" />);

    expect(sendMcpGetStatus).toHaveBeenCalledExactlyOnceWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "database" }));
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
    expect(screen.getByText("database-mcp")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Refresh MCP server status"));
    expect(sendMcpGetStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);
    fireEvent.click(screen.getByTitle("Disable server"));
    fireEvent.click(screen.getByTitle("Reconnect server"));
    expect(sendMcpToggle).toHaveBeenCalledWith("s1", "database", false);
    expect(sendMcpReconnect).toHaveBeenCalledWith("s1", "database");

    fireEvent.click(screen.getByTitle("Add MCP server"));
    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), { target: { value: "memory" } });
    fireEvent.change(screen.getByPlaceholderText("npx -y @modelcontextprotocol/server-memory"), {
      target: { value: "memory-mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));
    expect(sendMcpSetServers).toHaveBeenCalledWith("s1", { memory: { type: "stdio", command: "memory-mcp" } });
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);

    act(() => useStore.getState().updateSession("s1", { mcp_status_error: null }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "database" })).toBeInTheDocument();
    expect(sendMcpGetStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps initial server hints and scopes the error to the selected session", () => {
    // Another session's error must not follow the user when the same panel changes sessions.
    useStore.setState({
      sessions: new Map([
        [
          "s1",
          session("s1", { mcp_status_error: STATUS_ERROR, mcp_servers: [{ name: "memory", status: "connected" }] }),
        ],
        ["s2", session("s2")],
      ]),
      cliConnected: new Map([
        ["s1", true],
        ["s2", true],
      ]),
    });
    const { rerender } = render(<McpSection sessionId="s1" />);
    expect(screen.getByRole("button", { name: "memory" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);

    rerender(<McpSection sessionId="s2" />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "memory" })).not.toBeInTheDocument();
    expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument();
    expect(sendMcpGetStatus).toHaveBeenNthCalledWith(1, "s1");
    expect(sendMcpGetStatus).toHaveBeenNthCalledWith(2, "s2");
  });

  it("does not refetch on error changes or expansion, and keeps the reconnect fetch lifecycle", () => {
    // Error presentation must not introduce a new fetch loop or clear itself when the section opens.
    useStore.setState({
      sessions: new Map([["s1", session("s1")]]),
      cliConnected: new Map([["s1", true]]),
    });
    const { rerender } = render(<McpSection sessionId="s1" collapsed />);
    act(() => useStore.getState().updateSession("s1", { mcp_status_error: STATUS_ERROR }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<McpSection sessionId="s1" />);
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);
    expect(sendMcpGetStatus).toHaveBeenCalledTimes(1);

    act(() => useStore.getState().setCliConnected("s1", false));
    expect(screen.getByTitle("Refresh MCP server status")).toBeDisabled();
    act(() => useStore.getState().setCliConnected("s1", true));
    expect(sendMcpGetStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(STATUS_ERROR);
  });
});
