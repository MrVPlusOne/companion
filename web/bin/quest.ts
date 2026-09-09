#!/usr/bin/env bun
/**
 * Questmaster CLI — standalone tool for managing quests.
 *
 * Imports quest-store.ts directly (no HTTP for data operations).
 * After mutations, notifies the Companion server so browsers refresh.
 *
 * Usage:  quest <command> [options]
 *
 * Commands:
 *   list       List all quests (latest versions)
 *   mine       List quests owned by current session
 *   show       Show compact quest detail with progressive reveal
 *   status     Show compact action-oriented quest status
 *   history    Show quest history (live or legacy backup)
 *   create     Create a new quest
 *   claim      Claim a quest for a session
 *   complete   Mark done and enter review inbox with checklist
 *   done       Mark quest as done
 *   cancel     Cancel a quest from any status
 *   transition Generic status transition
 *   edit       In-place edit (no new version)
 *   later      Move review-pending quest out of review inbox
 *   inbox      Move review-pending quest back to review inbox
 *   check      Toggle a verification checkbox
 *   feedback   Add, edit, or inspect quest feedback entries
 *   outcome    Inspect preserved legacy Quest Outcome data
 *   quiz       Show or replace quest quiz Q/A metadata
 *   address    Toggle feedback addressed status
 *   reassign   Reassign quest ownership from a leader session
 *   delete     Delete a quest
 *   resize-image  Resize an image to fit within a max pixel dimension
 *   optimize-image  Write an optimized .takode-agent sibling image
 */

import {
  listQuests,
  getQuest,
  getQuestHistoryView,
  createQuest,
  completeQuest,
  markDone,
  cancelQuest,
  transitionQuest,
  patchQuest,
  patchQuestForOwner,
  checkVerificationItem,
  markQuestVerificationRead,
  markQuestVerificationInboxUnread,
  deleteQuest,
  cancelQuestForOwner,
} from "../server/quest-store.js";
import type { QuestmasterTask } from "../server/quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "../server/quest-types.js";
import { applyQuestListFilters } from "../server/quest-list-filters.js";
import { grepQuests } from "../server/quest-grep.js";
import { getName } from "../server/session-names.js";
import { formatQuestLine, formatSessionLabel } from "./quest-format.js";
import { parseCommitShas } from "./quest-commit-flags.js";
import {
  normalizeTldr,
  preferredFeedbackPreview,
  tldrWarningsForContent,
  QUEST_TLDR_WARNING_HEADER,
} from "../server/quest-tldr.js";
import { QUEST_PHASE_DOCUMENTATION_WARNING_HEADER } from "../server/quest-phase-docs.js";
import {
  compactPhaseDocumentationGroups,
  phaseDocumentationPreview,
  summarizeQuestPhaseDocumentation,
} from "../shared/quest-phase-documentation-summary.js";
import {
  completionHygieneWarnings,
  feedbackAddWarnings,
  filterFeedbackEntries,
  formatFeedbackIndices,
  isAgentSummaryFeedback,
  latestFeedbackEntry,
  questFeedbackEntries,
  unaddressedHumanFeedbackEntries,
  type FeedbackAuthorFilter,
  type IndexedFeedbackEntry,
} from "./quest-feedback.js";
import { showHelp } from "./quest-help.js";
import { runOptimizeImageCommand, runResizeImageCommand } from "./quest-image.js";
import { runHistoryCommand } from "./quest-history-command.js";
import { parseRelationshipFlags } from "./quest-relationship-flags.js";
import { fetchSessionMetadataMap, type SessionMetadata } from "./quest-session-metadata.js";
import { runCommitLinksCommand } from "./quest-commit-links.js";
import { runShowCommand } from "./quest-show-command.js";
import { runTagsCommand } from "./quest-tags-command.js";
import { runQuizCommand } from "./quest-quiz.js";
import { runClaimCommand, runReassignCommand } from "./quest-ownership-command.js";
import { parseCommaSeparatedTags } from "./quest-tag-options.js";
import { runFeedbackEditCommand } from "./quest-feedback-edit-command.js";
import {
  guardLocalQuestStatusMutation,
  parseQuestStatusMutationOverride,
  postQuestStatusMutation,
} from "./quest-status-mutation.js";
import { COMPANION_MEMORY_SPACE_SLUG_ENV } from "../server/memory-session-space.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getQuestDisplayOwner, getQuestOwner, sameQuestOwner } from "../shared/quest-owner.js";
import { isDeletedQuestFeedbackEntry } from "../shared/quest-feedback.js";
import {
  codexQuestOwner,
  codexQuestProvenance,
  getCodexQuestInvocationContext,
  hasManagedCompanionIdentity,
  isQuestServerExecution,
} from "./quest-codex-invocation.js";
import {
  isQuestMutationCommand,
  questCommandPositionals,
  questCommandReadsStdin,
} from "../shared/quest-command-classification.js";
import { runCodexQuestCommandRpc } from "./quest-codex-rpc.js";
import {
  addCodexQuestFeedback,
  editCodexQuestFeedback,
  setCodexQuestQuiz,
  toggleCodexQuestFeedbackAddressed,
} from "./quest-codex-local.js";
import { discoverQuestCompanionCredentials, type CompanionCredentials } from "./quest-companion-credentials.js";
import { saveQuestInputImage, uploadQuestInputImage } from "./quest-image-input.js";
import { formatQuestStatusSummary, questStatusSummaryForJson } from "./quest-status-format.js";
import { runQuestOutcomeCommand } from "./quest-outcome-command.js";

const DEFAULT_PORT = 3456;
const COMPANION_SESSION_ID_HEADER = "x-companion-session-id";
const COMPANION_AUTH_TOKEN_HEADER = "x-companion-auth-token";

// ─── Arg parsing helpers ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const positionalArgs = questCommandPositionals(args);
const codexInvocation = getCodexQuestInvocationContext();
const questServerExecution = isQuestServerExecution();
const managedCompanionIdentity = hasManagedCompanionIdentity();
const directCodexExecution = !!codexInvocation && questServerExecution && !managedCompanionIdentity;

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}

function options(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
}

/** Get positional arg at index (0-based, after the command). */
function positional(index: number): string | undefined {
  return positionalArgs[index];
}

/**
 * Validate that all --flags in args are from the allowed set.
 * Rejects unknown flags with a helpful error message and "did you mean?" suggestions.
 */
function validateFlags(allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (allowedSet.has(name)) continue;

    // Find close matches for "did you mean?" suggestion
    const suggestions = allowed.filter((a) => {
      // Shared prefix of >= 3 chars
      if (a.startsWith(name.slice(0, 3)) || name.startsWith(a.slice(0, 3))) return true;
      // One contains the other
      if (a.includes(name) || name.includes(a)) return true;
      return false;
    });

    let msg = `Unknown flag: --${name}`;
    if (suggestions.length > 0) {
      msg += `. Did you mean: ${suggestions.map((s) => `--${s}`).join(", ")}?`;
    }
    msg += `\nValid flags: ${allowed.map((f) => `--${f}`).join(", ")}`;
    die(msg);
  }
}

const jsonOutput = flag("json");

// ─── Companion auth discovery ──────────────────────────────────────────────

/** Discover session credentials from env vars or session-auth file fallback. */
function getCredentials(): CompanionCredentials | null {
  return discoverQuestCompanionCredentials({
    cwd: process.cwd(),
    skipFileDiscovery: !!codexInvocation,
    fail: die,
  });
}

