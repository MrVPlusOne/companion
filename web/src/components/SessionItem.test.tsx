// @vitest-environment jsdom
import { render, fireEvent, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState, type ComponentProps } from "react";
import type { SidebarSessionItem as SessionItemType } from "../utils/sidebar-session-item.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";
import { hasUnreadSessionAttention } from "../utils/session-attention-status.js";
import {
  SESSION_ATTENTION_PROJECTION,
  type SessionAttentionProjectionValue,
} from "../../shared/session-attention-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../shared/leader-thread-tabs-projection.js";
import { createLeaderThreadTabsProjectionValue } from "../test-fixtures/leader-thread-tabs-projection.js";

const mockStoreState = {
  questNamedSessions: new Set<string>(),
  sessions: new Map<string, { claimedQuestStatus?: string; claimedQuestVerificationInboxUnread?: boolean }>(),
  sessionTaskPreview: new Map<string, { text: string; updatedAt: number }>(),
  sessionPreviewUpdatedAt: new Map<string, number>(),
  sessionAttention: new Map<string, "action" | "error" | "review" | null>(),
  syncedProjectionValues: new Map<string, unknown>(),
  syncedProjectionVersions: new Map(),
  syncedProjectionKeys: new Set<string>(),
  sessionNotifications: new Map<string, Array<any>>(),
  sessionTimers: new Map<string, Array<{ id: string }>>(),
  sessionBoards: new Map<string, Array<any>>(),
  sessionCompletedBoards: new Map<string, Array<any>>(),
  sessionBoardRowStatuses: new Map<string, Record<string, any>>(),
  quests: [] as Array<any>,
  sdkSessions: [] as Array<any>,
  currentSessionId: "s1",
  updateSdkSession: vi.fn(),
};

function installLeaderPhaseSummary(
  summary: ReturnType<typeof createLeaderThreadTabsProjectionValue>["activePhaseSummary"],
): void {
  const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, "s1");
  mockStoreState.syncedProjectionKeys.add(entryId);
  mockStoreState.syncedProjectionValues.set(
    entryId,
    createLeaderThreadTabsProjectionValue({ activePhaseSummary: summary }),
  );
}

vi.mock("../store.js", () => ({
  useStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

vi.mock("../api.js", () => ({
  api: {
    updateLeaderProfilePortrait: vi.fn(async (_sessionId: string, portraitId: string) => ({
      ok: true,
      sessionId: "s1",
      leaderProfilePortraitId: portraitId,
      leaderProfilePortrait: {
        id: portraitId,
        poolId: portraitId.startsWith("shmi") ? "shmi" : "tako",
        label: portraitId,
        smallUrl: `/leader-profile-portraits/test/${portraitId}.96.webp`,
        largeUrl: `/leader-profile-portraits/test/${portraitId}.320.webp`,
        smallSize: 96,
        largeSize: 320,
        smallBytes: 1,
        largeBytes: 1,
      },
    })),
  },
}));

const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));

import { SessionItem } from "./SessionItem.js";
import { api } from "../api.js";
import { LEADER_PROFILE_PORTRAITS } from "../../shared/leader-profile-portraits.js";

const TAKO_PORTRAIT = LEADER_PROFILE_PORTRAITS[0];
const SHMI_PORTRAIT = LEADER_PROFILE_PORTRAITS.find((portrait) => portrait.poolId === "shmi")!;

beforeEach(() => {
  mockStoreState.updateSdkSession.mockClear();
  vi.mocked(api.updateLeaderProfilePortrait).mockClear();
  mockStoreState.questNamedSessions.clear();
  mockStoreState.sessions.clear();
  mockStoreState.sessionTaskPreview.clear();
  mockStoreState.sessionPreviewUpdatedAt.clear();
  mockStoreState.sessionBoards.clear();
  mockStoreState.sessionCompletedBoards.clear();
  mockStoreState.sessionBoardRowStatuses.clear();
  mockStoreState.quests = [];
  mockStoreState.syncedProjectionValues.clear();
  mockStoreState.syncedProjectionVersions.clear();
  mockStoreState.syncedProjectionKeys.clear();
});

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "s1",
    model: "gpt-5-codex",
    cwd: "/repo",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "codex",
    repoRoot: "/repo",
    permCount: 0,
    ...overrides,
  };
}

function renderSessionItem(overrides: Partial<ComponentProps<typeof SessionItem>> = {}) {
  const onArchive = vi.fn();
  const onSelect = vi.fn();
  const session = overrides.session ?? makeSession();
  const projectedAttention = mockStoreState.sessionAttention.get(session.id) ?? null;

  const view = render(
    <SessionItem
      session={session}
      isActive={false}
      isArchived={false}
      sessionName="Session"
      sessionPreview="preview"
      permCount={0}
      isRecentlyRenamed={false}
      onSelect={onSelect}
      onStartRename={vi.fn()}
      onArchive={onArchive}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
      onClearRecentlyRenamed={vi.fn()}
      editingSessionId={null}
      editingName=""
      setEditingName={vi.fn()}
      onConfirmRename={vi.fn()}
      onCancelRename={vi.fn()}
      editInputRef={{ current: null }}
      attention={projectedAttention}
      hasUnread={hasUnreadSessionAttention(projectedAttention)}
      {...overrides}
    />,
  );

  return {
    ...view,
    onArchive,
    onSelect,
  };
}

it("hides the archived delete action on mobile cards", () => {
  renderSessionItem({
    session: makeSession({ archived: true }),
    isArchived: true,
  });

  const deleteButton = screen.getByTitle("Delete permanently");
  expect(deleteButton).toHaveClass("hidden");
  expect(deleteButton).toHaveClass("sm:block");
});

