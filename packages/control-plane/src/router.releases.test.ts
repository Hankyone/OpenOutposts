import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";

/**
 * A worker fetching its own update carries no product credential, so the
 * release routes have to clear the router's authentication gate on their own.
 */
function createEnv(objects: Record<string, string>) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  const get = vi.fn(async (key: string) => {
    const stored = objects[key];
    if (stored === undefined) return null;
    const bytes = new TextEncoder().encode(stored);
    return { body: new Response(bytes).body, size: bytes.byteLength, httpEtag: `"etag-${key}"` };
  });
  return {
    env: {
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(async () => []),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      RELEASES_BUCKET: { get, head: vi.fn(async () => null) },
    },
    get,
  };
}

describe("router release distribution", () => {
  it("serves the manifest without any credential", async () => {
    const { env } = createEnv({ "outpost-worker/stable/manifest.json": '{"schemaVersion":1}' });

    const response = await handleRequest(
      new Request("https://test.local/releases/outpost-worker/stable/manifest.json"),
      env as never
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"schemaVersion":1}');
  });

  // The public exemption covers /releases/outpost-worker/ and nothing wider, so a
  // path invented under /releases stops at the authentication gate.
  it("does not extend the public exemption past the worker prefix", async () => {
    const { env, get } = createEnv({});

    const response = await handleRequest(
      new Request("https://test.local/releases/secrets/token"),
      env as never
    );

    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it("404s a worker key the release layout would never contain", async () => {
    const { env, get } = createEnv({});

    const response = await handleRequest(
      new Request("https://test.local/releases/outpost-worker/beta/manifest.json"),
      env as never
    );

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("still refuses writes through the router", async () => {
    const { env } = createEnv({ "outpost-worker/stable/manifest.json": "{}" });

    const response = await handleRequest(
      new Request("https://test.local/releases/outpost-worker/stable/manifest.json", {
        method: "POST",
      }),
      env as never
    );

    expect(response.status).toBe(405);
  });
});
