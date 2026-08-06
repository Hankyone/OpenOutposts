/**
 * Session ownership at the worker edge.
 *
 * The escalation this closes: a prompt drives the harness, the harness drives
 * the outpost bash tool on the session owner's own machine, and every
 * session-scoped route used to take the session id straight from the path. Any
 * signed-in user could therefore run shell commands on any other user's machine
 * by addressing their session. The sign-in allowlist was the only thing in the
 * way, and it stops being a boundary the moment a second person is allowlisted
 * — which these tests do deliberately.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";

const MODEL = "anthropic/claude-haiku-4-5";

/**
 * Create a session that exists in both places it has to: the D1 index row the
 * ownership gate reads, and the Durable Object the routes proxy to.
 */
async function createOwnedSession(sessionId: string, ownerUserId: string | null): Promise<void> {
  const now = Date.now();
  await new SessionIndexStore(env.DB).create({
    id: sessionId,
    title: "Owned session",
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
  await initNamedSession(sessionId, { model: MODEL, userId: ownerUserId ?? "user-unowned" });
}

function userFetch(
  accessToken: string,
  path: string,
  init?: { method?: string; body?: string }
): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init?.body,
  });
}

/**
 * One representative of each way a user credential can reach a session: read
 * its state, read its transcript, drive it, mint the websocket credential that
 * streams it, walk its children, and remove it.
 */
function sessionRoutes(sessionId: string): ReadonlyArray<{
  name: string;
  method: string;
  path: string;
  body?: string;
}> {
  return [
    { name: "read state", method: "GET", path: `/sessions/${sessionId}` },
    { name: "read events", method: "GET", path: `/sessions/${sessionId}/events` },
    { name: "read messages", method: "GET", path: `/sessions/${sessionId}/messages` },
    { name: "read participants", method: "GET", path: `/sessions/${sessionId}/participants` },
    { name: "list children", method: "GET", path: `/sessions/${sessionId}/children` },
    { name: "read changes", method: "GET", path: `/sessions/${sessionId}/diff` },
    {
      name: "prompt",
      method: "POST",
      path: `/sessions/${sessionId}/prompt`,
      body: JSON.stringify({ content: "cat ~/.ssh/id_ed25519" }),
    },
    {
      name: "mint a websocket token",
      method: "POST",
      path: `/sessions/${sessionId}/ws-token`,
      body: JSON.stringify({}),
    },
    { name: "stop", method: "POST", path: `/sessions/${sessionId}/stop`, body: "{}" },
    {
      name: "rename",
      method: "PATCH",
      path: `/sessions/${sessionId}/title`,
      body: JSON.stringify({ title: "renamed" }),
    },
    { name: "archive", method: "POST", path: `/sessions/${sessionId}/archive`, body: "{}" },
    {
      name: "refresh pull requests",
      method: "POST",
      path: `/sessions/${sessionId}/pull-requests/refresh`,
      body: "{}",
    },
    { name: "delete", method: "DELETE", path: `/sessions/${sessionId}` },
  ];
}

