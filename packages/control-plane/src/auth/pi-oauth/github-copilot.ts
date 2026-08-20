/**
 * GitHub Copilot device-code OAuth, matching Pi's bundled flow for github.com.
 *
 * The GitHub OAuth access token is the refresh credential; each issuance
 * exchanges it for a short-lived Copilot token. Enterprise hosts are out of
 * scope for hosted sign-in: the product talks to github.com.
 */

import { classifyOAuthDeviceError } from "./device";
import {
  getJson,
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

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DOMAIN = "github.com";
const DEVICE_CODE_URL = `https://${DOMAIN}/login/device/code`;
const ACCESS_TOKEN_URL = `https://${DOMAIN}/login/oauth/access_token`;
const COPILOT_TOKEN_URL = `https://api.${DOMAIN}/copilot_internal/v2/token`;

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

async function exchangeCopilotToken(
  githubAccessToken: string,
  options: ProviderFetchOptions,
  now: () => number
): Promise<OAuthGrantTokens> {
  const response = await getJson(COPILOT_TOKEN_URL, {
    ...options,
    headers: {
      Authorization: `Bearer ${githubAccessToken}`,
      ...COPILOT_HEADERS,
    },
  });
  const body = await readJsonObject(response);
  if (!response.ok) {
    throw new ProviderOAuthRequestError(
      jsonErrorMessage(body, `GitHub Copilot token request failed (HTTP ${response.status})`),
      {
        retryable: response.status >= 500,
        invalidGrant: isInvalidGrant(body, response.status),
        status: response.status,
      }
    );
  }
  const token = requireString(body, "token");
  const expiresAtSeconds = optionalNumber(body.expires_at);
  return {
    access: token,
    refresh: githubAccessToken,
    expiresAt: expiresAtSeconds !== undefined ? expiresAtSeconds * 1000 : now() + 30 * 60 * 1000,
  };
}

export function githubCopilotOAuthAdapter(
  options: ProviderFetchOptions & { now?: () => number } = {}
): SubscriptionOAuthAdapter {
  const now = options.now ?? (() => Date.now());
  const info = subscriptionSignInInfo("github-copilot");
  const githubHeaders = { "User-Agent": COPILOT_HEADERS["User-Agent"] };

  return {
    ...info,

    async startDeviceCode() {
      const response = await postForm(
        DEVICE_CODE_URL,
        { client_id: CLIENT_ID, scope: "read:user" },
        { ...options, headers: githubHeaders }
      );
      const body = await readJsonObject(response);
      if (!response.ok) {
        throw new ProviderOAuthRequestError(
          jsonErrorMessage(body, `GitHub device code request failed (HTTP ${response.status})`),
          { retryable: response.status >= 500, status: response.status }
        );
      }
      const deviceCode = requireString(body, "device_code");
      const userCode = requireString(body, "user_code");
      const verificationUri = requireTrustedHttpUrl(body.verification_uri, "verification_uri");
      const intervalSeconds = optionalNumber(body.interval) ?? 5;
      const expiresInSeconds = optionalNumber(body.expires_in) ?? 15 * 60;
      return {
        userCode,
        verificationUri,
        intervalSeconds,
        expiresInSeconds,
        payload: { deviceCode, domain: DOMAIN },
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
        ACCESS_TOKEN_URL,
        {
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        { ...options, headers: githubHeaders }
      );
      const body = await readJsonObject(response);
      const classified = classifyOAuthDeviceError(body);
      if (classified) return classified;
      const githubAccessToken = optionalString(body.access_token);
      if (githubAccessToken) {
        try {
          const tokens = await exchangeCopilotToken(githubAccessToken, options, now);
          return { status: "complete", tokens };
        } catch (error) {
          if (error instanceof ProviderOAuthRequestError) {
            return { status: "failed", message: error.message, retryable: error.retryable };
          }
          throw error;
        }
      }
      return {
        status: "failed",
        message: jsonErrorMessage(
          body,
          `GitHub device token request failed (HTTP ${response.status})`
        ),
        retryable: response.status >= 500,
      };
    },

    async refresh(refreshToken) {
      return exchangeCopilotToken(refreshToken, options, now);
    },
  };
}
