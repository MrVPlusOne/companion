import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { MAX_INSTRUCTION_CONTENT_BYTES, type CapturedInstructionContent } from "../shared/codex-instruction-content.js";
import type { CodexInstructionSnapshot } from "./codex-adapter-types.js";
import {
  captureCodexInstructionRolloutBoundary,
  readCapturedCodexInstructionText,
  type CodexInstructionRolloutBoundary,
} from "./codex-instruction-rollout.js";

const MAX_SOURCE_COUNT = 64;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const READ_BUDGET_MS = 1000;
const PROJECT_SEPARATOR = "\n\n--- project-doc ---\n\n";
const PENDING = "Captured instruction text is unavailable until native thread evidence confirms this snapshot.";

interface SourceCandidate {
  bytes: string | null;
  unavailableReason?: string;
}

export interface CodexInstructionCaptureEvidence {
  rollout?: CodexInstructionRolloutBoundary;
  candidates: SourceCandidate[];
}

/** Freeze only confirmed instruction-file candidates and the exact configured generated text. */
export async function captureCodexInstructionContents(
  snapshot: CodexInstructionSnapshot,
  developerInstructions: string | undefined,
  rolloutPath: unknown,
): Promise<CodexInstructionSnapshot> {
  const generated =
    developerInstructions?.trim() && Buffer.byteLength(developerInstructions) <= MAX_INSTRUCTION_CONTENT_BYTES
      ? { content: developerInstructions }
      : unavailable(
          developerInstructions?.trim()
            ? "The captured instructions exceed the viewer limit."
            : "No generated instructions were configured for this snapshot.",
        );
  const fallback = {
    generated,
    sources: snapshot.instructionSources.map(() => unavailable(PENDING)),
  };
  const contents = await withReadBudget(
    (signal) => captureFileContents(snapshot, rolloutPath, generated, signal),
    fallback,
  );
  return { ...snapshot, contents };
}

async function captureFileContents(
  snapshot: CodexInstructionSnapshot,
  rolloutPath: unknown,
  generated: CapturedInstructionContent,
  signal: AbortSignal,
): Promise<NonNullable<CodexInstructionSnapshot["contents"]>> {
  if (!snapshot.instructionSourcesReported || snapshot.instructionSources.length === 0)
    return { generated, sources: [] };
  const rollout = await captureCodexInstructionRolloutBoundary(rolloutPath, snapshot.threadId);
  const candidates: SourceCandidate[] = [];
  let budget = MAX_CAPTURE_BYTES;
  for (const source of snapshot.instructionSources) {
    if (signal.aborted) break;
    const candidate =
      rollout && candidates.length < MAX_SOURCE_COUNT && budget > 0
        ? await readSourceCandidate(source.path, Math.min(budget, MAX_INSTRUCTION_CONTENT_BYTES))
        : { bytes: null, unavailableReason: "Native instruction capture is unavailable for this source." };
    if (candidate.bytes) budget -= Buffer.byteLength(candidate.bytes, "base64");
    candidates.push(candidate);
  }
  return {
    generated,
    sources: candidates.map((candidate) => unavailable(candidate.unavailableReason ?? PENDING)),
    evidence: { ...(rollout ? { rollout } : {}), candidates },
  };
}

