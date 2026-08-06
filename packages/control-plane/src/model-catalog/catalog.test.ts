import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import { MODEL_CATALOG_VERSION, type CatalogModel } from "@openoutposts/outpost-protocol";

import type { StoredHomesteadCatalog } from "../db/homestead-model-catalogs";
import {
  PRODUCT_EFFORT_TO_THINKING_LEVEL,
  HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS,
  THINKING_LEVELS_WITHOUT_PRODUCT_EFFORT,
  buildModelCatalogView,
  checkModelSelection,
  deriveReasoning,
  isEffortSupported,
  mergeHomesteadCatalogs,
  selectLiveCatalogs,
  type BuildCatalogViewInput,
  type CheckModelSelectionInput,
  type ModelCatalogView,
  type ModelSelectionOutcome,
} from "./catalog";

function model(overrides: Partial<CatalogModel> & Pick<CatalogModel, "providerId" | "id">) {
  return {
    name: overrides.id,
    reasoning: false,
    input: ["text"],
    ...overrides,
  } as CatalogModel;
}

/** Evaluation time for every liveness decision below. */
const NOW = 1_000_000;

function catalog(
  homesteadId: string,
  providers: { id: string; name: string }[],
  models: CatalogModel[],
  reportedAt = 1_000,
  liveness: Partial<Pick<StoredHomesteadCatalog, "lastSeenAt" | "disconnectedAt">> = {}
): StoredHomesteadCatalog {
  return {
    homesteadId,
    catalogVersion: MODEL_CATALOG_VERSION,
    catalogHash: `${homesteadId}-hash`,
    providers,
    models,
    reportedAt,
    // Live as of NOW unless a test says otherwise. `reportedAt` deliberately
    // stays old: a connected homestead's catalog is only rewritten when its
    // content changes, so the two must not be conflated.
    lastSeenAt: NOW,
    disconnectedAt: null,
    ...liveness,
  };
}

/** The catalog view at NOW. */
function buildView(input: Omit<BuildCatalogViewInput, "nowMs">): ModelCatalogView {
  return buildModelCatalogView({ ...input, nowMs: NOW });
}

/** A selection check at NOW. */
function checkSelection(input: Omit<CheckModelSelectionInput, "nowMs">): ModelSelectionOutcome {
  return checkModelSelection({ ...input, nowMs: NOW });
}

const ANTHROPIC = { id: "anthropic", name: "Anthropic" };
const OPENAI = { id: "openai", name: "OpenAI" };

describe("thinking-level mapping", () => {
  it("maps the product's 'none' onto the harness's 'off'", () => {
    expect(PRODUCT_EFFORT_TO_THINKING_LEVEL.none).toBe("off");
  });

  it("reports the harness levels the product cannot express", () => {
    // Pi's 'minimal' sits below the product's 'low'. It is named rather than
    // dropped so the gap is visible instead of silently unrepresented.
    expect(THINKING_LEVELS_WITHOUT_PRODUCT_EFFORT).toEqual(["minimal"]);
  });
});

