import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getLegacyCodexHome } from "./codex-home.js";

interface NodeReplConfig {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface CodexConfig {
  mcp_servers?: { node_repl?: NodeReplConfig };
  project_root_markers?: string[];
}

/**
 * Refresh the installed desktop native runtime through host Codex launch flags.
 * Neither home is written, and inspecting prerequisites never starts a native process.
 */
export async function codexComputerUseLaunchArgs(
  sessionConfig: string,
  cwd: string,
  options: { codexLegacyHome?: string; containerId?: string } = {},
): Promise<string[]> {
  if (options.containerId || process.platform !== "darwin") return [];
  const desktopHome = options.codexLegacyHome ?? getLegacyCodexHome();

  try {
    const source = nodeReplConfig(Bun.TOML.parse(await readFile(join(desktopHome, "config.toml"), "utf-8")));
    const sessionSettings = Bun.TOML.parse(sessionConfig) as CodexConfig;
    const session = nodeReplConfig(sessionSettings);
    if (source.url !== undefined || !source.command || !isBundledNodeRepl(source.command)) {
      return skipNativeDefault("the desktop Codex home has no configured app-bundled Node REPL");
    }
    if (session.url !== undefined || (session.command && !isBundledNodeRepl(session.command))) {
      return skipNativeDefault("the session uses a custom Node REPL; its configuration was preserved");
    }
    const system = Bun.TOML.parse(await optionalConfig("/etc/codex/config.toml")) as CodexConfig;
    if (system.mcp_servers?.node_repl !== undefined) {
      return skipNativeDefault("the system configures Node REPL; its configuration was preserved");
    }
    const rootMarkers = sessionSettings.project_root_markers ?? system.project_root_markers;
    if (
      rootMarkers !== undefined &&
      (!Array.isArray(rootMarkers) || rootMarkers.length !== 1 || rootMarkers[0] !== ".git")
    ) {
      return skipNativeDefault("custom project-root discovery is configured; project settings were preserved");
    }
    if (await hasProjectNodeRepl(cwd, desktopHome)) {
      return skipNativeDefault("the project configures Node REPL; its configuration was preserved");
    }
    const sourceEnv = source.env ?? {};
    const sessionEnv = session.env ?? {};
    const moduleDir = join(dirname(dirname(source.command)), "lib", "node_modules");
    const node = sourceEnv.NODE_REPL_NODE_PATH;
    const cli = sourceEnv.CODEX_CLI_PATH;
    const helper = sourceEnv.SKY_CUA_SERVICE_PATH;
    if (![node, cli, helper].every((path) => typeof path === "string" && isAbsolute(path))) {
      return skipNativeDefault("the desktop native runtime configuration is incomplete");
    }
    // Validate only files; executing the helper would exceed startup's authority.
    await Promise.all([
      ...[source.command, node, cli, join(helper, "Contents", "MacOS", "SkyComputerUseService")].map((path) =>
        access(path, constants.X_OK),
      ),
      access(join(moduleDir, "@oai", "sky", "package.json"), constants.R_OK),
    ]);

    const env = {
      NODE_REPL_NODE_PATH: node,
      CODEX_CLI_PATH: cli,
      CODEX_HOME: sourceEnv.CODEX_HOME || desktopHome,
      SKY_CUA_SERVICE_PATH: helper,
      NODE_REPL_NODE_MODULE_DIRS: mergePaths(
        moduleDir,
        sourceEnv.NODE_REPL_NODE_MODULE_DIRS,
        sessionEnv.NODE_REPL_NODE_MODULE_DIRS,
      ),
      NODE_REPL_TRUSTED_CODE_PATHS: mergePaths(
        moduleDir,
        sourceEnv.NODE_REPL_TRUSTED_CODE_PATHS,
        sessionEnv.NODE_REPL_TRUSTED_CODE_PATHS,
      ),
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
        ...trustedServices(sourceEnv.NODE_REPL_TRUSTED_SERVICES),
        ...trustedServices(sessionEnv.NODE_REPL_TRUSTED_SERVICES),
        sky: "@oai/sky/service",
      }),
    };
    // Leaf overrides retain session-specific tools, timeouts, browser settings,
    // other MCP servers, and the disabled legacy direct computer-use entry.
    const settings: Record<string, string | string[] | boolean> = {
      command: source.command,
      args: source.args ?? [],
      enabled: true,
    };
    for (const [key, value] of Object.entries(env)) settings[`env.${key}`] = value;
    return Object.entries(settings).flatMap(([key, value]) => [
      "-c",
      `mcp_servers.node_repl.${key}=${JSON.stringify(value)}`,
    ]);
  } catch {
    // Parser errors may echo TOML or environment values containing credentials.
    return skipNativeDefault("could not read or validate the installed native runtime prerequisites");
  }
}

function nodeReplConfig(config: CodexConfig): NodeReplConfig {
  const server = config.mcp_servers?.node_repl ?? {};
  if (
    (server.command !== undefined && typeof server.command !== "string") ||
    (server.args !== undefined &&
      (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string"))) ||
    (server.env !== undefined &&
      (!server.env ||
        typeof server.env !== "object" ||
        Array.isArray(server.env) ||
        !Object.values(server.env).every((value) => typeof value === "string")))
  ) {
    throw new Error("invalid Node REPL configuration");
  }
  return server;
}

function skipNativeDefault(reason: string): string[] {
  console.warn(`[cli-launcher] Native computer-use default not applied: ${reason}`);
  return [];
}

function isBundledNodeRepl(command: string): boolean {
  return isAbsolute(command) && command.endsWith("/Contents/Resources/cua_node/bin/node_repl");
}

function trustedServices(raw?: string): Record<string, string> {
  if (!raw) return {};
  const services: unknown = JSON.parse(raw);
  if (
    !services ||
    typeof services !== "object" ||
    Array.isArray(services) ||
    !Object.values(services).every((v) => typeof v === "string")
  ) {
    throw new Error("invalid Node REPL trusted-service mapping");
  }
  return services as Record<string, string>;
}

function mergePaths(...values: (string | undefined)[]): string {
  return [...new Set(values.flatMap((value) => value?.split(":").filter(Boolean) ?? []))].join(":");
}

async function hasProjectNodeRepl(cwd: string, desktopHome: string): Promise<boolean> {
  // CLI flags outrank project config. Leave any project-owned Node REPL alone,
  // even if trust is unknown, rather than turn a default into a forced override.
  for (let directory = await realpath(cwd); ; directory = dirname(directory)) {
    const path = join(directory, ".codex", "config.toml");
    if (path !== join(resolve(desktopHome), "config.toml")) {
      if (Object.keys(nodeReplConfig(Bun.TOML.parse(await optionalConfig(path)))).length > 0) return true;
    }
    try {
      await access(join(directory, ".git"));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) return false;
  }
}

async function optionalConfig(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}
