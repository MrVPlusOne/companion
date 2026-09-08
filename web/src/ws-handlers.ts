import { useStore } from "./store.js";
import { api } from "./api.js";
import { createComposerDraftImage } from "./components/composer-image-utils.js";
import { collectLocalImagePreviewSources, resolveLocalImagePreviews } from "./local-image-previews.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  ContentBlock,
  ChatMessage,
  SdkSessionInfo,
  TaskItem,
} from "./types.js";
import { playNotificationSound } from "./utils/notification-sound.js";
import { getRecoveryModelDeliveryContent } from "./utils/injected-event-message.js";
import {
  extractTextFromBlocks,
  normalizeCodexReasoningDetailMessage,
  normalizeHistoryMessageToChatMessages,
  normalizeLiveAssistantThreadMetadata,
  normalizeLiveLeaderUserThreadMetadata,
} from "./utils/history-message-normalization.js";
import { applyNotificationStatusUpdate, applySessionNotifications } from "./notification-status.js";
import {
  applyAuthoritativeSessionArchive,
  beginActiveSessionListRequest,
  hydrateSessionList,
} from "./session-list-hydration.js";
import {
  cacheHistoryWindow,
  cacheThreadWindow,
  resolveCachedHistoryWindowMessages,
  resolveCachedThreadWindowEntries,
} from "./utils/history-window-cache.js";
import { isRootThinkingOnlyAssistantHistoryEntry } from "../shared/history-sync-hash.js";
import { isTerminalResultInterrupted } from "../shared/result-interruption.js";
import { SESSION_DEFAULTS_UPDATED_EVENT } from "../shared/session-defaults.js";
import { recordFrontendPerfEntry } from "./utils/frontend-perf-recorder.js";
import { applyThreadAttachmentUpdate } from "./thread-attachment-update-handler.js";
import type { WsIncomingMessageContext } from "./ws-message-context.js";
import { handleTranscriptionProgressMessage } from "./transcription-progress.js";
import { requestThreadViewportSnapshot } from "./utils/thread-viewport.js";
import { handleNotificationUpdateMessage } from "./ws-notification-handler.js";
import { handleStreamEventMessage } from "./ws-stream-event-handler.js";
import { applyAutoPauseRecoverySnapshot, handleStatusChangeMessage } from "./ws-status-change-handler.js";
import {
  mergeAssistantContentBlocks,
  stripRootCodexThinkingBlocks,
  stripRootCodexThinkingMessage,
} from "./utils/assistant-content-blocks.js";
import { convertLegacyParentedCodexThinkingMessage } from "./utils/codex-reasoning-detail.js";
import { TODO_STATE_UPDATED_EVENT } from "./todo-events.js";
import { indexCodexSubagentToolResults } from "./utils/codex-subagent-tool-results.js";
import { handleQuestListUpdated, handleSessionQuestClaimed } from "./ws-quest-handlers.js";
import {
  handleSyncedProjectionMessage,
  type SyncedProjectionMessageHandlerDeps,
} from "./ws-synced-projection-handler.js";

const taskCounters = new Map<string, number>();
const pendingCliDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();
/** Debounce timer for session_created events -- coalesce rapid bursts into a single API call. */
let sessionCreatedTimer: ReturnType<typeof setTimeout> | null = null;

let sessionMutationRefreshInFlight: Promise<void> | null = null;
type SessionMutationRefreshParams = {
  sessionId: string;
  createdSessionId?: string;
  archivedSessionId?: string;
  kind: "session_created_refresh" | "session_archived_refresh";
};
let queuedSessionMutationRefresh: SessionMutationRefreshParams | null = null;

/** Delay transient backend_disconnected flips to avoid sidebar flicker during fast relaunches. */
const CLI_DISCONNECT_DEBOUNCE_MS = 250;

function perfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export interface WsMessageHandlerDeps extends SyncedProjectionMessageHandlerDeps {
  disconnectSession: (sessionId: string) => void;
  sendToSession: (sessionId: string, msg: BrowserOutgoingMessage) => boolean;
}

function clearPendingCliDisconnect(sessionId: string): void {
  const timer = pendingCliDisconnectTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingCliDisconnectTimers.delete(sessionId);
}

function applyCliDisconnected(sessionId: string, reason: "idle_limit" | "broken" | "recovery_suppressed" | null): void {
  const store = useStore.getState();
  store.setCliConnected(sessionId, false);
  store.setCliDisconnectReason(sessionId, reason);
  store.setSessionStatus(sessionId, null);
  store.clearStreamingState(sessionId);
  store.clearToolProgress(sessionId);
}

function isCodexSession(sessionId: string): boolean {
  return useStore.getState().sessions.get(sessionId)?.backend_type === "codex";
}

function mergeLiveAssistantMetadata(
  existing: ChatMessage["metadata"] | undefined,
  incoming: ChatMessage["metadata"] | undefined,
  authoritativeAnswerRoute: boolean,
): ChatMessage["metadata"] | undefined {
  if (!existing && !incoming) return undefined;
  const merged = { ...existing, ...incoming };
  if (!authoritativeAnswerRoute) return merged;

  // A completed answer rebroadcast may add automatic visibility or use Main
  // as its source route. Replace proof-bearing route fields so omitted Main
  // fields do not retain the provisional quest.
  for (const key of ["threadKey", "questId", "threadRefs"] as const) {
    if (!incoming || !Object.prototype.hasOwnProperty.call(incoming, key)) delete merged[key];
  }
  return merged;
}

function clearRecoverableCodexInitErrors(sessionId: string): void {
  const store = useStore.getState();
  const messages = store.messages.get(sessionId);
  if (!messages?.some(isRecoverableCodexInitErrorMessage)) return;
  store.setMessages(
    sessionId,
    messages.filter((message) => !isRecoverableCodexInitErrorMessage(message)),
    { frozenCount: store.messageFrozenCounts.get(sessionId) ?? 0 },
  );
}

function isRecoverableCodexInitErrorMessage(message: ChatMessage): boolean {
  if (!message.ephemeral || message.role !== "system" || message.variant !== "error") return false;
  if (!/\bCodex initialization failed: Transport closed\b/i.test(message.content)) return false;
  return ![
    /error loading default config/i,
    /no such file or directory/i,
    /permission denied/i,
    /\bEACCES\b/i,
    /authentication token is expired/i,
    /\btoken_expired\b/i,
    /\brmcp::transport\b/i,
    /\bcodex_apps\b/i,
    /\bTokenRefreshFailed\b/i,
    /\binvalid_grant\b/i,
  ].some((pattern) => pattern.test(message.content));
}

function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

export function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

function resetTaskExtractionTracking(sessionId: string): void {
  processedToolUseIds.delete(sessionId);
  taskCounters.delete(sessionId);
}

function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);
  let hadTaskUpdate = false;

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
        hadTaskUpdate = true;
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      hadTaskUpdate = true;
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
        hadTaskUpdate = true;
      }
    }
  }

  // Update sidebar task preview: show the first in_progress task's activeForm
  if (hadTaskUpdate) {
    const tasks = useStore.getState().sessionTasks.get(sessionId);
    const active = tasks?.find((t) => t.status === "in_progress");
    store.setSessionTaskPreview(sessionId, active ? active.activeForm || active.subject : null);
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const session = store.sessions.get(sessionId);
  const sessionCwd = session?.cwd || store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  // Use repo root as scope so files outside session cwd (e.g. repo-root CLAUDE.md) are tracked.
  // For worktrees, repo_root points to the main repo (not the worktree directory), so fall
  // back to cwd when repo_root isn't an ancestor of cwd.
  const scope = session?.repo_root && sessionCwd?.startsWith(session.repo_root + "/") ? session.repo_root : sessionCwd;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    const filePath = name === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (
      (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") &&
      typeof filePath === "string"
    ) {
      const resolvedPath = resolveSessionFilePath(filePath, sessionCwd);
      if (isPathInSessionScope(resolvedPath, scope)) {
        store.addChangedFile(sessionId, resolvedPath);
      }
    }
  }
}

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

