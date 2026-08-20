/**
 * xAI (SuperGrok / X Premium) device-code OAuth, matching Pi's bundled flow.
 */

import { classifyOAuthDeviceError } from "./device";
import {
  expiresAtFromExpiresIn,
  isInvalidGrant,
  jsonErrorMessage,
  optionalNumber,
  optionalString,
  postForm,
  readJsonObject,
  requireString,
  requireTrustedHttpsUrl,
  type ProviderFetchOptions,
} from "./http";
import {
  ProviderOAuthRequestError,
  subscriptionSignInInfo,
  type OAuthGrantTokens,
  type SubscriptionOAuthAdapter,
} from "./types";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

function tokensFromBody(
  body: Record<string, unknown>,
  now: () => number,
  previousRefresh?: string
): OAuthGrantTokens {
  const refresh = optionalString(body.refresh_token) ?? previousRefresh ?? null;
  if (!refresh) {
    throw new ProviderOAuthRequestError("xAI token response missing refresh_token", {
      retryable: false,
    });
  }
  const expiresIn = optionalNumber(body.expires_in) ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  return {
    access: requireString(body, "access_token"),
    refresh,
    expiresAt: expiresAtFromExpiresIn(expiresIn, now),
  };
}

export function xaiOAuthAdapter(
  options: ProviderFetchOptions & { now?: () => number } = {}
): SubscriptionOAuthAdapter {
  const now = options.now ?? (() => Date.now());
  const info = subscriptionSignInInfo("xai");

  return {
    ...info,

    async startDeviceCode() {
      const response = await postForm(
        DEVICE_CODE_URL,
        { client_id: CLIENT_ID, scope: SCOPE, referrer: "pi" },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `xAI device authorization failed (HTTP ${response.status})`),
          { retryable: response.status >= 500, status: response.status }
        );
      }
      const deviceCode = requireString(body, "device_code");
      const userCode = requireString(body, "user_code");
      const verificationUri = requireTrustedHttpsUrl(
        optionalString(body.verification_uri_complete) ?? body.verification_uri,
        "verification_uri"
      );
      const interval = optionalNumber(body.interval);
      return {
        userCode,
        verificationUri,
        intervalSeconds: interval && interval > 0 ? interval : 5,
        expiresInSeconds: optionalNumber(body.expires_in) ?? 15 * 60,
        payload: { deviceCode },
      };
    },

    async pollDeviceCode(payload) {
      const deviceCode = payload.deviceCode;
      if (!deviceCode) {
        throw new ProviderOAuthRequestError("Sign-in flow is missing its device code", {
          retryable: false,
        });
      }
      const response = await postForm(
        TOKEN_URL,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLIENT_ID,
          device_code: deviceCode,
        },
        options
      );
      const body = await readJsonObject(response);
      const classified = classifyOAuthDeviceError(body);
      if (classified) return classified;
      if (response.ok && optionalString(body.access_token)) {
        try {
          return { status: "complete", tokens: tokensFromBody(body, now) };
        } catch (error) {
          return {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          };
        }
      }
      return {
        status: "failed",
        message: jsonErrorMessage(
          body,
          `xAI device token polling failed (HTTP ${response.status})`
        ),
        retryable: response.status >= 500,
      };
    },

    async refresh(refreshToken) {
      const response = await postForm(
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
          jsonErrorMessage(body, `xAI token refresh failed (HTTP ${response.status})`),
          {
            retryable: response.status >= 500,
            invalidGrant: isInvalidGrant(body, response.status),
            status: response.status,
          }
        );
      }
      return tokensFromBody(body, now, refreshToken);
    },
  };
}
