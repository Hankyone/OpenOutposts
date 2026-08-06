import { describe, it, expect } from "vitest";
import { HOMESTEAD_RECOVERY_VERSION } from "@openoutposts/outpost-protocol";
import { initSession, queryDO, seedSandboxAuth } from "./helpers";

const RECOVERY_PATH = "http://internal/internal/rotate-sandbox-credentials";

async function requestRecovery(
  stub: Awaited<ReturnType<typeof initSession>>["stub"],
  sandboxId: string,
  productSessionId: string
): Promise<Response> {
  return stub.fetch(RECOVERY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recoveryVersion: HOMESTEAD_RECOVERY_VERSION,
      productSessionId,
      sandboxId,
    }),
  });
}

describe("homestead restart recovery", () => {
  it("rotates credentials for a generation that is still active", async () => {
    const { stub } = await initSession();
    const sessionId = "recovery-session";
    await seedSandboxAuth(stub, {
      authToken: "bridge-token",
      credentialFetchToken: "fetch-token",
      sandboxId: "generation-active",
      status: "ready",
    });

    const response = await requestRecovery(stub, "generation-active", sessionId);
    expect(response.status).toBe(200);

    const body = await response.json<{ sandboxAuthToken: string; credentialFetchToken: string }>();
    expect(body.sandboxAuthToken).toBeTruthy();
    expect(body.credentialFetchToken).toBeTruthy();
    expect(body.sandboxAuthToken).not.toBe("bridge-token");
  });

  it("revives a generation that went stale, so a lost heartbeat is not the end of it", async () => {
    const { stub } = await initSession();
    const sessionId = "recovery-session";
    await seedSandboxAuth(stub, {
      authToken: "bridge-token",
      credentialFetchToken: "fetch-token",
      sandboxId: "generation-stale",
      status: "ready",
    });

    // What a missed heartbeat does: the status goes stale and the credentials
    // are revoked, because a generation nobody is serving must not hold live
    // ones. Rotation then has nothing left to match on.
    await stub.fetch("http://internal/internal/state");
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stale', auth_token_hash = NULL, credential_fetch_token_hash = NULL"
    );

    const response = await requestRecovery(stub, "generation-stale", sessionId);
    expect(response.status).toBe(200);

    const body = await response.json<{ sandboxAuthToken: string }>();
    expect(body.sandboxAuthToken).toBeTruthy();

    // Revived rather than left dormant, so the bridge can reconnect: the
    // upgrade path refuses a stale sandbox outright.
    const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox LIMIT 1");
    expect(rows[0].status).toBe("connecting");
  });

  it("still refuses a generation that was stopped", async () => {
    const { stub } = await initSession();
    const sessionId = "recovery-session";
    await seedSandboxAuth(stub, {
      authToken: "bridge-token",
      credentialFetchToken: "fetch-token",
      sandboxId: "generation-stopped",
      status: "ready",
    });

    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stopped', auth_token_hash = NULL, credential_fetch_token_hash = NULL"
    );

    const response = await requestRecovery(stub, "generation-stopped", sessionId);
    expect(response.status).toBe(409);
  });

  it("refuses a generation the caller did not name correctly", async () => {
    const { stub } = await initSession();
    const sessionId = "recovery-session";
    await seedSandboxAuth(stub, {
      authToken: "bridge-token",
      credentialFetchToken: "fetch-token",
      sandboxId: "generation-real",
      status: "stale",
    });

    const response = await requestRecovery(stub, "generation-guessed", sessionId);
    expect(response.status).toBe(409);
  });
});
