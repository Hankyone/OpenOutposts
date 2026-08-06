import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIndexRoutes } from "./session-index";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const mockSessionIndexStore = {
  list: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../db/session-index", () => ({
  SessionIndexStore: vi.fn().mockImplementation(function () {
    return mockSessionIndexStore;
  }),
}));

function createCtx(principal?: RequestContext["principal"]): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
    principal,
  };
}

function userPrincipal(canonicalUserId: string): RequestContext["principal"] {
  return {
    kind: "user",
    user: {
      provider: "github",
      providerUserId: "583231",
      canonicalUserId,
      participantUserId: canonicalUserId,
    },
    tokenId: "token-1",
  };
}

/**
 * The DELETE route reaches the session's Durable Object through the runtime
 * client, so the environment has to carry a SESSION binding. `purgeResponse`
 * is what that DO answers with.
 */
const purgeCalls: string[] = [];
let purgeResponse: () => Response = () => Response.json({ purged: true });

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    SESSION: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({
        fetch: (request: Request) => {
          purgeCalls.push(`${String(id)} ${new URL(request.url).pathname}`);
          return Promise.resolve(purgeResponse());
        },
      }),
    },
  } as unknown as Env;
}

function getHandler(method: string, path: string) {
  for (const route of sessionIndexRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

async function listSessions(
  query = "",
  principal?: RequestContext["principal"]
): Promise<Response> {
  const { handler, match } = getHandler("GET", "/sessions");
  return handler(
    new Request(`https://test.local/sessions${query}`),
    createEnv(),
    match,
    createCtx(principal)
  );
}

describe("session index routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionIndexStore.list.mockResolvedValue({
      sessions: [],
      hasMore: false,
    });
  });

  it("defaults invalid pagination values before querying the store", async () => {
    const response = await listSessions("?limit=abc&offset=nope");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: [],
      limit: 50,
      offset: 0,
    });
  });

  it("clamps pagination values before querying the store", async () => {
    const response = await listSessions("?limit=500&offset=-10");

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: [],
      limit: 100,
      offset: 0,
    });
  });

  it("passes validated creator filters through to the store", async () => {
    const response = await listSessions(
      "?createdBy=0123456789abcdef0123456789abcdef&createdBy=0123456789abcdef0123456789abcdef"
    );

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith({
      status: undefined,
      excludeStatus: undefined,
      createdByUserIds: ["0123456789abcdef0123456789abcdef"],
      limit: 50,
      offset: 0,
    });
  });

  it("rejects invalid creator filters before querying the store", async () => {
    const response = await listSessions("?createdBy=me");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });
});

describe("session listing scope", () => {
  const OWNER = "0123456789abcdef0123456789abcdef";
  const OTHER = "fedcba9876543210fedcba9876543210";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionIndexStore.list.mockResolvedValue({ sessions: [], hasMore: false });
  });

  it("scopes an unfiltered user listing to the caller's own sessions", async () => {
    const response = await listSessions("", userPrincipal(OWNER));

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserIds: [OWNER] })
    );
  });

  it("keeps a user listing that asks only for its own sessions", async () => {
    const response = await listSessions(`?createdBy=${OWNER}`, userPrincipal(OWNER));

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserIds: [OWNER] })
    );
  });

  it("refuses a user listing that asks for another user's sessions", async () => {
    const response = await listSessions(`?createdBy=${OTHER}`, userPrincipal(OWNER));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Sessions can only be listed for the authenticated user",
    });
    expect(mockSessionIndexStore.list).not.toHaveBeenCalled();
  });

  it("leaves the filter untouched for a service principal", async () => {
    const response = await listSessions(`?createdBy=${OTHER}`, {
      kind: "service",
      service: "slack-bot",
      actor: null,
    });

    expect(response.status).toBe(200);
    expect(mockSessionIndexStore.list).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserIds: [OTHER] })
    );
  });
});

/**
 * Deleting erases the session's Durable Object storage as well as its index
 * row, so the order of the two steps matters: a purge that failed must leave
 * the row behind, or the delete cannot be retried and the DO is stranded with
 * nothing pointing at it.
 *
 * Ownership is not asserted here because it is not decided here — the router's
 * `authorizeSessionAccess` gate covers every path beneath `/sessions/:id`, and
 * `test/integration/session-ownership.test.ts` pins it to this route by name.
 */
describe("session deletion", () => {
  const OWNER = "0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    vi.clearAllMocks();
    purgeCalls.length = 0;
    purgeResponse = () => Response.json({ purged: true });
    mockSessionIndexStore.delete.mockResolvedValue(true);
  });

  async function deleteSession(
    sessionId = "sess-1",
    principal?: RequestContext["principal"]
  ): Promise<Response> {
    const { handler, match } = getHandler("DELETE", `/sessions/${sessionId}`);
    return handler(
      new Request(`https://test.local/sessions/${sessionId}`, { method: "DELETE" }),
      createEnv(),
      match,
      createCtx(principal)
    );
  }

  it("purges the session's storage before dropping its index row", async () => {
    const response = await deleteSession("sess-1", userPrincipal(OWNER));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "deleted", sessionId: "sess-1" });
    expect(purgeCalls).toEqual(["sess-1 /internal/purge"]);
    expect(mockSessionIndexStore.delete).toHaveBeenCalledWith("sess-1");
  });

  it("addresses the purge at the session's own durable object", async () => {
    await deleteSession("sess-other", userPrincipal(OWNER));

    expect(purgeCalls).toEqual(["sess-other /internal/purge"]);
  });

  it("keeps the index row when the purge fails, so the delete can be retried", async () => {
    purgeResponse = () => Response.json({ error: "boom" }, { status: 500 });

    const response = await deleteSession("sess-1", userPrincipal(OWNER));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Session storage purge failed" });
    expect(mockSessionIndexStore.delete).not.toHaveBeenCalled();
  });

  it("deletes for a service principal, as it always could", async () => {
    const response = await deleteSession("sess-1", {
      kind: "service",
      service: "slack-bot",
      actor: null,
    });

    expect(response.status).toBe(200);
    expect(purgeCalls).toEqual(["sess-1 /internal/purge"]);
    expect(mockSessionIndexStore.delete).toHaveBeenCalledWith("sess-1");
  });
});
