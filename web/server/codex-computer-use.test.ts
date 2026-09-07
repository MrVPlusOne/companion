import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexComputerUseLaunchArgs } from "./codex-computer-use.js";
import { prepareCodexSpawn } from "./cli-launcher-codex.js";

const systemConfig = vi.hoisted(() => ({ contents: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // System-layer fixtures must never write to or depend on the machine's real /etc configuration.
    readFile: vi.fn((path, ...options) =>
      path === "/etc/codex/config.toml" ? Promise.resolve(systemConfig.contents) : actual.readFile(path, ...options),
    ),
  };
});

const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  systemConfig.contents = "";
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-native-startup-"));
  roots.push(root);
  const home = join(root, "desktop-home");
  const resources = join(root, "ChatGPT.app", "Contents", "Resources");
  const command = join(resources, "cua_node", "bin", "node_repl");
  const node = join(resources, "cua_node", "bin", "node");
  const cli = join(resources, "codex");
  const helper = join(home, "computer-use", "Codex Computer Use.app");
  const service = join(helper, "Contents", "MacOS", "SkyComputerUseService");
  const packagePath = join(resources, "cua_node", "lib", "node_modules", "@oai", "sky", "package.json");
  const codexBinary = join(root, "bin", "codex");
  for (const path of [command, node, cli, service, codexBinary, packagePath]) {
    await mkdir(dirname(path), { recursive: true });
    // Disposable sentinels validate launch preparation without running Codex or any native helper.
    await writeFile(path, path === packagePath ? "{}" : "#!/bin/sh\nexit 77\n");
    await chmod(path, 0o755);
  }
  await mkdir(join(root, ".git"));
  const source = [
    "[mcp_servers.node_repl]",
    `command = ${JSON.stringify(command)}`,
    "args = []",
    "[mcp_servers.node_repl.env]",
    `NODE_REPL_NODE_PATH = ${JSON.stringify(node)}`,
    `CODEX_CLI_PATH = ${JSON.stringify(cli)}`,
    `CODEX_HOME = ${JSON.stringify(home)}`,
    `SKY_CUA_SERVICE_PATH = ${JSON.stringify(helper)}`,
    `NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: "desktop-browser-service" }))}`,
    "",
  ].join("\n");
  await writeFile(join(home, "config.toml"), source);
  return { root, home, command, node, service, packagePath, codexBinary, source };
}

function nativeOverrides(args: string[]) {
  const assignments = args.filter(
    (arg, index) => index > 0 && args[index - 1] === "-c" && arg.startsWith("mcp_servers.node_repl."),
  );
  // Parsing the actual CLI assignments catches quoting/escaping errors before provider startup.
  return (
    Bun.TOML.parse(assignments.join("\n")) as {
      mcp_servers: { node_repl: { command: string; args: string[]; enabled: boolean; env: Record<string, string> } };
    }
  ).mcp_servers.node_repl;
}

const staleConfig = [
  'model = "session-model"',
  "[mcp_servers.node_repl]",
  'command = "/old/Codex.app/Contents/Resources/cua_node/bin/node_repl"',
  "enabled = false",
  "startup_timeout_sec = 37",
  "[mcp_servers.node_repl.env]",
  'KEEP_THIS = "session-value"',
  'NODE_REPL_NODE_MODULE_DIRS = "/custom/modules"',
  `NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(JSON.stringify({ browser: "session-browser-service", custom: "custom-service" }))}`,
  "[mcp_servers.computer-use]",
  "enabled = false",
  'command = "legacy-direct-client"',
  "[mcp_servers.other]",
  'command = "unrelated-server"',
  "",
].join("\n");

