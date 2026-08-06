/**
 * Session ownership: a user credential may only reach a session it owns.
 *
 * A prompt drives the harness, and the harness drives the outpost bash tool on
 * the session owner's own machine. So `/sessions/:id/*` is an execution door on
 * someone's hardware exactly as much as `/outposts/*` is, and it has to be
 * closed the same way. Before this gate existed, every session-scoped handler
 * took the session id straight from the path: the author was derived from the
 * verified principal, but nothing ever asked whether that principal owned the
 * session it was addressing.
 *
 * The owner is the `sessions.user_id` column, written once at initialization
 * from the verified creator. It is never read from the request — not from a
 * body field, not from a query filter, not from the Durable Object's
 * participant list. A session whose row records no owner is refused rather than
 * attributed to the caller: fabricating ownership would make the invariant
 * conditional on a fallback, which is the same silent-substitution failure this
 * codebase is being swept for.
 *
 * Only user principals are gated. Service principals (the web BFF's token
 * endpoints, the Slack/GitHub/Linear bots, the Modal scheduler) act for the
 * deployment rather than for a browser session, and sandbox principals are
 * already bound to one session id by the token the router verified against that
 * session's own Durable Object. Neither can address a session by picking an id.
 */

import { createLogger } from "../logger";
import { error, type RequestContext } from "../routes/shared";

const logger = createLogger("auth:session-ownership");

/**
 * Matches every session-scoped path — `/sessions/:id` and everything beneath
 * it. Collection paths (`GET /sessions`, `POST /sessions`) name no session and
 * are deliberately excluded; the listing scopes itself to the caller instead
 * (see routes/session-index.ts).
 */
const SESSION_SCOPED_PATH = /^\/sessions\/([^/]+)(?:\/|$)/;

/** The session a path addresses, or null when it addresses none. */
export function sessionIdFromPath(path: string): string | null {
  return SESSION_SCOPED_PATH.exec(path)?.[1] ?? null;
}

function denyLog(
  reason: "session_missing" | "session_unowned" | "not_owner",
  sessionId: string,
  ctx: RequestContext,
  path: string
): void {
  logger.warn("Auth failed: session ownership", {
    event: "auth.session_ownership_denied",
    reason,
    session_id: sessionId,
    http_path: path,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

/**
 * Authorize the request's principal against the session its path names.
 *
 * Returns null when the request may proceed, or the response to return
 * immediately. Runs once at the router, so a session-scoped route added later
 * inherits the check instead of having to remember it.
 *
 * A caller that does not own the session is told so (403) rather than shown a
 * 404: session ids are unguessable, so the existence of one the caller already
 * named is not a useful disclosure, and a distinguishable refusal is what makes
 * a misrouted client diagnosable instead of mysterious.
 */
export async function authorizeSessionAccess(
  path: string,
  ctx: RequestContext
): Promise<Response | null> {
  const principal = ctx.principal;
  if (principal?.kind !== "user") return null;

  const sessionId = sessionIdFromPath(path);
  if (!sessionId) return null;

  const row = await ctx.db
    .prepare("SELECT user_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ user_id: string | null }>();

  if (!row) {
    denyLog("session_missing", sessionId, ctx, path);
    return error("Session not found", 404);
  }

  if (!row.user_id) {
    // Sessions predating owner attribution, and automation runs whose
    // automation carries no resolvable user, have a null owner. There is no
    // honest way to decide whether this caller is that owner, so the answer is
    // no — for everyone, visibly.
    denyLog("session_unowned", sessionId, ctx, path);
    return error("Session has no recorded owner", 403);
  }

  if (row.user_id !== principal.user.canonicalUserId) {
    denyLog("not_owner", sessionId, ctx, path);
    return error("Session belongs to another user", 403);
  }

  return null;
}
