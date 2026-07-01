-- 0087_bulk_import.sql
-- Bulk roster importer: a multi-page PDF "padrón/expediente" full of names is
-- fanned out into MANY normal intake submissions (one draft persona + pending
-- case_intel lead each), so the whole batch surfaces in the EXISTING operator
-- review queue (/api/admin/intake). `bulk_import_jobs` is the parent job that
-- tracks progress + counts; each fanned-out `intake_submissions` row carries the
-- parent job id in the new `batch_id` column.
--
-- Nothing this creates is ever public: every auto-created persona stays
-- moderation='pending' until an operator approves it, exactly like the single
-- photo/PDF intake path.
--
-- Idempotent for the tables (CREATE ... IF NOT EXISTS). The ALTER adds a column;
-- re-running it will error (D1 has no ADD COLUMN IF NOT EXISTS) — the reconciled
-- d1_migrations tracker means this file applies exactly once.

CREATE TABLE IF NOT EXISTS bulk_import_jobs (
  id                   TEXT PRIMARY KEY,               -- bik_xxxxxxxx (public code IMP-XXXXXX)
  code                 TEXT NOT NULL,                  -- IMP-XXXXXX shown to the submitter
  source               TEXT NOT NULL DEFAULT 'telegram', -- telegram | console
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | error
  r2_key               TEXT,                           -- source PDF stored in PERSON_PHOTOS bucket
  mime                 TEXT,
  file_name            TEXT,
  total_records        INTEGER,                        -- names extracted (NULL until processed)
  created_records      INTEGER NOT NULL DEFAULT 0,     -- new draft personas
  matched_records      INTEGER NOT NULL DEFAULT 0,     -- attached to an existing case
  needs_review_records INTEGER NOT NULL DEFAULT 0,     -- no name/cédula legible
  error_records        INTEGER NOT NULL DEFAULT 0,     -- per-record persist failures
  chat_id              TEXT,                           -- Telegram chat to send the summary to
  submitted_by         TEXT,                           -- @handle / tg:id / operator email
  tg_user_id           TEXT,
  note                 TEXT,
  created_ms           INTEGER NOT NULL,
  updated_ms           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bulkjobs_status  ON bulk_import_jobs(status, created_ms);
CREATE INDEX IF NOT EXISTS idx_bulkjobs_created ON bulk_import_jobs(created_ms);

-- Link each fanned-out submission back to its parent roster job.
ALTER TABLE intake_submissions ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_intake_batch ON intake_submissions(batch_id);
