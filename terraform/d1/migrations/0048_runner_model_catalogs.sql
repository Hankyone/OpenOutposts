-- Model catalogs reported by central agent runners.
--
-- The harness owns the model registry (Pi's ModelRuntime) and the harness runs
-- inside a runner, so the control plane learns which models exist from a
-- runner's registration message or not at all. The runner Durable Object
-- stores that report in its own SQLite and stays the source of truth; this
-- table is the advisory directory, exactly as `outposts` (0046) is for the
-- fleet, so the model list can be served without a Durable Object round trip.
--
-- A row deliberately outlives its runner's connection. A catalog that survives
-- a disconnect is what keeps the settings page renderable and lets a stored
-- model id resolve to a display name while the fleet is briefly down; the
-- freshness question is answered by `reported_at`, not by deletion.
--
-- Providers and models are held as JSON rather than as per-model rows. A
-- report is written and read whole — the read path filters it against one
-- user's connected providers in memory — so per-model rows would serve no
-- query the product makes while turning a single write into a thousand.
--
-- `catalog_hash` is a digest of the reported content. A runner re-sends its
-- whole catalog on every reconnect, and reconnects are frequent; comparing the
-- digest is what stops a reconnect storm from rewriting an unchanged catalog.
CREATE TABLE IF NOT EXISTS runner_model_catalogs (
  runner_id       TEXT PRIMARY KEY,
  catalog_version INTEGER NOT NULL, -- payload version, independent of the wire protocol version
  catalog_hash    TEXT NOT NULL,
  providers_json  TEXT NOT NULL,
  models_json     TEXT NOT NULL,
  provider_count  INTEGER NOT NULL,
  model_count     INTEGER NOT NULL,
  reported_at     INTEGER NOT NULL  -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_runner_model_catalogs_reported
  ON runner_model_catalogs (reported_at);