function shouldNotifyOnResult(sessionId: string, store: ReturnType<typeof useStore.getState>): boolean {
  const sdk = store.sdkSessions.find((s) => s.sessionId === sessionId);
  if (sdk?.herdedBy) return false;
  if (!sdk?.isOrchestrator) return true;

  const messages = store.messages.get(sessionId) || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return !!msg.notification;
  }
  return false;
}

let idCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function refreshActiveSidebarSessions(params: SessionMutationRefreshParams): void {
  if (sessionMutationRefreshInFlight) {
    queuedSessionMutationRefresh = params;
    return;
  }
  const startedAt = perfNow();
  const requestSequence = beginActiveSessionListRequest();
  const refresh = api
    .listSessions({ includeArchived: false })
    .then((list) => {
      hydrateSessionList(list, { preserveMissingArchived: true, activeSnapshotRequestSequence: requestSequence });
      const durationMs = perfNow() - startedAt;
      if (params.kind === "session_created_refresh" && params.createdSessionId) {
        recordFrontendPerfEntry({
          kind: "session_created_refresh",
          timestamp: Date.now(),
          sessionId: params.sessionId,
          createdSessionId: params.createdSessionId,
          sessionCount: list.length,
          durationMs,
          ok: true,
        });
      } else if (params.kind === "session_archived_refresh" && params.archivedSessionId) {
        recordFrontendPerfEntry({
          kind: "session_archived_refresh",
          timestamp: Date.now(),
          sessionId: params.sessionId,
          archivedSessionId: params.archivedSessionId,
          sessionCount: list.length,
          durationMs,
          ok: true,
        });
      }
    })
    .catch((err) => {
      const durationMs = perfNow() - startedAt;
      if (params.kind === "session_created_refresh" && params.createdSessionId) {
        recordFrontendPerfEntry({
          kind: "session_created_refresh",
          timestamp: Date.now(),
          sessionId: params.sessionId,
          createdSessionId: params.createdSessionId,
          durationMs,
          ok: false,
        });
      } else if (params.kind === "session_archived_refresh" && params.archivedSessionId) {
        recordFrontendPerfEntry({
          kind: "session_archived_refresh",
          timestamp: Date.now(),
          sessionId: params.sessionId,
          archivedSessionId: params.archivedSessionId,
          durationMs,
          ok: false,
        });
      }
      console.warn(`[ws] Failed to refresh sessions after ${params.kind}:`, err);
    })
    .finally(() => {
      if (sessionMutationRefreshInFlight === refresh) {
        sessionMutationRefreshInFlight = null;
        const queuedRefresh = queuedSessionMutationRefresh;
        queuedSessionMutationRefresh = null;
        if (queuedRefresh) refreshActiveSidebarSessions(queuedRefresh);
      }
    });
  sessionMutationRefreshInFlight = refresh;
}

function normalizeHistoryMessages(
  sessionId: string,
  historyMessages: BrowserIncomingMessage[],
  startIndex = 0,
  localPreviewSources = collectLocalImagePreviewSources(useStore.getState(), sessionId),
): { chatMessages: ChatMessage[]; frozenCount: number } {
  const store = useStore.getState();
  const chatMessages: ChatMessage[] = [];
  const childToolResults = indexCodexSubagentToolResults(historyMessages);
  let frozenCount = 0;
  const fallbackTimestamps = buildHistoryFallbackTimestamps(historyMessages.map((message) => ({ message })));

  for (let i = 0; i < historyMessages.length; i++) {
    const histMsg = historyMessages[i];
    const historyIndex =
      Number.isInteger(histMsg.history_index) && (histMsg.history_index ?? -1) >= 0
        ? histMsg.history_index!
        : startIndex + i;
    const fallbackTimestamp = fallbackTimestamps[i];
    if (histMsg.type === "assistant") {
      if (isCodexSession(sessionId) && isRootThinkingOnlyAssistantHistoryEntry(histMsg)) continue;
      const msg = histMsg.message;
      for (const chatMessage of normalizeHistoryMessageToChatMessages(histMsg, historyIndex, {
        fallbackTimestamp,
        codexSubagentToolResults: histMsg.codexSubagent
          ? childToolResults.get(histMsg.codexSubagent.childId)
          : undefined,
      })) {
        const converted = convertLegacyParentedCodexThinkingMessage(isCodexSession(sessionId), chatMessage);
        const stripped = stripRootCodexThinkingMessage(isCodexSession(sessionId), converted);
        if (stripped) chatMessages.push(stripped);
      }
      if (!histMsg.codexSubagent && msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }
      const histToolStartTimes = (histMsg as Record<string, unknown>).tool_start_times as
        | Record<string, number>
        | undefined;
      if (!histMsg.codexSubagent && histToolStartTimes) {
        store.setToolStartTimestamps(sessionId, histToolStartTimes);
      }
    } else if (
      histMsg.type === "user_message" ||
      histMsg.type === "codex_reasoning_detail" ||
      histMsg.type === "error"
    ) {
      chatMessages.push(
        ...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, {
          fallbackTimestamp,
          localImages:
            histMsg.type === "user_message"
              ? resolveLocalImagePreviews(sessionId, histMsg, localPreviewSources)
              : undefined,
        }),
      );
    } else if (histMsg.type === "leader_user_message") {
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, { fallbackTimestamp }));
    } else if (histMsg.type === "tool_result_preview") {
      if (!histMsg.codexSubagent)
        for (const preview of histMsg.previews) store.setToolResult(sessionId, preview.tool_use_id, preview);
    } else if (histMsg.type === "task_notification") {
      if (histMsg.tool_use_id) {
        store.setBackgroundAgentNotif(sessionId, histMsg.tool_use_id, {
          status: histMsg.status,
          outputFile: histMsg.output_file,
          summary: histMsg.summary,
        });
      }
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, { fallbackTimestamp }));
    } else if (histMsg.type === "result") {
      if (!histMsg.codexSubagent) {
        store.setTasks(sessionId, []);
        store.setSessionTaskPreview(sessionId, null);
      }
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, { fallbackTimestamp }));
      if (!histMsg.codexSubagent) frozenCount = chatMessages.length;
    } else if (
      histMsg.type === "compact_marker" ||
      histMsg.type === "codex_auto_pause_recovery_summary" ||
      histMsg.type === "quest_lifecycle_event" ||
      histMsg.type === "thread_attachment_marker" ||
      histMsg.type === "thread_transition_marker" ||
      histMsg.type === "permission_denied" ||
      histMsg.type === "permission_approved"
    ) {
      chatMessages.push(...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, { fallbackTimestamp }));
    }
  }

  return { chatMessages, frozenCount };
}

