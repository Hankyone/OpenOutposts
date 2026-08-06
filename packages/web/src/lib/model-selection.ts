import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  normalizeModelId,
  resolveEnabledModel as resolveSharedEnabledModel,
} from "@open-inspect/shared";

import type { CatalogModelReasoning } from "@/hooks/use-model-catalog";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

/**
 * Pick the model the automation form should actually use, given a desired model
 * (a blank-create default, a saved automation's model, or a template
 * suggestion) and the user's currently enabled models.
 *
 * The form's model selector only lists enabled models, so a model the user has
 * not enabled would render an unselected control and be submitted verbatim. This
 * coerces to a model that is actually enabled, preferring the desired model,
 * then the system default, then the first enabled model. `getValidModelOrDefault`
 * also normalizes legacy/bare ids and falls back for unknown ones.
 */
export function resolveEnabledModel(model: string, enabledModels: string[]): string {
  return resolveSharedEnabledModel({ model, enabledModels, fallbackModel: DEFAULT_MODEL });
}

/**
 * Coerce a desired model onto a list the harness catalog produced.
 *
 * Catalog ids are whatever the harness reports, so they cannot be validated
 * against the bundled catalog: an id the product has never named is still a
 * perfectly reachable model. Preference order is the desired model, then the
 * bundled default if the catalog happens to offer it, then the first offering.
 */
function resolveCatalogModel(model: string, catalogModels: string[]): string {
  if (catalogModels.length === 0) return model;
  const normalized = normalizeModelId(model);
  if (catalogModels.includes(normalized)) return normalized;
  if (catalogModels.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  return catalogModels[0];
}

/**
 * The effort to keep for a model, judged by whichever list can speak for it.
 *
 * A model the harness catalog names is judged by the catalog and nothing else:
 * it reports what a turn will actually accept, where the bundled table is a
 * hand-maintained guess that drifts. A model the catalog has never heard of
 * falls to the bundled table exactly as before. The two must not be mixed —
 * checking a catalog model against the bundled list is what silently cleared a
 * perfectly valid effort, and passing a bundled-table effort the harness
 * refuses is what killed the turn at the other end.
 */
function resolveReasoningEffort(
  model: string,
  effort: string | undefined,
  reasoning: CatalogModelReasoning | null | undefined
): string | undefined {
  if (reasoning === undefined) {
    return effort && isValidReasoningEffort(model, effort)
      ? effort
      : getDefaultReasoningEffort(model);
  }
  // Null is the catalog saying this model has no thinking mode, so no effort
  // may be stored for it at all.
  if (reasoning === null) return undefined;
  if (effort && reasoning.efforts.includes(effort)) return effort;
  return reasoning.default ?? undefined;
}

/**
 * @param offeredModels - The ids the picker is showing, or undefined while
 *   they are still loading (the preference is then left as it is).
 * @param fromCatalog - True when `offeredModels` came from the harness catalog
 *   rather than the bundled enabled-model list, which changes how an id that
 *   the bundled catalog does not know is treated: reachable, not invalid.
 * @param reasoningByModel - Per-model reasoning support from the harness
 *   catalog. A model absent from it is judged by the bundled table instead.
 */
export function resolveModelPreference(
  preference: ModelPreference,
  offeredModels: string[] | undefined,
  fromCatalog = false,
  reasoningByModel?: ReadonlyMap<string, CatalogModelReasoning | null>
): ModelPreference {
  const model = offeredModels
    ? fromCatalog
      ? resolveCatalogModel(preference.model, offeredModels)
      : resolveEnabledModel(preference.model, offeredModels)
    : fromCatalog
      ? // The catalog governs but its list has not arrived: hold the model as
        // it is rather than rewrite a reachable id to the bundled default.
        normalizeModelId(preference.model)
      : getValidModelOrDefault(preference.model);
  return {
    model,
    reasoningEffort: resolveReasoningEffort(
      model,
      preference.reasoningEffort,
      reasoningByModel?.get(model)
    ),
  };
}
