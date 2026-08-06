/**
 * Client-invoked renewal of the web session token pair (`oi_at_`/`oi_rt_`).
 *
 * This is the ONLY place the rotating refresh grant is redeemed. NextAuth v4's
 * jwt callback also runs under `getServerSession`, which cannot persist a
 * rotated cookie — redeeming there would orphan the cookie's refresh token —
 * so renewal lives in this route handler, which re-encodes the session JWT
 * and writes it back (chunk-aware) in the same response.
 *
 * The client calls this route on mount, on window focus, and on an interval
 * comfortably inside the renew window (see `WebSessionGate`).
 * Concurrent refresh requests from multiple tabs are safe within the control
 * plane's refresh-reuse grace window; the remaining stale-writer race is
 * documented in `renewWebSessionTokens` and requires the Phase B cookie
 * redesign.
 */

import { NextResponse } from "next/server";
import { getToken, encode } from "next-auth/jwt";
import { cookies } from "next/headers";
import { createLogger } from "@/lib/logger";
import { renewWebSessionTokens } from "@/lib/oi-session";
import { SESSION_COOKIE_MAX_AGE_SECONDS, writeSessionCookie } from "@/lib/session-cookie";

const log = createLogger("oi-refresh");

export async function POST(): Promise<NextResponse> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    log.error("oi_refresh.misconfigured", { reason: "NEXTAUTH_SECRET not configured" });
    return NextResponse.json({ error: "Auth not configured" }, { status: 500 });
  }

  const cookieStore = await cookies();
  const cookiePairs = Object.fromEntries(
    cookieStore.getAll().map((cookie) => [cookie.name, cookie.value])
  );
  // getToken reads req.cookies only — pass the parsed pairs so chunked
  // session cookies reassemble (same contract as oi-session's reader).
  const token = await getToken({
    req: { headers: {}, cookies: cookiePairs } as Parameters<typeof getToken>[0]["req"],
  });
  if (!token) {
    // No decodable session *in this request*. Usually terminal, but the
    // chunked session cookie is read non-atomically, so a read landing mid
    // rotation-write sees no token for a moment. Marked retryable so the
    // client re-checks before destroying a live login; a genuinely absent
    // session simply fails the retries too.
    return NextResponse.json({ error: "Unauthorized", reason: "no_session" }, { status: 401 });
  }
  if (!token.oiAccessToken || !token.oiAccessTokenExpiresAt || !token.oiRefreshToken) {
    // Decodable session that never carried a token pair — re-login required.
    return NextResponse.json({ error: "Unauthorized", reason: "grant_invalid" }, { status: 401 });
  }

  const renewal = await renewWebSessionTokens(token);
  if (renewal.changed) {
    const encoded = await encode({ token, secret, maxAge: SESSION_COOKIE_MAX_AGE_SECONDS });
    writeSessionCookie(cookieStore, encoded);
  }
  if (renewal.status === "unauthenticated") {
    // The grant is dead or its rotation was reused — terminal by design.
    // Never retryable: reuse is the token-theft signal.
    return NextResponse.json({ error: "Unauthorized", reason: "grant_invalid" }, { status: 401 });
  }
  if (renewal.status === "temporarily_unavailable") {
    return NextResponse.json({ error: "Authentication temporarily unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    renewed: renewal.changed,
    accessTokenExpiresAt: token.oiAccessTokenExpiresAt ?? null,
  });
}
