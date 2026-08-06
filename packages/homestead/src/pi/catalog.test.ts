import {
  MODEL_CATALOG_VERSION,
  homesteadToControlMessageSchema,
} from "@openoutposts/outpost-protocol";
import { OUTPOST_PROTOCOL_VERSION } from "@openoutposts/outpost-protocol";
import { describe, expect, it } from "vitest";

import { buildModelCatalog, type PiModelRegistry } from "./catalog.js";

const registry: PiModelRegistry = {
  getProviders: () => [
    { id: "anthropic", name: "Anthropic" },
    { id: "opencode", name: "OpenCode Zen" },
  ],
  getModels: () => [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      provider: "anthropic",
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: undefined, max: "max" },
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ],
};

describe("buildModelCatalog", () => {
  it("reports every provider and model the harness knows", () => {
    const catalog = buildModelCatalog(registry);

    expect(catalog.catalogVersion).toBe(MODEL_CATALOG_VERSION);
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["anthropic", "opencode"]);
    expect(catalog.models.map((model) => `${model.providerId}/${model.id}`)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it("carries only the thinking levels the harness states an opinion about", () => {
    const [sonnet, haiku] = buildModelCatalog(registry).models;

    // An explicit null is "unsupported"; an absent key is "provider default".
    // Collapsing the two would strip reasoning controls from models that have
    // them, or offer a level a provider rejects mid-turn.
    expect(sonnet.thinkingLevels).toEqual({ off: null, max: "max" });
    expect(haiku.thinkingLevels).toBeUndefined();
  });

  it("produces a catalog a registration message accepts", () => {
    const parsed = homesteadToControlMessageSchema.safeParse({
      type: "homestead.register",
      protocolVersion: OUTPOST_PROTOCOL_VERSION,
      homesteadId: "homestead-01",
      homesteadVersion: "0.1.0",
      harnesses: ["pi"],
      catalog: buildModelCatalog(registry),
    });

    expect(parsed.success).toBe(true);
  });
});
