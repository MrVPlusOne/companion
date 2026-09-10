import { useEffect, useMemo, useState } from "react";
import { buildFeedModel } from "../../hooks/use-feed-model.js";
import { useStore } from "../../store.js";
import { buildTurnActivityFixtureWindow, turnActivityFixture } from "../../test-fixtures/turn-activity-disclosure.js";
import { normalizeHistoryMessageToChatMessages } from "../../utils/history-message-normalization.js";
import { filterMessagesForThread } from "../../utils/thread-projection.js";
import { buildFeedSections } from "../message-feed-sections.js";
import { TurnEntries } from "../MessageFeedTurns.js";
import { resolveThreadResponses } from "../thread-response-presentation.js";
import { TurnActivityDisclosure } from "../TurnActivitySummary.js";
import { PlaygroundSectionGroup, Section } from "./shared.js";

const EMPTY_IDS = new Set<string>();
const NOOP = () => {};

export function PlaygroundTurnActivitySection() {
  const [expanded, setExpanded] = useState(false);
  const [longExpanded, setLongExpanded] = useState(false);
  const { sections, presentation } = useMemo(() => {
    const sync = buildTurnActivityFixtureWindow();
    const proof = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );
    const messages = filterMessagesForThread(proof, turnActivityFixture.threadKey);
    const sections = buildFeedSections(buildFeedModel(messages, true).turns);
    return {
      sections,
      presentation: resolveThreadResponses(
        sections,
        sync.threadResponseProjection,
        turnActivityFixture.threadKey,
        true,
        proof,
      ),
    };
  }, []);

  useEffect(() => {
    // Tool previews are local fixture data. No backend session or search provider
    // is created, and cleanup restores only this fixture's transient map.
    const sessionId = turnActivityFixture.sessionId;
    const previous = useStore.getState().toolResults.get(sessionId);
    const previews = new Map(
      turnActivityFixture.history.flatMap((message) =>
        message.type === "tool_result_preview"
          ? message.previews.map((preview) => [preview.tool_use_id, preview] as const)
          : [],
      ),
    );
    useStore.setState((state) => ({ toolResults: new Map(state.toolResults).set(sessionId, previews) }));
    return () => {
      useStore.setState((state) => {
        if (state.toolResults.get(sessionId) !== previews) return state;
        const toolResults = new Map(state.toolResults);
        if (previous) toolResults.set(sessionId, previous);
        else toolResults.delete(sessionId);
        return { toolResults };
      });
    };
  }, []);

  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Turn Activity"
        description="The summary aligns with the guide. Returned-work notices have cleared, background activity stays together, and both answers remain separate."
      >
        <div
          className="max-h-[720px] max-w-4xl space-y-3 overflow-y-auto rounded-xl bg-cc-bg p-3 sm:p-6"
          data-testid="playground-turn-activity"
        >
          <TurnEntries
            sections={sections}
            sessionId={turnActivityFixture.sessionId}
            currentThreadKey={turnActivityFixture.threadKey}
            leaderMode
            showInlineMessageTiming={false}
            isCodexSession
            activeCodexTerminalIds={EMPTY_IDS}
            onOpenCodexTerminal={NOOP}
            turnStates={sections.flatMap((section) =>
              section.turns.map(() => ({ defaultExpanded: false, isActivityExpanded: expanded })),
            )}
            toggleTurn={() => setExpanded((value) => !value)}
            questLinkSurface="chat-feed"
            threadResponsePresentation={presentation}
            activeNeedsInputAnchorMessageIds={EMPTY_IDS}
            visibleThreadStatuses={[]}
          />
        </div>
      </Section>
      <Section title="Long Turn Duration" description="Hour-long summaries show hours and minutes in both states.">
        <div data-testid="playground-turn-duration">
          <TurnActivityDisclosure
            stats={{ messageCount: 9, toolCount: 18, subagentCount: 0, herdEventCount: 5 }}
            durationMs={62_024_000}
            expanded={longExpanded}
            onToggle={() => setLongExpanded((value) => !value)}
          />
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
