#!/usr/bin/env bun
/**
 * Takode CLI - cross-session orchestration commands.
 * Server-authoritative orchestration commands.
 */

import { handlePort } from "./takode-port.js";
import { handleBoard } from "./takode-board.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  err,
  formatInlineText,
  formatTimestampCompact,
  getBase,
  hasHelpFlag,
  stripGlobalFlags,
} from "./takode-core.js";
import { handleFileResolve } from "./takode-file-resolve.js";
import { handleGoal } from "./takode-goal-commands.js";
import { printCommandHelp, printUsage } from "./takode-help.js";
import { handleLease } from "./takode-lease.js";
import { handleExport, handleGrep, handleLogs, handlePeek, handleRead, handleScan } from "./takode-message-commands.js";
import { handleBranch, handleRefreshBranch, handleTimer } from "./takode-misc-commands.js";
import { handleTodo } from "./takode-todo-commands.js";
import {
  handleAnswer,
  handleArchive,
  handleHerd,
  handleInterrupt,
  handleNotify,
  handlePause,
  handlePending,
  handlePhases,
  handleRename,
  handleSearch,
  handleSend,
  handleSetBase,
  handleSpawn,
  handleThread,
  handleUnpause,
  handleUnherd,
  handleWorkerStream,
} from "./takode-orchestration-commands.js";
import { handlePermission } from "./takode-permission-commands.js";
import { handleReconnect } from "./takode-reconnect.js";
import { handleWorktreeCleanup } from "./takode-worktree-cleanup.js";
import {
  handleInfo,
  handleLeaderContextResume,
  handleList,
  handleTasks,
  handleTimers,
} from "./takode-session-commands.js";

type CommandAccess = {
  requireOrchestrator?: boolean;
  allowSessionlessRead?: boolean;
};

async function ensureTakodeAccess(base: string, options?: { requireOrchestrator?: boolean }): Promise<void> {
  const me = (await apiGet(base, "/takode/me")) as { isOrchestrator?: boolean };
  if (options?.requireOrchestrator && me.isOrchestrator !== true) {
    err("takode commands require an orchestrator session.");
  }
}

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = stripGlobalFlags(rawArgs);
const base = getBase(rawArgs);

try {
  const commandAccess = new Map<string, CommandAccess>([
    ["list", { allowSessionlessRead: true }],
    ["search", { allowSessionlessRead: true }],
    ["info", { allowSessionlessRead: true }],
    ["leader-context-resume", {}],
    ["file-resolve", {}],
    ["tasks", { allowSessionlessRead: true }],
    ["timers", {}],
    ["scan", { allowSessionlessRead: true }],
    ["peek", { allowSessionlessRead: true }],
    ["read", { allowSessionlessRead: true }],
    ["grep", { allowSessionlessRead: true }],
    ["logs", {}],
    ["export", { allowSessionlessRead: true }],
    ["send", { requireOrchestrator: true }],
    ["reconnect", { requireOrchestrator: true }],
    ["pause", { requireOrchestrator: true }],
    ["unpause", { requireOrchestrator: true }],
    ["goal", { requireOrchestrator: true }],
    ["thread", { requireOrchestrator: true }],
    ["rename", { requireOrchestrator: true }],
    ["herd", { requireOrchestrator: true }],
    ["unherd", { requireOrchestrator: true }],
    ["interrupt", { requireOrchestrator: true }],
    ["archive", { requireOrchestrator: true }],
    ["pending", { requireOrchestrator: true }],
    ["answer", { requireOrchestrator: true }],
    ["set-base", {}],
    ["refresh-branch", {}],
    ["branch", {}],
    ["notify", {}],
    ["worker-stream", {}],
    ["phases", {}],
    ["board", {}],
    ["port", {}],
    ["timer", {}],
    ["todo", {}],
    ["lease", {}],
    ["permission", { requireOrchestrator: true }],
    ["worktree-cleanup", { requireOrchestrator: true }],
  ]);
  if (!command || command === "-h" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  if (command === "help") {
    const helpTarget = args[0];
    if (!helpTarget) {
      printUsage();
      process.exit(0);
    }
    if (!printCommandHelp(helpTarget, args.slice(1))) {
      console.error(`Unknown command: ${helpTarget}`);
      printUsage();
      process.exit(1);
    }
    process.exit(0);
  }

  const wantsHelp = hasHelpFlag(args);
  if (wantsHelp) {
    if (!printCommandHelp(command, args)) {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
    process.exit(0);
  }
  const access = command ? commandAccess.get(command) : undefined;
  if (access && !access.allowSessionlessRead) {
    await ensureTakodeAccess(base, access);
  }

  switch (command) {
    case "list":
      await handleList(base, args);
      break;
    case "search":
      await handleSearch(base, args);
      break;
    case "info":
      await handleInfo(base, args);
      break;
    case "leader-context-resume":
      await handleLeaderContextResume(base, args);
      break;
    case "file-resolve":
      await handleFileResolve(base, args);
      break;
    case "spawn":
      await handleSpawn(base, args);
      break;
    case "interrupt":
      await handleInterrupt(base, args);
      break;
    case "archive":
      await handleArchive(base, args);
      break;
    case "tasks":
      await handleTasks(base, args);
      break;
    case "timers":
      await handleTimers(base, args);
      break;
    case "scan":
      await handleScan(base, args);
      break;
    case "peek":
      await handlePeek(base, args);
      break;
    case "read":
      await handleRead(base, args);
      break;
    case "grep":
      await handleGrep(base, args);
      break;
    case "logs":
      await handleLogs(base, args);
      break;
    case "export":
      await handleExport(base, args);
      break;
    case "send":
      await handleSend(base, args);
      break;
    case "reconnect":
      await handleReconnect(base, args);
      break;
    case "pause":
      await handlePause(base, args);
      break;
    case "unpause":
      await handleUnpause(base, args);
      break;
    case "goal":
      await handleGoal(base, args);
      break;
    case "thread":
      await handleThread(base, args);
      break;
    case "rename":
      await handleRename(base, args);
      break;
    case "herd":
      await handleHerd(base, args);
      break;
    case "unherd":
      await handleUnherd(base, args);
      break;
    case "pending":
      await handlePending(base, args);
      break;
    case "answer":
      await handleAnswer(base, args);
      break;
    case "set-base":
      await handleSetBase(base, args);
      break;
    case "refresh-branch":
      await handleRefreshBranch(base, args);
      break;
    case "branch":
      await handleBranch(base, args);
      break;
    case "notify":
      await handleNotify(base, args);
      break;
    case "worker-stream":
      await handleWorkerStream(base, args);
      break;
    case "phases":
      await handlePhases(base, args);
      break;
    case "port":
      await handlePort(base, args);
      break;
    case "board":
      await handleBoard(base, args);
      break;
    case "timer":
      await handleTimer(base, args);
      break;
    case "todo":
      await handleTodo(base, args);
      break;
    case "lease":
      await handleLease(args, {
        apiGet: (path) => apiGet(base, path),
        apiPost: (path, body) => apiPost(base, path, body),
        apiDelete: (path) => apiDelete(base, path),
        err,
        formatInlineText,
        formatTimestampCompact,
      });
      break;
    case "permission":
      await handlePermission(base, args);
      break;
    case "worktree-cleanup":
      await handleWorktreeCleanup(base, args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
  process.exit(0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    console.error(JSON.stringify({ error: "Cannot connect to Companion server. Is it running?" }));
  } else {
    console.error(JSON.stringify({ error: message }));
  }
  process.exit(1);
}
