/**
 * Kimi For Coding device-code OAuth, matching Pi's bundled RFC 8628 flow.
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
  requireTrustedHttpUrl,
  type ProviderFetchOptions,
} from "./http";
import {
  ProviderOAuthRequestError,
  subscriptionSignInInfo,
  type OAuthGrantTokens,
  type SubscriptionOAuthAdapter,
} from "./types";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

function tokensFromBody(body: Record<string, unknown>, now: () => number): OAuthGrantTokens {
  const expiresAt = expiresAtFromExpiresIn(body.expires_in, now);
  if (expiresAt === null) {
    throw new ProviderOAuthRequestError("Kimi Code token response missing expires_in", {
      retryable: false,
    });
  }
  return {
    access: requireString(body, "access_token"),
    refresh: requireString(body, "refresh_token"),
    expiresAt,
  };
}

export function kimiCodingOAuthAdapter(
  options: ProviderFetchOptions & { now?: () => number } = {}
): SubscriptionOAuthAdapter {
  const now = options.now ?? (() => Date.now());
  const info = subscriptionSignInInfo("kimi-coding");

  return {
    ...info,

    async startDeviceCode() {
      const response = await postForm(
        `${OAUTH_HOST}/api/oauth/device_authorization`,
        { client_id: CLIENT_ID },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `Kimi Code device authorization failed (HTTP ${response.status})`),
          { retryable: response.status >= 500, status: response.status }
        );
      }
      const deviceCode = requireString(body, "device_code");
      const userCode = requireString(body, "user_code");
      const verificationUri = requireTrustedHttpUrl(
        optionalString(body.verification_uri_complete) ?? body.verification_uri,
        "verification_uri"
      );
      return {
        userCode,
        verificationUri,
        intervalSeconds: optionalNumber(body.interval) || DEFAULT_POLL_INTERVAL_SECONDS,
        expiresInSeconds: optionalNumber(body.expires_in) || DEVICE_CODE_TIMEOUT_SECONDS,
        payload: { deviceCode, oauthHost: OAUTH_HOST },
      };
    },

    async pollDeviceCode(payload) {
      const deviceCode = payload.deviceCode;
      const oauthHost = payload.oauthHost || OAUTH_HOST;
      if (!deviceCode) {
        throw new ProviderOAuthRequestError("Sign-in flow is missing its device code", {
          retryable: false,
        });
      }
      const response = await postForm(
        `${oauthHost}/api/oauth/token`,
        {
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
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
          `Kimi Code device token request failed (HTTP ${response.status})`
        ),
        retryable: response.status >= 500,
      };
    },

    async refresh(refreshToken) {
      const response = await postForm(
        `${OAUTH_HOST}/api/oauth/token`,
        {
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `Kimi Code token refresh failed (HTTP ${response.status})`),
          {
            retryable: response.status >= 500 || response.status === 429,
            invalidGrant: isInvalidGrant(body, response.status),
            status: response.status,
          }
        );
      }
      return tokensFromBody(body, now);
    },
  };
}
