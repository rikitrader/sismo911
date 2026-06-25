-- AI damage-photo assessments.
CREATE TABLE IF NOT EXISTS damage_reports (
  id          TEXT PRIMARY KEY,
  photo_key   TEXT NOT NULL,          -- KV key for the stored image
  content_type TEXT,
  severity    TEXT,                   -- ninguno | leve | moderado | grave | severo | indeterminado
  summary     TEXT,                   -- AI-generated assessment (Spanish)
  hazards     TEXT,                   -- JSON array of detected hazards
  lat         REAL,
  lon         REAL,
  event_id    TEXT,
  ai_model    TEXT,
  reporter    TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_damage_created ON damage_reports(created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_damage_severity ON damage_reports(severity);
