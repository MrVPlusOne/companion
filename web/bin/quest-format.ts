import type { QuestmasterTask, QuestOwnershipEvent, QuestRecoveryEvent } from "../server/quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "../server/quest-types.js";
import type { SessionMetadata } from "./quest-session-metadata.js";
import { normalizeTldr } from "../server/quest-tldr.js";
import {
  phaseDocumentationPreview,
  summarizeQuestPhaseDocumentation,
  type IndexedQuestFeedbackEntry,
} from "../shared/quest-phase-documentation-summary.js";
import { formatQuestRelationships } from "./quest-relationship-format.js";
import { indexedLiveQuestFeedbackEntries } from "../shared/quest-feedback.js";
export type { SessionMetadata } from "./quest-session-metadata.js";

type FormatSessionOptions = {
  currentSessionId?: string;
  getSessionName?: (sessionId: string) => string | undefined;
  preferSessionNum?: boolean;
};

type FormatQuestOptions = Omit<FormatSessionOptions, "preferSessionNum">;

type QuestDetailSections = {
  description: boolean;
  debrief: boolean;
  metadata: boolean;
  phases: boolean;
  phaseIndexes: Set<number>;
};

type FormatQuestDetailOptions = FormatQuestOptions & {
  full?: boolean;
  sections?: string | string[];
};

const DEFAULT_PHASE_ENTRY_LIMIT = 8;

const STATUS_ICONS: Record<string, string> = {
  idea: "○",
  refined: "●",
  in_progress: "◐",
  done: "✓",
};

const STATUS_LABELS: Record<string, string> = {
  idea: "idea",
  refined: "refined",
  in_progress: "in_progress",
  done: "done",
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isVerificationInboxUnreadQuest(q: QuestmasterTask): boolean {
  return isQuestReviewInboxUnread(q);
}

function questRecencyTs(q: QuestmasterTask): number {
  return Math.max(q.createdAt, (q as { updatedAt?: number }).updatedAt ?? 0, q.statusChangedAt ?? 0);
}

function compactPreview(text: string, maxLen = 180): string {
  const singleLine = text.trim().replace(/\s+/g, " ");
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function indentBody(text: string, indent = "  "): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split("\n").map((line) => `${indent}${line}`);
}

function addIndentedSection(lines: string[], label: string, text: string, bodyIndent = "  "): void {
  const body = indentBody(text, bodyIndent);
  if (!body.length) return;
  lines.push(`${label}:`);
  lines.push(...body);
}

function normalizeDetailSections(value: string | string[] | undefined): QuestDetailSections {
  const sections: QuestDetailSections = {
    description: false,
    debrief: false,
    metadata: false,
    phases: false,
    phaseIndexes: new Set(),
  };
  const rawParts = Array.isArray(value) ? value : value ? value.split(",") : [];
  for (const rawPart of rawParts) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part === "description" || part === "debrief" || part === "metadata" || part === "phases") {
      sections[part] = true;
      continue;
    }
    const phaseMatch = /^phase:(\d+)$/.exec(part);
    if (phaseMatch) {
      sections.phaseIndexes.add(Number(phaseMatch[1]));
      continue;
    }
    throw new Error(
      `Unknown quest show section "${part}". Valid sections: description, debrief, metadata, phases, phase:<index>`,
    );
  }
  return sections;
}

