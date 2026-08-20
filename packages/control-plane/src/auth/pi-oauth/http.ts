/**
 * HTTP helpers for Pi-subscription OAuth adapters.
 *
 * Provider token endpoints are JSON or form-encoded; Workers `fetch` covers
 * both. Timeouts are short: a hung provider must not stall a turn's issuance.
 */

import { ProviderOAuthRequestError } from "./types";

export const PROVIDER_OAUTH_TIMEOUT_MS = 15_000;

export interface ProviderFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export async function providerFetch(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {}
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROVIDER_OAUTH_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal(timeoutMs)])
    : timeoutSignal(timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ProviderOAuthRequestError("Sign-in was cancelled", { retryable: false });
    }
    throw new ProviderOAuthRequestError(
      `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    );
  }
}

export async function postJson(
  url: string,
  body: Record<string, unknown>,
  options: ProviderFetchOptions = {}
): Promise<Response> {
  return providerFetch(
    url,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options
  );
}

export async function postForm(
  url: string,
  fields: Record<string, string>,
  options: ProviderFetchOptions & { headers?: Record<string, string> } = {}
): Promise<Response> {
  return providerFetch(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        ...options.headers,
      },
      body: new URLSearchParams(fields).toString(),
    },
    options
  );
}

export async function getJson(
  url: string,
  options: ProviderFetchOptions & { headers?: Record<string, string> } = {}
): Promise<Response> {
  return providerFetch(
    url,
    {
      method: "GET",
      headers: { Accept: "application/json", ...options.headers },
    },
    options
  );
}

export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ProviderOAuthRequestError(`Provider returned non-JSON (HTTP ${response.status})`, {
      retryable: response.status >= 500,
      status: response.status,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderOAuthRequestError("Provider returned a non-object JSON body", {
      retryable: false,
      status: response.status,
    });
  }
  return parsed as Record<string, unknown>;
}

export function jsonErrorMessage(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error_description === "string" && body.error_description) {
    return body.error_description;
  }
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.error === "string" && body.error) return body.error;
  return fallback;
}

export function isInvalidGrant(body: Record<string, unknown>, status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    body.error === "invalid_grant" ||
    body.error === "invalid_token"
  );
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderOAuthRequestError(`Provider response missing ${key}`, { retryable: false });
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function expiresAtFromExpiresIn(expiresIn: unknown, now: () => number): number | null {
  const seconds = optionalNumber(expiresIn);
  if (seconds === undefined || seconds <= 0) return null;
  return now() + seconds * 1000;
}

export function trustedHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function trustedHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function requireTrustedHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || !trustedHttpUrl(value)) {
    throw new ProviderOAuthRequestError(`Untrusted ${field} in provider response`, {
      retryable: false,
    });
  }
  return new URL(value).href;
}

export function requireTrustedHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || !trustedHttpsUrl(value)) {
    throw new ProviderOAuthRequestError(`Untrusted ${field} in provider response`, {
      retryable: false,
    });
  }
  return new URL(value).href;
}
