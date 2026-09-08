import type { BrowserIncomingMessage } from "../session-types.js";
import { leaderAnswerThreadAuthority } from "../leader-thread-response.js";

type AssistantHistoryEntry = Extract<BrowserIncomingMessage, { type: "assistant" }>;

/** Visibility never grants Ready authority, including sibling status segments and replay. */
export function displayOnlyLeaderAnswerThreads(
  session: { id: string; messageHistory: BrowserIncomingMessage[] },
  turnEntries: readonly AssistantHistoryEntry[],
): Set<string> {
  const ownerThreads = new Set<string>();
  const visibleThreads = new Set<string>();
  for (const entry of turnEntries) {
    if (!entry.threadAnswer) continue;
    const authority = leaderAnswerThreadAuthority(session, entry);
    authority.ownerThreadKeys.forEach((threadKey) => ownerThreads.add(threadKey));
    authority.visibleThreadKeys.forEach((threadKey) => visibleThreads.add(threadKey));
  }
  return new Set([...visibleThreads].filter((threadKey) => !ownerThreads.has(threadKey)));
}
