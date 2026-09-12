import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args], {
    env,
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

describe("takode scan/peek context diagnostics", () => {
  it("keeps defaults compact and reveals context details only with --context", async () => {
    const requests: string[] = [];
    const now = Date.now();
    const turn = {
      turn: 0,
      si: 0,
      ei: 3,
      start: now - 60_000,
      end: now - 59_000,
      dur: 1_000,
      stats: { tools: 1, messages: 1, subagents: 0 },
      success: true,
      result: "done",
      user: "inspect quest",
    };
    const context = {
      reportedUsage: {
        timestamp: now - 61_000,
        source: "codex_token_usage",
        contextUsedPercent: 42,
        contextTokensUsed: 230_000,
        displayContextTokensUsed: 231_000,
        providerReportedTotalTokens: 231_000,
        modelContextWindow: 545_000,
      },
      messageBytes: 2_048,
      toolResultBytes: 29_400,
      hiddenToolResultBytes: 29_393,
      totalObservableBytes: 31_441,
      topCommands: [{ family: "quest show", bytes: 29_460, calls: 1 }],
    };

    const server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";
      requests.push(`${method} ${url}`);

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-context", isOrchestrator: true }));
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Context Worker",
            status: "idle",
            quest: null,
            mode: "turn_scan",
            totalTurns: 1,
            totalMessages: 4,
            from: 0,
            count: 1,
            turns: [turn],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=1&context=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Context Worker",
            status: "idle",
            quest: null,
            mode: "turn_scan",
            totalTurns: 1,
            totalMessages: 4,
            from: 0,
            count: 1,
            turns: [{ ...turn, context }],
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/153/messages?turn=0&count=60&showTools=true&context=true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Context Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 4,
            from: 0,
            to: 3,
            messages: [
              {
                idx: 0,
                type: "user",
                content: "inspect quest",
                ts: now - 60_000,
                contextUsage: context.reportedUsage,
              },
              {
                idx: 1,
                type: "assistant",
                content: "",
                ts: now - 59_500,
                contextUsage: null,
                tools: [
                  {
                    idx: 0,
                    name: "Bash",
                    summary: "Show quest q-1452",
                    status: "completed",
                    context: {
                      resultBytes: 29_400,
                      hiddenResultBytes: 29_393,
                      commandFamily: "quest show",
                      commandSummary: "Show quest q-1452",
                    },
                  },
                ],
              },
              { idx: 3, type: "result", content: "done", ts: now - 59_000, success: true, contextUsage: null },
            ],
            bounds: [{ turn: 0, si: 0, ei: 3 }],
          }),
        );
        return;
      }

      if (
        method === "GET" &&
        url === "/api/sessions/153/messages?turnContaining=1&count=60&showTools=true&context=true"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sid: "worker-153",
            sn: 153,
            name: "Context Worker",
            status: "idle",
            quest: null,
            mode: "range",
            totalMessages: 4,
            from: 0,
            to: 3,
            messages: [
              {
                idx: 0,
                type: "user",
                content: "inspect quest",
                ts: now - 60_000,
                contextUsage: null,
              },
              {
                idx: 1,
                type: "assistant",
                content: "",
                ts: now - 59_500,
                contextUsage: context.reportedUsage,
                tools: [
                  {
                    idx: 0,
                    name: "Bash",
                    summary: "Show quest q-1452",
                    status: "completed",
                    context: {
                      resultBytes: 29_400,
                      hiddenResultBytes: 29_393,
                      commandFamily: "quest show",
                      commandSummary: "Show quest q-1452",
                    },
                  },
                ],
              },
              { idx: 3, type: "result", content: "done", ts: now - 59_000, success: true, contextUsage: null },
            ],
            bounds: [{ turn: 0, si: 0, ei: 3 }],
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
    const env = { ...process.env, COMPANION_SESSION_ID: "leader-context", COMPANION_AUTH_TOKEN: "auth" };

    try {
      const compactScan = await runTakode(["scan", "153", "--from", "0", "--count", "1", "--port", String(port)], env);
      const contextScan = await runTakode(
        ["scan", "153", "--from", "0", "--count", "1", "--context", "--port", String(port)],
        env,
      );
      const contextPeek = await runTakode(["peek", "153", "--turn", "0", "--context", "--port", String(port)], env);
      const containingPeek = await runTakode(
        ["peek", "153", "--turn-containing", "1", "--context", "--port", String(port)],
        env,
      );

      expect(compactScan.status).toBe(0);
      expect(compactScan.stderr).toBe("");
      expect(compactScan.stdout).not.toContain("context:");
      expect(compactScan.stdout).not.toContain("reported usage");
      expect(contextScan.stderr).toBe("");
      expect(contextScan.status).toBe(0);
      expect(contextScan.stdout).toContain(
        "context: reported usage 42% 231,000/545,000 tokens provider input 230,000 codex_token_usage",
      );
      expect(contextScan.stdout).toContain("message JSON 2.0 KiB; tool results 28.7 KiB");
      expect(contextScan.stdout).toContain("top quest show 28.8 KiB");
      expect(contextPeek.status).toBe(0);
      expect(contextPeek.stderr).toBe("");
      expect(contextPeek.stdout).toContain("ctx 42% 231,000/545,000 tokens provider input 230,000 codex_token_usage");
      expect(contextPeek.stdout).toContain("ctx unavailable");
      expect(contextPeek.stdout).toContain("Bash ✓ Show quest q-1452 [quest show, result 28.7 KiB");
      expect(containingPeek.status).toBe(0);
      expect(containingPeek.stderr).toBe("");
      expect(containingPeek.stdout).toContain(
        "ctx 42% 231,000/545,000 tokens provider input 230,000 codex_token_usage",
      );
      expect(containingPeek.stdout).toContain("ctx unavailable");
      expect(requests).toContain("GET /api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=1");
      expect(requests).toContain("GET /api/sessions/153/messages?scan=turns&fromTurn=0&turnCount=1&context=true");
      expect(requests).toContain("GET /api/sessions/153/messages?turn=0&count=60&showTools=true&context=true");
      expect(requests).toContain(
        "GET /api/sessions/153/messages?turnContaining=1&count=60&showTools=true&context=true",
      );
    } finally {
      server.close();
    }
  });
});
