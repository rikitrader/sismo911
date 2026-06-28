-- SUMINISTROS seed — starter reference data + sample stock for the inventory
-- division. Idempotent (INSERT OR IGNORE on fixed IDs). Caducidad values are
-- chosen relative to ~2026-06-27 so the dashboard shows live alerts:
--   1781000000000 ≈ 2026-06-14 (VENCIDO) · 1784000000000 ≈ 2026-07-09 (POR VENCER)
--   1800000000000 ≈ 2027-01-15 (vigente).

-- ── Categorías ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO sum_categorias (id, nombre, color, descripcion, created_ms) VALUES
  ('cat_agua', 'Agua',      '#2563eb', 'Agua potable y almacenamiento',        1782518400000),
  ('cat_alim', 'Alimentos', '#16a34a', 'Raciones y alimentos no perecederos',  1782518400000),
  ('cat_medi', 'Medicina',  '#dc2626', 'Insumos médicos y medicamentos',       1782518400000),
  ('cat_refu', 'Refugio',   '#d97706', 'Carpas, mantas y abrigo',              1782518400000),
  ('cat_higi', 'Higiene',   '#0891b2', 'Kits e insumos de higiene',            1782518400000),
  ('cat_resc', 'Rescate',   '#7c3aed', 'Equipo de rescate y protección',       1782518400000);

-- ── Ubicaciones ───────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO sum_ubicaciones (id, nombre, tipo, codigo, estado_region, responsable, activa, created_ms, updated_ms) VALUES
  ('ubi_ccs', 'Depósito Central Caracas',   'deposito',           'DEP-CCS', 'Distrito Capital', 'Coord. Logística', 1, 1782518400000, 1782518400000),
  ('ubi_val', 'Almacén Valencia',           'almacen',            'ALM-VAL', 'Carabobo',         'Almacén Regional', 1, 1782518400000, 1782518400000),
  ('ubi_lgu', 'Refugio La Guaira',          'refugio',            'REF-LGU', 'La Guaira',        'Jefe de Refugio',  1, 1782518400000, 1782518400000),
  ('ubi_var', 'Hospital Vargas',            'hospital',           'HOS-VAR', 'Distrito Capital', 'Farmacia',         1, 1782518400000, 1782518400000),
  ('ubi_mer', 'Punto Distribución Mérida',  'punto_distribucion', 'PDD-MER', 'Mérida',           'Distribución',     1, 1782518400000, 1782518400000);

-- ── Productos (catálogo) ──────────────────────────────────────────────────────
INSERT OR IGNORE INTO sum_productos (id, codigo, nombre, categoria_id, unidad, perecedero, stock_min, activo, created_ms, updated_ms) VALUES
  ('prod_agua1', 'PRD-AGUA01', 'Agua potable 1.5L',     'cat_agua', 'unidad',  0, 500, 1, 1782518400000, 1782518400000),
  ('prod_agua2', 'PRD-AGUA02', 'Bidón de agua 20L',     'cat_agua', 'unidad',  0, 100, 1, 1782518400000, 1782518400000),
  ('prod_arroz', 'PRD-ALIM01', 'Arroz (saco 10kg)',     'cat_alim', 'saco',    1, 200, 1, 1782518400000, 1782518400000),
  ('prod_atun',  'PRD-ALIM02', 'Atún enlatado',         'cat_alim', 'caja',    1, 300, 1, 1782518400000, 1782518400000),
  ('prod_para',  'PRD-MEDI01', 'Paracetamol 500mg',     'cat_medi', 'blister', 1, 400, 1, 1782518400000, 1782518400000),
  ('prod_suero', 'PRD-MEDI02', 'Suero oral',            'cat_medi', 'unidad',  1, 250, 1, 1782518400000, 1782518400000),
  ('prod_vend',  'PRD-MEDI03', 'Vendas estériles',      'cat_medi', 'paquete', 0, 150, 1, 1782518400000, 1782518400000),
  ('prod_carpa', 'PRD-REFU01', 'Carpa familiar',        'cat_refu', 'unidad',  0,  50, 1, 1782518400000, 1782518400000),
  ('prod_manta', 'PRD-REFU02', 'Manta térmica',         'cat_refu', 'unidad',  0, 300, 1, 1782518400000, 1782518400000),
  ('prod_jabon', 'PRD-HIGI01', 'Jabón antibacterial',   'cat_higi', 'unidad',  0, 200, 1, 1782518400000, 1782518400000),
  ('prod_kit',   'PRD-HIGI02', 'Kit higiene personal',  'cat_higi', 'paquete', 0, 150, 1, 1782518400000, 1782518400000),
  ('prod_casco', 'PRD-RESC01', 'Casco de rescate',      'cat_resc', 'unidad',  0,  30, 1, 1782518400000, 1782518400000);

