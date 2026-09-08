import type { FeedEntry, Turn } from "../../hooks/use-feed-model.js";
import type { ThreadResponsePresentation } from "../thread-response-presentation.js";
import { FeedEntries } from "../MessageFeedEntries.js";
import { ReadyThreadResponseRows } from "../ReadyThreadResponseRows.js";
import { TurnToggleFooter } from "../CollapseFooter.js";
import { Card, PlaygroundSectionGroup, Section } from "./shared.js";

const SESSION_ID = "playground-thread-responses";

function assistantEntry(
  id: string,
  content: string,
  leaderThreadRole?: "commentary" | "answer" | "response",
): Extract<FeedEntry, { kind: "message" }> {
  return {
    kind: "message",
    msg: {
      id,
      role: "assistant",
      content,
      timestamp: 1,
      metadata: {
        leaderThreadRole,
        ...(leaderThreadRole === "answer"
          ? { threadAnswer: { version: 2 as const, answerUserMessageIds: ["u1", "u2"], observedHistoryLength: 7 } }
          : {}),
      },
    },
  };
}

const GROUPED_COVERED_USER_MESSAGES = [
  {
    historyMessageId: "playground-user-first",
    userMessageId: "u1",
    content: "Please foreground the polished result when this work is ready.",
  },
  {
    historyMessageId: "playground-user-second",
    userMessageId: "u2",
    content: "Please include the mobile behavior too.",
  },
] as const;

