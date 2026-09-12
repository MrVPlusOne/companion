/**
 * Leader quest/thread tab rail presentation and interaction.
 *
 * WorkBoardBar owns projection/model assembly; this module owns the bounded
 * tab strip, overflow menu, drag handling, and hover-detail lifecycle.
 */
import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import { useStore } from "../store.js";
import type { ActiveTurnRoute, QuestmasterTask } from "../types.js";
import { threadStatusKey, type LeaderThreadStatus } from "../../shared/thread-status-marker.js";
import { isCompletedJourneyPresentationStatus } from "./QuestJourneyTimeline.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "../utils/thread-projection.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import { hydrateQuestDetail } from "../utils/quest-detail-hydration.js";
import { NotifyMeIcon } from "./NotifyMe.js";
import { THREAD_MONITORING_PROJECTION, type ThreadMonitoringProjectionValue } from "../../shared/thread-monitoring.js";
import { getSyncedProjectionValue } from "../store-synced-projections.js";

export const DONE_THREAD_TITLE_COLOR = "var(--color-cc-muted)";
const NORMAL_THREAD_TITLE_COLOR = "var(--color-cc-fg)";
export const QUEUED_THREAD_TITLE_COLOR = "var(--color-cc-fg)";

export function reorderThreadTabsAfterDrag(
  threadKeys: ReadonlyArray<string>,
  activeThreadKey: unknown,
  overThreadKey: unknown,
): string[] {
  const keys = threadKeys.map((key) => normalizeThreadKey(key));
  const activeKey = normalizeThreadKey(String(activeThreadKey ?? ""));
  const overKey = normalizeThreadKey(String(overThreadKey ?? ""));
  if (!activeKey || !overKey || activeKey === overKey) return keys;
  const oldIndex = keys.indexOf(activeKey);
  const newIndex = keys.indexOf(overKey);
  if (oldIndex < 0 || newIndex < 0) return keys;
  return arrayMove(keys, oldIndex, newIndex);
}

export function constrainThreadTabTransformToHorizontal(transform: Transform | null): Transform | null {
  if (!transform || transform.y === 0) return transform;
  return { ...transform, y: 0 };
}

const COMPACT_MOBILE_THREAD_TAB_WIDTH = 76;
const COMPACT_DESKTOP_THREAD_TAB_WIDTH = 160;
const COMPACT_DESKTOP_PACKING_MIN_RAIL_WIDTH = 640;
const COMPACT_MORE_TABS_WIDTH = 72;
const COMPACT_TAB_GAP = 4;
const FLUID_THREAD_TAB_SIZE_CLASS = "min-w-[var(--thread-tab-width)] max-w-[14rem] flex-[1_1_var(--thread-tab-width)]";

export interface CompactThreadTabPartition<T> {
  visibleTabs: T[];
  hiddenTabs: T[];
  visibleThreadKeys: string[];
  hiddenThreadKeys: string[];
}

export function buildCompactThreadTabPartition<T extends { threadKey: string }>({
  tabs,
  currentThreadKey,
  railWidth,
}: {
  tabs: ReadonlyArray<T>;
  currentThreadKey: string;
  railWidth: number | null;
}): CompactThreadTabPartition<T> {
  const visibleCapacity = estimateCompactVisibleTabCapacity(tabs.length, railWidth);
  const selectedThreadKey = normalizeThreadKey(currentThreadKey);
  const selectedIndex = tabs.findIndex((tab) => normalizeThreadKey(tab.threadKey) === selectedThreadKey);
  const visibleKeys = new Set(tabs.slice(0, visibleCapacity).map((tab) => normalizeThreadKey(tab.threadKey)));
  if (selectedIndex >= visibleCapacity && visibleCapacity > 0) {
    visibleKeys.delete(normalizeThreadKey(tabs[visibleCapacity - 1]!.threadKey));
    visibleKeys.add(selectedThreadKey);
  }
  const visibleTabs = tabs.filter((tab) => visibleKeys.has(normalizeThreadKey(tab.threadKey)));
  const hiddenTabs = tabs.filter((tab) => !visibleKeys.has(normalizeThreadKey(tab.threadKey)));

  return {
    visibleTabs,
    hiddenTabs,
    visibleThreadKeys: visibleTabs.map((tab) => normalizeThreadKey(tab.threadKey)),
    hiddenThreadKeys: hiddenTabs.map((tab) => normalizeThreadKey(tab.threadKey)),
  };
}

