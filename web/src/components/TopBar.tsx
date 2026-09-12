import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { parseHash, threadRouteFromHash } from "../utils/routing.js";
import { navigateTo } from "../utils/navigation.js";
import { SessionInfoPopover } from "./SessionInfoPopover.js";
import { ConfigureSessionModal } from "./ConfigureSessionModal.js";
import type { SessionViewModel } from "../utils/session-view-model.js";
import { resolveSessionNavigation } from "../utils/session-navigation-resolver.js";
import { hasUnreadSessionAttention } from "../utils/session-attention-status.js";
import { resolveDiffTarget } from "../utils/diff-target.js";
import { questLabel, questOwnsSessionName } from "../utils/quest-helpers.js";
import { getShortcutTitle } from "../shortcuts.js";
import { GlobalNeedsInputMenu } from "./GlobalNeedsInputMenu.js";
import { GlobalNotifyMeMenu } from "./GlobalNotifyMeMenu.js";
import { activeBoardSummarySegments } from "./leader-board-summary.js";
import { LeaderWorkboardControlButton, SummarySegments } from "./leader-workboard-controls.js";
import { useQuestCodeCommitShas } from "./QuestCommitDiffView.js";
import type { BoardRowData } from "./BoardTable.js";
import type { LeaderWorkboardView } from "../store-types.js";

type TopBarState = ReturnType<typeof useStore.getState>;
const EMPTY_LEADER_BOARD_ROWS: readonly BoardRowData[] = [];

interface TopBarProps {
  fullPageLabel?: string;
  universalSearchOpen?: boolean;
  onOpenUniversalSearch?: () => void;
  onCloseUniversalSearch?: () => void;
}

function countScopedChangedFiles(state: TopBarState, sessionId: string, sessionVm: SessionViewModel | null): number {
  const files = state.changedFiles.get(sessionId);
  if (!files) return 0;

  const sessionCwd = sessionVm?.cwd;
  if (!sessionCwd) return files.size;

  // Use repo_root only when it's an ancestor of cwd (worktrees have a different root).
  const scope =
    sessionVm?.repoRoot && sessionCwd.startsWith(sessionVm.repoRoot + "/") ? sessionVm.repoRoot : sessionCwd;
  const prefix = `${scope}/`;
  const scopedFiles = [...files].filter((fp) => fp === scope || fp.startsWith(prefix));
  const stats = state.diffFileStats.get(sessionId);
  if (!stats || stats.size === 0) return scopedFiles.length;

  return scopedFiles.filter((fp) => {
    const st = stats.get(fp);
    return !st || st.additions > 0 || st.deletions > 0;
  }).length;
}

export function getCurrentTopBarSessionState(state: TopBarState) {
  const currentSessionId = state.currentSessionId;
  if (!currentSessionId) {
    return {
      currentSessionId: null,
      isConnected: false,
      status: null,
      currentPermCount: 0,
      currentSdkState: null,
      isArchived: false,
      currentHasUnread: false,
      sessionName: null,
      sessionNum: null,
      isQuestNamed: false,
      questStatus: undefined,
      idleKilled: false,
      activeTimerCount: 0,
      changedFilesCount: 0,
      leaderProfilePortrait: undefined,
      pause: null,
      paused: false,
    };
  }

  const resolved = resolveSessionNavigation(state, currentSessionId);
  const currentSessionVm = resolved?.viewModel ?? null;
  const currentItem = resolved?.sidebarItem;
  const questStatus = currentSessionVm?.claimedQuestStatus;
  const questReviewInboxUnread = currentSessionVm?.claimedQuestVerificationInboxUnread;
  const sessionName = resolved?.sidebarItem.name || `Session ${currentSessionId.slice(0, 8)}`;

  return {
    currentSessionId,
    isConnected: currentItem?.isConnected ?? false,
    status: currentItem?.status ?? null,
    currentPermCount: currentItem?.permCount ?? 0,
    currentSdkState: currentItem?.sdkState ?? null,
    isArchived: currentItem?.archived ?? false,
    currentHasUnread: hasUnreadSessionAttention(state.sessionAttention.get(currentSessionId)),
    sessionName,
    sessionNum: currentSessionVm?.sessionNum ?? null,
    isQuestNamed:
      currentSessionVm?.isOrchestrator !== true && questOwnsSessionName(questStatus, questReviewInboxUnread),
    questStatus,
    questReviewInboxUnread,
    idleKilled: currentItem?.idleKilled ?? false,
    activeTimerCount: currentItem?.pendingTimerCount ?? 0,
    changedFilesCount: countScopedChangedFiles(state, currentSessionId, currentSessionVm),
    leaderProfilePortrait: currentItem?.isOrchestrator ? currentItem.leaderProfilePortrait : undefined,
    pause: currentSessionVm?.pause ?? null,
    paused: currentItem?.paused ?? !!currentSessionVm?.pause?.pausedAt,
  };
}

