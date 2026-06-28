-- DEMO seed for the FLOTA live-GPS system — LOCAL / STAGING ONLY.
-- NEVER apply this to production (no fake units in a live emergency DB — hard rule).
-- Run only via scripts/seed-flota-demo.sh, which forces `--local`.
-- Idempotent: fixed ids + INSERT OR IGNORE.
INSERT OR IGNORE INTO flota_units (id, name, type, status, operator_id, created_at, updated_at) VALUES
  ('unit_demo_amb1', 'Ambulancia PC-01 (DEMO)', 'ambulancia', 'active', NULL, 1782600000000, 1782600000000),
  ('unit_demo_res1', 'Rescate B-02 (DEMO)',     'rescate',    'active', NULL, 1782600000000, 1782600000000),
  ('unit_demo_bom1', 'Autobomba B-07 (DEMO)',   'bomberos',   'active', NULL, 1782600000000, 1782600000000),
  ('unit_demo_dron', 'Dron SAR D-01 (DEMO)',    'dron',       'active', NULL, 1782600000000, 1782600000000);
