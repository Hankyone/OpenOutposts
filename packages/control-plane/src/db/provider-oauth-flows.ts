/**
 * Pending Pi-subscription OAuth flows.
 *
 * Browser sign-in cannot keep a PKCE verifier or device_code in the page: the
 * control plane holds them, encrypted and bound to the owner, until the user
 * finishes authorizing. Completing, abandoning, or replacing a flow deletes
 * the previous row; expiry is a backstop.
 */

import { decryptToken, encryptToken, generateId } from "../auth/crypto";
import { providerOAuthFlowContext } from "../auth/encryption-contexts";
import type { SubscriptionSignInFlow } from "../auth/pi-oauth";
import type { SqlDatabase } from "./sql-database";

export const AUTHORIZATION_CODE_FLOW_LIFETIME_MS = 10 * 60 * 1000;
export const DEVICE_CODE_FLOW_MAX_LIFETIME_MS = 15 * 60 * 1000;
const MAX_PAYLOAD_KEYS = 16;
const MAX_PAYLOAD_VALUE_LENGTH = 8 * 1024;
const PAYLOAD_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export class ProviderOAuthFlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOAuthFlowValidationError";
  }
}

export class ProviderOAuthFlowDecryptionError extends Error {
  constructor(
    readonly flowId: string,
    readonly provider: string
  ) {
    super(`Failed to decrypt provider OAuth flow '${flowId}'`);
    this.name = "ProviderOAuthFlowDecryptionError";
  }
}

export interface ProviderOAuthFlowRecord {
  id: string;
  provider: string;
  flowKind: SubscriptionSignInFlow;
  payload: Record<string, string>;
  expiresAt: number;
}

export interface ReplaceProviderOAuthFlowInput {
  userId: string;
  provider: string;
  flowKind: SubscriptionSignInFlow;
  payload: Record<string, string>;
  lifetimeMs: number;
}

function assertPayload(payload: Record<string, string>): Record<string, string> {
  const keys = Object.keys(payload);
  if (keys.length > MAX_PAYLOAD_KEYS) {
    throw new ProviderOAuthFlowValidationError("OAuth flow payload is too large");
  }
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    if (!PAYLOAD_KEY_PATTERN.test(key)) {
      throw new ProviderOAuthFlowValidationError("OAuth flow payload has an invalid key");
    }
    const value = payload[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new ProviderOAuthFlowValidationError(
        "OAuth flow payload values must be non-empty strings"
      );
    }
    if (value.length > MAX_PAYLOAD_VALUE_LENGTH) {
      throw new ProviderOAuthFlowValidationError("OAuth flow payload value is too large");
    }
    normalized[key] = value;
  }
  return normalized;
}

function decodePayload(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OAuth flow payload is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAuth flow payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new Error("OAuth flow payload is malformed");
    }
    payload[key] = value;
  }
  return assertPayload(payload);
}

export class ProviderOAuthFlowStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Start a new flow for this owner and provider, replacing any in-flight one.
   */
  async replace(input: ReplaceProviderOAuthFlowInput): Promise<{ id: string; expiresAt: number }> {
    const payload = assertPayload(input.payload);
    if (!Number.isFinite(input.lifetimeMs) || input.lifetimeMs <= 0) {
      throw new ProviderOAuthFlowValidationError("OAuth flow lifetime must be positive");
    }
    const id = generateId();
    const now = this.now();
    const expiresAt = now + input.lifetimeMs;
    const payloadEncrypted = await encryptToken(
      JSON.stringify(payload),
      this.encryptionKey,
      providerOAuthFlowContext(input.userId, id)
    );

    await this.db
      .prepare(
        `INSERT INTO provider_oauth_flows
           (id, user_id, provider, flow_kind, payload_encrypted, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           id = excluded.id,
           flow_kind = excluded.flow_kind,
           payload_encrypted = excluded.payload_encrypted,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`
      )
      .bind(id, input.userId, input.provider, input.flowKind, payloadEncrypted, expiresAt, now)
      .run();

    return { id, expiresAt };
  }

  /**
   * Load this owner's in-flight flow for a provider. Expired rows are deleted
   * rather than returned: a verifier that can no longer complete is not a
   * flow the user can still finish.
   */
  async get(userId: string, provider: string): Promise<ProviderOAuthFlowRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, provider, flow_kind, payload_encrypted, expires_at
         FROM provider_oauth_flows WHERE user_id = ? AND provider = ?`
      )
      .bind(userId, provider)
      .first<{
        id: string;
        provider: string;
        flow_kind: SubscriptionSignInFlow;
        payload_encrypted: string;
        expires_at: number;
      }>();

    if (!row) return null;

    if (row.expires_at <= this.now()) {
      await this.delete(userId, provider);
      return null;
    }

    let payload: Record<string, string>;
    try {
      const raw = await decryptToken(
        row.payload_encrypted,
        this.encryptionKey,
        providerOAuthFlowContext(userId, row.id)
      );
      payload = decodePayload(raw);
    } catch {
      throw new ProviderOAuthFlowDecryptionError(row.id, row.provider);
    }

    return {
      id: row.id,
      provider: row.provider,
      flowKind: row.flow_kind,
      payload,
      expiresAt: row.expires_at,
    };
  }

  async delete(userId: string, provider: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM provider_oauth_flows WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
