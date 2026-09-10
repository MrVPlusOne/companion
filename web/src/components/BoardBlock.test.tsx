// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardBlock } from "./BoardBlock.js";
import { useStore } from "../store.js";
import type { BoardRowData } from "./BoardTable.js";
import type { BoardRowSessionStatus } from "../types.js";

const liveRowSessionStatuses = new Map<string, Record<string, BoardRowSessionStatus>>();

vi.mock("./BoardTable.js", () => ({
  BoardTable: ({
    board,
    rowSessionStatuses,
  }: {
    board: BoardRowData[];
    rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
  }) => (
    <div data-testid="board-table" data-statuses={JSON.stringify(rowSessionStatuses ?? null)}>
      {board.length} rows
    </div>
  ),
  QuestLink: ({ questId }: { questId: string }) => <a href={"#quest-" + questId}>{questId}</a>,
}));

vi.mock("./CollapseFooter.js", () => ({
  CollapseFooter: () => null,
}));

describe("BoardBlock", () => {
  beforeEach(() => {
    liveRowSessionStatuses.clear();
    useStore.getState().reset();
    useStore.setState({ sessionBoardRowStatuses: liveRowSessionStatuses });
  });

  it("prefers explicit row session statuses over the live store snapshot", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];
    liveRowSessionStatuses.set("s-1", {
      "q-42": { worker: { sessionId: "worker-live", sessionNum: 9, status: "idle" }, reviewer: null },
    });

    render(
      <BoardBlock
        board={board}
        sessionId="s-1"
        defaultOpen
        rowSessionStatuses={{
          "q-42": {
            worker: { sessionId: "worker-inline", sessionNum: 12, status: "running" },
            reviewer: { sessionId: "reviewer-inline", sessionNum: 13, status: "running" },
          },
        }}
      />,
    );

    expect(screen.getByTestId("board-table")).toHaveAttribute(
      "data-statuses",
      JSON.stringify({
        "q-42": {
          worker: { sessionId: "worker-inline", sessionNum: 12, status: "running" },
          reviewer: { sessionId: "reviewer-inline", sessionNum: 13, status: "running" },
        },
      }),
    );
  });

  it("formats embedded quest journey enum labels in the operation header", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(<BoardBlock board={board} operation="advanced q-42 to USER_CHECKPOINTING" defaultOpen />);

    expect(screen.getByText("advanced q-42 to User Checkpoint")).toBeInTheDocument();
    expect(screen.queryByText(/USER_CHECKPOINTING/)).toBeNull();
  });

  it("starts collapsed even when the board has a tool command", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(
      <BoardBlock
        board={board}
        sessionId="s-1"
        toolUseId="board-tool-1"
        originalToolName="Bash"
        originalInput={{ command: "takode board advance q-42" }}
        originalCommand="takode board advance q-42"
      />,
    );

    expect(screen.getByText("takode board advance q-42")).toBeInTheDocument();
    expect(screen.queryByTestId("board-table")).toBeNull();

    fireEvent.click(screen.getByText("takode board advance q-42"));
    expect(screen.getByTestId("board-table")).toBeInTheDocument();
  });

  it("renders queue warnings when present", () => {
    const board: BoardRowData[] = [{ questId: "q-42", title: "Quest", updatedAt: 1 }];

    render(
      <BoardBlock
        board={board}
        defaultOpen
        queueWarnings={[
          {
            questId: "q-42",
            kind: "dispatchable",
            summary: "q-42 can be dispatched now: wait-for resolved (q-9).",
            action: "Dispatch it now.",
          },
        ]}
      />,
    );

    expect(screen.getByText("Queue Warnings")).toBeInTheDocument();
    expect(screen.getByText(/q-42 can be dispatched now/i)).toBeInTheDocument();
    expect(screen.getByText(/Next: Dispatch it now\./i)).toBeInTheDocument();
  });

  it("renders an expanded proposal review artifact instead of the full board table", () => {
    const board: BoardRowData[] = [
      { questId: "q-942", title: "Draft workflow", waitFor: ["q-12", "#5"], waitForInput: ["n-3"], updatedAt: 1 },
    ];
    const longSummary =
      "Goal / Acceptance: approve the workflow change.\nScheduling: wait for the current reviewer before dispatch.";

    render(
      <BoardBlock
        board={board}
        operation="propose q-942"
        proposalReview={{
          questId: "q-942",
          title: "Draft workflow",
          status: "PROPOSED",
          presentedAt: 123,
          summary: longSummary,
          journey: {
            mode: "proposed",
            phaseIds: ["alignment", "work", "memory"],
            phaseNotes: {
              "1": "Build the draft and present paths.",
            },
          },
        }}
      />,
    );

    expect(screen.getByTestId("quest-journey-proposal-review")).toBeInTheDocument();
    expect(screen.getByText("Journey Proposal")).toBeInTheDocument();
    // The shared Markdown renderer preserves soft breaks with <br>, rather
    // than a literal newline text node; both complete lines remain visible.
    const summary = screen.getByTestId("quest-journey-proposal-review").querySelector(".markdown-body");
    expect(summary).toBeInTheDocument();
    expect(summary).toHaveTextContent("Goal / Acceptance: approve the workflow change.");
    expect(summary).toHaveTextContent("Scheduling: wait for the current reviewer before dispatch.");
    expect(summary?.querySelector("br")).not.toBeNull();
    expect(summary).not.toHaveClass("truncate");
    expect(screen.getByText("Build the draft and present paths.")).toHaveAttribute("data-purpose-kind", "authored");
    expect(screen.getByText("Build the draft and present paths.")).toHaveClass("ml-[1.375rem]");
    expect(screen.queryByTestId("board-table")).toBeNull();
    const dependencyRow = within(screen.getByTestId("proposal-dependency-row"));
    expect(dependencyRow.getByText("q-12")).toHaveAttribute("href", "#quest-q-12");
    expect(dependencyRow.getByText("#5")).toBeInTheDocument();
    expect(dependencyRow.getByText("3")).toBeInTheDocument();
  });
});
