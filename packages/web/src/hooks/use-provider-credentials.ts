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

export const PROVIDER_OAUTH_METHODS_KEY = "/api/provider-credentials/oauth-methods";

export type ProviderOAuthFlow = "authorization_code" | "device_code";

export interface ProviderOAuthMethod {
  id: string;
  name: string;
  loginLabel: string;
  flow: ProviderOAuthFlow;
}

interface ProviderOAuthMethodsResponse {
  methods: ProviderOAuthMethod[];
}

export function useProviderOAuthMethods() {
  const { data: session } = useAuthSession();
  const { data, error, isLoading } = useSWR<ProviderOAuthMethodsResponse>(
    session ? PROVIDER_OAUTH_METHODS_KEY : null
  );

  return {
    methods: data?.methods ?? [],
    loading: isLoading,
    unavailable: Boolean(error),
  };
}

export type ProviderOAuthStart =
  | {
      flow: "authorization_code";
      provider: string;
      authorizeUrl: string;
      instructions: string;
      expiresAt: number;
    }
  | {
      flow: "device_code";
      provider: string;
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresInSeconds: number;
      expiresAt: number;
    };

export type ProviderOAuthPoll =
  | { status: "pending"; intervalSeconds?: number }
  | { status: "complete"; created: boolean }
  | { status: "denied"; error: string }
  | { status: "expired"; error: string };

export async function startProviderOAuth(provider: string): Promise<ProviderOAuthStart> {
  const response = await browserApiFetch(
    `${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(provider)}/oauth/start`,
    { method: "POST" }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to start subscription sign-in"));
  }
  return (await response.json()) as ProviderOAuthStart;
}

export async function completeProviderOAuth(provider: string, code: string): Promise<void> {
  const response = await browserApiFetch(
    `${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(provider)}/oauth/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Failed to complete subscription sign-in"));
  }
}

export async function pollProviderOAuth(provider: string): Promise<ProviderOAuthPoll> {
  const response = await browserApiFetch(
    `${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(provider)}/oauth/poll`,
    { method: "POST" }
  );
  const body = (await response.json().catch(() => ({}))) as {
    status?: string;
    intervalSeconds?: number;
    created?: boolean;
    error?: string;
  };
  if (body.status === "pending") {
    return { status: "pending", intervalSeconds: body.intervalSeconds };
  }
  if (body.status === "complete") {
    return { status: "complete", created: Boolean(body.created) };
  }
  if (body.status === "denied") {
    return { status: "denied", error: body.error || "Sign-in was denied" };
  }
  if (body.status === "expired") {
    return { status: "expired", error: body.error || "Device code expired" };
  }
  throw new Error(
    typeof body.error === "string" && body.error
      ? body.error
      : "Failed to poll subscription sign-in"
  );
}

export async function cancelProviderOAuth(provider: string): Promise<void> {
  await browserApiFetch(`${PROVIDER_CREDENTIALS_KEY}/${encodeURIComponent(provider)}/oauth`, {
    method: "DELETE",
  });
}
