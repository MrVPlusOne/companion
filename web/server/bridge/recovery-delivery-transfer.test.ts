import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type PersistedSession } from "../session-store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, CodexAutoPauseRecoveryLink } from "../session-types.js";
import type { BrowserTransportDeps, BrowserTransportSessionLike } from "./browser-transport-controller.js";
import { buildProgrammaticUserMessage } from "../session-pause.js";
import { leaderTimerMessageIdForDelivery } from "./adapter-browser-routing-timer.js";
import { getTrustedRecoveryDeliveryTransferId } from "./recovery-delivery-transfer-routing-context.js";
import { routeAdapterBrowserMessage } from "./adapter-browser-routing-controller.js";
import type { AdapterBrowserRoutingDeps, AdapterBrowserRoutingSessionLike } from "./adapter-browser-routing-types.js";
import {
  materializeCodexAutoPausedInputsForDrain,
  sweepCodexAutoPausedQueuedBacklog,
} from "../codex-result-error-auto-pause.js";
import { createCodexAutoPauseRecoverySummary } from "./codex-auto-pause-recovery-summary.js";
import {
  beginRecoveryDeliveryTransferHandoff,
  deliverRecoveryDeliveryTransfer,
  normalizePersistedRecoveryDeliveryTransfers,
  RECOVERY_DELIVERY_TRANSFER_MAX_COUNT,
  resumeRecoveryDeliveryTransfers,
  type RecoveryDeliveryTransferCandidate,
  type RecoveryDeliveryTransferDeps,
  type RecoveryDeliveryTransferSessionLike,
} from "./recovery-delivery-transfer.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function link(groupId = "group-1"): CodexAutoPauseRecoveryLink {
  return { summaryId: "summary-1", groupId };
}

function messageFor(groupId = "group-1", content = `private payload ${groupId}`) {
  return {
    type: "user_message" as const,
    content,
    agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    threadKey: "q-test",
    questId: "q-test",
    autoPauseRecoveries: [link(groupId)],
  };
}

function summary(groups: string[]): BrowserIncomingMessage {
  return {
    type: "codex_auto_pause_recovery_summary",
    id: "summary-1",
    timestamp: 10,
    content: `Automatic input recovery: ${groups.length} awaiting delivery.`,
    searchText: "automatic input recovery released_to_delivery",
    recovery: {
      family: "copilot_auth_refresh_exhausted",
      pausedAt: 1,
      recoveryConfirmedAt: 10,
      updatedAt: 10,
      status: "releasing",
      receipts: groups.map((groupId, index) => ({
        groupId,
        source: "programmatic",
        sourceLabel: "Herd Events",
        count: 1,
        coalescedCount: 0,
        queuedAt: 2 + index,
        lastQueuedAt: 2 + index,
        releasedAt: 10,
        outcome: "released_to_delivery",
        reasonCode: "manual_recovery_succeeded",
        reason: "Manual recovery succeeded; queued for exact-once delivery.",
      })),
    },
  } as BrowserIncomingMessage;
}