const CURRENT_RESPONSE = assistantEntry(
  "playground-response-current",
  "The later answer adds the final mobile result without compressing the detailed answer above it.",
  "answer",
);
const EARLIER_RESPONSE = assistantEntry(
  "playground-response-earlier",
  "The responsive feed now keeps this detailed accepted-Work answer visible for both requests, including the reasoning and remaining uncertainty.",
  "answer",
);
const INTERMEDIATE = assistantEntry(
  "playground-response-intermediate",
  "Intermediate investigation detail that belongs only in expanded chronology.",
  "commentary",
);
const READY_TURN: Turn = {
  id: "playground-user-second",
  userEntry: {
    kind: "message",
    msg: {
      id: "playground-user-second",
      role: "user",
      content: "Please include the mobile behavior too.",
      timestamp: 1,
    },
  },
  allEntries: [EARLIER_RESPONSE, INTERMEDIATE, CURRENT_RESPONSE],
  presentationEntries: [EARLIER_RESPONSE, INTERMEDIATE, CURRENT_RESPONSE],
  agentEntries: [INTERMEDIATE],
  systemEntries: [],
  notificationEntries: [EARLIER_RESPONSE, CURRENT_RESPONSE],
  responseEntry: null,
  subConclusions: [],
  collapsedEntries: [],
  stats: { messageCount: 1, toolCount: 2, subagentCount: 1, herdEventCount: 0 },
};
const PRESENTATION: ThreadResponsePresentation = {
  ready: true,
  cutoverHistoryIndex: 0,
  pendingMessageCount: 0,
  currentResponses: [
    {
      response: {
        version: 2,
        threadKey: "q-2042",
        questId: "q-2042",
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["playground-user-first", "playground-user-second"],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
        currentMessageId: EARLIER_RESPONSE.msg.id,
        currentHistoryIndex: 6,
        createdAt: 6,
        updatedAt: 6,
        source: "explicit",
      },
      anchorUserMessageId: "playground-user-second",
      anchorTurnId: READY_TURN.id,
      anchorOrder: 1,
      sourceTurnId: READY_TURN.id,
      messageEntry: EARLIER_RESPONSE,
      collapsedMessageEntry: EARLIER_RESPONSE,
      referencedUserMessages: GROUPED_COVERED_USER_MESSAGES,
    },
    {
      response: {
        version: 2,
        threadKey: "q-2042",
        questId: "q-2042",
        answerUserMessageIds: ["u1", "u2"],
        referencedUserMessageIds: ["playground-user-first", "playground-user-second"],
        coveredAnswerUserMessageIds: ["u1", "u2"],
        coveredUserMessageIds: ["playground-user-first", "playground-user-second"],
        currentMessageId: CURRENT_RESPONSE.msg.id,
        currentHistoryIndex: 7,
        createdAt: 7,
        updatedAt: 7,
        source: "explicit",
      },
      anchorUserMessageId: "playground-user-second",
      anchorTurnId: READY_TURN.id,
      anchorOrder: 1,
      sourceTurnId: READY_TURN.id,
      messageEntry: CURRENT_RESPONSE,
      collapsedMessageEntry: CURRENT_RESPONSE,
      referencedUserMessages: GROUPED_COVERED_USER_MESSAGES,
    },
  ],
  currentResponseMessageIds: new Set([EARLIER_RESPONSE.msg.id, CURRENT_RESPONSE.msg.id]),
  quizGroups: [{ hostTurnId: READY_TURN.id, questIds: ["q-8"] }],
  layoutSignature: "playground-response-r2",
};
const ACTIVE_PRESENTATION: ThreadResponsePresentation = {
  ...PRESENTATION,
  ready: false,
  pendingMessageCount: 1,
  layoutSignature: "playground-response-r2-pending",
};
const ANSWER_ONLY_RESPONSE = assistantEntry(
  "playground-answer-only-response",
  "The answer remains visible while the lightweight footer provides the only expansion action.",
  "answer",
);
const ANSWER_ONLY_TURN: Turn = {
  id: "playground-answer-only-user",
  userEntry: {
    kind: "message",
    msg: {
      id: "playground-answer-only-user",
      role: "user",
      content: "Show the answer-only collapsed state.",
      timestamp: 1,
    },
  },
  allEntries: [ANSWER_ONLY_RESPONSE],
  presentationEntries: [ANSWER_ONLY_RESPONSE],
  agentEntries: [],
  systemEntries: [],
  notificationEntries: [ANSWER_ONLY_RESPONSE],
  responseEntry: ANSWER_ONLY_RESPONSE,
  subConclusions: [],
  collapsedEntries: [{ kind: "entry", key: "entry:playground-answer-only-response", entry: ANSWER_ONLY_RESPONSE }],
  stats: { messageCount: 0, toolCount: 0, subagentCount: 0, herdEventCount: 0 },
};
const ANSWER_ONLY_PRESENTATION: ThreadResponsePresentation = {
  ...PRESENTATION,
  currentResponses: [
    {
      response: {
        ...PRESENTATION.currentResponses[0]!.response,
        answerUserMessageIds: ["u3"],
        referencedUserMessageIds: [ANSWER_ONLY_TURN.id],
        coveredAnswerUserMessageIds: ["u3"],
        coveredUserMessageIds: [ANSWER_ONLY_TURN.id],
        currentMessageId: ANSWER_ONLY_RESPONSE.msg.id,
      },
      anchorUserMessageId: ANSWER_ONLY_TURN.id,
      anchorTurnId: ANSWER_ONLY_TURN.id,
      anchorOrder: 0,
      sourceTurnId: ANSWER_ONLY_TURN.id,
      messageEntry: ANSWER_ONLY_RESPONSE,
      collapsedMessageEntry: ANSWER_ONLY_RESPONSE,
      referencedUserMessages: [
        {
          historyMessageId: ANSWER_ONLY_TURN.id,
          userMessageId: "u3",
          content: "Show the answer-only collapsed state.",
        },
      ],
    },
  ],
  currentResponseMessageIds: new Set([ANSWER_ONLY_RESPONSE.msg.id]),
  quizGroups: [],
  layoutSignature: "playground-answer-only-r1",
};
const ASSOCIATED_MAIN_RESPONSE_BASE = assistantEntry(
  "playground-associated-main-answer",
  "This Main answer remains visible here because its covered request is associated with this quest.",
  "answer",
);
const ASSOCIATED_MAIN_RESPONSE: Extract<FeedEntry, { kind: "message" }> = {
  ...ASSOCIATED_MAIN_RESPONSE_BASE,
  msg: {
    ...ASSOCIATED_MAIN_RESPONSE_BASE.msg,
    metadata: {
      leaderThreadRole: "answer",
      threadKey: "main",
      threadAnswer: { version: 2, answerUserMessageIds: ["u25"], observedHistoryLength: 25 },
    },
  },
};
const ASSOCIATED_MAIN_TURN: Turn = {
  id: "playground-associated-main-user",
  userEntry: {
    kind: "message",
    msg: {
      id: "playground-associated-main-user",
      role: "user",
      content: "Main request attached to this quest.",
      timestamp: 1,
      metadata: {
        leaderResponseCoverageVersion: 1,
        leaderUserMessageId: "u25",
        threadKey: "main",
        threadRefs: [{ threadKey: "q-2042", questId: "q-2042", source: "backfill" }],
      },
    },
  },
  allEntries: [ASSOCIATED_MAIN_RESPONSE],
  presentationEntries: [ASSOCIATED_MAIN_RESPONSE],
  agentEntries: [],
  systemEntries: [],
  notificationEntries: [ASSOCIATED_MAIN_RESPONSE],
  responseEntry: ASSOCIATED_MAIN_RESPONSE,
  subConclusions: [],
  collapsedEntries: [
    { kind: "entry", key: "entry:playground-associated-main-answer", entry: ASSOCIATED_MAIN_RESPONSE },
  ],
  stats: { messageCount: 0, toolCount: 1, subagentCount: 0, herdEventCount: 0 },
};
const ASSOCIATED_MAIN_PRESENTATION: ThreadResponsePresentation = {
  ...PRESENTATION,
  currentResponses: [
    {
      response: {
        version: 2,
        threadKey: "main",
        answerUserMessageIds: ["u25"],
        referencedUserMessageIds: [ASSOCIATED_MAIN_TURN.id],
        coveredAnswerUserMessageIds: [],
        coveredUserMessageIds: [],
        currentMessageId: ASSOCIATED_MAIN_RESPONSE.msg.id,
        currentHistoryIndex: 25,
        createdAt: 25,
        updatedAt: 25,
        source: "explicit",
      },
      anchorUserMessageId: ASSOCIATED_MAIN_TURN.id,
      anchorTurnId: ASSOCIATED_MAIN_TURN.id,
      anchorOrder: 0,
      sourceTurnId: ASSOCIATED_MAIN_TURN.id,
      messageEntry: ASSOCIATED_MAIN_RESPONSE,
      collapsedMessageEntry: ASSOCIATED_MAIN_RESPONSE,
      referencedUserMessages: [
        {
          historyMessageId: ASSOCIATED_MAIN_TURN.id,
          userMessageId: "u25",
          content: "Main request attached to this quest.",
        },
      ],
    },
  ],
  currentResponseMessageIds: new Set([ASSOCIATED_MAIN_RESPONSE.msg.id]),
  quizGroups: [],
  layoutSignature: "playground-associated-main-answer",
};

