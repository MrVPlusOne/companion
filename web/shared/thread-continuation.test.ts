import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import { appendThreadTransitionMarkerForRouteSwitch, threadRouteForTarget } from "../server/thread-routing-metadata.js";
import { normalizeHistoryMessageToChatMessages } from "../src/utils/history-message-normalization.js";
import { currentThreadContinuationId } from "./thread-continuation.js";
import { buildThreadContinuationFixture } from "./test-fixtures/thread-continuation.js";
import { buildThreadWindowSync } from "./thread-window.js";

const markerIds = (history: readonly BrowserIncomingMessage[]) =>
  history.flatMap((message) => (message.type === "thread_transition_marker" ? [message.id] : []));

describe("temporary thread continuation", () => {
  it.each(["main", "q-42"] as const)("keeps only the current %s departure across repeated returns", (source) => {
    // The real producer emits no inbound marker for Main, so its own assistant
    // output must clear the notice just as a quest's incoming transition does.
    const fixture = buildThreadContinuationFixture(source);
    const before = JSON.stringify(fixture);
    for (const [history, expected] of [
      [fixture.away, markerIds(fixture.away).at(-1)!],
      [fixture.returned, null],
      [fixture.departedAgain, markerIds(fixture.departedAgain).at(-1)!],
    ] as const) {
      expect(currentThreadContinuationId(history, source)).toBe(expected);
      const normalized = history.flatMap((message, index) => normalizeHistoryMessageToChatMessages(message, index));
      expect(currentThreadContinuationId(normalized, source)).toBe(expected);
      const sync = buildThreadWindowSync({
        messageHistory: history,
        threadKey: source,
        fromItem: -1,
        itemCount: 10,
        sectionItemCount: 5,
        visibleItemCount: 2,
      });
      expect(markerIds(sync.entries.map((entry) => entry.message))).toEqual(expected ? [expected] : []);
      const audit = buildThreadWindowSync({
        messageHistory: history,
        threadKey: "all",
        fromItem: -1,
        itemCount: 20,
        sectionItemCount: 5,
        visibleItemCount: 4,
      });
      expect(markerIds(audit.entries.map((entry) => entry.message))).toEqual(markerIds(history));
    }
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("does not resurrect an expired notice in an older bounded window", () => {
    // Add later human turns so the return is outside the requested old slice.
    const { returned } = buildThreadContinuationFixture();
    const history: BrowserIncomingMessage[] = [...returned];
    for (let index = 0; index < 20; index++)
      history.push({
        type: "user_message",
        id: `later-request-${index}`,
        content: "Another check",
        timestamp: 1789067000000 + index,
        ...threadRouteForTarget("q-42"),
      });
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-42",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });
    expect(sync.window.has_newer_items).toBe(true);
    expect(markerIds(sync.entries.map((entry) => entry.message))).toEqual([]);
  });

  it("does not confuse incoming requests, attached answers or child activity with a return", () => {
    const { away } = buildThreadContinuationFixture();
    const expected = currentThreadContinuationId(away, "q-42");
    const work = away.at(-1)!;
    if (work.type !== "assistant") throw new Error("Fixture must end in assistant work");
    const events: BrowserIncomingMessage[] = [
      {
        type: "user_message",
        id: "queued-request",
        content: "Also check sorting",
        timestamp: 1789067000000,
        ...threadRouteForTarget("q-42"),
      },
      { ...work, ...threadRouteForTarget("q-42"), parent_tool_use_id: "child-tool" },
      { ...work, threadRefs: [{ threadKey: "q-42", questId: "q-42", source: "backfill" }] },
    ];
    for (const event of events) {
      const history = [...away, event];
      expect(currentThreadContinuationId(history, "q-42")).toBe(expected);
      expect(
        currentThreadContinuationId(
          history.flatMap((message, index) => normalizeHistoryMessageToChatMessages(message, index)),
          "q-42",
        ),
      ).toBe(expected);
    }
    // Shared-answer display anchors are separate from the authored work route.
    expect(
      currentThreadContinuationId(
        [
          ...away.flatMap((message, index) => normalizeHistoryMessageToChatMessages(message, index)),
          {
            role: "assistant",
            content: "Shared answer",
            metadata: { threadKey: "q-42", questId: "q-42", threadAnswer: { authoredThreadKey: "q-43" } },
          },
        ],
        "q-42",
      ),
    ).toBe(expected);
  });

  it("uses routed leader prose and Codex reasoning as return evidence while honoring root filtering", () => {
    const { away } = buildThreadContinuationFixture();
    const expected = currentThreadContinuationId(away, "q-42");
    const returned: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: "leader-return",
      content: "Back",
      timestamp: 1789067000000,
      ...threadRouteForTarget("q-42"),
    };
    expect(currentThreadContinuationId([...away, returned], "q-42")).toBeNull();
    expect(currentThreadContinuationId([...away, returned], "q-42", (message) => message !== returned)).toBe(expected);
    expect(
      currentThreadContinuationId(
        [...away, { type: "codex_reasoning_detail", text: "Checking the list", ...threadRouteForTarget("q-42") }],
        "q-42",
      ),
    ).toBeNull();
  });

  it("ignores status-only output and preserves the producer's idempotent departure history", () => {
    // A status marker is separate from work routing, and repeated processing of
    // the same destination must not create a replacement departure or lose audit.
    const { away } = buildThreadContinuationFixture("main");
    const expected = currentThreadContinuationId(away, "main");
    expect(
      currentThreadContinuationId(
        [
          ...away.flatMap((message, index) => normalizeHistoryMessageToChatMessages(message, index)),
          { role: "assistant", content: "", contentBlocks: [], metadata: { threadKey: "main" } },
        ],
        "main",
      ),
    ).toBe(expected);
    const before = JSON.stringify(away);
    expect(appendThreadTransitionMarkerForRouteSwitch(away, threadRouteForTarget("q-43"))).toBeNull();
    expect(JSON.stringify(away)).toBe(before);
  });
});
