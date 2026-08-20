import type { Logger } from "../logger";
import {
  getSubscriptionOAuthAdapterIfKnown,
  ProviderOAuthRequestError,
  type SubscriptionOAuthAdapter,
} from "../auth/pi-oauth";
import {
  ProviderCredentialDecryptionError,
  ProviderCredentialValidationError,
  type DecryptedProviderCredential,
  type UserProviderCredentialStore,
} from "../db/user-provider-credentials";

/**
 * How long an issued model credential is good for before the harness must ask
 * again.
 *
 * Re-fetching is what makes a vault change take effect: a rotated or removed
 * credential, or an ended session, is only noticed at the next issuance. An
 * hour matches the outpost lease's default lifetime, so a session that is
 * still holding a machine is a session still re-authorizing its credential.
 *
 * This constant is one half of a contract the homestead owns the other half of.
 * The homestead does not copy it: its credential store carries the
 * `expires_at_epoch_ms` issued below and re-fetches when that passes, so
 * shortening the TTL here shortens it for live sessions at their next
 * issuance. The homestead also re-issues at every turn boundary, which is what
 * makes revoking a vault entry stop a session that is already running rather
 * than only the next one to start.
 */
export const MODEL_CREDENTIAL_TTL_MS = 60 * 60 * 1000;

/**
 * How far before an OAuth access token's stated expiry the vault refreshes
 * it. Matches Pi's typical skew so a token handed to a turn is still good
 * when the response comes back.
 */
export const OAUTH_ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Why an issuance was refused, as a closed vocabulary.
 *
 * Separate from `error`, which is prose for the harness's operator. This is the
 * classification the audit record stores; the two are kept apart so a reworded
 * message can never change what the security record says happened.
 */
export type ModelCredentialDenialReason =
  | "invalid_request"
  | "no_credential"
  | "unsupported_kind"
  | "credential_unusable"
  | "oauth_grant_invalid"
  | "provider_unavailable"
  | "storage_unavailable";

export type ModelCredentialKind = "api_key" | "oauth";

export type ModelCredentialResult =
  | {
      ok: true;
      kind: ModelCredentialKind;
      provider: string;
      credentialId: string;
      apiKey: string;
      expiresAtEpochMs: number;
    }
  | { ok: false; status: number; error: string; reason: ModelCredentialDenialReason };

export interface IssueModelCredentialInput {
  /** The product session the credential is being issued to. */
  sessionId: string;
  /** The session owner whose vault is consulted. Never caller-supplied. */
  ownerUserId: string;
  /** Normalized harness provider id. */
  provider: string;
}

export interface ModelCredentialsServiceOptions {
  now?: () => number;
  adapterFor?: (provider: string) => SubscriptionOAuthAdapter | null;
}

/**
 * Issues a session's model credential from the owning user's vault.
 *
 * Shaped after {@link import("./scm-credentials-service").ScmCredentialsService}:
 * a discriminated union the HTTP handler maps straight onto a response,
 * permanent faults as 500 and transient ones as 502, and the material never
 * reaches a log line.
 *
 * What "short-lived" means here, stated plainly: for an API key the material
 * is the user's own long-lived provider key — no provider offers a derived
 * session credential, so there is nothing shorter to mint. The expiry bounds
 * how long a session may keep using it before re-authorizing, and every
 * issuance is a fresh ownership check. It is not a claim that the key itself
 * expires.
 *
 * For an OAuth grant the material is a short-lived access token. If it is
 * expired or within the refresh skew, this service refreshes against the
 * provider, stores the rotated grant, and issues the new access token.
 * Refresh tokens never leave the vault.
 */
export class ModelCredentialsService {
  private readonly now: () => number;
  private readonly adapterFor: (provider: string) => SubscriptionOAuthAdapter | null;

  constructor(
    private readonly store: UserProviderCredentialStore,
    private readonly log: Logger,
    options: ModelCredentialsServiceOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.adapterFor =
      options.adapterFor ?? ((provider) => getSubscriptionOAuthAdapterIfKnown(provider));
  }

