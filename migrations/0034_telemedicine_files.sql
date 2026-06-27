-- Telemedicine v2 — attachments on an appointment (photos the patient sends,
-- documents the doctor attaches). Bytes live in R2 (PERSON_PHOTOS, telemed/ prefix);
-- this table is the index. Idempotent.
CREATE TABLE IF NOT EXISTS telemed_appt_files (
  id             TEXT PRIMARY KEY,   -- f_...
  appointment_id TEXT NOT NULL,
  uploader       TEXT,               -- patient | doctor
  r2_key         TEXT NOT NULL,
  filename       TEXT,
  content_type   TEXT,
  caption        TEXT,
  at_ms          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemed_files ON telemed_appt_files(appointment_id, at_ms);