function EditingSessionItem({
  onConfirmRename = vi.fn(),
  onCancelRename = vi.fn(),
}: {
  onConfirmRename?: ReturnType<typeof vi.fn>;
  onCancelRename?: ReturnType<typeof vi.fn>;
}) {
  const [editingName, setEditingName] = useState("Session");

  return (
    <SessionItem
      session={makeSession()}
      isActive={false}
      isArchived={false}
      sessionName="Session"
      sessionPreview="preview"
      permCount={0}
      isRecentlyRenamed={false}
      onSelect={vi.fn()}
      onStartRename={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
      onClearRecentlyRenamed={vi.fn()}
      editingSessionId="s1"
      editingName={editingName}
      setEditingName={setEditingName}
      onConfirmRename={onConfirmRename as () => void}
      onCancelRename={onCancelRename as () => void}
      editInputRef={{ current: null }}
    />
  );
}

function setSessionNotifications(sessionId: string, notifications: Array<any>) {
  mockStoreState.sessionNotifications.set(sessionId, notifications);
  const active = notifications.filter((notification) => !notification.done);
  const needsInput = active.filter((notification) => notification.category === "needs-input" && !notification.muted);
  const review = active.filter((notification) => notification.category === "review");
  const muted = active.filter((notification) => notification.category === "needs-input" && notification.muted);
  setSessionAttentionProjection(
    sessionId,
    needsInput.length > 0
      ? { attentionReason: "action", status: { urgency: "needs-input", count: needsInput.length } }
      : review.length > 0
        ? { attentionReason: "review", status: { urgency: "review", count: review.length } }
        : muted.length > 0
          ? { attentionReason: null, status: { urgency: "muted-needs-input", count: muted.length } }
          : { attentionReason: null, status: null },
  );
}

function setSessionTimers(sessionId: string, timerIds: string[]) {
  mockStoreState.sessionTimers.set(
    sessionId,
    timerIds.map((id) => ({ id })),
  );
}

function setSessionAttentionProjection(sessionId: string, value: SessionAttentionProjectionValue) {
  const entryId = syncedProjectionEntryId(SESSION_ATTENTION_PROJECTION, sessionId);
  mockStoreState.syncedProjectionKeys.add(entryId);
  mockStoreState.syncedProjectionValues.set(entryId, value);
  mockStoreState.sessionAttention.set(sessionId, value.attentionReason);
}

const SAGE_THEME: HerdGroupBadgeTheme = {
  token: "sage",
  textColor: "rgb(159, 214, 172)",
  borderColor: "rgba(119, 191, 139, 0.34)",
  leaderBackground: "rgba(119, 191, 139, 0.16)",
  herdBackground: "rgba(119, 191, 139, 0.1)",
};

describe("SessionItem swipe archive", () => {
  it("archives on right swipe in normal mode", () => {
    const { getByText, onArchive } = renderSessionItem();
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 80, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 170, clientY: 42 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive.mock.calls[0][1]).toBe("s1");
  });

  it("archives on left swipe in normal mode", () => {
    const { getByText, onArchive } = renderSessionItem();
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 180, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 90, clientY: 38 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive.mock.calls[0][1]).toBe("s1");
  });

  it("disables swipe archive while reorder mode is active", () => {
    const { getByText, onArchive } = renderSessionItem({ reorderMode: true });
    const item = getByText("Session").closest("button")!;

    fireEvent.touchStart(item, { touches: [{ clientX: 80, clientY: 40 }] });
    fireEvent.touchMove(item, { touches: [{ clientX: 170, clientY: 42 }] });
    fireEvent.touchEnd(item);

    expect(onArchive).not.toHaveBeenCalled();
  });

  it("does not select the session when the mobile reorder handle is tapped", () => {
    const { onSelect } = renderSessionItem({
      reorderMode: true,
      onMobileReorderHandleActiveChange: vi.fn(),
      dragHandleProps: {},
    });

    const handle = screen.getByTestId("session-drag-handle-s1");
    fireEvent.click(handle);

    expect(onSelect).not.toHaveBeenCalled();
    expect(handle).toHaveClass("touch-none");
  });
});

describe("SessionItem archive confirmation copy", () => {
  it("shows the worktree warning when confirming a worktree archive", () => {
    renderSessionItem({
      archiveConfirmation: { sessionId: "s1", kind: "worktree" },
      onConfirmArchive: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/delete the worktree/i)).toBeInTheDocument();
  });

  it("shows the leader warning with the active worker count", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      archiveConfirmation: { sessionId: "s1", kind: "leader", activeWorkerCount: 2 },
      onConfirmArchive: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/archive only this leader/i)).toBeInTheDocument();
    expect(screen.getByText(/2 active herd member sessions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader Only" })).toBeInTheDocument();
  });

  it("offers a leader plus herd archive action when the caller provides one", () => {
    const onConfirmArchive = vi.fn();
    const onConfirmArchiveHerdMembers = vi.fn();
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      archiveConfirmation: { sessionId: "s1", kind: "leader", activeWorkerCount: 2 },
      onConfirmArchive,
      onConfirmArchiveHerdMembers,
      onCancelArchive: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Archive Leader Only" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Leader + Herd" }));

    expect(onConfirmArchive).toHaveBeenCalledTimes(1);
    expect(onConfirmArchiveHerdMembers).toHaveBeenCalledTimes(1);
  });

  it("preserves the worktree warning for leader archive choices", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, isWorktree: true }),
      archiveConfirmation: {
        sessionId: "s1",
        kind: "leader",
        activeWorkerCount: 2,
        leaderArchiveDestructiveTarget: "worktree",
      },
      onConfirmArchive: vi.fn(),
      onConfirmArchiveHerdMembers: vi.fn(),
      onCancelArchive: vi.fn(),
    });

    expect(screen.getByText(/delete this leader's worktree/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader Only" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Leader + Herd" })).toBeInTheDocument();
  });
});

describe("SessionItem archived worktree cleanup status", () => {
  it("shows pending cleanup tooltip for archived worktrees", () => {
    // Protects the new async archive UX: users need a clear explanation that
    // archive succeeded but background worktree deletion is still running.
    renderSessionItem({
      session: makeSession({ archived: true, isWorktree: true, worktreeCleanupStatus: "pending" }),
      isArchived: true,
    });

    expect(screen.getByText("wt")).toHaveAttribute("title", "Worktree cleanup is still running");
  });

  it("shows failed cleanup tooltip for archived worktrees", () => {
    // Protects the surfaced failure path so an archive doesn't look half-done
    // with no reason when background worktree cleanup fails.
    renderSessionItem({
      session: makeSession({
        archived: true,
        isWorktree: true,
        worktreeCleanupStatus: "failed",
        worktreeCleanupError: "git worktree remove failed",
      }),
      isArchived: true,
    });

    expect(screen.getByText("wt")).toHaveAttribute("title", "git worktree remove failed");
  });

  it("offers retry for archived worktrees that still exist", () => {
    const onRetryWorktreeCleanup = vi.fn();
    renderSessionItem({
      session: makeSession({
        archived: true,
        isWorktree: true,
        worktreeExists: true,
        worktreeCleanupStatus: "failed",
      }),
      isArchived: true,
      onRetryWorktreeCleanup,
    });

    fireEvent.click(screen.getByTitle("Retry worktree cleanup"));

    expect(onRetryWorktreeCleanup).toHaveBeenCalledWith(expect.any(Object), "s1");
  });
});

describe("SessionItem rename mode", () => {
  it("keeps the rename input outside the clickable row button so spaces do not trigger row activation", () => {
    // Regression guard for q-676: the rename input must not be nested inside the
    // row button, because Space can activate buttons and collapse edit mode.
    const onConfirmRename = vi.fn();
    const onCancelRename = vi.fn();

    render(<EditingSessionItem onConfirmRename={onConfirmRename} onCancelRename={onCancelRename} />);
    const input = screen.getByDisplayValue("Session");

    input.focus();
    fireEvent.change(input, { target: { value: "Session Name" } });
    fireEvent.keyDown(input, { key: " " });

    expect(input.closest("button")).toBeNull();
    expect(screen.getByDisplayValue("Session Name")).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
    expect(onConfirmRename).not.toHaveBeenCalled();
    expect(onCancelRename).not.toHaveBeenCalled();
  });
});

describe("SessionItem search match context", () => {
  it("shows matched field label and highlights matched query text", () => {
    renderSessionItem({
      matchContext: "message: fix beta auth bug",
      matchedField: "user_message",
      matchQuery: "beta",
    });

    expect(screen.getByText("message:")).toBeInTheDocument();
    const highlight = screen.getByText("beta");
    expect(highlight.tagName).toBe("MARK");
    expect(screen.getByText(/fix/i)).toBeInTheDocument();
  });

  it("falls back to session name snippet for name matches without matchContext", () => {
    renderSessionItem({
      sessionName: "Beta Session",
      matchContext: null,
      matchedField: "name",
      matchQuery: "beta",
    });

    expect(screen.getByText("name:")).toBeInTheDocument();
    const highlight = screen.getByText("Beta");
    expect(highlight.tagName).toBe("MARK");
  });

  it("falls back to the numeric session label for exact session-number matches", () => {
    renderSessionItem({
      session: makeSession({ sessionNum: 12 }),
      matchContext: null,
      matchedField: "session_number",
      matchQuery: "#0012",
    });

    const matchLine = screen.getByText("session:").parentElement;
    expect(matchLine).not.toBeNull();
    expect(matchLine).toHaveTextContent("#12");
  });
});

