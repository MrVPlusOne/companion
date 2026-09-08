import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

// Mock randomUUID and randomBytes so session IDs and auth tokens are deterministic
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    randomUUID: () => "test-session-id",
    randomBytes: (n: number) => ({ toString: () => "a".repeat(n * 2) }),
  };
});

// Mock child_process.exec to prevent actual git commands from running in tests
const mockExec = vi.hoisted(() =>
  vi.fn((_cmd: string, _opts: any, cb: any) => {
    if (_cmd.includes("git --no-optional-locks ls-files --error-unmatch --")) {
      const err = Object.assign(new Error("Command failed: git ls-files"), {
        code: 1,
        stderr: "error: pathspec '.claude/settings.json' did not match any file(s) known to git",
      });
      if (typeof _opts === "function") {
        _opts(err, "", "");
        return;
      }
      if (cb) cb(err, "", "");
      return;
    }
    // Simulate immediate success (exec callback signature: err, stdout, stderr)
    if (typeof _opts === "function") {
      _opts(null, "", "");
      return;
    }
    if (cb) cb(null, "", "");
  }),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    exec: mockExec,
  };
});

// Mock path-resolver for binary resolution
const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string): string | null => "/usr/bin/claude"));
const mockGetEnrichedPath = vi.hoisted(() => vi.fn(() => "/usr/bin:/usr/local/bin"));
const mockCaptureUserShellPath = vi.hoisted(() => vi.fn(() => "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((): Record<string, string> => ({})));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  getEnrichedPath: mockGetEnrichedPath,
  captureUserShellPath: mockCaptureUserShellPath,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

// Mock container-manager for container validation in relaunch
const mockIsContainerAlive = vi.hoisted(() => vi.fn((): "running" | "stopped" | "missing" => "running"));
const mockHasBinaryInContainer = vi.hoisted(() => vi.fn((): boolean => true));
const mockStartContainer = vi.hoisted(() => vi.fn());
vi.mock("./container-manager.js", () => ({
  containerManager: {
    isContainerAlive: mockIsContainerAlive,
    hasBinaryInContainer: mockHasBinaryInContainer,
    startContainer: mockStartContainer,
  },
}));

// Mock fs operations for worktree guardrails (CLAUDE.md in .claude dirs)
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((..._args: any[]) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn((..._args: any[]) => ""));
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockUnlinkSync = vi.hoisted(() => vi.fn());
const mockSymlinkSync = vi.hoisted(() => vi.fn());
const mockLstatSync = vi.hoisted(() =>
  vi.fn((_path?: string): any => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const isMockedPath = vi.hoisted(() => (path: string): boolean => {
  return (
    path.includes(".claude") ||
    path.includes(".codex") ||
    path.includes(".companion") ||
    path.startsWith("/tmp/worktrees/") ||
    path.startsWith("/tmp/main-repo")
  );
});

// Async mock functions for node:fs/promises — delegate to sync mocks so test
// setups (mockExistsSync.mockImplementation, mockReadFileSync.mockImplementation, etc.)
// and assertions (expect(mockSymlinkSync).toHaveBeenCalledWith, etc.) still work.
const mockMkdir = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockMkdirSync(...args);
  }),
);
const mockAccess = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    if (!mockExistsSync(args[0])) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
);
const mockReadFile = vi.hoisted(() => vi.fn(async (...args: any[]) => mockReadFileSync(...args)));
const mockCopyFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockCp = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => {
    // no-op for mocked paths
  }),
);
const mockReaddir = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any[]> => []));
const mockStat = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => ({
    isFile: () => true,
    mtimeMs: 1,
  })),
);
const mockRealpath = vi.hoisted(() => vi.fn(async (...args: any[]) => args[0]));
const mockWriteFile = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockWriteFileSync(...args);
  }),
);
const mockUnlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockUnlinkSync(...args);
  }),
);
const mockSymlink = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => {
    mockSymlinkSync(...args);
  }),
);
const mockLstat = vi.hoisted(() => vi.fn(async (...args: any[]) => mockLstatSync(...args)));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdirSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdirSync(...args);
      }
      return actual.mkdirSync(...args);
    },
    existsSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockExistsSync(...args);
      }
      return actual.existsSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFileSync(...args);
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFileSync(...args);
      }
      return actual.writeFileSync(...args);
    },
    unlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlinkSync(...args);
      }
      return actual.unlinkSync(...args);
    },
    symlinkSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlinkSync(...args);
      }
      return actual.symlinkSync(...args);
    },
    lstatSync: (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstatSync(...args);
      }
      return actual.lstatSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    mkdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockMkdir(...args);
      }
      return actual.mkdir(...args);
    },
    access: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockAccess(...args);
      }
      return actual.access(...args);
    },
    readFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReadFile(...args);
      }
      return actual.readFile(...args);
    },
    copyFile: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCopyFile(...args);
      }
      return actual.copyFile(...args);
    },
    cp: async (...args: any[]) => {
      if (
        (typeof args[0] === "string" && isMockedPath(args[0])) ||
        (typeof args[1] === "string" && isMockedPath(args[1]))
      ) {
        return mockCp(...args);
      }
      return actual.cp(...args);
    },
    readdir: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockReaddir(...args);
      }
      return actual.readdir(...args);
    },
    stat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockStat(...args);
      }
      return actual.stat(...args);
    },
    writeFile: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockWriteFile(...args);
      }
      return actual.writeFile(...args);
    },
    unlink: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockUnlink(...args);
      }
      return actual.unlink(...args);
    },
    symlink: async (...args: any[]) => {
      // symlink(target, path) — route by target path
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockSymlink(...args);
      }
      return actual.symlink(...args);
    },
    lstat: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockLstat(...args);
      }
      return actual.lstat(...args);
    },
    realpath: async (...args: any[]) => {
      if (typeof args[0] === "string" && isMockedPath(args[0])) {
        return mockRealpath(...args);
      }
      return actual.realpath(...args);
    },
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { createLauncherHerdChangeHandler } from "./herd-change-handler.js";
import type { TakodeEvent, TakodeHerdReassignedEventData } from "./session-types.js";

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────

