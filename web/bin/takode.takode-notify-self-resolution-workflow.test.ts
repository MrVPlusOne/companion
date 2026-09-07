import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionAuthDir, getSessionAuthPath } from "../shared/session-auth.js";

type JsonObject = Record<string, unknown>;

/** Compute centralized auth path — must match getSessionAuthPath() in cli-launcher.ts */
function centralAuthPath(cwd: string, home: string, serverId = "test-server-id"): string {
  return getSessionAuthPath(cwd, serverId, home);
}

function readJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      resolve(body ? (JSON.parse(body) as JsonObject) : {});
    });
  });
}

async function runTakode(
  args: string[],
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
  stdin?: string,
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

  if (stdin !== undefined) {
    child.stdin?.end(stdin);
  } else {
    child.stdin?.end();
  }

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

describe("takode notify self-resolution workflow", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let requestBodies: JsonObject[];

  beforeAll(async () => {
    requestBodies = [];
    server = createServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-7", isOrchestrator: false }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notify") {
        const body = await readJson(req);
        requestBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        if (body.category === "waiting") {
          res.end(
            JSON.stringify({
              ok: true,
              category: "waiting",
              transient: true,
              anchoredMessageId: null,
              notificationId: null,
              rawNotificationId: null,
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            category: "needs-input",
            anchoredMessageId: "asst-1",
            notificationId: 7,
            rawNotificationId: "n-7",
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-7/notifications/needs-input/self") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            notifications: [
              {
                notificationId: 2,
                rawNotificationId: "n-2",
                summary: "Need rollout decision",
                timestamp: 1000,
                messageId: "asst-2",
              },
              {
                notificationId: 7,
                rawNotificationId: "n-7",
                summary: "Need config confirmation",
                suggestedAnswers: ["yes", "no"],
                timestamp: 1001,
                messageId: "asst-7",
              },
            ],
            resolvedCount: 3,
          }),
        );
        return;
      }

      if (method === "GET" && url === "/api/sessions/worker-7/notifications") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              id: "n-2",
              category: "needs-input",
              summary: "Need rollout decision",
              timestamp: 1000,
              messageId: "asst-2",
              done: false,
            },
            {
              id: "n-7",
              category: "needs-input",
              summary: "Need config confirmation",
              suggestedAnswers: ["yes", "no"],
              timestamp: 1001,
              messageId: "asst-7",
              done: false,
            },
            {
              id: "n-8",
              category: "needs-input",
              summary: "Deferred prompt",
              timestamp: 1002,
              messageId: "asst-8",
              done: false,
              muted: true,
            },
            {
              id: "n-9",
              category: "needs-input",
              summary: "Resolved prompt",
              timestamp: 1003,
              messageId: "asst-9",
              done: true,
            },
          ]),
        );
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notifications/needs-input/7/resolve") {
        requestBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, notificationId: 7, rawNotificationId: "n-7", changed: false }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notifications/needs-input/8/mute") {
        requestBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, notificationId: 8, rawNotificationId: "n-8", muted: true, changed: false }));
        return;
      }

      if (method === "POST" && url === "/api/sessions/worker-7/notifications/needs-input/8/unmute") {
        requestBodies.push(await readJson(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, notificationId: 8, rawNotificationId: "n-8", muted: false, changed: true }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0);
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    requestBodies = [];
  });

  it.each([
    { args: ["help", "notify"], status: 0 },
    { args: ["notify", "--help"], status: 0 },
    { args: ["notify"], status: 1 },
  ])("includes required reply guidance in $args", async ({ args, status }) => {
    // Both explicit help and missing-argument usage reach agents. Inspect the
    // actual CLI output without creating a notification in the fixture server.
    const result = await runTakode([...args, "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });
    expect(result.status).toBe(status);
    const text = status === 0 ? result.stdout : (JSON.parse(result.stderr).error as string);
    const output = text.replace(/\s+/g, " ");

    expect(output).toContain("include one or two concise suggested replies");
    expect(output).toContain("For a binary question, provide both choices");
    expect(output).toContain("not preselected answers or authorization");
    expect(output).toContain("custom replies must remain available");
    expect(output).toContain("all valid decision alternatives visible in chat");
    expect(output).toContain("does not impose a tool-level limit on suggestions");
    expect(output).toContain("provide replies after each question");
    expect(requestBodies).toEqual([]);
  });

  it("prints the created notification id for takode notify needs-input", async () => {
    const result = await runTakode(["notify", "needs-input", "Need", "approval", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Notification sent (needs-input, id 7)");
    expect(requestBodies[0]).toEqual({ category: "needs-input", summary: "Need approval" });
  });

  it("prints a transient acknowledgement for takode notify waiting without an id", async () => {
    const result = await runTakode(["notify", "waiting", "Waiting", "on", "reviewer", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Waiting status noted (transient)");
    expect(result.stdout).not.toContain("id");
    expect(requestBodies[0]).toEqual({ category: "waiting", summary: "Waiting on reviewer" });
  });

  it("passes repeated suggested answers for needs-input notifications without a three-option cap", async () => {
    const result = await runTakode(
      [
        "notify",
        "needs-input",
        "Need",
        "approval",
        "--suggest",
        "yes",
        "--suggest",
        "no",
        "--suggest",
        "revise",
        "--suggest",
        "later",
        "--port",
        String(port),
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "worker-7",
        COMPANION_AUTH_TOKEN: "auth-7",
      },
    );

    expect(result.status).toBe(0);
    expect(requestBodies[0]).toEqual({
      category: "needs-input",
      summary: "Need approval",
      suggestedAnswers: ["yes", "no", "revise", "later"],
    });
  });

  it("passes explicit thread ownership for created needs-input notifications", async () => {
    const result = await runTakode(
      ["notify", "needs-input", "Need", "approval", "--thread", "q-983", "--suggest", "yes", "--port", String(port)],
      {
        ...process.env,
        COMPANION_SESSION_ID: "worker-7",
        COMPANION_AUTH_TOKEN: "auth-7",
      },
    );

    expect(result.status).toBe(0);
    expect(requestBodies[0]).toEqual({
      category: "needs-input",
      summary: "Need approval",
      threadKey: "q-983",
      suggestedAnswers: ["yes"],
    });
  });

  it("passes per-question suggested answers for needs-input notifications", async () => {
    const result = await runTakode(
      [
        "notify",
        "needs-input",
        "Need",
        "choices",
        "--question",
        "Which rollout?",
        "--suggest",
        "staged",
        "--suggest",
        "full",
        "--suggest",
        "pause",
        "--suggest",
        "rollback",
        "--question",
        "When?",
        "--suggest",
        "now",
        "--port",
        String(port),
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "worker-7",
        COMPANION_AUTH_TOKEN: "auth-7",
      },
    );

    expect(result.status).toBe(0);
    expect(requestBodies[0]).toEqual({
      category: "needs-input",
      summary: "Need choices",
      questions: [
        { prompt: "Which rollout?", suggestedAnswers: ["staged", "full", "pause", "rollback"] },
        { prompt: "When?", suggestedAnswers: ["now"] },
      ],
    });
  });

  it("rejects mixed legacy and per-question suggestions", async () => {
    const result = await runTakode(
      [
        "notify",
        "needs-input",
        "Need",
        "choices",
        "--suggest",
        "yes",
        "--question",
        "Which rollout?",
        "--port",
        String(port),
      ],
      {
        ...process.env,
        COMPANION_SESSION_ID: "worker-7",
        COMPANION_AUTH_TOKEN: "auth-7",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use --suggest after each --question when --question is used.");
    expect(requestBodies).toHaveLength(0);
  });

  it("lists unresolved same-session needs-input notifications", async () => {
    const result = await runTakode(["notify", "list", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Active unresolved same-session needs-input notifications: 2. Muted: 1. Resolved: 1.",
    );
    expect(result.stdout).toContain("2. Need rollout decision");
    expect(result.stdout).toContain("7. Need config confirmation");
    expect(result.stdout).not.toContain("8. Deferred prompt");
    expect(result.stdout).toContain("suggestions: yes, no");
  });

  it("lists muted same-session needs-input notifications separately", async () => {
    const result = await runTakode(["notify", "list", "--muted", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Muted unresolved same-session needs-input notifications: 1. Muted: 1. Resolved: 1.",
    );
    expect(result.stdout).toContain("8. Deferred prompt");
    expect(result.stdout).not.toContain("2. Need rollout decision");
  });

  it("mutes and unmutes same-session needs-input notifications", async () => {
    const mute = await runTakode(["notify", "mute", "8", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });
    expect(mute.status).toBe(0);
    expect(mute.stdout).toContain("Needs-input notification 8 was already muted.");
    expect(requestBodies[0]).toEqual({});

    requestBodies.length = 0;
    const unmute = await runTakode(["notify", "unmute", "8", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });
    expect(unmute.status).toBe(0);
    expect(unmute.stdout).toContain("Unmuted needs-input notification 8.");
    expect(requestBodies[0]).toEqual({});
  });

  it("treats resolving an already-resolved notification as a successful no-op", async () => {
    const result = await runTakode(["notify", "resolve", "7", "--port", String(port)], {
      ...process.env,
      COMPANION_SESSION_ID: "worker-7",
      COMPANION_AUTH_TOKEN: "auth-7",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Needs-input notification 7 was already resolved.");
    expect(requestBodies[0]).toEqual({});
  });
});
