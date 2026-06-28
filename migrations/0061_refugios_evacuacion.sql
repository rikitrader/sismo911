-- REFUGIOS / EVACUACIÓN — shelter siting + evacuation logistics for La Guaira
-- (ex-Vargas). Candidate sites are SCORED (roads/services/bed/safety) and the
-- at-risk population (by parroquia) is ASSIGNED to the best available shelters.
-- Idempotent: CREATE … IF NOT EXISTS + INSERT OR IGNORE on stable ids.
--
-- HONESTY: seed lat/lon, areas and 0-5 service/road/safety scores are PLANNING
-- ESTIMATES for desk-exercise purposes, NOT a field survey. Verify on the ground
-- before committing people to any site. (notes carry 'verificar en campo'.)

CREATE TABLE IF NOT EXISTS refugios_sites (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,                 -- polideportivo|estadio|campo_golf|iglesia|club_puerto|escuela_nautica|deposito_contenedores|zona_baldia|gimnasio|escuela|hospital|aeropuerto
  municipio TEXT,
  parroquia TEXT,
  lat REAL,
  lon REAL,
  area_m2 INTEGER,                    -- total usable surface area
  techado_m2 INTEGER,                 -- covered/roofed area (permanent beds)
  bed_type TEXT DEFAULT 'temporal',  -- permanente|temporal|mixto
  capacity_estimate INTEGER,         -- manual override; else computed from area
  road_access INTEGER DEFAULT 3,     -- 0-5 access quality / # routes
  road_distance_m INTEGER,           -- meters to nearest carretera principal
  services_water INTEGER DEFAULT 2,  -- 0-5
  services_power INTEGER DEFAULT 2,
  services_sanitation INTEGER DEFAULT 2,
  services_kitchen INTEGER DEFAULT 1,
  elevation_m INTEGER,               -- altitude (mudslide/tsunami safety)
  flood_risk INTEGER DEFAULT 2,      -- 0-5 (higher = riskier: near quebrada/coast)
  coast_distance_m INTEGER,          -- tsunami buffer
  status TEXT NOT NULL DEFAULT 'candidato', -- candidato|activo|lleno|cerrado|reserva
  current_occupancy INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  score INTEGER,                     -- optional cached suitability (API recomputes live)
  moderation TEXT NOT NULL DEFAULT 'approved',
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refugios_sites_tipo ON refugios_sites(tipo);
CREATE INDEX IF NOT EXISTS idx_refugios_sites_parroquia ON refugios_sites(parroquia);
CREATE INDEX IF NOT EXISTS idx_refugios_sites_status ON refugios_sites(status);

CREATE TABLE IF NOT EXISTS refugios_zones (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,              -- parroquia
  municipio TEXT,
  lat REAL,
  lon REAL,
  population INTEGER NOT NULL,       -- at-risk / to-evacuate population (estimate)
  risk_level TEXT DEFAULT 'medio',  -- alto|medio|bajo (deslave/flood history)
  notes TEXT,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refugios_assignments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,             -- groups one assignment run
  zone_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  people INTEGER NOT NULL,
  distance_km REAL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refugios_assign_run ON refugios_assignments(run_id);

-- ── Seed: candidate sites (La Guaira coastal strip) ──────────────────────────
-- ms helper inlined: CAST(strftime('%s','now') AS INTEGER)*1000
INSERT OR IGNORE INTO refugios_sites
 (id,nombre,tipo,municipio,parroquia,lat,lon,area_m2,techado_m2,bed_type,road_access,road_distance_m,services_water,services_power,services_sanitation,services_kitchen,elevation_m,flood_risk,coast_distance_m,status,notes,created_ms,updated_ms)
VALUES
 ('ref_aeropuerto','Aeropuerto Internacional Simón Bolívar (Maiquetía)','aeropuerto','Vargas','Maiquetía',10.6010,-66.9910,120000,18000,'mixto',5,150,4,4,3,2,12,3,400,'reserva','Hub de puente aéreo y staging logístico. Plano, gran superficie. Baja elevación: limitar a staging, no pernocta masiva si hay alerta de tsunami. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_umc','Universidad Marítima del Caribe / Escuela Náutica','escuela_nautica','Vargas','Catia La Mar',10.5950,-67.0250,45000,12000,'permanente',4,250,3,3,3,3,25,2,600,'candidato','Aulas, comedores y dormitorios de cadetes; estructura sólida. Buen techado para camas permanentes. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_caraballeda_golf','Caraballeda Golf & Yacht Club','campo_golf','Vargas','Caraballeda',10.6120,-66.8520,250000,6000,'mixto',4,300,3,3,3,3,8,3,250,'candidato','Amplio campo abierto para carpas + club techado. Cercano al mar y a la quebrada San Julián (riesgo deslave histórico 1999). Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_azul','Club Puerto Azul','club_puerto','Vargas','Naiguatá',10.6150,-66.8350,180000,9000,'mixto',3,500,4,4,4,4,15,2,150,'candidato','Club privado con servicios robustos (agua, planta eléctrica, cocinas). Acceso por una sola vía. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_catia','Polideportivo de Catia La Mar','polideportivo','Vargas','Catia La Mar',10.5980,-67.0150,30000,9000,'permanente',4,200,3,3,3,2,20,2,500,'candidato','Gimnasio cubierto + canchas; buena para camas permanentes. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_gim_vargas','Gimnasio Cubierto José María Vargas','gimnasio','Vargas','La Guaira',10.6020,-66.9320,8000,6000,'permanente',4,150,3,3,3,2,30,2,450,'candidato','Estructura techada céntrica. Capacidad media. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_estadio_pariata','Estadio de Pariata','estadio','Vargas','Maiquetía',10.5990,-66.9700,28000,3000,'temporal',4,250,2,2,2,1,18,3,400,'candidato','Gradas + campo para carpas. Servicios limitados; reforzar WASH. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_usb_litoral','Universidad Simón Bolívar — Sede Litoral (Camurí Grande)','escuela','Vargas','Naiguatá',10.6110,-66.7900,60000,15000,'permanente',3,400,3,3,3,3,40,2,700,'candidato','Aulas y residencias; elevada y alejada del mar = más segura. Acceso por carretera de la costa. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_puerto_contenedores','Puerto de La Guaira — patios de contenedores (Bolipuertos)','deposito_contenedores','Vargas','La Guaira',10.6000,-66.9300,90000,4000,'temporal',5,100,4,4,2,1,5,4,80,'reserva','Gran explanada y contenedores reutilizables como módulos. MUY baja elevación y pegado al mar: NO usar bajo alerta de tsunami. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_catedral_guaira','Catedral San Pedro Apóstol (La Guaira)','iglesia','Vargas','La Guaira',10.6015,-66.9335,2500,1800,'permanente',3,120,2,2,2,1,28,2,420,'candidato','Iglesia céntrica; capacidad pequeña, útil como punto de reunión. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_iglesia_macuto','Iglesia San Bartolomé de Macuto','iglesia','Vargas','Macuto',10.6080,-66.8900,2000,1500,'permanente',3,150,2,2,2,1,22,3,180,'candidato','Punto de reunión barrial; cercana a la costa. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_zona_soublette','Zona baldía Av. Soublette (terrenos planos junto a la autopista)','zona_baldia','Vargas','Carlos Soublette',10.5970,-66.9900,70000,0,'temporal',5,50,1,1,1,0,35,2,600,'candidato','Explanada estable junto a vía rápida = staging/carpas rápido. Sin servicios: montar WASH y agua. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_escuela_carayaca','Escuela Técnica de Carayaca','escuela','Vargas','Carayaca',10.5650,-67.1300,18000,5000,'permanente',2,800,3,2,3,2,180,1,4000,'candidato','En la montaña, lejos del mar = baja exposición a tsunami/deslave costero. Acceso por carretera secundaria. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_naiguata','Polideportivo de Naiguatá','polideportivo','Vargas','Naiguatá',10.6180,-66.7400,22000,7000,'permanente',3,350,3,2,3,2,16,3,200,'candidato','Cubierto + canchas; al este, cercano a quebradas. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_club_camuri','Complejo recreacional Camurí Chico','club_puerto','Vargas','Caraballeda',10.6100,-66.8650,40000,3000,'mixto',3,400,3,3,2,2,7,4,90,'candidato','Balneario; baja elevación, alta exposición costera. Solo si no hay alerta marina. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_escuela_junko','Escuela Bolivariana El Junko','escuela','Vargas','El Junko',10.5350,-67.0700,9000,3000,'permanente',2,600,3,2,2,2,1500,1,9000,'candidato','Zona alta de montaña (~1.500 m): la más segura ante tsunami/deslave costero, pero acceso lento. Reserva estratégica. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_liceo_caruao','Liceo de Caruao (Los Caracas)','escuela','Vargas','Caruao',10.6250,-66.5500,12000,4000,'permanente',2,500,2,2,2,2,30,2,500,'candidato','Extremo este del litoral; cubre a Caruao/Los Caracas, lejos del resto. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
 ('ref_poli_raulleoni','Polideportivo Raúl Leoni','polideportivo','Vargas','Raúl Leoni',10.5930,-67.0050,15000,5000,'permanente',4,200,3,3,3,2,24,2,520,'candidato','Cubierto, buen acceso; sirve a Raúl Leoni y Catia La Mar este. Verificar en campo.',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000);

-- ── Seed: at-risk population zones (parroquias of La Guaira) ──────────────────
-- Population figures are rough planning estimates (state total ≈ 340-360k).
INSERT OR IGNORE INTO refugios_zones (id,nombre,municipio,lat,lon,population,risk_level,notes,created_ms) VALUES
 ('zone_catia','Catia La Mar','Vargas',10.5980,-67.0200,110000,'medio','Parroquia más poblada; sector oeste del litoral.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_soublette','Carlos Soublette','Vargas',10.5990,-66.9850,45000,'alto','Densamente poblada; afectada en el deslave de 1999.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_maiquetia','Maiquetía','Vargas',10.5990,-66.9700,40000,'alto','Casco urbano junto al aeropuerto; quebradas activas.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_caraballeda','Caraballeda','Vargas',10.6120,-66.8520,30000,'alto','Epicentro de la tragedia de Vargas 1999 (quebrada San Julián).',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_carayaca','Carayaca','Vargas',10.5650,-67.1300,30000,'medio','Parroquia de montaña al oeste, dispersa.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_naiguata','Naiguatá','Vargas',10.6180,-66.7400,25000,'alto','Litoral este; quebradas y exposición costera.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_laguaira','La Guaira','Vargas',10.6020,-66.9320,25000,'medio','Capital del estado; casco histórico y puerto.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_macuto','Macuto','Vargas',10.6080,-66.8900,20000,'alto','Balneario; severamente afectado en 1999.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_raulleoni','Raúl Leoni','Vargas',10.5930,-67.0050,12000,'medio','Sector residencial al oeste.',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_caruao','Caruao','Vargas',10.6250,-66.5500,8000,'medio','Extremo este; comunidades costeras aisladas (Los Caracas).',CAST(strftime('%s','now') AS INTEGER)*1000),
 ('zone_eljunko','El Junko','Vargas',10.5350,-67.0700,5000,'bajo','Zona alta de montaña; baja exposición costera.',CAST(strftime('%s','now') AS INTEGER)*1000);

-- ── RBAC: refugios capability (mirror of the regenerated 0047 rows) ───────────
-- 0047 is already applied on the live DB and won't re-run, so the new refugios
-- permission, grants and feature flag are (idempotently) inserted here too. On a
-- fresh DB 0047 inserts them first and these are no-ops. (canonical source:
-- scripts/rbac-catalog.mjs → 0047_rbac_seed.sql.)
INSERT OR IGNORE INTO rbac_permissions (key, resource, action, label, category) VALUES
 ('refugios:read','refugios','read','Read Refugios','Operations'),
 ('refugios:manage','refugios','manage','Manage Refugios','Operations');
INSERT OR IGNORE INTO role_permissions (role_id, perm_key, effect) VALUES
 ('role_super_admin','refugios:read','allow'),
 ('role_super_admin','refugios:manage','allow'),
 ('role_emergency_manager','refugios:read','allow'),
 ('role_emergency_manager','refugios:manage','allow'),
 ('role_read_only','refugios:read','allow');
INSERT OR IGNORE INTO feature_flags (org_id, module_key, enabled, updated_ms) VALUES
 ('org_sismo911','refugios',1,0);
