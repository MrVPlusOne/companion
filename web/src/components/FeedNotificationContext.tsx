import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SessionNotification } from "../types.js";

interface FeedNotificationDisplay {
  sessionId: string;
  notifications: ReadonlyArray<SessionNotification> | undefined;
}

const FeedNotificationContext = createContext<FeedNotificationDisplay | null>(null);

/** Share one bounded display projection without replacing the authoritative inbox. */
export function FeedNotificationProvider({
  sessionId,
  notifications,
  children,
}: FeedNotificationDisplay & { children: ReactNode }) {
  const value = useMemo(() => ({ sessionId, notifications }), [sessionId, notifications]);
  return <FeedNotificationContext.Provider value={value}>{children}</FeedNotificationContext.Provider>;
}

/** Use the current feed's proven placements; actions still address the original notification ID. */
export function useFeedDisplayNotifications(
  sessionId: string | undefined,
  authoritativeNotifications: ReadonlyArray<SessionNotification> | undefined,
): ReadonlyArray<SessionNotification> | undefined {
  const display = useContext(FeedNotificationContext);
  return display && display.sessionId === sessionId ? display.notifications : authoritativeNotifications;
}
