/**
 * OpenOutposts Control Plane
 *
 * Cloudflare Workers entry point with Durable Objects for session management.
 */

import { handleRequest } from "./router";
import { createLogger } from "./logger";
import type { Env } from "./types";
import { outpostIdentifierSchema } from "@openoutposts/outpost-protocol";
import { verifyOutpostEnrollmentToken, verifyOutpostMachineProof } from "./auth/outpost";
import { consumeServiceNonce } from "./auth/service-nonce";
import type { OutpostRecord } from "./db/outposts";
import {
  ACTOR_HEADER,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared";

const logger = createLogger("worker");

// Re-export Durable Objects for Cloudflare to discover
export { SessionDO } from "./session/durable-object";
export { SchedulerDO } from "./scheduler/durable-object";
export { OutpostDO } from "./outpost/durable-object";
export { HomesteadDO } from "./homestead/durable-object";

/**
 * Worker fetch handler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for session
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() === "websocket") {
      if (url.pathname.startsWith("/outposts/")) {
        return handleOutpostWebSocket(request, env, url);
      }
      if (url.pathname === "/homesteads/connect") {
        return handleHomesteadWebSocket(request, env, url);
      }
      return handleWebSocket(request, env, url);
    }

    // Regular API request — logged by the router with requestId and timing
    return handleRequest(request, env, ctx);
  },

  /**
   * Cron trigger handler — wakes the SchedulerDO to process overdue automations.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.SCHEDULER) {
      logger.debug("SCHEDULER binding not configured, skipping scheduled tick");
      return;
    }

    // Always wake the SchedulerDO — it runs both the recovery sweep
    // (orphaned/timed-out runs) and processes overdue automations.
    const doId = env.SCHEDULER.idFromName("global-scheduler");
    const stub = env.SCHEDULER.get(doId);

    await stub.fetch("http://internal/internal/tick", { method: "POST" });
  },
};

async function handleOutpostWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  const match = url.pathname.match(/^\/outposts\/([^/]+)\/connect$/);
  const parsedId = outpostIdentifierSchema.safeParse(match?.[1]);
  if (!parsedId.success) return new Response("Invalid outpost WebSocket path", { status: 400 });

  // eslint-disable-next-line no-restricted-syntax -- composition root: the WebSocket entrypoint's one DB binding read
  const db = env.DB;
  const outpost = await db
    .prepare("SELECT * FROM outposts WHERE id = ?")
    .bind(parsedId.data)
    .first<OutpostRecord>();
  let keyFingerprint: string | null = null;
  let ownerUserId: string | null = null;

  if (outpost) {
    const proof = await verifyOutpostMachineProof(request, outpost, db);
    if (proof.ok) {
      keyFingerprint = proof.keyFingerprint;
      ownerUserId = proof.ownerUserId;
    }
  }

  if (
    !keyFingerprint &&
    env.OUTPOST_ALLOW_LEGACY_SHARED_TOKEN === "true" &&
    outpost?.owner_user_id &&
    outpost.confirmed_at !== null &&
    outpost.revoked_at === null &&
    outpost.public_key === null &&
    (await verifyOutpostEnrollmentToken(
      request.headers.get("Authorization"),
      env.OUTPOST_ENROLLMENT_TOKEN
    ))
  ) {
    keyFingerprint = "legacy-shared-token";
    ownerUserId = outpost.owner_user_id;
    logger.warn("Accepted legacy shared-token outpost connection", {
      event: "outpost.legacy_auth_accepted",
      outpost_id: parsedId.data,
      owner_user_id: ownerUserId,
    });
  }

  if (!keyFingerprint || !ownerUserId) {
    logger.warn("Outpost enrollment rejected", {
      event: "outpost.auth_failed",
      http_path: url.pathname,
      outpost_id: parsedId.data,
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("X-Outpost-ID", parsedId.data);
  headers.set("X-Outpost-Key-Fingerprint", keyFingerprint);
  headers.set("X-Outpost-Owner-User-ID", ownerUserId);
  const doId = env.OUTPOST.idFromName(parsedId.data);
  return env.OUTPOST.get(doId).fetch("http://internal/connect", {
    method: "GET",
    headers,
  });
}

async function handleHomesteadWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.HOMESTEAD) {
    return new Response("Homestead registry is not configured", { status: 503 });
  }
  if (!env.SERVICE_AUTH_SECRET_HOMESTEAD) {
    logger.error("SERVICE_AUTH_SECRET_HOMESTEAD not configured - rejecting homestead connection", {
      event: "homestead.auth_misconfigured",
    });
    return new Response("Internal authentication not configured", { status: 500 });
  }

  // The same signed credential the homestead uses for lease and tool calls.
  // The upgrade is a GET with no body, so the signature binds the method, this
  // path and its query — a captured header cannot be pointed at a lease route.
  const verification = await verifyServiceSignature({
    signatureHeader: request.headers.get(SERVICE_SIGNATURE_HEADER) ?? "",
    service: "homestead",
    secret: env.SERVICE_AUTH_SECRET_HOMESTEAD,
    method: request.method,
    url: request.url,
    bodySha256Hex: await sha256Hex(""),
    actor: request.headers.get(ACTOR_HEADER) ?? "",
  });
  const authorized = verification.ok && request.headers.get(SERVICE_HEADER) === "homestead";
  if (!authorized) {
    logger.warn("Homestead connection rejected", {
      event: "homestead.auth_failed",
      http_path: url.pathname,
    });
    return new Response("Unauthorized", { status: 401 });
  }

  // eslint-disable-next-line no-restricted-syntax -- composition root: the WebSocket entrypoint's one DB binding read
  const db = env.DB;
  const consumed = await consumeServiceNonce(db, "homestead", verification.nonce, logger, {
    requestId: request.headers.get("x-request-id") ?? undefined,
    traceId: request.headers.get("x-trace-id") ?? undefined,
  });
  if (!consumed) {
    return new Response("Unauthorized", { status: 401 });
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  const doId = env.HOMESTEAD.idFromName("default");
  return env.HOMESTEAD.get(doId).fetch("http://internal/connect", {
    method: "GET",
    headers,
  });
}

/**
 * Handle WebSocket connections.
 */
async function handleWebSocket(request: Request, env: Env, url: URL): Promise<Response> {
  // Extract session ID from path: /sessions/:id/ws
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);

  if (!match) {
    logger.warn("Invalid WebSocket path", { event: "ws.invalid_path", http_path: url.pathname });
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const sessionId = match[1];
  logger.info("WebSocket upgrade", {
    event: "ws.connect",
    http_path: url.pathname,
    session_id: sessionId,
  });

  // Get Durable Object and forward WebSocket
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);

  // Forward the WebSocket upgrade request to the DO
  const response = await stub.fetch(request);

  // If it's a WebSocket upgrade response, return it directly
  // Add CORS headers for the upgrade response
  if (response.webSocket) {
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  return response;
}
