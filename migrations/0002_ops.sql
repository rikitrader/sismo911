-- Phase 2–4 operational tables.

-- Family safety check-ins
CREATE TABLE IF NOT EXISTS checkins (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'safe',   -- safe | need_help | unknown
  message     TEXT,
  lat         REAL,
  lon         REAL,
  event_id    TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkins_created ON checkins(created_ms DESC);

-- Emergency SOS signals
CREATE TABLE IF NOT EXISTS sos_alerts (
  id          TEXT PRIMARY KEY,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  name        TEXT,
  phone       TEXT,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | acknowledged | resolved
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_alerts(status, created_ms DESC);

-- Resource & supply tracking
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                   -- water | food | shelter | medical | fuel | power
  label       TEXT NOT NULL,
  quantity    TEXT,
  status      TEXT NOT NULL DEFAULT 'available', -- available | low | depleted
  region      TEXT,
  lat         REAL,
  lon         REAL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind);

-- HAM / emergency comms directory
CREATE TABLE IF NOT EXISTS comms_channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  band        TEXT,                            -- HF | VHF | UHF | citizen
  frequency   TEXT,
  mode        TEXT,                            -- FM | SSB | etc
  region      TEXT,
  purpose     TEXT,
  created_ms  INTEGER NOT NULL
);

-- Web Push subscriptions + per-user alert prefs
CREATE TABLE IF NOT EXISTS push_subs (
  id          TEXT PRIMARY KEY,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  min_mag     REAL DEFAULT 4.0,
  lat         REAL,
  lon         REAL,
  radius_km   REAL DEFAULT 300,
  created_ms  INTEGER NOT NULL
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS audit (
  id          TEXT PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_ms  INTEGER NOT NULL
);
