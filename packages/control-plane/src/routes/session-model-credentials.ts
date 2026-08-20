/**
 * The session-scoped model-credential broker.
 *
 * The homestead runs the harness centrally and holds no provider key of its
 * own. When the harness needs one it calls this endpoint for the session it is
 * running, and the control plane answers from the vault belonging to that
 * session's owner.
 *
 * Authentication is the session's own model-credential *fetch* token, verified
 * by a round trip to the session Durable Object against that token's own
 * stored hash. The route sits on the router's CREDENTIAL_FETCH_AUTH_ROUTES
 * list, which refuses the homestead credential every homestead carries
 * and equally refuses the session's bridge token.
 *
 * Two separate tokens rather than one: the bridge token also authorizes PR
 * creation, media upload, child-session spawn and Slack notification, and it
 * is the credential the harness process ends up holding. Reusing it here would
 * mean anything that could read the agent's own state could pull the session
 * owner's provider key and then act on the session besides. The handler
 * re-checks the verified scope below rather than trusting the route list to
 * stay correct.
 *
 * Whose credential applies is never caller-supplied. It is resolved from the
 * session row's owner, so a session can only ever receive its own owner's
 * credential.
 */

import { extractProviderAndModel } from "@open-inspect/shared";

import { createLogger } from "../logger";
import { actorFromPrincipal, writeAuditRecord } from "../db/audit-log";
import {
  ProviderCredentialValidationError,
  UserProviderCredentialStore,
  normalizeProviderId,
} from "../db/user-provider-credentials";
import { ModelCredentialsService } from "../session/model-credentials-service";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("router:model-credentials");

/**
 * Read an optional `{ provider }` body. A bodyless POST is normal — the
 * harness usually wants the provider the session was created with — so a
 * parse failure yields no fields rather than an error.
 */
async function readRequestedProvider(request: Request): Promise<string | null | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const provider = (raw as { provider?: unknown }).provider;
  if (provider === undefined || provider === null) return null;
  if (typeof provider !== "string") return error("provider must be a string", 400);
  return provider;
}

async function handleIssueModelCredential(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  // Defence in depth against route-list drift: the router already proved this
  // caller holds this session's fetch token specifically, and nothing else may
  // reach here. The scope check is not redundant with the route list — it is
  // what makes a future edit that moves this path onto a broader list fail
  // closed instead of quietly widening what may fetch a provider key.
  const principal = ctx.principal;
  if (
    principal?.kind !== "sandbox" ||
    principal.scope !== "credential_fetch" ||
    principal.sessionId !== sessionId
  ) {
    return error(
      "Unauthorized: model credentials require the session's credential-fetch token",
      401
    );
  }

  if (!env.TOKEN_ENCRYPTION_KEY) {
    return error("TOKEN_ENCRYPTION_KEY not configured", 500);
  }

  const requestedProvider = await readRequestedProvider(request);
  if (requestedProvider instanceof Response) return requestedProvider;

  const session = await ctx.db
    .prepare("SELECT user_id, model FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ user_id: string | null; model: string | null }>();

  if (!session) return error("Session not found", 404);
  if (!session.user_id) {
    // A session with no recorded owner has no vault to resolve. Refusing keeps
    // the "a session never receives another user's credential" invariant total
    // rather than conditional on a fallback.
    logger.warn("model.credential_denied", {
      event: "model.credential_denied",
      session_id: sessionId,
      reason: "session_unowned",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    await writeAuditRecord(ctx.db, logger, {
      action: "credential.issue_denied",
      outcome: "denied",
      actor: actorFromPrincipal(ctx.principal),
      sessionId,
      reason: "session_unowned",
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    });
    return error("Session has no owner to resolve a provider credential from", 403);
  }

  const providerSource = requestedProvider ?? (session.model ? session.model : null);
  if (!providerSource) {
    return error("provider is required: the session records no model to derive it from", 400);
  }

  let provider: string;
  try {
    // Deriving the provider from the session's model is only sound when the
    // model names one. Assuming Anthropic for the rest handed out — or refused
    // — the wrong vault entry without ever saying which model caused it.
    let derivedProvider = requestedProvider;
    if (derivedProvider === null) {
      const extracted = extractProviderAndModel(providerSource);
      if (!extracted) {
        return error(
          `Cannot derive a provider from the session's model "${providerSource}": it names none. ` +
            "Pass an explicit provider.",
          400
        );
      }
      derivedProvider = extracted.provider;
    }
    provider = normalizeProviderId(derivedProvider);
  } catch (e) {
    if (e instanceof ProviderCredentialValidationError) return error(e.message, 400);
    throw e;
  }

  const log = logger.child({
    session_id: sessionId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  const service = new ModelCredentialsService(
    new UserProviderCredentialStore(ctx.db, env.TOKEN_ENCRYPTION_KEY),
    log
  );

  const result = await service.issue({
    sessionId,
    ownerUserId: session.user_id,
    provider,
  });

  // Both outcomes are recorded, and both name the session's owner as the
  // identity — the caller is the session's own token, which acts for that
  // person. The record says which provider was asked for, never the material.
  await writeAuditRecord(ctx.db, logger, {
    action: result.ok ? "credential.issued" : "credential.issue_denied",
    outcome: result.ok ? "success" : "denied",
    actor: actorFromPrincipal(ctx.principal, session.user_id),
    sessionId,
    object: { kind: "provider_credential", id: provider },
    reason: result.ok ? null : result.reason,
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  });

  if (!result.ok) {
    return json({ error: result.error }, result.status);
  }

  return new Response(
    JSON.stringify({
      kind: result.kind,
      provider: result.provider,
      credential_id: result.credentialId,
      api_key: result.apiKey,
      expires_at_epoch_ms: result.expiresAtEpochMs,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
}

export const sessionModelCredentialRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/sessions/:id/model-credentials"),
    handler: handleIssueModelCredential,
  },
];
