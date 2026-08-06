/**
 * Turning a homestead's reported model catalog into what the product may offer.
 *
 * The inversion this module exists for: the hardcoded list in
 * `@open-inspect/shared` decides which models the product knows about, and
 * nothing checks that the harness can reach any of them — which is how a user
 * comes to select a model that does not exist and have a different one answer.
 * Here the harness's own registry decides what exists, the user's connected
 * providers decide what is reachable, and the product list is demoted to an
 * overlay that may add description and ordering but may never add a model.
 *
 * Everything in this file is pure. The database reads live in `service.ts`, so
 * the merge, the reasoning derivation and the ordering can be tested against
 * literals rather than through a Durable Object.
 *
 * The hardcoded list stays in place for the inherited managed-sandbox path,
 * which has no homestead and therefore no catalog. Nothing here removes it.
 */

import {
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  MODEL_REASONING_CONFIG,
  VALID_MODELS,
  normalizeModelId,
  type ReasoningEffort,
} from "@open-inspect/shared";
import {
  modelThinkingLevelSchema,
  REASONING_EFFORT_TO_THINKING_LEVEL,
  type CatalogModel,
  type CatalogProvider,
  type ModelThinkingLevel,
} from "@openoutposts/outpost-protocol";

import type { StoredHomesteadCatalog } from "../db/homestead-model-catalogs";

/**
 * The product's reasoning vocabulary expressed in the harness's.
 *
 * The two are not the same set and the record is exhaustive over the product
 * side by type, so a new product effort cannot be added without deciding what
 * it means to the harness. The harness side is checked at runtime below.
 *
 * The map itself lives in the protocol package: the homestead applies the same
 * translation when it runs a turn, and a second copy here would be a second
 * answer to the same question. The `satisfies` keeps the product's own effort
 * union authoritative — an effort added to `@open-inspect/shared` and not to
 * the protocol's map fails this file to compile.
 */
export const PRODUCT_EFFORT_TO_THINKING_LEVEL = REASONING_EFFORT_TO_THINKING_LEVEL satisfies Record<
  ReasoningEffort,
  ModelThinkingLevel
>;

/** Product efforts in ascending order; the order the UI renders them in. */
const PRODUCT_EFFORTS = Object.keys(PRODUCT_EFFORT_TO_THINKING_LEVEL) as ReasoningEffort[];

/**
 * Harness thinking levels the product has no effort for — reported rather than
 * quietly dropped, and derived from the protocol's enum so a level added by a
 * future harness shows up here instead of disappearing.
 *
 * Today this is Pi's `minimal`, which sits below the product's `low`.
 */
export const THINKING_LEVELS_WITHOUT_PRODUCT_EFFORT: ModelThinkingLevel[] = (() => {
  const mapped = new Set<string>(Object.values(PRODUCT_EFFORT_TO_THINKING_LEVEL));
  return modelThinkingLevelSchema.options.filter((level) => !mapped.has(level));
})();

/**
 * Product metadata the harness catalog has no equivalent for.
 *
 * Each of these is supplied by the overlay where the overlay knows the model
 * and is explicitly absent otherwise — a model the harness offers and the
 * product has never heard of renders with the harness's own name, a null
 * description and no default effort, rather than being hidden because the
 * product cannot describe it.
 */
export const PRODUCT_METADATA_WITHOUT_HARNESS_EQUIVALENT = [
  "description",
  "defaultReasoningEffort",
  "displayCategory",
  "enabledByDefault",
  "productDefaultModel",
];

export interface ModelReasoning {
  efforts: ReasoningEffort[];
  /**
   * The effort to preselect. Null means the harness and provider decide, which
   * is the honest answer for any model the product overlay does not know.
   */
  default: ReasoningEffort | null;
}

