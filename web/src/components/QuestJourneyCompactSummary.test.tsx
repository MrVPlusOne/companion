// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { QuestJourneyPlanState } from "../../shared/quest-journey.js";
import { QuestJourneyCompactSummary, QuestJourneyPreviewCard, QuestJourneyTimeline } from "./QuestJourneyTimeline.js";

const PROPOSED_JOURNEY: QuestJourneyPlanState = {
  mode: "proposed",
  phaseIds: ["alignment", "work", "user-checkpoint", "work", "memory"],
  phaseNotes: { "2": "Confirm the delivery choice before Work resumes." },
};

describe("QuestJourneyCompactSummary", () => {
  it("keeps a proposed five-phase Journey to one status label while preserving the full detail preview", () => {
    // A real checkpoint plan repeats Work after the decision. The compact
    // banner must not expand that producer-shaped plan into five inline labels.
    render(
      <>
        <QuestJourneyTimeline journey={PROPOSED_JOURNEY} status="PROPOSED" compact />
        <QuestJourneyPreviewCard journey={PROPOSED_JOURNEY} status="PROPOSED" />
      </>,
    );

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "proposed");
    expect(summary).toHaveTextContent(/^Proposed5 phases1 note$/);

    const details = screen.getByTestId("quest-journey-detail-list");
    const rows = within(details).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    ["Alignment", "Work", "User Checkpoint", "Work", "Memory"].forEach((label, index) => {
      expect(rows[index]).toHaveAttribute("data-phase-index", String(index));
      expect(within(rows[index]).getByText(label)).toBeInTheDocument();
    });
    expect(within(details).getByText(PROPOSED_JOURNEY.phaseNotes!["2"])).toBeInTheDocument();
  });

  it("keeps the active phase and repeated-phase position without adding the rest of the Journey", () => {
    // The second Work occurrence must retain its authoritative position, and
    // banner consumers that suppress note counts must keep that behavior.
    render(
      <QuestJourneyCompactSummary
        journey={{ ...PROPOSED_JOURNEY, mode: "active", activePhaseIndex: 3, currentPhaseId: "work" }}
        status="WORKING"
        showNotes={false}
      />,
    );

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "active");
    expect(summary).toHaveTextContent(/^Work4\/5$/);
  });

  it.each(["done", "needs_verification"])("keeps the completed summary for %s quests", (status) => {
    // Completed quest status remains authoritative over a retained active
    // phase, so a finished quest never advertises Work as its current step.
    render(
      <QuestJourneyCompactSummary
        journey={{ ...PROPOSED_JOURNEY, mode: "active", activePhaseIndex: 3, currentPhaseId: "work" }}
        status={status}
      />,
    );

    const summary = screen.getByTestId("quest-journey-compact-summary");
    expect(summary).toHaveAttribute("data-journey-mode", "completed");
    expect(summary).toHaveTextContent(/^Completed5 phases1 note$/);
  });
});
