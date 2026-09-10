import type { QuestJourneyPlanState } from "../../shared/quest-journey.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { QuestJourneyTimeline } from "./QuestJourneyTimeline.js";

export function QuestJourneyProposalReview({
  proposal,
  onQuestClick,
  sessionId,
  className,
}: {
  proposal: {
    questId: string;
    title?: string;
    status: string;
    journey: QuestJourneyPlanState;
    presentedAt?: number;
    summary?: string;
    scheduling?: Record<string, unknown>;
  };
  onQuestClick?: () => void;
  sessionId?: string;
  className?: string;
}) {
  const title = (
    <>
      <span className="font-mono-code text-xs text-cc-info">{proposal.questId}</span>
      {proposal.title && (
        <span className="mt-1 block text-base font-semibold text-cc-fg sm:text-lg">{proposal.title}</span>
      )}
    </>
  );
  return (
    <div
      className={`min-w-0 space-y-4 px-4 py-4 sm:px-5 ${className ?? ""}`.trim()}
      data-testid="quest-journey-proposal-review"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {onQuestClick ? (
          <button
            type="button"
            onClick={onQuestClick}
            className="min-w-0 flex-1 text-left [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary"
            aria-label={`${proposal.questId}${proposal.title ? ` ${proposal.title}` : ""}`}
          >
            {title}
          </button>
        ) : (
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{title}</div>
        )}
        {proposal.presentedAt && (
          <time className="shrink-0 text-[11px] text-cc-muted" dateTime={new Date(proposal.presentedAt).toISOString()}>
            {new Date(proposal.presentedAt).toLocaleTimeString()}
          </time>
        )}
      </div>
      {proposal.summary && (
        <MarkdownContent
          text={proposal.summary}
          sessionId={sessionId}
          size="md"
          wrapLongContent
          questLinkSurface="chat-feed"
          className="[&>:first-child]:mt-0 [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm"
        />
      )}
      <QuestJourneyTimeline journey={proposal.journey} status={proposal.status} variant="vertical" />
    </div>
  );
}
