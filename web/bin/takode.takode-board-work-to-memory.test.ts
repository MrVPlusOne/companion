import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

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
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const takodePath = fileURLToPath(new URL("./takode.ts", import.meta.url));
  const child = spawn(process.execPath, [takodePath, ...args, "--port", String(port)], {
    env: {
      ...process.env,
      COMPANION_SESSION_ID: "worker-1",
      COMPANION_AUTH_TOKEN: "worker-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

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

describe("takode board work-to-memory commit evidence", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let postedBodies: JsonObject[];

  beforeEach(async () => {
    postedBodies = [];
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-1", isOrchestrator: false }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/takode/board/work-to-memory") {
        const body = await readJson(req);
        postedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            questId: body.questId,
            previousState: "WORKING",
            newState: "MEMORY",
            workFeedbackIndex: body.workFeedbackIndex ?? 0,
            board: [],
            resolvedSessionDeps: [],
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0);
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("qualifies generic advance help with the guarded Work boundary", async () => {
    const result = await runTakode(["help", "board", "advance"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("non-Work Quest Journey boundaries");
    expect(result.stdout).toContain("does not perform Work -> Memory");
    expect(result.stdout).toContain("takode board work-to-memory");
  });

  it("sends normalized ordered target SHAs as structured Work evidence", async () => {
    // The transition payload is the Work-owned durable boundary, so duplicate
    // and mixed-case CLI values must be normalized before the request is sent.
    const result = await runTakode(
      ["board", "work-to-memory", "q-12", "--work-note", "4", "--commit", "ABC1234", "--commits", "def5678,abc1234"],
      port,
    );

    expect(result.status).toBe(0);
    expect(postedBodies).toEqual([
      {
        questId: "q-12",
        workFeedbackIndex: 4,
        commitShas: ["abc1234", "def5678"],
      },
    ]);
    expect(result.stdout).toContain("2 code commits");
  });

  it("sends an explicit zero-code assertion for genuine zero-tracked-change Work", async () => {
    const result = await runTakode(["board", "work-to-memory", "q-13", "--work-note", "5", "--no-code"], port);

    expect(result.status).toBe(0);
    expect(postedBodies).toEqual([{ questId: "q-13", workFeedbackIndex: 5, noCode: true }]);
    expect(result.stdout).toContain("no code changes");
  });

  it("forwards optional-checkpoint skip proof on the guarded transition", async () => {
    const result = await runTakode(
      ["board", "work-to-memory", "q-14", "--no-code", "--skip-optional-checkpoint", "Approved condition is satisfied"],
      port,
    );

    expect(result.status).toBe(0);
    expect(postedBodies).toEqual([
      {
        questId: "q-14",
        noCode: true,
        skipOptionalUserCheckpointReason: "Approved condition is satisfied",
      },
    ]);
  });

  it.each([
    [["board", "work-to-memory", "q-12", "--work-note", "4"], "Use exactly one Work evidence mode"],
    [["board", "work-to-memory", "q-12", "--commit", "abc1234", "--no-code"], "Use exactly one Work evidence mode"],
    [["board", "work-to-memory", "q-12", "--commit", "not-a-sha"], "Invalid commit SHA"],
  ])("rejects invalid evidence locally before posting: %j", async (args, errorText) => {
    const result = await runTakode(args, port);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(errorText);
    expect(postedBodies).toEqual([]);
  });
});

describe("takode board replace-work-evidence", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let postedBodies: JsonObject[];

  beforeEach(async () => {
    postedBodies = [];
    server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/takode/me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId: "worker-1", isOrchestrator: false }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/takode/board/replace-work-evidence") {
        const body = await readJson(req);
        postedBodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            questId: body.questId,
            previousCommitShas: body.expectedCommitShas,
            commitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            target: {
              mode: "remote-backed",
              checkoutPath: "/repo",
              branch: "main",
              headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            correction: {
              journeyRunId: "board-leader-1-1",
              phaseOccurrenceId: "board-leader-1-1:p2",
              ts: 10,
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
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("posts normalized compare-and-swap evidence and prints a compact correction receipt", async () => {
    const oldSha = "1".repeat(40);
    const result = await runTakode(
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        `${oldSha.toUpperCase()},${oldSha}`,
        "--commits",
        "ABC1234,abc1234",
        "--reason",
        "Correct mistyped delivery evidence",
      ],
      port,
    );

    expect(result.status).toBe(0);
    expect(postedBodies).toEqual([
      {
        questId: "q-12",
        expectedCommitShas: [oldSha],
        commitShas: ["abc1234"],
        reason: "Correct mistyped delivery evidence",
      },
    ]);
    expect(result.stdout).toContain("q-12: replaced Work code evidence (1 -> 1)");
    expect(result.stdout).toContain(`previous: ${oldSha}`);
    expect(result.stdout).toContain("replacement: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.stdout).toContain("target: /repo main @ aaaaaaaaaaaa");
    expect(result.stdout).not.toContain("QUEST");
  });

  it("keeps JSON output bounded to the correction receipt instead of a board dump", async () => {
    const result = await runTakode(
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        "1111111",
        "--commits",
        "aaaaaaa",
        "--reason",
        "Repair evidence",
        "--json",
      ],
      port,
    );

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as JsonObject;
    expect(json).toMatchObject({
      ok: true,
      questId: "q-12",
      previousCommitShas: ["1111111"],
      commitShas: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      target: { mode: "remote-backed", branch: "main" },
    });
    expect(json).not.toHaveProperty("board");
    expect(json).not.toHaveProperty("reason");
  });

  it.each([
    [
      ["board", "replace-work-evidence", "q-12", "--commits", "aaaaaaa", "--reason", "Repair"],
      "--expected-commits must contain",
    ],
    [
      ["board", "replace-work-evidence", "q-12", "--expected-commits", "1111111", "--reason", "Repair"],
      "--commits must contain",
    ],
    [
      ["board", "replace-work-evidence", "q-12", "--expected-commits", "1111111", "--commits", "aaaaaaa"],
      "--reason requires",
    ],
    [
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(7, "0")).join(","),
        "--commits",
        Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(7, "0")).join(","),
        "--reason",
        "Repair",
      ],
      "at most 50 commits",
    ],
    [
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        "1111111,2222222",
        "--commits",
        "aaaaaaa",
        "--reason",
        "Repair",
      ],
      "cannot contain fewer commits",
    ],
    [
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        "1111111",
        "--commits",
        "1111111",
        "--reason",
        "Repair",
      ],
      "must differ",
    ],
    [
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        "1111111",
        "--commits",
        "aaaaaaa",
        "--reason",
        "Repair",
        "--no-code",
      ],
      "Unknown option",
    ],
    [
      [
        "board",
        "replace-work-evidence",
        "q-12",
        "--expected-commits",
        "1111111",
        "--commits",
        "aaaaaaa",
        "--reason",
        "x".repeat(1_001),
      ],
      "at most 1000 characters",
    ],
  ])("rejects invalid correction input before posting: %j", async (args, errorText) => {
    const result = await runTakode(args, port);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(errorText);
    expect(postedBodies).toEqual([]);
  });

  it("documents the correction-only compare-and-swap contract", async () => {
    const result = await runTakode(["help", "board", "replace-work-evidence"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--expected-commits");
    expect(result.stdout).toContain("must exactly match");
    expect(result.stdout).toContain("does not advance the Journey");
    expect(result.stdout).toContain("limited to 50 unique commits");
  });
});
