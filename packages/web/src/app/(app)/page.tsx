"use client";

import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { APP_NAME } from "@/lib/site-config";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
import { useModelPicker } from "@/hooks/use-model-picker";
import type { CatalogModelReasoning } from "@/hooks/use-model-catalog";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import {
  ATTACHMENT_ACCEPT,
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import {
  useSessionTargetPicker,
  type SessionTargetSelection,
} from "@/hooks/use-session-target-picker";
import { SessionTargetPicker } from "@/components/session-target-picker";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { ModelPicker } from "@/components/model-picker";
import { PaperclipIcon, SendIcon } from "@/components/ui/icons";
import type { ComboboxGroup } from "@/components/ui/combobox";

const LAST_SELECTED_MODEL_STORAGE_KEY = "openoutposts-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "openoutposts-last-selected-reasoning-effort";

export default function Home() {
  const { data: session } = useAuthSession();
  const router = useRouter();
  const picker = useSessionTargetPicker();
  const { sessionTarget, selectedBranch, configKey, buildRequestFields, isLaunchable } = picker;
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [prompt, setPrompt] = useState("");
  const sessionAttachments = useSessionAttachments();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const submitInFlightRef = useRef(false);
  // Keyed by the picker's configKey so environment/ad-hoc selections
  // invalidate an in-flight creation exactly like repo/branch changes do.
  const pendingConfigRef = useRef<{
    target: string;
    model: string;
    reasoningEffort?: string;
    branch: string;
  } | null>(null);
  const hasHydratedModelPreferencesRef = useRef(false);
  const modelPicker = useModelPicker();
  const loadingEnabledModels = modelPicker.loading;

  useEffect(() => {
    if (hasHydratedModelPreferencesRef.current) return;

    const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const storedReasoningEffort = localStorage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    setStoredPreference({
      model: storedModel ?? DEFAULT_MODEL,
      reasoningEffort: storedReasoningEffort ?? undefined,
    });
    hasHydratedModelPreferencesRef.current = true;
  }, []);

  const { model: selectedModel, reasoningEffort } = resolveModelPreference(
    modelPreferenceDraft ?? storedPreference,
    modelPicker.offeredModels,
    modelPicker.fromCatalog,
    modelPicker.reasoningByModel
  );

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPendingSessionId(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    pendingConfigRef.current = null;
  }, [sessionTarget, selectedModel, reasoningEffort, selectedBranch]);

  /**
   * Creates the session row. Called only from submit: a session is a durable
   * control-plane object that shows up in the sidebar, so a keystroke must not
   * mint one — an abandoned draft or a change of target would strand it there
   * with no way for the user to know why it exists.
   */
  const createSession = useCallback(async () => {
    if (loadingEnabledModels) return null;
    if (pendingSessionId) return pendingSessionId;
    if (sessionCreationPromise.current) return sessionCreationPromise.current;
    const targetRequestFields = buildRequestFields();
    if (!targetRequestFields) return null;

    setIsCreatingSession(true);
    const currentConfig = {
      target: configKey,
      model: selectedModel,
      reasoningEffort,
      branch: sessionTarget?.kind === "repo" ? selectedBranch : "",
    };
    pendingConfigRef.current = currentConfig;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const promise = (async () => {
      try {
        const res = await browserApiFetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...targetRequestFields,
            model: selectedModel,
            reasoningEffort,
          }),
          signal: abortController.signal,
        });

        if (res.ok) {
          const data = await res.json();
          if (
            pendingConfigRef.current?.target === currentConfig.target &&
            pendingConfigRef.current?.model === currentConfig.model &&
            pendingConfigRef.current?.reasoningEffort === currentConfig.reasoningEffort &&
            pendingConfigRef.current?.branch === currentConfig.branch
          ) {
            setPendingSessionId(data.sessionId);
            return data.sessionId as string;
          }
          return null;
        }
        return null;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return null;
        }
        console.error("Failed to create session:", error);
        return null;
      } finally {
        if (abortControllerRef.current === abortController) {
          setIsCreatingSession(false);
          sessionCreationPromise.current = null;
          abortControllerRef.current = null;
        }
      }
    })();

    sessionCreationPromise.current = promise;
    return promise;
  }, [
    sessionTarget,
    selectedBranch,
    configKey,
    buildRequestFields,
    selectedModel,
    reasoningEffort,
    pendingSessionId,
    loadingEnabledModels,
  ]);

  const saveModelPreferenceDraft = useCallback((preference: ModelPreference) => {
    setModelPreferenceDraft(preference);
    localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, preference.model);
    if (preference.reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, preference.reasoningEffort);
    } else {
      localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    }
  }, []);

  const handleModelChange = useCallback(
    (model: string) => {
      saveModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
    },
    [saveModelPreferenceDraft]
  );

  const handleReasoningEffortChange = useCallback(
    (nextReasoningEffort: string | undefined) => {
      saveModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [saveModelPreferenceDraft, selectedModel]
  );

  const handlePromptChange = (value: string) => {
    setPrompt(value);
  };

  const handleAddFiles = (files: Iterable<File>) => {
    sessionAttachments.addFiles(files);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current || sessionAttachments.isUploading || loadingEnabledModels) return;
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (!prompt.trim() && !hasAttachments) return;
    if (!isLaunchable) {
      setError(
        sessionTarget?.kind === "repos"
          ? "Select at least one repository"
          : "Please select a repository or environment"
      );
      return;
    }

    submitInFlightRef.current = true;
    setCreating(true);
    setError("");

    try {
      let sessionId = pendingSessionId;
      if (!sessionId) {
        sessionId = await createSession();
      }

      if (!sessionId) {
        setError("Failed to create session");
        return;
      }

      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch {
          return;
        }
      }

      const res = await browserApiFetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
          model: selectedModel,
          reasoningEffort,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      });

      if (res.ok) {
        sessionAttachments.clearAttachments();
        mutate(isUnarchivedSessionListKey);
        router.push(`/session/${sessionId}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send prompt");
        setCreating(false);
      }
    } catch (_error) {
      setError("Failed to create session");
    } finally {
      submitInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <HomeContent
      isAuthenticated={!!session}
      picker={picker}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={handleReasoningEffortChange}
      prompt={prompt}
      handlePromptChange={handlePromptChange}
      attachments={{
        items: sessionAttachments.attachments,
        error: sessionAttachments.attachmentError,
        isUploading: sessionAttachments.isUploading,
        onAdd: handleAddFiles,
        onRemove: sessionAttachments.removeAttachment,
      }}
      creating={creating}
      isCreatingSession={isCreatingSession}
      loadingEnabledModels={loadingEnabledModels}
      error={error}
      handleSubmit={handleSubmit}
      modelOptions={modelPicker.items}
      needsProviderConnection={modelPicker.needsProviderConnection}
      catalogReasoning={modelPicker.reasoningByModel.get(selectedModel)}
    />
  );
}

function HomeContent({
  isAuthenticated,
  picker,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  prompt,
  handlePromptChange,
  attachments,
  creating,
  isCreatingSession,
  loadingEnabledModels,
  error,
  handleSubmit,
  modelOptions,
  needsProviderConnection,
  catalogReasoning,
}: {
  isAuthenticated: boolean;
  picker: SessionTargetSelection;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  reasoningEffort: string | undefined;
  setReasoningEffort: (value: string | undefined) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  attachments: {
    items: ReturnType<typeof useSessionAttachments>["attachments"];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  creating: boolean;
  isCreatingSession: boolean;
  /** The model list is still resolving, so a prompt cannot name a model yet. */
  loadingEnabledModels: boolean;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
  modelOptions: ComboboxGroup[];
  needsProviderConnection: boolean;
  /** The selected model's reasoning support, when the harness catalog names it. */
  catalogReasoning: CatalogModelReasoning | null | undefined;
}) {
  const { isOpen } = useSidebarContext();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsLocked = creating || attachments.isUploading;
  const {
    isDraggingOver,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = useAttachmentDropZone({ locked: attachmentsLocked, onAdd: attachments.onAdd });
  const { sessionTarget, repos, loadingRepos, isLaunchable } = picker;
  const sendLabel = loadingEnabledModels
    ? "Loading models…"
    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to {APP_NAME}</h1>
            {isAuthenticated ? (
              <p className="text-muted-foreground">
                Ask a question or describe what you want to build
              </p>
            ) : (
              <p className="text-muted-foreground">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

              <div
                className={`border border-border bg-input ${isDraggingOver ? "ring-2 ring-accent" : ""}`}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <AttachmentPreviewStrip
                  items={attachments.items}
                  error={attachments.error}
                  onRemove={attachments.onRemove}
                  disabled={attachmentsLocked}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                {/* Text input area */}
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="What do you want to build?"
                    autoComplete="off"
                    disabled={creating}
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {isCreatingSession && (
                      <span className="whitespace-nowrap text-xs text-accent">
                        Starting session...
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachmentsLocked}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title="Attach images"
                      aria-label="Attach images"
                    >
                      <PaperclipIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && attachments.items.length === 0) ||
                        attachmentsLocked ||
                        loadingEnabledModels ||
                        !isLaunchable
                      }
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title={sendLabel}
                      aria-label={sendLabel}
                    >
                      {creating ? (
                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <SendIcon className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Footer row with target and model selectors */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                  {/* Left side - Target selector + Model selector */}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    <SessionTargetPicker {...picker.pickerProps} disabled={creating} />

                    {/* Model selector */}
                    <ModelPicker
                      selectedModel={selectedModel}
                      onSelect={setSelectedModel}
                      items={modelOptions}
                      disabled={creating}
                      needsProviderConnection={needsProviderConnection}
                    />

                    {/* Reasoning effort pills */}
                    <ReasoningEffortPills
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      onSelect={setReasoningEffort}
                      disabled={creating}
                      catalogReasoning={catalogReasoning}
                    />
                  </div>

                  {/* Right side - Agent label */}
                  <span className="hidden sm:inline text-sm text-muted-foreground">
                    build agent
                  </span>
                </div>
              </div>

              {sessionTarget?.kind === "repos" && (
                <p className="mt-3 text-xs text-muted-foreground text-center">
                  <Link href="/settings?tab=environments" className="text-accent hover:underline">
                    Save this repository set as an environment
                  </Link>
                  .
                </p>
              )}

              {repos.length === 0 && !loadingRepos && (
                <p className="mt-3 text-sm text-muted-foreground text-center">
                  No repositories found. You can start without a repository or grant repository
                  access in settings.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
