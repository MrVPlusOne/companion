import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCompactionRecoveryPrompt } from "../server/compaction-recovery-prompts.ts";
import { buildPeekDefault, buildPeekRange, buildPeekTurnScan } from "../server/takode-messages.ts";

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin?.end();

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const [code] = await once(child, "close");
  return { status: code as number | null, stdout, stderr };
}

function makeLongContent(prefix: string, fillerLength: number, marker: string): string {
  return `${prefix}${"x".repeat(fillerLength)} ${marker} ${"y".repeat(40)}`;
}

function makeWindowedContent(
  prefix: string,
  visiblePadding: number,
  visibleMarker: string,
  hiddenPadding: number,
  hiddenMarker: string,
): string {
  return `${prefix}${"x".repeat(visiblePadding)} ${visibleMarker} ${"y".repeat(hiddenPadding)} ${hiddenMarker} ${"z".repeat(40)}`;
}

describe("takode peek/scan source-aware truncation", () => {
  it("renders compact thread context and sends --thread filters for scan, peek, read, and grep", async () => {
    // CLI inspection should preserve thread context without requiring raw
    // message dumps. The mocked server uses the same projection helpers as the
    // real route so this exercises both compact metadata and plain rendering.
    const now = Date.now();
    const history = [
      {
        type: "user_message",
        content: "quest prompt",
        timestamp: now - 30_000,
        threadKey: "q-1289",
        questId: "q-1289",
        threadRefs: [{ threadKey: "q-1289", questId: "q-1289", source: "explicit" }],
      },
      {
        type: "assistant",
        timestamp: now - 20_000,
        threadKey: "q-1289",
        questId: "q-1289",
        threadRefs: [{ threadKey: "q-1289", questId: "q-1289", source: "explicit" }],
        threadStatusMarkers: [
          {
            kind: "waiting",
            label: "Thread Waiting",
            threadKey: "q-1298",
            questId: "q-1298",
            summary: "waiting on explore",
            messageId: "m-status",
            timestamp: now - 20_000,
            updatedAt: now - 20_000,
          },
        ],
        message: { content: [{ type: "text", text: "mixed q-1289 reply with needle" }] },
      },
      {
        type: "result",
        timestamp: now - 10_000,
        data: { duration_ms: 20_000, is_error: false, result: "mixed q-1289 reply with needle" },
      },
    ] as any[];

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-thread-cli", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=3&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Worker",
            status: "idle",
            quest: null,
            ...buildPeekTurnScan(history, { fromTurn: 0, turnCount: 3, threadKey: "q-1298" }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=3&from=0&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Worker",
            status: "idle",
            quest: null,
            ...buildPeekRange(history, { from: 0, count: 3, threadKey: "q-1298" }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Worker",
            status: "idle",
            quest: null,
            ...buildPeekDefault(history, { collapsedCount: 0, threadKey: "q-1298" }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?turnContaining=1&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Worker",
            status: "idle",
            quest: null,
            ...buildPeekRange(history, { from: 0, until: 2, threadKey: "q-1298" }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?turnContaining=0&threadKey=q-1298") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Message index 0 does not participate in thread q-1298" }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/1?threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 1,
            type: "assistant",
            ts: now - 20_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: "mixed q-1289 reply with needle",
            threadKey: "q-1289",
            questId: "q-1289",
            threadRefs: [{ threadKey: "q-1289", questId: "q-1289", source: "explicit" }],
            threadStatuses: [
              { kind: "waiting", threadKey: "q-1298", questId: "q-1298", summary: "waiting on explore" },
            ],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/grep?q=needle&limit=3&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId: "worker-153",
            sessionNum: 153,
            query: "needle",
            threadKey: "q-1298",
            totalMatches: 1,
            matches: [
              {
                idx: 1,
                type: "assistant",
                ts: now - 20_000,
                snippet: "mixed q-1289 reply with needle",
                turn: 0,
                threadKey: "q-1289",
                questId: "q-1289",
                threads: ["q-1289", "q-1298"],
                threadStatuses: [
                  { kind: "waiting", threadKey: "q-1298", questId: "q-1298", summary: "waiting on explore" },
                ],
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected ${method} ${url}` }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const env = {
        ...process.env,
        COMPANION_SESSION_ID: "leader-thread-cli",
        COMPANION_AUTH_TOKEN: "auth-thread-cli",
      };
      const scanResult = await runTakode(
        ["scan", "153", "--from", "0", "--count", "3", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const peekResult = await runTakode(
        ["peek", "153", "--from", "0", "--count", "3", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const defaultPeekResult = await runTakode(["peek", "153", "--thread", "q-1298", "--port", String(port)], env);
      const readResult = await runTakode(["read", "153", "1", "--thread", "q-1298", "--port", String(port)], env);
      const grepResult = await runTakode(
        ["grep", "153", "needle", "--count", "3", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const turnContainingResult = await runTakode(
        ["peek", "153", "--turn-containing", "1", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const turnContainingWrongThreadResult = await runTakode(
        ["peek", "153", "--turn-containing", "0", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const peekHelpResult = await runTakode(["help", "peek"], env);

      expect(scanResult.status).toBe(0);
      expect(scanResult.stdout).toContain("threads: q-1289, q-1298");
      expect(scanResult.stdout).not.toContain("status:");
      expect(scanResult.stdout).toContain("mixed q-1289 reply");

      expect(peekResult.status).toBe(0);
      expect(peekResult.stdout).toContain("[q-1289,q-1298]");

      expect(defaultPeekResult.status).toBe(0);
      expect(defaultPeekResult.stdout).toContain("threads: q-1289, q-1298");
      expect(defaultPeekResult.stdout).not.toContain("status:");

      expect(readResult.status).toBe(0);
      expect(readResult.stdout).toContain("threads: q-1289, q-1298");
      expect(readResult.stdout).toContain("status: q-1298 waiting: waiting on explore");

      expect(grepResult.status).toBe(0);
      expect(grepResult.stdout).toContain("[q-1289,q-1298]");
      expect(grepResult.stdout).not.toMatch(/\bassistant\s+turn\s+\d/);
      expect(grepResult.stdout).not.toMatch(/\bT\d+\b/);
      expect(grepResult.stdout).toContain("mixed q-1289 reply with needle");
      expect(grepResult.stdout).toContain("takode read 153 <msg-id> --thread q-1298");
      expect(grepResult.stdout).toContain("takode peek 153 --turn-containing <msg-id> --thread q-1298");

      expect(turnContainingResult.status).toBe(0);
      expect(turnContainingResult.stdout).toContain("--- Turn 0 ---");
      expect(turnContainingResult.stdout).toContain("[q-1289,q-1298]");

      expect(turnContainingWrongThreadResult.status).toBe(1);
      expect(turnContainingWrongThreadResult.stderr).toContain("Message index 0 does not participate in thread q-1298");

      expect(peekHelpResult.status).toBe(0);
      expect(peekHelpResult.stdout).toContain("--turn-containing msg-id");
      expect(peekHelpResult.stdout).toContain("takode peek 1 --turn-containing 42");
    } finally {
      server.close();
    }
  });

  it("preserves --thread filters in scan and range peek navigation hints", async () => {
    const now = Date.now();
    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-thread-hints", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=2&turnCount=2&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Hint Worker",
            status: "idle",
            quest: null,
            mode: "turn_scan",
            totalTurns: 10,
            totalMessages: 40,
            from: 2,
            count: 2,
            turns: [
              {
                turn: 2,
                si: 20,
                ei: 21,
                start: now - 20_000,
                end: now - 18_000,
                dur: 2_000,
                stats: { tools: 0, messages: 2, subagents: 0 },
                success: true,
                user: "thread prompt",
                result: "thread result",
                threads: ["q-1298"],
              },
              {
                turn: 3,
                si: 22,
                ei: 23,
                start: now - 17_000,
                end: now - 15_000,
                dur: 2_000,
                stats: { tools: 0, messages: 2, subagents: 0 },
                success: true,
                user: "next thread prompt",
                result: "next thread result",
                threads: ["q-1298"],
              },
            ],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=2&from=2&threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Hint Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 10,
            from: 2,
            to: 3,
            messages: [
              {
                idx: 2,
                type: "user",
                content: "thread prompt",
                ts: now - 20_000,
                threads: ["q-1298"],
              },
              {
                idx: 3,
                type: "assistant",
                content: "thread answer",
                ts: now - 19_000,
                threads: ["q-1298"],
              },
            ],
            bounds: [{ turn: 2, si: 2, ei: 3 }],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?threadKey=q-1298") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Thread Hint Worker",
            status: "idle",
            quest: null,
            mode: "default",
            totalTurns: 5,
            totalMessages: 10,
            collapsed: [
              {
                turn: 4,
                si: 8,
                ei: 9,
                start: now - 10_000,
                end: now - 8_000,
                dur: 2_000,
                stats: { tools: 0, messages: 2, subagents: 0 },
                success: true,
                user: "latest thread prompt",
                result: "latest thread result",
                threads: ["q-1298"],
              },
            ],
            omitted: 4,
            expanded: null,
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected ${method} ${url}` }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const env = {
        ...process.env,
        COMPANION_SESSION_ID: "leader-thread-hints",
        COMPANION_AUTH_TOKEN: "auth-thread-hints",
      };
      const scanResult = await runTakode(
        ["scan", "153", "--from", "2", "--count", "2", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const peekResult = await runTakode(
        ["peek", "153", "--from", "2", "--count", "2", "--thread", "q-1298", "--port", String(port)],
        env,
      );
      const defaultPeekResult = await runTakode(["peek", "153", "--thread", "q-1298", "--port", String(port)], env);

      expect(scanResult.status).toBe(0);
      expect(scanResult.stdout).toContain("Older: takode scan 153 --until 2 --count 2 --thread q-1298");
      expect(scanResult.stdout).toContain("Newer: takode scan 153 --from 4 --count 2 --thread q-1298");
      expect(scanResult.stdout).toContain("Expand: takode peek 153 --turn <N> --thread q-1298");
      expect(scanResult.stdout).toContain("Full message: takode read 153 <msg-id> --thread q-1298");

      expect(peekResult.status).toBe(0);
      expect(peekResult.stdout).toContain("Prev: takode peek 153 --until 2 --count 2 --thread q-1298");
      expect(peekResult.stdout).toContain("Next: takode peek 153 --from 4 --count 2 --thread q-1298");

      expect(defaultPeekResult.status).toBe(0);
      expect(defaultPeekResult.stdout).toContain(
        "... 4 earlier turns omitted (takode peek 153 --from 0 --thread q-1298 to browse)",
      );
    } finally {
      server.close();
    }
  });

  it("summarizes injected compaction recovery prompts in compact scan and peek output only", async () => {
    // Regression coverage for compact views: injected recovery prompts should
    // collapse to a template summary, while other long system-sourced messages
    // keep the normal agent-message window and full JSON read access remains.
    const prompt = getCompactionRecoveryPrompt("standard", "153");
    const ordinarySystemContent = makeLongContent("ordinary-system ", 100, "ORDINARY_SYSTEM_KEEP");
    const now = Date.now();
    const history = [
      {
        type: "user_message",
        content: prompt,
        timestamp: now - 80_000,
        agentSource: { sessionId: "system", sessionLabel: "System" },
      },
      {
        type: "assistant",
        timestamp: now - 70_000,
        message: { content: [{ type: "text", text: "recovered" }] },
      },
      {
        type: "result",
        timestamp: now - 60_000,
        data: { duration_ms: 20_000, is_error: false, result: "recovered" },
      },
      {
        type: "user_message",
        content: ordinarySystemContent,
        timestamp: now - 50_000,
        agentSource: { sessionId: "system", sessionLabel: "System" },
      },
      {
        type: "assistant",
        timestamp: now - 40_000,
        message: { content: [{ type: "text", text: "ordinary system message handled" }] },
      },
      {
        type: "result",
        timestamp: now - 30_000,
        data: { duration_ms: 20_000, is_error: false, result: "ordinary system message handled" },
      },
    ] as any[];

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-injected-compaction", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=2") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Injected Compaction Worker",
            status: "idle",
            quest: null,
            ...buildPeekTurnScan(history, { fromTurn: 0, turnCount: 2 }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=2&from=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Injected Compaction Worker",
            status: "idle",
            quest: null,
            ...buildPeekRange(history, { from: 0, count: 2 }),
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 0,
            type: "user_message",
            ts: now - 80_000,
            totalLines: prompt.split("\n").length,
            offset: 0,
            limit: 200,
            content: prompt,
            rawMessage: {
              type: "user_message",
              content: prompt,
              timestamp: now - 80_000,
              agentSource: { sessionId: "system", sessionLabel: "System" },
            },
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const env = {
        ...process.env,
        COMPANION_SESSION_ID: "leader-injected-compaction",
        COMPANION_AUTH_TOKEN: "auth-injected-compaction",
      };
      const scanResult = await runTakode(["scan", "153", "--from", "0", "--count", "2", "--port", String(port)], env);
      const peekResult = await runTakode(["peek", "153", "--from", "0", "--count", "2", "--port", String(port)], env);
      const readJsonResult = await runTakode(["read", "153", "0", "--json", "--port", String(port)], env);

      expect(scanResult.status).toBe(0);
      expect(scanResult.stdout).toContain("agent System:");
      expect(scanResult.stdout).toContain("[injected compaction recovery]");
      expect(scanResult.stdout).toContain("Context was compacted. Before continuing");
      expect(scanResult.stdout).not.toContain("memory catalog show");
      expect(scanResult.stdout).toContain("ORDINARY_SYSTEM_KEEP");
      expect(scanResult.stdout).not.toContain("ordinary-system [injected compaction recovery]");

      expect(peekResult.status).toBe(0);
      expect(peekResult.stdout).toContain("[injected compaction recovery]");
      expect(peekResult.stdout).not.toContain("memory catalog show");

      expect(readJsonResult.status).toBe(0);
      expect(readJsonResult.stdout).toContain("memory catalog show");
      expect(readJsonResult.stdout).toContain("takode read 153");
    } finally {
      server.close();
    }
  });

  it("gives scan human user prompts a generous window while keeping herd prompts aggressive", async () => {
    const userContent = makeWindowedContent("human-summary ", 1880, "USER_SCAN_KEEP", 220, "USER_SCAN_HIDE");
    const herdContent = makeLongContent("herd-summary ", 180, "HERD_SCAN_HIDE");
    const agentContent = makeLongContent("agent-summary ", 120, "AGENT_SCAN_KEEP");
    const now = Date.now();
    const history = [
      { type: "user_message", content: userContent, timestamp: now - 90_000 },
      {
        type: "assistant",
        timestamp: now - 75_000,
        message: { content: [{ type: "text", text: "user turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 60_000,
        data: { duration_ms: 30_000, is_error: false, result: "user turn done" },
      },
      {
        type: "user_message",
        content: herdContent,
        timestamp: now - 60_000,
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      },
      {
        type: "assistant",
        timestamp: now - 50_000,
        message: { content: [{ type: "text", text: "herd turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 40_000,
        data: { duration_ms: 20_000, is_error: false, result: "herd turn done" },
      },
      {
        type: "user_message",
        content: agentContent,
        timestamp: now - 30_000,
        agentSource: { sessionId: "session-7", sessionLabel: "#7 System Leader" },
      },
      {
        type: "assistant",
        timestamp: now - 20_000,
        message: { content: [{ type: "text", text: "agent turn done" }] },
      },
      {
        type: "result",
        timestamp: now - 10_000,
        data: { duration_ms: 20_000, is_error: false, result: "agent turn done" },
      },
    ] as any[];

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-scan-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=3") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Scan Worker",
            status: "idle",
            quest: null,
            ...buildPeekTurnScan(history, { fromTurn: 0, turnCount: 3 }),
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["scan", "153", "--from", "0", "--count", "3", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-scan-source",
        COMPANION_AUTH_TOKEN: "auth-scan-source",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("user:");
      expect(result.stdout).toContain("herd:");
      expect(result.stdout).toContain("agent #7:");
      expect(result.stdout).not.toContain("System Leader");
      expect(result.stdout).toContain("USER_SCAN_KEEP");
      expect(result.stdout).not.toContain("USER_SCAN_HIDE");
      expect(result.stdout).toContain("AGENT_SCAN_KEEP");
      expect(result.stdout).not.toContain("HERD_SCAN_HIDE");
    } finally {
      server.close();
    }
  });

  it("gives peek user messages more visible space than herd messages while keeping source provenance", async () => {
    const userContent = makeLongContent("peek-user ", 360, "USER_PEEK_KEEP");
    const herdContent = makeLongContent("peek-herd ", 360, "HERD_PEEK_HIDE");
    const agentContent = makeLongContent("peek-agent ", 220, "AGENT_PEEK_KEEP");

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-peek-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=3&from=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Peek Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 3,
            from: 0,
            to: 2,
            bounds: [{ turn: 0, si: 0, ei: 2 }],
            messages: [
              {
                idx: 0,
                type: "user",
                ts: Date.now() - 30_000,
                content: userContent,
              },
              {
                idx: 1,
                type: "user",
                ts: Date.now() - 20_000,
                content: herdContent,
                agent: { sessionId: "herd-events" },
              },
              {
                idx: 2,
                type: "user",
                ts: Date.now() - 10_000,
                content: agentContent,
                agent: { sessionId: "session-9", sessionLabel: "#9 System Worker" },
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["peek", "153", "--from", "0", "--count", "3", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-peek-source",
        COMPANION_AUTH_TOKEN: "auth-peek-source",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("user  ");
      expect(result.stdout).toContain("herd  ");
      expect(result.stdout).toContain("agent #9");
      expect(result.stdout).not.toContain("System Worker");
      expect(result.stdout).toContain("USER_PEEK_KEEP");
      expect(result.stdout).toContain("AGENT_PEEK_KEEP");
      expect(result.stdout).not.toContain("HERD_PEEK_HIDE");
    } finally {
      server.close();
    }
  });

  it("reveals the full timer source through an explicit firing ID while keeping ordinary reads compact", async () => {
    // Exact supplied source references are the explicit detail path; a large
    // automatic note must not make ordinary numeric reads more verbose.
    const content = `[⏰ Timer t1 reminder] Check progress\n${"x".repeat(20_000)} FIRING_DETAIL_END`;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          idx: 7,
          type: "user_message",
          ts: 1_700_000_000_000,
          totalLines: 2,
          offset: 0,
          limit: 200,
          content,
          rawMessage: { type: "user_message", agentSource: { sessionId: "timer:t1", sessionLabel: "Timer t1" } },
        }),
      );
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const env = { ...process.env, COMPANION_SESSION_ID: undefined, COMPANION_AUTH_TOKEN: undefined };
    try {
      const ordinary = await runTakode(["read", "153", "7", "--port", String(port)], env);
      const exact = await runTakode(["read", "153", "f2", "--port", String(port)], env);
      expect(ordinary.status).toBe(0);
      expect(ordinary.stdout).toContain("more chars hidden");
      expect(ordinary.stdout).not.toContain("FIRING_DETAIL_END");
      expect(exact.status).toBe(0);
      expect(exact.stdout).toContain("FIRING_DETAIL_END");
      expect(exact.stdout).not.toContain("more chars hidden");
      expect(requests).toEqual(["/api/sessions/153/messages/7", "/api/sessions/153/messages/f2"]);
    } finally {
      server.close();
    }
  });

  it("gives takode read a generous human user window while keeping herd reads shorter and labeled", async () => {
    const userContent = makeWindowedContent("read-user ", 1888, "READ_USER_KEEP", 220, "READ_USER_HIDE");
    const herdContent = makeWindowedContent("read-herd ", 120, "READ_HERD_KEEP", 120, "READ_HERD_HIDE");
    const agentContent = "read-agent READ_AGENT_KEEP";

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-read-source", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 0,
            type: "user_message",
            ts: Date.now() - 30_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: userContent,
            rawMessage: {
              type: "user_message",
              content: userContent,
              timestamp: Date.now() - 30_000,
            },
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 1,
            type: "user_message",
            ts: Date.now() - 20_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: herdContent,
            rawMessage: {
              type: "user_message",
              content: herdContent,
              timestamp: Date.now() - 20_000,
              agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
            },
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages/2") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            idx: 2,
            type: "user_message",
            ts: Date.now() - 10_000,
            totalLines: 1,
            offset: 0,
            limit: 200,
            content: agentContent,
            rawMessage: {
              type: "user_message",
              content: agentContent,
              timestamp: Date.now() - 10_000,
              agentSource: { sessionId: "session-11", sessionLabel: "#11 Long Agent Name" },
            },
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const userResult = await runTakode(["read", "153", "0", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read-source",
        COMPANION_AUTH_TOKEN: "auth-read-source",
      });
      const herdResult = await runTakode(["read", "153", "1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read-source",
        COMPANION_AUTH_TOKEN: "auth-read-source",
      });
      const agentResult = await runTakode(["read", "153", "2", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-read-source",
        COMPANION_AUTH_TOKEN: "auth-read-source",
      });

      expect(userResult.status).toBe(0);
      expect(userResult.stdout).toContain("[msg 0] user --");
      expect(userResult.stdout).toContain("READ_USER_KEEP");
      expect(userResult.stdout).not.toContain("READ_USER_HIDE");
      expect(userResult.stdout).toContain("more chars hidden");

      expect(herdResult.status).toBe(0);
      expect(herdResult.stdout).toContain("[msg 1] herd --");
      expect(herdResult.stdout).toContain("READ_HERD_KEEP");
      expect(herdResult.stdout).not.toContain("READ_HERD_HIDE");
      expect(herdResult.stdout).toContain("more chars hidden");

      expect(agentResult.status).toBe(0);
      expect(agentResult.stdout).toContain("[msg 2] agent #11 --");
      expect(agentResult.stdout).not.toContain("Long Agent Name");
      expect(agentResult.stdout).toContain("READ_AGENT_KEEP");
    } finally {
      server.close();
    }
  });

  it("keeps non-numbered agent labels visible instead of dropping provenance", async () => {
    const agentContent = "fallback-agent AGENT_FALLBACK_KEEP";

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-agent-fallback", isOrchestrator: false }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?count=1&from=0") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Peek Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 1,
            from: 0,
            to: 0,
            bounds: [{ turn: 0, si: 0, ei: 0 }],
            messages: [
              {
                idx: 0,
                type: "user",
                ts: Date.now() - 10_000,
                content: agentContent,
                agent: { sessionId: "system", sessionLabel: "System" },
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runTakode(["peek", "153", "--from", "0", "--count", "1", "--port", String(port)], {
        ...process.env,
        COMPANION_SESSION_ID: "leader-agent-fallback",
        COMPANION_AUTH_TOKEN: "auth-agent-fallback",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("agent System");
      expect(result.stdout).toContain("AGENT_FALLBACK_KEEP");
    } finally {
      server.close();
    }
  });
});
