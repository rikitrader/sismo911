-- CIVIS "atendidos" ingest — widen hospital_patients so a person attended in a
-- hospital (or refugio) that CIVIS Venezuela (civisvenezuela.com/atendidos)
-- publishes can be mirrored into our registry as a full, deduped profile.
--
-- CIVIS exposes /api/atendidos with a STABLE per-record code (ATN-XXXXXXXX). We
-- store it in `source_ref` for exact-idempotent re-ingest and traceability, plus
-- `foto_url` (published photo, almost always null today but carried when present)
-- and `sexo` (F/M/null). Name-level dedupe still rides the existing dedupe_key
-- UNIQUE index; source_ref is traceability only, so it is NON-unique on purpose
-- (a name-collision collapse must not fight a source_ref uniqueness constraint).
--
-- Column adds error if re-run (SQLite has no ADD COLUMN IF NOT EXISTS); the
-- migration tracker applies each file once, and the ingest also ensures these
-- columns at runtime (try/catch) so a lagging DB self-heals.

ALTER TABLE hospital_patients ADD COLUMN source_ref TEXT;
ALTER TABLE hospital_patients ADD COLUMN foto_url   TEXT;
ALTER TABLE hospital_patients ADD COLUMN sexo       TEXT;

CREATE INDEX IF NOT EXISTS idx_hp_source_ref ON hospital_patients(source, source_ref);
