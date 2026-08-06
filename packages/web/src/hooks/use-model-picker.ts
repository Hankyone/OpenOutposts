import { useMemo } from "react";
import type { ComboboxGroup } from "@/components/ui/combobox";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import {
  useModelCatalog,
  type CatalogModelReasoning,
  type CatalogProvider,
} from "@/hooks/use-model-catalog";

export interface ModelPickerState {
  /** Grouped options for the picker, in provider order. */
  items: ComboboxGroup[];
  /**
   * The ids the picker offers, for coercing a stored selection onto the list.
   * Undefined while either source is still loading, which callers read as
   * "leave the current selection alone".
   */
  offeredModels: string[] | undefined;
  /**
   * True when the harness catalog decided the list. Ids may then sit outside
   * the bundled catalog, so selection must not be validated against it.
   */
  fromCatalog: boolean;
  /**
   * The catalog answered and it offers this user nothing, which in practice
   * means no provider is connected. The picker says so and links to settings
   * rather than rendering an empty dropdown.
   */
  needsProviderConnection: boolean;
  /**
   * What each offered model supports for reasoning, keyed by model id.
   *
   * Three answers, and they are not the same. A missing key means the catalog
   * does not name that model, so the bundled table is the only thing that can
   * speak for it. A null value means the harness says the model has no
   * thinking mode, so no effort may be offered. A value is the harness's own
   * list, which is the only one that matches what a turn will accept.
   */
  reasoningByModel: ReadonlyMap<string, CatalogModelReasoning | null>;
  loading: boolean;
}

function toComboboxGroups(providers: CatalogProvider[]): ComboboxGroup[] {
  return providers.map((provider) => ({
    category: provider.name,
    options: provider.models.map((model) => ({
      value: model.id,
      label: model.name,
      description: model.description ?? undefined,
    })),
  }));
}

/**
 * What the model picker may offer.
 *
 * When a homestead has reported a catalog, that catalog is the list: the harness
 * decides which models exist and the user's connected providers decide which
 * are reachable, so the picker cannot offer something that will fail at the
 * first prompt. When no homestead has reported one — every managed-sandbox
 * deployment — the bundled list stands exactly as before.
 */
export function useModelPicker(): ModelPickerState {
  const { enabledModels, enabledModelOptions, loading: loadingEnabledModels } = useEnabledModels();
  const { catalog, loading: loadingCatalog } = useModelCatalog();

  const bundledItems = useMemo<ComboboxGroup[]>(
    () =>
      enabledModelOptions.map((group) => ({
        category: group.category,
        options: group.models.map((model) => ({
          value: model.id,
          label: model.name,
          description: model.description,
        })),
      })),
    [enabledModelOptions]
  );

  const catalogProviders = useMemo<CatalogProvider[] | null>(() => {
    if (!catalog) return null;
    // The enabled-model preference is deployment-wide and its ids come from
    // the bundled list, so it can only ever speak about models that list
    // names. A model the harness offers and the product never named is
    // therefore always offered, and the preference narrows the rest.
    const enabled = loadingEnabledModels ? null : new Set(enabledModels);
    const narrowed = catalog.providers.map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) => !enabled || !model.inProductCatalog || enabled.has(model.id)
      ),
    }));
    const keptCount = narrowed.reduce((total, provider) => total + provider.models.length, 0);
    // A preference may narrow the picker; it may never empty it. Disabling
    // every bundled model must not leave a user who has connected a provider
    // with nothing to select.
    const providers = keptCount > 0 ? narrowed : catalog.providers;
    return providers.filter((provider) => provider.models.length > 0);
  }, [catalog, enabledModels, loadingEnabledModels]);

  const loading = loadingCatalog || loadingEnabledModels;

  return useMemo<ModelPickerState>(() => {
    if (!catalogProviders) {
      return {
        items: bundledItems,
        offeredModels: loadingEnabledModels ? undefined : enabledModels,
        fromCatalog: false,
        needsProviderConnection: false,
        reasoningByModel: new Map(),
        loading,
      };
    }

    const offeredModels = catalogProviders.flatMap((provider) =>
      provider.models.map((model) => model.id)
    );
    const reasoningByModel = new Map<string, CatalogModelReasoning | null>(
      catalogProviders.flatMap((provider) =>
        provider.models.map((model) => [model.id, model.reasoning] as const)
      )
    );

    return {
      items: toComboboxGroups(catalogProviders),
      offeredModels: loading ? undefined : offeredModels,
      fromCatalog: true,
      needsProviderConnection: !loading && offeredModels.length === 0,
      reasoningByModel,
      loading,
    };
  }, [bundledItems, catalogProviders, enabledModels, loading, loadingEnabledModels]);
}
