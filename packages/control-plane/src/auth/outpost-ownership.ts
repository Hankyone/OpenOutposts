import { OutpostStore, type OutpostRecord } from "../db/outposts";
import type { RequestContext } from "../routes/shared";
import { HttpError } from "../routes/shared";

export function requireOutpostOwner(ctx: RequestContext): string {
  const principal = ctx.principal;
  if (principal?.kind !== "user" || !principal.user.canonicalUserId) {
    throw new HttpError("Outpost ownership requires a signed-in user", 403);
  }
  return principal.user.canonicalUserId;
}

export async function requireOwnedOutpost(
  ctx: RequestContext,
  outpostId: string
): Promise<OutpostRecord> {
  const ownerUserId = requireOutpostOwner(ctx);
  const outpost = await new OutpostStore(ctx.db).getOwned(outpostId, ownerUserId);
  if (!outpost) {
    throw new HttpError("Outpost not found", 404);
  }
  return outpost;
}

export async function requireSessionOutpost(
  ctx: RequestContext,
  requestedOutpostId: string | null | undefined,
  defaultOutpostId: string | undefined,
  ownerUserId: string | null
): Promise<OutpostRecord> {
  if (!ownerUserId) {
    throw new HttpError("A session owner is required to select an outpost", 403);
  }
  const outpostId = requestedOutpostId ?? defaultOutpostId;
  if (!outpostId) {
    throw new HttpError("No outpost was selected and no default outpost is configured", 400);
  }

  const outpost = await new OutpostStore(ctx.db).getOwned(outpostId, ownerUserId);
  if (!outpost) {
    throw new HttpError("The selected outpost is not owned by this user", 403);
  }
  if (outpost.confirmed_at === null) {
    throw new HttpError("The selected outpost has not completed enrollment", 409);
  }
  return outpost;
}
