import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import {
  THREAD_MONITORING_PROJECTION,
  type ThreadMonitoringEntry,
  type ThreadMonitoringPage,
} from "../../shared/thread-monitoring.js";
import { useStore } from "../store.js";
import { getSyncedProjectionValue } from "../store-synced-projections.js";
import { fetchThreadMonitoring, updateThreadMonitoring } from "../api/thread-monitoring.js";
import { navigateToSessionMessageId, navigateToSessionThread, routeSessionRefForId } from "../utils/routing.js";
import { NotifyMeIcon } from "./NotifyMe.js";

export function NotifyMeResults({
  entries,
  busy,
  onOpen,
  onAction,
}: {
  entries: ThreadMonitoringEntry[];
  busy?: boolean;
  onOpen: (entry: ThreadMonitoringEntry) => void;
  onAction: (entry: ThreadMonitoringEntry, action: "acknowledge" | "untrack") => void;
}) {
  return (
    <div className="divide-y divide-cc-border/50">
      {entries.map((entry) => (
        <div key={`${entry.sessionId}:${entry.threadKey}`} className="px-3 py-2.5" data-testid="notify-me-result">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5">
              <NotifyMeIcon pending={Boolean(entry.pending)} className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpen(entry)}
                className="block max-w-full truncate text-left text-xs font-medium text-cc-fg hover:underline cursor-pointer"
              >
                {entry.title}
              </button>
              <p className="truncate text-[10px] text-cc-muted">
                {entry.sessionName}
                {entry.sessionNum ? ` · #${entry.sessionNum}` : ""}
              </p>
              <p className="mt-1 text-xs leading-snug text-cc-text-secondary">
                {entry.pending?.summary || (entry.pending ? "New result ready" : "Waiting for the next result")}
              </p>
              {entry.pending && (
                <time className="text-[10px] text-cc-muted" dateTime={new Date(entry.pending.timestamp).toISOString()}>
                  {new Date(entry.pending.timestamp).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => onOpen(entry)}
                  className="text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  Open
                </button>
                {entry.pending && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAction(entry, "acknowledge")}
                    className="rounded border border-cc-info/30 px-1.5 py-0.5 text-cc-info hover:bg-cc-info/10 cursor-pointer disabled:opacity-50"
                  >
                    Acknowledge
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(entry, "untrack")}
                  className="ml-auto text-cc-muted hover:text-cc-fg cursor-pointer disabled:opacity-50"
                >
                  Stop tracking
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GlobalNotifyMeMenu() {
  const state = useStore(
    useShallow((state) => ({
      sdkSessions: state.sdkSessions,
      syncedProjectionValues: state.syncedProjectionValues,
      syncedProjectionKeys: state.syncedProjectionKeys,
    })),
  );
  const summary = useMemo(() => {
    let pending = 0;
    let tracked = 0;
    const revisions: string[] = [];
    for (const session of state.sdkSessions) {
      if (session.archived) continue;
      const value = getSyncedProjectionValue(state, THREAD_MONITORING_PROJECTION, session.sessionId);
      if (!value) continue;
      pending += value.pendingCount;
      tracked += value.trackedCount;
      revisions.push(`${session.sessionId}:${value.revision}`);
    }
    return { pending, tracked, signature: revisions.join("|") };
  }, [state]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<ThreadMonitoringPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    fetchThreadMonitoring(filter, offset, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (offset >= page.total && offset > 0) {
          setOffset(0);
          return;
        }
        setPage(page);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Please retry");
      });
    return () => controller.abort();
  }, [open, filter, offset, refresh, summary.signature]);

  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node))
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  async function act(entry: ThreadMonitoringEntry, action: "acknowledge" | "untrack") {
    setBusy(true);
    setError(null);
    try {
      await updateThreadMonitoring(entry.sessionId, entry.threadKey, action, entry.pending?.id);
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Please retry");
    } finally {
      setBusy(false);
    }
  }

  function jump(entry: ThreadMonitoringEntry) {
    const routeSessionId = routeSessionRefForId(entry.sessionId, state.sdkSessions);
    if (entry.pending?.messageId)
      navigateToSessionMessageId(entry.sessionId, entry.pending.messageId, {
        routeSessionId,
        threadKey: entry.threadKey,
      });
    else navigateToSessionThread(entry.sessionId, entry.threadKey, false, routeSessionId);
    setOpen(false);
  }

  const top = Math.min((triggerRef.current?.getBoundingClientRect().bottom ?? 40) + 6, window.innerHeight - 180);
  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((open) => !open)}
        aria-expanded={open}
        aria-label={`Notify Me: ${summary.pending} ${summary.pending === 1 ? "task" : "tasks"} with results`}
        title="Notify Me: monitored task results"
        className={`inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] cursor-pointer ${summary.pending ? "border-cc-info/40 bg-cc-info/10 text-cc-info" : "border-cc-border text-cc-muted hover:bg-cc-hover"}`}
      >
        <span>{summary.pending}</span>
        <NotifyMeIcon pending={summary.pending > 0} monitored={summary.tracked > 0} className="h-3.5 w-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notify Me"
            className="fixed z-[90] flex max-h-[min(70vh,560px)] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-cc-border bg-cc-card shadow-xl"
            style={{ top, right: 12 }}
          >
            <div className="flex items-center justify-between border-b border-cc-border px-3 py-2">
              <span className="text-sm font-semibold text-cc-fg">Notify Me</span>
              <button
                type="button"
                aria-label="Close Notify Me"
                onClick={() => setOpen(false)}
                className="text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-3 px-3 py-2 text-xs">
              {(["pending", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => {
                    setFilter(value);
                    setOffset(0);
                    setPage(null);
                  }}
                  className={`cursor-pointer ${filter === value ? "font-medium text-cc-fg" : "text-cc-muted"}`}
                >
                  {value === "pending" ? `Results (${summary.pending})` : `All tracked (${summary.tracked})`}
                </button>
              ))}
            </div>
            <p className="px-3 pb-2 text-[11px] text-cc-muted">
              Opening a result keeps it here until you acknowledge or reply.
            </p>
            {error && (
              <div role="alert" className="px-3 pb-2 text-xs text-cc-error">
                {error}{" "}
                <button type="button" onClick={() => setRefresh((value) => value + 1)}>
                  Retry
                </button>
              </div>
            )}
            <div className="min-h-0 overflow-y-auto">
              {page ? (
                <NotifyMeResults
                  entries={page.entries}
                  busy={busy}
                  onOpen={jump}
                  onAction={(entry, action) => void act(entry, action)}
                />
              ) : (
                <p className="p-3 text-xs text-cc-muted">Loading…</p>
              )}
              {page?.entries.length === 0 && (
                <p className="px-3 py-5 text-center text-xs text-cc-muted">
                  {filter === "pending"
                    ? "No results waiting. Tracked tasks will appear here when ready."
                    : "Choose Notify Me in a task tab to track its results."}
                </p>
              )}
            </div>
            {page && (offset > 0 || page.nextOffset !== null) && (
              <div className="flex justify-between border-t border-cc-border p-2 text-xs text-cc-muted">
                <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
                  Previous
                </button>
                <button
                  type="button"
                  disabled={page.nextOffset === null}
                  onClick={() => setOffset(page.nextOffset ?? offset)}
                >
                  Next
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
