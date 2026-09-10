import type { BrowserIncomingMessage } from "../../server/session-types.js";
import {
  appendThreadTransitionMarkerForRouteSwitch,
  threadRouteForTarget,
} from "../../server/thread-routing-metadata.js";

/** Synthetic repeated departures produced by the real route-switch writer. */
export function buildThreadContinuationFixture(source: "main" | "q-42" = "q-42") {
  const history: BrowserIncomingMessage[] = [
    {
      type: "user_message",
      id: "continuation-request",
      content: "Check the list and its detail view.",
      timestamp: 1789066800000,
      ...threadRouteForTarget(source),
    },
  ];
  const work = (threadKey: string, text: string) => {
    const timestamp = 1789066800000 + history.length * 1000;
    const route = threadRouteForTarget(threadKey);
    appendThreadTransitionMarkerForRouteSwitch(history, route, timestamp);
    history.push({
      type: "assistant",
      message: {
        id: `continuation-work-${history.length}`,
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      timestamp,
      parent_tool_use_id: null,
      ...route,
    });
  };
  for (let pass = 1; pass <= 3; pass++) {
    work(source, `Checking the list, pass ${pass}.`);
    work("q-43", `Checking the detail view, pass ${pass}.`);
  }
  const away = [...history];
  work(source, "Back in this thread: the list checks passed.");
  const returned = [...history];
  work("q-43", "Continuing with the final detail-view check.");
  return { source, away, returned, departedAgain: history };
}