const MULTI_OWNER_RESPONSE: Extract<FeedEntry, { kind: "message" }> = {
  ...ASSOCIATED_MAIN_RESPONSE,
  msg: {
    ...ASSOCIATED_MAIN_RESPONSE.msg,
    id: "playground-shared-answer",
    content:
      "The shared answer covers both the Main request and this quest's request. Each tab keeps its own remaining questions.",
    metadata: {
      ...ASSOCIATED_MAIN_RESPONSE.msg.metadata,
      threadAnswer: {
        version: 2,
        answerUserMessageIds: ["u25", "u26"],
        observedHistoryLength: 26,
        authoredThreadKey: "q-2042",
        ownerGroups: [
          { threadKey: "main", userMessageIds: ["u25"] },
          { threadKey: "q-2042", userMessageIds: ["u26"] },
        ],
      },
    },
  },
};
const MULTI_OWNER_TURN: Turn = {
  ...ASSOCIATED_MAIN_TURN,
  id: "playground-shared-quest-user",
  allEntries: [MULTI_OWNER_RESPONSE],
  presentationEntries: [MULTI_OWNER_RESPONSE],
  notificationEntries: [MULTI_OWNER_RESPONSE],
  responseEntry: MULTI_OWNER_RESPONSE,
};
const MULTI_OWNER_PRESENTATION: ThreadResponsePresentation = {
  ...ASSOCIATED_MAIN_PRESENTATION,
  currentResponses: [
    {
      ...ASSOCIATED_MAIN_PRESENTATION.currentResponses[0]!,
      response: {
        ...ASSOCIATED_MAIN_PRESENTATION.currentResponses[0]!.response,
        answerUserMessageIds: ["u25", "u26"],
        referencedUserMessageIds: [ASSOCIATED_MAIN_TURN.id, MULTI_OWNER_TURN.id],
        coveredAnswerUserMessageIds: ["u26"],
        coveredUserMessageIds: [MULTI_OWNER_TURN.id],
        currentMessageId: MULTI_OWNER_RESPONSE.msg.id,
      },
      anchorUserMessageId: MULTI_OWNER_TURN.id,
      anchorTurnId: MULTI_OWNER_TURN.id,
      sourceTurnId: MULTI_OWNER_TURN.id,
      messageEntry: MULTI_OWNER_RESPONSE,
      collapsedMessageEntry: MULTI_OWNER_RESPONSE,
      referencedUserMessages: [
        { historyMessageId: ASSOCIATED_MAIN_TURN.id, userMessageId: "u25", content: "Please handle my Main request." },
        {
          historyMessageId: MULTI_OWNER_TURN.id,
          userMessageId: "u26",
          content: "Please include this quest's request in the same answer.",
        },
      ],
    },
  ],
  currentResponseMessageIds: new Set([MULTI_OWNER_RESPONSE.msg.id]),
  layoutSignature: "playground-shared-answer",
};

