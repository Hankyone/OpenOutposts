import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";

export const MODEL_CATALOG_KEY = "/api/model-catalog";

/**
 * The models this user can actually reach.
 *
 * Shape mirrors `ModelCatalogView` in the control plane
 * (`packages/control-plane/src/model-catalog/catalog.ts`), restated here
 * because the web app does not depend on that package. It is a wire contract,
 * so only the fields the UI reads are declared.
 */
/**
 * A model's reasoning support, as the harness reported it and the control
 * plane narrowed it to the product's own effort vocabulary.
 *
 * `efforts` is the whole list the model accepts, in ascending order; `default`
 * is the one to preselect, or null when nothing here has an opinion and the
 * harness and provider decide.
 */
export interface CatalogModelReasoning {
  efforts: string[];
  default: string | null;
}

export interface CatalogModel {
  /** Canonical id, `providerId/modelId` — what the session is created with. */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  description: string | null;
  /** Null when the harness reports the model has no thinking mode at all. */
  reasoning: CatalogModelReasoning | null;
  contextWindow: number | null;
  maxTokens: number | null;
  /** False for a model the harness offers that the bundled list never named. */
  inProductCatalog: boolean;
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface UnconnectedProvider {
  id: string;
  name: string;
  modelCount: number;
}

export interface ModelCatalogView {
  /**
   * `unavailable` means no homestead has ever reported a catalog to this
   * deployment; `stale` means catalogs exist but every homestead that reported one
   * has gone away, so none of their models may be offered. Neither governs this
   * list — see the fallback note below.
   */
  source: "homestead" | "stale" | "unavailable";
  reportedAt: string | null;
  /** Providers this user holds a credential for, and the models they reach. */
  providers: CatalogProvider[];
  /** Providers the harness supports that this user has not connected. */
  unconnectedProviders: UnconnectedProvider[];
}

/**
 * Read the catalog, treating any failure as "unavailable".
 *
 * A deployment with no homestead answers `source: "unavailable"` by design, and a
 * request that fails outright is indistinguishable from that to a caller: both
 * mean the catalog cannot govern this list, and the bundled model list stands.
 * Failing open matters because the alternative is an empty model picker.
 *
 * `stale` — every homestead that reported a catalog is now disconnected — falls
 * back the same way, and that is a display fallback only: session creation
 * refuses outright while no homestead is connected, naming the reason, so a model
 * picked from the bundled list here cannot quietly start a session that dies.
 */
export function useModelCatalog() {
  const { data: session } = useAuthSession();
  const { data, isLoading, error } = useSWR<ModelCatalogView>(session ? MODEL_CATALOG_KEY : null);

  const catalog = !error && data?.source === "homestead" ? data : null;

  return { catalog, loading: isLoading };
}
