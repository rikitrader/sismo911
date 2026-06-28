-- SUMINISTROS — Inventory & supply-chain management for emergency relief.
-- A serverless re-code of OpenBoxes' core domain (Locations / Products /
-- InventoryItem / stock / Transactions / Requisitions) on Cloudflare + Hono + D1.
-- Additive only. Rides the existing `sismo911` D1. Spanish domain naming to match
-- the app. Mounted under /api/suministros/*; served at suministros.sismo911.com
-- (+ /suministros). GET public; writes operator-gated (ADMIN_WRITE_PREFIXES).

-- Ubicaciones: stock-holding sites — depósitos, refugios, almacenes, hospitales,
-- puntos de distribución, proveedores. (OpenBoxes: Location.)
CREATE TABLE IF NOT EXISTS sum_ubicaciones (
  id            TEXT PRIMARY KEY,              -- ubi_xxxxxxxx
  nombre        TEXT NOT NULL,
  tipo          TEXT NOT NULL DEFAULT 'deposito', -- deposito|refugio|almacen|hospital|punto_distribucion|proveedor
  codigo        TEXT,                          -- short human code
  estado_region TEXT,                          -- Venezuelan estado
  direccion     TEXT,
  lat           REAL,
  lon           REAL,
  responsable   TEXT,
  telefono      TEXT,
  activa        INTEGER NOT NULL DEFAULT 1,
  notas         TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_ubicaciones_tipo ON sum_ubicaciones(tipo);
CREATE INDEX IF NOT EXISTS idx_sum_ubicaciones_estado ON sum_ubicaciones(estado_region);

-- Categorías de producto (Agua, Alimentos, Medicina, Refugio, Higiene...).
-- (OpenBoxes: Category.)
CREATE TABLE IF NOT EXISTS sum_categorias (
  id          TEXT PRIMARY KEY,                -- cat_xxxxxxxx
  nombre      TEXT NOT NULL,
  color       TEXT,                            -- hex for UI chips
  descripcion TEXT,
  created_ms  INTEGER NOT NULL
);

-- Catálogo de productos — the SKU master. (OpenBoxes: Product.)
CREATE TABLE IF NOT EXISTS sum_productos (
  id            TEXT PRIMARY KEY,              -- prod_xxxxxxxx
  codigo        TEXT NOT NULL UNIQUE,          -- SKU (PRD-XXXXXX)
  nombre        TEXT NOT NULL,
  categoria_id  TEXT,
  unidad        TEXT NOT NULL DEFAULT 'unidad', -- unidad|caja|kg|litro|paquete|saco|blister
  perecedero    INTEGER NOT NULL DEFAULT 0,    -- 1 ⇒ track lot + expiry
  stock_min     REAL NOT NULL DEFAULT 0,       -- reorder threshold (global, across locations)
  descripcion   TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_productos_categoria ON sum_productos(categoria_id);

-- Inventory items = product + lot + expiry. (OpenBoxes: InventoryItem.)
-- A non-perishable product gets a single default item (lote NULL, caducidad NULL).
CREATE TABLE IF NOT EXISTS sum_items (
  id            TEXT PRIMARY KEY,              -- item_xxxxxxxx
  producto_id   TEXT NOT NULL,
  lote          TEXT,                          -- lot/batch number (NULL = default)
  caducidad_ms  INTEGER,                       -- expiry date epoch ms (NULL = none)
  created_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_items_producto ON sum_items(producto_id);
CREATE INDEX IF NOT EXISTS idx_sum_items_caducidad ON sum_items(caducidad_ms);

-- Stock on hand = running balance per (ubicacion, item). Denormalized ledger
-- total; every transaction line adjusts it in the same D1 batch.
-- (OpenBoxes: ProductAvailability / InventoryLevel quantityOnHand.)
CREATE TABLE IF NOT EXISTS sum_existencias (
  ubicacion_id  TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  cantidad      REAL NOT NULL DEFAULT 0,
  updated_ms    INTEGER NOT NULL,
  PRIMARY KEY (ubicacion_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_sum_existencias_item ON sum_existencias(item_id);

-- Transactions (stock movements). (OpenBoxes: Transaction + TransactionType.)
CREATE TABLE IF NOT EXISTS sum_transacciones (
  id                TEXT PRIMARY KEY,          -- tx_xxxxxxxx
  codigo            TEXT NOT NULL UNIQUE,      -- TX-XXXXXXXX (human tracking code)
  tipo              TEXT NOT NULL,             -- recepcion|despacho|traslado|ajuste|conteo
  ubicacion_id      TEXT,                      -- recepcion: destino · despacho/traslado: origen · ajuste/conteo: sitio
  ubicacion_dest_id TEXT,                      -- traslado: destino
  referencia        TEXT,                      -- PO#, donante, código de requisición, etc.
  requisicion_id    TEXT,                      -- link to fulfilled requisition (nullable)
  motivo            TEXT,                      -- reason (ajuste / conteo)
  actor             TEXT,                      -- operator who recorded it
  nota              TEXT,
  created_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_tx_tipo ON sum_transacciones(tipo);
CREATE INDEX IF NOT EXISTS idx_sum_tx_ubicacion ON sum_transacciones(ubicacion_id);
CREATE INDEX IF NOT EXISTS idx_sum_tx_created ON sum_transacciones(created_ms);

-- Transaction line items. `cantidad` is the absolute quantity moved; the stock
-- sign is derived from the transaction tipo when applied. (OpenBoxes: TransactionEntry.)
CREATE TABLE IF NOT EXISTS sum_transaccion_lineas (
  id             TEXT PRIMARY KEY,             -- txl_xxxxxxxx
  transaccion_id TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  cantidad       REAL NOT NULL,                -- signed delta actually applied to stock
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_txl_tx ON sum_transaccion_lineas(transaccion_id);
CREATE INDEX IF NOT EXISTS idx_sum_txl_item ON sum_transaccion_lineas(item_id);

-- Requisiciones: a requesting location asks for stock. (OpenBoxes: Requisition.)
CREATE TABLE IF NOT EXISTS sum_requisiciones (
  id            TEXT PRIMARY KEY,              -- req_xxxxxxxx
  codigo        TEXT NOT NULL UNIQUE,          -- REQ-XXXXXXXX
  ubicacion_id  TEXT NOT NULL,                 -- requesting location (destino)
  origen_id     TEXT,                          -- fulfilling location (set on approval)
  estado        TEXT NOT NULL DEFAULT 'borrador', -- borrador|enviada|aprobada|surtida|cancelada
  prioridad     INTEGER NOT NULL DEFAULT 3,    -- 1 (max) .. 5 (min)
  solicitante   TEXT,
  nota          TEXT,
  enviada_ms    INTEGER,
  aprobada_ms   INTEGER,
  surtida_ms    INTEGER,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_req_estado ON sum_requisiciones(estado);
CREATE INDEX IF NOT EXISTS idx_sum_req_ubicacion ON sum_requisiciones(ubicacion_id);

-- Requisition line items. (OpenBoxes: RequisitionItem.)
CREATE TABLE IF NOT EXISTS sum_requisicion_lineas (
  id             TEXT PRIMARY KEY,             -- rql_xxxxxxxx
  requisicion_id TEXT NOT NULL,
  producto_id    TEXT NOT NULL,
  cantidad_sol   REAL NOT NULL,                -- requested quantity
  cantidad_surt  REAL NOT NULL DEFAULT 0,      -- fulfilled quantity
  created_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sum_rql_req ON sum_requisicion_lineas(requisicion_id);
