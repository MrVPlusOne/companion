import { VoiceInputIcon } from "./VoiceInputIcon.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationAnnotation } from "../../shared/conversation-annotations.js";
import { buildAnnotationVoiceReference, type AnnotationVoiceContext } from "../../shared/annotation-voice-context.js";
import { api } from "../api.js";
import { useVoiceInput } from "../hooks/useVoiceInput.js";
import { createVoiceTranscriptionRequestId } from "./composer-voice-transcription-utils.js";
import { VoiceRecordingStatus } from "./VoiceRecordingStatus.js";

type VoiceMode = "dictation" | "append" | "edit";
interface Capture {
  mode: VoiceMode;
  base: string;
  start: number;
  end: number;
  context: AnnotationVoiceContext;
  blob?: Blob;
}

/** Edit one attachment. A recording owns an immutable target and reference snapshot. */
export function AnnotationEditor({
  annotation,
  context,
  sessionId,
  threadKey,
  threadTitle,
  position,
  sourceUnavailable,
  onSave,
  onCancel,
  onRemove,
}: {
  annotation: ConversationAnnotation;
  context: AnnotationVoiceContext;
  sessionId: string;
  threadKey: string;
  threadTitle?: string;
  position?: { x: number; y: number };
  sourceUnavailable?: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const [text, setText] = useState(annotation.comment);
  const [mode, setMode] = useState<"append" | "edit">("append");
  const [proposal, setProposal] = useState<{ before: string; after: string } | null>(null);
  const [failed, setFailed] = useState<Capture | null>(null);
  const [alternate, setAlternate] = useState<Capture | null>(null);
  const [hideAlternate, setHideAlternate] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);
  const currentText = useRef(text);
  currentText.current = text;
  const voice = useVoiceInput({
    onAudioReady: (blob) => {
      if (capture.current) void transcribe({ ...capture.current, blob });
    },
  });
  const busy = voice.isRecording || voice.isPreparing || voice.isTranscribing;
  const hint = buildAnnotationVoiceReference(context, text);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    textarea.current?.focus({ preventScroll: true });
    return () => {
      generation.current++;
      capture.current = null;
      previous?.focus({ preventScroll: true });
    };
  }, []);

  function changeText(value: string) {
    generation.current++;
    setText(value);
    setFailed(null);
    setAlternate(null);
    setProposal(null);
    voice.setError(null);
  }

  async function transcribe(snapshot: Capture) {
    if (!snapshot.blob) return;
    const requestGeneration = ++generation.current;
    voice.setIsTranscribing(true);
    voice.setTranscriptionPhase("preparing");
    voice.setError(null);
    setFailed(null);
    try {
      const result = await api.transcribe(snapshot.blob, {
        sessionId,
        threadKey,
        threadTitle,
        requestId: createVoiceTranscriptionRequestId(),
        mode: snapshot.mode,
        composerText: snapshot.base,
        annotationContext: snapshot.context,
        onPhase: voice.setTranscriptionPhase,
      });
      if (requestGeneration !== generation.current) return;
      if (snapshot.mode === "edit") {
        setText(snapshot.base);
        setProposal({ before: snapshot.base, after: result.text });
      } else {
        const before = snapshot.base.slice(0, snapshot.start);
        const after = snapshot.base.slice(snapshot.end);
        const separator = before && !/\s$/.test(before) && result.text ? " " : "";
        setText(snapshot.mode === "dictation" ? result.text : before + separator + result.text + after);
        setProposal(null);
      }
      setAlternate(snapshot.mode === "dictation" ? null : snapshot);
      setHideAlternate(false);
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      voice.setError(error instanceof Error ? error.message : "Transcription failed.");
      setFailed(snapshot);
    } finally {
      if (requestGeneration === generation.current) {
        voice.setIsTranscribing(false);
        voice.setTranscriptionPhase(null);
      }
    }
  }

  function toggleVoice() {
    if (voice.isRecording) {
      voice.toggleRecording();
      return;
    }
    if (!voice.isSupported) {
      voice.setError(voice.unsupportedMessage ?? "Voice input is unavailable.");
      return;
    }
    const base = currentText.current;
    capture.current = {
      mode: base.trim() ? mode : "dictation",
      base,
      start: textarea.current?.selectionStart ?? base.length,
      end: textarea.current?.selectionEnd ?? base.length,
      context: structuredClone(context),
    };
    setAlternate(null);
    setFailed(null);
    voice.toggleRecording();
  }

  const width = Math.min(420, window.innerWidth - 24);
  const left = Math.max(12, Math.min(position?.x ?? (window.innerWidth - width) / 2, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(position?.y ?? window.innerHeight / 3, window.innerHeight - 400));
  return createPortal(
    <div
      className="fixed inset-0 z-[1200] bg-black/15"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Edit annotation"
        style={{ width, left, top }}
        className="fixed max-h-[85dvh] overflow-auto rounded-2xl border border-cc-border bg-cc-card p-4 text-cc-fg shadow-2xl"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            voice.cancelRecording();
            onCancel();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
              ),
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <blockquote className="mb-3 max-h-24 overflow-auto whitespace-pre-wrap break-words border-l-2 border-cc-primary/60 pl-3 text-xs text-cc-muted">
          {annotation.selectedText}
        </blockquote>
        {sourceUnavailable && (
          <p role="status" className="mb-2 text-xs text-cc-muted">
            The quoted passage is unavailable in this view. You can still edit this comment.
          </p>
        )}
        <textarea
          ref={textarea}
          aria-label="Comment"
          value={text}
          disabled={busy || !!proposal}
          onChange={(event) => changeText(event.target.value)}
          placeholder="Add your comment…"
          rows={4}
          className="w-full resize-y rounded-xl border border-cc-border bg-cc-input-bg p-3 text-sm outline-none focus:border-cc-primary"
        />
        {hint.shortened && (
          <details className="my-2 text-xs text-cc-muted">
            <summary className="cursor-pointer">Voice context shortened</summary>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{hint.text}</pre>
          </details>
        )}
        {voice.isRecording && <VoiceRecordingStatus currentLevel={voice.volumeLevel} samples={voice.volumeHistory} />}
        {voice.isTranscribing && (
          <p role="status" className="py-2 text-xs text-cc-muted">
            {voice.transcriptionPhase === "editing" ? "Editing comment…" : "Transcribing comment…"}
          </p>
        )}
        {voice.error && (
          <div role="alert" className="py-2 text-xs text-red-400">
            {voice.error}
            {failed && (
              <button className="ml-2 underline" disabled={busy} onClick={() => void transcribe(failed)}>
                Retry
              </button>
            )}
            <button
              className="ml-2 underline"
              onClick={() => {
                setFailed(null);
                voice.setError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {proposal && (
          <div className="my-2 rounded-xl border border-cc-border p-3 text-sm">
            <p className="mb-2 text-xs text-cc-muted">Proposed comment</p>
            <p className="whitespace-pre-wrap break-words">{proposal.after}</p>
            <div className="mt-2 flex gap-3 text-xs">
              <button disabled={busy} onClick={() => changeText(proposal.after)}>
                Accept edit
              </button>
              <button disabled={busy} onClick={() => changeText(proposal.before)}>
                Undo edit
              </button>
            </div>
          </div>
        )}
        {alternate && !hideAlternate && (
          <div className="my-2 flex items-center gap-2 text-xs text-cc-muted">
            <button
              className="underline"
              disabled={busy}
              onClick={() => void transcribe({ ...alternate, mode: alternate.mode === "edit" ? "append" : "edit" })}
            >
              Try as {alternate.mode === "edit" ? "append" : "voice edit"}
            </button>
            <button aria-label="Dismiss alternate voice mode" onClick={() => setHideAlternate(true)}>
              ×
            </button>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 text-sm">
          <button
            type="button"
            disabled={voice.isTranscribing || voice.isPreparing || !!proposal}
            onClick={toggleVoice}
            title={voice.isRecording ? "Stop recording" : "Voice input"}
            className={`flex h-11 w-11 sm:h-8 sm:w-8 items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover disabled:opacity-40 ${voice.isRecording ? "text-cc-primary bg-cc-primary/10" : ""}`}
            aria-label={voice.isRecording ? "Stop voice comment" : "Voice comment"}
          >
            <VoiceInputIcon active={voice.isRecording || voice.isPreparing} />
          </button>
          {text.trim() && (
            <select
              aria-label="Comment voice mode"
              value={mode}
              disabled={busy || !!proposal}
              onChange={(event) => setMode(event.target.value as "append" | "edit")}
              className="min-w-0 rounded-lg bg-cc-input-bg p-1.5 text-xs"
            >
              <option value="append">Append</option>
              <option value="edit">Edit</option>
            </select>
          )}
          <div className="flex-1" />
          {onRemove && (
            <button aria-label="Delete comment" disabled={busy} className="text-cc-muted" onClick={onRemove}>
              Delete
            </button>
          )}
          <button
            onClick={() => {
              voice.cancelRecording();
              onCancel();
            }}
            className="rounded-lg border border-cc-border px-2 py-1.5"
          >
            Cancel
          </button>
          <button
            disabled={!text.trim() || busy || !!proposal}
            onClick={() => onSave(text)}
            className="rounded-lg bg-cc-primary px-3 py-1.5 text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
