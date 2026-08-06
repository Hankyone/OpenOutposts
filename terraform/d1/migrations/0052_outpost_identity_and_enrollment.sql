-- Durable fleet ownership and per-machine enrollment.
--
-- Existing rows intentionally remain unowned. They are invisible to users and
-- cannot authenticate through the new machine-key path until an administrator
-- explicitly claims them through the legacy migration route.
ALTER TABLE outposts ADD COLUMN owner_user_id TEXT;
ALTER TABLE outposts ADD COLUMN owner_team_id TEXT;
ALTER TABLE outposts ADD COLUMN public_key TEXT;
ALTER TABLE outposts ADD COLUMN key_algorithm TEXT;
ALTER TABLE outposts ADD COLUMN key_fingerprint TEXT;
ALTER TABLE outposts ADD COLUMN enrolled_at INTEGER;
ALTER TABLE outposts ADD COLUMN enrolled_by_user_id TEXT;
ALTER TABLE outposts ADD COLUMN confirmed_at INTEGER;
ALTER TABLE outposts ADD COLUMN revoked_at INTEGER;
ALTER TABLE outposts ADD COLUMN access_scope TEXT;
ALTER TABLE outposts ADD COLUMN workspace_roots_json TEXT;

CREATE INDEX IF NOT EXISTS idx_outposts_owner
  ON outposts (owner_user_id, revoked_at, connected, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outposts_key_fingerprint
  ON outposts (key_fingerprint)
  WHERE key_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS outpost_enrollments (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  owner_team_id TEXT,
  access_scope TEXT NOT NULL DEFAULT 'full',
  requested_name TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  outpost_id TEXT UNIQUE,
  confirmation_code_hash TEXT,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (outpost_id) REFERENCES outposts(id)
);

CREATE INDEX IF NOT EXISTS idx_outpost_enrollments_owner
  ON outpost_enrollments (owner_user_id, issued_at DESC);

-- A signed WebSocket upgrade proof is single-use. Keeping the nonce hash in D1
-- closes the small replay window created by its timestamp allowance.
CREATE TABLE IF NOT EXISTS outpost_connect_nonces (
  nonce_hash TEXT PRIMARY KEY,
  outpost_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (outpost_id) REFERENCES outposts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outpost_connect_nonces_expiry
  ON outpost_connect_nonces (expires_at);