function estimateCompactVisibleTabCapacity(tabCount: number, railWidth: number | null): number {
  if (tabCount <= 0) return 0;
  if (!railWidth || railWidth <= 0) return tabCount;
  const threadTabWidth = compactThreadTabWidthForRail(railWidth);
  const tabAndGap = threadTabWidth + COMPACT_TAB_GAP;
  if (threadTabWidth + tabCount * tabAndGap <= railWidth) return tabCount;
  return Math.max(1, Math.floor((railWidth - threadTabWidth - COMPACT_MORE_TABS_WIDTH - COMPACT_TAB_GAP) / tabAndGap));
}

function compactThreadTabWidthForRail(railWidth?: number | null): number {
  if (!railWidth || railWidth < COMPACT_DESKTOP_PACKING_MIN_RAIL_WIDTH) return COMPACT_MOBILE_THREAD_TAB_WIDTH;
  return COMPACT_DESKTOP_THREAD_TAB_WIDTH;
}

function stringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isSelectedThread(currentThreadKey: string, targetThreadKey: string): boolean {
  return normalizeThreadKey(currentThreadKey) === normalizeThreadKey(targetThreadKey);
}

function isActiveOutputThread(activeTurnRoute: ActiveTurnRoute | null | undefined, targetThreadKey: string): boolean {
  if (!activeTurnRoute?.threadKey) return false;
  return normalizeThreadKey(activeTurnRoute.threadKey) === normalizeThreadKey(targetThreadKey);
}

