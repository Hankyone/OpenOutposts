import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

import {
  collectMessages,
  initNamedSession,
  openClientWs,
  queryDO,
  seedSandboxAuth,
} from "./helpers";

let sequence = 0;

async function setup() {
  sequence += 1;
  const sessionName = `startup-failure-${Date.now()}-${sequence}`;
  const sandboxId = `sandbox-${sequence}`;
  const bridgeToken = `bridge-${sequence}`;
  const credentialFetchToken = `fetch-${sequence}`;
  const { stub } = await initNamedSession(sessionName);
  await seedSandboxAuth(stub, {
    authToken: bridgeToken,
    credentialFetchToken,
    sandboxId,
    status: "connecting",
  });
  const existing = await queryDO<{ last_spawn_error: string | null }>(
    stub,
    "SELECT last_spawn_error FROM sandbox LIMIT 1"
  );
  return {
    sessionName,
    sandboxId,
    bridgeToken,
    credentialFetchToken,
    stub,
    initialSpawnError: existing[0]?.last_spawn_error ?? null,
  };
}

function report(
  sessionName: string,
  token: string,
  body: Record<string, unknown>
): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionName}/startup-failure`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /sessions/:id/startup-failure", () => {
  it("persists clone failure on the current generation and broadcasts sandbox_error", async () => {
    const generation = await setup();
    const { ws } = await openClientWs(generation.sessionName, { subscribe: true });
    const messages = collectMessages(ws, {
      until: (message) => message.type === "sandbox_error",
    });
    const timestamp = Date.now();

    const response = await report(generation.sessionName, generation.bridgeToken, {
      stage: "repository_clone",
      error: "git clone exited 128: repository not found",
      sandboxId: generation.sandboxId,
      timestamp,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "failed" });
    const rows = await queryDO<{
      status: string;
      last_spawn_error: string | null;
      last_spawn_error_at: number | null;
    }>(
      generation.stub,
      "SELECT status, last_spawn_error, last_spawn_error_at FROM sandbox LIMIT 1"
    );
    expect(rows[0]).toEqual({
      status: "failed",
      last_spawn_error: "git clone exited 128: repository not found",
      last_spawn_error_at: timestamp,
    });
    expect(await messages).toContainEqual({
      type: "sandbox_error",
      error: "git clone exited 128: repository not found",
    });
    ws.close();
  });

  it("refuses a stale sandbox id without changing the current generation", async () => {
    const generation = await setup();

    const response = await report(generation.sessionName, generation.bridgeToken, {
      stage: "harness_start",
      error: "late failure from an old assignment",
      sandboxId: "older-generation",
      timestamp: Date.now(),
    });

    expect(response.status).toBe(409);
    const rows = await queryDO<{ status: string; last_spawn_error: string | null }>(
      generation.stub,
      "SELECT status, last_spawn_error FROM sandbox LIMIT 1"
    );
    expect(rows[0]).toEqual({
      status: "connecting",
      last_spawn_error: generation.initialSpawnError,
    });
  });

  it("accepts only the bridge token, not the credential-fetch token", async () => {
    const generation = await setup();

    const response = await report(generation.sessionName, generation.credentialFetchToken, {
      stage: "bridge_start",
      error: "bridge failed",
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });

    expect(response.status).toBe(401);
    const rows = await queryDO<{ status: string }>(
      generation.stub,
      "SELECT status FROM sandbox LIMIT 1"
    );
    expect(rows[0]?.status).toBe("connecting");
  });

  it("refuses a delayed duplicate after the current generation is ready", async () => {
    const generation = await setup();
    await queryDO(generation.stub, "UPDATE sandbox SET status = ?", "ready");
    const before = await queryDO<{ last_spawn_error: string | null }>(
      generation.stub,
      "SELECT last_spawn_error FROM sandbox LIMIT 1"
    );

    const response = await report(generation.sessionName, generation.bridgeToken, {
      stage: "bridge_start",
      error: "delayed duplicate startup report",
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });

    expect(response.status).toBe(409);
    const rows = await queryDO<{ status: string; last_spawn_error: string | null }>(
      generation.stub,
      "SELECT status, last_spawn_error FROM sandbox LIMIT 1"
    );
    expect(rows[0]).toEqual({ status: "ready", last_spawn_error: before[0]?.last_spawn_error });
  });

  it("rejects an oversized error without changing lifecycle state", async () => {
    const generation = await setup();

    const response = await report(generation.sessionName, generation.bridgeToken, {
      stage: "repository_clone",
      error: "x".repeat(2049),
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });

    expect(response.status).toBe(400);
    const rows = await queryDO<{ status: string; last_spawn_error: string | null }>(
      generation.stub,
      "SELECT status, last_spawn_error FROM sandbox LIMIT 1"
    );
    expect(rows[0]).toEqual({
      status: "connecting",
      last_spawn_error: generation.initialSpawnError,
    });
  });
});
