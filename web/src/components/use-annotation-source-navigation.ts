import { useCallback, useEffect, useRef } from "react";
import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { resolveSessionMessageTarget } from "../api/session-message-search.js";
import { navigateToSessionMessageId } from "../utils/routing.js";
import { useStore } from "../store.js";
import { resolveAnnotationRange } from "./annotation-passages.js";

function sourceElement(sessionId: string, messageId: string, threadKey: string): HTMLElement | undefined {
  const matches: HTMLElement[] = [];
  const surfaces = document.querySelectorAll<HTMLElement>("[data-feed-session-id], [data-annotation-preview-session]");
  for (const surface of surfaces) {
    if ((surface.dataset.feedSessionId ?? surface.dataset.annotationPreviewSession) !== sessionId) continue;
    if (surface.dataset.feedThreadKey && surface.dataset.feedThreadKey !== threadKey) continue;
    const source = Array.from(surface.querySelectorAll<HTMLElement>("[data-message-id]")).find(
      (node) => node.dataset.messageId === messageId,
    );
    if (source) matches.push(source);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function sourcePosition(source: HTMLElement, annotation: ConversationAnnotation) {
  const range = resolveAnnotationRange(source, annotation);
  const rect = range?.getBoundingClientRect?.() ?? source.getBoundingClientRect();
  const feed = source.closest<HTMLElement>("[data-feed-session-id]");
  if (feed) {
    const bounds = feed.getBoundingClientRect();
    const scale = feed.offsetHeight ? bounds.height / feed.offsetHeight || 1 : 1;
    feed.scrollTop += (rect.top - bounds.top - Math.min(100, bounds.height / 4)) / scale;
  } else source.scrollIntoView?.({ block: "center", behavior: "instant" });
  const placed = range?.getBoundingClientRect?.() ?? source.getBoundingClientRect();
  return { position: { x: placed.left, y: placed.bottom + 12 }, sourceUnavailable: !range };
}

/** Use normal bounded-feed navigation, then position the editor beside the verified passage. */
export function useAnnotationSourceNavigation(sessionId: string, threadKey: string) {
  const request = useRef<AbortController | null>(null);
  const editor = useStore((state) => state.annotationEditor);
  const scrollTarget = useStore((state) =>
    state.annotationEditor?.navigateToSource ? state.scrollToMessageId.get(sessionId) : null,
  );
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [sessionId, threadKey],
  );
  useEffect(() => {
    if (!editor?.navigateToSource || editor.sessionId !== sessionId || editor.threadKey !== threadKey || scrollTarget)
      return;
    const source = sourceElement(sessionId, editor.annotation.sourceMessageId!, threadKey);
    useStore.getState().setAnnotationEditor({
      ...editor,
      navigateToSource: false,
      ...(source ? sourcePosition(source, editor.annotation) : { sourceUnavailable: true }),
    });
  }, [editor, scrollTarget, sessionId, threadKey]);
  return useCallback(
    async (annotation: ConversationAnnotation) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const store = useStore.getState();
      const sourceId = annotation.sourceMessageId;
      const source = sourceId ? sourceElement(sessionId, sourceId, threadKey) : undefined;
      if (source?.closest("[data-annotation-preview-session]")) {
        store.setAnnotationEditor({ sessionId, threadKey, annotation, ...sourcePosition(source, annotation) });
        return;
      }
      if (source) {
        store.requestScrollToMessage(sessionId, sourceId!);
        store.setExpandAllInTurn(sessionId, sourceId!);
        store.setAnnotationEditor({ sessionId, threadKey, annotation, navigateToSource: true });
        return;
      }
      try {
        const target = sourceId ? await resolveSessionMessageTarget(sessionId, sourceId, controller.signal) : null;
        if (controller.signal.aborted) return;
        const current = useStore
          .getState()
          .composerDrafts.get(sessionId)
          ?.annotations?.find((item) => item.id === annotation.id);
        if (!current) return;
        annotation = current;
        if (!target) {
          store.setAnnotationEditor({ sessionId, threadKey, annotation, sourceUnavailable: true });
          return;
        }
        navigateToSessionMessageId(sessionId, target.messageId, {
          threadKey: target.threadKey,
          preserveMainThreadRoute: true,
        });
        store.setAnnotationEditor({ sessionId, threadKey: target.threadKey, annotation, navigateToSource: true });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          !useStore
            .getState()
            .composerDrafts.get(sessionId)
            ?.annotations?.some((item) => item.id === annotation.id)
        )
          return;
        console.error("Failed to locate comment source:", error);
        store.setAnnotationEditor({ sessionId, threadKey, annotation, sourceUnavailable: true });
      }
    },
    [sessionId, threadKey],
  );
}