/** Resolve a source index from retained, exact-thread evidence without rereading source files. */
export async function resolveCapturedInstructionContent(
  snapshot: CodexInstructionSnapshot,
  source: string,
): Promise<CapturedInstructionContent> {
  if (source === "generated")
    return snapshot.contents?.generated ?? unavailable("This snapshot predates instruction-content capture.");
  if (!/^(0|[1-9]\d*)$/.test(source)) return unavailable("The requested instruction source is unavailable.");
  const index = Number(source);
  if (!Number.isSafeInteger(index) || index >= snapshot.instructionSources.length)
    return unavailable("The requested instruction source is unavailable.");
  const captured = snapshot.contents?.sources[index];
  if (captured?.content !== null && captured?.content !== undefined) return captured;
  const evidence = snapshot.contents?.evidence;
  if (!evidence?.rollout) return captured ?? unavailable("This snapshot predates instruction-content capture.");
  const nativeText = await withReadBudget(
    () => readCapturedCodexInstructionText(evidence.rollout!, snapshot.threadId),
    null,
  );
  if (nativeText === null) return captured ?? unavailable(PENDING);
  const correlated = correlateSources(snapshot, evidence.candidates, nativeText);
  if (!correlated) return unavailable("Native thread text could not be matched to the captured instruction sources.");
  if (snapshot.contents) snapshot.contents.sources = correlated.map((content) => ({ content }));
  return { content: correlated[index] };
}

function unavailable(unavailableReason: string): CapturedInstructionContent {
  return { content: null, unavailableReason };
}

async function readSourceCandidate(path: string, limit: number): Promise<SourceCandidate> {
  const supported = (value: string) => ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"].includes(basename(value));
  if (!isAbsolute(path) || !supported(path))
    return { bytes: null, unavailableReason: "This source is outside supported instruction-file boundaries." };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const target = await realpath(path);
    // Instruction aliases must not turn the viewer into an auth/config-file reader.
    if (!supported(target))
      return { bytes: null, unavailableReason: "This source resolves outside supported instruction-file boundaries." };
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return { bytes: null, unavailableReason: "The instruction source is not a regular file." };
    const buffer = Buffer.alloc(Math.min(before.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== buffer.length ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return { bytes: null, unavailableReason: "The instruction source changed during capture." };
    return { bytes: buffer.toString("base64") };
  } catch {
    return { bytes: null, unavailableReason: "The instruction source could not be captured in this environment." };
  } finally {
    await handle?.close().catch(() => console.warn("[codex-instructions] Could not close source-capture reader."));
  }
}

function correlateSources(
  snapshot: CodexInstructionSnapshot,
  candidates: SourceCandidate[],
  nativeText: string,
): string[] | null {
  if (snapshot.instructionSources.length !== candidates.length || !candidates.length) return null;
  const contents: string[] = [];
  let remaining = nativeText;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (candidate.bytes === null) return null;
    const bytes = Buffer.from(candidate.bytes, "base64");
    const global = snapshot.instructionSources[index].kind === "global";
    const text = global ? bytes.toString("utf8").trim() : bytes.toString("utf8");
    if (!text.trim()) return null;
    if (index === candidates.length - 1) {
      if (!remaining.trim()) return null;
      if (global ? text !== remaining : !isDecodedPrefix(bytes, remaining)) return null;
      if (Buffer.byteLength(remaining) > MAX_INSTRUCTION_CONTENT_BYTES) return null;
      contents.push(remaining);
      return contents;
    }
    const nextIsGlobal = snapshot.instructionSources[index + 1].kind === "global";
    if (nextIsGlobal) return null;
    const prefix = text + (global ? PROJECT_SEPARATOR : "\n\n");
    if (!remaining.startsWith(prefix)) return null;
    if (Buffer.byteLength(text) > MAX_INSTRUCTION_CONTENT_BYTES) return null;
    contents.push(text);
    remaining = remaining.slice(prefix.length);
  }
  return null;
}

function isDecodedPrefix(bytes: Buffer, text: string): boolean {
  // Codex truncates the final repository entry by raw bytes before lossy UTF-8 decoding.
  // Searching decoded length also handles a cut through a multibyte character.
  let low = 0;
  let high = bytes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bytes.subarray(0, middle).toString("utf8").length < text.length) low = middle + 1;
    else high = middle;
  }
  for (let end = low; end <= bytes.length; end++) {
    const decoded = bytes.subarray(0, end).toString("utf8");
    if (decoded === text) return true;
    if (decoded.length > text.length) return false;
  }
  return false;
}

async function withReadBudget<T>(operation: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), READ_BUDGET_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
