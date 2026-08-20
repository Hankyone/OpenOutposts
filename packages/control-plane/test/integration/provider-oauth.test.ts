/**
 * OAuth grants in the provider-credential vault: storage, flow isolation,
 * catalog, and issuance of an unexpired grant (refresh is unit-tested).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { encryptToken } from "../../src/auth/crypto";
import { providerOAuthFlowContext } from "../../src/auth/encryption-contexts";
import { ProviderOAuthFlowStore } from "../../src/db/provider-oauth-flows";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserProviderCredentialStore } from "../../src/db/user-provider-credentials";
import { MODEL_CREDENTIAL_TTL_MS } from "../../src/session/model-credentials-service";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, initNamedSession, seedSandboxAuth } from "./helpers";

function userFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<Response> {
  const body = init?.body === undefined ? undefined : JSON.stringify(init.body);
  return SELF.fetch(`https://test.local${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
  });
}

describe("provider OAuth grants", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("lists the bundled subscription sign-in methods", async () => {
    const alice = await createSignedInUser("alice-1");
    const response = await userFetch(alice.accessToken, "/provider-credentials/oauth-methods");
    expect(response.status).toBe(200);
    const body = await response.json<{ methods: Array<{ id: string; flow: string }> }>();
    expect(body.methods.map((method) => method.id)).toEqual([
      "anthropic",
      "openai-codex",
      "openrouter",
      "github-copilot",
      "kimi-coding",
      "xai",
    ]);
    expect(body.methods.find((method) => method.id === "anthropic")?.flow).toBe(
      "authorization_code"
    );
  });

  it("starts an Anthropic paste-code flow without exposing the PKCE verifier", async () => {
    const alice = await createSignedInUser("alice-1");
    const started = await userFetch(
      alice.accessToken,
      "/provider-credentials/anthropic/oauth/start",
      {
        method: "POST",
      }
    );
    expect(started.status).toBe(201);
    const body = await started.json<{
      flow: string;
      authorizeUrl: string;
      payload?: unknown;
    }>();
    expect(body.flow).toBe("authorization_code");
    expect(body.authorizeUrl).toContain("https://claude.ai/oauth/authorize?");
    expect(body.authorizeUrl).toContain("code_challenge");
    expect(body.payload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("code_verifier");

    const row = await env.DB.prepare(
      "SELECT payload_encrypted FROM provider_oauth_flows WHERE user_id = ?"
    )
      .bind(alice.userId)
      .first<{ payload_encrypted: string }>();
    expect(row?.payload_encrypted).toBeTruthy();
    expect(row!.payload_encrypted).not.toContain("verifier");
  });

  it("refuses a ciphertext relocated onto another user's OAuth flow", async () => {
    const alice = await createSignedInUser("alice-1");
    const bob = await createSignedInUser("bob-2");
    const store = new ProviderOAuthFlowStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
    const aliceFlow = await store.replace({
      userId: alice.userId,
      provider: "anthropic",
      flowKind: "authorization_code",
      payload: { verifier: "a".repeat(43) },
      lifetimeMs: 60_000,
    });
    const bobFlow = await store.replace({
      userId: bob.userId,
      provider: "anthropic",
      flowKind: "authorization_code",
      payload: { verifier: "b".repeat(43) },
      lifetimeMs: 60_000,
    });

    const aliceRow = await env.DB.prepare(
      "SELECT payload_encrypted FROM provider_oauth_flows WHERE id = ?"
    )
      .bind(aliceFlow.id)
      .first<{ payload_encrypted: string }>();
    await env.DB.prepare("UPDATE provider_oauth_flows SET payload_encrypted = ? WHERE id = ?")
      .bind(aliceRow!.payload_encrypted, bobFlow.id)
      .run();

    await expect(store.get(bob.userId, "anthropic")).rejects.toThrow(/Failed to decrypt/);
    const aliceLoaded = await store.get(alice.userId, "anthropic");
    expect(aliceLoaded?.payload.verifier).toBe("a".repeat(43));
  });

  it("stores an oauth_grant and issues it as kind=oauth without refreshing", async () => {
    const alice = await createSignedInUser("alice-1");
    const store = new UserProviderCredentialStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
    const expiresAt = Date.now() + 30 * 60 * 1000;
    const saved = await store.putOAuthGrant({
      userId: alice.userId,
      provider: "anthropic",
      accessToken: "oauth-access-1",
      refreshToken: "oauth-refresh-1",
      expiresAt,
      label: "Sign in with Claude Pro/Max",
    });
    expect(saved.credential.kind).toBe("oauth_grant");
    expect(saved.credential.secretExpiresAt).toBe(expiresAt);

    const listed = await userFetch(alice.accessToken, "/provider-credentials");
    const listedBody = await listed.json<{
      credentials: Array<{ kind: string; expiresAt: number | null }>;
    }>();
    expect(listedBody.credentials[0]?.kind).toBe("oauth_grant");
    expect(JSON.stringify(listedBody)).not.toContain("oauth-access-1");
    expect(JSON.stringify(listedBody)).not.toContain("oauth-refresh-1");

    const issued = await store.getForIssuance(alice.userId, "anthropic");
    expect(issued).toMatchObject({
      kind: "oauth_grant",
      secret: "oauth-access-1",
      refreshSecret: "oauth-refresh-1",
    });

    const sessionName = `oauth-grant-${Date.now()}`;
    await new SessionIndexStore(env.DB).create({
      id: sessionName,
      title: null,
      repoOwner: "acme",
      repoName: "web-app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: "main",
      status: "created",
      userId: alice.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { stub } = await initNamedSession(sessionName, { model: "anthropic/claude-haiku-4-5" });
    const fetchToken = `cf-tok-${sessionName}`;
    await seedSandboxAuth(stub, {
      authToken: `sb-tok-${sessionName}`,
      credentialFetchToken: fetchToken,
      sandboxId: `sb-${sessionName}`,
    });

    const before = Date.now();
    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/model-credentials`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${fetchToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      }
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      kind: string;
      api_key: string;
      expires_at_epoch_ms: number;
    }>();
    expect(body.kind).toBe("oauth");
    expect(body.api_key).toBe("oauth-access-1");
    expect(body.expires_at_epoch_ms).toBeLessThanOrEqual(expiresAt);
    expect(body.expires_at_epoch_ms).toBeGreaterThanOrEqual(before);
    expect(body.expires_at_epoch_ms).toBeLessThanOrEqual(Date.now() + MODEL_CREDENTIAL_TTL_MS);
  });

  it("refuses a flow ciphertext bound to a different flow id", async () => {
    const alice = await createSignedInUser("alice-1");
    const foreign = await encryptToken(
      JSON.stringify({ verifier: "c".repeat(43) }),
      env.TOKEN_ENCRYPTION_KEY,
      providerOAuthFlowContext(alice.userId, "not-this-flow")
    );
    await env.DB.prepare(
      `INSERT INTO provider_oauth_flows
         (id, user_id, provider, flow_kind, payload_encrypted, expires_at, created_at)
       VALUES (?, ?, 'anthropic', 'authorization_code', ?, ?, ?)`
    )
      .bind("flow-real", alice.userId, foreign, Date.now() + 60_000, Date.now())
      .run();

    const store = new ProviderOAuthFlowStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
    await expect(store.get(alice.userId, "anthropic")).rejects.toThrow(/Failed to decrypt/);
  });

  it("returns 404 when completing or polling with no in-flight flow", async () => {
    const alice = await createSignedInUser("alice-1");
    const complete = await userFetch(
      alice.accessToken,
      "/provider-credentials/anthropic/oauth/complete",
      { method: "POST", body: { code: "some-code-value" } }
    );
    expect(complete.status).toBe(404);

    const poll = await userFetch(alice.accessToken, "/provider-credentials/xai/oauth/poll", {
      method: "POST",
    });
    expect(poll.status).toBe(404);

    const unknown = await userFetch(alice.accessToken, "/provider-credentials/openai/oauth/start", {
      method: "POST",
    });
    expect(unknown.status).toBe(400);
  });
});
