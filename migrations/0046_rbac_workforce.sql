-- ============================================================================
-- 0046_rbac_workforce.sql — Enterprise RBAC + workforce-management foundation.
--
-- ADDITIVE ONLY. Nothing is dropped. The live site keeps working identically:
-- the legacy users.role column (citizen|operator|admin) is preserved and remains
-- the fast-path gate until the permission engine fully supersedes it. Every new
-- workforce table carries org_id so multi-org is never a redesign (schema-ready,
-- single-org UI per the locked decision).
--
-- Conventions (match the rest of this repo): TEXT PRIMARY KEY with a typed prefix
-- (org_, dept_, team_, role_, inv_, …); timestamps are INTEGER unix-ms; CREATE
-- TABLE IF NOT EXISTS so re-application is safe. D1 does not enforce FKs by
-- default — REFERENCES here document intent and aid future PRAGMA enforcement.
-- ============================================================================

-- ── Organizations (multi-tenant root) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY,                 -- org_xxxxxxxx
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  logo_r2       TEXT,                             -- R2 key, optional
  branding_json TEXT,                             -- {primary, accent, …} JSON
  status        TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER
);

-- The single canonical organization for the current single-org deployment.
-- Everything below defaults to it; the org switcher UI is deferred.
INSERT OR IGNORE INTO organizations (id, slug, name, status, created_ms)
VALUES ('org_sismo911', 'sismo911', 'SISMO911', 'active', 0);

-- ── Departments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,                    -- dept_xxxxxxxx
  org_id     TEXT NOT NULL DEFAULT 'org_sismo911' REFERENCES organizations(id),
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES departments(id),     -- nestable
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);

-- ── Teams + membership ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,                    -- team_xxxxxxxx
  org_id     TEXT NOT NULL DEFAULT 'org_sismo911' REFERENCES organizations(id),
  name       TEXT NOT NULL,
  color      TEXT,                                -- hex chip color
  priority   INTEGER NOT NULL DEFAULT 0,
  leader_id  TEXT REFERENCES users(id),
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id      TEXT NOT NULL REFERENCES teams(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  role_in_team TEXT,                              -- 'leader' | 'member' | free text
  added_ms     INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- ── RBAC: roles (with inheritance) ──────────────────────────────────────────
-- org_id NULL => global/system role usable across all orgs. inherits_json is a
-- JSON array of role keys this role absorbs (resolved transitively in code).
CREATE TABLE IF NOT EXISTS rbac_roles (
  id           TEXT PRIMARY KEY,                  -- role_xxxxxxxx
  org_id       TEXT REFERENCES organizations(id), -- NULL = system/global
  key          TEXT NOT NULL,                     -- 'super_admin', 'dispatcher', …
  name         TEXT NOT NULL,
  description  TEXT,
  inherits_json TEXT NOT NULL DEFAULT '[]',       -- ["operator", …]
  is_system    INTEGER NOT NULL DEFAULT 0,        -- 1 = built-in, not deletable
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rbac_roles_key ON rbac_roles(IFNULL(org_id,''), key);

-- ── RBAC: permission catalog (resource:action) ──────────────────────────────
-- Seeded in 0047/seed. New module => new rows here, no schema change (extensible
-- per the final objective).
CREATE TABLE IF NOT EXISTS rbac_permissions (
  key        TEXT PRIMARY KEY,                    -- 'patients:read'
  resource   TEXT NOT NULL,                       -- 'patients'
  action     TEXT NOT NULL,                       -- 'read'
  label      TEXT NOT NULL,                       -- human label
  category   TEXT                                 -- grouping for the UI
);
CREATE INDEX IF NOT EXISTS idx_rbac_perms_resource ON rbac_permissions(resource);

-- role → permission grant. effect 'deny' overrides 'allow' at resolution time.
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id  TEXT NOT NULL REFERENCES rbac_roles(id),
  perm_key TEXT NOT NULL REFERENCES rbac_permissions(key),
  effect   TEXT NOT NULL DEFAULT 'allow',         -- allow | deny
  PRIMARY KEY (role_id, perm_key)
);

-- ── RBAC: user assignments + direct overrides ───────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
  user_id       TEXT NOT NULL REFERENCES users(id),
  role_id       TEXT NOT NULL REFERENCES rbac_roles(id),
  scope_org_id  TEXT REFERENCES organizations(id),  -- NULL = user's home org
  scope_dept_id TEXT REFERENCES departments(id),     -- optional dept scoping
  granted_by    TEXT REFERENCES users(id),
  granted_ms    INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

-- direct per-user permission override (allow grants extra, deny revokes).
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    TEXT NOT NULL REFERENCES users(id),
  perm_key   TEXT NOT NULL REFERENCES rbac_permissions(key),
  effect     TEXT NOT NULL DEFAULT 'allow',        -- allow | deny
  granted_by TEXT REFERENCES users(id),
  granted_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, perm_key)
);

-- ── Feature flags (per-org module toggles) ──────────────────────────────────
-- Disabled module => routes 404, sidebar/search/shortcuts omit it (no info leak).
CREATE TABLE IF NOT EXISTS feature_flags (
  org_id     TEXT NOT NULL DEFAULT 'org_sismo911' REFERENCES organizations(id),
  module_key TEXT NOT NULL,                        -- 'telemedicina','flota',…
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id),
  updated_ms INTEGER,
  PRIMARY KEY (org_id, module_key)
);

