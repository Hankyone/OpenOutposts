// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import { MODEL_PREFERENCES_KEY } from "./use-enabled-models";
import { MODEL_CATALOG_KEY, type ModelCatalogView } from "./use-model-catalog";
import { useModelPicker } from "./use-model-picker";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    data: { user: { name: "test" } },
    status: "authenticated",
  }),
}));

function catalogModel(id: string, overrides: Record<string, unknown> = {}) {
  const [providerId, modelId] = id.split("/");
  return {
    id,
    providerId,
    modelId,
    name: modelId,
    description: null,
    reasoning: null,
    contextWindow: null,
    maxTokens: null,
    inProductCatalog: false,
    ...overrides,
  };
}

function wrapper(fallback: { catalog: ModelCatalogView; enabledModels: string[] }) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            [MODEL_CATALOG_KEY]: fallback.catalog,
            [MODEL_PREFERENCES_KEY]: { enabledModels: fallback.enabledModels },
          },
          revalidateIfStale: false,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

const UNAVAILABLE: ModelCatalogView = {
  source: "unavailable",
  reportedAt: null,
  providers: [],
  unconnectedProviders: [],
};

describe("useModelPicker", () => {
  it("keeps the bundled list when no homestead has reported a catalog", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({ catalog: UNAVAILABLE, enabledModels: [DEFAULT_MODEL] }),
    });

    expect(result.current.fromCatalog).toBe(false);
    expect(result.current.needsProviderConnection).toBe(false);
    expect(result.current.offeredModels).toEqual([DEFAULT_MODEL]);
    expect(result.current.items.flatMap((group) => group.options.map((o) => o.value))).toEqual([
      DEFAULT_MODEL,
    ]);
  });

  it("offers what the catalog reports, including models the product never named", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({
        catalog: {
          source: "homestead",
          reportedAt: "2026-07-27T00:00:00.000Z",
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [
                catalogModel(DEFAULT_MODEL, { inProductCatalog: true, name: "Sonnet" }),
                catalogModel("anthropic/claude-fable-5"),
              ],
            },
          ],
          unconnectedProviders: [{ id: "openai", name: "OpenAI", modelCount: 4 }],
        },
        enabledModels: [DEFAULT_MODEL],
      }),
    });

    expect(result.current.fromCatalog).toBe(true);
    expect(result.current.offeredModels).toEqual([DEFAULT_MODEL, "anthropic/claude-fable-5"]);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].category).toBe("Anthropic");
  });

  it("lets the enabled-model preference narrow the catalog, but only the models it names", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({
        catalog: {
          source: "homestead",
          reportedAt: null,
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [
                catalogModel(DEFAULT_MODEL, { inProductCatalog: true }),
                catalogModel("anthropic/claude-opus-4-8", { inProductCatalog: true }),
                catalogModel("anthropic/claude-fable-5"),
              ],
            },
          ],
          unconnectedProviders: [],
        },
        enabledModels: [DEFAULT_MODEL],
      }),
    });

    expect(result.current.offeredModels).toEqual([DEFAULT_MODEL, "anthropic/claude-fable-5"]);
  });

  it("never lets the preference empty a catalog that has models", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({
        catalog: {
          source: "homestead",
          reportedAt: null,
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [catalogModel("anthropic/claude-opus-4-8", { inProductCatalog: true })],
            },
          ],
          unconnectedProviders: [],
        },
        // A deployment-wide preference that names none of the reachable models.
        enabledModels: [DEFAULT_MODEL],
      }),
    });

    expect(result.current.offeredModels).toEqual(["anthropic/claude-opus-4-8"]);
    expect(result.current.needsProviderConnection).toBe(false);
  });

  it("reports each catalog model's reasoning support, null included", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({
        catalog: {
          source: "homestead",
          reportedAt: null,
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [
                catalogModel(DEFAULT_MODEL, {
                  inProductCatalog: true,
                  reasoning: { efforts: ["none", "low", "high"], default: "low" },
                }),
                // A model the harness says has no thinking mode at all.
                catalogModel("anthropic/claude-fable-5", { reasoning: null }),
              ],
            },
          ],
          unconnectedProviders: [],
        },
        enabledModels: [DEFAULT_MODEL],
      }),
    });

    expect(result.current.reasoningByModel.get(DEFAULT_MODEL)).toEqual({
      efforts: ["none", "low", "high"],
      default: "low",
    });
    expect(result.current.reasoningByModel.get("anthropic/claude-fable-5")).toBe(null);
    // A model no catalog names is absent, not null: the bundled table is the
    // only thing that can answer for it.
    expect(result.current.reasoningByModel.has("anthropic/claude-opus-4-8")).toBe(false);
  });

  it("reports no catalog reasoning while the bundled list governs", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({ catalog: UNAVAILABLE, enabledModels: [DEFAULT_MODEL] }),
    });

    expect(result.current.reasoningByModel.size).toBe(0);
  });

  it("reports that a provider must be connected when the catalog offers nothing", () => {
    const { result } = renderHook(() => useModelPicker(), {
      wrapper: wrapper({
        catalog: {
          source: "homestead",
          reportedAt: null,
          providers: [],
          unconnectedProviders: [{ id: "anthropic", name: "Anthropic", modelCount: 12 }],
        },
        enabledModels: [DEFAULT_MODEL],
      }),
    });

    expect(result.current.fromCatalog).toBe(true);
    expect(result.current.needsProviderConnection).toBe(true);
    expect(result.current.items).toEqual([]);
  });
});
