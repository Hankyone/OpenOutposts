import { timingSafeEqual } from "@open-inspect/shared";
import { base64UrlDecode } from "./encoding";
import { hashToken } from "./crypto";
import type { OutpostRecord } from "../db/outposts";
import type { SqlDatabase } from "../db/sql-database";

export const OUTPOST_PROOF_HEADERS = {
  timestamp: "X-OpenOutposts-Timestamp",
  nonce: "X-OpenOutposts-Nonce",
  signature: "X-OpenOutposts-Signature",
  keyFingerprint: "X-OpenOutposts-Key-Fingerprint",
} as const;

const PROOF_DOMAIN = "openoutposts-connect-v1";
const PROOF_MAX_AGE_MS = 2 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyOutpostEnrollmentToken(
  authorizationHeader: string | null,
  expectedToken: string | undefined
): Promise<boolean> {
  if (!expectedToken || !authorizationHeader?.startsWith("Bearer ")) return false;

  const providedToken = authorizationHeader.slice(7);
  if (!providedToken) return false;

  const [providedHash, expectedHash] = await Promise.all([
    sha256(providedToken),
    sha256(expectedToken),
  ]);
  return timingSafeEqual(providedHash, expectedHash);
}

export function canonicalOutpostProof(
  method: string,
  path: string,
  outpostId: string,
  timestamp: string,
  nonce: string
): string {
  return [PROOF_DOMAIN, method, path, outpostId, timestamp, nonce].join("\n");
}

export type OutpostProofResult =
  | { ok: true; keyFingerprint: string; ownerUserId: string }
  | { ok: false; reason: string };

export async function verifyOutpostMachineProof(
  request: Request,
  outpost: OutpostRecord,
  db: SqlDatabase,
  options: { allowUnconfirmed?: boolean; allowRevoked?: boolean; now?: number } = {}
): Promise<OutpostProofResult> {
  if (
    (outpost.revoked_at !== null && !options.allowRevoked) ||
    !outpost.owner_user_id ||
    !outpost.public_key ||
    outpost.key_algorithm !== "ed25519" ||
    !outpost.key_fingerprint
  ) {
    return { ok: false, reason: "machine identity is inactive" };
  }
  if (!options.allowUnconfirmed && outpost.confirmed_at === null) {
    return { ok: false, reason: "machine enrollment is not confirmed" };
  }

  const timestamp = request.headers.get(OUTPOST_PROOF_HEADERS.timestamp);
  const nonce = request.headers.get(OUTPOST_PROOF_HEADERS.nonce);
  const signatureValue = request.headers.get(OUTPOST_PROOF_HEADERS.signature);
  const fingerprint = request.headers.get(OUTPOST_PROOF_HEADERS.keyFingerprint);
  if (!timestamp || !nonce || !signatureValue || !fingerprint) {
    return { ok: false, reason: "machine proof is incomplete" };
  }
  if (fingerprint !== outpost.key_fingerprint) {
    return { ok: false, reason: "machine key fingerprint does not match" };
  }

  const timestampMs = Number(timestamp);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > PROOF_MAX_AGE_MS) {
    return { ok: false, reason: "machine proof timestamp is outside the allowed window" };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;
  let nonceBytes: Uint8Array;
  try {
    publicKey = base64UrlDecode(outpost.public_key);
    signature = base64UrlDecode(signatureValue);
    nonceBytes = base64UrlDecode(nonce);
  } catch {
    return { ok: false, reason: "machine proof encoding is invalid" };
  }
  if (publicKey.byteLength !== 32 || signature.byteLength !== 64 || nonceBytes.byteLength < 16) {
    return { ok: false, reason: "machine proof has invalid lengths" };
  }

  let verified = false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(
        canonicalOutpostProof(
          request.method,
          new URL(request.url).pathname,
          outpost.id,
          timestamp,
          nonce
        )
      )
    );
  } catch {
    return { ok: false, reason: "machine proof could not be verified" };
  }
  if (!verified) return { ok: false, reason: "machine signature is invalid" };

  const nonceHash = await hashToken(`${outpost.id}:${nonce}`);
  try {
    await db.batch([
      db.prepare("DELETE FROM outpost_connect_nonces WHERE expires_at <= ?").bind(now),
      db
        .prepare(
          `INSERT INTO outpost_connect_nonces (nonce_hash, outpost_id, expires_at)
           VALUES (?, ?, ?)`
        )
        .bind(nonceHash, outpost.id, now + NONCE_TTL_MS),
    ]);
  } catch {
    return { ok: false, reason: "machine proof was already used" };
  }

  return {
    ok: true,
    keyFingerprint: outpost.key_fingerprint,
    ownerUserId: outpost.owner_user_id,
  };
}
