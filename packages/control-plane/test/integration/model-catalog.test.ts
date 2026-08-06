/**
 * Integration tests for the homestead-reported model catalog.
 *
 * The property that carries the feature is reachability: the product may only
 * offer a model the harness reports and the reading user has a credential for.
 * That is asserted from both ends — what the endpoint serves, and what session
 * creation accepts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  MODEL_CATALOG_VERSION,
  OUTPOST_PROTOCOL_VERSION,
  type CatalogModel,
} from "@openoutposts/outpost-protocol";

import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  createSignedInUser,
  seedSessionOutpost,
  homesteadFetch,
  homesteadHeaders,
} from "./helpers";

const REPORTED_MODELS: CatalogModel[] = [
  {
    providerId: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    providerId: "anthropic",
    id: "claude-tiny-experimental",
    name: "Claude Tiny (experimental)",
    reasoning: false,
    input: ["text"],
  },
  {
    providerId: "openai",
    id: "gpt-5.4",
    name: "GPT 5.4",
    reasoning: true,
    thinkingLevels: { off: null, minimal: null },
    input: ["text"],
  },
];

interface CatalogResponse {
  source: string;
  catalogVersion: number | null;
  reportedAt: string | null;
  homesteadIds: string[];
  staleHomesteadIds: string[];
  providers: {
    id: string;
    name: string;
    models: {
      id: string;
      name: string;
      description: string | null;
      inProductCatalog: boolean;
      reasoning: { efforts: string[]; default: string | null } | null;
      contextWindow: number | null;
      maxTokens: number | null;
    }[];
  }[];
  unconnectedProviders: { id: string; name: string; modelCount: number }[];
  gaps: {
    productMetadataWithoutHarnessEquivalent: string[];
    harnessThinkingLevelsWithoutProductEffort: string[];
    unreachableProductModels: string[];
  };
}

/**
 * Sockets registerHomestead has opened for the current test. A test that fails
 * before its own close() would otherwise leak a live connection under the same
 * homestead id, and its eventual close retires the catalog the NEXT test just
 * registered — one real failure then cascades into phantom failures downstream.
 */
const openHomesteadSockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of openHomesteadSockets.splice(0)) {
    try {
      ws.close(1000, "test cleanup");
    } catch {
      // Already closed by the test itself.
    }
  }
  // Give the homestead Durable Object a turn to process the closes before the
  // next test registers under the same homestead id.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

async function registerHomestead(options?: { homesteadId?: string; models?: CatalogModel[] }) {
  const connectUrl = "https://test.local/homesteads/connect";
  const response = await SELF.fetch(connectUrl, {
    headers: { Upgrade: "websocket", ...(await homesteadHeaders("GET", connectUrl)) },
  });
  const ws = response.webSocket;
  if (!ws) throw new Error("WebSocket upgrade failed");
  ws.accept();
  openHomesteadSockets.push(ws);

  const registered = collectMessages(ws, {
    until: (message) => message.type === "homestead.registered",
  });
  ws.send(
    JSON.stringify({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId: options?.homesteadId ?? "homestead-catalog",
      homesteadVersion: "0.1.0-test",
      harnesses: ["pi"],
      catalog: {
        catalogVersion: MODEL_CATALOG_VERSION,
        providers: [
          { id: "anthropic", name: "Anthropic" },
          { id: "openai", name: "OpenAI" },
        ],
        models: options?.models ?? REPORTED_MODELS,
      },
    })
  );
  await registered;
  // The catalog is persisted after the acknowledgement is sent, so give the
  // Durable Object a turn to finish the D1 mirror before reading it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return ws;
}