describe("SessionItem herd role badges", () => {
  it("renders a themed leader badge for leader sessions", () => {
    // Leader badges only render in status-bar row variants; herd-group rows
    // already communicate leadership structurally.
    renderSessionItem({
      session: makeSession({ isOrchestrator: true }),
      herdGroupBadgeTheme: SAGE_THEME,
      useStatusBar: true,
    });

    const badge = screen.getByText("leader");
    expect(badge).toHaveAttribute("data-herd-group-tone", "sage");
    expect(badge).toHaveStyle({ color: SAGE_THEME.textColor });
    expect(badge).toHaveStyle({ backgroundColor: SAGE_THEME.leaderBackground });
  });

  it("renders a themed herd badge for worker sessions", () => {
    renderSessionItem({
      session: makeSession({ herdedBy: "leader-1" }),
      herdGroupBadgeTheme: SAGE_THEME,
    });

    const badge = screen.getByText("herd");
    expect(badge).toHaveAttribute("data-herd-group-tone", "sage");
    expect(badge).toHaveStyle({ color: SAGE_THEME.textColor });
    expect(badge).toHaveStyle({ backgroundColor: SAGE_THEME.herdBackground });
  });
});

describe("SessionItem leader profiles", () => {
  it("renders a clickable portrait for leader sessions", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, leaderProfilePortrait: TAKO_PORTRAIT }),
    });

    const portraitButton = screen.getByRole("button", { name: /open tako 1\.1 profile/i });
    const portraitImage = portraitButton.querySelector("img");
    expect(portraitButton).toBeInTheDocument();
    expect(portraitImage).toHaveAttribute("src", TAKO_PORTRAIT.smallUrl);
    expect(portraitImage).toHaveAttribute("width", String(TAKO_PORTRAIT.smallSize));
    expect(portraitImage).toHaveAttribute("height", String(TAKO_PORTRAIT.smallSize));
    expect(portraitImage).toHaveAttribute("loading", "eager");
    expect(portraitImage).toHaveAttribute("decoding", "async");
  });

  it("lays out leader portraits across title and metadata rows while showing active Journey phase counts", () => {
    installLeaderPhaseSummary([{ label: "Implement", count: 1, tone: "phase", color: "#4ade80" }]);
    mockStoreState.sessionBoards.set("s1", [
      {
        questId: "q-1",
        title: "Implement leader chip",
        status: "IMPLEMENTING",
        updatedAt: 1,
        journey: { mode: "active", phaseIds: ["alignment", "implement"], currentPhaseId: "implement" },
      },
    ]);

    renderSessionItem({
      session: makeSession({
        isOrchestrator: true,
        leaderProfilePortrait: TAKO_PORTRAIT,
        sessionNum: 1286,
        isWorktree: true,
        status: "running",
      }),
      sessionPreview: "recent activity stays readable across the whole row",
    });

    const layout = screen.getByTestId("session-leader-portrait-layout");
    expect(layout).toHaveClass("grid", "grid-cols-[1.8rem_minmax(0,1fr)]");

    const portraitButton = screen.getByRole("button", { name: /open tako 1\.1 profile/i });
    expect(portraitButton).toHaveClass("h-[1.8rem]", "w-[1.8rem]", "ring-2", "ring-emerald-500/80");
    expect(portraitButton).toHaveAttribute("data-status", "running");
    expect(screen.queryByTestId("session-status-dot")).not.toBeInTheDocument();

    expect(screen.getByTestId("session-title-row")).toHaveClass("col-start-2", "row-start-1");
    expect(screen.getByTestId("session-metadata-row")).toHaveClass("col-start-2", "row-start-2");
    expect(screen.getByTestId("session-metadata-row")).toHaveTextContent("#1286");
    expect(screen.getByTestId("session-preview-row")).toHaveClass("col-span-2", "row-start-3");
    expect(screen.getByTestId("session-preview-row")).toHaveAttribute("data-leader-active-phase-summary", "true");
    expect(screen.getByTestId("session-preview-row")).toHaveTextContent("1 Implement");
    expect(screen.queryByText("recent activity stays readable")).not.toBeInTheDocument();
  });

  it("uses stronger metadata text on the selected active session row", () => {
    // The selected light sidebar row background is darker than the base app
    // background, so ordinary muted metadata needs a stronger selected-row tone.
    renderSessionItem({
      isActive: true,
      session: makeSession({
        isOrchestrator: true,
        leaderProfilePortrait: TAKO_PORTRAIT,
        sessionNum: 72,
        linesAdded: 18,
        linesRemoved: 3,
      }),
    });

    const metadataRow = screen.getByTestId("session-metadata-row");
    expect(metadataRow).toHaveTextContent("#72");
    expect(metadataRow).toHaveClass("text-cc-fg/80");
    expect(metadataRow).not.toHaveClass("text-cc-muted");
    expect(within(metadataRow).getByText("#72")).toHaveClass("text-current");

    const lineDiff = screen.getByTestId("session-git-line-diff");
    expect(within(lineDiff).getByText("+18")).toHaveClass("text-current");
    expect(within(lineDiff).getByText("+18")).not.toHaveClass("text-green-500");
    expect(within(lineDiff).getByText("-3")).toHaveClass("text-current");
    expect(within(lineDiff).getByText("-3")).not.toHaveClass("text-red-400");
  });

  it("preserves git diff color cues on non-selected session rows", () => {
    renderSessionItem({
      isActive: false,
      session: makeSession({
        isOrchestrator: true,
        leaderProfilePortrait: TAKO_PORTRAIT,
        linesAdded: 18,
        linesRemoved: 3,
      }),
    });

    const lineDiff = screen.getByTestId("session-git-line-diff");
    expect(within(lineDiff).getByText("+18")).toHaveClass("text-green-500");
    expect(within(lineDiff).getByText("-3")).toHaveClass("text-red-400");
  });

  it("does not show stale user-message previews for leader chips with no active phase counts", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, leaderProfilePortrait: TAKO_PORTRAIT }),
      sessionPreview: "stale leader user prompt",
    });

    expect(screen.queryByTestId("session-preview-row")).not.toBeInTheDocument();
    expect(screen.queryByText("stale leader user prompt")).not.toBeInTheDocument();
  });

  it("renders leader phase counts from authoritative sidebar metadata before the board is opened", () => {
    installLeaderPhaseSummary([
      { label: "Code Review", count: 1, tone: "phase", color: "#a78bfa" },
      { label: "Queued", count: 1, tone: "status" },
    ]);
    renderSessionItem({
      session: makeSession({
        isOrchestrator: true,
        leaderProfilePortrait: TAKO_PORTRAIT,
        leaderActivePhaseSummary: [
          { label: "Code Review", count: 1, tone: "phase", color: "#a78bfa" },
          { label: "Queued", count: 1, tone: "status" },
        ],
      }),
      sessionPreview: "stale leader user prompt",
    });

    expect(screen.getByTestId("session-preview-row")).toHaveAttribute("data-leader-active-phase-summary", "true");
    expect(screen.getByTestId("session-preview-row")).toHaveTextContent("1 Code Review, 1 Queued");
    expect(screen.queryByText("stale leader user prompt")).not.toBeInTheDocument();
  });

  it("does not render portraits for non-leader sessions", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: false, leaderProfilePortrait: TAKO_PORTRAIT }),
    });

    expect(screen.queryByRole("button", { name: /open tako 1\.1 profile/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-leader-portrait-layout")).not.toBeInTheDocument();
  });

  it("uses projected preview time instead of human activity time when choosing the latest preview", () => {
    mockStoreState.sessionTaskPreview.set("s1", { text: "Newer task", updatedAt: 150 });
    mockStoreState.sessionPreviewUpdatedAt.set("s1", 300);

    renderSessionItem({
      session: makeSession({
        lastUserMessageAt: 100,
        lastMessagePreviewAt: 200,
      }),
      sessionPreview: "Projected injected preview",
    });

    expect(screen.getByText("Projected injected preview")).toBeInTheDocument();
    expect(screen.queryByText("Newer task")).toBeNull();
  });

  it("does not revive stale local preview timing after the projection clears it", () => {
    mockStoreState.sessionTaskPreview.set("s1", { text: "Current task", updatedAt: 150 });
    mockStoreState.sessionPreviewUpdatedAt.set("s1", 300);

    renderSessionItem({
      session: makeSession({}),
    });

    expect(screen.getByText("Current task")).toBeInTheDocument();
  });

  it("keeps non-leader rows in the compact preview-before-metadata order", () => {
    renderSessionItem({
      session: makeSession({ sessionNum: 42 }),
      sessionPreview: "compact non-leader preview",
    });

    const preview = screen.getByText("compact non-leader preview");
    const backendIcon = screen.getByAltText("Codex");
    expect(backendIcon).toHaveAttribute("src", "/backend-logos/codex.svg");
    expect(preview.compareDocumentPosition(backendIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("session-status-dot")).toBeInTheDocument();
  });

  it("uses the approved Claude backend badge for Claude and Claude SDK sessions", () => {
    const { rerender } = renderSessionItem({
      session: makeSession({ backendType: "claude" }),
    });

    expect(screen.getByAltText("Claude")).toHaveAttribute("src", "/backend-logos/claude.svg");

    rerender(
      <SessionItem
        session={makeSession({ backendType: "claude-sdk" })}
        isActive={false}
        isArchived={false}
        sessionName="Session"
        sessionPreview="preview"
        permCount={0}
        isRecentlyRenamed={false}
        onSelect={vi.fn()}
        onStartRename={vi.fn()}
        onArchive={vi.fn()}
        onUnarchive={vi.fn()}
        onDelete={vi.fn()}
        onClearRecentlyRenamed={vi.fn()}
        editingSessionId={null}
        editingName=""
        setEditingName={vi.fn()}
        onConfirmRename={vi.fn()}
        onCancelRename={vi.fn()}
        editInputRef={{ current: null }}
      />,
    );

    expect(screen.getByAltText("Claude SDK")).toHaveAttribute("src", "/backend-logos/claude.svg");
  });

  it("opens the profile picker from a leader portrait", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, leaderProfilePortrait: TAKO_PORTRAIT }),
    });

    fireEvent.click(screen.getByRole("button", { name: /open tako 1\.1 profile/i }));

    expect(screen.getByRole("dialog", { name: "Leader profile" })).toBeInTheDocument();
    expect(screen.getByTitle(SHMI_PORTRAIT.label)).toBeInTheDocument();
  });

  it("groups picker options by the current portrait pool first", () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, leaderProfilePortrait: SHMI_PORTRAIT }),
    });

    fireEvent.click(screen.getByRole("button", { name: /open shmi/i }));

    const dialog = screen.getByRole("dialog", { name: "Leader profile" });
    const shmiGroup = within(dialog).getByRole("region", { name: "Shmi" });
    const takoGroup = within(dialog).getByRole("region", { name: "Tako" });
    expect(shmiGroup.compareDocumentPosition(takoGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(shmiGroup).getByTitle(SHMI_PORTRAIT.label)).toBeInTheDocument();
    expect(within(takoGroup).getByTitle(TAKO_PORTRAIT.label)).toBeInTheDocument();
  });

  it("changes the leader portrait through the picker", async () => {
    renderSessionItem({
      session: makeSession({ isOrchestrator: true, leaderProfilePortrait: TAKO_PORTRAIT }),
    });

    fireEvent.click(screen.getByRole("button", { name: /open tako 1\.1 profile/i }));
    fireEvent.click(screen.getByTitle(SHMI_PORTRAIT.label));

    await waitFor(() => {
      expect(mockStoreState.updateSdkSession).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ leaderProfilePortraitId: SHMI_PORTRAIT.id }),
      );
    });
  });

  it("keeps all 96 portrait options selectable from a constrained viewport", async () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    window.innerWidth = 430;
    window.innerHeight = 640;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 36,
      y: 600,
      width: 20,
      height: 20,
      top: 600,
      right: 56,
      bottom: 620,
      left: 36,
      toJSON: () => ({}),
    });

    try {
      renderSessionItem({
        session: makeSession({ isOrchestrator: true, leaderProfilePortrait: TAKO_PORTRAIT }),
      });

      fireEvent.click(screen.getByRole("button", { name: /open tako 1\.1 profile/i }));

      const dialog = screen.getByRole("dialog", { name: "Leader profile" });
      expect(dialog).toHaveStyle({ top: "108px", width: "300px", maxHeight: "520px" });
      expect(screen.getByTestId("leader-profile-portrait-grid-scroll")).toHaveClass("min-h-0", "overflow-y-auto");
      expect(LEADER_PROFILE_PORTRAITS).toHaveLength(96);

      const lastPortrait = LEADER_PROFILE_PORTRAITS[LEADER_PROFILE_PORTRAITS.length - 1];
      fireEvent.click(screen.getByRole("button", { name: lastPortrait.label }));

      await waitFor(() => {
        expect(mockStoreState.updateSdkSession).toHaveBeenCalledWith(
          "s1",
          expect.objectContaining({ leaderProfilePortraitId: lastPortrait.id }),
        );
      });
    } finally {
      rectSpy.mockRestore();
      window.innerWidth = originalInnerWidth;
      window.innerHeight = originalInnerHeight;
    }
  });
});

