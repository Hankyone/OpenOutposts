/**
 * Worker release distribution.
 *
 * Enrolled machines fetch their own updates from here. The repository is
 * private, so GitHub Releases cannot serve an unauthenticated worker; this
 * route fronts the release R2 bucket instead.
 *
 * The route is deliberately public. The objects are the same binaries anyone
 * installing a worker downloads by hand, and integrity does not come from who
 * is asking: the manifest is signed with an offline key the worker embeds, and
 * every blob and patch is checked against a digest that signed manifest names.
 * Requiring a credential here would only mean a worker whose machine identity
 * has drifted could no longer receive the fix for that drift.
 */

import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, type Route } from "./shared";

const logger = createLogger("router:releases");

/**
 * The only object keys this route will serve. Anything else is a 404 —
 * including any key the release tool would never have written.
 */
const RELEASE_KEY_PATTERN =
  /^outpost-worker\/(?:stable\/manifest\.json(?:\.sig)?|blobs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|patches\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;

/** Blobs and patches carry their version in the key and never change. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The manifest is the one mutable object; a stale one delays every update. */
const MANIFEST_CACHE_CONTROL = "no-cache";

const RELEASE_PATH_PREFIX = "/releases/";

function isManifestKey(key: string): boolean {
  return key.endsWith("/manifest.json") || key.endsWith("/manifest.json.sig");
}

function contentTypeFor(key: string): string {
  if (key.endsWith("manifest.json")) return "application/json";
  if (key.endsWith("manifest.json.sig")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/**
 * Extract the object key from the request path, or null when the path could
 * not name a release object.
 *
 * The dot-segment check is not redundant with the pattern above: `..` is made
 * only of characters the pattern's segment class allows, so a key like
 * `blobs/../secret` would match it. R2 treats keys as literal strings and
 * would not traverse, but a key shape the release tool never writes has no
 * business reaching the bucket at all.
 */
function releaseKeyFromPath(path: string): string | null {
  if (!path.startsWith(RELEASE_PATH_PREFIX)) return null;
  const key = path.slice(RELEASE_PATH_PREFIX.length);
  if (!RELEASE_KEY_PATTERN.test(key)) return null;
  if (key.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return key;
}

async function handleRelease(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const bucket = env.RELEASES_BUCKET;
  if (!bucket) {
    logger.error("releases.bucket_missing", { http_path: match[0] });
    return error("Release storage is not configured", 503);
  }

  const key = releaseKeyFromPath(new URL(request.url).pathname);
  if (!key) {
    return error("Not found", 404);
  }

  const cacheControl = isManifestKey(key) ? MANIFEST_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
  const headers = new Headers({
    "Content-Type": contentTypeFor(key),
    "Cache-Control": cacheControl,
  });

  if (request.method === "HEAD") {
    const metadata = await bucket.head(key);
    if (!metadata) return error("Not found", 404);
    headers.set("Content-Length", String(metadata.size));
    headers.set("ETag", metadata.httpEtag);
    return new Response(null, { status: 200, headers });
  }

  const object = await bucket.get(key);
  if (!object) return error("Not found", 404);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

/**
 * Anything but a read is refused outright. Publishing happens through R2
 * credentials held by the release workflow, never through this Worker.
 */
async function handleReleaseMethodNotAllowed(): Promise<Response> {
  const response = error("Method not allowed", 405);
  const headers = new Headers(response.headers);
  headers.set("Allow", "GET, HEAD");
  return new Response(response.body, { status: 405, headers });
}

const RELEASE_PATTERN = /^\/releases\/.+$/;

export const releaseRoutes: Route[] = [
  { method: "GET", pattern: RELEASE_PATTERN, handler: handleRelease },
  { method: "HEAD", pattern: RELEASE_PATTERN, handler: handleRelease },
  { method: "POST", pattern: RELEASE_PATTERN, handler: handleReleaseMethodNotAllowed },
  { method: "PUT", pattern: RELEASE_PATTERN, handler: handleReleaseMethodNotAllowed },
  { method: "PATCH", pattern: RELEASE_PATTERN, handler: handleReleaseMethodNotAllowed },
  { method: "DELETE", pattern: RELEASE_PATTERN, handler: handleReleaseMethodNotAllowed },
];