describe("session ownership: another user's session", () => {
  const sessionId = "ownership-foreign-session";
  let ownerToken: string;
  let intruderToken: string;

  beforeEach(async () => {
    await cleanD1Tables();
    const owner = await createSignedInUser("100001");
    const intruder = await createSignedInUser("100002");
    ownerToken = owner.accessToken;
    intruderToken = intruder.accessToken;
    await createOwnedSession(sessionId, owner.userId);
  });

  afterEach(cleanD1Tables);

  it.each(sessionRoutes(sessionId))(
    "refuses a second signed-in user trying to $name",
    async (route) => {
      const response = await userFetch(intruderToken, route.path, {
        method: route.method,
        body: route.body,
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Session belongs to another user",
      });
    }
  );

  it("still lets the owner read the session", async () => {
    const response = await userFetch(ownerToken, `/sessions/${sessionId}`);

    expect(response.status).toBe(200);
  });

  it("still lets the owner read the transcript", async () => {
    const response = await userFetch(ownerToken, `/sessions/${sessionId}/events`);

    expect(response.status).toBe(200);
  });

  it("still lets the owner prompt", async () => {
    const response = await userFetch(ownerToken, `/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "Fix the login bug" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "queued" });
  });

  it("still lets the owner mint a websocket token", async () => {
    const response = await userFetch(ownerToken, `/sessions/${sessionId}/ws-token`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
  });

  it("refuses a session id nobody has created", async () => {
    const response = await userFetch(intruderToken, "/sessions/no-such-session");

    expect(response.status).toBe(404);
  });
});

describe("session ownership: a session with no recorded owner", () => {
  const sessionId = "ownership-unowned-session";
  let userToken: string;

  beforeEach(async () => {
    await cleanD1Tables();
    userToken = (await createSignedInUser("100003")).accessToken;
    await createOwnedSession(sessionId, null);
  });

  afterEach(cleanD1Tables);

  it("refuses every signed-in user rather than inventing an owner", async () => {
    const response = await userFetch(userToken, `/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "whoami" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Session has no recorded owner",
    });
  });
});

describe("session listing scope", () => {
  let owner: { userId: string; accessToken: string };
  let intruder: { userId: string; accessToken: string };

  beforeEach(async () => {
    await cleanD1Tables();
    owner = await createSignedInUser("100004");
    intruder = await createSignedInUser("100005");
    await createOwnedSession("ownership-list-owner", owner.userId);
    await createOwnedSession("ownership-list-intruder", intruder.userId);
  });

  afterEach(cleanD1Tables);

  it("lists only the caller's own sessions when no filter is given", async () => {
    const response = await userFetch(intruder.accessToken, "/sessions");

    expect(response.status).toBe(200);
    const body = await response.json<{ sessions: Array<{ id: string }> }>();
    expect(body.sessions.map((session) => session.id)).toEqual(["ownership-list-intruder"]);
  });

  it("refuses a listing filtered to another user", async () => {
    const response = await userFetch(intruder.accessToken, `/sessions?createdBy=${owner.userId}`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Sessions can only be listed for the authenticated user",
    });
  });
});

describe("session ownership: machine callers are unaffected", () => {
  const sandboxToken = "ownership-sandbox-token";
  // A fresh Durable Object per test: seedSandboxAuth waits for the (always
  // failing) test spawn, which a DO reused from an earlier test has already
  // passed through.
  let sessionId: string;
  let ownerUserId: string;

  beforeEach(async () => {
    await cleanD1Tables();
    sessionId = `ownership-machine-session-${crypto.randomUUID()}`;
    ownerUserId = (await createSignedInUser("100006")).userId;
    const now = Date.now();
    await new SessionIndexStore(env.DB).create({
      id: sessionId,
      title: "Machine session",
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
    const { stub } = await initNamedSession(sessionId, { model: MODEL, userId: ownerUserId });
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: "ownership-sandbox" });
  });

  afterEach(cleanD1Tables);

  it("still serves the bridge holding the session's own sandbox token", async () => {
    // The homestead and the in-sandbox bridge authenticate per session, never as a
    // user, so the ownership gate must not stand between them and their session.
    const response = await SELF.fetch(`https://test.local/sessions/${sessionId}/children`, {
      headers: { Authorization: `Bearer ${sandboxToken}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ children: [] });
  });

  it("still lets a bot prompt a session it did not sign in for", async () => {
    // Bots act for the deployment through their own service credential; they
    // hold no user token and are not owner-scoped.
    const response = await serviceFetch(`https://test.local/sessions/${sessionId}/prompt`, {
      method: "POST",
      service: "slack-bot",
      actor: "slack:U0000001",
      body: JSON.stringify({ content: "Deploy to staging" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "queued" });
  });
});
