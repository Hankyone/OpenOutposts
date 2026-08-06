import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";

import {
  collectMessages,
  connectConfirmedOutpost,
  seedConfirmedOutpost,
  seedIndexedSession,
  type TestMachineIdentity,
  homesteadFetch,
} from "./helpers";

async function openOutpost(outpostId: string) {
  const machine = await seedConfirmedOutpost(outpostId);
  return { ...(await connectConfirmedOutpost(machine)), machine };
}

describe("Outpost WebSocket", () => {
  it("fails closed when enrollment authentication is missing or invalid", async () => {
    const missing = await SELF.fetch("https://test.local/outposts/workstation-01/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(401);

    const invalid = await SELF.fetch("https://test.local/outposts/workstation-01/connect", {
      headers: {
        Upgrade: "websocket",
        Authorization: "Bearer wrong-token",
      },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.webSocket).toBeNull();
  });

  it("refuses a second live connection for the same machine identity", async () => {
    const machine: TestMachineIdentity = await seedConfirmedOutpost(`duplicate-${Date.now()}`);
    const first = await connectConfirmedOutpost(machine);
    expect(first.response.status).toBe(101);
    if (!first.ws) throw new Error("WebSocket upgrade failed");
    const registered = collectMessages(first.ws, {
      until: (message) => message.type === "outpost.registered",
    });
    first.ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: machine.outpostId,
        name: "Duplicate test",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "linux",
          architecture: "amd64",
          operations: ["bash"],
          workspaceRoots: ["/workspace"],
        },
      })
    );
    await registered;
    const duplicate = await connectConfirmedOutpost(machine);
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.ws).toBeNull();
    first.ws?.close(1000, "test complete");
  });

  it("refuses registration when revocation lands after the signed upgrade", async () => {
    const machine = await seedConfirmedOutpost(`revocation-race-${Date.now()}`);
    const connection = await connectConfirmedOutpost(machine);
    expect(connection.response.status).toBe(101);
    if (!connection.ws) throw new Error("WebSocket upgrade failed");

    await env.DB.prepare("UPDATE outposts SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), machine.outpostId)
      .run();

    const rejected = collectMessages(connection.ws, {
      until: (message) => message.type === "outpost.error",
    });
    connection.ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: machine.outpostId,
        name: "Revoked during connect",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "linux",
          architecture: "amd64",
          operations: ["bash"],
          workspaceRoots: ["/workspace"],
        },
      })
    );

    expect(await rejected).toContainEqual(
      expect.objectContaining({ type: "outpost.error", code: "identity_mismatch" })
    );
  });

  it("registers, acknowledges heartbeats, and exposes current status", async () => {
    const outpostId = `workstation-${Date.now()}`;
    const { response, ws, machine } = await openOutpost(outpostId);
    expect(response.status).toBe(101);
    expect(ws).toBeDefined();
    if (!ws) throw new Error("WebSocket upgrade failed");

    const registrationMessages = collectMessages(ws, {
      until: (message) => message.type === "outpost.registered",
    });
    ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId,
        name: "Test workstation",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "darwin",
          architecture: "arm64",
          operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
          workspaceRoots: ["/workspace"],
        },
      })
    );

    const registered = (await registrationMessages).find(
      (message) => message.type === "outpost.registered"
    );
    expect(registered).toMatchObject({
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      outpostId,
      heartbeatIntervalMs: 15_000,
    });

    const heartbeatMessages = collectMessages(ws, {
      until: (message) => message.type === "outpost.heartbeat_ack",
    });
    ws.send(
      JSON.stringify({
        type: "outpost.heartbeat",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId,
        sentAt: new Date().toISOString(),
      })
    );
    expect(await heartbeatMessages).toContainEqual(
      expect.objectContaining({
        type: "outpost.heartbeat_ack",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId,
      })
    );

    const statusResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}`);
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      id: outpostId,
      name: "Test workstation",
      workerVersion: "0.1.0-test",
      connected: true,
      capabilities: {
        platform: "darwin",
        architecture: "arm64",
        workspaceRoots: ["/workspace"],
      },
    });

    // The fleet listing belongs to the owner, not to the homestead.
    const listResponse = await SELF.fetch("https://test.local/outposts", {
      headers: { Authorization: `Bearer ${machine.ownerAccessToken}` },
    });
    expect(listResponse.status).toBe(200);
    const listing = (await listResponse.json()) as {
      outposts: Array<{ id: string; connected: boolean; platform: string }>;
    };
    expect(listing.outposts).toContainEqual(
      expect.objectContaining({ id: outpostId, connected: true, platform: "darwin" })
    );

    ws.close(1000, "test complete");
  });

  it("grants leases and routes tool calls to the connected worker", async () => {
    const outpostId = `leased-${Date.now()}`;
    const { ws, machine } = await openOutpost(outpostId);
    await seedIndexedSession("session-01", machine.ownerUserId);
    if (!ws) throw new Error("WebSocket upgrade failed");

    // Simulate the worker: accept lease offers, answer context and tool requests.
    const seenToolRequests: Record<string, unknown>[] = [];
    const seenContextRequests: Record<string, unknown>[] = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
        string,
        unknown
      >;
      if (message.type === "lease.offer") {
        ws.send(
          JSON.stringify({
            type: "lease.accepted",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            leaseId: message.leaseId,
          })
        );
      }
      if (message.type === "tool.request") {
        seenToolRequests.push(message);
        ws.send(
          JSON.stringify({
            type: "tool.result",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            requestId: message.requestId,
            leaseId: message.leaseId,
            ok: true,
            output: {
              stdout: "hello from the outpost\n",
              stderr: "",
              exitCode: 0,
              durationMs: 5,
              truncated: false,
            },
          })
        );
      }
      if (message.type === "context.request") {
        seenContextRequests.push(message);
        ws.send(
          JSON.stringify({
            type: "context.result",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            requestId: message.requestId,
            leaseId: message.leaseId,
            ok: true,
            files: [{ path: "outpost:/project/AGENTS.md", content: "# Project rules" }],
          })
        );
      }
    });

    const registered = collectMessages(ws, {
      until: (message) => message.type === "outpost.registered",
    });
    ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId,
        name: "Leased workstation",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "linux",
          architecture: "amd64",
          operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
          workspaceRoots: ["/workspace"],
        },
      })
    );
    await registered;

    const leaseResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/leases`, {
      method: "POST",
      body: JSON.stringify({
        productSessionId: "session-01",
        workspacePath: "/workspace/project",
      }),
    });
    expect(leaseResponse.status).toBe(201);
    const lease = (await leaseResponse.json()) as { leaseId: string; expiresAt: string };
    expect(lease.leaseId).toBeTruthy();

    const contextResponse = await homesteadFetch(
      `https://test.local/outposts/${outpostId}/leases/${lease.leaseId}/context`,
      { method: "POST", body: "{}" }
    );
    expect(contextResponse.status).toBe(200);
    await expect(contextResponse.json()).resolves.toEqual({
      ok: true,
      files: [{ path: "outpost:/project/AGENTS.md", content: "# Project rules" }],
    });
    expect(seenContextRequests).toHaveLength(1);
    expect(seenContextRequests[0]).toMatchObject({ leaseId: lease.leaseId });

    const toolResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
      method: "POST",
      body: JSON.stringify({
        leaseId: lease.leaseId,
        operation: "bash",
        input: { command: "echo hello" },
      }),
    });
    expect(toolResponse.status).toBe(200);
    await expect(toolResponse.json()).resolves.toMatchObject({
      ok: true,
      output: { stdout: "hello from the outpost\n", exitCode: 0 },
    });
    expect(seenToolRequests).toHaveLength(1);
    expect(seenToolRequests[0]).toMatchObject({
      leaseId: lease.leaseId,
      operation: "bash",
      input: { command: "echo hello" },
    });

    // Invalid input is rejected before it reaches the worker.
    const invalidResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
      method: "POST",
      body: JSON.stringify({
        leaseId: lease.leaseId,
        operation: "edit",
        input: { path: "a.txt" },
      }),
    });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ errorCode: "invalid_input" });

    const statusResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}`, {});
    await expect(statusResponse.json()).resolves.toMatchObject({
      activeLeases: [{ leaseId: lease.leaseId, productSessionId: "session-01" }],
    });

    const renewResponse = await homesteadFetch(
      `https://test.local/outposts/${outpostId}/leases/${lease.leaseId}/renew`,
      { method: "POST", body: JSON.stringify({ ttlMs: 7_200_000 }) }
    );
    expect(renewResponse.status).toBe(200);
    const renewed = (await renewResponse.json()) as { expiresAt: string };
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
      new Date(lease.expiresAt).getTime()
    );

    const cancelResponse = await homesteadFetch(
      `https://test.local/outposts/${outpostId}/leases/${lease.leaseId}/cancel-work`,
      { method: "POST", body: "{}" }
    );
    expect(cancelResponse.status).toBe(200);

    const releaseResponse = await homesteadFetch(
      `https://test.local/outposts/${outpostId}/leases/${lease.leaseId}`,
      { method: "DELETE", body: JSON.stringify({ reason: "completed" }) }
    );
    expect(releaseResponse.status).toBe(200);

    const afterRelease = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
      method: "POST",
      body: JSON.stringify({
        leaseId: lease.leaseId,
        operation: "bash",
        input: { command: "echo hello" },
      }),
    });
    await expect(afterRelease.json()).resolves.toMatchObject({
      ok: false,
      errorCode: "lease_unknown",
    });

    ws.close(1000, "test complete");
  });

  it("cancels the worker request when a tool call times out", async () => {
    const outpostId = `timeout-${Date.now()}`;
    const { ws, machine } = await openOutpost(outpostId);
    await seedIndexedSession("session-timeout", machine.ownerUserId);
    if (!ws) throw new Error("WebSocket upgrade failed");

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
        string,
        unknown
      >;
      if (message.type === "lease.offer") {
        ws.send(
          JSON.stringify({
            type: "lease.accepted",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            leaseId: message.leaseId,
          })
        );
      }
    });

    const registered = collectMessages(ws, {
      until: (message) => message.type === "outpost.registered",
    });
    ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId,
        name: "Slow workstation",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "linux",
          architecture: "amd64",
          operations: ["bash"],
          workspaceRoots: ["/workspace"],
        },
      })
    );
    await registered;

    const leaseResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/leases`, {
      method: "POST",
      body: JSON.stringify({
        productSessionId: "session-timeout",
        workspacePath: "/workspace/project",
      }),
    });
    const lease = (await leaseResponse.json()) as { leaseId: string };

    const workerMessages = collectMessages(ws, {
      until: (message) => message.type === "tool.cancel",
    });
    const response = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
      method: "POST",
      body: JSON.stringify({
        leaseId: lease.leaseId,
        operation: "bash",
        input: { command: "sleep 600" },
        timeoutMs: 20,
      }),
    });
    const messages = await workerMessages;
    const request = messages.find((message) => message.type === "tool.request");
    const cancellation = messages.find((message) => message.type === "tool.cancel");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, errorCode: "timeout" });
    expect(request?.requestId).toEqual(expect.any(String));
    expect(cancellation).toMatchObject({
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      leaseId: lease.leaseId,
      requestId: request?.requestId,
    });

    ws.close(1000, "test complete");
  });

  it("refuses to lease a disconnected outpost", async () => {
    const outpostId = `never-connected-${Date.now()}`;
    const machine = await seedConfirmedOutpost(outpostId);
    await seedIndexedSession("session-01", machine.ownerUserId);
    const response = await homesteadFetch(`https://test.local/outposts/${outpostId}/leases`, {
      method: "POST",
      body: JSON.stringify({ productSessionId: "session-01", workspacePath: "/workspace" }),
    });
    expect(response.status).toBe(409);
  });

  it("rejects a registration whose identity differs from the route", async () => {
    const { ws } = await openOutpost(`expected-${Date.now()}`);
    if (!ws) throw new Error("WebSocket upgrade failed");

    const messages = collectMessages(ws, {
      until: (message) => message.type === "outpost.error",
    });
    ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: "different-outpost",
        name: "Wrong workstation",
        workerVersion: "0.1.0-test",
        capabilities: {
          platform: "linux",
          architecture: "amd64",
          operations: ["bash"],
          workspaceRoots: [],
        },
      })
    );

    expect(await messages).toContainEqual(
      expect.objectContaining({ type: "outpost.error", code: "identity_mismatch" })
    );
  });
});
