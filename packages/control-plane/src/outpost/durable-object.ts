import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  OUTPOST_PROTOCOL_VERSION,
  outpostOperationSchema,
  toolInputSchemas,
  workerToControlMessageSchema,
  type ContextResult,
  type LeaseAccepted,
  type LeaseRejected,
  type OutpostError,
  type ToolResult,
} from "@openoutposts/outpost-protocol";

import { createLogger, parseLogLevel, type Logger } from "../logger";
import {
  AUDIT_ACTOR_KINDS,
  writeAuditRecord,
  type AuditActor,
  type AuditReason,
  type AuditRecordInput,
} from "../db/audit-log";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const HEARTBEAT_INTERVAL_MS = 15_000;
const LEASE_DEFAULT_TTL_MS = 60 * 60 * 1000;
const LEASE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_ACCEPT_TIMEOUT_MS = 10_000;
const CONTEXT_TIMEOUT_MS = 15_000;
const TOOL_DEFAULT_TIMEOUT_MS = 120_000;
const TOOL_MAX_TIMEOUT_MS = 300_000;

/**
 * Who a lease is being taken for, resolved by the control plane before the
 * request reaches here.
 *
 * The DO cannot resolve it itself: a lease arrives on the deployment's internal
 * credential, which names no person, and the session row that does name one
 * lives in D1. So the route resolves it once per lease (routes/outposts.ts) and
 * this object carries it onto every subsequent tool call under that lease —
 * one lookup per grant rather than one per command. It is overwritten by the
 * route, never trusted from a caller.
 */
const leaseActorSchema = z.object({
  kind: z.enum(AUDIT_ACTOR_KINDS),
  userId: z.string().min(1).max(200).nullable().optional(),
});

const createLeaseBodySchema = z.object({
  productSessionId: z.string().min(1).max(200),
  workspacePath: z.string().min(1).max(4096),
  ttlMs: z.number().int().positive().max(LEASE_MAX_TTL_MS).optional(),
  actor: leaseActorSchema.optional(),
});

const releaseLeaseBodySchema = z.object({
  reason: z.enum(["completed", "expired", "moved", "cancelled"]).default("completed"),
});

const renewLeaseBodySchema = z.object({
  ttlMs: z.number().int().positive().max(LEASE_MAX_TTL_MS).optional(),
});

const toolCallBodySchema = z.object({
  leaseId: z.string().min(1).max(200),
  operation: outpostOperationSchema,
  input: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().positive().max(TOOL_MAX_TIMEOUT_MS).optional(),
});

interface SocketAttachment {
  connectionId: string;
  outpostId: string;
  keyFingerprint: string;
  ownerUserId: string;
  registered: boolean;
}

interface OutpostRow {
  [key: string]: SqlStorageValue;
  id: string;
  name: string;
  worker_version: string;
  platform: string;
  architecture: string;
  operations_json: string;
  workspace_roots_json: string;
  connection_id: string;
  connected_at: number;
  last_heartbeat_at: number;
  disconnected_at: number | null;
}

interface LeaseRow {
  [key: string]: SqlStorageValue;
  id: string;
  product_session_id: string;
  workspace_path: string;
  created_at: number;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
  /** Audit attribution, carried from the grant onto every call under it. */
  actor_kind: string | null;
  actor_user_id: string | null;
}

interface PendingLease {
  resolve: (outcome: LeaseAccepted | LeaseRejected | "disconnected" | "timeout") => void;
}

interface PendingTool {
  resolve: (outcome: ToolResult | "disconnected" | "timeout") => void;
}

interface PendingContext {
  resolve: (outcome: ContextResult | "disconnected" | "timeout") => void;
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.connectionId === "string" &&
    typeof record.outpostId === "string" &&
    typeof record.keyFingerprint === "string" &&
    typeof record.ownerUserId === "string" &&
    typeof record.registered === "boolean"
  );
}

const DIRECTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export class OutpostDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly log: Logger;
  private readonly pendingLeases = new Map<string, PendingLease>();
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly pendingContexts = new Map<string, PendingContext>();
  private lastDirectorySyncAt = 0;
  /** The DO's global-database handle for the advisory outposts directory. */
  private readonly db: SqlDatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // eslint-disable-next-line no-restricted-syntax -- composition root: the DO's one env.DB read
    this.db = env.DB;
    this.log = createLogger("outpost-do", {}, parseLogLevel(env.LOG_LEVEL));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS outpost (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        worker_version TEXT NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        workspace_roots_json TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        disconnected_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lease (
        id TEXT PRIMARY KEY,
        product_session_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER,
        release_reason TEXT,
        actor_kind TEXT,
        actor_user_id TEXT
      )
    `);
    // Machines enrolled before leases carried attribution already have a lease
    // table without these columns. Adding them here is the whole migration this
    // object needs; leases granted before it record no actor and say so.
    const leaseColumns = new Set(
      (this.sql.exec("PRAGMA table_info(lease)").toArray() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!leaseColumns.has("actor_kind")) {
      this.sql.exec("ALTER TABLE lease ADD COLUMN actor_kind TEXT");
    }
    if (!leaseColumns.has("actor_user_id")) {
      this.sql.exec("ALTER TABLE lease ADD COLUMN actor_user_id TEXT");
    }
  }

  /**
   * The identity a lease's work is attributable to.
   *
   * A lease granted before attribution existed, or one whose session had no
   * recorded owner, resolves to the internal credential with no user. That is
   * recorded as an absence rather than filled in with a plausible guess.
   */
  private leaseActor(lease: Pick<LeaseRow, "actor_kind" | "actor_user_id">): AuditActor {
    const kind = AUDIT_ACTOR_KINDS.find((candidate) => candidate === lease.actor_kind);
    return { kind: kind ?? "internal", userId: lease.actor_user_id ?? null };
  }

  /**
   * Append an audit record off the critical path.
   *
   * `waitUntil` keeps the object alive until the write settles, so the record
   * survives the response without the tool call waiting on D1. A write that
   * fails is logged at error level by {@link writeAuditRecord}, never dropped
   * quietly.
   */
  private audit(input: AuditRecordInput): void {
    this.ctx.waitUntil(writeAuditRecord(this.db, this.log, input));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.handleConnect(request);
    if (url.pathname === "/status" && request.method === "GET") return this.status();
    if (url.pathname === "/leases" && request.method === "POST") {
      return this.handleCreateLease(request);
    }
    const releaseMatch = url.pathname.match(/^\/leases\/([^/]+)$/);
    if (releaseMatch && request.method === "DELETE") {
      return this.handleReleaseLease(request, releaseMatch[1]);
    }
    const renewMatch = url.pathname.match(/^\/leases\/([^/]+)\/renew$/);
    if (renewMatch && request.method === "POST") {
      return this.handleRenewLease(request, renewMatch[1]);
    }
    const cancelMatch = url.pathname.match(/^\/leases\/([^/]+)\/cancel-work$/);
    if (cancelMatch && request.method === "POST") {
      return this.handleCancelLeaseWork(cancelMatch[1]);
    }
    const contextMatch = url.pathname.match(/^\/leases\/([^/]+)\/context$/);
    if (contextMatch && request.method === "POST") {
      return this.handleContextRequest(contextMatch[1]);
    }
    if (url.pathname === "/tool" && request.method === "POST") {
      return this.handleToolCall(request);
    }
    if (url.pathname === "/forget" && request.method === "POST") {
      return this.handleForget();
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== "string") {
      this.rejectSocket(ws, "invalid_message", "Only JSON text messages are supported");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(rawMessage);
    } catch {
      this.rejectSocket(ws, "invalid_message", "Message is not valid JSON");
      return;
    }

    const parsed = workerToControlMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.rejectSocket(
        ws,
        "invalid_message",
        `Message does not match protocol version ${OUTPOST_PROTOCOL_VERSION}`
      );
      return;
    }

    const attachment = this.getAttachment(ws);
    if (!attachment) {
      this.rejectSocket(ws, "invalid_message", "Connection identity is missing");
      return;
    }

    const message = parsed.data;
    if ("outpostId" in message && message.outpostId !== attachment.outpostId) {
      this.rejectSocket(ws, "identity_mismatch", "Message identity does not match connection");
      return;
    }

    if (message.type === "outpost.register") {
      await this.handleRegister(ws, attachment, message);
      return;
    }

    if (!attachment.registered) {
      this.rejectSocket(ws, "registration_required", "Register before sending other messages");
      return;
    }

    switch (message.type) {
      case "outpost.heartbeat": {
        const now = Date.now();
        this.sql.exec(
          `UPDATE outpost
           SET last_heartbeat_at = ?
           WHERE id = ? AND connection_id = ?`,
          now,
          attachment.outpostId,
          attachment.connectionId
        );
        if (now - this.lastDirectorySyncAt > DIRECTORY_SYNC_INTERVAL_MS) {
          this.ctx.waitUntil(this.touchDirectory(attachment.outpostId, now));
        }
        ws.send(
          JSON.stringify({
            type: "outpost.heartbeat_ack",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            outpostId: attachment.outpostId,
            receivedAt: new Date(now).toISOString(),
          })
        );
        return;
      }
      case "lease.accepted":
      case "lease.rejected": {
        // Unsolicited acceptances happen when leases are re-offered after a
        // reconnect; they are benign.
        this.pendingLeases.get(message.leaseId)?.resolve(message);
        return;
      }
      case "tool.result": {
        // A result arriving after its caller timed out has no pending entry.
        this.pendingTools.get(message.requestId)?.resolve(message);
        return;
      }
      case "context.result": {
        this.pendingContexts.get(message.requestId)?.resolve(message);
        return;
      }
      default:
        this.rejectSocket(ws, "unsupported_message", "This message is not supported yet");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (attachment?.registered) {
      this.sql.exec(
        `UPDATE outpost
         SET disconnected_at = ?
         WHERE id = ? AND connection_id = ?`,
        Date.now(),
        attachment.outpostId,
        attachment.connectionId
      );
      this.log.info("Outpost disconnected", {
        event: "outpost.disconnected",
        outpost_id: attachment.outpostId,
        connection_id: attachment.connectionId,
        close_code: code,
      });
      this.ctx.waitUntil(this.markDirectoryDisconnected(attachment.outpostId));
    }
    this.failPendingExchanges("disconnected");
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.log.error("Outpost WebSocket error", { error });
    this.failPendingExchanges("disconnected");
    ws.close(1011, "Internal error");
  }

  private async handleRegister(
    ws: WebSocket,
    attachment: SocketAttachment,
    message: Extract<z.infer<typeof workerToControlMessageSchema>, { type: "outpost.register" }>
  ): Promise<void> {
    if (!(await this.connectionIdentityIsActive(attachment))) {
      this.rejectSocket(ws, "identity_mismatch", "Machine identity is no longer active");
      return;
    }

    const now = Date.now();
    // Enrollment is the machine appearing under this identity for the first
    // time; every later registration is a reconnect. Only the first is audited:
    // a flapping worker reconnects on a backoff measured in seconds, and a
    // security record that a link-flap can flood is one nobody can read.
    // Reconnects remain visible as `outpost.registered` log lines.
    const firstRegistration =
      this.sql.exec(`SELECT id FROM outpost WHERE id = ?`, message.outpostId).toArray().length ===
      0;
    this.sql.exec(
      `INSERT INTO outpost (
        id, name, worker_version, platform, architecture, operations_json,
        workspace_roots_json, connection_id, connected_at, last_heartbeat_at, disconnected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        worker_version = excluded.worker_version,
        platform = excluded.platform,
        architecture = excluded.architecture,
        operations_json = excluded.operations_json,
        workspace_roots_json = excluded.workspace_roots_json,
        connection_id = excluded.connection_id,
        connected_at = excluded.connected_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        disconnected_at = NULL`,
      message.outpostId,
      message.name,
      message.workerVersion,
      message.capabilities.platform,
      message.capabilities.architecture,
      JSON.stringify(message.capabilities.operations),
      JSON.stringify(message.capabilities.workspaceRoots),
      attachment.connectionId,
      now,
      now
    );

    ws.serializeAttachment({ ...attachment, registered: true } satisfies SocketAttachment);
    ws.send(
      JSON.stringify({
        type: "outpost.registered",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        outpostId: attachment.outpostId,
        connectionId: attachment.connectionId,
        registeredAt: new Date(now).toISOString(),
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      })
    );
    this.log.info("Outpost registered", {
      event: "outpost.registered",
      outpost_id: attachment.outpostId,
      connection_id: attachment.connectionId,
    });
    if (firstRegistration) {
      // The owner completed enrollment before this connection was admitted.
      // This record marks the enrolled machine's first live registration, so
      // the machine is the actor and its durable owner remains in D1.
      this.audit({
        action: "outpost.enrolled",
        outcome: "success",
        actor: { kind: "outpost" },
        outpostId: attachment.outpostId,
        occurredAt: now,
      });
    }
    this.ctx.waitUntil(
      this.syncDirectory({
        id: attachment.outpostId,
        name: message.name,
        workerVersion: message.workerVersion,
        platform: message.capabilities.platform,
        architecture: message.capabilities.architecture,
        connected: true,
        now,
      })
    );

    // Re-offer leases that are still active so a reconnecting worker can
    // resume serving its sessions without homestead involvement.
    const activeLeases = this.sql
      .exec(`SELECT * FROM lease WHERE released_at IS NULL AND expires_at > ?`, now)
      .toArray() as LeaseRow[];
    for (const lease of activeLeases) {
      ws.send(
        JSON.stringify({
          type: "lease.offer",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          leaseId: lease.id,
          productSessionId: lease.product_session_id,
          workspacePath: lease.workspace_path,
          expiresAt: new Date(lease.expires_at).toISOString(),
        })
      );
    }
  }

  private async handleCreateLease(request: Request): Promise<Response> {
    const body = createLeaseBodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "Invalid lease request body" }, { status: 400 });
    }

    const actor = this.leaseActor({
      actor_kind: body.data.actor?.kind ?? null,
      actor_user_id: body.data.actor?.userId ?? null,
    });
    const outpostId = this.registeredOutpostId();

    const socket = this.activeSocket();
    if (!socket) {
      this.auditLeaseRefusal(body.data.productSessionId, actor, outpostId, "outpost_disconnected");
      return Response.json({ error: "Outpost is not connected" }, { status: 409 });
    }

    const now = Date.now();
    const leaseId = crypto.randomUUID();
    const expiresAt = now + (body.data.ttlMs ?? LEASE_DEFAULT_TTL_MS);

    const outcome = new Promise<LeaseAccepted | LeaseRejected | "disconnected" | "timeout">(
      (resolve) => {
        this.pendingLeases.set(leaseId, { resolve });
      }
    );
    const timer = setTimeout(() => {
      this.pendingLeases.get(leaseId)?.resolve("timeout");
    }, LEASE_ACCEPT_TIMEOUT_MS);

    socket.send(
      JSON.stringify({
        type: "lease.offer",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId,
        productSessionId: body.data.productSessionId,
        workspacePath: body.data.workspacePath,
        expiresAt: new Date(expiresAt).toISOString(),
      })
    );

    const result = await outcome;
    clearTimeout(timer);
    this.pendingLeases.delete(leaseId);

    if (result === "timeout") {
      this.auditLeaseRefusal(body.data.productSessionId, actor, outpostId, "offer_timeout");
      return Response.json({ error: "Outpost did not answer the lease offer" }, { status: 504 });
    }
    if (result === "disconnected") {
      this.auditLeaseRefusal(body.data.productSessionId, actor, outpostId, "outpost_disconnected");
      return Response.json(
        { error: "Outpost disconnected during the lease offer" },
        {
          status: 502,
        }
      );
    }
    if (result.type === "lease.rejected") {
      this.log.warn("Lease rejected by worker", {
        event: "lease.rejected",
        lease_id: leaseId,
        reason: result.reason,
      });
      // The worker's own reason is free text on the wire; the record keeps the
      // classification and the log line keeps the text.
      this.auditLeaseRefusal(body.data.productSessionId, actor, outpostId, "worker_refused");
      return Response.json(
        { error: `Outpost rejected the lease: ${result.reason}` },
        {
          status: 422,
        }
      );
    }

    this.sql.exec(
      `INSERT INTO lease (
         id, product_session_id, workspace_path, created_at, expires_at, actor_kind, actor_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      leaseId,
      body.data.productSessionId,
      body.data.workspacePath,
      now,
      expiresAt,
      actor.kind,
      actor.userId ?? null
    );
    this.log.info("Lease granted", {
      event: "lease.granted",
      lease_id: leaseId,
      product_session_id: body.data.productSessionId,
    });
    // The grant of execution authority over someone's machine — the record an
    // auditor starts from, and the anchor every tool call below points back to.
    this.audit({
      action: "lease.granted",
      outcome: "success",
      actor,
      sessionId: body.data.productSessionId,
      outpostId,
      leaseId,
      occurredAt: now,
    });
    return Response.json(
      { leaseId, expiresAt: new Date(expiresAt).toISOString() },
      { status: 201 }
    );
  }

  private async handleReleaseLease(request: Request, leaseId: string): Promise<Response> {
    const body = releaseLeaseBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return Response.json({ error: "Invalid release body" }, { status: 400 });
    }

    const lease = this.sql.exec(`SELECT * FROM lease WHERE id = ?`, leaseId).toArray()[0] as
      | LeaseRow
      | undefined;
    if (!lease) return Response.json({ error: "Lease not found" }, { status: 404 });

    if (lease.released_at === null) {
      this.sql.exec(
        `UPDATE lease SET released_at = ?, release_reason = ? WHERE id = ?`,
        Date.now(),
        body.data.reason,
        leaseId
      );
      this.activeSocket()?.send(
        JSON.stringify({
          type: "lease.release",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          leaseId,
          reason: body.data.reason,
        })
      );
      this.log.info("Lease released", {
        event: "lease.released",
        lease_id: leaseId,
        reason: body.data.reason,
      });
      this.audit({
        action: "lease.released",
        outcome: "success",
        actor: this.leaseActor(lease),
        sessionId: lease.product_session_id,
        outpostId: this.registeredOutpostId(),
        leaseId,
        reason: body.data.reason,
      });
    }
    return Response.json({ released: true });
  }

  /**
   * Extends an active lease and re-offers it to the connected worker, whose
   * store overwrites the expiry. Long sessions renew well before expiry.
   */
  private async handleRenewLease(request: Request, leaseId: string): Promise<Response> {
    const body = renewLeaseBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!body.success) {
      return Response.json({ error: "Invalid renew body" }, { status: 400 });
    }
    const now = Date.now();
    const lease = this.sql.exec(`SELECT * FROM lease WHERE id = ?`, leaseId).toArray()[0] as
      | LeaseRow
      | undefined;
    if (!lease || lease.released_at !== null) {
      return Response.json({ error: "Lease is not active" }, { status: 404 });
    }
    if (lease.expires_at <= now) {
      return Response.json({ error: "Lease has already expired" }, { status: 410 });
    }
    const socket = this.activeSocket();
    if (!socket) {
      return Response.json({ error: "Outpost is not connected" }, { status: 409 });
    }

    const expiresAt = now + (body.data.ttlMs ?? LEASE_DEFAULT_TTL_MS);
    this.sql.exec(`UPDATE lease SET expires_at = ? WHERE id = ?`, expiresAt, leaseId);
    socket.send(
      JSON.stringify({
        type: "lease.offer",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId,
        productSessionId: lease.product_session_id,
        workspacePath: lease.workspace_path,
        expiresAt: new Date(expiresAt).toISOString(),
      })
    );
    // Renewal extends authority over a machine, so it is granted authority in
    // its own right and recorded as such rather than folded into the grant.
    this.audit({
      action: "lease.renewed",
      outcome: "success",
      actor: this.leaseActor(lease),
      sessionId: lease.product_session_id,
      outpostId: this.registeredOutpostId(),
      leaseId,
      occurredAt: now,
    });
    return Response.json({ leaseId, expiresAt: new Date(expiresAt).toISOString() });
  }

  /** Cancels every queued or running operation under a lease. */
  private async handleCancelLeaseWork(leaseId: string): Promise<Response> {
    const lease = this.sql.exec(`SELECT * FROM lease WHERE id = ?`, leaseId).toArray()[0] as
      | LeaseRow
      | undefined;
    if (!lease) return Response.json({ error: "Lease not found" }, { status: 404 });
    const socket = this.activeSocket();
    if (!socket) {
      return Response.json({ error: "Outpost is not connected" }, { status: 409 });
    }
    this.sendToolCancellation(socket, leaseId);
    return Response.json({ cancelled: true });
  }

  private async handleToolCall(request: Request): Promise<Response> {
    const body = toolCallBodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "Invalid tool call body" }, { status: 400 });
    }

    const inputParse = toolInputSchemas[body.data.operation].safeParse(body.data.input);
    if (!inputParse.success) {
      // Not audited: the payload never named a valid operation, no lease was
      // consulted, and nothing was asked of the machine. The record covers
      // authority and execution, not malformed requests.
      return Response.json(
        {
          ok: false,
          error: `Invalid ${body.data.operation} input: ${inputParse.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
          errorCode: "invalid_input",
        },
        { status: 400 }
      );
    }

    const now = Date.now();
    const outpostId = this.registeredOutpostId();
    const lease = this.sql
      .exec(`SELECT * FROM lease WHERE id = ?`, body.data.leaseId)
      .toArray()[0] as LeaseRow | undefined;
    if (!lease || lease.released_at !== null) {
      this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
        outcome: "denied",
        reason: "lease_unknown",
      });
      return Response.json(
        { ok: false, error: "Lease is not active", errorCode: "lease_unknown" },
        { status: 200 }
      );
    }
    if (lease.expires_at <= now) {
      this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
        outcome: "denied",
        reason: "lease_expired",
      });
      return Response.json(
        { ok: false, error: "Lease has expired", errorCode: "lease_expired" },
        { status: 200 }
      );
    }

    const socket = this.activeSocket();
    if (!socket) {
      this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
        outcome: "failure",
        reason: "outpost_disconnected",
      });
      return Response.json({ error: "Outpost is not connected" }, { status: 409 });
    }

    const requestId = crypto.randomUUID();
    const timeoutMs = body.data.timeoutMs ?? TOOL_DEFAULT_TIMEOUT_MS;
    const outcome = new Promise<ToolResult | "disconnected" | "timeout">((resolve) => {
      this.pendingTools.set(requestId, { resolve });
    });
    const timer = setTimeout(() => {
      this.pendingTools.get(requestId)?.resolve("timeout");
    }, timeoutMs);

    socket.send(
      JSON.stringify({
        type: "tool.request",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        requestId,
        leaseId: body.data.leaseId,
        operation: body.data.operation,
        input: body.data.input,
      })
    );

    const result = await outcome;
    clearTimeout(timer);
    this.pendingTools.delete(requestId);
    const durationMs = Date.now() - now;

    if (result === "timeout") {
      // Returning a timeout without withdrawing the request leaves it free to
      // mutate the machine after its caller has moved on. Protocol v3 narrows
      // this cancellation to the one request instead of stopping sibling work
      // under the same lease.
      this.sendToolCancellation(socket, body.data.leaseId, requestId);
      this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
        outcome: "failure",
        reason: "timeout",
        durationMs,
      });
      return Response.json(
        {
          ok: false,
          error: `Outpost did not return a result within ${timeoutMs}ms`,
          errorCode: "timeout",
        },
        { status: 200 }
      );
    }
    if (result === "disconnected") {
      this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
        outcome: "failure",
        reason: "outpost_disconnected",
        durationMs,
      });
      return Response.json(
        { error: "Outpost disconnected during the tool call" },
        {
          status: 502,
        }
      );
    }
    this.auditToolCall(body.data.operation, lease, body.data.leaseId, outpostId, {
      outcome: result.ok ? "success" : "failure",
      // The worker's error code is a closed protocol vocabulary; its `error`
      // string is not, and never enters the record.
      reason: result.ok ? null : (result.errorCode ?? null),
      durationMs,
    });
    return Response.json({
      ok: result.ok,
      output: result.output,
      error: result.error,
      errorCode: result.errorCode,
    });
  }

  private async handleContextRequest(leaseId: string): Promise<Response> {
    const now = Date.now();
    const outpostId = this.registeredOutpostId();
    const lease = this.sql.exec(`SELECT * FROM lease WHERE id = ?`, leaseId).toArray()[0] as
      | LeaseRow
      | undefined;
    if (!lease || lease.released_at !== null) {
      this.auditContextRead(lease, leaseId, outpostId, {
        outcome: "denied",
        reason: "lease_unknown",
      });
      return Response.json(
        { ok: false, files: [], error: "Lease is not active", errorCode: "lease_unknown" },
        { status: 200 }
      );
    }
    if (lease.expires_at <= now) {
      this.auditContextRead(lease, leaseId, outpostId, {
        outcome: "denied",
        reason: "lease_expired",
      });
      return Response.json(
        { ok: false, files: [], error: "Lease has expired", errorCode: "lease_expired" },
        { status: 200 }
      );
    }

    const socket = this.activeSocket();
    if (!socket) {
      this.auditContextRead(lease, leaseId, outpostId, {
        outcome: "failure",
        reason: "outpost_disconnected",
      });
      return Response.json({ error: "Outpost is not connected" }, { status: 409 });
    }

    const requestId = crypto.randomUUID();
    const outcome = new Promise<ContextResult | "disconnected" | "timeout">((resolve) => {
      this.pendingContexts.set(requestId, { resolve });
    });
    const timer = setTimeout(() => {
      this.pendingContexts.get(requestId)?.resolve("timeout");
    }, CONTEXT_TIMEOUT_MS);

    socket.send(
      JSON.stringify({
        type: "context.request",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        requestId,
        leaseId,
      })
    );

    const result = await outcome;
    clearTimeout(timer);
    this.pendingContexts.delete(requestId);
    if (result === "timeout") {
      this.auditContextRead(lease, leaseId, outpostId, {
        outcome: "failure",
        reason: "timeout",
        durationMs: Date.now() - now,
      });
      return Response.json(
        {
          ok: false,
          files: [],
          error: `Outpost did not return workspace context within ${CONTEXT_TIMEOUT_MS}ms`,
          errorCode: "timeout",
        },
        { status: 200 }
      );
    }
    if (result === "disconnected") {
      this.auditContextRead(lease, leaseId, outpostId, {
        outcome: "failure",
        reason: "outpost_disconnected",
        durationMs: Date.now() - now,
      });
      return Response.json(
        { error: "Outpost disconnected during workspace context discovery" },
        { status: 502 }
      );
    }
    this.auditContextRead(lease, leaseId, outpostId, {
      outcome: result.ok ? "success" : "failure",
      reason: result.ok ? null : (result.errorCode ?? null),
      durationMs: Date.now() - now,
    });
    return Response.json({
      ok: result.ok,
      files: result.files,
      error: result.error,
      errorCode: result.errorCode,
    });
  }

  /**
   * Drop this machine: release every lease it still holds, tell the worker,
   * close the connection, and forget the registration.
   *
   * Releasing before disconnecting is what makes removal meaningful — a
   * worker that misses the close still receives `lease.release` for each
   * lease, and any tool call arriving afterwards finds no active lease. This
   * The owner-facing route revokes the durable machine identity before calling
   * this method. Keeping that order means a delayed connection or registration
   * cannot recreate the directory row after this object closes its sockets.
   */
  private handleForget(): Response {
    const now = Date.now();
    const socket = this.activeSocket();
    const outpostId = this.registeredOutpostId();
    const activeLeases = this.sql
      .exec(`SELECT * FROM lease WHERE released_at IS NULL`)
      .toArray() as LeaseRow[];

    for (const lease of activeLeases) {
      this.sql.exec(
        `UPDATE lease SET released_at = ?, release_reason = ? WHERE id = ?`,
        now,
        "cancelled",
        lease.id
      );
      socket?.send(
        JSON.stringify({
          type: "lease.release",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          leaseId: lease.id,
          reason: "cancelled",
        })
      );
      // Removal ends every grant on the machine, and each ending is its own
      // record — the machine's removal row says the fleet changed, these say
      // which sessions lost their execution authority and when. The removal
      // itself is recorded by the route, which is where the person is known.
      this.audit({
        action: "lease.released",
        outcome: "success",
        actor: this.leaseActor(lease),
        sessionId: lease.product_session_id,
        outpostId,
        leaseId: lease.id,
        reason: "cancelled",
        occurredAt: now,
      });
    }

    for (const ws of this.ctx.getWebSockets()) {
      ws.close(4003, "Removed from the fleet");
    }
    this.failPendingExchanges("disconnected");
    this.sql.exec(`DELETE FROM outpost`);

    this.log.info("Outpost removed from the fleet", {
      event: "outpost.removed",
      released_leases: activeLeases.length,
    });
    return Response.json({ removed: true, releasedLeases: activeLeases.length });
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const outpostId = request.headers.get("X-Outpost-ID");
    if (!outpostId) return new Response("Outpost identity missing", { status: 400 });
    const keyFingerprint = request.headers.get("X-Outpost-Key-Fingerprint");
    const ownerUserId = request.headers.get("X-Outpost-Owner-User-ID");
    if (!keyFingerprint || !ownerUserId) {
      return new Response("Verified machine identity missing", { status: 400 });
    }

    const row = this.sql.exec("SELECT * FROM outpost LIMIT 1").toArray()[0] as
      | OutpostRow
      | undefined;
    const freshConnection =
      row &&
      row.disconnected_at === null &&
      Date.now() - row.last_heartbeat_at <= HEARTBEAT_INTERVAL_MS * 3 &&
      this.ctx.getWebSockets().some((socket) => {
        const attachment = this.getAttachment(socket);
        return socket.readyState === WebSocket.OPEN && attachment?.registered;
      });
    if (freshConnection) {
      return new Response("Outpost already has a live connection", { status: 409 });
    }

    for (const existing of this.ctx.getWebSockets()) {
      existing.close(4000, "Stale connection replaced by the same machine identity");
    }
    this.failPendingExchanges("disconnected");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = {
      connectionId: crypto.randomUUID(),
      outpostId,
      keyFingerprint,
      ownerUserId,
      registered: false,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`outpost:${outpostId}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Re-check the durable identity at registration time.
   *
   * The outer Worker verifies the signed HTTP upgrade before it reaches this
   * object. Revocation can commit after that read but before the first protocol
   * message. This second check closes that race and also pins the owner and key
   * fingerprint forwarded by the Worker to the durable row.
   */
  private async connectionIdentityIsActive(attachment: SocketAttachment): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT owner_user_id, key_fingerprint, confirmed_at, revoked_at
         FROM outposts WHERE id = ?`
      )
      .bind(attachment.outpostId)
      .first<{
        owner_user_id: string | null;
        key_fingerprint: string | null;
        confirmed_at: number | null;
        revoked_at: number | null;
      }>();
    if (
      !row ||
      row.owner_user_id !== attachment.ownerUserId ||
      row.confirmed_at === null ||
      row.revoked_at !== null
    ) {
      return false;
    }
    return attachment.keyFingerprint === "legacy-shared-token"
      ? row.key_fingerprint === null
      : row.key_fingerprint === attachment.keyFingerprint;
  }

  private status(): Response {
    const cursor = this.sql.exec("SELECT * FROM outpost LIMIT 1");
    const row = cursor.toArray()[0] as OutpostRow | undefined;
    if (!row)
      return new Response(JSON.stringify({ error: "Outpost not registered" }), { status: 404 });

    const connected =
      row.disconnected_at === null &&
      Date.now() - row.last_heartbeat_at <= HEARTBEAT_INTERVAL_MS * 3 &&
      this.ctx.getWebSockets().some((ws) => {
        const attachment = this.getAttachment(ws);
        return (
          ws.readyState === WebSocket.OPEN &&
          attachment?.registered === true &&
          attachment.connectionId === row.connection_id
        );
      });

    const activeLeases = this.sql
      .exec(
        `SELECT * FROM lease WHERE released_at IS NULL AND expires_at > ? ORDER BY created_at`,
        Date.now()
      )
      .toArray() as LeaseRow[];

    return Response.json({
      id: row.id,
      name: row.name,
      workerVersion: row.worker_version,
      capabilities: {
        platform: row.platform,
        architecture: row.architecture,
        operations: JSON.parse(row.operations_json) as unknown,
        workspaceRoots: JSON.parse(row.workspace_roots_json) as unknown,
      },
      connectionId: row.connection_id,
      connected,
      connectedAt: new Date(row.connected_at).toISOString(),
      lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
      disconnectedAt:
        row.disconnected_at === null ? null : new Date(row.disconnected_at).toISOString(),
      activeLeases: activeLeases.map((lease) => ({
        leaseId: lease.id,
        productSessionId: lease.product_session_id,
        workspacePath: lease.workspace_path,
        expiresAt: new Date(lease.expires_at).toISOString(),
      })),
    });
  }

  // Enrollment creates the durable directory row before this object sees a
  // connection. Registration only refreshes operational fields, so a race
  // with revocation cannot recreate or reactivate a removed identity.
  private async syncDirectory(entry: {
    id: string;
    name: string;
    workerVersion: string;
    platform: string;
    architecture: string;
    connected: boolean;
    now: number;
  }): Promise<void> {
    try {
      await this.db
        .prepare(
          `UPDATE outposts
           SET name = ?,
               worker_version = ?,
               platform = ?,
               architecture = ?,
               connected = ?,
               connected_at = ?,
               last_seen_at = ?,
               disconnected_at = NULL
           WHERE id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL`
        )
        .bind(
          entry.name,
          entry.workerVersion,
          entry.platform,
          entry.architecture,
          entry.connected ? 1 : 0,
          entry.now,
          entry.now,
          entry.id
        )
        .run();
      this.lastDirectorySyncAt = entry.now;
    } catch (error) {
      this.log.warn("Outpost directory sync failed", {
        event: "outpost.directory_sync_failed",
        outpost_id: entry.id,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async touchDirectory(outpostId: string, now: number): Promise<void> {
    try {
      await this.db
        .prepare(`UPDATE outposts SET last_seen_at = ? WHERE id = ?`)
        .bind(now, outpostId)
        .run();
      this.lastDirectorySyncAt = now;
    } catch {
      // advisory only
    }
  }

  private async markDirectoryDisconnected(outpostId: string): Promise<void> {
    try {
      await this.db
        .prepare(
          `UPDATE outposts SET connected = 0, disconnected_at = ?, last_seen_at = ? WHERE id = ?`
        )
        .bind(Date.now(), Date.now(), outpostId)
        .run();
    } catch {
      // advisory only
    }
  }

  /**
   * The machine this object represents, as recorded at registration.
   *
   * Read from the row rather than from the caller: every audit record names the
   * machine, and one that named whatever the request said would be worth
   * nothing. A DO that has never seen a registration has no machine to name.
   */
  private registeredOutpostId(): string | null {
    const row = this.sql.exec(`SELECT id FROM outpost LIMIT 1`).toArray()[0] as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  /** A request for execution authority that did not result in a grant. */
  private auditLeaseRefusal(
    productSessionId: string,
    actor: AuditActor,
    outpostId: string | null,
    reason: AuditReason
  ): void {
    this.audit({
      action: "lease.rejected",
      outcome: "denied",
      actor,
      sessionId: productSessionId,
      outpostId,
      reason,
    });
  }

  /**
   * One record per operation asked of the machine.
   *
   * What it carries: the operation name, the lease it ran under, the session
   * that lease belongs to, the machine, the identity the authority descends
   * from, the outcome, and how long it took.
   *
   * What it deliberately does not carry: anything from the operation's input or
   * result. A bash command is text the model composed and routinely contains
   * credentials inline; `write` and `edit` inputs are file contents outright;
   * results are unbounded output. Recording a path would be safe for four of
   * the seven operations and unsafe for the rest, and a per-operation carve-out
   * is the kind of conditional rule that leaks the first time an operation is
   * added. So: no field of the payload, in either direction, ever.
   */
  private auditToolCall(
    operation: string,
    lease: Pick<LeaseRow, "actor_kind" | "actor_user_id" | "product_session_id"> | undefined,
    leaseId: string,
    outpostId: string | null,
    result: {
      outcome: "success" | "denied" | "failure";
      reason?: AuditReason | null;
      durationMs?: number;
    }
  ): void {
    this.audit({
      action: "outpost.tool_call",
      outcome: result.outcome,
      actor: this.leaseActor(lease ?? { actor_kind: null, actor_user_id: null }),
      sessionId: lease?.product_session_id ?? null,
      outpostId,
      leaseId,
      object: { kind: "outpost_operation", id: operation },
      reason: result.reason ?? null,
      durationMs: result.durationMs ?? null,
    });
  }

  private auditContextRead(
    lease: Pick<LeaseRow, "actor_kind" | "actor_user_id" | "product_session_id"> | undefined,
    leaseId: string,
    outpostId: string | null,
    result: {
      outcome: "success" | "denied" | "failure";
      reason?: AuditReason | null;
      durationMs?: number;
    }
  ): void {
    this.audit({
      action: "outpost.context_read",
      outcome: result.outcome,
      actor: this.leaseActor(lease ?? { actor_kind: null, actor_user_id: null }),
      sessionId: lease?.product_session_id ?? null,
      outpostId,
      leaseId,
      object: { kind: "outpost_context", id: "agent-instructions" },
      reason: result.reason ?? null,
      durationMs: result.durationMs ?? null,
    });
  }

  private sendToolCancellation(socket: WebSocket, leaseId: string, requestId?: string): void {
    socket.send(
      JSON.stringify({
        type: "tool.cancel",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        leaseId,
        ...(requestId === undefined ? {} : { requestId }),
      })
    );
  }

  private activeSocket(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (ws.readyState === WebSocket.OPEN && attachment?.registered === true) {
        return ws;
      }
    }
    return null;
  }

  private failPendingExchanges(outcome: "disconnected"): void {
    for (const pending of this.pendingLeases.values()) pending.resolve(outcome);
    for (const pending of this.pendingTools.values()) pending.resolve(outcome);
    for (const pending of this.pendingContexts.values()) pending.resolve(outcome);
  }

  private getAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment: unknown = ws.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment : null;
  }

  private rejectSocket(ws: WebSocket, code: OutpostError["code"], message: string): void {
    ws.send(
      JSON.stringify({
        type: "outpost.error",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        code,
        message,
      } satisfies OutpostError)
    );
    ws.close(4002, message);
  }
}
