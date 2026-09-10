import { useEffect } from "react";
import { useStore } from "../../store.js";
import { ToolBlock } from "../ToolBlock.js";
import type { BoardProposalReviewPayload, BoardRowData } from "../BoardBlock.js";

const SESSION_ID = "playground-journey-proposal";
const TOOL_ID = "playground-journey-proposal-tool";
const summary = `## Goal / Acceptance

Make **approval decisions** easy to review while keeping the complete proposal available.

- Render headings, lists, and [source context](quest:q-941) clearly.
- Preserve the original \`takode board propose\` command for inspection.

## Boundaries

Keep existing approval behavior and the full Journey. This example is *display-only* and changes no real decisions.

## Scheduling

1. Review the proposed scope and dependencies.
2. Complete Work after the checkpoint decision.

Approve and start this work? **Approve and start** begins the scoped change; **Keep filed** leaves it unstarted.`;

const command = `summary=$(cat <<'EOF'
${summary}
EOF
)
takode board propose q-942 --summary "$summary"`;
const proposal: BoardProposalReviewPayload = {
  questId: "q-942",
  title: "Make Journey proposals easier to review",
  status: "PROPOSED",
  presentedAt: 1770000000000,
  summary,
  journey: {
    mode: "proposed",
    presetId: "custom",
    phaseIds: ["alignment", "work", "user-checkpoint", "work", "memory"],
    phaseNotes: { "2": "Confirm the remaining scope before Work resumes." },
  },
};
const board: BoardRowData[] = [
  { ...proposal, updatedAt: proposal.presentedAt, waitFor: ["q-941"], waitForInput: ["n-3"] },
];

/** Exercises the real tool-result path, including full raw command inspection. */
export function PlaygroundJourneyProposal() {
  useEffect(() => {
    const content = JSON.stringify({
      __takode_board__: true,
      board,
      operation: "propose q-942: updated",
      proposalReview: proposal,
    });
    const toolResults = new Map(useStore.getState().toolResults);
    toolResults.set(
      SESSION_ID,
      new Map([
        [TOOL_ID, { tool_use_id: TOOL_ID, content, is_error: false, is_truncated: false, total_size: content.length }],
      ]),
    );
    useStore.setState({ toolResults });
    return () => {
      const next = new Map(useStore.getState().toolResults);
      next.delete(SESSION_ID);
      useStore.setState({ toolResults: next });
    };
  }, []);

  return (
    <div data-testid="playground-journey-proposal">
      <ToolBlock name="Bash" input={{ command }} toolUseId={TOOL_ID} sessionId={SESSION_ID} />
    </div>
  );
}
