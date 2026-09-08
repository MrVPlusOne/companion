import { useEffect, useRef, useState } from "react";
import { NotificationMarker, UserReplyChip } from "../MessageBubble.js";
import { BoardBlock } from "../BoardBlock.js";
import type { BoardRowData } from "../BoardTable.js";
import { CatPawAvatar } from "../CatIcons.js";
import { ReplyChip } from "../Composer.js";
import { ComposerMetaToolbar } from "../ComposerMetaToolbar.js";
import { PausedInputChip, PauseOtherSourcesButton } from "../SessionPauseComposerControls.js";
import { WorkBoardBar } from "../WorkBoardBar.js";
import { useStore } from "../../store.js";
import { CLAUDE_MODELS, CLAUDE_PERMISSION_MODES, CODEX_MODELS, CODEX_PERMISSION_MODES } from "../../utils/backends.js";
import type { QuestJourneyPhaseId } from "../../../shared/quest-journey.js";
import {
  LEADER_THREAD_TABS_PROJECTION,
  type LeaderThreadTabsProjectionTab,
  type LeaderThreadTabsProjectionValue,
} from "../../../shared/leader-thread-tabs-projection.js";
import { getSyncedProjectionValue } from "../../store-synced-projections.js";
import { PlaygroundNotificationInboxSection } from "./PlaygroundNotificationInboxSection.js";
import { PlaygroundQuestSessionAutocompletePreview } from "./PlaygroundComposerAutocompletePreview.js";
import {
  PlaygroundNeedsInputRecordingPreview,
  PlaygroundNeedsInputTranscriptionFailurePreview,
} from "./NeedsInputAnswerPreviews.js";
import { PlaygroundQuestDetailModalSection } from "./PlaygroundQuestDetailModalSection.js";
import { PlaygroundAutoPauseBannerStates } from "./AutoPausePlaygroundStates.js";
import { PlaygroundReasoningDetailStates } from "./ReasoningDetailStates.js";
import { PlaygroundLeaderActivityStates } from "./LeaderActivityStates.js";
import { PlaygroundQuestJourneyPalette } from "./PlaygroundQuestJourneyPalette.js";
import { PlaygroundQuestStatusPanelSection, PlaygroundQuestmasterCompactSection } from "./PlaygroundQuestSections.js";
import { PlaygroundTodoStates } from "./PlaygroundTodoStates.js";
import { PlaygroundTimerStates } from "./PlaygroundTimerStates.js";
import { PlaygroundCodexInstructionsSection } from "./PlaygroundCodexInstructionsSection.js";
import { PlaygroundTurnWindowStabilitySection } from "./PlaygroundTurnWindowStabilitySection.js";
import { buildPlaygroundProjectedJourney } from "./leader-thread-tabs-projection-fixtures.js";
import { MOCK_SESSION_ID } from "./fixtures.js";
import {
  Card,
  PlaygroundAddressedSuggestedAnswerNotificationMarker,
  PlaygroundBoardWithOriginalCommand,
  PlaygroundCollapsedBoardCommand,
  PlaygroundDedupedNotificationMessage,
  PlaygroundHoverCrossLinkDemo,
  PlaygroundMessageLinkHoverDemo,
  PlaygroundMultiQuestionNotificationMarker,
  PlaygroundReviewNotificationMarker,
  PlaygroundSectionGroup,
  PlaygroundSelectionContextMenu,
  PlaygroundSuggestedAnswerNotificationMarker,
  Section,
} from "./shared.js";

const PLAYGROUND_FAST_SERVICE_TIER = { id: "priority", name: "Fast", description: "1.5x speed, increased usage" };
const PLAYGROUND_BOARD_SESSION_ID = "playground-board-bar";
let playgroundBoardProjectionRevision = 0;

function applyPlaygroundBoardProjection(value: LeaderThreadTabsProjectionValue): void {
  useStore.getState().applySyncedProjectionSnapshot({
    type: "synced_projection_snapshot",
    projection: LEADER_THREAD_TABS_PROJECTION,
    key: PLAYGROUND_BOARD_SESSION_ID,
    generation: "playground-board-tabs",
    revision: ++playgroundBoardProjectionRevision,
    value,
  });
}

function playgroundFallbackTab(threadKey: string): LeaderThreadTabsProjectionTab {
  const crowdMatch = /^q-(11\d{2})$/.exec(threadKey);
  const crowdIndex = crowdMatch ? Number(crowdMatch[1]) - 1100 : null;
  return {
    threadKey,
    questId: threadKey,
    title:
      threadKey === "q-99"
        ? "Newly moved user request"
        : crowdIndex
          ? `Desktop tab ${crowdIndex} with readable context`
          : threadKey,
    boardStatus: null,
    journey: null,
    sourceLeaderSessionId: PLAYGROUND_BOARD_SESSION_ID,
    sourceRowCreatedAt: null,
    workerSessionId: null,
    workerSessionNum: null,
    active: false,
    queued: false,
    proposed: false,
    neverStartedScheduled: false,
    completed: false,
    canClose: true,
    attention: { needsInput: false, mutedNeedsInput: false, reviewUnread: false, updatedAt: 0 },
    updatedAt: 0,
  };
}

function applyPlaygroundBoardTabKeys(threadKeys: string[]): void {
  const current = getSyncedProjectionValue(
    useStore.getState(),
    LEADER_THREAD_TABS_PROJECTION,
    PLAYGROUND_BOARD_SESSION_ID,
  );
  if (!current) return;
  const tabsByKey = new Map(current.tabs.map((tab) => [tab.threadKey, tab]));
  applyPlaygroundBoardProjection({
    ...current,
    tabs: threadKeys.map((threadKey) => tabsByKey.get(threadKey) ?? playgroundFallbackTab(threadKey)),
  });
}

const PLAYGROUND_CODEX_MODEL_OPTIONS = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    icon: "●",
    serviceTiers: [PLAYGROUND_FAST_SERVICE_TIER],
    supportedReasoningLevels: [
      { effort: "medium", description: "Balanced reasoning for everyday work." },
      { effort: "ultra", description: "Maximum reasoning that may proactively use multiple agents." },
    ],
    defaultReasoningLevel: "medium",
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    icon: "⚡",
    supportedReasoningLevels: [
      { effort: "low", description: "Fast, lightweight reasoning." },
      { effort: "medium", description: "Balanced reasoning." },
    ],
    defaultReasoningLevel: "low",
  },
];

function PlaygroundCollapseAllButton() {
  return (
    <button
      type="button"
      className="flex h-7 w-7 cursor-default items-center justify-center rounded-md text-cc-muted/40"
      title="Collapse all turns"
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 16 16">
        <path d="M4 2l4 4 4-4" />
        <path d="M4 14l4-4 4 4" />
      </svg>
    </button>
  );
}