export function TopBar({
  fullPageLabel,
  universalSearchOpen = false,
  onOpenUniversalSearch = () => {},
  onCloseUniversalSearch = () => {},
}: TopBarProps = {}) {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const threadRoute = useMemo(
    () => (route.page === "session" ? threadRouteFromHash(hash) : { hasThreadParam: false, threadKey: null }),
    [hash, route.page],
  );
  const isSessionView = route.page === "session" || route.page === "home";
  const isQuestmasterPage = route.page === "questmaster";
  const {
    currentSessionId,
    sidebarOpen,
    shortcutSettings,
    setSidebarOpen,
    setSessionInfoOpenSessionId,
    codexSubagentInspector,
    closeCodexSubagentInspector,
    activeTab,
    setActiveTab,
    activeQuestCount,
    refreshQuestSummary,
    isCurrentLeaderSession,
    currentLeaderBoard,
    currentLeaderCompletedCount,
    currentLeaderWorkboardView,
    setLeaderWorkboardView,
  } = useStore(
    useShallow((s) => ({
      currentSessionId: s.currentSessionId,
      sidebarOpen: s.sidebarOpen,
      shortcutSettings: s.shortcutSettings,
      setSidebarOpen: s.setSidebarOpen,
      setSessionInfoOpenSessionId: s.setSessionInfoOpenSessionId,
      codexSubagentInspector: s.codexSubagentInspector,
      closeCodexSubagentInspector: s.closeCodexSubagentInspector,
      activeTab: s.activeTab,
      setActiveTab: s.setActiveTab,
      activeQuestCount:
        s.questSummary?.active ?? s.quests.reduce((count, quest) => count + (quest.status !== "done" ? 1 : 0), 0),
      refreshQuestSummary: s.refreshQuestSummary,
      isCurrentLeaderSession:
        !!s.currentSessionId &&
        s.sdkSessions.some((session) => session.sessionId === s.currentSessionId && session.isOrchestrator === true),
      currentLeaderBoard: s.currentSessionId
        ? (s.sessionBoards.get(s.currentSessionId) ?? EMPTY_LEADER_BOARD_ROWS)
        : EMPTY_LEADER_BOARD_ROWS,
      currentLeaderCompletedCount: s.currentSessionId
        ? (s.sessionCompletedBoards.get(s.currentSessionId)?.length ?? 0)
        : 0,
      currentLeaderWorkboardView: s.currentSessionId ? (s.leaderWorkboardViews.get(s.currentSessionId) ?? null) : null,
      setLeaderWorkboardView: s.setLeaderWorkboardView,
    })),
  );
  const {
    isConnected,
    status,
    currentPermCount,
    currentSdkState,
    isArchived,
    currentHasUnread,
    sessionName,
    sessionNum,
    isQuestNamed,
    questStatus,
    questReviewInboxUnread,
    idleKilled,
    activeTimerCount,
    leaderProfilePortrait,
    paused,
  } = useStore(useShallow(getCurrentTopBarSessionState));
  const diffChrome = useStore(
    useShallow((s) => {
      const target = resolveDiffTarget(s, s.currentSessionId, threadRoute.threadKey);
      const targetSessionId = target?.kind === "session" ? target.sessionId : null;
      const targetSessionVm = targetSessionId
        ? (resolveSessionNavigation(s, targetSessionId)?.viewModel ?? null)
        : null;
      return {
        diffTargetKind: target?.kind ?? null,
        diffTargetQuestId: target?.kind === "quest-commits" ? target.questId : null,
        diffButtonTitle: activeTab === "diff" ? "Back to chat" : (target?.title ?? "Show diffs"),
        changedFilesCount:
          targetSessionId && targetSessionVm ? countScopedChangedFiles(s, targetSessionId, targetSessionVm) : 0,
      };
    }),
  );
  const questDiffCommitState = useQuestCodeCommitShas(diffChrome.diffTargetQuestId);
  const diffBadgeCount =
    diffChrome.diffTargetKind === "quest-commits"
      ? questDiffCommitState.commitShas.length
      : diffChrome.changedFilesCount;
  const [infoOpen, setInfoOpen] = useState(false);
  const [configureSessionId, setConfigureSessionId] = useState<string | null>(null);
  const sessionInfoAnchorRef = useRef<HTMLDivElement | null>(null);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;
  const isPaused = paused;
  const currentLeaderActiveSummarySegments = useMemo(
    () => activeBoardSummarySegments(currentLeaderBoard),
    [currentLeaderBoard],
  );

  useEffect(() => {
    if (!isSessionView && codexSubagentInspector) closeCodexSubagentInspector();
  }, [closeCodexSubagentInspector, codexSubagentInspector, isSessionView]);

  useEffect(() => {
    const openSessionId = infoOpen && isSessionView ? currentSessionId : null;
    setSessionInfoOpenSessionId(openSessionId);
    return () => setSessionInfoOpenSessionId(null);
  }, [infoOpen, isSessionView, currentSessionId, setSessionInfoOpenSessionId]);

  // Load quests on mount and keep the badge count fresh. The quest_list_updated
  // WebSocket broadcast only reaches browsers with an active session WS connection,
  // so we also poll and refresh on tab visibility/focus as a fallback.
  useEffect(() => {
    let timeoutId: number | null = null;

    const scheduleNextPoll = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (document.visibilityState !== "visible") return;
      timeoutId = window.setTimeout(() => {
        void refreshQuestSummary();
        scheduleNextPoll();
      }, 15_000);
    };

    void refreshQuestSummary({ force: true });
    scheduleNextPoll();

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void refreshQuestSummary({ force: true });
        scheduleNextPoll();
      } else if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
    function handleFocus() {
      void refreshQuestSummary({ force: true });
      scheduleNextPoll();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshQuestSummary]);

  // Track the hash before navigating to questmaster so we can toggle back
  const prevHashRef = useRef<string>("");

  const handleQuestToggle = useCallback(() => {
    closeCodexSubagentInspector();
    if (isQuestmasterPage) {
      // Toggle back to previous view (or home)
      const prev = prevHashRef.current;
      if (prev && prev !== "#/questmaster") {
        navigateTo(prev);
      } else {
        navigateTo("");
      }
    } else {
      // Save current hash before navigating to questmaster
      prevHashRef.current = window.location.hash;
      navigateTo("/questmaster");
    }
  }, [closeCodexSubagentInspector, isQuestmasterPage]);
  const openLeaderWorkboardViewInPlace = useCallback(
    (view: LeaderWorkboardView) => {
      if (!currentSessionId) return;
      const activeView = useStore.getState().leaderWorkboardViews.get(currentSessionId) ?? null;
      setLeaderWorkboardView(currentSessionId, activeView === view ? null : view);
    },
    [currentSessionId, setLeaderWorkboardView],
  );

  if (fullPageLabel) {
    return (
      <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 bg-cc-card border-b border-cc-border">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
            title={getShortcutTitle("Toggle sidebar", shortcutSettings, "toggle_sidebar", shortcutPlatform)}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <span className="truncate text-[12px] font-semibold text-cc-fg">{fullPageLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[12px] text-cc-muted sm:gap-3">
          <GlobalNeedsInputMenu />
          <GlobalNotifyMeMenu />
          <SearchToggleButton
            isOpen={universalSearchOpen}
            onOpen={onOpenUniversalSearch}
            onClose={onCloseUniversalSearch}
          />
          <button
            onClick={handleQuestToggle}
            className={`relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg transition-colors ${
              isQuestmasterPage ? "bg-cc-active text-cc-primary" : "text-cc-muted hover:bg-cc-hover hover:text-cc-fg"
            }`}
            title={isQuestmasterPage ? "Back to session" : "Quests"}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
              <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
            </svg>
            {activeQuestCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-cc-primary px-0.5 text-[8px] font-semibold leading-none text-white">
                {activeQuestCount}
              </span>
            )}
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3 min-w-0">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title={getShortcutTitle("Toggle sidebar", shortcutSettings, "toggle_sidebar", shortcutPlatform)}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {/* Current session status + title — clickable to open session info */}
        {currentSessionId && (
          <div ref={sessionInfoAnchorRef} className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={() => {
                const nextOpen = !infoOpen;
                setInfoOpen(nextOpen);
                if (nextOpen) closeCodexSubagentInspector();
              }}
              className="flex items-center gap-1.5 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
              aria-label={[
                isCurrentLeaderSession ? "Leader" : null,
                typeof sessionNum === "number" ? `#${sessionNum}` : null,
                sessionName,
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="[&>div]:mt-0 shrink-0">
                <SessionStatusDot
                  permCount={currentPermCount}
                  isConnected={isConnected}
                  sdkState={currentSdkState}
                  status={status}
                  hasUnread={currentHasUnread}
                  idleKilled={idleKilled}
                  activeTimerCount={activeTimerCount}
                />
              </div>
              {typeof sessionNum === "number" && (
                <span className="text-[11px] font-medium text-cc-muted shrink-0" title={`Session #${sessionNum}`}>
                  #{sessionNum}
                </span>
              )}
              {leaderProfilePortrait && (
                <img
                  src={leaderProfilePortrait.smallUrl}
                  alt=""
                  width={leaderProfilePortrait.smallSize}
                  height={leaderProfilePortrait.smallSize}
                  loading="eager"
                  decoding="async"
                  data-testid="topbar-leader-profile-portrait"
                  className="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-cc-border/70"
                  draggable={false}
                />
              )}
              {sessionName && (
                <span className="min-w-0 truncate text-[11px] font-medium text-cc-fg" title={sessionName}>
                  {questLabel(sessionName, isQuestNamed, questStatus, questReviewInboxUnread)}
                </span>
              )}
            </button>
            {!isConnected && !isPaused && !isArchived && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[11px] text-cc-warning hover:text-cc-warning/80 font-medium cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-[12px] text-cc-muted">
        {currentSessionId &&
          isSessionView &&
          isCurrentLeaderSession &&
          currentLeaderActiveSummarySegments.length > 0 && (
            <LeaderWorkboardControlButton
              view="active"
              activeView={currentLeaderWorkboardView}
              onSelectView={openLeaderWorkboardViewInPlace}
              testId="topbar-workboard-shortcut"
              ariaLabel="Open active workboard"
              title="Open active workboard"
              hideUntilWide
            >
              <span className="min-w-0 truncate" data-testid="topbar-workboard-phase-summary">
                <SummarySegments segments={currentLeaderActiveSummarySegments} />
              </span>
            </LeaderWorkboardControlButton>
          )}
        {currentSessionId && isSessionView && isCurrentLeaderSession && currentLeaderCompletedCount > 0 && (
          <LeaderWorkboardControlButton
            view="completed"
            activeView={currentLeaderWorkboardView}
            onSelectView={openLeaderWorkboardViewInPlace}
            testId="topbar-completed-shortcut"
            ariaLabel="Open completed quests"
            title="Open completed quests"
            hideUntilWide
          >
            <span className="tabular-nums">{currentLeaderCompletedCount}</span>
            <span>Completed</span>
          </LeaderWorkboardControlButton>
        )}
        <GlobalNeedsInputMenu />
        <GlobalNotifyMeMenu />
        <SearchToggleButton
          isOpen={universalSearchOpen}
          onOpen={onOpenUniversalSearch}
          onClose={onCloseUniversalSearch}
        />
        {currentSessionId && isSessionView && (
          <>
            {status === "compacting" && (
              <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
            )}
            {status === "reverting" && <span className="text-cc-warning font-medium animate-pulse">Reverting...</span>}
            {/* Diffs toggle */}
            <button
              onClick={() => {
                closeCodexSubagentInspector();
                setActiveTab(activeTab === "diff" ? "chat" : "diff");
              }}
              className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                activeTab === "diff"
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title={diffChrome.diffButtonTitle}
              aria-label={diffChrome.diffButtonTitle}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M2.5 1A1.5 1.5 0 001 2.5v11A1.5 1.5 0 002.5 15h3a.5.5 0 000-1h-3a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5h3a.5.5 0 000-1h-3zM10.5 1a.5.5 0 000 1h3a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-3a.5.5 0 000 1h3A1.5 1.5 0 0015 13.5v-11A1.5 1.5 0 0013.5 1h-3zM8 3.5a.5.5 0 01.5.5v8a.5.5 0 01-1 0V4a.5.5 0 01.5-.5zM5.5 6a.5.5 0 000 1h1a.5.5 0 000-1h-1zm4 0a.5.5 0 000 1h1a.5.5 0 000-1h-1zM5.5 9a.5.5 0 000 1h1a.5.5 0 000-1h-1zm4 0a.5.5 0 000 1h1a.5.5 0 000-1h-1z" />
              </svg>
              {diffBadgeCount > 0 && (
                <span className="absolute -top-1 -right-1 text-[8px] bg-cc-primary text-white rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-semibold leading-none px-0.5">
                  {diffBadgeCount}
                </span>
              )}
            </button>
            {infoOpen && currentSessionId && (
              <SessionInfoPopover
                sessionId={currentSessionId}
                onClose={() => setInfoOpen(false)}
                anchorElement={sessionInfoAnchorRef.current}
                onConfigure={(targetSessionId) => {
                  setConfigureSessionId(targetSessionId);
                  setInfoOpen(false);
                }}
              />
            )}
            {configureSessionId && (
              <ConfigureSessionModal sessionId={configureSessionId} onClose={() => setConfigureSessionId(null)} />
            )}
          </>
        )}
        {/* Quests toggle — rightmost for stable position across views */}
        <button
          onClick={handleQuestToggle}
          className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
            isQuestmasterPage ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
          title={isQuestmasterPage ? "Back to session" : "Quests"}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
          </svg>
          {activeQuestCount > 0 && (
            <span className="absolute -top-1 -right-1 text-[8px] bg-cc-primary text-white rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-semibold leading-none px-0.5">
              {activeQuestCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}

function SearchToggleButton({ isOpen, onOpen, onClose }: { isOpen: boolean; onOpen: () => void; onClose: () => void }) {
  const shortcutSettings = useStore((s) => s.shortcutSettings);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;

  return (
    <button
      onClick={() => (isOpen ? onClose() : onOpen())}
      aria-label="Universal Search"
      data-testid="topbar-universal-search"
      className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
        isOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      title={getShortcutTitle("Universal Search", shortcutSettings, "search_session", shortcutPlatform)}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
        <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
      </svg>
    </button>
  );
}
