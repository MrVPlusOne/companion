import { useMemo, useState } from "react";
import { buildThreadContinuationFixture } from "../../../shared/test-fixtures/thread-continuation.js";
import { buildThreadWindowSync } from "../../../shared/thread-window.js";
import { buildFeedModel } from "../../hooks/use-feed-model.js";
import { normalizeHistoryMessageToChatMessages } from "../../utils/history-message-normalization.js";
import { buildFeedMessageModel } from "../../utils/feed-render-model.js";
import { buildFeedSections } from "../message-feed-sections.js";
import { TurnEntries } from "../MessageFeedTurns.js";
import { PlaygroundSectionGroup, Section } from "./shared.js";

const EMPTY_IDS = new Set<string>();
const NOOP = () => {};

export function PlaygroundThreadContinuationSection() {
  const [source, setSource] = useState<"main" | "q-42">("q-42");
  const [thread, setThread] = useState("q-42");
  const [stage, setStage] = useState<"away" | "returned" | "departedAgain">("away");
  const [expanded, setExpanded] = useState(true);
  const sections = useMemo(() => {
    const history = buildThreadContinuationFixture(source)[stage];
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: thread,
      fromItem: -1,
      itemCount: 20,
      sectionItemCount: 5,
      visibleItemCount: 4,
    });
    const model = buildFeedMessageModel({
      leaderSessionId: "playground-continuation",
      threadKey: thread,
      projectThreadRoutes: true,
      allMessages: [],
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages: sync.entries.flatMap((entry) =>
        normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
      ),
    });
    return buildFeedSections(buildFeedModel(model.messages, true).turns);
  }, [source, stage, thread]);

  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Temporary Continuation Notices"
        description="One departure notice remains while work is away. Returning clears it; All Threads preserves the audit."
      >
        <div data-testid="playground-thread-continuation" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label>
              Scenario{" "}
              <select
                aria-label="Continuation source"
                value={source}
                className="rounded bg-cc-hover p-2"
                onChange={(event) => {
                  const next = event.target.value === "main" ? "main" : "q-42";
                  setSource(next);
                  setThread(next);
                }}
              >
                <option value="q-42">Quest thread</option>
                <option value="main">Main</option>
              </select>
            </label>
            {(
              [
                ["away", "Work away"],
                ["returned", "Work returned"],
                ["departedAgain", "Work left again"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={stage === value}
                onClick={() => setStage(value)}
                className="min-h-11 rounded border border-cc-border px-3 hover:bg-cc-hover"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" onClick={() => setThread(source)} className="min-h-11 text-cc-primary">
              Source thread
            </button>
            <button type="button" onClick={() => setThread("all")} className="min-h-11 text-cc-primary">
              All Threads
            </button>
            <span>Viewing {thread === "all" ? "All Threads" : thread === "main" ? "Main" : `thread:${thread}`}</span>
          </div>
          <div className="max-h-[620px] overflow-y-auto rounded-xl bg-cc-bg p-3 sm:p-6" data-testid="continuation-feed">
            <TurnEntries
              sections={sections}
              sessionId="playground-continuation"
              currentThreadKey={thread}
              leaderMode
              showInlineMessageTiming={false}
              isCodexSession
              activeCodexTerminalIds={EMPTY_IDS}
              onOpenCodexTerminal={NOOP}
              onSelectThread={setThread}
              turnStates={sections.flatMap((section) =>
                section.turns.map(() => ({ defaultExpanded: true, isActivityExpanded: expanded })),
              )}
              toggleTurn={() => setExpanded((value) => !value)}
              questLinkSurface="chat-feed"
              activeNeedsInputAnchorMessageIds={EMPTY_IDS}
              visibleThreadStatuses={[]}
            />
          </div>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
