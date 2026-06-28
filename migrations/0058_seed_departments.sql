-- 0058_seed_departments.sql — seed the starter organizational departments.
--
-- The departments table (migration 0046) ships EMPTY: only org_sismo911 exists,
-- and operators were expected to create departments at runtime via the admin
-- Organización UI (/console → /api/rbac/departments). This seeds the 7 canonical
-- functional departments — mirroring the RBAC permission categories (see
-- scripts/rbac-catalog.mjs) — so the org hierarchy is populated out of the box
-- and staff can be assigned a department immediately.
--
-- Idempotent (INSERT OR IGNORE on a fixed PK). Fixed created_ms values give a
-- stable display order (the admin list orders by created_ms). Top-level only
-- (parent_id NULL); nest sub-departments later from the UI.
--
-- Apply on REMOTE under the gmail OAuth session:
--   wrangler d1 migrations apply sismo911 --remote --env-file /dev/null

INSERT OR IGNORE INTO departments (id, org_id, name, parent_id, created_ms) VALUES
  ('dept_operaciones',   'org_sismo911', 'Operaciones',              NULL, 1),
  ('dept_medico',        'org_sismo911', 'Médico / Salud',           NULL, 2),
  ('dept_logistica',     'org_sismo911', 'Logística y Suministros',  NULL, 3),
  ('dept_administracion','org_sismo911', 'Administración',           NULL, 4),
  ('dept_finanzas',      'org_sismo911', 'Finanzas',                 NULL, 5),
  ('dept_seguridad',     'org_sismo911', 'Seguridad',                NULL, 6),
  ('dept_tecnologia',    'org_sismo911', 'Tecnología / Sistemas',    NULL, 7);