function PlaygroundComposerPermissionToolbar({
  backend,
  state,
}: {
  backend: "claude" | "codex";
  state: "menu" | "popover";
}) {
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const permissionDropdownRef = useRef<HTMLDivElement | null>(null);
  const isCodex = backend === "codex";
  const codexModelOptions = isCodex
    ? CODEX_MODELS.map((model) =>
        model.value === "gpt-5.4" ? { ...model, serviceTiers: [PLAYGROUND_FAST_SERVICE_TIER] } : model,
      )
    : CODEX_MODELS;

  return (
    <div className="border-t border-cc-border bg-cc-card px-4 py-3">
      <div className="rounded-[14px] border border-cc-border bg-cc-input-bg pt-28">
        <div className="px-4 pb-1 text-sm text-cc-muted">
          {isCodex ? "Codex profile selector with pending restart confirmation." : "Claude permission selector menu."}
        </div>
        <ComposerMetaToolbar
          sessionId={`playground-permission-${backend}-${state}`}
          sessionView={{
            gitBranch: isCodex ? "feature/codex-profile" : "feature/claude-mode",
            model: isCodex ? "gpt-5.4" : "claude-sonnet-4-5-20250929",
            isContainerized: false,
            gitAhead: isCodex ? 1 : 0,
            gitBehind: 0,
          }}
          isCodex={isCodex}
          isConnected={true}
          canEditLaunchSettings={true}
          imageUploadDisabled={false}
          imageUploadTitle="Upload image"
          showModelDropdown={false}
          setShowModelDropdown={() => {}}
          modelDropdownRef={modelDropdownRef}
          claudeModelOptions={CLAUDE_MODELS.filter((model) => model.value)}
          codexModelOptions={codexModelOptions}
          onSelectModel={() => {}}
          codexReasoningEffort={isCodex ? "high" : ""}
          codexEffectiveReasoningEffort={isCodex ? "high" : null}
          codexEffectiveReasoningEffortReported={isCodex}
          onSelectCodexReasoning={() => {}}
          codexServiceTier={isCodex ? "priority" : null}
          codexFastServiceTier={isCodex ? (codexModelOptions[1]?.serviceTiers?.[0] ?? null) : null}
          onSelectCodexServiceTier={() => {}}
          onResetCodexSettings={async () => {}}
          permissionOptions={isCodex ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES}
          permissionMode={isCodex ? "auto-review" : "acceptEdits"}
          showPermissionDropdown={state === "menu"}
          setShowPermissionDropdown={() => {}}
          permissionDropdownRef={permissionDropdownRef}
          pendingPermissionMode={state === "popover" ? (isCodex ? "full-access" : "bypassPermissions") : null}
          onRequestPermissionMode={() => {}}
          onCancelPermissionMode={() => {}}
          onConfirmPermissionMode={() => {}}
          collapseAllButton={<PlaygroundCollapseAllButton />}
          pauseControl={
            <PauseOtherSourcesButton
              isPaused={isCodex}
              heldCount={2}
              busy={false}
              directComposerMessagesSend={true}
              onToggle={() => {}}
            />
          }
          onOpenFilePicker={() => {}}
          warmMicrophone={() => {}}
          voiceSupported={true}
          toggleVoiceUnsupportedInfo={() => {}}
          handleMicClick={() => {}}
          voiceButtonDisabled={false}
          isPreparing={false}
          isRecording={false}
          voiceButtonTitle="Voice input"
          canSend={false}
          isRunning={false}
          handleInterrupt={() => {}}
          handleSend={() => {}}
          sendButtonTitle="Send: Enter; New line: Shift+Enter"
          sendPressing={false}
        />
      </div>
    </div>
  );
}

function PlaygroundCodexModelToolbar({ narrow = false }: { narrow?: boolean }) {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [effort, setEffort] = useState("ultra");
  const [serviceTier, setServiceTier] = useState<string | null>("priority");
  const [showModelDropdown, setShowModelDropdown] = useState(!narrow);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const permissionDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedModel = PLAYGROUND_CODEX_MODEL_OPTIONS.find((option) => option.value === model);
  const fastTier = selectedModel?.serviceTiers?.[0] ?? null;

  return (
    <div className={`border-t border-cc-border bg-cc-card px-3 py-3 ${narrow ? "max-w-[330px]" : ""}`}>
      <div className={`rounded-[14px] border border-cc-border bg-cc-input-bg ${showModelDropdown ? "pt-56" : "pt-10"}`}>
        <ComposerMetaToolbar
          sessionId={`playground-codex-model-${narrow ? "narrow" : "menu"}`}
          sessionView={{ model, gitAhead: 0, gitBehind: 0 }}
          isCodex={true}
          isConnected={true}
          canEditLaunchSettings={true}
          imageUploadDisabled={false}
          imageUploadTitle="Upload image"
          showModelDropdown={showModelDropdown}
          setShowModelDropdown={setShowModelDropdown}
          modelDropdownRef={modelDropdownRef}
          claudeModelOptions={[]}
          codexModelOptions={PLAYGROUND_CODEX_MODEL_OPTIONS}
          onSelectModel={setModel}
          codexReasoningEffort={effort}
          codexEffectiveReasoningEffort={narrow ? effort : "high"}
          codexEffectiveReasoningEffortReported={true}
          onSelectCodexReasoning={setEffort}
          codexServiceTier={serviceTier}
          codexFastServiceTier={fastTier}
          onSelectCodexServiceTier={setServiceTier}
          onResetCodexSettings={async () => {
            setModel("gpt-5.6-sol");
            setEffort("medium");
            setServiceTier(null);
          }}
          permissionOptions={CODEX_PERMISSION_MODES}
          permissionMode="default"
          showPermissionDropdown={false}
          setShowPermissionDropdown={() => {}}
          permissionDropdownRef={permissionDropdownRef}
          pendingPermissionMode={null}
          onRequestPermissionMode={() => {}}
          onCancelPermissionMode={() => {}}
          onConfirmPermissionMode={() => {}}
          collapseAllButton={<PlaygroundCollapseAllButton />}
          pauseControl={null}
          onOpenFilePicker={() => {}}
          warmMicrophone={() => {}}
          voiceSupported={true}
          toggleVoiceUnsupportedInfo={() => {}}
          handleMicClick={() => {}}
          voiceButtonDisabled={false}
          isPreparing={false}
          isRecording={false}
          voiceButtonTitle="Voice input"
          canSend={false}
          isRunning={false}
          handleInterrupt={() => {}}
          handleSend={() => {}}
          sendButtonTitle="Send"
          sendPressing={false}
        />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-cc-muted">
        {narrow
          ? "Narrow-width state: the friendly model and effort label truncates before essential composer actions."
          : "Choose Model, Effort, and Speed independently. A runtime mismatch stays a compact warning instead of becoming a second selector; Reset restores the playground defaults."}
      </p>
    </div>
  );
}

