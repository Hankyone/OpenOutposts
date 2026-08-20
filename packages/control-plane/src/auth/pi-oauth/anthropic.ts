/**
 * Anthropic Claude Pro/Max OAuth, matching Pi's bundled flow.
 *
 * The registered redirect is a localhost callback. A hosted product cannot
 * bind that port, so login is: open the authorize URL, paste the redirected
 * URL or code. Token exchange still sends Pi's loopback redirect_uri, which
 * is what the authorization was issued for.
 */

import { createPkceS256Pair } from "../pkce";
import {
  expiresAtFromExpiresIn,
  isInvalidGrant,
  jsonErrorMessage,
  postJson,
  readJsonObject,
  requireString,
  type ProviderFetchOptions,
} from "./http";
import {
  ProviderOAuthRequestError,
  subscriptionSignInInfo,
  type OAuthGrantTokens,
  type SubscriptionOAuthAdapter,
} from "./types";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "http://localhost:53692/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function tokensFromBody(body: Record<string, unknown>, now: () => number): OAuthGrantTokens {
  return {
    access: requireString(body, "access_token"),
    refresh: requireString(body, "refresh_token"),
    expiresAt: expiresAtFromExpiresIn(body.expires_in, now) ?? now() + 60 * 60 * 1000,
  };
}

export function anthropicOAuthAdapter(
  options: ProviderFetchOptions & { now?: () => number } = {}
): SubscriptionOAuthAdapter {
  const now = options.now ?? (() => Date.now());
  const info = subscriptionSignInInfo("anthropic");

  return {
    ...info,

    async startAuthorizationCode() {
      const { verifier, challenge } = await createPkceS256Pair();
      const params = new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: verifier,
      });
      return {
        authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}`,
        instructions:
          "Complete sign-in in the browser, then paste the redirected localhost URL or the authorization code.",
        payload: { verifier, redirectUri: REDIRECT_URI },
      };
    },

    async completeAuthorizationCode(payload, code) {
      const verifier = payload.verifier;
      const redirectUri = payload.redirectUri || REDIRECT_URI;
      if (!verifier) {
        throw new ProviderOAuthRequestError("Sign-in flow is missing its PKCE verifier", {
          retryable: false,
        });
      }
      const response = await postJson(
        TOKEN_URL,
        {
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          state: verifier,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `Anthropic token exchange failed (HTTP ${response.status})`),
          {
            retryable: response.status >= 500,
            invalidGrant: isInvalidGrant(body, response.status),
            status: response.status,
          }
        );
      }
      return tokensFromBody(body, now);
    },

    async refresh(refreshToken) {
      const response = await postJson(
        TOKEN_URL,
        {
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
        },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `Anthropic token refresh failed (HTTP ${response.status})`),
          {
            retryable: response.status >= 500,
            invalidGrant: isInvalidGrant(body, response.status),
            status: response.status,
          }
        );
      }
      return tokensFromBody(body, now);
    },
  };
}
