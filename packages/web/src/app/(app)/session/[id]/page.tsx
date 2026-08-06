"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { Suspense, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SessionTimeline } from "@/components/session-timeline";
import { MediaLightbox } from "@/components/media-lightbox";
import { SessionHeader } from "@/components/session-header";
import { SessionDetailsOverlay } from "@/components/session-details-overlay";
import { SessionPromptComposer } from "@/components/session-prompt-composer";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { useDefaultLayout } from "react-resizable-panels";
import { archiveSession } from "@/lib/archive-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
import { useModelPicker } from "@/hooks/use-model-picker";
import {
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import { useSessionDiffs } from "@/hooks/use-session-diffs";
import { useSessionExecutionTarget } from "@/hooks/use-session-execution-target";
import { resolveDiffSelection, type DiffSelection } from "@/lib/session-diffs";
import type { SessionDiffFile, SessionDiffRepository } from "@open-inspect/shared";
import { SessionChangesPanel } from "@/components/session-changes-panel";
import {
  SESSION_CHANGES_LAYOUT_ID,
  SessionDesktopLayout,
} from "@/components/session-desktop-layout";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useBrowserLayoutStorage } from "@/hooks/use-browser-layout-storage";
import { focusSessionDetailsTrigger } from "@/lib/session-details-focus";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

export default function SessionPage() {
  return (
    <Suspense>
      <SessionPageContent />
    </Suspense>
  );
}

function SessionPageContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const sessionId = params.id as string;

  const {
    connected,
    connecting,
    replaying,
    authError,
    connectionError,
    sessionState,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  } = useSessionSocket(sessionId);

  const fallbackSessionInfo = useMemo(
    () => ({
      repoOwner: searchParams.get("repoOwner") || null,
      repoName: searchParams.get("repoName") || null,
      title: searchParams.get("title") || null,
    }),
    [searchParams]
  );

  // Fleet-centric status: the machine this session is bound to and whether it
  // is currently reachable, or the sandbox lifecycle for sandbox sessions.
  const executionTarget = useSessionExecutionTarget(sessionState);

  const { handleArchive, handleUnarchive, renameSession } = useSessionListActions(sessionId);
  const {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    modelItems,
    needsProviderConnection,
    catalogReasoning,
    loadingEnabledModels,
  } = useModelSelection(sessionState);
  // A send needs an open socket and a settled model list; the composer shows
  // whichever is missing instead of offering a button that does nothing.
  const sendBlockedReason = !connected
    ? "Disconnected. Reconnect to send this message."
    : loadingEnabledModels
      ? "Loading models…"
      : null;
  const {
    prompt,
    sessionAttachments,
    inputRef,
    isSubmitting,
    sendError,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
  } = usePromptInput(
    sessionId,
    isProcessing,
    sendPrompt,
    sendTyping,
    selectedModel,
    reasoningEffort,
    Boolean(sendBlockedReason)
  );

  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const diffReturnFocusRef = useRef<DiffSelection | null>(null);
  const { state: diffState, isLoading: diffLoading } = useSessionDiffs(sessionId);

  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => !prev);
  }, []);
  const openMobileDetails = useCallback(() => {
    setIsDetailsOpen(true);
  }, []);
  const focusDetailsTrigger = useCallback(
    () => focusSessionDetailsTrigger(isPhone, actionsButtonRef.current, detailsButtonRef.current),
    [isPhone]
  );

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
  }, [isBelowLg]);

  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const selectedMediaArtifact = useMemo(
    () => mediaArtifacts.find((artifact) => artifact.id === selectedMediaArtifactId) ?? null,
    [mediaArtifacts, selectedMediaArtifactId]
  );
  const primaryRepo =
    sessionState?.repositories?.[0] ??
    (sessionState?.repoOwner && sessionState?.repoName
      ? { repoOwner: sessionState.repoOwner, repoName: sessionState.repoName }
      : null);

  const showTimelineSkeleton = events.length === 0 && (connecting || replaying);
  const resolvedDiff = useMemo(
    () =>
      selectedDiff && diffState?.current
        ? resolveDiffSelection(diffState.current, selectedDiff)
        : null,
    [diffState, selectedDiff]
  );
  const changesLayoutStorage = useBrowserLayoutStorage();
  const changesLayout = useDefaultLayout({
    id: SESSION_CHANGES_LAYOUT_ID,
    panelIds:
      resolvedDiff && diffState && !isBelowLg
        ? ["session-main", "session-changes"]
        : ["session-main"],
    storage: changesLayoutStorage,
  });
  const openDiff = useCallback((repository: SessionDiffRepository, file: SessionDiffFile) => {
    const selection = { repositoryPosition: repository.position, path: file.path };
    diffReturnFocusRef.current = selection;
    setSelectedDiff(selection);
    setIsDetailsOpen(false);
  }, []);
  const closeDiff = useCallback(() => {
    const returnSelection = diffReturnFocusRef.current;
    setSelectedDiff(null);
    requestAnimationFrame(() => {
      if (!isBelowLg && returnSelection) {
        const row = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button[data-diff-path]")
        ).find(
          (candidate) =>
            candidate.dataset.diffRepositoryPosition ===
              String(returnSelection.repositoryPosition) &&
            candidate.dataset.diffPath === returnSelection.path
        );
        if (row) {
          row.focus();
          return;
        }
      }
      focusDetailsTrigger();
    });
  }, [focusDetailsTrigger, isBelowLg]);

  const sessionWorkspace = (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      <SessionTimeline
        events={events}
        sessionId={sessionId}
        currentParticipantId={currentParticipantId}
        isProcessing={isProcessing}
        loadingHistory={loadingHistory}
        showSkeleton={showTimelineSkeleton}
        onLoadOlder={loadOlderEvents}
        onOpenMedia={setSelectedMediaArtifactId}
      />
    </div>
  );

  return (
    <div className="h-full min-w-0 overflow-x-hidden flex flex-col">
      <SessionHeader
        sessionState={sessionState}
        fallbackSessionInfo={fallbackSessionInfo}
        executionTarget={executionTarget}
        connected={connected}
        connecting={connecting}
        isDetailsOpen={isDetailsOpen}
        detailsButtonRef={detailsButtonRef}
        actionsButtonRef={actionsButtonRef}
        onToggleDetails={toggleDetails}
        onOpenMobileDetails={openMobileDetails}
        actions={{
          sessionId,
          sessionStatus: sessionState?.status ?? "created",
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        renameSession={renameSession}
      />

      {/* Connection error banner */}
      {(authError || connectionError) && (
        <div className="bg-destructive-muted border-b border-destructive-border px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-destructive">{authError || connectionError}</p>
          <button
            type="button"
            onClick={reconnect}
            className="px-3 py-1.5 text-sm font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 transition"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="min-w-0 flex-1 flex overflow-hidden">
        {!isBelowLg ? (
          <SessionDesktopLayout
            workspace={sessionWorkspace}
            sidebar={
              <SessionRightSidebar
                sessionId={sessionId}
                sessionState={sessionState}
                executionTarget={executionTarget}
                participants={participants}
                events={events}
                artifacts={artifacts}
                onOpenMedia={setSelectedMediaArtifactId}
                diffState={diffState}
                diffLoading={diffLoading}
                selectedDiff={selectedDiff}
                onOpenDiff={openDiff}
              />
            }
            changes={
              resolvedDiff && diffState ? (
                <SessionChangesPanel
                  sessionId={sessionId}
                  state={diffState}
                  resolved={resolvedDiff}
                  onClose={closeDiff}
                  onSelect={setSelectedDiff}
                />
              ) : null
            }
            defaultLayout={changesLayout.defaultLayout}
            onLayoutChanged={changesLayout.onLayoutChanged}
          />
        ) : (
          <>
            {sessionWorkspace}
            <SessionRightSidebar
              sessionId={sessionId}
              sessionState={sessionState}
              executionTarget={executionTarget}
              participants={participants}
              events={events}
              artifacts={artifacts}
              onOpenMedia={setSelectedMediaArtifactId}
              diffState={diffState}
              diffLoading={diffLoading}
              selectedDiff={selectedDiff}
              onOpenDiff={openDiff}
            />
          </>
        )}
      </main>

      {isBelowLg && (
        <SessionDetailsOverlay
          open={isDetailsOpen}
          onOpenChange={setIsDetailsOpen}
          isPhone={isPhone}
          onReturnFocus={focusDetailsTrigger}
          sessionId={sessionId}
          sessionState={sessionState}
          executionTarget={executionTarget}
          participants={participants}
          events={events}
          artifacts={artifacts}
          onOpenMedia={setSelectedMediaArtifactId}
          diffState={diffState}
          diffLoading={diffLoading}
          selectedDiff={selectedDiff}
          onOpenDiff={openDiff}
        />
      )}

      {isBelowLg && (
        <Sheet
          open={Boolean(resolvedDiff && diffState)}
          onOpenChange={(open) => !open && closeDiff()}
        >
          <SheetContent className="inset-0 h-dvh w-screen max-w-none gap-0 p-0 sm:max-w-none">
            <SheetTitle className="sr-only">Changes</SheetTitle>
            {resolvedDiff && diffState && (
              <SessionChangesPanel
                mobile
                sessionId={sessionId}
                state={diffState}
                resolved={resolvedDiff}
                onClose={closeDiff}
                onSelect={setSelectedDiff}
              />
            )}
          </SheetContent>
        </Sheet>
      )}

      <MediaLightbox
        sessionId={sessionId}
        artifact={selectedMediaArtifact}
        open={selectedMediaArtifactId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMediaArtifactId(null);
          }
        }}
      />

      <SessionPromptComposer
        session={{
          id: sessionId,
          status: sessionState?.status ?? "created",
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        prompt={{
          value: prompt,
          isProcessing,
          draftLocked: isSubmitting || sessionAttachments.isUploading,
          sendBlockedReason,
          sendError,
          inputRef,
          onSubmit: handleSubmit,
          onChange: handleInputChange,
          onKeyDown: handleKeyDown,
          onStopExecution: stopExecution,
        }}
        attachments={{
          items: sessionAttachments.attachments,
          error: sessionAttachments.attachmentError,
          isUploading: sessionAttachments.isUploading,
          onAdd: sessionAttachments.addFiles,
          onRemove: sessionAttachments.removeAttachment,
        }}
        model={{
          selectedModel,
          reasoningEffort,
          items: modelItems,
          needsProviderConnection,
          catalogReasoning,
          onModelChange: handleModelChange,
          onReasoningEffortChange: setReasoningEffort,
        }}
      />
    </div>
  );
}

/**
 * Archive, unarchive, and rename actions for the current session, each keeping
 * the SWR session-list caches in sync.
 */
function useSessionListActions(sessionId: string) {
  const router = useRouter();

  const { trigger: triggerRename } = useSWRMutation(
    `/api/sessions/${sessionId}/title`,
    (url: BrowserApiPath, { arg }: { arg: { title: string } }) =>
      browserApiFetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: arg.title }),
      }).then((r) => {
        if (r.ok) return true;
        console.error("Failed to update session title");
        return false;
      }),
    { throwOnError: false }
  );

  const handleArchive = useCallback(async () => {
    const didArchive = await archiveSession(sessionId);
    if (didArchive) {
      await mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );
      router.push("/");
    }
  }, [router, sessionId]);

  const renameSession = useCallback(
    async (title: string) => {
      const updatedAt = Date.now();
      const updateSessionsTitle = (data?: SessionListResponse): SessionListResponse | undefined => {
        if (!data?.sessions) return data;
        return {
          ...data,
          sessions: data.sessions.map((session) =>
            session.id === sessionId ? { ...session, title, updatedAt } : session
          ),
        };
      };

      try {
        const success = await triggerRename({ title });
        if (!success) {
          throw new Error("Failed to update session title");
        }
        await Promise.all([
          mutate<SessionListResponse>(isUnarchivedSessionListKey, updateSessionsTitle, {
            populateCache: true,
            revalidate: true,
          }),
          mutate<SessionListResponse>(isArchivedSessionListKey, updateSessionsTitle, {
            populateCache: true,
            revalidate: false,
          }),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    [sessionId, triggerRename]
  );

  const { trigger: handleUnarchive } = useSWRMutation(
    `/api/sessions/${sessionId}/unarchive`,
    (url: BrowserApiPath) =>
      browserApiFetch(url, { method: "POST" }).then(async (r) => {
        if (r.ok) {
          await mutate<SessionListResponse>(
            isArchivedSessionListKey,
            (current) =>
              current
                ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
                : current,
            { revalidate: false, populateCache: true }
          );
          mutate(isUnarchivedSessionListKey);
        } else {
          console.error("Failed to unarchive session");
        }
      }),
    { throwOnError: false }
  );

  return { handleArchive, handleUnarchive, renameSession };
}

/**
 * Model and reasoning-effort selection derived from session state until the
 * user takes ownership of an explicit draft.
 */
function useModelSelection(sessionState: SessionState) {
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);

  const modelPicker = useModelPicker();
  const loadingEnabledModels = modelPicker.loading;
  const { model: selectedModel, reasoningEffort } = resolveModelPreference(
    modelPreferenceDraft ?? {
      model: sessionState?.model ?? DEFAULT_MODEL,
      reasoningEffort:
        sessionState?.reasoningEffort ??
        getDefaultReasoningEffort(sessionState?.model ?? DEFAULT_MODEL),
    },
    modelPicker.offeredModels,
    modelPicker.fromCatalog,
    modelPicker.reasoningByModel
  );

  const handleModelChange = useCallback((model: string) => {
    setModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
  }, []);

  const setReasoningEffort = useCallback(
    (nextReasoningEffort: string | undefined) => {
      setModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [selectedModel]
  );

  return {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    modelItems: modelPicker.items,
    needsProviderConnection: modelPicker.needsProviderConnection,
    catalogReasoning: modelPicker.reasoningByModel.get(selectedModel),
    loadingEnabledModels,
  };
}

/**
 * Prompt textarea state and handlers: submit, Cmd/Ctrl+Enter, and the
 * debounced typing indicator.
 */
function usePromptInput(
  sessionId: string,
  isProcessing: boolean,
  sendPrompt: ReturnType<typeof useSessionSocket>["sendPrompt"],
  sendTyping: ReturnType<typeof useSessionSocket>["sendTyping"],
  selectedModel: string,
  reasoningEffort: string | undefined,
  sendBlocked: boolean
) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sessionAttachments = useSessionAttachments();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const submitInFlightRef = useRef(false);

  const clearTypingTimeout = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTypingTimeout, [clearTypingTimeout]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (
      submitInFlightRef.current ||
      (!prompt.trim() && !hasAttachments) ||
      isProcessing ||
      sendBlocked ||
      sessionAttachments.isUploading
    ) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setSendError(null);
    try {
      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch {
          return;
        }
      }

      // Drop any queued typing indicator — the prompt supersedes it
      clearTypingTimeout();
      const accepted = await sendPrompt(
        prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
        selectedModel,
        reasoningEffort,
        attachments
      );
      if (!accepted) {
        // The draft stays in the box; the user only needs to be told that it
        // did not leave, and that reconnecting is what fixes it.
        setSendError("Message not sent. Reconnect and try again.");
        return;
      }

      setPrompt("");
      sessionAttachments.clearAttachments();
      // Revalidate sidebar so this session bubbles to the top
      mutate(isUnarchivedSessionListKey);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);
    setSendError(null);

    // Send typing indicator (debounced)
    clearTypingTimeout();
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping();
    }, 300);
  };

  return {
    prompt,
    sessionAttachments,
    inputRef,
    isSubmitting,
    sendError,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
  };
}
