/**
 * A signed-in user's own provider credentials.
 *
 * The owner comes from the request's verified principal and the path never
 * names a user, so there is no shape in which one user can address another's
 * rows. Listing returns presence and metadata; the stored secret has no read
 * path at all. The only decryption in the system is session-scoped issuance
 * (see routes/session-model-credentials.ts).
 */

import { createLogger } from "../logger";
import { actorFromPrincipal, writeAuditRecord } from "../db/audit-log";
import {
  ProviderCredentialValidationError,
  UserProviderCredentialStore,
  normalizeProviderId,
  type ProviderCredentialMetadata,
} from "../db/user-provider-credentials";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:provider-credentials");

/**
 * Resolve the owning user, or refuse.
 *
 * Only a user principal owns credentials. A service principal asserting no
 * actor (the web BFF's own credential) and a bot asserting someone else's are
 * both refused: user-bearing web calls carry the signed-in user's session
 * token and resolve as user principals, which is the only caller this surface
 * has.
 */
function resolveOwner(ctx: RequestContext): { userId: string } | Response {
  const principal = ctx.principal;
  if (principal?.kind !== "user") {
    return error("A signed-in user is required to manage provider credentials", 403);
  }
  const userId = principal.user.canonicalUserId;
  if (!userId) {
    // User principals always carry a canonical id (it is read off the token
    // row). Fail closed rather than fall back to an unattributed write.
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

async function handleListCredentials(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const owner = resolveOwner(ctx);
  if (owner instanceof Response) return owner;
  const encryptionKey = requireEncryptionKey(env);
  if (encryptionKey instanceof Response) return encryptionKey;

  const store = new UserProviderCredentialStore(ctx.db, encryptionKey);
  const credentials = await store.list(owner.userId);

  logger.info("provider_credential.listed", {
    event: "provider_credential.listed",
    user_id: owner.userId,
    credentials_count: credentials.length,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ credentials: credentials.map(serialize) });
}

async function handlePutCredential(
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

  const body = await parseJsonBody<{ apiKey?: unknown; label?: unknown }>(request);
  if (body instanceof Response) return body;

  if (typeof body?.apiKey !== "string") {
    return error("Request body must include an apiKey string", 400);
  }
  if (body.label !== undefined && body.label !== null && typeof body.label !== "string") {
    return error("label must be a string", 400);
  }

  const store = new UserProviderCredentialStore(ctx.db, encryptionKey);

  try {
    const result = await store.putApiKey({
      userId: owner.userId,
      provider,
      apiKey: body.apiKey,
      label: body.label ?? null,
    });

    logger.info("provider_credential.saved", {
      event: "provider_credential.saved",
      user_id: owner.userId,
      provider: result.credential.provider,
      credential_id: result.credential.id,
      created: result.created,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    // A vault write is a change to what a session can authenticate as. The
    // record names the provider, which is what identifies a user's credential
    // (one per owner per provider), and never touches the material.
    await writeAuditRecord(ctx.db, logger, {
      action: result.created ? "credential.created" : "credential.replaced",
      outcome: "success",
      actor: actorFromPrincipal(ctx.principal, owner.userId),
      object: { kind: "provider_credential", id: result.credential.provider },
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    });

    return json(
      { status: result.created ? "created" : "replaced", credential: serialize(result.credential) },
      result.created ? 201 : 200
    );
  } catch (e) {
    if (e instanceof ProviderCredentialValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to save provider credential", {
      error: e instanceof Error ? e.message : String(e),
      user_id: owner.userId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Provider credential storage unavailable", 503);
  }
}

async function handleDeleteCredential(
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

  const store = new UserProviderCredentialStore(ctx.db, encryptionKey);

  try {
    const deleted = await store.delete(owner.userId, provider);
    if (!deleted) return error("Provider credential not found", 404);

    logger.info("provider_credential.deleted", {
      event: "provider_credential.deleted",
      user_id: owner.userId,
      provider: provider.toLowerCase(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    await writeAuditRecord(ctx.db, logger, {
      action: "credential.deleted",
      outcome: "success",
      actor: actorFromPrincipal(ctx.principal, owner.userId),
      // The normalized slug, not the raw path segment: the record names the
      // same credential the store just removed.
      object: { kind: "provider_credential", id: normalizeProviderId(provider) },
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    });

    return json({ status: "deleted", provider: provider.toLowerCase() });
  } catch (e) {
    if (e instanceof ProviderCredentialValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete provider credential", {
      error: e instanceof Error ? e.message : String(e),
      user_id: owner.userId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Provider credential storage unavailable", 503);
  }
}

export const userProviderCredentialRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/provider-credentials"),
    handler: handleListCredentials,
  },
  {
    method: "PUT",
    pattern: parsePattern("/provider-credentials/:provider"),
    handler: handlePutCredential,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/provider-credentials/:provider"),
    handler: handleDeleteCredential,
  },
];
