/**
 * The deployment's append-only audit record.
 *
 * Two records exist in this product and they are not the same thing. Session
 * history is product data a user may delete. This is security metadata: who was
 * granted authority over which machine, who exercised it, and whose credentials
 * changed. It has to outlive the session it describes, which is why it is a D1
 * table of its own rather than session-scoped Durable Object state.
 *
 * **It records identity and action, never content.** No prompt, no model
 * output, no command line, no file path, no tool input or result. That is not a
 * convention this module asks callers to respect — there is no field to put
 * content in. Every caller-supplied string is either drawn from a closed
 * vocabulary declared below or validated as an identifier, and an identifier is
 * something prose fails to be. Keeping content out is what makes a store with
 * no delete path safe: an audit row can never become the reason a secret
 * someone pasted into a prompt is retained forever.
 *
 * **Append-only, twice over.** This module has an insert path and read paths.
 * There is no update method, no delete method, and no SQL in this file that
 * could become one. Migration 0049 backs that with `BEFORE UPDATE` and
 * `BEFORE DELETE` triggers that abort, so a future writer that forgets — or a
 * hand-typed statement at a SQL console — fails rather than rewrites history.
 * Retention is deliberately unimplemented for the same reason; see the
 * migration.
 *
 * Attribution never comes from the caller's assertion. `actorFromPrincipal`
 * reads the router's already-verified principal, and machine-driven writes
 * carry the user the authority descends from — the session's owner, resolved
 * from the session row — or record its absence explicitly.
 */

import type { ServiceName } from "@open-inspect/shared";

import { generateId } from "../auth/crypto";
import type { Principal } from "../auth/principal";
import type { Logger } from "../logger";
import type { SqlDatabase } from "./sql-database";

/**
 * Everything the record can say happened.
 *
 * Deliberately small, and deliberately reusing the structured-log event names
 * the deployment already emits (`lease.granted`, `outpost.removed`) so a log
 * line and an audit row about the same event are recognisably the same event.
 */
