/**
 * Resolving a model somebody asked for, without ever answering with a
 * different one.
 *
 * The connected homestead's harness catalog decides what exists. Until a homestead
 * has registered one there is nothing to check against, and the hardcoded list
 * in `@open-inspect/shared` answers instead. What must not vary is the failure
 * mode: an explicit choice that cannot be honoured
 * is refused by name, never rewritten to a default. `getValidModelOrDefault`
 * did the rewriting, and it did it with no log line and no user-visible trace,
 * which is how a session came to run one model while the UI showed another.
 *
 * A default is still correct in exactly one case — nobody expressed a
 * preference — and this returns it flagged as a substitution so the caller can
 * say so in its log rather than have it happen incidentally.
 */

import {
  DEFAULT_MODEL,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  VALID_MODELS,
} from "@open-inspect/shared";

import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { isEffortSupported, type ModelReasoning } from "./catalog";
import { ModelCatalogService } from "./service";

export interface ResolvedModel {
  model: string;
  /**
   * The model's reasoning support as the homestead catalog reports it, or null
   * when the catalog did not answer — either because no homestead has registered
   * one, or because the model has no thinking mode at all. `catalogGoverned`
   * tells the two apart.
   */
  reasoning: ModelReasoning | null;
  /** True when a homestead catalog decided this, rather than the hardcoded list. */
  catalogGoverned: boolean;
  /** True when nobody asked for a model and the default was applied. */
  substituted: boolean;
}

export type RequestedModelOutcome = ({ ok: true } & ResolvedModel) | { ok: false; error: string };

export interface ResolveRequestedModelInput {
  env: Env;
  db: SqlDatabase;
  /** The owner whose connected providers decide reachability, when known. */
  userId: string | null;
  /** The model that was asked for, or null when nobody asked for one. */
  requested: string | null | undefined;
  /**
   * The model to keep when nobody asked for one — a parent session's model, an
   * automation's stored model. Inherited verbatim and never re-validated: it
   * was validated when it was first chosen, and re-checking it against a list
   * that has since changed is how a child session silently downgraded to the
   * deployment default.
   */
  inherited?: string | null;
}

/** Resolve a model choice against whichever list can answer for it. */
export async function resolveRequestedModel(
  input: ResolveRequestedModelInput
): Promise<RequestedModelOutcome> {
  // A field that is absent means "no preference"; a field that is present and
  // blank is a caller bug, and answering it with an inherited or default model
  // would be the substitution this exists to remove. The two are kept apart.
  const supplied = input.requested ?? null;
  if (supplied !== null && supplied.trim() === "") {
    return {
      ok: false,
      error: `Invalid model "${supplied}": expected "provider/model-id".`,
    };
  }
  const requested = supplied === null ? null : supplied.trim();

  if (requested === null && input.inherited) {
    return {
      ok: true,
      model: input.inherited,
      reasoning: null,
      catalogGoverned: false,
      substituted: false,
    };
  }

  const outcome = await new ModelCatalogService(input.db).checkSelection(input.userId, requested);
  if (outcome.status === "unreachable") return { ok: false, error: outcome.error };
  if (outcome.status === "reachable") {
    return {
      ok: true,
      model: outcome.model,
      reasoning: outcome.reasoning,
      catalogGoverned: true,
      substituted: outcome.substituted,
    };
  }
  // `unchecked`: no homestead has ever registered a catalog here, so there is
  // nothing to check against and the hardcoded list answers below, exactly as
  // it did before the catalog existed.

  if (requested === null) {
    return {
      ok: true,
      model: DEFAULT_MODEL,
      reasoning: null,
      catalogGoverned: false,
      substituted: true,
    };
  }

  if (!isValidModel(requested)) {
    return {
      ok: false,
      error: `Invalid model "${requested}". Valid models: ${VALID_MODELS.join(", ")}`,
    };
  }

  return {
    ok: true,
    model: normalizeModelId(requested),
    reasoning: null,
    catalogGoverned: false,
    substituted: false,
  };
}

/**
 * The reasoning effort that may be stored for a resolved model, or null when
 * the request cannot be honoured.
 *
 * Three cases, and the third is the one that used to go wrong. When a homestead
 * catalog resolved the model, the catalog's own reasoning report decides. When
 * the hardcoded list knows the model, it decides. When neither knows it — a
 * model a homestead offers that this package has never named — nothing here can
 * judge the effort, so it is passed through untouched for the harness to
 * accept or refuse by name. Judging it against a list that has never heard of
 * the model would silently discard an effort the user selected.
 */
export function resolveReasoningEffortFor(
  resolved: ResolvedModel,
  effort: string | null | undefined
): string | null {
  if (effort === undefined || effort === null || effort === "") return null;
  if (resolved.catalogGoverned)
    return isEffortSupported(resolved.reasoning, effort) ? effort : null;
  if (isValidModel(resolved.model)) {
    return isValidReasoningEffort(resolved.model, effort) ? effort : null;
  }
  return effort;
}
