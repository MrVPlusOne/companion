import {
  mkdir,
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
  unlink,
  open,
  readdir,
  stat,
} from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { getLegacyCodexHome, resolveCompanionCodexHome, resolveCompanionCodexSessionHome } from "./codex-home.js";
import { seedCodexResumeRollout } from "./codex-resume-rollout.js";
import {
  NON_INTERACTIVE_GIT_EDITOR_ENV_KEYS,
  stripInheritedTelemetryEnv,
  withNonInteractiveGitEditorEnv,
} from "./cli-launcher-env.js";
import {
  escapeRegExp,
  readStringSettingInSection,
  readTopLevelNumberSetting,
  readTopLevelStringSetting,
  removeTopLevelTomlSettings,
  upsertBooleanSettingInSection,
  upsertShellEnvironmentIncludeOnly,
  upsertTopLevelNumberSetting,
  upsertTopLevelStringSetting,
} from "./cli-launcher-codex-config-utils.js";
import { CooperativeTiming } from "./cooperative-timing.js";
import { buildTakodeDelegateMcpConfig, upsertTakodeDelegateMcpServer } from "./codex-delegate-mcp-config.js";
import { resolveBinary, getEnrichedPath, captureUserShellEnv } from "./path-resolver.js";
import { sessionTag } from "./session-tag.js";
import { isDeprecatedProjectSkillSlug } from "./skill-symlink.js";
import {
  CODEX_LEADER_RECYCLE_FALLBACK_THRESHOLD_TOKENS,
  resolveCodexLeaderRecycleThresholdFromEffectiveContext,
  type CodexLeaderRecycleThresholdResolution,
} from "./codex-leader-recycle-threshold.js";
import {
  createCodexInstalledModelCatalogLoader,
  readCodexModelCatalogEntry,
  resolveCodexReasoningSummaryLaunchMode,
  type CodexReasoningSummaryLaunchMode,
} from "./codex-reasoning-summary-config.js";
import {
  effectiveContextPercentFromModelEntry,
  leaderRecycleThresholdForUsableCapacity,
  rawContextWindowForUsableCapacity,
} from "./codex-context-capacity.js";
import { isCodexLeaderRecycleMode, type CodexLeaderCompactionMode } from "../shared/codex-leader-compaction-mode.js";
import {
  appendCodexContextLaunchArgs,
  CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  deriveCodexLeaderLaunchGuard,
  effectiveContextWindowFromModelEntry,
  logCodexContextWindowDiagnostics,
  nonLeaderAutoCompactTokenLimitForUsableCapacity,
  resolveCodexContextWindowDiagnostics,
  type CodexLeaderLaunchGuard,
  type CodexResolvedContextLaunchConfig,
} from "./codex-context-launch-diagnostics.js";
import type { CodexContextWindowDiagnostics } from "./codex-context-types.js";
import type { CodexMultiAgentVersion } from "../shared/codex-multi-agent-version.js";
import {
  syncCodexGlobalInstructionFiles,
  readEffectiveCodexGlobalInstructions,
  renderContainerCodexGlobalInstructionWrite,
  type CodexGlobalInstructionSnapshot,
} from "./codex-global-instructions.js";
import type { CodexInstructionContext } from "./codex-instruction-snapshot.js";

const codexFeaturesHeader = "[features]";
const codexMultiAgentFeature = "multi_agent";
const codexMultiAgentV2Feature = "multi_agent_v2";
const codexImageGenerationFeature = "image_generation";
const sessionScopedCodexConfigKeys = new Set(["developer_instructions"]);
const dotslashShebang = "#!/usr/bin/env dotslash";
const codexBootstrapCacheMarker = 'CACHE_DIR = os.path.expanduser("~/.cache/codex")';
const nodeShebangRe = /^#!.*\bnode(?:\s|$)/;
const hostCodexShellEnvVars = ["LITELLM_API_KEY", "LITELLM_PROXY_URL", "LITELLM_BASE_URL"] as const;
const maiWrapperRootMarker = ".mai-agents-root";
const maiWrapperEnvHostPrefix = "companion-codex-home-";
const maiWrapperHostnameShimDirName = ".mai-wrapper-bin";
const imagegenSkillRelativePath = ".system/imagegen";
const deprecatedCodexSkillsDirName = "skills";
const defaultCodexLeaderRecycleThresholdTokens = CODEX_LEADER_RECYCLE_FALLBACK_THRESHOLD_TOKENS;
const takodeLeaderModelCatalogFilename = "takode-leader-model-catalog.json";
const spawnPrepCacheTtlMs = 60_000;
const takodeNonLeaderModelCatalogFilename = "takode-model-catalog.json";
const takodeNonLeaderModelCatalogSourceFilename = "takode-model-catalog-source.json";
const containerTakodeNonLeaderModelCatalogPath = "/root/.codex/takode-model-catalog.json";
const containerTakodeLeaderModelCatalogPath = "/root/.codex/takode-leader-model-catalog.json";

type HostCodexBinaryKind = "native" | "dotslash" | "bootstrap";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexApprovalPolicy = "never" | "untrusted" | "on-request" | "on-failure";
const hostLaunchBinaryCache = new Map<string, TimedPromiseCacheEntry<{ binary: string; dotslashCache?: string }>>();
const legacySkillMigrationCache = new Map<string, TimedPromiseCacheEntry<void>>();
let spawnPrepCacheStats: CodexSpawnPrepCacheStats = {
  hostLaunchBinaryCacheHits: 0,
  hostLaunchBinaryCacheMisses: 0,
  latestCachedCodexArtifactScans: 0,
  legacySkillMigrationCacheHits: 0,
  legacySkillMigrationCacheMisses: 0,
};
interface MaiWrapperSessionLaunchSpec {
  hostnameShimDir: string;
}

interface MaiWrapperHostSpec {
  hostCodexHome?: string;
  hostEnvRaw: string;
  wrapperRoot: string;
}

export class MissingCodexBinaryError extends Error {}

interface TimedPromiseCacheEntry<T> {
  expiresAtMs: number;
  promise: Promise<T>;
}

interface CodexSpawnPrepCacheStats {
  hostLaunchBinaryCacheHits: number;
  hostLaunchBinaryCacheMisses: number;
  latestCachedCodexArtifactScans: number;
  legacySkillMigrationCacheHits: number;
  legacySkillMigrationCacheMisses: number;
}

interface CodexLaunchInfo {
  cwd: string;
  cliSessionId?: string;
  isOrchestrator?: boolean;
  codexLeaderCompactionMode?: CodexLeaderCompactionMode;
  codexLeaderRecycleThresholdTokens?: number;
  codexLeaderRecycleLineage?: {
    recycleEvents?: Array<{
      trigger?: string;
      tokenUsage?: {
        modelContextWindow?: number;
      };
    }>;
  };
}

interface CodexLaunchOptions {
  model?: string;
  codexBinary?: string;
  permissionMode?: string;
  askPermission?: boolean;
  uiMode?: "plan" | "agent";
  codexSandbox?: CodexSandboxMode;
  codexInternetAccess?: boolean;
  codexReasoningEffort?: string;
  /** Server-selected native Codex collaboration implementation. */
  codexMultiAgentVersion?: CodexMultiAgentVersion;
  /** Desired usable context capacity; raw provider/catalog values are derived during launch prep. */
  codexMaxContextLength?: number;
  codexHome?: string;
  containerId?: string;
  env?: Record<string, string>;
  resumeCliSessionId?: string;
  codexResumeSourceSessionId?: string;
  requireResumeCliSessionId?: boolean;
  /** Legacy compatibility only; leader thresholds are derived from model effective context. */
  codexLeaderRecycleThresholdTokens?: number;
  /** Codex leader context management mode. Missing means recycle for backward compatibility. */
  codexLeaderCompactionMode?: CodexLeaderCompactionMode;
  /** Deprecated compatibility setting; ignored so non-leader compaction follows Codex defaults. */
  codexNonLeaderAutoCompactThresholdPercent?: number;
  codexLegacyHome?: string;
  codexAgentsSkillsHome?: string;
  codexHomePrepared?: boolean;
  codexSpawnPrepYieldEveryMs?: number;
}

export interface CodexSpawnSpec {
  spawnCmd: string[];
  spawnEnv: Record<string, string | undefined>;
  spawnCwd: string | undefined;
  sandboxMode?: CodexSandboxMode;
  reasoningSummary?: CodexReasoningSummaryLaunchMode;
  codexLeaderRecycleThresholdTokens?: number;
  contextWindowDiagnostics: CodexContextWindowDiagnostics;
  instructionContext: CodexInstructionContext;
}

function codexGlobalInstructionFilenamesForContext(runtimeHome: string, sourceHome: string) {
  return (["AGENTS.override.md", "AGENTS.md"] as const).map((filename) => ({
    loadedPath: join(runtimeHome, filename),
    sourcePath: join(sourceHome, filename),
    delivery: "copied_snapshot" as const,
  }));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function nowMs(): number {
  return Date.now();
}

function getAgentsSkillsHome(): string {
  return join(homedir(), ".agents", "skills");
}

async function pathFingerprint(path: string): Promise<string> {
  if (!(await fileExists(path))) return "missing";
  const pathStat = await stat(path).catch(() => null);
  if (!pathStat) return "missing";
  const isDirectory = typeof pathStat.isDirectory === "function" && pathStat.isDirectory();
  const isFile = typeof pathStat.isFile === "function" && pathStat.isFile();
  return `${isDirectory ? "dir" : isFile ? "file" : "other"}:${pathStat.size}:${pathStat.mtimeMs}`;
}

async function directoryEntryFingerprint(path: string): Promise<string> {
  const fingerprint = await pathFingerprint(path);
  if (fingerprint === "missing") return fingerprint;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) return fingerprint;
  const entrySummary = entries
    .map((entry) => {
      const kind = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
      return `${entry.name}:${kind}`;
    })
    .sort()
    .join(",");
  return `${fingerprint}:${entrySummary}`;
}

function getFreshCachedPromise<T>(cache: Map<string, TimedPromiseCacheEntry<T>>, key: string): Promise<T> | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs <= nowMs()) {
    cache.delete(key);
    return null;
  }
  return cached.promise;
}

