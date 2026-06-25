-- Satellite / GIS damage assessments: an operator picks an area on the map and
-- Workers AI vision assesses the overhead imagery chip for earthquake damage.
CREATE TABLE IF NOT EXISTS sat_damage (
  id             TEXT PRIMARY KEY,
  lat            REAL NOT NULL,
  lon            REAL NOT NULL,
  zoom           INTEGER,
  bbox_n         REAL, bbox_s REAL, bbox_e REAL, bbox_w REAL,
  severity       TEXT,                 -- ninguno|leve|moderado|grave|severo|indeterminado
  summary        TEXT,
  hazards        TEXT,                 -- JSON array
  imagery_source TEXT,                 -- google | esri | maxar
  imagery_date   TEXT,
  event_id       TEXT,                 -- anchored to us6000t7zp (Yumare M7.5)
  ai_model       TEXT,
  analyzed_by    TEXT,
  verification   TEXT NOT NULL DEFAULT 'unverified',  -- unverified | verified | disputed
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sat_damage_created ON sat_damage(created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sat_damage_sev ON sat_damage(severity);
