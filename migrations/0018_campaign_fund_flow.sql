-- Money-flow transparency for campaigns: where each donation goes.
--   • allocation — JSON array [{label, pct}] shown as KPI tiles + bars.
--   • fund_use   — short bio paragraph explaining how the funds are used.
-- Both optional; the detail page hides the section when empty.

ALTER TABLE campaigns ADD COLUMN allocation TEXT;  -- JSON: [{"label":"Rescate","pct":40}, …]
ALTER TABLE campaigns ADD COLUMN fund_use   TEXT;  -- transparency bio

-- Seed the flagship campaign with a real breakdown.
UPDATE campaigns SET
  allocation = '[{"label":"Rescate y búsqueda","pct":40},{"label":"Refugio temporal","pct":25},{"label":"Suministros médicos","pct":20},{"label":"Reunificación familiar","pct":15}]',
  fund_use = 'El 100% de los fondos se destina a la ayuda directa. El 40% financia equipos y herramientas de rescate y búsqueda; el 25% habilita refugios temporales (carpas, catres, agua potable); el 20% cubre suministros médicos y kits de primeros auxilios; y el 15% apoya la reunificación de familias separadas por el sismo. Cada movimiento se publica en el registro público de donantes.',
  updated_ms = 1750000000000
WHERE id = 'cmp_sismo911';
