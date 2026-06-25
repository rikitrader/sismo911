-- Structural damage reports synced from sosvenezuela2026.com (source of truth).
CREATE TABLE IF NOT EXISTS sos_damage (
  id TEXT PRIMARY KEY, category TEXT, severity TEXT, resource_status TEXT, verification TEXT,
  title TEXT, description TEXT, lat REAL, lng REAL, municipio TEXT, parroquia TEXT,
  building_type TEXT, people_trapped INTEGER, source_url TEXT, image_url TEXT,
  created_at TEXT, synced_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sos_damage_cat ON sos_damage(category);
CREATE INDEX IF NOT EXISTS idx_sos_damage_created ON sos_damage(created_at DESC);
