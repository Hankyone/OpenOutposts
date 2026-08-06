/**
 * The advisory directory of model catalogs reported by homesteads.
 *
 * A homestead reports the harness's own model registry when it registers (see
 * `modelCatalogSchema` in the outpost protocol). The homestead Durable Object
 * keeps that report and stays the source of truth; this table mirrors it so
 * the product can serve a model list without a Durable Object round trip and
 * while no homestead is connected — the same relationship `outposts` has with the
 * outpost Durable Object.
 *
 * Rows are keyed per homestead rather than treated as a deployment singleton.
 * There is one homestead today, but the registry is being made plural, and a
 * catalog that silently means "whatever the last homestead to connect said" is
 * the kind of thing that stays correct until the day it does not.
 */

import type { CatalogModel, CatalogProvider } from "@openoutposts/outpost-protocol";

import type { SqlDatabase } from "./sql-database";

/** One homestead's reported catalog, as stored. */
export interface StoredHomesteadCatalog {
  homesteadId: string;
  /** The payload's own version, independent of the wire protocol version. */
  catalogVersion: number;
  catalogHash: string;
  providers: CatalogProvider[];
  models: CatalogModel[];
  reportedAt: number;
  /**
   * When this deployment last heard from the homestead. Distinct from
   * `reportedAt`, which only moves when the catalog's content changes — a
   * healthy homestead can go a long time without reporting anything new.
   */
  lastSeenAt: number;
  /** Set when the homestead's connection closed; null while it is connected. */
  disconnectedAt: number | null;
}

export interface PutHomesteadCatalogInput {
  homesteadId: string;
  catalogVersion: number;
  catalogHash: string;
  providers: CatalogProvider[];
  models: CatalogModel[];
  reportedAt: number;
  connectionId: string;
}

interface CatalogRow {
  homestead_id: string;
  catalog_version: number;
  catalog_hash: string;
  providers_json: string;
  models_json: string;
  reported_at: number;
  last_seen_at: number;
  disconnected_at: number | null;
}

/**
 * A stored payload that no longer parses is treated as absent rather than
 * thrown from a read path: the catalog is advisory, the Durable Object still
 * holds the real report, and a malformed mirror must not take the model list
 * down with it.
 */
function parseArray<T>(json: string): T[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

export class HomesteadModelCatalogStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * The digest of what is currently stored for a homestead, or null when nothing
   * is. Callers compare it against a fresh report so a reconnect that carries
   * an unchanged catalog costs one read instead of a rewrite.
   */
  async getHash(homesteadId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT catalog_hash FROM homestead_model_catalogs WHERE homestead_id = ?")
      .bind(homesteadId)
      .first<{ catalog_hash: string }>();
    return row?.catalog_hash ?? null;
  }

  /** Replace a homestead's reported catalog, and mark it live as of now. */
  async put(input: PutHomesteadCatalogInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO homestead_model_catalogs (
           homestead_id, catalog_version, catalog_hash, providers_json, models_json,
           provider_count, model_count, reported_at, connection_id, last_seen_at,
           disconnected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(homestead_id) DO UPDATE SET
           catalog_version = excluded.catalog_version,
           catalog_hash = excluded.catalog_hash,
           providers_json = excluded.providers_json,
           models_json = excluded.models_json,
           provider_count = excluded.provider_count,
           model_count = excluded.model_count,
           reported_at = excluded.reported_at,
           connection_id = excluded.connection_id,
           last_seen_at = excluded.last_seen_at,
           disconnected_at = NULL`
      )
      .bind(
        input.homesteadId,
        input.catalogVersion,
        input.catalogHash,
        JSON.stringify(input.providers),
        JSON.stringify(input.models),
        input.providers.length,
        input.models.length,
        input.reportedAt,
        input.connectionId,
        input.reportedAt
      )
      .run();
  }

  /**
   * Record that a homestead is still there.
   *
   * Separate from `put` because the two answer different questions and move at
   * different rates: a catalog is rewritten only when its content changes,
   * while liveness has to keep moving for the catalog to stay offerable. A
   * homestead with no stored catalog has nothing to mark, which the `WHERE` makes
   * a no-op rather than an insert of a catalog-less row.
   */
  async markLive(homesteadId: string, connectionId: string, atMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE homestead_model_catalogs
         SET last_seen_at = ?, connection_id = ?, disconnected_at = NULL
         WHERE homestead_id = ?`
      )
      .bind(atMs, connectionId, homesteadId)
      .run();
  }

  /**
   * Record that a homestead's connection closed.
   *
   * Guarded on the connection id so a close notification that arrives after a
   * newer connection has already registered cannot retire the live one — the
   * same guard the homestead Durable Object's own table uses.
   */
  async markDisconnected(homesteadId: string, connectionId: string, atMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE homestead_model_catalogs
         SET disconnected_at = ?
         WHERE homestead_id = ? AND connection_id = ?`
      )
      .bind(atMs, homesteadId, connectionId)
      .run();
  }

  /**
   * Every reported catalog, most recently reported first.
   *
   * Stale rows are returned too. Deciding which are still live is the pure
   * layer's job (`selectLiveCatalogs` in `model-catalog/catalog.ts`), so the
   * rule is testable against literals and so a caller that only wants to
   * resolve a stored model id to a display name can still see a retired
   * homestead's entry.
   */
  async list(): Promise<StoredHomesteadCatalog[]> {
    const result = await this.db
      .prepare(
        `SELECT homestead_id, catalog_version, catalog_hash, providers_json, models_json,
                reported_at, last_seen_at, disconnected_at
         FROM homestead_model_catalogs ORDER BY reported_at DESC`
      )
      .all<CatalogRow>();

    const catalogs: StoredHomesteadCatalog[] = [];
    for (const row of result.results ?? []) {
      const providers = parseArray<CatalogProvider>(row.providers_json);
      const models = parseArray<CatalogModel>(row.models_json);
      if (!providers || !models) continue;
      catalogs.push({
        homesteadId: row.homestead_id,
        catalogVersion: row.catalog_version,
        catalogHash: row.catalog_hash,
        providers,
        models,
        reportedAt: row.reported_at,
        lastSeenAt: row.last_seen_at,
        disconnectedAt: row.disconnected_at,
      });
    }
    return catalogs;
  }
}
