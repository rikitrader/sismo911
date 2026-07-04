-- 0088: SitRep #10 official toll should be the "best estimate", not the day-one
-- USGS PAGER modeled band (conf 0.90). The OCHA figures are official point
-- counts a week into the emergency; raise them to 0.92 so /api/casualties'
-- highest-confidence "best" reflects the current official toll. Idempotent.
UPDATE casualty_reports SET confidence = 0.92
 WHERE id IN ('sitrep10-reliefweb-dead-20260703', 'sitrep10-reliefweb-injured-20260703');
