-- FLOTA — Emergency-response Fleet & Dispatch (FleetOps adapted to disaster response).
-- Additive only. Rides the existing `sismo911` D1. Spanish domain naming to match
-- the app. Mounted under /api/flota/*. GET public; writes operator-gated.

-- Response units (vehicles): ambulances, rescue trucks, fire, cargo, moto, drones.
CREATE TABLE IF NOT EXISTS flota_unidades (
  id            TEXT PRIMARY KEY,           -- uni_xxxxxxxx
  tipo          TEXT NOT NULL DEFAULT 'rescate', -- ambulancia|rescate|bomberos|carga|moto|dron|otro
  nombre        TEXT NOT NULL,
  placa         TEXT,
  estado_op     TEXT NOT NULL DEFAULT 'disponible', -- disponible|en_mision|fuera_servicio|mantenimiento
  capacidad     INTEGER,
  organizacion  TEXT,
  estado_region TEXT,                       -- Venezuelan estado
  lat           REAL,
  lon           REAL,
  rumbo         REAL,
  ult_pos_ms    INTEGER,
  notas         TEXT,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_unidades_estado ON flota_unidades(estado_op);
CREATE INDEX IF NOT EXISTS idx_flota_unidades_tipo ON flota_unidades(tipo);

-- Responders / crew assigned to units.
CREATE TABLE IF NOT EXISTS flota_personal (
  id          TEXT PRIMARY KEY,             -- per_xxxxxxxx
  nombre      TEXT NOT NULL,
  rol         TEXT NOT NULL DEFAULT 'rescatista', -- paramedico|rescatista|conductor|coordinador|voluntario
  telefono    TEXT,
  email       TEXT,
  unidad_id   TEXT,                         -- currently-assigned unit (nullable)
  estado      TEXT NOT NULL DEFAULT 'activo', -- activo|inactivo|en_mision
  skills      TEXT,                         -- JSON array
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_personal_unidad ON flota_personal(unidad_id);

-- Fleets (groupings of units, e.g. by org or region).
CREATE TABLE IF NOT EXISTS flota_flotas (
  id            TEXT PRIMARY KEY,           -- flt_xxxxxxxx
  nombre        TEXT NOT NULL,
  organizacion  TEXT,
  estado_region TEXT,
  descripcion   TEXT,
  created_ms    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS flota_flota_unidades (
  flota_id   TEXT NOT NULL,
  unidad_id  TEXT NOT NULL,
  PRIMARY KEY (flota_id, unidad_id)
);

-- Dispatch missions (the "order" in FleetOps). Can reference a seismic event
-- (events.id) or a SOS/case. Full status lifecycle + waypoints + activity.
CREATE TABLE IF NOT EXISTS flota_misiones (
  id           TEXT PRIMARY KEY,            -- mis_xxxxxxxx
  codigo       TEXT NOT NULL UNIQUE,        -- MIS-XXXXXXXX (human tracking code)
  tipo         TEXT NOT NULL DEFAULT 'rescate', -- rescate|evacuacion|suministro|evaluacion|medico|traslado
  prioridad    INTEGER NOT NULL DEFAULT 3,  -- 1 (max) .. 5 (min)
  estado       TEXT NOT NULL DEFAULT 'creada', -- creada|despachada|en_ruta|en_sitio|completada|cancelada
  unidad_id    TEXT,
  personal_id  TEXT,
  evento_id    TEXT,                        -- FK events.id (nullable)
  caso_ref     TEXT,                        -- free ref to a SOS/missing-person/acopio item
  origen_lat   REAL, origen_lon REAL, origen_dir TEXT,
  destino_lat  REAL, destino_lon REAL, destino_dir TEXT,
  descripcion  TEXT,
  despachada_ms INTEGER,
  completada_ms INTEGER,
  meta         TEXT,                        -- JSON
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_misiones_estado ON flota_misiones(estado);
CREATE INDEX IF NOT EXISTS idx_flota_misiones_unidad ON flota_misiones(unidad_id);
CREATE INDEX IF NOT EXISTS idx_flota_misiones_evento ON flota_misiones(evento_id);

CREATE TABLE IF NOT EXISTS flota_mision_waypoints (
  id         TEXT PRIMARY KEY,              -- wpt_xxxxxxxx
  mision_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  lat        REAL, lon REAL, direccion TEXT,
  estado     TEXT NOT NULL DEFAULT 'pendiente', -- pendiente|llegada|completado
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_waypoints_mision ON flota_mision_waypoints(mision_id);

CREATE TABLE IF NOT EXISTS flota_mision_actividad (
  id         TEXT PRIMARY KEY,              -- act_xxxxxxxx
  mision_id  TEXT NOT NULL,
  estado     TEXT NOT NULL,
  nota       TEXT,
  lat        REAL, lon REAL,
  actor      TEXT,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_actividad_mision ON flota_mision_actividad(mision_id);

-- Append-only GPS track points (latest position also denormalized onto
-- flota_unidades for fast map reads). Powers the live tracking view.
CREATE TABLE IF NOT EXISTS flota_posiciones (
  id         TEXT PRIMARY KEY,              -- pos_xxxxxxxx
  unidad_id  TEXT NOT NULL,
  mision_id  TEXT,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  rumbo      REAL,
  velocidad  REAL,
  ts_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flota_posiciones_unidad ON flota_posiciones(unidad_id, ts_ms);
