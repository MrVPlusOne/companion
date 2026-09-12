// @vitest-environment jsdom
import { renderExpandedComposer as render } from "./composer-test-utils.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as renderCollapsedComposer } from "@testing-library/react";
import { Profiler } from "react";
import { screen, fireEvent, createEvent, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionState } from "../../server/session-types.js";
import type { VoiceTranscriptionResult } from "../api.js";
import type { ChatMessage, QuestmasterTask, SdkSessionInfo } from "../types.js";
import { DEFAULT_SESSION_DEFAULTS } from "../../shared/session-defaults.js";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mediaState = {
  touchDevice: false,
};

// Polyfill matchMedia for jsdom. Touch capability remains query-driven; layout
// width is controlled via window.innerWidth because the composer now uses
// zoom-adjusted viewport width instead of a raw media query.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === "(hover: none) and (pointer: coarse)" ? mediaState.touchDevice : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockSendToSession = vi.fn().mockReturnValue(true);
const mockTranscribe = vi
  .fn()
  .mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
const mockGetBackendModels = vi.fn().mockResolvedValue([]);
const mockGetSettings = vi.fn().mockResolvedValue({ claudeDefaultModel: "" });
const mockUpdateSettings = vi.fn().mockResolvedValue({});
const mockRefreshSessionSkills = vi.fn().mockResolvedValue({ ok: true, skills: [] });
const mockPrepareUserMessageImages = vi.fn();
const mockDeletePreparedUserMessageImage = vi.fn().mockResolvedValue({ ok: true });
const mockPauseSession = vi.fn().mockResolvedValue({ ok: true, queued: 0 });
const mockUnpauseSession = vi.fn().mockResolvedValue({ ok: true, resumed: 0 });

// Build a controllable mock store state
let mockStoreState: Record<string, unknown> = {};

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

vi.mock("../api.js", () => ({
  api: {
    gitPull: vi.fn().mockResolvedValue({ success: true, output: "", git_ahead: 0, git_behind: 0 }),
    getBackendModels: (...args: unknown[]) => mockGetBackendModels(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
    refreshSessionSkills: (...args: unknown[]) => mockRefreshSessionSkills(...args),
    prepareUserMessageImages: (...args: unknown[]) => mockPrepareUserMessageImages(...args),
    deletePreparedUserMessageImage: (...args: unknown[]) => mockDeletePreparedUserMessageImage(...args),
    pauseSession: (...args: unknown[]) => mockPauseSession(...args),
    unpauseSession: (...args: unknown[]) => mockUnpauseSession(...args),
    transcribe: (...args: unknown[]) => mockTranscribe(...args),
  },
}));

const mockVoiceState = {
  isSupportedOverride: null as boolean | null,
  isRecordingOverride: null as boolean | null,
  isPreparingOverride: null as boolean | null,
  isTranscribingOverride: null as boolean | null,
  unsupportedReasonOverride: null as
    | "insecure-context"
    | "missing-media-devices"
    | "missing-media-recorder"
    | "unsupported-environment"
    | null,
  unsupportedMessageOverride: null as string | null,
  onAudioReady: null as ((blob: Blob) => void | Promise<void>) | null,
  warmMicrophone: vi.fn(),
  toggleRecording: vi.fn(),
  cancelRecording: vi.fn(),
};

vi.mock("../hooks/useVoiceInput.js", async () => {
  const React = await import("react");
  return {
    useVoiceInput: (options: { onAudioReady?: (blob: Blob) => void | Promise<void> } = {}) => {
      mockVoiceState.onAudioReady = options.onAudioReady ?? null;
      const isSupported = mockVoiceState.isSupportedOverride ?? window.isSecureContext !== false;
      const unsupportedReason = isSupported
        ? null
        : (mockVoiceState.unsupportedReasonOverride ??
          (window.isSecureContext === false ? "insecure-context" : "unsupported-environment"));
      const unsupportedMessage = isSupported
        ? null
        : (mockVoiceState.unsupportedMessageOverride ??
          (unsupportedReason === "insecure-context"
            ? "Voice input requires HTTPS or localhost in this browser."
            : "Voice input is unavailable."));
      // Use real React state so onAudioReady can drive re-renders for error/isTranscribing
      const [error, setError] = React.useState<string | null>(null);
      const [isTranscribing, setIsTranscribing] = React.useState(false);
      const [transcriptionPhase, setTranscriptionPhase] = React.useState<string | null>(null);
      const resolvedIsRecording = mockVoiceState.isRecordingOverride ?? false;
      const resolvedIsPreparing = mockVoiceState.isPreparingOverride ?? false;
      const resolvedIsTranscribing = mockVoiceState.isTranscribingOverride ?? isTranscribing;
      return {
        isRecording: resolvedIsRecording,
        isPreparing: resolvedIsPreparing,
        isSupported,
        unsupportedReason,
        unsupportedMessage,
        isTranscribing: resolvedIsTranscribing,
        transcriptionPhase,
        error,
        volumeLevel: 0,
        setIsTranscribing,
        setTranscriptionPhase,
        setError,
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        toggleRecording: mockVoiceState.toggleRecording.mockImplementation(() =>
          options.onAudioReady?.(new Blob(["voice"], { type: "audio/webm" })),
        ),
        cancelRecording: mockVoiceState.cancelRecording,
        warmMicrophone: mockVoiceState.warmMicrophone,
      };
    },
  };
});

// Mock useStore as a function that takes a selector
const mockAppendMessage = vi.fn();
const mockUpdateSession = vi.fn();
const mockSetPreviousPermissionMode = vi.fn();
const mockSetSessionPreview = vi.fn();
const mockSetAskPermission = vi.fn();
const mockRequestBottomAlignOnNextUserMessage = vi.fn();

// Shared listener set for mock store reactivity
const mockStoreListeners = new Set<{
  getSelected: () => unknown;
  lastSelectedRef: { current: unknown };
  notify: () => void;
}>();
function notifyMockStore() {
  mockStoreListeners.forEach((listener) => {
    const nextSelected = listener.getSelected();
    if (!Object.is(nextSelected, listener.lastSelectedRef.current)) {
      listener.lastSelectedRef.current = nextSelected;
      listener.notify();
    }
  });
}

vi.mock("../store.js", async () => {
  const React = await import("react");
  // Create a mock store function that acts like zustand's useStore with subscribe support
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const selectorRef = React.useRef(selector);
    selectorRef.current = selector;
    const selected = selector(mockStoreState);
    const lastSelectedRef = React.useRef(selected);
    lastSelectedRef.current = selected;
    const [, forceUpdate] = React.useReducer((c: number) => c + 1, 0);
    React.useEffect(() => {
      const listener = {
        getSelected: () => selectorRef.current(mockStoreState),
        lastSelectedRef,
        notify: forceUpdate,
      };
      mockStoreListeners.add(listener);
      return () => {
        mockStoreListeners.delete(listener);
      };
    }, []);
    return selected;
  };
  // Add getState for imperative access (used by Composer for clearComposerDraft etc.)
  useStore.getState = () => mockStoreState;
  return { useStore };
});

