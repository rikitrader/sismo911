-- SUMINISTROS — Envíos (two-step inter-location shipment registry).
-- despachar removes stock from origen; recibir adds it at destino.
-- Between the two steps stock is "in transit" at neither location.
-- Additive only; idempotent (CREATE IF NOT EXISTS, INSERT OR IGNORE).

-- Carrier / method catalogue.
CREATE TABLE IF NOT EXISTS sum_metodos_envio (
  id            TEXT PRIMARY KEY,                  -- sm_xxxxxxxx
  nombre        TEXT NOT NULL,
  transportista TEXT,
  modo          TEXT NOT NULL DEFAULT 'terrestre', -- terrestre|aereo|maritimo|fluvial|courier
  activo        INTEGER NOT NULL DEFAULT 1,
  created_ms    INTEGER NOT NULL
);

-- Shipment header.
CREATE TABLE IF NOT EXISTS sum_envios (
  id             TEXT PRIMARY KEY,                   -- env_xxxxxxxx
  codigo         TEXT NOT NULL UNIQUE,               -- ENV-XXXXXXXX (human tracking code)
  origen_id      TEXT NOT NULL,
  destino_id     TEXT NOT NULL,
  metodo_id      TEXT,                               -- nullable FK → sum_metodos_envio
  estado         TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|despachado|en_transito|recibido|cancelado
  num_referencia TEXT,
  transportista  TEXT,
  nota           TEXT,
  despachado_ms  INTEGER,
  recibido_ms    INTEGER,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_env_estado  ON sum_envios(estado);
CREATE INDEX IF NOT EXISTS idx_sum_env_origen  ON sum_envios(origen_id);
CREATE INDEX IF NOT EXISTS idx_sum_env_destino ON sum_envios(destino_id);

-- Physical containers attached to a shipment (boxes, pallets, etc.).
CREATE TABLE IF NOT EXISTS sum_envio_contenedores (
  id          TEXT PRIMARY KEY,               -- cont_xxxxxxxx
  envio_id    TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'caja',   -- caja|pallet|saco|nevera|bidon
  codigo      TEXT,
  descripcion TEXT,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_cont_envio ON sum_envio_contenedores(envio_id);

-- Line items inside a shipment (optionally assigned to a container).
CREATE TABLE IF NOT EXISTS sum_envio_lineas (
  id            TEXT PRIMARY KEY,    -- envl_xxxxxxxx
  envio_id      TEXT NOT NULL,
  contenedor_id TEXT,               -- nullable FK → sum_envio_contenedores
  item_id       TEXT NOT NULL,
  cantidad      REAL NOT NULL,
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_envl_envio ON sum_envio_lineas(envio_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- created_ms=1782518400000 ≈ 2026-06-27 (matches seed_suministros.sql convention).

INSERT OR IGNORE INTO sum_metodos_envio
  (id, nombre, transportista, modo, activo, created_ms) VALUES
  ('sm_terrestre', 'Carga terrestre', 'Flota SISMO911', 'terrestre', 1, 1782518400000),
  ('sm_aereo',     'Puente aéreo',    'PC Aérea',       'aereo',     1, 1782518400000);

INSERT OR IGNORE INTO sum_envios
  (id, codigo, origen_id, destino_id, metodo_id, estado, num_referencia, created_ms, updated_ms) VALUES
  ('env_demo01', 'ENV-DEMO0001', 'ubi_ccs', 'ubi_lgu', 'sm_terrestre', 'pendiente', 'GUIA-001', 1782518400000, 1782518400000);

INSERT OR IGNORE INTO sum_envio_contenedores
  (id, envio_id, tipo, codigo, created_ms) VALUES
  ('cont_demo01', 'env_demo01', 'pallet', 'PAL-001', 1782518400000);

INSERT OR IGNORE INTO sum_envio_lineas
  (id, envio_id, contenedor_id, item_id, cantidad, created_ms) VALUES
  ('envl_demo01', 'env_demo01', 'cont_demo01', 'item_agua1', 200, 1782518400000),
  ('envl_demo02', 'env_demo01', NULL,          'item_manta', 100, 1782518400000);
