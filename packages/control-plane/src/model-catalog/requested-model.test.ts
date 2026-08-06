import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import { MODEL_CATALOG_VERSION, type CatalogModel } from "@openoutposts/outpost-protocol";

import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import type { Env } from "../types";
import { resolveReasoningEffortFor, resolveRequestedModel } from "./requested-model";

const REPORTED: CatalogModel[] = [
  {
    providerId: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text"],
  },
  {
    providerId: "anthropic",
    id: "claude-tiny-experimental",
    name: "Claude Tiny",
    reasoning: false,
    input: ["text"],
  },
];

/**
 * The two reads `ModelCatalogService` makes, answered from literals. Only the
 * table name is matched, because that is the only thing this fake needs to
 * distinguish and asserting on SQL text would break on any harmless rewrite.
 */
function fakeDb(options: {
  connectedProviders?: string[];
  models?: CatalogModel[];
  lastSeenAt?: number;
  disconnectedAt?: number | null;
  empty?: boolean;
}): SqlDatabase {
  const rows = (query: string): unknown[] => {
    if (query.includes("user_provider_credentials")) {
      return (options.connectedProviders ?? ["anthropic"]).map((provider) => ({ provider }));
    }
    if (options.empty) return [];
    return [
      {
        homestead_id: "homestead-1",
        catalog_version: MODEL_CATALOG_VERSION,
        catalog_hash: "hash",
        providers_json: JSON.stringify([{ id: "anthropic", name: "Anthropic" }]),
        models_json: JSON.stringify(options.models ?? REPORTED),
        reported_at: 1_000,
        last_seen_at: options.lastSeenAt ?? Date.now(),
        disconnected_at: options.disconnectedAt ?? null,
      },
    ];
  };

  const statement = (query: string): SqlStatement => ({
    bind: () => statement(query),
    first: async () => (rows(query)[0] ?? null) as never,
    run: async () => ({ results: [] as never[], meta: { changes: 0 } }),
    all: async () => ({ results: rows(query) as never[], meta: { changes: 0 } }),
  });

  return {
    prepare: statement,
    batch: async () => [],
  };
}

function envWith(provider: string): Env {
  return { SANDBOX_PROVIDER: provider } as unknown as Env;
}

const MANAGED = envWith("modal");
const OUTPOST = envWith("outpost");

describe("resolveRequestedModel on a managed-sandbox deployment", () => {
  const db = fakeDb({ empty: true });

  it("accepts a listed model and canonicalizes it", async () => {
    await expect(
      resolveRequestedModel({ env: MANAGED, db, userId: "u1", requested: "claude-haiku-4-5" })
    ).resolves.toMatchObject({ ok: true, model: "anthropic/claude-haiku-4-5", substituted: false });
  });

  it("refuses an unlisted model by name instead of substituting the default", async () => {
    const outcome = await resolveRequestedModel({
      env: MANAGED,
      db,
      userId: "u1",
      requested: "anthropic/not-a-real-model",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error).toContain("anthropic/not-a-real-model");
  });

  it("applies the default only when nothing was requested, and flags it", async () => {
    await expect(
      resolveRequestedModel({ env: MANAGED, db, userId: "u1", requested: null })
    ).resolves.toMatchObject({ ok: true, model: DEFAULT_MODEL, substituted: true });
  });

  it("inherits verbatim rather than re-judging a model nothing asked to change", async () => {
    // A parent session or stored automation may legitimately run a model the
    // bundled list never named; re-checking it here is what downgraded it.
    await expect(
      resolveRequestedModel({
        env: MANAGED,
        db,
        userId: "u1",
        requested: null,
        inherited: "anthropic/claude-tiny-experimental",
      })
    ).resolves.toMatchObject({
      ok: true,
      model: "anthropic/claude-tiny-experimental",
      substituted: false,
    });
  });
});

describe("resolveRequestedModel on an outpost deployment", () => {
  it("accepts a model the homestead offers and the bundled list has never named", async () => {
    await expect(
      resolveRequestedModel({
        env: OUTPOST,
        db: fakeDb({}),
        userId: "u1",
        requested: "anthropic/claude-tiny-experimental",
      })
    ).resolves.toMatchObject({
      ok: true,
      model: "anthropic/claude-tiny-experimental",
      catalogGoverned: true,
    });
  });

  it("refuses a bundled-list model no homestead offers", async () => {
    const outcome = await resolveRequestedModel({
      env: OUTPOST,
      db: fakeDb({}),
      userId: "u1",
      requested: "anthropic/claude-opus-5",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error).toContain("no connected homestead offers it");
  });

  it("refuses everything while the only homestead is disconnected", async () => {
    const outcome = await resolveRequestedModel({
      env: OUTPOST,
      db: fakeDb({ disconnectedAt: Date.now() - 1 }),
      userId: "u1",
      requested: "anthropic/claude-sonnet-4-6",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error).toContain("no homestead is currently connected");
  });

  it("falls back to the bundled list only when no homestead ever registered", async () => {
    await expect(
      resolveRequestedModel({
        env: OUTPOST,
        db: fakeDb({ empty: true }),
        userId: "u1",
        requested: "anthropic/claude-haiku-4-5",
      })
    ).resolves.toMatchObject({ ok: true, catalogGoverned: false });
  });
});

describe("resolveReasoningEffortFor", () => {
  const catalogGoverned = {
    model: "anthropic/claude-tiny-experimental",
    reasoning: { efforts: ["low", "high"] as const, default: null },
    catalogGoverned: true,
    substituted: false,
  };

  it("lets the homestead catalog decide for a catalog-resolved model", () => {
    expect(
      resolveReasoningEffortFor(
        { ...catalogGoverned, reasoning: { efforts: ["low", "high"], default: null } },
        "high"
      )
    ).toBe("high");
    expect(
      resolveReasoningEffortFor(
        { ...catalogGoverned, reasoning: { efforts: ["low"], default: null } },
        "high"
      )
    ).toBe(null);
  });

  it("lets the bundled list decide for a model it names", () => {
    const resolved = {
      model: "anthropic/claude-sonnet-4-6",
      reasoning: null,
      catalogGoverned: false,
      substituted: false,
    };
    expect(resolveReasoningEffortFor(resolved, "high")).toBe("high");
    expect(resolveReasoningEffortFor(resolved, "turbo")).toBe(null);
  });

  it("passes the effort through for a model neither list names", () => {
    // Judging it against a list that has never heard of the model is how an
    // effort the user selected got silently discarded. The harness refuses it
    // by name instead.
    expect(
      resolveReasoningEffortFor(
        {
          model: "some-provider/some-model",
          reasoning: null,
          catalogGoverned: false,
          substituted: false,
        },
        "high"
      )
    ).toBe("high");
  });
});