import { Composer } from "./Composer.js";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "s1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: [],
    permissionMode: "acceptEdits",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function makeQuest(overrides: Partial<QuestmasterTask> & { questId: string; title: string }): QuestmasterTask {
  const { questId, title, ...rest } = overrides;
  return {
    id: `${questId}-v1`,
    version: 1,
    questId,
    title,
    description: "",
    status: "refined",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...rest,
  } as QuestmasterTask;
}

function makeSdkSession(
  overrides: Partial<SdkSessionInfo> & { sessionId: string; sessionNum: number },
): SdkSessionInfo {
  const { sessionId, sessionNum, ...rest } = overrides;
  return {
    sessionId,
    sessionNum,
    state: "connected",
    cwd: "/test",
    createdAt: 1,
    ...rest,
  };
}

function makeMessage(overrides: Partial<ChatMessage> & { id: string; content: string }): ChatMessage {
  const { id, content, ...rest } = overrides;
  return {
    id,
    role: "user",
    content,
    timestamp: 1,
    ...rest,
  };
}

function setupMockStore(
  overrides: {
    isConnected?: boolean;
    sessionStatus?: "idle" | "running" | "compacting" | null;
    session?: Partial<SessionState>;
    draftText?: string;
    draft?: { text: string; images: unknown[] };
    zoomLevel?: number;
    sdkSessionTotals?: { added: number; removed: number };
    sdkSessions?: SdkSessionInfo[];
    quests?: QuestmasterTask[];
    sessionNames?: Map<string, string>;
    messages?: ChatMessage[];
    vscodeSelectionContext?: {
      selection: {
        absolutePath: string;
        startLine: number;
        endLine: number;
        lineCount: number;
      } | null;
      updatedAt: number;
      sourceId: string;
      sourceType?: "browser-panel" | "vscode-window";
      sourceLabel?: string;
    } | null;
  } = {},
) {
  const {
    isConnected = true,
    sessionStatus = "idle",
    session = {},
    draftText = "",
    draft,
    zoomLevel = 1,
    sdkSessionTotals,
    sdkSessions = [],
    quests = [],
    sessionNames = new Map(),
    messages = [],
    vscodeSelectionContext = null,
  } = overrides;

  const sessionsMap = new Map<string, SessionState>();
  sessionsMap.set("s1", makeSession(session));

  const cliConnectedMap = new Map<string, boolean>();
  cliConnectedMap.set("s1", isConnected);

  const sessionStatusMap = new Map<string, "idle" | "running" | "compacting" | null>();
  sessionStatusMap.set("s1", sessionStatus);

  const previousPermissionModeMap = new Map<string, string>();
  previousPermissionModeMap.set("s1", "acceptEdits");

  const askPermissionMap = new Map<string, boolean>();
  askPermissionMap.set("s1", true);

  mockStoreState = {
    sessions: sessionsMap,
    cliConnected: cliConnectedMap,
    sessionStatus: sessionStatusMap,
    previousPermissionMode: previousPermissionModeMap,
    askPermission: askPermissionMap,
    composerDrafts: draft
      ? new Map([["s1", draft]])
      : draftText
        ? new Map([["s1", { text: draftText, images: [] }]])
        : new Map(),
    replyContexts: new Map(),
    appendMessage: mockAppendMessage,
    updateSession: mockUpdateSession,
    setPreviousPermissionMode: mockSetPreviousPermissionMode,
    setSessionPreview: mockSetSessionPreview,
    setAskPermission: mockSetAskPermission,
    requestBottomAlignOnNextUserMessage: mockRequestBottomAlignOnNextUserMessage,
    pendingUserUploads: new Map(),
    zoomLevel,
    vscodeSelectionContext,
    dismissedVsCodeSelectionKey: null,
    sdkSessions:
      sdkSessions.length > 0
        ? sdkSessions
        : sdkSessionTotals
          ? [
              {
                sessionId: "s1",
                totalLinesAdded: sdkSessionTotals.added,
                totalLinesRemoved: sdkSessionTotals.removed,
              },
            ]
          : [],
    quests,
    sessionNames,
    messages: new Map(messages.length > 0 ? [["s1", messages]] : []),
    setComposerDraft: vi.fn((sessionId: string, draft: { text: string; images: unknown[] }) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).set(sessionId, draft);
      notifyMockStore();
    }),
    clearComposerDraft: vi.fn((sessionId: string) => {
      (mockStoreState.composerDrafts as Map<string, unknown>).delete(sessionId);
      notifyMockStore();
    }),
    addPendingUserUpload: vi.fn((sessionId: string, upload: unknown) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, unknown[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      pending.set(sessionId, [...current, upload]);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    updatePendingUserUpload: vi.fn((sessionId: string, uploadId: string, updater: (upload: any) => any) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      pending.set(
        sessionId,
        current.map((upload) => (upload.id === uploadId ? updater(upload) : upload)),
      );
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    removePendingUserUpload: vi.fn((sessionId: string, uploadId: string) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      const next = current.filter((upload) => upload.id !== uploadId);
      if (next.length > 0) pending.set(sessionId, next);
      else pending.delete(sessionId);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
    }),
    consumePendingUserUpload: vi.fn((sessionId: string, uploadId: string) => {
      const pending = (mockStoreState.pendingUserUploads as Map<string, any[]>) ?? new Map();
      const current = pending.get(sessionId) ?? [];
      let consumed: any = null;
      const next = current.filter((upload) => {
        if (upload.id !== uploadId) return true;
        consumed = upload;
        return false;
      });
      if (next.length > 0) pending.set(sessionId, next);
      else pending.delete(sessionId);
      mockStoreState.pendingUserUploads = pending;
      notifyMockStore();
      return consumed;
    }),
    setReplyContext: vi.fn(
      (
        sessionId: string,
        context: {
          messageId: string;
          previewText: string;
        } | null,
      ) => {
        const replyContexts = mockStoreState.replyContexts as Map<string, { messageId: string; previewText: string }>;
        if (context) {
          replyContexts.set(sessionId, context);
        } else {
          replyContexts.delete(sessionId);
        }
        notifyMockStore();
      },
    ),
    dismissVsCodeSelection: vi.fn((key: string | null) => {
      mockStoreState.dismissedVsCodeSelectionKey = key;
      notifyMockStore();
    }),
    collapsibleTurnIds: new Map(),
    turnActivityOverrides: new Map(),
    collapseAllTurnActivity: vi.fn(),
    pendingPermissions: new Map(),
    removePermission: vi.fn(),
    diffFileStats: new Map(),
    focusComposer: vi.fn(),
  };
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function expectNoOverflowHiddenAncestorWithin(node: HTMLElement, stopAt: HTMLElement) {
  let current: HTMLElement | null = node.parentElement;
  while (current && current !== stopAt) {
    expect(current.className).not.toContain("overflow-hidden");
    current = current.parentElement;
  }
  expect(current).toBe(stopAt);
}

function makeImageFile(name: string, type = "image/png") {
  return new File(["fake-image-bytes"], name, { type });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeImageDataTransfer(file: File) {
  return {
    files: [file],
    items: [
      {
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVoiceState.isSupportedOverride = null;
  mockVoiceState.isRecordingOverride = null;
  mockVoiceState.isPreparingOverride = null;
  mockVoiceState.isTranscribingOverride = null;
  mockVoiceState.unsupportedReasonOverride = null;
  mockVoiceState.unsupportedMessageOverride = null;
  mockVoiceState.onAudioReady = null;
  mockVoiceState.warmMicrophone.mockReset();
  mockVoiceState.toggleRecording.mockReset();
  mockVoiceState.cancelRecording.mockReset();
  mockTranscribe.mockResolvedValue({ mode: "dictation", text: "transcribed text", backend: "openai", enhanced: false });
  mockGetBackendModels.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ claudeDefaultModel: "" });
  mockUpdateSettings.mockResolvedValue({});
  mockRefreshSessionSkills.mockResolvedValue({ ok: true, skills: [] });
  mockPauseSession.mockResolvedValue({ ok: true, queued: 0 });
  mockUnpauseSession.mockResolvedValue({ ok: true, resumed: 0 });
  mockPrepareUserMessageImages.mockReset();
  mockDeletePreparedUserMessageImage.mockReset();
  mockDeletePreparedUserMessageImage.mockResolvedValue({ ok: true });
  mockPrepareUserMessageImages.mockImplementation(
    async (sessionId: string, images: Array<{ mediaType: string }>, _signal?: AbortSignal) => ({
      imageRefs: images.map((image, index) => ({
        imageId: `img-${index + 1}`,
        media_type: image.mediaType,
      })),
      paths: images.map((_image, index) => `/Users/test/.companion/images/${sessionId}/img-${index + 1}.orig.png`),
      attachmentAnnotation: images
        .map(
          (_image, index) =>
            `Attachment ${index + 1}: /Users/test/.companion/images/${sessionId}/img-${index + 1}.orig.png`,
        )
        .join("\n"),
    }),
  );
  mockRequestBottomAlignOnNextUserMessage.mockReset();
  mediaState.touchDevice = false;
  setViewportWidth(1024);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "FileReader", {
    configurable: true,
    writable: true,
    value: class MockFileReader {
      result: string | ArrayBuffer | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

      readAsDataURL(file: Blob) {
        this.result = `data:${(file as File).type || "image/png"};base64,ZmFrZQ==`;
        this.onload?.call(this as unknown as FileReader, new ProgressEvent("load") as ProgressEvent<FileReader>);
      }
    },
  });
  setupMockStore();
});

// ─── Basic rendering ────────────────────────────────────────────────────────

describe("Composer basic rendering", () => {
  it("renders textarea and send button", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn).toBeTruthy();
  });

  it("releases the exact server-authored auto-pause epoch without optimistic local state", async () => {
    const pausedAt = new Date("2026-09-01T12:00:00Z").getTime();
    const autoPause = {
      family: "model_backend_stream_error" as const,
      fingerprint: "stream-error",
      streak: 3,
      threshold: 3,
      pausedAt,
      lastError: "stream disconnected",
      lastErrorAt: pausedAt,
      lastSourceKind: "automatic" as const,
      totalMatchingErrors: 3,
      heldInputs: [],
    };
    setupMockStore({
      session: {
        backend_type: "codex",
        codex_result_error_auto_pause: autoPause,
      },
    });

    render(<Composer sessionId="s1" />);
    const release = screen.getByTestId("composer-auto-pause-release");

    fireEvent.click(release);

    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "release_codex_auto_paused_inputs",
      pausedAt,
    });
    expect(release.textContent).toContain("Release now");
    expect((release as HTMLButtonElement).disabled).toBe(false);

    const sessions = mockStoreState.sessions as Map<string, SessionState>;
    act(() => {
      sessions.set("s1", {
        ...sessions.get("s1")!,
        codex_result_error_auto_pause: {
          ...autoPause,
          releaseProgress: { status: "releasing", acceptedAt: pausedAt + 1_000 },
        },
      });
      notifyMockStore();
    });

    await waitFor(() =>
      expect((screen.getByTestId("composer-auto-pause-release") as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId("composer-auto-pause-release").textContent).toContain("Releasing…");

    act(() => {
      sessions.set("s1", {
        ...sessions.get("s1")!,
        codex_result_error_auto_pause: null,
      });
      notifyMockStore();
    });

    await waitFor(() => expect(screen.queryByTestId("composer-paused-banner")).toBeNull());
  });

  it("renders archived sessions as read-only instead of active input", () => {
    // Archived session history should remain inspectable, but the composer must
    // not expose a live textarea or send control that would imply backend input.
    setupMockStore({ isConnected: false, sdkSessions: [{ sessionId: "s1", archived: true } as SdkSessionInfo] });

    render(<Composer sessionId="s1" />);

    expect(screen.getByTestId("archived-readonly-composer").textContent).toContain("Archived session is read-only.");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("disables browser spellcheck on the composer textarea", () => {
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");

    // Regression coverage for q-352: spellcheck must stay off consistently so
    // the browser does not re-enable per-keystroke decoration in some states.
    expect(textarea?.getAttribute("spellcheck")).toBe("false");
  });

  it("shows the leader quest destination in the desktop Codex placeholder", () => {
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: true } });

    const { container } = render(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Posting to q-1498 ... (/ for commands, $ for skills/apps, @ for files)");
  });

  it("keeps the Claude command and file hints after the leader quest destination", () => {
    setupMockStore({ session: { isOrchestrator: true } });

    const { container } = render(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Posting to q-1498 ... (/ for commands, @ for files)");
  });

  it("keeps the generic placeholder on the leader Main Thread", () => {
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: true } });

    const { container } = render(<Composer sessionId="s1" threadKey="main" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Type a message... (/ for commands, $ for skills/apps, @ for files)");
  });

  it("keeps the generic placeholder for non-leader quest-thread renders", () => {
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: false } });

    const { container } = render(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Type a message... (/ for commands, $ for skills/apps, @ for files)");
  });

  it("keeps the generic placeholder on touch mobile leader quest tabs", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: true } });

    const { container } = renderCollapsedComposer(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Type a message... (/ for commands, $ for skills/apps, @ for files)");
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the generic placeholder on narrow desktop leader quest tabs", () => {
    setViewportWidth(500);
    mediaState.touchDevice = false;
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: true } });

    const { container } = render(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.placeholder).toBe("Type a message... (/ for commands, $ for skills/apps, @ for files)");
  });

  it("keeps pending answer and plan placeholders ahead of the destination cue", () => {
    setupMockStore({ session: { backend_type: "codex", isOrchestrator: true } });
    (mockStoreState.pendingPermissions as Map<string, Map<string, unknown>>).set(
      "s1",
      new Map([["ask-1", { request_id: "ask-1", tool_name: "AskUserQuestion", input: { questions: [] } }]]),
    );

    const { container, rerender } = render(<Composer sessionId="s1" threadKey="q-1498" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("Type your answer...");

    (mockStoreState.pendingPermissions as Map<string, Map<string, unknown>>).set(
      "s1",
      new Map([["plan-1", { request_id: "plan-1", tool_name: "ExitPlanMode", input: {} }]]),
    );
    rerender(<Composer sessionId="s1" threadKey="q-1498" />);

    expect(textarea.placeholder).toBe("Type to reject plan and send new instructions...");
  });

  it("does not rerender for unrelated sessions and sdkSessions churn", async () => {
    setupMockStore({
      session: { git_branch: "main", model: "claude-sonnet-4-5-20250929" },
      sdkSessionTotals: { added: 5, removed: 2 },
    });

    const sessionsMap = mockStoreState.sessions as Map<string, SessionState>;
    sessionsMap.set("s2", makeSession({ session_id: "s2", git_branch: "feature/initial" }));
    mockStoreState.sdkSessions = [
      ...(mockStoreState.sdkSessions as Array<{
        sessionId: string;
        totalLinesAdded: number;
        totalLinesRemoved: number;
      }>),
      { sessionId: "s2", totalLinesAdded: 1, totalLinesRemoved: 1 },
    ];

    let composerCommits = 0;

    render(
      <Profiler id="composer" onRender={() => composerCommits++}>
        <Composer sessionId="s1" />
      </Profiler>,
    );

    // Let mount-time async hydration settle before capturing the baseline.
    await act(async () => {
      await Promise.resolve();
    });

    // After mount-time hydration settles, unrelated session churn must not
    // commit the active Composer subtree at all.
    const baselineCommits = composerCommits;
    expect(baselineCommits).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("sonnet-4.5")).toBeTruthy();

    // Regression coverage for q-352: unrelated session-list polling churn
    // should not commit the active Composer subtree anymore.
    act(() => {
      sessionsMap.set("s2", makeSession({ session_id: "s2", git_branch: "feature/updated", model: "gpt-5.4" }));
      mockStoreState.sdkSessions = [
        {
          sessionId: "s1",
          totalLinesAdded: 5,
          totalLinesRemoved: 2,
        },
        {
          sessionId: "s2",
          totalLinesAdded: 99,
          totalLinesRemoved: 42,
        },
      ];
      notifyMockStore();
    });

    expect(composerCommits).toBe(baselineCommits);
    expect(screen.getByText("sonnet-4.5")).toBeTruthy();
    expect(screen.queryByText("+99")).toBeNull();
  });

  it("omits composer diff totals even when sdk fallback has values", () => {
    setupMockStore({
      session: { total_lines_added: 0, total_lines_removed: 0 },
      sdkSessionTotals: { added: 34, removed: 8 },
    });
    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("+34")).toBeNull();
    expect(screen.queryByText("-8")).toBeNull();
  });

  it("renders the composer footer after the textarea with a friendly model-and-effort chip", () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        permissionMode: "plan",
        git_branch: "feature/composer-footer",
        model: "gpt-5.4",
        codex_reasoning_effort: "high",
      },
    });

    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea");
    const footer = screen.getByTestId("composer-footer-toolbar");
    const meta = screen.getByTestId("composer-footer-meta");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    const permissionSelector = screen.getByTitle(/Default:/);

    expect(textarea).toBeTruthy();
    expect(Boolean(textarea && textarea.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(sendButton.closest('[data-testid="composer-footer-toolbar"]')).toBe(footer);
    expect(permissionSelector.closest('[data-testid="composer-footer-toolbar"]')).toBe(footer);
    expect(within(meta).getByText("5.4 High")).toBeTruthy();
    expect(within(meta).queryByText("feature/composer-footer")).toBeNull();
  });

  it("places pause controls in the composer footer and exposes held input state", async () => {
    setupMockStore({
      session: {
        pause: {
          pausedAt: 123,
          queuedMessages: [
            {
              id: "held-1",
              queuedAt: 124,
              source: "programmatic",
              message: { type: "user_message", content: "Held external reminder" },
            },
          ],
        } as any,
      },
    });

    render(<Composer sessionId="s1" />);

    const pauseButton = screen.getByTestId("composer-pause-sources-button");
    expect(pauseButton.closest('[data-testid="composer-footer-toolbar"]')).toBeTruthy();
    expect(screen.getByTestId("composer-paused-chip").textContent).toContain("Other sources paused");

    await userEvent.click(screen.getByTestId("composer-paused-chip"));
    expect(screen.getByTestId("composer-held-input-list").textContent).toContain("Held external reminder");

    await userEvent.click(pauseButton);
    await waitFor(() => expect(mockUnpauseSession).toHaveBeenCalledWith("s1"));
  });

  it("keeps the moved footer popovers outside overflow-hidden ancestors", async () => {
    setupMockStore({
      session: {
        git_branch: "main",
        model: "claude-sonnet-4-5-20250929",
        permissionMode: "acceptEdits",
      },
    });

    render(<Composer sessionId="s1" />);

    const footer = screen.getByTestId("composer-footer-toolbar");
    await userEvent.click(screen.getByTitle(/Accept edits:/));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-permission-mode-menu"), footer);

    await userEvent.click(screen.getByTitle("Model: claude-sonnet-4-5-20250929 (click to change)"));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-model-menu"), footer);
  });

  it("keeps the moved codex reasoning menu outside overflow-hidden ancestors", async () => {
    setupMockStore({
      session: {
        backend_type: "codex",
        git_branch: "feature/reasoning-menu",
        model: "gpt-5.4",
        permissionMode: "plan",
      },
    });

    render(<Composer sessionId="s1" />);

    const footer = screen.getByTestId("composer-footer-toolbar");
    await userEvent.click(screen.getByTitle(/Model: gpt-5.4; speed:/));
    await userEvent.click(screen.getByRole("menuitem", { name: /Effort/ }));
    expectNoOverflowHiddenAncestorWithin(screen.getByTestId("composer-reasoning-menu"), footer);
  });

  it("renders a Codex speed menu gated by model service tiers", async () => {
    mockGetBackendModels.mockResolvedValue([
      {
        value: "gpt-5.4",
        label: "GPT-5.4",
        description: "Frontier model",
        serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
      },
    ]);
    setupMockStore({
      session: {
        backend_type: "codex",
        git_branch: "feature/speed-menu",
        model: "gpt-5.4",
        permissionMode: "plan",
      },
    });

    render(<Composer sessionId="s1" />);

    await waitFor(() => expect(mockGetBackendModels).toHaveBeenCalledWith("codex"));
    await userEvent.click(screen.getByTitle(/Model: gpt-5.4; speed:/));
    await userEvent.click(screen.getByRole("menuitem", { name: /Speed/ }));
    const menu = screen.getByTestId("composer-speed-menu");
    expect(within(menu).getByText("Standard")).toBeTruthy();
    expect(within(menu).getByText("Fast")).toBeTruthy();

    await userEvent.click(within(menu).getByText("Fast"));
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_codex_service_tier",
      serviceTier: "priority",
    });
  });

  it("resets Codex model settings from fresh role-aware server defaults", async () => {
    // Reset must not hardcode frontend values: it reloads the server-owned
    // defaults, resolves the current session role, and uses existing setting messages.
    mockGetSettings.mockResolvedValue({
      claudeDefaultModel: "",
      sessionDefaults: {
        ...DEFAULT_SESSION_DEFAULTS,
        codex: {
          ...DEFAULT_SESSION_DEFAULTS.codex,
          model: "gpt-worker",
          reasoningEffort: "low",
          serviceTier: null,
        },
        leaderUsesWorkerDefaults: false,
        leader: {
          ...DEFAULT_SESSION_DEFAULTS.leader,
          codex: {
            ...DEFAULT_SESSION_DEFAULTS.leader.codex,
            model: "gpt-leader",
            reasoningEffort: "ultra",
            serviceTier: "priority",
          },
        },
      },
    } as any);
    setupMockStore({
      session: {
        backend_type: "codex",
        isOrchestrator: true,
        model: "gpt-5.4",
        codex_reasoning_effort: "high",
        codex_service_tier: null,
        permissionMode: "plan",
      },
    });

    render(<Composer sessionId="s1" />);
    await userEvent.click(screen.getByTitle(/Model: gpt-5.4; speed:/));
    await userEvent.click(screen.getByRole("menuitem", { name: "Reset to default" }));

    await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_model", model: "gpt-leader" });
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_codex_reasoning_effort",
      effort: "ultra",
    });
    expect(mockSendToSession).toHaveBeenCalledWith("s1", {
      type: "set_codex_service_tier",
      serviceTier: "priority",
    });
  });

  it("clears an unsupported Codex service tier after model metadata loads", async () => {
    mockGetBackendModels.mockResolvedValue([
      {
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        description: "No speed tier",
      },
    ]);
    setupMockStore({
      session: {
        backend_type: "codex",
        model: "gpt-5.3-codex",
        permissionMode: "plan",
        codex_service_tier: "priority",
      },
    });

    render(<Composer sessionId="s1" />);

    await waitFor(() =>
      expect(mockSendToSession).toHaveBeenCalledWith("s1", {
        type: "set_codex_service_tier",
        serviceTier: null,
      }),
    );
  });

  it("starts compact on narrow desktop layouts too", () => {
    setViewportWidth(500);
    mediaState.touchDevice = false;
    renderCollapsedComposer(<Composer sessionId="s1" />);

    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
  });

  it("does not replay a historical focus request when a drafted mobile composer mounts", () => {
    // A global focus counter can remain nonzero after an earlier explicit action.
    // Mounting or returning to a drafted mobile session must not replay that old edge.
    setViewportWidth(430);
    mediaState.touchDevice = true;
    setupMockStore({ draftText: "Preserved mobile draft" });
    mockStoreState.focusComposerTrigger = 7;

    const { container } = renderCollapsedComposer(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.value).toBe("Preserved mobile draft");
    expect(document.activeElement).not.toBe(textarea);
  });

  it("still honors a new explicit composer focus request on mobile", async () => {
    // Intentional focus actions remain available; only stale/navigation-driven
    // focus is suppressed.
    setViewportWidth(430);
    mediaState.touchDevice = true;
    setupMockStore({ draftText: "Tap or shortcut to continue" });
    mockStoreState.focusComposerTrigger = 4;
    const { container } = render(<Composer sessionId="s1" />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    act(() => {
      mockStoreState.focusComposerTrigger = 5;
      notifyMockStore();
    });

    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("blurs a focused drafted mobile composer when leader thread navigation reuses it", async () => {
    // Leader quest-thread selection can reuse one Composer instance. The route
    // change must be view-only on touch devices while preserving the draft.
    setViewportWidth(430);
    mediaState.touchDevice = true;
    setupMockStore({ draftText: "Keep this draft across threads" });
    const view = render(<Composer sessionId="s1" threadKey="main" />);
    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    view.rerender(<Composer sessionId="s1" threadKey="q-42" />);

    await waitFor(() => expect(document.activeElement).not.toBe(textarea));
    expect(textarea.value).toBe("Keep this draft across threads");
    await userEvent.click(textarea);
    expect(document.activeElement).toBe(textarea);
  });

  it("preserves focused composer behavior across desktop thread navigation", () => {
    // Desktop navigation retains the established focus behavior.
    setViewportWidth(1024);
    mediaState.touchDevice = false;
    setupMockStore({ draftText: "Desktop draft" });
    const view = render(<Composer sessionId="s1" threadKey="main" />);
    const textarea = view.container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.focus();

    view.rerender(<Composer sessionId="s1" threadKey="q-42" />);

    expect(document.activeElement).toBe(textarea);
  });

  it("shows only the compact input on mobile, hiding mode labels and all controls", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    setupMockStore({
      session: {
        permissionMode: "plan",
        uiMode: "plan",
      },
    });

    renderCollapsedComposer(<Composer sessionId="s1" />);

    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");

    // Only the input is accessible; the complete toolbar stays mounted but hidden.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("composer-footer-toolbar").closest("[hidden]")).toBeTruthy();
  });

  it("uses the existing image upload input after expanding the mobile composer", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;

    const { container } = render(<Composer sessionId="s1" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const fileInputClick = vi.spyOn(fileInput, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByTitle("Upload image"));

    expect(fileInputClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the voice button visible on mobile even when voice input is unavailable", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    const voiceButtons = screen.getAllByLabelText("Voice input");
    expect(voiceButtons.length).toBeGreaterThan(0);
    expect(voiceButtons[0].hasAttribute("disabled")).toBe(false);
    expect(voiceButtons[0].getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();
  });

  it("shows the expanded mobile voice button instead of dropping it from the toolbar", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    setupMockStore({ draftText: "Voice should still have a slot" });

    render(<Composer sessionId="s1" />);

    const voiceButtons = screen.getAllByLabelText("Voice input");
    expect(voiceButtons.length).toBeGreaterThan(0);
    expect(screen.getByTitle("Voice needs HTTPS")).toBeTruthy();
  });

  it("keeps the mobile composer expanded once voice capture becomes active", () => {
    vi.useFakeTimers();
    try {
      setViewportWidth(500);
      mediaState.touchDevice = true;

      const { rerender } = render(<Composer sessionId="s1" />);

      fireEvent.click(screen.getAllByLabelText("Voice input")[0]);
      mockVoiceState.isPreparingOverride = true;
      rerender(<Composer sessionId="s1" />);

      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(screen.getByText("Preparing mic...")).toBeTruthy();
      expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the expanded mobile mic interactive while the session is streaming", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    setupMockStore({ sessionStatus: "running" });

    render(<Composer sessionId="s1" />);

    const voiceButton = screen.getAllByLabelText("Voice input")[0];
    expect(voiceButton.hasAttribute("disabled")).toBe(false);
    expect(voiceButton.getAttribute("aria-disabled")).toBe("false");
    expect(voiceButton.className).not.toContain("opacity-30");
  });

  it("shows the full unavailable-voice explanation only after pressing the voice button", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();

    fireEvent.click(screen.getAllByLabelText("Voice input")[0]);

    expect(screen.getByText("Voice input requires HTTPS or localhost in this browser.")).toBeTruthy();
  });

  it("shows the concise unavailable tooltip without the full message on desktop hover state", () => {
    setViewportWidth(1200);
    mediaState.touchDevice = false;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<Composer sessionId="s1" />);

    expect(screen.getByTitle("Voice needs HTTPS")).toBeTruthy();
    expect(screen.queryByText("Voice input requires HTTPS or localhost in this browser.")).toBeNull();
  });

  it("reveals a new reply and preserves it when focus leaves the composer", () => {
    setViewportWidth(500);
    mediaState.touchDevice = true;

    renderCollapsedComposer(<Composer sessionId="s1" />);

    // Choosing a reply reveals its context; outside interaction now hides it without discarding it.
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");

    act(() => {
      (
        mockStoreState.setReplyContext as (
          sessionId: string,
          context: { messageId: string; previewText: string } | null,
        ) => void
      )("s1", {
        messageId: "msg-1",
        previewText: "Good plan from #618. One thing to clarify before approving.",
      });
    });

    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Good plan from #618. One thing to clarify before approving.")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByText("Good plan from #618. One thing to clarify before approving.").closest("[hidden]"),
    ).toBeTruthy();
    act(() => screen.getByRole("textbox").focus());
    expect(
      screen.getByText("Good plan from #618. One thing to clarify before approving.").closest("[hidden]"),
    ).toBeNull();
  });

  it("allows the mobile composer to collapse again after a notification reply is cleared", () => {
    vi.useFakeTimers();
    try {
      setViewportWidth(500);
      mediaState.touchDevice = true;

      render(<Composer sessionId="s1" />);

      // Clearing the reply and leaving the composer restores the compact input.
      act(() => {
        (
          mockStoreState.setReplyContext as (
            sessionId: string,
            context: { messageId: string; previewText: string } | null,
          ) => void
        )("s1", {
          messageId: "notif-1",
          previewText: "Approve q-460 plan? Re-run all 4 datasets before review.",
        });
      });

      expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("Approve q-460 plan? Re-run all 4 datasets before review.")).toBeTruthy();

      fireEvent.click(screen.getByLabelText("Cancel reply"));
      fireEvent.pointerDown(document.body);

      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("Approve q-460 plan? Re-run all 4 datasets before review.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Hidden drafts report zero layout size; restoring must measure the visible textarea again.
it("restores automatic sizing after the draft changes while minimized", () => {
  const size = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.closest("[hidden]") ? 0 : 140;
  });
  try {
    setupMockStore({ draftText: "Original long draft" });
    render(<Composer sessionId="s1" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.click(screen.getByLabelText("Minimize composer"));
    act(() => (mockStoreState.setComposerDraft as Function)("s1", { text: "A changed long draft", images: [] }));
    act(() => screen.getByRole("textbox").focus());
    expect(textarea.style.height).toBe("140px");
  } finally {
    size.mockRestore();
  }
});

it("minimizes on mobile thread navigation without reviving an old collapse request", () => {
  vi.useFakeTimers();
  try {
    setViewportWidth(430);
    mediaState.touchDevice = true;
    const view = render(
      <>
        <button role="tab">Another thread</button>
        <Composer sessionId="s1" threadKey="main" />
      </>,
    );
    act(() => vi.advanceTimersByTime(350));
    act(() => screen.getByRole("textbox").focus());
    fireEvent.pointerDown(screen.getByRole("tab"));
    view.rerender(
      <>
        <button role="tab">Another thread</button>
        <Composer sessionId="s1" threadKey="another" />
      </>,
    );
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
  } finally {
    vi.useRealTimers();
  }
});

it("does not let an earlier empty-draft timer undo explicit expansion", () => {
  vi.useFakeTimers();
  try {
    setViewportWidth(430);
    mediaState.touchDevice = true;
    render(<Composer sessionId="s1" />);
    act(() => screen.getByRole("textbox").focus());
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("true");
  } finally {
    vi.useRealTimers();
  }
});

// An outside request may minimize after active voice releases its reveal, without a delayed empty-draft timer.
it("allows an empty mobile composer to collapse after voice capture finishes", () => {
  vi.useFakeTimers();
  try {
    setViewportWidth(430);
    mediaState.touchDevice = true;
    const view = render(<Composer sessionId="s1" />);
    act(() => screen.getByRole("textbox").focus());
    mockVoiceState.isRecordingOverride = true;
    view.rerender(<Composer sessionId="s1" />);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    mockVoiceState.isRecordingOverride = false;
    view.rerender(<Composer sessionId="s1" />);
    act(() => vi.advanceTimersByTime(350));
    expect(screen.getByRole("textbox").getAttribute("aria-expanded")).toBe("false");
  } finally {
    vi.useRealTimers();
  }
});

// Defaults are uniform at both sizes; first-line presentation must never mutate later draft lines.
it.each([false, true])("starts with only the populated input visible (touch=%s)", (touch) => {
  mediaState.touchDevice = touch;
  setViewportWidth(touch ? 430 : 1440);
  const draftText = "The first draft line\nThe second line is retained\nAnd so is the third";
  setupMockStore({ draftText });
  renderCollapsedComposer(<Composer sessionId="s1" />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(textarea.value).toBe(draftText);
  expect(textarea.getAttribute("aria-expanded")).toBe("false");
  expect(textarea.wrap).toBe("off");
  expect(textarea.style.height).toBe("24px");
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  // Padding belongs to the input box too, even though the clipped textarea is only one line tall.
  fireEvent.click(textarea.parentElement!);
  expect(textarea.getAttribute("aria-expanded")).toBe("true");
  expect(textarea.wrap).toBe("soft");
  expect(screen.getByLabelText("Minimize composer").closest("[data-testid=composer-footer-toolbar]")).toBeTruthy();
});