function getCurrentSessionId(): string | undefined {
  if (managedCompanionIdentity) return process.env.COMPANION_SESSION_ID?.trim() || undefined;
  if (codexInvocation) return codexInvocation.sessionId;
  return getCredentials()?.sessionId || process.env.COMPANION_SESSION_ID || undefined;
}

function getCompanionPort(): string | undefined {
  if (codexInvocation && !managedCompanionIdentity) return undefined;
  if (process.env.COMPANION_PORT) return process.env.COMPANION_PORT;
  const creds = getCredentials();
  const credsPort = creds?.port;
  if (typeof credsPort === "number" && credsPort > 0) return String(credsPort);
  return creds ? String(DEFAULT_PORT) : undefined;
}

function companionAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const creds = getCredentials();
  if (!creds) return extra;
  return {
    [COMPANION_SESSION_ID_HEADER]: creds.sessionId,
    [COMPANION_AUTH_TOKEN_HEADER]: creds.authToken,
    ...extra,
  };
}

// ─── Server notification ────────────────────────────────────────────────────

async function notifyServer(): Promise<void> {
  if (directCodexExecution) return;
  const port = getCompanionPort();
  if (!port) return;
  try {
    await fetch(`http://localhost:${port}/api/quests/_notify`, {
      method: "POST",
      headers: companionAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best effort — server may not be running
  }
}

// ─── Output helpers ─────────────────────────────────────────────────────────

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function compactSnippet(text: string, maxLen: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), maxLen);
}

function formatPhaseScopeLabel(match: {
  phaseId?: string;
  phasePosition?: number;
  phaseOccurrence?: number;
  phaseOccurrenceId?: string;
  journeyRunId?: string;
}): string | null {
  if (!match.phaseId && !match.phasePosition && !match.phaseOccurrenceId && !match.journeyRunId) return null;
  const phase = match.phaseId
    ? `${match.phaseId}${match.phaseOccurrence && match.phaseOccurrence > 1 ? `#${match.phaseOccurrence}` : ""}${
        match.phasePosition ? `@${match.phasePosition}` : ""
      }`
    : match.phasePosition
      ? `phase@${match.phasePosition}`
      : "phase";
  return `phase: ${phase}`;
}

function warn(message: string): void {
  console.error(`Warning: ${message}`);
}

function warnAll(messages: string[]): void {
  for (const message of messages) warn(message);
}

function tldrWarningsForWrite(kind: "description" | "feedback" | "debrief", text: unknown, tldr: unknown): string[] {
  return tldrWarningsForContent(kind, text, tldr);
}

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

const STATUS_LABELS: Record<string, string> = {
  idea: "idea",
  refined: "refined",
  in_progress: "in_progress",
  done: "done",
};

const VERIFICATION_FILTER_VALUES = new Set([
  "all",
  "verification",
  "needs_verification",
  "inbox",
  "unread",
  "new",
  "reviewed",
  "non-inbox",
  "non_inbox",
  "read",
  "acknowledged",
]);

function parseVerificationFilterTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function requireReviewPendingQuest(quest: QuestmasterTask, questId: string, action: "later" | "inbox"): void {
  if (hasQuestReviewMetadata(quest)) return;
  die(`Quest ${questId} is ${quest.status}; quest ${action} only applies to quests under review.`);
}

const currentSessionId = getCurrentSessionId();
const companionPort = getCompanionPort();

let sessionMetadataCache: Map<string, SessionMetadata> | null = null;

async function getSessionMetadataMap(): Promise<Map<string, SessionMetadata>> {
  if (sessionMetadataCache) return sessionMetadataCache;
  sessionMetadataCache = await fetchSessionMetadataMap(companionPort, companionAuthHeaders());
  return sessionMetadataCache;
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseCommitShasFromFlags(flagName = "commit", pluralFlagName = "commits"): string[] {
  try {
    return parseCommitShas([
      ...options(flagName),
      ...options(pluralFlagName).flatMap((group) => group.split(",").map((value) => value.trim())),
    ]);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}

function parsePositiveIntegerFlag(name: string, fallback: number, label: string): number {
  const value = option(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    die(`--${name} must be a positive integer for ${label}`);
  }
  return parsed;
}

function parseFeedbackAuthorFilter(): FeedbackAuthorFilter {
  const author = option("author") ?? "all";
  if (author === "human" || author === "agent" || author === "all") return author;
  die("--author must be one of: human, agent, all");
}

function humanFeedbackWarning(quest: QuestmasterTask): string | null {
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  if (unaddressed.length === 0) return null;
  return `unaddressed human feedback on ${quest.questId}: ${formatFeedbackIndices(unaddressed)}. Inspect with quest feedback list ${quest.questId} --unaddressed and mark resolved with quest address ${quest.questId} <index>.`;
}

function printHumanFeedbackWarning(quest: QuestmasterTask): void {
  const message = humanFeedbackWarning(quest);
  if (message) warn(message);
}

function feedbackEntryForJson(entry: IndexedFeedbackEntry): IndexedFeedbackEntry {
  return entry;
}

function formatFeedbackEntry(entry: IndexedFeedbackEntry, options: { full?: boolean } = {}): string {
  const state =
    entry.author === "human"
      ? entry.addressed
        ? "addressed"
        : "unaddressed"
      : isAgentSummaryFeedback(entry.text)
        ? "summary"
        : "comment";
  const text = options.full ? entry.text : compactSnippet(preferredFeedbackPreview(entry), 160);
  const imageNote = entry.images?.length
    ? ` (${entry.images.length} image${entry.images.length === 1 ? "" : "s"})`
    : "";
  const phaseNote = entry.phaseId ? `, ${entry.phaseId}${entry.phasePosition ? `@${entry.phasePosition}` : ""}` : "";
  return `#${entry.index} [${entry.author}, ${state}${phaseNote}, ${timeAgo(entry.ts)}] ${text}${imageNote}`;
}

let stdinTextPromise: Promise<string> | null = null;
let stdinFlagName: string | null = null;

async function readStdinText(): Promise<string> {
  if (!stdinTextPromise) {
    process.stdin.setEncoding("utf8");
    stdinTextPromise = (async () => {
      let text = "";
      for await (const chunk of process.stdin) {
        text += chunk;
      }
      return text;
    })();
  }
  return stdinTextPromise;
}

async function readOptionTextFile(pathOrDash: string, flagName: string): Promise<string> {
  if (pathOrDash === "-") {
    if (stdinFlagName && stdinFlagName !== flagName) {
      die(
        `Only one option can read from stdin per command. Already using ${stdinFlagName}; cannot also use ${flagName}.`,
      );
    }
    stdinFlagName = flagName;
    return readStdinText();
  }

  try {
    return await readFile(resolve(pathOrDash), "utf-8");
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    die(`Cannot read ${flagName} input from ${pathOrDash}${detail}`);
  }
}

async function readOptionalRichTextOption(args: {
  inlineFlag: string;
  fileFlag: string;
  label: string;
  allowEmpty?: boolean;
}): Promise<string | undefined> {
  const inlineValue = option(args.inlineFlag);
  const fileValue = option(args.fileFlag);
  const hasInlineFlag = flag(args.inlineFlag);
  const hasFileFlag = flag(args.fileFlag);

  if (hasInlineFlag && inlineValue === undefined) {
    die(`--${args.inlineFlag} requires a value`);
  }
  if (hasFileFlag && fileValue === undefined) {
    die(`--${args.fileFlag} requires a path or '-' for stdin`);
  }
  if (inlineValue !== undefined && fileValue !== undefined) {
    die(`Use either --${args.inlineFlag} or --${args.fileFlag}, not both`);
  }

  const value =
    fileValue !== undefined
      ? await readOptionTextFile(fileValue, `--${args.fileFlag}`)
      : inlineValue !== undefined
        ? inlineValue
        : undefined;

  if (value !== undefined && !args.allowEmpty && !value.trim()) {
    die(`${args.label} is required`);
  }

  return value;
}

