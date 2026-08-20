/**
 * Browser-first Pi-subscription sign-in.
 *
 * Starts a device-code or paste-code flow, holds the verifier/device_code in
 * the vault, and on success writes an oauth_grant. Refresh tokens never leave
 * the control plane.
 */

import {
  AUTHORIZATION_CODE_FLOW_LIFETIME_MS,
  DEVICE_CODE_FLOW_MAX_LIFETIME_MS,
  ProviderOAuthFlowDecryptionError,
  ProviderOAuthFlowValidationError,
  type ProviderOAuthFlowStore,
} from "../db/provider-oauth-flows";
import {
  ProviderCredentialValidationError,
  type PutOAuthGrantResult,
  type UserProviderCredentialStore,
} from "../db/user-provider-credentials";
import {
  getSubscriptionOAuthAdapter,
  isSubscriptionSignInProvider,
  parsePastedAuthorizationCode,
  ProviderOAuthRequestError,
  type ProviderFetchOptions,
  type SubscriptionOAuthAdapter,
  type SubscriptionSignInProviderId,
} from "./pi-oauth";

export class ProviderOAuthSignInError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; retryable?: boolean }) {
    super(message);
    this.name = "ProviderOAuthSignInError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export type ProviderOAuthStartResult =
  | {
      flow: "authorization_code";
      provider: SubscriptionSignInProviderId;
      authorizeUrl: string;
      instructions: string;
      expiresAt: number;
    }
  | {
      flow: "device_code";
      provider: SubscriptionSignInProviderId;
      userCode: string;
      verificationUri: string;
      intervalSeconds: number;
      expiresInSeconds: number;
      expiresAt: number;
    };

export type ProviderOAuthPollResult =
  | { status: "pending"; intervalSeconds?: number }
  | { status: "complete"; result: PutOAuthGrantResult }
  | { status: "denied"; message: string }
  | { status: "expired"; message: string };

export interface ProviderOAuthSignInServiceOptions extends ProviderFetchOptions {
  adapterFor?: (id: SubscriptionSignInProviderId) => SubscriptionOAuthAdapter;
}

function requireSubscriptionProvider(provider: string): SubscriptionSignInProviderId {
  const normalized = provider.trim().toLowerCase();
  if (!isSubscriptionSignInProvider(normalized)) {
    throw new ProviderOAuthSignInError(
      `Subscription sign-in is not available for provider '${provider}'`,
      { status: 400 }
    );
  }
  return normalized;
}

export class ProviderOAuthSignInService {
  private readonly adapterFor: (id: SubscriptionSignInProviderId) => SubscriptionOAuthAdapter;

  constructor(
    private readonly flows: ProviderOAuthFlowStore,
    private readonly credentials: UserProviderCredentialStore,
    options: ProviderOAuthSignInServiceOptions = {}
  ) {
    const fetchOptions: ProviderFetchOptions = {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    };
    this.adapterFor = options.adapterFor ?? ((id) => getSubscriptionOAuthAdapter(id, fetchOptions));
  }

  async start(userId: string, provider: string): Promise<ProviderOAuthStartResult> {
    const id = requireSubscriptionProvider(provider);
    const adapter = this.adapterFor(id);

    try {
      if (adapter.flow === "authorization_code") {
        if (!adapter.startAuthorizationCode) {
          throw new ProviderOAuthSignInError("This provider cannot start a paste-code sign-in", {
            status: 500,
          });
        }
        const started = await adapter.startAuthorizationCode();
        const stored = await this.flows.replace({
          userId,
          provider: id,
          flowKind: "authorization_code",
          payload: started.payload,
          lifetimeMs: AUTHORIZATION_CODE_FLOW_LIFETIME_MS,
        });
        return {
          flow: "authorization_code",
          provider: id,
          authorizeUrl: started.authorizeUrl,
          instructions: started.instructions,
          expiresAt: stored.expiresAt,
        };
      }

      if (!adapter.startDeviceCode) {
        throw new ProviderOAuthSignInError("This provider cannot start a device-code sign-in", {
          status: 500,
        });
      }
      const started = await adapter.startDeviceCode();
      const lifetimeMs = Math.min(
        DEVICE_CODE_FLOW_MAX_LIFETIME_MS,
        Math.max(1_000, started.expiresInSeconds * 1000)
      );
      const stored = await this.flows.replace({
        userId,
        provider: id,
        flowKind: "device_code",
        payload: started.payload,
        lifetimeMs,
      });
      return {
        flow: "device_code",
        provider: id,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        intervalSeconds: started.intervalSeconds,
        expiresInSeconds: started.expiresInSeconds,
        expiresAt: stored.expiresAt,
      };
    } catch (error) {
      throw this.rewrite(error);
    }
  }

