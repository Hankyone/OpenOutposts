import { base64UrlEncode } from "./encoding";

const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InvalidPkceVerifierError extends Error {
  constructor() {
    super("PKCE verifier is malformed");
    this.name = "InvalidPkceVerifierError";
  }
}

export function isPkceS256Challenge(value: unknown): value is string {
  return typeof value === "string" && PKCE_S256_CHALLENGE_PATTERN.test(value);
}

export function isPkceVerifier(value: unknown): value is string {
  return typeof value === "string" && PKCE_VERIFIER_PATTERN.test(value);
}

export async function createPkceS256Challenge(verifier: string): Promise<string> {
  if (!isPkceVerifier(verifier)) {
    throw new InvalidPkceVerifierError();
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * 32 random bytes, base64url-encoded without padding — 43 characters, the
 * RFC 7636 minimum and the length Pi's own OAuth helpers produce.
 */
export function createPkceVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createPkceS256Pair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = createPkceVerifier();
  return { verifier, challenge: await createPkceS256Challenge(verifier) };
}
