-- Hospital patient registry — the consolidated "Registro Maestro de Pacientes –
-- Sismo Venezuela 2026" (hospital intake lists compiled by health staff /
-- volunteers / journalists, designed for the public to find loved ones by
-- name/cédula). Ingested from the maintainer's spreadsheet feed.
--
-- Honesty: OBSERVACIONES mixes hospitalized / discharged (alta) / deceased
-- (fallecido) / unknown — `estado` is PARSED per row, never assumed. Rows flagged
-- "ESTADO EN CONFLICTO" carry conflict=1 and are kept for operator review, not
-- auto-applied to cases. Idempotent (CREATE … IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS hospital_patients (
  id              TEXT PRIMARY KEY,                 -- hp_xxxxxxxx
  dedupe_key      TEXT,                             -- cédula (if valid) else hospital|norm_name
  hospital        TEXT,
  full_name       TEXT NOT NULL,                    -- primary display name
  name_variants   TEXT,                             -- JSON array of alternate spellings
  norm_name       TEXT,                             -- normalized primary name (matching)
  edad            TEXT,                             -- free-text age (may be range/blank)
  cedula          TEXT,
  telefono        TEXT,
  direccion       TEXT,
  estado          TEXT NOT NULL DEFAULT 'desconocido', -- hospitalizado | alta | fallecido | desconocido
  conflict        INTEGER NOT NULL DEFAULT 0,        -- "ESTADO EN CONFLICTO" → operator review
  observaciones   TEXT,
  source          TEXT NOT NULL DEFAULT 'registro-maestro',
  source_updated  TEXT,                             -- e.g. "30JUN26 00:40h"
  -- ── Cross-reference linkage to the missing-persons cases ──────────────────
  matched_person_id   TEXT,                         -- persons.id (operator registry)
  matched_persona_id  TEXT,                         -- personas.id (Familia registry)
  match_kind          TEXT,                         -- cedula | name | none
  match_confidence    TEXT NOT NULL DEFAULT 'none', -- high | low | none
  matched_ms          INTEGER,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hp_dedupe ON hospital_patients(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hp_norm   ON hospital_patients(norm_name);
CREATE INDEX IF NOT EXISTS idx_hp_cedula ON hospital_patients(cedula) WHERE cedula IS NOT NULL AND cedula <> '';
CREATE INDEX IF NOT EXISTS idx_hp_estado ON hospital_patients(estado);
CREATE INDEX IF NOT EXISTS idx_hp_hospital ON hospital_patients(hospital);
-- The match cron drains unmatched rows in pages.
CREATE INDEX IF NOT EXISTS idx_hp_unmatched ON hospital_patients(match_confidence, created_ms);
