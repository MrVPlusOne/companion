import { Fragment } from "react";
import type { TurnStats } from "../hooks/use-feed-model.js";
import { summarizeWorkerEventActivity } from "../utils/herd-event-classification.js";
import { isTouchDevice } from "../utils/mobile.js";
import { formatElapsed } from "./message-feed-utils.js";

export function TurnActivityDisclosure({
  stats,
  durationMs,
  expanded,
  onToggle,
}: {
  stats: TurnStats;
  durationMs: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const labels = summaryLabels(stats, durationMs);
  const action = expanded ? "Hide turn activity" : "Show turn activity";
  const heightClass = isTouchDevice() ? "min-h-11" : "min-h-11 sm:min-h-7";

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={labels.length > 0 ? action + " · " + labels.join(" · ") : action}
      className={
        "group/turn-summary inline-flex max-w-full touch-manipulation items-center gap-2 rounded-sm border-0 bg-transparent px-0 py-1 text-left text-xs font-normal text-cc-muted transition-colors hover:text-cc-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cc-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-cc-bg sm:text-[13px] " +
        heightClass
      }
      data-turn-toggle
    >
      <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums underline-offset-4 group-hover/turn-summary:underline group-hover/turn-summary:decoration-cc-muted/60">
        {labels.length === 0
          ? "Turn activity"
          : labels.map((label, index) => (
              <Fragment key={label}>
                {index > 0 && (
                  <span className="text-cc-muted/70" aria-hidden="true">
                    ·
                  </span>
                )}
                <span
                  className="whitespace-nowrap"
                  data-testid={index === 0 && durationMs !== null ? "turn-summary-duration" : undefined}
                >
                  {label}
                </span>
              </Fragment>
            ))}
      </span>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={"h-2.5 w-2.5 shrink-0 opacity-70 " + (expanded ? "rotate-90" : "")}
        aria-hidden="true"
      >
        <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    </button>
  );
}

function summaryLabels(stats: TurnStats, durationMs: number | null): string[] {
  const labels: string[] = [];
  if (durationMs !== null) labels.push(formatElapsed(durationMs));
  if (stats.messageCount > 0) labels.push(stats.messageCount + (stats.messageCount === 1 ? " message" : " messages"));
  if (stats.toolCount > 0) labels.push(stats.toolCount + (stats.toolCount === 1 ? " tool" : " tools"));
  if (stats.subagentCount > 0) labels.push(stats.subagentCount + (stats.subagentCount === 1 ? " agent" : " agents"));
  if (stats.herdEventCount > 0) labels.push(summarizeWorkerEventActivity(stats.herdEventCount));
  return labels;
}
