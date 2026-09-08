// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../../server/session-types.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { useStore } from "../store.js";
import { normalizeHistoryMessageToChatMessages } from "../utils/history-message-normalization.js";
import { useCodexSafeFeedModel } from "./use-codex-safe-feed-model.js";
import { useCollapsePolicy } from "./use-collapse-policy.js";
import { useFeedModel } from "./use-feed-model.js";

const SESSION_ID = "leading-turn-identity";
const THREAD_KEY = "q-1";
const THREAD_FIELDS = {
  threadKey: THREAD_KEY,
  questId: THREAD_KEY,
  threadRefs: [{ threadKey: THREAD_KEY, questId: THREAD_KEY, source: "explicit" as const }],
};

function user(id: string, timestamp: number, injected = false): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content: injected ? "A worker reported progress." : "Keep following the work.",
    timestamp,
    ...(injected ? { agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } } : {}),
    ...THREAD_FIELDS,
  };
}

function assistant(id: string, timestamp: number): BrowserIncomingMessage {
  return {
    type: "assistant",
    timestamp,
    ...THREAD_FIELDS,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "codex",
      content: [{ type: "text", text: "The work continues." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
  };
}

function normalizedMessages(window: ReturnType<typeof buildThreadWindowSync>) {
  return window.entries.flatMap((entry) => normalizeHistoryMessageToChatMessages(entry.message, entry.history_index));
}

beforeEach(() => {
  useStore.setState({ turnActivityOverrides: new Map() });
});

describe("selected-window leading turn identity", () => {
  it("keeps a manual collapse through overlapping injected ranges and the return of its human boundary", () => {
    // Server ranges begin at injected user rows; the feed merges them into one
    // human turn. Paging must not create a new collapse key from each slice.
    const history = [
      user("human-start", 1),
      assistant("first-reply", 2),
      ...Array.from({ length: 8 }, (_, index) => [
        user(`injected-${index}`, index * 2 + 3, true),
        assistant(`reply-${index}`, index * 2 + 4),
      ]).flat(),
    ];
    const windows = [
      { fromItem: 7, itemCount: 2 },
      { fromItem: 5, itemCount: 4 },
      { fromItem: 6, itemCount: 3 },
      { fromItem: 0, itemCount: 9 },
    ].map((bounds) =>
      buildThreadWindowSync({
        messageHistory: history,
        threadKey: THREAD_KEY,
        sectionItemCount: 2,
        visibleItemCount: 3,
        ...bounds,
      }),
    );
    const props = windows.map((window) => ({ messages: normalizedMessages(window), window: window.window }));
    const { result, rerender } = renderHook(
      ({ messages, window }) => {
        const model = useCodexSafeFeedModel({
          messages,
          frozenCount: 0,
          frozenRevision: 0,
          isCodexSession: true,
          leaderMode: true,
          leaderSessionMode: true,
          sessionNotifications: undefined,
          userBoundarySourceSessionId: null,
          leadingTurnId: window.leading_turn_id,
          perf: { sessionId: SESSION_ID, threadKey: THREAD_KEY },
        });
        const policy = useCollapsePolicy({ sessionId: SESSION_ID, turns: model.turns });
        return { model, policy };
      },
      { initialProps: props[0]! },
    );

    expect(result.current.model.turns).toHaveLength(1);
    expect(result.current.model.turns[0]?.userEntry).toBeNull();
    expect(result.current.model.turns[0]?.id).toBe("human-start");
    act(() => result.current.policy.toggleTurn("human-start"));
    expect(useStore.getState().turnActivityOverrides.get(SESSION_ID)?.get("human-start")).toBe(false);

    for (const next of props.slice(1)) {
      rerender(next);
      expect(result.current.model.turns.map((turn) => turn.id)).toEqual(["human-start"]);
      expect(result.current.policy.turnStates[0]?.isActivityExpanded).toBe(false);
    }
    expect(result.current.model.turns[0]?.userEntry).not.toBeNull();
  });

  it("recomputes a changed hint without mutating its frozen cached turn", () => {
    // The same message references can receive corrected window metadata. A hint
    // must not leak into the frozen model when the next delivery omits it.
    const messages = normalizeHistoryMessageToChatMessages(user("injected-start", 1, true), 10);
    const emptyIds: readonly string[] = [];
    const { result, rerender } = renderHook(
      ({ leadingTurnId }: { leadingTurnId: string | undefined }) =>
        useFeedModel(messages, {
          leaderMode: true,
          frozenCount: messages.length,
          leadingTurnId,
          anchoredNotificationMessageIds: emptyIds,
          visibleAssistantChildMessageIds: emptyIds,
        }),
      { initialProps: { leadingTurnId: "human-first" as string | undefined } },
    );

    expect(result.current.turns[0]?.id).toBe("human-first");
    rerender({ leadingTurnId: "human-second" });
    expect(result.current.turns[0]?.id).toBe("human-second");
    rerender({ leadingTurnId: undefined });
    expect(result.current.turns[0]?.id).toBe("turn-a-injected-start");
  });

  it("preserves loaded human boundaries and all later turn identities", () => {
    // The hint describes only an omitted leading boundary, never a replacement
    // for a real user row or an instruction to re-key every loaded turn.
    const messages = [user("first-human", 1), assistant("first-answer", 2), user("second-human", 3)].flatMap(
      (message, index) => normalizeHistoryMessageToChatMessages(message, index),
    );
    const { result, rerender } = renderHook(
      ({ loadedMessages }) => useFeedModel(loadedMessages, { leaderMode: true, leadingTurnId: "hinted-human" }),
      { initialProps: { loadedMessages: messages.slice(1) } },
    );

    expect(result.current.turns.map((turn) => turn.id)).toEqual(["hinted-human", "second-human"]);
    rerender({ loadedMessages: messages });
    expect(result.current.turns.map((turn) => turn.id)).toEqual(["first-human", "second-human"]);
  });
});
