-- FLOTA live GPS — Uber-style, emergency-safe phone tracking.
-- (Spec called this 0039; 0039–0044 were already taken by concurrent suministros/
-- volunteer migrations, so it ships as 0045. Same content.)
--
-- New canonical English-named live-GPS tables. The empty legacy flota_unit_tokens
-- (migration 0038) is replaced here with the richer, expiring schema; src/lib/
-- flota-token.ts and the old token endpoints are repointed to it. Timestamps are
-- INTEGER unix-ms (app convention) under the spec's *_at names.

-- Replace the empty legacy token table (verified 0 rows in prod before migrating).
DROP TABLE IF EXISTS flota_unit_tokens;

-- Response units tracked live (distinct from the legacy Spanish flota_unidades).
CREATE TABLE IF NOT EXISTS flota_units (
  id          TEXT PRIMARY KEY,            -- unit_xxxxxxxx
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'rescate',
  status      TEXT NOT NULL DEFAULT 'active', -- active | inactive | suspended
  operator_id TEXT,                        -- owning operator (users.id)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_units_status ON flota_units(status);

-- Scoped, expiring, revocable, hashed per-unit tokens. Only the hash is stored.
CREATE TABLE IF NOT EXISTS flota_unit_tokens (
  id         TEXT PRIMARY KEY,             -- tok_xxxxxxxx
  unit_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL,                -- sha256(full token); looked up directly
  label      TEXT,
  expires_at INTEGER,                      -- unix-ms; NULL = no expiry (legacy issue path)
  revoked_at INTEGER,
  created_by TEXT,                         -- operator/admin users.id who issued it
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_unit_tokens_hash ON flota_unit_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_flota_unit_tokens_unit ON flota_unit_tokens(unit_id);

-- Append-only GPS location events.
CREATE TABLE IF NOT EXISTS flota_locations (
  id          TEXT PRIMARY KEY,            -- loc_xxxxxxxx
  unit_id     TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  heading     REAL,
  speed_mps   REAL,
  battery_pct INTEGER,
  source      TEXT DEFAULT 'phone',        -- phone | manual | import
  recorded_at INTEGER NOT NULL,            -- device clock (unix-ms)
  received_at INTEGER NOT NULL             -- server clock (unix-ms)
);
CREATE INDEX IF NOT EXISTS idx_flota_locations_unit ON flota_locations(unit_id, recorded_at);

-- Dispatch assignments linking a unit to a case/emergency.
CREATE TABLE IF NOT EXISTS flota_dispatches (
  id          TEXT PRIMARY KEY,            -- dsp_xxxxxxxx
  unit_id     TEXT NOT NULL,
  case_id     TEXT,
  status      TEXT NOT NULL DEFAULT 'assigned', -- assigned | enroute | onscene | cleared
  assigned_by TEXT,
  assigned_at INTEGER NOT NULL,
  cleared_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flota_dispatches_unit ON flota_dispatches(unit_id, status);

-- Tamper-evident audit log: token issue/revoke + GPS ingest (never raw secrets).
CREATE TABLE IF NOT EXISTS flota_audit_log (
  id         TEXT PRIMARY KEY,             -- aud_xxxxxxxx
  actor_id   TEXT,                         -- operator users.id, or 'unit:<id>' for device
  unit_id    TEXT,
  action     TEXT NOT NULL,                -- token.issue | token.revoke | gps.ingest | gps.reject
  meta_json  TEXT,                         -- JSON; NEVER contains the raw token
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_audit_unit ON flota_audit_log(unit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flota_audit_action ON flota_audit_log(action, created_at);
