-- Moderation flag for citizen-submitted missing-person reports (DESAP.personas).
-- Default 'approved' so the existing 31k dataset + scraped rows stay visible;
-- only new public /api/familia/persons submissions enter as 'pending' and are
-- hidden from public reads until an operator approves them. (Applied directly
-- on remote via `wrangler d1 execute` because the DESAP migration chain is out
-- of sync; this file is the schema-of-record.)
-- NOTE: target database binding is DESAP, not the default DB.
ALTER TABLE personas ADD COLUMN moderation TEXT NOT NULL DEFAULT 'approved';
