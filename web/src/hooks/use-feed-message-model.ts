import { useMemo } from "react";
import { useStore } from "../store.js";
import { buildFeedMessageModel, type BuildFeedMessageModelInput } from "../utils/feed-render-model.js";

type FeedMessageInput = Omit<
  BuildFeedMessageModelInput,
  "sessionNotifications" | "sessionAttentionRecords" | "sessionBoard" | "sessionCompletedBoard" | "toolResults"
>;

/** Derive one bounded feed from its current server-owned window and decision state. */
export function useFeedMessageModel(input: FeedMessageInput) {
  const sessionId = input.leaderSessionId;
  const sessionNotifications = useStore((s) => s.sessionNotifications?.get(sessionId));
  const sessionAttentionRecords = useStore((s) => s.sessionAttentionRecords?.get(sessionId));
  const sessionBoard = useStore((s) => s.sessionBoards?.get(sessionId));
  const sessionCompletedBoard = useStore((s) => s.sessionCompletedBoards?.get(sessionId));
  const toolResults = useStore((s) => s.toolResults.get(sessionId));
  return useMemo(
    () =>
      buildFeedMessageModel({
        ...input,
        sessionNotifications,
        sessionAttentionRecords,
        sessionBoard,
        sessionCompletedBoard,
        toolResults,
      }),
    [
      input.leaderSessionId,
      input.threadKey,
      input.projectThreadRoutes,
      input.allMessages,
      input.historyLoading,
      input.selectedFeedWindow,
      input.selectedFeedWindowEnabled,
      input.selectedFeedWindowMessages,
      input.threadResponseState,
      input.additionalAttentionRecords,
      sessionNotifications,
      sessionAttentionRecords,
      sessionBoard,
      sessionCompletedBoard,
      toolResults,
    ],
  );
}
