import { CodexThinkingInline, MessageBubble } from "../MessageBubble.js";
import { SideChatPanel } from "../SideChatPanel.js";
import { DiffViewer } from "../DiffViewer.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { SessionCreationProgress } from "../SessionCreationProgress.js";
import { StepList } from "../SessionCreationView.js";
import { CodexInstructionsCollapsible } from "../TaskPanel.js";
import {
  CatPawAvatar,
  CatPawLeft,
  CatPawRight,
  YarnBallDot,
  YarnBallSpinner,
  SleepingCat,
  PowerPlugDot,
} from "../CatIcons.js";
import { HighlightedText } from "../HighlightedText.js";
import { PawTrailAvatar } from "../PawTrail.js";
import { VoiceLevelWaveform } from "../VoiceRecordingStatus.js";
import { AlternateVoiceRerunOffer } from "../AlternateVoiceRerunOffer.js";
import type { CreationProgressEvent, SideChatRecord } from "../../types.js";
import {
  MOCK_SESSION_ID,
  MOCK_SUBAGENT_TOOL_ITEMS,
  MOCK_TOOL_GROUP_ITEMS,
  PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_DISCONNECTED_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_ERROR_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_GENERATING_CHILD_SESSION_ID,
  PLAYGROUND_SIDE_CHAT_PERMISSION_CHILD_SESSION_ID,
  MSG_ASSISTANT,
} from "./fixtures.js";
import { PlaygroundSideChatStates } from "./SideChatPlaygroundStates.js";
import { PlaygroundSidebarOverflowStates, PlaygroundUniversalSearchStates } from "./search-sidebar-states.js";
import { PlaygroundUserMessageNavigatorSection } from "./PlaygroundUserMessageNavigatorSection.js";
import { PlaygroundHerdEventStates } from "./HerdEventPlaygroundStates.js";
import { PlaygroundCompactToolActivityStates } from "./CompactToolActivityPlaygroundStates.js";
import { PlaygroundTimerMessageStates } from "./TimerMessagePlaygroundStates.js";
import { PlaygroundCodexSubagentStates } from "./CodexSubagentPlaygroundStates.js";
import { PlaygroundDiffViewerSection } from "./DiffViewerPlaygroundSection.js";
import { CompactToolMessageGroups } from "../ToolMessageGroup.js";
import {
  Card,
  PlaygroundClaudeMdButton,
  PlaygroundFolderPicker,
  PlaygroundSectionGroup,
  PlaygroundSelectionContextMenu,
  PlaygroundDelegateTaskGroup,
  PlaygroundDelegateTaskPendingLiveActivityGroup,
  PlaygroundDelegateTaskPendingNoHandoffGroup,
  PlaygroundSubagentGroup,
  PlaygroundToolGroup,
  Section,
} from "./shared.js";

const PLAYGROUND_VOICE_HISTORY = [0.08, 0.18, 0.35, 0.68, 0.82, 0.44, 0.16, 0.1, 0.28, 0.58, 0.72, 0.24];

function PlaygroundVoiceHistory() {
  const volumeHistory = PLAYGROUND_VOICE_HISTORY.map((level, index) => ({ time: index, level }));
  return <VoiceLevelWaveform currentLevel={0.64} samples={volumeHistory} />;
}

const PLAYGROUND_FALLBACK_SIDE_CHAT: SideChatRecord = {
  id: "st-playground-fallback",
  rootSessionId: MOCK_SESSION_ID,
  childSessionId: PLAYGROUND_SIDE_CHAT_CHILD_SESSION_ID,
  anchorMessageId: MSG_ASSISTANT.id,
  anchorHistoryIndex: 2,
  anchorPreview: "We can stage the migration instead of replacing auth in one pass.",
  createdAt: Date.now() - 30_000,
  updatedAt: Date.now() - 8_000,
  messageCount: 2,
  lastMessagePreview: "Use a feature flag and keep session cookie validation until parity tests pass.",
  seeded: true,
  contextStrategy: "bounded-replay" as const,
  contextFallbackReason: "Codex native fork skipped: anchor is not the final assistant message in its Codex turn",
};

