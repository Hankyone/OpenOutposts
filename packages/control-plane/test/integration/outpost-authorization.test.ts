import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { ApiTokenStore } from "../../src/db/api-tokens";
import { UserStore } from "../../src/db/user-store";
import { WebSessionTokenService } from "../../src/auth/web-session-tokens";
import { cleanD1Tables } from "./cleanup";
import { seedConfirmedOutpost, seedIndexedSession, serviceFetch, homesteadFetch } from "./helpers";

const OUTPOST_ID = "workstation-01";

/**
 * Mint a real web session token for a freshly created canonical user — the
 * exact credential the web BFF forwards from a signed-in browser.
 */
async function signInUser(email: string): Promise<string> {
  const user = await new UserStore(env.DB).createUser({ displayName: email, email });
  const pair = await new WebSessionTokenService(new ApiTokenStore(env.DB)).mintPair(user.id, {
    provider: "github",
    providerUserId: `github-${user.id}`,
  });
  return pair.accessToken;
}

async function seedOutpost(ownerUserId: string | null = null): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO outposts
       (id, name, worker_version, platform, architecture, connected, connected_at,
        last_seen_at, disconnected_at, owner_user_id, enrolled_at,
        enrolled_by_user_id, confirmed_at, access_scope)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, 'full')`
  )
    .bind(
      OUTPOST_ID,
      "Workstation",
      "0.1.0-test",
      "darwin",
      "arm64",
      now,
      now,
      ownerUserId,
      now,
      ownerUserId,
      now
    )
    .run();
}

/** Every outpost path that grants machine status, leases, or tool execution. */
const CONTROL_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: `/outposts/${OUTPOST_ID}` },
  { method: "POST", path: `/outposts/${OUTPOST_ID}/leases` },
  { method: "DELETE", path: `/outposts/${OUTPOST_ID}/leases/lease-1` },
  { method: "POST", path: `/outposts/${OUTPOST_ID}/leases/lease-1/renew` },
  { method: "POST", path: `/outposts/${OUTPOST_ID}/leases/lease-1/cancel-work` },
  { method: "POST", path: `/outposts/${OUTPOST_ID}/tool` },
  { method: "GET", path: "/homesteads" },
];

describe("outpost control-route authorization", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it.each(CONTROL_ROUTES)("rejects an unauthenticated $method $path", async (route) => {
    const response = await SELF.fetch(`https://test.local${route.path}`, {
      method: route.method,
      body: route.method === "GET" ? undefined : "{}",
    });

    expect(response.status).toBe(401);
  });

  it.each(CONTROL_ROUTES)("rejects a signed-in user on $method $path", async (route) => {
    // The escalation this closes: any signed-in user could take a lease on any
    // enrolled machine and run shell commands on it.
    const accessToken = await signInUser("owner@example.com");

    const response = await SELF.fetch(`https://test.local${route.path}`, {
      method: route.method,
      headers: { Authorization: `Bearer ${accessToken}` },
      body: route.method === "GET" ? undefined : "{}",
    });

    expect(response.status).toBe(401);
  });

  it.each(CONTROL_ROUTES)("rejects a service credential on $method $path", async (route) => {
    const response = await serviceFetch(`https://test.local${route.path}`, {
      method: route.method,
      body: route.method === "GET" ? undefined : "{}",
    });

    expect(response.status).toBe(401);
  });

  it("still serves the homestead registry to the internal credential", async () => {
    const response = await homesteadFetch("https://test.local/homesteads");

    expect(response.status).toBe(200);
  });

  it("still serves per-outpost status to the internal credential", async () => {
    await seedOutpost();

    const response = await homesteadFetch(`https://test.local/outposts/${OUTPOST_ID}`);

    // The DO 404s an outpost that has never connected to it. The point is the
    // status is the handler's, not the 401 the router now returns to everyone
    // else — the directory row alone does not make the DO aware of it.
    expect(response.status).toBe(404);
  });

  it("refuses a lease when the session's owner does not own the machine", async () => {
    const machine = await seedConfirmedOutpost(`someone-elses-${Date.now()}`);
    const intruder = await new UserStore(env.DB).createUser({
      displayName: "intruder",
      email: "intruder@test.local",
    });
    await seedIndexedSession("intruder-session", intruder.id);

    const response = await homesteadFetch(
      `https://test.local/outposts/${machine.outpostId}/leases`,
      {
        method: "POST",
        body: JSON.stringify({
          productSessionId: "intruder-session",
          workspacePath: "/workspace/project",
        }),
      }
    );

    // The internal credential names no person, so the grant has to be checked
    // against the session's owner. Reaching the machine at all would be shell
    // access on hardware this user does not own.
    expect(response.status).toBe(403);
  });

  it("refuses a lease for a session that does not exist", async () => {
    const machine = await seedConfirmedOutpost(`phantom-${Date.now()}`);

    const response = await homesteadFetch(
      `https://test.local/outposts/${machine.outpostId}/leases`,
      {
        method: "POST",
        body: JSON.stringify({
          productSessionId: "no-such-session",
          workspacePath: "/workspace/project",
        }),
      }
    );

    expect(response.status).toBe(403);
  });
});

describe("outpost listing for end-user credentials", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("rejects an unauthenticated listing", async () => {
    const response = await SELF.fetch("https://test.local/outposts");

    expect(response.status).toBe(401);
  });

  it("refuses the fleet listing to the homestead credential", async () => {
    await seedOutpost();

    const response = await homesteadFetch("https://test.local/outposts");

    // Browsing a fleet is the owner's business. The homestead drives machines
    // it is handed; the deployment-wide bearer this replaced could do both.
    expect(response.status).toBe(403);
  });

  it("lists the fleet for the deployment's single signed-in user", async () => {
    const accessToken = await signInUser("owner@example.com");
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("owner@example.com")
      .first<{ id: string }>();
    if (!user) throw new Error("owner missing");
    await seedOutpost(user.id);

    const response = await SELF.fetch("https://test.local/outposts", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ outposts: Array<{ id: string; connected: boolean }> }>();
    expect(body.outposts).toEqual([expect.objectContaining({ id: OUTPOST_ID, connected: true })]);
  });

  it("does not expose one user's machine to another account", async () => {
    await signInUser("owner@example.com");
    const owner = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("owner@example.com")
      .first<{ id: string }>();
    if (!owner) throw new Error("owner missing");
    await seedOutpost(owner.id);
    const intruderToken = await signInUser("intruder@example.com");

    const response = await SELF.fetch("https://test.local/outposts", {
      headers: { Authorization: `Bearer ${intruderToken}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outposts: [] });
  });
});
