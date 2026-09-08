import { describe, expect, it, vi } from "vitest";
import {
  handleBrowserMessage,
  type BrowserTransportDeps,
  type BrowserTransportSessionLike,
} from "./browser-transport-controller.js";
import { buildProgrammaticUserMessage, unpauseSessionState } from "../session-pause.js";

describe("timer firing provenance at the browser boundary", () => {
  it("removes browser-supplied provenance before a paused input can become durable", async () => {
    // Browser JSON cannot acquire timer answer authority by impersonating TimerManager.
    const session = {
      id: "paused-leader",
      backendType: "claude",
      state: { pause: { pausedAt: 1, queuedMessages: [] } },
    } as unknown as BrowserTransportSessionLike;
    const deps = {
      getLauncherSessionInfo: () => ({ archived: false }),
      persistSession: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      broadcastError: vi.fn(),
      recordIncomingRaw: vi.fn(),
    } as unknown as BrowserTransportDeps;
    const raw = JSON.stringify({
      type: "user_message",
      content: "[⏰ Timer t1 reminder] Report",
      agentSource: { sessionId: "timer:t1" },
      timerFiring: { timerId: "t1", scheduledFireAt: 1, messageId: "f7" },
    });
    await handleBrowserMessage(session, raw, undefined, deps).completion;
    const held = unpauseSessionState(session);
    expect(held).toHaveLength(1);
    expect(held[0]!.message).not.toHaveProperty("timerFiring");
    expect(held[0]!.message.content).toBe("[⏰ Timer t1 reminder] Report");
    expect(deps.recordIncomingRaw).toHaveBeenCalledWith(session.id, raw, session.backendType, undefined);
  });

  it("retains server-owned firing provenance and destination through persisted queue serialization", () => {
    // This same builder serves manual pause and automatic recovery-held delivery.
    const message = buildProgrammaticUserMessage({
      content: "[⏰ Timer t1 reminder] Report",
      agentSource: { sessionId: "timer:t1" },
      threadRoute: { threadKey: "q-42", questId: "q-42" },
      options: { timerFiring: { timerId: "t1", scheduledFireAt: 1 } },
    });
    expect(JSON.parse(JSON.stringify(message))).toMatchObject({
      timerFiring: { timerId: "t1", scheduledFireAt: 1 },
      threadKey: "q-42",
      questId: "q-42",
    });
  });
});
