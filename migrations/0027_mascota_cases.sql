-- 0027 — Lost-pet CASE TRACKING for /mascotas (mirrors the desaparecidos docket).
--
-- rav_reports (kind='mascota') is REFRESHED every :05 from RAV by an UPSERT whose
-- ON CONFLICT(id) DO UPDATE sets ONLY the RAV-sourced columns. The columns added
-- here are APP-OWNED: families/operators set them through the app and the ingest
-- never touches them — same golden rule as personas (estado/localizado_*). So a
-- "reunida" status set in-app survives the next cron sync.
--
-- Apply on remote under the gmail OAuth session, per statement (ADD COLUMN is not
-- idempotent — skip any that already exist). Do NOT `migrations apply --remote`.

-- App-owned tracking columns on rav_reports (ingest leaves these alone):
ALTER TABLE rav_reports ADD COLUMN case_status  TEXT;                       -- perdida | avistada | en_transito | reunida | fallecida  (NULL = derive from category/status)
ALTER TABLE rav_reports ADD COLUMN reunited_at  INTEGER;                     -- ms when marked reunida
ALTER TABLE rav_reports ADD COLUMN case_note    TEXT;                        -- operator/reunification note
ALTER TABLE rav_reports ADD COLUMN moderation   TEXT NOT NULL DEFAULT 'approved'; -- existing RAV rows stay visible; citizen-created reports start 'pending'
ALTER TABLE rav_reports ADD COLUMN reports_count INTEGER NOT NULL DEFAULT 0; -- # of citizen updates/sightings on this case
ALTER TABLE rav_reports ADD COLUMN case_updated_ms INTEGER;                  -- last activity (update/sighting) for sorting

CREATE INDEX IF NOT EXISTS idx_rav_reports_case_status ON rav_reports(case_status);
CREATE INDEX IF NOT EXISTS idx_rav_reports_moderation  ON rav_reports(moderation);

-- Timeline of sightings / updates on a pet case (the cronología), mirrors person_events.
CREATE TABLE IF NOT EXISTS mascota_events (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL,            -- rav_reports.id
  kind        TEXT NOT NULL,            -- avistamiento | nota | contacto | reunificada | estado | abierta
  status_from TEXT,
  status_to   TEXT,
  detail      TEXT,                     -- free text (<=2000)
  location    TEXT,                     -- where seen (<=200)
  lat         REAL,
  lng         REAL,
  contact     TEXT,                     -- reporter contact (<=120)
  source      TEXT,                     -- citizen | operator | system
  actor       TEXT,                     -- operator email when applicable
  created_ms  INTEGER NOT NULL,
  review      TEXT NOT NULL DEFAULT 'approved'  -- citizen updates land 'pending'; operator/system 'approved'
);
CREATE INDEX IF NOT EXISTS idx_mascota_events_report ON mascota_events(report_id, created_ms ASC);
CREATE INDEX IF NOT EXISTS idx_mascota_events_review ON mascota_events(review, created_ms DESC);
