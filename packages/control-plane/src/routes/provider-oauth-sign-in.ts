/**
 * Browser-first Pi-subscription sign-in.
 *
 * The owner comes from the verified principal, the same as the API-key vault.
 * Start returns an authorize URL or a device code; complete/poll write an
 * oauth_grant. Refresh tokens never appear in a response.
 */

import { createLogger } from "../logger";
import { actorFromPrincipal, writeAuditRecord } from "../db/audit-log";
import { ProviderOAuthFlowStore } from "../db/provider-oauth-flows";
import {
  UserProviderCredentialStore,
  type ProviderCredentialMetadata,
} from "../db/user-provider-credentials";
import {
  ProviderOAuthSignInError,
  ProviderOAuthSignInService,
} from "../auth/provider-oauth-sign-in-service";
import { SUBSCRIPTION_SIGN_IN_CATALOG } from "../auth/pi-oauth";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:provider-oauth");

function resolveOwner(ctx: RequestContext): { userId: string } | Response {
  const principal = ctx.principal;
  if (principal?.kind !== "user") {
    return error("A signed-in user is required to manage provider credentials", 403);
  }
  const userId = principal.user.canonicalUserId;
  if (!userId) {
    return error("User principal has no canonical id", 500);
  }
  return { userId };
}

function requireEncryptionKey(env: Env): string | Response {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    return error("TOKEN_ENCRYPTION_KEY not configured", 500);
  }
  return env.TOKEN_ENCRYPTION_KEY;
}

function serialize(credential: ProviderCredentialMetadata) {
  return {
    id: credential.id,
    provider: credential.provider,
    label: credential.label,
    kind: credential.kind,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    lastUsedAt: credential.lastUsedAt,
    expiresAt: credential.secretExpiresAt,
  };
}

function serviceFor(ctx: RequestContext, encryptionKey: string): ProviderOAuthSignInService {
  return new ProviderOAuthSignInService(
    new ProviderOAuthFlowStore(ctx.db, encryptionKey),
    new UserProviderCredentialStore(ctx.db, encryptionKey)
  );
}

function mapError(errorValue: unknown, ctx: RequestContext, userId: string): Response {
  if (errorValue instanceof ProviderOAuthSignInError) {
    return error(errorValue.message, errorValue.status);
  }
  logger.error("Provider OAuth sign-in failed", {
    error: errorValue instanceof Error ? errorValue.message : String(errorValue),
    user_id: userId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("Provider sign-in is unavailable", 503);
}

async function auditCredentialWrite(
  ctx: RequestContext,
  userId: string,
  result: { credential: ProviderCredentialMetadata; created: boolean }
): Promise<void> {
  await writeAuditRecord(ctx.db, logger, {
    action: result.created ? "credential.created" : "credential.replaced",
    outcome: "success",
    actor: actorFromPrincipal(ctx.principal, userId),
    object: { kind: "provider_credential", id: result.credential.provider },
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  });
}

async function handleListMethods(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  return json({
    methods: SUBSCRIPTION_SIGN_IN_CATALOG.map((method) => ({
      id: method.id,
      name: method.name,
      loginLabel: method.loginLabel,
      flow: method.flow,
    })),
  });
}

async function handleStart(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  const encryptionKey = requireEncryptionKey(env);
  if (encryptionKey instanceof Response) return encryptionKey;
  const provider = match.groups?.provider;
  if (!provider) return error("Provider is required", 400);

  try {
    const started = await serviceFor(ctx, encryptionKey).start(owner.userId, provider);
    logger.info("provider_oauth.started", {
      event: "provider_oauth.started",
      user_id: owner.userId,
      provider: started.provider,
      flow: started.flow,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json(started, 201);
  } catch (errorValue) {
    return mapError(errorValue, ctx, owner.userId);
  }
}

async function handleComplete(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  const encryptionKey = requireEncryptionKey(env);
  if (encryptionKey instanceof Response) return encryptionKey;
  const provider = match.groups?.provider;
  if (!provider) return error("Provider is required", 400);

  const body = await parseJsonBody<{ code?: unknown }>(request);
  if (body instanceof Response) return body;
  if (typeof body?.code !== "string") {
    return error("Request body must include a code string", 400);
  }

  try {
    const result = await serviceFor(ctx, encryptionKey).complete(owner.userId, provider, body.code);
    logger.info("provider_oauth.completed", {
      event: "provider_oauth.completed",
      user_id: owner.userId,
      provider: result.credential.provider,
      credential_id: result.credential.id,
      created: result.created,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    await auditCredentialWrite(ctx, owner.userId, result);
    return json(
      { status: result.created ? "created" : "replaced", credential: serialize(result.credential) },
      result.created ? 201 : 200
    );
  } catch (errorValue) {
    return mapError(errorValue, ctx, owner.userId);
  }
}

async function handlePoll(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  const encryptionKey = requireEncryptionKey(env);
  if (encryptionKey instanceof Response) return encryptionKey;
  const provider = match.groups?.provider;
  if (!provider) return error("Provider is required", 400);

  try {
    const polled = await serviceFor(ctx, encryptionKey).poll(owner.userId, provider);
    if (polled.status === "complete") {
      logger.info("provider_oauth.completed", {
        event: "provider_oauth.completed",
        user_id: owner.userId,
        provider: polled.result.credential.provider,
        credential_id: polled.result.credential.id,
        created: polled.result.created,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      await auditCredentialWrite(ctx, owner.userId, polled.result);
      return json({
        status: "complete",
        credential: serialize(polled.result.credential),
        created: polled.result.created,
      });
    }
    if (polled.status === "pending") {
      return json({
        status: "pending",
        intervalSeconds: polled.intervalSeconds,
      });
    }
    return json(
      { status: polled.status, error: polled.message },
      polled.status === "denied" ? 403 : 410
    );
  } catch (errorValue) {
    return mapError(errorValue, ctx, owner.userId);
  }
}

async function handleCancel(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  const encryptionKey = requireEncryptionKey(env);
  if (encryptionKey instanceof Response) return encryptionKey;
  const provider = match.groups?.provider;
  if (!provider) return error("Provider is required", 400);

  try {
    const deleted = await serviceFor(ctx, encryptionKey).cancel(owner.userId, provider);
    if (!deleted) return error("No sign-in is in progress for this provider", 404);
    return json({ status: "cancelled", provider: provider.toLowerCase() });
  } catch (errorValue) {
    return mapError(errorValue, ctx, owner.userId);
  }
}

export const providerOAuthSignInRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/provider-credentials/oauth-methods"),
    handler: handleListMethods,
  },
  {
    method: "POST",
    pattern: parsePattern("/provider-credentials/:provider/oauth/start"),
    handler: handleStart,
  },
  {
    method: "POST",
    pattern: parsePattern("/provider-credentials/:provider/oauth/complete"),
    handler: handleComplete,
  },
  {
    method: "POST",
    pattern: parsePattern("/provider-credentials/:provider/oauth/poll"),
    handler: handlePoll,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/provider-credentials/:provider/oauth"),
    handler: handleCancel,
  },
];
