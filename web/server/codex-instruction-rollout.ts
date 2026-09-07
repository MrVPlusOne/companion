import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const HEADER_BYTES = 64 * 1024;
const EVIDENCE_BYTES = 2 * 1024 * 1024;

interface InstructionBaseline {
  known: boolean;
  text: string | null;
}

export interface CodexInstructionRolloutBoundary {
  path: string;
  offset: number;
  fileId?: string;
  baseline: InstructionBaseline;
}

type RecordValue = Record<string, unknown>;
type FileHandle = Awaited<ReturnType<typeof open>>;

/** Remember the exact producer rollout boundary without discovering or reading unrelated files. */
export async function captureCodexInstructionRolloutBoundary(
  path: unknown,
  threadId: string,
): Promise<CodexInstructionRolloutBoundary | undefined> {
  if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    if (!(await matchesThread(handle, stat.size, threadId))) return undefined;
    const baseline = { known: false, text: null } as InstructionBaseline;
    for (const record of await readRecords(handle, Math.max(0, stat.size - EVIDENCE_BYTES), stat.size)) {
      updateBaseline(baseline, record);
    }
    return { path, offset: stat.size, fileId: `${stat.dev}:${stat.ino}`, baseline };
  } catch (error) {
    // A fresh producer thread may not materialize its rollout before its first real turn.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, offset: 0, baseline: { known: false, text: null } };
    }
    return undefined;
  } finally {
    await closeHandle(handle);
  }
}

/** Return native instruction text only after a complete turn context proves this initialization was used. */
export async function readCapturedCodexInstructionText(
  boundary: CodexInstructionRolloutBoundary,
  threadId: string,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(boundary.path, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < boundary.offset) return null;
    if (boundary.fileId && boundary.fileId !== `${stat.dev}:${stat.ino}`) return null;
    if (!(await matchesThread(handle, stat.size, threadId))) return null;
    const baseline = { ...boundary.baseline };
    const end = Math.min(stat.size, boundary.offset + EVIDENCE_BYTES);
    for (const record of await readRecords(handle, boundary.offset, end)) {
      updateBaseline(baseline, record);
      const payload = object(record.payload);
      // Native context is persisted after initial instructions or resume reconciliation.
      // A pre-initialization context can never prove a new/cold-resumed snapshot.
      if (record.type === "turn_context" && typeof payload?.turn_id === "string") {
        return baseline.known ? baseline.text : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await closeHandle(handle);
  }
}

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function updateBaseline(baseline: InstructionBaseline, record: RecordValue): void {
  if (record.type === "instruction_evidence_invalid") {
    baseline.known = false;
    baseline.text = null;
  }
  const payload = object(record.payload);
  if (!payload) {
    if (record.type === "world_state") baseline.known = false;
    return;
  }
  // Older native producers retained the assembled text on every turn context.
  if (record.type === "turn_context" && Object.hasOwn(payload, "user_instructions")) {
    baseline.known = typeof payload.user_instructions === "string" || payload.user_instructions === null;
    baseline.text = typeof payload.user_instructions === "string" ? payload.user_instructions : null;
    return;
  }
  if (record.type !== "world_state") return;
  const state = object(payload.state);
  if (!state || typeof payload.full !== "boolean") {
    baseline.known = false;
    baseline.text = null;
    return;
  }
  if (payload.full === true) {
    baseline.known = true;
    baseline.text = null;
  }
  if (!Object.hasOwn(state, "agents_md")) return;
  const agents = object(state.agents_md);
  if (state.agents_md === null) {
    baseline.known = true;
    baseline.text = null;
  } else if (agents && Object.hasOwn(agents, "text")) {
    baseline.known = typeof agents.text === "string" || agents.text === null;
    baseline.text = typeof agents.text === "string" ? agents.text : null;
  } else if (!agents) {
    baseline.known = false;
    baseline.text = null;
  }
}

async function matchesThread(handle: FileHandle, fileSize: number, threadId: string): Promise<boolean> {
  const records = await readRecords(handle, 0, Math.min(fileSize, HEADER_BYTES));
  const first = records[0];
  const payload = object(first?.payload);
  // session_id may identify an entire native thread tree; id identifies this exact thread.
  return first?.type === "session_meta" && (payload?.id ?? payload?.thread_id ?? payload?.session_id) === threadId;
}

async function readRecords(handle: FileHandle, start: number, end: number): Promise<RecordValue[]> {
  const from = start > 0 ? start - 1 : 0;
  const buffer = Buffer.alloc(Math.max(0, end - from));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline < 0) return [];
    text = text.slice(firstNewline + 1);
  }
  const lines = text.split("\n");
  lines.pop(); // Never trust a partial trailing record.
  const records: RecordValue[] = [];
  for (const line of lines) {
    try {
      const record = object(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // Corrupt retained records cannot safely carry a baseline across this point.
      records.push({ type: "instruction_evidence_invalid" });
    }
  }
  return records;
}

async function closeHandle(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => console.warn("[codex-instructions] Could not close retained-evidence reader."));
}
