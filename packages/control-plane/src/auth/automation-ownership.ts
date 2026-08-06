/**
 * Automation ownership: a user credential may only reach an automation it owns.
 *
 * An automation is a stored instruction plus a stored identity. `automations.
 * user_id` is replayed by the scheduler as the session identity of every run it
 * fires, so an automation is a standing grant to start sessions **as** that
 * person — on that person's outposts, with that person's provider credentials.
 * Editing one is therefore not a settings change; it is arranging for someone
 * else's machine to run your instructions under their name. Invoking one is
 * pulling that trigger immediately. Before this gate existed, every
 * `/automations/:id` handler took the id straight from the path and never asked
 * whether the caller owned the row.
 *
 * The owner is the `automations.user_id` column, resolved fail-closed from the
 * verified principal at create time (see routes/automations.ts) and never read
 * from a request afterwards. A row that records no owner is refused rather than
 * attributed to the caller — the same rule, and the same reason, as
 * session-ownership.ts.
 *
 * Only user principals are gated. Service principals (the bots, the Modal
 * scheduler) act for the deployment rather than for a browser session, and the
 * automation engine itself never travels this path at all: the schedulers reach
 * SchedulerDO through a Durable Object binding, and the webhook triggers
 * (`/webhooks/automation/:id`, `/webhooks/sentry/:id`) authenticate with the
 * automation's own key on public routes. Nothing that fires an automation on
 * schedule or on event passes through here.
 */

import { createLogger } from "../logger";
import { error, type RequestContext } from "../routes/shared";

const logger = createLogger("auth:automation-ownership");

/**
 * Matches every automation-scoped path — `/automations/:id` and everything
 * beneath it. Collection paths (`GET /automations`, `POST /automations`) name
 * no automation and are deliberately excluded; the listing scopes itself to the
 * caller and creation derives the owner from the principal (see
 * routes/automations.ts).
 */
const AUTOMATION_SCOPED_PATH = /^\/automations\/([^/]+)(?:\/|$)/;

/** The automation a path addresses, or null when it addresses none. */
export function automationIdFromPath(path: string): string | null {
  return AUTOMATION_SCOPED_PATH.exec(path)?.[1] ?? null;
}

function denyLog(
  reason: "automation_missing" | "automation_unowned" | "not_owner",
  automationId: string,
  ctx: RequestContext,
  path: string
): void {
  logger.warn("Auth failed: automation ownership", {
    event: "auth.automation_ownership_denied",
    reason,
    automation_id: automationId,
    http_path: path,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

/**
 * Authorize the request's principal against the automation its path names.
 *
 * Returns null when the request may proceed, or the response to return
 * immediately. Runs once at the router, so an automation-scoped route added
 * later inherits the check instead of having to remember it.
 *
 * Soft-deleted rows are treated as absent, matching every handler's own
 * `getById`, so the gate's 404 and the handler's 404 are the same answer.
 */
export async function authorizeAutomationAccess(
  path: string,
  ctx: RequestContext
): Promise<Response | null> {
  const principal = ctx.principal;
  if (principal?.kind !== "user") return null;

  const automationId = automationIdFromPath(path);
  if (!automationId) return null;

  const row = await ctx.db
    .prepare("SELECT user_id FROM automations WHERE id = ? AND deleted_at IS NULL")
    .bind(automationId)
    .first<{ user_id: string | null }>();

  if (!row) {
    denyLog("automation_missing", automationId, ctx, path);
    return error("Automation not found", 404);
  }

  if (!row.user_id) {
    // Automations created before owner attribution, and any whose creator could
    // not be resolved to a canonical user, have a null owner. There is no
    // honest way to decide whether this caller is that owner, so the answer is
    // no — for everyone, visibly.
    denyLog("automation_unowned", automationId, ctx, path);
    return error("Automation has no recorded owner", 403);
  }

  if (row.user_id !== principal.user.canonicalUserId) {
    denyLog("not_owner", automationId, ctx, path);
    return error("Automation belongs to another user", 403);
  }

  return null;
}

/**
 * The owner filter a listing must apply for this principal: the caller's own
 * canonical id for a user credential, or null for a service principal acting
 * for the deployment.
 *
 * A user principal always carries a canonical id (it is read off the token
 * row). If that ever breaks, refuse rather than list the whole table — an
 * unscoped listing is exactly the leak this closes.
 */
export function automationOwnerFilterFor(ctx: RequestContext): string | null | Response {
  const principal = ctx.principal;
  if (principal?.kind !== "user") return null;

  const canonicalUserId = principal.user.canonicalUserId;
  if (!canonicalUserId) {
    logger.warn("Auth failed: user principal has no canonical id", {
      event: "auth.automation_ownership_denied",
      reason: "principal_unresolved",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("User principal has no canonical id", 500);
  }

  return canonicalUserId;
}
