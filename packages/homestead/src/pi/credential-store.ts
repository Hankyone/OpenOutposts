/**
 * The session's model credential, held for exactly as long as the control
 * plane said it was good for.
 *
 * Pi asks its credential store for the provider key on every model request, so
 * the store is the one seam where an expiry can mean anything. The mechanism
 * this replaces could not: an auth entry of the form `!command` has its stdout
 * cached in a module-level Map keyed by the command string, for the lifetime of
 * the homestead process, with no invalidation reachable from here. Under it the
 * hour-long expiry the broker issues bounded nothing, revoking a credential
 * left every live session running on it until the homestead restarted, and one
 * transient failure at first use was cached as that session's answer forever —
 * failures are cached identically.
 *
 * What this store guarantees instead:
 *
 * - The credential is re-issued from the control plane at the start of every
 *   turn, so a revoked or rotated vault entry takes effect on the next thing
 *   the user does rather than at the next process restart.
 * - A credential that reaches its issued expiry mid-turn is re-issued in place,
 *   so a turn outliving the TTL keeps running on a live credential rather than
 *   a dead one.
 * - A failed issuance is never the stored answer. It leaves the store holding
 *   nothing and is cleared by the next success.
 * - The store answers for one provider — the session's own — and never returns
 *   `undefined` for it. Returning `undefined` is how a credential store tells
 *   pi-ai "nothing is stored here", which sends it to the ambient environment:
 *   on a shared homestead that is the operator's own key standing in for the
 *   session owner's, which is the substitution this codebase exists to refuse.
 */

import { exec } from "node:child_process";

import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

import {
  fetchModelCredentialWithRetry,
  ModelCredentialError,
  type ModelCredentialRequest,
} from "./model-credential.js";

/**
 * Pi's credential-store contract, reached through the SDK option that accepts
 * one. Pi does not re-export the interface itself, and taking it from the
 * option means this file can never implement a shape the SDK would not take.
 */
export type PiCredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;

/**
 * How far before its stated expiry a credential is treated as due.
 *
 * It covers the request already in flight when the clock crosses over: a key
 * handed to the provider a moment before expiry must still be good when the
 * response comes back.
 */
export const CREDENTIAL_REFRESH_SKEW_MS = 60_000;

/** How long the development key command may take before it is abandoned. */
const KEY_COMMAND_TIMEOUT_MS = 10_000;

/**
 * A credential as this store holds it.
 *
 * `expiresAtEpochMs` is the issuer's number, carried through rather than
 * recomputed from a local constant: the control plane owns the lifetime, and a
 * second copy of it here could disagree with the one that was actually issued.
 * It is absent only for the development key command, which is a static
 * operator key with no issued lifetime at all.
 */
export interface ResolvedModelCredential {
  kind?: "api_key" | "oauth";
  apiKey: string;
  expiresAtEpochMs?: number;
}

/**
 * A turn could not be given a credential.
 *
 * The message is the whole point of this class. Pi surfaces a model-layer
 * failure as the top-level `message` of whatever was thrown, and pi-ai wraps a
 * credential-store rejection as `Credential store read failed for <provider>`,
 * dropping the cause — so unless the harness substitutes this message the user
 * is told nothing but that something failed. Every message here names the
 * provider, says what the issuer said, and states that nothing was used in the
 * credential's place.
 */
export class ModelCredentialUnavailableError extends Error {
  /** The session's Pi provider id, or undefined when none was ever resolved. */
  readonly providerId: string | undefined;
  /** Whether another attempt could plausibly succeed without the user acting. */
  readonly retryable: boolean;

  private constructor(
    message: string,
    options: { providerId?: string | undefined; retryable: boolean }
  ) {
    super(message);
    this.name = "ModelCredentialUnavailableError";
    this.providerId = options.providerId;
    this.retryable = options.retryable;
  }

  /** The issuer was asked and did not issue. */
  static notIssued(
    providerId: string,
    detail: string,
    options: { retryable: boolean }
  ): ModelCredentialUnavailableError {
    const message = options.retryable
      ? `The ${providerId} credential for this session could not be refreshed: ${detail}. ` +
        `The turn was stopped rather than run on a credential the control plane could not reconfirm.`
      : `The ${providerId} credential for this session could not be issued: ${detail}. ` +
        `The turn was stopped rather than run on another key; check the ${providerId} ` +
        `credential on the account that owns this session.`;
    return new ModelCredentialUnavailableError(message, {
      providerId,
      retryable: options.retryable,
    });
  }

  /** There was never a credential to ask for. */
  static notConfigured(reason: string): ModelCredentialUnavailableError {
    return new ModelCredentialUnavailableError(
      `This session has no model credential configured: ${reason}. The homestead holds no ` +
        `provider key of its own, so nothing can be used in its place.`,
      { retryable: false }
    );
  }
}

/**
 * The store the harness holds, over and above what Pi asks of it.
 *
 * `revalidate` is the turn boundary and `failure` is what makes a failure
 * inside a turn attributable; both are the harness's business, not Pi's.
 */
