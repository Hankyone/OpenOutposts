/**
 * Fleet-centric session status.
 *
 * Every session executes on an outpost — a machine the user owns. The session
 * view answers the question the user actually has — which machine is running
 * this, and is that machine currently reachable — so the machine's own
 * heartbeat is what the status reports. A session that has not yet been bound
 * to a machine can only report its own lifecycle, and says so.
 */

import type { SandboxStatus, SessionState } from "@open-inspect/shared";
import type { OutpostSummary } from "@/hooks/use-outposts";

/**
 * How stale a heartbeat may be before the machine is reported as unreachable.
 * Mirrors the control plane's own liveness rule: three missed 15s beats.
 */
export const OUTPOST_HEARTBEAT_STALE_AFTER_MS = 45_000;

export type OutpostReachability = "connected" | "stale" | "offline" | "unknown";

export type SessionExecutionTarget =
  /** No session state yet — nothing truthful to say about the target. */
  | { kind: "unknown" }
  /**
   * The session names no machine yet. It still executes on an outpost; the
   * only thing the view can honestly report is the session's own lifecycle.
   */
  | { kind: "unassigned"; status: SandboxStatus }
  | {
      kind: "outpost";
      outpostId: string;
      /** The fleet name when known, otherwise the raw id. */
      name: string;
      /**
       * Whether the fleet listing described this machine. False when the
       * listing is unavailable or no longer contains the id — the session
       * still names its machine, but claims nothing about its heartbeat.
       */
      described: boolean;
      reachability: OutpostReachability;
      lastSeenAt: number | null;
      platform: string | null;
      workerVersion: string | null;
    };

/**
 * The machine's reachability from its directory row: a row that claims a live
 * connection is trusted only while its heartbeat is fresh, so a control plane
 * that has not yet noticed a dropped socket cannot make a dead machine look
 * connected.
 */
export function resolveOutpostReachability(
  outpost: Pick<OutpostSummary, "connected" | "lastSeenAt">,
  now: number
): OutpostReachability {
  if (!outpost.connected) return "offline";
  const lastSeenAt = parseTimestamp(outpost.lastSeenAt);
  if (lastSeenAt === null) return "unknown";
  return now - lastSeenAt > OUTPOST_HEARTBEAT_STALE_AFTER_MS ? "stale" : "connected";
}

/**
 * Derive the session's execution target from its state and the fleet listing.
 *
 * Consumes the listing defensively: it may be empty because the deployment
 * has no machines, because the request was refused, or because the machine
 * was un-enrolled after the session launched. None of those let us describe
 * a heartbeat, and none of them make the session's own machine id wrong.
 */
export function deriveSessionExecutionTarget(
  sessionState: Pick<SessionState, "sandboxStatus" | "outpostId"> | null,
  outposts: OutpostSummary[],
  now: number = Date.now()
): SessionExecutionTarget {
  if (!sessionState) return { kind: "unknown" };

  const outpostId = sessionState.outpostId ?? null;
  if (!outpostId) return { kind: "unassigned", status: sessionState.sandboxStatus };

  const outpost = outposts.find((candidate) => candidate.id === outpostId);
  if (!outpost) {
    return {
      kind: "outpost",
      outpostId,
      name: outpostId,
      described: false,
      reachability: "unknown",
      lastSeenAt: null,
      platform: null,
      workerVersion: null,
    };
  }

  return {
    kind: "outpost",
    outpostId,
    name: outpost.name || outpostId,
    described: true,
    reachability: resolveOutpostReachability(outpost, now),
    lastSeenAt: parseTimestamp(outpost.lastSeenAt),
    platform: outpost.platform || null,
    workerVersion: outpost.workerVersion ?? null,
  };
}

export interface ExecutionTargetDisplay {
  /** Short status text for the header row. */
  label: string;
  /** Longer text for the hover title, or null when the label says it all. */
  detail: string | null;
  tone: "success" | "warning" | "destructive" | "muted" | "accent";
}

/**
 * Tone for the session's own lifecycle, which is all an unbound session can
 * report. Covers every `SandboxStatus` the control plane can send; an
 * unrecognized one falls back to muted rather than claiming health.
 */
const SESSION_LIFECYCLE_TONES: Record<SandboxStatus, ExecutionTargetDisplay["tone"]> = {
  pending: "muted",
  spawning: "warning",
  connecting: "warning",
  warming: "warning",
  syncing: "accent",
  ready: "success",
  running: "accent",
  stale: "muted",
  snapshotting: "accent",
  stopped: "muted",
  failed: "destructive",
};

const REACHABILITY_TEXT: Record<OutpostReachability, string> = {
  connected: "connected",
  stale: "no heartbeat",
  offline: "offline",
  unknown: "connection unknown",
};

const REACHABILITY_TONES: Record<OutpostReachability, ExecutionTargetDisplay["tone"]> = {
  connected: "success",
  stale: "warning",
  offline: "destructive",
  unknown: "muted",
};

/** Render-ready label, tone, and hover detail for an execution target. */
export function describeExecutionTarget(
  target: SessionExecutionTarget
): ExecutionTargetDisplay | null {
  switch (target.kind) {
    case "unknown":
      return null;
    case "unassigned":
      return {
        label: `Outpost · ${target.status}`,
        detail: "Running on an outpost. This session has not named which machine yet.",
        tone: SESSION_LIFECYCLE_TONES[target.status] ?? "muted",
      };
    case "outpost": {
      const parts = [target.described ? target.outpostId : "Not in your machine list"];
      if (target.platform) parts.push(target.platform);
      if (target.workerVersion) parts.push(`worker ${target.workerVersion}`);
      return {
        label: `${target.name} · ${REACHABILITY_TEXT[target.reachability]}`,
        detail: parts.join(" · "),
        tone: REACHABILITY_TONES[target.reachability],
      };
    }
  }
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
