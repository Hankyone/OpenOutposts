import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SubscriptionOAuthAdapter } from "../auth/pi-oauth";
import { ProviderOAuthRequestError } from "../auth/pi-oauth";
import type {
  DecryptedProviderCredential,
  UserProviderCredentialStore,
} from "../db/user-provider-credentials";
import {
  MODEL_CREDENTIAL_TTL_MS,
  ModelCredentialsService,
  OAUTH_ACCESS_REFRESH_SKEW_MS,
} from "./model-credentials-service";

function createTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function apiKey(overrides: Partial<DecryptedProviderCredential> = {}): DecryptedProviderCredential {
  return {
    id: "cred-1",
    provider: "anthropic",
    kind: "api_key",
    secret: "sk-ant-1",
    refreshSecret: null,
    secretExpiresAt: null,
    ...overrides,
  };
}

function oauthGrant(
  overrides: Partial<DecryptedProviderCredential> = {}
): DecryptedProviderCredential {
  return {
    id: "cred-oauth",
    provider: "anthropic",
    kind: "oauth_grant",
    secret: "access-old",
    refreshSecret: "refresh-old",
    secretExpiresAt: 2_000_000_000_000,
    ...overrides,
  };
}

function fakeStore(
  credential: DecryptedProviderCredential | null,
  extra: Partial<UserProviderCredentialStore> = {}
): UserProviderCredentialStore {
  return {
    getForIssuance: vi.fn().mockResolvedValue(credential),
    touchLastUsed: vi.fn().mockResolvedValue(undefined),
    rotateOAuthGrant: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as unknown as UserProviderCredentialStore;
}

const INPUT = { sessionId: "sess-1", ownerUserId: "user-1", provider: "anthropic" };

describe("ModelCredentialsService", () => {
  it("issues an API key with the session TTL and kind=api_key", async () => {
    const now = 1_700_000_000_000;
    const store = fakeStore(apiKey());
    const result = await new ModelCredentialsService(store, createTestLogger(), {
      now: () => now,
    }).issue(INPUT);

    expect(result).toEqual({
      ok: true,
      kind: "api_key",
      provider: "anthropic",
      credentialId: "cred-1",
      apiKey: "sk-ant-1",
      expiresAtEpochMs: now + MODEL_CREDENTIAL_TTL_MS,
    });
    expect(store.touchLastUsed).toHaveBeenCalledWith("user-1", "cred-1");
    expect(store.rotateOAuthGrant).not.toHaveBeenCalled();
  });

  it("issues an unexpired OAuth grant without refreshing", async () => {
    const now = 1_700_000_000_000;
    const expiresAt = now + 20 * 60 * 1000;
    const store = fakeStore(oauthGrant({ secretExpiresAt: expiresAt }));
    const refresh = vi.fn();
    const result = await new ModelCredentialsService(store, createTestLogger(), {
      now: () => now,
      adapterFor: () => ({ refresh }) as unknown as SubscriptionOAuthAdapter,
    }).issue(INPUT);

    expect(result).toMatchObject({
      ok: true,
      kind: "oauth",
      apiKey: "access-old",
      expiresAtEpochMs: expiresAt,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(store.rotateOAuthGrant).not.toHaveBeenCalled();
  });

  it("refreshes an expired OAuth grant, stores the rotation, and returns kind=oauth", async () => {
    const now = 1_700_000_000_000;
    const store = fakeStore(
      oauthGrant({ secretExpiresAt: now + OAUTH_ACCESS_REFRESH_SKEW_MS - 1 })
    );
    const result = await new ModelCredentialsService(store, createTestLogger(), {
      now: () => now,
      adapterFor: () =>
        ({
          refresh: vi.fn().mockResolvedValue({
            access: "access-new",
            refresh: "refresh-new",
            expiresAt: now + 3600 * 1000,
          }),
        }) as unknown as SubscriptionOAuthAdapter,
    }).issue(INPUT);

    expect(result).toEqual({
      ok: true,
      kind: "oauth",
      provider: "anthropic",
      credentialId: "cred-oauth",
      apiKey: "access-new",
      expiresAtEpochMs: now + MODEL_CREDENTIAL_TTL_MS,
    });
    expect(store.rotateOAuthGrant).toHaveBeenCalledWith({
      userId: "user-1",
      provider: "anthropic",
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: now + 3600 * 1000,
    });
  });

  it("refuses a dead OAuth grant without retrying", async () => {
    const now = 1_700_000_000_000;
    const store = fakeStore(oauthGrant({ secretExpiresAt: now }));
    const result = await new ModelCredentialsService(store, createTestLogger(), {
      now: () => now,
      adapterFor: () =>
        ({
          refresh: vi
            .fn()
            .mockRejectedValue(new ProviderOAuthRequestError("revoked", { invalidGrant: true })),
        }) as unknown as SubscriptionOAuthAdapter,
    }).issue(INPUT);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      reason: "oauth_grant_invalid",
    });
    expect(store.rotateOAuthGrant).not.toHaveBeenCalled();
  });

  it("treats a retryable provider refresh failure as a 502", async () => {
    const now = 1_700_000_000_000;
    const store = fakeStore(oauthGrant({ secretExpiresAt: now }));
    const result = await new ModelCredentialsService(store, createTestLogger(), {
      now: () => now,
      adapterFor: () =>
        ({
          refresh: vi
            .fn()
            .mockRejectedValue(new ProviderOAuthRequestError("timeout", { retryable: true })),
        }) as unknown as SubscriptionOAuthAdapter,
    }).issue(INPUT);

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      reason: "provider_unavailable",
    });
  });
});
