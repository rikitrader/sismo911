-- ============================================================================
-- 0053_lifecycle.sql — Phase 2 Wave 2: USER LIFECYCLE.
--
-- Adds the columns + table the invitation/approval workflow needs:
--   • invitations.phone        — destination for the SMS invite channel.
--   • invitations.approved_by  — who approved the resulting account (audit hook).
--   • approval_requests        — one row per account that landed status='pending'
--                                and is awaiting an approver decision.
--
-- Additive + idempotent: bare ADD COLUMN runs once via the migration tracker
-- (same convention as 0046/0052); the table is CREATE … IF NOT EXISTS.
-- ============================================================================

ALTER TABLE invitations ADD COLUMN phone TEXT;            -- SMS channel destination
ALTER TABLE invitations ADD COLUMN approved_by TEXT;      -- approver of the accepted account

CREATE TABLE IF NOT EXISTS approval_requests (
  id                TEXT PRIMARY KEY,                     -- apr_xxxxxxxx
  user_id           TEXT,                                 -- the pending account
  requested_role_id TEXT,                                 -- role to grant on approval
  status            TEXT DEFAULT 'pending',               -- pending | approved | rejected
  decided_by        TEXT,                                 -- approver user id
  decided_ms        INTEGER,
  created_ms        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_user ON approval_requests(user_id);
