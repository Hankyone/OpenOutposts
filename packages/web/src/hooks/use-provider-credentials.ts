import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export const PROVIDER_CREDENTIALS_KEY = "/api/provider-credentials";

/**
 * A stored credential as the product may know it.
 *
 * There is deliberately no field for the secret, not even a masked one: the
 * control plane has no read path for stored key material, so presence and
 * these timestamps are the whole of what a client can ever learn.
 */
export interface ProviderCredential {
  id: string;
  provider: string;
  label: string | null;
  kind: "api_key" | "oauth_grant";
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** OAuth access-token expiry. Null for API keys, which do not expire. */
  expiresAt: number | null;
}

interface ProviderCredentialsResponse {
  credentials: ProviderCredential[];
}

export function useProviderCredentials() {
  const { data: session } = useAuthSession();
  const { data, error, isLoading, mutate } = useSWR<ProviderCredentialsResponse>(
    session ? PROVIDER_CREDENTIALS_KEY : null
  );

  return {
    credentials: data?.credentials ?? [],
    loading: isLoading,
    unavailable: Boolean(error),
    mutate,
  };
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}) as { error?: string });
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

/**
 * Add a provider key, or replace the one already stored for that provider.
 *
 * The key leaves the browser once and is never returned; callers must clear
 * their own input state rather than expect to read it back.
 */
export async function saveProviderApiKey(input: {
  provider: string;
  apiKey: string;
  label?: string | null;
}): Promise<void> {
  const response = await browserApiFetch(
    `${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(input.provider)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: input.apiKey, label: input.label ?? null }),
    }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to save provider key"));
  }
}

export async function deleteProviderCredential(provider: string): Promise<void> {
  const response = await browserApiFetch(
    `${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(provider)}`,
    {
      method: "DELETE",
    }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to remove provider key"));
  }
}
