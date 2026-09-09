import { useStore } from "../store.js";
import type { BoardParticipantStatus } from "../types.js";
import { resolveSessionNavigation, type ResolvedSessionNavigation } from "../utils/session-navigation-resolver.js";
import { hasUnreadSessionAttention } from "../utils/session-attention-status.js";
import type { SessionStatusDotProps } from "./SessionStatusDot.js";

export function participantStatusToDotProps(status: BoardParticipantStatus["status"]): SessionStatusDotProps {
  if (status === "archived") {
    return { archived: true, permCount: 0, isConnected: false, sdkState: "exited", status: null };
  }
  if (status === "disconnected") {
    return { permCount: 0, isConnected: false, sdkState: "exited", status: null };
  }
  if (status === "running") {
    return { permCount: 0, isConnected: true, sdkState: "running", status: "running" };
  }
  return { permCount: 0, isConnected: true, sdkState: "connected", status: "idle" };
}

export function resolveParticipantSessionStatusDotProps({
  navigation,
  hasUnread,
  fallbackStatus,
}: {
  navigation: ResolvedSessionNavigation | null;
  hasUnread: boolean;
  fallbackStatus?: BoardParticipantStatus["status"];
}): SessionStatusDotProps | null {
  if (!navigation) return fallbackStatus ? participantStatusToDotProps(fallbackStatus) : null;
  const session = navigation.sidebarItem;
  return {
    archived: session.archived,
    permCount: session.permCount,
    isConnected: session.isConnected,
    sdkState: session.sdkState,
    status: session.status,
    hasUnread,
    idleKilled: session.idleKilled,
    activeTimerCount: session.pendingTimerCount,
  };
}

export function useParticipantSessionStatusDotProps(
  sessionId: string | null | undefined,
  fallbackStatus?: BoardParticipantStatus["status"],
): SessionStatusDotProps | null {
  const navigation = useStore((state) => (sessionId ? resolveSessionNavigation(state, sessionId) : null));
  const hasUnread = useStore((state) =>
    sessionId ? hasUnreadSessionAttention(state.sessionAttention.get(sessionId)) : false,
  );
  return resolveParticipantSessionStatusDotProps({ navigation, hasUnread, fallbackStatus });
}
