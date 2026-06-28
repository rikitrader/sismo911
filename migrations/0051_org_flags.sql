-- 0051_org_flags.sql — scoped feature-flag overrides (org < role < user precedence).
--
-- Phase-0 shipped feature_flags(org_id, module_key) as an org-only opt-out base
-- layer (see migrations/0046_rbac_workforce.sql). This migration ADDS a higher-
-- precedence override layer WITHOUT touching that base table: an override row can
-- target a single org, a role, or a user, and the resolver (src/lib/feature-flags.ts)
-- layers them lowest→highest as:
--     base feature_flags(org)  <  override scope='org'  <  scope='role'  <  scope='user'
-- (highest matching wins; default ENABLED when no row exists anywhere).
--
-- Idempotent: CREATE … IF NOT EXISTS so re-runs are safe.

CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  id         TEXT PRIMARY KEY,                 -- ffo_xxxxxxxx
  module_key TEXT NOT NULL,                    -- 'telemedicina','flota',…
  scope_type TEXT NOT NULL,                    -- 'org' | 'role' | 'user'
  scope_id   TEXT NOT NULL,                    -- org_id | role key | user id
  enabled    INTEGER NOT NULL,                 -- 1 = on, 0 = off
  updated_by TEXT,                             -- actor user id
  updated_ms INTEGER
);

-- One row per (module, scope_type, scope_id) so PUT upserts cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ffo
  ON feature_flag_overrides(module_key, scope_type, scope_id);
