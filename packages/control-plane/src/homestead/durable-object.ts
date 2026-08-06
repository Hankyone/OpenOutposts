import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  OUTPOST_PROTOCOL_VERSION,
  HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE,
  HOMESTEAD_SUPERSEDED_CLOSE_CODE,
  assignedRepositorySchema,
  harnessKindSchema,
  outpostIdentifierSchema,
  homesteadToControlMessageSchema,
  type ModelCatalog,
  type HomesteadError,
  type SessionAssignAccepted,
  type SessionAssignRejected,
} from "@openoutposts/outpost-protocol";

import { hashToken } from "../auth/crypto";
import { writeAuditRecord, type AuditRecordInput } from "../db/audit-log";
import { HomesteadModelCatalogStore } from "../db/homestead-model-catalogs";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger, parseLogLevel, type Logger } from "../logger";
import type { Env } from "../types";

const HEARTBEAT_INTERVAL_MS = 15_000;
const ASSIGN_TIMEOUT_MS = 15_000;

/**
 * How long a registered connection keeps holding its homestead id without a sign
 * of life.
 *
 * Three heartbeat intervals, the same staleness rule the outpost status route
 * uses. It is what stops a refusal from becoming a lockout: a socket the
 * control plane still holds open for a process that is gone would otherwise own
 * that homestead id forever, and the legitimate machine could never register
 * again.
 */
const CONNECTION_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * How often a heartbeat is allowed to push the homestead's liveness out to the D1
 * catalog directory.
 *
 * Heartbeats arrive every 15 seconds and the directory only needs to stay
 * inside `HOMESTEAD_CATALOG_LIVENESS_WINDOW_MS`, so throttling to a minute keeps
 * the fleet's steady state at one small D1 write per homestead per minute instead
 * of four.
 */
const CATALOG_LIVENESS_REFRESH_INTERVAL_MS = 60_000;

const assignBodySchema = z.object({
  /**
   * The homestead this session must be served by, when the caller knows which one.
   *
   * Absent means "any connected homestead" — the behaviour every caller has today,
   * and the only one available until a session records the homestead it belongs
   * to. Present means exactly that homestead: a targeted assignment naming a
   * homestead that is not connected is refused by name and never quietly handed to
   * a different one.
   */
  homesteadId: outpostIdentifierSchema.optional(),
  productSessionId: z.string().min(1).max(200),
  sandboxId: z.string().min(1).max(200),
  sandboxAuthToken: z.string().min(1),
  credentialFetchToken: z.string().min(1),
  controlPlaneUrl: z.string().min(1),
  harness: harnessKindSchema,
  model: z.string().min(1).optional(),
  outpostId: z.string().min(1).max(200),
  workspacePath: z.string().min(1).max(4096),
  repositories: z.array(assignedRepositorySchema).optional(),
});

interface SocketAttachment {
  connectionId: string;
  homesteadId: string | null;
  registered: boolean;
}

interface HomesteadRow {
  [key: string]: SqlStorageValue;
  id: string;
  homestead_version: string;
  harnesses_json: string;
  connection_id: string;
  connected_at: number;
  last_heartbeat_at: number;
  disconnected_at: number | null;
}

interface CatalogRow {
  [key: string]: SqlStorageValue;
  homestead_id: string;
  catalog_version: number;
  catalog_hash: string;
  provider_count: number;
  model_count: number;
  reported_at: number;
}

interface PendingAssignment {
  /**
   * The connection the offer went out on. Failure is scoped to it: with more
   * than one homestead connected, one socket closing must not fail assignments
   * another homestead is still deciding on.
   */
  connectionId: string;
  resolve: (
    outcome: SessionAssignAccepted | SessionAssignRejected | "disconnected" | "timeout"
  ) => void;
}

/** A homestead id currently held by an open, registered, heartbeating socket. */
interface LiveHomestead {
  homesteadId: string;
  connectionId: string;
  connectedAt: number;
  socket: WebSocket;
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.connectionId === "string" &&
    (typeof record.homesteadId === "string" || record.homesteadId === null) &&
    typeof record.registered === "boolean"
  );
}