async function readRichTextOption(args: {
  inlineFlag: string;
  fileFlag: string;
  label: string;
  allowEmpty?: boolean;
}): Promise<string> {
  const value = await readOptionalRichTextOption(args);

  if (value === undefined) {
    die(
      `${args.label} is required. Use --${args.inlineFlag} for short inline text or ` +
        `--${args.fileFlag} <path> (or '-') for arbitrary rich text.`,
    );
  }

  if (!args.allowEmpty && !value.trim()) {
    die(`${args.label} is required`);
  }

  return value;
}

async function readOptionalDebriefOptions(): Promise<{ debrief?: string; debriefTldr?: string }> {
  const debrief = await readOptionalRichTextOption({
    inlineFlag: "debrief",
    fileFlag: "debrief-file",
    label: "Final debrief",
  });
  const debriefTldr = await readOptionalRichTextOption({
    inlineFlag: "debrief-tldr",
    fileFlag: "debrief-tldr-file",
    label: "Final debrief TLDR",
  });
  const normalizedDebriefTldr = normalizeTldr(debriefTldr);
  return {
    ...(debrief !== undefined ? { debrief } : {}),
    ...(debriefTldr !== undefined ? { debriefTldr: normalizedDebriefTldr ?? "" } : {}),
  };
}

function parseVerificationItems(raw: string, sourceLabel: string): { text: string; checked: boolean }[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
      die(`Invalid JSON in ${sourceLabel}${detail}`);
    }
    if (!Array.isArray(parsed)) {
      die(`${sourceLabel} JSON input must be an array of strings or { text } objects`);
    }
    return parsed.map((entry, index) => {
      const text =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string"
            ? entry.text
            : null;
      if (!text || !text.trim()) {
        die(`${sourceLabel} item ${index + 1} must be a non-empty string or object with a non-empty text field`);
      }
      return { text: text.trim(), checked: false };
    });
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text, checked: false }));
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  validateFlags(["status", "tags", "tag", "session", "text", "verification", "json"]);
  const verification = option("verification");
  const verificationTokens = parseVerificationFilterTokens(verification);
  const invalidVerification = verificationTokens.filter((token) => !VERIFICATION_FILTER_VALUES.has(token));
  if (invalidVerification.length > 0) {
    die(
      `Invalid --verification value(s): ${invalidVerification.join(", ")}. ` +
        "Valid values: all, inbox, reviewed (aliases: verification, needs_verification, unread, new, non-inbox, non_inbox, read, acknowledged).",
    );
  }
  const quests = applyQuestListFilters(await listQuests(), {
    status: option("status"),
    tags: option("tags"),
    tag: option("tag"),
    session: option("session"),
    text: option("text"),
    verification,
  });
  const sessionMetadata = await getSessionMetadataMap();

  if (jsonOutput) {
    out(quests);
    return;
  }

  if (quests.length === 0) {
    console.log("No quests found.");
    return;
  }
  for (const q of quests) {
    console.log(formatQuestLine(q, sessionMetadata, { currentSessionId, getSessionName: getName }));
    const tldr = normalizeTldr((q as { tldr?: unknown }).tldr);
    if (tldr) {
      console.log(`       TLDR: ${compactSnippet(tldr, 120)}`);
    }
    const phaseSummary = summarizeQuestPhaseDocumentation(q);
    const phaseGroups = compactPhaseDocumentationGroups(phaseSummary, 2);
    for (const group of phaseGroups) {
      const latestEntry = group.entries.at(-1);
      if (!latestEntry) continue;
      const meta = group.metaLabel ? ` [${group.metaLabel}]` : "";
      console.log(
        `       Phase: ${group.displayLabel}${meta}: ${compactSnippet(phaseDocumentationPreview(latestEntry), 120)}`,
      );
    }
  }
}

async function cmdStatus(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest status <questId>");

  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);

  if (jsonOutput) {
    out(questStatusSummaryForJson(quest));
    return;
  }
  const sessionMetadata = await getSessionMetadataMap();
  console.log(
    formatQuestStatusSummary(quest, sessionMetadata, {
      currentSessionId,
      getSessionName: getName,
    }),
  );
  printHumanFeedbackWarning(quest);
}

async function cmdGrep(): Promise<void> {
  validateFlags(["count", "json"]);
  const limit = parsePositiveIntegerFlag("count", 50, "match count");

  const flagConsumed = new Set<number>();
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    flagConsumed.add(i);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) {
      flagConsumed.add(i + 1);
      i += 1;
    }
  }

  const query = args
    .slice(1)
    .filter((_, index) => !flagConsumed.has(index + 1))
    .join(" ")
    .trim();

  if (!query) die("Usage: quest grep <pattern> [--count N] [--json]");

  const quests = await listQuests();
  let result;
  try {
    result = grepQuests(quests, query, { limit });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (jsonOutput) {
    out(result);
    return;
  }

  if (result.totalMatches === 0) {
    console.log(`No quest matches for "${query}".`);
    if (result.warning) console.log(`Hint: ${result.warning}`);
    return;
  }

  const shown = result.matches.length;
  console.log(
    `${result.totalMatches} quest match${result.totalMatches === 1 ? "" : "es"} for "${query}"${shown < result.totalMatches ? ` (showing first ${shown})` : ""}:`,
  );
  console.log("");

  const groupedMatches = new Map<
    string,
    {
      questId: string;
      title: string;
      status: QuestmasterTask["status"];
      matches: (typeof result.matches)[number][];
    }
  >();
  for (const match of result.matches) {
    const existing = groupedMatches.get(match.questId);
    if (existing) {
      existing.matches.push(match);
      continue;
    }
    groupedMatches.set(match.questId, {
      questId: match.questId,
      title: match.title,
      status: match.status,
      matches: [match],
    });
  }

  const questById = new Map(quests.map((quest) => [quest.questId, quest] as const));

  for (const group of groupedMatches.values()) {
    const title = truncate(group.title, 48);
    const status = STATUS_LABELS[group.status] ?? group.status;
    const questLabel = `${group.questId.padEnd(6)} ${title}`;
    console.log(`  ${questLabel} (${status})`);
    for (const match of group.matches) {
      const parts = [match.matchedField];
      if (match.feedbackAuthor) parts.push(match.feedbackAuthor);
      const phaseScope = formatPhaseScopeLabel(match);
      if (phaseScope) parts.push(phaseScope);
      const quest = questById.get(match.questId);
      const feedbackEntries =
        quest && "feedback" in quest ? (quest as { feedback?: Array<{ ts?: number }> }).feedback : undefined;
      const feedbackTs = match.feedbackIndex !== undefined ? feedbackEntries?.[match.feedbackIndex]?.ts : undefined;
      if (feedbackTs) parts.push(timeAgo(feedbackTs));
      console.log(`        ${parts.join(" | ")}`);
      console.log(`        ${compactSnippet(match.snippet, 96)}`);
    }
    console.log("");
  }

  if (result.warning) console.log(`Hint: ${result.warning}`);
}

