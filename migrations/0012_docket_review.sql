-- Moderation for case-docket updates. The public can READ approved cases +
-- approved docket entries. Logged-in citizens can SUBMIT an update, which lands
-- as 'pending' until an operator/admin approves it. Operator/admin submissions
-- are auto-approved. Pre-existing rows are system/operator-made → 'approved'.
ALTER TABLE person_events ADD COLUMN review TEXT NOT NULL DEFAULT 'approved';  -- pending | approved | rejected
CREATE INDEX IF NOT EXISTS idx_person_events_review ON person_events(review, created_ms DESC);
