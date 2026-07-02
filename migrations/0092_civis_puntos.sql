-- CIVIS "puntos" — aid / collection / help points published at
-- civisvenezuela.com/api/puntos (acopio, refugio, agua, médico, …). A public map
-- of where to GET and GIVE help after the quake. Distinct from refugios_sites
-- (our own shelter-siting engine) and acopio_status (operator status overlay):
-- this is the crowd/agency-sourced points layer, ~1,957 rows, paginated by offset.
-- Idempotent UPSERT on the CIVIS id (dedupe by construction).

CREATE TABLE IF NOT EXISTS civis_puntos (
  id             TEXT PRIMARY KEY,          -- CIVIS uuid
  nombre         TEXT NOT NULL DEFAULT '',
  tipo           TEXT,                       -- acopio | refugio | agua | medico | …
  lat            REAL,
  lng            REAL,
  direccion      TEXT,
  estado         TEXT,                       -- abierto | cerrado | …
  detalle        TEXT,
  servicios      TEXT,                       -- JSON array
  necesidades    TEXT,                       -- JSON array
  pais           TEXT,
  confirmaciones INTEGER NOT NULL DEFAULT 0,
  total_personas INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'civis',
  actualizado    TEXT,                       -- source actualizadoEn
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_civis_puntos_tipo   ON civis_puntos(tipo);
CREATE INDEX IF NOT EXISTS idx_civis_puntos_estado ON civis_puntos(estado);
CREATE INDEX IF NOT EXISTS idx_civis_puntos_updated ON civis_puntos(updated_ms DESC);
