import { ComposerMinimizer } from "./ComposerMinimizer.js";
import { sendComposerDraft } from "./composer-message-send.js";
import { ComposerAnnotations } from "./ComposerAnnotations.js";
import { formatAnnotatedMessage } from "../../shared/conversation-annotations.js";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  deriveUiMode,
  deriveCodexPermissionMode,
  formatModel,
  getModelsForBackend,
  normalizeClaudePermission,
  resolveClaudePermissionCliMode,
  resolveCodexPermissionCliMode,
  toModelOptions,
  type ClaudePermissionMode,
  type CodexPermissionMode,
  type ModelOption,
} from "../utils/backends.js";
import { isTouchDevice } from "../utils/mobile.js";
import { ComposerMenus } from "./ComposerMenus.js";
import { ComposerMetaToolbar } from "./ComposerMetaToolbar.js";
import { buildComposerPlaceholder } from "./composer-placeholder.js";
import { ComposerReferencePreview } from "./ComposerReferencePreview.js";
import { CollapseAllButton } from "./ComposerCollapseAllButton.js";
import { CollapsedComposerBar, ComposerInputSurface } from "./ComposerSurface.js";
import { PausedInputChip, PauseOtherSourcesButton } from "./SessionPauseComposerControls.js";
import { ComposerStatusBlocks } from "./ComposerStatusBlocks.js";
import { useCodexModelOptions } from "./use-codex-model-options.js";
import { useComposerNavigationFocus } from "./use-composer-navigation-focus.js";
import { useResetCodexModelSettings } from "./use-reset-codex-model-settings.js";
import {
  createComposerDraftImage,
  ensureSupportedFormat,
  getImageFiles,
  getPastedImageFiles,
  hasDraggedImageFiles,
  readFileAsBase64,
} from "./composer-image-utils.js";
import { collectPlainTakodeReferences, parseCodexModeSlashCommand } from "./composer-reference-utils.js";
import { useComposerAutocomplete } from "./use-composer-autocomplete.js";
import type { AlternateVoiceRerun, FailedTranscription, VoiceEditProposal } from "./composer-voice-types.js";
import { useVoiceInput } from "../hooks/useVoiceInput.js";
import { useComposerSessionView } from "./use-composer-session-view.js";
import {
  api,
  type VoiceRecordingTiming,
  type VoiceTranscriptionClientTiming,
  type VoiceTranscriptionFrontendTimingEvent,
  type VoiceTranscriptionPhase,
  type VoiceTranscriptionProgressEvent,
  type VoiceTranscriptionUiTiming,
} from "../api.js";
import { recordFrontendPerfEntry } from "../utils/frontend-perf-recorder.js";
import {
  buildVsCodeSelectionPrompt,
  formatVsCodeSelectionAttachmentLabel,
  formatVsCodeSelectionSummary,
  getVsCodeSelectionDismissKey,
  getVsCodeSelectionSessionRoot,
  resolveVsCodeSelectionForSession,
  type VsCodeSelectionContextPayload,
} from "../utils/vscode-context.js";
import { isNarrowComposerLayout } from "../utils/layout.js";
import {
  SHORTCUT_DOUBLE_TAP_WINDOW_MS,
  getMatchingShortcutAction,
  getMatchingShortcutTapAction,
  isModifierOnlyKey,
  type ShortcutActionId,
} from "../shortcuts.js";
import type { ComposerDraftImage, SessionPauseState } from "../types.js";
import {
  abortPendingUserUpload,
  clearPendingUserUploadController,
  registerPendingUserUploadController,
} from "../pending-user-upload-manager.js";
import {
  afterNextPaint,
  calculateVoiceTranscriptionPhaseDurations,
  createVoiceTranscriptionRequestId,
  nowMs,
} from "./composer-voice-transcription-utils.js";

export { ReplyChip } from "./ReplyChip.js";

const EMPTY_COMPOSER_IMAGES: ComposerDraftImage[] = [];
const VOICE_SHORTCUT_ACTIONS: readonly ShortcutActionId[] = ["voice_start", "voice_stop"];

function eventKeyIsOnlyPressedModifier(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  if (event.key === "Shift") return event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
  if (event.key === "Control") return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (event.key === "Alt") return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if (event.key === "Meta") return event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
  return false;
}

function eventUsesComboModifier(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) && !eventKeyIsOnlyPressedModifier(event);
}