export function ThreadNavButton({
  label,
  detail,
  selected,
  onClick,
  testId,
  variant = "card",
  secondary = false,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
  variant?: "card" | "compact";
  secondary?: boolean;
}) {
  const compact = variant === "compact";
  const tone = selected
    ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
    : secondary
      ? "border-cc-border/45 bg-transparent text-cc-muted hover:bg-cc-hover/45 hover:text-cc-fg"
      : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg";
  const detailClass = compact
    ? "hidden shrink-0 text-[10px] text-cc-muted/75 sm:inline"
    : "block truncate text-[10px] text-cc-muted/80";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${compact ? "inline-flex gap-1.5 px-2 py-1" : "flex gap-2 px-2.5 py-1.5"} min-w-0 items-center rounded-md border text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 focus-visible:ring-inset ${tone}`}
      data-testid={testId}
      data-variant={variant}
      aria-pressed={selected}
    >
      <span className={compact ? "min-w-0 truncate text-[11px] font-medium" : "min-w-0"}>
        {compact ? label : <span className="block truncate text-[11px] font-medium">{label}</span>}
        {detail && <span className={detailClass}>{detail}</span>}
      </span>
    </button>
  );
}

export interface PrimaryThreadChip {
  threadKey: string;
  questId?: string;
  title: string;
  detail?: string;
  needsInput: boolean;
  mutedNeedsInput: boolean;
  blueNudge: boolean;
  titleColor?: string;
  projectedCurrentState?: boolean;
  canClose: boolean;
  updatedAt: number;
}

export function threadKeyToSelectAfterClosing(threadKey: string, tabs: ReadonlyArray<PrimaryThreadChip>): string {
  const normalized = normalizeThreadKey(threadKey);
  const closingIndex = tabs.findIndex((tab) => normalizeThreadKey(tab.threadKey) === normalized);
  if (closingIndex < 0) return MAIN_THREAD_KEY;
  return normalizeThreadKey(tabs[closingIndex + 1]?.threadKey ?? MAIN_THREAD_KEY);
}

function displayThreadTabTitleColor(
  tab: PrimaryThreadChip,
  hydratedQuest: QuestmasterTask | undefined,
  statuses: Readonly<Record<string, LeaderThreadStatus>> | undefined,
): string | undefined {
  const hydratedTitleColor =
    hydratedQuest && isCompletedJourneyPresentationStatus(hydratedQuest.status) ? DONE_THREAD_TITLE_COLOR : undefined;
  const baseTitleColor = tab.projectedCurrentState ? tab.titleColor : (hydratedTitleColor ?? tab.titleColor);
  return baseTitleColor === DONE_THREAD_TITLE_COLOR && statuses?.[threadStatusKey(tab.threadKey)]?.kind === "waiting"
    ? NORMAL_THREAD_TITLE_COLOR
    : baseTitleColor;
}

function ActiveOutputIndicator() {
  return (
    <span
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="thread-tab-active-output-indicator"
      data-reduced-motion-static="true"
      data-dot-position="stripe-origin"
      data-stripe-origin="top-left"
    >
      <span
        className="absolute inset-x-1 top-0 h-px overflow-hidden rounded-full bg-violet-100/30"
        data-testid="thread-tab-active-output-glint-track"
      >
        <span
          className="thread-tab-output-glint absolute inset-y-0 left-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white to-sky-200 shadow-[0_0_8px_rgba(224,242,254,0.66)]"
          data-testid="thread-tab-active-output-glint"
          data-reduced-motion="animation-disabled"
        />
      </span>
      <span
        className="absolute left-1 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-50/95 shadow-[0_0_9px_rgba(224,242,254,0.78)] ring-1 ring-violet-100/75"
        data-testid="thread-tab-active-output-dot"
      />
    </span>
  );
}

const BELL_PRESENTATION = {
  "needs-input": ["text-cc-attention", "thread-tab-needs-input-bell"],
  review: ["text-cc-info", "thread-tab-blue-notification-bell"],
  muted: ["text-cc-muted", "thread-tab-muted-needs-input-bell"],
} as const;

type ThreadTabAttention = Pick<PrimaryThreadChip, "needsInput" | "blueNudge" | "mutedNeedsInput">;

function ThreadTabAlerts({ attention, activeOutput }: { attention: ThreadTabAttention; activeOutput: boolean }) {
  const kind = attention.needsInput
    ? "needs-input"
    : attention.blueNudge
      ? "review"
      : attention.mutedNeedsInput
        ? "muted"
        : null;
  if (!kind) return null;
  const [tone, testId] = BELL_PRESENTATION[kind];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`relative z-10 h-3 w-3 shrink-0 ${tone}`}
      aria-hidden="true"
      data-testid={testId}
      data-active-output={activeOutput ? "true" : "false"}
    >
      <path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v1.8c0 .7-.24 1.38-.68 1.92L3 10.75h10l-.82-1.03a3.05 3.05 0 0 1-.68-1.92V6A3.5 3.5 0 0 0 8 2.5Z" />
      <path d="M6.75 12.5a1.35 1.35 0 0 0 2.5 0" />
    </svg>
  );
}

function ThreadTabIdentity({
  questId,
  title,
  titleColor,
  activeOutput,
  menu = false,
}: {
  questId?: string;
  title: string;
  titleColor?: string;
  activeOutput: boolean;
  menu?: boolean;
}) {
  const titleNode = (
    <span
      className="min-w-0 truncate"
      style={titleColor ? { color: titleColor } : undefined}
      data-testid={menu ? "thread-tabs-more-row-title" : undefined}
      data-title-color={menu ? (titleColor ?? "") : undefined}
    >
      {title}
    </span>
  );
  if (menu) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {questId && <span className="shrink-0 font-mono-code">{questId}</span>}
        {titleNode}
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 px-1"
      style={titleColor ? { color: titleColor } : undefined}
      data-testid="thread-tab-title"
      data-active-output={activeOutput ? "true" : "false"}
      data-title-color={titleColor ?? ""}
    >
      {questId && <span className="shrink-0 font-mono-code">{questId}</span>}
      {titleNode}
    </span>
  );
}

function ThreadTabCloseButton({
  label,
  selected = false,
  menu = false,
  onClose,
}: {
  label: string;
  selected?: boolean;
  menu?: boolean;
  onClose: () => void;
}) {
  const className = menu
    ? "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
    : `inline-flex w-5 shrink-0 items-center justify-center overflow-hidden border-l border-current/10 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:border-current/10 focus-visible:opacity-100 ${
        selected
          ? "w-5 opacity-100"
          : "opacity-70 sm:pointer-events-none sm:border-transparent sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:border-current/10 sm:group-hover:opacity-100"
      }`;
  return (
    <button
      type="button"
      aria-label={`Close ${label}`}
      className={className}
      data-testid={menu ? "thread-tabs-more-row-close" : "thread-tab-close"}
      data-compact-close={menu ? undefined : "true"}
      data-selected={menu ? undefined : selected ? "true" : "false"}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

interface ThreadTabView {
  monitor?: { pendingResultId: string | null };
  tab: PrimaryThreadChip;
  threadKey: string;
  selected: boolean;
  activeOutput: boolean;
  newTab: boolean;
  hoverQuest?: QuestmasterTask;
  questId?: string;
  titleColor?: string;
}

function cachedQuestForId(questId: string | undefined): QuestmasterTask | undefined {
  if (!questId) return undefined;
  const normalizedQuestId = normalizeThreadKey(questId);
  const state = useStore.getState();
  return (
    state.questDetails?.get(normalizedQuestId) ??
    state.quests.find((quest) => normalizeThreadKey(quest.questId) === normalizedQuestId)
  );
}

function buildThreadTabView(
  tab: PrimaryThreadChip,
  currentThreadKey: string,
  activeTurnRoute: ActiveTurnRoute | null | undefined,
  newTabKeys: ReadonlySet<string> | undefined,
  threadStatuses: Readonly<Record<string, LeaderThreadStatus>> | undefined,
  monitors?: ThreadMonitoringProjectionValue["threads"],
): ThreadTabView {
  const hoverQuest = cachedQuestForId(tab.questId);
  return {
    tab,
    monitor: monitors?.[tab.threadKey],
    threadKey: normalizeThreadKey(tab.threadKey),
    selected: isSelectedThread(currentThreadKey, tab.threadKey),
    activeOutput: isActiveOutputThread(activeTurnRoute, tab.threadKey),
    newTab: newTabKeys?.has(tab.threadKey) ?? false,
    hoverQuest,
    questId: hoverQuest?.questId ?? tab.questId,
    titleColor: displayThreadTabTitleColor(tab, hoverQuest, threadStatuses),
  };
}

function threadTabTone(selected: boolean): string {
  return selected
    ? "relative z-10 -mb-px rounded-b-none border-cc-primary/45 border-b-transparent bg-cc-card text-cc-fg shadow-[0_-1px_0_rgba(174,86,48,0.46),0_0_0_1px_rgba(174,86,48,0.13),0_10px_20px_-16px_rgba(174,86,48,0.55),inset_0_1px_0_rgba(255,255,255,0.18)]"
    : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg";
}

type QuestTabHover = (view: ThreadTabView, anchorRect: DOMRect) => void;

function RailThreadTab({
  view,
  reorderable,
  onSelect,
  onClose,
  onHover,
  onHoverEnd,
}: {
  view: ThreadTabView;
  reorderable: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onHover: QuestTabHover;
  onHoverEnd: () => void;
}) {
  const { tab, threadKey, selected, activeOutput, newTab, hoverQuest, questId, titleColor } = view;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.threadKey,
    disabled: !reorderable,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(constrainThreadTabTransformToHorizontal(transform)),
    transition,
    ...(isDragging ? { opacity: 0.78, zIndex: 30 } : {}),
  };
  const title = hoverQuest
    ? undefined
    : `${questId ? `${questId}: ${tab.title}` : tab.title}${tab.needsInput ? " needs input" : tab.blueNudge ? " has review updates" : ""}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      title={title}
      onMouseEnter={(event) => onHover(view, event.currentTarget.getBoundingClientRect())}
      onMouseLeave={questId ? onHoverEnd : undefined}
      className={`group relative inline-flex ${FLUID_THREAD_TAB_SIZE_CLASS} items-stretch overflow-hidden rounded-t-md border text-[11px] font-medium transition-colors ${newTab ? "thread-tab-pop" : ""} ${reorderable ? "cursor-grab active:cursor-grabbing" : ""} ${threadTabTone(selected)}`}
      data-testid="thread-tab"
      data-thread-key={tab.threadKey}
      data-needs-input={tab.needsInput ? "true" : "false"}
      data-muted-needs-input={tab.mutedNeedsInput ? "true" : "false"}
      data-blue-notification={tab.blueNudge ? "true" : "false"}
      data-active-output={activeOutput ? "true" : "false"}
      data-new-tab={newTab ? "true" : "false"}
      data-min-label={questId ?? tab.threadKey}
      data-closable={tab.canClose ? "true" : "false"}
      data-has-quest-hover={hoverQuest ? "true" : "false"}
      data-thread-tab-width-source="true"
      data-reorderable={reorderable ? "true" : "false"}
    >
      {activeOutput && <ActiveOutputIndicator />}
      <button
        type="button"
        onClick={onSelect}
        className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-t-[inherit] px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 focus-visible:ring-inset"
        data-testid="thread-tab-select"
        {...(reorderable ? attributes : {})}
        {...(reorderable ? listeners : {})}
        aria-pressed={selected}
      >
        <ThreadTabAlerts attention={tab} activeOutput={activeOutput} />
        {view.monitor && <NotifyMeIcon pending={Boolean(view.monitor.pendingResultId)} />}
        <ThreadTabIdentity questId={questId} title={tab.title} titleColor={titleColor} activeOutput={activeOutput} />
      </button>
      {onClose && tab.canClose && (
        <ThreadTabCloseButton label={questId ?? tab.title} selected={selected} onClose={onClose} />
      )}
    </div>
  );
}