describe("deriveReasoning", () => {
  it("gives no reasoning control to a model with no thinking mode", () => {
    expect(
      deriveReasoning(model({ providerId: "anthropic", id: "x", reasoning: false }), null)
    ).toBe(null);
  });

  it("treats an absent level map as 'provider default' up to 'high'", () => {
    const derived = deriveReasoning(
      model({ providerId: "anthropic", id: "claude-haiku-4-5", reasoning: true }),
      null
    );
    // 'xhigh' and 'max' are absent from a model that declares no map at all,
    // and absent means unsupported for exactly those two.
    expect(derived?.efforts).toEqual(["none", "low", "medium", "high"]);
  });

  it("refuses 'xhigh' and 'max' unless the harness names them", () => {
    // Pi's rule: for these two levels an absent key is unsupported, and Pi
    // clamps rather than refusing — so an effort offered here on the strength
    // of a missing key becomes a turn the homestead kills.
    const absent = deriveReasoning(
      model({
        providerId: "openai",
        id: "gpt-5.4",
        reasoning: true,
        thinkingLevels: { low: "low", medium: "medium", high: "high" },
      }),
      null
    );
    expect(absent?.efforts).toEqual(["none", "low", "medium", "high"]);

    const named = deriveReasoning(
      model({
        providerId: "openai",
        id: "gpt-5.4",
        reasoning: true,
        thinkingLevels: { low: "low", xhigh: "xhigh", max: "max" },
      }),
      null
    );
    expect(named?.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("drops the levels the harness explicitly marks unsupported", () => {
    const derived = deriveReasoning(
      model({
        providerId: "openai",
        id: "gpt-5.4",
        reasoning: true,
        thinkingLevels: { minimal: null, max: null, low: "low", off: null, xhigh: "xhigh" },
      }),
      null
    );
    // 'off' null removes the product's 'none'; 'max' null removes 'max';
    // 'minimal' has no product effort so removing it changes nothing; 'xhigh'
    // survives because this model names it.
    expect(derived?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keeps a supported overlay default and discards an unsupported one", () => {
    const supported = deriveReasoning(
      model({ providerId: "anthropic", id: "m", reasoning: true }),
      "high"
    );
    expect(supported?.default).toBe("high");

    const unsupported = deriveReasoning(
      model({ providerId: "anthropic", id: "m", reasoning: true, thinkingLevels: { high: null } }),
      "high"
    );
    expect(unsupported?.default).toBe(null);
    expect(unsupported?.efforts).not.toContain("high");

    // An overlay default of 'max' is the same kind of unsupported when the
    // harness never named the level.
    const unnamed = deriveReasoning(
      model({ providerId: "anthropic", id: "m", reasoning: true }),
      "max"
    );
    expect(unnamed?.default).toBe(null);
  });

  it("gives no reasoning control when every product effort is unsupported", () => {
    expect(
      deriveReasoning(
        model({
          providerId: "openai",
          id: "m",
          reasoning: true,
          thinkingLevels: { off: null, low: null, medium: null, high: null },
        }),
        null
      )
    ).toBe(null);
  });
});

describe("isEffortSupported", () => {
  it("refuses every effort for a model with no reasoning", () => {
    expect(isEffortSupported(null, "high")).toBe(false);
  });

  it("accepts only listed efforts", () => {
    const reasoning = { efforts: ["low", "high"] as const, default: null };
    expect(isEffortSupported({ efforts: [...reasoning.efforts], default: null }, "high")).toBe(
      true
    );
    expect(isEffortSupported({ efforts: [...reasoning.efforts], default: null }, "max")).toBe(
      false
    );
    expect(isEffortSupported({ efforts: [...reasoning.efforts], default: null }, undefined)).toBe(
      false
    );
  });
});

describe("mergeHomesteadCatalogs", () => {
  it("unions homesteads and lets the most recent report win a shared id", () => {
    const merged = mergeHomesteadCatalogs([
      catalog(
        "newer",
        [ANTHROPIC],
        [model({ providerId: "anthropic", id: "m", name: "New" })],
        2000
      ),
      catalog(
        "older",
        [ANTHROPIC, OPENAI],
        [
          model({ providerId: "anthropic", id: "m", name: "Old" }),
          model({ providerId: "openai", id: "g" }),
        ],
        1000
      ),
    ]);

    expect(merged.models.get("anthropic/m")?.name).toBe("New");
    // A model only the older homestead offers stays offered: during a rollover
    // the dropdown must not empty out.
    expect(merged.models.has("openai/g")).toBe(true);
    expect(merged.homesteadIds).toEqual(["newer", "older"]);
    expect(merged.reportedAt).toBe(2000);
  });
});

describe("buildModelCatalogView", () => {
  const catalogs = [
    catalog(
      "homestead-1",
      [ANTHROPIC, OPENAI],
      [
        model({
          providerId: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          reasoning: true,
        }),
        model({ providerId: "anthropic", id: "some-unlisted-model", name: "Unlisted" }),
        model({ providerId: "openai", id: "gpt-5.4", name: "GPT 5.4", reasoning: true }),
      ]
    ),
  ];

  it("reports 'unavailable' when no homestead has reported anything", () => {
    const view = buildView({ catalogs: [], connectedProviders: ["anthropic"] });
    expect(view.source).toBe("unavailable");
    expect(view.providers).toEqual([]);
    expect(view.gaps.unreachableProductModels).toEqual([]);
  });

  it("offers only the providers the user has connected", () => {
    const view = buildView({ catalogs, connectedProviders: ["anthropic"] });

    expect(view.source).toBe("homestead");
    expect(view.providers.map((provider) => provider.id)).toEqual(["anthropic"]);
    expect(view.unconnectedProviders).toEqual([{ id: "openai", name: "OpenAI", modelCount: 1 }]);
  });

  it("decorates a product-known model and still offers one the product has never named", () => {
    const view = buildView({ catalogs, connectedProviders: ["anthropic"] });
    const models = view.providers[0].models;

    const known = models.find((entry) => entry.id === "anthropic/claude-sonnet-4-6");
    expect(known?.description).toBe("Latest balanced, fast coding");
    expect(known?.inProductCatalog).toBe(true);
    expect(known?.reasoning?.default).toBe("high");

    const unknown = models.find((entry) => entry.id === "anthropic/some-unlisted-model");
    expect(unknown).toBeDefined();
    expect(unknown?.name).toBe("Unlisted");
    expect(unknown?.description).toBe(null);
    expect(unknown?.inProductCatalog).toBe(false);
    // Product-known models sort ahead of ones the overlay has never seen.
    expect(models[0].id).toBe("anthropic/claude-sonnet-4-6");
  });

  it("names the product ids no homestead offers instead of pretending they exist", () => {
    const view = buildView({ catalogs, connectedProviders: ["anthropic"] });
    expect(view.gaps.unreachableProductModels).toContain("anthropic/claude-opus-4-8");
    expect(view.gaps.unreachableProductModels).not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("declares the product metadata the harness has no equivalent for", () => {
    const view = buildView({ catalogs, connectedProviders: [] });
    expect(view.gaps.productMetadataWithoutHarnessEquivalent).toContain("description");
    expect(view.gaps.productMetadataWithoutHarnessEquivalent).toContain("defaultReasoningEffort");
    expect(view.gaps.harnessThinkingLevelsWithoutProductEffort).toEqual(["minimal"]);
  });
});

describe("checkModelSelection", () => {
  const catalogs = [
    catalog(
      "homestead-1",
      [ANTHROPIC, OPENAI],
      [
        model({ providerId: "anthropic", id: "claude-sonnet-4-6", reasoning: true }),
        model({ providerId: "openai", id: "gpt-5.4", reasoning: true }),
      ]
    ),
  ];

  it("declines to judge when the deployment has no catalog", () => {
    expect(
      checkSelection({ catalogs: [], connectedProviders: [], requested: "anything/at-all" })
    ).toEqual({ status: "unchecked", reason: "no-catalog" });
  });

  it("refuses a model no homestead offers, and says so", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["anthropic"],
      requested: "anthropic/claude-opus-5",
    });
    expect(outcome.status).toBe("unreachable");
    if (outcome.status !== "unreachable") throw new Error("expected unreachable");
    expect(outcome.error).toContain("anthropic/claude-opus-5");
    expect(outcome.error).toContain("no connected homestead offers it");
  });

  it("refuses a reachable model whose provider the user has not connected", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["anthropic"],
      requested: "openai/gpt-5.4",
    });
    expect(outcome.status).toBe("unreachable");
    if (outcome.status !== "unreachable") throw new Error("expected unreachable");
    expect(outcome.error).toContain("no credential is connected for provider 'openai'");
  });

  it("accepts a reachable model and carries its reasoning support", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["anthropic", "openai"],
      requested: "openai/gpt-5.4",
    });
    expect(outcome).toMatchObject({
      status: "reachable",
      model: "openai/gpt-5.4",
      substituted: false,
    });
    if (outcome.status !== "reachable") throw new Error("expected reachable");
    expect(outcome.reasoning?.efforts).toContain("high");
  });

  it("normalizes a bare legacy model id before checking it", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["anthropic"],
      requested: "claude-sonnet-4-6",
    });
    expect(outcome).toMatchObject({ status: "reachable", model: "anthropic/claude-sonnet-4-6" });
  });

  it("prefers the product default when nothing was requested", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["anthropic"],
      requested: null,
    });
    expect(outcome).toMatchObject({
      status: "reachable",
      model: DEFAULT_MODEL,
      substituted: false,
    });
  });

  it("substitutes, and says it substituted, when the product default is unreachable", () => {
    const outcome = checkSelection({
      catalogs,
      connectedProviders: ["openai"],
      requested: null,
    });
    expect(outcome).toMatchObject({
      status: "reachable",
      model: "openai/gpt-5.4",
      substituted: true,
    });
  });

  it("refuses when the user has connected nothing the harness supports", () => {
    const outcome = checkSelection({ catalogs, connectedProviders: [], requested: null });
    expect(outcome.status).toBe("unreachable");
    if (outcome.status !== "unreachable") throw new Error("expected unreachable");
    expect(outcome.error).toContain("connect a provider credential");
  });
});

