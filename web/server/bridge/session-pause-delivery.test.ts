import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type PersistedSession } from "../session-store.js";
import { buildProgrammaticUserMessage, queuePausedUserMessage } from "../session-pause.js";
import type { BrowserOutgoingMessage, CodexAutoPauseRecoveryLink } from "../session-types.js";
import type { BrowserTransportDeps, BrowserTransportSessionLike } from "./browser-transport-controller.js";
import { unpauseSessionForDelivery } from "./session-pause-delivery.js";
import { leaderTimerMessageIdForDelivery } from "./adapter-browser-routing-timer.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSession(message: Extract<BrowserOutgoingMessage, { type: "user_message" }>): BrowserTransportSessionLike {
  const link = message.autoPauseRecoveries?.[0];
  return {
    id: "manual-pause-resume",
    backendType: "codex",
    browserSockets: new Set(),
    messageHistory: link
      ? [
          {
            type: "codex_auto_pause_recovery_summary",
            id: link.summaryId,
            timestamp: 100,
            content: "Automatic input recovery: 1 awaiting delivery.",
            searchText: "automatic input recovery outcome:released_to_delivery",
            recovery: {
              family: "copilot_auth_refresh_exhausted",
              pausedAt: 90,
              recoveryConfirmedAt: 100,
              updatedAt: 100,
              status: "releasing",
              receipts: [
                {
                  groupId: link.groupId,
                  source: "programmatic",
                  sourceLabel: "Herd Events",
                  count: 1,
                  coalescedCount: 0,
                  queuedAt: 91,
                  lastQueuedAt: 91,
                  releasedAt: 100,
                  outcome: "released_to_delivery",
                  reasonCode: "manual_recovery_succeeded",
                  reason: "Manual recovery succeeded; queued for exact-once delivery.",
                },
              ],
            },
          } as any,
        ]
      : [],
    frozenCount: 0,
    state: {
      permissionMode: "default",
      pause: {
        pausedAt: 110,
        queuedMessages: [{ id: "paused-1", queuedAt: 111, source: "browser", message }],
      },
    } as any,
    nextEventSeq: 1,
    lastAckSeq: 0,
    pendingPermissions: new Map(),
    pendingCodexInputs: [],
    pendingCodexTurns: [],
    recoveryDeliveryTransfers: [],
    taskHistory: [],
    eventBuffer: [],
    lastReadAt: 0,
    attentionReason: null,
    generationStartedAt: null,
    notifications: [],
    attentionRecords: [],
    processedClientMessageIds: [],
    processedClientMessageIdSet: new Set(),
  };
}

function recoveryMessage(): Extract<BrowserOutgoingMessage, { type: "user_message" }> {
  return {
    type: "user_message",
    content: "released automatic event",
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    autoPauseRecoveries: [{ summaryId: "summary-1", groupId: "group-1" }],
  };
}

interface IngressOptions {
  archived?: boolean;
  priorRoute?: Promise<void>;
  route?: BrowserTransportDeps["routeBrowserMessage"];
}

function makeIngressDeps(options: IngressOptions = {}): BrowserTransportDeps {
  return {
    getLauncherSessionInfo: vi.fn(() => ({
      archived: options.archived ?? false,
      state: options.archived ? "exited" : "connected",
      backendType: "codex" as const,
    })),
    getRouteChain: vi.fn(() => options.priorRoute),
    setRouteChain: vi.fn(),
    clearRouteChain: vi.fn(),
    routeBrowserMessage: options.route ?? vi.fn(),
    touchActivity: vi.fn(),
    persistSession: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    broadcastError: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    idempotentMessageTypes: new Set(),
    processedClientMsgIdLimit: 100,
  } as unknown as BrowserTransportDeps;
}

function makeDeliveryDeps(getIngressDeps: () => BrowserTransportDeps, onFirstBarrier?: () => void | Promise<void>) {
  const snapshots: any[] = [];
  let barrierCount = 0;
  return {
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    persistSessionImmediately: vi.fn(async (target) => {
      snapshots.push(structuredClone(target));
      barrierCount += 1;
      if (barrierCount === 1) await onFirstBarrier?.();
    }),
    getBrowserTransportDeps: getIngressDeps,
    releasePendingTransfer: vi.fn(),
    onCLIRelaunchNeeded: vi.fn(),
    snapshots,
  };
}

