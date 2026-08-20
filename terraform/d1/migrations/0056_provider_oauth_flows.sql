-- Pending Pi-subscription OAuth flows (device code or authorization code).
--
-- Browser sign-in cannot keep a PKCE verifier or device_code in the page: the
-- control plane has to hold them until the user finishes authorizing. The
-- payload is encrypted and bound to the owning user, and the row is short-lived.
-- Completing or abandoning a flow deletes it; expiry is a backstop, not the
-- primary cleanup.
CREATE TABLE IF NOT EXISTS provider_oauth_flows (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  flow_kind          TEXT NOT NULL CHECK (flow_kind IN ('authorization_code', 'device_code')),
  payload_encrypted  TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One in-flight flow per owner per provider. Starting again replaces the
-- previous attempt rather than leaving two verifiers that could both complete.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_oauth_flows_owner_provider
  ON provider_oauth_flows (user_id, provider);

CREATE INDEX IF NOT EXISTS idx_provider_oauth_flows_expiry
  ON provider_oauth_flows (expires_at);
