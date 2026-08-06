import { z } from "zod";

import { base64UrlDecode, base64UrlEncode } from "../auth/encoding";
import { hashToken } from "../auth/crypto";
import { verifyOutpostMachineProof } from "../auth/outpost";
import { requireOutpostOwner } from "../auth/outpost-ownership";
import { OutpostEnrollmentStore, type OutpostEnrollmentRecord } from "../db/outpost-enrollments";
import { OutpostStore } from "../db/outposts";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, parsePattern, type RequestContext, type Route } from "./shared";

const logger = createLogger("router:outpost-enrollment");
const ENROLLMENT_TOKEN_PREFIX = "oo_enroll_";
const ENROLLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;
const PUBLIC_KEY_BYTES = 32;

const createEnrollmentSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

const consumeEnrollmentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  workerVersion: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(100),
  architecture: z.string().trim().min(1).max(100),
  publicKey: z.string().min(1).max(100),
  workspaceRoots: z.array(z.string().min(1).max(4096)).min(1).max(64),
});

const confirmEnrollmentSchema = z.object({
  code: z.string().regex(/^\d{3}-?\d{3}$/),
});

function randomToken(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function confirmationCode(): string {
  const maximum = 0x1_0000_0000;
  const acceptable = maximum - (maximum % 1_000_000);
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= acceptable);
  return (buffer[0] % 1_000_000).toString().padStart(6, "0");
}

function formatConfirmationCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.startsWith(ENROLLMENT_TOKEN_PREFIX) ? token : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandFor(controlPlaneUrl: string, token: string, name: string | null): string {
  const nameArgument = name ? ` --name ${shellQuote(name)}` : "";
  return `openoutpost enroll --control-plane ${shellQuote(controlPlaneUrl)} --token ${shellQuote(token)} --workspace-root "$PWD"${nameArgument} && openoutpost`;
}

function enrollmentState(enrollment: OutpostEnrollmentRecord, now: number): string {
  if (enrollment.cancelled_at !== null) return "cancelled";
  if (enrollment.confirmed_at !== null) return "confirmed";
  if (enrollment.expires_at <= now) return "expired";
  if (enrollment.consumed_at !== null) return "awaiting_confirmation";
  return "issued";
}

async function handleCreateEnrollment(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = createEnrollmentSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return error("Invalid enrollment request", 400);

  const ownerUserId = requireOutpostOwner(ctx);
  const now = Date.now();
  const id = `enroll_${randomToken(18)}`;
  const token = `${ENROLLMENT_TOKEN_PREFIX}${randomToken(32)}`;
  const expiresAt = now + ENROLLMENT_TOKEN_TTL_MS;
  await new OutpostEnrollmentStore(ctx.db).create({
    id,
    tokenHash: await hashToken(token),
    ownerUserId,
    requestedName: parsed.data.name ?? null,
    accessScope: "full",
    issuedAt: now,
    expiresAt,
  });

  const controlPlaneUrl = new URL(request.url).origin;
  const command = commandFor(controlPlaneUrl, token, parsed.data.name ?? null);
  return json(
    {
      enrollmentId: id,
      expiresAt: new Date(expiresAt).toISOString(),
      commands: {
        macos: command,
        linux: command,
      },
    },
    201
  );
}

async function handleConsumeEnrollment(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return error("Invalid or expired enrollment token", 401);
  const parsed = consumeEnrollmentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error("Invalid machine enrollment request", 400);

  let publicKey: Uint8Array;
  try {
    publicKey = base64UrlDecode(parsed.data.publicKey);
  } catch {
    return error("Invalid machine public key", 400);
  }
  if (publicKey.byteLength !== PUBLIC_KEY_BYTES) {
    return error("Invalid machine public key", 400);
  }

  const store = new OutpostEnrollmentStore(ctx.db);
  const enrollment = await store.getByTokenHash(await hashToken(token));
  const now = Date.now();
  if (
    !enrollment ||
    enrollment.consumed_at !== null ||
    enrollment.cancelled_at !== null ||
    enrollment.expires_at <= now
  ) {
    return error("Invalid or expired enrollment token", 401);
  }

  const code = confirmationCode();
  const outpostId = `outpost-${randomToken(12)}`;
  const keyFingerprint = base64UrlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey))
  );
  const consumed = await store.consume(enrollment, {
    outpostId,
    name: enrollment.requested_name ?? parsed.data.name,
    workerVersion: parsed.data.workerVersion,
    platform: parsed.data.platform,
    architecture: parsed.data.architecture,
    publicKey: parsed.data.publicKey,
    keyFingerprint,
    workspaceRoots: parsed.data.workspaceRoots,
    confirmationCodeHash: await hashToken(`outpost-confirm:${code}`),
    now,
  });
  if (!consumed) return error("Enrollment token was already used", 409);

  logger.info("Outpost enrollment token consumed", {
    event: "outpost.enrollment_consumed",
    enrollment_id: enrollment.id,
    outpost_id: outpostId,
    owner_user_id: enrollment.owner_user_id,
  });
  return json(
    {
      enrollmentId: enrollment.id,
      outpostId,
      confirmationCode: formatConfirmationCode(code),
      expiresAt: new Date(enrollment.expires_at).toISOString(),
    },
    201
  );
}

