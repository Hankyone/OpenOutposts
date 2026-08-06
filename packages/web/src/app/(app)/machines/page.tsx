"use client";

import { useState } from "react";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { MachineCard } from "@/components/fleet/machine-card";
import { EnrollMachine } from "@/components/fleet/enroll-machine";
import { RemoveMachineDialog } from "@/components/fleet/remove-machine-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useOutposts, type OutpostSummary } from "@/hooks/use-outposts";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export default function MachinesPage() {
  const { isOpen } = useSidebarContext();
  const { outposts, loading, unavailable, refresh } = useOutposts();

  const [pendingRemoval, setPendingRemoval] = useState<OutpostSummary | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRemove = async (machine: OutpostSummary) => {
    setPendingRemoval(null);
    setActionError(null);
    setRemovingId(machine.id);

    try {
      const response = await browserApiFetch(`/api/outposts/${encodeURIComponent(machine.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        // The control plane's own words: it is the one that knows whether the
        // refusal was ownership, a machine that had already gone, or a lease
        // it could not release.
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? `Failed to remove ${machine.name || machine.id}`);
        return;
      }
      refresh();
    } catch (error) {
      console.error("Failed to remove outpost:", error);
      setActionError(`Failed to remove ${machine.name || machine.id}`);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-3xl font-semibold text-foreground">Machines</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every machine that runs your sessions&apos; files and commands. Agents run here in the
              control plane; only the work touches these.
            </p>
          </div>

          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          {unavailable && (
            <ErrorBanner className="mb-4" role="alert">
              Unable to load your machines. A deployment that does not yet record which account owns
              a machine refuses the listing rather than showing you someone else&apos;s.
            </ErrorBanner>
          )}

          {loading && !unavailable ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {outposts.map((machine) => (
                <MachineCard
                  key={machine.id}
                  machine={machine}
                  onRemove={setPendingRemoval}
                  removing={removingId === machine.id}
                />
              ))}
              {!unavailable && outposts.length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">No machines yet.</p>
              )}
            </div>
          )}

          <RemoveMachineDialog
            machineName={pendingRemoval && (pendingRemoval.name || pendingRemoval.id)}
            onOpenChange={(open) => {
              if (!open) setPendingRemoval(null);
            }}
            onConfirm={() => {
              if (pendingRemoval) void handleRemove(pendingRemoval);
            }}
          />

          <EnrollMachine onEnrolled={refresh} />
        </div>
      </div>
    </div>
  );
}
