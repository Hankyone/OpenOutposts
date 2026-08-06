/**
 * The model catalog the product may offer, for the signed-in user.
 *
 * What the harness supports, intersected with the providers this user has
 * connected. Nothing here is secret — a provider name is not a credential —
 * but reachability is per user, so the owner comes from the verified principal
 * and the path never names one.
 *
 * `source: "unavailable"` is a real answer, not an error: a deployment whose
 * homestead has never registered has no catalog to serve, and a client that
 * receives it should fall back to whatever list it used before (the managed
 * sandbox path's hardcoded catalog) rather than render an empty dropdown.
 */

import { createLogger } from "../logger";
import { ModelCatalogService } from "../model-catalog/service";
import type { Env } from "../types";
import { json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("router:model-catalog");

async function handleGetModelCatalog(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  // Only a user principal owns credentials, and the vault keys on the
  // canonical user id — the same resolution the credential routes use. Any
  // other caller is served the reported catalog with nothing connected: what
  // the harness supports is not secret, only who can reach it is.
  const principal = ctx.principal;
  const userId = principal?.kind === "user" ? (principal.user.canonicalUserId ?? null) : null;

  const view = await new ModelCatalogService(ctx.db).viewForUser(userId);

  logger.info("model_catalog.served", {
    event: "model_catalog.served",
    user_id: userId ?? undefined,
    source: view.source,
    connected_provider_count: view.providers.length,
    offered_model_count: view.providers.reduce((total, p) => total + p.models.length, 0),
    unconnected_provider_count: view.unconnectedProviders.length,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json(view);
}

export const modelCatalogRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/model-catalog"),
    handler: handleGetModelCatalog,
  },
];
