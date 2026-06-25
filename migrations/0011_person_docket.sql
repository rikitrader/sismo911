-- Missing-person case docket / tracing log.
-- One row per traced event in a person's case: the report itself, every status
-- change, sightings, contact attempts, hospital/shelter/morgue matches, operator
-- notes. Rendered as a chronological court-style docket starting from the sismo.
CREATE TABLE IF NOT EXISTS person_events (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES persons(id),
  kind        TEXT NOT NULL,        -- report_filed | status_change | sighting | contact | note | shelter | hospital | morgue | reunified | review
  status_from TEXT,
  status_to   TEXT,
  detail      TEXT,
  location    TEXT,
  lat         REAL,
  lon         REAL,
  source      TEXT,                 -- citizen | operator | hospital | shelter | morgue | ngo | system
  actor       TEXT,                 -- operator email / id, when known
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_person_events_person ON person_events(person_id, created_ms ASC);
CREATE INDEX IF NOT EXISTS idx_person_events_kind   ON person_events(kind);
