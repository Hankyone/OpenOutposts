/**
 * OpenAI Codex (ChatGPT Plus/Pro) device-code OAuth, matching Pi's headless path.
 *
 * Pi also offers a localhost-callback browser login. A hosted product cannot
 * bind that port, so this adapter is device-code only: the user enters a
 * short code at auth.openai.com/codex/device.
 */

import { classifyOAuthDeviceError } from "./device";
import {
  expiresAtFromExpiresIn,
  isInvalidGrant,
  jsonErrorMessage,
  optionalString,
  postForm,
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

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;

function tokensFromBody(body: Record<string, unknown>, now: () => number): OAuthGrantTokens {
  return {
    access: requireString(body, "access_token"),
    refresh: requireString(body, "refresh_token"),
    expiresAt: expiresAtFromExpiresIn(body.expires_in, now),
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  options: ProviderFetchOptions,
  now: () => number
): Promise<OAuthGrantTokens> {
  const response = await postForm(
    TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    },
    options
  );
  const body = await readJsonObject(response);
  if (!response.ok) {
    throw new ProviderOAuthRequestError(
      jsonErrorMessage(body, `OpenAI Codex token exchange failed (HTTP ${response.status})`),
      {
        retryable: response.status >= 500,
        invalidGrant: isInvalidGrant(body, response.status),
        status: response.status,
      }
    );
  }
  return tokensFromBody(body, now);
}

export function openaiCodexOAuthAdapter(
  options: ProviderFetchOptions & { now?: () => number } = {}
): SubscriptionOAuthAdapter {
  const now = options.now ?? (() => Date.now());
  const info = subscriptionSignInInfo("openai-codex");

  return {
    ...info,

    async startDeviceCode() {
      const response = await postJson(DEVICE_USER_CODE_URL, { client_id: CLIENT_ID }, options);
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(
            body,
            `OpenAI Codex device code request failed (HTTP ${response.status})`
          ),
          { retryable: response.status >= 500, status: response.status }
        );
      }
      const deviceAuthId = requireString(body, "device_auth_id");
      const userCode = requireString(body, "user_code");
      const intervalSeconds = Number(body.interval);
      if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
        throw new ProviderOAuthRequestError("OpenAI Codex device code response missing interval", {
          retryable: false,
        });
      }
      return {
        userCode,
        verificationUri: DEVICE_VERIFICATION_URI,
        intervalSeconds,
        expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
        payload: { deviceAuthId, userCode },
      };
    },

    async pollDeviceCode(payload) {
      const deviceAuthId = payload.deviceAuthId;
      const userCode = payload.userCode;
      if (!deviceAuthId || !userCode) {
        throw new ProviderOAuthRequestError("Sign-in flow is missing its device code", {
          retryable: false,
        });
      }
      const response = await postJson(
        DEVICE_TOKEN_URL,
        { device_auth_id: deviceAuthId, user_code: userCode },
        options
      );
      if (response.status === 403 || response.status === 404) {
        return { status: "pending" };
      }
      const body = await readJsonObject(response);
      const classified = classifyOAuthDeviceError(body);
      if (classified) return classified;
      if (!response.ok) {
        return {
          status: "failed",
          message: jsonErrorMessage(
            body,
            `OpenAI Codex device auth failed (HTTP ${response.status})`
          ),
          retryable: response.status >= 500,
        };
      }
      const authorizationCode = optionalString(body.authorization_code);
      const codeVerifier = optionalString(body.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        return {
          status: "failed",
          message: "OpenAI Codex device auth response missing authorization code",
          retryable: false,
        };
      }
      try {
        const tokens = await exchangeAuthorizationCode(
          authorizationCode,
          codeVerifier,
          options,
          now
        );
        return { status: "complete", tokens };
      } catch (error) {
        if (error instanceof ProviderOAuthRequestError) {
          return {
            status: "failed",
            message: error.message,
            retryable: error.retryable,
          };
        }
        throw error;
      }
    },

    async refresh(refreshToken) {
      const response = await postForm(
        TOKEN_URL,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        },
        options
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `OpenAI Codex token refresh failed (HTTP ${response.status})`),
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
