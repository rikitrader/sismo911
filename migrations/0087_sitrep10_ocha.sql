-- 0087: OCHA Situation Report No. 10 (03 Jul 2026, 7:00 pm VET) — official figures.
-- Source: https://reliefweb.int/report/venezuela-bolivarian-republic/earthquakes-venezuela-situation-report-10-03-july-2026-time-0700-pm
-- Recorded under the tier-1 `reliefweb` source (registered in 0063). as_of is
-- 2026-07-03 19:00 VET = 23:00 UTC. Idempotent (INSERT OR IGNORE, stable ids).
INSERT OR IGNORE INTO casualty_reports
  (id, event_id, source_key, metric, value_min, value_max, as_of_ms, confidence, citation_url, note, method, ingested_ms)
VALUES
  ('sitrep10-reliefweb-dead-20260703', 've-eq-2026-06-24', 'reliefweb', 'dead', 2645, 2645,
    CAST(strftime('%s','2026-07-03 23:00:00') AS INTEGER)*1000, 0.85,
    'https://reliefweb.int/report/venezuela-bolivarian-republic/earthquakes-venezuela-situation-report-10-03-july-2026-time-0700-pm',
    'Balance oficial — Informe de Situación Nº 10 de OCHA (03 jul 2026, 7:00 pm).', 'manual',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('sitrep10-reliefweb-injured-20260703', 've-eq-2026-06-24', 'reliefweb', 'injured', 12666, 12666,
    CAST(strftime('%s','2026-07-03 23:00:00') AS INTEGER)*1000, 0.85,
    'https://reliefweb.int/report/venezuela-bolivarian-republic/earthquakes-venezuela-situation-report-10-03-july-2026-time-0700-pm',
    'Heridos — Informe de Situación Nº 10 de OCHA (03 jul 2026, 7:00 pm).', 'manual',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('sitrep10-reliefweb-rescued-20260703', 've-eq-2026-06-24', 'reliefweb', 'rescued', 6462, 6462,
    CAST(strftime('%s','2026-07-03 23:00:00') AS INTEGER)*1000, 0.85,
    'https://reliefweb.int/report/venezuela-bolivarian-republic/earthquakes-venezuela-situation-report-10-03-july-2026-time-0700-pm',
    'Personas rescatadas desde el inicio de la emergencia — SitRep Nº 10 OCHA.', 'manual',
    CAST(strftime('%s','now') AS INTEGER)*1000),

  ('sitrep10-reliefweb-displaced-20260703', 've-eq-2026-06-24', 'reliefweb', 'displaced', 15050, NULL,
    CAST(strftime('%s','2026-07-03 23:00:00') AS INTEGER)*1000, 0.80,
    'https://reliefweb.int/report/venezuela-bolivarian-republic/earthquakes-venezuela-situation-report-10-03-july-2026-time-0700-pm',
    'Personas que perdieron su hogar (~15.050) — SitRep Nº 10 OCHA; cifra aproximada de autoridades.', 'manual',
    CAST(strftime('%s','now') AS INTEGER)*1000);
