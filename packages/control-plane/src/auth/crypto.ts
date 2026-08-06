/**
 * Token encryption using AES-256-GCM, bound to the row that stores it.
 *
 * Key management:
 * - TOKEN_ENCRYPTION_KEY / REPO_SECRETS_ENCRYPTION_KEY stored as Cloudflare
 *   Worker secrets
 * - Generate with: openssl rand -base64 32
 * - Set via Terraform (see terraform.tfvars)
 *
 * Why every call carries a context
 * --------------------------------
 * AES-GCM without additional authenticated data proves only that a ciphertext
 * was produced under the key. It says nothing about *where* it was stored, so a
 * value lifted out of one row decrypts cleanly in any other row sealed with the
 * same key. With owner-scoped tables that is a cross-user attack: anyone who
 * can write a row can relocate another user's ciphertext into their own scope
 * and have the product decrypt it for them.
 *
 * So {@link encryptToken} and {@link decryptToken} take an
 * {@link EncryptionContext} naming the storage location — table, scope kind,
 * scope id, key name — and pass its canonical encoding as GCM's
 * `additionalData`. Moving a ciphertext to a different owner, a different
 * scope, or a different column changes the context, and the decrypt fails.
 * The parameter is required rather than optional precisely so no call site can
 * end up unbound by omission.
 *
 * Stored format, and reading what is already stored
 * -------------------------------------------------
 * A value sealed by this module is `v1.` + base64(IV||ciphertext). Values
 * written before this scheme are bare base64(IV||ciphertext) with no prefix —
 * `.` is outside the base64 alphabet, so the two are distinguishable without
 * ambiguity. {@link decryptToken} reads both: prefixed values are verified
 * against the context, legacy values are decrypted unbound, exactly as they
 * were written.
 *
 * That dual read is deliberate and is the reason this is not a migration. Two
 * of the encrypted columns live in Durable Object SQLite (the session DO's
 * code-server password and ttyd token), one per session, and no D1 migration
 * can reach them — there is no way to enumerate every session DO. A migration
 * would therefore be silently partial, which is the failure this codebase is
 * being swept for. Every store rewrites bound on its next write, so the legacy
 * set only shrinks.
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit IV for GCM

/**
 * Marks a ciphertext sealed with an {@link EncryptionContext}. Also the hook a
 * future key rotation hangs its generation off (roadmap 7.7): a new generation
 * gets a new prefix, and a row records which one sealed it.
 */
export const BOUND_CIPHERTEXT_PREFIX = "v1.";

/** Domain separator, so these bytes can never be confused with another scheme's. */
const AAD_DOMAIN = "openoutposts.enc.v1";

/**
 * Where a ciphertext lives. The four fields together are the row identity a
 * value is sealed to.
 *
 * - `table` — the storage location, e.g. `user_provider_credentials`. Not
 *   necessarily a SQL table name: a value copied between stores by design (the
 *   SCM OAuth tokens, which travel from D1 into each session's participant row)
 *   uses one logical name across all of them, because relocation *within* one
 *   person's own identity is how that feature works.
 * - `scopeKind` / `scopeId` — who or what owns the row: a user, a repo, an
 *   environment, a session, the deployment.
 * - `keyName` — which value within the row, so an access token cannot be
 *   swapped into the refresh column, nor one secret key's value into another's.
 */
export interface EncryptionContext {
  table: string;
  scopeKind: string;
  scopeId: string;
  keyName: string;
}

/**
 * Canonical bytes for a context.
 *
 * Newline-separated, with newlines refused in the fields, so two different
 * contexts cannot encode to the same string — without that, a scope id and a
 * key name could be shifted across the boundary between them and still
 * authenticate.
 */
