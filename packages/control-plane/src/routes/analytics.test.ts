import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsRoutes } from "./analytics";
import { HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import type { RequestContext } from "./shared";
import type { Principal } from "../auth/principal";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const FIXED_NOW = 1_700_000_000_000;

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

vi.mock("../db/analytics-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AnalyticsStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

function getHandler(method: string, path: string) {
  const pathname = new URL(`https://test.local${path}`).pathname;
  for (const route of analyticsRoutes) {
    if (route.method === method && route.pattern.test(pathname)) {
      const match = pathname.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }

  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

const WEB_SERVICE_PRINCIPAL: Principal = { kind: "service", service: "web", actor: null };

const USER_PRINCIPAL: Principal = {
  kind: "user",
  user: {
    provider: "github",
    providerUserId: "583231",
    canonicalUserId: "user-1",
    participantUserId: "user-1",
  },
  tokenId: "token-1",
};

/** A user token whose canonical id never resolved — the fail-closed case. */
const UNRESOLVED_USER_PRINCIPAL: Principal = {
  kind: "user",
  user: {
    provider: "github",
    providerUserId: "583232",
    canonicalUserId: null,
    participantUserId: "user-2",
  },
  tokenId: "token-2",
};

function createCtx(principal: Principal = WEB_SERVICE_PRINCIPAL): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    principal,
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callRoute(method: string, path: string, principal?: Principal): Promise<Response> {
  const { handler, match } = getHandler(method, path);
  return handler(
    new Request(`https://test.local${path}`, { method }),
    createEnv(),
    match,
    createCtx(principal)
  );
}

describe("analytics route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("GET /analytics/summary", () => {
    it("defaults days to 30", async () => {
      mockStore.getSummary.mockResolvedValue({
        totalSessions: 12,
        activeUsers: 4,
        totalCost: 1.5,
        avgCost: 0.125,
        totalPrs: 2,
        statusBreakdown: {
          created: 1,
          active: 2,
          completed: 5,
          failed: 2,
          archived: 1,
          cancelled: 1,
        },
      });

      const response = await callRoute("GET", "/analytics/summary");
      expect(response.status).toBe(200);
      expect(mockStore.getSummary).toHaveBeenCalledWith({
        startAt: FIXED_NOW - 30 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
        spawnSources: HUMAN_SPAWN_SOURCES,
        ownerUserId: null,
      });
    });

    it("returns 400 for invalid days", async () => {
      const response = await callRoute("GET", "/analytics/summary?days=31");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "days must be one of: 7, 14, 30, 90",
      });
      expect(mockStore.getSummary).not.toHaveBeenCalled();
    });
  });

  describe("GET /analytics/timeseries", () => {
    it("passes the requested range to the store", async () => {
      mockStore.getTimeseries.mockResolvedValue({ series: [] });

      const response = await callRoute("GET", "/analytics/timeseries?days=14");
      expect(response.status).toBe(200);
      expect(mockStore.getTimeseries).toHaveBeenCalledWith({
        startAt: FIXED_NOW - 14 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
        spawnSources: HUMAN_SPAWN_SOURCES,
        ownerUserId: null,
      });
    });
  });

  describe("GET /analytics/breakdown", () => {
    it("requires a valid by parameter", async () => {
      const response = await callRoute("GET", "/analytics/breakdown?days=30");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "by must be one of: user, repo",
      });
    });

    it("returns 400 for invalid by values", async () => {
      const response = await callRoute("GET", "/analytics/breakdown?days=30&by=status");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "by must be one of: user, repo",
      });
      expect(mockStore.getBreakdown).not.toHaveBeenCalled();
    });
  });

  describe("owner scope", () => {
    it("scopes every aggregate to a user credential's own sessions", async () => {
      mockStore.getSummary.mockResolvedValue({});
      mockStore.getTimeseries.mockResolvedValue({ series: [] });
      mockStore.getBreakdown.mockResolvedValue({ entries: [] });

      await callRoute("GET", "/analytics/summary", USER_PRINCIPAL);
      await callRoute("GET", "/analytics/timeseries", USER_PRINCIPAL);
      await callRoute("GET", "/analytics/breakdown?by=user", USER_PRINCIPAL);

      for (const spy of [mockStore.getSummary, mockStore.getTimeseries, mockStore.getBreakdown]) {
        expect(spy.mock.calls[0][0]).toMatchObject({ ownerUserId: "user-1" });
      }
    });

    it("leaves a service principal's view deployment-wide", async () => {
      mockStore.getSummary.mockResolvedValue({});

      await callRoute("GET", "/analytics/summary", WEB_SERVICE_PRINCIPAL);

      expect(mockStore.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({ ownerUserId: null })
      );
    });

    it("refuses rather than aggregating everything when a user has no canonical id", async () => {
      const response = await callRoute("GET", "/analytics/summary", UNRESOLVED_USER_PRINCIPAL);

      expect(response.status).toBe(500);
      expect(mockStore.getSummary).not.toHaveBeenCalled();
    });
  });
});
