import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  OUTPOST_PROTOCOL_VERSION,
  HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE,
} from "@openoutposts/outpost-protocol";

import { collectMessages, homesteadFetch, homesteadHeaders } from "./helpers";

const CONNECT_URL = "https://test.local/homesteads/connect";

async function openHomestead(headerOverride?: Record<string, string>) {
  // The upgrade is signed like every other homestead call.
  const auth = headerOverride ?? (await homesteadHeaders("GET", CONNECT_URL));
  const response = await SELF.fetch(CONNECT_URL, {
    headers: { Upgrade: "websocket", ...auth },
  });
  const ws = response.webSocket;
  if (ws) ws.accept();
  return { response, ws };
}

function assignViaBinding(body: Record<string, unknown>) {
  const stub = env.HOMESTEAD.get(env.HOMESTEAD.idFromName("default"));
  return stub.fetch("http://internal/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productSessionId: "session-01",
      sandboxId: "sandbox-01",
      sandboxAuthToken: "bridge-token",
      credentialFetchToken: "fetch-token",
      controlPlaneUrl: "https://test.local",
      harness: "pi",
      model: "anthropic/claude-sonnet-4-6",
      outpostId: "workstation-01",
      workspacePath: "/workspace/sessions/session-01",
      repositories: [
        {
          repoOwner: "octocat",
          repoName: "Hello-World",
          baseBranch: "master",
          cloneUrl: "https://github.com/octocat/Hello-World.git",
        },
      ],
      ...body,
    }),
  });
}

interface HomesteadStatus {
  connected: boolean;
  homesteads: { id: string; connected: boolean }[];
}

async function homesteadStatus(): Promise<HomesteadStatus> {
  const response = await homesteadFetch("https://test.local/homesteads");
  expect(response.status).toBe(200);
  return response.json<HomesteadStatus>();
}

/** Polls until `check` holds, so nothing in these tests waits on a fixed sleep. */
async function waitUntil(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Registers a homestead and waits for the acknowledgement.
 *
 * Every test that wants a homestead gone must call {@link retireHomestead}: the
 * registry now keeps one connection per homestead id rather than evicting on
 * sight, so a socket a test walks away from stays registered and keeps
 * receiving assignments for the rest of the file.
 */
async function registerHomestead(homesteadId: string) {
  const { response, ws } = await openHomestead();
  expect(response.status).toBe(101);
  if (!ws) throw new Error("WebSocket upgrade failed");
  const registered = collectMessages(ws, {
    until: (message) => message.type === "homestead.registered",
  });
  ws.send(
    JSON.stringify({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId,
      homesteadVersion: "0.1.0-test",
      harnesses: ["pi"],
    })
  );
  expect(
    (await registered).find((message) => message.type === "homestead.registered")
  ).toMatchObject({
    homesteadId,
  });
  return ws;
}

/** Answers every assignment this homestead is offered, recording what it saw. */
function autoAccept(ws: WebSocket, accept = true): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
      string,
      unknown
    >;
    if (message.type !== "session.assign") return;
    seen.push(message);
    ws.send(
      JSON.stringify(
        accept
          ? {
              type: "session.assign_accepted",
              protocolVersion: OUTPOST_PROTOCOL_VERSION,
              assignmentId: message.assignmentId,
            }
          : {
              type: "session.assign_rejected",
              protocolVersion: OUTPOST_PROTOCOL_VERSION,
              assignmentId: message.assignmentId,
              reason: "outpost is offline",
            }
      )
    );
  });
  return seen;
}

/** Closes a homestead's socket and waits until the registry has stopped offering it. */
async function retireHomestead(ws: WebSocket, homesteadId: string): Promise<void> {
  ws.close(1000, "test complete");
  await waitUntil(async () => {
    const status = await homesteadStatus();
    return status.homesteads.find((homestead) => homestead.id === homesteadId)?.connected === false;
  }, `homestead ${homesteadId} to be recorded as disconnected`);
}