function normalizeThreadWindowEntries(
  sessionId: string,
  entries: Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>["entries"],
): ChatMessage[] {
  const store = useStore.getState();
  const localPreviewSources = collectLocalImagePreviewSources(store, sessionId);
  const chatMessages: ChatMessage[] = [];
  const childToolResults = indexCodexSubagentToolResults(entries.map((entry) => entry.message));
  const fallbackTimestamps = buildHistoryFallbackTimestamps(entries);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const histMsg = entry.message;
    const historyIndex = entry.history_index;
    const fallbackTimestamp = fallbackTimestamps[index];
    if (histMsg.type === "assistant") {
      if (isCodexSession(sessionId) && isRootThinkingOnlyAssistantHistoryEntry(histMsg)) continue;
      for (const chatMessage of normalizeHistoryMessageToChatMessages(histMsg, historyIndex, {
        fallbackTimestamp,
        codexSubagentToolResults: histMsg.codexSubagent
          ? childToolResults.get(histMsg.codexSubagent.childId)
          : undefined,
      })) {
        const converted = convertLegacyParentedCodexThinkingMessage(isCodexSession(sessionId), chatMessage);
        const stripped = stripRootCodexThinkingMessage(isCodexSession(sessionId), converted);
        if (stripped) chatMessages.push(stripped);
      }
      if (!histMsg.codexSubagent && histMsg.message.content?.length) {
        extractTasksFromBlocks(sessionId, histMsg.message.content);
        extractChangedFilesFromBlocks(sessionId, histMsg.message.content);
      }
      const histToolStartTimes = histMsg.tool_start_times;
      if (!histMsg.codexSubagent && histToolStartTimes) {
        store.setToolStartTimestamps(sessionId, histToolStartTimes);
      }
      continue;
    }
    if (histMsg.type === "tool_result_preview") {
      if (!histMsg.codexSubagent)
        for (const preview of histMsg.previews) store.setToolResult(sessionId, preview.tool_use_id, preview);
      continue;
    }
    if (histMsg.type === "task_notification") {
      if (histMsg.tool_use_id) {
        store.setBackgroundAgentNotif(sessionId, histMsg.tool_use_id, {
          status: histMsg.status,
          outputFile: histMsg.output_file,
          summary: histMsg.summary,
        });
      }
    }
    chatMessages.push(
      ...normalizeHistoryMessageToChatMessages(histMsg, historyIndex, {
        fallbackTimestamp,
        localImages:
          histMsg.type === "user_message"
            ? resolveLocalImagePreviews(sessionId, histMsg, localPreviewSources)
            : undefined,
      }),
    );
  }
  return chatMessages;
}

function buildHistoryFallbackTimestamps(
  items: ReadonlyArray<{ message: BrowserIncomingMessage }>,
): Array<number | undefined> {
  const previousTimestamps: Array<number | undefined> = [];
  let previousTimestamp: number | undefined;
  for (const item of items) {
    previousTimestamps.push(previousTimestamp);
    previousTimestamp = readHistoryMessageTimestamp(item.message) ?? previousTimestamp;
  }

  const fallbackTimestamps: Array<number | undefined> = new Array(items.length);
  let nextTimestamp: number | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const timestamp = readHistoryMessageTimestamp(items[index]!.message);
    fallbackTimestamps[index] = timestamp ?? previousTimestamps[index] ?? nextTimestamp;
    nextTimestamp = timestamp ?? nextTimestamp;
  }
  return fallbackTimestamps;
}

function readHistoryMessageTimestamp(message: BrowserIncomingMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return timestamp;
}

function markPendingUserMessageFailed(sessionId: string, clientMsgId: string, message: string): void {
  const store = useStore.getState();
  const active = store.pendingUserUploads.get(sessionId)?.find((upload) => upload.id === clientMsgId) ?? null;
  const restored = store.takePendingUserUploadRestoration(sessionId, clientMsgId);
  if (active) {
    store.updatePendingUserUpload(sessionId, clientMsgId, (upload) => ({
      ...upload,
      stage: "failed",
      error: message,
      prepared: undefined,
    }));
  } else if (restored) {
    store.addPendingUserUpload(sessionId, { ...restored, stage: "failed", error: message, prepared: undefined });
  }
}

function clearPendingUploadsCoveredByHistory(sessionId: string, historyMessages: BrowserIncomingMessage[]): void {
  const committedInputIds = new Set<string>();
  const committedClientMsgIds = new Set<string>();
  for (const msg of historyMessages) {
    if (msg.type !== "user_message" || msg.codexSubagent) continue;
    if (typeof msg.id === "string") committedInputIds.add(msg.id);
    if (typeof msg.client_msg_id === "string") committedClientMsgIds.add(msg.client_msg_id);
  }
  if (committedInputIds.size === 0 && committedClientMsgIds.size === 0) return;
  const store = useStore.getState();
  for (const clientMsgId of committedClientMsgIds) {
    store.consumePendingUserUpload(sessionId, clientMsgId);
    store.takePendingUserUploadRestoration(sessionId, clientMsgId);
  }
  const pendingInputs = store.pendingCodexInputs.get(sessionId) ?? [];
  const remainingInputs = pendingInputs.filter(
    (input) => !committedInputIds.has(input.id) && !committedClientMsgIds.has(input.clientMsgId ?? ""),
  );
  if (remainingInputs.length !== pendingInputs.length) store.setPendingCodexInputs(sessionId, remainingInputs);
}

function reconcileLocalPreviewCopiesWithAuthoritativeMessages(
  sessionId: string,
  historyMessages: readonly BrowserIncomingMessage[],
): void {
  type AuthoritativeUserMessage = {
    clientMsgId?: string;
    messageId?: string;
    images: NonNullable<Extract<BrowserIncomingMessage, { type: "user_message" }>["images"]>;
  };
  const authoritativeByClientMsgId = new Map<string, AuthoritativeUserMessage>();
  const authoritativeByMessageId = new Map<string, AuthoritativeUserMessage>();
  for (const message of historyMessages) {
    if (message.type !== "user_message" || message.codexSubagent) continue;
    const authoritative: AuthoritativeUserMessage = {
      ...(typeof message.client_msg_id === "string" ? { clientMsgId: message.client_msg_id } : {}),
      ...(typeof message.id === "string" && message.id.trim() ? { messageId: message.id } : {}),
      images: message.images ?? [],
    };
    if (authoritative.clientMsgId) authoritativeByClientMsgId.set(authoritative.clientMsgId, authoritative);
    if (authoritative.messageId) authoritativeByMessageId.set(authoritative.messageId, authoritative);
  }
  if (authoritativeByClientMsgId.size === 0 && authoritativeByMessageId.size === 0) return;

  const store = useStore.getState();
  const messageLists: ChatMessage[][] = [store.messages.get(sessionId) ?? []];
  for (const messages of store.threadWindowMessages.get(sessionId)?.values() ?? []) messageLists.push(messages);
  const updatedMessageIds = new Set<string>();
  for (const messages of messageLists) {
    for (const message of messages) {
      if (!message.localImages?.length || updatedMessageIds.has(message.id)) continue;
      const authoritative =
        (message.clientMsgId ? authoritativeByClientMsgId.get(message.clientMsgId) : undefined) ??
        authoritativeByMessageId.get(message.id);
      if (!authoritative) continue;
      const sameMessage =
        (!authoritative.messageId || authoritative.messageId === message.id) &&
        (!authoritative.clientMsgId || authoritative.clientMsgId === message.clientMsgId);
      const authoritativeImageIds = new Set(authoritative.images.map((image) => image.imageId));
      const nextLocalImages = sameMessage
        ? message.localImages.filter(
            (image) => typeof image.imageId === "string" && authoritativeImageIds.has(image.imageId),
          )
        : [];
      const imagesChanged =
        sameMessage &&
        ((message.images?.length ?? 0) !== authoritative.images.length ||
          authoritative.images.some((image, index) => message.images?.[index]?.imageId !== image.imageId));
      if (nextLocalImages.length === message.localImages.length && !imagesChanged) continue;
      updatedMessageIds.add(message.id);
      store.updateMessage(sessionId, message.id, {
        ...(imagesChanged ? { images: authoritative.images.length > 0 ? authoritative.images : undefined } : {}),
        localImages: nextLocalImages.length > 0 ? nextLocalImages : undefined,
      });
    }
  }
}

function collectRetainedToolUseIds(messages: ChatMessage[]): Set<string> {
  const retained = new Set<string>();
  for (const message of messages) {
    if (message.parentToolUseId) retained.add(message.parentToolUseId);
    for (const block of message.contentBlocks || []) {
      if (block.type === "tool_use" && block.id) retained.add(block.id);
    }
  }
  return retained;
}

function resetAuthoritativeHistoryState(
  sessionId: string,
  options?: { preserveToolStateIds?: Iterable<string> },
): void {
  const store = useStore.getState();
  store.resetSessionForAuthoritativeHistory(sessionId, options);
}

