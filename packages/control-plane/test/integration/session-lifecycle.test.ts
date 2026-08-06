import { describe, it, expect } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { hashToken } from "../../src/auth/crypto";
import type { SessionDO } from "../../src/session/durable-object";
import {
  initSession,
  readSandboxTokenColumns,
  seedSandboxAuthHash,
  waitForSandboxStatus,
} from "./helpers";

/** Ask a session DO to verify a token for a purpose, the way the router does. */
function verifyToken(
  stub: DurableObjectStub,
  token: string,
  purpose?: "bridge" | "credential_fetch"
): Promise<Response> {
  return stub.fetch("http://internal/internal/verify-sandbox-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(purpose === undefined ? { token } : { token, purpose }),
  });
}

describe("GET /internal/state", () => {
  it("state includes sandbox after init", async () => {
    const { stub } = await initSession();

    const res = await stub.fetch("http://internal/internal/state");
    expect(res.status).toBe(200);

    const state = await res.json<{
      id: string;
      status: string;
      sandbox: { id: string; status: string } | null;
    }>();

    expect(state.sandbox).not.toBeNull();
    expect(state.sandbox!.id).toEqual(expect.any(String));
    // Status depends on how far the background warmSandbox() waitUntil has run.
    // In CI the provider call can fail before this state read completes.
    expect(["pending", "spawning", "failed"]).toContain(state.sandbox!.status);
  });

  it("state reflects custom model", async () => {
    const { stub } = await initSession({ model: "anthropic/claude-sonnet-4-5" });

    const res = await stub.fetch("http://internal/internal/state");
    const state = await res.json<{ model: string }>();

    expect(state.model).toBe("anthropic/claude-sonnet-4-5");
  });
});

describe("POST /internal/archive", () => {
  it("archive sets status to archived", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("archived");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("archived");
  });

  it("archive rejects non-participant", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "stranger" }),
    });

    expect(res.status).toBe(403);
  });
});

describe("POST /internal/unarchive", () => {
  it("unarchive restores to active", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    // First archive
    await stub.fetch("http://internal/internal/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    // Then unarchive
    const res = await stub.fetch("http://internal/internal/unarchive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe("active");

    // Verify via state endpoint
    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = await stateRes.json<{ status: string }>();
    expect(state.status).toBe("active");
  });
});

describe("POST /internal/prompt", () => {
  it.each(["completed", "failed", "archived", "cancelled"])(
    "reopens %s session back to active",
    async (status) => {
      const { stub } = await initSession({ userId: "user-1" });

      await runInDurableObject(stub, (instance: SessionDO) => {
        instance.ctx.storage.sql.exec("UPDATE session SET status = ?", status);
      });

      const promptRes = await stub.fetch("http://internal/internal/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Re-open session",
          authorId: "user-1",
          source: "web",
        }),
      });
      expect(promptRes.status).toBe(200);

      const stateRes = await stub.fetch("http://internal/internal/state");
      const state = await stateRes.json<{ status: string }>();
      expect(state.status).toBe("active");
    }
  );
});

describe("POST /internal/update-title", () => {
  it("updates the session title", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "new title" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("new title");

    const stateRes = await stub.fetch("http://internal/internal/state");
    const state = (await stateRes.json()) as { title: string };
    expect(state.title).toBe("new title");
  });

  it("rejects empty title", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects title over 200 characters", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const res = await stub.fetch("http://internal/internal/update-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", title: "a".repeat(201) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /internal/verify-sandbox-token", () => {
  it("validates token using hashed sandbox auth token", async () => {
    const { stub } = await initSession();

    const authToken = "test-sandbox-auth-token-hashed";
    await seedSandboxAuthHash(stub, { authToken, sandboxId: "sb-hashed-token" });

    const validRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken }),
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json<{ valid: boolean }>();
    expect(validBody.valid).toBe(true);

    const invalidRes = await stub.fetch("http://internal/internal/verify-sandbox-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(invalidRes.status).toBe(401);
    const invalidBody = await invalidRes.json<{ valid: boolean; error: string }>();
    expect(invalidBody.valid).toBe(false);
  });

  it("never compares against the plaintext column, even when it disagrees with the hash", async () => {
    const { stub } = await initSession();
    await waitForSandboxStatus(stub, "failed");

    // A row in the shape the removed fallback existed for, made decisive: the
    // plaintext column holds one token and the hash column another. If any
    // comparison against the plaintext column survived, the plaintext token
    // would authenticate.
    const plaintextToken = "legacy-plaintext-token-12345";
    const hashedToken = "current-hashed-token-67890";
    const hash = await hashToken(hashedToken);
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox SET auth_token = ?, auth_token_hash = ?, status = 'ready' WHERE id = (SELECT id FROM sandbox LIMIT 1)",
        plaintextToken,
        hash
      );
    });

    const plaintextRes = await verifyToken(stub, plaintextToken);
    expect(plaintextRes.status).toBe(401);
    expect((await plaintextRes.json<{ valid: boolean }>()).valid).toBe(false);

    const hashedRes = await verifyToken(stub, hashedToken);
    expect(hashedRes.status).toBe(200);
    expect((await hashedRes.json<{ valid: boolean }>()).valid).toBe(true);

    // ...and the plaintext column no longer holds anything at all.
    const columns = await readSandboxTokenColumns(stub);
    expect(columns.auth_token).toBeNull();
    expect(columns.auth_token_hash).toBe(hash);
  });

  it("keeps a pre-hash session working by converting its plaintext token to a hash", async () => {
    const { stub } = await initSession();
    await waitForSandboxStatus(stub, "failed");

    // Exactly what a row written before hashing existed looks like: the token
    // in the clear, no hash beside it. The bridge holding that token must not
    // be broken by the fallback's removal.
    const authToken = "test-sandbox-auth-token-12345";
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox SET auth_token = ?, auth_token_hash = NULL, status = 'ready' WHERE id = (SELECT id FROM sandbox LIMIT 1)",
        authToken
      );
    });

    const validRes = await verifyToken(stub, authToken);
    expect(validRes.status).toBe(200);
    expect((await validRes.json<{ valid: boolean }>()).valid).toBe(true);

    const invalidRes = await verifyToken(stub, "wrong-token");
    expect(invalidRes.status).toBe(401);
    expect((await invalidRes.json<{ valid: boolean; error: string }>()).valid).toBe(false);

    // The credential now lives only as a hash: the conversion happened, and it
    // is not a plaintext comparison wearing a different name.
    const columns = await readSandboxTokenColumns(stub);
    expect(columns.auth_token).toBeNull();
    expect(columns.auth_token_hash).toBe(await hashToken(authToken));
  });

  it("refuses a credential-fetch token that is only the bridge token", async () => {
    const { stub } = await initSession();
    await waitForSandboxStatus(stub, "failed");

    const bridgeToken = "bridge-token-abc";
    const fetchToken = "fetch-token-def";
    const bridgeHash = await hashToken(bridgeToken);
    const fetchHash = await hashToken(fetchToken);
    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "UPDATE sandbox SET auth_token = NULL, auth_token_hash = ?, credential_fetch_token_hash = ?, status = 'ready' WHERE id = (SELECT id FROM sandbox LIMIT 1)",
        bridgeHash,
        fetchHash
      );
    });

    expect((await verifyToken(stub, bridgeToken, "credential_fetch")).status).toBe(401);
    expect((await verifyToken(stub, fetchToken, "bridge")).status).toBe(401);
    expect((await verifyToken(stub, bridgeToken, "bridge")).status).toBe(200);
    expect((await verifyToken(stub, fetchToken, "credential_fetch")).status).toBe(200);
  });
});