let exitResolve: (code: number) => void;

function createMockProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdout: null,
    stderr: null,
  };
}

function createMockCodexProc(pid = 12345) {
  let resolve: (code: number) => void;
  const exitedPromise = new Promise<number>((r) => {
    resolve = r;
  });
  exitResolve = resolve!;
  return {
    pid,
    kill: vi.fn(),
    exited: exitedPromise,
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>(),
  };
}

const mockSpawn = vi.fn();
const bunGlobal = globalThis as typeof globalThis & { Bun?: any };
const hadBunGlobal = typeof bunGlobal.Bun !== "undefined";
const originalBunSpawn = hadBunGlobal ? bunGlobal.Bun!.spawn : undefined;
if (hadBunGlobal) {
  // In Bun runtime, globalThis.Bun is non-configurable; patch spawn directly.
  (bunGlobal.Bun as { spawn?: unknown }).spawn = mockSpawn;
} else {
  bunGlobal.Bun = { spawn: mockSpawn };
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let store: SessionStore;
let launcher: CliLauncher;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-apply default: lstatSync throws ENOENT (file doesn't exist), matching real behavior
  mockLstatSync.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  delete process.env.COMPANION_CONTAINER_SDK_HOST;
  delete process.env.COMPANION_FORCE_BYPASS_IN_CONTAINER;
  tempDir = mkdtempSync(join(tmpdir(), "launcher-test-"));
  store = new SessionStore(tempDir);
  launcher = new CliLauncher(3456, { serverId: "test-server-id" });
  launcher.setStore(store);
  mockSpawn.mockReturnValue(createMockProc());
  mockResolveBinary.mockReturnValue("/usr/bin/claude");
  mockGetEnrichedPath.mockReturnValue("/usr/bin:/usr/local/bin");
  mockCaptureUserShellPath.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  mockCaptureUserShellEnv.mockReturnValue({});
  mockCopyFile.mockReset();
  mockReaddir.mockReset();
  mockStat.mockReset();
  mockReaddir.mockResolvedValue([]);
  mockStat.mockResolvedValue({
    isFile: () => true,
    mtimeMs: 1,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  if (hadBunGlobal) {
    (bunGlobal.Bun as { spawn?: unknown }).spawn = originalBunSpawn;
  } else {
    delete bunGlobal.Bun;
  }
});

// ─── launch ──────────────────────────────────────────────────────────────────

describe("getOrchestratorGuardrails", () => {
  it.each(["claude", "codex"] as const)("launches %s leaders with compact design-to-delivery pointers", (backend) => {
    const guardrails = launcher.getOrchestratorGuardrails(backend);

    // Exercise the launcher-facing path without duplicating the lifecycle owner's
    // full separation and delivery-evidence checklist.
    expect(guardrails).toContain("Keep one intended design-and-build outcome in one quest");
    expect(guardrails).toContain("resume same-quest implementation");
    expect(guardrails).toContain("close as design-only");
    expect(guardrails).toContain("create a separate implementation successor");
    expect(guardrails).toContain("Apply the user-approved continuation");
    expect(guardrails).toContain("revises a still-design-only title");
    expect(guardrails).toContain("updates any stale description/TLDR before clearing the wait or resuming Work");
    expect(guardrails).toContain("final Memory is only the backstop");
    expect(guardrails).toContain("returns the current quest to its assigned worker in Work");
    expect(guardrails).toContain("Same-quest routing continues implementation");
    expect(guardrails).toContain("design-only or successor routing closes the current accepted scope");
    expect(guardrails).toContain("return the current quest to its assigned worker in Work for continuation or closure");
    expect(guardrails).toContain("Technical Work and that transition remain worker-owned");
    expect(guardrails).toContain("Verify delivery before claiming testability");
    expect(guardrails).toContain("Apply the delivery-evidence checklist in `quest-journey.md`");
    expect(guardrails).toContain("separation, reopening, active-successor, and evidence rules");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/user-checkpoint/leader.md`");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/work/leader.md`");
    expect(guardrails).toContain("The Work leader brief remains the complete owner of recovery behavior");
    expect(guardrails).toContain("That brief owns the complete recovery rule");
    expect(guardrails).toContain("Report accepted Work before Memory closure");
    expect(guardrails).toContain("accepted-Work response normally carries the substantive user-facing answer");
    // Both backend launch paths must teach the supplied-reference workflow,
    // without restoring a mandatory lookup or split answer for routing alone.
    expect(guardrails).toContain("Use the supplied user-message IDs and available conversation context");
    expect(guardrails).toContain("inspect source messages or earlier answers only when needed");
    expect(guardrails).toContain("Answers may cover nonconsecutive IDs and messages with different owning threads");
    expect(guardrails).toContain("Do not discover numeric history indices, attach the answer, or duplicate its prose");
    expect(guardrails).toContain("Each thread receives coverage only for its own referenced user requests");
    expect(guardrails).not.toContain("retrieve or reread every listed user message");
    expect(guardrails).not.toContain("single authoritative owner shared by every covered ID");
    expect(guardrails).toContain("Apply `explain-clearly` for substantial answers");
    expect(guardrails).toContain("every valid answer remains visible in source chronology");
    expect(guardrails).toContain("Routine Memory completion is routed commentary/status");
    expect(guardrails).toContain("publish routine Memory closure with `[thread:q-N:C]`");
    expect(guardrails).toContain("renders the quest quiz on the turn that carries the directive");
    expect(guardrails).not.toContain("publish the polished completion answer");
    expect(guardrails).not.toContain("actual answer-turn host");
    expect(guardrails).toContain("--work-note <feedback-index> --commit <sha>");
    expect(guardrails).toContain("Genuine zero-git-tracked-change Work uses the mutually exclusive `--no-code` mode");
    expect(guardrails).toContain("older quest commits do not replace it");
    expect(guardrails).toContain("The transition attaches code metadata before entering Memory");
    expect(guardrails).toContain("direct approved optional checkpoint immediately before Memory");
    expect(guardrails).toContain("`--skip-optional-checkpoint <reason>`");
    expect(guardrails).toContain("Required or taken checkpoints must be followed by later Work before Memory");
    expect(guardrails).toContain(
      "generic advance may resume repeated plans into later Work but may not skip directly into Memory",
    );
    expect(guardrails).toContain("route back to Work instead of first-attaching them during Memory");
    expect(guardrails).toContain("Memory may attach only separate file-based memory-repository commits");
    expect(guardrails).toContain("`--memory-commit` / `--memory-commits`");
    expect(guardrails).toContain("the worker stops the Work turn");
    expect(guardrails).toContain("Ordinary read-only follow-ups during Memory use accepted evidence without reopening");
    expect(guardrails).not.toContain("genuinely optional or deferred work");
    expect(guardrails).not.toContain("accepted Work evidence, synchronized commit or artifact metadata");
  });

  it("returns Claude-family guardrails with skill loading and sub-skill references", () => {
    // getOrchestratorGuardrails returns a trimmed system prompt that references
    // sub-skill files for detailed workflows. Detailed content (worker selection
    // rules, full quest journey transitions, CLI docs) lives in sub-skill .md files.
    const guardrails = launcher.getOrchestratorGuardrails("claude");
    expect(guardrails).toContain("Takode -- Cross-Session Orchestration");
    // CLI, quest, and leader-dispatch references point to skills loaded on startup
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("leader-dispatch");
    expect(guardrails).toContain("confirm");
    expect(guardrails).toContain("quest");
    expect(guardrails).toContain("`leader-decision-communication`");
    expect(guardrails).toContain("sole complete owner of decision-first wording");
    expect(guardrails).toContain("/quest-design");
    expect(guardrails).toContain("## Durable Names in Handoffs");
    expect(guardrails).toContain("keep quest IDs out of the Takode-external durable names");
    expect(guardrails).toContain("Do not ask for a `q-N`-specific destination, filename, job label");
    expect(guardrails).toContain("commit message, or PR description");
    expect(guardrails).toContain("quest links, phase notes, board state, or memory metadata");
    expect(guardrails).toContain("sub-agent");
    // Core leader behaviors remain inline
    expect(guardrails).toContain("Create a quest for any non-trivial work");
    expect(guardrails).toContain("Never implement non-trivial changes yourself");
    // Quest Journey phase table kept inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("QUEUED");
    expect(guardrails).toContain("WORKING");
    expect(guardrails).toContain("Memory");
    expect(guardrails).toContain("separate review quest");
    expect(guardrails).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/leader.md`");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/assignee.md`");
    expect(guardrails).toContain("one confirmation can approve quest text, Journey, and dispatch plan");
    expect(guardrails).toContain(
      "Direct create/dispatch is allowed only for clear, low-risk, reversible repo-local work",
    );
    expect(guardrails).toContain("Pre-dispatch approval remains mandatory for ambiguous");
    expect(guardrails).toContain("Use delayed approval via User Checkpoint");
    expect(guardrails).toContain("visible chat approval surface is for the user's decision, not worker grounding");
    expect(guardrails).toContain("make it read like a TLDR for approval");
    expect(guardrails).toContain("Keep the quest record intent-first and self-contained");
    expect(guardrails).toContain("useful evidence or context a worker could not reasonably recover");
    expect(guardrails).toContain("leave unconfirmed leader ideas and detailed planning to Work");
    expect(guardrails).not.toContain("Move most detailed grounding, evidence, acceptance bullets, non-goals");
    expect(guardrails).toContain("Use the scannable shape");
    expect(guardrails).toContain("preserve judgment, but expand only for ambiguity");
    expect(guardrails).toContain("authorized Journey to the board before or with dispatch");
    expect(guardrails).toContain("Work Board");
    // Spawn backend default note
    expect(guardrails).toContain("default to your own backend type");
    expect(guardrails).toContain("The 5-slot limit applies to workers only");
    expect(guardrails).toContain("archiving reviewers does not free worker-slot capacity");
    // Skill references: /leader-dispatch for dispatch workflow, sub-files for quest-journey and board-usage
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("quest-journey.md");
    expect(guardrails).toContain("board-usage.md");
    // Leader discipline: wait for user answer, follow the board-approved Journey
    expect(guardrails).toContain("wait only on the affected scope");
    expect(guardrails).toContain("Follow the board-approved Quest Journey");
    expect(guardrails).toContain("recommended, not mandatory");
    expect(guardrails).toContain("After alignment approval, authorize Work and Memory");
    expect(guardrails).toContain("separate review quest");
    expect(guardrails).toContain("Every quest-backed dispatched task follows Quest Journey v2");
    expect(guardrails).toContain("direct worker errand");
    expect(guardrails).toContain("one-turn, context-rich, read-only draft");
    expect(guardrails).toContain("otherwise create or reopen a normal quest");
    expect(guardrails).toContain("Work is intentionally broader");
    expect(guardrails).toContain("Leader context is a scarce long-horizon resource");
    expect(guardrails).toContain("when there is no new context, a short Work authorization is sufficient");
    expect(guardrails).not.toContain("Leader-only deltas");
    expect(guardrails).not.toContain("Do not promote leader synthesis into accepted scope");
    expect(guardrails).toContain("System-interrupted worker `turn_end` herd events may be provisional");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/work/leader.md`");
    expect(guardrails).toContain("That brief owns the complete recovery rule");
    expect(guardrails).not.toContain("allow one short verification window");
    expect(guardrails).not.toContain("exact-once replay proof or recovery suppression");
    expect(guardrails).toContain("Route implementation follow-ups to context-rich sources");
    expect(guardrails).toContain("Use a direct worker errand only for one-turn");
    expect(guardrails).toContain("read-only technical clarification about an active or recently completed quest");
    expect(guardrails).toContain("prefer a short Takode follow-up to the responsible worker");
    expect(guardrails).toContain("accepted Work/Memory evidence before reopening source yourself");
    expect(guardrails).toContain("Do not create a quest or authorize changes for a clarification");
    expect(guardrails).toContain("User Checkpoint is a durable pause state inside the same Work occurrence");
    expect(guardrails).toContain("Apply `leader-decision-communication` before publishing");
    expect(guardrails).toContain("self-contained packet with findings, named options, key tradeoffs");
    expect(guardrails).toContain("exact requested answer");
    // Generated leader guardrails use neutral paired examples and retain conservative fallbacks.
    expect(guardrails).toContain("a material edit alone is not approval");
    expect(guardrails).toContain("One fresh reply may make one exact substitution");
    expect(guardrails).toContain('"Change the batch limit to 120" is edit-only');
    expect(guardrails).toContain('"Approve the bounded operation with batch limit 120" is edit-plus-approval');
    expect(guardrails).toContain("questions, vague/conditional/conflicting approval, ambiguous referents");
    expect(guardrails).toContain("dependent changes, changed monitor/stop conditions");
    expect(guardrails).toContain("changed safety implications/consequences/tradeoffs");
    expect(guardrails).toContain("fresh explicit approval before external consequences");
    expect(guardrails).toContain("Harmless typo-only corrections can still proceed");
    expect(guardrails).toContain("write the authorized Journey to the board before or with dispatch");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("repeated `takode peek` / `takode scan` checks");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Only inspect a worker after a herd event");
    expect(guardrails).toContain(
      "prefer the plain-text forms of `takode info`, `takode peek`, `takode scan`, and `quest show`",
    );
    expect(guardrails).toContain("Use `--json` only when you need exact structured fields");
    expect(guardrails).toContain("quest feedback list --json");
    expect(guardrails).toContain("quest feedback list/latest/show");
    expect(guardrails).toContain("`commitShas`");
    expect(guardrails).toContain("Leader File Links Across Worktrees");
    expect(guardrails).toContain("takode file-resolve --session <worker-or-reviewer> <path-or-file-link>");
    expect(guardrails).toContain(
      "[CHANGELOG.md:7](file:/Users/jiayiwei/.companion/worktrees/companion/jiayi-wt-9146/CHANGELOG.md:7)",
    );
    expect(guardrails).toContain("Repo-relative links remain appropriate after Port/main-repo sync");
    expect(guardrails).toContain("Make every worker instruction phase-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **alignment only**");
    expect(guardrails).toContain("Initial Journey authorization comes before dispatch");
    expect(guardrails).toContain("write the authorized Journey to the board before or with dispatch");
    expect(guardrails).toContain(
      "The worker alignment phase then returns a concise leader-verification read-in inside that authorized Journey",
    );
    expect(guardrails).toContain("not a broad planning report");
    expect(guardrails).toContain("broad implementation plans, exhaustive evidence inventories");
    expect(guardrails).toContain("not a routine second user-approval gate");
    expect(guardrails).toContain("Alignment approval is leader-owned by default");
    expect(guardrails).toContain("Escalate alignment back to the user only");
    expect(guardrails).toContain("significant ambiguity, scope change, Journey revision, user-visible tradeoff");
    expect(guardrails).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(guardrails).toContain("Fresh human feedback that changes accepted work resets the active cycle");
    expect(guardrails).toContain(
      "An ordinary read-only clarification during Memory does not reset or reopen the quest",
    );
    expect(guardrails).toContain("do not let stale old-scope completions advance the quest");
    expect(guardrails).toContain("zero-tracked-change quests");
    expect(guardrails).toContain("Work still produces the accepted artifact or finding");
    expect(guardrails).toContain("Pre-dispatch approval is conditional");
    expect(guardrails).toContain("The visible chat approval surface is for the user's decision");
    expect(guardrails).toContain("Use the scannable shape");
    expect(guardrails).toContain("optional sections should be omitted when they add no decision value");
    expect(guardrails).toContain("Fresh worker is the default");
    expect(guardrails).toContain("Queue quest work on the board yourself with `--wait-for`");
    expect(guardrails).toContain("Work still produces the accepted artifact or finding");
    expect(guardrails).toContain("sync/push when authorized");
    expect(guardrails).toContain("worker-owned Work -> Memory transition");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("allows clean behind-only worktrees");
    expect(guardrails).toContain("commits genuinely ahead of the current target/base branch");
    expect(guardrails).toContain("takode info` and sidebar counts may use a different session diff base");
    expect(guardrails).toContain("replacement preflight or explicit current target-ref verification");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md");
    expect(guardrails).toContain("Phase-note TLDRs should be 1-5 scan-friendly bullets or sentences");
    expect(guardrails).toContain("raw SHAs, branch names, exhaustive command lists");
    expect(guardrails).toContain("dedicated `Synced SHAs:` lines");
    expect(guardrails).toContain("Use value-based compression instead of hard length caps");
    expect(guardrails).toContain("file-by-file diff narration");
    expect(guardrails).toContain("Keep the memory boundary explicit");
    expect(guardrails).toContain("Non-Memory phases should not add routine `memory update not needed` statements");
    expect(guardrails).toContain("quest-backed updates should use `q-N`");
    expect(guardrails).toContain("should not routinely add `commit:*` or `session:*` sources");
    expect(guardrails).toContain("use explicit `--phase`, `--phase-position`, `--phase-occurrence`");
    expect(guardrails).toContain("Final Memory reports exactly one");
    expect(guardrails).toContain("Work -> Memory transition");
    expect(guardrails).toContain("quest metadata reconciliation");
    expect(guardrails).toContain("Final debrief TLDRs and routine user-facing summaries should describe");
    expect(guardrails).toContain("without repeating raw commit hashes already carried");
    expect(guardrails).toContain("Routine Memory completion is routed commentary/status");
    expect(guardrails).toContain("materially completes, corrects, or changes the earlier response");
    expect(guardrails).toContain("{[(Quest Quiz: q-N)]}");
    expect(guardrails).toContain("quest metadata reconciliation");
    expect(guardrails).toContain("sync/push when authorized");
    expect(guardrails).toContain("worker-owned Work -> Memory transition");
    expect(guardrails).toContain("A quest in `MEMORY` is downstream-unblocking");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("Final chat handoffs are compact pointers");
    expect(guardrails).toContain("raw commit hashes already carried");
    expect(guardrails).toContain("Separate Review Quests");
    expect(guardrails).toContain("independent judgment materially reduces risk");
    expect(guardrails).toContain("For investigation, design, or zero-tracked-change quests");
    expect(guardrails).toContain("Work still produces the accepted artifact or finding");
    expect(guardrails).toContain("worker-owned Work -> Memory transition");
    expect(guardrails).toContain("prefer `quest grep <pattern>` over manually scanning many `quest show` results");
    expect(guardrails).toContain("Use `quest list --text` for broad list filtering and `quest grep`");
    expect(guardrails).toContain("takode notify");
    expect(guardrails).toContain("needs-input");
    expect(guardrails).toContain("review");
    expect(guardrails).toContain("takode notify list");
    expect(guardrails).toContain("takode notify resolve <notification-id>");
    expect(guardrails).toContain("After the user answers a same-session `takode notify needs-input` prompt");
    expect(guardrails).toContain("Use this only for notifications created by your current session");
    expect(guardrails).toContain("Do not rely on deprecated leader reply suffixes");
    expect(guardrails).toContain("use role-bearing routed leader responses");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain(
      "publish the detailed question, options, or confirmation text with the appropriate role-bearing marker",
    );
    expect(guardrails).toContain("`[thread:main:C]`");
    expect(guardrails).toContain("`[thread:q-N:A:u1,u2]`");
    expect(guardrails).toContain("standalone `---` line immediately before each later role-bearing marker");
    expect(guardrails).toContain("then call `takode notify needs-input`");
    expect(guardrails).toContain("The visible thread text is the decision surface");
    expect(guardrails).toContain("New blocking prompt -> new `needs-input` notification");
    expect(guardrails).toContain(
      "existing unresolved prompts in the same thread or quest do not cover a separate approval or decision",
    );
    expect(guardrails).toContain("Link the affected active board row with `--wait-for-input` when applicable");
    expect(guardrails).toContain("takode notify list");
    expect(guardrails).toContain("takode notify resolve <notification-id>");
    expect(guardrails).toContain("After the user answers a same-session `takode notify needs-input` prompt");
    expect(guardrails).toContain("Use this only for notifications created by your current session");
    expect(guardrails).toContain("so the user never misses it");
    expect(guardrails).toContain("Fresh human feedback that changes accepted work outranks stale completions");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // Detailed content moved to sub-skill files, not inline
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("takode peek <session> [--from N]");
    expect(guardrails).not.toContain("Maintain at most 5 sessions");
    // Worker selection details now in /leader-dispatch skill
    expect(guardrails).not.toContain("Queue if the best worker is busy");
    // Full phase transitions now in quest-journey.md
    expect(guardrails).not.toContain("QUEUED -> PLANNING");
  });

  it("returns Codex guardrails without Claude-only or sub-agent guidance", () => {
    const guardrails = launcher.getOrchestratorGuardrails("codex");
    expect(guardrails).toContain("leader session");
    expect(guardrails).toContain("`leader-decision-communication`");
    expect(guardrails).toContain("sole complete owner of decision-first wording");
    expect(guardrails).toContain("Delegate all major work");
    expect(guardrails).toContain("delegate_task(task)");
    expect(guardrails).toContain("inspectable forked transcript");
    expect(guardrails).toContain("If the user explicitly asks you to use `delegate_task`");
    expect(guardrails).toContain("make your next action the actual MCP tool call");
    expect(guardrails).not.toContain("delegate_command(command)");
    expect(guardrails).toContain("## Durable Names in Handoffs");
    expect(guardrails).toContain("keep quest IDs out of the Takode-external durable names");
    expect(guardrails).toContain("Do not ask for a `q-N`-specific destination, filename, job label");
    expect(guardrails).toContain("commit message, or PR description");
    // Skill references for detailed workflows
    expect(guardrails).toContain("/leader-dispatch");
    expect(guardrails).toContain("/quest-design");
    expect(guardrails).toContain("quest-journey.md");
    // Quest Journey phase table inline as quick reference
    expect(guardrails).toContain("Quest Journey");
    expect(guardrails).toContain("Work");
    expect(guardrails).toContain("separate review quest");
    expect(guardrails).toContain("~/.companion/quest-journey-phases/<phase-id>/");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/leader.md`");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/alignment/assignee.md`");
    // CLI reference delegated to skill
    expect(guardrails).toContain("takode-orchestration");
    expect(guardrails).toContain("default to your own backend type");
    expect(guardrails).toContain("The 5-slot limit applies to workers only");
    expect(guardrails).toContain("archiving reviewers does not free worker-slot capacity");
    expect(guardrails).toContain("Do not use sleep-based waits");
    expect(guardrails).toContain("wait for the next herd event");
    expect(guardrails).toContain("Make every worker instruction phase-explicit");
    expect(guardrails).toContain("Initial dispatch authorizes **alignment only**");
    expect(guardrails).toContain("Initial Journey authorization comes before dispatch");
    expect(guardrails).toContain("write the authorized Journey to the board before or with dispatch");
    expect(guardrails).toContain("Follow the board-approved Quest Journey");
    expect(guardrails).toContain("Work is intentionally broader");
    expect(guardrails).toContain("Leader context is a scarce long-horizon resource");
    expect(guardrails).toContain("when there is no new context, a short Work authorization is sufficient");
    expect(guardrails).not.toContain("Leader-only deltas");
    expect(guardrails).not.toContain("Do not promote leader synthesis into accepted scope");
    expect(guardrails).toContain("System-interrupted worker `turn_end` herd events may be provisional");
    expect(guardrails).toContain("`~/.companion/quest-journey-phases/work/leader.md`");
    expect(guardrails).toContain("That brief owns the complete recovery rule");
    expect(guardrails).not.toContain("allow one short verification window");
    expect(guardrails).not.toContain("exact-once replay proof or recovery suppression");
    expect(guardrails).toContain("Route implementation follow-ups to context-rich sources");
    expect(guardrails).toContain("Use a direct worker errand only for one-turn");
    expect(guardrails).toContain("Do not create a quest or authorize changes for a clarification");
    expect(guardrails).toContain("USER_CHECKPOINTING");
    expect(guardrails).toContain("User Checkpoint");
    expect(guardrails).toContain("not a routine second user-approval gate");
    expect(guardrails).toContain("Alignment approval is leader-owned by default");
    expect(guardrails).toContain("Escalate alignment back to the user only");
    expect(guardrails).toContain("After alignment approval, authorize Work and Memory");
    expect(guardrails).toContain("point the worker at the exact prior messages, quests, or discussions");
    expect(guardrails).toContain("Pre-dispatch approval is conditional");
    expect(guardrails).toContain(
      "Direct create/dispatch is allowed only for clear, low-risk, reversible repo-local work",
    );
    expect(guardrails).toContain("Use delayed approval via User Checkpoint");
    expect(guardrails).toContain("a material edit alone is not approval");
    expect(guardrails).toContain("One fresh reply may make one exact substitution");
    expect(guardrails).toContain("no question or user choice remains");
    expect(guardrails).toContain("obtain fresh explicit approval before external consequences");
    expect(guardrails).toContain("exact action was explicitly approved and no ambiguity remains");
    expect(guardrails).toContain("The visible chat approval surface is for the user's decision");
    expect(guardrails).toContain("Use the scannable shape");
    expect(guardrails).toContain("optional sections should be omitted when they add no decision value");
    expect(guardrails).toContain("Fresh worker is the default");
    expect(guardrails).toContain("Queue quest work on the board yourself with `--wait-for`");
    expect(guardrails).toContain("Leaders do not own worker quests");
    expect(guardrails).toContain("worker doing the job claims and completes the quest");
    expect(guardrails).toContain("Archiving a worktree worker removes its worktree and any uncommitted changes");
    expect(guardrails).toContain("ported, committed, or otherwise synced");
    expect(guardrails).toContain("allows clean behind-only worktrees");
    expect(guardrails).toContain("commits genuinely ahead of the current target/base branch");
    expect(guardrails).toContain("takode info` and sidebar counts may use a different session diff base");
    expect(guardrails).toContain("replacement preflight or explicit current target-ref verification");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md");
    expect(guardrails).toContain("Phase-note TLDRs should be 1-5 scan-friendly bullets or sentences");
    expect(guardrails).toContain("raw SHAs, branch names, exhaustive command lists");
    expect(guardrails).toContain("dedicated `Synced SHAs:` lines");
    expect(guardrails).toContain("Use value-based compression instead of hard length caps");
    expect(guardrails).toContain("file-by-file diff narration");
    expect(guardrails).toContain("Keep the memory boundary explicit");
    expect(guardrails).toContain("include memory-specific evidence only when material");
    expect(guardrails).toContain("use explicit `--phase`, `--phase-position`, `--phase-occurrence`");
    expect(guardrails).toContain("Every active phase needs durable quest documentation");
    expect(guardrails).toContain("Worker-stream checkpoints are optional early visibility");
    expect(guardrails).toContain("raw commit hashes already carried");
    expect(guardrails).toContain("Work is intentionally broader");
    expect(guardrails).toContain("independent review is genuinely needed");
    expect(guardrails).toContain("If independent review is genuinely needed");
    expect(guardrails).toContain("Embedded review phases are not part of active Quest Journey v2");
    expect(guardrails).toContain("independent judgment materially reduces risk");
    expect(guardrails).toContain("separate review quest");
    expect(guardrails).toContain("separate review quest");
    expect(guardrails).toContain("Work is intentionally broader");
    expect(guardrails).toContain("worker-owned Work -> Memory transition");
    expect(guardrails).toContain("Work still produces the accepted artifact or finding");
    expect(guardrails).toContain("sync/push when authorized");
    expect(guardrails).toContain("Every time you ask the user a question");
    expect(guardrails).toContain(
      "publish the detailed question, options, or confirmation text with the appropriate role-bearing marker",
    );
    expect(guardrails).toContain("`[thread:main:C]`");
    expect(guardrails).toContain("`[thread:q-N:A:u1,u2]`");
    expect(guardrails).toContain("standalone `---` line immediately before each later role-bearing marker");
    expect(guardrails).toContain("then call `takode notify needs-input`");
    expect(guardrails).toContain("never as the only place options or tradeoffs appear");
    expect(guardrails).toContain("so the user never misses it");
    expect(guardrails).toContain("Do not rely on deprecated leader reply suffixes");
    expect(guardrails).toContain("Do **not** call `takode notify review` for quest completion");
    expect(guardrails).toContain("Takode already sends that review notification automatically");
    // No verbose CLI command docs
    expect(guardrails).not.toContain("takode list [--active] [--all]");
    expect(guardrails).not.toContain("CLAUDE.md");
    expect(guardrails).not.toContain("sub-agent");
    expect(guardrails).not.toMatch(/\bagent\b/i);
  });
});