export function PlaygroundInteractiveSections() {
  const [boardOpenThreadKeys, setBoardOpenThreadKeys] = useState(["q-1932", "q-42", "q-55", "q-61", "q-77", "q-88"]);
  const [boardPreviewThreadKey, setBoardPreviewThreadKey] = useState("main");

  return (
    <PlaygroundSectionGroup groupId="interactive">
      <PlaygroundTurnWindowStabilitySection />
      {/* ─── Composer ──────────────────────────────── */}
      <Section
        title="Composer"
        description="Message input bar with backend-native permission selector, image upload, and independent Stop plus Send controls while a follow-up is ready during generation"
      >
        <div className="max-w-3xl">
          <Card label="Running with a sendable follow-up">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="px-4 pt-3 pb-2">
                  <div className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                      <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                      <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
                    </svg>
                    <span className="min-w-0 truncate rounded px-0.5 font-mono-code">OverflowTarget.tsx:438-444</span>
                    <span className="text-cc-muted/60">&middot;</span>
                    <span className="shrink-0">7 lines selected</span>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-cc-border/60 cursor-pointer"
                      aria-label="Dismiss selection"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" />
                      </svg>
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Can you refactor the auth module to use JWT?"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Full access</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span className="truncate font-mono-code">jiayi</span>
                      <span className="shrink-0 text-cc-muted/40">&middot;</span>
                      <span className="truncate font-mono-code">sonnet-4.5</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div
                      className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-error/10 text-cc-error"
                      title="Stop generation"
                    >
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
          <Card label="Claude permission selector menu">
            <PlaygroundComposerPermissionToolbar backend="claude" state="menu" />
          </Card>
          <div className="mt-4" />
          <Card label="Codex permission change confirmation">
            <PlaygroundComposerPermissionToolbar backend="codex" state="popover" />
          </Card>
          <div className="mt-4" />
          <Card label="Codex model and effort selector">
            <PlaygroundCodexModelToolbar />
          </Card>
          <div className="mt-4" />
          <Card label="Codex model selector — narrow layout">
            <PlaygroundCodexModelToolbar narrow />
          </Card>
          <div className="mt-4" />
          <PlaygroundAutoPauseBannerStates />
          <div className="mt-4" />
          <Card label="Paused other input sources">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <PausedInputChip
                  heldCount={2}
                  directComposerMessagesSend={true}
                  pause={{
                    pausedAt: Date.now() - 90_000,
                    queuedMessages: [
                      {
                        id: "playground-held-timer",
                        queuedAt: Date.now() - 60_000,
                        source: "programmatic",
                        message: {
                          type: "user_message",
                          content: "Recurring timer reminder held while paused",
                          agentSource: { sessionId: "timer:t1", sessionLabel: "Timer t1" },
                        },
                      },
                      {
                        id: "playground-held-herd",
                        queuedAt: Date.now() - 30_000,
                        source: "programmatic",
                        message: { type: "user_message", content: "Leader herd event held for this session" },
                      },
                    ],
                  }}
                />
                <textarea
                  readOnly
                  value="Direct composer messages still send while outside sources are paused."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <PlaygroundCollapseAllButton />
                    <PauseOtherSourcesButton
                      isPaused={true}
                      heldCount={2}
                      busy={false}
                      directComposerMessagesSend={true}
                      onToggle={() => {}}
                    />
                  </div>
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                      <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Connected — VS Code preview only">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="px-4 pt-3 pb-2">
                  <div className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                      <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                      <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
                    </svg>
                    <span className="relative min-w-0">
                      <span className="block truncate rounded px-0.5 font-mono-code text-cc-fg">App.tsx:58</span>
                      <span className="absolute left-0 bottom-full z-20 mb-2 w-max max-w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-cc-border bg-cc-card px-3 py-2 text-[11px] text-cc-fg shadow-lg">
                        <span className="block font-mono-code break-all leading-snug">
                          /Users/stan/Dev/project/web/src/App.tsx
                        </span>
                      </span>
                    </span>
                    <span className="text-cc-muted/60">&middot;</span>
                    <span className="shrink-0">1 line selected</span>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Does this selection matter?"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Full access</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                      <span className="truncate font-mono-code">jiayi</span>
                      <span className="shrink-0 text-cc-muted/40">&middot;</span>
                      <span className="truncate font-mono-code">sonnet-4.5</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
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
          <Card label="Desktop drag-over image attach">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="relative bg-cc-input-bg border border-cc-primary rounded-[14px] overflow-hidden shadow-[0_0_0_3px_rgba(255,122,26,0.12)]">
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border border-dashed border-cc-primary/50 bg-cc-primary/10">
                  <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
                    Drop images to attach
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Investigate this screenshot and attached error."
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
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-primary bg-cc-primary/10">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
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
          <Card label="Attachment processing states">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <div className="flex items-center gap-2 px-4 pt-3 text-[11px] text-cc-warning">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                  <span>Remove or retry 1 failed image before sending.</span>
                </div>
                <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#4b5563,#111827)]" />
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Uploading...</div>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#7f1d1d,#1f2937)]" />
                    <button
                      type="button"
                      className="absolute left-1.5 top-1.5 rounded-full bg-cc-card/95 px-2 py-1 text-[10px] font-medium text-cc-primary shadow-sm"
                    >
                      Retry
                    </button>
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Upload failed</div>
                      <div className="truncate text-white/80">server rejected image</div>
                    </div>
                  </div>
                  <div className="relative">
                    <div className="w-24 h-24 rounded-lg border border-cc-border bg-[linear-gradient(135deg,#0f766e,#111827)]" />
                    <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                      <div className="truncate font-medium">Ready</div>
                    </div>
                  </div>
                </div>
                <textarea
                  readOnly
                  value="Please compare the ready screenshot once the retry succeeds."
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
                  <div className="flex min-w-0 items-center gap-2 overflow-hidden text-[11px] text-cc-muted">
                    <div className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium">
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
                      <span>Full access</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
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
          <Card label="Codex `$` skill/app picker">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="relative bg-cc-input-bg border border-cc-border rounded-[14px] overflow-visible">
                <div className="absolute left-2 right-2 bottom-full mb-1 rounded-[10px] border border-cc-border bg-cc-card shadow-lg py-1">
                  {[
                    {
                      label: "$doc-coauthoring",
                      kind: "skill",
                      description: "Draft and edit design docs",
                    },
                    {
                      label: "$google-drive",
                      kind: "app",
                      description: "Search and edit Drive files",
                    },
                  ].map((entry, index) => (
                    <div
                      key={entry.label}
                      className={`w-full px-3 py-2 flex items-center gap-2.5 ${index === 0 ? "bg-cc-hover" : ""}`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        {entry.kind === "app" ? (
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="w-3.5 h-3.5"
                          >
                            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
                            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
                            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
                            <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-cc-fg">{entry.label}</span>
                          <span className="shrink-0 text-[11px] text-cc-muted">{entry.kind}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-cc-muted">{entry.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <textarea
                  readOnly
                  value="Use $doc"
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
                    <span>agent</span>
                  </div>
                  <div className="flex items-center gap-1">
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
          <PlaygroundQuestSessionAutocompletePreview />
          <div className="mt-4" />
          <Card label="Send pressed — paw morph">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
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
                    <div
                      className="flex items-center justify-center w-8 h-8 rounded-full bg-cc-primary text-white animate-[send-morph_500ms_ease-out]"
                      style={{ animationPlayState: "paused", animationDelay: "-150ms" }}
                    >
                      <CatPawAvatar className="w-4 h-4" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Plan mode active">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-primary/40 rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                <div className="flex items-center justify-between px-2.5 pb-2.5">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-cc-primary">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <rect x="3" y="3" width="3.5" height="10" rx="0.75" />
                      <rect x="9.5" y="3" width="3.5" height="10" rx="0.75" />
                    </svg>
                    <span>plan</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
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
          <Card label="Mobile reply lock keeps composer expanded">
            <div className="border-t border-cc-border bg-cc-card px-3 py-3">
              <div className="max-w-[430px]">
                <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                  <ReplyChip
                    previewText="Approve q-460 plan? Re-run all 4 datasets before review."
                    onDismiss={() => {}}
                  />
                  <textarea
                    readOnly
                    value=""
                    placeholder="Type a message... (/ for commands)"
                    rows={1}
                    className="w-full px-4 pt-3 pb-1 text-base bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
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
                      <span>agent</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-11 h-11 rounded-lg text-cc-muted">
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-5 h-5"
                        >
                          <rect x="2" y="2" width="12" height="12" rx="2" />
                          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                          <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="flex items-center justify-center w-11 h-11 rounded-full bg-cc-hover text-cc-muted">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          <div className="mt-4" />
          <Card label="Running — stop button visible">
            <div className="border-t border-cc-border bg-cc-card px-4 py-3">
              <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
                <textarea
                  readOnly
                  value=""
                  placeholder="Type a message... (/ for commands)"
                  rows={1}
                  className="w-full px-4 pt-3 pb-1 text-sm bg-transparent resize-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
                  style={{ minHeight: "36px" }}
                />
                {/* Git branch info */}
                <div className="flex items-center gap-2 px-4 pb-1 text-[11px] text-cc-muted overflow-hidden">
                  <span className="flex items-center gap-1 truncate min-w-0">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    </svg>
                    <span className="truncate">feat/jwt-auth</span>
                    <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                  </span>
                  <span className="flex items-center gap-0.5 text-[10px]">
                    <span className="text-green-500">3&#8593;</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-green-500">+142</span>
                    <span className="text-red-400">-38</span>
                  </span>
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
                  <div className="flex items-center gap-3 sm:gap-1">
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                        <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cc-error/10 text-cc-error">
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
        </div>
      </Section>

      {/* ─── Reply Chip ──────────────────────────────── */}
      <Section
        title="Reply Chip"
        description="Shows which assistant message the user is replying to. Appears above the composer textarea."
      >
        <div className="max-w-3xl">
          <Card label="Short preview text">
            <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
              <ReplyChip previewText="Here's the implementation plan for the reply feature..." onDismiss={() => {}} />
              <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
            </div>
          </Card>
          <Card label="Long preview text (truncated)">
            <div className="bg-cc-input-bg border border-cc-border rounded-[14px] overflow-hidden">
              <ReplyChip
                previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS so it doesn't wrap to multiple lines and break the layout"
                onDismiss={() => {}}
              />
              <div className="px-4 py-3 text-cc-muted text-sm italic">(Composer textarea would be here)</div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Selection Context Menu ──────────────────────────────── */}
      <Section
        title="Selection Context Menu"
        description="Floating context menu shown when the user selects text within an assistant message. Offers quoting and copy options."
      >
        <div className="max-w-3xl">
          <Card label="Live full-block and partial-selection controls">
            <PlaygroundSelectionContextMenu />
          </Card>
        </div>
      </Section>

      {/* ─── User Message Reply Chip ──────────────────────────────── */}
      <Section
        title="User Message Reply Chip"
        description="Read-only reply chip rendered above user message bubble text when the user replied to a specific assistant message."
      >
        <div className="max-w-3xl">
          <Card label="Short reply context">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText="Here's the implementation plan for the reply feature..." />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  Can you also add keyboard shortcuts for this?
                </pre>
              </div>
            </div>
          </Card>
          <Card label="Long reply context (truncated)">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText="This is a much longer preview text that exceeds the typical display width and should be truncated with CSS to keep the chip compact" />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  I disagree with this approach. Let me explain why.
                </pre>
              </div>
            </div>
          </Card>
          <Card label="Reply with code in preview">
            <div className="flex justify-end">
              <div className="max-w-[80%] px-4 py-2.5 rounded-[14px] rounded-br-[4px] bg-cc-user-bubble text-cc-fg">
                <UserReplyChip previewText={'Here\'s the fix: `const result = await fetchData("api/v2")`'} />
                <pre className="text-[14px] whitespace-pre-wrap break-words font-sans-ui leading-relaxed">
                  This doesn't handle the error case. Can you add a try/catch?
                </pre>
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ─── Notification Marker ──────────────────────────────── */}
      <Section
        title="Notification Marker"
        description="Rendered after assistant message content when a notification was anchored to it via takode notify."
      >
        <div className="max-w-3xl">
          <Card label="needs-input (amber, no summary)">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">I've finished analyzing the logs. There are two approaches we could take:</p>
              <p className="text-cc-muted">1. Increase the timeout globally, or 2. Add retry logic per-request.</p>
              <NotificationMarker category="needs-input" />
            </div>
          </Card>
          <Card label="needs-input with summary">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">I've finished analyzing the logs. There are two approaches we could take:</p>
              <p className="text-cc-muted">1. Increase the timeout globally, or 2. Add retry logic per-request.</p>
              <NotificationMarker category="needs-input" summary="Need decision on auth approach" />
            </div>
          </Card>
          <Card label="needs-input with suggested answers">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The canary is healthy and ready for the next step.</p>
              <p className="text-cc-muted">Choose whether to continue the rollout now or hold for manual checks.</p>
              <PlaygroundSuggestedAnswerNotificationMarker />
            </div>
          </Card>
          <Card label="needs-input custom answer recording state">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The answer field is actively listening.</p>
              <p className="text-cc-muted">
                The mic button, status, and level meter share the composer recording language.
              </p>
              <PlaygroundNeedsInputRecordingPreview />
            </div>
          </Card>
          <Card label="needs-input custom answer transcription failure">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">A recorded answer failed to transcribe.</p>
              <p className="text-cc-muted">The field keeps the answer in place and offers a compact retry path.</p>
              <PlaygroundNeedsInputTranscriptionFailurePreview />
            </div>
          </Card>
          <Card label="needs-input with structured questions">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The release is ready for a final launch decision.</p>
              <p className="text-cc-muted">Answer both parts without moving focus to the composer.</p>
              <PlaygroundMultiQuestionNotificationMarker />
            </div>
          </Card>
          <Card label="addressed needs-input with suggested answers">
            <div className="text-cc-fg text-sm">
              <p className="mb-1">The rollout decision was answered.</p>
              <p className="text-cc-muted">No further reply is needed.</p>
              <PlaygroundAddressedSuggestedAnswerNotificationMarker />
            </div>
          </Card>
          <Card label="review (green, no summary)">
            <div className="text-cc-fg text-sm">
              <p>All changes have been committed and tests pass. The PR is ready for your review.</p>
              <PlaygroundReviewNotificationMarker />
            </div>
          </Card>
          <Card label="review with summary">
            <div className="text-cc-fg text-sm">
              <p>All changes have been committed and tests pass. The PR is ready for your review.</p>
              <PlaygroundReviewNotificationMarker summary="q-131: takode notify fixes ready" />
            </div>
          </Card>
          <Card label="deduped same-message authoritative + tool-use state">
            <PlaygroundDedupedNotificationMessage />
          </Card>
        </div>
      </Section>

      {/* ─── Work Board ──────────────────────────────────────────── */}
      <Section
        title="Work Board"
        description="Collapsible card rendered when a takode board command outputs board data. Shows quest/worker assignments and freeform status."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Collapsed command chip">
            <PlaygroundCollapsedBoardCommand />
          </Card>
          <Card label="Board with items">
            <BoardBlock
              defaultOpen
              operation="advanced q-42 to WORKING"
              queueWarnings={[
                {
                  questId: "q-61",
                  kind: "dispatchable",
                  summary: "q-61 can be dispatched now: wait-for resolved (q-50, #8).",
                  action: "Dispatch it now or replace QUEUED with the next active Quest Journey phase.",
                },
              ]}
              board={[
                {
                  questId: "q-42",
                  title: "Fix mobile sidebar overflow",
                  worker: "abc123",
                  workerNum: 5,
                  status: "WORKING",
                  waitForInput: ["n-3", "n-4"],
                  updatedAt: Date.now() - 60000,
                },
                {
                  questId: "q-55",
                  title: "Add dark mode toggle",
                  worker: "def456",
                  workerNum: 8,
                  status: "QUEUED",
                  waitFor: ["#5"],
                  updatedAt: Date.now() - 30000,
                },
                {
                  questId: "q-61",
                  title: "Optimize DB queries",
                  status: "QUEUED",
                  waitFor: ["q-50", "#8"],
                  updatedAt: Date.now(),
                },
              ]}
            />
          </Card>
          <Card label="Expanded board with raw inspection">
            <PlaygroundBoardWithOriginalCommand />
          </Card>
          <Card label="Optional Journey proposal">
            <BoardBlock
              defaultOpen
              operation="propose q-942"
              proposalReview={{
                questId: "q-942",
                title: "Make proposed Journey drafting intentional",
                status: "PROPOSED",
                presentedAt: Date.now() - 30000,
                summary:
                  "Goal / Acceptance: approve a proposal flow with a preset checkpoint inside Work. Scheduling: wait for the current approval prompt, then promote the proposed row.",
                journey: {
                  mode: "proposed",
                  presetId: "v2-work",
                  phaseIds: ["alignment", "work", "user-checkpoint", "memory"],
                  phaseNotes: {
                    "1": "Trace CLI, server, and UI paths during Work.",
                    "2": "Pause for the preset decision before Work resumes.",
                  },
                  presentation: {
                    state: "presented",
                    presentedAt: Date.now() - 30000,
                    signature: "playground",
                  },
                },
              }}
              board={[
                {
                  questId: "q-942",
                  title: "Make proposed Journey drafting intentional",
                  status: "PROPOSED",
                  waitForInput: ["n-3"],
                  journey: {
                    mode: "proposed",
                    presetId: "v2-work",
                    phaseIds: ["alignment", "work", "user-checkpoint", "memory"],
                  },
                  updatedAt: Date.now() - 30000,
                },
              ]}
            />
          </Card>
          <Card label="Journey phase summaries">
            <div className="p-3">
              <PlaygroundQuestJourneyPalette />
            </div>
          </Card>
          <Card label="Empty board">
            <BoardBlock board={[]} />
          </Card>
        </div>
      </Section>

      {/* ─── Work Board Bar (Persistent Widget) ────────────────────── */}
      <Section
        title="Work Board Bar"
        description="Persistent top thread navigator for orchestrator sessions. Shows summary (collapsed) and full board table (expanded). Expanded/collapsed state persists per session in the browser, and composer interaction should not auto-collapse it."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Work Board Bar (click to seed store, then interact)">
            <div className="p-3 space-y-3">
              <button
                type="button"
                onClick={() => {
                  const boardSessionId = PLAYGROUND_BOARD_SESSION_ID;
                  // Seed Zustand store with mock board and orchestrator session
                  const state = useStore.getState();
                  const now = Date.now();
                  const baseSession = state.sessions.get(MOCK_SESSION_ID);
                  if (!baseSession) throw new Error("Playground base session is not seeded");
                  state.addSession({
                    ...baseSession,
                    session_id: boardSessionId,
                    cwd: "/mock/playground",
                    is_containerized: false,
                    isOrchestrator: true,
                  });
                  const mediumRepeatedJourneyPhaseIds: QuestJourneyPhaseId[] = [
                    "alignment",
                    ...Array.from({ length: 4 }, () => ["work", "user-checkpoint"] as const).flat(),
                    "memory",
                  ];
                  const boardData: BoardRowData[] = [
                    {
                      questId: "q-42",
                      title: "Fix mobile sidebar overflow",
                      worker: "abc123",
                      workerNum: 5,
                      status: "WORKING",
                      waitForInput: ["n-3"],
                      updatedAt: now - 60000,
                      journey: {
                        mode: "active" as const,
                        phaseIds: mediumRepeatedJourneyPhaseIds,
                        currentPhaseId: "work",
                        activePhaseIndex: 7,
                        phaseNotes: {
                          "5": "Sixth previous phase hidden by default in tab hover previews.",
                          "6": "First visible previous phase for the tab hover clamp.",
                        },
                        phaseTimings: Object.fromEntries(
                          Array.from({ length: 8 }, (_, index) => [
                            String(index),
                            index === 7
                              ? { startedAt: now - 60_000 }
                              : { startedAt: now - (8 - index) * 60_000, endedAt: now - (7 - index) * 60_000 },
                          ]),
                        ),
                      },
                    },
                    {
                      questId: "q-55",
                      title: "Add dark mode toggle",
                      worker: "def456",
                      workerNum: 8,
                      status: "QUEUED",
                      waitFor: ["#5"],
                      updatedAt: now - 30000,
                      journey: {
                        mode: "proposed" as const,
                        phaseIds: ["alignment", "work", "memory"],
                      },
                    },
                    {
                      questId: "q-61",
                      title: "Optimize DB queries",
                      status: "PROPOSED",
                      waitForInput: ["n-19"],
                      updatedAt: now,
                      journey: {
                        mode: "proposed" as const,
                        phaseIds: ["alignment", "work", "user-checkpoint", "memory"],
                      },
                    },
                  ];
                  state.setSessionBoard(boardSessionId, boardData);
                  state.setSessionStatus(boardSessionId, "running");
                  state.setActiveTurnRoute(boardSessionId, { threadKey: "q-42", questId: "q-42" });
                  state.setSessionBoardRowStatuses(boardSessionId, {
                    "q-42": {
                      worker: {
                        sessionId: "playground-board-worker",
                        sessionNum: 5,
                        name: "Clear Mesa",
                        status: "running",
                      },
                    },
                    "q-55": {
                      worker: {
                        sessionId: "playground-board-worker-queued",
                        sessionNum: 8,
                        name: "Queued Worker",
                        status: "idle",
                      },
                      reviewer: null,
                    },
                    "q-61": {
                      worker: {
                        sessionId: "playground-board-worker-proposed",
                        sessionNum: 9,
                        name: "Proposal Worker",
                        status: "disconnected",
                      },
                      reviewer: null,
                    },
                    "q-88": {
                      worker: {
                        sessionId: "playground-board-worker-done",
                        sessionNum: 10,
                        name: "Done Worker",
                        status: "archived",
                      },
                      reviewer: {
                        sessionId: "playground-board-reviewer-done",
                        sessionNum: 11,
                        name: "Done Reviewer",
                        status: "archived",
                      },
                    },
                  });
                  state.setSessionCompletedBoard(boardSessionId, [
                    {
                      questId: "q-88",
                      title: "Reviewed collapsed-result handling",
                      status: "DONE",
                      updatedAt: now - 120000,
                      completedAt: now - 110000,
                      journey: {
                        mode: "active" as const,
                        phaseIds: ["alignment", "work", "memory"],
                        currentPhaseId: "memory",
                        phaseTimings: {
                          "0": { startedAt: now - 300_000, endedAt: now - 240_000 },
                          "1": { startedAt: now - 240_000, endedAt: now - 120_000 },
                          "2": { startedAt: now - 120_000, endedAt: now - 110_000 },
                        },
                      },
                    },
                  ]);
                  state.setSessionAttentionRecords(boardSessionId, [
                    {
                      id: "playground-board-bar-main-input",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-main-input" },
                      threadKey: "main",
                      title: "Main needs input",
                      summary: "The leader has a Main-thread decision to make.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 55_000,
                      updatedAt: now - 11_000,
                      route: { threadKey: "main" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-main-input",
                    },
                    {
                      id: "playground-board-bar-chip",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-chip", questId: "q-42" },
                      questId: "q-42",
                      threadKey: "q-42",
                      title: "q-42 needs input",
                      summary: "The current worker has a question before continuing.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 50_000,
                      updatedAt: now - 10_000,
                      route: { threadKey: "q-42", questId: "q-42" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-chip",
                    },
                    {
                      id: "playground-board-bar-rework",
                      leaderSessionId: boardSessionId,
                      type: "quest_reopened_or_rework",
                      source: { kind: "message", id: "playground-board-bar-rework", questId: "q-77" },
                      questId: "q-77",
                      threadKey: "q-77",
                      title: "q-77 rework requested",
                      summary: "The thread was reopened after user feedback.",
                      actionLabel: "Open",
                      priority: "milestone",
                      state: "reopened",
                      createdAt: now - 40_000,
                      updatedAt: now - 20_000,
                      route: { threadKey: "q-77", questId: "q-77" },
                      chipEligible: false,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-rework",
                    },
                    {
                      id: "playground-board-bar-closed-chip-input",
                      leaderSessionId: boardSessionId,
                      type: "needs_input",
                      source: { kind: "notification", id: "playground-board-bar-closed-chip-input", questId: "q-61" },
                      questId: "q-61",
                      threadKey: "q-61",
                      title: "q-61 needs input",
                      summary: "The queued thread is blocked on a decision.",
                      actionLabel: "Answer",
                      priority: "needs_input",
                      state: "unresolved",
                      createdAt: now - 25_000,
                      updatedAt: now - 12_000,
                      route: { threadKey: "q-61", questId: "q-61" },
                      chipEligible: true,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-closed-chip-input",
                    },
                    {
                      id: "playground-board-bar-review",
                      leaderSessionId: boardSessionId,
                      type: "quest_completed_recent",
                      source: { kind: "board", id: "q-88", questId: "q-88", signature: "finished" },
                      questId: "q-88",
                      threadKey: "q-88",
                      title: "Journey finished",
                      summary: "Review inbox copy",
                      actionLabel: "Open",
                      priority: "review",
                      state: "unresolved",
                      createdAt: now - 30_000,
                      updatedAt: now - 15_000,
                      route: { threadKey: "q-88", questId: "q-88" },
                      chipEligible: false,
                      ledgerEligible: true,
                      dedupeKey: "playground-board-bar-review",
                    },
                  ]);
                  const completedRow = useStore.getState().sessionCompletedBoards.get(boardSessionId)?.[0];
                  const visualRows = new Map(
                    [...boardData, ...(completedRow ? [completedRow] : [])].map((row) => [row.questId, row]),
                  );
                  const projectedAttention = (needsInput = false, reviewUnread = false, updatedAt = 0) => ({
                    needsInput,
                    mutedNeedsInput: false,
                    reviewUnread,
                    updatedAt,
                  });
                  const projectedTabs = boardOpenThreadKeys.map((threadKey) => {
                    const row = visualRows.get(threadKey);
                    const completed = threadKey === "q-88" || threadKey === "q-1932";
                    const queued = !completed && row?.status === "QUEUED";
                    const proposed = !completed && row?.status === "PROPOSED";
                    const needsInput = threadKey === "q-42" || threadKey === "q-61";
                    const reviewUnread = threadKey === "q-1932";
                    const fallback = playgroundFallbackTab(threadKey);
                    return {
                      ...fallback,
                      title: row?.title ?? fallback.title,
                      boardStatus: row?.status ?? (completed ? "DONE" : null),
                      journey: buildPlaygroundProjectedJourney(row, completed),
                      sourceRowCreatedAt: row?.createdAt ?? null,
                      workerSessionId: row?.worker ?? null,
                      workerSessionNum: row?.workerNum ?? null,
                      active: !queued && !proposed && !completed && row?.status === "WORKING",
                      queued,
                      proposed,
                      neverStartedScheduled: queued || proposed,
                      completed,
                      canClose: row?.status !== "WORKING",
                      attention: projectedAttention(needsInput, reviewUnread, row?.updatedAt ?? now),
                      updatedAt: row?.updatedAt ?? now,
                    } satisfies LeaderThreadTabsProjectionTab;
                  });
                  applyPlaygroundBoardProjection({
                    currentQuestStateVersion: 1,
                    tabState: { version: 1 },
                    tabs: projectedTabs,
                    mainAttention: projectedAttention(true, false, now),
                    threadStatuses: {
                      "q-88": {
                        kind: "waiting",
                        label: "Thread Waiting",
                        threadKey: "q-88",
                        questId: "q-88",
                        summary: "awaiting a read-only worker follow-up",
                        messageId: "playground-board-bar-q88-waiting",
                        timestamp: now - 10_000,
                        updatedAt: now - 10_000,
                      },
                    },
                    activePhaseSummary: [{ label: "Work", count: 1, tone: "phase" }],
                  });
                  const questIds = ["q-42", "q-55", "q-61", "q-77", "q-88", "q-99", "q-1932"];
                  const quests = state.quests
                    .filter((quest) => !questIds.includes(quest.questId))
                    .concat([
                      {
                        id: "q-42-v1",
                        questId: "q-42",
                        version: 1,
                        title: "Fix mobile sidebar overflow",
                        status: "in_progress" as const,
                        description: "Keep narrow mobile layouts from clipping the primary shell.",
                        tldr: "Medium-long repeated Journey for tab hover clamp checks: current row 12 should show only five prior phases by default.",
                        createdAt: now - 4_800_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 3_600_000,
                        leaderSessionId: boardSessionId,
                        tags: ["ui", "mobile", "journey"],
                      },
                      {
                        id: "q-55-v1",
                        questId: "q-55",
                        version: 1,
                        title: "Add dark mode toggle",
                        status: "refined" as const,
                        description: "Queued UI control work with proposed Journey metadata.",
                        createdAt: now - 3_900_000,
                        tags: ["ui"],
                      },
                      {
                        id: "q-61-v1",
                        questId: "q-61",
                        version: 1,
                        title: "Optimize DB queries",
                        status: "refined" as const,
                        description: "Proposal row used to exercise non-current Journey preview rendering.",
                        createdAt: now - 3_600_000,
                        tags: ["backend"],
                      },
                      {
                        id: "q-77-v1",
                        questId: "q-77",
                        version: 1,
                        title: "Off-board routed discussion",
                        status: "in_progress" as const,
                        description: "Off-board thread surfaced by attention, without active Journey metadata.",
                        createdAt: now - 3_000_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 2_900_000,
                        tags: ["threads"],
                      },
                      {
                        id: "q-88-v2",
                        questId: "q-88",
                        version: 2,
                        title: "Reviewed collapsed-result handling",
                        status: "done" as const,
                        description: "Completed quest retained in history with Journey preview data.",
                        tldr: "Completed hover-card state with finished time, summary, and Journey preview.",
                        createdAt: now - 7_200_000,
                        completedAt: now - 110_000,
                        verificationItems: [],
                        tags: ["done", "journey"],
                      },
                      {
                        id: "q-99-v1",
                        questId: "q-99",
                        version: 1,
                        title: "Newly moved user request",
                        status: "in_progress" as const,
                        description: "Recently created quest tab used for insertion and hover preview checks.",
                        createdAt: now - 45_000,
                        sessionId: "playground-board-worker",
                        claimedAt: now - 30_000,
                        tags: ["threads"],
                      },
                    ]);
                  const questTitlePreviews = new Map(state.questTitlePreviews);
                  questTitlePreviews.set("q-1932", {
                    questId: "q-1932",
                    title: "Resolve VSCode QA Stack Conflicts",
                    version: 3,
                    updatedAt: now - 600_000,
                  });
                  const playgroundSessionIds = [
                    boardSessionId,
                    "playground-board-worker",
                    "playground-board-reviewer",
                    "playground-board-worker-queued",
                    "playground-board-worker-proposed",
                    "playground-board-worker-done",
                    "playground-board-reviewer-done",
                  ];
                  const existing = state.sdkSessions.filter((s) => !playgroundSessionIds.includes(s.sessionId));
                  useStore.setState({
                    sdkSessions: [
                      ...existing,
                      {
                        sessionId: boardSessionId,
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now,
                        isOrchestrator: true,
                        sessionNum: 402,
                      },
                      {
                        sessionId: "playground-board-worker",
                        state: "running",
                        cwd: "/mock/playground",
                        createdAt: now - 3_600_000,
                        sessionNum: 5,
                        herdedBy: boardSessionId,
                        name: "Clear Mesa",
                      },
                      {
                        sessionId: "playground-board-reviewer",
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now - 2_400_000,
                        sessionNum: 6,
                        name: "Review Lead",
                      },
                      {
                        sessionId: "playground-board-worker-queued",
                        state: "connected",
                        cwd: "/mock/playground",
                        createdAt: now - 2_000_000,
                        sessionNum: 8,
                        name: "Queued Worker",
                      },
                      {
                        sessionId: "playground-board-worker-proposed",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 1_800_000,
                        sessionNum: 9,
                        name: "Proposal Worker",
                      },
                      {
                        sessionId: "playground-board-worker-done",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 6_000_000,
                        sessionNum: 10,
                        name: "Done Worker",
                      },
                      {
                        sessionId: "playground-board-reviewer-done",
                        state: "exited",
                        cwd: "/mock/playground",
                        createdAt: now - 5_000_000,
                        sessionNum: 11,
                        name: "Done Reviewer",
                      },
                    ],
                    quests,
                    questTitlePreviews,
                  });
                }}
                className="text-xs font-medium px-3 py-1.5 rounded-md bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 transition-colors cursor-pointer"
              >
                Seed board data
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextKeys = ["q-99", ...boardOpenThreadKeys.filter((key) => key !== "q-99")];
                  setBoardOpenThreadKeys(nextKeys);
                  applyPlaygroundBoardTabKeys(nextKeys);
                  setBoardPreviewThreadKey("q-99");
                }}
                className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 transition-colors cursor-pointer"
              >
                Simulate moved-message tab
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextKeys = ["q-88", ...boardOpenThreadKeys.filter((key) => key !== "q-88")];
                  setBoardOpenThreadKeys(nextKeys);
                  applyPlaygroundBoardTabKeys(nextKeys);
                  setBoardPreviewThreadKey("main");
                }}
                className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 transition-colors cursor-pointer"
              >
                Show waiting completed tab
              </button>
              <button
                type="button"
                onClick={() => {
                  const crowdKeys = Array.from({ length: 12 }, (_, index) => `q-${1101 + index}`);
                  const nextKeys = ["q-42", ...crowdKeys, "q-55", "q-61", "q-77", "q-88"];
                  setBoardOpenThreadKeys(nextKeys);
                  applyPlaygroundBoardTabKeys(nextKeys);
                  setBoardPreviewThreadKey(crowdKeys.at(-1) ?? "main");
                }}
                className="ml-2 text-xs font-medium px-3 py-1.5 rounded-md bg-violet-500/15 hover:bg-violet-500/25 text-violet-200 transition-colors cursor-pointer"
              >
                Simulate desktop tab crowd
              </button>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("main")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "main"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg"
                  }`}
                >
                  Main banner
                </button>
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("q-42")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "q-42"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg"
                  }`}
                >
                  Quest thread
                </button>
                <button
                  type="button"
                  onClick={() => setBoardPreviewThreadKey("all")}
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    boardPreviewThreadKey === "all"
                      ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                      : "border-cc-border/45 bg-transparent text-cc-muted hover:bg-cc-hover/45 hover:text-cc-fg"
                  }`}
                >
                  All Threads
                </button>
              </div>
              <div className="max-w-[28rem] border border-cc-border rounded-lg overflow-visible">
                <WorkBoardBar
                  sessionId="playground-board-bar"
                  currentThreadKey={boardPreviewThreadKey}
                  onSelectThread={setBoardPreviewThreadKey}
                  openThreadKeys={boardOpenThreadKeys}
                  onCloseThreadTab={(threadKey, nextThreadKey) => {
                    const nextKeys = boardOpenThreadKeys.filter((key) => key !== threadKey);
                    setBoardOpenThreadKeys(nextKeys);
                    applyPlaygroundBoardTabKeys(nextKeys);
                    setBoardPreviewThreadKey((current) => (current === threadKey ? nextThreadKey : current));
                  }}
                  threadRows={[
                    {
                      threadKey: "q-99",
                      questId: "q-99",
                      title: "Newly moved user request",
                      messageCount: 1,
                      section: "active",
                    },
                    {
                      threadKey: "q-42",
                      questId: "q-42",
                      title: "Fix mobile sidebar overflow",
                      messageCount: 5,
                      section: "active",
                    },
                    {
                      threadKey: "q-55",
                      questId: "q-55",
                      title: "Add dark mode toggle",
                      messageCount: 3,
                      section: "active",
                    },
                    {
                      threadKey: "q-61",
                      questId: "q-61",
                      title: "Optimize DB queries",
                      messageCount: 2,
                      section: "active",
                    },
                    {
                      threadKey: "q-77",
                      questId: "q-77",
                      title: "Off-board routed discussion",
                      messageCount: 1,
                      section: "active",
                    },
                    {
                      threadKey: "q-88",
                      questId: "q-88",
                      title: "Reviewed collapsed-result handling",
                      messageCount: 2,
                      section: "done",
                    },
                    {
                      threadKey: "q-1932",
                      questId: "q-1932",
                      title: "q-1932",
                      messageCount: 9,
                      section: "done",
                    },
                    ...(boardOpenThreadKeys.some((threadKey) => threadKey.startsWith("q-11"))
                      ? Array.from({ length: 12 }, (_, index) => {
                          const questId = `q-${1101 + index}`;
                          return {
                            threadKey: questId,
                            questId,
                            title: `Desktop tab ${index + 1} with readable context`,
                            messageCount: index + 1,
                            section: "active" as const,
                          };
                        })
                      : []),
                  ]}
                />
              </div>
              <p className="text-[10px] text-cc-muted">
                Click "Seed board data" first. The constrained width keeps several open tabs visible while hidden tabs
                collapse into More for tab sizing, phase color, close affordance, overflow, and insertion checks. Hover
                q-42 to inspect the shared quest hover card with a medium-long repeated Journey clamped around current
                row 12. The retained q-1932 tab is absent from the paged quest list and recovers its canonical title
                only from the bounded title projection. q-88 is completed but has authoritative Thread Waiting; use the
                dedicated control to keep it visible while Main remains selected. The active-output route targets q-42
                so Main stays visually quiet.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      <PlaygroundQuestStatusPanelSection />
      <PlaygroundQuestmasterCompactSection />

      <Section
        title="Codex Reasoning Details"
        description="Persistent chronological summaries, including grouped adjacent runs that preview the newest title and expand to the complete ordered audit."
      >
        <div className="max-w-3xl">
          <Card label="Persistent reasoning detail states">
            <div className="p-3">
              <PlaygroundReasoningDetailStates />
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Leader And Worker Activity Chips"
        description="Session-owned activity state: worker projection remains visible without turning an idle leader into a running session."
      >
        <div className="max-w-4xl">
          <Card label="Leader and worker lifecycle boundaries">
            <div className="p-3">
              <PlaygroundLeaderActivityStates />
            </div>
          </Card>
        </div>
      </Section>

      <PlaygroundTodoStates />

      <PlaygroundCodexInstructionsSection />
      <PlaygroundTimerStates />

      <PlaygroundNotificationInboxSection />

      <PlaygroundQuestDetailModalSection />

      <Section
        title="Hover Cross-links"
        description="Quest and session markdown hovers cross-link through compact chips and preserve orchestration context inside the existing hover cards."
      >
        <div className="max-w-3xl space-y-4">
          <Card label="Quest hover shows orchestration">
            <PlaygroundHoverCrossLinkDemo text="Hover [q-418](quest:q-418) to see status, Journey, owner, and leader metadata in the quest hover preview." />
          </Card>
          <Card label="Session hover shows active quest">
            <PlaygroundHoverCrossLinkDemo text="Hover [#566](session:566) to see the worker's active quest chip and needs-input status line in the session hover preview." />
          </Card>
          <Card label="Leader hover shows active quests">
            <PlaygroundHoverCrossLinkDemo text="Hover [#565](session:565) to see active leader board quests with colored phase labels and normal titles." />
          </Card>
          <Card label="Message link hover focuses the referenced message">
            <PlaygroundMessageLinkHoverDemo />
          </Card>
        </div>
      </Section>
    </PlaygroundSectionGroup>
  );
}
