-- 0086_search_filters.sql
-- Full-database search + filter support for /casos and /personas.
--
-- Adds STRUCTURED, INDEXED search fields to the three registries that the
-- unified case docket (/api/persons/cases) unions:
--   • persons            (native operator expedientes)
--   • personas           (Familia federated registry)
--   • hospital_patients  (Registro Maestro de Pacientes)
--
-- New columns (all NULLable, additive — no existing data is touched):
--   name_norm     accent-folded + lowercased name, for case/accent-insensitive
--                 search (hospital_patients already carries `norm_name`, reused).
--   geo_estado    normalized Venezuelan estado slug parsed from the free-text
--                 location (persons.last_seen / personas.ubicacion /
--                 hospital_patients.direccion|hospital). NULL when unparsed —
--                 the query keeps a raw-location LIKE fallback so unparsed rows
--                 stay findable.
--   geo_municipio normalized municipio slug parsed from the same free text.
--   age_num       hospital_patients only: numeric age parsed from the free-text
--                 `edad` (may be a range/blank) so age-range filters can include
--                 hospital rows. persons.age / personas.edad are already INTEGER.
--
-- Backfill of existing rows is done by scripts/backfill-search-fields.mjs (runs
-- the same JS normalizer used on the write path). Re-running this migration
-- errors on the ADD COLUMNs (SQLite has no ADD COLUMN IF NOT EXISTS); the D1
-- migration tracker was reconciled 2026-06-27 so each migration applies once.
-- Indexes are IF NOT EXISTS so index creation stays idempotent.

-- ── persons (native cases) ────────────────────────────────────────────────
ALTER TABLE persons ADD COLUMN name_norm     TEXT;
ALTER TABLE persons ADD COLUMN geo_estado    TEXT;
ALTER TABLE persons ADD COLUMN geo_municipio TEXT;

CREATE INDEX IF NOT EXISTS idx_persons_name_norm  ON persons(name_norm);
CREATE INDEX IF NOT EXISTS idx_persons_geo_estado ON persons(geo_estado);
CREATE INDEX IF NOT EXISTS idx_persons_geo_muni   ON persons(geo_municipio);
CREATE INDEX IF NOT EXISTS idx_persons_age        ON persons(age);
CREATE INDEX IF NOT EXISTS idx_persons_sex        ON persons(sex);
CREATE INDEX IF NOT EXISTS idx_persons_created    ON persons(created_ms);

-- ── personas (Familia registry) ───────────────────────────────────────────
-- NOTE: personas.estado is the CASE STATUS, so the geographic column is
-- deliberately named geo_estado (never `estado`) to avoid collision.
ALTER TABLE personas ADD COLUMN name_norm     TEXT;
ALTER TABLE personas ADD COLUMN geo_estado    TEXT;
ALTER TABLE personas ADD COLUMN geo_municipio TEXT;

CREATE INDEX IF NOT EXISTS idx_personas_name_norm  ON personas(name_norm);
CREATE INDEX IF NOT EXISTS idx_personas_geo_estado ON personas(geo_estado);
CREATE INDEX IF NOT EXISTS idx_personas_geo_muni   ON personas(geo_municipio);
CREATE INDEX IF NOT EXISTS idx_personas_edad       ON personas(edad);
CREATE INDEX IF NOT EXISTS idx_personas_created    ON personas(created_at);

-- ── hospital_patients (Registro Maestro) ──────────────────────────────────
-- norm_name already exists + is indexed (idx_hp_norm); reuse it for name search.
ALTER TABLE hospital_patients ADD COLUMN age_num       INTEGER;
ALTER TABLE hospital_patients ADD COLUMN geo_estado    TEXT;
ALTER TABLE hospital_patients ADD COLUMN geo_municipio TEXT;

CREATE INDEX IF NOT EXISTS idx_hp_age_num    ON hospital_patients(age_num);
CREATE INDEX IF NOT EXISTS idx_hp_geo_estado ON hospital_patients(geo_estado);
CREATE INDEX IF NOT EXISTS idx_hp_geo_muni   ON hospital_patients(geo_municipio);
CREATE INDEX IF NOT EXISTS idx_hp_created    ON hospital_patients(created_ms);