async function cmdCreate(): Promise<void> {
  validateFlags([
    "title",
    "title-file",
    "desc",
    "desc-file",
    "tldr",
    "tldr-file",
    "status",
    "tags",
    "session-space",
    "follow-up-of",
    "image",
    "images",
    "json",
  ]);
  const positionalTitle = positional(0);
  const title = await readOptionalRichTextOption({
    inlineFlag: "title",
    fileFlag: "title-file",
    label: "Quest title",
  });
  if (positionalTitle !== undefined && title !== undefined) {
    die("Use either a positional <title>, --title, or --title-file, not multiple title inputs");
  }
  const resolvedTitle = positionalTitle ?? title;
  if (!resolvedTitle) {
    die(
      'Usage: quest create [<title> | --title "..." | --title-file <path>|-] ' +
        '[--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] ' +
        '[--status idea|refined] [--tags "t1,t2"] [--session-space <slug>] [--follow-up-of "q-1,q-2"] ' +
        '[--image <path>] [--images "p1,p2"]',
    );
  }

  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const status = option("status");
  if (status !== undefined && status !== "idea" && status !== "refined") {
    die("--status for quest create must be one of: idea, refined");
  }
  const tags = parseCommaSeparatedTags(option("tags"));
  const sessionSpaceSlug = option("session-space") ?? process.env[COMPANION_MEMORY_SPACE_SLUG_ENV];
  const imagePaths = [
    ...options("image"),
    ...options("images").flatMap((group) => group.split(",").map((p) => p.trim())),
  ].filter(Boolean);
  const relationships = parseRelationshipFlags({ option });

  try {
    const uploadedImages =
      imagePaths.length > 0
        ? (() => {
            if (directCodexExecution) {
              return Promise.all(imagePaths.map((path) => saveQuestInputImage(path)));
            }
            const port = companionPort;
            if (!port) {
              die("Companion server port not found. Set COMPANION_PORT env var.");
            }
            return Promise.all(imagePaths.map((path) => uploadQuestInputImage(port, path, companionAuthHeaders())));
          })()
        : undefined;
    const resolvedImages = uploadedImages ? await uploadedImages : undefined;
    const quest = await createQuest({
      title: resolvedTitle,
      description,
      ...(status ? { status: status as "idea" | "refined" } : {}),
      ...(normalizedTldr ? { tldr: normalizedTldr } : {}),
      tags,
      ...(sessionSpaceSlug ? { sessionSpaceSlug } : {}),
      ...(relationships ? { relationships } : {}),
      ...(resolvedImages?.length ? { images: resolvedImages } : {}),
      ...(directCodexExecution && codexInvocation ? { createdBy: codexQuestProvenance(codexInvocation) } : {}),
    });
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const imageNote = resolvedImages?.length ? `, ${resolvedImages.length} image(s)` : "";
      console.log(`Created ${quest.questId}: "${quest.title}" (${quest.status}${imageNote})`);
      console.log(`Use this exact quest ID for follow-up commands: ${quest.questId}`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdComplete(): Promise<void> {
  validateFlags([
    "items",
    "items-file",
    "commit",
    "commits",
    "memory-commit",
    "memory-commits",
    "no-code",
    "session",
    "debrief",
    "debrief-file",
    "debrief-tldr",
    "debrief-tldr-file",
    "force",
    "reason",
    "json",
  ]);
  const id = positional(0);
  if (!id) {
    die(
      'Usage: quest complete <questId> [--items "check1,check2" | --items-file <path>|-] ' +
        '[--no-code] [--session <sid>] [--commit <sha>] [--commits "sha1,sha2"] [--memory-commit <sha>] [--memory-commits "sha1,sha2"] ' +
        '[--debrief "..." | --debrief-file <path>|-] [--debrief-tldr "..." | --debrief-tldr-file <path>|-]',
    );
  }

  if (flag("items") && option("items") === undefined) {
    die("--items requires a comma-separated value");
  }
  if (flag("items-file") && option("items-file") === undefined) {
    die("--items-file requires a path or '-' for stdin");
  }
  const commitShas = parseCommitShasFromFlags();
  const memoryCommitShas = parseCommitShasFromFlags("memory-commit", "memory-commits");
  const noCode = flag("no-code");
  if (noCode && (commitShas.length > 0 || memoryCommitShas.length > 0)) {
    die("--no-code cannot be combined with --commit/--commits or --memory-commit/--memory-commits");
  }
  const inlineItems = option("items");
  const itemsFile = option("items-file");
  if (inlineItems !== undefined && itemsFile !== undefined) {
    die("Use either --items or --items-file, not both");
  }
  const targetSessionId = option("session")?.trim();
  if (flag("session") && !targetSessionId) {
    die("--session requires a session id");
  }
  const debriefOptions = await readOptionalDebriefOptions();
  const override = parseQuestStatusMutationOverride(statusMutationCommandDeps());

  let items: { text: string; checked: boolean }[] = [];
  if (itemsFile !== undefined) {
    const rawItems = await readOptionTextFile(itemsFile, "--items-file");
    items = parseVerificationItems(rawItems, "--items-file");
  } else if (inlineItems) {
    items = inlineItems
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text) => ({ text, checked: false }));
  }
  const currentQuest = await getQuest(id);
  if (currentQuest) {
    warnAll(completionHygieneWarnings(currentQuest, items, commitShas));
  }

  const serverQuest = await postQuestStatusMutation(statusMutationCommandDeps(), id, "complete", {
    verificationItems: items,
    ...(targetSessionId ? { sessionId: targetSessionId } : {}),
    ...(commitShas.length > 0 ? { commitShas } : {}),
    ...(memoryCommitShas.length > 0 ? { memoryCommitShas } : {}),
    ...(override.force ? { force: true, reason: override.reason } : {}),
    ...debriefOptions,
  });
  if (serverQuest) {
    if (jsonOutput) {
      out(serverQuest);
    } else {
      console.log(`Completed ${serverQuest.questId} "${serverQuest.title}" with ${items.length} user review checks`);
      console.log(formatCompletionReminder(serverQuest.questId, { noCode }));
    }
    warnAll(tldrWarningsForWrite("debrief", debriefOptions.debrief, debriefOptions.debriefTldr));
    return;
  }
  if (override.force) {
    die("Leader recovery via quest complete --force requires Companion server auth.");
  }

  // Fallback: direct filesystem (no browser notification)
  try {
    await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, override, {
      ...(targetSessionId ? { targetSessionId } : {}),
      ...(directCodexExecution ? { requireOwner: true } : {}),
    });
    const directSessionId = directCodexExecution ? codexInvocation?.sessionId : undefined;
    const quest = await completeQuest(
      id,
      items,
      commitShas.length > 0 ||
        memoryCommitShas.length > 0 ||
        targetSessionId ||
        directSessionId ||
        Object.keys(debriefOptions).length > 0
        ? {
            commitShas,
            memoryCommitShas,
            ...((targetSessionId ?? directSessionId) ? { sessionId: targetSessionId ?? directSessionId } : {}),
            ...(directCodexExecution ? { ownerKind: "codex" as const } : {}),
            ...(directCodexExecution && codexInvocation ? { provenance: codexQuestProvenance(codexInvocation) } : {}),
            ...debriefOptions,
          }
        : undefined,
    );
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Completed ${quest.questId} "${quest.title}" with ${items.length} user review checks`);
      console.log(formatCompletionReminder(quest.questId, { noCode }));
    }
    warnAll(tldrWarningsForWrite("debrief", debriefOptions.debrief, debriefOptions.debriefTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

function formatCompletionReminder(questId: string, options: { noCode: boolean }): string {
  const summaryLine =
    `Reminder: keep one substantive user-oriented quest summary comment up to date with ` +
    `\`quest feedback ${questId} --text "Summary: <what changed, why it matters, and what verification passed>"\`` +
    ` before reporting that the quest is ready. Use \`--text-file <path>\` or \`--text-file -\`` +
    ` when that summary includes copied logs, backticks, or other shell-like text. For long multi-topic summaries, write the full \`--text\`/\`--text-file\` body first and add \`--tldr\`/\`--tldr-file\` second, with each major topic preserved in concise scan text instead of incidental raw details. Put implementation details, automated verification results, Code Review, Execute, Port, push, and post-port evidence in phase docs, review verdicts, Port notes, commit metadata, and the debrief, not in \`quest complete --items\`. Empty user review checks are normal when no user action remains. Avoid review/rework timelines unless essential. Every completed non-cancelled quest must also have final debrief metadata and debrief TLDR metadata; use \`--debrief-file\` plus \`--debrief-tldr-file\` on completion, or treat the handoff as incomplete until a leader or final Memory phase can supply both.`;
  if (options.noCode) {
    return (
      summaryLine +
      " You used `--no-code` for this local CLI handoff, so do not add port commentary or synced SHA placeholders. Only use `--no-code` when the quest produced zero git-tracked changes; it does not relax the final debrief and debrief TLDR requirement."
    );
  }
  return (
    summaryLine +
    " Use `--commit/--commits` structured metadata for routine port info, including docs, skills, prompts, templates, and other text-only tracked-file commits; only add a second prose port comment when the port was exceptional."
  );
}

async function cmdDone(): Promise<void> {
  validateFlags([
    "notes",
    "notes-file",
    "debrief",
    "debrief-file",
    "debrief-tldr",
    "debrief-tldr-file",
    "cancelled",
    "force",
    "reason",
    "json",
  ]);
  const id = positional(0);
  if (!id)
    die(
      'Usage: quest done <questId> [--notes "..." | --notes-file <path>|-] ' +
        '[--debrief "..." | --debrief-file <path>|-] [--debrief-tldr "..." | --debrief-tldr-file <path>|-] [--cancelled]',
    );

  const notes = await readOptionalRichTextOption({
    inlineFlag: "notes",
    fileFlag: "notes-file",
    label: "Closure notes",
  });
  const debriefOptions = await readOptionalDebriefOptions();
  const cancelled = flag("cancelled");
  const override = parseQuestStatusMutationOverride(statusMutationCommandDeps());
  if (cancelled && Object.keys(debriefOptions).length > 0) {
    die("Final debrief metadata is only supported for completed quests, not cancelled quests");
  }

  try {
    const serverQuest = await postQuestStatusMutation(statusMutationCommandDeps(), id, "done", {
      ...(notes ? { notes } : {}),
      ...debriefOptions,
      ...(cancelled ? { cancelled: true } : {}),
      ...(override.force ? { force: true, reason: override.reason } : {}),
    });
    if (serverQuest) {
      if (jsonOutput) out(serverQuest);
      else {
        const verb = cancelled ? "Cancelled" : "Marked done";
        console.log(`${verb} ${serverQuest.questId} "${serverQuest.title}"`);
      }
      warnAll(tldrWarningsForWrite("debrief", debriefOptions.debrief, debriefOptions.debriefTldr));
      return;
    }
    await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, override, {
      ...(directCodexExecution ? { requireOwner: true } : {}),
    });
    const quest = await markDone(id, {
      notes,
      cancelled,
      ...debriefOptions,
      ...(directCodexExecution ? { ownerKind: "codex" as const } : {}),
      ...(directCodexExecution && codexInvocation ? { provenance: codexQuestProvenance(codexInvocation) } : {}),
    });
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const verb = cancelled ? "Cancelled" : "Marked done";
      console.log(`${verb} ${quest.questId} "${quest.title}"`);
    }
    warnAll(tldrWarningsForWrite("debrief", debriefOptions.debrief, debriefOptions.debriefTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdCancel(): Promise<void> {
  validateFlags(["notes", "notes-file", "force", "reason", "json"]);
  const id = positional(0);
  if (!id) die('Usage: quest cancel <id> [--notes "reason" | --notes-file <path>|-] [--json]');

  const notes = await readOptionalRichTextOption({
    inlineFlag: "notes",
    fileFlag: "notes-file",
    label: "Cancellation reason",
  });
  const override = parseQuestStatusMutationOverride(statusMutationCommandDeps());

  try {
    const serverQuest = await postQuestStatusMutation(statusMutationCommandDeps(), id, "cancel", {
      ...(notes ? { notes } : {}),
      ...(override.force ? { force: true, reason: override.reason } : {}),
    });
    if (serverQuest) {
      if (jsonOutput) out(serverQuest);
      else console.log(`Cancelled ${serverQuest.questId} "${serverQuest.title}"`);
      return;
    }
    await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, override);
    const quest =
      directCodexExecution && codexInvocation
        ? await cancelQuestForOwner(id, codexQuestOwner(codexInvocation), notes, {
            provenance: codexQuestProvenance(codexInvocation),
          })
        : await cancelQuest(id, notes);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Cancelled ${quest.questId} "${quest.title}"`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdTransition(): Promise<void> {
  validateFlags([
    "status",
    "desc",
    "desc-file",
    "tldr",
    "tldr-file",
    "session",
    "commit",
    "commits",
    "memory-commit",
    "memory-commits",
    "debrief",
    "debrief-file",
    "debrief-tldr",
    "debrief-tldr-file",
    "force",
    "reason",
    "json",
  ]);
  const id = positional(0);
  if (!id)
    die(
      'Usage: quest transition <questId> --status <s> [--desc "..." | --desc-file <path>|-] ' +
        '[--tldr "..." | --tldr-file <path>|-] ' +
        '[--debrief "..." | --debrief-file <path>|-] [--debrief-tldr "..." | --debrief-tldr-file <path>|-]',
    );

  const status = option("status");
  if (!status) die("--status is required");
  if (status === "needs_verification" || status === "verification") {
    die(
      "needs_verification is no longer a lifecycle transition target. Use `quest complete` for review handoff or `quest list --verification ...` for review filters.",
    );
  }
  if (directCodexExecution && status === "in_progress") {
    die("Direct Codex tasks must use `quest claim <questId>` instead of transitioning to in_progress.");
  }

  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const debriefOptions = await readOptionalDebriefOptions();
  const sessionId = option("session") || currentSessionId;
  const commitShas = parseCommitShasFromFlags();
  const memoryCommitShas = parseCommitShasFromFlags("memory-commit", "memory-commits");
  const override = parseQuestStatusMutationOverride(statusMutationCommandDeps());
  if ((commitShas.length > 0 || memoryCommitShas.length > 0) && status !== "done") {
    die("commit metadata flags can only be used when completing a quest");
  }
  if (Object.keys(debriefOptions).length > 0 && status !== "done") {
    die("--debrief/--debrief-file and --debrief-tldr/--debrief-tldr-file can only be used with --status done");
  }

  try {
    const transitionInput = {
      status: status as import("../server/quest-types.js").QuestStatus,
      ...(description !== undefined ? { description } : {}),
      ...(tldr !== undefined ? { tldr: normalizedTldr ?? "" } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(commitShas.length > 0 ? { commitShas } : {}),
      ...(memoryCommitShas.length > 0 ? { memoryCommitShas } : {}),
      ...(directCodexExecution ? { ownerKind: "codex" as const } : {}),
      ...(directCodexExecution && codexInvocation ? { lastModifiedBy: codexQuestProvenance(codexInvocation) } : {}),
      ...debriefOptions,
    };
    const serverQuest = await postQuestStatusMutation(statusMutationCommandDeps(), id, "transition", {
      ...transitionInput,
      ...(override.force ? { force: true, reason: override.reason } : {}),
    });
    const quest =
      serverQuest ??
      (await (async () => {
        await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, override, {
          ...(sessionId ? { targetSessionId: sessionId } : {}),
          ...(directCodexExecution && status === "done" ? { requireOwner: true } : {}),
        });
        return transitionQuest(id, transitionInput);
      })());
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Transitioned ${quest.questId} to ${quest.status}`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
    warnAll(tldrWarningsForWrite("debrief", debriefOptions.debrief, debriefOptions.debriefTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdLater(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest later <questId>");

  if (companionPort) {
    try {
      const res = await fetch(
        `http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/verification/read`,
        {
          method: "POST",
          headers: companionAuthHeaders(),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      requireReviewPendingQuest(quest, id, "later");
      if (jsonOutput) {
        out(quest);
      } else {
        console.log(`Marked ${quest.questId} as acknowledged (left Review Inbox, stays under review)`);
      }
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).message?.includes("timeout")) {
        // Server unreachable — fall through to direct filesystem.
      } else {
        die((e as Error).message);
      }
    }
  }

  try {
    if (directCodexExecution) {
      await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, { force: false });
    }
    const quest = await markQuestVerificationRead(id);
    if (!quest) die(`Quest ${id} not found`);
    requireReviewPendingQuest(quest, id, "later");
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Marked ${quest.questId} as acknowledged (left Review Inbox, stays under review)`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdInbox(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest inbox <questId>");

  if (companionPort) {
    try {
      const res = await fetch(
        `http://localhost:${companionPort}/api/quests/${encodeURIComponent(id)}/verification/inbox`,
        {
          method: "POST",
          headers: companionAuthHeaders(),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        die((err as { error: string }).error || res.statusText);
      }
      const quest = (await res.json()) as QuestmasterTask;
      requireReviewPendingQuest(quest, id, "inbox");
      if (jsonOutput) {
        out(quest);
      } else {
        console.log(`Moved ${quest.questId} back to Review Inbox`);
      }
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError" || (e as Error).message?.includes("timeout")) {
        // Server unreachable — fall through to direct filesystem.
      } else {
        die((e as Error).message);
      }
    }
  }

  try {
    if (directCodexExecution) {
      await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, { force: false });
    }
    const quest = await markQuestVerificationInboxUnread(id);
    if (!quest) die(`Quest ${id} not found`);
    requireReviewPendingQuest(quest, id, "inbox");
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Moved ${quest.questId} back to Review Inbox`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdEdit(): Promise<void> {
  validateFlags([
    "title",
    "title-file",
    "desc",
    "desc-file",
    "tldr",
    "tldr-file",
    "tags",
    "session-space",
    "follow-up-of",
    "clear-follow-up-of",
    "json",
  ]);
  const id = positional(0);
  if (!id) {
    die(
      'Usage: quest edit <questId> [--title "..." | --title-file <path>|-] ' +
        '[--desc "..." | --desc-file <path>|-] [--tldr "..." | --tldr-file <path>|-] [--tags "t1,t2"] [--session-space <slug>] [--follow-up-of "q-1,q-2" | --clear-follow-up-of]',
    );
  }

  const title = await readOptionalRichTextOption({
    inlineFlag: "title",
    fileFlag: "title-file",
    label: "Quest title",
  });
  const description = await readOptionalRichTextOption({
    inlineFlag: "desc",
    fileFlag: "desc-file",
    label: "Quest description",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Quest TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);
  const tags = parseCommaSeparatedTags(option("tags"));
  const sessionSpaceSlug = option("session-space");
  if (flag("clear-follow-up-of") && flag("follow-up-of")) {
    die("Use either --follow-up-of or --clear-follow-up-of, not both");
  }
  const relationships = parseRelationshipFlags({ option, clearFollowUpOf: flag("clear-follow-up-of") });

  if (
    title === undefined &&
    description === undefined &&
    tldr === undefined &&
    tags === undefined &&
    sessionSpaceSlug === undefined &&
    relationships === undefined
  ) {
    die(
      "At least one of --title/--title-file, --desc/--desc-file, --tldr/--tldr-file, --tags, --session-space, --follow-up-of, or --clear-follow-up-of is required",
    );
  }

  try {
    const patch = {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(tldr !== undefined ? { tldr: normalizedTldr ?? "" } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(sessionSpaceSlug !== undefined ? { sessionSpaceSlug } : {}),
      ...(relationships !== undefined ? { relationships } : {}),
      ...(directCodexExecution && codexInvocation ? { lastModifiedBy: codexQuestProvenance(codexInvocation) } : {}),
    };
    const quest =
      directCodexExecution && codexInvocation
        ? await patchQuestForOwner(id, codexQuestOwner(codexInvocation), patch)
        : await patchQuest(id, patch);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      console.log(`Updated ${quest.questId} "${quest.title}"`);
    }
    warnAll(tldrWarningsForWrite("description", description, normalizedTldr));
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdCheck(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  const indexStr = positional(1);
  if (!id || indexStr === undefined) die("Usage: quest check <questId> <index>");

  const index = Number(indexStr);
  if (Number.isNaN(index)) die("Index must be a number");

  // Toggle: read current state and flip it
  const current = await getQuest(id);
  if (!current) die(`Quest ${id} not found`);
  if (!("verificationItems" in current)) die("Quest has no User review checks");
  const items = (current as { verificationItems: { checked: boolean }[] }).verificationItems;
  if (index < 0 || index >= items.length) die(`Index ${index} out of range (0-${items.length - 1})`);
  const newChecked = !items[index].checked;

  try {
    if (directCodexExecution) {
      await guardLocalQuestStatusMutation(statusMutationCommandDeps(), id, { force: false });
    }
    const quest = await checkVerificationItem(id, index, newChecked);
    if (!quest) die(`Quest ${id} not found`);
    await notifyServer();
    if (jsonOutput) {
      out(quest);
    } else {
      const item = (quest as { verificationItems: { text: string; checked: boolean }[] }).verificationItems[index];
      console.log(`[${item.checked ? "x" : " "}] ${item.text}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdFeedback(): Promise<void> {
  const subcommand = positional(0);
  if (subcommand === "list") return cmdFeedbackList();
  if (subcommand === "latest") return cmdFeedbackLatest();
  if (subcommand === "show") return cmdFeedbackShow();
  if (subcommand === "add") return cmdFeedbackAdd({ explicitAdd: true });
  if (subcommand === "edit") {
    return runFeedbackEditCommand({
      companionPort,
      companionAuthHeaders,
      ...(directCodexExecution && codexInvocation
        ? {
            editLocally: (questId: string, index: number, patch: { text?: string; tldr?: string }) =>
              editCodexQuestFeedback(codexInvocation, questId, index, patch),
          }
        : {}),
    });
  }
  return cmdFeedbackAdd({ explicitAdd: false });
}

async function cmdFeedbackList(): Promise<void> {
  validateFlags(["last", "author", "unaddressed", "json"]);
  const id = positional(1);
  if (!id) die("Usage: quest feedback list <questId> [--last N] [--author human|agent|all] [--unaddressed] [--json]");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  if (flag("last") && option("last") === undefined) die("--last requires a positive integer value");
  const last = flag("last") ? parsePositiveIntegerFlag("last", 10, "feedback entries") : undefined;
  const entries = filterFeedbackEntries(quest, {
    author: parseFeedbackAuthorFilter(),
    unaddressed: flag("unaddressed"),
    ...(last !== undefined ? { last } : {}),
  });
  if (jsonOutput) {
    out(entries.map(feedbackEntryForJson));
    return;
  }
  if (entries.length === 0) {
    console.log(`No feedback entries found for ${quest.questId}.`);
    return;
  }
  for (const entry of entries) {
    console.log(formatFeedbackEntry(entry));
  }
}

async function cmdFeedbackLatest(): Promise<void> {
  validateFlags(["author", "unaddressed", "full", "json"]);
  const id = positional(1);
  if (!id) die("Usage: quest feedback latest <questId> [--author human|agent|all] [--unaddressed] [--full] [--json]");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  const entry = latestFeedbackEntry(quest, {
    author: parseFeedbackAuthorFilter(),
    unaddressed: flag("unaddressed"),
  });
  if (jsonOutput) {
    out(entry ? feedbackEntryForJson(entry) : null);
    return;
  }
  if (!entry) {
    console.log(`No matching feedback entries found for ${quest.questId}.`);
    return;
  }
  console.log(formatFeedbackEntry(entry, { full: flag("full") }));
}

async function cmdFeedbackShow(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(1);
  const indexStr = positional(2);
  if (!id || indexStr === undefined) die("Usage: quest feedback show <questId> <index> [--json]");
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 0) die("Index must be a non-negative integer");
  const quest = await getQuest(id);
  if (!quest) die(`Quest ${id} not found`);
  const rawEntry = quest.feedback?.[index];
  if (isDeletedQuestFeedbackEntry(rawEntry)) die(`Feedback index ${index} was deleted`);
  const entry = filterFeedbackEntries(quest).find((candidate) => candidate.index === index);
  if (!entry) die(`Feedback index ${index} out of range`);
  if (jsonOutput) {
    out(feedbackEntryForJson(entry));
    return;
  }
  console.log(formatFeedbackEntry(entry, { full: true }));
  if (entry.images?.length) {
    for (const img of entry.images) {
      console.log(`  ${img.filename} -> ${img.path}`);
    }
  }
}

async function cmdFeedbackAdd(addOptions: { explicitAdd: boolean }): Promise<void> {
  validateFlags([
    "text",
    "text-file",
    "tldr",
    "tldr-file",
    "author",
    "session",
    "image",
    "images",
    "phase",
    "phase-position",
    "phase-occurrence",
    "phase-occurrence-id",
    "journey-run",
    "kind",
    "infer-phase",
    "no-phase",
    "json",
  ]);
  const id = positional(addOptions.explicitAdd ? 1 : 0);
  if (!id) {
    die(
      'Usage: quest feedback <questId> (--text "..." | --text-file <path>|-) ' +
        '[--tldr "..." | --tldr-file <path>|-] [--author agent|human] [--session <sid>] ' +
        '[--image <path>] [--images "p1,p2"]',
    );
  }

  const text = await readRichTextOption({
    inlineFlag: "text",
    fileFlag: "text-file",
    label: "Feedback text",
  });
  const tldr = await readOptionalRichTextOption({
    inlineFlag: "tldr",
    fileFlag: "tldr-file",
    label: "Feedback TLDR",
  });
  const normalizedTldr = normalizeTldr(tldr);

  const authorOpt = option("author");
  const author = authorOpt === "human" ? "human" : "agent";
  const sessionId = option("session") || currentSessionId;
  if (author === "agent" && !sessionId) {
    die("Agent feedback requires --session <sid> or Companion session auth.");
  }
  const imagePaths = [
    ...options("image"),
    ...options("images").flatMap((group) => group.split(",").map((p) => p.trim())),
  ].filter(Boolean);

  if (directCodexExecution && codexInvocation) {
    const phaseFlag = [
      "phase",
      "phase-position",
      "phase-occurrence",
      "phase-occurrence-id",
      "journey-run",
      "infer-phase",
    ].find(flag);
    if (phaseFlag) {
      die(`Direct Codex quest feedback is flat and does not support --${phaseFlag}. Use --no-phase instead.`);
    }
    if (author !== "agent") die("Direct Codex quest feedback must use --author agent.");
    if (option("session") && option("session") !== codexInvocation.sessionId) {
      die("Direct Codex quest feedback cannot target another session.");
    }
    try {
      const uploadedImages = await Promise.all(imagePaths.map((path) => saveQuestInputImage(path)));
      const { before, quest } = await addCodexQuestFeedback({
        context: codexInvocation,
        questId: id,
        text,
        ...(normalizedTldr ? { tldr: normalizedTldr } : {}),
        ...(option("kind") ? { kind: option("kind") } : {}),
        ...(uploadedImages.length ? { images: uploadedImages } : {}),
      });
      const mutationWarnings = feedbackAddWarnings({ before, after: quest, author, text: text.trim() });
      const tldrWarnings = tldrWarningsForWrite("feedback", text, normalizedTldr);
      if (jsonOutput) out(quest);
      else {
        const entryCount = questFeedbackEntries(quest).length;
        const imageNote = uploadedImages.length ? `, ${uploadedImages.length} image(s)` : "";
        console.log(`Added feedback to ${quest.questId} (${entryCount} entries total${imageNote})`);
      }
      warnAll([...mutationWarnings, ...tldrWarnings]);
      return;
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  }

  const port = companionPort;
  if (!port) {
    die("Companion server port not found. Set COMPANION_PORT env var.");
  }

  try {
    const before = await getQuest(id);
    const uploadedImages =
      imagePaths.length > 0
        ? await Promise.all(imagePaths.map((path) => uploadQuestInputImage(port, path, companionAuthHeaders())))
        : undefined;
    const res = await fetch(`http://localhost:${port}/api/quests/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      headers: companionAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        text: text.trim(),
        ...(normalizedTldr ? { tldr: normalizedTldr } : {}),
        author,
        ...(author === "agent" && sessionId ? { sessionId } : {}),
        ...(uploadedImages?.length ? { images: uploadedImages } : {}),
        ...(option("phase") ? { phase: option("phase") } : {}),
        ...(option("phase-position") ? { phasePosition: option("phase-position") } : {}),
        ...(option("phase-occurrence") ? { phaseOccurrence: option("phase-occurrence") } : {}),
        ...(option("phase-occurrence-id") ? { phaseOccurrenceId: option("phase-occurrence-id") } : {}),
        ...(option("journey-run") ? { journeyRunId: option("journey-run") } : {}),
        ...(option("kind") ? { kind: option("kind") } : {}),
        ...(flag("infer-phase") ? { inferPhase: true } : {}),
        ...(flag("no-phase") ? { noPhase: true } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      die((err as { error: string }).error || res.statusText);
    }
    const quest = (await res.json()) as QuestmasterTask;
    const tldrHeaderWarning = res.headers.get(QUEST_TLDR_WARNING_HEADER);
    const phaseHeaderWarning = res.headers.get(QUEST_PHASE_DOCUMENTATION_WARNING_HEADER);
    const mutationWarnings = feedbackAddWarnings({ before, after: quest, author, text: text.trim() });
    const tldrWarnings = tldrHeaderWarning
      ? [tldrHeaderWarning]
      : author === "agent"
        ? tldrWarningsForWrite("feedback", text, normalizedTldr)
        : [];
    if (jsonOutput) {
      out(quest);
      warnAll([...mutationWarnings, ...tldrWarnings, ...(phaseHeaderWarning ? [phaseHeaderWarning] : [])]);
    } else {
      const entryCount = questFeedbackEntries(quest).length;
      const imageNote = uploadedImages?.length ? `, ${uploadedImages.length} image(s)` : "";
      console.log(`Added feedback to ${quest.questId} (${entryCount} entries total${imageNote})`);
      warnAll([...mutationWarnings, ...tldrWarnings, ...(phaseHeaderWarning ? [phaseHeaderWarning] : [])]);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

async function cmdAddress(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  const indexStr = positional(1);
  if (!id || indexStr === undefined) die("Usage: quest address <questId> <index>");

  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) die("Invalid index");

  if (directCodexExecution && codexInvocation) {
    try {
      const quest = await toggleCodexQuestFeedbackAddressed(codexInvocation, id, index);
      if (!quest) die(`Quest ${id} not found`);
      printAddressedFeedbackResult(quest, index);
      return;
    } catch (error) {
      die(error instanceof Error ? error.message : String(error));
    }
  }

  const port = companionPort;
  if (!port) {
    die("Companion server port not found. Set COMPANION_PORT env var.");
  }

  try {
    const res = await fetch(
      `http://localhost:${port}/api/quests/${encodeURIComponent(id)}/feedback/${index}/addressed`,
      {
        method: "POST",
        headers: companionAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      die((err as { error: string }).error || res.statusText);
    }
    const quest = (await res.json()) as QuestmasterTask;
    printAddressedFeedbackResult(quest, index);
  } catch (e) {
    die((e as Error).message);
  }
}

function printAddressedFeedbackResult(quest: QuestmasterTask, index: number): void {
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  if (jsonOutput) out(quest);
  else {
    const entry = questFeedbackEntries(quest).find((candidate) => candidate.index === index);
    if (!entry) die(`Feedback index ${index} was deleted`);
    console.log(`Feedback #${index} on ${quest.questId}: ${entry.addressed ? "addressed" : "unaddressed"}`);
  }
  if (unaddressed.length > 0) {
    warn(`remaining unaddressed human feedback: ${formatFeedbackIndices(unaddressed)}.`);
  }
}

async function cmdMine(): Promise<void> {
  validateFlags(["json"]);
  if (!currentSessionId) die("No current session identity found.");

  const currentOwner = {
    kind: codexInvocation && !managedCompanionIdentity ? ("codex" as const) : ("takode" as const),
    sessionId: currentSessionId,
  };
  const quests = (await listQuests()).filter((quest) => sameQuestOwner(getQuestOwner(quest), currentOwner));

  if (jsonOutput) {
    out(quests);
    return;
  }

  if (quests.length === 0) {
    console.log("No quests owned by this session.");
    return;
  }

  for (const q of quests) {
    console.log(formatQuestLine(q, undefined, { currentSessionId, getSessionName: getName }));
  }
}

async function cmdDelete(): Promise<void> {
  validateFlags(["json"]);
  const id = positional(0);
  if (!id) die("Usage: quest delete <questId>");

  if (directCodexExecution && codexInvocation) {
    const current = await getQuest(id);
    const owner = current ? getQuestDisplayOwner(current) : undefined;
    if (owner && !sameQuestOwner(owner, codexQuestOwner(codexInvocation))) {
      die(`Cannot delete ${id}: it is owned by ${owner.kind} owner ${owner.sessionId}`);
    }
  }
  const deleted = await deleteQuest(id);
  if (!deleted) die(`Quest ${id} not found`);
  await notifyServer();
  if (jsonOutput) {
    out({ deleted: true, questId: id });
  } else {
    console.log(`Deleted ${id}`);
  }
}

function ownershipCommandDeps() {
  return {
    validateFlags,
    positional,
    option,
    flag,
    currentSessionId,
    codexOwner: directCodexExecution && codexInvocation ? codexQuestOwner(codexInvocation) : undefined,
    codexProvenance: directCodexExecution && codexInvocation ? codexQuestProvenance(codexInvocation) : undefined,
    companionPort,
    companionAuthHeaders,
    notifyServer,
    printHumanFeedbackWarning,
    jsonOutput,
    out,
    die,
  };
}

function statusMutationCommandDeps() {
  return {
    companionAuthHeaders,
    companionPort,
    currentSessionId,
    codexOwner: directCodexExecution && codexInvocation ? codexQuestOwner(codexInvocation) : undefined,
    die,
    flag,
    option,
    warn,
  };
}

async function proxyCodexMutationToServer(): Promise<boolean> {
  if (!codexInvocation || managedCompanionIdentity || questServerExecution || !isQuestMutationCommand(args)) {
    return false;
  }
  const result = await runCodexQuestCommandRpc({
    argv: args,
    context: codexInvocation,
    ...(questCommandReadsStdin(args) ? { stdin: await readStdinText() } : {}),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  return true;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (await proxyCodexMutationToServer()) return;
  switch (command) {
    case "list":
      return cmdList();
    case "mine":
      return cmdMine();
    case "grep":
      return cmdGrep();
    case "commit-links":
      validateFlags(["delivery", "commits", "json"]);
      await runCommitLinksCommand({
        questId: positionalArgs[0] ?? "",
        deliveryId: option("delivery") ?? "",
        commitShas: option("commits")?.split(","),
        json: jsonOutput,
      });
      break;
    case "show":
      return runShowCommand({
        validateFlags,
        positional,
        flag,
        option,
        getQuest,
        getSessionMetadataMap,
        currentSessionId,
        getSessionName: getName,
        jsonOutput,
        out,
        die,
        printHumanFeedbackWarning,
      });
    case "status":
      return cmdStatus();
    case "history":
      return runHistoryCommand({
        positional,
        validateFlags,
        jsonOutput,
        out,
        die,
        getQuest,
        getQuestHistoryView,
        statusLabels: STATUS_LABELS,
        timeAgo,
      });
    case "tags":
      return runTagsCommand({ listQuests, validateFlags, jsonOutput, out });
    case "create":
      return cmdCreate();
    case "claim":
      return runClaimCommand(ownershipCommandDeps());
    case "reassign":
      return runReassignCommand(ownershipCommandDeps());
    case "complete":
      return cmdComplete();
    case "done":
      return cmdDone();
    case "cancel":
      return cmdCancel();
    case "transition":
      return cmdTransition();
    case "later":
      return cmdLater();
    case "inbox":
      return cmdInbox();
    case "edit":
      return cmdEdit();
    case "check":
      return cmdCheck();
    case "feedback":
      return cmdFeedback();
    case "outcome":
      return runQuestOutcomeCommand({
        positional,
        validateFlags,
        getQuest,
        jsonOutput,
        out,
        die,
      });
    case "quiz":
      return runQuizCommand({
        positional,
        validateFlags,
        option,
        jsonOutput,
        out,
        die,
        warn,
        readOptionTextFile,
        getQuest,
        patchQuest:
          directCodexExecution && codexInvocation
            ? (questId, patch) => setCodexQuestQuiz(codexInvocation, questId, patch.quizItems ?? [])
            : patchQuest,
        notifyServer,
        companionPort,
        companionAuthHeaders,
      });
    case "address":
      return cmdAddress();
    case "delete":
      return cmdDelete();
    case "resize-image":
      return runResizeImageCommand({ validateFlags, positional, option, die, jsonOutput, out });
    case "optimize-image":
      return runOptimizeImageCommand({ validateFlags, positional, option, die, jsonOutput, out });
    case "help":
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      return;
    default:
      die(`Unknown command: ${command}. Run 'quest help' for usage.`);
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
