-- 0086_telegram_intake.sql
-- Telegram photo/PDF intake bot: audit ledger for every submission the bot
-- ingests, whether it matched an existing case or created a draft one.
--
-- `personas.origen` already exists (migration 0020) — intake writes origen='telegram'
-- on any auto-created draft persona, so no ALTER is needed here.
--
-- Idempotent: CREATE ... IF NOT EXISTS so re-running is a no-op.

CREATE TABLE IF NOT EXISTS intake_submissions (
  id             TEXT PRIMARY KEY,               -- itk_xxxxxxxx (public code shown as ITK-XXXXXX)
  channel        TEXT NOT NULL DEFAULT 'telegram',
  tg_user_id     TEXT,                           -- Telegram numeric user id (as text)
  tg_username    TEXT,                           -- @handle if present
  tg_chat_id     TEXT,                           -- chat the file arrived in
  file_id        TEXT,                           -- Telegram file_id of the ingested media
  mime           TEXT,                           -- image/jpeg | image/png | application/pdf
  r2_key         TEXT,                           -- raw evidence stored in PERSON_PHOTOS bucket
  extracted_json TEXT,                           -- structured fields returned by Workers AI
  match_score    REAL,                           -- 0..1 confidence of the chosen match (NULL if none)
  outcome        TEXT NOT NULL DEFAULT 'pending',-- matched | created | needs_review | rejected | error
  person_id      TEXT,                           -- fam-<personas.id> when linked/created
  intel_id       TEXT,                           -- case_intel row created for this submission
  note           TEXT,                           -- short human-readable outcome note
  created_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intake_outcome ON intake_submissions(outcome, created_ms);
CREATE INDEX IF NOT EXISTS idx_intake_person  ON intake_submissions(person_id);
CREATE INDEX IF NOT EXISTS idx_intake_tguser  ON intake_submissions(tg_user_id, created_ms);
