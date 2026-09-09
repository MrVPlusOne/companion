import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type BackendModelInfo, type SessionConfigPatch } from "../api.js";
import { useStore } from "../store.js";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  getCodexReasoningEffortOptions,
  getModelsForBackend,
  toModelOptions,
  type CodexPermissionMode,
  type ModelOption,
} from "../utils/backends.js";
import {
  CLAUDE_1M_CONTEXT_TOKENS,
  CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  CLAUDE_REASONING_EFFORTS,
  type ClaudeReasoningEffort,
} from "../../shared/session-defaults.js";
import {
  contextWindowLimitWarning,
  contextWindowPreview,
  effectiveContextPercentForModel,
} from "../utils/context-window.js";
import {
  deriveAskPermissionForMode,
  deriveUiModeForMode,
  normalizeClaudePermissionMode,
  normalizeCodexPermissionProfile,
  resolveCodexPermissionProfile,
} from "../../shared/permission-modes.js";
import {
  normalizeCodexLeaderCompactionMode,
  type CodexLeaderCompactionMode,
} from "../../shared/codex-leader-compaction-mode.js";

const inputClass =
  "w-full rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2 text-sm text-cc-fg focus:border-cc-primary/60 focus:outline-none";

type Backend = "claude" | "claude-sdk" | "codex";

interface SessionConfigForm {
  model: string;
  permissionMode: string;
  codexInternetAccess: boolean;
  codexReasoningEffort: string;
  codexServiceTier: string | null;
  codexMaxContextLength: string;
  codexLeaderCompactionMode: CodexLeaderCompactionMode;
  claudeReasoningEffort: string;
  claudeMaxContextLength: string;
}

interface ConfigureSessionModalProps {
  sessionId: string;
  onClose: () => void;
}

function numberInputValue(value: number | null | undefined): string {
  return value ? String(value) : "";
}

function parseOptionalPositiveInteger(
  value: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  const numeric = Number(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return { ok: false, error: "Use a positive integer." };
  return { ok: true, value: numeric };
}

function normalizeContextInput(value: string): string {
  const parsed = parseOptionalPositiveInteger(value);
  return parsed.ok && parsed.value ? String(parsed.value) : "";
}

function modelsForBackend(backend: "claude" | "codex", dynamicModels: BackendModelInfo[], currentModel: string) {
  const dynamic = dynamicModels.length ? toModelOptions(dynamicModels) : [];
  const fallback = getModelsForBackend(backend);
  const merged = [...dynamic, ...fallback].filter((option) => option.value);
  if (currentModel && !merged.some((option) => option.value === currentModel)) {
    merged.unshift({ value: currentModel, label: currentModel, icon: "" });
  }
  const seen = new Set<string>();
  return merged.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
}

function selectedCodexTierOptions(model: string, options: ModelOption[]) {
  return options.find((option) => option.value === model)?.serviceTiers ?? [];
}

function liveValue<T>(
  source: Record<string, unknown> | undefined,
  key: string,
): { present: boolean; value: T | undefined } {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) return { present: false, value: undefined };
  return { present: true, value: source[key] as T | undefined };
}

function formsEqual(left: SessionConfigForm | null, right: SessionConfigForm | null): boolean {
  if (!left || !right) return left === right;
  return (Object.keys(left) as Array<keyof SessionConfigForm>).every(
    (key) => (left[key] ?? null) === (right[key] ?? null),
  );
}

function effectCopy(effect: "now" | "next-turn" | "restart" | "resume"): string {
  switch (effect) {
    case "now":
      return "Applies now";
    case "next-turn":
      return "Applies next turn";
    case "restart":
      return "Requires restart";
    case "resume":
      return "Applies on resume";
  }
}

function Effect({ effect }: { effect: "now" | "next-turn" | "restart" | "resume" }) {
  return <span className="text-[11px] text-cc-muted">{effectCopy(effect)}</span>;
}

function FieldLabel({ label, effect }: { label: string; effect: "now" | "next-turn" | "restart" | "resume" }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3">
      <label className="text-xs font-medium text-cc-fg">{label}</label>
      <Effect effect={effect} />
    </div>
  );
}

function codexPermissionOptions() {
  return CODEX_PERMISSION_MODES.map((option) => ({
    ...option,
    profile: resolveCodexPermissionProfile(option.value as CodexPermissionMode),
  }));
}

