import { VoiceInputIcon } from "./VoiceInputIcon.js";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject, type ReactNode } from "react";
import {
  formatModel,
  getCodexReasoningEffortOptions,
  type PermissionOption,
  type ModelOption,
} from "../utils/backends.js";
import { CatPawAvatar } from "./CatIcons.js";
import { buildCodexReasoningAuthorityDisplay } from "../utils/codex-reasoning-display.js";

function PaperPlaneIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
    </svg>
  );
}

type CodexMenuPanel = "summary" | "model" | "effort" | "speed";

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <path d="M6 3.5L10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
      <path d="M10 3.5L5.5 8 10 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
      <path d="M3.5 5.25V2.75m0 0H6m-2.5 0L5.1 4.3A5 5 0 1 1 3 8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function friendlyCodexModelLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/^gpt[-\s]*/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return label;
  return normalized
    .split(" ")
    .map((part) => (/^\d/.test(part) ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

function focusableMenuButtons(container: HTMLDivElement | null): HTMLButtonElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
}

export function ComposerMetaToolbar({
  sessionId,
  sessionView,
  isCodex,
  isConnected,
  canEditLaunchSettings,
  imageUploadDisabled,
  imageUploadTitle,
  showModelDropdown,
  setShowModelDropdown,
  modelDropdownRef,
  claudeModelOptions,
  codexModelOptions,
  onSelectModel,
  codexReasoningEffort,
  codexEffectiveReasoningEffort,
  codexEffectiveReasoningEffortReported,
  onSelectCodexReasoning,
  codexServiceTier,
  codexFastServiceTier,
  onSelectCodexServiceTier,
  onResetCodexSettings,
  permissionOptions,
  permissionMode,
  showPermissionDropdown,
  setShowPermissionDropdown,
  permissionDropdownRef,
  pendingPermissionMode,
  onRequestPermissionMode,
  onCancelPermissionMode,
  onConfirmPermissionMode,
  collapseAllButton,
  pauseControl,
  onOpenFilePicker,
  warmMicrophone,
  voiceSupported,
  toggleVoiceUnsupportedInfo,
  handleMicClick,
  voiceButtonDisabled,
  isPreparing,
  isRecording,
  voiceButtonTitle,
  canSend,
  isRunning,
  handleInterrupt,
  handleSend,
  sendButtonTitle,
  sendPressing,
}: {
  sessionId: string;
  sessionView: {
    gitBranch?: string;
    model?: string;
    isContainerized?: boolean;
    gitAhead: number;
    gitBehind: number;
  };
  isCodex: boolean;
  isConnected: boolean;
  canEditLaunchSettings: boolean;
  imageUploadDisabled: boolean;
  imageUploadTitle: string;
  showModelDropdown: boolean;
  setShowModelDropdown: (open: boolean) => void;
  modelDropdownRef: RefObject<HTMLDivElement | null>;
  claudeModelOptions: ModelOption[];
  codexModelOptions: ModelOption[];
  onSelectModel: (model: string) => void;
  codexReasoningEffort: string;
  codexEffectiveReasoningEffort: string | null;
  codexEffectiveReasoningEffortReported: boolean;
  onSelectCodexReasoning: (effort: string) => void;
  codexServiceTier: string | null;
  codexFastServiceTier: NonNullable<ModelOption["serviceTiers"]>[number] | null;
  onSelectCodexServiceTier: (serviceTier: string | null) => void;
  onResetCodexSettings: () => Promise<void>;
  permissionOptions: PermissionOption[];
  permissionMode: string;
  showPermissionDropdown: boolean;
  setShowPermissionDropdown: (open: boolean) => void;
  permissionDropdownRef: RefObject<HTMLDivElement | null>;
  pendingPermissionMode: string | null;
  onRequestPermissionMode: (mode: string) => void;
  onCancelPermissionMode: () => void;
  onConfirmPermissionMode: () => void;
  collapseAllButton: ReactNode;
  pauseControl: ReactNode;
  onOpenFilePicker: () => void;
  warmMicrophone: () => void;
  voiceSupported: boolean;
  toggleVoiceUnsupportedInfo: (expandComposerOnReveal?: boolean) => void;
  handleMicClick: () => void;
  voiceButtonDisabled: boolean;
  isPreparing: boolean;
  isRecording: boolean;
  voiceButtonTitle: string;
  canSend: boolean;
  isRunning: boolean;
  handleInterrupt: () => void;
  handleSend: () => void;
  sendButtonTitle: string;
  sendPressing: boolean;
}) {
  const [codexMenuPanel, setCodexMenuPanel] = useState<CodexMenuPanel>("summary");
  const [resettingCodexSettings, setResettingCodexSettings] = useState(false);
  const [resetCodexSettingsError, setResetCodexSettingsError] = useState("");
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const codexMenuRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<{ kind: "summary" | "option"; value: string } | null>(null);
  const selectedPermission =
    permissionOptions.find((option) => option.value === permissionMode) ?? permissionOptions[0];
  const pendingPermission = pendingPermissionMode
    ? permissionOptions.find((option) => option.value === pendingPermissionMode)
    : null;
  const fastSupported = !!codexFastServiceTier;
  const fastSelected = !!codexFastServiceTier && codexServiceTier === codexFastServiceTier.id;
  const selectedSpeedLabel = fastSelected ? codexFastServiceTier.name : "Standard";
  const fastDescription = codexFastServiceTier?.description || "Use increased-priority Codex service tier.";
  const selectableCodexModelOptions = codexModelOptions.filter((option) => option.value);
  const selectedCodexModel = codexModelOptions.find((option) => option.value === sessionView.model);
  const supportedReasoningValues = selectedCodexModel?.supportedReasoningLevels?.map((level) => level.effort) ?? null;
  const normalizedCurrentEffort = codexReasoningEffort.trim().toLowerCase();
  const currentEffortAdvertised =
    !normalizedCurrentEffort ||
    !supportedReasoningValues?.length ||
    supportedReasoningValues.includes(normalizedCurrentEffort);
  const allCodexReasoningOptions = getCodexReasoningEffortOptions({
    modelOptions: codexModelOptions,
    model: sessionView.model,
    currentEffort: codexReasoningEffort,
  });
  const codexReasoningOptions = allCodexReasoningOptions.filter(
    (option) => !option.value || !supportedReasoningValues?.length || supportedReasoningValues.includes(option.value),
  );
  const selectedModelLabel = friendlyCodexModelLabel(selectedCodexModel?.label || sessionView.model || "Model");
  const defaultReasoningValue = selectedCodexModel?.defaultReasoningLevel?.trim().toLowerCase() || "";
  const defaultReasoningLabel = defaultReasoningValue
    ? getCodexReasoningEffortOptions({
        modelOptions: codexModelOptions,
        model: sessionView.model,
        currentEffort: defaultReasoningValue,
        includeDefault: false,
      }).find((option) => option.value === defaultReasoningValue)?.label || defaultReasoningValue
    : "";
  const selectedReasoningLabel = normalizedCurrentEffort
    ? currentEffortAdvertised
      ? codexReasoningOptions.find((option) => option.value === normalizedCurrentEffort)?.label ||
        normalizedCurrentEffort
      : `${allCodexReasoningOptions.find((option) => option.value === normalizedCurrentEffort)?.label || normalizedCurrentEffort} (unavailable)`
    : defaultReasoningLabel
      ? `${defaultReasoningLabel} (default)`
      : "Default";
  const reasoningAuthority = buildCodexReasoningAuthorityDisplay({
    requested: codexReasoningEffort,
    effective: codexEffectiveReasoningEffort,
    effectiveReported: codexEffectiveReasoningEffortReported,
    runtimeConnected: isConnected,
    defaultRequested: defaultReasoningValue,
    defaultRequestedLabel: defaultReasoningLabel,
    labelForEffort: (effort) =>
      getCodexReasoningEffortOptions({
        modelOptions: codexModelOptions,
        model: sessionView.model,
        currentEffort: effort,
        includeDefault: false,
      }).find((option) => option.value === effort)?.label || effort,
  });
  const combinedCodexLabel = reasoningAuthority.triggerSuffix
    ? `${selectedModelLabel} ${reasoningAuthority.triggerSuffix}`
    : selectedModelLabel;
  const hasReasoningChoices = codexReasoningOptions.some((option) => option.value !== "");
  const settingsDisabled = !canEditLaunchSettings;
  const quietSettingsDisabledClass = settingsDisabled
    ? "opacity-30 cursor-not-allowed text-cc-muted"
    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer";
  const permissionTitle = settingsDisabled
    ? "Reconnect to Takode to change permissions"
    : isConnected
      ? `${selectedPermission.label}: ${selectedPermission.description}`
      : "Applies on resume";
  const claudeModelTitle = settingsDisabled
    ? "Reconnect to Takode to change model"
    : isConnected
      ? `Model: ${sessionView.model} (click to change)`
      : "Applies on resume";
  const codexModelTitle = settingsDisabled
    ? "Reconnect to Takode to change model"
    : isConnected
      ? `Model: ${sessionView.model}; speed: ${selectedSpeedLabel}; ${reasoningAuthority.title} (click to change)`
      : "Applies on resume";
  const permissionChangeDetail = isConnected
    ? "This will restart the CLI session. Any in-progress operation will be interrupted. Your conversation will be preserved."
    : "This will apply when the session resumes. Your conversation will be preserved.";
  const permissionConfirmLabel = isConnected ? "Restart" : "Apply";

  useEffect(() => {
    if (showModelDropdown) return;
    setCodexMenuPanel("summary");
    setResetCodexSettingsError("");
  }, [showModelDropdown]);

  useEffect(() => {
    if (!showModelDropdown || !isCodex || !pendingFocusRef.current) return;
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const selector =
      pending.kind === "summary"
        ? `[data-codex-summary-key="${pending.value}"]`
        : `[data-codex-option-value="${pending.value}"]`;
    codexMenuRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [codexMenuPanel, isCodex, showModelDropdown]);

  function openCodexPanel(panel: Exclude<CodexMenuPanel, "summary">, focusValue: string) {
    pendingFocusRef.current = { kind: "option", value: focusValue };
    setCodexMenuPanel(panel);
  }

  function returnToCodexSummary(summaryKey: "model" | "effort" | "speed") {
    pendingFocusRef.current = { kind: "summary", value: summaryKey };
    setCodexMenuPanel("summary");
  }

  function closeModelMenu() {
    setShowModelDropdown(false);
    setCodexMenuPanel("summary");
    modelTriggerRef.current?.focus();
  }

  function toggleCodexModelMenu() {
    if (showModelDropdown) {
      closeModelMenu();
      return;
    }
    pendingFocusRef.current = { kind: "summary", value: "model" };
    setCodexMenuPanel("summary");
    setShowModelDropdown(true);
  }

  function handleCodexMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (codexMenuPanel === "summary") closeModelMenu();
      else returnToCodexSummary(codexMenuPanel);
      return;
    }
    if (event.key === "ArrowLeft" && codexMenuPanel !== "summary") {
      event.preventDefault();
      returnToCodexSummary(codexMenuPanel);
      return;
    }
    if (!new Set(["ArrowDown", "ArrowUp", "Home", "End"]).has(event.key)) return;
    const buttons = focusableMenuButtons(codexMenuRef.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") buttons[0]?.focus();
    else if (event.key === "End") buttons.at(-1)?.focus();
    else if (event.key === "ArrowDown") buttons[(currentIndex + 1 + buttons.length) % buttons.length]?.focus();
    else buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
  }

  async function handleResetCodexSettings() {
    if (resettingCodexSettings) return;
    setResettingCodexSettings(true);
    setResetCodexSettingsError("");
    try {
      await onResetCodexSettings();
      closeModelMenu();
    } catch {
      setResetCodexSettingsError("Couldn’t load session defaults. Try again.");
    } finally {
      setResettingCodexSettings(false);
    }
  }

  return (
    <div
      data-testid="composer-footer-toolbar"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 pb-2.5 pt-1 sm:flex-nowrap"
    >
      <div className="flex min-w-0 basis-full flex-1 items-center gap-1.5 sm:basis-auto">
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative" ref={permissionDropdownRef}>
            <button
              onClick={() => setShowPermissionDropdown(!showPermissionDropdown)}
              disabled={settingsDisabled}
              className={`flex max-w-[150px] items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors select-none ${
                quietSettingsDisabledClass
              }`}
              title={permissionTitle}
            >
              <span className="truncate">{selectedPermission.label}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5 shrink-0 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showPermissionDropdown && (
              <div
                data-testid="composer-permission-mode-menu"
                className="absolute left-0 bottom-full z-10 mb-1 w-64 overflow-hidden rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg"
              >
                {permissionOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => onRequestPermissionMode(option.value)}
                    className={`w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-cc-hover ${
                      option.value === permissionMode ? "text-cc-primary" : "text-cc-fg"
                    }`}
                  >
                    <div className="text-xs font-medium">{option.label}</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-cc-muted">{option.description}</div>
                  </button>
                ))}
              </div>
            )}
            {pendingPermission && (
              <div
                data-testid="composer-permission-mode-popover"
                className="absolute left-0 bottom-full z-20 mb-2 w-72 rounded-[10px] border border-cc-border bg-cc-card p-3 shadow-lg"
              >
                <p className="mb-1 text-xs font-medium text-cc-fg">Change permissions to {pendingPermission.label}?</p>
                <p className="mb-3 text-[11px] leading-relaxed text-cc-muted">{permissionChangeDetail}</p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={onCancelPermissionMode}
                    className="cursor-pointer rounded-md px-2.5 py-1 text-[11px] text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={onConfirmPermissionMode}
                    className="cursor-pointer rounded-md bg-cc-primary/15 px-2.5 py-1 text-[11px] font-medium text-cc-primary transition-colors hover:bg-cc-primary/25"
                  >
                    {permissionConfirmLabel}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0">{collapseAllButton}</div>
        <div className="shrink-0">{pauseControl}</div>

        {sessionView.model && (
          <div data-testid="composer-footer-meta" className="flex min-w-0 items-center gap-2 text-[11px] text-cc-muted">
            {!isCodex ? (
              <div className="relative min-w-0" ref={modelDropdownRef}>
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  disabled={settingsDisabled}
                  className={`flex min-w-0 max-w-[132px] items-center gap-1 rounded-md px-2 py-1 font-mono-code transition-colors select-none sm:max-w-[180px] ${
                    settingsDisabled
                      ? "cursor-not-allowed opacity-30"
                      : "cursor-pointer hover:bg-cc-hover hover:text-cc-fg"
                  }`}
                  title={claudeModelTitle}
                >
                  <span className="truncate">{formatModel(sessionView.model)}</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {showModelDropdown && (
                  <div
                    data-testid="composer-model-menu"
                    className="absolute left-0 bottom-full z-10 mb-1 max-h-64 w-52 overflow-y-auto rounded-[10px] border border-cc-border bg-cc-card py-1 shadow-lg"
                  >
                    {claudeModelOptions.map((m) => (
                      <button
                        key={m.value}
                        onClick={() => {
                          onSelectModel(m.value);
                          setShowModelDropdown(false);
                        }}
                        className={`w-full cursor-pointer px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover ${
                          m.value === sessionView.model ? "font-medium text-cc-primary" : "text-cc-fg"
                        }`}
                      >
                        <span className="mr-1.5">{m.icon}</span>
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="relative min-w-0" ref={modelDropdownRef}>
                <button
                  ref={modelTriggerRef}
                  onClick={toggleCodexModelMenu}
                  disabled={settingsDisabled}
                  aria-expanded={showModelDropdown}
                  aria-haspopup="menu"
                  aria-label={`Model and effort: ${combinedCodexLabel}`}
                  className={`flex min-w-0 max-w-[148px] items-center gap-1 rounded-md px-2 py-1 transition-colors select-none sm:max-w-[210px] ${
                    settingsDisabled
                      ? "cursor-not-allowed opacity-30"
                      : "cursor-pointer hover:bg-cc-hover hover:text-cc-fg"
                  }`}
                  title={codexModelTitle}
                >
                  <span data-testid="composer-model-trigger-label" className="truncate font-medium">
                    {combinedCodexLabel}
                  </span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="h-2.5 w-2.5 shrink-0 opacity-50">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {showModelDropdown && (
                  <div
                    ref={codexMenuRef}
                    data-testid="composer-model-menu"
                    data-codex-panel={codexMenuPanel}
                    role="menu"
                    aria-label="Model and effort settings"
                    onKeyDown={handleCodexMenuKeyDown}
                    className="absolute right-0 bottom-full z-10 mb-1 max-h-[min(22rem,calc(100vh-8rem))] w-48 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[12px] border border-cc-border bg-cc-card p-1.5 shadow-lg sm:right-auto sm:left-0 sm:w-72"
                  >
                    {codexMenuPanel === "summary" && (
                      <div data-testid="composer-model-summary-menu">
                        <button
                          data-codex-summary-key="model"
                          role="menuitem"
                          onClick={() =>
                            openCodexPanel("model", sessionView.model || selectableCodexModelOptions[0]?.value || "")
                          }
                          className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-cc-fg transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none"
                        >
                          <span className="text-sm font-medium">Model</span>
                          <span className="ml-auto max-w-[9.5rem] truncate text-sm text-cc-muted">
                            {selectedModelLabel}
                          </span>
                          <span className="shrink-0 text-cc-muted">
                            <ChevronRightIcon />
                          </span>
                        </button>
                        {hasReasoningChoices && (
                          <button
                            data-codex-summary-key="effort"
                            role="menuitem"
                            onClick={() => openCodexPanel("effort", codexReasoningEffort || "default")}
                            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-cc-fg transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none"
                          >
                            <span className="text-sm font-medium">Effort</span>
                            <span className="ml-auto max-w-[9.5rem] truncate text-sm text-cc-muted">
                              {selectedReasoningLabel}
                            </span>
                            <span className="shrink-0 text-cc-muted">
                              <ChevronRightIcon />
                            </span>
                          </button>
                        )}
                        {reasoningAuthority.warningLabel && (
                          <div
                            data-testid="composer-reasoning-warning"
                            role="status"
                            className="mx-2 mb-1 flex items-start gap-2 rounded-md border border-cc-warning/25 bg-cc-warning/10 px-2.5 py-2 text-[11px] leading-snug text-cc-warning"
                            title={reasoningAuthority.title}
                          >
                            <span aria-hidden="true" className="mt-px shrink-0 font-semibold">
                              !
                            </span>
                            <span>{reasoningAuthority.warningLabel}</span>
                          </div>
                        )}
                        {fastSupported && (
                          <button
                            data-codex-summary-key="speed"
                            role="menuitem"
                            onClick={() =>
                              openCodexPanel(
                                "speed",
                                fastSelected ? codexFastServiceTier?.id || "standard" : "standard",
                              )
                            }
                            className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-cc-fg transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none"
                          >
                            <span className="text-sm font-medium">Speed</span>
                            <span className="ml-auto max-w-[9.5rem] truncate text-sm text-cc-muted">
                              {selectedSpeedLabel}
                            </span>
                            <span className="shrink-0 text-cc-muted">
                              <ChevronRightIcon />
                            </span>
                          </button>
                        )}
                        <div className="my-1 border-t border-cc-border/70" />
                        <button
                          role="menuitem"
                          onClick={() => void handleResetCodexSettings()}
                          disabled={resettingCodexSettings}
                          className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:bg-cc-hover focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
                        >
                          <span>{resettingCodexSettings ? "Resetting…" : "Reset to default"}</span>
                          <span className="ml-auto">
                            <ResetIcon />
                          </span>
                        </button>
                        {resetCodexSettingsError && (
                          <p role="alert" className="px-3 pb-1 pt-0.5 text-[11px] leading-snug text-cc-error">
                            {resetCodexSettingsError}
                          </p>
                        )}
                      </div>
                    )}

                    {codexMenuPanel === "model" && (
                      <div data-testid="composer-model-options-menu">
                        <button
                          role="menuitem"
                          onClick={() => returnToCodexSummary("model")}
                          className="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:bg-cc-hover focus-visible:outline-none"
                        >
                          <BackIcon /> Model
                        </button>
                        {selectableCodexModelOptions.map((model) => (
                          <button
                            key={model.value}
                            data-codex-option-value={model.value}
                            role="menuitemradio"
                            aria-checked={model.value === sessionView.model}
                            onClick={() => {
                              onSelectModel(model.value);
                              returnToCodexSummary("model");
                            }}
                            className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none ${
                              model.value === sessionView.model ? "font-medium text-cc-primary" : "text-cc-fg"
                            }`}
                          >
                            <span className="w-4 shrink-0 text-center">{model.icon}</span>
                            <span className="truncate">{friendlyCodexModelLabel(model.label)}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    {codexMenuPanel === "effort" && (
                      <div data-testid="composer-reasoning-menu">
                        <button
                          role="menuitem"
                          onClick={() => returnToCodexSummary("effort")}
                          className="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:bg-cc-hover focus-visible:outline-none"
                        >
                          <BackIcon /> Effort
                        </button>
                        {codexReasoningOptions.map((effort) => {
                          const isDefault = effort.value === "";
                          const label =
                            isDefault && defaultReasoningLabel ? `Default (${defaultReasoningLabel})` : effort.label;
                          return (
                            <button
                              key={effort.value || "default"}
                              data-codex-option-value={effort.value || "default"}
                              role="menuitemradio"
                              aria-checked={effort.value === codexReasoningEffort}
                              onClick={() => {
                                onSelectCodexReasoning(effort.value);
                                returnToCodexSummary("effort");
                              }}
                              className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none ${
                                effort.value === codexReasoningEffort ? "text-cc-primary" : "text-cc-fg"
                              }`}
                            >
                              <div className="text-xs font-medium">{label}</div>
                              {effort.description && (
                                <div className="mt-0.5 text-[11px] leading-snug text-cc-muted">
                                  {effort.description}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {codexMenuPanel === "speed" && codexFastServiceTier && (
                      <div data-testid="composer-speed-menu">
                        <button
                          role="menuitem"
                          onClick={() => returnToCodexSummary("speed")}
                          className="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:bg-cc-hover focus-visible:outline-none"
                        >
                          <BackIcon /> Speed
                        </button>
                        <button
                          data-codex-option-value="standard"
                          role="menuitemradio"
                          aria-checked={!fastSelected}
                          onClick={() => {
                            onSelectCodexServiceTier(null);
                            returnToCodexSummary("speed");
                          }}
                          className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none ${
                            !fastSelected ? "text-cc-primary" : "text-cc-fg"
                          }`}
                        >
                          <div className="text-xs font-medium">Standard</div>
                          <div className="mt-0.5 text-[11px] leading-snug text-cc-muted">Default Codex speed.</div>
                        </button>
                        <button
                          data-codex-option-value={codexFastServiceTier.id}
                          role="menuitemradio"
                          aria-checked={fastSelected}
                          onClick={() => {
                            onSelectCodexServiceTier(codexFastServiceTier.id);
                            returnToCodexSummary("speed");
                          }}
                          className={`w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors hover:bg-cc-hover focus-visible:bg-cc-hover focus-visible:outline-none ${
                            fastSelected ? "text-cc-primary" : "text-cc-fg"
                          }`}
                        >
                          <div className="text-xs font-medium">{codexFastServiceTier.name}</div>
                          <div className="mt-0.5 text-[11px] leading-snug text-cc-muted">{fastDescription}</div>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-1">
        <button
          onClick={onOpenFilePicker}
          disabled={imageUploadDisabled}
          className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
            !imageUploadDisabled
              ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              : "text-cc-muted opacity-30 cursor-not-allowed"
          }`}
          title={imageUploadTitle}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-5 h-5 sm:w-4 sm:h-4"
          >
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
            <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <button
          onPointerEnter={warmMicrophone}
          onClick={!voiceSupported ? () => toggleVoiceUnsupportedInfo(false) : handleMicClick}
          disabled={voiceButtonDisabled}
          aria-label="Voice input"
          aria-disabled={!voiceSupported || voiceButtonDisabled}
          className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
            !voiceSupported || voiceButtonDisabled
              ? "text-cc-muted opacity-30 cursor-not-allowed"
              : isPreparing
                ? "text-cc-warning bg-cc-warning/10 cursor-wait"
                : isRecording
                  ? "text-cc-primary bg-cc-primary/10 hover:bg-cc-primary/20 cursor-pointer"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          }`}
          title={voiceButtonTitle}
        >
          <VoiceInputIcon active={isRecording || isPreparing} />
        </button>

        {isRunning && (
          <button
            onClick={handleInterrupt}
            className="flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
            title="Stop generation"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        )}
        {(canSend || !isRunning) && (
          <div className="relative group">
            <button
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
              className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors ${
                canSend
                  ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                  : "bg-cc-hover text-cc-muted cursor-not-allowed"
              } ${sendPressing ? "animate-[send-morph_500ms_ease-out]" : ""}`}
              title={sendButtonTitle}
            >
              {sendPressing ? (
                <CatPawAvatar className="w-5 h-5 sm:w-4 sm:h-4" />
              ) : (
                <PaperPlaneIcon className="w-5 h-5 sm:w-4 sm:h-4" />
              )}
            </button>
            {!canSend && sendButtonTitle !== "Send message" && (
              <div className="pointer-events-none absolute bottom-full right-0 mb-2 hidden group-hover:block">
                <div className="whitespace-nowrap rounded-lg border border-cc-border bg-cc-card px-3 py-1.5 text-[11px] text-cc-muted shadow-lg">
                  {sendButtonTitle}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
