import { describe, expect, it } from "vitest";
import { buildSidebarVisibleSessions } from "./sidebar-visible-sessions.js";
import type { SdkSessionInfo, TreeGroup } from "../types.js";

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: `/repo/${id}`,
    createdAt: 1,
    archived: false,
    treeGroupId: "default",
    ...overrides,
  };
}

describe("buildSidebarVisibleSessions", () => {
  it("derives ordered visible rows without reviewer sessions", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", { createdAt: 3, sessionNum: 10, isOrchestrator: true }),
      makeSdkSession("worker", { createdAt: 2, herdedBy: "leader", sessionNum: 11 }),
      makeSdkSession("reviewer", { createdAt: 1, reviewerOf: 11, sessionNum: 12 }),
    ];
    const treeGroups: TreeGroup[] = [{ id: "default", name: "Default" }];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups,
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(["leader"]),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.orderedVisibleSessionIds).toEqual(["leader", "worker"]);
  });

  it("uses projected leader review attention for the session blue dot", () => {
    const sdkSessions: SdkSessionInfo[] = [makeSdkSession("leader", { isOrchestrator: true, cliConnected: true })];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map([["leader", "review"]]),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("leader")).toBe("review");
    expect(result.treeViewGroups[0]?.unreadCount).toBe(1);
  });

  it("fails closed before projected attention arrives even when a summary is active", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", {
        isOrchestrator: true,
        cliConnected: true,
        notificationUrgency: "review",
        activeNotificationCount: 3,
        activeReviewNotificationCount: 3,
        notificationStatusVersion: 12,
        notificationStatusUpdatedAt: 12_000,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("leader")).toBeUndefined();
    expect(result.treeViewGroups[0]?.unreadCount).toBe(0);
  });

  it("uses the projected cleared attention after a leader thread tab is closed", () => {
    const sdkSessions: SdkSessionInfo[] = [makeSdkSession("leader", { isOrchestrator: true })];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map([["leader", null]]),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("leader")).toBeNull();
    expect(result.treeViewGroups[0]?.unreadCount).toBe(0);
  });

  it("does not let notification summaries arbitrate the projection-owned reason index", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", {
        cliConnected: true,
        notificationUrgency: null,
        activeNotificationCount: 0,
        mutedNeedsInputNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map([["leader", "review"]]),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("leader")).toBe("review");
    expect(result.treeViewGroups[0]?.unreadCount).toBe(1);
  });

  it("preserves active needs-input and muted-only attention semantics", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("needs-input", {
        cliConnected: true,
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        activeNeedsInputNotificationCount: 1,
        notificationStatusVersion: 2,
      }),
      makeSdkSession("muted", {
        cliConnected: true,
        notificationUrgency: null,
        activeNotificationCount: 0,
        mutedNeedsInputNotificationCount: 1,
        notificationStatusVersion: 3,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map([
        ["needs-input", "action"],
        ["muted", null],
      ]),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("needs-input")).toBe("action");
    expect(result.sessionSetAttention.get("muted")).toBeNull();
    // Neither an unresolved prompt nor a muted prompt is an unread result.
    expect(result.treeViewGroups[0]?.unreadCount).toBe(0);
  });

  it("uses attention projection authority before selection while preserving navigation timer data", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", {
        isOrchestrator: true,
        cliConnected: true,
        pendingTimerCount: 1,
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 8,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map([["leader", "review"]]),
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention.get("leader")).toBe("review");
    expect(result.treeViewGroups[0]?.unreadCount).toBe(1);
    expect(result.allSessionList[0]?.pendingTimerCount).toBe(1);
  });

  it("passes the projection-owned attention map through without local derivation", () => {
    const sdkSessions = [
      makeSdkSession("needs-input", {
        notificationUrgency: "review",
        activeNotificationCount: 4,
        notificationStatusVersion: 4,
      }),
      makeSdkSession("muted", {
        notificationUrgency: "review",
        activeNotificationCount: 2,
        notificationStatusVersion: 2,
      }),
      makeSdkSession("clear", {
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 1,
      }),
    ];

    const sessionAttention = new Map<"needs-input" | "muted" | "clear", "action" | null>([
      ["needs-input", "action"],
      ["muted", null],
      ["clear", null],
    ]);
    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention,
      sessionSortMode: "created",
    });

    expect(result.sessionSetAttention).toBe(sessionAttention);
    expect(result.sessionSetAttention).toEqual(
      new Map<string, "action" | null>([
        ["needs-input", "action"],
        ["muted", null],
        ["clear", null],
      ]),
    );
  });

  it("filters hidden Side Chat child sessions from the compatible-build snapshot", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("root", { createdAt: 2, sessionNum: 10 }),
      makeSdkSession("hidden-child", { createdAt: 1, sessionNum: 11, hidden: true }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.allSessionList.map((session) => session.id)).toEqual(["root"]);
    expect(result.orderedVisibleSessionIds).toEqual(["root"]);
  });

  it("does not invent Side Chat child rows omitted from the compatible-build snapshot", () => {
    const result = buildSidebarVisibleSessions({
      sdkSessions: [makeSdkSession("root", { createdAt: 2, sessionNum: 10 })],
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.allSessionList.map((session) => session.id)).toEqual(["root"]);
    expect(result.treeViewGroups.flatMap((group) => group.nodes.map((node) => node.leader.id))).toEqual(["root"]);
  });

  it("keeps archived reviewers attached to active parents without adding standalone archived rows", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("parent", { createdAt: 3, sessionNum: 11, archived: false }),
      makeSdkSession("reviewer", { createdAt: 2, reviewerOf: 11, sessionNum: 12, archived: true, archivedAt: 2500 }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    // Archived reviewer sessions should remain reachable from their parent
    // record, but should not become separate rows in the Archived section.
    expect(result.archivedSessions.map((s) => s.id)).toEqual([]);
    expect(result.activeReviewers).toEqual([]);
    expect(result.treeViewGroups[0].nodes[0].reviewers.map((s) => s.id)).toEqual(["reviewer"]);
  });

  it("carries archived worktree cleanup status into sidebar rows", () => {
    const result = buildSidebarVisibleSessions({
      sdkSessions: [
        makeSdkSession("archived-worktree", {
          archived: true,
          isWorktree: true,
          worktreeExists: true,
          worktreeCleanupStatus: "failed",
          worktreeCleanupError: "cleanup failed",
        }),
      ],
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.archivedSessions[0]).toMatchObject({
      id: "archived-worktree",
      isWorktree: true,
      worktreeExists: true,
      worktreeCleanupStatus: "failed",
      worktreeCleanupError: "cleanup failed",
    });
  });

  it("hides workers from ordered visible rows when their herd is collapsed", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", { createdAt: 3, sessionNum: 10, isOrchestrator: true }),
      makeSdkSession("worker", { createdAt: 2, herdedBy: "leader", sessionNum: 11 }),
      makeSdkSession("standalone", { createdAt: 1, sessionNum: 12 }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map([["default", ["leader", "standalone"]]]),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.orderedVisibleSessionIds).toEqual(["leader", "standalone"]);
  });

  it("hides an entire collapsed tree group from ordered visible rows", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("default-session", { createdAt: 2, sessionNum: 10 }),
      makeSdkSession("quest-session", { createdAt: 1, sessionNum: 11 }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [
        { id: "default", name: "Default" },
        { id: "quest", name: "Quest" },
      ],
      treeAssignments: new Map([["quest-session", "quest"]]),
      treeNodeOrder: new Map([
        ["default", ["default-session"]],
        ["quest", ["quest-session"]],
      ]),
      collapsedTreeGroups: new Set(["quest"]),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.orderedVisibleSessionIds).toEqual(["default-session"]);
  });

  it("uses snapshot treeGroupId while tree assignments are still hydrating", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("oai-leader", {
        createdAt: 1,
        sessionNum: 710,
        isOrchestrator: true,
        treeGroupId: "oai",
        memorySessionSpaceSlug: "OAI",
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [
        { id: "default", name: "Default" },
        { id: "oai", name: "OAI" },
      ],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.treeViewGroups.find((group) => group.id === "default")?.nodes).toHaveLength(0);
    expect(result.treeViewGroups.find((group) => group.id === "oai")?.nodes.map((node) => node.leader.id)).toEqual([
      "oai-leader",
    ]);
  });

  it("preserves completed quest review metadata from idle session snapshots", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("worker", {
        claimedQuestStatus: "done",
        claimedQuestVerificationInboxUnread: true,
        createdAt: 1,
        sessionNum: 12,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.allSessionList[0]).toMatchObject({
      id: "worker",
      claimedQuestStatus: "done",
      claimedQuestVerificationInboxUnread: true,
    });
  });

  it("uses quest status from the current compatible-build snapshot", () => {
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("worker", {
        claimedQuestStatus: "in_progress",
        claimedQuestVerificationInboxUnread: undefined,
        createdAt: 1,
        sessionNum: 12,
      }),
    ];

    const result = buildSidebarVisibleSessions({
      sdkSessions,
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
    });

    expect(result.allSessionList[0]).toMatchObject({
      id: "worker",
      claimedQuestStatus: "in_progress",
      claimedQuestVerificationInboxUnread: undefined,
    });
  });
});