async function setTimedPromiseCacheEntry<T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  key: string,
  makePromise: () => Promise<T>,
): Promise<T> {
  const promise = makePromise();
  cache.set(key, { expiresAtMs: nowMs() + spawnPrepCacheTtlMs, promise });
  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
    throw error;
  }
}

function mapCodexApprovalPolicy(permissionMode?: string, askPermission?: boolean): CodexApprovalPolicy | undefined {
  switch (permissionMode) {
    case "codex-custom":
      return undefined;
    case "codex-default":
      return "on-request";
    case "codex-auto-review":
      return "on-request";
    case "codex-full-access":
      return "never";
  }

  const effectiveAskPermission =
    typeof askPermission === "boolean" ? askPermission : permissionMode !== "bypassPermissions";
  if (!effectiveAskPermission) return "never";
  return permissionMode === "bypassPermissions" ? "never" : "untrusted";
}

function resolveCodexSandbox(permissionMode?: string, requested?: CodexSandboxMode): CodexSandboxMode | undefined {
  if (permissionMode === "codex-custom") return undefined;
  if (requested) return requested;
  switch (permissionMode) {
    case "codex-auto-review":
      return "workspace-write";
    case "codex-full-access":
    case "bypassPermissions":
      return "danger-full-access";
    case "codex-default":
    default:
      return "workspace-write";
  }
}

function mergePathStrings(paths: Array<string | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const pathValue of paths) {
    for (const entry of (pathValue || "").split(":")) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.join(":");
}

function normalizeMaiHostname(input: string): string {
  let normalized = input.replace(/[^A-Za-z0-9._-]/g, "-");
  while (normalized.length > 0 && /^[._-]/.test(normalized)) normalized = normalized.slice(1);
  while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  if (normalized.length > 64) {
    normalized = normalized.slice(0, 64);
    while (normalized.length > 0 && /[._-]$/.test(normalized)) normalized = normalized.slice(0, -1);
  }
  return normalized || "host";
}

function quoteShellEnvValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readShellEnvAssignment(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^${escapeRegExp(key)}=(.*)$`, "m"));
  if (!match) return undefined;
  const value = match[1]?.trim() || "";
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\\\''/g, "'");
  }
  return value;
}
function isCodexLeaderLaunch(info: CodexLaunchInfo, options: CodexLaunchOptions): boolean {
  return info.isOrchestrator === true || options.env?.TAKODE_ROLE === "orchestrator";
}

function isCodexLeaderRecycleLaunch(info: CodexLaunchInfo, options: CodexLaunchOptions): boolean {
  if (!isCodexLeaderLaunch(info, options)) return false;
  return isCodexLeaderRecycleMode(options.codexLeaderCompactionMode ?? info.codexLeaderCompactionMode);
}

async function readMaiWrapperHostEnv(wrapperRoot: string): Promise<string> {
  const currentHostname = hostname();
  const shortHostname = currentHostname.split(".")[0] || currentHostname;
  const candidates = Array.from(
    new Set([normalizeMaiHostname(currentHostname), normalizeMaiHostname(shortHostname)]).values(),
  ).filter(Boolean);

  for (const candidate of candidates) {
    const hostEnvPath = join(wrapperRoot, ".run", `.env-${candidate}`);
    const hostEnvRaw = await readFile(hostEnvPath, "utf-8").catch(() => "");
    if (hostEnvRaw) return hostEnvRaw;
  }
  return "";
}

async function resolveMaiWrapperHostSpec(binary: string): Promise<MaiWrapperHostSpec | null> {
  if (basename(binary) !== "codex.sh") return null;

  let resolvedBinary = binary;
  try {
    resolvedBinary = await realpath(binary);
  } catch {
    resolvedBinary = binary;
  }

  const wrapperRoot = dirname(resolvedBinary);
  if (!(await fileExists(join(wrapperRoot, maiWrapperRootMarker)))) {
    return null;
  }

  const hostEnvRaw = await readMaiWrapperHostEnv(wrapperRoot);
  return {
    hostCodexHome: readShellEnvAssignment(hostEnvRaw, "CODEX_HOME"),
    hostEnvRaw,
    wrapperRoot,
  };
}

function renderMaiWrapperSessionEnv(hostEnvRaw: string, codexHome: string, options: CodexLaunchOptions): string {
  let out = hostEnvRaw;
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  out += "# Takode session overrides\n";
  out += `CODEX_HOME=${quoteShellEnvValue(codexHome)}\n`;

  for (const key of hostCodexShellEnvVars) {
    const value = options.env?.[key];
    if (value) out += `${key}=${quoteShellEnvValue(value)}\n`;
  }

  return out;
}

function scrubSessionScopedCodexConfig(configToml: string): string {
  return removeTopLevelTomlSettings(configToml, sessionScopedCodexConfigKeys);
}

function getSelectedProviderEnvKeys(configToml: string): string[] {
  const provider = readTopLevelStringSetting(configToml, "model_provider")?.trim();
  if (!provider) return [];
  const envKey = readStringSettingInSection(configToml, `[model_providers.${provider}]`, "env_key")?.trim();
  return envKey ? [envKey] : [];
}

function usesMaiLitellmProvider(configToml: string): boolean {
  return readTopLevelStringSetting(configToml, "model_provider")?.trim().toLowerCase() === "mai-litellm";
}

function isTakodeNonLeaderModelCatalogConfigPath(codexHome: string, rawPath: string): boolean {
  const resolvedPath = resolveConfigPathValue(codexHome, rawPath);
  return (
    resolvedPath === resolve(codexHome, takodeNonLeaderModelCatalogFilename) ||
    resolvedPath === containerTakodeNonLeaderModelCatalogPath
  );
}

async function ensureMaiWrapperHostnameShim(shimDir: string, hostnameValue: string): Promise<void> {
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, "hostname");
  const shimContents = `#!/usr/bin/env bash
printf '%s\\n' ${quoteShellEnvValue(hostnameValue)}
`;
  await writeFile(shimPath, shimContents, "utf-8");
  await chmod(shimPath, 0o755);
}

async function resolveMaiWrapperSessionLaunchSpec(
  hostSpec: MaiWrapperHostSpec,
  sessionId: string,
  codexHome: string,
  options: CodexLaunchOptions,
): Promise<MaiWrapperSessionLaunchSpec | null> {
  const overlayHostname = normalizeMaiHostname(`${maiWrapperEnvHostPrefix}${sessionId}`);
  const overlayEnvPath = join(hostSpec.wrapperRoot, ".run", `.env-${overlayHostname}`);
  const overlayEnv = renderMaiWrapperSessionEnv(hostSpec.hostEnvRaw, codexHome, options);
  await mkdir(dirname(overlayEnvPath), { recursive: true });
  await writeFile(overlayEnvPath, overlayEnv, "utf-8");

  const hostnameShimDir = join(codexHome, maiWrapperHostnameShimDirName);
  await ensureMaiWrapperHostnameShim(hostnameShimDir, overlayHostname);
  return { hostnameShimDir };
}
function resolveConfigPathValue(configDir: string, rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return join(homedir(), rawPath.slice(2));
  }
  return resolve(configDir, rawPath);
}

function coercePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function displayNameFromModelSlug(modelSlug: string): string {
  if (/^gpt-/i.test(modelSlug)) return `GPT-${modelSlug.slice(4)}`;
  return modelSlug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

function ensureCodexModelEntrySchemaDefaults(modelEntry: Record<string, any>, modelSlug: string): boolean {
  let changed = false;
  const setDefault = (key: string, value: any, isValid: (current: unknown) => boolean) => {
    if (isValid(modelEntry[key])) return;
    modelEntry[key] = value;
    changed = true;
  };

  setDefault("display_name", displayNameFromModelSlug(modelSlug), (value) => typeof value === "string");
  setDefault(
    "supported_reasoning_levels",
    [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
      { effort: "ultra", description: "Maximum reasoning that may proactively use multiple agents" },
    ],
    Array.isArray,
  );
  setDefault("shell_type", "shell_command", (value) => typeof value === "string");
  setDefault("visibility", "list", (value) => typeof value === "string");
  setDefault("supported_in_api", true, (value) => typeof value === "boolean");
  setDefault("priority", 0, (value) => typeof value === "number" && Number.isFinite(value));
  setDefault("base_instructions", "", (value) => typeof value === "string");
  setDefault("supports_reasoning_summaries", true, (value) => typeof value === "boolean");
  setDefault("support_verbosity", true, (value) => typeof value === "boolean");
  setDefault(
    "truncation_policy",
    { mode: "tokens", limit: 10000 },
    (value) =>
      !!value &&
      typeof value === "object" &&
      typeof (value as any).mode === "string" &&
      typeof (value as any).limit === "number",
  );
  setDefault("supports_parallel_tool_calls", true, (value) => typeof value === "boolean");
  setDefault("experimental_supported_tools", [], Array.isArray);

  return changed;
}

function disableResponsesLiteForMaiLitellm(modelEntry: Record<string, any>): boolean {
  if (modelEntry.use_responses_lite !== true) return false;
  modelEntry.use_responses_lite = false;
  return true;
}

interface CodexLeaderLaunchConfig extends CodexResolvedContextLaunchConfig {
  recycleThresholdTokens: number;
  sourceEffectiveContextWindowTokens?: number;
  source?: string;
}

type CodexContextLaunchConfig = CodexResolvedContextLaunchConfig;

interface CodexLeaderRecycleThresholdForConfig extends CodexLeaderRecycleThresholdResolution {
  source?: string;
}

async function resolveCodexLeaderRecycleThresholdForConfig(
  codexHome: string,
  configToml: string,
  modelId: string | undefined,
): Promise<CodexLeaderRecycleThresholdForConfig> {
  const modelSlug = modelId || readTopLevelStringSetting(configToml, "model");
  const configuredRawContextWindow = readTopLevelNumberSetting(configToml, "model_context_window");
  const existingCatalogPathValue = readTopLevelStringSetting(configToml, "model_catalog_json");
  const existingCatalogPath = existingCatalogPathValue
    ? resolveConfigPathValue(codexHome, existingCatalogPathValue)
    : undefined;
  const existingCatalogIsTakodeLeaderGenerated =
    !!existingCatalogPath && basename(existingCatalogPath) === takodeLeaderModelCatalogFilename;
  if (!modelSlug) {
    const configuredEffectiveContextWindow =
      configuredRawContextWindow && !existingCatalogIsTakodeLeaderGenerated
        ? Math.floor((configuredRawContextWindow * CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100)
        : undefined;
    return {
      ...resolveCodexLeaderRecycleThresholdFromEffectiveContext(configuredEffectiveContextWindow),
      source: configuredEffectiveContextWindow ? "config" : "fallback",
    };
  }

  const sourceCatalogCandidates = [
    existingCatalogPath && !existingCatalogIsTakodeLeaderGenerated ? existingCatalogPath : undefined,
    join(codexHome, "models_cache.json"),
    join(getLegacyCodexHome(), "models_cache.json"),
  ].filter((candidate, index, all): candidate is string => !!candidate && all.indexOf(candidate) === index);

  for (const sourceCatalogPath of sourceCatalogCandidates) {
    const modelEntry = await readCodexModelCatalogEntry(sourceCatalogPath, modelSlug);
    const effectiveContextWindow = modelEntry ? effectiveContextWindowFromModelEntry(modelEntry) : undefined;
    if (effectiveContextWindow) {
      return {
        ...resolveCodexLeaderRecycleThresholdFromEffectiveContext(effectiveContextWindow),
        source: sourceCatalogPath,
      };
    }
  }

  const configuredEffectiveContextWindow =
    configuredRawContextWindow && !existingCatalogIsTakodeLeaderGenerated
      ? Math.floor((configuredRawContextWindow * CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100)
      : undefined;
  return {
    ...resolveCodexLeaderRecycleThresholdFromEffectiveContext(configuredEffectiveContextWindow),
    source: configuredEffectiveContextWindow ? "config" : "fallback",
  };
}

function latestThresholdRecycleBudget(info: CodexLaunchInfo): number | undefined {
  const recycleEvents = info.codexLeaderRecycleLineage?.recycleEvents;
  if (!Array.isArray(recycleEvents)) return undefined;
  for (let index = recycleEvents.length - 1; index >= 0; index -= 1) {
    const event = recycleEvents[index];
    if (event?.trigger !== "threshold") continue;
    const budget = coercePositiveNumber(event.tokenUsage?.modelContextWindow);
    if (budget) return budget;
  }
  return undefined;
}

function existingLeaderRecycleBudget(info: CodexLaunchInfo): number | undefined {
  const current = coercePositiveNumber(info.codexLeaderRecycleThresholdTokens) ?? 0;
  const latestRecycleBudget = latestThresholdRecycleBudget(info) ?? 0;
  const budget = Math.max(current, latestRecycleBudget);
  return budget > 0 ? budget : undefined;
}

function forceCodexModelEntryMultiAgentVersion(
  modelEntry: Record<string, any>,
  multiAgentVersion?: CodexMultiAgentVersion,
): boolean {
  if (!multiAgentVersion || modelEntry.multi_agent_version === multiAgentVersion) return false;
  modelEntry.multi_agent_version = multiAgentVersion;
  return true;
}

async function ensureCodexLeaderModelCatalogOverride(
  codexHome: string,
  configToml: string,
  recycleThresholdTokens: number,
  options?: {
    model?: string;
    modelCatalogConfigPath?: string;
    multiAgentVersion?: CodexMultiAgentVersion;
  },
): Promise<{ catalogJson?: string; configToml: string; launchGuard: CodexLeaderLaunchGuard }> {
  let launchGuard = deriveCodexLeaderLaunchGuard(
    recycleThresholdTokens,
    CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  );
  const override = await ensureCodexModelCatalogOverride(codexHome, configToml, {
    model: options?.model,
    modelCatalogConfigPath: options?.modelCatalogConfigPath,
    catalogFilename: takodeLeaderModelCatalogFilename,
    createModelEntry: (modelSlug) => ({
      slug: modelSlug,
      context_window: launchGuard.providerRawContextWindow,
      max_context_window: launchGuard.providerRawContextWindow,
      effective_context_window_percent: CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
      auto_compact_token_limit: launchGuard.providerAutoCompactTokenLimit,
    }),
    mutateModelEntry: (modelEntry) => {
      const effectivePercent =
        coercePositiveNumber(modelEntry.effective_context_window_percent) ||
        CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
      launchGuard = deriveCodexLeaderLaunchGuard(recycleThresholdTokens, effectivePercent);
      const changed =
        modelEntry.context_window !== launchGuard.providerRawContextWindow ||
        modelEntry.max_context_window !== launchGuard.providerRawContextWindow ||
        modelEntry.auto_compact_token_limit !== launchGuard.providerAutoCompactTokenLimit;
      modelEntry.context_window = launchGuard.providerRawContextWindow;
      modelEntry.max_context_window = launchGuard.providerRawContextWindow;
      modelEntry.auto_compact_token_limit = launchGuard.providerAutoCompactTokenLimit;
      const compatibilityChanged = usesMaiLitellmProvider(configToml) && disableResponsesLiteForMaiLitellm(modelEntry);
      const multiAgentChanged = forceCodexModelEntryMultiAgentVersion(modelEntry, options?.multiAgentVersion);
      return changed || compatibilityChanged || multiAgentChanged;
    },
  });
  return { ...override, launchGuard };
}

async function ensureCodexModelCatalogOverride(
  codexHome: string,
  configToml: string,
  options: {
    model?: string;
    modelCatalogConfigPath?: string;
    catalogFilename: string;
    createModelEntry?: (modelSlug: string) => Record<string, any>;
    sourceCatalogSnapshotFilename?: string;
    skipConfiguredCatalogSource?: boolean;
    mutateModelEntry: (modelEntry: Record<string, any>) => boolean;
  },
): Promise<{ catalogJson?: string; configToml: string }> {
  const modelSlug = options?.model || readTopLevelStringSetting(configToml, "model");
  if (!modelSlug) return { configToml };

  const existingCatalogPathValue = readTopLevelStringSetting(configToml, "model_catalog_json");
  const configuredCatalogPath = existingCatalogPathValue
    ? resolveConfigPathValue(codexHome, existingCatalogPathValue)
    : undefined;
  const sourceCatalogSnapshotPath = options.sourceCatalogSnapshotFilename
    ? join(codexHome, options.sourceCatalogSnapshotFilename)
    : undefined;
  const sourceCatalogCandidates = [
    configuredCatalogPath && !options.skipConfiguredCatalogSource ? configuredCatalogPath : undefined,
    options.skipConfiguredCatalogSource ? sourceCatalogSnapshotPath : undefined,
    join(codexHome, "models_cache.json"),
    join(getLegacyCodexHome(), "models_cache.json"),
  ].filter((candidate, index, all): candidate is string => !!candidate && all.indexOf(candidate) === index);

  let parsedCatalog: any = null;
  let parsedCatalogSourcePath: string | undefined;
  for (const sourceCatalogPath of sourceCatalogCandidates) {
    if (!(await fileExists(sourceCatalogPath))) continue;
    try {
      parsedCatalog = JSON.parse(await readFile(sourceCatalogPath, "utf-8"));
      if (Array.isArray(parsedCatalog?.models)) {
        parsedCatalogSourcePath = sourceCatalogPath;
        break;
      }
    } catch (error) {
      console.warn(`[cli-launcher] Failed to parse Codex model catalog ${sourceCatalogPath}:`, error);
      parsedCatalog = null;
    }
  }
  if (!Array.isArray(parsedCatalog?.models)) {
    if (!options.createModelEntry) return { configToml };
    parsedCatalog = { models: [] };
  }

  if (
    sourceCatalogSnapshotPath &&
    configuredCatalogPath &&
    parsedCatalogSourcePath === configuredCatalogPath &&
    existingCatalogPathValue &&
    !isTakodeNonLeaderModelCatalogConfigPath(codexHome, existingCatalogPathValue)
  ) {
    // Once config points at Takode's generated catalog, the user's original
    // catalog path is no longer present there. Keep an unmodified session-local
    // source snapshot so later V1/V2 launches and context reset can rebuild the
    // generated entry without discarding custom model metadata.
    await writeFile(sourceCatalogSnapshotPath, JSON.stringify(parsedCatalog, null, 2) + "\n", "utf-8");
  }

  const modelEntries = parsedCatalog.models as any[];
  let modelEntry = modelEntries.find((entry: any) => entry?.slug === modelSlug);
  let addedModelEntry = false;
  if (!modelEntry || typeof modelEntry !== "object") {
    if (!options.createModelEntry) return { configToml };
    modelEntry = options.createModelEntry(modelSlug);
    modelEntries.push(modelEntry);
    addedModelEntry = true;
  }
  const schemaDefaultsChanged = ensureCodexModelEntrySchemaDefaults(modelEntry, modelSlug);
  const changed = options.mutateModelEntry(modelEntry) || addedModelEntry || schemaDefaultsChanged;

  const catalogJson = JSON.stringify(parsedCatalog, null, 2) + "\n";
  const catalogPath = join(codexHome, options.catalogFilename);
  const catalogConfigPath = options?.modelCatalogConfigPath || catalogPath;
  if (
    !options.skipConfiguredCatalogSource &&
    !changed &&
    configuredCatalogPath === resolveConfigPathValue(codexHome, catalogConfigPath)
  ) {
    return { configToml };
  }
  await writeFile(catalogPath, catalogJson, "utf-8");

  const nextConfigToml = upsertTopLevelStringSetting(configToml, "model_catalog_json", catalogConfigPath);
  return { configToml: nextConfigToml, catalogJson };
}

async function scrubTakodeNonLeaderContextOverride(
  codexHome: string,
  configToml: string,
  options?: { model?: string; preserveModelCatalog?: boolean },
): Promise<string> {
  const rawCatalogPath = readTopLevelStringSetting(configToml, "model_catalog_json");
  if (!rawCatalogPath || !isTakodeNonLeaderModelCatalogConfigPath(codexHome, rawCatalogPath)) return configToml;

  const modelSlug = options?.model || readTopLevelStringSetting(configToml, "model");
  const topLevelContextWindow = readTopLevelNumberSetting(configToml, "model_context_window");
  const topLevelAutoCompactLimit = readTopLevelNumberSetting(configToml, "model_auto_compact_token_limit");
  let shouldRemoveTopLevelContext = false;
  let shouldRemoveTopLevelAutoCompact = false;
  if (modelSlug && topLevelContextWindow) {
    const catalogPath = resolveConfigPathValue(codexHome, rawCatalogPath);
    const modelEntry = await readCodexModelCatalogEntry(catalogPath, modelSlug);
    const catalogContextWindow =
      coercePositiveNumber(modelEntry?.context_window) || coercePositiveNumber(modelEntry?.max_context_window);
    shouldRemoveTopLevelContext = catalogContextWindow === topLevelContextWindow;
    shouldRemoveTopLevelAutoCompact =
      shouldRemoveTopLevelContext &&
      !!topLevelAutoCompactLimit &&
      coercePositiveNumber(modelEntry?.auto_compact_token_limit) === topLevelAutoCompactLimit;
  }

  const keys = new Set<string>();
  if (!options?.preserveModelCatalog) keys.add("model_catalog_json");
  if (shouldRemoveTopLevelContext) keys.add("model_context_window");
  if (shouldRemoveTopLevelAutoCompact) keys.add("model_auto_compact_token_limit");
  return removeTopLevelTomlSettings(configToml, keys);
}

async function ensureCodexNonLeaderContextCapacityOverride(
  codexHome: string,
  configToml: string,
  desiredUsableContextWindow: number,
  options?: {
    model?: string;
    modelCatalogConfigPath?: string;
    multiAgentVersion?: CodexMultiAgentVersion;
  },
): Promise<{ configToml: string; modelCatalogJson?: string; launchConfig: CodexContextLaunchConfig }> {
  let rawContextWindow = rawContextWindowForUsableCapacity(
    desiredUsableContextWindow,
    CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  );
  const modelAutoCompactTokenLimit = nonLeaderAutoCompactTokenLimitForUsableCapacity(desiredUsableContextWindow);
  let effectivePercent = CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT;
  const override = await ensureCodexModelCatalogOverride(codexHome, configToml, {
    model: options?.model,
    modelCatalogConfigPath: options?.modelCatalogConfigPath,
    catalogFilename: takodeNonLeaderModelCatalogFilename,
    sourceCatalogSnapshotFilename: takodeNonLeaderModelCatalogSourceFilename,
    createModelEntry: (modelSlug) => ({
      slug: modelSlug,
      context_window: rawContextWindow,
      max_context_window: rawContextWindow,
      effective_context_window_percent: effectivePercent,
      auto_compact_token_limit: modelAutoCompactTokenLimit,
    }),
    mutateModelEntry: (modelEntry) => {
      effectivePercent = effectiveContextPercentFromModelEntry(modelEntry);
      rawContextWindow = rawContextWindowForUsableCapacity(desiredUsableContextWindow, effectivePercent);
      const changed =
        modelEntry.context_window !== rawContextWindow ||
        modelEntry.max_context_window !== rawContextWindow ||
        modelEntry.effective_context_window_percent !== effectivePercent ||
        modelEntry.auto_compact_token_limit !== modelAutoCompactTokenLimit;
      modelEntry.context_window = rawContextWindow;
      modelEntry.max_context_window = rawContextWindow;
      modelEntry.effective_context_window_percent = effectivePercent;
      modelEntry.auto_compact_token_limit = modelAutoCompactTokenLimit;
      const compatibilityChanged = usesMaiLitellmProvider(configToml) && disableResponsesLiteForMaiLitellm(modelEntry);
      const multiAgentChanged = forceCodexModelEntryMultiAgentVersion(modelEntry, options?.multiAgentVersion);
      return changed || compatibilityChanged || multiAgentChanged;
    },
  });

  let configTomlWithContext = upsertTopLevelNumberSetting(
    override.configToml,
    "model_context_window",
    rawContextWindow,
  );
  configTomlWithContext = upsertTopLevelNumberSetting(
    configTomlWithContext,
    "model_auto_compact_token_limit",
    modelAutoCompactTokenLimit,
  );
  const modelCatalogConfigPath = readTopLevelStringSetting(configTomlWithContext, "model_catalog_json");
  return {
    configToml: configTomlWithContext,
    modelCatalogJson: override.catalogJson,
    launchConfig: {
      modelContextWindow: rawContextWindow,
      modelAutoCompactTokenLimit,
      catalogEffectiveContextWindowPercent: effectivePercent,
      ...(modelCatalogConfigPath ? { modelCatalogConfigPath } : {}),
    },
  };
}

async function ensureCodexMaiLitellmCatalogCompatibilityOverride(
  codexHome: string,
  configToml: string,
  options?: {
    model?: string;
    modelCatalogConfigPath?: string;
    multiAgentVersion?: CodexMultiAgentVersion;
    skipConfiguredCatalogSource?: boolean;
  },
): Promise<{ configToml: string; modelCatalogJson?: string }> {
  const override = await ensureCodexModelCatalogOverride(codexHome, configToml, {
    model: options?.model,
    modelCatalogConfigPath: options?.modelCatalogConfigPath,
    catalogFilename: takodeNonLeaderModelCatalogFilename,
    sourceCatalogSnapshotFilename: takodeNonLeaderModelCatalogSourceFilename,
    skipConfiguredCatalogSource: options?.skipConfiguredCatalogSource,
    ...(options?.multiAgentVersion ? { createModelEntry: (modelSlug: string) => ({ slug: modelSlug }) } : {}),
    mutateModelEntry: (modelEntry) => {
      const compatibilityChanged = disableResponsesLiteForMaiLitellm(modelEntry);
      const multiAgentChanged = forceCodexModelEntryMultiAgentVersion(modelEntry, options?.multiAgentVersion);
      return compatibilityChanged || multiAgentChanged;
    },
  });
  return { configToml: override.configToml, modelCatalogJson: override.catalogJson };
}

async function ensureCodexMultiAgentModelCatalogOverride(
  codexHome: string,
  configToml: string,
  multiAgentVersion: CodexMultiAgentVersion,
  options?: { model?: string; modelCatalogConfigPath?: string; skipConfiguredCatalogSource?: boolean },
): Promise<{ configToml: string; modelCatalogJson?: string }> {
  const override = await ensureCodexModelCatalogOverride(codexHome, configToml, {
    model: options?.model,
    modelCatalogConfigPath: options?.modelCatalogConfigPath,
    catalogFilename: takodeNonLeaderModelCatalogFilename,
    sourceCatalogSnapshotFilename: takodeNonLeaderModelCatalogSourceFilename,
    skipConfiguredCatalogSource: options?.skipConfiguredCatalogSource,
    createModelEntry: (modelSlug) => ({ slug: modelSlug }),
    mutateModelEntry: (modelEntry) => forceCodexModelEntryMultiAgentVersion(modelEntry, multiAgentVersion),
  });
  return { configToml: override.configToml, modelCatalogJson: override.catalogJson };
}

async function readFilePrefix(path: string, maxBytes = 4096): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function detectHostCodexBinaryKind(path: string): Promise<HostCodexBinaryKind> {
  const prefix = await readFilePrefix(path);
  if (prefix.startsWith(dotslashShebang)) return "dotslash";
  if (prefix.includes(codexBootstrapCacheMarker)) return "bootstrap";
  return "native";
}

async function shouldInvokeCodexWithSiblingNode(path: string): Promise<boolean> {
  const prefix = await readFilePrefix(path, 512);
  return nodeShebangRe.test(prefix);
}

function getLegacyDotslashCacheDirs(): string[] {
  const dirs = new Set<string>();
  const explicit = process.env.DOTSLASH_CACHE?.trim();
  if (explicit) dirs.add(resolve(explicit));
  if (process.platform === "darwin") {
    dirs.add(join(homedir(), "Library", "Caches", "dotslash"));
  }
  dirs.add(join(homedir(), ".cache", "dotslash"));
  return [...dirs];
}

async function findLatestCachedCodexArtifact(): Promise<string | null> {
  spawnPrepCacheStats.latestCachedCodexArtifactScans++;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const root of getLegacyDotslashCacheDirs()) {
    const prefixes = await readdir(root).catch(() => []);
    for (const prefix of prefixes) {
      const prefixDir = join(root, prefix);
      const hashes = await readdir(prefixDir).catch(() => []);
      for (const hash of hashes) {
        const artifact = join(prefixDir, hash, "codex");
        try {
          const artifactStat = await stat(artifact);
          if (artifactStat.isFile()) {
            candidates.push({ path: artifact, mtimeMs: artifactStat.mtimeMs });
          }
        } catch {
          // Not a codex artifact directory.
        }
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
}

async function prepareDotslashCache(dotslashCache: string, timing?: CooperativeTiming): Promise<void> {
  await mkdir(dotslashCache, { recursive: true });
  await timing?.yieldIfDue("prepare dotslash cache mkdir");

  let existingEntries: string[] = [];
  try {
    existingEntries = await readdir(dotslashCache);
  } catch {
    existingEntries = [];
  }
  if (existingEntries.length > 0) return;

  for (const sourceRoot of getLegacyDotslashCacheDirs()) {
    if (resolve(sourceRoot) === resolve(dotslashCache)) continue;
    const sourceEntries = await readdir(sourceRoot).catch(() => []);
    if (sourceEntries.length === 0) continue;

    try {
      for (const entry of sourceEntries) {
        await cp(join(sourceRoot, entry), join(dotslashCache, entry), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        await timing?.yieldIfDue("seed dotslash cache entry");
      }
      return;
    } catch (error) {
      console.warn(`[cli-launcher] Failed to seed DotSlash cache from ${sourceRoot}:`, error);
    }
  }
}

function resolveSymlinkTargetPath(linkPath: string, targetPath: string): string {
  return resolve(dirname(linkPath), targetPath);
}

async function syncSeededDirectory(
  src: string,
  dest: string,
  timing?: CooperativeTiming,
): Promise<"missing" | "unchanged" | "created"> {
  if (!(await fileExists(src))) return "missing";

  const srcStat = await lstat(src).catch(() => null);
  if (!srcStat) {
    if (await fileExists(dest)) return "unchanged";
    await cp(src, dest, { recursive: true });
    await timing?.yieldIfDue("copy Codex seed directory");
    return "created";
  }

  if (srcStat.isSymbolicLink()) {
    const srcTargetRaw = await readlink(src).catch(() => null);
    if (!srcTargetRaw) return "unchanged";

    const desiredTarget = resolveSymlinkTargetPath(src, srcTargetRaw);
    const destStat = await lstat(dest).catch(() => null);
    if (destStat?.isSymbolicLink()) {
      const destTargetRaw = await readlink(dest).catch(() => null);
      if (destTargetRaw && resolveSymlinkTargetPath(dest, destTargetRaw) === desiredTarget) {
        return "unchanged";
      }
    }

    await rm(dest, { recursive: true, force: true }).catch(() => {});
    await symlink(desiredTarget, dest);
    await timing?.yieldIfDue("link Codex seed directory");
    return "created";
  }

  if (await fileExists(dest)) return "unchanged";
  await cp(src, dest, { recursive: true });
  await timing?.yieldIfDue("copy Codex seed directory");
  return "created";
}

function normalizeRelativeSeedPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function isExcludedSeedPath(path: string, excludedRelativePaths: Set<string>): boolean {
  const normalized = normalizeRelativeSeedPath(path);
  if (!normalized) return false;
  for (const excluded of excludedRelativePaths) {
    if (normalized === excluded || normalized.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

async function mergeSkillDirectory(
  src: string,
  dest: string,
  options: { overwriteExisting: boolean; excludedRelativePaths?: Set<string>; timing?: CooperativeTiming },
): Promise<"missing" | "unchanged" | "created"> {
  if (!(await fileExists(src))) return "missing";

  const sourceRoot = await realpath(src).catch(() => src);
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  let copied = false;

  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const entrySrc = join(sourceRoot, entry.name);
    const entryDest = join(dest, entry.name);
    const relativePath = normalizeRelativeSeedPath(relative(sourceRoot, entrySrc));
    if (options.excludedRelativePaths && isExcludedSeedPath(relativePath, options.excludedRelativePaths)) continue;

    if (!options.overwriteExisting && (await fileExists(entryDest))) continue;
    await removeBrokenSymlink(entryDest);
    if (options.overwriteExisting) {
      await rm(entryDest, { recursive: true, force: true }).catch(() => {});
    }
    if (await copySeedEntry(entrySrc, entryDest, sourceRoot, options.excludedRelativePaths, options.timing)) {
      copied = true;
    }
    await options.timing?.yieldIfDue("merge Codex skill entry");
  }

  return copied ? "created" : "unchanged";
}

async function removeBrokenSymlink(path: string): Promise<void> {
  const pathStat = await lstat(path).catch(() => null);
  if (!pathStat?.isSymbolicLink()) return;

  if (await fileExists(path)) return;
  await unlink(path).catch(() => {});
}

async function copySeedEntry(
  entrySrc: string,
  entryDest: string,
  sourceRoot: string,
  excludedRelativePaths?: Set<string>,
  timing?: CooperativeTiming,
): Promise<boolean> {
  const entryStat = await lstat(entrySrc).catch(() => null);
  if (entryStat?.isSymbolicLink() && !(await fileExists(entrySrc))) {
    console.warn(`[cli-launcher] Skipping broken legacy Codex skill symlink: ${entrySrc}`);
    return false;
  }
  if (!entryStat || !entryStat.isDirectory() || entryStat.isSymbolicLink()) {
    await cp(entrySrc, entryDest, { recursive: true });
    await timing?.yieldIfDue("copy Codex skill entry");
    return true;
  }

  await mkdir(entryDest, { recursive: true });
  const stack: Array<{ srcDir: string; destDir: string }> = [{ srcDir: entrySrc, destDir: entryDest }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = await readdir(current.srcDir, { withFileTypes: true }).catch(() => []);
    for (const child of entries) {
      const childSrc = join(current.srcDir, child.name);
      const childDest = join(current.destDir, child.name);
      const relativePath = normalizeRelativeSeedPath(relative(sourceRoot, childSrc));
      if (excludedRelativePaths && isExcludedSeedPath(relativePath, excludedRelativePaths)) continue;

      if (child.isDirectory() && !child.isSymbolicLink()) {
        await mkdir(childDest, { recursive: true });
        stack.push({ srcDir: childSrc, destDir: childDest });
        continue;
      }

      if (child.isSymbolicLink() && !(await fileExists(childSrc))) {
        console.warn(`[cli-launcher] Skipping broken legacy Codex skill symlink: ${childSrc}`);
        continue;
      }

      await cp(childSrc, childDest, { recursive: true });
      await timing?.yieldIfDue("copy Codex skill child entry");
    }
    await timing?.yieldIfDue("copy Codex skill directory");
  }
  return true;
}

async function migrateLegacyCodexSkillsToAgentsHome(
  sourceHome: string,
  options?: {
    filterImagegenSkill?: boolean;
    timing?: CooperativeTiming;
    destSkillsHome?: string;
    legacyCodexHome?: string;
  },
): Promise<void> {
  const dest = options?.destSkillsHome ?? getAgentsSkillsHome();
  const legacyCodexHome = options?.legacyCodexHome ?? getLegacyCodexHome();
  const sourceHomePath = resolve(sourceHome);
  const legacyHomePath = resolve(legacyCodexHome);
  const sourceRoots = Array.from(
    new Set([join(sourceHomePath, "skills"), join(legacyHomePath, "skills")].map((candidate) => resolve(candidate))),
  );
  const rootFingerprints = await Promise.all(sourceRoots.map((root) => directoryEntryFingerprint(root)));
  const destFingerprint = await directoryEntryFingerprint(dest);
  const cacheKey = JSON.stringify({
    dest: resolve(dest),
    destFingerprint,
    filterImagegenSkill: options?.filterImagegenSkill === true,
    roots: sourceRoots.map((root, index) => [root, rootFingerprints[index]]),
  });

  const cached = getFreshCachedPromise(legacySkillMigrationCache, cacheKey);
  if (cached) {
    spawnPrepCacheStats.legacySkillMigrationCacheHits++;
    return cached;
  }

  spawnPrepCacheStats.legacySkillMigrationCacheMisses++;
  return setTimedPromiseCacheEntry(legacySkillMigrationCache, cacheKey, () =>
    migrateLegacyCodexSkillsToAgentsHomeUncached({
      ...options,
      destSkillsHome: dest,
      sourceRoots,
    }),
  );
}

async function migrateLegacyCodexSkillsToAgentsHomeUncached(options: {
  filterImagegenSkill?: boolean;
  timing?: CooperativeTiming;
  destSkillsHome: string;
  sourceRoots: string[];
}): Promise<void> {
  const dest = options.destSkillsHome;
  const excludedRelativePaths = options?.filterImagegenSkill ? new Set([imagegenSkillRelativePath]) : new Set<string>();

  for (const legacySkillsHome of options.sourceRoots) {
    if (legacySkillsHome === resolve(dest)) continue;
    const entries = await readdir(legacySkillsHome, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (isDeprecatedProjectSkillSlug(entry.name)) {
        excludedRelativePaths.add(entry.name);
      }
    }
    await mergeSkillDirectory(legacySkillsHome, dest, {
      overwriteExisting: false,
      excludedRelativePaths,
      timing: options?.timing,
    });
    await options?.timing?.yieldIfDue("migrate legacy Codex skill directory");
  }
}

async function removeDeprecatedCodexHomeSkills(codexHome: string): Promise<void> {
  // Skills are discovered from ~/.agents/skills. Remove old per-session copies
  // so stale CODEX_HOME/skills content cannot act like an active skill root.
  await rm(join(codexHome, deprecatedCodexSkillsDirName), { recursive: true, force: true });
}

async function prepareCodexHome(
  codexHome: string,
  resumeCliSessionId?: string,
  seedSourceHome?: string,
  options?: {
    filterImagegenSkill?: boolean;
    allowLegacyAuthFallback?: boolean;
    legacyCodexHome?: string;
    agentsSkillsHome?: string;
    resumeRolloutSourceHomes?: string[];
    timing?: CooperativeTiming;
  },
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await options?.timing?.yieldIfDue("prepare Codex home directory");

  const legacyCodexHome = resolve(options?.legacyCodexHome || getLegacyCodexHome());
  const sourceHome = resolve(seedSourceHome || legacyCodexHome);
  const canSeedSourceHome = sourceHome !== resolve(codexHome) && (await fileExists(sourceHome));

  await syncCodexGlobalInstructionFiles(codexHome, sourceHome);
  await options?.timing?.yieldIfDue("snapshot Codex global instructions");

  const fileSeeds = ["auth.json", "config.toml", "models_cache.json", "version.json"];
  if (canSeedSourceHome) {
    for (const name of fileSeeds) {
      try {
        const candidateSources = [join(sourceHome, name)];
        const mayFallbackToLegacyAuth = name !== "auth.json" || options?.allowLegacyAuthFallback !== false;
        if (
          (name === "auth.json" || name === "models_cache.json") &&
          legacyCodexHome !== sourceHome &&
          mayFallbackToLegacyAuth
        ) {
          candidateSources.push(join(legacyCodexHome, name));
        }

        let src: string | null = null;
        for (const candidate of candidateSources) {
          if (await fileExists(candidate)) {
            src = candidate;
            break;
          }
        }

        const dest = join(codexHome, name);
        if (!src) {
          if (name === "auth.json" && options?.allowLegacyAuthFallback === false) {
            await unlink(dest).catch(() => {});
          }
          continue;
        }
        if (name === "auth.json") {
          await linkCodexAuthFile(src, dest);
          continue;
        }
        if (!(await fileExists(dest))) {
          if (name === "config.toml") {
            const seededConfig = await readFile(src, "utf-8");
            await writeFile(dest, scrubSessionScopedCodexConfig(seededConfig), "utf-8");
          } else {
            await copyFile(src, dest);
          }
        }
        await options?.timing?.yieldIfDue(`seed Codex ${name}`);
      } catch (error) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, error);
      }
    }
  }

  if (canSeedSourceHome) {
    const dirSeeds = ["vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(sourceHome, name);
        const dest = join(codexHome, name);
        await syncSeededDirectory(src, dest, options?.timing);
        await options?.timing?.yieldIfDue(`seed Codex ${name}/`);
      } catch (error) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, error);
      }
    }
  }

  try {
    await removeDeprecatedCodexHomeSkills(codexHome);
    await options?.timing?.yieldIfDue("remove deprecated Codex home skills");
    await migrateLegacyCodexSkillsToAgentsHome(sourceHome, {
      destSkillsHome: options?.agentsSkillsHome,
      filterImagegenSkill: options?.filterImagegenSkill,
      legacyCodexHome,
      timing: options?.timing,
    });
  } catch (error) {
    console.warn(`[cli-launcher] Failed to migrate legacy Codex skills into ~/.agents/skills:`, error);
  }

  try {
    await seedCodexResumeRollout(
      codexHome,
      resumeCliSessionId,
      [...(options?.resumeRolloutSourceHomes ?? []), sourceHome],
      options?.timing,
    );
  } catch (error) {
    console.warn(`[cli-launcher] Failed to seed resume rollout for ${resumeCliSessionId}:`, error);
  }
}

async function linkCodexAuthFile(src: string, dest: string): Promise<void> {
  await unlink(dest).catch(() => {});
  try {
    await symlink(src, dest);
  } catch (error) {
    // Prefer a live link so Codex's rotating refresh token stays shared across
    // session homes. Copying is only a fallback for filesystems that disallow
    // symlinks.
    await copyFile(src, dest);
    console.warn(`[cli-launcher] Failed to symlink Codex auth.json into session home; copied instead:`, error);
  }
}

async function ensureCodexSessionConfig(
  codexHome: string,
  envVars: string[],
  options?: {
    leaderLaunch?: boolean;
    /** Legacy test/compatibility fields are ignored; leader thresholds are metadata-derived. */
    leaderRecycleThresholdTokens?: number;
    /** Deprecated compatibility setting; ignored so non-leader compaction follows Codex defaults. */
    nonLeaderAutoCompactThresholdPercent?: number;
    codexContextCapacityTokens?: number;
    existingLeaderRecycleThresholdTokens?: number;
    model?: string;
    codexBinary?: string;
    multiAgentVersion?: CodexMultiAgentVersion;
    loadInstalledModelCatalog?: () => Promise<import("./codex-model-catalog.js").CodexCatalogResult | null>;
    modelCatalogConfigPath?: string;
    takodeDelegateMcp?: {
      enabled: boolean;
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    timing?: CooperativeTiming;
  },
) {
  const configPath = join(codexHome, "config.toml");
  let current = "";
  try {
    current = await readFile(configPath, "utf-8");
  } catch {
    current = "";
  }
  await options?.timing?.yieldIfDue("read Codex session config");

  let next = scrubSessionScopedCodexConfig(current);
  next = upsertBooleanSettingInSection(next, codexFeaturesHeader, codexMultiAgentFeature, true);
  if (options?.multiAgentVersion) {
    next = upsertBooleanSettingInSection(
      next,
      codexFeaturesHeader,
      codexMultiAgentV2Feature,
      options.multiAgentVersion === "v2",
    );
  }
  if (usesMaiLitellmProvider(next)) {
    next = upsertBooleanSettingInSection(next, codexFeaturesHeader, codexImageGenerationFeature, false);
  }
  const providerEnvKeys = getSelectedProviderEnvKeys(next);
  next = upsertShellEnvironmentIncludeOnly(next, [
    "HOME",
    "PATH",
    ...NON_INTERACTIVE_GIT_EDITOR_ENV_KEYS,
    ...providerEnvKeys,
    ...envVars,
  ]);
  const modelId = options?.model || readTopLevelStringSetting(next, "model");
  const leaderLaunch = options?.leaderLaunch ?? !options?.nonLeaderAutoCompactThresholdPercent;
  const desiredContextCapacity = coercePositiveNumber(options?.codexContextCapacityTokens);
  const existingLeaderRecycleThresholdTokens = coercePositiveNumber(options?.existingLeaderRecycleThresholdTokens);
  const leaderRecycleThreshold =
    leaderLaunch && desiredContextCapacity
      ? leaderRecycleThresholdForUsableCapacity(desiredContextCapacity)
      : leaderLaunch && existingLeaderRecycleThresholdTokens
        ? {
            recycleThresholdTokens: existingLeaderRecycleThresholdTokens,
            source: "existing leader recycle budget",
            usedFallback: false,
          }
        : leaderLaunch
          ? await resolveCodexLeaderRecycleThresholdForConfig(codexHome, next, modelId)
          : undefined;
  const leaderRecycleThresholdTokens = leaderRecycleThreshold?.recycleThresholdTokens;
  let modelCatalogJson: string | undefined;
  let leaderLaunchConfig: CodexLeaderLaunchConfig | undefined;
  let contextLaunchConfig: CodexContextLaunchConfig | undefined;
  if (leaderLaunch && leaderRecycleThresholdTokens && leaderRecycleThresholdTokens > 0) {
    const override = await ensureCodexLeaderModelCatalogOverride(codexHome, next, leaderRecycleThresholdTokens, {
      model: modelId,
      modelCatalogConfigPath: options?.modelCatalogConfigPath,
      multiAgentVersion: options?.multiAgentVersion,
    });
    next = override.configToml;
    modelCatalogJson = override.catalogJson;
    next = upsertTopLevelNumberSetting(next, "model_context_window", override.launchGuard.providerRawContextWindow);
    next = upsertTopLevelNumberSetting(
      next,
      "model_auto_compact_token_limit",
      override.launchGuard.providerAutoCompactTokenLimit,
    );
    const modelCatalogConfigPath = readTopLevelStringSetting(next, "model_catalog_json");
    const sourceEffectiveContextWindowTokens = leaderRecycleThreshold?.sourceEffectiveContextWindowTokens;
    leaderLaunchConfig = {
      recycleThresholdTokens: leaderRecycleThresholdTokens,
      modelContextWindow: override.launchGuard.providerRawContextWindow,
      modelAutoCompactTokenLimit: override.launchGuard.providerAutoCompactTokenLimit,
      catalogEffectiveContextWindowPercent: override.launchGuard.catalogEffectiveContextWindowPercent,
      ...(sourceEffectiveContextWindowTokens ? { sourceEffectiveContextWindowTokens } : {}),
      ...(leaderRecycleThreshold?.source ? { source: leaderRecycleThreshold.source } : {}),
      ...(modelCatalogConfigPath ? { modelCatalogConfigPath } : {}),
    };
    await options?.timing?.yieldIfDue("prepare Codex leader derived context guard");
  } else if (desiredContextCapacity) {
    const override = await ensureCodexNonLeaderContextCapacityOverride(codexHome, next, desiredContextCapacity, {
      model: modelId,
      modelCatalogConfigPath: options?.modelCatalogConfigPath,
      multiAgentVersion: options?.multiAgentVersion,
    });
    next = override.configToml;
    modelCatalogJson = override.modelCatalogJson;
    contextLaunchConfig = override.launchConfig;
    await options?.timing?.yieldIfDue("prepare Codex usable context override");
  } else if (usesMaiLitellmProvider(next)) {
    const configuredCatalogPath = readTopLevelStringSetting(next, "model_catalog_json");
    const rebuildTakodeCatalog =
      !!configuredCatalogPath && isTakodeNonLeaderModelCatalogConfigPath(codexHome, configuredCatalogPath);
    next = await scrubTakodeNonLeaderContextOverride(codexHome, next, {
      model: modelId,
      preserveModelCatalog: true,
    });
    const override = await ensureCodexMaiLitellmCatalogCompatibilityOverride(codexHome, next, {
      model: modelId,
      modelCatalogConfigPath: options?.modelCatalogConfigPath,
      multiAgentVersion: options?.multiAgentVersion,
      skipConfiguredCatalogSource: rebuildTakodeCatalog,
    });
    next = override.configToml;
    modelCatalogJson = override.modelCatalogJson;
    await options?.timing?.yieldIfDue("prepare Codex MAI LiteLLM catalog compatibility override");
  } else {
    const configuredCatalogPath = readTopLevelStringSetting(next, "model_catalog_json");
    const rebuildTakodeCatalog =
      !!configuredCatalogPath && isTakodeNonLeaderModelCatalogConfigPath(codexHome, configuredCatalogPath);
    next = await scrubTakodeNonLeaderContextOverride(codexHome, next, {
      model: modelId,
      preserveModelCatalog: options?.multiAgentVersion !== undefined,
    });
    if (options?.multiAgentVersion) {
      const override = await ensureCodexMultiAgentModelCatalogOverride(codexHome, next, options.multiAgentVersion, {
        model: modelId,
        modelCatalogConfigPath: options.modelCatalogConfigPath,
        skipConfiguredCatalogSource: rebuildTakodeCatalog,
      });
      next = override.configToml;
      modelCatalogJson = override.modelCatalogJson;
      await options.timing?.yieldIfDue("prepare Codex multi-agent model catalog override");
    }
  }
  if (options?.takodeDelegateMcp) {
    next = upsertTakodeDelegateMcpServer(next, options.takodeDelegateMcp);
  }
  const reasoningSummaryLaunchMode = await resolveCodexReasoningSummaryLaunchMode({
    codexHome,
    configToml: next,
    modelId,
    generatedCatalogJson: modelCatalogJson,
    legacyCodexHome: getLegacyCodexHome(),
    loadInstalledModelCatalog:
      options?.loadInstalledModelCatalog ?? createCodexInstalledModelCatalogLoader(options?.codexBinary),
  });
  if (next !== current) {
    await writeFile(configPath, next, "utf-8");
    await options?.timing?.yieldIfDue("write Codex session config");
  }
  return {
    configToml: next,
    modelCatalogJson,
    leaderRecycleThresholdTokens,
    leaderLaunchConfig,
    contextLaunchConfig,
    reasoningSummaryLaunchMode,
  };
}

export function renderContainerCodexFileWrite(path: string, contents: string, heredocMarker: string): string {
  const normalizedContents = contents.replace(/\r\n/g, "\n");
  const fileBody = normalizedContents.endsWith("\n") ? normalizedContents.slice(0, -1) : normalizedContents;
  const contentLines = new Set(normalizedContents.split("\n"));
  let resolvedMarker = heredocMarker;
  for (let suffix = 1; contentLines.has(resolvedMarker); suffix += 1) {
    resolvedMarker = `${heredocMarker}_${suffix}`;
  }
  return [
    `mkdir -p ${JSON.stringify(dirname(path))}`,
    `cat > ${JSON.stringify(path)} <<'${resolvedMarker}'`,
    fileBody,
    resolvedMarker,
  ].join("\n");
}

function renderContainerCodexConfigWrite(configToml: string): string {
  return renderContainerCodexFileWrite("/root/.codex/config.toml", configToml, "__COMPANION_CODEX_CONFIG__");
}

function renderContainerCodexAuthRefresh(): string {
  return [
    "if [ -f /companion-host-codex/auth.json ]; then",
    "mkdir -p /root/.codex",
    "rm -f /root/.codex/auth.json",
    "cp /companion-host-codex/auth.json /root/.codex/auth.json 2>/dev/null || true",
    "fi",
  ].join("\n");
}

async function resolveHostCodexLaunchBinary(
  sessionId: string,
  binary: string,
  codexHomeRoot: string,
  timing?: CooperativeTiming,
): Promise<{ binary: string; dotslashCache?: string }> {
  const binaryFingerprint = await pathFingerprint(binary);
  const legacyCacheRoots = getLegacyDotslashCacheDirs().map((root) => resolve(root));
  const cacheKey = JSON.stringify({
    binary: resolve(binary),
    binaryFingerprint,
    codexHomeRoot: resolve(codexHomeRoot),
    legacyCacheRoots,
  });
  const cached = getFreshCachedPromise(hostLaunchBinaryCache, cacheKey);
  if (cached) {
    const result = await cached;
    if (await fileExists(result.binary)) {
      spawnPrepCacheStats.hostLaunchBinaryCacheHits++;
      return result;
    }
    hostLaunchBinaryCache.delete(cacheKey);
  }

  spawnPrepCacheStats.hostLaunchBinaryCacheMisses++;
  return setTimedPromiseCacheEntry(hostLaunchBinaryCache, cacheKey, () =>
    resolveHostCodexLaunchBinaryUncached(sessionId, binary, codexHomeRoot, timing),
  );
}

async function resolveHostCodexLaunchBinaryUncached(
  sessionId: string,
  binary: string,
  codexHomeRoot: string,
  timing?: CooperativeTiming,
): Promise<{ binary: string; dotslashCache?: string }> {
  const kind = await detectHostCodexBinaryKind(binary);
  if (kind === "native") return { binary };

  const cachedArtifact = await findLatestCachedCodexArtifact();
  if (cachedArtifact) {
    console.log(`[cli-launcher] Using cached Codex artifact for session ${sessionTag(sessionId)}: ${cachedArtifact}`);
    return { binary: cachedArtifact };
  }

  let selectedBinary = binary;
  if (kind === "bootstrap") {
    const cachedDotslashFile = join(homedir(), ".cache", "codex", "codex");
    if (await fileExists(cachedDotslashFile)) {
      selectedBinary = cachedDotslashFile;
    }
  }

  const selectedKind = selectedBinary === binary ? kind : await detectHostCodexBinaryKind(selectedBinary);
  if (selectedKind !== "dotslash") {
    return { binary: selectedBinary };
  }

  const dotslashCache = join(codexHomeRoot, "dotslash-cache");
  await prepareDotslashCache(dotslashCache, timing);
  return { binary: selectedBinary, dotslashCache };
}

export async function prepareCodexSpawn(
  sessionId: string,
  info: CodexLaunchInfo,
  options: CodexLaunchOptions,
): Promise<CodexSpawnSpec> {
  const serverId = options.env?.COMPANION_SERVER_ID;
  const isContainerized = !!options.containerId;
  const codexHomeRoot = resolveCompanionCodexHome(options.codexHome);
  const codexLeaderLaunch = isCodexLeaderLaunch(info, options);
  const leaderRecycleLaunch = isCodexLeaderRecycleLaunch(info, options);
  const timing = new CooperativeTiming({
    label: `Codex spawn prep ${sessionTag(sessionId)}`,
    ...(options.codexSpawnPrepYieldEveryMs ? { yieldEveryMs: options.codexSpawnPrepYieldEveryMs } : {}),
  });

  try {
    let binary = options.codexBinary || "codex";
    if (!isContainerized) {
      const resolved = timing.stepSync("resolve Codex binary", () => resolveBinary(binary));
      if (!resolved) {
        throw new MissingCodexBinaryError(`Binary "${binary}" not found in PATH`);
      }
      binary = resolved;
    }

    let dotslashCache: string | undefined;
    if (!isContainerized) {
      const hostLaunchBinary = await timing.step("resolve Codex host launch binary", () =>
        resolveHostCodexLaunchBinary(sessionId, binary, codexHomeRoot, timing),
      );
      binary = hostLaunchBinary.binary;
      dotslashCache = hostLaunchBinary.dotslashCache;
    }

    const approvalPolicy = mapCodexApprovalPolicy(options.permissionMode, options.askPermission);
    const sandboxMode = resolveCodexSandbox(options.permissionMode, options.codexSandbox);

    const codexHome = resolveCompanionCodexSessionHome(sessionId, codexHomeRoot);
    const resumeRolloutSourceHomes = options.codexResumeSourceSessionId
      ? [resolveCompanionCodexSessionHome(options.codexResumeSourceSessionId, codexHomeRoot)]
      : [];
    const maiWrapperHostSpec = !isContainerized
      ? await timing.step("resolve MAI wrapper host", () => resolveMaiWrapperHostSpec(binary))
      : null;
    const runtimeCodexHome = isContainerized ? "/root/.codex" : codexHome;
    const globalInstructionSourceHome = resolve(
      maiWrapperHostSpec?.hostCodexHome || options.codexLegacyHome || getLegacyCodexHome(),
    );
    const instructionContext: CodexInstructionContext = {
      globalSources: codexGlobalInstructionFilenamesForContext(runtimeCodexHome, globalInstructionSourceHome),
      configLayers: [
        { kind: "user", path: join(runtimeCodexHome, "config.toml") },
        { kind: "session_flags", label: "Takode launch overrides" },
      ],
    };
    const shellEnvVars = Object.keys(options.env || {}).filter(
      (name) => name.startsWith("COMPANION_") || name.startsWith("TAKODE_"),
    );
    let resolvedLeaderRecycleThresholdTokens: number | undefined;
    let leaderLaunchConfig: CodexLeaderLaunchConfig | undefined;
    let contextLaunchConfig: CodexContextLaunchConfig | undefined;
    let reasoningSummaryLaunchMode: CodexReasoningSummaryLaunchMode | undefined;
    let resolvedConfigToml = "";
    let resolvedModelCatalogJson: string | undefined;
    let containerLeaderConfigToml: string | undefined;
    let containerModelCatalogJson: string | undefined;
    let containerGlobalInstructions: CodexGlobalInstructionSnapshot | null = null;
    const containerModelCatalogPath = leaderRecycleLaunch
      ? containerTakodeLeaderModelCatalogPath
      : options.codexMaxContextLength || options.codexMultiAgentVersion
        ? containerTakodeNonLeaderModelCatalogPath
        : undefined;

    if (!isContainerized) {
      if (!options.codexHomePrepared) {
        await timing.step("prepare Codex home", () =>
          prepareCodexHome(
            codexHome,
            options.resumeCliSessionId || info.cliSessionId,
            maiWrapperHostSpec?.hostCodexHome,
            {
              allowLegacyAuthFallback: !maiWrapperHostSpec,
              agentsSkillsHome: options.codexAgentsSkillsHome,
              filterImagegenSkill: !!maiWrapperHostSpec,
              legacyCodexHome: options.codexLegacyHome,
              resumeRolloutSourceHomes,
              timing,
            },
          ),
        );
      }
      const sessionConfig = await timing.step("ensure Codex session config", () =>
        ensureCodexSessionConfig(codexHome, shellEnvVars, {
          leaderLaunch: leaderRecycleLaunch,
          codexContextCapacityTokens: options.codexMaxContextLength,
          existingLeaderRecycleThresholdTokens: existingLeaderRecycleBudget(info),
          model: options.model,
          codexBinary: binary,
          multiAgentVersion: options.codexMultiAgentVersion,
          takodeDelegateMcp: buildTakodeDelegateMcpConfig(
            codexLeaderLaunch || options.env?.TAKODE_DELEGATE_ROLE === "child",
            options.env,
          ),
          timing,
        }),
      );
      resolvedConfigToml = sessionConfig.configToml;
      resolvedModelCatalogJson = sessionConfig.modelCatalogJson;
      resolvedLeaderRecycleThresholdTokens = sessionConfig.leaderRecycleThresholdTokens;
      leaderLaunchConfig = sessionConfig.leaderLaunchConfig;
      contextLaunchConfig = sessionConfig.contextLaunchConfig;
      reasoningSummaryLaunchMode = sessionConfig.reasoningSummaryLaunchMode;
    } else {
      if (!options.codexHomePrepared) {
        await timing.step("prepare container Codex home", () =>
          prepareCodexHome(codexHome, options.resumeCliSessionId || info.cliSessionId, undefined, {
            agentsSkillsHome: options.codexAgentsSkillsHome,
            legacyCodexHome: options.codexLegacyHome,
            resumeRolloutSourceHomes,
            timing,
          }),
        );
      }
      containerGlobalInstructions = await timing.step("read container Codex global instructions", () =>
        readEffectiveCodexGlobalInstructions(codexHome),
      );
      const containerConfig = await timing.step("ensure container Codex session config", () =>
        ensureCodexSessionConfig(codexHome, shellEnvVars, {
          leaderLaunch: leaderRecycleLaunch,
          codexContextCapacityTokens: options.codexMaxContextLength,
          existingLeaderRecycleThresholdTokens: existingLeaderRecycleBudget(info),
          model: options.model,
          codexBinary: binary,
          multiAgentVersion: options.codexMultiAgentVersion,
          modelCatalogConfigPath: containerModelCatalogPath,
          takodeDelegateMcp: buildTakodeDelegateMcpConfig(
            codexLeaderLaunch || options.env?.TAKODE_DELEGATE_ROLE === "child",
            options.env,
          ),
          timing,
        }),
      );
      containerLeaderConfigToml = containerConfig.configToml;
      containerModelCatalogJson = containerConfig.modelCatalogJson;
      resolvedConfigToml = containerConfig.configToml;
      resolvedModelCatalogJson = containerConfig.modelCatalogJson;
      resolvedLeaderRecycleThresholdTokens = containerConfig.leaderRecycleThresholdTokens;
      leaderLaunchConfig = containerConfig.leaderLaunchConfig;
      contextLaunchConfig = containerConfig.contextLaunchConfig;
      reasoningSummaryLaunchMode = containerConfig.reasoningSummaryLaunchMode;
    }

    const selectedContextLaunchConfig = leaderLaunchConfig ?? contextLaunchConfig;
    const contextWindowDiagnostics = await resolveCodexContextWindowDiagnostics({
      codexHome,
      configToml: resolvedConfigToml,
      generatedCatalogJson: resolvedModelCatalogJson,
      model: options.model,
      role: codexLeaderLaunch ? "leader" : "non_leader",
      ...(codexLeaderLaunch ? { leaderMode: leaderRecycleLaunch ? "recycle" : "compact" } : {}),
      ...(options.codexMaxContextLength ? { configuredUsableContextWindow: options.codexMaxContextLength } : {}),
      ...(selectedContextLaunchConfig
        ? {
            displayContextWindow: leaderLaunchConfig?.recycleThresholdTokens ?? options.codexMaxContextLength,
            launchConfig: selectedContextLaunchConfig,
          }
        : {}),
      leaderRecycleGuard: !!leaderLaunchConfig,
    });
    logCodexContextWindowDiagnostics(
      sessionId,
      options.model,
      contextWindowDiagnostics,
      selectedContextLaunchConfig?.modelCatalogConfigPath ??
        readTopLevelStringSetting(resolvedConfigToml, "model_catalog_json"),
    );

    const maiWrapperLaunchSpec =
      !isContainerized && maiWrapperHostSpec
        ? await timing.step("resolve MAI wrapper launch", () =>
            resolveMaiWrapperSessionLaunchSpec(maiWrapperHostSpec, sessionId, codexHome, options),
          )
        : null;
    const args: string[] = [];
    if (options.codexMultiAgentVersion) {
      args.push(options.codexMultiAgentVersion === "v2" ? "--enable" : "--disable", codexMultiAgentV2Feature);
    }
    args.push("-c", `tools.webSearch=${options.codexInternetAccess === true ? "true" : "false"}`);
    if (options.model) {
      args.push("-c", `model=${options.model}`);
    }
    if (options.codexReasoningEffort) {
      args.push("-c", `model_reasoning_effort=${options.codexReasoningEffort}`);
    }
    appendCodexContextLaunchArgs(args, contextLaunchConfig);
    if (options.permissionMode === "codex-auto-review") {
      args.push("-c", "approvals_reviewer=auto_review");
    }
    if (approvalPolicy) {
      args.push("-a", approvalPolicy);
    }
    if (sandboxMode) {
      args.push("-s", sandboxMode);
    }
    if (reasoningSummaryLaunchMode) {
      args.push("-c", `model_reasoning_summary=${reasoningSummaryLaunchMode}`);
    }
    appendCodexContextLaunchArgs(args, leaderLaunchConfig);
    args.push("app-server");
    if (leaderLaunchConfig) {
      console.info(
        `[cli-launcher] Codex leader launch guard for session ${sessionTag(sessionId)}: ` +
          `sourceEffectiveContext=${leaderLaunchConfig.sourceEffectiveContextWindowTokens ?? "unknown"} ` +
          `source=${leaderLaunchConfig.source ?? "unknown"} ` +
          `recycleThreshold=${leaderLaunchConfig.recycleThresholdTokens} ` +
          `providerContextWindow=${leaderLaunchConfig.modelContextWindow} ` +
          `providerAutoCompactLimit=${leaderLaunchConfig.modelAutoCompactTokenLimit} ` +
          `catalog=${leaderLaunchConfig.modelCatalogConfigPath ?? "none"}`,
      );
    }

    if (isContainerized) {
      const dockerArgs = ["docker", "exec", "-i"];
      const containerEnv = withNonInteractiveGitEditorEnv(options.env ?? {});
      for (const [key, value] of Object.entries(containerEnv)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }
      dockerArgs.push("-e", "CLAUDECODE=");
      dockerArgs.push("-e", "CODEX_HOME=/root/.codex");
      dockerArgs.push(options.containerId!);
      const innerCmd = [binary, ...args].map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
      const shellCommands: string[] = [
        renderContainerCodexAuthRefresh(),
        renderContainerCodexGlobalInstructionWrite(containerGlobalInstructions, renderContainerCodexFileWrite),
      ];
      if (containerModelCatalogJson && containerModelCatalogPath) {
        shellCommands.push(
          renderContainerCodexFileWrite(
            containerModelCatalogPath,
            containerModelCatalogJson,
            "__COMPANION_CODEX_MODEL_CATALOG__",
          ),
        );
      }
      if (containerLeaderConfigToml) {
        shellCommands.push(renderContainerCodexConfigWrite(containerLeaderConfigToml));
      }
      shellCommands.push(`exec ${innerCmd}`);
      dockerArgs.push("bash", "-lc", shellCommands.join("\n"));
      const containerSpawnPath = timing.stepSync("build container Codex spawn PATH", () =>
        getEnrichedPath({ serverId }),
      );

      return {
        spawnCmd: dockerArgs,
        spawnEnv: { ...process.env, PATH: containerSpawnPath },
        spawnCwd: undefined,
        sandboxMode,
        reasoningSummary: reasoningSummaryLaunchMode,
        codexLeaderRecycleThresholdTokens: resolvedLeaderRecycleThresholdTokens,
        contextWindowDiagnostics,
        instructionContext,
      };
    }

    const binaryDir = resolve(binary, "..");
    const siblingNode = join(binaryDir, "node");
    const companionBinDir = join(homedir(), ".companion", "bin");
    const localBinDir = join(homedir(), ".local", "bin");
    const bunBinDir = join(homedir(), ".bun", "bin");
    const enrichedPath = timing.stepSync("build Codex spawn PATH", () => getEnrichedPath({ serverId }));
    const spawnPath = mergePathStrings([
      maiWrapperLaunchSpec?.hostnameShimDir,
      binaryDir,
      companionBinDir,
      localBinDir,
      bunBinDir,
      enrichedPath,
    ]);

    const spawnCmd = await timing.step("select Codex invocation", async () => {
      if ((await fileExists(siblingNode)) && (await shouldInvokeCodexWithSiblingNode(binary))) {
        let codexScript: string;
        try {
          codexScript = await realpath(binary);
        } catch {
          codexScript = binary;
        }
        return [siblingNode, codexScript, ...args];
      }
      return [binary, ...args];
    });

    const shellEnv = timing.stepSync("load warmed Codex shell env", () =>
      captureUserShellEnv([...hostCodexShellEnvVars], { allowShellSpawn: false }),
    );

    return {
      spawnCmd,
      spawnEnv: withNonInteractiveGitEditorEnv({
        ...stripInheritedTelemetryEnv(process.env),
        ...shellEnv,
        CLAUDECODE: undefined,
        MAI_CODEX_DEBUG_WRAPPER: "1",
        ...options.env,
        CODEX_HOME: codexHome,
        ...(dotslashCache ? { DOTSLASH_CACHE: dotslashCache } : {}),
        PATH: spawnPath,
      }),
      spawnCwd: info.cwd,
      sandboxMode,
      reasoningSummary: reasoningSummaryLaunchMode,
      codexLeaderRecycleThresholdTokens: resolvedLeaderRecycleThresholdTokens,
      contextWindowDiagnostics,
      instructionContext,
    };
  } finally {
    timing.finish({
      backend: "codex",
      container: isContainerized,
      leader: codexLeaderLaunch,
    });
  }
}

export function _resetCodexSpawnPrepCachesForTest(): void {
  hostLaunchBinaryCache.clear();
  legacySkillMigrationCache.clear();
  spawnPrepCacheStats = {
    hostLaunchBinaryCacheHits: 0,
    hostLaunchBinaryCacheMisses: 0,
    latestCachedCodexArtifactScans: 0,
    legacySkillMigrationCacheHits: 0,
    legacySkillMigrationCacheMisses: 0,
  };
}

export function _getCodexSpawnPrepCacheStatsForTest(): CodexSpawnPrepCacheStats {
  return { ...spawnPrepCacheStats };
}

export function _resolveHostCodexLaunchBinaryForTest(
  sessionId: string,
  binary: string,
  codexHomeRoot: string,
  timing?: CooperativeTiming,
): Promise<{ binary: string; dotslashCache?: string }> {
  return resolveHostCodexLaunchBinary(sessionId, binary, codexHomeRoot, timing);
}

export function _migrateLegacyCodexSkillsToAgentsHomeForTest(
  sourceHome: string,
  options?: {
    filterImagegenSkill?: boolean;
    timing?: CooperativeTiming;
    destSkillsHome?: string;
    legacyCodexHome?: string;
  },
): Promise<void> {
  return migrateLegacyCodexSkillsToAgentsHome(sourceHome, options);
}

export function _ensureCodexSessionConfigForTest(
  codexHome: string,
  envVars: string[],
  options?: {
    leaderRecycleThresholdTokens?: number;
    leaderLaunch?: boolean;
    /** Deprecated compatibility setting; ignored so non-leader compaction follows Codex defaults. */
    nonLeaderAutoCompactThresholdPercent?: number;
    codexContextCapacityTokens?: number;
    existingLeaderRecycleThresholdTokens?: number;
    model?: string;
    codexBinary?: string;
    multiAgentVersion?: CodexMultiAgentVersion;
    loadInstalledModelCatalog?: () => Promise<import("./codex-model-catalog.js").CodexCatalogResult | null>;
    modelCatalogConfigPath?: string;
    takodeDelegateMcp?: {
      enabled: boolean;
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    timing?: CooperativeTiming;
  },
) {
  return ensureCodexSessionConfig(codexHome, envVars, options);
}