  async issue(input: IssueModelCredentialInput): Promise<ModelCredentialResult> {
    let credential;
    try {
      credential = await this.store.getForIssuance(input.ownerUserId, input.provider);
    } catch (e) {
      if (e instanceof ProviderCredentialValidationError) {
        return { ok: false, status: 400, error: e.message, reason: "invalid_request" };
      }
      if (e instanceof ProviderCredentialDecryptionError) {
        this.log.error("model.credential_undecryptable", {
          event: "model.credential_undecryptable",
          session_id: input.sessionId,
          user_id: input.ownerUserId,
          provider: input.provider,
          credential_id: e.credentialId,
        });
        return {
          ok: false,
          status: 500,
          error: "Stored provider credential could not be read",
          reason: "credential_unusable",
        };
      }
      // A storage fault is transient from the harness's point of view: the
      // next turn's fetch should retry rather than fail the session.
      this.log.warn("model.credential_lookup_failed", {
        event: "model.credential_lookup_failed",
        session_id: input.sessionId,
        user_id: input.ownerUserId,
        provider: input.provider,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 502,
        error: "Provider credential storage unavailable",
        reason: "storage_unavailable",
      };
    }

    if (!credential) {
      this.logDenied(input, "no_credential");
      return {
        ok: false,
        status: 404,
        error: `No credential is connected for provider '${input.provider}'`,
        reason: "no_credential",
      };
    }

    let kind: ModelCredentialKind;
    let secret = credential.secret;
    let providerExpiresAt = credential.secretExpiresAt;

    if (credential.kind === "api_key") {
      kind = "api_key";
    } else if (credential.kind === "oauth_grant") {
      const refreshed = await this.refreshOAuthIfDue(input, credential);
      if (!refreshed.ok) return refreshed;
      kind = "oauth";
      secret = refreshed.access;
      providerExpiresAt = refreshed.expiresAt;
    } else {
      this.logDenied(input, "unsupported_kind");
      return {
        ok: false,
        status: 500,
        error: "Stored provider credential has an unsupported kind",
        reason: "unsupported_kind",
      };
    }

    const issuedAt = this.now();
    const ttlCap = issuedAt + MODEL_CREDENTIAL_TTL_MS;
    const expiresAtEpochMs =
      providerExpiresAt === null ? ttlCap : Math.min(ttlCap, providerExpiresAt);

    try {
      await this.store.touchLastUsed(input.ownerUserId, credential.id);
    } catch (e) {
      // The usage stamp is bookkeeping; losing it must not fail an issuance
      // that has otherwise succeeded.
      this.log.warn("model.credential_touch_failed", {
        event: "model.credential_touch_failed",
        credential_id: credential.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    this.log.info("model.credential_issued", {
      event: "model.credential_issued",
      session_id: input.sessionId,
      user_id: input.ownerUserId,
      provider: credential.provider,
      credential_id: credential.id,
      kind,
      expires_at: expiresAtEpochMs,
    });

    return {
      ok: true,
      kind,
      provider: credential.provider,
      credentialId: credential.id,
      apiKey: secret,
      expiresAtEpochMs,
    };
  }

  private async refreshOAuthIfDue(
    input: IssueModelCredentialInput,
    credential: DecryptedProviderCredential
  ): Promise<
    | { ok: true; access: string; expiresAt: number | null }
    | Extract<ModelCredentialResult, { ok: false }>
  > {
    const due =
      credential.secretExpiresAt !== null &&
      this.now() + OAUTH_ACCESS_REFRESH_SKEW_MS >= credential.secretExpiresAt;
    if (!due) {
      return { ok: true, access: credential.secret, expiresAt: credential.secretExpiresAt };
    }

    const adapter = this.adapterFor(credential.provider);
    if (!adapter?.refresh || !credential.refreshSecret) {
      this.logDenied(input, "oauth_grant_invalid");
      return {
        ok: false,
        status: 409,
        error: `The ${credential.provider} subscription has expired; sign in again`,
        reason: "oauth_grant_invalid",
      };
    }

    let tokens;
    try {
      tokens = await adapter.refresh(credential.refreshSecret);
    } catch (e) {
      if (e instanceof ProviderOAuthRequestError && e.invalidGrant) {
        this.logDenied(input, "oauth_grant_invalid");
        return {
          ok: false,
          status: 409,
          error: `The ${credential.provider} subscription is no longer valid; sign in again`,
          reason: "oauth_grant_invalid",
        };
      }
      this.log.warn("model.oauth_refresh_failed", {
        event: "model.oauth_refresh_failed",
        session_id: input.sessionId,
        user_id: input.ownerUserId,
        provider: credential.provider,
        credential_id: credential.id,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 502,
        error: `Could not refresh the ${credential.provider} subscription`,
        reason: "provider_unavailable",
      };
    }

    try {
      await this.store.rotateOAuthGrant({
        userId: input.ownerUserId,
        provider: credential.provider,
        accessToken: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: tokens.expiresAt,
      });
    } catch (e) {
      this.log.warn("model.oauth_rotate_failed", {
        event: "model.oauth_rotate_failed",
        session_id: input.sessionId,
        credential_id: credential.id,
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        ok: false,
        status: 502,
        error: "Provider credential storage unavailable",
        reason: "storage_unavailable",
      };
    }

    return { ok: true, access: tokens.access, expiresAt: tokens.expiresAt };
  }

  private logDenied(input: IssueModelCredentialInput, reason: ModelCredentialDenialReason): void {
    this.log.warn("model.credential_denied", {
      event: "model.credential_denied",
      session_id: input.sessionId,
      user_id: input.ownerUserId,
      provider: input.provider,
      reason,
    });
  }
}
