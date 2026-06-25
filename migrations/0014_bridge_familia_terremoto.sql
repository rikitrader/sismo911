-- Bridge the case system to the terremoto + the Familia registry.
-- 1) Spanish place names + link existing native cases to the Yumare M7.5 event
--    (us6000t7zp, 2026-06-24) so every case docket starts at the date of the quake.
UPDATE events SET place_es = '28 km al SE de Yumare, Venezuela' WHERE id = 'us6000t7zp' AND (place_es IS NULL OR place_es = '');
UPDATE events SET place_es = '23 km al SE de Yumare, Venezuela' WHERE id = 'us6000t7zc' AND (place_es IS NULL OR place_es = '');
UPDATE persons SET event_id = 'us6000t7zp' WHERE event_id IS NULL;

-- 2) Metadata overlay so Familia-origin cases (which live in the DESAP `personas`
--    DB and have no row in `persons`) can still carry priority / incident type /
--    assignee like native cases. Keyed by the federated case id ("fam-<personas.id>").
CREATE TABLE IF NOT EXISTS case_meta (
  person_id     TEXT PRIMARY KEY,
  priority      TEXT,
  incident_type TEXT,
  assigned_to   TEXT,
  updated_ms    INTEGER
);
