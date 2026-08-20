import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";
import type * as WebSessionTokensModule from "./auth/web-session-tokens";

const INTERNAL_SECRET = "test-internal-callback-secret";

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
 * Env fixture for the outpost routes. `outpostFetch` stands in for the outpost
 * Durable Object and `homesteadFetch` for the homestead registry: a call that
 * reaches either one is a call that got past authentication, which is what
 * these tests are measuring.
 */
function createEnv(overrides?: {
  scmProvider?: string;
  allowLegacySharedToken?: boolean;
  legacyOutpostId?: string;
  singleUserId?: string;
}) {
  const outpostFetch = vi.fn(async () => Response.json({ ok: true }));
  const homesteadFetch = vi.fn(async () =>
    Response.json({
      connected: true,
      homesteads: [{ id: "private-homestead", harnesses: ["pi"] }],
    })
  );

  let boundValues: unknown[] = [];
  let lastQuery = "";
  // A lease is granted only when the session's owner also owns the machine, so
  // the stub has to answer both halves or the route can never be reached.
  const statement = {
    bind: vi.fn((...values: unknown[]) => {
      boundValues = values;
      return statement;
    }),
    first: vi.fn(async () => {
      if (/FROM sessions/i.test(lastQuery)) return { user_id: "owner-1" };
      if (/FROM outposts/i.test(lastQuery)) {
        return {
          id: "workstation-01",
          owner_user_id: "owner-1",
          confirmed_at: 1,
          revoked_at: null,
        };
      }
      return null;
    }),
    all: vi.fn(async () => ({
      results: overrides?.singleUserId ? [{ id: overrides.singleUserId }] : [],
    })),
    run: vi.fn(async () => ({
      meta: {
        changes: boundValues.includes(overrides?.legacyOutpostId) ? 1 : 0,
      },
    })),
  };

  const env = {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: overrides?.scmProvider ?? "github",
    INTERNAL_CALLBACK_SECRET: INTERNAL_SECRET,
    OUTPOST_ALLOW_LEGACY_SHARED_TOKEN: overrides?.allowLegacySharedToken ? "true" : undefined,
    DB: {
      prepare: vi.fn((query: string) => {
        lastQuery = query;
        return statement;
      }),
      batch: vi.fn(async () => []),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    OUTPOST: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: outpostFetch }),
    },
    HOMESTEAD: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: homesteadFetch }),
    },
  };

  return { env, outpostFetch, homesteadFetch };
}

/** Every outpost path that grants machine status, leases, or tool execution. */
const CONTROL_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/outposts/workstation-01" },
  { method: "POST", path: "/outposts/workstation-01/leases" },
  { method: "DELETE", path: "/outposts/workstation-01/leases/lease-1" },
  { method: "POST", path: "/outposts/workstation-01/leases/lease-1/renew" },
  { method: "POST", path: "/outposts/workstation-01/leases/lease-1/cancel-work" },
  { method: "POST", path: "/outposts/workstation-01/leases/lease-1/context" },
  { method: "POST", path: "/outposts/workstation-01/tool" },
  { method: "GET", path: "/homesteads" },
];