function makeSession(groups = ["group-1"]): RecoveryDeliveryTransferSessionLike {
  return {
    id: "transfer-session",
    backendType: "codex",
    browserSockets: new Set(),
    messageHistory: [summary(groups)],
    frozenCount: 0,
    state: {
      permissionMode: "default",
      codex_result_error_auto_pause: {
        family: "copilot_auth_refresh_exhausted",
        fingerprint: "copilot_auth_refresh_exhausted:github_copilot",
        streak: 1,
        threshold: 1,
        pausedAt: 1,
        lastError: "GitHub Copilot API-key refresh exhausted its retry budget.",
        lastErrorAt: 1,
        lastSourceKind: "automatic",
        totalMatchingErrors: 1,
        heldInputs: groups.map((groupId, index) => ({
          id: `held-${index + 1}`,
          queuedAt: 2 + index,
          lastQueuedAt: 2 + index,
          source: "programmatic",
          count: 1,
          message: messageFor(groupId),
        })),
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

const REVIEWER_COLLISION_SUMMARY_ID = "codex-auto-pause-recovery-1234567890";
const REVIEWER_COLLIDING_SOURCE_IDS = [
  "codex-auto-pause-1234567890043-40",
  "codex-auto-pause-1234567890094-91",
] as const;

function makeReviewerCollisionSession(count: number): {
  session: RecoveryDeliveryTransferSessionLike;
  sourceIds: string[];
} {
  const sourceIds = Array.from({ length: count }, (_, index) => `codex-auto-pause-reviewer-${index + 1}`);
  if (count >= 2) {
    sourceIds[Math.min(39, count - 2)] = REVIEWER_COLLIDING_SOURCE_IDS[0];
    sourceIds[Math.min(90, count - 1)] = REVIEWER_COLLIDING_SOURCE_IDS[1];
  }
  const session = makeSession(sourceIds);
  const recoverySummary = session.messageHistory[0];
  if (recoverySummary?.type !== "codex_auto_pause_recovery_summary") throw new Error("missing recovery summary");
  recoverySummary.id = REVIEWER_COLLISION_SUMMARY_ID;
  for (const [index, held] of (session.state.codex_result_error_auto_pause?.heldInputs ?? []).entries()) {
    const sourceId = sourceIds[index]!;
    held.id = sourceId;
    held.message = {
      ...messageFor(sourceId, `captured payload ${index + 1}`),
      autoPauseRecoveries: [{ summaryId: REVIEWER_COLLISION_SUMMARY_ID, groupId: sourceId }],
    };
  }
  return { session, sourceIds };
}

function candidates(session: RecoveryDeliveryTransferSessionLike): RecoveryDeliveryTransferCandidate[] {
  return (session.state.codex_result_error_auto_pause?.heldInputs ?? []).map((held) => ({
    sourceOwnerKind: "auto_pause",
    sourceOwnerId: held.id,
    sourceOwnerCount: held.count,
    message: held.message,
  }));
}

function makeIngressDeps(route: BrowserTransportDeps["routeBrowserMessage"] = vi.fn()): BrowserTransportDeps {
  return {
    getLauncherSessionInfo: vi.fn(() => ({ archived: false, state: "connected", backendType: "codex" as const })),
    getRouteChain: vi.fn(() => undefined),
    setRouteChain: vi.fn(),
    clearRouteChain: vi.fn(),
    routeBrowserMessage: route,
    touchActivity: vi.fn(),
    persistSession: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    broadcastError: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    idempotentMessageTypes: new Set(),
    processedClientMsgIdLimit: 100,
  } as unknown as BrowserTransportDeps;
}

function makeDeps(
  snapshots: RecoveryDeliveryTransferSessionLike[],
  route: BrowserTransportDeps["routeBrowserMessage"] = vi.fn(),
): RecoveryDeliveryTransferDeps {
  return {
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    persistSessionImmediately: vi.fn(async (session: RecoveryDeliveryTransferSessionLike) => {
      snapshots.push(structuredClone(session));
    }),
    getBrowserTransportDeps: () => makeIngressDeps(route),
    releasePendingTransfer: vi.fn(),
  };
}

function receiptOutcome(session: RecoveryDeliveryTransferSessionLike, groupId = "group-1") {
  const entry = session.messageHistory.find((item) => item.type === "codex_auto_pause_recovery_summary");
  if (entry?.type !== "codex_auto_pause_recovery_summary") throw new Error("missing summary");
  return entry.recovery.receipts.find((item) => item.groupId === groupId)?.outcome;
}

function effectiveOwnerCount(session: RecoveryDeliveryTransferSessionLike, target: CodexAutoPauseRecoveryLink): number {
  const transferOwns = session.recoveryDeliveryTransfers.some((entry) =>
    entry.message.autoPauseRecoveries?.some(
      (item) => item.summaryId === target.summaryId && item.groupId === target.groupId,
    ),
  );
  // Transfer ownership takes precedence while old/new owners coexist.
  if (transferOwns) return 1;
  const pendingOwns = [
    ...session.pendingCodexInputs.flatMap((input) => input.autoPauseRecoveries ?? []),
    ...session.pendingCodexTurns.flatMap((turn) => turn.autoPauseRecoveryLinks ?? []),
  ].some((item) => item.summaryId === target.summaryId && item.groupId === target.groupId);
  const manualOwns = (session.state.pause?.queuedMessages ?? []).some((queued) =>
    queued.message.autoPauseRecoveries?.some(
      (item) => item.summaryId === target.summaryId && item.groupId === target.groupId,
    ),
  );
  const autoOwns = (session.state.codex_result_error_auto_pause?.heldInputs ?? []).some((held) =>
    held.message.autoPauseRecoveries?.some(
      (item) => item.summaryId === target.summaryId && item.groupId === target.groupId,
    ),
  );
  return Number(pendingOwns) + Number(manualOwns) + Number(autoOwns);
}

function expectOwnedOrTerminal(
  session: RecoveryDeliveryTransferSessionLike,
  groupId = "group-1",
  summaryId = "summary-1",
): void {
  const outcome = receiptOutcome(session, groupId);
  if (outcome === "released_to_delivery") {
    expect(effectiveOwnerCount(session, { summaryId, groupId }), `owner for ${groupId}`).toBe(1);
  } else {
    expect(outcome).toBeTruthy();
  }
}

function persisted(session: RecoveryDeliveryTransferSessionLike): PersistedSession {
  return {
    id: session.id,
    state: session.state,
    messageHistory: session.messageHistory,
    pendingMessages: [],
    pendingPermissions: [],
    pendingCodexInputs: session.pendingCodexInputs,
    pendingCodexTurns: session.pendingCodexTurns,
    recoveryDeliveryTransfers: session.recoveryDeliveryTransfers,
  } as unknown as PersistedSession;
}

describe("recovery delivery transfer ownership", () => {
  it("keeps one firing reference through pending, hold, restart, transfer, and re-admission", async () => {
    // Exercise the real adapter admission on both sides of a persisted hold.
    // Frozen delivery prevents this isolated fixture from starting a backend.
    const session = makeSession([]);
    session.messageHistory = [];
    const firing = buildProgrammaticUserMessage({
      content: "[⏰ Timer t1 reminder] Report",
      agentSource: { sessionId: "timer:t1", sessionLabel: "Timer t1" },
      threadRoute: { threadKey: "q-42", questId: "q-42" },
      options: { timerFiring: { timerId: "t1", scheduledFireAt: 1 } },
    });
    let nextId = 0;
    const routingDeps = {
      getLauncherSessionInfo: () => ({ isOrchestrator: true, state: "starting" }),
      nextUserMessageId: () => `timer-input-${++nextId}`,
      addPendingCodexInput: (
        target: AdapterBrowserRoutingSessionLike,
        input: (typeof target.pendingCodexInputs)[number],
      ) => {
        target.pendingCodexInputs.push(input);
      },
      broadcastToBrowsers: vi.fn(),
      promoteLeaderThreadTabForMessageAttention: vi.fn(),
      emitTakodeEvent: vi.fn(),
      persistSession: vi.fn(),
      isHerdEventSource: () => false,
      isCodexWorkerV2DeliveryFrozen: () => true,
      rebuildQueuedCodexPendingStartBatch: vi.fn(),
    } as unknown as AdapterBrowserRoutingDeps;
    await routeAdapterBrowserMessage(
      session as unknown as AdapterBrowserRoutingSessionLike,
      firing,
      undefined,
      routingDeps,
    );
    const admitted = session.pendingCodexInputs[0]!;
    expect(admitted).toMatchObject({ leaderTimerMessageId: "f1", timerFiring: firing.timerFiring });
    expect(admitted.deliveryContent).toMatch(/\[Timer reminder .* id:f1\] \[thread:q-42\]/);

    expect(sweepCodexAutoPausedQueuedBacklog(session, 30).heldInputIds).toEqual([admitted.id]);
    expect(session.pendingCodexInputs).toEqual([]);
    expect(session.state.codex_result_error_auto_pause!.heldInputs[0].message).toMatchObject({
      timerFiring: { ...firing.timerFiring, messageId: "f1" },
      deliveryContent: admitted.deliveryContent,
    });
    const dir = mkdtempSync(join(tmpdir(), "takode-timer-held-delivery-"));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    await store.saveImmediate(persisted(session));
    const saved = (await store.load(session.id))!;
    const restored = makeSession([]);
    restored.state = saved.state;
    restored.messageHistory = saved.messageHistory;
    restored.pendingCodexInputs = saved.pendingCodexInputs ?? [];
    expect(leaderTimerMessageIdForDelivery(restored, firing)).toBe("f2");

    const route = vi.fn(async (target: BrowserTransportSessionLike, message: BrowserOutgoingMessage) => {
      await routeAdapterBrowserMessage(
        target as unknown as AdapterBrowserRoutingSessionLike,
        message,
        undefined,
        routingDeps,
      );
    });
    const deps = makeDeps([], route);
    const pause = restored.state.codex_result_error_auto_pause!;
    const summary = createCodexAutoPauseRecoverySummary(restored, pause, pause.heldInputs, 40, deps);
    const messages = materializeCodexAutoPausedInputsForDrain(pause.heldInputs, summary.id);
    await beginRecoveryDeliveryTransferHandoff(
      restored,
      pause.heldInputs.map((item, index) => ({
        sourceOwnerKind: "auto_pause",
        sourceOwnerId: item.id,
        sourceOwnerCount: item.count,
        message: messages[index],
      })),
      {},
      deps,
    );
    expect(leaderTimerMessageIdForDelivery(restored, firing)).toBe("f2");
    await deliverRecoveryDeliveryTransfer(restored, restored.recoveryDeliveryTransfers[0].id, deps);

    expect(restored.pendingCodexInputs).toHaveLength(1);
    expect(restored.pendingCodexInputs[0]).toMatchObject({
      leaderTimerMessageId: "f1",
      timerFiring: { ...firing.timerFiring, messageId: "f1" },
      deliveryContent: admitted.deliveryContent,
      content: firing.content,
      threadKey: "q-42",
    });
    expect(restored.pendingCodexInputs[0].deliveryContent?.match(/id:f1/g)).toHaveLength(1);
    expect(restored.recoveryDeliveryTransfers).toEqual([]);
  });

  it("retains timer firing proof through persisted automatic-recovery transfer delivery", async () => {
    // Recovery's exact-payload trust check and firing identity both depend on
    // retaining the server-owned metadata through internal ingress.
    const session = makeSession();
    session.state.codex_result_error_auto_pause!.heldInputs[0]!.message = {
      ...buildProgrammaticUserMessage({
        content: "[⏰ Timer t1 reminder] Report",
        agentSource: { sessionId: "timer:t1", sessionLabel: "Timer t1" },
        threadRoute: { threadKey: "q-42", questId: "q-42" },
        options: { timerFiring: { timerId: "t1", scheduledFireAt: 1 } },
      }),
      autoPauseRecoveries: [link()],
    };
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      expect(getTrustedRecoveryDeliveryTransferId(target, routed)).toBeTruthy();
      target.pendingCodexInputs.push({
        id: "timer-input",
        content: routed.content,
        timestamp: 120,
        cancelable: true,
        threadKey: routed.threadKey,
        autoPauseRecoveries: routed.autoPauseRecoveries,
        leaderTimerMessageId: leaderTimerMessageIdForDelivery(target, routed),
      });
    });
    const deps = makeDeps([], route);
    await beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, deps);
    session.recoveryDeliveryTransfers = normalizePersistedRecoveryDeliveryTransfers(
      JSON.parse(JSON.stringify(session.recoveryDeliveryTransfers)),
    );

    await deliverRecoveryDeliveryTransfer(session, session.recoveryDeliveryTransfers[0]!.id, deps);

    expect(route).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        timerFiring: { timerId: "t1", scheduledFireAt: 1 },
        threadKey: "q-42",
      }),
      undefined,
    );
    expect(session.pendingCodexInputs[0]).toMatchObject({ leaderTimerMessageId: "f1", threadKey: "q-42" });
    expect(session.recoveryDeliveryTransfers).toEqual([]);
    expectOwnedOrTerminal(session);
  });

  it("persists transfer precedence before removing the old owner", async () => {
    const session = makeSession();
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const deps = makeDeps(snapshots);

    await beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, deps);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.recoveryDeliveryTransfers).toHaveLength(1);
    expect(snapshots[0]?.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(1);
    expect(snapshots[1]?.state.codex_result_error_auto_pause).toBeNull();
    for (const snapshot of snapshots) expectOwnedOrTerminal(snapshot);
    expectOwnedOrTerminal(session);
  });

  it("retains transfer ownership through delayed ingress, then persists pending before cleanup", async () => {
    const session = makeSession();
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    let releaseRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const route = vi.fn(async (target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      await routeGate;
      if (routed.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: "pending-1",
        content: routed.content,
        timestamp: 20,
        cancelable: true,
        autoPauseRecoveries: routed.autoPauseRecoveries,
      } as any);
    });
    const deps = makeDeps(snapshots, route);
    const transfers = await beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, deps);

    const delivering = deliverRecoveryDeliveryTransfer(session, transfers.get("held-1")!, deps);
    await Promise.resolve();
    expect(session.recoveryDeliveryTransfers).toHaveLength(1);
    expectOwnedOrTerminal(session);
    releaseRoute();
    await delivering;

    expect(route).toHaveBeenCalledTimes(1);
    expect(session.recoveryDeliveryTransfers).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expectOwnedOrTerminal(session);
    for (const snapshot of snapshots) expectOwnedOrTerminal(snapshot);
    expect(deps.releasePendingTransfer).toHaveBeenCalledTimes(1);
  });

  it("persists terminal rejection with transfer ownership before safe cleanup", async () => {
    const session = makeSession();
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const deps = makeDeps(snapshots, vi.fn());
    const transfers = await beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, deps);

    await deliverRecoveryDeliveryTransfer(session, transfers.get("held-1")!, deps);

    expect(receiptOutcome(session)).toBe("failed");
    expect(session.recoveryDeliveryTransfers).toHaveLength(0);
    for (const snapshot of snapshots) expectOwnedOrTerminal(snapshot);
    expectOwnedOrTerminal(session);
    expect(deps.releasePendingTransfer).not.toHaveBeenCalled();
  });

  it.each([1, 25, 100])("drains %i transfers with bounded state and exact-once cleanup", async (count) => {
    const groups = Array.from({ length: count }, (_, index) => `group-${index + 1}`);
    const session = makeSession(groups);
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const route = vi.fn((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
      if (routed.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: `pending-${target.pendingCodexInputs.length + 1}`,
        content: routed.content,
        timestamp: 30,
        cancelable: true,
        autoPauseRecoveries: routed.autoPauseRecoveries,
      } as any);
    });
    const deps = makeDeps(snapshots, route);
    const transfers = await beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, deps);
    expect(session.recoveryDeliveryTransfers).toHaveLength(count);

    let completed = 0;
    for (const transferId of transfers.values()) {
      await deliverRecoveryDeliveryTransfer(session, transferId, deps);
      completed += 1;
      expect(session.recoveryDeliveryTransfers).toHaveLength(count - completed);
    }

    expect(route).toHaveBeenCalledTimes(count);
    expect(session.pendingCodexInputs).toHaveLength(count);
    expect(session.recoveryDeliveryTransfers).toHaveLength(0);
    for (const groupId of groups) expectOwnedOrTerminal(session, groupId);
    for (const snapshot of snapshots) {
      for (const groupId of groups) expectOwnedOrTerminal(snapshot, groupId);
    }
  });

  it("keeps the source owner intact when bounded transfer capacity is exceeded", async () => {
    const groups = Array.from({ length: RECOVERY_DELIVERY_TRANSFER_MAX_COUNT + 1 }, (_, index) => `group-${index + 1}`);
    const session = makeSession(groups);
    const removeSource = vi.fn(() => {
      session.state.codex_result_error_auto_pause = null;
    });

    await expect(
      beginRecoveryDeliveryTransferHandoff(
        session,
        candidates(session),
        { onSourceOwnersRemoved: removeSource },
        {
          persistSessionImmediately: vi.fn(async () => {}),
        },
      ),
    ).rejects.toThrow("capacity exceeded");

    expect(removeSource).not.toHaveBeenCalled();
    expect(session.recoveryDeliveryTransfers).toHaveLength(0);
    expect(session.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(groups.length);
  });

  it("rejects distinct transfers sharing one source owner before a Map can overwrite either lookup", async () => {
    const session = makeSession(["group-1", "group-2"]);
    const heldInputs = session.state.codex_result_error_auto_pause!.heldInputs;
    heldInputs[0]!.id = "duplicate-source-owner";
    heldInputs[1]!.id = "duplicate-source-owner";
    const persistSessionImmediately = vi.fn(async () => {});

    await expect(
      beginRecoveryDeliveryTransferHandoff(session, candidates(session), {}, { persistSessionImmediately }),
    ).rejects.toThrow("source owner collision");

    expect(persistSessionImmediately).not.toHaveBeenCalled();
    expect(session.recoveryDeliveryTransfers).toEqual([]);
    expect(session.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(2);
  });

  it("restarts from an overlap snapshot without reconstructing payload from the summary", async () => {
    const session = makeSession();
    const dir = mkdtempSync(join(tmpdir(), "takode-recovery-transfer-"));
    tempDirs.push(dir);
    const store = new SessionStore(dir);
    let unblockFirstPersist!: () => void;
    const firstPersistGate = new Promise<void>((resolve) => {
      unblockFirstPersist = resolve;
    });
    let persistCalls = 0;
    const beginPromise = beginRecoveryDeliveryTransferHandoff(
      session,
      candidates(session),
      {},
      {
        persistSessionImmediately: async (target) => {
          persistCalls += 1;
          await store.saveImmediate(persisted(target));
          if (persistCalls === 1) await firstPersistGate;
        },
      },
    );
    await vi.waitFor(async () => {
      const onDisk = await store.load(session.id);
      expect(onDisk?.recoveryDeliveryTransfers).toHaveLength(1);
      expect(onDisk?.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(1);
    });

    // Simulate restart from the first durable overlap snapshot.
    const overlap = (await store.load(session.id))!;
    expect(JSON.stringify(overlap.recoveryDeliveryTransfers)).not.toContain("recoveryDeliveryTransferId");
    const restored = makeSession();
    restored.state = overlap.state;
    restored.messageHistory = overlap.messageHistory;
    restored.pendingCodexInputs = overlap.pendingCodexInputs ?? [];
    restored.pendingCodexTurns = overlap.pendingCodexTurns ?? [];
    restored.recoveryDeliveryTransfers = normalizePersistedRecoveryDeliveryTransfers(overlap.recoveryDeliveryTransfers);
    const routedPayloads: string[] = [];
    const deps: RecoveryDeliveryTransferDeps = {
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      persistSessionImmediately: async (target) => store.saveImmediate(persisted(target)),
      getBrowserTransportDeps: () =>
        makeIngressDeps((target: BrowserTransportSessionLike, routed: BrowserOutgoingMessage) => {
          if (routed.type !== "user_message") return;
          routedPayloads.push(routed.content);
          target.pendingCodexInputs.push({
            id: "restored-pending",
            content: routed.content,
            timestamp: 40,
            cancelable: true,
            autoPauseRecoveries: routed.autoPauseRecoveries,
          } as any);
        }),
      releasePendingTransfer: vi.fn(),
    };

    await resumeRecoveryDeliveryTransfers(restored, deps);
    await resumeRecoveryDeliveryTransfers(restored, deps);

    expect(routedPayloads).toEqual(["private payload group-1"]);
    expect(restored.recoveryDeliveryTransfers).toHaveLength(0);
    expect(restored.state.codex_result_error_auto_pause).toBeNull();
    expect(restored.pendingCodexInputs).toHaveLength(1);
    expect(JSON.stringify(restored.messageHistory)).not.toContain("private payload group-1");
    expectOwnedOrTerminal(restored);
    const finalDisk = await store.load(restored.id);
    expect(finalDisk?.recoveryDeliveryTransfers).toEqual([]);
    expect(finalDisk?.pendingCodexInputs).toHaveLength(1);

    unblockFirstPersist();
    await beginPromise;
  });

  it("selectively splits legacy coalesced overlap sources whose transfer predates same-pause identity", async () => {
    const session = makeSession();
    const held = session.state.codex_result_error_auto_pause!.heldInputs[0]!;
    held.count = 3;
    held.message = {
      type: "user_message",
      content: "latest coalesced newcomer",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    };
    session.recoveryDeliveryTransfers = [
      {
        id: "recovery-transfer-coalesced1234567890",
        createdAt: 1,
        sourceOwnerKind: "auto_pause",
        sourceOwnerId: held.id,
        sourceOwnerCount: 1,
        payloadBytes: 100,
        message: messageFor("group-1", "captured original payload"),
      },
    ];
    const routed: string[] = [];
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const deps = makeDeps(snapshots, (target: BrowserTransportSessionLike, input: BrowserOutgoingMessage) => {
      if (input.type !== "user_message") return;
      routed.push(input.content);
      target.pendingCodexInputs.push({
        id: "captured-pending",
        content: input.content,
        timestamp: 50,
        cancelable: true,
        autoPauseRecoveries: input.autoPauseRecoveries,
      } as any);
    });

    await resumeRecoveryDeliveryTransfers(session, deps);

    expect(routed).toEqual([]);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.state.codex_result_error_auto_pause?.heldInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("retained-"),
          count: 2,
          message: expect.objectContaining({ content: "latest coalesced newcomer" }),
        }),
        expect.objectContaining({
          count: 1,
          message: expect.objectContaining({ content: "captured original payload" }),
        }),
      ]),
    );
    const entry = session.messageHistory[0];
    expect(entry?.type).toBe("codex_auto_pause_recovery_summary");
    if (entry?.type === "codex_auto_pause_recovery_summary") {
      expect(entry.recovery.receipts[0]).toMatchObject({ count: 1, coalescedCount: 0 });
    }
    expect(session.recoveryDeliveryTransfers).toEqual([]);
    expectOwnedOrTerminal(session);
  });

  it("fails closed before reusing a transfer whose recovery link has no matching receipt", async () => {
    const session = makeSession();
    const held = session.state.codex_result_error_auto_pause!.heldInputs[0]!;
    session.recoveryDeliveryTransfers = [
      {
        id: "recovery-transfer-membership-mismatch",
        createdAt: 1,
        sourceOwnerKind: "auto_pause",
        sourceOwnerId: held.id,
        sourceOwnerCount: 1,
        payloadBytes: 100,
        message: messageFor("missing-group", "captured private payload"),
      },
    ];
    const persistSessionImmediately = vi.fn(async () => {});

    await expect(resumeRecoveryDeliveryTransfers(session, makeDeps([]))).rejects.toThrow("summary membership mismatch");
    await expect(
      beginRecoveryDeliveryTransferHandoff(
        session,
        [
          {
            sourceOwnerKind: "auto_pause",
            sourceOwnerId: held.id,
            sourceOwnerCount: held.count,
            message: messageFor("missing-group", "captured private payload"),
          },
        ],
        {},
        { persistSessionImmediately },
      ),
    ).rejects.toThrow("summary membership mismatch");

    expect(persistSessionImmediately).not.toHaveBeenCalled();
    expect(session.state.codex_result_error_auto_pause?.heldInputs).toEqual([held]);
    expect(session.recoveryDeliveryTransfers).toHaveLength(1);
  });

  it("uses the complete transfer identity and retries live retained-owner collisions deterministically", async () => {
    const { session, sourceIds } = makeReviewerCollisionSession(2);
    const preparedCandidates = candidates(session);
    const snapshots: RecoveryDeliveryTransferSessionLike[] = [];
    let overlap!: RecoveryDeliveryTransferSessionLike;
    let persistCalls = 0;

    const transferIds = await beginRecoveryDeliveryTransferHandoff(
      session,
      preparedCandidates,
      {},
      {
        persistSessionImmediately: vi.fn(async (target: RecoveryDeliveryTransferSessionLike) => {
          persistCalls += 1;
          if (persistCalls === 1) {
            const firstTransfer = target.recoveryDeliveryTransfers.find(
              (entry) => entry.sourceOwnerId === REVIEWER_COLLIDING_SOURCE_IDS[0],
            )!;
            const collidingBase = `codex-auto-pause-retained-${firstTransfer.id}`;
            const heldInputs = target.state.codex_result_error_auto_pause!.heldInputs;
            for (const [index, held] of heldInputs.entries()) {
              held.count += 1;
              held.lastQueuedAt = 100 + index;
              held.message = {
                type: "user_message",
                content: `latest newcomer ${index + 1}`,
                agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
              };
            }
            heldInputs.push({
              id: `${collidingBase}-2`,
              queuedAt: 102,
              lastQueuedAt: 102,
              source: "programmatic",
              count: 1,
              message: { type: "user_message", content: "pre-existing retained owner" },
            });
            target.pendingCodexInputs.push({
              id: collidingBase,
              content: "ordinary pending owner",
              timestamp: 103,
              cancelable: true,
            });
            target.state.pause = {
              pausedAt: 104,
              queuedMessages: [
                {
                  id: `${collidingBase}-1`,
                  queuedAt: 104,
                  source: "browser",
                  message: { type: "user_message", content: "manual owner" },
                },
              ],
            };
            overlap = structuredClone(target);
          }
          snapshots.push(structuredClone(target));
        }),
      },
    );

    const firstTransferId = transferIds.get(REVIEWER_COLLIDING_SOURCE_IDS[0])!;
    const secondTransferId = transferIds.get(REVIEWER_COLLIDING_SOURCE_IDS[1])!;
    expect(firstTransferId.slice(-12)).toBe("ed2000000073");
    expect(secondTransferId.slice(-12)).toBe("ed2000000073");
    expect(firstTransferId).not.toBe(secondTransferId);
    expect(transferIds.size).toBe(2);

    const activeRetained = session.state.codex_result_error_auto_pause!.heldInputs.filter((item) =>
      item.message.content.startsWith("latest newcomer"),
    );
    expect(activeRetained.map((item) => item.id)).toEqual([
      `codex-auto-pause-retained-${firstTransferId}-3`,
      `codex-auto-pause-retained-${secondTransferId}`,
    ]);
    expect(new Set(session.state.codex_result_error_auto_pause!.heldInputs.map((item) => item.id)).size).toBe(
      session.state.codex_result_error_auto_pause!.heldInputs.length,
    );
    for (const sourceId of sourceIds) expectOwnedOrTerminal(session, sourceId, REVIEWER_COLLISION_SUMMARY_ID);

    const restored = structuredClone(overlap);
    restored.recoveryDeliveryTransfers = normalizePersistedRecoveryDeliveryTransfers(overlap.recoveryDeliveryTransfers);
    const restoredSnapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const restoredDeps = makeDeps(restoredSnapshots);
    await resumeRecoveryDeliveryTransfers(restored, restoredDeps);
    const restoredRetained = restored.state.codex_result_error_auto_pause!.heldInputs.filter((item) =>
      item.message.content.startsWith("latest newcomer"),
    );
    expect(restoredRetained.map((item) => item.id)).toEqual(activeRetained.map((item) => item.id));
    expect(restored.recoveryDeliveryTransfers).toEqual([]);
    const restoredIds = restored.state.codex_result_error_auto_pause!.heldInputs.map((item) => item.id);
    expect(new Set(restoredIds).size).toBe(restoredIds.length);
    const snapshotCount = restoredSnapshots.length;
    await resumeRecoveryDeliveryTransfers(restored, restoredDeps);
    expect(restoredSnapshots).toHaveLength(snapshotCount);
    for (const sourceId of sourceIds) {
      expectOwnedOrTerminal(restored, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
      for (const snapshot of restoredSnapshots) {
        expectOwnedOrTerminal(snapshot, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
      }
    }
  });

  it("keeps 100 partial-coalescing transfer lookups one-to-one across active and restored drains", async () => {
    const { session, sourceIds } = makeReviewerCollisionSession(100);
    const preparedCandidates = candidates(session);
    let overlap!: RecoveryDeliveryTransferSessionLike;
    let persistCalls = 0;
    const activeSnapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const transferIds = await beginRecoveryDeliveryTransferHandoff(
      session,
      preparedCandidates,
      {},
      {
        persistSessionImmediately: vi.fn(async (target: RecoveryDeliveryTransferSessionLike) => {
          persistCalls += 1;
          if (persistCalls === 1) {
            for (const [index, held] of target.state.codex_result_error_auto_pause!.heldInputs.entries()) {
              held.count += 1;
              held.lastQueuedAt = 1_000 + index;
              held.message = {
                type: "user_message",
                content: `latest bounded newcomer ${index + 1}`,
                agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
              };
            }
            overlap = structuredClone(target);
          }
          activeSnapshots.push(structuredClone(target));
        }),
      },
    );

    expect(transferIds.size).toBe(100);
    expect(new Set(transferIds.values()).size).toBe(100);
    for (const [index, sourceId] of sourceIds.entries()) {
      const transferId = transferIds.get(sourceId)!;
      const transfer = session.recoveryDeliveryTransfers.find((entry) => entry.id === transferId);
      expect(transfer?.sourceOwnerId).toBe(sourceId);
      expect(transfer?.message.content).toBe(`captured payload ${index + 1}`);
      expectOwnedOrTerminal(session, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
    }
    const activeRetainedIds = session.state.codex_result_error_auto_pause!.heldInputs.map((item) => item.id);
    expect(activeRetainedIds).toHaveLength(100);
    expect(new Set(activeRetainedIds).size).toBe(100);

    const restored = structuredClone(overlap);
    restored.recoveryDeliveryTransfers = normalizePersistedRecoveryDeliveryTransfers(overlap.recoveryDeliveryTransfers);
    const restoredSnapshots: RecoveryDeliveryTransferSessionLike[] = [];
    const deps = makeDeps(restoredSnapshots);
    await resumeRecoveryDeliveryTransfers(restored, deps);
    await resumeRecoveryDeliveryTransfers(restored, deps);

    expect(restored.recoveryDeliveryTransfers).toEqual([]);
    const restoredIds = restored.state.codex_result_error_auto_pause!.heldInputs.map((item) => item.id);
    expect(new Set(restoredIds).size).toBe(restoredIds.length);
    for (const sourceId of sourceIds) {
      expectOwnedOrTerminal(restored, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
      for (const snapshot of activeSnapshots) {
        expectOwnedOrTerminal(snapshot, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
      }
      for (const snapshot of restoredSnapshots) {
        expectOwnedOrTerminal(snapshot, sourceId, REVIEWER_COLLISION_SUMMARY_ID);
      }
    }
  });

  it("selectively removes a captured manual owner while restart retains later queued arrivals", async () => {
    const session = makeSession();
    session.state.codex_result_error_auto_pause = null;
    const capturedMessage = messageFor("group-1", "captured manual payload");
    session.state.pause = {
      pausedAt: 60,
      queuedMessages: [
        { id: "manual-captured", queuedAt: 61, source: "browser", message: capturedMessage },
        {
          id: "manual-newcomer",
          queuedAt: 62,
          source: "browser",
          message: { type: "user_message", content: "later manual newcomer" },
        },
      ],
    };
    session.recoveryDeliveryTransfers = [
      {
        id: "recovery-transfer-manual123456789012",
        createdAt: 1,
        sourceOwnerKind: "manual_pause",
        sourceOwnerId: "manual-captured",
        sourceOwnerCount: 1,
        payloadBytes: 100,
        message: capturedMessage,
      },
    ];
    const deps = makeDeps([], (target: BrowserTransportSessionLike, input: BrowserOutgoingMessage) => {
      if (input.type !== "user_message") return;
      target.pendingCodexInputs.push({
        id: "manual-pending",
        content: input.content,
        timestamp: 63,
        cancelable: true,
        autoPauseRecoveries: input.autoPauseRecoveries,
      } as any);
    });

    await resumeRecoveryDeliveryTransfers(session, deps);

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.state.pause?.queuedMessages).toEqual([
      expect.objectContaining({
        id: "manual-newcomer",
        message: { type: "user_message", content: "later manual newcomer" },
      }),
      expect.objectContaining({
        message: expect.objectContaining({ content: "captured manual payload" }),
      }),
    ]);
    expect(session.recoveryDeliveryTransfers).toEqual([]);
    expectOwnedOrTerminal(session);
  });
});
