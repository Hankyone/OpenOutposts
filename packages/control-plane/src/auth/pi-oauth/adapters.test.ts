import { describe, expect, it } from "vitest";
import { anthropicOAuthAdapter } from "./anthropic";
import { githubCopilotOAuthAdapter } from "./github-copilot";
import { kimiCodingOAuthAdapter } from "./kimi-coding";
import { openaiCodexOAuthAdapter } from "./openai-codex";
import { openRouterOAuthAdapter } from "./openrouter";
import { xaiOAuthAdapter } from "./xai";
import { ProviderOAuthRequestError } from "./types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

function formBody(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

const NOW = 1_700_000_000_000;

describe("anthropicOAuthAdapter", () => {
  it("builds a PKCE authorize URL and exchanges a pasted code", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = anthropicOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return jsonResponse(200, {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        });
      }),
    });

    const started = await adapter.startAuthorizationCode?.();
    expect(started?.authorizeUrl).toContain("https://claude.ai/oauth/authorize?");
    expect(started?.authorizeUrl).toContain("code_challenge_method=S256");
    expect(started?.payload.verifier).toHaveLength(43);

    const tokens = await adapter.completeAuthorizationCode?.(started!.payload, "pasted-code");
    expect(tokens).toEqual({
      access: "at-1",
      refresh: "rt-1",
      expiresAt: NOW + 3600 * 1000,
    });
    expect(calls[0]?.body).toMatchObject({
      grant_type: "authorization_code",
      code: "pasted-code",
      code_verifier: started!.payload.verifier,
    });
  });

  it("refreshes and marks invalid_grant", async () => {
    const adapter = anthropicOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async () =>
        jsonResponse(400, { error: "invalid_grant", error_description: "revoked" })
      ),
    });
    const error = await adapter.refresh?.("rt-old").catch((value) => value);
    expect(error).toBeInstanceOf(ProviderOAuthRequestError);
    expect(error.invalidGrant).toBe(true);
  });
});

describe("openRouterOAuthAdapter", () => {
  it("exchanges a code for a non-expiring key and has no refresh", async () => {
    const adapter = openRouterOAuthAdapter({
      fetchImpl: mockFetch(async () => jsonResponse(200, { key: "or-key-1" })),
    });
    const started = await adapter.startAuthorizationCode?.();
    expect(started?.authorizeUrl).toContain("https://openrouter.ai/auth?");
    const tokens = await adapter.completeAuthorizationCode?.(started!.payload, "or-code");
    expect(tokens).toEqual({ access: "or-key-1", refresh: null, expiresAt: null });
    expect(adapter.refresh).toBeUndefined();
  });
});

describe("openaiCodexOAuthAdapter", () => {
  it("starts a device code and exchanges on poll completion", async () => {
    const adapter = openaiCodexOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async (url, init) => {
        if (url.endsWith("/usercode")) {
          return jsonResponse(200, {
            device_auth_id: "dev-1",
            user_code: "ABCD-EFGH",
            interval: 5,
          });
        }
        if (url.endsWith("/deviceauth/token")) {
          return jsonResponse(200, {
            authorization_code: "authz",
            code_verifier: "verifier-from-openai",
          });
        }
        expect(url).toBe("https://auth.openai.com/oauth/token");
        expect(formBody(init).get("grant_type")).toBe("authorization_code");
        expect(formBody(init).get("code")).toBe("authz");
        return jsonResponse(200, {
          access_token: "codex-at",
          refresh_token: "codex-rt",
          expires_in: 3600,
        });
      }),
    });

    const started = await adapter.startDeviceCode?.();
    expect(started).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      payload: { deviceAuthId: "dev-1", userCode: "ABCD-EFGH" },
    });

    const polled = await adapter.pollDeviceCode?.(started!.payload);
    expect(polled).toEqual({
      status: "complete",
      tokens: { access: "codex-at", refresh: "codex-rt", expiresAt: NOW + 3600 * 1000 },
    });
  });

  it("treats 403 device polls as pending", async () => {
    const adapter = openaiCodexOAuthAdapter({
      fetchImpl: mockFetch(async () => new Response("nope", { status: 403 })),
    });
    await expect(
      adapter.pollDeviceCode?.({ deviceAuthId: "dev-1", userCode: "ABCD" })
    ).resolves.toEqual({ status: "pending" });
  });
});