export interface SessionCredentialStore extends PiCredentialStore {
  /** The one provider this store answers for, or null when none is configured. */
  readonly providerId: string | null;
  /**
   * Obtains a credential from the issuer now, whatever is already held.
   *
   * Called once at session start and again at the start of every turn. Every
   * issuance is a fresh ownership check at the control plane, so this is what
   * makes revoking a credential stop a live session rather than only stopping
   * the next one.
   */
  revalidate(): Promise<void>;
  /** The refusal that left this store holding nothing, if it is holding nothing. */
  failure(): ModelCredentialUnavailableError | null;
}

export interface IssuedCredentialStoreOptions {
  /** Pi provider id of the session's model, e.g. "anthropic". */
  providerId: string;
  /** Obtains a credential, or throws a reason worth showing the session's owner. */
  issue: () => Promise<ResolvedModelCredential>;
  refreshSkewMs?: number;
  now?: () => number;
  onLog?: (line: string) => void;
}

/**
 * Holds one session's credential and re-issues it when it is due.
 *
 * The whole of the caching policy is: a credential is held until the issuer's
 * expiry is within the refresh skew, and a failed issuance leaves nothing held.
 * There is no negative cache and no stale-while-revalidate — a credential the
 * control plane has declined to reissue is not a credential this session may
 * keep using, whether the decline was a revocation or an outage.
 */
export class IssuedCredentialStore implements SessionCredentialStore {
  readonly providerId: string;
  readonly #issue: () => Promise<ResolvedModelCredential>;
  readonly #refreshSkewMs: number;
  readonly #now: () => number;
  readonly #onLog: ((line: string) => void) | undefined;

  #held: ResolvedModelCredential | null = null;
  #inFlight: Promise<ResolvedModelCredential> | null = null;
  #failure: ModelCredentialUnavailableError | null = null;

  constructor(options: IssuedCredentialStoreOptions) {
    this.providerId = options.providerId;
    this.#issue = options.issue;
    this.#refreshSkewMs = options.refreshSkewMs ?? CREDENTIAL_REFRESH_SKEW_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#onLog = options.onLog;
  }

  async revalidate(): Promise<void> {
    await this.#issueNow();
  }

  failure(): ModelCredentialUnavailableError | null {
    return this.#failure;
  }

  /**
   * Pi's per-request read.
   *
   * A recorded refusal is replayed rather than retried: within a turn the
   * answer will not have changed, and replaying it immediately keeps a doomed
   * turn from spending its whole budget re-asking. The refusal is cleared by
   * the next successful issuance, which the next turn's `revalidate` performs —
   * so a transient failure costs one turn and not a session.
   */
  async read(
    providerId: string
  ): Promise<
    | { type: "api_key"; key: string }
    | { type: "oauth"; access: string; refresh: string; expires: number }
    | undefined
  > {
    if (providerId !== this.providerId) return undefined;
    if (this.#failure) throw this.#failure;
    const held = this.#held !== null && !this.#due() ? this.#held : await this.#issueNow();
    if (held.kind === "oauth") {
      // Pi refreshes OAuth grants through `modify`. This session's grant is
      // refreshed in the control plane vault at issuance; a far-future expires
      // keeps Pi from attempting a local refresh, and an empty refresh token
      // means there is nothing here to leak or rotate.
      return {
        type: "oauth",
        access: held.apiKey,
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
      };
    }
    return { type: "api_key", key: held.apiKey };
  }

  /**
   * Metadata only. Pi's contract forbids resolving the key while listing, and
   * this store takes that literally: listing is called during model-catalogue
   * refreshes, which must not cost the session an issuance.
   */
  list(): Promise<readonly { providerId: string; type: "api_key" | "oauth" }[]> {
    const type = this.#held?.kind === "oauth" ? "oauth" : "api_key";
    return Promise.resolve([{ providerId: this.providerId, type }]);
  }

  /**
   * Refused. `modify` is pi-ai's only write path, used for interactive login
   * and for rotating a stored OAuth grant. This session's credential is issued
   * by the control plane from its owner's vault; a write from the agent process
   * would be a credential this product cannot account for.
   */
  modify(): Promise<never> {
    return Promise.reject(
      new Error(
        `This session's ${this.providerId} credential is issued by the control plane and ` +
          `cannot be written from the agent process.`
      )
    );
  }

  /** Logout. Nothing is persisted, so this only drops what is held. */
  delete(providerId: string): Promise<void> {
    if (providerId === this.providerId) {
      this.#held = null;
      this.#failure = null;
    }
    return Promise.resolve();
  }

  #due(): boolean {
    const held = this.#held;
    if (held === null) return true;
    if (held.expiresAtEpochMs === undefined) return false;
    return this.#now() + this.#refreshSkewMs >= held.expiresAtEpochMs;
  }

