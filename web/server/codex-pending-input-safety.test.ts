import { afterEach, describe, expect, it } from "vitest";
import {
  compactPendingCodexInputsForBrowser,
  projectCancelledCodexInputForBrowser,
} from "./codex-pending-input-safety.js";
import type { PendingCodexInput } from "./session-types.js";
import { isLeaderTimerAnswerTarget } from "../shared/leader-answer-message-id.js";

const ORIGINAL_PREVIEW_LIMIT = process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES;

afterEach(() => {
  if (ORIGINAL_PREVIEW_LIMIT === undefined) delete process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES;
  else process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES = ORIGINAL_PREVIEW_LIMIT;
});

function recoveryInput(overrides: Partial<PendingCodexInput> = {}): PendingCodexInput {
  return {
    id: "recovery-owner",
    content: "Visible recovery status",
    deliveryContent: "Private verification-first recovery instructions",
    timestamp: 1,
    cancelable: true,
    agentSource: { sessionId: "system:codex-turn-recovery:original-owner", sessionLabel: "Recovery" },
    queueBeforeOwnerId: "later-owner",
    requireFreshSuccessor: true,
    leaderThreadOutcomeReminderGuard: {
      version: 1,
      pendingResponseTargets: [],
      missingOutcomeTargets: [{ threadKey: "main", earliestTimestamp: 1 }],
      missingNeedsInputTargets: [],
    },
    ...overrides,
  };
}

describe("Codex pending input browser projection", () => {
  it.each([
    { messageId: "timer-m1", answerable: true },
    { messageId: "f1", answerable: false },
  ])("projects raw $messageId without timer provenance or additional answer authority", ({ messageId, answerable }) => {
    // Projection leaves raw IDs intact; unsupported IDs stay ineligible even
    // when all other timer-source fields match a genuine reminder.
    const input = recoveryInput({
      content: "[⏰ Timer t1 reminder] Report",
      agentSource: { sessionId: "timer:t1" },
      leaderTimerMessageId: messageId,
      timerFiring: { timerId: "t1", scheduledFireAt: 1, messageId },
    });

    for (const projected of [
      compactPendingCodexInputsForBrowser([input])[0],
      projectCancelledCodexInputForBrowser(input),
    ]) {
      expect(projected).not.toHaveProperty("timerFiring");
      expect(projected.leaderTimerMessageId).toBe(messageId);
      expect(isLeaderTimerAnswerTarget(projected)).toBe(answerable);
    }
    expect(input.timerFiring?.messageId).toBe(messageId);
  });

  it("omits delivery-only recovery instructions and FIFO policy from ordinary snapshots", () => {
    const [projected] = compactPendingCodexInputsForBrowser([recoveryInput()]);

    expect(projected).toMatchObject({ id: "recovery-owner", content: "Visible recovery status" });
    expect(projected).not.toHaveProperty("deliveryContent");
    expect(projected).not.toHaveProperty("queueBeforeOwnerId");
    expect(projected).not.toHaveProperty("requireFreshSuccessor");
    expect(projected).not.toHaveProperty("leaderThreadOutcomeReminderGuard");
  });

  it("keeps recovery-only fields omitted when the visible preview is truncated", () => {
    process.env.TAKODE_CODEX_PENDING_INPUT_BROWSER_PREVIEW_BYTES = "80";
    const [projected] = compactPendingCodexInputsForBrowser([
      recoveryInput({ content: "visible ".repeat(100), deliveryContent: "private ".repeat(100) }),
    ]);

    expect(projected.payloadTruncated).toBe(true);
    expect(projected.content).toContain("Truncated for browser sync");
    expect(projected).not.toHaveProperty("deliveryContent");
    expect(projected).not.toHaveProperty("deliveryContentBytes");
    expect(projected).not.toHaveProperty("queueBeforeOwnerId");
    expect(projected).not.toHaveProperty("requireFreshSuccessor");
  });

  it("preserves ordinary composer restoration data while stripping cancellation-only server policy", () => {
    const projected = projectCancelledCodexInputForBrowser(
      recoveryInput({
        agentSource: { sessionId: "leader-1" },
        clientMsgId: "client-message",
        imageRefs: [{ imageId: "stored-image", media_type: "image/png", sourceName: "stored.png" }],
        draftImages: [{ name: "draft.png", base64: "draft-data", mediaType: "image/png" }],
        replyContext: { messageId: "reply-1", previewText: "reply" },
        historyFollowUps: [{ content: "private follow-up" }],
        autoPauseRecoveries: [{ summaryId: "summary", groupId: "group" }],
      }),
    );

    expect(projected).toMatchObject({
      content: "Visible recovery status",
      clientMsgId: "client-message",
      imageRefs: [{ imageId: "stored-image", media_type: "image/png" }],
      draftImages: [{ name: "draft.png", base64: "draft-data", mediaType: "image/png" }],
      replyContext: { messageId: "reply-1" },
    });
    expect(projected).not.toHaveProperty("deliveryContent");
    expect(projected).not.toHaveProperty("historyFollowUps");
    expect(projected).not.toHaveProperty("autoPauseRecoveries");
    expect(projected).not.toHaveProperty("queueBeforeOwnerId");
    expect(projected).not.toHaveProperty("requireFreshSuccessor");
    expect(projected).not.toHaveProperty("leaderThreadOutcomeReminderGuard");
  });

  it("retains bounded delivery content for ordinary non-recovery pending input", () => {
    const [projected] = compactPendingCodexInputsForBrowser([
      recoveryInput({
        agentSource: { sessionId: "leader-1" },
        queueBeforeOwnerId: undefined,
        requireFreshSuccessor: undefined,
      }),
    ]);

    expect(projected.deliveryContent).toBe("Private verification-first recovery instructions");
  });
});