function receipt(session: BrowserTransportSessionLike) {
  const summary = session.messageHistory.find((message) => message.type === "codex_auto_pause_recovery_summary");
  if (summary?.type !== "codex_auto_pause_recovery_summary") throw new Error("missing recovery summary");
  return { summary, receipt: summary.recovery.receipts[0]! };
}

function recoveryLinksInManualPause(session: BrowserTransportSessionLike): CodexAutoPauseRecoveryLink[] {
  return (session.state.pause?.queuedMessages ?? []).flatMap((queued) => queued.message.autoPauseRecoveries ?? []);
}

function recoveryLinksInAutoPause(session: BrowserTransportSessionLike): CodexAutoPauseRecoveryLink[] {
  return (session.state.codex_result_error_auto_pause?.heldInputs ?? []).flatMap(
    (held) => held.message.autoPauseRecoveries ?? [],
  );
}

function expectEveryReleasedLinkOwnedOnce(session: BrowserTransportSessionLike): void {
  const pendingLinks = [
    ...session.pendingCodexInputs.flatMap((input) => input.autoPauseRecoveries ?? []),
    ...session.pendingCodexTurns.flatMap((turn) => turn.autoPauseRecoveryLinks ?? []),
  ];
  const manualLinks = recoveryLinksInManualPause(session);
  const autoLinks = recoveryLinksInAutoPause(session);
  const owns = (links: CodexAutoPauseRecoveryLink[], summaryId: string, groupId: string) =>
    links.some((link) => link.summaryId === summaryId && link.groupId === groupId);

  for (const message of session.messageHistory) {
    if (message.type !== "codex_auto_pause_recovery_summary") continue;
    for (const item of message.recovery.receipts) {
      if (item.outcome !== "released_to_delivery") continue;
      const ownerCount = [pendingLinks, manualLinks, autoLinks].filter((links) =>
        owns(links, message.id, item.groupId),
      ).length;
      expect(ownerCount, `released group ${item.groupId} must have exactly one durable owner`).toBe(1);
    }
  }
}

