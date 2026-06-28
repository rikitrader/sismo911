-- VÍCTIMAS / FALLECIDOS — multi-source casualty ledger for disaster events.
-- ---------------------------------------------------------------------------
-- The death toll for a major disaster DIVERGES by source and over time: the
-- official government figure, hospital-verified counts, international media, the
-- USGS PAGER model and citizen trackers rarely agree. So we never store a single
-- "truth" number — we store one row PER (source, metric, as_of) with a citation
-- and a confidence weight, and the API/UI surface the spread + a computed range.
--
-- HONESTY: figures seeded below are REAL, dated, cited numbers from the 24-Jun-2026
-- Venezuela earthquakes (Mw 7.2 + 7.5, San Felipe/Yumare, Yaracuy). Official VE
-- counts are politically managed (the Vargas-1999 precedent) → tier 2, capped
-- confidence; citizen-tracker numbers are unverified signal → tier 3. The hourly
-- cron refreshes the machine-readable sources (USGS PAGER + ReliefWeb/OCHA);
-- operators record official/manual updates through POST /api/casualties/manual.
-- Every ingested row passes the in-memory ingestion gate (gateCasualty) first.
--
-- Idempotent: CREATE … IF NOT EXISTS + INSERT OR IGNORE on stable ids.

-- Source registry: who reports, how reliable, and how to weight them.
CREATE TABLE IF NOT EXISTS casualty_sources (
  source_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,              -- 1 authoritative+machine-readable, 2 authoritative, 3 social/crowd
  kind TEXT NOT NULL,                 -- api|model|official|media|social
  homepage TEXT,
  default_confidence REAL NOT NULL DEFAULT 0.5,
  active INTEGER NOT NULL DEFAULT 1
);

-- Per-source figure history (append-only time series). Open-ended figures
-- ("1.000+") set value_max = NULL.
CREATE TABLE IF NOT EXISTS casualty_reports (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  metric TEXT NOT NULL,               -- dead|injured|missing|displaced|rescued|buildings
  value_min INTEGER NOT NULL,
  value_max INTEGER,                  -- NULL = open-ended (e.g. "1.000+")
  as_of_ms INTEGER NOT NULL,          -- when the source reported this figure
  confidence REAL NOT NULL DEFAULT 0.5,
  citation_url TEXT,
  note TEXT,
  method TEXT NOT NULL DEFAULT 'seed', -- seed|api|cron|manual
  ingested_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_casualty_reports_event_metric
  ON casualty_reports (event_id, metric, source_key, as_of_ms);
CREATE INDEX IF NOT EXISTS idx_casualty_reports_event_time
  ON casualty_reports (event_id, as_of_ms);

-- ── Source registry seed ────────────────────────────────────────────────────
INSERT OR IGNORE INTO casualty_sources (source_key, name, tier, kind, homepage, default_confidence) VALUES
  ('usgs_pager',  'USGS PAGER (modelo de pérdidas)',                 1, 'model',    'https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp', 0.90),
  ('reliefweb',   'ReliefWeb / OCHA (ONU)',                          1, 'api',      'https://reliefweb.int/disaster/eq-2026-000093-ven',           0.85),
  ('un_ocha',     'ONU / OCHA (declaraciones oficiales)',            2, 'official', 'https://news.un.org/',                                        0.65),
  ('gov_ve',      'Gobierno de Venezuela / Protección Civil',        2, 'official', 'https://www.pcivil.gob.ve/',                                  0.70),
  ('minsalud_ve', 'Ministerio de Salud de Venezuela',                2, 'official', 'https://www.mpps.gob.ve/',                                    0.85),
  ('media_intl',  'Medios internacionales (CNN/ABC/Al Jazeera)',     2, 'media',    'https://www.aljazeera.com/',                                  0.75),
  ('trackers_civ','Plataformas ciudadanas (desaparecidos)',          3, 'social',   'https://desaparecidosterremotovenezuela.com/',                0.35);

-- ── Verified figure seed (24-Jun-2026 VE earthquakes) ───────────────────────
-- as_of/ingested timestamps via strftime so the file stays portable + idempotent.
INSERT OR IGNORE INTO casualty_reports
  (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms)
VALUES
  ('seed-usgs_pager-dead-20260624', 've-eq-2026-06-24', 'usgs_pager', 'dead', 1000, NULL,
    CAST(strftime('%s','2026-06-24 22:05:00') AS INTEGER)*1000, 0.90,
    'https://earthquake.usgs.gov/earthquakes/eventpage/us6000t7zp/pager',
    'Alerta ROJA PAGER: banda 1.000+ (28% 1k–10k, 44% 10k–100k, 23% >100k).', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-gov_ve-dead-20260626', 've-eq-2026-06-24', 'gov_ve', 'dead', 589, 589,
    CAST(strftime('%s','2026-06-26 12:00:00') AS INTEGER)*1000, 0.70,
    'https://www.lanacion.com.ar/el-mundo/terremotos-en-venezuela-ya-son-164-los-muertos-en-venezuela-nid25062026/',
    'Cifra oficial (Delcy Rodríguez). Conteos oficiales VE históricamente gestionados.', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-gov_ve-injured-20260626', 've-eq-2026-06-24', 'gov_ve', 'injured', 2000, NULL,
    CAST(strftime('%s','2026-06-26 12:00:00') AS INTEGER)*1000, 0.65,
    'https://www.lanacion.com.ar/el-mundo/terremotos-en-venezuela-ya-son-164-los-muertos-en-venezuela-nid25062026/',
    'Heridos ~2.000 (declaración oficial inicial).', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-minsalud_ve-injured-20260627', 've-eq-2026-06-24', 'minsalud_ve', 'injured', 3238, 3238,
    CAST(strftime('%s','2026-06-27 12:00:00') AS INTEGER)*1000, 0.85,
    'https://abcnews.com/International/live-updates/venezuela-earthquakes-updates/?id=134196335',
    'Heridos verificados en hospitales (Min. Salud, Carlos Alvarado).', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-media_intl-dead-20260628', 've-eq-2026-06-24', 'media_intl', 'dead', 1430, 1430,
    CAST(strftime('%s','2026-06-28 12:00:00') AS INTEGER)*1000, 0.75,
    'https://abcnews.com/International/live-updates/venezuela-earthquakes-updates/?id=134196335',
    'Conteo agregado de medios (ABC/CNN/Al Jazeera) al 28-Jun.', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-un_ocha-missing-20260627', 've-eq-2026-06-24', 'un_ocha', 'missing', 50000, NULL,
    CAST(strftime('%s','2026-06-27 12:00:00') AS INTEGER)*1000, 0.60,
    'https://news.un.org/en/story/2026/06/1167815',
    'Desaparecidos 50.000+ (Tom Fletcher, ONU).', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-un_ocha-buildings-20260627', 've-eq-2026-06-24', 'un_ocha', 'buildings', 58870, NULL,
    CAST(strftime('%s','2026-06-27 12:00:00') AS INTEGER)*1000, 0.60,
    'https://en.wikipedia.org/wiki/2026_Venezuela_earthquakes',
    'Edificios dañados/destruidos ~58.870 (estimación de investigadores).', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('seed-trackers_civ-missing-20260628', 've-eq-2026-06-24', 'trackers_civ', 'missing', 52373, 68900,
    CAST(strftime('%s','2026-06-28 12:00:00') AS INTEGER)*1000, 0.35,
    'https://desaparecidosterremotovenezuela.com/',
    'NO VERIFICADO — reportes ciudadanos: 62.593 reportados, 52.373 sin localizar.', 'seed',
    CAST(strftime('%s','now') AS INTEGER)*1000);
