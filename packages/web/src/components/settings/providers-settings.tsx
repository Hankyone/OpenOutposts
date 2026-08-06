"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MODEL_OPTIONS } from "@open-inspect/shared";
import {
  deleteProviderCredential,
  saveProviderApiKey,
  useProviderCredentials,
  type ProviderCredential,
} from "@/hooks/use-provider-credentials";
import { useModelCatalog } from "@/hooks/use-model-catalog";
import { formatRelativeTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Provider display names the bundled model list already implies, used when no
 * homestead has reported a catalog and there is nothing better to call a provider.
 */
const BUNDLED_PROVIDER_NAMES: ReadonlyMap<string, string> = (() => {
  const names = new Map<string, string>();
  for (const group of MODEL_OPTIONS) {
    for (const model of group.models) {
      const providerId = model.id.split("/")[0];
      if (!names.has(providerId)) names.set(providerId, group.category);
    }
  }
  return names;
})();

interface ProviderRow {
  id: string;
  name: string;
  credential: ProviderCredential | null;
  /** How many models this provider reaches, when a catalog says so. */
  modelCount: number | null;
}

function buildRows(
  credentials: ProviderCredential[],
  catalog: ReturnType<typeof useModelCatalog>["catalog"]
): ProviderRow[] {
  const byProvider = new Map<string, ProviderRow>();

  const upsert = (id: string, patch: Partial<ProviderRow>) => {
    const existing = byProvider.get(id);
    byProvider.set(id, {
      id,
      name: patch.name ?? existing?.name ?? BUNDLED_PROVIDER_NAMES.get(id) ?? id,
      credential: patch.credential ?? existing?.credential ?? null,
      modelCount: patch.modelCount ?? existing?.modelCount ?? null,
    });
  };

  if (catalog) {
    for (const provider of catalog.providers) {
      upsert(provider.id, { name: provider.name, modelCount: provider.models.length });
    }
    for (const provider of catalog.unconnectedProviders) {
      upsert(provider.id, { name: provider.name, modelCount: provider.modelCount });
    }
  } else {
    // Nothing has reported what the harness supports, so the bundled list is
    // the only guess available. It is a guess, and the page says so.
    for (const [id, name] of BUNDLED_PROVIDER_NAMES) upsert(id, { name });
  }

  // A credential always gets a row, including for a provider no catalog
  // mentions: a key the user stored must remain visible and removable.
  for (const credential of credentials) {
    upsert(credential.provider, { credential });
  }

  return Array.from(byProvider.values()).sort((a, b) => {
    if (!!a.credential !== !!b.credential) return a.credential ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** "3h" becomes "3h ago"; the helper's own "just now" already reads as a phrase. */
function since(timestamp: number): string {
  const relative = formatRelativeTime(timestamp);
  return relative === "just now" ? relative : `${relative} ago`;
}

function CredentialSummary({ credential }: { credential: ProviderCredential }) {
  const parts = [
    `added ${since(credential.updatedAt)}`,
    credential.lastUsedAt ? `used ${since(credential.lastUsedAt)}` : "never used",
  ];
  return (
    <span className="text-xs text-muted-foreground">
      {credential.label ? `${credential.label} • ` : ""}
      {parts.join(" • ")}
    </span>
  );
}

function ProviderKeyForm({
  provider,
  replacing,
  onDone,
  onCancel,
}: {
  provider: ProviderRow;
  replacing: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!apiKey.trim()) {
      toast.error("Enter an API key");
      return;
    }
    setSaving(true);
    try {
      await saveProviderApiKey({
        provider: provider.id,
        apiKey: apiKey.trim(),
        label: label.trim() || null,
      });
      // The key has left the browser and cannot be read back; drop it here
      // rather than leave it sitting in component state.
      setApiKey("");
      setLabel("");
      toast.success(replacing ? `${provider.name} key replaced` : `${provider.name} connected`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider key");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border px-4 py-3 space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`provider-key-${provider.id}`}>API key</Label>
        <Input
          id={`provider-key-${provider.id}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={replacing ? "Enter the new key" : "Paste your key"}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`provider-label-${provider.id}`}>Label (optional)</Label>
        <Input
          id={`provider-label-${provider.id}`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Personal key"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving..." : replacing ? "Replace key" : "Connect"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ProvidersSettings() {
  const { credentials, loading: loadingCredentials, mutate } = useProviderCredentials();
  const { catalog, loading: loadingCatalog } = useModelCatalog();
  const [editing, setEditing] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderRow | null>(null);

  const rows = useMemo(() => buildRows(credentials, catalog), [credentials, catalog]);

  async function remove(provider: ProviderRow) {
    try {
      await deleteProviderCredential(provider.id);
      mutate();
      toast.success(`${provider.name} key removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider key");
    }
    setRemoveTarget(null);
  }

  if (loadingCredentials || loadingCatalog) {
    return <div className="text-sm text-muted-foreground">Loading providers...</div>;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Providers</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Your sessions run on the key you add here. It belongs to your account, is encrypted at rest,
        and is never displayed again once saved.
      </p>

      {!catalog && (
        <p className="text-sm text-warning mb-6">
          No homestead has reported which providers it supports, so this list is the one the product
          ships with. A key you add now takes effect once a homestead that supports the provider
          connects.
        </p>
      )}

      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The connected homestead reported no providers, so there is nothing to connect a key to.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const isEditing = editing === row.id;
          const connected = row.credential !== null;
          return (
            <div key={row.id} className="border border-border">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{row.name}</div>
                  {row.credential ? (
                    <CredentialSummary credential={row.credential} />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {row.modelCount === null
                        ? "Not connected"
                        : `Not connected • ${row.modelCount} ${
                            row.modelCount === 1 ? "model" : "models"
                          }`}
                    </span>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1">
                  {/*
                    Every row carries the same two verbs, so the accessible
                    name has to name the provider or a screen reader hears a
                    column of identical buttons.
                  */}
                  <Button
                    size="sm"
                    variant={connected ? "ghost" : "outline"}
                    aria-label={
                      isEditing
                        ? `Cancel ${row.name} key`
                        : connected
                          ? `Replace ${row.name} key`
                          : `Connect ${row.name}`
                    }
                    onClick={() => setEditing(isEditing ? null : row.id)}
                  >
                    {isEditing ? "Cancel" : connected ? "Replace" : "Connect"}
                  </Button>
                  {connected && (
                    <Button
                      size="sm"
                      variant="destructive"
                      aria-label={`Remove ${row.name} key`}
                      onClick={() => setRemoveTarget(row)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {isEditing && (
                <ProviderKeyForm
                  provider={row}
                  replacing={connected}
                  onDone={() => {
                    setEditing(null);
                    mutate();
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          );
        })}
      </div>

      {/*
        Subscription sign-in is a real gap, not a coming-soon teaser: the
        credential record already has a place for an OAuth grant, and nothing
        issues or refreshes one. A disabled entry saying so is honest; a
        working-looking button would not be.
      */}
      <h3 className="text-sm font-medium text-foreground mt-8 mb-2">Subscription sign-in</h3>
      <div className="flex items-center justify-between gap-4 border border-border-muted px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">Sign in with a provider subscription</div>
          <span className="text-xs text-muted-foreground">
            Not built. API keys are the only credential a session can use today.
          </span>
        </div>
        <Button size="sm" variant="outline" disabled>
          Unavailable
        </Button>
      </div>

      <AlertDialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name} key</AlertDialogTitle>
            <AlertDialogDescription>
              Sessions can no longer use this provider until you add a key again. Running sessions
              lose it at their next credential refresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeTarget && remove(removeTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
