-- Casualty ledger — correct the `buildings` figure provenance + add Microsoft.
--
-- The `buildings` = 58.870 figure was seeded under `un_ocha` citing Wikipedia,
-- but the number ORIGINATES from NASA's experimental Sentinel-1 damage-proxy
-- assessment (Corey Scher & Jamon Van Den Hoek, Oregon State University;
-- coherence/backscatter change detection vs. 65 prior-year reference images;
-- preliminary, ~75% land coverage, NOT field-validated). This migration:
--   1. Registers NASA + Microsoft AI for Good as casualty sources.
--   2. Re-points the existing buildings row to NASA with the live map citation.
--   3. Adds Microsoft's independent Catia La Mar city-level assessment.
-- Idempotent: INSERT OR IGNORE on fixed keys/ids; UPDATE keyed by row id.

-- 1. Sources ------------------------------------------------------------------
INSERT OR IGNORE INTO casualty_sources (source_key, name, tier, kind, default_confidence, active) VALUES
  ('nasa_dpm',     'NASA — Sentinel-1 mapa de daños (Oregon State)', 2, 'model', 0.85, 1),
  ('msft_ai4good', 'Microsoft AI for Good Lab',                      2, 'model', 0.80, 1);

-- 2. Re-attribute the buildings figure to NASA (live damage-map citation) ------
UPDATE casualty_reports
   SET source_key   = 'nasa_dpm',
       confidence    = 0.85,
       citation_url = 'https://www.arcgis.com/home/item.html?id=0c3d77dd5aae46e4829d9a282477615c',
       note         = 'Estructuras probablemente dañadas/destruidas ~58.870 (NASA/Oregon State, Sentinel-1, detección de cambio de coherencia; preliminar, ~75% de cobertura, no validado en campo).',
       as_of_ms     = 1782820800000
 WHERE id = 'seed-un_ocha-buildings-20260627';

-- 3. Microsoft AI for Good — Catia La Mar (independent, city-level) ------------
INSERT OR IGNORE INTO casualty_reports
  (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms) VALUES
  ('seed-msft-buildings-catialamar', 've-eq-2026-06-24', 'msft_ai4good', 'buildings', 9000, 10000, 1782820800000, 0.80,
   'https://www.arcgis.com/home/item.html?id=598f2c29404b445787db112a64160040',
   'Catia La Mar: ~1/3 de ~30.000 edificaciones dañadas (modelo de IA sobre imágenes satelitales; evaluación a nivel ciudad).',
   'manual', 1782820800000);
