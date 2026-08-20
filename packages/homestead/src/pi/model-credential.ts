/**
 * The session's model credential: how a centrally running harness gets a
 * provider key that belongs to the session's owner and to nobody else.
 *
 * The homestead holds no provider key of its own. This module is one issuance —
 * a request to the control plane's per-session credential endpoint — and
 * nothing more. When it is issued, how long it is held, and what happens when
 * it cannot be issued belong to credential-store.ts.
 *
 * Nothing here touches disk. The request lives in the homestead's memory for the
 * life of the session; the key exists only in the returned value and in Pi's
 * memory.
 *
 * The bearer is deliberately NOT the session's bridge credential. That one
 * also authorizes PR creation, media upload, child-session spawn and Slack
 * notification, and this is the one credential the agent's own session state
 * carries. The fetch token opens the credential endpoint and nothing else.
 */

/**
 * How long one issuance may take in total, retries included.
 *
 * It runs at a turn boundary with the user waiting, so the budget is short
 * enough to fail visibly rather than look like a hung session.
 */
export const CREDENTIAL_FETCH_BUDGET_MS = 8_000;

/** Per-attempt HTTP timeout, leaving room for one retry inside the budget. */
const ATTEMPT_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 400;
const MAX_FETCH_ATTEMPTS = 3;

export interface ModelCredentialRequest {
  /** Control-plane base URL the homestead itself reaches the deployment on. */
  controlPlaneUrl: string;
  productSessionId: string;
  /** Harness provider id the credential is wanted for, e.g. "anthropic". */
  provider: string;
  /**
   * The session's credential-fetch token. The credential endpoint refuses the
   * homestead credential and the session's own bridge token alike,
   * so this is the only credential that can fetch this session's key — and it
   * can fetch no other session's, and nothing else about this one.
   */
  credentialFetchToken: string;
}

export interface IssuedModelCredential {
  provider: string;
  kind: "api_key" | "oauth";
  apiKey: string;
  expiresAtEpochMs: number;
}

/**
 * A fetch that failed. `retryable` separates "the control plane is briefly
 * unavailable" from "this user has no credential for this provider": the
 * first is worth another attempt inside the budget, the second never is.
 */
export class ModelCredentialError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "ModelCredentialError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface FetchModelCredentialOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Asks the control plane to issue this session's provider credential.
 *
 * Failures carry the control plane's own message where there is one; the key
 * never appears in an error, and neither does the fetch token.
 */
export async function fetchModelCredential(
  request: ModelCredentialRequest,
  options: FetchModelCredentialOptions = {}
): Promise<IssuedModelCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const base = request.controlPlaneUrl.replace(/\/+$/, "");
  const url = `${base}/sessions/${encodeURIComponent(request.productSessionId)}/model-credentials`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.credentialFetchToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: request.provider }),
      signal: controller.signal,
    });
  } catch (error) {
    // A network fault, a DNS failure, or our own abort. All are worth another
    // attempt: none of them says anything about the credential itself.
    throw new ModelCredentialError(
      `could not reach the control plane: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await readErrorMessage(response);
    // 5xx and the two "come back later" 4xx codes are the transient set; every
    // other refusal is a decision about this user and this provider.
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new ModelCredentialError(
      `control plane refused to issue a credential (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      { retryable, status: response.status }
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ModelCredentialError("credential response was not JSON", {
      retryable: true,
      status: response.status,
    });
  }

  const record = (body ?? {}) as Record<string, unknown>;
  const apiKey = record.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ModelCredentialError("credential response carried no key", {
      retryable: false,
      status: response.status,
    });
  }
  const expiresAtEpochMs = record.expires_at_epoch_ms;
  if (typeof expiresAtEpochMs !== "number" || !Number.isFinite(expiresAtEpochMs)) {
    throw new ModelCredentialError("credential response carried no usable expiry", {
      retryable: false,
      status: response.status,
    });
  }
  if (expiresAtEpochMs <= now()) {
    throw new ModelCredentialError("credential was issued already expired", {
      retryable: false,
      status: response.status,
    });
  }

  const kind = record.kind === "oauth" ? "oauth" : "api_key";

  return {
    provider: typeof record.provider === "string" ? record.provider : request.provider,
    kind,
    apiKey,
    expiresAtEpochMs,
  };
}

/**
 * Fetches with retries, bounded by the issuance budget. Only transient
 * refusals are retried.
 */
export async function fetchModelCredentialWithRetry(
  request: ModelCredentialRequest,
  options: FetchModelCredentialOptions & {
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<IssuedModelCredential> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.budgetMs ?? CREDENTIAL_FETCH_BUDGET_MS);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchModelCredential(request, options);
    } catch (error) {
      const retryable = error instanceof ModelCredentialError && error.retryable;
      const roomLeft = now() + ATTEMPT_TIMEOUT_MS + RETRY_DELAY_MS <= deadline;
      // The attempt cap is the real stop condition when the clock is not the
      // wall clock; the deadline is the one that bounds the waiting user.
      if (!retryable || !roomLeft || attempt >= MAX_FETCH_ATTEMPTS) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}
