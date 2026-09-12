import { formatAnnotatedMessage } from "../../shared/conversation-annotations.js";
import { useCallback, useMemo, useState, type MouseEvent, type RefObject } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ChatMessage, ComposerDraftImage, SdkSessionInfo } from "../types.js";
import { copyRichText, getMessageMarkdown, getMessagePlainText, writeClipboardText } from "../utils/copy-utils.js";
import { generateReplyPreview } from "../utils/reply-preview.js";
import { absoluteUrlForHash, routeSessionRefForId, sessionMessageHash } from "../utils/routing.js";
import { createComposerDraftImage } from "./composer-image-utils.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { MessageTimeMenuMetadata, MessageTimestampMenuTrigger } from "./MessageRailTimestamp.js";
import { useSideChatActionState } from "./SideChatControls.js";
import { useMessageStarActions } from "./use-message-star-actions.js";

function buildCopyMessageLink(sessionId: string | undefined, message: ChatMessage, sdkSessions: SdkSessionInfo[]) {
  if (!sessionId) return null;
  const messageIndex =
    message.historyIndex ??
    useStore
      .getState()
      .messages.get(sessionId)
      ?.findIndex((msg) => msg.id === message.id) ??
    -1;
  if (messageIndex < 0) return null;
  const sessionRef = routeSessionRefForId(sessionId, sdkSessions);
  return absoluteUrlForHash(sessionMessageHash(sessionRef, messageIndex));
}

function buildDraftImageName(mediaType: string, index: number): string {
  const ext = mediaType.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "bin";
  return `attachment-${index + 1}.${ext}`;
}

async function restoreMessageImagesToDraft(
  sessionId: string,
  images: NonNullable<ChatMessage["images"]>,
): Promise<ComposerDraftImage[]> {
  const restored = await Promise.all(
    images.map(async (img, idx) => {
      const res = await fetch(`/api/images/${encodeURIComponent(sessionId)}/${encodeURIComponent(img.imageId)}/full`);
      if (!res.ok) throw new Error(`Failed to fetch image ${img.imageId}: ${res.statusText}`);
      const blob = await res.blob();
      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        ...createComposerDraftImage(
          {
            name: buildDraftImageName(img.media_type, idx),
            base64: btoa(binary),
            mediaType: blob.type || img.media_type,
          },
          { status: "uploading" },
        ),
      };
    }),
  );
  return restored;
}

export function UserMessageMenu({
  message,
  sessionId,
  canRevert,
}: {
  message: ChatMessage;
  sessionId?: string;
  canRevert: boolean;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const starAction = useMessageStarActions(sessionId, message);

  const showCopied = useCallback(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const handleCopy = useCallback(() => {
    writeClipboardText(formatAnnotatedMessage(message.content, message.metadata?.annotations))
      .then(showCopied)
      .catch(console.error);
  }, [message.content, message.metadata?.annotations, showCopied]);

  const handleCopyLink = useCallback(() => {
    const link = buildCopyMessageLink(sessionId, message, sdkSessions);
    if (!link) return;
    writeClipboardText(link).then(showCopied).catch(console.error);
  }, [message, sdkSessions, sessionId, showCopied]);

  const handleRevert = useCallback(async () => {
    if (!sessionId || !message.id) return;
    try {
      await api.revertToMessage(sessionId, message.id);
      const store = useStore.getState();
      store.setComposerDraft(sessionId, {
        text: message.content,
        images: [],
        annotations: message.metadata?.annotations,
      });
      if (message.images?.length) {
        try {
          const images = await restoreMessageImagesToDraft(sessionId, message.images);
          store.setComposerDraft(sessionId, {
            text: message.content,
            images,
            annotations: message.metadata?.annotations,
          });
        } catch (imageErr) {
          console.error("Failed to restore images after revert:", imageErr);
        }
      }
    } catch (err) {
      console.error("Revert failed:", err);
    }
  }, [sessionId, message.id, message.content, message.images, message.metadata?.annotations]);

  const toggle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (menuPos) {
        setMenuPos(null);
      } else {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPos({ x: rect.left, y: rect.bottom + 4 });
      }
    },
    [menuPos],
  );

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [{ label: "Copy message", onClick: handleCopy }];
    if (sessionId) list.push({ label: "Copy message link", onClick: handleCopyLink });
    if (starAction.actionable) list.push({ label: starAction.label, onClick: starAction.toggleStarred });
    if (canRevert) {
      list.push({
        label: "Revert to here",
        onClick: handleRevert,
        confirm: {
          title: "Revert to here?",
          description: "All messages after this point will be removed.",
          confirmLabel: "Revert",
          destructive: true,
        },
      });
    }
    return list;
  }, [canRevert, handleCopy, handleCopyLink, handleRevert, sessionId, starAction]);

  return (
    <div className="shrink-0 self-start mt-1">
      <MessageTimestampMenuTrigger
        timestamp={message.timestamp}
        testId="message-time-user-menu"
        ariaLabel="Message options"
        title="Message options"
        onClick={toggle}
        className={`rounded p-1 transition-all cursor-pointer hover:bg-cc-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-cc-primary/40 ${
          menuPos || copied
            ? "opacity-100"
            : "opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 sm:group-focus-within/msg:opacity-100"
        }`}
      >
        {copied ? (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5 text-cc-success"
          >
            <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted">
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
          </svg>
        )}
      </MessageTimestampMenuTrigger>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={items}
          onClose={() => setMenuPos(null)}
          footer={<MessageTimeMenuMetadata timestamp={message.timestamp} testId="message-time-user-menu-metadata" />}
          widthClassName="w-[248px] max-w-[calc(100vw-1rem)]"
        />
      )}
    </div>
  );
}

