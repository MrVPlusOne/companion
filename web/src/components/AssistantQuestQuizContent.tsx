import { useEffect, useMemo } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { QuestmasterTask } from "../types.js";
import { MarkdownContent } from "./MarkdownContent.js";
import type { QuestLinkSurface } from "./quest-link-surface.js";
import { QuestQuizSection } from "./QuestQuizSection.js";

const QUEST_QUIZ_DIRECTIVE_RE = /^\s*\{\[\(Quest Quiz:\s*(q-\d+)\)\]\}\s*$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

export type AssistantQuestQuizSegment = { kind: "text"; text: string } | { kind: "quiz"; questId: string };

const questQuizDetailFetches = new Map<string, Promise<void>>();
const resolvedEmptyQuestQuizDetailKeys = new Set<string>();

interface AssistantQuestQuizContentProps {
  text: string;
  sessionId?: string;
  searchHighlight?: { query: string; mode: "strict" | "fuzzy"; isCurrent: boolean } | null;
  enableChatSelectionMenu?: boolean;
  questLinkSurface?: QuestLinkSurface;
}

export function stripQuestQuizMarkers(text: string, shouldStrip?: (questId: string) => boolean): string {
  const segments = parseQuestQuizContentSegments(text);
  const isStrippedQuiz = (segment: AssistantQuestQuizSegment) =>
    segment.kind === "quiz" && (!shouldStrip || shouldStrip(segment.questId));
  if (!segments.some(isStrippedQuiz)) return text;
  return segments
    .filter((segment) => !isStrippedQuiz(segment))
    .map((segment) => (segment.kind === "text" ? segment.text : `{[(Quest Quiz: ${segment.questId})]}`))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractQuestQuizMarkerIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const segment of parseQuestQuizContentSegments(text)) {
    if (segment.kind !== "quiz" || seen.has(segment.questId)) continue;
    seen.add(segment.questId);
    ids.push(segment.questId);
  }
  return ids;
}

function normalizeQuestQuizText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function readFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = line.match(FENCE_RE);
  if (!match) return null;
  const token = match[1];
  return { marker: token[0] as "`" | "~", length: token.length };
}

export function parseQuestQuizContentSegments(text: string): AssistantQuestQuizSegment[] {
  const segments: AssistantQuestQuizSegment[] = [];
  const textLines: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  const flushText = () => {
    const visibleText = normalizeQuestQuizText(textLines.join("\n"));
    textLines.length = 0;
    if (visibleText) segments.push({ kind: "text", text: visibleText });
  };

  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      textLines.push(line);
      const closingFence = readFence(line);
      if (closingFence && closingFence.marker === fence.marker && closingFence.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const openingFence = readFence(line);
    if (openingFence) {
      fence = openingFence;
      textLines.push(line);
      continue;
    }

    const directive = line.match(QUEST_QUIZ_DIRECTIVE_RE);
    if (directive) {
      flushText();
      segments.push({ kind: "quiz", questId: directive[1].toLowerCase() });
      continue;
    }

    textLines.push(line);
  }

  flushText();
  return segments;
}

function findQuest(quests: QuestmasterTask[], questId: string): QuestmasterTask | null {
  const normalizedQuestId = questId.toLowerCase();
  return quests.find((quest) => quest.questId.toLowerCase() === normalizedQuestId) ?? null;
}

function quizItemsCount(quest: QuestmasterTask | null | undefined): number {
  return quest?.quizItems?.length ?? 0;
}

function questDetailFetchKey(questId: string, etag: string | null | undefined): string {
  return questId.toLowerCase() + ":" + (etag ?? "no-etag");
}

function fetchQuestDetailForQuizDirective(questId: string): Promise<void> {
  const normalizedQuestId = questId.toLowerCase();
  const state = useStore.getState();
  const currentEtag = state.questDetailEtags.get(normalizedQuestId) ?? null;
  const fetchKey = questDetailFetchKey(normalizedQuestId, currentEtag);
  if (resolvedEmptyQuestQuizDetailKeys.has(fetchKey)) return Promise.resolve();

  const existing = questQuizDetailFetches.get(fetchKey);
  if (existing) return existing;

  const fetchPromise = api
    .getQuestValidated(normalizedQuestId, currentEtag)
    .then((result) => {
      if (result.status === "fresh") {
        useStore.getState().upsertQuestDetail(result.data, { etag: result.etag });
        if (quizItemsCount(result.data) === 0) {
          resolvedEmptyQuestQuizDetailKeys.add(questDetailFetchKey(normalizedQuestId, result.etag));
        }
        return;
      }

      resolvedEmptyQuestQuizDetailKeys.add(fetchKey);
    })
    .catch(() => {
      resolvedEmptyQuestQuizDetailKeys.add(fetchKey);
    })
    .finally(() => {
      if (questQuizDetailFetches.get(fetchKey) === fetchPromise) {
        questQuizDetailFetches.delete(fetchKey);
      }
    });

  questQuizDetailFetches.set(fetchKey, fetchPromise);
  return fetchPromise;
}

function findRenderableQuest(
  questDetails: Map<string, QuestmasterTask>,
  quests: QuestmasterTask[],
  questId: string,
): QuestmasterTask | null {
  const normalizedQuestId = questId.toLowerCase();
  return questDetails.get(normalizedQuestId) ?? findQuest(quests, normalizedQuestId);
}

function uniqueQuestQuizIds(segments: AssistantQuestQuizSegment[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== "quiz" || seen.has(segment.questId)) continue;
    seen.add(segment.questId);
    ids.push(segment.questId);
  }
  return ids;
}

export function AssistantQuestQuizContent({
  text,
  sessionId,
  searchHighlight,
  enableChatSelectionMenu = false,
  questLinkSurface = "legacy",
}: AssistantQuestQuizContentProps) {
  const segments = useMemo(() => parseQuestQuizContentSegments(text), [text]);
  const quests = useStore((state) => state.quests);
  const questDetails = useStore((state) => state.questDetails);
  const questDetailEtags = useStore((state) => state.questDetailEtags);
  const quizQuestIds = useMemo(() => uniqueQuestQuizIds(segments), [segments]);

  useEffect(() => {
    for (const questId of quizQuestIds) {
      const quest = findRenderableQuest(questDetails, quests, questId);
      if (quizItemsCount(quest) > 0) continue;

      const fetchKey = questDetailFetchKey(questId, questDetailEtags.get(questId.toLowerCase()) ?? null);
      if (resolvedEmptyQuestQuizDetailKeys.has(fetchKey) || questQuizDetailFetches.has(fetchKey)) continue;

      void fetchQuestDetailForQuizDirective(questId);
    }
  }, [questDetailEtags, questDetails, quizQuestIds, quests]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <MarkdownContent
              key={`text-${index}`}
              text={segment.text}
              sessionId={sessionId}
              searchHighlight={searchHighlight}
              enableChatSelectionMenu={enableChatSelectionMenu}
              questLinkSurface={questLinkSurface}
            />
          );
        }

        const quest = findRenderableQuest(questDetails, quests, segment.questId);
        if (!quest || (quest.quizItems?.length ?? 0) === 0) return null;
        return (
          <QuestQuizSection
            key={`quiz-${segment.questId}-${index}`}
            items={quest.quizItems}
            questId={quest.questId}
            questTitle={quest.title}
            variant="inline"
            sessionId={sessionId}
            questLinkSurface={questLinkSurface}
          />
        );
      })}
    </>
  );
}
