import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { releaseRoutes } from "./releases";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";

const MANIFEST = '{"schemaVersion":1}';
const BLOB = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(objects: Record<string, Uint8Array | string>) {
  const get = vi.fn(async (key: string) => {
    const stored = objects[key];
    if (stored === undefined) return null;
    const bytes = typeof stored === "string" ? new TextEncoder().encode(stored) : stored;
    return {
      body: new Response(bytes).body,
      size: bytes.byteLength,
      httpEtag: `"etag-${key}"`,
    };
  });
  const head = vi.fn(async (key: string) => {
    const stored = objects[key];
    if (stored === undefined) return null;
    const bytes = typeof stored === "string" ? new TextEncoder().encode(stored) : stored;
    return { size: bytes.byteLength, httpEtag: `"etag-${key}"` };
  });
  const env = { RELEASES_BUCKET: { get, head } } as unknown as Env;
  return { env, get, head };
}

async function callRoute(env: Env, method: string, path: string): Promise<Response> {
  const route = releaseRoutes.find(
    (candidate) => candidate.method === method && path.match(candidate.pattern)
  );
  if (!route) return new Response("no route", { status: 404 });
  const match = path.match(route.pattern);
  if (!match) throw new Error("route pattern did not match");
  return route.handler(
    new Request(`https://test.local${path}`, { method }),
    env,
    match,
    createContext()
  );
}

describe("worker release routes", () => {
  it("serves the signed manifest with a no-cache header", async () => {
    const { env } = createEnv({ "outpost-worker/stable/manifest.json": MANIFEST });

    const response = await callRoute(env, "GET", "/releases/outpost-worker/stable/manifest.json");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MANIFEST);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    // A cached manifest delays every update on the fleet.
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves the manifest signature", async () => {
    const { env } = createEnv({ "outpost-worker/stable/manifest.json.sig": "c2lnbmF0dXJl" });

    const response = await callRoute(
      env,
      "GET",
      "/releases/outpost-worker/stable/manifest.json.sig"
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("serves binaries and patches as immutable objects", async () => {
    const { env } = createEnv({
      "outpost-worker/blobs/v1.2.0/openoutpost-linux-amd64": BLOB,
      "outpost-worker/patches/v1.1.0_v1.2.0/openoutpost-linux-amd64": BLOB,
    });

    for (const path of [
      "/releases/outpost-worker/blobs/v1.2.0/openoutpost-linux-amd64",
      "/releases/outpost-worker/patches/v1.1.0_v1.2.0/openoutpost-linux-amd64",
    ]) {
      const response = await callRoute(env, "GET", path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("Content-Length")).toBe(String(BLOB.byteLength));
    }
  });

  it("answers HEAD without a body", async () => {
    const { env, get } = createEnv({ "outpost-worker/blobs/v1.2.0/openoutpost-linux-amd64": BLOB });

    const response = await callRoute(
      env,
      "HEAD",
      "/releases/outpost-worker/blobs/v1.2.0/openoutpost-linux-amd64"
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe(String(BLOB.byteLength));
    expect(get).not.toHaveBeenCalled();
  });

  it("404s an object the bucket does not hold", async () => {
    const { env } = createEnv({});

    const response = await callRoute(
      env,
      "GET",
      "/releases/outpost-worker/blobs/v9.9.9/openoutpost-linux-amd64"
    );

    expect(response.status).toBe(404);
  });

  it("refuses writes", async () => {
    const { env, get } = createEnv({ "outpost-worker/stable/manifest.json": MANIFEST });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await callRoute(
        env,
        method,
        "/releases/outpost-worker/stable/manifest.json"
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("never reaches the bucket for a key outside the release layout", async () => {
    const { env, get, head } = createEnv({ "outpost-worker/stable/manifest.json": MANIFEST });

    const paths = [
      "/releases/outpost-worker/blobs/../../secret",
      "/releases/outpost-worker/blobs/./manifest.json",
      "/releases/outpost-worker/beta/manifest.json",
      "/releases/outpost-worker/blobs/v1.2.0",
      "/releases/outpost-worker/blobs/v1.2.0/nested/deeper",
      "/releases/secrets/token",
    ];
    for (const path of paths) {
      const response = await callRoute(env, "GET", path);
      expect(response.status, path).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  it("reports a deployment with no release bucket rather than failing opaquely", async () => {
    const response = await callRoute(
      {} as Env,
      "GET",
      "/releases/outpost-worker/stable/manifest.json"
    );

    expect(response.status).toBe(503);
  });
});
