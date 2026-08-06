import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  sessionAttachmentReferencesSchema,
  type CallbackContext,
  type SessionAttachmentReference,
} from "@open-inspect/shared";
import { applyIdentityEnforcement, mayAttachCallbackContext } from "../auth/identity-enforcement";
import { SessionIndexStore } from "../db/session-index";
import { UserStore } from "../db/user-store";
import { createLogger } from "../logger";
import { resolveReasoningEffortFor, resolveRequestedModel } from "../model-catalog/requested-model";
import { SessionInternalPaths } from "../session/contracts";
import { parseAuthorId, resolveGitHubEnrichment, type GitHubEnrichment } from "../session/identity";
import type { Env } from "../types";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-prompt");

function validateAttachments(raw: unknown): SessionAttachmentReference[] | Response | undefined {
  if (raw === undefined) return undefined;
  const result = sessionAttachmentReferencesSchema.safeParse(raw);
  if (!result.success) {
    if (Array.isArray(raw) && raw.length > MAX_SESSION_ATTACHMENTS_PER_MESSAGE) {
      return error(
        `You can attach up to ${MAX_SESSION_ATTACHMENTS_PER_MESSAGE} files per message`,
        400
      );
    }
    return error("Invalid attachments", 400);
  }
  return result.data;
}

/**
 * Validate the reasoning effort this turn may actually run at.
 *
 * The effort belongs to whichever model runs, whether the prompt names that
 * model or inherits it from the session. The same catalog that validates
 * model selection decides the effort here too, so an explicit unsupported
 * choice is rejected instead of being silently discarded.
 *
 * An effort-only override validates against the stored model but does not
 * manufacture a model override in the command forwarded to the SessionDO.
 */
type TurnReasoningEffortOutcome =
  | { ok: true; effort: string | undefined }
  | { ok: false; error: string; status: 400 | 404 };

async function resolveTurnReasoningEffort(
  env: Env,
  ctx: SessionRouteContext,
  sessionId: string,
  userId: string | null,
  requestedModel: string | undefined,
  requestedEffort: unknown
): Promise<TurnReasoningEffortOutcome> {
  if (requestedEffort === undefined) return { ok: true, effort: undefined };
  if (typeof requestedEffort !== "string" || requestedEffort.length === 0) {
    return { ok: false, error: "Invalid reasoning effort", status: 400 };
  }

  let effectiveModel = requestedModel;
  if (effectiveModel === undefined) {
    const session = await new SessionIndexStore(ctx.db).get(sessionId);
    if (!session) return { ok: false, error: "Session not found", status: 404 };
    effectiveModel = session.model;
  }

  const resolved = await resolveRequestedModel({
    env,
    db: ctx.db,
    userId,
    requested: effectiveModel,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error, status: 400 };

  const effort = resolveReasoningEffortFor(resolved, requestedEffort);
  if (effort === null) {
    logger.info("prompt.reasoning_effort_unsupported", {
      event: "prompt.reasoning_effort_unsupported",
      session_id: sessionId,
      model: resolved.model,
      reasoning_effort: requestedEffort,
      catalog_governed: resolved.catalogGoverned,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return {
      ok: false,
      error: `Reasoning effort "${requestedEffort}" is not supported by model "${resolved.model}"`,
      status: 400,
    };
  }
  return { ok: true, effort: requestedEffort };
}

async function handleSessionPrompt(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = (await request.json()) as {
    content: string;
    source?: string;
    model?: string;
    reasoningEffort?: unknown;
    attachments?: unknown;
    callbackContext?: CallbackContext;
  };

  if (!body.content) {
    return error("content is required");
  }
  const enforcement = applyIdentityEnforcement(ctx, "prompt", body);
  if (enforcement.rejection) return enforcement.rejection;

  const attachments = validateAttachments(body.attachments);
  if (attachments instanceof Response) return attachments;

  // The author comes from the verified principal (user → canonical id, bot →
  // asserted actor); an actorless bot prompt is system-initiated and stays
  // anonymous. callbackContext is a completion notification channel — only
  // the bots that own callbacks may attach one.
  const authorId = enforcement.enforced.participantUserId ?? "anonymous";
  const callbackContext = mayAttachCallbackContext(ctx) ? body.callbackContext : undefined;
  if (callbackContext === undefined && body.callbackContext !== undefined) {
    logger.warn("Dropped callbackContext from unauthorized principal", {
      event: "identity.callback_context_dropped",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  const reasoningEffortOutcome = await resolveTurnReasoningEffort(
    env,
    ctx,
    sessionId,
    enforcement.enforced.canonicalUserId,
    body.model,
    body.reasoningEffort
  );
  if (!reasoningEffortOutcome.ok) {
    return error(reasoningEffortOutcome.error, reasoningEffortOutcome.status);
  }
  const reasoningEffort = reasoningEffortOutcome.effort;

  let enrichment: GitHubEnrichment | undefined;
  const parsed = parseAuthorId(authorId);
  if (authorId !== "anonymous") {
    try {
      const userStore = new UserStore(ctx.db);
      let userId: string | undefined;
      if (parsed) {
        const identity = await userStore.getIdentity(parsed.provider, parsed.providerUserId);
        userId = identity?.userId;
      } else {
        userId = (await userStore.getUserById(authorId))?.id;
      }
      if (userId) {
        enrichment = (await resolveGitHubEnrichment(env, ctx.db, userStore, userId)) ?? undefined;
      }
    } catch (e) {
      logger.warn("Failed to enrich prompt with GitHub identity", {
        error: e instanceof Error ? e : String(e),
        authorId,
      });
    }
  }

  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.prompt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: body.content,
      authorId,
      source: body.source || "web",
      model: body.model,
      reasoningEffort,
      attachments,
      callbackContext,
      scmEnrichment: enrichment
        ? {
            userId: enrichment.scmUserId,
            login: enrichment.scmLogin ?? null,
            name: enrichment.displayName ?? null,
            email: enrichment.email ?? null,
            accessTokenEncrypted: enrichment.accessTokenEncrypted ?? null,
            refreshTokenEncrypted: enrichment.refreshTokenEncrypted ?? null,
            tokenExpiresAt: enrichment.tokenExpiresAt ?? null,
          }
        : undefined,
    }),
  });

  const store = new SessionIndexStore(ctx.db);
  ctx.executionCtx?.waitUntil(
    store.touchUpdatedAt(sessionId).catch((error) => {
      logger.error("session_index.touch_updated_at.background_error", {
        session_id: sessionId,
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
        error,
      });
    })
  );

  return response;
}

export const sessionPromptRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/prompt"),
    handler: handleSessionPrompt,
  }),
];