function connectCredential(accessToken: string, provider: string) {
  return SELF.fetch(`https://test.local/provider-credentials/${provider}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: `sk-${provider}-integration-key` }),
  });
}

async function readCatalog(accessToken: string): Promise<CatalogResponse> {
  const response = await SELF.fetch("https://test.local/model-catalog", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(response.status).toBe(200);
  return response.json<CatalogResponse>();
}

describe("homestead model catalog", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("reports unavailable until a homestead has registered a catalog", async () => {
    const alice = await createSignedInUser("catalog-none");
    const view = await readCatalog(alice.accessToken);

    expect(view.source).toBe("unavailable");
    expect(view.providers).toEqual([]);
    expect(view.unconnectedProviders).toEqual([]);
  });

  it("stores a registered catalog and surfaces a summary on the homestead status route", async () => {
    const ws = await registerHomestead();

    const stored = await env.DB.prepare(
      "SELECT homestead_id, catalog_version, provider_count, model_count FROM homestead_model_catalogs"
    ).all<{
      homestead_id: string;
      catalog_version: number;
      provider_count: number;
      model_count: number;
    }>();
    expect(stored.results).toEqual([
      {
        homestead_id: "homestead-catalog",
        catalog_version: MODEL_CATALOG_VERSION,
        provider_count: 2,
        model_count: REPORTED_MODELS.length,
      },
    ]);

    const status = await homesteadFetch("https://test.local/homesteads");
    await expect(status.json()).resolves.toMatchObject({
      homesteads: [
        {
          id: "homestead-catalog",
          catalog: { catalogVersion: MODEL_CATALOG_VERSION, providerCount: 2, modelCount: 3 },
        },
      ],
    });

    ws.close(1000, "test complete");
  });

  it("does not rewrite the directory when a reconnect reports the same catalog", async () => {
    const first = await registerHomestead();
    const before = await env.DB.prepare(
      "SELECT reported_at, catalog_hash FROM homestead_model_catalogs WHERE homestead_id = ?"
    )
      .bind("homestead-catalog")
      .first<{ reported_at: number; catalog_hash: string }>();
    first.close(1000, "reconnecting");

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await registerHomestead();
    const after = await env.DB.prepare(
      "SELECT reported_at, catalog_hash FROM homestead_model_catalogs WHERE homestead_id = ?"
    )
      .bind("homestead-catalog")
      .first<{ reported_at: number; catalog_hash: string }>();

    expect(after?.catalog_hash).toBe(before?.catalog_hash);
    expect(after?.reported_at).toBe(before?.reported_at);

    second.close(1000, "test complete");
  });

  it("offers nothing while the user has connected no provider, and names what is available", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("catalog-unconnected");

    const view = await readCatalog(alice.accessToken);
    expect(view.source).toBe("homestead");
    expect(view.providers).toEqual([]);
    expect(view.unconnectedProviders).toEqual([
      { id: "anthropic", name: "Anthropic", modelCount: 2 },
      { id: "openai", name: "OpenAI", modelCount: 1 },
    ]);

    ws.close(1000, "test complete");
  });

  it("offers only the connected provider's models, with product metadata layered on", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("catalog-anthropic");
    expect((await connectCredential(alice.accessToken, "anthropic")).status).toBe(201);

    const view = await readCatalog(alice.accessToken);
    expect(view.providers.map((provider) => provider.id)).toEqual(["anthropic"]);
    expect(view.unconnectedProviders.map((provider) => provider.id)).toEqual(["openai"]);

    const [known, unknown] = view.providers[0].models;
    expect(known.id).toBe("anthropic/claude-sonnet-4-6");
    expect(known.description).toBe("Latest balanced, fast coding");
    expect(known.inProductCatalog).toBe(true);
    expect(known.reasoning?.default).toBe("high");
    expect(known.contextWindow).toBe(200_000);

    // A model the harness offers and the product list has never named is still
    // offered — with the harness's name, no description, and no invented
    // reasoning support.
    expect(unknown.id).toBe("anthropic/claude-tiny-experimental");
    expect(unknown.description).toBe(null);
    expect(unknown.inProductCatalog).toBe(false);
    expect(unknown.reasoning).toBe(null);

    // Product ids the harness does not know are named rather than offered.
    expect(view.gaps.unreachableProductModels).toContain("anthropic/claude-opus-4-8");
    expect(view.gaps.harnessThinkingLevelsWithoutProductEffort).toEqual(["minimal"]);

    ws.close(1000, "test complete");
  });

  it("keeps one user's reachable set out of another's", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("catalog-alice");
    const bob = await createSignedInUser("catalog-bob");
    await connectCredential(alice.accessToken, "anthropic");
    await connectCredential(bob.accessToken, "openai");

    const aliceView = await readCatalog(alice.accessToken);
    const bobView = await readCatalog(bob.accessToken);

    expect(aliceView.providers.map((provider) => provider.id)).toEqual(["anthropic"]);
    expect(bobView.providers.map((provider) => provider.id)).toEqual(["openai"]);

    // The harness explicitly marks 'off' and 'minimal' unsupported for gpt-5.4,
    // so the product's 'none' is gone. 'xhigh' and 'max' are gone too: absent
    // from a model's thinking-level map means unsupported for those two levels
    // (Pi's rule), so only the always-derivable middle band survives.
    expect(bobView.providers[0].models[0].reasoning?.efforts).toEqual(["low", "medium", "high"]);

    ws.close(1000, "test complete");
  });
});

describe("session model selection on the outpost path", () => {
  const originalBackend = env.SANDBOX_PROVIDER;

  beforeEach(async () => {
    await cleanD1Tables();
    // The catalog governs the outpost execution path only; the managed-sandbox
    // path this deployment defaults to keeps the hardcoded list.
    (env as unknown as Record<string, string | undefined>).SANDBOX_PROVIDER = "outpost";
  });
  afterEach(async () => {
    (env as unknown as Record<string, string | undefined>).SANDBOX_PROVIDER = originalBackend;
    await cleanD1Tables();
  });

  function createSession(accessToken: string, body: Record<string, unknown>) {
    return SELF.fetch("https://test.local/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("refuses a model no homestead offers, naming the model", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("select-unknown");
    await connectCredential(alice.accessToken, "anthropic");

    const response = await createSession(alice.accessToken, {
      title: "unknown model",
      model: "anthropic/claude-opus-5",
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("anthropic/claude-opus-5");
    expect(body.error).toContain("no connected homestead offers it");

    ws.close(1000, "test complete");
  });

  it("refuses a model whose provider the user has not connected, naming the provider", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("select-unconnected");
    await connectCredential(alice.accessToken, "anthropic");

    const response = await createSession(alice.accessToken, {
      title: "unconnected provider",
      model: "openai/gpt-5.4",
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("no credential is connected for provider 'openai'");

    ws.close(1000, "test complete");
  });

  it("refuses when the user has connected nothing at all", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("select-nothing");

    const response = await createSession(alice.accessToken, { title: "no credentials" });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("connect a provider credential");

    ws.close(1000, "test complete");
  });

  it("accepts a reachable model and records it on the session", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("select-reachable");
    await seedSessionOutpost(alice.userId);
    await connectCredential(alice.accessToken, "anthropic");

    const response = await createSession(alice.accessToken, {
      title: "reachable model",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
    });

    expect(response.status).toBe(201);
    const created = await response.json<{ sessionId: string }>();
    const row = await env.DB.prepare("SELECT model FROM sessions WHERE id = ?")
      .bind(created.sessionId)
      .first<{ model: string }>();
    expect(row?.model).toBe("anthropic/claude-sonnet-4-6");

    ws.close(1000, "test complete");
  });

  it("hands selection back to the bundled list when no homestead has reported a catalog", async () => {
    const alice = await createSignedInUser("select-no-catalog");
    await seedSessionOutpost(alice.userId);

    // No catalog exists, so the pre-catalog behaviour stands and the bundled
    // list is authoritative — a model it names is accepted.
    const response = await createSession(alice.accessToken, {
      title: "no catalog",
      model: "anthropic/claude-opus-5",
    });
    expect(response.status).toBe(201);
  });

  it("refuses a model neither list names even with no catalog, instead of defaulting it", async () => {
    const alice = await createSignedInUser("select-no-catalog-unknown");

    const response = await createSession(alice.accessToken, {
      title: "no catalog, unknown model",
      model: "anthropic/not-a-real-model",
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("anthropic/not-a-real-model");
  });

  it("stops offering a disconnected homestead's models and refuses sessions on them", async () => {
    const ws = await registerHomestead();
    const alice = await createSignedInUser("select-homestead-gone");
    await seedSessionOutpost(alice.userId);
    await connectCredential(alice.accessToken, "anthropic");

    // Prove the model is offered while the homestead is up, so the assertions
    // below are about the disconnect and not about the fixture.
    expect(
      (
        await createSession(alice.accessToken, {
          title: "while connected",
          model: "anthropic/claude-sonnet-4-6",
        })
      ).status
    ).toBe(201);

    ws.close(1000, "homestead going away");
    // The close handler mirrors the disconnect into D1; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const view = await readCatalog(alice.accessToken);
    expect(view.source).toBe("stale");
    expect(view.providers).toEqual([]);
    expect(view.staleHomesteadIds).toEqual(["homestead-catalog"]);

    // The stored row survives the disconnect by design — what it may no longer
    // do is be offered.
    const stored = await env.DB.prepare(
      "SELECT disconnected_at FROM homestead_model_catalogs WHERE homestead_id = ?"
    )
      .bind("homestead-catalog")
      .first<{ disconnected_at: number | null }>();
    expect(stored?.disconnected_at).toEqual(expect.any(Number));

    const response = await createSession(alice.accessToken, {
      title: "after the homestead went away",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("no homestead is currently connected");
  });

  it("offers the catalog again when the homestead comes back", async () => {
    const first = await registerHomestead();
    const alice = await createSignedInUser("select-homestead-back");
    await connectCredential(alice.accessToken, "anthropic");

    first.close(1000, "homestead restarting");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await readCatalog(alice.accessToken)).source).toBe("stale");

    // The reconnect reports an unchanged catalog, so the directory skips the
    // rewrite — liveness has to be refreshed by registration itself or the
    // catalog would stay retired behind a homestead that is demonstrably back.
    const second = await registerHomestead();
    const view = await readCatalog(alice.accessToken);
    expect(view.source).toBe("homestead");
    expect(view.staleHomesteadIds).toEqual([]);
    expect(view.providers.map((provider) => provider.id)).toEqual(["anthropic"]);

    second.close(1000, "test complete");
  });
});
