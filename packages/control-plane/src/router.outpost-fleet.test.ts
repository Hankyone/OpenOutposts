import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";
import type * as WebSessionTokensModule from "./auth/web-session-tokens";

vi.mock("./auth/web-session-tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof WebSessionTokensModule>();
  return {
    ...actual,
    WebSessionTokenService: vi.fn(function () {
      return {
        verifyAccessToken: async () => ({
          ok: true,
          tokenId: "token-1",
          userId: "owner-1",
          provider: "github",
          providerUserId: "github-owner-1",
        }),
      };
    }),
  };
});

function userRequest(path: string, method = "GET"): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: { Authorization: "Bearer oi_at_owner" },
  });
}

/**
 * Env fixture for the owner-facing fleet routes.
 */
function createEnv(overrides?: { knownOutpostId?: string | null; ownerUserId?: string }) {
  const outpostFetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/status") {
      return Response.json({
        id: "workstation-01",
        name: "Studio Mac mini",
        capabilities: { platform: "darwin", architecture: "arm64", operations: [] },
        connectionId: "connection-1",
        connected: true,
        lastHeartbeatAt: "2026-08-18T22:00:00.000Z",
        activeLeases: [
          {
            leaseId: "lease-1",
            productSessionId: "session-abc",
            workspacePath: "/Users/dev/work",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      });
    }
    if (init?.method === "POST") return Response.json({ removed: true, releasedLeases: 1 });
    return new Response("Not found", { status: 404 });
  });

  const revocations: string[] = [];
  const knownOutpostId = overrides?.knownOutpostId === undefined ? null : overrides.knownOutpostId;

  const prepare = vi.fn((sql: string) => {
    const statement = {
      boundValues: [] as unknown[],
      bind(...values: unknown[]) {
        statement.boundValues = values;
        return statement;
      },
      async first() {
        if (sql.includes("FROM outposts")) {
          return statement.boundValues[0] === knownOutpostId &&
            statement.boundValues[1] === (overrides?.ownerUserId ?? "owner-1")
            ? { id: knownOutpostId, owner_user_id: overrides?.ownerUserId ?? "owner-1" }
            : null;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (sql.includes("UPDATE outposts") && sql.includes("revoked_at")) {
          revocations.push(String(statement.boundValues[3]));
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  });

  const env = {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    INTERNAL_CALLBACK_SECRET: "test-internal-callback-secret",
    DB: { prepare, batch: vi.fn(async () => []), exec: vi.fn(), dump: vi.fn() },
    OUTPOST: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: outpostFetch }),
    },
    HOMESTEAD: { idFromName: (name: string) => name, get: () => ({ fetch: vi.fn() }) },
  };

  return { env, outpostFetch, revocations };
}

describe("GET /outposts/:id/sessions", () => {
  it("rejects an unauthenticated caller", async () => {
    const { env, outpostFetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/outposts/workstation-01/sessions"),
      env as never
    );

    expect(response.status).toBe(401);
    expect(outpostFetch).not.toHaveBeenCalled();
  });

  it("reports only the lease fields, never the machine's capabilities", async () => {
    const { env } = createEnv({ knownOutpostId: "workstation-01" });

    const response = await handleRequest(
      userRequest("/outposts/workstation-01/sessions"),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      lastHeartbeatAt: "2026-08-18T22:00:00.000Z",
      sessions: [
        {
          leaseId: "lease-1",
          productSessionId: "session-abc",
          workspacePath: "/Users/dev/work",
          expiresAt: expect.any(String),
        },
      ],
    });
  });

  it("refuses a user who does not own the machine", async () => {
    const { env, outpostFetch } = createEnv({
      knownOutpostId: "workstation-01",
      ownerUserId: "someone-else",
    });

    const response = await handleRequest(
      userRequest("/outposts/workstation-01/sessions"),
      env as never
    );

    expect(response.status).toBe(404);
    expect(outpostFetch).not.toHaveBeenCalled();
  });
});

describe("DELETE /outposts/:id", () => {
  it("rejects an unauthenticated caller", async () => {
    const { env, outpostFetch, revocations } = createEnv({
      knownOutpostId: "workstation-01",
    });

    const response = await handleRequest(
      new Request("https://test.local/outposts/workstation-01", { method: "DELETE" }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(outpostFetch).not.toHaveBeenCalled();
    expect(revocations).toEqual([]);
  });

  it("releases the machine's leases before forgetting its directory row", async () => {
    const { env, outpostFetch, revocations } = createEnv({
      knownOutpostId: "workstation-01",
    });

    const response = await handleRequest(
      userRequest("/outposts/workstation-01", "DELETE"),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: true, revoked: true });
    expect(outpostFetch).toHaveBeenCalledWith(
      "http://internal/forget",
      expect.objectContaining({ method: "POST" })
    );
    expect(revocations).toEqual(["workstation-01"]);
  });

  it("404s a machine the directory does not list", async () => {
    const { env, outpostFetch, revocations } = createEnv({
      knownOutpostId: "workstation-01",
    });

    const response = await handleRequest(
      userRequest("/outposts/ghost-machine", "DELETE"),
      env as never
    );

    expect(response.status).toBe(404);
    expect(outpostFetch).not.toHaveBeenCalled();
    expect(revocations).toEqual([]);
  });

  it("refuses removal by a user who does not own the machine", async () => {
    const { env, outpostFetch, revocations } = createEnv({
      knownOutpostId: "workstation-01",
      ownerUserId: "someone-else",
    });

    const response = await handleRequest(
      userRequest("/outposts/workstation-01", "DELETE"),
      env as never
    );

    expect(response.status).toBe(404);
    expect(outpostFetch).not.toHaveBeenCalled();
    expect(revocations).toEqual([]);
  });

  it("keeps the lease and tool routes internal-only", async () => {
    // The fleet routes widen the user-facing set by exactly two entries; the
    // execution surface must not come along with them.
    const { env, outpostFetch } = createEnv();

    for (const route of [
      { method: "GET", path: "/outposts/workstation-01" },
      { method: "POST", path: "/outposts/workstation-01/leases" },
      { method: "POST", path: "/outposts/workstation-01/tool" },
    ]) {
      const response = await handleRequest(
        new Request(`https://test.local${route.path}`, {
          method: route.method,
          headers: { Authorization: "Bearer oi_at_owner" },
          body: route.method === "GET" ? undefined : "{}",
        }),
        env as never
      );

      expect(response.status).toBe(401);
    }
    expect(outpostFetch).not.toHaveBeenCalled();
  });

  it("does not let the homestead credential remove a machine", async () => {
    const { env, revocations } = createEnv({ knownOutpostId: "workstation-01" });

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/outposts/workstation-01", {
        method: "DELETE",
        service: "homestead",
      }),
      env as never
    );

    // Removing a machine is the owner's decision. The homestead drives
    // machines and never speaks for the person who enrolled one.
    expect(response.status).toBe(403);
    expect(revocations).toEqual([]);
  });
});
