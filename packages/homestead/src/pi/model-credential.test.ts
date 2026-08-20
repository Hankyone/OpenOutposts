import { describe, expect, it } from "vitest";

import {
  fetchModelCredential,
  fetchModelCredentialWithRetry,
  ModelCredentialError,
  type ModelCredentialRequest,
} from "./model-credential.js";

const request: ModelCredentialRequest = {
  controlPlaneUrl: "https://control.example/",
  productSessionId: "session-01",
  provider: "anthropic",
  credentialFetchToken: "credential-fetch-token",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchModelCredential", () => {
  it("asks the session's own credential endpoint with the session's own token", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const credential = await fetchModelCredential(request, {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return jsonResponse(200, {
          provider: "anthropic",
          credential_id: "cred-01",
          api_key: "sk-ant-secret",
          expires_at_epoch_ms: 2_000,
        });
      }) as unknown as typeof fetch,
      now: () => 1_000,
    });

    expect(seenUrl).toBe("https://control.example/sessions/session-01/model-credentials");
    expect(new Headers(seenInit?.headers).get("Authorization")).toBe(
      "Bearer credential-fetch-token"
    );
    expect(JSON.parse(String(seenInit?.body))).toEqual({ provider: "anthropic" });
    expect(credential).toEqual({
      provider: "anthropic",
      kind: "api_key",
      apiKey: "sk-ant-secret",
      expiresAtEpochMs: 2_000,
    });
  });

  it("carries kind=oauth from the control plane without inventing a refresh token", async () => {
    const credential = await fetchModelCredential(request, {
      fetchImpl: (async () =>
        jsonResponse(200, {
          provider: "anthropic",
          kind: "oauth",
          credential_id: "cred-01",
          api_key: "access-token",
          expires_at_epoch_ms: 2_000,
        })) as unknown as typeof fetch,
      now: () => 1_000,
    });

    expect(credential.kind).toBe("oauth");
    expect(credential.apiKey).toBe("access-token");
    expect(credential).not.toHaveProperty("refresh");
  });

  it("treats a refusal about this user's credential as permanent", async () => {
    const failure = await fetchModelCredential(request, {
      fetchImpl: (async () =>
        jsonResponse(404, {
          error: "No credential is connected for provider 'anthropic'",
        })) as unknown as typeof fetch,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelCredentialError);
    const error = failure as ModelCredentialError;
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(404);
    // The control plane's own words: "no credential" and "the deployment is
    // briefly broken" must not read the same in a log.
    expect(error.message).toContain("No credential is connected");
  });

  it("treats a storage or transport fault as worth retrying", async () => {
    const failure = (await fetchModelCredential(request, {
      fetchImpl: (async () =>
        jsonResponse(502, {
          error: "Provider credential storage unavailable",
        })) as unknown as typeof fetch,
    }).catch((error: unknown) => error)) as ModelCredentialError;

    expect(failure.retryable).toBe(true);

    const networkFailure = (await fetchModelCredential(request, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    }).catch((error: unknown) => error)) as ModelCredentialError;

    expect(networkFailure.retryable).toBe(true);
  });

  it("refuses a credential that is already expired", async () => {
    const failure = (await fetchModelCredential(request, {
      fetchImpl: (async () =>
        jsonResponse(200, {
          api_key: "sk-ant-secret",
          expires_at_epoch_ms: 500,
        })) as unknown as typeof fetch,
      now: () => 1_000,
    }).catch((error: unknown) => error)) as ModelCredentialError;

    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("expired");
  });

  it("refuses a response carrying no key rather than printing an empty one", async () => {
    const failure = (await fetchModelCredential(request, {
      fetchImpl: (async () =>
        jsonResponse(200, { expires_at_epoch_ms: 2_000 })) as unknown as typeof fetch,
      now: () => 1_000,
    }).catch((error: unknown) => error)) as ModelCredentialError;

    expect(failure.retryable).toBe(false);
  });
});

describe("fetchModelCredentialWithRetry", () => {
  it("retries a transient failure inside the budget", async () => {
    let attempts = 0;
    const credential = await fetchModelCredentialWithRetry(request, {
      fetchImpl: (async () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse(503, { error: "unavailable" });
        return jsonResponse(200, { api_key: "sk-ant-secret", expires_at_epoch_ms: 2_000 });
      }) as unknown as typeof fetch,
      now: () => 1_000,
      sleep: () => Promise.resolve(),
    });

    expect(attempts).toBe(2);
    expect(credential.apiKey).toBe("sk-ant-secret");
  });

  it("does not retry a decision about this user's credential", async () => {
    let attempts = 0;
    await fetchModelCredentialWithRetry(request, {
      fetchImpl: (async () => {
        attempts += 1;
        return jsonResponse(403, { error: "Session has no owner" });
      }) as unknown as typeof fetch,
      now: () => 1_000,
      sleep: () => Promise.resolve(),
    }).catch(() => {});

    expect(attempts).toBe(1);
  });

  it("gives up rather than retrying forever while the control plane is down", async () => {
    let attempts = 0;
    const failure = (await fetchModelCredentialWithRetry(request, {
      fetchImpl: (async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      // A frozen clock is the case the attempt cap exists for: without it the
      // deadline alone never arrives.
      now: () => 1_000,
      sleep: () => Promise.resolve(),
    }).catch((error: unknown) => error)) as ModelCredentialError;

    expect(attempts).toBe(3);
    expect(failure.retryable).toBe(true);
  });
});
