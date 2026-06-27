-- person_events holds docket/timeline entries for BOTH native cases (persons.id)
-- AND federated Familia cases (fam-<personas.id>). The original FK
-- person_id REFERENCES persons(id) silently rejected EVERY Familia docket insert
-- (logDocket swallows the error), so Familia timelines were always empty and the
-- public status-update flow could not record hospitalizado/aparecido for them.
-- SQLite can't drop a constraint in place, so recreate the table without the FK.
-- Nothing references person_events, so no FK toggling is needed.
CREATE TABLE person_events_new (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL,            -- persons.id OR fam-<personas.id> (federated)
  kind        TEXT NOT NULL,
  status_from TEXT,
  status_to   TEXT,
  detail      TEXT,
  location    TEXT,
  lat         REAL,
  lon         REAL,
  source      TEXT,
  actor       TEXT,
  created_ms  INTEGER NOT NULL,
  review      TEXT NOT NULL DEFAULT 'approved'
);
INSERT INTO person_events_new (id, person_id, kind, status_from, status_to, detail, location, lat, lon, source, actor, created_ms, review)
  SELECT id, person_id, kind, status_from, status_to, detail, location, lat, lon, source, actor, created_ms, review FROM person_events;
DROP TABLE person_events;
ALTER TABLE person_events_new RENAME TO person_events;
CREATE INDEX IF NOT EXISTS idx_person_events_person ON person_events(person_id, created_ms ASC);
CREATE INDEX IF NOT EXISTS idx_person_events_kind   ON person_events(kind);
CREATE INDEX IF NOT EXISTS idx_person_events_review ON person_events(review, created_ms DESC);
