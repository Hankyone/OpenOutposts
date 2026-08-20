import { describe, expect, it, vi } from "vitest";
import type { ProviderOAuthFlowRecord, ProviderOAuthFlowStore } from "../db/provider-oauth-flows";
import type { UserProviderCredentialStore } from "../db/user-provider-credentials";
import type { SubscriptionOAuthAdapter } from "./pi-oauth";
import {
  ProviderOAuthSignInError,
  ProviderOAuthSignInService,
} from "./provider-oauth-sign-in-service";

function fakeFlows(
  current: ProviderOAuthFlowRecord | null = null
): ProviderOAuthFlowStore & { current: ProviderOAuthFlowRecord | null } {
  const store = {
    current,
    replace: vi.fn(async (input) => {
      store.current = {
        id: "flow-1",
        provider: input.provider,
        flowKind: input.flowKind,
        payload: input.payload,
        expiresAt: 1_700_000_000_000 + input.lifetimeMs,
      };
      return { id: "flow-1", expiresAt: store.current.expiresAt };
    }),
    get: vi.fn(async () => store.current),
    delete: vi.fn(async () => {
      const had = store.current !== null;
      store.current = null;
      return had;
    }),
  };
  return store as unknown as ProviderOAuthFlowStore & { current: ProviderOAuthFlowRecord | null };
}

function fakeCredentials(): UserProviderCredentialStore {
  return {
    putOAuthGrant: vi.fn().mockResolvedValue({
      created: true,
      credential: {
        id: "cred-1",
        provider: "anthropic",
        label: "Sign in with Claude Pro/Max",
        kind: "oauth_grant",
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        secretExpiresAt: 2,
      },
    }),
  } as unknown as UserProviderCredentialStore;
}

const authCodeAdapter: SubscriptionOAuthAdapter = {
  id: "anthropic",
  name: "Anthropic (Claude Pro/Max)",
  loginLabel: "Sign in with Claude Pro/Max",
  flow: "authorization_code",
  startAuthorizationCode: vi.fn().mockResolvedValue({
    authorizeUrl: "https://claude.ai/oauth/authorize?x=1",
    instructions: "paste",
    payload: { verifier: "v".repeat(43) },
  }),
  completeAuthorizationCode: vi.fn().mockResolvedValue({
    access: "at",
    refresh: "rt",
    expiresAt: 9,
  }),
};

const deviceAdapter: SubscriptionOAuthAdapter = {
  id: "xai",
  name: "xAI",
  loginLabel: "Sign in with SuperGrok or X Premium",
  flow: "device_code",
  startDeviceCode: vi.fn().mockResolvedValue({
    userCode: "ABCD",
    verificationUri: "https://auth.x.ai/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
    payload: { deviceCode: "dc" },
  }),
  pollDeviceCode: vi.fn(),
};

describe("ProviderOAuthSignInService", () => {
  it("starts a paste-code flow without returning the PKCE verifier", async () => {
    const flows = fakeFlows();
    const started = await new ProviderOAuthSignInService(flows, fakeCredentials(), {
      adapterFor: () => authCodeAdapter,
    }).start("user-1", "anthropic");

    expect(started).toMatchObject({
      flow: "authorization_code",
      authorizeUrl: "https://claude.ai/oauth/authorize?x=1",
    });
    expect(JSON.stringify(started)).not.toContain("v".repeat(43));
    expect(flows.replace).toHaveBeenCalled();
  });

  it("completes a pasted code into an oauth_grant and deletes the flow", async () => {
    const flows = fakeFlows({
      id: "flow-1",
      provider: "anthropic",
      flowKind: "authorization_code",
      payload: { verifier: "v".repeat(43) },
      expiresAt: Date.now() + 60_000,
    });
    const credentials = fakeCredentials();
    const result = await new ProviderOAuthSignInService(flows, credentials, {
      adapterFor: () => authCodeAdapter,
    }).complete("user-1", "anthropic", "http://localhost:53692/callback?code=the-code");

    expect(result.created).toBe(true);
    expect(authCodeAdapter.completeAuthorizationCode).toHaveBeenCalledWith(
      { verifier: "v".repeat(43) },
      "the-code"
    );
    expect(credentials.putOAuthGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        provider: "anthropic",
        accessToken: "at",
        refreshToken: "rt",
      })
    );
    expect(flows.delete).toHaveBeenCalledWith("user-1", "anthropic");
  });

  it("stores a grant when a device poll completes and reports pending otherwise", async () => {
    const flows = fakeFlows({
      id: "flow-1",
      provider: "xai",
      flowKind: "device_code",
      payload: { deviceCode: "dc" },
      expiresAt: Date.now() + 60_000,
    });
    const credentials = fakeCredentials();
    const pollDeviceCode = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending", intervalSeconds: 8 })
      .mockResolvedValueOnce({
        status: "complete",
        tokens: { access: "xai-at", refresh: "xai-rt", expiresAt: 10 },
      });
    const adapter = { ...deviceAdapter, pollDeviceCode };
    const service = new ProviderOAuthSignInService(flows, credentials, {
      adapterFor: () => adapter,
    });

    await expect(service.poll("user-1", "xai")).resolves.toEqual({
      status: "pending",
      intervalSeconds: 8,
    });
    expect(credentials.putOAuthGrant).not.toHaveBeenCalled();

    const completed = await service.poll("user-1", "xai");
    expect(completed.status).toBe("complete");
    expect(credentials.putOAuthGrant).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "xai-at", refreshToken: "xai-rt" })
    );
  });

  it("refuses an unknown provider and a missing paste", async () => {
    const service = new ProviderOAuthSignInService(fakeFlows(), fakeCredentials(), {
      adapterFor: () => authCodeAdapter,
    });
    await expect(service.start("user-1", "openai")).rejects.toBeInstanceOf(
      ProviderOAuthSignInError
    );
    await expect(service.complete("user-1", "anthropic", "not a code")).rejects.toMatchObject({
      status: 400,
    });
  });
});
