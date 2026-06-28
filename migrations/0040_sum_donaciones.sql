-- SUMINISTROS — Donaciones (donation registry + line items).
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).
-- Tables: sum_donaciones, sum_donacion_lineas.

-- Donation registrations — a single donation pledge from any donor type.
CREATE TABLE IF NOT EXISTS sum_donaciones (
  id               TEXT PRIMARY KEY,            -- don_xxxxxxxx
  codigo           TEXT NOT NULL UNIQUE,         -- DON-XXXXXXXX (human tracking code)
  donante          TEXT NOT NULL,               -- donor name / organisation
  tipo_donante     TEXT NOT NULL DEFAULT 'individual', -- individual|empresa|ong|gobierno|internacional
  ubicacion_id     TEXT NOT NULL,               -- destino: receiving location
  referencia       TEXT,                         -- donor reference, guide number, etc.
  estado           TEXT NOT NULL DEFAULT 'registrada', -- registrada|recibida|cancelada
  valor_estimado   REAL,                         -- estimated total value
  moneda           TEXT NOT NULL DEFAULT 'USD',
  nota             TEXT,
  actor            TEXT,                         -- operator who registered it
  recibida_ms      INTEGER,                      -- timestamp when received into stock
  created_ms       INTEGER NOT NULL,
  updated_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_don_estado    ON sum_donaciones(estado);
CREATE INDEX IF NOT EXISTS idx_sum_don_ubicacion ON sum_donaciones(ubicacion_id);

-- Line items — one row per product/lot within a donation.
CREATE TABLE IF NOT EXISTS sum_donacion_lineas (
  id             TEXT PRIMARY KEY,              -- dol_xxxxxxxx
  donacion_id    TEXT NOT NULL,
  producto_id    TEXT NOT NULL,
  lote           TEXT,
  caducidad_ms   INTEGER,
  cantidad       REAL NOT NULL,
  valor_unitario REAL,
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_dol_donacion ON sum_donacion_lineas(donacion_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- 2 pending donations (estado=registrada) destined to ubi_ccs (Depósito Central Caracas).
-- created_ms=1782518400000 ≈ 2026-06-27 (matches seed_suministros.sql convention).

INSERT OR IGNORE INTO sum_donaciones
  (id, codigo, donante, tipo_donante, ubicacion_id, estado, moneda, created_ms, updated_ms) VALUES
  ('don_cruzroja', 'DON-CRUZROJA', 'Cruz Roja Venezolana', 'ong',           'ubi_ccs', 'registrada', 'USD', 1782518400000, 1782518400000),
  ('don_unicef',   'DON-UNICEF01', 'UNICEF',               'internacional', 'ubi_ccs', 'registrada', 'USD', 1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_donacion_lineas
  (id, donacion_id, producto_id, cantidad, created_ms) VALUES
  ('dol_cruzroja1', 'don_cruzroja', 'prod_manta', 200, 1782518400000),
  ('dol_cruzroja2', 'don_cruzroja', 'prod_agua1', 500, 1782518400000),
  ('dol_unicef1',   'don_unicef',   'prod_kit',   300, 1782518400000);
