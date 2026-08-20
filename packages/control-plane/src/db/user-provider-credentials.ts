/**
 * The per-user provider-credential vault.
 *
 * Two read paths, deliberately named apart. {@link
 * UserProviderCredentialStore.list} returns presence and metadata — the
 * columns holding ciphertext are not in its SELECT at all, so there is no
 * shape a listing could accidentally carry the secret in. {@link
 * UserProviderCredentialStore.getForIssuance} is the only method that
 * decrypts, and it exists for one caller: session-scoped issuance.
 *
 * Encryption is the deployment's AES-256-GCM primitive under
 * TOKEN_ENCRYPTION_KEY — the required binding, not the optional
 * REPO_SECRETS_ENCRYPTION_KEY the scoped-secret stores use, because a vault
 * that silently degrades when a key is absent is worse than one that refuses
 * to serve.
 *
 * Every row records the key generation that sealed it. Reading a row sealed by
 * an unknown generation fails closed rather than attempting a decrypt that
 * would fail opaquely.
 */

import { decryptToken, encryptToken, generateId } from "../auth/crypto";
import { providerCredentialContext } from "../auth/encryption-contexts";
import type { SqlDatabase } from "./sql-database";

/** Credential shapes the vault can hold. */
export type ProviderCredentialKind = "api_key" | "oauth_grant";

/**
 * The encryption key generation this build seals with. Bump alongside a
 * rotation pass that can decrypt both generations; until then, a row carrying
 * anything else is refused rather than guessed at.
 */
export const CURRENT_CREDENTIAL_KEY_VERSION = 1;

/**
 * Provider API keys are well under a kilobyte in every published format; the
 * cap exists so a mistaken paste of a file cannot fill the column.
 */
export const MAX_PROVIDER_SECRET_LENGTH = 8 * 1024;
export const MAX_CREDENTIAL_LABEL_LENGTH = 100;
const MAX_PROVIDER_ID_LENGTH = 64;

/**
 * Harness provider ids as Pi spells them: lowercase slugs such as `anthropic`,
 * `opencode`, `zai-coding-cn`. Deliberately not the scoped-secret key rules —
 * those uppercase, reserve environment-variable names and cap a scope at fifty
 * keys, none of which mean anything for a vault row.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Raised for caller-fixable input; route handlers map it to a 400. */
export class ProviderCredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCredentialValidationError";
  }
}

/**
 * Raised when a stored credential cannot be recovered. Carries the row's
 * identity so an operator can find it, and never the material or the
 * underlying crypto error's contents.
 */
export class ProviderCredentialDecryptionError extends Error {
  constructor(
    readonly credentialId: string,
    readonly provider: string
  ) {
    super(`Failed to decrypt provider credential '${credentialId}'`);
    this.name = "ProviderCredentialDecryptionError";
  }
}

/** What a listing may show: presence, description, timestamps. Never material. */
export interface ProviderCredentialMetadata {
  id: string;
  provider: string;
  label: string | null;
  kind: ProviderCredentialKind;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** OAuth access-token expiry; null for API keys, which do not expire. */
  secretExpiresAt: number | null;
}

/** The decrypted credential, produced only by the issuance path. */
export interface DecryptedProviderCredential {
  id: string;
  provider: string;
  kind: ProviderCredentialKind;
  /** The API key, or the OAuth access token. */
  secret: string;
  /** OAuth refresh token. Null for API keys and non-refreshable grants. */
  refreshSecret: string | null;
  secretExpiresAt: number | null;
}

export interface PutApiKeyInput {
  userId: string;
  provider: string;
  apiKey: string;
  label?: string | null;
}

export interface PutApiKeyResult {
  credential: ProviderCredentialMetadata;
  /** False when an existing credential for the same provider was replaced. */
  created: boolean;
}

export interface PutOAuthGrantInput {
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  label?: string | null;
}

export type PutOAuthGrantResult = PutApiKeyResult;

export interface RotateOAuthGrantInput {
  userId: string;
  provider: string;
  accessToken: string;
  /** Null keeps the stored refresh token (xAI may omit rotation). */
  refreshToken: string | null;
  expiresAt: number | null;
}

interface MetadataDbRow {
  id: string;
  provider: string;
  label: string | null;
  kind: ProviderCredentialKind;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  secret_expires_at: number | null;
}

