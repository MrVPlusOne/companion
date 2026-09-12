import type { BrowserOutgoingMessage } from "../session-types.js";
import type { ImageRef } from "../image-store.js";
import type { BrowserUserMessage } from "./adapter-browser-routing-message-types.js";
import { deriveAttachmentPaths, formatAttachmentPathAnnotation } from "../attachment-paths.js";
import { formatAnnotatedMessage, readConversationAnnotations } from "../../shared/conversation-annotations.js";
import { formatReplyContentForAssistant } from "../../shared/reply-context.js";

/** Compile structured annotations before server-owned delivery preludes are attached. */
export function prepareAnnotatedUserMessage(sessionId: string, message: BrowserUserMessage): BrowserUserMessage {
  if (message.annotations === undefined) return message;
  const annotations = readConversationAnnotations(message.annotations);
  if (!annotations.length) return { ...message, annotations };
  return {
    ...message,
    annotations,
    deliveryContent:
      formatReplyContentForAssistant(formatAnnotatedMessage(message.content, annotations), message.replyContext) +
      formatAttachmentPathAnnotation(deriveAttachmentPaths(sessionId, message.imageRefs ?? [])),
  };
}

export function normalizeAdapterUserMessage(
  session: { id: string },
  msg: BrowserUserMessage,
  userImageRefs: ImageRef[] | undefined,
): BrowserOutgoingMessage | null {
  let adapterMsg: BrowserOutgoingMessage = msg.takodeHerdBatch
    ? (({ takodeHerdBatch: _takodeHerdBatch, ...rest }) => rest)(msg)
    : msg;
  if (typeof msg.deliveryContent === "string") {
    const delivered = { ...adapterMsg, content: msg.deliveryContent } as BrowserOutgoingMessage;
    delete (delivered as { deliveryContent?: unknown }).deliveryContent;
    delete (delivered as { historyFollowUps?: unknown }).historyFollowUps;
    delete (delivered as { draftImages?: unknown }).draftImages;
    delete (delivered as { imageRefs?: unknown }).imageRefs;
    delete (delivered as { images?: unknown }).images;
    delete (delivered as { autoPauseSourceKind?: unknown }).autoPauseSourceKind;
    delete (delivered as { autoPauseRecoveries?: unknown }).autoPauseRecoveries;
    return delivered;
  }
  const resolvedImageRefs = userImageRefs ?? msg.imageRefs;
  if (!resolvedImageRefs?.length) {
    const stripped = { ...adapterMsg } as BrowserOutgoingMessage;
    delete (stripped as { historyFollowUps?: unknown }).historyFollowUps;
    delete (stripped as { autoPauseSourceKind?: unknown }).autoPauseSourceKind;
    delete (stripped as { autoPauseRecoveries?: unknown }).autoPauseRecoveries;
    return stripped;
  }
  let annotatedContent = msg.content || "";
  const resolvedPaths = deriveAttachmentPaths(session.id, resolvedImageRefs);
  if (resolvedPaths.length > 0) {
    annotatedContent += formatAttachmentPathAnnotation(resolvedPaths);
  }
  adapterMsg = { ...msg, content: annotatedContent } as BrowserOutgoingMessage;
  const stripped = { ...adapterMsg, content: annotatedContent } as BrowserOutgoingMessage;
  delete (stripped as { deliveryContent?: unknown }).deliveryContent;
  delete (stripped as { historyFollowUps?: unknown }).historyFollowUps;
  delete (stripped as { draftImages?: unknown }).draftImages;
  delete (stripped as { imageRefs?: unknown }).imageRefs;
  delete (stripped as { images?: unknown }).images;
  delete (stripped as { autoPauseSourceKind?: unknown }).autoPauseSourceKind;
  delete (stripped as { autoPauseRecoveries?: unknown }).autoPauseRecoveries;
  return stripped;
}