describe("Codex native computer-use startup defaults", () => {
  it.each([
    "leader",
    "worker",
    "ordinary",
  ] as const)("refreshes an existing %s home through normal spawn preparation", async (role) => {
    const f = await fixture();
    const sessionId = `${role}-session`;
    const codexHome = join(f.root, "session-homes");
    const sessionHome = join(codexHome, sessionId);
    await mkdir(sessionHome, { recursive: true });
    await writeFile(join(sessionHome, "config.toml"), staleConfig);
    const spawn = await prepareCodexSpawn(
      sessionId,
      { cwd: f.root, isOrchestrator: role === "leader" },
      {
        codexBinary: f.codexBinary,
        codexHome,
        codexHomePrepared: true,
        codexLegacyHome: f.home,
        codexLeaderCompactionMode: "compact",
        permissionMode: "codex-full-access",
      },
    );
    const native = nativeOverrides(spawn.spawnCmd);
    expect(native.command).toBe(f.command);
    expect(native.enabled).toBe(true);
    expect(native.env.CODEX_HOME).toBe(f.home);
    expect(native.env.NODE_REPL_NODE_PATH).toBe(f.node);
    expect(native.env.NODE_REPL_NODE_MODULE_DIRS.split(":")).toContain("/custom/modules");
    expect(JSON.parse(native.env.NODE_REPL_TRUSTED_SERVICES)).toEqual({
      browser: "session-browser-service",
      custom: "custom-service",
      sky: "@oai/sky/service",
    });
    expect(native.env).not.toHaveProperty("KEEP_THIS");
    expect(native).not.toHaveProperty("startup_timeout_sec");
    expect(spawn.spawnCmd).not.toContain("mcp_servers.computer-use.enabled=true");
    // Full Access is unchanged, and only the configured MCP subprocess uses the desktop home.
    expect(spawn.spawnEnv.CODEX_HOME).toBe(sessionHome);
    expect(spawn.spawnCmd).toContain("never");
    expect(spawn.spawnCmd).toContain("danger-full-access");
    expect(await readFile(join(f.home, "config.toml"), "utf-8")).toBe(f.source);
    expect(await readFile(join(sessionHome, "config.toml"), "utf-8")).toContain(staleConfig);
  });

  it("enables a fresh session and observes updated desktop configuration on the next launch", async () => {
    const f = await fixture();
    const options = {
      codexBinary: f.codexBinary,
      codexHome: join(f.root, "sessions"),
      codexLegacyHome: f.home,
      codexAgentsSkillsHome: join(f.root, "skills"),
    };
    const first = await prepareCodexSpawn("fresh-session", { cwd: f.root }, options);
    expect(nativeOverrides(first.spawnCmd).enabled).toBe(true);
    // Changing only a disposable source proves relaunch reads current runtime config, not a cached snapshot.
    await writeFile(join(f.home, "config.toml"), f.source.replace("args = []", 'args = ["--updated-runtime"]'));
    const next = await prepareCodexSpawn("fresh-session", { cwd: f.root }, options);
    expect(nativeOverrides(next.spawnCmd).args).toEqual(["--updated-runtime"]);
  });

  it.each([
    "node",
    "service",
    "packagePath",
  ] as const)("reports an unavailable %s prerequisite without changing source configuration", async (field) => {
    const f = await fixture();
    await rm(f[field]);
    expect(await codexComputerUseLaunchArgs(staleConfig, f.root, { codexLegacyHome: f.home })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Native computer-use default not applied"));
    expect(await readFile(join(f.home, "config.toml"), "utf-8")).toBe(f.source);
  });

  it.each(["desktop", "session"])("preserves a custom %s Node REPL instead of replacing it", async (target) => {
    const f = await fixture();
    const custom = '[mcp_servers.node_repl]\ncommand = "/custom/node_repl"\n';
    if (target === "desktop") await writeFile(join(f.home, "config.toml"), custom);
    expect(
      await codexComputerUseLaunchArgs(target === "session" ? custom : staleConfig, f.root, {
        codexLegacyHome: f.home,
      }),
    ).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Native computer-use default not applied"));
  });

  it.each(["desktop", "session"])("preserves a custom HTTP %s Node REPL without mixing transports", async (target) => {
    const f = await fixture();
    // A URL-backed server has no command; adding stdio settings would both replace it and break its config.
    const custom = '[mcp_servers.node_repl]\nurl = "https://example.invalid/mcp"\n';
    if (target === "desktop") await writeFile(join(f.home, "config.toml"), custom);
    expect(
      await codexComputerUseLaunchArgs(target === "session" ? custom : staleConfig, f.root, {
        codexLegacyHome: f.home,
      }),
    ).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Native computer-use default not applied"));
  });

  it("does not manufacture runtime support when desktop configuration is missing or invalid", async () => {
    const f = await fixture();
    await rm(join(f.home, "config.toml"));
    expect(await codexComputerUseLaunchArgs("", f.root, { codexLegacyHome: f.home })).toEqual([]);
    await writeFile(join(f.home, "config.toml"), 'secret = "do-not-log-this');
    expect(await codexComputerUseLaunchArgs("", f.root, { codexLegacyHome: f.home })).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("do-not-log-this");
  });

  it.each([
    '[mcp_servers.node_repl]\ncommand = "/project/node_repl"\n',
    '[mcp_servers.node_repl]\nurl = "https://example.invalid/mcp"\n',
    '[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = \'{"custom":"project-service"}\'\n',
  ])("preserves project-owned Node REPL config inherited from the trusted repository root", async (projectConfig) => {
    const f = await fixture();
    const cwd = join(f.root, "nested", "package");
    const projectPath = join(f.root, ".codex", "config.toml");
    await mkdir(cwd, { recursive: true });
    await mkdir(dirname(projectPath));
    await writeFile(projectPath, projectConfig);
    await writeFile(
      join(f.home, "config.toml"),
      `${f.source}\n[projects.${JSON.stringify(f.root)}]\ntrust_level = "trusted"\n`,
    );
    // A lower-priority project setting must not be replaced by the feature's CLI defaults.
    expect(await codexComputerUseLaunchArgs(staleConfig, cwd, { codexLegacyHome: f.home })).toEqual([]);
    expect(await readFile(projectPath, "utf-8")).toBe(projectConfig);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("project configures Node REPL"));
  });

  it("keeps defaults with unrelated project settings and stops discovery at the repository boundary", async () => {
    const f = await fixture();
    const projectPath = join(f.root, ".codex", "config.toml");
    await mkdir(dirname(projectPath));
    await writeFile(projectPath, 'model = "project-model"\n');
    expect(
      nativeOverrides(await codexComputerUseLaunchArgs(staleConfig, f.root, { codexLegacyHome: f.home })).enabled,
    ).toBe(true);
    const nestedRepo = join(f.root, "nested-repo");
    await mkdir(join(nestedRepo, ".git"), { recursive: true });
    await writeFile(projectPath, '[mcp_servers.node_repl]\ncommand = "/outer-project/node_repl"\n');
    expect(
      nativeOverrides(await codexComputerUseLaunchArgs(staleConfig, nestedRepo, { codexLegacyHome: f.home })).enabled,
    ).toBe(true);
  });

  it.each(['["ROOT"]', "[]"])("preserves custom project discovery with markers %s", async (markers) => {
    const f = await fixture();
    // Custom markers can make Codex load an outer config above an inner .git; flags must not bypass it.
    const session = `project_root_markers = ${markers}\n${staleConfig}`;
    expect(await codexComputerUseLaunchArgs(session, f.root, { codexLegacyHome: f.home })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("custom project-root discovery"));
  });

  it("preserves inherited system native settings and custom root discovery", async () => {
    const f = await fixture();
    systemConfig.contents =
      '[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = \'{"custom":"system-service"}\'\n';
    expect(await codexComputerUseLaunchArgs(staleConfig, f.root, { codexLegacyHome: f.home })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("system configures Node REPL"));
    systemConfig.contents = 'project_root_markers = ["ROOT"]\n';
    expect(await codexComputerUseLaunchArgs(staleConfig, f.root, { codexLegacyHome: f.home })).toEqual([]);
    // An explicit normal session root policy overrides the inherited root policy without changing it.
    expect(
      nativeOverrides(
        await codexComputerUseLaunchArgs(`project_root_markers = [".git"]\n${staleConfig}`, f.root, {
          codexLegacyHome: f.home,
        }),
      ).enabled,
    ).toBe(true);
  });

  it("checks the actual repository when the session directory is a symlink", async () => {
    const f = await fixture();
    const repo = join(f.root, "actual-repo");
    await mkdir(join(repo, "nested"), { recursive: true });
    await mkdir(join(repo, ".git"));
    await mkdir(join(repo, ".codex"));
    await writeFile(join(repo, ".codex", "config.toml"), '[mcp_servers.node_repl]\ncommand = "/project/node_repl"\n');
    const alias = join(f.root, "alias");
    await symlink(join(repo, "nested"), alias);
    expect(await codexComputerUseLaunchArgs(staleConfig, alias, { codexLegacyHome: f.home })).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("project configures Node REPL"));
  });

  it("skips containers and unsupported platforms before native prerequisite reads", async () => {
    // The missing fixture home would warn if either excluded path tried to discover native support.
    expect(
      await codexComputerUseLaunchArgs("", "/workspace", {
        codexLegacyHome: "/missing-desktop-home",
        containerId: "container",
      }),
    ).toEqual([]);
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(await codexComputerUseLaunchArgs("", "/workspace", { codexLegacyHome: "/missing-desktop-home" })).toEqual(
      [],
    );
    expect(console.warn).not.toHaveBeenCalled();
  });
});
