"use client";

import { useState } from "react";
import { mutate } from "swr";
import { toast } from "sonner";
import type { Environment } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatSessionRepositoriesLabel } from "@/lib/repo-label";
import { useEnvironments, ENVIRONMENTS_KEY } from "@/hooks/use-environments";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { EnvironmentForm, type EnvironmentFormValues } from "./environment-form";

type View = { mode: "list" } | { mode: "create" } | { mode: "edit"; environmentId: string };

export function EnvironmentsSettings() {
  const { environments, loading } = useEnvironments();
  const [view, setView] = useState<View>({ mode: "list" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async (values: EnvironmentFormValues) => {
    setSubmitting(true);
    setError("");
    try {
      const response = await browserApiFetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to create environment");
        return;
      }
      // Await the revalidation: the edit view resolves the environment from
      // the SWR cache, so switching before it refreshes flashes "not found".
      await mutate(ENVIRONMENTS_KEY);
      toast.success(`Created ${values.name}`);
      const createdId = data?.environment?.id;
      setView(createdId ? { mode: "edit", environmentId: createdId } : { mode: "list" });
    } catch {
      setError("Failed to create environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (environmentId: string, values: EnvironmentFormValues) => {
    setSubmitting(true);
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environmentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error || "Failed to update environment");
        return;
      }
      mutate(ENVIRONMENTS_KEY);
      toast.success(`Saved ${values.name}`);
      setView({ mode: "list" });
    } catch {
      setError("Failed to update environment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (environment: Environment) => {
    setError("");
    try {
      const response = await browserApiFetch(`/api/environments/${environment.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json();
        setError(data?.error || "Failed to delete environment");
        return;
      }
      mutate(ENVIRONMENTS_KEY);
      toast.success(`Deleted ${environment.name}`);
    } catch {
      setError("Failed to delete environment");
    }
  };

  if (view.mode === "create") {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">New Environment</h2>
        <p className="text-sm text-muted-foreground mb-6">
          A named set of repositories that launch together in one workspace.
        </p>
        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}
        <EnvironmentForm
          mode="create"
          onSubmit={handleCreate}
          onCancel={() => setView({ mode: "list" })}
          submitting={submitting}
        />
      </div>
    );
  }

  if (view.mode === "edit") {
    const environment = environments.find((entry) => entry.id === view.environmentId);
    if (!environment) {
      return (
        <div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading environment...</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-3">Environment not found.</p>
              <Button variant="outline" size="xs" onClick={() => setView({ mode: "list" })}>
                Back to environments
              </Button>
            </>
          )}
        </div>
      );
    }

    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">{environment.name}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {environment.description || "Edit this environment."}
        </p>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        <EnvironmentForm
          mode="edit"
          initialValues={environment}
          onSubmit={(values) => handleUpdate(environment.id, values)}
          onCancel={() => setView({ mode: "list" })}
          submitting={submitting}
        />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-semibold text-foreground">Environments</h2>
          <Button size="xs" onClick={() => setView({ mode: "create" })}>
            New environment
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-6">
          Named repository sets that launch together in one workspace.
        </p>

        {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

        {loading && <p className="text-sm text-muted-foreground">Loading environments...</p>}

        {!loading && environments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No environments yet. Create one to launch multi-repository sessions.
          </p>
        )}

        <div className="space-y-2">
          {environments.map((environment) => {
            return (
              <div key={environment.id} className="border border-border px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {environment.name}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {formatSessionRepositoriesLabel(null, null, environment.repositories)}
                      </span>
                    </div>
                    {environment.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {environment.description}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setView({
                          mode: "edit",
                          environmentId: environment.id,
                        })
                      }
                    >
                      Edit
                    </Button>
                    {confirmDeleteId === environment.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="destructive"
                          size="xs"
                          onClick={() => {
                            handleDelete(environment);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Confirm
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => setConfirmDeleteId(environment.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