-- ── Items (lotes / caducidad) ─────────────────────────────────────────────────
INSERT OR IGNORE INTO sum_items (id, producto_id, lote, caducidad_ms, created_ms) VALUES
  ('item_agua1',   'prod_agua1', NULL,        NULL,          1782518400000),
  ('item_agua2',   'prod_agua2', NULL,        NULL,          1782518400000),
  ('item_arroz_a', 'prod_arroz', 'LOTE-AR01', 1784000000000, 1782518400000), -- por vencer
  ('item_arroz_b', 'prod_arroz', 'LOTE-AR02', 1800000000000, 1782518400000),
  ('item_atun_a',  'prod_atun',  'LOTE-AT01', 1800000000000, 1782518400000),
  ('item_para_a',  'prod_para',  'LOTE-PA01', 1781000000000, 1782518400000), -- VENCIDO
  ('item_para_b',  'prod_para',  'LOTE-PA02', 1800000000000, 1782518400000),
  ('item_suero_a', 'prod_suero', 'LOTE-SU01', 1784000000000, 1782518400000), -- por vencer
  ('item_vend',    'prod_vend',  NULL,        NULL,          1782518400000),
  ('item_carpa',   'prod_carpa', NULL,        NULL,          1782518400000),
  ('item_manta',   'prod_manta', NULL,        NULL,          1782518400000),
  ('item_jabon',   'prod_jabon', NULL,        NULL,          1782518400000),
  ('item_kit',     'prod_kit',   NULL,        NULL,          1782518400000),
  ('item_casco',   'prod_casco', NULL,        NULL,          1782518400000);

-- ── Existencias (on-hand por ubicación). kit (110<150) y casco (25<30) quedan
--    bajo mínimo; para_a vencido en Hospital Vargas; arroz_a y suero_a por vencer.
INSERT OR IGNORE INTO sum_existencias (ubicacion_id, item_id, cantidad, updated_ms) VALUES
  ('ubi_ccs', 'item_agua1',   800, 1782518400000),
  ('ubi_ccs', 'item_agua2',   150, 1782518400000),
  ('ubi_ccs', 'item_arroz_a', 120, 1782518400000),
  ('ubi_ccs', 'item_arroz_b',  90, 1782518400000),
  ('ubi_ccs', 'item_atun_a',  400, 1782518400000),
  ('ubi_ccs', 'item_para_b',  600, 1782518400000),
  ('ubi_ccs', 'item_suero_a', 200, 1782518400000),
  ('ubi_ccs', 'item_vend',    220, 1782518400000),
  ('ubi_ccs', 'item_carpa',    60, 1782518400000),
  ('ubi_ccs', 'item_manta',   500, 1782518400000),
  ('ubi_ccs', 'item_jabon',   350, 1782518400000),
  ('ubi_ccs', 'item_kit',      80, 1782518400000),
  ('ubi_ccs', 'item_casco',    15, 1782518400000),
  ('ubi_val', 'item_agua1',   300, 1782518400000),
  ('ubi_val', 'item_atun_a',  150, 1782518400000),
  ('ubi_val', 'item_manta',   200, 1782518400000),
  ('ubi_val', 'item_jabon',   120, 1782518400000),
  ('ubi_val', 'item_para_b',  200, 1782518400000),
  ('ubi_lgu', 'item_agua1',    50, 1782518400000),
  ('ubi_lgu', 'item_manta',    80, 1782518400000),
  ('ubi_lgu', 'item_kit',      30, 1782518400000),
  ('ubi_lgu', 'item_suero_a',  50, 1782518400000),
  ('ubi_var', 'item_para_a',   40, 1782518400000),
  ('ubi_var', 'item_para_b',  100, 1782518400000),
  ('ubi_var', 'item_suero_a',  60, 1782518400000),
  ('ubi_var', 'item_vend',     40, 1782518400000),
  ('ubi_mer', 'item_agua2',    30, 1782518400000),
  ('ubi_mer', 'item_arroz_b',  40, 1782518400000),
  ('ubi_mer', 'item_casco',    10, 1782518400000);
