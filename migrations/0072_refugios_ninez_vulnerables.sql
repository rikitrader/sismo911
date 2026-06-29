-- REFUGIOS · NIÑEZ Y POBLACIONES VULNERABLES — shelter-side classification,
-- aggregated population counts, and humanitarian needs tracking.
--
-- Serves two community proposals:
--   • Módulo 11 — Protección de Niños y Adolescentes (child-care capability of a
--     shelter, approximate # of minors attended, pediatric needs board).
--   • Giovanni #8 — clasificación de refugios por población vulnerable
--     (discapacidad, movilidad reducida, adultos mayores, embarazadas,
--     familias con niños, crónicos, mascotas).
-- Both are the SAME shelter-tagging schema, so they share these tables.
--
-- PRIVACY / HONESTY (HARD): these tables store ONLY aggregated, shelter-level
-- data — NEVER an individually-identifiable minor (no name, cédula, photo or
-- street address lives here; individual minor cases stay in persons/personas,
-- already governed by src/lib/minor-protect.ts). Every row carries `official`
-- (1 = authorized by the competent authority) + `source`. PUBLIC surfaces MUST
-- render only official=1 rows; planning estimates (official=0) are operator-only.
-- Idempotent: CREATE … IF NOT EXISTS + INSERT OR IGNORE on stable ids.

-- ── Capability matrix: what populations a shelter can care for ────────────────
-- One row per (site, capability). value: 0/1 boolean or a small count where it
-- makes sense (e.g. # of espacios de lactancia). capability_key ∈
--   child age-care tiers: recien_nacido | lactante | nino_pequeno | escolar | adolescente
--   child special:        discapacidad_infantil | cronico_infantil | medico_especializado
--                         | espacio_lactancia | personal_infantil
--   vulnerable (Giovanni #8): discapacidad | movilidad_reducida | adulto_mayor
--                         | embarazada | familia_ninos | cronico | mascotas
CREATE TABLE IF NOT EXISTS refugios_site_capabilities (
  site_id TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 1,   -- 0/1 boolean, or a small count
  notes TEXT,
  official INTEGER NOT NULL DEFAULT 0, -- 1 = authorized/official; 0 = planning estimate
  source TEXT,                         -- who reported it (autoridad, ONG, estimación…)
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (site_id, capability_key)
);
CREATE INDEX IF NOT EXISTS idx_refugios_cap_key ON refugios_site_capabilities(capability_key);

-- ── Aggregated population at a shelter (NO individual records) ─────────────────
-- category_key ∈ menores_0_5 | menores_6_15 | menores_16_17 | recien_nacidos
--               | lactantes | embarazadas | adultos_mayores | discapacidad | total
CREATE TABLE IF NOT EXISTS refugios_site_population (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  category_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  as_of_ms INTEGER NOT NULL,
  official INTEGER NOT NULL DEFAULT 0,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_refugios_pop_site ON refugios_site_population(site_id);
CREATE INDEX IF NOT EXISTS idx_refugios_pop_cat ON refugios_site_population(category_key);

-- ── Humanitarian needs board per shelter ──────────────────────────────────────
-- need_key ∈ agua | formula_lactante | panales | ropa | mantas
--          | medicamento_pediatrico | atencion_medica | atencion_psicologica
--          | vacunas | kit_higiene | leche | alimento_especial | alimento_infantil
-- status ∈ requerido | parcial | cubierto
CREATE TABLE IF NOT EXISTS refugios_site_needs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  need_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requerido',
  qty_required INTEGER,
  qty_received INTEGER,
  unit TEXT,
  as_of_ms INTEGER NOT NULL,
  official INTEGER NOT NULL DEFAULT 0,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_refugios_needs_site ON refugios_site_needs(site_id);
CREATE INDEX IF NOT EXISTS idx_refugios_needs_status ON refugios_site_needs(status);

-- ── Seed: PLANNING ESTIMATES ONLY (official=0) so the operator UI is not empty.
-- These are NOT shown on public surfaces (which filter official=1). They are
-- desk-exercise tags for La Guaira candidate sites, NOT a field survey.
INSERT OR IGNORE INTO refugios_site_capabilities (site_id, capability_key, value, notes, official, source, updated_ms) VALUES
 -- UMC / Escuela Náutica: aulas + comedores → buena para niñez escolar y familias
 ('ref_umc','escolar',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_umc','nino_pequeno',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_umc','familia_ninos',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_umc','adolescente',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 -- Club Puerto Azul: servicios robustos → lactantes, embarazadas, espacio lactancia
 ('ref_puerto_azul','lactante',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_azul','recien_nacido',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_azul','espacio_lactancia',2,'Estimación: ~2 espacios habilitables. Verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_azul','embarazada',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_azul','familia_ninos',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 -- Polideportivo Catia La Mar: cubierto, accesible → discapacidad, movilidad
 ('ref_poli_catia','discapacidad',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_catia','movilidad_reducida',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_catia','escolar',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_catia','adulto_mayor',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 -- USB Litoral: elevada/segura → personal infantil, crónicos, médico
 ('ref_usb_litoral','personal_infantil',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_usb_litoral','cronico_infantil',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_usb_litoral','medico_especializado',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_usb_litoral','escolar',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 -- Caraballeda Golf: amplio → familias, mascotas
 ('ref_caraballeda_golf','familia_ninos',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_caraballeda_golf','mascotas',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_caraballeda_golf','nino_pequeno',1,'Estimación de planificación; verificar en campo.',0,'estimacion_planificacion',CAST(strftime('%s','now') AS INTEGER)*1000);
