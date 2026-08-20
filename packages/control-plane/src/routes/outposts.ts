import {
  homesteadRecoveryRequestSchema,
  homesteadRecoveryResponseSchema,
  outpostIdentifierSchema,
} from "@openoutposts/outpost-protocol";

import { requireOutpostOwner } from "../auth/outpost-ownership";
import { actorFromPrincipal, writeAuditRecord } from "../db/audit-log";
import { OutpostStore, type OutpostRecord } from "../db/outposts";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { error, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("router:outposts");

function outpostStub(env: Env, match: RegExpMatchArray) {
  const parsedId = outpostIdentifierSchema.safeParse(match.groups?.id);
  if (!parsedId.success) return null;
  return env.OUTPOST.get(env.OUTPOST.idFromName(parsedId.data));
}

/**
 * Resolve the identity a lease is being taken for, and refuse the grant unless
 * that identity owns the machine.
 *
 * A lease arrives on the homestead's own credential, which names no
 * person; the person is the owner of the product session the lease is for, and
 * that lives in `sessions.user_id`. Resolving it once per grant is what lets
 * the outpost Durable Object attribute every subsequent command under that
 * lease without another database read.
 *
 * Whatever the caller put in an `actor` field is discarded — attribution that a
 * caller could assert would not be attribution.
 *
 * An unresolvable owner is a refusal, not an unattributed grant. A lease is
 * shell access on someone's hardware, and a session nobody owns cannot
 * establish that anybody is entitled to it. Session creation already refuses to
 * select a machine for an ownerless session, so no legitimate request reaches
 * here without an owner.
 */
async function withResolvedLeaseActor(
  body: string,
  outpostId: string,
  ctx: RequestContext
): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON; the Durable Object owns rejecting it and says so precisely.
    return { ok: true, body };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, body };
  }

  const request = parsed as Record<string, unknown>;
  const productSessionId = request.productSessionId;
  let ownerUserId: string | null = null;

  if (typeof productSessionId === "string" && productSessionId.length > 0) {
    const session = await ctx.db
      .prepare("SELECT user_id FROM sessions WHERE id = ?")
      .bind(productSessionId)
      .first<{ user_id: string | null }>();
    ownerUserId = session?.user_id ?? null;
    if (!ownerUserId) {
      logger.warn("Lease actor unresolved", {
        event: "lease.actor_unresolved",
        session_id: productSessionId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }
  }

  // The owner resolved above is the only thing that makes this grant legitimate.
  // Session creation checked that this user owns this machine, but that was one
  // check at one moment; a lease is a fresh grant of shell access and has to
  // stand on its own. Refusing here is what stops the deployment's internal
  // credential — which names no person and is accepted on every machine route —
  // from being a key to every machine in the fleet.
  const owned =
    ownerUserId === null ? null : await new OutpostStore(ctx.db).getOwned(outpostId, ownerUserId);
  if (!owned || owned.confirmed_at === null) {
    logger.warn("Lease refused: outpost not owned by the session owner", {
      event: "lease.ownership_denied",
      outpost_id: outpostId,
      session_id: typeof productSessionId === "string" ? productSessionId : null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    // Refused before the Durable Object, so the DO's own refusal record cannot
    // cover it. A denial of shell access belongs in the same log as a grant.
    await writeAuditRecord(ctx.db, logger, {
      action: "lease.rejected",
      outcome: "denied",
      actor: actorFromPrincipal(ctx.principal, ownerUserId),
      sessionId: typeof productSessionId === "string" ? productSessionId : null,
      outpostId,
      reason: "session_unowned",
    });
    return {
      ok: false,
      response: error("This outpost is not available to the session's owner", 403),
    };
  }

  return {
    ok: true,
    body: JSON.stringify({
      ...request,
      actor: actorFromPrincipal(ctx.principal, ownerUserId),
    }),
  };
}

async function handleGetOutpost(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const stub = outpostStub(env, match);
  if (!stub) return error("Invalid outpost ID", 400);
  return stub.fetch("http://internal/status");
}

async function handleCreateLease(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsedId = outpostIdentifierSchema.safeParse(match.groups?.id);
  if (!parsedId.success) return error("Invalid outpost ID", 400);
  const stub = env.OUTPOST.get(env.OUTPOST.idFromName(parsedId.data));

  const resolved = await withResolvedLeaseActor(await request.text(), parsedId.data, ctx);
  if (!resolved.ok) return resolved.response;

  return stub.fetch("http://internal/leases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: resolved.body,
  });
}

async function handleReleaseLease(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const stub = outpostStub(env, match);
  if (!stub) return error("Invalid outpost ID", 400);
  const leaseId = match.groups?.leaseId;
  if (!leaseId) return error("Invalid lease ID", 400);
  return stub.fetch(`http://internal/leases/${encodeURIComponent(leaseId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}

function forwardLeaseAction(action: "renew" | "cancel-work" | "context") {
  return async (
    request: Request,
    env: Env,
    match: RegExpMatchArray,
    _ctx: RequestContext
  ): Promise<Response> => {
    const stub = outpostStub(env, match);
    if (!stub) return error("Invalid outpost ID", 400);
    const leaseId = match.groups?.leaseId;
    if (!leaseId) return error("Invalid lease ID", 400);
    return stub.fetch(`http://internal/leases/${encodeURIComponent(leaseId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    });
  };
}

async function handleToolCall(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const stub = outpostStub(env, match);
  if (!stub) return error("Invalid outpost ID", 400);
  return stub.fetch("http://internal/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}

async function handleHomesteadStatus(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.HOMESTEAD) return error("Homestead registry is not configured", 503);
  return env.HOMESTEAD.get(env.HOMESTEAD.idFromName("default")).fetch("http://internal/status");
}

/**
 * Tell a signed-in owner whether any homestead can currently accept work.
 * The internal status carries identities, versions, harnesses, catalog
 * summaries, and timestamps; none of those are needed by first-use preflight.
 */
async function handleHomesteadReadiness(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  requireOutpostOwner(ctx);
  if (!env.HOMESTEAD) return error("Homestead registry is not configured", 503);

  const response = await env.HOMESTEAD.get(env.HOMESTEAD.idFromName("default")).fetch(
    "http://internal/status"
  );
  if (!response.ok) return error("Unable to read homestead readiness", 502);

  const status = (await response.json().catch(() => null)) as { connected?: unknown } | null;
  if (typeof status?.connected !== "boolean") {
    return error("Homestead registry returned an invalid status", 502);
  }
  return Response.json(
    { connected: status.connected },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Rotate the two in-memory credentials a homestead needs after a restart.
 *
 * Authentication is enforced by the router's internal-only outpost branch.
 * The session Durable Object owns the generation check and atomic hash swap;
 * this route only validates and transports the versioned exchange.
 */
async function handleSessionRecovery(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = homesteadRecoveryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error("Invalid or unsupported recovery request", 400);

  const response = await createSessionRuntimeClient(env, ctx).fetch(
    parsed.data.productSessionId,
    SessionInternalPaths.rotateSandboxCredentials,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    }
  );
  if (!response.ok) {
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const body = homesteadRecoveryResponseSchema.safeParse(await response.json().catch(() => null));
  if (!body.success) return error("Session recovery returned an invalid response", 502);
  return new Response(JSON.stringify(body.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * List the machines the requesting person owns.
 *
 * There is no unfiltered view any more. It existed for a credential that named
 * nobody, and every request now arrives with a principal: a signed-in user, who
 * sees their own rows, or the homestead, which is refused here because driving
 * machines does not include browsing a fleet.
 */
async function handleListOutposts(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = new OutpostStore(ctx.db);
  const rows = await store.listForOwner(requireOutpostOwner(ctx));
  return Response.json({
    outposts: rows.map((row: OutpostRecord) => ({
      id: row.id,
      name: row.name,
      workerVersion: row.worker_version,
      platform: row.platform,
      architecture: row.architecture,
      connected: row.connected === 1,
      connectedAt: new Date(row.connected_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      disconnectedAt:
        row.disconnected_at === null ? null : new Date(row.disconnected_at).toISOString(),
      confirmed: row.confirmed_at !== null,
    })),
  });
}

export const outpostRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/outposts"),
    handler: handleListOutposts,
  },
  {
    method: "GET",
    pattern: parsePattern("/homesteads"),
    handler: handleHomesteadStatus,
  },
  {
    method: "GET",
    pattern: parsePattern("/homesteads/readiness"),
    handler: handleHomesteadReadiness,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/session-recovery"),
    handler: handleSessionRecovery,
  },
  {
    method: "GET",
    pattern: parsePattern("/outposts/:id"),
    handler: handleGetOutpost,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/leases"),
    handler: handleCreateLease,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/outposts/:id/leases/:leaseId"),
    handler: handleReleaseLease,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/leases/:leaseId/renew"),
    handler: forwardLeaseAction("renew"),
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/leases/:leaseId/cancel-work"),
    handler: forwardLeaseAction("cancel-work"),
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/leases/:leaseId/context"),
    handler: forwardLeaseAction("context"),
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/tool"),
    handler: handleToolCall,
  },
];
