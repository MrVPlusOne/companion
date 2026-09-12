import { useContext, useLayoutEffect, type RefObject } from "react";
import { ComposerVisibilityContext } from "./ComposerMinimizer.js";

/** Refit visible draft text after content, restore, or width changes without measuring a hidden box. */
export function useComposerTextareaSize(ref: RefObject<HTMLTextAreaElement | null>, text: string): void {
  const visible = useContext(ComposerVisibilityContext);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    if (!visible) {
      // Keep padding outside this one-line viewport: native textarea text can paint into bottom padding.
      textarea.style.height = "24px";
      // The compact view always shows the first line, including after editing further down the draft.
      textarea.scrollTop = 0;
      textarea.scrollLeft = 0;
      return;
    }
    const fit = () => {
      const previous = textarea.style.height;
      textarea.style.height = "auto";
      const height = textarea.scrollHeight;
      textarea.style.height = height > 0 ? `${Math.min(height, 200)}px` : previous;
    };
    fit();
    let width = textarea.getBoundingClientRect().width;
    // Width changes can rewrap text without changing the draft; ignore height-only notifications.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const next = textarea.getBoundingClientRect().width;
            if (next === width) return;
            width = next;
            if (width > 0) fit();
          });
    observer?.observe(textarea);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, text, visible]);
}
