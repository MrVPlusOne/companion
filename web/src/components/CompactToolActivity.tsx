import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "../store.js";
import { parseTakodeBoardCommand } from "../utils/takode-tool-command.js";
import { parseFileReadCommand } from "../utils/terminal-command-preview.js";
import { isPureTakodeSendCommand } from "../utils/takode-send-command.js";
import { getToolIcon, getToolLabel, ToolIcon } from "./ToolBlock.js";
import { summarizeWorkerEventActivity } from "../utils/herd-event-classification.js";

export interface CompactToolActivityItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
  messageId?: string;
  kind?: "tool" | "worker_event";
}

// Keep the fallback independent of viewport measurement so desktop/mobile and
// live/replayed renders make the same decision from the activity model alone.
const MAX_DESCRIPTIVE_TOOL_CALLS = 6;
const MAX_DESCRIPTIVE_TOOL_CATEGORIES = 3;
const MAX_DESCRIPTIVE_SUMMARY_LENGTH = 56;

/** Return whether a tool can be safely hidden behind a passive activity summary. */
export function isCompactToolActivityItem(item: CompactToolActivityItem): boolean {
  const normalizedName = item.name.toLowerCase();
  if (
    (normalizedName === "bash" && parseTakodeBoardCommand(item.input.command)?.subcommand === "propose") ||
    normalizedName === "askuserquestion" ||
    normalizedName === "exitplanmode" ||
    normalizedName === "task" ||
    normalizedName === "agent" ||
    normalizedName.includes("request_user_input")
  ) {
    return false;
  }

  return true;
}

interface ActivityCategory {
  key: string;
  items: CompactToolActivityItem[];
}

function getActivityCategory(item: CompactToolActivityItem): string {
  if (item.kind === "worker_event") return "worker-event";
  const name = item.name.toLowerCase();
  if (name === "bash") {
    if (isPureTakodeSendCommand(item.input.command)) return "worker-send";
    return parseFileReadCommand(String(item.input.command ?? "")) ? "read" : "command";
  }
  if (name === "read" || name.includes("read_file")) return "read";
  if (name === "write" || name === "edit" || name === "notebookedit" || name.includes("apply_patch")) {
    return "edit";
  }
  if (name === "glob" || name === "grep" || name.includes("search_files") || name.includes("search_content")) {
    return "search";
  }
  if (name === "websearch" || name === "web_search") return "web-search";
  if (name === "webfetch" || name.includes("fetch")) return "fetch";
  if (name === "view_image" || name.includes("view_image")) return "image";
  if (name === "todowrite" || name === "taskcreate" || name === "taskupdate") return "tasks";
  return `tool:${item.name}`;
}

function groupActivity(items: CompactToolActivityItem[]): ActivityCategory[] {
  const categories = new Map<string, ActivityCategory>();
  for (const item of items) {
    const key = getActivityCategory(item);
    const category = categories.get(key);
    if (category) {
      category.items.push(item);
    } else {
      categories.set(key, { key, items: [item] });
    }
  }
  return [...categories.values()];
}

function uniqueActivityItems(items: CompactToolActivityItem[]): CompactToolActivityItem[] {
  const seenIds = new Set<string>();
  return items.filter((item) => {
    if (!item.id) return true;
    const identity = `${item.kind ?? "tool"}:${item.id}`;
    if (seenIds.has(identity)) return false;
    seenIds.add(identity);
    return true;
  });
}

function conciseValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function describeCategory(category: ActivityCategory): string {
  const count = category.items.length;
  const first = category.items[0];
  if (category.key === "worker-event") return summarizeWorkerEventActivity(count);
  if (category.key === "worker-send") return count === 1 ? "Sent a message" : `Sent ${count} messages`;
  if (category.key === "read") return count === 1 ? "Read file" : "Read files";
  if (category.key === "command") return count === 1 ? "Ran command" : `Ran ${count} commands`;
  if (category.key === "edit") return count === 1 ? "Edited file" : "Edited files";
  if (category.key === "image") return count === 1 ? "Viewed image" : "Viewed images";
  if (category.key === "tasks") return "Updated tasks";
  if (category.key === "fetch") return count === 1 ? "Fetched page" : "Fetched pages";
  if (category.key === "search") {
    const subject = count === 1 ? conciseValue(first.input.pattern ?? first.input.query) : null;
    return subject ? `Searched for ${subject}` : "Searched code";
  }
  if (category.key === "web-search") {
    const subject = count === 1 ? conciseValue(first.input.query) : null;
    return subject ? `Searched web for ${subject}` : "Searched web";
  }
  return `Used ${getToolLabel(first.name)}`;
}

function lowercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toLowerCase()}${value.slice(1)}`;
}

function joinSummaryParts(parts: string[]): string {
  return parts.map((part, index) => (index === 0 ? part : lowercaseFirst(part))).join(", ");
}

function formatToolCallCount(count: number): string {
  return `${count} tool call${count === 1 ? "" : "s"}`;
}

function shouldUseToolCountFallback(
  toolCallCount: number,
  toolCategoryCount: number,
  descriptiveSummary: string,
): boolean {
  return (
    toolCallCount > MAX_DESCRIPTIVE_TOOL_CALLS ||
    toolCategoryCount > MAX_DESCRIPTIVE_TOOL_CATEGORIES ||
    descriptiveSummary.length > MAX_DESCRIPTIVE_SUMMARY_LENGTH
  );
}

/** Build the short, human-readable label shown for a collapsed run of tools. */
export function summarizeToolActivity(items: CompactToolActivityItem[]): string {
  const uniqueItems = uniqueActivityItems(items);
  const categories = groupActivity(uniqueItems);
  const descriptiveSummary = joinSummaryParts(categories.map(describeCategory));
  const ordinaryToolCategories = categories.filter(
    (category) => category.key !== "worker-event" && category.key !== "worker-send",
  );
  const ordinaryToolCallCount = ordinaryToolCategories.reduce((count, category) => count + category.items.length, 0);
  const ordinaryToolCategoryCount = ordinaryToolCategories.length;

  if (!shouldUseToolCountFallback(ordinaryToolCallCount, ordinaryToolCategoryCount, descriptiveSummary)) {
    return descriptiveSummary;
  }

  let includedToolCount = false;
  const countSummaryParts = categories.flatMap((category) => {
    if (category.key === "worker-event" || category.key === "worker-send") return [describeCategory(category)];
    if (includedToolCount) return [];
    includedToolCount = true;
    return [formatToolCallCount(ordinaryToolCallCount)];
  });
  return joinSummaryParts(countSummaryParts);
}

export function CompactToolActivity({
  items,
  sessionId,
  containedMessageIds = [],
  children,
}: {
  items: CompactToolActivityItem[];
  sessionId?: string;
  containedMessageIds?: string[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandTargetId = useStore((state) => (sessionId ? state.expandAllInTurn.get(sessionId) : undefined));
  const uniqueItems = useMemo(() => uniqueActivityItems(items), [items]);
  const summary = useMemo(() => summarizeToolActivity(uniqueItems), [uniqueItems]);
  const iconType = getToolIcon(items[0]?.name ?? "");
  const itemCount = uniqueItems.length;
  const itemKindLabel = uniqueItems.some((item) => item.kind === "worker_event")
    ? `activity item${itemCount === 1 ? "" : "s"}`
    : `tool call${itemCount === 1 ? "" : "s"}`;

  useEffect(() => {
    if (expandTargetId && containedMessageIds.includes(expandTargetId)) setOpen(true);
  }, [containedMessageIds, expandTargetId]);

  if (uniqueItems.length === 0) return null;

  return (
    <div data-testid="compact-tool-activity">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${itemCount} ${itemKindLabel}: ${summary}`}
        title={`${open ? "Hide" : "Show"} ${itemCount} ${itemKindLabel}`}
        className="group flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-cc-muted transition-colors hover:bg-cc-hover/50 hover:text-cc-fg cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`h-3 w-3 shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="opacity-65">
          <ToolIcon type={iconType} />
        </span>
        <span className="truncate">{summary}</span>
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 border-l border-cc-border/70 pl-3" data-activity-details>
          {children}
        </div>
      )}
    </div>
  );
}
