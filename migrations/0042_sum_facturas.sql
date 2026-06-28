-- SUMINISTROS — Cuentas GL / presupuesto + Facturas de compra + Líneas de factura.
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).
-- Tables: sum_cuentas, sum_facturas, sum_factura_lineas.

-- GL / budget accounts (plan de cuentas simplificado).
CREATE TABLE IF NOT EXISTS sum_cuentas (
  id          TEXT PRIMARY KEY,                 -- gl_xxxxxxxx
  codigo      TEXT NOT NULL,                    -- PRESUP-EMERG, GASTO-MEDIC, etc.
  nombre      TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'gasto',    -- gasto|activo|pasivo|ingreso|presupuesto
  descripcion TEXT,
  activa      INTEGER NOT NULL DEFAULT 1,
  created_ms  INTEGER NOT NULL
);

-- Invoices / purchase orders.
CREATE TABLE IF NOT EXISTS sum_facturas (
  id             TEXT PRIMARY KEY,              -- fac_xxxxxxxx
  codigo         TEXT NOT NULL UNIQUE,          -- FAC-XXXXXXXX (human tracking code)
  proveedor_id   TEXT NOT NULL,
  orden_id       TEXT,                          -- optional ref to sum_ordenes (plain TEXT, no FK)
  cuenta_id      TEXT,                          -- optional GL / budget account
  estado         TEXT NOT NULL DEFAULT 'borrador', -- borrador|emitida|pagada|anulada
  moneda         TEXT NOT NULL DEFAULT 'USD',
  monto_total    REAL NOT NULL DEFAULT 0,
  fecha_ms       INTEGER NOT NULL,
  vencimiento_ms INTEGER,
  referencia     TEXT,
  nota           TEXT,
  pagada_ms      INTEGER,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_fac_estado     ON sum_facturas(estado);
CREATE INDEX IF NOT EXISTS idx_sum_fac_proveedor  ON sum_facturas(proveedor_id);

-- Invoice line items.
CREATE TABLE IF NOT EXISTS sum_factura_lineas (
  id          TEXT PRIMARY KEY,                 -- facl_xxxxxxxx
  factura_id  TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  producto_id TEXT,                             -- optional ref to sum_productos
  cantidad    REAL NOT NULL DEFAULT 1,
  precio_unit REAL NOT NULL DEFAULT 0,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_facl_factura ON sum_factura_lineas(factura_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- created_ms=1782518400000 ≈ 2026-06-27 (matches existing seed convention).

INSERT OR IGNORE INTO sum_cuentas
  (id, codigo, nombre, tipo, activa, created_ms) VALUES
  ('gl_presup',  'PRESUP-EMERG',  'Presupuesto Emergencia Sísmica', 'presupuesto', 1, 1782518400000),
  ('gl_medic',   'GASTO-MEDIC',   'Gasto Medicina',                 'gasto',       1, 1782518400000),
  ('gl_logist',  'GASTO-LOGIST',  'Gasto Logística',                'gasto',       1, 1782518400000),
  ('gl_invent',  'ACTIVO-INVENT', 'Inventario',                     'activo',      1, 1782518400000);

INSERT OR IGNORE INTO sum_facturas
  (id, codigo, proveedor_id, orden_id, cuenta_id, estado, moneda, monto_total,
   fecha_ms, created_ms, updated_ms) VALUES
  ('fac_para01', 'FAC-PARA0001', 'prv_farmavzla', 'oc_para01', 'gl_medic',
   'emitida', 'USD', 600, 1782518400000, 1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_factura_lineas
  (id, factura_id, descripcion, producto_id, cantidad, precio_unit, created_ms) VALUES
  ('facl_para01', 'fac_para01', 'Paracetamol 500mg', 'prod_para', 5000, 0.12, 1782518400000);