export interface ReachableModel {
  /** Canonical product id: `providerId/modelId`. */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  description: string | null;
  reasoning: ModelReasoning | null;
  contextWindow: number | null;
  maxTokens: number | null;
  input: ("text" | "image")[];
  /** False for a model the harness offers that the product list has never named. */
  inProductCatalog: boolean;
}

export interface ReachableProvider {
  id: string;
  name: string;
  models: ReachableModel[];
}

export interface UnconnectedProvider {
  id: string;
  name: string;
  modelCount: number;
}

export interface ModelCatalogView {
  /**
   * - `homestead`: at least one connected homestead's catalog governs this list.
   * - `stale`: catalogs exist but every homestead that reported one is gone. The
   *   list is not served from them, and this is deliberately distinct from
   *   `unavailable` so a caller cannot read "the homestead is down" as "this
   *   deployment has no homestead" and fall back to the bundled list unprompted.
   * - `unavailable`: no homestead has ever reported a catalog to this deployment.
   */
  source: "homestead" | "stale" | "unavailable";
  catalogVersion: number | null;
  reportedAt: string | null;
  homesteadIds: string[];
  /** Homesteads whose stored catalog is no longer live, and so contributes nothing. */
  staleHomesteadIds: string[];
  /** Providers this user holds a credential for, and their models. */
  providers: ReachableProvider[];
  /** Providers the harness supports that this user has not connected. */
  unconnectedProviders: UnconnectedProvider[];
  gaps: {
    productMetadataWithoutHarnessEquivalent: string[];
    harnessThinkingLevelsWithoutProductEffort: ModelThinkingLevel[];
    /** Product catalog ids no reported catalog contains. Pure drift. */
    unreachableProductModels: string[];
  };
}

interface OverlayEntry {
  description: string;
  defaultEffort: ReasoningEffort | null;
  rank: number;
}

/**
 * The product list as an overlay: description, preferred default effort and
 * display order, keyed by canonical id. It may decorate a harness model and it
 * may order one; it can never introduce one.
 */
const PRODUCT_OVERLAY: ReadonlyMap<string, OverlayEntry> = (() => {
  const overlay = new Map<string, OverlayEntry>();
  let rank = 0;
  for (const group of MODEL_OPTIONS) {
    for (const model of group.models) {
      overlay.set(model.id, {
        description: model.description,
        defaultEffort: MODEL_REASONING_CONFIG[model.id]?.default ?? null,
        rank: rank++,
      });
    }
  }
  return overlay;
})();

/** Provider display order, taken from where each provider first appears above. */
const PRODUCT_PROVIDER_RANK: ReadonlyMap<string, number> = (() => {
  const ranks = new Map<string, number>();
  for (const [id, entry] of PRODUCT_OVERLAY) {
    const providerId = id.split("/")[0];
    if (!ranks.has(providerId)) ranks.set(providerId, entry.rank);
  }
  return ranks;
})();

function catalogModelId(model: CatalogModel): string {
  return `${model.providerId}/${model.id}`;
}

/**
 * How long a homestead's catalog stays offerable after the last sign of life.
 *
 * The homestead Durable Object heartbeats every 15 seconds and refreshes the
 * directory's liveness at most once a minute, so this tolerates two missed
 * refreshes before a healthy homestead's models disappear. It is the ceiling on
 * how long a homestead that died without closing its socket keeps contributing;
 * a socket that closes cleanly is retired immediately and does not wait it out.
 */
export const HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS = 180_000;

export interface CatalogLiveness {
  live: StoredHomesteadCatalog[];
  staleHomesteadIds: string[];
}

/**
 * Split stored catalogs into the ones still worth offering and the ones whose
 * homestead is gone.
 *
 * A stored catalog is not evidence that anything can run: rows deliberately
 * outlive the connection so a retired homestead's model ids still resolve to
 * display names. Offering them is what turned a disconnected homestead into a
 * session that passed every check and then died as an unexplained spawn
 * failure, so offerability asks about the homestead, not about the row.
 */
