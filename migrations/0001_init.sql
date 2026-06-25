-- SISMO911 schema — events + emergency operations
-- Seismic events ingested from USGS (source of truth for the map/feed).
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,           -- USGS event id (e.g. us6000t7zp)
  source        TEXT NOT NULL DEFAULT 'usgs',
  mag           REAL,
  place         TEXT,
  place_es      TEXT,
  time_ms       INTEGER NOT NULL,           -- epoch millis
  updated_ms    INTEGER,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  depth_km      REAL,
  mmi           REAL,                        -- max estimated intensity, if provided
  alert         TEXT,                        -- usgs PAGER alert: green/yellow/orange/red
  tsunami       INTEGER DEFAULT 0,
  felt          INTEGER,                     -- DYFI reports count
  url           TEXT,
  raw           TEXT,                        -- raw GeoJSON feature (JSON)
  ingested_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(time_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_mag  ON events(mag DESC);

-- Missing-persons registry (citizen + official entries). PII — access-controlled.
CREATE TABLE IF NOT EXISTS persons (
  id            TEXT PRIMARY KEY,
  full_name     TEXT NOT NULL,
  age           INTEGER,
  sex           TEXT,
  last_seen     TEXT,                        -- free-text location
  last_seen_lat REAL,
  last_seen_lon REAL,
  event_id      TEXT REFERENCES events(id),
  status        TEXT NOT NULL DEFAULT 'missing',  -- missing | found_safe | found_deceased | unknown
  contact_phone TEXT,
  notes         TEXT,
  photo_url     TEXT,
  reported_by   TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persons_status ON persons(status);
CREATE INDEX IF NOT EXISTS idx_persons_event  ON persons(event_id);

-- National emergency contact directory (Proteccion Civil, FUNVISIS, defense, medical).
CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  agency        TEXT NOT NULL,
  category      TEXT NOT NULL,               -- civil_protection | defense | fire | medical | seismology | police
  region        TEXT,                        -- estado / national
  phone         TEXT,
  alt_phone     TEXT,
  radio         TEXT,
  email         TEXT,
  lat           REAL,
  lon           REAL,
  is_hotline    INTEGER DEFAULT 0,
  source        TEXT,                        -- where the datum came from (public record / partner)
  verified_ms   INTEGER,
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_cat    ON contacts(category);
CREATE INDEX IF NOT EXISTS idx_contacts_region ON contacts(region);

-- Citizen / social situational reports (manual "Reportar Temblor" + future social adapters).
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,               -- citizen | x | facebook | instagram | tiktok
  external_id   TEXT,                        -- post id on the source platform
  event_id      TEXT REFERENCES events(id),
  text          TEXT,
  media_url     TEXT,
  author        TEXT,
  lat           REAL,
  lon           REAL,
  felt_intensity INTEGER,                     -- citizen-reported MMI 1-10
  sentiment     TEXT,
  created_ms    INTEGER NOT NULL,
  ingested_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_event   ON reports(event_id);
CREATE INDEX IF NOT EXISTS idx_reports_channel ON reports(channel);

-- Ingestion bookkeeping (last successful poll per source).
CREATE TABLE IF NOT EXISTS ingest_log (
  source        TEXT PRIMARY KEY,
  last_run_ms   INTEGER,
  last_ok_ms    INTEGER,
  last_count    INTEGER,
  last_error    TEXT
);
