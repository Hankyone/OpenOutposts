"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut, useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";

/**
 * Check interval for web session token renewal. Must sit comfortably inside
 * OI_ACCESS_TOKEN_RENEW_WINDOW_MS (15 min) so a token entering the renew
 * window is rotated well before it expires.
 */
const WEB_SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Backoff before re-checking a 401 the refresh route marked retryable
 * (`reason: "no_session"` — no decodable session in that one request, which a
 * cookie read landing mid rotation-write can produce transiently). Signing out
 * is destructive and unrecoverable without a full re-login, so a single blip
 * must not end a session that is supposed to survive for months. Terminal 401s
 * — a dead grant or detected rotation reuse — never reach this path.
 */
const RETRYABLE_401_BACKOFF_MS = [500, 1500];

async function retryableUnauthorized(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return (body as { reason?: string } | null)?.reason === "no_session";
  } catch {
    // An unparseable body is not a retry signal — fall through to sign-out.
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms that NextAuth and the control-plane token pair form a usable web
 * session before rendering authenticated children, then keeps that pair fresh.
 * Renewal cannot live in the NextAuth jwt callback (getServerSession cannot
 * persist rotated cookies), so this client-side gate drives rotation on
 * mount, focus/visibility, and an interval.
 */
export function WebSessionGate({ children }: { children?: ReactNode }) {
  const { status } = useAuthSession();
  const signingOutRef = useRef(false);
  const [webSessionStatus, setWebSessionStatus] = useState<
    "checking" | "ready" | "temporarily_unavailable"
  >("checking");
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (status === "authenticated") return;
    setWebSessionStatus("checking");
    signingOutRef.current = false;
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    let checkInFlight = false;

    const checkWebSession = async () => {
      if (checkInFlight) return;
      checkInFlight = true;
      try {
        let response = await browserApiFetch("/api/auth/oi-refresh", { method: "POST" });
        if (cancelled) return;

        for (const backoffMs of RETRYABLE_401_BACKOFF_MS) {
          if (response.status !== 401 || !(await retryableUnauthorized(response))) break;
          if (cancelled) return;
          await delay(backoffMs);
          if (cancelled) return;
          response = await browserApiFetch("/api/auth/oi-refresh", { method: "POST" });
          if (cancelled) return;
        }

        if (response.status === 401 && !signingOutRef.current) {
          signingOutRef.current = true;
          try {
            await signOut();
          } catch {
            if (!cancelled) {
              signingOutRef.current = false;
              setWebSessionStatus("temporarily_unavailable");
            }
          }
          return;
        }
        if (response.ok) {
          setWebSessionStatus("ready");
          return;
        }
        setWebSessionStatus("temporarily_unavailable");
      } catch {
        if (!cancelled) {
          setWebSessionStatus("temporarily_unavailable");
        }
      } finally {
        checkInFlight = false;
      }
    };

    void checkWebSession();
    const checkInterval = setInterval(() => void checkWebSession(), WEB_SESSION_CHECK_INTERVAL_MS);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkWebSession();
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      cancelled = true;
      clearInterval(checkInterval);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [retryGeneration, status]);

  if (status === "unauthenticated") return children ?? null;
  if (status !== "authenticated") return null;
  if (webSessionStatus === "temporarily_unavailable") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="space-y-3 text-center">
          <p>Authentication temporarily unavailable</p>
          <button
            type="button"
            className="rounded-md border px-3 py-2"
            onClick={() => {
              setWebSessionStatus("checking");
              setRetryGeneration((generation) => generation + 1);
            }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (webSessionStatus !== "ready") return null;
  return children ?? null;
}
