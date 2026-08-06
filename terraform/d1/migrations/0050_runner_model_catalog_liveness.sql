-- Liveness for the advisory runner model catalog directory (0048).
--
-- 0048 stored `reported_at` and offered every stored catalog forever, so a
-- retired runner kept contributing models to the picker and to the session
-- creation check. A user selected one, creation passed, and the session died
-- as a generic spawn failure with no mention of the model — a fail-loudly
-- violation produced by the fail-loudly feature.
--
-- `reported_at` cannot answer the freshness question on its own: a runner
-- re-sends its whole catalog on every reconnect and the directory deliberately
-- skips the rewrite when the digest is unchanged, so a healthy runner's
-- `reported_at` can be arbitrarily old. Liveness therefore gets its own column,
-- refreshed from the runner's heartbeat, and a disconnect is recorded outright
-- rather than waited out.
--
-- Rows still outlive the connection, exactly as 0048 intended: a stale row can
-- resolve a stored model id to a display name and keep the settings page
-- renderable. What it may no longer do is be offered.
--
-- `connection_id` mirrors the Durable Object's own `runner` table so a close
-- arriving after a newer connection registered cannot mark the live row dead.
ALTER TABLE runner_model_catalogs ADD COLUMN connection_id TEXT;
ALTER TABLE runner_model_catalogs ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runner_model_catalogs ADD COLUMN disconnected_at INTEGER;

-- The last report is the last time this deployment provably heard from the
-- runner, so it is the honest starting value. Rows older than the liveness
-- window are stale from the moment this migration lands, which is the correct
-- direction: they are offered again the moment their runner heartbeats.
UPDATE runner_model_catalogs SET last_seen_at = reported_at;

CREATE INDEX IF NOT EXISTS idx_runner_model_catalogs_last_seen
  ON runner_model_catalogs (last_seen_at);
