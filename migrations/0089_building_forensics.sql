-- 0089_building_forensics.sql — forensic per-building profile ("court case" file).
--
-- Two additive tables that hang off tv_buildings (building_id = tv_buildings.id):
--
--   building_profile — ONE structured forensic record per building: year built,
--     structure type/system, floors, units, GIS refs (plus code, cadastral),
--     engineering/geological/national study links, occupancy + cost overrides,
--     complaint count. All nullable; operator-editable; empty until enriched.
--     No fabrication: a NULL means "sin dato / pendiente de estudio", never a guess.
--
--   building_docs — the EVIDENCE LIST: many rows per building. Each is one piece
--     of the dossier (photo set, PDF report, engineering study, geological study,
--     national/official study, news article, social post, complaint, court doc).
--     `kind` classifies the tab it shows under; `url` points at the artifact.
--
-- Idempotent (CREATE ... IF NOT EXISTS). building_id is NOT a hard FK (tv_buildings
-- rows are re-upserted by ingest) — it is a soft reference by id.

CREATE TABLE IF NOT EXISTS building_profile (
  building_id       TEXT PRIMARY KEY,          -- = tv_buildings.id
  year_built        INTEGER,                    -- año de construcción
  structure_type    TEXT,                       -- e.g. "Pórticos de concreto armado", "Mampostería"
  structure_system  TEXT,                       -- lateral system / notes
  floors            INTEGER,                     -- nº de pisos (surveyed, overrides estimate)
  units             INTEGER,                     -- nº de unidades/apartamentos
  occupancy_est     INTEGER,                     -- surveyed occupancy (overrides model)
  gross_area_m2     REAL,                        -- surveyed built area (overrides estimate)
  plus_code         TEXT,                        -- Google Plus Code
  cadastral_ref     TEXT,                        -- ficha catastral / parcela
  soil_type         TEXT,                        -- geotécnico (relleno, roca, aluvión…)
  repair_cost_usd   REAL,                        -- surveyed cost override
  replacement_cost_usd REAL,                     -- surveyed cost override
  engineer_study_url   TEXT,                     -- estudio de ingeniería (peritaje)
  geological_study_url TEXT,                     -- estudio geológico/geotécnico
  national_study_url   TEXT,                     -- estudio oficial (FUNVISIS/PC/CIV)
  first_built_permit   TEXT,                     -- permiso de construcción original
  last_inspection_at   TEXT,                     -- última inspección
  complaints_count  INTEGER NOT NULL DEFAULT 0,  -- nº de denuncias/quejas registradas
  summary           TEXT,                        -- forensic summary / hallazgos
  updated_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS building_docs (
  id            TEXT PRIMARY KEY,               -- uuid
  building_id   TEXT NOT NULL,                  -- = tv_buildings.id
  kind          TEXT NOT NULL DEFAULT 'other',  -- photo|pdf|engineering|geological|national|news|social|complaint|court|repair|other
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT,                           -- link or R2 object
  source        TEXT,                           -- provenance (outlet, agency, author)
  author        TEXT,
  published_at  TEXT,                           -- date on the document
  notes         TEXT,
  added_by      TEXT,
  created_at    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_building_docs_bld ON building_docs(building_id);
CREATE INDEX IF NOT EXISTS idx_building_docs_kind ON building_docs(kind);
