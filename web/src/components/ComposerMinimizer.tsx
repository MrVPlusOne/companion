import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store.js";

/** Hide the whole draft surface without unmounting editors, uploads, or attachment state. */
export function ComposerMinimizer({
  children,
  destination,
  canMinimize = true,
  reveal = false,
  onRestore,
}: {
  children: ReactNode;
  destination: string;
  canMinimize?: boolean;
  reveal?: boolean;
  onRestore?: () => void;
}) {
  const [minimizedDestination, setMinimizedDestination] = useState<string | null>(null);
  const minimized = minimizedDestination === destination && !reveal;
  const content = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const focusTrigger = useStore((state) => state.focusComposerTrigger);
  const previousTrigger = useRef(focusTrigger);
  useEffect(() => {
    const previous = previousTrigger.current;
    previousTrigger.current = focusTrigger;
    if (typeof focusTrigger !== "number" || typeof previous !== "number" || focusTrigger <= previous) return;
    if (!minimized) return;
    onRestore?.();
    restoreFocus.current = true;
    setMinimizedDestination(null);
  }, [focusTrigger, minimized, onRestore]);
  useLayoutEffect(() => {
    if (minimized || !restoreFocus.current) return;
    restoreFocus.current = false;
    content.current?.querySelector("textarea")?.focus();
  }, [minimized]);
  return (
    <div className="shrink-0 bg-cc-card" data-testid="composer-minimizer">
      {(canMinimize || minimized) && (
        <div className={`mx-auto flex max-w-3xl ${minimized ? "px-2 py-2" : "justify-end px-2 pt-1"}`}>
          <button
            type="button"
            aria-label={minimized ? "Restore composer" : "Minimize composer"}
            title={minimized ? "Restore composer" : "Minimize composer"}
            aria-expanded={!minimized}
            disabled={reveal}
            onClick={() => {
              if (minimized) {
                onRestore?.();
                restoreFocus.current = true;
                setMinimizedDestination(null);
              } else {
                content.current?.querySelector("textarea")?.blur();
                setMinimizedDestination(destination);
              }
            }}
            className={`flex items-center gap-2 rounded-lg text-cc-muted hover:bg-cc-hover hover:text-cc-fg disabled:opacity-40 ${minimized ? "w-full border border-cc-border px-3 py-2 text-sm" : "h-7 w-7 justify-center"}`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-4 w-4"
            >
              <path d={minimized ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {minimized && <span>Restore composer</span>}
          </button>
        </div>
      )}
      <div ref={content} hidden={minimized}>
        {children}
      </div>
    </div>
  );
}