export const AUDIT_ACTIONS = [
  /** A machine appeared in the fleet for the first time under this identity. */
  "outpost.enrolled",
  /** A machine was dropped from the fleet. */
  "outpost.removed",
  /** A product session was bound to a machine: the grant of execution authority. */
  "lease.granted",
  /** A lease was asked for and not given. */
  "lease.rejected",
  /** An existing grant's expiry was pushed out. */
  "lease.renewed",
  /** A grant ended. */
  "lease.released",
  /** One bounded operation executed on a machine under a lease. */
  "outpost.tool_call",
  /** The fixed agent-instruction hierarchy was read at harness startup. */
  "outpost.context_read",
  /**
   * A connection claimed a homestead id another live connection already held, and
   * was refused. Recorded because taking over an identity is how one process
   * would inherit another's session assignments.
   */
  "homestead.identity_refused",
  /** A user added a provider credential to their vault. */
  "credential.created",
  /** A user overwrote an existing provider credential. */
  "credential.replaced",
  /** A user removed a provider credential. */
  "credential.deleted",
  /** A session was handed its owner's provider credential. */
  "credential.issued",
  /** A session asked for a provider credential and was refused. */
  "credential.issue_denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = ["success", "denied", "failure"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * How the acting identity reached the control plane.
 *
 * `internal` is the deployment-wide bearer the central homestead still
 * carries (roadmap 4.4 replaces it with a per-homestead signed credential). It is
 * named apart from `service` precisely because it proves possession of a shared
 * secret rather than a service identity — recording it as a named service would
 * assert more than was verified.
 */
export const AUDIT_ACTOR_KINDS = [
  "user",
  "service",
  "internal",
  "sandbox",
  "outpost",
  "system",
] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** The kind of thing an action names, when it names something. */
export const AUDIT_OBJECT_KINDS = [
  /** One of the seven bounded worker operations; the id is the operation name. */
  "outpost_operation",
  /** The fixed AGENTS.md/CLAUDE.md hierarchy read at harness startup. */
  "outpost_context",
  /** A vault entry; the id is the provider slug, which is unique per owner. */
  "provider_credential",
  /** A central homestead service; the id is the homestead id it claimed. */
  "homestead",
] as const;
export type AuditObjectKind = (typeof AUDIT_OBJECT_KINDS)[number];

/**
 * Why an action ended the way it did — a closed vocabulary, never a message.
 *
 * A worker's or a provider's own error text is free-form, caller-influenced,
 * and occasionally quotes the input that failed; it is a content channel and
 * stays in the structured logs. What lands here is the classification.
 */
export const AUDIT_REASONS = [
  // Lease release reasons, mirroring the protocol's release vocabulary.
  "completed",
  "expired",
  "moved",
  "cancelled",
  // Why a lease was not granted.
  "worker_refused",
  "offer_timeout",
  "outpost_disconnected",
  // Tool-call failures, mirroring the protocol's tool error codes.
  "lease_unknown",
  "lease_expired",
  "operation_unsupported",
  "invalid_input",
  "path_outside_workspace",
  "execution_error",
  "timeout",
  // Why a credential was not issued.
  "session_unowned",
  "no_credential",
  "unsupported_kind",
  "credential_unusable",
  "oauth_grant_invalid",
  "provider_unavailable",
  "storage_unavailable",
  "invalid_request",
] as const;
export type AuditReason = (typeof AUDIT_REASONS)[number];

/**
 * The identity an action is attributable to.
 *
 * `userId` is the person, `kind` is how the request arrived. They are separate
 * because the two most security-relevant actions in this product — a shell
 * command on a machine, and a credential handed to a harness — arrive as a
 * machine credential acting for a person.
 */
export interface AuditActor {
  kind: AuditActorKind;
  /** Canonical `users.id`, or null when the control plane cannot resolve one. */
  userId?: string | null;
  /** Service name, set only for `service` actors. */
  service?: ServiceName | null;
}

/** The thing an action names, when it names one. */
export interface AuditObject {
  kind: AuditObjectKind;
  id: string;
}

export interface AuditRecordInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actor: AuditActor;
  sessionId?: string | null;
  outpostId?: string | null;
  leaseId?: string | null;
  object?: AuditObject | null;
  reason?: AuditReason | null;
  /** Wall-clock duration of the audited action. Bounded number, never a payload size. */
  durationMs?: number | null;
  requestId?: string | null;
  traceId?: string | null;
  /** Overridable only so tests can pin time; production always takes the default. */
  occurredAt?: number;
}

/** A row as read back. Identical in shape to what was written. */
export interface AuditRecord {
  id: string;
  occurredAt: number;
  action: AuditAction;
  outcome: AuditOutcome;
  actorKind: AuditActorKind;
  actorUserId: string | null;
  actorService: string | null;
  sessionId: string | null;
  outpostId: string | null;
  leaseId: string | null;
  objectKind: string | null;
  objectId: string | null;
  reason: string | null;
  durationMs: number | null;
  requestId: string | null;
  traceId: string | null;
}

/** Raised when a write would put something that is not an identifier in a column. */
export class AuditLogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogValidationError";
  }
}

/**
 * The one shape a caller-supplied string may take: an identifier.
 *
 * Session ids, outpost ids, lease UUIDs, canonical user ids, provider slugs and
 * operation names all satisfy it. Prompt text, a command line, a diagnostic
 * message and a file path do not — they carry spaces, newlines, quotes or a
 * leading separator. This is the runtime half of "no content field": the
 * columns are typed as identifiers, so content cannot be spelled in them even
 * by a caller that wants to.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/** Matches the per-column CHECK ceilings in migration 0049. */
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_CORRELATION_ID_LENGTH = 64;

function assertIdentifier(
  value: string | null | undefined,
  field: string,
  maxLength = MAX_IDENTIFIER_LENGTH
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new AuditLogValidationError(`Audit field '${field}' must be a string`);
  }
  if (value.length === 0) {
    // An empty string is not an identifier, and writing one would record a
    // subject that looks present and names nothing.
    throw new AuditLogValidationError(`Audit field '${field}' must not be empty`);
  }
  if (value.length > maxLength) {
    throw new AuditLogValidationError(
      `Audit field '${field}' must be at most ${maxLength} characters`
    );
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new AuditLogValidationError(
      `Audit field '${field}' must be an identifier; the audit log records identities and actions, never content`
    );
  }
  return value;
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AuditLogValidationError(
      `Audit field '${field}' must be one of: ${allowed.join(", ")}`
    );
  }
  return value as T;
}

function assertDurationMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AuditLogValidationError("Audit field 'durationMs' must be a non-negative number");
  }
  return Math.round(value);
}

/**
 * The actor behind a request, read off the principal the router already
 * verified.
 *
 * A sandbox principal is a session's own token: it acts for the session, and
 * the person it is attributable to is the session's owner, which the caller
 * passes in from the session row rather than from anything the request said.
 */
export function actorFromPrincipal(
  principal: Principal | undefined,
  ownerUserId?: string | null
): AuditActor {
  switch (principal?.kind) {
    case "user":
      return { kind: "user", userId: principal.user.canonicalUserId };
    case "service":
      return {
        kind: "service",
        service: principal.service,
        // A bot asserting an actor names that person only if the control plane
        // has seen them before; an unresolved actor is recorded as absent.
        userId: ownerUserId ?? principal.actor?.canonicalUserId ?? null,
      };
    case "sandbox":
      return { kind: "sandbox", userId: ownerUserId ?? null };
    default:
      // No principal on an authenticated path means the deployment's internal
      // bearer, which the router accepts on outpost control routes without
      // resolving an identity.
      return { kind: "internal", userId: ownerUserId ?? null };
  }
}

const COLUMNS =
  "id, occurred_at, action, outcome, actor_kind, actor_user_id, actor_service, " +
  "session_id, outpost_id, lease_id, object_kind, object_id, reason, duration_ms, " +
  "request_id, trace_id";

interface AuditDbRow {
  id: string;
  occurred_at: number;
  action: AuditAction;
  outcome: AuditOutcome;
  actor_kind: AuditActorKind;
  actor_user_id: string | null;
  actor_service: string | null;
  session_id: string | null;
  outpost_id: string | null;
  lease_id: string | null;
  object_kind: string | null;
  object_id: string | null;
  reason: string | null;
  duration_ms: number | null;
  request_id: string | null;
  trace_id: string | null;
}

function toRecord(row: AuditDbRow): AuditRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    outcome: row.outcome,
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    actorService: row.actor_service,
    sessionId: row.session_id,
    outpostId: row.outpost_id,
    leaseId: row.lease_id,
    objectKind: row.object_kind,
    objectId: row.object_id,
    reason: row.reason,
    durationMs: row.duration_ms,
    requestId: row.request_id,
    traceId: row.trace_id,
  };
}

/** What a read may be scoped by. Reads are for operators and, later, owners. */
export interface AuditQuery {
  actorUserId?: string;
  sessionId?: string;
  outpostId?: string;
  action?: AuditAction;
  /** Inclusive lower bound on `occurredAt`. */
  since?: number;
  limit?: number;
}

const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;

/**
 * The audit store. Insert and read; there is nothing else, by design.
 *
 * Adding an `update` or `delete` method here would not work — migration 0049's
 * triggers abort both — but the absence is the point rather than the trigger
 * being a backstop for carelessness.
 */