describe("homestead catalog liveness", () => {
  const models = [model({ providerId: "anthropic", id: "claude-sonnet-4-6", reasoning: true })];

  it("keeps a homestead that heartbeated inside the window", () => {
    const live = catalog("homestead-1", [ANTHROPIC], models, 1_000, {
      lastSeenAt: NOW - HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS + 1,
    });
    expect(selectLiveCatalogs([live], NOW)).toEqual({ live: [live], staleHomesteadIds: [] });
  });

  it("retires a homestead that has not been seen for longer than the window", () => {
    const gone = catalog("homestead-1", [ANTHROPIC], models, 1_000, {
      lastSeenAt: NOW - HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS - 1,
    });
    expect(selectLiveCatalogs([gone], NOW)).toEqual({
      live: [],
      staleHomesteadIds: ["homestead-1"],
    });
  });

  it("retires a homestead that disconnected without waiting out the window", () => {
    const closed = catalog("homestead-1", [ANTHROPIC], models, 1_000, {
      lastSeenAt: NOW,
      disconnectedAt: NOW - 1,
    });
    expect(selectLiveCatalogs([closed], NOW)).toEqual({
      live: [],
      staleHomesteadIds: ["homestead-1"],
    });
  });

  it("stops offering a retired homestead's models and says which homestead went away", () => {
    const view = buildView({
      catalogs: [
        catalog("homestead-gone", [ANTHROPIC], models, 1_000, { disconnectedAt: NOW - 1 }),
        catalog("homestead-live", [OPENAI], [model({ providerId: "openai", id: "gpt-5.4" })]),
      ],
      connectedProviders: ["anthropic", "openai"],
    });

    expect(view.source).toBe("homestead");
    expect(view.staleHomesteadIds).toEqual(["homestead-gone"]);
    expect(view.providers.map((provider) => provider.id)).toEqual(["openai"]);
    expect(view.homesteadIds).toEqual(["homestead-live"]);
  });

  it("reports 'stale' rather than 'unavailable' when every homestead has gone", () => {
    // The two must stay distinguishable: 'unavailable' sends a caller back to
    // its pre-catalog behaviour, which for the model list is the hardcoded
    // default — the substitution this whole path exists to remove.
    const view = buildView({
      catalogs: [catalog("homestead-1", [ANTHROPIC], models, 1_000, { disconnectedAt: NOW - 1 })],
      connectedProviders: ["anthropic"],
    });

    expect(view.source).toBe("stale");
    expect(view.providers).toEqual([]);
    expect(view.staleHomesteadIds).toEqual(["homestead-1"]);
  });

  it("refuses a session's model when no homestead is connected, instead of declining to judge", () => {
    const outcome = checkSelection({
      catalogs: [catalog("homestead-1", [ANTHROPIC], models, 1_000, { disconnectedAt: NOW - 1 })],
      connectedProviders: ["anthropic"],
      requested: "anthropic/claude-sonnet-4-6",
    });

    expect(outcome.status).toBe("unreachable");
    if (outcome.status !== "unreachable") throw new Error("expected unreachable");
    expect(outcome.error).toContain("no homestead is currently connected");
  });

  it("still declines to judge when no homestead has ever reported anything", () => {
    expect(checkSelection({ catalogs: [], connectedProviders: [], requested: "a/b" })).toEqual({
      status: "unchecked",
      reason: "no-catalog",
    });
  });
});
