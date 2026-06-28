-- 0060_assign_suministros_role_departments.sql — finish the role→department map.
--
-- The 4 SUMINISTROS division area roles (seeded in 0050) were the only system
-- roles left without a department after 0059. They all belong to Logística y
-- Suministros (dept_logistica, seeded in 0058). Assign them so EVERY role is
-- owned by a department.
--
-- Apply on REMOTE under the gmail OAuth session:
--   wrangler d1 migrations apply sismo911 --remote --env-file /dev/null

UPDATE rbac_roles SET department_id = 'dept_logistica'
 WHERE org_id IS NULL AND key IN ('sum_warehouse','sum_dispatch','sum_inventory','sum_purchasing');