/**
 * The metadata projection, written once. Every listing and every write
 * response reads through this column list, so no call site can widen it to a
 * ciphertext column by accident.
 */
const METADATA_COLUMNS =
  "id, provider, label, kind, created_at, updated_at, last_used_at, secret_expires_at";

function toMetadata(row: MetadataDbRow): ProviderCredentialMetadata {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    secretExpiresAt: row.secret_expires_at,
  };
}

/**
 * Normalize and validate a provider id. Exported because the issuance route
 * validates a caller-supplied provider before it touches the database.
 */
export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    throw new ProviderCredentialValidationError("Provider is required");
  }
  if (normalized.length > MAX_PROVIDER_ID_LENGTH) {
    throw new ProviderCredentialValidationError(
      `Provider must be at most ${MAX_PROVIDER_ID_LENGTH} characters`
    );
  }
  if (!PROVIDER_ID_PATTERN.test(normalized)) {
    throw new ProviderCredentialValidationError(
      "Provider must be a lowercase slug (letters, digits, '.', '_', '-')"
    );
  }
  return normalized;
}

function normalizeLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CREDENTIAL_LABEL_LENGTH) {
    throw new ProviderCredentialValidationError(
      `Label must be at most ${MAX_CREDENTIAL_LABEL_LENGTH} characters`
    );
  }
  return trimmed;
}

function validateSecret(secret: string, noun = "API key"): string {
  // Surrounding whitespace is the single most common paste artefact and is
  // never part of a provider key.
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new ProviderCredentialValidationError(`${noun} must not be empty`);
  }
  if (trimmed.length > MAX_PROVIDER_SECRET_LENGTH) {
    throw new ProviderCredentialValidationError(
      `${noun} must be at most ${MAX_PROVIDER_SECRET_LENGTH} characters`
    );
  }
  return trimmed;
}

/**
 * The provider slugs a user has connected, in sorted order.
 *
 * A free function rather than a store method because it needs no encryption
 * key: which providers a user has connected is presence, not material, and the
 * model catalog reads it on every request to decide what that user may be
 * offered. Requiring a key to answer it would either push the key into the
 * catalog path or invite a second query written somewhere else against this
 * table.
 */
export async function listConnectedProviders(db: SqlDatabase, userId: string): Promise<string[]> {
  const result = await db
    .prepare("SELECT provider FROM user_provider_credentials WHERE user_id = ? ORDER BY provider")
    .bind(userId)
    .all<{ provider: string }>();
  return (result.results ?? []).map((row) => row.provider);
}

