-- Missing-persons registry ("personas"), the Familia dataset.
--
-- HISTORY: personas originally lived in a separate D1 (desaparecidos-vzla).
-- PR #87 ("centralize personas into the main sismo911 DB") moved all reads/
-- writes to the default DB binding but never added a CREATE for the table to
-- the migration chain — the table + data were copied over out-of-band. This
-- migration backfills that gap so a fresh `d1 migrations apply` builds a
-- complete schema (and so 0013_familia_moderation's ALTER has a table to
-- alter). CREATE TABLE IF NOT EXISTS → a no-op where personas already exists.
--
-- Sorts before 0013_familia_moderation.sql (which adds the `moderation` column),
-- so this base definition intentionally omits `moderation`. `foto_r2` is kept
-- here because no other migration adds it (also applied out-of-band originally).
CREATE TABLE IF NOT EXISTS personas (
  id                  TEXT PRIMARY KEY,
  nombre              TEXT NOT NULL DEFAULT '',
  edad                INTEGER,
  ubicacion           TEXT NOT NULL DEFAULT '',
  fecha               TEXT,
  descripcion         TEXT NOT NULL DEFAULT '',
  contacto            TEXT NOT NULL DEFAULT '',
  foto                TEXT NOT NULL DEFAULT '',
  estado              TEXT NOT NULL DEFAULT 'sin-contacto',
  localizado_por      TEXT,
  localizado_contacto TEXT,
  localizado_relacion TEXT,
  localizado_nota     TEXT,
  reportada           INTEGER NOT NULL DEFAULT 0,
  reportes            INTEGER NOT NULL DEFAULT 0,
  reportada_at        INTEGER,
  created_at          INTEGER,
  updated_at          INTEGER,
  pulled_at           TEXT,
  foto_r2             TEXT
);
CREATE INDEX IF NOT EXISTS idx_personas_estado ON personas(estado);
CREATE INDEX IF NOT EXISTS idx_personas_updated ON personas(updated_at DESC);
