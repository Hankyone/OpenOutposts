"use client";

/**
 * Connection state for one machine, rendered the same way everywhere the fleet
 * appears. The reachability rule itself lives with the session view's target
 * derivation so the machines page and the session header can never disagree
 * about whether a machine is answering.
 */

import {
  resolveOutpostReachability,
  type OutpostReachability,
} from "@/lib/session-execution-target";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const REACHABILITY_LABELS: Record<OutpostReachability, string> = {
  connected: "Connected",
  stale: "No heartbeat",
  offline: "Offline",
  unknown: "Unknown",
};

const REACHABILITY_DOT_CLASSES: Record<OutpostReachability, string> = {
  connected: "bg-success",
  stale: "bg-warning",
  offline: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};

const REACHABILITY_TEXT_CLASSES: Record<OutpostReachability, string> = {
  connected: "text-success",
  stale: "text-warning",
  offline: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

interface MachineStatusProps {
  connected: boolean;
  /** ISO timestamp of the machine's last recorded heartbeat. */
  lastSeenAt: string;
  className?: string;
}

export function MachineStatus({ connected, lastSeenAt, className }: MachineStatusProps) {
  const reachability = resolveOutpostReachability({ connected, lastSeenAt }, Date.now());

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        REACHABILITY_TEXT_CLASSES[reachability],
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn("w-2 h-2 rounded-full", REACHABILITY_DOT_CLASSES[reachability])}
      />
      {REACHABILITY_LABELS[reachability]}
    </span>
  );
}

/**
 * How long ago the fleet directory last heard from a machine.
 *
 * The directory is refreshed on register and disconnect and only every few
 * minutes in between, so this is deliberately coarse — the exact timestamp is
 * on the hover title for anyone who needs it.
 */
export function MachineHeartbeat({ lastSeenAt, className }: Omit<MachineStatusProps, "connected">) {
  const parsed = Date.parse(lastSeenAt);
  if (Number.isNaN(parsed)) {
    return <span className={cn("text-xs text-muted-foreground", className)}>Never</span>;
  }

  const age = formatRelativeTime(parsed);
  return (
    <span
      className={cn("text-xs text-muted-foreground", className)}
      title={new Date(parsed).toLocaleString()}
    >
      {age === "just now" ? age : `${age} ago`}
    </span>
  );
}
