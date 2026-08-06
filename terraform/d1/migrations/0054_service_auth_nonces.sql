-- A sig1 signature is single-use. Detection used to live in an isolate-local
-- Map that logged the reuse and then let the request through, which meant a
-- captured header stayed replayable for the whole validity window and a replay
-- aimed at a different isolate was never even seen. This is the same durable
-- one-use record the machine-identity proof already keeps in
-- outpost_connect_nonces, applied to the service credential.
CREATE TABLE IF NOT EXISTS service_auth_nonces (
  nonce_hash TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_service_auth_nonces_expiry
  ON service_auth_nonces (expires_at);
