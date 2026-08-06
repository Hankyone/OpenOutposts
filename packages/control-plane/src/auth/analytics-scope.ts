/**
 * Analytics scope: which sessions a caller's aggregates are computed over.
 *
 * The `/analytics` routes are not an execution door, so unlike session and
 * automation ownership there is nothing here to refuse — every caller gets an
 * answer. What has to be decided is *whose* rows the answer is computed from.
 * Until now the four handlers aggregated `sessions` and `session_pull_requests`
 * across the whole deployment with no owner predicate at all: titles, repository
 * names, per-user cost, PR URLs and display names of every other person signed
 * in. That is a cross-user disclosure the moment a second user exists, and it is
 * silent — a leak with no error to notice.
 *
 * The rule mirrors the ownership gates: a user credential sees its own sessions
 * (`sessions.user_id` = the caller's canonical id) and nothing else. Service
 * principals act for the deployment, not for a browser session, and keep the
 * deployment-wide view.
 *
 * Sessions whose `user_id` is null — rows predating owner attribution — belong
 * to no one this can resolve and are therefore outside every user-scoped
 * aggregate. Folding them into whoever happens to ask would be exactly the
 * fabricated-ownership fallback the ownership gates refuse.
 *
 * This is a scope, not a gate, so it cannot be enforced from the router: a
 * router-level check can say no, but it cannot narrow a SQL predicate. It is
 * enforced structurally instead — `AnalyticsFilters` and
 * `PullRequestAnalyticsFilters` both declare `ownerUserId` as a REQUIRED field,
 * so a new analytics query cannot be written without deciding, and
 * `routes/analytics.ts` builds every filter from a scope resolved here.
 */

import { createLogger } from "../logger";
import { error, type RequestContext } from "../routes/shared";

const logger = createLogger("auth:analytics-scope");

export interface AnalyticsScope {
  /**
   * The user whose sessions the aggregates cover, or null for the
   * deployment-wide view a service principal gets.
   */
  readonly ownerUserId: string | null;
}

/**
 * Resolve the analytics scope for this request's principal, or the response to
 * return immediately.
 */
export function resolveAnalyticsScope(ctx: RequestContext): AnalyticsScope | Response {
  const principal = ctx.principal;
  if (principal?.kind !== "user") return { ownerUserId: null };

  const canonicalUserId = principal.user.canonicalUserId;
  if (!canonicalUserId) {
    // User principals always carry a canonical id (it is read off the token
    // row). Fail closed rather than compute deployment-wide aggregates if that
    // ever breaks.
    logger.warn("Auth failed: analytics scope", {
      event: "auth.analytics_scope_denied",
      reason: "principal_unresolved",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("User principal has no canonical id", 500);
  }

  return { ownerUserId: canonicalUserId };
}