describe("SessionItem status dot", () => {
  beforeEach(() => {
    mockStoreState.sessionTimers.clear();
    mockStoreState.currentSessionId = "s1";
  });

  it("shows a breathing green dot while running", () => {
    renderSessionItem({
      session: makeSession({
        status: "running",
        sdkState: "running",
      }),
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "running");
    expect(dot).toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("shows a glowing amber dot when permissions are pending", () => {
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 2,
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "permission");
    expect(dot).toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("shows a gray dot when idle", () => {
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected" }),
      permCount: 0,
    });

    const dot = screen.getByTestId("session-status-dot");
    expect(dot).toHaveAttribute("data-status", "idle");
    expect(dot).not.toHaveStyle({ animation: "yarn-glow-breathe 2s ease-in-out infinite" });
  });

  it("replaces the idle dot with a timer icon when the session is waiting on timers", () => {
    // Idle sessions with scheduled timers should advertise that waiting state
    // in the primary status slot instead of the old hover-hidden side badge.
    const { container } = renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected", pendingTimerCount: 2 }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("data-count", "2");
    expect(timerIcon).toHaveAttribute("title", "2 scheduled timers");
    expect(container.querySelector('[data-testid="session-status-dot"]')).toBeNull();
  });

  it("shows a pause badge with held-input count instead of the timer icon", () => {
    const { container } = renderSessionItem({
      session: makeSession({
        pendingTimerCount: 1,
        pause: {
          pausedAt: 123,
          queuedMessages: [
            {
              id: "p1",
              queuedAt: 124,
              source: "programmatic",
              message: { type: "user_message", content: "held" },
            },
          ],
        },
        pausedInputQueueCount: 1,
      }),
      permCount: 0,
    });

    expect(screen.getByTestId("session-pause-badge")).toHaveTextContent("1");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });

  it("uses the dedicated alignment classes for the timer icon slot", () => {
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected", pendingTimerCount: 1 }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon.className).toContain("h-3");
    expect(timerIcon.className).toContain("w-3");
    expect(timerIcon.className).toContain("leading-none");
    expect(timerIcon.firstElementChild).toHaveClass("-translate-y-px");
  });

  it("shows the timer icon in status-bar sidebar rows too", () => {
    // Status-bar rows use the left status stripe instead of the dot, so the
    // timer state still needs an inline icon to stay visible there.
    renderSessionItem({
      session: makeSession({ status: "idle", sdkState: "connected", pendingTimerCount: 1 }),
      permCount: 0,
      useStatusBar: true,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("title", "1 scheduled timer");
  });

  it("uses the polled session snapshot timer count for non-selected rows", () => {
    // Non-current sidebar rows do not keep a live socket open, so they should
    // still advertise scheduled work from the server-polled session snapshot.
    mockStoreState.currentSessionId = "other-session";

    renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
      permCount: 0,
    });

    const timerIcon = screen.getByTestId("session-status-timer-icon");
    expect(timerIcon).toHaveAttribute("title", "1 scheduled timer");
  });

  it("keeps row timer authority for the current session", () => {
    mockStoreState.currentSessionId = "s1";
    setSessionTimers("s1", ["stale-live"]);

    const { container } = renderSessionItem({
      session: makeSession({ pendingTimerCount: 0 }),
      permCount: 0,
    });

    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });

  it("does not let stale local timer state clear the current row count", () => {
    mockStoreState.currentSessionId = "s1";

    renderSessionItem({
      session: makeSession({ pendingTimerCount: 2 }),
      permCount: 0,
    });

    expect(screen.getByTestId("session-status-timer-icon")).toHaveAttribute("data-count", "2");
    expect(screen.queryByTestId("session-status-dot")).toBeNull();
  });
});

describe("SessionItem git status refresh", () => {
  it("does not render a dedicated manual git refresh button", () => {
    renderSessionItem({
      session: makeSession({
        isWorktree: true,
        gitAhead: 3,
        linesAdded: 42,
        gitStatusRefreshedAt: Date.now() - 10 * 60_000,
      }),
    });

    expect(screen.queryByTestId("session-git-refresh")).toBeNull();
    expect(screen.getByTestId("session-git-divergence")).toHaveAttribute("data-stale", "true");
    expect(screen.getByTestId("session-git-line-diff").getAttribute("title")).toContain("Last refreshed");
  });

  it("surfaces git refresh failures as compact status metadata", () => {
    renderSessionItem({
      session: makeSession({
        isWorktree: true,
        linesAdded: 42,
        gitStatusRefreshedAt: Date.now() - 10 * 60_000,
        gitStatusRefreshError: "Unable to refresh diff stats",
      }),
    });

    const error = screen.getByTestId("session-git-status-error");
    expect(error).toHaveTextContent("!");
    expect(error.getAttribute("title")).toContain("Unable to refresh diff stats");
  });

  it("surfaces intentional diff-stat skips without treating them as refresh failures", () => {
    renderSessionItem({
      session: makeSession({
        isWorktree: true,
        diffStatsSkippedReason: "Diff stats skipped: branch is 83 commits from base",
        gitStatusRefreshedAt: Date.now(),
      }),
    });

    const skipped = screen.getByTestId("session-git-diff-skipped");
    expect(skipped).toHaveTextContent("skip");
    expect(skipped.getAttribute("title")).toContain("Diff stats skipped: branch is 83 commits from base");
    expect(screen.queryByTestId("session-git-status-error")).toBeNull();
  });
});

describe("SessionItem notification marker", () => {
  beforeEach(() => {
    mockStoreState.sessionAttention.clear();
    mockStoreState.sessionNotifications.clear();
    mockStoreState.sessionTimers.clear();
    mockStoreState.sdkSessions = [];
    mockStoreState.currentSessionId = "s1";
  });

  it("shows a blue notification marker when review is the highest active inbox urgency", () => {
    // When there are only active review notifications and no higher-priority
    // badges, the inline session marker should use the blue review color.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "n-review-done", category: "review", summary: "Done review", timestamp: Date.now(), done: true },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-attention-marker");
    expect(marker).toHaveAttribute("data-attention", "review");
  });

  it("gives needs-input precedence over review in the inline notification marker", () => {
    // needs-input should take precedence over review for the second consumer
    // of the shared urgency helper, matching the notification bell behavior.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-attention-marker");
    expect(marker).toHaveAttribute("data-attention", "action");
  });

  it("keeps the notification marker visible when the session row is hovered", () => {
    // The sidebar hover card opens from the whole row, so the status marker must
    // not fade out at the same moment the detail pop-up appears.
    setSessionNotifications("s1", [
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-attention-marker");
    expect(marker).toHaveAttribute("data-attention", "action");
    expect(marker.className).not.toContain("group-hover:opacity-0");
  });

  it("shows muted needs-input as a gray marker when no active notification wins", () => {
    // Muted needs-input remains unresolved, but it should not use the amber active
    // attention state. The row still exposes a quieter discoverability marker.
    setSessionNotifications("s1", [
      {
        id: "n-muted",
        category: "needs-input",
        summary: "Deferred answer",
        timestamp: Date.now(),
        done: false,
        muted: true,
      },
    ]);

    renderSessionItem();
    const marker = screen.getByTestId("session-notification-marker");
    expect(marker).toHaveAttribute("data-urgency", "muted-needs-input");
    expect(marker.className).toContain("bg-cc-muted");
  });

  it("keeps active needs-input amber when active and muted notifications coexist", () => {
    // Active amber is the primary action state even when the same session also
    // contains muted unresolved prompts.
    setSessionNotifications("s1", [
      { id: "n-active", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
      {
        id: "n-muted",
        category: "needs-input",
        summary: "Deferred answer",
        timestamp: Date.now(),
        done: false,
        muted: true,
      },
    ]);

    renderSessionItem();
    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "action");
  });

  it("keeps review blue ahead of muted needs-input", () => {
    // Existing blue review/unread notification semantics should not become gray
    // just because a deferred needs-input prompt also exists.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      {
        id: "n-muted",
        category: "needs-input",
        summary: "Deferred answer",
        timestamp: Date.now(),
        done: false,
        muted: true,
      },
    ]);

    renderSessionItem();
    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
  });

  it("does not consult deprecated leader-tab state when rendering notification urgency", () => {
    // Closing an unread thread tab counts as reading it for the session-set
    // indicator. The underlying review notification remains unresolved, but a
    // closed tab must not keep a hidden blue row marker alive.
    setSessionNotifications("s1", [
      {
        id: "n-review",
        category: "review",
        summary: "q-1 ready for review",
        timestamp: Date.now(),
        done: false,
        threadKey: "q-1",
        questId: "q-1",
      },
      {
        id: "n-muted",
        category: "needs-input",
        summary: "Deferred answer",
        timestamp: Date.now(),
        done: false,
        muted: true,
        threadKey: "q-2",
        questId: "q-2",
      },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        isOrchestrator: true,
        notificationUrgency: "review",
        activeNotificationCount: 1,
        notificationStatusVersion: 7,
        leaderOpenThreadTabs: {
          version: 1,
          orderedOpenThreadKeys: [],
          closedThreadTombstones: [{ threadKey: "q-1", closedAt: Date.now() }],
          updatedAt: Date.now(),
        },
      },
    ];

    renderSessionItem({ session: makeSession({ isOrchestrator: true }) });

    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
  });

  it("keeps the blue marker when a leader review notification belongs to an open thread tab", () => {
    setSessionNotifications("s1", [
      {
        id: "n-review",
        category: "review",
        summary: "q-1 ready for review",
        timestamp: Date.now(),
        done: false,
        threadKey: "q-1",
        questId: "q-1",
      },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        isOrchestrator: true,
        notificationUrgency: "review",
        activeNotificationCount: 1,
        notificationStatusVersion: 8,
        leaderOpenThreadTabs: {
          version: 1,
          orderedOpenThreadKeys: ["q-1"],
          closedThreadTombstones: [],
          updatedAt: Date.now(),
        },
      },
    ];

    renderSessionItem({
      session: makeSession({ isOrchestrator: true, notificationUrgency: "review", activeNotificationCount: 1 }),
    });

    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
  });

  it("keeps the blue marker for a selected leader session with a fresh active review summary", () => {
    // The selected session row should not briefly hide a backend-authored
    // thread-scoped unread summary just because the user opened the leader
    // session shell. Otherwise switching away makes the same unread reappear.
    setSessionNotifications("s1", [
      {
        id: "n-review",
        category: "review",
        summary: "q-1 ready for review",
        timestamp: Date.now(),
        done: false,
        threadKey: "q-1",
        questId: "q-1",
      },
    ]);
    mockStoreState.currentSessionId = "s1";
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        isOrchestrator: true,
        notificationUrgency: "review",
        activeNotificationCount: 1,
        activeReviewNotificationCount: 1,
        notificationStatusVersion: 9,
        notificationStatusUpdatedAt: 9000,
        leaderOpenThreadTabs: {
          version: 1,
          orderedOpenThreadKeys: ["q-1"],
          closedThreadTombstones: [],
          updatedAt: 9000,
        },
      },
    ];

    renderSessionItem({
      session: makeSession({ isOrchestrator: true, notificationUrgency: "review", activeNotificationCount: 1 }),
    });

    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
  });

  it("does not fall back to a stale snapshot marker after the live inbox is known cleared", () => {
    // A loaded empty inbox is authoritative for the session row. Falling back to
    // an older /api/sessions amber marker would resurrect a resolved needs-input dot.
    setSessionNotifications("s1", []);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
      },
    ];

    const { container } = renderSessionItem({
      session: makeSession({ notificationUrgency: "needs-input", activeNotificationCount: 1 }),
    });

    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("ignores stale active full-inbox data when a newer clear summary is known", () => {
    // A browser can have an old full notification inbox from a previous visit
    // while global fanout has already delivered a newer lightweight clear.
    // The sidebar marker must follow the newer clear summary.
    setSessionNotifications("s1", [
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      },
    ];
    setSessionAttentionProjection("s1", { attentionReason: null, status: null });

    const { container } = renderSessionItem();

    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("uses a newer active summary over stale review-only full-inbox data", () => {
    // The notification chip and session row can hold an older full inbox while
    // global fanout has already delivered the latest lightweight needs-input
    // status. The row must keep showing amber, not fall back to blue review.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Review", timestamp: Date.now(), done: false },
    ]);
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 6,
        notificationStatusUpdatedAt: 6000,
      },
    ];
    setSessionAttentionProjection("s1", {
      attentionReason: "action",
      status: { urgency: "needs-input", count: 1 },
    });

    renderSessionItem();

    const marker = screen.getByTestId("session-attention-marker");
    expect(marker).toHaveAttribute("data-attention", "action");
  });

  it("renders the projected clear instead of stale summary attention", () => {
    setSessionAttentionProjection("s1", { attentionReason: null, status: null });
    const { container } = renderSessionItem({
      session: makeSession({
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
      }),
    });

    expect(container.querySelector(".bg-amber-400")).toBeNull();
  });

  it("keeps rendering action attention when notification status is still active", () => {
    // The render guard is only for stale cleared summaries; current needs-input
    // action attention should still produce the visible amber badge.
    const { container } = renderSessionItem({
      attention: "action",
      session: makeSession({
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 5,
      }),
    });

    expect(container.querySelector(".bg-amber-400")).not.toBeNull();
  });

  it("suppresses the inbox marker when a higher-priority attention badge is already active", () => {
    // The session-level attention badge should continue to win over the inbox
    // marker so the shared urgency helper does not bypass existing precedence.
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    setSessionAttentionProjection("s1", {
      attentionReason: "action",
      status: { urgency: "needs-input", count: 1 },
    });

    const { container } = renderSessionItem();
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("uses the status icon instead of a side badge when timers exist", () => {
    // A timed but otherwise idle session should use the primary status slot
    // rather than a hover-hidden side badge.
    const { container } = renderSessionItem({ session: makeSession({ pendingTimerCount: 2 }) });

    const icon = screen.getByTestId("session-status-timer-icon");
    expect(icon).toHaveAttribute("data-count", "2");
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("suppresses the timer icon when a stronger permission badge is active", () => {
    // Pending permissions should continue to own the badge lane because they
    // require immediate user attention.
    const { container } = renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
      permCount: 1,
    });
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });

  it("shows the timer icon after the projection explicitly clears attention", () => {
    setSessionNotifications("s1", [
      { id: "n-review", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    setSessionAttentionProjection("s1", { attentionReason: null, status: null });
    const { container } = renderSessionItem({ session: makeSession({ pendingTimerCount: 1 }) });
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("preserves needs-input precedence when timers are also present", () => {
    // Urgent needs-input inbox markers must still win over the timer badge so
    // sessions that require a human response remain immediately visible.
    setSessionNotifications("s1", [
      { id: "n-input", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    const { container } = renderSessionItem({ session: makeSession({ pendingTimerCount: 1 }) });
    const marker = screen.getByTestId("session-attention-marker");
    expect(marker).toHaveAttribute("data-attention", "action");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
  });

  it("uses a projected review as the sole search-row marker authority ahead of a timer", () => {
    mockStoreState.currentSessionId = "other-session";
    setSessionAttentionProjection("s1", {
      attentionReason: "review",
      status: { urgency: "review", count: 2 },
    });
    mockStoreState.sessionNotifications.set("s1", [
      { id: "legacy-input", category: "needs-input", summary: "Stale", timestamp: 1, done: false },
    ]);

    const { container } = renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
      useStatusBar: true,
      matchContext: "message: projected result",
      matchedField: "user_message",
      matchQuery: "projected",
    });

    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "review");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-notification-marker"]')).toBeNull();
  });

  it("uses projected needs-input and ignores conflicting legacy review state", () => {
    setSessionAttentionProjection("s1", {
      attentionReason: "action",
      status: { urgency: "needs-input", count: 1 },
    });
    mockStoreState.sessionNotifications.set("s1", [
      { id: "legacy-review", category: "review", summary: "Stale", timestamp: 1, done: false },
    ]);

    renderSessionItem();

    expect(screen.getByTestId("session-attention-marker")).toHaveAttribute("data-attention", "action");
    expect(screen.queryByTestId("session-notification-marker")).toBeNull();
  });

  it("uses projected muted-only status ahead of a timer without reviving legacy attention", () => {
    setSessionAttentionProjection("s1", {
      attentionReason: null,
      status: { urgency: "muted-needs-input", count: 3 },
    });

    const { container } = renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
    });

    expect(screen.getByTestId("session-notification-marker")).toHaveAttribute("data-urgency", "muted-needs-input");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
    expect(screen.queryByTestId("session-attention-marker")).toBeNull();
  });

  it("lets a projected clear reveal the ordinary timer and suppress stale legacy markers", () => {
    setSessionAttentionProjection("s1", { attentionReason: null, status: null });
    mockStoreState.sessionNotifications.set("s1", [
      { id: "legacy-input", category: "needs-input", summary: "Stale", timestamp: 1, done: false },
    ]);

    renderSessionItem({
      session: makeSession({ pendingTimerCount: 1 }),
    });

    expect(screen.getByTestId("session-status-timer-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("session-attention-marker")).toBeNull();
    expect(screen.queryByTestId("session-notification-marker")).toBeNull();
  });

  it("keeps permission precedence over projected attention", () => {
    setSessionAttentionProjection("s1", {
      attentionReason: "action",
      status: { urgency: "needs-input", count: 2 },
    });

    renderSessionItem({ permCount: 2 });

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "permission");
    expect(screen.queryByTestId("session-attention-marker")).toBeNull();
    expect(screen.queryByTestId("session-notification-marker")).toBeNull();
  });

  it("preserves projected error as unread without inventing notification urgency", () => {
    setSessionAttentionProjection("s1", { attentionReason: "error", status: null });

    const { container } = renderSessionItem({ session: makeSession({ pendingTimerCount: 1 }) });

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "completed_unread");
    expect(container.querySelector('[data-testid="session-status-timer-icon"]')).toBeNull();
    expect(screen.queryByTestId("session-attention-marker")).toBeNull();
    expect(screen.queryByTestId("session-notification-marker")).toBeNull();
  });
});

describe("SessionItem reviewer badge", () => {
  // Tests for the inline reviewer badge that appears on the parent session's
  // metadata row (Row 3) when an active reviewer session exists. The badge
  // replaces the old indented reviewer row with a compact clickable indicator.

  beforeEach(() => {
    mockNavigateToSession.mockReset();
  });

  it("renders a review badge when reviewerSession is provided", () => {
    // The parent session (sessionNum: 8) should show a compact reviewer
    // navigation badge with a stable visible role label while the session
    // number stays available through the accessible label and tooltip.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("reviewer");
    expect(badge).toHaveAccessibleName("Reviewer #42, click to open");
    expect(badge).toHaveClass("max-w-[3.75rem]", "gap-px", "overflow-hidden", "px-1");
    expect(badge.querySelector("svg")).toHaveClass("w-2", "h-2");
  });

  it("does not render a review badge when reviewerSession is undefined", () => {
    // Sessions without an active reviewer should not display any badge.
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
    });

    expect(screen.queryByTestId("session-reviewer-badge")).not.toBeInTheDocument();
  });

  it("navigates to the reviewer session on badge click without selecting the parent", () => {
    // Clicking the badge should open the reviewer session directly via
    // navigateToSession, not trigger the parent row's onSelect handler.
    // stopPropagation prevents the click from bubbling to the parent button.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const { onSelect } = renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    fireEvent.click(screen.getByTestId("session-reviewer-badge"));

    expect(mockNavigateToSession).toHaveBeenCalledWith("reviewer-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("navigates to the reviewer session from the keyboard without selecting the parent", () => {
    // The compact badge is keyboard-operable because it replaces a standalone
    // reviewer row as the user's path into the reviewer session.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const { onSelect } = renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    fireEvent.keyDown(badge, { key: "Enter" });
    fireEvent.keyDown(badge, { key: " " });

    expect(mockNavigateToSession).toHaveBeenCalledTimes(2);
    expect(mockNavigateToSession).toHaveBeenNthCalledWith(1, "reviewer-1");
    expect(mockNavigateToSession).toHaveBeenNthCalledWith(2, "reviewer-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the reviewer session as the hover preview target when the badge is hovered", () => {
    // Hovering the inline reviewer badge should override the parent row hover
    // target so the shared sidebar popover previews the reviewer session.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverStart = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverStart,
    });

    fireEvent.mouseEnter(screen.getByTestId("session-reviewer-badge"));

    expect(onHoverStart).toHaveBeenCalled();
    expect(onHoverStart.mock.calls.at(-1)?.[0]).toBe("reviewer-1");
    expect(onHoverStart.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ top: 0, left: 0 }));
  });

  it("restores the parent hover preview when leaving the reviewer badge back into the row", () => {
    // Moving off the badge but staying inside the row should put the hover
    // card back on the parent session instead of clearing the preview.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverStart = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverStart,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    const button = screen.getByText("Session").closest("button")!;
    fireEvent.mouseLeave(badge, { relatedTarget: button });

    expect(onHoverStart).toHaveBeenCalled();
    expect(onHoverStart.mock.calls.at(-1)?.[0]).toBe("s1");
  });

  it("ends hover preview when leaving the reviewer badge away from the row", () => {
    // Exiting the badge toward the popover/outside world should use the
    // existing delayed hover-end path instead of snapping back to the parent.
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    const onHoverEnd = vi.fn();
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
      onHoverEnd,
    });

    fireEvent.mouseLeave(screen.getByTestId("session-reviewer-badge"), {
      relatedTarget: document.body,
    });

    expect(onHoverEnd).toHaveBeenCalledTimes(1);
  });

  it("shows reviewer session number in the title tooltip", () => {
    // When the reviewer has a sessionNum, the tooltip should include it
    // (e.g., "Reviewer #42, click to open").
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 42, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("title", "Reviewer #42, click to open");
  });

  it("omits session number from title when reviewer has no sessionNum", () => {
    // When the reviewer session has no sessionNum (e.g., null), the tooltip
    // should gracefully omit it rather than showing "undefined" or "#null".
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: undefined, reviewerOf: 8 });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("title", "Reviewer, click to open");
    expect(badge).toHaveTextContent("reviewer");
  });

  it("shows running status glow when reviewer is actively working", () => {
    // A running reviewer should have a green-themed badge with breathing glow
    // animation so the user can see at a glance that the review is in progress.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "running",
      sdkState: "running",
      isConnected: true,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "running");
    expect(badge).toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows permission status glow when reviewer needs approval", () => {
    // A reviewer waiting for tool permission should have an amber-themed badge
    // with breathing glow, mirroring how the main status stripe signals permission.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      permCount: 2,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "permission");
    expect(badge).toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows no glow animation when reviewer is idle", () => {
    // An idle reviewer should display as a plain muted badge with no glow,
    // so it doesn't draw attention when nothing is happening.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "idle");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("uses the projection-owned reviewer attention index", () => {
    const reviewer = makeSession({ id: "reviewer-1", reviewerOf: 8, status: "idle" });
    setSessionAttentionProjection("reviewer-1", {
      attentionReason: "review",
      status: { urgency: "review", count: 4 },
    });

    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    expect(screen.getByTestId("session-reviewer-badge")).toHaveAttribute("data-reviewer-status", "completed_unread");
  });

  it("shows no glow animation when reviewer is disconnected", () => {
    // A disconnected reviewer (CLI process dropped) should fall back to the
    // gray/muted theme with no glow, same as idle -- no user action needed.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      status: "idle",
      sdkState: "connected",
      isConnected: false,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "disconnected");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });

  it("shows archived status when reviewer session is archived", () => {
    // An archived reviewer should show the archived visual status (gray, no glow).
    // This verifies that the `archived` field is correctly passed to deriveSessionStatus.
    const reviewer = makeSession({
      id: "reviewer-1",
      reviewerOf: 8,
      archived: true,
      status: "idle",
      sdkState: "connected",
      isConnected: true,
      permCount: 0,
    });
    renderSessionItem({
      session: makeSession({ sessionNum: 8 }),
      reviewerSession: reviewer,
    });

    const badge = screen.getByTestId("session-reviewer-badge");
    expect(badge).toHaveAttribute("data-reviewer-status", "archived");
    expect(badge).not.toHaveStyle({ animation: "reviewer-badge-glow 2s ease-in-out infinite" });
  });
});

