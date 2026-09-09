import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import type { ChatMessage } from "../types.js";
import type { LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { getEntryId, isUserBoundaryEntry, type FeedEntry, type Turn } from "../hooks/use-feed-model.js";
import { FeedEntries, isCompactableHerdEventEntry } from "./MessageFeedEntries.js";
import { CodexSubagentTurnSegment } from "./CodexSubagentTurnSegment.js";
import { TurnActivityDisclosure } from "./TurnActivitySummary.js";
import { AssistantQuestQuizContent, extractQuestQuizMarkerIds } from "./AssistantQuestQuizContent.js";
import {
  appendTimedMessagesFromEntries,
  buildMinuteBoundaryLabelMap,
  getTurnFeedBlockId,
  isTimedChatMessage,
} from "./message-feed-utils.js";
import type { FeedSection } from "./message-feed-sections.js";
import { PawTrailAvatar, HidePawContext } from "./PawTrail.js";
import { getAssistantVisibleMarkdown } from "../utils/assistant-message-renderability.js";
import { CompactFeedActivity } from "./CompactFeedActivity.js";
import {
  readyThreadResponseAppliesToTurn,
  threadResponsePresentationTouchesTurn,
  type ThreadResponsePresentation,
} from "./thread-response-presentation.js";
import { ReadyThreadResponseRows, readyThreadResponseTurnHasContent } from "./ReadyThreadResponseRows.js";
import { getTurnSummaryDurationMs } from "./message-feed-turn-duration.js";
import { InlineMessageTimingVisibilityContext } from "./MessageTimestamp.js";
import { TurnThreadStatusFooter } from "./MessageFeedThreadStatus.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";

function entryHasModelActivity(entry: FeedEntry): boolean {
  if (entry.kind !== "message") return true;
  return entry.msg.role === "assistant";
}

function turnPresentationEntries(turn: Turn): FeedEntry[] {
  return turn.presentationEntries ?? turn.allEntries;
}

function turnHasModelActivity(turn: Turn): boolean {
  return turnPresentationEntries(turn).some(entryHasModelActivity);
}

function latestStatusHostTurnId(sections: FeedSection[]): string | null {
  let latestTurnId: string | null = null;
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex--) {
    const turns = sections[sectionIndex].turns;
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
      const turn = turns[turnIndex];
      latestTurnId ??= turn.id;
      if (turnHasModelActivity(turn)) return turn.id;
    }
  }
  return latestTurnId;
}

function suppressRelocatedAnswersFromExpandedSourceTurns(
  presentation: ThreadResponsePresentation | null | undefined,
  expandedTurnIds: ReadonlySet<string>,
): ThreadResponsePresentation | null {
  if (!presentation) return null;
  const currentResponses = presentation.currentResponses.filter(
    (item) => item.anchorTurnId === item.sourceTurnId || !expandedTurnIds.has(item.sourceTurnId),
  );
  if (currentResponses.length === presentation.currentResponses.length) return presentation;
  return {
    ...presentation,
    currentResponses,
    currentResponseMessageIds: new Set(currentResponses.map((item) => item.response.currentMessageId)),
  };
}

