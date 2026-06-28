-- SUMINISTROS — Proveedores, donantes y vínculos producto-proveedor.
-- Additive tables: sum_proveedores (supplier/donor registry) and
-- sum_producto_proveedor (price + lead-time per product-supplier pair). Idempotent.

-- ── sum_proveedores ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sum_proveedores (
  id            TEXT PRIMARY KEY,              -- prv_xxxxxxxx
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'proveedor', -- proveedor|donante|fabricante|distribuidor
  rif           TEXT,
  contacto      TEXT,
  telefono      TEXT,
  email         TEXT,
  direccion     TEXT,
  estado_region TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  notas         TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_proveedores_tipo ON sum_proveedores(tipo);

-- ── sum_producto_proveedor ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sum_producto_proveedor (
  id               TEXT PRIMARY KEY,           -- pp_xxxxxxxx
  producto_id      TEXT NOT NULL,
  proveedor_id     TEXT NOT NULL,
  codigo_proveedor TEXT,                        -- supplier's own SKU/part number
  precio           REAL,
  moneda           TEXT NOT NULL DEFAULT 'USD', -- USD|VES
  lead_time_dias   INTEGER,
  minimo_pedido    REAL,
  preferido        INTEGER NOT NULL DEFAULT 0,
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_pp_producto  ON sum_producto_proveedor(producto_id);
CREATE INDEX IF NOT EXISTS idx_sum_pp_proveedor ON sum_producto_proveedor(proveedor_id);

-- ── Seed: 3 proveedores (fixed ids, idempotent) ────────────────────────────────
-- created_ms = 1782518400000 matches existing seed convention (~2026-06-27).
INSERT OR IGNORE INTO sum_proveedores (id, nombre, tipo, activo, created_ms, updated_ms) VALUES
  ('prv_pahogar',   'PAHO/OPS',                   'proveedor',  1, 1782518400000, 1782518400000),
  ('prv_farmavzla', 'Farmacéutica Venezuela C.A.', 'fabricante', 1, 1782518400000, 1782518400000),
  ('prv_cruzroja',  'Cruz Roja Venezolana',        'donante',    1, 1782518400000, 1782518400000);

-- ── Seed: 4 product-supplier price links ──────────────────────────────────────
-- Points to products that exist in seed_suministros.sql.
INSERT OR IGNORE INTO sum_producto_proveedor
  (id, producto_id, proveedor_id, precio, moneda, preferido, created_ms, updated_ms) VALUES
  ('pp_para_farma', 'prod_para',  'prv_farmavzla', 0.12, 'USD', 1, 1782518400000, 1782518400000),
  ('pp_agua_paho',  'prod_agua1', 'prv_pahogar',   0.35, 'USD', 0, 1782518400000, 1782518400000),
  ('pp_suero_farm', 'prod_suero', 'prv_farmavzla', 0.45, 'USD', 0, 1782518400000, 1782518400000),
  ('pp_manta_cruz', 'prod_manta', 'prv_cruzroja',  3.50, 'USD', 0, 1782518400000, 1782518400000);