describe("githubCopilotOAuthAdapter", () => {
  it("stores the GitHub token as refresh and the Copilot token as access", async () => {
    const adapter = githubCopilotOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async (url) => {
        if (url.includes("/login/device/code")) {
          return jsonResponse(200, {
            device_code: "dc",
            user_code: "1234-5678",
            verification_uri: "https://github.com/login/device",
            interval: 5,
            expires_in: 900,
          });
        }
        if (url.includes("/login/oauth/access_token")) {
          return jsonResponse(200, { access_token: "gho_github" });
        }
        expect(url).toContain("copilot_internal/v2/token");
        return jsonResponse(200, { token: "copilot-at", expires_at: NOW / 1000 + 1800 });
      }),
    });

    const started = await adapter.startDeviceCode?.();
    expect(started?.verificationUri).toBe("https://github.com/login/device");
    const polled = await adapter.pollDeviceCode?.(started!.payload);
    expect(polled).toEqual({
      status: "complete",
      tokens: {
        access: "copilot-at",
        refresh: "gho_github",
        expiresAt: (NOW / 1000 + 1800) * 1000,
      },
    });
  });

  it("rejects a non-http verification URI", async () => {
    const adapter = githubCopilotOAuthAdapter({
      fetchImpl: mockFetch(async () =>
        jsonResponse(200, {
          device_code: "dc",
          user_code: "1234",
          verification_uri: "file:///etc/passwd",
          expires_in: 900,
        })
      ),
    });
    await expect(adapter.startDeviceCode?.()).rejects.toBeInstanceOf(ProviderOAuthRequestError);
  });
});

describe("kimiCodingOAuthAdapter", () => {
  it("polls pending then completes", async () => {
    let polls = 0;
    const adapter = kimiCodingOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async (url) => {
        if (url.includes("device_authorization")) {
          return jsonResponse(200, {
            device_code: "kimi-dc",
            user_code: "KIMI-1",
            verification_uri: "https://auth.kimi.com/device",
            verification_uri_complete: "https://auth.kimi.com/device?user_code=KIMI-1",
            interval: 5,
            expires_in: 900,
          });
        }
        polls += 1;
        if (polls === 1) return jsonResponse(400, { error: "authorization_pending" });
        return jsonResponse(200, {
          access_token: "kimi-at",
          refresh_token: "kimi-rt",
          expires_in: 3600,
        });
      }),
    });

    const started = await adapter.startDeviceCode?.();
    expect(started?.verificationUri).toContain("user_code=KIMI-1");
    await expect(adapter.pollDeviceCode?.(started!.payload)).resolves.toEqual({
      status: "pending",
    });
    await expect(adapter.pollDeviceCode?.(started!.payload)).resolves.toMatchObject({
      status: "complete",
      tokens: { access: "kimi-at", refresh: "kimi-rt" },
    });
  });
});

describe("xaiOAuthAdapter", () => {
  it("keeps the previous refresh token when rotation omits one", async () => {
    const adapter = xaiOAuthAdapter({
      now: () => NOW,
      fetchImpl: mockFetch(async () =>
        jsonResponse(200, { access_token: "xai-new", expires_in: 3600 })
      ),
    });
    const tokens = await adapter.refresh?.("xai-old");
    expect(tokens).toEqual({
      access: "xai-new",
      refresh: "xai-old",
      expiresAt: NOW + 3600 * 1000,
    });
  });

  it("classifies access_denied as denied", async () => {
    const adapter = xaiOAuthAdapter({
      fetchImpl: mockFetch(async () => jsonResponse(400, { error: "access_denied" })),
    });
    await expect(adapter.pollDeviceCode?.({ deviceCode: "dc" })).resolves.toMatchObject({
      status: "denied",
    });
  });
});
