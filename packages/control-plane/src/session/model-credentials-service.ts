import type { Logger } from "../logger";
import {
  ProviderCredentialDecryptionError,
  ProviderCredentialValidationError,
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
  | "storage_unavailable";

export type ModelCredentialResult =
  | {
      ok: true;
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
 */
export class ModelCredentialsService {
  constructor(
    private readonly store: UserProviderCredentialStore,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now()
  ) {}

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

    if (credential.kind !== "api_key") {
      // The column shape holds an OAuth grant, but issuing one means refreshing
      // it against the provider first. Refusing beats handing a session an
      // access token that may already be dead.
      this.logDenied(input, "unsupported_kind");
      return {
        ok: false,
        status: 500,
        error: "OAuth-backed provider credentials cannot be issued to a session yet",
        reason: "unsupported_kind",
      };
    }

    const issuedAt = this.now();
    const expiresAtEpochMs = issuedAt + MODEL_CREDENTIAL_TTL_MS;

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
      expires_at: expiresAtEpochMs,
    });

    return {
      ok: true,
      provider: credential.provider,
      credentialId: credential.id,
      apiKey: credential.secret,
      expiresAtEpochMs,
    };
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
