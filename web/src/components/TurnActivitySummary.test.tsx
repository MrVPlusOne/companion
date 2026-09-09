// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TurnActivityDisclosure } from "./TurnActivitySummary.js";

const STATS = { messageCount: 1, toolCount: 3, subagentCount: 0, herdEventCount: 0 };

describe("TurnActivitySummary root-only tool scope", () => {
  it("keeps all existing summary values visible in both disclosure states", () => {
    // Collapsing previously discarded message/time metadata. Use the same
    // values in both states, including supplemental counters and absent time.
    const stats = { messageCount: 2, toolCount: 5, subagentCount: 2, herdEventCount: 3 };
    const props = { stats, durationMs: 73_000, onToggle: () => {} };
    const view = render(<TurnActivityDisclosure {...props} expanded={false} />);
    const control = screen.getByRole("button", { name: /Show turn activity/ });
    for (const text of ["2 messages", "5 tools", "2 agents", "3 worker events"]) {
      expect(control).toHaveTextContent(text);
    }
    expect(screen.getByTestId("turn-summary-duration")).toHaveTextContent("1m 13s");

    view.rerender(<TurnActivityDisclosure {...props} expanded />);
    expect(screen.getByRole("button", { name: /Hide turn activity/ })).toBe(control);
    expect(screen.getByTestId("turn-summary-duration")).toHaveTextContent("1m 13s");
    view.rerender(<TurnActivityDisclosure {...props} durationMs={null} expanded />);
    expect(screen.queryByTestId("turn-summary-duration")).not.toBeInTheDocument();
    expect(control).toHaveTextContent("2 messages");
  });

  it("keeps expanded summaries on the same root-only count contract", () => {
    render(<TurnActivityDisclosure stats={STATS} durationMs={null} expanded onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: /Hide turn activity/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button")).toHaveTextContent("1 message·3 tools");
    expect(screen.getByRole("button")).not.toHaveAccessibleName(/nested Codex subagent activity/i);
  });

  it("uses count-only copy for a single lifecycle worker event in the top shortcut", () => {
    render(
      <TurnActivityDisclosure
        stats={{
          messageCount: 0,
          toolCount: 0,
          subagentCount: 0,
          herdEventCount: 1,
          herdEventLifecycle: ["failed"],
        }}
        durationMs={null}
        expanded
        onToggle={() => {}}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("1 worker event");
    expect(screen.getByRole("button")).not.toHaveTextContent(/Work failed/);
  });

  it("keeps uncommon herd lifecycle detail out of collapsed activity summaries", () => {
    render(
      <TurnActivityDisclosure
        stats={{
          messageCount: 0,
          toolCount: 0,
          subagentCount: 0,
          herdEventCount: 2,
          herdEventLifecycle: ["context_continued", "interrupted"],
        }}
        durationMs={null}
        expanded
        onToggle={() => {}}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("2 worker events");
    expect(screen.getByRole("button")).not.toHaveTextContent(/Work interrupted|context compacted/);
  });
});
