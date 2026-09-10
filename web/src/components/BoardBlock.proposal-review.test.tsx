// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BoardBlock, type BoardProposalReviewPayload } from "./BoardBlock.js";
import { useStore } from "../store.js";

const sessionId = "proposal-leader";
const toolUseId = "proposal-tool";
const summary = `## Goal / Acceptance

Review **complete terms** with *readable context* and \`literal code\`.

- Keep the [source decision](quest:q-42:feedback:3).
- Read [the discussion](session:5:12).

## Scheduling

1. Review the scope.
2. Approve the work.

<script>window.untrusted = true</script>

[Unsafe link](javascript:alert%281%29)

Final approval question: proceed with these terms?`;
const proposal: BoardProposalReviewPayload = {
  questId: "q-43",
  title: "A complete proposal title that remains readable on a narrow screen",
  status: "PROPOSED",
  presentedAt: 1770000000000,
  summary,
  journey: {
    mode: "proposed",
    phaseIds: ["alignment", "work", "memory"],
    phaseNotes: { "1": "Preserve the complete proposed scope." },
  },
};
const command = `summary=$(cat <<'EOF'\n${summary}\nEOF\n)\ntakode board propose q-43 --summary "$summary"`;

beforeEach(() => {
  useStore.getState().reset();
  useStore
    .getState()
    .setSdkSessions([
      { sessionId: "discussion-session", sessionNum: 5, state: "connected", cwd: "/repo", createdAt: 1 },
    ]);
  window.location.hash = `#/session/${sessionId}`;
});

describe("Journey proposal approval card", () => {
  it("renders the complete summary through safe shared Markdown and native Takode links", () => {
    // Includes the final decision, rich blocks, unsafe markup, and exact source
    // links so visual polish cannot replace or weaken the approval packet.
    const before = JSON.stringify(proposal);
    const view = render(<BoardBlock board={[]} proposalReview={proposal} sessionId={sessionId} />);
    const review = screen.getByTestId("quest-journey-proposal-review");

    expect(screen.getByRole("heading", { name: "Goal / Acceptance", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scheduling", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("complete terms").tagName).toBe("STRONG");
    expect(screen.getByText("readable context").tagName).toBe("EM");
    expect(screen.getByText("literal code").tagName).toBe("CODE");
    expect(review.querySelector("ul")).toHaveTextContent("source decision");
    expect(review.querySelector("ol")).toHaveTextContent("Approve the work.");
    expect(screen.getByRole("link", { name: "source decision" })).toHaveAttribute(
      "href",
      `#/session/${sessionId}?quest=q-42&feedback=3`,
    );
    expect(screen.getByRole("link", { name: "the discussion" })).toHaveAttribute("href", "#/session/5?msg=12");
    expect(screen.getByRole("button", { name: "Preview q-42 feedback #3" })).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getAllByText("Final approval question: proceed with these terms?")).toHaveLength(1);
    expect(screen.getByText("Preserve the complete proposed scope.")).toBeInTheDocument();
    expect(review.textContent?.indexOf(proposal.title!)).toBeLessThan(review.textContent!.indexOf("Goal / Acceptance"));
    expect(JSON.stringify(proposal)).toBe(before);
  });

  it("keeps shell details behind raw inspection and preserves collapse and reopen controls", () => {
    // Exercise the real nested ToolBlock with its original producer-shaped result,
    // rather than mocking the raw inspector or fetching a real proposal.
    const content = JSON.stringify({ __takode_board__: true, board: [], proposalReview: proposal });
    useStore.setState({
      toolResults: new Map([
        [
          sessionId,
          new Map([
            [
              toolUseId,
              {
                tool_use_id: toolUseId,
                content,
                is_error: false,
                is_truncated: false,
                total_size: content.length,
              },
            ],
          ]),
        ],
      ]),
    });
    const view = render(
      <BoardBlock
        board={[]}
        proposalReview={proposal}
        sessionId={sessionId}
        toolUseId={toolUseId}
        operation="propose q-43: updated"
        originalToolName="Bash"
        originalInput={{ command }}
        originalCommand={command}
      />,
    );
    const header = screen.getByRole("button", { name: "Journey Proposal" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).not.toHaveTextContent("summary=$");
    expect(screen.queryByText("propose q-43: updated")).toBeNull();
    expect(screen.queryByText("Original command")).toBeNull();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("quest-journey-proposal-review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show raw" }));
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Original command")).toBeInTheDocument();
    expect(screen.getByText("propose q-43: updated")).toBeInTheDocument();
    expect(view.container.textContent).toContain(command);
    expect(
      within(screen.getByTestId("quest-journey-proposal-review")).getByRole("heading", { name: "Goal / Acceptance" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide raw" }));
    expect(screen.queryByText("Original command")).toBeNull();
    expect(screen.getByText("Final approval question: proceed with these terms?")).toBeInTheDocument();
    expect(useStore.getState().toolResults.get(sessionId)?.get(toolUseId)?.content).toBe(content);
  });
});
