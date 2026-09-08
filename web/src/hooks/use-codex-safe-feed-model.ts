import { useMemo } from "react";
import type { ChatMessage, SessionNotification } from "../types.js";
import { collectAnchoredNotificationMessageIds } from "../utils/anchored-notifications.js";
import { stripRootCodexThinkingMessages } from "../utils/assistant-content-blocks.js";
import { useFeedModel } from "./use-feed-model.js";

export function useCodexSafeFeedModel(params: {
  messages: ChatMessage[];
  frozenCount: number;
  frozenRevision: number;
  isCodexSession: boolean;
  leaderMode: boolean;
  leaderSessionMode: boolean;
  sessionNotifications: ReadonlyArray<SessionNotification> | undefined;
  userBoundarySourceSessionId: string | null;
  visibleAssistantChildMessageIds?: readonly string[];
  leadingTurnId?: string;
  perf: { sessionId: string; threadKey: string };
}) {
  const anchoredNotificationMessageIds = useMemo(
    () => collectAnchoredNotificationMessageIds(params.sessionNotifications),
    [params.sessionNotifications],
  );
  const feedMessages = useMemo(
    () =>
      params.isCodexSession
        ? stripRootCodexThinkingMessages(params.messages, params.frozenCount)
        : { messages: params.messages, frozenCount: params.frozenCount },
    [params.frozenCount, params.isCodexSession, params.messages],
  );
  return useFeedModel(feedMessages.messages, {
    leaderMode: params.leaderMode,
    leaderSessionMode: params.leaderSessionMode,
    frozenCount: feedMessages.frozenCount,
    frozenRevision: params.frozenRevision,
    anchoredNotificationMessageIds,
    userBoundarySourceSessionId: params.userBoundarySourceSessionId,
    visibleAssistantChildMessageIds: params.visibleAssistantChildMessageIds,
    leadingTurnId: params.leadingTurnId,
    perf: params.perf,
  });
}