function CollapsedTurnRows({
  turn,
  sessionId,
  currentThreadKey,
  minuteBoundaryLabels,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  questLinkSurface,
  threadResponsePresentation,
  activeNeedsInputAnchorMessageIds,
  preserveHostQuestQuiz,
}: {
  turn: Turn;
  sessionId: string;
  currentThreadKey: string;
  minuteBoundaryLabels: Map<string, string>;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  questLinkSurface: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
  activeNeedsInputAnchorMessageIds: ReadonlySet<string>;
  preserveHostQuestQuiz: boolean;
}) {
  const collapsedEntries = turn.collapsedEntries ?? [];
  if (threadResponsePresentation) {
    return (
      <ReadyThreadResponseRows
        turn={turn}
        presentation={threadResponsePresentation}
        sessionId={sessionId}
        questLinkSurface={questLinkSurface}
        activeNeedsInputAnchorMessageIds={activeNeedsInputAnchorMessageIds}
        renderEntry={(entry) => (
          <FeedEntries
            entries={[entry]}
            sessionId={sessionId}
            currentThreadKey={currentThreadKey}
            minuteBoundaryLabels={minuteBoundaryLabels}
            isCodexSession={isCodexSession}
            activeCodexTerminalIds={activeCodexTerminalIds}
            onOpenCodexTerminal={onOpenCodexTerminal}
            onSelectThread={onSelectThread}
            suppressThreadSystemMarkers
            questLinkSurface={questLinkSurface}
          />
        )}
      />
    );
  }
  // The fallback Ready path has no response presentation to carry a separate Quiz row.
  // Rebuild only directives already owned by this turn, and skip any representative that renders one itself.
  const hiddenHostQuizIds = preserveHostQuestQuiz
    ? (() => {
        const visibleQuizIds = new Set(
          collapsedEntries.flatMap((row) =>
            row.kind === "entry" && row.entry.kind === "message"
              ? extractQuestQuizMarkerIds(getAssistantVisibleMarkdown(row.entry.msg))
              : [],
          ),
        );
        return [
          ...new Set(
            turnPresentationEntries(turn).flatMap((entry) =>
              entry.kind === "message" && entry.msg.role === "assistant"
                ? extractQuestQuizMarkerIds(getAssistantVisibleMarkdown(entry.msg))
                : [],
            ),
          ),
        ].filter((questId) => !visibleQuizIds.has(questId));
      })()
    : [];
  return (
    <>
      {collapsedEntries.map((row) => {
        if (row.kind === "activity") return null;

        return (
          <div key={row.key} className="px-2.5 py-2 sm:px-3">
            <HidePawContext.Provider value={true}>
              {isCompactableHerdEventEntry(row.entry) ? (
                <CompactFeedActivity
                  segments={[{ kind: "worker_event", messages: [row.entry.msg] }]}
                  sessionId={sessionId}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={onOpenCodexTerminal}
                  questLinkSurface={questLinkSurface}
                />
              ) : (
                <FeedEntries
                  entries={[row.entry]}
                  sessionId={sessionId}
                  currentThreadKey={currentThreadKey}
                  minuteBoundaryLabels={minuteBoundaryLabels}
                  isCodexSession={isCodexSession}
                  activeCodexTerminalIds={activeCodexTerminalIds}
                  onOpenCodexTerminal={onOpenCodexTerminal}
                  onSelectThread={onSelectThread}
                  suppressThreadSystemMarkers
                  questLinkSurface={questLinkSurface}
                />
              )}
            </HidePawContext.Provider>
          </div>
        );
      })}
      {hiddenHostQuizIds.length > 0 && (
        <div className="min-w-0 px-2.5 pb-2 sm:px-3" data-testid="thread-response-quiz">
          <AssistantQuestQuizContent
            text={hiddenHostQuizIds.map((questId) => `{[(Quest Quiz: ${questId})]}`).join("\n")}
            sessionId={sessionId}
            questLinkSurface={questLinkSurface}
          />
        </div>
      )}
    </>
  );
}

interface TurnEntryRun {
  key: string;
  activity: boolean;
  entries: FeedEntry[];
}

function groupTurnActivity(turn: Turn, presentation?: ThreadResponsePresentation | null): TurnEntryRun[] {
  const activityIds = new Set(turn.agentEntries.map(getEntryId));
  const retainedIds = new Set(turn.subConclusions.map((item) => getEntryId(item.entry)));
  for (const response of presentation?.currentResponses ?? []) retainedIds.add(response.response.currentMessageId);
  const runs: TurnEntryRun[] = [];

  // Group only adjacent activity; an answer or decision breaks the guide without
  // moving any entry across it. Existing feed classification owns visibility.
  for (const entry of turnPresentationEntries(turn)) {
    const key = getEntryId(entry);
    const activity = activityIds.has(key) && !retainedIds.has(key);
    const previous = runs.at(-1);
    if (previous?.activity === activity) previous.entries.push(entry);
    else runs.push({ key, activity, entries: [entry] });
  }
  return runs;
}

