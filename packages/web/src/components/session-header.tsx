"use client";

import { useEffect, useState, type RefObject } from "react";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { MobileSessionActions } from "@/components/mobile-session-actions";
import type { SessionActionProps } from "@/components/session-actions";
import type { useSessionSocket } from "@/hooks/use-session-socket";
import { formatRepoLabel } from "@/lib/repo-label";
import { formatModelName } from "@/lib/format";
import {
  describeExecutionTarget,
  type ExecutionTargetDisplay,
  type SessionExecutionTarget,
} from "@/lib/session-execution-target";

type SessionSocketState = ReturnType<typeof useSessionSocket>;

const TONE_TEXT_CLASSES: Record<ExecutionTargetDisplay["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  accent: "text-accent",
  muted: "text-muted-foreground",
};

const TONE_DOT_CLASSES: Record<ExecutionTargetDisplay["tone"], string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  accent: "bg-accent",
  muted: "bg-muted-foreground",
};

export type SessionHeaderProps = {
  sessionState: SessionSocketState["sessionState"];
  fallbackSessionInfo: {
    repoOwner: string | null;
    repoName: string | null;
    title: string | null;
  };
  /** Which machine (or sandbox) this session executes on, and its heartbeat. */
  executionTarget: SessionExecutionTarget;
  connected: boolean;
  connecting: boolean;
  isDetailsOpen: boolean;
  detailsButtonRef: RefObject<HTMLButtonElement | null>;
  actionsButtonRef: RefObject<HTMLButtonElement | null>;
  onToggleDetails: () => void;
  onOpenMobileDetails: () => void;
  actions: SessionActionProps;
  renameSession: (title: string) => Promise<boolean | undefined>;
};

export function SessionHeader({
  sessionState,
  fallbackSessionInfo,
  executionTarget,
  connected,
  connecting,
  isDetailsOpen,
  detailsButtonRef,
  actionsButtonRef,
  onToggleDetails,
  onOpenMobileDetails,
  actions,
  renameSession,
}: SessionHeaderProps) {
  const { isOpen } = useSidebarContext();
  const targetDisplay = describeExecutionTarget(executionTarget);
  const hasFallbackSessionInfo =
    fallbackSessionInfo.repoOwner !== null ||
    fallbackSessionInfo.repoName !== null ||
    fallbackSessionInfo.title !== null;
  const repoLabel = sessionState
    ? formatRepoLabel(sessionState.repoOwner, sessionState.repoName)
    : hasFallbackSessionInfo
      ? formatRepoLabel(fallbackSessionInfo.repoOwner, fallbackSessionInfo.repoName)
      : "Loading session...";
  const baseResolvedTitle = sessionState?.title ?? fallbackSessionInfo.title ?? repoLabel;

  const [isRenaming, setIsRenaming] = useState(false);
  const [title, setTitle] = useState(baseResolvedTitle);
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);

  const resolvedTitle =
    optimisticTitle ?? sessionState?.title ?? fallbackSessionInfo.title ?? repoLabel;

  const handleStartRename = () => {
    setTitle(resolvedTitle);
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!sessionState) {
      setIsRenaming(false);
      return;
    }

    const trimmed = title.trim();

    if (!trimmed || trimmed === resolvedTitle) {
      setIsRenaming(false);
      return;
    }

    const previousTitle = resolvedTitle;
    setIsRenaming(false);
    setOptimisticTitle(trimmed);

    const success = await renameSession(trimmed);
    if (!success) {
      setOptimisticTitle(null);
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  useEffect(() => {
    if (!optimisticTitle) return;
    if (sessionState?.title === optimisticTitle) {
      setOptimisticTitle(null);
    }
  }, [optimisticTitle, sessionState?.title]);

  useEffect(() => {
    if (!isRenaming) setTitle(sessionState?.title ?? fallbackSessionInfo.title ?? "");
  }, [fallbackSessionInfo.title, sessionState?.title, isRenaming]);

  return (
    <header className="border-b border-border-muted flex-shrink-0">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!isOpen && <CollapsedSidebarControls />}
          <div>
            {isRenaming ? (
              <input
                autoFocus
                aria-label="Session title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={handleRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                  if (e.key === "Escape") {
                    setIsRenaming(false);
                  }
                }}
                className="text-sm bg-transparent text-foreground outline-none focus:ring-inset focus:ring-ring font-medium max-w-40 truncate"
              />
            ) : (
              <h1
                className="text-sm font-medium text-foreground max-w-40 truncate cursor-text"
                onClick={handleStartRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleStartRename();
                  }
                }}
                role="button"
                tabIndex={0}
                title="Click to rename"
              >
                {resolvedTitle}
              </h1>
            )}
            <p className="text-sm text-muted-foreground">{repoLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            ref={detailsButtonRef}
            type="button"
            onClick={onToggleDetails}
            className="hidden md:block lg:hidden px-3 py-1.5 text-sm text-muted-foreground border border-border-muted hover:text-foreground hover:bg-muted transition"
            aria-label="Toggle session details"
            aria-controls="session-details-dialog"
            aria-expanded={isDetailsOpen}
          >
            Details
          </button>
          <MobileSessionActions
            {...actions}
            triggerRef={actionsButtonRef}
            onOpenDetails={onOpenMobileDetails}
            onOpenMedia={onOpenMobileDetails}
          />
          <div className="md:hidden">
            <CombinedStatusDot
              connected={connected}
              connecting={connecting}
              targetDisplay={targetDisplay}
            />
          </div>
          <div className="hidden md:contents">
            <ConnectionStatus connected={connected} connecting={connecting} />
            <ExecutionTargetStatus display={targetDisplay} />
            <ModelStatus
              model={sessionState?.model}
              reasoningEffort={sessionState?.reasoningEffort}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

function ConnectionStatus({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  if (connecting) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        Connecting...
      </span>
    );
  }

  if (connected) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <span className="w-2 h-2 rounded-full bg-success" />
        Connected
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <span className="w-2 h-2 rounded-full bg-destructive" />
      Disconnected
    </span>
  );
}

