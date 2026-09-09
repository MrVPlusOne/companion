import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from "react";
import { hasUnreadSessionAttention } from "../utils/session-attention-status.js";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import {
  hydrateChatDisplaySettingsFromServer,
  hydrateShortcutSettingsFromServer,
  useStore,
  countUserPermissions,
  type PendingSession,
} from "../store.js";
import { api, type SessionSearchResult } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { connectSession, disconnectSession } from "../ws.js";
import { navigateToSession, navigateToMostRecentSession, parseHash } from "../utils/routing.js";
import { cancelPendingCreation } from "../utils/pending-creation.js";
import { getTreeGroupNewSessionDefaultsKey } from "../utils/new-session-defaults.js";
import { bootstrapServerId, scopedGetItem } from "../utils/scoped-storage.js";
import { TreeViewGroup } from "./TreeViewGroup.js";
import { SortableTreeGroup } from "./SortableTreeGroup.js";
import { SessionItem, type ArchiveConfirmationState } from "./SessionItem.js";
import { ArchivedSessionSection, type CommonSessionItemProps } from "./ArchivedSessionSection.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { ConfigureSessionModal } from "./ConfigureSessionModal.js";
import { buildMoveToSubmenu } from "./SidebarContextMenu.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import { SidebarBuildLabel } from "./SidebarBuildLabel.js";
import { SidebarUsageBar } from "./SidebarUsageBar.js";
import { YarnBallSpinner } from "./CatIcons.js";
import type { SdkSessionInfo } from "../types.js";
import {
  applyAuthoritativeSessionArchive,
  beginActiveSessionListRequest,
  hydrateSessionList,
  refreshTreeGroups as hydrateTreeGroups,
  SIDEBAR_SESSION_POLL_INTERVAL_MS,
  SIDEBAR_SESSION_STALE_REFRESH_MS,
} from "../session-list-hydration.js";

import { buildSidebarVisibleSessions } from "../utils/sidebar-visible-sessions.js";
import { resolveSessionNavigation } from "../utils/session-navigation-resolver.js";
import { buildReviewerByParent } from "../utils/reviewer-by-parent.js";
import { isDesktopShellLayout } from "../utils/layout.js";
import { isTouchDevice } from "../utils/mobile.js";
import { requestThreadViewportSnapshot } from "../utils/thread-viewport.js";
import { requestAutoSessionGitStatusRefreshes } from "../utils/session-git-status-auto-refresh.js";
import type { SidebarSessionItem } from "../utils/sidebar-session-item.js";
import {
  buildHerdGroupBadgeThemes,
  getHerdGroupLeaderId,
  type HerdGroupBadgeTheme,
} from "../utils/herd-group-theme.js";
import {
  DEFAULT_GROUP_VISIBLE_SESSION_LIMIT,
  readSidebarGroupVisibleLimits,
  writeSidebarGroupVisibleLimits,
} from "../utils/sidebar-group-overflow.js";
import { getShortcutTitle } from "../shortcuts.js";
import { formatDocumentTitle, getDocumentTitleAttentionCount } from "../utils/document-title-attention.js";
import { buildSidebarItemFromSearchResult } from "../utils/sidebar-search-result.js";
import { useArchivedSessionPaging } from "../hooks/useArchivedSessionPaging.js";
import { archiveGroupNavigationExcludedIds, archiveGroupSuccessfulIds } from "../utils/archive-group-reconciliation.js";

