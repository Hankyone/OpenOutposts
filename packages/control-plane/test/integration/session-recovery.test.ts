import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

import {
  initNamedSession,
  readSandboxTokenColumns,
  seedSandboxAuth,
  homesteadFetch,
} from "./helpers";

let sessionCounter = 0;

function verifyToken(
  stub: DurableObjectStub,
  token: string,
  purpose: "bridge" | "credential_fetch"
): Promise<Response> {
  return stub.fetch("http://internal/internal/verify-sandbox-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, purpose }),
  });
}

async function recover(productSessionId: string, sandboxId: string): Promise<Response> {
  return homesteadFetch("https://test.local/outposts/session-recovery", {
    method: "POST",
    body: JSON.stringify({
      recoveryVersion: 1,
      productSessionId,
      sandboxId,
    }),
  });
}

async function setupActiveGeneration() {
  sessionCounter += 1;
  const productSessionId = `homestead-recovery-${Date.now()}-${sessionCounter}`;
  const sandboxId = `generation-${sessionCounter}`;
  const bridgeToken = `old-bridge-${sessionCounter}`;
  const fetchToken = `old-fetch-${sessionCounter}`;
  const { stub } = await initNamedSession(productSessionId);
  await seedSandboxAuth(stub, {
    authToken: bridgeToken,
    credentialFetchToken: fetchToken,
    sandboxId,
    status: "ready",
  });
  return { productSessionId, sandboxId, bridgeToken, fetchToken, stub };
}

describe("homestead session recovery", () => {
  it("requires internal authentication and the supported recovery version", async () => {
    const generation = await setupActiveGeneration();

    const unauthenticated = await SELF.fetch("https://test.local/outposts/session-recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recoveryVersion: 1,
        productSessionId: generation.productSessionId,
        sandboxId: generation.sandboxId,
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const incompatible = await homesteadFetch("https://test.local/outposts/session-recovery", {
      method: "POST",
      body: JSON.stringify({
        recoveryVersion: 2,
        productSessionId: generation.productSessionId,
        sandboxId: generation.sandboxId,
      }),
    });
    expect(incompatible.status).toBe(400);
  });

  it("rotates both credentials for the same active generation", async () => {
    const generation = await setupActiveGeneration();

    const response = await recover(generation.productSessionId, generation.sandboxId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<{
      recoveryVersion: number;
      productSessionId: string;
      sandboxId: string;
      sandboxAuthToken: string;
      credentialFetchToken: string;
    }>();
    expect(body).toMatchObject({
      recoveryVersion: 1,
      productSessionId: generation.productSessionId,
      sandboxId: generation.sandboxId,
    });
    expect(body.sandboxAuthToken).not.toBe(generation.bridgeToken);
    expect(body.credentialFetchToken).not.toBe(generation.fetchToken);

    expect((await verifyToken(generation.stub, generation.bridgeToken, "bridge")).status).toBe(401);
    expect(
      (await verifyToken(generation.stub, generation.fetchToken, "credential_fetch")).status
    ).toBe(401);
    expect((await verifyToken(generation.stub, body.sandboxAuthToken, "bridge")).status).toBe(200);
    expect(
      (await verifyToken(generation.stub, body.credentialFetchToken, "credential_fetch")).status
    ).toBe(200);
  });

  it("revokes both credentials on stop and refuses recovery", async () => {
    const generation = await setupActiveGeneration();

    const stopped = await generation.stub.fetch("http://internal/internal/cancel", {
      method: "POST",
    });
    expect(stopped.status).toBe(200);

    const columns = await readSandboxTokenColumns(generation.stub);
    expect(columns.auth_token).toBeNull();
    expect(columns.auth_token_hash).toBeNull();
    expect(columns.credential_fetch_token_hash).toBeNull();

    expect((await verifyToken(generation.stub, generation.bridgeToken, "bridge")).status).toBe(410);
    expect(
      (await verifyToken(generation.stub, generation.fetchToken, "credential_fetch")).status
    ).toBe(410);
    expect((await recover(generation.productSessionId, generation.sandboxId)).status).toBe(409);
  });

  it("refuses a recovery request for a different generation", async () => {
    const generation = await setupActiveGeneration();

    expect((await recover(generation.productSessionId, "another-generation")).status).toBe(409);
    expect((await verifyToken(generation.stub, generation.bridgeToken, "bridge")).status).toBe(200);
    expect(
      (await verifyToken(generation.stub, generation.fetchToken, "credential_fetch")).status
    ).toBe(200);
  });
});
