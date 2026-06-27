-- 0030 — drop the case_attachments.person_id FK so citizen "aportes" work on
-- federated cases (Familia `fam-<id>` and hospital `hosp-<id>` have no `persons`
-- row). Mirrors 0022_person_events_drop_fk for person_events. case_attachments is
-- empty (0 rows) at migration time, so this is a clean DROP + CREATE (no data copy).
--
-- Apply on remote under the gmail OAuth session.

DROP TABLE IF EXISTS case_attachments;
CREATE TABLE case_attachments (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL,                 -- persons.id OR fam-<id> OR hosp-<id> (no FK — federated keys)
  kind         TEXT NOT NULL,                 -- photo | video | document | voice | gps | report
  r2_key       TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  description  TEXT,
  category     TEXT,
  source       TEXT,                          -- citizen | operator | hospital | morgue | ngo | gov
  verification TEXT NOT NULL DEFAULT 'unverified',
  uploaded_by  TEXT,
  lat          REAL,
  lon          REAL,
  created_ms   INTEGER NOT NULL,
  review       TEXT NOT NULL DEFAULT 'approved'  -- citizen aportes start 'pending'
);
CREATE INDEX IF NOT EXISTS idx_case_att_person ON case_attachments(person_id, review, created_ms DESC);
