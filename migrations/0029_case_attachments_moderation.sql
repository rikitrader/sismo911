-- 0029 — per-case documents/pictures/files (Mascotas + Desaparecidos), moderated.
--
-- Citizens and operators can attach photos/documents/files to a case. Citizen
-- uploads land review='pending' and an operator approves before they're public;
-- operator uploads are 'approved'. Files live in the PERSON_PHOTOS R2 bucket.
--
-- Apply on remote under the gmail OAuth session, per statement (ADD COLUMN is not
-- idempotent — skip it if it already exists). Do NOT `migrations apply --remote`.

-- Mascota case attachments (new — mascotas had no attachments before).
CREATE TABLE IF NOT EXISTS mascota_attachments (
  id           TEXT PRIMARY KEY,
  report_id    TEXT NOT NULL,                 -- rav_reports.id (kind='mascota')
  kind         TEXT NOT NULL DEFAULT 'photo', -- photo | document | file
  r2_key       TEXT NOT NULL,                 -- PERSON_PHOTOS key
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  description  TEXT,
  category     TEXT,                          -- foto | volante | veterinario | otro
  source       TEXT NOT NULL DEFAULT 'citizen', -- citizen | operator
  review       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  uploaded_by  TEXT,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mascota_att_report ON mascota_attachments(report_id, review, created_ms DESC);

-- Desaparecidos: add moderation to the existing confidential attachments table so
-- citizen "aportes" (contributions) can be distinguished + moderated. Existing
-- operator rows default to 'approved' (unchanged visibility).
ALTER TABLE case_attachments ADD COLUMN review TEXT NOT NULL DEFAULT 'approved';