export function selectLiveCatalogs(
  catalogs: readonly StoredHomesteadCatalog[],
  nowMs: number
): CatalogLiveness {
  const live: StoredHomesteadCatalog[] = [];
  const staleHomesteadIds: string[] = [];
  for (const catalog of catalogs) {
    const gone =
      catalog.disconnectedAt !== null ||
      catalog.lastSeenAt < nowMs - HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS;
    if (gone) staleHomesteadIds.push(catalog.homesteadId);
    else live.push(catalog);
  }
  return { live, staleHomesteadIds };
}

interface MergedCatalog {
  providers: Map<string, CatalogProvider>;
  models: Map<string, CatalogModel>;
  catalogVersion: number | null;
  reportedAt: number | null;
  homesteadIds: string[];
}

/**
 * Union the reports of every homestead.
 *
 * Callers pass catalogs most recently reported first, and the first report to
 * name an id wins. With one homestead that is simply "the current catalog"; with
 * several it means a model stays offered while any homestead still offers it,
 * which is the behaviour that keeps a rolling deploy from emptying the
 * dropdown mid-rollover.
 */
export function mergeHomesteadCatalogs(catalogs: readonly StoredHomesteadCatalog[]): MergedCatalog {
  const providers = new Map<string, CatalogProvider>();
  const models = new Map<string, CatalogModel>();
  const homesteadIds: string[] = [];
  let catalogVersion: number | null = null;
  let reportedAt: number | null = null;

  for (const catalog of catalogs) {
    homesteadIds.push(catalog.homesteadId);
    catalogVersion ??= catalog.catalogVersion;
    if (reportedAt === null || catalog.reportedAt > reportedAt) reportedAt = catalog.reportedAt;
    for (const provider of catalog.providers) {
      if (!providers.has(provider.id)) providers.set(provider.id, provider);
    }
    for (const model of catalog.models) {
      const id = catalogModelId(model);
      if (!models.has(id)) models.set(id, model);
    }
  }

  return { providers, models, catalogVersion, reportedAt, homesteadIds };
}

/**
 * Thinking levels a harness only supports when it names them outright.
 *
 * For every other level an absent key means "the provider's own default
 * applies"; for these two it means "unsupported". The asymmetry is Pi's, not
 * ours, and it is not arbitrary: these are the two levels above what a model
 * offers by default, so a model can only reach them by declaring a mapping.
 */
const LEVELS_REQUIRING_AN_EXPLICIT_MAPPING: ModelThinkingLevel[] = ["xhigh", "max"];

/**
 * Which product efforts a harness model actually accepts.
 *
 * The harness reports a sparse map in which a missing level means "the
 * provider's own default applies" and an explicit null means "unsupported".
 * Collapsing those two would either strip the reasoning control from every
 * model that carries no map at all, or offer a level the provider rejects
 * mid-turn, so the distinction is preserved rather than flattened.
 *
 * The one exception is `xhigh` and `max`, where absent also means unsupported.
 * This mirrors Pi's own `getSupportedThinkingLevels` (pi-ai `dist/models.js`)
 * and must track it: Pi silently clamps a level a model does not support, and
 * the homestead deliberately fails the turn instead rather than run at an
 * effort the user did not pick — so offering an effort Pi would clamp turns a
 * mis-derived capability into a dead turn.
 */
export function deriveReasoning(
  model: CatalogModel,
  defaultEffort: ReasoningEffort | null
): ModelReasoning | null {
  if (!model.reasoning) return null;

  const levels: Partial<Record<ModelThinkingLevel, string | null>> = model.thinkingLevels ?? {};
  const efforts = PRODUCT_EFFORTS.filter((effort) => {
    const level = PRODUCT_EFFORT_TO_THINKING_LEVEL[effort];
    if (!(level in levels)) return !LEVELS_REQUIRING_AN_EXPLICIT_MAPPING.includes(level);
    return levels[level] !== null;
  });

  if (efforts.length === 0) return null;
  return {
    efforts,
    default: defaultEffort !== null && efforts.includes(defaultEffort) ? defaultEffort : null,
  };
}

