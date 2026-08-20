/**
 * Shared RFC 8628 device-code error classification.
 *
 * Each adapter still owns its success shape and its HTTP status quirks
 * (OpenAI treats 403/404 as pending). This only maps the standard OAuth
 * error codes so denied/expired/slow_down cannot drift between providers.
 */

import { jsonErrorMessage, optionalNumber } from "./http";
import type { DevicePollResult } from "./types";

export function classifyOAuthDeviceError(body: Record<string, unknown>): DevicePollResult | null {
  const error = body.error;
  if (error === "authorization_pending" || error === "deviceauth_authorization_pending") {
    return { status: "pending" };
  }
  if (error === "slow_down") {
    const intervalSeconds = optionalNumber(body.interval);
    return intervalSeconds !== undefined && intervalSeconds > 0
      ? { status: "pending", intervalSeconds }
      : { status: "pending" };
  }
  if (error === "access_denied" || error === "authorization_denied") {
    return { status: "denied", message: jsonErrorMessage(body, "Sign-in was denied") };
  }
  if (error === "expired_token") {
    return { status: "expired", message: jsonErrorMessage(body, "Device code expired") };
  }
  return null;
}
