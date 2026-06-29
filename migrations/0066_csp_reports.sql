-- CSP violation reports captured during the Report-Only observation window (before we
-- drop script-src 'unsafe-inline'). Deduplicated by a signature so a violation that
-- fires on every page load collapses to ONE reviewable row with a hit `count`, instead
-- of flooding the table. Reviewed via GET /api/rbac/csp-violations (security:read).
CREATE TABLE IF NOT EXISTS csp_reports (
  sig                 TEXT PRIMARY KEY,            -- doc|directive|blocked|source|line|col (bounded)
  document_uri        TEXT,
  violated_directive  TEXT,
  effective_directive TEXT,
  blocked_uri         TEXT,
  source_file         TEXT,
  line_no             INTEGER,
  col_no              INTEGER,
  script_sample       TEXT,
  disposition         TEXT,
  user_agent          TEXT,
  count               INTEGER NOT NULL DEFAULT 1,
  first_seen          INTEGER NOT NULL,
  last_seen           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_csp_reports_last_seen ON csp_reports(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_csp_reports_count ON csp_reports(count DESC);