describe("outpost control routes reject every credential but the homestead's", () => {
  it.each(CONTROL_ROUTES)("rejects an unauthenticated $method $path", async (route) => {
    const { env, outpostFetch, homesteadFetch } = createEnv();

    const response = await handleRequest(
      new Request(`https://test.local${route.path}`, {
        method: route.method,
        body: route.method === "GET" ? undefined : "{}",
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(outpostFetch).not.toHaveBeenCalled();
    expect(homesteadFetch).not.toHaveBeenCalled();
  });

  it.each(CONTROL_ROUTES)(
    "rejects an otherwise-valid service credential on $method $path",
    async (route) => {
      // A signed service credential authenticates everywhere else in the
      // control plane. On these routes the branch must be exclusive: only the
      // internal credential passes, and the request never reaches a handler.
      const { env, outpostFetch, homesteadFetch } = createEnv();

      const response = await handleRequest(
        await signedServiceRequest(`https://test.local${route.path}`, {
          method: route.method,
          body: route.method === "GET" ? undefined : "{}",
        }),
        env as never
      );

      expect(response.status).toBe(401);
      expect(outpostFetch).not.toHaveBeenCalled();
      expect(homesteadFetch).not.toHaveBeenCalled();
    }
  );

  it("rejects an unrecognized bearer token on the tool route", async () => {
    const { env, outpostFetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/outposts/workstation-01/tool", {
        method: "POST",
        headers: { Authorization: "Bearer oi_at_not-a-real-token" },
        body: "{}",
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(outpostFetch).not.toHaveBeenCalled();
  });

  it.each(CONTROL_ROUTES)("admits the homestead credential on $method $path", async (route) => {
    const { env, outpostFetch, homesteadFetch } = createEnv();
    const body =
      route.method === "GET"
        ? undefined
        : JSON.stringify({ productSessionId: "session-01", workspacePath: "/workspace" });

    const response = await handleRequest(
      await signedServiceRequest(`https://test.local${route.path}`, {
        method: route.method,
        body,
        service: "homestead",
      }),
      env as never
    );

    expect(response.status).toBe(200);
    const reached = route.path === "/homesteads" ? homesteadFetch : outpostFetch;
    expect(reached).toHaveBeenCalledTimes(1);
  });
});

describe("GET /outposts stays reachable for end-user credentials", () => {
  it("rejects an unauthenticated listing", async () => {
    const { env } = createEnv();

    const response = await handleRequest(new Request("https://test.local/outposts"), env as never);

    expect(response.status).toBe(401);
  });

  it("refuses the homestead credential on the owner-facing listing", async () => {
    const { env } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/outposts", { service: "homestead" }),
      env as never
    );

    // The homestead drives machines; it does not browse someone's fleet. The
    // deployment-wide bearer this replaced could, which is the point.
    expect(response.status).toBe(403);
  });

  it("lists only the signed-in owner's fleet", async () => {
    const { env } = createEnv();

    const response = await handleRequest(userRequest("/outposts"), env as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outposts: [] });
  });

  it("refuses a service credential on the owner-facing listing", async () => {
    const { env } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/outposts"),
      env as never
    );

    expect(response.status).toBe(403);
  });
});

describe("GET /homesteads/readiness is owner-safe", () => {
  it("rejects unauthenticated requests", async () => {
    const { env, homesteadFetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/homesteads/readiness"),
      env as never
    );

    expect(response.status).toBe(401);
    expect(homesteadFetch).not.toHaveBeenCalled();
  });

  it("projects internal status down to connected only", async () => {
    const { env, homesteadFetch } = createEnv();

    const response = await handleRequest(userRequest("/homesteads/readiness"), env as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ connected: true });
    expect(homesteadFetch).toHaveBeenCalledOnce();
  });

  it("refuses service credentials on the owner-facing projection", async () => {
    const { env, homesteadFetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/homesteads/readiness", {
        service: "homestead",
      }),
      env as never
    );

    expect(response.status).toBe(403);
    expect(homesteadFetch).not.toHaveBeenCalled();
  });
});

describe("POST /outposts/:id/claim", () => {
  it("keeps legacy claiming disabled by default", async () => {
    const { env } = createEnv({
      legacyOutpostId: "legacy-workstation",
      singleUserId: "owner-1",
    });

    const response = await handleRequest(
      userRequest("/outposts/legacy-workstation/claim", "POST"),
      env as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Legacy outpost claiming is disabled",
    });
  });

  it("allows the sole deployment user to claim an old machine only when opted in", async () => {
    const { env } = createEnv({
      allowLegacySharedToken: true,
      legacyOutpostId: "legacy-workstation",
      singleUserId: "owner-1",
    });

    const response = await handleRequest(
      userRequest("/outposts/legacy-workstation/claim", "POST"),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: true,
      outpostId: "legacy-workstation",
    });
  });
});

describe("outpost paths stay SCM-agnostic", () => {
  // Guards the shared pattern list: narrowing the auth branch without
  // mirroring it into isScmAgnosticRoute 501s these routes, but only on
  // deployments with no usable source-control provider.
  it.each([...CONTROL_ROUTES, { method: "GET", path: "/outposts" }])(
    "reaches $method $path under a gitlab provider",
    async (route) => {
      const { env } = createEnv({ scmProvider: "gitlab" });

      const response = await handleRequest(
        await signedServiceRequest(`https://test.local${route.path}`, {
          method: route.method,
          body:
            route.method === "GET"
              ? undefined
              : JSON.stringify({ productSessionId: "session-01", workspacePath: "/workspace" }),
          service: "homestead",
        }),
        env as never
      );

      // The invariant is the SCM gate, not the auth outcome: a route missing
      // from isScmAgnosticRoute answers 501 on a deployment with no usable
      // source control, whatever credential reached it.
      expect(response.status).not.toBe(501);
    }
  );
});
