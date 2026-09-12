import {
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  type KeyboardEvent,
  type MouseEvent,
  Fragment,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { connectSession, sendToSession } from "../ws.js";
import { formatWaitForRefLabel, getWaitForRefKind } from "../../shared/quest-journey.js";
import type { LeaderThreadTabsProjectionJourney } from "../../shared/leader-thread-tabs-projection.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { NotifyMeControl } from "./NotifyMe.js";
import { SideChatPanel } from "./SideChatPanel.js";
import {
  PermissionBanner,
  PlanReviewOverlay,
  PlanCollapsedChip,
  PermissionsCollapsedChip,
} from "./PermissionBanner.js";
import { TaskOutlineBar } from "./TaskOutlineBar.js";
import { TodoStatusLine } from "./TodoStatusLine.js";
import { WorkBoardBar, type WorkBoardThreadNavigationRow } from "./WorkBoardBar.js";
import { YarnBallDot } from "./CatIcons.js";
import { SearchBar } from "./SearchBar.js";
import { useSessionSearch } from "../hooks/useSessionSearch.js";
import { hasMessageDeepLinkFromHash, navigateToSessionThread, threadRouteFromHash } from "../utils/routing.js";
import type { BoardRowData } from "./BoardTable.js";
import {
  isCompletedJourneyPresentationStatus,
  QuestJourneyPreviewCard,
  QuestJourneyTimeline,
} from "./QuestJourneyTimeline.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { ModelProvenanceMigrationBanner } from "./ModelProvenanceMigrationBanner.js";
import { useParticipantSessionStatusDotProps } from "./session-participant-status.js";
import {
  QUEST_PARTICIPANT_CHIP_CLASS,
  QUEST_PARTICIPANT_NAME_CLASS,
  QUEST_PARTICIPANT_SESSION_CLASS,
} from "./quest-participant-chip-style.js";
import { SessionRoleLabel } from "./SessionRoleLabel.js";
import { commitCountLabel } from "./QuestCommitEvidence.js";
import { useQuestCodeCommitShas } from "./QuestCommitDiffView.js";
import {
  buildLeaderThreadRowsFromSummaries,
  collectLeaderThreadSummaries,
  mergeLeaderThreadSummaries,
} from "../../shared/leader-projection.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "../utils/thread-projection.js";
import { resolveNotificationOwnerThreadKey } from "../utils/notification-thread.js";
import {
  persistLeaderSelectedThreadKey,
  readLeaderSelectedThreadKey,
  requestThreadViewportSnapshot,
} from "../utils/thread-viewport.js";
import { ViewportHandoffThreadEntryGate } from "./ViewportHandoffEntryGate.js";
import { createViewportHandoffEntryId, noteViewportSelectionActivity } from "../utils/viewport-handoff-client.js";
import { resolveInitialLeaderThreadKey } from "../utils/initial-leader-thread.js";
import { applyCanonicalQuestTitles, buildCanonicalQuestTitleIndex } from "../utils/quest-title-index.js";
import {
  buildAttentionRecords,
  isAttentionRecordActive,
  parseQuestIdsFromReviewSummary,
} from "../utils/attention-records.js";
import { getQuestStatusTheme } from "../utils/quest-status-theme.js";
import {
  beginThreadNavigationTiming,
  markColdReplayFlushCommitted,
  markThreadNavigationCommitted,
} from "../utils/frontend-perf-recorder.js";
import { readOpenThreadTabKeys } from "../utils/leader-open-thread-tabs.js";
import {
  placeLeaderOpenThreadTabKey,
  reorderLeaderOpenThreadKeys,
  shouldPersistLeaderThreadTab,
  type LeaderOpenThreadTabsState,
  type LeaderThreadTabUpdate,
} from "../../shared/leader-open-thread-tabs.js";
import {
  getLiveSessionConnectionStatus,
  getRecoverableSessionConnectionPresentation,
} from "../utils/recoverable-session-connection.js";
import { findSessionQuestContextCandidate } from "../utils/session-quest-context.js";
import { resolveSessionNavigation, type ResolvedSessionNavigation } from "../utils/session-navigation-resolver.js";
import { resolveChatSessionNavigationSummary } from "../utils/chat-session-navigation-summary.js";
export { resolveChatSessionNavigationSummary } from "../utils/chat-session-navigation-summary.js";
import {
  projectedLeaderOpenThreadTabs,
  resolveLeaderThreadTabsProjection,
} from "../utils/leader-thread-tabs-resolver.js";
import { mergeProjectedLeaderThreadRows } from "../utils/leader-thread-tabs-navigation.js";
import { useLeaderOpenThreadTabStateSync } from "../hooks/use-leader-open-thread-tab-state-sync.js";
import type {
  BoardRowSessionStatus,
  ChatMessage,
  LeaderProjectionSnapshot,
  QuestTitlePreview,
  QuestmasterTask,
  SessionAttentionRecord,
  SessionNotification,
  SessionState,
  SideChatRecord,
} from "../types.js";

export interface QuestThreadBannerRow {
  threadKey: string;
  questId?: string;
  title: string;
  status?: string;
  boardStatus?: string;
  journey?: BoardRowData["journey"];
  journeyDurationSummary?: LeaderThreadTabsProjectionJourney["durationSummary"];
  boardRow?: BoardRowData;
  rowStatus?: BoardRowSessionStatus;
  leaderSessionId?: string | null;
  leaderSessionNum?: number | null;
  /** Legacy row snapshot; commit UI resolves from the fresher exact quest projection. */
  commitShas?: string[];
  section?: "active" | "done";
}

type LeaderThreadRow = QuestThreadBannerRow & {
  messageCount: number;
  createdAt: number;
};

const EMPTY_BOARD_ROWS: BoardRowData[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ATTENTION_RECORDS: SessionAttentionRecord[] = [];
const EMPTY_SIDE_CHATS: Record<string, SideChatRecord> = {};
const EMPTY_QUEST_DETAILS = new Map<string, QuestmasterTask>();
const EMPTY_QUEST_TITLE_PREVIEWS = new Map<string, QuestTitlePreview | null>();

export function reviewNotificationIdsForSelectedThread(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  attentionRecords: ReadonlyArray<SessionAttentionRecord>,
  selectedThreadKey: string,
): string[] {
  const selected = normalizeThreadKey(selectedThreadKey || MAIN_THREAD_KEY);
  if (selected === ALL_THREADS_KEY) return [];

  const effectiveThreadsByNotificationId = new Map<string, Set<string>>();
  for (const record of attentionRecords) {
    if (record.priority !== "review" || record.source.kind !== "notification" || !record.source.id) continue;
    if (!isAttentionRecordActive(record)) continue;
    const threadKey = normalizeThreadKey(record.route.threadKey || record.threadKey);
    const threads = effectiveThreadsByNotificationId.get(record.source.id) ?? new Set<string>();
    threads.add(threadKey);
    effectiveThreadsByNotificationId.set(record.source.id, threads);
  }

  const ids: string[] = [];
  for (const notification of notifications ?? []) {
    if (notification.done || notification.category !== "review") continue;
    const parsedMultiQuestThreads = parseQuestIdsFromReviewSummary(notification.summary);
    const effectiveThreads =
      parsedMultiQuestThreads.length > 1
        ? new Set(parsedMultiQuestThreads.map((threadKey) => normalizeThreadKey(threadKey)))
        : effectiveThreadsByNotificationId.get(notification.id);
    if (
      effectiveThreads ? !effectiveThreads.has(selected) : resolveNotificationOwnerThreadKey(notification) !== selected
    ) {
      continue;
    }
    ids.push(notification.id);
  }
  return ids;
}

type LiveConnectionStatusBannerProps = {
  status:
    | "starting"
    | "broken"
    | "recovery-suppressed"
    | "cli-disconnected"
    | "websocket-disconnected"
    | "server-unreachable";
  backendState?: string;
  backendError?: string | null;
  reconnectProgress?: SessionState["backend_reconnect"];
  hasEverConnected?: boolean;
  idlePaused?: boolean;
  isResumeMissingRolloutError?: boolean;
  onRelaunch?: () => void;
};

function LiveConnectionStatusBanner({
  status,
  backendState,
  backendError,
  reconnectProgress,
  hasEverConnected = false,
  idlePaused = false,
  isResumeMissingRolloutError = false,
  onRelaunch,
}: LiveConnectionStatusBannerProps) {
  const isWarning = status === "server-unreachable" || status === "broken" || status === "recovery-suppressed";
  const message =
    status === "server-unreachable"
      ? "Server unreachable"
      : status === "websocket-disconnected"
        ? "Reconnecting to session..."
        : status === "recovery-suppressed"
          ? (backendError ?? "Automatic recovery is paused. Reconnect to start a fresh cycle.")
          : status === "broken"
            ? (backendError ?? "CLI failed to recover. Relaunch to resume queued messages.")
            : status === "cli-disconnected"
              ? idlePaused
                ? "Session paused to stay within keep-alive limit"
                : "Keep working here. Takode reconnects when delivery needs the backend."
              : backendState === "recovering"
                ? reconnectProgress
                  ? `Reconnecting (${reconnectProgress.attempt}/${reconnectProgress.maxAttempts})...`
                  : "Recovering session..."
                : backendState === "resuming" || hasEverConnected
                  ? "Reconnecting session..."
                  : "Starting session...";

  return (
    <div
      data-testid="live-connection-status-banner"
      role="status"
      aria-live="polite"
      className={`shrink-0 border-t px-3 py-2 sm:px-4 ${
        isWarning ? "border-cc-warning/25 bg-cc-warning/10" : "border-cc-border bg-cc-border/30"
      }`}
    >
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 text-center sm:gap-3">
        {status === "starting" ? (
          <svg
            className="h-3 w-3 shrink-0 animate-spin text-cc-text-secondary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${isWarning ? "bg-cc-warning animate-pulse" : "bg-cc-muted"}`}
            aria-hidden="true"
          />
        )}
        <span className={`min-w-0 text-xs font-medium ${isWarning ? "text-cc-warning" : "text-cc-text-secondary"}`}>
          {message}
        </span>
        {(status === "broken" || status === "recovery-suppressed" || status === "cli-disconnected") && onRelaunch && (
          <button
            type="button"
            onClick={onRelaunch}
            className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors cursor-pointer ${
              isWarning
                ? "bg-cc-warning/20 text-cc-warning hover:bg-cc-warning/30"
                : "bg-cc-hover text-cc-fg hover:bg-cc-border"
            }`}
          >
            {status === "broken" && isResumeMissingRolloutError
              ? "Start Fresh"
              : status === "broken"
                ? "Relaunch"
                : status === "recovery-suppressed"
                  ? "Reconnect"
                  : "Resume"}
          </button>
        )}
      </div>
    </div>
  );
}

function isDoneThreadRow(row: QuestThreadBannerRow): boolean {
  return (
    row.boardRow?.completedAt !== undefined ||
    isCompletedJourneyPresentationStatus(row.status) ||
    isCompletedJourneyPresentationStatus(row.boardStatus)
  );
}

function journeyStatusForThread(row: QuestThreadBannerRow): string | undefined {
  return isDoneThreadRow(row) ? "done" : row.boardStatus;
}

function QuestJourneyHoverTarget({ row, children }: { row: QuestThreadBannerRow; children: ReactNode }) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);
  const cardWidth = 380;
  const gap = 6;

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!cardRef.current || !hoverRect) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - cardWidth - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, hoverRect.top - rect.height - gap)}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [hoverRect]);

  function showPreviewForTarget(target: HTMLElement) {
    if (!row.journey?.phaseIds?.length) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(target.getBoundingClientRect());
  }

  function showPreview(event: MouseEvent<HTMLDivElement>) {
    showPreviewForTarget(event.currentTarget);
  }

  function handlePreviewKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    showPreviewForTarget(event.currentTarget);
  }

  function scheduleHidePreview() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <div
        className="inline-flex max-w-full min-w-0"
        onMouseEnter={showPreview}
        onMouseLeave={scheduleHidePreview}
        onClick={(event) => showPreviewForTarget(event.currentTarget)}
        onKeyDown={handlePreviewKeyDown}
        role={row.journey?.phaseIds?.length ? "button" : undefined}
        tabIndex={row.journey?.phaseIds?.length ? 0 : undefined}
        aria-label={row.journey?.phaseIds?.length ? "Show Quest Journey preview" : undefined}
        aria-haspopup={row.journey?.phaseIds?.length ? "dialog" : undefined}
        aria-expanded={hoverRect ? "true" : "false"}
        data-testid="quest-thread-journey-hover-target"
        data-touch-preview={row.journey?.phaseIds?.length ? "true" : "false"}
      >
        {children}
      </div>
      {row.journey &&
        hoverRect &&
        createPortal(
          <div
            ref={cardRef}
            className="fixed z-50 pointer-events-auto"
            style={{
              left: hoverRect.left,
              top: hoverRect.bottom + gap,
              width: cardWidth,
              transform: `scale(${zoomLevel})`,
              transformOrigin: "top left",
            }}
            onMouseEnter={() => {
              if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={() => setHoverRect(null)}
            data-testid="quest-thread-journey-hover-card"
          >
            <div className="rounded-lg border border-cc-border bg-cc-card p-2.5 shadow-xl">
              <QuestJourneyPreviewCard
                journey={row.journey}
                status={journeyStatusForThread(row)}
                durationSummary={row.journeyDurationSummary}
                quest={{ questId: row.questId ?? row.threadKey, title: row.title }}
                onQuestClick={() => useStore.getState().openQuestOverlay(row.questId ?? row.threadKey)}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

type QuestBannerVariant = "thread" | "session";
type QuestBannerParticipantRole = "Worker" | "Reviewer" | "Leader";
type QuestBannerWaitCondition = { kind: "queued"; refs: string[] } | { kind: "user-input"; refs: string[] };
type QuestBannerQueuedWaitCondition = Extract<QuestBannerWaitCondition, { kind: "queued" }>;

function findQuestById(quests: QuestmasterTask[], questId?: string | null): QuestmasterTask | undefined {
  if (!questId) return undefined;
  const normalized = questId.toLowerCase();
  return quests.find((quest) => quest.questId.toLowerCase() === normalized);
}

function findQuestBoardContext({
  questId,
  leaderSessionId,
  sessionBoards,
  sessionCompletedBoards,
  rowStatuses,
}: {
  questId: string;
  leaderSessionId?: string | null;
  sessionBoards: ReadonlyMap<string, readonly BoardRowData[]>;
  sessionCompletedBoards: ReadonlyMap<string, readonly BoardRowData[]>;
  rowStatuses: ReadonlyMap<string, Record<string, BoardRowSessionStatus>>;
}): { row?: BoardRowData; rowStatus?: BoardRowSessionStatus; leaderSessionId?: string } {
  const normalizedQuestId = questId.toLowerCase();
  const preferredLeaderId = leaderSessionId ?? undefined;
  const leaderIds = [
    ...(preferredLeaderId ? [preferredLeaderId] : []),
    ...[...sessionBoards.keys(), ...sessionCompletedBoards.keys()].filter((id) => id !== preferredLeaderId),
  ];

  for (const candidateLeaderId of leaderIds) {
    const row =
      sessionBoards
        .get(candidateLeaderId)
        ?.find((candidate) => candidate.questId.toLowerCase() === normalizedQuestId) ??
      sessionCompletedBoards
        .get(candidateLeaderId)
        ?.find((candidate) => candidate.questId.toLowerCase() === normalizedQuestId);
    const rowStatus =
      rowStatuses.get(candidateLeaderId)?.[questId] ?? rowStatuses.get(candidateLeaderId)?.[normalizedQuestId];
    if (row || rowStatus) return { row, rowStatus, leaderSessionId: candidateLeaderId };
  }

  return {};
}

function QuestBannerParticipantChip({
  role,
  participant,
  sessionId: explicitSessionId,
  fallbackSessionId,
  fallbackSessionNum,
  currentSessionId,
  threadKey,
  showDisplayName = true,
}: {
  role: QuestBannerParticipantRole;
  participant?: BoardRowSessionStatus["worker"] | BoardRowSessionStatus["reviewer"] | null;
  sessionId?: string | null;
  fallbackSessionId?: string;
  fallbackSessionNum?: number;
  currentSessionId?: string;
  threadKey?: string | null;
  showDisplayName?: boolean;
}) {
  const candidateSessionId = participant?.sessionId ?? explicitSessionId ?? fallbackSessionId ?? null;
  const candidateSessionNum = participant?.sessionNum ?? fallbackSessionNum ?? undefined;
  const resolvedNavigation = useStore((s) => {
    if (candidateSessionId) return resolveSessionNavigation(s, candidateSessionId);
    if (candidateSessionNum == null) return null;
    for (const sdkSession of s.sdkSessions) {
      const candidate = resolveSessionNavigation(s, sdkSession.sessionId);
      if (participantNavigationMatchesSessionNum(candidate, sdkSession.sessionNum, candidateSessionNum)) {
        return candidate;
      }
    }
    return null;
  });
  const sessionId = candidateSessionId ?? resolvedNavigation?.viewModel.sessionId ?? null;
  const { sessionNum, displayName } = resolveQuestBannerParticipantIdentity(
    resolvedNavigation,
    candidateSessionNum,
    participant?.name,
  );
  const dotProps = useParticipantSessionStatusDotProps(sessionId, participant?.status);
  if (currentSessionId && sessionId === currentSessionId) return null;
  if (!sessionId && sessionNum == null) return null;
  const label = `${role} #${sessionNum ?? "?"}${displayName ? ` ${displayName}` : ""}`;
  const content = (
    <>
      {dotProps && <SessionStatusDot className="mt-0" {...dotProps} />}
      <SessionRoleLabel role={role} />
      <span className={QUEST_PARTICIPANT_SESSION_CLASS}>{`#${sessionNum ?? "?"}`}</span>
      {showDisplayName && displayName && <span className={QUEST_PARTICIPANT_NAME_CLASS}>{displayName}</span>}
    </>
  );

  return (
    <SessionInlineLink
      sessionId={sessionId}
      sessionNum={sessionNum}
      className={QUEST_PARTICIPANT_CHIP_CLASS}
      dataTestId="quest-thread-participant"
      ariaLabel={label}
      title={`Open ${role.toLowerCase()} session ${sessionNum != null ? `#${sessionNum}` : sessionId}${displayName ? ` ${displayName}` : ""}`}
      threadKey={threadKey}
    >
      {content}
    </SessionInlineLink>
  );
}

export function participantNavigationMatchesSessionNum(
  navigation: ResolvedSessionNavigation | null,
  sdkSessionNum: number | null | undefined,
  targetSessionNum: number,
): boolean {
  return navigation ? navigation.viewModel.sessionNum === targetSessionNum : sdkSessionNum === targetSessionNum;
}

export function resolveQuestBannerParticipantIdentity(
  navigation: ResolvedSessionNavigation | null,
  fallbackSessionNum?: number,
  fallbackName?: string,
): { sessionNum?: number; displayName?: string } {
  return navigation
    ? { sessionNum: navigation.viewModel.sessionNum ?? undefined, displayName: navigation.sidebarItem.name }
    : { sessionNum: fallbackSessionNum, displayName: fallbackName };
}

function boardWorkerParticipantForRow(row?: QuestThreadBannerRow): BoardRowSessionStatus["worker"] | undefined {
  const participant = row?.rowStatus?.worker;
  const boardWorkerId = row?.boardRow?.worker;
  const boardWorkerNum = row?.boardRow?.workerNum;
  if (!boardWorkerId && boardWorkerNum == null) return participant;
  if (!participant) return undefined;
  if (boardWorkerId && participant.sessionId === boardWorkerId) return participant;
  if (boardWorkerNum != null && participant.sessionNum === boardWorkerNum) return participant;
  return undefined;
}

function QuestStatusFallbackPill({ status }: { status?: string }) {
  if (!status) return null;
  const statusTheme = getQuestStatusTheme(status);
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-none ${statusTheme.bg} ${statusTheme.text} ${statusTheme.border}`}
      data-testid="quest-banner-status-pill"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusTheme.dot}`} />
      {statusTheme.label}
    </span>
  );
}

function QuestBannerCommitButton({ questId, count }: { questId: string; count: number }) {
  const label = commitCountLabel(count);
  const setActiveTab = useStore((s) => s.setActiveTab);
  return (
    <button
      type="button"
      onClick={() => setActiveTab("diff")}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-cc-border/60 bg-cc-hover/35 px-1.5 text-[10px] leading-none text-cc-muted transition-colors hover:border-cc-primary/35 hover:text-cc-primary"
      data-testid="quest-thread-commit-button"
      aria-label={`Open ${questId} recorded commit diffs, ${label}`}
      title={`Open ${questId} recorded commit diffs`}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3" aria-hidden="true">
        <path d="M2.5 1A1.5 1.5 0 001 2.5v11A1.5 1.5 0 002.5 15h11a1.5 1.5 0 001.5-1.5v-11A1.5 1.5 0 0013.5 1h-11zM2 2.5a.5.5 0 01.5-.5h11a.5.5 0 01.5.5V5H2V2.5zM2 6h12v7.5a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5V6zm3 1.5a.5.5 0 000 1h6a.5.5 0 000-1H5zm0 2.5a.5.5 0 000 1h4a.5.5 0 000-1H5z" />
      </svg>
      <span className="tabular-nums">{label}</span>
    </button>
  );
}

function isQueuedBoardRowStatus(status?: string): boolean {
  return (status ?? "").trim().toUpperCase() === "QUEUED";
}

function compactStringList(values: ReadonlyArray<string> | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function waitConditionForBoardRow(row?: BoardRowData): QuestBannerWaitCondition | null {
  if (!row) return null;
  if (isQueuedBoardRowStatus(row.status)) {
    const refs = compactStringList(row.waitFor);
    return refs.length > 0 ? { kind: "queued", refs } : null;
  }
  const refs = compactStringList(row.waitForInput);
  return refs.length > 0 ? { kind: "user-input", refs } : null;
}

function waitForInputLabel(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId);
  return `user input ${match ? match[1] : notificationId}`;
}

function waitConditionTitle(condition: QuestBannerWaitCondition): string {
  const labels =
    condition.kind === "queued" ? condition.refs.map(formatWaitForRefLabel) : condition.refs.map(waitForInputLabel);
  return `Waiting for ${labels.join(", ")}`;
}

function queuedWaitStatusTitle(condition: QuestBannerQueuedWaitCondition): string {
  return waitConditionTitle(condition).replace(/^Waiting for /, "Queued, waiting for ");
}

function QuestBannerQueuedWaitRef({ depRef }: { depRef: string }) {
  const kind = getWaitForRefKind(depRef);
  if (kind === "session") {
    const sessionNum = Number.parseInt(depRef.slice(1), 10);
    const session = useStore((s) => s.sdkSessions.find((candidate) => candidate.sessionNum === sessionNum));
    if (!session) return <span className="font-mono-code text-cc-attention">{depRef}</span>;
    return (
      <SessionInlineLink
        sessionId={session.sessionId}
        sessionNum={sessionNum}
        className="font-mono-code text-cc-attention hover:text-cc-attention-strong hover:underline decoration-dotted underline-offset-2"
        title={`Open waiting session #${sessionNum}`}
        stopPropagation
      >
        {depRef}
      </SessionInlineLink>
    );
  }
  if (kind === "quest") {
    return (
      <QuestInlineLink
        questId={depRef}
        className="font-mono-code text-cc-attention hover:text-cc-attention-strong hover:underline decoration-dotted underline-offset-2"
        stopPropagation
      >
        {depRef}
      </QuestInlineLink>
    );
  }
  return <span className="text-cc-attention">{formatWaitForRefLabel(depRef)}</span>;
}

function QuestBannerWaitRef({ condition, refValue }: { condition: QuestBannerWaitCondition; refValue: string }) {
  if (condition.kind === "queued") return <QuestBannerQueuedWaitRef depRef={refValue} />;
  return <span className="text-cc-attention">{waitForInputLabel(refValue)}</span>;
}

function QuestBannerWaitPill({ condition }: { condition: QuestBannerWaitCondition }) {
  return (
    <span
      className="inline-flex min-h-5 min-w-0 max-w-full shrink flex-wrap items-center gap-x-1 gap-y-0.5 rounded-full border border-cc-attention/35 bg-cc-attention/10 px-1.5 py-0.5 text-[10px] leading-none text-cc-attention"
      data-testid="quest-thread-wait-pill"
      title={waitConditionTitle(condition)}
    >
      <span className="shrink-0 font-medium">Waiting for </span>
      <span className="inline-flex min-w-0 flex-wrap items-center">
        {condition.refs.map((refValue, index) => (
          <Fragment key={`${condition.kind}-${refValue}`}>
            {index > 0 && <span className="text-cc-muted/70">, </span>}
            <QuestBannerWaitRef condition={condition} refValue={refValue} />
          </Fragment>
        ))}
      </span>
    </span>
  );
}

function QuestBannerQueuedStatusChip({ condition }: { condition: QuestBannerQueuedWaitCondition }) {
  return (
    <span
      className="inline-flex min-h-5 min-w-0 max-w-full shrink flex-wrap items-center gap-x-1 gap-y-0.5 rounded-full border border-cc-border/55 bg-cc-hover/20 px-1.5 py-0.5 text-[10px] leading-none text-cc-fg"
      data-testid="quest-thread-queued-status-chip"
      title={queuedWaitStatusTitle(condition)}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-cc-attention/45 bg-cc-attention/55" />
      <span className="shrink-0 font-medium">Queued, waiting for </span>
      <span className="inline-flex min-w-0 flex-wrap items-center">
        {condition.refs.map((refValue, index) => (
          <Fragment key={`${condition.kind}-${refValue}`}>
            {index > 0 && <span className="text-cc-muted/70">, </span>}
            <QuestBannerWaitRef condition={condition} refValue={refValue} />
          </Fragment>
        ))}
      </span>
    </span>
  );
}

function CompactingIndicator({ sessionId }: { sessionId: string }) {
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  if (sessionStatus !== "compacting") return null;
  return (
    <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code px-4 py-1">
      <YarnBallDot className="text-cc-primary animate-pulse" />
      <span>Compacting conversation...</span>
    </div>
  );
}

function messageSummariesAfterProjection(messages: ChatMessage[], projection?: LeaderProjectionSnapshot) {
  if (!projection) return collectLeaderThreadSummaries(messages);
  return collectLeaderThreadSummaries(
    messages.filter((message) => {
      if (typeof message.historyIndex !== "number") return true;
      if (message.historyIndex < 0) return true;
      return message.historyIndex >= projection.sourceHistoryLength;
    }),
  );
}

function useLeaderThreadModel(sessionId: string, deferMessageDerivedRows = false) {
  const activeBoard = useStore((s) => s.sessionBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const storedMessages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const leaderProjection = useStore((s) => s.leaderProjections.get(sessionId));
  const messages = deferMessageDerivedRows ? EMPTY_MESSAGES : storedMessages;
  const quests = useStore((s) => s.quests);
  const rowSessionStatuses = useStore((s) => s.sessionBoardRowStatuses.get(sessionId));
  const threadSummaries = useMemo(() => {
    const projected = leaderProjection?.threadSummaries ?? [];
    if (deferMessageDerivedRows) return projected;
    return mergeLeaderThreadSummaries(projected, messageSummariesAfterProjection(messages, leaderProjection));
  }, [deferMessageDerivedRows, leaderProjection, messages]);
  const rows = useMemo(
    () =>
      buildLeaderThreadRowsFromSummaries({
        activeBoard,
        completedBoard,
        threadSummaries,
        quests,
        rowSessionStatuses,
      }).map((row) => ({ ...row, leaderSessionId: sessionId })) as LeaderThreadRow[],
    [activeBoard, completedBoard, quests, rowSessionStatuses, sessionId, threadSummaries],
  );
  const activeRows = useMemo(() => rows.filter((row) => row.section === "active"), [rows]);
  const doneRows = useMemo(() => rows.filter((row) => row.section === "done"), [rows]);
  return {
    activeBoard,
    completedBoard,
    leaderProjection,
    messages,
    rawMessages: storedMessages,
    rows,
    activeRows,
    doneRows,
  };
}

function threadTitleForTranscription(threadKey: string, rows: LeaderThreadRow[]): string | undefined {
  const normalized = threadKey.toLowerCase();
  if (normalized === MAIN_THREAD_KEY) return "Main Thread";
  if (normalized === ALL_THREADS_KEY) return "All Threads";
  const row = rows.find((candidate) => candidate.threadKey === normalized);
  if (!row) return undefined;
  if (row.questId && row.title) return `${row.questId}: ${row.title}`;
  return row.title || row.questId;
}

function toWorkBoardThreadRows(rows: LeaderThreadRow[]): WorkBoardThreadNavigationRow[] {
  return rows.map((row) => ({
    threadKey: row.threadKey,
    questId: row.questId,
    title: row.title,
    status: row.status,
    boardStatus: row.boardStatus,
    messageCount: row.messageCount,
    section: row.section,
  }));
}

function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/i.test(threadKey.trim());
}

function composeThreadKeyForSelection(threadKey: string): string {
  const normalized = threadKey.trim().toLowerCase();
  if (normalized === ALL_THREADS_KEY) return MAIN_THREAD_KEY;
  return normalized;
}

function isAvailableLeaderThread(
  threadKey: string,
  rows: LeaderThreadRow[],
  openThreadKeys: ReadonlyArray<string> = [],
): boolean {
  const normalized = normalizeThreadKey(threadKey);
  if (normalized === MAIN_THREAD_KEY || normalized === ALL_THREADS_KEY) return true;
  return (
    rows.some((row) => row.threadKey === normalized) ||
    openThreadKeys.some((key) => normalizeThreadKey(key) === normalized)
  );
}

function questOrBoardRowIsCompleted(questStatus?: string, boardRowStatus?: string, completedAt?: number): boolean {
  return (
    completedAt !== undefined ||
    isCompletedJourneyPresentationStatus(questStatus) ||
    isCompletedJourneyPresentationStatus(boardRowStatus)
  );
}

function restorableSelectedThreadKey({
  threadKey,
  authoritativeLeaderOpenThreadTabs,
  openThreadTabKeys,
  rows,
}: {
  threadKey: string | null;
  authoritativeLeaderOpenThreadTabs: LeaderOpenThreadTabsState | null | undefined;
  openThreadTabKeys: ReadonlyArray<string>;
  rows: LeaderThreadRow[];
}): string | null {
  if (!threadKey) return null;
  const normalized = normalizeThreadKey(threadKey);
  if (normalized === MAIN_THREAD_KEY || normalized === ALL_THREADS_KEY) return normalized;
  if (!shouldPersistLeaderThreadTab(normalized)) return null;
  if (openThreadTabKeys.includes(normalized)) return normalized;
  if (authoritativeLeaderOpenThreadTabs) return null;
  return isAvailableLeaderThread(normalized, rows) ? normalized : null;
}

function buildSessionQuestBannerRow({
  sessionId,
  sessionNum,
  claimedQuestId,
  claimedQuestTitle,
  claimedQuestStatus,
  claimedQuestLeaderSessionId,
  herdedBy,
  quests,
  sessionBoards,
  sessionCompletedBoards,
  rowStatuses,
}: {
  sessionId: string;
  sessionNum?: number | null;
  claimedQuestId?: string | null;
  claimedQuestTitle?: string | null;
  claimedQuestStatus?: string | null;
  claimedQuestLeaderSessionId?: string | null;
  herdedBy?: string | null;
  quests: QuestmasterTask[];
  sessionBoards: ReadonlyMap<string, readonly BoardRowData[]>;
  sessionCompletedBoards: ReadonlyMap<string, readonly BoardRowData[]>;
  rowStatuses: ReadonlyMap<string, Record<string, BoardRowSessionStatus>>;
}): QuestThreadBannerRow | null {
  const sessionCandidate = claimedQuestId
    ? null
    : findSessionQuestContextCandidate({
        sessionId,
        sessionNum,
        quests,
        sessionBoards,
        sessionCompletedBoards,
        rowStatuses,
      });
  const quest = findQuestById(quests, claimedQuestId) ?? sessionCandidate?.quest;
  const questId = claimedQuestId ?? quest?.questId ?? sessionCandidate?.row?.questId;
  if (!questId) return null;

  const leaderSessionId =
    claimedQuestLeaderSessionId ?? quest?.leaderSessionId ?? sessionCandidate?.leaderSessionId ?? herdedBy ?? null;
  const boardContext = sessionCandidate?.row
    ? {
        row: sessionCandidate.row as BoardRowData,
        rowStatus: sessionCandidate.rowStatus,
        leaderSessionId: sessionCandidate.leaderSessionId,
      }
    : findQuestBoardContext({
        questId,
        leaderSessionId,
        sessionBoards,
        sessionCompletedBoards,
        rowStatuses,
      });
  const boardRow = boardContext.row;
  const rowStatus = boardContext.rowStatus;
  const resolvedLeaderSessionId = leaderSessionId ?? boardContext.leaderSessionId ?? null;
  const title = quest?.title ?? claimedQuestTitle ?? boardRow?.title ?? questId;
  const status = quest?.status ?? claimedQuestStatus ?? boardRow?.status;

  return {
    threadKey: questId.toLowerCase(),
    questId,
    title,
    ...(status ? { status } : {}),
    ...(boardRow?.status ? { boardStatus: boardRow.status } : {}),
    ...(boardRow?.journey ? { journey: boardRow.journey } : {}),
    ...(boardRow ? { boardRow } : {}),
    ...(rowStatus ? { rowStatus } : {}),
    ...(resolvedLeaderSessionId ? { leaderSessionId: resolvedLeaderSessionId } : {}),
    section: status === "done" || boardRow?.completedAt ? "done" : "active",
  };
}

export function QuestThreadBanner({
  row,
  threadKey,
  variant = "thread",
  currentSessionId,
  monitorSessionId,
}: {
  row?: QuestThreadBannerRow;
  threadKey: string;
  variant?: QuestBannerVariant;
  currentSessionId?: string;
  monitorSessionId?: string;
}) {
  const questId = row?.questId ?? threadKey.toLowerCase();
  const title = row?.title;
  const isSessionBanner = variant === "session";
  const codeCommitState = useQuestCodeCommitShas(isSessionBanner ? null : questId, row?.commitShas);
  const showCommitAffordance = !isSessionBanner;
  const waitCondition = row && isDoneThreadRow(row) ? null : waitConditionForBoardRow(row?.boardRow);
  const queuedWaitCondition = waitCondition?.kind === "queued" ? waitCondition : null;
  const inputWaitCondition = waitCondition?.kind === "user-input" ? waitCondition : null;
  const hasParticipantContext = isSessionBanner
    ? !!(row?.leaderSessionId || row?.rowStatus?.reviewer)
    : !!(row?.rowStatus?.worker || row?.boardRow?.worker || row?.rowStatus?.reviewer);
  const hasMeta = !!waitCondition || !!row?.journey || !!row?.status || hasParticipantContext || showCommitAffordance;
  return (
    <div
      className="shrink-0 border-b border-cc-border/80 bg-cc-bg/95 px-2.5 py-1 sm:px-3"
      data-testid="quest-thread-banner"
      data-variant={variant}
      data-layout="compact-inline"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <div className="inline-flex min-w-0 max-w-full flex-[1_1_16rem] items-baseline gap-1.5">
          {isSessionBanner && (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/65">Quest</span>
          )}
          <QuestInlineLink
            questId={questId}
            className="cc-quest-link shrink-0 font-mono-code font-medium hover:underline"
          >
            {questId}
          </QuestInlineLink>
          {title && <span className="min-w-0 truncate text-xs font-medium text-cc-fg sm:text-[13px]">{title}</span>}
        </div>
        {hasMeta && (
          <div
            className="inline-flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-1.5 sm:flex-[0_1_auto] sm:justify-end"
            data-testid="quest-thread-meta-strip"
          >
            {queuedWaitCondition ? (
              row?.journey ? (
                <QuestJourneyHoverTarget row={row}>
                  <QuestBannerQueuedStatusChip condition={queuedWaitCondition} />
                </QuestJourneyHoverTarget>
              ) : (
                <QuestBannerQueuedStatusChip condition={queuedWaitCondition} />
              )
            ) : row?.journey ? (
              <QuestJourneyHoverTarget row={row}>
                <QuestJourneyTimeline
                  journey={row.journey}
                  status={journeyStatusForThread(row)}
                  compact
                  showNotes={false}
                  className="rounded-full border border-cc-border/55 bg-cc-hover/20 px-1.5 py-0.5"
                />
              </QuestJourneyHoverTarget>
            ) : null}
            {!queuedWaitCondition && !row?.journey && <QuestStatusFallbackPill status={row?.status} />}
            {inputWaitCondition && <QuestBannerWaitPill condition={inputWaitCondition} />}
            {showCommitAffordance && (
              <QuestBannerCommitButton questId={questId} count={codeCommitState.commitShas.length} />
            )}
            {monitorSessionId && !isSessionBanner && (
              <NotifyMeControl sessionId={monitorSessionId} threadKey={threadKey} />
            )}
            {hasParticipantContext && (
              <div className="inline-flex min-w-0 items-center gap-1.5" data-testid="quest-thread-participant-strip">
                {isSessionBanner ? (
                  <>
                    <QuestBannerParticipantChip
                      role="Leader"
                      sessionId={row?.leaderSessionId}
                      fallbackSessionNum={row?.leaderSessionNum ?? undefined}
                      currentSessionId={currentSessionId}
                      threadKey={row?.questId}
                    />
                    <QuestBannerParticipantChip
                      role="Reviewer"
                      participant={row?.rowStatus?.reviewer}
                      currentSessionId={currentSessionId}
                    />
                  </>
                ) : (
                  <>
                    <QuestBannerParticipantChip
                      role="Worker"
                      participant={boardWorkerParticipantForRow(row)}
                      fallbackSessionId={row?.boardRow?.worker}
                      fallbackSessionNum={row?.boardRow?.workerNum}
                      showDisplayName={false}
                    />
                    <QuestBannerParticipantChip
                      role="Reviewer"
                      participant={row?.rowStatus?.reviewer}
                      showDisplayName={false}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function stringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type OpenThreadTabOptions = {
  repositionExisting?: boolean;
};

function shouldRepairRouteThreadOrder({
  lastProcessedRouteThreadKey,
  localSelectionRoute,
  threadKey,
}: {
  lastProcessedRouteThreadKey: string | null;
  localSelectionRoute: boolean;
  threadKey: string;
}): boolean {
  return !localSelectionRoute && lastProcessedRouteThreadKey !== normalizeThreadKey(threadKey);
}

export function ChatView({
  sessionId,
  preview = false,
  routeThreadKey,
  hasThreadRoute,
  viewportHandoffThreadEntryScopeId,
}: {
  sessionId: string;
  preview?: boolean;
  routeThreadKey?: string | null;
  hasThreadRoute?: boolean;
  viewportHandoffThreadEntryScopeId?: string;
}) {
  const {
    sessionPerms,
    connStatus,
    backendState,
    backendReconnect,
    backendError,
    cliConnected,
    cliEverConnected,
    cliDisconnectReason,
    launcherState,
    isArchived,
    serverReachable,
    isLeaderSession,
    sessionMetadataKnown,
    historyLoading,
    hasKnownThreadSources,
    sessionNum,
    claimedQuestId,
    claimedQuestTitle,
    claimedQuestStatus,
    claimedQuestLeaderSessionId,
    herdedBy,
    modelProvenanceMigration,
    authoritativeLeaderOpenThreadTabs,
    leaderTabsProjection,
    slackThreads,
    cachedThreadWindows,
  } = useStore(
    useShallow((s) => {
      const sessionState = s.sessions.get(sessionId);
      const sdkSession = s.sdkSessions.find((sdk) => sdk.sessionId === sessionId);
      const navigationSummary = resolveChatSessionNavigationSummary(s, sessionId);
      const tabsProjection = resolveLeaderThreadTabsProjection(s, sessionId);
      return {
        sessionPerms: s.pendingPermissions.get(sessionId),
        connStatus: s.connectionStatus.get(sessionId) ?? "disconnected",
        backendState: sessionState?.backend_state ?? "disconnected",
        backendReconnect: sessionState?.backend_reconnect ?? null,
        backendError: sessionState?.backend_error ?? null,
        cliConnected: s.cliConnected.get(sessionId) ?? false,
        cliEverConnected: s.cliEverConnected.get(sessionId) ?? false,
        cliDisconnectReason: s.cliDisconnectReason.get(sessionId) ?? null,
        launcherState: sdkSession?.state,
        isArchived: sdkSession?.archived ?? false,
        serverReachable: s.serverReachable,
        isLeaderSession: tabsProjection.projectionState === "accepted" || navigationSummary.isLeaderSession,
        sessionMetadataKnown: Boolean(sessionState || sdkSession),
        historyLoading: s.historyLoading.get(sessionId) ?? false,
        hasKnownThreadSources:
          s.messages.has(sessionId) ||
          s.leaderProjections.has(sessionId) ||
          tabsProjection.projectionState === "accepted" ||
          s.sessionBoards.has(sessionId) ||
          s.sessionCompletedBoards.has(sessionId),
        claimedQuestId: navigationSummary.claimedQuestId,
        sessionNum: navigationSummary.sessionNum,
        claimedQuestTitle: navigationSummary.claimedQuestTitle,
        claimedQuestStatus: navigationSummary.claimedQuestStatus,
        claimedQuestLeaderSessionId: navigationSummary.claimedQuestLeaderSessionId,
        herdedBy: navigationSummary.herdedBy,
        modelProvenanceMigration: sessionState?.modelProvenanceMigration ?? sdkSession?.modelProvenanceMigration,
        authoritativeLeaderOpenThreadTabs: projectedLeaderOpenThreadTabs(tabsProjection),
        leaderTabsProjection: tabsProjection.projectionState === "accepted" ? tabsProjection.value : null,
        slackThreads: sessionState?.slackThreads ?? EMPTY_SIDE_CHATS,
        cachedThreadWindows: s.threadWindows?.get(sessionId),
      };
    }),
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState(() =>
    resolveInitialLeaderThreadKey({
      sessionId,
      isLeaderSession,
      hasThreadRoute,
      routeThreadKey,
      leaderOpenThreadTabs: authoritativeLeaderOpenThreadTabs,
    }),
  );
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  selectedThreadKeyRef.current = selectedThreadKey;
  const generatedViewportHandoffThreadEntryScopeId = useMemo(createViewportHandoffEntryId, [sessionId]);
  const viewportHandoffThreadEntryScope =
    viewportHandoffThreadEntryScopeId ?? generatedViewportHandoffThreadEntryScopeId;
  const normalizedViewportHandoffThreadKey = normalizeThreadKey(isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY);
  const viewportHandoffThreadEntryRef = useRef({
    scopeId: viewportHandoffThreadEntryScope,
    threadKey: normalizedViewportHandoffThreadKey,
    entryId: `${viewportHandoffThreadEntryScope}:${normalizedViewportHandoffThreadKey}`,
  });
  if (viewportHandoffThreadEntryRef.current.scopeId !== viewportHandoffThreadEntryScope) {
    viewportHandoffThreadEntryRef.current = {
      scopeId: viewportHandoffThreadEntryScope,
      threadKey: normalizedViewportHandoffThreadKey,
      entryId: `${viewportHandoffThreadEntryScope}:${normalizedViewportHandoffThreadKey}`,
    };
  } else if (viewportHandoffThreadEntryRef.current.threadKey !== normalizedViewportHandoffThreadKey) {
    viewportHandoffThreadEntryRef.current = {
      scopeId: viewportHandoffThreadEntryScope,
      threadKey: normalizedViewportHandoffThreadKey,
      entryId: `${viewportHandoffThreadEntryScope}:${normalizedViewportHandoffThreadKey}:${createViewportHandoffEntryId()}`,
    };
  }
  const passiveRestoreThreadKeyRef = useRef(hasThreadRoute ? null : readLeaderSelectedThreadKey(sessionId));
  const wasLeaderSessionRef = useRef(isLeaderSession);
  if (isLeaderSession) wasLeaderSessionRef.current = true;
  useLayoutEffect(
    () => () => {
      if (wasLeaderSessionRef.current && !preview) {
        persistLeaderSelectedThreadKey(sessionId, selectedThreadKeyRef.current);
      }
    },
    [preview, sessionId],
  );
  const [selectedSideChatId, setSelectedSideChatId] = useState<string | null>(null);
  const selectedSideChat = selectedSideChatId ? slackThreads[selectedSideChatId] : undefined;

  useLayoutEffect(() => {
    if (!isLeaderSession) return;
    markThreadNavigationCommitted(sessionId, normalizeThreadKey(selectedThreadKey));
  }, [isLeaderSession, selectedThreadKey, sessionId]);

  useLayoutEffect(() => {
    markColdReplayFlushCommitted(sessionId);
  });

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { sessionId?: string; sideChatId?: string; threadId?: string; childSessionId?: string }
        | undefined;
      const sideChatId = detail?.sideChatId ?? detail?.threadId;
      if (detail?.sessionId !== sessionId || !sideChatId) return;
      useStore.getState().closeCodexSubagentInspector();
      setSelectedSideChatId(sideChatId);
      if (detail.childSessionId) connectSession(detail.childSessionId);
    };
    window.addEventListener("takode:open-side-chat", onOpen);
    window.addEventListener("takode:open-slack-thread", onOpen);
    return () => {
      window.removeEventListener("takode:open-side-chat", onOpen);
      window.removeEventListener("takode:open-slack-thread", onOpen);
    };
  }, [sessionId]);

  useEffect(() => {
    if (selectedSideChat?.childSessionId) connectSession(selectedSideChat.childSessionId);
  }, [selectedSideChat?.childSessionId]);

  const codexSubagentInspectorOpen = useStore((state) => state.codexSubagentInspector?.sessionId === sessionId);
  useEffect(() => {
    if (codexSubagentInspectorOpen) setSelectedSideChatId(null);
  }, [codexSubagentInspectorOpen]);
  const [openThreadTabKeys, setOpenThreadTabKeys] = useState(() => {
    if (!isLeaderSession) return [];
    if (leaderTabsProjection?.tabState === null) return readOpenThreadTabKeys(sessionId);
    return authoritativeLeaderOpenThreadTabs?.orderedOpenThreadKeys ?? [];
  });
  const openThreadTabKeysRef = useRef(openThreadTabKeys);
  const titleHydrationConnectionStatusRef = useRef<typeof connStatus | null>(null);
  const {
    activeBoard,
    completedBoard,
    leaderProjection,
    messages: allMessages,
    rawMessages: allRawMessages,
    rows: threadRows,
  } = useLeaderThreadModel(sessionId, historyLoading);
  const sessionNotifications = useStore((s) => s.sessionNotifications.get(sessionId));
  const persistedAttentionRecords = useStore((s) => s.sessionAttentionRecords.get(sessionId));
  const quests = useStore((s) => s.quests);
  const questDetails = useStore((s) => s.questDetails ?? EMPTY_QUEST_DETAILS);
  const questTitlePreviews = useStore((s) => s.questTitlePreviews ?? EMPTY_QUEST_TITLE_PREVIEWS);
  const hydrateQuestTitles = useStore((s) => s.hydrateQuestTitles);
  const canonicalQuestTitles = useMemo(
    () => buildCanonicalQuestTitleIndex({ quests, questDetails, questTitlePreviews }),
    [questDetails, questTitlePreviews, quests],
  );
  const allSessionBoards = useStore((s) => s.sessionBoards);
  const allSessionCompletedBoards = useStore((s) => s.sessionCompletedBoards);
  const allSessionBoardRowStatuses = useStore((s) => s.sessionBoardRowStatuses);
  const routeSyncEnabled = hasThreadRoute !== undefined || routeThreadKey !== undefined;
  const showQuestThreadBanner =
    isLeaderSession &&
    selectedThreadKey.toLowerCase() !== MAIN_THREAD_KEY &&
    selectedThreadKey.toLowerCase() !== ALL_THREADS_KEY &&
    isQuestThreadKey(selectedThreadKey);
  const sessionQuestBannerRow = useMemo(
    () =>
      !isLeaderSession
        ? buildSessionQuestBannerRow({
            sessionId,
            sessionNum,
            claimedQuestId,
            claimedQuestTitle,
            claimedQuestStatus,
            claimedQuestLeaderSessionId,
            herdedBy,
            quests,
            sessionBoards: allSessionBoards,
            sessionCompletedBoards: allSessionCompletedBoards,
            rowStatuses: allSessionBoardRowStatuses,
          })
        : null,
    [
      allSessionBoardRowStatuses,
      allSessionBoards,
      allSessionCompletedBoards,
      claimedQuestId,
      claimedQuestLeaderSessionId,
      claimedQuestStatus,
      claimedQuestTitle,
      herdedBy,
      isLeaderSession,
      quests,
      sessionId,
      sessionNum,
    ],
  );
  const composerThreadKey = isLeaderSession ? composeThreadKeyForSelection(selectedThreadKey) : MAIN_THREAD_KEY;
  const composerQuestId = isLeaderSession && isQuestThreadKey(composerThreadKey) ? composerThreadKey : undefined;
  const reviewAttentionRecords = useMemo(
    () =>
      isLeaderSession
        ? buildAttentionRecords({
            leaderSessionId: sessionId,
            records: [...(persistedAttentionRecords ?? []), ...(leaderProjection?.messageAttentionRecords ?? [])],
            notifications: sessionNotifications,
            boardRows: activeBoard,
            completedBoardRows: completedBoard,
            messages: leaderProjection || historyLoading ? EMPTY_MESSAGES : allMessages,
          })
        : EMPTY_ATTENTION_RECORDS,
    [
      activeBoard,
      allMessages,
      completedBoard,
      historyLoading,
      isLeaderSession,
      leaderProjection,
      persistedAttentionRecords,
      sessionId,
      sessionNotifications,
    ],
  );
  const navigationThreadRows = useMemo(() => {
    const detailRows = applyCanonicalQuestTitles(threadRows, canonicalQuestTitles);
    if (!leaderTabsProjection) return detailRows;
    return mergeProjectedLeaderThreadRows(detailRows, leaderTabsProjection, canonicalQuestTitles) as LeaderThreadRow[];
  }, [canonicalQuestTitles, leaderTabsProjection, threadRows]);
  const reviewNotificationIdsToClear = useMemo(
    () =>
      !preview
        ? reviewNotificationIdsForSelectedThread(
            sessionNotifications,
            reviewAttentionRecords,
            isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY,
          )
        : [],
    [isLeaderSession, preview, reviewAttentionRecords, selectedThreadKey, sessionNotifications],
  );
  useEffect(() => {
    for (const notificationId of reviewNotificationIdsToClear) {
      api.markNotificationDone(sessionId, notificationId, true).catch(console.error);
    }
  }, [reviewNotificationIdsToClear, sessionId]);
  const selectedThreadRow = useMemo(() => {
    const normalizedThreadKey = normalizeThreadKey(selectedThreadKey);
    const existing = navigationThreadRows.find((row) => row.threadKey === normalizedThreadKey);
    if (existing || !isQuestThreadKey(normalizedThreadKey)) return existing;
    const title = canonicalQuestTitles.get(normalizedThreadKey);
    if (!title) return undefined;
    return {
      threadKey: normalizedThreadKey,
      questId: normalizedThreadKey,
      title,
      messageCount: 0,
      createdAt: Number.MAX_SAFE_INTEGER,
    } satisfies LeaderThreadRow;
  }, [canonicalQuestTitles, navigationThreadRows, selectedThreadKey]);
  const composerThreadTitle = isLeaderSession
    ? selectedThreadRow?.questId && selectedThreadRow.title
      ? `${selectedThreadRow.questId}: ${selectedThreadRow.title}`
      : threadTitleForTranscription(selectedThreadKey, navigationThreadRows)
    : undefined;
  const workBoardThreadRows = useMemo(() => toWorkBoardThreadRows(navigationThreadRows), [navigationThreadRows]);
  useEffect(() => {
    openThreadTabKeysRef.current = openThreadTabKeys;
  }, [openThreadTabKeys]);
  useEffect(() => {
    if (!isLeaderSession || !hydrateQuestTitles) return;
    const previousConnectionStatus = titleHydrationConnectionStatusRef.current;
    titleHydrationConnectionStatusRef.current = connStatus;
    const questIds = [...new Set([...openThreadTabKeys, selectedThreadKey].map(normalizeThreadKey))].filter(
      isQuestThreadKey,
    );
    if (questIds.length === 0) return;
    const connectionBecameReady = connStatus === "connected" && previousConnectionStatus !== "connected";
    void hydrateQuestTitles(questIds, connectionBecameReady ? { force: true } : undefined);
  }, [connStatus, hydrateQuestTitles, isLeaderSession, openThreadTabKeys, selectedThreadKey]);
  const sendLeaderThreadTabUpdate = useCallback(
    (operation: LeaderThreadTabUpdate) => sendToSession(sessionId, { type: "leader_thread_tabs_update", operation }),
    [sessionId],
  );
  const openThreadTab = useCallback(
    (threadKey: string, options: OpenThreadTabOptions = {}) => {
      const normalized = normalizeThreadKey(threadKey);
      if (!shouldPersistLeaderThreadTab(normalized)) return;
      const existingOpenThreadKeys = openThreadTabKeysRef.current;
      const nextOpenThreadTabKeys = placeLeaderOpenThreadTabKey(existingOpenThreadKeys, normalized, "first");
      if (existingOpenThreadKeys.includes(normalized)) {
        if (!options.repositionExisting || stringArraysEqual(existingOpenThreadKeys, nextOpenThreadTabKeys)) return;
      }
      openThreadTabKeysRef.current = nextOpenThreadTabKeys;
      setOpenThreadTabKeys(nextOpenThreadTabKeys);
      sendLeaderThreadTabUpdate({
        type: "open",
        threadKey: normalized,
        placement: "first",
      });
    },
    [sendLeaderThreadTabUpdate],
  );
  const locallySelectedRouteThreadKeyRef = useRef<string | null>(null);
  const lastProcessedRouteThreadKeyRef = useRef<string | null>(null);
  const handleSelectThread = useCallback(
    (threadKey: string) => {
      const nextThreadKey = normalizeThreadKey(threadKey || MAIN_THREAD_KEY);
      const currentThreadKey = normalizeThreadKey(selectedThreadKey);
      if (nextThreadKey !== currentThreadKey) {
        beginThreadNavigationTiming({
          sessionId,
          fromThreadKey: currentThreadKey,
          toThreadKey: nextThreadKey,
          cachedWindow: cachedThreadWindows?.has(nextThreadKey) === true,
        });
      }
      openThreadTab(nextThreadKey);
      passiveRestoreThreadKeyRef.current = nextThreadKey;
      selectedThreadKeyRef.current = nextThreadKey;
      if (isLeaderSession && !preview) {
        persistLeaderSelectedThreadKey(sessionId, nextThreadKey);
      }
      if (nextThreadKey === currentThreadKey) return;
      if (!preview) noteViewportSelectionActivity(sessionId, nextThreadKey);
      void requestThreadViewportSnapshot(sessionId, {
        threadKey: currentThreadKey,
        selectedThreadKey: nextThreadKey,
        publishHandoff: true,
        keepalive: true,
        reason: "thread-departure",
      });
      setSelectedThreadKey(nextThreadKey);
      if (!preview) {
        locallySelectedRouteThreadKeyRef.current = nextThreadKey;
        navigateToSessionThread(sessionId, nextThreadKey);
      }
    },
    [cachedThreadWindows, isLeaderSession, openThreadTab, preview, selectedThreadKey, sessionId],
  );
  const handleCloseThreadTab = useCallback(
    (threadKey: string, nextThreadKey = MAIN_THREAD_KEY) => {
      const normalized = normalizeThreadKey(threadKey);
      const nextOpenThreadTabKeys = openThreadTabKeysRef.current.filter((key) => key !== normalized);
      openThreadTabKeysRef.current = nextOpenThreadTabKeys;
      setOpenThreadTabKeys(nextOpenThreadTabKeys);
      sendLeaderThreadTabUpdate({ type: "close", threadKey: normalized, closedAt: Date.now() });
      if (normalizeThreadKey(selectedThreadKey) === normalized) {
        handleSelectThread(nextThreadKey);
      }
    },
    [handleSelectThread, selectedThreadKey, sendLeaderThreadTabUpdate],
  );
  const handleReorderThreadTabs = useCallback(
    (orderedThreadKeys: string[]) => {
      const nextOpenThreadTabKeys = reorderLeaderOpenThreadKeys(openThreadTabKeysRef.current, orderedThreadKeys);
      if (stringArraysEqual(openThreadTabKeysRef.current, nextOpenThreadTabKeys)) return;
      openThreadTabKeysRef.current = nextOpenThreadTabKeys;
      setOpenThreadTabKeys(nextOpenThreadTabKeys);
      sendLeaderThreadTabUpdate({ type: "reorder", orderedOpenThreadKeys: nextOpenThreadTabKeys });
    },
    [sendLeaderThreadTabUpdate],
  );

  useEffect(() => {
    locallySelectedRouteThreadKeyRef.current = null;
    lastProcessedRouteThreadKeyRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (routeSyncEnabled) return;
    setSelectedThreadKey(MAIN_THREAD_KEY);
  }, [routeSyncEnabled, sessionId]);

  useLeaderOpenThreadTabStateSync({
    sessionId,
    isLeaderSession,
    preview,
    connectionStatus: connStatus,
    projection: leaderTabsProjection,
    openThreadTabKeysRef,
    setOpenThreadTabKeys,
    sendUpdate: sendLeaderThreadTabUpdate,
  });

  const questStatusByKey = useMemo(
    () => new Map(quests.map((quest) => [normalizeThreadKey(quest.questId), quest.status])),
    [quests],
  );

  useEffect(() => {
    if (!routeSyncEnabled || preview) return;
    const liveHash = window.location.hash;
    const liveThreadRoute = threadRouteFromHash(liveHash);
    if (liveThreadRoute.hasThreadParam !== hasThreadRoute || liveThreadRoute.threadKey !== (routeThreadKey ?? null)) {
      return;
    }
    const preserveMessageThreadRoute = hasMessageDeepLinkFromHash(liveHash) && routeThreadKey != null;

    if (!isLeaderSession) {
      if (!sessionMetadataKnown) return;
      lastProcessedRouteThreadKeyRef.current = null;
      passiveRestoreThreadKeyRef.current = MAIN_THREAD_KEY;
      selectedThreadKeyRef.current = MAIN_THREAD_KEY;
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      if (hasThreadRoute && !preserveMessageThreadRoute) {
        navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      }
      return;
    }

    if (!hasThreadRoute) {
      lastProcessedRouteThreadKeyRef.current = null;
      const restoredThreadKey = restorableSelectedThreadKey({
        threadKey: passiveRestoreThreadKeyRef.current,
        authoritativeLeaderOpenThreadTabs,
        openThreadTabKeys,
        rows: navigationThreadRows,
      });
      const nextThreadKey = restoredThreadKey ?? MAIN_THREAD_KEY;
      passiveRestoreThreadKeyRef.current = nextThreadKey;
      selectedThreadKeyRef.current = nextThreadKey;
      if (selectedThreadKey !== nextThreadKey) {
        setSelectedThreadKey(nextThreadKey);
      }
      if (!restoredThreadKey) {
        persistLeaderSelectedThreadKey(sessionId, MAIN_THREAD_KEY);
      } else if (restoredThreadKey !== MAIN_THREAD_KEY) {
        // This URL follows passive selection restore, not an external route
        // requesting first placement over the authoritative tab order.
        locallySelectedRouteThreadKeyRef.current = restoredThreadKey;
        navigateToSessionThread(sessionId, restoredThreadKey, true);
      }
      return;
    }

    if (!routeThreadKey) {
      lastProcessedRouteThreadKeyRef.current = null;
      passiveRestoreThreadKeyRef.current = MAIN_THREAD_KEY;
      selectedThreadKeyRef.current = MAIN_THREAD_KEY;
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      return;
    }

    const nextThreadKey = normalizeThreadKey(routeThreadKey);
    if (isAvailableLeaderThread(nextThreadKey, navigationThreadRows, openThreadTabKeys)) {
      const localSelectionRoute = locallySelectedRouteThreadKeyRef.current === nextThreadKey;
      if (localSelectionRoute) {
        locallySelectedRouteThreadKeyRef.current = null;
      }
      const repositionExisting = shouldRepairRouteThreadOrder({
        lastProcessedRouteThreadKey: lastProcessedRouteThreadKeyRef.current,
        localSelectionRoute,
        threadKey: nextThreadKey,
      });
      if (repositionExisting) {
        openThreadTab(nextThreadKey, { repositionExisting });
      }
      lastProcessedRouteThreadKeyRef.current = nextThreadKey;
      passiveRestoreThreadKeyRef.current = nextThreadKey;
      selectedThreadKeyRef.current = nextThreadKey;
      if (selectedThreadKey !== nextThreadKey) {
        setSelectedThreadKey(nextThreadKey);
      }
      persistLeaderSelectedThreadKey(sessionId, nextThreadKey);
      if (nextThreadKey === MAIN_THREAD_KEY && hasThreadRoute && !preserveMessageThreadRoute) {
        navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      }
      return;
    }

    if (!historyLoading && hasKnownThreadSources) {
      lastProcessedRouteThreadKeyRef.current = null;
      passiveRestoreThreadKeyRef.current = MAIN_THREAD_KEY;
      selectedThreadKeyRef.current = MAIN_THREAD_KEY;
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      persistLeaderSelectedThreadKey(sessionId, MAIN_THREAD_KEY);
      if (!preserveMessageThreadRoute) {
        navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      }
    }
  }, [
    authoritativeLeaderOpenThreadTabs,
    hasKnownThreadSources,
    hasThreadRoute,
    historyLoading,
    isLeaderSession,
    openThreadTabKeys,
    preview,
    routeSyncEnabled,
    routeThreadKey,
    selectedThreadKey,
    sessionMetadataKnown,
    sessionId,
    navigationThreadRows,
    openThreadTab,
  ]);

  // Within-session search
  const searchInputRef = useRef<HTMLInputElement>(null);
  useSessionSearch(sessionId, !preview);

  const perms = useMemo(() => (sessionPerms ? Array.from(sessionPerms.values()) : []), [sessionPerms]);

  // Separate plan permission from other permissions
  const planPerm = perms.find((p) => p.tool_name === "ExitPlanMode") || null;
  const otherPerms = perms.filter((p) => p.tool_name !== "ExitPlanMode");

  // Plan collapse state — auto-expand when a new plan arrives
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const planPermId = planPerm?.request_id;
  useEffect(() => {
    if (planPermId) setPlanCollapsed(false);
  }, [planPermId]);

  const showPlanOverlay = planPerm && !planCollapsed;

  // Permissions collapse state — auto-expand only when new permissions arrive
  const [permsCollapsed, setPermsCollapsed] = useState(false);
  const prevOtherPermsCount = useRef(0);
  useEffect(() => {
    if (otherPerms.length > prevOtherPermsCount.current) {
      setPermsCollapsed(false);
    }
    prevOtherPermsCount.current = otherPerms.length;
  }, [otherPerms.length]);

  const recoverableConnectionPresentation = getRecoverableSessionConnectionPresentation({
    backendState,
    browserConnectionStatus: connStatus,
    cliConnected,
    cliEverConnected,
    idlePaused: cliDisconnectReason === "idle_limit",
    serverReachable,
  });
  const isResumeMissingRolloutError =
    backendError?.includes("could not be resumed because its local rollout is missing or unreadable") ?? false;
  const liveConnectionStatus = getLiveSessionConnectionStatus({
    backendState,
    browserConnectionStatus: connStatus,
    cliConnected,
    cliEverConnected,
    launcherState,
    recoverableConnectionPresentation,
    archived: isArchived,
    serverReachable,
  });
  return (
    <div className="relative flex flex-col h-full min-h-0">
      {preview ? (
        <div className="shrink-0 px-4 py-2 border-b border-cc-border bg-cc-card/80 text-[11px] text-cc-muted font-medium">
          Previewing search result. Press Enter to select this conversation.
        </div>
      ) : (
        /* Within-session message search bar */
        <SearchBar sessionId={sessionId} inputRef={searchInputRef} />
      )}

      {/* Archived session banner */}
      {!preview && isArchived && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/25 flex items-center justify-center gap-3">
          <span className="text-xs text-amber-300 font-medium">This session is archived. History is read-only.</span>
          <button
            onClick={() => api.unarchiveSession(sessionId).catch(console.error)}
            className="text-xs font-medium px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
          >
            Unarchive
          </button>
        </div>
      )}

      {!preview && modelProvenanceMigration && (
        <ModelProvenanceMigrationBanner
          migration={modelProvenanceMigration}
          onAcknowledge={(eventId) => api.acknowledgeModelProvenanceMigration(sessionId, eventId)}
        />
      )}

      {/* Session task outline — horizontal milestone chips */}
      {!preview && !isLeaderSession && !sessionQuestBannerRow && <TaskOutlineBar sessionId={sessionId} />}

      {/* Persistent work board for orchestrator sessions -- primary thread navigation above the feed */}
      {!preview && (
        <WorkBoardBar
          sessionId={sessionId}
          currentThreadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
          onSelectThread={isLeaderSession ? handleSelectThread : undefined}
          openThreadKeys={isLeaderSession ? openThreadTabKeys : undefined}
          onCloseThreadTab={isLeaderSession ? handleCloseThreadTab : undefined}
          onReorderThreadTabs={isLeaderSession ? handleReorderThreadTabs : undefined}
          threadRows={isLeaderSession ? workBoardThreadRows : undefined}
        />
      )}

      {/* Plan overlay fills the chat area, OR show the normal message feed */}
      {!preview && showPlanOverlay ? (
        <PlanReviewOverlay permission={planPerm} sessionId={sessionId} onCollapse={() => setPlanCollapsed(true)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {!preview && showQuestThreadBanner && (
                <QuestThreadBanner row={selectedThreadRow} threadKey={selectedThreadKey} monitorSessionId={sessionId} />
              )}
              {!preview && !showQuestThreadBanner && sessionQuestBannerRow && (
                <QuestThreadBanner
                  row={sessionQuestBannerRow}
                  threadKey={sessionQuestBannerRow.threadKey}
                  variant="session"
                  currentSessionId={sessionId}
                />
              )}
              <ViewportHandoffThreadEntryGate
                key={`${sessionId}:${normalizeThreadKey(isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY)}`}
                sessionId={preview ? null : sessionId}
                threadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
                entryId={viewportHandoffThreadEntryRef.current.entryId}
                fallback={
                  <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-cc-muted">
                    Loading conversation...
                  </div>
                }
              >
                <MessageFeed
                  sessionId={sessionId}
                  threadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
                  projectThreadRoutes={isLeaderSession}
                  onSelectThread={isLeaderSession ? handleSelectThread : undefined}
                  showCodexSubagentControl={!preview}
                />
              </ViewportHandoffThreadEntryGate>
            </div>
            {!preview && selectedSideChat && (
              <SideChatPanel
                rootSessionId={sessionId}
                sideChat={selectedSideChat}
                onClose={() => setSelectedSideChatId(null)}
              />
            )}
          </div>
        </div>
      )}

      {/* Collapsed plan chip (when plan exists but is collapsed) */}
      {!preview && planPerm && planCollapsed && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2">
          <PlanCollapsedChip permission={planPerm} sessionId={sessionId} onExpand={() => setPlanCollapsed(false)} />
        </div>
      )}

      {/* Non-plan permission banners — collapsible */}
      {!preview &&
        otherPerms.length > 0 &&
        (permsCollapsed ? (
          <PermissionsCollapsedChip permissions={otherPerms} onExpand={() => setPermsCollapsed(false)} />
        ) : (
          <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
            <div
              onClick={() => setPermsCollapsed(true)}
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-cc-card border-b border-cc-border/50 cursor-pointer hover:bg-cc-hover/50 transition-colors"
              role="button"
              title="Minimize approvals"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-[11px] font-medium text-cc-warning">
                {otherPerms.length} pending approval{otherPerms.length !== 1 ? "s" : ""}
              </span>
              <span className="ml-auto p-1.5 rounded-md text-cc-muted">
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                  <path d="M4 8h4" />
                </svg>
              </span>
            </div>
            {otherPerms.map((p) => (
              <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
            ))}
          </div>
        ))}

      {liveConnectionStatus && (!preview || liveConnectionStatus === "server-unreachable") && (
        <LiveConnectionStatusBanner
          status={liveConnectionStatus}
          backendState={backendState}
          backendError={backendError}
          reconnectProgress={backendReconnect}
          hasEverConnected={cliEverConnected}
          idlePaused={cliDisconnectReason === "idle_limit"}
          isResumeMissingRolloutError={isResumeMissingRolloutError}
          onRelaunch={
            liveConnectionStatus === "broken" ||
            liveConnectionStatus === "cli-disconnected" ||
            liveConnectionStatus === "recovery-suppressed"
              ? () => api.relaunchSession(sessionId).catch(console.error)
              : undefined
          }
        />
      )}

      {/* Compacting indicator — fixed above composer, green like running state */}
      {!preview && <CompactingIndicator sessionId={sessionId} />}

      {/* Active todo status — shows current in-progress task */}
      {!preview && <TodoStatusLine sessionId={sessionId} />}

      {/* Composer */}
      {!preview && (
        <Composer
          sessionId={sessionId}
          threadKey={composerThreadKey}
          questId={composerQuestId}
          transcriptionThreadKey={isLeaderSession ? composerThreadKey : undefined}
          transcriptionThreadTitle={composerThreadTitle}
        />
      )}
    </div>
  );
}
