import type { ReactNode } from "react";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";
import { AssistantQuestQuizContent } from "./AssistantQuestQuizContent.js";
import { HidePawContext } from "./PawTrail.js";
import { collapsedResponseEntry, type ThreadResponsePresentation } from "./thread-response-presentation.js";
import { ThreadResponseCoverageBadge } from "./ThreadResponsePresentationChrome.js";
import { isBoardProposalMessage, isNeedsInputNotifyMessage } from "../utils/takode-tool-command.js";

function presentationEntries(turn: Turn): readonly FeedEntry[] {
  return turn.presentationEntries ?? turn.allEntries;
}

function sourceDecisionEntries(
  turn: Turn,
  activeNeedsInputAnchorMessageIds: ReadonlySet<string>,
  excludedMessageIds: ReadonlySet<string>,
): Array<{ entry: Extract<FeedEntry, { kind: "message" }>; order: number }> {
  const seenMessageIds = new Set<string>();
  return presentationEntries(turn).flatMap((entry, order) => {
    if (entry.kind !== "message") return [];
    const messageId = entry.msg.id;
    // Structured decisions stay at their original source even after resolution.
    // Ordinary resolved prose prompts still lose their active pin as before.
    const hasSourceDecision =
      isBoardProposalMessage(entry.msg) ||
      (entry.msg.notification?.category === "needs-input" && isNeedsInputNotifyMessage(entry.msg));
    if (
      (!activeNeedsInputAnchorMessageIds.has(messageId) && !hasSourceDecision) ||
      excludedMessageIds.has(messageId) ||
      seenMessageIds.has(messageId)
    ) {
      return [];
    }
    seenMessageIds.add(messageId);
    return [{ entry, order }];
  });
}

export function readyThreadResponseTurnHasContent(
  turn: Turn,
  presentation: ThreadResponsePresentation,
  activeNeedsInputAnchorMessageIds: ReadonlySet<string> = new Set(),
): boolean {
  if (presentation.currentResponses.some((item) => item.anchorTurnId === turn.id)) return true;
  if (
    sourceDecisionEntries(turn, activeNeedsInputAnchorMessageIds, presentation.currentResponseMessageIds).length > 0
  ) {
    return true;
  }
  if (presentation.quizGroups.some((group) => group.hostTurnId === turn.id && group.questIds.length > 0)) return true;
  return false;
}

export function ReadyThreadResponseRows({
  turn,
  presentation,
  renderEntry,
  sessionId,
  questLinkSurface,
  activeNeedsInputAnchorMessageIds = new Set(),
}: {
  turn: Turn;
  presentation: ThreadResponsePresentation;
  renderEntry: (entry: FeedEntry) => ReactNode;
  sessionId: string;
  questLinkSurface: QuestLinkSurface;
  activeNeedsInputAnchorMessageIds?: ReadonlySet<string>;
}) {
  const responses = presentation.currentResponses.filter((item) => item.anchorTurnId === turn.id);
  const responseMessageIds = new Set(responses.map((item) => item.response.currentMessageId));
  const promptEntries = sourceDecisionEntries(turn, activeNeedsInputAnchorMessageIds, responseMessageIds);
  const quizGroup = presentation.quizGroups.find((group) => group.hostTurnId === turn.id);
  const rows = [
    ...responses.map((item, responseOrder) => ({
      kind: "response" as const,
      item,
      order: item.response.currentHistoryIndex,
      fallbackOrder: responseOrder,
    })),
    ...promptEntries.map(({ entry, order }) => ({
      kind: "prompt" as const,
      // A pinned source keeps its prose and notification, while only this
      // turn's grouped directives move into the separate Quiz row below.
      entry:
        quizGroup &&
        entry.msg.role === "assistant" &&
        Number.isInteger(entry.msg.historyIndex) &&
        entry.msg.historyIndex! >= presentation.cutoverHistoryIndex
          ? collapsedResponseEntry(entry, (questId) => quizGroup.questIds.includes(questId))
          : entry,
      order: Number.isInteger(entry.msg.historyIndex) ? entry.msg.historyIndex! : Number.MAX_SAFE_INTEGER,
      fallbackOrder: order,
    })),
  ].sort((left, right) => left.order - right.order || left.fallbackOrder - right.fallbackOrder);

  return (
    <>
      {rows.map((row) =>
        row.kind === "response" ? (
          <div
            key={row.item.response.currentMessageId}
            className="min-w-0 px-2.5 py-2 sm:px-3"
            data-testid="thread-response-current"
          >
            <ThreadResponseCoverageBadge
              messageCount={row.item.response.answerUserMessageIds.length}
              referencedMessages={row.item.referencedUserMessages}
              className="mb-1.5"
            />
            <HidePawContext.Provider value={true}>
              {renderEntry(row.item.collapsedMessageEntry)}
            </HidePawContext.Provider>
          </div>
        ) : (
          <div
            key={`needs-input-prompt:${row.entry.msg.id}`}
            className="min-w-0 px-2.5 py-2 sm:px-3"
            data-testid="thread-response-needs-input-prompt"
          >
            <HidePawContext.Provider value={true}>{renderEntry(row.entry)}</HidePawContext.Provider>
          </div>
        ),
      )}
      {quizGroup && quizGroup.questIds.length > 0 && (
        <div className="min-w-0 px-2.5 pb-2 sm:px-3" data-testid="thread-response-quiz">
          <AssistantQuestQuizContent
            text={quizGroup.questIds.map((questId) => `{[(Quest Quiz: ${questId})]}`).join("\n")}
            sessionId={sessionId}
            questLinkSurface={questLinkSurface}
          />
        </div>
      )}
    </>
  );
}
