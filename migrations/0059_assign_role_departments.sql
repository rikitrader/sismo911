-- 0059_assign_role_departments.sql — assign each system role to a department.
--
-- rbac_roles had no department link (only users.department_id existed). This adds
-- rbac_roles.department_id (nullable FK → departments) and assigns each of the 22
-- system roles to the department that owns it (departments seeded in 0058).
-- Cross-cutting roles (executive/utility/public: super_admin, owner, read_only,
-- guest, citizen) stay NULL — they are not owned by a single department.
--
-- Source of truth for the mapping: scripts/rbac-catalog.mjs → ROLE_DEPARTMENTS.
-- Idempotent: ADD COLUMN errors only if re-run (accepted); UPDATEs are by role key.
--
-- Apply on REMOTE under the gmail OAuth session:
--   wrangler d1 migrations apply sismo911 --remote --env-file /dev/null

ALTER TABLE rbac_roles ADD COLUMN department_id TEXT REFERENCES departments(id);

UPDATE rbac_roles SET department_id = 'dept_operaciones'    WHERE org_id IS NULL AND key IN ('operations_director','emergency_manager','dispatcher','incident_commander','case_manager','call_center','volunteer','operator');
UPDATE rbac_roles SET department_id = 'dept_medico'         WHERE org_id IS NULL AND key IN ('medical_director','doctor','nurse','paramedic');
UPDATE rbac_roles SET department_id = 'dept_logistica'      WHERE org_id IS NULL AND key = 'logistics';
UPDATE rbac_roles SET department_id = 'dept_finanzas'       WHERE org_id IS NULL AND key = 'finance';
UPDATE rbac_roles SET department_id = 'dept_administracion' WHERE org_id IS NULL AND key IN ('hr','support');
UPDATE rbac_roles SET department_id = 'dept_tecnologia'     WHERE org_id IS NULL AND key = 'developer';
