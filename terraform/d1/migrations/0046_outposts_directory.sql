-- Cross-outpost directory. Each outpost's Durable Object owns its own state;
-- this index exists so the deployment can list its fleet (UI pickers, status
-- dashboards) without knowing outpost IDs in advance. Rows are upserted by
-- the outpost DO on register/disconnect and are advisory: the DO remains the
-- source of truth for per-outpost state.
CREATE TABLE IF NOT EXISTS outposts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disconnected_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outposts_connected ON outposts (connected, last_seen_at);
