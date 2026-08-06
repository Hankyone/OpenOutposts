import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";

import { base64UrlEncode } from "../../src/auth/encoding";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  connectConfirmedOutpost,
  createSignedInUser,
  machineProofHeaders,
  type TestMachineIdentity,
} from "./helpers";

function userFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

function tokenFromCommand(command: string): string {
  const match = command.match(/--token '([^']+)'/);
  if (!match) throw new Error("enrollment command did not contain a token");
  return match[1];
}

describe("owner-scoped outpost enrollment", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("requires machine-side possession, user confirmation, and then machine proof", async () => {
    const owner = await createSignedInUser("enrollment-owner");
    const intruder = await createSignedInUser("enrollment-intruder");

    const issued = await userFetch(owner.accessToken, "/outposts/enrollments", {
      method: "POST",
      body: JSON.stringify({ name: "Studio Mac" }),
    });
    expect(issued.status).toBe(201);
    const issue = await issued.json<{
      enrollmentId: string;
      commands: { macos: string; linux: string };
    }>();
    expect(issue.commands.macos).toContain("openoutpost enroll");
    expect(issue.commands.linux).toContain("openoutpost enroll");
    const token = tokenFromCommand(issue.commands.macos);
    expect(token).toMatch(/^oo_enroll_/);

    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
    const consumed = await SELF.fetch("https://test.local/outposts/enrollments/consume", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Host-provided name",
        workerVersion: "0.2.0-test",
        platform: "darwin",
        architecture: "arm64",
        publicKey: base64UrlEncode(publicKey),
        workspaceRoots: ["/Users/dev/work"],
      }),
    });
    expect(consumed.status).toBe(201);
    const machineResult = await consumed.json<{
      outpostId: string;
      confirmationCode: string;
    }>();
    expect(machineResult.outpostId).toMatch(/^outpost-/);
    expect(machineResult.confirmationCode).toMatch(/^\d{3}-\d{3}$/);

    const storedToken = await env.DB.prepare(
      "SELECT token_hash FROM outpost_enrollments WHERE id = ?"
    )
      .bind(issue.enrollmentId)
      .first<{ token_hash: string }>();
    expect(storedToken?.token_hash).not.toContain(token);

    const pending = await env.DB.prepare("SELECT * FROM outposts WHERE id = ?")
      .bind(machineResult.outpostId)
      .first<{ owner_user_id: string; confirmed_at: number | null; name: string }>();
    expect(pending).toMatchObject({
      owner_user_id: owner.userId,
      confirmed_at: null,
      name: "Studio Mac",
    });
    const pendingListing = await userFetch(owner.accessToken, "/outposts");
    await expect(pendingListing.json()).resolves.toEqual({ outposts: [] });

    const keyFingerprint = base64UrlEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey))
    );
    const machine: TestMachineIdentity = {
      outpostId: machineResult.outpostId,
      ownerUserId: owner.userId,
      ownerAccessToken: owner.accessToken,
      keyFingerprint,
      privateKey: keyPair.privateKey,
    };
    const statusPath = `/outposts/${machine.outpostId}/enrollment-status`;
    const statusHeaders = await machineProofHeaders(machine, "GET", statusPath);
    const status = await SELF.fetch(`https://test.local${statusPath}`, {
      headers: statusHeaders,
    });
    await expect(status.json()).resolves.toMatchObject({
      state: "pending",
      confirmed: false,
    });
    const replayedProof = await SELF.fetch(`https://test.local${statusPath}`, {
      headers: statusHeaders,
    });
    expect(replayedProof.status).toBe(401);

    const hiddenListing = await userFetch(intruder.accessToken, "/outposts");
    await expect(hiddenListing.json()).resolves.toEqual({ outposts: [] });

    const wrongOwner = await userFetch(
      intruder.accessToken,
      `/outposts/enrollments/${issue.enrollmentId}/confirm`,
      { method: "POST", body: JSON.stringify({ code: machineResult.confirmationCode }) }
    );
    expect(wrongOwner.status).toBe(409);

    const confirmed = await userFetch(
      owner.accessToken,
      `/outposts/enrollments/${issue.enrollmentId}/confirm`,
      { method: "POST", body: JSON.stringify({ code: machineResult.confirmationCode }) }
    );
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toEqual({
      confirmed: true,
      outpostId: machine.outpostId,
    });
    const confirmedListing = await userFetch(owner.accessToken, "/outposts");
    await expect(confirmedListing.json()).resolves.toMatchObject({
      outposts: [{ id: machine.outpostId, name: "Studio Mac", confirmed: true }],
    });

    const intruderSession = await userFetch(intruder.accessToken, "/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Wrong owner",
        model: "anthropic/claude-haiku-4-5",
        outpostId: machine.outpostId,
      }),
    });
    expect(intruderSession.status).toBe(403);

    const ownerSession = await userFetch(owner.accessToken, "/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: "Owned target",
        model: "anthropic/claude-haiku-4-5",
        outpostId: machine.outpostId,
      }),
    });
    expect(ownerSession.status).toBe(201);

    const connected = await connectConfirmedOutpost(machine);
    expect(connected.response.status).toBe(101);
    if (!connected.ws) throw new Error("WebSocket upgrade failed");
    const registered = collectMessages(connected.ws, {
      until: (message) => message.type === "outpost.registered",
    });
    connected.ws.send(
      JSON.stringify({
        type: "outpost.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: machine.outpostId,
        name: "Studio Mac",
        workerVersion: "0.2.0-test",
        capabilities: {
          platform: "darwin",
          architecture: "arm64",
          operations: ["bash", "read", "write", "edit", "grep", "find", "ls"],
          workspaceRoots: ["/Users/dev/work"],
        },
      })
    );
    await registered;

    const removed = await userFetch(owner.accessToken, `/outposts/${machine.outpostId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ removed: true, revoked: true });

    const reconnect = await connectConfirmedOutpost(machine);
    expect(reconnect.response.status).toBe(401);
    expect(reconnect.ws).toBeNull();
  });

  it("consumes each one-time enrollment token only once", async () => {
    const owner = await createSignedInUser("single-use-owner");
    const issued = await userFetch(owner.accessToken, "/outposts/enrollments", {
      method: "POST",
      body: "{}",
    });
    const issue = await issued.json<{ commands: { linux: string } }>();
    const token = tokenFromCommand(issue.commands.linux);
    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
    );
    const body = JSON.stringify({
      name: "Single use",
      workerVersion: "test",
      platform: "linux",
      architecture: "amd64",
      publicKey,
      workspaceRoots: ["/workspace"],
    });
    const first = await SELF.fetch("https://test.local/outposts/enrollments/consume", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    const second = await SELF.fetch("https://test.local/outposts/enrollments/consume", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body,
    });
    expect(second.status).toBe(401);
  });
});
