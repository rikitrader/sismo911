-- Cross-source de-duplication for the seismic `events` table.
-- USGS and FUNVISIS both report the same physical quake under different ids,
-- so they land as two rows / two map markers. Rather than DELETE the duplicate
-- (which the hourly ingest would just re-create — a treadmill), we MARK the
-- non-preferred row with `dup_of = <kept event id>` and filter `dup_of IS NULL`
-- on every public read. Non-destructive, idempotent, and re-marking a
-- re-ingested duplicate is a no-op. NULL = canonical/visible.
ALTER TABLE events ADD COLUMN dup_of TEXT;
CREATE INDEX IF NOT EXISTS idx_events_dup_of ON events(dup_of);