describe("manual pause recovery-link transfer", () => {
  it("retains a server-created timer firing and destination through manual unpause", async () => {
    // Queue serialization and the real internal ingress path must preserve
    // provenance; treating resume as fresh browser JSON would erase it.
    const message = JSON.parse(
      JSON.stringify(
        buildProgrammaticUserMessage({
          content: "[⏰ Timer t1 reminder] Report",
          agentSource: { sessionId: "timer:t1", sessionLabel: "Timer t1" },
          threadRoute: { threadKey: "q-42", questId: "q-42" },
          options: { timerFiring: { timerId: "t1", scheduledFireAt: 1 } },
        }),
      ),
    );
    const session = makeSession(message);
    session.state.pause!.queuedMessages[0]!.source = "programmatic";
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: "timer-input",
        content: routed.content,
        timestamp: 120,
        cancelable: true,
        threadKey: routed.threadKey,
        leaderTimerMessageId: leaderTimerMessageIdForDelivery(target, routed),
      });
    });

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => makeIngressDeps({ route })) as any);

    expect(session.state.pause).toBeNull();
    expect(route).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        timerFiring: { timerId: "t1", scheduledFireAt: 1 },
        threadKey: "q-42",
      }),
      undefined,
    );
    expect(session.pendingCodexInputs[0]).toMatchObject({ leaderTimerMessageId: "f1", threadKey: "q-42" });
  });

  it("transfers a released link into normal pending delivery", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: "pending-1",
        content: routed.content,
        timestamp: 120,
        cancelable: true,
        autoPauseRecoveries: routed.autoPauseRecoveries,
      } as any);
    });

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => makeIngressDeps({ route })) as any);

    expect(session.state.pause).toBeNull();
    expect(session.pendingCodexInputs[0]?.autoPauseRecoveries).toEqual(message.autoPauseRecoveries);
    expect(receipt(session).receipt.outcome).toBe("released_to_delivery");
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("transfers a released link into a renewed auto-pause hold", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);

    await unpauseSessionForDelivery(
      session as any,
      makeDeliveryDeps(() => {
        session.state.codex_result_error_auto_pause = {
          family: "copilot_auth_refresh_exhausted",
          fingerprint: "copilot_auth_refresh_exhausted:github_copilot",
          streak: 1,
          threshold: 1,
          pausedAt: 130,
          lastError: "GitHub Copilot API-key refresh exhausted its retry budget.",
          lastErrorAt: 130,
          lastSourceKind: "automatic",
          totalMatchingErrors: 1,
          heldInputs: [],
        };
        return makeIngressDeps();
      }) as any,
    );

    expect(recoveryLinksInAutoPause(session)).toEqual(message.autoPauseRecoveries);
    expect(receipt(session).receipt.outcome).toBe("released_to_delivery");
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("transfers a released link into a newly requeued manual pause", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);

    await unpauseSessionForDelivery(
      session as any,
      makeDeliveryDeps(() => {
        session.state.pause = { pausedAt: 140, queuedMessages: [] };
        return makeIngressDeps();
      }) as any,
    );

    expect(recoveryLinksInManualPause(session)).toEqual(message.autoPauseRecoveries);
    expect(receipt(session).receipt.outcome).toBe("released_to_delivery");
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("selectively resumes captured messages while concurrent manual-pause arrivals remain held", async () => {
    vi.spyOn(Date, "now").mockReturnValue(200);
    const message = recoveryMessage();
    const session = makeSession(message);
    const routedContents: string[] = [];
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      routedContents.push(routed.content);
      if (!routed.autoPauseRecoveries?.length) return;
      target.pendingCodexInputs.push({
        id: "captured-pending",
        content: routed.content,
        timestamp: 145,
        cancelable: true,
        autoPauseRecoveries: routed.autoPauseRecoveries,
      } as any);
    });
    const deps = makeDeliveryDeps(
      () => makeIngressDeps({ route }),
      () => {
        queuePausedUserMessage(session as any, "browser", {
          type: "user_message",
          content: "concurrent newcomer one",
        });
        queuePausedUserMessage(session as any, "browser", {
          type: "user_message",
          content: "concurrent newcomer two",
        });
      },
    );

    await unpauseSessionForDelivery(session as any, deps as any);

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.state.pause?.queuedMessages.map((item) => item.message.content)).toEqual([
      "concurrent newcomer one",
      "concurrent newcomer two",
      "released automatic event",
    ]);
    expect(deps.snapshots[1]?.state.pause?.queuedMessages).toHaveLength(2);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: { pause: expect.objectContaining({ queuedMessages: expect.any(Array) }) },
      }),
    );
    expectEveryReleasedLinkOwnedOnce(session);

    await unpauseSessionForDelivery(session as any, deps as any);

    expect(session.state.pause).toBeNull();
    expect(routedContents).toEqual(["concurrent newcomer one", "concurrent newcomer two", "released automatic event"]);
    expect(route).toHaveBeenCalledTimes(3);
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("drops the queued payload when an authoritative terminal receipt already owns the link", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);
    const existing = receipt(session).receipt;
    existing.outcome = "failed";
    existing.reasonCode = "delivery_pipeline_rejected";
    existing.reason = "Failed because the server could not admit the released input to pending delivery.";
    existing.terminalAt = 115;
    const route = vi.fn();

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => makeIngressDeps({ route })) as any);

    expect(route).not.toHaveBeenCalled();
    expect(session.state.pause).toBeNull();
    expect(existing.outcome).toBe("failed");
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it.each([
    ["direct", undefined],
    ["serialized", Promise.resolve()],
  ])("terminalizes only unowned links after %s route rejection", async (_label, priorRoute) => {
    const session = makeSession(recoveryMessage());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ingress = makeIngressDeps({
      priorRoute,
      route: vi.fn(async () => {
        throw new Error("route rejected");
      }),
    });

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => ingress) as any);

    expect(receipt(session).receipt).toMatchObject({
      outcome: "failed",
      reasonCode: "delivery_pipeline_rejected",
    });
    expect(ingress.broadcastError).toHaveBeenCalledWith(session, "Failed to process message. Please retry.");
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("terminalizes an archived read-only resume with no payload owner", async () => {
    const session = makeSession(recoveryMessage());

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => makeIngressDeps({ archived: true })) as any);

    expect(receipt(session).receipt).toMatchObject({
      outcome: "failed",
      reasonCode: "delivery_pipeline_rejected",
    });
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("terminalizes a route-completed-without-owner resume", async () => {
    const session = makeSession(recoveryMessage());

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => makeIngressDeps()) as any);

    expect(receipt(session).receipt).toMatchObject({
      outcome: "failed",
      reasonCode: "delivery_pipeline_rejected",
    });
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("preserves pending ownership when routing throws after admission", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ingress = makeIngressDeps({
      route: vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
        if (routed.type !== "user_message") return;
        target.pendingCodexInputs.push({
          id: "pending-before-error",
          content: routed.content,
          timestamp: 150,
          cancelable: true,
          autoPauseRecoveries: routed.autoPauseRecoveries,
        } as any);
        throw new Error("late route error");
      }),
    });

    await unpauseSessionForDelivery(session as any, makeDeliveryDeps(() => ingress) as any);

    expect(receipt(session).receipt.outcome).toBe("released_to_delivery");
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(ingress.broadcastError).toHaveBeenCalled();
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("keeps replayed resume idempotent when the link already has pending ownership", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: "pending-once",
        content: routed.content,
        timestamp: 160,
        cancelable: true,
        autoPauseRecoveries: routed.autoPauseRecoveries,
      } as any);
    });
    const deps = makeDeliveryDeps(() => makeIngressDeps({ route }));

    await unpauseSessionForDelivery(session as any, deps as any);
    session.state.pause = {
      pausedAt: 170,
      queuedMessages: [{ id: "replayed-paused", queuedAt: 171, source: "browser", message }],
    };
    await unpauseSessionForDelivery(session as any, deps as any);
    await unpauseSessionForDelivery(session as any, deps as any);

    expect(route).toHaveBeenCalledTimes(1);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.messageHistory.filter((entry) => entry.type === "codex_auto_pause_recovery_summary")).toHaveLength(
      1,
    );
    expectEveryReleasedLinkOwnedOnce(session);
  });

  it("persists the transferred pending owner and receipt across restart", async () => {
    const message = recoveryMessage();
    const session = makeSession(message);
    await unpauseSessionForDelivery(
      session as any,
      makeDeliveryDeps(() =>
        makeIngressDeps({
          route: (target, routed) => {
            if (routed.type !== "user_message") return;
            target.pendingCodexInputs.push({
              id: "restart-pending",
              content: routed.content,
              timestamp: 180,
              cancelable: true,
              autoPauseRecoveries: routed.autoPauseRecoveries,
            } as any);
          },
        }),
      ) as any,
    );

    const dir = mkdtempSync(join(tmpdir(), "takode-manual-pause-transfer-"));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    store.saveSync({
      id: session.id,
      state: { ...session.state, session_id: session.id },
      messageHistory: session.messageHistory,
      pendingMessages: [],
      pendingPermissions: [],
      pendingCodexInputs: session.pendingCodexInputs,
      pendingCodexTurns: session.pendingCodexTurns,
    } as unknown as PersistedSession);
    await store.flushAll();

    const restored = await store.load(session.id);
    expect(restored?.pendingCodexInputs?.[0]?.autoPauseRecoveries).toEqual(message.autoPauseRecoveries);
    const restoredSummary = restored?.messageHistory.find(
      (entry) => entry.type === "codex_auto_pause_recovery_summary",
    );
    expect(restoredSummary?.type).toBe("codex_auto_pause_recovery_summary");
    if (restoredSummary?.type === "codex_auto_pause_recovery_summary") {
      expect(restoredSummary.recovery.receipts[0]?.outcome).toBe("released_to_delivery");
    }
  });

  it("keeps ordinary recovery-link-free pause resume behavior and error reporting", async () => {
    const session = makeSession({ type: "user_message", content: "ordinary paused message" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ingress = makeIngressDeps({
      route: vi.fn(async () => {
        throw new Error("ordinary route failure");
      }),
    });
    const delivery = makeDeliveryDeps(() => ingress);

    await unpauseSessionForDelivery(session as any, delivery as any);

    expect(session.state.pause).toBeNull();
    expect(ingress.routeBrowserMessage).toHaveBeenCalledTimes(1);
    expect(ingress.broadcastError).toHaveBeenCalledWith(session, "Failed to process message. Please retry.");
    expect(session.messageHistory).toEqual([]);
    expect(delivery.persistSession).toHaveBeenCalledTimes(1);
  });
});
