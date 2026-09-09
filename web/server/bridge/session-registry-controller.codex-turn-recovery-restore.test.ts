import { describe, expect, it, vi } from "vitest";
import { createSessionAttentionProjectionDefinition } from "../session-attention-projection.js";
import { buildPersistedSessionPayload, restorePersistedSessions } from "./session-registry-controller.js";
import { setAttention } from "./session-notification-controller.js";
import { injectCompactionRecovery } from "./compaction-recovery.js";

const recovery = {
  recoveryId: "original-owner",
  originalOwnerId: "original-owner",
  originalProviderTurnId: "turn-original",
  originalHistoryIndex: 0,
  continuationOwnerId: null,
  threadKey: "q-recovery",
  questId: "q-recovery",
  status: "continuation_pending",
  reason: "interrupted_after_activity",
  attempt: 1,
  maxAttempts: 1,
  createdAt: 10,
  updatedAt: 20,
} as const;

function persisted(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-recovery",
    state: {
      backend_type: "codex",
      backend_state: "disconnected",
      backend_error: null,
      isOrchestrator: true,
      codex_turn_recovery: recovery,
    },
    messageHistory: [
      {
        type: "user_message",
        id: "original-owner",
        content: "finish the work",
        timestamp: 1,
        threadKey: "q-recovery",
        questId: "q-recovery",
      },
    ],
    pendingPermissions: [],
    pendingMessages: [],
    pendingCodexInputs: [],
    pendingCodexTurns: [],
    ...overrides,
  };
}

const deps = () => ({
  recoverToolStartTimesFromHistory: vi.fn(),
  finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
  scheduleCodexToolResultWatchdogs: vi.fn(),
  reconcileRestoredBoardState: vi.fn(async () => {}),
});

function deriveAttention(session: any) {
  const definition = createSessionAttentionProjectionDefinition<{}>({
    getSession: () => session,
    isHerdedWorkerSession: () => false,
    authorizeSubscription: () => true,
  });
  const dependencies = definition.selectDependencies(session, session.id);
  return definition.derive(session, session.id, dependencies);
}

describe("restored session activity", () => {
  it("repairs human activity while restoring the latest committed or pending preview owner", async () => {
    const sessions = new Map<string, any>();
    const setLastUserMessageAt = vi.fn();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          messageHistory: [
            { type: "user_message", id: "human", content: "Human", timestamp: 100 },
            {
              type: "user_message",
              id: "injected",
              content: "Timer",
              timestamp: 400,
              agentSource: { sessionId: "timer:t1" },
            },
          ],
          pendingCodexInputs: [
            { id: "pending", content: "Pending human", timestamp: 300, cancelable: true },
            {
              id: "pending-injected",
              content: "Herd event",
              timestamp: 500,
              cancelable: false,
              agentSource: { sessionId: "herd-events" },
            },
          ],
        }),
      ],
      { ...deps(), setLastUserMessageAt },
    );

    expect(setLastUserMessageAt).toHaveBeenCalledOnce();
    expect(setLastUserMessageAt).toHaveBeenCalledWith("session-recovery", 300);
    expect(sessions.get("session-recovery")).toMatchObject({
      lastUserMessage: "Herd event",
      lastMessagePreviewAt: 500,
    });
  });
});

