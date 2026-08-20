"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MODEL_OPTIONS } from "@open-inspect/shared";
import {
  cancelProviderOAuth,
  completeProviderOAuth,
  deleteProviderCredential,
  pollProviderOAuth,
  saveProviderApiKey,
  startProviderOAuth,
  useProviderCredentials,
  useProviderOAuthMethods,
  type ProviderCredential,
  type ProviderOAuthMethod,
  type ProviderOAuthStart,
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
  signIn: ProviderOAuthMethod | null;
}

function buildRows(
  credentials: ProviderCredential[],
  catalog: ReturnType<typeof useModelCatalog>["catalog"],
  methods: ProviderOAuthMethod[]
): ProviderRow[] {
  const byProvider = new Map<string, ProviderRow>();
  const methodsById = new Map(methods.map((method) => [method.id, method]));

  const upsert = (id: string, patch: Partial<ProviderRow>) => {
    const existing = byProvider.get(id);
    byProvider.set(id, {
      id,
      name: patch.name ?? existing?.name ?? BUNDLED_PROVIDER_NAMES.get(id) ?? id,
      credential: patch.credential ?? existing?.credential ?? null,
      modelCount: patch.modelCount ?? existing?.modelCount ?? null,
      signIn: patch.signIn ?? existing?.signIn ?? methodsById.get(id) ?? null,
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

  for (const method of methods) {
    if (byProvider.has(method.id)) {
      upsert(method.id, { signIn: method });
    } else {
      upsert(method.id, { name: method.name, signIn: method });
    }
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
  const kind = credential.kind === "oauth_grant" ? "Signed in" : null;
  const parts = [
    kind,
    `added ${since(credential.updatedAt)}`,
    credential.lastUsedAt ? `used ${since(credential.lastUsedAt)}` : "never used",
  ].filter(Boolean);
  return (
    <span className="text-xs text-muted-foreground">
      {credential.label && credential.kind !== "oauth_grant" ? `${credential.label} • ` : ""}
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

function AuthorizationCodeSignIn({
  provider,
  started,
  onDone,
  onCancel,
}: {
  provider: ProviderRow;
  started: Extract<ProviderOAuthStart, { flow: "authorization_code" }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  async function complete() {
    if (!code.trim()) {
      toast.error("Paste the redirected URL or authorization code");
      return;
    }
    setSaving(true);
    try {
      await completeProviderOAuth(provider.id, code.trim());
      setCode("");
      toast.success(`Signed in to ${provider.name}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to complete sign-in");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border px-4 py-3 space-y-3">
      <p className="text-sm text-muted-foreground">{started.instructions}</p>
      <a href={started.authorizeUrl} target="_blank" rel="noreferrer" className="text-sm underline">
        Open {provider.name} sign-in
      </a>
      <div className="space-y-1.5">
        <Label htmlFor={`provider-oauth-code-${provider.id}`}>
          Authorization code or redirect URL
        </Label>
        <Input
          id={`provider-oauth-code-${provider.id}`}
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="http://localhost:53692/callback?code=..."
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={complete} disabled={saving}>
          {saving ? "Signing in..." : "Complete sign-in"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DeviceCodeSignIn({
  provider,
  started,
  onDone,
  onCancel,
}: {
  provider: ProviderRow;
  started: Extract<ProviderOAuthStart, { flow: "device_code" }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [waiting, setWaiting] = useState(true);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;

  useEffect(() => {
    const abort = new AbortController();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        abort.signal.addEventListener("abort", () => {
          window.clearTimeout(timer);
          resolve();
        });
      });

    void (async () => {
      let intervalMs = Math.max(1_000, started.intervalSeconds * 1000);
      await sleep(intervalMs);
      while (!abort.signal.aborted) {
        try {
          const polled = await pollProviderOAuth(provider.id);
          if (abort.signal.aborted) return;
          if (polled.status === "pending") {
            if (polled.intervalSeconds && polled.intervalSeconds > 0) {
              intervalMs = Math.max(1_000, polled.intervalSeconds * 1000);
            }
            await sleep(intervalMs);
            continue;
          }
          if (polled.status === "complete") {
            setWaiting(false);
            toast.success(`Signed in to ${provider.name}`);
            onDoneRef.current();
            return;
          }
          setWaiting(false);
          toast.error(polled.error);
          onCancelRef.current();
          return;
        } catch (err) {
          if (abort.signal.aborted) return;
          setWaiting(false);
          toast.error(err instanceof Error ? err.message : "Failed to poll sign-in");
          onCancelRef.current();
          return;
        }
      }
    })();

    return () => abort.abort();
  }, [provider.id, provider.name, started.intervalSeconds]);

  return (
    <div className="border-t border-border px-4 py-3 space-y-3">
      <p className="text-sm text-muted-foreground">
        Enter this code at the provider, then return here. This page waits until you finish.
      </p>
      <div className="text-lg font-mono tracking-widest select-all">{started.userCode}</div>
      <a
        href={started.verificationUri}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline"
      >
        Open {provider.name} device sign-in
      </a>
      <p className="text-xs text-muted-foreground">
        {waiting ? "Waiting for authorization..." : "Sign-in ended."}
      </p>
      <Button size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function ProvidersSettings() {
  const { credentials, loading: loadingCredentials, mutate } = useProviderCredentials();
  const { methods, loading: loadingMethods } = useProviderOAuthMethods();
  const { catalog, loading: loadingCatalog } = useModelCatalog();
  const [editing, setEditing] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{ row: ProviderRow; started: ProviderOAuthStart } | null>(
    null
  );
  const [starting, setStarting] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderRow | null>(null);

  const rows = useMemo(
    () => buildRows(credentials, catalog, methods),
    [credentials, catalog, methods]
  );

  async function remove(provider: ProviderRow) {
    try {
      await deleteProviderCredential(provider.id);
      mutate();
      toast.success(`${provider.name} disconnected`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove provider key");
    }
    setRemoveTarget(null);
  }

  async function beginSignIn(row: ProviderRow) {
    if (!row.signIn) return;
    setEditing(null);
    setStarting(row.id);
    try {
      const started = await startProviderOAuth(row.id);
      const url =
        started.flow === "authorization_code" ? started.authorizeUrl : started.verificationUri;
      window.open?.(url, "_blank", "noopener,noreferrer");
      setSignIn({ row, started });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start subscription sign-in");
    } finally {
      setStarting(null);
    }
  }

  async function closeSignIn() {
    const providerId = signIn?.row.id;
    setSignIn(null);
    if (providerId) {
      await cancelProviderOAuth(providerId);
    }
  }

  if (loadingCredentials || loadingCatalog || loadingMethods) {
    return <div className="text-sm text-muted-foreground">Loading providers...</div>;
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Providers</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Your sessions run on the key or subscription you add here. It belongs to your account, is
        encrypted at rest, and is never displayed again once saved.
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
          const isSigningIn = signIn?.row.id === row.id;
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
                    onClick={() => {
                      setSignIn(null);
                      setEditing(isEditing ? null : row.id);
                    }}
                  >
                    {isEditing ? "Cancel" : connected ? "Replace" : "Connect"}
                  </Button>
                  {row.signIn && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={
                        isSigningIn ? `Cancel ${row.name} sign-in` : row.signIn.loginLabel
                      }
                      disabled={starting === row.id}
                      onClick={() => {
                        if (isSigningIn) {
                          void closeSignIn();
                          return;
                        }
                        void beginSignIn(row);
                      }}
                    >
                      {isSigningIn
                        ? "Cancel"
                        : starting === row.id
                          ? "Starting..."
                          : row.signIn.loginLabel}
                    </Button>
                  )}
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
              {isSigningIn && signIn.started.flow === "authorization_code" && (
                <AuthorizationCodeSignIn
                  provider={row}
                  started={signIn.started}
                  onDone={() => {
                    setSignIn(null);
                    mutate();
                  }}
                  onCancel={() => void closeSignIn()}
                />
              )}
              {isSigningIn && signIn.started.flow === "device_code" && (
                <DeviceCodeSignIn
                  provider={row}
                  started={signIn.started}
                  onDone={() => {
                    setSignIn(null);
                    mutate();
                  }}
                  onCancel={() => void closeSignIn()}
                />
              )}
            </div>
          );
        })}
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
