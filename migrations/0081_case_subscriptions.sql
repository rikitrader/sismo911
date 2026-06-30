-- 0081_case_subscriptions.sql
-- Public EMAIL SUBSCRIPTIONS to a missing-person CASE, plus a per-case snapshot
-- the cron uses to detect changes between ticks. Flow: a citizen enters their
-- email (double opt-in → verify), then the `case-alerts` cron (src/cron.ts)
-- emails an AI-written summary whenever the watched fields of that case change.
--
-- `case_id` is the SAME unified id the investigation CRM uses (mirror of
-- caseExists() in src/routes/investigation.ts):
--   persons.id          → curated docket person
--   fam-<personas.id>   → public Familia registry missing person (the public surface)
--   hosp-<rav id>       → hospital intake
--
-- Idempotent: CREATE ... IF NOT EXISTS only, so re-running the migration is a no-op.

CREATE TABLE IF NOT EXISTS case_subscriptions (
  id              TEXT PRIMARY KEY,                 -- sub_<hex>
  case_id         TEXT NOT NULL,                    -- unified case id (see header)
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | active | unsubscribed
  verify_hash     TEXT,                             -- sha256(verify token); cleared once consumed (activation is sensitive)
  unsub_token     TEXT NOT NULL,                    -- plaintext one-click unsubscribe capability token (low-sensitivity URL)
  last_state_hash TEXT,                             -- watched-field hash at this sub's last alert (per-sub watermark)
  created_ms      INTEGER NOT NULL,
  verified_ms     INTEGER,
  last_alert_ms   INTEGER
);
-- One subscription per (case, email). A re-subscribe UPSERTs (re-arms verify).
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_subs_case_email ON case_subscriptions(case_id, email);
CREATE INDEX IF NOT EXISTS idx_case_subs_verify ON case_subscriptions(verify_hash);
CREATE INDEX IF NOT EXISTS idx_case_subs_unsub  ON case_subscriptions(unsub_token);
CREATE INDEX IF NOT EXISTS idx_case_subs_active ON case_subscriptions(case_id, status);

-- Per-case snapshot of the watched fields. The cron compares a freshly computed
-- hash against `state_hash` to decide whether the case changed; `state_json`
-- holds the prior human-readable values so the AI can describe WHAT changed.
CREATE TABLE IF NOT EXISTS case_alert_state (
  case_id    TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
