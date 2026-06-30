-- Personal contacts manager ("Contactos") — a per-user address book, like Apple
-- Contacts. SCOPED to the owning user (user_id); never the operator agency
-- directory (that's the separate `contacts` table / /api/contacts).
--
-- A contact can be created manually, imported (vCard/CSV/Google People API), or
-- auto-created when the user saves a new "send" wallet/payee — and kept updated
-- on re-save (dedupe via dedupe_key). Idempotent (CREATE … IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS user_contacts (
  id             TEXT PRIMARY KEY,                 -- con_xxxxxxxx
  user_id        TEXT NOT NULL REFERENCES users(id),
  display_name   TEXT NOT NULL,
  first_name     TEXT,
  last_name      TEXT,
  org            TEXT,
  emails_json    TEXT,                             -- JSON array of {label,value}
  phones_json    TEXT,                             -- JSON array of {label,value}
  wallet_address TEXT,                             -- USDC/x402 "send to" address
  payee_user_id  TEXT,                             -- set if the contact is a SISMO911 user
  note           TEXT,
  avatar_url     TEXT,
  favorite       INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'manual',   -- manual | vcard | csv | google | payee
  external_id    TEXT,                             -- Google People resourceName, etc.
  -- Stable dedupe key (lower(email) ‖ normalized phone ‖ lower wallet ‖ lower name)
  -- so imports + payee auto-create UPDATE an existing card instead of duplicating.
  dedupe_key     TEXT,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_contacts_owner ON user_contacts(user_id, display_name);
-- One card per (owner, dedupe_key): the upsert target for imports + payee sync.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_contacts_dedupe ON user_contacts(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
