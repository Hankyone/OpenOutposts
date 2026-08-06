import type { SqlDatabase } from "./sql-database";

export interface OutpostRecord {
  id: string;
  name: string;
  worker_version: string;
  platform: string;
  architecture: string;
  connected: number;
  connected_at: number;
  last_seen_at: number;
  disconnected_at: number | null;
  owner_user_id: string | null;
  owner_team_id: string | null;
  public_key: string | null;
  key_algorithm: string | null;
  key_fingerprint: string | null;
  enrolled_at: number | null;
  enrolled_by_user_id: string | null;
  confirmed_at: number | null;
  revoked_at: number | null;
  access_scope: string | null;
  workspace_roots_json: string | null;
}

export class OutpostStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(outpostId: string): Promise<OutpostRecord | null> {
    return this.db
      .prepare("SELECT * FROM outposts WHERE id = ?")
      .bind(outpostId)
      .first<OutpostRecord>();
  }

  async getOwned(outpostId: string, ownerUserId: string): Promise<OutpostRecord | null> {
    return this.db
      .prepare(
        `SELECT * FROM outposts
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`
      )
      .bind(outpostId, ownerUserId)
      .first<OutpostRecord>();
  }

  async listForOwner(ownerUserId: string): Promise<OutpostRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM outposts
         WHERE owner_user_id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL
         ORDER BY connected DESC, name`
      )
      .bind(ownerUserId)
      .all<OutpostRecord>();
    return result.results ?? [];
  }

  async listActive(): Promise<OutpostRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM outposts
         WHERE confirmed_at IS NOT NULL AND revoked_at IS NULL
         ORDER BY connected DESC, name`
      )
      .all<OutpostRecord>();
    return result.results ?? [];
  }

  async revokeOwned(outpostId: string, ownerUserId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE outposts
         SET revoked_at = ?, connected = 0, disconnected_at = ?, last_seen_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`
      )
      .bind(now, now, now, outpostId, ownerUserId)
      .run();
    return result.meta.changes === 1;
  }

  async claimLegacy(outpostId: string, ownerUserId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE outposts
         SET owner_user_id = ?,
             enrolled_by_user_id = ?,
             enrolled_at = COALESCE(enrolled_at, connected_at, ?),
             confirmed_at = COALESCE(confirmed_at, ?),
             access_scope = COALESCE(access_scope, 'full')
         WHERE id = ? AND owner_user_id IS NULL AND revoked_at IS NULL`
      )
      .bind(ownerUserId, ownerUserId, now, now, outpostId)
      .run();
    return result.meta.changes === 1;
  }
}