const PLAYGROUND_SIDE_CHAT_OPERATIONAL_STATES: Array<{ label: string; sideChat: SideChatRecord }> = [
  {
    label: "Disconnected with queued send",
    sideChat: {
      id: "st-playground-disconnected",
      rootSessionId: MOCK_SESSION_ID,
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
  },
  {
    label: "Generating reply",
    sideChat: {
      id: "st-playground-generating",
      rootSessionId: MOCK_SESSION_ID,
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
  },
  {
    label: "Permission denied",
    sideChat: {
      id: "st-playground-permission",
      rootSessionId: MOCK_SESSION_ID,
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
  },
  {
    label: "Backend error",
    sideChat: {
      id: "st-playground-error",
      rootSessionId: MOCK_SESSION_ID,
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
      contextFallbackReason: "Codex native fork skipped: anchor is not the final assistant message in its Codex turn",
    },
  },
];

export function PlaygroundStateSections() {
  return (
    <PlaygroundSectionGroup groupId="states">
      <Section title="Side Chat" description="Root reply affordance and hidden read-only Side Chat panel">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <Card label="Root assistant reply with action cluster and Side Chat count">
            <div className="space-y-4 border-t border-cc-border bg-cc-card px-4 py-4">
              <MessageBubble message={MSG_ASSISTANT} sessionId={MOCK_SESSION_ID} currentThreadKey="main" />
            </div>
          </Card>
          <Card label="Open read-only Side Chat panel">
            <div className="h-[420px] border-t border-cc-border bg-cc-card">
              <SideChatPanel
                rootSessionId={MOCK_SESSION_ID}
                sideChat={PLAYGROUND_FALLBACK_SIDE_CHAT}
                onClose={() => {}}
              />
            </div>
          </Card>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLAYGROUND_SIDE_CHAT_OPERATIONAL_STATES.map(({ label, sideChat }) => (
            <Card key={sideChat.id} label={label}>
              <div className="h-[360px] border-t border-cc-border bg-cc-card">
                <SideChatPanel rootSessionId={MOCK_SESSION_ID} sideChat={sideChat} onClose={() => {}} />
              </div>
            </Card>
          ))}
        </div>
      </Section>
      <PlaygroundSideChatStates />
      <PlaygroundCodexSubagentStates />

      {/* ─── Composer — Voice Recording ──────────────────────────────── */}
      <Section
        title="Composer — Voice Recording"
        description="Microphone button records audio, server transcribes via Gemini or OpenAI Whisper"
      >
        <div className="max-w-3xl">
          <Card label="Mobile — voice unavailable (idle)">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value="I still need the mic button to stay visible on mobile."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-3 sm:gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted/30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <rect x="3" y="3" width="10" height="10" rx="1" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Mobile — voice unavailable (after tap)">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <div className="px-4 pt-2">
                  <div className="flex items-start gap-2 rounded-lg border border-cc-warning/25 bg-cc-warning/10 px-3 py-2 text-[11px] text-cc-warning">
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                    <span className="flex-1">Voice input requires HTTPS or localhost in this browser.</span>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Tap the disabled mic only when you want the full explanation."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-3 sm:gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted/30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <rect x="3" y="3" width="10" height="10" rx="1" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Mobile collapsed bar while streaming">
            <div className="border-t border-cc-border bg-cc-card py-3 pl-4 pr-6">
              <div className="max-w-3xl mx-auto flex items-center gap-2">
                <div className="flex-1 min-w-0 flex items-center px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-[14px] cursor-text">
                  <span className="flex-1 text-sm text-cc-muted text-left truncate">Type a message...</span>
                </div>
                <div className="flex items-center justify-center w-10 h-10 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer shrink-0">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                    <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="flex items-center justify-center w-10 h-10 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer shrink-0">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-5 h-5">
                    <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                    <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                  </svg>
                </div>
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-cc-error/10 text-cc-error shrink-0">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                    <rect x="3" y="3" width="10" height="10" rx="1" />
                  </svg>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Preparing mic (stream warming)">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Preparing indicator */}
                <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-warning">
                  <span className="w-2 h-2 rounded-full bg-cc-warning animate-pulse" />
                  <span>Preparing mic...</span>
                </div>
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {/* Mic button — preparing state (amber) */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-warning bg-cc-warning/10 cursor-wait">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Recording active">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Recording indicator */}
                <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                  <span>Recording...</span>
                  <PlaygroundVoiceHistory />
                </div>
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {/* Mic button — recording state */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Recording with mode toggle (edit/append)">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Recording indicator with mode toggle */}
                <div
                  data-testid="playground-recording-mode-row-edit"
                  className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary"
                >
                  <div
                    data-testid="playground-recording-mode-toggle-edit"
                    className="flex items-center gap-0.5 rounded-full bg-cc-bg-secondary p-0.5"
                  >
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cc-primary text-white">
                      Edit
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-cc-muted">Append</span>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse shrink-0" />
                  <span className="shrink-0">Recording</span>
                  <PlaygroundVoiceHistory />
                </div>
                <textarea
                  readOnly
                  value="Some existing text in the composer..."
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Recording with mode toggle (append selected)">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Recording indicator with append mode active */}
                <div
                  data-testid="playground-recording-mode-row-append"
                  className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary"
                >
                  <div
                    data-testid="playground-recording-mode-toggle-append"
                    className="flex items-center gap-0.5 rounded-full bg-cc-bg-secondary p-0.5"
                  >
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-cc-muted">Edit</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cc-primary text-white">
                      Append
                    </span>
                  </div>
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse shrink-0" />
                  <span className="shrink-0">Recording</span>
                  <PlaygroundVoiceHistory />
                </div>
                <textarea
                  readOnly
                  value="Some existing text in the composer..."
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 animate-pulse">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Preparing transcript — request in flight">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                  <span>Preparing transcript...</span>
                </div>
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Transcribing — STT in progress">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Transcribing indicator */}
                <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                  <span>Transcribing...</span>
                </div>
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {/* Mic button — disabled during transcription */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Enhancing — LLM enhancement in progress">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                {/* Enhancing indicator — shown after STT completes, during LLM enhancement */}
                <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                  <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                  <span>Enhancing...</span>
                </div>
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-2 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Voice edit preview — explicit accept or undo">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value={"Ship the reconnect fix tonight and add a short rollback note for on-call."}
                  rows={2}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "54px" }}
                />
                <div className="px-4 pb-3 pt-1">
                  <div className="rounded-xl border border-cc-primary/20 bg-cc-primary/5 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-cc-primary">
                          Voice edit preview
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-cc-muted">
                          Apply instruction:{" "}
                          <span className="text-cc-fg">
                            Make this calmer, split it into two sentences, and mention the rollback note at the end.
                          </span>
                        </div>
                      </div>
                      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
                        <button className="rounded-lg border border-cc-border px-3 py-1.5 text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg">
                          Undo
                        </button>
                        <button className="rounded-lg bg-cc-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90">
                          Accept
                        </button>
                      </div>
                    </div>
                    <AlternateVoiceRerunOffer
                      rerun={{
                        resultId: "playground-edit-result",
                        blob: new Blob(["playground voice edit"]),
                        sourceMode: "edit",
                        composerText: "Ship the reconnect fix tonight.",
                        cursorContext: { before: "Ship the reconnect fix tonight.", after: "" },
                        status: "idle",
                      }}
                      onRerun={() => undefined}
                      onDismiss={() => undefined}
                      className="mt-3"
                    />
                    <div className="mt-3 overflow-hidden rounded-lg border border-cc-border bg-cc-bg/80">
                      <DiffViewer
                        oldText="Ship the reconnect fix tonight and add a short rollback note for on-call."
                        newText={
                          "Ship the reconnect fix tonight.\nAdd a short rollback note for on-call so the handoff stays calm and explicit."
                        }
                        mode="compact"
                      />
                    </div>
                    <AlternateVoiceRerunOffer
                      rerun={{
                        resultId: "playground-append-running",
                        blob: new Blob(["playground voice append"]),
                        sourceMode: "append",
                        composerText: "Ship the reconnect fix tonight.",
                        cursorContext: { before: "Ship the reconnect fix tonight.", after: "" },
                        status: "running",
                      }}
                      onRerun={() => undefined}
                      onDismiss={() => undefined}
                      className="mt-3"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted opacity-30">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Transcription failed — retry banner">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  rows={2}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "54px" }}
                  placeholder="Type a message..."
                />
                <div className="px-4 pb-2">
                  <div className="flex items-center gap-2 rounded-lg border border-cc-warning/25 bg-cc-warning/10 px-3 py-2 text-[11px] text-cc-warning">
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                    <span className="flex-1 min-w-0 truncate">
                      Transcription timed out — the server took too long to respond.
                    </span>
                    <button className="shrink-0 rounded-md bg-cc-primary px-2.5 py-1 text-[10px] font-medium text-white hover:bg-cc-primary-hover transition-colors cursor-pointer">
                      Retry
                    </button>
                    <button
                      className="shrink-0 text-cc-warning/70 hover:text-cc-warning transition-colors cursor-pointer"
                      aria-label="Dismiss transcription error"
                      title="Dismiss"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>plan</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full text-cc-muted hover:bg-cc-hover transition-colors">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 opacity-60">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Leader quest tab idle placeholder">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Posting to q-1498 ... (/ for commands, $ for skills/apps, @ for files)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    <span>code</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    {/* Mic button — idle state (muted) */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                        <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-hover text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                        <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                      </svg>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Streaming Indicator ──────────────────────────────── */}
      <Section title="Streaming Indicator" description="Live typing animation shown while the assistant is generating">
        <div className="space-y-4 max-w-3xl">
          <Card label="Codex streaming (complete lines only)">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
              </div>
              <div className="flex-1 min-w-0">
                <MarkdownContent
                  text={"I'll start by creating the JWT utility module with sign and verify helpers.\n"}
                />
                <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle -translate-y-[2px] animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
              </div>
            </div>
          </Card>
          <Card label="Claude streaming (serif)">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
              </div>
              <div className="flex-1 min-w-0">
                <pre className="font-serif-assistant text-[15px] text-cc-fg whitespace-pre-wrap break-words leading-relaxed">
                  I'll start by creating the JWT utility module with sign and verify helpers. Let me first check what
                  dependencies are already installed...
                  <span className="inline-block w-0.5 h-4 bg-cc-primary ml-0.5 align-middle animate-[pulse-dot_0.8s_ease-in-out_infinite]" />
                </pre>
              </div>
            </div>
          </Card>
          <Card label="Codex live thinking">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5 -ml-0.5">
                <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
              </div>
              <div className="flex-1 min-w-0">
                <CodexThinkingInline text="Checking how collapsed subagent turns handle parented reasoning." />
              </div>
            </div>
          </Card>
          <Card label="Generation stats bar">
            <div className="flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code pl-9">
              <YarnBallDot className="text-cc-primary animate-pulse" />
              <span>Generating...</span>
              <span className="text-cc-muted/60">(</span>
              <span>12s</span>
              <span className="text-cc-muted/40">&middot;</span>
              <span>&darr; 1.2k</span>
              <span className="text-cc-muted/60">)</span>
            </div>
          </Card>
        </div>
      </Section>

      <PlaygroundCompactToolActivityStates />

      {/* ─── Tool Message Groups ──────────────────────────────── */}
      <Section
        title="Tool Message Groups"
        description="Compact mixed-tool activity and detailed same-tool groups, each expandable on demand"
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="Compact command activity without a message marker">
            <CompactToolMessageGroups
              groups={[
                {
                  kind: "tool_msg_group",
                  toolName: "Bash",
                  firstId: "compact-commands",
                  items: [
                    { id: "compact-notify-list", name: "Bash", input: { command: "takode notify list" } },
                    { id: "compact-board", name: "Bash", input: { command: "takode board detail q-1777" } },
                    { id: "compact-test", name: "Bash", input: { command: "bun --no-install run test" } },
                  ],
                },
              ]}
              sessionId={MOCK_SESSION_ID}
              isCodexSession={false}
              activeCodexTerminalIds={new Set()}
              onOpenCodexTerminal={() => {}}
            />
          </Card>
          <Card label="Multi-item group (2 Terminal commands)">
            <PlaygroundToolGroup
              toolName="Bash"
              items={[
                {
                  id: "bash-group-1",
                  name: "Bash",
                  input: { command: "test -f /home/demo/.config/takode/settings.json" },
                },
                {
                  id: "bash-group-2",
                  name: "Bash",
                  input: { command: "sed -n '1,80p' /home/demo/.config/takode/settings.json" },
                },
              ]}
            />
          </Card>
          <Card label="Multi-item group (4 Reads)">
            <PlaygroundToolGroup toolName="Read" items={MOCK_TOOL_GROUP_ITEMS} />
          </Card>
          <Card label="Single-item group">
            <PlaygroundToolGroup
              toolName="Glob"
              items={[{ id: "sg-1", name: "Glob", input: { pattern: "src/auth/**/*.ts" } }]}
            />
          </Card>
        </div>
      </Section>

      {/* ─── Subagent Groups ──────────────────────────────── */}
      <Section
        title="Subagent Groups"
        description="Unified card for Task tool subagents — prompt, activities, and result in one collapsible container"
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="Subagent with prompt, tool calls, and result">
            <PlaygroundSubagentGroup
              description="Search codebase for auth patterns"
              agentType="Explore"
              prompt="Find all files related to authentication and authorization in the codebase. Look for middleware, guards, and token handling."
              items={MOCK_SUBAGENT_TOOL_ITEMS}
              durationSeconds={8.6}
              resultText={
                "Found **3 authentication-related files**:\n\n- `src/auth/middleware.ts` — JWT validation middleware\n- `src/auth/session.ts` — Session management with Redis\n- `src/routes/login.ts` — Login endpoint with rate limiting\n\nThe codebase uses a standard JWT + refresh token pattern."
              }
            />
          </Card>
          <Card label="Subagent still running (has children, no result)">
            <PlaygroundSubagentGroup
              description="Run database migration tests"
              agentType="general-purpose"
              prompt="Execute all database migration tests and report any failures."
              items={MOCK_SUBAGENT_TOOL_ITEMS.slice(0, 2)}
              liveStartedAt={Date.now() - 13_000}
            />
          </Card>
          <Card label="Subagent just spawned (no children yet)">
            <PlaygroundSubagentGroup
              description="Analyze performance bottlenecks"
              agentType="Plan"
              prompt="Profile the application startup and identify the top 3 performance bottlenecks."
              items={[]}
            />
          </Card>
          <Card label="Subagent interrupted (session ended without result)">
            <PlaygroundSubagentGroup
              description="Review authentication module"
              agentType="general-purpose"
              prompt="Audit the auth module for security vulnerabilities and suggest improvements."
              items={[]}
              durationSeconds={4.2}
              interrupted
            />
          </Card>
          <Card label="Delegate task with task preview, trace, and friendly result">
            <PlaygroundDelegateTaskGroup />
          </Card>
          <Card label="Delegate task pending handoff (empty trace)">
            <PlaygroundDelegateTaskPendingNoHandoffGroup />
          </Card>
          <Card label="Delegate task pending handoff (live activity, no handoff)">
            <PlaygroundDelegateTaskPendingLiveActivityGroup />
          </Card>
        </div>
      </Section>

      {/* ─── Collapsed Activity Bars ──────────────────────────────── */}
      <Section
        title="Collapsed Activity Bars"
        description="Turn summary bars for collapsed agent activity — shows message, tool, agent, and herd event counts"
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="Collapsed bar with herd events">
            <div className="rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
              <button className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <span>3 messages</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>5 tools</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>1 agent</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>2 herd events</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>2m 15s</span>
              </button>
            </div>
          </Card>
          <Card label="Collapsed bar without herd events">
            <div className="rounded-xl border border-cc-border/20 bg-cc-card/20 overflow-hidden">
              <button className="w-full flex items-center gap-1.5 py-1.5 px-3 border-l-2 border-cc-border/40 bg-cc-hover/10 hover:bg-cc-hover/30 transition-colors cursor-pointer text-[11px] text-cc-muted font-mono-code">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 text-cc-muted/60">
                  <path d="M6 4l4 4-4 4" />
                </svg>
                <span>1 message</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>3 tools</span>
                <span className="text-cc-muted/40">&middot;</span>
                <span>12s</span>
              </button>
            </div>
          </Card>
          <Card label="Leader Main stream — full activity visible">
            <div className="space-y-3">
              <MessageBubble
                message={{
                  id: "playground-leader-private-detail",
                  role: "assistant",
                  content: "Checked worker state, inspected the board, and prepared the next dispatch.",
                  timestamp: Date.now() - 120000,
                  metadata: {
                    threadKey: "main",
                  },
                }}
              />
              <MessageBubble
                message={{
                  id: "playground-threaded-user-reply",
                  role: "user",
                  content: "I replied from the quest thread, so route the next leader answer there.",
                  timestamp: Date.now() - 90000,
                  metadata: {
                    threadKey: "q-43",
                    questId: "q-43",
                    threadRefs: [{ threadKey: "q-43", questId: "q-43", source: "explicit" }],
                  },
                }}
              />
              <MessageBubble
                message={{
                  id: "playground-collapsed-touser",
                  role: "assistant",
                  content:
                    "Approved #70's plan for q-43. It's a clean unification: resize once at store time (1920px max).",
                  timestamp: Date.now() - 60000,
                  metadata: {
                    threadKey: "q-43",
                    threadRefs: [{ threadKey: "q-43", questId: "q-43", source: "explicit" }],
                  },
                }}
              />
            </div>
          </Card>
          <Card label="Leader thread switcher">
            <div className="rounded-lg border border-cc-border bg-cc-card/60 p-2 text-xs">
              <div className="rounded-md bg-cc-hover px-2 py-1.5 text-cc-fg">
                <div className="font-semibold">Main</div>
                <div className="text-[10px] text-cc-muted">Complete leader transcript</div>
              </div>
              <div className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-cc-muted/70">Active</div>
              <div className="mt-1 rounded-md px-2 py-1.5 text-cc-muted">
                <div className="flex items-start gap-1.5">
                  <span className="cc-quest-link shrink-0 text-xs font-medium font-mono-code">q-43</span>
                  <span className="min-w-0 truncate text-xs font-medium text-cc-fg">Resize images at store time</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full border border-cc-border/60 bg-cc-card/70 px-1.5 py-0.5 text-[10px] text-cc-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    Implement
                  </span>
                  <span className="inline-flex items-center gap-1 rounded border border-cc-border/60 bg-cc-hover/40 px-1.5 py-0.5 text-[10px] leading-none">
                    <span
                      className="h-2 w-2 rounded-full bg-emerald-500"
                      style={{
                        animation: "yarn-glow-breathe 2s ease-in-out infinite",
                        ["--glow-color" as string]: "rgba(34, 197, 94, 0.6)",
                      }}
                    />
                    W <span className="font-mono-code text-amber-400">#70</span>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded border border-cc-border/60 bg-cc-hover/40 px-1.5 py-0.5 text-[10px] leading-none">
                    <span className="h-2 w-2 rounded-full bg-cc-muted/50" />R{" "}
                    <span className="font-mono-code text-amber-400">#71</span>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded border border-cc-border/60 bg-cc-hover/40 px-1.5 py-0.5 text-[10px] leading-none">
                    <PowerPlugDot className="h-2.5 w-2.5 text-cc-muted/60" />W{" "}
                    <span className="font-mono-code text-amber-400">#72</span>
                  </span>
                </div>
                <div className="mt-1 text-[10px] tabular-nums text-cc-muted/85">3 messages</div>
              </div>
              <div className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-cc-muted/70">Done</div>
              <div className="mt-1 rounded-md px-2 py-1.5 text-cc-muted">
                <div className="cc-quest-link truncate text-xs">
                  <span className="font-mono-code">q-41</span>
                  <span className="text-cc-muted"> · </span>
                  <span>Finalize quest handoff</span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </Section>
      <PlaygroundHerdEventStates />
      <PlaygroundTimerMessageStates />

      <PlaygroundDiffViewerSection />
      {/* ─── New Session Modal Layout ─────────────────────── */}
      <Section
        title="New Session Modal Layout"
        description="Static layout mock for the labeled New Session controls without mounting the API-backed modal"
      >
        <div
          className="w-full max-w-[460px] rounded-2xl border border-cc-border bg-cc-card shadow-xl"
          data-testid="playground-new-session-modal-layout"
        >
          <div className="flex items-center justify-between border-b border-cc-border px-5 py-4">
            <h3 className="text-sm font-semibold text-cc-fg">New Session</h3>
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
              ×
            </button>
          </div>
          <div className="space-y-4 px-5 py-4">
            <section className="space-y-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/80">Engine</h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">Backend</div>
                  <div className="inline-flex rounded-lg bg-cc-hover/50 p-0.5">
                    <button className="rounded-md px-2.5 py-1 text-xs text-cc-muted">Claude</button>
                    <button className="rounded-md bg-cc-primary/15 px-2.5 py-1 text-xs font-medium text-cc-primary">
                      Codex
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">
                    Permission mode
                  </div>
                  <button className="rounded-md bg-cc-hover/50 px-2.5 py-1 text-xs font-medium text-cc-fg">
                    Default ▾
                  </button>
                </div>
              </div>
            </section>
            <section className="space-y-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/80">Codex options</h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">
                    Network access
                  </div>
                  <button className="rounded-md bg-cc-primary/15 px-2 py-1 text-xs font-medium text-cc-primary">
                    Internet
                  </button>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">
                    Reasoning effort
                  </div>
                  <button className="rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    High ▾
                  </button>
                </div>
              </div>
            </section>
            <section className="space-y-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/80">Workspace</h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-[1_1_12rem] space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">Folder</div>
                  <button className="flex max-w-full items-center rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    <span className="truncate font-mono-code">companion</span>
                    <span className="ml-1">▾</span>
                  </button>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">Isolation</div>
                  <button className="rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    Worktree
                  </button>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">
                    Session role
                  </div>
                  <button className="rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    Leader
                  </button>
                </div>
              </div>
            </section>
            <section className="space-y-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cc-muted/80">Runtime</h4>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">
                    Environment
                  </div>
                  <button className="rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    No env ▾
                  </button>
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-cc-muted/75">Model</div>
                  <button className="rounded-md px-2 py-1 text-xs text-cc-muted hover:bg-cc-hover hover:text-cc-fg">
                    Default (gpt-5.5) ▾
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </Section>
      {/* ─── Session Creation Progress ─────────────────────── */}
      <Section
        title="Session Creation Progress"
        description="Step-by-step progress indicator shown during session creation (SSE streaming)"
      >
        <div className="space-y-4 max-w-md">
          <Card label="In progress (container session)">
            <SessionCreationProgress
              steps={
                [
                  { step: "resolving_env", label: "Resolving environment...", status: "done" },
                  { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                  { step: "creating_container", label: "Starting container...", status: "in_progress" },
                  { step: "launching_cli", label: "Launching Claude Code...", status: "in_progress" },
                ] satisfies CreationProgressEvent[]
              }
            />
          </Card>
          <Card label="Completed (worktree session)">
            <SessionCreationProgress
              steps={
                [
                  { step: "resolving_env", label: "Resolving environment...", status: "done" },
                  { step: "fetching_git", label: "Fetching from remote...", status: "done" },
                  { step: "checkout_branch", label: "Checking out feat/auth...", status: "done" },
                  { step: "creating_worktree", label: "Creating worktree...", status: "done" },
                  { step: "launching_cli", label: "Launching Claude Code...", status: "done" },
                ] satisfies CreationProgressEvent[]
              }
            />
          </Card>
          <Card label="Error during image pull">
            <SessionCreationProgress
              steps={
                [
                  { step: "resolving_env", label: "Resolving environment...", status: "done" },
                  { step: "pulling_image", label: "Pulling Docker image...", status: "error" },
                ] satisfies CreationProgressEvent[]
              }
              error="Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s"
            />
          </Card>
          <Card label="Error during init script">
            <SessionCreationProgress
              steps={
                [
                  { step: "resolving_env", label: "Resolving environment...", status: "done" },
                  { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                  { step: "creating_container", label: "Starting container...", status: "done" },
                  { step: "running_init_script", label: "Running init script...", status: "error" },
                ] satisfies CreationProgressEvent[]
              }
              error={"npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /app/package.json"}
            />
          </Card>
        </div>
      </Section>
      {/* ─── Session Creation View (StepList) ──────────────────────────── */}
      <Section
        title="Session Creation View"
        description="Inline creation progress shown when a pending session is selected (replaces old full-screen overlay)"
      >
        <div className="space-y-4">
          <Card label="In progress (container session)">
            <div className="py-4">
              <StepList
                steps={
                  [
                    { step: "resolving_env", label: "Environment resolved", status: "done" },
                    { step: "pulling_image", label: "Pulling Docker image...", status: "done" },
                    { step: "creating_container", label: "Starting container...", status: "in_progress" },
                    { step: "launching_cli", label: "Launching Claude Code...", status: "in_progress" },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </div>
          </Card>
          <Card label="All steps done">
            <div className="py-4">
              <StepList
                steps={
                  [
                    { step: "resolving_env", label: "Environment resolved", status: "done" },
                    { step: "fetching_git", label: "Fetch complete", status: "done" },
                    { step: "creating_worktree", label: "Worktree created", status: "done" },
                    { step: "launching_cli", label: "CLI launched", status: "done" },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </div>
          </Card>
          <Card label="Error state">
            <div className="py-4">
              <StepList
                steps={
                  [
                    { step: "resolving_env", label: "Environment resolved", status: "done" },
                    { step: "pulling_image", label: "Pulling Docker image...", status: "error" },
                  ] satisfies CreationProgressEvent[]
                }
              />
              <div className="mt-3 w-full max-w-xs px-4">
                <div className="px-3 py-2.5 rounded-lg bg-cc-error/5 border border-cc-error/20">
                  <p className="text-[11px] text-cc-error whitespace-pre-wrap font-mono-code leading-relaxed">
                    Failed to pull docker.io/stangirard/the-companion:latest — connection timed out after 30s
                  </p>
                </div>
              </div>
            </div>
          </Card>
          <Card label="Codex backend">
            <div className="py-4">
              <StepList
                steps={
                  [
                    { step: "resolving_env", label: "Environment resolved", status: "done" },
                    { step: "launching_cli", label: "Launching Codex...", status: "in_progress" },
                  ] satisfies CreationProgressEvent[]
                }
              />
            </div>
          </Card>
        </div>
      </Section>
      {/* ─── Codex Instruction Sources ─────────────────────── */}
      <Section
        title="Codex Instruction Sources"
        description="Read-only thread snapshot of configuration provenance and every AGENTS file Codex reported as loaded"
      >
        <div className="max-w-md overflow-hidden rounded-xl border border-cc-border bg-cc-card">
          <CodexInstructionsCollapsible
            sessionId="playground-codex-instructions"
            snapshot={{
              threadId: "0199-demo-thread",
              capturedAt: Date.UTC(2026, 8, 7, 12, 0, 0),
              lifecycle: "thread_resume",
              instructionSourcesReported: true,
              developerInstructionsConfigured: true,
              configLayers: [
                { kind: "user", path: "/Users/demo/.companion/codex-home/session-id/config.toml" },
                { kind: "session_flags", label: "Takode launch overrides" },
              ],
              instructionSources: [
                {
                  path: "/Users/demo/.companion/codex-home/session-id/AGENTS.override.md",
                  sourcePath: "/Users/demo/.codex/AGENTS.override.md",
                  kind: "global",
                  delivery: "copied_snapshot",
                },
                { path: "/workspace/AGENTS.md", kind: "project", delivery: "direct" },
                {
                  path: "/workspace/packages/very-long-component-name/AGENTS.md",
                  kind: "project",
                  delivery: "direct",
                },
              ],
            }}
          />
        </div>
      </Section>

      {/* ─── CLAUDE.md Editor ──────────────────────────────── */}
      <Section title="CLAUDE.md Editor" description="Modal for viewing and editing project CLAUDE.md instructions">
        <div className="space-y-4 max-w-3xl">
          <Card label="Open editor button (from TopBar)">
            <PlaygroundClaudeMdButton />
          </Card>
        </div>
      </Section>

      {/* ─── Cat Theme Elements ──────────────────────────────── */}
      <Section title="Cat Theme Elements" description="Cat-themed UI icons and animations used throughout Takode">
        <div className="space-y-4 max-w-3xl">
          <Card label="Paw Trail (down-facing, land-from-above stamp)">
            <div className="flex flex-col items-start gap-1 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center -translate-x-1 rotate-[160deg]">
                  <CatPawLeft className="w-3 h-3 text-cc-primary" />
                </div>
                <span className="text-xs text-cc-muted">Left paw — toes down-left (160deg)</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center translate-x-1 rotate-[200deg]">
                  <CatPawRight className="w-3 h-3 text-cc-primary" />
                </div>
                <span className="text-xs text-cc-muted">Right paw — toes down-right (200deg)</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center -translate-x-1 rotate-[160deg]">
                  <CatPawLeft className="w-3 h-3 text-cc-primary animate-[paw-walk_0.8s_ease-in-out_infinite]" />
                </div>
                <span className="text-xs text-cc-muted">Walking (streaming)</span>
              </div>
            </div>
          </Card>
          <Card label="Yarn Ball Status Dot (sidebar sessions)">
            <div className="flex items-center gap-6 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <YarnBallDot
                  className="text-cc-success"
                  style={{ filter: "drop-shadow(0 0 4px rgba(34, 197, 94, 0.6))" }}
                />
                <span className="text-xs text-cc-muted">Running</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot
                  className="text-cc-warning"
                  style={{ filter: "drop-shadow(0 0 4px rgba(245, 158, 11, 0.6))" }}
                />
                <span className="text-xs text-cc-muted">Permission</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-error" />
                <span className="text-xs text-cc-muted">Disconnected</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-muted/40" />
                <span className="text-xs text-cc-muted">Idle</span>
              </div>
            </div>
          </Card>
          <Card label="Yarn Ball Status Dots">
            <div className="flex items-center gap-6 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-primary animate-pulse" />
                <span className="text-xs text-cc-muted">Running</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-warning animate-pulse" />
                <span className="text-xs text-cc-muted">Compacting</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-success" />
                <span className="text-xs text-cc-muted">Active</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-blue-500" />
                <span className="text-xs text-cc-muted">Unread</span>
              </div>
            </div>
          </Card>
          <Card label="Yarn Ball Rolling (back-and-forth)">
            <div className="flex items-center gap-6 px-4 py-3">
              <div className="flex items-center gap-1.5">
                <YarnBallDot
                  className="text-cc-success yarn-ball-roll"
                  style={{ filter: "drop-shadow(0 0 4px rgba(34, 197, 94, 0.6))" }}
                />
                <span className="text-xs text-cc-muted">Running</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot
                  className="text-cc-warning yarn-ball-roll"
                  style={{ filter: "drop-shadow(0 0 4px rgba(245, 158, 11, 0.6))" }}
                />
                <span className="text-xs text-cc-muted">Compacting</span>
              </div>
              <div className="flex items-center gap-1.5">
                <YarnBallDot className="text-cc-muted/40" />
                <span className="text-xs text-cc-muted">Static (idle)</span>
              </div>
            </div>
          </Card>
          <Card label="Yarn Ball Spinner">
            <div className="flex items-center gap-6 px-4 py-3">
              <YarnBallSpinner className="w-3 h-3 text-cc-primary" />
              <YarnBallSpinner className="w-4 h-4 text-cc-muted" />
              <YarnBallSpinner className="w-5 h-5 text-cc-primary" />
              <span className="text-xs text-cc-muted">Various sizes</span>
            </div>
          </Card>
          <Card label="Sleeping Cat (empty state)">
            <div className="flex items-center gap-6 px-4 py-3">
              <SleepingCat className="w-28 h-20" />
              <SleepingCat className="w-20 h-14" />
            </div>
          </Card>
          <Card label="Paw Approval (button morph)">
            <div className="flex items-center gap-6 px-4 py-3">
              <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-success/90 text-white cursor-pointer">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                  <path d="M3 8.5l3.5 3.5 6.5-7" />
                </svg>
                Allow
              </button>
              <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-success/90 text-white animate-[paw-approve_400ms_ease-out_forwards]">
                <CatPawAvatar className="w-3.5 h-3.5" />
                Approved
              </button>
              <span className="text-xs text-cc-muted">Button morphs on approval</span>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Session Search"
        description="In-session search highlights matching text in messages. SearchBar drives the interaction; HighlightedText renders per-message match highlights."
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="HighlightedText — Current match (strict)">
            <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
              <HighlightedText
                text="Hello world, this is a test message with hello again"
                query="hello"
                mode="strict"
                isCurrent={true}
              />
            </div>
            <p className="text-[10px] text-cc-muted mt-2">
              Strict mode, isCurrent=true — bright amber highlights on exact substring matches
            </p>
          </Card>
          <Card label="HighlightedText — Other match (strict)">
            <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
              <HighlightedText
                text="Hello world, this is a test message with hello again"
                query="hello"
                mode="strict"
                isCurrent={false}
              />
            </div>
            <p className="text-[10px] text-cc-muted mt-2">
              Strict mode, isCurrent=false — subtle amber highlights for non-active matches
            </p>
          </Card>
          <Card label="HighlightedText — Fuzzy mode">
            <div className="p-2 rounded-lg bg-cc-bg text-sm text-cc-fg">
              <HighlightedText text="The quick brown fox jumps" query="quick fox" mode="fuzzy" isCurrent={true} />
            </div>
            <p className="text-[10px] text-cc-muted mt-2">
              Fuzzy mode — each query word highlighted independently ("quick" and "fox")
            </p>
          </Card>
          <Card label="SearchBar states (description)">
            <div className="space-y-2 text-xs text-cc-muted px-1">
              <p>
                <span className="font-medium text-cc-fg">Idle:</span> Hidden — activated via Cmd+Shift+F / Ctrl+Shift+F
                keyboard shortcut
              </p>
              <p>
                <span className="font-medium text-cc-fg">Open (no matches):</span> Input field with "0 of 0" counter,
                up/down navigation arrows disabled
              </p>
              <p>
                <span className="font-medium text-cc-fg">Open (with matches):</span> "3 of 12" counter with active
                navigation arrows, close button (Escape)
              </p>
              <p>
                <span className="font-medium text-cc-fg">Mode toggle:</span> Strict (exact substring) ↔ Fuzzy (per-word)
                via button in the search bar
              </p>
              <p>
                <span className="font-medium text-cc-fg">Category filters:</span> Inline segmented pills for `All`,
                `User`, `Assistant`, and `Events` keep the bar compact while narrowing matches by semantic category:
                human or leader-authored user messages stay in `User`, while timers, herd updates, and system messages
                move to `Events`
              </p>
            </div>
          </Card>
          <Card label="SearchBar filter mock">
            <div className="rounded-xl border border-cc-border bg-cc-card px-3 py-2">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted shrink-0">
                  <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
                </svg>
                <div className="min-w-0 flex-1 text-sm text-cc-muted">Search messages...</div>
                <div className="flex items-center gap-1 rounded-lg border border-cc-border/70 bg-cc-bg/70 p-0.5">
                  {["All", "User", "Assistant", "Events"].map((label) => {
                    const isActive = label === "Events";
                    return (
                      <button
                        key={label}
                        type="button"
                        className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                          isActive ? "bg-cc-primary/18 text-cc-primary" : "text-cc-muted"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="flex items-center justify-center w-7 h-7 rounded-lg text-xs font-mono-code bg-cc-hover text-cc-fg"
                >
                  Aa
                </button>
                <span className="text-[11px] text-cc-muted whitespace-nowrap tabular-nums shrink-0">2 of 3</span>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      <PlaygroundUniversalSearchStates />
      <PlaygroundUserMessageNavigatorSection />
      <PlaygroundSidebarOverflowStates />

      {/* ─── Folder Picker ──────────────────────────────── */}
      <Section
        title="Folder Picker"
        description="Directory browser modal with breadcrumbs, filter, hidden dirs toggle, and keyboard nav"
      >
        <div className="space-y-4 max-w-3xl">
          <Card label="Open folder picker">
            <PlaygroundFolderPicker />
          </Card>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
