import { useComposerTextareaSize } from "./use-composer-textarea-size.js";
import { useContext } from "react";
import { ComposerVisibilityContext } from "./ComposerMinimizer.js";
import type { RefObject, ReactNode } from "react";
import { Lightbox } from "./Lightbox.js";

export function ComposerInputSurface({
  imageSrcs,
  lightboxSrc,
  setLightboxSrc,
  removeImage,
  retryImage,
  fileInputRef,
  handleFileSelect,
  handleComposerDragEnter,
  handleComposerDragOver,
  handleComposerDragLeave,
  handleComposerDrop,
  isImageDragOver,
  isPlan,
  textareaRef,
  text,
  handleInput,
  handleSelectionChange,
  handleKeyDown,
  handlePaste,
  placeholder,
  isRecording,
  recordingCursorBefore,
  recordingCursorAfter,
  topChildren,
  bottomChildren,
}: {
  imageSrcs: Array<{
    id: string;
    src: string | null;
    name: string;
    status: "reading" | "uploading" | "ready" | "failed";
    error?: string;
  }>;
  lightboxSrc: string | null;
  setLightboxSrc: (src: string | null) => void;
  removeImage: (index: number) => void;
  retryImage: (imageId: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleComposerDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleComposerDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  isImageDragOver: boolean;
  isPlan: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  handleInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSelectionChange: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent) => void;
  placeholder: string;
  isRecording: boolean;
  recordingCursorBefore: string;
  recordingCursorAfter: string;
  topChildren?: ReactNode;
  bottomChildren?: ReactNode;
}) {
  const expanded = useContext(ComposerVisibilityContext);
  useComposerTextareaSize(textareaRef, text);
  return (
    <div className="max-w-3xl mx-auto">
      {imageSrcs.length > 0 && (
        <div hidden={!expanded}>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {imageSrcs.map(({ id, src, name, status, error }, i) => (
              <div key={id} className="relative group">
                {src ? (
                  <img
                    src={src}
                    alt={name}
                    className="w-24 h-24 rounded-lg object-cover border border-cc-border cursor-zoom-in hover:opacity-80 transition-opacity"
                    onClick={() => setLightboxSrc(src)}
                  />
                ) : (
                  <div className="w-24 h-24 rounded-lg border border-cc-border bg-cc-hover flex items-center justify-center text-[10px] text-cc-muted">
                    Preparing...
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-1 bottom-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white">
                  <div className="truncate font-medium">
                    {status === "reading"
                      ? "Preparing..."
                      : status === "uploading"
                        ? "Uploading..."
                        : status === "failed"
                          ? "Upload failed"
                          : "Ready"}
                  </div>
                  {error && <div className="truncate text-white/80">{error}</div>}
                </div>
                {status === "failed" && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      retryImage(id);
                    }}
                    className="absolute left-1.5 top-1.5 rounded-full bg-cc-card/95 px-2 py-1 text-[10px] font-medium text-cc-primary shadow-sm transition-colors hover:bg-cc-card cursor-pointer"
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImage(i);
                  }}
                  aria-label={`Remove image ${name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {lightboxSrc && <Lightbox src={lightboxSrc} alt="attachment" onClose={() => setLightboxSrc(null)} />}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      <div
        data-testid="composer-input-card"
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
        className={`relative bg-cc-input-bg border rounded-[14px] overflow-visible transition-colors ${
          isImageDragOver
            ? "border-cc-primary bg-cc-primary/5 shadow-[0_0_0_3px_rgba(255,122,26,0.12)]"
            : isPlan
              ? "border-cc-primary/40"
              : "border-cc-border focus-within:border-cc-primary/30"
        }`}
      >
        {isImageDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border border-dashed border-cc-primary/50 bg-cc-primary/10">
            <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
              Drop images to attach
            </div>
          </div>
        )}

        <div hidden={!expanded}>{topChildren}</div>

        <div
          className={`relative ${expanded ? "" : "px-4 py-2.5"}`}
          onClick={() => {
            if (!expanded) textareaRef.current?.focus();
          }}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onSelect={handleSelectionChange}
            onMouseUp={handleSelectionChange}
            onKeyUp={handleSelectionChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            spellCheck={false}
            placeholder={placeholder}
            rows={1}
            wrap={expanded ? "soft" : "off"}
            aria-expanded={expanded}
            className={`block w-full text-base sm:text-sm bg-transparent resize-none focus:outline-none font-sans-ui placeholder:text-cc-muted disabled:opacity-50 ${expanded ? "px-4 pt-3 pb-1 overflow-y-auto" : "p-0 leading-6 overflow-hidden"} ${
              isRecording && recordingCursorAfter ? "text-transparent caret-transparent" : "text-cc-fg"
            }`}
            style={{ minHeight: expanded ? "36px" : "24px", maxHeight: expanded ? "200px" : "24px" }}
          />
          {isRecording && recordingCursorAfter && (
            <div className="absolute inset-0 px-4 pt-3 pb-1 text-base sm:text-sm font-sans-ui text-cc-fg pointer-events-none overflow-y-auto whitespace-pre-wrap break-words">
              <span>{recordingCursorBefore}</span>
              <span
                className="inline-block w-[2px] rounded-full animate-pulse mx-px"
                style={{ height: "1.15em", backgroundColor: "rgb(239 68 68 / 0.8)", verticalAlign: "text-bottom" }}
              />
              <span>{recordingCursorAfter}</span>
            </div>
          )}
        </div>

        <div hidden={!expanded}>{bottomChildren}</div>
      </div>
    </div>
  );
}
