-- SUMINISTROS — Picklists (hojas de picking físico para surtir ítems de una ubicación).
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).
-- Tables: sum_picklists, sum_picklist_lineas.

-- Picklist header.
CREATE TABLE IF NOT EXISTS sum_picklists (
  id              TEXT PRIMARY KEY,              -- pck_xxxxxxxx
  codigo          TEXT NOT NULL UNIQUE,          -- PICK-XXXXXXXX (código de seguimiento)
  ubicacion_id    TEXT NOT NULL,                 -- ubicación de origen (donde se recogen los ítems)
  requisicion_id  TEXT,                          -- requisición asociada (nullable)
  referencia      TEXT,
  estado          TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|en_proceso|completada|cancelada
  asignado_a      TEXT,                          -- operador responsable del picking
  nota            TEXT,
  completada_ms   INTEGER,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_pck_estado    ON sum_picklists(estado);
CREATE INDEX IF NOT EXISTS idx_sum_pck_ubicacion ON sum_picklists(ubicacion_id);

-- Picklist line items — one row per ítem a recoger.
CREATE TABLE IF NOT EXISTS sum_picklist_lineas (
  id            TEXT PRIMARY KEY,               -- pkl_xxxxxxxx
  picklist_id   TEXT NOT NULL,
  item_id       TEXT NOT NULL,                  -- lote específico a recoger
  cantidad_sol  REAL NOT NULL,                  -- cantidad solicitada
  cantidad_pick REAL NOT NULL DEFAULT 0,        -- cantidad realmente recogida
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_pkl_picklist ON sum_picklist_lineas(picklist_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- 1 picklist demo en Depósito Central Caracas (ubi_ccs), estado 'pendiente'.
-- created_ms=1782518400000 ≈ 2026-06-27 (convención seed_suministros.sql).
-- Ítems: item_agua1 (800 u. en ubi_ccs) y item_manta (500 u. en ubi_ccs).

INSERT OR IGNORE INTO sum_picklists
  (id, codigo, ubicacion_id, requisicion_id, referencia, estado, asignado_a, nota, completada_ms, created_ms, updated_ms) VALUES
  ('pck_demo01', 'PICK-DEMO0001', 'ubi_ccs', NULL, NULL, 'pendiente', 'Almacenista 1', NULL, NULL, 1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_picklist_lineas
  (id, picklist_id, item_id, cantidad_sol, cantidad_pick, created_ms) VALUES
  ('pkl_demo01', 'pck_demo01', 'item_agua1', 100, 0, 1782518400000),
  ('pkl_demo02', 'pck_demo01', 'item_manta',  50, 0, 1782518400000);