  async complete(userId: string, provider: string, pasted: string): Promise<PutOAuthGrantResult> {
    const id = requireSubscriptionProvider(provider);
    const adapter = this.adapterFor(id);
    const code = parsePastedAuthorizationCode(pasted);
    if (!code) {
      throw new ProviderOAuthSignInError(
        "Could not find an authorization code in what you pasted",
        { status: 400 }
      );
    }

    const flow = await this.requireFlow(userId, id, "authorization_code");
    if (!adapter.completeAuthorizationCode) {
      throw new ProviderOAuthSignInError("This provider cannot complete a paste-code sign-in", {
        status: 500,
      });
    }

    try {
      const tokens = await adapter.completeAuthorizationCode(flow.payload, code);
      const result = await this.credentials.putOAuthGrant({
        userId,
        provider: id,
        accessToken: tokens.access,
        refreshToken: tokens.refresh,
        expiresAt: tokens.expiresAt,
        label: adapter.loginLabel,
      });
      await this.flows.delete(userId, id);
      return result;
    } catch (error) {
      throw this.rewrite(error);
    }
  }

  async poll(userId: string, provider: string): Promise<ProviderOAuthPollResult> {
    const id = requireSubscriptionProvider(provider);
    const adapter = this.adapterFor(id);
    const flow = await this.requireFlow(userId, id, "device_code");
    if (!adapter.pollDeviceCode) {
      throw new ProviderOAuthSignInError("This provider cannot poll a device-code sign-in", {
        status: 500,
      });
    }

    try {
      const polled = await adapter.pollDeviceCode(flow.payload);
      if (polled.status === "pending") {
        return { status: "pending", intervalSeconds: polled.intervalSeconds };
      }
      if (polled.status === "denied") {
        await this.flows.delete(userId, id);
        return { status: "denied", message: polled.message };
      }
      if (polled.status === "expired") {
        await this.flows.delete(userId, id);
        return { status: "expired", message: polled.message };
      }
      if (polled.status === "failed") {
        throw new ProviderOAuthSignInError(polled.message, {
          status: polled.retryable ? 502 : 400,
          retryable: polled.retryable,
        });
      }
      const result = await this.credentials.putOAuthGrant({
        userId,
        provider: id,
        accessToken: polled.tokens.access,
        refreshToken: polled.tokens.refresh,
        expiresAt: polled.tokens.expiresAt,
        label: adapter.loginLabel,
      });
      await this.flows.delete(userId, id);
      return { status: "complete", result };
    } catch (error) {
      throw this.rewrite(error);
    }
  }

  async cancel(userId: string, provider: string): Promise<boolean> {
    const id = requireSubscriptionProvider(provider);
    return this.flows.delete(userId, id);
  }

  private async requireFlow(
    userId: string,
    provider: SubscriptionSignInProviderId,
    expected: "authorization_code" | "device_code"
  ) {
    let flow;
    try {
      flow = await this.flows.get(userId, provider);
    } catch (error) {
      throw this.rewrite(error);
    }
    if (!flow) {
      throw new ProviderOAuthSignInError("No sign-in is in progress for this provider", {
        status: 404,
      });
    }
    if (flow.flowKind !== expected) {
      throw new ProviderOAuthSignInError(
        expected === "authorization_code"
          ? "This provider's sign-in is waiting for a device code, not a pasted authorization code"
          : "This provider's sign-in is waiting for a pasted authorization code, not a device poll",
        { status: 409 }
      );
    }
    return flow;
  }

  private rewrite(error: unknown): Error {
    if (
      error instanceof ProviderOAuthSignInError ||
      error instanceof ProviderCredentialValidationError
    ) {
      if (error instanceof ProviderCredentialValidationError) {
        return new ProviderOAuthSignInError(error.message, { status: 400 });
      }
      return error;
    }
    if (error instanceof ProviderOAuthFlowValidationError) {
      return new ProviderOAuthSignInError(error.message, { status: 400 });
    }
    if (error instanceof ProviderOAuthFlowDecryptionError) {
      return new ProviderOAuthSignInError("Stored sign-in flow could not be read", { status: 500 });
    }
    if (error instanceof ProviderOAuthRequestError) {
      if (error.invalidGrant) {
        return new ProviderOAuthSignInError(error.message, { status: 400 });
      }
      return new ProviderOAuthSignInError(error.message, {
        status: error.retryable ? 502 : 400,
        retryable: error.retryable,
      });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
