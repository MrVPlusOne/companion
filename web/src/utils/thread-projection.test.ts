import { describe, expect, it } from "vitest";
import type { ChatMessage, ThreadTransitionMarker } from "../types.js";
import { filterMessagesForThread } from "./thread-projection.js";

function message(id: string, metadata: NonNullable<ChatMessage["metadata"]>): ChatMessage {
  return {
    id,
    role: "system",
    content: id,
    timestamp: 1,
    metadata,
  };
}

function transition(id: string, sourceThreadKey: string, threadKey: string): ChatMessage {
  const marker: ThreadTransitionMarker = {
    type: "thread_transition_marker",
    id,
    timestamp: 1,
    markerKey: `thread-transition:${sourceThreadKey}->${threadKey}:0`,
    sourceThreadKey,
    ...(sourceThreadKey === "main" ? {} : { sourceQuestId: sourceThreadKey }),
    threadKey,
    ...(threadKey === "main" ? {} : { questId: threadKey }),
    transitionedAt: 1,
    reason: "route_switch",
  };
  return message(id, { threadTransitionMarker: marker });
}

describe("thread transition projection", () => {
  it("clears an outbound notice when a later transition returns to its thread", () => {
    // A return retires the earlier departure in the ordinary source feed;
    // the other thread still has its current outgoing notice.
    const outbound = transition("outbound", "q-1752", "q-1742");
    const inbound = transition("inbound", "q-1742", "q-1752");

    expect(filterMessagesForThread([outbound, inbound], "q-1752").map(({ id }) => id)).toEqual([]);
    expect(filterMessagesForThread([outbound, inbound], "q-1742").map(({ id }) => id)).toEqual(["inbound"]);
  });

  it("preserves both directions in All Threads", () => {
    const outbound = transition("outbound", "q-1752", "q-1742");
    const inbound = transition("inbound", "q-1742", "q-1752");

    expect(filterMessagesForThread([outbound, inbound], "all")).toEqual([outbound, inbound]);
  });

  it("keeps useful activity and outbound context in a mixed marker run", () => {
    const attachment = message("attachment", {
      threadAttachmentMarker: {
        type: "thread_attachment_marker",
        id: "attachment",
        timestamp: 1,
        markerKey: "thread-attachment:q-1752:context",
        threadKey: "q-1752",
        questId: "q-1752",
        attachedAt: 1,
        attachedBy: "leader",
        messageIds: ["context"],
        messageIndices: [1],
        ranges: ["1"],
        count: 1,
        firstMessageId: "context",
        firstMessageIndex: 1,
      },
    });
    const inbound = transition("inbound", "q-1742", "q-1752");
    const activity = message("activity", {
      threadKey: "q-1752",
      questId: "q-1752",
      crossThreadActivityMarker: {
        threadKey: "q-1752",
        questId: "q-1752",
        count: 1,
        firstMessageId: "activity-source",
        lastMessageId: "activity-source",
        summary: "Useful activity detail",
        startedAt: 1,
        updatedAt: 1,
      },
    });
    const outbound = transition("outbound", "q-1752", "q-1742");

    expect(filterMessagesForThread([attachment, inbound, activity, outbound], "q-1752").map(({ id }) => id)).toEqual([
      "activity",
      "outbound",
    ]);
  });

  it("also clears Main departures on a return without affecting raw markers", () => {
    const outboundFromMain = transition("main-outbound", "main", "q-1752");
    const inboundToMain = transition("main-inbound", "q-1752", "main");
    const questTransition = transition("quest-transition", "q-1752", "q-1742");

    expect(
      filterMessagesForThread([outboundFromMain, inboundToMain, questTransition], "main").map(({ id }) => id),
    ).toEqual([]);
    expect(filterMessagesForThread([outboundFromMain, inboundToMain, questTransition], "all")).toHaveLength(3);
  });
});