describe("SessionItem quest title label", () => {
  // Quest-named sessions display a checkbox prefix to indicate status:
  // ☐ for in-progress, ☑ for done.
  // Non-quest sessions show the plain name with no prefix.

  afterEach(() => {
    // Reset quest state after each test
    mockStoreState.questNamedSessions.clear();
    mockStoreState.sessions.clear();
  });

  it("shows ☐ prefix for in-progress quest sessions", () => {
    renderSessionItem({
      sessionName: "Fix auth bug",
      session: makeSession({ claimedQuestStatus: "in_progress" }),
    });

    expect(screen.getByText("☐ Fix auth bug")).toBeInTheDocument();
  });

  it("shows ☑ prefix for done quest sessions under review", () => {
    renderSessionItem({
      sessionName: "Fix auth bug",
      session: makeSession({ claimedQuestStatus: "done", claimedQuestVerificationInboxUnread: true }),
    });

    expect(screen.getByText("☑ Fix auth bug")).toBeInTheDocument();
  });

  it("can derive the checked prefix from sidebar session data when bridge quest state is missing", () => {
    renderSessionItem({
      sessionName: "Fix auth bug",
      session: makeSession({ claimedQuestStatus: "done", claimedQuestVerificationInboxUnread: true }),
    });

    expect(screen.getByText("☑ Fix auth bug")).toBeInTheDocument();
  });

  it("does not resurrect cleared projected quest metadata from stale bridge state", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", {
      claimedQuestStatus: "done",
      claimedQuestVerificationInboxUnread: true,
    });

    renderSessionItem({
      session: makeSession({}),
      sessionName: "Projected plain session",
    });

    expect(screen.getByText("Projected plain session")).toBeInTheDocument();
    expect(screen.queryByText("☑ Projected plain session")).toBeNull();
  });

  it("does not derive a quest checkbox prefix for orchestrator rows", () => {
    renderSessionItem({
      sessionName: "Leader 7",
      session: makeSession({ isOrchestrator: true, claimedQuestStatus: "done" }),
    });

    const span = screen.getByText("Leader 7");
    expect(span.textContent).toBe("Leader 7");
    expect(screen.queryByText("☑ Leader 7")).not.toBeInTheDocument();
    expect(screen.queryByText("☐ Leader 7")).not.toBeInTheDocument();
  });

  it("shows plain name for non-quest sessions", () => {
    renderSessionItem({ sessionName: "Regular session" });

    const span = screen.getByText("Regular session");
    expect(span.textContent).toBe("Regular session");
  });

  it("does not infer quest ownership from stale local state when row status is undefined", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "in_progress" });

    renderSessionItem({ sessionName: "Mystery quest" });

    expect(screen.getByText("Mystery quest")).toBeInTheDocument();
    expect(screen.queryByText("☐ Mystery quest")).toBeNull();
  });

  it("does not retain a quest prefix after authoritative review metadata is cleared", () => {
    mockStoreState.questNamedSessions.add("s1");
    mockStoreState.sessions.set("s1", { claimedQuestStatus: "done", claimedQuestVerificationInboxUnread: true });

    renderSessionItem({
      sessionName: "Completed quest",
      session: makeSession({ claimedQuestStatus: "done" }),
    });

    expect(screen.getByText("Completed quest")).toBeInTheDocument();
    expect(screen.queryByText("☐ Completed quest")).toBeNull();
  });

  it("preserves reviewer navigation while hiding stale skip chips when board quest context is available", () => {
    mockStoreState.quests = [
      {
        questId: "q-1450",
        title: "Worker banner handoff",
        status: "in_progress",
        sessionId: "earlier-owner",
        createdAt: 1,
      },
    ];
    mockStoreState.sessionBoards.set("leader-1", [
      { questId: "q-1450", title: "Worker banner handoff", worker: "s1", workerNum: 1946, updatedAt: 2 },
    ]);
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 1947, isConnected: true, permCount: 0 });

    renderSessionItem({
      session: makeSession({
        sessionNum: 1946,
        isWorktree: true,
        diffStatsSkippedReason: "Diff stats skipped",
      }),
      reviewerSession: reviewer,
    });

    expect(screen.getByTestId("session-reviewer-badge")).toHaveTextContent("reviewer");
    expect(screen.getByTestId("session-reviewer-badge")).toHaveAccessibleName("Reviewer #1947, click to open");
    expect(screen.queryByTestId("session-git-diff-skipped")).not.toBeInTheDocument();
    expect(screen.getByText("wt")).toBeInTheDocument();
  });

  it("preserves reviewer and skip chips when no quest context applies", () => {
    const reviewer = makeSession({ id: "reviewer-1", sessionNum: 1947, isConnected: true, permCount: 0 });

    renderSessionItem({
      session: makeSession({
        sessionNum: 1946,
        isWorktree: true,
        diffStatsSkippedReason: "Diff stats skipped",
      }),
      reviewerSession: reviewer,
    });

    expect(screen.getByTestId("session-reviewer-badge")).toBeInTheDocument();
    expect(screen.getByTestId("session-git-diff-skipped")).toHaveTextContent("skip");
  });
});

describe("SessionItem isDraggable cursor styling", () => {
  // When isDraggable is true (default), the session button shows a grab cursor
  // on desktop (sm breakpoint) so users know they can drag to reorder.
  it("shows grab cursor classes when isDraggable is true (default)", () => {
    renderSessionItem();
    const button = screen.getByText("Session").closest("button")!;
    expect(button.className).toContain("sm:cursor-grab");
    expect(button.className).toContain("sm:active:cursor-grabbing");
  });

  // When isDraggable is false (activity sort mode), the grab cursor is removed
  // to signal that reordering is server-controlled and not user-draggable.
  it("hides grab cursor classes when isDraggable is false", () => {
    renderSessionItem({ isDraggable: false });
    const button = screen.getByText("Session").closest("button")!;
    expect(button.className).not.toContain("sm:cursor-grab");
    expect(button.className).not.toContain("sm:active:cursor-grabbing");
    expect(button.className).toContain("cursor-pointer");
  });
});
