-- CIVIS satellite structural damage — civisvenezuela.com/api/edificaciones.
-- OFFICIAL-source layer (Copernicus EMS verified + Microsoft AI4G prediction):
-- ~975 geolocated buildings marked colapso/grave after the 24/06/2026 doble
-- terremoto. Deliberately SEPARATE from tv_buildings (terremotovenezuela
-- citizen-documented dossiers) and sos_damage (citizen reports): this is the
-- satellite evidence class; no cross-source merging. Idempotent UPSERT by
-- CIVIS uuid. Feeds /panorama + the Satélite tab on /edificios.

CREATE TABLE IF NOT EXISTS sat_edificaciones (
  id          TEXT PRIMARY KEY,              -- CIVIS uuid
  lat         REAL,
  lng         REAL,
  severidad   TEXT NOT NULL DEFAULT '',      -- colapso | grave
  oficial     INTEGER NOT NULL DEFAULT 0,    -- 1 = Copernicus-verified official
  zona        TEXT,                          -- Caraballeda / La Guaira, Moron, …
  uso         TEXT,                          -- Residential | Unclassified | …
  maps_url    TEXT,                          -- Google Maps deep link from CIVIS
  source      TEXT NOT NULL DEFAULT 'civis',
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sat_edif_severidad ON sat_edificaciones(severidad);
CREATE INDEX IF NOT EXISTS idx_sat_edif_zona      ON sat_edificaciones(zona);
CREATE INDEX IF NOT EXISTS idx_sat_edif_updated   ON sat_edificaciones(updated_ms DESC);

-- Hourly snapshot of CIVIS /api/estadisticas (full live counter set: personas,
-- atendidas, daños ciudadanos, daño satelital) + /api/panorama (AI summary).
-- One row per ingest run; /api/panorama/stats serves the latest row.
CREATE TABLE IF NOT EXISTS civis_stats_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_ms              INTEGER NOT NULL,
  stats_json            TEXT NOT NULL DEFAULT '{}',  -- raw /api/estadisticas stats object
  panorama_text         TEXT NOT NULL DEFAULT '',    -- AI summary (with disclaimer on render)
  panorama_generated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_civis_stats_taken ON civis_stats_snapshots(taken_ms DESC);
