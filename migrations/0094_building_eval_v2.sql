-- 0094: Eval-layer v2 — bind signed tracking events to the authenticated RBAC user
-- and support append-only corrections (annulment pointer).
-- All additive; existing rows default to NULL. SQLite has no ADD COLUMN IF NOT
-- EXISTS — idempotency relies on the d1_migrations tracker (file runs once).

ALTER TABLE building_eval_events ADD COLUMN user_id TEXT;           -- authenticated RBAC user (server-stamped)
ALTER TABLE building_eval_events ADD COLUMN user_name TEXT;         -- display name/email at signing time
ALTER TABLE building_eval_events ADD COLUMN voids_event_id INTEGER; -- id of the event this 'anulacion' voids

CREATE INDEX IF NOT EXISTS idx_bee_voids ON building_eval_events (voids_event_id);
