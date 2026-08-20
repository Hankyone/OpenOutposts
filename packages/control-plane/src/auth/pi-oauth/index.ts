/**
 * Pi-subscription OAuth adapters, loaded by id.
 *
 * The catalog and the factories live here so a caller can describe or run a
 * sign-in flow without importing `@earendil-works/pi-ai` or any Pi extension.
 * Auth protocol is copied; tool extensions are not.
 */

import { anthropicOAuthAdapter } from "./anthropic";
import { githubCopilotOAuthAdapter } from "./github-copilot";
import { kimiCodingOAuthAdapter } from "./kimi-coding";
import { openaiCodexOAuthAdapter } from "./openai-codex";
import { openRouterOAuthAdapter } from "./openrouter";
import type { ProviderFetchOptions } from "./http";
import {
  isSubscriptionSignInProvider,
  type SubscriptionOAuthAdapter,
  type SubscriptionSignInProviderId,
} from "./types";
import { xaiOAuthAdapter } from "./xai";

export {
  SUBSCRIPTION_SIGN_IN_CATALOG,
  SUBSCRIPTION_SIGN_IN_PROVIDERS,
  isSubscriptionSignInProvider,
  subscriptionSignInInfo,
  ProviderOAuthRequestError,
  type DeviceCodeStart,
  type DevicePollResult,
  type OAuthGrantTokens,
  type SubscriptionOAuthAdapter,
  type SubscriptionSignInFlow,
  type SubscriptionSignInProviderId,
  type SubscriptionSignInProviderInfo,
} from "./types";
export { parsePastedAuthorizationCode } from "./paste-code";
export type { ProviderFetchOptions } from "./http";

const ADAPTERS: Record<
  SubscriptionSignInProviderId,
  (options?: ProviderFetchOptions) => SubscriptionOAuthAdapter
> = {
  anthropic: anthropicOAuthAdapter,
  "openai-codex": openaiCodexOAuthAdapter,
  openrouter: openRouterOAuthAdapter,
  "github-copilot": githubCopilotOAuthAdapter,
  "kimi-coding": kimiCodingOAuthAdapter,
  xai: xaiOAuthAdapter,
};

export function getSubscriptionOAuthAdapter(
  id: SubscriptionSignInProviderId,
  options: ProviderFetchOptions = {}
): SubscriptionOAuthAdapter {
  return ADAPTERS[id](options);
}

export function getSubscriptionOAuthAdapterIfKnown(
  provider: string,
  options: ProviderFetchOptions = {}
): SubscriptionOAuthAdapter | null {
  if (!isSubscriptionSignInProvider(provider)) return null;
  return getSubscriptionOAuthAdapter(provider, options);
}
