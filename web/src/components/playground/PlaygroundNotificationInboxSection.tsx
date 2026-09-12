import { NotificationChip } from "../NotificationChip.js";
import { PlaygroundNotifyMe } from "./PlaygroundNotifyMe.js";
import { GlobalNeedsInputMenu } from "../GlobalNeedsInputMenu.js";
import { MessageFeed } from "../MessageFeed.js";
import { TimerChip } from "../TimerWidget.js";
import { useStore } from "../../store.js";
import type { ChatMessage, LeaderThreadResponseProjection } from "../../types.js";
import { Card, Section } from "./shared.js";

function seedNotificationData() {
  const now = Date.now();
  useStore.setState({
    sessionNotifications: new Map([
      [
        "playground-notifs",
        [
          {
            id: "n-1",
            category: "review" as const,
            summary: "q-235 ready for review: Compact notification inbox copy",
            timestamp: now - 600_000,
            messageId: "mock-msg-42",
            done: false,
          },
          {
            id: "n-2",
            category: "needs-input" as const,
            summary: "Choose image transport and validation path",
            questions: [
              {
                prompt: "Should we use JPEG q85 or q75 for the transport tier?",
                suggestedAnswers: ["q85", "q75"],
              },
              {
                prompt: "Run browser validation in Execute?",
                suggestedAnswers: ["yes", "no"],
              },
              {
                prompt:
                  "Add any reviewer context or rollout caveats that should travel with this answer. This is intentionally long enough to exercise the auto-expanding custom answer field.",
              },
            ],
            timestamp: now - 120_000,
            messageId: "mock-msg-87",
            done: false,
          },
          {
            id: "n-3",
            category: "waiting" as const,
            summary: "Waiting on reviewer handoff",
            timestamp: now - 300_000,
            messageId: "mock-msg-31",
            done: false,
          },
          {
            id: "n-4",
            category: "review" as const,
            summary: "Port to main repo completed successfully",
            timestamp: now - 3_600_000,
            messageId: "mock-msg-15",
            done: true,
          },
          {
            id: "n-5",
            category: "needs-input" as const,
            summary: "Deferred token rotation approval",
            questions: [
              {
                prompt: "Rotate now or keep muted until the Execute window?",
                suggestedAnswers: ["rotate now", "keep muted"],
              },
            ],
            timestamp: now - 4_200_000,
            messageId: "mock-msg-muted",
            done: false,
            muted: true,
          },
        ],
      ],
    ]),
    messages: new Map([
      [
        "playground-notifs",
        [
          {
            id: "mock-msg-87",
            role: "assistant" as const,
            content:
              "**Image transport decision**\n\n- JPEG q85 keeps dense UI text readable for reviewers.\n- JPEG q75 cuts upload size, but can blur mobile screenshots.\n- Browser validation should include the narrow approval path before Execute signs off.",
            timestamp: now - 130_000,
          },
        ],
      ],
    ]),
  });
}

function seedSummaryOnlyNeedsInput() {
  const now = Date.now();
  useStore.setState({
    sessionNotifications: new Map([
      [
        "playground-notifs",
        [
          {
            id: "stale-review",
            category: "review" as const,
            summary: "Older review cached locally",
            timestamp: now - 300_000,
            messageId: "mock-msg-stale",
            done: false,
          },
        ],
      ],
    ]),
  });
  useStore.getState().setSdkSessions([
    {
      sessionId: "playground-notifs",
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      archived: false,
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
      activeNeedsInputNotificationCount: 1,
      activeReviewNotificationCount: 0,
      notificationStatusVersion: 2,
      notificationStatusUpdatedAt: now,
    },
  ]);
}

