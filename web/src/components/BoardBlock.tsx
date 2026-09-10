import { useState, useRef, useCallback, memo } from "react";
import { CollapseFooter } from "./CollapseFooter.js";
import { useStore } from "../store.js";
import { BoardTable, QuestLink } from "./BoardTable.js";
import { ToolBlock } from "./ToolBlock.js";
import {
  formatQuestJourneyText,
  formatWaitForRefLabel,
  getWaitForRefKind,
  type BoardQueueWarning,
} from "../../shared/quest-journey.js";
import { QuestJourneyProposalReview } from "./QuestJourneyProposalReview.js";
import type { BoardRowSessionStatus } from "../types.js";
import type { QuestJourneyPlanState } from "../../shared/quest-journey.js";

// Re-export for backward compatibility (ToolBlock imports BoardRowData from here)
export type { BoardRowData } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";

interface BoardBlockProps {
  board: BoardRowData[];
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
  operation?: string;
  queueWarnings?: BoardQueueWarning[];
  proposalReview?: BoardProposalReviewPayload;
  toolUseId?: string;
  sessionId?: string;
  originalCommand?: string;
  originalToolName?: string;
  originalInput?: Record<string, unknown>;
  defaultOpen?: boolean;
  defaultShowOriginalCommand?: boolean;
}

export interface BoardProposalReviewPayload {
  questId: string;
  title?: string;
  status: string;
  journey: QuestJourneyPlanState;
  presentedAt: number;
  summary?: string;
  scheduling?: Record<string, unknown>;
}

function notificationLabel(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId.trim());
  return match ? match[1] : notificationId;
}

function ProposalDependencyRow({ row }: { row?: BoardRowData }) {
  const waitFor = row?.waitFor ?? [];
  const waitForInput = row?.waitForInput ?? [];
  if (waitFor.length === 0 && waitForInput.length === 0) return null;

  return (
    <div className="border-t border-cc-border bg-cc-bg/20 px-3 py-2" data-testid="proposal-dependency-row">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/70">Waiting on</div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cc-muted">
        {waitFor.map((ref, index) => {
          const kind = getWaitForRefKind(ref);
          return (
            <span key={["wait", ref, index].join(":")} className="inline-flex items-center gap-1">
              {kind === "quest" ? <QuestLink questId={ref} /> : <span>{formatWaitForRefLabel(ref)}</span>}
            </span>
          );
        })}
        {waitForInput.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <span>input</span>
            <span className="font-mono-code">{waitForInput.map(notificationLabel).join(", ")}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible card that renders the leader's work board inline in the chat feed.
 * Displayed when a `takode board` CLI command yields explicit board JSON or
 * when ToolBlock can fall back to the live server-authoritative board state.
 */
export const BoardBlock = memo(function BoardBlock({
  board,
  rowSessionStatuses,
  operation,
  queueWarnings,
  proposalReview,
  toolUseId,
  sessionId,
  originalCommand,
  originalToolName,
  originalInput,
  defaultOpen = false,
  defaultShowOriginalCommand = false,
}: BoardBlockProps) {
  const liveRowSessionStatuses = useStore((s) => (sessionId ? s.sessionBoardRowStatuses.get(sessionId) : undefined));
  const effectiveRowSessionStatuses = rowSessionStatuses ?? liveRowSessionStatuses;

  const [open, setOpen] = useState(defaultOpen || !!proposalReview);
  const [showOriginalCommand, setShowOriginalCommand] = useState(defaultShowOriginalCommand);
  const canShowOriginalCommand = !!originalToolName && !!originalInput && !!toolUseId && !!sessionId;

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleOriginalCommandToggle = useCallback(() => {
    setOpen(true);
    setShowOriginalCommand((prev) => !prev);
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  const formattedOperation = operation ? formatQuestJourneyText(operation) : undefined;
  const proposalRow = proposalReview
    ? board.find((row) => row.questId.toLowerCase() === proposalReview.questId.toLowerCase())
    : undefined;
  const commandPreview = originalCommand
    ? originalCommand.length > 60
      ? `${originalCommand.slice(0, 60)}...`
      : originalCommand
    : "Work Board";
  const rawCommandToggle = canShowOriginalCommand && (
    <button
      type="button"
      onClick={handleOriginalCommandToggle}
      className="shrink-0 rounded-md border border-cc-border px-2 py-1 text-[11px] font-medium text-cc-muted hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary"
      aria-pressed={showOriginalCommand}
      title={originalCommand ? `Original command: ${originalCommand}` : "Show raw command output"}
    >
      {showOriginalCommand ? "Hide raw" : "Show raw"}
    </button>
  );

  return (
    <div className="min-w-0 border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <div ref={headerRef} className="flex items-center gap-2 pr-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={handleToggle}
          className="min-w-0 flex flex-1 items-center gap-2.5 px-3 py-2.5 text-left hover:bg-cc-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cc-primary"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
            <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
          </svg>
          <span
            className={`min-w-0 flex-1 truncate text-xs text-cc-fg/90 ${proposalReview ? "font-medium" : "font-mono-code"}`}
            title={proposalReview ? "Journey Proposal" : originalCommand || commandPreview}
          >
            {proposalReview ? "Journey Proposal" : commandPreview}
          </span>
          {!proposalReview && (
            <span className="text-xs text-cc-muted ml-auto">
              {board.length} {board.length === 1 ? "item" : "items"}
            </span>
          )}
        </button>
        {proposalReview && rawCommandToggle}
      </div>

      {open && (
        <div className="border-t border-cc-border">
          {!proposalReview && (formattedOperation || canShowOriginalCommand) && (
            <div className="flex items-center justify-between gap-3 border-b border-cc-border px-3 py-2 bg-cc-bg/20">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-wider text-cc-muted">Work Board</div>
                {formattedOperation && (
                  <div className="mt-0.5 truncate text-xs text-cc-muted">{formattedOperation}</div>
                )}
              </div>
              {rawCommandToggle}
            </div>
          )}
          {queueWarnings && queueWarnings.length > 0 && (
            <div className="border-b border-cc-border px-3 py-2 bg-amber-500/10">
              <div className="text-[10px] font-medium uppercase tracking-wider text-amber-300/80">Queue Warnings</div>
              <div className="mt-1 space-y-1">
                {queueWarnings.map((warning) => (
                  <div key={`${warning.questId}:${warning.kind}`} className="text-xs text-amber-100/90">
                    {warning.summary}
                    {warning.action ? ` Next: ${warning.action}` : ""}
                  </div>
                ))}
              </div>
            </div>
          )}
          {showOriginalCommand && canShowOriginalCommand && (
            <div className="border-b border-cc-border px-3 py-3 bg-cc-bg/30">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-cc-muted">
                Original command
              </div>
              {proposalReview && formattedOperation && (
                <div className="mb-2 text-xs text-cc-muted">{formattedOperation}</div>
              )}
              <ToolBlock
                name={originalToolName}
                input={originalInput}
                toolUseId={toolUseId}
                sessionId={sessionId}
                defaultOpen
                disableInlineSpecialCases
              />
            </div>
          )}
          {proposalReview && (
            <QuestJourneyProposalReview
              proposal={proposalReview}
              sessionId={sessionId}
              onQuestClick={() => useStore.getState().openQuestOverlay(proposalReview.questId)}
            />
          )}
          {proposalReview ? (
            <ProposalDependencyRow row={proposalRow} />
          ) : (
            <BoardTable board={board} rowSessionStatuses={effectiveRowSessionStatuses} />
          )}
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
});
