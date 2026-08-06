/**
 * Analytics owner scoping at the worker edge.
 *
 * The four `/analytics` routes aggregate `sessions` and `session_pull_requests`
 * across the whole deployment. Unlike the session and automation gates there is
 * no shell behind them, but there is no error either: a second signed-in user
 * used to receive every other person's session counts, spend, repository names,
 * display names and PR URLs, silently, as a normal 200.
 *
 * The refusal here is exclusion rather than a 403 — the caller gets an answer,
 * computed only over their own rows — so these tests assert on the numbers, and
 * assert that the deployment-wide view a service principal gets is unchanged.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsPullRequestsResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";
import { SessionIndexStore } from "../../src/db/session-index";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "../../src/db/session-pull-request-store";
import { cleanD1Tables } from "./cleanup";
import { createSignedInUser, serviceFetch } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

function userFetch(accessToken: string, path: string): Promise<Response> {
  return SELF.fetch(`https://test.local${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function seedSession(input: {
  id: string;
  userId: string | null;
  scmLogin?: string | null;
  repoName?: string;
  totalCost: number;
  prCount?: number;
  createdAt: number;
}): Promise<void> {
  const store = new SessionIndexStore(env.DB);
  await store.create({
    id: input.id,
    title: input.id,
    repoOwner: "acme",
    repoName: input.repoName ?? "web-app",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    spawnSource: "user",
    scmLogin: input.scmLogin ?? null,
    userId: input.userId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  await store.updateMetrics(input.id, {
    totalCost: input.totalCost,
    activeDurationMs: 1_000,
    messageCount: 1,
    prCount: input.prCount ?? 0,
  });
}

function makePrRecord(
  overrides: Partial<SessionPullRequestRecord> &
    Pick<SessionPullRequestRecord, "artifactId" | "sessionId" | "prNumber">
): SessionPullRequestRecord {
  const now = Date.now();
  return {
    repositoryExternalId: "9001",
    repoOwner: "acme",
    repoName: "web-app",
    url: `https://github.com/acme/web-app/pull/${overrides.prNumber}`,
    lifecycleState: "open",
    isDraft: false,
    headBranch: `openoutposts/${overrides.sessionId}`,
    baseBranch: "main",
    headSha: null,
    providerCreatedAt: now - DAY_MS,
    providerUpdatedAt: now - DAY_MS,
    mergedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("analytics owner scoping", () => {
  let alice: { userId: string; accessToken: string };
  let bob: { userId: string; accessToken: string };
  const now = Date.now();
  const inWindow = now - 2 * DAY_MS;

  beforeEach(async () => {
    await cleanD1Tables();
    alice = await createSignedInUser("300001");
    bob = await createSignedInUser("300002");

    await seedSession({ id: "s-alice-1", userId: alice.userId, totalCost: 1, createdAt: inWindow });
    await seedSession({ id: "s-alice-2", userId: alice.userId, totalCost: 2, createdAt: inWindow });
    await seedSession({
      id: "s-bob-1",
      userId: bob.userId,
      repoName: "bobs-secret-repo",
      totalCost: 40,
      createdAt: inWindow,
    });
    // A row predating owner attribution: it belongs to nobody this can resolve,
    // so it must appear in no user's aggregates rather than be handed to
    // whoever asks.
    await seedSession({
      id: "s-unowned",
      userId: null,
      scmLogin: "ghost",
      totalCost: 500,
      createdAt: inWindow,
    });
  });

  describe("GET /analytics/summary", () => {
    it("counts only the caller's own sessions", async () => {
      const response = await userFetch(alice.accessToken, "/analytics/summary?days=7");

      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsSummaryResponse>();
      expect(body.totalSessions).toBe(2);
      expect(body.totalCost).toBe(3);
      expect(body.activeUsers).toBe(1);
    });

    it("shows a second signed-in user nothing of the first", async () => {
      const response = await userFetch(bob.accessToken, "/analytics/summary?days=7");

      const body = await response.json<AnalyticsSummaryResponse>();
      expect(body.totalSessions).toBe(1);
      expect(body.totalCost).toBe(40);
    });

    it("still gives a service principal the deployment-wide view", async () => {
      const response = await serviceFetch("https://test.local/analytics/summary?days=7");

      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsSummaryResponse>();
      expect(body.totalSessions).toBe(4);
      expect(body.totalCost).toBe(543);
    });
  });

  describe("GET /analytics/breakdown", () => {
    it("returns only the caller's own row on the user dimension", async () => {
      const response = await userFetch(alice.accessToken, "/analytics/breakdown?days=7&by=user");

      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsBreakdownResponse>();
      expect(body.entries.map((entry) => entry.key)).toEqual([alice.userId]);
    });

    it("does not leak another user's repository names on the repo dimension", async () => {
      const response = await userFetch(alice.accessToken, "/analytics/breakdown?days=7&by=repo");

      const body = await response.json<AnalyticsBreakdownResponse>();
      expect(body.entries.map((entry) => entry.key)).toEqual(["acme/web-app"]);
    });

    it("still shows a service principal every user", async () => {
      const response = await serviceFetch("https://test.local/analytics/breakdown?days=7&by=user");

      const body = await response.json<AnalyticsBreakdownResponse>();
      expect(body.entries.length).toBeGreaterThan(1);
    });
  });

  describe("GET /analytics/timeseries", () => {
    it("groups only the caller's own sessions", async () => {
      const response = await userFetch(alice.accessToken, "/analytics/timeseries?days=7");

      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsTimeseriesResponse>();
      const total = body.series.reduce(
        (sum, point) => sum + Object.values(point.groups).reduce((a, b) => a + b, 0),
        0
      );
      expect(total).toBe(2);
    });
  });

  describe("GET /analytics/pull-requests", () => {
    beforeEach(async () => {
      const prs = new SessionPullRequestStore(env.DB);
      await prs.upsert(makePrRecord({ artifactId: "pr-a1", sessionId: "s-alice-1", prNumber: 1 }));
      await prs.upsert(
        makePrRecord({
          artifactId: "pr-b1",
          sessionId: "s-bob-1",
          prNumber: 2,
          repoName: "bobs-secret-repo",
          url: "https://github.com/acme/bobs-secret-repo/pull/2",
        })
      );
      await prs.upsert(makePrRecord({ artifactId: "pr-u1", sessionId: "s-unowned", prNumber: 3 }));
    });

    it("reports only pull requests from the caller's own sessions", async () => {
      const response = await userFetch(alice.accessToken, "/analytics/pull-requests?days=7");

      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsPullRequestsResponse>();
      expect(body.funnel.created).toBe(1);
      expect(body.repos.map((repo) => repo.key)).toEqual(["acme/web-app"]);
      expect(body.prSessionCost).toBe(1);
      // Open inventory ignores the window but must not ignore the owner.
      expect(body.openInventory.total).toBe(1);
    });

    it("shows a second signed-in user only their own", async () => {
      const response = await userFetch(bob.accessToken, "/analytics/pull-requests?days=7");

      const body = await response.json<AnalyticsPullRequestsResponse>();
      expect(body.repos.map((repo) => repo.key)).toEqual(["acme/bobs-secret-repo"]);
      expect(body.prSessionCost).toBe(40);
    });

    it("still gives a service principal the deployment-wide view", async () => {
      const response = await serviceFetch("https://test.local/analytics/pull-requests?days=7");

      const body = await response.json<AnalyticsPullRequestsResponse>();
      expect(body.funnel.created).toBe(3);
      expect(body.openInventory.total).toBe(3);
    });
  });
});
