-- Per-user provider credentials: the model credentials a session's owner
-- brings to the harness.
--
-- The first genuinely owner-scoped secret store in the deployment. The three
-- scoped secret stores (global 0004, repo 0001, environment 0033) have no
-- owner column and are decrypted wholesale into a session's environment;
-- nothing there can express "this key belongs to this person". Every row here
-- names its owner and every read path filters on it.
--
-- `team_id` is reserved so a later team grant is an ownership-resolution
-- change rather than a table rewrite. Nothing writes it today.
--
-- `kind` separates a user-supplied API key from an OAuth grant. Only
-- 'api_key' is writable today; `refresh_secret_encrypted` and
-- `secret_expires_at` exist so a grant can be stored in the same row later
-- without another migration.
--
-- `key_version` records which encryption key generation sealed
-- `secret_encrypted`. No other encrypted column in this schema carries one,
-- which is exactly why key rotation has no migration path anywhere else. This
-- table starts with one so rotation never needs a backfill.
CREATE TABLE IF NOT EXISTS user_provider_credentials (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  team_id                  TEXT,             -- reserved for team ownership; always NULL today
  provider                 TEXT NOT NULL,    -- harness provider id, e.g. 'anthropic'
  label                    TEXT,             -- user-supplied description; never secret
  kind                     TEXT NOT NULL CHECK (kind IN ('api_key','oauth_grant')),
  key_version              INTEGER NOT NULL DEFAULT 1,
  secret_encrypted         TEXT NOT NULL,    -- API key, or an OAuth access token
  refresh_secret_encrypted TEXT,             -- OAuth refresh token
  secret_expires_at        INTEGER,          -- OAuth access-token expiry (epoch ms)
  created_at               INTEGER NOT NULL, -- epoch ms
  updated_at               INTEGER NOT NULL, -- epoch ms
  last_used_at             INTEGER,          -- stamped on every session issuance
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- One live credential per (owner, provider). Issuance resolves a session's
-- owner and the harness provider to exactly one row, so there is no tie to
-- break and no ordering rule to get wrong.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_provider_credentials_owner
  ON user_provider_credentials (user_id, provider);
