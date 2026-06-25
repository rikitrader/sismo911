-- Movement / SOS layer: citizen damage-report map, community channel, persons.
-- Citizen submissions enter as status='pending' (moderation queue). Ingested
-- humanitarian data (KoboToolbox) enters as status='approved' with attribution.

CREATE TABLE IF NOT EXISTS map_reports (
  id            TEXT PRIMARY KEY,
  ext_id        TEXT UNIQUE,                 -- source dedup key (e.g. kobo _id)
  category      TEXT NOT NULL,               -- damaged_building | collapsed_building | trapped_people | gas_leak | aid_point | medical_need | water_point | shelter | other
  severity      TEXT,                        -- rojo | naranja | amarillo
  status        TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected
  verification  TEXT NOT NULL DEFAULT 'unverified',  -- unverified | community_confirmed | official_verified
  title         TEXT,
  description   TEXT,
  lat           REAL,                        -- published (privacy-rounded) coords
  lon           REAL,
  estado        TEXT,
  municipio     TEXT,
  parroquia     TEXT,
  building_type TEXT,
  people_trapped INTEGER,
  source        TEXT NOT NULL DEFAULT 'citizen',     -- citizen | kobotoolbox | usgs
  source_url    TEXT,
  image_key     TEXT,                        -- KV PHOTOS key
  reporter      TEXT,
  reactions_up  INTEGER NOT NULL DEFAULT 0,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mapreports_status  ON map_reports(status, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_mapreports_cat     ON map_reports(category);
CREATE INDEX IF NOT EXISTS idx_mapreports_sev     ON map_reports(severity);

-- Per-report citizen comments (verified-info threads).
CREATE TABLE IF NOT EXISTS report_comments (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES map_reports(id),
  name        TEXT,
  body        TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_report ON report_comments(report_id, created_ms);

-- Community channel (verified-info chat).
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL DEFAULT 'general',
  name        TEXT,
  body        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'citizen',   -- citizen | moderator | official
  flagged     INTEGER NOT NULL DEFAULT 0,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_channel ON chat_messages(channel, created_ms DESC);
