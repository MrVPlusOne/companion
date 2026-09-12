import { createContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export const ComposerVisibilityContext = createContext(true);

/** Own the entire composer's focus boundary while keeping the draft and attachments mounted. */
export function ComposerMinimizer({
  children,
  destination,
  expanded,
  onExpandedChange,
}: {
  children: ReactNode;
  destination: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const insidePointerEvent = useRef<Event | null>(null);
  const blurGeneration = useRef(0);

  useEffect(() => {
    const pointerDown = (event: PointerEvent) => {
      pointerInside.current =
        event === insidePointerEvent.current || (root.current?.contains(event.target as Node) ?? false);
      insidePointerEvent.current = null;
      if (!pointerInside.current) onExpandedChange(false);
    };
    const resetPointer = () => {
      pointerInside.current = false;
    };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("pointerup", resetPointer);
    document.addEventListener("pointercancel", resetPointer);
    document.addEventListener("keydown", resetPointer, true);
    return () => {
      blurGeneration.current++;
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("pointerup", resetPointer);
      document.removeEventListener("pointercancel", resetPointer);
      document.removeEventListener("keydown", resetPointer, true);
    };
  }, [onExpandedChange]);

  useLayoutEffect(() => {
    // A destination change retires old blur work. Desktop focus may intentionally survive navigation.
    blurGeneration.current++;
    onExpandedChange(root.current?.contains(document.activeElement) ?? false);
  }, [destination, onExpandedChange]);

  useLayoutEffect(() => {
    if (expanded || !root.current?.contains(document.activeElement)) return;
    // Hidden toolbar controls must not retain focus after send or manual minimization.
    (document.activeElement as HTMLElement | null)?.blur();
  }, [expanded]);

  return (
    <div
      ref={root}
      className="shrink-0 bg-cc-card"
      data-testid="composer-minimizer"
      data-collapsed={!expanded}
      onPointerDownCapture={(event) => {
        // React-owned portals, such as an attachment lightbox, belong to this same interaction.
        insidePointerEvent.current = event.nativeEvent;
      }}
      onFocusCapture={() => {
        blurGeneration.current++;
        onExpandedChange(true);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        // Clicking a non-focusable part of an internal control is still composer interaction.
        if (!event.relatedTarget && pointerInside.current) return;
        const generation = ++blurGeneration.current;
        queueMicrotask(() => {
          if (generation !== blurGeneration.current || root.current?.contains(document.activeElement)) return;
          onExpandedChange(false);
        });
      }}
    >
      <ComposerVisibilityContext.Provider value={expanded}>{children}</ComposerVisibilityContext.Provider>
    </div>
  );
}

/** Fit manual minimization into the existing toolbar without adding a row. */
export function ComposerMinimizeButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label="Minimize composer"
      title="Minimize composer"
      aria-expanded="true"
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-cc-muted hover:bg-cc-hover hover:text-cc-fg disabled:opacity-40"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-4 w-4"
      >
        <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
