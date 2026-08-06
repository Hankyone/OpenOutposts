/**
 * The database half of the model catalog: read what homesteads reported, read
 * which providers this user connected, and hand both to the pure resolution in
 * `catalog.ts`.
 *
 * Both reads are per request and neither is cached. The catalog changes only
 * when a homestead registers and the credential list only when a user edits it,
 * so a cache would mostly serve staleness; if that changes, this is the one
 * place to add one.
 */

import { listConnectedProviders } from "../db/user-provider-credentials";
import { HomesteadModelCatalogStore } from "../db/homestead-model-catalogs";
import type { SqlDatabase } from "../db/sql-database";
import {
  buildModelCatalogView,
  checkModelSelection,
  type ModelCatalogView,
  type ModelSelectionOutcome,
} from "./catalog";

export class ModelCatalogService {
  private readonly catalogs: HomesteadModelCatalogStore;

  constructor(private readonly db: SqlDatabase) {
    this.catalogs = new HomesteadModelCatalogStore(db);
  }

  /**
   * The catalog as one user may see it.
   *
   * A caller with no resolved user gets the reported catalog with nothing
   * connected — every provider lands in `unconnectedProviders` and no model is
   * offered. That is the truthful answer rather than an error: the shape of
   * what exists is not secret, and only reachability is per user.
   */
  async viewForUser(userId: string | null): Promise<ModelCatalogView> {
    const [catalogs, connectedProviders] = await Promise.all([
      this.catalogs.list(),
      userId ? listConnectedProviders(this.db, userId) : Promise.resolve<string[]>([]),
    ]);
    return buildModelCatalogView({ catalogs, connectedProviders, nowMs: Date.now() });
  }

  /**
   * Check a model choice against what this user can actually reach.
   *
   * Returns `unchecked` when no homestead has ever reported a catalog, which is
   * every deployment before a homestead first registers. Callers keep their
   * previous behaviour in that case rather than refusing sessions on the
   * strength of an absent catalog. A deployment whose homesteads have all gone
   * away is a different answer — `unreachable`, not `unchecked` — because a
   * disconnected fleet must not read as an unconfigured one.
   */
  async checkSelection(
    userId: string | null,
    requested: string | null
  ): Promise<ModelSelectionOutcome> {
    const [catalogs, connectedProviders] = await Promise.all([
      this.catalogs.list(),
      userId ? listConnectedProviders(this.db, userId) : Promise.resolve<string[]>([]),
    ]);
    return checkModelSelection({
      catalogs,
      connectedProviders,
      requested,
      nowMs: Date.now(),
    });
  }
}
