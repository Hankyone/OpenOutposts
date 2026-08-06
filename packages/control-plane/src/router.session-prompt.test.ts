import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_CATALOG_VERSION } from "@openoutposts/outpost-protocol";

import { UserStore } from "./db/user-store";
import { handleRequest } from "./router";

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

// Prompts attribute to the verified principal, never a body field. Resolve
// the bearer token to a fixed user principal so the tests exercise the
// principal-derived author path through the real router.
vi.mock("./auth/web-session-tokens", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    WebSessionTokenService: vi.fn(function () {
      return {
        verifyAccessToken: async () => ({
          ok: true,
          tokenId: "token-1",
          userId: "user-1",
          provider: "github",
          providerUserId: "583231",
        }),
      };
    }),
  };
});

function userPromptRequest(body: Record<string, unknown>): Request {
  return new Request("https://test.local/sessions/session-1/prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer oi_at_test-token",
    },
    body: JSON.stringify(body),
  });
}

/**
 * A live homestead catalog for this deployment, plus the providers the reading
 * user has connected. Absent means no homestead ever reported one, which is
 * what every fixture here assumed before the catalog existed.
 */
interface CatalogFixture {
  providers: { id: string; name: string }[];
  models: Record<string, unknown>[];
  connectedProviders: string[];
}

interface SessionRowFixture {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: "running";
  parent_session_id: string | null;
  spawn_source: "user";
  spawn_depth: number;
  automation_id: string | null;
  automation_run_id: string | null;
  scm_login: string | null;
  user_id: string | null;
  total_cost: number;
  active_duration_ms: number;
  message_count: number;
  pr_count: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
}

const defaultSessionRow: SessionRowFixture = {
  id: "session-1",
  title: "Test session",
  repo_owner: null,
  repo_name: null,
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: "medium",
  base_branch: null,
  status: "running",
  parent_session_id: null,
  spawn_source: "user",
  spawn_depth: 0,
  automation_id: null,
  automation_run_id: null,
  scm_login: null,
  user_id: "user-1",
  total_cost: 0,
  active_duration_ms: 0,
  message_count: 0,
  pr_count: 0,
  environment_id: null,
  created_at: 1,
  updated_at: 1,
};

/**
 * `sessionRow` is what the `sessions` table returns for session-1 — the
 * router's ownership gate reads it before any session handler runs, so every
 * prompt fixture has to say who owns the session. "user-1" is the user the
 * mocked web session token resolves to; `null` stands for a session that does
 * not exist.
 */
function createEnv(
  sessionFetch: ReturnType<typeof vi.fn>,
  sessionRow: { user_id: string | null } | null = { user_id: "user-1" },
  catalog?: CatalogFixture,
  sessionIndexRow: SessionRowFixture | null = sessionRow === null
    ? null
    : { ...defaultSessionRow, user_id: sessionRow.user_id }
): Record<string, unknown> {
  const statement = (rows: unknown[] = [], firstRow: unknown = null) => {
    const prepared = {
      bind: vi.fn(() => prepared),
      first: vi.fn(async () => firstRow),
      all: vi.fn(async () => ({ results: rows })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    return prepared;
  };
  const catalogRows = catalog
    ? [
        {
          homestead_id: "homestead-1",
          catalog_version: MODEL_CATALOG_VERSION,
          catalog_hash: "hash-1",
          providers_json: JSON.stringify(catalog.providers),
          models_json: JSON.stringify(catalog.models),
          reported_at: Date.now(),
          last_seen_at: Date.now(),
          disconnected_at: null,
        },
      ]
    : [];
  const credentialRows = (catalog?.connectedProviders ?? []).map((provider) => ({ provider }));
  return {
    SCM_PROVIDER: "github",
    DB: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("homestead_model_catalogs")) return statement(catalogRows);
        if (sql.includes("user_provider_credentials")) return statement(credentialRows);
        if (sql.includes("SELECT user_id FROM sessions")) return statement([], sessionRow);
        if (sql.includes("SELECT * FROM sessions")) return statement([], sessionIndexRow);
        return statement();
      }),
      batch: vi.fn(async () => []),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: sessionFetch }),
    },
  };
}