export function AssistantMessageMenu({
  message,
  contentRef,
  sessionId,
  currentThreadKey,
  showSideChatActions,
}: {
  message: ChatMessage;
  contentRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  currentThreadKey?: string;
  showSideChatActions: boolean;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const starAction = useMessageStarActions(sessionId, message);
  const sideChatAction = useSideChatActionState({
    currentThreadKey,
    message,
    sessionId: sessionId ?? "",
  });

  const showFeedback = useCallback((label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const handleCopyMarkdown = useCallback(() => {
    writeClipboardText(getMessageMarkdown(message))
      .then(() => showFeedback("Markdown"))
      .catch(console.error);
  }, [message, showFeedback]);

  const handleCopyPlainText = useCallback(() => {
    writeClipboardText(getMessagePlainText(message))
      .then(() => showFeedback("Plain text"))
      .catch(console.error);
  }, [message, showFeedback]);

  const handleCopyRichText = useCallback(() => {
    copyRichText(contentRef.current?.innerHTML ?? "", getMessagePlainText(message))
      .then(() => showFeedback("Rich text"))
      .catch(console.error);
  }, [message, contentRef, showFeedback]);

  const handleCopyLink = useCallback(() => {
    const link = buildCopyMessageLink(sessionId, message, sdkSessions);
    if (!link) return;
    writeClipboardText(link)
      .then(() => showFeedback("Link"))
      .catch(console.error);
  }, [message, sdkSessions, sessionId, showFeedback]);

  const handleReply = useCallback(() => {
    if (!sessionId) return;
    const store = useStore.getState();
    const allMessages = store.messages.get(sessionId) ?? [];
    const otherContents = allMessages
      .filter((m) => m.role === "assistant" && m.id !== message.id)
      .map((m) => m.content);
    const previewText = generateReplyPreview(message.content, otherContents);
    store.setReplyContext(sessionId, { messageId: message.id, previewText });
  }, [message, sessionId]);

  const toggle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (menuPos) {
        setMenuPos(null);
      } else {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPos({ x: rect.left, y: rect.bottom + 4 });
      }
    },
    [menuPos],
  );

  const items = useMemo<ContextMenuItem[]>(() => {
    const list: ContextMenuItem[] = [];
    if (showSideChatActions && sessionId && sideChatAction.available) {
      if (sideChatAction.sideChat) {
        list.push({
          label: `Open Side Chat (${sideChatAction.sideChat.messageCount ?? 0})`,
          onClick: sideChatAction.handleClick,
        });
      } else if (sideChatAction.nativeReady) {
        list.push({
          label: sideChatAction.creating ? "Starting Side Chat..." : "Start Side Chat",
          onClick: sideChatAction.handleClick,
          disabled: sideChatAction.creating,
        });
      } else {
        list.push({
          label: sideChatAction.unavailableDetail ?? sideChatAction.nativeReason,
          onClick: () => {},
          disabled: true,
        });
        if (sideChatAction.preflight?.fallback.available) {
          list.push({
            label: sideChatAction.fallbackConfirming ? "Confirm replay Side Chat" : "Replay Side Chat",
            onClick: sideChatAction.handleFallbackClick,
            disabled: sideChatAction.creating,
          });
        }
      }
    }
    if (sessionId) list.push({ label: "Reply to this message", onClick: handleReply });
    if (starAction.actionable) list.push({ label: starAction.label, onClick: starAction.toggleStarred });
    list.push(
      { label: "Copy as Markdown", onClick: handleCopyMarkdown },
      { label: "Copy as Rich Text", onClick: handleCopyRichText },
      { label: "Copy as Plain Text", onClick: handleCopyPlainText },
    );
    if (sessionId) list.push({ label: "Copy message link", onClick: handleCopyLink });
    return list;
  }, [
    handleCopyLink,
    handleCopyMarkdown,
    handleCopyPlainText,
    handleCopyRichText,
    handleReply,
    sessionId,
    showSideChatActions,
    sideChatAction,
    starAction,
  ]);

  return (
    <>
      <span
        className="float-right mb-0.5 ml-1 inline-flex opacity-100 transition-opacity sm:opacity-0 sm:group-hover/msg:opacity-100 sm:group-focus-within/msg:opacity-100"
        data-message-action-menu-placement="first-line"
        data-message-action-menu-row
      >
        <MessageTimestampMenuTrigger
          timestamp={message.timestamp}
          testId="message-time-assistant-menu"
          onClick={toggle}
          className="inline-flex h-6 w-6 touch-manipulation items-center justify-center rounded-md border border-cc-border bg-cc-card/80 text-cc-muted shadow-sm transition-colors hover:bg-cc-hover hover:text-cc-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-cc-primary/40"
          title="Message options"
          ariaLabel="Message options"
        >
          {copied ? (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-3.5 w-3.5 text-cc-success"
            >
              <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="13" cy="8" r="1.5" />
            </svg>
          )}
        </MessageTimestampMenuTrigger>
      </span>
      {menuPos && (
        <ContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={items}
          onClose={() => setMenuPos(null)}
          footer={
            <MessageTimeMenuMetadata timestamp={message.timestamp} testId="message-time-assistant-menu-metadata" />
          }
          widthClassName="w-[248px] max-w-[calc(100vw-1rem)]"
        />
      )}
    </>
  );
}
