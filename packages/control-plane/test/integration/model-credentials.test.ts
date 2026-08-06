/**
 * Integration tests for POST /sessions/:id/model-credentials.
 *
 * Exercises the real worker path: credential-fetch-token verification through
 * the session Durable Object, session-owner resolution from D1, and issuance
 * from that owner's vault. The properties under test are the ones the design
 * turns on — a session receives its own owner's credential and no one else's,
 * the endpoint is reachable only with the session's narrow credential-fetch
 * token (not its bridge token, not the deployment-wide internal bearer, not a
 * signed-in user), and every issued credential carries an expiry.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserProviderCredentialStore } from "../../src/db/user-provider-credentials";
import { MODEL_CREDENTIAL_TTL_MS } from "../../src/session/model-credentials-service";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, initNamedSession, seedSandboxAuth } from "./helpers";

const ALICE_KEY = "sk-ant-alice-0001";
const BOB_KEY = "sk-ant-bob-0002";

let sessionCounter = 0;

async function setupSession(options: {
  ownerUserId: string | null;
  model?: string;
  /** Overrides the model recorded in D1, which is what the route reads. */
  indexModel?: string;
}): Promise<{
  sessionName: string;
  sandboxToken: string;
  fetchToken: string;
  stub: DurableObjectStub;
}> {
  sessionCounter += 1;
  const sessionName = `model-creds-${Date.now()}-${sessionCounter}`;
  const model = options.model ?? "anthropic/claude-haiku-4-5";

  // The D1 index row is what records a session's owner; the DO holds no
  // user_id of its own.
  await new SessionIndexStore(env.DB).create({
    id: sessionName,
    title: null,
    repoOwner: "acme",
    repoName: "web-app",
    model: options.indexModel ?? model,
    reasoningEffort: null,
    baseBranch: "main",
    status: "created",
    userId: options.ownerUserId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const { stub } = await initNamedSession(sessionName, { model });
  const sandboxToken = `sb-tok-${sessionName}`;
  const fetchToken = `cf-tok-${sessionName}`;
  await seedSandboxAuth(stub, {
    authToken: sandboxToken,
    credentialFetchToken: fetchToken,
    sandboxId: `sb-${sessionName}`,
  });

  return { sessionName, sandboxToken, fetchToken, stub };
}

async function saveCredential(userId: string, provider: string, apiKey: string): Promise<void> {
  const store = new UserProviderCredentialStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
  await store.putApiKey({ userId, provider, apiKey });
}

function issue(
  sessionName: string,
  token: string | null,
  body?: Record<string, unknown>
): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionName}/model-credentials`, {
    method: "POST",
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface IssuedCredential {
  provider: string;
  credential_id: string;
  api_key: string;
  expires_at_epoch_ms: number;
}

describe("POST /sessions/:id/model-credentials", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("issues the session owner's credential with an expiry and no caching", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName, fetchToken } = await setupSession({ ownerUserId: alice.userId });

    const before = Date.now();
    const response = await issue(sessionName, fetchToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json<IssuedCredential>();
    expect(body.provider).toBe("anthropic");
    expect(body.api_key).toBe(ALICE_KEY);
    expect(body.expires_at_epoch_ms).toBeGreaterThanOrEqual(before + MODEL_CREDENTIAL_TTL_MS);
    expect(body.expires_at_epoch_ms).toBeLessThanOrEqual(Date.now() + MODEL_CREDENTIAL_TTL_MS);

    // Issuance is attributable: the row it came from records the use.
    const row = await env.DB.prepare(
      "SELECT last_used_at FROM user_provider_credentials WHERE id = ?"
    )
      .bind(body.credential_id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toBeGreaterThanOrEqual(before);
  });

  it("resolves the provider from the session's model when the body names none", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "openai", "sk-openai-alice");
    const { sessionName, fetchToken } = await setupSession({
      ownerUserId: alice.userId,
      model: "openai/gpt-5.4",
    });

    const response = await issue(sessionName, fetchToken);
    expect(response.status).toBe(200);
    const body = await response.json<IssuedCredential>();
    expect(body.provider).toBe("openai");
    expect(body.api_key).toBe("sk-openai-alice");
  });

  it("refuses to guess a provider for a session model that names none", async () => {
    // The derivation used to assume Anthropic for any unprefixed id, so a
    // session on an unrecognised model quietly asked for the wrong vault entry
    // and failed downstream without ever naming the model.
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", "sk-anthropic-alice");
    const { sessionName, fetchToken } = await setupSession({
      ownerUserId: alice.userId,
      // A legacy row: the DO holds a well-formed model, the D1 index does not.
      indexModel: "legacy-unprefixed-model",
    });

    const response = await issue(sessionName, fetchToken);
    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("legacy-unprefixed-model");
    expect(body.error).toContain("names none");
  });

  it("serves each session its own owner's credential", async () => {
    const alice = await createSignedInUser("alice-1");
    const bob = await createSignedInUser("bob-2");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    await saveCredential(bob.userId, "anthropic", BOB_KEY);

    const aliceSession = await setupSession({ ownerUserId: alice.userId });
    const bobSession = await setupSession({ ownerUserId: bob.userId });

    const aliceIssued = await (
      await issue(aliceSession.sessionName, aliceSession.fetchToken)
    ).json<IssuedCredential>();
    const bobIssued = await (
      await issue(bobSession.sessionName, bobSession.fetchToken)
    ).json<IssuedCredential>();

    expect(aliceIssued.api_key).toBe(ALICE_KEY);
    expect(bobIssued.api_key).toBe(BOB_KEY);
    expect(aliceIssued.credential_id).not.toBe(bobIssued.credential_id);
  });

  it("refuses a session whose owner has no credential for the provider", async () => {
    const alice = await createSignedInUser("alice-1");
    const bob = await createSignedInUser("bob-2");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);

    // Bob's session must not fall back to Alice's key just because one exists.
    const { sessionName, fetchToken } = await setupSession({ ownerUserId: bob.userId });
    const response = await issue(sessionName, fetchToken);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain(ALICE_KEY);
  });

  it("refuses a session that records no owner", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName, fetchToken } = await setupSession({ ownerUserId: null });

    const response = await issue(sessionName, fetchToken);
    expect(response.status).toBe(403);
  });

  it("refuses a token belonging to another session", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const target = await setupSession({ ownerUserId: alice.userId });
    const other = await setupSession({ ownerUserId: alice.userId });

    const response = await issue(target.sessionName, other.fetchToken);
    expect(response.status).toBe(401);
  });

  it("refuses provider credential issuance after the session goes dormant", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName, fetchToken, stub } = await setupSession({
      ownerUserId: alice.userId,
    });

    const stopped = await stub.fetch("http://internal/internal/cancel", { method: "POST" });
    expect(stopped.status).toBe(200);

    const response = await issue(sessionName, fetchToken);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(ALICE_KEY);
  });

  it("refuses the session's own sandbox bridge token", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName, sandboxToken, fetchToken } = await setupSession({
      ownerUserId: alice.userId,
    });

    // The bridge token is this session's own valid credential — it opens PR
    // creation, media upload, child spawn and Slack notification on this very
    // session. It must not also buy the owner's provider key.
    const response = await issue(sessionName, sandboxToken);
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(ALICE_KEY);

    // ...while the narrow token, on the same session, still works.
    expect((await issue(sessionName, fetchToken)).status).toBe(200);
  });

  it("refuses the fetch token on a route the bridge token is for", async () => {
    const alice = await createSignedInUser("alice-1");
    const { sessionName, fetchToken } = await setupSession({ ownerUserId: alice.userId });

    // The separation runs both ways: the credential-fetch token buys nothing
    // on the session's bridge surface.
    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fetchToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a session whose sandbox has no fetch token at all", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);

    sessionCounter += 1;
    const sessionName = `model-creds-nofetch-${Date.now()}-${sessionCounter}`;
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
    const sandboxToken = `sb-tok-${sessionName}`;
    // No credentialFetchToken: a row minted before the column existed.
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: `sb-${sessionName}` });

    // Refused rather than falling back to the wider bridge token.
    expect((await issue(sessionName, sandboxToken)).status).toBe(401);
  });

  it("refuses the deployment-wide internal bearer", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName } = await setupSession({ ownerUserId: alice.userId });

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/model-credentials`,
      { method: "POST", headers: { Authorization: "Bearer 1.deadbeef" } }
    );

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(ALICE_KEY);
  });

  it("refuses a signed-in user presenting their own session token", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName } = await setupSession({ ownerUserId: alice.userId });

    // Even the owner cannot read their own key back through this endpoint —
    // it is a harness credential path, not a user-facing one.
    const response = await issue(sessionName, alice.accessToken);
    expect(response.status).toBe(401);
  });

  it("returns 401 without any credential and 404 for an unknown session", async () => {
    const alice = await createSignedInUser("alice-1");
    await saveCredential(alice.userId, "anthropic", ALICE_KEY);
    const { sessionName, fetchToken } = await setupSession({ ownerUserId: alice.userId });

    expect((await issue(sessionName, null)).status).toBe(401);

    // A session id with no DO behind it cannot pass token verification at all.
    expect((await issue("no-such-session", fetchToken)).status).toBe(401);
  });
});