/**
 * Where this session's work actually happens: the bound machine and its
 * heartbeat, or the session's own lifecycle while no machine is named.
 */
function ExecutionTargetStatus({ display }: { display: ExecutionTargetDisplay | null }) {
  if (!display) return null;

  return (
    <span
      className={`flex items-center gap-1 text-xs ${TONE_TEXT_CLASSES[display.tone]}`}
      title={display.detail ?? undefined}
    >
      <span className={`w-2 h-2 rounded-full ${TONE_DOT_CLASSES[display.tone]}`} />
      {display.label}
    </span>
  );
}

function ModelStatus({ model, reasoningEffort }: { model?: string; reasoningEffort?: string }) {
  if (!model) return null;

  return (
    <span className="text-xs text-muted-foreground" title={model}>
      {formatModelName(model)}
      {reasoningEffort && <span>{` \u00b7 ${reasoningEffort}`}</span>}
    </span>
  );
}

function CombinedStatusDot({
  connected,
  connecting,
  targetDisplay,
}: {
  connected: boolean;
  connecting: boolean;
  targetDisplay: ExecutionTargetDisplay | null;
}) {
  let color: string;
  let pulse = false;
  let label: string;

  if (!connected && !connecting) {
    color = "bg-destructive";
    label = "Disconnected";
  } else if (connecting) {
    color = "bg-warning";
    pulse = true;
    label = "Connecting...";
  } else if (targetDisplay) {
    // The execution target dominates: a live browser socket is no comfort
    // while the machine running the work is unreachable.
    color = TONE_DOT_CLASSES[targetDisplay.tone];
    label = `Connected \u00b7 ${targetDisplay.label}`;
  } else {
    color = "bg-success";
    label = "Connected";
  }

  return (
    <span title={label} className="flex items-center">
      <span className={`w-2.5 h-2.5 rounded-full ${color}${pulse ? " animate-pulse" : ""}`} />
    </span>
  );
}
