import {
  ANALYTICS_BREAKDOWN_BY,
  ANALYTICS_DAYS,
  type AnalyticsBreakdownBy,
  type AnalyticsDays,
} from "@open-inspect/shared";
import { resolveAnalyticsScope, type AnalyticsScope } from "../auth/analytics-scope";
import { type AnalyticsFilters, AnalyticsStore, HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import {
  type PullRequestAnalyticsFilters,
  PullRequestAnalyticsStore,
} from "../db/pull-request-analytics-store";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

function parseDaysParam(value: string | null): AnalyticsDays | null {
  if (value === null) return 30;

  const parsed = Number(value);
  return ANALYTICS_DAYS.includes(parsed as AnalyticsDays) ? (parsed as AnalyticsDays) : null;
}

function parseBreakdownBy(value: string | null): AnalyticsBreakdownBy | null {
  if (!value) return null;
  return ANALYTICS_BREAKDOWN_BY.includes(value as AnalyticsBreakdownBy)
    ? (value as AnalyticsBreakdownBy)
    : null;
}

function getFilters(days: AnalyticsDays, scope: AnalyticsScope): AnalyticsFilters {
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  return {
    startAt,
    endAt,
    spawnSources: HUMAN_SPAWN_SOURCES,
    ownerUserId: scope.ownerUserId,
  };
}

/**
 * PR analytics is scoped to the PR population itself, so unlike the session
 * analytics it applies no spawn-source filter — automation-produced PRs are
 * output too, surfaced via the source dimension instead. The owner scope is
 * not a dimension and applies to both.
 */
function getPullRequestFilters(
  days: AnalyticsDays,
  scope: AnalyticsScope
): PullRequestAnalyticsFilters {
  const now = Date.now();
  return {
    startAt: now - days * 24 * 60 * 60 * 1000,
    endAt: now,
    now,
    ownerUserId: scope.ownerUserId,
  };
}

/**
 * An analytics handler, which can only be written against a resolved owner
 * scope.
 *
 * The scope is an argument rather than something each handler looks up because
 * that is what makes it structural: every route below is built through
 * {@link scoped}, so the resolution runs exactly once per request in one place,
 * and a handler physically cannot query without a scope in hand — the filter
 * types both require the field.
 */
type ScopedHandler = (
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext,
  scope: AnalyticsScope
) => Promise<Response>;

function scoped(handler: ScopedHandler): Route["handler"] {
  return async (request, env, match, ctx) => {
    const scope = resolveAnalyticsScope(ctx);
    if (scope instanceof Response) return scope;
    return handler(request, env, match, ctx, scope);
  };
}

const handleSummary: ScopedHandler = async (request, _env, _match, ctx, scope) => {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getSummary(getFilters(days, scope)));
};

const handleTimeseries: ScopedHandler = async (request, _env, _match, ctx, scope) => {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getTimeseries(getFilters(days, scope)));
};

const handleBreakdown: ScopedHandler = async (request, _env, _match, ctx, scope) => {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const byParam = url.searchParams.get("by");
  const by = parseBreakdownBy(byParam);
  if (!by) {
    return error(`by must be one of: ${ANALYTICS_BREAKDOWN_BY.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getBreakdown(getFilters(days, scope), by));
};

const handlePullRequests: ScopedHandler = async (request, _env, _match, ctx, scope) => {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new PullRequestAnalyticsStore(ctx.db);
  return json(await store.get(getPullRequestFilters(days, scope)));
};

export const analyticsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/analytics/summary"),
    handler: scoped(handleSummary),
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/timeseries"),
    handler: scoped(handleTimeseries),
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/breakdown"),
    handler: scoped(handleBreakdown),
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/pull-requests"),
    handler: scoped(handlePullRequests),
  },
];
