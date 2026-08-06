import { describe, expect, it, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";

import { ApiTokenStore } from "../../src/db/api-tokens";
import { UserStore } from "../../src/db/user-store";
import { WebSessionTokenService } from "../../src/auth/web-session-tokens";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  connectConfirmedOutpost,
  seedConfirmedOutpost,
  seedIndexedSession,
  homesteadFetch,
} from "./helpers";

/** The credential the web BFF forwards from a signed-in browser. */
async function signInUser(email: string): Promise<string> {
  const user = await new UserStore(env.DB).createUser({ displayName: email, email });
  const pair = await new WebSessionTokenService(new ApiTokenStore(env.DB)).mintPair(user.id, {
    provider: "github",
    providerUserId: `github-${user.id}`,
  });
  return pair.accessToken;
}

/** Connect a worker and register it, returning its socket. */
async function enrolWorker(
  outpostId: string
): Promise<{ ws: WebSocket; accessToken: string; ownerUserId: string }> {
  const machine = await seedConfirmedOutpost(outpostId);
  const { ws } = await connectConfirmedOutpost(machine);
  if (!ws) throw new Error("WebSocket upgrade failed");

  // Stand in for the worker: accept every lease it is offered.
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
      name: "Studio Mac mini",
      workerVersion: "0.1.0-test",
      capabilities: {
        platform: "darwin",
        architecture: "arm64",
        operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
        workspaceRoots: ["/workspace"],
      },
    })
  );
  await registered;
  return { ws, accessToken: machine.ownerAccessToken, ownerUserId: machine.ownerUserId };
}

async function grantLease(
  outpostId: string,
  productSessionId: string,
  ownerUserId: string
): Promise<string> {
  // A lease is only granted when the session's owner owns the machine.
  await seedIndexedSession(productSessionId, ownerUserId);
  const response = await homesteadFetch(`https://test.local/outposts/${outpostId}/leases`, {
    method: "POST",
    body: JSON.stringify({ productSessionId, workspacePath: "/workspace/project" }),
  });
  expect(response.status).toBe(201);
  const lease = await response.json<{ leaseId: string }>();
  return lease.leaseId;
}

describe("fleet routes the machines page drives", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.exec("DELETE FROM outposts;");
  });

  it("reports the sessions bound to a machine without leaking its capabilities", async () => {
    const outpostId = `bound-${Date.now()}`;
    const { ws, accessToken, ownerUserId } = await enrolWorker(outpostId);
    const leaseId = await grantLease(outpostId, "session-abc", ownerUserId);

    const response = await SELF.fetch(`https://test.local/outposts/${outpostId}/sessions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ sessions: Array<Record<string, unknown>> }>();
    expect(body.sessions).toEqual([
      {
        leaseId,
        productSessionId: "session-abc",
        workspacePath: "/workspace/project",
        expiresAt: expect.any(String),
      },
    ]);
    // The DO's status carries capabilities, workspace roots and the connection
    // id. None of that belongs on a route an end-user credential can reach.
    expect(JSON.stringify(body)).not.toContain("workspaceRoots");
    expect(JSON.stringify(body)).not.toContain("connectionId");

    ws.close(1000, "test complete");
  });

  it("hides bindings from a user who does not own the machine", async () => {
    const outpostId = `unattributable-${Date.now()}`;
    const { ws } = await enrolWorker(outpostId);
    const accessToken = await signInUser("intruder@example.com");

    const response = await SELF.fetch(`https://test.local/outposts/${outpostId}/sessions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(404);
    ws.close(1000, "test complete");
  });

  it("removes a machine: releases its leases, tells the worker, forgets the row", async () => {
    const outpostId = `removed-${Date.now()}`;
    const { ws, accessToken, ownerUserId } = await enrolWorker(outpostId);
    const leaseId = await grantLease(outpostId, "session-abc", ownerUserId);

    const released = collectMessages(ws, {
      until: (message) => message.type === "lease.release",
    });

    const response = await SELF.fetch(`https://test.local/outposts/${outpostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: true, revoked: true });

    // The worker is told, rather than left believing it still holds the lease.
    expect(await released).toContainEqual(
      expect.objectContaining({ type: "lease.release", leaseId })
    );

    // The fleet listing is the owner's view, not the homestead's.
    const listing = await SELF.fetch("https://test.local/outposts", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await listing.json<{ outposts: Array<{ id: string }> }>();
    expect(body.outposts.map((outpost) => outpost.id)).not.toContain(outpostId);

    // And the lease is genuinely gone: work cannot keep flowing to a machine
    // the fleet no longer lists.
    const toolResponse = await homesteadFetch(`https://test.local/outposts/${outpostId}/tool`, {
      method: "POST",
      body: JSON.stringify({ leaseId, operation: "bash", input: { command: "echo hello" } }),
    });
    await expect(toolResponse.json()).resolves.toMatchObject({
      ok: false,
      errorCode: "lease_unknown",
    });
  });

  it("404s a removal for a machine the directory never listed", async () => {
    const accessToken = await signInUser("owner@example.com");

    const response = await SELF.fetch("https://test.local/outposts/ghost-machine", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(404);
  });

  it("rejects an unauthenticated removal", async () => {
    const outpostId = `guarded-${Date.now()}`;
    const { ws, accessToken } = await enrolWorker(outpostId);

    const response = await SELF.fetch(`https://test.local/outposts/${outpostId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
    const listing = await SELF.fetch("https://test.local/outposts", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await listing.json<{ outposts: Array<{ id: string }> }>();
    expect(body.outposts.map((outpost) => outpost.id)).toContain(outpostId);

    ws.close(1000, "test complete");
  });
});