function MoreThreadTabRow({
  view,
  reorderable,
  reorderMode,
  draftIndex,
  draftCount,
  onMove,
  onSelect,
  onClose,
  onHover,
  onHoverEnd,
}: {
  view: ThreadTabView;
  reorderable: boolean;
  reorderMode: boolean;
  draftIndex: number;
  draftCount: number;
  onMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  onClose?: () => void;
  onHover: QuestTabHover;
  onHoverEnd: () => void;
}) {
  const { tab, threadKey, selected, activeOutput, questId, titleColor } = view;
  return (
    <div
      className={`group flex min-w-0 items-center gap-2 px-2 py-1.5 text-left text-[11px] transition-colors ${
        selected ? "bg-cc-primary/10 text-cc-fg" : "text-cc-fg hover:bg-cc-hover/50"
      }`}
      data-testid="thread-tabs-more-row"
      data-thread-key={threadKey}
      data-hidden="true"
      data-active-output={activeOutput ? "true" : "false"}
      data-needs-input={tab.needsInput ? "true" : "false"}
      data-muted-needs-input={tab.mutedNeedsInput ? "true" : "false"}
      data-blue-notification={tab.blueNudge ? "true" : "false"}
      data-reorderable={reorderable ? "true" : "false"}
      onMouseEnter={(event) => onHover(view, event.currentTarget.getBoundingClientRect())}
      onMouseLeave={questId ? onHoverEnd : undefined}
    >
      {reorderMode && reorderable && (
        <div className="flex shrink-0 flex-col gap-0.5">
          {([-1, 1] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              aria-label={`Move ${questId ?? threadKey} ${direction < 0 ? "up" : "down"}`}
              disabled={direction < 0 ? draftIndex <= 0 : draftIndex < 0 || draftIndex >= draftCount - 1}
              onClick={() => onMove(direction)}
              className="rounded border border-cc-border/70 px-1 text-[10px] text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg disabled:opacity-35"
            >
              {direction < 0 ? "Up" : "Down"}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={reorderMode}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 disabled:cursor-default"
        data-testid="thread-tabs-more-row-select"
      >
        {activeOutput && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-200 shadow-[0_0_8px_rgba(224,242,254,0.8)]" />
        )}
        <ThreadTabAlerts attention={tab} activeOutput={activeOutput} />
        {view.monitor && <NotifyMeIcon pending={Boolean(view.monitor.pendingResultId)} />}
        <span className="min-w-0 flex-1">
          <ThreadTabIdentity
            questId={questId}
            title={tab.title}
            titleColor={titleColor}
            activeOutput={activeOutput}
            menu
          />
          <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-cc-muted">
            <span>{threadKey}</span>
            {selected && <span className="text-violet-100">Current</span>}
            {tab.detail && <span className="min-w-0 truncate">{tab.detail}</span>}
          </span>
        </span>
      </button>
      {onClose && tab.canClose && !reorderMode && (
        <ThreadTabCloseButton label={questId ?? tab.title} menu onClose={onClose} />
      )}
    </div>
  );
}

function useQuestTabHover() {
  const [hoveredQuest, setHoveredQuest] = useState<{ quest: QuestmasterTask; anchorRect: DOMRect } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ questId: string; anchorRect: DOMRect } | null>(null);

  useEffect(
    () => () => {
      pendingRef.current = null;
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const show: QuestTabHover = (view, anchorRect) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const { hoverQuest, questId, tab } = view;
    setHoveredQuest(hoverQuest?.title === tab.title ? { quest: hoverQuest, anchorRect } : null);
    if (!questId) return;
    const pending = { questId, anchorRect };
    pendingRef.current = pending;
    void hydrateQuestDetail(questId)
      .then((quest) => {
        if (pendingRef.current !== pending || !quest) return;
        pendingRef.current = null;
        setHoveredQuest({ quest, anchorRect });
      })
      .catch(() => {
        if (pendingRef.current === pending) pendingRef.current = null;
      });
  };

  const hideImmediately = () => {
    pendingRef.current = null;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoveredQuest(null);
  };
  const scheduleHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(hideImmediately, 100);
  };
  return {
    hoveredQuest,
    show,
    scheduleHide,
    hideImmediately,
    keepVisible: () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
  };
}

function matchingThreadKeys(tabs: ReadonlyArray<PrimaryThreadChip>, allowed: ReadonlySet<string>): string[] {
  return tabs.map((tab) => normalizeThreadKey(tab.threadKey)).filter((key) => allowed.has(key));
}

export function ThreadTabRail({
  mainState,
  tabs,
  reorderableThreadKeys,
  sessionId,
  currentThreadKey,
  onSelectThread,
  onCloseThreadTab,
  onReorderThreadTabs,
  newTabKeys,
  threadStatuses,
}: {
  mainState?: PrimaryThreadChip;
  tabs: PrimaryThreadChip[];
  reorderableThreadKeys: string[];
  sessionId: string;
  currentThreadKey: string;
  onSelectThread?: (threadKey: string) => void;
  onCloseThreadTab?: (threadKey: string) => void;
  onReorderThreadTabs?: (orderedThreadKeys: string[]) => void;
  newTabKeys?: ReadonlySet<string>;
  threadStatuses?: Readonly<Record<string, LeaderThreadStatus>>;
}) {
  const openThread = (threadKey: string) => {
    const target = normalizeThreadKey(threadKey || MAIN_THREAD_KEY);
    const selected = normalizeThreadKey(currentThreadKey || MAIN_THREAD_KEY);
    if (onSelectThread && (selected === ALL_THREADS_KEY || selected !== target)) onSelectThread(target);
  };
  const sessionStatus = useStore((state) => state.sessionStatus.get(sessionId));
  const monitors = useStore(
    (state) => getSyncedProjectionValue(state, THREAD_MONITORING_PROJECTION, sessionId)?.threads,
  );
  const activeTurnRoute = useStore((state) => state.activeTurnRoutes.get(sessionId));
  const runningRoute = sessionStatus === "running" ? activeTurnRoute : null;
  const hover = useQuestTabHover();
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [railWidth, setRailWidth] = useState<number | null>(null);
  const [moreTabsOpen, setMoreTabsOpen] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [draftReorderKeys, setDraftReorderKeys] = useState<string[]>([]);
  const compactTabs = useMemo(
    () => buildCompactThreadTabPartition({ tabs, currentThreadKey, railWidth }),
    [currentThreadKey, railWidth, tabs],
  );
  const { visibleTabs, hiddenTabs } = compactTabs;
  const hasOverflowTabs = hiddenTabs.length > 0;
  const reorderableKeySet = new Set(reorderableThreadKeys.map(normalizeThreadKey));
  const sortableTabKeys = matchingThreadKeys(visibleTabs, reorderableKeySet);
  const allReorderableTabKeys = matchingThreadKeys(tabs, reorderableKeySet);
  const moreTabsReorderKeys = matchingThreadKeys(hiddenTabs, reorderableKeySet);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useLayoutEffect(() => {
    const element = tabStripRef.current;
    if (!element) return;
    const measure = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      setRailWidth((existing) => (existing === width ? existing : width));
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (hasOverflowTabs) return;
    setMoreTabsOpen(false);
    setReorderMode(false);
  }, [hasOverflowTabs]);

  useEffect(() => {
    if (!moreTabsOpen) return;
    setReorderMode(false);
    setDraftReorderKeys(moreTabsReorderKeys);
  }, [moreTabsOpen, moreTabsReorderKeys.join("\0")]);

  useEffect(() => {
    if (!moreTabsOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreTabsOpen(false);
        setReorderMode(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [moreTabsOpen]);

  const moveDraftReorderKey = (threadKey: string, direction: -1 | 1) =>
    setDraftReorderKeys((keys) => {
      const index = keys.indexOf(threadKey);
      const nextIndex = index + direction;
      return index < 0 || nextIndex < 0 || nextIndex >= keys.length ? keys : arrayMove(keys, index, nextIndex);
    });

  const closeMoreTabs = () => setMoreTabsOpen(false);
  const listedHiddenTabs = !reorderMode
    ? hiddenTabs
    : [
        ...draftReorderKeys
          .map((key) => hiddenTabs.find((tab) => normalizeThreadKey(tab.threadKey) === key))
          .filter((tab): tab is PrimaryThreadChip => !!tab),
        ...hiddenTabs.filter((tab) => !reorderableKeySet.has(normalizeThreadKey(tab.threadKey))),
      ];
  const commitMoreTabsReorder = () => {
    if (!stringArraysEqual(moreTabsReorderKeys, draftReorderKeys)) {
      const pending = [...draftReorderKeys];
      const pendingSet = new Set(pending);
      onReorderThreadTabs?.(allReorderableTabKeys.map((key) => (pendingSet.has(key) ? (pending.shift() ?? key) : key)));
    }
    setReorderMode(false);
    closeMoreTabs();
  };

  const mainSelected = isSelectedThread(currentThreadKey, MAIN_THREAD_KEY);
  const mainAttention = mainState ?? { needsInput: false, mutedNeedsInput: false, blueNudge: false };
  const mainActiveOutput = isActiveOutputThread(runningRoute, MAIN_THREAD_KEY);
  const selectedHidden = hiddenTabs.some((tab) => isSelectedThread(currentThreadKey, tab.threadKey));
  const activeOutputHidden = hiddenTabs.some((tab) => isActiveOutputThread(runningRoute, tab.threadKey));
  const hiddenAttention = {
    needsInput: hiddenTabs.some((tab) => tab.needsInput),
    mutedNeedsInput: hiddenTabs.some((tab) => tab.mutedNeedsInput),
    blueNudge: hiddenTabs.some((tab) => tab.blueNudge),
  };
  const tabStripStyle = {
    "--thread-tab-width": `${compactThreadTabWidthForRail(railWidth)}px`,
  } as CSSProperties;

  return (
    <div
      className="border-b border-cc-border bg-cc-card px-3 pb-0 pt-1.5 sm:px-4"
      data-testid="thread-tab-rail"
      data-open-tab-count={tabs.length + 1}
      data-closed-chip-count="0"
      data-unified-tab-track="true"
      data-overflow={hasOverflowTabs ? "more-tabs-list" : "none"}
      data-hidden-tab-count={hiddenTabs.length}
    >
      <div
        ref={tabStripRef}
        style={tabStripStyle}
        className="mobile-scroll-stable-surface relative flex w-full min-w-0 items-end gap-1 overflow-visible"
        data-testid="thread-tab-strip"
        data-overflow-mode="more-tabs"
        data-close-target-width-frozen="false"
        data-frozen-thread-tab-width=""
        aria-label="Thread tabs"
      >
        <button
          type="button"
          onClick={() => openThread(MAIN_THREAD_KEY)}
          title={`${mainState?.title ?? "Main Thread"}${mainAttention.needsInput ? " needs input" : mainAttention.blueNudge ? " has review updates" : ""}`}
          className={`relative inline-flex ${FLUID_THREAD_TAB_SIZE_CLASS} items-center gap-1.5 overflow-hidden rounded-t-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 focus-visible:ring-inset ${threadTabTone(mainSelected)}`}
          data-testid="thread-main-tab"
          data-thread-key={MAIN_THREAD_KEY}
          data-thread-tab-width-source="true"
          data-needs-input={mainAttention.needsInput ? "true" : "false"}
          data-muted-needs-input={mainAttention.mutedNeedsInput ? "true" : "false"}
          data-blue-notification={mainAttention.blueNudge ? "true" : "false"}
          data-active-output={mainActiveOutput ? "true" : "false"}
          data-min-label="Main Thread"
          aria-pressed={mainSelected}
        >
          {mainActiveOutput && <ActiveOutputIndicator />}
          <ThreadTabAlerts attention={mainAttention} activeOutput={mainActiveOutput} />
          <ThreadTabIdentity title="Main Thread" activeOutput={mainActiveOutput} />
          {mainState?.detail && <span className="shrink-0 text-[10px] text-cc-muted/80">{mainState.detail}</span>}
        </button>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event: DragEndEvent) => {
            if (!onReorderThreadTabs || !event.over) return;
            const ordered = reorderThreadTabsAfterDrag(sortableTabKeys, event.active.id, event.over.id);
            if (!stringArraysEqual(sortableTabKeys, ordered)) onReorderThreadTabs(ordered);
          }}
        >
          <SortableContext items={sortableTabKeys} strategy={horizontalListSortingStrategy}>
            {visibleTabs.map((tab) => {
              const view = buildThreadTabView(
                tab,
                currentThreadKey,
                runningRoute,
                newTabKeys,
                threadStatuses,
                monitors,
              );
              const reorderable = !!onReorderThreadTabs && reorderableKeySet.has(view.threadKey);
              return (
                <RailThreadTab
                  key={view.threadKey}
                  view={view}
                  reorderable={reorderable}
                  onSelect={() => openThread(view.threadKey)}
                  onClose={onCloseThreadTab ? () => onCloseThreadTab(view.threadKey) : undefined}
                  onHover={hover.show}
                  onHoverEnd={hover.scheduleHide}
                />
              );
            })}
          </SortableContext>
        </DndContext>
        {hasOverflowTabs && (
          <div className="relative shrink-0" data-testid="thread-tabs-more-wrapper">
            <button
              type="button"
              onClick={() => setMoreTabsOpen((open) => !open)}
              className={`relative inline-flex h-full min-w-[4.25rem] items-center justify-center gap-1 rounded-t-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 focus-visible:ring-inset ${
                moreTabsOpen || selectedHidden
                  ? "border-cc-primary/45 bg-cc-card text-cc-fg"
                  : activeOutputHidden
                    ? "border-cc-info-border bg-cc-info-bg text-cc-info hover:bg-cc-info-bg/80"
                    : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg"
              }`}
              data-testid="thread-tabs-more-button"
              data-hidden-count={hiddenTabs.length}
              data-has-active-output={activeOutputHidden ? "true" : "false"}
              data-has-needs-input={hiddenAttention.needsInput ? "true" : "false"}
              data-has-muted-needs-input={hiddenAttention.mutedNeedsInput ? "true" : "false"}
              data-has-blue-notification={hiddenAttention.blueNudge ? "true" : "false"}
              aria-haspopup="menu"
              aria-expanded={moreTabsOpen}
              aria-label={`${hiddenTabs.length} hidden tab${hiddenTabs.length === 1 ? "" : "s"}`}
            >
              {activeOutputHidden && (
                <span className="h-1.5 w-1.5 rounded-full bg-cc-info shadow-[0_0_8px_rgba(14,116,144,0.45)] dark:shadow-[0_0_8px_rgba(125,211,252,0.65)]" />
              )}
              <ThreadTabAlerts attention={hiddenAttention} activeOutput={activeOutputHidden} />
              <span>More</span>
              <span className="rounded-sm bg-cc-hover/70 px-1 font-mono-code text-[10px] text-cc-fg">
                {hiddenTabs.length}
              </span>
            </button>
            {moreTabsOpen && (
              <div
                className="absolute right-0 top-full z-50 mt-1 w-[min(22rem,90vw)] overflow-hidden rounded-md border border-cc-border bg-cc-card shadow-xl"
                data-testid="thread-tabs-more-list"
                role="menu"
              >
                <div className="flex items-center justify-between gap-2 border-b border-cc-border px-2 py-1.5">
                  <span className="text-[11px] font-medium text-cc-fg">More tabs</span>
                  {onReorderThreadTabs && moreTabsReorderKeys.length > 1 && (
                    <div className="flex items-center gap-1">
                      {reorderMode ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setDraftReorderKeys(moreTabsReorderKeys);
                              setReorderMode(false);
                            }}
                            className="rounded border border-cc-border/70 px-1.5 py-0.5 text-[10px] text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={commitMoreTabsReorder}
                            className="rounded border border-cc-primary/50 bg-cc-primary/15 px-1.5 py-0.5 text-[10px] text-cc-fg transition-colors hover:bg-cc-primary/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
                          >
                            Done
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDraftReorderKeys(moreTabsReorderKeys);
                            setReorderMode(true);
                          }}
                          className="rounded border border-cc-border/70 px-1.5 py-0.5 text-[10px] text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
                          data-testid="thread-tabs-more-reorder-toggle"
                        >
                          Reorder
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto py-1" data-testid="thread-tabs-more-list-rows">
                  {listedHiddenTabs.map((tab) => {
                    const view = buildThreadTabView(
                      tab,
                      currentThreadKey,
                      runningRoute,
                      newTabKeys,
                      threadStatuses,
                      monitors,
                    );
                    const reorderable = reorderableKeySet.has(view.threadKey);
                    return (
                      <MoreThreadTabRow
                        key={view.threadKey}
                        view={view}
                        reorderable={reorderable}
                        reorderMode={reorderMode}
                        draftIndex={draftReorderKeys.indexOf(view.threadKey)}
                        draftCount={draftReorderKeys.length}
                        onMove={(direction) => moveDraftReorderKey(view.threadKey, direction)}
                        onSelect={() => {
                          openThread(view.threadKey);
                          closeMoreTabs();
                        }}
                        onClose={onCloseThreadTab ? () => onCloseThreadTab(view.threadKey) : undefined}
                        onHover={hover.show}
                        onHoverEnd={hover.scheduleHide}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {hover.hoveredQuest && (
        <QuestHoverCard
          quest={hover.hoveredQuest.quest}
          anchorRect={hover.hoveredQuest.anchorRect}
          onMouseEnter={hover.keepVisible}
          onMouseLeave={hover.hideImmediately}
        />
      )}
    </div>
  );
}