export function ConfigureSessionModal({ sessionId, onClose }: ConfigureSessionModalProps) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((item) => item.sessionId === sessionId));
  const updateSession = useStore((s) => s.updateSession);
  const updateSdkSession = useStore((s) => s.updateSdkSession);
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const backend = (session?.backend_type ?? sdkSession?.backendType ?? "claude") as Backend;
  const isCodex = backend === "codex";
  const backendLabel = isCodex ? "Codex" : "Claude";
  const [form, setForm] = useState<SessionConfigForm | null>(null);
  const [initial, setInitial] = useState<SessionConfigForm | null>(null);
  const [codexModels, setCodexModels] = useState<BackendModelInfo[]>([]);
  const [claudeModels, setClaudeModels] = useState<BackendModelInfo[]>([]);
  const [codexEffectiveContextPercent, setCodexEffectiveContextPercent] = useState(
    CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const formRef = useRef<SessionConfigForm | null>(null);
  const initialRef = useRef<SessionConfigForm | null>(null);
  const initializedSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    initialRef.current = initial;
  }, [initial]);

  const configSourceKey = JSON.stringify({
    sessionId,
    backend,
    model: session?.model || sdkSession?.model || "",
    permissionMode: session?.permissionMode ?? sdkSession?.permissionMode ?? "",
    codexInternetAccess: Object.prototype.hasOwnProperty.call(session ?? {}, "codex_internet_access")
      ? (session as Record<string, unknown> | undefined)?.codex_internet_access
      : sdkSession?.codexInternetAccess,
    codexReasoningEffort: Object.prototype.hasOwnProperty.call(session ?? {}, "codex_reasoning_effort")
      ? (session as Record<string, unknown> | undefined)?.codex_reasoning_effort
      : sdkSession?.codexReasoningEffort,
    codexServiceTier: Object.prototype.hasOwnProperty.call(session ?? {}, "codex_service_tier")
      ? (session as Record<string, unknown> | undefined)?.codex_service_tier
      : sdkSession?.codexServiceTier,
    codexMaxContextLength: Object.prototype.hasOwnProperty.call(session ?? {}, "codex_max_context_length")
      ? (session as Record<string, unknown> | undefined)?.codex_max_context_length
      : sdkSession?.codexMaxContextLength,
    codexLeaderCompactionMode: Object.prototype.hasOwnProperty.call(session ?? {}, "codex_leader_compaction_mode")
      ? (session as Record<string, unknown> | undefined)?.codex_leader_compaction_mode
      : sdkSession?.codexLeaderCompactionMode,
    claudeReasoningEffort: Object.prototype.hasOwnProperty.call(session ?? {}, "claude_reasoning_effort")
      ? (session as Record<string, unknown> | undefined)?.claude_reasoning_effort
      : sdkSession?.claudeReasoningEffort,
    claudeMaxContextLength: Object.prototype.hasOwnProperty.call(session ?? {}, "claude_max_context_length")
      ? (session as Record<string, unknown> | undefined)?.claude_max_context_length
      : sdkSession?.claudeMaxContextLength,
  });

  useEffect(() => {
    const live = session as Record<string, unknown> | undefined;
    const liveCodexInternetAccess = liveValue<boolean | null>(live, "codex_internet_access");
    const liveCodexReasoningEffort = liveValue<string | null>(live, "codex_reasoning_effort");
    const liveCodexServiceTier = liveValue<string | null>(live, "codex_service_tier");
    const liveCodexMaxContextLength = liveValue<number | null>(live, "codex_max_context_length");
    const liveCodexLeaderCompactionMode = liveValue<string | null>(live, "codex_leader_compaction_mode");
    const liveClaudeReasoningEffort = liveValue<string | null>(live, "claude_reasoning_effort");
    const liveClaudeMaxContextLength = liveValue<number | null>(live, "claude_max_context_length");
    const permissionMode = isCodex
      ? normalizeCodexPermissionProfile(session?.permissionMode ?? sdkSession?.permissionMode, "codex-default")
      : normalizeClaudePermissionMode(session?.permissionMode ?? sdkSession?.permissionMode);
    const next: SessionConfigForm = {
      model: session?.model || sdkSession?.model || "",
      permissionMode,
      codexInternetAccess: liveCodexInternetAccess.present
        ? (liveCodexInternetAccess.value ?? false)
        : (sdkSession?.codexInternetAccess ?? false),
      codexReasoningEffort: liveCodexReasoningEffort.present
        ? (liveCodexReasoningEffort.value ?? "")
        : (sdkSession?.codexReasoningEffort ?? ""),
      codexServiceTier: liveCodexServiceTier.present
        ? (liveCodexServiceTier.value ?? null)
        : (sdkSession?.codexServiceTier ?? null),
      codexMaxContextLength: numberInputValue(
        liveCodexMaxContextLength.present
          ? liveCodexMaxContextLength.value
          : (sdkSession?.codexMaxContextLength ?? null),
      ),
      codexLeaderCompactionMode: normalizeCodexLeaderCompactionMode(
        liveCodexLeaderCompactionMode.present
          ? liveCodexLeaderCompactionMode.value
          : sdkSession?.codexLeaderCompactionMode,
      ),
      claudeReasoningEffort: liveClaudeReasoningEffort.present
        ? (liveClaudeReasoningEffort.value ?? "")
        : (sdkSession?.claudeReasoningEffort ?? ""),
      claudeMaxContextLength: numberInputValue(
        liveClaudeMaxContextLength.present
          ? liveClaudeMaxContextLength.value
          : (sdkSession?.claudeMaxContextLength ?? null),
      ),
    };
    const sessionChanged = initializedSessionIdRef.current !== sessionId;
    initializedSessionIdRef.current = sessionId;
    const draftIsPristine = !formRef.current || formsEqual(formRef.current, initialRef.current);
    if (!sessionChanged && !draftIsPristine) return;
    formRef.current = next;
    initialRef.current = next;
    setForm(next);
    setInitial(next);
    setError("");
    setSavedMessage("");
  }, [backend, configSourceKey, isCodex, sessionId]);

  useEffect(() => {
    let cancelled = false;
    api
      .getBackendModels("codex")
      .then((models) => {
        if (!cancelled) setCodexModels(models);
      })
      .catch(() => {});
    api
      .getBackendModels("claude")
      .then((models) => {
        if (!cancelled) setClaudeModels(models);
      })
      .catch(() => {});
    api
      .getSettings()
      .then((settings) => {
        if (!cancelled) {
          setCodexEffectiveContextPercent(
            settings.sessionDefaults?.codex.effectiveContextWindowPercent ??
              CODEX_DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const modelOptions = useMemo(
    () => modelsForBackend(isCodex ? "codex" : "claude", isCodex ? codexModels : claudeModels, form?.model ?? ""),
    [claudeModels, codexModels, form?.model, isCodex],
  );
  const serviceTiers = useMemo(
    () => (form ? selectedCodexTierOptions(form.model, modelOptions) : []),
    [form, modelOptions],
  );
  const selectedModelOption = form ? modelOptions.find((option) => option.value === form.model) : undefined;
  const codexReasoningOptions = getCodexReasoningEffortOptions({
    modelOptions,
    model: form?.model,
    currentEffort: form?.codexReasoningEffort,
  });
  const codexEffectivePercent = effectiveContextPercentForModel(selectedModelOption, codexEffectiveContextPercent);
  const isCodexLeader = isCodex && (session?.isOrchestrator === true || sdkSession?.isOrchestrator === true);

  if (!form || !initial) return null;
  const activeForm = form;

  const codexMaxContext = parseOptionalPositiveInteger(form.codexMaxContextLength);
  const claudeMaxContext = parseOptionalPositiveInteger(form.claudeMaxContextLength);
  const claudeContextInvalid =
    !isCodex &&
    claudeMaxContext.ok &&
    claudeMaxContext.value !== null &&
    claudeMaxContext.value !== CLAUDE_1M_CONTEXT_TOKENS;
  const validationError =
    !codexMaxContext.ok || !claudeMaxContext.ok
      ? "Context window must be a positive integer or empty."
      : claudeContextInvalid
        ? `Claude max context currently supports only ${CLAUDE_1M_CONTEXT_TOKENS.toLocaleString()} or empty.`
        : "";
  const codexMaxContextValue = codexMaxContext.ok ? codexMaxContext.value : null;
  const codexContextWarning = isCodex
    ? contextWindowLimitWarning(codexMaxContextValue, selectedModelOption, {
        leader: isCodexLeader,
        effectivePercent: codexEffectivePercent,
      })
    : null;

  const changedFields = new Set<keyof SessionConfigForm>();
  for (const key of Object.keys(form) as Array<keyof SessionConfigForm>) {
    if ((form[key] ?? null) !== (initial[key] ?? null)) changedFields.add(key);
  }
  const restartRequired = isCodex
    ? [
        "model",
        "permissionMode",
        "codexInternetAccess",
        "codexReasoningEffort",
        "codexMaxContextLength",
        "codexLeaderCompactionMode",
      ].some((key) => changedFields.has(key as keyof SessionConfigForm))
    : ["claudeReasoningEffort", "claudeMaxContextLength"].some((key) =>
        changedFields.has(key as keyof SessionConfigForm),
      );
  const hasChanges = changedFields.size > 0;
  const primaryLabel = !cliConnected
    ? "Save for Next Resume"
    : restartRequired
      ? "Restart to Apply Changes"
      : "Apply Changes";

  function update<K extends keyof SessionConfigForm>(key: K, value: SessionConfigForm[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSavedMessage("");
  }

  function buildPatch(): SessionConfigPatch {
    const patch: SessionConfigPatch = {};
    if (changedFields.has("model")) patch.model = activeForm.model;
    if (changedFields.has("permissionMode")) patch.permissionMode = activeForm.permissionMode;
    if (isCodex) {
      if (changedFields.has("codexInternetAccess")) patch.codexInternetAccess = activeForm.codexInternetAccess;
      if (changedFields.has("codexReasoningEffort"))
        patch.codexReasoningEffort = activeForm.codexReasoningEffort || null;
      if (changedFields.has("codexServiceTier")) patch.codexServiceTier = activeForm.codexServiceTier;
      if (changedFields.has("codexMaxContextLength") && codexMaxContext.ok) {
        patch.codexMaxContextLength = codexMaxContext.value;
      }
      if (changedFields.has("codexLeaderCompactionMode")) {
        patch.codexLeaderCompactionMode = activeForm.codexLeaderCompactionMode;
      }
    } else {
      if (changedFields.has("claudeReasoningEffort"))
        patch.claudeReasoningEffort = activeForm.claudeReasoningEffort || null;
      if (changedFields.has("claudeMaxContextLength") && claudeMaxContext.ok) {
        patch.claudeMaxContextLength = claudeMaxContext.value;
      }
    }
    return patch;
  }

  async function save() {
    if (!hasChanges || validationError || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await api.updateSessionConfig(sessionId, buildPatch());
      updateSdkSession(sessionId, response.session);
      updateSession(sessionId, response.sessionState);
      if (response.restartRequired && response.backendConnected) {
        await api.relaunchSession(sessionId);
      }
      setSavedMessage(
        response.restartRequired || !response.backendConnected ? "Changes will apply on resume." : "Changes applied.",
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const fieldEffect = (restart: boolean, nextTurn = false) =>
    !cliConnected ? "resume" : restart ? "restart" : nextTurn ? "next-turn" : "now";

  const modal = (
    <div
      data-session-info-modal="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Configure Session"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-cc-border bg-cc-card shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-cc-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-cc-fg">Configure Session</h2>
            <p className="mt-0.5 text-xs text-cc-muted">
              {backendLabel} session settings for{" "}
              {sdkSession?.sessionNum ? `#${sdkSession.sessionNum}` : sessionId.slice(0, 8)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
            aria-label="Close Configure Session"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div>
                <FieldLabel label={`${backendLabel} model`} effect={fieldEffect(isCodex)} />
                <select
                  aria-label="Session model"
                  value={form.model}
                  onChange={(event) => update("model", event.target.value)}
                  className={inputClass}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <FieldLabel label="Permission mode" effect={fieldEffect(isCodex)} />
                <select
                  aria-label="Session permission mode"
                  value={form.permissionMode}
                  onChange={(event) => update("permissionMode", event.target.value)}
                  className={inputClass}
                >
                  {isCodex
                    ? codexPermissionOptions().map((option) => (
                        <option key={option.profile} value={option.profile}>
                          {option.label}
                        </option>
                      ))
                    : CLAUDE_PERMISSION_MODES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                </select>
              </div>

              {isCodex ? (
                <>
                  <div>
                    <FieldLabel label="Reasoning effort" effect={fieldEffect(true)} />
                    <select
                      aria-label="Session Codex reasoning effort"
                      value={form.codexReasoningEffort}
                      onChange={(event) => update("codexReasoningEffort", event.target.value)}
                      className={inputClass}
                    >
                      {codexReasoningOptions.map((option) => (
                        <option key={option.value || "default"} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <FieldLabel label="Speed" effect={fieldEffect(false, true)} />
                    <select
                      aria-label="Session Codex speed"
                      value={form.codexServiceTier ?? ""}
                      onChange={(event) => update("codexServiceTier", event.target.value || null)}
                      className={inputClass}
                    >
                      <option value="">Standard</option>
                      {serviceTiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name || tier.id}
                        </option>
                      ))}
                    </select>
                  </div>

                  {isCodexLeader && (
                    <div>
                      <FieldLabel label="Leader context mode" effect={fieldEffect(true)} />
                      <select
                        aria-label="Session Codex leader context mode"
                        value={form.codexLeaderCompactionMode}
                        onChange={(event) =>
                          update("codexLeaderCompactionMode", normalizeCodexLeaderCompactionMode(event.target.value))
                        }
                        className={inputClass}
                      >
                        <option value="recycle">Recycle before Codex compacts</option>
                        <option value="compact">Use Codex built-in compaction</option>
                      </select>
                      <p className="mt-1.5 text-xs text-cc-muted">
                        Automatic behavior only. /compact compacts; /recycle recycles this leader once. Neither command
                        changes this mode.
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <FieldLabel label="Reasoning effort" effect={fieldEffect(true)} />
                  <select
                    aria-label="Session Claude reasoning effort"
                    value={form.claudeReasoningEffort}
                    onChange={(event) =>
                      update("claudeReasoningEffort", event.target.value as ClaudeReasoningEffort | "")
                    }
                    className={inputClass}
                  >
                    <option value="">Backend default</option>
                    {CLAUDE_REASONING_EFFORTS.map((value) => (
                      <option key={value} value={value}>
                        {value === "max" ? "Max" : value[0].toUpperCase() + value.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {isCodex && (
                <label className="flex items-center justify-between gap-3 rounded-lg bg-cc-hover/60 px-3 py-2 text-sm text-cc-fg">
                  <span className="flex flex-col">
                    <span>Internet access</span>
                    <Effect effect={fieldEffect(true)} />
                  </span>
                  <input
                    aria-label="Session Codex internet access"
                    type="checkbox"
                    checked={form.codexInternetAccess}
                    onChange={(event) => update("codexInternetAccess", event.target.checked)}
                  />
                </label>
              )}

              {isCodex ? (
                <div>
                  <FieldLabel label="Usable context capacity" effect={fieldEffect(true)} />
                  <input
                    aria-label="Session Codex usable context capacity"
                    type="number"
                    min={1}
                    value={form.codexMaxContextLength}
                    onChange={(event) => update("codexMaxContextLength", normalizeContextInput(event.target.value))}
                    placeholder="No override"
                    className={inputClass}
                  />
                  <p className="mt-1.5 text-xs leading-snug text-cc-muted">
                    {contextWindowPreview(codexMaxContextValue, codexEffectivePercent, { leader: isCodexLeader })}
                  </p>
                  {codexContextWarning && (
                    <p className="mt-1.5 rounded-lg border border-cc-warning/30 bg-cc-warning/10 px-3 py-2 text-xs leading-relaxed text-cc-fg">
                      {codexContextWarning}
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <FieldLabel label="Max context length" effect={fieldEffect(true)} />
                  <input
                    aria-label="Session Claude max context length"
                    type="number"
                    min={1}
                    value={form.claudeMaxContextLength}
                    onChange={(event) => update("claudeMaxContextLength", normalizeContextInput(event.target.value))}
                    placeholder="No override"
                    className={inputClass}
                  />
                  <p className="mt-1.5 text-xs leading-snug text-cc-muted">
                    Empty leaves the backend default unchanged. Supported value:{" "}
                    {CLAUDE_1M_CONTEXT_TOKENS.toLocaleString()}.
                  </p>
                </div>
              )}

              {restartRequired && (
                <div className="rounded-lg border border-cc-warning/30 bg-cc-warning/10 px-3 py-2 text-xs leading-relaxed text-cc-fg">
                  {cliConnected
                    ? "These changes require restarting the session. The conversation is preserved."
                    : "These changes are saved for the next resume or relaunch."}
                </div>
              )}
              {(validationError || error) && (
                <div className="rounded-lg bg-cc-error/10 px-3 py-2 text-xs text-cc-error">
                  {validationError || error}
                </div>
              )}
              {savedMessage && (
                <div className="rounded-lg bg-cc-success/10 px-3 py-2 text-xs text-cc-success">{savedMessage}</div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-cc-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg px-3 py-2 text-sm text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!hasChanges || !!validationError || saving}
            onClick={() => void save()}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              !hasChanges || validationError || saving
                ? "cursor-not-allowed bg-cc-hover text-cc-muted"
                : restartRequired
                  ? "cursor-pointer bg-cc-warning/20 text-cc-warning hover:bg-cc-warning/30"
                  : "cursor-pointer bg-cc-primary text-white hover:bg-cc-primary-hover"
            }`}
          >
            {saving ? "Saving..." : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );

  // Match other global overlays: escape sidebar/panel overflow and transform containing blocks.
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}