describe("restored Codex interrupted-turn recovery", () => {
  it("round-trips terminal audits outside the active recovery slot without exposing them as session state", async () => {
    // Archived terminal records retain their replay veto after server restart;
    // the browser state and a later queued input remain independently owned.
    const terminal = { ...recovery, status: "action_required", reason: "continuation_interrupted" };
    const saved = persisted({
      state: { ...persisted().state, codex_turn_recovery: null },
      codexTerminalRecoveries: [terminal],
      pendingCodexInputs: [{ id: "later-input", content: "still pending", timestamp: 30, cancelable: true }],
    });
    const sessions = new Map<string, any>();
    await restorePersistedSessions(sessions, [saved], deps());
    const restored = sessions.get(saved.id);
    expect(restored.state.codex_turn_recovery).toBeNull();
    expect(restored.state).not.toHaveProperty("codexTerminalRecoveries");
    expect(restored.codexTerminalRecoveries).toEqual([expect.objectContaining(terminal)]);
    expect(restored.pendingCodexInputs).toEqual(saved.pendingCodexInputs);
    const serialized = JSON.parse(JSON.stringify(buildPersistedSessionPayload(restored)));
    const again = new Map<string, any>();
    await restorePersistedSessions(again, [serialized], deps());
    expect(again.get(saved.id).codexTerminalRecoveries).toEqual(restored.codexTerminalRecoveries);
    expect(again.get(saved.id).pendingCodexInputs).toEqual(saved.pendingCodexInputs);
  });

  it("repairs the durable continuation owner and active status", async () => {
    const source = "system:codex-turn-recovery:original-owner";
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          messageHistory: [
            ...persisted().messageHistory,
            {
              type: "user_message",
              id: "continuation-owner",
              content: "visible continuation",
              timestamp: 2,
              agentSource: { sessionId: source, sessionLabel: "Interrupted Turn Recovery" },
              threadKey: "q-recovery",
              questId: "q-recovery",
            },
          ],
          pendingCodexInputs: [
            {
              id: "continuation-owner",
              content: "visible continuation",
              timestamp: 2,
              cancelable: false,
              agentSource: { sessionId: source, sessionLabel: "Interrupted Turn Recovery" },
              threadKey: "q-recovery",
              questId: "q-recovery",
            },
          ],
          pendingCodexTurns: [
            {
              adapterMsg: { type: "codex_start_pending", pendingInputIds: ["continuation-owner"], inputs: [] },
              userMessageId: "continuation-owner",
              pendingInputIds: ["continuation-owner"],
              userContent: "recovery",
              historyIndex: 1,
              status: "backend_acknowledged",
              dispatchCount: 1,
              createdAt: 2,
              updatedAt: 3,
              acknowledgedAt: 3,
              turnTarget: "current",
              lastError: null,
              turnId: "turn-continuation",
              disconnectedAt: 4,
              resumeConfirmedAt: null,
            },
          ],
        }),
      ],
      deps(),
    );

    expect(sessions.get("session-recovery").state.codex_turn_recovery).toMatchObject({
      continuationOwnerId: "continuation-owner",
      status: "continuation_active",
    });
    expect(sessions.get("session-recovery").attentionReason).toBeNull();
  });

  it.each([
    "manual_compact",
    "manual_recycle",
  ] as const)("preserves exact %s recycle-transfer ownership across restart and injection", async (trigger) => {
    // Preserve both old persisted command records and the dedicated recycle command.
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          codexLeaderRecycleContinuation: {
            trigger,
            requestedAt: 30,
            content: "inspect retained work before continuing",
            recoveryId: "original-owner",
            threadKey: "q-recovery",
            questId: "q-recovery",
          },
        }),
      ],
      deps(),
    );
    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toMatchObject({
      status: "continuation_pending",
      recoveryId: "original-owner",
    });
    expect(restored.codexLeaderRecycleContinuation).toMatchObject({ trigger, recoveryId: "original-owner" });

    const injectUserMessage = vi.fn();
    injectCompactionRecovery(restored, {
      isLeaderSession: () => true,
      isSystemSourceTag: (source) => source?.sessionId?.startsWith("system:") === true,
      injectUserMessage,
    });
    expect(injectUserMessage).toHaveBeenCalledWith(
      restored.id,
      "inspect retained work before continuing",
      {
        sessionId: "system:codex-turn-recovery:original-owner",
        sessionLabel: "Resuming Interrupted Work",
      },
      { threadKey: "q-recovery", questId: "q-recovery" },
      expect.objectContaining({ deliveryContent: expect.stringContaining("inspect retained work") }),
    );
  });

  it.each([false, true])("persists same-thread success retirement after restore (archived: %s)", async (archived) => {
    const sessions = new Map<string, any>();
    const persistHistoryMetadataRepair = vi.fn(async () => {});
    const terminal = {
      ...recovery,
      threadKey: "main",
      questId: undefined,
      status: "action_required",
      reason: "continuation_dispatch_failed",
      updatedAt: 20,
    };
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          _frozenCount: 2,
          state: {
            backend_type: "codex",
            backend_state: "disconnected",
            backend_error: null,
            isOrchestrator: true,
            codex_turn_recovery: archived ? null : terminal,
          },
          codexTerminalRecoveries: archived ? [terminal] : [],
          pendingCodexInputs: [
            { id: "original-owner", content: "old payload", timestamp: 1, cancelable: true },
            {
              id: "late-continuation",
              content: "old continuation",
              timestamp: 25,
              cancelable: true,
              agentSource: { sessionId: "system:codex-turn-recovery:original-owner" },
            },
            { id: "independent", content: "later work", timestamp: 50, cancelable: true },
          ],
          messageHistory: [
            {
              type: "user_message",
              id: "original-owner",
              content: "finish the work",
              timestamp: 1,
              threadKey: "main",
            },
            {
              type: "user_message",
              id: "recovery-diagnostic",
              content: "Review the interrupted work.",
              timestamp: 30,
              agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
              threadKey: "main",
            },
            {
              type: "user_message",
              id: "fresh-follow-up",
              content: "The connection is back; finish anything still missing.",
              timestamp: 40,
              threadKey: "main",
            },
            {
              type: "result",
              data: {
                type: "result",
                subtype: "success",
                is_error: false,
                duration_ms: 1,
                duration_api_ms: 1,
                num_turns: 1,
                total_cost_usd: 0,
                stop_reason: "completed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
                uuid: "fresh-follow-up-result",
                session_id: "session-recovery",
              },
            },
          ],
        }),
      ],
      { ...deps(), persistHistoryMetadataRepair },
    );

    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toBeNull();
    expect(restored.codexTerminalRecoveries).toEqual([]);
    expect(restored.pendingCodexInputs.map((input: any) => input.id)).toEqual(["independent"]);
    expect(restored.messageHistory[1]).toMatchObject({
      id: "recovery-diagnostic",
      codexTurnRecoveryId: "original-owner",
      codexTurnRecoveryResolvedAt: expect.any(Number),
    });
    expect(persistHistoryMetadataRepair).toHaveBeenCalledWith(restored, 2);
  });

  it("keeps restored terminal recovery internal without reviving navigation attention", async () => {
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          attentionReason: "error",
          state: {
            backend_type: "codex",
            backend_state: "disconnected",
            backend_error: null,
            isOrchestrator: true,
            codex_turn_recovery: {
              ...recovery,
              status: "action_required",
              reason: "continuation_dispatch_failed",
              raisedAttention: true,
            },
          },
        }),
      ],
      deps(),
    );

    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      reason: "continuation_dispatch_failed",
      raisedAttention: false,
    });
    expect(restored.attentionReason).toBeNull();
    expect(deriveAttention(restored)).toEqual({ attentionReason: null, status: null });

    setAttention(restored, "error", { persistSession: vi.fn() });
    expect(deriveAttention(restored)).toEqual({ attentionReason: "error", status: null });
  });

  it.each([
    "connected",
    "disconnected",
  ] as const)("preserves a later unrelated failed-turn error across %s restart recovery repair", async (backendState) => {
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          attentionReason: "error",
          state: {
            backend_type: "codex",
            backend_state: backendState,
            backend_error: null,
            isOrchestrator: true,
            codex_turn_recovery: {
              ...recovery,
              status: "action_required",
              reason: "continuation_dispatch_failed",
              raisedAttention: true,
            },
          },
          messageHistory: [
            ...persisted().messageHistory,
            {
              type: "user_message",
              id: "recovery-diagnostic",
              content: "Takode retained this recovery note for audit.",
              timestamp: 21,
              agentSource: { sessionId: "system:codex-leader-recovery-diagnostic" },
              codexTurnRecoveryId: "original-owner",
              threadKey: "q-recovery",
              questId: "q-recovery",
            },
            {
              type: "user_message",
              id: "later-unrelated-owner",
              content: "Run unrelated work in another thread.",
              timestamp: 30,
              threadKey: "q-other",
              questId: "q-other",
            },
            {
              type: "user_message",
              id: "later-timer-co-owner",
              content: "Timer fired while the same provider turn was active.",
              timestamp: 31,
              agentSource: { sessionId: "timer:later-co-owner" },
              threadKey: "q-other",
              questId: "q-other",
            },
            {
              type: "result",
              data: {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                result: "Unrelated work failed",
                duration_ms: 1,
                duration_api_ms: 1,
                num_turns: 1,
                total_cost_usd: 0,
                stop_reason: "failed",
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
                uuid: "later-unrelated-result",
                session_id: "session-recovery",
              },
              threadKey: "q-other",
              questId: "q-other",
            },
          ],
        }),
      ],
      deps(),
    );

    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      raisedAttention: false,
    });
    expect(restored.attentionReason).toBe("error");
    expect(deriveAttention(restored)).toEqual({ attentionReason: "error", status: null });
  });

  it("preserves a later direct-turn disconnect error without requiring a result row", async () => {
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          attentionReason: "error",
          state: {
            backend_type: "codex",
            backend_state: "disconnected",
            backend_error: null,
            isOrchestrator: true,
            codex_turn_recovery: {
              ...recovery,
              status: "action_required",
              reason: "continuation_dispatch_failed",
              raisedAttention: true,
            },
          },
          messageHistory: [
            ...persisted().messageHistory,
            {
              type: "user_message",
              id: "later-disconnected-owner",
              content: "Run separate work while the old recovery remains auditable.",
              timestamp: 30,
              threadKey: "q-other",
              questId: "q-other",
            },
          ],
          pendingCodexTurns: [
            {
              adapterMsg: {
                type: "codex_start_pending",
                pendingInputIds: ["later-disconnected-owner"],
                inputs: [{ content: "Run separate work while the old recovery remains auditable." }],
              },
              userMessageId: "later-disconnected-owner",
              pendingInputIds: ["later-disconnected-owner"],
              userContent: "Run separate work while the old recovery remains auditable.",
              historyIndex: 1,
              status: "backend_acknowledged",
              dispatchCount: 1,
              createdAt: 30,
              updatedAt: 40,
              acknowledgedAt: 35,
              turnTarget: "current",
              lastError: null,
              turnId: "later-disconnected-turn",
              disconnectedAt: 40,
              resumeConfirmedAt: null,
            },
          ],
        }),
      ],
      deps(),
    );

    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toMatchObject({
      status: "action_required",
      raisedAttention: false,
    });
    expect(restored.attentionReason).toBe("error");
    expect(deriveAttention(restored)).toEqual({ attentionReason: "error", status: null });
  });

  it("preserves restored broken-session error attention beside terminal recovery", async () => {
    const sessions = new Map<string, any>();
    await restorePersistedSessions(
      sessions,
      [
        persisted({
          attentionReason: "error",
          state: {
            backend_type: "codex",
            backend_state: "broken",
            backend_error: "Terminal backend failure",
            isOrchestrator: true,
            codex_turn_recovery: {
              ...recovery,
              status: "action_required",
              reason: "recovery_failed",
              raisedAttention: true,
            },
          },
        }),
      ],
      deps(),
    );

    const restored = sessions.get("session-recovery");
    expect(restored.state.codex_turn_recovery).toMatchObject({ status: "action_required", raisedAttention: false });
    expect(restored.attentionReason).toBe("error");
    expect(deriveAttention(restored)).toEqual({ attentionReason: "error", status: null });
  });

  it("does not fabricate executable recovery for archived search-only sessions", async () => {
    const sessions = new Map<string, any>();
    await restorePersistedSessions(sessions, [persisted({ _searchDataOnly: true })], deps());

    expect(sessions.get("session-recovery").state.codex_turn_recovery).toMatchObject({
      status: "continuation_pending",
      attempt: 1,
    });
    expect(sessions.get("session-recovery").searchDataOnly).toBe(true);
  });
});
