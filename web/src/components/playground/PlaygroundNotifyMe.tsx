import { useState } from "react";
import { NotifyMeControlView, NotifyMeIcon } from "../NotifyMe.js";
import { NotifyMeResults } from "../GlobalNotifyMeMenu.js";
import { Card } from "./shared.js";
import type { ThreadMonitoringEntry } from "../../../shared/thread-monitoring.js";

export function PlaygroundNotifyMe() {
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(true);
  const entries: ThreadMonitoringEntry[] = enabled
    ? [
        {
          sessionId: "notify-me-preview",
          sessionName: "Design workspace",
          sessionNum: 12,
          threadKey: "q-42",
          title: "Compare navigation designs",
          trackedAt: 1,
          pending: pending
            ? {
                id: "1",
                messageId: "result",
                timestamp: Date.UTC(2026, 8, 11, 17),
                summary: "The comparison is ready. A compact header keeps the task controls within reach.",
              }
            : null,
        },
      ]
    : [];
  return (
    <Card label="Notify Me: persistent monitored results">
      <div className="space-y-3 p-3" data-testid="playground-notify-me">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-t-lg border border-cc-border px-2 py-1 text-xs text-cc-fg">
            {enabled && <NotifyMeIcon pending={pending} />}Compare navigation designs
          </span>
          <NotifyMeControlView
            enabled={enabled}
            pending={enabled && pending}
            onToggle={() => {
              setEnabled(!enabled);
              setPending(false);
            }}
            onAcknowledge={() => setPending(false)}
          />
        </div>
        <div className="max-w-[400px] overflow-hidden rounded-xl border border-cc-border bg-cc-card">
          <div className="border-b border-cc-border px-3 py-2 text-xs font-semibold text-cc-fg">
            Notify Me · {enabled && pending ? "1 result waiting" : "All tracked"}
          </div>
          <NotifyMeResults
            entries={entries}
            onOpen={() => {}}
            onAction={(_entry, action) => {
              setPending(false);
              if (action === "untrack") setEnabled(false);
            }}
          />
        </div>
        <button
          type="button"
          className="text-xs text-cc-info hover:underline cursor-pointer"
          onClick={() => {
            setEnabled(true);
            setPending(true);
          }}
        >
          Show a new Ready result
        </button>
      </div>
    </Card>
  );
}
