import { formatThreadMarker } from "../../shared/thread-routing.js";
import type { AdapterBrowserRoutingDeps, AdapterBrowserRoutingSessionLike } from "./adapter-browser-routing-types.js";
import type { BrowserUserMessage, IngestedUserMessage } from "./adapter-browser-routing-message-types.js";
import { isSystemSourceTag, isTimerReminderContent, isTimerSourceTag } from "./adapter-browser-routing-source-tags.js";

function localDateKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function buildAdapterUserMessageSourcePrefix(
  session: AdapterBrowserRoutingSessionLike,
  ts: number,
  getLauncherSessionInfo: AdapterBrowserRoutingDeps["getLauncherSessionInfo"],
  agentSource?: BrowserUserMessage["agentSource"],
  content?: string,
  sourceThreadKey?: string,
  leaderUserMessageId?: string,
  leaderTimerMessageId?: string,
): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateKey = localDateKey(ts);
  const includeDate = !session.lastUserMessageDateTag || dateKey !== session.lastUserMessageDateTag;
  session.lastUserMessageDateTag = dateKey;
  const dateStr = includeDate
    ? date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " "
    : "";
  const timeWithDate = dateStr + time;
  const sessionInfo = getLauncherSessionInfo(session.id);
  const threadTag = sessionInfo?.isOrchestrator && sourceThreadKey ? `${formatThreadMarker(sourceThreadKey)} ` : "";
  if (isTimerSourceTag(agentSource)) {
    const idTag = sessionInfo?.isOrchestrator && leaderTimerMessageId ? ` id:${leaderTimerMessageId}` : "";
    return idTag || isTimerReminderContent(content)
      ? `[Timer reminder ${timeWithDate}${idTag}] ${threadTag}`
      : `[Timer event ${timeWithDate}] ${threadTag}`;
  }
  if (sessionInfo?.isOrchestrator) {
    if (isSystemSourceTag(agentSource)) return `[System ${timeWithDate}] ${threadTag}`;
    if (agentSource?.sessionId === "herd-events") return `[Herd ${timeWithDate}] ${threadTag}`;
    if (agentSource) {
      const label = agentSource.sessionLabel || agentSource.sessionId.slice(0, 8);
      return `[Agent ${label} ${timeWithDate}] ${threadTag}`;
    }
    const idTag = leaderUserMessageId ? ` id:${leaderUserMessageId}` : "";
    return `[User ${timeWithDate}${idTag}] ${threadTag}`;
  }
  if (sessionInfo?.herdedBy && agentSource) {
    const label = agentSource.sessionLabel || agentSource.sessionId.slice(0, 8);
    return `[Leader ${label} ${timeWithDate}] `;
  }
  return `[User ${timeWithDate}] `;
}

/** Build a model envelope once, retaining the original envelope on an identified firing retry. */
export function buildUserMessageDeliveryPrefix(
  session: AdapterBrowserRoutingSessionLike,
  ingested: IngestedUserMessage,
  msg: BrowserUserMessage,
  contentPreview: string | undefined,
  deps: Pick<AdapterBrowserRoutingDeps, "getLauncherSessionInfo">,
): string {
  if (
    msg.deliveryContent &&
    msg.timerFiring?.messageId &&
    msg.timerFiring.messageId === ingested.historyEntry.leaderTimerMessageId
  ) {
    return "";
  }
  return buildAdapterUserMessageSourcePrefix(
    session,
    ingested.timestamp,
    deps.getLauncherSessionInfo,
    msg.agentSource,
    contentPreview,
    ingested.historyEntry.threadKey,
    ingested.historyEntry.leaderUserMessageId,
    ingested.historyEntry.leaderTimerMessageId,
  );
}