describe("Homestead WebSocket", () => {
  it("rejects unauthenticated homestead connections", async () => {
    const missing = await SELF.fetch("https://test.local/homesteads/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(401);

    const invalid = await openHomestead({
      "X-OpenOutposts-Service": "homestead",
      "X-OpenOutposts-Service-Signature": "sig1.1.aa.not-a-valid-signature",
    });
    expect(invalid.response.status).toBe(401);

    // The retired deployment-wide bearer opens nothing now, not even here.
    const bearer = await SELF.fetch(CONNECT_URL, {
      headers: { Upgrade: "websocket", Authorization: "Bearer 1.deadbeef" },
    });
    expect(bearer.status).toBe(401);
  });

  it("rejects an exact replay of a homestead connection signature", async () => {
    const headers = await homesteadHeaders("GET", CONNECT_URL);

    const first = await openHomestead(headers);
    expect(first.response.status).toBe(101);
    expect(first.ws).toBeDefined();
    first.ws?.close(1000, "test complete");

    const replay = await openHomestead(headers);
    expect(replay.response.status).toBe(401);
    expect(replay.ws).toBeNull();

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM service_auth_nonces WHERE service = ?"
    )
      .bind("homestead")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("registers a homestead and routes a session assignment to it", async () => {
    const { response, ws } = await openHomestead();
    expect(response.status).toBe(101);
    if (!ws) throw new Error("WebSocket upgrade failed");

    const seenAssignments: Record<string, unknown>[] = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
        string,
        unknown
      >;
      if (message.type === "session.assign") {
        seenAssignments.push(message);
        ws.send(
          JSON.stringify({
            type: "session.assign_accepted",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            assignmentId: message.assignmentId,
          })
        );
      }
    });

    const registered = collectMessages(ws, {
      until: (message) => message.type === "homestead.registered",
    });
    ws.send(
      JSON.stringify({
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: "homestead-01",
        homesteadVersion: "0.1.0-test",
        harnesses: ["pi"],
      })
    );
    expect(
      (await registered).find((message) => message.type === "homestead.registered")
    ).toMatchObject({ homesteadId: "homestead-01" });

    const assignResponse = await assignViaBinding({});
    expect(assignResponse.status).toBe(200);
    // The answer names the homestead that took the session even though the caller
    // asked for no particular one — that is the fact a homestead binding gets
    // written from.
    await expect(assignResponse.json()).resolves.toEqual({
      assigned: true,
      homesteadId: "homestead-01",
    });
    expect(seenAssignments).toHaveLength(1);
    expect(seenAssignments[0]).toMatchObject({
      productSessionId: "session-01",
      sandboxId: "sandbox-01",
      sandboxAuthToken: "bridge-token",
      outpostId: "workstation-01",
      workspacePath: "/workspace/sessions/session-01",
      repositories: [
        {
          repoOwner: "octocat",
          repoName: "Hello-World",
          cloneUrl: "https://github.com/octocat/Hello-World.git",
        },
      ],
    });

    const statusResponse = await homesteadFetch("https://test.local/homesteads");
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      connected: true,
      homesteads: [{ id: "homestead-01", connected: true }],
    });

    await retireHomestead(ws, "homestead-01");
  });

  it("surfaces homestead rejection and absence to the caller", async () => {
    const { ws } = await openHomestead();
    if (!ws) throw new Error("WebSocket upgrade failed");

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "{}") as Record<
        string,
        unknown
      >;
      if (message.type === "session.assign") {
        ws.send(
          JSON.stringify({
            type: "session.assign_rejected",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            assignmentId: message.assignmentId,
            reason: "outpost is offline",
          })
        );
      }
    });

    const registered = collectMessages(ws, {
      until: (message) => message.type === "homestead.registered",
    });
    ws.send(
      JSON.stringify({
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: "homestead-02",
        homesteadVersion: "0.1.0-test",
        harnesses: ["pi"],
      })
    );
    await registered;

    const rejected = await assignViaBinding({ productSessionId: "session-02" });
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({
      error: expect.stringContaining("outpost is offline"),
    });

    // After the homestead disconnects, assignment fails fast with a conflict.
    await retireHomestead(ws, "homestead-02");
    const absent = await assignViaBinding({ productSessionId: "session-03" });
    expect(absent.status).toBe(409);
  });

  it("holds a connection for each homestead id at once", async () => {
    const east = await registerHomestead("homestead-east");
    const west = await registerHomestead("homestead-west");

    const status = await homesteadStatus();
    expect(status.connected).toBe(true);
    expect(
      status.homesteads
        .filter((homestead) => homestead.connected)
        .map((homestead) => homestead.id)
        .sort()
    ).toEqual(["homestead-east", "homestead-west"]);

    await retireHomestead(east, "homestead-east");
    // One homestead leaving says nothing about the other: the registry is no
    // longer a single socket that either exists or does not.
    const afterOneLeft = await homesteadStatus();
    expect(afterOneLeft.connected).toBe(true);
    expect(
      afterOneLeft.homesteads
        .filter((homestead) => homestead.connected)
        .map((homestead) => homestead.id)
    ).toEqual(["homestead-west"]);

    await retireHomestead(west, "homestead-west");
    expect((await homesteadStatus()).connected).toBe(false);
  });

  it("sends a targeted assignment to the homestead it names, and to no other", async () => {
    const east = await registerHomestead("homestead-target-east");
    const west = await registerHomestead("homestead-target-west");
    const seenByEast = autoAccept(east);
    const seenByWest = autoAccept(west);

    const response = await assignViaBinding({
      homesteadId: "homestead-target-east",
      productSessionId: "session-targeted",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assigned: true,
      homesteadId: "homestead-target-east",
    });
    expect(seenByEast.map((message) => message.productSessionId)).toEqual(["session-targeted"]);
    expect(seenByWest).toEqual([]);

    await retireHomestead(east, "homestead-target-east");
    await retireHomestead(west, "homestead-target-west");
  });

  it("refuses a targeted assignment whose homestead is gone instead of using another", async () => {
    const survivor = await registerHomestead("homestead-survivor");
    const seenBySurvivor = autoAccept(survivor);
    const departed = await registerHomestead("homestead-departed");
    await retireHomestead(departed, "homestead-departed");

    const response = await assignViaBinding({
      homesteadId: "homestead-departed",
      productSessionId: "session-orphaned",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Homestead homestead-departed is not connected",
    });
    // The point of the refusal: a homestead that was there did not quietly take
    // work addressed to one that was not.
    expect(seenBySurvivor).toEqual([]);

    await retireHomestead(survivor, "homestead-survivor");
  });

  it("refuses a second connection claiming a live homestead id and records the refusal", async () => {
    const holder = await registerHomestead("homestead-contested");
    const seenByHolder = autoAccept(holder);

    const { ws: intruder } = await openHomestead();
    if (!intruder) throw new Error("WebSocket upgrade failed");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      intruder.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason })
      );
    });
    const refusal = collectMessages(intruder, {
      until: (message) => message.type === "homestead.error",
    });
    intruder.send(
      JSON.stringify({
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: "homestead-contested",
        homesteadVersion: "0.1.0-test",
        harnesses: ["pi"],
      })
    );

    expect((await refusal).find((message) => message.type === "homestead.error")).toMatchObject({
      code: "duplicate_identity",
      message: expect.stringContaining("homestead-contested"),
    });
    expect(await closed).toMatchObject({ code: HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE });

    // The holder is untouched: still registered, still the one that serves.
    const status = await homesteadStatus();
    expect(
      status.homesteads.filter((homestead) => homestead.connected).map((homestead) => homestead.id)
    ).toEqual(["homestead-contested"]);
    const assigned = await assignViaBinding({
      homesteadId: "homestead-contested",
      productSessionId: "session-contested",
    });
    expect(assigned.status).toBe(200);
    expect(seenByHolder.map((message) => message.productSessionId)).toEqual(["session-contested"]);

    // Refusing quietly would be no better than rebinding quietly: identity
    // takeover is what the audit record exists to make visible.
    await waitUntil(async () => {
      const row = await env.DB.prepare(
        "SELECT object_id, outcome, actor_kind FROM audit_log WHERE action = ? AND object_id = ?"
      )
        .bind("homestead.identity_refused", "homestead-contested")
        .first<{ object_id: string; outcome: string; actor_kind: string }>();
      return row?.outcome === "denied" && row.actor_kind === "internal";
    }, "the refusal to be recorded in the audit log");

    await retireHomestead(holder, "homestead-contested");
  });

  it("refuses to let one connection change which homestead it is", async () => {
    const ws = await registerHomestead("homestead-settled");
    const refusal = collectMessages(ws, {
      until: (message) => message.type === "homestead.error",
    });
    ws.send(
      JSON.stringify({
        type: "homestead.register",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        homesteadId: "homestead-renamed",
        homesteadVersion: "0.1.0-test",
        harnesses: ["pi"],
      })
    );
    expect((await refusal).find((message) => message.type === "homestead.error")).toMatchObject({
      code: "identity_mismatch",
    });

    const status = await homesteadStatus();
    expect(status.homesteads.map((homestead) => homestead.id)).not.toContain("homestead-renamed");
    await waitUntil(async () => {
      const current = await homesteadStatus();
      return current.homesteads.every((homestead) => !homestead.connected);
    }, "the refused connection to be closed");
  });

  it("lets a homestead id be reclaimed once its connection is gone", async () => {
    const first = await registerHomestead("homestead-returning");
    await retireHomestead(first, "homestead-returning");

    // A refusal that outlived the process holding the id would lock a homestead
    // out of its own identity; only a live connection holds one.
    const second = await registerHomestead("homestead-returning");
    const seenBySecond = autoAccept(second);
    const assigned = await assignViaBinding({
      homesteadId: "homestead-returning",
      productSessionId: "session-returned",
    });
    expect(assigned.status).toBe(200);
    expect(seenBySecond.map((message) => message.productSessionId)).toEqual(["session-returned"]);

    await retireHomestead(second, "homestead-returning");
  });
});
