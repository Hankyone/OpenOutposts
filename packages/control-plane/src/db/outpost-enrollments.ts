import type { SqlDatabase } from "./sql-database";

export interface OutpostEnrollmentRecord {
  id: string;
  token_hash: string;
  owner_user_id: string;
  owner_team_id: string | null;
  access_scope: string;
  requested_name: string | null;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
  outpost_id: string | null;
  confirmation_code_hash: string | null;
  confirmed_at: number | null;
  cancelled_at: number | null;
}

export interface PendingMachineInput {
  outpostId: string;
  name: string;
  workerVersion: string;
  platform: string;
  architecture: string;
  publicKey: string;
  keyFingerprint: string;
  workspaceRoots: string[];
  confirmationCodeHash: string;
  now: number;
}

export class OutpostEnrollmentStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: {
    id: string;
    tokenHash: string;
    ownerUserId: string;
    requestedName: string | null;
    accessScope: string;
    issuedAt: number;
    expiresAt: number;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO outpost_enrollments (
           id, token_hash, owner_user_id, requested_name, access_scope, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.tokenHash,
        input.ownerUserId,
        input.requestedName,
        input.accessScope,
        input.issuedAt,
        input.expiresAt
      )
      .run();
  }

  async getByTokenHash(tokenHash: string): Promise<OutpostEnrollmentRecord | null> {
    return this.db
      .prepare("SELECT * FROM outpost_enrollments WHERE token_hash = ?")
      .bind(tokenHash)
      .first<OutpostEnrollmentRecord>();
  }

  async getOwned(id: string, ownerUserId: string): Promise<OutpostEnrollmentRecord | null> {
    return this.db
      .prepare("SELECT * FROM outpost_enrollments WHERE id = ? AND owner_user_id = ?")
      .bind(id, ownerUserId)
      .first<OutpostEnrollmentRecord>();
  }

  /**
   * Atomically consumes one enrollment and creates its pending machine row.
   *
   * The insert reads only an eligible enrollment, then the guarded update
   * consumes it in the same D1 batch. D1 serializes batches, so a concurrent
   * consumer sees the committed consumed row and changes neither table.
   */
  async consume(
    enrollment: OutpostEnrollmentRecord,
    machine: PendingMachineInput
  ): Promise<boolean> {
    const [outpostResult, consumeResult] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO outposts (
             id, name, worker_version, platform, architecture, connected,
             connected_at, last_seen_at, disconnected_at, owner_user_id,
             owner_team_id, public_key, key_algorithm, key_fingerprint,
             enrolled_at, enrolled_by_user_id, confirmed_at, revoked_at,
             access_scope, workspace_roots_json
           )
           SELECT ?, ?, ?, ?, ?, 0, ?, ?, NULL, owner_user_id, owner_team_id,
                  ?, 'ed25519', ?, ?, owner_user_id, NULL, NULL, access_scope, ?
           FROM outpost_enrollments
           WHERE id = ? AND token_hash = ? AND consumed_at IS NULL
             AND cancelled_at IS NULL AND expires_at > ?`
        )
        .bind(
          machine.outpostId,
          machine.name,
          machine.workerVersion,
          machine.platform,
          machine.architecture,
          machine.now,
          machine.now,
          machine.publicKey,
          machine.keyFingerprint,
          machine.now,
          JSON.stringify(machine.workspaceRoots),
          enrollment.id,
          enrollment.token_hash,
          machine.now
        ),
      this.db
        .prepare(
          `UPDATE outpost_enrollments
           SET consumed_at = ?, outpost_id = ?, confirmation_code_hash = ?
           WHERE id = ? AND token_hash = ? AND consumed_at IS NULL
             AND cancelled_at IS NULL AND expires_at > ?`
        )
        .bind(
          machine.now,
          machine.outpostId,
          machine.confirmationCodeHash,
          enrollment.id,
          enrollment.token_hash,
          machine.now
        ),
    ]);
    return outpostResult.meta.changes === 1 && consumeResult.meta.changes === 1;
  }

  async confirm(input: {
    enrollmentId: string;
    ownerUserId: string;
    confirmationCodeHash: string;
    now: number;
  }): Promise<string | null> {
    const enrollment = await this.getOwned(input.enrollmentId, input.ownerUserId);
    if (
      !enrollment?.outpost_id ||
      enrollment.confirmation_code_hash !== input.confirmationCodeHash ||
      enrollment.confirmed_at !== null ||
      enrollment.cancelled_at !== null ||
      enrollment.expires_at <= input.now
    ) {
      return null;
    }

    const [confirmResult, outpostResult] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE outpost_enrollments
           SET confirmed_at = ?
           WHERE id = ? AND owner_user_id = ? AND confirmation_code_hash = ?
             AND confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM outposts
               WHERE id = outpost_enrollments.outpost_id
                 AND owner_user_id = ? AND confirmed_at IS NULL AND revoked_at IS NULL
             )`
        )
        .bind(
          input.now,
          input.enrollmentId,
          input.ownerUserId,
          input.confirmationCodeHash,
          input.now,
          input.ownerUserId
        ),
      this.db
        .prepare(
          `UPDATE outposts
           SET confirmed_at = ?
           WHERE id = ? AND owner_user_id = ? AND confirmed_at IS NULL AND revoked_at IS NULL`
        )
        .bind(input.now, enrollment.outpost_id, input.ownerUserId),
    ]);
    return confirmResult.meta.changes === 1 && outpostResult.meta.changes === 1
      ? enrollment.outpost_id
      : null;
  }
}