function seedGlobalNeedsInputData() {
  const now = Date.now();
  useStore.setState({
    sessionNotifications: new Map([
      [
        "global-needs-input-leader",
        [
          {
            id: "n-1",
            category: "needs-input" as const,
            summary: "Choose the worker handoff path",
            suggestedAnswers: ["dispatch now", "wait for review"],
            timestamp: now - 90_000,
            messageId: "global-msg-1",
            done: false,
          },
        ],
      ],
      [
        "global-needs-input-worker",
        [
          {
            id: "n-2",
            category: "needs-input" as const,
            summary: "Confirm validation coverage",
            questions: [
              { prompt: "Run browser validation?", suggestedAnswers: ["yes", "no"] },
              { prompt: "Include mobile viewport?", suggestedAnswers: ["yes", "desktop only"] },
            ],
            timestamp: now - 30_000,
            messageId: "global-msg-2",
            done: false,
          },
          {
            id: "n-3",
            category: "needs-input" as const,
            summary: "Deferred rollout approval",
            timestamp: now - 3_600_000,
            messageId: "global-msg-muted",
            done: false,
            muted: true,
          },
          {
            id: "n-4",
            category: "review" as const,
            summary: "Review-only item excluded from global needs-input",
            timestamp: now - 15_000,
            messageId: "global-msg-review",
            done: false,
          },
        ],
      ],
    ]),
    messages: new Map([
      [
        "global-needs-input-leader",
        [
          {
            id: "global-msg-1",
            role: "assistant" as const,
            content:
              "**Worker handoff options**\n\n- Dispatch now if the reviewer only needs a scope pass.\n- Wait for review if the implementation direction could still change.\n- Keep the needs-input answer short enough to route cleanly.",
            timestamp: now - 100_000,
          },
        ],
      ],
      [
        "global-needs-input-worker",
        [
          {
            id: "global-msg-2",
            role: "assistant" as const,
            content:
              "**Validation coverage**\n\nInclude the desktop operator view plus the mobile approval path, because the notification panel sits close to feed controls on narrow screens.\n\n[q-1276](quest:q-1276) already covered source-message navigation.",
            timestamp: now - 45_000,
          },
        ],
      ],
    ]),
  });
  useStore.getState().setSdkSessions([
    {
      sessionId: "global-needs-input-leader",
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      sessionNum: 401,
      name: "Leader",
    },
    {
      sessionId: "global-needs-input-worker",
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      sessionNum: 402,
      name: "Worker",
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
      activeNeedsInputNotificationCount: 1,
      mutedNeedsInputNotificationCount: 1,
    },
  ]);
}

const COLLAPSED_PROMPT_SESSION_ID = "playground-collapsed-needs-input";
const COLLAPSED_PROMPT_THREAD_KEY = "q-9004";

function seedCollapsedAnswerNeedsInputPrompt() {
  const now = Date.now();
  const route = {
    threadKey: COLLAPSED_PROMPT_THREAD_KEY,
    questId: COLLAPSED_PROMPT_THREAD_KEY,
    source: "explicit" as const,
  };
  const messages: ChatMessage[] = [
    {
      id: "playground-collapsed-pending-user",
      role: "user",
      content: "Prepare the rollout and stop for my final environment choice.",
      timestamp: now - 60_000,
      historyIndex: 0,
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u1",
      },
    },
    {
      id: "playground-collapsed-answered-user",
      role: "user",
      content: "Also confirm which checks already passed.",
      timestamp: now - 50_000,
      historyIndex: 1,
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u2",
      },
    },
    {
      id: "playground-collapsed-answer",
      role: "assistant",
      content: "The rollout preparation is complete and the remaining implementation evidence is verified.",
      timestamp: now - 40_000,
      historyIndex: 2,
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderThreadRole: "answer",
        threadAnswer: { version: 2, answerUserMessageIds: ["u2"], observedHistoryLength: 2 },
      },
    },
    {
      id: "playground-collapsed-prompt",
      role: "assistant",
      content:
        "**Choose the final rollout boundary**\n\n- **Staged:** validate with the internal cohort first.\n- **Direct:** publish immediately after the current checks.\n\nReply with the option you want and any timing constraint.",
      timestamp: now - 30_000,
      historyIndex: 3,
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderThreadRole: "commentary",
      },
    },
    {
      id: "playground-collapsed-tool",
      role: "assistant",
      content: "",
      timestamp: now - 20_000,
      historyIndex: 4,
      contentBlocks: [
        {
          type: "tool_use",
          id: "playground-collapsed-notify-tool",
          name: "Bash",
          input: { command: 'takode notify needs-input "Choose final rollout boundary"' },
        },
      ],
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderThreadRole: "commentary",
      },
    },
    {
      id: "playground-collapsed-quiz",
      role: "assistant",
      content: `{[(Quest Quiz: ${COLLAPSED_PROMPT_THREAD_KEY})]}`,
      timestamp: now - 10_000,
      historyIndex: 5,
      metadata: {
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        threadRefs: [route],
        leaderThreadRole: "commentary",
      },
    },
  ];
  const responseState: LeaderThreadResponseProjection = {
    version: 2,
    threadKey: COLLAPSED_PROMPT_THREAD_KEY,
    cutoverHistoryIndex: 0,
    pendingMessageCount: 1,
    pendingMessages: [
      {
        userMessageId: "u1",
        historyMessageId: "playground-collapsed-pending-user",
        historyIndex: 0,
        askedAt: now - 60_000,
      },
    ],
    ready: false,
    currentAnswers: [
      {
        version: 2,
        threadKey: COLLAPSED_PROMPT_THREAD_KEY,
        questId: COLLAPSED_PROMPT_THREAD_KEY,
        answerUserMessageIds: ["u2"],
        referencedUserMessageIds: ["playground-collapsed-answered-user"],
        coveredAnswerUserMessageIds: ["u2"],
        coveredUserMessageIds: ["playground-collapsed-answered-user"],
        currentMessageId: "playground-collapsed-answer",
        currentHistoryIndex: 2,
        createdAt: now - 40_000,
        updatedAt: now - 40_000,
        source: "explicit",
      },
    ],
  };
  const store = useStore.getState();
  store.setSdkSessions([
    ...store.sdkSessions.filter((session) => session.sessionId !== COLLAPSED_PROMPT_SESSION_ID),
    {
      sessionId: COLLAPSED_PROMPT_SESSION_ID,
      state: "connected",
      cwd: "/playground",
      createdAt: now,
      archived: false,
      isOrchestrator: true,
      name: "Collapsed prompt leader",
    },
  ]);
  store.setMessages(COLLAPSED_PROMPT_SESSION_ID, messages);
  store.setThreadWindow(
    COLLAPSED_PROMPT_SESSION_ID,
    COLLAPSED_PROMPT_THREAD_KEY,
    {
      thread_key: COLLAPSED_PROMPT_THREAD_KEY,
      from_item: 0,
      item_count: messages.length,
      total_items: messages.length,
      has_older_items: false,
      has_newer_items: false,
      source_history_length: messages.length,
      section_item_count: 10,
      visible_item_count: messages.length,
    },
    messages,
    responseState,
  );
  store.setSessionNotifications(COLLAPSED_PROMPT_SESSION_ID, [
    {
      id: "playground-collapsed-needs-input",
      category: "needs-input",
      summary: "Choose final rollout boundary",
      suggestedAnswers: ["Staged", "Direct"],
      timestamp: now - 25_000,
      messageId: "playground-collapsed-prompt",
      threadKey: COLLAPSED_PROMPT_THREAD_KEY,
      questId: COLLAPSED_PROMPT_THREAD_KEY,
      done: false,
    },
  ]);
  store.collapseAllTurnActivity(COLLAPSED_PROMPT_SESSION_ID, ["playground-collapsed-answered-user"]);
}

