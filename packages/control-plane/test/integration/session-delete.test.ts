/**
 * Deleting a session, end to end.
 *
 * The failure this closes: DELETE removed the session's row from the D1 index
 * and nothing else. The Durable Object kept its whole SQLite database — every
 * message, every event, its participants and its sandbox credentials — plus
 * its alarm and any media it had uploaded. The session vanished from the
 * product and stayed on the platform, unreachable and never released, for as
 * long as the deployment lived. A user who asked for a session to be deleted
 * got it hidden.
 *
 * These run against real Durable Object storage because that is the only place
 * the distinction between "hidden" and "gone" is observable at all.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionInternalPaths } from "../../src/session/contracts";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, initNamedSession, queryDO, seedEvents, serviceFetch } from "./helpers";

const MODEL = "anthropic/claude-haiku-4-5";

async function createOwnedSession(sessionId: string, ownerUserId: string) {
  const now = Date.now();
  await new SessionIndexStore(env.DB).create({
    id: sessionId,
    title: "Doomed session",
    repoOwner: "acme",
    repoName: "web-app",
    model: MODEL,
    reasoningEffort: null,
    baseBranch: "main",
    status: "created",
    userId: ownerUserId,
    createdAt: now,
    updatedAt: now,
  });
  return initNamedSession(sessionId, { model: MODEL, userId: ownerUserId });
}

function userFetch(accessToken: string, path: string, method = "GET"): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function listApplicationTables(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, (instance: SessionDO) =>
    instance.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .toArray()
      .map(({ name }) => name)
  );
}

describe("deleting a session", () => {
  let sessionId: string;
  let ownerToken: string;
  let ownerUserId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    sessionId = `delete-session-${crypto.randomUUID()}`;
    const owner = await createSignedInUser("100201");
    ownerToken = owner.accessToken;
    ownerUserId = owner.userId;
  });

  afterEach(cleanD1Tables);

  it("erases the durable object's storage, not just the index row", async () => {
    const { stub } = await createOwnedSession(sessionId, ownerUserId);
    await seedEvents(stub, [
      { id: "evt-1", type: "tool_call", data: '{"tool":"bash"}', createdAt: Date.now() },
      { id: "evt-2", type: "tool_result", data: '{"result":"ok"}', createdAt: Date.now() },
    ]);
    expect(await queryDO<{ id: string }>(stub, "SELECT id FROM events")).toHaveLength(2);

    const response = await userFetch(ownerToken, `/sessions/${sessionId}`, "DELETE");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "deleted", sessionId });
    // The index row is gone...
    await expect(new SessionIndexStore(env.DB).get(sessionId)).resolves.toBeNull();
    // ...and so is everything the Durable Object was holding. The tables
    // themselves no longer exist, which is what deleteAll leaves behind.
    await expect(queryDO(stub, "SELECT id FROM events")).rejects.toThrow(/no such table/);
    await expect(queryDO(stub, "SELECT id FROM session")).rejects.toThrow(/no such table/);

    const staleState = await stub.fetch(`http://internal${SessionInternalPaths.state}`);
    expect(staleState.status).toBe(410);
    await expect(staleState.json()).resolves.toEqual({ error: "Session deleted" });
    await expect(listApplicationTables(stub)).resolves.toEqual([]);

    const staleInit = await stub.fetch(`http://internal${SessionInternalPaths.init}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionName: sessionId,
        repoOwner: "acme",
        repoName: "web-app",
        repoId: 12345,
        userId: ownerUserId,
      }),
    });
    expect(staleInit.status).toBe(410);
    await expect(staleInit.json()).resolves.toEqual({ error: "Session deleted" });
    await expect(listApplicationTables(stub)).resolves.toEqual([]);
  });

  it("keeps a never-initialized durable object terminal after purge", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`bare-${sessionId}`));

    const purge = await stub.fetch(`http://internal${SessionInternalPaths.purge}`, {
      method: "POST",
    });

    expect(purge.status).toBe(200);
    await expect(listApplicationTables(stub)).resolves.toEqual([]);

    const staleState = await stub.fetch(`http://internal${SessionInternalPaths.state}`);
    expect(staleState.status).toBe(410);
    await expect(staleState.json()).resolves.toEqual({ error: "Session deleted" });
    await expect(listApplicationTables(stub)).resolves.toEqual([]);
  });

  it("closes accepted sockets without initializing the WebSocket manager", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`hibernated-${sessionId}`));

    const result = await runInDurableObject(stub, async (instance: SessionDO) => {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      instance.ctx.acceptWebSocket(server, ["sandbox"]);
      client.accept();
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client.addEventListener("close", (event) => {
          resolve({ code: event.code, reason: event.reason });
        });
      });

      const response = await instance.fetch(
        new Request(`http://internal${SessionInternalPaths.purge}`, { method: "POST" })
      );

      return { status: response.status, close: await closed };
    });

    expect(result).toEqual({
      status: 200,
      close: { code: 1001, reason: "session deleted" },
    });
    await expect(listApplicationTables(stub)).resolves.toEqual([]);
  });

  it("leaves nothing behind for a session that never ran a turn", async () => {
    const { stub } = await createOwnedSession(sessionId, ownerUserId);

    const response = await userFetch(ownerToken, `/sessions/${sessionId}`, "DELETE");

    expect(response.status).toBe(200);
    await expect(queryDO(stub, "SELECT id FROM session")).rejects.toThrow(/no such table/);
  });

  /**
   * The ownership gate is what stands between one user and another user's
   * session, and it now guards a destructive operation rather than a cosmetic
   * one. It lives at the router, so this pins it to the delete route by name.
   */
  it("refuses another signed-in user, leaving the session intact", async () => {
    const { stub } = await createOwnedSession(sessionId, ownerUserId);
    const intruder = await createSignedInUser("100202");

    const response = await userFetch(intruder.accessToken, `/sessions/${sessionId}`, "DELETE");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Session belongs to another user" });
    await expect(new SessionIndexStore(env.DB).get(sessionId)).resolves.not.toBeNull();
    expect(await queryDO<{ id: string }>(stub, "SELECT id FROM session")).toHaveLength(1);
  });

  it("lets a service principal delete on the deployment's behalf", async () => {
    const { stub } = await createOwnedSession(sessionId, ownerUserId);

    const response = await serviceFetch(`https://test.local/sessions/${sessionId}`, {
      method: "DELETE",
      service: "slack-bot",
      actor: "slack:U0000001",
    });

    expect(response.status).toBe(200);
    await expect(queryDO(stub, "SELECT id FROM session")).rejects.toThrow(/no such table/);
  });

  /**
   * A DELETE that already succeeded must be safe to send again — a retrying
   * client, or a user clicking twice, must not meet an error that suggests
   * something went wrong.
   */
  it("is safe to send twice for a service principal", async () => {
    await createOwnedSession(sessionId, ownerUserId);

    const first = await serviceFetch(`https://test.local/sessions/${sessionId}`, {
      method: "DELETE",
      service: "slack-bot",
      actor: "slack:U0000001",
    });
    const second = await serviceFetch(`https://test.local/sessions/${sessionId}`, {
      method: "DELETE",
      service: "slack-bot",
      actor: "slack:U0000001",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