/**
 * Whether a caller-supplied reasoning effort is one the model actually accepts.
 *
 * A model with no thinking mode accepts none, which is why a null `reasoning`
 * refuses rather than waves the effort through.
 */
export function isEffortSupported(
  reasoning: ModelReasoning | null,
  effort: string | null | undefined
): boolean {
  if (!effort || !reasoning) return false;
  return (reasoning.efforts as string[]).includes(effort);
}

function toReachableModel(model: CatalogModel): ReachableModel {
  const id = catalogModelId(model);
  const overlay = PRODUCT_OVERLAY.get(id);
  return {
    id,
    providerId: model.providerId,
    modelId: model.id,
    name: model.name,
    description: overlay?.description ?? null,
    reasoning: deriveReasoning(model, overlay?.defaultEffort ?? null),
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    input: [...model.input],
    inProductCatalog: overlay !== undefined,
  };
}

function compareModels(a: ReachableModel, b: ReachableModel): number {
  const rankA = PRODUCT_OVERLAY.get(a.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  const rankB = PRODUCT_OVERLAY.get(b.id)?.rank ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return a.id.localeCompare(b.id);
}

function compareProviderIds(a: string, b: string): number {
  const rankA = PRODUCT_PROVIDER_RANK.get(a) ?? Number.MAX_SAFE_INTEGER;
  const rankB = PRODUCT_PROVIDER_RANK.get(b) ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  return a.localeCompare(b);
}

/**
 * Group a merged catalog by provider, in display order.
 *
 * A model whose provider the harness never declared still gets a group — the
 * provider list and the model list are two independent arrays on the wire, and
 * losing models because one of them was short would be a silent subtraction.
 */
function groupByProvider(merged: MergedCatalog): ReachableProvider[] {
  const grouped = new Map<string, ReachableModel[]>();
  for (const model of merged.models.values()) {
    const bucket = grouped.get(model.providerId);
    if (bucket) bucket.push(toReachableModel(model));
    else grouped.set(model.providerId, [toReachableModel(model)]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => compareProviderIds(a, b))
    .map(([providerId, models]) => ({
      id: providerId,
      name: merged.providers.get(providerId)?.name ?? providerId,
      models: models.sort(compareModels),
    }));
}

export interface BuildCatalogViewInput {
  /** Most recently reported first. Stale entries included; filtered here. */
  catalogs: readonly StoredHomesteadCatalog[];
  /** Provider slugs the reading user holds a credential for. */
  connectedProviders: readonly string[];
  /** Evaluation time, for the liveness window. */
  nowMs: number;
}

/** The model list one user may be offered. */
export function buildModelCatalogView(input: BuildCatalogViewInput): ModelCatalogView {
  const { live, staleHomesteadIds } = selectLiveCatalogs(input.catalogs, input.nowMs);
  const merged = mergeHomesteadCatalogs(live);
  const connected = new Set(input.connectedProviders);
  const grouped = groupByProvider(merged);

  const providers = grouped.filter((provider) => connected.has(provider.id));
  const unconnectedProviders = grouped
    .filter((provider) => !connected.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
    }));

  const hasCatalog = merged.models.size > 0;

  return {
    source: hasCatalog ? "homestead" : staleHomesteadIds.length > 0 ? "stale" : "unavailable",
    catalogVersion: hasCatalog ? merged.catalogVersion : null,
    reportedAt: merged.reportedAt === null ? null : new Date(merged.reportedAt).toISOString(),
    homesteadIds: merged.homesteadIds,
    staleHomesteadIds,
    providers,
    unconnectedProviders,
    gaps: {
      productMetadataWithoutHarnessEquivalent: [...PRODUCT_METADATA_WITHOUT_HARNESS_EQUIVALENT],
      harnessThinkingLevelsWithoutProductEffort: [...THINKING_LEVELS_WITHOUT_PRODUCT_EFFORT],
      unreachableProductModels: hasCatalog
        ? VALID_MODELS.filter((id) => !merged.models.has(id))
        : [],
    },
  };
}

