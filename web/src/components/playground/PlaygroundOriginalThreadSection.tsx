import { useMemo, useState } from "react";
import { buildThreadWindowSync } from "../../../shared/thread-window.js";
import { originalThreadRequest } from "../../../shared/test-fixtures/original-thread-visibility.js";
import { normalizeHistoryMessageToChatMessages } from "../../utils/history-message-normalization.js";
import { filterMessagesForThread } from "../../utils/thread-projection.js";
import { MessageBubble } from "../MessageBubble.js";
import { Card, PlaygroundSectionGroup, Section } from "./shared.js";

export function PlaygroundOriginalThreadSection() {
  const [origin, setOrigin] = useState("main");
  const [view, setView] = useState<"original" | "destination" | "all">("original");
  const history = useMemo(() => [originalThreadRequest(origin, origin === "main" ? "explicit" : "backfill")], [origin]);
  const threadKey = view === "original" ? origin : view === "destination" ? "q-42" : "all";
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey,
    fromItem: -1,
    itemCount: 1,
    sectionItemCount: 1,
    visibleItemCount: 1,
  });
  const messages = filterMessagesForThread(
    sync.entries.flatMap((entry) => normalizeHistoryMessageToChatMessages(entry.message, entry.history_index)),
    threadKey,
  );
  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Original Thread Visibility"
        description="A request stays findable in its original thread and the destination while ongoing work keeps its assigned owner."
      >
        <Card label="Original and destination views">
          <div className="space-y-4" data-testid="playground-original-thread-visibility">
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["main", "Main handoff"],
                  ["q-41", "Quest attachment"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="min-h-11 rounded border border-cc-border px-3 text-xs aria-pressed:bg-cc-primary/15 aria-pressed:text-cc-primary"
                  aria-pressed={origin === key}
                  onClick={() => setOrigin(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {(["original", "destination", "all"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="min-h-11 rounded border border-cc-border px-3 text-xs aria-pressed:bg-cc-primary/15 aria-pressed:text-cc-primary"
                  aria-pressed={view === key}
                  onClick={() => setView(key)}
                >
                  {key === "original"
                    ? "Original thread"
                    : key === "destination"
                      ? "Destination thread"
                      : "All Threads"}
                </button>
              ))}
            </div>
            <div className="min-w-0 rounded border border-cc-border p-3" data-view-thread={threadKey}>
              {messages.map((message) => (
                <div key={message.id} data-source-id={message.id}>
                  <MessageBubble
                    message={message}
                    currentThreadKey={threadKey}
                    interactionMode="read-only"
                    showSideChatActions={false}
                    showTimestamp={false}
                  />
                </div>
              ))}
            </div>
          </div>
        </Card>
      </Section>
    </PlaygroundSectionGroup>
  );
}
