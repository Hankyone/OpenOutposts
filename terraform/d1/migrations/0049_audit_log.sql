-- The deployment's append-only security record.
--
-- This is not session history. Session history is product data a user may
-- delete; this table is the record of who was granted what authority over
-- which machine, and it has to survive that deletion. The two are kept in
-- different stores for exactly that reason.
--
-- It records identity and action and nothing else. No prompt, no model output,
-- no command line, no file path, no tool input or result. That exclusion is
-- what makes an immutable store safe to keep: an audit row can never be the
-- reason a secret someone pasted into a prompt is retained forever with no
-- delete path. The column list below is the whole vocabulary — there is no
-- free-form detail, metadata or note column, so there is no shape in which
-- content could arrive.
--
-- Append-only is enforced twice. In TypeScript, `src/db/audit-log.ts` has an
-- insert path and read paths and no update or delete code at all. Here, the
-- two triggers below abort any UPDATE or DELETE against the table, including
-- one issued by a future store module, a migration written in haste, or an
-- operator at a SQL console. Retention and export are deliberately absent: a
-- retention sweep is a delete path, and it needs its own reviewed design
-- (a migration that drops the trigger, prunes, and restores it) rather than an
-- ambient one that would also serve as an audit-scrubbing tool.
--
-- Every text column holds an identifier or a closed-vocabulary token, and the
-- CHECK constraints cap each one. The caps are not documentation: they are the
-- storage-layer half of "no content field", bounding what any writer can put
-- in a column even if it bypasses the store module. The module's own
-- validation is stricter still — it requires identifier-shaped values, which
-- prose and command lines are not.
CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  occurred_at   INTEGER NOT NULL, -- epoch ms
  action        TEXT NOT NULL,    -- closed vocabulary; see AUDIT_ACTIONS
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),

  -- Who. `actor_kind` says how the identity arrived; `actor_user_id` is the
  -- human it is attributable to, resolved by the control plane and never
  -- self-asserted. A machine-driven action carries the user the authority
  -- descends from — the session's owner — or NULL when the control plane
  -- cannot resolve one, which is recorded as absence rather than guessed.
  actor_kind    TEXT NOT NULL CHECK (
                  actor_kind IN ('user', 'service', 'internal', 'sandbox', 'outpost', 'system')
                ),
  actor_user_id TEXT,             -- canonical users.id
  actor_service TEXT,             -- service name for service principals

  -- What it touched. The three recurring subjects get their own columns
  -- because every query an auditor asks is scoped by one of them.
  session_id    TEXT,
  outpost_id    TEXT,
  lease_id      TEXT,
  object_kind   TEXT,             -- e.g. 'outpost_operation', 'provider_credential'
  object_id     TEXT,             -- the operation name, the provider slug

  -- Why, and how long. `reason` is a closed vocabulary, never a message: a
  -- worker's or a provider's free-text error is a content channel and stays in
  -- the structured logs.
  reason        TEXT,
  duration_ms   INTEGER,

  -- Correlation back to the structured logs, which hold the detail this table
  -- deliberately does not.
  request_id    TEXT,
  trace_id      TEXT,

  CHECK (length(action) <= 64),
  CHECK (actor_user_id IS NULL OR length(actor_user_id) <= 200),
  CHECK (actor_service IS NULL OR length(actor_service) <= 64),
  CHECK (session_id IS NULL OR length(session_id) <= 200),
  CHECK (outpost_id IS NULL OR length(outpost_id) <= 200),
  CHECK (lease_id IS NULL OR length(lease_id) <= 200),
  CHECK (object_kind IS NULL OR length(object_kind) <= 64),
  CHECK (object_id IS NULL OR length(object_id) <= 200),
  CHECK (reason IS NULL OR length(reason) <= 64),
  CHECK (request_id IS NULL OR length(request_id) <= 64),
  CHECK (trace_id IS NULL OR length(trace_id) <= 64)
);

-- The four questions the record is read by: what happened recently, what did
-- this person do, what happened to this session, and what happened on this
-- machine. Each index is (subject, time) so a scoped read stays ordered
-- without a sort.
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_outpost ON audit_log (outpost_id, occurred_at);

-- Append-only by construction. A record that can be rewritten is not evidence,
-- and the value of this table is entirely that a row, once written, is the
-- same row later. RAISE(ABORT) rolls back the whole statement, so a bulk
-- UPDATE or DELETE that happens to include an audit row fails as a unit rather
-- than partially applying.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be deleted');
END;
