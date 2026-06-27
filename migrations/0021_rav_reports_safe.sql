-- 0021 — RAV (redayudavenezuela.com) extra datasets: citizen reports + safe check-ins.
--
-- Two more readable Supabase tables the public bundle doesn't even use:
--   reports       (~9.3k) — multi-kind citizen reports: mascota (lost pets),
--                  voluntario (volunteers offering help), atrapados (trapped),
--                  ayuda_int (intl aid), dano (damage) — with photo/geo/contact.
--   safe_reports  (~300)  — "estoy a salvo" check-ins (name/city/state/status).
--
-- Both keyed on the RAV uuid → UPSERT = no duplicates by construction. Apply per
-- statement on remote under the gmail OAuth session (CREATE TABLE IF NOT EXISTS
-- is idempotent; do NOT `migrations apply --remote`, the tracker is drifted).

CREATE TABLE IF NOT EXISTS rav_reports (
  id          TEXT PRIMARY KEY,          -- RAV uuid
  kind        TEXT,                      -- mascota | voluntario | atrapados | ayuda_int | dano | …
  category    TEXT,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  city        TEXT,
  state       TEXT,
  area        TEXT,
  lat         REAL,
  lng         REAL,
  contact     TEXT,
  status      TEXT,
  photo_url   TEXT,
  meta        TEXT NOT NULL DEFAULT '{}',
  tags        TEXT NOT NULL DEFAULT '[]',
  origen      TEXT NOT NULL DEFAULT 'rav',
  ext_id      TEXT,
  created_at  TEXT,
  synced_at   TEXT,
  pulled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rav_reports_kind   ON rav_reports(kind);
CREATE INDEX IF NOT EXISTS idx_rav_reports_status ON rav_reports(status);
CREATE INDEX IF NOT EXISTS idx_rav_reports_created ON rav_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS rav_safe_reports (
  id          TEXT PRIMARY KEY,          -- RAV uuid
  slug        TEXT,
  name        TEXT NOT NULL DEFAULT '',
  city        TEXT,
  state       TEXT,
  area        TEXT,
  status      TEXT,
  note        TEXT,
  photo_url   TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  origen      TEXT NOT NULL DEFAULT 'rav',
  created_at  TEXT,
  synced_at   TEXT,
  pulled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rav_safe_created ON rav_safe_reports(created_at DESC);
-- cedula intentionally NOT stored — PII we don't need for a public safe-list.