  /**
   * One issuance at a time. Pi resolves auth per request and a turn makes many,
   * so without coalescing a credential falling due mid-turn would fan out into
   * one control-plane call per in-flight request.
   */
  #issueNow(): Promise<ResolvedModelCredential> {
    if (this.#inFlight) return this.#inFlight;
    const attempt = (async () => {
      try {
        const issued = await this.#issue();
        this.#held = issued;
        this.#failure = null;
        this.#onLog?.(
          `credential: ${this.providerId} credential issued${
            issued.expiresAtEpochMs === undefined
              ? ""
              : `, valid for ${Math.round((issued.expiresAtEpochMs - this.#now()) / 1000)}s`
          }`
        );
        return issued;
      } catch (error) {
        const unavailable = asUnavailable(this.providerId, error);
        // Dropping what is held is the point: a credential the issuer has just
        // declined to reissue must not answer the next request.
        this.#held = null;
        this.#failure = unavailable;
        throw unavailable;
      } finally {
        this.#inFlight = null;
      }
    })();
    this.#inFlight = attempt;
    return attempt;
  }
}

/**
 * The store for a session that has no credential to fetch at all.
 *
 * It refuses rather than reporting nothing stored, because reporting nothing
 * stored is what sends pi-ai to the ambient environment. A session with no
 * credential must fail saying so, not quietly run on whatever key the homestead
 * machine happens to carry.
 */
export function unconfiguredCredentialStore(reason: string): SessionCredentialStore {
  const refusal = ModelCredentialUnavailableError.notConfigured(reason);
  return {
    providerId: null,
    read: () => Promise.reject(refusal),
    list: () => Promise.resolve([]),
    modify: () => Promise.reject(refusal),
    delete: () => Promise.resolve(),
    revalidate: () => Promise.reject(refusal),
    failure: () => refusal,
  };
}

/**
 * How a session obtains its provider key.
 *
 * Both forms end up in the same store, so the caching, the expiry and the
 * refusal behaviour are identical whichever is in use. What differs is only
 * where the key comes from.
 */
export type PiCredential =
  | {
      /**
       * The product path: the control plane issues a credential scoped to this
       * one session, resolved from the session owner's own vault.
       */
      kind: "brokered";
      /** Pi provider id, e.g. "anthropic" or "openrouter". */
      providerId: string;
      request: ModelCredentialRequest;
    }
  | {
      /**
       * DEVELOPMENT ONLY: an operator-supplied command, the same key for every
       * session the homestead serves. It exists for the local quickstart, where
       * there is no signed-in user to own a vault entry.
       */
      kind: "key-command";
      providerId: string;
      keyCommand: string;
    };

export interface CreateSessionCredentialStoreOptions {
  onLog?: (line: string) => void;
  now?: () => number;
  refreshSkewMs?: number;
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export function createSessionCredentialStore(
  credential: PiCredential,
  options: CreateSessionCredentialStoreOptions = {}
): SessionCredentialStore {
  const issue =
    credential.kind === "brokered"
      ? () =>
          fetchModelCredentialWithRetry(credential.request, {
            ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
            ...(options.now === undefined ? {} : { now: options.now }),
          }).then((issued) => ({
            kind: issued.kind,
            apiKey: issued.apiKey,
            expiresAtEpochMs: issued.expiresAtEpochMs,
          }))
      : () => runKeyCommand(credential.keyCommand);

  return new IssuedCredentialStore({
    providerId: credential.providerId,
    issue,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.refreshSkewMs === undefined ? {} : { refreshSkewMs: options.refreshSkewMs }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  });
}

/**
 * Runs the development key command and takes its stdout as the key.
 *
 * It carries no expiry: it is a static operator key, and claiming a lifetime
 * for it would be inventing one. It is still re-run at every turn boundary, so
 * an operator who changes the key does not have to restart the homestead.
 */
function runKeyCommand(command: string): Promise<ResolvedModelCredential> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: KEY_COMMAND_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new ModelCredentialError(
              `the development key command failed: ${lastLine(stderr) || error.message}`,
              { retryable: false }
            )
          );
          return;
        }
        const key = stdout.trim();
        if (key.length === 0) {
          reject(
            new ModelCredentialError(
              `the development key command printed nothing${
                lastLine(stderr) ? `: ${lastLine(stderr)}` : ""
              }`,
              { retryable: false }
            )
          );
          return;
        }
        resolve({ apiKey: key });
      }
    );
  });
}

/** Last non-empty stderr line, capped: diagnosis without a wall of output. */
function lastLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .pop();
  if (!line) return "";
  return line.length > 500 ? `${line.slice(0, 500)}…` : line;
}

function asUnavailable(providerId: string, error: unknown): ModelCredentialUnavailableError {
  if (error instanceof ModelCredentialUnavailableError) return error;
  if (error instanceof ModelCredentialError) {
    return ModelCredentialUnavailableError.notIssued(providerId, error.message, {
      retryable: error.retryable,
    });
  }
  // An unclassified fault is treated as transient: it says nothing about the
  // user's credential, and calling it permanent would tell them to go fix
  // something that is not broken.
  return ModelCredentialUnavailableError.notIssued(
    providerId,
    error instanceof Error ? error.message : String(error),
    { retryable: true }
  );
}
