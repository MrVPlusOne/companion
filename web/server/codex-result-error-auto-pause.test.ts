import { describe, expect, it } from "vitest";
import {
  buildCodexAutoPauseDiagnostic,
  classifyCodexResultError,
  determineCodexTurnSourceKind,
  determineUserMessageSourceKind,
  getCodexAutoPauseRecoveryProgress,
  getCodexAutoPauseHeldInputCount,
  isCodexAutoPauseRecoveryTesting,
  materializeCodexAutoPausedInputsForDrain,
  noteCodexResultForAutoPause,
  queueCodexAutoPausedInput,
  sweepCodexAutoPausedQueuedBacklog,
} from "./codex-result-error-auto-pause.js";
import type { CLIResultMessage, CodexOutboundTurn, PendingCodexInput, SessionState } from "./session-types.js";

function result(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "stream disconnected before completion: error sending request for url (http://localhost:4000/responses)",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    stop_reason: "failed",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    session_id: "codex-session",
    codex_turn_id: "turn-1",
    uuid: "result-1",
    ...overrides,
  };
}

const COPILOT_AUTH_REFRESH_EXHAUSTED_RESULT =
  "litellm.BadRequestError: GetLLMProvider Exception - litellm.AuthenticationError: " +
  "Failed to refresh API key: Failed to refresh API key after maximum retries\n\n" +
  "original model: github_copilot/gpt-5.6-sol";

function copilotAuthRefreshResult(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return result({ result: COPILOT_AUTH_REFRESH_EXHAUSTED_RESULT, ...overrides });
}

function session(): { state: Pick<SessionState, "codex_result_error_auto_pause"> } {
  return { state: { codex_result_error_auto_pause: null } };
}

function turn(
  sourceKind: "manual" | "automatic",
): Pick<
  CodexOutboundTurn,
  | "autoPauseRecoveryTestingRetired"
  | "autoPauseSourceKind"
  | "providerRecoveryAttempts"
  | "providerRecoveryFamily"
  | "turnTarget"
> {
  return {
    autoPauseSourceKind: sourceKind,
    turnTarget: sourceKind === "manual" ? "current" : null,
    autoPauseRecoveryTestingRetired: false,
  };
}

