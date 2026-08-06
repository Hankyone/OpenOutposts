/**
 * Integration tests for the per-user provider-credential vault.
 *
 * Three properties carry the security requirement and are asserted directly:
 * the stored secret appears in no response the CRUD surface produces, one user
 * can neither see nor touch another user's rows, and a ciphertext physically
 * relocated into another user's row does not decrypt there.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { UserProviderCredentialStore } from "../../src/db/user-provider-credentials";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, serviceFetch } from "./helpers";

const ANTHROPIC_KEY = "sk-ant-integration-test-key-0001";

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

interface CredentialMetadata {
  id: string;
  provider: string;
  label: string | null;
  kind: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

describe("per-user provider credentials", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("stores a credential and returns metadata without the secret", async () => {
    const alice = await createSignedInUser("alice-1");

    const created = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY, label: "Personal key" },
    });

    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(ANTHROPIC_KEY);

    const createdBody = JSON.parse(createdText) as {
      status: string;
      credential: CredentialMetadata;
    };
    expect(createdBody.status).toBe("created");
    expect(createdBody.credential.provider).toBe("anthropic");
    expect(createdBody.credential.label).toBe("Personal key");
    expect(createdBody.credential.kind).toBe("api_key");
    expect(createdBody.credential.lastUsedAt).toBeNull();

    const listed = await userFetch(alice.accessToken, "/provider-credentials");
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(ANTHROPIC_KEY);
    const listedBody = JSON.parse(listedText) as { credentials: CredentialMetadata[] };
    expect(listedBody.credentials).toHaveLength(1);
    expect(listedBody.credentials[0].id).toBe(createdBody.credential.id);
    expect(Object.keys(listedBody.credentials[0]).sort()).toEqual([
      "createdAt",
      "expiresAt",
      "id",
      "kind",
      "label",
      "lastUsedAt",
      "provider",
      "updatedAt",
    ]);
  });

  it("encrypts the secret at rest with a recorded key version", async () => {
    const alice = await createSignedInUser("alice-1");
    await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY },
    });

    const row = await env.DB.prepare(
      "SELECT secret_encrypted, key_version, team_id FROM user_provider_credentials WHERE user_id = ?"
    )
      .bind(alice.userId)
      .first<{ secret_encrypted: string; key_version: number; team_id: string | null }>();

    expect(row).not.toBeNull();
    expect(row!.secret_encrypted).not.toContain(ANTHROPIC_KEY);
    expect(row!.key_version).toBe(1);
    expect(row!.team_id).toBeNull();
  });

  it("refuses a ciphertext relocated into another user's row", async () => {
    const alice = await createSignedInUser("alice-1");
    const bob = await createSignedInUser("bob-2");
    await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY },
    });
    await userFetch(bob.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: "sk-ant-bobs-own-key-0002" },
    });

    const aliceCipher = await env.DB.prepare(
      "SELECT secret_encrypted FROM user_provider_credentials WHERE user_id = ? AND provider = 'anthropic'"
    )
      .bind(alice.userId)
      .first<{ secret_encrypted: string }>();

    // The relocation attack, carried out at the storage layer: Alice's
    // ciphertext written verbatim into Bob's row. Both rows are sealed under
    // the same deployment key, so before the binding this decrypted cleanly
    // and Bob's sessions would have been issued Alice's key.
    await env.DB.prepare(
      "UPDATE user_provider_credentials SET secret_encrypted = ? WHERE user_id = ? AND provider = 'anthropic'"
    )
      .bind(aliceCipher!.secret_encrypted, bob.userId)
      .run();

    const store = new UserProviderCredentialStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
    await expect(store.getForIssuance(bob.userId, "anthropic")).rejects.toThrow(
      /Failed to decrypt/
    );

    // Alice's own row is untouched and still readable.
    const mine = await store.getForIssuance(alice.userId, "anthropic");
    expect(mine?.secret).toBe(ANTHROPIC_KEY);
  });

  it("refuses a ciphertext relocated to the same user's other provider", async () => {
    const alice = await createSignedInUser("alice-1");
    await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY },
    });
    await userFetch(alice.accessToken, "/provider-credentials/openai", {
      method: "PUT",
      body: { apiKey: "sk-openai-alice-0003" },
    });

    const anthropic = await env.DB.prepare(
      "SELECT secret_encrypted FROM user_provider_credentials WHERE user_id = ? AND provider = 'anthropic'"
    )
      .bind(alice.userId)
      .first<{ secret_encrypted: string }>();

    await env.DB.prepare(
      "UPDATE user_provider_credentials SET secret_encrypted = ? WHERE user_id = ? AND provider = 'openai'"
    )
      .bind(anthropic!.secret_encrypted, alice.userId)
      .run();

    const store = new UserProviderCredentialStore(env.DB, env.TOKEN_ENCRYPTION_KEY);
    await expect(store.getForIssuance(alice.userId, "openai")).rejects.toThrow(/Failed to decrypt/);
  });

  it("replaces an existing credential for the same provider in place", async () => {
    const alice = await createSignedInUser("alice-1");
    const first = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY, label: "Old" },
    });
    const firstId = (await first.json<{ credential: CredentialMetadata }>()).credential.id;

    const second = await userFetch(alice.accessToken, "/provider-credentials/ANTHROPIC", {
      method: "PUT",
      body: { apiKey: "sk-ant-replacement", label: "New" },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json<{ status: string; credential: CredentialMetadata }>();
    expect(secondBody.status).toBe("replaced");
    expect(secondBody.credential.id).toBe(firstId);
    expect(secondBody.credential.label).toBe("New");

    const listed = await userFetch(alice.accessToken, "/provider-credentials");
    const listedBody = await listed.json<{ credentials: CredentialMetadata[] }>();
    expect(listedBody.credentials).toHaveLength(1);
  });

  it("removes a credential and reports a second removal as not found", async () => {
    const alice = await createSignedInUser("alice-1");
    await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY },
    });

    const deleted = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const again = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("never shows or lets a user touch another user's credential", async () => {
    const alice = await createSignedInUser("alice-1");
    const bob = await createSignedInUser("bob-2");

    await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY, label: "Alice's key" },
    });

    const bobList = await userFetch(bob.accessToken, "/provider-credentials");
    expect(bobList.status).toBe(200);
    const bobListText = await bobList.text();
    expect(bobListText).not.toContain(ANTHROPIC_KEY);
    expect(bobListText).not.toContain("Alice's key");
    expect(JSON.parse(bobListText)).toEqual({ credentials: [] });

    // Bob's delete addresses his own (absent) row, never Alice's.
    const bobDelete = await userFetch(bob.accessToken, "/provider-credentials/anthropic", {
      method: "DELETE",
    });
    expect(bobDelete.status).toBe(404);

    const aliceStillHasIt = await userFetch(alice.accessToken, "/provider-credentials");
    const aliceBody = await aliceStillHasIt.json<{ credentials: CredentialMetadata[] }>();
    expect(aliceBody.credentials).toHaveLength(1);

    // Bob writing the same provider creates his own row, leaving Alice's alone.
    await userFetch(bob.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: "sk-ant-bob" },
    });
    const rows = await env.DB.prepare(
      "SELECT user_id FROM user_provider_credentials ORDER BY user_id"
    ).all<{ user_id: string }>();
    expect((rows.results ?? []).map((r) => r.user_id).sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
  });

  it("refuses callers that are not a signed-in user", async () => {
    const unauthenticated = await SELF.fetch("https://test.local/provider-credentials");
    expect(unauthenticated.status).toBe(401);

    // The web service's own credential asserts no user, so it owns nothing.
    const service = await serviceFetch("https://test.local/provider-credentials");
    expect(service.status).toBe(403);
  });

  it("rejects an empty key and a malformed provider id", async () => {
    const alice = await createSignedInUser("alice-1");

    const empty = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { apiKey: "   " },
    });
    expect(empty.status).toBe(400);

    const missing = await userFetch(alice.accessToken, "/provider-credentials/anthropic", {
      method: "PUT",
      body: { label: "no key" },
    });
    expect(missing.status).toBe(400);

    const badProvider = await userFetch(alice.accessToken, "/provider-credentials/not%20a%20slug", {
      method: "PUT",
      body: { apiKey: ANTHROPIC_KEY },
    });
    expect(badProvider.status).toBe(400);
  });
});