/**
 * What happened when a requested model was checked against the catalog.
 *
 * `unchecked` is not a pass. It says the deployment has no catalog to check
 * against — no homestead has ever registered one — and the caller should keep
 * whatever behaviour it had before the catalog existed.
 */
export type ModelSelectionOutcome =
  | { status: "unchecked"; reason: "no-catalog" }
  | {
      status: "reachable";
      model: string;
      substituted: boolean;
      /**
       * The chosen model's reasoning support as the harness reports it. Null
       * means the model has no thinking mode, so no effort may be stored for
       * it — the same question the product's hardcoded config answers for the
       * managed-sandbox path, answered from the catalog instead.
       */
      reasoning: ModelReasoning | null;
    }
  | { status: "unreachable"; requested: string | null; error: string };

export interface CheckModelSelectionInput extends BuildCatalogViewInput {
  /** The model the caller asked for, or null when they expressed no preference. */
  requested: string | null;
}

/**
 * Decide whether a session may start on a model, before it starts.
 *
 * The alternative this replaces is silent substitution: today an unrecognised
 * id becomes the product default with no log line, and a recognised-but-
 * unreachable one survives all the way to the harness, where the session dies
 * on a connect timeout with no user-visible reason. Both failures are moved
 * here, where they can be spelled out to the person who chose.
 */
export function checkModelSelection(input: CheckModelSelectionInput): ModelSelectionOutcome {
  const { live, staleHomesteadIds } = selectLiveCatalogs(input.catalogs, input.nowMs);
  const merged = mergeHomesteadCatalogs(live);
  if (merged.models.size === 0) {
    // "Every homestead is gone" and "no homestead ever registered" are different
    // answers and must not collapse into one. Returning `unchecked` for the
    // first would hand the caller back to its pre-catalog behaviour — the
    // hardcoded default — which is the silent substitution this whole path
    // exists to remove, dressed up as an absent feature.
    if (staleHomesteadIds.length > 0) {
      return {
        status: "unreachable",
        requested: input.requested,
        error:
          "No model is available: no homestead is currently connected to this deployment. " +
          "Start a homestead and try again.",
      };
    }
    return { status: "unchecked", reason: "no-catalog" };
  }

  const connected = new Set(input.connectedProviders);

  if (input.requested !== null && input.requested !== "") {
    const id = normalizeModelId(input.requested);
    const model = merged.models.get(id);
    if (!model) {
      return {
        status: "unreachable",
        requested: input.requested,
        error: `Model '${id}' is not available: no connected homestead offers it.`,
      };
    }
    if (!connected.has(model.providerId)) {
      return {
        status: "unreachable",
        requested: input.requested,
        error:
          `Model '${id}' is not available: no credential is connected for provider ` +
          `'${model.providerId}'. Add one in settings, then try again.`,
      };
    }
    return {
      status: "reachable",
      model: id,
      substituted: false,
      reasoning: toReachableModel(model).reasoning,
    };
  }

  // No preference expressed. Substituting here is not a silent swap of a
  // user's choice — there was none — but it is still reported to the caller so
  // the substitution can be logged.
  const reachable = groupByProvider(merged)
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => provider.models);

  if (reachable.length === 0) {
    return {
      status: "unreachable",
      requested: null,
      error:
        "No model is available: connect a provider credential in settings before starting a session.",
    };
  }

  const preferred = reachable.find((model) => model.id === DEFAULT_MODEL);
  const chosen = preferred ?? reachable[0];
  return {
    status: "reachable",
    model: chosen.id,
    substituted: preferred === undefined,
    reasoning: chosen.reasoning,
  };
}