describe("Codex result-error auto-pause", () => {
  it("classifies only narrow Codex terminal responses backend stream errors", () => {
    expect(classifyCodexResultError(result())).toEqual({
      family: "model_backend_stream_error",
      fingerprint: "model_backend_stream_error:responses",
      message: "Model backend stream disconnected before completion.",
    });
    expect(classifyCodexResultError(result({ codex_turn_id: undefined }))).toBeNull();
    expect(classifyCodexResultError(result({ is_error: false, result: "ok" }))).toBeNull();
    expect(classifyCodexResultError(result({ result: "permission denied by user" }))).toBeNull();
  });

  it("classifies Copilot auth refresh exhaustion only when all high-confidence markers are present", () => {
    expect(classifyCodexResultError(copilotAuthRefreshResult())).toEqual({
      family: "copilot_auth_refresh_exhausted",
      fingerprint: "copilot_auth_refresh_exhausted:github_copilot",
      message: "GitHub Copilot API-key refresh exhausted its retry budget.",
    });
  });

  it.each([
    [
      "generic authentication failure",
      "litellm.AuthenticationError: invalid credentials\n\noriginal model: github_copilot/gpt-5.6-sol",
    ],
    [
      "other provider refresh failure",
      "litellm.AuthenticationError: Failed to refresh API key after maximum retries\n\noriginal model: openai/gpt-5.6-sol",
    ],
    ["permission failure", "permission denied by user for github_copilot/gpt-5.6-sol"],
    ["unrelated 400", "litellm.BadRequestError: status 400 for github_copilot/gpt-5.6-sol"],
  ])("does not classify %s as Copilot auth refresh exhaustion", (_label, rawResult) => {
    expect(classifyCodexResultError(result({ result: rawResult }))).toBeNull();
  });

  it("distinguishes corroborated auth-recovery model rejection from a genuinely unsupported model", () => {
    const unsupported = result({
      result: '{"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}',
    });
    expect(classifyCodexResultError(unsupported)).toEqual({
      family: "model_not_supported",
      fingerprint: "model_not_supported:selected_model",
      message: "The selected model was rejected as unsupported by the provider.",
    });

    expect(
      classifyCodexResultError(
        result({
          ...unsupported,
          codex_provider_failure_context: {
            family: "copilot_auth_refresh_invalidated",
            observedAt: 100,
          },
        }),
      ),
    ).toEqual({
      family: "copilot_auth_refresh_invalidated",
      fingerprint: "copilot_auth_refresh_invalidated:github_copilot",
      message: "GitHub Copilot authentication became invalid while connectivity was recovering.",
    });
  });

  it("pauses uncorroborated unsupported models immediately without suggesting silent fallback", () => {
    const s = session();
    const unsupported = result({
      result: '{"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}',
    });
    const outcome = noteCodexResultForAutoPause(s, unsupported, turn("automatic"), 100);

    expect(outcome.pausedNow).toBe(true);
    expect(outcome.diagnostic).toContain("Choose a supported model, then send a message");
    expect(outcome.diagnostic).toContain("will not change models");
  });

  it("stores and diagnoses Copilot auth refresh exhaustion without retaining raw or credential-like text", () => {
    const sentinel = "sentinel-api-key-value";
    const s = session();
    const outcome = noteCodexResultForAutoPause(
      s,
      copilotAuthRefreshResult({
        result: `${COPILOT_AUTH_REFRESH_EXHAUSTED_RESULT}\nAuthorization: Bearer ${sentinel}`,
      }),
      turn("automatic"),
      100,
    );
    const state = s.state.codex_result_error_auto_pause!;
    const rendered = JSON.stringify({ state, diagnostic: outcome.diagnostic ?? buildCodexAutoPauseDiagnostic(state) });

    expect(state.lastError).toBe("GitHub Copilot API-key refresh exhausted its retry budget.");
    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toContain("Authorization");
    expect(rendered).not.toContain("BadRequestError");
    expect(outcome.diagnostic).toContain("Copilot sign-in could not be refreshed");
    expect(outcome.diagnostic).not.toContain("DNS");
  });

  it("pauses after the first Copilot refresh-exhaustion result", () => {
    const s = session();

    const first = noteCodexResultForAutoPause(s, copilotAuthRefreshResult(), turn("automatic"), 100);

    expect(first.pausedNow).toBe(true);
    expect(s.state.codex_result_error_auto_pause).toMatchObject({
      family: "copilot_auth_refresh_exhausted",
      fingerprint: "copilot_auth_refresh_exhausted:github_copilot",
      streak: 1,
      threshold: 1,
      pausedAt: 100,
    });
  });

  it("counts consecutive classified errors and pauses at the threshold without using recovery state", () => {
    const s = session();

    expect(noteCodexResultForAutoPause(s, result({ uuid: "r1" }), turn("automatic"), 100)).toMatchObject({
      pausedNow: false,
    });
    expect(noteCodexResultForAutoPause(s, result({ uuid: "r2" }), turn("automatic"), 200)).toMatchObject({
      pausedNow: false,
    });
    const third = noteCodexResultForAutoPause(s, result({ uuid: "r3" }), turn("automatic"), 300);

    expect(third.pausedNow).toBe(true);
    expect(s.state.codex_result_error_auto_pause).toMatchObject({
      streak: 3,
      threshold: 3,
      pausedAt: 300,
      fingerprint: "model_backend_stream_error:responses",
    });
  });

  it("resets a non-paused streak after a successful result", () => {
    const s = session();
    noteCodexResultForAutoPause(s, result({ uuid: "r1" }), turn("automatic"), 100);

    const reset = noteCodexResultForAutoPause(
      s,
      result({ is_error: false, result: "ok", subtype: "success", stop_reason: "end_turn" }),
      turn("automatic"),
      200,
    );

    expect(reset.changed).toBe(true);
    expect(s.state.codex_result_error_auto_pause).toBeNull();
  });

  it("keeps automatic sources paused after a matching manual failure and resumes only after manual success", () => {
    const s = session();
    noteCodexResultForAutoPause(s, copilotAuthRefreshResult({ uuid: "r1" }), turn("automatic"), 100);

    const failedManual = noteCodexResultForAutoPause(s, copilotAuthRefreshResult({ uuid: "r2" }), turn("manual"), 200);
    expect(failedManual.pausedNow).toBe(false);
    expect(s.state.codex_result_error_auto_pause?.pausedAt).toBe(100);
    expect(s.state.codex_result_error_auto_pause?.streak).toBe(2);

    queueCodexAutoPausedInput(s, "programmatic", {
      type: "user_message",
      content: "held herd event",
      agentSource: { sessionId: "herd-events" },
    });
    const resumed = noteCodexResultForAutoPause(
      s,
      result({ is_error: false, result: "ok", subtype: "success", stop_reason: "end_turn" }),
      turn("manual"),
      300,
    );

    expect(resumed.resumedNow).toBe(true);
    expect(resumed.heldInputs).toHaveLength(1);
    expect(s.state.codex_result_error_auto_pause).toBeNull();
  });

  it("lets only the matching current provider-recovery owner clear an automatic pause", () => {
    const success = result({ is_error: false, result: "ok", subtype: "success", stop_reason: "end_turn" });
    const accepted = session();
    noteCodexResultForAutoPause(accepted, result({ uuid: "r1" }), turn("automatic"), 100);
    noteCodexResultForAutoPause(accepted, result({ uuid: "r2" }), turn("automatic"), 110);
    noteCodexResultForAutoPause(accepted, result({ uuid: "r3" }), turn("automatic"), 120);
    queueCodexAutoPausedInput(accepted, "programmatic", {
      type: "user_message",
      content: "held herd event",
      agentSource: { sessionId: "herd-events" },
    });

    const recovered = noteCodexResultForAutoPause(
      accepted,
      success,
      {
        ...turn("automatic"),
        turnTarget: "current",
        providerRecoveryAttempts: 151,
        providerRecoveryFamily: "model_backend_stream_error",
      },
      200,
    );

    expect(recovered).toMatchObject({ resumedNow: true });
    expect(recovered.heldInputs).toHaveLength(1);
    expect(accepted.state.codex_result_error_auto_pause).toBeNull();

    for (const rejectedOwner of [
      { ...turn("automatic"), turnTarget: "current" as const },
      {
        ...turn("automatic"),
        turnTarget: "queued" as const,
        providerRecoveryAttempts: 2,
        providerRecoveryFamily: "model_backend_stream_error" as const,
      },
      {
        ...turn("automatic"),
        turnTarget: "current" as const,
        providerRecoveryAttempts: 2,
        providerRecoveryFamily: "copilot_auth_refresh_invalidated" as const,
      },
    ]) {
      const paused = session();
      noteCodexResultForAutoPause(paused, result({ uuid: "x1" }), turn("automatic"), 100);
      noteCodexResultForAutoPause(paused, result({ uuid: "x2" }), turn("automatic"), 110);
      noteCodexResultForAutoPause(paused, result({ uuid: "x3" }), turn("automatic"), 120);

      expect(noteCodexResultForAutoPause(paused, success, rejectedOwner, 200)).toMatchObject({ resumedNow: false });
      expect(paused.state.codex_result_error_auto_pause?.pausedAt).toBe(120);
    }
  });

  it("does not let a retired or queued manual owner clear the pause on later success", () => {
    const success = result({ is_error: false, result: "ok", subtype: "success", stop_reason: "end_turn" });
    for (const owner of [
      { ...turn("manual"), autoPauseRecoveryTestingRetired: true },
      { ...turn("manual"), turnTarget: "queued" as const },
    ]) {
      const s = session();
      noteCodexResultForAutoPause(s, copilotAuthRefreshResult(), turn("automatic"), 100);
      queueCodexAutoPausedInput(s, "programmatic", {
        type: "user_message",
        content: "held herd event",
        agentSource: { sessionId: "herd-events" },
      });

      expect(noteCodexResultForAutoPause(s, success, owner, 200)).toMatchObject({ resumedNow: false });
      expect(s.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(1);
    }
  });

  it("retains the empty held array so a post-success backlog sweep joins the same handoff", () => {
    const s = session();
    noteCodexResultForAutoPause(s, copilotAuthRefreshResult(), turn("automatic"), 100);
    const heldInputs = s.state.codex_result_error_auto_pause!.heldInputs;
    const outcome = noteCodexResultForAutoPause(
      s,
      result({ is_error: false, result: "ok", subtype: "success", stop_reason: "end_turn" }),
      turn("manual"),
      200,
      { retainPausedOwnerOnResume: true },
    );

    expect(outcome.heldInputs).toBe(heldInputs);
    queueCodexAutoPausedInput(s, "programmatic", {
      type: "user_message",
      content: "queued after success classification",
      agentSource: { sessionId: "herd-events" },
    });
    expect(outcome.heldInputs).toHaveLength(1);
  });

  it("coalesces repeated automatic held inputs and materializes one representative on drain", () => {
    const s = session();
    noteCodexResultForAutoPause(s, result({ uuid: "r1" }), turn("automatic"), 100);
    noteCodexResultForAutoPause(s, result({ uuid: "r2" }), turn("automatic"), 200);
    noteCodexResultForAutoPause(s, result({ uuid: "r3" }), turn("automatic"), 300);
    const message = {
      type: "user_message" as const,
      content: "board stalled",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      threadKey: "main",
      autoPauseRecoveries: [{ summaryId: "prior-summary", groupId: "prior-group-a" }],
    };

    queueCodexAutoPausedInput(s, "programmatic", message, 400);
    queueCodexAutoPausedInput(
      s,
      "programmatic",
      { ...message, autoPauseRecoveries: [{ summaryId: "prior-summary", groupId: "prior-group-b" }] },
      500,
    );

    const state = s.state.codex_result_error_auto_pause!;
    expect(state.heldInputs).toHaveLength(1);
    expect(getCodexAutoPauseHeldInputCount(state)).toBe(2);
    const [materialized] = materializeCodexAutoPausedInputsForDrain(state.heldInputs, "current-summary");
    expect(materialized?.content).toContain("2 similar automatic");
    expect(materialized?.autoPauseRecoveries).toEqual([
      { summaryId: "prior-summary", groupId: "prior-group-a" },
      { summaryId: "prior-summary", groupId: "prior-group-b" },
      { summaryId: "current-summary", groupId: state.heldInputs[0]!.id },
    ]);
  });

  it("keeps assigned firings distinct while preserving unassigned timer coalescing", () => {
    // Different admitted fN identities cannot share a held representative.
    // Timers held before admission retain the existing content-based policy.
    const target = session();
    noteCodexResultForAutoPause(target, copilotAuthRefreshResult(), turn("automatic"), 100);
    const message = {
      type: "user_message" as const,
      content: "[⏰ Timer t1 reminder] Report",
      agentSource: { sessionId: "timer:t1" },
      threadKey: "q-42",
      timerFiring: { timerId: "t1", scheduledFireAt: 1 },
    };
    for (const messageId of ["f1", "f2"]) {
      queueCodexAutoPausedInput(
        target,
        "programmatic",
        {
          ...message,
          timerFiring: { ...message.timerFiring, messageId },
        },
        200,
      );
    }
    queueCodexAutoPausedInput(target, "programmatic", message, 210);
    queueCodexAutoPausedInput(
      target,
      "programmatic",
      {
        ...message,
        timerFiring: { ...message.timerFiring, scheduledFireAt: 2 },
      },
      220,
    );

    const held = target.state.codex_result_error_auto_pause!.heldInputs;
    expect(held.map((item) => [item.count, item.message.timerFiring?.messageId])).toEqual([
      [1, "f1"],
      [1, "f2"],
      [2, undefined],
    ]);
    const drained = materializeCodexAutoPausedInputsForDrain(held);
    expect(drained[0].content).toBe(message.content);
    expect(drained[1].content).toBe(message.content);
    expect(drained[2].content).toBe(
      "[Takode auto-pause resumed: 2 similar automatic inputs were coalesced while delivery was paused.]\n\n" +
        message.content,
    );
    expect(drained[2].timerFiring).toEqual({ timerId: "t1", scheduledFireAt: 2 });
  });

  it("treats only composer and explicit manual overrides as manual while background sources are automatic", () => {
    expect(determineUserMessageSourceKind({ type: "user_message", content: "hi", inputSource: "composer" })).toBe(
      "manual",
    );
    expect(
      determineUserMessageSourceKind({
        type: "user_message",
        content: "from takode send",
        autoPauseSourceKind: "manual",
        agentSource: { sessionId: "operator-session" },
      }),
    ).toBe("manual");
    expect(
      determineUserMessageSourceKind({
        type: "user_message",
        content: "internal",
        agentSource: { sessionId: "resource-lease:agent-browser" },
      }),
    ).toBe("automatic");
    expect(
      determineUserMessageSourceKind({
        type: "user_message",
        content: "herd",
        agentSource: { sessionId: "herd-events" },
      }),
    ).toBe("automatic");
    expect(
      determineUserMessageSourceKind({
        type: "user_message",
        content: "timer",
        agentSource: { sessionId: "timer:abc" },
      }),
    ).toBe("automatic");
    expect(
      determineUserMessageSourceKind({ type: "user_message", content: "internal", inputSource: "programmatic" }),
    ).toBe("automatic");
  });

  it("marks a batched Codex turn automatic when any pending input is automatic", () => {
    const manual: PendingCodexInput = {
      id: "m1",
      content: "manual",
      timestamp: 1,
      cancelable: true,
      autoPauseSourceKind: "manual",
    };
    const automatic: PendingCodexInput = {
      id: "a1",
      content: "automatic",
      timestamp: 2,
      cancelable: true,
      agentSource: { sessionId: "herd-events" },
    };

    expect(determineCodexTurnSourceKind([manual])).toBe("manual");
    expect(determineCodexTurnSourceKind([manual, automatic])).toBe("automatic");
  });

  it("holds unrelated automatic backlog without deleting the exact provider-retry owner", () => {
    // The original user row is already committed, so it is absent from
    // pendingCodexInputs. Auto-pause must not mistake that for a stale batch.
    const paused = session();
    noteCodexResultForAutoPause(paused, result({ uuid: "failure-1" }), turn("automatic"), 100);
    noteCodexResultForAutoPause(paused, result({ uuid: "failure-2" }), turn("automatic"), 110);
    noteCodexResultForAutoPause(paused, result({ uuid: "failure-3" }), turn("automatic"), 120);
    const retryOwner = {
      adapterMsg: { type: "codex_start_pending", pendingInputIds: ["original"], inputs: [{ content: "original" }] },
      userMessageId: "original",
      pendingInputIds: ["original"],
      userContent: "original",
      historyIndex: 0,
      status: "queued",
      dispatchCount: 3,
      createdAt: 1,
      updatedAt: 120,
      acknowledgedAt: null,
      turnTarget: "current",
      lastError: null,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
      autoPauseSourceKind: "automatic",
      providerRecoveryAttempts: 3,
      providerRecoveryFamily: "model_backend_stream_error",
    } as CodexOutboundTurn;
    const unrelated = {
      id: "later-automatic",
      content: "later event",
      timestamp: 125,
      cancelable: true,
      autoPauseSourceKind: "automatic",
      leaderThreadOutcomeReminderGuard: {
        version: 1,
        pendingResponseTargets: [],
        missingOutcomeTargets: [{ threadKey: "main", earliestTimestamp: 10 }],
        missingNeedsInputTargets: [],
      },
    } as PendingCodexInput;
    const target = {
      state: paused.state,
      pendingCodexInputs: [unrelated],
      pendingCodexTurns: [retryOwner],
    };

    expect(sweepCodexAutoPausedQueuedBacklog(target, 130)).toMatchObject({
      changed: true,
      heldInputIds: ["later-automatic"],
    });
    expect(target.pendingCodexTurns).toEqual([retryOwner]);
    expect(target.pendingCodexInputs).toHaveLength(0);
    expect(target.state.codex_result_error_auto_pause?.heldInputs).toHaveLength(1);
    expect(
      target.state.codex_result_error_auto_pause?.heldInputs[0]?.message.leaderThreadOutcomeReminderGuard,
    ).toMatchObject({ version: 1 });
  });

  it("derives testing and active progress only from the exact current manual owner", () => {
    // The browser must not infer testing from a local submit or generic running
    // status; current server-owned turn source and ownership are both required.
    const target = session();
    noteCodexResultForAutoPause(target, copilotAuthRefreshResult(), turn("automatic"), 100);
    const activeTurn = {
      autoPauseSourceKind: "manual" as const,
      status: "backend_acknowledged" as const,
      turnTarget: "current" as const,
      turnId: "turn-recovery",
    };

    expect(isCodexAutoPauseRecoveryTesting({ ...target, pendingCodexTurns: [activeTurn] })).toBe(true);
    expect(getCodexAutoPauseRecoveryProgress({ ...target, pendingCodexTurns: [activeTurn] })).toBe("testing");
    expect(
      getCodexAutoPauseRecoveryProgress({
        ...target,
        state: { ...target.state, backend_state: "connected" },
        isGenerating: true,
        codexAdapter: { getCurrentTurnId: () => "turn-recovery" },
        pendingCodexTurns: [activeTurn],
      }),
    ).toBe("active");
    expect(
      getCodexAutoPauseRecoveryProgress({
        ...target,
        state: { ...target.state, backend_state: "connected" },
        isGenerating: true,
        codexAdapter: { getCurrentTurnId: () => "unrelated-turn" },
        pendingCodexTurns: [activeTurn],
      }),
    ).toBeNull();
    expect(
      isCodexAutoPauseRecoveryTesting({
        ...target,
        pendingCodexTurns: [{ ...activeTurn, autoPauseSourceKind: "automatic" }],
      }),
    ).toBe(false);
    expect(
      isCodexAutoPauseRecoveryTesting({
        ...target,
        pendingCodexTurns: [{ ...activeTurn, turnTarget: "queued" }],
      }),
    ).toBe(false);
    expect(
      isCodexAutoPauseRecoveryTesting({ ...target, pendingCodexTurns: [{ ...activeTurn, status: "queued" }] }),
    ).toBe(true);
    expect(
      getCodexAutoPauseRecoveryProgress({
        ...target,
        pendingCodexTurns: [{ ...activeTurn, autoPauseRecoveryTestingRetired: true }],
      }),
    ).toBeNull();
    expect(
      isCodexAutoPauseRecoveryTesting({
        ...target,
        pendingCodexTurns: [{ ...activeTurn, status: "completed" }],
      }),
    ).toBe(false);
  });

  it("keeps Copilot refresh auto-pause state independent across sessions", () => {
    const first = session();
    const second = session();

    noteCodexResultForAutoPause(first, copilotAuthRefreshResult({ uuid: "first" }), turn("automatic"), 100);

    expect(first.state.codex_result_error_auto_pause?.pausedAt).toBe(100);
    expect(second.state.codex_result_error_auto_pause).toBeNull();

    noteCodexResultForAutoPause(second, copilotAuthRefreshResult({ uuid: "second" }), turn("automatic"), 200);

    expect(first.state.codex_result_error_auto_pause?.pausedAt).toBe(100);
    expect(second.state.codex_result_error_auto_pause?.pausedAt).toBe(200);
    expect(first.state.codex_result_error_auto_pause?.heldInputs).not.toBe(
      second.state.codex_result_error_auto_pause?.heldInputs,
    );
  });
});