/** Restrict drag movement to vertical axis only. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [mobileReorderHandleActive, setMobileReorderHandleActive] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState<ArchiveConfirmationState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [configureSessionId, setConfigureSessionId] = useState<string | null>(null);
  const [hoveredSession, setHoveredSession] = useState<{ sessionId: string; rect: DOMRect } | null>(null);
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  const editInputRef = useRef<HTMLInputElement>(null);
  const editingSessionIdRef = useRef<string | null>(null);
  const [editingServerName, setEditingServerName] = useState(false);
  const [serverNameDraft, setServerNameDraft] = useState("");
  const serverNameInputRef = useRef<HTMLInputElement>(null);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const contextMenuBridge = useStore((s) => (contextMenu ? s.sessions.get(contextMenu.sessionId) : undefined));
  const contextMenuLeaderBridge = useStore((s) =>
    contextMenu && currentSessionId ? s.sessions.get(currentSessionId) : undefined,
  );
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const removeSession = useStore((s) => s.removeSession);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const sessionAttention = useStore((s) => s.sessionAttention);
  const sessionNotifications = useStore((s) => s.sessionNotifications);
  const reorderMode = useStore((s) => s.reorderMode);
  const setReorderMode = useStore((s) => s.setReorderMode);
  const sessionSortMode = useStore((s) => s.sessionSortMode);
  const setSessionSortMode = useStore((s) => s.setSessionSortMode);
  const treeGroups = useStore((s) => s.treeGroups);
  const treeAssignments = useStore((s) => s.treeAssignments);
  const collapsedTreeGroups = useStore((s) => s.collapsedTreeGroups);
  const toggleTreeGroupCollapse = useStore((s) => s.toggleTreeGroupCollapse);
  const collapsedTreeNodes = useStore((s) => s.collapsedTreeNodes);
  const toggleTreeNodeCollapse = useStore((s) => s.toggleTreeNodeCollapse);
  const expandedHerdNodes = useStore((s) => s.expandedHerdNodes);
  const treeNodeOrder = useStore((s) => s.treeNodeOrder);
  const pendingSessions = useStore((s) => s.pendingSessions);
  const serverName = useStore((s) => s.serverName);
  const setServerName = useStore((s) => s.setServerName);
  const setSearchPreviewSessionId = useStore((s) => s.setSearchPreviewSessionId);
  const zoomLevel = useStore((s) => s.zoomLevel ?? 1);
  const shortcutSettings = useStore((s) => s.shortcutSettings);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchIncludeArchived, setSearchIncludeArchived] = useState(false);
  const [searchLeaderOnly, setSearchLeaderOnly] = useState(false);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [bulkSelectionGroupId, setBulkSelectionGroupId] = useState<string | null>(null);
  const [bulkSelectedSessionIds, setBulkSelectedSessionIds] = useState<Set<string>>(new Set());
  const [bulkTargetGroupId, setBulkTargetGroupId] = useState("");
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkSourceMenuOpen, setBulkSourceMenuOpen] = useState(false);
  const [expandedOverflowGroups, setExpandedOverflowGroups] = useState<Set<string>>(new Set());
  const [groupVisibleLimits, setGroupVisibleLimits] = useState<Map<string, number>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sessionScrollerRef = useRef<HTMLDivElement>(null);
  const {
    archivedSessionPage,
    autoLoadUnsupported: archivedAutoLoadUnsupported,
    loadArchivedSessionsPage,
    loadMoreSentinelRef: archivedLoadMoreSentinelRef,
  } = useArchivedSessionPaging({ showArchived, scrollerRef: sessionScrollerRef });
  const route = parseHash(hash);
  const isSettingsPage = route.page === "settings";
  const isTerminalPage = route.page === "terminal";
  const isScheduledPage = route.page === "scheduled";
  const isQuestmasterPage = route.page === "questmaster";
  const isMemoryPage = route.page === "memory";
  const isDesktopLayout = isDesktopShellLayout(zoomLevel);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;

  const refreshTreeGroups = useCallback(async () => {
    await hydrateTreeGroups();
  }, []);

  const refreshSessionListNow = useCallback(
    async (refreshArchivedPage = false) => {
      try {
        const requestSequence = beginActiveSessionListRequest();
        const list = await api.listSessions({ includeArchived: false });
        hydrateSessionList(list, { preserveMissingArchived: true, activeSnapshotRequestSequence: requestSequence });
        if (refreshArchivedPage) await loadArchivedSessionsPage({ reset: true });
      } catch (err) {
        console.warn("[sidebar] session refresh failed:", err);
      }
    },
    [loadArchivedSessionsPage],
  );

  const nextAutoGroupName = useCallback(() => {
    const existing = new Set(treeGroups.map((g) => g.name));
    let n = 1;
    while (existing.has(`Session Space ${n}`)) n++;
    return `Session Space ${n}`;
  }, [treeGroups]);

  // Refresh sidebar session snapshots. The fixed 5s poll is existing behavior;
  // focus/pageshow only adds a stale-gated one-shot for mobile/background restores.
  useEffect(() => {
    let active = true;
    let refreshInFlight: Promise<void> | null = null;
    let lastRefreshStartedAt = 0;

    function refreshSessionList(force: boolean) {
      const now = Date.now();
      if (!force && now - lastRefreshStartedAt < SIDEBAR_SESSION_STALE_REFRESH_MS) {
        return refreshInFlight ?? Promise.resolve();
      }
      if (refreshInFlight) return refreshInFlight;
      lastRefreshStartedAt = now;
      refreshInFlight = (async () => {
        try {
          const requestSequence = beginActiveSessionListRequest();
          const list = await api.listSessions({ includeArchived: false });
          if (active) {
            hydrateSessionList(list, { preserveMissingArchived: true, activeSnapshotRequestSequence: requestSequence });
          }
        } catch (e) {
          console.warn("[sidebar] session poll failed:", e);
        } finally {
          refreshInFlight = null;
        }
      })();
      return refreshInFlight;
    }

    function refreshIfVisibleAndStale() {
      if (document.visibilityState === "hidden") return;
      refreshSessionList(false);
    }

    const interval = setInterval(() => refreshSessionList(true), SIDEBAR_SESSION_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisibleAndStale);
    window.addEventListener("pageshow", refreshIfVisibleAndStale);
    document.addEventListener("visibilitychange", refreshIfVisibleAndStale);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisibleAndStale);
      window.removeEventListener("pageshow", refreshIfVisibleAndStale);
      document.removeEventListener("visibilitychange", refreshIfVisibleAndStale);
    };
  }, []);

  // Hydrate tree groups on mount so sidebar renders correct grouping immediately.
  // After this initial fetch, WebSocket tree_groups_update keeps groups in sync.
  useEffect(() => {
    refreshTreeGroups()
      .then((tgs) => {
        return tgs;
      })
      .catch((e) => {
        console.warn("[sidebar] tree group hydration failed:", e);
      });
  }, [refreshTreeGroups]);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        if (s.serverName) setServerName(s.serverName);
        if (s.serverId) {
          const migrated = bootstrapServerId(s.serverId);
          if (migrated) {
            // First visit to this server — re-read store state from now-scoped keys
            const store = useStore.getState();
            const sessionId = scopedGetItem("cc-current-session");
            store.setCurrentSession(sessionId);
          }
          setGroupVisibleLimits(readSidebarGroupVisibleLimits());
        }
        hydrateShortcutSettingsFromServer(s).catch((err) => {
          console.warn("[sidebar] shortcut settings hydration failed:", err);
        });
        hydrateChatDisplaySettingsFromServer(s);
      })
      .catch(() => {});
  }, []);

  // Keep the browser-tab prefix aligned with the active global needs-input bell.
  useEffect(() => {
    const needsInputCount = getDocumentTitleAttentionCount({
      sdkSessions,
      sessionNotifications,
    });
    const suffix = import.meta.env.DEV ? "[DEV] Takode" : "Takode";
    const base = serverName ? `${serverName} — ${suffix}` : suffix;
    document.title = formatDocumentTitle(base, needsInputCount);
  }, [serverName, sessionNotifications, sdkSessions]);

  useEffect(() => {
    if (editingServerName && serverNameInputRef.current) {
      serverNameInputRef.current.focus();
      serverNameInputRef.current.select();
    }
  }, [editingServerName]);

  function confirmServerNameEdit() {
    const trimmed = serverNameDraft.trim();
    setServerName(trimmed);
    api.updateSettings({ serverName: trimmed }).catch(() => {});
    setEditingServerName(false);
  }

  function cancelServerNameEdit() {
    setEditingServerName(false);
  }

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!mobileReorderHandleActive) return;

    const clearHandleState = () => setMobileReorderHandleActive(false);
    window.addEventListener("pointerup", clearHandleState);
    window.addEventListener("pointercancel", clearHandleState);
    window.addEventListener("touchend", clearHandleState);
    window.addEventListener("touchcancel", clearHandleState);

    return () => {
      window.removeEventListener("pointerup", clearHandleState);
      window.removeEventListener("pointercancel", clearHandleState);
      window.removeEventListener("touchend", clearHandleState);
      window.removeEventListener("touchcancel", clearHandleState);
    };
  }, [mobileReorderHandleActive]);

  useEffect(() => {
    if (!reorderMode && mobileReorderHandleActive) {
      setMobileReorderHandleActive(false);
    }
  }, [mobileReorderHandleActive, reorderMode]);

  function handleSelectSession(sessionId: string) {
    setContextMenu(null);
    setSearchQuery("");
    setActiveSearchResultIndex(0);
    setSearchPreviewSessionId(null);
    api.markSessionRead?.(sessionId, { mode: "session-view" }).catch(() => {});
    // Navigate to session hash — App.tsx hash effect handles setCurrentSession + connectSession
    navigateToSession(sessionId);
    if (isDesktopLayout || !isTouchDevice()) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Skip focus-steal if user double-clicked to rename -- the rename input
          // needs to keep focus; stealing it would blur, confirm, and exit.
          if (editingSessionIdRef.current != null) return;
          useStore.getState().focusComposer();
        });
      });
    }
    if (!isDesktopLayout) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handlePreviewSearchSession(sessionId: string) {
    if (currentSessionId === sessionId) {
      setSearchPreviewSessionId(null);
      return;
    }
    setSearchPreviewSessionId(sessionId);
  }

  useEffect(() => {
    function handleFocusGlobalSearch() {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
    window.addEventListener("takode:focus-global-search", handleFocusGlobalSearch);
    return () => window.removeEventListener("takode:focus-global-search", handleFocusGlobalSearch);
  }, []);

  /** Tree view variant: assigns new session to the tree group after creation. */
  function handleCreateSessionInTreeGroup(treeGroupId: string) {
    const normalizedTreeGroupId = treeGroupId.trim();
    if (!normalizedTreeGroupId) return;

    useStore.getState().openNewSessionModal({
      treeGroupId: normalizedTreeGroupId,
      newSessionDefaultsKey: getTreeGroupNewSessionDefaultsKey(normalizedTreeGroupId),
    });

    if (!isDesktopLayout) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleCreateTreeGroup() {
    api
      .createTreeGroup(nextAutoGroupName())
      .then(() => refreshTreeGroups())
      .catch(console.error);
  }

  const startBulkSelection = useCallback(
    (groupId: string, _sessionIds?: string[]) => {
      if (collapsedTreeGroups.has(groupId)) {
        toggleTreeGroupCollapse(groupId);
      }
      setBulkSourceMenuOpen(false);
      setBulkSelectionGroupId(groupId);
      setBulkSelectedSessionIds(new Set());
      const firstTarget = treeGroups.find((group) => group.id !== groupId)?.id || "";
      setBulkTargetGroupId(firstTarget);
    },
    [collapsedTreeGroups, toggleTreeGroupCollapse, treeGroups],
  );

  const cancelBulkSelection = useCallback(() => {
    setBulkSelectionGroupId(null);
    setBulkSelectedSessionIds(new Set());
    setBulkTargetGroupId("");
    setBulkAssigning(false);
  }, []);

  const toggleBulkSession = useCallback((sessionId: string) => {
    setBulkSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleBulkSelectAll = useCallback((sessionIds: string[]) => {
    setBulkSelectedSessionIds((current) => {
      const allSelected = sessionIds.length > 0 && sessionIds.every((sessionId) => current.has(sessionId));
      return allSelected ? new Set() : new Set(sessionIds);
    });
  }, []);

  const createGroupForBulkAssignment = useCallback(async () => {
    try {
      const created = await api.createTreeGroup(nextAutoGroupName());
      await refreshTreeGroups();
      setBulkTargetGroupId(created.group.id);
    } catch (err) {
      console.warn("[sidebar] failed to create bulk target Session Space:", err);
    }
  }, [nextAutoGroupName, refreshTreeGroups]);

  const applyBulkAssignment = useCallback(async () => {
    if (!bulkSelectionGroupId || bulkSelectedSessionIds.size === 0 || !bulkTargetGroupId) return;
    setBulkAssigning(true);
    try {
      await api.assignSessionsToTreeGroup([...bulkSelectedSessionIds], bulkTargetGroupId);
      await refreshTreeGroups();
      cancelBulkSelection();
    } catch (err) {
      console.warn("[sidebar] failed to bulk assign sessions:", err);
      setBulkAssigning(false);
    }
  }, [bulkSelectedSessionIds, bulkSelectionGroupId, bulkTargetGroupId, cancelBulkSelection, refreshTreeGroups]);

  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    editingSessionIdRef.current = null;
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    editingSessionIdRef.current = null;
    setEditingName("");
  }

  function handleStartRename(id: string, currentName: string) {
    setEditingSessionId(id);
    editingSessionIdRef.current = id;
    setEditingName(currentName);
  }

  function handleContextMenu(e: React.MouseEvent, sessionId: string) {
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  }

  const handlePauseToggle = useCallback(
    async (sessionId: string, paused: boolean) => {
      try {
        if (paused) await api.unpauseSession(sessionId);
        else await api.pauseSession(sessionId);
        await refreshSessionListNow();
      } catch (err) {
        console.warn("[sidebar] failed to toggle session pause:", err);
      }
    },
    [refreshSessionListNow],
  );

  const hoverIntentRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleHoverStart(sessionId: string, rect: DOMRect) {
    if (hoverIntentRef.current) clearTimeout(hoverIntentRef.current);
    setHoveredSession({ sessionId, rect });
  }

  function handleHoverEnd() {
    hoverIntentRef.current = setTimeout(() => {
      setHoveredSession(null);
    }, 100);
  }

  function handleHoverCardEnter() {
    if (hoverIntentRef.current) clearTimeout(hoverIntentRef.current);
  }

  function handleHoverCardLeave() {
    setHoveredSession(null);
  }

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        disconnectSession(sessionId);
        await api.deleteSession(sessionId);
      } catch {
        // best-effort
      }
      if (useStore.getState().currentSessionId === sessionId) {
        navigateToMostRecentSession({ excludeId: sessionId });
      }
      removeSession(sessionId);
    },
    [removeSession],
  );

  function handleArchiveSession(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    const state = useStore.getState();
    const sdk = state.sdkSessions.find((candidate) => candidate.sessionId === sessionId);
    const bridge = state.sessions.get(sessionId);
    const isContainerized = bridge?.is_containerized === true || typeof sdk?.containerId === "string";
    const isWorktree = bridge?.is_worktree === true || sdk?.isWorktree === true;
    const isOrchestrator = bridge?.isOrchestrator === true || sdk?.isOrchestrator === true;
    const activeWorkerCount = isOrchestrator
      ? state.sdkSessions.filter((worker) => worker.herdedBy === sessionId && !worker.archived).length
      : 0;
    if (isWorktree || isContainerized || activeWorkerCount > 0) {
      setArchiveConfirmation({
        sessionId,
        kind: activeWorkerCount > 0 ? "leader" : isWorktree ? "worktree" : "container",
        activeWorkerCount: activeWorkerCount > 0 ? activeWorkerCount : undefined,
        leaderArchiveDestructiveTarget:
          activeWorkerCount > 0 && isWorktree
            ? "worktree"
            : activeWorkerCount > 0 && isContainerized
              ? "container"
              : undefined,
      });
      return;
    }
    doArchive(sessionId);
  }

  async function doArchive(sessionId: string, force?: boolean) {
    try {
      disconnectSession(sessionId);
      const result = await api.archiveSession(sessionId, force ? { force: true } : undefined);
      applyAuthoritativeSessionArchive(result.sessionId ?? sessionId, result.archivedAt);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      navigateToMostRecentSession({ excludeId: sessionId });
    }
    void refreshSessionListNow(showArchived || archivedSessionPage.loaded);
  }

  const confirmArchive = useCallback(() => {
    if (archiveConfirmation) {
      doArchive(archiveConfirmation.sessionId, true);
      setArchiveConfirmation(null);
    }
  }, [archiveConfirmation, doArchive]);

  const cancelArchive = useCallback(() => {
    setArchiveConfirmation(null);
  }, []);

  const doArchiveGroup = useCallback(
    async (leaderId: string) => {
      const state = useStore.getState();
      const workers = state.sdkSessions
        .filter((worker) => worker.herdedBy === leaderId && !worker.archived)
        .map((worker) => ({ sessionId: worker.sessionId }));
      const navigationExcludedIds = archiveGroupNavigationExcludedIds(leaderId, workers);
      let archivedIds = new Set<string>();
      try {
        for (const w of workers) {
          disconnectSession(w.sessionId);
        }
        disconnectSession(leaderId);

        const result = await api.archiveGroup(leaderId);
        archivedIds = archiveGroupSuccessfulIds(leaderId, workers, result);
        const archivedAt = Date.now();
        for (const archivedId of archivedIds) {
          applyAuthoritativeSessionArchive(archivedId, archivedAt);
        }
      } catch {
        // best-effort
      }
      // Navigate away if the current session is part of the archived group
      const currentId = useStore.getState().currentSessionId;
      if (currentId) {
        if (navigationExcludedIds.has(currentId)) {
          navigateToMostRecentSession({ excludeIds: navigationExcludedIds });
        }
      }
      void refreshSessionListNow(showArchived || archivedSessionPage.loaded);
    },
    [archivedSessionPage.loaded, refreshSessionListNow, showArchived],
  );

  const confirmArchiveHerdMembers = useCallback(() => {
    if (archiveConfirmation?.kind === "leader") {
      void doArchiveGroup(archiveConfirmation.sessionId);
      setArchiveConfirmation(null);
    }
  }, [archiveConfirmation, doArchiveGroup]);

  const doHerdToCurrentSession = useCallback(async (workerId: string, force = false) => {
    const leaderId = useStore.getState().currentSessionId;
    if (!leaderId) return;
    try {
      const result = await api.herdWorkerToLeader(workerId, leaderId, force ? { force: true } : undefined);
      if (result.herded.length === 0) {
        throw new Error("Failed to herd session");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to herd session");
      return;
    }
  }, []);

  async function handleUnarchiveSession(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    void refreshSessionListNow(true);
  }

  async function handleRetryWorktreeCleanup(e: React.MouseEvent, sessionId: string) {
    e.stopPropagation();
    let shouldRefreshImmediately = true;
    try {
      const result = await api.retryWorktreeCleanup(sessionId);
      if (result.candidate) {
        useStore.getState().updateSdkSession(result.candidate.sessionId, {
          worktreeExists: result.candidate.exists,
          worktreeCleanupStatus: result.candidate.cleanupStatus ?? undefined,
          worktreeCleanupError: result.candidate.cleanupError ?? undefined,
          worktreeCleanupStartedAt: result.candidate.cleanupStartedAt ?? undefined,
          worktreeCleanupFinishedAt: result.candidate.cleanupFinishedAt ?? undefined,
        });
        shouldRefreshImmediately = false;
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to retry worktree cleanup");
      return;
    }
    if (shouldRefreshImmediately) void refreshSessionListNow(true);
    window.setTimeout(() => void refreshSessionListNow(true), 1500);
  }

  const toggleArchivedSessions = useCallback(() => {
    const nextShowArchived = !showArchived;
    setShowArchived(nextShowArchived);
    if (nextShowArchived && !archivedSessionPage.loaded) void loadArchivedSessionsPage({ reset: true });
  }, [archivedSessionPage.loaded, loadArchivedSessionsPage, showArchived]);

  const {
    allSessionList,
    activeSessions,
    activeReviewers,
    cronSessions,
    archivedSessions,
    orderedVisibleSessionIds,
    treeViewGroups,
    sessionSetAttention,
  } = useMemo(
    () =>
      buildSidebarVisibleSessions({
        sdkSessions,
        treeGroups,
        treeAssignments,
        treeNodeOrder,
        collapsedTreeGroups,
        expandedHerdNodes,
        sessionAttention,
        sessionSortMode,
      }),
    [
      sdkSessions,
      treeGroups,
      treeAssignments,
      treeNodeOrder,
      sessionAttention,
      collapsedTreeGroups,
      expandedHerdNodes,
      sessionSortMode,
    ],
  );

  useEffect(() => {
    const sessionById = new Map(allSessionList.map((session) => [session.id, session] as const));
    const visibleWorkerSessions = orderedVisibleSessionIds
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session) => session && session.herdedBy && session.id !== currentSessionId);
    requestAutoSessionGitStatusRefreshes(visibleWorkerSessions, { requireStale: true });
  }, [allSessionList, currentSessionId, orderedVisibleSessionIds]);

  // Map: parentSessionNum -> reviewer SessionItem (for inline badge on parent row).
  // Includes archived reviewers so historical review trajectories stay inspectable
  // from their parent without becoming standalone sidebar clutter.
  const reviewerByParent = useMemo(() => buildReviewerByParent(allSessionList), [allSessionList]);
  const visibleArchivedSessions = useMemo(() => {
    const archivedById = new Map(archivedSessions.map((session) => [session.id, session] as const));
    return archivedSessionPage.ids
      .map((sessionId) => archivedById.get(sessionId))
      .filter((session): session is SidebarSessionItem => !!session);
  }, [archivedSessionPage.ids, archivedSessions]);
  const logoSrc = "/app-logo.png";
  const [showCronSessions, setShowCronSessions] = useState(true);
  const treeGroupIds = useMemo(() => treeViewGroups.map((g) => g.id), [treeViewGroups]);
  const treePointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const treeSensors = useSensors(treePointerSensor);
  const handleTreeGroupDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = treeGroupIds.indexOf(active.id as string);
      const newIndex = treeGroupIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(treeViewGroups, oldIndex, newIndex);
      const state = {
        groups: reordered.map((g) => ({ id: g.id, name: g.name })),
        assignments: Object.fromEntries(treeAssignments),
      };
      api.updateTreeGroups(state).catch((err) => {
        console.warn("[sidebar] failed to update tree group order:", err);
      });
    },
    [treeGroupIds, treeViewGroups, treeAssignments],
  );

  const toggleGroupOverflow = useCallback((groupId: string) => {
    setExpandedOverflowGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const setGroupVisibleLimit = useCallback((groupId: string, limit: number) => {
    setGroupVisibleLimits((current) => {
      const next = new Map(current);
      if (limit === DEFAULT_GROUP_VISIBLE_SESSION_LIMIT) next.delete(groupId);
      else next.set(groupId, limit);
      writeSidebarGroupVisibleLimits(next);
      return next;
    });
    setExpandedOverflowGroups((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
  }, []);

  // Session-level DnD for cross-group moves in tree view.
  // Maps each root session ID to its group so we can detect cross-group drops.
  const sessionToGroupMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of treeViewGroups) {
      for (const n of g.nodes) map.set(n.leader.id, g.id);
    }
    return map;
  }, [treeViewGroups]);
  const handleTreeSessionDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = active.id as string;
      const overId = over.id as string;
      const sourceGroup = sessionToGroupMap.get(activeId);
      const targetGroup = sessionToGroupMap.get(overId);
      if (!sourceGroup || !targetGroup) return;
      if (sourceGroup !== targetGroup) {
        api.assignSessionToTreeGroup(activeId, targetGroup).catch(console.error);
      } else {
        const group = treeViewGroups.find((g) => g.id === sourceGroup);
        if (!group) return;
        const nodeIds = group.nodes.map((n) => n.leader.id);
        const oldIndex = nodeIds.indexOf(activeId);
        const newIndex = nodeIds.indexOf(overId);
        if (oldIndex === -1 || newIndex === -1) return;
        const newOrder = arrayMove(nodeIds, oldIndex, newIndex);
        api.updateTreeNodeOrder(sourceGroup, newOrder).catch(console.error);
      }
    },
    [sessionToGroupMap, treeViewGroups],
  );
  const handleTreeDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = active.id as string;
      const overId = over.id as string;
      const activeIsGroup = treeGroupIds.includes(activeId);
      const overIsGroup = treeGroupIds.includes(overId);

      if (activeIsGroup || overIsGroup) {
        if (activeIsGroup && overIsGroup) handleTreeGroupDragEnd(event);
        return;
      }

      handleTreeSessionDragEnd(event);
    },
    [handleTreeGroupDragEnd, handleTreeSessionDragEnd, treeGroupIds],
  );

  // Server-side session search (debounced, abort on query change).
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setIsSearching(false);
      setActiveSearchResultIndex(0);
      setSearchPreviewSessionId(null);
      return;
    }

    setIsSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const resp = await api.searchSessions(q, {
          includeArchived: searchIncludeArchived,
          includeReviewers: false,
          leaderOnly: searchLeaderOnly,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSearchResults(resp.results);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("[sidebar] session search failed:", err);
        setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchIncludeArchived, searchLeaderOnly, searchQuery]);

  useEffect(() => {
    if (searchQuery.trim()) {
      setBulkSourceMenuOpen(false);
    }
  }, [searchQuery]);

  // Search filtering: map server-side results back to current session rows.
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return null;
    if (!searchResults) return [];

    const sessionsById = new Map(allSessionList.map((s) => [s.id, s]));
    const results: Array<{
      session: SidebarSessionItem;
      sessionName?: string;
      sessionPreview?: string;
      matchContext: string | null;
      matchedField: SessionSearchResult["matchedField"];
    }> = [];
    for (const match of searchResults) {
      const localSession = sessionsById.get(match.sessionId);
      const session = localSession ?? buildSidebarItemFromSearchResult(match);
      if (!session) continue;
      results.push({
        session,
        sessionName: localSession ? undefined : match.session?.name,
        sessionPreview: localSession ? undefined : match.messageMatch?.snippet,
        matchContext: match.matchContext,
        matchedField: match.matchedField,
      });
    }
    return results;
  }, [searchQuery, searchResults, allSessionList]);

  useEffect(() => {
    if (!filteredSessions || filteredSessions.length === 0) {
      setActiveSearchResultIndex(0);
      setSearchPreviewSessionId(null);
      return;
    }
    setActiveSearchResultIndex((prev) => Math.min(prev, filteredSessions.length - 1));
  }, [filteredSessions]);

  useEffect(() => {
    if (!filteredSessions || filteredSessions.length === 0) return;
    const selected = filteredSessions[activeSearchResultIndex];
    if (!selected) return;
    handlePreviewSearchSession(selected.session.id);
  }, [activeSearchResultIndex, filteredSessions]);

  const highlightedSidebarSessionId = filteredSessions?.[activeSearchResultIndex]?.session.id ?? currentSessionId;
  const highlightedSidebarSelector = filteredSessions
    ? "button[data-search-selected='true']"
    : highlightedSidebarSessionId
      ? `button[data-session-id='${highlightedSidebarSessionId}'][data-active-session='true']`
      : null;

  useEffect(() => {
    if (!highlightedSidebarSessionId || !highlightedSidebarSelector) return;
    const scroller = sessionScrollerRef.current;
    if (!scroller) return;
    const highlightedRow = scroller.querySelector<HTMLElement>(highlightedSidebarSelector);
    if (!highlightedRow) return;
    highlightedRow.scrollIntoView({ block: "nearest" });
  }, [highlightedSidebarSessionId, highlightedSidebarSelector]);

  const showSortControls = !searchFocused && !searchQuery && !filteredSessions && activeSessions.length > 1;
  const bulkSourceGroups = treeViewGroups.filter((group) => group.nodes.length > 0);
  const activeBulkSourceGroup = bulkSelectionGroupId
    ? treeViewGroups.find((group) => group.id === bulkSelectionGroupId)
    : undefined;
  const bulkDisabledBySearch = searchQuery.trim().length > 0;
  const hasNoActiveSessionRows =
    treeViewGroups.every((group) => group.nodes.length === 0) &&
    activeSessions.length === 0 &&
    cronSessions.length === 0 &&
    pendingSessions.size === 0;

  const herdHoverHighlights = useMemo(() => new Map<string, "leader" | "worker">(), []);
  const herdGroupBadgeThemes = useMemo(() => {
    const leaderThemes = buildHerdGroupBadgeThemes(allSessionList);
    const sessionThemes = new Map<string, HerdGroupBadgeTheme>();

    for (const session of allSessionList) {
      const leaderId = getHerdGroupLeaderId(session);
      if (!leaderId) continue;
      const theme = leaderThemes.get(leaderId);
      if (theme) sessionThemes.set(session.id, theme);
    }

    return sessionThemes;
  }, [allSessionList]);

  const sessionItemProps: CommonSessionItemProps = {
    onSelect: handleSelectSession,
    onStartRename: handleStartRename,
    onArchive: handleArchiveSession,
    onUnarchive: handleUnarchiveSession,
    onRetryWorktreeCleanup: handleRetryWorktreeCleanup,
    onDelete: handleDeleteSession,
    onClearRecentlyRenamed: clearRecentlyRenamed,
    onContextMenu: handleContextMenu,
    onHoverStart: handleHoverStart,
    onHoverEnd: handleHoverEnd,
    editingSessionId,
    editingName,
    setEditingName,
    onConfirmRename: confirmRename,
    onCancelRename: cancelRename,
    editInputRef,
    archiveConfirmation,
    onConfirmArchive: confirmArchive,
    onConfirmArchiveHerdMembers: confirmArchiveHerdMembers,
    onCancelArchive: cancelArchive,
  };

  return (
    <aside className="w-full sm:w-[260px] h-full flex flex-col bg-cc-sidebar border-r border-cc-border">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 mb-4">
          <img src={logoSrc} alt="" className="h-12 w-12 shrink-0 rounded-xl object-contain" />
          {editingServerName ? (
            <input
              ref={serverNameInputRef}
              value={serverNameDraft}
              onChange={(e) => setServerNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmServerNameEdit();
                if (e.key === "Escape") cancelServerNameEdit();
              }}
              onBlur={confirmServerNameEdit}
              className="text-sm font-semibold text-cc-fg tracking-tight bg-cc-input-bg border border-cc-border rounded px-1.5 py-0.5 outline-none focus:border-cc-primary/60 min-w-0 w-[140px]"
              placeholder="Takode"
              maxLength={30}
            />
          ) : (
            <span
              onClick={() => {
                setServerNameDraft(serverName || "");
                setEditingServerName(true);
              }}
              className="text-sm font-semibold text-cc-fg tracking-tight cursor-pointer hover:text-cc-primary transition-colors"
              title="Click to rename this server instance"
            >
              {serverName || "Takode"}
            </span>
          )}
          <button
            type="button"
            onClick={() => useStore.getState().setSidebarOpen(false)}
            className="sm:hidden ml-auto inline-flex items-center justify-center w-9 h-9 rounded-full border border-cc-border/70 bg-cc-hover/50 text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            aria-label="Dismiss sidebar"
            title="Dismiss sidebar"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-4 h-4">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
          {import.meta.env.DEV && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 leading-none">
              Dev
            </span>
          )}
        </div>
      </div>

      <div
        ref={sessionScrollerRef}
        data-testid="sidebar-session-scroller"
        className={`flex-1 px-2 pb-2 overflow-x-hidden ${
          mobileReorderHandleActive ? "overflow-y-hidden overscroll-none" : "overflow-y-auto"
        }`}
        style={{
          touchAction: mobileReorderHandleActive ? "none" : "pan-y",
          overscrollBehaviorX: "none",
        }}
      >
        {allSessionList.length > 0 && (
          <div className="px-2 pb-1.5 flex items-center gap-1">
            <div className="relative flex-1 transition-all duration-200 ease-in-out">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-cc-muted pointer-events-none"
              >
                <circle cx="6.5" cy="6.5" r="4.5" />
                <path d="M10 10l3.5 3.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setActiveSearchResultIndex(0);
                  setSearchQuery(e.target.value);
                }}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchPreviewSessionId(null);
                    searchInputRef.current?.blur();
                    return;
                  }
                  if (!filteredSessions || filteredSessions.length === 0) {
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveSearchResultIndex((prev) => (prev + 1) % filteredSessions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveSearchResultIndex(
                      (prev) => (prev - 1 + filteredSessions.length) % filteredSessions.length,
                    );
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const selected = filteredSessions[activeSearchResultIndex];
                    if (selected) {
                      setSearchQuery("");
                      setActiveSearchResultIndex(0);
                      setSearchPreviewSessionId(null);
                      handleSelectSession(selected.session.id);
                    }
                  }
                }}
                placeholder="Search..."
                title="Search sessions"
                className="w-full pl-6 pr-6 py-1.5 text-[11px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder-cc-muted outline-none focus:border-cc-primary/60 transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear session search"
                  title="Clear session search"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchPreviewSessionId(null);
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
            {bulkSourceGroups.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (bulkDisabledBySearch) return;
                  setBulkSourceMenuOpen((open) => !open);
                }}
                disabled={bulkDisabledBySearch}
                title={
                  bulkDisabledBySearch
                    ? "Clear search to bulk organize Session Spaces"
                    : activeBulkSourceGroup
                      ? `Bulk organizing ${activeBulkSourceGroup.name} Session Space`
                      : "Bulk organize sessions by source Session Space"
                }
                aria-label={
                  bulkDisabledBySearch
                    ? "Clear search to bulk organize Session Spaces"
                    : "Bulk organize sessions by source Session Space"
                }
                className={`shrink-0 h-7 px-2 inline-flex items-center justify-center rounded-md text-[10px] font-semibold transition-colors ${
                  bulkSelectionGroupId
                    ? "bg-cc-primary/15 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                } ${bulkDisabledBySearch ? "opacity-45 cursor-not-allowed" : "cursor-pointer"}`}
              >
                Bulk
              </button>
            )}
            {showSortControls && sessionSortMode !== "activity" && (
              <button
                onClick={() => setReorderMode(!reorderMode)}
                className={`sm:hidden text-[10px] font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                  reorderMode ? "bg-cc-primary/10 text-cc-primary" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                {reorderMode ? "Done" : "Edit"}
              </button>
            )}
            {showSortControls && (
              <button
                onClick={() => setSessionSortMode(sessionSortMode === "created" ? "activity" : "created")}
                title={sessionSortMode === "activity" ? "Sorted by last user message" : "Sorted by creation time"}
                className={`text-[10px] font-medium px-1.5 py-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                  sessionSortMode === "activity"
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                {sessionSortMode === "activity" ? (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <path d="M3 4h10M3 8h7M3 12h4" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )}

        {searchQuery.trim() && (
          <div className="px-2 pb-1.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={searchIncludeArchived}
              onClick={() => {
                setActiveSearchResultIndex(0);
                setSearchIncludeArchived((current) => !current);
              }}
              className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                searchIncludeArchived
                  ? "border-cc-primary/30 bg-cc-primary/15 text-cc-primary"
                  : "border-cc-border/70 bg-cc-bg/60 text-cc-muted hover:text-cc-fg"
              }`}
            >
              Include archived
            </button>
            <button
              type="button"
              aria-pressed={searchLeaderOnly}
              onClick={() => {
                setActiveSearchResultIndex(0);
                setSearchLeaderOnly((current) => !current);
              }}
              className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                searchLeaderOnly
                  ? "border-cc-primary/30 bg-cc-primary/15 text-cc-primary"
                  : "border-cc-border/70 bg-cc-bg/60 text-cc-muted hover:text-cc-fg"
              }`}
            >
              Leaders only
            </button>
          </div>
        )}

        {bulkSourceMenuOpen && !bulkDisabledBySearch && bulkSourceGroups.length > 0 && (
          <div className="mx-2 mb-1.5 rounded-md border border-cc-border/70 bg-cc-card/70 p-1.5 shadow-sm">
            <div className="px-1 pb-1 text-[10px] font-medium text-cc-muted">Choose source Session Space</div>
            <div className="space-y-1">
              {bulkSourceGroups.map((group) => {
                const rootSessionIds = group.nodes.map((node) => node.leader.id);
                const sessionCount = rootSessionIds.length;
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => startBulkSelection(group.id, rootSessionIds)}
                    className="w-full min-w-0 rounded px-2 py-1.5 text-left text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                    aria-label={`Bulk organize ${group.name} Session Space`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      <span className="shrink-0 text-[10px] text-cc-muted">
                        {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {filteredSessions !== null ? (
          /* Search results: flat list across all sessions */
          filteredSessions.length === 0 ? (
            <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
              {isSearching ? "Searching..." : "No matching sessions."}
            </p>
          ) : (
            <div className="space-y-2 sm:space-y-0.5">
              {filteredSessions.map(({ session: s, sessionName, sessionPreview, matchContext, matchedField }) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  isActive={currentSessionId === s.id}
                  isSearchSelected={filteredSessions[activeSearchResultIndex]?.session.id === s.id}
                  isArchived={s.archived}
                  sessionName={sessionName ?? s.name ?? undefined}
                  sessionPreview={sessionPreview ?? (s.lastMessagePreview || undefined)}
                  permCount={s.permCount}
                  attention={sessionSetAttention.get(s.id) ?? null}
                  hasUnread={hasUnreadSessionAttention(sessionSetAttention.get(s.id))}
                  isRecentlyRenamed={recentlyRenamed.has(s.id)}
                  herdGroupBadgeTheme={herdGroupBadgeThemes.get(s.id)}
                  herdHoverHighlight={herdHoverHighlights.get(s.id)}
                  matchContext={matchContext}
                  matchedField={matchedField}
                  matchQuery={searchQuery}
                  useStatusBar
                  {...sessionItemProps}
                />
              ))}
            </div>
          )
        ) : treeViewGroups.length === 0 &&
          activeSessions.length === 0 &&
          cronSessions.length === 0 &&
          archivedSessionPage.loaded &&
          (archivedSessionPage.total ?? 0) === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">No sessions yet.</p>
        ) : (
          <>
            {pendingSessions.size > 0 && (
              <div className="space-y-2 sm:space-y-0.5 mb-1">
                {Array.from(pendingSessions.values())
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((ps) => (
                    <PendingSessionItem
                      key={ps.id}
                      pending={ps}
                      isActive={currentSessionId === ps.id}
                      onSelect={() => {
                        navigateToSession(ps.id);
                      }}
                      onCancel={() => cancelPendingCreation(ps.id)}
                    />
                  ))}
              </div>
            )}

            <DndContext
              sensors={sessionSortMode === "activity" || bulkSelectionGroupId ? [] : treeSensors}
              collisionDetection={closestCenter}
              onDragEnd={sessionSortMode === "activity" || bulkSelectionGroupId ? undefined : handleTreeDragEnd}
              modifiers={[restrictToVerticalAxis]}
            >
              <SortableContext items={treeGroupIds} strategy={verticalListSortingStrategy}>
                {treeViewGroups.map((group, i) => (
                  <SortableTreeGroup key={group.id} id={group.id}>
                    {({ setNodeRef, style, listeners, attributes, isDragging }) => (
                      <div ref={setNodeRef} style={style}>
                        <TreeViewGroup
                          group={group}
                          isGroupCollapsed={collapsedTreeGroups.has(group.id)}
                          collapsedTreeNodes={collapsedTreeNodes}
                          onToggleGroupCollapse={toggleTreeGroupCollapse}
                          onToggleNodeCollapse={toggleTreeNodeCollapse}
                          onCreateSession={handleCreateSessionInTreeGroup}
                          currentSessionId={currentSessionId}
                          recentlyRenamed={recentlyRenamed}
                          isFirst={i === 0}
                          groupDragging={isDragging}
                          onMobileReorderHandleActiveChange={setMobileReorderHandleActive}
                          groupDragHandleProps={
                            treeViewGroups.length > 1 && sessionSortMode !== "activity" && !bulkSelectionGroupId
                              ? {
                                  listeners: listeners as Record<string, unknown> | undefined,
                                  attributes: attributes as unknown as Record<string, unknown>,
                                }
                              : undefined
                          }
                          visibleSessionLimit={groupVisibleLimits.get(group.id) ?? DEFAULT_GROUP_VISIBLE_SESSION_LIMIT}
                          overflowExpanded={expandedOverflowGroups.has(group.id)}
                          onToggleOverflow={toggleGroupOverflow}
                          onSetVisibleSessionLimit={setGroupVisibleLimit}
                          sessionAttention={sessionSetAttention}
                          herdGroupBadgeThemes={herdGroupBadgeThemes}
                          bulkSelectionActive={bulkSelectionGroupId === group.id}
                          bulkSelectedSessionIds={bulkSelectedSessionIds}
                          bulkTargetGroupId={bulkTargetGroupId}
                          bulkAssigning={bulkAssigning}
                          availableBulkTargetGroups={treeGroups.filter((candidate) => candidate.id !== group.id)}
                          onCancelBulkSelection={cancelBulkSelection}
                          onToggleBulkSession={toggleBulkSession}
                          onToggleBulkSelectAll={toggleBulkSelectAll}
                          onBulkTargetGroupChange={setBulkTargetGroupId}
                          onApplyBulkAssignment={applyBulkAssignment}
                          onCreateGroupForBulkAssignment={createGroupForBulkAssignment}
                          {...sessionItemProps}
                        />
                      </div>
                    )}
                  </SortableTreeGroup>
                ))}
              </SortableContext>
            </DndContext>
            <button
              onClick={handleCreateTreeGroup}
              className="w-full mt-1 px-2 py-1.5 flex items-center gap-1.5 rounded-md text-[10px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3 h-3">
                <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
              </svg>
              <span className="font-medium">New Session Space</span>
            </button>

            {cronSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-cc-border">
                <button
                  onClick={() => setShowCronSessions(!showCronSessions)}
                  className="w-full px-3 py-1.5 text-[11px] font-medium text-violet-400 uppercase tracking-wider flex items-center gap-1.5 hover:text-violet-300 transition-colors cursor-pointer"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform ${showCronSessions ? "rotate-90" : ""}`}
                  >
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                    <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
                  </svg>
                  Scheduled Runs ({cronSessions.length})
                </button>
                {showCronSessions && (
                  <div className="space-y-2 sm:space-y-0.5 mt-1">
                    {cronSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        sessionName={s.name ?? undefined}
                        permCount={s.permCount}
                        attention={sessionSetAttention.get(s.id) ?? null}
                        hasUnread={hasUnreadSessionAttention(sessionSetAttention.get(s.id))}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        herdGroupBadgeTheme={herdGroupBadgeThemes.get(s.id)}
                        herdHoverHighlight={herdHoverHighlights.get(s.id)}
                        reviewerSession={s.sessionNum != null ? reviewerByParent.get(s.sessionNum) : undefined}
                        useStatusBar
                        {...sessionItemProps}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <ArchivedSessionSection
              showArchived={showArchived}
              hasNoActiveSessionRows={hasNoActiveSessionRows}
              loaded={archivedSessionPage.loaded}
              loading={archivedSessionPage.loading}
              error={archivedSessionPage.error}
              hasMore={archivedSessionPage.hasMore}
              total={archivedSessionPage.total}
              archivedSessions={visibleArchivedSessions}
              autoLoadUnsupported={archivedAutoLoadUnsupported}
              loadMoreSentinelRef={archivedLoadMoreSentinelRef}
              currentSessionId={currentSessionId}
              recentlyRenamed={recentlyRenamed}
              herdGroupBadgeThemes={herdGroupBadgeThemes}
              herdHoverHighlights={herdHoverHighlights}
              reviewerByParent={reviewerByParent}
              sessionItemProps={sessionItemProps}
              onToggle={toggleArchivedSessions}
              onLoadMore={() => void loadArchivedSessionsPage()}
            />
          </>
        )}
      </div>

      <div className="px-3 py-2 border-t border-cc-border space-y-1.5">
        <SidebarUsageBar />
        <div className="flex items-center justify-around">
          <button
            title={getShortcutTitle("Terminal", shortcutSettings, "open_terminal", shortcutPlatform)}
            onClick={() => {
              if (!isTerminalPage) {
                const state = useStore.getState();
                const sessionId = state.currentSessionId;
                requestThreadViewportSnapshot(sessionId);
                const sessionCwd =
                  (sessionId ? state.sessions.get(sessionId)?.cwd : null) ??
                  state.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd ??
                  null;
                if (sessionCwd) {
                  state.openTerminal(sessionCwd, sessionId);
                }
              }
              window.location.hash = "#/terminal";
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isTerminalPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="w-4 h-4">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M4.5 7l2.5 2-2.5 2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9 11h3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            title="To-dos & Timers"
            aria-label="To-dos & Timers"
            onClick={() => {
              if (isScheduledPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/scheduled";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isScheduledPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              className="w-4 h-4"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <path d="m7 8 1.5 1.5L11 7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 14h4" strokeLinecap="round" />
              <circle cx="16" cy="15" r="3" />
              <path d="M16 13.5V15l1 1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            title="Memory"
            onClick={() => {
              if (isMemoryPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/memory";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isMemoryPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
              data-testid="memory-nav-icon"
            >
              <path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .5 6.6A4 4 0 1 0 12 18Z" />
              <path d="M12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.5 6.6A4 4 0 1 1 12 18Z" />
              <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
            </svg>
          </button>
          <button
            title="Quests"
            onClick={() => {
              if (isQuestmasterPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/questmaster";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isQuestmasterPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
            </svg>
          </button>
          <button
            title="Settings"
            onClick={() => {
              if (isSettingsPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/settings";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isSettingsPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        <SidebarBuildLabel
          buildTime={__BUILD_TIME__}
          onOpenChangelog={() => {
            if (!isDesktopLayout) {
              useStore.getState().setSidebarOpen(false);
            }
          }}
        />
      </div>
      {contextMenu &&
        (() => {
          const sdk = sdkSessions.find((s) => s.sessionId === contextMenu.sessionId);
          const bridge = contextMenuBridge;
          const sessionInfo = allSessionList.find((s) => s.id === contextMenu.sessionId);
          if (!sdk && !bridge) return null;
          const cliId = sdk?.cliSessionId || "";
          const isArchived = sdk?.archived === true;
          const isExited = sdk?.state === "exited";
          const isPaused = !!(bridge?.pause ?? sdk?.pause);
          const attention = sessionAttention.get(contextMenu.sessionId);
          const backendType = bridge?.backend_type ?? sdk?.backendType ?? "claude";
          const currentLeaderSdk = sdkSessions.find((s) => s.sessionId === currentSessionId);
          const currentLeaderBridge = contextMenuLeaderBridge;
          const isCurrentLeader =
            currentLeaderBridge?.isOrchestrator === true || currentLeaderSdk?.isOrchestrator === true;
          const isTargetLeader = bridge?.isOrchestrator === true || sdk?.isOrchestrator === true;
          const canHerdToCurrentSession =
            !isArchived &&
            !isExited &&
            !!currentSessionId &&
            currentSessionId !== contextMenu.sessionId &&
            isCurrentLeader &&
            !isTargetLeader;
          const needsForceHerd = canHerdToCurrentSession && !!sdk?.herdedBy && sdk.herdedBy !== currentSessionId;

          // Count non-archived herded workers for the leader+herd archive option.
          const herdedWorkers =
            !isArchived && isTargetLeader
              ? sdkSessions.filter((worker) => worker.herdedBy === contextMenu.sessionId && !worker.archived)
              : [];

          const sessionNum = sessionInfo?.sessionNum ?? sdk?.sessionNum;
          const items: ContextMenuItem[] = [
            ...(sessionNum != null
              ? [
                  {
                    label: "Copy Session Number",
                    onClick: () => {
                      writeClipboardText(`#${sessionNum}`).catch(console.error);
                    },
                  },
                ]
              : [
                  {
                    label: "Copy Session ID",
                    onClick: () => {
                      writeClipboardText(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]),
            ...(cliId
              ? [
                  {
                    label: "Copy CLI Session ID",
                    onClick: () => {
                      writeClipboardText(cliId).catch(console.error);
                    },
                  },
                ]
              : []),
            {
              label: "Rename",
              onClick: () => {
                const name = allSessionList.find((session) => session.id === contextMenu.sessionId)?.name || "";
                handleStartRename(contextMenu.sessionId, name);
              },
            },
            ...(!isArchived
              ? [
                  {
                    label: "Configure Session",
                    onClick: () => {
                      setConfigureSessionId(contextMenu.sessionId);
                    },
                  },
                ]
              : []),
            ...(!isArchived
              ? [
                  {
                    label: isPaused ? "Unpause Session" : "Pause Session",
                    onClick: () => {
                      void handlePauseToggle(contextMenu.sessionId, isPaused);
                    },
                  },
                ]
              : []),
            ...(!isExited && !isArchived
              ? [
                  {
                    label: "Relaunch",
                    onClick: () => {
                      api.relaunchSession(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            // Transport switch: only for Claude-family sessions that are alive
            ...(backendType === "claude" && !isExited && !isArchived
              ? [
                  {
                    label: "Switch to SDK",
                    onClick: () => {
                      api.upgradeTransport(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            ...(backendType === "claude-sdk" && !isExited && !isArchived
              ? [
                  {
                    label: "Switch to WebSocket",
                    onClick: () => {
                      api.downgradeTransport(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            attention
              ? {
                  label: "Mark as read",
                  onClick: () => {
                    api.markSessionRead?.(contextMenu.sessionId).catch(() => {});
                  },
                }
              : {
                  label: "Mark as unread",
                  onClick: () => {
                    api.markSessionUnread(contextMenu.sessionId).catch(() => {});
                  },
                },
            // Tree groups are now the only session-browsing mode in the sidebar.
            ...buildMoveToSubmenu(treeGroups, treeAssignments, contextMenu.sessionId),
            ...(canHerdToCurrentSession
              ? [
                  {
                    label: needsForceHerd ? "Force Herd to Current Session" : "Herd to Current Session",
                    onClick: () => {
                      void doHerdToCurrentSession(contextMenu.sessionId, needsForceHerd);
                    },
                    ...(needsForceHerd
                      ? {
                          confirm: {
                            title: "Force herd takeover?",
                            description:
                              "This will move the session out of its current leader's herd into your current leader session.",
                            confirmLabel: "Force Herd",
                          },
                        }
                      : {}),
                  },
                ]
              : []),
            isArchived
              ? {
                  label: "Unarchive",
                  onClick: () => {
                    const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                    void handleUnarchiveSession(syntheticEvent, contextMenu.sessionId);
                  },
                }
              : {
                  label: "Archive",
                  onClick: () => {
                    const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                    handleArchiveSession(syntheticEvent, contextMenu.sessionId);
                  },
                },
            // Archives the leader and all active herded workers in one action.
            ...(herdedWorkers.length > 0
              ? [
                  {
                    label: "Archive Leader + Herd",
                    onClick: () => {
                      doArchiveGroup(contextMenu.sessionId);
                    },
                    confirm: {
                      title: "Archive leader and herd?",
                      description: `This will archive the leader and ${herdedWorkers.length} worker session${herdedWorkers.length === 1 ? "" : "s"}.`,
                      confirmLabel: "Archive Leader + Herd",
                      destructive: true,
                    },
                  },
                ]
              : []),
            {
              label: "Delete Session",
              onClick: () => {
                const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                void handleDeleteSession(syntheticEvent, contextMenu.sessionId);
              },
              confirm: {
                title: "Delete session permanently?",
                description: "This cannot be undone. The session will be removed from history.",
                confirmLabel: "Delete",
                destructive: true,
              },
            },
          ];

          return (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              items={items}
              onClose={() => setContextMenu(null)}
              widthClassName="w-56 max-w-[calc(100vw-1rem)]"
              itemClassName="whitespace-normal break-words leading-snug"
            />
          );
        })()}
      {configureSessionId && (
        <ConfigureSessionModal sessionId={configureSessionId} onClose={() => setConfigureSessionId(null)} />
      )}
      {hoveredSession &&
        (() => {
          const s = allSessionList.find((item) => item.id === hoveredSession.sessionId);
          if (!s) return null;
          return (
            <SessionHoverCard
              session={s}
              sessionName={s.name ?? undefined}
              sessionPreview={s.lastMessagePreview || undefined}
              taskHistory={sessionTaskHistory.get(hoveredSession.sessionId)}
              cliSessionId={sdkSessions.find((sdk) => sdk.sessionId === hoveredSession.sessionId)?.cliSessionId}
              anchorRect={hoveredSession.rect}
              onMouseEnter={handleHoverCardEnter}
              onMouseLeave={handleHoverCardLeave}
            />
          );
        })()}
    </aside>
  );
}

// ─── Pending Session Chip ────────────────────────────────────────────────────

function PendingSessionItem({
  pending,
  isActive,
  onSelect,
  onCancel,
}: {
  pending: PendingSession;
  isActive: boolean;
  onSelect: () => void;
  onCancel: () => void;
}) {
  const folderName = pending.cwd?.split("/").pop() || "New session";
  const logoSrc = pending.backend === "codex" ? "/logo-codex.svg" : "/logo.png";
  const hasError = pending.status === "error";
  const isCreating = pending.status === "creating";

  // Accent color based on backend (matching SessionItem pattern)
  const accentColor = pending.backend === "codex" ? "border-blue-500" : "border-[#c47a4e]";

  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors border-l-2 ${accentColor} ${
        isActive ? "bg-cc-active" : "hover:bg-cc-hover"
      }`}
    >
      {/* Status indicator */}
      <div className="w-4 h-4 shrink-0 flex items-center justify-center">
        {isCreating && <YarnBallSpinner className="w-3.5 h-3.5 text-cc-primary" />}
        {hasError && (
          <div className="w-3 h-3 rounded-full bg-cc-error/20 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-cc-error" />
          </div>
        )}
        {pending.status === "succeeded" && (
          <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-success">
            <path
              d="M13.25 4.75L6 12 2.75 8.75"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      {/* Name and subtitle */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <img src={logoSrc} alt="" className="w-3 h-3 opacity-60" />
          <span className="text-xs font-medium text-cc-fg truncate">{folderName}</span>
        </div>
        <span className={`text-[10px] leading-tight truncate block ${hasError ? "text-cc-error" : "text-cc-muted"}`}>
          {hasError ? "Creation failed" : isCreating ? "Creating session..." : "Ready"}
        </span>
      </div>

      {/* Cancel/delete button (visible on hover) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 text-cc-muted hover:text-cc-error transition-all cursor-pointer"
        title={hasError ? "Dismiss" : "Cancel creation"}
      >
        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
