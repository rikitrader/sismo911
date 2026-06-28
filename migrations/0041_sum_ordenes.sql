-- SUMINISTROS — Órdenes de Compra (PO registry + partial/full receipt tracking).
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).
-- Tables: sum_ordenes, sum_orden_lineas.

-- Purchase order header.
CREATE TABLE IF NOT EXISTS sum_ordenes (
  id                TEXT PRIMARY KEY,            -- oc_xxxxxxxx
  codigo            TEXT NOT NULL UNIQUE,         -- OC-XXXXXXXX (human tracking code)
  proveedor_id      TEXT NOT NULL,
  ubicacion_id      TEXT NOT NULL,               -- destino: receiving location
  estado            TEXT NOT NULL DEFAULT 'borrador', -- borrador|aprobada|recibida_parcial|recibida|cancelada
  moneda            TEXT NOT NULL DEFAULT 'USD',
  referencia        TEXT,
  solicitante       TEXT,
  fecha_esperada_ms INTEGER,
  nota              TEXT,
  aprobada_ms       INTEGER,
  recibida_ms       INTEGER,
  created_ms        INTEGER NOT NULL,
  updated_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_ord_estado    ON sum_ordenes(estado);
CREATE INDEX IF NOT EXISTS idx_sum_ord_proveedor ON sum_ordenes(proveedor_id);

-- Line items — one row per product within the PO.
CREATE TABLE IF NOT EXISTS sum_orden_lineas (
  id            TEXT PRIMARY KEY,              -- ocl_xxxxxxxx
  orden_id      TEXT NOT NULL,
  producto_id   TEXT NOT NULL,
  cantidad_ped  REAL NOT NULL,                 -- quantity ordered
  cantidad_rec  REAL NOT NULL DEFAULT 0,       -- quantity received so far
  precio_unit   REAL,                          -- unit price in orden.moneda
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_ocl_orden ON sum_orden_lineas(orden_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- 2 órdenes destined to ubi_ccs (Depósito Central Caracas).
-- created_ms=1782518400000 ≈ 2026-06-27 (matches seed_suministros.sql convention).

INSERT OR IGNORE INTO sum_ordenes
  (id, codigo, proveedor_id, ubicacion_id, estado, moneda, aprobada_ms, created_ms, updated_ms) VALUES
  ('oc_para01', 'OC-PARA0001', 'prv_farmavzla', 'ubi_ccs', 'aprobada', 'USD', 1782518400000, 1782518400000, 1782518400000),
  ('oc_agua01', 'OC-AGUA0001', 'prv_pahogar',   'ubi_ccs', 'borrador', 'USD', NULL,           1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_orden_lineas
  (id, orden_id, producto_id, cantidad_ped, precio_unit, created_ms) VALUES
  ('ocl_para01', 'oc_para01', 'prod_para',  5000, 0.12, 1782518400000),
  ('ocl_agua01', 'oc_agua01', 'prod_agua1', 2000, 0.35, 1782518400000);
