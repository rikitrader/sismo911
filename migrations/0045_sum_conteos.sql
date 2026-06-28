-- SUMINISTROS — Conteos cíclicos (cycle counts: snapshot → conteo físico → conciliación AJUSTE).
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).
-- Tables: sum_conteos, sum_conteo_lineas.

-- Conteo header.
CREATE TABLE IF NOT EXISTS sum_conteos (
  id             TEXT PRIMARY KEY,                   -- cnt_xxxxxxxx
  codigo         TEXT NOT NULL UNIQUE,               -- CNT-XXXXXXXX (código de seguimiento)
  ubicacion_id   TEXT NOT NULL,                      -- ubicación donde se realiza el conteo
  estado         TEXT NOT NULL DEFAULT 'programado', -- programado|en_proceso|conciliado|cancelado
  programado_ms  INTEGER,                            -- fecha/hora programada para el conteo
  asignado_a     TEXT,                               -- inventarista responsable
  nota           TEXT,
  conciliado_ms  INTEGER,                            -- fecha/hora de conciliación
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_cnt_estado    ON sum_conteos(estado);
CREATE INDEX IF NOT EXISTS idx_sum_cnt_ubicacion ON sum_conteos(ubicacion_id);

-- Líneas del conteo — una fila por ítem a contar.
CREATE TABLE IF NOT EXISTS sum_conteo_lineas (
  id               TEXT PRIMARY KEY,   -- cnl_xxxxxxxx
  conteo_id        TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  cantidad_sistema REAL NOT NULL,      -- existencia en sistema al momento del snapshot
  cantidad_contada REAL,               -- cantidad físicamente contada (null hasta contar)
  created_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_cnl_conteo ON sum_conteo_lineas(conteo_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- 1 conteo demo en Depósito Central Caracas (ubi_ccs), estado 'programado'.
-- created_ms=1782518400000 ≈ 2026-06-27 (convención seed_suministros.sql).
-- Ítems: item_agua1 (800 u.) y item_para_b (600 u.) — match seed_suministros existencias.

INSERT OR IGNORE INTO sum_conteos
  (id, codigo, ubicacion_id, estado, programado_ms, asignado_a, nota, conciliado_ms, created_ms, updated_ms) VALUES
  ('cnt_demo01', 'CNT-DEMO0001', 'ubi_ccs', 'programado', 1782518400000, 'Inventarista', NULL, NULL, 1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_conteo_lineas
  (id, conteo_id, item_id, cantidad_sistema, cantidad_contada, created_ms) VALUES
  ('cnl_demo01', 'cnt_demo01', 'item_agua1',  800, NULL, 1782518400000),
  ('cnl_demo02', 'cnt_demo01', 'item_para_b', 600, NULL, 1782518400000);
