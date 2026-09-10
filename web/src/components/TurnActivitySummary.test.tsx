// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TurnActivityDisclosure } from "./TurnActivitySummary.js";

const STATS = { messageCount: 1, toolCount: 3, subagentCount: 0, herdEventCount: 0 };

describe("TurnActivitySummary root-only tool scope", () => {
  it.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 0min"],
    [3_659_999, "1h 0min"],
    [3_660_000, "1h 1min"],
    [7_199_999, "1h 59min"],
    [7_200_000, "2h 0min"],
    [62_024_000, "17h 13min"],
    [90_061_000, "25h 1min"],
  ])("formats %i ms as %s in both disclosure states", (durationMs, expected) => {
    // Boundaries preserve short formats and drop seconds, rather than rounding
    // the measured interval, once hours are present. Long runs stay in hours.
    const props = { stats: STATS, durationMs, onToggle: () => {} };
    const view = render(<TurnActivityDisclosure {...props} expanded={false} />);
    const control = screen.getByRole("button", { name: `Show turn activity · ${expected} · 1 message · 3 tools` });
    expect(screen.getByTestId("turn-summary-duration").textContent).toBe(expected);
    view.rerender(<TurnActivityDisclosure {...props} expanded />);
    expect(screen.getByRole("button", { name: `Hide turn activity · ${expected} · 1 message · 3 tools` })).toBe(
      control,
    );
    expect(screen.getByTestId("turn-summary-duration").textContent).toBe(expected);
  });

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
