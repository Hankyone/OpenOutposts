import { useEffect, useMemo, useState } from "react";
import type { SessionState } from "@open-inspect/shared";
import { useOutposts } from "@/hooks/use-outposts";
import {
  deriveSessionExecutionTarget,
  type SessionExecutionTarget,
} from "@/lib/session-execution-target";

/**
 * How often the derived status re-evaluates the heartbeat. Matches the fleet
 * poll: without its own tick, a machine that simply stops beating would keep
 * rendering as connected, because an unchanged listing produces no re-render.
 */
const HEARTBEAT_TICK_MS = 15_000;

/**
 * The machine (or sandbox) this session executes on, with its current
 * heartbeat. Re-derives both when the fleet listing changes and on a tick, so
 * a machine that goes quiet stops being reported as connected.
 */
export function useSessionExecutionTarget(
  sessionState: Pick<SessionState, "sandboxStatus" | "outpostId"> | null
): SessionExecutionTarget {
  const { outposts } = useOutposts();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), HEARTBEAT_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return useMemo(
    () => deriveSessionExecutionTarget(sessionState, outposts, now),
    [sessionState, outposts, now]
  );
}
