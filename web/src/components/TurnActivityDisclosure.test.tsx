// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnActivityDisclosure } from "./TurnActivitySummary.js";

const EMPTY_STATS = { messageCount: 0, toolCount: 0, subagentCount: 0, herdEventCount: 0 };

function StatefulTurnToggle() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-turn-id="turn-focus">
      <TurnActivityDisclosure
        expanded={expanded}
        stats={{ ...EMPTY_STATS, toolCount: 4 }}
        durationMs={null}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && <p>Expanded chronology</p>}
    </div>
  );
}

// Retains the former turn-footer interaction cases against its approved replacement.
describe("TurnActivityDisclosure interaction", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers one accessible touch-sized disclosure with tool metadata", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <TurnActivityDisclosure
        expanded={false}
        stats={{ ...EMPTY_STATS, toolCount: 3 }}
        durationMs={null}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button", { name: "Show turn activity · 3 tools" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveClass("min-h-11", "touch-manipulation", "bg-transparent");
    expect(button).not.toHaveClass("sm:min-h-7", "w-full");
    expect(screen.getAllByRole("button")).toHaveLength(1);

    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("uses a text fallback without inventing metadata when no values are available", () => {
    render(<TurnActivityDisclosure expanded={false} stats={EMPTY_STATS} durationMs={null} onToggle={() => {}} />);

    expect(screen.getByRole("button", { name: "Show turn activity" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Turn activity")).toBeVisible();
    expect(screen.queryByText(/tools?/i)).not.toBeInTheDocument();
  });

  it("uses singular tool copy", () => {
    render(
      <TurnActivityDisclosure
        expanded={false}
        stats={{ ...EMPTY_STATS, toolCount: 1 }}
        durationMs={null}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Show turn activity · 1 tool" })).toBeVisible();
  });

  it("keeps the same control and focus across both states", async () => {
    const user = userEvent.setup();
    render(<StatefulTurnToggle />);

    const disclosure = screen.getByRole("button", { name: "Show turn activity · 4 tools" });
    disclosure.focus();
    await user.click(disclosure);
    expect(screen.getByRole("button", { name: "Hide turn activity · 4 tools" })).toBe(disclosure);
    expect(document.activeElement).toBe(disclosure);
    expect(screen.getAllByRole("button")).toHaveLength(1);

    await user.click(disclosure);
    expect(screen.getByRole("button", { name: "Show turn activity · 4 tools" })).toBe(disclosure);
    expect(document.activeElement).toBe(disclosure);
  });

  it("collapses from the top without a footer-specific scroll adjustment", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container } = render(
      <TurnActivityDisclosure expanded stats={EMPTY_STATS} durationMs={null} onToggle={onToggle} />,
    );
    container.scrollTop = 120;

    const button = screen.getByRole("button", { name: "Hide turn activity" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("min-h-11", "sm:min-h-7");
    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(container.scrollTop).toBe(120);
  });
});
