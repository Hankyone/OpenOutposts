"use client";

/**
 * One machine in the fleet list: who it is, whether it is answering, what it
 * is running, and the way to remove it.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MachineHeartbeat, MachineStatus } from "@/components/fleet/machine-status";
import { useOutpostBoundSessions, type OutpostSummary } from "@/hooks/use-outposts";

interface MachineCardProps {
  machine: OutpostSummary;
  onRemove: (machine: OutpostSummary) => void;
  removing: boolean;
}

export function MachineCard({ machine, onRemove, removing }: MachineCardProps) {
  const bound = useOutpostBoundSessions(machine.id);
  const platform = [machine.platform, machine.architecture].filter(Boolean).join("/");

  return (
    <div className="border border-border-muted rounded-md px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground truncate">
              {machine.name || machine.id}
            </h2>
            <MachineStatus connected={machine.connected} lastSeenAt={machine.lastSeenAt} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">{machine.id}</p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => onRemove(machine)}
          disabled={removing}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Platform</dt>
          <dd className="text-xs text-foreground">{platform || "Unknown"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Worker version</dt>
          <dd className="text-xs text-foreground font-mono">
            {machine.workerVersion ?? "Unknown"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Last heartbeat</dt>
          <dd>
            <MachineHeartbeat lastSeenAt={machine.lastSeenAt} />
          </dd>
        </div>
      </dl>

      <div className="mt-3 border-t border-border-muted pt-3">
        <h3 className="text-xs text-muted-foreground">Bound sessions</h3>
        <BoundSessions {...bound} />
      </div>
    </div>
  );
}

function BoundSessions({
  sessions,
  loading,
  unavailable,
}: ReturnType<typeof useOutpostBoundSessions>) {
  if (unavailable) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        This control plane does not report bindings for your account, so what this machine is
        running cannot be shown here.
      </p>
    );
  }

  if (loading) {
    return <p className="mt-1 text-xs text-muted-foreground">Loading…</p>;
  }

  if (sessions.length === 0) {
    return (
      <p className="mt-1 text-xs text-muted-foreground">Nothing is running on this machine.</p>
    );
  }

  return (
    <ul className="mt-1 flex flex-col gap-1">
      {sessions.map((session) => (
        <li key={session.leaseId} className="flex items-baseline gap-2 text-xs">
          <Link
            href={`/session/${session.productSessionId}`}
            className="font-mono text-accent hover:underline truncate"
          >
            {session.productSessionId}
          </Link>
          <span className="text-muted-foreground font-mono truncate">{session.workspacePath}</span>
        </li>
      ))}
    </ul>
  );
}