-- ── Field-level security policies ───────────────────────────────────────────
-- e.g. ('patients','medical_notes','perm','patients:medical_notes')
--      ('persons','gps','perm','incidents:gps')   ('users','phone','hidden',NULL)
CREATE TABLE IF NOT EXISTS field_policies (
  id          TEXT PRIMARY KEY,                    -- fp_xxxxxxxx
  org_id      TEXT NOT NULL DEFAULT 'org_sismo911' REFERENCES organizations(id),
  resource    TEXT NOT NULL,                       -- 'patients'
  field       TEXT NOT NULL,                       -- 'medical_notes'
  visibility  TEXT NOT NULL DEFAULT 'visible',     -- visible | hidden | readonly | perm
  required_perm TEXT,                              -- when visibility='perm'
  created_ms  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_policies ON field_policies(org_id, resource, field);

-- ── Invitations (email/sms/magic-link/qr/csv) + approval workflow ───────────
CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,                    -- inv_xxxxxxxx
  org_id      TEXT NOT NULL DEFAULT 'org_sismo911' REFERENCES organizations(id),
  email       TEXT NOT NULL,
  role_id     TEXT REFERENCES rbac_roles(id),
  dept_id     TEXT REFERENCES departments(id),
  token_hash  TEXT NOT NULL,                       -- sha256 of the invite token
  channel     TEXT NOT NULL DEFAULT 'email',       -- email | sms | magic | qr | csv
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending | accepted | expired | revoked
  invited_by  TEXT REFERENCES users(id),
  expires_ms  INTEGER NOT NULL,
  created_ms  INTEGER NOT NULL,
  accepted_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- ── Login history (success + failure) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_history (
  id         TEXT PRIMARY KEY,                     -- lh_xxxxxxxx
  user_id    TEXT REFERENCES users(id),            -- NULL if email unknown
  email      TEXT,                                 -- attempted email
  ip         TEXT,
  ua         TEXT,
  ok         INTEGER NOT NULL,                     -- 1 success, 0 failure
  reason     TEXT,                                 -- 'bad_password','locked',…
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_login_history_ok ON login_history(ok, created_ms);

-- ── Security events (perm changes, elevation, deletes, sensitive access) ────
CREATE TABLE IF NOT EXISTS security_events (
  id         TEXT PRIMARY KEY,                     -- se_xxxxxxxx
  type       TEXT NOT NULL,                        -- 'perm.change','user.suspend','impersonate.start',…
  actor_id   TEXT REFERENCES users(id),
  target_id  TEXT,                                 -- affected user/record id
  ip         TEXT,
  detail_json TEXT,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(type, created_ms);
CREATE INDEX IF NOT EXISTS idx_security_events_actor ON security_events(actor_id, created_ms);

-- ── Impersonation log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS impersonation_log (
  id          TEXT PRIMARY KEY,                    -- imp_xxxxxxxx
  admin_id    TEXT NOT NULL REFERENCES users(id),
  target_id   TEXT NOT NULL REFERENCES users(id),
  reason      TEXT,
  started_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,                    -- auto-expire
  ended_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_impersonation_admin ON impersonation_log(admin_id);

-- ── Extend users with workforce + security fields (additive ALTERs) ─────────
-- SQLite/D1 requires one ADD COLUMN per statement and constant defaults.
ALTER TABLE users ADD COLUMN org_id          TEXT DEFAULT 'org_sismo911';
ALTER TABLE users ADD COLUMN preferred_name  TEXT;
ALTER TABLE users ADD COLUMN username         TEXT;
ALTER TABLE users ADD COLUMN job_title        TEXT;
ALTER TABLE users ADD COLUMN department_id    TEXT;
ALTER TABLE users ADD COLUMN manager_id       TEXT;
ALTER TABLE users ADD COLUMN office           TEXT;
ALTER TABLE users ADD COLUMN location         TEXT;
ALTER TABLE users ADD COLUMN employment_type  TEXT DEFAULT 'employee';  -- employee|volunteer|contractor|agency|partner|temporary
ALTER TABLE users ADD COLUMN status           TEXT DEFAULT 'active';    -- active|inactive|suspended|pending|locked|deleted
ALTER TABLE users ADD COLUMN timezone         TEXT;
ALTER TABLE users ADD COLUMN language         TEXT DEFAULT 'es';
ALTER TABLE users ADD COLUMN notes            TEXT;
ALTER TABLE users ADD COLUMN emergency_contact TEXT;
ALTER TABLE users ADD COLUMN avatar_r2        TEXT;
ALTER TABLE users ADD COLUMN last_ip          TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled      INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret       TEXT;
ALTER TABLE users ADD COLUMN api_access       INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN perm_epoch       INTEGER DEFAULT 1;        -- bump => KV perm cache invalidated

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Extend sessions with IP + revocation (additive; existing rows get NULL/0).
ALTER TABLE sessions ADD COLUMN ip         TEXT;
ALTER TABLE sessions ADD COLUMN revoked_ms INTEGER;
