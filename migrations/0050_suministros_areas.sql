-- SUMINISTROS per-area least-privilege (RBAC). Splits the flat operator access
-- to the inventory division into four function areas, so each operator can only
-- perform writes in their area. Built on the RBAC engine (rbac_*): new area
-- permissions + four area roles + assignment of the 4 provisioned operators to
-- their area role (which drops their broad ops:console — the engine uses
-- user_roles over the legacy users.role fallback).
--
-- Area → operations:
--   warehouse  : recepción, traslados, requisiciones
--   dispatch   : despacho, picklists, envíos, métodos de envío
--   inventory  : ajustes, conteos cíclicos
--   purchasing : proveedores, órdenes de compra, donaciones, facturas, cuentas
-- Catalog/config writes (ubicaciones, categorías, productos) stay on
-- `suministros:manage` (managers/admins only). Reads (GET) remain public.

-- ── Area permissions ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO rbac_permissions (key, resource, action, label, category) VALUES
 ('suministros:warehouse',  'suministros', 'warehouse',  'Almacén: recepción y traslados',        'Logistics'),
 ('suministros:dispatch',   'suministros', 'dispatch',   'Despacho: salidas, picklists, envíos',  'Logistics'),
 ('suministros:inventory',  'suministros', 'inventory',  'Inventario: ajustes y conteos',         'Logistics'),
 ('suministros:purchasing', 'suministros', 'purchasing', 'Compras: proveedores, OC, donaciones',  'Logistics');

-- ── Area roles (system, area-scoped) ─────────────────────────────────────────
INSERT OR IGNORE INTO rbac_roles (id, org_id, key, name, description, inherits_json, is_system, created_ms) VALUES
 ('role_sum_warehouse',  NULL, 'sum_warehouse',  'Suministros · Almacén',    'Recepción, traslados y requisiciones (sin acceso a otros módulos).', '[]', 1, 1782518400000),
 ('role_sum_dispatch',   NULL, 'sum_dispatch',   'Suministros · Despacho',   'Despacho, picklists y envíos.',                                     '[]', 1, 1782518400000),
 ('role_sum_inventory',  NULL, 'sum_inventory',  'Suministros · Inventario', 'Ajustes y conteos cíclicos.',                                       '[]', 1, 1782518400000),
 ('role_sum_purchasing', NULL, 'sum_purchasing', 'Suministros · Compras',    'Proveedores, órdenes de compra, donaciones y facturas.',            '[]', 1, 1782518400000);

-- ── Area role grants (each area role: its area perm + read-only on the division) ─
INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_sum_warehouse',  'suministros:warehouse',  'allow'),
 ('role_sum_warehouse',  'suministros:read',       'allow'),
 ('role_sum_dispatch',   'suministros:dispatch',   'allow'),
 ('role_sum_dispatch',   'suministros:read',       'allow'),
 ('role_sum_inventory',  'suministros:inventory',  'allow'),
 ('role_sum_inventory',  'suministros:read',       'allow'),
 ('role_sum_purchasing', 'suministros:purchasing', 'allow'),
 ('role_sum_purchasing', 'suministros:read',       'allow');

-- ── Keep existing managers/admins full-access: grant all 4 area perms to the
--    roles that already hold suministros:manage (super_admin short-circuits). ──
INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_operator',          'suministros:warehouse',  'allow'),
 ('role_operator',          'suministros:dispatch',   'allow'),
 ('role_operator',          'suministros:inventory',  'allow'),
 ('role_operator',          'suministros:purchasing', 'allow'),
 ('role_logistics',         'suministros:warehouse',  'allow'),
 ('role_logistics',         'suministros:dispatch',   'allow'),
 ('role_logistics',         'suministros:inventory',  'allow'),
 ('role_logistics',         'suministros:purchasing', 'allow'),
 ('role_emergency_manager', 'suministros:warehouse',  'allow'),
 ('role_emergency_manager', 'suministros:dispatch',   'allow'),
 ('role_emergency_manager', 'suministros:inventory',  'allow'),
 ('role_emergency_manager', 'suministros:purchasing', 'allow');

-- ── Assign the 4 provisioned operators to their area role (resolved by email).
--    This drops their legacy ops:console (engine uses user_roles over the
--    legacy fallback) → true least privilege. ─────────────────────────────────
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_ms)
 SELECT id, 'role_sum_warehouse',  1782518400000 FROM users WHERE email = 'almacen@sismo911.com';
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_ms)
 SELECT id, 'role_sum_inventory',  1782518400000 FROM users WHERE email = 'inventario@sismo911.com';
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_ms)
 SELECT id, 'role_sum_dispatch',   1782518400000 FROM users WHERE email = 'despacho@sismo911.com';
INSERT OR IGNORE INTO user_roles (user_id, role_id, granted_ms)
 SELECT id, 'role_sum_purchasing', 1782518400000 FROM users WHERE email = 'compras@sismo911.com';

-- Invalidate cached permission sets for the reassigned operators.
UPDATE users SET perm_epoch = COALESCE(perm_epoch, 0) + 1
 WHERE email IN ('almacen@sismo911.com','inventario@sismo911.com','despacho@sismo911.com','compras@sismo911.com');