export const TurnEntriesExpanded = memo(function TurnEntriesExpanded({
  turn,
  threadStatusFooter,
  ...feedProps
}: {
  turn: Turn;
  threadStatusFooter?: ReactNode;
} & Omit<ComponentProps<typeof FeedEntries>, "entries">) {
  const runs = useMemo(
    () => groupTurnActivity(turn, feedProps.threadResponsePresentation),
    [turn, feedProps.threadResponsePresentation],
  );
  return (
    <>
      {runs.map((run) => {
        const content = <FeedEntries {...feedProps} entries={run.entries} />;
        return (
          <div
            key={run.key}
            className={
              run.activity
                ? "space-y-2 border-l border-cc-border/70 pl-7 sm:space-y-3 sm:pl-9"
                : "space-y-2 sm:space-y-3"
            }
            data-turn-activity={run.activity ? "true" : undefined}
          >
            {run.activity ? <HidePawContext.Provider value={true}>{content}</HidePawContext.Provider> : content}
          </div>
        );
      })}
      {threadStatusFooter}
    </>
  );
});

export const TurnEntries = memo(function TurnEntries({
  sections,
  sessionId,
  currentThreadKey,
  leaderMode,
  showInlineMessageTiming,
  isCodexSession,
  activeCodexTerminalIds,
  onOpenCodexTerminal,
  onSelectThread,
  turnStates,
  toggleTurn,
  userBoundarySourceSessionId,
  questLinkSurface,
  threadResponsePresentation,
  activeNeedsInputAnchorMessageIds,
  visibleThreadStatuses,
  onThreadStatusLayoutContributionChange,
}: {
  sections: FeedSection[];
  sessionId: string;
  currentThreadKey: string;
  leaderMode: boolean;
  showInlineMessageTiming: boolean;
  isCodexSession: boolean;
  activeCodexTerminalIds: Set<string>;
  onOpenCodexTerminal: (toolUseId: string) => void;
  onSelectThread?: (threadKey: string) => void;
  turnStates: Array<{ defaultExpanded: boolean; isActivityExpanded: boolean } | undefined>;
  toggleTurn: (turnId: string) => void;
  userBoundarySourceSessionId?: string | null;
  questLinkSurface: QuestLinkSurface;
  threadResponsePresentation?: ThreadResponsePresentation | null;
  activeNeedsInputAnchorMessageIds: ReadonlySet<string>;
  visibleThreadStatuses: LeaderThreadStatus[];
  onThreadStatusLayoutContributionChange?: (height: number) => void;
}) {
  const turns = useMemo(() => sections.flatMap((section) => section.turns), [sections]);
  const expandedTurnIds = useMemo(
    () => new Set(turns.flatMap((turn, index) => (turnStates[index]?.isActivityExpanded === true ? [turn.id] : []))),
    [turns, turnStates],
  );
  const collapsedAnswerPresentation = useMemo(
    () => suppressRelocatedAnswersFromExpandedSourceTurns(threadResponsePresentation, expandedTurnIds),
    [expandedTurnIds, threadResponsePresentation],
  );
  const latestThreadResponseUpdatedAt = Math.max(
    0,
    ...(threadResponsePresentation?.currentResponses
      .filter((item) => item.response.coveredUserMessageIds.length > 0)
      .map((item) => item.response.updatedAt) ?? []),
  );
  const readyThreadResponsePresentation =
    threadResponsePresentation?.ready &&
    visibleThreadStatuses.some((status) => status.kind === "ready" && status.timestamp >= latestThreadResponseUpdatedAt)
      ? threadResponsePresentation
      : null;
  const threadStatusFooterTurnId = useMemo(
    () => (visibleThreadStatuses.length > 0 ? latestStatusHostTurnId(sections) : null),
    [sections, visibleThreadStatuses.length],
  );
  const minuteBoundaryLabels = useMemo(() => {
    const visibleTimedMessages: ChatMessage[] = [];

    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index];
      const isActivityExpanded = turnStates[index]?.isActivityExpanded ?? false;

      if (turn.userEntry?.kind === "message" && isTimedChatMessage(turn.userEntry.msg)) {
        visibleTimedMessages.push(turn.userEntry.msg);
      }

      if (isActivityExpanded) {
        appendTimedMessagesFromEntries(turnPresentationEntries(turn), visibleTimedMessages);
      } else if (
        !readyThreadResponsePresentation ||
        !readyThreadResponseAppliesToTurn(turn, readyThreadResponsePresentation)
      ) {
        appendTimedMessagesFromEntries(turn.systemEntries, visibleTimedMessages);
      }
    }

    return buildMinuteBoundaryLabelMap(visibleTimedMessages);
  }, [readyThreadResponsePresentation, turns, turnStates]);
  return (
    <InlineMessageTimingVisibilityContext.Provider value={showInlineMessageTiming}>
      {(() => {
        let globalIndex = 0;
        return sections.map((section) => (
          <div key={section.id} data-feed-section-id={section.id} className="space-y-3 sm:space-y-5">
            {section.turns.map((turn) => {
              const turnIndex = globalIndex++;
              const turnState = turnStates[turnIndex];
              const isActivityExpanded = turnState?.isActivityExpanded ?? false;
              const preserveHostQuestQuiz = turnIndex === turns.length - 1 && turnState?.defaultExpanded === false;
              const expandedThreadResponsePresentation =
                threadResponsePresentation && readyThreadResponseAppliesToTurn(turn, threadResponsePresentation)
                  ? threadResponsePresentation
                  : null;
              const currentAnswerBelongsToTurn =
                collapsedAnswerPresentation != null &&
                threadResponsePresentationTouchesTurn(turn, collapsedAnswerPresentation);
              const collapsedThreadResponsePresentation =
                readyThreadResponsePresentation &&
                collapsedAnswerPresentation &&
                readyThreadResponseAppliesToTurn(turn, readyThreadResponsePresentation)
                  ? collapsedAnswerPresentation
                  : collapsedAnswerPresentation &&
                      currentAnswerBelongsToTurn &&
                      readyThreadResponseAppliesToTurn(turn, collapsedAnswerPresentation)
                    ? collapsedAnswerPresentation
                    : null;
              const hasCollapsedContent = collapsedThreadResponsePresentation
                ? readyThreadResponseTurnHasContent(
                    turn,
                    collapsedThreadResponsePresentation,
                    activeNeedsInputAnchorMessageIds,
                  )
                : (turn.collapsedEntries?.some((row) => row.kind === "entry") ?? false) ||
                  turn.subConclusions.length > 0;
              const hasCollapsedCurrentAnswer =
                collapsedThreadResponsePresentation?.currentResponses.some((item) => item.anchorTurnId === turn.id) ??
                false;
              const turnSummaryDuration = getTurnSummaryDurationMs(turn, turns[turnIndex + 1] ?? null, leaderMode);
              const showThreadStatusFooter = turn.id === threadStatusFooterTurnId;
              const threadStatusFooter = showThreadStatusFooter ? (
                <TurnThreadStatusFooter
                  statuses={visibleThreadStatuses}
                  currentThreadKey={currentThreadKey}
                  onSelectThread={onSelectThread}
                  onLayoutContributionChange={onThreadStatusLayoutContributionChange}
                />
              ) : null;

              return (
                <div key={turn.id}>
                  <div
                    data-turn-id={turn.id}
                    data-feed-block-id={getTurnFeedBlockId(turn.id)}
                    className="turn-container space-y-2 sm:space-y-3"
                    data-user-turn={
                      isUserBoundaryEntry(turn.userEntry, userBoundarySourceSessionId) ? "true" : undefined
                    }
                  >
                    {turn.userEntry && (
                      <FeedEntries
                        entries={[turn.userEntry]}
                        sessionId={sessionId}
                        currentThreadKey={currentThreadKey}
                        minuteBoundaryLabels={minuteBoundaryLabels}
                        isCodexSession={isCodexSession}
                        activeCodexTerminalIds={activeCodexTerminalIds}
                        onOpenCodexTerminal={onOpenCodexTerminal}
                        onSelectThread={onSelectThread}
                        questLinkSurface={questLinkSurface}
                      />
                    )}

                    {turnPresentationEntries(turn).length > 0 && (
                      <div className="min-w-0 pl-7 sm:pl-9">
                        <TurnActivityDisclosure
                          stats={turn.stats}
                          durationMs={turnSummaryDuration}
                          expanded={isActivityExpanded}
                          onToggle={() => toggleTurn(turn.id)}
                        />
                      </div>
                    )}
                    {!isActivityExpanded && !collapsedThreadResponsePresentation && (
                      <CodexSubagentTurnSegment sessionId={sessionId} turnId={turn.id} />
                    )}
                    {isActivityExpanded ? (
                      turnPresentationEntries(turn).length > 0 && (
                        <TurnEntriesExpanded
                          turn={turn}
                          sessionId={sessionId}
                          currentThreadKey={currentThreadKey}
                          threadStatusFooter={threadStatusFooter}
                          minuteBoundaryLabels={minuteBoundaryLabels}
                          isCodexSession={isCodexSession}
                          activeCodexTerminalIds={activeCodexTerminalIds}
                          onOpenCodexTerminal={onOpenCodexTerminal}
                          onSelectThread={onSelectThread}
                          questLinkSurface={questLinkSurface}
                          threadResponsePresentation={expandedThreadResponsePresentation}
                        />
                      )
                    ) : (
                      <>
                        {!collapsedThreadResponsePresentation && turn.systemEntries.length > 0 && (
                          <FeedEntries
                            entries={turn.systemEntries}
                            sessionId={sessionId}
                            currentThreadKey={currentThreadKey}
                            minuteBoundaryLabels={minuteBoundaryLabels}
                            isCodexSession={isCodexSession}
                            activeCodexTerminalIds={activeCodexTerminalIds}
                            onOpenCodexTerminal={onOpenCodexTerminal}
                            onSelectThread={onSelectThread}
                            suppressThreadSystemMarkers
                            questLinkSurface={questLinkSurface}
                          />
                        )}
                        {hasCollapsedContent && (
                          <div
                            className={
                              hasCollapsedCurrentAnswer
                                ? "flex min-w-0 items-start"
                                : "flex min-w-0 items-start gap-2 sm:gap-3"
                            }
                            data-testid={hasCollapsedCurrentAnswer ? "thread-response-collapsed-shell" : undefined}
                          >
                            {!hasCollapsedCurrentAnswer && <PawTrailAvatar />}
                            <div className="flex-1 min-w-0 rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
                              {!collapsedThreadResponsePresentation && turn.subConclusions.length > 0 && (
                                <div className="px-3 pt-2 space-y-1.5">
                                  <HidePawContext.Provider value={true}>
                                    {turn.subConclusions.map((sc, scIdx) => (
                                      <FeedEntries
                                        key={scIdx}
                                        entries={[sc.entry]}
                                        sessionId={sessionId}
                                        currentThreadKey={currentThreadKey}
                                        isCodexSession={isCodexSession}
                                        activeCodexTerminalIds={activeCodexTerminalIds}
                                        onOpenCodexTerminal={onOpenCodexTerminal}
                                        onSelectThread={onSelectThread}
                                        questLinkSurface={questLinkSurface}
                                      />
                                    ))}
                                  </HidePawContext.Provider>
                                </div>
                              )}
                              <CollapsedTurnRows
                                turn={turn}
                                sessionId={sessionId}
                                currentThreadKey={currentThreadKey}
                                minuteBoundaryLabels={minuteBoundaryLabels}
                                isCodexSession={isCodexSession}
                                activeCodexTerminalIds={activeCodexTerminalIds}
                                onOpenCodexTerminal={onOpenCodexTerminal}
                                onSelectThread={onSelectThread}
                                questLinkSurface={questLinkSurface}
                                threadResponsePresentation={collapsedThreadResponsePresentation}
                                activeNeedsInputAnchorMessageIds={activeNeedsInputAnchorMessageIds}
                                preserveHostQuestQuiz={preserveHostQuestQuiz}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {(!isActivityExpanded || turnPresentationEntries(turn).length === 0) && threadStatusFooter}
                  </div>
                </div>
              );
            })}
          </div>
        ));
      })()}
    </InlineMessageTimingVisibilityContext.Provider>
  );
});
