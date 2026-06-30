-- 0084: reversible archive for the hospital_patients duplicate collapse.
-- collapseHospitalDupes() moves losing duplicate rows HERE (never silently deletes)
-- before removing them from hospital_patients, so a bad merge can be undone.
CREATE TABLE IF NOT EXISTS hospital_patients_dupes (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  hospital TEXT,
  full_name TEXT,
  name_variants TEXT,
  norm_name TEXT,
  edad TEXT,
  cedula TEXT,
  telefono TEXT,
  direccion TEXT,
  estado TEXT,
  conflict INTEGER,
  observaciones TEXT,
  source TEXT,
  source_updated TEXT,
  matched_person_id TEXT,
  matched_persona_id TEXT,
  match_kind TEXT,
  match_confidence REAL,
  matched_ms INTEGER,
  created_ms INTEGER,
  updated_ms INTEGER,
  merged_into TEXT,         -- id of the surviving (winner) row this was merged into
  archived_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hpd_norm ON hospital_patients_dupes(norm_name);
CREATE INDEX IF NOT EXISTS idx_hpd_merged ON hospital_patients_dupes(merged_into);
