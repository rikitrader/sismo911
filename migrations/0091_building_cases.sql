-- 0091: building_cases — persistent linkage between a reported building
-- (tv_buildings) and a missing-person case (/casos expediente).
--
-- case_id uses the federated case-id scheme of /api/persons/:id/docket:
--   persons.id (native) · 'fam-<personas.id>' (Familia) · 'hosp-<id>' (hospital).
-- source: 'auto' = hourly name-token linker (tv-buildings cron) · 'manual' =
-- operator attach via POST /api/buildings/reported/:id/cases.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS building_cases (
  building_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (building_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_building_cases_case ON building_cases (case_id);