/**
 * Registry for central homestead services. A single well-known instance
 * ("default") accepts outbound homestead connections and hands product sessions
 * to a connected homestead on behalf of the outpost sandbox provider.
 *
 * **One connection per homestead id, and many homestead ids at once.** Every homestead
 * that registers keeps its own socket; a connection claiming an id another live
 * connection already holds is refused and recorded rather than taking the id
 * over. Both halves matter and for different reasons. Plurality is what lets a
 * redeploy be a rollover instead of an outage, and is the prerequisite for
 * routing a session to the machine it belongs to — with one shared socket,
 * "send this session to its homestead" cannot mean anything. Refusal is what
 * keeps that routing honest: silent rebinding was the primitive by which one
 * process could inherit another's identity and, with it, its session
 * assignments.
 */
export class HomesteadDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly db: SqlDatabase;
  private readonly log: Logger;
  private readonly pendingAssignments = new Map<string, PendingAssignment>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // eslint-disable-next-line no-restricted-syntax -- composition root: the DO's one env.DB read
    this.db = env.DB;
    this.log = createLogger("homestead-do", {}, parseLogLevel(env.LOG_LEVEL));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS homestead (
        id TEXT PRIMARY KEY,
        homestead_version TEXT NOT NULL,
        harnesses_json TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        last_heartbeat_at INTEGER NOT NULL,
        disconnected_at INTEGER
      )
    `);
    // The reported model catalog. Held here, beside the homestead row, because
    // this Durable Object is the only place a homestead speaks to the control
    // plane outside per-session work — the D1 mirror below is a read
    // convenience, not the record.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS homestead_catalog (
        homestead_id TEXT PRIMARY KEY,
        catalog_version INTEGER NOT NULL,
        catalog_hash TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        models_json TEXT NOT NULL,
        provider_count INTEGER NOT NULL,
        model_count INTEGER NOT NULL,
        reported_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.handleConnect(request);
    if (url.pathname === "/status" && request.method === "GET") return this.status();
    if (url.pathname === "/assign" && request.method === "POST") {
      return this.handleAssign(request);
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

    const parsed = homesteadToControlMessageSchema.safeParse(decoded);
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

    if (message.type === "homestead.register") {
      const now = Date.now();
      if (attachment.homesteadId !== null && attachment.homesteadId !== message.homesteadId) {
        // One connection, one identity. Re-registering the same id is a
        // homestead re-reporting itself; registering a different one would leave
        // two homestead rows naming this socket and make "which homestead is this
        // connection" unanswerable.
        this.rejectSocket(
          ws,
          "identity_mismatch",
          "This connection is already registered under another homestead id"
        );
        return;
      }
      const holder = this.liveHomesteads(now).find(
        (candidate) =>
          candidate.homesteadId === message.homesteadId &&
          candidate.connectionId !== attachment.connectionId
      );
      if (holder) {
        // Two processes answering to one homestead id is how a session assignment
        // reaches the wrong one, so the newcomer is turned away rather than
        // given the id. The holder is left running and serving.
        this.log.error("Homestead identity already held; connection refused", {
          event: "homestead.identity_refused",
          homestead_id: message.homesteadId,
          connection_id: attachment.connectionId,
          holder_connection_id: holder.connectionId,
        });
        this.audit({
          action: "homestead.identity_refused",
          outcome: "denied",
          // Possession of the deployment's internal credential, which names no
          // person; roadmap 4.4 replaces it with a per-homestead signed identity.
          actor: { kind: "internal", userId: null },
          object: { kind: "homestead", id: message.homesteadId },
          occurredAt: now,
        });
        this.refuseSocket(
          ws,
          "duplicate_identity",
          `Homestead id ${message.homesteadId} is already registered on another live connection`,
          HOMESTEAD_DUPLICATE_IDENTITY_CLOSE_CODE
        );
        return;
      }
      // Nothing live holds the id, but a previous connection's row may still
      // name it — a socket that never closed cleanly, or one whose heartbeats
      // stopped. Close that connection as it is displaced so its process learns
      // it is no longer serving instead of heartbeating into a row that has
      // moved on.
      this.supersedeStaleConnections(message.homesteadId, attachment.connectionId);
      this.sql.exec(
        `INSERT INTO homestead (
          id, homestead_version, harnesses_json, connection_id,
          connected_at, last_heartbeat_at, disconnected_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          homestead_version = excluded.homestead_version,
          harnesses_json = excluded.harnesses_json,
          connection_id = excluded.connection_id,
          connected_at = excluded.connected_at,
          last_heartbeat_at = excluded.last_heartbeat_at,
          disconnected_at = NULL`,
        message.homesteadId,
        message.homesteadVersion,
        JSON.stringify(message.harnesses),
        attachment.connectionId,
        now,
        now
      );
      ws.serializeAttachment({
        ...attachment,
        homesteadId: message.homesteadId,
        registered: true,
      } satisfies SocketAttachment);
      ws.send(
        JSON.stringify({
          type: "homestead.registered",
          protocolVersion: OUTPOST_PROTOCOL_VERSION,
          homesteadId: message.homesteadId,
          connectionId: attachment.connectionId,
          registeredAt: new Date(now).toISOString(),
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        })
      );
      this.log.info("Homestead registered", {
        event: "homestead.registered",
        homestead_id: message.homesteadId,
        connection_id: attachment.connectionId,
      });
      // After the acknowledgement, never before it: a homestead that reports a
      // large catalog must not wait on catalog persistence to learn it is
      // registered, and a catalog write that fails must not fail registration.
      //
      // Liveness is refreshed even when this registration carries no catalog:
      // a homestead that reconnects without re-reporting still owns whatever the
      // directory already holds for it, and leaving that row stale would retire
      // a catalog whose homestead is demonstrably back.
      await this.markCatalogLive(message.homesteadId, attachment.connectionId, now);
      if (message.catalog) {
        await this.recordCatalog(
          message.homesteadId,
          message.catalog,
          now,
          attachment.connectionId
        );
      }
      return;
    }

    if (!attachment.registered || attachment.homesteadId === null) {
      this.rejectSocket(ws, "registration_required", "Register before sending other messages");
      return;
    }

    switch (message.type) {
      case "homestead.heartbeat": {
        if (message.homesteadId !== attachment.homesteadId) {
          this.rejectSocket(ws, "identity_mismatch", "Message identity does not match connection");
          return;
        }
        const now = Date.now();
        const previousHeartbeatAt =
          (
            this.sql
              .exec(
                "SELECT last_heartbeat_at FROM homestead WHERE id = ? AND connection_id = ?",
                attachment.homesteadId,
                attachment.connectionId
              )
              .toArray() as { last_heartbeat_at: number }[]
          )[0]?.last_heartbeat_at ?? 0;
        this.sql.exec(
          `UPDATE homestead SET last_heartbeat_at = ? WHERE id = ? AND connection_id = ?`,
          now,
          attachment.homesteadId,
          attachment.connectionId
        );
        // The heartbeat is what keeps the D1 catalog directory offerable, but
        // it arrives four times a minute and the directory only needs to stay
        // inside its liveness window, so the write is throttled.
        if (now - previousHeartbeatAt >= CATALOG_LIVENESS_REFRESH_INTERVAL_MS) {
          await this.markCatalogLive(attachment.homesteadId, attachment.connectionId, now);
        }
        ws.send(
          JSON.stringify({
            type: "homestead.heartbeat_ack",
            protocolVersion: OUTPOST_PROTOCOL_VERSION,
            homesteadId: attachment.homesteadId,
            receivedAt: new Date(now).toISOString(),
          })
        );
        return;
      }
      case "session.assign_accepted":
      case "session.assign_rejected": {
        // A resolution arriving after its caller timed out has no entry.
        this.pendingAssignments.get(message.assignmentId)?.resolve(message);
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (attachment?.registered && attachment.homesteadId !== null) {
      const now = Date.now();
      this.sql.exec(
        `UPDATE homestead SET disconnected_at = ? WHERE id = ? AND connection_id = ?`,
        now,
        attachment.homesteadId,
        attachment.connectionId
      );
      // The directory stops offering this homestead's models now rather than
      // waiting out the liveness window. The row itself stays: it still
      // resolves stored model ids to display names.
      try {
        await new HomesteadModelCatalogStore(this.db).markDisconnected(
          attachment.homesteadId,
          attachment.connectionId,
          now
        );
      } catch (error) {
        // A directory that keeps offering a dead homestead's models is exactly the
        // failure this is here to prevent, so the miss is loud. The liveness
        // window still retires the row without any further write.
        this.log.error("Homestead model catalog disconnect not mirrored", {
          event: "homestead.catalog_disconnect_sync_failed",
          homestead_id: attachment.homesteadId,
          error: error instanceof Error ? error : String(error),
        });
      }
      this.log.info("Homestead disconnected", {
        event: "homestead.disconnected",
        homestead_id: attachment.homesteadId,
        close_code: code,
      });
    }
    if (attachment) this.failPendingAssignments(attachment.connectionId);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    const attachment = this.getAttachment(ws);
    this.log.error("Homestead WebSocket error", {
      error,
      homestead_id: attachment?.homesteadId ?? undefined,
    });
    // Only this connection's assignments fail. A socket with no identity has
    // none: an assignment is only ever sent to a registered connection.
    if (attachment) this.failPendingAssignments(attachment.connectionId);
    ws.close(1011, "Internal error");
  }

  private async handleAssign(request: Request): Promise<Response> {
    const body = assignBodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "Invalid assignment body" }, { status: 400 });
    }

    const { homesteadId: requestedHomesteadId, ...assignment } = body.data;
    const target = this.selectHomestead(requestedHomesteadId, Date.now());
    if (!target) {
      // Two different absences, told apart: nothing to serve the session at
      // all, versus the named homestead specifically not being there. The second
      // never degrades into the first.
      if (requestedHomesteadId !== undefined) {
        this.log.warn("Targeted assignment refused: homestead not connected", {
          event: "homestead.assign_target_absent",
          homestead_id: requestedHomesteadId,
          product_session_id: assignment.productSessionId,
        });
        return Response.json(
          { error: `Homestead ${requestedHomesteadId} is not connected` },
          { status: 409 }
        );
      }
      return Response.json({ error: "No homestead is connected" }, { status: 409 });
    }

    const assignmentId = crypto.randomUUID();
    const outcome = new Promise<
      SessionAssignAccepted | SessionAssignRejected | "disconnected" | "timeout"
    >((resolve) => {
      this.pendingAssignments.set(assignmentId, { connectionId: target.connectionId, resolve });
    });
    const timer = setTimeout(() => {
      this.pendingAssignments.get(assignmentId)?.resolve("timeout");
    }, ASSIGN_TIMEOUT_MS);

    target.socket.send(
      JSON.stringify({
        type: "session.assign",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        assignmentId,
        ...assignment,
      })
    );

    const result = await outcome;
    clearTimeout(timer);
    this.pendingAssignments.delete(assignmentId);

    if (result === "timeout") {
      return Response.json({ error: "Homestead did not answer the assignment" }, { status: 504 });
    }
    if (result === "disconnected") {
      return Response.json(
        { error: "Homestead disconnected during the assignment" },
        {
          status: 502,
        }
      );
    }
    if (result.type === "session.assign_rejected") {
      this.log.warn("Assignment rejected by homestead", {
        event: "homestead.assign_rejected",
        homestead_id: target.homesteadId,
        product_session_id: assignment.productSessionId,
        reason: result.reason,
      });
      return Response.json(
        { error: `Homestead rejected the session: ${result.reason}` },
        {
          status: 422,
        }
      );
    }

    this.log.info("Session assigned to homestead", {
      event: "homestead.session_assigned",
      homestead_id: target.homesteadId,
      product_session_id: assignment.productSessionId,
      outpost_id: assignment.outpostId,
    });
    // The answer names the homestead even when the caller did not ask for one:
    // which homestead is serving a session is the fact a homestead binding will be
    // written from, and the caller should not have to infer it.
    return Response.json({ assigned: true, homesteadId: target.homesteadId });
  }

  /**
   * The homestead an assignment goes to, or null when there is none.
   *
   * A named homestead is looked up and nothing else is considered — the whole
   * point of naming one. An unnamed assignment takes the most recently
   * connected live homestead, which keeps the single-homestead deployment's behaviour
   * exactly as it was and, when a replacement homestead joins during a rollover,
   * sends new work to the new process while the outgoing one finishes what it
   * already holds. Ties break on homestead id so the choice is reproducible.
   *
   * Load is deliberately not consulted: this object keeps no session accounting
   * (roadmap 4.1), and a placement rule that pretended to balance without it
   * would be a guess wearing a policy's clothes.
   */
  private selectHomestead(homesteadId: string | undefined, now: number): LiveHomestead | null {
    const live = this.liveHomesteads(now);
    if (homesteadId !== undefined) {
      return live.find((candidate) => candidate.homesteadId === homesteadId) ?? null;
    }
    const ordered = [...live].sort(
      (a, b) => b.connectedAt - a.connectedAt || a.homesteadId.localeCompare(b.homesteadId)
    );
    return ordered[0] ?? null;
  }

  private handleConnect(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    // Nothing is evicted here, and nothing can be: a connection claims no
    // identity until it registers, so a socket closed at this point would be
    // closed for having arrived, not for conflicting with anything. Whether
    // this connection may serve a given homestead id is decided at registration,
    // where the id is known.

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = {
      connectionId: crypto.randomUUID(),
      homesteadId: null,
      registered: false,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["homestead"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private status(): Response {
    const rows = this.sql
      .exec("SELECT * FROM homestead ORDER BY connected_at DESC")
      .toArray() as HomesteadRow[];
    // Summary only. The catalog runs to hundreds of kilobytes and the model
    // list has its own endpoint; what a status caller needs is whether one was
    // reported, how big it is, and how stale.
    const catalogRows = this.sql
      .exec(
        `SELECT homestead_id, catalog_version, catalog_hash, provider_count, model_count, reported_at
         FROM homestead_catalog`
      )
      .toArray() as CatalogRow[];
    const catalogByHomestead = new Map(catalogRows.map((row) => [row.homestead_id, row]));
    // Liveness comes from the same helper assignment uses, so the fleet a
    // caller can see and the fleet a session can reach cannot disagree.
    const liveConnectionIds = new Set(
      this.liveHomesteads(Date.now()).map((homestead) => homestead.connectionId)
    );
    return Response.json({
      connected: liveConnectionIds.size > 0,
      homesteads: rows.map((row) => ({
        id: row.id,
        homesteadVersion: row.homestead_version,
        harnesses: JSON.parse(row.harnesses_json) as unknown,
        catalog: (() => {
          const catalog = catalogByHomestead.get(row.id);
          if (!catalog) return null;
          return {
            catalogVersion: catalog.catalog_version,
            catalogHash: catalog.catalog_hash,
            providerCount: catalog.provider_count,
            modelCount: catalog.model_count,
            reportedAt: new Date(catalog.reported_at).toISOString(),
          };
        })(),
        connected: liveConnectionIds.has(row.connection_id),
        connectedAt: new Date(row.connected_at).toISOString(),
        lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
        disconnectedAt:
          row.disconnected_at === null ? null : new Date(row.disconnected_at).toISOString(),
      })),
    });
  }

  /**
   * Persist a homestead's reported model catalog and mirror it into D1.
   *
   * A homestead re-sends its whole catalog on every reconnect, and reconnects are
   * frequent, so the digest gates the work: an unchanged catalog costs one
   * comparison and nothing else. The digest is a change detector over the
   * reported content, not a security claim.
   *
   * The D1 mirror is advisory. It is what the model-catalog endpoint reads, so
   * a failed mirror degrades the product's model list to whatever was last
   * written — which is why the failure is logged loudly and never propagated
   * into the protocol path.
   */
  /**
   * Push the homestead's liveness into the D1 catalog directory.
   *
   * Separate from `recordCatalog` because the directory skips rewriting an
   * unchanged catalog, so `reported_at` cannot double as a liveness signal: a
   * homestead can stay connected for weeks without ever changing its catalog.
   * A homestead with no directory row has nothing to mark and this does nothing.
   */
  private async markCatalogLive(
    homesteadId: string,
    connectionId: string,
    atMs: number
  ): Promise<void> {
    try {
      await new HomesteadModelCatalogStore(this.db).markLive(homesteadId, connectionId, atMs);
    } catch (error) {
      // Advisory, and self-correcting: the next heartbeat retries. It is logged
      // because a run of these ends with a live homestead's models disappearing.
      this.log.error("Homestead model catalog liveness not mirrored", {
        event: "homestead.catalog_liveness_sync_failed",
        homestead_id: homesteadId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async recordCatalog(
    homesteadId: string,
    catalog: ModelCatalog,
    reportedAt: number,
    connectionId: string
  ): Promise<void> {
    const providersJson = JSON.stringify(catalog.providers);
    const modelsJson = JSON.stringify(catalog.models);
    const catalogHash = await hashToken(`${catalog.catalogVersion}:${providersJson}:${modelsJson}`);

    const localHash =
      (
        this.sql
          .exec("SELECT catalog_hash FROM homestead_catalog WHERE homestead_id = ?", homesteadId)
          .toArray() as { catalog_hash: string }[]
      )[0]?.catalog_hash ?? null;

    // The mirror's digest is consulted, not assumed from the local one. They
    // diverge exactly when a previous mirror write failed, and that is the case
    // a reconnect must retry rather than skip forever.
    const directory = new HomesteadModelCatalogStore(this.db);
    let mirrorHash: string | null = null;
    try {
      mirrorHash = await directory.getHash(homesteadId);
    } catch {
      // Unknown mirror state: fall through and rewrite it.
    }

    if (localHash === catalogHash && mirrorHash === catalogHash) return;

    if (localHash !== catalogHash) {
      this.sql.exec(
        `INSERT INTO homestead_catalog (
          homestead_id, catalog_version, catalog_hash, providers_json, models_json,
          provider_count, model_count, reported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(homestead_id) DO UPDATE SET
          catalog_version = excluded.catalog_version,
          catalog_hash = excluded.catalog_hash,
          providers_json = excluded.providers_json,
          models_json = excluded.models_json,
          provider_count = excluded.provider_count,
          model_count = excluded.model_count,
          reported_at = excluded.reported_at`,
        homesteadId,
        catalog.catalogVersion,
        catalogHash,
        providersJson,
        modelsJson,
        catalog.providers.length,
        catalog.models.length,
        reportedAt
      );
    }

    try {
      await directory.put({
        homesteadId,
        catalogVersion: catalog.catalogVersion,
        catalogHash,
        providers: catalog.providers,
        models: catalog.models,
        reportedAt,
        connectionId,
      });
      this.log.info("Homestead model catalog recorded", {
        event: "homestead.catalog_recorded",
        homestead_id: homesteadId,
        catalog_version: catalog.catalogVersion,
        provider_count: catalog.providers.length,
        model_count: catalog.models.length,
      });
    } catch (error) {
      this.log.error("Homestead model catalog directory sync failed", {
        event: "homestead.catalog_sync_failed",
        homestead_id: homesteadId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  /**
   * Every homestead id currently held by a connection that can serve.
   *
   * All three conditions are load-bearing. The socket must be open, or the
   * assignment goes nowhere. Its connection must be the one the homestead's row
   * names, or it is a superseded connection whose registration has already been
   * taken over. And the row's heartbeat must be recent, or the process behind
   * an open socket has stopped answering and only looks alive.
   */
  private liveHomesteads(now: number): LiveHomestead[] {
    const rows = this.sql
      .exec("SELECT * FROM homestead WHERE disconnected_at IS NULL")
      .toArray() as HomesteadRow[];
    const byConnection = new Map(rows.map((row) => [row.connection_id, row]));

    const live: LiveHomestead[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const attachment = this.getAttachment(ws);
      if (!attachment?.registered || attachment.homesteadId === null) continue;
      const row = byConnection.get(attachment.connectionId);
      if (!row || row.id !== attachment.homesteadId) continue;
      if (now - row.last_heartbeat_at > CONNECTION_STALE_AFTER_MS) continue;
      live.push({
        homesteadId: row.id,
        connectionId: row.connection_id,
        connectedAt: row.connected_at,
        socket: ws,
      });
    }
    return live;
  }

  /**
   * Close any other socket still claiming this homestead id, as its registration
   * is taken over.
   *
   * Only reached once the id has been judged unheld — a live holder is refused
   * long before here. What this closes is the leftover: a socket whose process
   * died without a clean close, or one that stopped heartbeating. Left open it
   * would keep sending heartbeats against a row that no longer names it and
   * receive no work, believing all the while that it was serving.
   */
  private supersedeStaleConnections(homesteadId: string, keepConnectionId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(ws);
      if (!attachment || attachment.connectionId === keepConnectionId) continue;
      if (attachment.homesteadId !== homesteadId) continue;
      this.log.warn("Homestead identity reclaimed from a stale connection", {
        event: "homestead.identity_reclaimed",
        homestead_id: homesteadId,
        stale_connection_id: attachment.connectionId,
        connection_id: keepConnectionId,
      });
      this.failPendingAssignments(attachment.connectionId);
      ws.close(HOMESTEAD_SUPERSEDED_CLOSE_CODE, "Replaced by a newer connection");
    }
  }

  /** Fail only the assignments that went out on one connection. */
  private failPendingAssignments(connectionId: string): void {
    for (const pending of this.pendingAssignments.values()) {
      if (pending.connectionId === connectionId) pending.resolve("disconnected");
    }
  }

  /**
   * Append an audit record without making the protocol path wait on D1.
   * `waitUntil` keeps the object alive until it settles; a write that fails is
   * logged at error level by {@link writeAuditRecord}, never dropped quietly.
   */
  private audit(input: AuditRecordInput): void {
    this.ctx.waitUntil(writeAuditRecord(this.db, this.log, input));
  }

  private getAttachment(ws: WebSocket): SocketAttachment | null {
    const attachment: unknown = ws.deserializeAttachment();
    return isSocketAttachment(attachment) ? attachment : null;
  }

  private rejectSocket(ws: WebSocket, code: HomesteadError["code"], message: string): void {
    this.refuseSocket(ws, code, message, 4002);
  }

  /**
   * Tell a connection why it is being closed, then close it.
   *
   * The close code is a parameter because a homestead has to act differently on
   * each: a protocol error (4002) is its own bug, while a refused identity
   * means another process holds the id and reconnecting immediately only
   * produces a hot loop.
   */
  private refuseSocket(
    ws: WebSocket,
    code: HomesteadError["code"],
    message: string,
    closeCode: number
  ): void {
    ws.send(
      JSON.stringify({
        type: "homestead.error",
        protocolVersion: OUTPOST_PROTOCOL_VERSION,
        code,
        message,
      } satisfies HomesteadError)
    );
    ws.close(closeCode, message);
  }
}
