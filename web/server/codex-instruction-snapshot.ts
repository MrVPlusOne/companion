import type {
  CodexConfigLayerSourceSnapshot,
  CodexInstructionSnapshot,
  CodexInstructionSourceSnapshot,
} from "./codex-adapter-types.js";

export interface CodexInstructionContext {
  globalSources: Array<{
    loadedPath: string;
    sourcePath: string;
    delivery: "copied_snapshot";
  }>;
  configLayers: CodexConfigLayerSourceSnapshot[];
}

export function normalizeCodexInstructionPath(path: string, platform = process.platform): string {
  let normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (platform === "darwin") {
    if (normalized === "/private/tmp" || normalized.startsWith("/private/tmp/")) {
      normalized = normalized.slice("/private".length);
    } else if (normalized === "/private/var" || normalized.startsWith("/private/var/")) {
      normalized = normalized.slice("/private".length);
    }
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function buildCodexInstructionSnapshot(options: {
  threadId: string;
  capturedAt: number;
  lifecycle: CodexInstructionSnapshot["lifecycle"];
  instructionSources: unknown;
  instructionContext?: CodexInstructionContext;
  developerInstructionsConfigured: boolean;
}): CodexInstructionSnapshot {
  const rawSources = Array.isArray(options.instructionSources) ? options.instructionSources : null;
  const reported = rawSources !== null;
  const globalSources = new Map(
    (options.instructionContext?.globalSources ?? []).map((source) => [
      normalizeCodexInstructionPath(source.loadedPath),
      source,
    ]),
  );
  const instructionSources = rawSources
    ? rawSources.flatMap((entry: unknown): CodexInstructionSourceSnapshot[] => {
        const path = optionalString(entry);
        if (!path) return [];
        const normalized = normalizeCodexInstructionPath(path);
        const globalSource = globalSources.get(normalized);
        return [
          {
            path,
            kind: globalSource ? "global" : "project",
            ...(globalSource
              ? { sourcePath: globalSource.sourcePath, delivery: globalSource.delivery }
              : { delivery: "direct" as const }),
          },
        ];
      })
    : [];

  return {
    threadId: options.threadId,
    capturedAt: options.capturedAt,
    lifecycle: options.lifecycle,
    instructionSourcesReported: reported,
    instructionSources,
    configLayers: options.instructionContext?.configLayers ?? [],
    developerInstructionsConfigured: options.developerInstructionsConfigured,
  };
}