function formatAuthorLabel(
  entry: IndexedQuestFeedbackEntry,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string {
  return entry.authorSessionId
    ? `${entry.author}:${formatSessionLabel(entry.authorSessionId, sessionMetadata, {
        ...options,
        preferSessionNum: true,
      })}`
    : entry.author;
}

function indexedFeedbackEntries(q: QuestmasterTask): IndexedQuestFeedbackEntry[] {
  return indexedLiveQuestFeedbackEntries(q.feedback);
}

function formatFeedbackEntryPreview(
  entry: IndexedQuestFeedbackEntry,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string {
  const authorLabel = formatAuthorLabel(entry, sessionMetadata, options);
  const addressed = entry.addressed ? ", addressed" : "";
  const preview = compactPreview(normalizeTldr(entry.tldr) ?? entry.text, 140);
  return `  #${entry.index} [${authorLabel}${addressed}, ${timeAgo(entry.ts)}] ${preview}`;
}

function formatMetadataLines(
  q: QuestmasterTask,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string[] {
  const lines: string[] = [];
  if (q.tags?.length) {
    lines.push(`Tags:        ${q.tags.join(", ")}`);
  }
  if (q.sessionSpaceSlug) {
    lines.push(`Session Space: ${q.sessionSpaceSlug}`);
  }
  if ("sessionId" in q) {
    const sid = (q as { sessionId: string }).sessionId;
    lines.push(`Session:     ${formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true })}`);
  }
  const leaderSessionId = (q as { leaderSessionId?: string }).leaderSessionId;
  if (leaderSessionId) {
    lines.push(
      `Leader:      ${formatSessionLabel(leaderSessionId, sessionMetadata, { ...options, preferSessionNum: true })}`,
    );
  }
  const previousOwners = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
  if (previousOwners?.length) {
    lines.push(
      `Previous:    ${previousOwners
        .map((sid) => formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true }))
        .join(", ")}`,
    );
  }
  const ownershipEvents = (q as { ownershipEvents?: QuestOwnershipEvent[] }).ownershipEvents;
  if (ownershipEvents?.length) {
    lines.push(`Ownership:   ${ownershipEvents.length} event(s)`);
    for (const event of ownershipEvents.slice(-5)) {
      lines.push(`  - ${formatOwnershipEvent(event, sessionMetadata, options)}`);
    }
  }
  lines.push(...formatRecoveryEventLines(q, sessionMetadata, options));
  if ("claimedAt" in q) {
    lines.push(`Claimed:     ${timeAgo((q as { claimedAt: number }).claimedAt)}`);
  }
  if ("verificationItems" in q) {
    const items = (q as { verificationItems: { text: string; checked: boolean }[] }).verificationItems;
    const checked = items.filter((i) => i.checked).length;
    lines.push(`User review checks: ${checked}/${items.length}`);
    lines.push(
      `Inbox:        ${hasQuestReviewMetadata(q) ? (isVerificationInboxUnreadQuest(q) ? "unread (Review Inbox)" : "acknowledged (under review)") : "n/a"}`,
    );
    for (let i = 0; i < items.length; i++) {
      lines.push(`  [${items[i].checked ? "x" : " "}] ${i}: ${items[i].text}`);
    }
  }
  if (q.commitShas?.length) {
    lines.push(`Code Commits: ${q.commitShas.length}`);
    for (const sha of q.commitShas) lines.push(`  ${sha}`);
  }
  if (q.memoryCommitShas?.length) {
    lines.push(`Memory Commits: ${q.memoryCommitShas.length}`);
    for (const sha of q.memoryCommitShas) lines.push(`  ${sha}`);
  }
  lines.push(...deliverySummaryLines(q, false));
  if (q.quizItems?.length) {
    lines.push(`Quiz Items: ${q.quizItems.length}`);
    lines.push(`  Full: quest quiz show ${q.questId}`);
  }
  lines.push(...formatQuestRelationships(q));
  if (q.images?.length) {
    lines.push(`Images:      ${q.images.length} attached`);
    for (const img of q.images) lines.push(`  ${img.filename} -> ${img.path}`);
  }
  const isCancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  if (isCancelled) lines.push(`Cancelled:   yes`);
  if ("notes" in q && (q as { notes?: string }).notes) {
    lines.push(`Notes:       ${(q as { notes: string }).notes}`);
  }
  if ("completedAt" in q) {
    lines.push(`Completed:   ${timeAgo((q as { completedAt: number }).completedAt)}`);
  }
  lines.push(`Last Active: ${timeAgo(questRecencyTs(q))}`);
  lines.push(`Created:     ${timeAgo(q.createdAt)}`);
  if (q.statusChangedAt && q.statusChangedAt !== q.createdAt) {
    lines.push(`Status:      ${timeAgo(q.statusChangedAt)}`);
  }
  return lines;
}

function formatCompactOwnershipLines(
  q: QuestmasterTask,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string[] {
  const lines: string[] = [];
  if ("sessionId" in q) {
    const sid = (q as { sessionId: string }).sessionId;
    lines.push(`Session:     ${formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true })}`);
  }
  const leaderSessionId = (q as { leaderSessionId?: string }).leaderSessionId;
  if (leaderSessionId) {
    lines.push(
      `Leader:      ${formatSessionLabel(leaderSessionId, sessionMetadata, { ...options, preferSessionNum: true })}`,
    );
  }
  const previousOwners = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
  if (previousOwners?.length) {
    lines.push(
      `Previous:    ${previousOwners
        .map((sid) => formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true }))
        .join(", ")}`,
    );
  }
  return lines;
}

function formatPhaseDocumentationIndex(
  q: QuestmasterTask,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
  mode: "compact" | "phases",
): string[] {
  const phaseDocumentation = summarizeQuestPhaseDocumentation(q);
  const documentedGroups = phaseDocumentation.groups.filter((group) => group.entries.length > 0);
  if (documentedGroups.length === 0) return [];

  const lines: string[] = [`Phase Documentation:`];
  const totalEntries = documentedGroups.reduce((sum, group) => sum + group.entries.length, 0);
  const rows = documentedGroups.flatMap((group) => group.entries.map((entry) => ({ group, entry })));
  const selectedRows = mode === "compact" ? rows.slice(-DEFAULT_PHASE_ENTRY_LIMIT) : rows;
  const selectedByGroup = new Map<string, IndexedQuestFeedbackEntry[]>();
  for (const { group, entry } of selectedRows) {
    selectedByGroup.set(group.key, [...(selectedByGroup.get(group.key) ?? []), entry]);
  }
  for (const group of documentedGroups) {
    const selectedEntries = selectedByGroup.get(group.key);
    if (!selectedEntries?.length) continue;
    const meta = group.metaLabel ? ` [${group.metaLabel}]` : "";
    lines.push(`  ${group.displayLabel}${meta}`);
    for (const entry of selectedEntries) {
      const authorLabel = formatAuthorLabel(entry, sessionMetadata, options);
      const kind = entry.kind ? `, ${entry.kind}` : "";
      const tldr = normalizeTldr(entry.tldr);
      if (mode === "phases" && tldr && tldr.includes("\n")) {
        lines.push(`    #${entry.index} [${authorLabel}${kind}, ${timeAgo(entry.ts)}] TLDR:`);
        lines.push(...indentBody(tldr, "      "));
      } else {
        const preview = tldr
          ? `TLDR: ${mode === "compact" ? compactPreview(tldr, 140) : tldr}`
          : compactPreview(entry.text, 140);
        lines.push(`    #${entry.index} [${authorLabel}${kind}, ${timeAgo(entry.ts)}] ${preview}`);
      }
    }
  }
  if (selectedRows.length < totalEntries) {
    lines.push(
      `  ... showing latest ${selectedRows.length} of ${totalEntries} phase note(s). Reveal all TLDRs with --sections phases.`,
    );
  }
  lines.push(`  Reveal one full phase note with: quest show ${q.questId} --sections phase:<index>`);
  return lines;
}

function formatFullPhaseNote(
  q: QuestmasterTask,
  phaseIndex: number,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string[] {
  const phaseDocumentation = summarizeQuestPhaseDocumentation(q);
  const group = phaseDocumentation.groups.find((candidate) =>
    candidate.entries.some((entry) => entry.index === phaseIndex),
  );
  const entry = group?.entries.find((candidate) => candidate.index === phaseIndex);
  if (!group || !entry) {
    return [`Phase #${phaseIndex}: not found in phase documentation.`];
  }

  const meta = group.metaLabel ? ` [${group.metaLabel}]` : "";
  const authorLabel = formatAuthorLabel(entry, sessionMetadata, options);
  const kind = entry.kind ? `, ${entry.kind}` : "";
  const lines = [
    `Phase #${entry.index}: ${group.displayLabel}${meta}`,
    `  ${authorLabel}${kind}, ${timeAgo(entry.ts)}`,
  ];
  const tldr = normalizeTldr(entry.tldr);
  if (tldr) addIndentedSection(lines, "  TLDR", tldr, "    ");
  addIndentedSection(lines, "  Body", entry.text, "    ");
  return lines;
}

function formatOwnershipEvent(
  event: QuestOwnershipEvent,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string {
  const labelOptions = { ...options, preferSessionNum: true };
  const previous = formatSessionLabel(event.previousOwnerSessionId, sessionMetadata, labelOptions);
  const next = formatSessionLabel(event.newOwnerSessionId, sessionMetadata, labelOptions);
  const actor = formatSessionLabel(event.actorSessionId, sessionMetadata, labelOptions);
  return `${event.operation} ${timeAgo(event.ts)}: ${previous} -> ${next} by ${actor}; reason: ${event.reason}`;
}

function formatRecoveryEventLines(
  q: QuestmasterTask,
  sessionMetadata: Map<string, SessionMetadata> | undefined,
  options: FormatQuestOptions | undefined,
): string[] {
  const events = (q as { recoveryEvents?: QuestRecoveryEvent[] }).recoveryEvents;
  if (!events?.length) return [];
  return [
    `Recovery:    ${events.length} event(s)`,
    ...events.slice(-3).map((event) => {
      const actor = formatSessionLabel(event.actorSessionId, sessionMetadata, { ...options, preferSessionNum: true });
      return (
        `  - ${event.operation} ${timeAgo(event.ts)} by ${actor}; ` +
        `bypassed/unavailable checks: ${event.bypassedChecks.length}; reason: ${event.reason}`
      );
    }),
  ];
}

export function formatSessionLabel(
  sid: string,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatSessionOptions,
): string {
  const metadata = sessionMetadata?.get(sid);
  const name = metadata?.name || options?.getSessionName?.(sid);
  const isYou = options?.currentSessionId === sid;
  const notes = [metadata?.archived ? "archived" : "", isYou ? "you" : ""].filter(Boolean);
  const shortId = sid.slice(0, 8);

  if (options?.preferSessionNum && metadata?.sessionNum != null) {
    const head = `#${metadata.sessionNum}${name ? ` "${name}"` : ""}`;
    return `${head} (${[shortId, ...notes].join(", ")})`;
  }

  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  return name ? `"${name}" (${shortId})${suffix}` : `${shortId}${suffix}`;
}

export function formatQuestLine(
  q: QuestmasterTask,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatQuestOptions,
): string {
  const cancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  const icon = cancelled ? "✗" : STATUS_ICONS[q.status] || "?";
  const tags = q.tags?.length ? `  [${q.tags.join(", ")}]` : "";
  const session = (() => {
    if (!("sessionId" in q)) return "";
    const sid = (q as { sessionId: string }).sessionId;
    return `  → ${formatSessionLabel(sid, sessionMetadata, options)}`;
  })();
  const ownership = (() => {
    const previous = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
    if (!previous?.length) return "";
    return `  [prev:${previous.length}]`;
  })();
  const leader = (() => {
    const sid = (q as { leaderSessionId?: string }).leaderSessionId;
    if (!sid) return "";
    return `  [leader:${formatSessionLabel(sid, sessionMetadata, options)}]`;
  })();
  const statusLabel = (() => {
    if (cancelled) return "cancelled";
    if (isVerificationInboxUnreadQuest(q)) return "review_inbox";
    if (hasQuestReviewMetadata(q)) return "under_review";
    return STATUS_LABELS[q.status] ?? q.status;
  })();
  const pad = (s: string, len: number) => s.padEnd(len);
  return `${icon} ${pad(q.questId, 6)} ${pad(q.title, 36)}${tags}${ownership}${leader}  (${statusLabel}${session})`;
}

export function formatQuestDetail(
  q: QuestmasterTask,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatQuestDetailOptions,
): string {
  if (options?.full) return formatQuestDetailFull(q, sessionMetadata, options);

  const sections = normalizeDetailSections(options?.sections);
  const lines: string[] = [];
  lines.push(`Quest ${q.questId} (rev ${q.version}, ${STATUS_LABELS[q.status] ?? q.status})`);
  lines.push(`Title:       ${q.title}`);
  const tldr = normalizeTldr((q as { tldr?: unknown }).tldr);
  if (tldr) lines.push(`TLDR:        ${tldr}`);

  const description = "description" in q ? q.description?.trim() : undefined;
  if (sections.description && description) {
    addIndentedSection(lines, "Description", description);
  } else if (description) {
    lines.push(`Description: ${compactPreview(description)}`);
  }

  const isCancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  const debrief = q.status === "done" && !isCancelled ? (q as { debrief?: string }).debrief?.trim() : undefined;
  const debriefTldr =
    q.status === "done" && !isCancelled ? normalizeTldr((q as { debriefTldr?: unknown }).debriefTldr) : undefined;
  if (sections.debrief && debrief) {
    if (debriefTldr) addIndentedSection(lines, "Debrief TLDR", debriefTldr);
    addIndentedSection(lines, "Debrief", debrief);
  } else if (debriefTldr) {
    lines.push(`Debrief TLDR: ${compactPreview(debriefTldr)}`);
  } else if (debrief) {
    lines.push(`Debrief:     ${compactPreview(debrief)}`);
  }

  if (!sections.metadata) {
    lines.push(...formatCompactOwnershipLines(q, sessionMetadata, options));
  }

  const unaddressedFeedback = indexedFeedbackEntries(q).filter(
    (entry) => entry.author === "human" && entry.addressed !== true,
  );
  lines.push(`Unaddressed feedback:`);
  if (unaddressedFeedback.length === 0) {
    lines.push(`  none`);
  } else {
    for (const entry of unaddressedFeedback) {
      lines.push(formatFeedbackEntryPreview(entry, sessionMetadata, options));
    }
    lines.push(`  Full feedback: quest feedback show ${q.questId} <index>`);
  }

  if (sections.metadata) {
    lines.push(`Metadata:`);
    lines.push(...formatMetadataLines(q, sessionMetadata, options).map((line) => `  ${line}`));
  }

  lines.push(...formatPhaseDocumentationIndex(q, sessionMetadata, options, sections.phases ? "phases" : "compact"));
  for (const phaseIndex of [...sections.phaseIndexes].sort((a, b) => a - b)) {
    lines.push(...formatFullPhaseNote(q, phaseIndex, sessionMetadata, options));
  }

  const revealSections = ["description", "debrief", "metadata", "phases"].join(",");
  lines.push(`Reveal:      quest show ${q.questId} --sections ${revealSections}`);
  lines.push(`Full detail: quest show ${q.questId} --full  (expensive; prefer --sections first)`);
  return lines.join("\n");
}

function formatQuestDetailFull(
  q: QuestmasterTask,
  sessionMetadata?: Map<string, SessionMetadata>,
  options?: FormatQuestOptions,
): string {
  const lines: string[] = [];
  lines.push(`Warning: --full can consume substantial context. Prefer --sections for targeted detail.`);
  lines.push(`Quest ${q.questId} (rev ${q.version}, ${STATUS_LABELS[q.status] ?? q.status})`);
  lines.push(`Title:       ${q.title}`);
  const tldr = normalizeTldr((q as { tldr?: unknown }).tldr);
  if (tldr) {
    lines.push(`TLDR:        ${tldr}`);
  }
  if ("description" in q && q.description) {
    lines.push(`Description: ${q.description}`);
  }
  const isCancelled = "cancelled" in q && (q as { cancelled?: boolean }).cancelled;
  const debrief = q.status === "done" && !isCancelled ? (q as { debrief?: string }).debrief?.trim() : undefined;
  const debriefTldr =
    q.status === "done" && !isCancelled ? normalizeTldr((q as { debriefTldr?: unknown }).debriefTldr) : undefined;
  if (debriefTldr) {
    lines.push(`Debrief TLDR: ${debriefTldr}`);
  }
  if (debrief) {
    lines.push(`Debrief:     ${debrief}`);
  }
  if (q.tags?.length) {
    lines.push(`Tags:        ${q.tags.join(", ")}`);
  }
  if (q.sessionSpaceSlug) {
    lines.push(`Session Space: ${q.sessionSpaceSlug}`);
  }
  if ("sessionId" in q) {
    const sid = (q as { sessionId: string }).sessionId;
    lines.push(`Session:     ${formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true })}`);
  }
  const leaderSessionId = (q as { leaderSessionId?: string }).leaderSessionId;
  if (leaderSessionId) {
    lines.push(
      `Leader:      ${formatSessionLabel(leaderSessionId, sessionMetadata, { ...options, preferSessionNum: true })}`,
    );
  }
  const previousOwners = (q as { previousOwnerSessionIds?: string[] }).previousOwnerSessionIds;
  if (previousOwners?.length) {
    lines.push(
      `Previous:    ${previousOwners
        .map((sid) => formatSessionLabel(sid, sessionMetadata, { ...options, preferSessionNum: true }))
        .join(", ")}`,
    );
  }
  const ownershipEvents = (q as { ownershipEvents?: QuestOwnershipEvent[] }).ownershipEvents;
  if (ownershipEvents?.length) {
    lines.push(`Ownership:   ${ownershipEvents.length} event(s)`);
    for (const event of ownershipEvents.slice(-5)) {
      lines.push(`  - ${formatOwnershipEvent(event, sessionMetadata, options)}`);
    }
  }
  lines.push(...formatRecoveryEventLines(q, sessionMetadata, options));
  if ("claimedAt" in q) {
    lines.push(`Claimed:     ${timeAgo((q as { claimedAt: number }).claimedAt)}`);
  }
  if ("verificationItems" in q) {
    const items = (q as { verificationItems: { text: string; checked: boolean }[] }).verificationItems;
    const checked = items.filter((i) => i.checked).length;
    lines.push(`User review checks: ${checked}/${items.length}`);
    lines.push(
      `Inbox:        ${hasQuestReviewMetadata(q) ? (isVerificationInboxUnreadQuest(q) ? "unread (Review Inbox)" : "acknowledged (under review)") : "n/a"}`,
    );
    for (let i = 0; i < items.length; i++) {
      lines.push(`  [${items[i].checked ? "x" : " "}] ${i}: ${items[i].text}`);
    }
  }
  if (q.commitShas?.length) {
    lines.push(`Code Commits: ${q.commitShas.length}`);
    for (const sha of q.commitShas) {
      lines.push(`  ${sha}`);
    }
  }
  if (q.memoryCommitShas?.length) {
    lines.push(`Memory Commits: ${q.memoryCommitShas.length}`);
    for (const sha of q.memoryCommitShas) {
      lines.push(`  ${sha}`);
    }
  }
  lines.push(...deliverySummaryLines(q, true));
  if (q.quizItems?.length) {
    lines.push(`Quiz Items: ${q.quizItems.length}`);
    lines.push(`  Full: quest quiz show ${q.questId}`);
  }
  lines.push(...formatQuestRelationships(q));
  const phaseDocumentation = summarizeQuestPhaseDocumentation(q);
  const documentedGroups = phaseDocumentation.groups.filter((group) => group.entries.length > 0);
  if (documentedGroups.length > 0) {
    lines.push(`Phase Documentation:`);
    for (const group of documentedGroups) {
      const meta = group.metaLabel ? ` [${group.metaLabel}]` : "";
      lines.push(`  ${group.displayLabel}${meta}`);
      for (const entry of group.entries) {
        const authorLabel = entry.authorSessionId
          ? `${entry.author}:${formatSessionLabel(entry.authorSessionId, sessionMetadata, {
              ...options,
              preferSessionNum: true,
            })}`
          : entry.author;
        const kind = entry.kind ? `, ${entry.kind}` : "";
        const preview = normalizeTldr(entry.tldr)
          ? `TLDR: ${normalizeTldr(entry.tldr)}`
          : compactPreview(phaseDocumentationPreview(entry));
        lines.push(`    #${entry.index} [${authorLabel}${kind}, ${timeAgo(entry.ts)}] ${preview}`);
        lines.push(`      Full: quest feedback show ${q.questId} ${entry.index}`);
      }
    }
  }
  if ("feedback" in q) {
    const rawEntries = indexedFeedbackEntries(q);
    const entries = phaseDocumentation.hasPhaseDocumentation ? phaseDocumentation.unscopedFeedback : rawEntries;
    if (entries?.length) {
      lines.push(phaseDocumentation.hasPhaseDocumentation ? `Unscoped Feedback:` : `Feedback:`);
      for (const entry of entries) {
        const authorLabel = entry.authorSessionId
          ? `${entry.author}:${formatSessionLabel(entry.authorSessionId, sessionMetadata, {
              ...options,
              preferSessionNum: true,
            })}`
          : entry.author;
        const tag = entry.addressed
          ? `${authorLabel}, addressed, ${timeAgo(entry.ts)}`
          : `${authorLabel}, ${timeAgo(entry.ts)}`;
        const phaseLabel = entry.phaseId
          ? ` (${entry.phaseId}${entry.phasePosition ? `@${entry.phasePosition}` : ""})`
          : "";
        const entryTldr = normalizeTldr(entry.tldr);
        lines.push(`  #${entry.index} [${tag}]${phaseLabel} ${entryTldr ? `TLDR: ${entryTldr}` : entry.text}`);
        if (entryTldr) {
          lines.push(`    Full: ${entry.text}`);
        }
        if (entry.images?.length) {
          for (const img of entry.images) {
            lines.push(`    ${img.filename} → ${img.path}`);
          }
        }
      }
    }
  }
  if (q.images?.length) {
    lines.push(`Images:      ${q.images.length} attached`);
    for (const img of q.images) {
      lines.push(`  ${img.filename} → ${img.path}`);
    }
  }
  if (isCancelled) {
    lines.push(`Cancelled:   yes`);
  }
  if ("notes" in q && (q as { notes?: string }).notes) {
    lines.push(`Notes:       ${(q as { notes: string }).notes}`);
  }
  if ("completedAt" in q) {
    lines.push(`Completed:   ${timeAgo((q as { completedAt: number }).completedAt)}`);
  }
  lines.push(`Last Active: ${timeAgo(questRecencyTs(q))}`);
  lines.push(`Created:     ${timeAgo(q.createdAt)}`);
  if (q.statusChangedAt && q.statusChangedAt !== q.createdAt) {
    lines.push(`Status:      ${timeAgo(q.statusChangedAt)}`);
  }
  return lines.join("\n");
}

function deliverySummaryLines(quest: QuestmasterTask, full: boolean): string[] {
  const deliveries = quest.codeDeliveries ?? [];
  if (!deliveries.length) return [];
  const visible = full ? deliveries : deliveries.slice(-5);
  return [
    `Code Deliveries: ${deliveries.length}${visible.length < deliveries.length ? " (latest 5; --full reveals all IDs)" : ""}`,
    ...visible.map((delivery) => `  ${delivery.id}: ${delivery.commits.length} commits -> ${delivery.target.branch}`),
    `  Author: quest commit-links ${quest.questId} --delivery <id>`,
  ];
}