const NOOP = () => {};

function renderEntry(entry: FeedEntry) {
  return (
    <FeedEntries
      entries={[entry]}
      sessionId={SESSION_ID}
      currentThreadKey="q-2042"
      isCodexSession={false}
      activeCodexTerminalIds={new Set()}
      onOpenCodexTerminal={NOOP}
      questLinkSurface="chat-feed"
    />
  );
}

export function PlaygroundThreadResponseSection() {
  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Routed Answers"
        description="Every valid routed answer remains visible in source chronology with its original coverage preview; later answers add or correct substance, Ready controls whole-thread collapse, and expanded history preserves all commentary and answer rows."
      >
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <Card label="Collapsed Ready · chronological answer set plus Quiz">
            <div
              className="min-w-0 max-w-[430px] overflow-hidden rounded-xl border border-cc-border/30 bg-cc-card/20"
              data-testid="playground-unified-footer-with-tools"
            >
              <ReadyThreadResponseRows
                turn={READY_TURN}
                presentation={PRESENTATION}
                renderEntry={renderEntry}
                sessionId={SESSION_ID}
                questLinkSurface="chat-feed"
              />
              <TurnToggleFooter expanded={false} onToggle={NOOP} toolCount={READY_TURN.stats.toolCount} />
            </div>
          </Card>
          <Card label="Collapsed answer only · no hidden tools">
            <div
              className="min-w-0 w-full max-w-[320px] overflow-hidden rounded-xl border border-cc-border/30 bg-cc-card/20"
              data-testid="playground-unified-footer-without-tools"
            >
              <ReadyThreadResponseRows
                turn={ANSWER_ONLY_TURN}
                presentation={ANSWER_ONLY_PRESENTATION}
                renderEntry={renderEntry}
                sessionId={SESSION_ID}
                questLinkSurface="chat-feed"
              />
              <TurnToggleFooter expanded={false} onToggle={NOOP} />
            </div>
          </Card>
          <Card label="Collapsed quest projection · associated Main answer">
            <div
              className="min-w-0 w-full max-w-[430px] overflow-hidden rounded-xl border border-cc-border/30 bg-cc-card/20"
              data-testid="playground-associated-main-answer"
            >
              <ReadyThreadResponseRows
                turn={ASSOCIATED_MAIN_TURN}
                presentation={ASSOCIATED_MAIN_PRESENTATION}
                renderEntry={renderEntry}
                sessionId={SESSION_ID}
                questLinkSurface="chat-feed"
              />
              <TurnToggleFooter expanded={false} onToggle={NOOP} toolCount={ASSOCIATED_MAIN_TURN.stats.toolCount} />
            </div>
          </Card>
          <Card label="Expanded active thread · complete chronology">
            <div
              className="min-w-0 max-w-[430px] space-y-3 rounded-xl border border-cc-border/30 bg-cc-card/20 p-3"
              data-testid="playground-unified-footer-expanded"
            >
              <FeedEntries
                entries={[
                  assistantEntry("playground-response-old", "Earlier answer wording for the same requests.", "answer"),
                  INTERMEDIATE,
                  CURRENT_RESPONSE,
                ]}
                sessionId={SESSION_ID}
                currentThreadKey="q-2042"
                isCodexSession={false}
                activeCodexTerminalIds={new Set()}
                onOpenCodexTerminal={NOOP}
                questLinkSurface="chat-feed"
                threadResponsePresentation={ACTIVE_PRESENTATION}
              />
              <TurnToggleFooter expanded onToggle={NOOP} />
            </div>
          </Card>
          <Card label="One answer · Main and quest requests">
            <div
              className="min-w-0 w-full max-w-[430px] rounded-xl border border-cc-border/30 bg-cc-card/20"
              data-testid="playground-multi-owner-answer"
            >
              <ReadyThreadResponseRows
                turn={MULTI_OWNER_TURN}
                presentation={MULTI_OWNER_PRESENTATION}
                renderEntry={renderEntry}
                sessionId={SESSION_ID}
                questLinkSurface="chat-feed"
              />
              <TurnToggleFooter expanded={false} onToggle={NOOP} />
            </div>
          </Card>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
