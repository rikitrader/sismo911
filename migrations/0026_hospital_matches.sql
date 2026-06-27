-- Cross-match between desaparecidos and hospital intakes (rav_reports kind=hospital).
-- A match means a missing person's name equals a hospitalized person's name — a
-- LEAD to verify, never an automatic status change. The case keeps status
-- 'missing'; we add a persistent badge (read from here by /api/persons/cases) and
-- a PENDING docket note so an operator can confirm. One match row per (person, report).
CREATE TABLE IF NOT EXISTS hospital_matches (
  person_id     TEXT NOT NULL,      -- persons.id or 'fam-'||personas.id
  report_id     TEXT NOT NULL,      -- rav_reports.id (the hospital intake)
  hospital_name TEXT,
  name_key      TEXT,               -- normalized full name used for the match
  noted         INTEGER NOT NULL DEFAULT 0,  -- 1 once a docket note was written
  created_ms    INTEGER,
  PRIMARY KEY (person_id, report_id)
);
CREATE INDEX IF NOT EXISTS idx_hmatch_person ON hospital_matches(person_id);

-- Cursor state so the matcher drains the whole registry across cron ticks.
CREATE TABLE IF NOT EXISTS hospital_match_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  phase       TEXT NOT NULL DEFAULT 'personas',  -- personas | persons | done
  cursor      TEXT NOT NULL DEFAULT '',
  scanned     INTEGER NOT NULL DEFAULT 0,
  matched     INTEGER NOT NULL DEFAULT 0,
  updated_ms  INTEGER
);
INSERT OR IGNORE INTO hospital_match_state (id) VALUES (1);
