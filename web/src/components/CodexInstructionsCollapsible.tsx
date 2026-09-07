import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { SdkSessionInfo } from "../types.js";
import { SectionHeader, usePersistedCollapse } from "./PanelSection.js";

type InstructionSnapshot = NonNullable<SdkSessionInfo["codexInstructionSnapshot"]>;

interface InstructionFetchState {
  key: string;
  status: "loading" | "loaded" | "failed";
  snapshot?: InstructionSnapshot;
}

interface SelectedInstruction {
  snapshotKey: string;
  source: string;
  label: string;
  path?: string;
  trigger: HTMLButtonElement;
}

export function CodexInstructionsCollapsible({
  sessionId,
  snapshot,
  fetchWhenMissing = true,
  refreshKey = "",
  snapshotLoading = false,
  snapshotFailed = false,
}: {
  sessionId: string;
  snapshot?: SdkSessionInfo["codexInstructionSnapshot"];
  fetchWhenMissing?: boolean;
  refreshKey?: string;
  snapshotLoading?: boolean;
  snapshotFailed?: boolean;
}) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-codex-instructions");
  const detailKey = `${sessionId}\u0000${refreshKey}`;
  const [fetchState, setFetchState] = useState<InstructionFetchState | null>(null);
  const [selection, setSelection] = useState<SelectedInstruction | null>(null);
  const currentFetchState = fetchState?.key === detailKey ? fetchState : null;
  const resolvedSnapshot = snapshot ?? currentFetchState?.snapshot;
  const awaitingInitialFetch = !collapsed && fetchWhenMissing && snapshot === undefined && !currentFetchState;
  const loading = snapshotLoading || currentFetchState?.status === "loading" || awaitingInitialFetch;
  const failed = snapshotFailed || currentFetchState?.status === "failed";
  const snapshotKey = `${detailKey}\u0000${resolvedSnapshot?.threadId ?? ""}\u0000${resolvedSnapshot?.capturedAt ?? ""}`;
  const currentSelection = selection?.snapshotKey === snapshotKey ? selection : null;

  useEffect(() => {
    setSelection(null);
  }, [snapshotKey, collapsed, loading, failed]);

  useEffect(() => {
    if (collapsed || !fetchWhenMissing || snapshot !== undefined) return;
    let cancelled = false;
    setFetchState({ key: detailKey, status: "loading" });
    api
      .getSessionInfo(sessionId)
      .then((detail) => {
        if (!cancelled) {
          setFetchState({ key: detailKey, status: "loaded", snapshot: detail.codexInstructionSnapshot });
        }
      })
      .catch(() => {
        if (!cancelled) setFetchState({ key: detailKey, status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [collapsed, detailKey, fetchWhenMissing, sessionId, snapshot]);

  const closeViewer = useCallback(() => {
    setSelection(null);
    if (currentSelection?.trigger.isConnected) currentSelection.trigger.focus();
  }, [currentSelection]);
  const sources = resolvedSnapshot?.instructionSources ?? [];
  const configLayers = resolvedSnapshot?.configLayers ?? [];

  return (
    <>
      <SectionHeader title="Developer Instructions" collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        <div className="space-y-3 px-3 py-2" data-testid="codex-instruction-sources">
          {loading ? (
            <div className="px-2 text-[11px] text-cc-muted">Loading…</div>
          ) : failed ? (
            <div className="px-2 text-[11px] text-cc-error">Could not load the instruction snapshot.</div>
          ) : !resolvedSnapshot ? (
            <div className="px-2 text-[11px] leading-snug text-cc-muted">
              No captured instruction snapshot for this Codex thread. A fresh start or relaunch records one.
            </div>
          ) : (
            <>
              <div className="space-y-1">
                {resolvedSnapshot.developerInstructionsConfigured && (
                  <InstructionSourceButton
                    label="Takode-generated instructions"
                    badge="Takode"
                    onClick={(trigger) =>
                      setSelection({
                        snapshotKey,
                        source: "generated",
                        label: "Takode-generated instructions",
                        trigger,
                      })
                    }
                  />
                )}
                {sources.map((source, index) => {
                  const displayPath = source.sourcePath ?? source.path;
                  const label = displayPath.split(/[\\/]/).pop() ?? displayPath;
                  return (
                    <InstructionSourceButton
                      key={`${source.path}-${index}`}
                      label={label}
                      badge={source.kind === "global" ? "Global" : source.kind === "project" ? "Repository" : "Other"}
                      path={displayPath}
                      loadedPath={source.sourcePath && source.path !== source.sourcePath ? source.path : undefined}
                      onClick={(trigger) =>
                        setSelection({ snapshotKey, source: String(index), label, path: displayPath, trigger })
                      }
                    />
                  );
                })}
                {!resolvedSnapshot.instructionSourcesReported ? (
                  <div className="px-2 text-[11px] text-cc-muted">
                    This Codex version did not report loaded sources.
                  </div>
                ) : sources.length === 0 ? (
                  <div className="px-2 text-[11px] text-cc-muted">No AGENTS instruction files were loaded.</div>
                ) : null}
              </div>
              {configLayers.length > 0 && (
                <div className="space-y-1 border-t border-cc-border/40 pt-2">
                  <div className="px-2 text-[10px] font-medium uppercase tracking-wide text-cc-muted/70">
                    Takode launch configuration
                  </div>
                  <div className="px-2 text-[10px] leading-snug text-cc-muted/75">
                    Launcher-known, path-only provenance; not an exhaustive Codex config dump.
                  </div>
                  {configLayers.map((layer, index) => (
                    <div
                      key={`${layer.kind}-${layer.path ?? layer.label ?? index}`}
                      className="rounded-md px-2 py-1.5 text-[11px]"
                    >
                      <div className="font-medium text-cc-fg/90">{configLayerLabel(layer)}</div>
                      {layer.path && <div className="mt-0.5 break-all font-mono-code text-cc-muted">{layer.path}</div>}
                    </div>
                  ))}
                </div>
              )}
              <div className="border-t border-cc-border/40 px-2 pt-2 text-[10px] leading-snug text-cc-muted/80 break-words">
                {resolvedSnapshot.lifecycle === "thread_resume" ? "Resumed" : "Started"} thread{" "}
                <span className="break-all">{resolvedSnapshot.threadId}</span>
                {` · captured ${new Date(resolvedSnapshot.capturedAt).toLocaleString()}`}. Instruction details show
                captured content for this thread, not current files. Global copies refresh when Takode launches or
                relaunches the Codex process.
              </div>
            </>
          )}
        </div>
      )}
      {!collapsed && !loading && !failed && resolvedSnapshot && currentSelection && (
        <InstructionContentViewer
          key={`${snapshotKey}\u0000${currentSelection.source}`}
          sessionId={sessionId}
          snapshot={resolvedSnapshot}
          selection={currentSelection}
          onClose={closeViewer}
        />
      )}
    </>
  );
}

function InstructionSourceButton({
  label,
  badge,
  path,
  loadedPath,
  onClick,
}: {
  label: string;
  badge: "Takode" | "Global" | "Repository" | "Other";
  path?: string;
  loadedPath?: string;
  onClick: (trigger: HTMLButtonElement) => void;
}) {
  const badgeClass =
    badge === "Global"
      ? "bg-blue-500/10 text-blue-400"
      : badge === "Repository"
        ? "bg-cc-primary/10 text-cc-primary"
        : "bg-cc-hover text-cc-muted";
  return (
    <button
      type="button"
      aria-label={path ? `${badge} instructions: ${path}` : label}
      aria-haspopup="dialog"
      onClick={(event) => onClick(event.currentTarget)}
      className="block w-full min-w-0 rounded-md bg-cc-hover/25 px-2 py-2 text-left hover:bg-cc-hover focus-visible:outline-2 focus-visible:outline-cc-primary cursor-pointer transition-colors"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeClass}`}
        >
          {badge}
        </span>
        <span className="min-w-0 break-words font-mono-code text-[11px] text-cc-fg/90">{label}</span>
      </span>
      {path && (
        <span className="mt-1 block break-all font-mono-code text-[10px] leading-relaxed text-cc-muted">{path}</span>
      )}
      {loadedPath && (
        <span className="mt-1 block break-all text-[10px] leading-relaxed text-cc-muted/75">
          Loaded snapshot: <span className="font-mono-code">{loadedPath}</span>
        </span>
      )}
    </button>
  );
}

function InstructionContentViewer({
  sessionId,
  snapshot,
  selection,
  onClose,
}: {
  sessionId: string;
  snapshot: InstructionSnapshot;
  selection: SelectedInstruction;
  onClose: () => void;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<{
    status: "loading" | "loaded" | "failed";
    content?: string | null;
    reason?: string;
  }>({ status: "loading" });
  const { threadId, capturedAt } = snapshot;
  const { source } = selection;

  useEffect(() => {
    let cancelled = false;
    api
      .getSessionInstructionContent(sessionId, { threadId, capturedAt, source })
      .then((detail) => {
        if (cancelled) return;
        if (detail.threadId !== threadId || detail.capturedAt !== capturedAt || detail.source !== source) {
          setResult({ status: "failed" });
          return;
        }
        setResult({ status: "loaded", content: detail.content, reason: detail.unavailableReason });
      })
      .catch(() => {
        if (!cancelled) setResult({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, threadId, capturedAt, source]);

  useEffect(() => {
    closeRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const close = closeRef.current;
        const body = dialogRef.current?.querySelector<HTMLElement>("[data-instruction-content]");
        const first = close;
        const last = body ?? close;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    // Capture Escape before Session Info's own dismiss listener, keeping the parent open.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  return createPortal(
    <div
      data-session-info-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3 sm:p-8"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex h-full max-h-[900px] w-full max-w-5xl min-w-0 flex-col overflow-hidden rounded-2xl border border-cc-border bg-cc-bg shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-cc-border bg-cc-card px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="break-words text-sm font-semibold text-cc-fg">
              {selection.label}
            </h2>
            <p className="mt-0.5 text-[11px] text-cc-muted">Captured developer instructions · Read-only</p>
            {selection.path && (
              <p className="mt-1 break-all font-mono-code text-[10px] text-cc-muted">{selection.path}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close instruction viewer"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div data-instruction-content tabIndex={0} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {result.status === "loading" ? (
            <p role="status" className="text-sm text-cc-muted">
              Loading captured instructions…
            </p>
          ) : result.status === "failed" ? (
            <p role="alert" className="text-sm text-cc-error">
              Could not load the captured instructions. Close and reopen this source to try again.
            </p>
          ) : result.content === null || result.content === undefined ? (
            <p className="text-sm text-cc-muted">
              {result.reason || "Captured content is unavailable for this instruction source."}
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-mono-code text-[12px] leading-relaxed text-cc-fg/90">
              {result.content}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function configLayerLabel(layer: InstructionSnapshot["configLayers"][number]): string {
  if (layer.label) return layer.label;
  if (layer.kind === "user") return layer.profile ? `Session config · profile ${layer.profile}` : "Session config";
  if (layer.kind === "project") return "Project config";
  if (layer.kind === "system") return "System config";
  if (layer.kind === "managed") return "Managed config";
  if (layer.kind === "legacy_managed") return "Legacy managed config";
  return "Config source";
}
