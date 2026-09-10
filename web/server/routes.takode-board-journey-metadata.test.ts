import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTakodeBoardRoutes } from "./routes/takode-board.js";
import type { BoardRow } from "./session-types.js";
import * as questStore from "./quest-store.js";
import * as gitUtils from "./git-utils.js";
import * as deliveries from "./quest-code-deliveries.js";

interface TestSession {
  id: string;
  state: Record<string, unknown>;
  board: Map<string, BoardRow>;
  completedBoard: Map<string, BoardRow>;
  notifications: Array<Record<string, unknown>>;
  boardDispatchStates: Map<string, Record<string, unknown>>;
  boardStallStates: Map<string, Record<string, unknown>>;
  attentionRecords: Array<Record<string, unknown>>;
}

let app: Hono;
let session: TestSession;
let sessions: Map<string, TestSession>;
let authCallerId = "leader-1";
let authCaller: Record<string, unknown> = { sessionId: "leader-1", isOrchestrator: true };
let broadcastGlobal: ReturnType<typeof vi.fn>;
let broadcastBoard: ReturnType<typeof vi.fn>;

function createSession(id = "leader-1"): TestSession {
  return {
    id,
    state: {},
    board: new Map(),
    completedBoard: new Map(),
    notifications: [],
    boardDispatchStates: new Map(),
    boardStallStates: new Map(),
    attentionRecords: [],
  };
}

function getBoardRows(sessionId: string): BoardRow[] {
  return [...(sessions.get(sessionId)?.board.values() ?? [])];
}

function createRouteApp(): Hono {
  const api = new Hono();
  broadcastGlobal = vi.fn();
  broadcastBoard = vi.fn();
  const wsBridge = {
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    broadcastGlobal,
    completeDoneBoardRowsForQuest: vi.fn(() => []),
    findAssignedBoardRowsForWorker: vi.fn((workerSessionId: string, questId: string) =>
      [...sessions.values()].flatMap((leader) => {
        const row = [...leader.board.values()].find(
          (candidate) => candidate.questId === questId && candidate.worker === workerSessionId,
        );
        return row ? [{ leaderSessionId: leader.id, row }] : [];
      }),
    ),
  };
  registerTakodeBoardRoutes(api, {
    launcher: {} as any,
    wsBridge: wsBridge as any,
    authenticateTakodeCaller: vi.fn(() => ({
      callerId: authCallerId,
      caller: authCaller,
    })) as any,
    resolveId: vi.fn((raw: string) => raw),
    boardWatchdogDeps: {
      getLauncherSessionInfo: vi.fn((sessionId: string) => ({
        isOrchestrator: sessionId === "leader-1",
        lastActivityAt: 0,
      })),
      getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
      listSessions: vi.fn(() => []),
      resolveSessionId: vi.fn((ref: string) => (sessions.has(ref) ? ref : undefined)),
      timerCount: vi.fn(() => 0),
      backendConnected: vi.fn(() => true),
      getBoard: vi.fn((sessionId: string) => getBoardRows(sessionId)),
      emitTakodeEvent: vi.fn(),
      markNotificationDone: vi.fn(() => true),
      isSessionIdle: vi.fn(() => true),
    },
    workBoardStateDeps: {
      getBoardDispatchableSignature: vi.fn(() => null),
      markNotificationDone: vi.fn(() => true),
      broadcastBoard,
      broadcastAttentionRecords: vi.fn(),
      persistSession: vi.fn(),
      notifyReview: vi.fn(),
    },
    buildBoardRowSessionStatuses: vi.fn(async () => ({})),
    resolveSessionDeps: vi.fn(() => []),
  });
  return api;
}

function setupTakodeSessions(): void {
  session = createSession();
  sessions = new Map([[session.id, session]]);
  authCallerId = "leader-1";
  authCaller = { sessionId: "leader-1", isOrchestrator: true };
  app = createRouteApp();
}

