import { useEffect } from "react";
import { useStore } from "../../store.js";
import type { SessionState } from "../../types.js";
import type { LeaderThreadStatus } from "../../../shared/thread-status-marker.js";
import {
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../../shared/thread-routing-reminder.js";
import {
  MOCK_SESSION_ID,
  PLAYGROUND_BROKEN_SESSION_ID,
  PLAYGROUND_CODEX_PENDING_SESSION_ID,
  PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
  PLAYGROUND_DISCONNECTED_SESSION_ID,
  PLAYGROUND_LOADING_SESSION_ID,
  PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID,
  PLAYGROUND_LEADER_RETURN_SESSION_ID,
  PLAYGROUND_RECOVERING_SESSION_ID,
  PLAYGROUND_REPEATED_ERROR_SESSION_ID,
  PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID,
  PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID,
  PLAYGROUND_RESUMING_SESSION_ID,
  PLAYGROUND_SECTIONED_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID,
  PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID,
  PLAYGROUND_STARTING_SESSION_ID,
  PLAYGROUND_STREAM_RETRY_SESSION_ID,
  PLAYGROUND_THREAD_PANEL_SESSION_ID,
  MSG_ASSISTANT,
  MSG_ASSISTANT_TOOLS,
  MSG_STARRED_ASSISTANT,
  MSG_STARRED_USER,
  MSG_TOOL_ERROR,
  MSG_USER,
  PERM_BASH,
  PERM_DYNAMIC,
  makePlaygroundMessage,
  makeResolvedNeedsInputMainProjectionFixture,
  makePlaygroundSectionedMessages,
} from "./fixtures.js";
import { buildPlaygroundAutoPauseRecoveryMessage } from "./AutoPausePlaygroundStates.js";
import { createSyntheticLargeLeaderFeedFixture } from "../../test-fixtures/large-leader-feed-fixture.js";
import { buildLeaderActivePhaseSummary } from "../../../shared/leader-active-phase-summary.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../../shared/leader-thread-tabs-projection.js";
import { seedCodexTurnRecoveryPlaygroundStates } from "./CodexTurnRecoveryPlaygroundSeed.js";
import { buildPlaygroundProjectedJourney } from "./leader-thread-tabs-projection-fixtures.js";

const EMPTY_PROJECTED_ATTENTION = { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 };

function projectedAttention(overrides: Partial<typeof EMPTY_PROJECTED_ATTENTION> = {}) {
  return { ...EMPTY_PROJECTED_ATTENTION, ...overrides };
}

export function usePlaygroundSeed() {
  useEffect(() => {
    const store = useStore.getState();
    const snapshot = useStore.getState();
    const sessionId = MOCK_SESSION_ID;
    const questInProgressId = "quest-in-progress";
    const questVerificationId = "quest-needs-verification";
    const demoSessionIds = [
      sessionId,
      PLAYGROUND_SECTIONED_SESSION_ID,
      PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID,
      PLAYGROUND_LOADING_SESSION_ID,
      PLAYGROUND_LEADER_RETURN_SESSION_ID,
      PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID,
      PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      PLAYGROUND_CODEX_PENDING_SESSION_ID,
      PLAYGROUND_REPEATED_ERROR_SESSION_ID,
      PLAYGROUND_STARTING_SESSION_ID,
      PLAYGROUND_STREAM_RETRY_SESSION_ID,
      PLAYGROUND_RESUMING_SESSION_ID,
      PLAYGROUND_DISCONNECTED_SESSION_ID,
      PLAYGROUND_BROKEN_SESSION_ID,
      PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID,
      PLAYGROUND_TURN_RECOVERY_RECOVERING_SESSION_ID,
      PLAYGROUND_TURN_RECOVERY_REPLAY_SESSION_ID,
      PLAYGROUND_TURN_RECOVERY_PENDING_SESSION_ID,
      PLAYGROUND_TURN_RECOVERY_ACTIVE_SESSION_ID,
      PLAYGROUND_TURN_RECOVERY_ACTION_SESSION_ID,
      PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
      PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID,
      PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID,
      PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID,
      PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID,
      PLAYGROUND_THREAD_PANEL_SESSION_ID,
      "leader-alpha",
      questInProgressId,
      questVerificationId,
    ];
    const prevSessions = new Map(demoSessionIds.map((id) => [id, snapshot.sessions.get(id)]));
    const prevMessages = new Map(demoSessionIds.map((id) => [id, snapshot.messages.get(id)]));
    const prevHistoryWindows = new Map(demoSessionIds.map((id) => [id, snapshot.historyWindows.get(id)]));
    const prevThreadWindows = new Map(demoSessionIds.map((id) => [id, snapshot.threadWindows.get(id)]));
    const prevThreadWindowMessages = new Map(demoSessionIds.map((id) => [id, snapshot.threadWindowMessages.get(id)]));
    const prevPerms = new Map(demoSessionIds.map((id) => [id, snapshot.pendingPermissions.get(id)]));
    const prevConn = new Map(demoSessionIds.map((id) => [id, snapshot.connectionStatus.get(id)]));
    const prevCli = new Map(demoSessionIds.map((id) => [id, snapshot.cliConnected.get(id)]));
    const prevCliEver = new Map(demoSessionIds.map((id) => [id, snapshot.cliEverConnected.get(id)]));
    const prevCliDisconnectReason = new Map(demoSessionIds.map((id) => [id, snapshot.cliDisconnectReason.get(id)]));
    const prevStatus = new Map(demoSessionIds.map((id) => [id, snapshot.sessionStatus.get(id)]));
    const prevActiveTurnRoutes = new Map(demoSessionIds.map((id) => [id, snapshot.activeTurnRoutes.get(id)]));
    const prevStreaming = new Map(demoSessionIds.map((id) => [id, snapshot.streaming.get(id)]));
    const prevStreamingStartedAt = new Map(demoSessionIds.map((id) => [id, snapshot.streamingStartedAt.get(id)]));
    const prevStreamingOutputTokens = new Map(demoSessionIds.map((id) => [id, snapshot.streamingOutputTokens.get(id)]));
    const prevFeedScrollPositions = new Map(demoSessionIds.map((id) => [id, snapshot.feedScrollPosition.get(id)]));
    const prevHistoryLoading = new Map(demoSessionIds.map((id) => [id, snapshot.historyLoading.get(id)]));
    const prevSessionBoards = new Map(demoSessionIds.map((id) => [id, snapshot.sessionBoards.get(id)]));
    const prevSessionBoardRowStatuses = new Map(
      demoSessionIds.map((id) => [id, snapshot.sessionBoardRowStatuses.get(id)]),
    );
    const prevSessionCompletedBoards = new Map(
      demoSessionIds.map((id) => [id, snapshot.sessionCompletedBoards.get(id)]),
    );
    const prevSessionNotifications = new Map(demoSessionIds.map((id) => [id, snapshot.sessionNotifications.get(id)]));
    const prevSessionAttentionRecords = new Map(
      demoSessionIds.map((id) => [id, snapshot.sessionAttentionRecords.get(id)]),
    );
    const prevPendingCodexInputs = new Map(demoSessionIds.map((id) => [id, snapshot.pendingCodexInputs.get(id)]));
    const prevPendingUserUploads = new Map(demoSessionIds.map((id) => [id, snapshot.pendingUserUploads.get(id)]));
    const prevPendingUserUploadRestorations = new Map(
      demoSessionIds.map((id) => [id, snapshot.pendingUserUploadRestorations.get(id)]),
    );
    const prevToolProgress = new Map(demoSessionIds.map((id) => [id, snapshot.toolProgress.get(id)]));
    const prevToolResults = new Map(demoSessionIds.map((id) => [id, snapshot.toolResults.get(id)]));
    const prevToolStartTimestamps = new Map(demoSessionIds.map((id) => [id, snapshot.toolStartTimestamps.get(id)]));
    const sidebarTimerDemoIds = ["leader-alpha", "playground-worker-banner"];
    const prevSessionTimers = new Map(sidebarTimerDemoIds.map((id) => [id, snapshot.sessionTimers.get(id)]));

    const session: SessionState = {
      session_id: sessionId,
      backend_type: "claude",
      model: "claude-sonnet-4-5",
      cwd: "/Users/stan/Dev/project",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebSearch"],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: ["explain", "review", "fix"],
      skills: ["doc-coauthoring", "frontend-design"],
      total_cost_usd: 0.1847,
      num_turns: 14,
      context_used_percent: 62,
      is_compacting: false,
      git_branch: "feat/jwt-auth",
      is_worktree: false,
      is_containerized: true,
      repo_root: "/Users/stan/Dev/project",
      git_ahead: 3,
      git_behind: 0,
      total_lines_added: 142,
      total_lines_removed: 38,
      starredMessages: {
        [MSG_STARRED_USER.id]: {
          messageId: MSG_STARRED_USER.id,
          role: "user",
          historyIndex: MSG_STARRED_USER.historyIndex ?? 90,
          sourceThreadKey: "main",
          routeThreadKey: "main",
          timestamp: MSG_STARRED_USER.timestamp,
          starredAt: Date.now() - 12_000,
        },
        [MSG_STARRED_ASSISTANT.id]: {
          messageId: MSG_STARRED_ASSISTANT.id,
          role: "assistant",
          historyIndex: MSG_STARRED_ASSISTANT.historyIndex ?? 91,
          sourceThreadKey: "main",
          routeThreadKey: "main",
          timestamp: MSG_STARRED_ASSISTANT.timestamp,
          starredAt: Date.now() - 10_000,
        },
      },
      slackThreads: {
        "st-playground": {
          id: "st-playground",
          rootSessionId: sessionId,
          childSessionId: PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
          anchorMessageId: MSG_ASSISTANT.id,
          anchorHistoryIndex: 2,
          anchorPreview: "We can stage the migration instead of replacing auth in one pass.",
          createdAt: Date.now() - 30_000,
          updatedAt: Date.now() - 8_000,
          messageCount: 2,
          lastMessagePreview: "Use a feature flag and keep session cookie validation until parity tests pass.",
          seeded: true,
          contextStrategy: "native-fork",
        },
        "st-playground-disconnected": {
          id: "st-playground-disconnected",
          rootSessionId: sessionId,
          childSessionId: PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID,
          anchorMessageId: MSG_ASSISTANT.id,
          anchorHistoryIndex: 2,
          anchorPreview: "Disconnected hidden child while the root session stays readable.",
          createdAt: Date.now() - 24_000,
          updatedAt: Date.now() - 18_000,
          messageCount: 1,
          lastMessagePreview: "Queued follow-up will run after reconnect.",
          seeded: true,
          contextStrategy: "native-fork",
        },
        "st-playground-generating": {
          id: "st-playground-generating",
          rootSessionId: sessionId,
          childSessionId: PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID,
          anchorMessageId: MSG_ASSISTANT.id,
          anchorHistoryIndex: 2,
          anchorPreview: "Generating Side Chat child with active output tokens.",
          createdAt: Date.now() - 22_000,
          updatedAt: Date.now() - 4_000,
          messageCount: 1,
          lastMessagePreview: "Drafting a rollout comparison...",
          seeded: true,
          contextStrategy: "native-fork",
        },
        "st-playground-permission": {
          id: "st-playground-permission",
          rootSessionId: sessionId,
          childSessionId: PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID,
          anchorMessageId: MSG_ASSISTANT.id,
          anchorHistoryIndex: 2,
          anchorPreview: "Read-only child denied a repository mutation.",
          createdAt: Date.now() - 21_000,
          updatedAt: Date.now() - 6_000,
          messageCount: 1,
          lastMessagePreview: "Thread turns are read-only.",
          seeded: true,
          contextStrategy: "native-fork",
        },
        "st-playground-error": {
          id: "st-playground-error",
          rootSessionId: sessionId,
          childSessionId: PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID,
          anchorMessageId: MSG_ASSISTANT.id,
          anchorHistoryIndex: 2,
          anchorPreview: "Backend error state in the hidden child.",
          createdAt: Date.now() - 19_000,
          updatedAt: Date.now() - 5_000,
          messageCount: 1,
          lastMessagePreview: "Backend stream disconnected before completion.",
          seeded: true,
          contextStrategy: "bounded-replay",
          contextFallbackReason:
            "Codex native fork skipped: anchor is not the final assistant message in its Codex turn",
        },
      },
    };

    store.addSession(session);
    store.setConnectionStatus(sessionId, "connected");
    store.setCliConnected(sessionId, true);
    store.setSessionStatus(sessionId, "running");
    store.setMessages(sessionId, [
      makePlaygroundMessage({
        id: "playground-older-timestamp-fixture",
        role: "assistant",
        content: "Older transcript checkpoint with a date-aware timestamp.",
        timestamp: Date.now() - 3 * 86_400_000,
        turnDurationMs: 32_000,
      }),
      MSG_USER,
      makePlaygroundMessage({
        id: "playground-thread-routing-reminder",
        role: "user",
        content: [
          "[Thread routing reminder]",
          "Missing thread marker. Your previous leader response was not assigned to a thread.",
          "Resend user-visible leader text with `[thread:main]` or `[thread:q-N]` as the first line.",
          "For leader shell commands, put `# thread:main` or `# thread:q-N` as the first non-empty command line.",
        ].join("\n"),
        timestamp: Date.now() - 55_000,
        agentSource: {
          sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
          sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
        },
      }),
      MSG_ASSISTANT,
      MSG_ASSISTANT_TOOLS,
      MSG_TOOL_ERROR,
      buildPlaygroundAutoPauseRecoveryMessage(),
    ]);
    store.setHistoryWindow(sessionId, {
      from_turn: 6,
      turn_count: 6,
      total_turns: 12,
      has_older_items: true,
      has_newer_items: false,
      start_index: 12,
      section_turn_count: 10,
      visible_section_count: 3,
    });
    store.setStreaming(sessionId, "I'm updating tests and then I'll run the full suite.");
    store.setStreamingStats(sessionId, { startedAt: Date.now() - 12000, outputTokens: 1200 });
    store.addPermission(sessionId, PERM_BASH);
    store.addPermission(sessionId, PERM_DYNAMIC);

    const sideChatChildSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
      hidden: true,
      slackThreadChild: {
        rootSessionId: sessionId,
        threadId: "st-playground",
        anchorMessageId: MSG_ASSISTANT.id,
        anchorHistoryIndex: 2,
        readOnly: true,
        contextStrategy: "native-fork",
      },
      num_turns: 1,
    };
    store.addSession(sideChatChildSession);
    store.setConnectionStatus(PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-thread-user",
        role: "user",
        content: "What is the lowest-risk migration order?",
        timestamp: Date.now() - 12_000,
        metadata: { slackThreadId: "st-playground" },
      }),
      makePlaygroundMessage({
        id: "playground-thread-assistant",
        role: "assistant",
        content: "Use a feature flag and keep session cookie validation until parity tests pass.",
        timestamp: Date.now() - 8_000,
        metadata: { slackThreadId: "st-playground" },
      }),
    ]);

    const sideChatDisconnectedSession: SessionState = {
      ...sideChatChildSession,
      session_id: PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID,
      backend_state: "disconnected",
      backend_error: null,
      slackThreadChild: {
        ...sideChatChildSession.slackThreadChild!,
        threadId: "st-playground-disconnected",
      },
    };
    store.addSession(sideChatDisconnectedSession);
    store.setConnectionStatus(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID, "idle");
    store.setPendingCodexInputs(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID, [
      {
        id: "playground-side-chat-pending",
        content: "Can you queue this while reconnecting?",
        timestamp: Date.now() - 2_500,
        cancelable: true,
        clientMsgId: "playground-side-chat-pending-client",
      },
    ]);
    store.setMessages(PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-side-chat-disconnected-user",
        role: "user",
        content: "Can you queue this while reconnecting?",
        timestamp: Date.now() - 2_500,
        metadata: { slackThreadId: "st-playground-disconnected" },
      }),
    ]);

    const sideChatGeneratingSession: SessionState = {
      ...sideChatChildSession,
      session_id: PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID,
      backend_state: "connected",
      backend_error: null,
      slackThreadChild: {
        ...sideChatChildSession.slackThreadChild!,
        threadId: "st-playground-generating",
      },
    };
    store.addSession(sideChatGeneratingSession);
    store.setConnectionStatus(PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID, "running");
    store.setStreamingStats(PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID, {
      startedAt: Date.now() - 9_000,
      outputTokens: 318,
    });
    store.setMessages(PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-side-chat-generating-user",
        role: "user",
        content: "Compare the rollout risks.",
        timestamp: Date.now() - 10_000,
        metadata: { slackThreadId: "st-playground-generating" },
      }),
    ]);

    const sideChatPermissionSession: SessionState = {
      ...sideChatChildSession,
      session_id: PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID,
      backend_state: "connected",
      backend_error: null,
      slackThreadChild: {
        ...sideChatChildSession.slackThreadChild!,
        threadId: "st-playground-permission",
      },
    };
    store.addSession(sideChatPermissionSession);
    store.setConnectionStatus(PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-side-chat-denied",
        role: "system",
        content:
          "Thread turns are read-only. Continue in the root conversation or a normal quest workflow to edit files.",
        timestamp: Date.now() - 6_000,
        variant: "denied",
        metadata: { slackThreadId: "st-playground-permission" },
      }),
    ]);

    const sideChatErrorSession: SessionState = {
      ...sideChatChildSession,
      session_id: PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID,
      backend_state: "connected",
      backend_error: "stream disconnected before completion",
      slackThreadChild: {
        ...sideChatChildSession.slackThreadChild!,
        threadId: "st-playground-error",
      },
    };
    store.addSession(sideChatErrorSession);
    store.setConnectionStatus(PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-side-chat-error-user",
        role: "user",
        content: "Why did the backend stop?",
        timestamp: Date.now() - 7_000,
        metadata: { slackThreadId: "st-playground-error" },
      }),
    ]);

    const sectionedSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_SECTIONED_SESSION_ID,
      cwd: "/Users/stan/Dev/project/long-session",
      num_turns: 200,
      is_containerized: false,
    };
    store.addSession(sectionedSession);
    store.setConnectionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SECTIONED_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SECTIONED_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_SECTIONED_SESSION_ID, makePlaygroundSectionedMessages(4));
    store.setFeedScrollPosition(PLAYGROUND_SECTIONED_SESSION_ID, {
      scrollTop: 240,
      scrollHeight: 1600,
      isAtBottom: false,
      anchorTurnId: "playground-section-u1",
      anchorOffsetTop: 0,
    });

    const sparseThreadWindowSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.5",
      cwd: "/Users/stan/Dev/takode/sparse-thread-window",
      num_turns: 80,
      is_containerized: false,
      isOrchestrator: true,
    };
    store.addSession(sparseThreadWindowSession);
    store.setConnectionStatus(PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID, "idle");
    const sparseNeedsInputFixture = makeResolvedNeedsInputMainProjectionFixture(Date.now() - 86_400_000);
    store.setThreadWindow(
      PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID,
      "main",
      {
        thread_key: "main",
        from_item: 12,
        item_count: 30,
        total_items: 84,
        has_older_items: true,
        has_newer_items: false,
        source_history_length: 240,
        section_item_count: 10,
        visible_item_count: 3,
      },
      [sparseNeedsInputFixture.reminder],
    );
    store.setSessionNotifications(PLAYGROUND_SPARSE_THREAD_WINDOW_SESSION_ID, [sparseNeedsInputFixture.notification]);

    const loadingSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_LOADING_SESSION_ID,
      cwd: "/Users/stan/Dev/project/cold-session",
      num_turns: 86,
      is_containerized: false,
    };
    store.addSession(loadingSession);
    store.setConnectionStatus(PLAYGROUND_LOADING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_LOADING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_LOADING_SESSION_ID, "idle");
    store.setHistoryLoading(PLAYGROUND_LOADING_SESSION_ID, true);

    const threadStatusTimestamp = Date.now() - 72_000;
    const playgroundClearedReadyStatus: LeaderThreadStatus = {
      kind: "ready",
      label: "Thread Ready",
      threadKey: "q-9001",
      questId: "q-9001",
      summary: "initial implementation answer complete",
      messageId: "playground-thread-q961-ready",
      timestamp: threadStatusTimestamp - 60_000,
      updatedAt: threadStatusTimestamp - 60_000,
    };
    const playgroundActiveWorkWaitingStatus: LeaderThreadStatus = {
      kind: "waiting",
      label: "Thread Waiting",
      threadKey: "q-9001",
      questId: "q-9001",
      summary: "waiting while the current Work phase remains active",
      messageId: "playground-thread-q9001-work-waiting",
      timestamp: threadStatusTimestamp,
      updatedAt: threadStatusTimestamp,
    };
    const playgroundWaitingStatus: LeaderThreadStatus = {
      kind: "waiting",
      label: "Thread Waiting",
      threadKey: "q-9002",
      questId: "q-9002",
      summary:
        "waiting for q-9001 to finish before mobile status chip wrapping can be visually checked on the narrow add-to-home-screen layout",
      messageId: "playground-thread-status-batch",
      timestamp: threadStatusTimestamp,
      updatedAt: threadStatusTimestamp,
    };
    const playgroundReadyStatus: LeaderThreadStatus = {
      kind: "ready",
      label: "Thread Ready",
      threadKey: "q-9003",
      questId: "q-9003",
      summary: "dispatch plan is ready",
      messageId: "playground-thread-q963-phase-final",
      timestamp: threadStatusTimestamp,
      updatedAt: threadStatusTimestamp,
    };
    const playgroundCompletedWaitingStatus: LeaderThreadStatus = {
      kind: "waiting",
      label: "Thread Waiting",
      threadKey: "q-9004",
      questId: "q-9004",
      summary: "waiting for final user review after completion",
      messageId: "playground-thread-q964-waiting",
      timestamp: threadStatusTimestamp,
      updatedAt: threadStatusTimestamp,
    };
    const threadPanelSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_THREAD_PANEL_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.5",
      cwd: "/Users/stan/Dev/takode/thread-panel",
      is_containerized: false,
      isOrchestrator: true,
    };
    store.addSession(threadPanelSession);
    store.setConnectionStatus(PLAYGROUND_THREAD_PANEL_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_THREAD_PANEL_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_THREAD_PANEL_SESSION_ID, "running");
    store.setActiveTurnRoute(PLAYGROUND_THREAD_PANEL_SESSION_ID, { threadKey: "q-9001", questId: "q-9001" });
    store.setStreamingStats(PLAYGROUND_THREAD_PANEL_SESSION_ID, { startedAt: Date.now() - 42_000, outputTokens: 1280 });
    const leaderReturnFixture = createSyntheticLargeLeaderFeedFixture({
      historyMessageCount: 131,
      selectedTailCount: 30,
    });
    const leaderReturnSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_LEADER_RETURN_SESSION_ID,
      cwd: "/tmp/takode-playground/leader-return",
      is_containerized: false,
      isOrchestrator: true,
    };
    const leaderReturnAwaySession: SessionState = {
      ...session,
      session_id: PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID,
      cwd: "/tmp/takode-playground/away",
      is_containerized: false,
      isOrchestrator: false,
    };
    store.addSession(leaderReturnSession);
    store.addSession(leaderReturnAwaySession);
    for (const id of [PLAYGROUND_LEADER_RETURN_SESSION_ID, PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID]) {
      store.setConnectionStatus(id, "connected");
      store.setCliConnected(id, true);
      store.setSessionStatus(id, "idle");
    }
    store.setMessages(PLAYGROUND_LEADER_RETURN_SESSION_ID, leaderReturnFixture.allMessages);
    store.setMessages(PLAYGROUND_LEADER_RETURN_AWAY_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-leader-return-away-message",
        role: "assistant",
        content: "Synthetic away session for repeated leader return validation.",
        timestamp: Date.now() - 30_000,
        historyIndex: 0,
      }),
    ]);
    store.setThreadWindow(
      PLAYGROUND_LEADER_RETURN_SESSION_ID,
      "main",
      {
        thread_key: "main",
        from_item: 101,
        item_count: 30,
        total_items: 131,
        has_older_items: true,
        has_newer_items: false,
        source_history_length: leaderReturnFixture.selectedWindowSourceHistoryLength,
        section_item_count: 10,
        visible_item_count: 3,
        window_hash: "playground-leader-return-main",
      },
      leaderReturnFixture.selectedMainWindowMessages,
    );
    const leaderReturnCompletedAt = Date.now() - 20_000;
    store.setSessionCompletedBoard(PLAYGROUND_LEADER_RETURN_SESSION_ID, [
      {
        questId: "q-1944",
        title: "Completed tab must stay passive",
        status: "DONE",
        updatedAt: leaderReturnCompletedAt,
        completedAt: leaderReturnCompletedAt,
      },
    ]);
    store.applySyncedProjectionSnapshot({
      type: "synced_projection_snapshot",
      projection: LEADER_THREAD_TABS_PROJECTION,
      key: PLAYGROUND_LEADER_RETURN_SESSION_ID,
      generation: "playground-leader-return-tabs",
      revision: 1,
      value: {
        currentQuestStateVersion: 1,
        tabState: { version: 1 },
        tabs: [
          ["q-1944", "Completed tab must stay passive"],
          ["q-1945", "Viewed tab keeps its position"],
          ["q-1946", "Later retained tab"],
        ].map(([threadKey, title]) => ({
          threadKey,
          questId: threadKey,
          title,
          boardStatus: "DONE",
          journey: null,
          sourceLeaderSessionId: PLAYGROUND_LEADER_RETURN_SESSION_ID,
          sourceRowCreatedAt: null,
          workerSessionId: null,
          workerSessionNum: null,
          active: false,
          queued: false,
          proposed: false,
          neverStartedScheduled: false,
          completed: true,
          canClose: true,
          attention: projectedAttention(),
          updatedAt: leaderReturnCompletedAt,
        })),
        mainAttention: projectedAttention(),
        threadStatuses: {},
        activePhaseSummary: [],
      },
    });
    store.setMessages(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-thread-main",
        role: "user",
        content: "Coordinate the active Journey board.",
        timestamp: Date.now() - 180_000,
        historyIndex: 0,
        metadata: {
          threadRefs: [
            {
              threadKey: "q-9003",
              questId: "q-9003",
              source: "backfill",
              attachedAt: Date.now() - 12_000,
            },
          ],
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-attached-history",
        role: "assistant",
        content: "Earlier context attached to the implementation quest.",
        timestamp: Date.now() - 150_000,
        historyIndex: 1,
        metadata: { threadRefs: [{ threadKey: "q-9001", questId: "q-9001", source: "backfill" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-attachment-marker",
        role: "system",
        content: "1 message moved to q-9001",
        timestamp: Date.now() - 149_000,
        historyIndex: 2,
        variant: "info",
        metadata: {
          threadAttachmentMarker: {
            type: "thread_attachment_marker",
            id: "playground-thread-attachment-marker",
            timestamp: Date.now() - 149_000,
            markerKey: "thread-attachment:q-9001:playground-thread-attached-history",
            threadKey: "q-9001",
            questId: "q-9001",
            attachedAt: Date.now() - 149_000,
            attachedBy: "playground",
            messageIds: ["playground-thread-attached-history"],
            messageIndices: [1],
            ranges: ["1"],
            count: 1,
            firstMessageId: "playground-thread-attached-history",
            firstMessageIndex: 1,
          },
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-transition-marker",
        role: "system",
        content: "Work continued from Main to thread:q-9002",
        timestamp: Date.now() - 145_000,
        historyIndex: 3,
        variant: "info",
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "playground-thread-transition-marker",
            timestamp: Date.now() - 145_000,
            markerKey: "thread-transition:main->q-9002:0",
            sourceThreadKey: "main",
            threadKey: "q-9002",
            questId: "q-9002",
            transitionedAt: Date.now() - 145_000,
            reason: "route_switch",
            sourceMessageIndex: 0,
          },
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-outbound-transition",
        role: "system",
        content: "Work continued from thread:q-9001 to thread:q-9002",
        timestamp: Date.now() - 140_000,
        historyIndex: 4,
        variant: "info",
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "playground-thread-outbound-transition",
            timestamp: Date.now() - 140_000,
            markerKey: "thread-transition:q-9001->q-9002:1",
            sourceThreadKey: "q-9001",
            sourceQuestId: "q-9001",
            threadKey: "q-9002",
            questId: "q-9002",
            transitionedAt: Date.now() - 140_000,
            reason: "route_switch",
          },
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-inbound-transition",
        role: "system",
        content: "Work continued from thread:q-9002 to thread:q-9001",
        timestamp: Date.now() - 135_000,
        historyIndex: 5,
        variant: "info",
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "playground-thread-inbound-transition",
            timestamp: Date.now() - 135_000,
            markerKey: "thread-transition:q-9002->q-9001:2",
            sourceThreadKey: "q-9002",
            sourceQuestId: "q-9002",
            threadKey: "q-9001",
            questId: "q-9001",
            transitionedAt: Date.now() - 135_000,
            reason: "route_switch",
          },
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q961-ready",
        role: "assistant",
        content: "The initial q-9001 answer is complete and remains in history.",
        timestamp: Date.now() - 130_000,
        historyIndex: 6,
        metadata: {
          threadRefs: [{ threadKey: "q-9001", questId: "q-9001", source: "explicit" }],
          threadStatusMarkers: [playgroundClearedReadyStatus],
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q961",
        role: "assistant",
        content: "Fresh routed leader activity has started, so the old q-9001 Ready footer is cleared.",
        timestamp: Date.now() - 120_000,
        historyIndex: 7,
        metadata: { threadRefs: [{ threadKey: "q-9001", questId: "q-9001", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q961-assistant",
        role: "assistant",
        content: "Tool calls and implementation notes are continuing in q-9001.",
        timestamp: Date.now() - 110_000,
        historyIndex: 8,
        metadata: { threadRefs: [{ threadKey: "q-9001", questId: "q-9001", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q962",
        role: "assistant",
        content: "Queued until the dependency finishes.",
        timestamp: Date.now() - 90_000,
        historyIndex: 9,
        metadata: { threadRefs: [{ threadKey: "q-9002", questId: "q-9002", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q963",
        role: "assistant",
        content: "Waiting for a free worker before dispatch.",
        timestamp: Date.now() - 60_000,
        historyIndex: 10,
        metadata: { threadRefs: [{ threadKey: "q-9003", questId: "q-9003", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-status-batch",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "text", text: "" }],
        turnDurationMs: 18_253,
        timestamp: threadStatusTimestamp,
        historyIndex: 11,
        metadata: {
          threadRefs: [
            { threadKey: "q-9002", questId: "q-9002", source: "explicit" },
            { threadKey: "q-9003", questId: "q-9003", source: "explicit" },
          ],
          threadStatusMarkers: [playgroundWaitingStatus, playgroundReadyStatus],
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q961-resolved-input",
        role: "assistant",
        content: "The scope confirmation was answered and should keep its resolved needs-input marker visible.",
        timestamp: Date.now() - 52_000,
        historyIndex: 12,
        metadata: { threadRefs: [{ threadKey: "q-9001", questId: "q-9001", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q963-stale-ready",
        role: "assistant",
        content:
          "Older Thread Ready output remains in history, but its resolved notification marker should not render as a crossed-out stale chip.",
        timestamp: Date.now() - 44_000,
        historyIndex: 13,
        metadata: { threadRefs: [{ threadKey: "q-9003", questId: "q-9003", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q964",
        role: "assistant",
        content: "Completed Journey is ready for review without active phase cues.",
        timestamp: Date.now() - 30_000,
        historyIndex: 14,
        metadata: { threadRefs: [{ threadKey: "q-9004", questId: "q-9004", source: "explicit" }] },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q965-recovered-source",
        role: "assistant",
        content:
          "Approval plan for q-9005: run the focused worker, then hold at Code Review for the thumbnail evidence.",
        timestamp: Date.now() - 20_000,
        historyIndex: 15,
      }),
      makePlaygroundMessage({
        id: "playground-thread-q963-phase-commentary",
        role: "assistant",
        content: "Checking the internal worker queue before publishing the dispatch plan.",
        timestamp: Date.now() - 10_000,
        historyIndex: 16,
        metadata: {
          codexMessagePhase: "commentary",
          threadRefs: [{ threadKey: "q-9003", questId: "q-9003", source: "explicit" }],
        },
      }),
      makePlaygroundMessage({
        id: "playground-thread-q963-phase-final",
        role: "assistant",
        content: "The dispatch plan is ready with the requested worker assignment.",
        timestamp: Date.now() - 9_000,
        historyIndex: 17,
        metadata: {
          codexMessagePhase: "final_answer",
          threadRefs: [{ threadKey: "q-9003", questId: "q-9003", source: "explicit" }],
          threadStatusMarkers: [playgroundReadyStatus],
        },
      }),
    ]);
    const questProjectionMessages =
      useStore
        .getState()
        .messages.get(PLAYGROUND_THREAD_PANEL_SESSION_ID)
        ?.filter((message) =>
          [
            "playground-thread-outbound-transition",
            "playground-thread-inbound-transition",
            "playground-thread-q961-assistant",
          ].includes(message.id),
        ) ?? [];
    store.setThreadWindow(
      PLAYGROUND_THREAD_PANEL_SESSION_ID,
      "q-9001",
      {
        thread_key: "q-9001",
        from_item: 2,
        item_count: questProjectionMessages.length,
        total_items: questProjectionMessages.length + 2,
        has_older_items: true,
        has_newer_items: false,
        source_history_length: 17,
        section_item_count: 10,
        visible_item_count: 3,
      },
      questProjectionMessages,
    );
    const phaseProjectionMessages =
      useStore
        .getState()
        .messages.get(PLAYGROUND_THREAD_PANEL_SESSION_ID)
        ?.filter((message) =>
          [
            "playground-thread-main",
            "playground-thread-q963",
            "playground-thread-status-batch",
            "playground-thread-q963-stale-ready",
            "playground-thread-q963-phase-final",
            "playground-thread-q963-phase-commentary",
          ].includes(message.id),
        ) ?? [];
    store.setThreadWindow(
      PLAYGROUND_THREAD_PANEL_SESSION_ID,
      "q-9003",
      {
        thread_key: "q-9003",
        from_item: 0,
        item_count: phaseProjectionMessages.length,
        total_items: phaseProjectionMessages.length,
        has_older_items: false,
        has_newer_items: false,
        source_history_length: 18,
        section_item_count: 10,
        visible_item_count: phaseProjectionMessages.length,
      },
      phaseProjectionMessages,
    );
    const mainProjectionMessages =
      useStore
        .getState()
        .messages.get(PLAYGROUND_THREAD_PANEL_SESSION_ID)
        ?.filter((message) =>
          [
            "playground-thread-main",
            "playground-thread-attached-history",
            "playground-thread-attachment-marker",
            "playground-thread-transition-marker",
            "playground-thread-outbound-transition",
            "playground-thread-inbound-transition",
          ].includes(message.id),
        ) ?? [];
    store.setThreadWindow(
      PLAYGROUND_THREAD_PANEL_SESSION_ID,
      "main",
      {
        thread_key: "main",
        from_item: 0,
        item_count: mainProjectionMessages.length,
        total_items: mainProjectionMessages.length,
        has_older_items: false,
        has_newer_items: false,
        source_history_length: 15,
        section_item_count: 10,
        visible_item_count: 3,
      },
      mainProjectionMessages,
    );
    store.setSessionNotifications(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      {
        id: "playground-attention-input",
        category: "needs-input",
        summary: "Choose whether q-9001 should proceed to review",
        timestamp: Date.now() - 104_000,
        messageId: "playground-thread-q961-assistant",
        threadKey: "q-9001",
        questId: "q-9001",
        done: false,
      },
      {
        id: "playground-missing-user-decision",
        category: "needs-input",
        summary: "Approve dispatching the q-9003 follow-up worker",
        timestamp: Date.now() - 64_000,
        messageId: null,
        threadKey: "q-9003",
        questId: "q-9003",
        done: false,
      },
      {
        id: "playground-routed-source-decision",
        category: "needs-input",
        summary: "Approve the q-9005 plan/description",
        timestamp: Date.now() - 24_000,
        messageId: "playground-thread-q965-recovered-source",
        threadKey: "q-9005",
        questId: "q-9005",
        done: false,
      },
      {
        id: "playground-resolved-scope-input",
        category: "needs-input",
        summary: "Scope confirmation answered",
        timestamp: Date.now() - 52_000,
        messageId: "playground-thread-q961-resolved-input",
        threadKey: "q-9001",
        questId: "q-9001",
        done: true,
      },
      {
        id: "playground-stale-thread-ready",
        category: "review",
        summary: "Thread ready: q-9003 | older dispatch pass complete",
        timestamp: Date.now() - 44_000,
        messageId: "playground-thread-q963-stale-ready",
        threadKey: "q-9003",
        questId: "q-9003",
        done: true,
      },
      {
        id: "playground-attention-reviewed",
        category: "review",
        summary: "q-9002 review already handled",
        timestamp: Date.now() - 84_000,
        messageId: null,
        threadKey: "q-9002",
        questId: "q-9002",
        done: true,
      },
    ]);
    store.setSessionBoard(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      {
        questId: "q-9001",
        title: "Finish data-flow cleanup",
        worker: "playground-thread-worker",
        workerNum: 1321,
        status: "WORKING",
        updatedAt: Date.now() - 120_000,
        createdAt: Date.now() - 240_000,
        journey: {
          mode: "active",
          phaseIds: ["alignment", "work", "memory"],
          activePhaseIndex: 1,
          currentPhaseId: "work",
          phaseTimings: {
            "0": { startedAt: Date.now() - 240_000, endedAt: Date.now() - 180_000 },
            "1": { startedAt: Date.now() - 180_000 },
          },
        },
      },
      {
        questId: "q-9002",
        title: "Add queued thread wait chip",
        status: "QUEUED",
        waitFor: ["q-9001"],
        updatedAt: Date.now() - 90_000,
        createdAt: Date.now() - 210_000,
        journey: { mode: "active", phaseIds: ["alignment", "work", "memory"] },
      },
      {
        questId: "q-9003",
        title: "Dispatch follow-up worker",
        status: "QUEUED",
        waitForInput: ["playground-missing-user-decision"],
        updatedAt: Date.now() - 60_000,
        createdAt: Date.now() - 180_000,
        journey: { mode: "active", phaseIds: ["alignment", "work", "memory"] },
      },
      {
        questId: "q-9005",
        title: "Recover approval source message",
        status: "QUEUED",
        waitForInput: ["playground-routed-source-decision"],
        updatedAt: Date.now() - 24_000,
        createdAt: Date.now() - 150_000,
        journey: { mode: "active", phaseIds: ["alignment", "work", "memory"] },
      },
      {
        questId: "q-9006",
        title: "Review proposed tab dismissal",
        status: "PROPOSED",
        updatedAt: Date.now() - 12_000,
        createdAt: Date.now() - 120_000,
        journey: { mode: "proposed", phaseIds: ["alignment", "work", "memory"] },
      },
    ]);
    store.setSessionBoardRowStatuses(PLAYGROUND_THREAD_PANEL_SESSION_ID, {
      "q-9001": {
        worker: { sessionId: "playground-thread-worker", sessionNum: 1321, name: "Clear Mesa", status: "running" },
        reviewer: null,
      },
      "q-9002": {
        worker: { sessionId: "playground-thread-worker-queued", sessionNum: 1320, status: "idle" },
        reviewer: null,
      },
      "q-9003": {
        worker: { sessionId: "playground-thread-worker-dispatch", sessionNum: 1305, status: "disconnected" },
        reviewer: null,
      },
    });
    store.setSessionCompletedBoard(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      {
        questId: "q-9004",
        title: "Finish completed Journey display",
        status: "MEMORY",
        updatedAt: Date.now() - 30_000,
        completedAt: Date.now() - 20_000,
        createdAt: Date.now() - 150_000,
        journey: {
          mode: "active",
          phaseIds: ["alignment", "work", "memory"],
          currentPhaseId: "memory",
          phaseTimings: {
            "0": { startedAt: Date.now() - 150_000, endedAt: Date.now() - 120_000 },
            "1": { startedAt: Date.now() - 120_000, endedAt: Date.now() - 80_000 },
            "2": { startedAt: Date.now() - 80_000, endedAt: Date.now() - 20_000 },
          },
        },
      },
    ]);
    store.setSessionAttentionRecords(PLAYGROUND_THREAD_PANEL_SESSION_ID, [
      {
        id: "playground-chip-needs-input",
        leaderSessionId: PLAYGROUND_THREAD_PANEL_SESSION_ID,
        type: "needs_input",
        source: { kind: "notification", id: "playground-chip-needs-input", questId: "q-9001" },
        questId: "q-9001",
        threadKey: "q-9001",
        title: "Answer q-9001 worker",
        summary: "Implementation is waiting for a concrete user answer in the quest thread.",
        actionLabel: "Answer",
        priority: "needs_input",
        state: "unresolved",
        createdAt: Date.now() - 100_000,
        updatedAt: Date.now() - 80_000,
        route: { threadKey: "q-9001", questId: "q-9001", messageId: "playground-thread-q961-assistant" },
        chipEligible: true,
        ledgerEligible: true,
        dedupeKey: "playground-chip-needs-input",
      },
      {
        id: "playground-chip-seen",
        leaderSessionId: PLAYGROUND_THREAD_PANEL_SESSION_ID,
        type: "blocked_user_resolvable",
        source: { kind: "manual", id: "playground-chip-seen", questId: "q-9003" },
        questId: "q-9003",
        threadKey: "q-9003",
        title: "Unblock dispatch",
        summary: "This item has been seen but still needs a user-resolvable action.",
        actionLabel: "Unblock",
        priority: "blocked",
        state: "seen",
        createdAt: Date.now() - 70_000,
        updatedAt: Date.now() - 50_000,
        route: { threadKey: "q-9003", questId: "q-9003" },
        chipEligible: true,
        ledgerEligible: true,
        dedupeKey: "playground-chip-seen",
      },
    ]);
    const projectedTabKeys = ["q-9001", "q-9004", "q-9003", "q-9005", "q-9002", "q-9006"];
    const projectedBoardRows = new Map(
      [
        ...(useStore.getState().sessionBoards.get(PLAYGROUND_THREAD_PANEL_SESSION_ID) ?? []),
        ...(useStore.getState().sessionCompletedBoards.get(PLAYGROUND_THREAD_PANEL_SESSION_ID) ?? []),
      ].map((row) => [row.questId, row]),
    );
    store.applySyncedProjectionSnapshot({
      type: "synced_projection_snapshot",
      projection: LEADER_THREAD_TABS_PROJECTION,
      key: PLAYGROUND_THREAD_PANEL_SESSION_ID,
      generation: "playground-leader-tabs",
      revision: 1,
      value: {
        currentQuestStateVersion: 1,
        tabState: { version: 1 },
        tabs: projectedTabKeys.map((threadKey) => {
          const boardRow = projectedBoardRows.get(threadKey)!;
          const completed = boardRow.completedAt !== undefined;
          const queued = !completed && boardRow.status === "QUEUED";
          const proposed = !completed && boardRow.status === "PROPOSED";
          const attention =
            threadKey === "q-9001"
              ? projectedAttention({ needsInput: true, reviewUnread: true, updatedAt: boardRow.updatedAt })
              : threadKey === "q-9003"
                ? projectedAttention({ reviewUnread: true, updatedAt: boardRow.updatedAt })
                : threadKey === "q-9005"
                  ? projectedAttention({ mutedNeedsInput: true, updatedAt: boardRow.updatedAt })
                  : projectedAttention({ updatedAt: boardRow.updatedAt });
          return {
            threadKey,
            questId: threadKey,
            title: boardRow.title ?? threadKey,
            boardStatus: boardRow.status ?? null,
            journey: buildPlaygroundProjectedJourney(boardRow, completed),
            sourceLeaderSessionId: PLAYGROUND_THREAD_PANEL_SESSION_ID,
            sourceRowCreatedAt: boardRow.createdAt,
            workerSessionId: boardRow.worker ?? null,
            workerSessionNum: boardRow.workerNum ?? null,
            active: !queued && !proposed && !completed,
            queued,
            proposed,
            neverStartedScheduled: (queued || proposed) && boardRow.threadTabActivatedAt === undefined,
            completed,
            canClose: completed || queued || proposed,
            attention,
            updatedAt: boardRow.updatedAt,
          };
        }),
        mainAttention: projectedAttention(),
        threadStatuses: {
          "q-9001": playgroundActiveWorkWaitingStatus,
          "q-9002": playgroundWaitingStatus,
          "q-9003": playgroundReadyStatus,
          "q-9004": playgroundCompletedWaitingStatus,
        },
        activePhaseSummary: buildLeaderActivePhaseSummary(
          useStore.getState().sessionBoards.get(PLAYGROUND_THREAD_PANEL_SESSION_ID) ?? [],
        ),
      },
    });

    const codexTerminalSession: SessionState = {
      ...session,
      session_id: PLAYGROUND_CODEX_TERMINAL_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.3-codex",
      cwd: "/Users/stan/Dev/project/codex-live-terminal",
      is_containerized: false,
      skill_metadata: [
        {
          name: "doc-coauthoring",
          path: "/Users/stan/.agents/skills/doc-coauthoring/SKILL.md",
          description: "Draft and edit design docs",
        },
        {
          name: "frontend-design",
          path: "/Users/stan/.agents/skills/frontend-design/SKILL.md",
          description: "Polish React UI states",
        },
      ],
      apps: [
        {
          id: "connector_google_drive",
          name: "Google Drive",
          description: "Search and edit Drive files",
        },
        {
          id: "connector_slack",
          name: "Slack",
          description: "Read and draft Slack updates",
        },
      ],
    };
    store.addSession(codexTerminalSession);
    store.setConnectionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, [
      {
        id: "playground-codex-terminal-user",
        role: "user",
        content: "Run the flaky test shard and tell me why it stalls.",
        timestamp: Date.now() - 60_000,
      },
      {
        id: "playground-codex-terminal-bash",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 55_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-live-bash",
            name: "Bash",
            input: {
              command: "bun test src/session/ws-bridge.test.ts --runInBand --reporter=verbose",
            },
          },
        ],
      },
      {
        id: "playground-codex-terminal-bash-complete",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 25_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-complete-bash",
            name: "Bash",
            input: {
              command: "find src -name '*.test.ts' -maxdepth 3",
            },
          },
        ],
      },
      {
        id: "playground-codex-terminal-bash-orphaned",
        role: "assistant",
        content: "",
        timestamp: Date.now() - 18_000,
        model: "gpt-5.3-codex",
        contentBlocks: [
          {
            type: "tool_use",
            id: "playground-codex-orphaned-bash",
            name: "Bash",
            input: {
              command: "git status --short",
            },
          },
        ],
      },
    ]);
    store.setToolStartTimestamps(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, {
      "playground-codex-live-bash": Date.now() - 49_000,
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "RUN  src/session/ws-bridge.test.ts\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 50,
      outputDelta: "  ✓ keeps tool_result_preview tails idempotent\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-live-bash", {
      toolName: "Bash",
      elapsedSeconds: 51,
      outputDelta: "  ... waiting on ws reconnect watchdog case ...\n",
    });
    store.setToolProgress(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      toolName: "Bash",
      elapsedSeconds: 14,
      outputDelta: "src/components/MessageFeed.test.tsx\nsrc/components/ToolBlock.test.tsx\n",
    });
    store.setToolResult(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-complete-bash", {
      tool_use_id: "playground-codex-complete-bash",
      content: "Terminal command completed, but no output was captured.",
      is_error: false,
      total_size: 53,
      is_truncated: false,
      duration_seconds: 14.1,
    });
    store.setToolResult(PLAYGROUND_CODEX_TERMINAL_SESSION_ID, "playground-codex-orphaned-bash", {
      tool_use_id: "playground-codex-orphaned-bash",
      content: "Terminal command did not deliver a final result after a later tool completed.",
      is_error: false,
      total_size: 77,
      is_truncated: false,
      duration_seconds: 121.7,
      synthetic_reason: "superseded_by_later_completed_tool",
      retained_output: false,
    });

    store.addSession({
      ...session,
      session_id: PLAYGROUND_CODEX_PENDING_SESSION_ID,
      backend_type: "codex",
      backend_state: "connected",
      backend_error: null,
      model: "gpt-5.4",
      num_turns: 3,
      context_used_percent: 38,
    });
    store.setConnectionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_CODEX_PENDING_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_CODEX_PENDING_SESSION_ID, "running");
    store.setMessages(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-codex-pending-user",
        role: "user",
        content: "Inspect the auth flow and summarize what is broken.",
      }),
      makePlaygroundMessage({
        id: "playground-codex-pending-assistant",
        role: "assistant",
        content: "Searching the auth pipeline now.",
      }),
    ]);
    store.setPendingCodexInputs(PLAYGROUND_CODEX_PENDING_SESSION_ID, [
      {
        id: "playground-pending-codex-1",
        content: "Also check whether refresh-token rotation races with logout.",
        timestamp: Date.now(),
        cancelable: true,
        threadKey: "q-1958",
        questId: "q-1958",
        draftImages: [],
      },
      {
        id: "playground-pending-codex-2",
        clientMsgId: "playground-pending-failed-client",
        content: "If you find a race, propose the smallest safe fix first.",
        timestamp: Date.now() + 1,
        cancelable: true,
        threadKey: "q-1958",
        questId: "q-1958",
        deliveryState: "failed",
        failureReason: "nonrecoverable_turn_start",
        failureMessage: "Codex rejected this input before delivery.",
        failedAt: Date.now() + 2,
        draftImages: [],
      },
      {
        id: "playground-pending-codex-3",
        content: "A failed message from another browser can still be cancelled after reconnect.",
        timestamp: Date.now() + 3,
        cancelable: true,
        threadKey: "q-1958",
        questId: "q-1958",
        deliveryState: "failed",
        failureReason: "nonrecoverable_turn_start",
        failureMessage: "Codex rejected this input before delivery.",
        failedAt: Date.now() + 4,
        draftImages: [],
      },
    ]);
    store.addPendingUserUpload(PLAYGROUND_CODEX_PENDING_SESSION_ID, {
      id: "playground-pending-failed-client",
      content: "If you find a race, propose the smallest safe fix first.",
      timestamp: Date.now() + 1,
      stage: "delivering",
      threadKey: "q-1958",
      questId: "q-1958",
      images: [],
      prepared: {
        deliveryContent: "If you find a race, propose the smallest safe fix first.",
        imageRefs: [],
      },
    });
    store.consumePendingUserUpload(PLAYGROUND_CODEX_PENDING_SESSION_ID, "playground-pending-failed-client");

    const repeatedBackendError =
      "Error: stream disconnected before completion: error sending request for url (http://localhost:4000/responses)";
    store.addSession({
      ...session,
      session_id: PLAYGROUND_REPEATED_ERROR_SESSION_ID,
      backend_type: "codex",
      backend_state: "connected",
      backend_error: null,
      model: "gpt-5.5",
      cwd: "/Users/stan/Dev/takode/repeated-error-feed",
      is_containerized: false,
      num_turns: 5,
    });
    store.setConnectionStatus(PLAYGROUND_REPEATED_ERROR_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_REPEATED_ERROR_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_REPEATED_ERROR_SESSION_ID, "idle");
    store.setMessages(PLAYGROUND_REPEATED_ERROR_SESSION_ID, [
      makePlaygroundMessage({
        id: "playground-repeated-error-user",
        role: "user",
        content: "Why did the leader stop responding?",
        timestamp: Date.now() - 34_000,
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        makePlaygroundMessage({
          id: `playground-repeated-error-${index + 1}`,
          role: "system",
          content: repeatedBackendError,
          timestamp: Date.now() - 32_000 + index,
          variant: "error",
        }),
      ),
      makePlaygroundMessage({
        id: "playground-repeated-error-hidden-route-marker",
        role: "system",
        content: "",
        timestamp: Date.now() - 31_000,
        metadata: {
          threadTransitionMarker: {
            type: "thread_transition_marker",
            id: "playground-repeated-error-hidden-route-marker",
            timestamp: Date.now() - 31_000,
            markerKey: "thread-transition:main->repeated-error-playground",
            sourceThreadKey: "main",
            threadKey: "repeated-error-playground",
            transitionedAt: Date.now() - 31_000,
            reason: "route_switch",
          },
        },
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        makePlaygroundMessage({
          id: `playground-repeated-error-after-hidden-${index + 1}`,
          role: "system",
          content: repeatedBackendError,
          timestamp: Date.now() - 30_500 + index,
          variant: "error",
        }),
      ),
      makePlaygroundMessage({
        id: "playground-repeated-error-boundary",
        role: "system",
        content: "Session restored after operator intervention",
        timestamp: Date.now() - 27_000,
      }),
      makePlaygroundMessage({
        id: "playground-repeated-error-later",
        role: "system",
        content: repeatedBackendError,
        timestamp: Date.now() - 26_000,
        variant: "error",
      }),
      makePlaygroundMessage({
        id: "playground-repeated-error-followup",
        role: "user",
        content: "Continue after the repeated backend errors.",
        timestamp: Date.now() - 25_000,
      }),
    ]);

    // Mock tool results for ToolResultSection demo
    store.setToolResult(sessionId, "tu-1", {
      tool_use_id: "tu-1",
      content: "src/auth/middleware.ts\nsrc/auth/login.ts\nsrc/auth/session.ts",
      is_error: false,
      total_size: 58,
      is_truncated: false,
      duration_seconds: 0.3,
    });
    store.setToolResult(sessionId, "tu-2", {
      tool_use_id: "tu-2",
      content:
        '...\n  if (!req.session.userId) {\n    return res.status(401).json({ error: "Unauthorized" });\n  }\n  next();\n}',
      is_error: false,
      total_size: 7168,
      is_truncated: true,
      duration_seconds: 0.1,
    });
    store.setToolResult(sessionId, "tu-3", {
      tool_use_id: "tu-3",
      content: "FAIL src/auth/__tests__/middleware.test.ts\n  \u25CF Auth Middleware \u203A should reject expired toke",
      is_error: true,
      total_size: 185,
      is_truncated: false,
      duration_seconds: 12.4,
    });

    // Mock tool results with durations for standalone ToolBlock demos
    const toolDurations: Record<string, number> = {
      "tb-1": 3.2,
      "tb-2": 0.1,
      "tb-3": 0.4,
      "tb-4": 0.2,
      "tb-5": 0.8,
      "tb-6": 1.5,
      "tb-7": 2.1,
      "tb-8": 4.7,
      "tb-10": 0.0,
      "tb-11": 0.3,
      "tb-12": 0.1,
      "tb-14": 0.0,
      "tb-15": 0.0,
      "tb-image-lightbox": 0.2,
    };
    for (const [id, dur] of Object.entries(toolDurations)) {
      store.setToolResult(sessionId, id, {
        tool_use_id: id,
        content: "",
        is_error: false,
        total_size: 0,
        is_truncated: false,
        duration_seconds: dur,
      });
    }

    // Mock a running Codex Bash command with streamed output deltas.
    store.setToolStartTimestamps(sessionId, { "tb-live": Date.now() - 47_000 });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 47,
      outputDelta: "Collecting source shards...\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 48,
      outputDelta: "Merged 128/512 files\n",
    });
    store.setToolProgress(sessionId, "tb-live", {
      toolName: "Bash",
      elapsedSeconds: 49,
      outputDelta: "Merged 256/512 files\n",
    });

    // Additional ChatView states used by the chat-flow Playground coverage.
    store.addSession({
      ...session,
      session_id: PLAYGROUND_STARTING_SESSION_ID,
      backend_type: "claude-sdk",
      backend_state: "initializing",
      backend_error: null,
    });
    store.setConnectionStatus(PLAYGROUND_STARTING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_STARTING_SESSION_ID, false);
    store.setSessionStatus(PLAYGROUND_STARTING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RESUMING_SESSION_ID,
      backend_type: "codex",
      backend_state: "resuming",
      backend_error: null,
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RESUMING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RESUMING_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RESUMING_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_RESUMING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RECOVERING_SESSION_ID,
      backend_type: "codex",
      backend_state: "recovering",
      backend_error: null,
      backend_reconnect: { attempt: 2, maxAttempts: 5, cycleStartedAt: Date.now() - 45_000 },
      codex_provider_retry: {
        family: "model_backend_stream_error",
        ownerId: "playground-retry-owner",
        attempt: 4,
        maxAttempts: null,
        startedAt: Date.now() - 72_000,
      },
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RECOVERING_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RECOVERING_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RECOVERING_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_RECOVERING_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_STREAM_RETRY_SESSION_ID,
      backend_type: "codex",
      model: "gpt-5.6-sol",
      backend_state: "connected",
      codex_stream_retry: { turnId: "playground-stream-turn" },
    });
    store.setConnectionStatus(PLAYGROUND_STREAM_RETRY_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_STREAM_RETRY_SESSION_ID, true);
    store.setSessionStatus(PLAYGROUND_STREAM_RETRY_SESSION_ID, "running");

    store.addSession({
      ...session,
      session_id: PLAYGROUND_DISCONNECTED_SESSION_ID,
      backend_type: "claude-sdk",
      backend_state: "connected",
      backend_error: null,
    });
    store.setConnectionStatus(PLAYGROUND_DISCONNECTED_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_DISCONNECTED_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_DISCONNECTED_SESSION_ID);
    store.setSessionStatus(PLAYGROUND_DISCONNECTED_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_BROKEN_SESSION_ID,
      backend_type: "codex",
      backend_state: "broken",
      backend_error: "Codex initialization failed: Transport closed",
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_BROKEN_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_BROKEN_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_BROKEN_SESSION_ID);
    store.setCliDisconnectReason(PLAYGROUND_BROKEN_SESSION_ID, "broken");
    store.setSessionStatus(PLAYGROUND_BROKEN_SESSION_ID, null);

    store.addSession({
      ...session,
      session_id: PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID,
      backend_type: "codex",
      backend_state: "recovery_suppressed",
      backend_error:
        "Codex automatic recovery is paused after 5 failed attempts. Use Reconnect to start a fresh cycle.",
      backend_reconnect: { attempt: 5, maxAttempts: 5, cycleStartedAt: Date.now() - 6 * 60_000 },
      model: "gpt-5.3-codex",
    });
    store.setConnectionStatus(PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID, "connected");
    store.setCliConnected(PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID, false);
    store.setCliEverConnected(PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID);
    store.setCliDisconnectReason(PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID, "recovery_suppressed");
    store.setSessionStatus(PLAYGROUND_RECOVERY_SUPPRESSED_SESSION_ID, null);

    seedCodexTurnRecoveryPlaygroundStates(store, session);

    // Seed claimed-quest state used by non-sidebar playground surfaces.
    store.addSession({ ...session, session_id: questInProgressId, claimedQuestStatus: "in_progress" });
    store.addSession({
      ...session,
      session_id: questVerificationId,
      claimedQuestStatus: "done",
      claimedQuestVerificationInboxUnread: true,
    });
    store.setSessionTimers("leader-alpha", [
      {
        id: "sidebar-timer-1",
        sessionId: "leader-alpha",
        title: "Check worker queue",
        description: "Review the active herd backlog and redistribute work if needed.",
        type: "delay",
        originalSpec: "20m",
        nextFireAt: Date.now() + 1_200_000,
        createdAt: Date.now() - 240_000,
        fireCount: 0,
      },
    ]);
    store.setSessionTimers("playground-worker-banner", [
      {
        id: "banner-timer-1",
        sessionId: "playground-worker-banner",
        title: "Resume banner worker",
        description: "Worker is idle until the scheduled timer fires.",
        type: "delay",
        originalSpec: "12m",
        nextFireAt: Date.now() + 720_000,
        createdAt: Date.now() - 180_000,
        fireCount: 0,
      },
    ]);
    store.setSessionBoard("leader-alpha", [
      {
        questId: "q-play-1",
        title: "Refine leader banner controls",
        status: "WORKING",
        updatedAt: Date.now() - 120_000,
        journey: { mode: "active", phaseIds: ["alignment", "work", "memory"], currentPhaseId: "work" },
      },
      {
        questId: "q-play-2",
        title: "Review sidebar phase summaries",
        status: "MEMORY",
        updatedAt: Date.now() - 60_000,
        journey: { mode: "active", phaseIds: ["alignment", "work", "memory"], currentPhaseId: "memory" },
      },
    ]);

    return () => {
      useStore.getState().clearSyncedProjectionsForKey(PLAYGROUND_THREAD_PANEL_SESSION_ID);
      useStore.getState().clearSyncedProjectionsForKey(PLAYGROUND_LEADER_RETURN_SESSION_ID);
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        const messages = new Map(s.messages);
        const historyWindows = new Map(s.historyWindows);
        const threadWindows = new Map(s.threadWindows);
        const threadWindowMessages = new Map(s.threadWindowMessages);
        const pendingPermissions = new Map(s.pendingPermissions);
        const connectionStatus = new Map(s.connectionStatus);
        const cliConnected = new Map(s.cliConnected);
        const cliEverConnected = new Map(s.cliEverConnected);
        const sessionStatus = new Map(s.sessionStatus);
        const activeTurnRoutes = new Map(s.activeTurnRoutes);
        const streaming = new Map(s.streaming);
        const streamingStartedAt = new Map(s.streamingStartedAt);
        const streamingOutputTokens = new Map(s.streamingOutputTokens);
        const cliDisconnectReason = new Map(s.cliDisconnectReason);
        const feedScrollPosition = new Map(s.feedScrollPosition);
        const historyLoading = new Map(s.historyLoading);
        const sessionBoards = new Map(s.sessionBoards);
        const sessionBoardRowStatuses = new Map(s.sessionBoardRowStatuses);
        const sessionCompletedBoards = new Map(s.sessionCompletedBoards);
        const sessionNotifications = new Map(s.sessionNotifications);
        const sessionAttentionRecords = new Map(s.sessionAttentionRecords);
        const pendingCodexInputs = new Map(s.pendingCodexInputs);
        const pendingUserUploads = new Map(s.pendingUserUploads);
        const pendingUserUploadRestorations = new Map(s.pendingUserUploadRestorations);
        const sessionTimers = new Map(s.sessionTimers);
        const toolProgress = new Map(s.toolProgress);
        const toolResults = new Map(s.toolResults);
        const toolStartTimestamps = new Map(s.toolStartTimestamps);

        for (const demoId of demoSessionIds) {
          const prevSession = prevSessions.get(demoId);
          const prevMessageList = prevMessages.get(demoId);
          const prevPermissionMap = prevPerms.get(demoId);
          const prevConnection = prevConn.get(demoId);
          const prevCliConnected = prevCli.get(demoId);
          const prevCliSeen = prevCliEver.get(demoId);
          const prevDisconnectReason = prevCliDisconnectReason.get(demoId);
          const prevSessionState = prevStatus.get(demoId);
          const prevActiveTurnRoute = prevActiveTurnRoutes.get(demoId);
          const prevStream = prevStreaming.get(demoId);
          const prevStreamStarted = prevStreamingStartedAt.get(demoId);
          const prevStreamTokens = prevStreamingOutputTokens.get(demoId);
          const prevFeedScrollPosition = prevFeedScrollPositions.get(demoId);
          const prevLoading = prevHistoryLoading.get(demoId);
          const prevPendingCodex = prevPendingCodexInputs.get(demoId);
          const prevPendingUserUpload = prevPendingUserUploads.get(demoId);
          const prevPendingUserUploadRestoration = prevPendingUserUploadRestorations.get(demoId);
          const prevBoardRowStatuses = prevSessionBoardRowStatuses.get(demoId);
          const prevCompletedBoard = prevSessionCompletedBoards.get(demoId);
          const prevSessionToolProgress = prevToolProgress.get(demoId);
          const prevSessionToolResults = prevToolResults.get(demoId);
          const prevSessionToolStarts = prevToolStartTimestamps.get(demoId);
          const prevAttentionRecords = prevSessionAttentionRecords.get(demoId);

          if (prevSession) sessions.set(demoId, prevSession);
          else sessions.delete(demoId);
          if (prevMessageList) messages.set(demoId, prevMessageList);
          else messages.delete(demoId);
          const prevHistoryWindow = prevHistoryWindows.get(demoId);
          if (prevHistoryWindow) historyWindows.set(demoId, prevHistoryWindow);
          else historyWindows.delete(demoId);
          const prevThreadWindowMap = prevThreadWindows.get(demoId);
          const prevThreadWindowMessageMap = prevThreadWindowMessages.get(demoId);
          if (prevThreadWindowMap) threadWindows.set(demoId, prevThreadWindowMap);
          else threadWindows.delete(demoId);
          if (prevThreadWindowMessageMap) threadWindowMessages.set(demoId, prevThreadWindowMessageMap);
          else threadWindowMessages.delete(demoId);
          if (prevPermissionMap) pendingPermissions.set(demoId, prevPermissionMap);
          else pendingPermissions.delete(demoId);
          if (prevConnection) connectionStatus.set(demoId, prevConnection);
          else connectionStatus.delete(demoId);
          if (typeof prevCliConnected === "boolean") cliConnected.set(demoId, prevCliConnected);
          else cliConnected.delete(demoId);
          if (typeof prevCliSeen === "boolean") cliEverConnected.set(demoId, prevCliSeen);
          else cliEverConnected.delete(demoId);
          if (prevDisconnectReason !== undefined) cliDisconnectReason.set(demoId, prevDisconnectReason);
          else cliDisconnectReason.delete(demoId);
          if (prevSessionState) sessionStatus.set(demoId, prevSessionState);
          else sessionStatus.delete(demoId);
          if (prevActiveTurnRoute !== undefined) activeTurnRoutes.set(demoId, prevActiveTurnRoute);
          else activeTurnRoutes.delete(demoId);
          if (typeof prevStream === "string") streaming.set(demoId, prevStream);
          else streaming.delete(demoId);
          if (typeof prevStreamStarted === "number") streamingStartedAt.set(demoId, prevStreamStarted);
          else streamingStartedAt.delete(demoId);
          if (typeof prevStreamTokens === "number") streamingOutputTokens.set(demoId, prevStreamTokens);
          else streamingOutputTokens.delete(demoId);
          if (prevFeedScrollPosition) feedScrollPosition.set(demoId, prevFeedScrollPosition);
          else feedScrollPosition.delete(demoId);
          if (prevLoading) historyLoading.set(demoId, true);
          else historyLoading.delete(demoId);
          const prevBoard = prevSessionBoards.get(demoId);
          const prevNotifications = prevSessionNotifications.get(demoId);
          if (prevBoard) sessionBoards.set(demoId, prevBoard);
          else sessionBoards.delete(demoId);
          if (prevBoardRowStatuses) sessionBoardRowStatuses.set(demoId, prevBoardRowStatuses);
          else sessionBoardRowStatuses.delete(demoId);
          if (prevNotifications) sessionNotifications.set(demoId, prevNotifications);
          else sessionNotifications.delete(demoId);
          if (prevAttentionRecords) sessionAttentionRecords.set(demoId, prevAttentionRecords);
          else sessionAttentionRecords.delete(demoId);
          if (prevCompletedBoard) sessionCompletedBoards.set(demoId, prevCompletedBoard);
          else sessionCompletedBoards.delete(demoId);
          if (prevPendingCodex) pendingCodexInputs.set(demoId, prevPendingCodex);
          else pendingCodexInputs.delete(demoId);
          if (prevPendingUserUpload) pendingUserUploads.set(demoId, prevPendingUserUpload);
          else pendingUserUploads.delete(demoId);
          if (prevPendingUserUploadRestoration) {
            pendingUserUploadRestorations.set(demoId, prevPendingUserUploadRestoration);
          } else pendingUserUploadRestorations.delete(demoId);
          if (prevSessionToolProgress) toolProgress.set(demoId, prevSessionToolProgress);
          else toolProgress.delete(demoId);
          if (prevSessionToolResults) toolResults.set(demoId, prevSessionToolResults);
          else toolResults.delete(demoId);
          if (prevSessionToolStarts) toolStartTimestamps.set(demoId, prevSessionToolStarts);
          else toolStartTimestamps.delete(demoId);
        }
        for (const timerDemoId of sidebarTimerDemoIds) {
          const prevTimers = prevSessionTimers.get(timerDemoId);
          if (prevTimers) sessionTimers.set(timerDemoId, prevTimers);
          else sessionTimers.delete(timerDemoId);
        }
        return {
          sessions,
          messages,
          historyWindows,
          threadWindows,
          threadWindowMessages,
          pendingPermissions,
          connectionStatus,
          cliConnected,
          cliEverConnected,
          cliDisconnectReason,
          sessionStatus,
          activeTurnRoutes,
          streaming,
          streamingStartedAt,
          streamingOutputTokens,
          feedScrollPosition,
          historyLoading,
          sessionBoards,
          sessionBoardRowStatuses,
          sessionCompletedBoards,
          sessionNotifications,
          sessionAttentionRecords,
          pendingCodexInputs,
          pendingUserUploads,
          pendingUserUploadRestorations,
          sessionTimers,
          toolProgress,
          toolResults,
          toolStartTimestamps,
        };
      });
    };
  }, []);
}
