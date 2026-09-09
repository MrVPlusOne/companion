import type { BrowserIncomingMessage, ThreadRefSource } from "../../server/session-types.js";

/** Reproduce a preserved original route plus later association without copying private conversation text. */
export function originalThreadRequest(
  originalThreadKey = "main",
  source: ThreadRefSource = "explicit",
): Extract<BrowserIncomingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    id: "original-request",
    content:
      "Please study the smallest safe release first. Keep the larger redesign separate, and bring back a plan for discussion.",
    timestamp: 1,
    threadKey: originalThreadKey,
    ...(originalThreadKey === "main" ? {} : { questId: originalThreadKey }),
    leaderUserMessageId: "u1",
    leaderResponseCoverageVersion: 1,
    threadRefs: [{ threadKey: "q-42", questId: "q-42", source, attachedAt: 2, attachedBy: "fixture-leader" }],
  };
}