describe("session prompt identity enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches a web prompt from the canonical linked GitHub identity", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
        getIdentitiesForUser: async () => [
          {
            provider: "github",
            providerUserId: "1001",
            providerLogin: "ada",
            providerEmail: "private@example.com",
          },
        ],
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        authorId: "user-1",
        scmEnrichment: {
          userId: "1001",
          login: "ada",
          name: "Trusted Ada",
          email: "1001+ada@users.noreply.github.com",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
        },
      });
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("preserves stored enrichment when the GitHub identity lookup is unavailable", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => {
          throw new Error("D1 unavailable");
        },
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("leaves stored enrichment unchanged when no linked GitHub identity exists", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => ({ id: "user-1", displayName: "Unlinked User" }),
        getIdentitiesForUser: async () => [],
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("rejects a caller-asserted authorId without forwarding to the runtime", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", authorId: "someone-else" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'authorId' is not accepted from verified callers",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});

describe("session prompt reasoning effort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UserStore).mockImplementation(function () {
      return { getUserById: async () => undefined } as never;
    });
  });

  const MODEL = "anthropic/claude-sonnet-4-6";

  /** One reachable model whose harness stops at 'high'. */
  function narrowedCatalog(): CatalogFixture {
    return {
      providers: [{ id: "anthropic", name: "Anthropic" }],
      models: [
        {
          providerId: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          reasoning: true,
          // No xhigh and no max: absent means unsupported for those two, so
          // the harness would clamp them and the homestead would kill the turn.
          thinkingLevels: { off: "off", low: "low", medium: "medium", high: "high" },
          input: ["text"],
        },
      ],
      connectedProviders: ["anthropic"],
    };
  }

  it("rejects an effort the connected homestead's catalog does not support", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", model: MODEL, reasoningEffort: "max" }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog()) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `Reasoning effort "max" is not supported by model "${MODEL}"`,
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("forwards an effort the catalog does support", async () => {
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.reasoningEffort).toBe("high");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", model: MODEL, reasoningEffort: "high" }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog()) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("accepts a prompt without a reasoning effort", async () => {
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.reasoningEffort).toBeUndefined();
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", model: MODEL }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog()) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("rejects an effort the bundled list refuses when no catalog can answer", async () => {
    // No homestead ever reported a catalog, so the hardcoded list decides —
    // exactly as session creation does on the same deployment.
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", model: MODEL, reasoningEffort: "xhigh" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `Reasoning effort "xhigh" is not supported by model "${MODEL}"`,
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("validates and forwards an effort-only override against the stored model", async () => {
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.reasoningEffort).toBe("high");
      expect(body).not.toHaveProperty("model");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", reasoningEffort: "high" }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog()) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("rejects an unsupported effort-only override for the stored model", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", reasoningEffort: "max" }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog()) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: `Reasoning effort "max" is not supported by model "${MODEL}"`,
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("returns not found when an effort-only override has no session index row", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", reasoningEffort: "high" }),
      createEnv(sessionFetch, { user_id: "user-1" }, narrowedCatalog(), null) as never
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("rejects the prompt when the requested model cannot be resolved", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const stale = narrowedCatalog();
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", model: MODEL, reasoningEffort: "xhigh" }),
      createEnv(sessionFetch, { user_id: "user-1" }, { ...stale, connectedProviders: [] }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        `Model '${MODEL}' is not available: no credential is connected for provider ` +
        "'anthropic'. Add one in settings, then try again.",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});

describe("session prompt ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a prompt to a session owned by someone else", async () => {
    // A prompt drives the outpost bash tool on the owner's machine, so this is
    // the shell-execution boundary, not just a data one.
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "cat ~/.ssh/id_ed25519" }),
      createEnv(sessionFetch, { user_id: "user-2" }) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Session belongs to another user",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("refuses a prompt to a session whose row records no owner", async () => {
    // Legacy and automation rows can carry a null owner. There is no honest
    // way to decide whether this caller is that owner, so nobody is.
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch, { user_id: null }) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Session has no recorded owner",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it("refuses a prompt to a session that does not exist", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch, null) as never
    );

    expect(response.status).toBe(404);
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});
