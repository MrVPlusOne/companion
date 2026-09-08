import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body) as JsonObject;
}

async function runTakode(args: string[], port: number) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./takode.ts", import.meta.url)), ...args, "--port", String(port)],
    {
      env: {
        ...process.env,
        COMPANION_SESSION_ID: "leader-handoff",
        COMPANION_AUTH_TOKEN: "auth-handoff",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

describe("takode thread handoff", () => {
  let server: Server;
  let port: number;
  let calls: JsonObject[];
  let response: JsonObject;
  let responseStatus: number;

  beforeEach(async () => {
    calls = [];
    responseStatus = 200;
    response = {
      ok: true,
      sessionId: "leader-handoff",
      questId: "q-42",
      handedOffUserMessageIds: ["u1", "u2", "u3", "u4"],
      alreadyHandedOffUserMessageIds: [],
      notificationIds: ["n-1", "n-2", "n-3"],
      alreadyHandedOffNotificationIds: [],
      // A future backend addition must never turn the compact CLI result into a source-history dump.
      injectedSystemPrompt: "private-debug-content".repeat(1_000),
      messageHistory: [{ content: "private source message" }],
    };
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "leader-handoff", isOrchestrator: true }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions/leader-handoff/thread/handoff") {
        calls.push(await readJson(req));
        res.writeHead(responseStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it.each([false, true])("sends deduplicated exact IDs and keeps json=%s output compact", async (json) => {
    // Exercise the real command dispatcher and authenticated HTTP body with all three accepted list forms.
    const result = await runTakode(
      [
        "thread",
        "handoff",
        "q-42",
        "--user",
        "u1,u2",
        "u3",
        "--user",
        "u1",
        "u4",
        "--notification",
        "n-1",
        "n-2,n-3",
        "--notification",
        "n-1",
        ...(json ? ["--json"] : []),
      ],
      port,
    );

    expect(result.status).toBe(0);
    expect(calls).toEqual([
      {
        questId: "q-42",
        userMessageIds: ["u1", "u2", "u3", "u4"],
        notificationIds: ["n-1", "n-2", "n-3"],
      },
    ]);
    expect(result.stdout).not.toContain("injectedSystemPrompt");
    expect(result.stdout).not.toContain("private-debug-content");
    expect(result.stdout).not.toContain("private source message");
    if (json) {
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        sessionId: "leader-handoff",
        questId: "q-42",
        handedOffUserMessageIds: ["u1", "u2", "u3", "u4"],
        alreadyHandedOffUserMessageIds: [],
        notificationIds: ["n-1", "n-2", "n-3"],
        alreadyHandedOffNotificationIds: [],
      });
    } else {
      expect(result.stdout).toContain("Handed off to q-42: u1, u2, u3, u4; notifications n-1, n-2, n-3.");
    }
  });

  it("omits unselected notifications and reports a same-owner retry without claiming new work", async () => {
    // Retry status comes from the server; the CLI must retain its distinction from newly transferred IDs.
    response = {
      ok: true,
      sessionId: "leader-handoff",
      questId: "q-42",
      handedOffUserMessageIds: [],
      alreadyHandedOffUserMessageIds: ["u1"],
      notificationIds: [],
      alreadyHandedOffNotificationIds: [],
    };
    const result = await runTakode(["thread", "handoff", "q-42", "--user", "u1"], port);

    expect(result.status).toBe(0);
    expect(calls).toEqual([{ questId: "q-42", userMessageIds: ["u1"] }]);
    expect(result.stdout).toContain("No changes for q-42. Already handed off: u1.");
  });

  it.each([
    [[], "--user requires"],
    [["--user"], "--user requires"],
    [["--user", "u1", "--notification"], "--notification requires"],
    [["--user", "u0"], "Invalid user ID"],
    [["--user", "u01"], "Invalid user ID"],
    [["--user", "U1"], "Invalid user ID"],
    [["--user", "1"], "Invalid user ID"],
    [["--user", "u1,"], "Invalid user ID"],
    [["--user", "u1", "--notification", "n-0"], "Invalid notification ID"],
    [["--user", "u1", "--notification", "n-01"], "Invalid notification ID"],
    [["--user", "u1", "--notification", "1"], "Invalid notification ID"],
    [["--user", "u1", "--unknown"], "Unknown option or argument"],
    [["--user", "u1", "-x"], "Unknown option or argument"],
    [["--user", "u1", "--json", "false"], "Unknown option or argument"],
  ])("rejects malformed selectors %j before a handoff request", async (args, diagnostic) => {
    // Never guess which unfinished requests or decisions a malformed invocation intended to transfer.
    const result = await runTakode(["thread", "handoff", "q-42", ...args], port);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(calls).toEqual([]);
  });

  it("preserves the server's actionable rejection instead of reporting success", async () => {
    // Ownership and prompt-anchor checks remain server-authoritative.
    responseStatus = 409;
    response = { error: "Notification n-1 has no proven prompt anchor." };
    const result = await runTakode(
      ["thread", "handoff", "q-42", "--user", "u1", "--notification", "n-1", "--json"],
      port,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Notification n-1 has no proven prompt anchor.");
    expect(result.stdout).toBe("");
  });

  it("distinguishes responsibility handoff from context attachment in public help", async () => {
    // Help remains available without executing either mutation route.
    const result = await runTakode(["thread", "handoff", "--help"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("takode thread handoff <quest-id> --user <uN>");
    expect(result.stdout).toContain("attach does not transfer unfinished responsibility");
    expect(result.stdout).toContain("Same-destination retries make no changes");
    expect(calls).toEqual([]);
  });
});
