/**
 * Pi's bundled subscription OAuth, as the control plane speaks it.
 *
 * These adapters reuse the public client ids, token URLs, and refresh
 * contracts Pi already ships in `@earendil-works/pi-ai`. They do not load Pi
 * extensions: an extension can register tools, and homestead containment is
 * the allowlist plus `noExtensions`. Auth protocol is copied here so a
 * Workers runtime can run it — Pi's own login helpers bind `http.createServer`
 * on localhost, which is the CLI path, not this product's.
 *
 * Homestead still talks to Pi only through a short-lived issued credential.
 * Refresh tokens never leave the vault.
 */

export const SUBSCRIPTION_SIGN_IN_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "openrouter",
  "github-copilot",
  "kimi-coding",
  "xai",
] as const;

export type SubscriptionSignInProviderId = (typeof SUBSCRIPTION_SIGN_IN_PROVIDERS)[number];

export function isSubscriptionSignInProvider(
  value: unknown
): value is SubscriptionSignInProviderId {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_SIGN_IN_PROVIDERS as readonly string[]).includes(value)
  );
}

export type SubscriptionSignInFlow = "authorization_code" | "device_code";

export interface SubscriptionSignInProviderInfo {
  readonly id: SubscriptionSignInProviderId;
  readonly name: string;
  readonly loginLabel: string;
  readonly flow: SubscriptionSignInFlow;
}

/** Tokens the vault stores after a successful sign-in or refresh. */
export interface OAuthGrantTokens {
  access: string;
  /** Null when the provider minted a non-refreshable key (OpenRouter). */
  refresh: string | null;
  /** Epoch ms; null when the access token does not expire. */
  expiresAt: number | null;
}

export interface AuthorizationCodeStart {
  authorizeUrl: string;
  instructions: string;
  payload: Record<string, string>;
}

export interface DeviceCodeStart {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  payload: Record<string, string>;
}

export type DevicePollResult =
  | { status: "pending"; intervalSeconds?: number }
  | { status: "complete"; tokens: OAuthGrantTokens }
  | { status: "denied"; message: string }
  | { status: "expired"; message: string }
  | { status: "failed"; message: string; retryable: boolean };

export interface SubscriptionOAuthAdapter {
  readonly id: SubscriptionSignInProviderId;
  readonly name: string;
  readonly loginLabel: string;
  readonly flow: SubscriptionSignInFlow;
  startAuthorizationCode?(): Promise<AuthorizationCodeStart>;
  completeAuthorizationCode?(
    payload: Record<string, string>,
    code: string
  ): Promise<OAuthGrantTokens>;
  startDeviceCode?(): Promise<DeviceCodeStart>;
  pollDeviceCode?(payload: Record<string, string>): Promise<DevicePollResult>;
  /**
   * Exchange a refresh token. OpenRouter's OAuth mints a long-lived key and
   * has no refresh; those adapters omit this.
   */
  refresh?(refreshToken: string): Promise<OAuthGrantTokens>;
}

export class ProviderOAuthRequestError extends Error {
  readonly retryable: boolean;
  readonly invalidGrant: boolean;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { retryable?: boolean; invalidGrant?: boolean; status?: number } = {}
  ) {
    super(message);
    this.name = "ProviderOAuthRequestError";
    this.retryable = options.retryable ?? false;
    this.invalidGrant = options.invalidGrant ?? false;
    this.status = options.status;
  }
}

export function subscriptionSignInInfo(
  id: SubscriptionSignInProviderId
): SubscriptionSignInProviderInfo {
  const info = SUBSCRIPTION_SIGN_IN_CATALOG.find((entry) => entry.id === id);
  if (!info) {
    throw new Error(`Unknown subscription sign-in provider '${id}'`);
  }
  return info;
}

export const SUBSCRIPTION_SIGN_IN_CATALOG: readonly SubscriptionSignInProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    loginLabel: "Sign in with Claude Pro/Max",
    flow: "authorization_code",
  },
  {
    id: "openai-codex",
    name: "OpenAI (ChatGPT Plus/Pro)",
    loginLabel: "Sign in with ChatGPT",
    flow: "device_code",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    loginLabel: "Sign in with OpenRouter",
    flow: "authorization_code",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    loginLabel: "Sign in with GitHub Copilot",
    flow: "device_code",
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    loginLabel: "Sign in with Kimi Code",
    flow: "device_code",
  },
  {
    id: "xai",
    name: "xAI (Grok/X subscription)",
    loginLabel: "Sign in with SuperGrok or X Premium",
    flow: "device_code",
  },
];
