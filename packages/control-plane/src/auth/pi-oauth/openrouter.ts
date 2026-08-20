/**
 * OpenRouter OAuth PKCE. The provider mints a long-lived API key rather than
 * a refreshable access token.
 *
 * Pi binds an ephemeral localhost callback. Hosted sign-in uses the same
 * authorize URL with a loopback callback_url; the user pastes the redirected
 * URL or code after the browser fails to connect.
 */

import { createPkceS256Pair } from "../pkce";
import {
  isInvalidGrant,
  jsonErrorMessage,
  optionalString,
  postJson,
  readJsonObject,
  type ProviderFetchOptions,
} from "./http";
import {
  ProviderOAuthRequestError,
  subscriptionSignInInfo,
  type SubscriptionOAuthAdapter,
} from "./types";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_URL = "http://localhost:1456/oauth/callback";

export function openRouterOAuthAdapter(
  options: ProviderFetchOptions = {}
): SubscriptionOAuthAdapter {
  const info = subscriptionSignInInfo("openrouter");

  return {
    ...info,

    async startAuthorizationCode() {
      const { verifier, challenge } = await createPkceS256Pair();
      const params = new URLSearchParams({
        callback_url: CALLBACK_URL,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return {
        authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}`,
        instructions:
          "Complete sign-in in the browser, then paste the redirected localhost URL or the authorization code.",
        payload: { verifier, callbackUrl: CALLBACK_URL },
      };
    },

    async completeAuthorizationCode(payload, code) {
      const verifier = payload.verifier;
      if (!verifier) {
        throw new ProviderOAuthRequestError("Sign-in flow is missing its PKCE verifier", {
          retryable: false,
        });
      }
      const response = await postJson(
        TOKEN_URL,
        { code, code_verifier: verifier, code_challenge_method: "S256" },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `OpenRouter key exchange failed (HTTP ${response.status})`),
          {
            retryable: response.status >= 500,
            invalidGrant: isInvalidGrant(body, response.status),
            status: response.status,
          }
        );
      }
      const key = optionalString(body.key);
      if (!key) {
        throw new ProviderOAuthRequestError('OpenRouter OAuth response carries no "key"', {
          retryable: false,
          status: response.status,
        });
      }
      return { access: key, refresh: null, expiresAt: null };
    },
  };
}
