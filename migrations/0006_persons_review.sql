-- Public (moderated) missing-persons reporting.
-- Existing rows are treated as approved; citizen submissions enter as 'pending'.
ALTER TABLE persons ADD COLUMN review TEXT NOT NULL DEFAULT 'approved';  -- pending | approved | rejected
CREATE INDEX IF NOT EXISTS idx_persons_review ON persons(review, updated_ms DESC);