function seedOwnerThreadNeedsInputPanel() {
  const now = Date.now();
  useStore.setState({
    messages: new Map([["playground-owner-needs-input", []]]),
    sessionNotifications: new Map([
      [
        "playground-owner-needs-input",
        [
          {
            id: "n-owner-panel",
            category: "needs-input" as const,
            summary: "Choose q-1793 decision-panel fallback",
            questions: [
              {
                prompt: "Which owner-thread fallback should render while the source message is unavailable?",
                suggestedAnswers: ["Show decision panel", "Retry detail load", "Keep abstract chip"],
              },
            ],
            timestamp: now - 45_000,
            messageId: null,
            threadKey: "q-1793",
            questId: "q-1793",
            done: false,
          },
        ],
      ],
    ]),
  });
}

export function PlaygroundNotificationInboxSection() {
  return (
    <Section
      title="Notification Inbox"
      description="Per-session notification inbox for takode notify events. Chip + modal with active/done sections."
    >
      <div className="max-w-3xl space-y-4">
        <PlaygroundNotifyMe />
        <Card label="Notification chip (floating pill)">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedNotificationData}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-info-border bg-cc-info-bg hover:bg-cc-info-bg/80 text-cc-info transition-colors cursor-pointer"
            >
              Seed notification data
            </button>
            <button
              type="button"
              onClick={seedSummaryOnlyNeedsInput}
              className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed summary-only needs-input
            </button>
            <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
              <div className="absolute bottom-2 right-2">
                <NotificationChip sessionId="playground-notifs" />
              </div>
            </div>
            <p className="text-[10px] text-cc-muted">
              Click &quot;Seed notification data&quot; first. The lower-right inbox shows needs-input rows with one
              prompt title, explicit Go to and Mute/Unmute row actions, expandable source context, direct Send Response
              controls, voice-enabled long-answer fields, a muted backlog, and a collapsible Done section. Active review
              notifications stay out of this panel because blue review status is represented on thread tabs.
            </p>
          </div>
        </Card>

        <Card label="Global top-bar needs-input aggregate">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedGlobalNeedsInputData}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed global needs-input data
            </button>
            <div className="flex h-16 items-start justify-end rounded-lg border border-cc-border bg-cc-bg p-3">
              <GlobalNeedsInputMenu />
            </div>
            <p className="text-[10px] text-cc-muted">
              Shows the top-bar aggregate for unresolved needs-input notifications, with quiet source-context navigation
              and review or unread-style activity excluded. Muted prompts appear as a secondary backlog.
            </p>
          </div>
        </Card>

        <Card label="Collapsed answer with unresolved prompt">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedCollapsedAnswerNeedsInputPrompt}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed collapsed prompt
            </button>
            <div className="h-96 overflow-hidden rounded-lg border border-cc-border bg-cc-bg">
              <MessageFeed sessionId={COLLAPSED_PROMPT_SESSION_ID} threadKey={COLLAPSED_PROMPT_THREAD_KEY} />
            </div>
            <p className="text-[10px] text-cc-muted">
              A collapsed response turn keeps the one answer-coverage chip, the complete unresolved decision prompt and
              its amber reply card, the actual-turn Quiz, and one unified expansion footer. Resolving the notification
              releases the prompt from this special collapsed slot.
            </p>
          </div>
        </Card>

        <Card label="Owner-thread needs-input decision row">
          <div className="p-3 space-y-2">
            <button
              type="button"
              onClick={seedOwnerThreadNeedsInputPanel}
              className="text-xs font-medium px-3 py-1.5 rounded-md border border-cc-attention-border bg-cc-attention-bg hover:bg-cc-attention-bg/80 text-cc-attention transition-colors cursor-pointer"
            >
              Seed owner-thread panel
            </button>
            <div className="h-72 overflow-hidden rounded-lg border border-cc-border bg-cc-bg">
              <MessageFeed sessionId="playground-owner-needs-input" threadKey="q-1793" />
            </div>
            <p className="text-[10px] text-cc-muted">
              Owner quest threads render the full needs-input decision panel for unanchored or stale-anchor
              notifications, preserving suggested answers, custom response, voice control, and Reply.
            </p>
          </div>
        </Card>

        <Card label="Combined chips (same-line layout)">
          <div className="p-3 space-y-2">
            <p className="text-[10px] text-cc-muted mb-2">
              Seed both timer and notification data above, then see them side-by-side as they appear in the feed.
            </p>
            <div className="relative h-24 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
              <div className="pointer-events-none absolute bottom-2 right-2 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3">
                <TimerChip sessionId="playground-timers" />
                <NotificationChip sessionId="playground-notifs" />
              </div>
            </div>
            <p className="text-[10px] text-cc-muted">
              Timer chip on the left, needs-input notification chip on the right -- mirrors FeedStatusPill layout.
            </p>
          </div>
        </Card>

        <Card label="Mobile nav clearance">
          <div className="p-3 space-y-2">
            <p className="text-[10px] text-cc-muted mb-2">
              On touch layouts, the feed navigation stack should keep all four controls visible, use larger touch
              targets, and float above the lower-right status chips instead of colliding with them.
            </p>
            <div className="relative h-32 rounded-lg border border-cc-border bg-cc-bg overflow-hidden">
              <div className="absolute right-2 flex flex-col gap-2" style={{ bottom: "64px" }}>
                <button
                  type="button"
                  className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                  aria-label="Playground go to top"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                    <path d="M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 12h8" strokeLinecap="round" />
                  </svg>
                </button>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                    aria-label="Playground previous user message"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                      <path d="M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M8 3v10" strokeLinecap="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                    aria-label="Playground next user message"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                      <path d="M4 9l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M8 3v10" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <button
                  type="button"
                  className="h-10 w-10 rounded-full bg-cc-card border border-cc-border shadow-lg flex items-center justify-center text-cc-muted"
                  aria-label="Playground go to bottom"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                    <path d="M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 4h8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="pointer-events-none absolute bottom-2 right-2 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3">
                <TimerChip sessionId="playground-timers" />
                <NotificationChip sessionId="playground-notifs" />
              </div>
            </div>
            <p className="text-[10px] text-cc-muted">
              The mock mirrors the touch feed: previous/next user-message buttons are restored, all four buttons use
              larger 40px targets with wider spacing, and the stack still reserves vertical clearance above the measured
              chip row on mobile.
            </p>
          </div>
        </Card>
      </div>
    </Section>
  );
}