function snapshotThreadViewportBeforeHistoryReplacement(sessionId: string): void {
  // Mobile reconnect can replace history while the feed stays mounted. Capture
  // the live scroll position before the replacement clears window state.
  requestThreadViewportSnapshot(sessionId);
}

/** Resolve a pending message-index scroll from deep link navigation (session:N:M). */
function resolvePendingMessageScroll(sessionId: string, messages: ChatMessage[]): void {
  const store = useStore.getState();

  // Resolve pending message ID scroll (from /msg/<id> deep links in new tabs).
  const pendingMsgId = store.pendingScrollToMessageId.get(sessionId);
  if (pendingMsgId) {
    store.clearPendingScrollToMessageId(sessionId);
    store.requestScrollToMessage(sessionId, pendingMsgId);
    store.setExpandAllInTurn(sessionId, pendingMsgId);
    return; // ID-based scroll takes precedence over index-based
  }

  // Resolve pending message index scroll (from legacy ?msg=N deep links).
  const pendingIdx = store.pendingScrollToMessageIndex.get(sessionId);
  if (pendingIdx == null) return;
  const hasRawHistoryIndexes = messages.some((msg) => typeof msg.historyIndex === "number");
  const targetMsg = hasRawHistoryIndexes
    ? messages.find((msg) => msg.historyIndex === pendingIdx)
    : messages[pendingIdx];
  if (!targetMsg) return;

  store.clearPendingScrollToMessageIndex(sessionId);
  store.requestScrollToMessage(sessionId, targetMsg.id);
  store.setExpandAllInTurn(sessionId, targetMsg.id);
}

function requestUncachedHistoryWindow(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "history_window_sync" }>,
  deps: WsMessageHandlerDeps,
): void {
  deps.sendToSession(sessionId, {
    type: "history_window_request",
    from_turn: data.window.from_turn,
    turn_count: data.window.turn_count,
    section_turn_count: data.window.section_turn_count,
    visible_section_count: data.window.visible_section_count,
    activate_view: true,
  });
}

function requestUncachedThreadWindow(
  sessionId: string,
  data: Extract<BrowserIncomingMessage, { type: "thread_window_sync" }>,
  deps: WsMessageHandlerDeps,
): void {
  deps.sendToSession(sessionId, {
    type: "thread_window_request",
    thread_key: data.window.thread_key,
    from_item: data.window.from_item,
    item_count: data.window.item_count,
    section_item_count: data.window.section_item_count,
    visible_item_count: data.window.visible_item_count,
    activate_view: true,
  });
}

