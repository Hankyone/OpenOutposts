/**
 * The fleet surface an end-user credential may reach.
 *
 * Kept apart from `outposts.ts`, which is the control-plane-internal registry
 * the homestead drives: per-machine status, leases, and tool calls that run
 * shell commands on someone's own hardware. Nothing here grants execution.
 * These routes answer the two questions the machines page asks on behalf of
 * the machine's owner — what is running on it, and remove it — and they are
 * scoped by the same ownership rule as the fleet listing.
 */

import { outpostIdentifierSchema } from "@openoutposts/outpost-protocol";

import { requireOwnedOutpost, requireOutpostOwner } from "../auth/outpost-ownership";
import { actorFromPrincipal, writeAuditRecord } from "../db/audit-log";
import { OutpostStore } from "../db/outposts";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("router:outpost-fleet");

/** One product session currently holding a lease on a machine. */
interface BoundSession {
  leaseId: string;
  productSessionId: string;
  workspacePath: string;
  expiresAt: string;
}

interface OutpostStatusResponse {
  activeLeases?: BoundSession[];
}

function outpostStub(env: Env, match: RegExpMatchArray) {
  const parsedId = outpostIdentifierSchema.safeParse(match.groups?.id);
  if (!parsedId.success) return null;
  return { id: parsedId.data, stub: env.OUTPOST.get(env.OUTPOST.idFromName(parsedId.data)) };
}

/**
 * The product sessions currently bound to one machine.
 *
 * Projected from the outpost DO's active leases — the only record of what a
 * machine is executing — down to the lease fields alone. The rest of the DO's
 * status (capabilities, workspace roots, connection id) stays internal.
 */
async function handleListBoundSessions(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const target = outpostStub(env, match);
  if (!target) return error("Invalid outpost ID", 400);
  await requireOwnedOutpost(ctx, target.id);

  const response = await target.stub.fetch("http://internal/status");
  // A machine that has never registered has no leases to report, which is an
  // answer rather than a failure.
  if (response.status === 404) return json({ sessions: [] });
  if (!response.ok) return error("Unable to read the machine's leases", 502);

  const status = (await response.json()) as OutpostStatusResponse;
  return json({
    sessions: (status.activeLeases ?? []).map((lease) => ({
      leaseId: lease.leaseId,
      productSessionId: lease.productSessionId,
      workspacePath: lease.workspacePath,
      expiresAt: lease.expiresAt,
    })),
  });
}

/**
 * Remove a machine from the fleet.
 *
 * The DO releases the machine's leases and closes its connection first, so the
 * removal is not merely cosmetic, and the advisory directory row goes last.
 * Revocation is written before the live socket is closed. A reconnect racing
 * the removal therefore fails at authentication even if DO cleanup is delayed.
 */
async function handleRemoveOutpost(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const target = outpostStub(env, match);
  if (!target) return error("Invalid outpost ID", 400);

  const ownerUserId = requireOutpostOwner(ctx);
  await requireOwnedOutpost(ctx, target.id);
  const revoked = await new OutpostStore(ctx.db).revokeOwned(target.id, ownerUserId, Date.now());
  if (!revoked) return error("Outpost not found", 404);

  const forgotten = await target.stub.fetch("http://internal/forget", { method: "POST" });
  if (!forgotten.ok) return error("Failed to release the machine's leases", 502);

  // A machine leaving the fleet is a fleet-membership change, and the person
  // who caused it is known here and only here — the Durable Object sees the
  // removal arrive with no principal at all. Written before the response
  // because a removal is rare and the record is the point of the route.
  await writeAuditRecord(ctx.db, logger, {
    action: "outpost.removed",
    outcome: "success",
    actor: actorFromPrincipal(ctx.principal),
    outpostId: target.id,
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  });

  return json({ removed: true, revoked: true });
}

export const outpostFleetRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/outposts/:id/sessions"),
    handler: handleListBoundSessions,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/outposts/:id"),
    handler: handleRemoveOutpost,
  },
];
