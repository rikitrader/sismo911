-- ============================================================================
-- 0052_rbac_finegrained.sql — Phase 2 R1 + U4 (delta over the 0047 seed snapshot).
--
-- R1: fine-grained per-surface permissions that replace the coarse `ops:console`
--     in the global gate (src/rbac/route-policy.ts). Granted to the legacy
--     `operator` role (and `super_admin`) so access is preserved 1:1.
-- U4: temporary role assignments — `user_roles.expires_ms`; the engine ignores a
--     role whose expiry has passed.
-- All idempotent (INSERT OR IGNORE / bare ADD COLUMN runs once via the tracker).
-- Source of truth stays scripts/rbac-catalog.mjs (already updated).
-- ============================================================================

-- New fine-grained permissions.
INSERT OR IGNORE INTO rbac_permissions (key, resource, action, label, category) VALUES
 ('admin:maintenance','admin','maintenance','Maintenance Admin','Operations'),
 ('contacts:manage','contacts','manage','Manage Contacts','Operations'),
 ('acopio:manage','acopio','manage','Manage Acopio','Logistics'),
 ('aid_orgs:manage','aid_orgs','manage','Manage Aid Orgs','Operations'),
 ('emergencia:manage','emergencia','manage','Manage Emergencia','Operations'),
 ('damage:moderate','damage','moderate','Moderate Damage','Operations'),
 ('persons:moderate','persons','moderate','Moderate Persons','Operations'),
 ('sos:triage','sos','triage','Triage Sos','Operations'),
 ('events:refresh','events','refresh','Refresh Events','Operations'),
 ('sat:analyze','sat','analyze','Analyze Sat','Operations');

-- Grant them to the operator role (direct allow) so the gate migration is access-preserving.
INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_operator','admin:maintenance','allow'),
 ('role_operator','contacts:manage','allow'),
 ('role_operator','acopio:manage','allow'),
 ('role_operator','aid_orgs:manage','allow'),
 ('role_operator','emergencia:manage','allow'),
 ('role_operator','damage:moderate','allow'),
 ('role_operator','persons:moderate','allow'),
 ('role_operator','sos:triage','allow'),
 ('role_operator','events:refresh','allow'),
 ('role_operator','sat:analyze','allow');

-- Mirror them onto super_admin's explicit grant list (engine god-mode already
-- covers it; this keeps the role-editor matrix complete).
INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_super_admin','admin:maintenance','allow'),
 ('role_super_admin','contacts:manage','allow'),
 ('role_super_admin','acopio:manage','allow'),
 ('role_super_admin','aid_orgs:manage','allow'),
 ('role_super_admin','emergencia:manage','allow'),
 ('role_super_admin','damage:moderate','allow'),
 ('role_super_admin','persons:moderate','allow'),
 ('role_super_admin','sos:triage','allow'),
 ('role_super_admin','events:refresh','allow'),
 ('role_super_admin','sat:analyze','allow');

-- U4: temporary role expiry.
ALTER TABLE user_roles ADD COLUMN expires_ms INTEGER;