export class AuditLogStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Append one record.
   *
   * Validates before writing so a malformed call fails at the call site during
   * development rather than writing a row nobody can interpret. Callers on a
   * request path should go through {@link writeAuditRecord}, which turns a
   * failure into a loud log line instead of a failed product operation.
   */
  async record(input: AuditRecordInput): Promise<AuditRecord> {
    const action = assertMember(input.action, AUDIT_ACTIONS, "action");
    if (!action) throw new AuditLogValidationError("Audit field 'action' is required");
    const outcome = assertMember(input.outcome, AUDIT_OUTCOMES, "outcome");
    if (!outcome) throw new AuditLogValidationError("Audit field 'outcome' is required");
    const actorKind = assertMember(input.actor?.kind, AUDIT_ACTOR_KINDS, "actor.kind");
    if (!actorKind) throw new AuditLogValidationError("Audit field 'actor.kind' is required");

    const objectKind = input.object
      ? assertMember(input.object.kind, AUDIT_OBJECT_KINDS, "object.kind")
      : null;
    if (input.object && !objectKind) {
      throw new AuditLogValidationError("Audit field 'object.kind' is required");
    }

    const row: AuditDbRow = {
      id: generateId(),
      occurred_at: input.occurredAt ?? Date.now(),
      action,
      outcome,
      actor_kind: actorKind,
      actor_user_id: assertIdentifier(input.actor.userId, "actor.userId"),
      actor_service: assertIdentifier(input.actor.service, "actor.service", 64),
      session_id: assertIdentifier(input.sessionId, "sessionId"),
      outpost_id: assertIdentifier(input.outpostId, "outpostId"),
      lease_id: assertIdentifier(input.leaseId, "leaseId"),
      object_kind: objectKind,
      object_id: input.object ? assertIdentifier(input.object.id, "object.id") : null,
      reason: assertMember(input.reason, AUDIT_REASONS, "reason"),
      duration_ms: assertDurationMs(input.durationMs),
      request_id: assertIdentifier(input.requestId, "requestId", MAX_CORRELATION_ID_LENGTH),
      trace_id: assertIdentifier(input.traceId, "traceId", MAX_CORRELATION_ID_LENGTH),
    };

    await this.db
      .prepare(
        `INSERT INTO audit_log (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.occurred_at,
        row.action,
        row.outcome,
        row.actor_kind,
        row.actor_user_id,
        row.actor_service,
        row.session_id,
        row.outpost_id,
        row.lease_id,
        row.object_kind,
        row.object_id,
        row.reason,
        row.duration_ms,
        row.request_id,
        row.trace_id
      )
      .run();

    return toRecord(row);
  }

  /** Read records, newest first, scoped by whichever subjects the caller names. */
  async list(query: AuditQuery = {}): Promise<AuditRecord[]> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (query.actorUserId !== undefined) {
      conditions.push("actor_user_id = ?");
      bindings.push(assertIdentifier(query.actorUserId, "actorUserId"));
    }
    if (query.sessionId !== undefined) {
      conditions.push("session_id = ?");
      bindings.push(assertIdentifier(query.sessionId, "sessionId"));
    }
    if (query.outpostId !== undefined) {
      conditions.push("outpost_id = ?");
      bindings.push(assertIdentifier(query.outpostId, "outpostId"));
    }
    if (query.action !== undefined) {
      conditions.push("action = ?");
      bindings.push(assertMember(query.action, AUDIT_ACTIONS, "action"));
    }
    if (query.since !== undefined) {
      conditions.push("occurred_at >= ?");
      bindings.push(query.since);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_READ_LIMIT, 1), MAX_READ_LIMIT);

    const result = await this.db
      .prepare(
        `SELECT ${COLUMNS} FROM audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`
      )
      .bind(...bindings, limit)
      .all<AuditDbRow>();

    return (result.results ?? []).map(toRecord);
  }
}

/**
 * Append a record without letting its failure take down the operation being
 * audited.
 *
 * The alternative — refusing to execute a command whose record cannot be
 * written — is a stronger guarantee and a worse product: the command usually
 * has already run by the time the record is written, so failing the response
 * would misreport a completed action rather than prevent one. What this does
 * instead is fail loudly: `audit.write_failed` is an error-level event naming
 * the action that went unrecorded, which is exactly the signal an operator
 * needs and exactly what a silent catch would destroy.
 */
export async function writeAuditRecord(
  db: SqlDatabase,
  log: Logger,
  input: AuditRecordInput
): Promise<void> {
  try {
    await new AuditLogStore(db).record(input);
  } catch (e) {
    log.error("audit.write_failed", {
      event: "audit.write_failed",
      audit_action: input.action,
      audit_outcome: input.outcome,
      session_id: input.sessionId ?? undefined,
      outpost_id: input.outpostId ?? undefined,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
