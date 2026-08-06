import { TOKEN_VALIDITY_MS, type ServiceName } from "@open-inspect/shared";

import { hashToken } from "./crypto";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";

export interface ServiceNonceCorrelation {
  requestId?: string;
  traceId?: string;
}

/**
 * Burn a signature's nonce, refusing the request if it has already been spent.
 *
 * The insert is what enforces uniqueness, so the write must be the gate. A
 * storage failure therefore denies rather than admits: a nonce we could not
 * record is a nonce we cannot promise is unspent.
 */
export async function consumeServiceNonce(
  db: SqlDatabase,
  service: ServiceName,
  nonce: string,
  logger: Logger,
  correlation: ServiceNonceCorrelation = {}
): Promise<boolean> {
  const now = Date.now();
  const nonceHash = await hashToken(`${service}:${nonce}`);
  try {
    await db.batch([
      db.prepare("DELETE FROM service_auth_nonces WHERE expires_at <= ?").bind(now),
      db
        .prepare(
          "INSERT INTO service_auth_nonces (nonce_hash, service, expires_at) VALUES (?, ?, ?)"
        )
        .bind(nonceHash, service, now + TOKEN_VALIDITY_MS),
    ]);
    return true;
  } catch (e) {
    // A primary-key collision is a replay. Anything else is the store failing,
    // and the two must not be logged as the same thing: one is an attack and
    // the other is an outage. Both still refuse.
    const detail = e instanceof Error ? e.message : String(e);
    const isReplay = /UNIQUE|constraint/i.test(detail);
    if (isReplay) {
      logger.warn("Service auth nonce reused", {
        event: "auth.nonce_reuse",
        service,
        request_id: correlation.requestId,
        trace_id: correlation.traceId,
      });
    } else {
      logger.error("Service auth nonce store unavailable - refusing request", {
        event: "auth.nonce_store_failed",
        service,
        error: detail,
        request_id: correlation.requestId,
        trace_id: correlation.traceId,
      });
    }
    return false;
  }
}
