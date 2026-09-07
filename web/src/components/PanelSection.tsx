import { useCallback, useSyncExternalStore } from "react";

const collapseListeners = new Set<() => void>();

export function usePersistedCollapse(key: string, defaultCollapsed = false): [boolean, () => void] {
  const value = useSyncExternalStore(
    (cb) => {
      collapseListeners.add(cb);
      return () => collapseListeners.delete(cb);
    },
    () => {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultCollapsed : stored === "1";
    },
  );
  const toggle = useCallback(() => {
    localStorage.setItem(key, value ? "0" : "1");
    collapseListeners.forEach((listener) => listener());
  }, [key, value]);
  return [value, toggle];
}

export function SectionHeader({
  title,
  collapsed,
  onToggle,
  right,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[12px] font-semibold text-cc-fg cursor-pointer select-none hover:text-cc-primary transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
        {title}
      </button>
      {!collapsed && right && <div className="flex items-center gap-1">{right}</div>}
    </div>
  );
}