function encodeContext(context: EncryptionContext): Uint8Array {
  const fields: Array<[keyof EncryptionContext, string]> = [
    ["table", context.table],
    ["scopeKind", context.scopeKind],
    ["scopeId", context.scopeId],
    ["keyName", context.keyName],
  ];
  for (const [name, value] of fields) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Encryption context field '${name}' must be a non-empty string`);
    }
    if (value.includes("\n")) {
      throw new Error(`Encryption context field '${name}' must not contain a newline`);
    }
  }
  return new TextEncoder().encode([AAD_DOMAIN, ...fields.map(([, value]) => value)].join("\n"));
}

/**
 * Import the encryption key from base64-encoded secret.
 */
async function getEncryptionKey(keyBase64: string): Promise<CryptoKey> {
  const keyData = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey("raw", keyData, { name: ALGORITHM, length: KEY_LENGTH }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a token using AES-256-GCM, bound to its storage location.
 *
 * @param token - Plain text token to encrypt
 * @param encryptionKey - Base64-encoded encryption key
 * @param context - Where the ciphertext will be stored; authenticated, not encrypted
 * @returns `v1.` + base64-encoded IV + ciphertext
 */
export async function encryptToken(
  token: string,
  encryptionKey: string,
  context: EncryptionContext
): Promise<string> {
  const additionalData = encodeContext(context);
  const key = await getEncryptionKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(token);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData },
    key,
    encoded
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return `${BOUND_CIPHERTEXT_PREFIX}${btoa(String.fromCharCode(...combined))}`;
}

/**
 * Decrypt a token using AES-256-GCM.
 *
 * A `v1.`-prefixed value must have been sealed with exactly this context;
 * anything else — another user's row, another column, another scope — fails to
 * authenticate and throws. An unprefixed value predates the scheme and is
 * decrypted unbound.
 *
 * @param encrypted - Stored value, prefixed or legacy
 * @param encryptionKey - Base64-encoded encryption key
 * @param context - Where this value was read from
 * @returns Decrypted plain text token
 */
export async function decryptToken(
  encrypted: string,
  encryptionKey: string,
  context: EncryptionContext
): Promise<string> {
  const isBound = encrypted.startsWith(BOUND_CIPHERTEXT_PREFIX);
  // Computed for both paths so a malformed context is an error even on the
  // legacy read, rather than a latent one that only surfaces after a rewrite.
  const additionalData = encodeContext(context);
  const payload = isBound ? encrypted.slice(BOUND_CIPHERTEXT_PREFIX.length) : encrypted;

  const key = await getEncryptionKey(encryptionKey);
  const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    isBound ? { name: ALGORITHM, iv, additionalData } : { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Whether a stored value carries the binding prefix. Exposed for tests and for
 * a future rotation pass that needs to find rows still holding legacy values.
 */
export function isBoundCiphertext(encrypted: string): boolean {
  return encrypted.startsWith(BOUND_CIPHERTEXT_PREFIX);
}

/**
 * Generate a random encryption key (for testing/setup).
 *
 * @returns Base64-encoded 256-bit key
 */
export function generateEncryptionKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}

/**
 * Generate a random token/ID.
 *
 * @param length - Length in bytes (default 32)
 * @returns Hex-encoded random string
 */
export function generateId(length: number = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a token using SHA-256.
 *
 * Used for storing WebSocket auth tokens securely - we store the hash
 * and compare against incoming tokens.
 *
 * @param token - Plain text token to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashToken(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Encrypt an access/refresh token pair.
 * Returns null for tokens that weren't provided (undefined/empty).
 * Throws if encryption of a provided token fails.
 *
 * The two contexts are separate arguments rather than one with a derived key
 * name, so the caller states which column each half lands in.
 */
export async function encryptTokenPair(
  accessToken: string | undefined,
  refreshToken: string | undefined,
  encryptionKey: string,
  contexts: { access: EncryptionContext; refresh: EncryptionContext }
): Promise<{ accessTokenEncrypted: string | null; refreshTokenEncrypted: string | null }> {
  const accessTokenEncrypted = accessToken
    ? await encryptToken(accessToken, encryptionKey, contexts.access)
    : null;
  const refreshTokenEncrypted = refreshToken
    ? await encryptToken(refreshToken, encryptionKey, contexts.refresh)
    : null;
  return { accessTokenEncrypted, refreshTokenEncrypted };
}

// timingSafeEqual is exported from @open-inspect/shared — use that instead.
