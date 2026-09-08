import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexMcpManager } from "./codex-mcp-manager.js";
import type { JsonRpcTransport } from "./codex-jsonrpc-transport.js";
import type { BrowserIncomingMessage } from "./session-types.js";

function makeManager() {
  const call = vi.fn<JsonRpcTransport["call"]>();
  const messages: BrowserIncomingMessage[] = [];
  const manager = new CodexMcpManager(
    { call } as unknown as JsonRpcTransport,
    (message) => messages.push(message),
    "mcp-status-session",
  );
  return { call, messages, manager };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex MCP status retrieval", () => {
  it.each([
    "mcpServerStatus/list",
    "config/read",
  ])("records a scoped diagnostic when %s fails without emitting a conversation error", async (failingMethod) => {
    // Both reads belong to one status refresh; a failure in either must remain
    // inspectable without being mistaken for a failed user turn or MCP mutation.
    const { call, messages, manager } = makeManager();
    const diagnostic = "RPC timeout: mcpServerStatus/list\nconnector diagnostic details";
    call.mockImplementation(async (method) => {
      if (method === failingMethod) throw new Error(diagnostic);
      return { data: [] };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await manager.handleGetStatus(750)).toEqual([]);

    const message = `Failed to get MCP status: Error: ${diagnostic}`;
    expect(messages).toEqual([{ type: "session_update", session: { mcp_status_error: message } }]);
    expect(warn).toHaveBeenCalledWith(`[codex-adapter] ${message} for session mcp-status-session`);
    expect(call.mock.calls.map(([method]) => method)).toEqual(
      failingMethod === "config/read" ? ["mcpServerStatus/list", "config/read"] : ["mcpServerStatus/list"],
    );
    expect(call.mock.calls.every(([, , timeout]) => timeout === 750)).toBe(true);
  });

  it.each([
    { label: "an initial empty list", failedFirst: false, data: [] },
    { label: "an empty recovery", failedFirst: true, data: [] },
    { label: "a populated recovery", failedFirst: true, data: [{ name: "docs", tools: { read: { name: "read" } } }] },
  ])("publishes status and explicitly clears the diagnostic for $label", async ({ failedFirst, data }) => {
    // Empty success is authoritative too, including after adapter recreation or
    // a previous refresh failure. It must clear the browser's remembered warning.
    const { call, messages, manager } = makeManager();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (failedFirst) {
      call.mockRejectedValueOnce(new Error("RPC timeout"));
      await manager.handleGetStatus();
      expect(messages[0]).toMatchObject({
        type: "session_update",
        session: { mcp_status_error: "Failed to get MCP status: Error: RPC timeout" },
      });
      messages.length = 0;
    }
    call.mockResolvedValueOnce({ data }).mockResolvedValueOnce({ config: {} });

    const servers = await manager.handleGetStatus();

    expect(servers.map((server) => server.name)).toEqual(data.map((server) => server.name));
    expect(messages).toEqual([
      { type: "mcp_status", servers },
      { type: "session_update", session: { mcp_status_error: null } },
    ]);
  });

  it("preserves startup server failures independently of status retrieval failure and recovery", async () => {
    // A startup event cannot prove that the whole status request recovered, and
    // a successful request cannot prove that a failed server itself recovered.
    const { call, messages, manager } = makeManager();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    call.mockRejectedValueOnce(new Error("RPC timeout"));
    await manager.handleGetStatus();
    messages.length = 0;

    const startupError = 'Auth(TokenRefreshFailed("invalid_grant"))';
    manager.handleStartupStatusUpdated({ name: "docs", status: "failed", error: startupError });

    expect(messages).toEqual([
      {
        type: "mcp_status",
        servers: [
          {
            name: "docs",
            status: "failed",
            error: startupError,
            config: { type: "unknown" },
            scope: "session",
            tools: [],
          },
        ],
      },
      { type: "session_update", session: { mcp_servers: [{ name: "docs", status: "failed" }] } },
    ]);
    messages.length = 0;
    call.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ config: {} });

    const servers = await manager.handleGetStatus();

    expect(servers).toEqual([expect.objectContaining({ name: "docs", status: "failed", error: startupError })]);
    expect(messages).toEqual([
      { type: "mcp_status", servers },
      { type: "session_update", session: { mcp_status_error: null } },
    ]);
  });
});

describe("Codex MCP action failures", () => {
  it.each([
    { action: "toggle", method: "config/value/write", prefix: 'Failed to toggle MCP server "docs"' },
    { action: "reload", method: "config/mcpServer/reload", prefix: "Failed to reload MCP servers" },
    { action: "configure", method: "config/batchWrite", prefix: "Failed to configure MCP servers" },
  ] as const)("keeps $action failures on the existing generic error path", async ({ action, method, prefix }) => {
    // Only status retrieval is scoped by this change; actual requested mutations
    // must retain their existing error reporting and must not claim recovery.
    const { call, messages, manager } = makeManager();
    call.mockRejectedValueOnce(new Error("operation failed"));

    if (action === "toggle") await manager.handleToggle("docs", false);
    if (action === "reload") await manager.handleReconnect();
    if (action === "configure") await manager.handleSetServers({ docs: { type: "stdio", command: "docs-server" } });

    expect(call.mock.calls.map(([calledMethod]) => calledMethod)).toEqual([method]);
    expect(messages).toEqual([{ type: "error", message: `${prefix}: Error: operation failed` }]);
  });
});