function handleParsedMessage(
  sessionId: string,
  data: BrowserIncomingMessage,
  deps: WsMessageHandlerDeps,
  context: WsIncomingMessageContext = { source: "live" },
) {
  const store = useStore.getState();
  if (handleSyncedProjectionMessage(sessionId, data, store, deps, context)) return;

  switch (data.type) {
    case "session_init": {
      const existingSession = store.sessions.get(sessionId);
      store.addSession(data.session);
      // Do NOT set cliConnected here — session_init is just a state snapshot.
      // Connection status comes from explicit backend_connected/backend_disconnected messages.
      if (!existingSession) {
        store.setSessionStatus(sessionId, "idle");
      }
      // Sync askPermission from server state
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      if (data.session.backend_state === "connected") {
        clearRecoverableCodexInitErrors(sessionId);
      }
      // Sync askPermission if updated
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      break;
    }

    case "session_activity_update": {
      const targetSessionId = data.session_id;
      if (!targetSessionId) break;
      const update = data.session ?? {};
      if (update.modelProvenanceMigration) {
        store.updateSdkSession(targetSessionId, { modelProvenanceMigration: update.modelProvenanceMigration });
      }
      applyNotificationStatusUpdate(targetSessionId, update);
      break;
    }

    case "codex_pending_inputs": {
      store.setPendingCodexInputs(sessionId, data.inputs);
      for (const input of data.inputs) {
        if (input.clientMsgId) store.consumePendingUserUpload(sessionId, input.clientMsgId);
      }
      break;
    }

    case "codex_pending_input_failed": {
      if (data.input.clientMsgId) {
        markPendingUserMessageFailed(sessionId, data.input.clientMsgId, data.message);
      }
      break;
    }

    case "codex_pending_input_cancelled": {
      if (data.input.clientMsgId) store.consumePendingUserUpload(sessionId, data.input.clientMsgId);
      const restoredUpload = data.input.clientMsgId
        ? store.takePendingUserUploadRestoration(sessionId, data.input.clientMsgId)
        : null;
      const fallbackImages = data.input.draftImages?.length
        ? data.input.draftImages.map((img) => ({
            ...createComposerDraftImage(
              {
                name: img.name,
                base64: img.base64,
                mediaType: img.mediaType,
              },
              { status: "uploading" },
            ),
          }))
        : restoredUpload?.images || [];
      const hasServerImages = Boolean(data.input.imageRefs?.length);
      const hasRestorableImages = Boolean(data.input.draftImages?.length || restoredUpload?.images.length);
      if (!hasServerImages || hasRestorableImages) {
        store.setComposerDraft(sessionId, {
          text: data.input.content,
          images: fallbackImages,
        });
        store.setReplyContext(sessionId, data.input.replyContext ?? restoredUpload?.replyContext ?? null);
      }
      break;
    }

    case "leader_user_message": {
      const normalized = normalizeLiveLeaderUserThreadMetadata(data);
      store.appendMessage(sessionId, {
        id: data.id,
        role: "assistant",
        content: normalized.content,
        timestamp: data.timestamp,
        ...(data.history_index !== undefined ? { historyIndex: data.history_index } : {}),
        metadata: normalized.metadata,
        ...(data.notification ? { notification: data.notification } : {}),
      });
      break;
    }

    case "thread_attachment_marker": {
      const [message] = normalizeHistoryMessageToChatMessages(data, data.history_index ?? -1);
      if (message) store.appendMessage(sessionId, message);
      break;
    }

    case "thread_attachment_update": {
      applyThreadAttachmentUpdate(sessionId, data, deps, { messageContext: context });
      break;
    }

    case "thread_transition_marker": {
      const [message] = normalizeHistoryMessageToChatMessages(data, data.history_index ?? -1);
      if (message) store.appendMessage(sessionId, message);
      break;
    }

    case "compact_marker": {
      const [message] = normalizeHistoryMessageToChatMessages(data, data.history_index ?? -1);
      if (message) store.appendMessage(sessionId, message);
      break;
    }

    case "codex_auto_pause_recovery_summary": {
      const [message] = normalizeHistoryMessageToChatMessages(data, data.history_index ?? -1);
      if (!message) break;
      const existing = store.messages.get(sessionId)?.some((candidate) => candidate.id === message.id);
      if (existing) store.updateMessage(sessionId, message.id, message);
      else store.appendMessage(sessionId, message);
      break;
    }

    case "codex_reasoning_detail": {
      const message = normalizeCodexReasoningDetailMessage(data, data.history_index);
      const existing = store.messages.get(sessionId)?.find((candidate) => candidate.id === message.id);
      if (!existing) store.appendMessage(sessionId, message);
      store.updateMessage(sessionId, message.id, {
        content: message.content,
        ...(message.historyIndex !== undefined ? { historyIndex: message.historyIndex } : {}),
        parentToolUseId: message.parentToolUseId,
        metadata: message.metadata,
      });
      if (!data.codexSubagent) {
        store.setStreamingThinking(sessionId, null, data.parent_tool_use_id);
        if (data.status === "streaming") store.setSessionStatus(sessionId, "running");
      }
      break;
    }

    case "vscode_selection_state": {
      store.setVsCodeSelectionContext(data.state);
      break;
    }

    case "assistant": {
      const msg = data.message;
      const normalized = normalizeLiveAssistantThreadMetadata(data);
      const contentBlocks = stripRootCodexThinkingBlocks(
        isCodexSession(sessionId),
        data.parent_tool_use_id,
        normalized.content,
      );
      const textContent = extractTextFromBlocks(contentBlocks);
      const chatMsg = convertLegacyParentedCodexThinkingMessage(isCodexSession(sessionId), {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        turnDurationMs: data.turn_duration_ms,
        ...(data.history_index !== undefined ? { historyIndex: data.history_index } : {}),
        cliUuid: (data as Record<string, unknown>).uuid as string | undefined,
        ...(data.notification ? { notification: data.notification } : {}),
        ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
      });
      // Server accumulates content blocks for same-ID messages (parallel tool calls).
      // If this ID already exists, merge content blocks rather than replace — this
      // handles both accumulated messages (server sends full set) and non-accumulated
      // messages (old server sends partial blocks) correctly.
      const existingMsgs = store.messages.get(sessionId) || [];
      const existing = msg.id ? existingMsgs.find((m) => m.id === msg.id) : undefined;
      if (existing) {
        const mergedBlocks = stripRootCodexThinkingBlocks(
          isCodexSession(sessionId),
          data.parent_tool_use_id,
          mergeAssistantContentBlocks(existing.contentBlocks || [], contentBlocks || []),
        );
        store.updateMessage(sessionId, msg.id!, {
          content: extractTextFromBlocks(mergedBlocks),
          contentBlocks: mergedBlocks,
          timestamp: data.timestamp || existing.timestamp,
          stopReason: msg.stop_reason || existing.stopReason,
          ...(data.history_index !== undefined ? { historyIndex: data.history_index } : {}),
          ...(data.notification ? { notification: data.notification } : {}),
          ...(normalized.metadata
            ? {
                metadata: mergeLiveAssistantMetadata(
                  existing.metadata,
                  normalized.metadata,
                  data.threadAnswer !== undefined,
                ),
              }
            : {}),
          ...(typeof data.turn_duration_ms === "number" ? { turnDurationMs: data.turn_duration_ms } : {}),
        });
      } else if (contentBlocks.length > 0 || data.notification || normalized.metadata?.threadStatusMarkers?.length) {
        store.appendMessage(sessionId, chatMsg);
      }
      // Native child rows are audit content only. They must not mutate the
      // root session's live streaming, task, progress, or lifecycle state.
      if (data.codexSubagent) break;
      store.setStreaming(sessionId, null, data.parent_tool_use_id);
      if (msg.content?.some((block) => block.type === "thinking")) {
        store.setStreamingThinking(sessionId, null, data.parent_tool_use_id);
      }
      // Clear progress only for completed tools (tool_result blocks), not all tools.
      // Blanket clear would cause flickering during concurrent tool execution.
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            store.clearToolProgress(sessionId, block.tool_use_id);
          }
        }
      }
      // Rebroadcasted assistant messages with turn_duration_ms arrive AFTER the
      // turn completes (post-result). Don't flip status to "running" for those —
      // the result handler will set "idle" momentarily, but setting "running" here
      // causes a brief incorrect status flicker.
      if (typeof data.turn_duration_ms !== "number") {
        store.setSessionStatus(sessionId, "running");
      }

      // Store server-provided tool start timestamps for live duration display
      if (data.tool_start_times && typeof data.tool_start_times === "object") {
        store.setToolStartTimestamps(sessionId, data.tool_start_times as Record<string, number>);
      }

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      handleStreamEventMessage(sessionId, data);
      break;
    }

    case "result": {
      // Native-child completion is authoritative audit history, but it cannot
      // settle or mutate the root session's browser lifecycle.
      if (data.codexSubagent) break;
      const r = data.data;
      const sessionUpdates: Partial<{
        total_cost_usd: number;
        num_turns: number;
        context_used_percent: number;
        total_lines_added: number;
        total_lines_removed: number;
      }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      store.updateSession(sessionId, sessionUpdates);
      store.clearStreamingState(sessionId);
      store.clearToolProgress(sessionId);
      store.setSessionStatus(sessionId, "idle");
      store.setActiveTurnRoute(sessionId, null);
      store.setSessionStuck(sessionId, false);
      store.setTasks(sessionId, []);
      store.setSessionTaskPreview(sessionId, null);
      const isProviderRetryResult = !!r.codex_provider_retry;
      const notifyOnResult = !isProviderRetryResult && shouldNotifyOnResult(sessionId, store);
      // Play notification sound if enabled and tab is not focused
      if (notifyOnResult && !document.hasFocus() && store.notificationSound) {
        const sdk = store.sdkSessions.find((s) => s.sessionId === sessionId);
        console.log(
          `[notification] result sound: session=${sessionId.slice(0, 8)} isOrch=${!!sdk?.isOrchestrator} herdedBy=${sdk?.herdedBy ?? "none"}`,
        );
        playNotificationSound();
      }
      if (notifyOnResult && !document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
      }
      if (
        r.is_error &&
        !isProviderRetryResult &&
        !isTerminalResultInterrupted(r, { explicitInterrupted: data.interrupted === true })
      ) {
        const errorText = r.errors?.length ? r.errors.join(", ") : r.result || "An error occurred";
        const isContextLimit = errorText.toLowerCase().includes("prompt is too long");

        // If user tried /compact but it failed because context is full,
        // auto-recover by killing the CLI and relaunching with --resume.
        // The SDK protocol doesn't intercept slash commands from user messages,
        // so /compact gets treated as a regular prompt and overflows again.
        if (isContextLimit) {
          const msgs = store.messages.get(sessionId) || [];
          const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
          if (lastUserMsg?.content.trim().toLowerCase() === "/compact") {
            store.appendMessage(sessionId, {
              id: nextId(),
              role: "system",
              content: "Context is full — restarting session to compact...",
              timestamp: Date.now(),
              variant: "info",
              ephemeral: true,
            });
            fetch(`/api/sessions/${encodeURIComponent(sessionId)}/force-compact`, { method: "POST" }).catch(() => {
              store.appendMessage(sessionId, {
                id: nextId(),
                role: "system",
                content: `Error: ${errorText}`,
                timestamp: Date.now(),
                variant: "error",
                ephemeral: true,
              });
            });
            break;
          }
        }

        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${errorText}`,
          timestamp: Date.now(),
          variant: "error",
        });
      }
      store.commitMessagesAsFrozen(sessionId);
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      // If evaluating via LLM auto-approver, don't pause timer or notify —
      // the agent isn't waiting on the user yet.
      if (!data.request.evaluating) {
        store.pauseStreamingTimer(sessionId);
        if (!document.hasFocus() && store.notificationDesktop) {
          const req = data.request;
          console.log(`[notification] permission_request: session=${sessionId.slice(0, 8)} tool=${req.tool_name}`);
          sendBrowserNotification("Permission needed", `${req.tool_name}: approve or deny`, req.request_id);
        }
      }
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [
          {
            type: "tool_use" as const,
            id: req.tool_use_id,
            name: req.tool_name,
            input: req.input,
          },
        ];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "permission_denied": {
      if (data.request_id) store.removePermission(sessionId, data.request_id);
      const denialMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "denied",
      };
      store.appendMessage(sessionId, denialMsg);
      break;
    }

    case "permission_approved": {
      // Delay permission removal slightly so the "Approved" stamping animation
      // has time to play before the component unmounts. The permission is already
      // resolved on the server — this delay is purely cosmetic (400ms matches
      // the paw-approve animation duration).
      const approvedReqId = data.request_id;
      if (approvedReqId) {
        setTimeout(() => store.removePermission(sessionId, approvedReqId), 400);
      }
      const approvedMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "approved",
        ...(data.answers?.length ? { metadata: { answers: data.answers } } : {}),
      };
      store.appendMessage(sessionId, approvedMsg);
      break;
    }

    case "permission_auto_approved": {
      // Don't remove — mark as auto-approved so PermissionBanner can decide
      // whether to dismiss silently or show an "auto-approved" indicator
      // (depending on whether the user had expanded the evaluating dialog).
      store.markPermissionAutoApproved(sessionId, data.request_id, data.reason || "Auto-approved");
      // Summary shows what was approved; reason (LLM rationale) is passed via metadata
      // for separate rendering in the AutoApprovedChip.
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.summary ?? `Auto-approved: ${data.tool_name}`,
        timestamp: data.timestamp,
        variant: "approved",
        ephemeral: true,
        ...(data.reason ? { metadata: { autoApprovalReason: data.reason } } : {}),
      });
      break;
    }

    case "permission_auto_denied": {
      // LLM auto-approver declined — transition from evaluating to normal pending state.
      // The permission stays pending for the user (LLM deny = "not confident, ask human").
      store.updatePermissionEvaluating(sessionId, data.request_id, undefined);
      // NOW pause timer and send notification since this needs user attention
      store.pauseStreamingTimer(sessionId);
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Permission needed", `${data.tool_name}: approve or deny`, data.request_id);
      }
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: `Auto-approver declined ${data.tool_name}: ${data.reason}`,
        timestamp: data.timestamp,
        variant: "info",
        ephemeral: true,
      });
      break;
    }

    case "permission_needs_attention": {
      // LLM evaluation deferred, failed, or timed out — transition to normal pending state.
      // Store the deferral reason so PermissionBanner can explain WHY.
      store.updatePermissionEvaluating(sessionId, data.request_id, undefined);
      if (data.reason) {
        store.updatePermissionDeferralReason(sessionId, data.request_id, data.reason);
      }
      store.pauseStreamingTimer(sessionId);
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification(
          "Permission needed",
          data.reason || "Auto-approval evaluation finished — needs your input",
          data.request_id,
        );
      }
      break;
    }

    case "leader_group_idle": {
      console.log(
        `[notification] leader_group_idle: leader=${data.leader_label} members=${data.member_count} idle_for=${data.idle_for_ms}ms focus=${document.hasFocus()} sound=${store.notificationSound}`,
      );
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification(
          "Leader group idle",
          `${data.leader_label} is idle and waiting for attention`,
          `leader-group-idle:${data.leader_session_id}`,
        );
      }
      break;
    }

    case "permission_evaluating_status": {
      // Auto-approver status transition (e.g., "queued" → "evaluating")
      store.updatePermissionEvaluating(sessionId, data.request_id, data.evaluating);
      break;
    }

    case "tool_progress": {
      if (data.codexSubagent) break;
      store.setToolProgress(sessionId, data.tool_use_id, {
        toolName: data.tool_name,
        elapsedSeconds: data.elapsed_time_seconds,
        outputDelta: typeof data.output_delta === "string" ? data.output_delta : undefined,
      });
      break;
    }

    case "transcription_progress": {
      handleTranscriptionProgressMessage({
        requestId: data.requestId,
        phase: data.phase,
        mode: data.mode,
        timestamp: data.timestamp,
        timing: data.timing,
        result: data.result,
        error: data.error,
      });
      break;
    }

    case "tool_use_summary": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.summary,
        timestamp: Date.now(),
        ephemeral: true,
      });
      break;
    }

    case "tool_result_preview": {
      if (data.codexSubagent) {
        store.attachCodexSubagentToolResults(sessionId, data.codexSubagent, data.previews);
        break;
      }
      for (const preview of data.previews) {
        const retainedProgress = store.toolProgress.get(sessionId)?.get(preview.tool_use_id);
        const shouldRetainTerminalTranscript =
          store.sessions.get(sessionId)?.backend_type === "codex" && retainedProgress?.toolName === "Bash";
        store.setToolResult(sessionId, preview.tool_use_id, preview);
        // Preserve completed Codex Bash output so the inline card can keep the
        // captured transcript after the live terminal chip disappears.
        if (!shouldRetainTerminalTranscript) {
          store.clearToolProgress(sessionId, preview.tool_use_id);
        }
      }
      break;
    }

    case "user_message": {
      // Server-authoritative: user messages are broadcast by the server to all
      // browsers. The browser never adds user messages to the store locally.
      const localImages = resolveLocalImagePreviews(sessionId, data, collectLocalImagePreviewSources(store, sessionId));
      if (typeof data.client_msg_id === "string") {
        store.consumePendingUserUpload(sessionId, data.client_msg_id);
        store.takePendingUserUploadRestoration(sessionId, data.client_msg_id);
      }
      clearPendingUploadsCoveredByHistory(sessionId, [data]);
      const metadata: ChatMessage["metadata"] = {
        ...(data.replyContext ? { replyContext: data.replyContext } : {}),
        ...(data.vscodeSelection ? { vscodeSelection: data.vscodeSelection } : {}),
        ...(data.threadRefs ? { threadRefs: data.threadRefs } : {}),
        ...(data.threadKey ? { threadKey: data.threadKey } : {}),
        ...(data.questId ? { questId: data.questId } : {}),
        ...(data.threadRoutingError ? { threadRoutingError: data.threadRoutingError } : {}),
        ...(data.leaderResponseCoverageVersion
          ? { leaderResponseCoverageVersion: data.leaderResponseCoverageVersion }
          : {}),
        ...(data.leaderUserMessageId ? { leaderUserMessageId: data.leaderUserMessageId } : {}),
        ...(data.leaderTimerMessageId ? { leaderTimerMessageId: data.leaderTimerMessageId } : {}),
      };
      const modelDeliveryContent = getRecoveryModelDeliveryContent(data);
      const userMsg: ChatMessage = {
        id: data.id || nextId(),
        role: "user",
        content: data.content,
        timestamp: data.timestamp || Date.now(),
        ...(data.images?.length ? { images: data.images } : {}),
        ...(localImages?.length ? { localImages } : {}),
        ...(typeof data.client_msg_id === "string" ? { clientMsgId: data.client_msg_id } : {}),
        ...(data.history_index !== undefined ? { historyIndex: data.history_index } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(data.agentSource ? { agentSource: data.agentSource } : {}),
        ...(modelDeliveryContent !== undefined ? { modelDeliveryContent } : {}),
        ...(data.takodeHerdEventKeys?.length ? { takodeHerdEventKeys: data.takodeHerdEventKeys } : {}),
        ...(data.takodeHerdEvents?.length ? { takodeHerdEvents: data.takodeHerdEvents } : {}),
      };
      store.appendMessage(sessionId, userMsg);
      reconcileLocalPreviewCopiesWithAuthoritativeMessages(sessionId, [data]);
      break;
    }

    case "status_change": {
      handleStatusChangeMessage(sessionId, data);
      break;
    }

    case "session_stuck": {
      store.setSessionStuck(sessionId, true);
      break;
    }

    case "session_unstuck": {
      store.setSessionStuck(sessionId, false);
      break;
    }

    case "session_deleted": {
      // Another browser or the API deleted a session — remove it from the store
      // so the sidebar updates immediately without waiting for the next poll.
      // Also disconnect the WebSocket to prevent reconnect attempts.
      const deletedId = data.session_id;
      if (deletedId && typeof deletedId === "string") {
        console.log(`[ws] session_deleted: removing ${deletedId} from store`);
        store.removeSession(deletedId);
        deps.disconnectSession(deletedId);
      }
      break;
    }

    case "session_archived": {
      const archivedId = data.session_id;
      if (archivedId && typeof archivedId === "string") {
        applyAuthoritativeSessionArchive(archivedId, data.archivedAt);
        refreshActiveSidebarSessions({
          sessionId,
          archivedSessionId: archivedId,
          kind: "session_archived_refresh",
        });
      }
      break;
    }

    case "session_created": {
      // Another browser or the API created a session — debounce the refresh
      // to coalesce rapid bursts (e.g., multiple sessions created in quick succession).
      const createdId = data.session_id;
      if (createdId && typeof createdId === "string") {
        if (sessionCreatedTimer) clearTimeout(sessionCreatedTimer);
        sessionCreatedTimer = setTimeout(() => {
          sessionCreatedTimer = null;
          refreshActiveSidebarSessions({
            sessionId,
            createdSessionId: createdId,
            kind: "session_created_refresh",
          });
        }, 1_000);
      }
      break;
    }

    case "notification_anchored": {
      // Stamp the notification onto the matching assistant message in the store
      // so the chat feed can render a visual marker.
      const targetId = data.messageId;
      if (targetId) {
        store.updateMessage(sessionId, targetId, {
          notification: data.notification,
        });
      }
      break;
    }

    case "board_updated": {
      // Update Zustand board state so the persistent WorkBoardBar widget
      // and any future live-updating inline boards stay current.
      store.setSessionBoard(sessionId, data.board ?? []);
      store.setSessionCompletedBoard(sessionId, data.completedBoard ?? []);
      if (data.rowSessionStatuses) {
        store.setSessionBoardRowStatuses(sessionId, data.rowSessionStatuses);
      }
      break;
    }

    case "timer_update": {
      // Server-authoritative timer list for this session.
      store.setSessionTimers(sessionId, data.timers ?? []);
      break;
    }

    case "notification_update": {
      handleNotificationUpdateMessage(sessionId, data);
      break;
    }

    case "attention_records_update": {
      store.setSessionAttentionRecords(sessionId, data.attentionRecords ?? []);
      break;
    }

    case "permissions_cleared": {
      store.clearPermissions(sessionId);
      break;
    }

    case "state_snapshot": {
      // Authoritative state from server — overrides any stale transient state
      const authoritativeNotificationStatus = {
        notificationUrgency: data.notificationUrgency,
        activeNotificationCount: data.activeNotificationCount,
        activeNeedsInputNotificationCount: data.activeNeedsInputNotificationCount,
        activeReviewNotificationCount: data.activeReviewNotificationCount,
        mutedNeedsInputNotificationCount: data.mutedNeedsInputNotificationCount,
        notificationStatusVersion: data.notificationStatusVersion,
        notificationStatusUpdatedAt: data.notificationStatusUpdatedAt,
      };
      store.setSessionStatus(sessionId, data.sessionStatus as "idle" | "running" | "compacting" | "reverting" | null);
      store.setActiveTurnRoute(sessionId, data.sessionStatus === "running" ? data.activeTurnRoute : null);
      store.setCodexReasoningPreviews(sessionId, data.codexReasoningPreviews ?? []);
      store.setCliConnected(sessionId, data.backendConnected);
      applyAutoPauseRecoverySnapshot(sessionId, data);
      // state_snapshot is sent after subscribe replay completes. If no
      // history_sync arrived, this was an empty-history
      // session and the optimistic loading placeholder should be cleared.
      store.markHistoryDelivered(sessionId);
      store.setHistoryLoading(sessionId, false);
      store.setPendingThreadWindowRequest(sessionId, null);
      if (data.backendState !== undefined || data.backendError !== undefined) {
        store.updateSession(sessionId, {
          ...(data.backendState !== undefined ? { backend_state: data.backendState } : {}),
          ...(data.backendError !== undefined ? { backend_error: data.backendError } : {}),
          ...(data.backendReconnect !== undefined ? { backend_reconnect: data.backendReconnect } : {}),
          ...(data.codexProviderRetry !== undefined ? { codex_provider_retry: data.codexProviderRetry } : {}),
          ...(data.codexStreamRetry !== undefined ? { codex_stream_retry: data.codexStreamRetry } : {}),
          ...(data.codexTurnRecovery !== undefined ? { codex_turn_recovery: data.codexTurnRecovery } : {}),
        });
      }
      if (data.backendConnected) store.setCliEverConnected(sessionId);
      if (data.askPermission !== undefined) {
        store.setAskPermission(sessionId, data.askPermission);
      }
      // Clear stale streaming state when session is not actively generating.
      // This handles: server restart (event_replay sets stale timers),
      // CLI crash mid-generation, and any other state desync.
      if (data.sessionStatus !== "running") {
        store.clearStreamingState(sessionId);
        store.clearToolProgress(sessionId);
        store.setSessionStuck(sessionId, false);
      } else if (data.generationStartedAt && !store.streamingStartedAt.has(sessionId)) {
        // Restore generation timer from server so switching sessions
        // doesn't reset the "Purring..." counter.
        store.setStreamingStats(sessionId, { startedAt: data.generationStartedAt });
      }
      // Sync board state from server on connect/reconnect
      if (data.board) {
        store.setSessionBoard(sessionId, data.board);
      }
      if (data.completedBoard) {
        store.setSessionCompletedBoard(sessionId, data.completedBoard);
      }
      if (data.rowSessionStatuses) {
        store.setSessionBoardRowStatuses(sessionId, data.rowSessionStatuses);
      }
      // Sync notification inbox from server on connect/reconnect
      if (data.notifications) {
        applySessionNotifications(sessionId, data.notifications, authoritativeNotificationStatus, {
          authoritativeStatus: true,
        });
      }
      store.setSessionAttentionRecords(sessionId, data.attentionRecords ?? []);
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
          variant: "error",
          ephemeral: true,
        });
      }
      break;
    }

    case "error": {
      if (data.codexSubagent) {
        store.appendMessage(sessionId, {
          id: data.id ?? nextId(),
          role: "system",
          content: data.message,
          timestamp: data.timestamp ?? Date.now(),
          variant: "error",
          ...(data.history_index !== undefined ? { historyIndex: data.history_index } : {}),
          metadata: {
            codexSubagent: data.codexSubagent,
            ...(data.threadRefs ? { threadRefs: data.threadRefs } : {}),
            ...(data.threadKey ? { threadKey: data.threadKey } : {}),
            ...(data.questId ? { questId: data.questId } : {}),
            ...(data.threadRoutingError ? { threadRoutingError: data.threadRoutingError } : {}),
          },
        });
        break;
      }
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
        variant: "error",
        ephemeral: true,
      });
      break;
    }

    case "backend_disconnected": {
      clearPendingCliDisconnect(sessionId);
      const reason = data.reason ?? null;
      const timer = setTimeout(() => {
        pendingCliDisconnectTimers.delete(sessionId);
        applyCliDisconnected(sessionId, reason);
      }, CLI_DISCONNECT_DEBOUNCE_MS);
      pendingCliDisconnectTimers.set(sessionId, timer);
      break;
    }

    case "backend_connected": {
      clearPendingCliDisconnect(sessionId);
      clearRecoverableCodexInitErrors(sessionId);
      store.setCliConnected(sessionId, true);
      break;
    }

    case "tree_groups_update": {
      const startedAt = perfNow();
      const groups = Array.isArray(data.treeGroups) ? data.treeGroups : [];
      const assignments =
        data.treeAssignments && typeof data.treeAssignments === "object"
          ? (data.treeAssignments as Record<string, string>)
          : {};
      const nodeOrder =
        data.treeNodeOrder && typeof data.treeNodeOrder === "object"
          ? (data.treeNodeOrder as Record<string, string[]>)
          : {};
      store.setTreeGroups(groups, assignments, nodeOrder);
      recordFrontendPerfEntry({
        kind: "tree_groups_update_apply",
        timestamp: Date.now(),
        sessionId,
        groupCount: groups.length,
        assignmentCount: Object.keys(assignments).length,
        nodeOrderParentCount: Object.keys(nodeOrder).length,
        nodeOrderChildCount: Object.values(nodeOrder).reduce((count, children) => count + children.length, 0),
        durationMs: perfNow() - startedAt,
      });
      break;
    }

    case "session_task_history": {
      store.setSessionTaskHistory(sessionId, data.tasks);
      break;
    }

    case "pr_status_update": {
      store.setPRStatus(sessionId, { available: data.available, pr: data.pr });
      break;
    }

    case "compact_boundary": {
      // CLI has compacted — preserve existing messages and insert a compact marker divider
      const markerTs = typeof data.timestamp === "number" ? data.timestamp : Date.now();
      const markerId = data.id || `compact-boundary-${markerTs}`;
      store.appendMessage(sessionId, {
        id: markerId,
        role: "system",
        content: "Conversation compacted",
        timestamp: markerTs,
        variant: "info",
      });
      break;
    }

    case "compact_summary": {
      // Update the most recent compact marker with the full summary text
      const msgs = store.messages.get(sessionId) || [];
      const lastCompact = [...msgs]
        .reverse()
        .find(
          (m) =>
            m.role === "system" &&
            m.id.startsWith("compact-boundary-") &&
            m.metadata?.compactMarkerKind !== "session_recycled",
        );
      if (lastCompact) {
        store.updateMessage(sessionId, lastCompact.id, { content: data.summary });
      }
      break;
    }

    case "mcp_status": {
      store.setMcpServers(sessionId, data.servers);
      break;
    }

    case "task_notification": {
      if (data.tool_use_id) {
        store.setBackgroundAgentNotif(sessionId, data.tool_use_id, {
          status: data.status,
          outputFile: data.output_file,
          summary: data.summary,
        });
      }
      // Add a visible system message so the user can see what background task
      // completed and why the model may start a new auto-triggered turn.
      if (data.summary) {
        store.appendMessage(sessionId, {
          id: `task-notif-${data.task_id || Date.now()}`,
          role: "system",
          content: data.summary,
          timestamp: Date.now(),
          variant: "task_completed",
        });
      }
      break;
    }

    case "quest_list_updated": {
      handleQuestListUpdated(data);
      break;
    }

    case "todo_state_updated": {
      window.dispatchEvent(
        new CustomEvent(TODO_STATE_UPDATED_EVENT, { detail: { revision: data.revision, updatedAt: data.updatedAt } }),
      );
      break;
    }

    case "settings_updated": {
      window.dispatchEvent(new CustomEvent(SESSION_DEFAULTS_UPDATED_EVENT, { detail: data.sessionDefaults }));
      break;
    }

    case "quest_lifecycle_event": {
      for (const message of normalizeHistoryMessageToChatMessages(data, data.history_index ?? -1)) {
        store.appendMessage(sessionId, message);
      }
      break;
    }

    case "session_quest_claimed": {
      handleSessionQuestClaimed(sessionId, data);
      break;
    }

    case "history_sync": {
      const existingMessages = store.messages.get(sessionId) || [];
      const existingFrozenCount = Math.max(
        0,
        Math.min(store.messageFrozenCounts.get(sessionId) ?? 0, existingMessages.length),
      );
      const reusableFrozenCount = Math.max(0, Math.min(existingFrozenCount, data.frozen_base_count));
      const frozenPrefix = reusableFrozenCount > 0 ? existingMessages.slice(0, reusableFrozenCount) : [];
      const preservedToolStateIds = collectRetainedToolUseIds(frozenPrefix);
      snapshotThreadViewportBeforeHistoryReplacement(sessionId);
      resetAuthoritativeHistoryState(sessionId, { preserveToolStateIds: preservedToolStateIds });
      // The replacement just cleared sessionTasks. Forget live-delivery IDs before
      // replaying the authoritative payload so the same TodoWrite can rehydrate it.
      resetTaskExtractionTracking(sessionId);
      const localPreviewSources = collectLocalImagePreviewSources(store, sessionId);
      const { chatMessages: frozenDeltaMessages } = normalizeHistoryMessages(
        sessionId,
        data.frozen_delta,
        data.frozen_base_history_index,
        localPreviewSources,
      );
      const { chatMessages: hotMessages } = normalizeHistoryMessages(
        sessionId,
        data.hot_messages,
        data.frozen_count,
        localPreviewSources,
      );
      // The retained prefix was not normalized again, so restore its IDs only
      // after the changed delta/hot payload had a chance to apply.
      const processed = getProcessedSet(sessionId);
      for (const toolUseId of preservedToolStateIds) processed.add(toolUseId);
      const mergedMessages = [...frozenPrefix, ...frozenDeltaMessages, ...hotMessages];
      const nextFrozenCount = Math.max(
        frozenPrefix.length,
        Math.min(data.frozen_count, frozenPrefix.length + frozenDeltaMessages.length),
      );
      store.setMessages(sessionId, mergedMessages, {
        frozenCount: nextFrozenCount,
        frozenHash: data.expected_frozen_hash,
      });
      reconcileLocalPreviewCopiesWithAuthoritativeMessages(sessionId, [...data.frozen_delta, ...data.hot_messages]);
      clearPendingUploadsCoveredByHistory(sessionId, [...data.frozen_delta, ...data.hot_messages]);
      store.setHistoryWindow(sessionId, null);
      store.markHistoryDelivered(sessionId);
      store.setHistoryLoading(sessionId, false);
      if (mergedMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      resolvePendingMessageScroll(sessionId, mergedMessages);
      break;
    }

    case "history_window_sync": {
      const sourceMessages =
        data.cache_hit === true ? resolveCachedHistoryWindowMessages(sessionId, data.window) : data.messages;
      if (!sourceMessages) {
        requestUncachedHistoryWindow(sessionId, data, deps);
        break;
      }
      resetAuthoritativeHistoryState(sessionId);
      // A window replacement is authoritative for tasks too. Clear live dedup
      // markers before replay so a same-ID TodoWrite is applied after the reset.
      resetTaskExtractionTracking(sessionId);
      const { chatMessages, frozenCount } = normalizeHistoryMessages(
        sessionId,
        sourceMessages,
        data.window.start_index,
      );
      store.setMessages(sessionId, chatMessages, { frozenCount });
      reconcileLocalPreviewCopiesWithAuthoritativeMessages(sessionId, sourceMessages);
      clearPendingUploadsCoveredByHistory(sessionId, sourceMessages);
      store.setHistoryWindow(sessionId, data.window);
      store.markHistoryDelivered(sessionId);
      store.setHistoryLoading(sessionId, false);
      if (chatMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      resolvePendingMessageScroll(sessionId, chatMessages);
      if (data.cache_hit !== true) {
        cacheHistoryWindow(sessionId, data.window, data.messages);
      }
      break;
    }

    case "thread_window_sync": {
      const sourceEntries =
        data.cache_hit === true ? resolveCachedThreadWindowEntries(sessionId, data.window) : data.entries;
      if (!sourceEntries) {
        requestUncachedThreadWindow(sessionId, data, deps);
        break;
      }
      const chatMessages = normalizeThreadWindowEntries(sessionId, sourceEntries);
      store.setThreadWindow(sessionId, data.thread_key, data.window, chatMessages, data.response_state ?? null);
      reconcileLocalPreviewCopiesWithAuthoritativeMessages(
        sessionId,
        sourceEntries.map((entry) => entry.message),
      );
      if (sourceEntries.length > 0) store.setCliEverConnected(sessionId);
      if (store.pendingThreadWindowRequests.get(sessionId) === data.thread_key) {
        store.setPendingThreadWindowRequest(sessionId, null);
      }
      clearPendingUploadsCoveredByHistory(
        sessionId,
        sourceEntries.map((entry) => entry.message),
      );
      if (data.cache_hit !== true) {
        cacheThreadWindow(sessionId, data.window, data.entries);
      }
      break;
    }

    case "leader_projection_snapshot": {
      store.setLeaderProjection(sessionId, data.projection);
      break;
    }
  }
}

export function createWsMessageHandler(deps: WsMessageHandlerDeps) {
  return (sessionId: string, data: BrowserIncomingMessage, context?: WsIncomingMessageContext) => {
    handleParsedMessage(sessionId, data, deps, context);
  };
}
