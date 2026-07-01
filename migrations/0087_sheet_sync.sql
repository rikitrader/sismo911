-- Sheet-as-source-of-truth sync: fields the curated "Casos CRM" Google Sheet governs.
-- The Worker cron reads the sheet and upserts these into D1 (D1 stays the fast serving
-- layer the site reads). estado keeps its existing enum; deceased/hospitalized are
-- additive FLAGS so the sheet can drive them without breaking existing rendering.

-- personas (the public Familia directory — bulk of the rows)
ALTER TABLE personas ADD COLUMN hospitalizado       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN fallecido           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE personas ADD COLUMN hospital_nombre     TEXT;
ALTER TABLE personas ADD COLUMN sheet_case_no       TEXT;
ALTER TABLE personas ADD COLUMN synced_from_sheet_ms INTEGER;

-- persons (the CICPC-style investigation CRM — 411 cases; status already exists)
ALTER TABLE persons  ADD COLUMN hospitalizado       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE persons  ADD COLUMN fallecido           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE persons  ADD COLUMN hospital_nombre     TEXT;
ALTER TABLE persons  ADD COLUMN sheet_case_no       TEXT;
ALTER TABLE persons  ADD COLUMN synced_from_sheet_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_personas_sheet_case ON personas(sheet_case_no);
CREATE INDEX IF NOT EXISTS idx_persons_sheet_case  ON persons(sheet_case_no);
