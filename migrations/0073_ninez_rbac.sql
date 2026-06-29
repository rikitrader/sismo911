-- NIÑEZ / VULNERABLES — RBAC seed (permissions, grants, feature flag).
--
-- 0047_rbac_seed.sql is GENERATED from scripts/rbac-catalog.mjs and is already
-- applied on the live DB (it won't re-run), so the new `ninez` permission, its
-- grants and the feature flag are (idempotently) inserted here too. On a fresh
-- DB the regenerated 0047 inserts them first and these become no-ops.
-- (canonical source: scripts/rbac-catalog.mjs — `ninez` resource + module +
-- emergency_manager grant; read_only auto-holds ninez:read via the :read filter.)
--
-- operator (legacy) inherits emergency_manager, so it gains ninez:read/manage
-- transitively — no direct operator grant needed (matches the refugios pattern).
-- Idempotent: INSERT OR IGNORE.

INSERT OR IGNORE INTO rbac_permissions (key, resource, action, label, category) VALUES
 ('ninez:read','ninez','read','Read Ninez','Operations'),
 ('ninez:manage','ninez','manage','Manage Ninez','Operations');

INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_super_admin','ninez:read','allow'),
 ('role_super_admin','ninez:manage','allow'),
 ('role_emergency_manager','ninez:read','allow'),
 ('role_emergency_manager','ninez:manage','allow'),
 ('role_read_only','ninez:read','allow');

INSERT OR IGNORE INTO feature_flags (org_id, module_key, enabled, updated_ms) VALUES
 ('org_sismo911','ninez',1,0);