export function Composer({
  sessionId,
  threadKey = "main",
  questId,
  transcriptionThreadKey,
  transcriptionThreadTitle,
}: {
  sessionId: string;
  threadKey?: string;
  questId?: string;
  transcriptionThreadKey?: string;
  transcriptionThreadTitle?: string;
}) {
  const draft = useStore((s) => s.composerDrafts.get(sessionId));
  const shortcutSettings = useStore((s) => s.shortcutSettings);
  const replyContext = useStore((s) => s.replyContexts.get(sessionId));
  const text = draft?.text ?? "";
  const images = draft?.images ?? EMPTY_COMPOSER_IMAGES;
  const annotations = draft?.annotations;
  const annotationEditorOpen = useStore((state) => state.annotationEditor?.sessionId === sessionId);
  const setText = useCallback(
    (t: string | ((prev: string) => string)) => {
      const store = useStore.getState();
      const current = store.composerDrafts.get(sessionId);
      const prevText = current?.text ?? "";
      const newText = typeof t === "function" ? t(prevText) : t;
      store.setComposerDraft(sessionId, { ...current, text: newText, images: current?.images ?? [] });
    },
    [sessionId],
  );
  const setImages = useCallback(
    (updater: ComposerDraftImage[] | ((prev: ComposerDraftImage[]) => ComposerDraftImage[])) => {
      const store = useStore.getState();
      const current = store.composerDrafts.get(sessionId);
      const prevImages = current?.images ?? [];
      const newImages = typeof updater === "function" ? updater(prevImages) : updater;
      store.setComposerDraft(sessionId, { ...current, text: current?.text ?? "", images: newImages });
    },
    [sessionId],
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false);
  const [pendingPermissionMode, setPendingPermissionMode] = useState<string | null>(null);
  const [dynamicClaudeModels, setDynamicClaudeModels] = useState<ModelOption[] | null>(null);
  const [sendPressing, setSendPressing] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [voiceEditProposal, setVoiceEditProposal] = useState<VoiceEditProposal | null>(null);
  const [alternateVoiceRerun, setAlternateVoiceRerun] = useState<AlternateVoiceRerun | null>(null);
  const zoomLevel = useStore((s) => s.zoomLevel);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageDragDepthRef = useRef(0);
  const startedImageUploadsRef = useRef(new Set<string>());
  const draftImageSourceFilesRef = useRef(new Map<string, File>());
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const permissionDropdownRef = useRef<HTMLDivElement>(null);
  const voiceCaptureModeRef = useRef<"dictation" | "edit" | "append">("dictation");
  const voiceEditBaseTextRef = useRef("");
  const activeVoiceTranscriptionThreadKeyRef = useRef<string | undefined>(transcriptionThreadKey);
  const activeVoiceTranscriptionThreadTitleRef = useRef<string | undefined>(transcriptionThreadTitle);
  const preferredVoiceModeRef = useRef<"edit" | "append">("edit");
  const persistedSettingsRef = useRef<Awaited<ReturnType<typeof api.getSettings>> | null>(null);
  const persistedSettingsLoadedRef = useRef(false);
  const persistedSettingsRequestRef = useRef<Promise<Awaited<ReturnType<typeof api.getSettings>> | null> | null>(null);
  const sendPressingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceStartPendingRef = useRef(false);
  const voiceStartPendingReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceShortcutTapCandidateRef = useRef<string | null>(null);
  const voiceShortcutLastTapRef = useRef<{ key: string; time: number } | null>(null);
  const voiceShortcutTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voiceCaptureMode, setVoiceCaptureMode] = useState<"dictation" | "edit" | "append">("dictation");
  const [failedTranscription, setFailedTranscription] = useState<FailedTranscription | null>(null);
  const preRecordingTextRef = useRef({ before: "", after: "" });
  const {
    isRecording,
    isPreparing,
    isSupported: voiceSupported,
    unsupportedReason: voiceUnsupportedReason,
    unsupportedMessage: voiceUnsupportedMessage,
    isTranscribing,
    transcriptionPhase,
    error: voiceError,
    volumeLevel,
    volumeHistory = [],
    setIsTranscribing,
    setTranscriptionPhase,
    setError: setVoiceError,
    toggleRecording,
    cancelRecording,
    warmMicrophone,
  } = useVoiceInput({
    onAudioReady: (blob, recordingTiming) => {
      performTranscription(
        blob,
        voiceCaptureModeRef.current,
        voiceEditBaseTextRef.current,
        {
          ...preRecordingTextRef.current,
        },
        activeVoiceTranscriptionThreadKeyRef.current,
        activeVoiceTranscriptionThreadTitleRef.current,
        recordingTiming,
      );
    },
  });
  const [voiceUnsupportedInfoOpen, setVoiceUnsupportedInfoOpen] = useState(false);
  const isRecordingRef = useRef(isRecording);
  const isPreparingRef = useRef(isPreparing);

  const clearPendingVoiceStart = useCallback(() => {
    if (voiceStartPendingReleaseTimerRef.current) {
      clearTimeout(voiceStartPendingReleaseTimerRef.current);
      voiceStartPendingReleaseTimerRef.current = null;
    }
    voiceStartPendingRef.current = false;
  }, []);

  const clearVoiceShortcutTap = useCallback(() => {
    if (voiceShortcutTapTimerRef.current) {
      clearTimeout(voiceShortcutTapTimerRef.current);
      voiceShortcutTapTimerRef.current = null;
    }
    voiceShortcutTapCandidateRef.current = null;
    voiceShortcutLastTapRef.current = null;
  }, []);

  const deferPendingVoiceStartRelease = useCallback(() => {
    if (voiceStartPendingReleaseTimerRef.current) {
      clearTimeout(voiceStartPendingReleaseTimerRef.current);
    }
    voiceStartPendingReleaseTimerRef.current = setTimeout(() => {
      voiceStartPendingReleaseTimerRef.current = null;
      voiceStartPendingRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    isPreparingRef.current = isPreparing;
    if (isRecording || isPreparing) {
      clearPendingVoiceStart();
    }
  }, [clearPendingVoiceStart, isPreparing, isRecording]);

  useEffect(() => clearPendingVoiceStart, [clearPendingVoiceStart]);

  useEffect(
    () => () => {
      if (sendPressingTimerRef.current) {
        clearTimeout(sendPressingTimerRef.current);
        sendPressingTimerRef.current = null;
      }
    },
    [],
  );

  const applyPersistedVoicePreference = useCallback((settings: Awaited<ReturnType<typeof api.getSettings>> | null) => {
    persistedSettingsRef.current = settings;
    persistedSettingsLoadedRef.current = true;
    const savedVoiceMode = settings?.transcriptionConfig?.voiceCaptureMode;
    preferredVoiceModeRef.current = savedVoiceMode === "edit" || savedVoiceMode === "append" ? savedVoiceMode : "edit";
    return settings;
  }, []);

  const loadPersistedSettings = useCallback(() => {
    if (persistedSettingsLoadedRef.current) {
      return Promise.resolve(persistedSettingsRef.current);
    }
    if (persistedSettingsRequestRef.current) {
      return persistedSettingsRequestRef.current;
    }
    const request = api
      .getSettings()
      .catch(() => null)
      .then((settings) => applyPersistedVoicePreference(settings))
      .finally(() => {
        persistedSettingsRequestRef.current = null;
      });
    persistedSettingsRequestRef.current = request;
    return request;
  }, [applyPersistedVoicePreference]);

  const persistPreferredVoiceMode = useCallback((mode: "edit" | "append") => {
    preferredVoiceModeRef.current = mode;
    if (persistedSettingsRef.current) {
      persistedSettingsRef.current = {
        ...persistedSettingsRef.current,
        transcriptionConfig: {
          ...persistedSettingsRef.current.transcriptionConfig,
          voiceCaptureMode: mode,
        },
      };
    }
    api.updateSettings({ transcriptionConfig: { voiceCaptureMode: mode } }).catch(() => {});
  }, []);

  const handleMicClick = useCallback(async () => {
    if (!voiceSupported) {
      setVoiceError(voiceUnsupportedMessage ?? "Voice input is unavailable.");
      return;
    }
    if (isRecordingRef.current) {
      clearPendingVoiceStart();
      toggleRecording();
      return;
    }
    if (isPreparingRef.current || voiceStartPendingRef.current) {
      return;
    }

    voiceStartPendingRef.current = true;
    try {
      setFailedTranscription(null);
      setAlternateVoiceRerun(null);
      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? text.length;
      activeVoiceTranscriptionThreadKeyRef.current = transcriptionThreadKey;
      activeVoiceTranscriptionThreadTitleRef.current = transcriptionThreadTitle;
      preRecordingTextRef.current = {
        before: text.slice(0, cursorPos),
        after: text.slice(cursorPos),
      };
      if (text.trim().length > 0) {
        if (!persistedSettingsLoadedRef.current) {
          await loadPersistedSettings();
        }
        if (isRecordingRef.current || isPreparingRef.current) {
          clearPendingVoiceStart();
          return;
        }
        const mode = preferredVoiceModeRef.current;
        voiceCaptureModeRef.current = mode;
        setVoiceCaptureMode(mode);
        voiceEditBaseTextRef.current = text;
        setVoiceEditProposal(null);
        setAlternateVoiceRerun(null);
      } else {
        voiceCaptureModeRef.current = "dictation";
        setVoiceCaptureMode("dictation");
      }
      toggleRecording();
      deferPendingVoiceStartRelease();
    } catch (error) {
      clearPendingVoiceStart();
      throw error;
    }
  }, [
    clearPendingVoiceStart,
    deferPendingVoiceStartRelease,
    loadPersistedSettings,
    setVoiceError,
    text,
    toggleRecording,
    transcriptionThreadKey,
    transcriptionThreadTitle,
    voiceSupported,
    voiceUnsupportedMessage,
  ]);

  /** Transcribe an audio blob and apply the result based on mode. Used by both initial recording and retry. */
  async function performTranscription(
    blob: Blob,
    mode: "dictation" | "edit" | "append",
    composerText: string,
    cursorContext: { before: string; after: string },
    contextThreadKey?: string,
    contextThreadTitle?: string,
    recordingTiming?: VoiceRecordingTiming,
    source?: "alternate",
  ) {
    const requestId = createVoiceTranscriptionRequestId();
    const startedAt = nowMs();
    const startedAtTimestamp = Date.now();
    const frontendTimingEvents: VoiceTranscriptionFrontendTimingEvent[] = [];
    let clientTiming: VoiceTranscriptionClientTiming | undefined;
    const uiTiming: VoiceTranscriptionUiTiming = {};
    let status: "success" | "error" = "success";
    if (recordingTiming) {
      recordFrontendPerfEntry({
        kind: "voice_recording_timing",
        timestamp: recordingTiming.blobReadyAt,
        sessionId,
        requestId,
        chunkCount: recordingTiming.chunkCount,
        chunkBytes: recordingTiming.chunkBytes,
        blobBytes: recordingTiming.blobBytes,
        ...(recordingTiming.blobMimeType !== undefined ? { blobMimeType: recordingTiming.blobMimeType } : {}),
        ...(recordingTiming.selectedMimeType !== undefined
          ? { selectedMimeType: recordingTiming.selectedMimeType }
          : {}),
        ...(recordingTiming.recorderMimeType !== undefined
          ? { recorderMimeType: recordingTiming.recorderMimeType }
          : {}),
        ...(recordingTiming.recordingDurationMs !== undefined
          ? { recordingDurationMs: recordingTiming.recordingDurationMs }
          : {}),
        ...(recordingTiming.stopToBlobReadyMs !== undefined
          ? { stopToBlobReadyMs: recordingTiming.stopToBlobReadyMs }
          : {}),
        ...(recordingTiming.blobBuildDurationMs !== undefined
          ? { blobBuildDurationMs: recordingTiming.blobBuildDurationMs }
          : {}),
      });
    }
    const recordProgress = (progress: VoiceTranscriptionProgressEvent) => {
      const clientTimestamp = Date.now();
      const elapsedMs = Math.max(0, nowMs() - startedAt);
      frontendTimingEvents.push({
        phase: progress.phase,
        source: progress.source,
        eventTimestamp: progress.timestamp,
        clientTimestamp,
        elapsedMs,
        ...(progress.timing?.uploadDurationMs !== undefined
          ? { uploadDurationMs: progress.timing.uploadDurationMs }
          : {}),
        ...(progress.timing?.sttDurationMs !== undefined ? { sttDurationMs: progress.timing.sttDurationMs } : {}),
        ...(progress.timing?.enhancementDurationMs !== undefined
          ? { enhancementDurationMs: progress.timing.enhancementDurationMs }
          : {}),
        ...(progress.timing?.serverTiming ? { serverTiming: progress.timing.serverTiming } : {}),
      });
      recordFrontendPerfEntry({
        kind: "voice_transcription_progress",
        timestamp: progress.timestamp,
        sessionId,
        requestId: progress.requestId,
        phase: progress.phase,
        source: progress.source,
        elapsedMs,
        ...(progress.mode ? { mode: progress.mode } : {}),
        ...(progress.timing?.audioSizeBytes !== undefined ? { audioSizeBytes: progress.timing.audioSizeBytes } : {}),
        ...(progress.timing?.audioMimeType !== undefined ? { audioMimeType: progress.timing.audioMimeType } : {}),
        ...(progress.timing?.audioFileName !== undefined ? { audioFileName: progress.timing.audioFileName } : {}),
        ...(progress.timing?.uploadDurationMs !== undefined
          ? { uploadDurationMs: progress.timing.uploadDurationMs }
          : {}),
        ...(progress.timing?.sttDurationMs !== undefined ? { sttDurationMs: progress.timing.sttDurationMs } : {}),
        ...(progress.timing?.enhancementDurationMs !== undefined
          ? { enhancementDurationMs: progress.timing.enhancementDurationMs }
          : {}),
      });
    };
    const transcriptionOptions = {
      sessionId,
      threadKey: contextThreadKey,
      threadTitle: contextThreadTitle,
      requestId,
      onPhase: (phase: VoiceTranscriptionPhase) => setTranscriptionPhase(phase),
      onProgress: recordProgress,
      onClientTiming: (timing: VoiceTranscriptionClientTiming) => {
        clientTiming = timing;
      },
    };
    const markApiResolved = () => {
      const apiResolvedAt = Date.now();
      uiTiming.apiResolvedAt = apiResolvedAt;
      uiTiming.apiElapsedMs = Math.max(0, nowMs() - startedAt);
    };
    const applyVoiceResult = (apply: () => void) => {
      const applyStartedAt = Date.now();
      uiTiming.applyStartedAt = applyStartedAt;
      apply();
      const applyCompletedAt = Date.now();
      uiTiming.applyCompletedAt = applyCompletedAt;
      uiTiming.applyDurationMs = applyCompletedAt - applyStartedAt;
    };
    setIsTranscribing(true);
    setTranscriptionPhase("preparing");
    try {
      if (mode === "edit") {
        const {
          text: editedText,
          instructionText,
          rawText,
        } = await api.transcribe(blob, {
          ...transcriptionOptions,
          mode: "edit",
          composerText,
        });
        markApiResolved();
        applyVoiceResult(() => {
          setText(composerText);
          setVoiceEditProposal({
            originalText: composerText,
            editedText,
            instructionText: instructionText || rawText || "",
          });
          setAlternateVoiceRerun({
            resultId: requestId,
            blob,
            sourceMode: "edit",
            composerText,
            cursorContext,
            transcriptionThreadKey: contextThreadKey,
            transcriptionThreadTitle: contextThreadTitle,
            status: "idle",
          });
        });
      } else if (mode === "append") {
        const { text: appendText } = await api.transcribe(blob, {
          ...transcriptionOptions,
          mode: "append",
          composerText,
        });
        markApiResolved();
        const { before, after } = cursorContext;
        const needsSpace = before.length > 0 && !/\s$/.test(before);
        const separator = needsSpace ? " " : "";
        applyVoiceResult(() => {
          setText(before + separator + appendText + after);
          setVoiceEditProposal(null);
          setAlternateVoiceRerun({
            resultId: requestId,
            blob,
            sourceMode: "append",
            composerText,
            cursorContext,
            transcriptionThreadKey: contextThreadKey,
            transcriptionThreadTitle: contextThreadTitle,
            status: "idle",
          });
        });
      } else {
        const { text: transcript } = await api.transcribe(blob, {
          ...transcriptionOptions,
          mode: "dictation",
        });
        markApiResolved();
        applyVoiceResult(() => {
          setText(transcript);
          setVoiceEditProposal(null);
          setAlternateVoiceRerun(null);
        });
      }
    } catch (err) {
      status = "error";
      const message = err instanceof Error ? err.message : "Transcription failed";
      if (source === "alternate") {
        setAlternateVoiceRerun((current) =>
          current?.blob === blob
            ? {
                ...current,
                status: "error",
                message,
              }
            : current,
        );
      } else {
        setVoiceError(message);
        setFailedTranscription({
          blob,
          mode,
          composerText,
          cursorContext,
          transcriptionThreadKey: contextThreadKey,
          transcriptionThreadTitle: contextThreadTitle,
        });
      }
    } finally {
      const completedAt = Date.now();
      const totalElapsedMs = Math.max(0, nowMs() - startedAt);
      setIsTranscribing(false);
      setTranscriptionPhase(null);
      const reportTranscriptionFrontendTiming = api.reportTranscriptionFrontendTiming;
      if (typeof reportTranscriptionFrontendTiming === "function") {
        void afterNextPaint()
          .then((nextPaintAt) => {
            uiTiming.nextPaintAt = nextPaintAt;
            if (uiTiming.applyCompletedAt !== undefined) {
              uiTiming.applyToNextPaintMs = nextPaintAt - uiTiming.applyCompletedAt;
            }
            if (clientTiming) {
              recordFrontendPerfEntry({
                kind: "voice_transcription_client_timing",
                timestamp: clientTiming.resultReturnedAt ?? completedAt,
                sessionId,
                requestId,
                transport: clientTiming.transport,
                requestBodyBytes: clientTiming.requestBodyBytes,
                ...(clientTiming.responseStartDelayMs !== undefined
                  ? { responseStartDelayMs: clientTiming.responseStartDelayMs }
                  : {}),
                ...(clientTiming.firstChunkDelayMs !== undefined
                  ? { firstChunkDelayMs: clientTiming.firstChunkDelayMs }
                  : {}),
                ...(clientTiming.resultStreamDurationMs !== undefined
                  ? { resultStreamDurationMs: clientTiming.resultStreamDurationMs }
                  : {}),
                ...(clientTiming.resultDeliverySource !== undefined
                  ? { resultDeliverySource: clientTiming.resultDeliverySource }
                  : {}),
                ...(clientTiming.webSocketResultAt !== undefined
                  ? { webSocketResultAt: clientTiming.webSocketResultAt }
                  : {}),
                ...(uiTiming.apiElapsedMs !== undefined ? { apiElapsedMs: uiTiming.apiElapsedMs } : {}),
                ...(uiTiming.applyToNextPaintMs !== undefined
                  ? { applyToNextPaintMs: uiTiming.applyToNextPaintMs }
                  : {}),
              });
            }
            return reportTranscriptionFrontendTiming({
              requestId,
              sessionId,
              mode,
              status,
              startedAt: startedAtTimestamp,
              completedAt,
              totalElapsedMs,
              phaseDurationsMs: calculateVoiceTranscriptionPhaseDurations(frontendTimingEvents, totalElapsedMs),
              events: frontendTimingEvents,
              ...(recordingTiming ? { recordingTiming } : {}),
              ...(clientTiming ? { clientTiming } : {}),
              ...(Object.keys(uiTiming).length > 0 ? { uiTiming } : {}),
            });
          })
          .catch(() => undefined);
      }
    }
  }

  const retryTranscription = useCallback(async () => {
    if (!failedTranscription) return;
    const { blob, mode, composerText, cursorContext, transcriptionThreadKey, transcriptionThreadTitle } =
      failedTranscription;
    setFailedTranscription(null);
    setVoiceError(null);
    await performTranscription(
      blob,
      mode,
      composerText,
      cursorContext,
      transcriptionThreadKey,
      transcriptionThreadTitle,
    );
  }, [failedTranscription, sessionId, setVoiceError]);

  const rerunAlternateVoiceMode = useCallback(async () => {
    if (!alternateVoiceRerun || alternateVoiceRerun.status === "running") return;
    const targetMode = alternateVoiceRerun.sourceMode === "edit" ? "append" : "edit";
    setVoiceError(null);
    setFailedTranscription(null);
    setAlternateVoiceRerun({
      ...alternateVoiceRerun,
      status: "running",
      message: undefined,
    });
    await performTranscription(
      alternateVoiceRerun.blob,
      targetMode,
      alternateVoiceRerun.composerText,
      alternateVoiceRerun.cursorContext,
      alternateVoiceRerun.transcriptionThreadKey,
      alternateVoiceRerun.transcriptionThreadTitle,
      undefined,
      "alternate",
    );
  }, [alternateVoiceRerun, setVoiceError]);

  const toggleVoiceUnsupportedInfo = useCallback(
    (expandComposerOnReveal = false) => {
      if (!voiceUnsupportedMessage) return;
      if (expandComposerOnReveal) setComposerExpanded(true);
      setVoiceUnsupportedInfoOpen((open) => !open);
    },
    [voiceUnsupportedMessage],
  );

  const [isNarrowLayout, setIsNarrowLayout] = useState(() => isNarrowComposerLayout(zoomLevel));
  const usesTouchKeyboard = isTouchDevice();
  useEffect(() => {
    const updateLayout = () => setIsNarrowLayout(isNarrowComposerLayout(zoomLevel));
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [zoomLevel]);

  useComposerNavigationFocus({ textareaRef, sessionId, threadKey, usesTouchKeyboard });

  useEffect(() => {
    setVoiceEditProposal(null);
    setFailedTranscription(null);
    setAlternateVoiceRerun(null);
    setVoiceError(null);
    voiceCaptureModeRef.current = "dictation";
    setVoiceCaptureMode("dictation");
    voiceEditBaseTextRef.current = "";
  }, [sessionId, setVoiceError]);

  useEffect(() => {
    if (!voiceError || failedTranscription) return;
    const timer = setTimeout(() => setVoiceError(null), 4000);
    return () => clearTimeout(timer);
  }, [voiceError, failedTranscription, setVoiceError]);

  const sessionView = useComposerSessionView(sessionId);
  const [pauseBusy, setPauseBusy] = useState(false);
  const vscodeSelectionState = useStore((s) => s.vscodeSelectionContext);
  const previewQuestIds = useStore(useShallow((s) => s.quests.map((quest) => quest.questId.toLowerCase())));
  const previewSessionNums = useStore(
    useShallow((s) =>
      s.sdkSessions
        .map((sdkSession) => sdkSession.sessionNum)
        .filter((sessionNum): sessionNum is number => Number.isFinite(sessionNum)),
    ),
  );

  const isConnected = sessionView.isConnected;
  const isBrowserServerConnected = sessionView.browserConnectionStatus === "connected";
  const isRecoverySuppressed =
    sessionView.backendState === "recovery_suppressed" || sessionView.backendState === "broken";
  const canUseInput = !isRecoverySuppressed && !sessionView.isArchived;
  const voiceShortcutIsAvailable = useCallback(
    (actionId: ShortcutActionId) => {
      if (actionId === "voice_start") {
        return (
          !isRecordingRef.current &&
          !isPreparingRef.current &&
          isBrowserServerConnected &&
          canUseInput &&
          !isTranscribing &&
          !voiceEditProposal
        );
      }
      if (actionId === "voice_stop") {
        return isRecordingRef.current;
      }
      return false;
    },
    [canUseInput, isBrowserServerConnected, isTranscribing, voiceEditProposal],
  );

  const runVoiceShortcutAction = useCallback(
    (actionId: ShortcutActionId) => {
      if (!voiceShortcutIsAvailable(actionId)) return false;
      if (actionId === "voice_start" || actionId === "voice_stop") {
        void handleMicClick();
        return true;
      }
      return false;
    },
    [handleMicClick, voiceShortcutIsAvailable],
  );

  const currentMode = sessionView.permissionMode;
  const isCodex = sessionView.backendType === "codex";
  // Prefer the server-provided UI mode when available. permissionMode can be
  // stale during backend transitions (e.g., SDK init/status replay) while uiMode
  // is the authoritative virtual mode for the composer toggle.
  const uiMode = isCodex ? "agent" : (sessionView.serverUiMode ?? deriveUiMode(currentMode));
  const isPlan = uiMode === "plan";
  const codexPermissionMode = deriveCodexPermissionMode(currentMode);
  const claudePermissionMode = normalizeClaudePermission(currentMode);
  const permissionOptions = isCodex ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
  const permissionMode = isCodex ? codexPermissionMode : claudePermissionMode;
  const codexReasoningEffort = sessionView.codexReasoningEffort;
  const codexEffectiveReasoningEffort = sessionView.codexEffectiveReasoningEffort;
  const codexEffectiveReasoningEffortReported = sessionView.codexEffectiveReasoningEffortReported;
  const codexServiceTier = sessionView.codexServiceTier;
  const pauseState = sessionView.pause as SessionPauseState | null;
  const isPaused = !!pauseState?.pausedAt;
  const pausedInputQueueCount = sessionView.pausedInputQueueCount;
  const codexResultErrorAutoPause = sessionView.codexResultErrorAutoPause;
  const codexAutoPauseRecoveryProgress = sessionView.codexAutoPauseRecoveryProgress;
  const codexAutoPausedInputCount = sessionView.codexAutoPausedInputCount;
  const { codexModelOptions, codexFastServiceTier } = useCodexModelOptions({
    isCodex,
    model: sessionView.model,
    codexServiceTier,
    sessionId,
    loadPersistedSettings,
  });
  // Resolve the "Default" option: replace the empty-value placeholder with
  // the user's actual configured model from ~/.claude/settings.json so we
  // never send an empty string to set_model (which would make the model
  // selector disappear since sessionData.model becomes falsy).
  const claudeModelOptions = useMemo(() => {
    return (dynamicClaudeModels || getModelsForBackend("claude")).filter((m) => m.value !== "");
  }, [dynamicClaudeModels]);
  const resetCodexModelSettings = useResetCodexModelSettings({
    sessionId,
    isLeaderSession: sessionView.isLeaderSession,
    model: sessionView.model,
    reasoningEffort: codexReasoningEffort,
    serviceTier: codexServiceTier,
  });
  const sessionSelectionRoot = getVsCodeSelectionSessionRoot(sessionView.repoRoot, sessionView.cwd);
  const dismissedVsCodeSelectionKey = useStore((s) => s.dismissedVsCodeSelectionKey);
  const currentVsCodeSelectionKey = useMemo(
    () => getVsCodeSelectionDismissKey(vscodeSelectionState),
    [vscodeSelectionState],
  );
  const vscodeSelectionPayload: VsCodeSelectionContextPayload | null =
    vscodeSelectionState?.selection && currentVsCodeSelectionKey !== dismissedVsCodeSelectionKey
      ? resolveVsCodeSelectionForSession(vscodeSelectionState.selection, sessionSelectionRoot)
      : null;
  const autocomplete = useComposerAutocomplete({
    text,
    setText,
    textareaRef,
    sessionId,
    threadKey,
    isCodex,
    sessionView,
  });
  const {
    slashMenuOpen,
    filteredCommands,
    menuRef,
    slashMenuIndex,
    selectCommand,
    dollarMenuOpen,
    filteredDollarCommands,
    dollarMenuRef,
    dollarMenuIndex,
    referenceMenuOpen,
    filteredReferenceSuggestions,
    referenceMenuRef,
    referenceMenuIndex,
    referenceKind,
    referenceQuery,
    referenceLoading,
    selectReference,
    mentionMenuOpen,
    mentionResults,
    mentionMenuRef,
    mentionIndex,
    mentionQuery,
    mentionLoading,
    selectMention,
    handleAutocompleteInput,
    handleAutocompleteSelectionChange,
    handleAutocompleteKeyDown,
    closeAutocompleteMenus,
  } = autocomplete;

  useEffect(() => {
    if (isCodex) return;
    let cancelled = false;
    // Fetch dynamic models and the user's configured default in parallel
    Promise.all([
      api.getBackendModels("claude").catch(() => [] as { value: string; label: string; description: string }[]),
      loadPersistedSettings(),
    ]).then(([models, settings]) => {
      if (cancelled) return;
      const options = models.length > 0 ? toModelOptions(models) : [];
      // If the user has a default model configured in ~/.claude/settings.json,
      // prepend a "Default (model)" option that sends the actual model ID
      // instead of an empty string (which would hide the model selector).
      const defaultModel = settings?.claudeDefaultModel;
      if (defaultModel) {
        const defaultOption: ModelOption = {
          value: defaultModel,
          label: `Default (${defaultModel})`,
          icon: "\u25C6",
        };
        // Use dynamic models if available, otherwise fall back to static list
        // (filtered to remove the empty-value "Default" placeholder).
        const baseOptions = options.length > 0 ? options : getModelsForBackend("claude").filter((m) => m.value !== "");
        setDynamicClaudeModels([defaultOption, ...baseOptions]);
      } else if (options.length > 0) {
        setDynamicClaudeModels(options);
      }
      // If neither dynamic models nor default model are available,
      // dynamicClaudeModels stays null and the static fallback is used.
    });
    return () => {
      cancelled = true;
    };
  }, [isCodex, loadPersistedSettings]);

  // Close mode dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (permissionDropdownRef.current && !permissionDropdownRef.current.contains(e.target as Node)) {
        setShowPermissionDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  const acceptVoiceEdit = useCallback(() => {
    if (!voiceEditProposal) return;
    setText(voiceEditProposal.editedText);
    setVoiceEditProposal(null);
    setAlternateVoiceRerun(null);
    textareaRef.current?.focus();
  }, [setText, voiceEditProposal]);

  const undoVoiceEdit = useCallback(() => {
    if (!voiceEditProposal) return;
    setText(voiceEditProposal.originalText);
    setVoiceEditProposal(null);
    setAlternateVoiceRerun(null);
    textareaRef.current?.focus();
  }, [setText, voiceEditProposal]);

  const handleTogglePause = useCallback(async () => {
    if (pauseBusy) return;
    setPauseBusy(true);
    try {
      if (isPaused) {
        await api.unpauseSession(sessionId);
      } else {
        await api.pauseSession(sessionId);
      }
    } catch (err) {
      console.error("[composer] failed to toggle pause:", err);
    } finally {
      setPauseBusy(false);
    }
  }, [isPaused, pauseBusy, sessionId]);

  async function handleSend() {
    const store = useStore.getState();
    const msg = text.trim();
    if (
      (!msg && images.length === 0 && !annotations?.length) ||
      !canUseInput ||
      voiceEditProposal ||
      annotationEditorOpen ||
      !allImagesReady
    )
      return;

    // Auto-answer pending AskUserQuestion if user types a response.
    // The typed text becomes the "Other..." answer for each question.
    // No separate user_message is sent — the answer IS the user's message.
    if (pendingAskUserPerm) {
      const questions = Array.isArray(pendingAskUserPerm.input?.questions)
        ? (pendingAskUserPerm.input.questions as Record<string, unknown>[])
        : [];
      const answers: Record<string, string> = {};
      for (let i = 0; i < Math.max(1, questions.length); i++) {
        answers[String(i)] = formatAnnotatedMessage(msg, annotations);
      }
      sendToSession(sessionId, {
        type: "permission_response",
        request_id: pendingAskUserPerm.request_id,
        ...(annotations?.length ? { annotationMessage: { content: msg, annotations } } : {}),
        behavior: "allow",
        updated_input: { ...pendingAskUserPerm.input, answers },
      });
      store.removePermission(sessionId, pendingAskUserPerm.request_id);
      store.clearComposerDraft(sessionId);
      setComposerExpanded(false);
      setAlternateVoiceRerun(null);
      closeAutocompleteMenus();
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (isTouchDevice()) textareaRef.current?.blur();
      else textareaRef.current?.focus();
      return;
    }

    // Auto-reject pending plan if user sends a message while plan is pending.
    // This matches Claude Code vanilla behavior: typing a new message rejects
    // the plan and sends the new instructions as a fresh turn.
    if (pendingPlanPerm) {
      sendToSession(sessionId, {
        type: "permission_response",
        request_id: pendingPlanPerm.request_id,
        behavior: "deny",
        message: "Plan rejected — user sent a new message",
      });
      store.removePermission(sessionId, pendingPlanPerm.request_id);
    }

    // Codex local slash shortcuts for mode switching.
    // These must not be sent as normal user turns.
    if (isCodex && !annotations?.length && images.length === 0) {
      const targetMode = parseCodexModeSlashCommand(msg);
      if (targetMode) {
        const switched = sendToSession(sessionId, {
          type: "set_permission_mode",
          mode: resolveCodexPermissionCliMode(targetMode.permissionMode),
        });
        if (!switched) return;
        store.clearComposerDraft(sessionId);
        setComposerExpanded(false);
        setAlternateVoiceRerun(null);
        closeAutocompleteMenus();
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        if (isTouchDevice()) textareaRef.current?.blur();
        else textareaRef.current?.focus();
        return;
      }
    }

    // Keep reply metadata separate from stored user text; send concise context to the assistant.
    const currentReplyContext = useStore.getState().replyContexts.get(sessionId);
    const clearComposerUi = () => {
      setComposerExpanded(false);
      closeAutocompleteMenus();
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      if (isTouchDevice()) {
        textareaRef.current?.blur();
      } else {
        textareaRef.current?.focus();
      }

      setSendPressing(true);
      if (sendPressingTimerRef.current) clearTimeout(sendPressingTimerRef.current);
      sendPressingTimerRef.current = setTimeout(() => {
        sendPressingTimerRef.current = null;
        setSendPressing(false);
      }, 500);
    };

    const finalizeReplyNotification = () => {
      if (!currentReplyContext?.messageId && !currentReplyContext?.notificationId) return;
      const notifications = useStore.getState().sessionNotifications?.get(sessionId);
      const notif = currentReplyContext.notificationId
        ? notifications?.find((n) => n.id === currentReplyContext.notificationId && !n.done)
        : notifications?.find((n) => n.messageId === currentReplyContext.messageId && !n.done);
      if (notif) {
        api.markNotificationDone(sessionId, notif.id, true).catch(() => {});
      }
    };

    const result = sendComposerDraft(
      sessionId,
      { text, images, annotations },
      {
        threadKey,
        questId,
        vscodeSelection: vscodeSelectionPayload ?? undefined,
      },
      isCodex,
    );
    if (result === "failed") return;
    setAlternateVoiceRerun(null);
    if (result === "sent") finalizeReplyNotification();
    clearComposerUi();
  }

  // Voice recording keyboard shortcuts:
  // - Configured start action: starts recording
  // - Configured stop action: finishes recording and transcribes
  // - Escape: fixed cancel shortcut while recording/preparing
  useEffect(() => {
    if (!voiceSupported) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (useStore.getState().annotationEditor?.sessionId === sessionId) return;
      if (e.key === "Escape" && (isRecording || isPreparing)) {
        e.preventDefault();
        cancelRecording();
        clearVoiceShortcutTap();
        return;
      }

      const comboAction = getMatchingShortcutAction(shortcutSettings, e, {
        actionIds: VOICE_SHORTCUT_ACTIONS,
        isActionAvailable: voiceShortcutIsAvailable,
      });
      if (comboAction) {
        if (runVoiceShortcutAction(comboAction)) {
          e.preventDefault();
          e.stopPropagation();
          clearVoiceShortcutTap();
        }
        return;
      }

      if (e.repeat) return;
      if (voiceShortcutTapCandidateRef.current && voiceShortcutTapCandidateRef.current !== e.key) {
        clearVoiceShortcutTap();
        return;
      }
      if (eventUsesComboModifier(e) || (!isModifierOnlyKey(e.key) && e.key.length !== 1)) {
        voiceShortcutTapCandidateRef.current = null;
        voiceShortcutLastTapRef.current = null;
        return;
      }
      voiceShortcutTapCandidateRef.current = e.key;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (voiceShortcutTapCandidateRef.current !== e.key) return;
      voiceShortcutTapCandidateRef.current = null;
      const now = Date.now();

      const doubleTapAction = getMatchingShortcutTapAction(shortcutSettings, e.key, 2, {
        actionIds: VOICE_SHORTCUT_ACTIONS,
        isActionAvailable: voiceShortcutIsAvailable,
      });
      const singleTapAction = getMatchingShortcutTapAction(shortcutSettings, e.key, 1, {
        actionIds: VOICE_SHORTCUT_ACTIONS,
        isActionAvailable: voiceShortcutIsAvailable,
      });
      const previousTap = voiceShortcutLastTapRef.current;
      if (previousTap?.key === e.key && now - previousTap.time < SHORTCUT_DOUBLE_TAP_WINDOW_MS) {
        clearVoiceShortcutTap();
        if (doubleTapAction && runVoiceShortcutAction(doubleTapAction)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      if (singleTapAction && !doubleTapAction) {
        if (runVoiceShortcutAction(singleTapAction)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      voiceShortcutLastTapRef.current = { key: e.key, time: now };
      if (voiceShortcutTapTimerRef.current) clearTimeout(voiceShortcutTapTimerRef.current);
      voiceShortcutTapTimerRef.current = setTimeout(() => {
        voiceShortcutTapTimerRef.current = null;
        const action = getMatchingShortcutTapAction(shortcutSettings, e.key, 1, {
          actionIds: VOICE_SHORTCUT_ACTIONS,
          isActionAvailable: voiceShortcutIsAvailable,
        });
        voiceShortcutLastTapRef.current = null;
        if (action) void runVoiceShortcutAction(action);
      }, SHORTCUT_DOUBLE_TAP_WINDOW_MS);

      if (doubleTapAction === "voice_start") {
        warmMicrophone();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      clearVoiceShortcutTap();
    };
  }, [
    cancelRecording,
    clearVoiceShortcutTap,
    voiceSupported,
    isRecording,
    isPreparing,
    shortcutSettings,
    runVoiceShortcutAction,
    voiceShortcutIsAvailable,
    warmMicrophone,
  ]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (handleAutocompleteKeyDown(e)) return;

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      return;
    }
    // Desktop: Enter sends, Shift+Enter inserts newline.
    // Mobile: Enter always inserts newline (users tap the Send button).
    // Skip during IME composition (e.g. CJK input) -- Enter confirms the
    // candidate character, not a send intent. keyCode 229 covers older browsers.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !usesTouchKeyboard &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newText = e.target.value;
    const cursorPos = e.target.selectionStart;
    if (voiceEditProposal) {
      setVoiceEditProposal(null);
    }
    if (alternateVoiceRerun) {
      setAlternateVoiceRerun(null);
    }
    setText(newText);
    handleAutocompleteInput(newText, cursorPos);
  }

  function handleSelectionChange(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    handleAutocompleteSelectionChange(e);
  }

  function handleInterrupt() {
    sendToSession(sessionId, { type: "interrupt" });
  }

  const startImagePreparation = useCallback(
    async (image: ComposerDraftImage) => {
      const uploadController = new AbortController();
      registerPendingUserUploadController(image.id, uploadController);
      try {
        const prepared = await api.prepareUserMessageImages(
          sessionId,
          [{ mediaType: image.mediaType, data: image.base64, filename: image.name }],
          uploadController.signal,
        );
        const imageRef = prepared.imageRefs[0];
        const path = prepared.paths[0];
        if (!imageRef || !path) {
          throw new Error("Image preparation returned incomplete metadata");
        }
        setImages((prev) =>
          prev.map((current) =>
            current.id === image.id
              ? {
                  ...current,
                  status: "ready",
                  error: undefined,
                  prepared: { imageRef, path },
                }
              : current,
          ),
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : "Image upload failed";
        setImages((prev) =>
          prev.map((current) =>
            current.id === image.id
              ? {
                  ...current,
                  status: "failed",
                  error: message,
                  prepared: undefined,
                }
              : current,
          ),
        );
      } finally {
        clearPendingUserUploadController(image.id);
        startedImageUploadsRef.current.delete(image.id);
      }
    },
    [sessionId, setImages],
  );

  const cleanupPreparedImage = useCallback(
    async (image: ComposerDraftImage) => {
      const imageId = image.prepared?.imageRef.imageId;
      if (!imageId) return;
      try {
        await api.deletePreparedUserMessageImage(sessionId, imageId);
      } catch (err) {
        console.error("Failed to clean up prepared image:", err);
      }
    },
    [sessionId],
  );

  const readDraftImageFile = useCallback(
    async (imageId: string, file: File) => {
      try {
        const raw = await readFileAsBase64(file);
        const { base64, mediaType } = await ensureSupportedFormat(raw.base64, raw.mediaType);
        draftImageSourceFilesRef.current.delete(imageId);
        setImages((prev) =>
          prev.map((image) =>
            image.id === imageId
              ? {
                  ...image,
                  base64,
                  mediaType,
                  status: "uploading",
                  error: undefined,
                }
              : image,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Image read failed";
        setImages((prev) =>
          prev.map((image) =>
            image.id === imageId
              ? {
                  ...image,
                  status: "failed",
                  error: message,
                  prepared: undefined,
                }
              : image,
          ),
        );
      }
    },
    [setImages],
  );

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    await appendImages(getImageFiles(e.target.files));
    e.target.value = "";
  }

  function removeImage(index: number) {
    const target = images[index];
    if (target) {
      abortPendingUserUpload(target.id);
      startedImageUploadsRef.current.delete(target.id);
      draftImageSourceFilesRef.current.delete(target.id);
      void cleanupPreparedImage(target);
    }
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function retryImage(imageId: string) {
    const target = images.find((image) => image.id === imageId);
    const sourceFile = draftImageSourceFilesRef.current.get(imageId);
    abortPendingUserUpload(imageId);
    startedImageUploadsRef.current.delete(imageId);
    if (target) {
      await cleanupPreparedImage(target);
    }
    if (sourceFile) {
      setImages((prev) =>
        prev.map((image) =>
          image.id === imageId
            ? {
                ...image,
                status: "reading",
                error: undefined,
                prepared: undefined,
              }
            : image,
        ),
      );
      void readDraftImageFile(imageId, sourceFile);
      return;
    }
    if (target?.base64) {
      const retryingImage: ComposerDraftImage = {
        ...target,
        status: "uploading",
        error: undefined,
        prepared: undefined,
      };
      setImages((prev) =>
        prev.map((image) =>
          image.id === imageId
            ? {
                ...retryingImage,
              }
            : image,
        ),
      );
      startedImageUploadsRef.current.add(imageId);
      void startImagePreparation(retryingImage);
      return;
    }
    setImages((prev) =>
      prev.map((image) =>
        image.id === imageId
          ? {
              ...image,
              status: "failed",
              error: "Original file is no longer available for retry.",
              prepared: undefined,
            }
          : image,
      ),
    );
  }

  async function appendImages(files: File[], buildName?: (file: File, index: number) => string) {
    if (files.length === 0) return;
    const newImages = files.map((file, index) =>
      createComposerDraftImage(
        {
          name: buildName?.(file, index) ?? file.name,
          base64: "",
          mediaType: file.type || "image/png",
        },
        { status: "reading" },
      ),
    );
    newImages.forEach((image, index) => {
      const file = files[index];
      if (file) {
        draftImageSourceFilesRef.current.set(image.id, file);
      }
    });
    setImages((prev) => [...prev, ...newImages]);

    await Promise.all(
      files.map(async (file, index) => {
        const draftImage = newImages[index];
        if (!draftImage) return;
        await readDraftImageFile(draftImage.id, file);
      }),
    );
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const files = getPastedImageFiles(e);
    if (files.length === 0) return;
    e.preventDefault();
    const pasteTs = Date.now();
    await appendImages(
      files,
      (_file, index) => `pasted-${pasteTs}-${index}.${files[index].type.split("/")[1] || "jpeg"}`,
    );
  }

  function resetImageDragState() {
    imageDragDepthRef.current = 0;
    setIsImageDragOver(false);
  }

  function handleComposerDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    imageDragDepthRef.current += 1;
    setIsImageDragOver(true);
  }

  function handleComposerDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!isImageDragOver) setIsImageDragOver(true);
  }

  function handleComposerDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isImageDragOver) return;
    e.preventDefault();
    e.stopPropagation();
    imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1);
    if (imageDragDepthRef.current === 0) {
      setIsImageDragOver(false);
    }
  }

  async function handleComposerDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = getImageFiles(e.dataTransfer?.files);
    if (files.length === 0) {
      resetImageDragState();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    resetImageDragState();
    await appendImages(files);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    images.forEach((image) => {
      if (
        image.status !== "uploading" ||
        image.prepared ||
        !image.base64 ||
        startedImageUploadsRef.current.has(image.id)
      ) {
        return;
      }
      startedImageUploadsRef.current.add(image.id);
      void startImagePreparation(image);
    });
  }, [images, startImagePreparation]);

  function confirmPermissionChange() {
    if (!pendingPermissionMode) return;
    const mode = isCodex
      ? resolveCodexPermissionCliMode(pendingPermissionMode as CodexPermissionMode)
      : resolveClaudePermissionCliMode(pendingPermissionMode as ClaudePermissionMode);
    sendToSession(sessionId, {
      type: "set_permission_mode",
      mode,
    });
    setPendingPermissionMode(null);
    setShowPermissionDropdown(false);
  }

  // Detect pending ExitPlanMode permission for auto-reject and ghost text
  const pendingPlanPerm = useStore((s) => {
    const permsMap = s.pendingPermissions.get(sessionId);
    if (!permsMap) return null;
    for (const perm of permsMap.values()) {
      if (perm.tool_name === "ExitPlanMode") return perm;
    }
    return null;
  });

  // Detect pending AskUserQuestion permission — typing a message answers it
  const pendingAskUserPerm = useStore((s) => {
    const permsMap = s.pendingPermissions.get(sessionId);
    if (!permsMap) return null;
    for (const perm of permsMap.values()) {
      if (perm.tool_name === "AskUserQuestion") return perm;
    }
    return null;
  });

  const isRunning = useStore((s) => s.sessionStatus.get(sessionId) === "running");
  const readingImageCount = images.filter((image) => image.status === "reading").length;
  const uploadingImageCount = images.filter((image) => image.status === "uploading").length;
  const failedImageCount = images.filter((image) => image.status === "failed").length;
  const readyImageCount = images.filter((image) => image.status === "ready" && image.prepared).length;
  const allImagesReady = images.length === readyImageCount;
  const attachmentBlockReason =
    readingImageCount > 0
      ? `Preparing ${readingImageCount} image${readingImageCount === 1 ? "" : "s"} before upload.`
      : uploadingImageCount > 0
        ? `${uploadingImageCount} image${uploadingImageCount === 1 ? "" : "s"} still uploading.`
        : failedImageCount > 0
          ? `Remove or retry ${failedImageCount} failed image${failedImageCount === 1 ? "" : "s"} before sending.`
          : null;
  const canSend =
    (text.trim().length > 0 || images.length > 0 || !!annotations?.length) &&
    canUseInput &&
    !voiceEditProposal &&
    !annotationEditorOpen &&
    allImagesReady;
  const isVoiceInteractionActive = isPreparing || isRecording || isTranscribing;
  const hasActiveReplyContext = !!replyContext;
  const placeholder = buildComposerPlaceholder({
    isCodex,
    isLeaderSession: sessionView.isLeaderSession,
    threadKey,
    usesTouchKeyboard,
    isNarrowLayout,
    pendingAskUserPerm,
    pendingPlanPerm,
  });

  // Mobile collapsible composer — keep voice capture visible even when the draft is empty.
  const isCollapsed =
    usesTouchKeyboard &&
    isNarrowLayout &&
    !composerExpanded &&
    !hasActiveReplyContext &&
    !isVoiceInteractionActive &&
    !text.trim() &&
    images.length === 0 &&
    !annotations?.length &&
    !annotationEditorOpen;

  // Replying should immediately reveal the full composer on mobile so the
  // reply target context stays visible instead of falling back to the compact bar.
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout || !hasActiveReplyContext) return;
    setComposerExpanded(true);
  }, [usesTouchKeyboard, isNarrowLayout, hasActiveReplyContext]);

  // Clearing a reply or finishing voice releases its expansion lock. Empty drafts and navigation
  // do not schedule a collapse; successful sends explicitly collapse their own composer.
  const previousInteraction = useRef(hasActiveReplyContext || isVoiceInteractionActive);
  useEffect(() => {
    const wasActive = previousInteraction.current;
    previousInteraction.current = hasActiveReplyContext || isVoiceInteractionActive;
    if (!wasActive || previousInteraction.current || !usesTouchKeyboard || !isNarrowLayout) return;
    if (isVoiceInteractionActive || text.trim() || images.length || annotations?.length || annotationEditorOpen) return;
    const timer = setTimeout(() => setComposerExpanded(false), 300);
    return () => clearTimeout(timer);
  }, [
    hasActiveReplyContext,
    usesTouchKeyboard,
    isNarrowLayout,
    isVoiceInteractionActive,
    text,
    images.length,
    annotations?.length,
    annotationEditorOpen,
    threadKey,
  ]);

  // Tapping the conversation can collapse an empty composer; navigation controls cannot.
  const composerRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout || isCollapsed || isVoiceInteractionActive || hasActiveReplyContext)
      return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("[data-feed-session-id]")?.getAttribute("data-feed-session-id") === sessionId &&
        !hasActiveReplyContext &&
        !isVoiceInteractionActive &&
        !text.trim() &&
        images.length === 0 &&
        composerRootRef.current &&
        !composerRootRef.current.contains(e.target as Node)
      ) {
        setComposerExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [
    usesTouchKeyboard,
    isNarrowLayout,
    isCollapsed,
    hasActiveReplyContext,
    isVoiceInteractionActive,
    text,
    images.length,
    sessionId,
  ]);

  const expandComposer = useCallback(() => {
    textareaRef.current?.focus(); // synchronous focus triggers mobile virtual keyboard
    setComposerExpanded(true);
  }, []);

  const imageSrcs = useMemo(
    () =>
      images.map((img) => ({
        id: img.id,
        src: img.base64 ? `data:${img.mediaType};base64,${img.base64}` : null,
        name: img.name,
        status: img.status,
        error: img.error,
      })),
    [images],
  );
  const voiceUnsupportedTooltip =
    voiceUnsupportedReason === "insecure-context" ? "Voice needs HTTPS" : "Voice unavailable";
  const voiceIdleTitle = text.trim().length > 0 ? "Voice edit" : "Voice input";
  const voiceButtonTitle =
    (!voiceSupported ? voiceUnsupportedTooltip : voiceError) ||
    (!isBrowserServerConnected
      ? "Reconnect to Takode server to use voice input"
      : !canUseInput
        ? "Resume session to use voice input"
        : isPreparing
          ? "Preparing microphone..."
          : isTranscribing
            ? transcriptionPhase === "preparing"
              ? "Preparing transcript..."
              : transcriptionPhase === "editing"
                ? "Editing..."
                : transcriptionPhase === "appending"
                  ? "Appending..."
                  : transcriptionPhase === "finalizing"
                    ? "Finalizing..."
                    : transcriptionPhase === "enhancing"
                      ? "Enhancing..."
                      : "Transcribing..."
            : isRecording
              ? "Stop recording"
              : voiceEditProposal
                ? "Accept or undo the voice edit first"
                : voiceIdleTitle);
  const voiceButtonDisabled =
    !isBrowserServerConnected ||
    !canUseInput ||
    isTranscribing ||
    isPreparing ||
    !!voiceEditProposal ||
    annotationEditorOpen;
  const compactVoiceButtonDisabled = voiceButtonDisabled;
  const imageUploadDisabled = !isBrowserServerConnected || !canUseInput;
  const imageUploadTitle = !isBrowserServerConnected
    ? "Reconnect to Takode server to upload images"
    : !canUseInput
      ? "Resume session to upload images"
      : "Upload image";
  const sendButtonShortcutTitle = usesTouchKeyboard
    ? "Send: tap button; New line: Enter"
    : "Send: Enter; New line: Shift+Enter";
  const sendButtonTitle = attachmentBlockReason ?? (canSend ? sendButtonShortcutTitle : "Send message");
  const plainReferencePreviews = useMemo(() => {
    const questIds = new Set(previewQuestIds);
    const sessionNums = new Set(previewSessionNums);

    return collectPlainTakodeReferences(text).filter((reference) =>
      reference.kind === "quest"
        ? questIds.has(reference.questId.toLowerCase())
        : sessionNums.has(reference.sessionNum),
    );
  }, [previewQuestIds, previewSessionNums, text]);

  useEffect(() => {
    if (voiceSupported || isRecording || isTranscribing) {
      setVoiceUnsupportedInfoOpen(false);
    }
  }, [voiceSupported, isRecording, isTranscribing]);

  if (sessionView.isArchived) {
    return (
      <div className="shrink-0 border-t border-cc-border bg-cc-card px-4 py-3" data-testid="archived-readonly-composer">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 rounded-[14px] border border-cc-border bg-cc-input-bg px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className="font-medium text-cc-fg">Archived session is read-only.</span>
          <span className="text-xs text-cc-muted">Unarchive to resume live input.</span>
        </div>
      </div>
    );
  }

  return (
    <ComposerMinimizer
      destination={`${sessionId}:${threadKey}`}
      canMinimize={!isCollapsed}
      reveal={isVoiceInteractionActive || annotationEditorOpen}
      onRestore={expandComposer}
    >
      <div
        ref={composerRootRef}
        className={`shrink-0 border-t border-cc-border bg-cc-card ${isCollapsed ? "" : "px-2 sm:px-4 py-2 sm:py-3"}`}
      >
        <CollapsedComposerBar
          isCollapsed={isCollapsed}
          expandComposer={expandComposer}
          onVoiceButton={() => {
            if (!voiceSupported) {
              toggleVoiceUnsupportedInfo(true);
              return;
            }
            setComposerExpanded(true);
            handleMicClick();
          }}
          onOpenFilePicker={() => fileInputRef.current?.click()}
          imageUploadDisabled={imageUploadDisabled}
          imageUploadTitle={imageUploadTitle}
          compactVoiceButtonDisabled={compactVoiceButtonDisabled}
          voiceSupported={voiceSupported}
          isPreparing={isPreparing}
          isRecording={isRecording}
          voiceButtonTitle={voiceButtonTitle}
          isRunning={isRunning}
          onStop={handleInterrupt}
        />
        <div className={isCollapsed ? "h-0 overflow-hidden" : ""}>
          <ComposerInputSurface
            imageSrcs={imageSrcs}
            lightboxSrc={lightboxSrc}
            setLightboxSrc={setLightboxSrc}
            removeImage={removeImage}
            retryImage={retryImage}
            fileInputRef={fileInputRef}
            handleFileSelect={handleFileSelect}
            handleComposerDragEnter={handleComposerDragEnter}
            handleComposerDragOver={handleComposerDragOver}
            handleComposerDragLeave={handleComposerDragLeave}
            handleComposerDrop={handleComposerDrop}
            isImageDragOver={isImageDragOver}
            isPlan={isPlan}
            textareaRef={textareaRef}
            text={text}
            handleInput={handleInput}
            handleSelectionChange={handleSelectionChange}
            handleKeyDown={handleKeyDown}
            handlePaste={handlePaste}
            placeholder={placeholder}
            isRecording={isRecording}
            recordingCursorBefore={preRecordingTextRef.current.before}
            recordingCursorAfter={preRecordingTextRef.current.after}
            topChildren={
              <>
                <ComposerMenus
                  slashMenuOpen={slashMenuOpen}
                  filteredCommands={filteredCommands}
                  menuRef={menuRef}
                  slashMenuIndex={slashMenuIndex}
                  selectCommand={selectCommand}
                  dollarMenuOpen={dollarMenuOpen}
                  filteredDollarCommands={filteredDollarCommands}
                  dollarMenuRef={dollarMenuRef}
                  dollarMenuIndex={dollarMenuIndex}
                  referenceMenuOpen={referenceMenuOpen}
                  filteredReferenceSuggestions={filteredReferenceSuggestions}
                  referenceMenuRef={referenceMenuRef}
                  referenceMenuIndex={referenceMenuIndex}
                  referenceKind={referenceKind}
                  referenceQuery={referenceQuery}
                  referenceLoading={referenceLoading}
                  selectReference={selectReference}
                  mentionMenuOpen={mentionMenuOpen}
                  mentionResults={mentionResults}
                  mentionMenuRef={mentionMenuRef}
                  mentionIndex={mentionIndex}
                  mentionQuery={mentionQuery}
                  mentionLoading={mentionLoading}
                  selectMention={selectMention}
                />

                <ComposerStatusBlocks
                  isPreparing={isPreparing}
                  isRecording={isRecording}
                  isTranscribing={isTranscribing}
                  transcriptionPhase={transcriptionPhase}
                  volumeLevel={volumeLevel}
                  volumeHistory={volumeHistory}
                  voiceCaptureMode={voiceCaptureMode}
                  voiceUnsupportedInfoOpen={voiceUnsupportedInfoOpen}
                  voiceUnsupportedMessage={voiceUnsupportedMessage}
                  voiceError={voiceError}
                  failedTranscription={failedTranscription}
                  voiceEditProposal={voiceEditProposal}
                  alternateVoiceRerun={alternateVoiceRerun}
                  replyContext={replyContext ?? null}
                  vscodeSelectionLabel={
                    vscodeSelectionPayload ? formatVsCodeSelectionAttachmentLabel(vscodeSelectionPayload) : null
                  }
                  vscodeSelectionSummary={
                    vscodeSelectionPayload ? formatVsCodeSelectionSummary(vscodeSelectionPayload) : null
                  }
                  vscodeSelectionTitle={
                    vscodeSelectionPayload ? buildVsCodeSelectionPrompt(vscodeSelectionPayload) : null
                  }
                  onRetryTranscription={retryTranscription}
                  onDismissVoiceError={() => {
                    setFailedTranscription(null);
                    setVoiceError(null);
                  }}
                  onAcceptVoiceEdit={acceptVoiceEdit}
                  onUndoVoiceEdit={undoVoiceEdit}
                  onRerunAlternateVoiceMode={rerunAlternateVoiceMode}
                  onDismissUnsupportedInfo={() => setVoiceUnsupportedInfoOpen(false)}
                  onDismissReply={() => useStore.getState().setReplyContext(sessionId, null)}
                  onDismissVsCodeSelection={() => useStore.getState().dismissVsCodeSelection(currentVsCodeSelectionKey)}
                  onSetVoiceModeEdit={() => {
                    voiceCaptureModeRef.current = "edit";
                    setVoiceCaptureMode("edit");
                    persistPreferredVoiceMode("edit");
                  }}
                  onSetVoiceModeAppend={() => {
                    voiceCaptureModeRef.current = "append";
                    setVoiceCaptureMode("append");
                    persistPreferredVoiceMode("append");
                  }}
                />
                <PausedInputChip
                  pause={pauseState}
                  autoPause={codexResultErrorAutoPause}
                  autoPauseRecoveryProgress={codexAutoPauseRecoveryProgress}
                  heldCount={pausedInputQueueCount}
                  autoPausedHeldCount={codexAutoPausedInputCount}
                  directComposerMessagesSend={isConnected}
                  onReleaseAutoPausedInputs={(pausedAt) =>
                    sendToSession(sessionId, { type: "release_codex_auto_paused_inputs", pausedAt })
                  }
                />
                <ComposerAnnotations
                  sessionId={sessionId}
                  threadKey={transcriptionThreadKey ?? threadKey}
                  threadTitle={transcriptionThreadTitle}
                  disabled={!canUseInput}
                />
                <ComposerReferencePreview references={plainReferencePreviews} />
              </>
            }
            bottomChildren={
              <>
                <ComposerMetaToolbar
                  sessionId={sessionId}
                  sessionView={sessionView}
                  isCodex={isCodex}
                  isConnected={isConnected}
                  canEditLaunchSettings={isBrowserServerConnected}
                  imageUploadDisabled={imageUploadDisabled}
                  imageUploadTitle={imageUploadTitle}
                  showModelDropdown={showModelDropdown}
                  setShowModelDropdown={setShowModelDropdown}
                  modelDropdownRef={modelDropdownRef}
                  claudeModelOptions={claudeModelOptions}
                  codexModelOptions={codexModelOptions}
                  onSelectModel={(model) => sendToSession(sessionId, { type: "set_model", model })}
                  codexReasoningEffort={codexReasoningEffort}
                  codexEffectiveReasoningEffort={codexEffectiveReasoningEffort}
                  codexEffectiveReasoningEffortReported={codexEffectiveReasoningEffortReported}
                  onSelectCodexReasoning={(effort) =>
                    sendToSession(sessionId, { type: "set_codex_reasoning_effort", effort })
                  }
                  codexServiceTier={codexServiceTier}
                  codexFastServiceTier={codexFastServiceTier}
                  onSelectCodexServiceTier={(serviceTier) =>
                    sendToSession(sessionId, { type: "set_codex_service_tier", serviceTier })
                  }
                  onResetCodexSettings={resetCodexModelSettings}
                  permissionOptions={permissionOptions}
                  permissionMode={permissionMode}
                  showPermissionDropdown={showPermissionDropdown}
                  setShowPermissionDropdown={setShowPermissionDropdown}
                  permissionDropdownRef={permissionDropdownRef}
                  pendingPermissionMode={pendingPermissionMode}
                  onRequestPermissionMode={(mode) => {
                    if (mode === permissionMode) {
                      setShowPermissionDropdown(false);
                      return;
                    }
                    setPendingPermissionMode(mode);
                    setShowPermissionDropdown(false);
                  }}
                  onCancelPermissionMode={() => setPendingPermissionMode(null)}
                  onConfirmPermissionMode={confirmPermissionChange}
                  collapseAllButton={<CollapseAllButton sessionId={sessionId} />}
                  pauseControl={
                    <PauseOtherSourcesButton
                      isPaused={isPaused}
                      heldCount={pausedInputQueueCount}
                      busy={pauseBusy}
                      directComposerMessagesSend={isConnected}
                      onToggle={handleTogglePause}
                    />
                  }
                  onOpenFilePicker={() => fileInputRef.current?.click()}
                  warmMicrophone={warmMicrophone}
                  voiceSupported={voiceSupported}
                  toggleVoiceUnsupportedInfo={toggleVoiceUnsupportedInfo}
                  handleMicClick={handleMicClick}
                  voiceButtonDisabled={voiceButtonDisabled}
                  isPreparing={isPreparing}
                  isRecording={isRecording}
                  voiceButtonTitle={voiceButtonTitle}
                  canSend={canSend}
                  isRunning={isRunning}
                  handleInterrupt={handleInterrupt}
                  handleSend={handleSend}
                  sendButtonTitle={sendButtonTitle}
                  sendPressing={sendPressing}
                />
              </>
            }
          />
        </div>
      </div>
    </ComposerMinimizer>
  );
}
