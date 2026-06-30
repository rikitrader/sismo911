-- SUMINISTROS — manual unit-cost override on the product master.
-- Cost precedence for valuation becomes: manual override (costo_unit > 0)
--   → preferred-supplier price → MIN(supplier price) → 0.
-- D1/SQLite has no ADD COLUMN IF NOT EXISTS; this runs once (migration tracker
-- prevents re-runs). If applied by hand, guard against the duplicate-column error.
ALTER TABLE sum_productos ADD COLUMN costo_unit REAL NOT NULL DEFAULT 0;
ALTER TABLE sum_productos ADD COLUMN moneda_costo TEXT NOT NULL DEFAULT 'USD';