async function handleGetEnrollment(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Invalid enrollment ID", 400);
  const enrollment = await new OutpostEnrollmentStore(ctx.db).getOwned(
    id,
    requireOutpostOwner(ctx)
  );
  if (!enrollment) return error("Enrollment not found", 404);
  return json({
    enrollmentId: enrollment.id,
    outpostId: enrollment.outpost_id,
    state: enrollmentState(enrollment, Date.now()),
    expiresAt: new Date(enrollment.expires_at).toISOString(),
  });
}

async function handleConfirmEnrollment(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Invalid enrollment ID", 400);
  const parsed = confirmEnrollmentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error("Enter the six-digit code shown by the machine", 400);

  const ownerUserId = requireOutpostOwner(ctx);
  const normalizedCode = parsed.data.code.replace("-", "");
  const outpostId = await new OutpostEnrollmentStore(ctx.db).confirm({
    enrollmentId: id,
    ownerUserId,
    confirmationCodeHash: await hashToken(`outpost-confirm:${normalizedCode}`),
    now: Date.now(),
  });
  if (!outpostId) return error("The confirmation code is invalid or expired", 409);

  logger.info("Outpost enrollment confirmed", {
    event: "outpost.enrollment_confirmed",
    enrollment_id: id,
    outpost_id: outpostId,
    owner_user_id: ownerUserId,
  });
  return json({ confirmed: true, outpostId });
}

async function handleEnrollmentStatus(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const outpostId = match.groups?.id;
  if (!outpostId) return error("Invalid outpost ID", 400);
  const outpost = await new OutpostStore(ctx.db).get(outpostId);
  if (!outpost) return error("Outpost not found", 404);
  const proof = await verifyOutpostMachineProof(request, outpost, ctx.db, {
    allowUnconfirmed: true,
    allowRevoked: true,
  });
  if (!proof.ok) return error("Invalid machine proof", 401);
  return json({
    state:
      outpost.revoked_at !== null
        ? "revoked"
        : outpost.confirmed_at !== null
          ? "confirmed"
          : "pending",
    confirmed: outpost.confirmed_at !== null && outpost.revoked_at === null,
    revoked: outpost.revoked_at !== null,
  });
}

async function handleClaimLegacyOutpost(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (env.OUTPOST_ALLOW_LEGACY_SHARED_TOKEN !== "true") {
    return error("Legacy outpost claiming is disabled", 403);
  }
  const outpostId = match.groups?.id;
  if (!outpostId) return error("Invalid outpost ID", 400);
  const ownerUserId = requireOutpostOwner(ctx);
  const users = await ctx.db.prepare("SELECT id FROM users LIMIT 2").all<{ id: string }>();
  if (users.results.length !== 1 || users.results[0]?.id !== ownerUserId) {
    return error("Legacy claiming requires a single-user deployment", 409);
  }

  const claimed = await new OutpostStore(ctx.db).claimLegacy(outpostId, ownerUserId, Date.now());
  if (!claimed) return error("Unclaimed legacy outpost not found", 404);
  logger.warn("Legacy outpost claimed under shared-token compatibility", {
    event: "outpost.legacy_claimed",
    outpost_id: outpostId,
    owner_user_id: ownerUserId,
  });
  return json({ claimed: true, outpostId });
}

export const outpostEnrollmentRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/outposts/enrollments"),
    handler: handleCreateEnrollment,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/enrollments/consume"),
    handler: handleConsumeEnrollment,
  },
  {
    method: "GET",
    pattern: parsePattern("/outposts/enrollments/:id"),
    handler: handleGetEnrollment,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/enrollments/:id/confirm"),
    handler: handleConfirmEnrollment,
  },
  {
    method: "GET",
    pattern: parsePattern("/outposts/:id/enrollment-status"),
    handler: handleEnrollmentStatus,
  },
  {
    method: "POST",
    pattern: parsePattern("/outposts/:id/claim"),
    handler: handleClaimLegacyOutpost,
  },
];
