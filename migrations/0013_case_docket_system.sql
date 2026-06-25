-- Court-style emergency case docket system. Turns each missing-person record
-- into a full digital expediente: case number, priority, incident type, assigned
-- responder, plus evidence/attachments, tasks, internal messages and the roster
-- of victims/contacts tied to the case.

-- Case metadata on the existing persons (case) record.
ALTER TABLE persons ADD COLUMN case_number   TEXT;                       -- EXP-2026-0001
ALTER TABLE persons ADD COLUMN priority      TEXT NOT NULL DEFAULT 'media';   -- alta | media | baja
ALTER TABLE persons ADD COLUMN incident_type TEXT NOT NULL DEFAULT 'persona_desaparecida';
ALTER TABLE persons ADD COLUMN assigned_to   TEXT;                       -- responder name / unit

-- Stable, human-readable case numbers for existing rows (ordered by insertion).
UPDATE persons SET case_number = printf('EXP-2026-%04d', rowid) WHERE case_number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_case_number ON persons(case_number);
CREATE INDEX IF NOT EXISTS idx_persons_priority ON persons(priority);

-- Evidence / uploads: photos, videos, documents (PDF), voice notes, GPS, reports.
CREATE TABLE IF NOT EXISTS case_attachments (
  id           TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES persons(id),
  kind         TEXT NOT NULL,                 -- photo | video | document | voice | gps | report
  r2_key       TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  description  TEXT,
  category     TEXT,                          -- evidencia | parte_policial | identificacion | escena | otro
  source       TEXT,                          -- citizen | operator | hospital | morgue | ngo | gov
  verification TEXT NOT NULL DEFAULT 'unverified',  -- unverified | verified | disputed
  uploaded_by  TEXT,
  lat          REAL,
  lon          REAL,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_attach_person ON case_attachments(person_id, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_case_attach_kind   ON case_attachments(kind);

-- Tasks assigned to responders within a case.
CREATE TABLE IF NOT EXISTS case_tasks (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES persons(id),
  title       TEXT NOT NULL,
  detail      TEXT,
  assignee    TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | done
  priority    TEXT NOT NULL DEFAULT 'media',  -- alta | media | baja
  due_ms      INTEGER,
  created_by  TEXT,
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_tasks_person ON case_tasks(person_id, created_ms DESC);

-- Internal case messages / coordination thread (operators).
CREATE TABLE IF NOT EXISTS case_messages (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES persons(id),
  author      TEXT,
  body        TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_messages_person ON case_messages(person_id, created_ms ASC);

-- Victims / contacts / witnesses linked to a case.
CREATE TABLE IF NOT EXISTS case_victims (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES persons(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'contacto', -- victima | contacto | testigo | familiar
  phone       TEXT,
  relation    TEXT,
  notes       TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_victims_person ON case_victims(person_id, created_ms ASC);
