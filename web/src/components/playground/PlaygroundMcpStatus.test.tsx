// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useStore } from "../../store.js";
import { sendMcpGetStatus, sendMcpReconnect, sendMcpSetServers, sendMcpToggle } from "../../ws.js";
import { PlaygroundMcpStatus } from "./PlaygroundMcpStatus.js";

vi.mock("../../ws.js", () => ({
  sendMcpGetStatus: vi.fn(),
  sendMcpReconnect: vi.fn(),
  sendMcpSetServers: vi.fn(),
  sendMcpToggle: vi.fn(),
}));

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
});

it("shows real panel failure and recovery without transport requests and removes its synthetic state", () => {
  // The fixture exercises the real McpSection while keeping all state local to an unconnected synthetic session.
  const originalServers = useStore.getState().mcpServers;
  const { unmount } = render(<PlaygroundMcpStatus />);
  expect(screen.getByRole("status")).toHaveTextContent("Couldn’t refresh MCP server status.");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Failed to get MCP status: Error: mcpServerStatus/list timed out after 5000ms",
  );
  expect(screen.getByRole("button", { name: "filesystem" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "postgres" }));
  expect(screen.getByText(/Connection refused: ECONNREFUSED/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("MCP status response"), { target: { value: "empty" } });
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.queryByText(/No MCP servers configured/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "filesystem" })).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("MCP status response"), { target: { value: "recovered" } });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "filesystem" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "postgres" }));
  expect(screen.getByText(/Connection refused: ECONNREFUSED/)).toBeInTheDocument();

  unmount();
  expect(useStore.getState().sessions.has("playground-mcp-status")).toBe(false);
  expect(useStore.getState().mcpServers).toEqual(originalServers);
  expect(sendMcpGetStatus).not.toHaveBeenCalled();
  expect(sendMcpToggle).not.toHaveBeenCalled();
  expect(sendMcpReconnect).not.toHaveBeenCalled();
  expect(sendMcpSetServers).not.toHaveBeenCalled();
});
