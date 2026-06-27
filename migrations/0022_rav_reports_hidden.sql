-- Duplicate-photo cleanup for citizen reports (/mascotas etc).
-- `hidden` flags a report as a duplicate (same image content re-submitted under a
-- different URL). It is intentionally NOT part of the ingest UPSERT's SET clause,
-- so the flag survives every re-sync from RAV. The reports feed filters hidden=0.
ALTER TABLE rav_reports ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