export class UserProviderCredentialStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  /** Every credential this user owns, metadata only. */
  async list(userId: string): Promise<ProviderCredentialMetadata[]> {
    const result = await this.db
      .prepare(
        `SELECT ${METADATA_COLUMNS} FROM user_provider_credentials
         WHERE user_id = ? ORDER BY provider`
      )
      .bind(userId)
      .all<MetadataDbRow>();
    return (result.results ?? []).map(toMetadata);
  }

  /**
   * Add or replace this user's credential for one provider.
   *
   * Replacement rather than a second row: issuance resolves owner plus
   * provider to one credential, so a provider holds at most one. The row id
   * survives a replacement so audit records naming it stay resolvable.
   */
  async putApiKey(input: PutApiKeyInput): Promise<PutApiKeyResult> {
    const provider = normalizeProviderId(input.provider);
    const label = normalizeLabel(input.label);
    const secret = validateSecret(input.apiKey);

    const now = Date.now();
    const secretEncrypted = await encryptToken(
      secret,
      this.encryptionKey,
      providerCredentialContext(input.userId, provider)
    );

    const existing = await this.db
      .prepare("SELECT id FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
      .bind(input.userId, provider)
      .first<{ id: string }>();

    const id = existing?.id ?? generateId();

    await this.db
      .prepare(
        `INSERT INTO user_provider_credentials
           (id, user_id, team_id, provider, label, kind, key_version,
            secret_encrypted, refresh_secret_encrypted, secret_expires_at,
            created_at, updated_at, last_used_at)
         VALUES (?, ?, NULL, ?, ?, 'api_key', ?, ?, NULL, NULL, ?, ?, NULL)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           label = excluded.label,
           kind = excluded.kind,
           key_version = excluded.key_version,
           secret_encrypted = excluded.secret_encrypted,
           -- A replacement is a new credential, so the OAuth columns and the
           -- usage stamp reset with it rather than describing the old secret.
           refresh_secret_encrypted = NULL,
           secret_expires_at = NULL,
           last_used_at = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        input.userId,
        provider,
        label,
        CURRENT_CREDENTIAL_KEY_VERSION,
        secretEncrypted,
        now,
        now
      )
      .run();

    const row = await this.db
      .prepare(
        `SELECT ${METADATA_COLUMNS} FROM user_provider_credentials
         WHERE user_id = ? AND provider = ?`
      )
      .bind(input.userId, provider)
      .first<MetadataDbRow>();

    if (!row) {
      // The upsert above just wrote this row; a miss means the write did not
      // land, which must not be reported as success.
      throw new Error("Provider credential write did not persist");
    }

    return { credential: toMetadata(row), created: !existing };
  }

  /**
   * Add or replace this user's OAuth grant for one provider.
   *
   * Same uniqueness rule as {@link putApiKey}: one row per owner per provider,
   * so signing in replaces an API key for that provider rather than sitting
   * beside it.
   */
  async putOAuthGrant(input: PutOAuthGrantInput): Promise<PutOAuthGrantResult> {
    const provider = normalizeProviderId(input.provider);
    const label = normalizeLabel(input.label);
    const access = validateSecret(input.accessToken, "Access token");
    const refresh =
      input.refreshToken === null || input.refreshToken === undefined
        ? null
        : validateSecret(input.refreshToken, "Refresh token");
    if (input.expiresAt !== null && input.expiresAt !== undefined) {
      if (!Number.isFinite(input.expiresAt) || !Number.isInteger(input.expiresAt)) {
        throw new ProviderCredentialValidationError("OAuth expiry must be an integer epoch ms");
      }
    }

    const now = Date.now();
    const secretEncrypted = await encryptToken(
      access,
      this.encryptionKey,
      providerCredentialContext(input.userId, provider, "secret")
    );
    const refreshEncrypted =
      refresh === null
        ? null
        : await encryptToken(
            refresh,
            this.encryptionKey,
            providerCredentialContext(input.userId, provider, "refresh_secret")
          );

    const existing = await this.db
      .prepare("SELECT id FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
      .bind(input.userId, provider)
      .first<{ id: string }>();

    const id = existing?.id ?? generateId();

    await this.db
      .prepare(
        `INSERT INTO user_provider_credentials
           (id, user_id, team_id, provider, label, kind, key_version,
            secret_encrypted, refresh_secret_encrypted, secret_expires_at,
            created_at, updated_at, last_used_at)
         VALUES (?, ?, NULL, ?, ?, 'oauth_grant', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           label = excluded.label,
           kind = excluded.kind,
           key_version = excluded.key_version,
           secret_encrypted = excluded.secret_encrypted,
           refresh_secret_encrypted = excluded.refresh_secret_encrypted,
           secret_expires_at = excluded.secret_expires_at,
           last_used_at = NULL,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        input.userId,
        provider,
        label,
        CURRENT_CREDENTIAL_KEY_VERSION,
        secretEncrypted,
        refreshEncrypted,
        input.expiresAt ?? null,
        now,
        now
      )
      .run();

    const row = await this.db
      .prepare(
        `SELECT ${METADATA_COLUMNS} FROM user_provider_credentials
         WHERE user_id = ? AND provider = ?`
      )
      .bind(input.userId, provider)
      .first<MetadataDbRow>();

    if (!row) {
      throw new Error("Provider credential write did not persist");
    }

    return { credential: toMetadata(row), created: !existing };
  }

  /**
   * Replace the access (and maybe refresh) tokens of an existing OAuth grant.
   * Used after a successful refresh during issuance; the row id and label stay.
   */
  async rotateOAuthGrant(input: RotateOAuthGrantInput): Promise<void> {
    const provider = normalizeProviderId(input.provider);
    const access = validateSecret(input.accessToken, "Access token");
    const refresh =
      input.refreshToken === null || input.refreshToken === undefined
        ? null
        : validateSecret(input.refreshToken, "Refresh token");

    const secretEncrypted = await encryptToken(
      access,
      this.encryptionKey,
      providerCredentialContext(input.userId, provider, "secret")
    );
    const now = Date.now();

    if (refresh !== null) {
      const refreshEncrypted = await encryptToken(
        refresh,
        this.encryptionKey,
        providerCredentialContext(input.userId, provider, "refresh_secret")
      );
      const result = await this.db
        .prepare(
          `UPDATE user_provider_credentials
           SET key_version = ?, secret_encrypted = ?, refresh_secret_encrypted = ?,
               secret_expires_at = ?, updated_at = ?
           WHERE user_id = ? AND provider = ? AND kind = 'oauth_grant'`
        )
        .bind(
          CURRENT_CREDENTIAL_KEY_VERSION,
          secretEncrypted,
          refreshEncrypted,
          input.expiresAt ?? null,
          now,
          input.userId,
          provider
        )
        .run();
      if ((result.meta?.changes ?? 0) === 0) {
        throw new Error("OAuth grant rotation did not match a stored grant");
      }
      return;
    }

    const result = await this.db
      .prepare(
        `UPDATE user_provider_credentials
         SET key_version = ?, secret_encrypted = ?, secret_expires_at = ?, updated_at = ?
         WHERE user_id = ? AND provider = ? AND kind = 'oauth_grant'`
      )
      .bind(
        CURRENT_CREDENTIAL_KEY_VERSION,
        secretEncrypted,
        input.expiresAt ?? null,
        now,
        input.userId,
        provider
      )
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      throw new Error("OAuth grant rotation did not match a stored grant");
    }
  }

  /** Remove this user's credential for one provider. */
  async delete(userId: string, provider: string): Promise<boolean> {
    const normalized = normalizeProviderId(provider);
    const result = await this.db
      .prepare("DELETE FROM user_provider_credentials WHERE user_id = ? AND provider = ?")
      .bind(userId, normalized)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Decrypt one owner's credential for a provider. The single decryption path
   * in this module, named so that any other caller of it is visible in review.
   */
  async getForIssuance(
    userId: string,
    provider: string
  ): Promise<DecryptedProviderCredential | null> {
    const normalized = normalizeProviderId(provider);
    const row = await this.db
      .prepare(
        `SELECT id, provider, kind, key_version, secret_encrypted,
                refresh_secret_encrypted, secret_expires_at
         FROM user_provider_credentials WHERE user_id = ? AND provider = ?`
      )
      .bind(userId, normalized)
      .first<{
        id: string;
        provider: string;
        kind: ProviderCredentialKind;
        key_version: number;
        secret_encrypted: string;
        refresh_secret_encrypted: string | null;
        secret_expires_at: number | null;
      }>();

    if (!row) return null;

    if (row.key_version !== CURRENT_CREDENTIAL_KEY_VERSION) {
      // Sealed by a key generation this build cannot address. Refusing is the
      // whole point of recording the version.
      throw new ProviderCredentialDecryptionError(row.id, row.provider);
    }

    let secret: string;
    let refreshSecret: string | null = null;
    try {
      // Bound to this owner and this provider: a ciphertext lifted from
      // another user's row, or from the same user's other provider, fails here
      // rather than being issued to a session.
      secret = await decryptToken(
        row.secret_encrypted,
        this.encryptionKey,
        providerCredentialContext(userId, normalized, "secret")
      );
      if (row.kind === "oauth_grant" && row.refresh_secret_encrypted) {
        refreshSecret = await decryptToken(
          row.refresh_secret_encrypted,
          this.encryptionKey,
          providerCredentialContext(userId, normalized, "refresh_secret")
        );
      }
    } catch {
      throw new ProviderCredentialDecryptionError(row.id, row.provider);
    }

    return {
      id: row.id,
      provider: row.provider,
      kind: row.kind,
      secret,
      refreshSecret,
      secretExpiresAt: row.secret_expires_at,
    };
  }

  /** Stamp the usage time. Owner-scoped so a stray id cannot touch another row. */
  async touchLastUsed(userId: string, credentialId: string): Promise<void> {
    await this.db
      .prepare("UPDATE user_provider_credentials SET last_used_at = ? WHERE id = ? AND user_id = ?")
      .bind(Date.now(), credentialId, userId)
      .run();
  }
}
