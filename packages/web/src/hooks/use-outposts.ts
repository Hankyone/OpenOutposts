import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";

/**
 * Poll cadence for the fleet listing. Outposts heartbeat every 15s, so a
 * 15s refresh keeps a rendered connection state at most one missed beat old.
 */
const OUTPOSTS_REFRESH_INTERVAL_MS = 15_000;

export interface OutpostSummary {
  id: string;
  name: string;
  platform: string;
  architecture: string;
  connected: boolean;
  lastSeenAt: string;
  /** Absent on control planes that predate the field in the listing. */
  workerVersion?: string;
  disconnectedAt?: string | null;
}

interface ListOutpostsResponse {
  outposts: OutpostSummary[];
}

export const OUTPOSTS_KEY = "/api/outposts";

/**
 * The enrolled outposts this user can see. Empty for deployments that run on
 * managed sandboxes only — the picker hides its outpost group then.
 *
 * The listing is also refused (rather than filtered) when the control plane
 * cannot attribute machines to the caller, so `unavailable` distinguishes
 * "no machines" from "cannot say": callers that name a specific machine fall
 * back to its id instead of claiming it is missing.
 */
export function useOutposts(): {
  outposts: OutpostSummary[];
  loading: boolean;
  unavailable: boolean;
  refresh: () => void;
} {
  const { data: session, status } = useAuthSession();

  const { data, error, isLoading, mutate } = useSWR<ListOutpostsResponse>(
    session ? OUTPOSTS_KEY : null,
    { refreshInterval: OUTPOSTS_REFRESH_INTERVAL_MS }
  );

  return {
    outposts: data?.outposts ?? [],
    loading: status === "loading" || isLoading,
    unavailable: Boolean(error),
    refresh: () => {
      void mutate();
    },
  };
}

/** One product session currently holding a lease on a machine. */
export interface OutpostBoundSession {
  leaseId: string;
  productSessionId: string;
  workspacePath: string;
  expiresAt: string;
}

interface ListBoundSessionsResponse {
  sessions: OutpostBoundSession[];
  /** Live Durable Object status, unlike the advisory fleet directory row. */
  connected?: boolean;
  lastHeartbeatAt?: string | null;
}

/**
 * The sessions currently bound to one machine.
 *
 * Separate from the listing because bindings live in the machine's own Durable
 * Object rather than the fleet directory. `unavailable` is the honest answer
 * when the control plane will not report them: a machine with nothing bound
 * and a machine we cannot ask about must not render the same way.
 */
export function useOutpostBoundSessions(outpostId: string | null): {
  sessions: OutpostBoundSession[];
  connected: boolean | null;
  lastHeartbeatAt: string | null;
  loading: boolean;
  unavailable: boolean;
} {
  const { data: session } = useAuthSession();

  const { data, error, isLoading } = useSWR<ListBoundSessionsResponse>(
    session && outpostId ? `/api/outposts/${encodeURIComponent(outpostId)}/sessions` : null,
    { refreshInterval: OUTPOSTS_REFRESH_INTERVAL_MS }
  );

  return {
    sessions: data?.sessions ?? [],
    connected: data?.connected ?? null,
    lastHeartbeatAt: data?.lastHeartbeatAt ?? null,
    loading: isLoading,
    unavailable: Boolean(error),
  };
}
