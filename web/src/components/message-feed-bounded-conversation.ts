import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryWindowState, ThreadWindowState } from "../types.js";
import { getCachedHistoryWindowHash } from "../utils/history-window-cache.js";
import { sendToSession } from "../ws.js";

/** Keep scroll handlers synchronous while making follow changes observable to subscriptions. */
export function useMessageFeedFollowState(initiallyFollowing: boolean) {
  const autoFollowEnabledRef = useRef(initiallyFollowing);
  const [followRevision, setFollowRevision] = useState(0);
  const setAutoFollowEnabled = useCallback((enabled: boolean) => {
    if (autoFollowEnabledRef.current === enabled) return;
    autoFollowEnabledRef.current = enabled;
    setFollowRevision((revision) => revision + 1);
  }, []);
  return { autoFollowEnabledRef, followRevision, setAutoFollowEnabled };
}

export function useMessageFeedBoundedConversation(input: {
  sessionId: string;
  connectionStatus: string | undefined;
  normalizedThreadKey: string;
  selectedFeedWindowEnabled: boolean;
  activeHistoryWindow: HistoryWindowState | null;
  activeThreadWindow: ThreadWindowState | null;
  autoFollowEnabledRef: { current: boolean };
  followRevision: number;
}): {
  historyWindowRevision: number;
  noteWindowRequest: (window: HistoryWindowState | ThreadWindowState | null) => void;
  requestHistoryWindow: (
    fromTurn: number,
    turnCount: number,
    sectionTurnCount: number,
    visibleSectionCount: number,
    targetMessageId?: string,
  ) => boolean;
} {
  const historyWindowRevisionRef = useRef<{ window: HistoryWindowState | null; revision: number }>({
    window: null,
    revision: 0,
  });
  const lastAnnouncementRef = useRef<string | null>(null);
  const requestedFromWindowRef = useRef<HistoryWindowState | ThreadWindowState | null | undefined>(undefined);
  const noteWindowRequest = useCallback((window: HistoryWindowState | ThreadWindowState | null) => {
    requestedFromWindowRef.current = window;
    lastAnnouncementRef.current = null;
  }, []);
  if (historyWindowRevisionRef.current.window !== input.activeHistoryWindow) {
    historyWindowRevisionRef.current = {
      window: input.activeHistoryWindow,
      revision: historyWindowRevisionRef.current.revision + 1,
    };
  }

  const requestHistoryWindow = useCallback(
    (
      fromTurn: number,
      turnCount: number,
      sectionTurnCount: number,
      visibleSectionCount: number,
      targetMessageId?: string,
    ) => {
      const cachedWindowHash = getCachedHistoryWindowHash(input.sessionId, {
        fromTurn,
        turnCount,
        sectionTurnCount,
        visibleSectionCount,
      });
      const delivered = sendToSession(input.sessionId, {
        type: "history_window_request",
        from_turn: fromTurn,
        turn_count: turnCount,
        section_turn_count: sectionTurnCount,
        visible_section_count: visibleSectionCount,
        activate_view: true,
        ...(cachedWindowHash ? { cached_window_hash: cachedWindowHash } : {}),
        ...(targetMessageId ? { target_message_id: targetMessageId } : {}),
      });
      if (delivered) noteWindowRequest(input.activeHistoryWindow);
      return delivered;
    },
    [input.activeHistoryWindow, input.sessionId, noteWindowRequest],
  );

  useEffect(() => {
    if (input.connectionStatus !== "connected") {
      lastAnnouncementRef.current = null;
      requestedFromWindowRef.current = undefined;
      return;
    }
    const thread = input.selectedFeedWindowEnabled ? input.activeThreadWindow : null;
    const history = input.selectedFeedWindowEnabled ? null : input.activeHistoryWindow;
    if (!thread && !history) return;
    // An explicit request has activated its destination. Do not overwrite it
    // with the old applied window while waiting for a replacement delivery.
    if (requestedFromWindowRef.current === (thread ?? history)) return;
    requestedFromWindowRef.current = undefined;
    const sectionCount = thread?.section_item_count ?? history!.section_turn_count;
    const visibleCount = thread?.visible_item_count ?? history!.visible_section_count;
    // Read after layout: restoring an older viewport or aligning a local send
    // may have changed follow intent since this render began.
    const announcement = {
      type: "conversation_view_update" as const,
      view: thread ? ("thread" as const) : ("history" as const),
      ...(thread ? { thread_key: input.normalizedThreadKey } : {}),
      from: input.autoFollowEnabledRef.current ? -1 : (thread?.from_item ?? history!.from_turn),
      count: Math.max(thread?.item_count ?? history!.turn_count, sectionCount * visibleCount),
      section_count: sectionCount,
      visible_count: visibleCount,
      cached_window_hash: thread?.window_hash ?? history?.window_hash,
    };
    const signature = JSON.stringify([input.sessionId, announcement]);
    if (signature === lastAnnouncementRef.current) return;
    if (sendToSession(input.sessionId, announcement)) lastAnnouncementRef.current = signature;
  }, [
    input.activeHistoryWindow,
    input.activeThreadWindow,
    input.connectionStatus,
    input.normalizedThreadKey,
    input.selectedFeedWindowEnabled,
    input.sessionId,
    input.autoFollowEnabledRef,
    input.followRevision,
  ]);

  return {
    historyWindowRevision: historyWindowRevisionRef.current.revision,
    noteWindowRequest,
    requestHistoryWindow,
  };
}
