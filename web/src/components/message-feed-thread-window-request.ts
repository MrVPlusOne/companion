import { useCallback } from "react";
import type { ThreadWindowState } from "../types.js";
import { getThreadWindowItemCount } from "../../shared/thread-window.js";
import { getCachedThreadWindowHash } from "../utils/history-window-cache.js";
import { sendToSession } from "../ws.js";
import { useStore } from "../store.js";
import { DEFAULT_VISIBLE_SECTION_COUNT } from "./message-feed-sections.js";

export function useThreadWindowRequester({
  activeThreadWindow,
  normalizedThreadKey,
  sectionTurnCount,
  sessionId,
  onWindowRequest,
  setPendingInitialThreadWindowKey,
}: {
  activeThreadWindow: ThreadWindowState | null;
  normalizedThreadKey: string;
  sectionTurnCount: number;
  sessionId: string;
  onWindowRequest: (window: ThreadWindowState | null) => void;
  setPendingInitialThreadWindowKey: (threadKey: string) => void;
}) {
  return useCallback(
    (fromItem: number, requestedItemCount?: number, targetMessageId?: string) => {
      const store = useStore.getState();
      if (!activeThreadWindow && store.pendingThreadWindowRequests?.get(sessionId) === normalizedThreadKey) {
        return true;
      }
      const itemCount = activeThreadWindow
        ? requestedItemCount ||
          activeThreadWindow.item_count ||
          getThreadWindowItemCount(activeThreadWindow.visible_item_count, activeThreadWindow.section_item_count)
        : getThreadWindowItemCount(DEFAULT_VISIBLE_SECTION_COUNT, sectionTurnCount);
      const sectionItemCount = activeThreadWindow?.section_item_count ?? sectionTurnCount;
      const visibleItemCount = activeThreadWindow?.visible_item_count ?? DEFAULT_VISIBLE_SECTION_COUNT;
      const cachedWindowHash =
        fromItem < 0 && activeThreadWindow?.window_hash
          ? activeThreadWindow.window_hash
          : getCachedThreadWindowHash(sessionId, {
              threadKey: normalizedThreadKey,
              fromItem,
              itemCount,
              sectionItemCount,
              visibleItemCount,
            });
      const delivered = sendToSession(sessionId, {
        type: "thread_window_request",
        thread_key: normalizedThreadKey,
        from_item: fromItem,
        item_count: itemCount,
        section_item_count: sectionItemCount,
        visible_item_count: visibleItemCount,
        activate_view: true,
        ...(targetMessageId ? { target_message_id: targetMessageId } : {}),
        ...(cachedWindowHash && !targetMessageId ? { cached_window_hash: cachedWindowHash } : {}),
      });
      if (delivered) onWindowRequest(activeThreadWindow);
      if (delivered && !activeThreadWindow) {
        store.setPendingThreadWindowRequest?.(sessionId, normalizedThreadKey);
        setPendingInitialThreadWindowKey(normalizedThreadKey);
      }
      return delivered;
    },
    [
      activeThreadWindow,
      normalizedThreadKey,
      onWindowRequest,
      sectionTurnCount,
      sessionId,
      setPendingInitialThreadWindowKey,
    ],
  );
}