async function postBoard(body: Record<string, unknown>): Promise<Response> {
  return app.request("/sessions/leader-1/board", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function postWorkerMemory(body: Record<string, unknown>): Promise<Response> {
  return app.request("/takode/board/work-to-memory", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function postReplaceWorkEvidence(body: Record<string, unknown>): Promise<Response> {
  return app.request("/takode/board/replace-work-evidence", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("Takode board Journey metadata route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(questStore, "getQuest").mockResolvedValue(null);
    vi.spyOn(questStore, "appendQuestCodeCommitEvidenceForOwner").mockResolvedValue(null);
    vi.spyOn(questStore, "replaceQuestCodeCommitEvidenceForOwner").mockResolvedValue(null);
    vi.spyOn(gitUtils, "getRepoInfoAsync").mockResolvedValue(null);
    vi.spyOn(gitUtils, "gitAsync").mockRejectedValue(new Error("unexpected git command"));
    // This suite isolates owner/phase/race guards. Real target and retention verification lives in port-tracking.test.ts.
    vi.spyOn(deliveries, "buildCodeDelivery").mockImplementation(async (input) => ({
      id: "d".repeat(32),
      recordedAt: 100,
      actorSessionId: input.actorSessionId,
      phaseOccurrenceId: input.phaseOccurrenceId,
      targetHeadSha: "f".repeat(40),
      target: {
        repoRoot: "/fixture/repo",
        checkoutPath: "/fixture/repo",
        branch: "integration",
        mode: "remote-backed",
      },
      commits: input.commitShas.map((sha) => ({
        sha,
        shortSha: sha.slice(0, 7),
        message: "Verified fixture commit",
        timestamp: 100,
        additions: 1,
        deletions: 0,
        binaryFiles: 0,
      })),
    }));
    setupTakodeSessions();
  });

  it("stores the active v2 phase plan and cached quest TLDR metadata on board rows", async () => {
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      title: "Improve Journey chip",
      status: "refined",
      tldr: "Make Journey chips easier to scan.",
    } as any);

    const res = await postBoard({
      questId: "q-9",
      status: "PLANNING",
      phases: ["alignment", "work", "memory"],
      presetId: "v2-work",
    });

    expect(res.status).toBe(200);
    const stored = session.board.get("q-9")!;
    expect(stored.title).toBe("Improve Journey chip");
    expect(stored.questTldr).toBe("Make Journey chips easier to scan.");
    expect(stored.journey).toMatchObject({
      presetId: "v2-work",
      phaseIds: ["alignment", "work", "memory"],
      activePhaseIndex: 0,
      currentPhaseId: "alignment",
    });
  });

  it("rejects a direct Codex-owned quest before creating a Takode Journey row", async () => {
    // Board admission is provider-aware even when a Takode worker exists with
    // the same raw ID as the direct Codex task.
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Direct Codex work",
      status: "in_progress",
      description: "Owned outside Takode orchestration.",
      sessionId: "worker-1",
      ownerKind: "codex",
      claimedAt: 2,
      createdAt: 1,
    });

    const res = await postBoard({
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      phases: ["alignment", "work", "memory"],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("owned by a direct Codex task") });
    expect(session.board.has("q-9")).toBe(false);
  });

  it("fails closed when board admission cannot verify Quest ownership", async () => {
    // Ownership verification is an admission check, not optional title/TLDR
    // enrichment, so transient store failures must not create an unchecked row.
    vi.mocked(questStore.getQuest).mockRejectedValueOnce(new Error("store unavailable"));

    const res = await postBoard({
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      phases: ["alignment", "work", "memory"],
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Cannot verify quest ownership") });
    expect(session.board.has("q-9")).toBe(false);
  });

  it("rejects legacy v1 phases and states for new active rows", async () => {
    const legacyPhase = await postBoard({
      questId: "q-9",
      phases: ["alignment", "implement", "memory"],
    });
    expect(legacyPhase.status).toBe(400);
    expect(await legacyPhase.json()).toMatchObject({
      error: expect.stringContaining("legacy v1 phase IDs are historical-read only"),
    });

    const legacyStatus = await postBoard({
      questId: "q-9",
      status: "IMPLEMENTING",
      phases: ["alignment", "work", "memory"],
    });
    expect(legacyStatus.status).toBe(400);
    expect(await legacyStatus.json()).toMatchObject({
      error: expect.stringContaining("Invalid active Quest Journey state"),
    });
  });

  it("links and clears active User Checkpoint waits without changing the Work occurrence", async () => {
    session.notifications.push({ id: "n-4", category: "needs-input", done: false });
    await postBoard({
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      phases: ["alignment", "work", "memory"],
      activePhaseIndex: 1,
    });

    const pause = await postBoard({
      questId: "q-9",
      status: "USER_CHECKPOINTING",
      activePhaseIndex: 1,
      waitForInput: ["n-4"],
    });
    expect(pause.status).toBe(200);
    expect(session.board.get("q-9")?.journey?.currentPhaseId).toBe("work");
    expect(session.board.get("q-9")?.waitForInput).toEqual(["n-4"]);

    const resume = await postBoard({
      questId: "q-9",
      status: "WORKING",
      activePhaseIndex: 1,
      clearWaitForInput: true,
    });
    expect(resume.status).toBe(200);
    expect(session.board.get("q-9")?.journey?.currentPhaseId).toBe("work");
    expect(session.board.get("q-9")?.waitForInput).toBeUndefined();
  });

  it("persists code commits and invalidates quest previews before moving Work to Memory", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      title: "Quest",
      worker: "worker-1",
      workerNum: 5,
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      title: "Quest",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          kind: "phase_summary",
          phaseId: "work",
          text: "Work note with enough detail to count as current and useful for final Memory handoff.",
          ts: 10,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(questStore.appendQuestCodeCommitEvidenceForOwner).mockImplementationOnce(async () => {
      // Tie changed reads to persistence, not to a fragile number of preflight reads.
      expect(session.board.get("q-9")?.status).toBe("WORKING");
      vi.mocked(questStore.getQuest).mockResolvedValue({ ...claimedQuest, commitShas: ["abc1234", "deadbeef"] });
      return { ...claimedQuest, commitShas: ["abc1234", "deadbeef"] };
    });

    const res = await postWorkerMemory({
      questId: "q-9",
      workFeedbackIndex: 0,
      commitShas: ["ABC1234", "abc1234", "deadbeef"],
    });

    expect(res.status).toBe(200);
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).toHaveBeenCalledWith(
      "q-9",
      { kind: "takode", sessionId: "worker-1" },
      ["abc1234", "deadbeef"],
      expect.objectContaining({ actorSessionId: "worker-1" }),
    );
    expect(broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
    expect(broadcastGlobal.mock.invocationCallOrder[0]).toBeLessThan(broadcastBoard.mock.invocationCallOrder[0]);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
    expect(session.board.get("q-9")?.journey).toMatchObject({
      activePhaseIndex: 2,
      currentPhaseId: "memory",
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      questId: "q-9",
      previousState: "WORKING",
      newState: "MEMORY",
      workFeedbackIndex: 0,
    });
  });

  it("rejects an older-run Work note until the active run occurrence has its own note", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const currentRun = {
      runId: "board-leader-1-20",
      source: "board",
      status: "active",
      createdAt: 20,
      updatedAt: 21,
      phaseIds: ["alignment", "work", "memory"],
      phaseOccurrences: [
        {
          occurrenceId: "preserved-current-work-occurrence",
          phaseId: "work",
          phaseIndex: 1,
          phasePosition: 2,
          phaseOccurrence: 1,
          status: "active",
        },
      ],
    };
    const oldOnlyQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      journeyRuns: [currentRun],
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          kind: "phase_summary",
          phaseId: "work",
          journeyRunId: "board-leader-1-10",
          phaseOccurrenceId: "board-leader-1-10:p2",
          text: "Prior-run Work note with enough detail to prove that stale phase evidence must not authorize Memory.",
          ts: 10,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValueOnce(oldOnlyQuest);

    const stale = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: expect.stringContaining("active Journey run") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");

    const currentQuest = {
      ...oldOnlyQuest,
      feedback: [
        ...oldOnlyQuest.feedback,
        {
          author: "agent",
          authorSessionId: "worker-1",
          kind: "phase_summary",
          phaseId: "work",
          journeyRunId: "board-leader-1-20",
          phaseOccurrenceId: "preserved-current-work-occurrence",
          text: "Current-run Work note with enough detail to authorize the exact active occurrence handoff to Memory.",
          ts: 22,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(currentQuest);

    const current = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(current.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
  });

  it("does not accept a deleted Work feedback slot as transition evidence", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      title: "Quest",
      worker: "worker-1",
      workerNum: 5,
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      title: "Quest",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          kind: "phase_summary",
          phaseId: "work",
          text: "Deleted Work evidence that must never authorize a transition even if stale content remains.",
          ts: 10,
          deletedAt: 11,
        },
      ],
    } as any);

    const res = await postWorkerMemory({ questId: "q-9", workFeedbackIndex: 0, noCode: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not the current Work phase note") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("does not treat a same-ID direct Codex owner as the assigned Takode worker", async () => {
    // The raw session ID alone is insufficient for Work -> Memory authority.
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Direct Codex work",
      status: "in_progress",
      description: "Owned outside Takode orchestration.",
      sessionId: "worker-1",
      ownerKind: "codex",
      claimedAt: 2,
      createdAt: 1,
    });

    const res = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("assigned worker") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it.each([
    ["missing evidence", { questId: "q-9" }],
    ["both evidence modes", { questId: "q-9", commitShas: ["abc1234"], noCode: true }],
    ["empty commit list", { questId: "q-9", commitShas: [] }],
    ["invalid commit", { questId: "q-9", commitShas: ["not-a-sha"] }],
  ])("rejects Work to Memory with %s", async (_label, body) => {
    const res = await postWorkerMemory(body);

    expect(res.status).toBe(400);
    expect(session.board.has("q-9")).toBe(false);
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("allows explicit zero-code Work to enter Memory without attaching commits", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          kind: "phase_summary",
          text: "Zero-code Work note with enough detail to establish the accepted outcome and Memory handoff.",
          ts: 1,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);

    const res = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(res.status).toBe(200);
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
    expect(broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
    expect(broadcastGlobal.mock.invocationCallOrder[0]).toBeLessThan(broadcastBoard.mock.invocationCallOrder[0]);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
  });

  it("blocks unaddressed human feedback before commit persistence", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail, but it cannot supersede unresolved human feedback.",
          ts: 1,
        },
        { author: "human", text: "Please correct the remaining issue.", addressed: false, ts: 2 },
      ],
    } as any);

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("human feedback") });
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
    expect(broadcastGlobal).not.toHaveBeenCalled();
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("ignores deleted human feedback when checking transition eligibility", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence remains eligible after an obsolete human feedback slot has been deleted.",
          ts: 1,
        },
        {
          author: "human",
          text: "Obsolete human feedback that should no longer block the transition.",
          addressed: false,
          ts: 2,
          deletedAt: 3,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);

    const res = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(res.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
  });

  it("leaves the board in Work when commit persistence fails", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail to permit a guarded handoff when persistence succeeds.",
          ts: 1,
        },
      ],
    } as any);
    vi.mocked(questStore.appendQuestCodeCommitEvidenceForOwner).mockRejectedValueOnce(new Error("disk unavailable"));

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(503);
    expect(session.board.get("q-9")?.status).toBe("WORKING");
    expect(broadcastGlobal).not.toHaveBeenCalled();
  });

  it("re-reads quest ownership after commit persistence before entering Memory", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail to permit a guarded handoff while ownership remains stable.",
          ts: 1,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(questStore.appendQuestCodeCommitEvidenceForOwner).mockImplementationOnce(async () => {
      // Ownership changes at the asynchronous write boundary, after all preflight reads.
      vi.mocked(questStore.getQuest).mockResolvedValue({
        ...claimedQuest,
        sessionId: "worker-2",
        commitShas: ["abc1234"],
      });
      return { ...claimedQuest, commitShas: ["abc1234"] };
    });

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("ownership changed") });
    expect(broadcastGlobal).not.toHaveBeenCalled();
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("rechecks human feedback after commit persistence before entering Memory", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail while no human feedback is pending at initial validation.",
          ts: 1,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(questStore.appendQuestCodeCommitEvidenceForOwner).mockImplementationOnce(async () => {
      // Pending feedback arrives during persistence, not on an arbitrary read count.
      vi.mocked(questStore.getQuest).mockResolvedValue({
        ...claimedQuest,
        commitShas: ["abc1234"],
        feedback: [
          ...claimedQuest.feedback,
          { author: "human", text: "New feedback arrived during the handoff.", addressed: false, ts: 2 },
        ],
      });
      return { ...claimedQuest, commitShas: ["abc1234"] };
    });

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("human feedback") });
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).toHaveBeenCalledOnce();
    expect(broadcastGlobal).not.toHaveBeenCalled();
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("revalidates the board after commit persistence before entering Memory", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail to permit a guarded handoff when state remains stable.",
          ts: 1,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(questStore.appendQuestCodeCommitEvidenceForOwner).mockImplementationOnce(async () => {
      // The board changes exactly at persistence, independently of preflight read count.
      session.board.get("q-9")!.waitForInput = ["n-7"];
      vi.mocked(questStore.getQuest).mockResolvedValue({ ...claimedQuest, commitShas: ["abc1234"] });
      return { ...claimedQuest, commitShas: ["abc1234"] };
    });

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("User Checkpoint") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("allows a direct optional checkpoint skip into Memory and records the reason", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "user-checkpoint", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
        phaseNotes: { "2": "Optional: skip if Work confirms there is no user-visible tradeoff." },
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence confirms the optional checkpoint skip condition and supports Memory handoff.",
          ts: 3,
        },
      ],
    } as any);

    const res = await postWorkerMemory({
      questId: "q-9",
      noCode: true,
      skipOptionalUserCheckpointReason: "Work confirmed there is no user-visible tradeoff.",
    });

    expect(res.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
    expect(session.board.get("q-9")?.journey).toMatchObject({
      activePhaseIndex: 3,
      currentPhaseId: "memory",
      phaseSkipReasons: { "2": "Work confirmed there is no user-visible tradeoff." },
    });
  });

  it.each([
    [
      "missing optional skip proof",
      { "2": "Optional: skip if Work confirms there is no user-visible tradeoff." },
      {},
      "skip reason",
    ],
    ["attempted required checkpoint skip", undefined, { skipOptionalUserCheckpointReason: "Skip it." }, "required"],
    ["taken required checkpoint without later Work", undefined, {}, "later Work occurrence"],
  ])("rejects %s before appending commit evidence", async (_label, phaseNotes, extra, errorText) => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "user-checkpoint", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
        ...(phaseNotes ? { phaseNotes } : {}),
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence is detailed enough, but checkpoint proof must still be validated first.",
          ts: 3,
        },
      ],
    } as any);

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"], ...extra });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(errorText) });
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
    expect(broadcastGlobal).not.toHaveBeenCalled();
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("rejects an empty optional checkpoint skip reason before quest mutation", async () => {
    const res = await postWorkerMemory({
      questId: "q-9",
      noCode: true,
      skipOptionalUserCheckpointReason: "   ",
    });

    expect(res.status).toBe(400);
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("resumes a taken checkpoint into later Work before the ordinary Memory transition", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "USER_CHECKPOINTING",
      journey: {
        phaseIds: ["alignment", "work", "user-checkpoint", "work", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });

    const resumed = await app.request("/sessions/leader-1/board/q-9/advance", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(resumed.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("WORKING");
    expect(session.board.get("q-9")?.journey?.activePhaseIndex).toBe(3);

    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Post-checkpoint Work evidence records the resolved decision and the final accepted implementation state.",
          ts: 4,
        },
      ],
    } as any);

    const memory = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(memory.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
    expect(session.board.get("q-9")?.journey?.activePhaseIndex).toBe(4);
  });

  it("rejects an explicit active plan with no later Memory before appending commits", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "user-checkpoint", "work"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence is complete, but the explicit Journey still has no later Memory occurrence.",
          ts: 3,
        },
      ],
    } as any);

    const res = await postWorkerMemory({ questId: "q-9", commitShas: ["abc1234"] });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("no Memory phase") });
    expect(questStore.appendQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
    expect(broadcastGlobal).not.toHaveBeenCalled();
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("does not let an early Work occurrence skip checkpoint or repeated Work phases", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "user-checkpoint", "work", "memory"],
        activePhaseIndex: 1,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Current Work evidence with enough detail to test a guarded multi-occurrence Journey handoff.",
          ts: 1,
        },
      ],
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);

    const res = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("planned phase occurrence") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");
    expect(session.board.get("q-9")?.journey?.activePhaseIndex).toBe(1);
  });

  it("targets the next later Memory occurrence from a repeated final Work", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: {
        phaseIds: ["alignment", "work", "memory", "work", "memory"],
        activePhaseIndex: 3,
        currentPhaseId: "work",
      },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [
        {
          author: "agent",
          authorSessionId: "worker-1",
          phaseId: "work",
          text: "Final repeated Work evidence with enough detail to target the next later Memory occurrence.",
          ts: 1,
        },
      ],
    } as any);

    const res = await postWorkerMemory({ questId: "q-9", noCode: true });

    expect(res.status).toBe(200);
    expect(session.board.get("q-9")?.status).toBe("MEMORY");
    expect(session.board.get("q-9")?.journey?.activePhaseIndex).toBe(4);
    expect(session.board.get("q-9")?.journey?.currentPhaseId).toBe("memory");
  });

  it("blocks generic set from jumping an active Planning row directly to Memory", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "PLANNING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 0, currentPhaseId: "alignment" },
      createdAt: 1,
      updatedAt: 2,
    });

    const res = await postBoard({ questId: "q-9", status: "MEMORY", activePhaseIndex: 2 });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("work-to-memory") });
    expect(session.board.get("q-9")?.status).toBe("PLANNING");
  });

  it.each([
    ["with an explicit phase plan", { phases: ["alignment", "work", "memory"], activePhaseIndex: 2 }],
    ["without an explicit phase plan", {}],
  ])("blocks direct creation of an active Memory row %s", async (_label, extra) => {
    const res = await postBoard({ questId: "q-10", status: "MEMORY", ...extra });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("work-to-memory") });
    expect(session.board.has("q-10")).toBe(false);
  });

  it("blocks generic set and advance from bypassing the guarded Work transition", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });

    const set = await postBoard({ questId: "q-9", status: "MEMORY", activePhaseIndex: 2 });
    expect(set.status).toBe(409);
    expect(await set.json()).toMatchObject({ error: expect.stringContaining("work-to-memory") });

    const advance = await app.request("/sessions/leader-1/board/q-9/advance", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(advance.status).toBe(409);
    expect(await advance.json()).toMatchObject({ error: expect.stringContaining("work-to-memory") });
    expect(session.board.get("q-9")?.status).toBe("WORKING");

    const pausedRow = session.board.get("q-9")!;
    pausedRow.status = "USER_CHECKPOINTING";
    pausedRow.journey = {
      phaseIds: ["alignment", "work", "memory"],
      activePhaseIndex: 1,
      currentPhaseId: "work",
    };

    const pausedSet = await postBoard({ questId: "q-9", status: "MEMORY", activePhaseIndex: 2 });
    expect(pausedSet.status).toBe(409);
    expect(await pausedSet.json()).toMatchObject({ error: expect.stringContaining("work-to-memory") });

    const pausedAdvance = await app.request("/sessions/leader-1/board/q-9/advance", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(pausedAdvance.status).toBe(409);
    expect(await pausedAdvance.json()).toMatchObject({ error: expect.stringContaining("phase position") });
    expect(session.board.get("q-9")?.status).toBe("USER_CHECKPOINTING");
    expect(session.board.get("q-9")?.journey?.currentPhaseId).toBe("work");
  });

  it("rejects Work to Memory when checkpoint wait or Work note proof is missing", async () => {
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      waitForInput: ["n-2"],
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 1,
      updatedAt: 2,
    });
    authCallerId = "worker-1";
    authCaller = { sessionId: "worker-1", isOrchestrator: false };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      feedback: [],
    } as any);

    const checkpoint = await postWorkerMemory({ questId: "q-9", noCode: true });
    expect(checkpoint.status).toBe(409);
    expect(await checkpoint.json()).toMatchObject({ error: expect.stringContaining("User Checkpoint") });

    session.board.get("q-9")!.waitForInput = undefined;
    const missingNote = await postWorkerMemory({ questId: "q-9", noCode: true });
    expect(missingNote.status).toBe(409);
    expect(await missingNote.json()).toMatchObject({ error: expect.stringContaining("Work phase note") });
  });

  it("replaces invalid Work evidence only after selected-target reachability verification", async () => {
    const invalidSha = "1bbb8efa151d5600a4e943875a0f436699af24fa";
    const validSha = "1bbb8efa554745fffc900a8cf947e7176d176e05";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isOrchestrator: false,
      isWorktree: true,
      cwd: "/repo/worktrees/worker",
      repoRoot: "/repo",
      branch: "main",
      actualBranch: "main-wt-1",
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Quest",
      description: "Repair invalid structured delivery evidence.",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [invalidSha],
      journeyRuns: [
        {
          runId: "board-leader-1-20",
          source: "board",
          status: "active",
          createdAt: 20,
          updatedAt: 21,
          phaseIds: ["alignment", "work", "memory"],
          phaseOccurrences: [
            {
              occurrenceId: "current-work-occurrence",
              phaseId: "work",
              phaseIndex: 1,
              phasePosition: 2,
              phaseOccurrence: 1,
              status: "active",
            },
          ],
        },
      ],
      createdAt: 1,
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command, cwd) => {
      expect(cwd).toBe("/repo");
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") return validSha;
      if (command === `rev-parse --verify ${validSha.slice(0, 12)}^{commit}`) return validSha.toUpperCase();
      if (command === `merge-base --is-ancestor ${validSha} ${validSha}`) return "";
      throw new Error(`unexpected git command: ${command}`);
    });
    vi.mocked(questStore.replaceQuestCodeCommitEvidenceForOwner).mockResolvedValue({
      ...claimedQuest,
      commitShas: [validSha],
      codeCommitEvidenceReplacementEvents: [
        {
          operation: "replace_code_commit_evidence",
          actorSessionId: "worker-1",
          reason: "Correct mistyped delivery evidence",
          previousCommitShas: [invalidSha],
          replacementCommitShas: [validSha],
          journeyRunId: "board-leader-1-20",
          phaseOccurrenceId: "current-work-occurrence",
          verifiedTargetBranch: "main",
          verifiedTargetHeadSha: validSha,
          ts: 30,
        },
      ],
    });

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [invalidSha],
      commitShas: [validSha.slice(0, 12)],
      reason: "Correct mistyped delivery evidence",
    });

    expect(res.status).toBe(200);
    expect(gitUtils.gitAsync).not.toHaveBeenCalledWith(expect.stringContaining(invalidSha), expect.anything());
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).toHaveBeenCalledWith(
      "q-9",
      { kind: "takode", sessionId: "worker-1" },
      {
        expectedCommitShas: [invalidSha],
        replacementCommitShas: [validSha],
        reason: "Correct mistyped delivery evidence",
        journeyRunId: "board-leader-1-20",
        phaseOccurrenceId: "current-work-occurrence",
        verifiedTargetBranch: "main",
        verifiedTargetHeadSha: validSha,
      },
    );
    expect(await res.json()).toEqual({
      ok: true,
      questId: "q-9",
      previousCommitShas: [invalidSha],
      commitShas: [validSha],
      target: {
        mode: "remote-backed",
        checkoutPath: "/repo",
        branch: "main",
        headSha: validSha,
      },
      correction: {
        journeyRunId: "board-leader-1-20",
        phaseOccurrenceId: "current-work-occurrence",
        ts: 30,
      },
    });
    expect(broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
    expect(session.board.get("q-9")?.status).toBe("WORKING");
  });

  it("uses the exact configured target worktree rather than the worker or base checkout", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      cwd: "/repo/worktrees/worker",
      branch: "main",
      actualBranch: "main-wt-1",
      worktreePortTarget: { repoRoot: "/repo", branch: "leader-wt-2", worktreePath: "/repo/worktrees/leader" },
    };
    const quest = {
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Quest",
      description: "Repair evidence.",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
      createdAt: 1,
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(quest);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "leader-wt-2",
      defaultBranch: "main",
      isWorktree: true,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command, cwd) => {
      expect(cwd).toBe("/repo/worktrees/leader");
      if (command === "rev-parse --verify 'refs/heads/leader-wt-2^{commit}'") return newSha;
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command === `merge-base --is-ancestor ${newSha} ${newSha}`) return "";
      throw new Error(`unexpected git command: ${command}`);
    });
    vi.mocked(questStore.replaceQuestCodeCommitEvidenceForOwner).mockResolvedValue({ ...quest, commitShas: [newSha] });

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfoAsync).toHaveBeenCalledWith("/repo/worktrees/leader");
    expect(await res.json()).toMatchObject({
      target: { mode: "worktree", checkoutPath: "/repo/worktrees/leader", branch: "leader-wt-2" },
    });
  });

  it("rejects a replacement commit that is not reachable from the selected target HEAD", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
    } as any);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command) => {
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") return headSha;
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command.startsWith("merge-base --is-ancestor")) {
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      throw new Error(`unexpected git command: ${command}`);
    });

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not reachable") });
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
    expect(broadcastGlobal).not.toHaveBeenCalled();
  });

  it("leaves evidence unchanged when the atomic expected-list comparison fails", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["alignment", "work", "memory"], activePhaseIndex: 1, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
    } as any);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command) => {
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") return newSha;
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command.startsWith("merge-base --is-ancestor")) return "";
      throw new Error(`unexpected git command: ${command}`);
    });
    vi.mocked(questStore.replaceQuestCodeCommitEvidenceForOwner).mockRejectedValue(
      new Error("Stored code commit evidence does not exactly match the expected ordered commits"),
    );

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("does not exactly match") });
    expect(broadcastGlobal).not.toHaveBeenCalled();
  });

  it("rejects evidence shrinkage before target or store access", async () => {
    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: ["1111111", "2222222"],
      commitShas: ["aaaaaaa"],
      reason: "Remove invalid evidence",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("cannot contain fewer commits") });
    expect(questStore.getQuest).not.toHaveBeenCalled();
    expect(gitUtils.getRepoInfoAsync).not.toHaveBeenCalled();
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("rejects unbounded replacement reasons before target or store access", async () => {
    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: ["1111111"],
      commitShas: ["aaaaaaa"],
      reason: "x".repeat(1_001),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("at most 1000 characters") });
    expect(questStore.getQuest).not.toHaveBeenCalled();
    expect(gitUtils.getRepoInfoAsync).not.toHaveBeenCalled();
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("rejects oversized evidence lists before target or store access", async () => {
    const commitShas = Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(7, "0"));
    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: commitShas,
      commitShas,
      reason: "Repair evidence",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("at most 50 commits") });
    expect(questStore.getQuest).not.toHaveBeenCalled();
    expect(gitUtils.getRepoInfoAsync).not.toHaveBeenCalled();
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it.each([
    { callerId: "other-worker", boardStatus: "WORKING", expectedStatus: 403, expectedError: "assigned worker" },
    { callerId: "worker-1", boardStatus: "MEMORY", expectedStatus: 409, expectedError: "board state WORKING" },
  ])("rejects unauthorized or non-Work correction attempts before Git: $expectedError", async (testCase) => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: testCase.boardStatus,
      journey: { phaseIds: ["work", "memory"], activePhaseIndex: 0, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = testCase.callerId;
    authCaller = {
      sessionId: testCase.callerId,
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
    } as any);

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(testCase.expectedStatus);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(testCase.expectedError) });
    expect(gitUtils.getRepoInfoAsync).not.toHaveBeenCalled();
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("fails closed when the configured selected-target branch is not checked out", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["work", "memory"], activePhaseIndex: 0, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
    } as any);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "other",
      defaultBranch: "main",
      isWorktree: false,
    });

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("must have branch main checked out") });
    expect(gitUtils.gitAsync).not.toHaveBeenCalled();
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("fails closed when the selected-target branch head changes during verification", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const firstHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const secondHead = "cccccccccccccccccccccccccccccccccccccccc";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["work", "memory"], activePhaseIndex: 0, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    vi.mocked(questStore.getQuest).mockResolvedValue({
      id: "q-9",
      questId: "q-9",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
    } as any);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    let branchReadCount = 0;
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command) => {
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") {
        branchReadCount += 1;
        return branchReadCount === 1 ? firstHead : secondHead;
      }
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command === `merge-base --is-ancestor ${newSha} ${firstHead}`) return "";
      throw new Error(`unexpected git command: ${command}`);
    });

    const res = await postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("branch changed during verification") });
    expect(questStore.replaceQuestCodeCommitEvidenceForOwner).not.toHaveBeenCalled();
  });

  it("holds the Work board occurrence stable while the atomic store replacement is pending", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["work", "memory"], activePhaseIndex: 0, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Quest",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
      createdAt: 1,
    } as any;
    vi.mocked(questStore.getQuest).mockResolvedValue(claimedQuest);
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command) => {
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") return newSha;
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command === `merge-base --is-ancestor ${newSha} ${newSha}`) return "";
      throw new Error(`unexpected git command: ${command}`);
    });
    const pendingReplacement = deferred<any>();
    vi.mocked(questStore.replaceQuestCodeCommitEvidenceForOwner).mockReturnValue(pendingReplacement.promise);

    const correction = postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });
    await vi.waitFor(() => expect(questStore.replaceQuestCodeCommitEvidenceForOwner).toHaveBeenCalled());

    authCallerId = "leader-1";
    authCaller = { sessionId: "leader-1", isOrchestrator: true };
    const blockedRemoval = await app.request("/sessions/leader-1/board/q-9", { method: "DELETE" });
    expect(blockedRemoval.status).toBe(409);
    expect(session.board.has("q-9")).toBe(true);

    pendingReplacement.resolve({
      ...claimedQuest,
      commitShas: [newSha],
      codeCommitEvidenceReplacementEvents: [{ ts: 30 }],
    });
    expect((await correction).status).toBe(200);

    const removal = await app.request("/sessions/leader-1/board/q-9", { method: "DELETE" });
    expect(removal.status).toBe(200);
    expect(session.board.has("q-9")).toBe(false);
  });

  it("rechecks the lock when an earlier board mutation resumes during evidence replacement", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    session.board.set("q-9", {
      questId: "q-9",
      worker: "worker-1",
      status: "WORKING",
      journey: { phaseIds: ["work", "memory"], activePhaseIndex: 0, currentPhaseId: "work" },
      createdAt: 20,
      updatedAt: 21,
    });
    const claimedQuest = {
      id: "q-9",
      questId: "q-9",
      version: 1,
      title: "Quest",
      status: "in_progress",
      sessionId: "worker-1",
      commitShas: [oldSha],
      createdAt: 1,
    } as any;
    const pendingBoardQuestRead = deferred<any>();
    let questReadCount = 0;
    vi.mocked(questStore.getQuest).mockImplementation(() => {
      questReadCount += 1;
      return questReadCount === 1 ? pendingBoardQuestRead.promise : Promise.resolve(claimedQuest);
    });
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue({
      repoRoot: "/repo",
      repoName: "repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitAsync).mockImplementation(async (command) => {
      if (command === "rev-parse --verify 'refs/heads/main^{commit}'") return newSha;
      if (command === `rev-parse --verify ${newSha}^{commit}`) return newSha;
      if (command === `merge-base --is-ancestor ${newSha} ${newSha}`) return "";
      throw new Error(`unexpected git command: ${command}`);
    });
    const pendingReplacement = deferred<any>();
    vi.mocked(questStore.replaceQuestCodeCommitEvidenceForOwner).mockReturnValue(pendingReplacement.promise);

    authCallerId = "leader-1";
    authCaller = { sessionId: "leader-1", isOrchestrator: true };
    const earlierBoardMutation = postBoard({ questId: "q-9", status: "WORKING" });
    await vi.waitFor(() => expect(questStore.getQuest).toHaveBeenCalledTimes(1));

    authCallerId = "worker-1";
    authCaller = {
      sessionId: "worker-1",
      isWorktree: true,
      worktreePortTarget: { repoRoot: "/repo", branch: "main" },
    };
    const correction = postReplaceWorkEvidence({
      questId: "q-9",
      expectedCommitShas: [oldSha],
      commitShas: [newSha],
      reason: "Correct evidence",
    });
    await vi.waitFor(() => expect(questStore.replaceQuestCodeCommitEvidenceForOwner).toHaveBeenCalled());

    pendingBoardQuestRead.resolve(claimedQuest);
    const blockedBoardMutation = await earlierBoardMutation;
    expect(blockedBoardMutation.status).toBe(409);
    expect(await blockedBoardMutation.json()).toMatchObject({
      error: expect.stringContaining("Work evidence mutation is in progress"),
    });
    expect(session.board.get("q-9")?.status).toBe("WORKING");

    pendingReplacement.resolve({
      ...claimedQuest,
      commitShas: [newSha],
      codeCommitEvidenceReplacementEvents: [{ ts: 30 }],
    });
    expect((await correction).status).toBe(200);
  });
});
