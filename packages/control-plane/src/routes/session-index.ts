import { isCanonicalUserId, type SessionStatus } from "@open-inspect/shared";
import { SessionIndexStore } from "../db/session-index";
import { SessionInternalPaths } from "../session/contracts";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import type { Env } from "../types";

const SESSION_STATUSES: SessionStatus[] = [
  "created",
  "active",
  "completed",
  "failed",
  "archived",
  "cancelled",
];

function parseSessionStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  return SESSION_STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : undefined;
}

function parseCreatedByFilters(searchParams: URLSearchParams): string[] | Response {
  const values = searchParams.getAll("createdBy");
  const userIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!isCanonicalUserId(value)) {
      return error("Invalid createdBy", 400);
    }

    if (!seen.has(value)) {
      seen.add(value);
      userIds.push(value);
    }
  }

  return userIds;
}

/**
 * Narrow the requested creator filter to what this principal may see.
 *
 * For a service principal `createdBy` is what it has always been: an optional
 * filter over the whole index. For a user credential it is an authorization
 * boundary — the listing is scoped to that user's own canonical id whether or
 * not they asked, and a request that explicitly named someone else is refused
 * rather than quietly narrowed to themselves.
 */
function scopeCreatedByToPrincipal(ctx: RequestContext, requested: string[]): string[] | Response {
  const principal = ctx.principal;
  if (principal?.kind !== "user") return requested;

  const canonicalUserId = principal.user.canonicalUserId;
  if (!canonicalUserId) {
    // User principals always carry a canonical id (it is read off the token
    // row). Fail closed rather than list the whole index if that ever breaks.
    return error("User principal has no canonical id", 500);
  }

  const foreign = requested.filter((userId) => userId !== canonicalUserId);
  if (foreign.length > 0) {
    return error("Sessions can only be listed for the authenticated user", 403);
  }

  return [canonicalUserId];
}

function parsePaginationLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parsePaginationOffset(value: string | null): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

async function handleListSessions(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const limit = parsePaginationLimit(url.searchParams.get("limit"));
  const offset = parsePaginationOffset(url.searchParams.get("offset"));
  const statusParam = url.searchParams.get("status");
  const excludeStatusParam = url.searchParams.get("excludeStatus");
  const status = parseSessionStatus(statusParam);
  const excludeStatus = parseSessionStatus(excludeStatusParam);
  const createdByUserIds = parseCreatedByFilters(url.searchParams);

  if (statusParam && !status) {
    return error("Invalid status", 400);
  }

  if (excludeStatusParam && !excludeStatus) {
    return error("Invalid excludeStatus", 400);
  }

  if (createdByUserIds instanceof Response) {
    return createdByUserIds;
  }

  const scopedUserIds = scopeCreatedByToPrincipal(ctx, createdByUserIds);
  if (scopedUserIds instanceof Response) {
    return scopedUserIds;
  }

  const store = new SessionIndexStore(ctx.db);
  const result = await store.list({
    status,
    excludeStatus,
    createdByUserIds: scopedUserIds,
    limit,
    offset,
  });

  return json({
    sessions: result.sessions,
    hasMore: result.hasMore,
  });
}

/**
 * Deletes a session and everything it holds.
 *
 * This used to drop the index row alone: the Durable Object kept its whole
 * database, its alarm, and every media object it had uploaded, unreachable but
 * never released. A user who asked for a session to be deleted got it hidden.
 *
 * Ownership is not checked here. `authorizeSessionAccess` runs at the router
 * for every path beneath `/sessions/:id`, which includes this one, and a
 * second copy of the rule in this handler would be a second answer to the same
 * question — free to drift from the first. Now that the operation is
 * destructive, that gate is load-bearing rather than cosmetic, and
 * `test/integration/session-ownership.test.ts` pins it to this route by name.
 */
async function handleDeleteSession(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  // Storage first, index row second. A purge that fails leaves the row in
  // place so the delete can be retried; the reverse order would strand the
  // Durable Object with nothing left pointing at it, which is the leak this
  // change exists to close.
  const purged = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.purge, {
    method: "POST",
  });
  if (!purged.ok) {
    return error("Session storage purge failed", 502);
  }

  await new SessionIndexStore(ctx.db).delete(sessionId);

  return json({ status: "deleted", sessionId });
}

export const sessionIndexRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/sessions"), handler: handleListSessions },
  sessionRoute({
    method: "DELETE",
    pattern: parsePattern("/sessions/:id"),
    handler: handleDeleteSession,
  }),
];
